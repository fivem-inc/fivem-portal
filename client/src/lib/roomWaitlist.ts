// キャンセル待ちの**読み込み**を1か所にまとめた場所（2026-09-05）。
//
// 🚨 キャンセル待ちの一覧（WaitlistSettings）と、担当別の予約一覧の**両方**が
//    ここを呼ぶ。読み方を足すときは必ずここに足すこと。
// 🚨 「その回で対象かどうか」の**判定**は lib/roomBooking.ts にある
//    （waitBlockedOn / waitQueueKey / waitAppliesTo）。あちらは supabase を
//    読まないので、画面を開かずに検算できる。判定を足すのもあちら。

import { supabase } from './supabaseClient';
import { waitKey } from './roomBooking';
import type { Waitlist } from './roomBooking';

/** 読み込んだ結果。error が入っているときは中身を信用しないこと */
export interface WaitlistState {
  rows: Waitlist[];
  /** 鍵 → 繰り上げで作った予約のID（**生きているものだけ**） */
  promoted: Map<string, string>;
  /** 鍵 → 見送りの理由（理由なしは null） */
  skips: Map<string, string | null>;
  /** 読めなかったときの説明。空文字なら成功 */
  error: string;
}

/**
 * 失敗したときの返し方。
 * 🚨 待ちの一覧そのものは読めていることがある（付随情報だけ失敗した場合）ので、
 *    読めた rows はそのまま返す。ただし promoted / skips は**空**にする。
 *    呼ぶ側は error を必ず画面に出すこと（空を「0件」と読ませない）。
 */
const failed = (error: string, rows: Waitlist[] = []): WaitlistState => ({
  rows, promoted: new Map(), skips: new Map(), error,
});

/**
 * 並んでいるキャンセル待ちと、その付随情報（繰り上げ済み・見送り）をまとめて読む。
 *
 * 🚨 **埋め込みで一度に読まない**（2026-09-04 実機で発覚）。
 *    room_waitlist_promotions は room_bookings への外部キーが2本あり、
 *    埋め込みは過去に PGRST201（曖昧）で失敗している。素直に分けて読む。
 * 🚨 **エラーを必ず返す**。見ていなかったため、読み込みに失敗しても
 *    「繰り上げ済みは0件」と黙って判断し、画面が事実と違うことを言っていた。
 */
export const loadWaitlistState = async (): Promise<WaitlistState> => {
  const { data, error: err } = await supabase
    .from('room_waitlist')
    // 🚨 room_bookings へは booking_id と promoted_booking_id の**外部キーが2本**ある。
    //    「!booking_id」で結び先を明示しないと PGRST201 で一覧全体が読めなくなる
    .select('*, booking:room_bookings!booking_id(id, floor_id, starts_at, ends_at, purpose, status, deleted_at, staff_id, member_no, customer_label, cancel_kind, recurrence_id, no_waitlist), recurrence:room_recurrences(id, floor_id, weekday, start_time, end_time, purpose, staff_id, active, auto_open_slot, waitlist_closed, accept_start, accept_end, slot_memo)')
    .eq('status', 'waiting')
    .order('position')
    .order('created_at');
  if (err) return failed('キャンセル待ちを読み込めませんでした。通信を確認して開き直してください。');

  const rows = (data ?? []) as Waitlist[];
  if (rows.length === 0) return { rows, promoted: new Map(), skips: new Map(), error: '' };

  const ids = rows.map(w => w.id);
  const [prRes, skRes] = await Promise.all([
    supabase.from('room_waitlist_promotions')
      .select('waitlist_id, booking_id, created_booking_id').in('waitlist_id', ids),
    supabase.from('room_waitlist_skips')
      .select('waitlist_id, booking_id, reason').in('waitlist_id', ids),
  ]);
  if (prRes.error || skRes.error) {
    return failed('繰り上げ済み・見送りの記録を読み込めませんでした。通信を確認して開き直してください。', rows);
  }

  type PromoRow = { waitlist_id: string; booking_id: string; created_booking_id: string | null };
  const promos = (prRes.data ?? []) as PromoRow[];
  // 🚨 繰り上げで作った予約が**まだ生きているか**を別に見る（2026-09-04・㊻）。
  //    削除されていれば「繰り上げ済み」ではなくなり、もう一度繰り上げられる
  const createdIds = [...new Set(promos.map(p => p.created_booking_id).filter(Boolean))] as string[];
  const alive = new Set<string>();
  if (createdIds.length > 0) {
    const { data: cb, error: cbErr } = await supabase.from('room_bookings')
      .select('id').in('id', createdIds).is('deleted_at', null).eq('status', 'active');
    if (cbErr) return failed('繰り上げた予約を確認できませんでした。通信を確認して開き直してください。', rows);
    for (const x of (cb ?? []) as { id: string }[]) alive.add(x.id);
  }

  return {
    rows,
    // created が空の古い記録は、対応する予約が分からないので数えない（サーバーと同じ）
    promoted: new Map(promos
      .filter(p => p.created_booking_id && alive.has(p.created_booking_id))
      .map(p => [waitKey(p.waitlist_id, p.booking_id), p.created_booking_id!])),
    skips: new Map(((skRes.data ?? []) as { waitlist_id: string; booking_id: string; reason: string | null }[])
      .map(x => [waitKey(x.waitlist_id, x.booking_id), x.reason])),
    error: '',
  };
};

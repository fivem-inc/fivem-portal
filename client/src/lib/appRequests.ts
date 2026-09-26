// 「申請の依頼」（application_requests）を受け取った側の共通処理（2026-09-26）。
//
// 🚨 残業ページ（OvertimePage）と休暇ページ（LeaveRequest）の両方が同じものを使う。
//    2026-09-26 まで依頼のカードは残業ページにしか無く、休暇の依頼でも残業ページに探しに行く作りだった。
//    休暇ページにも出すにあたり、読み込み・「対応しない」・文言をここに1本化した（書き写さない）。
// 🚨 申請との結び付け（open → applied）は DB のトリガー link_application_request_on_insert が行う
//    （同じ人・同じ種類・同じ日）。画面は結び付けない。

import { supabase } from './supabaseClient';
import { insertNotification } from './notifications';
import type { SegmentLike } from './segmentsText';

export type AppRequestKind = 'overtime' | 'leave';

export interface ReceivedAppRequest {
  id: string;
  requester_id: string;
  requester_name: string | null;
  kind: AppRequestKind;
  target_dates: string[] | null;
  memo: string | null;
  due_date: string | null;
  status: string;
  /** 上長が口頭で相談した日（任意）。🚨 created_at とは別もの */
  consulted_on: string | null;
  /** 入る時間と校（シフト調整の決定で作った依頼だけに入る） */
  segments: SegmentLike[] | null;
}

/** 「対応しない」の理由の選択肢。
 *  🚨 定型の文字はそのまま recipient_note に入る。あとから数えたいので表記を増やさないこと
 *     （メモに自由記述させる方式は 2026-09-02 に「表記ゆれで数えられない」として見送っている）。
 *  🚨 有給は理由を問わないのが原則なので、選ぶのは必須・書くのは「その他」のときだけ必須 */
export const DISMISS_REASONS = ['すでに申請した', '日付や内容が異なる', '申請が不要になった', 'その他'] as const;
export const DISMISS_OTHER = 'その他';

export const APP_REQUEST_KIND_LABEL: Record<AppRequestKind, string> = { overtime: '残業・勤務変更', leave: '休暇' };

/** 自分あての開いている依頼を読む（kind を渡せばその種類だけ）。読めなかったら error を返す（空で嘘をつかない） */
export async function loadReceivedAppRequests(userId: string, kind?: AppRequestKind): Promise<{ rows: ReceivedAppRequest[]; error: string | null }> {
  let q = supabase.from('application_requests')
    .select('id, requester_id, kind, target_dates, memo, due_date, status, consulted_on, segments')
    .eq('recipient_id', userId)
    .eq('status', 'open')
    .order('created_at', { ascending: true });
  if (kind) q = q.eq('kind', kind);
  const { data, error } = await q;
  if (error) return { rows: [], error: '依頼を読み込めませんでした：' + error.message };
  const rows = (data ?? []) as Omit<ReceivedAppRequest, 'requester_name'>[];
  const ids = [...new Set(rows.map(r => r.requester_id))];
  const nameOf = new Map<string, string>();
  if (ids.length > 0) {
    const { data: profs } = await supabase.from('profiles').select('id, name').in('id', ids);
    for (const p of (profs ?? []) as { id: string; name: string }[]) nameOf.set(p.id, p.name);
  }
  return { rows: rows.map(r => ({ ...r, requester_name: nameOf.get(r.requester_id) ?? null })), error: null };
}

/**
 * 依頼に「対応しない」と答える。status を dismissed にして、依頼した上長にベルで知らせる。
 * 🚨 update は0件でもエラーにならないので件数を見る。0件＝すでに処理された（取り下げ・申請済み）
 * 🚨 ベルだけ（event_key を付けない）。付けると push_queue に積まれてスマホが鳴る（ユーザー確定）
 * 🚨 宛先は依頼した本人1人だけ。dispatchSiteNotification は使わない（設定が無いと全員に飛ぶ）
 */
export async function dismissAppRequest(r: ReceivedAppRequest, note: string): Promise<string | null> {
  const { data, error } = await supabase.from('application_requests')
    .update({ status: 'dismissed', recipient_note: note, responded_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', r.id).eq('status', 'open').select('id');
  if (error) return '保存できませんでした：' + error.message;
  if (!data || data.length === 0) return '保存できませんでした（すでに処理された可能性があります）';
  const dates = (r.target_dates ?? []).map(d => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}（${dowOf(d)}）`).join('・');
  void insertNotification(
    r.requester_id,
    `📩 ${APP_REQUEST_KIND_LABEL[r.kind] ?? r.kind}の申請依頼は「対応しない」と回答がありました`,
    `${dates}／理由：${note}`,
    'application_request:dismissed',
    r.id,
  );
  return null;
}

const DOW = ['日', '月', '火', '水', '木', '金', '土'];
export function dowOf(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return DOW[new Date(y, m - 1, d).getDay()];
}
/** 「9/26（金）」の形 */
export const mdDow = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}（${dowOf(d)}）`;

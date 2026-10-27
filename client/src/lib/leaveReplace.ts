// 有休を時間外調整休に変える（2026-10-27 段2a・計画 docs/計画-言葉をそろえる-休暇の種類の変更.md）。
//
// 入口は2つ・仕組みは1つ：
//   ① ご本人：有休のカードの［時間外調整休に変更する］（LeaveRequest）
//   ② 上長：申請の依頼のシートで「この有休を、時間外調整休に変更できることをご本人に案内する」（ApplicationRequestSheet）
//      → ご本人の残業ページに「休暇の種類のご案内」（LeaveKindGuideCard）
//   どちらも、ご本人が残業申請（時間外調整休・終日）を replaces_leave_id 付きで出す。受理された瞬間に DB が有休を取り消す（その日を抜く）
// 🚨 止めるのは DB（enforce_overtime_replaces_leave・enforce_appreq_leave_replace・leave_replace_block）。画面の確かめは先に知らせるためだけ
// 🚨 言葉は「変える」ではなく「変更する」（2026-10-27 ユーザー確定・段2a と段2b でそろえる）
// 🚨 文言は 2026-10-27 ユーザー確定（法律の専門家2体のレビューのあと）。直すときは計画の「段2a の文言」を見てから

import { supabase } from './supabaseClient';
import { isNetworkFailure } from './netFailure';

/** 時間外調整休に変えられる休暇の種類（DB の leave_replace_block と同じ） */
export const LEAVE_REPLACE_TYPES = ['有給休暇', 'バースデー休暇（有給）'] as const;
/** 有休奨励日の休み（変えられない） */
const ENC_REASON = '【有給奨励日】';

export interface ReplaceableLeave {
  id: string;
  leave_type: string;
  status: string;
  reason?: string | null;
  leave_dates?: string | null;
}

export function leaveDatesOf(l: { leave_dates?: string | null }): string[] {
  try {
    const v = JSON.parse(String(l.leave_dates ?? '[]'));
    return Array.isArray(v) ? (v as string[]).filter(x => typeof x === 'string').sort() : [];
  } catch { return []; }
}

/** カードに［時間外調整休に変更する］を出してよい休暇か（細かい止めは DB。ここは見た目の出し分け） */
export function isReplaceableLeave(l: ReplaceableLeave): boolean {
  return (LEAVE_REPLACE_TYPES as readonly string[]).includes(l.leave_type)
    && !['cancelled', 'rejected'].includes(l.status)
    && (l.reason ?? '') !== ENC_REASON
    && leaveDatesOf(l).length > 0;
}

const DOW = ['日', '月', '火', '水', '木', '金', '土'];
const dowOf = (d: string) => { const [y, m, dd] = d.split('-').map(Number); return DOW[new Date(y, m - 1, dd).getDay()]; };
/** 「10/30（金）」 */
export const mdDowShort = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}（${dowOf(d)}）`;
/** 「10月30日（金）」 */
export const mdDowLong = (d: string) => `${Number(d.slice(5, 7))}月${Number(d.slice(8, 10))}日（${dowOf(d)}）`;

/** 受理の画面・履歴の札「10/30（有休）からの変更」 */
export const replacedFromLabel = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}（有休）からの変更`;

/** 申請の画面の上の帯（2026-10-26 ユーザー確定 案A） */
export const replaceBannerTitle = (date: string) => `${mdDowLong(date)}の有給休暇を、時間外調整休に変更する申請です`;
export const replaceBannerNote = (date: string) => `受理されると、${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日の有給休暇は取り消されます。`;

/** 変えられるか（ご本人の休暇）。null＝変えられる。読めなかったときも null（最後は DB が止める） */
export async function myLeaveReplaceBlock(leaveId: string, date: string): Promise<string | null> {
  const { data, error } = await supabase.rpc('my_leave_replace_block', { p_leave: leaveId, p_date: date });
  if (error) { console.error('[有休からの変更の確かめ]', error.message); return null; }
  return typeof data === 'string' && data ? data : null;
}

/** 変えられるか（上長が相手の休暇を見るとき）。null＝変えられる */
export async function leaveReplaceBlockFor(leaveId: string, userId: string, date: string): Promise<string | null> {
  const { data, error } = await supabase.rpc('leave_replace_block_for', { p_leave: leaveId, p_user: userId, p_date: date });
  if (error) { console.error('[有休からの変更の確かめ]', error.message); return null; }
  return typeof data === 'string' && data ? data : null;
}

/** DB の 'LEAVE_CHANGE|<文>' から文を取り出す（無ければ null） */
export function leaveChangeText(err: { message?: string | null } | null | undefined): string | null {
  const m = String(err?.message ?? '');
  const i = m.indexOf('LEAVE_CHANGE|');
  return i >= 0 ? m.slice(i + 'LEAVE_CHANGE|'.length).trim() : null;
}

/** ご本人の、受理の前の「有休からの変更」の申請（休暇の ID → 日付）。カードの［時間外調整休に変更する］を隠すため */
export async function loadPendingReplacements(userId: string): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  const { data, error } = await supabase.from('overtime_reports')
    .select('replaces_leave_id, work_date')
    .eq('applicant_id', userId).eq('entry_type', 'manual')
    .not('replaces_leave_id', 'is', null)
    .not('status', 'in', '(cancelled,rejected,returned)');
  if (error) { if (!isNetworkFailure(error)) console.error('[有休からの変更の申請]', error.message); return out; }
  for (const r of (data ?? []) as { replaces_leave_id: string; work_date: string }[]) {
    const s = out.get(r.replaces_leave_id) ?? new Set<string>();
    s.add(r.work_date);
    out.set(r.replaces_leave_id, s);
  }
  return out;
}

/**
 * 自分で受理した（その場で確定した）有休からの変更のあと、有休の Google カレンダーの予定を直す。
 * 上長の受理のときは Edge Function（overtime-approve）が同じことをする。
 * 🚨 共用の gcal-sync は変えない（delete と upsert を順に呼ぶだけ）。作り直すのはカレンダーに出る段（マネージャーの受理から）だけ
 */
export async function syncReplacedLeaveGcal(leaveId: string, date: string, name: string): Promise<void> {
  try {
    const { data: lv } = await supabase.from('leave_requests')
      .select('id, status, leave_type, leave_dates, leave_locations').eq('id', leaveId).maybeSingle();
    if (!lv) return;
    await supabase.functions.invoke('gcal-sync', { body: { action: 'delete', source_type: 'leave', source_id: lv.id, dates: [date] } });
    const rest = leaveDatesOf(lv as ReplaceableLeave);
    if (['manager_approved', 'admin_approved', 'approved'].includes(String(lv.status)) && rest.length > 0) {
      let locations: Record<string, string> = {};
      try { locations = JSON.parse(String(lv.leave_locations ?? '{}')); } catch { locations = {}; }
      await supabase.functions.invoke('gcal-sync', { body: { action: 'upsert', source_type: 'leave', source_id: lv.id, dates: rest, name, leave_type: lv.leave_type, locations } });
    }
  } catch (e) {
    console.error('[有休の予定の直し]', e instanceof Error ? e.message : String(e));
  }
}

// ───────── 段2b：時間外調整休を有休に変更する（2026-10-27・入口はご本人だけ＝残業ページの時間外調整休のカード） ─────────
// 休暇申請（有給休暇・バースデー休暇・その日だけ）をマネージャーの受理の段から出す（DB の create_leave_from_chosei）。
// 🚨 マネージャーが受理した瞬間に DB がその日の時間外調整休を取り消す。経理・社長が差し戻す（取り消す）と DB が元に戻す（apply_chosei_replacement）

/** 受理の画面・履歴の札「10/30（時間外調整休）からの変更」 */
export const replacedFromChoseiLabel = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}（時間外調整休）からの変更`;

/** 休暇申請の画面の上の帯（2026-10-27 ユーザー確定） */
export const choseiBannerTitle = (date: string) => `${mdDowLong(date)}の時間外調整休を、有給休暇に変更する申請です`;
export const choseiBannerNote = (date: string) => `マネージャーが受理すると、${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日の時間外調整休は取り消されます。`;

/** 変えられるか（ご本人の時間外調整休）。null＝変えられる。読めなかったときも null（最後は DB が止める） */
export async function myOvertimeReplaceBlock(overtimeId: string): Promise<string | null> {
  const { data, error } = await supabase.rpc('my_overtime_replace_block', { p_ot: overtimeId });
  if (error) { console.error('[時間外調整休からの変更の確かめ]', error.message); return null; }
  return typeof data === 'string' && data ? data : null;
}

/** ご本人の、マネージャーの受理の前の「時間外調整休からの変更」の休暇（時間外調整休の ID の集まり）。カードの［有休に変更する］を隠すため */
export async function loadPendingChoseiReplacements(userId: string): Promise<Set<string>> {
  const out = new Set<string>();
  const { data, error } = await supabase.from('leave_requests')
    .select('replaces_overtime_id')
    .eq('user_id', userId)
    .not('replaces_overtime_id', 'is', null)
    .not('status', 'in', '(cancelled,rejected)');
  if (error) { if (!isNetworkFailure(error)) console.error('[時間外調整休からの変更の休暇]', error.message); return out; }
  for (const r of (data ?? []) as { replaces_overtime_id: string }[]) out.add(r.replaces_overtime_id);
  return out;
}

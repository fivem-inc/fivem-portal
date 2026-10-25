// 残業申請のカレンダーの印（2026-10-12 ユーザー確定）。
// 🚨 印の判定・言葉・色はこの1か所。カレンダー・押したときの案内・管理画面の一覧が同じものを使う。
//
//   事前   … 事前申請を出していて、まだ勤務の日が来ていない
//   未報告 … 勤務の日が過ぎたのに、実績の報告がまだ（履歴の催促 unreportedRequests と同じ翌日基準）
//   報告済 … 事前申請のあと実績を報告した
//   事後   … 事後報告を出した
//   差戻   … 差し戻された
//   定時   … 残業がなかった（残業なしの実績報告・打刻ズレ・［シフト通り勤務した］の記録）
//   休暇   … 休暇申請を出した日（休暇から自動で入る調整休を含む）
//
// 試せる人だけに出す（overtime_day_check_enabled()・残業の管理画面の「役職ごと・個人ごと」）。
import { supabase } from './supabaseClient';
import { isFullDayReport } from './overtimeTypes';
import { leaveDateList } from './leaveDates';
import { isFurikaeReportRow, isFurikaeUnreported } from './furikaeReport';

export type DayMarkKind = 'pre' | 'unreported' | 'reported' | 'posthoc' | 'returned' | 'teiji' | 'leave';

/** 印の札。🚨 マスの背景（休館日の色）や暗い画面でも読めるよう、札は自分の背景色を持つ固定色 */
export const DAY_MARK_STYLE: Record<DayMarkKind, { label: string; bg: string; text: string }> = {
  pre:        { label: '事前',   bg: '#e6f1fb', text: '#0c447c' },
  unreported: { label: '未報告', bg: '#b45309', text: '#ffffff' },
  reported:   { label: '報告済', bg: '#eeedfe', text: '#3c3489' },
  posthoc:    { label: '事後',   bg: '#e1f5ee', text: '#085041' },
  returned:   { label: '差戻',   bg: '#c62828', text: '#ffffff' },
  teiji:      { label: '定時',   bg: '#f1efe8', text: '#444441' },
  leave:      { label: '休暇',   bg: '#fbeaf0', text: '#72243e' },
};

/** カレンダーの下に出す説明（1行） */
export const DAY_MARK_LEGEND = '事前＝事前申請／未報告＝実績の報告がまだ／報告済／事後＝事後報告／差戻＝差し戻し／定時＝残業なし／休暇';

/** 印の材料になる申請の列（細く読む） */
export interface DayMarkReport {
  id: string;
  work_date: string;
  status: string;
  entry_type: string;
  is_post_hoc: boolean;
  diff_minutes: number | null;
  application_types: string[] | null;
  furikae_origin_date: string | null;
  /** 振替元の日がまだ来ていなかった振替休日（振替元の実績を報告する・2026-10-26） */
  furikae_report_needed?: boolean | null;
}

export interface DayMark {
  kind: DayMarkKind;
  /** 申請から付いた印のとき、その申請 */
  reportId?: string;
  status?: string;
  /** 振替休日の「振替元の日」として付いた印 */
  furikaeOrigin?: boolean;
  /** ［シフト通り勤務した］の記録から付いた印（本人が取り消せる） */
  dayCheck?: { created_at: string };
  /** 打刻ズレ（打刻が遅れただけ）から付いた定時 */
  clockOnly?: boolean;
}

/**
 * 残業がなかった申請か（＝定時）。差分0で確定し、種別が無い（残業なしの実績報告）か打刻ズレだけ。
 * 🚨 DB の enforce_overtime_self_confirm と同じ考え方。leave_auto はここに来る前に外している
 */
export function isTeijiReport(r: Pick<DayMarkReport, 'status' | 'diff_minutes' | 'application_types'>): boolean {
  if (r.status !== 'confirmed' || (r.diff_minutes ?? 0) !== 0) return false;
  const types = r.application_types ?? [];
  return types.length === 0 || (types.length === 1 && types[0] === 'clock_only');
}

/** 申請1件の印。today は 'YYYY-MM-DD'（日本時間） */
export function dayMarkOfReport(r: DayMarkReport, today: string): DayMarkKind {
  if (r.status === 'returned') return 'returned';
  if (isTeijiReport(r)) return 'teiji';
  // 終日（調整休・振替休日・欠勤）は実績報告が無いので、出し方（事前／事後）だけで分ける
  if (isFullDayReport(r.application_types)) return r.is_post_hoc ? 'posthoc' : 'pre';
  if (r.status === 'requested' || r.status === 'request_confirmed') {
    // 🚨 催促（unreportedRequests）と同じ翌日基準。当日はまだ勤務中のことがあるため「事前」のまま
    return r.work_date < today ? 'unreported' : 'pre';
  }
  return r.is_post_hoc ? 'posthoc' : 'reported';
}

/** 'YYYY-MM' の月の初日と末日 */
export function monthRange(year: number, month0: number): { from: string; to: string } {
  const pad = (n: number) => String(n).padStart(2, '0');
  const last = new Date(year, month0 + 1, 0).getDate();
  return { from: `${year}-${pad(month0 + 1)}-01`, to: `${year}-${pad(month0 + 1)}-${pad(last)}` };
}

/**
 * 本人の、ある期間の印をまとめて読む。🚨 error は必ず返す（読めないのに「何もない日」に見せないため）。
 * 読むのは細い列だけ（通信量のため）。月を替えたとき・記録したときだけ呼ぶ（定期的には読まない）。
 */
export async function loadDayMarks(
  userId: string, from: string, to: string, today: string,
): Promise<{ marks: Record<string, DayMark>; error: string | null }> {
  const [rep, chk, lv] = await Promise.all([
    supabase.from('overtime_reports')
      .select('id, work_date, status, entry_type, is_post_hoc, diff_minutes, application_types, furikae_origin_date, furikae_report_needed')
      .eq('applicant_id', userId)
      .neq('status', 'cancelled')
      .or(`and(work_date.gte.${from},work_date.lte.${to}),and(furikae_origin_date.gte.${from},furikae_origin_date.lte.${to})`),
    supabase.from('overtime_day_checks')
      .select('work_date, created_at')
      .eq('user_id', userId)
      .gte('work_date', from).lte('work_date', to),
    supabase.from('leave_requests')
      .select('leave_dates, start_date, end_date, status')
      .eq('user_id', userId)
      .neq('status', 'rejected')
      .lte('start_date', to).gte('end_date', from),
  ]);
  const err = rep.error ?? chk.error ?? lv.error;
  if (err) return { marks: {}, error: err.message };

  const marks: Record<string, DayMark> = {};
  // 弱い順に入れて、強いもので上書きする：休暇 → 定時の記録 → 休暇から自動の行 → 振替元 → 申請
  for (const l of (lv.data ?? []) as { leave_dates: string | null; start_date: string | null; end_date: string | null; status: string | null }[]) {
    if (l.status === 'cancelled') continue;
    for (const d of leaveDateList(l.leave_dates, l.start_date, l.end_date)) {
      if (d >= from && d <= to) marks[d] = { kind: 'leave' };
    }
  }
  for (const c of (chk.data ?? []) as { work_date: string; created_at: string }[]) {
    marks[c.work_date] = { kind: 'teiji', dayCheck: { created_at: c.created_at } };
  }
  const reports = (rep.data ?? []) as DayMarkReport[];
  for (const r of reports) {
    if (r.entry_type === 'leave_auto' && r.work_date >= from && r.work_date <= to) marks[r.work_date] = { kind: 'leave' };
  }
  for (const r of reports) {
    if (r.entry_type !== 'manual' || !r.furikae_origin_date) continue;
    const d = r.furikae_origin_date;
    if (d < from || d > to) continue;
    // 振替元の実績を報告する振替休日は、振替元の日に「未報告／報告済」を付ける（休む日には付けない・2026-10-26）
    const kind: DayMarkKind = isFurikaeReportRow(r)
      ? (isFurikaeUnreported(r, today) ? 'unreported' : r.status === 'reported' ? 'reported' : dayMarkOfReport(r, today))
      : dayMarkOfReport(r, today);
    marks[d] = { kind, reportId: r.id, status: r.status, furikaeOrigin: true };
  }
  for (const r of reports) {
    if (r.entry_type !== 'manual' || r.work_date < from || r.work_date > to) continue;
    const kind = dayMarkOfReport(r, today);
    marks[r.work_date] = {
      kind, reportId: r.id, status: r.status,
      clockOnly: kind === 'teiji' && (r.application_types ?? []).includes('clock_only'),
    };
  }
  return { marks, error: null };
}

/** 印のある日は、入力に進ませない（DB が断る日・することが別にある日）。休暇から自動の日・休暇の日は止めない */
export function dayMarkBlocksForm(m: DayMark | undefined): boolean {
  if (!m) return false;
  if (m.kind === 'leave') return false;
  return true;
}

/** DB の関数のエラー（DAY_CHECK_◯◯: 文）から、画面に出す文を取り出す */
export function dayCheckErrorText(message: string): string {
  const m = /DAY_CHECK_[A-Z_]+:\s*(.+)$/.exec(message);
  return m ? m[1] : message;
}

/** ［シフト通り勤務した］を記録する。返り値は error の文（成功なら null） */
export async function recordDayCheck(date: string, shift: object): Promise<string | null> {
  const { error } = await supabase.rpc('overtime_day_check_record', { p_date: date, p_shift: shift });
  return error ? dayCheckErrorText(error.message) : null;
}

/** 記録を取り消す。🚨 0件（もう無かった）も知らせる */
export async function cancelDayCheck(date: string): Promise<string | null> {
  const { data, error } = await supabase.rpc('overtime_day_check_cancel', { p_date: date });
  if (error) return dayCheckErrorText(error.message);
  if (data === 0) return 'この日の定時の記録は、すでにありません';
  return null;
}

/** この機能を使えるか（残業の管理画面の「役職ごと・個人ごと」）。読めなければ使えない側に倒す */
export async function fetchDayCheckEnabled(): Promise<boolean> {
  const { data, error } = await supabase.rpc('overtime_day_check_enabled');
  if (error) { console.error('[定時の記録] 使えるかを確かめられませんでした', error.message); return false; }
  return data === true;
}

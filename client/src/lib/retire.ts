// 退職の予約・手続きのチェック（2026-09-19・1段目）。設計は docs/計画-退職者の申請期間.md
//
// 🚨 状態の判定・呼び名はここ1か所（ユーザー管理・退職の手続き・ホームの案内が同じものを使う）
// 🚨 期限の初期値の計算は DB の retire_access_default() だけが持つ（画面で計算し直さない＝2か所に書かない）
// 🚨 退職・取り消し・復活は RPC（retire_schedule / retire_cancel / retire_restore）。is_active を画面から書かない

import { supabase } from './supabaseClient';

export type RetireState = 'none' | 'scheduled' | 'switch_failed' | 'grace' | 'retired';

export interface RetireFields {
  is_active?: boolean | null;
  approval_status?: string | null;
  retire_date?: string | null;
  retiree_access_until?: string | null;
}

/**
 * none      … 在籍中（退職日なし）／承認待ち
 * scheduled … 在籍中・退職日を予約済み
 * switch_failed … 退職日を過ぎたのに在籍のまま（毎晩の自動の切り替えに失敗した・2026-09-19）
 * grace     … 退職済み・申請の期限内（3段目でログインできるようになる）
 * retired   … 退職済み（期限切れ・または退職日の記録がない昔の退職者）
 */
export function retireState(p: RetireFields, todayJst: string): RetireState {
  if (p.approval_status === 'pending') return 'none';
  if (p.is_active !== false) {
    if (!p.retire_date) return 'none';
    return p.retire_date < todayJst ? 'switch_failed' : 'scheduled';
  }
  if (p.retire_date && p.retiree_access_until && todayJst <= p.retiree_access_until) return 'grace';
  return 'retired';
}

/** "2026-10-31" → "10/31"（月・日の頭にゼロを付けない） */
export function mdLabel(ymd: string | null | undefined): string {
  if (!ymd) return '';
  return `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}`;
}

/**
 * 札の文言（ユーザー管理の「状態」の欄・チェック表の見出し）。
 * 🚨 1段目では退職者はまだログインできないので「申請期間」とは言わない（2026-09-19 UXレビュー）。
 *    3段目（申請期間を開く）を出すときに、grace の文言をここ1か所で変える
 */
export function retireStateLabel(p: RetireFields, todayJst: string): string {
  switch (retireState(p, todayJst)) {
    case 'scheduled': return `在籍中（${mdLabel(p.retire_date)} 退職予定）`;
    case 'switch_failed': return `在籍中（${mdLabel(p.retire_date)} 退職・切り替えに失敗）`;
    case 'grace':
    case 'retired': return p.retire_date ? `退職済み（${mdLabel(p.retire_date)} 退職）` : '退職済み';
    default: return '在籍中';
  }
}

/** 札の色（在籍中＝緑／退職予定・切り替え失敗＝橙／退職済み＝赤）。🚨 既存の色だけを使う */
export function retireStateColor(p: RetireFields, todayJst: string, isDark: boolean): string {
  const s = retireState(p, todayJst);
  if (s === 'scheduled' || s === 'switch_failed') return isDark ? '#ffc107' : '#b35900';
  if (s === 'grace' || s === 'retired') return '#dc3545';
  return isDark ? '#5cb85c' : '#1e7e34';
}

/** 期限の初期値（DB の retire_access_default を呼ぶ）。読めなければ null */
export async function fetchRetireAccessDefault(retireDate: string): Promise<string | null> {
  const { data, error } = await supabase.rpc('retire_access_default', { p_retire_date: retireDate });
  if (error || typeof data !== 'string') return null;
  return data;
}

export interface RetireScheduleResult {
  retire_date: string;
  access_until: string;
  applied_now: boolean;
  access_expired: boolean;
  reassigned: number;
}

/** 付け替えの記録の表の名前 → 画面での呼び名 */
export const REASSIGN_TABLE_LABEL: Record<string, string> = {
  overtime_reports: '残業',
  shift_reports: '勤務変更報告',
  leave_requests: '休暇',
};

/** 必須で、まだ済んでいない項目の数（チェック表・ホームの案内で共用） */
export function retireRemaining(
  items: { id: string; required: boolean; active: boolean }[],
  checks: { user_id: string; item_id: string }[],
  userId: string,
): number {
  return items.filter(i => i.active && i.required && !checks.some(c => c.user_id === userId && c.item_id === i.id)).length;
}

// ============================================================
// 3段目（退職者向けの画面）。2026-09-20
// ============================================================

/** いまログインしている人の立場。🚨 判定そのものは DB の my_access_state() が持つ（画面で日付を比べない） */
export type AccessMode = 'staff' | 'retiree_grace' | 'blocked';

export interface AccessState {
  mode: AccessMode;
  /** 退職者のとき：ログインできる期限 "YYYY-MM-DD" */
  access_until?: string | null;
  /** 退職者のとき：退職日 */
  retire_date?: string | null;
  /** 退職者のとき：出してよい機能（app_settings.retiree_feature_keys） */
  feature_keys?: string[];
}

/**
 * いまの立場を DB に聞く。
 * 🚨 期限の判定は**必ず DB 側**で行う。端末の時計は利用者が変えられるうえ、ずれていることもある。
 * 🚨 読めなかったときは null を返す（＝分からない）。呼ぶ側は **null で追い出してはいけない**。
 *    通信が悪いだけの在籍者をログアウトさせるのが、いちばん起こしてはいけない事故。
 */
export async function fetchAccessState(): Promise<AccessState | null> {
  const { data, error } = await supabase.rpc('my_access_state');
  if (error || !data) return null;
  const st = data as AccessState;
  if (st.mode !== 'staff' && st.mode !== 'retiree_grace' && st.mode !== 'blocked') return null;
  return st;
}

/** 期限まであと何日か（今日を含めない）。期限が無ければ null */
export function daysUntil(accessUntil: string | null | undefined, todayJst: string): number | null {
  if (!accessUntil) return null;
  const a = new Date(`${accessUntil}T12:00:00+09:00`).getTime();
  const b = new Date(`${todayJst}T12:00:00+09:00`).getTime();
  return Math.round((a - b) / 86400000);
}

/** 案内に出す期限の言い方。🚨 「あと◯日」は残り7日以内のときだけ付ける
 *  （2026-09-20 ユーザー確定。13日先の「あと13日」は情報が増えず、毎回出ると急かして見えるため） */
export function accessUntilLabel(accessUntil: string | null | undefined, todayJst: string): string {
  if (!accessUntil) return '';
  const [y, m, d] = accessUntil.split('-').map(Number);
  const dow = ['日', '月', '火', '水', '木', '金', '土'][new Date(`${accessUntil}T12:00:00+09:00`).getDay()];
  const base = `${y}年${m}月${d}日（${dow}）`;
  const left = daysUntil(accessUntil, todayJst);
  return left !== null && left >= 0 && left <= 7 ? `${base}（あと${left}日）` : base;
}

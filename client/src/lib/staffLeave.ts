/**
 * 休職（2026-10-19〜・計画 docs/計画-休職と手続き.md）
 *
 * 🚨 休職中かどうかは profiles に置かない（profiles は全員が読めるため・ユーザー確定）。記録は staff_leaves で、
 *    読めるのは本人・マネージャー以上・管理者だけ。書くのは DB の staff_leave_* の関数だけ。
 * 🚨 状態（予定・休職中・終了）は日付と列から決める（DB の staff_leave_active_on と同じ決め方を statusOf 1か所に）
 */
import { supabase } from './supabaseClient';
import { mdLabel } from './retire';

export interface StaffLeave {
  id: string;
  user_id: string;
  start_date: string;          // 休職の初日
  return_date: string | null;  // 復職日（戻って最初に出勤する日）。空＝未定
  board_opt_in: boolean;
  board_asked_at: string | null;
  push_on: boolean;
  push_asked_at: string | null;
  features_add: string[];
  features_remove: string[];
  ended_at: string | null;
  end_reason: 'returned' | 'scheduled' | 'retired' | null;
  cancelled_at: string | null;
  created_at: string;
}

/**
 * 管理画面のユーザー一覧に［休職］を出すか（2026-10-20）。
 * 🚨 申請先の候補から外す・残りの宛先・日付の直し忘れのベル・スマホのお知らせ・チェックリスト・シフト表がそろうまで false。
 *    そろう前に登録すると、休職中の人が候補に残る・申請が受理されないまま気づかれない、が起きるため（計画 docs/計画-休職と手続き.md）
 */
export const LEAVE_REGISTER_OPEN = false;

export type LeaveStatus = 'scheduled' | 'on_leave' | 'ended' | 'cancelled';

const COLS = 'id, user_id, start_date, return_date, board_opt_in, board_asked_at, push_on, push_asked_at, features_add, features_remove, ended_at, end_reason, cancelled_at, created_at';

/** 日本時間の日付 "YYYY-MM-DD"（ended_at の日付を出すため） */
function jstDate(iso: string): string {
  return new Date(new Date(iso).getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

/** その休職の今日の状態（DB の staff_leave_active_on と同じ決め方） */
export function leaveStatusOf(l: StaffLeave, todayJst: string): LeaveStatus {
  if (l.cancelled_at) return 'cancelled';
  if (l.ended_at && jstDate(l.ended_at) <= todayJst) return 'ended';
  if (l.return_date && l.return_date <= todayJst) return 'ended';
  if (l.start_date > todayJst) return 'scheduled';
  return 'on_leave';
}

/** その日に休職中か（DB の staff_leave_active_on と同じ決め方） */
export function leaveActiveOnDay(l: StaffLeave | null | undefined, day: string): boolean {
  if (!l || l.cancelled_at) return false;
  if (l.start_date > day) return false;
  if (l.return_date && l.return_date <= day) return false;
  if (l.ended_at && jstDate(l.ended_at) <= day) return false;
  return true;
}

/** 一覧の「状態」の欄の文字（休職の予定・休職中のときだけ。それ以外は null） */
export function leaveStateLabel(l: StaffLeave | null | undefined, todayJst: string): string | null {
  if (!l) return null;
  const st = leaveStatusOf(l, todayJst);
  if (st === 'scheduled') return `在籍中（${mdLabel(l.start_date)} 休職予定）`;
  if (st === 'on_leave') return l.return_date ? `休職中（${mdLabel(l.return_date)} 復職予定）` : '休職中（復職日 未定）';
  return null;
}

/** 休職の文字の色（灰色。退職のオレンジ・赤と見分けるため） */
export const leaveStateColor = (isDark: boolean): string => (isDark ? '#adb5bd' : '#6c757d');

/** 終わっていない（予定・休職中の）休職を、人ごとに1件ずつ。読めない役職のときは空 */
export async function fetchOpenLeaves(): Promise<Map<string, StaffLeave>> {
  const { data, error } = await supabase.from('staff_leaves').select(COLS)
    .is('ended_at', null).is('cancelled_at', null);
  const m = new Map<string, StaffLeave>();
  if (error) { console.error('[staffLeave] 読み込みに失敗:', error); return m; }
  for (const r of (data ?? []) as StaffLeave[]) m.set(r.user_id, r);
  return m;
}

/**
 * 休職中に選べる機能（権限管理の「休職中に使える機能」の並び・名前）。keys は feature_key（FAQ はナビにも出す faq_nav と2つで1つ）。
 * path は、その機能のページ（休職中にここ以外のページを開いたら「このページは現在ご利用いただけません」）
 */
export const LEAVE_SELECTABLE: { label: string; keys: string[]; paths: string[] }[] = [
  { label: '連絡板', keys: ['board'], paths: ['/board'] },
  { label: 'FAQ', keys: ['faq', 'faq_nav'], paths: ['/faq'] },
  { label: '交通費', keys: ['expense'], paths: ['/expense'] },
  { label: '残業申請', keys: ['overtime'], paths: ['/overtime'] },
  { label: '勤務変更報告', keys: ['shift_report'], paths: ['/shift-report'] },
  { label: '休暇申請', keys: ['leave_request'], paths: ['/leave'] },
  { label: '出張報告', keys: ['trip_report'], paths: ['/trip-report'] },
  { label: '備品購入', keys: ['purchase_request'], paths: ['/purchase'] },
  { label: '場所予約', keys: ['room_booking'], paths: ['/rooms'] },
  { label: '勤怠カレンダー', keys: ['leave_calendar'], paths: ['/calendar'] },
];

/** 休職中でもいつも開けるページ（ホーム・設定・お知らせ・安否確認など） */
const LEAVE_ALWAYS_PATHS = ['/', '/account', '/change-password', '/change-email', '/notification-settings', '/announcements', '/help', '/safety', '/settings-check'];

/** 休職中にそのページを開いてよいか（🚨 判定はここ1か所・App.tsx の ProtectedLayout が使う） */
export function leaveAllowsPath(pathname: string, keys: string[]): boolean {
  if (LEAVE_ALWAYS_PATHS.includes(pathname)) return true;
  const f = LEAVE_SELECTABLE.find(x => x.paths.includes(pathname));
  return !!f && f.keys.every(k => keys.includes(k) || k === 'faq_nav');
}

/** 使える機能の名前の一覧（本人のホーム・登録の窓に出す） */
export function leaveFeatureLabels(keys: string[]): string[] {
  return LEAVE_SELECTABLE.filter(f => keys.includes(f.keys[0])).map(f => f.label);
}

/** 初めの設定（DB の app_settings 'leave_feature_keys' と同じ。読めないときの表示だけに使う） */
export const LEAVE_DEFAULT_FEATURE_LABELS = ['連絡板', 'FAQ', '交通費', '残業申請', '勤務変更報告'];

// ── 受理待ちの一覧と付け替え ──
export interface PendingItem {
  kind: 'leave' | 'overtime' | 'shift' | 'purchase';
  row_id: string;
  col: string;
  applicant_id: string | null;
  applicant_name: string | null;
  item_date: string | null;
  detail: string | null;
  can_reassign: boolean;
}

export const PENDING_KIND_LABEL: Record<PendingItem['kind'], string> = {
  leave: '休暇', overtime: '残業', shift: '勤務変更', purchase: '備品',
};

/** その人が対応する予定の申請。読めなかったときは null（🚨 null のときは登録させない） */
export async function fetchPendingItems(userId: string): Promise<PendingItem[] | null> {
  const { data, error } = await supabase.rpc('staff_pending_items', { p_user: userId });
  if (error) { console.error('[staffLeave] 受理待ちの読み込みに失敗:', error); return null; }
  return (data ?? []) as PendingItem[];
}

/** 一覧の1行の文字（例：休暇 10/25（田中さん）・有給休暇） */
export function pendingItemLabel(it: PendingItem): string {
  const who = it.applicant_name ? `（${it.applicant_name}さん）` : '';
  const date = it.item_date ? ` ${mdLabel(it.item_date)}` : '';
  const second = it.kind === 'leave' && it.col === 'approver2_id' ? '・2人目' : '';
  const detail = it.kind === 'leave' && it.detail ? `・${it.detail}` : it.kind === 'purchase' && it.detail ? `・${it.detail}` : '';
  return `${PENDING_KIND_LABEL[it.kind]}${date}${who}${detail}${second}`;
}

export interface ReassignPick { kind: PendingItem['kind']; row_id: string; col: string; to: string }

export async function reassignPending(userId: string, picks: ReassignPick[]): Promise<{ moved: number; error: string | null }> {
  if (picks.length === 0) return { moved: 0, error: null };
  const { data, error } = await supabase.rpc('staff_leave_reassign', { p_user: userId, p_items: picks });
  if (error) return { moved: 0, error: error.message };
  return { moved: Number(data ?? 0), error: null };
}

// ── 登録・修正・取消・復職（管理者だけ。権限は DB が見る）──
/** 休職中に使える機能の基本（app_settings 'leave_feature_keys'）。読めなければ null */
export async function fetchLeaveBaseKeys(): Promise<string[] | null> {
  const { data, error } = await supabase.from('app_settings').select('value').eq('key', 'leave_feature_keys').maybeSingle();
  if (error) { console.error('[staffLeave] 基本の機能の読み込みに失敗:', error); return null; }
  const k = (data?.value as { keys?: string[] } | null)?.keys;
  return Array.isArray(k) ? k : [];
}

export async function registerLeave(userId: string, start: string, ret: string | null, add: string[] = [], remove: string[] = []): Promise<{ id: string | null; error: string | null }> {
  const { data, error } = await supabase.rpc('staff_leave_register', { p_user: userId, p_start: start, p_return: ret, p_features_add: add, p_features_remove: remove });
  if (error) return { id: null, error: error.message };
  return { id: (data as string) ?? null, error: null };
}

export async function updateLeave(l: StaffLeave, start: string, ret: string | null, add: string[] = l.features_add, remove: string[] = l.features_remove): Promise<string | null> {
  const { error } = await supabase.rpc('staff_leave_update', {
    p_id: l.id, p_start: start, p_return: ret, p_features_add: add, p_features_remove: remove,
  });
  return error ? error.message : null;
}

export async function cancelLeave(id: string): Promise<string | null> {
  const { error } = await supabase.rpc('staff_leave_cancel', { p_id: id });
  return error ? error.message : null;
}

export async function returnFromLeave(id: string): Promise<string | null> {
  const { error } = await supabase.rpc('staff_leave_return', { p_id: id });
  return error ? error.message : null;
}

// ── 申請先・宛先の候補から外す（2026-10-20・段3の4）──
// 🚨 だれが休職中かはほかのスタッフには読めない。DB の unavailable_approver_ids が
//    「承認者になる役職の人で、いま休職中の人」だけを返す（マネージャー以上・管理者には休職中の全員）。
// 🚨 読めなかったときは「外さない」（通信が悪いだけで候補が消えるほうが困る。申請先は DB のトリガーが最後に止める）
const AWAY_FRESH_MS = 10 * 60 * 1000;
let awayCache: { at: number; ids: Set<string> } | null = null;
let awayInflight: Promise<Set<string>> | null = null;

/** いま休職中で、申請先・宛先に選べない人の id（10分使い回す） */
export async function fetchUnavailableIds(): Promise<Set<string>> {
  if (awayCache && Date.now() - awayCache.at < AWAY_FRESH_MS) return awayCache.ids;
  if (awayInflight) return awayInflight;
  awayInflight = (async () => {
    const { data, error } = await supabase.rpc('unavailable_approver_ids');
    if (error) { console.error('[staffLeave] 選べない方の読み込みに失敗:', error); return awayCache?.ids ?? new Set<string>(); }
    const ids = new Set<string>(((data ?? []) as (string | { unavailable_approver_ids: string })[])
      .map(r => (typeof r === 'string' ? r : r.unavailable_approver_ids)));
    awayCache = { at: Date.now(), ids };
    return ids;
  })();
  try { return await awayInflight; } finally { awayInflight = null; }
}

/** 一覧から選べない人を外す（id を持つ行なら何でも） */
export function withoutUnavailable<T extends { id: string }>(rows: T[], away: Set<string>): T[] {
  return away.size === 0 ? rows : rows.filter(r => !away.has(r.id));
}

/** DB が申請先で止めたときの文（'APPROVER_ON_LEAVE|文'）を取り出す。違えば null */
export function approverOnLeaveText(msg: string | null | undefined): string | null {
  if (!msg) return null;
  const i = msg.indexOf('APPROVER_ON_LEAVE|');
  return i >= 0 ? msg.slice(i + 'APPROVER_ON_LEAVE|'.length).trim() : null;
}

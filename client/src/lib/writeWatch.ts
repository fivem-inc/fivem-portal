// 自分が DB に書き込んだら、その話題の数字をすぐ数え直す（2026-10-18・通信量の見直し 段2・ユーザー確定）
//
// 【なぜ】ナビはページを移るたびに付け直され、そのたびに数字を全部数え直していた（1回 約22本・1日の要求の約7割）。
//   ページを移っただけでは数え直さない（hooks/useRefreshOn の key つき）代わりに、
//   「自分がしたこと（受理・報告・申請・既読など）」は書き込んだ直後に数え直す＝自分の数字はすぐ変わる（ユーザー確定）。
//   ほかの人がしたことは、今までどおり通知の表（lib/refreshBus）と 10分・30分の全件の数え直しで直る。
//
// 【仕組み】lib/supabaseClient の fetch を1か所で見張り（watchedFetch）、書き込みの要求から話題を引く（topicsForWrite）。
//   最後の書き込みから 2.5 秒待ってまとめて1回（続いても最長 10 秒で1回）、その話題を refreshBus に知らせる。
//
// 🚨 見るのは /rest/v1/（表・RPC）と /functions/v1/（Edge Function）だけ。Auth のトークン更新・Storage のアップロードは見ない
// 🚨 GET・HEAD・失敗した要求（res.ok でない）は見ない。応答の本文は読まない（そのまま返す）
// 🚨 数字に関係ない書き込み（ログインの記録・ナビの設定・FAQ の記録など）は IGNORE で外す（開くたびに2重に数えないため）
// 🚨 話題が分からない書き込みは 'all'（数え直しが1回増えるだけで壊れない側に倒す）
// 🚨 連絡板のページにいる間は 'board' を知らせない（読むたびに数え直さない・ページを出たときに useBoardUnread が数え直す）
// 🚨 topicsForWrite は supabase を読まない（node で検算できる）

import type { RefreshKey, RefreshTopic } from './refreshBus';

/** 数字に関係ない書き込み（表・RPC・Edge Function の名前） */
const IGNORE = new Set([
  'touch_last_sign_in', 'record_session_device', 'record_logout', 'set_my_nav_order', 'set_my_nav_two_row',
  'faq_public_event_log', 'faq_query_log', 'faq_public_log', 'push_subscriptions',
  'login_events', 'session_devices', 'gcal-sync', 'send-push', 'send-email', 'slack-notify', 'push-dispatch',
  'record-signup-ip', 'receipt-signed-url', 'storage-usage-check', 'password-setup-mail',
  'overtime_banner_dismissals',   // 目安超えの帯を閉じた記録（ナビの数字には出ない）
]);

/** 表・RPC・Edge Function の名前 → 話題 */
const TOPIC_RULES: [RegExp, RefreshTopic[]][] = [
  // ホームの新着（2026-10-18）：［確認した］・ホームを開いた・締め日を閉じる・催促／有休奨励日／出勤のお願いへの回答
  [/^home_|^set_payroll_close_notice|^respond_scheduled_reminder|^answer_encouragement_day|^shift_adjust_answer_part_request/, ['home']],
  [/^board_|^board-/, ['board']],
  [/^notifications$|^mark_.*read/, ['bell']],
  [/^overtime|clock_inquiry|^overtime-/, ['overtime', 'application_request']],
  [/^leave|^leave-/, ['leave', 'application_request']],
  [/^shift_report|^shift-report/, ['shift_report']],
  [/^purchase|^purchase-/, ['purchase_request']],
  [/^safety|^submit_safety/, ['safety']],
  [/^application_request/, ['application_request']],
  [/^app_settings$|^roles$|^feature_permissions$|^admin_|^staff_checklist/, ['admin']],
];

/** 読むだけの RPC で、名前の形では見分けられないもの（2026-10-19・DB の関数の中身で書き込みが無いことを確かめた）。
 *  🚨 admin_setup_alerts を「管理の書き込み」と数えていたため、管理者の画面で「読む→書き込みと数える→'admin' を読み直す→読む…」が
 *     約2.5秒ごとに続いていた（10/18〜19）。数え直しを呼ぶ話題の中で読む RPC は、必ずここか下の形に入れること */
const READ_RPCS = new Set([
  'admin_setup_alerts', 'admin_user_sessions', 'board_can_manage_groups', 'clock_inquiry_day_states',
  'overtime_day_check_enabled', 'overtime_visible_roster', 'shift_adjust_my_part_requests',
  'faq_public_data', 'faq_public_contact', 'retire_access_default', 'retire_purchase_pending',
  'cleaning_token', 'kids_shift_token', 'shift_patterns_token', 'study_sessions_token',
]);

/** 読むだけの RPC（名前の形で見分ける・漏れても1回余計に数え直すだけ。ただし堂々めぐりになることがある＝上の READ_RPCS） */
function isReadRpc(name: string): boolean {
  if (READ_RPCS.has(name)) return true;
  return /^(my_|get_|count_|list_|search_|calendar_|report_|faq_public_event_summary)|_count$|_ids$|_counts$|_totals?$|_banner$|_status$|_options$|_preview$|_summary$|_check_conflict$|_busy$|_visible$|_estimate$|_overview$|_progress$|_for$|^role_is_|^is_|^has_|^room_check|^room_staff_busy/.test(name);
}

/**
 * 要求から「数え直す話題」を引く。書き込みでない・数字に関係ないときは空。
 * url は文字列（https://xxx.supabase.co/rest/v1/notifications?id=eq.… など）
 */
export function topicsForWrite(url: string, method: string): RefreshKey[] {
  const m = method.toUpperCase();
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return [];
  let path: string;
  try { path = new URL(url).pathname; } catch { path = url; }
  let name: string | null = null;
  const rpc = path.match(/\/rest\/v1\/rpc\/([^/?]+)/);
  if (rpc) {
    name = rpc[1];
    if (isReadRpc(name)) return [];
  } else {
    const tbl = path.match(/\/rest\/v1\/([^/?]+)/);
    const fn = path.match(/\/functions\/v1\/([^/?]+)/);
    name = tbl?.[1] ?? fn?.[1] ?? null;
  }
  if (!name) return [];   // /auth/v1/・/storage/v1/ など
  if (IGNORE.has(name)) return [];
  for (const [re, topics] of TOPIC_RULES) if (re.test(name)) return topics;
  return ['all'];
}

// ── 書き込みの時刻（話題ごと）と、まとめて知らせる係 ──
const lastWriteAt = new Map<RefreshKey, number>();
let pending = new Set<RefreshKey>();
let debounceTimer: number | undefined;
let firstPendingAt = 0;
export const WRITE_DEBOUNCE_MS = 2500;
export const WRITE_MAX_WAIT_MS = 10_000;
let emitter: ((keys: RefreshKey[]) => void) | null = null;
let pathnameOf: () => string = () => (typeof window !== 'undefined' ? window.location.pathname : '');

/** refreshBus の emit をつなぐ（循環 import を避けるため、hooks/useRefreshOn が起動時に渡す） */
export function setWriteEmitter(fn: (keys: RefreshKey[]) => void): void { emitter = fn; }
/** 検算用：今のページの取り方を差し替える */
export function setPathnameGetter(fn: () => string): void { pathnameOf = fn; }

/** この話題（どれか）に、t より後の書き込みがあったか（ページを移ったときに読み直すかの判定） */
export function writtenSince(topics: readonly RefreshTopic[], t: number): boolean {
  const all = lastWriteAt.get('all') ?? 0;
  if (all > t) return true;
  return topics.some(k => (lastWriteAt.get(k) ?? 0) > t);
}

function flush(): void {
  debounceTimer = undefined;
  const keys = [...pending].filter(k => !(k === 'board' && pathnameOf().startsWith('/board')));
  pending = new Set();
  firstPendingAt = 0;
  if (keys.length > 0 && emitter) emitter(keys);
}

/** 書き込みがあった（応答が ok だったもの） */
export function noteWrite(keys: RefreshKey[], now = Date.now()): void {
  if (keys.length === 0) return;
  for (const k of keys) { lastWriteAt.set(k, now); pending.add(k); }
  if (typeof window === 'undefined') return;
  if (!firstPendingAt) firstPendingAt = now;
  if (debounceTimer !== undefined) window.clearTimeout(debounceTimer);
  const wait = Math.min(WRITE_DEBOUNCE_MS, Math.max(0, firstPendingAt + WRITE_MAX_WAIT_MS - now));
  debounceTimer = window.setTimeout(flush, wait);
}

/** supabase-js に渡す fetch。要求はそのまま通し、成功した書き込みだけ noteWrite する（本文は読まない） */
export const watchedFetch: typeof fetch = async (input, init) => {
  const res = await fetch(input, init);
  try {
    if (res.ok) {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET');
      const keys = topicsForWrite(url, method);
      if (keys.length > 0) noteWrite(keys);
    }
  } catch { /* 見張りの失敗で要求を止めない */ }
  return res;
};

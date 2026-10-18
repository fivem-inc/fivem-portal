// 上のナビのボタンの表（2026-10-17・計画 docs/計画-ナビの並び替え.md の 2a）
//
// 🚨 ナビのボタンはここ1か所で決める（App.tsx の NavBar はこの表の順に描くだけ）。
//    あとで並べ替え（管理者の初めの並び・本人の並び）を足すときも、この表のキーを並べ替える
// 🚨 このファイルは React も supabase も読まない（出す条件と数字は呼ぶ側が NavContext で渡す）
// 🚨 固定：⚙️ 管理（管理者・いちばん左）→ 🏠（全員・その次）／💡 FAQ（いつも端）。並べ替えの対象はその間だけ

export type NavKey =
  | 'admin' | 'home' | 'expense' | 'trip_report' | 'leave' | 'calendar' | 'shift_report'
  | 'overtime' | 'purchase' | 'rooms' | 'board' | 'procedures' | 'faq';

export interface NavItem {
  key: NavKey;
  path: string;
  icon: string;
  /** パソコンの文字 */
  label: string;
  /** スマホの文字（44px の幅に入る短い言葉） */
  mobileLabel: string;
  /** 今いるページのときの色 */
  activeColor: string;
  /** 赤い数字。undefined＝数字を出さないボタン（数字の枠ごと作らない）。0＝今は出さない */
  badge?: number;
}

export interface NavContext {
  /** ⚙️ 管理を出すか（hooks/useAdminAccess の canOpen） */
  canAdminOpen: boolean;
  isAdmin: boolean;
  canExpense: boolean;
  canTripReport: boolean;
  canLeave: boolean;
  canCalendar: boolean;
  canShiftReport: boolean;
  canOvertime: boolean;
  canPurchaseRequest: boolean;
  canRoomBooking: boolean;
  canBoard: boolean;
  canProcedures: boolean;
  canFaqNav: boolean;
  /** ホームと交通費を分けるか（管理画面の切り替え nav_rollout.split_home・2026-10-17）。分けた人は 🏠 ホーム と 🚃 交通費 の2つ */
  splitHome?: boolean;
  /** 機能の公開（管理画面の公開設定）。lib/featurePublished の isFeaturePublished を渡す */
  isPub: (key: string) => boolean;
  badges: { admin: number; leave: number; shift: number; overtime: number; purchase: number; board: number; home?: number };
}

/** 今の人に出すボタンを、今の並び（初めの並び）で返す */
export function buildNavItems(c: NavContext): NavItem[] {
  const all: (NavItem & { show: boolean })[] = [
    { key: 'admin', path: '/admin', icon: '⚙️', label: '管理', mobileLabel: '管理', activeColor: '#6f42c1',
      show: c.canAdminOpen, badge: c.badges.admin },
    // 🏠 は誰にでも出す（2026-10-17 ユーザー確定）。交通費を使う人は「交通費」、使わない人は「ホーム」。
    // ホームの中の交通費のフォームは今までどおり使う人にだけ出る（App.tsx のホーム）
    { key: 'home', path: '/', icon: '🏠', ...(!c.splitHome && c.canExpense && c.isPub('expense')
        ? { label: '交通費', mobileLabel: '交通費' } : { label: 'ホーム', mobileLabel: 'ホーム' }),
      activeColor: '#007bff', show: true, badge: c.badges.home ?? 0 },
    // ホームと交通費を分けた人だけ（2026-10-17 ユーザー確定：🚃・🏠 のすぐ右・並べ替えできる）。中身は /expense
    { key: 'expense', path: '/expense', icon: '🚃', label: '交通費', mobileLabel: '交通費', activeColor: '#007bff',
      show: !!c.splitHome && c.canExpense && c.isPub('expense') },
    { key: 'trip_report', path: '/trip-report', icon: '📍', label: '出張報告', mobileLabel: '出張報告', activeColor: '#007bff',
      show: c.canTripReport && c.isPub('trip_report') },
    { key: 'leave', path: '/leave', icon: '🌿', label: '休暇申請', mobileLabel: '休暇申請', activeColor: '#28a745',
      show: c.canLeave && c.isPub('leave_request'), badge: c.badges.leave },
    { key: 'calendar', path: '/calendar', icon: '📅', label: 'カレンダー', mobileLabel: 'カレンダー', activeColor: '#4a90d9',
      show: (c.isAdmin || c.canCalendar) && c.isPub('leave_calendar') },
    { key: 'shift_report', path: '/shift-report', icon: '⏰', label: '勤務変更', mobileLabel: '勤務変更', activeColor: '#c0392b',
      show: c.canShiftReport && c.isPub('shift_report'), badge: c.badges.shift },
    { key: 'overtime', path: '/overtime', icon: '🕐', label: '残業・時間', mobileLabel: '残業', activeColor: '#1565c0',
      show: c.canOvertime && c.isPub('overtime'), badge: c.badges.overtime },
    // 備品精算の数字＝「✅ 承認」タブの件数＋「📋 履歴」タブの未確認件数
    { key: 'purchase', path: '/purchase', icon: '📦', label: '備品精算', mobileLabel: '備品精算', activeColor: '#17a2b8',
      show: c.canPurchaseRequest && c.isPub('purchase_request'), badge: c.badges.purchase },
    // 場所の予約。毎日開くものなので連絡板の前（出し分けは管理画面の「役職・機能権限」）
    { key: 'rooms', path: '/rooms', icon: '🚪', label: '場所予約', mobileLabel: '場所予約', activeColor: '#2f6f4f',
      show: c.canRoomBooking && c.isPub('room_booking') },
    { key: 'board', path: '/board', icon: '💬', label: '連絡板', mobileLabel: '連絡板', activeColor: '#e67e22',
      show: c.canBoard && c.isPub('board'), badge: c.badges.board },
    // 入社・退職の手続き（マネージャー以上と管理者）。赤い数字は付けない（押して消せない赤は付けない決まり）
    { key: 'procedures', path: '/retire', icon: '📋', label: '手続き', mobileLabel: '手続き', activeColor: '#6c757d',
      show: c.canProcedures },
    // FAQ はいつも端（毎日使うものではないため）。出すかは権限管理の「FAQ：ナビにも出す」
    { key: 'faq', path: '/faq', icon: '💡', label: 'FAQ', mobileLabel: 'FAQ', activeColor: '#0891b2',
      show: c.canFaqNav },
  ];
  return all.filter(i => i.show).map(i => { const { show, ...item } = i; void show; return item; });
}

/** 端のはみ出し・隠れた数字を数え直すきっかけ（出ているボタンと数字が変わったら変わる文字） */
export function navItemsSignature(items: NavItem[]): string {
  return items.map(i => `${i.key}:${i.badge ?? '-'}`).join(',');
}

// ───────────────────────────────────────────────
// 並べ替え（2026-10-17・2b）
// ───────────────────────────────────────────────

/** いつも左の2つ（⚙️ 管理・🏠）と、いつも端の1つ（💡 FAQ）。並べ替えの対象はその間だけ */
export const NAV_FIXED_FIRST: NavKey[] = ['admin', 'home'];
export const NAV_FIXED_LAST: NavKey[] = ['faq'];
/** 並びに入っていなかったら、後ろではなく先頭に出すボタン */
export const NAV_FRONT_IF_NEW: NavKey[] = ['expense'];
/** 並べ替えできるボタン（今の並び＝初めの並び） */
export const NAV_REORDERABLE: NavKey[] = ['expense', 'trip_report', 'leave', 'calendar', 'shift_report', 'overtime', 'purchase', 'rooms', 'board', 'procedures'];
/** 管理画面・「設定」の一覧に出す名前（権限に関係なく全部） */
export const NAV_KEY_NAME: Record<NavKey, string> = {
  admin: '⚙️ 管理', home: '🏠 ホーム（交通費）', expense: '🚃 交通費（ホームと分けた人だけ）', trip_report: '📍 出張報告', leave: '🌿 休暇申請', calendar: '📅 カレンダー',
  shift_report: '⏰ 勤務変更', overtime: '🕐 残業・時間', purchase: '📦 備品精算', rooms: '🚪 場所予約', board: '💬 連絡板',
  procedures: '📋 手続き', faq: '💡 FAQ',
};

/**
 * 並びを当てる。固定の3つはそのまま、間のボタンは order の順。
 * order に無いボタン（あとで増えた機能など）は、今の並びのまま最後に足す。order に有って今出ていないキーは無視する
 */
export function applyNavOrder(items: NavItem[], order: readonly string[] | null | undefined): NavItem[] {
  if (!order || order.length === 0) return items;
  const first = items.filter(i => NAV_FIXED_FIRST.includes(i.key));
  const last = items.filter(i => NAV_FIXED_LAST.includes(i.key));
  const middle = items.filter(i => !NAV_FIXED_FIRST.includes(i.key) && !NAV_FIXED_LAST.includes(i.key));
  // 並びに無いボタンは最後へ（あとで増えた機能）。ただし 🚃 交通費だけは先頭へ（分けたときは 🏠 のすぐ右が初めの位置・ユーザー確定）
  const idx = (k: string) => { const n = order.indexOf(k); return n >= 0 ? n : NAV_FRONT_IF_NEW.includes(k as NavKey) ? -1 : Number.MAX_SAFE_INTEGER; };
  const sorted = middle.map((it, i) => ({ it, i })).sort((a, b) => idx(a.it.key) - idx(b.it.key) || a.i - b.i).map(x => x.it);
  return [...first, ...sorted, ...last];
}

/**
 * 本人が並べ替えた「見えているボタンの順」を、保存する並びにする。
 * 🚨 今は権限が無くて見えていないボタンの順番も消さない（権限が戻ったときに元の位置に近く出るように）。前の並びにだけあるキーは後ろに足す
 */
export function mergeSavedNavOrder(visibleOrder: readonly string[], prevSaved: readonly string[] | null | undefined): string[] {
  const rest = (prevSaved ?? []).filter(k => !visibleOrder.includes(k));
  return [...visibleOrder, ...rest];
}

/** 試してから広げる切り替え（app_settings 'nav_rollout' の reorder／two_row） */
export interface NavRolloutRule { mode: 'off' | 'selected' | 'all'; user_ids: string[]; role_ids: string[] }
/** two_row_choice＝「設定」で本人が 2段／1段 を選べる人（2026-10-17・選んでいない人は two_row に従う） */
export interface NavRollout { reorder: NavRolloutRule; two_row: NavRolloutRule; split_home: NavRolloutRule; two_row_choice: NavRolloutRule }
export const NAV_ROLLOUT_OFF: NavRollout = {
  reorder: { mode: 'off', user_ids: [], role_ids: [] },
  two_row: { mode: 'off', user_ids: [], role_ids: [] },
  split_home: { mode: 'off', user_ids: [], role_ids: [] },
  two_row_choice: { mode: 'off', user_ids: [], role_ids: [] },
};

/** 読んだ値を形を確かめて取り込む（壊れていたら「オフ」） */
export function parseNavRollout(v: unknown): NavRollout {
  const rule = (x: unknown): NavRolloutRule => {
    const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
    const mode = o.mode === 'selected' || o.mode === 'all' ? o.mode : 'off';
    const ids = (a: unknown) => (Array.isArray(a) ? a.filter((s): s is string => typeof s === 'string') : []);
    return { mode, user_ids: ids(o.user_ids), role_ids: ids(o.role_ids) };
  };
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  return { reorder: rule(o.reorder), two_row: rule(o.two_row), split_home: rule(o.split_home), two_row_choice: rule(o.two_row_choice) };
}

/**
 * この人に効いているか。🚨 役職プレビュー中は「その役職」で判定し、選んだ人（user_ids）は見ない
 * （プレビューは役職の見え方を確かめるものなので、管理者本人が選ばれていても役職の結果にそろえる）
 */
export function navRolloutOn(rule: NavRolloutRule, userId: string | null | undefined, roleId: string | null | undefined, previewing: boolean): boolean {
  if (rule.mode === 'all') return true;
  if (rule.mode !== 'selected') return false;
  if (!previewing && userId && rule.user_ids.includes(userId)) return true;
  return !!roleId && rule.role_ids.includes(roleId);
}

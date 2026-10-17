// 上のナビのボタンの表（2026-10-17・計画 docs/計画-ナビの並び替え.md の 2a）
//
// 🚨 ナビのボタンはここ1か所で決める（App.tsx の NavBar はこの表の順に描くだけ）。
//    あとで並べ替え（管理者の初めの並び・本人の並び）を足すときも、この表のキーを並べ替える
// 🚨 このファイルは React も supabase も読まない（出す条件と数字は呼ぶ側が NavContext で渡す）
// 🚨 固定：⚙️ 管理（管理者・いちばん左）→ 🏠（全員・その次）／💡 FAQ（いつも端）。並べ替えの対象はその間だけ

export type NavKey =
  | 'admin' | 'home' | 'trip_report' | 'leave' | 'calendar' | 'shift_report'
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
  /** 機能の公開（管理画面の公開設定）。lib/featurePublished の isFeaturePublished を渡す */
  isPub: (key: string) => boolean;
  badges: { admin: number; leave: number; shift: number; overtime: number; purchase: number; board: number };
}

/** 今の人に出すボタンを、今の並び（初めの並び）で返す */
export function buildNavItems(c: NavContext): NavItem[] {
  const all: (NavItem & { show: boolean })[] = [
    { key: 'admin', path: '/admin', icon: '⚙️', label: '管理', mobileLabel: '管理', activeColor: '#6f42c1',
      show: c.canAdminOpen, badge: c.badges.admin },
    // 🏠 は誰にでも出す（2026-10-17 ユーザー確定）。交通費を使う人は「交通費」、使わない人は「ホーム」。
    // ホームの中の交通費のフォームは今までどおり使う人にだけ出る（App.tsx のホーム）
    { key: 'home', path: '/', icon: '🏠', ...(c.canExpense && c.isPub('expense')
        ? { label: '交通費', mobileLabel: '交通費' } : { label: 'ホーム', mobileLabel: 'ホーム' }),
      activeColor: '#007bff', show: true },
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

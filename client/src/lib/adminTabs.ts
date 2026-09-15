// 管理画面をマネージャー以上に開く（2026-09-15）。設計・決めたことは docs/計画-管理画面の開放.md
//
// ・開くかどうか ＝ 管理者、または（マネージャー以上 かつ パソコン かつ 管理者が開いたタブが1つ以上）
// ・開くタブは app_settings 'manager_admin_tabs'（配列）。最初は空＝全部オフ
// 🚨 タブの鍵は AdminPanelContext の AdminTab と、DB の can_manage_admin_tab(タブ) と同じ文字。ここにだけ書く
// 🚨 「パソコンだけ」は画面の制限。DB は端末を見分けられない（書き込みの許可は DB が同じ設定で決める）
// 🚨 このファイルは supabase を読まない（判定だけ）。読むのは hooks/useAdminAccess.ts

export const MANAGER_ADMIN_TABS_SETTING_KEY = 'manager_admin_tabs';

/** マネージャー以上に開けるタブ（並びは設定の画面の並び） */
export const MANAGER_TAB_KEYS = ['shift_patterns', 'groups', 'scheduled_reminders', 'faq', 'announcements', 'safety_checks'] as const;
export type ManagerTabKey = typeof MANAGER_TAB_KEYS[number];

export interface ManagerTabInfo {
  label: string;
  /** 開いたときにできるようになること */
  canDo: string;
  /** DB の書き込みの許可がどう変わるか */
  dbNote: string;
  /** 全員に届く連絡ができる＝オンにするとき二段階で確かめる */
  broadcast?: boolean;
}

export const MANAGER_TAB_INFO: Record<ManagerTabKey, ManagerTabInfo> = {
  shift_patterns: {
    label: '📑 シフト管理',
    canDo: '勤務表（通常シフト）のまとめての修正・Excel取り込み・PDF、部門の一覧とメインの部門',
    dbNote: 'シフトの保存を DB でも許可します（保存は確かめの関数を通るだけで、表を直接書き換えることはできません）。全員の通常シフトが読めるようになります',
  },
  groups: {
    label: '👥 グループ',
    canDo: 'スタッフを所属（グループ・所属チーム）に入れる・外す。グループの追加・名前の変更・削除は管理者だけです',
    dbNote: '所属の変更を DB でも許可します。管理者・全社の役職（社長など）・ご自身より上の役職の人の所属は変えられません。所属チームを変えると、休暇・残業の受理依頼が届く上長が変わります',
  },
  scheduled_reminders: {
    label: '📅 リマインド設定',
    canDo: '定期リマインドの追加・編集・ON/OFF・削除と対応状況、有給奨励日・連絡板の締切未読の送る時刻',
    dbNote: 'リマインドの書き込みを DB でも許可します',
  },
  faq: {
    label: '💡 FAQ管理',
    canDo: 'FAQ の追加・編集・公開と集計。Q&A編集アカウントの設定は管理者だけです',
    dbNote: 'FAQ の書き込みを DB でも許可します（下書きの回答と検索語の記録も読めるようになります）',
  },
  announcements: {
    label: '📢 お知らせ',
    canDo: 'お知らせの作成・編集・停止・削除（他の人が作ったものも）と、作成時のスマホ通知・メール',
    dbNote: 'お知らせの書き込みと、全員（約46名）への通知・メールの送信を DB でも許可します',
    broadcast: true,
  },
  safety_checks: {
    label: '🆘 安否・緊急',
    canDo: '安否確認の発信・終了・取消・代わりの回答と定型メッセージ。削除は管理者だけです',
    dbNote: 'DB の権限は変わりません（発信・終了・取消はもともとマネージャー以上ができます）。オフにしても、管理画面に出なくなるだけです',
  },
};

/** 設定の値を、知っているタブの鍵だけの配列にする（配列でない・知らない鍵は捨てる） */
export function normalizeManagerTabs(raw: unknown): ManagerTabKey[] {
  if (!Array.isArray(raw)) return [];
  const set = new Set(raw.filter((v): v is string => typeof v === 'string'));
  return MANAGER_TAB_KEYS.filter(k => set.has(k));
}

/**
 * loading … 設定を読み終えていない（🚨 読み終える前にホームへ飛ばさない）
 * error   … 設定を読めなかった
 * admin   … 管理者（全部のタブ）
 * ok      … マネージャー以上・パソコン・タブが1つ以上
 * not_manager / not_pc / no_tabs … 開けない理由
 */
export type AdminAccessReason = 'loading' | 'error' | 'admin' | 'ok' | 'not_manager' | 'not_pc' | 'no_tabs';

export interface AdminAccess {
  /** 判定が決まった（loading 以外） */
  ready: boolean;
  canOpen: boolean;
  reason: AdminAccessReason;
  /** 開いているタブ。管理者は null（＝全部） */
  visibleTabs: readonly ManagerTabKey[] | null;
}

export interface AdminAccessInput {
  isAdmin: boolean;
  isManagerPlus: boolean;
  isPc: boolean;
  /** 設定。null＝まだ読めていない */
  tabs: readonly ManagerTabKey[] | null;
  loadFailed: boolean;
}

export function decideAdminAccess(i: AdminAccessInput): AdminAccess {
  if (i.isAdmin) return { ready: true, canOpen: true, reason: 'admin', visibleTabs: null };
  const closed = (reason: AdminAccessReason, ready = true): AdminAccess => ({ ready, canOpen: false, reason, visibleTabs: [] });
  if (!i.isManagerPlus) return closed('not_manager');
  if (!i.isPc) return closed('not_pc');
  if (i.tabs === null) return i.loadFailed ? closed('error') : closed('loading', false);
  if (i.tabs.length === 0) return closed('no_tabs');
  return { ready: true, canOpen: true, reason: 'ok', visibleTabs: i.tabs };
}

/** そのタブを開いてよいか。管理者（visibleTabs が null）は全部 */
export function isAdminTabAllowed(access: Pick<AdminAccess, 'canOpen' | 'visibleTabs'>, tab: string): boolean {
  if (!access.canOpen) return false;
  return access.visibleTabs === null || (access.visibleTabs as readonly string[]).includes(tab);
}

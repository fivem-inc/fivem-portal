import { useState, useEffect, useCallback, useContext, useRef, useMemo } from 'react';
import type { AuthUser } from '../types';
import { supabase } from '../lib/supabaseClient';
import { AuthContext } from '../contexts/AuthContext.tsx';
import { readRawPendingQueue, writeRawPendingQueue } from '../lib/safetyStorage';
import { attrsFor, rankOf, previewRoleOptions } from '../lib/roleAttrs';
import type { RoleRow, ActsAs } from '../lib/roleAttrs';
import { useRoles } from './useRoles';

// 🚨 役職名の配列（旧 APPROVER_ROLES 等）はここに書かない。判定は roles の属性（lib/roleAttrs.ts）。
//    2026-09-09 に「社長」を改名しただけで承認者判定が外れ、本番の権限が壊れた。

interface UseAuthReturn {
  user: AuthUser | null;
  loading: boolean;
  isAdmin: boolean;
  isApprover: boolean;
  /** 以下は roles の属性から（2026-09-09）。プレビュー中はプレビュー役職の属性 */
  isLeaderPlus: boolean;
  isManagerPlus: boolean;
  /** 備品購入の決裁者（🚨 マネージャー以上とは別。経理＝管理者を含まない） */
  isBoardApprover: boolean;
  /** 経営（グループ絞り込みの対象外・「社長のみ」先行公開の対象） */
  isOrgWide: boolean;
  /** 承認フロー上の立場（leader/manager/accounting/president）。無ければ null */
  actsAs: ActsAs | null;
  /** 序列（小さいほど上）。役職が無ければ null */
  roleRank: number | null;
  /** 役職の一覧（属性つき・sort_order 順）。プルダウンや宛先の解決に使う */
  roles: RoleRow[];
  /** 役職プレビューに出す役職（管理者を除く） */
  previewRoles: RoleRow[];
  profileName: string;
  roleTitle: string;
  employmentType: string;
  canLeave: boolean;
  canShiftReport: boolean;
  canCalendar: boolean;
  canPurchaseRequest: boolean;
  canOvertime: boolean;
  canTripReportHistory: boolean;
  canOvertimeSummary: boolean;
  canShiftPatternDirectory: boolean;
  /**
   * シフト調整の作業場（勤怠カレンダーの中のタブ）の5つの権限。
   * 🚨 1つのまとまりで渡す。ばらばらに5つ足すと App.tsx（2人共通ファイル）の
   *    受け渡しが5行ずつ増える。中身はすべて機能権限（管理画面で切り替える）
   * 🚨 勤怠カレンダーの権限（canCalendar）が無い人は、これが ON でも入口に届かない
   *    （作業場はカレンダーの中にあるため）
   */
  shiftAdjust: {
    /** ① 見る・コメントする */
    view: boolean;
    /** ② 案を確認したと押す */
    review: boolean;
    /** ③ 案を作る・意見の期限を付ける */
    plan: boolean;
    /** ④ パートへ出勤のお願いを送る */
    request: boolean;
    /** ⑤ 決定する・決定を取り消す・確認済（変更なし）で閉じる */
    decide: boolean;
  };
  /** FAQ（よくある質問）を見られるか。管理画面の役職トグルで切り替える */
  canFaq: boolean;
  /** ナビバーにFAQボタンを出すか（canFaq とは別に切り替えられる） */
  canFaqNav: boolean;
  canExpense: boolean;
  canTripReport: boolean;
  canBoard: boolean;
  /** 場所予約（/rooms）。2026-08-31 ユーザー確定でマネージャー以上に絞った */
  canRoomBooking: boolean;
  canLeaveShiftAdjust: boolean;
  canApplicationRequest: boolean;
  canPartLeaveFormSend: boolean;
  canLeaveApprovals: boolean;
  /** 勤怠カレンダーへの登録・取消（2026-09-09 追加）。DB側の RLS も同じトグルを見る */
  canAttendanceInput: boolean;
  leaveRequestEnabled: boolean;
  /** FAQ管理画面だけを使える専用アカウントか（管理者は別途 isAdmin で判定） */
  isFaqEditor: boolean;
  handleLogout: () => Promise<void>;
}

// 役職の一覧（属性つき）は hooks/useRoles.ts が1回だけ読んで全画面で共有する。判定は lib/roleAttrs.ts。

// 前回読み込んだ名前・役職・権限を端末に保存しておき、次回起動時に即表示するためのキャッシュ。
// これで「名前・権限がまだ読めていない一瞬」に、名前なし（メール頭文字）や
// ナビボタンが減った状態が表示される問題を防ぐ（最新は裏で取り直して上書き）。
// 権限は表示用で、実データへのアクセスはサーバー側RLSで守られるため安全。
const AUTH_CACHE_PREFIX = 'fivem_auth_cache_';
const AUTH_CACHE_VERSION = 2; // 保存形式を変えたら上げる（旧キャッシュは破棄される）
interface AuthCache {
  v: number;
  name: string; roleTitle: string; employmentType: string;
  leaveRequestEnabled: boolean; perms: Record<string, boolean>;
  isFaqEditor?: boolean;
}
function readAuthCache(userId: string): AuthCache | null {
  try {
    const raw = localStorage.getItem(AUTH_CACHE_PREFIX + userId);
    if (!raw) return null;
    const c = JSON.parse(raw) as AuthCache;
    // バージョン不一致・形式破損は破棄（perms欠落での白画面を防ぐ）
    if (c.v !== AUTH_CACHE_VERSION || typeof c.perms !== 'object' || c.perms === null) return null;
    return c;
  } catch { return null; }
}
function writeAuthCache(userId: string, cache: Omit<AuthCache, 'v'>): void {
  try { localStorage.setItem(AUTH_CACHE_PREFIX + userId, JSON.stringify({ v: AUTH_CACHE_VERSION, ...cache })); } catch { /* 容量超過等は無視 */ }
}

// 役職名からDB権限マップを取得する共通処理。
// 取得に失敗した場合は null を返す（呼び出し側で「既存の権限を保持」させ、
// モバイルの不安定回線でトークン更新のたびに空データで上書きされ、
// ナビボタンが消える不具合を防ぐため）
async function fetchPermsForRole(roleName: string): Promise<Record<string, boolean> | null> {
  const { data: roleData, error: roleErr } = await supabase
    .from('roles')
    .select('id')
    .eq('name', roleName)
    .single();
  if (roleErr || !roleData) return null;
  const { data, error } = await supabase
    .from('feature_permissions')
    .select('feature_key, enabled')
    .eq('role_id', roleData.id);
  if (error) return null;
  const map: Record<string, boolean> = {};
  (data || []).forEach((p: { feature_key: string; enabled: boolean }) => {
    map[p.feature_key] = p.enabled;
  });
  return map;
}


// ───────────────────────────────────────────────────────────────
// 🚨🚨 読み込みは「同じ人・同じ瞬間なら1回だけ」にまとめる（2026-09-12・実機の数字で判明）
//
// useAuth は **25か所**（App.tsx だけで16）から呼ばれる。以前は**呼ばれた数だけ**
// profiles → roles → feature_permissions を読みに行っていた。実機で測った本番の数字：
//     profiles 15本 ／ roles 10本 ／ feature_permissions 9本 ／ touch_last_sign_in 12本
// しかも1回ぶんが**3段の順番待ち**（前が終わらないと次が始まらない）で、
// これが階段状に 0.35秒〜1.05秒まで続き、**起動が終わる時刻を決めていた**。
//
// 【直し方】結果を1つ作って全員で分け合う。やり方は2つ：
//   ① いま読みに行っている最中なら、その約束（Promise）に相乗りする
//   ② 読み終わった直後（FRESH_MS 以内）なら、その結果をそのまま配る
// 🚨 ずっと覚えておくことはしない。権限を変えたのに反映されない、を避けるため。
//    30秒はバッジの数え直しと同じ間隔に揃えてある（新しい決まりを増やさない）。
// 🚨 画面に出る値は1つも変えていない。**同じ値を、何度も読まないようにしただけ**。
// ───────────────────────────────────────────────────────────────
interface ProfileLoad {
  name: string;
  roleTitle: string;
  employmentType: string;
  leaveRequestEnabled: boolean;
  isFaqEditor: boolean;
  /** 🚨 null は「取れなかった」。空の権限で上書きしないため、呼び出し側で既存を保持する */
  perms: Record<string, boolean> | null;
}

const FRESH_MS = 30000;
let sharedInflight: { userId: string; promise: Promise<ProfileLoad | null> } | null = null;
let sharedResult: { userId: string; at: number; value: ProfileLoad | null } | null = null;

async function loadProfileOnce(userId: string): Promise<ProfileLoad | null> {
  if (sharedInflight && sharedInflight.userId === userId) return sharedInflight.promise;
  if (sharedResult && sharedResult.userId === userId && Date.now() - sharedResult.at < FRESH_MS) {
    return sharedResult.value;
  }

  const promise = (async (): Promise<ProfileLoad | null> => {
    const { data, error } = await supabase
      .from('profiles')
      .select('name, role_title, employment_type, leave_request_enabled, is_faq_editor')
      .eq('id', userId)
      .single();
    if (error || !data) return null;

    const role = data.role_title || '一般';
    const perms = await fetchPermsForRole(role);

    // 次回起動時に即表示できるよう名前・役職・権限をキャッシュ保存。
    // 🚨 権限の取得に失敗したとき（不安定な回線など）は、空の権限で上書きしてはいけない。
    //    上書きすると次回起動時にその空キャッシュが読まれ、
    //    「アプリを開いたらナビボタンが減っている」状態になる（2026-07-13 に直した症状の再発経路）。
    writeAuthCache(userId, {
      name: data.name || '',
      roleTitle: role,
      employmentType: data.employment_type || '正社員',
      leaveRequestEnabled: !!data.leave_request_enabled,
      perms: perms ?? readAuthCache(userId)?.perms ?? {},
      isFaqEditor: !!data.is_faq_editor,
    });

    // 🚨 直接UPDATEしない。profiles の直接更新はRLSで管理者のみに絞ってあるため、
    //    本人の最終アクセス記録は RPC 経由にする（2026-08-10）
    // 🚨 ここに置くことで、**1回の読み込みにつき1回**になる（以前は呼ばれた数だけ飛んでいた）
    supabase.rpc('touch_last_sign_in')
      .then(({ error: rpcErr }) => { if (rpcErr) console.error('[useAuth] touch_last_sign_in failed:', rpcErr); });

    return {
      name: data.name || '',
      roleTitle: role,
      employmentType: data.employment_type || '正社員',
      leaveRequestEnabled: !!data.leave_request_enabled,
      isFaqEditor: !!data.is_faq_editor,
      perms,
    };
  })();

  sharedInflight = { userId, promise };
  try {
    const value = await promise;
    // 🚨 **取れなかったとき（null）は覚えない。** 覚えてしまうと、電波が悪くて1回失敗しただけで
    //    30秒のあいだ誰も読み直さなくなる（＝名前も権限も出ないまま固まる）
    if (value) sharedResult = { userId, at: Date.now(), value };
    return value;
  } finally {
    if (sharedInflight && sharedInflight.promise === promise) sharedInflight = null;
  }
}

export const useAuth = (): UseAuthReturn => {
  const { user, previewRole } = useContext(AuthContext);
  const [loading, setLoading] = useState(true);
  // 初期値をキャッシュから同期的に読む（遅延初期化）。AuthProviderが認証確認中は
  // スケルトンでchildrenを遅らせるため、この時点でuserは確定しており、最初の描画から
  // 正しい名前・役職・権限が出せる（＝メール頭文字や減ナビのちらつきが出ない）。
  // 名前はキャッシュ→トークン内の名前(user_metadata.name)→空 の順でフォールバック
  const [initCache] = useState(() => user ? readAuthCache(user.id) : null);
  const [profileName, setProfileName] = useState(initCache?.name || user?.user_metadata?.name || '');
  const [roleTitle, setRoleTitle] = useState(initCache?.roleTitle ?? '');
  const [employmentType, setEmploymentType] = useState(initCache?.employmentType ?? '');
  const [leaveRequestEnabled, setLeaveRequestEnabled] = useState(initCache?.leaveRequestEnabled ?? false);
  const [isFaqEditor, setIsFaqEditor] = useState(initCache?.isFaqEditor ?? false);

  // 実際の役職の権限
  const [featurePerms, setFeaturePerms] = useState<Record<string, boolean>>(initCache?.perms ?? {});
  // プレビュー役職の権限
  const [previewPerms, setPreviewPerms] = useState<Record<string, boolean>>({});

  // 役職の一覧（属性つき）。キャッシュ → 裏で取り直して上書き（hooks/useRoles.ts）
  const roles = useRoles();

  const realIsAdmin = user?.app_metadata?.role === 'admin';
  const effectiveRoleTitle = previewRole ?? roleTitle;
  const isAdmin = previewRole ? false : realIsAdmin;
  // 役職の属性。プレビュー中はプレビュー役職の属性そのもの（管理者の全能は効かせない＝実際の見え方）
  const attrs = attrsFor(roles, effectiveRoleTitle);
  const adminOr = (v: boolean) => (previewRole ? v : (realIsAdmin || v));
  const isApprover      = adminOr(attrs.is_approver);
  const isLeaderPlus    = adminOr(attrs.is_leader_plus);
  const isManagerPlus   = adminOr(attrs.is_manager_plus);
  // 🚨 決裁者に管理者を含めない（経理が3万円超の決裁に自動で入る事故を防ぐ）。管理者は isAdmin で別に扱う
  const isBoardApprover = attrs.is_board_approver;
  const isOrgWide       = adminOr(attrs.is_org_wide);
  const actsAs          = attrs.acts_as;
  const roleRank        = rankOf(roles, effectiveRoleTitle);
  const previewRoles    = previewRoleOptions(roles);

  const fetchProfileName = useCallback(async () => {
    if (!user) return;

    try {
      // 🚨 同じ人・同じ瞬間の読み込みは1回にまとまる（上の loadProfileOnce）
      const loaded = await loadProfileOnce(user.id);
      if (loaded) {
        if (loaded.name) setProfileName(loaded.name);
        setRoleTitle(loaded.roleTitle);
        setEmploymentType(loaded.employmentType);
        setLeaveRequestEnabled(loaded.leaveRequestEnabled);
        setIsFaqEditor(loaded.isFaqEditor);
        // 🚨 取れなかった（null）ときは既存の権限を保持する。空で上書きしない
        if (loaded.perms) setFeaturePerms(loaded.perms);
        setLoading(false);
        return;
      }
    } catch (error) {
      console.error('Error fetching profile name:', error);
    }

    if (user.user_metadata?.name) {
      setProfileName(user.user_metadata.name);
    }
    setLoading(false);
  }, [user]);

  // アカウントが切り替わった時（初回マウントは遅延初期化で対応済み）に、
  // そのユーザーの前回キャッシュを即反映。無ければトークン内の名前にフォールバックし、
  // 前のアカウントの名前が残らないようにする（別アカウント切替時の誤表示防止）。
  const prevUserId = useRef(user?.id);
  useEffect(() => {
    if (!user?.id || user.id === prevUserId.current) { prevUserId.current = user?.id; return; }
    prevUserId.current = user.id;
    const c = readAuthCache(user.id);
    setProfileName(c?.name || user.user_metadata?.name || '');
    setEmploymentType(c?.employmentType ?? '');
    // アカウントを切り替えたら、前のアカウントのFAQ編集権限が残らないよう必ず引き直す
    setIsFaqEditor(c?.isFaqEditor ?? false);
    if (c) {
      setRoleTitle(c.roleTitle);
      setLeaveRequestEnabled(c.leaveRequestEnabled);
      setFeaturePerms(c.perms);
    }
  }, [user?.id, user?.user_metadata?.name]);

  useEffect(() => { fetchProfileName(); }, [fetchProfileName]);

  // プレビュー役職が変わったらその役職の権限を取得（失敗時は既存を保持）
  useEffect(() => {
    if (!previewRole) { setPreviewPerms({}); return; }
    fetchPermsForRole(previewRole).then(p => { if (p) setPreviewPerms(p); });
  }, [previewRole]);

  // 実効権限（プレビュー中はプレビュー役職の権限を使う）
  const effectivePerms = previewRole ? previewPerms : featurePerms;

  const effectiveEmploymentType = previewRole
    ? (previewRole === 'パート' ? 'パート' : '正社員')
    : employmentType;

  // 各権限フラグ（管理者は常に全てtrue）
  const canLeave      = realIsAdmin && !previewRole ? true : (effectivePerms.leave_request   ?? false);
  const canShiftReport = realIsAdmin && !previewRole ? true : (effectivePerms.shift_report    ?? false);
  const canCalendar   = realIsAdmin && !previewRole ? true : (effectivePerms.leave_calendar  ?? false);
  const canPurchaseRequest = realIsAdmin && !previewRole ? true : (effectivePerms.purchase_request ?? false);
  const canOvertime   = realIsAdmin && !previewRole ? true : (effectivePerms.overtime        ?? false);
  // 出張報告の履歴タブ（全員分の閲覧）。画面の出し分けはここ、実データの保護はDB側のRLS
  // （has_feature_permission('trip_report_history')）が担当する。
  // 🚨 RPCで判定すると役職プレビュー中も実アカウント（管理者）で評価されてしまい、
  //    「一般として表示」でも履歴タブが出てしまうため、他機能と同じ effectivePerms を使う
  const canTripReportHistory = realIsAdmin && !previewRole ? true : (effectivePerms.trip_report_history ?? false);
  // 残業の部門集計／全員のシフト予定も同じ方式に揃えた。
  // 以前は各ページから RPC(has_feature_permission) を直接呼んでいたが、
  // RPCは実アカウントで評価されるため役職プレビューが効かなかった（実際の見え方を確認できない）
  const canOvertimeSummary = realIsAdmin && !previewRole ? true : (effectivePerms.overtime_summary ?? false);
  const canShiftPatternDirectory = realIsAdmin && !previewRole ? true : (effectivePerms.shift_pattern_directory ?? false);
  // シフト調整の作業場（2026-09-13）。既定はすべて OFF ＝ 権限行が読めなかったときは出さない。
  // 🚨 テスト中は社長・管理者だけ ON にしてある（DB側・migration 20260912222515）
  // 🚨 useMemo で包む。5つをまとめた「もの」を毎回作り直すと、受け取った側が
  //    useEffect の依存に入れたときに毎描画で走り続ける（このリポジトリで何度も踏んでいる形）
  const saAll = realIsAdmin && !previewRole;
  const shiftAdjust = useMemo(() => ({
    view:    saAll ? true : (effectivePerms.shift_adjust_view    ?? false),
    review:  saAll ? true : (effectivePerms.shift_adjust_review  ?? false),
    plan:    saAll ? true : (effectivePerms.shift_adjust_plan    ?? false),
    request: saAll ? true : (effectivePerms.shift_adjust_request ?? false),
    decide:  saAll ? true : (effectivePerms.shift_adjust_decide  ?? false),
  }), [saAll, effectivePerms]);
  // FAQ（よくある質問）。ナビの「💡 FAQ」と各ページの「❓ FAQ」の両方がこれで切り替わる。
  // 管理画面「役職・機能権限管理」でONにした役職に表示される
  const canFaq = realIsAdmin && !previewRole ? true : (effectivePerms.faq ?? false);
  // ナビに出すかは別設定。ただし FAQ 自体が使えない人には出さない
  // （出すとボタンを押した先で弾かれる＝押せるのに見られないボタンになる）
  const canFaqNav = canFaq && (realIsAdmin && !previewRole ? true : (effectivePerms.faq_nav ?? false));
  // 🚨 これまで管理画面の役職トグルがどこからも読まれておらず、押しても何も起きなかった4機能。
  //    「設定したのに効かない」状態だったので、他機能と同じ形で配線した（2026-08-09）
  //    ⚠️ 公開設定（全公開／リーダー以上／社長のみ）と役職トグルの両方を満たす人にだけ表示される。
  //       連絡板を将来「全公開」にするときは、パート・一般・フロア責任者の役職トグルも
  //       ONにしないと使えないままになるので注意
  const canExpense    = realIsAdmin && !previewRole ? true : (effectivePerms.expense          ?? false);
  const canTripReport = realIsAdmin && !previewRole ? true : (effectivePerms.trip_report      ?? false);
  const canBoard      = realIsAdmin && !previewRole ? true : (effectivePerms.board            ?? false);
  // 場所予約。既定は false（＝権限行が無ければ出さない）。
  // 🚨 「無ければ全員に出す」にすると、権限行を入れ忘れたときに全員へ公開されてしまう
  const canRoomBooking = realIsAdmin && !previewRole ? true : (effectivePerms.room_booking     ?? false);
  const canLeaveApprovals = realIsAdmin && !previewRole ? true : (effectivePerms.leave_approvals ?? false);
  // 上長が部下に対して行う操作の権限（2026-09-09 追加）。
  // 🚨 既定は false。権限行を入れ忘れたときに全員が使える状態になるより安全側に倒す。
  //    管理画面「役職・機能権限」でONにする（初期値は migration で入れている）。
  //    🚨 DB側（set_leave_shift_adjust など）も同じ権限を見ている。片方だけ変えないこと。
  const canLeaveShiftAdjust = realIsAdmin && !previewRole ? true : (effectivePerms.leave_shift_adjust ?? false);
  const canApplicationRequest = realIsAdmin && !previewRole ? true : (effectivePerms.application_request ?? false);
  const canPartLeaveFormSend = realIsAdmin && !previewRole ? true : (effectivePerms.part_leave_form_send ?? false);
  // 勤怠カレンダーへの登録・取消（2026-09-09）。🚨 役職名では判定しない。
  //    以前は承認者（APPROVER_ROLES）で出していたが、DBのRLSはリーダー以上で弾いており
  //    フロア責任者が「押せるのに保存されない」状態だった。画面もDBも同じトグルを読む
  const canAttendanceInput = realIsAdmin && !previewRole ? true : (effectivePerms.attendance_input ?? false);

  const handleLogout = useCallback(async () => {
    console.log('[logout] clicked');
    try {
      const { error } = await supabase.auth.signOut({ scope: 'local' });
      if (error) { console.error('[logout] signOut error', error); return; }
      console.log('[logout] signOut success');
      // 🚨 未送信の安否確認の回答は、localStorage.clear() の巻き添えで消してはいけない。
      //    安否の回答は「消えてよい下書き」ではないので、退避して書き戻す。
      //    （誰の回答かは中に持たせてあるので、別の人がログインしても送り違えない）
      const keepSafetyQueue = readRawPendingQueue();
      localStorage.clear();
      sessionStorage.clear();
      writeRawPendingQueue(keepSafetyQueue);
      window.location.href = '/signin';
    } catch (error) {
      console.error('[logout] unexpected error:', error);
      window.location.href = '/signin';
    }
  }, []);

  return {
    user,
    loading,
    isAdmin,
    isApprover,
    isLeaderPlus,
    isManagerPlus,
    isBoardApprover,
    isOrgWide,
    actsAs,
    roleRank,
    roles,
    previewRoles,
    canAttendanceInput,
    profileName,
    roleTitle: effectiveRoleTitle,
    employmentType: effectiveEmploymentType,
    canLeave,
    canShiftReport,
    canCalendar,
    canPurchaseRequest,
    canOvertime,
    canTripReportHistory,
    canOvertimeSummary,
    canShiftPatternDirectory,
    shiftAdjust,
    canFaq,
    canFaqNav,
    canExpense,
    canTripReport,
    canBoard,
    canRoomBooking,
    canLeaveApprovals,
    canLeaveShiftAdjust,
    canApplicationRequest,
    canPartLeaveFormSend,
    leaveRequestEnabled,
    // 役職プレビュー中は他の権限と同じく実権限を伏せる（プレビューで実際の見え方を確認するため）
    isFaqEditor: previewRole ? false : isFaqEditor,
    handleLogout,
  };
};

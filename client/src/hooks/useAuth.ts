import { useState, useEffect, useCallback, useContext, useRef } from 'react';
import type { AuthUser } from '../types';
import { supabase } from '../lib/supabaseClient';
import { AuthContext } from '../contexts/AuthContext.tsx';
import { readRawPendingQueue, writeRawPendingQueue } from '../lib/safetyStorage';

const APPROVER_ROLES = ['リーダー', 'マネージャー', 'フロア責任者', '社長', '管理者'] as const;

interface UseAuthReturn {
  user: AuthUser | null;
  loading: boolean;
  isAdmin: boolean;
  isApprover: boolean;
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
  canExpense: boolean;
  canTripReport: boolean;
  canBoard: boolean;
  canLeaveApprovals: boolean;
  leaveRequestEnabled: boolean;
  /** FAQ管理画面だけを使える専用アカウントか（管理者は別途 isAdmin で判定） */
  isFaqEditor: boolean;
  handleLogout: () => Promise<void>;
}

const PREVIEW_ROLES = ['パート', '一般', 'リーダー', 'マネージャー', 'フロア責任者', '社長', '管理者'] as const;
export { PREVIEW_ROLES };

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

  const realIsAdmin = user?.app_metadata?.role === 'admin';
  const effectiveRoleTitle = previewRole ?? roleTitle;
  const isAdmin = previewRole ? false : realIsAdmin;
  const isApprover = previewRole
    ? APPROVER_ROLES.includes(previewRole as typeof APPROVER_ROLES[number])
    : (realIsAdmin || APPROVER_ROLES.includes(roleTitle as typeof APPROVER_ROLES[number]));

  const fetchProfileName = useCallback(async () => {
    if (!user) return;

    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('name, role_title, employment_type, leave_request_enabled, is_faq_editor')
        .eq('id', user.id)
        .single();

      if (!error && data) {
        if (data.name) setProfileName(data.name);
        const role = data.role_title || '一般';
        setRoleTitle(role);
        const empType = data.employment_type || '正社員';
        setEmploymentType(empType);
        setLeaveRequestEnabled(!!data.leave_request_enabled);
        setIsFaqEditor(!!data.is_faq_editor);

        // DBから権限を取得（失敗時nullは無視して既存の権限を保持）
        const perms = await fetchPermsForRole(role);
        if (perms) setFeaturePerms(perms);

        // 次回起動時に即表示できるよう名前・役職・権限をキャッシュ保存。
        // 🚨 権限の取得に失敗したとき（不安定な回線など）は、空の権限で上書きしてはいけない。
        //    上書きすると次回起動時にその空キャッシュが読まれ、
        //    「アプリを開いたらナビボタンが減っている」状態になる（2026-07-13 に直した症状の再発経路）。
        //    失敗時は前回の権限をそのまま引き継ぐ
        writeAuthCache(user.id, {
          name: data.name || '',
          roleTitle: role,
          employmentType: empType,
          leaveRequestEnabled: !!data.leave_request_enabled,
          perms: perms ?? readAuthCache(user.id)?.perms ?? {},
          isFaqEditor: !!data.is_faq_editor,
        });

        // 🚨 直接UPDATEしない。profiles の直接更新はRLSで管理者のみに絞ってあるため、
        //    本人の最終アクセス記録は RPC 経由にする（2026-08-10）
        supabase.rpc('touch_last_sign_in')
          .then(({ error }) => { if (error) console.error('[useAuth] touch_last_sign_in failed:', error); });

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
  // 🚨 これまで管理画面の役職トグルがどこからも読まれておらず、押しても何も起きなかった4機能。
  //    「設定したのに効かない」状態だったので、他機能と同じ形で配線した（2026-08-09）
  //    ⚠️ 公開設定（全公開／リーダー以上／社長のみ）と役職トグルの両方を満たす人にだけ表示される。
  //       連絡板を将来「全公開」にするときは、パート・一般・フロア責任者の役職トグルも
  //       ONにしないと使えないままになるので注意
  const canExpense    = realIsAdmin && !previewRole ? true : (effectivePerms.expense          ?? false);
  const canTripReport = realIsAdmin && !previewRole ? true : (effectivePerms.trip_report      ?? false);
  const canBoard      = realIsAdmin && !previewRole ? true : (effectivePerms.board            ?? false);
  const canLeaveApprovals = realIsAdmin && !previewRole ? true : (effectivePerms.leave_approvals ?? false);

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
    canExpense,
    canTripReport,
    canBoard,
    canLeaveApprovals,
    leaveRequestEnabled,
    // 役職プレビュー中は他の権限と同じく実権限を伏せる（プレビューで実際の見え方を確認するため）
    isFaqEditor: previewRole ? false : isFaqEditor,
    handleLogout,
  };
};

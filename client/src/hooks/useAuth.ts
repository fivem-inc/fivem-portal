import { useState, useEffect, useCallback, useContext } from 'react';
import type { AuthUser } from '../types';
import { supabase } from '../lib/supabaseClient';
import { AuthContext } from '../contexts/AuthContext.tsx';

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
  leaveRequestEnabled: boolean;
  handleLogout: () => Promise<void>;
}

const PREVIEW_ROLES = ['パート', '一般', 'リーダー', 'マネージャー', 'フロア責任者', '社長', '管理者'] as const;
export { PREVIEW_ROLES };

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
  const [profileName, setProfileName] = useState('');
  const [roleTitle, setRoleTitle] = useState('');
  const [employmentType, setEmploymentType] = useState('');
  const [leaveRequestEnabled, setLeaveRequestEnabled] = useState(false);

  // 実際の役職の権限
  const [featurePerms, setFeaturePerms] = useState<Record<string, boolean>>({});
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
        .select('name, role_title, employment_type, leave_request_enabled')
        .eq('id', user.id)
        .single();

      if (!error && data) {
        if (data.name) setProfileName(data.name);
        const role = data.role_title || '一般';
        setRoleTitle(role);
        const empType = data.employment_type || '正社員';
        setEmploymentType(empType);
        setLeaveRequestEnabled(!!data.leave_request_enabled);

        // DBから権限を取得（失敗時nullは無視して既存の権限を保持）
        const perms = await fetchPermsForRole(role);
        if (perms) setFeaturePerms(perms);

        supabase.from('profiles')
          .update({ last_sign_in_at: new Date().toISOString() })
          .eq('id', user.id)
          .select('id')
          .then(({ error }) => { if (error) console.error('[useAuth] last_sign_in_at update failed:', error); });

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

  const handleLogout = useCallback(async () => {
    console.log('[logout] clicked');
    try {
      const { error } = await supabase.auth.signOut({ scope: 'local' });
      if (error) { console.error('[logout] signOut error', error); return; }
      console.log('[logout] signOut success');
      localStorage.clear();
      sessionStorage.clear();
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
    leaveRequestEnabled,
    handleLogout,
  };
};

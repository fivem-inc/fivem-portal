import { useState, useEffect, useCallback, useContext } from 'react';
import type { AuthUser } from '../types';
import { supabase } from '../lib/supabaseClient';
import { AuthContext } from '../contexts/AuthContext.tsx';

const APPROVER_ROLES = ['リーダー', 'マネージャー', '社長', '管理者'] as const;

interface UseAuthReturn {
  user: AuthUser | null;
  loading: boolean;
  isAdmin: boolean;
  isApprover: boolean;
  profileName: string;
  roleTitle: string;
  canLeave: boolean;
  leaveRequestEnabled: boolean;
  handleLogout: () => Promise<void>;
}


export const useAuth = (): UseAuthReturn => {
  const { user } = useContext(AuthContext);
  const [loading, setLoading] = useState(true);
  const [profileName, setProfileName] = useState('');
  const [roleTitle, setRoleTitle] = useState('');
  const [canLeave, setCanLeave] = useState(false);
  const [leaveRequestEnabled, setLeaveRequestEnabled] = useState(false);

  const isAdmin = user?.app_metadata?.role === 'admin';
  const isApprover = isAdmin || APPROVER_ROLES.includes(roleTitle as typeof APPROVER_ROLES[number]);

  const fetchProfileName = useCallback(async () => {
    if (!user) return;
    
    // まずprofilesテーブルから名前を取得（管理者が更新した場合に対応）
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
        const alwaysShow = ['リーダー', 'マネージャー', '社長', '管理者'].includes(role);
        const isAdmin = user?.app_metadata?.role === 'admin';
        setCanLeave(alwaysShow || isAdmin);
        setLeaveRequestEnabled(!!data.leave_request_enabled);
        setLoading(false);
        return;
      }
    } catch (error) {
      console.error('Error fetching profile name:', error);
    }
    
    // profilesテーブルに名前がない場合はuser_metadataから取得
    if (user.user_metadata?.name) {
      setProfileName(user.user_metadata.name);
    }
    setLoading(false);
  }, [user]);

  const handleLogout = useCallback(async () => {
    try {
      // セッションをクリアしてからログアウト
      await supabase.auth.signOut({ scope: 'local' });
      
      // ローカルストレージをクリア（念のため）
      localStorage.clear();
      sessionStorage.clear();
      
      // ページをリロードしてサインイン画面に移動
      window.location.href = '/signin';
    } catch (error) {
      console.error('Unexpected error during logout:', error);
      // エラーが発生してもサインイン画面に移動
      window.location.href = '/signin';
    }
  }, []);

  useEffect(() => {
    fetchProfileName();
  }, [fetchProfileName]);

  return {
    user,
    loading,
    isAdmin,
    isApprover,
    profileName,
    roleTitle,
    canLeave,
    leaveRequestEnabled,
    handleLogout
  };
};
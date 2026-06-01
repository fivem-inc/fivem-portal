import { useState, useEffect, useCallback, useContext } from 'react';
import type { AuthUser } from '../types';
import { supabase } from '../lib/supabaseClient';
import { AuthContext } from '../contexts/AuthContext.tsx';

interface UseAuthReturn {
  user: AuthUser | null;
  loading: boolean;
  isAdmin: boolean;
  profileName: string;
  roleTitle: string;
  canLeave: boolean;
  handleLogout: () => Promise<void>;
}

export const useAuth = (): UseAuthReturn => {
  const { user } = useContext(AuthContext);
  const [loading] = useState(false);
  const [profileName, setProfileName] = useState('');
  const [roleTitle, setRoleTitle] = useState('一般');
  const [canLeave, setCanLeave] = useState(false);

  const isAdmin = user?.app_metadata?.role === 'admin';

  const fetchProfileName = useCallback(async () => {
    if (!user) return;
    
    // まずprofilesテーブルから名前を取得（管理者が更新した場合に対応）
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('name, role_title, employment_type')
        .eq('id', user.id)
        .single();

      if (!error && data) {
        if (data.name) setProfileName(data.name);
        if (data.role_title) setRoleTitle(data.role_title);
        // 休暇申請表示条件: 管理者・リーダー・マネージャー・社長 は常時表示
        // パート(一般) は leave_request_enabled=true のときのみ表示
        const alwaysShow = ['リーダー', 'マネージャー', '社長', '管理者'].includes(data.role_title || '');
        const isAdmin = user?.app_metadata?.role === 'admin';
        setCanLeave(alwaysShow || isAdmin);
        return;
      }
    } catch (error) {
      console.error('Error fetching profile name:', error);
    }
    
    // profilesテーブルに名前がない場合はuser_metadataから取得
    if (user.user_metadata?.name) {
      setProfileName(user.user_metadata.name);
    }
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
    profileName,
    roleTitle,
    canLeave,
    handleLogout
  };
};
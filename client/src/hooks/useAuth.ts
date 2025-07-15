import { useState, useEffect, useCallback, useContext } from 'react';
import type { AuthUser } from '../types';
import { supabase } from '../lib/supabaseClient';
import { AuthContext } from '../contexts/AuthContext.tsx';

interface UseAuthReturn {
  user: AuthUser | null;
  loading: boolean;
  isAdmin: boolean;
  profileName: string;
  showNameInput: boolean;
  setProfileName: (name: string) => void;
  handleSaveName: () => Promise<void>;
  handleLogout: () => Promise<void>;
  startEditingName: () => void;
}

export const useAuth = (): UseAuthReturn => {
  const { user } = useContext(AuthContext);
  const [loading] = useState(false);
  const [profileName, setProfileName] = useState('');
  const [showNameInput, setShowNameInput] = useState(false);

  const isAdmin = user?.app_metadata?.role === 'admin';

  const fetchProfileName = useCallback(async () => {
    if (!user) return;
    
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('name')
        .eq('id', user.id)
        .single();

      if (error) {
        console.error('Error fetching profile name:', error.message);
      } else if (data && data.name) {
        setProfileName(data.name);
        setShowNameInput(false);
      } else {
        setShowNameInput(true);
      }
    } catch (error) {
      console.error('Unexpected error fetching profile name:', error);
    }
  }, [user]);

  const handleSaveName = useCallback(async () => {
    if (!user || !profileName.trim()) {
      alert('名前を入力してください。');
      return;
    }

    console.log('=== 名前保存開始 ===');
    console.log('ユーザーID:', user.id);
    console.log('保存する名前:', profileName.trim());

    try {
      // まずprofilesテーブルにレコードが存在するかチェック
      const { data: existingProfile, error: fetchError } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', user.id)
        .single();

      console.log('既存プロフィール:', existingProfile);
      console.log('取得エラー:', fetchError);

      let result;
      if (fetchError && fetchError.code === 'PGRST116') {
        // レコードが存在しない場合は新規作成
        console.log('新規プロフィール作成');
        result = await supabase
          .from('profiles')
          .insert({ id: user.id, name: profileName.trim() });
      } else {
        // レコードが存在する場合は更新
        console.log('既存プロフィール更新');
        result = await supabase
          .from('profiles')
          .update({ name: profileName.trim() })
          .eq('id', user.id);
      }

      console.log('保存結果:', result);

      if (result.error) {
        console.error('保存エラー:', result.error);
        alert('名前の保存に失敗しました: ' + result.error.message);
      } else {
        console.log('✅ 名前保存成功');
        alert('名前を保存しました！');
        setShowNameInput(false);
      }
    } catch (error) {
      console.error('Unexpected error saving name:', error);
      alert('名前の保存中にエラーが発生しました。');
    }
  }, [user, profileName]);

  const handleLogout = useCallback(async () => {
    try {
      const { error } = await supabase.auth.signOut();
      if (error) {
        console.error('Error logging out:', error.message);
      }
    } catch (error) {
      console.error('Unexpected error during logout:', error);
    }
  }, []);

  const startEditingName = () => {
    setShowNameInput(true);
  };

  useEffect(() => {
    fetchProfileName();
  }, [fetchProfileName]);

  return {
    user,
    loading,
    isAdmin,
    profileName,
    showNameInput,
    setProfileName,
    handleSaveName,
    handleLogout,
    startEditingName
  };
};
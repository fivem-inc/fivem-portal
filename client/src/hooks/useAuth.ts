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
    
    console.log('=== 名前取得開始 ===');
    console.log('user_metadata:', user.user_metadata);
    
    // まずuser_metadataから名前を取得
    if (user.user_metadata?.name) {
      console.log('user_metadataから名前取得:', user.user_metadata.name);
      setProfileName(user.user_metadata.name);
      setShowNameInput(false);
      return;
    }
    
    // user_metadataに名前がない場合はprofilesテーブルから取得
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('name')
        .eq('id', user.id)
        .single();

      console.log('profilesテーブルから取得:', data);

      if (error) {
        console.error('Error fetching profile name:', error.message);
        setShowNameInput(true);
      } else if (data && data.name) {
        setProfileName(data.name);
        setShowNameInput(false);
      } else {
        setShowNameInput(true);
      }
    } catch (error) {
      console.error('Unexpected error fetching profile name:', error);
      setShowNameInput(true);
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
      // user_metadataを更新
      const { error: updateError } = await supabase.auth.updateUser({
        data: { 
          name: profileName.trim(),
          display_name: profileName.trim(),
          full_name: profileName.trim()
        }
      });

      console.log('user_metadata更新結果:', updateError);

      if (updateError) {
        console.error('user_metadata更新エラー:', updateError);
        alert('名前の保存に失敗しました: ' + updateError.message);
      } else {
        console.log('✅ user_metadata名前保存成功');
        
        // profilesテーブルも同期更新（既存データとの整合性のため）
        const { error: profileError } = await supabase
          .from('profiles')
          .upsert({ id: user.id, name: profileName.trim() });
        
        if (profileError) {
          console.warn('profiles同期更新エラー:', profileError);
        }
        
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
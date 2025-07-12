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

    try {
      const { error } = await supabase
        .from('profiles')
        .update({ name: profileName.trim() })
        .eq('id', user.id);

      if (error) {
        alert('名前の保存に失敗しました: ' + error.message);
      } else {
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
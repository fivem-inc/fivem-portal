import React, { createContext, useState, useEffect } from 'react';
import type { AuthContextType, AuthUser } from '../types';
import { supabase } from '../lib/supabaseClient';

// AuthContextの作成
// eslint-disable-next-line react-refresh/only-export-components
export const AuthContext = createContext<AuthContextType>({ user: null });

// AuthProviderコンポーネント
export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const getSession = async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        setUser(session?.user as AuthUser ?? null);
        setLoading(false);
      } catch (error) {
        console.error('Error getting session:', error);
        setLoading(false);
      }
    };

    getSession();

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      console.log('🔥 認証イベント:', event, '| セッション:', !!session);
      
      if (event === 'USER_UPDATED') {
        console.log('✅ USER_UPDATED イベント検知 - ユーザー情報更新完了');
        
        // 現在のユーザー情報と比較してメール変更かどうかを判断
        const currentUser = user;
        const newUser = session?.user;
        
        if (currentUser && newUser && currentUser.email !== newUser.email) {
          // メールアドレスが変更された場合のみ処理
          console.log('📧 メールアドレス変更検知:', currentUser.email, '→', newUser.email);
          alert('メールアドレスの変更が完了しました！新しいメールアドレスでログインし直してください。');
          
          // 3秒後にログアウトしてサインイン画面に移動
          setTimeout(async () => {
            await supabase.auth.signOut();
            window.location.href = '/signin';
          }, 3000);
        } else {
          // 名前変更やその他の更新の場合
          console.log('👤 ユーザー情報更新（メール以外）');
        }
      }
      
      setUser(session?.user as AuthUser ?? null);
    });

    return () => {
      subscription.unsubscribe();
    };
  }, []);

  return (
    <AuthContext.Provider value={{ user }}>
      {!loading && children}
    </AuthContext.Provider>
  );
};
import React, { createContext, useState, useEffect } from 'react';
import type { AuthContextType, AuthUser } from '../types';
import { supabase } from '../lib/supabaseClient';

// AuthContextの作成
// eslint-disable-next-line react-refresh/only-export-components
export const AuthContext = createContext<AuthContextType>({ user: null, previewRole: null, setPreviewRole: () => {}, blockedMessage: null, clearBlockedMessage: () => {} });

// AuthProviderコンポーネント
export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [previewRole, setPreviewRole] = useState<string | null>(null);
  const [blockedMessage, setBlockedMessage] = useState<string | null>(null);

  // is_active=false（退職済み・承認待ち）のユーザーは、ログイン状態として扱う前に弾く
  const applySessionUser = async (sessionUser: AuthUser | null) => {
    if (!sessionUser) { setUser(null); return; }
    const { data: profile } = await supabase
      .from('profiles')
      .select('is_active, approval_status')
      .eq('id', sessionUser.id)
      .single();
    if (profile && profile.is_active === false) {
      await supabase.auth.signOut();
      setUser(null);
      setBlockedMessage(
        profile.approval_status === 'pending'
          ? 'ご登録ありがとうございます。管理者の承認をお待ちください。'
          : 'このアカウントは無効です。管理者にお問い合わせください。'
      );
      return;
    }
    setUser(sessionUser);
  };

  useEffect(() => {
    const getSession = async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        await applySessionUser(session?.user as AuthUser ?? null);
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
      
      // SIGNED_IN（通常ログイン・メール確認リンクからの自動ログイン含む）は
      // is_active判定が終わるまで画面全体を非表示にし、承認待ち・退職済みの画面が一瞬でも見えないようにする
      if (event === 'SIGNED_IN') {
        setLoading(true);
        applySessionUser(session?.user as AuthUser ?? null).finally(() => setLoading(false));
      } else {
        applySessionUser(session?.user as AuthUser ?? null);
      }
    });

    return () => {
      subscription.unsubscribe();
    };
  }, []);

  return (
    <AuthContext.Provider value={{ user, previewRole, setPreviewRole, blockedMessage, clearBlockedMessage: () => setBlockedMessage(null) }}>
      {!loading && children}
    </AuthContext.Provider>
  );
};
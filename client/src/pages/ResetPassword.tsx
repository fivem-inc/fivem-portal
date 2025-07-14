import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabaseClient';

export default function ResetPassword() {
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    console.log('=== ResetPassword ページ初期化 ===');
    
    // 認証イベント監視
    const { data: authListener } = supabase.auth.onAuthStateChange((event, session) => {
      console.log('🔥 ResetPassword 認証イベント:', event, '| セッション:', !!session);
      
      if (event === 'PASSWORD_RECOVERY') {
        console.log('✅ PASSWORD_RECOVERY イベント検知');
      }
      
      if (event === 'SIGNED_IN' && session) {
        console.log('✅ SIGNED_IN イベント検知 - パスワードリセット用セッション確立');
      }
    });

    return () => {
      authListener.subscription.unsubscribe();
    };
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    // バリデーション
    if (newPassword !== confirmPassword) {
      setError('パスワードが一致しません。');
      setLoading(false);
      return;
    }

    if (newPassword.length < 6) {
      setError('パスワードは6文字以上で入力してください。');
      setLoading(false);
      return;
    }

    try {
      console.log('=== パスワード更新実行 ===');
      
      // 現在のセッションを確認
      const { data: sessionData } = await supabase.auth.getSession();
      if (!sessionData.session) {
        setError('セッションが見つかりません。メールリンクから再度アクセスしてください。');
        setLoading(false);
        return;
      }

      console.log('✅ セッション確認完了 - パスワード更新実行');

      // パスワード更新
      const { error: updateError } = await supabase.auth.updateUser({
        password: newPassword
      });

      if (updateError) {
        console.error('❌ パスワード更新エラー:', updateError);
        
        let errorMessage = updateError.message;
        if (updateError.message.includes('session') || updateError.message.includes('unauthorized')) {
          errorMessage = 'セッションが無効です。メールリンクから再度アクセスしてください。';
        } else if (updateError.message.includes('Password should be at least')) {
          errorMessage = 'パスワードは6文字以上で入力してください。';
        }
        setError(errorMessage);
      } else {
        console.log('✅ パスワード更新成功！');
        setSuccess(true);
        
        // 3秒後にログアウトしてサインイン画面に移動
        setTimeout(async () => {
          await supabase.auth.signOut();
          window.location.href = '/signin';
        }, 3000);
      }
    } catch (error) {
      console.error('❌ パスワード更新処理エラー:', error);
      setError('パスワードの更新中にエラーが発生しました。再度お試しください。');
    }
    
    setLoading(false);
  };

  if (success) {
    return (
      <div style={{ maxWidth: 320, margin: '80px auto', textAlign: 'center' }}>
        <h2>✅ パスワード更新完了</h2>
        <p style={{ color: 'green', marginTop: '20px' }}>
          パスワードが正常に更新されました！<br />
          3秒後に自動的にログイン画面に移動します。
        </p>
        <div style={{ marginTop: '20px' }}>
          <button 
            onClick={async () => {
              await supabase.auth.signOut();
              window.location.href = '/signin';
            }}
            style={{ padding: '10px 20px' }}
          >
            すぐにログイン画面へ
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 320, margin: '80px auto', textAlign: 'center' }}>
      <h2>新しいパスワードを設定</h2>
      <p style={{ marginBottom: '20px', color: '#666' }}>
        メールリンクからアクセスしました。新しいパスワードを入力してください。
      </p>
      
      <form onSubmit={handleSubmit}>
        <input
          type='password'
          style={{ width: '100%', margin: '6px 0', padding: 8 }}
          placeholder='新しいパスワード（6文字以上）'
          value={newPassword}
          onChange={e => setNewPassword(e.target.value)}
          required
        />
        <input
          type='password'
          style={{ width: '100%', margin: '6px 0', padding: 8 }}
          placeholder='新しいパスワード（確認用）'
          value={confirmPassword}
          onChange={e => setConfirmPassword(e.target.value)}
          required
        />
        <button 
          type="submit" 
          style={{ width: '100%', padding: 8, marginTop: '10px' }} 
          disabled={loading}
        >
          {loading ? 'パスワード更新中...' : 'パスワードを更新'}
        </button>
        
        {error && <p style={{ color: 'red', marginTop: '10px' }}>{error}</p>}
      </form>
      
      <div style={{ marginTop: '20px' }}>
        <button
          onClick={() => window.location.href = '/signin'}
          style={{ 
            background: 'none', 
            border: 'none', 
            color: 'blue', 
            cursor: 'pointer',
            textDecoration: 'underline'
          }}
        >
          ログイン画面に戻る
        </button>
      </div>
    </div>
  );
}
import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabaseClient';

export default function ResetPassword() {
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  // 自前のパスワード設定のメール（2026-10-04・password-setup-mail）は ?token_hash=… で来る。
  // 🚨 開いただけでは使わない。［パスワードを決める］を押して初めて verifyOtp する
  //    （会社のメールの安全確認がリンクを先に開いても、1回きりの鍵が使われないように）
  const [tokenHash] = useState(() => new URLSearchParams(window.location.search).get('token_hash'));
  const [verified, setVerified] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const verifyLink = async () => {
    if (!tokenHash) return;
    setVerifying(true);
    setError(null);
    const { error: vErr } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: 'recovery' });
    setVerifying(false);
    if (vErr) {
      setError('このリンクは期限が切れているか、すでに使われています。ログイン画面の［はじめての方］または「パスワードを忘れた場合」から、もう一度メールを受け取ってください。');
      return;
    }
    // 鍵を画面のアドレスから消す（戻る・再読み込みで使い回さない）
    window.history.replaceState(null, '', '/reset-password');
    setVerified(true);
  };

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
        // ホームの「パスワードを変更してください」のバナーを消す（2026-10-04）。失敗しても更新自体は成功している
        const { error: flagErr } = await supabase.rpc('clear_my_password_flag');
        if (flagErr) console.error('[reset-password] 印の解除に失敗:', flagErr.message);
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

  if (tokenHash && !verified) {
    return (
      <div style={{ maxWidth: 320, margin: '80px auto', textAlign: 'center' }}>
        <h2>パスワードの設定</h2>
        <p style={{ marginBottom: '20px', color: '#666' }}>下のボタンを押して、パスワードを決めてください。</p>
        <button
          onClick={verifyLink}
          disabled={verifying}
          style={{ width: '100%', padding: 10, background: '#1976d2', color: '#fff', border: 'none', borderRadius: 4, fontWeight: 'bold', cursor: 'pointer' }}
        >
          {verifying ? '確認しています...' : 'パスワードを決める'}
        </button>
        {error && <p style={{ color: 'red', marginTop: '10px' }}>{error}</p>}
        <div style={{ marginTop: '20px' }}>
          <button onClick={() => window.location.href = '/signin'} style={{ background: 'none', border: 'none', color: 'blue', cursor: 'pointer', textDecoration: 'underline' }}>
            ログイン画面に戻る
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 320, margin: '80px auto', textAlign: 'center' }}>
      <h2>新しいパスワードを設定</h2>
      <p style={{ marginBottom: '20px', color: '#666' }}>
        新しいパスワードを入力してください。
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
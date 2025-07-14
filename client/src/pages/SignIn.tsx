import { useState, useContext, useEffect } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient';
import { AuthContext } from '../contexts/AuthContext.tsx';

export default function SignIn() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [name, setName] = useState(''); // 新規追加: 名前
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSignUp, setIsSignUp] = useState(false); // 新規登録モードかどうかの状態
  const [isResettingPassword, setIsResettingPassword] = useState(false); // パスワードリセットモードかどうかの状態
  const [isSettingNewPassword, setIsSettingNewPassword] = useState(false); // 新しいパスワード設定モード
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [confirmationMessage, setConfirmationMessage] = useState<string | null>(null);
  const { user } = useContext(AuthContext); // AuthContextからuserを取得
  const [searchParams] = useSearchParams();

  // メール確認・パスワードリセット完了の検知
  useEffect(() => {
    const handleAuthRedirect = async () => {
      // URLパラメータをチェック
      const accessToken = searchParams.get('access_token');
      const refreshToken = searchParams.get('refresh_token');
      const type = searchParams.get('type');
      
      if (accessToken && refreshToken) {
        try {
          // 一旦ログアウトして、手動ログインを促す
          await supabase.auth.signOut();
          
          if (type === 'signup') {
            setConfirmationMessage('✅ メール確認が完了しました！ログイン情報を入力してログインしてください。');
            setIsSignUp(false); // ログインフォームに切り替え
          } else if (type === 'recovery') {
            // パスワードリセット確認後は新しいパスワード設定画面を表示
            setIsSettingNewPassword(true);
            setIsSignUp(false);
            setIsResettingPassword(false);
            setConfirmationMessage('🔐 新しいパスワードを設定してください。');
          }
          
          // URLをクリーンアップ
          window.history.replaceState({}, document.title, window.location.pathname);
        } catch (error) {
          console.error('Auth redirect handling error:', error);
        }
      }
    };

    handleAuthRedirect();
  }, [searchParams]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      // エラーメッセージを日本語化
      let errorMessage = error.message;
      if (error.message.includes('Invalid login credentials')) {
        errorMessage = 'メールアドレスまたはパスワードが正しくありません。';
      } else if (error.message.includes('Email not confirmed')) {
        errorMessage = 'メールアドレスが確認されていません。メールを確認してください。';
      }
      setError(errorMessage);
    }
    setLoading(false);
  };

  const handleSignUp = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    if (password !== confirmPassword) {
      setError('パスワードが一致しません。');
      setLoading(false);
      return;
    }

    if (!name.trim()) {
      setError('名前を入力してください。');
      setLoading(false);
      return;
    }

    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { 
          name: name.trim(),
          display_name: name.trim(),
          full_name: name.trim()
        }
      }
    });

    if (error) {
      // エラーメッセージを日本語化
      let errorMessage = error.message;
      if (error.message.includes('Unable to validate email address: invalid format')) {
        errorMessage = 'メールアドレスの形式が正しくありません。';
      } else if (error.message.includes('User already registered')) {
        errorMessage = 'このメールアドレスは既に登録されています。';
      } else if (error.message.includes('Password should be at least')) {
        errorMessage = 'パスワードは6文字以上で入力してください。';
      } else if (error.message.includes('Signup is disabled')) {
        errorMessage = '新規登録は現在無効になっています。';
      }
      setError(errorMessage);
    } else {
      // トリガーで自動作成されるため、コード側での作成は不要
      alert('登録が完了しました。メールを確認してアカウントを有効にしてください。');
      setIsSignUp(false); // 登録後、ログインフォームに戻る
    }
    setLoading(false);
  };

  const handlePasswordReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const { error } = await supabase.auth.resetPasswordForEmail(email);

    if (error) {
      setError(error.message);
    } else {
      alert('パスワードリセットのメールを送信しました。メールを確認してください。');
      setIsResettingPassword(false); // リセット後、ログインフォームに戻る
    }
    setLoading(false);
  };

  const handleNewPasswordSet = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    if (newPassword !== confirmNewPassword) {
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
      const { error } = await supabase.auth.updateUser({
        password: newPassword
      });

      if (error) {
        setError('パスワードの更新に失敗しました: ' + error.message);
      } else {
        await supabase.auth.signOut(); // 一旦ログアウト
        setIsSettingNewPassword(false);
        setNewPassword('');
        setConfirmNewPassword('');
        setConfirmationMessage('✅ パスワードが更新されました！新しいパスワードでログインしてください。');
      }
    } catch (error) {
      setError('パスワードの更新中にエラーが発生しました。');
    }
    setLoading(false);
  };

  // すでにログイン済みの場合は、ダッシュボードにリダイレクト
  if (user) {
    return <Navigate to="/" replace />;
  }

  return (
    <div style={{ maxWidth: 320, margin: '80px auto', textAlign: 'center' }}>
      <h2>ファイブM 交通費精算</h2>
      {isSettingNewPassword ? (
        <form onSubmit={handleNewPasswordSet}>
          <p>新しいパスワードを設定してください。</p>
          <input
            type='password'
            style={{ width: '100%', margin: '6px 0', padding: 8 }}
            placeholder='新しいパスワード'
            value={newPassword}
            onChange={e => setNewPassword(e.target.value)}
            required
          />
          <input
            type='password'
            style={{ width: '100%', margin: '6px 0', padding: 8 }}
            placeholder='新しいパスワード（確認用）'
            value={confirmNewPassword}
            onChange={e => setConfirmNewPassword(e.target.value)}
            required
          />
          <button type="submit" style={{ width: '100%', padding: 8 }} disabled={loading}>
            {loading ? 'パスワード更新中...' : 'パスワードを更新'}
          </button>
          {confirmationMessage && <p style={{ color: 'green', marginTop: '10px', fontWeight: 'bold' }}>{confirmationMessage}</p>}
          {error && <p style={{ color: 'red', marginTop: '10px' }}>{error}</p>}
        </form>
      ) : !isResettingPassword ? (
        <form onSubmit={isSignUp ? handleSignUp : handleLogin}>
          {isSignUp && (
            <input
              style={{ width: '100%', margin: '6px 0', padding: 8 }}
              placeholder='名前'
              value={name}
              onChange={e => setName(e.target.value)}
              required
            />
          )}
          <input
            style={{ width: '100%', margin: '6px 0', padding: 8 }}
            placeholder='メールアドレス'
            value={email}
            onChange={e => setEmail(e.target.value)}
            required
          />
          <input
            type='password'
            style={{ width: '100%', margin: '6px 0', padding: 8 }}
            placeholder='パスワード'
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
          />
          {isSignUp && (
            <input
              type='password'
              style={{ width: '100%', margin: '6px 0', padding: 8 }}
              placeholder='パスワード（確認用）'
              value={confirmPassword}
              onChange={e => setConfirmPassword(e.target.value)}
              required
            />
          )}
          <button type="submit" style={{ width: '100%', padding: 8 }} disabled={loading}>
            {loading ? (isSignUp ? '登録中...' : 'ログイン中...') : (isSignUp ? '新規登録' : 'ログイン')}
          </button>
          {confirmationMessage && <p style={{ color: 'green', marginTop: '10px', fontWeight: 'bold' }}>{confirmationMessage}</p>}
          {error && <p style={{ color: 'red', marginTop: '10px' }}>{error}</p>}
        </form>
      ) : (
        <form onSubmit={handlePasswordReset}>
          <p>パスワードをリセットするメールアドレスを入力してください。</p>
          <input
            style={{ width: '100%', margin: '6px 0', padding: 8 }}
            placeholder='メールアドレス'
            value={email}
            onChange={e => setEmail(e.target.value)}
            required
          />
          <button type="submit" style={{ width: '100%', padding: 8 }} disabled={loading}>
            {loading ? '送信中...' : 'パスワードをリセット'}
          </button>
          {error && <p style={{ color: 'red', marginTop: '10px' }}>{error}</p>}
        </form>
      )}
      {!isResettingPassword && (
        <button
          onClick={() => setIsSignUp(!isSignUp)}
          style={{ background: 'none', border: 'none', color: 'blue', cursor: 'pointer', marginTop: '10px' }}
        >
          {isSignUp ? 'ログイン画面に戻る' : '新規登録はこちら'}
        </button>
      )}
      {!isSignUp && !isResettingPassword && (
        <button
          onClick={() => setIsResettingPassword(true)}
          style={{ background: 'none', border: 'none', color: 'gray', cursor: 'pointer', marginTop: '10px' }}
        >
          パスワードを忘れた場合
        </button>
      )}
      {isResettingPassword && (
        <button
          onClick={() => setIsResettingPassword(false)}
          style={{ background: 'none', border: 'none', color: 'blue', cursor: 'pointer', marginTop: '10px' }}
        >
          ログイン画面に戻る
        </button>
      )}
    </div>
  );
}
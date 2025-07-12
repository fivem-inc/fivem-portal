import { useState, useContext } from 'react';
import { Navigate } from 'react-router-dom';
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
  const { user } = useContext(AuthContext); // AuthContextからuserを取得

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setError(error.message);
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

    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { name: name.trim() } // ここで名前を渡す
      }
    });

    if (error) {
      setError(error.message);
    } else if (data.user) {
      // ユーザー登録成功後、profilesテーブルに名前を挿入
      const { error: profileError } = await supabase
        .from('profiles')
        .insert({ id: data.user.id, name: name.trim() });

      if (profileError) {
        console.error('Error inserting profile:', profileError.message);
        setError('登録は完了しましたが、プロファイル情報の保存に失敗しました。');
      } else {
        alert('登録が完了しました。メールを確認してアカウントを有効にしてください。');
        setIsSignUp(false); // 登録後、ログインフォームに戻る
      }
    } else {
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

  // すでにログイン済みの場合は、ダッシュボードにリダイレクト
  if (user) {
    return <Navigate to="/" replace />;
  }

  return (
    <div style={{ maxWidth: 320, margin: '80px auto', textAlign: 'center' }}>
      <h2>ファイブM 交通費精算</h2>
      {!isResettingPassword ? (
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
import { useState, useContext, useEffect } from 'react';
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
  const [isSettingNewPassword, setIsSettingNewPassword] = useState(false); // 新しいパスワード設定モード
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [confirmationMessage, setConfirmationMessage] = useState<string | null>(null);
  const { user } = useContext(AuthContext); // AuthContextからuserを取得

  // 強制的なURL解析とデバッグ
  useEffect(() => {
    const currentUrl = window.location.href;
    const urlObj = new URL(currentUrl);
    
    // 完全なURL解析ログ
    console.log('=== URL解析開始 ===');
    console.log('完全URL:', currentUrl);
    console.log('pathname:', urlObj.pathname);
    console.log('search:', urlObj.search);
    console.log('hash:', urlObj.hash);
    
    // 全てのクエリパラメータ
    const searchParams = Object.fromEntries(urlObj.searchParams.entries());
    console.log('searchParams:', searchParams);
    
    // ハッシュパラメータ
    let hashParams = {};
    if (urlObj.hash) {
      hashParams = Object.fromEntries(new URLSearchParams(urlObj.hash.substring(1)).entries());
      console.log('hashParams:', hashParams);
    }
    
    // 複数の方法でtype=recoveryをチェック
    const checks = {
      urlIncludes: currentUrl.includes('type=recovery'),
      searchType: urlObj.searchParams.get('type') === 'recovery',
      hashType: hashParams.type === 'recovery',
      searchIncludes: urlObj.search.includes('type=recovery'),
      hashIncludes: urlObj.hash.includes('type=recovery')
    };
    console.log('recovery checks:', checks);
    
    const isPasswordReset = Object.values(checks).some(check => check === true);
    console.log('最終判定 isPasswordReset:', isPasswordReset);
    console.log('=== URL解析終了 ===');
    
    // パスワードリセットURLでない場合でも、強制的に表示するテスト
    if (currentUrl.includes('unwdmdgtzbhwflepabud.supabase.co')) {
      console.log('🚨 Supabase URLを検知 - 強制的にパスワード設定画面表示');
      alert('Supabase URLを検知しました。強制的にパスワード設定画面を表示します。');
      
      supabase.auth.signOut().then(() => {
        setIsSettingNewPassword(true);
        setIsSignUp(false);
        setIsResettingPassword(false);
        setConfirmationMessage('🔐 新しいパスワードを設定してください。');
      });
      
      // URLクリーンアップ
      window.history.replaceState({}, document.title, window.location.pathname);
      return;
    }
    
    if (isPasswordReset) {
      console.log('通常のパスワードリセット検知');
      supabase.auth.signOut().then(() => {
        setIsSettingNewPassword(true);
        setIsSignUp(false);
        setIsResettingPassword(false);
        setConfirmationMessage('🔐 新しいパスワードを設定してください。');
        
        // トークン保存処理
        const accessToken = searchParams.access_token || hashParams.access_token;
        const refreshToken = searchParams.refresh_token || hashParams.refresh_token;
        
        if (accessToken && refreshToken) {
          localStorage.setItem('resetTokens', JSON.stringify({ accessToken, refreshToken }));
          console.log('トークンを保存しました');
        }
      });
      
      window.history.replaceState({}, document.title, window.location.pathname);
    }

    // 認証イベント監視
    const { data: authListener } = supabase.auth.onAuthStateChange((event, session) => {
      console.log('認証イベント:', event, !!session);
      
      if (event === 'PASSWORD_RECOVERY' && session) {
        console.log('PASSWORD_RECOVERY イベント検知');
        setIsSettingNewPassword(true);
        setIsSignUp(false);
        setIsResettingPassword(false);
        setConfirmationMessage('🔐 新しいパスワードを設定してください。');
        
        localStorage.setItem('resetTokens', JSON.stringify({
          accessToken: session.access_token,
          refreshToken: session.refresh_token
        }));
      }
    });

    return () => {
      authListener.subscription.unsubscribe();
    };
  }, []);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    
    // シンプルなログイン処理
    
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

    try {
      // メールアドレスの形式を検証・修正
      const cleanEmail = email.replace(/＠/g, '@').trim();
      console.log('パスワードリセット email:', { original: email, clean: cleanEmail });
      
      // シンプルにパスワードリセットメールを送信
      const { error } = await supabase.auth.resetPasswordForEmail(cleanEmail, {
        redirectTo: 'https://five-m-expense.vercel.app/'
      });

      if (error) {
        let errorMessage = error.message;
        if (error.message.includes('Unable to validate email address: invalid format')) {
          errorMessage = 'メールアドレスの形式が正しくありません。半角の@を使用してください。';
        }
        setError(errorMessage);
      } else {
        alert('パスワードリセットのメールを送信しました。メールを確認して新しいパスワードを設定してください。');
        setIsResettingPassword(false);
      }
    } catch (error) {
      console.error('パスワードリセット処理エラー:', error);
      setError('パスワードリセット処理中にエラーが発生しました。');
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
      // 保存されたトークンでセッションを復元
      const resetTokensStr = localStorage.getItem('resetTokens');
      if (resetTokensStr) {
        try {
          const resetTokens = JSON.parse(resetTokensStr);
          console.log('保存されたトークンでセッション設定中...');
          
          const { error: sessionError } = await supabase.auth.setSession({
            access_token: resetTokens.accessToken,
            refresh_token: resetTokens.refreshToken
          });
          
          if (sessionError) {
            console.error('セッション設定エラー:', sessionError);
          } else {
            console.log('セッション設定成功');
          }
        } catch (parseError) {
          console.error('トークン解析エラー:', parseError);
        }
      }

      console.log('パスワード更新中...');
      const { error } = await supabase.auth.updateUser({
        password: newPassword
      });

      if (error) {
        console.error('パスワード更新エラー:', error);
        setError(`パスワードの更新に失敗しました: ${error.message}`);
      } else {
        console.log('パスワード更新成功');
        
        // 清掃処理
        localStorage.removeItem('resetTokens');
        await supabase.auth.signOut();
        
        setIsSettingNewPassword(false);
        setNewPassword('');
        setConfirmNewPassword('');
        setConfirmationMessage('✅ パスワードが更新されました！新しいパスワードでログインしてください。');
      }
    } catch (error) {
      console.error('パスワード設定エラー:', error);
      setError('パスワードの更新中にエラーが発生しました。');
    }
    setLoading(false);
  };

  // すでにログイン済みの場合は、ダッシュボードにリダイレクト
  // ただし、パスワード設定中の場合は除く
  if (user && !isSettingNewPassword) {
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
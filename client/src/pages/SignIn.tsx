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

  // 初期状態でパスワードリセットURLかチェック
  useEffect(() => {
    const currentUrl = window.location.href;
    if (currentUrl.includes('type=recovery')) {
      console.log('初期状態でパスワードリセットURL検知 - パスワード設定画面表示');
      setIsSettingNewPassword(true);
      setIsSignUp(false);
      setIsResettingPassword(false);
      setConfirmationMessage('🔐 新しいパスワードを設定してください。');
      localStorage.setItem('pendingPasswordReset', 'true');
    }
  }, []);

  // Supabase認証イベントを監視
  useEffect(() => {
    const { data: authListener } = supabase.auth.onAuthStateChange(async (event, session) => {
      console.log('認証イベント:', event, !!session);
      
      // PASSWORD_RECOVERYイベントを検知
      if (event === 'PASSWORD_RECOVERY' && session) {
        console.log('PASSWORD_RECOVERYイベント検知 - パスワード設定画面表示');
        setIsSettingNewPassword(true);
        setIsSignUp(false);
        setIsResettingPassword(false);
        setConfirmationMessage('🔐 新しいパスワードを設定してください。');
        localStorage.setItem('pendingPasswordReset', 'true');
        return;
      }
      
      // パスワードリセット中の自動ログインをブロック（ただし、レート制限を避ける）
      const pendingPasswordReset = localStorage.getItem('pendingPasswordReset');
      if (pendingPasswordReset && event === 'SIGNED_IN' && session && !isSettingNewPassword) {
        console.log('パスワードリセット中の自動ログインを検知');
        setIsSettingNewPassword(true);
        setIsSignUp(false);
        setIsResettingPassword(false);
        setConfirmationMessage('🔐 新しいパスワードを設定してください。');
        return;
      }
    });

    return () => {
      authListener.subscription.unsubscribe();
    };
  }, [isSettingNewPassword]);

  // メール確認・パスワードリセット完了の検知
  useEffect(() => {
    const handleAuthRedirect = async () => {
      // LocalStorageから回復フラグをチェック
      const pendingPasswordReset = localStorage.getItem('pendingPasswordReset');
      
      if (pendingPasswordReset) {
        console.log('LocalStorageからパスワードリセット検知');
        await supabase.auth.signOut();
        localStorage.removeItem('pendingPasswordReset');
        setIsSettingNewPassword(true);
        setIsSignUp(false);
        setIsResettingPassword(false);
        setConfirmationMessage('🔐 新しいパスワードを設定してください。');
        return;
      }
      
      // まず強制ログアウト（自動ログインを防ぐ）
      if (window.location.href.includes('type=recovery')) {
        await supabase.auth.signOut();
      }
      // URLから直接パラメータを取得
      const currentUrl = window.location.href;
      const urlObj = new URL(currentUrl);
      
      // クエリパラメータから取得
      const accessToken = urlObj.searchParams.get('access_token');
      const refreshToken = urlObj.searchParams.get('refresh_token');
      const type = urlObj.searchParams.get('type');
      
      // URLフラグメント（#）からも確認
      const urlHash = urlObj.hash;
      const hashParams = new URLSearchParams(urlHash.substring(1));
      const hashAccessToken = hashParams.get('access_token');
      const hashRefreshToken = hashParams.get('refresh_token');
      const hashType = hashParams.get('type');
      
      // デバッグ用ログ
      console.log('URL検知:', { 
        query: { accessToken: !!accessToken, refreshToken: !!refreshToken, type },
        hash: { accessToken: !!hashAccessToken, refreshToken: !!hashRefreshToken, type: hashType }
      });
      console.log('Current URL:', window.location.href);
      
      // hashとqueryの両方をチェック
      const finalAccessToken = accessToken || hashAccessToken;
      const finalRefreshToken = refreshToken || hashRefreshToken;
      const finalType = type || hashType;
      
      // type=recoveryを直接URLから検知
      const isRecovery = currentUrl.includes('type=recovery') || finalType === 'recovery';
      
      console.log('Recovery検知:', { isRecovery, finalType, urlContainsRecovery: currentUrl.includes('type=recovery') });
      
      if (isRecovery) {
        // パスワードリセット確認後は新しいパスワード設定画面を表示
        console.log('パスワードリセット検知 - 設定画面表示');
        setIsSettingNewPassword(true);
        setIsSignUp(false);
        setIsResettingPassword(false);
        setConfirmationMessage('🔐 新しいパスワードを設定してください。');
        
        // URLをクリーンアップ
        window.history.replaceState({}, document.title, window.location.pathname);
        return;
      }
      
      if (finalAccessToken && finalRefreshToken) {
        try {
          // 一旦ログアウトして、手動ログインを促す
          await supabase.auth.signOut();
          
          if (finalType === 'signup') {
            setConfirmationMessage('✅ メール確認が完了しました！ログイン情報を入力してログインしてください。');
            setIsSignUp(false); // ログインフォームに切り替え
          } else if (finalType === 'recovery') {
            // パスワードリセット確認後は新しいパスワード設定画面を表示
            console.log('パスワードリセット検知 - 設定画面表示');
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
    
    // パスワードリセット中のユーザーはログインをブロック
    const blockedEmail = localStorage.getItem('blockedUserEmail');
    if (blockedEmail === email) {
      setError('このアカウントはパスワードリセット中です。メールを確認して新しいパスワードを設定してください。');
      setLoading(false);
      return;
    }
    
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
      // ユーザーの現在のセッションを確認
      const { data: currentUser } = await supabase.auth.getUser();
      
      // パスワードリセットメールを送信
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: 'https://five-m-expense.vercel.app/'
      });

      if (error) {
        setError(error.message);
      } else {
        // フラグを設定してユーザーをブラックリスト化
        localStorage.setItem('pendingPasswordReset', 'true');
        localStorage.setItem('blockedUserEmail', email);
        
        // 現在ログインしている場合は強制ログアウト
        if (currentUser?.user) {
          await supabase.auth.signOut();
        }
        
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
      // URLパラメータからセッション情報を取得してセットアップ
      const currentUrl = window.location.href;
      const urlObj = new URL(currentUrl);
      
      let accessToken = urlObj.searchParams.get('access_token');
      let refreshToken = urlObj.searchParams.get('refresh_token');
      
      // URLフラグメントからも確認
      if (!accessToken || !refreshToken) {
        const hashParams = new URLSearchParams(urlObj.hash.substring(1));
        accessToken = hashParams.get('access_token');
        refreshToken = hashParams.get('refresh_token');
      }
      
      if (accessToken && refreshToken) {
        // セッションを設定
        console.log('セッション設定中...', { hasAccessToken: !!accessToken, hasRefreshToken: !!refreshToken });
        const { error: sessionError } = await supabase.auth.setSession({
          access_token: accessToken,
          refresh_token: refreshToken
        });
        
        if (sessionError) {
          console.error('セッション設定エラー:', sessionError);
          setError(`認証セッションの設定に失敗しました: ${sessionError.message}`);
          setLoading(false);
          return;
        }
        console.log('セッション設定成功');
      } else {
        console.log('トークンが見つかりません', { accessToken: !!accessToken, refreshToken: !!refreshToken });
        setError('認証トークンが見つかりません。メールリンクから再度アクセスしてください。');
        setLoading(false);
        return;
      }

      // パスワード更新
      console.log('パスワード更新中...');
      const { error } = await supabase.auth.updateUser({
        password: newPassword
      });

      if (error) {
        console.error('パスワード更新エラー:', error);
        setError(`パスワードの更新に失敗しました: ${error.message}`);
      } else {
        await supabase.auth.signOut(); // 一旦ログアウト
        setIsSettingNewPassword(false);
        setNewPassword('');
        setConfirmNewPassword('');
        
        // ブロックを解除
        localStorage.removeItem('pendingPasswordReset');
        localStorage.removeItem('blockedUserEmail');
        
        setConfirmationMessage('✅ パスワードが更新されました！新しいパスワードでログインしてください。');
      }
    } catch (error) {
      console.error('パスワード設定エラー:', error);
      setError('パスワードの更新中にエラーが発生しました。');
    }
    setLoading(false);
  };

  // すでにログイン済みの場合は、ダッシュボードにリダイレクト
  // ただし、パスワードリセット中の場合は除く
  const pendingPasswordReset = localStorage.getItem('pendingPasswordReset');
  if (user && !pendingPasswordReset && !isSettingNewPassword) {
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
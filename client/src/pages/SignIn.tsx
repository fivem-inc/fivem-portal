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

  // Supabase認証フローの処理
  useEffect(() => {
    // URLパラメータとハッシュの両方をチェック
    const currentUrl = window.location.href;
    const urlObj = new URL(currentUrl);
    
    console.log('=== 認証フロー解析 ===');
    console.log('完全URL:', currentUrl);
    console.log('search:', urlObj.search);
    console.log('hash:', urlObj.hash);
    
    // Supabase認証イベント監視（最優先）
    const { data: authListener } = supabase.auth.onAuthStateChange((event, session) => {
      console.log('🔥 認証イベント:', event, !!session);
      
      if (event === 'PASSWORD_RECOVERY' && session) {
        console.log('✅ PASSWORD_RECOVERY イベント検知 - セッション有効');
        
        // 即座にパスワード設定画面表示
        setIsSettingNewPassword(true);
        setIsSignUp(false);
        setIsResettingPassword(false);
        setConfirmationMessage('🔐 新しいパスワードを設定してください。');
        
        // セッション情報をlocalStorageに保存
        localStorage.setItem('resetTokens', JSON.stringify({
          accessToken: session.access_token,
          refreshToken: session.refresh_token
        }));
        
        console.log('✅ セッション情報を保存しました');
        return;
      }
      
      // トークンがハッシュに含まれている場合の処理
      if (event === 'SIGNED_IN' && session && currentUrl.includes('#')) {
        const hashParams = new URLSearchParams(urlObj.hash.substring(1));
        const type = hashParams.get('type');
        
        if (type === 'recovery') {
          console.log('✅ ハッシュからrecovery検知');
          
          setIsSettingNewPassword(true);
          setIsSignUp(false);
          setIsResettingPassword(false);
          setConfirmationMessage('🔐 新しいパスワードを設定してください。');
          
          localStorage.setItem('resetTokens', JSON.stringify({
            accessToken: session.access_token,
            refreshToken: session.refresh_token
          }));
          
          // URL クリーンアップ
          window.history.replaceState({}, document.title, window.location.pathname);
        }
      }
    });

    // 初期URLチェック（即座に実行）
    setTimeout(() => {
      const hashParams = new URLSearchParams(urlObj.hash.substring(1));
      const accessToken = hashParams.get('access_token');
      const type = hashParams.get('type');
      
      console.log('初期ハッシュチェック:', { 
        hasAccessToken: !!accessToken, 
        type, 
        hash: urlObj.hash 
      });
      
      if (accessToken && type === 'recovery') {
        console.log('✅ 初期状態でrecoveryトークン検知');
        
        setIsSettingNewPassword(true);
        setIsSignUp(false);
        setIsResettingPassword(false);
        setConfirmationMessage('🔐 新しいパスワードを設定してください。');
        
        // URLクリーンアップ
        window.history.replaceState({}, document.title, window.location.pathname);
      }
    }, 100);

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
      
      // パスワードリセットメールを送信（正しいリダイレクトURL）
      const { error } = await supabase.auth.resetPasswordForEmail(cleanEmail, {
        redirectTo: 'https://five-m-expense.vercel.app/signin'
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
      console.log('パスワード更新処理開始...');
      
      // 複数のアプローチでセッション確立を試行
      let sessionEstablished = false;
      
      // 1. 保存されたトークンを試行
      const resetTokensStr = localStorage.getItem('resetTokens');
      if (resetTokensStr) {
        try {
          const resetTokens = JSON.parse(resetTokensStr);
          console.log('保存されたトークンでセッション設定中...');
          
          const { error: sessionError } = await supabase.auth.setSession({
            access_token: resetTokens.accessToken,
            refresh_token: resetTokens.refreshToken
          });
          
          if (!sessionError) {
            console.log('保存されたトークンでセッション設定成功');
            sessionEstablished = true;
          } else {
            console.error('保存されたトークンでセッション設定失敗:', sessionError);
          }
        } catch (parseError) {
          console.error('トークン解析エラー:', parseError);
        }
      }
      
      // 2. 現在のセッションを確認
      if (!sessionEstablished) {
        const { data: session } = await supabase.auth.getSession();
        if (session.session) {
          console.log('既存のセッションを使用');
          sessionEstablished = true;
        }
      }
      
      console.log('セッション状態:', sessionEstablished ? '確立済み' : '未確立');

      // パスワード更新実行
      console.log('パスワード更新実行中...');
      const { error } = await supabase.auth.updateUser({
        password: newPassword
      });

      if (error) {
        console.error('パスワード更新エラー:', error);
        if (error.message.includes('session') || error.message.includes('Auth')) {
          setError('セッションが無効です。メールリンクから再度アクセスしてください。');
        } else {
          setError(`パスワードの更新に失敗しました: ${error.message}`);
        }
      } else {
        console.log('パスワード更新成功！');
        
        // 成功後の清掃処理
        localStorage.removeItem('resetTokens');
        await supabase.auth.signOut();
        
        setIsSettingNewPassword(false);
        setNewPassword('');
        setConfirmNewPassword('');
        setConfirmationMessage('✅ パスワードが更新されました！新しいパスワードでログインしてください。');
      }
    } catch (error) {
      console.error('パスワード設定エラー:', error);
      setError('パスワードの更新中にエラーが発生しました。再度お試しください。');
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
      {!isSignUp && !isResettingPassword && !isSettingNewPassword && (
        <button
          onClick={() => setIsResettingPassword(true)}
          style={{ background: 'none', border: 'none', color: 'gray', cursor: 'pointer', marginTop: '10px' }}
        >
          パスワードを忘れた場合
        </button>
      )}
      {!isSignUp && !isResettingPassword && !isSettingNewPassword && (
        <button
          onClick={() => {
            console.log('手動でパスワード設定画面に切り替え');
            setIsSettingNewPassword(true);
            setIsSignUp(false);
            setIsResettingPassword(false);
            setConfirmationMessage('🔐 メールリンクから来た場合は、ここで新しいパスワードを設定してください。');
          }}
          style={{ 
            background: '#ff6b6b', 
            color: 'white', 
            border: 'none', 
            padding: '8px 16px', 
            borderRadius: '4px',
            cursor: 'pointer', 
            marginTop: '15px',
            fontSize: '14px',
            fontWeight: 'bold'
          }}
        >
          パスワード設定画面へ（メールリンク用）
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
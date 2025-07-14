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

  // Supabase認証フロー処理（パスワードリセット対応）
  useEffect(() => {
    console.log('=== 認証フロー初期化 ===');
    
    // 認証イベント監視（最重要）
    const { data: authListener } = supabase.auth.onAuthStateChange(async (event, session) => {
      console.log('🔥 認証イベント:', event, '| セッション:', !!session);
      
      // PASSWORD_RECOVERYイベントを最優先で処理
      if (event === 'PASSWORD_RECOVERY') {
        console.log('✅ PASSWORD_RECOVERY イベント検知 - パスワード設定画面に切り替え');
        
        // 即座にパスワード設定モードに切り替え
        setIsSettingNewPassword(true);
        setIsSignUp(false);
        setIsResettingPassword(false);
        setConfirmationMessage('🔐 新しいパスワードを設定してください。');
        
        // セッション情報があれば保存
        if (session) {
          localStorage.setItem('resetSession', JSON.stringify({
            accessToken: session.access_token,
            refreshToken: session.refresh_token
          }));
          console.log('✅ リセットセッション保存');
        }
        
        return; // 他の処理をスキップ
      }
      
      // SIGNED_INイベントでrecoveryタイプかチェック
      if (event === 'SIGNED_IN' && session) {
        const currentUrl = window.location.href;
        const awaitingReset = localStorage.getItem('awaitingPasswordReset');
        
        // URLにtype=recoveryが含まれているか、リセット待機中かチェック
        if (currentUrl.includes('type=recovery') || currentUrl.includes('#access_token') || awaitingReset === 'true') {
          console.log('✅ SIGNED_IN + recovery検知 - パスワード設定画面に切り替え');
          console.log('検知理由:', { 
            hasRecoveryUrl: currentUrl.includes('type=recovery'),
            hasAccessToken: currentUrl.includes('#access_token'),
            awaitingReset: awaitingReset === 'true'
          });
          
          setIsSettingNewPassword(true);
          setIsSignUp(false);
          setIsResettingPassword(false);
          setConfirmationMessage('🔐 新しいパスワードを設定してください。');
          
          localStorage.setItem('resetSession', JSON.stringify({
            accessToken: session.access_token,
            refreshToken: session.refresh_token
          }));
          
          // フラグをクリア
          localStorage.removeItem('awaitingPasswordReset');
          
          // URLクリーンアップ
          window.history.replaceState({}, document.title, window.location.pathname);
          return;
        }
      }
    });

    // 初期URL確認（ページロード時）
    const checkInitialUrl = () => {
      const currentUrl = window.location.href;
      const urlObj = new URL(currentUrl);
      
      console.log('初期URL確認:', {
        url: currentUrl,
        hash: urlObj.hash,
        search: urlObj.search,
        hasRecovery: currentUrl.includes('type=recovery'),
        hasResetParam: urlObj.searchParams.get('reset')
      });
      
      // URLクエリパラメータからreset=trueをチェック
      if (urlObj.searchParams.get('reset') === 'true') {
        console.log('✅ リセットパラメータ検知 - パスワード設定準備');
        // この時点ではまだセッションがないので、flagを立てておく
        localStorage.setItem('awaitingPasswordReset', 'true');
      }
      
      // URLハッシュからrecoveryパラメータを検出
      if (urlObj.hash) {
        const hashParams = new URLSearchParams(urlObj.hash.substring(1));
        const accessToken = hashParams.get('access_token');
        const type = hashParams.get('type');
        
        console.log('ハッシュ詳細:', { accessToken: !!accessToken, type, fullHash: urlObj.hash });
        
        if (accessToken && type === 'recovery') {
          console.log('✅ 初期状態でrecoveryトークン検知 - パスワード設定画面表示');
          
          setIsSettingNewPassword(true);
          setIsSignUp(false);
          setIsResettingPassword(false);
          setConfirmationMessage('🔐 メールからアクセスしました。新しいパスワードを設定してください。');
          
          // フラグをクリア
          localStorage.removeItem('awaitingPasswordReset');
          
          // URLクリーンアップ
          window.history.replaceState({}, document.title, window.location.pathname);
        }
      }
    };
    
    // 初期チェック実行
    checkInitialUrl();

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
      
      // 強制的にログアウト
      await supabase.auth.signOut();
      
      // パスワードリセットメールを送信
      const { error: resetError } = await supabase.auth.resetPasswordForEmail(cleanEmail, {
        redirectTo: `${window.location.origin}/signin?reset=true`
      });

      if (resetError) {
        let errorMessage = resetError.message;
        if (resetError.message.includes('Unable to validate email address: invalid format')) {
          errorMessage = 'メールアドレスの形式が正しくありません。半角の@を使用してください。';
        } else if (resetError.message.includes('For security purposes')) {
          errorMessage = 'セキュリティのため、しばらく時間をおいてから再度お試しください。';
        } else if (resetError.message.includes('User not found')) {
          errorMessage = 'このメールアドレスは登録されていません。';
        }
        setError(errorMessage);
      } else {
        alert('パスワードリセットメールを送信しました。メールを確認して新しいパスワードを設定してください。');
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
      console.log('=== パスワード更新処理開始 ===');
      
      // Step 1: セッション確立を確認・試行
      let currentSession = null;
      
      // 現在のセッションを取得
      const { data: sessionData } = await supabase.auth.getSession();
      currentSession = sessionData.session;
      
      if (!currentSession) {
        // セッションがない場合は保存されたセッションを復元
        const resetSessionStr = localStorage.getItem('resetSession');
        if (resetSessionStr) {
          try {
            const resetSession = JSON.parse(resetSessionStr);
            console.log('保存されたリセットセッションを復元中...');
            
            const { error: setSessionError } = await supabase.auth.setSession({
              access_token: resetSession.accessToken,
              refresh_token: resetSession.refreshToken
            });
            
            if (!setSessionError) {
              console.log('✅ セッション復元成功');
              const { data: newSessionData } = await supabase.auth.getSession();
              currentSession = newSessionData.session;
            } else {
              console.error('セッション復元エラー:', setSessionError);
            }
          } catch (parseError) {
            console.error('セッションデータ解析エラー:', parseError);
          }
        }
      }
      
      if (!currentSession) {
        setError('認証セッションが見つかりません。メールリンクから再度アクセスしてください。');
        setLoading(false);
        return;
      }
      
      console.log('✅ セッション確認完了 - パスワード更新実行');

      // Step 2: パスワード更新実行
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
        
        // Step 3: 成功後の処理
        localStorage.removeItem('resetSession');
        localStorage.removeItem('resetTokens');
        
        alert('✅ パスワードが更新されました！新しいパスワードでログインしてください。');
        
        // ログアウトして初期状態に戻す
        await supabase.auth.signOut();
        
        setIsSettingNewPassword(false);
        setNewPassword('');
        setConfirmNewPassword('');
        setIsSignUp(false);
        setIsResettingPassword(false);
        setConfirmationMessage(null);
      }
    } catch (error) {
      console.error('❌ パスワード設定処理エラー:', error);
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
          <p>パスワードリセットメールを送信します。メールアドレスを入力してください。</p>
          <input
            style={{ width: '100%', margin: '6px 0', padding: 8 }}
            placeholder='メールアドレス'
            value={email}
            onChange={e => setEmail(e.target.value)}
            required
          />
          <button type="submit" style={{ width: '100%', padding: 8 }} disabled={loading}>
            {loading ? '送信中...' : 'パスワードリセットメールを送信'}
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
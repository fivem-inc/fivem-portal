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
  const [showPassword, setShowPassword] = useState(false); // パスワード表示切り替え
  const [showConfirmPassword, setShowConfirmPassword] = useState(false); // 確認用パスワード表示切り替え
  const { user } = useContext(AuthContext); // AuthContextからuserを取得

  // 認証フロー処理（簡素化 - パスワードリセットは専用ページで処理）
  useEffect(() => {
    console.log('=== SignIn 認証フロー初期化 ===');
    
    // 基本的な認証イベント監視
    const { data: authListener } = supabase.auth.onAuthStateChange((event, session) => {
      console.log('🔥 SignIn 認証イベント:', event, '| セッション:', !!session);
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
    
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      let errorMessage = error.message;
      if (error.message.includes('Invalid login credentials')) {
        errorMessage = 'メールアドレスまたはパスワードが正しくありません。';
      } else if (error.message.includes('Email not confirmed')) {
        errorMessage = 'メールアドレスが確認されていません。メールを確認してください。';
      }
      setError(errorMessage);
    } else if (data.user) {
      // 退職者チェック
      const { data: profile } = await supabase
        .from('profiles')
        .select('is_active')
        .eq('id', data.user.id)
        .single();
      if (profile && profile.is_active === false) {
        await supabase.auth.signOut();
        setError('このアカウントは無効です。管理者にお問い合わせください。');
      }
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
        redirectTo: `${window.location.origin}/reset-password`
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
              style={{ width: '100%', margin: '6px 0', padding: 8, boxSizing: 'border-box' }}
              placeholder='名前'
              value={name}
              onChange={e => setName(e.target.value)}
              required
            />
          )}
          <input
            style={{ width: '100%', margin: '6px 0', padding: 8, boxSizing: 'border-box' }}
            placeholder='メールアドレス'
            value={email}
            onChange={e => setEmail(e.target.value)}
            required
          />
          <div style={{ position: 'relative', margin: '6px 0' }}>
            <input
              type={showPassword ? 'text' : 'password'}
              style={{ width: '100%', padding: 8, paddingRight: '35px', boxSizing: 'border-box' }}
              placeholder='パスワード'
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              style={{
                position: 'absolute',
                right: '10px',
                top: '50%',
                transform: 'translateY(-50%)',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                fontSize: '16px',
                color: '#666',
                padding: 0,
                lineHeight: 1
              }}
            >
              {showPassword ? '●' : '○'}
            </button>
          </div>
          {isSignUp && (
            <div style={{ position: 'relative', margin: '6px 0' }}>
              <input
                type={showConfirmPassword ? 'text' : 'password'}
                style={{ width: '100%', padding: 8, paddingRight: '35px', boxSizing: 'border-box' }}
                placeholder='パスワード（確認用）'
                value={confirmPassword}
                onChange={e => setConfirmPassword(e.target.value)}
                required
              />
              <button
                type="button"
                onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                style={{
                  position: 'absolute',
                  right: '10px',
                  top: '50%',
                  transform: 'translateY(-50%)',
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: '16px',
                  color: '#666',
                  padding: 0,
                  lineHeight: 1
                }}
              >
                {showConfirmPassword ? '●' : '○'}
              </button>
            </div>
          )}
          <button 
            type="submit" 
            style={{ 
              width: '100%', 
              padding: 8,
              background: '#28a745',
              color: 'white',
              border: '1px solid #28a745',
              borderRadius: '4px',
              cursor: 'pointer'
            }} 
            disabled={loading}
          >
            {loading ? (isSignUp ? '登録中...' : 'ログイン中...') : (isSignUp ? '新規登録' : 'ログイン')}
          </button>
          {error && <p style={{ color: 'red', marginTop: '10px' }}>{error}</p>}
        </form>
      ) : (
        <form onSubmit={handlePasswordReset}>
          <p>パスワードリセットメールを送信します。登録しているメールアドレスを入力してください。</p>
          <input
            style={{ width: '100%', margin: '6px 0', padding: 8, boxSizing: 'border-box' }}
            placeholder='メールアドレス'
            value={email}
            onChange={e => setEmail(e.target.value)}
            required
          />
          <button 
            type="submit" 
            style={{ 
              width: '100%', 
              padding: 8,
              background: '#ffc107',
              color: '#212529',
              border: '1px solid #ffc107',
              borderRadius: '4px',
              cursor: 'pointer'
            }} 
            disabled={loading}
          >
            {loading ? '送信中...' : 'パスワードリセットメールを送信'}
          </button>
          {error && <p style={{ color: 'red', marginTop: '10px' }}>{error}</p>}
        </form>
      )}
      {!isResettingPassword && (
        <button
          onClick={() => setIsSignUp(!isSignUp)}
          style={{ 
            background: '#007bff', 
            border: '1px solid #007bff', 
            color: 'white', 
            cursor: 'pointer', 
            marginTop: '10px',
            padding: '8px 16px',
            borderRadius: '4px'
          }}
        >
          {isSignUp ? 'ログイン画面に戻る' : '新規登録はこちら'}
        </button>
      )}
      {!isSignUp && !isResettingPassword && (
        <button
          onClick={() => setIsResettingPassword(true)}
          style={{ 
            background: '#17a2b8', 
            border: '1px solid #17a2b8', 
            color: 'white', 
            cursor: 'pointer', 
            marginTop: '10px',
            padding: '8px 16px',
            borderRadius: '4px'
          }}
        >
          パスワードを忘れた場合
        </button>
      )}
      {isResettingPassword && (
        <button
          onClick={() => setIsResettingPassword(false)}
          style={{ 
            background: '#007bff', 
            border: '1px solid #007bff', 
            color: 'white', 
            cursor: 'pointer', 
            marginTop: '10px',
            padding: '8px 16px',
            borderRadius: '4px'
          }}
        >
          ログイン画面に戻る
        </button>
      )}
    </div>
  );
}
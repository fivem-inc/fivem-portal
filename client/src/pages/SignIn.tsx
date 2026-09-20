import { useState, useContext, useEffect } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient';
import { AuthContext } from '../contexts/AuthContext.tsx';
import { useAuth } from '../hooks/useAuth';
import {
  defaultIdleSetting, formatMinutes, idleCheckboxVisible, isPointerDevice, readCachedIdleConfig,
  readIdleLogoutSetting, writeIdleLogoutSetting, type IdleLogoutSetting,
} from '../lib/idleLogout';

export default function SignIn() {
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [name, setName] = useState(''); // 新規追加: 名前
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null); // 成功・案内メッセージ（alert廃止・緑表示）
  const [isSignUp, setIsSignUp] = useState(false); // 新規登録モードかどうかの状態
  const [isResettingPassword, setIsResettingPassword] = useState(false); // パスワードリセットモードかどうかの状態
  const [showPassword, setShowPassword] = useState(false); // パスワード表示切り替え
  const [showConfirmPassword, setShowConfirmPassword] = useState(false); // 確認用パスワード表示切り替え
  const { user, blockedMessage, clearBlockedMessage } = useContext(AuthContext);
  const { isAdmin } = useAuth();

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

  // is_active=false（退職済み・承認待ち）の判定はAuthContext側で一元的に行われる。
  // ここではそのブロック理由（メッセージ）を受け取って表示するだけにする。
  useEffect(() => {
    if (blockedMessage) {
      setError(blockedMessage);
      setLoading(false);
      clearBlockedMessage();
    }
  }, [blockedMessage, clearBlockedMessage]);

  // 共有パソコン用の自動ログアウト（2026-09-14）。決めたことは lib/idleLogout.ts の冒頭を見ること。
  // 🚨 ログイン前は app_settings を読めない（RLS が authenticated だけ）ので、管理者の設定は
  //    **ログイン中に写した値**を使う。写しが無い端末（その端末で初めてのログイン）は既定値（1分・パソコンだけ）
  const isPc = isPointerDevice();
  const idleCfg = readCachedIdleConfig();
  // パソコン（マウスのある端末）には常に出す。スマホ・タブレットは管理者が「出す」にしたときだけ
  const showIdleCheck = idleCheckboxVisible(idleCfg);
  // 初期値：パソコンは ON・スマホは OFF（この端末に記憶があればそれ）。外すには二段階の確認（ユーザー確定）
  const [idleLogout, setIdleLogout] = useState<IdleLogoutSetting>(() => readIdleLogoutSetting() ?? defaultIdleSetting());
  const [confirmIdleOff, setConfirmIdleOff] = useState(false);
  // 自動ログアウトで戻ってきたときの案内（handleLogout が ?reason=idle を付ける）
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (new URLSearchParams(location.search).get('reason') === 'idle') {
      setNotice(`${formatMinutes(idleCfg.minutes)}のあいだ操作がなかったため、自動的にログアウトしました。`);
    }
  }, [location.search, idleCfg.minutes]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    // 🚨 自動ログアウトのチェックは**ログインしたときに端末へ記憶**する（チェックを出していない端末では触らない）。
    //    記憶が無い端末では動かないので、いまログイン中の端末には次のログインまで効かない
    if (showIdleCheck) writeIdleLogoutSetting(idleLogout);

    // シンプルなログイン処理（is_active判定はAuthContextが行う）
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      let errorMessage = error.message;
      if (error.message.includes('Invalid login credentials')) {
        errorMessage = 'メールアドレスまたはパスワードが正しくありません。';
      } else if (error.message.includes('Email not confirmed')) {
        errorMessage = 'メールアドレスが確認されていません。メールを確認してください。';
      } else if (/banned|user_banned/i.test(error.message)) {
        // 退職して申請期間が終わった方（毎晩の処理でログインを止めている）。
        // 🚨 ふつうの「ログインできません」だと、ご本人は入力ミスだと思って何度も試し、最後に電話が来る。
        //    理由を書いて、連絡先の案内につなげる（2026-09-20・3段目）
        errorMessage = 'ご利用の期間が終了しました。申請の内容についてのご確認は、会社の担当者までご連絡ください。';
      }
      setError(errorMessage);
      setLoading(false);
    }
    // 成功時のloading解除はAuthContextのapplySessionUser完了後（blockedMessage or 通常ログイン）に任せる
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
        data: {
          name: name.trim(),
          display_name: name.trim(),
          full_name: name.trim()
        }
      }
    });

    if (!error && data.user) {
      // 承認待ちの新規登録を管理画面で確認する際の参考情報として、接続元IP・国を記録する。
      // 🚨 記録できなくても登録自体は続ける（あくまで参考情報）が、失敗を完全に握りつぶすと
      //    「ずっと記録されていない」ことに誰も気づけない。ログには必ず残す
      //    （実際、CORSが本番URLのみ許可でローカルからの登録が記録されていなかった）
      supabase.functions.invoke('record-signup-ip', { body: { user_id: data.user.id } })
        .then(
          ({ error: ipError }) => { if (ipError) console.error('[signup] IPの記録に失敗:', ipError); },
          (e) => console.error('[signup] IPの記録に失敗:', e),
        );
    }

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
      setError(null);
      setInfo('登録が完了しました。メールを確認してアカウントを有効にしてください。');
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
        setError(null);
        setInfo('パスワードリセットメールを送信しました。メールを確認して新しいパスワードを設定してください。');
        setIsResettingPassword(false);
      }
    } catch (error) {
      console.error('パスワードリセット処理エラー:', error);
      setError('パスワードリセット処理中にエラーが発生しました。');
    }
    
    setLoading(false);
  };

  if (user) {
    // ログイン前に開こうとしていた URL（ProtectedLayout が state.from に入れる）があればそこへ戻す。
    // 🚨 同じサイトの中のパス（/ で始まり // で始まらない）だけを許す。外部URLへは飛ばさない
    const from = (location.state as { from?: string } | null)?.from;
    const safeFrom = typeof from === 'string' && from.startsWith('/') && !from.startsWith('//') && from !== '/signin' ? from : null;
    return <Navigate to={safeFrom ?? (isAdmin ? '/admin' : '/')} replace />;
  }

  return (
    <div style={{ maxWidth: 320, margin: '80px auto', textAlign: 'center' }}>
      <h2>ファイブM スタッフサイト</h2>
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
          {!isSignUp && showIdleCheck && (
            <div style={{ textAlign: 'left', margin: '10px 0 4px', fontSize: 13 }}>
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={idleLogout === 'on'}
                  style={{ marginTop: 3 }}
                  onChange={e => {
                    if (e.target.checked) { setIdleLogout('on'); setConfirmIdleOff(false); }
                    else setConfirmIdleOff(true); // 🚨 すぐには外さない。二段階の確認を挟む（ユーザー確定）
                  }}
                />
                <span>
                  {isPc ? 'このパソコンは共有です' : 'この端末は共有です'}
                  <br />
                  <span style={{ color: '#666', fontSize: 12 }}>
                    {idleLogout === 'on'
                      ? `${formatMinutes(idleCfg.minutes)}のあいだ操作がないと自動でログアウトします（書きかけの下書きも消えます）`
                      : '自動ログアウトなし（この端末は他の人が触らない設定です）'}
                  </span>
                </span>
              </label>
              {confirmIdleOff && idleLogout === 'on' && (
                <div style={{ marginTop: 8, padding: '10px 12px', background: '#fff3cd', border: '2px solid #ffc107', borderRadius: 8, color: '#856404' }}>
                  <div style={{ fontWeight: 'bold', marginBottom: 6 }}>自動ログアウトを外しますか？</div>
                  <div style={{ fontSize: 12.5, marginBottom: 8, lineHeight: 1.5 }}>
                    外すと、席を離れている間に他の人が画面を見られます。個人用の端末など、他の人が触らないときだけにしてください。この設定はこの端末に記憶されます。
                  </div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <button
                      type="button"
                      onClick={() => { setIdleLogout('off'); setConfirmIdleOff(false); }}
                      style={{ background: '#1976d2', color: '#fff', border: '2px solid #1565c0', borderRadius: 6, padding: '6px 14px', fontWeight: 'bold', cursor: 'pointer' }}
                    >
                      外す
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmIdleOff(false)}
                      style={{ background: 'none', border: 'none', textDecoration: 'underline', color: '#856404', cursor: 'pointer', padding: '6px 8px' }}
                    >
                      やめる
                    </button>
                  </div>
                </div>
              )}
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
          {info && <p style={{ color: '#1e7e34', marginTop: '10px' }}>{info}</p>}
          {notice && (
            <p style={{ marginTop: 10, padding: '8px 10px', background: '#fff3cd', border: '2px solid #ffc107', borderRadius: 8, color: '#856404', fontSize: 13, textAlign: 'left' }}>
              {notice}
            </p>
          )}
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
          {info && <p style={{ color: '#1e7e34', marginTop: '10px' }}>{info}</p>}
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
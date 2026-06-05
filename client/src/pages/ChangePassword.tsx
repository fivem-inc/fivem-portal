import { useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { useNavigate } from 'react-router-dom';

export default function ChangePassword() {
  const navigate = useNavigate();
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (newPassword.length < 6) {
      setError('パスワードは6文字以上で入力してください。');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('パスワードが一致しません。');
      return;
    }

    setLoading(true);
    const { error: updateError } = await supabase.auth.updateUser({ password: newPassword });
    setLoading(false);

    if (updateError) {
      setError('パスワードの変更に失敗しました: ' + updateError.message);
    } else {
      setSuccess(true);
    }
  };

  if (success) {
    return (
      <div style={{ maxWidth: 400, margin: '80px auto', textAlign: 'center', padding: '0 16px' }}>
        <h2>✅ パスワード変更完了</h2>
        <p style={{ color: '#28a745', marginTop: 16, lineHeight: 1.6 }}>
          パスワードが正常に変更されました。
        </p>
        <button
          onClick={() => navigate('/')}
          style={{ marginTop: 24, padding: '10px 24px', background: '#007bff', color: 'white', border: 'none', borderRadius: 6, fontSize: 15, cursor: 'pointer' }}
        >
          ファイブＭスタッフサイトに戻る
        </button>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 400, margin: '80px auto', padding: '0 16px' }}>
      <h2 style={{ textAlign: 'center', marginBottom: 24 }}>パスワード変更</h2>

      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <input
          type="password"
          placeholder="新しいパスワード（6文字以上）"
          value={newPassword}
          onChange={e => setNewPassword(e.target.value)}
          required
          style={{ padding: 12, fontSize: 15, border: '1px solid #ccc', borderRadius: 6 }}
        />
        <input
          type="password"
          placeholder="新しいパスワード（確認用）"
          value={confirmPassword}
          onChange={e => setConfirmPassword(e.target.value)}
          required
          style={{ padding: 12, fontSize: 15, border: '1px solid #ccc', borderRadius: 6 }}
        />

        {error && <p style={{ color: '#dc3545', margin: 0, fontSize: 13 }}>{error}</p>}

        <button
          type="submit"
          disabled={loading}
          style={{ padding: 12, background: '#007bff', color: 'white', border: 'none', borderRadius: 6, fontSize: 15, cursor: 'pointer', opacity: loading ? 0.7 : 1 }}
        >
          {loading ? '変更中...' : 'パスワードを変更'}
        </button>
      </form>

      <div style={{ marginTop: 20, textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <button onClick={() => navigate('/change-email')} style={{ background: 'none', border: 'none', color: '#007bff', cursor: 'pointer', textDecoration: 'underline', fontSize: 13 }}>
          メールアドレス変更はこちら
        </button>
        <button onClick={() => navigate('/')} style={{ background: 'none', border: 'none', color: '#888', cursor: 'pointer', textDecoration: 'underline', fontSize: 13 }}>
          ファイブＭスタッフサイトに戻る
        </button>
      </div>
    </div>
  );
}

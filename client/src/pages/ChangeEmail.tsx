import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabaseClient';
import { useAuth } from '../hooks/useAuth';

export default function ChangeEmail() {
  const { user } = useAuth();
  const [newEmail, setNewEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    if (!user) {
      window.location.href = '/signin';
    }
  }, [user]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    // バリデーション
    if (!newEmail.trim()) {
      setError('新しいメールアドレスを入力してください。');
      setLoading(false);
      return;
    }

    // メールアドレス形式のバリデーション
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(newEmail)) {
      setError('有効なメールアドレスを入力してください。');
      setLoading(false);
      return;
    }

    // 現在のメールアドレスと同じかチェック
    if (user && newEmail === user.email) {
      setError('現在のメールアドレスと同じです。');
      setLoading(false);
      return;
    }

    try {
      console.log('=== メールアドレス変更実行 ===');
      
      // メールアドレス更新
      const { error: updateError } = await supabase.auth.updateUser({
        email: newEmail
      });

      if (updateError) {
        console.error('❌ メールアドレス変更エラー:', updateError);
        
        let errorMessage = updateError.message;
        if (updateError.message.includes('email')) {
          errorMessage = 'このメールアドレスは既に使用されています。';
        }
        setError(errorMessage);
      } else {
        console.log('✅ メールアドレス変更確認メール送信成功！');
        setSuccess(true);
      }
    } catch (error) {
      console.error('❌ メールアドレス変更処理エラー:', error);
      setError('メールアドレス変更中にエラーが発生しました。再度お試しください。');
    }
    
    setLoading(false);
  };

  if (!user) {
    return <div>認証を確認中...</div>;
  }

  if (success) {
    return (
      <div style={{ maxWidth: 400, margin: '80px auto', textAlign: 'center' }}>
        <h2>✅ 確認メール送信完了</h2>
        <p style={{ color: 'green', marginTop: '20px', lineHeight: 1.6 }}>
          新しいメールアドレス（{newEmail}）に確認メールを送信しました。<br />
          メール内のリンクをクリックして変更を完了してください。
        </p>
        <div style={{ marginTop: '30px' }}>
          <button 
            onClick={() => window.location.href = '/'}
            style={{ padding: '10px 20px', marginRight: '10px' }}
          >
            ダッシュボードに戻る
          </button>
          <button 
            onClick={() => {
              setSuccess(false);
              setNewEmail('');
            }}
            style={{ 
              padding: '10px 20px',
              background: 'none',
              border: '1px solid #ccc',
              cursor: 'pointer'
            }}
          >
            別のメールアドレスで再送信
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 400, margin: '80px auto', textAlign: 'center' }}>
      <h2>メールアドレス変更</h2>
      <div style={{ marginBottom: '20px', padding: '15px', backgroundColor: '#f5f5f5', borderRadius: '5px' }}>
        <p style={{ margin: 0, color: '#666' }}>
          現在のメールアドレス: <strong>{user.email}</strong>
        </p>
      </div>
      
      <form onSubmit={handleSubmit}>
        <input
          type='email'
          style={{ 
            width: '100%', 
            margin: '10px 0', 
            padding: '12px',
            border: '1px solid #ccc',
            borderRadius: '4px',
            fontSize: '16px'
          }}
          placeholder='新しいメールアドレス'
          value={newEmail}
          onChange={e => setNewEmail(e.target.value)}
          required
        />
        <button 
          type="submit" 
          style={{ 
            width: '100%', 
            padding: '12px', 
            marginTop: '15px',
            backgroundColor: '#007bff',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            fontSize: '16px',
            cursor: 'pointer'
          }} 
          disabled={loading}
        >
          {loading ? 'メール送信中...' : '変更メールを送信'}
        </button>
        
        {error && <p style={{ color: 'red', marginTop: '15px' }}>{error}</p>}
      </form>
      
      <div style={{ marginTop: '20px' }}>
        <button
          onClick={() => window.location.href = '/'}
          style={{ 
            background: 'none', 
            border: 'none', 
            color: 'blue', 
            cursor: 'pointer',
            textDecoration: 'underline'
          }}
        >
          ダッシュボードに戻る
        </button>
      </div>
    </div>
  );
}
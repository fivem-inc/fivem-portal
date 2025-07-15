import { useState } from 'react';
import { supabase } from '../lib/supabaseClient';

export default function SupabaseSettingsCheck() {
  const [testResult, setTestResult] = useState<string>('');
  const [loading, setLoading] = useState(false);

  const testEmailChange = async () => {
    setLoading(true);
    setTestResult('');

    try {
      // 現在のユーザー取得
      const { data: { user } } = await supabase.auth.getUser();
      
      if (!user) {
        setTestResult('❌ ログインが必要です');
        setLoading(false);
        return;
      }

      console.log('現在のユーザー:', user.email);
      
      // テスト用の同じメールアドレスで更新を試行
      const { error } = await supabase.auth.updateUser({
        email: user.email // 同じメールアドレス
      });

      if (error) {
        setTestResult(`📋 現在の設定確認結果:\n\nエラー: ${error.message}\n\n現在のメール: ${user.email}`);
      } else {
        setTestResult(`📋 現在の設定確認結果:\n\n✅ updateUser成功\n現在のメール: ${user.email}\n\n⚠️ 実際のメール変更をテストするには、\n異なるメールアドレスを使用してください。`);
      }
    } catch (error) {
      setTestResult(`❌ テスト実行エラー: ${error}`);
    }
    
    setLoading(false);
  };

  return (
    <div style={{ maxWidth: 500, margin: '80px auto', textAlign: 'center' }}>
      <h2>🔍 Supabase設定確認ツール</h2>
      
      <div style={{ marginBottom: '20px', padding: '15px', backgroundColor: '#f0f8ff', borderRadius: '5px', textAlign: 'left' }}>
        <h3>📋 確認項目</h3>
        <p>1. Secure email change: オン/オフ</p>
        <p>2. OTP有効期限設定</p>
        <p>3. 現在のユーザー情報</p>
      </div>

      <button 
        onClick={testEmailChange}
        disabled={loading}
        style={{ 
          padding: '15px 30px', 
          fontSize: '16px',
          backgroundColor: '#007bff',
          color: 'white',
          border: 'none',
          borderRadius: '5px',
          cursor: loading ? 'not-allowed' : 'pointer'
        }}
      >
        {loading ? '確認中...' : '📊 現在の設定を確認'}
      </button>

      {testResult && (
        <div style={{ 
          marginTop: '20px', 
          padding: '15px', 
          backgroundColor: '#f8f9fa', 
          borderRadius: '5px',
          textAlign: 'left',
          whiteSpace: 'pre-line'
        }}>
          {testResult}
        </div>
      )}

      <div style={{ marginTop: '30px' }}>
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
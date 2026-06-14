import { useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { useDarkMode } from '../hooks/useDarkMode';
import { requestPushPermission, unsubscribePush, getPushPermissionStatus } from '../utils/pushNotification';

export default function NotificationSettings() {
  const navigate = useNavigate();
  const isDark = useDarkMode();

  const bg   = isDark ? '#1e1e2e' : '#f8f9fa';
  const card = isDark ? '#2c2c3e' : '#ffffff';
  const text = isDark ? '#fff' : '#1a1a2e';
  const sub  = isDark ? '#adb5bd' : '#6c757d';
  const border = isDark ? '#3d3d55' : '#e9ecef';

  const [pushStatus, setPushStatus] = useState<'granted' | 'denied' | 'default' | 'unsupported'>('default');
  const [pushLoading, setPushLoading] = useState(false);

  useEffect(() => {
    getPushPermissionStatus().then((s) => setPushStatus(s as typeof pushStatus));
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        getPushPermissionStatus().then((s) => setPushStatus(s as typeof pushStatus));
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  const handlePushToggle = async () => {
    setPushLoading(true);
    if (pushStatus === 'granted') {
      await unsubscribePush();
      setPushStatus('default');
    } else {
      const result = await requestPushPermission();
      setPushStatus(result === 'granted' ? 'granted' : 'denied');
    }
    setPushLoading(false);
  };

  return (
    <div style={{ minHeight: '100vh', background: bg, padding: '24px 16px' }}>
      <div style={{ maxWidth: 400, margin: '0 auto' }}>
        <h2 style={{ fontSize: 18, fontWeight: 700, color: text, marginBottom: 20 }}>🔔 通知設定</h2>

        {pushStatus === 'unsupported' ? (
          <div style={{ background: card, borderRadius: 16, padding: '20px', color: sub, fontSize: 14 }}>
            このブラウザはプッシュ通知に対応していません
          </div>
        ) : (
          <div style={{ background: card, borderRadius: 16, overflow: 'hidden', boxShadow: '0 2px 12px rgba(0,0,0,0.08)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '16px 20px' }}>
              <span style={{ fontSize: 22, width: 32, textAlign: 'center' }}>🔔</span>
              <div style={{ flex: 1 }}>
                <p style={{ margin: '0 0 2px', fontSize: 15, fontWeight: 600, color: text }}>プッシュ通知</p>
                <p style={{ margin: 0, fontSize: 12, color: sub }}>
                  {pushStatus === 'granted' ? '通知ON（タップでOFF）' : pushStatus === 'denied' ? 'ブラウザで拒否されています' : '連絡板の通知を受け取る'}
                </p>
                {pushStatus === 'denied' && (
                  <div style={{ marginTop: 8, padding: '8px 10px', background: isDark ? '#3d3d55' : '#fff3cd', borderRadius: 8, fontSize: 11, color: isDark ? sub : '#856404', lineHeight: 1.8 }}>
                    ⚙️ <strong>再設定の手順</strong><br />
                    ① アドレスバー左の 🔒 をタップ<br />
                    ② 「通知」→「許可」に変更<br />
                    ③ このページを再読み込み
                  </div>
                )}
              </div>
              {pushStatus !== 'denied' && (
                <button
                  onClick={handlePushToggle}
                  disabled={pushLoading}
                  style={{
                    padding: '7px 16px', borderRadius: 20, border: 'none', cursor: pushLoading ? 'default' : 'pointer',
                    fontSize: 13, fontWeight: 600,
                    background: pushStatus === 'granted' ? '#dc3545' : '#4CAF50',
                    color: '#fff', opacity: pushLoading ? 0.6 : 1,
                  }}
                >
                  {pushLoading ? '...' : pushStatus === 'granted' ? 'OFFにする' : '許可する'}
                </button>
              )}
            </div>
          </div>
        )}

        <button
          onClick={() => navigate(-1)}
          style={{ display: 'block', width: '100%', marginTop: 20, padding: '12px', background: 'none', border: `1px solid ${border}`, borderRadius: 12, color: sub, cursor: 'pointer', fontSize: 14 }}
        >
          戻る
        </button>
      </div>
    </div>
  );
}

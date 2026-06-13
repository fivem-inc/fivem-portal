import { useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { useAuth } from '../hooks/useAuth';
import { useDarkMode } from '../hooks/useDarkMode';
import { requestPushPermission, unsubscribePush, getPushPermissionStatus } from '../utils/pushNotification';

export default function AccountSettings() {
  const navigate = useNavigate();
  const { user, profileName } = useAuth();
  const isDark = useDarkMode();

  const bg = isDark ? '#1e1e2e' : '#f8f9fa';
  const card = isDark ? '#2c2c3e' : '#ffffff';
  const text = isDark ? '#fff' : '#1a1a2e';
  const sub = isDark ? '#adb5bd' : '#6c757d';
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

  const menuItems = [
    {
      icon: '✉️',
      label: 'メールアドレス変更',
      desc: user?.email || '',
      path: '/change-email',
    },
    {
      icon: '🔑',
      label: 'パスワード変更',
      desc: '新しいパスワードに変更する',
      path: '/change-password',
    },
  ];

  return (
    <div style={{ minHeight: '100vh', background: bg, padding: '24px 16px' }}>
      {/* プロフィールカード */}
      <div style={{ maxWidth: 400, margin: '0 auto' }}>
        <div style={{ background: card, borderRadius: 16, padding: '28px 20px', textAlign: 'center', boxShadow: '0 2px 12px rgba(0,0,0,0.08)', marginBottom: 20 }}>
          <div style={{ width: 64, height: 64, borderRadius: '50%', background: isDark ? '#3d3d55' : '#e9ecef', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28, margin: '0 auto 12px' }}>
            👤
          </div>
          <p style={{ margin: '0 0 4px', fontSize: 20, fontWeight: 700, color: text }}>{profileName || '未設定'}</p>
          <p style={{ margin: 0, fontSize: 13, color: sub }}>{user?.email}</p>
        </div>

        {/* メニュー */}
        <div style={{ background: card, borderRadius: 16, overflow: 'hidden', boxShadow: '0 2px 12px rgba(0,0,0,0.08)' }}>
          {menuItems.map((item, i) => (
            <button
              key={item.path}
              onClick={() => navigate(item.path)}
              style={{
                width: '100%', display: 'flex', alignItems: 'center', gap: 14,
                padding: '16px 20px', background: 'none', border: 'none', cursor: 'pointer',
                borderBottom: i < menuItems.length - 1 ? `1px solid ${border}` : 'none',
                textAlign: 'left',
              }}
            >
              <span style={{ fontSize: 22, width: 32, textAlign: 'center' }}>{item.icon}</span>
              <div style={{ flex: 1 }}>
                <p style={{ margin: '0 0 2px', fontSize: 15, fontWeight: 600, color: text }}>{item.label}</p>
                <p style={{ margin: 0, fontSize: 12, color: sub, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 240 }}>{item.desc}</p>
              </div>
              <span style={{ color: sub, fontSize: 18 }}>›</span>
            </button>
          ))}
        </div>

        {/* プッシュ通知設定 */}
        {pushStatus !== 'unsupported' && (
          <div style={{ background: card, borderRadius: 16, overflow: 'hidden', boxShadow: '0 2px 12px rgba(0,0,0,0.08)', marginTop: 12 }}>
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
          onClick={() => navigate('/')}
          style={{ display: 'block', width: '100%', marginTop: 20, padding: '12px', background: 'none', border: `1px solid ${border}`, borderRadius: 12, color: sub, cursor: 'pointer', fontSize: 14 }}
        >
          ファイブＭスタッフサイトに戻る
        </button>
      </div>
    </div>
  );
}

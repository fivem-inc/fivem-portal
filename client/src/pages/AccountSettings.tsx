import { useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { useAuth } from '../hooks/useAuth';
import { useDarkMode } from '../hooks/useDarkMode';
import { supabase } from '../lib/supabaseClient';
import { requestPushPermission, unsubscribePush, getPushPermissionStatus } from '../utils/pushNotification';
import PushQuietHoursSection from '../components/PushQuietHoursSection';
import TextScaleChoice from '../components/TextScaleChoice';
import NavOrderSettings from '../components/NavOrderSettings';
import NavTwoRowSettings from '../components/NavTwoRowSettings';
import { SettingsGroup, SettingsRow } from '../components/SettingsRow';
import { useNavReorderOn } from '../hooks/useNavReorderOn';
import { useNavRolloutOn } from '../hooks/useNavRolloutOn';
import { TEXT_SCALES, getTextScale, textScaleSupported } from '../lib/textScale';
import { backBtn } from '../lib/buttonStyles';

export default function AccountSettings() {
  const navigate = useNavigate();
  const { user, profileName } = useAuth();
  const isDark = useDarkMode();

  const bg = isDark ? '#1e1e2e' : '#f8f9fa';
  const card = isDark ? '#2c2c3e' : '#ffffff';
  const text = isDark ? '#fff' : '#1a1a2e';
  const sub = isDark ? '#adb5bd' : '#6c757d';
  const border = isDark ? '#3d3d55' : '#e9ecef';

  const colors = { text, sub, border, card };
  // 開いている行（1度に1つ・2026-10-17 ユーザー確定）
  const [openKey, setOpenKey] = useState<string | null>(null);
  const toggle = (k: string) => () => setOpenKey(cur => (cur === k ? null : k));
  const navReorderOn = useNavReorderOn();
  const navTwoRowChoiceOn = useNavRolloutOn('two_row_choice');   // 2段を自分で選べる人だけ「スマホのナビ」を出す（2026-10-17）
  const [scale, setScale] = useState(getTextScale);
  const scaleLabel = textScaleSupported() ? (TEXT_SCALES.find(t => t.value === scale)?.label ?? '標準') : '';

  const [pushStatus, setPushStatus] = useState<'granted' | 'denied' | 'default' | 'unsupported'>('default');
  const [pushLoading, setPushLoading] = useState(false);

  // 緊急連絡先（安否確認で使用）
  // 閲覧できる範囲は staff_phone_numbers の RLS が決める：
  //   本人／マネージャー以上／安否確認が進行中のときはリーダーも
  // 画面には「何に使うか」だけ書き、閲覧範囲は書かない（会社の業務用連絡先のため）。
  // 🚨 もし画面に閲覧範囲を書き足すときは、上のRLSと必ず突き合わせること
  //    （以前「本人とマネージャー以上のみ」と書かれていたが、リーダーが抜けていて事実と違っていた）
  const [phone, setPhone] = useState('');
  const [phoneSaved, setPhoneSaved] = useState('');   // 保存済みの値（変更検知用）
  const [phoneLoading, setPhoneLoading] = useState(true);
  const [phoneSaving, setPhoneSaving] = useState(false);
  const [phoneMsg, setPhoneMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    if (!user?.id) return;
    supabase.from('staff_phone_numbers').select('phone').eq('user_id', user.id).maybeSingle()
      .then(({ data }: { data: { phone: string } | null }) => {
        setPhone(data?.phone || '');
        setPhoneSaved(data?.phone || '');
        setPhoneLoading(false);
      }, () => setPhoneLoading(false));
  }, [user?.id]);

  const savePhone = async () => {
    if (!user?.id) return;
    const v = phone.trim();
    if (!v) { setPhoneMsg({ type: 'err', text: '電話番号を入力してください' }); return; }
    setPhoneSaving(true);
    setPhoneMsg(null);
    const { error } = await supabase.from('staff_phone_numbers')
      .upsert({ user_id: user.id, phone: v }, { onConflict: 'user_id' });
    setPhoneSaving(false);
    if (error) { setPhoneMsg({ type: 'err', text: '保存できませんでした。時間をおいてお試しください' }); return; }
    setPhoneSaved(v);
    setPhoneMsg({ type: 'ok', text: '保存しました' });
    setTimeout(() => setPhoneMsg(null), 3000);
  };

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
      {/* プロフィールカード */}
      <div style={{ maxWidth: 400, margin: '0 auto' }}>
        <div style={{ background: card, borderRadius: 16, padding: '28px 20px', textAlign: 'center', boxShadow: '0 2px 12px rgba(0,0,0,0.08)', marginBottom: 20 }}>
          <div style={{ width: 64, height: 64, borderRadius: '50%', background: isDark ? '#3d3d55' : '#e9ecef', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28, margin: '0 auto 12px' }}>
            👤
          </div>
          <p style={{ margin: '0 0 4px', fontSize: 20, fontWeight: 700, color: text }}>{profileName || '未設定'}</p>
          <p style={{ margin: 0, fontSize: 13, color: sub }}>{user?.email}</p>
        </div>

        {/* 2026-10-17 ユーザー確定：まとまり（アカウント・連絡先・表示・通知）に分け、どの行も「絵文字＋名前（左寄せ）＋今の状態 ›」。押すとその行だけが開く */}
        <SettingsGroup label="アカウント" colors={colors}>
          <SettingsRow icon="✉️" title="メールアドレス変更" sub={user?.email || ''} colors={colors} onClick={() => navigate('/change-email')} />
          <SettingsRow icon="🔑" title="パスワード変更" sub="新しいパスワードに変更する" colors={colors} onClick={() => navigate('/change-password')} />
        </SettingsGroup>

        {/* 緊急連絡先（安否確認用） */}
        <SettingsGroup label="連絡先" colors={colors}>
          <SettingsRow icon="📞" title="緊急連絡先" sub="災害時の安否確認で連絡がつかないときに使います"
            value={phoneLoading ? '' : (phoneSaved || '未登録')} colors={colors} open={openKey === 'phone'} onToggle={toggle('phone')}>
            {phoneLoading ? (
              <p style={{ margin: 0, fontSize: 13, color: sub }}>読み込み中...</p>
            ) : (
              <>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input
                    type="tel"
                    value={phone}
                    onChange={e => { setPhone(e.target.value); setPhoneMsg(null); }}
                    placeholder="090-1234-5678"
                    style={{
                      flex: 1, minWidth: 0, padding: '10px 12px', fontSize: 16, borderRadius: 8,
                      border: `1px solid ${border}`, background: isDark ? '#3d3d55' : '#fff', color: text,
                    }}
                  />
                  <button
                    onClick={savePhone}
                    disabled={phoneSaving || phone.trim() === phoneSaved}
                    style={{
                      padding: '10px 16px', borderRadius: 8, border: 'none', fontSize: 13, fontWeight: 600,
                      background: phone.trim() === phoneSaved ? (isDark ? '#495057' : '#e9ecef') : '#1976d2',
                      color: phone.trim() === phoneSaved ? sub : '#fff',
                      cursor: phoneSaving || phone.trim() === phoneSaved ? 'default' : 'pointer',
                      flexShrink: 0,
                    }}
                  >
                    {phoneSaving ? '保存中...' : '保存'}
                  </button>
                </div>
                {phoneMsg && (
                  <div style={{
                    marginTop: 10, padding: '10px 12px', borderRadius: 8, fontSize: 13, fontWeight: 600,
                    background: phoneMsg.type === 'ok' ? '#f0fdf4' : '#f8d7da',
                    border: `1px solid ${phoneMsg.type === 'ok' ? '#86efac' : '#f5c2c7'}`,
                    color: phoneMsg.type === 'ok' ? '#166534' : '#842029',
                  }}>
                    {phoneMsg.type === 'ok' ? '✓ ' : ''}{phoneMsg.text}
                  </div>
                )}
              </>
            )}
          </SettingsRow>
        </SettingsGroup>

        <SettingsGroup label="表示" colors={colors}>
          {/* 文字の大きさ（2026-10-15・本人が選ぶ・その端末だけ・しくみは lib/textScale.ts） */}
          <SettingsRow icon="🔍" title="文字の大きさ" sub={textScaleSupported() ? 'このスマホだけに効きます' : 'パソコンはキーボードで変えます'}
            value={scaleLabel} colors={colors} open={openKey === 'text'} onToggle={toggle('text')}>
            <TextScaleChoice hintColor={sub} onChange={setScale} />
          </SettingsRow>
        </SettingsGroup>

        <SettingsGroup label="通知" colors={colors}>
          {pushStatus !== 'unsupported' && (
            <SettingsRow icon="🔔" title="プッシュ通知" sub="連絡板や申請のお知らせ"
              value={pushStatus === 'granted' ? '通知ON' : pushStatus === 'denied' ? '拒否されています' : '通知OFF'}
              colors={colors} open={openKey === 'push'} onToggle={toggle('push')}>
              <p style={{ margin: '0 0 10px', fontSize: 13, color: text, lineHeight: 1.7 }}>
                {pushStatus === 'granted'
                  ? 'このスマホに、連絡板や申請のお知らせが届きます。'
                  : pushStatus === 'denied'
                    ? 'ブラウザの設定で、通知が拒否されています。'
                    : '許可すると、このスマホに連絡板や申請のお知らせが届きます。'}
              </p>
              {pushStatus === 'denied' ? (
                <div style={{ padding: '8px 10px', background: isDark ? '#3d3d55' : '#fff3cd', borderRadius: 8, fontSize: 12, color: isDark ? sub : '#856404', lineHeight: 1.8 }}>
                  <strong>再設定の手順</strong><br />
                  ① アドレスバー左の 🔒 をタップ<br />
                  ② 「通知」→「許可」に変更<br />
                  ③ このページを再読み込み
                </div>
              ) : (
                <button onClick={handlePushToggle} disabled={pushLoading}
                  style={pushStatus === 'granted'
                    ? { ...backBtn(isDark), padding: '9px 16px', fontSize: 13 }
                    : { padding: '9px 16px', borderRadius: 8, border: 'none', fontSize: 13, fontWeight: 600, background: '#1976d2', color: '#fff', cursor: pushLoading ? 'default' : 'pointer' }}>
                  {pushLoading ? '...' : pushStatus === 'granted' ? '通知をオフにする' : '通知を許可する'}
                </button>
              )}
            </SettingsRow>
          )}
          {/* プッシュ通知の受信時間（許可済みの人にだけ出る） */}
          {pushStatus === 'granted' && <PushQuietHoursSection colors={colors} open={openKey === 'quiet'} onToggle={toggle('quiet')} />}
        </SettingsGroup>

        {/* 並び：表示 → 通知 → ナビ（2026-10-17 ユーザー確定「文字の大きさの下に通知」）。ナビの並びは試している人だけなので最後 */}
        <SettingsGroup label="ナビ" colors={colors}>
          {/* 上のナビの並び（2026-10-17・管理画面で「並べ替え」がオンの人だけに出る） */}
          {navReorderOn && <NavOrderSettings isDark={isDark} colors={colors} open={openKey === 'nav'} onToggle={toggle('nav')} />}
          {navTwoRowChoiceOn && <NavTwoRowSettings isDark={isDark} colors={colors} open={openKey === 'navTwoRow'} onToggle={toggle('navTwoRow')} />}
        </SettingsGroup>

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

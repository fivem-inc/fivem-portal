import { useEffect, useState } from 'react';
import { useAuth } from '../hooks/useAuth';
import { useDarkMode } from '../hooks/useDarkMode';
import { supabase } from '../lib/supabaseClient';
import { getPushPermissionStatus } from '../utils/pushNotification';
import { normalizeTime } from '../lib/timeInput';
import TimeInput from './TimeInput';

// プッシュ通知の受信時間帯・休暇日ミュートの本人設定カード。
// アカウント設定（/account）と通知設定（/notification-settings）の両方に同じものを表示する。
// 🚨 判定ロジックを持つのはDB関数 push_muted_user_ids（配達側）。ここは設定の保存だけ。
// 🚨 権限判定・表示条件はこの部品の中で完結させる（propsで配ると渡し忘れ事故になる前例あり）。
//    プッシュを許可している人（granted）にだけ表示する＝許可した瞬間、プッシュ通知カードの
//    真下にこのカードが現れる（未購読の人に「効かない設定」を見せない）。
export default function PushQuietHoursSection() {
  const { user } = useAuth();
  const isDark = useDarkMode();

  const card = isDark ? '#2c2c3e' : '#ffffff';
  const text = isDark ? '#fff' : '#1a1a2e';
  const sub = isDark ? '#adb5bd' : '#6c757d';

  const [granted, setGranted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [quietEnabled, setQuietEnabled] = useState(false);
  const [receiveStart, setReceiveStart] = useState('07:00');
  const [receiveEnd, setReceiveEnd] = useState('22:00');
  const [muteOnLeave, setMuteOnLeave] = useState(false);
  const [savedSnap, setSavedSnap] = useState('');   // 保存済み状態（変更検知用）
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const snap = (q: boolean, s: string, e: string, m: boolean) => JSON.stringify([q, s, e, m]);
  const dirty = snap(quietEnabled, receiveStart, receiveEnd, muteOnLeave) !== savedSnap;
  // 🚨 時刻として読めない値も止める。ここを素通りすると、画面の説明文（文字列で前後を比べている）と
  //    サーバー側のDB関数（time型で比べる）で日またぎの判定が食い違い、
  //    「鳴らないはずの時間に鳴る」という気づきにくい不具合になる
  const timeInvalid = quietEnabled
    && (receiveStart === receiveEnd || !normalizeTime(receiveStart) || !normalizeTime(receiveEnd));

  // プッシュ許可状態（許可済みの人にだけこのカードを出す）。
  // 別タブ・ブラウザ設定で変わることがあるので、画面に戻ったとき再チェックする
  useEffect(() => {
    const check = () => getPushPermissionStatus().then((s) => setGranted(s === 'granted'));
    check();
    const onVisible = () => { if (document.visibilityState === 'visible') check(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  useEffect(() => {
    if (!user?.id) return;
    supabase.from('push_preferences')
      .select('quiet_enabled, receive_start, receive_end, mute_on_leave')
      .eq('user_id', user.id)
      .maybeSingle()
      .then(({ data }: { data: { quiet_enabled: boolean; receive_start: string | null; receive_end: string | null; mute_on_leave: boolean } | null }) => {
        // DBのtime型は '07:00:00' で返るので HH:MM に切り詰める
        // （<input type="time"> の value はゼロ埋め HH:MM でないと表示されない）
        const q = data?.quiet_enabled ?? false;
        const s = (data?.receive_start ?? '07:00').slice(0, 5);
        const e = (data?.receive_end ?? '22:00').slice(0, 5);
        const m = data?.mute_on_leave ?? false;
        setQuietEnabled(q); setReceiveStart(s); setReceiveEnd(e); setMuteOnLeave(m);
        setSavedSnap(snap(q, s, e, m));
        setLoading(false);
      }, () => setLoading(false));
  }, [user?.id]);

  const save = async () => {
    if (!user?.id || timeInvalid) return;
    setSaving(true);
    setMsg(null);
    const { error } = await supabase.from('push_preferences').upsert({
      user_id: user.id,
      quiet_enabled: quietEnabled,
      receive_start: normalizeTime(receiveStart) || receiveStart,
      receive_end: normalizeTime(receiveEnd) || receiveEnd,
      mute_on_leave: muteOnLeave,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' });
    setSaving(false);
    if (error) { setMsg({ type: 'err', text: '保存できませんでした。時間をおいてお試しください' }); return; }
    setSavedSnap(snap(quietEnabled, receiveStart, receiveEnd, muteOnLeave));
    setMsg({ type: 'ok', text: '保存しました' });
    setTimeout(() => setMsg(null), 3000);
  };

  if (!granted) return null;

  // 表示用の時刻（7:00 形式・時は0埋めしない。アプリ共通の表記ルール）
  const disp = (t: string) => { const [h, m] = t.split(':'); return `${Number(h)}:${m ?? '00'}`; };
  // 入力値から「実際にどう動くか」を平易な言葉で常時表示する。
  // 🚨 これが無いと「夜止めたい人が受信欄に 22:00〜7:00 を入れて意図と真逆になる」事故に
  //    本人が気づけない（入力した瞬間にこの文で気づける）
  const effectText = receiveStart < receiveEnd
    ? `${disp(receiveStart)}〜${disp(receiveEnd)} のあいだは通知が鳴ります。それ以外の時間の通知は、${disp(receiveStart)} になるとまとめて届きます。`
    : receiveStart > receiveEnd
      ? `${disp(receiveStart)}〜翌${disp(receiveEnd)} のあいだは通知が鳴ります。${disp(receiveEnd)}〜${disp(receiveStart)} は鳴らず、${disp(receiveStart)} にまとめて届きます。（日をまたぐ設定です）`
      : '';


  return (
    <div style={{ background: card, borderRadius: 16, overflow: 'hidden', boxShadow: '0 2px 12px rgba(0,0,0,0.08)', marginTop: 12, padding: '16px 20px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 10 }}>
        <span style={{ fontSize: 22, width: 32, textAlign: 'center' }}>🕐</span>
        <div style={{ flex: 1 }}>
          <p style={{ margin: '0 0 2px', fontSize: 15, fontWeight: 600, color: text }}>通知の受信時間</p>
          <p style={{ margin: 0, fontSize: 12, color: sub }}>夜間や休みの日にプッシュ通知を鳴らさない設定です</p>
        </div>
      </div>

      {loading ? (
        <p style={{ margin: 0, fontSize: 13, color: sub }}>読み込み中...</p>
      ) : (
        <>
          {/* 受信時間帯 */}
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 14, fontWeight: 600, color: text }}>
            <input type="checkbox" checked={quietEnabled} onChange={e => { setQuietEnabled(e.target.checked); setMsg(null); }}
              style={{ width: 18, height: 18, accentColor: '#1976d2' }} />
            <span>通知を受け取る時間を決める</span>
          </label>
          {quietEnabled && (
            <div style={{ margin: '10px 0 0 26px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 13, color: sub }}>受け取る時間帯</span>
                <TimeInput value={receiveStart} onChange={v => { setReceiveStart(v); setMsg(null); }} isDark={isDark} advance ariaLabel="受け取る時間帯 開始" style={{ flex: 1, minWidth: 0 }} />
                <span style={{ fontSize: 14, color: text }}>〜</span>
                <TimeInput value={receiveEnd} onChange={v => { setReceiveEnd(v); setMsg(null); }} isDark={isDark} ariaLabel="受け取る時間帯 終了" style={{ flex: 1, minWidth: 0 }} />
              </div>
              {timeInvalid ? (
                <div style={{ marginTop: 8, padding: '8px 10px', borderRadius: 8, fontSize: 12.5,
                  background: isDark ? '#4a2b30' : '#fdecea', border: '1px solid #e24b4a', color: isDark ? '#ffb3b3' : '#b71c1c' }}>
                  開始と終了が同じ時刻です。受け取る時間帯を入力してください
                </div>
              ) : effectText && (
                <div style={{ marginTop: 8, padding: '8px 10px', borderRadius: 8, fontSize: 12.5, lineHeight: 1.7,
                  background: isDark ? '#1e2a3a' : '#eff6ff', border: `1px solid ${isDark ? '#3b82f6' : '#bfdbfe'}`, color: isDark ? '#bfdbfe' : '#1d4ed8' }}>
                  → {effectText}
                </div>
              )}
            </div>
          )}

          {/* 休暇日ミュート */}
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer', fontSize: 14, fontWeight: 600, color: text, marginTop: 14 }}>
            <input type="checkbox" checked={muteOnLeave} onChange={e => { setMuteOnLeave(e.target.checked); setMsg(null); }}
              style={{ width: 18, height: 18, accentColor: '#1976d2', marginTop: 1 }} />
            <span>休暇日は通知を受け取らない</span>
          </label>
          <p style={{ margin: '6px 0 0 26px', fontSize: 12, color: sub, lineHeight: 1.7 }}>
            休みの日（受理された休暇・調整休・振替休日・欠勤・会社の休業日）は通知を止め、休み明けにまとめて届きます。
          </p>

          {/* 例外の説明（常時表示） */}
          <p style={{ margin: '12px 0 0', fontSize: 12, color: sub, lineHeight: 1.7 }}>
            ※安否確認と、連絡板で「当日の連絡・緊急」が付いた連絡は、設定に関係なくすぐ届きます。<br />
            ※止まるのはスマホのプッシュ通知だけです。アプリを開けば 🔔ベル ではいつでも確認できます。
          </p>

          {/* 保存 */}
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
            <button
              onClick={save}
              disabled={saving || !dirty || timeInvalid}
              style={{
                padding: '10px 18px', borderRadius: 8, border: 'none', fontSize: 13, fontWeight: 600,
                background: (!dirty || timeInvalid) ? (isDark ? '#495057' : '#e9ecef') : '#1976d2',
                color: (!dirty || timeInvalid) ? sub : '#fff',
                cursor: saving || !dirty || timeInvalid ? 'default' : 'pointer',
              }}
            >
              {saving ? '保存中...' : '保存'}
            </button>
          </div>
          {msg && (
            <div style={{
              marginTop: 10, padding: '10px 12px', borderRadius: 8, fontSize: 13, fontWeight: 600,
              background: msg.type === 'ok' ? '#f0fdf4' : '#f8d7da',
              border: `1px solid ${msg.type === 'ok' ? '#86efac' : '#f5c2c7'}`,
              color: msg.type === 'ok' ? '#166534' : '#842029',
            }}>
              {msg.type === 'ok' ? '✓ ' : ''}{msg.text}
            </div>
          )}
        </>
      )}
    </div>
  );
}

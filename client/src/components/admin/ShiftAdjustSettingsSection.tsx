import React, { useCallback, useEffect, useState } from 'react';
import { useAdminPanel } from './AdminPanelContext';
import { supabase } from '../../lib/supabaseClient';

// シフト調整の設定（2026-09-13 手順8・ユーザー確定）。設計は docs/計画-シフト調整.md。
//
// ・毎朝のまとめ … 対象／何日以内／送る時刻／送る曜日
// ・決定するときの自動登録の開始日 … パート（勤怠の登録）と正社員（残業申請の依頼）で別々
// ・選ばれなかったパートへの連絡
//
// 🚨 宛先とスマホ通知の ON/OFF はここに置かない。上の通知一覧「シフト調整の毎朝のまとめ」で指定する。
//    同じ設定を2か所に置くと、片方だけ直したときに食い違う。
// 🚨 送る処理は DB の cron（shift_adjust_send_digest・15分おき）。Edge Function は使っていない。

const DAY_CHOICES = [3, 5, 7, 14];
// 表示は月曜はじまり。値は 0＝日 … 6＝土（DB の extract(dow) と同じ）
const WEEKDAYS: { v: number; label: string }[] = [
  { v: 1, label: '月' }, { v: 2, label: '火' }, { v: 3, label: '水' }, { v: 4, label: '木' },
  { v: 5, label: '金' }, { v: 6, label: '土' }, { v: 0, label: '日' },
];

interface Settings {
  digest_enabled: boolean;
  digest_include_working: boolean;
  digest_days: number;
  digest_time: string;          // "HH:MM:SS"
  digest_weekdays: number[];
  attendance_from: string | null;
  request_from: string | null;
  notify_unpicked: 'screen' | 'bell';
}

const ShiftAdjustSettingsSection: React.FC = () => {
  const { isDarkMode } = useAdminPanel();
  const [st, setSt] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const bg = isDarkMode ? '#343a40' : 'white';
  const text = isDarkMode ? '#fff' : '#333';
  const subText = isDarkMode ? '#adb5bd' : '#666';
  const borderColor = isDarkMode ? '#6c757d' : '#ddd';
  const inputStyle: React.CSSProperties = {
    padding: '8px 10px', borderRadius: 8, fontSize: 14,
    border: `1px solid ${borderColor}`, background: isDarkMode ? '#2b3035' : '#fff', color: text,
  };

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from('shift_adjust_settings')
      .select('digest_enabled, digest_include_working, digest_days, digest_time, digest_weekdays, attendance_from, request_from, notify_unpicked')
      .eq('id', 1)
      .maybeSingle();
    // 🚨 読めなかったときは「設定なし」と決めつけない。空で上書きすると既定値で塗り潰してしまう
    if (error) { setErr('設定を読み込めませんでした：' + error.message); return; }
    if (!data) { setErr('設定がまだありません（管理者にご連絡ください）'); return; }
    setErr('');
    setSt(data as Settings);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const save = async (patch: Partial<Settings>) => {
    if (!st || saving) return;
    const next = { ...st, ...patch };
    if (next.digest_weekdays.length === 0) {
      setErr('送る曜日を1つ以上選んでください');
      return;
    }
    setSaving(true); setErr(''); setMsg('');
    // 🚨 update は0件でもエラーにならない。件数を見ないと「保存したつもり」で通る
    const { data, error } = await supabase
      .from('shift_adjust_settings')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', 1)
      .select('id');
    setSaving(false);
    if (error) { setErr('保存できませんでした：' + error.message); return; }
    if (!data || data.length === 0) { setErr('保存できませんでした（権限がない可能性があります）'); return; }
    setSt(next);
    setMsg('✓ 保存しました');
    setTimeout(() => setMsg(''), 3000);
  };

  const chip = (on: boolean): React.CSSProperties => ({
    padding: '6px 14px', borderRadius: 14, fontSize: 12.5, fontWeight: 'bold', cursor: 'pointer',
    border: `1px solid ${on ? '#4a90d9' : borderColor}`,
    background: on ? '#e8f4fd' : 'transparent',
    color: on ? '#1565c0' : subText,
  });
  const label: React.CSSProperties = { fontSize: 12, color: subText, marginBottom: 6 };
  const note: React.CSSProperties = { fontSize: 11.5, color: subText, marginTop: 6, lineHeight: 1.6 };
  const row: React.CSSProperties = { marginBottom: 14 };
  const divider: React.CSSProperties = { borderTop: `0.5px solid ${borderColor}`, margin: '16px 0 14px' };

  const dateRow = (key: 'attendance_from' | 'request_from', title: string) => (
    <div style={row}>
      <div style={label}>{title}</div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          type="date"
          value={st?.[key] ?? ''}
          onChange={e => e.target.value && save({ [key]: e.target.value })}
          style={inputStyle}
        />
        {st?.[key] ? (
          <button type="button" onClick={() => save({ [key]: null })} style={chip(false)}>未設定に戻す</button>
        ) : (
          <span style={{ fontSize: 12, color: subText }}>未設定（初期値はOFF）</span>
        )}
      </div>
    </div>
  );

  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{
        background: '#E8F5E9', borderLeft: '3px solid #2E7D32', borderRadius: '0 6px 6px 0',
        padding: '8px 12px', fontSize: 13, fontWeight: 500, color: '#1B5E20', marginBottom: 8,
      }}>
        🔁 シフト調整（毎朝のまとめ・設定）
      </div>

      <div style={{ background: bg, border: `0.5px solid ${borderColor}`, borderRadius: 12, padding: '14px 16px' }}>
        <div style={{ fontSize: 12, color: subText, lineHeight: 1.7, marginBottom: 12 }}>
          まだ調整していない休み・欠勤を、毎朝1本にまとめてお知らせします。<br />
          押すと勤怠カレンダーの「シフト調整」タブが開きます。<br />
          <b style={{ color: text }}>送る相手とスマホ通知の ON/OFF</b>は、上の一覧「休暇申請 → シフト調整の毎朝のまとめ」で指定します。
          届くのは、そのうち「シフト調整を見る」権限がある方だけです。
        </div>

        {err && (
          <div style={{ marginBottom: 10, padding: '8px 10px', borderRadius: 8, fontSize: 12,
            background: '#f8d7da', border: '1px solid #f5c2c7', color: '#842029' }}>{err}</div>
        )}

        {st && (
          <>
            <div style={row}>
              <div style={label}>お知らせする</div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" onClick={() => save({ digest_enabled: true })} style={chip(st.digest_enabled)}>する</button>
                <button type="button" onClick={() => save({ digest_enabled: false })} style={chip(!st.digest_enabled)}>しない</button>
              </div>
            </div>

            <div style={row}>
              <div style={label}>まとめに入れるもの</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button type="button" onClick={() => save({ digest_include_working: true })} style={chip(st.digest_include_working)}>未調整＋調整中</button>
                <button type="button" onClick={() => save({ digest_include_working: false })} style={chip(!st.digest_include_working)}>未調整だけ</button>
              </div>
            </div>

            <div style={row}>
              <div style={label}>何日先までの休みを入れるか</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {DAY_CHOICES.map(d => (
                  <button key={d} type="button" onClick={() => save({ digest_days: d })} style={chip(st.digest_days === d)}>
                    {d}日以内
                  </button>
                ))}
              </div>
            </div>

            <div style={row}>
              <div style={label}>送る時刻</div>
              <input
                type="time"
                value={st.digest_time.slice(0, 5)}
                onChange={e => e.target.value && save({ digest_time: `${e.target.value}:00` })}
                style={inputStyle}
              />
              <div style={note}>
                この時刻を過ぎた最初のタイミング（15分おき）で送られます。2時間を過ぎたら、その日は送りません。
              </div>
            </div>

            <div style={{ marginBottom: 4 }}>
              <div style={label}>送る曜日（複数選べます）</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {WEEKDAYS.map(w => {
                  const on = st.digest_weekdays.includes(w.v);
                  return (
                    <button key={w.v} type="button" style={chip(on)}
                      onClick={() => save({
                        digest_weekdays: on ? st.digest_weekdays.filter(x => x !== w.v) : [...st.digest_weekdays, w.v].sort(),
                      })}>
                      {w.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div style={divider} />

            <div style={{ fontSize: 13, fontWeight: 'bold', color: text, marginBottom: 4 }}>決定するときの自動登録の開始日</div>
            <div style={{ ...note, marginTop: 0, marginBottom: 12 }}>
              休みの日がこの日以降なら、決定画面のチェックが最初からONになります。
              それより前の日、または未設定のときはOFFで出ます（押せば登録・依頼はできます）。
            </div>
            {dateRow('attendance_from', 'パート：勤怠に登録する')}
            {dateRow('request_from', '正社員：残業申請を依頼する')}

            <div style={divider} />

            <div style={{ marginBottom: 4 }}>
              <div style={label}>選ばれなかったパートへの連絡</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button type="button" onClick={() => save({ notify_unpicked: 'screen' })} style={chip(st.notify_unpicked === 'screen')}>返事の画面に出すだけ</button>
                <button type="button" onClick={() => save({ notify_unpicked: 'bell' })} style={chip(st.notify_unpicked === 'bell')}>ベルでも知らせる</button>
              </div>
              <div style={note}>
                どちらの場合も、返事の画面には「この日の担当は決定しました。ご返事ありがとうございました。」と出ます。
                ベルでも知らせる場合、スマホは鳴りません。
              </div>
            </div>

            {msg && <div style={{ marginTop: 10, fontSize: 12, color: '#1e8449', fontWeight: 'bold' }}>{msg}</div>}
          </>
        )}
      </div>
    </div>
  );
};

export default ShiftAdjustSettingsSection;

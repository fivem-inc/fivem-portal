import React, { useCallback, useEffect, useState } from 'react';
import { useAdminPanel } from './AdminPanelContext';
import { supabase } from '../../lib/supabaseClient';

// 「シフト調整がまだの休暇」を上長へ知らせる、毎朝のお知らせの設定（2026-09-09 ユーザー指示）。
//
// 🚨 宛先（どの役職に送るか・同じチームだけに絞るか）はここには置かない。
//    上の通知一覧「休暇申請 → シフト調整がまだのとき」で指定する。
//    同じ設定を2か所に置くと、片方だけ直したときに食い違う。
//
// 🚨 cron は15分おきに動いており、ここで決めた時刻を過ぎた最初の回で送られる。
//    送った印を休暇ごとに残しているので、何度動いても二重には送られない。

const MONTH_CHOICES = [12, 6, 3, 2, 1];

interface Settings {
  enabled: boolean;
  months_before: number[];
  send_time: string;      // "HH:MM:SS"
  window_minutes: number;
}

const LeaveShiftAlertSection: React.FC = () => {
  const { isDarkMode } = useAdminPanel();
  const [st, setSt] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const bg = isDarkMode ? '#343a40' : 'white';
  const text = isDarkMode ? '#fff' : '#333';
  const subText = isDarkMode ? '#adb5bd' : '#666';
  const borderColor = isDarkMode ? '#6c757d' : '#ddd';

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from('leave_shift_alert_settings')
      .select('enabled, months_before, send_time, window_minutes')
      .eq('id', 1)
      .maybeSingle();
    // 🚨 読めなかったときは「設定なし」と決めつけず、その旨を出す。
    //    空で上書きすると、保存したときに既定値で塗り潰してしまう
    if (error) { setErr('設定を読み込めませんでした：' + error.message); return; }
    if (!data) { setErr('設定がまだありません（管理者にご連絡ください）'); return; }
    setErr('');
    setSt(data as Settings);
  }, []);

  useEffect(() => { load(); }, [load]);

  const save = async (patch: Partial<Settings>) => {
    if (!st || saving) return;
    const next = { ...st, ...patch };
    if (next.months_before.length === 0) {
      setErr('お知らせする時期を1つ以上選んでください');
      return;
    }
    setSaving(true); setErr(''); setMsg('');
    // 🚨 update は0件でもエラーにならない。件数を見ないと「保存したつもり」で通る
    const { data, error } = await supabase
      .from('leave_shift_alert_settings')
      .update({
        enabled: next.enabled,
        months_before: [...next.months_before].sort((a, b) => b - a),
        send_time: next.send_time,
        window_minutes: next.window_minutes,
        updated_at: new Date().toISOString(),
      })
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

  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{
        background: '#E8F5E9', borderLeft: '3px solid #2E7D32', borderRadius: '0 6px 6px 0',
        padding: '8px 12px', fontSize: 13, fontWeight: 500, color: '#1B5E20', marginBottom: 8,
      }}>
        🔁 シフト未調整のお知らせ（毎朝）
      </div>

      <div style={{ background: bg, border: `0.5px solid ${borderColor}`, borderRadius: 12, padding: '14px 16px' }}>
        <div style={{ fontSize: 12, color: subText, lineHeight: 1.7, marginBottom: 12 }}>
          受理済みなのにシフト調整がまだの休暇を、上長へお知らせします。<br />
          押すと勤怠カレンダーが「シフト未調整だけ」で絞られた状態で開きます。<br />
          <b style={{ color: text }}>送る相手</b>は、上の一覧「休暇申請 → シフト調整がまだのとき」で指定します。
        </div>

        {err && (
          <div style={{ marginBottom: 10, padding: '8px 10px', borderRadius: 8, fontSize: 12,
            background: '#f8d7da', border: '1px solid #f5c2c7', color: '#842029' }}>{err}</div>
        )}

        {st && (
          <>
            {/* 送るかどうか */}
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 12, color: subText, marginBottom: 6 }}>お知らせする</div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" onClick={() => save({ enabled: true })} style={chip(st.enabled)}>する</button>
                <button type="button" onClick={() => save({ enabled: false })} style={chip(!st.enabled)}>しない</button>
              </div>
            </div>

            {/* いつ知らせるか（何ヶ月前） */}
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 12, color: subText, marginBottom: 6 }}>
                休暇日の何ヶ月前に知らせるか（複数選べます）
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {MONTH_CHOICES.map(m => {
                  const on = st.months_before.includes(m);
                  return (
                    <button key={m} type="button" style={chip(on)}
                      onClick={() => save({
                        months_before: on ? st.months_before.filter(x => x !== m) : [...st.months_before, m],
                      })}>
                      {m}ヶ月前
                    </button>
                  );
                })}
              </div>
              <div style={{ fontSize: 11.5, color: subText, marginTop: 6, lineHeight: 1.6 }}>
                🚨 1つの休暇につき、いちばん早い時期に1回、それより近い時期に1回の
                <b style={{ color: text }}>合計2回まで</b>です（3つ以上選んでも増えません）。
              </div>
            </div>

            {/* 送る時刻 */}
            <div style={{ marginBottom: 4 }}>
              <div style={{ fontSize: 12, color: subText, marginBottom: 6 }}>送る時刻</div>
              <input
                type="time"
                value={st.send_time.slice(0, 5)}
                onChange={e => e.target.value && save({ send_time: `${e.target.value}:00` })}
                style={{
                  padding: '8px 10px', borderRadius: 8, fontSize: 14,
                  border: `1px solid ${borderColor}`, background: isDarkMode ? '#2b3035' : '#fff', color: text,
                }}
              />
              <div style={{ fontSize: 11.5, color: subText, marginTop: 6, lineHeight: 1.6 }}>
                この時刻を過ぎた最初のタイミング（15分おき）で送られます。
                その日のうちに送れなかったぶんは、翌日の同じ時刻に送られます。
              </div>
            </div>

            {msg && <div style={{ marginTop: 10, fontSize: 12, color: '#1e8449', fontWeight: 'bold' }}>{msg}</div>}
          </>
        )}
      </div>
    </div>
  );
};

export default LeaveShiftAlertSection;

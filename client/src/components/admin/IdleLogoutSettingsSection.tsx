import React, { useEffect, useState } from 'react';
import { useAdminPanel } from './AdminPanelContext';
import {
  DEFAULT_IDLE_CONFIG, IDLE_MINUTES_MAX, IDLE_MINUTES_MIN, formatMinutes, normalizeIdleConfig,
  type IdleLogoutConfig,
} from '../../lib/idleLogout';
import { loadIdleConfig, saveIdleConfig } from '../../lib/idleLogoutConfig';
import SaveBar, { SaveNotice } from './SaveBar';

// 共有パソコンの自動ログアウトの設定（2026-09-14 ユーザー確定）。置き場所は「権限管理」タブの末尾。
// 決めたこと・写しの仕組みは lib/idleLogout.ts の冒頭を見ること。
//
// ・ログアウトまでの時間：1〜720分（12時間）。既定 1分。予告は常に残り15秒から
// ・スマホ・タブレットにもチェックを出すか：既定は出さない（パソコンだけ）。出す場合もスマホの初期値は OFF
// 🚨 ここで変えた値は、各端末が**次にログインしたとき**からログイン画面に反映される（写しの更新はログイン中）。
//    切る時間そのものは、ログイン中の端末が本物の設定を読むので、保存後の次の起動から効く

const IdleLogoutSettingsSection: React.FC = () => {
  const { isDarkMode } = useAdminPanel();
  const [cfg, setCfg] = useState<IdleLogoutConfig | null>(null);
  const [minutesText, setMinutesText] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  // ［変更する］を押したあとだけ触れる（2026-10-17・ページの決まり：押した瞬間には保存しない）
  const [editing, setEditing] = useState(false);
  const [mobileDraft, setMobileDraft] = useState(false);

  const bg = isDarkMode ? '#343a40' : 'white';
  const text = isDarkMode ? '#fff' : '#333';
  const subText = isDarkMode ? '#adb5bd' : '#666';
  const borderColor = isDarkMode ? '#6c757d' : '#ddd';
  const inputStyle: React.CSSProperties = {
    padding: '8px 10px', borderRadius: 8, fontSize: 14, width: 90,
    border: `1px solid ${borderColor}`, background: isDarkMode ? '#2b3035' : '#fff', color: text,
  };
  const chip = (on: boolean): React.CSSProperties => ({
    padding: '6px 14px', borderRadius: 14, fontSize: 12.5, fontWeight: 'bold', cursor: 'pointer',
    border: `1px solid ${on ? '#4a90d9' : borderColor}`,
    background: on ? '#e8f4fd' : 'transparent',
    color: on ? '#1565c0' : subText,
  });
  const label: React.CSSProperties = { fontSize: 12, color: subText, marginBottom: 6 };
  const note: React.CSSProperties = { fontSize: 11.5, color: subText, marginTop: 6, lineHeight: 1.6 };

  useEffect(() => {
    let alive = true;
    void loadIdleConfig().then(c => {
      if (!alive) return;
      // 🚨 読めなかったときは「設定なし」と決めつけず、理由を出す（既定値で塗り潰さない）
      if (!c) { setErr('設定を読み込めませんでした。画面を開き直してください'); return; }
      setCfg(c);
      setMinutesText(String(c.minutes));
    });
    return () => { alive = false; };
  }, []);

  const parsedMinutes = (() => {
    const n = Number(minutesText);
    if (!Number.isFinite(n) || minutesText.trim() === '') return null;
    return Math.round(n);
  })();
  const minutesInRange = parsedMinutes !== null && parsedMinutes >= IDLE_MINUTES_MIN && parsedMinutes <= IDLE_MINUTES_MAX;

  const save = async (patch: Partial<IdleLogoutConfig>) => {
    if (!cfg || saving) return;
    const next = normalizeIdleConfig({ ...cfg, ...patch });
    setSaving(true); setErr(''); setMsg('');
    const failure = await saveIdleConfig(next);
    setSaving(false);
    if (failure) { setErr('保存できませんでした：' + failure); return; }
    setCfg(next);
    setMinutesText(String(next.minutes));
    setEditing(false);
    setMsg('保存しました。各端末が次にログインしたときから効きます');
  };
  const changes: string[] = [];
  if (cfg && editing) {
    if (minutesInRange && parsedMinutes !== cfg.minutes) changes.push(`ログアウトまでの時間：${formatMinutes(cfg.minutes)} → ${formatMinutes(parsedMinutes!)}`);
    if (mobileDraft !== cfg.show_on_mobile) changes.push(`スマホ・タブレットにもチェックを出す：${cfg.show_on_mobile ? '出す' : '出さない'} → ${mobileDraft ? '出す' : '出さない'}`);
  }
  const startEdit = () => { if (!cfg) return; setMinutesText(String(cfg.minutes)); setMobileDraft(cfg.show_on_mobile); setEditing(true); setMsg(''); setErr(''); };
  const cancelEdit = () => { if (cfg) setMinutesText(String(cfg.minutes)); setEditing(false); setErr(''); };

  return (
    <div style={{ marginTop: 20 }}>
      <div style={{
        background: '#E8F5E9', borderLeft: '3px solid #2E7D32', borderRadius: '0 6px 6px 0',
        padding: '8px 12px', fontSize: 13, fontWeight: 500, color: '#1B5E20', marginBottom: 8,
      }}>
        共有パソコンの自動ログアウト
      </div>
      {cfg && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 6 }}>
          {!editing
            ? <button type="button" onClick={startEdit}
                style={{ padding: '5px 12px', borderRadius: 8, border: 'none', background: '#f59e0b', color: '#fff', fontWeight: 'bold', fontSize: 12, cursor: 'pointer' }}>✏️ 変更する</button>
            : <span style={{ fontSize: 12, color: '#d97706', fontWeight: 'bold' }}>✏️ 編集中</span>}
        </div>
      )}

      <div style={{ background: bg, border: `0.5px solid ${borderColor}`, borderRadius: 12, padding: '14px 16px' }}>
        <div style={{ fontSize: 12, color: subText, lineHeight: 1.7, marginBottom: 12 }}>
          ログイン画面の「この端末は共有です」にチェックしてログインした端末では、
          決められた時間なにも操作がないと自動でログアウトします（書きかけの下書きも消えます）。<br />
          チェックはパソコン（マウスのある端末）に出て、初期値は ON です。外すには二段階の確認があります。<br />
          <b style={{ color: text }}>ここで変えた値は、各端末が次にログインしたときから効きます。</b>
          いまログイン中の端末には、次にログイン画面を通るまで何も起きません。
        </div>

        {err && !editing && (
          <div style={{ marginBottom: 10, padding: '8px 10px', borderRadius: 8, fontSize: 12,
            background: '#f8d7da', border: '1px solid #f5c2c7', color: '#842029' }}>{err}</div>
        )}

        {cfg && (
          <>
            <div style={{ marginBottom: 14 }}>
              <div style={label}>ログアウトまでの時間（{IDLE_MINUTES_MIN}〜{IDLE_MINUTES_MAX}分＝最長12時間・いまは {formatMinutes(cfg.minutes)}）</div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <input
                  type="number"
                  inputMode="numeric"
                  min={IDLE_MINUTES_MIN}
                  max={IDLE_MINUTES_MAX}
                  step={1}
                  value={minutesText}
                  onChange={e => setMinutesText(e.target.value)}
                  disabled={!editing}
                  style={{ ...inputStyle, opacity: editing ? 1 : 0.7 }}
                />
                <span style={{ fontSize: 13, color: text }}>分</span>
                {minutesInRange && parsedMinutes !== cfg.minutes && (
                  <span style={{ fontSize: 12, color: subText }}>＝ {formatMinutes(parsedMinutes)}</span>
                )}
              </div>
              {!minutesInRange && minutesText.trim() !== '' && (
                <div style={{ ...note, color: '#dc3545' }}>{IDLE_MINUTES_MIN}〜{IDLE_MINUTES_MAX} の整数で入れてください</div>
              )}
              <div style={note}>予告のカード（「あと◯秒で自動的にログアウトします」）は、時間に関係なく残り15秒から出ます。</div>
            </div>

            <div style={{ marginBottom: 4 }}>
              <div style={label}>スマホ・タブレットのログイン画面にもチェックを出す</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button type="button" disabled={!editing} onClick={() => setMobileDraft(false)} style={{ ...chip(!(editing ? mobileDraft : cfg.show_on_mobile)), cursor: editing ? 'pointer' : 'default' }}>出さない（パソコンだけ）</button>
                <button type="button" disabled={!editing} onClick={() => setMobileDraft(true)} style={{ ...chip(editing ? mobileDraft : cfg.show_on_mobile), cursor: editing ? 'pointer' : 'default' }}>出す</button>
              </div>
              <div style={note}>
                「出す」にしても、スマホ・タブレットでのチェックの初期値は OFF です（個人用の端末がほとんどのため）。
                共有のタブレットで使うときだけ、その端末でチェックを入れてログインしてください。
              </div>
            </div>

            {editing
              ? <SaveBar isDark={isDarkMode} changes={changes} saving={saving} msg={err ? { text: err, fail: true } : null}
                  onCancel={cancelEdit} onSave={() => void save({ ...(minutesInRange ? { minutes: parsedMinutes! } : {}), show_on_mobile: mobileDraft })} />
              : <SaveNotice msg={msg ? { text: msg, fail: false } : null} />}
            {cfg.minutes === DEFAULT_IDLE_CONFIG.minutes && !cfg.show_on_mobile && (
              <div style={{ ...note, marginTop: 10 }}>いまは初期値（1分・パソコンだけ）です。</div>
            )}
          </>
        )}
      </div>
    </div>
  );
};

export default IdleLogoutSettingsSection;

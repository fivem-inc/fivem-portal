import React, { useEffect, useState } from 'react';
import { useAdminPanel } from './AdminPanelContext';
import { fetchGcalMode, setGcalMode, type GcalMode } from '../../lib/gcalCalendarConfig';

// 休暇・欠勤の書き込み先 Google カレンダーを本番／テストでワンクリック切替する管理セクション。
// 切替は app_settings に保存され、gcal-sync が次回の同期からその設定を使う。
const GcalCalendarSection: React.FC = () => {
  const { isDarkMode } = useAdminPanel();
  const [mode, setMode] = useState<GcalMode | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState('');

  const bg = isDarkMode ? '#343a40' : 'white';
  const text = isDarkMode ? '#fff' : '#333';
  const subText = isDarkMode ? '#adb5bd' : '#666';
  const borderColor = isDarkMode ? '#6c757d' : '#ddd';

  useEffect(() => { fetchGcalMode().then(setMode); }, []);

  const switchTo = async (target: GcalMode) => {
    if (saving || mode === null || mode === target) return;
    setSaving(true);
    const { error } = await setGcalMode(target);
    setSaving(false);
    if (error) { setSavedMsg('⚠ 切り替えに失敗しました'); setTimeout(() => setSavedMsg(''), 3000); return; }
    setMode(target);
    setSavedMsg(target === 'production' ? '✓ 本番カレンダーに切り替えました' : '✓ テストカレンダーに切り替えました');
    setTimeout(() => setSavedMsg(''), 3000);
  };

  const options: { value: GcalMode; label: string; sub: string }[] = [
    { value: 'production', label: '本番', sub: 'ファイブM共有' },
    { value: 'test', label: 'テスト', sub: '休暇（テスト）' },
  ];

  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{
        background: '#E3F2FD', borderLeft: '3px solid #1565C0', borderRadius: '0 6px 6px 0',
        padding: '8px 12px', fontSize: 13, fontWeight: 500, color: '#0D47A1', marginBottom: 8,
      }}>
        🗓 勤怠カレンダーの連携先
      </div>

      <div style={{ background: bg, border: `0.5px solid ${borderColor}`, borderRadius: 12, padding: '14px 16px' }}>
        <div style={{ fontSize: 12, color: subText, lineHeight: 1.7, marginBottom: 12 }}>
          休暇・欠勤を書き込む Google カレンダーを切り替えます。<br />
          切り替えると、以降の新しい予定は選んだカレンダーに登録されます（過去の予定は移動しません）。
        </div>

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {options.map(opt => {
            const active = mode === opt.value;
            return (
              <button key={opt.value} onClick={() => switchTo(opt.value)} disabled={saving || mode === null || active}
                style={{
                  flex: 1, minWidth: 130, textAlign: 'left', padding: '10px 14px', borderRadius: 10,
                  border: `1.5px solid ${active ? '#1565C0' : borderColor}`,
                  background: active ? (isDarkMode ? '#1b3a5c' : '#e7f1fb') : 'none',
                  color: text, cursor: active || saving ? 'default' : 'pointer',
                }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 14, fontWeight: 700 }}>
                  {active && <span style={{ color: '#1565C0' }}>●</span>}
                  {opt.label}
                  {active && <span style={{ fontSize: 11, color: '#1565C0', fontWeight: 700 }}>（現在）</span>}
                </div>
                <div style={{ fontSize: 11, color: subText, marginTop: 2 }}>{opt.sub}</div>
              </button>
            );
          })}
        </div>

        <div style={{ marginTop: 10, minHeight: 18 }}>
          {mode === null ? (
            <span style={{ fontSize: 12, color: subText }}>読み込み中...</span>
          ) : saving ? (
            <span style={{ fontSize: 12, color: subText }}>切り替え中...</span>
          ) : savedMsg ? (
            <span style={{ fontSize: 12, color: savedMsg.startsWith('⚠') ? '#dc3545' : '#28a745', fontWeight: 600 }}>{savedMsg}</span>
          ) : (
            <span style={{ fontSize: 11, color: subText }}>もう一方のボタンを押すとすぐ切り替わります。</span>
          )}
        </div>
      </div>
    </div>
  );
};

export default GcalCalendarSection;

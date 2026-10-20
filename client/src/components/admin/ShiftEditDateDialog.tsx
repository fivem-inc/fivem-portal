import React, { useState } from 'react';
import { backBtn, primaryBtn, TOGGLE_BLUE } from '../../lib/buttonStyles';
import { ShiftDialogFrame } from './ShiftCellDialog';
import { mdWithWeekday } from '../../lib/shiftRoster';

// 「いつから変えますか？」の窓（2026-10-20 ユーザー確定・docs/計画-シフト表の変え方.md）。
// ［今日］［明日］［来月1日］＋日付を選ぶ。過ぎた日を選んだら窓の中で先に知らせる（保存のときの確かめと同じ内容）
// 🚨 日付は 'YYYY-MM-DD' の文字列のまま計算する（toISOString の日本時間ずれを踏まない）

const pad = (n: number) => String(n).padStart(2, '0');
function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}
function firstOfNextMonth(date: string): string {
  const [y, m] = date.split('-').map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${pad(m + 1)}-01`;
}
const ShiftEditDateDialog: React.FC<{
  isDarkMode: boolean;
  today: string;
  initial: string;
  onCancel: () => void;
  onNext: (date: string) => void;
}> = ({ isDarkMode, today, initial, onCancel, onNext }) => {
  const [date, setDate] = useState(initial);
  const borderColor = isDarkMode ? '#495057' : '#dee2e6';
  const text = isDarkMode ? '#f8f9fa' : '#212529';
  const quick = [
    { label: '今日', value: today },
    { label: '明日', value: addDays(today, 1) },
    { label: '来月1日', value: firstOfNextMonth(today) },
  ];
  const onKeyDown = React.useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
  }, [onCancel]);
  return (
    <ShiftDialogFrame isDarkMode={isDarkMode} width={460} labelledBy="shift-date-heading" onKeyDown={onKeyDown}
      footer={(
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" style={{ ...backBtn(isDarkMode), flex: 1 }} onClick={onCancel}>やめる</button>
          <button type="button" style={{ ...primaryBtn({ disabled: !date }), flex: 2 }} disabled={!date} onClick={() => onNext(date)}>次へ</button>
        </div>
      )}>
      <div id="shift-date-heading" style={{ fontSize: 15, fontWeight: 'bold', marginBottom: 10 }}>いつから変えますか？</div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
        {quick.map(q => (
          <button key={q.label} type="button" onClick={() => setDate(q.value)}
            style={{
              padding: '6px 12px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13,
              fontWeight: date === q.value ? 'bold' : 'normal',
              background: date === q.value ? TOGGLE_BLUE : (isDarkMode ? '#495057' : '#e9ecef'), color: date === q.value ? '#fff' : text,
            }}>
            {q.label} {mdWithWeekday(q.value)}
          </button>
        ))}
      </div>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <span style={{ color: isDarkMode ? '#adb5bd' : '#6c757d' }}>日付を選ぶ</span>
        <input type="date" value={date} onChange={e => setDate(e.target.value)}
          style={{ padding: '5px 7px', borderRadius: 6, border: `1px solid ${borderColor}`, background: isDarkMode ? '#495057' : '#fff', color: text, fontSize: 13 }} />
      </label>
      {date && date < today && (
        <div style={{ marginTop: 10, padding: '8px 12px', borderRadius: 8, background: '#fff3cd', border: '1px solid #ffc107', color: '#856404', fontSize: 13 }}>
          {mdWithWeekday(date)}はもう過ぎています。保存すると、過ぎた日のシフトも書き換わります。
        </div>
      )}
    </ShiftDialogFrame>
  );
};

export default ShiftEditDateDialog;

import React, { useState } from 'react';

// タップで開閉する日付フィールド（スマホで1タップ確定・OSのピッカーを出さない）。
// 🚨 2026-09-09 に OvertimeProposalSheet から切り出した共通部品。
//    申請の依頼シートでも同じものが要るため、写して2つ目を作らないこと。
//    （このリポジトリでは「同じ入力欄を作り直して検索が抜ける」事故が何度も起きている）

// ISO日付 → "2026/07/27（月）"
const jpDate = (iso: string): string => {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  const dow = ['日', '月', '火', '水', '木', '金', '土'][new Date(iso + 'T00:00:00').getDay()];
  return `${y}/${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}（${dow}）`;
};

export const DateField: React.FC<{ value: string; onChange: (d: string) => void; isDark: boolean; placeholder?: string }> = ({ value, onChange, isDark, placeholder }) => {
  const [open, setOpen] = useState(false);
  const base = value ? new Date(value + 'T00:00:00') : new Date();
  const [vy, setVy] = useState(base.getFullYear());
  const [vm, setVm] = useState(base.getMonth());
  const text = isDark ? '#f8f9fa' : '#212529';
  const sub = isDark ? '#adb5bd' : '#6c757d';
  const border = isDark ? '#495057' : '#dee2e6';
  const inputBg = isDark ? '#2b3035' : '#fff';
  const fmt = (y: number, m: number, d: number) => `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const daysInMonth = new Date(vy, vm + 1, 0).getDate();
  const firstDay = new Date(vy, vm, 1).getDay();
  const t = new Date(); const todayStr = fmt(t.getFullYear(), t.getMonth(), t.getDate());
  const cells: (number | null)[] = [...Array(firstDay).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => i + 1)];
  const prev = () => { if (vm === 0) { setVy(y => y - 1); setVm(11); } else setVm(m => m - 1); };
  const next = () => { if (vm === 11) { setVy(y => y + 1); setVm(0); } else setVm(m => m + 1); };
  return (
    <div>
      <button type="button" onClick={() => setOpen(o => !o)} style={{ width: '100%', textAlign: 'left', padding: '9px 12px', borderRadius: 8, border: `1px solid ${border}`, background: inputBg, color: value ? text : sub, fontSize: 14, cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>{value ? jpDate(value) : (placeholder ?? '日付を選ぶ')}</span>
        <span style={{ fontSize: 12, color: sub }}>{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div style={{ background: isDark ? '#495057' : '#f8f9fa', borderRadius: 10, padding: 12, border: `1px solid ${border}`, marginTop: 6 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <button type="button" onClick={prev} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: text, padding: '0 10px', lineHeight: 1 }}>‹</button>
            <span style={{ fontWeight: 'bold', color: text, fontSize: 15 }}>{vy}年 {vm + 1}月</span>
            <button type="button" onClick={next} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: text, padding: '0 10px', lineHeight: 1 }}>›</button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2, marginBottom: 4 }}>
            {['日', '月', '火', '水', '木', '金', '土'].map((d, i) => (<div key={d} style={{ textAlign: 'center', fontSize: 11, fontWeight: 'bold', color: i === 0 ? '#e74c3c' : i === 6 ? '#3498db' : text, padding: '3px 0' }}>{d}</div>))}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2 }}>
            {cells.map((day, i) => {
              if (!day) return <div key={`e-${i}`} />;
              const iso = fmt(vy, vm, day);
              const sel = iso === value; const isT = iso === todayStr;
              const dow = (firstDay + day - 1) % 7;
              return (
                <button key={iso} type="button" onClick={() => { onChange(iso); setOpen(false); }}
                  style={{ padding: '10px 2px', minHeight: 40, borderRadius: 6, border: isT ? '2px solid #007bff' : '1px solid transparent', background: sel ? '#28a745' : 'transparent', color: sel ? '#fff' : dow === 0 ? '#e74c3c' : dow === 6 ? '#3498db' : text, cursor: 'pointer', fontSize: 13, fontWeight: sel ? 'bold' : 'normal', textAlign: 'center' }}>
                  {day}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};

export default DateField;

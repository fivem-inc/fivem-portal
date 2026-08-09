import React, { useState, useEffect, useRef } from 'react';

const SearchableSelect: React.FC<{
  value: string;
  options: [string, string][];
  allLabel?: string;
  onChange: (v: string) => void;
  isDarkMode: boolean;
}> = ({ value, options, allLabel = '全員', onChange, isDarkMode }) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const currentLabel = value === 'all' ? allLabel : (options.find(([id]) => id === value)?.[1] ?? allLabel);
  const filtered = query ? options.filter(([, name]) => name.includes(query)) : options;

  useEffect(() => {
    const handler = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  useEffect(() => { if (open) { setQuery(''); setTimeout(() => inputRef.current?.focus(), 0); } }, [open]);

  const bg = isDarkMode ? '#495057' : '#fff';
  const border = isDarkMode ? '#6c757d' : '#ccc';
  const textColor = isDarkMode ? '#fff' : '#333';
  const dropBg = isDarkMode ? '#343a40' : '#fff';
  const hoverBg = isDarkMode ? '#495057' : '#f0f4ff';

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
      <div onClick={() => setOpen(o => !o)}
        style={{ padding: '5px 28px 5px 10px', borderRadius: 8, border: `1px solid ${border}`, background: bg, color: textColor, fontSize: 12, cursor: 'pointer', minWidth: 120, position: 'relative', userSelect: 'none' }}>
        {currentLabel}
        <span style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', fontSize: 10, color: textColor }}>▼</span>
      </div>
      {open && (
        <div style={{ position: 'absolute', top: '100%', left: 0, zIndex: 1000, background: dropBg, border: `1px solid ${border}`, borderRadius: 8, boxShadow: '0 4px 12px rgba(0,0,0,0.15)', minWidth: 180, marginTop: 2 }}>
          <div style={{ padding: '6px 8px', borderBottom: `1px solid ${border}` }}>
            {/* 🚨 fontSize は 16 未満にしない。iPhoneは16px未満の入力欄にフォーカスすると
                   画面を勝手に拡大してしまい、一覧が読めなくなる */}
            <input ref={inputRef} value={query} onChange={e => setQuery(e.target.value)} placeholder="名前で検索..."
              style={{ width: '100%', padding: '5px 8px', borderRadius: 6, border: `1px solid ${border}`, background: bg, color: textColor, fontSize: 16, boxSizing: 'border-box' }} />
          </div>
          <div style={{ maxHeight: 200, overflowY: 'auto' }}>
            <div onClick={() => { onChange('all'); setOpen(false); }}
              style={{ padding: '7px 12px', fontSize: 12, cursor: 'pointer', background: value === 'all' ? '#007bff' : 'transparent', color: value === 'all' ? '#fff' : textColor }}
              onMouseEnter={e => { if (value !== 'all') (e.currentTarget as HTMLDivElement).style.background = hoverBg; }}
              onMouseLeave={e => { if (value !== 'all') (e.currentTarget as HTMLDivElement).style.background = 'transparent'; }}>
              {allLabel}
            </div>
            {filtered.map(([id, name]) => (
              <div key={id} onClick={() => { onChange(id); setOpen(false); }}
                style={{ padding: '7px 12px', fontSize: 12, cursor: 'pointer', background: value === id ? '#007bff' : 'transparent', color: value === id ? '#fff' : textColor }}
                onMouseEnter={e => { if (value !== id) (e.currentTarget as HTMLDivElement).style.background = hoverBg; }}
                onMouseLeave={e => { if (value !== id) (e.currentTarget as HTMLDivElement).style.background = 'transparent'; }}>
                {name}
              </div>
            ))}
            {filtered.length === 0 && <div style={{ padding: '7px 12px', fontSize: 12, color: isDarkMode ? '#adb5bd' : '#888' }}>見つかりません</div>}
          </div>
        </div>
      )}
    </div>
  );
};

export default SearchableSelect;

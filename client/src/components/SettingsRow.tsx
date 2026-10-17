// 「設定」のページ（pages/AccountSettings.tsx）の行とまとまり（2026-10-17 ユーザー確定）
//
// 🚨 どの行も「絵文字（左）＋名前と小さな説明（左寄せ・横並び）＋右に今の状態 › 」の同じ形。押すとその行だけが開く（開けるのは1度に1つ）
// 🚨 ページ全体に中央寄せがかかっているので、ここで必ず左寄せにする（前は緊急連絡先などが中央に寄っていた）
// 🚨 行は全部この部品を使う（同じ見た目を書き写さない）

import React from 'react';

export interface SettingsColors { text: string; sub: string; border: string; card: string }

/** まとまり（小さな見出し＋角丸の枠）。中の行が1つも無ければ何も出さない */
export const SettingsGroup: React.FC<{ label: string; colors: SettingsColors; children: React.ReactNode }> = ({ label, colors, children }) => {
  const rows = React.Children.toArray(children).filter(Boolean);
  if (rows.length === 0) return null;
  return (
    <div style={{ textAlign: 'left' }}>
      <div style={{ fontSize: 12, color: colors.sub, margin: '18px 6px 6px' }}>{label}</div>
      <div style={{ background: colors.card, borderRadius: 16, overflow: 'hidden', boxShadow: '0 2px 12px rgba(0,0,0,0.08)' }}>
        {rows.map((r, i) => (
          <div key={i} style={{ borderTop: i === 0 ? 'none' : `1px solid ${colors.border}` }}>{r}</div>
        ))}
      </div>
    </div>
  );
};

/**
 * 行1つ。onToggle を渡すと「押すと開く」行（children が中身）、onClick だけなら「押すと別の画面へ」の行。
 * 開いた中身は、名前の位置にそろえて出す
 */
export const SettingsRow: React.FC<{
  icon: React.ReactNode;
  title: string;
  sub?: string;
  value?: string;
  colors: SettingsColors;
  open?: boolean;
  onToggle?: () => void;
  onClick?: () => void;
  children?: React.ReactNode;
}> = ({ icon, title, sub, value, colors, open = false, onToggle, onClick, children }) => (
  <div style={{ textAlign: 'left' }}>
    <button type="button" onClick={onToggle ?? onClick} aria-expanded={onToggle ? open : undefined}
      style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 14, padding: '16px 20px', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', font: 'inherit' }}>
      <span aria-hidden="true" style={{ fontSize: 22, width: 32, textAlign: 'center', flexShrink: 0 }}>{icon}</span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', margin: '0 0 2px', fontSize: 15, fontWeight: 600, color: colors.text }}>{title}</span>
        {sub && <span style={{ display: 'block', fontSize: 12, color: colors.sub, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sub}</span>}
      </span>
      {value && <span style={{ fontSize: 12.5, color: colors.sub, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 130, flexShrink: 1 }}>{value}</span>}
      <span aria-hidden="true" style={{ color: colors.sub, fontSize: 18, width: 14, textAlign: 'center', flexShrink: 0 }}>{onToggle && open ? '⌄' : '›'}</span>
    </button>
    {onToggle && open && (
      <div style={{ padding: '0 20px 16px' }}>{children}</div>
    )}
  </div>
);

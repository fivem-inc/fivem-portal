import React from 'react';

// 休暇・勤務変更・残業で共通の「履歴バッジ」。
// change_kind で種別を区別し、色＋アイコン＋語の3点セットで表示する（色だけに依存しない）。
export type ChangeKind =
  | 'admin_edit' | 'resubmit' | 'rejected' | 'approved' | 'cancelled' | 'type_change';

interface KindMeta {
  label: string;
  icon: string;   // 絵文字（アイコンフォント非依存で確実に出す）
  fg: string;     // 文字色
  bg: string;     // バッジ地色（light）
  bgDark: string; // バッジ地色（dark）
  rowBg: string;  // 行の淡い地色（light）— 色覚に頼らず地の違いで識別
  rowBgDark: string;
}

// 管理者修正＝オレンジ（既存の🖊修正と統一。紫は勤務変更「代行」で使用済みのため避ける）
const META: Record<ChangeKind, KindMeta> = {
  admin_edit:  { label: '管理者が修正', icon: '🖊', fg: '#7c4d00', bg: '#ffe8cc', bgDark: '#3a2a00', rowBg: '#fff8f0', rowBgDark: '#2a1e00' },
  type_change: { label: '種別変更して受理', icon: '🖊', fg: '#7c4d00', bg: '#ffe8cc', bgDark: '#3a2a00', rowBg: '#fff8f0', rowBgDark: '#2a1e00' },
  resubmit:    { label: '本人が再提出', icon: '↩', fg: '#0c447c', bg: '#e6f1fb', bgDark: '#12304d', rowBg: '#f0f6fd', rowBgDark: '#16233a' },
  rejected:    { label: '差し戻し',     icon: '⟲', fg: '#791f1f', bg: '#fcebeb', bgDark: '#3a1414', rowBg: '#fdf1f1', rowBgDark: '#2a1414' },
  approved:    { label: '受理',         icon: '✓', fg: '#27500a', bg: '#eaf3de', bgDark: '#1b3a1e', rowBg: '#f3f8ec', rowBgDark: '#16261a' },
  cancelled:   { label: '取消',         icon: '🚫', fg: '#444441', bg: '#ececea', bgDark: '#33322f', rowBg: '#f5f5f3', rowBgDark: '#262523' },
};

export function kindMeta(kind: ChangeKind, labelOverride?: Partial<Record<ChangeKind, string>>): KindMeta {
  const base = META[kind] ?? META.admin_edit;
  const label = labelOverride?.[kind];
  return label ? { ...base, label } : base;
}

// 履歴行に置く小さなラベル（アイコン＋語＋色）。
export const HistoryBadge: React.FC<{ kind: ChangeKind; isDarkMode: boolean; labelOverride?: Partial<Record<ChangeKind, string>> }> = ({ kind, isDarkMode, labelOverride }) => {
  const m = kindMeta(kind, labelOverride);
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0,
      fontSize: 11, fontWeight: 'bold', padding: '2px 8px', borderRadius: 8,
      background: isDarkMode ? m.bgDark : m.bg, color: isDarkMode ? '#fff' : m.fg,
    }}>
      <span aria-hidden>{m.icon}</span>{m.label}
    </span>
  );
};

// 差分値の表示整形。null/空・配列（日付リスト等）をユーザー向けに整える。
export function formatDiffValue(v: unknown): string {
  if (v === null || v === undefined || v === '') return '(空)';
  if (Array.isArray(v)) return v.length === 0 ? '(なし)' : v.join('・');
  return String(v);
}

// changes JSON（{field:{old,new}}）を「項目：旧→新」の並びで描画する共通ブロック。
export const DiffList: React.FC<{
  changes: Record<string, { old: unknown; new: unknown }>;
  fieldLabels: Record<string, string>;
  isDarkMode: boolean;
}> = ({ changes, fieldLabels, isDarkMode }) => (
  <>
    {Object.entries(changes || {}).map(([field, diff]) => (
      <div key={field} style={{ fontSize: 12, color: isDarkMode ? '#eee' : '#333', marginTop: 2 }}>
        <span style={{ fontWeight: 'bold' }}>{fieldLabels[field] ?? field}</span>：
        <span style={{ color: isDarkMode ? '#f0999b' : '#a32d2d' }}>{formatDiffValue(diff.old)}</span>
        {' → '}
        <span style={{ color: isDarkMode ? '#97c459' : '#3b6d11' }}>{formatDiffValue(diff.new)}</span>
      </div>
    ))}
  </>
);

// 表の行を押したときの薄い色（2026-10-21 ユーザー指示：給与の確認中に、どの行を見ているか分かるように）。
// 残業の受理済み一覧と［表で見る］で共用。色が付くのは1行だけ。同じ行をもう一度押すと消える。
// 🚨 ボタン・入力欄・リンクを押したときは色を変えない（操作のついでに色が動くと紛らわしい）
import type React from 'react';

export const pickedRowBg = (isDark: boolean): string => (isDark ? '#1f3550' : '#eaf3fd');

export function onRowPick(e: React.MouseEvent, id: string, current: string | null, set: (v: string | null) => void): void {
  const t = e.target as HTMLElement | null;
  if (t?.closest('button, a, input, select, textarea, label, summary')) return;
  set(current === id ? null : id);
}

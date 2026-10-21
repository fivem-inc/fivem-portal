// シフトの表に出していない方（休職中）の灰色の1行（2026-10-21・段6・ユーザー確定）
// 🚨 シフト管理の表（マネージャー以上と管理者だけが開く）でだけ使う。印刷・Excel には出さない（画面だけ）
import React from 'react';

const LeaveHiddenLine: React.FC<{ isDark: boolean; labels: string[] }> = ({ isDark, labels }) => {
  if (labels.length === 0) return null;
  return (
    <div style={{ fontSize: 12.5, color: isDark ? '#adb5bd' : '#6c757d', margin: '0 0 8px', lineHeight: 1.6 }}>
      表に出していない方（休職中）：{labels.join('／')}
    </div>
  );
};

export default LeaveHiddenLine;

import React from 'react';
import { usePendingSubmits } from '../hooks/usePendingSubmits';
import { sendUnstableOnceText } from '../lib/netFailure';

/**
 * 申請の画面の上に出す黄色い1行（2026-10-21 電波 段4・ユーザー確定 案1）。
 * 文は送信に失敗したときと同じ sendUnstableOnceText（言い回しをそろえる）。何の申請かを太字で添える。
 * 🚨 画面の中で送信して「分からない」になったときは、その画面がすでに同じ文を出しているので hidden で消す（2回出さない）
 */
const PendingSubmitLine: React.FC<{
  userId: string | undefined;
  match: (slot: string) => boolean;
  /** もう一度押してもらうボタンの名前（例 '申請する'） */
  button: string;
  hidden?: boolean;
  style?: React.CSSProperties;
}> = ({ userId, match, button, hidden, style }) => {
  const list = usePendingSubmits(userId, match);
  if (hidden || list.length === 0) return null;
  return (
    <div style={{ margin: '0 0 12px', fontSize: 13, lineHeight: 1.6, color: '#856404', background: '#fff3cd', border: '1px solid #ffc107', borderRadius: 6, padding: '8px 12px', ...style }}>
      <div style={{ fontWeight: 'bold' }}>{list.map(p => p.label).join('・')}</div>
      {sendUnstableOnceText(button)}
    </div>
  );
};

export default PendingSubmitLine;

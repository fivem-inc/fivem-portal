import React from 'react';
import { useNavigate } from 'react-router-dom';
import { usePendingSubmits } from '../hooks/usePendingSubmits';
import { pendingSubmitsTitle, PENDING_SUBMITS_NOTE } from '../lib/netFailure';
import { BTN_BLUE } from '../lib/buttonStyles';

/**
 * ホームの「送信できたか確認できていない申請が◯件あります」（2026-10-21 電波 段4・ユーザー確定 案A・案1・案X）。
 * 🚨 ここでは送らない・確かめない。［◯◯を開く］で元の画面へ移り、本人がもう一度押す
 *    （届いていたときの上長へのお知らせは、元の画面が1回だけ送る）
 */
const PendingSubmitsCard: React.FC<{ userId: string }> = ({ userId }) => {
  const list = usePendingSubmits(userId);
  const navigate = useNavigate();
  if (list.length === 0) return null;
  return (
    <div style={{ margin: '0 0 16px 0', padding: '12px 16px', background: '#fff3cd', border: '1px solid #ffc107', borderRadius: 10, color: '#856404' }}>
      <div style={{ fontSize: 15, fontWeight: 'bold', marginBottom: 6 }}>{pendingSubmitsTitle(list.length)}</div>
      {list.map(p => (
        <div key={p.slot} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderTop: '1px solid #ffe08a', fontSize: 14 }}>
          <span style={{ flex: 1, minWidth: 0 }}>{p.label}</span>
          <button type="button" onClick={() => navigate(p.path)}
            style={{ flexShrink: 0, padding: '6px 12px', borderRadius: 6, border: 'none', background: BTN_BLUE, color: '#fff', fontSize: 13, fontWeight: 'bold', cursor: 'pointer' }}>
            {p.openLabel}
          </button>
        </div>
      ))}
      <div style={{ fontSize: 12.5, lineHeight: 1.6, marginTop: 6 }}>{PENDING_SUBMITS_NOTE}</div>
    </div>
  );
};

export default PendingSubmitsCard;

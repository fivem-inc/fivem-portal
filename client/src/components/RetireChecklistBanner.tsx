// ホームの案内「入社・退職の手続きが残っています」（2026-09-19 退職・2026-10-06 入社を足して1枚に）。マネージャー以上と管理者だけ
//
// 🚨 マネージャー以上でない人（約40名）には問い合わせを1本も増やさない（show=false なら何も読まない）
// 🚨 必須が残っている人だけを出す。全部済めば消える（押して消せない赤いバッジにはしない）
// 🚨 対象の人と残りの数え方は lib/staffChecklist.ts の loadPendingPeople 1か所（チェック表・タブの人数と同じ）

import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { loadPendingPeople, type PendingPerson } from '../lib/staffChecklist';

const RetireChecklistBanner: React.FC<{ show: boolean; isDark: boolean }> = ({ show, isDark }) => {
  const navigate = useNavigate();
  const [hire, setHire] = useState<PendingPerson[]>([]);
  const [retire, setRetire] = useState<PendingPerson[]>([]);

  useEffect(() => {
    if (!show) { setHire([]); setRetire([]); return; }
    let alive = true;
    void Promise.all([loadPendingPeople('hire'), loadPendingPeople('retire')]).then(([h, r]) => {
      if (!alive) return;
      setHire(h);
      setRetire(r);
    });
    return () => { alive = false; };
  }, [show]);

  if (!show || (hire.length === 0 && retire.length === 0)) return null;
  const line = (rows: PendingPerson[]) => rows.map(r => `${r.name}さん 残り${r.remaining}件`).join('・');
  const title = hire.length > 0 && retire.length > 0 ? '入社・退職の手続きが残っています'
    : hire.length > 0 ? '入社の準備が残っています' : '退職の手続きが残っています';
  return (
    <button type="button" onClick={() => navigate(`/retire?kind=${hire.length > 0 ? 'hire' : 'retire'}`)}
      style={{ width: '100%', textAlign: 'left', font: 'inherit', background: isDark ? '#3d3520' : '#fff8e1', border: `1px solid ${isDark ? '#8a6d1f' : '#ffe08a'}`, borderRadius: 10, padding: '12px 16px', marginBottom: 10, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 12 }}>
      <div style={{ fontSize: 18, flexShrink: 0 }}>📋</div>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 14, fontWeight: 'bold', color: isDark ? '#ffd54f' : '#8a5a00' }}>{title}</div>
        {hire.length > 0 && (
          <div style={{ fontSize: 12, color: isDark ? '#e0c97a' : '#8a5a00', marginTop: 2 }}>
            {retire.length > 0 ? '入社：' : ''}{line(hire)}
          </div>
        )}
        {retire.length > 0 && (
          <div style={{ fontSize: 12, color: isDark ? '#e0c97a' : '#8a5a00', marginTop: 2 }}>
            {hire.length > 0 ? '退職：' : ''}{line(retire)}
          </div>
        )}
      </div>
      <div style={{ fontSize: 12, color: isDark ? '#ffd54f' : '#b35900', whiteSpace: 'nowrap', flexShrink: 0 }}>開く →</div>
    </button>
  );
};

export default RetireChecklistBanner;

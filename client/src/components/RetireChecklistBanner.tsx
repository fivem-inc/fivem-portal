// ホームの案内「手続きが残っています」（2026-09-19 退職・2026-10-06 入社・2026-10-21 休職を足して1枚に）。マネージャー以上と管理者だけ
//
// 🚨 マネージャー以上でない人（約40名）には問い合わせを1本も増やさない（show=false なら何も読まない）
// 🚨 必須が残っている人だけを出す。全部済めば消える（押して消せない赤いバッジにはしない）
// 🚨 入社・退職の対象と残りの数え方は lib/staffChecklist.ts の loadPendingPeople 1か所（チェック表・タブの人数と同じ）。
//    休職は DB の leave_checklist_overview 1本（lib/staffLeave の pendingLeaveRows・「復職するとき」は復職日の7日前から）

import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { loadPendingPeople, type PendingPerson } from '../lib/staffChecklist';
import { fetchLeaveChecklistOverview, pendingLeaveRows, LEAVE_PHASE_LABEL, type LeaveChecklistRow } from '../lib/staffLeave';

const RetireChecklistBanner: React.FC<{ show: boolean; isDark: boolean }> = ({ show, isDark }) => {
  const navigate = useNavigate();
  const [hire, setHire] = useState<PendingPerson[]>([]);
  const [retire, setRetire] = useState<PendingPerson[]>([]);
  const [leave, setLeave] = useState<LeaveChecklistRow[]>([]);

  useEffect(() => {
    if (!show) { setHire([]); setRetire([]); setLeave([]); return; }
    let alive = true;
    void Promise.all([loadPendingPeople('hire'), loadPendingPeople('retire'), fetchLeaveChecklistOverview()]).then(([h, r, lv]) => {
      if (!alive) return;
      setHire(h);
      setRetire(r);
      setLeave(pendingLeaveRows(lv));
    });
    return () => { alive = false; };
  }, [show]);

  const kinds = [hire.length > 0, retire.length > 0, leave.length > 0].filter(Boolean).length;
  if (!show || kinds === 0) return null;
  const line = (rows: PendingPerson[]) => rows.map(r => `${r.name}さん 残り${r.remaining}件`).join('・');
  const leaveLine = leave.map(r => `${r.name ?? ''}さん（${LEAVE_PHASE_LABEL[r.phase]}）残り${r.remaining}件`).join('・');
  const title = kinds > 1 ? '手続きが残っています'
    : hire.length > 0 ? '入社の準備が残っています' : retire.length > 0 ? '退職の手続きが残っています' : '休職の手続きが残っています';
  const sub = isDark ? '#e0c97a' : '#8a5a00';
  return (
    <button type="button" onClick={() => {
      // 先頭の方まで動いて光らせる（?person=・2026-10-19）
      if (hire.length > 0) navigate(`/retire?kind=hire&person=${hire[0].id}`);
      else if (retire.length > 0) navigate(`/retire?kind=retire&person=${retire[0].id}`);
      else navigate(`/retire?kind=leave&person=${leave[0].user_id}`);
    }}
      style={{ width: '100%', textAlign: 'left', font: 'inherit', background: isDark ? '#3d3520' : '#fff8e1', border: `1px solid ${isDark ? '#8a6d1f' : '#ffe08a'}`, borderRadius: 10, padding: '12px 16px', marginBottom: 10, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 12 }}>
      <div style={{ fontSize: 18, flexShrink: 0 }}>📋</div>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 14, fontWeight: 'bold', color: isDark ? '#ffd54f' : '#8a5a00' }}>{title}</div>
        {hire.length > 0 && <div style={{ fontSize: 12, color: sub, marginTop: 2 }}>{kinds > 1 ? '入社：' : ''}{line(hire)}</div>}
        {retire.length > 0 && <div style={{ fontSize: 12, color: sub, marginTop: 2 }}>{kinds > 1 ? '退職：' : ''}{line(retire)}</div>}
        {leave.length > 0 && <div style={{ fontSize: 12, color: sub, marginTop: 2 }}>{kinds > 1 ? '休職：' : ''}{leaveLine}</div>}
      </div>
      <div style={{ fontSize: 12, color: isDark ? '#ffd54f' : '#b35900', whiteSpace: 'nowrap', flexShrink: 0 }}>開く →</div>
    </button>
  );
};

export default RetireChecklistBanner;

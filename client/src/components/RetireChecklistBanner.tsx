// ホームの案内「退職の手続きが残っています」（2026-09-19・1段目）。マネージャー以上と管理者だけ
//
// 🚨 マネージャー以上でない人（約40名）には問い合わせを1本も増やさない（show=false なら何も読まない）
// 🚨 必須が残っている人だけを出す。全部済めば消える（押して消せない赤いバッジにはしない）
// 🚨 残りの数え方は lib/retire.ts の retireRemaining 1か所（チェック表と同じ）

import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient';
import { retireRemaining } from '../lib/retire';

const RetireChecklistBanner: React.FC<{ show: boolean; isDark: boolean }> = ({ show, isDark }) => {
  const navigate = useNavigate();
  const [rows, setRows] = useState<{ name: string; remaining: number }[]>([]);

  useEffect(() => {
    if (!show) { setRows([]); return; }
    let alive = true;
    (async () => {
      const pp = await supabase.from('profiles').select('id, name').not('retire_date', 'is', null);
      if (pp.error || !pp.data || pp.data.length === 0) { if (alive) setRows([]); return; }
      const ids = pp.data.map(p => p.id as string);
      const [it, ck] = await Promise.all([
        supabase.from('retire_checklist_items').select('id, required, active'),
        supabase.from('retire_checklist_checks').select('user_id, item_id').in('user_id', ids),
      ]);
      // 読めないときは出さない（案内は補助。誤って「残っています」と出さない）
      if (it.error || ck.error) { if (alive) setRows([]); return; }
      const list = pp.data
        .map(p => ({ name: (p.name as string | null) ?? '', remaining: retireRemaining(it.data ?? [], ck.data ?? [], p.id as string) }))
        .filter(r => r.remaining > 0);
      if (alive) setRows(list);
    })();
    return () => { alive = false; };
  }, [show]);

  if (!show || rows.length === 0) return null;
  const summary = rows.map(r => `${r.name}さん 残り${r.remaining}件`).join('・');
  return (
    <div onClick={() => navigate('/retire')}
      style={{ background: isDark ? '#3d3520' : '#fff8e1', border: `1px solid ${isDark ? '#8a6d1f' : '#ffe08a'}`, borderRadius: 10, padding: '12px 16px', marginBottom: 10, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 12 }}>
      <div style={{ fontSize: 18, flexShrink: 0 }}>📋</div>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 14, fontWeight: 'bold', color: isDark ? '#ffd54f' : '#8a5a00' }}>退職の手続きが残っています</div>
        <div style={{ fontSize: 12, color: isDark ? '#e0c97a' : '#8a5a00', marginTop: 2 }}>{summary}</div>
      </div>
      <div style={{ fontSize: 12, color: isDark ? '#ffd54f' : '#b35900', whiteSpace: 'nowrap', flexShrink: 0 }}>開く →</div>
    </div>
  );
};

export default RetireChecklistBanner;

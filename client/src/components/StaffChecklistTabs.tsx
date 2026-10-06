// 入社・退職の手続き（2026-10-06）。［入社］［退職］を切り替えて、同じチェック表の部品（RetireChecklistPanel）を出す。
//
// 🚨 この部品1つを「/retire（マネージャー以上・スマホ可）」と「管理画面のタブ」の両方が使う（2か所に書かない）
// 🚨 /retire では ?kind=hire|retire と URL をそろえる（お知らせから押すと入社のほうが開くように）。
//    管理画面は ?tab= を管理画面のタブに使っているので、URL は触らない（syncUrl=false）
// 🚨 タブの人数は「必須が残っている人」。赤い数字のバッジにはしない（押して消せない赤は付けない決まり）

import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PageTabs } from './PageTabs';
import RetireChecklistPanel from './RetireChecklistPanel';
import { loadPendingPeople, type ChecklistKind } from '../lib/staffChecklist';

interface Props {
  isDark: boolean;
  isAdmin: boolean;
  /** /retire のときだけ true（URL の ?kind= と合わせる） */
  syncUrl?: boolean;
}

const StaffChecklistTabs: React.FC<Props> = ({ isDark, isAdmin, syncUrl = false }) => {
  const [params, setParams] = useSearchParams();
  const fromUrl = params.get('kind');
  const [kind, setKind] = useState<ChecklistKind>(
    syncUrl && (fromUrl === 'hire' || fromUrl === 'retire') ? fromUrl : 'hire');
  const [counts, setCounts] = useState<Record<ChecklistKind, number | null>>({ hire: null, retire: null });

  // お知らせから来たとき（URL が変わったとき）に合わせる
  useEffect(() => {
    if (syncUrl && (fromUrl === 'hire' || fromUrl === 'retire')) setKind(fromUrl);
  }, [syncUrl, fromUrl]);

  // 人数は切り替えるたびに数え直す（チェック表で済みにしたあとも、切り替えれば合う）
  useEffect(() => {
    let alive = true;
    void Promise.all([loadPendingPeople('hire'), loadPendingPeople('retire')]).then(([h, r]) => {
      if (alive) setCounts({ hire: h.length, retire: r.length });
    });
    return () => { alive = false; };
  }, [kind]);

  const label = (k: ChecklistKind, base: string) => {
    const n = counts[k];
    return n ? `${base}（残り ${n}人）` : base;
  };

  return (
    <div>
      <PageTabs
        variant="boxed"
        isDark={isDark}
        inactiveColor={isDark ? '#f8f9fa' : '#212529'}
        tabs={[
          { key: 'hire' as const, label: label('hire', '入社') },
          { key: 'retire' as const, label: label('retire', '退職') },
        ]}
        active={kind}
        onChange={k => {
          setKind(k);
          if (syncUrl) {
            const next = new URLSearchParams(params);
            next.set('kind', k);
            setParams(next, { replace: true });
          }
        }}
      />
      <RetireChecklistPanel key={kind} kind={kind} isDark={isDark} isAdmin={isAdmin} />
    </div>
  );
};

export default StaffChecklistTabs;

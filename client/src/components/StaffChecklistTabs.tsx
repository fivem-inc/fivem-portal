// 入社・退職の手続き（2026-10-06）。［入社］［退職］を切り替えて、同じチェック表の部品（RetireChecklistPanel）を出す。
//
// 🚨 この部品1つを「/retire（マネージャー以上・スマホ可）」と「管理画面のタブ」の両方が使う（2か所に書かない）
// 🚨 /retire では ?kind=hire|retire と URL をそろえる（お知らせから押すと入社のほうが開くように）。
//    管理画面は ?tab= を管理画面のタブに使っているので、URL は触らない（syncUrl=false）
// 🚨 2026-10-21：3つ目のタブ「休職」（中身は LeaveChecklistPanel・休職の1回ごと・入るとき／復職するとき）
// 🚨 タブの人数は「必須が残っている人」。赤い数字のバッジにはしない（押して消せない赤は付けない決まり）

import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PageTabs } from './PageTabs';
import RetireChecklistPanel from './RetireChecklistPanel';
import LeaveChecklistPanel from './LeaveChecklistPanel';
import { fetchLeaveChecklistOverview, pendingLeaveRows } from '../lib/staffLeave';
import { loadPendingPeople, type ChecklistKind } from '../lib/staffChecklist';

interface Props {
  isDark: boolean;
  isAdmin: boolean;
  /** 項目を編集できるか（2026-10-17：マネージャー以上と管理者。省略＝isAdmin） */
  canEditItems?: boolean;
  /** /retire のときだけ true（URL の ?kind= と合わせる） */
  syncUrl?: boolean;
}

type TabKind = ChecklistKind | 'leave';

const StaffChecklistTabs: React.FC<Props> = ({ isDark, isAdmin, canEditItems, syncUrl = false }) => {
  const [params, setParams] = useSearchParams();
  const fromUrl = params.get('kind');
  // 完了のお知らせから来たとき、その方を光らせる（?person=）。/retire のときだけ
  const focusPerson = syncUrl ? params.get('person') : null;
  const isKind = (v: string | null): v is TabKind => v === 'hire' || v === 'retire' || v === 'leave';
  const [kind, setKind] = useState<TabKind>(syncUrl && isKind(fromUrl) ? fromUrl : 'hire');
  const [counts, setCounts] = useState<Record<TabKind, number | null>>({ hire: null, retire: null, leave: null });

  // お知らせから来たとき（URL が変わったとき）に合わせる
  useEffect(() => {
    if (syncUrl && isKind(fromUrl)) setKind(fromUrl);
  }, [syncUrl, fromUrl]);

  // 人数は切り替えるたびに数え直す（チェック表で済みにしたあとも、切り替えれば合う）
  useEffect(() => {
    let alive = true;
    void Promise.all([loadPendingPeople('hire'), loadPendingPeople('retire'), fetchLeaveChecklistOverview()]).then(([h, r, lv]) => {
      // 休職は「残りがある休職」の数（1つの休職で2つの段が残っていても1人）
      if (alive) setCounts({ hire: h.length, retire: r.length, leave: new Set(pendingLeaveRows(lv).map(x => x.leave_id)).size });
    });
    return () => { alive = false; };
  }, [kind]);

  const label = (k: TabKind, base: string) => {
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
          { key: 'leave' as const, label: label('leave', '休職') },
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
      {kind === 'leave' ? (
        <LeaveChecklistPanel isDark={isDark} isAdmin={isAdmin} canEditItems={canEditItems ?? isAdmin}
          focusPersonId={focusPerson && fromUrl === 'leave' ? focusPerson : null} />
      ) : (
      <RetireChecklistPanel key={kind} kind={kind} isDark={isDark} isAdmin={isAdmin} canEditItems={canEditItems ?? isAdmin}
        focusPersonId={focusPerson && fromUrl === kind ? focusPerson : null} />
      )}
    </div>
  );
};

export default StaffChecklistTabs;

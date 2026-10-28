import { useEffect, useCallback } from 'react';
import { useRefreshOn } from './useRefreshOn';
import { useStickyState } from './useStickyState';
import { TOPICS_LEAVE } from '../lib/badgeTopics';
import { supabase } from '../lib/supabaseClient';
import { attrsFor } from '../lib/roleAttrs';
import { useRoles } from './useRoles';

// 休暇申請：自分の番の受理待ち件数（LeaveApprovalBannerと同じ判定ロジック）。
// NavBarのバッジと、休暇申請ページ内「受理ページへ」ボタンのバッジの両方から使う共通フック。
// 🚨 役職名では判定しない（2026-09-09 属性化）。リーダー以上＝is_leader_plus／最終受理＝立場 president
export const useLeavePendingCount = (userId: string | undefined, roleTitle: string | undefined, isAdmin: boolean) => {
  const roles = useRoles();
  const attrs = attrsFor(roles, roleTitle);
  const isLeaderPlus = attrs.is_leader_plus;
  const isPresident = attrs.acts_as === 'president';
  const key = `leave:${userId}:${isAdmin}:${isLeaderPlus}:${isPresident}`;
  const [pendingCount, setPendingCount] = useStickyState(key, 0);

  const fetchPending = useCallback(async () => {
    if (!userId) { setPendingCount(0); return; }
    if (!isAdmin && !isLeaderPlus) { setPendingCount(0); return; }

    // 🚨 3つの条件を1本の問い合わせに（2026-10-28 ログの量の見直し・前は1つの数字のために3本読んでいた）。条件は status で分かれるので重ならない
    const conds = [`and(status.eq.pending,approver_id.eq.${userId})`, `and(status.eq.step2_pending,approver2_id.eq.${userId})`];
    if (isPresident) conds.push('status.eq.admin_approved');
    const { data, error } = await supabase.from('leave_requests').select('id').or(conds.join(','));
    if (error) return;   // 読めなかったときは前の数字のまま（0 に戻さない）
    setPendingCount(data?.length ?? 0);
  }, [userId, isAdmin, isLeaderPlus, isPresident, setPendingCount]);

  // 🚨 30 秒ごとをやめ、通知の表にこの話題の新しい行が来たとき・ページを出入りしたときだけ数え直す（2026-09-27・通信量の見直し 段2・hooks/useRefreshOn.ts）
  // 🚨 key（2026-10-18）：同じ人・同じ条件なら、ページを移っても10分は読み直さない（自分が書き込んだらすぐ読む・hooks/useRefreshOn）
  useRefreshOn(fetchPending, TOPICS_LEAVE, key);
  useEffect(() => {
    window.addEventListener('leave-pending-changed', fetchPending);
    return () => window.removeEventListener('leave-pending-changed', fetchPending);
  }, [fetchPending]);
  return { pendingCount };
};

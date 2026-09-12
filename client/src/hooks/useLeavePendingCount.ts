import { useState, useEffect, useCallback } from 'react';
import { usePolling } from './usePolling';
import { supabase } from '../lib/supabaseClient';
import { attrsFor } from '../lib/roleAttrs';
import { useRoles } from './useRoles';

// 休暇申請：自分の番の受理待ち件数（LeaveApprovalBannerと同じ判定ロジック）。
// NavBarのバッジと、休暇申請ページ内「受理ページへ」ボタンのバッジの両方から使う共通フック。
// 🚨 役職名では判定しない（2026-09-09 属性化）。リーダー以上＝is_leader_plus／最終受理＝立場 president
export const useLeavePendingCount = (userId: string | undefined, roleTitle: string | undefined, isAdmin: boolean) => {
  const [pendingCount, setPendingCount] = useState(0);
  const roles = useRoles();
  const attrs = attrsFor(roles, roleTitle);
  const isLeaderPlus = attrs.is_leader_plus;
  const isPresident = attrs.acts_as === 'president';

  const fetchPending = useCallback(async () => {
    if (!userId) { setPendingCount(0); return; }
    if (!isAdmin && !isLeaderPlus) { setPendingCount(0); return; }

    const { data: d1 } = await supabase.from('leave_requests').select('id').eq('status', 'pending').eq('approver_id', userId);
    const { data: d2 } = await supabase.from('leave_requests').select('id').eq('status', 'step2_pending').eq('approver2_id', userId);
    const { data: d3 } = isPresident
      ? await supabase.from('leave_requests').select('id').eq('status', 'admin_approved')
      : { data: [] };
    setPendingCount((d1?.length ?? 0) + (d2?.length ?? 0) + (d3?.length ?? 0));
  }, [userId, isAdmin, isLeaderPlus, isPresident]);

  // 🚨 画面を見ていない間は止まり、戻った瞬間に1回読み直す（hooks/usePolling.ts）
  usePolling(fetchPending);
  useEffect(() => {
    window.addEventListener('leave-pending-changed', fetchPending);
    return () => window.removeEventListener('leave-pending-changed', fetchPending);
  }, [fetchPending]);
  return { pendingCount };
};

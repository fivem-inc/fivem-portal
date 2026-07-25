import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabaseClient';

// 休暇申請：自分の番の受理待ち件数（LeaveApprovalBannerと同じ判定ロジック）。
// NavBarのバッジと、休暇申請ページ内「受理ページへ」ボタンのバッジの両方から使う共通フック。
export const useLeavePendingCount = (userId: string | undefined, roleTitle: string | undefined, isAdmin: boolean) => {
  const [pendingCount, setPendingCount] = useState(0);

  const fetchPending = useCallback(async () => {
    if (!userId) { setPendingCount(0); return; }
    if (!isAdmin && !['リーダー', 'マネージャー', '社長', '管理者'].includes(roleTitle ?? '')) { setPendingCount(0); return; }

    const { data: d1 } = await supabase.from('leave_requests').select('id').eq('status', 'pending').eq('approver_id', userId);
    const { data: d2 } = await supabase.from('leave_requests').select('id').eq('status', 'step2_pending').eq('approver2_id', userId);
    const { data: d3 } = roleTitle === '社長'
      ? await supabase.from('leave_requests').select('id').eq('status', 'admin_approved')
      : { data: [] };
    setPendingCount((d1?.length ?? 0) + (d2?.length ?? 0) + (d3?.length ?? 0));
  }, [userId, roleTitle, isAdmin]);

  useEffect(() => { fetchPending(); const t = setInterval(fetchPending, 30000); return () => clearInterval(t); }, [fetchPending]);
  useEffect(() => {
    window.addEventListener('leave-pending-changed', fetchPending);
    return () => window.removeEventListener('leave-pending-changed', fetchPending);
  }, [fetchPending]);
  return { pendingCount };
};

import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabaseClient';

// 備品購入申請：自分の回答・承認を待っている件数
//
// ナビバーの赤バッジ・ホームの承認依頼バナー・購入申請ページの「✅ 承認」タブのバッジで共用する。
// （App.tsx に置いたままだとページ側から使えないため、useLeavePendingCount と同じく hooks に切り出した）
//
// 数え方
//   ・リーダー承認ルート：自分が leader_id で status=pending_leader のもの
//   ・マネージャー／全員承認ルート：自分が承認者に入っていて、
//     いまの approval_round で自分がまだ意見を出していないもの
//     （他の人が未回答でも、自分が答えていれば自分の「やること」ではないので数えない）
//
// 承認・差し戻し・意見送信の直後は 'purchase-pending-changed' イベントで即時に数え直す
export const usePurchasePendingCount = (userId: string | undefined, canPurchaseRequest: boolean | undefined) => {
  const [pendingCount, setPendingCount] = useState(0);

  const fetchPending = useCallback(async () => {
    if (!userId || !canPurchaseRequest) { setPendingCount(0); return; }

    const [leaderRes, managerRes, boardRes] = await Promise.all([
      supabase.from('purchase_requests').select('id').eq('leader_id', userId).eq('status', 'pending_leader'),
      supabase.from('purchase_requests').select('id, approval_round').contains('requested_manager_ids', [userId]).eq('status', 'pending_manager'),
      supabase.from('purchase_requests').select('id, approval_round').contains('board_approver_ids', [userId]).eq('status', 'pending_board'),
    ]);
    const opinionTargets = [...(managerRes.data ?? []), ...(boardRes.data ?? [])] as { id: string; approval_round: number }[];

    let answeredCount = 0;
    if (opinionTargets.length > 0) {
      const { data: ops } = await supabase
        .from('purchase_request_manager_opinions')
        .select('purchase_request_id, approval_round')
        .eq('manager_id', userId)
        .in('purchase_request_id', opinionTargets.map(t => t.id));
      const roundById: Record<string, number> = {};
      opinionTargets.forEach(t => { roundById[t.id] = t.approval_round; });
      const answeredIds = new Set((ops ?? []).filter(o => o.approval_round === roundById[o.purchase_request_id]).map(o => o.purchase_request_id));
      answeredCount = opinionTargets.filter(t => answeredIds.has(t.id)).length;
    }

    setPendingCount((leaderRes.data?.length ?? 0) + opinionTargets.length - answeredCount);
  }, [userId, canPurchaseRequest]);

  // 30秒ごとに数え直す（休暇・勤務変更のバッジと同じ。他の人が先に処理したときも減る）
  useEffect(() => { fetchPending(); const t = setInterval(fetchPending, 30000); return () => clearInterval(t); }, [fetchPending]);
  useEffect(() => {
    window.addEventListener('purchase-pending-changed', fetchPending);
    return () => window.removeEventListener('purchase-pending-changed', fetchPending);
  }, [fetchPending]);

  return { pendingCount, refetch: fetchPending };
};

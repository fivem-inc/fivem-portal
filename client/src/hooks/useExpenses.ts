import { useState, useEffect, useCallback } from 'react';
import type { Submission, PendingApproval, AuthUser } from '../types';
import { supabase } from '../lib/supabaseClient';

interface UseExpensesReturn {
  submissions: Submission[];
  pendingApprovals: PendingApproval[];
  isLoading: boolean;
  fetchExpenses: () => Promise<void>;
}

export const useExpenses = (user: AuthUser | null, isAdmin: boolean): UseExpensesReturn => {
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [pendingApprovals, setPendingApprovals] = useState<PendingApproval[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchExpenses = useCallback(async () => {
    if (!user) return;

    setIsLoading(true);
    let expensesToSet: Submission[] = [];
    let pendingApprovalsToSet: PendingApproval[] = [];

    try {
      if (isAdmin) {
        // 管理者の場合、すべての申請履歴と承認待ち一覧を取得
        const { data: allData, error: allError } = await supabase
          .from('expenses')
          .select('*, profiles!user_id(name, email)')
          .order('created_at', { ascending: false });

        if (allError) {
          console.error('Error fetching all expenses:', allError);
        } else {
          expensesToSet = allData || [];
          pendingApprovalsToSet = allData?.filter(s => s.status === 'pending') || [];
        }
      } else {
        // 一般ユーザーの場合、自分の申請履歴のみを取得
        const { data: myData, error: myError } = await supabase
          .from('expenses')
          .select('*, profiles!user_id(name, email)')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false });

        if (myError) {
          console.error('Error fetching your expenses:', myError);
        } else {
          expensesToSet = myData || [];
          
          // 一般ユーザーの場合、新しく却下された申請をチェック
          const recentlyRejected = myData?.filter(submission => {
            if (submission.status !== 'rejected' || !submission.rejected_at) return false;
            
            const rejectedDate = new Date(submission.rejected_at);
            const lastCheckKey = `lastRejectionCheck_${user.id}`;
            const lastCheck = localStorage.getItem(lastCheckKey);
            
            if (!lastCheck) {
              // 初回アクセスの場合、現在時刻を保存して通知なし
              localStorage.setItem(lastCheckKey, new Date().toISOString());
              return false;
            }
            
            const lastCheckDate = new Date(lastCheck);
            return rejectedDate > lastCheckDate;
          }) || [];
          
          // 新しく却下された申請がある場合、通知を表示
          if (recentlyRejected.length > 0) {
            const messages = recentlyRejected.map(submission => {
              const rejectedDate = new Date(submission.rejected_at!).toLocaleDateString('ja-JP');
              const reason = submission.rejected_reason || '理由なし';
              return `申請日: ${new Date(submission.created_at).toLocaleDateString('ja-JP')}\n却下日: ${rejectedDate}\n却下理由: ${reason}`;
            });
            
            alert(`交通費申請が却下されました\n\n${messages.join('\n\n---\n\n')}\n\n詳細は申請履歴で確認できます。`);
            
            // チェック時刻を更新
            const lastCheckKey = `lastRejectionCheck_${user.id}`;
            localStorage.setItem(lastCheckKey, new Date().toISOString());
          }
        }
      }
    } catch (error) {
      console.error('Unexpected error fetching expenses:', error);
    } finally {
      setSubmissions(expensesToSet);
      setPendingApprovals(pendingApprovalsToSet);
      setIsLoading(false);
    }
  }, [user, isAdmin]);

  useEffect(() => {
    fetchExpenses();
  }, [fetchExpenses]);

  return {
    submissions,
    pendingApprovals,
    isLoading,
    fetchExpenses
  };
};
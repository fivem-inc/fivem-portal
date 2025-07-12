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
          .select('*, profiles(name, email)')
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
          .select('*, profiles(name, email)')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false });

        if (myError) {
          console.error('Error fetching your expenses:', myError);
        } else {
          expensesToSet = myData || [];
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
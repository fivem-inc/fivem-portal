import { useState, useEffect, useCallback } from 'react';
import type { Submission, PendingApproval, AuthUser } from '../types';
import { supabase } from '../lib/supabaseClient';
import { isNetworkFailure, timeoutSignal } from '../lib/netFailure';
import { saveCopy, loadCopy } from '../lib/offlineCopy';

interface UseExpensesReturn {
  submissions: Submission[];
  pendingApprovals: PendingApproval[];
  isLoading: boolean;
  /** 直近の読み込みに失敗したか（2026-10-20・電波 段2）。🚨 失敗したときは前の一覧を消さない（空にすると「消えた」と思って出し直す） */
  loadFailed: boolean;
  fetchExpenses: () => Promise<void>;
  rejectionNotice: string | null;      // 却下通知（alert廃止・消費側でトースト表示）
  clearRejectionNotice: () => void;
}

export const useExpenses = (user: AuthUser | null, isAdmin: boolean): UseExpensesReturn => {
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [pendingApprovals, setPendingApprovals] = useState<PendingApproval[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [rejectionNotice, setRejectionNotice] = useState<string | null>(null);

  const fetchExpenses = useCallback(async () => {
    if (!user) return;

    setIsLoading(true);
    let expensesToSet: Submission[] = [];
    let pendingApprovalsToSet: PendingApproval[] = [];
    let failed = false;
    // 本人の履歴が通信のせいで読めなかったか（このときだけ端末の控えを出す・電波 段6）
    let netFailedOwn = false;

    try {
      if (isAdmin) {
        // 管理者の場合、すべての申請履歴と承認待ち一覧を取得
        const { data: allData, error: allError } = await supabase
          .from('expenses')
          // 🚨 is_active / retiree_access_until は、退職して申請期間中の方を却下するときの
          //    注意書き（retireeReturnNote）に要る。読むのは管理者のときだけ
          .select('*, profiles!user_id(name, email, is_active, retiree_access_until)')
          .order('created_at', { ascending: false });

        if (allError) {
          console.error('Error fetching all expenses:', allError);
          failed = true;
        } else {
          expensesToSet = allData || [];
          pendingApprovalsToSet = allData?.filter(s => s.status === 'pending') || [];
        }
      } else {
        // 一般ユーザーの場合、自分の申請履歴のみを取得
        const { data: myData, error: myError } = await supabase
          .from('expenses')
          // 🚨 email は退職者に許していない列。埋め込みに混ぜると 42501 でクエリごと落ち、
          //    交通費の履歴が1件も出なくなる（＝ホームが空になる）。本人のぶんに email は要らない
          .select('*, profiles!user_id(name)')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false })
          // 電波が弱いと応答が返らず空のまま待ち続けるので、10秒で打ち切って端末の控えに切り替える（電波 段6）
          .abortSignal(timeoutSignal(10000));

        if (myError) {
          console.error('Error fetching your expenses:', myError);
          failed = true;
          netFailedOwn = isNetworkFailure(myError);
        } else {
          expensesToSet = myData || [];
          // 端末の控え（スマホ・タブレットだけ・lib/offlineCopy）：本人の分だけ・新しい順に100件まで。🚨 管理者の全員分は控えない
          void saveCopy(user.id, 'expense_own', expensesToSet.slice(0, 100));
          
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
            
            setRejectionNotice(`交通費申請が却下されました\n\n${messages.join('\n\n---\n\n')}\n\n詳細は申請履歴で確認できます。`);
            
            // チェック時刻を更新
            const lastCheckKey = `lastRejectionCheck_${user.id}`;
            localStorage.setItem(lastCheckKey, new Date().toISOString());
          }
        }
      }
    } catch (error) {
      console.error('Unexpected error fetching expenses:', error);
      failed = true;
    } finally {
      // 通信のせいで本人の履歴が読めなかったら、端末の控えを出す（前の一覧が出ていればそれを優先）
      if (failed && netFailedOwn) {
        const copy = await loadCopy<Submission[]>(user.id, 'expense_own');
        if (copy && copy.length > 0) { failed = false; setSubmissions(prev => (prev.length > 0 ? prev : copy)); }
      } else if (!failed) {
        // 🚨 読めなかったときは前の一覧を残す（空で上書きしない）
        setSubmissions(expensesToSet);
        setPendingApprovals(pendingApprovalsToSet);
      }
      setLoadFailed(failed);
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
    loadFailed,
    fetchExpenses,
    rejectionNotice,
    clearRejectionNotice: () => setRejectionNotice(null)
  };
};
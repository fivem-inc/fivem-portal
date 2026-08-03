import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabaseClient';

// 安否確認：自分がまだ回答していない、進行中の安否確認の件数
//   ホームの赤バナー・ナビの連絡板バッジ加算・安否ページのバッジで共用する。
//   回答成功時・オフラインキュー送信成功時は 'safety-pending-changed' イベントで即時に数え直す。
export const useSafetyPendingCount = (userId: string | undefined) => {
  const [pendingCount, setPendingCount] = useState(0);
  const [activeChecks, setActiveChecks] = useState<{ id: string; title: string; body: string }[]>([]);

  const fetchPending = useCallback(async () => {
    if (!userId) { setPendingCount(0); setActiveChecks([]); return; }

    const { data: checks } = await supabase
      .from('safety_checks')
      .select('id, title, body')
      .eq('status', 'active')
      .eq('cancelled', false);
    if (!checks || checks.length === 0) { setPendingCount(0); setActiveChecks([]); return; }

    const { data: myRecipient } = await supabase
      .from('safety_check_recipients')
      .select('check_id')
      .eq('user_id', userId)
      .in('check_id', checks.map(c => c.id));
    const myCheckIds = new Set((myRecipient ?? []).map(r => r.check_id as string));
    const relevant = checks.filter(c => myCheckIds.has(c.id));
    if (relevant.length === 0) { setPendingCount(0); setActiveChecks([]); return; }

    const { data: myResponses } = await supabase
      .from('safety_check_responses')
      .select('check_id')
      .eq('user_id', userId)
      .in('check_id', relevant.map(c => c.id));
    const answered = new Set((myResponses ?? []).map(r => r.check_id as string));
    const unanswered = relevant.filter(c => !answered.has(c.id));

    setPendingCount(unanswered.length);
    setActiveChecks(unanswered as { id: string; title: string; body: string }[]);
  }, [userId]);

  useEffect(() => { fetchPending(); }, [fetchPending]);
  useEffect(() => {
    window.addEventListener('safety-pending-changed', fetchPending);
    const interval = setInterval(fetchPending, 30000);
    return () => { window.removeEventListener('safety-pending-changed', fetchPending); clearInterval(interval); };
  }, [fetchPending]);

  return { pendingCount, activeChecks, refetch: fetchPending };
};

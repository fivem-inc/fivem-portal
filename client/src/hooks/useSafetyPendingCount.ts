import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabaseClient';

// 安否確認：自分がまだ回答していない、進行中の安否確認の件数
//   ホームの赤バナー・ナビの連絡板バッジ加算・安否ページのバッジで共用する。
//   回答成功時・オフラインキュー送信成功時は 'safety-pending-changed' イベントで即時に数え直す。
// 種類ごとの見た目（安否＝赤／出勤確認＝オレンジ／応援のお願い＝青）。
// 応援要請まで赤くすると、本当の災害時に「またか」と流されてしまうため区別する。
export type SafetyPattern = 'safety3' | 'safety4' | 'attendance2' | 'support';

export const SAFETY_TONE: Record<SafetyPattern, { label: string; bg: string; border: string; text: string; icon: string }> = {
  safety3:     { label: '安否確認が進行中です',     bg: '#f8d7da', border: '#dc3545', text: '#721c24', icon: '🆘' },
  safety4:     { label: '安否確認が進行中です',     bg: '#f8d7da', border: '#dc3545', text: '#721c24', icon: '🆘' },
  attendance2: { label: '出勤確認が届いています',   bg: '#fff3cd', border: '#fd7e14', text: '#8a4b08', icon: '🚃' },
  support:     { label: '応援のお願いが届いています', bg: '#e3f2fd', border: '#1976d2', text: '#0c447c', icon: '🙋' },
};

export const safetyTone = (p: string | undefined) => SAFETY_TONE[(p as SafetyPattern)] ?? SAFETY_TONE.safety3;

export const useSafetyPendingCount = (userId: string | undefined) => {
  const [pendingCount, setPendingCount] = useState(0);
  const [activeChecks, setActiveChecks] = useState<{ id: string; title: string; body: string; pattern: string }[]>([]);

  const fetchPending = useCallback(async () => {
    if (!userId) { setPendingCount(0); setActiveChecks([]); return; }

    const { data: checks } = await supabase
      .from('safety_checks')
      .select('id, title, body, pattern')
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
    setActiveChecks(unanswered as { id: string; title: string; body: string; pattern: string }[]);
  }, [userId]);

  useEffect(() => { fetchPending(); }, [fetchPending]);
  useEffect(() => {
    window.addEventListener('safety-pending-changed', fetchPending);
    const interval = setInterval(fetchPending, 30000);
    return () => { window.removeEventListener('safety-pending-changed', fetchPending); clearInterval(interval); };
  }, [fetchPending]);

  return { pendingCount, activeChecks, refetch: fetchPending };
};

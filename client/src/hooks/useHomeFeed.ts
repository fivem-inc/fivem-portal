// ホームの新着を読む（2026-10-18）。DB の my_home_feed を1回だけ呼ぶ（本文は返さない・1人 約0.5KB）。
// 🚨 ナビとホームが同じ値を共有し（useStickyState）、ページを移っても10分は読み直さない（useRefreshOn の key）。
//    新しいベル通知・安否確認・自分の書き込み（［確認した］・ホームを開いた・回答など＝lib/writeWatch の 'home'）では読み直す
import { useCallback } from 'react';
import { supabase } from '../lib/supabaseClient';
import { useRefreshOn } from './useRefreshOn';
import { useStickyState } from './useStickyState';
import { TOPICS_HOME_FEED } from '../lib/badgeTopics';
import { newHomeItems, type HomeFeed } from '../lib/homeFeed';

export function useHomeFeed(userId: string | undefined) {
  const key = 'homefeed:' + (userId ?? '');
  const [feed, setFeed] = useStickyState<HomeFeed | null>(key, null);
  const fetchFeed = useCallback(async () => {
    if (!userId) return;
    const { data, error } = await supabase.rpc('my_home_feed');
    // 🚨 読めなかったときは前の値のまま（0 にして「新着なし」と言わない）
    if (error || !data) return;
    setFeed(data as HomeFeed);
  }, [userId, setFeed]);
  useRefreshOn(fetchFeed, TOPICS_HOME_FEED, key);
  /** ホームを開いた：画面の値でも「今見た」にする（DB は home_mark_seen） */
  const markSeenLocal = useCallback(() => {
    setFeed(f => (f ? { ...f, seen_at: new Date().toISOString() } : f));
  }, [setFeed]);
  const newCount = feed ? newHomeItems(feed.items, feed.seen_at).length : 0;
  return { feed, newCount, markSeenLocal, refetch: fetchFeed };
}

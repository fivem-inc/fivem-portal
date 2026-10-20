import { useEffect, useCallback } from 'react';
import { flushSafetyQueue } from '../lib/safetyQueue';

// 端末に保存した安否確認の回答を、どのページにいても送り直す。
//
// 🚨 これが無いと「オフラインで回答 → ホームに戻る → 電波が戻る」でも何も起きず、
//    安否ページをもう一度開くまで回答が届かない。
//    災害時は「一瞬だけ電波が入る」ことがあり、その瞬間を逃さないためにアプリ全体で見張る。
// 🚨 送る処理そのものは lib/safetyQueue の flushSafetyQueue 1か所（安否ページと共用・2026-10-20）
//
// ⚠️ /safety を開いているときは動かさない。
//    あのページには同じ見張りがあり、失敗の理由を画面に出す役目も持っているため。

const APP_FLUSH_INTERVAL_MS = 60000;

// 🚨 enabled=false のときは送信しない（退職者は submit_safety_response を実行できない。2026-09-20）
export const useSafetyQueueFlush = (userId: string | undefined, pathname: string, enabled = true) => {
  const flush = useCallback(() => {
    if (!userId) return;
    if (!enabled) return;   // 🚨 退職者は submit_safety_response を実行できない。送らない
    if (pathname === '/safety') return;
    void flushSafetyQueue(userId);
  }, [userId, pathname, enabled]);

  useEffect(() => {
    flush();
    // 🚨 iPhone は裏にいる間タイマーが止まり、「電波が戻った」の合図も当てにならない。
    //    アプリを前面に戻したとき（visibilitychange・pageshow）にも送る（2026-10-20）
    const onVisible = () => { if (document.visibilityState === 'visible') flush(); };
    window.addEventListener('online', flush);
    window.addEventListener('pageshow', flush);
    document.addEventListener('visibilitychange', onVisible);
    const interval = setInterval(flush, APP_FLUSH_INTERVAL_MS);
    return () => {
      window.removeEventListener('online', flush);
      window.removeEventListener('pageshow', flush);
      document.removeEventListener('visibilitychange', onVisible);
      clearInterval(interval);
    };
  }, [flush]);
};

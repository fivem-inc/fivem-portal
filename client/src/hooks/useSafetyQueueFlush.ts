import { useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabaseClient';
import { isTransientFailure, timeoutSignal, SAFETY_TIMEOUT_MS } from '../lib/netFailure';
import { loadPendingQueue, savePendingQueue } from '../lib/safetyStorage';

// 端末に保存した安否確認の回答を、どのページにいても送り直す。
//
// 🚨 これが無いと「オフラインで回答 → ホームに戻る → 電波が戻る」でも何も起きず、
//    安否ページをもう一度開くまで回答が届かない。
//    災害時は「一瞬だけ電波が入る」ことがあり、その瞬間を逃さないためにアプリ全体で見張る。
//
// ⚠️ /safety を開いているときは動かさない。
//    あのページには同じ処理があり、失敗の理由を画面に出す役目も持っているため
//    （二重に送ると無駄な通信になる）。

const APP_FLUSH_INTERVAL_MS = 60000;
const GIVE_UP_ATTEMPTS = 10;   // これ以上はここでは試さない（安否ページ側で理由を出して片付ける）

export const useSafetyQueueFlush = (userId: string | undefined, pathname: string) => {
  const flush = useCallback(async () => {
    if (!userId) return;
    if (pathname === '/safety') return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;

    const queue = loadPendingQueue(userId);
    const keys = Object.keys(queue);
    if (keys.length === 0) return;

    let changed = false;
    for (const checkId of keys) {
      const item = queue[checkId];
      if ((item.attempts ?? 0) >= GIVE_UP_ATTEMPTS) continue;

      const { error, status } = await supabase.rpc('submit_safety_response', {
        p_check_id: checkId, p_choice: item.choice, p_comment: item.comment || null,
        p_client_key: item.clientKey,
        p_answered_at: new Date(item.savedAt).toISOString(),
      }).abortSignal(timeoutSignal(SAFETY_TIMEOUT_MS));

      if (!error) {
        delete queue[checkId];
        changed = true;
      } else if (isTransientFailure(status, error)) {
        queue[checkId] = { ...item, attempts: (item.attempts ?? 0) + 1 };
        changed = true;
      }
      // 送り直しても通らない失敗はここでは消さない。
      // 安否ページを開いたときに理由つきで本人に知らせてから片付ける。
    }
    if (changed) {
      savePendingQueue(userId, queue);
      window.dispatchEvent(new CustomEvent('safety-pending-changed'));
    }
  }, [userId, pathname]);

  useEffect(() => {
    flush();
    window.addEventListener('online', flush);
    const interval = setInterval(flush, APP_FLUSH_INTERVAL_MS);
    return () => { window.removeEventListener('online', flush); clearInterval(interval); };
  }, [flush]);
};

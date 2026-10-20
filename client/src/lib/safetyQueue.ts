// 端末に保存した安否確認の回答（送信待ち）を送る処理（2026-10-20・1か所にまとめた）。
//
// 呼ぶのは2か所：どのページでも動く hooks/useSafetyQueueFlush と、安否ページ（pages/SafetyCheckPage）。
// 🚨 前は2か所に別々の送る処理があり、どちらも「最初に読んだ写しを、送り終えてから丸ごと保存」していた。
//    送っている途中に本人が別の安否に答える・別のタブが保存すると、その新しい回答が消えていた。
//    → 1件送るたびに lib/safetyStorage の updatePendingQueue で読み直し、同じ clientKey のときだけ消す。
// 🚨 同時に2つ動かさない：同じタブは「送っている最中」の約束を使い回す／別のタブは navigator.locks で1つだけ。
//    （navigator.locks が無いブラウザは同じタブの分だけ止める。2つ動いても、上の読み直しで回答は消えない）
// ・送り直しても通らない失敗は送信待ちから外し、理由を端末に残す（安否ページを開いたときに本人に出す）
// ・二重に届いても DB 側が1人1回答に上書きし、押した時刻の新しい方を残すので害はない

import { supabase } from './supabaseClient';
import { isTransientFailure, timeoutSignal, SAFETY_TIMEOUT_MS } from './netFailure';
import { loadPendingQueue, updatePendingQueue, loadQueueErrors, saveQueueErrors } from './safetyStorage';

export interface SafetyFlushResult {
  /** 送ってみた件数（0なら何もしていない） */
  tried: number;
  /** 届いた件数 */
  sent: number;
}

const LOCK_NAME = 'fivem-safety-flush';
let running: Promise<SafetyFlushResult> | null = null;

/** 送り直しても通らなかったときに本人へ出す文 */
export function friendlyQueueError(error: { code?: string; message?: string } | null): string {
  if (error?.code === '42501') return 'この安否確認の対象ではないため、回答を送れませんでした';
  if (error?.code === 'P0002') return 'この安否確認は取り消されました。回答は不要です';
  return '保存していた回答を送れませんでした。お手数ですがもう一度回答してください';
}

async function flushNow(userId: string): Promise<SafetyFlushResult> {
  const queue = loadPendingQueue(userId);
  const keys = Object.keys(queue);
  const result: SafetyFlushResult = { tried: 0, sent: 0 };
  if (keys.length === 0) return result;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return result; // 圏外なら試さない（電池対策）

  const errors: Record<string, string> = {};
  for (const checkId of keys) {
    const item = queue[checkId];
    result.tried++;
    const { data, error, status } = await supabase.rpc('submit_safety_response', {
      p_check_id: checkId, p_choice: item.choice, p_comment: item.comment || null,
      p_client_key: item.clientKey,
      // 本人がボタンを押した時刻。これより新しい回答（電話での代行入力など）が
      // すでにあれば、DB側で上書きしないようにするために渡す。
      p_answered_at: new Date(item.savedAt).toISOString(),
    }).abortSignal(timeoutSignal(SAFETY_TIMEOUT_MS));

    // 🚨 送っている間に同じ安否へ新しい回答が保存されていたら（clientKey が違う）、そちらは触らない
    const sameItem = (mine: Record<string, { clientKey: string }>) => mine[checkId]?.clientKey === item.clientKey;
    if (!error) {
      result.sent++;
      updatePendingQueue(userId, mine => { if (sameItem(mine)) delete mine[checkId]; });
      if (data && (data as { applied?: boolean }).applied === false) {
        errors[checkId] = 'あとから記録された新しい回答があるため、保存していた回答は反映されませんでした';
      }
    } else if (isTransientFailure(status, error)) {
      // まだ送れる見込みがある失敗。回数だけ数えておき、何度も失敗するようなら安否ページで本人に知らせる
      updatePendingQueue(userId, mine => {
        if (sameItem(mine)) mine[checkId] = { ...mine[checkId], attempts: (mine[checkId].attempts ?? 0) + 1 };
      });
    } else {
      // 送り直しても通らない失敗。永久に送り続けても届かないので外し、理由を残す
      updatePendingQueue(userId, mine => { if (sameItem(mine)) delete mine[checkId]; });
      errors[checkId] = friendlyQueueError(error);
    }
  }
  if (Object.keys(errors).length > 0) saveQueueErrors(userId, { ...loadQueueErrors(userId), ...errors });
  window.dispatchEvent(new CustomEvent('safety-pending-changed'));
  return result;
}

/** 送信待ちを送る。ほかで送っている最中なら、それを待って同じ結果を返す（別のタブで送っている最中なら何もしない） */
export function flushSafetyQueue(userId: string): Promise<SafetyFlushResult> {
  if (running) return running;
  const locks = typeof navigator !== 'undefined'
    ? (navigator as Navigator & { locks?: LockManager }).locks
    : undefined;
  const p = (locks
    ? locks.request(LOCK_NAME, { ifAvailable: true }, lock => (lock ? flushNow(userId) : { tried: 0, sent: 0 }))
    : flushNow(userId)
  ).catch((e: unknown) => {
    console.error('[safety] 送信待ちの送信で止まりました:', e);
    return { tried: 0, sent: 0 };
  }).finally(() => { running = null; });
  running = p;
  return p;
}

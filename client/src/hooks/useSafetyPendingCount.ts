import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '../lib/supabaseClient';
import { isTransientFailure, timeoutSignal, SAFETY_TIMEOUT_MS } from '../lib/netFailure';
import {
  loadPendingQueue, loadSafetySnapshot, saveSafetySnapshot,
  type SafetyCheckLite, type SafetyResponseLite,
} from '../lib/safetyStorage';

// 安否確認：自分がまだ回答していない、進行中の安否確認の件数
//   ホームの赤バナー・ナビの連絡板バッジ加算・安否ページのバッジで共用する。
//   回答成功時・オフラインキュー送信成功時は 'safety-pending-changed' イベントで即時に数え直す。
//
// 🚨 このフックは「電波が切れる直前の状態」を端末に残す役目も持つ。
//    ログインしていればどのページにいても30秒ごとに動くため、ここで控えを取っておくと
//    「安否ページを一度も開いていない人」でもオフラインで回答画面を出せる。
//    （/safety を開いたときだけ保存する作りだと、災害前にそのページを開いていた人しか救えない）
//
// 🚨 取得に失敗したときに 0件 にしてはいけない。
//    0件にするとホームの赤バナーが消え、「安否確認が出ていること」に気付けなくなる。
//    失敗時は前回の値か端末の控えを使う。

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

const CHECK_COLUMNS = 'id, title, body, pattern, options, is_test, status, cancelled, created_at';
const RESPONSE_COLUMNS = 'check_id, user_id, choice, comment, is_proxy, proxy_by, answered_at';

export const useSafetyPendingCount = (userId: string | undefined) => {
  const [pendingCount, setPendingCount] = useState(0);
  const [activeChecks, setActiveChecks] = useState<SafetyCheckLite[]>([]);
  const [queuedCount, setQueuedCount] = useState(0);   // 端末に保存済み・送信待ちの件数
  const [isStale, setIsStale] = useState(false);       // サーバーから取れず、端末の控えを見ている
  const [snapshotAt, setSnapshotAt] = useState<number | null>(null);

  // 通信が遅いと古い応答が後から返って新しい結果を上書きしてしまう。
  // 番号を振っておき、最新の呼び出し以外の応答は捨てる。
  const seq = useRef(0);

  // サーバーから取れなかったときに、端末の控えで埋める
  const applySnapshot = useCallback((uid: string) => {
    const snap = loadSafetySnapshot(uid);
    setIsStale(true);
    if (!snap) return;   // 控えが無いときは前回の値をそのまま残す（0件にしない）
    const queue = loadPendingQueue(uid);
    const answered = new Set(Object.keys(snap.myResponses));
    const unanswered = snap.checks.filter(c => !answered.has(c.id) && !queue[c.id]);
    setActiveChecks(unanswered);
    setPendingCount(unanswered.length);
    setQueuedCount(snap.checks.filter(c => !!queue[c.id]).length);
    setSnapshotAt(snap.savedAt);
  }, []);

  const fetchPending = useCallback(async () => {
    if (!userId) {
      setPendingCount(0); setActiveChecks([]); setQueuedCount(0); setIsStale(false); setSnapshotAt(null);
      return;
    }
    const uid = userId;
    const my = ++seq.current;

    // 完全に圏外のときはサーバーに問い合わせない（災害時に貴重な電池を無駄にしないため）
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      applySnapshot(uid);
      return;
    }

    const { data: checks, error: checksErr, status: checksStatus } = await supabase
      .from('safety_checks')
      .select(CHECK_COLUMNS)
      .eq('status', 'active')
      .eq('cancelled', false)
      .abortSignal(timeoutSignal(SAFETY_TIMEOUT_MS));
    if (my !== seq.current) return;
    if (checksErr) {
      if (isTransientFailure(checksStatus, checksErr)) applySnapshot(uid);
      return;
    }
    if (!checks || checks.length === 0) {
      setPendingCount(0); setActiveChecks([]); setQueuedCount(0); setIsStale(false); setSnapshotAt(null);
      saveSafetySnapshot(uid, [], {});   // 終わった安否確認が端末に残り続けないよう控えも消す
      return;
    }

    const { data: myRecipient, error: recErr, status: recStatus } = await supabase
      .from('safety_check_recipients')
      .select('check_id')
      .eq('user_id', uid)
      .in('check_id', checks.map(c => c.id))
      .abortSignal(timeoutSignal(SAFETY_TIMEOUT_MS));
    if (my !== seq.current) return;
    if (recErr) {
      if (isTransientFailure(recStatus, recErr)) applySnapshot(uid);
      return;
    }
    const myCheckIds = new Set((myRecipient ?? []).map(r => r.check_id as string));
    const relevant = (checks as SafetyCheckLite[]).filter(c => myCheckIds.has(c.id));
    if (relevant.length === 0) {
      setPendingCount(0); setActiveChecks([]); setQueuedCount(0); setIsStale(false); setSnapshotAt(null);
      saveSafetySnapshot(uid, [], {});
      return;
    }

    const { data: myResponses, error: resErr, status: resStatus } = await supabase
      .from('safety_check_responses')
      .select(RESPONSE_COLUMNS)
      .eq('user_id', uid)
      .in('check_id', relevant.map(c => c.id))
      .abortSignal(timeoutSignal(SAFETY_TIMEOUT_MS));
    if (my !== seq.current) return;
    if (resErr) {
      if (isTransientFailure(resStatus, resErr)) applySnapshot(uid);
      return;
    }

    const responseMap: Record<string, SafetyResponseLite> = {};
    (myResponses ?? []).forEach((r) => { responseMap[(r as SafetyResponseLite).check_id] = r as SafetyResponseLite; });

    // 端末に保存済み（送信待ち）の回答も「答えた」として扱う。
    // でないと本人は答えたのにホームが赤いままになり、何度も押すことになる。
    const queue = loadPendingQueue(uid);
    const answered = new Set(Object.keys(responseMap));
    const unanswered = relevant.filter(c => !answered.has(c.id) && !queue[c.id]);

    setPendingCount(unanswered.length);
    setActiveChecks(unanswered);
    setQueuedCount(relevant.filter(c => !answered.has(c.id) && !!queue[c.id]).length);
    setIsStale(false);
    setSnapshotAt(null);

    // 電波が切れる前の状態を残しておく（訓練は含めない・他人の情報は入れない）
    saveSafetySnapshot(uid, relevant, responseMap);
  }, [userId, applySnapshot]);

  useEffect(() => { fetchPending(); }, [fetchPending]);
  useEffect(() => {
    window.addEventListener('safety-pending-changed', fetchPending);
    window.addEventListener('online', fetchPending);
    const interval = setInterval(fetchPending, 30000);
    return () => {
      window.removeEventListener('safety-pending-changed', fetchPending);
      window.removeEventListener('online', fetchPending);
      clearInterval(interval);
    };
  }, [fetchPending]);

  return { pendingCount, activeChecks, queuedCount, isStale, snapshotAt, refetch: fetchPending };
};

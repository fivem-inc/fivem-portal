// バッジの数字を「いつ数え直すか」を1か所で決める部品（2026-09-27・通信量の見直し 段1）
//
// 【なぜ作ったか】
// Supabase 無料枠の通信量が 90%（4.52 / 5 GB）に達した。原因はデータの重さではなく回数で、
// 30 秒ごとの数え直し（hooks/usePolling.ts・12 か所）が月 139 万回＝全体の 78% を占めていた。
// 計画は docs/計画-自動更新の見直し.md（専門家役4体＋本番の実測で裏取り）。
//
// 【仕組み】
// バッジが「増える」出来事は、ほぼ全部が受け取り手に notifications の行を入れている。
// そこで 12 種類を別々に数えに行くのをやめ、通知の表を1本だけ読んで（lib/badgeLedger.ts）
// 「新しく来た行の話題」のフックだけが、今の数え方をもう一度呼ぶ。
//
// 【いつ通知の表を読むか】
//   ・画面を開いたとき（最初に1回）
//   ・前面に戻ったとき（visibilitychange / focus / pageshow。同時に来るので 5 秒以内は1回にまとめる）
//   ・見えている間の心拍（3 分）
// 【「減る側」の保険】（他の人が処理した・本人が取り消した、は通知の行が入らない）
//   ・前面に戻ったとき、前回の全件更新から 10 分以上たっていれば全件（'all'）
//   ・心拍で 30 分以上たっていれば全件
//   ・通知の表が2回続けて読めなかったら全件
//
// 🚨 このファイルは supabase を読まない（node で検算できるようにするため）。通知の表を読むのは badgeLedger.ts
// 🚨 送る処理（安否の回答のキューなど）には使わない。見ていない間に止まるため

export type RefreshTopic =
  | 'board' | 'leave' | 'shift_report' | 'overtime' | 'application_request'
  | 'purchase_request' | 'safety' | 'admin' | 'bell';
export type RefreshKey = RefreshTopic | 'all';
export type TickReason = 'start' | 'foreground' | 'heartbeat';

export const HEARTBEAT_MS = 3 * 60 * 1000;
export const FOREGROUND_COALESCE_MS = 5 * 1000;
export const FULL_ON_FOREGROUND_MS = 10 * 60 * 1000;
export const FULL_ON_HEARTBEAT_MS = 30 * 60 * 1000;

/** 全件の数え直しをするか（純粋な判定・検算用に外へ出している） */
export function isFullRefreshDue(reason: TickReason, now: number, lastFullAt: number): boolean {
  if (reason === 'foreground') return now - lastFullAt >= FULL_ON_FOREGROUND_MS;
  if (reason === 'heartbeat') return now - lastFullAt >= FULL_ON_HEARTBEAT_MS;
  return false;
}

/**
 * 通知の表を読んで「新しく来た話題」を返す関数。badgeLedger.ts が登録する。
 * 読めなかったときは null（失敗の回数を数えるため）。
 */
type Ticker = () => Promise<Set<RefreshTopic> | null>;

const listeners = new Map<RefreshKey, Set<() => void>>();
let subscriberCount = 0;
let ticker: Ticker | null = null;
let started = false;
let heartbeatTimer: number | undefined;
let lastForegroundAt = 0;
let lastFullAt = 0;
let failures = 0;
let running = false;
let stopTimer: number | undefined;
/** 購読が0になってから止めるまでの猶予。ナビはページを移るたびに付け直される（各ページの中に書かれている）ので、すぐ止めると止まって動き直し、台帳を1回余計に読む */
export const STOP_GRACE_MS = 5 * 1000;

export function setTicker(fn: Ticker): void { ticker = fn; }

/** 話題を知らせる。1つの購読者が複数の話題に入っていても1回だけ呼ぶ */
export function emit(keys: Iterable<RefreshKey>): void {
  const fns = new Set<() => void>();
  for (const k of keys) listeners.get(k)?.forEach(fn => fns.add(fn));
  fns.forEach(fn => { try { fn(); } catch (e) { console.error('[refreshBus] 数え直しに失敗:', e); } });
}

async function runTick(reason: TickReason): Promise<void> {
  if (running) return;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  running = true;
  try {
    const now = Date.now();
    const fullDue = isFullRefreshDue(reason, now, lastFullAt);
    const topics = ticker ? await ticker() : new Set<RefreshTopic>();
    if (topics === null) failures += 1; else failures = 0;
    if (fullDue || failures >= 2) {
      lastFullAt = now;
      failures = 0;
      emit(['all']);
    } else if (topics && topics.size > 0) {
      emit(topics);
    }
  } finally {
    running = false;
  }
}

function onForeground(): void {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
  const now = Date.now();
  if (now - lastForegroundAt < FOREGROUND_COALESCE_MS) return;
  lastForegroundAt = now;
  void runTick('foreground');
}

function onHeartbeat(): void {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
  void runTick('heartbeat');
}

function start(): void {
  if (started) return;
  started = true;
  const now = Date.now();
  // 🚨 開いた直後は各フックが自分で1回読むので、ここを「全件更新した時刻」「前面に戻った時刻」にする
  //    （pageshow は初回の読み込みでも来るので、5 秒のまとめに入れて二重に読まない）
  lastForegroundAt = now;
  lastFullAt = now;
  document.addEventListener('visibilitychange', onForeground);
  window.addEventListener('focus', onForeground);
  window.addEventListener('pageshow', onForeground);
  heartbeatTimer = window.setInterval(onHeartbeat, HEARTBEAT_MS);
  // 通知の表の「いま」を覚える（ここで来ていた行は新着として扱わない＝各フックが今読むため）
  void runTick('start');
}

function stop(): void {
  if (!started) return;
  started = false;
  document.removeEventListener('visibilitychange', onForeground);
  window.removeEventListener('focus', onForeground);
  window.removeEventListener('pageshow', onForeground);
  if (heartbeatTimer !== undefined) { window.clearInterval(heartbeatTimer); heartbeatTimer = undefined; }
}

/** 話題を購読する。'all'（全件の数え直し）にも自動で入る。戻り値で解除 */
export function subscribe(topics: readonly RefreshTopic[], fn: () => void): () => void {
  const keys: RefreshKey[] = [...topics, 'all'];
  for (const k of keys) {
    if (!listeners.has(k)) listeners.set(k, new Set());
    listeners.get(k)!.add(fn);
  }
  subscriberCount += 1;
  if (stopTimer !== undefined) { window.clearTimeout(stopTimer); stopTimer = undefined; }
  if (subscriberCount === 1) start();
  return () => {
    for (const k of keys) listeners.get(k)?.delete(fn);
    subscriberCount -= 1;
    if (subscriberCount === 0) {
      if (stopTimer !== undefined) window.clearTimeout(stopTimer);
      stopTimer = window.setTimeout(() => { stopTimer = undefined; if (subscriberCount === 0) stop(); }, STOP_GRACE_MS);
    }
  };
}

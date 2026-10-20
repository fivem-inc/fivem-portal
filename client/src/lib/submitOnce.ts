// 申請を「1回だけ」届ける仕組み（2026-10-21・電波 段3・docs/計画-電波が弱いとき.md の 4.・UI/UX とシニアエンジニアの2体でレビュー）。
//
// 【なぜ要るか】電波が弱いと、申請は届いたのに応答だけ落ちて「失敗」に見えることがある。そこで押し直すと同じ申請が2件届く。
// 【やり方】
//   ・端末で番号（uuid）を作り、申請の id にして入れる。番号は端末に保存する（読み込み直しても消えない）
//   ・届いたか分からない番号（状態 unknown）が残っていたら、送る前に「その番号の行がもう有るか」を先に確かめる。
//     🚨 23505 を待ってから確かめるのでは遅い：届いていた申請を押し直すと、BEFORE トリガー（締め後・重なり など）が先に断る
//   ・送信の待ち時間は20秒まで（登録の部分だけ・ユーザー確定）。8秒を過ぎたら onSlow
//   ・打ち切った直後はサーバーで処理が続いていることがあるので、少し待ってから確かめる。それでも無いときは「分からない」のまま番号を残す
//     （「無い」を決め手にしない＝次に押したときにもう一度確かめる）
// 【呼ぶ側の決まり】
//   ・後処理（上長へのお知らせ・メール・Slack など）は呼ぶ側に残す。'inserted' が返ったら1回だけ行う（recovered＝押し直しで届いていたと分かった）
//   ・'delivered_changed'：届いていた。直した内容は送っていない（後処理はしない・SEND_DELIVERED_CHANGED_TEXT を黄色で）
//   ・'unknown'：sendUnstableOnceText（黄色）。番号は残っている
//   ・'rejected'：今までの失敗の文（重なり止めなど）
// 🚨 「2件届くことはありません」と言えるのは、この仕組みを通した送信だけ

import { isNetworkFailure } from './netFailure';

type DbError = { message: string; code?: string; details?: string | null } | null;
type DbResult = { error: DbError; status?: number };
type ExistsResult = { data: unknown[] | null; error: DbError; status?: number };

export type SubmitOnceResult =
  | { kind: 'inserted'; id: string; recovered: boolean }
  | { kind: 'delivered_changed'; id: string }
  | { kind: 'unknown' }
  | { kind: 'rejected'; error: NonNullable<DbError>; status?: number };

interface SlotRecord { id: string; fp: string; at: number }

const SLOT_PREFIX = 'fivem_submit_once:';
/** 「分からない」の番号を覚えておく長さ（これより古いものは忘れる） */
const SLOT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const SUBMIT_TIMEOUT_MS = 20000;
export const SUBMIT_SLOW_MS = 8000;
const EXISTS_TIMEOUT_MS = 8000;
const RECHECK_WAIT_MS = 1500;

/** 端末で作る番号（crypto が使えない古い端末は getRandomValues・それも無ければ Math.random） */
export function newSubmitId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch { /* 下へ */ }
  const b = new Uint8Array(16);
  try {
    crypto.getRandomValues(b);
  } catch {
    for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  }
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const slotKey = (userId: string, slot: string) => `${SLOT_PREFIX}${userId}:${slot}`;
function readSlot(userId: string, slot: string): SlotRecord | null {
  try {
    const raw = localStorage.getItem(slotKey(userId, slot));
    if (!raw) return null;
    const r = JSON.parse(raw) as SlotRecord;
    if (!r?.id || typeof r.at !== 'number' || Date.now() - r.at > SLOT_MAX_AGE_MS) return null;
    return r;
  } catch { return null; }
}
function writeSlot(userId: string, slot: string, r: SlotRecord): void {
  try { localStorage.setItem(slotKey(userId, slot), JSON.stringify(r)); } catch { /* 保存できなくても送信は続ける（番号は画面の中で使う） */ }
}
export function clearSubmitSlot(userId: string, slot: string): void {
  try { localStorage.removeItem(slotKey(userId, slot)); } catch { /* 何もしない */ }
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** 時間内に終わらなければ abort して 'timeout' を返す（fetch の前の合言葉の取り直しにも abortSignal は効かないので、待ち自体も打ち切る）。
 *  書き換え（update）の上限にも使う（lib/overtimeSubmitApi） */
export async function raceTimeout<T>(run: (signal: AbortSignal) => PromiseLike<T>, ms: number): Promise<T | 'timeout'> {
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>(resolve => { timer = setTimeout(() => { ctrl.abort(); resolve('timeout'); }, ms); });
  try {
    return await Promise.race([Promise.resolve(run(ctrl.signal)), timeout]);
  } catch {
    // 通信の例外（fetch が投げた）も「分からない」と同じに扱う
    return 'timeout';
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** その番号の行がもう有るか。true＝有る／false＝無い／null＝確かめられなかった */
async function probe(id: string, exists: (id: string, signal: AbortSignal) => PromiseLike<ExistsResult>): Promise<boolean | null> {
  const r = await raceTimeout(signal => exists(id, signal), EXISTS_TIMEOUT_MS);
  if (r === 'timeout' || r.error) return null;
  return (r.data?.length ?? 0) > 0;
}

export async function submitOnce(opts: {
  userId: string;
  /** 申請の種類（例 'expense' 'leave' 'trip' 'shift_report' 'ot:2026-10-21'）。同じ種類の「分からない」番号を1つ覚える */
  slot: string;
  /** 入力の中身から作った文字列（送るたびに変わる時刻などは入れない）。同じなら同じ番号を使い回す */
  fingerprint: string;
  insert: (id: string, signal: AbortSignal) => PromiseLike<DbResult>;
  exists: (id: string, signal: AbortSignal) => PromiseLike<ExistsResult>;
  onSlow?: () => void;
  timeoutMs?: number;
}): Promise<SubmitOnceResult> {
  const { userId, slot, fingerprint, insert, exists, onSlow } = opts;
  const prev = readSlot(userId, slot);

  // 1. 前に「分からない」で終わった番号があれば、送る前に確かめる
  let id: string | null = null;
  if (prev) {
    const found = await probe(prev.id, exists);
    if (found === null) return { kind: 'unknown' };
    if (found) {
      clearSubmitSlot(userId, slot);
      return prev.fp === fingerprint ? { kind: 'inserted', id: prev.id, recovered: true } : { kind: 'delivered_changed', id: prev.id };
    }
    // 届いていない。中身が同じなら同じ番号のまま送る
    if (prev.fp === fingerprint) id = prev.id;
  }
  id = id ?? newSubmitId();
  // 🚨 送る前に保存する（送信中に閉じても、次に開いたとき同じ番号で確かめられる）
  writeSlot(userId, slot, { id, fp: fingerprint, at: Date.now() });

  // 2. 送る（20秒まで・8秒で onSlow）
  const slowTimer = onSlow ? setTimeout(onSlow, SUBMIT_SLOW_MS) : undefined;
  const res = await raceTimeout(signal => insert(id!, signal), opts.timeoutMs ?? SUBMIT_TIMEOUT_MS);
  if (slowTimer) clearTimeout(slowTimer);

  if (res !== 'timeout' && !res.error) {
    clearSubmitSlot(userId, slot);
    return { kind: 'inserted', id, recovered: false };
  }

  // 3. 失敗。通信のせい・時間切れ・23505（同じ番号がもう有る）なら、届いたかを確かめる
  const ambiguous = res === 'timeout' || isNetworkFailure(res.error, res.status) || res.error?.code === '23505';
  if (!ambiguous) {
    // 4xx（重なり止め・締め後・権限など）：届いていない。番号は捨てる
    clearSubmitSlot(userId, slot);
    return { kind: 'rejected', error: res.error!, status: res.status };
  }
  if (res === 'timeout') await sleep(RECHECK_WAIT_MS);
  let found = await probe(id, exists);
  if (found === false && res === 'timeout') { await sleep(RECHECK_WAIT_MS); found = await probe(id, exists); }
  if (found) {
    clearSubmitSlot(userId, slot);
    return { kind: 'inserted', id, recovered: false };
  }
  if (found === false && res !== 'timeout' && res.error?.code === '23505') {
    // 自分の番号は無いのに 23505＝別の申請とぶつかった（同じ日の申請がもう有る など）。今までどおりの失敗
    clearSubmitSlot(userId, slot);
    return { kind: 'rejected', error: res.error, status: res.status };
  }
  // 確かめられない・まだ見えない：番号を残して「分からない」
  return { kind: 'unknown' };
}

// 安否確認が「電波が無くても使える」ようにするための、端末に持つデータ。
//
// ここが持つのは2つだけ。
//   ① 送信待ちの回答（PENDING）  … 送れなかった自分の回答。電波が戻ったら自動送信する
//   ② 進行中の控え（SNAPSHOT）   … 最後に受け取れた「進行中の安否確認」と自分の回答
//
// 🚨 他人の回答・電話番号・集計は絶対にここへ入れない。
//    端末を無くしたときの情報漏れを防ぐため、残すのは
//    「全員に一斉送信された文面」と「自分の回答」だけに限る。
//
// ⚠️ draftStorage.ts（入力中の下書き）とは目的が違うので別ファイルにしている。
//      draftStorage : 無期限。消えるのは「送信成功」と「🗑クリア」のときだけ
//      ここ         : 毎回まるごと上書き。形が変わったら破棄。保存失敗を握りつぶさない

import type { SafetyPattern } from '../hooks/useSafetyPendingCount';

const PENDING_KEY = 'fivem_safety_pending_responses'; // ⚠️ 既存の送信待ちを失わないためキー名は変えない
const SNAPSHOT_KEY = 'fivem_safety_snapshot';

// 控えの形を変えたら必ず上げる。古い形の控えは読まずに捨てる。
// （毎日デプロイしているので、形が変わったまま古い控えを読むと画面が真っ白になる）
const SNAPSHOT_VERSION = 1;

export type SafetyChoiceOption = { key: string; label: string; color: 'green' | 'blue' | 'amber' | 'red' };

/** 控えに残す安否確認。回答画面を出すのに必要な分だけ。 */
export interface SafetyCheckLite {
  id: string;
  title: string;
  body: string;
  pattern: SafetyPattern;
  options: SafetyChoiceOption[];
  is_test: boolean;
  status: 'active' | 'closed';
  cancelled: boolean;
  created_at: string;
}

/** 控えに残す自分の回答。 */
export interface SafetyResponseLite {
  check_id: string;
  user_id: string;
  choice: string;
  comment: string | null;
  is_proxy: boolean;
  proxy_by: string | null;
  answered_at: string;
}

export interface SafetySnapshot {
  v: number;
  userId: string;
  savedAt: number;
  checks: SafetyCheckLite[];
  myResponses: Record<string, SafetyResponseLite>;
}

/** 送信待ちの回答1件。 */
export interface PendingResponse {
  choice: string;
  comment: string;
  clientKey: string;
  savedAt: number;        // 本人がボタンを押した時刻（どちらが新しい情報かの判定に使う）
  attempts?: number;      // 送信を試した回数
  lastError?: string;     // 直近の失敗理由（本人への説明用）
  userId?: string;        // 誰の回答か（同じ端末で別の人がログインしたとき送り違えないように）
}

export type PendingQueue = Record<string, PendingResponse>;

// ---------------- 送信待ちの回答 ----------------

/** 自分あての送信待ちだけを読む。 */
export function loadPendingQueue(userId: string): PendingQueue {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as PendingQueue;
    if (!parsed || typeof parsed !== 'object') return {};
    const mine: PendingQueue = {};
    for (const [checkId, item] of Object.entries(parsed)) {
      if (!item || typeof item.choice !== 'string') continue;
      // userId が無いのは今回の改修より前に保存された分。自分のものとして扱う。
      if (item.userId && item.userId !== userId) continue;
      mine[checkId] = item;
    }
    return mine;
  } catch {
    return {};
  }
}

/** 送信待ちを保存する。保存できたかを返す（容量超過を握りつぶさない）。 */
export function savePendingQueue(userId: string, queue: PendingQueue): boolean {
  try {
    const tagged: PendingQueue = {};
    for (const [checkId, item] of Object.entries(queue)) tagged[checkId] = { ...item, userId };
    localStorage.setItem(PENDING_KEY, JSON.stringify(tagged));
    return true;
  } catch {
    return false;
  }
}

// ログアウトの localStorage.clear() で未送信の回答まで消えないようにするための退避用。
export function readRawPendingQueue(): string | null {
  try { return localStorage.getItem(PENDING_KEY); } catch { return null; }
}
export function writeRawPendingQueue(raw: string | null): void {
  try { if (raw) localStorage.setItem(PENDING_KEY, raw); } catch { /* 保存できなくても致命的ではない */ }
}

// ---------------- 進行中の控え ----------------

/** 控えとして保存してよい形か検査する。
 *  options が壊れていると回答画面が落ちるので、ここで弾いて画面を守る。 */
function isValidCheck(value: unknown): value is SafetyCheckLite {
  if (!value || typeof value !== 'object') return false;
  const c = value as Record<string, unknown>;
  if (typeof c.id !== 'string' || typeof c.body !== 'string') return false;
  if (!Array.isArray(c.options) || c.options.length === 0) return false;
  return c.options.every((o) => {
    if (!o || typeof o !== 'object') return false;
    const opt = o as Record<string, unknown>;
    return typeof opt.key === 'string' && typeof opt.label === 'string';
  });
}

export function loadSafetySnapshot(userId: string): SafetySnapshot | null {
  try {
    const raw = localStorage.getItem(SNAPSHOT_KEY);
    if (!raw) return null;
    const snap = JSON.parse(raw) as SafetySnapshot;
    if (!snap || snap.v !== SNAPSHOT_VERSION) return null;   // 形が変わった＝読まずに捨てる
    if (snap.userId !== userId) return null;                 // 別の人の控えは出さない
    const checks = (Array.isArray(snap.checks) ? snap.checks : []).filter(isValidCheck);
    if (checks.length === 0) return null;
    return { ...snap, checks, myResponses: snap.myResponses ?? {} };
  } catch {
    return null;
  }
}

/** 控えをまるごと入れ替える。古い安否確認が残り続けないよう、毎回上書きする。 */
export function saveSafetySnapshot(
  userId: string,
  checks: SafetyCheckLite[],
  myResponses: Record<string, SafetyResponseLite>,
): boolean {
  try {
    // 訓練（テスト送信）は控えに残さない。
    // 残すとオフラインの間ずっと「【テスト】安否確認」が画面に居座り、
    // 本番の安否確認と紛らわしくなるため（＝「またか」で見流される原因になる）。
    const keep = checks.filter((c) => !c.is_test && c.status === 'active' && !c.cancelled).filter(isValidCheck);
    if (keep.length === 0) {
      localStorage.removeItem(SNAPSHOT_KEY);
      return true;
    }
    const ids = new Set(keep.map((c) => c.id));
    const responses: Record<string, SafetyResponseLite> = {};
    for (const [checkId, r] of Object.entries(myResponses)) {
      if (ids.has(checkId) && r) responses[checkId] = r;
    }
    const snap: SafetySnapshot = { v: SNAPSHOT_VERSION, userId, savedAt: Date.now(), checks: keep, myResponses: responses };
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snap));
    return true;
  } catch {
    return false;
  }
}

export function clearSafetySnapshot(): void {
  try { localStorage.removeItem(SNAPSHOT_KEY); } catch { /* ignore */ }
}

// ---------------- 表示用 ----------------

/** 「約3時間前（8/3 14:30）」の形。
 *  相対だけだと後から何時の情報か分からず、絶対だけだと避難中に古さが伝わらないため両方出す。 */
export function formatSnapshotAge(savedAt: number, now: number = Date.now()): string {
  const d = new Date(savedAt);
  const abs = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const min = Math.floor((now - savedAt) / 60000);
  let rel: string;
  if (min < 1) rel = 'たった今';
  else if (min < 60) rel = `約${min}分前`;
  else if (min < 60 * 24) rel = `約${Math.floor(min / 60)}時間前`;
  else rel = `${Math.floor(min / (60 * 24))}日以上前`;
  return `${rel}（${abs}）`;
}

/** 24時間以上前の控えか（古い可能性を強く伝えるかの判定） */
export function isSnapshotOld(savedAt: number, now: number = Date.now()): boolean {
  return now - savedAt > 24 * 60 * 60 * 1000;
}

// 連絡板の「送信の取り消し」（Gmail と同じ・2026-10-26 ユーザー確定）。計画は docs/計画-連絡板の送信の取り消し.md
// ・［送信］は DB の board_post で「取り消し待ち」の行を作る（相手にはまだ何も見えない・ベルもスマホもメールも出ない）
// ・10秒たったら board_release_hold で届ける。押さなければ、ほかの画面に移っても届ける（この係は画面全体に1つ）
//   アプリを閉じた・通信が切れたときは、毎分のジョブ（DB の cron_every_minute）が届ける＝送られずに消えることはない
// ・［取り消す］は board_cancel_hold。消せたら、送る直前の入力を作成の画面に戻す
// 🚨 届ける・ベルを作るのは DB だけ（board_deliver）。画面でベル・メールを作らない（作ると取り消しても届く・2通になる）
import { supabase } from './supabaseClient';
import { newClientKey } from './safetyStorage';
import { isNetworkFailure } from './netFailure';

export const UNDO_MS = 10_000;
/** 出てから0.5秒は［取り消す］に反応しない（［送信］を押した指のぶれで取り消さない） */
const IGNORE_MS = 500;

export const UNDO_TEXT = {
  sent: '送信しました',
  cancelled: '送信を取り消しました。内容は作成の画面に戻しています。',
  tooLate: 'すでに送信されたため、取り消せませんでした。送信トレイから削除できますが、スマホの通知とメールは取り消せません。',
  offline: '通信がつながらないため取り消せません。このまま送信されます。',
  gone: '取り消せませんでした（すでに削除されています）。',
  waiting: '送信待ち・まだ相手には届いていません',
} as const;

/** 取り消したときに作成の画面へ戻す中身（送る直前の入力のすべて） */
export type BoardRestore =
  | { kind: 'notice'; recipientIds: string[]; presetKeys: string[]; subject: string; body: string;
      deadlineType: string; deadline: string; answerPrompt: string; answerLocation: string; answerLink: string;
      allowReply: boolean; includeCC: boolean }
  | { kind: 'channel'; channelId: string; parentId: string | null; body: string;
      title: string; deadline: string; deadlineType: string; answerPrompt: string; answerLocation: string; answerLink: string }
  | { kind: 'noticeReply'; noticeId: string; partnerId: string; body: string }
  | { kind: 'broadcast'; targetIds: string[]; body: string };

export type PostState = 'held' | 'scheduled' | 'sent';
export type PostResult = { ok: true; state: PostState; scheduledAt: string | null } | { ok: false; error: unknown };

export { newClientKey as newPostId };

/** 送る（本体・宛先・写しを1つの取引で）。同じ id で呼び直しても2件にならない */
export async function postBoard(args: {
  id: string; msg: Record<string, unknown>; recipients?: string[] | null; hold: boolean; batch?: string | null;
}): Promise<PostResult> {
  const { data, error } = await supabase.rpc('board_post', {
    p_id: args.id, p_msg: args.msg, p_recipients: args.recipients ?? null, p_hold: args.hold, p_batch: args.batch ?? null,
  });
  if (error || !data) return { ok: false, error: error ?? new Error('応答がありませんでした') };
  const d = data as { state: PostState; scheduled_at: string | null };
  return { ok: true, state: d.state, scheduledAt: d.scheduled_at };
}

export type CancelResult = 'cancelled' | 'already_sent' | 'gone' | 'offline' | 'error';

export async function cancelHold(target: { id?: string; batch?: string }): Promise<CancelResult> {
  const { data, error } = await supabase.rpc('board_cancel_hold', { p_id: target.id ?? null, p_batch: target.batch ?? null });
  if (error) return isNetworkFailure(error) ? 'offline' : 'error';
  return (data as CancelResult) ?? 'error';
}

export async function releaseHold(target: { id?: string; batch?: string }): Promise<boolean> {
  const { error } = await supabase.rpc('board_release_hold', { p_id: target.id ?? null, p_batch: target.batch ?? null });
  if (error) console.error('[boardSendUndo] 今すぐ届けられませんでした（毎分のジョブが届けます）:', error.message);
  return !error;
}

// ── 画面全体に1つの係 ───────────────────────────────────────────
type Entry = { key: string; id?: string; batch?: string; restore: BoardRestore; shownAt: number; timer: ReturnType<typeof setTimeout> };
export type BandState =
  | { mode: 'none' }
  | { mode: 'undo'; key: string; shownAt: number; busy: boolean }
  | { mode: 'note'; text: string; tone: 'ok' | 'warn' };

let entries: Entry[] = [];
let band: BandState = { mode: 'none' };
let busyKey: string | null = null;
let noteTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();
const restoreListeners = new Set<(r: BoardRestore) => void>();
const sentListeners = new Set<() => void>();
let pendingRestore: BoardRestore | null = null;

const emit = () => listeners.forEach(f => f());
function setBand(b: BandState) { band = b; emit(); }
function showLatest() {
  const last = entries[entries.length - 1];
  setBand(last ? { mode: 'undo', key: last.key, shownAt: last.shownAt, busy: busyKey === last.key } : { mode: 'none' });
}
function note(text: string, tone: 'ok' | 'warn') {
  if (noteTimer) clearTimeout(noteTimer);
  setBand({ mode: 'note', text, tone });
  noteTimer = setTimeout(() => { noteTimer = null; if (band.mode === 'note') showLatest(); }, tone === 'ok' ? 4000 : 8000);
}

export function getBand(): BandState { return band; }
export function subscribeBand(f: () => void): () => void { listeners.add(f); return () => { listeners.delete(f); }; }
/** 届いた（10秒たって送った）とき。連絡板の画面が一覧を読み直す */
export function onBoardSent(f: () => void): () => void { sentListeners.add(f); return () => { sentListeners.delete(f); }; }
/** 取り消したとき。連絡板の画面が開いていればここで受け取る。開いていなければ takePendingRestore で受け取る */
export function onBoardRestore(f: (r: BoardRestore) => void): () => void { restoreListeners.add(f); return () => { restoreListeners.delete(f); }; }
export function takePendingRestore(): BoardRestore | null { const r = pendingRestore; pendingRestore = null; return r; }
export function hasRestoreListener(): boolean { return restoreListeners.size > 0; }

/** ［送信］が通ったあとに呼ぶ。10秒の帯を出し、押されなければ届ける */
export function startUndo(target: { id?: string; batch?: string }, restore: BoardRestore) {
  const key = target.batch ?? target.id ?? newClientKey();
  const timer = setTimeout(() => { void release(key); }, UNDO_MS);
  entries = [...entries.filter(e => e.key !== key), { key, ...target, restore, shownAt: Date.now(), timer }];
  if (noteTimer) { clearTimeout(noteTimer); noteTimer = null; }
  showLatest();
}

async function release(key: string) {
  const e = entries.find(x => x.key === key);
  if (!e || busyKey === key) return;
  entries = entries.filter(x => x.key !== key);
  showLatest();
  await releaseHold(e);
  sentListeners.forEach(f => f());
}

/** ［取り消す］。返り値は帯に出した結果（画面側の試しのため） */
export async function undo(key: string): Promise<CancelResult | 'ignored'> {
  const e = entries.find(x => x.key === key);
  if (!e || busyKey) return 'ignored';
  if (Date.now() - e.shownAt < IGNORE_MS) return 'ignored';
  clearTimeout(e.timer);
  busyKey = key; showLatest();
  const r = await cancelHold(e);
  busyKey = null;
  entries = entries.filter(x => x.key !== key);
  if (r === 'cancelled') {
    if (restoreListeners.size > 0) restoreListeners.forEach(f => f(e.restore));
    else pendingRestore = e.restore;
    note(UNDO_TEXT.cancelled, 'ok');
  } else {
    // 取り消せなかった＝届いている（か、このあと毎分のジョブが届ける）。内容は戻さない（2件届くのを防ぐ）
    if (r === 'offline') note(UNDO_TEXT.offline, 'warn');
    else if (r === 'gone') note(UNDO_TEXT.gone, 'warn');
    else note(UNDO_TEXT.tooLate, 'warn');
    if (r === 'error') void releaseHold(e);   // 取り消しに失敗したので、待たせずに届ける
    sentListeners.forEach(f => f());
  }
  return r;
}

/** 帯が消えたあと（送信トレイ・自分の吹き出しの「送信待ち」から）取り消す */
export async function undoWaiting(target: { id?: string; batch?: string }, restore: BoardRestore | null): Promise<CancelResult> {
  const r = await cancelHold(target);
  if (r === 'cancelled') {
    if (restore) { if (restoreListeners.size > 0) restoreListeners.forEach(f => f(restore)); else pendingRestore = restore; }
    note(restore ? UNDO_TEXT.cancelled : '送信を取り消しました。', 'ok');
  } else if (r === 'offline') note('通信がつながらないため取り消せません。', 'warn');
  else note(UNDO_TEXT.tooLate, 'warn');
  sentListeners.forEach(f => f());
  return r;
}

/** まだ帯が出ている（＝取り消せる）送信の番号。連絡板の画面が「送信待ち」の行に［取り消す］を出すかどうかに使う */
export function isUndoable(id: string): boolean { return entries.some(e => e.id === id); }

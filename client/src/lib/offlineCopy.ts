// 端末の控え（電波が弱いとき 段6・2026-10-23 ユーザー確定）
//
// 通信があるときに読めた「自分の一覧」（連絡板の受信・送信・アーカイブ、自分の申請の履歴）を端末に控え、
// 圏外・通信の失敗で読めなかったときに出す。圏外の目印は上の黄色い帯（OfflineBand）だけで、「◯時点の控え」の文は出さない。
//
// 🚨 決まり（安全・個人情報の担当と実機の担当のレビュー → ユーザー確定）
//  ・控えを作るのはスマホ・タブレットだけ。パソコン（マウスで操作する端末＝lib/idleLogout の isPointerDevice）では作らない
//    （校舎のパソコンは共有の印が無くても何人かで使う・持ち歩かないので圏外になりにくい）。パソコンに残っていれば消す
//  ・控えるのは自分あて・自分が出した分だけ。他人の情報（宛先・写し・既読の人の一覧・ほかの人の回答）、添付、位置情報は控えない（呼ぶ側で外す）
//  ・鍵は「ユーザーID:種類」。読むときも中の userId を照らし合わせる。14日たった控えは使わない
//  ・消す：ログアウト（hooks/useAuth の handleLogout）・ログインしている人がいなくなった／別の人に変わったとき（contexts/AuthContext）。
//    ログインした人と違う人の控えは、そのときに全部消す（keepOnly）
//  ・IndexedDB が使えない・開くのが止まる（古い iPhone）・容量が足りないときは「控えなし」で黙って続ける（画面を止めない）
//  ・管理者による強制ログアウトでも、その端末が圏外のままの間は控えが見える（電波が戻ってログインが切れた時点で消える・避けられない）
import { isPointerDevice } from './idleLogout';

const DB_NAME = 'fivem-offline-copy';
const STORE = 'copies';
const OPEN_TIMEOUT_MS = 2500;
export const COPY_MAX_AGE_MS = 14 * 86400_000;

/** 控えの種類（鍵の後ろ半分）。種類を足したらここにも */
export type CopyKind =
  | 'leave_history' | 'overtime_own' | 'expense_own' | 'shift_report_own' | 'trip_own'
  | 'board_inbox' | 'board_outbox' | 'board_outbox_archive' | 'board_archive';

interface CopyRow<T> { key: string; userId: string; kind: CopyKind; at: number; data: T }

/** この端末で控えを作ってよいか（スマホ・タブレットだけ） */
export function copiesAllowed(): boolean {
  try { return typeof indexedDB !== 'undefined' && !isPointerDevice(); } catch { return false; }
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase | null>(resolve => {
    let done = false;
    const finish = (db: IDBDatabase | null) => { if (!done) { done = true; resolve(db); } };
    // 🚨 古い iPhone で open が返ってこないことがある。待たずに「控えなし」で続ける
    const timer = setTimeout(() => { console.warn('[offlineCopy] 開くのに時間がかかったので控えを使いません'); finish(null); }, OPEN_TIMEOUT_MS);
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'key' }); };
      req.onsuccess = () => {
        clearTimeout(timer);
        const db = req.result;
        // ほかのタブが版を上げる・消すときは閉じる（止めない）
        db.onversionchange = () => { db.close(); dbPromise = null; };
        finish(db);
      };
      req.onerror = () => { clearTimeout(timer); console.warn('[offlineCopy] 開けませんでした', req.error); finish(null); };
      req.onblocked = () => { clearTimeout(timer); finish(null); };
    } catch (e) { clearTimeout(timer); console.warn('[offlineCopy] 使えません', e); finish(null); }
  }).then(db => { if (!db) dbPromise = null; return db; });
  return dbPromise;
}

function run<R>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<R> | void): Promise<R | null> {
  return openDb().then(db => new Promise<R | null>(resolve => {
    if (!db) { resolve(null); return; }
    try {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req ? (req.result as R) : null);
      tx.onerror = () => { console.warn('[offlineCopy] 読み書きできませんでした', tx.error); resolve(null); };
      tx.onabort = () => resolve(null);
    } catch (e) { console.warn('[offlineCopy] 読み書きできませんでした', e); resolve(null); }
  }));
}

/** 控えを置く（上書き）。パソコンでは何もしない。失敗しても黙って続ける */
export async function saveCopy<T>(userId: string | null | undefined, kind: CopyKind, data: T): Promise<void> {
  if (!userId || !copiesAllowed()) return;
  const row: CopyRow<T> = { key: `${userId}:${kind}`, userId, kind, at: Date.now(), data };
  await run('readwrite', s => s.put(row));
}

/** 控えを読む（無い・14日より古い・別の人・パソコンなら null） */
export async function loadCopy<T>(userId: string | null | undefined, kind: CopyKind): Promise<T | null> {
  if (!userId || !copiesAllowed()) return null;
  const row = await run<CopyRow<T> | undefined>('readonly', s => s.get(`${userId}:${kind}`));
  if (!row || row.userId !== userId || Date.now() - row.at > COPY_MAX_AGE_MS) return null;
  return row.data;
}

/** 控えを全部消す（ログアウト・ログインが無くなったとき・パソコン） */
export async function clearOfflineCopies(): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  await run('readwrite', s => s.clear());
}

/** この人の控えだけ残し、ほかの人の控えは消す（ログインした人が決まったとき）。パソコンでは全部消す */
export async function keepOnlyCopiesOf(userId: string): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  if (!copiesAllowed()) { await clearOfflineCopies(); return; }
  await run('readwrite', s => {
    const req = s.openCursor();
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return;
      const row = cur.value as CopyRow<unknown>;
      if (row.userId !== userId) cur.delete();
      cur.continue();
    };
  });
}

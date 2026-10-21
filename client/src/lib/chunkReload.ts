// 新しい版を出したあと、古い画面のまま別のページを開くと「真っ黒」になる件の対策（2026-10-16）
import { reloadFromNetwork } from './reloadFromNetwork';
//
// 【何が起きていたか】
// ・各ページは別々の部品ファイル（assets/〇〇-ハッシュ.js）に分かれていて、初めて開くときに読み込む
// ・本番に新しい版を出すとファイル名が変わり、古い名前のファイルは無くなる
//   （Vercel は無いファイルにトップページの中身を返す＝JS として読めない）
// ・画面の下に青い「新しいバージョンがあります」が出ている＝まだ古い版。この状態でまだ開いていない
//   ページへ移ると、古い名前を読みに行って失敗し、React が画面の中身をまるごと消す → 背景の黒だけが残る
//
// 【対策】
// ① 読み込めなかったら、1回だけ自動で読み込み直す（URL はもう移った先なので、押したページが新しい版で開く）
// ② それでもだめなら components/AppErrorBoundary が「読み込めませんでした［更新する］」を出す（真っ黒にしない）
//
// 🚨 自動の読み込み直しは「1分に1回まで」。sessionStorage の印で止める（何度も読み込み直す事故を防ぐ）。
//    印が読み書きできない端末では自動で読み込み直さない（止める手段が無いため）。②の案内に任せる
// 🚨 圏外・電波が弱いせいで読めなかったときは読み込み直さない（2026-10-20）。
//    読み込み直すとブラウザの「インターネットに接続されていません」の画面になり、動いていたアプリごと消える。
//    読み込み直す前に、サーバーに届くか（version.json）を確かめる。届かなければ「電波が戻ってから」の案内を出す

const KEY = 'fivem_chunk_reload_at';
const GUARD_MS = 60 * 1000;
let reloadStarted = false;

/** 部品ファイルが読み込めなかったときのエラーか（ブラウザごとに文が違う） */
export function isChunkLoadError(err: unknown): boolean {
  const e = err as { name?: string; message?: string } | null;
  const msg = String(e?.message ?? err ?? '');
  return e?.name === 'ChunkLoadError'
    || /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|is not a valid JavaScript MIME type|Unable to preload CSS/i.test(msg);
}

/** サーバーに届くか（届けば、返ってきた中身は問わない）。圏外・時間切れ（4秒）なら false */
export async function isServerReachable(): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store', signal: ctrl.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** 1分以内にまだ読み込み直していなければ、読み込み直す。読み込み直したら true */
export function reloadOnceForChunkError(): boolean {
  try {
    const last = Number(sessionStorage.getItem(KEY) || 0);
    if (Date.now() - last < GUARD_MS) return false;
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch {
    return false;
  }
  reloadStarted = true;
  // 印つきで開き直す（sw.js が古い写しに逃げず、新しい版を最後まで待つ・2026-10-21 電波 段5）
  reloadFromNetwork();
  return true;
}

export type ChunkRecovery = 'reloading' | 'offline' | 'gave_up';

/** 部品が読めなかったとき：サーバーに届けば1回だけ読み込み直す（'reloading'）／届かなければ何もしない（'offline'）／
 *  届くがもう読み込み直したあと（'gave_up'＝［更新する］の案内） */
export async function recoverFromChunkError(): Promise<ChunkRecovery> {
  if (!(await isServerReachable())) return 'offline';
  return reloadOnceForChunkError() ? 'reloading' : 'gave_up';
}

/** Vite が出す「部品を読み込めなかった」合図を受けて、1回だけ読み込み直す。main.tsx で1回呼ぶ。
 *  🚨 ここでは画面を止めない（preventDefault しない）。読めなかった部品は画面の網（AppErrorBoundary・RouteErrorBoundary）が
 *     受け止め、圏外なら案内を出す。サーバーに届くときだけ、ここで先に読み込み直す（網の案内が一瞬出ても、すぐ読み込み直しになる） */
export function installChunkReloadHandler(): void {
  window.addEventListener('vite:preloadError', () => {
    void recoverFromChunkError();
  });
}

/** この画面で、この仕組みが読み込み直しを始めたか（画面の網が「読めませんでした」を一瞬出さないため）。
 *  🚨 sessionStorage の時刻で見てはいけない。読み込み直したあとの新しい画面でも「直前に読み込み直した」と判定し、
 *     部品がまだ無いとき「読み込んでいます…」のまま止まる（2026-10-20 に試しで踏んだ） */
export function justReloaded(): boolean {
  return reloadStarted;
}

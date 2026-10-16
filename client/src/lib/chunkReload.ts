// 新しい版を出したあと、古い画面のまま別のページを開くと「真っ黒」になる件の対策（2026-10-16）
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

const KEY = 'fivem_chunk_reload_at';
const GUARD_MS = 60 * 1000;

/** 部品ファイルが読み込めなかったときのエラーか（ブラウザごとに文が違う） */
export function isChunkLoadError(err: unknown): boolean {
  const e = err as { name?: string; message?: string } | null;
  const msg = String(e?.message ?? err ?? '');
  return e?.name === 'ChunkLoadError'
    || /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|is not a valid JavaScript MIME type|Unable to preload CSS/i.test(msg);
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
  window.location.reload();
  return true;
}

/** Vite が出す「部品を読み込めなかった」合図を受けて、1回だけ読み込み直す。main.tsx で1回呼ぶ */
export function installChunkReloadHandler(): void {
  window.addEventListener('vite:preloadError', (event) => {
    if (reloadOnceForChunkError()) event.preventDefault();
  });
}

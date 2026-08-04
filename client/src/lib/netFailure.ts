// 通信の失敗をどう扱うかの共通判定と、待ち時間の上限（タイムアウト）。
//
// 🚨 通信失敗を error.message の文字列で判定してはいけない。
//    失敗したときの文章はブラウザごとに違い、
//      Android Chrome : "TypeError: Failed to fetch"
//      Firefox        : "TypeError: NetworkError when attempting to fetch resource."
//      iPhone Safari  : "TypeError: Load failed"      ← "fetch" も "network" も入らない
//    そのため /fetch|network/ で探す書き方では iPhone の失敗を取りこぼす。
//    Supabase は通信そのものが届かなかったとき status に 0 を返すので、そこで判定する。
//
// 🚨 navigator.onLine も当てにしない。
//    これは「アンテナが立っているか」しか見ておらず、災害時の輻輳（繋がりにくい状態）では
//    繋がらないのに true を返す。判定の主役にせず、補助にとどめる。

/** あとで送り直せば通る可能性のある失敗か（＝端末に保留してよいか） */
export function isTransientFailure(status: number | null | undefined, error: unknown): boolean {
  if (!error) return false;
  if (status == null || status === 0) return true;   // 通信が届かなかった（圏外・タイムアウト・CORS）
  if (status === 401) return true;                   // ログインの期限が切れた（入り直せば通る）
  if (status === 408 || status === 429) return true; // 時間切れ・混み合っている
  if (status >= 500) return true;                    // サーバー側の一時的な不調
  return false;                                      // 400番台（権限なし・対象外など）は送り直しても通らない
}

/** 指定ミリ秒で打ち切る AbortSignal。Supabase のクエリに .abortSignal() で渡す。
 *  AbortSignal.timeout() は古い端末に無いことがあるので自前で作る。 */
export function timeoutSignal(ms: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

/** abortSignal を渡せない処理（auth.getSession など）用。
 *  時間内に終わらなければ fallback を返して先へ進む（待ち続けて画面が固まるのを防ぐ）。 */
export function withTimeout<T>(promise: PromiseLike<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const finish = (v: T) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };
    const timer = setTimeout(() => finish(fallback), ms);
    Promise.resolve(promise).then(finish, () => finish(fallback));
  });
}

/** 安否確認の通信に使う上限。災害時に待たされ続けないよう短めにする。 */
export const SAFETY_TIMEOUT_MS = 10000;

/** ログイン時の在籍確認に使う上限。ここが返らないと起動画面から進めないため更に短く。 */
export const AUTH_TIMEOUT_MS = 6000;

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

// ---------------- 送信・読み込みに失敗したときの文（2026-10-20・電波 段2・文言はユーザー確定） ----------------
// 🚨 ブラウザの英語（「TypeError: Load failed」など）をそのまま画面に出さない。
//    「通信」「通信環境の良い場所で」にそろえる（アプリ全体の言い方・ユーザー確定）。安否確認の画面だけは「電波」のまま

/** 通信がつながっていないと分かるとき（端末が圏外と言っている） */
export const SEND_OFFLINE_TEXT = '通信がつながっていないため、送信できませんでした。入力した内容は残っています。通信環境の良い場所で、もう一度送信してください。';
/** 通信が不安定で、届いたか分からないとき */
export const SEND_UNSTABLE_TEXT = '通信が不安定なため、送信できたか確認できませんでした。入力した内容は残っています。履歴に出ていないことを確かめてから、もう一度送信してください。';
/** 1回だけ届ける仕組み（lib/submitOnce）を通した申請で、届いたか分からないとき（2026-10-21 ユーザー確定 案A）。
 *  🚨 「2件届くことはありません」と言えるのは submitOnce を通した送信だけ。それ以外は SEND_UNSTABLE_TEXT を使う */
export function sendUnstableOnceText(button: string): string {
  return `通信が不安定なため、送信できたか確認できませんでした。入力した内容は残っています。通信環境の良い場所で、もう一度［${button}］を押してください。同じ申請が2件届くことはありません。`;
}
/** 押し直して「実は届いていた」と分かったとき（緑の知らせ・2026-10-21 ユーザー確定 案A） */
export const SEND_DELIVERED_TEXT = 'さきほどの申請は届いていました。もう一度送る必要はありません。';
export const SEND_DELIVERED_SUB = '履歴で確認できます';
/** 届いたか分からないまま中身を直して送り直したら、さきほどの申請が届いていたとき（黄色・2026-10-21 ユーザー確定） */
export const SEND_DELIVERED_CHANGED_TEXT = 'さきほどの申請は届いていました。直した内容は送っていません。内容を直す場合は、履歴から取り消して、申請し直してください。';
/** まとめて申請・表入力で、通信の失敗が2回続いたため送らずに止めた行（2026-10-21 ユーザー確定の文） */
export function bulkStoppedText(button: string): string {
  return `通信が不安定なため、送信を中断しました。通信環境の良い場所で、もう一度［${button}］を押してください。`;
}
/** 通信がつながっていないときに、どのページでも上に出す黄色い帯（2026-10-21 電波 段4・ユーザー確定 案C-1） */
export const OFFLINE_BAND_TEXT = '通信がつながっていません。入力した内容は残っています。通信環境の良い場所で、送信してください。';
/** ホームのカード：送信できたか確認できていない申請（2026-10-21 電波 段4・ユーザー確定 案1） */
export function pendingSubmitsTitle(n: number): string {
  return `送信できたか確認できていない申請が${n}件あります`;
}
export const PENDING_SUBMITS_NOTE = '入力した内容は残っています。それぞれの画面を開き、通信環境の良い場所で、もう一度送信してください。同じ申請が2件届くことはありません。';
/** 送信が8秒を過ぎたときの灰色の案内（2026-10-21 ユーザー確定） */
export const SEND_SLOW_TEXT = '通信に時間がかかっています。画面を閉じずにお待ちください。';

/** 履歴を読み込めなかったとき（「ありません」と出さない） */
export const HISTORY_LOAD_FAILED_TEXT = '履歴を読み込めませんでした。通信環境の良い場所で［再読み込み］を押してください。';
/** ホーム・連絡板で、読めなかったのに「ありません」と出さないための文（2026-10-21 電波 段5・HISTORY と同じ形で名詞だけ違う） */
export const NOTICE_LOAD_FAILED_TEXT = 'お知らせを読み込めませんでした。通信環境の良い場所で［再読み込み］を押してください。';
export const BOARD_LOAD_FAILED_TEXT = 'グループ・DMを読み込めませんでした。通信環境の良い場所で［再読み込み］を押してください。';
/** ベルの一覧を読み込めなかったとき */
export const BELL_LOAD_FAILED_TEXT = '通知を読み込めませんでした。通信環境の良い場所で、もう一度開いてください。';

/** 通信のせいの失敗か（Supabase は通信が届かないと status 0・文の頭が「TypeError:」「AbortError:」「FetchError:」になる） */
export function isNetworkFailure(error: unknown, status?: number | null): boolean {
  if (!error) return false;
  if (status === 0) return true;
  if (status != null && (status >= 500 || status === 408 || status === 429)) return true;
  if (status != null) return false;
  const e = error as { name?: string; message?: string; code?: string };
  if (e.name === 'TypeError' || e.name === 'AbortError') return true;
  return /^(TypeError|AbortError|FetchError):/.test(String(e.message ?? '')) && !e.code;
}

/** 送信に失敗したときの文。通信のせいでなければ null（呼ぶ側の今までの文を出す） */
export function sendFailureText(error: unknown, status?: number | null): string | null {
  if (!isNetworkFailure(error, status)) return null;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return SEND_OFFLINE_TEXT;
  return SEND_UNSTABLE_TEXT;
}

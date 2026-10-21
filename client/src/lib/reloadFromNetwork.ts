// 新しい版へ読み込み直す（2026-10-21 電波 段5）。
// URL に印（?_net=1）を付けて開き直すと、sw.js は時間切れで保存した写し（古い版）に逃げず、通信を最後まで待つ。
// 🚨 ふつうの reload だと、電波が遅いときに「読み込み直す→6秒切れで古い写し→また読み込み直す」を繰り返して新しい版に移れない。
//    版が違う・部品が読めないときの読み込み直しは、すべてこれを使う。印はアプリが動き出したらすぐ消す（stripNetReloadParam）
// 🚨 印の名前は public/sw.js の NET_PARAM と同じにする
export const NET_RELOAD_PARAM = '_net';

export function reloadFromNetwork(): void {
  try {
    const u = new URL(window.location.href);
    u.searchParams.set(NET_RELOAD_PARAM, '1');
    window.location.replace(u.toString());
  } catch {
    window.location.reload();
  }
}

/** 起動したら印を URL から消す（履歴やブックマークに残さない） */
export function stripNetReloadParam(): void {
  try {
    const u = new URL(window.location.href);
    if (!u.searchParams.has(NET_RELOAD_PARAM)) return;
    u.searchParams.delete(NET_RELOAD_PARAM);
    window.history.replaceState(window.history.state, '', u.pathname + u.search + u.hash);
  } catch { /* 消せなくても動きは変わらない */ }
}

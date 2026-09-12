// バッジの数字などを「定期的に数え直す」ための共通部品（2026-09-12）
//
// 【なぜ作ったか】
// 実機（スマホのホーム画面から起動）で測ったところ、**30秒ごとに約39本の問い合わせ**が
// 走り続けていた（38.6秒・68.6秒・98.6秒に同じ塊が3回）。
// 🚨 30秒の更新は App.tsx の5か所だけだと思い込んでいたが、実際は**11か所**あり、
//    それぞれが複数の問い合わせを出していた。**数える前に「5本」と報告したのは誤り**だった。
//
// 【この部品がやること】
// 画面を見ていない間（他のアプリに切り替えた・タブを離れた・画面を消した）は数え直しを止め、
// **戻ってきた瞬間に1回だけ読み直す**。
// 🚨 **見ているときの動きは今までとまったく同じ**（すぐ1回 → 以後30秒ごと）。
//    数字が古いまま見えることはない（戻った瞬間に読み直すため）。
//
// 【🚨 使ってはいけないところ】
// **送る処理（安否の回答のキューの掃き出しなど）には使わない。**
// 見ていない間に止めると、オフラインで答えた安否の送信が遅れる。あれは「読む」ではなく「送る」。
//
// 【使い方】
//   const fetchX = useCallback(async () => { … }, [deps]);
//   usePolling(fetchX);
// 🚨 渡す関数は必ず useCallback で包むこと。包まないと毎回の描画で作り直され、
//    そのたびに読み直しが走る（＝直したいことの逆になる）。

import { useEffect } from 'react';

/** 既定の間隔。他のバッジと揃えるためにここ1か所で持つ */
export const POLL_INTERVAL_MS = 30000;

export function usePolling(fn: () => void, intervalMs: number = POLL_INTERVAL_MS): void {
  useEffect(() => {
    let timer: number | undefined;

    const start = () => {
      if (timer === undefined) timer = window.setInterval(fn, intervalMs);
    };
    const stop = () => {
      if (timer !== undefined) { window.clearInterval(timer); timer = undefined; }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        stop();
      } else {
        fn();    // 戻ってきた瞬間に読み直す（古い数字を見せない）
        start();
      }
    };

    fn();        // 従来どおり、まず1回すぐ読む
    // 🚨 最初から隠れた状態（他のタブで開かれた等）なら、間隔は始めない
    if (document.visibilityState !== 'hidden') start();
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => { stop(); document.removeEventListener('visibilitychange', onVisibilityChange); };
  }, [fn, intervalMs]);
}

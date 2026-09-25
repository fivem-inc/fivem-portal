import { useEffect, useRef } from 'react';

/**
 * 確認の枠などが開いたとき、その枠が見える位置まで画面を動かす（2026-09-25）。
 *
 * 【なぜ要るか】
 *   ［確認する］を押すと、その場で下に確認の枠が伸びる作りが多い。ボタンは画面の下端で押すことが多く、
 *   画面が動かないと［送信する］などの最後のボタンが画面の外に出て「押しても何も起きない」ように見える
 *   （残業の表入力・申請の依頼・残業の送信で実際に起きた）。
 *
 * 【使い方】
 *   const boxRef = useScrollIntoViewWhen<HTMLDivElement>(!!confirming);
 *   … <div ref={boxRef}> …確認の枠… </div>
 *
 * 🚨 同じ処理を画面ごとに書き写さない。直すときはここ1か所を直す。
 * block は既定 'center'（枠の上下が見えるように）。カードの中の小さな枠は 'nearest' で十分。
 */
export function useScrollIntoViewWhen<T extends HTMLElement>(active: unknown, block: ScrollLogicalPosition = 'center') {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ behavior: 'smooth', block });
  }, [active, block]);
  return ref;
}

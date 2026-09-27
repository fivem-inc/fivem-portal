// バッジの数え直しを「話題が来たとき」だけにする入口（2026-09-27・通信量の見直し 段1）
//
// 今の usePolling（30 秒ごと）の置き換え。仕組みは lib/refreshBus.ts、計画は docs/計画-自動更新の見直し.md
//
//   const fetchX = useCallback(async () => { … }, [deps]);
//   useRefreshOn(fetchX, BOARD_TOPICS);   // const BOARD_TOPICS = ['board'] as const をモジュールの外側で
//
// 動き：
//   ・画面に出たとき（mount）にすぐ1回読む（usePolling と同じ）
//   ・通知の表に、その話題の新しい行が来たら読む（前面に戻ったとき・3 分の心拍で確かめる）
//   ・全件の数え直し（前面に戻って 10 分以上・心拍で 30 分以上・通知の表が2回読めない）でも読む
//   ・自分の操作のあとの即時の数え直し（*-pending-changed などのイベント）は各フックが今までどおり持つ
// 🚨 渡す関数は必ず useCallback で包む。topics はモジュールの外側の定数にする（毎回作ると購読し直しになる）

import { useEffect } from 'react';
import { subscribe, type RefreshTopic } from '../lib/refreshBus';
import '../lib/badgeLedger';   // 通知の表を読む関数を refreshBus に登録する（読み込むだけでよい）

export function useRefreshOn(fn: () => void, topics: readonly RefreshTopic[]): void {
  useEffect(() => {
    fn();
    return subscribe(topics, fn);
  }, [fn, topics]);
}

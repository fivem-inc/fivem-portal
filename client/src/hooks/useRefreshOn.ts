// バッジの数え直しを「話題が来たとき」だけにする入口（2026-09-27・通信量の見直し 段1）
//
// 今の usePolling（30 秒ごと）の置き換え。仕組みは lib/refreshBus.ts、計画は docs/計画-自動更新の見直し.md
//
//   const fetchX = useCallback(async () => { … }, [deps]);
//   useRefreshOn(fetchX, BOARD_TOPICS, 'board:' + userId);   // const BOARD_TOPICS = ['board'] as const をモジュールの外側で
//
// 動き：
//   ・画面に出たとき（mount）に1回読む。🚨 2026-10-18 から key を渡すと、10分以内に同じ key で読んでいて、
//     そのあとに自分の書き込み（lib/writeWatch）が無ければ読まない（ナビはページを移るたびに付け直されるため・
//     値は hooks/useStickyState で覚えておく）。key を渡さないものは今までどおり毎回読む
//   ・通知の表に、その話題の新しい行が来たら読む（前面に戻ったとき・3 分の心拍で確かめる）
//   ・全件の数え直し（前面に戻って 10 分以上・心拍で 30 分以上・通知の表が2回読めない）でも読む
//   ・自分が書き込んだら（lib/writeWatch）、その話題を 2.5 秒後にまとめて読む
//   ・自分の操作のあとの即時の数え直し（*-pending-changed などのイベント）は各フックが今までどおり持つ
// 🚨 渡す関数は必ず useCallback で包む。topics はモジュールの外側の定数にする（毎回作ると購読し直しになる）

import { useEffect } from 'react';
import { emit, subscribe, type RefreshTopic } from '../lib/refreshBus';
import { setWriteEmitter, writtenSince } from '../lib/writeWatch';
import '../lib/badgeLedger';   // 通知の表を読む関数を refreshBus に登録する（読み込むだけでよい）

setWriteEmitter(keys => emit(keys));

/** ページを移っても読み直さない長さ（ほかの人の操作で減る数字は、最長これだけ遅れる） */
export const MOUNT_FRESH_MS = 10 * 60 * 1000;
const lastRunAt = new Map<string, number>();
const DEDUPE_MS = 1500;

export function useRefreshOn(fn: () => void, topics: readonly RefreshTopic[], key?: string): void {
  useEffect(() => {
    // 🚨 同じ key（ナビとホームの帯など）の読み直しが同時に来たら1回だけ（1.5秒以内の2回目は読まない・値は useStickyState で共有される）
    const run = () => {
      if (key) {
        const prev = lastRunAt.get(key);
        if (prev !== undefined && Date.now() - prev < DEDUPE_MS) return;
        lastRunAt.set(key, Date.now());
      }
      fn();
    };
    const last = key ? lastRunAt.get(key) : undefined;
    const fresh = last !== undefined && Date.now() - last < MOUNT_FRESH_MS && !writtenSince(topics, last);
    if (!fresh) run();
    return subscribe(topics, run);
  }, [fn, topics, key]);
}

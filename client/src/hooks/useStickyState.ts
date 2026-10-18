// ページを移っても値を覚えておく useState（2026-10-18・通信量の見直し 段2）
//
// ナビは各ページの中に書かれていて、ページを移るたびに付け直される。ふつうの useState だと付け直すたびに 0 に戻るので、
// 数え直さないと数字が消える。ここに覚えておけば、付け直しても前の数字のまま出せる（数え直すかは hooks/useRefreshOn の key で決める）。
// 🚨 key には「誰の・どの条件の数字か」を必ず入れる（userId・役職・管理者かなど）。違う人・役職プレビューの数字を出さないため
// 🚨 同じ key を使う部品（ナビとホームの帯）どうしは、同じ値を共有する（片方が数え直すと両方が変わる）

import { useCallback, useEffect, useState } from 'react';

const store = new Map<string, unknown>();
const listeners = new Map<string, Set<(v: unknown) => void>>();

export function useStickyState<T>(key: string, initial: T): [T, (v: T | ((prev: T) => T)) => void] {
  const [value, setLocal] = useState<T>(() => (store.has(key) ? (store.get(key) as T) : initial));
  useEffect(() => {
    if (store.has(key)) setLocal(store.get(key) as T); else setLocal(initial);
    const fn = (v: unknown) => setLocal(v as T);
    if (!listeners.has(key)) listeners.set(key, new Set());
    listeners.get(key)!.add(fn);
    return () => { listeners.get(key)?.delete(fn); };
    // initial は最初の値だけ使う（毎回変わる配列などで付け直さない）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  // useState と同じく、関数を渡すと今の値から次の値を作る
  const set = useCallback((v: T | ((prev: T) => T)) => {
    const next = typeof v === 'function' ? (v as (prev: T) => T)((store.has(key) ? store.get(key) : initial) as T) : v;
    store.set(key, next);
    listeners.get(key)?.forEach(fn => fn(next));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return [value, set];
}

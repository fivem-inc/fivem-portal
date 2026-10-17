// 上のナビの本人の並び（2026-10-17・計画 docs/計画-ナビの並び替え.md の 2b）。
// 🚨 自分では読みに行かない。プロフィールを読むとき（hooks/useAuth の loadProfileOnce）に一緒に読んだ値と、端末の控えを使う。
//    「設定」で並べ替えたときは setMyNavOrderLocal が知らせるので、すぐナビに反映される
import { useEffect, useState } from 'react';
import { MY_NAV_ORDER_EVENT, readMyNavOrder } from './useAuth';

export function useMyNavOrder(userId: string | null | undefined): string[] | null {
  const [order, setOrder] = useState<string[] | null>(() => (userId ? readMyNavOrder(userId) : null));
  useEffect(() => {
    if (!userId) { setOrder(null); return; }
    setOrder(readMyNavOrder(userId));
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ userId: string; navOrder: string[] | null }>).detail;
      if (d && d.userId === userId) setOrder(d.navOrder);
    };
    window.addEventListener(MY_NAV_ORDER_EVENT, on);
    return () => window.removeEventListener(MY_NAV_ORDER_EVENT, on);
  }, [userId]);
  return order;
}

// スマホのナビの2段の本人の選択（2026-10-17）。🚨 自分では読みに行かない（hooks/useAuth の loadProfileOnce と端末の控え）。
// 「設定」で選んだときは setMyNavTwoRowLocal が知らせるので、すぐナビに反映される（useMyNavOrder と同じ形）
import { useEffect, useState } from 'react';
import { MY_NAV_TWO_ROW_EVENT, readMyNavTwoRow } from './useAuth';

export function useMyNavTwoRow(userId: string | null | undefined): boolean | null {
  const [v, setV] = useState<boolean | null>(() => (userId ? readMyNavTwoRow(userId) : null));
  useEffect(() => {
    if (!userId) { setV(null); return; }
    setV(readMyNavTwoRow(userId));
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ userId: string; navTwoRow: boolean | null }>).detail;
      if (d && d.userId === userId) setV(d.navTwoRow);
    };
    window.addEventListener(MY_NAV_TWO_ROW_EVENT, on);
    return () => window.removeEventListener(MY_NAV_TWO_ROW_EVENT, on);
  }, [userId]);
  return v;
}

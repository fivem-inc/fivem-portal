// ホームの新着の印（2026-10-18）。ホーム（App.tsx の Dashboard）が入れ、各帯が読む。部品は components/HomeNew
import { createContext, useContext } from 'react';
import type { HomeFeed } from './homeFeed';

export const HomeNewContext = createContext<{ newKeys: ReadonlySet<string>; feed: HomeFeed | null }>({ newKeys: new Set(), feed: null });
export const useHomeNew = () => useContext(HomeNewContext);

/** この印（key・前方一致も可）が新しいか */
export function isNewKey(newKeys: ReadonlySet<string>, keyOrPrefix: string): boolean {
  if (newKeys.has(keyOrPrefix)) return true;
  for (const k of newKeys) if (k.startsWith(keyOrPrefix)) return true;
  return false;
}

/** この印（前方一致も可）を確認済みか（DB の my_home_feed の acked） */
export function isAckedKey(feed: HomeFeed | null, keyOrPrefix: string): boolean {
  return !!feed?.items.some(i => (i.k === keyOrPrefix || i.k.startsWith(keyOrPrefix)) && i.acked);
}

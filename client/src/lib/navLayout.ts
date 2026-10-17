// ナビの2段目の高さの受け渡し（2026-10-17・計画 docs/計画-ナビの並び替え.md の 2c）
//
// 🚨 ページの上の余白（body の padding-top・--topbar-height・scroll-padding-top）を書くのは App.tsx の PreviewBodyOffset だけ。
//    ナビ（NavBar）は「2段目の分をいくつ足すか」をここに入れるだけにする（書く場所が2つあると取り合いになるため）
// 🚨 2段のスマホでは、縮んで1段になっても余白は変えない（中身が上下に動いて、読んでいる場所を見失わないように）

import { useSyncExternalStore } from 'react';

/** 2段目の高さ（ボタン 44px ＋ 上下の余白） */
export const NAV_ROW2_HEIGHT = 52;

let extraTop = 0;
const listeners = new Set<() => void>();

export function setNavExtraTop(px: number): void {
  if (px === extraTop) return;
  extraTop = px;
  listeners.forEach(l => l());
}

export function useNavExtraTop(): number {
  return useSyncExternalStore(
    cb => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    () => extraTop,
    () => 0,
  );
}

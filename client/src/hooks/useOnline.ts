// 端末が「つながっている」と言っているか（navigator.onLine）。圏外の黄色い帯（OfflineBand）と、
// 圏外の間はボタンを押せなくする所（電波が弱いとき 段6・2026-10-23）が同じこれを使う。
// 🚨 onLine が true でも通らないことがある（電波が混み合う・Wi-Fi のログインのページ）。読み込みの失敗は lib/netFailure の isNetworkFailure で見る
import { useSyncExternalStore } from 'react';

const subscribe = (cb: () => void) => {
  window.addEventListener('online', cb);
  window.addEventListener('offline', cb);
  return () => { window.removeEventListener('online', cb); window.removeEventListener('offline', cb); };
};
const getSnapshot = () => typeof navigator === 'undefined' || navigator.onLine !== false;

export function useOnline(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => true);
}

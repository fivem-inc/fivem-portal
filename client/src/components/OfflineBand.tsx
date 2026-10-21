import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { OFFLINE_BAND_TEXT } from '../lib/netFailure';

/**
 * 通信がつながっていないときの黄色い帯（2026-10-21 電波 段4・ユーザー確定 案C-1）。ログイン後の全ページの上に1つ。
 * ・端末が「圏外」と言っているとき（navigator.onLine === false）だけ出す。つながったら黙って消す（緑の「接続しました」は出さない）
 * ・上のナビは position: fixed なので、帯もナビのすぐ下に固定し、同じ高さの空きを流れの先頭に入れて中身が隠れないようにする
 */
const OfflineBand: React.FC = () => {
  const [offline, setOffline] = useState(() => typeof navigator !== 'undefined' && navigator.onLine === false);
  const bandRef = useRef<HTMLDivElement>(null);
  const [h, setH] = useState(0);

  useEffect(() => {
    const on = () => setOffline(false);
    const off = () => setOffline(true);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);

  useLayoutEffect(() => {
    if (!offline || !bandRef.current) { setH(0); return; }
    const el = bandRef.current;
    const measure = () => setH(el.offsetHeight);
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [offline]);

  if (!offline) return null;
  return (
    <>
      <div style={{ height: h }} aria-hidden="true" />
      <div ref={bandRef} role="status"
        style={{ position: 'fixed', top: 'var(--topbar-height, 60px)', left: 0, right: 0, zIndex: 299,
          background: '#fff3cd', color: '#856404', borderBottom: '1px solid #ffc107',
          fontSize: 13, lineHeight: 1.5, padding: '6px 12px' }}>
        {OFFLINE_BAND_TEXT}
      </div>
    </>
  );
};

export default OfflineBand;

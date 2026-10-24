import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useOnline } from '../hooks/useOnline';
import { OFFLINE_BAND_TEXT } from '../lib/netFailure';

/**
 * 通信がつながっていないときの黄色い帯（2026-10-21 電波 段4・ユーザー確定 案C-1）。ログイン後の全ページの上に1つ。
 * ・端末が「圏外」と言っているとき（navigator.onLine === false）だけ出す。つながったら黙って消す（緑の「接続しました」は出さない）
 * ・上のナビは position: fixed なので、帯もナビのすぐ下に固定し、同じ高さの空きを流れの先頭に入れて中身が隠れないようにする
 * ・🚨 ナビの下に固定している見出し（連絡板・こどもシフト表の帯）は流れの空きでは下がらないので、帯の高さを --offline-band-h に置く。
 *   それらは top: calc(var(--topbar-height, 60px) + var(--offline-band-h, 0px)) にする（2026-10-24 実機：連絡板の見出しが帯に隠れて［＋お知らせ送信］が見えなかった）
 */
const OfflineBand: React.FC = () => {
  // つながっているかは hooks/useOnline（圏外の間にボタンを押せなくする所と共用・2026-10-23）
  const offline = !useOnline();
  // 圏外の間は html に印を付ける。index.css の決まりで、送るボタン（data-net="write"）が灰色になって押せなくなる（段6）
  useEffect(() => {
    const el = document.documentElement;
    if (offline) el.setAttribute('data-offline', '1'); else el.removeAttribute('data-offline');
    return () => el.removeAttribute('data-offline');
  }, [offline]);
  const bandRef = useRef<HTMLDivElement>(null);
  const [h, setH] = useState(0);

  useLayoutEffect(() => {
    if (!offline || !bandRef.current) { setH(0); return; }
    const el = bandRef.current;
    const measure = () => setH(el.offsetHeight);
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [offline]);

  // 帯の高さを、ナビの下に固定している見出しに渡す（--topbar-height は App.tsx の PreviewBodyOffset だけが書くので別の名前にする）
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--offline-band-h', offline ? `${h}px` : '0px');
    return () => { root.style.setProperty('--offline-band-h', '0px'); };
  }, [offline, h]);

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

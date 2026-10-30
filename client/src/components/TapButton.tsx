import React, { useRef } from 'react';

/**
 * 指で押したときに確実に反応するボタン（2026-10-30・連絡板の返信が iPhone で送れなかった件）。
 * ・指：離した瞬間（touchend）に onTap を呼び、preventDefault で iPhone があとから作る click を止める。
 *   止めないと、キーボードが閉じて画面がずれたあとの click が別のボタン（［テンプレートに保存］など）に当たる
 * ・押してから 10px 以上動いた（画面を動かした）・touchcancel のときは呼ばない
 * ・マウス・キーボード（Enter・スペース）は今までどおり click で呼ぶ。指で呼んだ直後の click は無視する（2回呼ばない）
 * ・mousedown の preventDefault：押したときに入力欄からフォーカスを外さない（キーボードを閉じない）
 * 🚨 disabled は使わない（押しても黙って何も起きない形になる）。押せない理由は onTap の中で文にして出す
 */
interface Props {
  onTap: () => void;
  style?: React.CSSProperties;
  children: React.ReactNode;
  /** 圏外の間は押せなくする印（index.css の data-net="write"） */
  netWrite?: boolean;
  ariaDisabled?: boolean;
}

const MOVE_PX = 10;
const CLICK_AFTER_TOUCH_MS = 800;

const TapButton: React.FC<Props> = ({ onTap, style, children, netWrite, ariaDisabled }) => {
  const start = useRef<{ x: number; y: number } | null>(null);
  const touchedAt = useRef(0);
  return (
    <button type="button" data-net={netWrite ? 'write' : undefined} aria-disabled={ariaDisabled || undefined}
      onMouseDown={e => e.preventDefault()}
      onTouchStart={e => { const t = e.touches[0]; start.current = t ? { x: t.clientX, y: t.clientY } : null; }}
      onTouchMove={e => {
        const s = start.current; const t = e.touches[0];
        if (s && t && (Math.abs(t.clientX - s.x) > MOVE_PX || Math.abs(t.clientY - s.y) > MOVE_PX)) start.current = null;
      }}
      onTouchCancel={() => { start.current = null; }}
      onTouchEnd={e => {
        const s = start.current; start.current = null;
        if (!s) return;
        if (e.cancelable) e.preventDefault();
        touchedAt.current = Date.now();
        onTap();
      }}
      onClick={() => { if (Date.now() - touchedAt.current < CLICK_AFTER_TOUCH_MS) return; onTap(); }}
      style={{ touchAction: 'manipulation', ...style }}>
      {children}
    </button>
  );
};

export default TapButton;

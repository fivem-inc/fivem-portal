import React, { useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router-dom';
import { getBand, subscribeBand, undo, hasRestoreListener, UNDO_TEXT } from '../lib/boardSendUndo';
import { backBtn } from '../lib/buttonStyles';

/**
 * 連絡板の「送信しました［取り消す］」の帯（2026-10-26・ユーザー確定：薄緑＝成功のカードと同じ会社の決まりの色・秒数は出さない）。
 * ログイン後の全ページに1つ（App.tsx の ProtectedLayout）。ほかの画面に移っても10秒の時計と送信は続く（lib/boardSendUndo）。
 * ・置き場所は画面の下。グループ・DM の入力欄が出ているときは、連絡板の画面が --board-undo-bottom に入力欄の高さを入れる（入力欄のすぐ上に出る）
 * ・［取り消す］は白に灰色の枠・高さ44px 以上
 */
const BoardUndoBand: React.FC = () => {
  const band = useSyncExternalStore(subscribeBand, getBand, getBand);
  const navigate = useNavigate();
  if (band.mode === 'none') return null;

  const isWarn = band.mode === 'note' && band.tone === 'warn';
  const box: React.CSSProperties = {
    position: 'fixed', left: '50%', transform: 'translateX(-50%)',
    bottom: 'calc(var(--board-undo-bottom, 16px) + env(safe-area-inset-bottom, 0px))',
    zIndex: 1200, width: 'min(480px, calc(100vw - 32px))', boxSizing: 'border-box',
    display: 'flex', alignItems: 'center', gap: 12, padding: '8px 10px 8px 16px', borderRadius: 10,
    background: isWarn ? '#fffbeb' : '#f0fdf4',
    border: `1px solid ${isWarn ? '#fcd34d' : '#86efac'}`,
    color: isWarn ? '#92400e' : '#166534',
    boxShadow: '0 4px 14px rgba(0,0,0,0.15)', fontSize: 14, fontWeight: 600, textAlign: 'left',
  };

  if (band.mode === 'note') {
    return <div role="status" aria-live="polite" style={{ ...box, padding: '12px 16px' }}>{isWarn ? '⚠️ ' : '✓ '}{band.text}</div>;
  }
  return (
    <div role="status" aria-live="polite" style={box}>
      <span style={{ flex: 1 }}>✓ {UNDO_TEXT.sent}</span>
      <button type="button" disabled={band.busy}
        onClick={async () => {
          const r = await undo(band.key);
          // 連絡板の画面を開いていないときは、連絡板へ移って内容を戻す
          if (r === 'cancelled' && !hasRestoreListener()) navigate('/board');
        }}
        style={{ ...backBtn(false), background: '#fff', minHeight: 44, minWidth: 96, padding: '0 16px', fontSize: 14, fontWeight: 700, opacity: band.busy ? 0.6 : 1 }}>
        {band.busy ? '取り消しています…' : '取り消す'}
      </button>
    </div>
  );
};

export default BoardUndoBand;

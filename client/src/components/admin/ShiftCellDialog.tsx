import React, { useEffect, useState } from 'react';
import { backBtn, primaryBtn } from '../../lib/buttonStyles';

// こども・大人シフト表の「マスを直す窓」と「いつから変えますか？」の窓（2026-10-20・docs/計画-シフト表の変え方.md）。
// ・画面の真ん中に出す（前は表のいちばん下に出て、押しても出ないように見えた）
// ・外側を押しても閉じない（続けて何十マスも直すときの押し間違いで、直した内容が消えないように・レビューで決定）
// ・Esc：何も変えていなければ閉じる／変えていれば「取り消しますか」をこの窓の中で聞く
// ・Ctrl+Enter（Mac は ⌘+Enter）＝［この内容にする］
// 🚨 hook はこのファイルに置く（KidsShiftPanel は早期 return があり大きいので、窓の仕組みを足さない）

/** 窓の外枠（背景の暗い幕・真ん中の白い箱・中だけスクロール・背景のスクロールを止める） */
export const ShiftDialogFrame: React.FC<{
  isDarkMode: boolean;
  width?: number;
  labelledBy?: string;
  onKeyDown?: (e: KeyboardEvent) => void;
  children: React.ReactNode;
  footer: React.ReactNode;
}> = ({ isDarkMode, width = 640, labelledBy, onKeyDown, children, footer }) => {
  // 開いている間だけ背景のスクロールを止める（閉じたら元の値に戻す）
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);
  useEffect(() => {
    if (!onKeyDown) return;
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onKeyDown]);
  const cardBg = isDarkMode ? '#343a40' : '#fff';
  const text = isDarkMode ? '#f8f9fa' : '#212529';
  const borderColor = isDarkMode ? '#495057' : '#dee2e6';
  return (
    // 🚨 zIndex 5000：画面下の「新しいバージョンがあります」（4000）より上・確かめの窓（6000）・知らせ（9999）より下
    <div role="dialog" aria-modal="true" aria-labelledby={labelledBy}
      style={{ position: 'fixed', inset: 0, zIndex: 5000, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ width: '100%', maxWidth: width, maxHeight: '90dvh', display: 'flex', flexDirection: 'column', background: cardBg, color: text, borderRadius: 12, border: `1px solid ${borderColor}`, boxShadow: '0 8px 24px rgba(0,0,0,0.25)' }}>
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', padding: '14px 16px', fontSize: 13, textAlign: 'left' }}>
          {children}
        </div>
        <div style={{ borderTop: `1px solid ${borderColor}`, padding: '10px 16px' }}>{footer}</div>
      </div>
    </div>
  );
};

/** マスを直す窓。中身（今までの直す欄）は children で受け取る */
const ShiftCellDialog: React.FC<{
  isDarkMode: boolean;
  heading: React.ReactNode;
  /** 窓を開いてから何か変えたか（Esc のときに聞くかどうか） */
  changed: boolean;
  /** ［直さずに閉じる］：開く前に戻して閉じる */
  onCancel: () => void;
  /** ［この内容にする］：下書きに残して閉じる */
  onDone: () => void;
  children: React.ReactNode;
}> = ({ isDarkMode, heading, changed, onCancel, onDone, children }) => {
  const [askCancel, setAskCancel] = useState(false);
  const onKeyDown = React.useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (changed) setAskCancel(true); else onCancel();
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      onDone();
    }
  }, [changed, onCancel, onDone]);
  return (
    <ShiftDialogFrame isDarkMode={isDarkMode} width={680} labelledBy="shift-edit-heading" onKeyDown={onKeyDown}
      footer={askCancel ? (
        <div style={{ padding: '8px 12px', borderRadius: 8, background: '#fff3cd', border: '1px solid #ffc107', color: '#856404', fontSize: 13 }}>
          このマスの直しを取り消しますか。
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button type="button" style={{ ...backBtn(isDarkMode), flex: 1 }} onClick={() => setAskCancel(false)}>戻る</button>
            <button type="button" style={{ ...primaryBtn({ danger: true }), flex: 1 }} onClick={onCancel}>取り消す</button>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" style={{ ...backBtn(isDarkMode), flex: 1 }} onClick={onCancel}>直さずに閉じる</button>
          <button type="button" style={{ ...primaryBtn(), flex: 2 }} onClick={onDone}>この内容にする</button>
        </div>
      )}>
      <div id="shift-edit-heading">{heading}</div>
      {children}
    </ShiftDialogFrame>
  );
};

export default ShiftCellDialog;

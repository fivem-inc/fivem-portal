// 「文字の大きさ」の選択（2026-10-15 ユーザー確定 A）。しくみは lib/textScale.ts
// 置き場所は「設定」のページ（/account・pages/AccountSettings.tsx）。2026-10-15 ユーザー指示で右上のメニューから移した
import { useState } from 'react';
import { TEXT_SCALES, getTextScale, setTextScale, textScaleSupported } from '../lib/textScale';
import { TOGGLE_BLUE } from '../lib/buttonStyles';

export default function TextScaleChoice({ hintColor = '#888' }: { hintColor?: string }) {
  const [scale, setScale] = useState(getTextScale);

  if (!textScaleSupported()) {
    return (
      <div style={{ fontSize: 12, color: hintColor, lineHeight: 1.6 }}>
        パソコンでは、キーボードの［Ctrl］と［＋］で大きくできます（元に戻すのは［Ctrl］と［0］）。
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', gap: 6 }}>
      {TEXT_SCALES.map(s => {
        const on = scale === s.value;
        return (
          <button key={s.value} type="button"
            onClick={() => { setTextScale(s.value); setScale(s.value); }}
            style={{
              flex: 1, padding: '9px 0', borderRadius: 8, cursor: 'pointer', fontSize: 14,
              border: `1px solid ${TOGGLE_BLUE}`,
              background: on ? TOGGLE_BLUE : 'transparent',
              color: on ? '#fff' : TOGGLE_BLUE,
              fontWeight: on ? 'bold' : 'normal',
            }}>
            {s.label}
          </button>
        );
      })}
    </div>
  );
}

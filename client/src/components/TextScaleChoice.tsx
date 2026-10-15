// 右上の自分のメニューの「文字の大きさ」（2026-10-15 ユーザー確定 A）。しくみは lib/textScale.ts
import { useState } from 'react';
import { TEXT_SCALES, getTextScale, setTextScale, textScaleSupported } from '../lib/textScale';
import { TOGGLE_BLUE } from '../lib/buttonStyles';

export default function TextScaleChoice() {
  const [scale, setScale] = useState(getTextScale);

  if (!textScaleSupported()) {
    return (
      <div style={{ fontSize: 11, color: '#888', lineHeight: 1.5 }}>
        文字を大きくするには、キーボードの［Ctrl］と［＋］を押してください（元に戻すのは［Ctrl］と［0］）。
      </div>
    );
  }

  return (
    <div>
      <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>文字の大きさ（このスマホだけ）</div>
      <div style={{ display: 'flex', gap: 4 }}>
        {TEXT_SCALES.map(s => {
          const on = scale === s.value;
          return (
            <button key={s.value} type="button"
              onClick={() => { setTextScale(s.value); setScale(s.value); }}
              style={{
                flex: 1, padding: '7px 0', borderRadius: 8, cursor: 'pointer', fontSize: 12.5,
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
    </div>
  );
}

import React from 'react';
import { HISTORY_LOAD_FAILED_TEXT } from '../lib/netFailure';

// 履歴を読み込めなかったときの赤い枠と［再読み込み］（2026-10-20・電波 段2）。
// 🚨 読めなかったときに「申請はありません」「申請履歴はありません」と出すと、本人は「消えた」と思って出し直す（2件になる）。
//    読めなかったときはこれを出し、「ありません」は出さない。残業・休暇・交通費の履歴で同じものを使う（文は lib/netFailure の1か所）
// ・枠の色は残業の履歴の読み込み失敗（前からある赤い枠）と同じ。ボタンは赤にしない（赤は差し戻し・安否確認だけ・lib/buttonStyles）

const LoadFailedNotice: React.FC<{ onRetry: () => void; text?: string }> = ({ onRetry, text = HISTORY_LOAD_FAILED_TEXT }) => (
  <div style={{ background: '#f8d7da', border: '1px solid #f5c2c7', borderRadius: 10, padding: '10px 12px', margin: '0 0 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
    <p style={{ margin: 0, fontSize: 13, color: '#842029', lineHeight: 1.6 }}>{text}</p>
    <button type="button" onClick={onRetry}
      style={{ flexShrink: 0, padding: '6px 12px', borderRadius: 8, border: '1px solid #842029', cursor: 'pointer', fontSize: 12, fontWeight: 'bold', background: '#fff', color: '#842029' }}>
      再読み込み
    </button>
  </div>
);

export default LoadFailedNotice;

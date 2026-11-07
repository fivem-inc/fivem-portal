// 前回の入力を戻したときだけ、入力欄の上に出す黄色い1行（2026-11-07 ユーザー確定）。
// ・きっかけ：下書きは黙って戻る作りで、前の続きだと気づかずに送ってエラーになった（マネージャーの方の報告）
// ・出すのは、開いた時点で「人が入力した前回の下書き」が残っていたときだけ（restored）。
//   ほかの画面が中身を入れて開いたとき（表から申請・申請の依頼など）は savePrefillDraft で印が付くので出さない
// ・その下書きが消えたら（［クリア］・送信）消える。clearDraft が DRAFT_CLEARED_EVENT を出す
// 🚨 文はこの1か所だけ（全部の申請の画面で同じ）
import React, { useEffect, useState } from 'react';
import { DRAFT_CLEARED_EVENT } from '../lib/draftStorage';

export const DRAFT_RESTORED_TEXT = '📋 前回の入力の続きを表示しています。';

const DraftRestoredLine: React.FC<{ draftKey: string; restored: boolean; style?: React.CSSProperties }> = ({ draftKey, restored, style }) => {
  const [show, setShow] = useState(restored);
  useEffect(() => {
    const h = (e: Event) => { if ((e as CustomEvent<string>).detail === draftKey) setShow(false); };
    window.addEventListener(DRAFT_CLEARED_EVENT, h);
    return () => window.removeEventListener(DRAFT_CLEARED_EVENT, h);
  }, [draftKey]);
  if (!show) return null;
  // 地の色を決めているので、ダークモードでも同じ見た目（字も濃い色に決める）
  return (
    <div style={{ background: '#fff8e1', borderLeft: '4px solid #f9a825', padding: '8px 10px', marginBottom: 12, color: '#5d4200', fontSize: 13, lineHeight: 1.6, ...style }}>
      {DRAFT_RESTORED_TEXT}
    </div>
  );
};

export default DraftRestoredLine;

// 前回の入力を戻したときだけ、入力欄の上に出す黄色い1行（2026-11-07 ユーザー確定）。
// ・きっかけ：下書きは黙って戻る作りで、前の続きだと気づかずに送ってエラーになった（マネージャーの方の報告）
// ・出すのは、開いた時点で「人が入力した前回の下書き」が残っていたときだけ（restored）。
//   ほかの画面が中身を入れて開いたとき（表から申請・申請の依頼など）は savePrefillDraft で印が付くので出さない
// ・その下書きが消えたら（［クリア］・送信）消える。clearDraft が DRAFT_CLEARED_EVENT を出す
// 🚨 文はこの1か所だけ（全部の申請の画面で同じ）
import React, { useEffect, useState } from 'react';
import { DRAFT_CLEARED_EVENT } from '../lib/draftStorage';

export const DRAFT_RESTORED_TEXT = '📋 前回の入力の続きを表示しています。';
// 送る前の確かめで止めたとき、黄色の1行が出ている画面だけエラーの文に足す（2026-11-07 ユーザー確定 案A）。
// きっかけ：「実際の時刻を入力してください」だけでは、前回の入力が残っているせいだと気づけなかった（マネージャーの方の報告）
export const DRAFT_HINT_TEXT = '前回の入力が残っている場合は、右上の［クリア］を押してから入力し直してください。';
// いま黄色の1行を出している下書きの鍵（画面の中だけ）
const shownKeys = new Set<string>();
// 送る前の確かめで止めたときのエラーの文に使う。通信の失敗などには使わない（［クリア］では直らないため）
export const withDraftHint = (draftKey: string, msg: string): string =>
  msg && shownKeys.has(draftKey) ? `${msg}。${DRAFT_HINT_TEXT}` : msg;

const DraftRestoredLine: React.FC<{ draftKey: string; restored: boolean; style?: React.CSSProperties }> = ({ draftKey, restored, style }) => {
  const [show, setShow] = useState(restored);
  useEffect(() => {
    const h = (e: Event) => { if ((e as CustomEvent<string>).detail === draftKey) setShow(false); };
    window.addEventListener(DRAFT_CLEARED_EVENT, h);
    return () => window.removeEventListener(DRAFT_CLEARED_EVENT, h);
  }, [draftKey]);
  useEffect(() => {
    if (!show) return;
    shownKeys.add(draftKey);
    return () => { shownKeys.delete(draftKey); };
  }, [show, draftKey]);
  if (!show) return null;
  // 地の色を決めているので、ダークモードでも同じ見た目（字も濃い色に決める）
  return (
    <div style={{ background: '#fff8e1', borderLeft: '4px solid #f9a825', padding: '8px 10px', marginBottom: 12, color: '#5d4200', fontSize: 13, lineHeight: 1.6, ...style }}>
      {DRAFT_RESTORED_TEXT}
    </div>
  );
};

export default DraftRestoredLine;

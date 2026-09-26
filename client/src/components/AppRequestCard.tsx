// 「申請の依頼」を受け取った側のカード（2026-09-26）。
//
// 🚨 残業ページ（OvertimePage の履歴タブ）と休暇ページ（LeaveRequest の申請タブ）の**2か所が同じこれを出す**。
//    2026-09-26 まで残業ページの中に直接書かれていて、休暇の依頼でも残業ページに探しに行く作りだった。
//    書き写さないこと（片方だけ直す事故になる）。
// 🚨 「対応しない」の中身（status を dismissed に・上長へベル）は lib/appRequests の dismissAppRequest。
//    ここは理由を選ぶ枠と押した瞬間の確認だけ。
// 🚨 「この依頼から申請」の中身は画面ごとに違う（残業＝下書きを作ってフォームへ／休暇＝日付と申請先を入れる）ので
//    呼び出し側が onStart で行う。書きかけの確認（replacePanel）も呼び出し側が出す。
// 🚨 色は残業ページにあったものをそのまま（新しい色は足さない）。ハイライトは勤怠カレンダーと同じ。

import React, { useState } from 'react';
import { useScrollIntoViewWhen } from '../hooks/useScrollIntoViewWhen';
import { segmentsText } from '../lib/segmentsText';
import { DISMISS_REASONS, DISMISS_OTHER, APP_REQUEST_KIND_LABEL, dismissAppRequest, mdDow } from '../lib/appRequests';
import type { ReceivedAppRequest } from '../lib/appRequests';

interface Props {
  r: ReceivedAppRequest;
  isDark: boolean;
  /** ベル・プッシュから ?focus=<依頼ID> で来たときに光らせる */
  focused?: boolean;
  focusRef?: (el: HTMLDivElement | null) => void;
  /** 「この依頼から申請」のボタンの文字（画面ごとに違う） */
  startLabel: string;
  onStart: () => void;
  /** 書きかけの確認など、呼び出し側がボタンの代わりに出したい枠 */
  replacePanel?: React.ReactNode;
  /** 「対応しない」が成立したあと（一覧から外す） */
  onDismissed: (r: ReceivedAppRequest) => void;
  onError: (message: string) => void;
}

const AppRequestCard: React.FC<Props> = ({ r, isDark, focused = false, focusRef, startLabel, onStart, replacePanel, onDismissed, onError }) => {
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  // 理由を選ぶ枠はカードの中で下に伸びるので、開いたらそこまで動かす（［対応しない］が画面の外に出ないように）
  const boxRef = useScrollIntoViewWhen<HTMLDivElement>(confirming ? r.id : null, 'nearest');
  const borderColor = isDark ? '#495057' : '#dee2e6';
  const subText = isDark ? '#adb5bd' : '#6c757d';
  const textMain = isDark ? '#fff' : '#0d47a1';

  const reset = () => { setConfirming(false); setReason(null); setNote(''); setErr(''); };
  const doDismiss = async () => {
    // 🚨 選んでいないまま消させない（上長に理由が伝わらない）
    if (!reason) { setErr('理由をお選びください'); return; }
    const finalNote = reason === DISMISS_OTHER ? note.trim() : reason;
    if (reason === DISMISS_OTHER && !finalNote) { setErr('理由を入力してください'); return; }
    reset();
    const fail = await dismissAppRequest(r, finalNote);
    if (fail) { onError(fail); return; }
    onDismissed(r);
  };

  return (
    <div ref={el => focusRef?.(el)}
      style={{ background: focused ? (isDark ? '#4a4423' : '#fff9c4') : (isDark ? '#243447' : '#e8f4fd'), border: `1px solid ${focused ? '#f59e0b' : (isDark ? '#3d5166' : '#90caf9')}`, borderRadius: 10, padding: '12px 14px', marginBottom: 8, transition: 'background 0.6s' }}>
      <p style={{ margin: '0 0 6px', fontSize: 13, lineHeight: 1.8, color: textMain }}>
        {r.requester_name ?? ''}さんから、
        {/* 相談した日（任意。空なら出さない。created_at で代用しない＝話した日とずれるため） */}
        {r.consulted_on && `${mdDow(r.consulted_on)}に相談した `}
        {(r.target_dates ?? []).map(mdDow).join('・')}の
        {APP_REQUEST_KIND_LABEL[r.kind] ?? r.kind}について申請のお願いが届いています。
        {r.due_date && <><br />{mdDow(r.due_date)}までに申請してください。</>}
      </p>
      {/* 入る時間と校（シフト調整の決定で作った依頼だけに入る） */}
      {(r.segments ?? []).length > 0 && (
        <p style={{ margin: '0 0 6px', fontSize: 13, fontWeight: 'bold', color: textMain }}>入る時間：{segmentsText(r.segments)}</p>
      )}
      {r.memo && (
        <p style={{ margin: '0 0 8px', padding: '7px 10px', borderRadius: 6, fontSize: 12, lineHeight: 1.7, background: isDark ? '#1b2a3a' : '#fff', color: isDark ? '#dee2e6' : '#495057', whiteSpace: 'pre-wrap' }}>{r.memo}</p>
      )}
      {confirming ? (
        <div ref={boxRef} style={{ padding: '9px 11px', borderRadius: 8, background: isDark ? '#4a3a1a' : '#fff8e1', border: '1px solid #f0c36d', color: isDark ? '#ffcf8f' : '#b7770d' }}>
          <p style={{ margin: '0 0 6px', fontSize: 12, lineHeight: 1.7 }}>対応しない理由をお選びください</p>
          {/* 🚨 色は既存の択一トグルの青（🎨🔒 固定色）。新しい色は足さない */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
            {DISMISS_REASONS.map(v => {
              const active = reason === v;
              return (
                <button key={v} type="button" onClick={() => { setReason(v); setErr(''); }}
                  style={{ padding: '4px 11px', borderRadius: 8, cursor: 'pointer', fontSize: 12, fontWeight: 'bold', border: `2px solid ${active ? '#1565c0' : '#90caf9'}`, background: active ? '#1976d2' : '#e3f2fd', color: active ? '#fff' : '#1565c0' }}>
                  {v}
                </button>
              );
            })}
          </div>
          {reason === DISMISS_OTHER && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 11.5, marginBottom: 5 }}>理由を入力してください</div>
              <textarea value={note} onChange={e => { setNote(e.target.value); setErr(''); }} rows={2} placeholder="例：シフトが変わったため"
                style={{ width: '100%', boxSizing: 'border-box', padding: '7px 9px', borderRadius: 8, border: `1px solid ${borderColor}`, background: isDark ? '#212529' : '#fff', color: isDark ? '#f8f9fa' : '#212529', fontSize: 13, fontFamily: 'inherit' }} />
            </div>
          )}
          {err && <div style={{ fontSize: 11.5, color: '#dc3545', marginBottom: 8 }}>{err}</div>}
          <div style={{ display: 'flex', gap: 6 }}>
            <button type="button" onClick={doDismiss}
              style={{ flex: 1, padding: '8px 0', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 12.5, fontWeight: 'bold', background: '#0d6efd', color: '#fff' }}>対応しない</button>
            <button type="button" onClick={reset}
              style={{ flex: 1, padding: '8px 0', borderRadius: 8, border: `1px solid ${borderColor}`, cursor: 'pointer', fontSize: 12.5, background: 'transparent', color: subText }}>やめる</button>
          </div>
        </div>
      ) : replacePanel ? (
        replacePanel
      ) : (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" onClick={onStart}
            style={{ flex: 1, minWidth: 140, padding: '10px 0', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 'bold', background: '#0d6efd', color: '#fff' }}>{startLabel}</button>
          <button type="button" onClick={() => setConfirming(true)}
            style={{ padding: '10px 16px', borderRadius: 8, border: `1px solid ${borderColor}`, cursor: 'pointer', fontSize: 12.5, background: 'transparent', color: subText }}>対応しない</button>
        </div>
      )}
    </div>
  );
};

export default AppRequestCard;

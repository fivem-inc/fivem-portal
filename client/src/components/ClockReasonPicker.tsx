// 打刻の報告（残業ではない）の「何がありましたか」（2026-10-22 ユーザー確定 案B）
//
// ① 出勤の打刻を忘れた ② 退勤の打刻を忘れた ③ 打刻が遅れた・早かった（残業ではない）の3つから選び、③のときだけ理由を選ぶ。
// 🚨 1件フォーム（OvertimePage）・まとめて申請（OvertimeBox）・表入力（OvertimeGrid）の3か所が同じこの部品を使う。書き写さないこと。
// 🚨 選択肢と並びは lib/overtimeTypes（CLOCK_KINDS・CLOCK_LATE_REASONS）。経理の確認への回答（ClockInquiryResponse）も同じ一覧
// 保存するのは今までどおり理由の文字1つ（①②は「出勤の打刻を忘れた」「退勤の打刻を忘れた」がそのまま入る）。
// ③を押して理由をまだ選んでいない間は、理由は空のまま（この部品が「③を選んだ」ことを覚える）
import React, { useState } from 'react';
import { CLOCK_FORGOT_IN, CLOCK_FORGOT_OUT, CLOCK_KINDS, CLOCK_LATE_REASONS, clockKindOf, type ClockKind } from '../lib/overtimeTypes';

interface Props {
  reason: string;
  other: string;
  /** 理由が変わった。kind は押したもの（①②で隠れる方の打刻時刻を消すのに使う） */
  onPick: (reason: string, kind: ClockKind) => void;
  onOtherChange: (text: string) => void;
  /** 表入力の行の中に置くとき（小さいボタンを横に並べる） */
  compact?: boolean;
  /** 送信前の確認で止まったとき、ここまで画面を動かすための印（1件フォーム） */
  errField?: string;
  /** 「その他」の欄の見た目（呼ぶ側の入力欄にそろえる） */
  otherInputStyle?: React.CSSProperties;
  ariaPrefix?: string;
}

const on = { border: '2px solid #1565c0', background: '#1976d2', color: '#fff' };
const off = { border: '2px solid #90caf9', background: '#e3f2fd', color: '#1565c0' };

const ClockReasonPicker: React.FC<Props> = ({ reason, other, onPick, onOtherChange, compact, errField, otherInputStyle, ariaPrefix = '' }) => {
  const [lateOpen, setLateOpen] = useState(() => clockKindOf(reason) === 'late');
  const kind: ClockKind | null = clockKindOf(reason) ?? (lateOpen ? 'late' : null);

  const big = (sel: boolean): React.CSSProperties => ({
    ...(sel ? on : off), padding: '10px 12px', borderRadius: 10, cursor: 'pointer', textAlign: 'left', fontSize: 13.5, fontWeight: 'bold',
  });
  const small = (sel: boolean): React.CSSProperties => ({
    ...(sel ? on : off), borderWidth: 1, padding: '3px 10px', borderRadius: 8, cursor: 'pointer', fontSize: 12, fontWeight: 'bold',
  });
  const btn = compact ? small : big;
  const req = <span style={{ color: '#dc3545' }}> *</span>;
  const labelStyle: React.CSSProperties = compact
    ? { fontSize: 12, marginBottom: 4 }
    : { display: 'block', fontSize: 13, fontWeight: 'bold', marginBottom: 6 };
  const list: React.CSSProperties = compact
    ? { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 6 }
    : { display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 10 };

  return (
    <div>
      <div style={labelStyle}>何がありましたか？{req}</div>
      <div style={list}>
        {CLOCK_KINDS.map((k, i) => (
          <button key={k.key} type="button" style={btn(kind === k.key)}
            data-err-field={i === 0 ? errField : undefined}
            onClick={() => {
              if (k.key === 'late') {
                setLateOpen(true);
                // ①②から③に変えたら理由を空に（③の理由を選び直してもらう）
                onPick(clockKindOf(reason) === 'late' ? reason : '', 'late');
              } else {
                setLateOpen(false);
                onPick(k.key === 'in' ? CLOCK_FORGOT_IN : CLOCK_FORGOT_OUT, k.key);
              }
            }}>
            {k.label}
          </button>
        ))}
      </div>
      {kind === 'late' && (
        <>
          <div style={labelStyle}>打刻が遅れた・早かった理由{req}</div>
          <div style={list}>
            {CLOCK_LATE_REASONS.map(r => (
              <button key={r} type="button" style={btn(reason === r)} onClick={() => onPick(r, 'late')}>{r}</button>
            ))}
            {compact && reason === 'その他' && (
              <input type="text" value={other} placeholder="例：迎えを待っていた" onChange={e => onOtherChange(e.target.value)}
                style={otherInputStyle} aria-label={`${ariaPrefix}打刻が遅れた・早かった理由（その他）`} />
            )}
          </div>
          {!compact && reason === 'その他' && (
            <input type="text" value={other} placeholder="例：迎えを待っていた" onChange={e => onOtherChange(e.target.value)}
              style={{ ...otherInputStyle, marginBottom: 10 }} aria-label={`${ariaPrefix}打刻が遅れた・早かった理由（その他）`} />
          )}
        </>
      )}
    </div>
  );
};

export default ClockReasonPicker;

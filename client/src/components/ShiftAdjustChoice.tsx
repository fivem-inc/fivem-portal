import React from 'react';
import { TOGGLE_BLUE } from '../lib/buttonStyles';
import { PARTIAL_SHIFT_NOTE } from '../lib/partialShiftAdjust';

// 受理するときの「シフト調整：必要／調整不要」（2026-10-14〜・2026-11-07 ユーザー確定 案A で作り直し）。
// ・🚨 最初はどちらも選ばれていない（notNeeded = null）。選ばずに受理しようとしたら呼ぶ側が止めて missing を立てる
//   （前は終日の休み＝必要・遅出など＝調整不要が最初に選ばれていて、押し忘れが黙ってどちらかになった）
// ・使う所：残業申請（自己受理の確認・まとめて申請・表入力・上長の受理・管理画面の代わりの受理・振替休日の変更）／
//   休暇申請（上長の受理・管理画面の休暇のタブ）。説明の1行は全部同じ（SHIFT_ADJUST_NOTE）
// ・出すのは「シフト調整の記録」の権限（leave_shift_adjust）がある人だけ（呼ぶ側で判定）。DB でも同じ権限を確かめる
// 🚨 文はユーザー確定。変えるときは社内FAQ も確認する
export const SHIFT_ADJUST_NOTE = PARTIAL_SHIFT_NOTE;
/** 選ばずに受理しようとしたときの文（呼ぶ側の赤い文にも使う） */
export const SHIFT_CHOICE_MISSING_TEXT = 'シフト調整の「必要」か「調整不要」を選んでください。';

const ShiftAdjustChoice: React.FC<{
  /** true＝調整不要／false＝必要／null＝まだ選んでいない */
  notNeeded: boolean | null;
  onChange: (notNeeded: boolean) => void;
  isDark: boolean;
  /** 選ばずに受理しようとした（赤い文を出す） */
  missing?: boolean;
  /** 何件分かを見出しに添える（まとめて送るとき） */
  countLabel?: string;
  /** 見出しに添える「四条本校 13:00〜15:00 いない時間」など（遅出・早退・勤務地変更・2026-10-20） */
  detail?: string;
  /** 下の説明の1行（省略で SHIFT_ADJUST_NOTE） */
  note?: string;
  /** 外側の余白（休暇の確認の枠などで変える） */
  margin?: string;
}> = ({ notNeeded, onChange, isDark, missing, countLabel, detail, note, margin }) => {
  const sub = isDark ? '#adb5bd' : '#6c757d';
  const showMissing = !!missing && notNeeded === null;
  return (
    <div style={{ margin: margin ?? '0 0 10px' }}>
      <div style={{ fontSize: 12.5, color: sub, marginBottom: 6 }}>シフト調整{countLabel ? `（${countLabel}）` : ''}{detail ? `（${detail}）` : ''}</div>
      <div style={{ display: 'flex', gap: 8 }}>
        {([[false, '必要'], [true, '調整不要']] as const).map(([v, l]) => {
          const on = notNeeded === v;
          return (
            <button key={l} type="button" onClick={() => onChange(v)} aria-pressed={on}
              style={{ padding: '6px 14px', borderRadius: 16, fontSize: 13, fontWeight: 'bold', cursor: 'pointer',
                border: showMissing ? '1.5px solid #dc3545' : '1.5px solid transparent',
                background: on ? TOGGLE_BLUE : (isDark ? '#1e3a5f' : '#e3f2fd'), color: on ? '#fff' : (isDark ? '#90caf9' : '#1565c0') }}>{l}</button>
          );
        })}
      </div>
      {showMissing && <div style={{ fontSize: 12, color: '#dc3545', marginTop: 6, fontWeight: 'bold' }}>{SHIFT_CHOICE_MISSING_TEXT}</div>}
      <div style={{ fontSize: 11.5, color: sub, marginTop: 6, lineHeight: 1.6 }}>{note ?? SHIFT_ADJUST_NOTE}</div>
    </div>
  );
};

export default ShiftAdjustChoice;

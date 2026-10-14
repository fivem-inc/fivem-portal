import React from 'react';
import { TOGGLE_BLUE } from '../lib/buttonStyles';

// 自分で受理する終日の休み（時間外調整休・振替休日・欠勤）の「シフト調整：必要／調整不要」（2026-10-14 ユーザー確定）。
// ・1件ずつのフォーム・表入力・まとめて申請の確認で使う。初めは［必要］が選ばれている（受理の画面・休暇と同じ）
// ・出すのは「シフト調整の記録」の権限（leave_shift_adjust）がある人だけ（呼ぶ側で判定）。DB でも同じ権限を確かめる
// 🚨 文はユーザー確定。変えるときは社内FAQ も確認する
export const SHIFT_ADJUST_SELF_NOTE = '判断がつかない場合も「必要」を選択してください。マネージャーなどが判断します。';

const ShiftAdjustChoice: React.FC<{
  notNeeded: boolean;
  onChange: (notNeeded: boolean) => void;
  isDark: boolean;
  /** 何件分かを見出しに添える（まとめて送るとき） */
  countLabel?: string;
}> = ({ notNeeded, onChange, isDark, countLabel }) => {
  const sub = isDark ? '#adb5bd' : '#6c757d';
  return (
    <div style={{ margin: '0 0 10px' }}>
      <div style={{ fontSize: 12.5, color: sub, marginBottom: 6 }}>シフト調整{countLabel ? `（${countLabel}）` : ''}</div>
      <div style={{ display: 'flex', gap: 8 }}>
        {([[false, '必要'], [true, '調整不要']] as const).map(([v, l]) => {
          const on = notNeeded === v;
          return (
            <button key={l} type="button" onClick={() => onChange(v)} aria-pressed={on}
              style={{ padding: '6px 14px', borderRadius: 16, fontSize: 13, fontWeight: 'bold', border: 'none', cursor: 'pointer',
                background: on ? TOGGLE_BLUE : (isDark ? '#1e3a5f' : '#e3f2fd'), color: on ? '#fff' : (isDark ? '#90caf9' : '#1565c0') }}>{l}</button>
          );
        })}
      </div>
      <div style={{ fontSize: 11.5, color: sub, marginTop: 6, lineHeight: 1.6 }}>{SHIFT_ADJUST_SELF_NOTE}</div>
    </div>
  );
};

export default ShiftAdjustChoice;

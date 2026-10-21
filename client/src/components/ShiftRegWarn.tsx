import React from 'react';
import { parseSegments } from '../lib/shiftCalc';
import { matchesRegisteredShift, registeredShiftText, type RegisteredShift } from '../lib/shiftRegistered';

/**
 * 勤務変更の「変更前」が登録シフトと違うときの小さな知らせ（2026-10-21 ユーザー確定 案A の③・受理する人の画面）。
 * 管理画面の勤務変更のタブ・勤務変更のページの受理待ち・履歴の3か所で同じものを使う
 */
const ShiftRegWarn: React.FC<{
  reg: RegisteredShift | null;
  r: { original_segments: unknown; original_start: string | null; original_end: string | null; original_outing_start: string | null; original_outing_end: string | null };
  style?: React.CSSProperties;
}> = ({ reg, r, style }) => {
  if (!reg || reg.bands.length === 0) return null;
  const segs = parseSegments(r.original_segments, r.original_start, r.original_end, r.original_outing_start, r.original_outing_end);
  if (segs.length === 0 || matchesRegisteredShift(segs, reg)) return null;
  return (
    <div style={{ display: 'inline-block', fontSize: 11, color: '#856404', background: '#fff3cd', border: '1px solid #ffe08a', borderRadius: 4, padding: '1px 6px', margin: '2px 0', ...style }}>
      ⚠️ 登録シフトは {registeredShiftText(reg)}
    </div>
  );
};

export default ShiftRegWarn;

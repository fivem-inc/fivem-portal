// 勤務変更報告の休憩・実労働の計算。ShiftReportPage（申請）と管理者修正モーダルで共通に使い、
// 計算エンジンの二重化（申請と修正でズレる事故）を防ぐ。
// ※残業(overtime)の breakCalc とは休憩ルールが異なるため別物。

function toMin(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

// 拘束時間帯（出勤〜退勤）から自動休憩を算出する。ShiftReportPage の従来ルールと同一。
export function calcShiftBreakMinutes(start: string, end: string): number {
  const s = toMin(start), d = toMin(end) - s;
  if (d <= 0)               return 0;
  if (d < 255)              return 0;
  if (s >= 780 && d <= 345) return 0;
  if (s >= 780 && d <= 375) return 15;
  if (d <= 390)             return 30;
  if (d <= 525)             return 45;
  return 60;
}

// 実労働 ＝ (退勤 − 出勤) − 休憩 − 外出。負値は0。
export function calcShiftLaborMinutes(
  actStart: string, actEnd: string, breakMin: number,
  outingStart?: string | null, outingEnd?: string | null,
): number {
  const outingMin = outingStart && outingEnd ? Math.max(0, toMin(outingEnd) - toMin(outingStart)) : 0;
  return Math.max(0, (toMin(actEnd) - toMin(actStart)) - breakMin - outingMin);
}

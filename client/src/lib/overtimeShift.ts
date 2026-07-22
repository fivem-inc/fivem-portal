// 残業の通常シフト解決と、時間調整（遅出/早退）受諾時の残業記録フィールド算出を
// 「単一の真実」として集約するモジュール。OvertimePage の申請フォームと、
// 調整提案の受諾処理（OvertimeProposalResponse）で共用し、計算のズレを防ぐ。
import { calcTotalBreak, calcLaborMinutes, resolveDayKind, timeToMin } from './breakCalc';
import type { WorkSegment, DayKind, CalendarKind } from './breakCalc';

export interface PatternRow {
  id: string;
  user_id: string;
  day_kind: DayKind;
  start_time: string | null;
  end_time: string | null;
  start_time2: string | null;
  end_time2: string | null;
  location: string | null;
  break_minutes: number;
  labor_minutes: number;
  valid_from: string;
  valid_to: string | null;
}

export interface NormalShiftSnapshot {
  day_kind: DayKind;
  calendar_kind: CalendarKind | null;
  start_time: string | null;   // "HH:MM:SS" or "HH:MM"
  end_time: string | null;
  start_time2?: string | null;
  end_time2?: string | null;
  location?: string | null;
  break_minutes: number;
  labor_minutes: number;
  manual_override?: boolean;
}

/** "HH:MM:SS" / "HH:MM" → "HH:MM" */
export const fmtTime = (t: string | null | undefined): string => (t ? t.slice(0, 5) : '');

/** 曜日パターンから該当日の通常シフトを解決（OvertimePage のロジックと同一） */
export function resolveNormalShift(
  patterns: PatternRow[], dateStr: string, calendarKind: CalendarKind | null,
): NormalShiftSnapshot {
  const dayKind = resolveDayKind(dateStr, calendarKind);
  const sameKind = patterns.filter(p => p.day_kind === dayKind);
  let row = sameKind.find(p => p.valid_from <= dateStr && (p.valid_to === null || p.valid_to >= dateStr));
  if (!row && sameKind.length > 0) {
    const sorted = [...sameKind].sort((a, b) => (a.valid_from < b.valid_from ? -1 : 1));
    row = dateStr < sorted[0].valid_from ? sorted[0] : sorted[sorted.length - 1];
  }
  return {
    day_kind: dayKind,
    calendar_kind: calendarKind,
    start_time: row?.start_time ?? null,
    end_time: row?.end_time ?? null,
    start_time2: row?.start_time2 ?? null,
    end_time2: row?.end_time2 ?? null,
    location: row?.location ?? null,
    break_minutes: row?.break_minutes ?? 0,
    labor_minutes: row?.labor_minutes ?? 0,
  };
}

export interface TimeAdjustBuild {
  ok: boolean;                 // その日が休み等で調整不能なら false
  normal_shift: NormalShiftSnapshot;
  segments: { start: string; end: string }[]; // planned セグメント（HH:MM）
  break_minutes: number;
  labor_minutes: number;
  diff_minutes: number;        // 労働−通常労働（マイナス＝相殺）
  application_types: string[]; // ['late_start_adj'] | ['early_end_adj']
}

/**
 * 時間調整（遅出/早退）を受諾したときの overtime_reports フィールドを、
 * 申請フォームと同じ計算（通常シフト→実働セグメント→休憩→労働→diff）で組み立てる。
 * kind='late_start' … 出勤を adjustTime まで遅らせる（先頭バンドの開始を置換）
 * kind='early_end'  … 退勤を adjustTime まで早める（末尾バンドの終了を置換）
 */
export function buildTimeAdjustReport(
  patterns: PatternRow[], dateStr: string, calendarKind: CalendarKind | null,
  kind: 'late_start' | 'early_end', adjustTime: string,
): TimeAdjustBuild {
  const ns = resolveNormalShift(patterns, dateStr, calendarKind);
  const bands: { start: string; end: string }[] = [];
  if (ns.start_time && ns.end_time) bands.push({ start: fmtTime(ns.start_time), end: fmtTime(ns.end_time) });
  if (ns.start_time2 && ns.end_time2) bands.push({ start: fmtTime(ns.start_time2), end: fmtTime(ns.end_time2) });

  const empty: TimeAdjustBuild = {
    ok: false, normal_shift: ns, segments: [], break_minutes: 0, labor_minutes: 0, diff_minutes: 0,
    application_types: kind === 'late_start' ? ['late_start_adj'] : ['early_end_adj'],
  };
  if (bands.length === 0 || !adjustTime) return empty;

  const segments = bands.map(b => ({ ...b }));
  if (kind === 'late_start') segments[0].start = adjustTime;               // 出勤を遅く
  else segments[segments.length - 1].end = adjustTime;                     // 退勤を早く

  // 実働セグメント（分）。開始≧終了の逆転は不正としてokにしない
  const work: WorkSegment[] = [];
  for (const s of segments) {
    const st = timeToMin(s.start); let en = timeToMin(s.end);
    if (st == null || en == null) return empty;
    if (en <= st) en += 1440;
    if (en <= st) return empty;
    work.push({ startMin: st, endMin: en });
  }
  const breakMin = calcTotalBreak(work);
  const laborMin = calcLaborMinutes(work, breakMin);
  return {
    ok: true,
    normal_shift: ns,
    segments,
    break_minutes: breakMin,
    labor_minutes: laborMin,
    diff_minutes: laborMin - ns.labor_minutes,
    application_types: kind === 'late_start' ? ['late_start_adj'] : ['early_end_adj'],
  };
}

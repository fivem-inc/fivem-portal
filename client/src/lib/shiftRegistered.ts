// 勤務変更の「変更前（通常シフト）」と登録シフト（曜日ごとのシフト）の照らし合わせ（2026-10-21 ユーザー確定 案A）。
// きっかけ：変更前を手で入れるため、6:15 と打ち間違えた報告がそのまま受理され、差分 −3:00 が給与に出かけた。
// ・出す画面：日付（と対象の人）を選ぶと登録シフトを入れる／違う時刻にすると黄色で知らせる（止めない）
// ・受理する人の画面：違えば「⚠️ 登録シフトは…」を小さく出す
// 🚨 登録シフトの決め方は残業の画面と同じ resolveNormalShift（会社カレンダーの休み・休館も見る）。ここに別の決まりを書かない
import { resolveNormalShift, normalShiftBands, type PatternRow } from './overtimeShift';
import { timeToMin, type CalendarKind } from './breakCalc';

export interface RegisteredShift { bands: { start: string; end: string }[]; location: string | null }

export function registeredShiftFor(patterns: PatternRow[], date: string, calendarKind: CalendarKind | null): RegisteredShift {
  // 🚨 その日に有効な登録シフトだけで決める。resolveNormalShift は有効な行が無いと「いちばん近い期間の行」を使うので、
  //    登録する前の日（例：9/16 から登録した人の 7月）まで今のシフトと比べてしまい、間違った知らせになる
  const valid = patterns.filter(p => p.valid_from <= date && (p.valid_to == null || p.valid_to >= date));
  if (valid.length === 0) return { bands: [], location: null };
  const ns = resolveNormalShift(valid, date, calendarKind);
  return { bands: normalShiftBands(ns).map(b => ({ start: b.start, end: b.end })), location: ns.location ?? null };
}

/** 「9:15〜12:30／14:00〜17:00」 */
export function registeredShiftText(reg: RegisteredShift): string {
  return reg.bands.map(b => `${b.start}〜${b.end}`).join('／');
}

/**
 * 入れた時間帯が登録シフトと同じか。時刻だけを比べる（勤務地は比べない）。
 * 登録シフトが休み（帯なし）のときは比べない＝ true（休日出勤などは登録シフトが無いのが正しい）
 */
export function matchesRegisteredShift(segs: { start: string; end: string }[], reg: RegisteredShift): boolean {
  if (reg.bands.length === 0) return true;
  const key = (list: { start: string; end: string }[]) => list
    .map(s => [timeToMin(s.start), timeToMin(s.end)] as const)
    .filter(([a, b]) => a != null && b != null)
    .sort((x, y) => (x[0] as number) - (y[0] as number))
    .map(([a, b]) => `${a}-${b}`).join(',');
  return key(segs) === key(reg.bands);
}

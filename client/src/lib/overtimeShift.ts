// 残業の通常シフト解決と、時間調整（遅出/早退）受諾時の残業記録フィールド算出を
// 「単一の真実」として集約するモジュール。OvertimePage の申請フォームと、
// 調整提案の受諾処理（OvertimeProposalResponse）で共用し、計算のズレを防ぐ。
import { calcTotalBreak, calcLaborMinutes, calcSegmentBreak, resolveDayKind, timeToMin } from './breakCalc';
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

/** 通常シフトの1つの時間帯。laborMin は「その帯だけ」の労働時間（拘束−自動休憩） */
export interface ShiftBand { start: string; end: string; laborMin: number }

/** 「通常シフト：」のラベル幅。2行目以降のぶら下げを揃えるのに使う
 *  （全角スペースで揃えると端末の文字設定でズレる・折り返しで崩れる） */
export const NS_LABEL_W = '6.2em';

/** 時間帯が複数ある日の合計行の見出し。
 *  🚨 「合計」は使わないこと。このアプリでは「合計時間数」＝今期の過不足（残高）として
 *     定着しており、同じカード内の「合計時間数 −0:45」と読み違える */
export const DAY_LABOR_LABEL = 'この日の労働';

/**
 * 通常シフトの共通形。PatternRow・NormalShiftSnapshot・画面のインライン型のどれでも
 * そのまま渡せるように緩く受ける（型を1つに固定すると呼び出し側で as が増える）
 */
export type ShiftLike = {
  start_time?: string | null;  end_time?: string | null;
  start_time2?: string | null; end_time2?: string | null;
  break_minutes?: number | null; labor_minutes?: number | null;
};

/** "HH:MM:SS" / "HH:MM" → "H:MM"（画面表示用・先頭ゼロなし）
 *  ⚠️ <input type="time"> の value には使わないこと。ゼロ埋めが無いと入力欄が空になる */
export function hmText(t: string | null | undefined): string {
  if (!t) return '';
  const s = t.slice(0, 5);
  const i = s.indexOf(':');
  return i < 0 ? s : `${Number(s.slice(0, i))}:${s.slice(i + 1)}`;
}

/**
 * 通常シフトを時間帯ごとに分解する（休みなら空配列）。
 * ・並びは時刻順。DBの並びは band1→band2 だが、朝が先に来るほうが読みやすい
 * ・laborMin は帯ごとに calcSegmentBreak を当てて引いた「その帯だけ」の労働時間
 *
 * 🚨 laborMin の合計を「その日の労働時間」として画面に出さないこと。
 *    保存済みの labor_minutes と一致しない場合がある
 *    （休暇受理の自動計上行は band2 を保存していないのに labor は band2 込み／
 *      曜日パターンの break_minutes は Excel取込・手入力で再計算値とずれうる）。
 *    合計は必ず保存値（labor_minutes）をそのまま出す。
 */
export function normalShiftBands(ns: ShiftLike | null | undefined): ShiftBand[] {
  if (!ns) return [];
  const out: { st: number; band: ShiftBand }[] = [];
  const add = (s?: string | null, e?: string | null) => {
    if (!s || !e) return;                       // 開始・終了が揃っていない帯は無いものとして扱う
    const st = timeToMin(s.slice(0, 5));
    let en = timeToMin(e.slice(0, 5));
    if (st == null || en == null) return;
    if (en <= st) en += 1440;                   // 日をまたぐ勤務
    if (en <= st) return;
    out.push({ st, band: { start: hmText(s), end: hmText(e), laborMin: (en - st) - calcSegmentBreak(st, en) } });
  };
  add(ns.start_time, ns.end_time);
  add(ns.start_time2, ns.end_time2);
  return out.sort((a, b) => a.st - b.st).map(x => x.band);
}

/** 通常シフトを1行で表す。例 "6:30〜7:15 / 9:30〜17:30"（休みなら空文字）
 *  区切りは実績側（segmentsLabel）と同じ " / " に揃えてある */
export function normalShiftTimeText(ns: ShiftLike | null | undefined): string {
  return normalShiftBands(ns).map(b => `${b.start}〜${b.end}`).join(' / ');
}

/**
 * 勤務日が当日のとき、「実績を報告する」ボタンを出してよい時刻（0時からの分）を返す。
 * ＝「その日の勤務が終わるころ」。通常シフトの終了と予定の終了のうち **早いほう**。
 *   ・残業が無くなって定時で上がった日も、待たずに「残業なし」で報告できる（通常シフト側で決まる）
 *   ・逆に出勤前・勤務中の早すぎる報告は止まる。
 *     🚨「残業なし」報告は誰の確認も通らずその場で確定する（OvertimePage の isPureZero → status='confirmed'）。
 *        朝に押されると実際は残業したのに記録が残らず、本人は修正依頼でしか直せない。
 * 通常シフトが無い日（休日出勤など）は予定の**開始**にフォールバックする（夜まで待たせない）。
 * どちらも取れなければ null ＝ 当日いつでも報告できる（詰まらせない側に倒す）。
 * 🚨 日をまたぐ勤務は 1440 を超える値を返す。当日は出ず、翌日に「勤務日を過ぎた分」として出る。
 */
export function reportGateMin(
  ns: ShiftLike | null | undefined,
  planned: { start_min: number; end_min: number }[],
): number | null {
  const nsEnds: number[] = [];
  const addEnd = (s?: string | null, e?: string | null) => {
    if (!s || !e) return;
    const st = timeToMin(s.slice(0, 5));
    let en = timeToMin(e.slice(0, 5));
    if (st == null || en == null) return;
    if (en <= st) en += 1440;                   // 日をまたぐ勤務
    nsEnds.push(en);
  };
  addEnd(ns?.start_time, ns?.end_time);
  addEnd(ns?.start_time2, ns?.end_time2);
  const nsEnd = nsEnds.length > 0 ? Math.max(...nsEnds) : null;
  // 🚨 seg_no は入力順で振られており「1本目＝最も早い」とは限らない（doSubmit はソートしない）。
  //    必ず min / max で取ること。
  const pStart = planned.length > 0 ? Math.min(...planned.map(s => s.start_min)) : null;
  const pEnd = planned.length > 0 ? Math.max(...planned.map(s => s.end_min)) : null;

  if (nsEnd != null && pEnd != null) return Math.min(nsEnd, pEnd);
  if (nsEnd != null) return nsEnd;
  if (pStart != null) return pStart;
  return null;
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

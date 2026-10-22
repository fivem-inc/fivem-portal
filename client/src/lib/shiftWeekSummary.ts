// シフト表の「週のまとめ」（2026-10-22・docs/計画-シフト表の時間と週休.md）。
// 🚨 supabase を読まない側（画面を開かずに検算できるようにするため）。画面（KidsShiftPanel）は材料を集めてここを呼ぶだけ。
//
// ・決定済みの表（mode='decided'）：勤務時間＝勤務表（いつものシフト）の時間帯。レッスン＝シフト表の担当
// ・作業中の案（mode='plan'）：勤務時間＝担当（と事務の時間）の前後から組み立てる
//     出勤＝最初の担当の pre 分前／退勤＝最後の担当の post 分後。間が gap 分以上空いたら時間帯を分ける。
//     人・曜日ごとに出勤・退勤の時刻を決めていればそちらを使う
// ・休憩は会社の決まり（lib/breakCalc の calcTotalBreak＝残業・勤務表と同じ）で時間帯ごとに引く
// ・レッスン以外＝合計（休憩を引いたあと）− レッスン（重なった時間は1回だけ数える）
// 🚨 週休＝7 − 出勤した曜日の数。目標は「週の目標時間」（正社員だけ・既定40時間）

import { calcTotalBreak } from './breakCalc';
import type { RosterDayKind } from './shiftRoster';

export const WEEK_DAYS: RosterDayKind[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
/** 正社員の週の目標時間の既定（分） */
export const DEFAULT_WEEKLY_TARGET = 40 * 60;
/** 週40時間（法定の目安・目標とは別に数える） */
export const LEGAL_WEEKLY = 40 * 60;

export interface Span { s: number; e: number }
/** 1人の1つの担当の時間 */
export interface DutySpan extends Span {
  /** レッスンに数えるか（行の種類の counts_as_lesson と役割で決まる） */
  lesson: boolean;
  /** どの表の担当か（こども／大人）。勉強会は 'study' */
  source: 'kids' | 'adult' | 'study';
}

export interface DayInput {
  spans: DutySpan[];
  /** 時刻の無い担当（校の役割だけ）がある＝出勤日だが時間が分からない */
  timeless: boolean;
  /** 案の事務の時間 */
  office: Span[];
  /** 案で決めた出勤・退勤の時刻（分）。null＝自動 */
  startAt: number | null;
  endAt: number | null;
  /** 勤務表の時間帯。null＝勤務表に無い・休み */
  roster: Span[] | null;
  /**
   * 案のとき、その日の担当が決定済みの表と比べてどうか（2026-10-22 ユーザー確定：案の時間の元は今の勤務表）。
   * same＝同じ（勤務表のまま）／changed＝変わった（勤務表のまま数え、出勤・退勤を変えるか聞く）／
   * off＝担当が無くなった（休み）／new＝勤務表に無い日に担当が入った（担当の前後で数える）／null＝比べない（仮の人・勤務表の無い方）
   */
  base?: PlanDayBase;
  /**
   * 案：勉強会だけが残った日の勉強会の時間（2026-10-22 ユーザー確定 案A：シフト優先。勉強会は勤務が決まってから組み直すので、休みとして数える）。
   * spans には入れない（＝出勤に数えない）。画面で「勉強会あり」と黄色で添えるだけ
   */
  studyOnly?: Span[];
}

export type PlanDayBase = 'same' | 'changed' | 'off' | 'new' | null;
/** 案で決定済みの表と比べて変わった日の短い呼び名（週のまとめの「出勤」の欄・人ごとの窓） */
export const CHANGE_LABEL = { changed: '担当が変わった', off: '休み', new: '勤務表に無い日' } as const;

export interface WeekSettings { pre: number; post: number; gap: number }

export interface DaySummary {
  working: boolean;
  /** 出勤だが時刻が分からない（校の役割だけの日） */
  timeless: boolean;
  blocks: Span[];
  breakMin: number;
  totalMin: number;
  lessonKids: number;
  lessonAdult: number;
  lessonMin: number;
  otherMin: number;
  /** 出勤・退勤を手で決めた日 */
  manual: boolean;
  /** 案：決定済みの表と比べた変わり方（赤で出す）。same・null は出さない */
  change: 'changed' | 'off' | 'new' | null;
  /** 案：担当が変わった日で、まだ出勤・退勤を決めていないときの「こうしますか」（勤務表の時刻 → 担当から出した時刻） */
  suggest: { fromStart: number; fromEnd: number; start: number; end: number } | null;
  /** その日の勤務表の時間帯（人ごとの窓で「勤務表 9:00〜18:00」と出す）。null＝勤務表に無い・休み */
  roster: Span[] | null;
  /** 案：勉強会だけが残った日の勉強会の時間（休みとして数えている）。無ければ null */
  studyOnly: Span[] | null;
}

export interface WeekSummary {
  days: Record<RosterDayKind, DaySummary>;
  workDays: number;
  offDays: number;
  lessonKids: number;
  lessonAdult: number;
  lessonMin: number;
  otherMin: number;
  totalMin: number;
  /** 週の目標時間（分）。null＝目標なし（パートなど） */
  target: number | null;
  /** 目標まで（目標 − 合計。マイナス＝超えている） */
  remain: number | null;
  /** 週休の前提（案）。null＝前提なし */
  offTarget: number | null;
  offMismatch: boolean;
  /** 1日の目安（分）。null＝出さない */
  dailyTarget: number | null;
  overDailyDays: RosterDayKind[];
  over40: boolean;
}

/** 重なった時間を1つにまとめた長さ */
export function unionMinutes(spans: Span[]): number {
  const sorted = spans.filter(x => x.e > x.s).sort((a, b) => a.s - b.s);
  let total = 0;
  let cur: Span | null = null;
  for (const x of sorted) {
    if (!cur) { cur = { ...x }; continue; }
    if (x.s <= cur.e) { cur.e = Math.max(cur.e, x.e); continue; }
    total += cur.e - cur.s;
    cur = { ...x };
  }
  if (cur) total += cur.e - cur.s;
  return total;
}

const clamp = (m: number) => Math.max(0, Math.min(24 * 60, m));

/** 案の1日の勤務の時間帯（担当・事務の前後から組み立てる） */
export function planBlocks(day: DayInput, set: WeekSettings): Span[] {
  const all = [...day.spans, ...day.office].filter(x => x.e > x.s).sort((a, b) => a.s - b.s);
  if (all.length === 0) {
    if (day.startAt != null && day.endAt != null && day.endAt > day.startAt) return [{ s: day.startAt, e: day.endAt }];
    return [];
  }
  const groups: Span[] = [];
  for (const x of all) {
    const last = groups[groups.length - 1];
    if (last && x.s - last.e < set.gap) last.e = Math.max(last.e, x.e);
    else groups.push({ s: x.s, e: x.e });
  }
  const blocks = groups.map(g => ({ s: clamp(g.s - set.pre), e: clamp(g.e + set.post) }));
  // 手で決めた時刻は、その日の最初の出勤・最後の退勤だけに効く
  if (day.startAt != null) blocks[0].s = day.startAt;
  if (day.endAt != null) blocks[blocks.length - 1].e = day.endAt;
  // 前後を足して重なった時間帯はつなげる（間を短くしたとき）
  const merged: Span[] = [];
  for (const b of blocks.sort((a, c) => a.s - c.s)) {
    const last = merged[merged.length - 1];
    if (last && b.s <= last.e) last.e = Math.max(last.e, b.e);
    else merged.push({ ...b });
  }
  return merged.filter(b => b.e > b.s);
}

/** 重なる・接する時間帯をつなげる */
function mergeSpans(spans: Span[]): Span[] {
  const out: Span[] = [];
  for (const b of spans.filter(x => x.e > x.s).map(x => ({ ...x })).sort((a, c) => a.s - c.s)) {
    const last = out[out.length - 1];
    if (last && b.s <= last.e) last.e = Math.max(last.e, b.e);
    else out.push(b);
  }
  return out;
}

/** 案で、今の勤務表を元にした1日の時間帯（出勤・退勤を決めていればその日の最初・最後に効く・事務の時間は足す） */
export function rosterPlanBlocks(day: DayInput): Span[] {
  const r = (day.roster ?? []).filter(x => x.e > x.s).map(x => ({ ...x })).sort((a, b) => a.s - b.s);
  if (r.length === 0) return [];
  if (day.startAt != null) r[0].s = day.startAt;
  if (day.endAt != null) r[r.length - 1].e = day.endAt;
  return mergeSpans([...r, ...day.office]);
}

/** 案の1日の勤務の時間帯：変わり方（base）で、勤務表を元にするか担当から組み立てるかを決める */
function planDayBlocks(day: DayInput, set: WeekSettings): Span[] {
  const hasRoster = (day.roster ?? []).some(x => x.e > x.s);
  if ((day.base === 'same' || day.base === 'changed') && hasRoster) return rosterPlanBlocks(day);
  // 担当が無くなった日：手で時刻か事務の時間を入れていなければ休み
  if (day.base === 'off' && day.startAt == null && day.endAt == null && day.office.length === 0) return [];
  return planBlocks(day, set);
}

export function daySummary(mode: 'decided' | 'plan', day: DayInput, set: WeekSettings): DaySummary {
  const lessonSpans = day.spans.filter(x => x.lesson);
  const lessonKids = unionMinutes(lessonSpans.filter(x => x.source === 'kids'));
  const lessonAdult = unionMinutes(lessonSpans.filter(x => x.source === 'adult'));
  const lessonMin = unionMinutes(lessonSpans);
  const blocks = mode === 'decided'
    ? (day.roster ?? []).filter(x => x.e > x.s)
    : planDayBlocks(day, set);
  const span = blocks.reduce((a, b) => a + (b.e - b.s), 0);
  const breakMin = blocks.length > 0 ? calcTotalBreak(blocks.map(b => ({ startMin: b.s, endMin: b.e }))) : 0;
  const totalMin = Math.max(0, span - breakMin);
  const working = blocks.length > 0 || day.timeless;
  return {
    working,
    timeless: blocks.length === 0 && day.timeless,
    blocks,
    breakMin,
    totalMin,
    lessonKids,
    lessonAdult,
    lessonMin,
    otherMin: Math.max(0, totalMin - lessonMin),
    manual: mode === 'plan' && (day.startAt != null || day.endAt != null),
    change: mode === 'plan' && day.base && day.base !== 'same' ? day.base : null,
    suggest: mode === 'plan' ? suggestOf(day, set) : null,
    roster: day.roster,
    studyOnly: mode === 'plan' && day.studyOnly && day.studyOnly.length > 0 ? day.studyOnly : null,
  };
}

/** 担当が変わった日の「出勤・退勤をこうしますか」。決めていない日・担当から出した時刻が勤務表と同じ日は null */
function suggestOf(day: DayInput, set: WeekSettings): DaySummary['suggest'] {
  if (day.base !== 'changed' || day.startAt != null || day.endAt != null) return null;
  const r = (day.roster ?? []).filter(x => x.e > x.s).sort((a, b) => a.s - b.s);
  const auto = planBlocks({ ...day, startAt: null, endAt: null }, set);
  if (r.length === 0 || auto.length === 0) return null;
  const fromStart = r[0].s, fromEnd = r[r.length - 1].e, start = auto[0].s, end = auto[auto.length - 1].e;
  if (start === fromStart && end === fromEnd) return null;
  return { fromStart, fromEnd, start, end };
}

export interface PersonTerms {
  /** 週の目標時間（分）。null＝目標なし */
  target: number | null;
  /** 週休の前提（案）。null＝前提なし（決定済みの表） */
  offTarget: number | null;
  /** 1日の目安（分）。null＝目標 ÷ 出勤日数 */
  daily: number | null;
}

export function weekSummary(
  mode: 'decided' | 'plan', days: Record<RosterDayKind, DayInput>, terms: PersonTerms, set: WeekSettings,
): WeekSummary {
  const out = {} as Record<RosterDayKind, DaySummary>;
  for (const d of WEEK_DAYS) out[d] = daySummary(mode, days[d], set);
  const list = WEEK_DAYS.map(d => out[d]);
  const workDays = list.filter(x => x.working).length;
  const totalMin = list.reduce((a, x) => a + x.totalMin, 0);
  const lessonMin = list.reduce((a, x) => a + x.lessonMin, 0);
  const sumWorkTarget = terms.offTarget != null ? 7 - terms.offTarget : workDays;
  const dailyTarget = terms.daily ?? (terms.target != null && sumWorkTarget > 0 ? Math.round(terms.target / sumWorkTarget) : null);
  return {
    days: out,
    workDays,
    offDays: 7 - workDays,
    lessonKids: list.reduce((a, x) => a + x.lessonKids, 0),
    lessonAdult: list.reduce((a, x) => a + x.lessonAdult, 0),
    lessonMin,
    otherMin: list.reduce((a, x) => a + x.otherMin, 0),
    totalMin,
    target: terms.target,
    remain: terms.target == null ? null : terms.target - totalMin,
    offTarget: terms.offTarget,
    offMismatch: terms.offTarget != null && terms.offTarget !== 7 - workDays,
    dailyTarget: mode === 'plan' ? dailyTarget : null,
    overDailyDays: mode === 'plan' && dailyTarget != null ? WEEK_DAYS.filter(d => out[d].totalMin > dailyTarget) : [],
    over40: totalMin > LEGAL_WEEKLY,
  };
}

/** 「8:15」の形（マイナスは付けない） */
export function hm(min: number): string {
  const m = Math.abs(Math.round(min));
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
}

/** 目標まで：「あと 8:15」「8:15 超え」「0:00」（目標どおり＝数字だけ・2026-10-22 ユーザー確定 案1） */
export function remainText(remain: number | null): string {
  if (remain == null) return '—';
  if (remain === 0) return '0:00';
  return remain > 0 ? `あと ${hm(remain)}` : `${hm(remain)} 超え`;
}

/** 時間の入力（「40」「37.5」「37:30」）を分に。読めなければ null */
export function parseHours(text: string): number | null {
  const t = text.trim().replace(/[０-９．：]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  if (!t) return null;
  const m = t.match(/^(\d{1,2}):([0-5]\d)$/);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  if (/^\d{1,2}(\.\d{1,2})?$/.test(t)) return Math.round(Number(t) * 60);
  return null;
}

/** まとめて変えるの対象（役職・今の値・まとめて変えない印）。変わる人と変えない人に分ける */
export interface BulkPerson { id: string; roleId: string | null; current: number | null; keep: boolean; keepReason: string | null }
export function bulkSplit(
  people: BulkPerson[], roleIds: Set<string>, value: number, skipSame: boolean,
): { change: BulkPerson[]; skip: { p: BulkPerson; why: string }[] } {
  const change: BulkPerson[] = [];
  const skip: { p: BulkPerson; why: string }[] = [];
  for (const p of people) {
    if (!p.roleId || !roleIds.has(p.roleId)) continue;
    if (p.keep) { skip.push({ p, why: p.keepReason ? `まとめて変えない：${p.keepReason}` : 'まとめて変えない' }); continue; }
    if (p.current === value) { if (skipSame) skip.push({ p, why: 'すでに同じ' }); continue; }
    change.push(p);
  }
  return { change, skip };
}

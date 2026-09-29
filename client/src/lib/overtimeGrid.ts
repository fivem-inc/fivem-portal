// 残業の「表でまとめて入力」（PCだけ）の判定（2026-09-24）。計画：docs/計画-残業の表入力.md
//
// 🚨 ここは画面の状態を持たない（検算できるように supabase も読まない）。
// 🚨 1件フォームと同じ判定は lib/overtimeSubmit を呼ぶ（ここに書き写さない）。

import { payPeriodEnd, minToTime, checkLegalBreak } from './breakCalc';
import type { WorkSegment, CalendarKind } from './breakCalc';
import { isFullDayReport, OT_TYPE_INFO, canOfferCalendarChoice } from './overtimeTypes';
import type { OvertimeType } from './overtimeTypes';
import {
  canReportOvertime, toWorkSegments, segmentIssuesOf, detectOvertimeTypes, composeApplicationTypes,
  effectiveLocationOf, validateOvertime, overtimePhase, isSameAsNormalShift,
} from './overtimeSubmit';
import type { SegInput, TypeDetect, LateChoice, EarlyChoice } from './overtimeSubmit';
import { buildWorkDiff, fullDayDiffMin, resolveNormalShift, reportGateMin } from './overtimeShift';
import type { NormalShiftSnapshot, PatternRow } from './overtimeShift';
import type { OvertimeStatus } from './overtimeStatus';
import { storedLocationChoice, storedLocationCustom, splitMoveLocation, furikaeOriginCalc, effectiveOtherLocation } from './overtimeFormParts';
import { computeBalance } from './overtimeBalance';
import type { BalanceRow, BalanceSummary } from './overtimeBalance';

/** 給与期間（16日〜翌15日）の日付を順に並べる */
export function periodDates(periodStart: string): string[] {
  const end = payPeriodEnd(periodStart);
  const [y, m, d] = periodStart.split('-').map(Number);
  const out: string[] = [];
  const cur = new Date(y, m - 1, d);
  for (let i = 0; i < 40; i++) {
    const s = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}-${String(cur.getDate()).padStart(2, '0')}`;
    out.push(s);
    if (s >= end) break;
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

/** 表の1行が「何をする日か」 */
export type GridDayKind =
  | 'new_post'        // 何も無い・過ぎた日 → 事後報告
  | 'new_advance'     // 何も無い・先の日 → 事前申請
  | 'new_today'       // 何も無い・今日 → 勤務の開始前なら事前申請／開始後なら事後報告（入れた時刻で決まる）
  | 'beyond_max'      // 何も無い・事前申請の上限より先 → まだ出せない
  | 'report'          // 事前申請あり・報告できる → 実績報告
  | 'report_wait'     // 事前申請あり・まだ報告できない（今日・勤務が終わる前／先の日）
  | 'resubmit'        // 差し戻し → 直して再提出
  | 'form_only'       // 表では扱わない（終日・打刻ズレの申請）→ 1件フォームで
  | 'done'            // 実績の確認待ち・確認済み → 表示だけ
  | 'leave_auto';     // 休暇からの自動計上 → 表示だけ（🚨 一意制約の対象外なので「空」と見せると二重計上になる）

/** 表で使う既存の申請（必要な列だけ） */
export interface GridReport {
  id: string;
  work_date: string;
  status: OvertimeStatus;
  entry_type: 'manual' | 'leave_auto';
  is_post_hoc: boolean;
  application_types: string[] | null;
  location: string | null;
  diff_minutes: number | null;
  break_minutes: number | null;
  break_manual: boolean;
  reason: string | null;
  return_comment: string | null;
  reviewer_id: string | null;
  normal_shift: unknown;
  /** 「開始が遅い／早く終わる理由」で押した事情（adj／event／telework）。札の表記と、開いたときの選択の復元に使う */
  late_situation?: string | null;
  early_situation?: string | null;
  /** 元の申請で本人が選んだ「カレンダーに載せるか」。🚨 実績報告・再提出ではそのまま引き継ぐ（計画 §10-7） */
  show_on_calendar?: boolean | null;
  segments?: { phase: 'planned' | 'actual'; seg_no: number; start_min: number; end_min: number }[];
}

/**
 * 表を読み込んだときと、送る直前に読み直したものが同じか（実績報告・再提出の行で使う）。
 * 🚨 表は長く開きっぱなしになる。その間に上長が受理・差し戻し・修正をしていたら、表の中身は古い。
 *    行の計算に使う項目だけを比べる（時刻の項目は比べない）
 */
export function sameGridReport(a: GridReport, b: GridReport): boolean {
  const pick = (r: GridReport) => JSON.stringify([
    r.status, r.is_post_hoc, [...(r.application_types ?? [])].sort(), r.location ?? '', r.break_minutes ?? null, !!r.break_manual,
    r.reason ?? '', r.reviewer_id ?? null, r.normal_shift ?? null, r.show_on_calendar ?? null,
    [...(r.segments ?? [])].sort((x, y) => (x.phase + x.seg_no).localeCompare(y.phase + y.seg_no)).map(x => [x.phase, x.seg_no, x.start_min, x.end_min]),
  ]);
  return pick(a) === pick(b);
}

/**
 * その日の申請の中から、表に出す1件を選ぶ。
 * ・取消済みは無いものとして扱う（もう一度出せる）
 * ・手入力の申請（manual）を優先。🚨 同じ日に手入力は1件まで（一意制約 uq_overtime_manual_per_day）
 * ・休暇からの自動計上（leave_auto）は、手入力が無い日だけ出す
 */
export function pickDayReport(reports: GridReport[]): { main: GridReport | null; leaveAuto: GridReport | null } {
  const live = reports.filter(r => r.status !== 'cancelled');
  const manual = live.find(r => r.entry_type === 'manual') ?? null;
  const leaveAuto = live.find(r => r.entry_type === 'leave_auto') ?? null;
  return { main: manual, leaveAuto };
}

/** 新しく出す日（事前申請・事後報告）の行か */
export const isNewGridKind = (k: GridDayKind): boolean => k === 'new_post' || k === 'new_advance' || k === 'new_today';

/**
 * 1日の土台（何をする日か・その日の通常シフト・元の申請・依頼・既定の申請先）。
 * 🚨 表入力と［まとめて申請］で同じもの（2026-09-29 表入力の画面の中から移した・中身は1文字も変えていない）
 */
export function buildDayBase<Q extends { requester_id: string }>(a: {
  date: string; today: string; nowMin: number; advanceMaxDate: string;
  patterns: PatternRow[]; calendarKind: CalendarKind | null;
  /** その日の自分の申請（取消も含めてよい） */
  dayReports: GridReport[];
  /** その日への上長からの申請の依頼 */
  request: Q | null;
  /** 新しく出す日の既定の申請先 */
  defaultReviewerId: string;
}) {
  const { date, today, nowMin, advanceMaxDate } = a;
  const ck = a.calendarKind;
  const resolved: NormalShiftSnapshot = resolveNormalShift(a.patterns, date, ck);
  const { main, leaveAuto } = pickDayReport(a.dayReports);
  const planned = (main?.segments ?? []).filter(s => s.phase === 'planned');
  const kind = classifyGridDay({
    date, today, nowMin, advanceMaxDate, main, leaveAuto,
    gateMin: main ? reportGateMin(main.normal_shift as NormalShiftSnapshot | null, planned) : null,
  });
  // 実績報告・再提出で元の申請がシフトを手直ししていれば、その控えで計算する（1件フォームと同じ）
  const snap = main?.normal_shift as NormalShiftSnapshot | null | undefined;
  const ns = (kind === 'report' || kind === 'resubmit') && snap?.manual_override ? snap : resolved;
  // 依頼は新しく出す日の行にだけ付ける（申請が既にある日は、1件フォームの依頼カードから）
  const req = isNewGridKind(kind) ? a.request : null;
  // 🚨 依頼がある日の申請先の既定は「依頼した人」（1件フォームと同じ）。表の上の申請先より先に使う
  const rowDefaultReviewer = req?.requester_id || a.defaultReviewerId;
  return { date, ck, ns, main, leaveAuto, kind, req, rowDefaultReviewer };
}

/**
 * 1行の「何をする日か」を決める。
 * gateMin は lib/overtimeShift の reportGateMin（今日の実績報告を出せる時刻）。
 */
export function classifyGridDay(args: {
  date: string;
  today: string;
  nowMin: number;
  advanceMaxDate: string;
  main: GridReport | null;
  leaveAuto: GridReport | null;
  gateMin: number | null;
}): GridDayKind {
  const { date, today, nowMin, advanceMaxDate, main, leaveAuto, gateMin } = args;
  if (main) {
    const types = main.application_types ?? [];
    if (main.status === 'requested' || main.status === 'request_confirmed') {
      // 終日（調整休・振休・欠勤）の事前申請には実績報告が無い
      if (isFullDayReport(types)) return 'done';
      return canReportOvertime(main, today, nowMin, gateMin) ? 'report' : 'report_wait';
    }
    if (main.status === 'returned') {
      // 表で直せないもの（終日・打刻ズレ）は1件フォームで。🚨 勤務地の移動ありは 2026-09-29 から表で直せる
      if (isFullDayReport(types) || types.includes('clock_only')) return 'form_only';
      return 'resubmit';
    }
    return 'done';
  }
  if (leaveAuto) return 'leave_auto';
  if (date < today) return 'new_post';
  if (date > today) return date > advanceMaxDate ? 'beyond_max' : 'new_advance';
  return 'new_today';
}

/** 行の左に出す種類の札（🚨 送る内容の取り違えを防ぐため、日付のすぐ右に出す） */
export const GRID_KIND_TAG: Record<GridDayKind, string> = {
  new_post: '事後報告',
  new_advance: '事前申請',
  new_today: '今日',
  beyond_max: 'まだ出せない',
  report: '実績報告',
  report_wait: '実績報告はまだ',
  resubmit: '再提出',
  form_only: 'フォームで',
  done: '済み',
  leave_auto: '休暇から自動',
};

// ────────────────────────────────────────────────────────────────
// 第4段：行ごとの入力と計算（2026-09-24）
// ────────────────────────────────────────────────────────────────

/** 1件フォームの自己受理の値（OvertimePage の SELF_REVIEW_VALUE と同じ） */
export const GRID_SELF_REVIEW = '__self__';

/**
 * 新しく出す行の種類（「種類」の列の［時間 ▼］・2026-09-29 ユーザー確定 案A）。
 * 🚨 4回目で「打刻が遅れただけ」、5回目で終日の「時間外調整休」「欠勤」、6回目で「振替休日」を足した
 */
export type GridDayType = 'time' | 'chosei_off' | 'furikae_off' | 'absence' | 'clock_only';

/** 終日の種類（表で扱うもの） */
export type GridFullDayType = 'chosei_off' | 'furikae_off' | 'absence';
export function isGridFullDay(t: GridDayType | null | undefined): t is GridFullDayType {
  return t === 'chosei_off' || t === 'furikae_off' || t === 'absence';
}

/** 「9/5」の形（表の注意の文に使う） */
export function shortMd(date: string): string {
  return `${parseInt(date.slice(5, 7), 10)}/${parseInt(date.slice(8, 10), 10)}`;
}

/** 振替元の日が別の申請で使われているときの文（DB のトリガー FURIKAE_DUP_ORIGIN と同じ言葉・lib/overtimeSubmit の friendlyOvertimeDbError） */
export const FURIKAE_ORIGIN_TAKEN_MSG = '振替元の日には別の申請があります。振替休日は振替元の勤務時間を含むため、その日を別途「休日出勤」等で申請しないでください。';

/**
 * 種類の選択肢（名前・並び・選べない理由）。🚨 表と［まとめて申請］で同じものを使う（ここに1か所）。
 * 選べないものは理由を添えて出す（例「打刻が遅れただけ（休みの日は選べません）」）
 */
export function gridDayTypeOptions(kind: GridDayKind, ns: NormalShiftSnapshot): { value: GridDayType; label: string; disabledReason: string }[] {
  // 打刻ズレは事後報告の新規だけ（1件フォームと同じ）。今日は事後報告として出す（2026-09-29 ユーザー確定）
  const clockNg = kind === 'new_advance' ? '先の日は選べません' : !ns.start_time ? '休みの日は選べません' : '';
  // 終日は出勤予定日だけ（1件フォームと同じ：validateOvertime の終日の枝）。先の日は事前申請・過ぎた日は事後報告・今日は事前申請（ユーザー確定）
  const fullNg = !ns.start_time ? '休みの日は選べません' : '';
  return [
    { value: 'time', label: '時間', disabledReason: '' },
    { value: 'chosei_off', label: '時間外調整休（終日）', disabledReason: fullNg },
    { value: 'furikae_off', label: '振替休日（終日）', disabledReason: fullNg },
    { value: 'absence', label: '欠勤（終日）', disabledReason: fullNg },
    { value: 'clock_only', label: '打刻が遅れただけ', disabledReason: clockNg },
  ];
}

/** 表の1行の入力（端末の下書きにもこの形で保存する） */
export interface RowDraft {
  /** 実績報告・再提出の行を「送る対象」にしたか。🚨 触るまで送らない（何もしないことが送信にならないように） */
  touched: boolean;
  segs: SegInput[];
  reason: string;
  /** 実績報告で予定から変えたときの理由 */
  changeReason: string;
  /** 休憩（分）の手入力。空＝自動 */
  breakMin: string;
  /** 勤務地の選択（校名 or 'その他' or '移動あり'） */
  location: string;
  locationCustom: string;
  /** 勤務地が「移動あり」のときの移動元・移動先の校（2026-09-29）。🚨 古い下書きには無いので読むときは既定値で埋める */
  locMoveStart: string;
  locMoveEnd: string;
  lateChoice: LateChoice | null;
  earlyChoice: EarlyChoice | null;
  /** 新しく出す行だけ。空＝表の上の申請先 */
  reviewerId: string;
  /** 新しく出す行の種類（2026-09-29）。🚨 古い下書きには無いので読むときは「時間」とみなす */
  dayType: GridDayType;
  /** 打刻ズレ：打刻の時刻（任意・参考値）と、打刻が遅くなった理由（CLOCK_ONLY_REASONS・「その他」は自由入力） */
  clockInAt: string;
  clockOutAt: string;
  clockReason: string;
  clockReasonOther: string;
  /** 振替休日：振替元（実際に出勤した日・校・出退勤の時刻）。休憩と労働は時刻から自動（1件フォームと同じ） */
  furikaeOriginDate: string;
  furikaeOriginLocation: string;
  furikaeOriginLocationCustom: string;
  furikaeOriginStart: string;
  furikaeOriginEnd: string;
  /** 「📅 みんなのカレンダーに表示」（2026-09-29 ユーザー確定 案A）。選べる人・事前申請の時間の申請だけ。初期値は表示しない（1件フォームと同じ） */
  showOnCalendar: boolean;
}

/** 分 → 入力欄用の "HH:MM"（時をゼロ埋め・翌日印は外す） */
export function minToInput(min: number): string {
  const [h, m] = minToTime(min).replace('翌', '').split(':');
  return `${h.padStart(2, '0')}:${m}`;
}

/** 通常シフトの帯を入力欄の形に（1件フォームの normalSegs と同じ：1本目→2本目の順・"HH:MM"） */
export function normalSegsOf(ns: NormalShiftSnapshot): SegInput[] {
  const out: SegInput[] = [];
  if (ns.start_time) out.push({ start: (ns.start_time ?? '').slice(0, 5), end: (ns.end_time ?? '').slice(0, 5) });
  if (ns.start_time2) out.push({ start: (ns.start_time2 ?? '').slice(0, 5), end: (ns.end_time2 ?? '').slice(0, 5) });
  return out;
}

/**
 * 勤務地の値 → 選択欄の値（校名なら校名／「A→B」は「移動あり」＋移動元・移動先／それ以外は「その他」＋自由入力）。
 * 🚨 規則は lib/overtimeFormParts（1件フォームと共用・2026-09-29）。ここに書き写さない
 */
export function locationPick(loc: string | null | undefined, workplaces: readonly string[]): { location: string; locationCustom: string; locMoveStart: string; locMoveEnd: string } {
  const l = loc ?? '';
  const m = splitMoveLocation(l);
  return { location: storedLocationChoice(l, [...workplaces]), locationCustom: storedLocationCustom(l, [...workplaces]), locMoveStart: m.start, locMoveEnd: m.end };
}

/** 空の行の入力 */
export const EMPTY_ROW_DRAFT: RowDraft = {
  touched: false, segs: [{ start: '', end: '' }], reason: '', changeReason: '', breakMin: '',
  location: '', locationCustom: '', locMoveStart: '', locMoveEnd: '', lateChoice: null, earlyChoice: null, reviewerId: '',
  dayType: 'time', clockInAt: '', clockOutAt: '', clockReason: '', clockReasonOther: '',
  furikaeOriginDate: '', furikaeOriginLocation: '', furikaeOriginLocationCustom: '', furikaeOriginStart: '', furikaeOriginEnd: '',
  showOnCalendar: false,
};

/**
 * 行の最初の入力。🚨 実績報告・再提出は1件フォームの初期値と同じ（予定の時刻・元の理由・元の休憩・元の勤務地・元の2択）
 */
export function initialRowDraft(kind: GridDayKind, main: GridReport | null, workplaces: readonly string[]): RowDraft {
  if (!main || (kind !== 'report' && kind !== 'resubmit')) return { ...EMPTY_ROW_DRAFT, segs: [{ start: '', end: '' }] };
  const segsAll = main.segments ?? [];
  // 実績報告は予定を、再提出はその申請の今の時間帯（実績があれば実績）を入れる
  const hasActual = segsAll.some(s => s.phase === 'actual');
  const want = kind === 'resubmit' && hasActual ? 'actual' : 'planned';
  const src = segsAll.filter(s => s.phase === want).sort((a, b) => a.seg_no - b.seg_no);
  const t = main.application_types ?? [];
  return {
    ...EMPTY_ROW_DRAFT,
    segs: src.length > 0 ? src.map(s => ({ start: minToInput(s.start_min), end: minToInput(s.end_min) })) : [{ start: '', end: '' }],
    reason: main.reason ?? '',
    // 再提出で選び直すときの初期値は元の申請の値（1件フォームと同じ）
    showOnCalendar: main.show_on_calendar ?? false,
    breakMin: main.break_manual && main.break_minutes != null ? String(main.break_minutes) : '',
    ...locationPick(main.location, workplaces),
    // 保存してある事情（event / telework）があれば押した位置に戻す（1件フォームと同じ）
    lateChoice: t.includes('tardiness') ? 'tardiness' : t.includes('late_start_adj') ? ((main.late_situation as LateChoice | null | undefined) ?? 'adj') : null,
    earlyChoice: t.includes('early_leave') ? 'early_leave' : t.includes('early_end_adj') ? ((main.early_situation as EarlyChoice | null | undefined) ?? 'adj') : null,
  };
}

/** 行の状態。🚨 送るのは 'ok' と 'warn' だけ */
export type RowState =
  | 'view'      // 表示だけ（済み・まだ報告できない・フォームで・休暇から自動・上限より先）
  | 'empty'     // 空（送らない）
  | 'idle'      // 実績報告・再提出で、まだ触っていない（送らない）
  | 'nochange'  // 通常シフトと同じ（送らない。🚨 エラーにしない）
  | 'editing'   // 入力中（その行を触っている間は赤くしない）
  | 'error'     // エラー（送らない）
  | 'warn'      // 注意（送れる）
  | 'ok'        // 送れる
  | 'locked';   // 締め切り後で経理の許可が無い（入力に誤りは無い・送らない。2026-09-29 計画の3回目）

export interface GridRowCalc {
  state: RowState;
  message: string;
  mode: 'advance' | 'posthoc';
  phase: 'planned' | 'actual';
  isReportPhase: boolean;
  isResubmit: boolean;
  workSegments: WorkSegment[];
  breakMin: number;
  laborMin: number;
  diffMin: number;
  legalOk: boolean;
  typeDetect: TypeDetect;
  applicationTypes: OvertimeType[];
  effectiveLocation: string;
  hasChanges: boolean;
  /** 実績報告で予定から変わった項目（時間帯・休憩・勤務地・種別）。修正の記録に残す（1件フォームと同じ言葉） */
  changedAxes: string[];
  isPureZero: boolean;
  reviewerId: string;
  isSelfReview: boolean;
  /** 送ると何になるか（行に出す文字） */
  sendLabel: string;
  /** 打刻ズレ（残業ではありません）の行か。送るときは確認なしで確定・通知なし（1件フォームと同じ） */
  clockOnly: boolean;
  /** 終日（時間外調整休・欠勤）の行ならその種類。🚨 差分（diffMin）は種類ごとの効き（調整休＝−シフト労働／欠勤＝0）、勤務地（effectiveLocation）はシフトの校 */
  fullDayType: GridFullDayType | null;
  /**
   * 「📅 みんなのカレンダーに表示」を出すか（1件フォームの offerCalendarChoice と同じ：選べる人・実績報告以外・canOfferCalendarChoice）。
   * 🚨 出すときだけ本人の選択を保存する。出さないときは今までどおり（新しい行は種類ごとの既定・実績報告と再提出は元の値）
   */
  offerCalendar: boolean;
  /** 振替休日の振替元（保存に使う値）。振替休日の行だけ */
  furikae: { date: string; location: string; start: string; end: string; breakMin: number; laborMin: number; hasTime: boolean } | null;
}

const NOCHANGE_MSG = '通常シフトと同じ内容です。残業・早退・調整など、変更した点を入力してください';

/**
 * 1行ぶんの計算とチェック。🚨 計算・判定は lib/overtimeSubmit（1件フォームと同じ部品）を呼ぶだけ。
 * ns はその日の通常シフト（実績報告・再提出で元の申請がシフトを手直ししていれば、その控え）。
 */
export function computeGridRow(a: {
  kind: GridDayKind;
  date: string;
  today: string;
  nowMin: number;
  advanceMaxDate: string;
  ns: NormalShiftSnapshot;
  main: GridReport | null;
  draft: RowDraft;
  /** 表の上の申請先（新しく出す行の既定） */
  defaultReviewerId: string;
  canSelfReview: boolean;
  /** 表を使っている本人の id（元の申請を自己受理していたかを見るため） */
  selfId: string;
  /** 締め切りを過ぎ、経理の許可も無い（新しく出す行だけに効く） */
  closeLocked: boolean;
  focused: boolean;
  /**
   * 申請先がマネージャー以上か（欠勤の申請先のチェック）。
   * 🚨 必須。DB・受理側（overtime-approve）が止めるのは欠勤の「自己受理」だけで、リーダー宛の欠勤は止まらない＝ここが唯一の網
   */
  reviewerIsManager: (id: string) => boolean;
  /**
   * この日を振替元にしている振替休日の日（すでにある申請・同じ表で入力中のどちらも）。
   * 🚨 振替元の日は別に申請すると二重計上になる（DB のトリガーでも止まる）。入力があればエラーにする
   */
  originOf?: string | null;
  /** 振替休日の行：振替元の日が使えない理由（表が知っている範囲＝すでにある申請・同じ表の別の行）。空なら問題なし */
  furikaeOriginNg?: string;
  /** カレンダーに載せるかを自分で選べる人か（管理画面の設定・1件フォームと同じ）。🚨 必須（渡し忘れると選べる人の選択が黙って消える） */
  canChooseCalendar: boolean;
}): GridRowCalc {
  const { kind, date, today, nowMin, ns, main, draft } = a;
  const isReportPhase = kind === 'report';
  const isResubmit = kind === 'resubmit';
  const isEdit = isReportPhase || isResubmit;
  // 打刻ズレは別の計算（時刻・勤務地・申請先を持たない）
  const isNewKind = kind === 'new_post' || kind === 'new_today' || kind === 'new_advance';
  // 振替元の日（6回目）：入力していればエラー。空・通常シフトと同じ日はそのまま
  if (!isEdit && isNewKind && a.originOf) {
    const inner = computeGridRow({ ...a, originOf: null });
    if (inner.state === 'empty' || inner.state === 'nochange') return inner;
    return { ...inner, state: a.focused ? 'editing' : 'error', message: `この日は ${shortMd(a.originOf)} の振替休日の振替元です。別途申請しないでください（二重計上になります）` };
  }
  if (!isEdit && isNewKind && (draft.dayType ?? 'time') === 'clock_only') return computeClockOnlyRow(a);
  if (!isEdit && isNewKind && isGridFullDay(draft.dayType)) return computeFullDayRow(a, draft.dayType);
  const segments = draft.segs;
  const workSegments = toWorkSegments(segments);
  const breakManual = draft.breakMin.trim() !== '';
  const diff = buildWorkDiff(workSegments, ns, breakManual ? (parseInt(draft.breakMin, 10) || 0) : null);
  const legal = checkLegalBreak(workSegments, diff.break_minutes);
  const effectiveLocation = effectiveLocationOf(draft.location, draft.locationCustom, draft.locMoveStart ?? '', draft.locMoveEnd ?? '');
  const typeDetect = detectOvertimeTypes({ hasDate: true, workSegments, normalShift: ns, effectiveLocation });
  const applicationTypes = composeApplicationTypes({ typeDetect, lateChoice: draft.lateChoice, earlyChoice: draft.earlyChoice, fullDay: false, fullDayType: null });

  // 事前か事後か。🚨 今日の新しい行は「入れた開始時刻」で決める（1件フォームの当日の事後報告チェックと同じ基準）
  let mode: 'advance' | 'posthoc';
  if (kind === 'new_advance') mode = 'advance';
  else if (kind === 'new_today') {
    const startMin = workSegments.length > 0 ? Math.min(...workSegments.map(s => s.startMin)) : Infinity;
    mode = nowMin >= startMin ? 'posthoc' : 'advance';
  } else if (isEdit && main) mode = main.is_post_hoc ? 'posthoc' : 'advance';
  else mode = 'posthoc';
  const phase = overtimePhase({ mode, isReportPhase, isResubmit, editTarget: isEdit ? main : null });

  // 実績報告の「予定から変わったか」。🚨 基準は保存値ではなく、予定を入れ直して同じ部品で計算した値（1件フォームと同じ）
  const changedAxes: string[] = [];
  if (isReportPhase && main) {
    const baseDraft = initialRowDraft('report', main, []);
    const baseWS = toWorkSegments(baseDraft.segs);
    const baseBreak = buildWorkDiff(baseWS, ns, baseDraft.breakMin.trim() !== '' ? (parseInt(baseDraft.breakMin, 10) || 0) : null).break_minutes;
    const baseTypes = composeApplicationTypes({
      typeDetect: detectOvertimeTypes({ hasDate: true, workSegments: baseWS, normalShift: ns, effectiveLocation: main.location ?? '' }),
      lateChoice: baseDraft.lateChoice, earlyChoice: baseDraft.earlyChoice, fullDay: false, fullDayType: null,
    });
    const live = [...workSegments].sort((x, y) => x.startMin - y.startMin);
    const bs = [...baseWS].sort((x, y) => x.startMin - y.startMin);
    if (live.length !== bs.length || live.some((x, i) => x.startMin !== bs[i].startMin || x.endMin !== bs[i].endMin)) changedAxes.push('時間帯');
    if (diff.break_minutes !== baseBreak) changedAxes.push('休憩');
    if (effectiveLocation !== (main.location ?? '')) changedAxes.push('勤務地');
    if (JSON.stringify([...applicationTypes].sort()) !== JSON.stringify([...baseTypes].sort())) changedAxes.push('種別');
  }
  const hasChanges = changedAxes.length > 0;
  const isPureZero = isReportPhase && diff.diff_minutes === 0 && applicationTypes.length === 0;

  // 申請先：実績報告・再提出は元の申請のまま（固定）。新しい行は行の指定 → 表の上
  const reviewerId = isEdit ? (main?.reviewer_id ?? '') : (draft.reviewerId || a.defaultReviewerId);
  // 🚨 元の事前申請を自己受理していた（申請先が本人）なら、実績報告も自己受理＝送った時点で確定（2026-09-25 ユーザー確定）。
  //    以前は「確認待ち」になり、本人が受理ページで自分の実績を確認し直していた（26件）。1件フォームと同じ判定
  const isSelfReview = reviewerId === GRID_SELF_REVIEW
    || (isReportPhase && a.canSelfReview && !!main && !!main.reviewer_id && main.reviewer_id === a.selfId);

  const sendLabel =
    isReportPhase ? (isPureZero ? '実績報告・残業なし（すぐ確定）' : hasChanges ? '実績報告（変更あり）' : '実績報告（予定どおり）')
    : isResubmit ? `再提出（${phase === 'actual' ? '事後として' : '事前申請として'}）`
    : mode === 'advance' ? '事前申請' : '事後報告';

  const calc = {
    message: '', mode, phase, isReportPhase, isResubmit, workSegments,
    breakMin: diff.break_minutes, laborMin: diff.labor_minutes, diffMin: diff.diff_minutes, legalOk: legal.ok,
    typeDetect, applicationTypes, effectiveLocation, hasChanges, changedAxes, isPureZero, reviewerId, isSelfReview, sendLabel,
    clockOnly: false, fullDayType: null, furikae: null,
    offerCalendar: a.canChooseCalendar && !isReportPhase && canOfferCalendarChoice(applicationTypes, mode === 'posthoc'),
  };

  const editable: GridDayKind[] = ['new_post', 'new_advance', 'new_today', 'report', 'resubmit'];
  if (!editable.includes(kind)) return { ...calc, state: 'view' };
  const anyInput = segments.some(s => s.start || s.end) || draft.reason.trim() !== '';
  if (!isEdit && !anyInput) return { ...calc, state: 'empty' };
  if (isEdit && !draft.touched) return { ...calc, state: 'idle' };
  // 🚨 通常シフトと同じ日は、理由を書く前でも「変更なし（送らない）」。エラーにしない
  //    （スプレッドシートに慣れた人は普段どおりの日も時間を書くため。判定は1件フォームと同じ関数）
  if (!isEdit && isSameAsNormalShift({ segments, normalSegs: normalSegsOf(ns), breakManual, effectiveLocation, normalShift: ns })) {
    return { ...calc, state: 'nochange', message: '通常シフトと同じ（送りません）' };
  }

  const message = validateOvertime({
    date, mode, hasEditTarget: isEdit, today, advanceMaxDate: a.advanceMaxDate,
    // 🚨 締め切りは最後に見る（ほかの入力の誤りを先に出すため）。表では「エラー」ではなく「許可待ち」（locked）
    closeLocked: false, clockOnlyMode: false, normalShift: ns,
    clockReason: '', clockReasonOther: '', fullDay: false, fullDayType: null, fdLocation: '',
    furikaeOriginDate: '', furikaeOriginLocation: '', furikaeOriginLocationCustom: '', furikaeOriginStart: '', furikaeOriginEnd: '', furikaeHasTime: false,
    reason: draft.reason, reviewerId, isSelfReview, canSelfReview: a.canSelfReview,
    segments, workSegments, segmentIssues: segmentIssuesOf(segments),
    isTodayPostHoc: mode === 'posthoc' && !isEdit && date === today, nowMin,
    breakManual, breakManualMin: draft.breakMin,
    location: draft.location, locationCustom: draft.locationCustom, locMoveStart: draft.locMoveStart ?? '', locMoveEnd: draft.locMoveEnd ?? '', effectiveLocation,
    normalSegs: normalSegsOf(ns), isReportPhase, hasChanges, isPureZero, changeReason: draft.changeReason,
    typeDetect, lateChoice: draft.lateChoice, earlyChoice: draft.earlyChoice,
  });
  // 🚨 自己受理はマネージャー以上だけ（1件フォームは選択肢自体を出さない。表でも同じ判定を通す）
  const selfBlocked = !isEdit && isSelfReview && !a.canSelfReview ? '自己受理はマネージャー以上のみです' : '';
  const msg = message || selfBlocked;
  if (msg === NOCHANGE_MSG) return { ...calc, state: 'nochange', message: '通常シフトと同じ（送りません）' };
  if (msg) return { ...calc, state: a.focused ? 'editing' : 'error', message: msg };
  if (!isEdit && a.closeLocked) return { ...calc, state: 'locked', message: '締め切り後のため、経理の許可が要ります（表の上から依頼できます）' };
  if (!legal.ok) return { ...calc, state: 'warn', message: '休憩が法定より短い（送れます）' };
  return { ...calc, state: 'ok' };
}

/**
 * 打刻ズレ（残業ではありません・打刻が遅れただけ）の行（2026-09-29・計画の4回目）。
 * 🚨 1件フォームと同じ：勤務時間は通常シフトどおり・差分0・事後報告・確認なしで確定・申請先なし。打刻の時刻は参考値で計算に使わない。
 *    判定は validateOvertime の打刻ズレの枝、保存は buildOvertimeRecord の打刻ズレの枝（どちらも1件フォームと共用）
 */
function computeClockOnlyRow(a: Parameters<typeof computeGridRow>[0]): GridRowCalc {
  const { kind, date, today, nowMin, ns, draft } = a;
  const normalSegs = normalSegsOf(ns);
  const workSegments = toWorkSegments(normalSegs);
  const mode = 'posthoc' as const;
  const phase = overtimePhase({ mode, isReportPhase: false, isResubmit: false, editTarget: null });
  const effectiveLocation = ns.location ?? '';
  const typeDetect = detectOvertimeTypes({ hasDate: true, workSegments, normalShift: ns, effectiveLocation });
  const calc = {
    message: '', mode, phase, isReportPhase: false, isResubmit: false, workSegments,
    breakMin: ns.break_minutes, laborMin: ns.labor_minutes, diffMin: 0, legalOk: true,
    typeDetect, applicationTypes: ['clock_only'] as OvertimeType[], effectiveLocation, hasChanges: false, changedAxes: [] as string[],
    isPureZero: false, reviewerId: '', isSelfReview: false, sendLabel: '打刻ズレの記録（確定）', clockOnly: true, fullDayType: null, furikae: null,
    offerCalendar: false,
  };
  const ng = gridDayTypeOptions(kind, ns).find(o => o.value === 'clock_only')?.disabledReason ?? '';
  const message = ng ? '打刻が遅れただけは選べません（' + ng + '）' : validateOvertime({
    date, mode, hasEditTarget: false, today, advanceMaxDate: a.advanceMaxDate,
    // 🚨 締め切りは最後に見る（時間の行と同じ）
    closeLocked: false, clockOnlyMode: true, normalShift: ns,
    clockReason: draft.clockReason ?? '', clockReasonOther: draft.clockReasonOther ?? '', fullDay: false, fullDayType: null, fdLocation: '',
    furikaeOriginDate: '', furikaeOriginLocation: '', furikaeOriginLocationCustom: '', furikaeOriginStart: '', furikaeOriginEnd: '', furikaeHasTime: false,
    reason: '', reviewerId: '', isSelfReview: false, canSelfReview: a.canSelfReview,
    segments: normalSegs, workSegments, segmentIssues: segmentIssuesOf(normalSegs),
    isTodayPostHoc: false, nowMin,
    breakManual: false, breakManualMin: '',
    location: '', locationCustom: '', locMoveStart: '', locMoveEnd: '', effectiveLocation,
    normalSegs, isReportPhase: false, hasChanges: false, isPureZero: false, changeReason: '',
    typeDetect, lateChoice: null, earlyChoice: null,
  });
  if (message) return { ...calc, state: a.focused ? 'editing' : 'error', message };
  if (a.closeLocked) return { ...calc, state: 'locked', message: '締め切り後のため、経理の許可が要ります（表の上から依頼できます）' };
  return { ...calc, state: 'ok' };
}

/**
 * 終日（時間外調整休・欠勤）の行（2026-09-29・計画の5回目）。
 * 🚨 1件フォームと同じ：時刻なし・差分は fullDayDiffMin（調整休＝−シフト労働／欠勤＝0）・勤務地はシフトの校（無い日だけ選ぶ）・
 *    理由と申請先は必須・欠勤の申請先はマネージャー以上（黙って差し替えず赤で）。判定は validateOvertime の終日の枝、保存は buildOvertimeRecord
 * 🚨 事前か事後か：過ぎた日＝事後報告／今日と先の日＝事前申請（ユーザー確定。1件フォームも今日の終日を事前申請で出せる）
 */
function computeFullDayRow(a: Parameters<typeof computeGridRow>[0], fdt: GridFullDayType): GridRowCalc {
  const { kind, date, today, nowMin, ns, draft } = a;
  const mode: 'advance' | 'posthoc' = kind === 'new_post' ? 'posthoc' : 'advance';
  const phase = overtimePhase({ mode, isReportPhase: false, isResubmit: false, editTarget: null });
  const effectiveLocation = effectiveLocationOf(draft.location, draft.locationCustom, draft.locMoveStart ?? '', draft.locMoveEnd ?? '');
  // 終日の勤務地はシフトの校を自動で使う（シフトに校が無い日だけ手で選ぶ）＝1件フォームの fdLocation と同じ
  const fdLocation = ns.location ?? effectiveLocation;
  const typeDetect = detectOvertimeTypes({ hasDate: true, workSegments: [], normalShift: ns, effectiveLocation });
  const applicationTypes = composeApplicationTypes({ typeDetect, lateChoice: null, earlyChoice: null, fullDay: true, fullDayType: fdt });
  // 振替休日：振替元の休憩・労働は時刻から自動（1件フォームと同じ furikaeOriginCalc）。差分＝振替元の労働 − 休む日のシフト労働
  const fk = fdt === 'furikae_off' ? furikaeOriginCalc(draft.furikaeOriginStart ?? '', draft.furikaeOriginEnd ?? '') : null;
  const furikae = fk ? {
    date: draft.furikaeOriginDate ?? '',
    location: effectiveOtherLocation(draft.furikaeOriginLocation ?? '', draft.furikaeOriginLocationCustom ?? ''),
    start: draft.furikaeOriginStart ?? '', end: draft.furikaeOriginEnd ?? '',
    breakMin: fk.breakMin, laborMin: fk.laborMin, hasTime: fk.hasTime,
  } : null;
  const diffMin = fullDayDiffMin(fdt, ns, fk?.laborMin ?? 0);
  const reviewerId = draft.reviewerId || a.defaultReviewerId;
  const isSelfReview = reviewerId === GRID_SELF_REVIEW;
  const calc = {
    message: '', mode, phase, isReportPhase: false, isResubmit: false, workSegments: [] as WorkSegment[],
    breakMin: 0, laborMin: 0, diffMin, legalOk: true,
    typeDetect, applicationTypes, effectiveLocation: fdLocation, hasChanges: false, changedAxes: [] as string[],
    isPureZero: false, reviewerId, isSelfReview,
    // 🚨 振替休日は振替元の日も呼び名に入れる（確認のあとで振替元を変えたら、送る直前の照合で止まるように）
    sendLabel: (mode === 'advance' ? '事前申請' : '事後報告') + '（' + OT_TYPE_INFO[fdt].label
      + (furikae?.date ? '・振替元 ' + shortMd(furikae.date) : '') + '）',
    // 終日は選ばせず必ず載せる（canOfferCalendarChoice と同じ）
    clockOnly: false, fullDayType: fdt, furikae, offerCalendar: false,
  };
  const ng = gridDayTypeOptions(kind, ns).find(o => o.value === fdt)?.disabledReason ?? '';
  const message = ng ? OT_TYPE_INFO[fdt].label + 'は選べません（' + ng + '）' : validateOvertime({
    date, mode, hasEditTarget: false, today, advanceMaxDate: a.advanceMaxDate,
    // 🚨 締め切りは最後に見る（時間の行と同じ）
    closeLocked: false, clockOnlyMode: false, normalShift: ns,
    clockReason: '', clockReasonOther: '', fullDay: true, fullDayType: fdt, fdLocation,
    furikaeOriginDate: draft.furikaeOriginDate ?? '', furikaeOriginLocation: draft.furikaeOriginLocation ?? '',
    furikaeOriginLocationCustom: draft.furikaeOriginLocationCustom ?? '',
    furikaeOriginStart: draft.furikaeOriginStart ?? '', furikaeOriginEnd: draft.furikaeOriginEnd ?? '', furikaeHasTime: fk?.hasTime ?? false,
    reason: draft.reason, reviewerId, isSelfReview, canSelfReview: a.canSelfReview,
    absenceReviewerOk: (!reviewerId || isSelfReview) ? undefined : a.reviewerIsManager(reviewerId),
    segments: [], workSegments: [], segmentIssues: segmentIssuesOf([]),
    isTodayPostHoc: false, nowMin,
    breakManual: false, breakManualMin: '',
    location: draft.location, locationCustom: draft.locationCustom, locMoveStart: draft.locMoveStart ?? '', locMoveEnd: draft.locMoveEnd ?? '', effectiveLocation,
    normalSegs: normalSegsOf(ns), isReportPhase: false, hasChanges: false, isPureZero: false, changeReason: '',
    typeDetect, lateChoice: null, earlyChoice: null,
  });
  // 振替元の日の確かめ（表の中で分かる範囲。DB のトリガーと送る直前の読み直しでも止まる）
  // 振替元の日は休む日の前後1年以内（年の打ち間違いで「0002年」などが通らないように・2026-09-29）
  const originGap = furikae?.date ? Math.abs(Date.parse(furikae.date + 'T00:00:00Z') - Date.parse(date + 'T00:00:00Z')) / 86400000 : 0;
  const originNg = !furikae || !furikae.date ? ''
    : furikae.date === date ? '振替元の日と休む日が同じです。実際に出勤した日を選んでください'
    : !(originGap <= 366) ? '振替元の勤務日が正しくありません（休む日の前後1年以内の日を選んでください）'
    : (a.furikaeOriginNg ?? '');
  // 🚨 自己受理はマネージャー以上だけ（時間の行と同じ）
  const msg = message || originNg || (isSelfReview && !a.canSelfReview ? '自己受理はマネージャー以上のみです' : '');
  if (msg) return { ...calc, state: a.focused ? 'editing' : 'error', message: msg };
  if (a.closeLocked) return { ...calc, state: 'locked', message: '締め切り後のため、経理の許可が要ります（表の上から依頼できます）' };
  return { ...calc, state: 'ok' };
}

/**
 * 表の上の「合計」（2026-09-28 ユーザー確定 案A）。いまの合計と、送れる行を送ったつもりの合計を返す。
 * 🚨 計算は lib/overtimeBalance の computeBalance だけ（スマホの合計時間数カードと同じ）。ここに式を書かない。
 * ・実績報告・再提出の行 … その申請（main）の差分を、入力中の差分に置き換える（送ると同じ行が書き換わるため）
 * ・新しく出す日の行 … 行を1つ足す
 * 状態は requested として足す。見込み（plannedTotal）は確定＋確認待ちの合計なので、受理の仕方（自己受理か）で変わらない。
 * 🚨 reports は表が読んだその給与期間の申請（work_date で絞ってある）なので、pay_period_start は period として扱う。
 */
export function gridBalance(
  reports: GridReport[],
  period: string,
  sends: { main: GridReport | null; isEdit: boolean; date: string; diffMin: number; applicationTypes: string[] }[],
): { now: BalanceSummary; after: BalanceSummary } {
  const toRow = (r: GridReport): BalanceRow => ({
    pay_period_start: period, status: r.status, entry_type: r.entry_type, work_date: r.work_date,
    diff_minutes: r.diff_minutes, application_types: r.application_types,
  });
  const base = reports.map(toRow);
  const replaced = new Map<string, BalanceRow>();
  const added: BalanceRow[] = [];
  sends.forEach(s => {
    const row: BalanceRow = {
      pay_period_start: period, status: 'requested', entry_type: 'manual', work_date: s.date,
      diff_minutes: s.diffMin, application_types: s.applicationTypes,
    };
    if (s.isEdit && s.main) replaced.set(s.main.id, row);
    else added.push(row);
  });
  const afterRows = [...reports.map(r => replaced.get(r.id) ?? toRow(r)), ...added];
  return { now: computeBalance(base, period), after: computeBalance(afterRows, period) };
}

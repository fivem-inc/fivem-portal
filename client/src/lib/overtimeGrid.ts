// 残業の「表でまとめて入力」（PCだけ）の判定（2026-09-24）。計画：docs/計画-残業の表入力.md
//
// 🚨 ここは画面の状態を持たない（検算できるように supabase も読まない）。
// 🚨 1件フォームと同じ判定は lib/overtimeSubmit を呼ぶ（ここに書き写さない）。

import { payPeriodEnd, minToTime, checkLegalBreak } from './breakCalc';
import type { WorkSegment } from './breakCalc';
import { isFullDayReport } from './overtimeTypes';
import type { OvertimeType } from './overtimeTypes';
import {
  canReportOvertime, toWorkSegments, segmentIssuesOf, detectOvertimeTypes, composeApplicationTypes,
  effectiveLocationOf, validateOvertime, overtimePhase, isSameAsNormalShift,
} from './overtimeSubmit';
import type { SegInput, TypeDetect, LateChoice, EarlyChoice } from './overtimeSubmit';
import { buildWorkDiff } from './overtimeShift';
import type { NormalShiftSnapshot } from './overtimeShift';
import type { OvertimeStatus } from './overtimeStatus';

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
  | 'form_only'       // 表では扱わない（終日・打刻ズレ・移動ありの差し戻し 等）→ 1件フォームで
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
      // 表で直せないもの（終日・打刻ズレ・勤務地の移動あり）は1件フォームで
      if (isFullDayReport(types) || types.includes('clock_only') || (main.location ?? '').includes('→')) return 'form_only';
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
  /** 勤務地の選択（校名 or 'その他'） */
  location: string;
  locationCustom: string;
  lateChoice: LateChoice | null;
  earlyChoice: EarlyChoice | null;
  /** 新しく出す行だけ。空＝表の上の申請先 */
  reviewerId: string;
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

/** 勤務地の値 → 選択欄の値（校名なら校名、それ以外は「その他」＋自由入力） */
export function locationPick(loc: string | null | undefined, workplaces: readonly string[]): { location: string; locationCustom: string } {
  const l = loc ?? '';
  if (!l) return { location: '', locationCustom: '' };
  if (workplaces.includes(l)) return { location: l, locationCustom: '' };
  return { location: 'その他', locationCustom: l };
}

/** 空の行の入力 */
export const EMPTY_ROW_DRAFT: RowDraft = {
  touched: false, segs: [{ start: '', end: '' }], reason: '', changeReason: '', breakMin: '',
  location: '', locationCustom: '', lateChoice: null, earlyChoice: null, reviewerId: '',
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
  | 'ok';       // 送れる

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
}): GridRowCalc {
  const { kind, date, today, nowMin, ns, main, draft } = a;
  const isReportPhase = kind === 'report';
  const isResubmit = kind === 'resubmit';
  const isEdit = isReportPhase || isResubmit;
  const segments = draft.segs;
  const workSegments = toWorkSegments(segments);
  const breakManual = draft.breakMin.trim() !== '';
  const diff = buildWorkDiff(workSegments, ns, breakManual ? (parseInt(draft.breakMin, 10) || 0) : null);
  const legal = checkLegalBreak(workSegments, diff.break_minutes);
  const effectiveLocation = effectiveLocationOf(draft.location, draft.locationCustom, '', '');
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
    closeLocked: !isEdit && a.closeLocked, clockOnlyMode: false, normalShift: ns,
    clockReason: '', clockReasonOther: '', fullDay: false, fullDayType: null, fdLocation: '',
    furikaeOriginDate: '', furikaeOriginLocation: '', furikaeOriginLocationCustom: '', furikaeOriginStart: '', furikaeOriginEnd: '', furikaeHasTime: false,
    reason: draft.reason, reviewerId, isSelfReview, canSelfReview: a.canSelfReview,
    segments, workSegments, segmentIssues: segmentIssuesOf(segments),
    isTodayPostHoc: mode === 'posthoc' && !isEdit && date === today, nowMin,
    breakManual, breakManualMin: draft.breakMin,
    location: draft.location, locationCustom: draft.locationCustom, locMoveStart: '', locMoveEnd: '', effectiveLocation,
    normalSegs: normalSegsOf(ns), isReportPhase, hasChanges, isPureZero, changeReason: draft.changeReason,
    typeDetect, lateChoice: draft.lateChoice, earlyChoice: draft.earlyChoice,
  });
  // 🚨 自己受理はマネージャー以上だけ（1件フォームは選択肢自体を出さない。表でも同じ判定を通す）
  const selfBlocked = !isEdit && isSelfReview && !a.canSelfReview ? '自己受理はマネージャー以上のみです' : '';
  const msg = message || selfBlocked;
  if (msg === NOCHANGE_MSG) return { ...calc, state: 'nochange', message: '通常シフトと同じ（送りません）' };
  if (msg) return { ...calc, state: a.focused ? 'editing' : 'error', message: msg };
  if (!legal.ok) return { ...calc, state: 'warn', message: '休憩が法定より短い（送れます）' };
  return { ...calc, state: 'ok' };
}

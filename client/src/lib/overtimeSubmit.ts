// 残業・時間管理の「1件の申請」を組み立てる判定の集まり（2026-09-24）。
//
// 🚨 これまで OvertimePage.tsx（1件フォーム）の中に直接書いていたものを、そのまま移した。
//    1件フォームと「表でまとめて入力」（docs/計画-残業の表入力.md）の両方がここを呼ぶ。
//    同じ判定を2か所に書かないこと（片方だけ直す事故になる）。
// 🚨 ここは**画面の状態を持たない**。必要な値はすべて引数で受け取る。
//    とくに「いまの時刻」は引数（nowMin / nowIso）で渡すこと（送る直前の時刻で判定するため）。
// 🚨 文言は1件フォームの赤い欄のハイライト（ERR_FIELD_BY_MSG）が完全一致で引いている。1文字も変えないこと。

import {
  timeToMin, minToTime, formatMin,
  payMonthPeriodLabel, payPeriodCloseCutoff, calcPayPeriodStartJst, jpDateLabel,
} from './breakCalc';
import type { WorkSegment } from './breakCalc';
import { normalShiftWindow } from './overtimeShift';
import type { NormalShiftSnapshot } from './overtimeShift';
import { isFullDayReport } from './overtimeTypes';
import type { OvertimeType } from './overtimeTypes';

/** 入力欄の1本ぶん（"HH:MM" か ""） */
export interface SegInput { start: string; end: string }

/** 1本の勤務が16時間を超えることは実務上ありえない */
export const MAX_SEG_MINUTES = 16 * 60;

/** 入力欄 → 実務時間帯（分）。終了が開始以前なら翌日扱い（深夜勤務） */
export function toWorkSegments(segments: SegInput[]): WorkSegment[] {
  return segments
    .map(s => {
      const st = timeToMin(s.start);
      let en = timeToMin(s.end);
      if (st == null || en == null) return null;
      if (en <= st) en += 1440; // 深夜跨ぎは翌日扱い
      return { startMin: st, endMin: en };
    })
    .filter((s): s is WorkSegment => s !== null);
}

/**
 * 明らかにおかしい時間帯を「送信するまで気づけない」状態にしないための入力時チェック。
 * 🚨 終了が開始より前なら翌日扱いにする仕様（深夜勤務のため必要）が、
 *    24時間表記の打ち間違い（夕方5時を 5:55 と入力）を静かに17時間の勤務に変えてしまう。
 *    実際に 12:30〜23:30 ＋ 12:30〜5:55 で「労働 27:25」と表示された（実機で発生）。
 * 行ごとの理由を返す（問題なしは null）。
 */
export function segmentIssuesOf(segments: SegInput[]): (string | null)[] {
  const issues: (string | null)[] = segments.map(() => null);
  let prevEnd: number | null = null;
  segments.forEach((s, i) => {
    const st = timeToMin(s.start);
    let en = timeToMin(s.end);
    if (st == null || en == null) return;
    const wrapped = en <= st;
    if (wrapped) en += 1440;
    if (en - st > MAX_SEG_MINUTES) {
      issues[i] = wrapped
        ? `終了が開始より前のため翌日として計算し、${formatMin(en - st)}の勤務になっています。夕方5時なら 17:00 のように入力してください`
        : `勤務${i + 1}が${formatMin(en - st)}になっています。時刻を確認してください`;
      return;
    }
    if (prevEnd != null && st < prevEnd) {
      issues[i] = `勤務${i + 1}の開始が勤務${i}の終了より前になっています`;
    }
    prevEnd = en;
  });
  return issues;
}

export interface TypeDetect { fixed: OvertimeType[]; lateQ: boolean; earlyQ: boolean }

/**
 * 種別の自動判定。時刻・勤務地の入力からシステムが種別を提案する。
 * 迷いやすい「調整か遅刻/早退か」だけ lateQ / earlyQ で本人に聞く。
 * 🚨 比べる相手は通常シフト**全体**（2本目の帯も含めた、いちばん早い始まり〜いちばん遅い終わり）。
 *    1本目だけと比べると、2本シフトの人で「午後をふつうに働いただけで残業」「朝の帯で早出」になる（2026-09-24）
 */
export function detectOvertimeTypes(args: {
  hasDate: boolean;
  workSegments: WorkSegment[];
  normalShift: NormalShiftSnapshot;
  effectiveLocation: string;
}): TypeDetect {
  const { hasDate, workSegments, normalShift, effectiveLocation } = args;
  if (workSegments.length === 0 || !hasDate) return { fixed: [] as OvertimeType[], lateQ: false, earlyQ: false };
  const fixed: OvertimeType[] = [];
  let lateQ = false, earlyQ = false;
  const sorted = [...workSegments].sort((a, b) => a.startMin - b.startMin);
  const firstStart = sorted[0].startMin;
  const lastEnd = sorted[sorted.length - 1].endMin;
  const win = normalShiftWindow(normalShift);
  if (!win) {
    fixed.push('holiday_work');
  } else {
    const ns = win.startMin;
    const ne = win.endMin;
    if (lastEnd > ne) fixed.push('overtime');
    if (firstStart < ns) fixed.push('early_start');
    if (firstStart > ns) lateQ = true;
    if (lastEnd < ne) earlyQ = true;
  }
  // 勤務地がシフトの校と違う／移動あり → 勤務地変更
  const normLoc = normalShift.location ?? '';
  if (effectiveLocation && (effectiveLocation.includes('→') || (normLoc && effectiveLocation !== normLoc))) {
    fixed.push('location_change');
  }
  return { fixed, lateQ, earlyQ };
}

/** 自動判定＋本人の2択 → 保存する種別。終日は単独付与（DB制約と対応） */
export function composeApplicationTypes(args: {
  typeDetect: TypeDetect;
  lateChoice: 'adj' | 'tardiness' | null;
  earlyChoice: 'adj' | 'early_leave' | null;
  fullDay: boolean;
  fullDayType: OvertimeType | null;
}): OvertimeType[] {
  const { typeDetect, lateChoice, earlyChoice, fullDay, fullDayType } = args;
  if (fullDay && fullDayType) return [fullDayType];
  const t = [...typeDetect.fixed];
  if (typeDetect.lateQ && lateChoice) t.push(lateChoice === 'adj' ? 'late_start_adj' : 'tardiness');
  if (typeDetect.earlyQ && earlyChoice) t.push(earlyChoice === 'adj' ? 'early_end_adj' : 'early_leave');
  return t;
}

/** 勤務地の実効値（保存・検証に使う）。移動あり＝「開始校→移動先校」 */
export function effectiveLocationOf(location: string, locationCustom: string, locMoveStart: string, locMoveEnd: string): string {
  return location === 'その他' ? locationCustom.trim()
    : location === '移動あり' ? (locMoveStart && locMoveEnd ? `${locMoveStart}→${locMoveEnd}` : '')
    : location;
}

/** 送信前チェックに渡す値（1件フォームの状態をそのまま写したもの） */
export interface ValidateInput {
  date: string;
  mode: 'advance' | 'posthoc';
  hasEditTarget: boolean;
  today: string;
  advanceMaxDate: string;
  closeLocked: boolean;
  clockOnlyMode: boolean;
  normalShift: NormalShiftSnapshot;
  clockReason: string;
  clockReasonOther: string;
  fullDay: boolean;
  fullDayType: OvertimeType | null;
  fdLocation: string;
  furikaeOriginDate: string;
  furikaeOriginLocation: string;
  furikaeOriginLocationCustom: string;
  furikaeOriginStart: string;
  furikaeOriginEnd: string;
  furikaeHasTime: boolean;
  reason: string;
  reviewerId: string;
  isSelfReview: boolean;
  canSelfReview: boolean;
  segments: SegInput[];
  workSegments: WorkSegment[];
  segmentIssues: (string | null)[];
  /** 当日ぶんの事後報告か（新規のみ） */
  isTodayPostHoc: boolean;
  /** いま何時か（0時からの分）。🚨 送信ボタンを押した瞬間の値を渡す */
  nowMin: number;
  breakManual: boolean;
  breakManualMin: string;
  location: string;
  locationCustom: string;
  locMoveStart: string;
  locMoveEnd: string;
  effectiveLocation: string;
  normalSegs: SegInput[];
  isReportPhase: boolean;
  hasChanges: boolean;
  isPureZero: boolean;
  changeReason: string;
  typeDetect: TypeDetect;
  lateChoice: 'adj' | 'tardiness' | null;
  earlyChoice: 'adj' | 'early_leave' | null;
}

/** 送信前チェック。問題なしは ''。🚨 文言は1文字も変えないこと（欄のハイライトが完全一致で引く） */
export function validateOvertime(v: ValidateInput): string {
  const { date, mode, today } = v;
  if (!date) return '日付を選択してください';
  if (mode === 'advance' && !v.hasEditTarget && date < today) return '事前申請は当日以降の日付を選択してください';
  // 🚨 先の日付の上限（2026-09-09 ユーザー確定）。日付選びでも押せなくしているが、
  //    下書きの復元や種類の切り替えで上限を越えた日が残ることがあるので送信前にも必ず弾く。
  if (mode === 'advance' && !v.hasEditTarget && date > v.advanceMaxDate)
    return `事前申請は${jpDateLabel(v.advanceMaxDate)}までです。それより先の日付は、その時期が近づいてから申請してください`;
  if (mode === 'posthoc' && date > today) return '事後報告は当日以前の日付を選択してください';
  if (v.closeLocked) {
    const targetPeriodStart = calcPayPeriodStartJst(date);
    return `この対象日は【${payMonthPeriodLabel(targetPeriodStart)}】の申請です。締め切り（${payPeriodCloseCutoff(targetPeriodStart).replace(/-/g, '/')}）を過ぎているため申請できません。経理に申請の許可を依頼してください。`;
  }
  // 打刻ズレ（残業ではありません）は時刻・勤務地・申請先の検証をスキップし、専用の検証のみ行う。
  // ※ ここを通さないと「勤務地を選択してください」「申請先を選択してください」で必ず止まる
  if (v.clockOnlyMode) {
    if (!v.normalShift.start_time) return 'この日はシフトが休みです。出勤予定日のみ記録できます';
    if (!v.clockReason) return '打刻が遅くなった理由を選んでください';
    if (v.clockReason === 'その他' && !v.clockReasonOther.trim()) return '理由を入力してください';
    return '';
  }
  // 終日（調整休・欠勤）は時刻・休憩・勤務地の検証をスキップし、専用の検証のみ行う
  if (v.fullDay) {
    if (!v.normalShift.start_time) return 'この日はシフトが休みです。出勤予定日のみ登録できます';
    if (!v.fullDayType) return '種別（時間外調整休・振替休日・欠勤）を選択してください';
    if (!v.fdLocation) return '勤務地を選択してください';
    if (v.fullDayType === 'furikae_off') {
      if (!v.furikaeOriginDate) return '振替元の勤務日を選択してください';
      if (!v.furikaeOriginLocation) return '振替元の勤務校を選択してください';
      if (v.furikaeOriginLocation === 'その他' && !v.furikaeOriginLocationCustom.trim()) return '振替元の勤務校を入力してください';
      if (!v.furikaeOriginStart || !v.furikaeOriginEnd) return '振替元の出勤・退勤の時刻を入力してください';
      if (!v.furikaeHasTime) return '振替元の時刻が正しくありません（開始・終了を確認してください）';
    }
    if (!v.reason.trim()) return '理由を入力してください';
    if (!v.reviewerId) return '申請先を選択してください';
    // 🚨 欠勤の自己受理はマネージャー以上のみ（2026-08-21 に開放）。
    //    canSelfReview が false の人には選択肢自体を出していないが、
    //    下書きの復元・修正で古い値が入っていることがあるのでここでも弾く。
    //    同じ判定が RLS（overtime_insert_own）と overtime-approve にもある。片方だけ直さないこと。
    if (v.fullDayType === 'absence' && v.isSelfReview && !v.canSelfReview) return '欠勤の自己受理はマネージャー以上のみです';
    return '';
  }
  if (v.workSegments.length === 0) return '勤務時間を入力してください';
  for (let i = 0; i < v.segments.length; i++) {
    const s = v.segments[i];
    if ((s.start && !s.end) || (!s.start && s.end)) return `勤務${i + 1}の開始・終了を両方入力してください`;
  }
  // 事後報告は「もう働いた分」を出すもの。当日ぶんは勤務を始める前に出せないようにする。
  // 🚨 基準は通常シフトではなく **本人が入力した勤務時間**（ユーザー確定・2026-08-29）。
  //    シフトを基準にすると、休日出勤（その日のシフトが無い）は判定できず、
  //    早出（シフト9:30の日に8:00から働いた）が「まだ9:30前」で止まってしまう。
  //    終日（調整休・欠勤）と打刻ズレは上で早期returnしており対象外＝朝でも出せる。
  if (v.isTodayPostHoc) {
    const startMin = Math.min(...v.workSegments.map(s => s.startMin));
    if (v.nowMin < startMin) {
      return `まだ ${minToTime(startMin)} になっていません。事後報告は勤務を始めてから送信してください`;
    }
  }
  // 入力時に赤く出しているもの（遡り・16時間超）と同じ理由で送信も止める
  const issue = v.segmentIssues.find(Boolean);
  if (issue) return issue;
  // 帯の重複チェック
  const sorted = [...v.workSegments].sort((a, b) => a.startMin - b.startMin);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].startMin < sorted[i - 1].endMin) return '勤務の時間が重なっています。開始・終了時刻を確認してください';
  }
  if (v.breakManual && (v.breakManualMin === '' || isNaN(parseInt(v.breakManualMin, 10)) || parseInt(v.breakManualMin, 10) < 0)) {
    return '休憩時間（分）を入力してください';
  }
  if (!v.location) return '勤務地を選択してください';
  if (v.location === 'その他' && !v.locationCustom.trim()) return '勤務地を入力してください';
  if (v.location === '移動あり' && (!v.locMoveStart || !v.locMoveEnd)) return '移動元・移動先の校を選択してください';
  if (!v.reason.trim()) return '理由を入力してください';
  if (!v.reviewerId) return '申請先を選択してください';
  // 通常シフトと全く同じ内容（時間帯・休憩・勤務地に変更なし）では送信不可。
  // ※実績報告は除外＝「事前申請では残業予定だったが実際は通常どおりだった（残業ゼロ）」も正当に報告できるようにする。
  if (!v.isReportPhase) {
    const sameSegs = v.segments.length === v.normalSegs.length
      && v.segments.every((s, i) => s.start === v.normalSegs[i].start && s.end === v.normalSegs[i].end);
    if (sameSegs && !v.breakManual && v.effectiveLocation === (v.normalShift.location ?? '')) {
      return '通常シフトと同じ内容です。残業・早退・調整など、変更した点を入力してください';
    }
  }
  // 実績報告で予定から変わっている場合は変更理由が必須（ただし「残業なし＝通常どおり」は理由不要）
  if (v.isReportPhase && !v.fullDay && v.hasChanges && !v.isPureZero && !v.changeReason.trim()) {
    return '予定から変わった理由を入力してください';
  }
  // 種別の2択（開始が遅い／早く終わる）は本人が選ぶまで送信不可
  if (v.typeDetect.lateQ && !v.lateChoice) return '「開始が遅い理由は？」を選択してください';
  if (v.typeDetect.earlyQ && !v.earlyChoice) return '「早く終わる理由は？」を選択してください';
  return '';
}

/** 実績（actual）として保存するか、予定（planned）として保存するか */
export function overtimePhase(args: {
  mode: 'advance' | 'posthoc';
  isReportPhase: boolean;
  isResubmit: boolean;
  editTarget: { is_post_hoc?: boolean | null; segments?: { phase: string }[] | null } | null;
}): 'planned' | 'actual' {
  const { mode, isReportPhase, isResubmit, editTarget } = args;
  return (mode === 'posthoc' || isReportPhase || (isResubmit && !!editTarget?.is_post_hoc) || (isResubmit && (editTarget?.segments ?? []).some(s => s.phase === 'actual')))
    ? 'actual' : 'planned';
}

/**
 * 実績を報告できるか。過去日は無条件、当日は「その日の勤務が終わるころ」（gateMin）を過ぎたら。
 * 🚨 requested（受理まち）も含める（2026-08-25）。受理を待たずに実績を報告できるようにしたため
 * 🚨🚨 催促する側（履歴タブの件数バッジ unreportedRequests／App.tsx のホーム件数・ナビ／
 *      Edge Function remind-overtime-unreported の毎朝のリマインド）は **翌日基準のまま** で、
 *      ここと意図的に基準が違う。当日から催促すると、まだ勤務中の人に「まだ報告していません」と出るため。
 *      「揃っていない」と思って片方に合わせないこと（2026-08-26）。
 * gateMin は lib/overtimeShift の reportGateMin で求めたもの（取れない行は null＝詰まらせない）。
 */
export function canReportOvertime(
  r: { status: string; application_types: OvertimeType[] | string[] | null; work_date: string },
  todayStr: string,
  nowMin: number,
  gateMin: number | null,
): boolean {
  if (!['requested', 'request_confirmed'].includes(r.status)) return false;
  if (isFullDayReport((r.application_types ?? []) as OvertimeType[])) return false; // 終日（調整休・振休・欠勤）は実績報告の概念がない
  if (r.work_date < todayStr) return true;                   // 勤務日を過ぎた分は無条件
  if (r.work_date > todayStr) return false;                  // 未来の予定
  return gateMin == null || nowMin >= gateMin;               // gate が取れない行は詰まらせない
}

// 振替休日の［休む日を出勤に変える］で、休む日の時間や場所が違うとき（2026-10-27 ユーザー確定・計画 docs/計画-振替休日の変更-時間も.md）。
// 本人の窓と受理する人の画面が、休む日にできる申請の中身（種別・時間・通常シフトとの差）をここ1か所で計算する。
// 🚨 受理のとき実際に作るのは DB の furikae_change_eval（同じ決まりの写し）。画面の計算は表示と送る前の確かめだけ。片方だけ直さないこと
// 🚨 休憩・種別の決まりは、ふだんの残業申請と同じ部品（lib/breakCalc・lib/overtimeSubmit）をそのまま使う
import { calcTotalBreak, calcLaborMinutes, checkLegalBreak, timeToMin } from './breakCalc';
import type { WorkSegment } from './breakCalc';
import { detectOvertimeTypes, composeApplicationTypes } from './overtimeSubmit';
import type { LateChoice, EarlyChoice } from './overtimeSubmit';
import type { NormalShiftSnapshot } from './overtimeShift';
import type { OvertimeType } from './overtimeTypes';

/** DB の列 furikae_change_plan（入力だけ） */
export interface FurikaeChangePlan {
  segments: { start: number; end: number }[];
  location: string;
  late_choice: LateChoice | null;
  early_choice: EarlyChoice | null;
}

export interface FurikaeChangeEval {
  segments: WorkSegment[];
  breakMin: number;
  laborMin: number;
  diffMin: number;
  types: OvertimeType[];
  /** 始まりが遅い・終わりが早い（理由を選ぶ欄を出す） */
  lateQ: boolean;
  earlyQ: boolean;
  location: string;
  legalOk: boolean;
}

/** 通常シフトの時間帯（1〜2本・始まりの順） */
export function normalSegmentsOf(ns: Pick<NormalShiftSnapshot, 'start_time' | 'end_time' | 'start_time2' | 'end_time2'> | null | undefined): WorkSegment[] {
  if (!ns) return [];
  const out: WorkSegment[] = [];
  const add = (s?: string | null, e?: string | null) => {
    const a = timeToMin((s ?? '').slice(0, 5));
    const b = timeToMin((e ?? '').slice(0, 5));
    if (a != null && b != null && b > a) out.push({ startMin: a, endMin: b });
  };
  add(ns.start_time, ns.end_time);
  add(ns.start_time2, ns.end_time2);
  return out.sort((x, y) => x.startMin - y.startMin);
}

/**
 * 休む日にできる申請の中身。error は送る前に止める理由（DB の furikae_change_eval と同じ文）。
 * 理由（遅出・早退）がまだ選ばれていないときも、種別以外は計算して返す（画面で欄を出すため）
 */
export function evalFurikaeChange(ns: NormalShiftSnapshot | null | undefined, plan: FurikaeChangePlan): { ev: FurikaeChangeEval | null; error: string } {
  const normal = normalSegmentsOf(ns);
  if (!ns || normal.length === 0) return { ev: null, error: 'この日の通常シフトが無いため、時間を変えられません' };
  if (plan.segments.length === 0) return { ev: null, error: '勤務時間を入力してください' };
  const segs = [...plan.segments].sort((a, b) => a.start - b.start);
  for (const s of segs) {
    if (!Number.isInteger(s.start) || !Number.isInteger(s.end) || s.start < 0 || s.end > 1440 || s.end <= s.start) {
      return { ev: null, error: '勤務時間の入力を確認してください' };
    }
  }
  for (let i = 1; i < segs.length; i++) {
    if (segs[i].start < segs[i - 1].end) return { ev: null, error: '勤務の時間が重なっています。開始・終了時刻を確認してください' };
  }
  const work: WorkSegment[] = segs.map(s => ({ startMin: s.start, endMin: s.end }));
  const breakMin = calcTotalBreak(work);
  const laborMin = calcLaborMinutes(work, breakMin);
  const location = plan.location.trim() || (ns.location ?? '').trim();
  if (!location) return { ev: null, error: '勤務地を選んでください' };
  const td = detectOvertimeTypes({ hasDate: true, workSegments: work, normalShift: ns, effectiveLocation: location });
  const types = composeApplicationTypes({ typeDetect: td, lateChoice: plan.late_choice, earlyChoice: plan.early_choice, fullDay: false, fullDayType: null });
  const ev: FurikaeChangeEval = {
    segments: work, breakMin, laborMin, diffMin: laborMin - (ns.labor_minutes ?? 0), types,
    lateQ: td.lateQ, earlyQ: td.earlyQ, location, legalOk: checkLegalBreak(work, breakMin).ok,
  };
  if (td.lateQ && !plan.late_choice) return { ev, error: '「開始が遅い理由」を選んでください' };
  if (td.earlyQ && !plan.early_choice) return { ev, error: '「早く終わる理由」を選んでください' };
  if (types.length === 0) {
    const same = normal.length === work.length && normal.every((n, i) => n.startMin === work[i].startMin && n.endMin === work[i].endMin);
    return { ev, error: same ? '通常シフトと同じです。［いつもどおり］を選んでください'
      : '始まりと終わりが通常シフトと同じため、種別が決まりません。始まりか終わりの時刻を変えてください' };
  }
  return { ev, error: '' };
}

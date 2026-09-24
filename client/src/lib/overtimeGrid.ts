// 残業の「表でまとめて入力」（PCだけ）の判定（2026-09-24）。計画：docs/計画-残業の表入力.md
//
// 🚨 ここは画面の状態を持たない（検算できるように supabase も読まない）。
// 🚨 1件フォームと同じ判定は lib/overtimeSubmit を呼ぶ（ここに書き写さない）。

import { payPeriodEnd } from './breakCalc';
import { isFullDayReport } from './overtimeTypes';
import { canReportOvertime } from './overtimeSubmit';
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
  reason: string | null;
  return_comment: string | null;
  reviewer_id: string | null;
  normal_shift: unknown;
  segments?: { phase: 'planned' | 'actual'; seg_no: number; start_min: number; end_min: number }[];
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

import { supabase } from './supabaseClient';
import { calcTotalBreak, calcLaborMinutes, checkLegalBreak, minToTime, formatSignedMin, type WorkSegment } from './breakCalc';
import { notifyOvertimeAdminEdited } from './overtimeNotify';
import { normalShiftWindow } from './overtimeShift';

// 管理者が残業の申請を直す処理（計算・変更点・保存）。
// 🚨 ［📋修正］の画面（OvertimeEditModal）と、打刻の確認のカードの［この時刻で申請を直す］（2026-10-13）の
//    両方がここを使う。計算や変更点の作り方を2か所に書かないこと

export interface EditableReport {
  id: string;
  applicant_id: string;
  work_date: string;
  normal_shift: { labor_minutes: number } | null;
  break_minutes: number | null;
  diff_minutes: number | null;
  reason: string | null;
  location: string | null;
  segments: { phase: 'planned' | 'actual'; seg_no: number; start_min: number; end_min: number }[];
}

/** 直す対象の段（実績があれば実績、無ければ予定） */
export const editPhaseOf = (r: Pick<EditableReport, 'segments'>): 'planned' | 'actual' =>
  r.segments.some(s => s.phase === 'actual') ? 'actual' : 'planned';

/** いまの時間帯（直す対象の段） */
export const currentSegsOf = (r: Pick<EditableReport, 'segments'>): WorkSegment[] => {
  const phase = editPhaseOf(r);
  return r.segments.filter(s => s.phase === phase).sort((a, b) => a.seg_no - b.seg_no)
    .map(s => ({ startMin: s.start_min, endMin: s.end_min }));
};

/** 休憩・実労働・差分・法定の休憩（申請フォームと同じ breakCalc） */
export function editFigures(segs: WorkSegment[], breakManual: boolean, manualMin: number, baseLabor: number) {
  const autoBreak = calcTotalBreak(segs);
  const breakMin = breakManual ? manualMin : autoBreak;
  const laborMin = calcLaborMinutes(segs, breakMin);
  return { autoBreak, breakMin, laborMin, diffMin: laborMin - baseLabor, legalOk: checkLegalBreak(segs, breakMin).ok };
}

export const segsLabel = (segs: WorkSegment[]) =>
  (segs.length ? segs.map(s => `${minToTime(s.startMin)}〜${minToTime(s.endMin)}`).join('、') : '(なし)');

export const EDIT_FIELD_LABELS: Record<string, string> = { work_date: '勤務日', segments: '時間帯', break_minutes: '休憩', diff_minutes: '差分時間', location: '校', reason: '理由' };

/**
 * 打刻ズレ（残業なし・clock_only）の時間を直して差が出たときの、正しい種類（2026-10-13）。
 * 🚨 打刻ズレのまま差が出ると、一覧では「残業なし」に見えるのに合計時間が変わる（本番で2件起きた）。
 *    始まり・終わりをシフトと比べて、調整遅出／早出／調整早退／残業を決める。差が0なら null（種類はそのまま）
 */
export function typesForClockOnlyEdit(
  types: string[] | null | undefined, segs: WorkSegment[], diffMin: number,
  ns: { start_time?: string | null; end_time?: string | null; start_time2?: string | null; end_time2?: string | null } | null,
): string[] | null {
  if (!(types ?? []).includes('clock_only') || diffMin === 0 || segs.length === 0) return null;
  // 🚨 シフトの始まり・終わりは全体の「いちばん早い始まり・いちばん遅い終わり」（2本目の終わりと決め打ちしない・2026-10-16）
  const w = normalShiftWindow(ns);
  const sStart = w ? w.startMin : null;
  const sEnd = w ? w.endMin : null;
  const first = Math.min(...segs.map(x => x.startMin));
  const last = Math.max(...segs.map(x => x.endMin));
  const out: string[] = [];
  if (sStart != null) { if (first > sStart) out.push('late_start_adj'); else if (first < sStart) out.push('early_start'); }
  if (sEnd != null) { if (last < sEnd) out.push('early_end_adj'); else if (last > sEnd) out.push('overtime'); }
  if (out.length === 0) out.push(diffMin < 0 ? 'early_end_adj' : 'overtime');
  return out;
}

/** 変更点（履歴に残す）と、その要約 */
export function editChanges(record: EditableReport, next: {
  workDate: string; segs: WorkSegment[]; breakMin: number; diffMin: number; location: string; reason: string;
}) {
  const c: Record<string, { old: unknown; new: unknown }> = {};
  if (record.work_date !== next.workDate) c.work_date = { old: record.work_date, new: next.workDate };
  const oldLabel = segsLabel(currentSegsOf(record));
  if (oldLabel !== segsLabel(next.segs)) c.segments = { old: oldLabel, new: segsLabel(next.segs) };
  if ((record.break_minutes ?? 0) !== next.breakMin) c.break_minutes = { old: `${record.break_minutes ?? 0}分`, new: `${next.breakMin}分` };
  if ((record.diff_minutes ?? 0) !== next.diffMin) c.diff_minutes = { old: formatSignedMin(record.diff_minutes ?? 0), new: formatSignedMin(next.diffMin) };
  if ((record.location ?? '') !== next.location) c.location = { old: record.location ?? '', new: next.location };
  if ((record.reason ?? '') !== next.reason) c.reason = { old: record.reason ?? '', new: next.reason };
  const summary = Object.keys(c).map(k => EDIT_FIELD_LABELS[k] ?? k).join('・') + 'を修正';
  return { changes: c, summary };
}

/**
 * 保存 → （打刻の確認から来たときは）確認を「直しました」に → 本人へ通知 → Googleカレンダーへ反映。
 * 戻り値：error＝保存できなかった／resolveError＝保存はできたが確認の札を変えられなかった／gcalFailed＝カレンダーだけ失敗
 */
export async function saveAdminOvertimeEdit(a: {
  record: EditableReport; workDate: string; segs: WorkSegment[];
  breakManual: boolean; breakMin: number; laborMin: number; diffMin: number; legalOk: boolean;
  reason: string; location: string; changes: Record<string, { old: unknown; new: unknown }>; summary: string;
  changeReason: string;
  /** 打刻の確認のカードから直したとき（その日の確認を「直しました」にする） */
  clockInquiryDayId?: string;
  /** 種類も直すとき（打刻ズレの時間を変えて差が出たとき・2026-10-13）。渡さなければ種類はそのまま */
  applicationTypes?: string[];
}): Promise<{ error?: string; resolveError?: string; gcalFailed?: boolean }> {
  const { record } = a;
  const { error: rpcErr } = await supabase.rpc('admin_edit_overtime_report', {
    p_id: record.id,
    p_work_date: a.workDate,
    p_break_minutes: a.breakMin,
    p_break_manual: a.breakManual,
    p_labor_minutes: a.laborMin,
    p_diff_minutes: a.diffMin,
    p_legal_warning: !a.legalOk,
    p_reason: a.reason,
    p_location: a.location,
    p_phase: editPhaseOf(record),
    p_segments: a.segs.map((s, i) => ({ seg_no: i + 1, start_min: s.startMin, end_min: s.endMin })),
    p_changes: a.changes,
    p_change_summary: a.summary,
    p_change_reason: a.changeReason,
    p_application_types: a.applicationTypes ?? null,
  });
  if (rpcErr) return { error: '保存に失敗しました: ' + rpcErr.message };

  let resolveError: string | undefined;
  if (a.clockInquiryDayId) {
    const { error: rErr } = await supabase.rpc('resolve_clock_inquiry_day', {
      p_day_id: a.clockInquiryDayId, p_kind: 'edited', p_note: segsLabel(a.segs),
    });
    if (rErr) resolveError = '申請は直しましたが、打刻の確認を「直しました」にできませんでした：' + rErr.message;
  }

  await notifyOvertimeAdminEdited({
    reportId: record.id,
    applicantId: record.applicant_id,
    dateLabel: record.work_date,
    summary: a.summary,
    reason: a.changeReason,
  }).then(null, () => {});

  // 受理後修正でカレンダーが古い日付・時刻のまま残らないよう再同期（冪等な再計算）
  const { data: syncRes, error: syncErr } = await supabase.functions.invoke('gcal-sync', {
    body: { action: 'sync', source_type: 'overtime', source_id: record.id },
  });
  const sr = syncRes as { success?: boolean } | null;
  return { resolveError, gcalFailed: !!syncErr || sr?.success === false };
}

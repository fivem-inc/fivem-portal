// 残業・時間管理の「1件の申請」を DB に保存する（2026-09-24）。
//
// 🚨 1件フォーム（OvertimePage.tsx の doSubmit）にあった書き込みを移した。
//    1件フォームと「表でまとめて入力」（docs/計画-残業の表入力.md）の両方がここを呼ぶ。
// 🚨 supabase を使うので、判定だけの lib/overtimeSubmit.ts とは分けてある
//    （判定側は画面を開かずに検算できるようにしておくため）。
// 🚨 失敗は握りつぶさない。error と件数を必ず見て、段階（stage）と理由を返す。

import { supabase } from './supabaseClient';
import { logFail } from './logFail';
import { friendlyOvertimeDbError } from './overtimeSubmit';
import { describeUpdate } from './statusUpdate';
import type { WorkSegment } from './breakCalc';
import { notifyOvertimeNewRequestBell, notifyOvertimeNewRequestEmail, sendOvertimeSlackBatch } from './overtimeNotify';
import type { BulkWriter, ExistingManual } from './overtimeBulkSend';
import type { GridReport } from './overtimeGrid';

export type SaveStage = 'insert' | 'update' | 'conflict' | 'seg_delete' | 'seg_insert';

export type SaveResult =
  | { ok: true; reportId: string }
  /** reportId があるのは「申請本体は保存できたが、そのあとで失敗した」とき */
  | { ok: false; stage: SaveStage; message: string; code?: string; reportId?: string };

export interface SaveArgs {
  userId: string;
  /** lib/overtimeSubmit の buildOvertimeRecord で組み立てたもの */
  record: Record<string, unknown>;
  phase: 'planned' | 'actual';
  /** 保存する時間帯（終日は空） */
  segments: WorkSegment[];
  /** 既存の申請を書き換えるとき（実績報告・再提出）。新規は null */
  edit: null | {
    id: string;
    /** 開いたときの状態。🚨 これを条件に書き換える（先に受理・差し戻しされていたら0件になる） */
    status: string;
    snapshot: unknown;
    historySummary: string;
    historyChangeReason: string | null;
  };
  /**
   * 時間帯の保存に失敗したとき、その phase を消して入れ直す回数（既定0＝入れ直さない）。
   * 🚨 表入力は1行ずつ順に送るので、通信の一時的な失敗で「時間帯の無い申請」が残らないよう入れ直す。
   *    申請本体を取消済みに戻すことはしない（本人の許可では cancelled に書き換えられない・
   *    取消の経路を通すと申請先に「取り消しました」が飛ぶ）。
   */
  segRetries?: number;
}

export async function saveOvertimeReport(a: SaveArgs): Promise<SaveResult> {
  let reportId: string;
  if (a.edit) {
    // 🚨 開いてから送るまでの間に、上長が受理・差し戻し・取消をしている場合がある。
    //    status を条件に付けて件数を見ないと、差し戻された申請に実績を上書きしてしまい、
    //    差し戻し理由が残ったまま「実績 確認待ち」に戻る（update は0件でもエラーにならない）
    const { data: updatedRows, error: err } = await supabase.from('overtime_reports')
      .update(a.record).eq('id', a.edit.id).eq('status', a.edit.status).select('id');
    if (err) return { ok: false, stage: 'update', message: friendlyOvertimeDbError(err.message, err.code), code: err.code };
    if (!updatedRows || updatedRows.length === 0) {
      return { ok: false, stage: 'conflict', message: 'この申請の状態が変わっています（先に受理・差し戻し・取消がされた可能性があります）。画面を更新してからやり直してください。' };
    }
    reportId = a.edit.id;
    // 修正の記録。🚨 書き換えが成功してから残す（2026-09-24）。
    //    以前は書き換えの前に残していたので、状態が変わっていて書き換えられなかったときに
    //    「実績報告」の記録だけが残っていた。記録の失敗で送信は止めない（今までどおり）
    await supabase.from('overtime_report_history').insert({
      report_id: a.edit.id,
      changed_by: a.userId,
      change_summary: a.edit.historySummary,
      change_reason: a.edit.historyChangeReason,
      snapshot: a.edit.snapshot as Record<string, unknown>,
    }).then(...logFail('残業の修正の記録'));
    // 対象phaseの時間帯を入れ替え
    // 🚨 消し漏れると時間帯が二重に残る。とくに危ないのは次の2つで、
    //    どちらも「このあとの insert が unique(report_id,phase,seg_no) で弾かれる」網に
    //    掛からないため、エラーを見ないと**何も起きずに古い時間帯が残る**：
    //      ・終日（調整休・欠勤）に変えたとき … 新しい時間帯が0件なので insert 自体が走らない
    //      ・時間帯を3本から2本に減らしたとき … 3本目だけが古いまま残る
    // 🚨 件数0はここでは失敗ではない（その phase を初めて保存するときは元から0件）。
    //    見るのは error だけにする。
    // 🚨 終日（時間帯が空）で保存するときは phase を問わず全部消す（2026-09-25）。
    //    「事前受理 → 実績報告 → 差し戻し」の申請（予定と実績の両方がある）を再提出で終日に変えると、
    //    対象 phase（実績）だけ消しても予定の時間帯が残り、勤怠カレンダーの関数（calendar_overtime_events）は
    //    種別を見ずに時間帯を読むので「欠勤なのに時刻付き」で出る。
    //    「空＝終日」と決めてよい根拠：時間の申請は送信前チェックで必ず1本以上あり、打刻ズレは通常シフトを渡す。
    //    元の時間帯は書き換え直前の snapshot（修正の記録）に残るので、消しても追える
    let segDel = supabase.from('overtime_report_segments').delete().eq('report_id', reportId);
    if (a.segments.length > 0) segDel = segDel.eq('phase', a.phase);
    const { error: segDelErr } = await segDel.select('id');
    if (segDelErr) return { ok: false, stage: 'seg_delete', message: '前回の時間帯を消せませんでした：' + segDelErr.message, reportId };
  } else {
    const { data: inserted, error: err } = await supabase.from('overtime_reports')
      .insert({ applicant_id: a.userId, submitted_by: a.userId, entry_type: 'manual', ...a.record })
      .select('id').single();
    if (err || !inserted) {
      return { ok: false, stage: 'insert', message: friendlyOvertimeDbError(err?.message ?? '保存した申請を読み戻せませんでした', err?.code), code: err?.code };
    }
    reportId = (inserted as { id: string }).id;
  }

  const segRows = a.segments.map((s, i) => ({
    report_id: reportId, phase: a.phase, seg_no: i + 1, start_min: s.startMin, end_min: s.endMin,
  }));
  if (segRows.length > 0) {
    let segErr = (await supabase.from('overtime_report_segments').insert(segRows)).error;
    for (let t = 0; segErr && t < (a.segRetries ?? 0); t++) {
      // 入れ直し：途中まで入った分があれば消してから、もう一度全部入れる
      const { error: delErr } = await supabase.from('overtime_report_segments')
        .delete().eq('report_id', reportId).eq('phase', a.phase).select('id');
      if (delErr) { segErr = delErr; continue; }
      segErr = (await supabase.from('overtime_report_segments').insert(segRows)).error;
    }
    if (segErr) return { ok: false, stage: 'seg_insert', message: '時間帯の保存に失敗しました: ' + segErr.message, reportId };
  }
  return { ok: true, reportId };
}

/**
 * Google カレンダーへの同期。送信のたびに必ず呼ぶ（action:'sync' は現在状態から再計算する冪等処理）。
 * 🚨 supabase.functions.invoke は 4xx/5xx でも throw しない。error と success の両方を見る。
 * 失敗したら false（送信そのものは成立している）。
 */
export async function syncOvertimeGcal(reportId: string): Promise<boolean> {
  const { data: syncRes, error: syncErr } = await supabase.functions.invoke('gcal-sync', {
    body: { action: 'sync', source_type: 'overtime', source_id: reportId },
  });
  const sr = syncRes as { success?: boolean; error?: string } | null;
  return !(syncErr || sr?.success === false);
}

/**
 * 時間外調整休（終日）の二重計上のチェック：休暇から自動計上された調整休（leave_auto）が同じ日にもうあるか。
 * 🚨 DB にこの重複を止める制約は無い（一意索引は manual 同士の1日1件と leave_auto だけ）＝ここが唯一の網。
 * 🚨 2026-09-29：1件フォームから移したとき、**読めなかったら止める**に変えた（以前は error を見ておらず、読めないと素通りしていた）。
 *    戻り値の error があれば送らずにその文を出すこと
 */
export async function findLeaveAutoDuplicate(userId: string, workDate: string): Promise<{ dup: boolean; error: string | null }> {
  const { data, error } = await supabase.from('overtime_reports')
    .select('id').eq('applicant_id', userId).eq('work_date', workDate).eq('entry_type', 'leave_auto').limit(1);
  if (error) return { dup: false, error: '休暇からの調整休の計上を確かめられませんでした（' + error.message + '）。もう一度お試しください' };
  return { dup: (data ?? []).length > 0, error: null };
}

// ── 締め後の許可の依頼（1件フォームから移した・2026-09-29。表入力でも使う）──

/** 経理から締め後の申請を許可された対象日。🚨 読めなかったときは空（＝締め後の日は送れない側に倒れる。最終判断は DB のトリガー） */
export async function fetchGrantedWorkDates(userId: string): Promise<Set<string>> {
  const { data } = await supabase.from('overtime_submission_grants').select('work_date').eq('user_id', userId).is('revoked_at', null);
  return new Set(((data ?? []) as { work_date: string }[]).map(g => g.work_date));
}

export interface GrantRequestRow {
  id: string; work_dates: string[];
  status: 'open' | 'resolved' | 'declined' | 'withdrawn';
  created_at: string; resolve_note: string | null;
}

/** 本人の依頼のうち、依頼中（open）と見送り（declined）。🚨 読めなかったときは rows が空で error に理由（黙って空にしない。画面で「読み込めませんでした」を出す） */
export async function fetchMyGrantRequests(userId: string): Promise<{ rows: GrantRequestRow[]; error: string | null }> {
  const { data, error } = await supabase.from('overtime_submission_grant_requests').select('id, work_dates, status, created_at, resolve_note')
    .eq('user_id', userId).in('status', ['open', 'declined']).order('created_at', { ascending: false });
  return { rows: (data as GrantRequestRow[] | null) ?? [], error: error ? error.message : null };
}

/**
 * 会社カレンダーの休館日（closed_all）の一覧。締め後の依頼の期限（給与データ確定日＝前営業日の遡り）の判定に使う（1件フォームから移した・2026-09-29）。
 * 🚨 読めなかったときは空（＝期限を土日だけで数える。最終判断は DB の overtime_grant_deadline）
 */
export async function fetchClosedAllDates(fromDate: string): Promise<Set<string>> {
  const { data } = await supabase.from('company_calendar').select('date').eq('kind', 'closed_all').gte('date', fromDate);
  return new Set(((data ?? []) as { date: string }[]).map(d => d.date));
}

/** 依頼を送る。失敗の文は grantRequestErrorMessage（lib/overtimeFormParts）で日本語にする */
export async function insertGrantRequest(userId: string, workDates: string[]): Promise<{ ok: true; id: string } | { ok: false; dbMessage: string }> {
  const { data, error } = await supabase.from('overtime_submission_grant_requests')
    .insert({ user_id: userId, work_dates: workDates })
    .select('id')
    .single();
  if (error) return { ok: false, dbMessage: error.message || '' };
  return { ok: true, id: (data as { id: string } | null)?.id ?? '' };
}

/**
 * 依頼を取り下げる。成立しなかったときはその文（成立したら null）。
 * 🚨 update は0件でもエラーにならない（RLSで弾かれても「0件成功」で返る）。件数を見ないと、依頼が残ったままなのに取り下げたように見える。
 * 🚨 status=open を条件に付ける。経理が先に許可・見送りをしていたら、その判断を黙って上書きしない
 */
export async function withdrawGrantRequest(requestId: string): Promise<string | null> {
  const res = await supabase.from('overtime_submission_grant_requests')
    .update({ status: 'withdrawn' }).eq('id', requestId).eq('status', 'open').select('id');
  return describeUpdate(res, '取り下げ', 'competing');
}

// ── まとめて送るときの本物の「書き込み係」（lib/overtimeBulkSend の BulkWriter・2026-09-29）──
// 🚨 表入力（OvertimeGrid.tsx の doSend）にあった問い合わせ・通知を、そのまま移した

export const supabaseBulkWriter: BulkWriter = {
  async reread(id) {
    const { data, error } = await supabase.from('overtime_reports')
      .select('*, segments:overtime_report_segments(phase, seg_no, start_min, end_min)')
      .eq('id', id).maybeSingle();
    return { data: (data as (GridReport & Record<string, unknown>) | null) ?? null, error: error ? error.message : null };
  },
  save: saveOvertimeReport,
  async findExistingManual(userId, date) {
    // 🚨 読めなかったときは error を返す（「内容が違います」と取り違えないため・2026-09-29）
    const { data, error } = await supabase.from('overtime_reports').select('diff_minutes, reason, application_types, location, furikae_origin_date')
      .eq('applicant_id', userId).eq('work_date', date).eq('entry_type', 'manual').neq('status', 'cancelled').maybeSingle();
    return { data: (data as ExistingManual | null) ?? null, error: error ? error.message : null };
  },
  async linkRequest(requestId, reportId) {
    // 🚨 update は0件でもエラーにならないので件数を見る。status=open を条件に入れる（相手が「対応しない」を選んだあとなら触らない）
    const nowIso = new Date().toISOString();
    const { data: linked, error: lerr } = await supabase.from('application_requests')
      .update({ status: 'applied', linked_id: reportId, responded_at: nowIso, updated_at: nowIso })
      .eq('id', requestId).eq('status', 'open').select('id');
    if (lerr || !linked || linked.length === 0) console.error('[申請の依頼] 申請済みにできませんでした', lerr?.message);
  },
  bell: notifyOvertimeNewRequestBell,
  email: notifyOvertimeNewRequestEmail,
  slack: sendOvertimeSlackBatch,
  gcal: syncOvertimeGcal,
};

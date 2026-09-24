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
import type { WorkSegment } from './breakCalc';

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
    const { error: segDelErr } = await supabase.from('overtime_report_segments')
      .delete().eq('report_id', reportId).eq('phase', a.phase).select('id');
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

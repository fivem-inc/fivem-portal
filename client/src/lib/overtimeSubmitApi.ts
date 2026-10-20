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
import { loadMyTripPendingDays } from './tripPending';
import { submitOnce, raceTimeout, SUBMIT_TIMEOUT_MS } from './submitOnce';
import { sendUnstableOnceText, SEND_DELIVERED_CHANGED_TEXT, timeoutSignal, isNetworkFailure } from './netFailure';
import { existingMatchesRecord } from './overtimeBulkSend';

export type SaveStage = 'insert' | 'update' | 'conflict' | 'seg_delete' | 'seg_insert' | 'unknown' | 'delivered_changed';

export type SaveResult =
  /** recovered＝押し直して「さきほどの申請は届いていた」と分かった（2026-10-21 電波 段3） */
  | { ok: true; reportId: string; recovered?: boolean }
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
  /** 送信が8秒を過ぎたとき（灰色の案内を出す・2026-10-21） */
  onSlow?: () => void;
  /** 「届いたか分からない」の文に入れるボタンの名前（既定「申請する」） */
  buttonLabel?: string;
}

/**
 * 書き換えが届いていたか（2026-10-21 電波 段3b）。true＝いまの行が「送った状態・中身」と同じ／false＝違う／null＝読めなかった。
 * 🚨 状態（status）も同じことを条件にする（届いていないのに、予定どおりの実績で中身だけ同じに見えるのを取り違えないため）。
 *    送った記録に状態が無いときは判定しない（false）
 */
async function editLanded(id: string, record: Record<string, unknown>): Promise<boolean | null> {
  if (typeof record.status !== 'string') return false;
  const r = await raceTimeout(signal => supabase.from('overtime_reports')
    .select('status, diff_minutes, reason, application_types, location, furikae_origin_date').eq('id', id).abortSignal(signal).maybeSingle(), 8000);
  if (r === 'timeout' || r.error) return null;
  const row = r.data as (ExistingManual & { status: string }) | null;
  return !!row && row.status === record.status && existingMatchesRecord(row, record);
}

export async function saveOvertimeReport(a: SaveArgs): Promise<SaveResult> {
  let reportId: string;
  let recovered = false;
  if (a.edit) {
    // 🚨 開いてから送るまでの間に、上長が受理・差し戻し・取消をしている場合がある。
    //    status を条件に付けて件数を見ないと、差し戻された申請に実績を上書きしてしまい、
    //    差し戻し理由が残ったまま「実績 確認待ち」に戻る（update は0件でもエラーにならない）
    // 🚨 2026-10-21 電波 段3b：書き換えにも上限（20秒）。応答だけ落ちて押し直すと、1回目で状態が変わっているので0件になる。
    //    そのとき「状態が変わっています」と出さず、読み直して「送った内容と同じ状態・中身」なら届いていたとして続き（記録・時間帯）を行う
    const edit = a.edit;
    const upd = await raceTimeout(signal => supabase.from('overtime_reports')
      .update(a.record).eq('id', edit.id).eq('status', edit.status).select('id').abortSignal(signal), SUBMIT_TIMEOUT_MS);
    const lost = upd === 'timeout' || (!!upd.error && isNetworkFailure(upd.error, upd.status));
    if (upd !== 'timeout' && upd.error && !lost) {
      return { ok: false, stage: 'update', message: friendlyOvertimeDbError(upd.error.message, upd.error.code), code: upd.error.code };
    }
    const updatedRows = upd === 'timeout' || upd.error ? null : upd.data;
    if (!updatedRows || updatedRows.length === 0) {
      const landed = await editLanded(edit.id, a.record);
      if (landed === true) {
        recovered = true;
      } else if (lost || landed === null) {
        return { ok: false, stage: 'unknown', message: sendUnstableOnceText(a.buttonLabel ?? '申請する') };
      } else {
        return { ok: false, stage: 'conflict', message: 'この申請の状態が変わっています（先に受理・差し戻し・取消がされた可能性があります）。画面を更新してからやり直してください。' };
      }
    }
    reportId = edit.id;
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
    // 🚨 2026-10-21 電波 段3：lib/submitOnce で1回だけ届ける（端末で作る番号・20秒まで）。1件フォーム・表入力・まとめて申請の3つがここを通る。
    //    同じ人・同じ日の手入力は DB で1件（uq_overtime_manual_per_day）なので2件にはならないが、押し直したときに
    //    「届いていたのにエラー」に見えるのを防ぐ（自分の番号の行なら届いていた）。中身の比べに送るたびに変わる時刻（◯◯_at）は入れない
    const row = { applicant_id: a.userId, submitted_by: a.userId, entry_type: 'manual', ...a.record };
    const fpRow = Object.fromEntries(Object.entries(row).filter(([k]) => !k.endsWith('_at')));
    const r = await submitOnce({
      userId: a.userId, slot: `ot:${String(a.record.work_date ?? '')}`, fingerprint: JSON.stringify([fpRow, a.phase, a.segments]),
      insert: (id, signal) => supabase.from('overtime_reports').insert({ id, ...row }).abortSignal(signal),
      exists: (id, signal) => supabase.from('overtime_reports').select('id').eq('id', id).abortSignal(signal),
      onSlow: a.onSlow,
    });
    if (r.kind === 'unknown') return { ok: false, stage: 'unknown', message: sendUnstableOnceText(a.buttonLabel ?? '申請する') };
    if (r.kind === 'delivered_changed') return { ok: false, stage: 'delivered_changed', message: SEND_DELIVERED_CHANGED_TEXT };
    if (r.kind === 'rejected') {
      return { ok: false, stage: 'insert', message: friendlyOvertimeDbError(r.error.message, r.error.code), code: r.error.code };
    }
    reportId = r.id;
    recovered = r.recovered;
  }

  const segRows = a.segments.map((s, i) => ({
    report_id: reportId, phase: a.phase, seg_no: i + 1, start_min: s.startMin, end_min: s.endMin,
  }));
  if (segRows.length > 0) {
    // 🚨 時間帯にも上限（20秒）。止まったら「申請は保存されたが時間帯が…」の今までの案内になる
    let segErr = (await supabase.from('overtime_report_segments').insert(segRows).abortSignal(timeoutSignal(20000))).error;
    if (segErr?.code === '23505' && recovered) {
      // 押し直しで届いていた申請：時間帯ももう入っていれば、そのまま成功（件数で確かめる）
      const { count } = await supabase.from('overtime_report_segments').select('id', { count: 'exact', head: true }).eq('report_id', reportId).eq('phase', a.phase);
      if (count === segRows.length) segErr = null;
    }
    for (let t = 0; segErr && t < (a.segRetries ?? 0); t++) {
      // 入れ直し：途中まで入った分があれば消してから、もう一度全部入れる
      const { error: delErr } = await supabase.from('overtime_report_segments')
        .delete().eq('report_id', reportId).eq('phase', a.phase).select('id');
      if (delErr) { segErr = delErr; continue; }
      segErr = (await supabase.from('overtime_report_segments').insert(segRows)).error;
    }
    if (segErr) return { ok: false, stage: 'seg_insert', message: '時間帯の保存に失敗しました: ' + segErr.message, reportId };
  }
  return { ok: true, reportId, recovered };
}

/**
 * 予定どおりの実績報告なら、受理を省いて確認済みにする（2026-10-13）。省けたら true。
 * 🚨 失敗・条件外は false（今までどおり「実績 確認待ち」のまま上長へ受理のお願いを出す）。送信そのものは止めない
 */
export async function confirmAsPlanned(reportId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('overtime_confirm_as_planned', { p_id: reportId });
  if (error) { console.error('[残業] 予定どおりの確認済みにできませんでした', error.message); return false; }
  return data === true;
}

/**
 * 出張報告から作った残業申請が、決定済みのシフト表どおりなら受理を省いて確認済みにする（2026-10-14）。
 * 🚨 合うかは DB の overtime_confirm_trip_rostered が決める（画面の値は信じない）。合わなければ理由が返り、上長の画面にも出る。
 *    失敗しても送信そのものは止めない（今までどおり受理待ち）
 */
export async function confirmTripRostered(reportId: string): Promise<{ confirmed: boolean; reason: string | null }> {
  const { data, error } = await supabase.rpc('overtime_confirm_trip_rostered', { p_id: reportId });
  if (error) { console.error('[残業] 出張の確認済みにできませんでした', error.message); return { confirmed: false, reason: null }; }
  const r = (data ?? {}) as { confirmed?: boolean; reason?: string | null };
  return { confirmed: r.confirmed === true, reason: r.reason ?? null };
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

/**
 * 期間の日を振替元にしている振替休日（取消以外）。振替元の日 → 振替休日の日。
 * 🚨 振替休日が別の給与期間にあっても拾う（振替元の日で引く）。表入力が「振替元の日」の行を入力できなくするのに使う
 */
export async function fetchFurikaeOrigins(userId: string, from: string, to: string): Promise<{ map: Map<string, string>; error: string | null }> {
  const { data, error } = await supabase.from('overtime_reports').select('work_date, furikae_origin_date')
    .eq('applicant_id', userId).eq('entry_type', 'manual').neq('status', 'cancelled')
    .contains('application_types', ['furikae_off']).gte('furikae_origin_date', from).lte('furikae_origin_date', to);
  const map = new Map<string, string>();
  ((data ?? []) as { work_date: string; furikae_origin_date: string | null }[]).forEach(x => { if (x.furikae_origin_date) map.set(x.furikae_origin_date, x.work_date); });
  return { map, error: error ? error.message : null };
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
  // 時間外調整休の二重計上の網（1件フォームと同じ関数・2026-09-29）
  findLeaveAutoDuplicate,
  async findFurikaeByOrigin(userId, originDate) {
    const { data, error } = await supabase.from('overtime_reports').select('work_date')
      .eq('applicant_id', userId).eq('entry_type', 'manual').neq('status', 'cancelled')
      .contains('application_types', ['furikae_off']).eq('furikae_origin_date', originDate);
    return { dates: ((data ?? []) as { work_date: string }[]).map(x => x.work_date), error: error ? error.message : null };
  },
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
  confirmAsPlanned,
  async tripPendingDates() {
    const r = await loadMyTripPendingDays();
    return new Set(r.days.filter(d => d.form === 'overtime').map(d => d.work_date));
  },
  confirmTripRostered,
  slack: sendOvertimeSlackBatch,
  gcal: syncOvertimeGcal,
};

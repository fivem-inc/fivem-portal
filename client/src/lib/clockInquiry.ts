// 打刻の確認（経理 → 本人）の答え・状態の言葉と判定（2026-10-13・計画は docs/計画-打刻の確認の改善.md）。
// 🚨 答えの言葉・選べる答え・「対応待ち」の判定はこの1か所。本人の画面（ClockInquiryResponse）と
//    経理の画面（OvertimeClockInquiryPanel）が同じものを使う。DB の answer_overtime_clock_inquiry にも
//    同じ「状態ごとに選べる答え」があるので、変えるときは両方を直すこと。
import { supabase } from './supabaseClient';
import { calcTotalBreak, calcLaborMinutes, minToTime, formatSignedMin } from './breakCalc';
import type { WorkSegment } from './breakCalc';
import { OT_TYPE_INFO, isOvertimeType, FULL_DAY_TYPES } from './overtimeTypes';
import { STATUS_INFO } from './overtimeStatus';
import type { OvertimeStatus } from './overtimeStatus';

// adjusted＝時間調整をしました（早退・遅出）（2026-10-13・申請を出し忘れた時間調整の日に「打刻が遅れただけ」を選ばれないように）
export type InquiryAnswer = 'pending' | 'worked' | 'adjusted' | 'not_worked' | 'unknown' | 'as_reported' | 'time_differs' | 'will_resubmit';
/** その日の申請の状態（DB の clock_inquiry_day_state と同じ値） */
export type DayState = 'none' | 'leave' | 'reported' | 'planned' | 'returned' | 'fullday';

export interface DayStateRow {
  work_date: string;
  state: DayState;
  report_id: string | null;
  status: string | null;
  application_types: string[] | null;
  is_post_hoc: boolean | null;
  diff_minutes: number | null;
  normal_shift: { labor_minutes?: number; break_minutes?: number } | null;
  segments: { start_min: number; end_min: number }[] | null;
  furikae_origin: boolean;
}

/** ある人の複数の日の状態をまとめて読む（本人か管理者だけ）。🚨 error は必ず返す */
export async function loadDayStates(userId: string, dates: string[]): Promise<{ map: Record<string, DayStateRow>; error: string | null }> {
  if (dates.length === 0) return { map: {}, error: null };
  const { data, error } = await supabase.rpc('clock_inquiry_day_states', { p_user: userId, p_dates: dates });
  if (error) return { map: {}, error: error.message };
  const map: Record<string, DayStateRow> = {};
  for (const r of (data ?? []) as DayStateRow[]) map[r.work_date] = r;
  return { map, error: null };
}

export interface AnswerChoice { value: InquiryAnswer; label: string; desc: string }

/** 打刻（2組目があれば「9:20〜11:45 / 15:41〜20:31」）。2組目は外出・戻りなど（2026-10-13 経理担当の意見） */
export function clockText(d: { clock_in: string | null; clock_out: string | null; clock_in2?: string | null; clock_out2?: string | null }): string {
  const h = (t: string | null | undefined) => (t ? t.slice(0, 5) : '—');
  const first = `${h(d.clock_in)}〜${h(d.clock_out)}`;
  return d.clock_in2 || d.clock_out2 ? `${first} / ${h(d.clock_in2)}〜${h(d.clock_out2)}` : first;
}
/** 最後の打刻＝1組目の退勤・2組目の出勤・2組目の退勤のうち、いちばん遅い時刻。［退勤の打刻］ボタン・「退勤のあと」の判断・打刻ズレの記録に使う。
 *  🚨 押し忘れがあっても送れる（2026-10-16 経理担当の意見）。2組目の退勤を押し忘れた日（9:30〜17:30 / 19:00〜—）は 19:00。
 *     1組目の出勤は入れない（出勤しか押していない日に、出勤の時刻を退勤として扱わないため）。
 *     DB の resolve_clock_inquiry_cancel（greatest(clock_out, clock_in2, clock_out2)）と同じ決め方 */
export const lastClockOut = (d: { clock_out: string | null; clock_in2?: string | null; clock_out2?: string | null }): string | null => {
  const ts = [d.clock_out, d.clock_in2, d.clock_out2].filter((t): t is string => !!t);
  if (ts.length === 0) return null;
  // 'HH:MM' と 'HH:MM:SS' が混ざっても比べられるように先頭5文字で比べる（ゼロ埋めなので文字の大小＝時刻の大小）
  return ts.reduce((a, b) => (b.slice(0, 5) > a.slice(0, 5) ? b : a));
};

/** 何について聞くか（2026-10-13 ユーザー確定）：after＝退勤のあと（今まで）／before＝出勤前／both＝両方。DB の ask_side と同じ値 */
export type AskSide = 'after' | 'before' | 'both';
export const ASK_SIDE_LABEL: Record<AskSide, string> = { after: '退勤のあと', before: '出勤前', both: '両方' };

const hm5 = (t: string | null | undefined) => (t ? t.slice(0, 5) : '');

/** 出勤の打刻がシフトの始まりより早いか（この日だけ「聞くこと」を選べる） */
export function isEarlyClockIn(shiftStart: string | null | undefined, clockIn: string | null | undefined): boolean {
  return !!hm5(shiftStart) && !!hm5(clockIn) && hm5(clockIn) < hm5(shiftStart);
}

/** 最初に選んでおく「聞くこと」。出勤が早く、退勤がシフトの終わりより遅くなければ「出勤前」、ほかは「退勤のあと」 */
export function defaultAskSide(shiftStart: string | null | undefined, shiftEnd: string | null | undefined,
  clockIn: string | null | undefined, clockOut: string | null | undefined): AskSide {
  const late = !!hm5(shiftEnd) && !!hm5(clockOut) && hm5(clockOut) > hm5(shiftEnd);
  return isEarlyClockIn(shiftStart, clockIn) && !late ? 'before' : 'after';
}

/** 本人の画面に出す「◯◯について確認されています」 */
export function askSideNote(side: AskSide, shiftStart: string | null, shiftEnd: string | null, clockIn: string | null, clockOut: string | null): string {
  const before = `出勤前（${hm5(clockIn) || '—'}〜${hm5(shiftStart) || '—'}）`;
  const after = `退勤のあと（${hm5(shiftEnd) || '—'}〜${hm5(clockOut) || '—'}）`;
  const what = side === 'before' ? before : side === 'both' ? `${before}と${after}` : after;
  return `${what}について確認されています`;
}

/** 「定時でした」の言葉は、何について聞いたかで変える */
const NOT_WORKED_LABEL: Record<AskSide, string> = {
  after: '定時でした（打刻が遅れただけ）',
  before: '定時でした（早く来ただけ）',
  both: '定時でした（業務はしていません）',
};

/**
 * その日の状態で選べる答え。🚨 DB の answer_overtime_clock_inquiry の判定と同じ組み合わせ。
 * 申請が無い日は「業務をしていました」を先頭に置く（楽な答えを先頭にしない・2026-08 の方針）
 */
export function answerChoices(state: DayState, askSide: AskSide = 'after'): AnswerChoice[] {
  const unknown: AnswerChoice = { value: 'unknown', label: '思い出せない・その他', desc: '経理に相談します' };
  switch (state) {
    case 'reported':
      return [
        { value: 'as_reported', label: '申請の通りです', desc: '申請した時間で合っています' },
        { value: 'time_differs', label: '時刻が違います', desc: '実際の勤務時間を入れてください（申請の時間が入っています）' },
        unknown,
      ];
    case 'planned':
      return [
        { value: 'as_reported', label: '予定どおり勤務しました', desc: '回答のあと、実績を報告します' },
        { value: 'time_differs', label: '時刻が違います', desc: '実際の勤務時間を入れてください。回答のあと、実績の報告を開きます' },
        unknown,
      ];
    case 'returned':
      return [
        { value: 'will_resubmit', label: '申請を直して出し直します', desc: '回答のあと、申請の修正画面を開きます' },
        unknown,
      ];
    case 'fullday':
      return [
        { value: 'as_reported', label: '申請の通りです', desc: '申請した内容で合っています' },
        unknown,
      ];
    default:
      return [
        { value: 'worked', label: '業務をしていました', desc: '残業として報告します' },
        { value: 'adjusted', label: '時間調整をしました（早退・遅出）', desc: '回答のあと、時間調整の申請を出します' },
        { value: 'not_worked', label: NOT_WORKED_LABEL[askSide], desc: '残業なし・理由を選びます' },
        unknown,
      ];
  }
}

/** 答えの言葉（経理の画面・回答済みの表示）。状態で言い方が変わるもの（予定どおり）があるので state も渡す */
export function answerLabel(answer: InquiryAnswer, state: DayState | null | undefined, askSide: AskSide = 'after'): string {
  if (answer === 'pending') return '未回答';
  if (answer === 'as_reported' && state === 'planned') return '予定どおり勤務しました';
  if (answer === 'not_worked') return NOT_WORKED_LABEL[askSide];
  const found = answerChoices(state ?? 'none').find(c => c.value === answer)
    ?? [...answerChoices('reported'), ...answerChoices('returned'), ...answerChoices('none')].find(c => c.value === answer);
  return found?.label ?? answer;
}

/** 時間帯の文字（"13:00〜22:00 / …"） */
export function segmentsText(segs: { start_min: number; end_min: number }[] | null | undefined): string {
  return (segs ?? []).map(s => `${minToTime(s.start_min)}〜${minToTime(s.end_min)}`).join(' / ');
}

/** 申請の種類の言葉（事前申請／事後報告／終日の種別／振替元） */
export function reportKindText(r: Pick<DayStateRow, 'application_types' | 'is_post_hoc' | 'furikae_origin'>): string {
  if (r.furikae_origin) return '振替休日の振替元';
  const full = (r.application_types ?? []).filter(isOvertimeType).filter(t => (FULL_DAY_TYPES as string[]).includes(t));
  if (full.length > 0) return full.map(t => OT_TYPE_INFO[t].label).join('・');
  return r.is_post_hoc ? '事後報告' : '事前申請';
}

/** 状態の帯の文（本人の画面の各日の1行目） */
export function stateBandText(r: DayStateRow | undefined): { text: string; tone: 'none' | 'app' | 'ret' | 'leave' } {
  if (!r || r.state === 'none') return { text: 'この日は申請が出ていません', tone: 'none' };
  if (r.state === 'leave') return { text: 'この日は休暇の申請があります', tone: 'leave' };
  const st = r.status && STATUS_INFO[r.status as OvertimeStatus] ? STATUS_INFO[r.status as OvertimeStatus].label : '';
  const time = segmentsText(r.segments);
  const head = `${reportKindText(r)}${time ? ` ${time}` : ''}`;
  if (r.state === 'returned') return { text: `この日の申請は差し戻し中です：${head}`, tone: 'ret' };
  if (r.state === 'planned') return { text: `この日は申請が出ています：${head}（${st}・実績の報告がまだ）`, tone: 'app' };
  return { text: `この日は申請が出ています：${head}（${st}）`, tone: 'app' };
}

/** 時間帯から、シフトとの差（分）を出す。休憩は残業申請と同じ自動の計算（breakCalc）。申請の時間と同じ物差し */
export function diffFromShift(segs: WorkSegment[], shiftLaborMin: number | null | undefined): number | null {
  if (segs.length === 0 || shiftLaborMin == null) return null;
  const labor = calcLaborMinutes(segs, calcTotalBreak(segs));
  return labor - shiftLaborMin;
}

export const signedText = (min: number | null | undefined) => (min == null ? '—' : formatSignedMin(min));

/** 「時刻が違います」のひとことの文例（中立な言い方・2026-10-13 レビュー） */
export const TIME_DIFFERS_NOTE_EXAMPLES = ['申請の入力を間違えた', '退勤を押し忘れた', '片付けが長引いた'];

/** 経理の画面の札（その日に経理がすることが残っているか） */
export type FollowUp =
  | { kind: 'action'; label: '対応待ち' }
  | { kind: 'waiting'; label: string }
  | { kind: 'done'; label: string };

export function followUpOf(d: {
  answer: InquiryAnswer; report_state: DayState | null; result_report_id: string | null;
  resolved_kind: 'edited' | 'cancelled' | 'kept' | null;
}, currentReportStatus?: string | null): FollowUp {
  if (d.resolved_kind === 'edited') return { kind: 'done', label: '直しました' };
  if (d.resolved_kind === 'cancelled') return { kind: 'done', label: '取り消しました' };
  if (d.resolved_kind === 'kept') return { kind: 'done', label: 'このまま' };
  if (d.answer === 'pending') return { kind: 'waiting', label: '未回答' };
  if (d.answer === 'time_differs' && d.report_state === 'planned') {
    return currentReportStatus === 'requested' || currentReportStatus === 'request_confirmed'
      ? { kind: 'waiting', label: '本人の実績報告待ち' } : { kind: 'done', label: 'このまま' };
  }
  if (d.answer === 'time_differs' || d.answer === 'unknown') return { kind: 'action', label: '対応待ち' };
  if (d.answer === 'worked' && !d.result_report_id) return { kind: 'waiting', label: '本人の残業報告待ち' };
  if (d.answer === 'adjusted' && !d.result_report_id) return { kind: 'waiting', label: '本人の時間調整の申請待ち' };
  if (d.answer === 'not_worked' && !d.result_report_id) return { kind: 'action', label: '対応待ち' };
  if (d.answer === 'as_reported' && d.report_state === 'planned'
      && (currentReportStatus === 'requested' || currentReportStatus === 'request_confirmed')) {
    return { kind: 'waiting', label: '本人の実績報告待ち' };
  }
  if (d.answer === 'will_resubmit' && currentReportStatus === 'returned') return { kind: 'waiting', label: '本人の出し直し待ち' };
  return { kind: 'done', label: 'このまま' };
}

/** 自分あての、まだ答えていない打刻の確認（残業申請のページの上のカード・2026-10-15） */
export interface MyOpenClockInquiry { id: string; created_at: string; message: string | null; sender_name: string | null; dates: string[] }

/**
 * 自分あての、まだ答えていない打刻の確認を読む（古い順）。
 * 🚨 user_id で必ず絞る（経理・管理者は全員の確認が読めるため、絞らないと他の人の確認が並ぶ）。
 * 読めなかったら error を返す（空の一覧で「確認は無い」と嘘をつかない）
 */
export async function loadMyOpenClockInquiries(userId: string): Promise<{ rows: MyOpenClockInquiry[]; error: string | null }> {
  const { data, error } = await supabase.from('overtime_clock_inquiries')
    .select('id, created_at, message, sender_id, days:overtime_clock_inquiry_days(work_date)')
    .eq('user_id', userId).eq('status', 'open').order('created_at', { ascending: true });
  if (error) return { rows: [], error: error.message };
  const list = (data ?? []) as { id: string; created_at: string; message: string | null; sender_id: string; days: { work_date: string }[] | null }[];
  const senderIds = [...new Set(list.map(r => r.sender_id))];
  let nameOf = new Map<string, string>();
  if (senderIds.length > 0) {
    // 名前が読めなくてもカードは出す（「経理」と出す）
    const { data: profs } = await supabase.from('profiles').select('id, name').in('id', senderIds);
    nameOf = new Map(((profs ?? []) as { id: string; name: string }[]).map(p => [p.id, p.name]));
  }
  return {
    rows: list.map(r => ({
      id: r.id, created_at: r.created_at, message: r.message,
      sender_name: nameOf.get(r.sender_id) ?? null,
      dates: (r.days ?? []).map(d => d.work_date).sort(),
    })),
    error: null,
  };
}

/** 自分あての、まだ答えていない打刻の確認の件数（ナビの数字）。読めなければ 0 */
export async function countMyOpenClockInquiries(userId: string): Promise<number> {
  const { count, error } = await supabase.from('overtime_clock_inquiries')
    .select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('status', 'open');
  if (error) { console.error('[打刻の確認] 件数を読めませんでした', error.message); return 0; }
  return count ?? 0;
}

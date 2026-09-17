// 残業申請のメモ（申請の前に「日付・時刻・理由」を書いておく）。
// 設計は docs/計画-残業申請メモ.md がすべて。DB は overtime_memos（本人だけが読み書きできる）。
//
// 🚨 ここには supabase を読まない処理だけを置く（画面を開かずに検算できるようにするため）。
// 🚨 メモの「何があった？」は**思い出すための目印**であって、申請の種別ではない。
//    申請の種別は今までどおり申請フォームが時刻から判断する（遅刻か調整遅出かは本人が2択で選ぶ）。

import { CLOCK_ONLY_REASONS, reasonExamplesFor } from './overtimeTypes';
import type { OvertimeType } from './overtimeTypes';
import { advanceRequestMaxDate, payPeriodCloseState, payPeriodCloseCutoff, calcPayPeriodStartJst, daysBetweenDateStr } from './breakCalc';

/** メモの「何があった？」 */
export type MemoKind =
  | 'tardiness' | 'early_start' | 'early_leave' | 'overtime' | 'holiday_work'
  | 'day_off' | 'location_change' | 'missed_clock' | 'clock_only' | 'other';

export interface OvertimeMemo {
  id: string;
  kind: MemoKind;
  kind_other: string | null;
  target_date: string;            // "YYYY-MM-DD"
  time_start: string | null;      // "HH:MM"（DBは time 型。読むときに5文字へ切る）
  time_end: string | null;
  location: string | null;
  reason: string;
  applied_at: string | null;
  applied_report_id: string | null;
  created_at: string;
  updated_at: string;
}

/** ボタンの並び（この順に出す）。🚨 「打刻忘れ」と「打刻ズレ」は別のもの（2026-09-17 ユーザー確定） */
export const MEMO_KINDS: { key: MemoKind; label: string }[] = [
  { key: 'tardiness',       label: '遅刻' },
  { key: 'early_start',     label: '早出' },
  { key: 'early_leave',     label: '早退' },
  { key: 'overtime',        label: '残業' },
  { key: 'holiday_work',    label: '休日出勤' },
  { key: 'day_off',         label: '調整休・振替・欠勤' },
  { key: 'location_change', label: '勤務地変更' },
  { key: 'missed_clock',    label: '打刻忘れ' },
  { key: 'clock_only',      label: '打刻ズレ' },
  { key: 'other',           label: 'その他' },
];

export function memoKindLabel(kind: MemoKind): string {
  return MEMO_KINDS.find(k => k.key === kind)?.label ?? 'その他';
}

/** 時刻の欄の名前。null の欄は出さない（調整休・勤務地変更は時刻を持たない） */
export function memoTimeLabels(kind: MemoKind): { start: string | null; end: string | null } {
  switch (kind) {
    case 'tardiness':
    case 'early_start':     return { start: '出勤の時刻', end: null };
    case 'early_leave':
    case 'overtime':        return { start: null, end: '退勤の時刻' };
    case 'holiday_work':    return { start: '出勤の時刻', end: '退勤の時刻' };
    case 'missed_clock':
    case 'clock_only':      return { start: '出勤の打刻', end: '退勤の打刻' };
    case 'other':           return { start: '時刻', end: null };
    default:                return { start: null, end: null };  // day_off / location_change
  }
}

/** 勤務地の欄を出すか */
export function memoNeedsLocation(kind: MemoKind): boolean {
  return kind === 'location_change';
}

/** 理由が必須か。🚨 打刻忘れ・打刻ズレだけ任意（「打刻忘れ」そのものが理由になるため） */
export function memoReasonRequired(kind: MemoKind): boolean {
  return kind !== 'missed_clock' && kind !== 'clock_only';
}

/** 打刻のメモ（今日以前の日付だけ・事後報告でしか出せないため） */
export function isClockMemoKind(kind: MemoKind): boolean {
  return kind === 'missed_clock' || kind === 'clock_only';
}

/** メモの種類 → 申請の種別（理由の文例を選ぶために使う。対応が無いものは null） */
export function memoKindToOvertimeType(kind: MemoKind): OvertimeType | null {
  switch (kind) {
    case 'tardiness':       return 'tardiness';
    case 'early_start':     return 'early_start';
    case 'early_leave':     return 'early_leave';
    case 'overtime':        return 'overtime';
    case 'holiday_work':    return 'holiday_work';
    case 'location_change': return 'location_change';
    default:                return null;
  }
}

/**
 * 理由の文例ボタン。
 * 🚨 申請フォームと同じ文例を使う（lib/overtimeTypes.ts の reasonExamplesFor）。書き写さないこと。
 * 打刻ズレだけは専用の理由（CLOCK_ONLY_REASONS）。「その他」は欄に直接書くのでボタンには出さない。
 */
export function memoReasonExamples(kind: MemoKind): string[] {
  if (kind === 'clock_only' || kind === 'missed_clock') {
    return CLOCK_ONLY_REASONS.filter(r => r !== 'その他');
  }
  if (kind === 'day_off') {
    return ['勤務時間調整のため', '休日出勤の振替のため', '体調不良のため', '私用のため'];
  }
  const t = memoKindToOvertimeType(kind);
  return t ? reasonExamplesFor([t], false, null) : [];
}

/** メモに書ける日付の範囲。下限は掃除（90日）と同じ。上限は事前申請と同じ（3か月先の給与期間まで） */
export function memoDateRange(todayStr: string): { min: string; max: string } {
  return { min: addDaysStr(todayStr, -90), max: advanceRequestMaxDate(todayStr) };
}

/** "YYYY-MM-DD" に日数を足す（UTC で計算するのでタイムゾーンの影響を受けない） */
export function addDaysStr(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}

/** 一覧の見出し（今日／先の予定／過去） */
export function memoSection(memo: OvertimeMemo, todayStr: string): 'today' | 'future' | 'past' {
  if (memo.target_date === todayStr) return 'today';
  return memo.target_date > todayStr ? 'future' : 'past';
}

/**
 * 締め切りの状態。
 *  先の予定・今日 … その日を過ぎると事前申請ができないので、**今日と明日**を 'soon'
 *  過去           … 給与の締め（支給月17日）の7日前から 'soon'、過ぎたら 'closed'
 * 🚨 申請済みのメモは数えない（画面側で除く）。
 */
export function memoDeadlineState(memo: OvertimeMemo, todayStr: string): 'open' | 'soon' | 'closed' {
  if (memo.target_date >= todayStr) {
    return daysBetweenDateStr(todayStr, memo.target_date) <= 1 ? 'soon' : 'open';
  }
  return payPeriodCloseState(memo.target_date, todayStr);
}

/** 過去のメモに添える「10/17まで」（締め切りの日）。先の予定では使わない */
export function memoCloseCutoffLabel(memo: OvertimeMemo): string {
  const cutoff = payPeriodCloseCutoff(calcPayPeriodStartJst(memo.target_date));
  const [, m, d] = cutoff.split('-').map(Number);
  return `${m}/${d}まで`;
}

/** 黄色く出すメモの件数（申請済みは数えない） */
export function memoSoonCount(memos: OvertimeMemo[], todayStr: string): number {
  return memos.filter(m => !m.applied_at && memoDeadlineState(m, todayStr) === 'soon').length;
}

/** 一覧の並び：今日 → 先の予定 → 過去、それぞれ日付の古い順。締め切り済みは過去のいちばん下 */
export function sortMemos(memos: OvertimeMemo[], todayStr: string): OvertimeMemo[] {
  const rank = (m: OvertimeMemo) => {
    const s = memoSection(m, todayStr);
    if (s === 'today') return 0;
    if (s === 'future') return 1;
    return memoDeadlineState(m, todayStr) === 'closed' ? 3 : 2;
  };
  return [...memos].sort((a, b) =>
    rank(a) - rank(b) || a.target_date.localeCompare(b.target_date) || a.created_at.localeCompare(b.created_at));
}

/** 行に出す1行の文字（例：「遅刻 10:05」）。時刻が無ければ種類だけ */
export function memoHeadText(memo: OvertimeMemo): string {
  const label = memo.kind === 'other' ? (memo.kind_other || 'その他') : memoKindLabel(memo.kind);
  const times = [memo.time_start, memo.time_end].filter(Boolean).map(t => (t as string).slice(0, 5));
  return times.length > 0 ? `${label} ${times.join('〜')}` : label;
}

/** 申請画面の上に出す案内の文字（例：「9/17（木）遅刻 のメモから入力しました」） */
export function memoShortLabel(memo: OvertimeMemo): string {
  const [, m, d] = memo.target_date.split('-').map(Number);
  const label = memo.kind === 'other' ? (memo.kind_other || 'その他') : memoKindLabel(memo.kind);
  return `${m}/${d} ${label}`;
}

/** メモを保存できるか（画面の検証）。DB側にも同じ決まりがある */
export function validateMemo(
  draft: { kind: MemoKind | null; kind_other: string; target_date: string; time_start: string; time_end: string; reason: string },
  todayStr: string,
): string {
  if (!draft.kind) return '「何があった？」を選んでください';
  if (draft.kind === 'other' && !draft.kind_other.trim()) return 'その他の内容を書いてください';
  if (!draft.target_date) return '日付を選んでください';
  const { min, max } = memoDateRange(todayStr);
  if (draft.target_date < min) return `メモに書けるのは ${min.replace(/-/g, '/')} 以降の日付です`;
  if (draft.target_date > max) return `メモに書けるのは ${max.replace(/-/g, '/')} までの日付です`;
  if (isClockMemoKind(draft.kind) && draft.target_date > todayStr) return '打刻のメモは今日以前の日付だけです';
  if (memoReasonRequired(draft.kind) && !draft.reason.trim()) return '理由を書いてください';
  return '';
}

// 勤務変更の「カレンダーに入っている予定（まだ出していない分）」の判定（2026-10-05）
//
// ・パートの方が、上長が勤怠カレンダー（attendance_exceptions）に入れた予定を見て、そこから勤務変更を出すための一覧
// ・出す範囲：締め切り前（残業と同じ「支給月の17日」＝ isPayPeriodClosed）で、今日までの日だけ（先の日は予定が変わるので出さない）
// ・「出した」：同じ勤務日の勤務変更（shift_reports）が1件でもあれば出さない（取り消し済みも含む。
//   一意制約（applicant_id, work_date）があり、取り消した日にもう一度出すと止まるため・2026-10-05 ユーザー確定）
// ・調整の遅出・早退（late_start / early_end）は正社員の時間調整なので出さない
// 🚨 判定はここ1か所。画面（ShiftReportTodo）と、のちに作る知らせ（第3段階）が同じ考え方を使う
// 🚨 このファイルは supabase を読まない（判定だけ）

import { isPayPeriodClosed } from './breakCalc';

export interface CalendarEntry {
  date: string;
  type: string;
  location: string | null;
  work_segments: { start: string; end: string; location: string }[] | null;
  notes: string | null;
}

export type ReportType = 'absence' | 'holiday_work' | 'location_change' | 'tardiness' | 'early_leave';

export interface TodoItem {
  date: string;
  /** カレンダーの種類（表示用） */
  calendarType: string;
  /** 勤務変更の種類（入れておくもの）。勤務時間変更は決め打ちできないので空＝本人が選ぶ */
  reportTypes: ReportType[];
  location: string | null;
  segments: { start: string; end: string; location: string }[];
}

// カレンダーの種類 → 勤務変更の種類
const TYPE_MAP: Record<string, ReportType[] | null> = {
  absent:          ['absence'],
  holiday_work:    ['holiday_work'],
  location_change: ['location_change'],
  late:            ['tardiness'],
  early_leave:     ['early_leave'],
  time_change:     [],     // 早出・遅刻・早退・残業のどれかは本人が選ぶ
  late_start:      null,   // 正社員の時間調整（一覧に出さない）
  early_end:       null,
};

/** 一覧に出す分（日付の古い順）。reportedDates＝勤務変更がすでにある勤務日 */
export function buildTodo(entries: CalendarEntry[], reportedDates: Set<string>, today: string): TodoItem[] {
  const out: TodoItem[] = [];
  const seen = new Set<string>();
  for (const e of [...entries].sort((a, b) => a.date.localeCompare(b.date))) {
    const mapped = TYPE_MAP[e.type];
    if (mapped === null || mapped === undefined) continue;
    if (e.date > today) continue;                       // 先の日は出さない
    if (isPayPeriodClosed(e.date, today)) continue;     // 締め切りを過ぎた分は出さない
    if (reportedDates.has(e.date)) continue;            // もう出した
    if (seen.has(e.date)) continue;                     // 同じ日に複数あっても1行（勤務変更は1日1件）
    seen.add(e.date);
    out.push({
      date: e.date,
      calendarType: e.type,
      reportTypes: mapped,
      location: e.location,
      segments: Array.isArray(e.work_segments) ? e.work_segments : [],
    });
  }
  return out;
}

/** 一覧を読む範囲のいちばん古い日（締め切り前の期間の始まり）。前の給与期間がまだ締め切り前なら、その始まり */
export function todoFromDate(today: string): string {
  const [y, m, d] = today.split('-').map(Number);
  // 今日が属する給与期間の開始（16日始まり）
  const curStart = d >= 16 ? new Date(y, m - 1, 16) : new Date(y, m - 2, 16);
  const prevStart = new Date(curStart.getFullYear(), curStart.getMonth() - 1, 16);
  const ymd = (dt: Date) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-16`;
  // 前の期間の日がまだ締め切り前か（締め切り＝支給月の17日）は isPayPeriodClosed で見る
  return isPayPeriodClosed(ymd(prevStart), today) ? ymd(curStart) : ymd(prevStart);
}

// 残業・勤務時間管理の休憩自動計算・法定チェック・時間ユーティリティ
// ルールはスプレッドシート「残業申請表」の計算式を移植（2026-07-20 実データ4件で検証済み）
// 時間量はすべて「分単位の整数」（マイナス値あり・1分単位）で扱う

/** 1つの勤務時間帯（その日の0:00からの分。深夜跨ぎは翌日を+1440分で表現） */
export interface WorkSegment {
  startMin: number;
  endMin: number;
}

/**
 * 休憩の自動計算（1時間帯分）
 * 出勤が13:00前（昼をまたぐ勤務）:
 *   拘束 4:15未満 → 0 / 〜6:30 → 30分 / 〜8:45 → 45分 / 超 → 60分
 * 出勤が13:00以降（午後からの勤務）:
 *   拘束 5:45以下 → 0 / 〜6:15 → 15分 / 〜6:30 → 30分 / 〜8:45 → 45分 / 超 → 60分
 */
export function calcSegmentBreak(startMin: number, endMin: number): number {
  const span = endMin - startMin;
  if (span <= 0) return 0;
  if (startMin < 13 * 60) {
    if (span < 4 * 60 + 15) return 0;
    if (span <= 6 * 60 + 30) return 30;
    if (span <= 8 * 60 + 45) return 45;
    return 60;
  }
  if (span <= 5 * 60 + 45) return 0;
  if (span <= 6 * 60 + 15) return 15;
  if (span <= 6 * 60 + 30) return 30;
  if (span <= 8 * 60 + 45) return 45;
  return 60;
}

/** 分割勤務（最大3時間帯）の休憩合計。時間帯ごとに表を適用して合算（シートの2行目運用と同じ結果） */
export function calcTotalBreak(segments: WorkSegment[]): number {
  return segments.reduce((sum, s) => sum + calcSegmentBreak(s.startMin, s.endMin), 0);
}

/** 拘束時間の合計（時間帯の長さの和。帯間の空き時間は含まない） */
export function calcTotalSpan(segments: WorkSegment[]): number {
  return segments.reduce((sum, s) => sum + Math.max(0, s.endMin - s.startMin), 0);
}

/** 労働時間 = 拘束合計 − 休憩 */
export function calcLaborMinutes(segments: WorkSegment[], breakMinutes: number): number {
  return calcTotalSpan(segments) - breakMinutes;
}

/**
 * 曜日パターン用：最大2つの時間帯（本務＋外出/戻り/テレワーク）から休憩・労働を算出。
 * 時刻はnull（休み）を渡してよい。休みの時間帯は無視する。
 */
export function calcPatternFields(
  band1: { start: number | null; end: number | null },
  band2?: { start: number | null; end: number | null },
): { breakMinutes: number; laborMinutes: number } {
  const segs: WorkSegment[] = [];
  if (band1.start != null && band1.end != null && band1.end > band1.start) segs.push({ startMin: band1.start, endMin: band1.end });
  if (band2 && band2.start != null && band2.end != null && band2.end > band2.start) segs.push({ startMin: band2.start, endMin: band2.end });
  if (segs.length === 0) return { breakMinutes: 0, laborMinutes: 0 };
  const breakMinutes = calcTotalBreak(segs);
  return { breakMinutes, laborMinutes: calcLaborMinutes(segs, breakMinutes) };
}

/** 時間帯の間の空き時間（外出など）の合計。法定チェックで休憩とみなせる */
export function calcGapMinutes(segments: WorkSegment[]): number {
  const sorted = [...segments]
    .filter(s => s.endMin > s.startMin)
    .sort((a, b) => a.startMin - b.startMin);
  let gap = 0;
  for (let i = 1; i < sorted.length; i++) {
    gap += Math.max(0, sorted[i].startMin - sorted[i - 1].endMin);
  }
  return gap;
}

export interface LegalCheckResult {
  ok: boolean;
  /** 法定の最低休憩（分）。0 = 休憩義務なし */
  requiredMinutes: number;
  /** 実際の休み合計（休憩＋帯間の空き時間） */
  actualRestMinutes: number;
}

/**
 * 労働基準法34条チェック（警告のみ・提出はブロックしない）
 * 1日の労働時間 >6h → 休憩45分以上 / >8h → 60分以上
 * 帯間の空き時間（外出）も休憩とみなして算入する
 */
export function checkLegalBreak(segments: WorkSegment[], breakMinutes: number): LegalCheckResult {
  const labor = calcLaborMinutes(segments, breakMinutes);
  const required = labor > 8 * 60 ? 60 : labor > 6 * 60 ? 45 : 0;
  const actualRest = breakMinutes + calcGapMinutes(segments);
  return { ok: actualRest >= required, requiredMinutes: required, actualRestMinutes: actualRest };
}

// ---------- 時間の表示・変換ユーティリティ ----------

/** "HH:MM" → 分（不正値は null） */
export function timeToMin(t: string | null | undefined): number | null {
  if (!t) return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(t);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

/** 分 → "HH:MM"（1440以上は翌日表記「翌1:00」） */
export function minToTime(min: number): string {
  const isNextDay = min >= 1440;
  const m = isNextDay ? min - 1440 : min;
  const hh = Math.floor(m / 60);
  const mm = m % 60;
  return `${isNextDay ? '翌' : ''}${hh}:${String(mm).padStart(2, '0')}`;
}

/** 符号付き分 → "＋H:MM" / "−H:MM" / "0:00" 表記（残高・差分表示用） */
export function formatSignedMin(min: number): string {
  const abs = Math.abs(min);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  const body = `${h}:${String(m).padStart(2, '0')}`;
  if (min > 0) return `＋${body}`;
  if (min < 0) return `−${body}`;
  return body;
}

/** 分 → "H:MM"（符号なし。労働時間・休憩の表示用） */
export function formatMin(min: number): string {
  const abs = Math.abs(min);
  return `${Math.floor(abs / 60)}:${String(abs % 60).padStart(2, '0')}`;
}

// ---------- JST日付ユーティリティ ----------
// toISOString() はUTC基準のためJST深夜0:00〜8:59に前日を返すバグがある（既存コードの教訓）。
// 日付文字列の生成は必ずこちらを使うこと。

/** Date → JSTローカルの "YYYY-MM-DD" */
export function toJstDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 今日のJST日付 "YYYY-MM-DD" */
export function todayJstStr(): string {
  return toJstDateStr(new Date());
}

/** 給与締め期間の開始日（16日〜翌15日締め）。SQL側 calc_pay_period_start と同一ロジック */
export function calcPayPeriodStartJst(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  if (d >= 16) return `${y}-${String(m).padStart(2, '0')}-16`;
  const py = m === 1 ? y - 1 : y;
  const pm = m === 1 ? 12 : m - 1;
  return `${py}-${String(pm).padStart(2, '0')}-16`;
}

/** 締め期間の終了日（開始日の翌月15日） */
export function payPeriodEnd(periodStart: string): string {
  const [y, m] = periodStart.split('-').map(Number);
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return `${ny}-${String(nm).padStart(2, '0')}-15`;
}

/** 締め期間のラベル「今月（7/16〜8/15）」用の期間文字列 */
export function payPeriodLabel(periodStart: string): string {
  const [, m] = periodStart.split('-').map(Number);
  const end = payPeriodEnd(periodStart);
  const [, em] = end.split('-').map(Number);
  return `${m}/16〜${em}/15`;
}

/** 締め期間の給与月ラベル「8月給与分」（締め終了日の月） */
export function payMonthLabel(periodStart: string): string {
  const [, em] = payPeriodEnd(periodStart).split('-').map(Number);
  return `${em}月給与分`;
}

/** 給与期間開始日（16日始まり）を1期分前後にずらす。direction: -1=前の期／1=次の期 */
export function shiftPayPeriod(periodStart: string, direction: -1 | 1): string {
  const [y, m] = periodStart.split('-').map(Number);
  const d = new Date(y, m - 1 + direction, 16);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-16`;
}

/** 給与期間の統一ラベル「8月給与分（7/16〜8/15）」。A/B/C/D 全機能でこれを使う */
export function payMonthPeriodLabel(periodStart: string): string {
  return `${payMonthLabel(periodStart)}（${payPeriodLabel(periodStart)}）`;
}

/**
 * 給与期間の申請・取消の締め切り日（支給月の17日）"YYYY-MM-DD"。
 * この日を過ぎたら本人の新規申請・取消は不可（経理の許可があれば通す）。
 * SQL側トリガー・Edge の締め判定と同一基準。支給月 = 締め終了日の月 = 開始月+1。
 */
export function payPeriodCloseCutoff(periodStart: string): string {
  const [y, m] = periodStart.split('-').map(Number);
  const cy = m === 12 ? y + 1 : y;
  const cm = m === 12 ? 1 : m + 1;
  return `${cy}-${String(cm).padStart(2, '0')}-17`;
}

/** 対象日が「締め済み（新規申請・取消の締め切りを過ぎた）」か。todayStr は JST の今日 "YYYY-MM-DD" */
export function isPayPeriodClosed(workDate: string, todayStr: string): boolean {
  return todayStr > payPeriodCloseCutoff(calcPayPeriodStartJst(workDate));
}

/**
 * 締め後申請の依頼ができる期限（給与データ確定日）"YYYY-MM-DD"。
 * 支給日（支給月25日）の前日を基準に、土日・会社カレンダーの休館日(closed_all)なら前営業日まで遡る。
 * SQL側 overtime_grant_deadline() と同一ロジック。closedDates は company_calendar の closed_all 日付集合。
 */
export function payPeriodGrantDeadline(periodStart: string, closedDates: Set<string>): string {
  const [y, m] = periodStart.split('-').map(Number);
  const cy = m === 12 ? y + 1 : y;
  const cm = m === 12 ? 1 : m + 1;
  const d = new Date(cy, cm - 1, 25); // 25日
  d.setDate(d.getDate() - 1); // 前日から開始
  const fmt = (dt: Date) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  for (let i = 0; i < 31; i++) {
    const dow = d.getDay();
    const ds = fmt(d);
    if (dow !== 0 && dow !== 6 && !closedDates.has(ds)) return ds;
    d.setDate(d.getDate() - 1);
  }
  return fmt(d);
}

/** 対象日の給与期間が「依頼の期限（給与データ確定日）を過ぎた」か。todayStr は JST の今日 "YYYY-MM-DD" */
export function isPayPeriodPayoutPassed(workDate: string, todayStr: string, closedDates: Set<string>): boolean {
  return todayStr > payPeriodGrantDeadline(calcPayPeriodStartJst(workDate), closedDates);
}

// ---------- 曜日パターン・会社カレンダー解決 ----------

export type DayKind = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun' | 'holiday' | 'work_on_closed';
export type CalendarKind = 'closed_all' | 'work_on_closed';

export const DAY_KIND_LABELS: Record<DayKind, string> = {
  mon: '月', tue: '火', wed: '水', thu: '木', fri: '金', sat: '土', sun: '日',
  holiday: '祝（全員休み日）', work_on_closed: '出（休館日だけど出勤日）',
};

export const CALENDAR_KIND_LABELS: Record<CalendarKind, string> = {
  closed_all: '全員休み',
  work_on_closed: '休館日だけど出勤日',
};

const DOW_TO_KIND: DayKind[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/**
 * 日付の day_kind を解決（会社カレンダーの特別区分が曜日より優先）
 * SQL側 sync_overtime_from_leave トリガーと同一ロジック
 */
export function resolveDayKind(dateStr: string, calendarKind: CalendarKind | null | undefined): DayKind {
  if (calendarKind === 'closed_all') return 'holiday';
  if (calendarKind === 'work_on_closed') return 'work_on_closed';
  const [y, m, d] = dateStr.split('-').map(Number);
  return DOW_TO_KIND[new Date(y, m - 1, d).getDay()];
}

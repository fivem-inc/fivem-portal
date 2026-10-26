// 給与計算用の［表で見る］（残業・勤務変更で共用・2026-10-21 ユーザー確定）の小さな部品。
// 見た目は components/admin/PayrollSheetView 1つ。データの作り方だけが残業（OvertimePayrollSheet）と勤務変更（ShiftReportPayrollSheet）で違う
import { calcPayPeriodStartJst, payPeriodEnd, formatMin } from './breakCalc';
import type { CalendarKind } from './breakCalc';
import { leaveDateList } from './leaveDates';
import { statusLabel } from './applicationStatus';

/** 表の1行（1日に申請が2件あれば2行。日付・通常シフトは1行目だけに出す） */
export interface SheetEntry {
  key: string;
  reason: string;
  sign: string;
  actual: string;
  time: string;
  /** 確認待ちなど合計に入らない行（灰色） */
  muted: boolean;
  /** 二重に数えない行（打ち消し線） */
  strike: boolean;
  timeColor?: string;
  /** 合計に入る分（Excel の「時間数（分）」に出す）。合計に入らない行は null（2026-10-22） */
  minutes?: number | null;
  /** 休暇の行（薄いピンク・2026-10-26）。時間数には入れない */
  tone?: 'leave';
}
export interface SheetDay {
  date: string;
  /** 通常シフト（2本なら2行）。空なら offLabel（休み・会社休・—） */
  nsLines: string[];
  offLabel: string;
  /** 労働時間(休憩)。無ければ '-' */
  laborText: string;
  entries: SheetEntry[];
  /** 会社カレンダー（日付の右の「会社」の列・2026-10-26）。無い日は空 */
  company?: CalendarKind | null;
}
export interface SheetPerson { id: string; name: string; employee_no: string | null }
/** 1人分の表（画面・並べて見る・Excel が同じものを使う・2026-10-22） */
export interface PersonSheet {
  total: number | null;
  totalNote: string;
  plannedText: string | null;
  absenceDays: number;
  pendingText: string | null;
  emptyText: string | null;
  days: SheetDay[];
}
/** 記載のある日だけ（［記載のある人を並べて］・Excel の「一覧」） */
export const daysWithEntries = (days: SheetDay[]): SheetDay[] => days.filter(d => d.entries.length > 0);

export const SHEET_DOW = ['日', '月', '火', '水', '木', '金', '土'];
export const dowOf = (ymd: string): number => { const [y, m, d] = ymd.split('-').map(Number); return new Date(y, m - 1, d).getDay(); };
export const sheetMd = (ymd: string): string => `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}`;
export const addDay = (ymd: string): string => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10); };
/** 元の表と同じ書き方：プラスは符号なし、マイナスは半角の「-」 */
export const sheetHm = (min: number): string => (min < 0 ? `-${formatMin(min)}` : formatMin(min));
/** 期の全日（16日〜翌15日） */
export function periodDays(period: string): string[] {
  const out: string[] = [];
  const end = payPeriodEnd(period);
  for (let d = period; d <= end; d = addDay(d)) out.push(d);
  return out;
}
/** 期の選択肢：次の期〜13期前（年つきの名前は画面で作る） */
export function payrollPeriodOptions(currentPeriod: string, extra?: string): string[] {
  const out: string[] = [];
  let p = calcPayPeriodStartJst(addDay(payPeriodEnd(currentPeriod)));
  for (let i = 0; i < 14; i++) {
    out.push(p);
    const [y, m] = p.split('-').map(Number);
    const pm = m === 1 ? 12 : m - 1, py = m === 1 ? y - 1 : y;
    p = `${py}-${String(pm).padStart(2, '0')}-16`;
  }
  if (extra && !out.includes(extra)) out.push(extra);
  return out;
}

/** 1000件ずつ全部読む（Supabase は件数を指定しないと 1000 件で黙って切る） */
export async function readAllRows<T>(make: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<{ rows: T[]; error: string | null }> {
  const rows: T[] = [];
  for (let off = 0; ; off += 1000) {
    const { data, error } = await make(off, off + 999);
    if (error) return { rows, error: error.message };
    const list = (data as T[] | null) ?? [];
    rows.push(...list);
    if (list.length < 1000) break;
  }
  return { rows, error: null };
}

// ── 会社カレンダーの列と休暇の行（2026-10-26 ユーザー確定） ─────────────────
/** 「会社」の列の文字（勤怠カレンダーのマスと同じ色を画面で敷く） */
export const COMPANY_LABEL: Record<CalendarKind, string> = {
  closed_all: '会社休',
  work_on_closed: '休館（出勤日）',
  work_on_closed_encouraged: '休館・有休奨励日',
};

/** 表に出す休暇（差し戻し・取消は読まない） */
export interface SheetLeave {
  id: string; user_id: string; leave_type: string | null; leave_type_other: string | null; status: string;
  leave_dates: string | null; start_date: string | null; end_date: string | null; chosei_sub_type: string | null;
}
/** 休暇の行。🚨 受理済みの時間外調整休（残業から引く）は、残業の側に「休暇から自動」の行があるので出さない（二重に見えないように）。
 *  理由は「休暇：有給休暇」だけ（有休奨励日かどうかは左の「会社」の列で分かる・ユーザー確定 案1） */
export function visibleLeavesOn(leaves: SheetLeave[], userId: string, date: string): SheetLeave[] {
  return leaves
    .filter(l => l.user_id === userId && leaveDateList(l.leave_dates, l.start_date, l.end_date).includes(date))
    .filter(l => !(l.status === 'approved' && l.chosei_sub_type === 'zangyou'));
}
/** 休暇の種類の文字（「有給休暇」「その他（◯◯）」） */
export const leaveTypeText = (l: SheetLeave): string =>
  l.leave_type === 'その他' ? `その他（${(l.leave_type_other ?? '').trim() || '休暇'}）` : (l.leave_type ?? '休暇');
export function leaveEntriesOn(leaves: SheetLeave[], userId: string, date: string): SheetEntry[] {
  return visibleLeavesOn(leaves, userId, date).map(l => {
    const ok = l.status === 'approved';
    return { key: `lv-${l.id}`, reason: `休暇：${leaveTypeText(l)}`, sign: ok ? '受理済み' : `（${statusLabel('leave', l.status)}）`, actual: '', time: '', muted: !ok, strike: false, minutes: null, tone: 'leave' as const };
  });
}
/** 期間にかかる休暇を読む select（残業・勤務変更の［表で見る］で同じもの） */
export const SHEET_LEAVE_SELECT = 'id, user_id, leave_type, leave_type_other, status, leave_dates, start_date, end_date, chosei_sub_type';

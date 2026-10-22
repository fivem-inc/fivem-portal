// 給与計算用の［表で見る］（残業・勤務変更で共用・2026-10-21 ユーザー確定）の小さな部品。
// 見た目は components/admin/PayrollSheetView 1つ。データの作り方だけが残業（OvertimePayrollSheet）と勤務変更（ShiftReportPayrollSheet）で違う
import { calcPayPeriodStartJst, payPeriodEnd, formatMin } from './breakCalc';

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
}
export interface SheetDay {
  date: string;
  /** 通常シフト（2本なら2行）。空なら offLabel（休み・会社休・—） */
  nsLines: string[];
  offLabel: string;
  /** 労働時間(休憩)。無ければ '-' */
  laborText: string;
  entries: SheetEntry[];
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

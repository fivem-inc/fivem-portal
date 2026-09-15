// 出張報告の Excel 出力の中身を作る（2026-09-15・ユーザー依頼）。
// 🚨 supabase を読まない（画面を開かずに検算できるように）。書き出しは admin/TripReportsTab.tsx
// ・シート①「報告一覧」：1報告1行（画面の一覧と同じ項目）
// ・シート②「日ごと」：人×日（日本時間）で1行。到着・終了の時刻と滞在時間。
//   🚨 到着1件・終了1件がそろい、終了が到着より後のときだけ滞在時間を出す。そろわない日は推測で組み合わせず、書き添えで分かるようにする
// ・期間は「報告した日（日本時間）」で絞る：給与期間（16日〜翌15日）／月（1日〜末日）／カスタム期間
// 表示の決め方（区分・次回予定・地図の URL）は lib/tripReportDisplay.ts を使う（2か所に書かない）

import { calcPayPeriodStartJst, payPeriodEnd, toJstDateStr } from './breakCalc';
import { formatTripNextDates, tripCategoryLabel, tripMapUrl } from './tripReportDisplay';

export interface TripExportReport {
  user_id?: string;
  report_type: string;
  category?: string | null;
  category_other?: string | null;
  location?: string | null;
  notes?: string | null;
  address?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  next_dates?: string | null;
  created_at?: string;
  profiles?: { name?: string | null; email?: string | null } | null;
}

export type TripPeriodMode = 'payperiod' | 'month' | 'custom';

/** 報告日（日本時間 "YYYY-MM-DD"） */
export const tripJstDate = (iso: string | undefined): string => (iso ? toJstDateStr(new Date(iso)) : '');

/** 報告の時刻（日本時間の分） */
export function tripJstMinutes(iso: string | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  const d = new Date(t + 9 * 3600 * 1000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

export const tripReporterName = (r: TripExportReport) => r.profiles?.name || r.profiles?.email || '不明';

/** 期間 → [開始日, 終了日]（両端を含む・日本時間の日付） */
export function tripPeriodRange(mode: TripPeriodMode, value: string, from: string, to: string): [string, string] {
  if (mode === 'payperiod') return [value, payPeriodEnd(value)];
  if (mode === 'month') {
    const [y, m] = value.split('-').map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return [`${value}-01`, `${value}-${String(last).padStart(2, '0')}`];
  }
  return [from || '0000-01-01', to || '9999-12-31'];
}

/** "YYYY-MM-DD" の翌日（日付だけの計算） */
export function tripNextDate(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + 1));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}

/** 選べる給与期間・月（報告がある期と今の期。新しい順） */
export function tripPeriodOptions(reports: TripExportReport[], today: string): { payperiods: string[]; months: string[] } {
  const dates = [today, ...reports.map(r => tripJstDate(r.created_at)).filter(Boolean)];
  return {
    payperiods: [...new Set(dates.map(calcPayPeriodStartJst))].sort((a, b) => b.localeCompare(a)),
    months: [...new Set(dates.map(d => d.slice(0, 7)))].sort((a, b) => b.localeCompare(a)),
  };
}

/** Excel の日付のシリアル値（1899-12-30 を 0。Excel はタイムゾーンを持たないので日本時間の見た目で入れる） */
export function excelDateSerial(ymd: string): number | '' {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  return m ? (Date.UTC(+m[1], +m[2] - 1, +m[3]) - Date.UTC(1899, 11, 30)) / 86400000 : '';
}

export const TRIP_LIST_HEADERS = ['報告日', '時刻', '報告者', '種別', '区分', '場所', '備考', '住所', '地図', '次回予定'];
export const TRIP_DAY_HEADERS = ['日付', '報告者', '区分', '場所', '到着', '終了', '滞在', '報告の数', '書き添え'];

/** シート①の行（古い順）。日付・時刻は Excel のシリアル値（書式は書き出す側で付ける） */
export function tripListRows(reports: TripExportReport[]): (string | number)[][] {
  return [...reports]
    .sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')))
    .map(r => {
      const min = tripJstMinutes(r.created_at);
      return [
        excelDateSerial(tripJstDate(r.created_at)), min === null ? '' : min / 1440, tripReporterName(r), r.report_type,
        tripCategoryLabel(r), r.location ?? '', r.notes ?? '', r.address ?? '', tripMapUrl(r.latitude, r.longitude) ?? '',
        formatTripNextDates(r.next_dates),
      ];
    });
}

/** シート②の行（日付→報告者の順） */
export function tripDayRows(reports: TripExportReport[]): (string | number)[][] {
  const groups = new Map<string, TripExportReport[]>();
  for (const r of reports) {
    const key = `${tripJstDate(r.created_at)}|${r.user_id ?? tripReporterName(r)}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))];
  return [...groups.entries()]
    .sort(([a, ga], [b, gb]) => a.split('|')[0].localeCompare(b.split('|')[0]) || tripReporterName(ga[0]).localeCompare(tripReporterName(gb[0]), 'ja'))
    .map(([key, g]) => {
      const sorted = [...g].sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')));
      const arrivals = sorted.filter(r => r.report_type === '到着');
      const ends = sorted.filter(r => r.report_type === '終了');
      const arrMin = arrivals.length ? tripJstMinutes(arrivals[0].created_at) : null;
      const endMin = ends.length ? tripJstMinutes(ends[ends.length - 1].created_at) : null;
      const places = uniq(sorted.map(r => r.location ?? ''));
      const notes: string[] = [];
      if (arrivals.length === 0) notes.push('到着の報告なし');
      if (ends.length === 0) notes.push('終了の報告なし');
      if (sorted.length > 2) notes.push(`報告${sorted.length}件`);
      if (places.length > 1) notes.push(`場所が${places.length}か所`);
      const clean = arrivals.length === 1 && ends.length === 1 && arrMin !== null && endMin !== null && endMin > arrMin;
      if (arrivals.length === 1 && ends.length === 1 && !clean) notes.push('終了が到着より前');
      return [
        excelDateSerial(key.split('|')[0]), tripReporterName(sorted[0]), uniq(sorted.map(r => tripCategoryLabel(r))).join('・'), places.join('・'),
        arrMin === null ? '' : arrMin / 1440, endMin === null ? '' : endMin / 1440, clean ? (endMin! - arrMin!) / 1440 : '',
        sorted.length, notes.join('・'),
      ];
    });
}

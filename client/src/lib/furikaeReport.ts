// 振替休日の実績報告（2026-10-26 ユーザー確定・計画 docs/計画-振替休日の実績報告.md）。
// 振替元の日（休日に働いた日）がまだ来ていないうちに出した振替休日は、ふつうの事前申請と同じく
// 「事前申請 受理済み」→ 振替元の日に［実績を報告する］→ 確定、の流れになる。
// 🚨 判定はここ1か所。画面（履歴の件数・ボタン・取消・カレンダーの印・ホームの件数）はすべてここを呼ぶ。
//    Edge Function（overtime-approve・remind-overtime-unreported）と DB（overtime_confirm_as_planned）は写し。片方だけ直さないこと
// 🚨 印（furikae_report_needed）は DB のトリガー trg_furikae_report_state が決める。画面からは立てない
import { calcPayPeriodStartJst, timeToMin } from './breakCalc';

export interface FurikaeRow {
  status: string;
  work_date: string;
  application_types?: string[] | null;
  furikae_report_needed?: boolean | null;
  furikae_origin_date?: string | null;
  furikae_origin_start?: string | null;
  furikae_origin_end?: string | null;
  request_confirmed_at?: string | null;
}

/** 振替元の実績を報告する振替休日か（印が立っているもの） */
export function isFurikaeReportRow(r: FurikaeRow): boolean {
  return r.furikae_report_needed === true
    && (r.application_types ?? []).includes('furikae_off')
    && !!r.furikae_origin_date;
}

/** 振替元の予定の時間（0時からの分）。終わりが開始以前なら日をまたぐとみなして +1440 */
export function furikaeOriginWindow(r: FurikaeRow): { startMin: number; endMin: number } | null {
  const s = timeToMin((r.furikae_origin_start ?? '').slice(0, 5));
  let e = timeToMin((r.furikae_origin_end ?? '').slice(0, 5));
  if (s == null || e == null) return null;
  if (e <= s) e += 1440;
  return { startMin: s, endMin: e };
}

/**
 * 実績報告のボタンをどこまで出すか（2026-10-26 ユーザー確定「分ける」）。
 * - 'none'       … まだ出さない（振替元の日の前・当日の予定の開始前・受理まち）
 * - 'differ_only'… ［勤務時間が申請と異なりました］だけ（当日の予定の開始から終わりまで）
 * - 'both'       … 両方（当日の予定の終わり以降・翌日以降）
 * 🚨 事前受理（request_confirmed）のときだけ。受理まち（requested）は報告できない（お知らせ・シフト調整・受理を省く判定が崩れるため）
 */
export function furikaeReportGate(r: FurikaeRow, todayStr: string, nowMin: number): 'none' | 'differ_only' | 'both' {
  if (!isFurikaeReportRow(r) || r.status !== 'request_confirmed') return 'none';
  const origin = r.furikae_origin_date as string;
  if (origin > todayStr) return 'none';
  if (origin < todayStr) return 'both';
  const w = furikaeOriginWindow(r);
  if (!w) return 'both';                         // 時刻が読めない行は詰まらせない
  if (nowMin >= w.endMin) return 'both';
  if (nowMin >= w.startMin) return 'differ_only';
  return 'none';
}

/** 報告がまだの振替休日か（催促・件数用）。振替元の日を過ぎた事前受理の分。基準は「翌日」（ふつうの事前申請と同じ） */
export function isFurikaeUnreported(r: FurikaeRow, todayStr: string): boolean {
  return isFurikaeReportRow(r) && r.status === 'request_confirmed' && (r.furikae_origin_date as string) < todayStr;
}

/** 本人がもう取り消せないか（休む日・振替元の日のどちらかが来たら・2026-10-26 ユーザー確定）。Edge Function overtime-approve の cancel と同じ */
export function furikaeSelfCancelLocked(r: FurikaeRow, todayStr: string): boolean {
  if (!isFurikaeReportRow(r)) return false;
  const origin = r.furikae_origin_date as string;
  const first = r.work_date < origin ? r.work_date : origin;
  return todayStr >= first;
}

const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
/** 給与期間の終わり（翌月15日）。pps は期間の初日（16日） */
const periodEnd = (pps: string) => {
  const [y, m] = pps.split('-').map(Number);
  const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
  return `${ny}-${String(nm).padStart(2, '0')}-15`;
};

/**
 * 休む日と振替元の日が別の給与期間なら、止める文（案C・2026-10-26 ユーザー確定）。同じなら null。
 * 🚨 DB のトリガー enforce_furikae_same_period と同じ文。画面で先に出し、送るときは DB が止める
 */
export function furikaePeriodNg(workDate: string, originDate: string): string | null {
  if (!workDate || !originDate) return null;
  const pw = calcPayPeriodStartJst(workDate);
  const po = calcPayPeriodStartJst(originDate);
  if (pw === po) return null;
  return `休む日（${md(workDate)}）は ${md(pw)}〜${md(periodEnd(pw))} の給与期間、振替元の日（${md(originDate)}）は ${md(po)}〜${md(periodEnd(po))} の給与期間です。振替休日は同じ期間の中でだけ出せます。`;
}

/** 給与期間の範囲の文（振替元の日の欄の説明「休む日と同じ給与期間（10/16〜11/15）の日を選んでください」用） */
export function payPeriodRangeLabel(dateStr: string): string {
  const pps = calcPayPeriodStartJst(dateStr);
  return `${md(pps)}〜${md(periodEnd(pps))}`;
}

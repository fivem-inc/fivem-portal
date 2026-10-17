// 管理画面「📊 レポート」の計算（2026-10-17・計画 docs/計画-レポートの作り直し.md）
//
// 🚨 このファイルは React も supabase も読まない（DB の report_overtime_data／report_misc_data が返した記録を受け取って計算するだけ）。テストできるように
// 🚨 残業の数え方は本人のカードと同じ lib/overtimeBalance の computeBalance（A＝1件ずつの差し引きのプラス分）。2か所に書かない
// 🚨 36協定の線は「目安」（法定の8時間・40時間ではなく、いつものシフトを超えた分で数えている）。画面にも書く
// 🚨 3人未満の集まりの平均などは出さない（MIN_GROUP）。順位は付けない

import { computeBalance, type BalanceRow } from './overtimeBalance';
import { calcPayPeriodStartJst, payPeriodEnd } from './breakCalc';

export const MIN_GROUP = 3;
/** 一般・フロア責任者に残業申請を広げた日（前の期と比べるときの印） */
export const OVERTIME_ROLLOUT_DATE = '2026-10-14';
/** 調整休・時間調整が休暇申請から残業申請へ移った日 */
export const OVERTIME_UNIFY_DATE = '2026-10-16';

// ── 日付 ─────────────────────────────────────
export function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}
export function daysBetween(a: string, b: string): number {
  const pa = a.split('-').map(Number); const pb = b.split('-').map(Number);
  return Math.round((Date.UTC(pb[0], pb[1] - 1, pb[2]) - Date.UTC(pa[0], pa[1] - 1, pa[2])) / 86400000);
}
export function prevPeriod(p: string): string { return calcPayPeriodStartJst(addDays(p, -1)); }
export function nextPeriod(p: string): string { return addDays(payPeriodEnd(p), 1); }
/** 年度（4月〜3月）の初日 */
export function fiscalYearStart(dateStr: string): string {
  const [y, m] = dateStr.split('-').map(Number);
  return `${m >= 4 ? y : y - 1}-04-01`;
}
/** タイムスタンプ（ISO）を日本時間の日付に */
export function jstDate(iso: string): string {
  const d = new Date(new Date(iso).getTime() + 9 * 3600_000);
  return d.toISOString().slice(0, 10);
}
const WEEK = ['日', '月', '火', '水', '木', '金', '土'];
export function weekdayOf(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
export const WEEKDAY_LABEL = WEEK;

// ── 数の見せ方 ─────────────────────────────────
export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
export function percentile(xs: number[], p: number): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
}
/** 分 → 「12:30」（時間:分） */
export function hm(min: number): string {
  const sign = min < 0 ? '−' : ''; const a = Math.abs(Math.round(min));
  return `${sign}${Math.floor(a / 60)}:${String(a % 60).padStart(2, '0')}`;
}
/** 時間（小数1けた） */
export function hours1(min: number): string { return (Math.round(min / 6) / 10).toFixed(1); }
/** 時間 → 「3時間」「1.5日」など読みやすく（受理までの時間など） */
export function durationText(hoursVal: number | null): string {
  if (hoursVal === null) return '—';
  if (hoursVal < 1) return `${Math.max(1, Math.round(hoursVal * 60))}分`;
  if (hoursVal < 48) return `${Math.round(hoursVal * 10) / 10}時間`;
  return `${Math.round(hoursVal / 24 * 10) / 10}日`;
}

// ── 校舎（場所は自由に書かれているので、知っている校の名前で見分ける）────
export const SCHOOLS = ['四条本校', '西陣校', '洛西口校', '上桂校', '南草津校'];
export function schoolOf(loc: string | null | undefined): string {
  if (!loc) return '不明';
  let best = ''; let pos = Infinity;
  for (const s of SCHOOLS) {
    const short = s.replace('校', '');
    const i = Math.min(...[loc.indexOf(s), loc.indexOf(short)].filter(x => x >= 0).concat([Infinity]));
    if (i < pos) { pos = i; best = s; }
  }
  if (best) return best;
  if (/在宅|自宅/.test(loc)) return '在宅';
  return 'その他（出張先など）';
}

// ── 記録の型（DB の関数が返す形） ─────────────────
export interface OtRow {
  a: string; wd: string; pp: string; st: BalanceRow['status']; et: string; d: number | null; t: string[]; ph: boolean;
  c: string; rc: string | null; cf: string | null; self: boolean; loc: string | null;
  ns: { start_time?: string | null; end_time?: string | null; start_time2?: string | null; end_time2?: string | null } | null;
  brk: number | null; seg: [number, number][];
}
export interface OtData { rows: OtRow[]; thresholds: Record<string, number | null>; settings: { threshold_minutes: number; banner_group_names: string[] } | null }
export interface Person { id: string; name: string | null; group_names: string[] | null; employment_type: string | null; role_title: string | null; is_active: boolean | null }

const toBalance = (r: OtRow): BalanceRow => ({ pay_period_start: r.pp, status: r.st, entry_type: r.et, work_date: r.wd, diff_minutes: r.d, application_types: r.t });
const tmin = (t: string | null | undefined): number | null => {
  if (!t) return null; const [h, m] = t.split(':').map(Number); return Number.isFinite(h) ? h * 60 + (m || 0) : null;
};

/**
 * いつものシフトの外で働いた時間（B・参考）。実際の時間帯のうち、いつものシフトの時間帯に重ならない分。
 * いつものシフトが無い日（休日出勤など）は、働いた時間帯の全部
 */
export function outsideShiftMinutes(r: OtRow): number {
  if (!r.seg || r.seg.length === 0) return 0;
  const shift: [number, number][] = [];
  const s1 = tmin(r.ns?.start_time), e1 = tmin(r.ns?.end_time), s2 = tmin(r.ns?.start_time2), e2 = tmin(r.ns?.end_time2);
  if (s1 !== null && e1 !== null) shift.push([s1, e1 <= s1 ? e1 + 1440 : e1]);
  if (s2 !== null && e2 !== null) shift.push([s2, e2 <= s2 ? e2 + 1440 : e2]);
  let out = 0;
  for (const [a, b] of r.seg) {
    let inside = 0;
    for (const [x, y] of shift) inside += Math.max(0, Math.min(b, y) - Math.max(a, x));
    out += Math.max(0, (b - a) - inside);
  }
  return out;
}

/** 確定して数える記録（computeBalance と同じ：取り消し・同日の重なる調整休を除く）。B や36協定に使う */
function countedConfirmed(rows: OtRow[]): OtRow[] {
  const conf = rows.filter(r => r.st === 'confirmed');
  const autoDates = new Set(conf.filter(r => r.et === 'leave_auto').map(r => `${r.a}|${r.wd}`));
  return conf.filter(r => !(r.et === 'manual' && r.t.includes('chosei_off') && autoDates.has(`${r.a}|${r.wd}`)));
}

// ── 残業：期ごと・人ごと ──────────────────────────
export interface OtPerson {
  id: string; plus: number; plannedPlus: number; total: number; plannedTotal: number; holidayPlus: number;
  outside: number; threshold: number | null; overThreshold: boolean; group: string; rows: number;
}
/** 人の部門（残業の部門のまとめと同じ：group_names のうち banner_group_names にあるもの） */
export function groupOf(p: Person | undefined, banner: string[]): string {
  const g = (p?.group_names ?? []).find(n => banner.includes(n));
  return g ?? '未所属';
}
/**
 * 期の人ごとの数字。cutDay を渡すと「期の初日から cutDay 日目まで」かつ「その時点までに出ていた申請」だけで数える
 * （途中の期と前の期を同じ日数で比べるため・事後の申請が多いので出した日でも切る）
 */
export function overtimeByPerson(data: OtData, period: string, people: Person[], cutDay?: number): OtPerson[] {
  const banner = data.settings?.banner_group_names ?? [];
  const pmap = new Map(people.map(p => [p.id, p]));
  let rows = data.rows.filter(r => r.pp === period);
  if (cutDay !== undefined) {
    const lastDate = addDays(period, cutDay - 1);
    rows = rows.filter(r => r.wd <= lastDate && jstDate(r.c) <= lastDate);
  }
  const ids = [...new Set(rows.map(r => r.a))];
  return ids.map(id => {
    const mine = rows.filter(r => r.a === id);
    const b = computeBalance(mine.map(toBalance), period);
    const outside = countedConfirmed(mine).reduce((s, r) => s + outsideShiftMinutes(r), 0);
    const threshold = id in data.thresholds ? data.thresholds[id] : (data.settings?.threshold_minutes ?? null);
    return {
      id, plus: b.plus, plannedPlus: b.plannedPlus, total: b.total, plannedTotal: b.plannedTotal, holidayPlus: b.holidayPlus,
      outside, threshold, overThreshold: threshold !== null && b.plannedTotal > threshold,
      group: groupOf(pmap.get(id), banner), rows: mine.length,
    };
  });
}

export const OT_BUCKETS: [string, number, number][] = [
  ['〜10時間', 0, 600], ['10〜20時間', 600, 1200], ['20〜30時間', 1200, 1800], ['30〜45時間', 1800, 2700], ['45時間〜', 2700, Infinity],
];
/** 1人あたりの残業（A・見込み）の分かれ方 */
export function overtimeDistribution(ps: OtPerson[]): { label: string; n: number }[] {
  return OT_BUCKETS.map(([label, lo, hi]) => ({ label, n: ps.filter(p => p.plannedPlus > 0 && p.plannedPlus >= lo && p.plannedPlus < hi).length }));
}
/** 部門ごと（3人未満は平均を出さない） */
export function overtimeByGroup(ps: OtPerson[], banner: string[]): { group: string; n: number; total: number; perPerson: number | null }[] {
  const groups = [...banner, '未所属'];
  return groups.map(g => {
    const mine = ps.filter(p => p.group === g && p.plannedPlus > 0);
    const total = mine.reduce((s, p) => s + p.plannedPlus, 0);
    return { group: g, n: mine.length, total, perPerson: mine.length >= MIN_GROUP ? total / mine.length : null };
  }).filter(x => x.n > 0);
}
/** 負荷の偏り：残業の多い上位2割の人が、全体の何％を占めるか（人が5人未満なら出さない） */
export function top20Share(ps: OtPerson[]): number | null {
  const xs = ps.map(p => p.plannedPlus).filter(x => x > 0).sort((a, b) => b - a);
  if (xs.length < 5) return null;
  const k = Math.max(1, Math.ceil(xs.length * 0.2));
  const all = xs.reduce((s, x) => s + x, 0);
  return all > 0 ? xs.slice(0, k).reduce((s, x) => s + x, 0) / all : null;
}
/** 校舎ごとの残業（A・見込み）と人数（場所で分ける） */
export function overtimeBySchool(data: OtData, period: string): { school: string; minutes: number; people: number }[] {
  const rows = data.rows.filter(r => r.pp === period && r.st !== 'cancelled' && r.st !== 'returned' && (r.d ?? 0) > 0);
  const m = new Map<string, { minutes: number; ids: Set<string> }>();
  for (const r of rows) {
    const s = schoolOf(r.loc);
    const e = m.get(s) ?? { minutes: 0, ids: new Set<string>() };
    e.minutes += r.d ?? 0; e.ids.add(r.a); m.set(s, e);
  }
  return [...m.entries()].map(([school, e]) => ({ school, minutes: e.minutes, people: e.ids.size })).sort((a, b) => b.minutes - a.minutes);
}

// ── 36協定の目安（暦の月・年度） ──────────────────────
export interface Agreement36 {
  id: string;
  months: { ym: string; a: number; b: number; planned: number }[];  // a＝確定（A）・b＝シフトの外（参考）・planned＝確定＋未確定（A）
  fyTotal: number;              // 年度の合計（A・確定）
  over45Count: number;          // 年度に45時間を超えた月の数（A）
  maxAvg2to6: number;           // 2〜6か月の平均のいちばん大きい値（A・休日出勤も含む）
  flags: string[];              // 目安に近い・超えたこと（文）
  thisMonth: { a: number; planned: number; projected: number | null };
}
/** 暦の月ごとの1人ずつの残業（A は1件ずつの差し引きのプラス分）。🚨 給与期間ではなく働いた日の月で分ける */
export function agreement36(data: OtData, today: string): Agreement36[] {
  const fy = fiscalYearStart(today);
  const ym = today.slice(0, 7);
  const ids = [...new Set(data.rows.map(r => r.a))];
  return ids.map(id => {
    const mine = data.rows.filter(r => r.a === id);
    const conf = countedConfirmed(mine);
    const planned = mine.filter(r => ['requested', 'request_confirmed', 'reported'].includes(r.st));
    const monthMap = new Map<string, { a: number; b: number; planned: number }>();
    const add = (k: string) => { if (!monthMap.has(k)) monthMap.set(k, { a: 0, b: 0, planned: 0 }); return monthMap.get(k)!; };
    for (const r of conf) {
      const e = add(r.wd.slice(0, 7));
      if ((r.d ?? 0) > 0) { e.a += r.d!; e.planned += r.d!; }
      e.b += outsideShiftMinutes(r);
    }
    for (const r of planned) if ((r.d ?? 0) > 0) add(r.wd.slice(0, 7)).planned += r.d!;
    const months = [...monthMap.entries()].map(([k, v]) => ({ ym: k, ...v })).sort((x, y) => x.ym.localeCompare(y.ym));
    const fyMonths = months.filter(m => `${m.ym}-01` >= fy);
    const fyTotal = fyMonths.reduce((s, m) => s + m.a, 0);
    const over45Count = fyMonths.filter(m => m.a > 2700).length;
    // 2〜6か月の平均：今月から前へ k か月（記録の無い月は0）
    let maxAvg2to6 = 0;
    for (let k = 2; k <= 6; k++) {
      let sum = 0;
      for (let i = 0; i < k; i++) {
        const [y, mo] = ym.split('-').map(Number); const t = new Date(Date.UTC(y, mo - 1 - i, 1));
        const key = `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}`;
        sum += monthMap.get(key)?.a ?? 0;
      }
      maxAvg2to6 = Math.max(maxAvg2to6, sum / k);
    }
    const cur = monthMap.get(ym) ?? { a: 0, b: 0, planned: 0 };
    // 見込み：日がたってから（10日以上）だけ。まだ早いうちのペースはぶれるので出さない
    const day = Number(today.slice(8, 10));
    const [yy, mm] = ym.split('-').map(Number);
    const dim = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
    const projected = day >= 10 ? cur.a / day * dim : null;
    const flags: string[] = [];
    if (cur.planned >= 2700) flags.push('今月、確定と申請済みの合計が45時間以上');
    else if (projected !== null && projected >= 2700 && cur.a >= 1350) flags.push('今月、このペースだと45時間を超えそう');
    if (cur.planned >= 6000) flags.push('今月、100時間以上');
    if (fyTotal > 21600) flags.push('年度の合計が360時間を超えた');
    if (maxAvg2to6 > 4800) flags.push('2〜6か月の平均が80時間を超えた');
    if (over45Count > 6) flags.push('45時間を超えた月が年6回を超えた');
    return { id, months, fyTotal, over45Count, maxAvg2to6, flags, thisMonth: { a: cur.a, planned: cur.planned, projected } };
  });
}

// ── 受理までの時間・事前申請の割合 ───────────────────
export interface FlowStat { label: string; n: number; selfN: number; medianH: number | null; p90H: number | null; preRate: number | null; returned: number }
const hoursBetween = (a: string, b: string) => (new Date(b).getTime() - new Date(a).getTime()) / 3600_000;
/** 残業：事前申請の受理（作った→受理）・事後の申請の受理（作った→確定）。🚨 自己受理（予定どおりの受理なしも含む）は除いて件数だけ別に */
export function overtimeFlow(data: OtData, period: string): FlowStat {
  const rows = data.rows.filter(r => r.pp === period && r.et === 'manual' && r.st !== 'cancelled');
  const waits: number[] = []; let selfN = 0;
  for (const r of rows) {
    if (!r.ph && r.rc) { if (r.self) selfN++; else waits.push(hoursBetween(r.c, r.rc)); }
    else if (r.ph && r.st === 'confirmed' && r.cf) { if (r.self) selfN++; else waits.push(hoursBetween(r.c, r.cf)); }
  }
  const pre = rows.filter(r => !r.t.includes('clock_only'));
  return {
    label: '残業・時間', n: rows.length, selfN, medianH: median(waits), p90H: percentile(waits, 0.9),
    preRate: pre.length ? pre.filter(r => !r.ph).length / pre.length : null,
    returned: rows.filter(r => r.st === 'returned').length,
  };
}

// ── その他の記録の型 ────────────────────────────
export interface MiscData {
  shift: { a: string; wd: string; pp: string; st: string; t: string[]; os: string | null; oe: string | null; oseg: { start: string; end: string; location?: string | null }[] | null;
    as: string | null; ae: string | null; aseg: { start: string; end: string; location?: string | null }[] | null; lab: number | null; brk: number | null; loc: string | null; c: string; cf: string | null; self: boolean }[];
  att: { u: string; d: string; type: string; loc: string | null }[];
  leave: { u: string; type: string; st: string; dates: string | null; sd: string | null; ed: string | null; c: string; ap: string | null; ap2: string | null }[];
  expense: { u: string; st: string; c: string; ap: string | null; rj: string | null; items: { d: string | null; amt: string | null; type: string | null }[] }[];
  purchase: { st: string; type: string | null; amt: number | null; c: string; loc: string | null; pay: string | null; paid: string | null; done: string | null }[];
  adjust: { d: string; cause: string; st: string; c: string; dc: string | null }[];
  corr: { type: string; kind: string; st: string; c: string; r: string | null }[];
  notice: { s: string; n: number; read: number; med: number | null; req: boolean; conf: number }[];
  safety: { c: string; n: number; ans: number; all: string | null }[];
}
const inRange = (d: string, from: string, to: string) => d >= from && d <= to;
/** 勤務変更の場所（実際→予定→時間帯に書いた場所の順） */
const shiftLoc = (r: MiscData['shift'][number]): string | null =>
  r.loc ?? r.aseg?.find(g => g.location)?.location ?? r.oseg?.find(g => g.location)?.location ?? null;

/** 勤務変更（パートの方）：予定より実際が長い・短い分（分）。期の中の受理済み・申請中（取り消しは除く） */
export function partTimeDelta(misc: MiscData, period: string): { plus: number; minus: number; n: number; people: number; bySchool: { school: string; plus: number; minus: number }[] } {
  const end = payPeriodEnd(period);
  const segMin = (segs: { start: string; end: string }[] | null, s: string | null, e: string | null) => {
    const list = segs && segs.length ? segs : (s && e ? [{ start: s, end: e }] : []);
    return list.reduce((sum, g) => { const a = tmin(g.start), b = tmin(g.end); return a !== null && b !== null ? sum + Math.max(0, (b <= a ? b + 1440 : b) - a) : sum; }, 0);
  };
  const rows = misc.shift.filter(r => r.st !== 'cancelled' && inRange(r.wd, period, end));
  let plus = 0, minus = 0; const ids = new Set<string>(); const sc = new Map<string, { plus: number; minus: number }>();
  for (const r of rows) {
    // 予定（いつものシフト）と実際の時間帯の長さの差。欠勤は実際0・予定のない出勤は予定0
    const orig = segMin(r.oseg, r.os, r.oe);
    const act = r.t.includes('absence') ? 0 : segMin(r.aseg, r.as, r.ae);
    const diff = act - orig;
    if (diff === 0) continue;
    ids.add(r.a);
    const school = schoolOf(shiftLoc(r));
    const s = sc.get(school) ?? { plus: 0, minus: 0 };
    if (diff > 0) { plus += diff; s.plus += diff; } else { minus += diff; s.minus += diff; }
    sc.set(school, s);
  }
  return { plus, minus, n: rows.length, people: ids.size, bySchool: [...sc.entries()].map(([school, v]) => ({ school, ...v })) };
}

/**
 * 欠勤・遅刻・早退（現場の穴）を校舎×曜日で。勤怠カレンダーの予定・残業申請・勤務変更の3つから集め、
 * 🚨 同じ人・同じ日・同じ種類は1つに数える（上長がカレンダーに入れ、本人も申請するため）
 */
export type HoleKind = '欠勤' | '遅刻' | '早退';
export function holes(misc: MiscData, ot: OtData, from: string, to: string): { kind: HoleKind; school: string; wd: number; date: string }[] {
  const out = new Map<string, { kind: HoleKind; school: string; wd: number; date: string }>();
  const put = (u: string, d: string, kind: HoleKind, loc: string | null) => {
    if (!inRange(d, from, to)) return;
    const k = `${u}|${d}|${kind}`;
    if (!out.has(k)) out.set(k, { kind, school: schoolOf(loc), wd: weekdayOf(d), date: d });
  };
  for (const e of misc.att) {
    if (e.type === 'absent') put(e.u, e.d, '欠勤', e.loc);
    else if (e.type === 'late') put(e.u, e.d, '遅刻', e.loc);
    else if (e.type === 'early_leave') put(e.u, e.d, '早退', e.loc);
  }
  for (const r of ot.rows) {
    if (r.st === 'cancelled') continue;
    if (r.t.includes('absence')) put(r.a, r.wd, '欠勤', r.loc);
    if (r.t.includes('tardiness')) put(r.a, r.wd, '遅刻', r.loc);
    if (r.t.includes('early_leave')) put(r.a, r.wd, '早退', r.loc);
  }
  for (const r of misc.shift) {
    if (r.st === 'cancelled') continue;
    const loc = shiftLoc(r);
    if (r.t.includes('absence')) put(r.a, r.wd, '欠勤', loc);
    if (r.t.includes('tardiness')) put(r.a, r.wd, '遅刻', loc);
    if (r.t.includes('early_leave')) put(r.a, r.wd, '早退', loc);
  }
  return [...out.values()];
}

/** シフト調整の相談：件数・決まっていないもの・決まるまでの日数（真ん中） */
export function adjustStats(misc: MiscData, from: string, to: string): { n: number; pending: number; decided: number; medianDays: number | null } {
  const rows = misc.adjust.filter(a => inRange(a.d, from, to) && a.st !== 'cause_cancelled');
  const days = rows.filter(a => a.dc).map(a => hoursBetween(a.c, a.dc!) / 24);
  return { n: rows.length, pending: rows.filter(a => a.st === 'pending').length, decided: rows.filter(a => a.st === 'decided').length, medianDays: median(days) };
}

// ── 休暇 ───────────────────────────────────
/** 休暇の状態の分類（🚨 manager_approved／admin_approved／step2_pending はまだ途中＝申請中。取り消しは数えない） */
export function leaveStateOf(st: string): 'approved' | 'pending' | 'rejected' | 'cancelled' {
  if (st === 'approved') return 'approved';
  if (st === 'rejected') return 'rejected';
  if (st === 'cancelled') return 'cancelled';
  return 'pending';
}
export function leaveDates(l: MiscData['leave'][number]): string[] {
  if (l.dates) { try { const a = JSON.parse(l.dates); if (Array.isArray(a)) return a.filter((x): x is string => typeof x === 'string'); } catch { /* 古い形 */ } }
  if (l.sd && l.ed) { const out: string[] = []; for (let d = l.sd; d <= l.ed && out.length < 400; d = addDays(d, 1)) out.push(d); return out; }
  return l.sd ? [l.sd] : [];
}
/** 期の中の受理済みの休暇の日数（種類ごと）＋残業申請側の終日の休み（10/16 から：時間外調整休・振替休日・欠勤） */
export function leaveSummary(misc: MiscData, ot: OtData, from: string, to: string) {
  const byType = new Map<string, number>(); let pending = 0; const advance: number[] = [];
  for (const l of misc.leave) {
    const st = leaveStateOf(l.st);
    const ds = leaveDates(l).filter(d => inRange(d, from, to));
    if (ds.length === 0) continue;
    if (st === 'approved') byType.set(l.type, (byType.get(l.type) ?? 0) + ds.length);
    if (st === 'pending') pending += 1;
    if (st !== 'cancelled') { const first = leaveDates(l)[0]; if (first) advance.push(daysBetween(jstDate(l.c), first)); }
  }
  // 残業申請側の終日の休み（手で出したもの・確定）。🚨 leave_auto は休暇の調整休と同じものなので数えない
  for (const r of ot.rows) {
    if (r.st !== 'confirmed' || r.et !== 'manual' || !inRange(r.wd, from, to)) continue;
    if (r.t.includes('chosei_off')) byType.set('時間外調整休（残業申請）', (byType.get('時間外調整休（残業申請）') ?? 0) + 1);
    if (r.t.includes('furikae_off')) byType.set('振替休日（残業申請）', (byType.get('振替休日（残業申請）') ?? 0) + 1);
  }
  return { byType: [...byType.entries()].map(([type, days]) => ({ type, days })).sort((a, b) => b.days - a.days), pending, advanceMedian: median(advance), lateCount: advance.filter(x => x < 3).length, total: advance.length };
}
/** 有休の取得の記録（今年度・今日まで・受理済み）。1人1行・少ない順。🚨 判定はしない（事実だけ・2026-10-17 ユーザー確定） */
export function paidLeaveRecord(misc: MiscData, today: string, people: Person[]): { id: string; days: number; last: string | null }[] {
  const fy = fiscalYearStart(today);
  const m = new Map<string, { days: number; last: string | null }>();
  for (const p of people.filter(x => x.is_active)) m.set(p.id, { days: 0, last: null });
  for (const l of misc.leave) {
    if (leaveStateOf(l.st) !== 'approved' || l.type !== '有給休暇') continue;
    for (const d of leaveDates(l)) {
      if (d < fy || d > today) continue;
      const e = m.get(l.u) ?? { days: 0, last: null };
      e.days += 1; if (!e.last || d > e.last) e.last = d; m.set(l.u, e);
    }
  }
  return [...m.entries()].map(([id, v]) => ({ id, ...v })).sort((a, b) => a.days - b.days);
}

// ── 交通費・備品 ───────────────────────────────
export const EXPENSE_TYPE_LABEL: Record<string, string> = { regular: '定期', one_time: '通勤・移動', business_trip: '出張', other: 'その他' };
export function expenseSummary(misc: MiscData, from: string, to: string) {
  const byType = new Map<string, number>(); let approved = 0, pendingAmt = 0, pendingN = 0, rejected = 0; const waits: number[] = [];
  for (const x of misc.expense) {
    const items = x.items.filter(it => it.d && inRange(it.d, from, to));
    if (items.length === 0) continue;
    const amt = items.reduce((s, it) => s + (Number(it.amt) || 0), 0);
    if (x.st === 'approved') {
      approved += amt;
      for (const it of items) { const k = EXPENSE_TYPE_LABEL[it.type ?? 'other'] ?? 'その他'; byType.set(k, (byType.get(k) ?? 0) + (Number(it.amt) || 0)); }
      if (x.ap) waits.push(hoursBetween(x.c, x.ap));
    } else if (x.st === 'pending') { pendingAmt += amt; pendingN += 1; }
    else if (x.st === 'rejected') rejected += 1;
  }
  return { approved, byType: [...byType.entries()].map(([type, amount]) => ({ type, amount })), pendingAmt, pendingN, rejected, medianH: median(waits) };
}
/** 備品：受理・記録まで済んだ状態（全員承認・自分で判断して共有・精算の記録） */
const PURCHASE_DONE = ['board_approved', 'self_judgment_shared', 'recorded', 'leader_approved', 'manager_approved'];
const PURCHASE_TYPE_LABEL: Record<string, string> = { purchase_request: '購入の申請', reimbursement: '精算（立替・会社払いの記録）' };
export function purchaseSummary(misc: MiscData, from: string, to: string) {
  const rows = misc.purchase.filter(p => inRange(jstDate(p.c), from, to) && p.st !== 'returned');
  const waits = rows.filter(p => p.done).map(p => hoursBetween(p.c, p.done!));
  const byPay = new Map<string, number>();
  for (const p of rows) { const k = PURCHASE_TYPE_LABEL[p.type ?? ''] ?? 'その他'; byPay.set(k, (byPay.get(k) ?? 0) + (p.amt ?? 0)); }
  return {
    n: rows.length, amount: rows.reduce((s, p) => s + (p.amt ?? 0), 0),
    // 途中＝受理・記録まで進んでいないもの（取り消し・差し戻しは除く）
    pending: rows.filter(p => p.st.startsWith('pending')).length,
    done: rows.filter(p => PURCHASE_DONE.includes(p.st)).length,
    reimburse: rows.filter(p => p.type === 'reimbursement').length,
    byType: [...byPay.entries()].map(([type, amount]) => ({ type, amount })), medianH: median(waits),
  };
}

// ── 連絡板のお知らせ・安否確認 ─────────────────────
export function noticeSummary(misc: MiscData, from: string, to: string) {
  const rows = misc.notice.filter(n => inRange(jstDate(n.s), from, to) && n.n > 0);
  const n = rows.reduce((s, r) => s + r.n, 0); const read = rows.reduce((s, r) => s + r.read, 0);
  const req = rows.filter(r => r.req);
  const reqN = req.reduce((s, r) => s + r.n, 0); const reqConf = req.reduce((s, r) => s + r.conf, 0);
  return { posts: rows.length, readRate: n ? read / n : null, medianMin: median(rows.map(r => r.med).filter((x): x is number => x !== null)),
    confirmRate: reqN ? reqConf / reqN : null, reqPosts: req.length };
}
export function safetySummary(misc: MiscData, from: string, to: string) {
  return misc.safety.filter(s => inRange(jstDate(s.c), from, to)).map(s => ({
    date: jstDate(s.c), rate: s.n ? s.ans / s.n : null, allHours: s.all ? hoursBetween(s.c, s.all) : null,
  }));
}

// ── 推移（期ごと） ─────────────────────────────
export function overtimeTrend(data: OtData, people: Person[], periods: string[]): { period: string; total: number; people: number; perPerson: number | null }[] {
  return periods.map(p => {
    const ps = overtimeByPerson(data, p, people).filter(x => x.plannedPlus > 0);
    const total = ps.reduce((s, x) => s + x.plannedPlus, 0);
    return { period: p, total, people: ps.length, perPerson: ps.length ? total / ps.length : null };
  });
}

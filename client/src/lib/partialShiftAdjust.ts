import { todayJstStr } from './breakCalc';

// 遅出・早退・勤務地変更の「シフト調整（代わりを探す相談）」（2026-10-20・計画 docs/計画-遅出早退勤務地変更のシフト調整.md）。
// 🚨 supabase を読まない（画面を開かずに検算できるように）。
// 🚨 いない時間の決まりは DB の ot_partial_cover と同じ。画面では選ぶ欄の見出しに出すだけで、保存される「いない時間」は DB が計算する。
//    決まりを変えるときは両方を直す（遅出＝いつものシフトの始まり〜予定の始まり／早退＝予定の終わり〜シフトの終わり／勤務地変更＝シフト全体）

/** 対象の種別（遅刻・調整遅出・早退・調整早退・勤務地変更） */
export const PARTIAL_SHIFT_TYPES = ['location_change', 'late_start_adj', 'tardiness', 'early_end_adj', 'early_leave'] as const;
const FULL_DAY = ['chosei_off', 'furikae_off', 'absence'];

/** 選ぶ欄を出してよい種別の組み合わせか（遅出などを含み、終日の休みを含まない） */
export function isPartialShiftCase(types: readonly string[] | null | undefined): boolean {
  const t = types ?? [];
  return t.some(x => (PARTIAL_SHIFT_TYPES as readonly string[]).includes(x)) && !t.some(x => FULL_DAY.includes(x));
}

/** 説明の1行（ユーザー確定 2026-10-20）。終日の休みの文（SHIFT_ADJUST_SELF_NOTE）とは別 */
export const PARTIAL_SHIFT_NOTE = '判断がつかない場合は「必要」を選択してください。マネージャーが確認し、不要なら「調整不要」にします。';

interface NormalShiftLike {
  start_time?: string | null; end_time?: string | null;
  start_time2?: string | null; end_time2?: string | null;
  location?: string | null;
}

const toMin = (t: string | null | undefined): number | null => {
  if (!t) return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(t);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** いない時間（分）。いつものシフトが無い・予定が無いときは null */
export function partialCover(
  types: readonly string[], ns: NormalShiftLike | null | undefined, planned: { startMin: number; endMin: number }[], location: string,
): { segs: { start: number; end: number }[]; location: string; note: string | null } | null {
  if (!ns) return null;
  const bands: { s: number; e: number }[] = [];
  for (const [a, b] of [[ns.start_time, ns.end_time], [ns.start_time2, ns.end_time2]] as const) {
    const s = toMin(a); let e = toMin(b);
    if (s == null || e == null) continue;
    if (e <= s) e += 1440;
    bands.push({ s, e });
  }
  if (bands.length === 0) return null;
  bands.sort((x, y) => x.s - y.s);
  const loc = types.includes('location_change');
  const late = types.includes('late_start_adj') || types.includes('tardiness');
  const early = types.includes('early_end_adj') || types.includes('early_leave');
  const segs: { start: number; end: number }[] = [];
  let note: string | null = null;
  if (loc) {
    for (const b of bands) segs.push({ start: b.s, end: b.e });
    if (location.includes('→')) note = '移動の時刻は申請に無いため、いつものシフト全体を表示しています';
  } else {
    if (planned.length === 0) return null;
    const ps = Math.min(...planned.map(p => p.startMin));
    const pe = Math.max(...planned.map(p => p.endMin));
    for (const b of bands) {
      if (late && ps > b.s) { const e = Math.min(b.e, ps); if (e > b.s) segs.push({ start: b.s, end: e }); }
      if (early && pe < b.e) { const s = Math.max(b.s, pe); if (b.e > s) segs.push({ start: s, end: b.e }); }
    }
    segs.sort((x, y) => x.start - y.start);
  }
  return { segs, location: ns.location ?? '', note };
}

/** 見出しに出す文「四条本校 13:00〜15:00」（時間帯が2つなら「・」でつなぐ）。時間が出せなければ校だけ */
export function partialCoverLabel(c: { segs: { start: number; end: number }[]; location: string } | null): string {
  if (!c) return '';
  const times = c.segs.map(s => `${hhmm(s.start)}〜${hhmm(s.end)}`).join('・');
  return [c.location, times].filter(Boolean).join(' ');
}

/** DB が保存した写し（shift_adjust_slots.cover_segments など）から見出しの文を作る */
export function slotCoverLabel(location: string | null | undefined, segs: { start: string; end: string }[] | null | undefined): string {
  const times = (segs ?? []).map(s => `${s.start}〜${s.end}`).join('・');
  return [location ?? '', times].filter(Boolean).join(' ');
}

/** 種別の名前（相談の見出し用）。勤務地変更は行き先も添える */
export function partialCauseLabel(types: readonly string[] | null | undefined): string {
  const t = types ?? [];
  const names: string[] = [];
  if (t.includes('tardiness')) names.push('遅刻');
  if (t.includes('late_start_adj')) names.push('調整遅出');   // 種別の札（lib/overtimeTypes の OT_TYPE_INFO）と同じ名前
  if (t.includes('early_leave')) names.push('早退');
  if (t.includes('early_end_adj')) names.push('調整早退');
  if (t.includes('location_change')) names.push('勤務地変更');
  return names.join('・') || '遅出・早退など';
}

export interface PartialToggleReport {
  id: string; applicant_id: string; work_date: string; status: string;
  application_types: string[] | null; is_post_hoc?: boolean | null; from_trip_date?: string | null;
  request_confirmed_at?: string | null; shift_adjust_needed?: boolean | null;
}

/** この申請に欄を出すか（受理済み・取り消されていない・遅出などを含む・事後でない・出張からでない・今日以降） */
export function partialToggleCase(r: PartialToggleReport): boolean {
  return !!r.request_confirmed_at && !['cancelled', 'rejected'].includes(r.status)
    && isPartialShiftCase(r.application_types) && !r.is_post_hoc && !r.from_trip_date && r.work_date >= todayJstStr();
}

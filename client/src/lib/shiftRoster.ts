// シフト管理（勤務表）の計算と表示（2026-09-15）。設計は docs/計画-管理画面の開放.md の 5-1〜5-3。
// 🚨 このファイルは supabase を読まない（画面を開かずに検算できるように）。読み書きは lib/shiftRosterApi.ts
//
// ・1日の中は「時間・校・部門」の区切り（segments）で持つ。area_id=null はその人のメインの部門
// ・つながっている区切り（前の終わり＝次の始まり）は1つの時間帯。間が空けば別の時間帯。時間帯は2つまで
// ・本務（1つ目の時間帯）は長いほう。休憩は時間帯ごとに breakCalc の表を当てて足す
// 🚨 同じ計算が DB の shift_pattern_fields にもある（保存するときは DB が計算し直す）。どちらかを直したら両方直す

import { calcSegmentBreak } from './breakCalc';

export type RosterDayKind = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun' | 'holiday' | 'work_on_closed';
export const ROSTER_WEEK: RosterDayKind[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
export const ROSTER_EXTRA: RosterDayKind[] = ['holiday', 'work_on_closed'];
export const ROSTER_DAY_LABEL: Record<RosterDayKind, string> = {
  mon: '月', tue: '火', wed: '水', thu: '木', fri: '金', sat: '土', sun: '日', holiday: '祝', work_on_closed: '出',
};

export interface RosterSegment {
  start: string;          // "09:30"
  end: string;            // "19:15"
  location: string;       // "四条本校"（今までの行は「四条本校→西陣校」のこともある）
  area_id: string | null; // null＝メインの部門
}

export interface RosterDay {
  segments: RosterSegment[];
  note: string;
}

export interface WorkArea {
  id: string;
  name: string;
  short_name: string;
  color: string;
  sort_order: number;
  active: boolean;
}

/** 表示の色（部門）。🚨 配色は既存の薄い色だけ。白黒でも読めるよう、画面・PDF とも必ず文字を添える */
export const AREA_COLORS: Record<string, { bg: string; fg: string }> = {
  teal: { bg: '#e1f5ee', fg: '#085041' },
  amber: { bg: '#faeeda', fg: '#633806' },
  blue: { bg: '#e6f1fb', fg: '#0c447c' },
  purple: { bg: '#eeedfe', fg: '#3c3489' },
  coral: { bg: '#faece7', fg: '#712b13' },
  pink: { bg: '#fbeaf0', fg: '#72243e' },
  green: { bg: '#eaf3de', fg: '#27500a' },
  gray: { bg: '#f1efe8', fg: '#444441' },
};

export interface PatternRowLike {
  day_kind: string;
  start_time: string | null;
  end_time: string | null;
  start_time2: string | null;
  end_time2: string | null;
  location: string | null;
  segments?: unknown;
  note?: string | null;
  valid_from: string;
  valid_to: string | null;
}

/** "9:30" / "09:30:00" → "09:30"。形が崩れていれば '' */
export function normTime(t: string | null | undefined): string {
  if (!t) return '';
  const m = /^(\d{1,2}):(\d{2})/.exec(t.trim());
  if (!m) return '';
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 24 || mi > 59 || (h === 24 && mi > 0)) return '';
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

export function toMin(t: string): number | null {
  const n = normTime(t);
  if (!n) return null;
  return Number(n.slice(0, 2)) * 60 + Number(n.slice(3, 5));
}

/** 分 → "9:30"（頭の0なし・表示用） */
export function minText(min: number): string {
  return `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`;
}

/** "09:30" → "9:30"（表示用） */
export function timeText(t: string): string {
  const m = toMin(t);
  return m == null ? t : minText(m);
}

/** 今までの列（時間帯2つ・校1つ）から区切りを作る（DB の shift_legacy_segments と同じ） */
export function legacySegments(row: Pick<PatternRowLike, 'start_time' | 'end_time' | 'start_time2' | 'end_time2' | 'location'>): RosterSegment[] {
  const out: RosterSegment[] = [];
  const loc = row.location ?? '';
  if (row.start_time && row.end_time) out.push({ start: normTime(row.start_time), end: normTime(row.end_time), location: loc, area_id: null });
  if (row.start_time2 && row.end_time2) out.push({ start: normTime(row.start_time2), end: normTime(row.end_time2), location: loc, area_id: null });
  return sortSegments(out);
}

function isSegment(v: unknown): v is RosterSegment {
  return !!v && typeof v === 'object' && typeof (v as RosterSegment).start === 'string' && typeof (v as RosterSegment).end === 'string';
}

export function rowToDay(row: PatternRowLike | null | undefined): RosterDay {
  if (!row) return { segments: [], note: '' };
  const segs = Array.isArray(row.segments) && row.segments.every(isSegment)
    ? (row.segments as RosterSegment[]).map(s => ({ start: normTime(s.start), end: normTime(s.end), location: s.location ?? '', area_id: s.area_id || null }))
    : legacySegments(row);
  return { segments: sortSegments(segs), note: row.note ?? '' };
}

export function sortSegments(segs: RosterSegment[]): RosterSegment[] {
  return [...segs].sort((a, b) => (toMin(a.start) ?? 0) - (toMin(b.start) ?? 0));
}

/** 比べるための形（時刻順・時刻の書き方・空白・空の部門をそろえる） */
function canon(day: RosterDay): string {
  return JSON.stringify({
    s: sortSegments(day.segments).map(x => [normTime(x.start), normTime(x.end), x.location.trim(), x.area_id || null]),
    n: day.note.trim(),
  });
}

export function dayEquals(a: RosterDay, b: RosterDay): boolean {
  return canon(a) === canon(b);
}

export interface RosterBand { s: number; e: number; locs: string[]; areaIds: (string | null)[] }

export interface DayFields {
  bands: RosterBand[];          // 時刻順
  breakMinutes: number;
  laborMinutes: number;
  error: string | null;
}

/**
 * 区切りから時間帯・休憩・労働を出す。形がおかしければ error に理由（DB の shift_pattern_fields と同じ決まり）。
 * 🚨 校が正しいか（校の一覧にあるか）はここでは見ない（一覧は画面が持つ）。validateDay で見る
 */
export function deriveFields(segments: RosterSegment[]): DayFields {
  const empty: DayFields = { bands: [], breakMinutes: 0, laborMinutes: 0, error: null };
  if (segments.length === 0) return empty;
  for (const x of segments) {
    if (!normTime(x.start) || !normTime(x.end)) return { ...empty, error: '時刻は「9:30」の形で入れてください' };
  }
  const sorted = sortSegments(segments);
  const bands: RosterBand[] = [];
  let prevEnd: number | null = null;
  for (const x of sorted) {
    const s = toMin(x.start)!;
    const e = toMin(x.end)!;
    if (e <= s) return { ...empty, error: `終わりの時刻は始まりより後にしてください（${timeText(x.start)}〜${timeText(x.end)}）` };
    if (prevEnd != null && s < prevEnd) return { ...empty, error: `時間帯が重なっています（${timeText(x.start)}〜${timeText(x.end)}）` };
    if (!x.location.trim()) return { ...empty, error: `校を選んでください（${timeText(x.start)}〜${timeText(x.end)}）` };
    const parts = x.location.split('→').map(p => p.trim());
    const last = bands[bands.length - 1];
    if (last && last.e === s) {
      last.e = e;
      for (const p of parts) if (last.locs[last.locs.length - 1] !== p) last.locs.push(p);
      last.areaIds.push(x.area_id || null);
    } else {
      const locs: string[] = [];
      for (const p of parts) if (locs[locs.length - 1] !== p) locs.push(p);
      bands.push({ s, e, locs, areaIds: [x.area_id || null] });
    }
    prevEnd = e;
  }
  if (bands.length > 2) return { ...empty, bands, error: `1日の時間帯は2つまでです（間の空いた時間帯が${bands.length}つあります）` };
  const breakMinutes = bands.reduce((sum, b) => sum + calcSegmentBreak(b.s, b.e), 0);
  const span = bands.reduce((sum, b) => sum + (b.e - b.s), 0);
  return { bands, breakMinutes, laborMinutes: span - breakMinutes, error: null };
}

/** 本務（1つ目の時間帯）＝長いほう。同じ長さなら早いほう（DB と同じ） */
export function mainBand(bands: RosterBand[]): RosterBand | null {
  if (bands.length === 0) return null;
  if (bands.length === 1) return bands[0];
  return (bands[1].e - bands[1].s) > (bands[0].e - bands[0].s) ? bands[1] : bands[0];
}

/** 入力の確かめ。校の一覧（workplaces）にない校も断る。問題なければ null */
export function validateDay(day: RosterDay, workplaces: string[]): string | null {
  const f = deriveFields(day.segments);
  if (f.error) return f.error;
  for (const x of day.segments) {
    for (const p of x.location.split('→').map(s => s.trim())) {
      if (!workplaces.includes(p)) return `「${p}」という校はありません`;
    }
  }
  if (day.note.trim().length > 100) return '曜日の書き添えは100文字までです';
  return null;
}

/** "四条本校" → "本校"、"西陣校" → "西陣"（表のマス用の短い名前） */
export function shortSchool(name: string): string {
  return name.replace('四条本校', '本校').replace(/校$/, '');
}

export function areaOf(areas: WorkArea[], areaId: string | null, mainAreaId: string | null): WorkArea | null {
  const id = areaId || mainAreaId;
  return id ? areas.find(a => a.id === id) ?? null : null;
}

/** 1日の時間の文（"9:30〜19:15" や "6:30〜7:15 / 9:30〜17:30"）。休みは '' */
export function dayTimeText(day: RosterDay): string {
  return deriveFields(day.segments).bands.map(b => `${minText(b.s)}〜${minText(b.e)}`).join(' / ');
}

/** 1日の場所の区切り（表のマス・PDF 用）。部門の色を付ける側が使う */
export interface PlaceStep { school: string; area: WorkArea | null; start: string; end: string }
export function placeSteps(day: RosterDay, areas: WorkArea[], mainAreaId: string | null): PlaceStep[] {
  const out: PlaceStep[] = [];
  for (const x of sortSegments(day.segments)) {
    const area = areaOf(areas, x.area_id, mainAreaId);
    const start = normTime(x.start);
    const end = normTime(x.end);
    for (const p of x.location.split('→').map(s => s.trim()).filter(Boolean)) {
      const last = out[out.length - 1];
      if (last && last.school === p && (last.area?.id ?? null) === (area?.id ?? null) && last.end === start) {
        last.end = end;
      } else {
        out.push({ school: p, area, start, end });
      }
    }
  }
  return out;
}

/** 週の労働時間の合計（分） */
export function weekLaborMinutes(days: Partial<Record<RosterDayKind, RosterDay>>): number {
  return ROSTER_WEEK.reduce((sum, k) => sum + (days[k] ? deriveFields(days[k]!.segments).laborMinutes : 0), 0);
}

/** その日に効いている行（valid_from ≤ 日 ≤ valid_to） */
export function rowOnDate<T extends Pick<PatternRowLike, 'valid_from' | 'valid_to'>>(rows: T[], date: string): T | undefined {
  return rows.find(r => r.valid_from <= date && (r.valid_to === null || r.valid_to >= date));
}

/** "2026-10-01" の前日 */
export type ShiftTimeIssueKind =
  | 'no_shift' | 'off' | 'before_start' | 'leaves_early' | 'outside' | 'partial' | 'other_school' | 'unknown_school';

/**
 * ある時間（開始 s〜終了 e・分）に、その人がその校で勤務しているか（問題が無ければ null）。
 * ③ 勉強会と ④ 掃除担当表の ⚠️ が同じこの1か所を使う（2026-09-15）。
 * ・勤務時間帯の中に収まれば OK（終了ちょうどに終わるのは OK、終了ちょうどに始まるのは outside）
 * ・出勤より前にかかる → before_start（detail＝出勤の時刻）／途中で退勤 → leaves_early（detail＝退勤の時刻）／
 *   時間帯をまたぐなど → partial／全部外れる → outside／休み → off／週のシフトが無い → no_shift
 * ・校が決まっていれば、その時間にかかる区切りの校が全部同じなら OK。「A→B」で移る時刻が分からない → unknown_school
 * 🚨 休憩は時刻を持っていないので判定できない
 */
export function shiftTimeIssue(
  s: number, e: number, location: string | null, day: RosterDay | null,
): { kind: ShiftTimeIssueKind; detail: string; overlap: boolean } | null {
  if (!day) return { kind: 'no_shift', detail: '', overlap: false };
  const bands = [...deriveFields(day.segments).bands].sort((a, b) => a.s - b.s);
  if (bands.length === 0) return { kind: 'off', detail: '', overlap: false };
  if (!bands.some(b => b.s <= s && e <= b.e)) {
    const overlapping = bands.filter(b => b.s < e && s < b.e);
    if (overlapping.length === 0) {
      // 勤務の時間帯に全く重ならない：次の出勤があれば「◯時出勤」、無ければ「◯時に退勤」（overlap=false）
      const next = bands.find(b => b.s >= e);
      if (next) return { kind: 'before_start', detail: minText(next.s), overlap: false };
      const prev = [...bands].reverse().find(b => b.e <= s);
      return prev ? { kind: 'leaves_early', detail: minText(prev.e), overlap: false } : { kind: 'outside', detail: '', overlap: false };
    }
    if (overlapping.length === 1) {
      const b = overlapping[0];
      if (s < b.s && e <= b.e) return { kind: 'before_start', detail: minText(b.s), overlap: true };
      if (s >= b.s && e > b.e) return { kind: 'leaves_early', detail: minText(b.e), overlap: true };
    }
    return { kind: 'partial', detail: '', overlap: true };
  }
  if (location) {
    const schools = new Set<string>();
    for (const x of sortSegments(day.segments)) {
      const xs = toMin(x.start) ?? 0;
      const xe = toMin(x.end) ?? 0;
      if (!(xs < e && s < xe)) continue;
      if (x.location.includes('→')) return { kind: 'unknown_school', detail: x.location, overlap: true };
      schools.add(x.location.trim());
    }
    const list = [...schools];
    if (list.length > 0 && list.some(sch => sch !== location)) return { kind: 'other_school', detail: list.join('・'), overlap: true };
  }
  return null;
}

/** その人のその曜日のシフト（date に効いている版）。ほかの曜日の行があれば「休み」、1行も無ければ null（未登録） */
export function shiftDayOn<T extends PatternRowLike>(rows: T[], dayKind: string, date: string): RosterDay | null {
  const row = rowOnDate(rows.filter(r => r.day_kind === dayKind), date);
  if (row) return rowToDay(row);
  return rows.some(r => r.valid_from <= date && (r.valid_to === null || r.valid_to >= date)) ? { segments: [], note: '' } : null;
}

export function prevDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d - 1));
  return dt.toISOString().slice(0, 10);
}

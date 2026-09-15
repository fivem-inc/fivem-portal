// ④ 掃除担当表の計算と表示（2026-09-15）。設計は docs/計画-管理画面の開放.md の 5-8〜5-8-2。
// 🚨 このファイルは supabase を読まない。読み書きは lib/cleaningRosterApi.ts
//
// ・行（校・階・仕事）×曜日のマス。マスは「いつから」で版（変えたマスだけ・先の版は残す）
// ・マスの中身：人と開始時刻（時刻なしもある）を何行でも＋書き添え1つ／「この日は無し」（斜線）／空（未入力）
// ・⚠️ は保存しない。週のシフトから計算（判定は lib/shiftRoster.ts の shiftTimeIssue・勉強会と共通）
// ・表の下の「休み」「担当なし」も週のシフトから自動（掃除の対象外の人は出さない）

import {
  ROSTER_DAY_LABEL, deriveFields, minText, normTime, shiftDayOn, shiftTimeIssue, shortSchool, toMin,
  type PatternRowLike, type RosterDay, type RosterDayKind, type ShiftTimeIssueKind,
} from './shiftRoster';

export interface CleaningRow {
  id: string;
  school: string;
  floor: string | null;
  task: string;
  short_name: string;
  vacuum_mark: boolean;
  note_below: string | null;
  minutes: number;
  sort_order: number;
  active: boolean;
}

export interface CleaningEntry {
  user_id: string;
  start: string; // "09:30"・時刻なしは ''
}

export interface CleaningCellValue {
  is_none: boolean;
  note: string;
  entries: CleaningEntry[];
}

export interface CleaningCellVersion extends CleaningCellValue {
  id: string;
  row_id: string;
  day_kind: RosterDayKind;
  valid_from: string;
  valid_to: string | null;
}

export interface CleaningNote {
  id: string;
  kind: 'title' | 'note';
  body: string;
  sort_order: number;
  active: boolean;
}

export const CLEANING_WEEK: RosterDayKind[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
export const EMPTY_CELL: CleaningCellValue = { is_none: false, note: '', entries: [] };

export const cellKey = (rowId: string, day: RosterDayKind) => `${rowId}|${day}`;

/** date に効いているマスの版 */
export function cellVersionOn(cells: CleaningCellVersion[], rowId: string, day: RosterDayKind, date: string): CleaningCellVersion | undefined {
  return cells.find(c => c.row_id === rowId && c.day_kind === day && c.valid_from <= date && (c.valid_to === null || c.valid_to >= date));
}

export function cellValue(v: CleaningCellValue | undefined): CleaningCellValue {
  if (!v) return EMPTY_CELL;
  return { is_none: v.is_none, note: v.note ?? '', entries: v.entries.map(e => ({ user_id: e.user_id, start: normTime(e.start) })) };
}

/** 保存の関数と同じ見方で比べる（時刻は "9:30" と "09:30" を同じに・書き添えは前後の空白を無視） */
export function cellEquals(a: CleaningCellValue, b: CleaningCellValue): boolean {
  if (a.is_none !== b.is_none || a.note.trim() !== b.note.trim() || a.entries.length !== b.entries.length) return false;
  return a.entries.every((e, i) => e.user_id === b.entries[i].user_id && normTime(e.start) === normTime(b.entries[i].start));
}

export function cellIsEmpty(v: CleaningCellValue): boolean {
  return !v.is_none && !v.note.trim() && v.entries.length === 0;
}

/** 入力のまちがい（保存の前に止める。無ければ null）。🚨 保存の関数の確かめと同じ中身 */
export function cellError(v: CleaningCellValue): string | null {
  if (v.is_none && v.entries.length > 0) return '「この日は無し」のマスに人は入れられません';
  if (v.entries.length > 6) return '1つのマスに入れられるのは6人までです';
  if (v.note.length > 100) return '書き添えは100文字までです';
  if (v.entries.some(e => !e.user_id)) return '人を選んでください';
  if (v.entries.some(e => e.start && !normTime(e.start))) return '時刻は「9:30」の形で入れてください';
  const sigs = v.entries.map(e => `${e.user_id}@${normTime(e.start)}`);
  if (new Set(sigs).size !== sigs.length) return '同じ人・同じ時刻が2回入っています';
  return null;
}

/** 勤務表の欄に書く場所：「4Fトイレ」「本校 看板・外回り」「西陣 ゴミ出し」 */
export function rowPlaceLabel(row: Pick<CleaningRow, 'school' | 'floor' | 'short_name'>): string {
  if (row.floor) return `${row.school === '四条本校' ? '' : `${shortSchool(row.school)} `}${row.floor}${row.short_name}`;
  return `${shortSchool(row.school)} ${row.short_name}`;
}

export interface CleaningIssue {
  userId: string;
  start: string;
  kind: ShiftTimeIssueKind;
  text: string;
  key: string; // 「確認した」に使う。ずれ方が変わると変わる
}

function issueText(kind: ShiftTimeIssueKind, name: string, detail: string): string {
  switch (kind) {
    case 'no_shift': return `${name}さんは週のシフトが未登録です`;
    case 'off': return `${name}さんはこの曜日が休みです`;
    case 'before_start': return `${name}さんは ${detail} 出勤です`;
    case 'leaves_early': return `${name}さんは ${detail} に退勤します`;
    case 'outside': return `${name}さんはこの時間に勤務していません`;
    case 'partial': return `${name}さんは一部の時間が勤務時間外です`;
    case 'other_school': return `${name}さんはこの時間 ${detail}`;
    case 'unknown_school': return `${name}さんの校を確かめられません（「${detail}」で移る時刻が未登録）`;
  }
}

/**
 * マスの ⚠️（時刻のある人だけ）。
 * @param dayOf その人のその曜日のシフト（未登録なら null）
 */
export function cellIssues(
  row: Pick<CleaningRow, 'school' | 'minutes'>,
  value: CleaningCellValue,
  dayOf: (userId: string) => RosterDay | null,
  fullNames: Map<string, string>,
): CleaningIssue[] {
  if (value.is_none) return [];
  const out: CleaningIssue[] = [];
  for (const e of value.entries) {
    const s = toMin(e.start);
    if (s === null || !e.start) continue;
    const r = shiftTimeIssue(s, s + row.minutes, row.school, dayOf(e.user_id));
    if (!r) continue;
    out.push({
      userId: e.user_id, start: normTime(e.start), kind: r.kind,
      text: issueText(r.kind, fullNames.get(e.user_id) ?? '（不明）', r.detail),
      key: `${r.kind}|${e.user_id}|${normTime(e.start)}|${r.detail}`,
    });
  }
  return out;
}

/** 週のシフトの行を人ごとに持っているときの dayOf */
export function dayOfFrom(rowsByUser: Map<string, PatternRowLike[]>, day: RosterDayKind, date: string) {
  return (userId: string) => shiftDayOn(rowsByUser.get(userId) ?? [], day, date);
}

/**
 * 表の下の「休み」「担当なし」（その曜日・date に効いている週のシフトから）
 * ・休み＝週のシフトが登録されているのに、その曜日は勤務なし。🚨 正社員だけ（2026-09-15 ユーザー確定・紙に合わせる）
 * ・担当なし＝その曜日に勤務するのに、どの行のマスにも入っていない（パートの方も出す）
 * 🚨 掃除の対象外の人・週のシフトが1行も無い人（管理用のアカウントなど）は出さない
 * @param isFullTime 正社員か（画面は lib/shiftExcelImport.ts の isShiftTarget で渡す）
 */
export function offAndUnassigned(
  staffIds: string[],
  excluded: Set<string>,
  rowsByUser: Map<string, PatternRowLike[]>,
  day: RosterDayKind,
  date: string,
  assigned: Set<string>,
  isFullTime: (userId: string) => boolean,
): { off: string[]; unassigned: string[] } {
  const off: string[] = [];
  const unassigned: string[] = [];
  for (const id of staffIds) {
    if (excluded.has(id)) continue;
    const d = shiftDayOn(rowsByUser.get(id) ?? [], day, date);
    if (!d) continue;
    if (deriveFields(d.segments).bands.length === 0) { if (isFullTime(id)) off.push(id); }
    else if (!assigned.has(id)) unassigned.push(id);
  }
  return { off, unassigned };
}

/**
 * 勤務表の「掃除」の欄（その人・その曜日）。
 * ・同じ時刻・同じ校は1行にまとめる（「13:15 西陣 掃除機・拭き掃除」）
 * ・その校のその曜日の全部の行（無しを除く）に入っているときは「9:00 上桂 全部」
 */
export function rosterCleaningLines(
  rows: CleaningRow[],
  valueOf: (rowId: string) => CleaningCellValue,
  userId: string,
): string[] {
  const active = rows.filter(r => r.active);
  const bySchool = new Map<string, CleaningRow[]>();
  for (const r of active) bySchool.set(r.school, [...(bySchool.get(r.school) ?? []), r]);
  const lines: { sortMin: number; text: string }[] = [];
  for (const [school, schoolRows] of bySchool) {
    const mine = schoolRows.flatMap(r => valueOf(r.id).entries.filter(e => e.user_id === userId).map(e => ({ r, start: normTime(e.start) })));
    if (mine.length === 0) continue;
    const workRows = schoolRows.filter(r => !valueOf(r.id).is_none);
    const coversAll = workRows.length > 1 && workRows.every(r => mine.some(m => m.r.id === r.id));
    const starts = [...new Set(mine.map(m => m.start))];
    if (coversAll && starts.length === 1) {
      lines.push({ sortMin: toMin(starts[0]) ?? 9999, text: `${starts[0] ? `${minText(toMin(starts[0]) ?? 0)} ` : ''}${shortSchool(school)} 全部` });
      continue;
    }
    for (const st of starts) {
      const places = mine.filter(m => m.start === st).map(m => rowPlaceLabel(m.r));
      const joined = school === '四条本校' || places.length === 1
        ? places.join('・')
        : `${shortSchool(school)} ${mine.filter(m => m.start === st).map(m => m.r.short_name).join('・')}`;
      lines.push({ sortMin: toMin(st) ?? 9999, text: `${st ? `${minText(toMin(st) ?? 0)} ` : ''}${joined}` });
    }
  }
  return lines.sort((a, b) => a.sortMin - b.sortMin).map(l => l.text);
}

/**
 * PDF で校×曜日を1マスにまとめて描くか。
 * ・全部の行が「この日は無し」 → { kind: 'none' }（1本の斜線）
 * ・全部の行が同じ1人・同じ時刻（または時刻なし）・書き添えなし → { kind: 'one' }（上桂の日曜「西村」）
 */
export function mergedSchoolDay(
  schoolRows: CleaningRow[],
  valueOf: (rowId: string) => CleaningCellValue,
): { kind: 'none' } | { kind: 'one'; userId: string; start: string } | null {
  const rows = schoolRows.filter(r => r.active);
  if (rows.length < 2) return null;
  const vals = rows.map(r => valueOf(r.id));
  if (vals.every(v => v.is_none)) return { kind: 'none' };
  const first = vals[0].entries[0];
  if (!first || vals.some(v => v.is_none || v.note.trim() || v.entries.length !== 1)) return null;
  if (vals.every(v => v.entries[0].user_id === first.user_id && normTime(v.entries[0].start) === normTime(first.start))) {
    return { kind: 'one', userId: first.user_id, start: normTime(first.start) };
  }
  return null;
}

/** マスの文字（画面・PDF 共通）：「恭子 9:30」「小川（授業前）」「森本・山田 10:00」 */
export function cellLines(value: CleaningCellValue, names: Map<string, string>): string[] {
  if (value.is_none) return [];
  const groups: { start: string; names: string[] }[] = [];
  for (const e of value.entries) {
    const st = normTime(e.start);
    const g = groups.find(x => x.start === st && st !== '');
    const nm = names.get(e.user_id) ?? '（不明）';
    if (g) g.names.push(nm);
    else groups.push({ start: st, names: [nm] });
  }
  const lines = groups.map(g => `${g.names.join('・')}${g.start ? ` ${minText(toMin(g.start) ?? 0)}` : ''}`);
  const note = value.note.trim();
  if (note) {
    if (lines.length > 0) lines[lines.length - 1] = `${lines[lines.length - 1]}${note.startsWith('(') || note.startsWith('（') ? note : `（${note}）`}`;
    else lines.push(note);
  }
  return lines;
}

export const dayLabel = (d: RosterDayKind) => ROSTER_DAY_LABEL[d];

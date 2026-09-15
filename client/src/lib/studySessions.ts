// ③ 勉強会の計算と表示（2026-09-15）。設計は docs/計画-管理画面の開放.md の 5-5・5-6。
// 🚨 このファイルは supabase を読まない。読み書きは lib/studySessionsApi.ts
//
// ・勤務表の欄の文：「12:30(30)濱口・馬場」（名前は lib/staffName.ts の短い名前）
// ・⚠️ 印は保存しない。週のシフト（segments）から計算する：
//     勤務時間帯の中に収まれば OK（終了ちょうどに終わるのは OK、終了ちょうどに始まるのは ⚠️）／
//     時間帯をまたぐ・一部外れる・全部外れる → ⚠️／休み → ⚠️／週のシフトが無い → 「未登録」／
//     校が決まっていれば、勉強会の時間にかかる区切りの校が全部同じなら OK。途中で移る → ⚠️。
//     「四条本校→西陣校」のように移る時刻が分からない行 → 「校を確かめられない」
// ・判定は勉強会の版の期間の中で、勤務表の版が切り替わる日ごとに見る（「10/1から ⚠️」）
// 🚨 休憩は時刻を持っていないので判定できない

import {
  minText, rowOnDate, rowToDay, shiftTimeIssue, toMin,
  type PatternRowLike, type RosterDay, type RosterDayKind,
} from './shiftRoster';

export interface StudyVersion {
  id: string;
  session_id: string;
  day_kind: RosterDayKind;
  start_time: string;        // "12:30:00"
  duration_minutes: number;
  location: string | null;
  floor: string | null;
  memo: string | null;
  valid_from: string;
  valid_to: string | null;
  members: string[];         // user_id（並び順）
}

export const STUDY_DURATIONS = [10, 15, 25, 30, 45];

export function studyStartMin(v: Pick<StudyVersion, 'start_time'>): number {
  return toMin(v.start_time) ?? 0;
}
export function studyEndMin(v: Pick<StudyVersion, 'start_time' | 'duration_minutes'>): number {
  return studyStartMin(v) + v.duration_minutes;
}

/** 勤務表の欄の文：「12:30(30)濱口・馬場」 */
export function studyLabel(v: Pick<StudyVersion, 'start_time' | 'duration_minutes' | 'members'>, names: Map<string, string>): string {
  return `${minText(studyStartMin(v))}(${v.duration_minutes})${v.members.map(id => names.get(id) ?? '（不明）').join('・')}`;
}

/** その日に効いている版 */
export function versionsOnDate(versions: StudyVersion[], date: string): StudyVersion[] {
  return versions.filter(v => v.valid_from <= date && (v.valid_to === null || v.valid_to >= date));
}

export type StudyIssueKind = 'no_shift' | 'off' | 'outside' | 'partial' | 'other_school' | 'unknown_school' | 'few_members' | 'inactive';

export interface StudyIssue {
  userId: string | null;
  kind: StudyIssueKind;
  since: string;   // この日から
  text: string;
  key: string;     // 「確認した」に使う。ずれ方が変わると変わる
}

/**
 * 1人の1日について、勉強会の時間に対する問題（無ければ null）。
 * 勤務表の画面の「保存すると勉強会が時間外になる」の確認でも使う（判定を2か所に書かない）
 */
export function dayIssue(
  v: Pick<StudyVersion, 'start_time' | 'duration_minutes' | 'location'>,
  day: RosterDay | null,
): { kind: Exclude<StudyIssueKind, 'few_members' | 'inactive'>; detail: string } | null {
  // 🚨 判定は lib/shiftRoster.ts の shiftTimeIssue（④ 掃除担当表と共通）。勉強会の文は「一部の時間が勤務時間外」にまとめる
  const r = shiftTimeIssue(studyStartMin(v), studyEndMin(v), v.location, day);
  if (!r) return null;
  if (r.kind === 'before_start' || r.kind === 'leaves_early' || r.kind === 'partial') return { kind: r.overlap ? 'partial' : 'outside', detail: '' };
  return { kind: r.kind, detail: r.detail };
}

function issueText(kind: StudyIssueKind, name: string, detail: string): string {
  switch (kind) {
    case 'no_shift': return `${name}さんは週のシフトが未登録です`;
    case 'off': return `${name}さんはこの曜日が休みです`;
    case 'outside': return `${name}さんはこの時間に勤務していません`;
    case 'partial': return `${name}さんは一部の時間が勤務時間外です`;
    case 'other_school': return `${name}さんはこの時間 ${detail}`;
    case 'unknown_school': return `${name}さんの校を確かめられません（「${detail}」で移る時刻が未登録）`;
    case 'inactive': return `${name}さんは退職しています`;
    case 'few_members': return `参加者が${detail}人です`;
  }
}

function nextDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/**
 * 勉強会の版の ⚠️ 印（fromDate 以降・版の期間の中）。勤務表の版が切り替わる日ごとに見て、いちばん早い日を since にする。
 * @param rowsByUser その人の週のシフトの行（fromDate に効いている行と、それより先の行）
 * @param fullNames  user_id → フルネーム
 * @param inactive   退職した人の user_id
 */
export function studyIssues(
  v: StudyVersion,
  rowsByUser: Map<string, PatternRowLike[]>,
  fromDate: string,
  fullNames: Map<string, string>,
  inactive: Set<string>,
): StudyIssue[] {
  const start = v.valid_from > fromDate ? v.valid_from : fromDate;
  if (v.valid_to !== null && v.valid_to < start) return [];
  const out = new Map<string, StudyIssue>();
  const add = (userId: string | null, kind: StudyIssueKind, since: string, detail: string) => {
    const k = `${kind}|${userId ?? ''}|${detail}`;
    if (out.has(k)) return;
    out.set(k, { userId, kind, since, text: issueText(kind, userId ? (fullNames.get(userId) ?? '（不明）') : '', detail), key: `${k}|${since}` });
  };

  const activeMembers = v.members.filter(id => !inactive.has(id));
  for (const id of v.members) if (inactive.has(id)) add(id, 'inactive', start, '');
  if (activeMembers.length < 2) add(null, 'few_members', start, String(activeMembers.length));

  // 判定する日：開始日と、その期間の中で参加者の週のシフトの版が切り替わる日
  const dates = new Set<string>([start]);
  for (const id of activeMembers) {
    for (const r of (rowsByUser.get(id) ?? []).filter(x => x.day_kind === v.day_kind)) {
      for (const d of [r.valid_from, r.valid_to ? nextDay(r.valid_to) : null]) {
        if (d && d > start && (v.valid_to === null || d <= v.valid_to)) dates.add(d);
      }
    }
  }
  for (const date of [...dates].sort()) {
    for (const id of activeMembers) {
      const rows = (rowsByUser.get(id) ?? []).filter(x => x.day_kind === v.day_kind);
      const row = rowOnDate(rows, date);
      const hasAny = (rowsByUser.get(id) ?? []).some(x => x.valid_from <= date && (x.valid_to === null || x.valid_to >= date));
      const issue = dayIssue(v, row ? rowToDay(row) : (hasAny ? { segments: [], note: '' } : null));
      if (issue) add(id, issue.kind, date, issue.detail);
    }
  }
  return [...out.values()].sort((a, b) => a.since.localeCompare(b.since));
}

/** "2026-10-01" → "10/1" */
export function mdText(date: string): string {
  return `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
}

// ⑤ こどもシフト表の計算と表示（2026-09-16）。🚨 supabase を読まない側（画面を開かずに検算できるようにするため）。
// 読み書きは lib/kidsShiftApi.ts。設計・決めたことは docs/計画-管理画面の開放.md の 5-9〜5-9-3。
//
// ・1つの「マス」＝置き場所（列・校の見出し・曜日の書き添え）×曜日。中身は行（items）＋人（people）
// ・案は「変えたマスだけ」を持ち、触っていないマスは決定済みの表から借りる（mergeCells）
// ・追加必要＝必要な人数に足りない分。班の数から決まる初期値は settings（管理画面で直せる）
// ・重なり＝同じ人が同じ曜日の同じ時間に2か所へ入っている（年度替わりは勤務表より先に作るので、⚠️ の代わりに効く）
// ・社員休み＝メインの部門が「こども」の正社員で、その曜日に勤務予定がない人

import type { RosterDay, RosterDayKind } from './shiftRoster';
import { toMin, normTime, shiftTimeIssue } from './shiftRoster';

export const KIDS_WEEK: RosterDayKind[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

export type KidsPlaceKind = 'column' | 'head' | 'daynote';
export type KidsPersonRole = 'lead' | 'onduty' | 'support';

export interface KidsPlace {
  id: string;
  kind: KidsPlaceKind;
  school: string | null;
  floor: string | null;
  label: string;
  sort_order: number;
  active: boolean;
}

export interface KidsRowKind {
  key: string;
  label: string;
  has_class: boolean;
  has_groups: boolean;
  has_people: boolean;
  issue_mode: 'full' | 'day_only';
  sort_order: number;
  active: boolean;
}

export interface KidsRoleKind {
  key: string;
  label: string;
  sort_order: number;
  active: boolean;
}

export interface KidsPerson {
  user_id: string;
  role: KidsPersonRole;
  start: string;
  end: string;
}

export interface KidsItem {
  kind: string;            // 行の種類（'role' は見出しの役割・'daynote' は曜日の書き添え）
  start: string;
  end: string;
  class_name: string;
  groups: number | null;
  required: number | null;
  min_lesson: number | null;
  role_key: string | null;
  is_none: boolean;        // 「なし」（フロント：なし）
  note: string;
  people: KidsPerson[];
}

export type KidsCellValue = KidsItem[];

export interface KidsCellVersion {
  id: string;
  place_id: string;
  day_kind: string;
  valid_from: string;
  valid_to: string | null;
  items: KidsCellValue;
}

export interface KidsPlanCell {
  id: string;
  plan_id: string;
  place_id: string;
  day_kind: string;
  base_sig: string;
  items: KidsCellValue;
}

export interface KidsPlan {
  id: string;
  name: string;
  apply_from: string;
  status: 'open' | 'archived';
  archived_reason: 'decided' | 'unused' | null;
  archived_at: string | null;
  decided_from: string | null;
  revision: number;
  updated_by: string | null;
  updated_at: string;
}

export interface KidsSettings {
  lesson_check: boolean;
  required_by_groups: Record<string, number>;
  min_lesson_by_groups: Record<string, number>;
  plan_limit: number;
}

export const EMPTY_CELL: KidsCellValue = [];

export function emptyItem(kind: string): KidsItem {
  return {
    kind, start: '', end: '', class_name: '', groups: null, required: null, min_lesson: null,
    role_key: kind === 'role' ? '' : null, is_none: false, note: '', people: [],
  };
}

/**
 * マスの中身を1つの文字にする。
 * 🚨 DB の kids_shift_cell_sig / kids_shift_payload_sig と**同じ形**（あちらはこれを md5 にしたもの）。
 *    片方を直したら3か所とも直すこと。画面はこの文字で「変わったか」を見る
 */
export function sigOfItems(items: KidsCellValue): string {
  return (items ?? []).map(it => [
    it.kind,
    `${normTime(it.start)}-${normTime(it.end)}`,
    (it.class_name ?? '').trim(),
    it.groups == null ? '' : String(it.groups),
    it.required == null ? '' : String(it.required),
    it.min_lesson == null ? '' : String(it.min_lesson),
    it.role_key ?? '',
    it.is_none ? 'true' : 'false',
    (it.note ?? '').trim(),
    (it.people ?? []).map(p => `${p.user_id}:${p.role || 'lead'}:${normTime(p.start)}-${normTime(p.end)}`).join(','),
  ].join('/')).join('|');
}

export function cellEquals(a: KidsCellValue, b: KidsCellValue): boolean {
  return sigOfItems(a) === sigOfItems(b);
}

/** その日に効いている版 */
export function cellVersionOn(cells: KidsCellVersion[], placeId: string, day: string, date: string): KidsCellVersion | null {
  return cells.find(c => c.place_id === placeId && c.day_kind === day
    && c.valid_from <= date && (c.valid_to === null || c.valid_to >= date)) ?? null;
}

/** 案を決定済みの表に重ねる（案が持っているマスだけ案の中身を使う） */
export function mergeCell(
  cells: KidsCellVersion[], planCells: KidsPlanCell[], placeId: string, day: string, date: string,
): KidsCellValue {
  const pc = planCells.find(p => p.place_id === placeId && p.day_kind === day);
  if (pc) return pc.items;
  return cellVersionOn(cells, placeId, day, date)?.items ?? EMPTY_CELL;
}

/** 班の数から決まる「必要な人数」「うちレッスンできる人」（行に入っていればそちらが優先） */
export function defaultsForGroups(settings: KidsSettings, groups: number | null): { required: number; minLesson: number } {
  const key = groups == null ? '' : String(groups);
  const req = settings.required_by_groups?.[key];
  const min = settings.min_lesson_by_groups?.[key];
  return { required: typeof req === 'number' ? req : (groups ?? 0), minLesson: typeof min === 'number' ? min : 0 };
}

export interface KidsShortfall {
  need: number;        // あと何人
  lessonNeed: number;  // うちレッスンできる人があと何人
  required: number;
  minLesson: number;
  leads: number;
  lessonLeads: number;
}

/** 追加必要（担当だけを数える。勤務中（担当しない）・サポートは数えない） */
export function shortfallOf(
  item: KidsItem, settings: KidsSettings, canLesson: (userId: string) => boolean, inactive?: Set<string>,
): KidsShortfall | null {
  if (item.kind === 'role' || item.kind === 'daynote') return null;
  const def = defaultsForGroups(settings, item.groups);
  const required = item.required ?? def.required;
  const minLesson = item.min_lesson ?? def.minLesson;
  if (required <= 0 && minLesson <= 0) return null;
  const leadPeople = (item.people ?? []).filter(p => p.role === 'lead' && !(inactive?.has(p.user_id)));
  const leads = leadPeople.length;
  const lessonLeads = leadPeople.filter(p => canLesson(p.user_id)).length;
  const need = Math.max(0, required - leads);
  const lessonNeed = settings.lesson_check ? Math.max(0, minLesson - lessonLeads) : 0;
  if (need === 0 && lessonNeed === 0) return null;
  return { need, lessonNeed, required, minLesson, leads, lessonLeads };
}

/** その人が「レッスンできる」か（印が無ければ 正社員＝できる／パート＝できない） */
export function makeCanLesson(
  flags: Map<string, boolean>, staff: { id: string; employment_type: string | null }[],
): (userId: string) => boolean {
  const byId = new Map(staff.map(s => [s.id, s.employment_type ?? '']));
  return (userId: string) => {
    const f = flags.get(userId);
    if (typeof f === 'boolean') return f;
    return (byId.get(userId) ?? '') !== 'パート';
  };
}

export interface KidsOverlap {
  day: string;
  userId: string;
  aPlaceId: string;
  bPlaceId: string;
  start: string;
  end: string;
}

interface OverlapSrc { placeId: string; items: KidsCellValue }

/** 同じ曜日に、同じ人が同じ時間で2か所に入っている（同じ校の中の重なりも出す・ユーザー確定） */
export function overlapsOfDay(day: string, sources: OverlapSrc[]): KidsOverlap[] {
  interface Span { placeId: string; s: number; e: number }
  const byUser = new Map<string, Span[]>();
  for (const src of sources) {
    for (const it of src.items ?? []) {
      if (it.kind === 'role' || it.kind === 'daynote' || it.is_none) continue;
      for (const p of it.people ?? []) {
        const s = toMin(normTime(p.start) || normTime(it.start));
        const e = toMin(normTime(p.end) || normTime(it.end));
        if (s == null || e == null || e <= s) continue;
        byUser.set(p.user_id, [...(byUser.get(p.user_id) ?? []), { placeId: src.placeId, s, e }]);
      }
    }
  }
  const out: KidsOverlap[] = [];
  for (const [userId, spans] of byUser) {
    const sorted = [...spans].sort((a, b) => a.s - b.s);
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const a = sorted[i];
        const b = sorted[j];
        if (b.s >= a.e) break;              // 並べ替え済みなので、これ以降は重ならない
        if (a.placeId === b.placeId) continue;  // 同じ列の中の掛け持ちは、そのマスを見れば分かるので出さない
        out.push({
          day, userId, aPlaceId: a.placeId, bPlaceId: b.placeId,
          start: minToText(Math.max(a.s, b.s)), end: minToText(Math.min(a.e, b.e)),
        });
      }
    }
  }
  return out;
}

function minToText(m: number): string {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** 紙と同じ書き方の1行（画面・PDF・Excel が同じものを使う） */
export function itemText(item: KidsItem, name: (userId: string) => string, roleLabel?: (key: string) => string): string {
  const t = normTime(item.start);
  const t2 = normTime(item.end);
  const people = (item.people ?? []);
  const leads = people.filter(p => p.role === 'lead');
  const onduty = people.filter(p => p.role === 'onduty');
  const support = people.filter(p => p.role === 'support');
  const nameOf = (p: KidsPerson) => {
    const base = name(p.user_id);
    const from = normTime(p.start);
    const to = normTime(p.end);
    if (from && to) return `${base}${from}〜${to}`;
    if (to) return `${base}${to}まで`;
    if (from) return `${from}〜${base}`;
    return base;
  };
  if (item.kind === 'role') {
    const label = roleLabel ? roleLabel(item.role_key ?? '') : (item.role_key ?? '');
    if (item.is_none) return `${label}：なし`;
    const main = leads.map(nameOf).join('・');
    const sup = support.length > 0 ? `（${support.map(nameOf).join('・')}）` : '';
    return `${label}：${main}${sup}${item.note ? ` ${item.note}` : ''}`;
  }
  if (item.kind === 'daynote') return item.note ?? '';
  const head: string[] = [];
  if (t) head.push(t2 ? `${t}〜${t2}` : `${t}〜`);
  if (item.class_name) head.push(item.class_name);
  if (item.groups != null) head.push(`${item.groups}班`);
  if (onduty.length > 0) head.push(`（${onduty.map(nameOf).join('・')}）`);
  const lines = [head.join(' ')];
  const second = [...leads.map(nameOf), ...support.map(p => `（${nameOf(p)}）`)];
  if (second.length > 0) lines.push(second.join('・'));
  if (item.note) lines.push(item.note);
  return lines.filter(Boolean).join('\n');
}

/** 追加必要の「（ ）」を、担当の並びの後ろに足した文字 */
export function itemTextWithBlanks(
  item: KidsItem, name: (userId: string) => string, shortfall: KidsShortfall | null, roleLabel?: (key: string) => string,
): string {
  const base = itemText(item, name, roleLabel);
  if (!shortfall || shortfall.need <= 0) return base;
  const blanks = Array.from({ length: shortfall.need }, () => '（　）').join('・');
  const lines = base.split('\n');
  if (lines.length >= 2) {
    lines[1] = lines[1] ? `${lines[1]}・${blanks}` : blanks;
    return lines.join('\n');
  }
  return `${base}\n${blanks}`;
}

export interface KidsStaffLite {
  id: string;
  name: string;
  is_active: boolean;
  employment_type: string | null;
  main_area: string | null;   // メインの部門の名前
}

/**
 * 社員休み（メインの部門が「こども」の正社員で、その曜日に勤務予定がない人）
 * @param hasShift その人がその曜日に勤務予定を持っているか
 */
export function offStaffOfDay(
  staff: KidsStaffLite[], hasShift: (userId: string) => boolean, areaName = 'こども',
): KidsStaffLite[] {
  return staff
    .filter(s => s.is_active && (s.employment_type ?? '') !== 'パート' && (s.main_area ?? '') === areaName)
    .filter(s => !hasShift(s.id));
}

/** 画面・PDF に出す列（その曜日に中身がある列だけ・ユーザー確定 案A） */
export function visibleColumns(
  places: KidsPlace[], day: string, has: (placeId: string, day: string) => boolean, extra: Set<string> = new Set(),
): KidsPlace[] {
  return places
    .filter(p => p.kind === 'column' && p.active)
    .filter(p => has(p.id, day) || extra.has(p.id))
    .sort((a, b) => a.sort_order - b.sort_order);
}

// ── ⚠️（出勤していない）の印（2026-09-22・2回目）────────────────────────────
//
// 決まりは設計書 docs/計画-管理画面の開放.md 5-9 の「⚠️ の決まり」。
// 🚨 判定そのものは書かない。**`lib/shiftRoster.ts` の shiftTimeIssue** を呼ぶ
//    （④掃除担当表・③勉強会とまったく同じもの。ここで書き直すと片方だけ直す事故になる）。
//
// ・レッスン／P／打合せ／大人コース業務／その他（issue_mode='full'）
//     … その曜日が休み／その時間より前に出勤／途中で退勤／その時間はほかの校
// ・園指導・見出しの役割（issue_mode='day_only'）
//     … **その曜日が休みかどうかだけ**（時刻・校は見ない）。
//       園指導は月1回の朝で週のシフトに入っていないため、時刻で見ると常に ⚠️ になる
// ・人ごとに「19まで」「16:45〜」があれば、その時間で見る（無ければ行の時間）
// ・退職した人は 'inactive'
//
// 🚨 勉強会の行はここでは判定しない（勉強会の画面が同じ ⚠️ を出す。二重に出さない）

export type KidsIssueKind =
  | 'no_shift' | 'off' | 'outside' | 'partial' | 'other_school' | 'unknown_school' | 'inactive';

export interface KidsIssue {
  placeId: string;
  dayKind: string;
  userId: string;
  kind: KidsIssueKind;
  text: string;
  /** 「確認した」に使う鍵。
   *  🚨 **日付を混ぜない**。勉強会で日付を混ぜたせいで、押した「確認した」が翌日に外れた
   *     （2026-09-22 に修正）。掃除当番と同じく「どこ・何の行・いつの時間・誰・何が」で作る */
  key: string;
}

function kidsIssueText(kind: KidsIssueKind, name: string, detail: string): string {
  switch (kind) {
    case 'no_shift': return `${name}さんは週のシフトが未登録です`;
    case 'off': return `${name}さんはこの曜日が休みです`;
    case 'outside': return `${name}さんはこの時間に勤務していません`;
    case 'partial': return `${name}さんは一部の時間が勤務時間外です`;
    case 'other_school': return `${name}さんはこの時間 ${detail}`;
    case 'unknown_school': return `${name}さんの校を確かめられません（「${detail}」で移る時刻が未登録）`;
    case 'inactive': return `${name}さんは退職しています`;
  }
}

/**
 * マス1つぶんの ⚠️。
 * @param items    そのマスの中身（行）
 * @param dayOf    user_id → その曜日の勤務予定（未登録なら null）
 * @param modeOf   行の種類 → 'full' か 'day_only'（kids_shift_row_kinds の issue_mode）
 * @param fullNames user_id → フルネーム
 * @param inactive 退職した人の user_id
 * @param school   そのマスの校（列の校。null なら校は見ない）
 */
export function kidsCellIssues(
  placeId: string,
  dayKind: string,
  items: KidsCellValue,
  dayOf: (userId: string) => RosterDay | null,
  modeOf: (rowKind: string) => 'full' | 'day_only',
  fullNames: Map<string, string>,
  inactive: Set<string>,
  school: string | null,
): KidsIssue[] {
  const out: KidsIssue[] = [];
  const seen = new Set<string>();
  const push = (userId: string, kind: KidsIssueKind, detail: string, rowKind: string, at: string) => {
    // 🚨 同じマスに同じ人が何度出てきても、同じ内容の ⚠️ は1つにまとめる
    const key = `${placeId}|${dayKind}|${rowKind}|${at}|${userId}|${kind}|${detail}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ placeId, dayKind, userId, kind, text: kidsIssueText(kind, fullNames.get(userId) ?? '（不明）', detail), key });
  };

  for (const it of items) {
    // 🚨 勉強会の行は勉強会の画面が見る（ここでは出さない）
    if (it.kind === 'study') continue;
    if (it.is_none) continue;
    const dayOnly = modeOf(it.kind) === 'day_only';
    for (const p of it.people) {
      if (inactive.has(p.user_id)) { push(p.user_id, 'inactive', '', it.kind, ''); continue; }
      const day = dayOf(p.user_id);
      // 人ごとの時間があればそれで見る（「19まで」「16:45〜」）
      const s = toMin(normTime(p.start || it.start));
      const e = toMin(normTime(p.end || it.end));
      if (dayOnly || s === null || e === null || e <= s) {
        // 🚨 その曜日が休みかどうかだけ。時刻も校も見ない
        if (!day) { push(p.user_id, 'no_shift', '', it.kind, ''); continue; }
        if (day.segments.length === 0) { push(p.user_id, 'off', '', it.kind, ''); continue; }
        continue;
      }
      const r = shiftTimeIssue(s, e, school, day);
      if (!r) continue;
      const at = normTime(p.start || it.start);
      // 「前に出勤」「途中で退勤」「一部だけ」は、勉強会と同じ言い方にまとめる
      if (r.kind === 'before_start' || r.kind === 'leaves_early' || r.kind === 'partial') {
        push(p.user_id, r.overlap ? 'partial' : 'outside', '', it.kind, at);
      } else {
        push(p.user_id, r.kind as KidsIssueKind, r.detail, it.kind, at);
      }
    }
  }
  return out;
}

// ── Excel に出す中身（2026-09-22・2回目の d）────────────────────────
// ✅ ユーザー確定（2026-09-22・案ウ）：**シートを2つに分ける**
//   ① 「表」   … 紙と同じ見た目（曜日×校の格子）。印刷して配る・手で書き足す用
//   ② 「一覧」 … 1行＝1件。🚨 Excel 側で並べ替え・絞り込み・集計ができる
//                （「誰が何コマ持っているか」を数えられる）
// 🚨 ここは supabase を読まない。画面を開かずに検算できるようにするため。
//    XLSX の呼び出し（動的 import）は画面側で行う。

/** 「表」シート。1行目が曜日の見出し、以降は置き場所ごとの行（セルの中は改行区切り） */
export function kidsGridSheet(
  days: RosterDayKind[],
  dayLabel: (d: RosterDayKind) => string,
  places: KidsPlace[],
  columnsOf: (d: RosterDayKind) => KidsPlace[],
  linesOf: (placeId: string, d: RosterDayKind) => string[],
): string[][] {
  const rows: string[][] = [['', ...days.map(dayLabel)]];
  for (const p of places) {
    // 🚨 どの曜日にも出ない列は行ごと出さない（画面・PDF と同じ「中身のある列だけ」の決まり）
    if (!days.some(d => columnsOf(d).some(c => c.id === p.id))) continue;
    rows.push([p.label, ...days.map(d =>
      (columnsOf(d).some(c => c.id === p.id) ? linesOf(p.id, d) : []).join('\n'))]);
  }
  return rows;
}

/** 「一覧」シート。1行＝1件（人がいる行は人ごとに1行） */
export function kidsListSheet(
  days: RosterDayKind[],
  dayLabel: (d: RosterDayKind) => string,
  columnsOf: (d: RosterDayKind) => KidsPlace[],
  cellOf: (placeId: string, d: RosterDayKind) => KidsCellValue,
  kindLabel: (key: string) => string,
  roleLabel: (key: string) => string,
  nameOf: (userId: string) => string,
): string[][] {
  const head = ['曜日', '校', '階', '列', '種類', '開始', '終了', 'クラス', '班', '人', '役割', '書き添え'];
  const rows: string[][] = [head];
  for (const d of days) {
    for (const p of columnsOf(d)) {
      for (const it of cellOf(p.id, d)) {
        const base = [
          dayLabel(d), p.school ?? '', p.floor ?? '', p.label,
          it.is_none ? `${kindLabel(it.kind)}（なし）` : kindLabel(it.kind),
          it.start, it.end, it.class_name, it.groups === null ? '' : String(it.groups),
        ];
        if (it.people.length === 0) { rows.push([...base, '', '', it.note]); continue; }
        // 🚨 人ごとに1行に開く。そうしないと Excel 側で「誰が何コマ」を数えられない
        for (const pe of it.people) {
          rows.push([...base, nameOf(pe.user_id), roleLabel(pe.role),
            // 人ごとの「19まで」「16:45〜」は書き添えに添えて残す（列を増やさない）
            [it.note, pe.start || pe.end ? `${pe.start || ''}〜${pe.end || ''}` : ''].filter(Boolean).join(' / ')]);
        }
      }
    }
  }
  return rows;
}

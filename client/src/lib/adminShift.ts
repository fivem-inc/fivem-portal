// 管理部シフト表の計算（2026-10-16・決めたことは docs/計画-管理部シフト表.md）
// ・入力しない表：勤務表（いつものシフト）から作る。管理部の人＝メインの部門が「管理部」の人
// ・こども・大人のシフト表に入っている分を重ねて出す（決定済みの表だけ）
// ・締め：四条本校だけ。その曜日に四条本校でいちばん遅く終わる管理部の人。同じ時刻が2人以上なら選んだ結果（admin_shift_closers）
// 🚨 このファイルは supabase を読まない（画面を開かずに検算できるように）。画面・印刷・Excel が同じものを呼ぶ

import { minText, normTime, placeSteps, toMin, type PlaceStep, type RosterDay, type RosterDayKind, type WorkArea } from './shiftRoster';
import { cellVersionOn, type KidsItem, type KidsPlace, type ShiftBoard } from './kidsShift';
import { crossEntriesOf, placeShortName } from './shiftCross';
import { ADULT_CLASS_KIND } from './adultShift';

/** 締めを見る校 */
export const CLOSE_SCHOOL = '四条本校';
/** 管理部の部門の名前（shift_work_areas.name） */
export const ADMIN_AREA_NAME = '管理部';

/** 曜日で見るの横軸（6時〜21時） */
export const TIMELINE_FROM = 6 * 60;
export const TIMELINE_TO = 21 * 60;

/** 校ごとの色（校の一覧の並びで当てる・薄い色に文字を添える） */
export const SCHOOL_COLOR_KEYS = ['blue', 'green', 'amber', 'purple', 'coral', 'pink', 'teal', 'gray'] as const;

/** その日の、校ごとの時間（同じ校が続けば1つにまとめる） */
export interface SchoolSpan { school: string; s: number; e: number }

export function schoolSpans(day: RosterDay, areas: WorkArea[], mainAreaId: string | null): SchoolSpan[] {
  const steps: PlaceStep[] = placeSteps(day, areas, mainAreaId);
  const out: SchoolSpan[] = [];
  for (const st of steps) {
    const s = toMin(st.start);
    const e = toMin(st.end);
    if (s == null || e == null) continue;
    const last = out[out.length - 1];
    if (last && last.school === st.school && last.e === s) last.e = e;
    else out.push({ school: st.school, s, e });
  }
  return out;
}

/** 締めの候補：四条本校でいちばん遅く終わる人（同じ時刻なら全員） */
export function closerCandidates(memberIds: string[], spansOf: (userId: string) => SchoolSpan[]): { candidates: string[]; endMin: number | null } {
  let best: number | null = null;
  let cands: string[] = [];
  for (const id of memberIds) {
    const ends = spansOf(id).filter(sp => sp.school === CLOSE_SCHOOL).map(sp => sp.e);
    if (ends.length === 0) continue;
    const e = Math.max(...ends);
    if (best == null || e > best) { best = e; cands = [id]; }
    else if (e === best) cands.push(id);
  }
  return { candidates: cands, endMin: best };
}

export interface SavedCloser { day_kind: string; user_id: string; candidates: string[] }

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every(x => b.includes(x));

/**
 * 締めの人を決める。1人なら自動。2人以上なら、同じ候補で選んだ結果があればその人、無ければ未定。
 * 🚨 勤務表が変わって候補が変わったら、前に選んだ結果は使わない（未定に戻る）
 */
export function resolveCloser(cands: string[], saved: SavedCloser | undefined): { userId: string | null; undecided: boolean; chosen: boolean } {
  if (cands.length === 0) return { userId: null, undecided: false, chosen: false };
  if (cands.length === 1) return { userId: cands[0], undecided: false, chosen: false };
  if (saved && sameSet(saved.candidates, cands) && cands.includes(saved.user_id)) return { userId: saved.user_id, undecided: false, chosen: true };
  return { userId: null, undecided: true, chosen: false };
}

/** こども・大人のシフト表に入っている分（1人・1つの行） */
export interface BoardEntry { userId: string; s: number | null; e: number | null; text: string; school: string | null }

interface BoardSrc {
  places: KidsPlace[];
  cells: Parameters<typeof cellVersionOn>[0];
  rowKinds: { key: string; has_groups: boolean; default_minutes: number | null }[];
  roleKinds: { key: string; label: string }[];
}

/** 決定済みの表の、その曜日の全員の分（date に効いている版）。見出しの役割（「南草津校の役割」など）も入れる */
export function boardEntriesOn(src: BoardSrc | null, board: ShiftBoard, day: RosterDayKind, date: string): BoardEntry[] {
  if (!src) return [];
  const name = board === 'adult' ? '大人' : 'こども';
  const ps = src.places.filter(p => p.active && (p.kind === 'column' || p.kind === 'trip' || p.kind === 'pool'));
  const itemsOf = (pid: string): KidsItem[] => cellVersionOn(src.cells, pid, day, date)?.items ?? [];
  const isCls = (it: KidsItem) => (board === 'adult' ? it.kind === ADULT_CLASS_KIND : !!src.rowKinds.find(k => k.key === it.kind)?.has_groups);
  const def = (k: string) => src.rowKinds.find(r => r.key === k)?.default_minutes ?? (board === 'adult' ? 30 : 50);
  const out: BoardEntry[] = crossEntriesOf(board, ps.map(p => ({ place: p, items: itemsOf(p.id) })), isCls, def, placeShortName)
    .map(e => ({
      userId: e.userId, s: e.s, e: e.e, school: e.school,
      // 呼び名から表の名前と時刻を外して「時刻〜時刻 場所 中身」に（例「こども：17:40〜18:30 本校 5F レッスン」）
      text: `${name}：${minText(e.s)}〜${minText(e.e)} ${e.label.replace(/^(こども|大人) /, '').replace(/\s\d{1,2}:\d{2}/, '')}`.trim(),
    }));
  // 見出しの役割（時間の無い役割・こどもの表）
  for (const h of src.places.filter(p => p.active && p.kind === 'head')) {
    for (const it of itemsOf(h.id)) {
      if (it.kind !== 'role' || it.is_none) continue;
      const label = src.roleKinds.find(r => r.key === it.role_key)?.label ?? '役割';
      for (const p of it.people) {
        if (!p.user_id || (p.role !== 'lead' && p.role !== 'support')) continue;
        const s = toMin(normTime(p.start));
        const e = toMin(normTime(p.end));
        out.push({ userId: p.user_id, s, e, school: h.school, text: `${name}：${h.school ? `${h.school}の` : ''}${label}${s != null ? ` ${minText(s)}〜${e != null ? minText(e) : ''}` : ''}` });
      }
    }
  }
  return out.sort((a, b) => (a.s ?? 0) - (b.s ?? 0));
}

/** 人ごとの表の1マスの文字（校ごとに「四条本校」→「6:30〜7:15」…）。休みは [] */
export function personCellLines(spans: SchoolSpan[]): { school: string; times: string[] }[] {
  const out: { school: string; times: string[] }[] = [];
  for (const sp of spans) {
    const last = out[out.length - 1];
    const t = `${minText(sp.s)}〜${minText(sp.e)}`;
    if (last && last.school === sp.school) last.times.push(t);
    else out.push({ school: sp.school, times: [t] });
  }
  return out;
}

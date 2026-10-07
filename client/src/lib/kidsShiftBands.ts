// こどもシフト表の「時刻の帯」と「3F・5F で動ける人（共通）」の行（2026-10-06 ユーザー確定・docs/計画-大人シフト表.md §5・§5-2）。
//
// ・左に時刻の列（案E）。全校を時刻の帯でそろえる。帯はその曜日のクラス（班のある行）の開始時刻から自動で作る
//   （5〜10分ずれる時刻は1つの帯にまとめる）。クラスより前の行（P・打合せなど）は先頭の帯にまとめる
// ・本校 3F・5F の帯のすぐ下に1行：「共通 6人／要る 5：名前…｜他業務：名前…」
//   共通＝「3F・5F で動ける人」に入れた人のうち、その時間にほかの行に入っていない人
//   他業務＝その時間に（ ）（勤務中・レッスンに入らない＝事務など）の人＋6F・事務・P・打合せなどに入っている人（行き先を添える）
//
// 🚨 supabase を読まない側（画面を開かずに検算できる）。画面と PDF の両方がここを使う（同じ判定を2か所に書かない）

import { normTime, toMin } from './shiftRoster';
import type { KidsItem, KidsPlace } from './kidsShift';

/** 近い時刻を1つの帯にまとめる幅（分） */
const MERGE_MIN = 10;

export interface KidsBand {
  /** 帯の始まり（分）。先頭の「クラスより前」の帯は、その中でいちばん早い時刻 */
  from: number;
  /** 次の帯の始まり（分）。最後の帯は null */
  to: number | null;
  /** 時刻の列に出す文字（例：15:40） */
  label: string;
}

export interface BandSource { placeId: string; items: KidsItem[] }

const minText = (m: number) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
const startOf = (it: KidsItem): number | null => toMin(normTime(it.start));

/**
 * その曜日の帯を作る。
 * @param isClass その行がクラス（帯の目印になる行）か。ふつうは「班の数を持つ種類」
 */
export function bandsOfDay(sources: BandSource[], isClass: (it: KidsItem) => boolean): KidsBand[] {
  const anchors: number[] = [];
  let earliest: number | null = null;
  for (const src of sources) for (const it of src.items) {
    if (it.kind === 'role' || it.kind === 'daynote' || it.kind === 'pool') continue;
    const s = startOf(it);
    if (s == null) continue;
    if (earliest == null || s < earliest) earliest = s;
    if (isClass(it)) anchors.push(s);
  }
  const sorted = [...new Set(anchors)].sort((a, b) => a - b);
  const merged: number[] = [];
  for (const a of sorted) if (merged.length === 0 || a - merged[merged.length - 1] > MERGE_MIN) merged.push(a);
  const bands: KidsBand[] = [];
  if (earliest != null && (merged.length === 0 || earliest < merged[0])) {
    bands.push({ from: earliest, to: merged[0] ?? null, label: merged.length === 0 ? minText(earliest) : `〜${minText(merged[0] - 1)}` });
  }
  merged.forEach((a, i) => bands.push({ from: a, to: merged[i + 1] ?? null, label: minText(a) }));
  return bands;
}

/** その行が入る帯の番号。時刻の無い行は先頭の帯 */
export function bandIndexOf(it: KidsItem, bands: KidsBand[]): number {
  const s = startOf(it);
  if (s == null || bands.length === 0) return 0;
  let idx = 0;
  for (let i = 0; i < bands.length; i++) if (s >= bands[i].from) idx = i;
  return idx;
}

/** マスの行を帯ごとに分ける（帯の中は時刻の早い順・同じ時刻はもとの並び） */
export function itemsByBand(items: KidsItem[], bands: KidsBand[]): KidsItem[][] {
  const out: KidsItem[][] = bands.map(() => []);
  if (bands.length === 0) return out;
  items
    .filter(it => it.kind !== 'role' && it.kind !== 'daynote' && it.kind !== 'pool')
    .map((it, i) => ({ it, i, s: startOf(it) ?? -1 }))
    .sort((a, b) => a.s - b.s || a.i - b.i)
    .forEach(({ it }) => out[bandIndexOf(it, bands)].push(it));
  return out;
}

// ─── 共通の行 ─────────────────────────────────────────

export interface PoolSource {
  place: KidsPlace;
  items: KidsItem[];
}

export interface PoolRow {
  /** 共通の人（userId と、帯の途中で来る・帰るときの添え書き） */
  common: { userId: string; note: string }[];
  /** 他業務（userId と行き先。（ ）の人は行き先なし） */
  other: { userId: string; where: string }[];
  /** 共通で回すクラスに、あと何人要るか（担当の数を引いたもの） */
  need: number;
  /** この帯に共通の行を出すか */
  show: boolean;
}

export interface PoolContext {
  /** 「3F・5F で動ける人」の置き場所（その校の kind='pool'） */
  poolPlace: KidsPlace;
  /** その曜日の「3F・5F で動ける人」の行（kind='pool'）。無ければ null */
  poolItem: KidsItem | null;
  /** その曜日のこどもの表のすべてのマス（共通の置き場所を除く） */
  sources: PoolSource[];
  /** 共通で回す列（同じ校の 3F・5F） */
  poolColumnIds: Set<string>;
  /** クラス（班のある行）か */
  isClass: (it: KidsItem) => boolean;
  /** 行の種類の呼び名（P・打合せ など） */
  kindLabel: (kind: string) => string;
  /** 終わりの時刻が無い行の長さ（分） */
  defaultMinutes: (kind: string) => number;
  /** 必要な人数（班の数から・行に入っていればそちら） */
  requiredOf: (it: KidsItem) => number;
  /** その人のその曜日の勤務の時間（分）。null＝週のシフトが無い（切らない）／空＝休み（2026-10-07） */
  shiftOf?: (userId: string) => { s: number; e: number }[] | null;
}

interface Span { s: number; e: number }

function spanOf(it: KidsItem, p: { start: string; end: string }, defMin: number): Span | null {
  const s = toMin(normTime(p.start) || normTime(it.start));
  if (s == null) return null;
  const e = toMin(normTime(p.end) || normTime(it.end)) ?? s + defMin;
  return e > s ? { s, e } : null;
}

const overlaps = (a: Span, b: Span) => a.s < b.e && b.s < a.e;

/**
 * 帯の共通の行。
 * 🚨 「3F・5F で動ける人」に入れた人でも、その時間にほかの行（担当・（ ）・P・打合せ・6F…）に入っていれば共通から外す
 *    （紙でも手で外している・2026-10-06 確認）。帯の途中で入る・抜ける人は「16:45〜」「17:00まで」を添える
 */
export function poolRowOfBand(band: KidsBand, ctx: PoolContext): PoolRow {
  const bandSpan: Span = { s: band.from, e: band.to ?? band.from + 60 };
  const busyAt = new Map<string, { where: string; inPoolClass: boolean; onduty: boolean }>();
  let need = 0;
  let poolClassHere = false;
  for (const src of ctx.sources) {
    const inPoolCols = ctx.poolColumnIds.has(src.place.id);
    for (const it of src.items) {
      if (it.kind === 'role' || it.kind === 'daynote' || it.kind === 'pool' || it.is_none) continue;
      const isCls = ctx.isClass(it);
      if (inPoolCols && isCls && it.use_pool) {
        const s = toMin(normTime(it.start));
        if (s != null && s >= bandSpan.s && (band.to == null || s < band.to)) {
          poolClassHere = true;
          const leads = (it.people ?? []).filter(p => p.role === 'lead').length;
          need += Math.max(0, ctx.requiredOf(it) - leads);
        }
      }
      const clsStart = toMin(normTime(it.start));
      const clsInBand = isCls && clsStart != null && clsStart >= bandSpan.s && (band.to == null || clsStart < band.to);
      for (const p of it.people ?? []) {
        const sp = spanOf(it, p, ctx.defaultMinutes(it.kind));
        if (!sp) continue;
        // 🚨 「帯の始まりの時刻に入っているか」で見る（帯の終わりに少し掛かるだけの P などで共通から外さない・紙と同じ）。
        //    （ ）の人は、その帯に始まるクラスの（ ）なら他業務に出す
        const atStart = sp.s <= bandSpan.s && bandSpan.s < sp.e;
        if (!atStart && !((p.role === 'onduty' || p.role === 'watch') && clsInBand)) continue;
        const where = isCls
          ? (src.place.school === ctx.poolPlace.school ? (src.place.floor ?? src.place.label) : (src.place.school ?? src.place.label))
          : ctx.kindLabel(it.kind);
        const prev = busyAt.get(p.user_id);
        // 🚨 （ ）と見守りは「クラスにいるがレッスンを担当しない」人＝他業務に出す（見守りは行き先に「見守り」）
        const notLesson = p.role === 'onduty' || p.role === 'watch';
        const info = {
          where: p.role === 'watch' && inPoolCols && isCls ? '見守り' : where,
          inPoolClass: inPoolCols && isCls && !notLesson, onduty: inPoolCols && isCls && notLesson,
        };
        // 本校 3F・5F のクラスの担当（・サポート）を優先して覚える（その人は他業務に出さない）
        if (!prev || info.inPoolClass) busyAt.set(p.user_id, info);
      }
    }
  }

  const common: PoolRow['common'] = [];
  const other: PoolRow['other'] = [];
  const seenOther = new Set<string>();
  for (const p of ctx.poolItem?.people ?? []) {
    let s = toMin(normTime(p.start)) ?? 0;
    let e = toMin(normTime(p.end)) ?? 24 * 60;
    // 🚨 週のシフトの時間で切る（2026-10-07 ユーザー確定：勤務の外の時間は共通に出さない。帰る時刻を「17:30まで」と添える）。
    //    休憩をはさむ日は、その帯に掛かる最初の勤務の区切りで見る
    const segs = ctx.shiftOf?.(p.user_id) ?? null;
    if (segs) {
      const hit = segs.map(g => ({ s: Math.max(s, g.s), e: Math.min(e, g.e) })).filter(x => x.e > x.s && overlaps(x, bandSpan));
      if (hit.length === 0) continue;
      ({ s, e } = hit[0]);
    }
    const here: Span = { s, e };
    if (!overlaps(here, bandSpan)) continue;
    const busy = busyAt.get(p.user_id);
    if (busy) {
      if (!busy.inPoolClass && !seenOther.has(p.user_id)) {
        other.push({ userId: p.user_id, where: busy.onduty && busy.where !== '見守り' ? '' : busy.where });
        seenOther.add(p.user_id);
      }
      continue;
    }
    const notes: string[] = [];
    if (s > bandSpan.s) notes.push(`${minText(s)}〜`);
    if (band.to != null && e < band.to) notes.push(`${minText(e)}まで`);
    common.push({ userId: p.user_id, note: notes.join('') });
  }
  // （ ）の人は「3F・5F で動ける人」に入っていなくても他業務に出す
  for (const [uid, b] of busyAt) {
    if (b.onduty && !seenOther.has(uid)) { other.push({ userId: uid, where: b.where === '見守り' ? '見守り' : '' }); seenOther.add(uid); }
  }
  return { common, other, need, show: poolClassHere || common.length > 0 };
}

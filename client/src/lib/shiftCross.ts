// こどもシフト表と大人シフト表の「表をまたぐ重なり」（2026-10-07・docs/計画-大人シフト表.md §4）。
//
// 🔴 直す   ＝担当どうし（こども・大人・前半・後半）／出張が絡むもの／担当と別の校
// ⚠️ 確かめる＝それ以外（担当と P・事務・映像・打合せ／補助・サポート・（ ）・共通の人とほかの仕事／補助・サポートと別のクラスの担当）
// 🚨 同じ表の中の重なりは、それぞれの表の「重なり」で見る（ここでは こども×大人 だけを比べる）
// 🚨 supabase を読まない側（画面を開かずに検算できる）。人の時間は大人＝personSpanOf（前半／後半）、こども＝人の時間か行の時間

import { normTime, toMin } from './shiftRoster';
import { ADULT_TRIP_KIND, personSpanOf, isTentativeItem } from './adultShift';
import type { KidsItem, KidsPlace, ShiftBoard } from './kidsShift';

/** 1人の、1つの行にいる時間 */
export interface CrossEntry {
  board: ShiftBoard;
  userId: string;
  s: number;
  e: number;
  /** lead＝担当／support＝サポート・（ ）・見守り・共通の人／assist＝補助／trip＝出張・園指導（外へ出る）／job＝P・事務・映像・打合せなど */
  cat: 'lead' | 'support' | 'assist' | 'trip' | 'job';
  school: string | null;
  /** 画面に出す呼び名（例：「こども 本校 3F 15:40 リトル」） */
  label: string;
  placeId: string;
}

export interface CrossSource { place: KidsPlace; items: KidsItem[] }

/** 重なりに出す置き場所の短い呼び名（本校 3F・6F・出張 など）。こども・大人・掃除の画面で同じものを使う */
export const placeShortName = (p: KidsPlace) => (p.kind === 'trip' ? '出張' : p.board === 'adult' ? (p.floor ?? p.label) : p.label.replace('四条本校', '本校'));

/**
 * その曜日の、その表の全員の時間を出す。
 * @param isClass クラスの行か（こども＝班のある行／大人＝adult_class）
 * @param defMin 終わりが無い行の長さ
 * @param placeName 置き場所の呼び名（「本校 3F」など）
 */
export function crossEntriesOf(
  board: ShiftBoard, sources: CrossSource[], isClass: (it: KidsItem) => boolean, defMin: (kind: string) => number,
  placeName: (p: KidsPlace) => string,
): CrossEntry[] {
  const out: CrossEntry[] = [];
  const boardName = board === 'adult' ? '大人' : 'こども';
  for (const src of sources) {
    for (const it of src.items) {
      if (it.kind === 'role' || it.kind === 'daynote' || it.is_none) continue;
      // P（目安）は週ごとに変わる予約なので重なりを見ない（2026-10-08・こども／大人／掃除の重なりがすべてここを通る）
      if (isTentativeItem(it)) continue;
      const cls = isClass(it);
      for (const p of it.people) {
        if (!p.user_id) continue;
        let sp: { s: number; e: number } | null;
        if (board === 'adult') sp = personSpanOf(it, p, defMin(it.kind));
        else {
          const s = toMin(normTime(p.start) || normTime(it.start));
          const e0 = toMin(normTime(p.end) || normTime(it.end));
          // 共通の人の「何時まで」が空＝その日の終わりまで
          const e = e0 ?? (s == null ? null : it.kind === 'pool' ? 24 * 60 : s + defMin(it.kind));
          sp = s != null && e != null && e > s ? { s, e } : null;
        }
        if (!sp) continue;
        let cat: CrossEntry['cat'];
        if (it.kind === ADULT_TRIP_KIND || it.kind === 'garden') cat = 'trip';
        else if (it.kind === 'pool') cat = 'support';
        else if (cls) {
          if (p.role === 'lead' || p.role === 'second') cat = 'lead';
          else if (p.role === 'assist') cat = 'assist';
          else cat = 'support';
        } else cat = 'job';
        const what = it.kind === 'pool' ? '共通の人' : (it.class_name || '').trim();
        out.push({
          board, userId: p.user_id, s: sp.s, e: sp.e, cat, school: src.place.kind === 'trip' ? null : src.place.school,
          label: `${boardName} ${placeName(src.place)} ${normTime(it.start)}${what ? ` ${what}` : ''}`.replace(/\s+/g, ' ').trim(),
          placeId: src.place.id,
        });
      }
    }
  }
  return out;
}

export interface CrossOverlap {
  level: 'red' | 'warn';
  userId: string;
  s: number;
  e: number;
  kids: CrossEntry;
  adult: CrossEntry;
}

/** 重なりの重さ（🔴 か ⚠️） */
export function crossLevel(a: CrossEntry, b: CrossEntry): 'red' | 'warn' {
  if (a.cat === 'lead' && b.cat === 'lead') return 'red';
  if (a.cat === 'trip' || b.cat === 'trip') return 'red';
  if ((a.cat === 'lead' || b.cat === 'lead') && a.school && b.school && a.school !== b.school) return 'red';
  return 'warn';
}

/** こども×大人の重なり（同じ人が同じ時間に両方の表に入っている）。境目がちょうど同じ時刻は重なりにしない */
export function crossOverlaps(kids: CrossEntry[], adult: CrossEntry[]): CrossOverlap[] {
  const out: CrossOverlap[] = [];
  const byUser = new Map<string, CrossEntry[]>();
  for (const a of adult) byUser.set(a.userId, [...(byUser.get(a.userId) ?? []), a]);
  for (const k of kids) {
    for (const a of byUser.get(k.userId) ?? []) {
      const s = Math.max(k.s, a.s);
      const e = Math.min(k.e, a.e);
      if (e <= s) continue;
      out.push({ level: crossLevel(k, a), userId: k.userId, s, e, kids: k, adult: a });
    }
  }
  return out.sort((x, y) => (x.level === y.level ? x.s - y.s : x.level === 'red' ? -1 : 1));
}

/** 「こども」の行（大人シフト表）：その人のその曜日のこどもの予定を「15:40〜17:30 本校」の形に（校ごとに1つ） */
export function kidsRowText(entries: CrossEntry[]): string {
  const bySchool = new Map<string, { s: number; e: number }>();
  for (const x of entries) {
    const k = x.school ?? (x.cat === 'trip' ? '外' : '');
    const cur = bySchool.get(k);
    bySchool.set(k, cur ? { s: Math.min(cur.s, x.s), e: Math.max(cur.e, x.e) } : { s: x.s, e: x.e });
  }
  const t = (m: number) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
  return [...bySchool.entries()].sort((a, b) => a[1].s - b[1].s)
    .map(([sc, v]) => `${t(v.s)}〜${t(v.e)}${sc ? ` ${(sc === '四条本校' ? '本校' : sc.replace(/校$/, ''))}` : ''}`).join('・');
}


// 大人シフト表（2026-10-07・設計は docs/計画-大人シフト表.md §3）。
// こどもシフト表と同じ表（kids_shift_*・board='adult'）に入れる。ここは「マスの中身をどう読むか・どう書くか」だけ。
//
// ・クラス（adult_class）の担当は前半／後半に分かれる：lead（前半）・support（前半のサポート）・second（後半）・second_support（後半のサポート）・assist（補助＝通し）
//   後半の人がいないクラスは、前半の人が通しで受け持つ
// ・前後半の境＝split_time（無ければちょうど半分・5分単位）
// ・P・映像・事務などは終わりが無くてもよい（無ければ行の種類ごとの長さ）
// 🚨 supabase を読まない側（画面を開かずに検算できる）。人の時間はここの personSpanOf 1つで計算する（⚠️・重なり・表示で同じものを使う）

import { minText, normTime, toMin } from './shiftRoster';
import type { KidsItem, KidsPerson, KidsPersonRole } from './kidsShift';

export const ADULT_CLASS_KIND = 'adult_class';
export const ADULT_TRIP_KIND = 'trip';

/** 大人シフト表で選べる人の役割（入れる画面の並び） */
export const ADULT_ROLES: { key: KidsPersonRole; label: string }[] = [
  { key: 'lead', label: '担当（前半）' },
  { key: 'support', label: 'サポート（前半）' },
  { key: 'second', label: '担当（後半）' },
  { key: 'second_support', label: 'サポート（後半）' },
  { key: 'assist', label: '補助（通し）' },
];

/** 別の仕事の札（白黒でも読めるように字で出す） */
export const ADULT_JOB_TAG: Record<string, string> = { private: 'P', private_tbd: 'P目安', video: '映', office: '事', meeting: '打', other: '他' };

/**
 * P（目安）＝会員様の希望で週ごとに変わる予約（2026-10-08 ユーザー確定）。表には薄く出すが、重なり（こども・大人・掃除・同じ列の中）は見ない。
 * 毎週決まっている予約は private（P）。⚠️（勤務時間の外）は行の種類の issue_mode=day_only で曜日の休みだけ見る
 */
export const ADULT_TENTATIVE_KIND = 'private_tbd';
export const isTentativeItem = (it: { kind: string }): boolean => it.kind === ADULT_TENTATIVE_KIND;

const isFirst = (r: KidsPersonRole) => r === 'lead' || r === 'support';
const isSecond = (r: KidsPersonRole) => r === 'second' || r === 'second_support';

/** Jr合同のクラス（灰色の帯で出す。名前は変えない・2026-10-06 ユーザー確定） */
export const isJrClass = (it: KidsItem) => it.kind === ADULT_CLASS_KIND && /jr/i.test(it.class_name ?? '');

/** クラスの始まり・終わり（分）。終わりが無い行は defMin を足す */
export function itemSpan(it: KidsItem, defMin: number): { s: number; e: number } | null {
  const s = toMin(normTime(it.start));
  if (s == null) return null;
  const e = toMin(normTime(it.end)) ?? s + defMin;
  return e > s ? { s, e } : null;
}

/** 前後半の境（分）。split_time が無ければちょうど半分（5分単位に丸める） */
export function splitMinOf(it: KidsItem, defMin = 60): number | null {
  const sp = itemSpan(it, defMin);
  if (!sp) return null;
  const given = toMin(normTime(it.split_time));
  if (given != null && given > sp.s && given < sp.e) return given;
  return sp.s + Math.round((sp.e - sp.s) / 2 / 5) * 5;
}

/** 後半の人がいるクラスか */
export const hasSecondHalf = (it: KidsItem) => it.people.some(p => isSecond(p.role));

/**
 * その人がその行にいる時間（分）。人ごとの時間があればそれを優先。
 * クラスは前半の人＝始まり〜境、後半の人＝境〜終わり（後半の人がいなければ前半の人は通し）。補助は通し
 */
export function personSpanOf(it: KidsItem, p: KidsPerson, defMin: number): { s: number; e: number } | null {
  const sp = itemSpan(it, defMin);
  if (!sp) return null;
  let { s, e } = sp;
  if (it.kind === ADULT_CLASS_KIND && hasSecondHalf(it)) {
    const mid = splitMinOf(it, defMin) ?? s;
    if (isFirst(p.role)) e = mid;
    if (isSecond(p.role)) s = mid;
  }
  const ps = toMin(normTime(p.start));
  const pe = toMin(normTime(p.end));
  if (ps != null) s = ps;
  if (pe != null) e = pe;
  return e > s ? { s, e } : null;
}

/**
 * 人ごとの時間を書き込んだ写し（⚠️「出勤していない」・重なりの判定に渡す用）。
 * 🚨 こどもの判定（kidsCellIssues・overlapsOfDay）は「人の時間が無ければ行の時間」で見るので、
 *    前後半と終わりの無い行の時間をここで埋めてから渡す（判定を2つ書かない）
 */
export function withPersonSpans(items: KidsItem[], defMinOf: (kind: string) => number): KidsItem[] {
  return items.map(it => ({
    ...it,
    end: it.end || (() => { const sp = itemSpan(it, defMinOf(it.kind)); return sp ? minText(sp.e) : ''; })(),
    people: it.people.map(p => {
      const sp = personSpanOf(it, p, defMinOf(it.kind));
      return sp ? { ...p, start: minText(sp.s), end: minText(sp.e) } : p;
    }),
  }));
}

/** 画面・PDF に出す1行。kind で字の大きさ・置き場所（3段）を分ける */
export interface AdultLine {
  text: string;
  /** head＝時刻とクラス名／staff＝担当（大きい字）／assist＝補助／job＝別の仕事（下の段）／trip＝出張／note＝書き添え */
  kind: 'head' | 'staff' | 'assist' | 'job' | 'trip' | 'note';
  /** P（目安）の行（薄く出す） */
  tentative?: boolean;
  jr: boolean;
}

/**
 * 1つの帯のマスの中身を行にする。並び＝クラス（時刻順）→ 別の仕事（時刻順）。
 * 担当の書き方は紙と同じ「馬場(濱口)/濱口」＝前半(前半のサポート)/後半(後半のサポート)
 */
export function adultLines(items: KidsItem[], name: (userId: string) => string): AdultLine[] {
  const names = (ps: KidsPerson[]) => ps.filter(p => p.user_id).map(p => name(p.user_id)).join('・');
  const byStart = (a: KidsItem, b: KidsItem) => (toMin(normTime(a.start)) ?? 0) - (toMin(normTime(b.start)) ?? 0);
  const classes = items.filter(it => it.kind === ADULT_CLASS_KIND).sort(byStart);
  const trips = items.filter(it => it.kind === ADULT_TRIP_KIND).sort(byStart);
  const jobs = items.filter(it => it.kind !== ADULT_CLASS_KIND && it.kind !== ADULT_TRIP_KIND && it.kind !== 'daynote').sort(byStart);
  const out: AdultLine[] = [];
  for (const it of classes) {
    const jr = isJrClass(it);
    const video = it.video === 'first' ? '［映 前半］' : it.video === 'second' ? '［映 後半］' : '';
    out.push({ text: `${normTime(it.start)} ${it.class_name || 'クラス'}${video}`, kind: 'head', jr });
    const half = (main: KidsPersonRole, sub: KidsPersonRole) => {
      const m = names(it.people.filter(p => p.role === main));
      const s = names(it.people.filter(p => p.role === sub));
      return `${m}${s ? `(${s})` : ''}`;
    };
    const first = half('lead', 'support');
    const staff = hasSecondHalf(it) ? `${first}/${half('second', 'second_support')}` : first;
    out.push({ text: staff || '（担当なし）', kind: 'staff', jr });
    const assist = names(it.people.filter(p => p.role === 'assist'));
    if (assist) out.push({ text: `補 ${assist}`, kind: 'assist', jr });
    if (it.note) out.push({ text: it.note, kind: 'note', jr });
  }
  for (const it of trips) {
    const t = `${normTime(it.start)}${it.end ? `〜${normTime(it.end)}` : ''}`;
    out.push({ text: `${it.class_name || '出張'} ${t} ${names(it.people)}`.trim(), kind: 'trip', jr: false });
    if (it.note) out.push({ text: it.note, kind: 'note', jr: false });
  }
  for (const it of jobs) {
    const tag = ADULT_JOB_TAG[it.kind] ?? '他';
    const t = `${normTime(it.start)}${it.end ? `〜${normTime(it.end)}` : ''}`;
    const who = names(it.people);
    out.push({ text: `${who}${t}${it.class_name ? ` ${it.class_name}` : ''}［${tag}］`, kind: 'job', jr: false, tentative: isTentativeItem(it) });
    if (it.note) out.push({ text: it.note, kind: 'note', jr: false });
  }
  return out;
}

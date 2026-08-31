// 予約の一括入力（CSV / Excel / テキスト貼り付け）の読み取りと組み立て。
//
// 🚨 重なりの判定はここでしない。1行ずつ既存の room_create_booking を通す。
//    画面側で数え直すと、サーバーの判定とズレて「入るはずが入らない」が起きる。
// 🚨 読めなかった行を黙って捨てない。理由をつけて返し、画面で必ず見せる。
//
// テキスト貼り付けは Excel からのコピー＝タブ区切りを想定する。
// カンマ区切りで貼られることもあるので、行の中でタブが1つも無ければカンマで割る。

import { addMinutes, minutesOf, defaultMinutesOf, type Floor, type Campus, type Staff, type PurposeDuration } from './roomBooking';

export type BookingField =
  | 'date' | 'place' | 'start' | 'end' | 'purpose'
  | 'staff' | 'member_no' | 'customer' | 'memo' | 'fixed';

export const BOOKING_FIELD_LABEL: Record<BookingField, string> = {
  date: '日付', place: '場所', start: '開始', end: '終了', purpose: '用途',
  staff: '担当', member_no: '会員番号', customer: 'お客様', memo: 'メモ', fixed: '固定',
};

/** これが無いと1行も作れない */
export const BOOKING_REQUIRED: BookingField[] = ['date', 'place', 'start'];

const HINTS: Record<BookingField, string[]> = {
  date:      ['日付', '日', 'date', '予約日'],
  place:     ['場所', '教室', 'フロア', '校', 'place', 'room'],
  start:     ['開始', '開始時刻', 'start', '時間', 'から'],
  end:       ['終了', '終了時刻', 'end', 'まで'],
  purpose:   ['用途', '種別', '区分', 'purpose'],
  staff:     ['担当', 'スタッフ', '講師', 'staff'],
  member_no: ['会員番号', '会員no', '会員', 'member'],
  customer:  ['お客様', '顧客', '生徒', '参加者', '氏名', '名前'],
  memo:      ['メモ', '備考', 'note', 'memo'],
  fixed:     ['固定', 'レギュラー', 'fixed'],
};

const norm = (s: string): string =>
  s.replace(/[Ａ-Ｚａ-ｚ０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .toLowerCase()
    .replace(/[\s_\-()（）[\]【】:：/／]/g, '');

export function guessBookingMapping(headers: string[]): Partial<Record<BookingField, number>> {
  const map: Partial<Record<BookingField, number>> = {};
  const used = new Set<number>();
  for (const field of Object.keys(HINTS) as BookingField[]) {
    const hints = [...HINTS[field]].sort((a, b) => b.length - a.length);
    for (const hint of hints) {
      const h = norm(hint);
      const idx = headers.findIndex((raw, i) => !used.has(i) && norm(String(raw ?? '')).includes(h));
      if (idx >= 0) { map[field] = idx; used.add(idx); break; }
    }
  }
  return map;
}

/** 貼り付けたテキストを表に分ける。タブが無ければカンマで割る */
export function splitPasted(text: string): string[][] {
  return text.replace(/\r\n?/g, '\n').split('\n')
    .filter(l => l.trim() !== '')
    .map(l => (l.includes('\t') ? l.split('\t') : l.split(',')).map(c => c.trim()));
}

/**
 * 日付を 'YYYY-MM-DD' に直す。年が無い「9/1」は基準日の年度で補う。
 * 🚨 年を「今年」で補うと、1〜3月に来年度の表を入れたときに1年ずれる。
 *    月が基準日より前なら翌年とみなす。
 */
export function parseBookingDate(v: unknown, baseDate: string): string | null {
  if (v === null || v === undefined || v === '') return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  if (v instanceof Date && !isNaN(v.getTime())) {
    return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
  }
  const s = String(v).replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/（.）|\(.\)/g, '').trim();       // 「9/1(火)」の曜日を落とす
  const full = s.match(/^(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?$/);
  const short = s.match(/^(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?$/);
  let y: number, mo: number, d: number;
  if (full) {
    y = Number(full[1]); mo = Number(full[2]); d = Number(full[3]);
  } else if (short) {
    mo = Number(short[1]); d = Number(short[2]);
    const [by, bm] = baseDate.split('-').map(Number);
    y = mo < bm ? by + 1 : by;                // 過ぎた月なら翌年とみなす
  } else {
    return null;
  }
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return `${y}-${pad(mo)}-${pad(d)}`;
}

/** '9:00' '0900' '9時' などを 'HH:MM' に直す */
export function parseBookingTime(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date && !isNaN(v.getTime())) {
    return `${String(v.getHours()).padStart(2, '0')}:${String(v.getMinutes()).padStart(2, '0')}`;
  }
  const s = String(v).replace(/[０-９：]/g, c =>
    c === '：' ? ':' : String.fromCharCode(c.charCodeAt(0) - 0xfee0)).trim();
  let h: number, m: number;
  const colon = s.match(/^(\d{1,2})\s*[:時]\s*(\d{1,2})\s*分?$/);
  const hourOnly = s.match(/^(\d{1,2})\s*時?$/);
  const packed = s.match(/^(\d{3,4})$/);
  if (colon) { h = Number(colon[1]); m = Number(colon[2]); }
  else if (packed) { const t = packed[1].padStart(4, '0'); h = Number(t.slice(0, 2)); m = Number(t.slice(2)); }
  else if (hourOnly) { h = Number(hourOnly[1]); m = 0; }
  else return null;
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * 「四条本校 3階」「西陣」のような書き方から場所を1つに決める。
 * 見つからない・2つ以上に当たる場合は null（＝エラー行にする）。
 * 🚨 曖昧なまま近いものを選ばない。違う教室に予約が入るほうが困る。
 */
/**
 * 場所の当たり具合。
 * id が null で candidates がある＝「その校に場所が複数あって決められない」。
 * 🚨 このとき理由を「正式な名前で書いてください」で済ませない。
 *    「四条本校」は正式名なので、書いた人は何が悪いのか分からない（実機確認で判明）。
 */
export interface FloorMatch { id: string | null; candidates: string[] }

export function matchFloor(raw: string, floors: Floor[], campuses: Campus[]): FloorMatch {
  const t = norm(raw);
  if (!t) return { id: null, candidates: [] };
  const hit = floors.filter(f => {
    const c = campuses.find(x => x.id === f.campus_id);
    const both = norm(`${c?.name ?? ''}${f.name}`);
    const only = norm(c?.name ?? '');
    return both === t || t === norm(f.name) || (only && only === t)
      || both.includes(t) || t.includes(both);
  });
  if (hit.length === 1) return { id: hit[0].id, candidates: [] };

  const byCampus = campuses.filter(c => norm(c.name) === t || t.includes(norm(c.name)));
  if (byCampus.length === 1) {
    const fs = floors.filter(f => f.campus_id === byCampus[0].id);
    // 校名だけでも、その校に場所が1つしか無いなら決められる
    if (fs.length === 1) return { id: fs[0].id, candidates: [] };
    if (fs.length > 1) return { id: null, candidates: fs.map(f => f.name) };
  }
  // 校名では絞れないが、場所名の一部が複数に当たっている場合も候補を出す
  if (hit.length > 1) {
    return {
      id: null,
      candidates: hit.map(f => {
        const c = campuses.find(x => x.id === f.campus_id);
        return `${c?.name ?? ''} ${f.name}`.trim();
      }),
    };
  }
  return { id: null, candidates: [] };
}

export function matchStaff(raw: string, staff: Staff[]): string | null {
  const t = norm(raw);
  if (!t) return null;
  const hit = staff.filter(s => norm(s.name) === t);
  if (hit.length === 1) return hit[0].id;
  const loose = staff.filter(s => norm(s.name).includes(t));
  return loose.length === 1 ? loose[0].id : null;
}

/**
 * 「固定」列の読み方（2026-08-31 ユーザー確定）。
 * 〇 ○ ● 固定 レギュラー 1 true はい ○印 などが入っていれば固定。
 * 🚨 **空欄は固定ではない**。列そのものが無いときも固定ではない。
 *    「×」「なし」「0」も固定ではないものとして扱う。
 */
export function parseFixed(raw: string): boolean {
  const t = raw.trim().toLowerCase();
  if (!t) return false;
  if (['×', 'x', '✕', '✖', 'なし', '無', '0', 'false', 'いいえ', '-', 'ー'].includes(t)) return false;
  return ['〇', '○', '●', '◯', '✓', '✔', 'o', '固定', 'れぎゅらー', 'レギュラー',
          '1', 'true', 'はい', 'yes', 'y'].includes(t);
}

export interface BulkBooking {
  date: string;
  floor_id: string;
  start: string;
  end: string;
  purpose: string;
  staff_id: string | null;
  member_no: string;
  customer_label: string;
  memo: string;
  is_fixed: boolean;
}

export interface BulkResult {
  ok: BulkBooking[];
  ng: { line: number; reason: string }[];
}

/** 上限。これ以上は一度に流させない（打ち間違いで大量に入るのを防ぐ） */
export const BULK_MAX_ROWS = 200;

export function buildBookings(
  rows: unknown[][],
  map: Partial<Record<BookingField, number>>,
  ctx: {
    floors: Floor[]; campuses: Campus[]; staff: Staff[];
    purposeDurations: PurposeDuration[]; baseDate: string; defaultPurpose: string;
  },
): BulkResult {
  const ok: BulkBooking[] = [];
  const ng: { line: number; reason: string }[] = [];
  const at = (row: unknown[], f: BookingField): string => {
    const i = map[f];
    return i === undefined ? '' : String(row[i] ?? '').trim();
  };
  const rawAt = (row: unknown[], f: BookingField): unknown => {
    const i = map[f];
    return i === undefined ? '' : row[i];
  };

  rows.forEach((row, i) => {
    const line = i + 1;
    if (row.every(c => String(c ?? '').trim() === '')) return;

    const date = parseBookingDate(rawAt(row, 'date'), ctx.baseDate);
    if (!date) { ng.push({ line, reason: `日付「${at(row, 'date')}」が読めません` }); return; }

    const placeRaw = at(row, 'place');
    const fm = matchFloor(placeRaw, ctx.floors, ctx.campuses);
    if (!fm.id) {
      ng.push({
        line,
        reason: fm.candidates.length > 0
          ? `場所「${placeRaw}」には ${fm.candidates.join('／')} があります。どれか1つまで書いてください`
          : `場所「${placeRaw}」が見つかりません（校や教室の名前を確かめてください）`,
      });
      return;
    }
    const floorId = fm.id;

    const start = parseBookingTime(rawAt(row, 'start'));
    if (!start) { ng.push({ line, reason: `開始「${at(row, 'start')}」が読めません` }); return; }

    const purposeRaw = at(row, 'purpose');
    const purpose = purposeRaw || ctx.defaultPurpose;
    const opt = ctx.purposeDurations.find(d => d.purpose === purpose) ?? null;
    if (purposeRaw && !opt) { ng.push({ line, reason: `用途「${purposeRaw}」がありません` }); return; }

    let end = parseBookingTime(rawAt(row, 'end'));
    if (!end) {
      // 終了が空なら、用途ごとの長さから決める
      const min = defaultMinutesOf(opt);
      if (!min) {
        ng.push({ line, reason: `終了がありません（用途「${purpose}」は長さが決まっていないので、終了時刻を入れてください）` });
        return;
      }
      end = addMinutes(start, min);
    }
    if (minutesOf(end) <= minutesOf(start)) {
      ng.push({ line, reason: '終了が開始より後になっていません' }); return;
    }

    // 🚨 長さが決まっている用途は、フォームでも終了を触らせていない。
    //    一括入力から抜け道にならないよう、ここでも弾く（2026-08-31 ユーザー確定・案A）
    if (opt && !opt.allow_free) {
      const len = minutesOf(end) - minutesOf(start);
      if (!opt.minutes.includes(len)) {
        ng.push({
          line,
          reason: `${purpose}は ${opt.minutes.join('分／')}分 と決まっています（この行は${len}分）`,
        });
        return;
      }
    }

    const staffRaw = at(row, 'staff');
    const staffId = staffRaw ? matchStaff(staffRaw, ctx.staff) : null;
    if (staffRaw && !staffId) {
      ng.push({ line, reason: `担当「${staffRaw}」が決められません` }); return;
    }

    ok.push({
      date, floor_id: floorId, start, end, purpose, staff_id: staffId,
      member_no: at(row, 'member_no'), customer_label: at(row, 'customer'), memo: at(row, 'memo'),
      is_fixed: parseFixed(at(row, 'fixed')),
    });
  });

  return { ok, ng };
}

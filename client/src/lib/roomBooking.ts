// 部屋（フロア）予約の共通処理。画面から時刻の組み立て・整形を追い出しておく場所。
//
// 🚨 時刻の扱いは lib/timeInput.ts を必ず通すこと（自前で split(':') しない）。
//    このアプリは 2026-08-26 に「"930" が NaN 経由で別の数字として静かに保存される」
//    事故を踏んでいる。ここでも HH:MM の生成は normalizeTime の結果だけを使う。

import { normalizeTime } from './timeInput';

/** 用途の区分（2026-08-28 ユーザー確定）。色は明/暗それぞれで見分けられる組み合わせにしている */
export const PURPOSES = ['プライベート', 'パーソナル', 'レッスン', 'レンタル', 'その他'] as const;
export type Purpose = typeof PURPOSES[number];

/** 用途ごとの色。[文字色, 背景色] を明るい画面／暗い画面で分ける */
export const PURPOSE_COLOR: Record<string, { light: [string, string]; dark: [string, string] }> = {
  'プライベート': { light: ['#7b4bb5', '#efe7fa'], dark: ['#c4a5ee', '#3a2f52'] },
  'パーソナル':   { light: ['#1f7a8c', '#e0f2f5'], dark: ['#7fd3e0', '#233f45'] },
  'レッスン':     { light: ['#3b6fb5', '#e6eefa'], dark: ['#8ab4e8', '#2b3950'] },
  'レンタル':     { light: ['#b5761f', '#fbeed8'], dark: ['#e0b071', '#453520'] },
  'その他':       { light: ['#5b6270', '#eceef1'], dark: ['#aab0be', '#383a4a'] },
};

export const purposeColor = (purpose: string, isDark: boolean): [string, string] => {
  const c = PURPOSE_COLOR[purpose] ?? PURPOSE_COLOR['その他'];
  return isDark ? c.dark : c.light;
};

/**
 * 募集中の枠の色。用途の色とは別に、ひと目で「まだ空いている」と分かる色にする。
 * 🚨 予約の色（青・緑など）と紛れないよう、枠線を破線にして中を薄くする指定と
 *    セットで使うこと（色だけで区別させない）。
 */
export const openSlotColor = (isDark: boolean): [string, string] =>
  isDark ? ['#e0b071', '#3a3020'] : ['#a06a12', '#fdf3e2'];

/** タイムラインの表示範囲。基準は 9:30〜20:00 だが前後1時間のイレギュラーがあるため広めに描く */
export const VIEW_START_HOUR = 8;
export const VIEW_END_HOUR = 22;

/** 所要時間のボタン（分）。終了時刻の足し算をさせないための選択肢 */
export const DURATION_PRESETS = [30, 45, 60, 90] as const;

export interface Campus {
  id: string;
  name: string;
  open_time: string;   // 'HH:MM:SS'
  close_time: string;
  sort_order: number;
  active: boolean;
}

export interface Floor {
  id: string;
  campus_id: string;
  name: string;
  capacity: number;
  sort_order: number;
  active: boolean;
}

/** レッスン区分（A〜E）。記号も説明も管理画面から追加・変更できる */
export interface LessonCategory {
  id: string;
  code: string;
  description: string;
  sort_order: number;
  active: boolean;
}

/** 担当スタッフ。担当できる区分は categoryIds で持つ（表示のみに使い、制限はしない） */
export interface Staff {
  id: string;
  name: string;
  user_id: string | null;
  sort_order: number;
  active: boolean;
  categoryIds?: string[];
}

export interface Booking {
  id: string;
  floor_id: string;
  starts_at: string;       // ISO（timestamptz）
  ends_at: string;
  purpose: string;
  booker_name: string;
  member_no: string | null;
  customer_label: string | null;
  memo: string | null;
  exclusive: boolean;
  status: 'active' | 'cancelled';
  /** booking = 予約が入っている ／ open = 募集中の枠（先に置いて後から埋める） */
  kind: 'booking' | 'open';
  /** 募集枠の定員。基本1。「2名同時で受けたい」ときだけ2以上 */
  seats: number;
  /** 募集枠にいま何人入っているか */
  filled: number;
  recurrence_id: string | null;
  staff_id: string | null;
  created_by: string;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

/** 重なっている予約（RPCが返す conflicts の中身） */
export interface ConflictInfo {
  id: string;
  booker: string;
  purpose: string;
  starts_at: string;
  ends_at: string;
  exclusive: boolean;
}

/** 日本時間の「今日」を YYYY-MM-DD で返す */
export const todayStr = (): string => {
  const d = new Date();
  const jst = new Date(d.getTime() + (d.getTimezoneOffset() + 540) * 60000);
  return `${jst.getFullYear()}-${String(jst.getMonth() + 1).padStart(2, '0')}-${String(jst.getDate()).padStart(2, '0')}`;
};

/** 'YYYY-MM-DD' + 'HH:MM' → Date（端末のローカル時刻として作る。国内利用のみのため） */
export const toDate = (dateStr: string, timeStr: string): Date | null => {
  const t = normalizeTime(timeStr);
  if (!t) return null;
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, mi] = t.split(':').map(Number);
  if ([y, mo, d, h, mi].some(n => !Number.isFinite(n))) return null;
  return new Date(y, mo - 1, d, h, mi, 0, 0);
};

/** ISO文字列 → 'HH:MM' */
export const hhmm = (iso: string): string => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/**
 * ISO文字列 → その端末での 'YYYY-MM-DD'。
 *
 * 🚨 iso.slice(0, 10) で日付を取ってはいけない。
 *    Supabase が返す timestamptz は UTC 表記（例 '2026-08-27T23:00:00+00:00'）で、
 *    これは日本時間の 8/28 08:00 のこと。切り出すと 8/27 になり、
 *    **朝8時台の予約が前日にまとめられる**（2026-08-28 の実機確認で発見）。
 *    日付でまとめる・比べるときは必ずこの関数を通すこと。
 */
export const localDate = (iso: string): string => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** 'HH:MM' → その日の 0:00 からの分数 */
export const minutesOf = (timeStr: string): number => {
  const t = normalizeTime(timeStr);
  if (!t) return 0;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};

/** 'HH:MM' に分を足して 'HH:MM' を返す（24時をまたぐ場合は 23:59 で止める） */
export const addMinutes = (timeStr: string, add: number): string => {
  const total = Math.min(minutesOf(timeStr) + add, 23 * 60 + 59);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
};

/** 'YYYY-MM-DD' → '8/28（木）' */
export const formatDateLabel = (dateStr: string): string => {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return `${m}/${d}（${'日月火水木金土'[dt.getDay()]}）`;
};

/** 'YYYY-MM-DD' が土日かどうか（一覧で薄く色を変えるため） */
export const isWeekend = (dateStr: string): 0 | 6 | null => {
  const [y, m, d] = dateStr.split('-').map(Number);
  const day = new Date(y, m - 1, d).getDay();
  return day === 0 ? 0 : day === 6 ? 6 : null;
};

/** 担当別・参加者別の一覧で何日先まで出すか（開始日を含む） */
export const RANGE_DAYS = 31;

/**
 * 場所の名前。その校に場所が1つしかないときは、フロア名（「全体」）を書かない。
 * 「西陣校 全体」より「西陣校」のほうが読みやすいため（2026-08-28 ユーザー指示）。
 * 場所が複数ある校（四条本校の 3階/5階/会議室）では今までどおり両方出す。
 */
export const placeLabel = (
  floor: Floor | null | undefined,
  campusName: string,
  siblingCount: number,
  withCampus: boolean,
): string => {
  if (!floor) return campusName;
  const solo = siblingCount <= 1;
  if (withCampus) return solo ? campusName : `${campusName} ${floor.name}`;
  return solo ? campusName : floor.name;
};

/** 日付を n 日ずらす */
export const shiftDate = (dateStr: string, days: number): string => {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d + days);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
};

/**
 * スコラプラスで会員を開くURL。
 * 会員番号を keyword に入れるだけ（2026-08-28 ユーザー提供の実URLと同じ形）。
 * 🚨 会員番号以外の個人情報はURLにもDBにも入れない方針。
 */
export const scholaUrl = (memberNo: string): string =>
  'https://buscatch.net/sc/admin/five-m/course_children'
  + `?search_condition_type=&keyword=${encodeURIComponent(memberNo)}&limit=50`
  + '&data%5Breservable_flg%5D=1&data%5Breservable_flg%5D=2';

/**
 * スタッフの担当できる区分を「A・B・D」の形にする。
 * 🚨 記号の並び順は room_lesson_categories.sort_order に従う（登録順ではない）。
 */
export const categoryLabel = (staff: Staff | null | undefined, categories: LessonCategory[]): string => {
  if (!staff?.categoryIds?.length) return '';
  const set = new Set(staff.categoryIds);
  return categories
    .filter(c => set.has(c.id))
    .sort((a, b) => a.sort_order - b.sort_order)
    .map(c => c.code)
    .join('・');
};

/** 予約が「今まさに使用中」か */
export const isNowUsing = (b: Booking, now: Date): boolean =>
  new Date(b.starts_at) <= now && new Date(b.ends_at) > now;

/**
 * そのフロアが今この瞬間に空いているか（同時予約の上限まで埋まっていたら使用中）。
 * 占有の予約が1件でもあれば、上限に関係なく使用中扱い。
 */
export const floorBusyNow = (floor: Floor, bookings: Booking[], now: Date): boolean => {
  const live = bookings.filter(b => b.floor_id === floor.id && b.status === 'active' && isNowUsing(b, now));
  if (live.some(b => b.exclusive)) return true;
  return live.length >= floor.capacity;
};

/** そのフロアの「次に予約が始まる時刻」（今より後で一番早いもの）。無ければ null */
export const nextStart = (floorId: string, bookings: Booking[], now: Date): string | null => {
  const future = bookings
    .filter(b => b.floor_id === floorId && b.status === 'active' && new Date(b.starts_at) > now)
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  return future.length ? hhmm(future[0].starts_at) : null;
};

/** そのフロアで今使っている予約のうち、一番遅い終了時刻 */
export const usingUntil = (floorId: string, bookings: Booking[], now: Date): string | null => {
  const live = bookings
    .filter(b => b.floor_id === floorId && b.status === 'active' && isNowUsing(b, now))
    .sort((a, b) => b.ends_at.localeCompare(a.ends_at));
  return live.length ? hhmm(live[0].ends_at) : null;
};

/**
 * 同じ時間帯に重なる予約どうしを横に並べるための列割り当て。
 * 同時3件まで入るフロアがあるので、重なった分を等幅で分ける。
 * 返り値: 予約ID → { col, cols }
 */
export const assignColumns = (bookings: Booking[]): Record<string, { col: number; cols: number }> => {
  const sorted = [...bookings].sort((a, b) =>
    a.starts_at.localeCompare(b.starts_at) || a.ends_at.localeCompare(b.ends_at));
  const result: Record<string, { col: number; cols: number }> = {};
  let group: Booking[] = [];
  let groupEnd = '';

  const flush = () => {
    if (!group.length) return;
    // グループ内で列を詰めて割り当てる（空いている一番左の列に置く）
    const colEnds: string[] = [];
    const cols: Record<string, number> = {};
    for (const b of group) {
      let idx = colEnds.findIndex(end => end <= b.starts_at);
      if (idx === -1) { idx = colEnds.length; colEnds.push(b.ends_at); }
      else colEnds[idx] = b.ends_at;
      cols[b.id] = idx;
    }
    const total = colEnds.length;
    for (const b of group) result[b.id] = { col: cols[b.id], cols: total };
    group = []; groupEnd = '';
  };

  for (const b of sorted) {
    if (group.length && b.starts_at >= groupEnd) flush();
    group.push(b);
    if (!groupEnd || b.ends_at > groupEnd) groupEnd = b.ends_at;
  }
  flush();
  return result;
};

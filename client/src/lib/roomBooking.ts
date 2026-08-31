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
  /** この枠が「固定」か。人ではなく曜日・時間の枠の性質。既定 false */
  is_fixed: boolean;
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

/**
 * キャンセル待ち（DBの room_waitlist）。埋まっている予約の後ろに並ぶ。
 * 🚨 募集枠（kind='open'）とは別物。あちらは「空きがある枠」、こちらは「空き待ち」。
 */
export interface Waitlist {
  id: string;
  booking_id: string;
  member_no: string | null;
  customer_label: string;
  staff_id: string | null;
  note: string | null;
  position: number;
  status: 'waiting' | 'promoted' | 'cancelled';
  created_at: string;
  /** 一覧で曜日・時間別に並べるために、予約側の情報を一緒に読む */
  booking?: {
    id: string; floor_id: string; starts_at: string; ends_at: string;
    purpose: string; status: 'active' | 'cancelled'; deleted_at: string | null;
  } | null;
}

/** お客様（DBの room_customers）。一般の方は会員番号を持たないので、ここには載らない */
export interface Customer {
  member_no: string;
  display_name: string;
  full_name: string | null;
  birth_date: string | null;   // 'YYYY-MM-DD'
  active: boolean;
  note: string | null;
}

/** 連絡先。見える範囲は設定（contact_visibility）で決まるので、読めないことがある */
export interface CustomerContact {
  member_no: string;
  phone: string | null;
  email: string | null;
  guardian_name: string | null;
}

/**
 * 生年月日から「学年の番号」を出す。小1=1 … 小6=6、中1=7 … 中3=9、高1=10 … 高3=12。
 * 0=年長、-1=年中、-2=年少。13以上は高校を出たあと。
 *
 * 🚨 日本の学年は「4/2〜翌4/1 生まれ」で1学年。**4/1生まれは1つ上の学年**になる。
 *    そこで生年月日の「1日前」がどの年度かを見る。
 *    例）2020-04-01 生まれ → 前日 2020-03-31 → 2019年度生まれ扱い
 *        2020-04-02 生まれ → 前日 2020-04-01 → 2020年度生まれ
 *
 * 🚨 学年を数値で持たないこと。持つと4月に全員1つズレ、上げ忘れると
 *    静かに間違った学年が出続ける（2026-08-29 ユーザー確定で計算方式にした）。
 */
export const gradeNumber = (birthDate: string, onDate: string): number | null => {
  if (!birthDate) return null;
  const [by, bm, bd] = birthDate.split('-').map(Number);
  if (!by || !bm || !bd) return null;
  const prev = new Date(by, bm - 1, bd - 1);          // 生年月日の前日
  const bornFy = prev.getMonth() + 1 >= 4 ? prev.getFullYear() : prev.getFullYear() - 1;
  return fiscalYear(onDate) - bornFy - 6;
};

/** 学年の番号を「小3」「年中」のような表示にする */
export const gradeLabel = (grade: number | null): string => {
  if (grade === null) return '';
  if (grade >= 1 && grade <= 6) return `小${grade}`;
  if (grade >= 7 && grade <= 9) return `中${grade - 6}`;
  if (grade >= 10 && grade <= 12) return `高${grade - 9}`;
  if (grade === 0) return '年長';
  if (grade === -1) return '年中';
  if (grade === -2) return '年少';
  if (grade < -2) return '未就園';
  return '一般';                                       // 高校を出たあと
};

/** 生年月日から、その日時点の学年表示を出す（'小3' など。生年月日が無ければ空） */
export const gradeOf = (birthDate: string | null, onDate: string): string =>
  (birthDate ? gradeLabel(gradeNumber(birthDate, onDate)) : '');

/**
 * 用途ごとの「長さ」の選択肢（DBの room_purpose_durations）。
 *
 * 🚨 ここをコードに固定しないこと。長さは現場の都合で変わるため、
 *    社員が基本設定から直せるようにしてある（2026-08-29 ユーザー指示）。
 */
export interface PurposeDuration {
  purpose: string;
  /** 選べる長さ（分）。空 = ボタンを出さない（任意入力だけ） */
  minutes: number[];
  /**
   * 最初に入る長さ（分）。null なら minutes の先頭を使う。
   * 🚨 並び順と既定は別のこと。プライベートは「25/30/50」と並べつつ既定は30分。
   */
  default_minutes: number | null;
  /** 終了時刻を手で入れてよいか。false のときは長さボタンだけで決める */
  allow_free: boolean;
}

/**
 * DBを読めなかったときに使う既定値。
 * 🚨 これが出るのは通信に失敗したときだけ。ここを直しても本番の値は変わらない
 *    （本番の値は room_purpose_durations にある）。
 */
export const FALLBACK_DURATIONS: PurposeDuration[] = [
  { purpose: 'プライベート', minutes: [25, 30, 50], default_minutes: 30,   allow_free: true },
  { purpose: 'パーソナル',   minutes: [10],         default_minutes: null, allow_free: false },
  { purpose: 'レッスン',     minutes: [50],         default_minutes: null, allow_free: false },
  { purpose: 'レンタル',     minutes: [60, 120],    default_minutes: null, allow_free: true },
  { purpose: 'その他',       minutes: [],           default_minutes: null, allow_free: true },
];

/**
 * 最初に入る長さ。設定が無ければ一覧の先頭。どちらも無ければ null。
 *
 * 🚨 一覧に無い値が既定になっていたら使わない。ボタンが選択状態にならず
 *    「押しても何も変わらない」ように見えてしまう。
 */
export const defaultMinutesOf = (d: PurposeDuration | null | undefined): number | null => {
  if (!d) return null;
  if (d.default_minutes != null && d.minutes.includes(d.default_minutes)) return d.default_minutes;
  return d.minutes[0] ?? null;
};

/** 分を「1時間30分」のように読める形にする（長さボタンの文字） */
export const durationLabel = (min: number): string => {
  if (min < 60) return `${min}分`;
  const h = Math.floor(min / 60), m = min % 60;
  return m === 0 ? `${h}時間` : `${h}時間${m}分`;
};

/**
 * 毎週の繰り返しの「約束事」。各回の実予約（Booking）とは別に1件だけ持つ。
 * 年度更新の画面は、この行を一覧にして次の年度へ引き継ぐ。
 */
export interface Recurrence {
  id: string;
  floor_id: string;
  weekday: number;         // 0=日曜（JS の getDay と同じ）
  start_time: string;      // 'HH:MM:SS'
  end_time: string;
  purpose: string;
  booker_name: string;
  member_no: string | null;
  customer_label: string | null;
  memo: string | null;
  exclusive: boolean;
  /**
   * この曜日・この時間の枠が「固定」か（2026-08-31 ユーザー確定）。
   * 🚨 人ではなく**枠**の性質。来週も入っているかの判断材料になり、
   *    パーソナルは固定かどうかで金額が変わる。未設定は false（固定でない）。
   */
  is_fixed: boolean;
  staff_id: string | null;
  kind: 'booking' | 'open';
  seats: number;
  start_date: string;
  end_date: string | null;
  /** 4/1〜翌3/31 を1つとする年度。終わりの日が属する年度を入れる */
  fiscal_year: number;
  /** どの繰り返しから引き継いだか。二度押しで二重に作らないための目印 */
  renewed_from: string | null;
  active: boolean;
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

/**
 * 年度（4/1〜翌3/31）。'2026-03-31' は 2025年度、'2026-04-01' は 2026年度。
 *
 * 🚨 年度は必ずこの関数で求めること。画面のあちこちで「月を見て分岐」を書くと、
 *    3月と4月の境目でだけ違う年度になるズレが出て、原因が分かりにくい。
 */
export const fiscalYear = (dateStr: string): number => {
  const [y, m] = dateStr.split('-').map(Number);
  return m >= 4 ? y : y - 1;
};

/** その年度の初日（4/1） */
export const fiscalYearStart = (fy: number): string => `${fy}-04-01`;

/** その年度の最終日（翌年の3/31）。繰り返しの既定の終わり */
export const fiscalYearEnd = (fy: number): string => `${fy + 1}-03-31`;

/** '2026年度（2027/3/31まで）' */
export const fiscalYearLabel = (fy: number): string => `${fy}年度（${fy + 1}/3/31まで）`;

/** 何日前から「年度末が近い」として扱うか（案内を出す・来年度末まで作れるようにする） */
export const RENEWAL_NOTICE_DAYS = 60;

/** 2つの日付の差（日数）。from から to まで何日あるか */
export const daysUntil = (fromStr: string, toStr: string): number => {
  const [y1, m1, d1] = fromStr.split('-').map(Number);
  const [y2, m2, d2] = toStr.split('-').map(Number);
  return Math.round(
    (new Date(y2, m2 - 1, d2).getTime() - new Date(y1, m1 - 1, d1).getTime()) / 86400000);
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

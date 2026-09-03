// 部屋（フロア）予約の共通処理。画面から時刻の組み立て・整形を追い出しておく場所。
//
// 🚨 時刻の扱いは lib/timeInput.ts を必ず通すこと（自前で split(':') しない）。
//    このアプリは 2026-08-26 に「"930" が NaN 経由で別の数字として静かに保存される」
//    事故を踏んでいる。ここでも HH:MM の生成は normalizeTime の結果だけを使う。

import { normalizeTime } from './timeInput';

/** 用途の区分（2026-08-28 ユーザー確定）。色は明/暗それぞれで見分けられる組み合わせにしている */
/**
 * 用途の既定（＝DBが読めないときの逃げ道）。
 * 🚨 2026-09-02 から用途は room_purposes テーブルにあり、管理者が
 *    ⚙️設定 → 用途 で追加・名前変更できる。ここに直書きで増やさないこと。
 */
export const PURPOSES = ['プライベート', 'パーソナル', 'レッスン', 'レンタル', 'その他'] as const;
/** 用途は管理者が増やせるので、決まった一覧の型では持てない */
export type Purpose = string;

/** 用途（DBの room_purposes）。管理者が ⚙️設定 で増減・改名できる */
export interface RoomPurpose {
  id: string;
  name: string;
  /** 色は下の PURPOSE_PALETTE の鍵で持つ（自由な色コードにしない） */
  color_key: string;
  sort_order: number;
  active: boolean;
}

/**
 * 用途に選べる色（明るい画面／暗い画面のペアを調整済み）。
 * 🚨 自由な色コードを許さない。暗い画面で読めない色や、募集中の枠（黄系の破線）と
 *    紛らわしい色を選ばれると事故になるため、この一覧からだけ選ぶ。
 */
export const PURPOSE_PALETTE: Record<string, { label: string; light: [string, string]; dark: [string, string] }> = {
  purple: { label: '紫',     light: ['#7b4bb5', '#efe7fa'], dark: ['#c4a5ee', '#3a2f52'] },
  teal:   { label: '青緑',   light: ['#1f7a8c', '#e0f2f5'], dark: ['#7fd3e0', '#233f45'] },
  blue:   { label: '青',     light: ['#3b6fb5', '#e6eefa'], dark: ['#8ab4e8', '#2b3950'] },
  amber:  { label: '茶',     light: ['#b5761f', '#fbeed8'], dark: ['#e0b071', '#453520'] },
  green:  { label: '緑',     light: ['#2f7a45', '#e3f2e8'], dark: ['#8fd3a8', '#24402e'] },
  rose:   { label: '赤紫',   light: ['#b5476b', '#fae7ee'], dark: ['#eda5bd', '#4a2b38'] },
  indigo: { label: '藍',     light: ['#5b52b5', '#e9e7fa'], dark: ['#b0a8ee', '#332f52'] },
  gray:   { label: '灰',     light: ['#5b6270', '#eceef1'], dark: ['#aab0be', '#383a4a'] },
};

/** 既存5用途の色（DBが読めないとき・登録前の名前のための逃げ道） */
const LEGACY_PURPOSE_KEY: Record<string, string> = {
  'プライベート': 'purple', 'パーソナル': 'teal', 'レッスン': 'blue',
  'レンタル': 'amber', 'その他': 'gray',
};

/**
 * 読み込んだ用途の一覧（画面全体で共通）。
 * 🚨 loadMasters が setPurposeRegistry で入れる。13か所の呼び出しに配列を
 *    引き回すと渡し忘れが出るので、ここ1か所で持つ。
 *    読み込み前・読めなかったときは PURPOSES（既定の5つ）で動く。
 */
let purposeRegistry: RoomPurpose[] = [];
export const setPurposeRegistry = (rows: RoomPurpose[]): void => {
  purposeRegistry = [...rows].sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name, 'ja'));
};

/** 予約フォームなどに出す用途（隠したものは出さない）。並びは sort_order */
export const activePurposes = (): string[] => {
  const act = purposeRegistry.filter(p => p.active).map(p => p.name);
  return act.length ? act : [...PURPOSES];
};

/** 集計などの並べ替え用。一覧に無い（隠した・古い）用途は最後にまわす */
export const purposeOrder = (name: string): number => {
  const all = purposeRegistry.length ? purposeRegistry.map(p => p.name) : [...PURPOSES];
  const i = all.indexOf(name);
  return i < 0 ? 99 : i;
};

export const purposeColor = (purpose: string, isDark: boolean): [string, string] => {
  const key = purposeRegistry.find(p => p.name === purpose)?.color_key
    ?? LEGACY_PURPOSE_KEY[purpose] ?? 'gray';
  const c = PURPOSE_PALETTE[key] ?? PURPOSE_PALETTE['gray'];
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
  /**
   * 用途の中の区分（パーソナルの「体操」「筋トレ」など）。選ばれていなければ null。
   * 🚨 選択肢は room_purpose_details にあり、管理者が足せる。ここに直書きしないこと。
   */
  detail: string | null;
  booker_name: string;
  member_no: string | null;
  customer_label: string | null;
  memo: string | null;
  exclusive: boolean;
  /** この枠が「固定」か。人ではなく曜日・時間の枠の性質。既定 false */
  is_fixed: boolean;
  status: 'active' | 'cancelled';
  /**
   * 取り消しの種類（status='cancelled' のときだけ意味を持つ・2026-09-02〜）。
   *   'closed'  … 休講（当社都合。レッスン自体を開催しない）
   *   'absence' … お休み（お客様都合のキャンセル。出欠の記録は見えたまま・集計にも入る）
   * 🚨 判定は isAbsence() / cancelledLabel() を使う。直接比較を書き散らさない
   */
  cancel_kind?: 'closed' | 'absence';
  /** booking = 予約が入っている ／ open = 募集中の枠（先に置いて後から埋める） */
  kind: 'booking' | 'open';
  /** 募集枠の定員。基本1。「2名同時で受けたい」ときだけ2以上 */
  seats: number;
  /** 募集枠にいま何人入っているか */
  filled: number;
  recurrence_id: string | null;
  /**
   * 画面で組み立てるお客様名（「田中 たろう」）。DBの列ではない。
   * 会員番号からお客様を引いて入れる。引けないとき（一般の方など）は空。
   * 🚨 予約に名前を保存してしまうと、お客様名を直したときに古いまま残る。
   *    だから保存せず、表示のときに毎回引く。
   */
  customer_name?: string;
  /**
   * 名前の横に出す学年・年齢（「小3」「大2」「32歳」）。DBの列ではない。
   * 🚨 その予約の日を基準に出す。学年は年度で変わるため
   */
  customer_grade?: string;
  staff_id: string | null;
  /**
   * 取り消した日時（消さずに印だけ付ける）。ふだんの一覧は deleted_at を除いて
   * 読むので null。キャンセル待ちの「入れる日」の候補だけは、取り消した回も
   * 読むためにここを見る（2026-09-02）。
   */
  deleted_at?: string | null;
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
  /** 「この回だけ」の待ち。毎週の枠の待ちでは null（どちらか片方だけが入る） */
  booking_id: string | null;
  /** 「毎週の枠」の待ち（2026-09-02〜）。担当が違えば枠も別＝待ち行列も別 */
  recurrence_id: string | null;
  member_no: string | null;
  customer_label: string;
  staff_id: string | null;
  note: string | null;
  position: number;
  status: 'waiting' | 'promoted' | 'cancelled';
  created_at: string;
  /** 一覧で並べるために、予約側の情報を一緒に読む（この回だけの待ち用） */
  booking?: {
    id: string; floor_id: string; starts_at: string; ends_at: string;
    purpose: string; status: 'active' | 'cancelled'; deleted_at: string | null;
    staff_id: string | null;
    /** 「空きあり」の目印の判定（参加者ごとの出欠照合）に使う */
    member_no: string | null; customer_label: string | null;
    cancel_kind?: 'closed' | 'absence';
    /**
     * この予約がどの毎週の枠に属すか。「この回だけ」の待ちを、
     * 同じ枠の毎週の待ちと**1本の列**にまとめるために使う（2026-09-02 案A）
     */
    recurrence_id: string | null;
  } | null;
  /** 毎週の枠の待ち用。枠の曜日・時間・担当をここから出す */
  recurrence?: {
    id: string; floor_id: string; weekday: number; start_time: string; end_time: string;
    purpose: string; staff_id: string | null; active: boolean;
    /** 空きが出たとき「空き枠にする」を出すか（枠ごとの設定・既定 true） */
    auto_open_slot?: boolean;
    /** キャンセル待ちの受付を締め切っているか（既定 false） */
    waitlist_closed?: boolean;
  } | null;
}

/** お客様（DBの room_customers）。一般の方は会員番号を持たないので、ここには載らない */
export interface Customer {
  member_no: string;
  display_name: string;
  full_name: string | null;
  /** 姓（漢字）。例：田中 */
  last_name: string | null;
  /** 名（漢字）。例：太郎 */
  first_name: string | null;
  /** 姓のふりがな（ひらがな） */
  last_kana: string | null;
  /** 名のふりがな（ひらがな）。予約表の表示に使う。例：たろう */
  first_kana: string | null;
  birth_date: string | null;   // 'YYYY-MM-DD'
  active: boolean;
  note: string | null;
}

/**
 * カタカナをひらがなに直す。
 *
 * 🚨 漢字からひらがなは作れない（同じ漢字でも読みが複数ある）ので、
 *    必ず**フリガナの列から**変換すること。ここは文字コードの計算だけなので
 *    推測が入らず、必ず同じ結果になる。
 * 半角カナ（ﾀﾅｶ）も先に全角へ寄せてから変換する。
 */
export const toHiragana = (s: string): string => {
  if (!s) return '';
  const HALF = 'ｦｧｨｩｪｫｬｭｮｯｰｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ';
  const FULL = 'ヲァィゥェォャュョッーアイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワン';
  let t = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const next = s[i + 1];
    const h = HALF.indexOf(c);
    if (h >= 0) {
      let full = FULL[h];
      // 濁点・半濁点は次の文字に付いてくるので、正しい1文字にまとめる
      if (next === 'ﾞ' || next === 'ﾟ') {
        const combined = (full + (next === 'ﾞ' ? '゙' : '゚')).normalize('NFC');
        if (combined.length === 1) { full = combined; i++; }
      }
      t += full;
    } else {
      t += c;
    }
  }
  // 全角カタカナ → ひらがな
  return t.replace(/[ァ-ヶ]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60));
};

/**
 * お客様の表示名。「田中 たろう」のように、姓は漢字・名はひらがなで出す
 * （2026-08-31 ユーザー指示）。
 * 作れないときは、取り込んだ氏名 → 「田中様」形式の表示名 の順に落とす。
 */
export const customerName = (c: Customer | null | undefined, onDate: string): string => {
  if (!c) return '';
  const last = (c.last_name ?? '').trim();
  const kana = (c.first_kana ?? '').trim();
  const kanji = (c.first_name ?? '').trim();
  // 🚨 大学生より上の大人は下の名前も漢字、それ以下の子どもはひらがな
  //    （2026-08-31 ユーザー指示）。境目は学年／年齢の切り替わりと同じ。
  //    生年月日が無いと大人かどうか分からないので、その場合はひらがな側に倒す
  const g = c.birth_date ? gradeNumber(c.birth_date, onDate) : null;
  const adult = g !== null && g > 16;
  const first = adult ? (kanji || kana) : (kana || kanji);
  if (last && first) return `${last} ${first}`;
  if (last) return last;
  return (c.full_name ?? '').trim() || c.display_name;
};

/** ひらがなをカタカナに直す（一覧の表示用。ふりがなはひらがなで持っている） */
export const toKatakana = (s: string): string =>
  (s || '').replace(/[ぁ-ゖ]/g, ch => String.fromCharCode(ch.charCodeAt(0) + 0x60));

/**
 * 漢字のフルネーム（「田中 太郎」）。基本設定の一覧で使う。
 * 予約表は customerName（「田中 たろう」）のほうを使う。
 */
export const customerFullName = (c: Customer | null | undefined): string => {
  if (!c) return '';
  const last = (c.last_name ?? '').trim();
  const first = (c.first_name ?? '').trim();
  if (last && first) return `${last} ${first}`;
  return (c.full_name ?? '').trim() || last || c.display_name;
};

/**
 * フリガナ（カタカナ）。一覧に出して探しやすくするため（2026-08-31 ユーザー指示）。
 * 🚨 中はひらがなで持っている。表示のときだけカタカナに直す。
 *    持ち方を変えると、予約表の「田中 たろう」も直さないといけなくなる。
 */
export const customerKana = (c: Customer | null | undefined): string => {
  if (!c) return '';
  const last = toKatakana((c.last_kana ?? '').trim());
  const first = toKatakana((c.first_kana ?? '').trim());
  return [last, first].filter(Boolean).join(' ');
};

/**
 * お名前でお客様を探すときの条件（PostgREST の or に渡す文字列）を作る。
 *
 * 🚨 一覧の絞り込みと**同じ考え方**をここ1か所に置く。探し方を2か所に書くと、
 *    片方だけ直して「一覧では出るのに予約画面では出ない」が起きる。
 * 🚨 ふりがなは**中はひらがな**で持っているので、カタカナ・半角カナで打たれても
 *    ひらがなに直してから当てる（`toHiragana`）。
 * 🚨 `,` `(` `)` は or の区切りとぶつかって条件ごと壊れるので落とす。
 *    落とした結果が空になったら null を返し、呼ぶ側で問い合わせを止めること。
 */
export const customerSearchFilter = (raw: string): string | null => {
  // 🚨 「田中 太郎」のように空白を含めて打たれても当たるように、**最初のかたまりだけ**で引く。
  //    姓と名は別の列なので、空白を含んだままではどの列にも一致しない（2026-09-01 検算で発覚）。
  //    残りのかたまりは `customerMatches` で絞る（DBに複雑な条件を書かずに済む）。
  const first = raw.trim().split(/[\s　]+/).filter(Boolean)[0] ?? '';
  const q = first.replace(/[,()*]/g, '');
  if (q.length < 1) return null;
  const kana = toHiragana(q);
  const like = (col: string, v: string) => `${col}.ilike.%${v}%`;
  return [
    like('display_name', q),
    like('last_name', q),
    like('first_name', q),
    like('full_name', q),
    like('last_kana', kana),
    like('first_kana', kana),
    like('member_no', q),
  ].join(',');
};

/**
 * 打った文字がこのお客様に当てはまるか（候補の絞り込み）。
 *
 * 🚨 DB では最初のかたまりだけで引いているので、「田中 太郎」の**「太郎」の部分**は
 *    ここで絞る。空白で区切られたかたまりが**すべて**含まれていることを求める。
 * 🚨 カタカナ・半角カナで打たれてもふりがなに当たるよう、ひらがなに直して比べる。
 */
export const customerMatches = (c: Customer, raw: string): boolean => {
  const q = raw.trim();
  if (!q) return true;
  const parts = [
    c.display_name, c.full_name, c.last_name, c.first_name, c.member_no,
    `${c.last_name ?? ''} ${c.first_name ?? ''}`,
    `${c.last_name ?? ''}${c.first_name ?? ''}`,
    c.last_kana, c.first_kana,
    `${c.last_kana ?? ''} ${c.first_kana ?? ''}`,
    `${c.last_kana ?? ''}${c.first_kana ?? ''}`,
  ];
  const hay = parts.filter(Boolean).join(' ').toLowerCase();
  return q.split(/[\s　]+/).filter(Boolean).every(tok => {
    const t = tok.toLowerCase();
    return hay.includes(t) || hay.includes(toHiragana(t));
  });
};

/** 連絡先。見える範囲は設定（contact_visibility）で決まるので、読めないことがある */
export interface CustomerContact {
  member_no: string;
  /** 固定電話（家電） */
  phone: string | null;
  /** 携帯番号。🚨 固定と両方あるときは両方出す（2026-08-31 ユーザー指示） */
  mobile: string | null;
  email: string | null;
  guardian_name: string | null;
}

/**
 * 連絡先を「固定電話 / 携帯 / メール」の順に、あるものだけ並べる。
 * 🚨 固定電話には見出しを付けない（2026-08-31 ユーザー指示）。
 *    番号だけのものが固定、「携帯」と書いてあるものが携帯、と読めればよい。
 */
export const contactLines = (k: CustomerContact | null | undefined): string[] => {
  if (!k) return [];
  return [
    k.phone ?? '',
    k.mobile ? `携帯 ${k.mobile}` : '',
    k.email ?? '',
    k.guardian_name ? `保護者：${k.guardian_name}` : '',
  ].filter(Boolean);
};

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


/** その日時点の満年齢。誕生日が来ていなければ1つ引く */
export const ageOn = (birthDate: string, onDate: string): number | null => {
  const [by, bm, bd] = birthDate.split('-').map(Number);
  const [y, m, d] = onDate.split('-').map(Number);
  if (!by || !bm || !bd || !y) return null;
  let age = y - by;
  if (m < bm || (m === bm && d < bd)) age--;
  return age < 0 ? null : age;
};

/**
 * 名前の横に出す「学年、または年齢」（2026-08-31 ユーザー指示）。
 *   未就園〜高3 … 学年（小3・中1・高2 など）
 *   大学生の年ごろ … 大1〜大4
 *   それより上の大人 … 「32歳」のように年齢
 *
 * 🚨 大1〜大4 は**生年月日からの推定**でしかない。浪人・専門学校・就職など、
 *    実際に大学生とは限らない。あくまで目安として出す。
 * 🚨 学年は年度で変わるので、**その予約の日**を基準に出すこと。
 *    今日を基準にすると、来年度の予約に今年度の学年が出る。
 */
export const gradeOrAge = (birthDate: string | null, onDate: string): string => {
  if (!birthDate) return '';
  const g = gradeNumber(birthDate, onDate);
  if (g === null) return '';
  if (g <= 12) return gradeLabel(g);          // 未就園 〜 高3
  if (g <= 16) return `大${g - 12}`;           // 大1〜大4
  const age = ageOn(birthDate, onDate);
  return age == null ? '' : `${age}歳`;
};

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
  /**
   * 詳細（体操・筋トレなど）を必ず選ばせるか（2026-09-01 ユーザー指示）。
   * 🚨 効くのは**その用途に詳細が1つ以上あるときだけ**。
   *    詳細を作っていない用途で必須にすると、予約そのものができなくなる。
   */
  detail_required: boolean;
}

/**
 * 用途の「詳細」（DBの room_purpose_details）。
 * パーソナルの 体操・筋トレ のような、用途の中の区分。
 *
 * 🚨 用途を増やす（「パーソナル（体操）」）形にはしないこと。色分け・長さの設定・
 *    集計がすべて用途の単位なので、増やすたびに設定が重複して食い違う。
 */
export interface PurposeDetail {
  id: string;
  purpose: string;
  name: string;
  sort_order: number;
  active: boolean;
}

/**
 * その用途で選べる詳細を、並び順で取り出す。
 * 🚨 隠したもの（active=false）は出さない。ただし**すでに保存されている詳細**は
 *    別扱いにすること（隠したあとで古い予約を開くと、選択が消えたように見えるため
 *    画面側で「いま入っている値」を足している）。
 */
/**
 * 出欠の選択肢（DBの room_attendance_options）。
 * 🚨 コードに固定しないこと。あとで「振替」等を足すのにデプロイが要るため
 *    （2026-09-01 ユーザー確定。用途詳細と同じ考え方）。
 */
export interface AttendanceOption {
  id: string;
  name: string;
  /** 出席として数えるか。「キャン1回消化」は来ていないが出席扱い */
  counts_present: boolean;
  /** どの用途で出すか。null・空 = 全用途。例：「連絡なし休み」は パーソナル のみ */
  purposes: string[] | null;
  /**
   * 支払いの記入欄を出す用途。null・空 = 出さない。
   * 🚨 表示の出し分け（purposes）とは**別物**。「出席」は全用途に出すが、
   *    支払い欄はプライベートのときだけ、という形にするため分けてある。
   */
  payment_purposes: string[] | null;
  sort_order: number;
  active: boolean;
}

/** 出欠の記録（DBの room_booking_attendance）。付けたときだけ行がある */
export interface AttendanceRow {
  id: string;
  booking_id: string;
  participant_no: string;
  participant_name: string;
  status: string;
  counted_present: boolean;
  /**
   * 支払いの覚書。プライベートの「10回区切りの一覧表」との照合に使う。
   * 書き方は「何回目 / 何回払い」（10回払いの2回目＝「2/10」、1回払いの4回目＝「4/1」）。
   * 🚨 **分数ではない。計算に使わないこと。**書き方が変わっても直さずに済むよう文字で持つ。
   */
  payment_note: string | null;
  recorded_at: string;
  recorded_by: string | null;
}

/**
 * この出欠を選んだとき、この用途で支払いの記入欄を出すか。
 * 🚨 判定をここ1か所にまとめる（入力欄・集計・CSVの3か所から呼ぶ）。
 */
export const needsPaymentNote = (opt: AttendanceOption | null | undefined, purpose: string): boolean =>
  !!opt?.payment_purposes?.includes(purpose);

/** その用途で出す出欠の選択肢を、並び順で取り出す */
export const attendanceOptionsFor = (
  purpose: string, all: AttendanceOption[],
): AttendanceOption[] =>
  all.filter(o => o.active && (!o.purposes || o.purposes.length === 0 || o.purposes.includes(purpose)))
     .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name, 'ja'));

/** 予約に紐づく参加者1人ぶん */
export interface Participant {
  /** 会員番号。一般のお客様は空 */
  no: string;
  /** お名前。入っていないこともある */
  name: string;
  /** 出欠の記録を結び付ける鍵。番号とお名前の組で1人と数える */
  key: string;
}

/**
 * 予約から参加者を取り出す。
 *
 * 🚨 いまの作りでは、2名定員の募集枠を埋めると room_fill_open_slot が
 *    会員番号とお名前を「田中 太郎, 佐藤 花子」のように**カンマでつないで1行に**入れる。
 *    参加者の表は無いので、ここで分ける。
 * 🚨 番号とお名前は**別々につながれる**。会員番号は任意なので、2名のうち片方だけ
 *    番号があると「番号1つ・名前2つ」になり、**単純に順番で結ぶと番号が別人に付く**
 *    （2026-09-01 検算で発覚。1人目に番号が無いと、2人目の番号が1人目に付いていた）。
 *    どの番号が誰のものか復元できないので、**数が合わないときは番号を捨てる**。
 *    黙って間違った番号を集計・CSVに載せるより、空のほうが安全。
 * 🚨 どちらも空の予約（レンタルなど）でも1人ぶん返す。出欠を付けられなくなるため。
 */
export const participantsOf = (b: Pick<Booking, 'member_no' | 'customer_label'>): Participant[] => {
  const split = (v: string | null) => (v ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const nos = split(b.member_no);
  const names = split(b.customer_label);
  // 番号と名前を順番で結んでよいか。
  //   ・数が同じ … 結んでよい
  //   ・名前が1人以下 … ずれようがない（会員番号だけの予約もここ）
  //   ・番号が無い … 結ぶものが無い
  const aligned = nos.length === names.length || names.length <= 1 || nos.length === 0;
  const n = Math.max(nos.length, names.length, 1);
  const out: Participant[] = [];
  for (let i = 0; i < n; i++) {
    const no = aligned ? (nos[i] ?? '') : '';
    const name = names[i] ?? '';
    out.push({ no, name, key: `${no}|${name}` });
  }
  return out;
};

/** 参加者の見せ方。お名前が無ければ会員番号、どちらも無ければその旨を出す */
export const participantLabelOf = (p: Participant): string =>
  p.name || (p.no ? `#${p.no}` : '（お名前なし）');

/**
 * 予約の見出し（「パーソナル・体操」）。詳細が無ければ用途だけ。
 * 🚨 同じ組み立てを画面のあちこちに書かないこと。片方だけ直す事故のもとになる。
 */
export const purposeWithDetail = (b: { purpose: string; detail?: string | null }): string =>
  b.detail ? `${b.purpose}・${b.detail}` : b.purpose;

export const detailsOf = (purpose: string, all: PurposeDetail[]): PurposeDetail[] =>
  all.filter(d => d.purpose === purpose && d.active)
     .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name, 'ja'));

/**
 * DBを読めなかったときに使う既定値。
 * 🚨 これが出るのは通信に失敗したときだけ。ここを直しても本番の値は変わらない
 *    （本番の値は room_purpose_durations にある）。
 */
export const FALLBACK_DURATIONS: PurposeDuration[] = [
  { purpose: 'プライベート', minutes: [25, 30, 50], default_minutes: 30,   allow_free: true,  detail_required: true },
  { purpose: 'パーソナル',   minutes: [10],         default_minutes: null, allow_free: false, detail_required: true },
  { purpose: 'レッスン',     minutes: [50],         default_minutes: null, allow_free: false, detail_required: true },
  { purpose: 'レンタル',     minutes: [60, 120],    default_minutes: null, allow_free: true,  detail_required: true },
  { purpose: 'その他',       minutes: [],           default_minutes: null, allow_free: true,  detail_required: true },
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
  /**
   * 用途の中の区分。来年度へ引き継ぐときに消えないよう、繰り返しにも持たせる。
   * 🚨 年度更新（room_renew_recurrence）はまだこれを予約にコピーしない（2026-09-01 時点）
   */
  detail: string | null;
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
  /** null = 期限なし（2026-09-02〜の既定。月次更新で延長し続ける。年度更新の対象外） */
  end_date: string | null;
  /** どこまで子予約を作ったか。月次更新（room_extend_recurrence）がここから先を作る */
  generated_to: string | null;
  /** 空きが出たとき「空き枠にする」を出すか（枠ごとの設定・既定 true） */
  auto_open_slot?: boolean;
  /** キャンセル待ちの受付を締め切っているか（既定 false） */
  waitlist_closed?: boolean;
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
/**
 * お客様都合の「お休み」か（2026-09-02〜）。休講（当社都合）とは別もの。
 * どちらも status='cancelled'（＝予約数に数えない・空き判定から外れる）だが、
 * お休みは出欠の記録が見えたまま・集計にも入る。
 */
export const isAbsence = (b: Pick<Booking, 'status' | 'cancel_kind'>): boolean =>
  b.status === 'cancelled' && b.cancel_kind === 'absence';

/** 取り消した予約のグレー表示に出す呼び名（案A・2026-09-02 ユーザー確定） */
export const cancelledLabel = (b: Pick<Booking, 'status' | 'cancel_kind'>): string =>
  isAbsence(b) ? 'お休み' : '休講';

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
 *
 * 🚨 2026-09-01 に形を直した。**うまく開かなかった**ため、ユーザーから提供された
 *    実際に動くURLと同じ形にした：`?keyword=<会員番号>&limit=50` だけ。
 *    それまで付けていた `search_condition_type=` と
 *    `data[reservable_flg]=1&2` は**外した**（この絞り込みが効いて出てこなかった）。
 * 🚨 複数人のときは**全角スペースでつなぐ**（提供されたURLが %E3%80%80 ＝ 全角空白）。
 *    2名の予約から1回で2人ぶんを開けるようにするため。
 * 🚨 会員番号以外の個人情報はURLにもDBにも入れない方針。
 */
export const scholaUrl = (memberNos: string | string[]): string => {
  const list = (Array.isArray(memberNos) ? memberNos : [memberNos])
    .map(s => s.trim()).filter(Boolean);
  return 'https://buscatch.net/sc/admin/five-m/course_children'
    + `?keyword=${encodeURIComponent(list.join('　'))}&limit=50`;
};

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

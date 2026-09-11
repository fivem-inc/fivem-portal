// 残業・時間管理の種別定義（本人ページ・管理タブで共通利用）。
// GCal側のタイトル・色・同期可否は supabase/functions/gcal-sync/index.ts の OVERTIME_TYPES と対応。
// ラベルや種別を追加・変更する場合は両方を合わせて更新すること。
export type OvertimeType =
  | 'overtime' | 'early_start' | 'tardiness' | 'early_leave'
  | 'holiday_work' | 'location_change' | 'late_start_adj' | 'early_end_adj'
  | 'chosei_off' | 'furikae_off' | 'absence'
  | 'clock_only';

export const OT_TYPE_INFO: Record<OvertimeType, { label: string; color: string; darkBg: string }> = {
  overtime:        { label: '残業',       color: '#1565c0', darkBg: '#1e3a5f' },
  early_start:     { label: '早出',       color: '#0891b2', darkBg: '#123a42' },
  tardiness:       { label: '遅刻',       color: '#7b1fa2', darkBg: '#3a1f4d' },
  early_leave:     { label: '早退',       color: '#e65100', darkBg: '#4a2c0a' },
  holiday_work:    { label: '休日出勤',   color: '#0f766e', darkBg: '#123a35' },
  location_change: { label: '勤務地変更', color: '#6d28d9', darkBg: '#2e1a5c' },
  late_start_adj:  { label: '調整遅出',   color: '#2e7d32', darkBg: '#1b3a1e' },
  early_end_adj:   { label: '調整早退',   color: '#7d3c98', darkBg: '#3a1f4d' },
  // 終日種別（単独付与のみ・時刻入力なし）。欠勤の赤はエラー赤(#dc3545)と区別するためやや暗め
  chosei_off:      { label: '時間外調整休', color: '#d4537e', darkBg: '#4b1528' },
  furikae_off:     { label: '振替休日',   color: '#3f51b5', darkBg: '#1f2a5c' },
  absence:         { label: '欠勤',       color: '#b23b3b', darkBg: '#4a1515' },
  // 打刻ズレ（打刻が遅れただけ・残業なし）。差分0の記録で、合計時間数には影響しない。
  // 灰色にしているのは「何も増減していない」ことを一目で分かるようにするため。
  clock_only:      { label: '打刻ズレ',   color: '#5a6b7d', darkBg: '#2c3540' },
};

// 「残業ではありません（打刻が遅れただけ）」の理由。本人の記録画面と、経理の確認への回答画面で共用する。
// 🚨 ここに業務（片付け・準備・保護者対応・引き継ぎなど）を並べてはいけない。
//    それらは会社の指示でやる仕事＝残業であり、「残業ではない」と記録させると
//    サービス残業を本人に認めさせた記録になる。並べてよいのは本人の都合だけ。
//    「着替え」も制服着用が義務だと労働時間と判断されうるため出さない。
export const CLOCK_ONLY_REASONS = [
  '打刻を忘れた（あとで押した）',
  '同僚と話していた',
  '私用で残っていた（休憩・電話・迎え待ちなど）',
  'その他',
];

/** 終日種別（時刻入力なし・segments を持たない） */
export const FULL_DAY_TYPES: OvertimeType[] = ['chosei_off', 'furikae_off', 'absence'];

export function isOvertimeType(t: string): t is OvertimeType {
  return t in OT_TYPE_INFO;
}

export function isFullDayReport(types: string[] | null | undefined): boolean {
  return (types ?? []).some(t => (FULL_DAY_TYPES as string[]).includes(t));
}

// ============================================================
//  カレンダー掲載の判定
// ============================================================
// 🚨 同じ表が supabase/functions/gcal-sync/index.ts の OVERTIME_TYPES にもある（2箇所管理）。
//    Deno 側からこのファイルを import できないため。片方だけ直すと
//    「アプリでは載る予定なのに Google カレンダーには出ない」という食い違いになる。
//
//  syncable     … そもそもカレンダーに出せる種別か（打刻ズレは記録だけなので出せない）
//  defaultShare … 本人が何も選ばなかったとき（show_on_calendar が null）に載せるか
//                 遅刻・早退だけ false。これまでカレンダーに出していなかったため、
//                 チェック欄を使わない人の見え方を変えないようにしている。
//  priority     … 複数の種別が付いているときに、どれを代表として出すか（小さいほど優先）。
//                 gcal-sync 側の priority と同じ並びにしてある。
export const OT_CALENDAR: Record<OvertimeType, { syncable: boolean; defaultShare: boolean; priority: number }> = {
  holiday_work:    { syncable: true,  defaultShare: true,  priority: 1 },
  overtime:        { syncable: true,  defaultShare: true,  priority: 2 },
  early_start:     { syncable: true,  defaultShare: true,  priority: 3 },
  late_start_adj:  { syncable: true,  defaultShare: true,  priority: 4 },
  early_end_adj:   { syncable: true,  defaultShare: true,  priority: 5 },
  location_change: { syncable: true,  defaultShare: true,  priority: 6 },
  // 事前に分かっている遅刻・早退も**既定で載せる**（2026-09-11 ユーザー確定）。
  // 🚨 以前は「既定では載せない（本人が選んだときだけ）」だったが、選べるのはマネージャー・社長だけで、
  //    **それ以外の役職（リーダー・フロア責任者・一般・パート）は本人がどう操作しても載らなかった**。
  //    「選べない人は全部載る」という本来の意図（OvertimePage の canChooseCalendar）と食い違っていた。
  //    「その時間帯にいない」予定なので、お休みや遅出(調整)と同じく周りが知るべき情報として扱う。
  //    事後報告（実際に遅れた記録）は canOfferCalendarChoice / willShowOnCalendar の条件で今までどおり載らない。
  // 🚨 gcal-sync の OVERTIME_TYPES と**必ず同時に**直すこと（2か所管理。片方だけだと
  //    「画面では載ると出るのに実際は載らない」になる）
  tardiness:       { syncable: true,  defaultShare: true,  priority: 7 },
  early_leave:     { syncable: true,  defaultShare: true,  priority: 8 },
  // 終日種別は「その日いない」情報なので、選ばせずに必ず載せる
  chosei_off:      { syncable: true,  defaultShare: true,  priority: 9 },
  furikae_off:     { syncable: true,  defaultShare: true,  priority: 10 },
  absence:         { syncable: true,  defaultShare: true,  priority: 11 },
  // 打刻ズレは残業ではなく記録だけ。カレンダーには出さない
  clock_only:      { syncable: false, defaultShare: false, priority: 12 },
};

// ============================================================
//  勤怠カレンダー（アプリ内 /calendar）での分類
// ============================================================
// 「休暇・欠勤」「遅刻・早退」「残業・休日出勤」の3つに分ける。
// 🚨 申請した場所（休暇ページ／残業ページ）では分けない。
//    残業ページから申請される調整休・振替休日は中身が休みなので、
//    場所で分けると「残業」側に入ってしまい、見る人が混乱する。
// グループ名は抽象語（休み・遅れ 等）ではなく、中に入っている代表的な種別名にしてある。
// 探しているものの名前でボタンを押せるようにするため（2026-08-21 ユーザー判断）。
export type CalendarCategory = 'leave' | 'late' | 'work';

const OT_WORK: OvertimeType[] = ['overtime', 'early_start', 'holiday_work', 'location_change'];
const OT_LEAVE: OvertimeType[] = ['chosei_off', 'furikae_off', 'absence'];

/** カレンダーに出す種別だけを、代表が先頭に来る順で返す */
export function calendarTypesInOrder(types: string[] | null | undefined): OvertimeType[] {
  return (types ?? [])
    .filter((t): t is OvertimeType => isOvertimeType(t) && OT_CALENDAR[t].syncable)
    .sort((a, b) => OT_CALENDAR[a].priority - OT_CALENDAR[b].priority);
}

/**
 * その残業がカレンダーのどのグループに入るか。
 * 🚨 代表種別（表示の色に使うもの）で判定する。
 *    別の基準で判定すると「青い帯なのに遅刻・早退のボタンで消える」ことになる。
 */
export function overtimeCalendarCategory(types: string[] | null | undefined): CalendarCategory {
  const primary = calendarTypesInOrder(types)[0];
  if (!primary) return 'late';
  if (OT_WORK.includes(primary)) return 'work';
  if (OT_LEAVE.includes(primary)) return 'leave';
  return 'late'; // 遅刻・早退（事前に分かっているもの）
}

/**
 * カレンダー掲載のチェック欄を出してよいか。
 * 出しても実際には載らない組み合わせでチェック欄を出すと、
 * 「チェックしたのに載らない・エラーも出ない」という気づけない不一致になる。
 */
export function canOfferCalendarChoice(
  types: string[] | null | undefined,
  isPostHoc: boolean,
): boolean {
  const list = types ?? [];
  if (list.length === 0) return false;
  if (isPostHoc) return false;              // 事後報告は載せない（もう終わったことなので）
  if (isFullDayReport(list)) return false;  // お休みは選ばせず必ず載せる
  return list.some(t => isOvertimeType(t) && OT_CALENDAR[t].syncable);
}

/** show_on_calendar が未指定（null）のときに載せるかどうか */
export function defaultShowOnCalendar(types: string[] | null | undefined): boolean {
  return (types ?? []).some(t => isOvertimeType(t) && OT_CALENDAR[t].defaultShare);
}

/** その報告が結局カレンダーに載るのか（表示用。実際の同期判定は gcal-sync 側） */
export function willShowOnCalendar(
  types: string[] | null | undefined,
  isPostHoc: boolean,
  showOnCalendar: boolean | null | undefined,
): boolean {
  const list = types ?? [];
  if (list.length === 0) return false;
  if (!list.some(t => isOvertimeType(t) && OT_CALENDAR[t].syncable)) return false;
  if (isFullDayReport(list)) return true;   // お休みは常に載る（事後報告でも）
  if (isPostHoc) return false;
  return showOnCalendar ?? defaultShowOnCalendar(list);
}

// ============================================================
//  Googleカレンダーに載るタイトルの組み立て
// ============================================================
// 🚨🚨 同じ組み立てが supabase/functions/gcal-sync/index.ts にもある（2箇所管理）。
//    Deno 側からこのファイルを import できないため。片方だけ直すと
//    「画面の見本と、実際にカレンダーに載る文字が違う」ことになる。
//    直すときは必ず両方を見ること（gcal-sync 側の summary の組み立て）。
//
// 画面でこれを出す理由：どの項目がカレンダーに載るのか（時刻は開始か終了か両方か、校は付くか）は
// 種別ごとに違い、説明文で書くと長くなる。実物を1行見せるのがいちばん短い（2026-09-09 ユーザー確定）。

/** 分 → "HH:MM"（1440以上は翌日表記）。gcal-sync の otMinToTime と同じ */
function gcalTimeLabel(min: number): string {
  const m = ((min % 1440) + 1440) % 1440;
  const hh = String(Math.floor(m / 60)).padStart(2, '0');
  const mm = String(m % 60).padStart(2, '0');
  return min >= 1440 ? `翌${hh}:${mm}` : `${hh}:${mm}`;
}

// 🚨 カレンダー側のラベルは画面のラベル（OT_TYPE_INFO）と一部違う。
//    画面「調整遅出」→カレンダー「遅出(調整)」、「時間外調整休」→「調整休」、
//    「振替休日」→「振休」、「欠勤」→「休み」。gcal-sync の OVERTIME_TYPES.label と一致させること。
const GCAL_LABEL: Partial<Record<OvertimeType, string>> = {
  late_start_adj: '遅出(調整)', early_end_adj: '早退(調整)',
  chosei_off: '調整休', furikae_off: '振休', absence: '休み',
};
const gcalLabelOf = (t: OvertimeType): string => GCAL_LABEL[t] ?? OT_TYPE_INFO[t].label;

export interface GcalSummaryInput {
  /** 表示名（全角スペースは半角に直す。gcal-sync 側と同じ） */
  name: string;
  types: string[];
  /** 勤務時間帯の最初の開始・最後の終了（分）。終日種別・時刻なしのときは null */
  firstStartMin: number | null;
  lastEndMin: number | null;
  location: string | null;
  /** 未受理（申請中）か。受理されると先頭の【申請中】が消える */
  isPending: boolean;
}

/**
 * カレンダーに載るタイトル。載らない組み合わせのときは null を返す
 * （載らないのに見本を出すと「載る」と誤解させるため）。
 */
export function buildGcalSummary(input: GcalSummaryInput): string | null {
  const syncTypes = calendarTypesInOrder(input.types);
  if (syncTypes.length === 0) return null;
  const primary = syncTypes[0];
  const label = syncTypes.slice(0, 2).map(gcalLabelOf).join('＋');

  let timeStr = '';
  if (input.firstStartMin != null && input.lastEndMin != null) {
    if (syncTypes.length >= 2 || primary === 'holiday_work') {
      timeStr = `${gcalTimeLabel(input.firstStartMin)}〜${gcalTimeLabel(input.lastEndMin)}`;
    } else if (primary === 'overtime' || primary === 'early_end_adj' || primary === 'early_leave') {
      // 終わりの時刻が大事なもの
      timeStr = `〜${gcalTimeLabel(input.lastEndMin)}`;
    } else if (primary === 'early_start' || primary === 'late_start_adj' || primary === 'tardiness') {
      // 始まりの時刻が大事なもの
      timeStr = `${gcalTimeLabel(input.firstStartMin)}〜`;
    }
  }

  let summary = `${input.isPending ? '【申請中】' : ''}${input.name.replace(/　/g, ' ')}｜${label}`;
  if (timeStr && primary !== 'location_change') summary += `｜${timeStr}`;
  if (input.location) summary += `［${input.location}］`;
  return summary;
}

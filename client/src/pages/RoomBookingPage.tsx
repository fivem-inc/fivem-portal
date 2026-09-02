import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import type { AuthUser } from '../types';
import { supabase } from '../lib/supabaseClient';
import { useDarkMode } from '../hooks/useDarkMode';
import TimeInput from '../components/TimeInput';
import {
  purposeColor, setPurposeRegistry, activePurposes, purposeOrder, PURPOSE_PALETTE,
  VIEW_START_HOUR, VIEW_END_HOUR, DURATION_PRESETS,
  todayStr, toDate, hhmm, minutesOf, addMinutes, formatDateLabel, shiftDate,
  scholaUrl, floorBusyNow, nextStart, usingUntil, assignColumns, categoryLabel,
  isWeekend, RANGE_DAYS, localDate, placeLabel, openSlotColor, durationLabel, FALLBACK_DURATIONS, gradeOrAge, defaultMinutesOf,
  isAbsence, cancelledLabel,
  customerName, customerFullName, customerKana, contactLines, toHiragana,
  fiscalYear, fiscalYearEnd, fiscalYearLabel, RENEWAL_NOTICE_DAYS, daysUntil, detailsOf, purposeWithDetail,
  participantsOf, participantLabelOf, attendanceOptionsFor, needsPaymentNote, customerSearchFilter, customerMatches,
  type Campus, type Floor, type Booking, type ConflictInfo,
  type Staff, type LessonCategory, type Recurrence, type PurposeDuration, type PurposeDetail,
  type AttendanceOption, type AttendanceRow, type Participant,
  type Customer, type CustomerContact, type Waitlist, type RoomPurpose,
} from '../lib/roomBooking';
import {
  readTable, guessMapping, buildCustomers, parseBirthDate, FIELD_LABEL, REQUIRED_FIELDS,
  type CustomerField,
} from '../lib/customerImport';
import { downloadCSV } from '../utils';
import {
  guessBookingMapping, splitPasted, buildBookings, BOOKING_FIELD_LABEL,
  BOOKING_REQUIRED, BULK_MAX_ROWS, parseScheduleLines, type BookingField,
} from '../lib/bookingBulk';

// 場所（フロア）の予約表。
//
// 予約の単位は「部屋」ではなく「フロア」（2026-08-28 ユーザー確定）。
//   四条本校のみ 3階/5階、他4校は「全体」1つ。各フロア 同時3件まで。
//   占有(exclusive)の予約がある時間は、上限に関係なく他の予約を入れさせない。
//
// 🚨 二重予約の最終判定は必ずサーバー（room_create_booking / room_update_booking）で行う。
//    画面のチェックは「入力中に気づかせる」ためのもので、2人同時保存は防げない。
//
// 🚨 スマホでは横並びのタイムラインが破綻する（1列50px以下で文字が読めない）ため、
//    幅が狭いときは「いまの空き状況」＋1フロアの縦リストに切り替える。

interface Props {
  user: AuthUser;
  roleTitle: string;
  isAdmin: boolean;
  /**
   * 雇用形態。useAuth が返す「プレビュー込み」の値。
   * 🚨 自分で profiles を読み直さないこと。役職プレビュー（👁️ 確認）で
   *    パートに切り替えても実際の値のままになり、**プレビューが効かない**。
   *    2026-08-31 に実際そうなっていた（パートで見てもスタッフ設定が触れた）。
   */
  employmentType: string;
}

const PX_PER_MIN = 1.1;                       // タイムラインの縦の縮尺
const VIEW_TOP_MIN = VIEW_START_HOUR * 60;
const VIEW_MIN = (VIEW_END_HOUR - VIEW_START_HOUR) * 60;
const CAMPUS_KEY = 'room_booking_last_campus';   // 前回見ていた校を覚えておく
const VIEW_KEY   = 'room_booking_last_view';     // 前回見ていた並べ方（場所別／担当別／参加者別）
const ALL_CAMPUS = '__all__';                    // 校タブの「全校」

/**
 * 何を軸に並べるか。
 *  place       = 場所（フロア）別。既定。1日のタイムライン。
 *  staff       = 担当スタッフ別。「この先生はいつ・どこに入っているか」を見る用。
 *  participant = 参加者別。会員番号＋お客様の表示名で、
 *                「この生徒さんはいつレッスンを受けているか」を見る用（2026-08-28 ユーザー確定）。
 *
 * 🚨 participant は「予約したスタッフ(booker_name)」ではない。
 *    予約者別で作りかけたが、見たいのは受ける側だったので入れ替えた。
 */
type ViewMode = 'place' | 'staff' | 'participant';
const VIEW_LABEL: Record<ViewMode, string> = { place: '場所別', staff: '担当別', participant: '参加者別' };

/**
 * 参加者をひとまとめにするキー。
 * 会員番号があればそれで束ねる（表示名の揺れ「田中様」「田中さま」で別人扱いにならない）。
 * 会員番号が無いものは表示名で束ね、どちらも無ければ「参加者なし」。
 */
const participantKey = (b: Booking): string =>
  b.member_no ? `no:${b.member_no}` : (b.customer_label ? `name:${b.customer_label}` : '__none__');

/** 参加者キー → 画面に出す文字列 */
const participantLabel = (b: Booking): string => {
  if (!b.member_no && !b.customer_label) return '参加者なし';
  return [b.customer_label, b.member_no ? `#${b.member_no}` : ''].filter(Boolean).join(' ');
};

/**
 * 出欠を1人ぶん記録する（付け直しは上書き、同じものをもう一度押すと取り消し）。
 *
 * 🚨 詳細画面とまとめて画面の**両方から呼ぶので、ここ1か所にまとめる**。
 *    同じ意味の処理を2か所に書くと、片方だけ直す事故になる。
 * 🚨 `counted_present` は**押した時点の設定を写して**保存する。
 *    あとで選択肢の「出席扱い」を変えても、過去の記録の意味が変わらないようにするため。
 * 戻り値は画面に出すエラー文（空なら成功）。
 */
const saveAttendanceRow = async (
  bookingId: string, p: Participant, opt: AttendanceOption | null,
): Promise<string> => {
  const { data: me } = await supabase.auth.getUser();
  if (opt === null) {
    // 取り消し。🚨 delete は0件でもエラーにならないので、消えた件数を数える
    const { data, error } = await supabase.from('room_booking_attendance')
      .delete()
      .eq('booking_id', bookingId)
      .eq('participant_no', p.no)
      .eq('participant_name', p.name)
      .select('id');
    if (error) return '取り消せませんでした。通信を確認してもう一度お試しください。';
    if (!data || data.length === 0) return '';   // もともと付いていない。何もしないでよい
    return '';
  }
  const { error } = await supabase.from('room_booking_attendance').upsert({
    booking_id: bookingId,
    participant_no: p.no,
    participant_name: p.name,
    status: opt.name,
    counted_present: opt.counts_present,
    recorded_at: new Date().toISOString(),
    recorded_by: me.user?.id ?? null,
  }, { onConflict: 'booking_id,participant_no,participant_name' });
  if (error) return '出欠を保存できませんでした。通信を確認してもう一度お試しください。';
  return '';
};

/**
 * 支払いの覚書だけを書き換える（出欠はすでに付いている前提）。
 * 🚨 出欠の行が無いときは何もしない。先に出欠を選んでもらう
 *    （空の記録だけができると、集計で「出欠なしの支払い」が出て意味が分からなくなる）。
 * 戻り値は画面に出すエラー文（空なら成功）。
 */
const savePaymentNote = async (
  bookingId: string, p: Participant, note: string,
): Promise<string> => {
  const { data, error } = await supabase.from('room_booking_attendance')
    .update({ payment_note: note.trim() || null })
    .eq('booking_id', bookingId)
    .eq('participant_no', p.no)
    .eq('participant_name', p.name)
    .select('id');
  // 🚨 update は0件でもエラーにならない。書けた件数で判断する
  if (error) return '支払いを保存できませんでした。通信を確認してもう一度お試しください。';
  if (!data || data.length === 0) return '先に出欠を選んでください。';
  return '';
};

/** タイムラインの1列。場所別なら1フロア、担当別なら1スタッフ。 */
interface Lane {
  key: string;
  title: string;
  note: string;          // 見出しの下の小さい文字（同時◯件まで／担当区分など）
  capacity: number | null;  // 場所別のときだけ意味がある。担当別・参加者別は null
  floorId: string | null;   // 空き枠を押して予約を作れるのは場所別のときだけ
}

type FormMode = { kind: 'create'; floorId: string; date: string; startTime: string }
              | { kind: 'edit'; booking: Booking };

const RoomBookingPage: React.FC<Props> = ({ user, roleTitle, isAdmin: admin, employmentType }) => {
  const isDark = useDarkMode();
  const [campuses, setCampuses] = useState<Campus[]>([]);
  const [floors, setFloors] = useState<Floor[]>([]);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [categories, setCategories] = useState<LessonCategory[]>([]);
  // 用途ごとの長さの選択肢（社員が基本設定から変えられる）
  const [purposeDurations, setPurposeDurations] = useState<PurposeDuration[]>(FALLBACK_DURATIONS);
  // 用途ごとの詳細（パーソナルの「体操」「筋トレ」など。社員が基本設定から足せる）。
  // 🚨 既定は空。読めなかったときに勝手な選択肢を出すより、出さないほうが安全
  const [purposeDetails, setPurposeDetails] = useState<PurposeDetail[]>([]);
  // 出欠の選択肢（社員が基本設定から足せる）。読めなければボタンを出さない
  const [attendanceOptions, setAttendanceOptions] = useState<AttendanceOption[]>([]);
  // いま見えている予約ぶんの出欠。付いていない予約は行が無い
  const [attendance, setAttendance] = useState<AttendanceRow[]>([]);
  // まとめて出欠を付ける画面を開いているか
  const [attendanceOpen, setAttendanceOpen] = useState(false);
  // キャンセル待ちの一覧（予約表の上のボタンから開く・2026-09-02 ユーザー承認）。
  // 🚨 基本設定の中だけだと開くまで見えないので、いつでも開ける入口を表に出す
  const [waitlistOpen, setWaitlistOpen] = useState(false);
  const [waitingCount, setWaitingCount] = useState(0);
  const [campusId, setCampusId] = useState<string>('');
  const [view, setView] = useState<ViewMode>('place');
  // 担当別・参加者別の絞り込み。'' = 全員。それ以外は staff.id または参加者キー
  const [only, setOnly] = useState<string>('');
  const [date, setDate] = useState<string>(todayStr());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [form, setForm] = useState<FormMode | null>(null);
  const [detail, setDetail] = useState<Booking | null>(null);
  const [settings, setSettings] = useState(false);
  // 「このお客様で予約を入れる」流れ（お客様一覧の『予約する』から入る）。
  // 🚨 一覧の時点では場所も時間も決まっていないので、ここでは覚えておくだけ。
  //    空き枠を選んだときに、会員番号とお名前を入れた状態でフォームを開く
  const [bookingFor, setBookingFor] = useState<Customer | null>(null);
  // 基本設定を使える役職（管理者が ⚙️設定 で決める）。
  // null = まだ読めていない／設定が無い → これまでどおり「パート以外は可」で動かす
  const [basicRoles, setBasicRoles] = useState<string[] | null>(null);
  // 年度更新は「社員まで」（パートは不可・2026-08-29 ユーザー確定）。
  // ⚙️設定（マスタ管理＝管理者）とは別の入口にする。仕事の性質が違うため
  const [renewal, setRenewal] = useState(false);
  // 年度末が近いときだけ「まだ引き継いでいない件数」を数えて案内を出す
  const [renewPending, setRenewPending] = useState(0);
  const [now, setNow] = useState(new Date());
  const [narrow, setNarrow] = useState(() => window.innerWidth < 760);
  const [mobileFloorId, setMobileFloorId] = useState<string>('');
  const [flash, setFlash] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrolledOnce = useRef(false);

  // ---- 配色（既存アプリのカード色に合わせる） ----
  const bg      = isDark ? '#1a1a2e' : '#f5f6f8';
  const card    = isDark ? '#2d2d3e' : '#ffffff';
  const line    = isDark ? '#3a3a5c' : '#e0e0e0';
  const lineSoft= isDark ? '#35354e' : '#eef0f3';
  const text    = isDark ? '#eeeeee' : '#222222';
  const textMid = isDark ? '#b3b8c6' : '#5b6270';
  const textSoft= isDark ? '#8b90a3' : '#8a90a0';
  const accent  = isDark ? '#6bbd92' : '#2f6f4f';
  const accentBg= isDark ? '#263b33' : '#e8f2ec';
  const nowColor= isDark ? '#ff6b6b' : '#d33b3b';
  const offHours= isDark ? '#26263a' : '#f7f8fa';   // 基準営業時間の外

  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < 760);
    window.addEventListener('resize', onResize);
    const t = setInterval(() => setNow(new Date()), 60000);
    return () => { window.removeEventListener('resize', onResize); clearInterval(t); };
  }, []);

  // ---- マスタ（校・場所・スタッフ・区分）の読み込み ----
  const loadMasters = useCallback(async () => {
    const [cRes, fRes, sRes, catRes, scRes, durRes, setRes, detRes, attRes, purRes] = await Promise.all([
      supabase.from('room_campuses').select('*').eq('active', true).order('sort_order'),
      supabase.from('room_floors').select('*').eq('active', true).order('sort_order'),
      supabase.from('room_staff').select('*').order('sort_order'),
      supabase.from('room_lesson_categories').select('*').order('sort_order'),
      supabase.from('room_staff_categories').select('*'),
      supabase.from('room_purpose_durations').select('*'),
      supabase.from('room_settings').select('value').eq('key', 'basic_settings_roles').maybeSingle(),
      supabase.from('room_purpose_details').select('*').order('sort_order'),
      supabase.from('room_attendance_options').select('*').order('sort_order'),
      supabase.from('room_purposes').select('*').order('sort_order'),
    ]);
    // 用途（2026-09-02〜 DBで持つ）。読めないときは既定の5つで動く（activePurposes が面倒を見る）
    setPurposeRegistry((purRes.data ?? []) as RoomPurpose[]);
    // 設定が読めないとき（まだ作っていない等）は null のままにして、
    // これまでどおり「パート以外は使える」で動かす。急に誰も使えなくならないように
    setBasicRoles(setRes.data?.value
      ? setRes.data.value.split(',').map((s: string) => s.trim()).filter(Boolean)
      : null);
    if (cRes.error || fRes.error) {
      setLoadError('場所の情報を読み込めませんでした。時間をおいて開き直してください。');
      return null;
    }
    // 長さの選択肢。読めなかったときだけ既定値で動かす（フォームが開けなくなるのを避ける）
    setPurposeDurations(durRes.data && durRes.data.length
      ? (durRes.data as PurposeDuration[])
      : FALLBACK_DURATIONS);
    // 詳細。読めなくてもエラーにしない（詳細が出ないだけで、予約はできる）
    setPurposeDetails((detRes.data ?? []) as PurposeDetail[]);
    // 出欠の選択肢。読めなくてもエラーにしない（出欠が付けられないだけ）
    setAttendanceOptions((attRes.data ?? []) as AttendanceOption[]);
    const cs = (cRes.data ?? []) as Campus[];
    setCampuses(cs);
    setFloors((fRes.data ?? []) as Floor[]);
    setCategories((catRes.data ?? []) as LessonCategory[]);
    // スタッフと担当区分を突き合わせる（別テーブルなのでここで1つにまとめる）
    const links = (scRes.data ?? []) as { staff_id: string; category_id: string }[];
    setStaff(((sRes.data ?? []) as Staff[]).map(s => ({
      ...s, categoryIds: links.filter(l => l.staff_id === s.id).map(l => l.category_id),
    })));
    return cs;
  }, []);

  /**
   * いま並んでいるキャンセル待ちの人数（予約表の上のボタンに出す）。
   * 数だけなので head で数え、行は読まない。
   */
  const loadWaitingCount = useCallback(async (): Promise<void> => {
    const { count } = await supabase.from('room_waitlist')
      .select('id', { count: 'exact', head: true }).eq('status', 'waiting');
    setWaitingCount(count ?? 0);
  }, []);

  useEffect(() => { loadWaitingCount(); }, [loadWaitingCount]);

  /**
   * 年度末が近いとき、まだ次の年度へ引き継いでいない繰り返しが何件あるかを数える。
   *
   * 引き継ぎ済みかどうかは「次の年度の行が renewed_from で自分を指しているか」で決まる。
   * 数えるだけなら SQL でも書けるが、件数は多くても数十なので2年度ぶんを読んで
   * 画面側で突き合わせる。関数を増やさないぶん、あとで読む人に分かりやすい。
   */
  const loadRenewPending = useCallback(async (): Promise<void> => {
    const today = todayStr();
    const fy = fiscalYear(today);
    if (daysUntil(today, fiscalYearEnd(fy)) > RENEWAL_NOTICE_DAYS) { setRenewPending(0); return; }
    const { data, error } = await supabase
      .from('room_recurrences')
      .select('id, fiscal_year, renewed_from')
      .in('fiscal_year', [fy, fy + 1])
      .eq('active', true);
    if (error || !data) { setRenewPending(0); return; }
    const rows = data as { id: string; fiscal_year: number; renewed_from: string | null }[];
    const done = new Set(rows.filter(r => r.fiscal_year === fy + 1 && r.renewed_from)
      .map(r => r.renewed_from as string));
    setRenewPending(rows.filter(r => r.fiscal_year === fy && !done.has(r.id)).length);
  }, []);

  useEffect(() => {
    (async () => {
      const cs = await loadMasters();
      if (cs) {
        // 前回見ていた校と並べ方を復元（無ければ先頭・場所別）
        let savedCampus = '', savedView = '';
        try {
          savedCampus = localStorage.getItem(CAMPUS_KEY) ?? '';
          savedView = localStorage.getItem(VIEW_KEY) ?? '';
        } catch { /* ignore */ }
        setCampusId(savedCampus === ALL_CAMPUS || cs.some(c => c.id === savedCampus)
          ? savedCampus : (cs[0]?.id ?? ''));
        // 🚨 'booker'（旧・予約者別）を保存している端末があるので、その場合は既定に戻す。
        //    知らない値をそのまま setView すると、どの表示にも当てはまらず空画面になる
        if (savedView === 'place' || savedView === 'staff' || savedView === 'participant') setView(savedView);
      }
      setLoading(false);
    })();
  }, [loadMasters]);

  // 基本設定を開けるか。
  //   ・パートは常に不可
  //   ・管理者は設定に関わらず常に可（自分を締め出せないようにする）
  //   ・それ以外は、管理者が決めた役職の一覧に自分の役職が入っていれば可
  //
  // 🚨 employmentType / roleTitle を自分で読み直さないこと。useAuth が返す
  //    「プレビュー込み」の値を使う。自前で読むと役職プレビュー（👁️ 確認）が
  //    効かず、パートに切り替えてもボタンが出たままになる（2026-08-31 実機で発覚）。
  // 🚨 これは画面に出すかどうかだけの話。実際に書けるかどうかは
  //    データベース側（room_can_use_basic_settings）でも同じ設定を見ている。
  // 🚨 出欠を書けるのは「パートでない人」。DB側の room_is_staff() と同じ条件にする。
  //    ここを緩めると、押せるのに保存できないボタンになる。
  //    基本設定（canRenew）と違い、役職の一覧（basicRoles）では絞らない
  const canAttendance = admin || (employmentType !== '' && employmentType !== 'パート');

  const canRenew = admin
    || (employmentType !== '' && employmentType !== 'パート'
        && (basicRoles === null || basicRoles.includes(roleTitle)));

  useEffect(() => {
    if (canRenew) loadRenewPending();
  }, [canRenew, loadRenewPending]);

  const allCampus = campusId === ALL_CAMPUS;
  const campus = useMemo(() => campuses.find(c => c.id === campusId) ?? null, [campuses, campusId]);
  const campusName = useCallback(
    (id: string) => campuses.find(c => c.id === id)?.name ?? '',
    [campuses]);

  // 全校のときは校の並び順 → 場所の並び順で通しに並べる
  const visibleFloors = useMemo(() => {
    const order = new Map(campuses.map((c, i) => [c.id, i]));
    return floors
      .filter(f => allCampus || f.campus_id === campusId)
      .sort((a, b) => (order.get(a.campus_id) ?? 0) - (order.get(b.campus_id) ?? 0) || a.sort_order - b.sort_order);
  }, [floors, campusId, allCampus, campuses]);

  useEffect(() => {
    if (visibleFloors.length && !visibleFloors.some(f => f.id === mobileFloorId)) {
      setMobileFloorId(visibleFloors[0].id);
    }
  }, [visibleFloors, mobileFloorId]);

  // ---- 予約を読み込む ----
  //   場所別 … その1日だけ（タイムラインは1日を描く）
  //   担当別・参加者別 … 起点日から1ヶ月ぶん（誰がいつ入っているかを見る用）
  const rangeDays = view === 'place' ? 1 : RANGE_DAYS;
  const loadBookings = useCallback(async () => {
    if (!visibleFloors.length) { setBookings([]); return; }
    const from = new Date(`${date}T00:00:00`);
    const to = new Date(from.getTime() + rangeDays * 86400000);
    const { data, error } = await supabase
      .from('room_bookings')
      .select('*')
      .in('floor_id', visibleFloors.map(f => f.id))
      .is('deleted_at', null)
      .gte('starts_at', from.toISOString())
      .lt('starts_at', to.toISOString())
      .order('starts_at');
    if (error) { setLoadError('予約を読み込めませんでした。'); return; }
    setLoadError('');
    const rows = (data ?? []) as Booking[];
    setBookings(rows);

    // 予約表に「田中 たろう」と出すため、いま見えている予約のお客様だけ読む。
    // 🚨 全件を読まない。人数が増えたときに毎回重くなる
    // 🚨 **参加者ごとに分けてから引く**。2名の予約は member_no が
    //    「2023030565, 2023051425」とカンマでつながっており、そのまま渡すと
    //    どのお客様にも一致せず、**名前が漢字のまま出ていた**（2026-09-01 実機で発覚）。
    //    名前は生年月日から学年を見て「太田 かりん」と作り分けているので、
    //    引けないとその作り分けごと効かなくなる。
    const nos = [...new Set(
      rows.flatMap(b => participantsOf(b).map(p => p.no)).filter(Boolean),
    )];
    if (nos.length === 0) return;
    const { data: cs } = await supabase
      .from('room_customers').select('*').in('member_no', nos);
    const map = Object.fromEntries(((cs ?? []) as Customer[]).map(c => [c.member_no, c]));
    // 予約に表示名を持たせておく。カードを描く場所が何か所もあるので、
    // それぞれで引き直すより、ここで1回だけ付けるほうが読みやすい
    setBookings(rows.map(b => {
      // 🚨 学年は年度で変わるので「今日」ではなく **その予約の日** を基準にする。
      //    今日を基準にすると、来年度の予約に今年度の学年が出る
      const on = localDate(b.starts_at);
      const ps = participantsOf(b);
      if (ps.length <= 1) {
        const c = ps[0]?.no ? map[ps[0].no] : null;
        return {
          ...b,
          customer_name: c ? customerName(c, on) : '',
          customer_grade: c ? gradeOrAge(c.birth_date, on) : '',
        };
      }
      // 🚨 2名以上は学年が人によって違うので、**名前のすぐ後ろ**に付けて1つにまとめる。
      //    学年だけ別に出すと、どちらの学年か分からなくなる
      const names = ps.map(p => {
        const c = p.no ? map[p.no] : null;
        const nm = c ? customerName(c, on) : p.name;
        const g = c?.birth_date ? gradeOrAge(c.birth_date, on) : '';
        return g ? `${nm}（${g}）` : nm;
      }).filter(Boolean);
      return { ...b, customer_name: names.join('、'), customer_grade: '' };
    }));
  }, [date, visibleFloors, rangeDays]);

  useEffect(() => { loadBookings(); }, [loadBookings]);

  /**
   * いま見えている予約ぶんの出欠を読む。
   * 🚨 全件を読まない（予約が増えると毎回重くなる）。
   * 🚨 予約が0件のときは問い合わせない。`in()` に空の配列を渡すと全件になる作りの
   *    ライブラリがあるため、条件が空になる呼び出しは最初から避ける。
   */
  const loadAttendance = useCallback(async (ids: string[]) => {
    if (ids.length === 0) { setAttendance([]); return; }
    const { data, error } = await supabase
      .from('room_booking_attendance').select('*').in('booking_id', ids);
    if (error) return;                       // 出欠が出ないだけ。予約表は動かす
    setAttendance((data ?? []) as AttendanceRow[]);
  }, []);

  useEffect(() => { loadAttendance(bookings.map(b => b.id)); },
    [bookings, loadAttendance]);

  const selectCampus = (id: string) => {
    setCampusId(id);
    try { localStorage.setItem(CAMPUS_KEY, id); } catch { /* ignore */ }
  };
  const selectView = (v: ViewMode) => {
    setView(v);
    try { localStorage.setItem(VIEW_KEY, v); } catch { /* ignore */ }
  };

  // ---- 「今」の位置まで自動スクロール（今日を見ているときだけ・最初の1回） ----
  const isToday = date === todayStr();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const nowTop = (nowMin - VIEW_TOP_MIN) * PX_PER_MIN;
  useEffect(() => {
    if (scrolledOnce.current || narrow || !isToday || loading || !scrollRef.current) return;
    if (nowMin < VIEW_TOP_MIN || nowMin > VIEW_END_HOUR * 60) return;
    scrollRef.current.scrollTop = Math.max(0, nowTop - 120);
    scrolledOnce.current = true;
  }, [narrow, isToday, loading, nowMin, nowTop]);

  const showFlash = (msg: string) => { setFlash(msg); setTimeout(() => setFlash(''), 4000); };

  // 🚨 休講(cancelled)も画面には残す。消してしまうと「空いた」と勘違いして
  //    別の予約が入る。空き判定の側（floorBusyNow など）が status を見て除外している。
  const freeFloors = useMemo(
    () => isToday ? visibleFloors.filter(f => !floorBusyNow(f, bookings, now)) : [],
    [isToday, visibleFloors, bookings, now]);

  /**
   * タイムラインの列を組み立てる。
   * 場所別 … その校（または全校）の場所を並べる。
   * 担当別 … その日に予約が入っているスタッフだけを並べる。
   *          🚨 全スタッフ16人を常に並べると1列が細くなって読めないため、
   *             予約のある人に絞る（誰も入っていない日は空表示）。
   * 参加者別 … 同じ考え方で、会員番号で束ねた参加者を並べる。
   */
  const lanes: Lane[] = useMemo(() => {
    if (view === 'place') {
      return visibleFloors.map(f => {
        // 校内に場所が1つだけなら「全体」は書かない（全校表示のときは校名だけになる）
        const siblings = floors.filter(x => x.campus_id === f.campus_id).length;
        return {
          key: f.id,
          title: placeLabel(f, campusName(f.campus_id), siblings, allCampus),
          note: `同時${f.capacity}件まで`,
          capacity: f.capacity,
          floorId: f.id,
        };
      });
    }
    if (view === 'staff') {
      const used = new Set(bookings.map(b => b.staff_id).filter(Boolean) as string[]);
      const lanesOut: Lane[] = staff
        .filter(s => used.has(s.id))
        .sort((a, b) => a.sort_order - b.sort_order)
        .map(s => ({
          key: s.id,
          title: s.name,
          note: categoryLabel(s, categories) || '担当区分なし',
          capacity: null,
          floorId: null,
        }));
      // 担当が決まっていない予約も落とさずに見せる（見落とし防止）
      if (bookings.some(b => !b.staff_id)) {
        lanesOut.push({ key: '__none__', title: '担当なし', note: '担当が入っていない予約', capacity: null, floorId: null });
      }
      return lanesOut;
    }
    // 参加者別。会員番号で束ね、同じ人の予約が1列にまとまるようにする
    const seen = new Map<string, string>();
    for (const b of bookings) {
      const k = participantKey(b);
      if (!seen.has(k)) seen.set(k, participantLabel(b));
    }
    return Array.from(seen.entries())
      .sort((a, b) => a[1].localeCompare(b[1], 'ja'))
      .map(([k, label]) => ({ key: k, title: label, note: '参加者', capacity: null, floorId: null }));
  }, [view, visibleFloors, floors, allCampus, campusName, bookings, staff, categories]);

  /** ある列に入る予約を選ぶ */
  const laneBookings = useCallback((lane: Lane) => {
    if (view === 'place')  return bookings.filter(b => b.floor_id === lane.key);
    if (view === 'staff')  return bookings.filter(b => (b.staff_id ?? '__none__') === lane.key);
    return bookings.filter(b => participantKey(b) === lane.key);
  }, [view, bookings]);

  const staffById = useCallback((id: string | null) => staff.find(s => s.id === id) ?? null, [staff]);
  /**
   * 場所の名前。その校に場所が1つしかなければ「全体」は書かず校名だけにする。
   * 例：西陣校（1つだけ）→「西陣校」／四条本校（3つ）→「四条本校 3階」
   */
  const placeName = useCallback((floorId: string, withCampus: boolean) => {
    const f = floors.find(x => x.id === floorId);
    if (!f) return '';
    const siblings = floors.filter(x => x.campus_id === f.campus_id).length;
    return placeLabel(f, campusName(f.campus_id), siblings, withCampus);
  }, [floors, campusName]);

  /**
   * 担当別・参加者別の絞り込みの選択肢。
   * その期間に予約がある人だけを出す（16人全員を常に出すと、実際にはいない人まで並ぶ）。
   */
  const onlyOptions = useMemo(() => {
    if (view === 'staff') {
      const used = new Set(bookings.map(b => b.staff_id).filter(Boolean) as string[]);
      const opts = staff.filter(s => used.has(s.id))
        .sort((a, b) => a.sort_order - b.sort_order)
        .map(s => ({ value: s.id, label: `${s.name}（${categoryLabel(s, categories) || '区分なし'}）` }));
      if (bookings.some(b => !b.staff_id)) opts.push({ value: '__none__', label: '担当なし' });
      return opts;
    }
    if (view === 'participant') {
      const seen = new Map<string, string>();
      for (const b of bookings) {
        const k = participantKey(b);
        if (!seen.has(k)) seen.set(k, participantLabel(b));
      }
      return Array.from(seen.entries())
        .sort((a, b) => a[1].localeCompare(b[1], 'ja'))
        .map(([value, label]) => ({ value, label }));
    }
    return [];
  }, [view, bookings, staff, categories]);

  // 絞り込みで選んでいた人がいなくなったら「全員」に戻す（空表示のまま固まるのを防ぐ）
  useEffect(() => {
    if (only && !onlyOptions.some(o => o.value === only)) setOnly('');
  }, [only, onlyOptions]);

  /**
   * 担当別・参加者別の1ヶ月一覧。日付ごとにまとめて並べる。
   * 予約が1件も無い日は行ごと出さない（1ヶ月ぶんの空行でスクロールが埋まるため）。
   */
  const rangeList = useMemo(() => {
    if (view === 'place') return [];
    const keyOf = (b: Booking) => view === 'staff' ? (b.staff_id ?? '__none__') : participantKey(b);
    const target = only ? bookings.filter(b => keyOf(b) === only) : bookings;
    const byDate = new Map<string, Booking[]>();
    for (const b of target) {
      const d = localDate(b.starts_at);
      const arr = byDate.get(d);
      if (arr) arr.push(b); else byDate.set(d, [b]);
    }
    return Array.from(byDate.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([d, list]) => ({ date: d, list: list.sort((a, b) => a.starts_at.localeCompare(b.starts_at)) }));
  }, [view, only, bookings]);

  // ---------------- 見た目の部品 ----------------
  const btn = (on: boolean, color = accent): React.CSSProperties => ({
    padding: '6px 13px', borderRadius: 999, fontSize: 13, cursor: 'pointer',
    border: `1px solid ${on ? color : line}`,
    background: on ? color : (isDark ? '#35354e' : '#f0f2f5'),
    color: on ? (isDark ? '#1d2a24' : '#fff') : textMid,
    fontWeight: on ? 700 : 400, whiteSpace: 'nowrap', flexShrink: 0,
  });

  if (loading) return <div style={{ padding: 40, textAlign: 'center', color: textMid }}>読み込んでいます...</div>;

  return (
    <div style={{ background: bg, minHeight: '100vh', color: text, padding: narrow ? '12px 10px 60px' : '18px 20px 60px' }}>
      <div style={{ maxWidth: 1200, margin: '0 auto' }}>

        <h1 style={{ fontSize: narrow ? 19 : 22, fontWeight: 700, margin: '0 0 12px' }}>🚪 場所の予約</h1>

        {loadError && (
          <div style={{ background: isDark ? '#4a2a2a' : '#fdecea', border: `1px solid ${isDark ? '#7a4444' : '#f5c6cb'}`, color: isDark ? '#ffb4b4' : '#a3282a', borderRadius: 10, padding: '10px 14px', marginBottom: 12, fontSize: 14 }}>
            {loadError}
          </div>
        )}
        {flash && (
          <div style={{ background: accentBg, border: `1px solid ${accent}`, color: accent, borderRadius: 10, padding: '10px 14px', marginBottom: 12, fontSize: 14, fontWeight: 700 }}>
            {flash}
          </div>
        )}

        {/* 年度末が近いときの案内（社員まで表示）。
            自動では増やさないので、ここで気づいてもらえないと4月以降が空のままになる。
            🚨 パートには出さない。押せないのに催促されることになるため */}
        {canRenew && renewPending > 0 && (
          <div style={{ background: isDark ? '#4a4326' : '#fff8e1', border: `1px solid ${isDark ? '#8a7a3a' : '#ffe082'}`, color: isDark ? '#ffe6a3' : '#7a5c00', borderRadius: 10, padding: '10px 14px', marginBottom: 12, fontSize: 14, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ lineHeight: 1.6 }}>
              4月以降の繰り返し予約はまだ入っていません。
              <strong>{renewPending}件</strong>を{fiscalYear(todayStr()) + 1}年度に引き継げます
            </span>
            <button onClick={() => setRenewal(true)}
              style={{ ...btn(false), marginLeft: 'auto' }}>年度更新へ</button>
          </div>
        )}

        {/* このお客様で予約を入れる最中の案内。
            🚨 やめる手段を必ず添える。抜け方が分からないと、別の予約まで
               このお客様の名前で入ってしまう */}
        {bookingFor && (
          <div style={{ background: accentBg, border: `1px solid ${accent}`, color: accent, borderRadius: 10, padding: '10px 14px', marginBottom: 12, fontSize: 14, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ lineHeight: 1.6 }}>
              <strong>{customerName(bookingFor, date)}</strong> さんの予約を入れます。
              空いている枠を選んでください
            </span>
            <button onClick={() => setBookingFor(null)}
              style={{ ...btn(false), marginLeft: 'auto' }}>やめる</button>
          </div>
        )}

        {/* 校のタブ。先頭に「全校」を置き、そこから校を絞れるようにする */}
        <div style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 8, marginBottom: 8 }}>
          <button onClick={() => selectCampus(ALL_CAMPUS)} style={btn(allCampus)}>全校</button>
          <span style={{ width: 1, background: line, flexShrink: 0, margin: '2px 3px' }} />
          {campuses.map(c => (
            <button key={c.id} onClick={() => selectCampus(c.id)} style={btn(c.id === campusId)}>{c.name}</button>
          ))}
        </div>

        {/* 並べ方の切替 */}
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12.5, color: textMid }}>並べ方</span>
          {(['place', 'staff', 'participant'] as ViewMode[]).map(v => (
            <button key={v} onClick={() => selectView(v)} style={btn(view === v)}>{VIEW_LABEL[v]}</button>
          ))}
          {/* 🚨 絵文字を付けない。🗓 は Windows の Chrome で □ に化けた（2026-08-31 実機確認）。
                 「文字で意味が通るなら絵文字を足さない」という既存の方針どおりにする */}
          {/* 出欠をまとめて付ける（2026-09-01 ユーザー指示）。
              🚨 出すのは「いま見ている日」の予約。担当別・参加者別は1ヶ月を描くが、
                 出欠は起点の日だけを出す（画面の中でも同じことを断っている） */}
          <button onClick={() => setAttendanceOpen(true)}
            style={{ ...btn(false), marginLeft: 'auto' }}>出欠</button>
          {/* キャンセル待ちの一覧（2026-09-02 ユーザー承認）。
              🚨 人数はボタンに直接出す。0名でも入口は出す（登録の説明が中にあるため） */}
          <button onClick={() => setWaitlistOpen(true)} style={btn(false)}>
            キャンセル待ち{waitingCount > 0 ? ` ${waitingCount}名` : ''}
          </button>
          {canRenew && (
            <button onClick={() => setRenewal(true)} style={btn(false)}>基本設定</button>
          )}
          {admin && (
            <button onClick={() => setSettings(true)} style={btn(false)}>⚙️ 設定</button>
          )}
        </div>

        {/* 日付の移動。
            場所別は「その日」、担当別・参加者別は「ここから1ヶ月」の起点になる。
            起点は過去の日付にも変えられる（ユーザー指示） */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
          <button onClick={() => setDate(todayStr())} style={btn(isToday)}>今日</button>
          <button onClick={() => setDate(shiftDate(date, view === 'place' ? -1 : -7))}
            style={{ ...btn(false), padding: '6px 11px' }} aria-label={view === 'place' ? '前の日' : '1週間前'}>◀</button>
          <span style={{ fontSize: 16, fontWeight: 700, minWidth: view === 'place' ? 92 : 150, textAlign: 'center' }}>
            {view === 'place'
              ? formatDateLabel(date)
              : `${formatDateLabel(date)} から1ヶ月`}
          </span>
          <button onClick={() => setDate(shiftDate(date, view === 'place' ? 1 : 7))}
            style={{ ...btn(false), padding: '6px 11px' }} aria-label={view === 'place' ? '次の日' : '1週間後'}>▶</button>
          <input type="date" value={date} onChange={e => e.target.value && setDate(e.target.value)}
            style={{ padding: '6px 9px', borderRadius: 8, border: `1px solid ${line}`, background: card, color: text, fontSize: 16 }} />
          {view !== 'place' && (
            <span style={{ fontSize: 12, color: textSoft }}>
              〜{formatDateLabel(shiftDate(date, RANGE_DAYS - 1))}
            </span>
          )}
        </div>

        {/* 担当別・参加者別の絞り込み（全員 or 1人） */}
        {view !== 'place' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12.5, color: textMid }}>
              {view === 'staff' ? '担当スタッフ' : '参加者'}
            </span>
            <select value={only} onChange={e => setOnly(e.target.value)}
              style={{ padding: '6px 9px', borderRadius: 8, border: `1px solid ${line}`, background: card, color: text, fontSize: 16, maxWidth: 300 }}>
              <option value="">全員（{onlyOptions.length}人）</option>
              {onlyOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            {only && (
              <button onClick={() => setOnly('')} style={btn(false)}>全員に戻す</button>
            )}
          </div>
        )}

        {/* いま空いている場所（今日・場所別のときだけ。担当別では意味が変わるので出さない） */}
        {isToday && view === 'place' && (
          <div style={{ background: accentBg, color: accent, borderRadius: 8, padding: '7px 12px', marginBottom: 12, fontSize: 13, fontWeight: 500 }}>
            {freeFloors.length
              ? `いま空いています：${freeFloors.map(f => placeName(f.id, allCampus)).join('・')}`
              : 'いま空いている場所はありません'}
          </div>
        )}

        {/* 場所別＝1日のタイムライン（PCは横並び・スマホは縦リスト）
            担当別／参加者別＝1ヶ月ぶんを日付ごとにまとめたリスト（PC・スマホ共通） */}
        {view !== 'place'
          ? <RangeList
              groups={rangeList} view={view} only={only}
              staffById={staffById} categories={categories}
              placeName={placeName} allCampus={allCampus}
              onOpenDetail={setDetail}
              colors={{ card, line, lineSoft, text, textMid, textSoft }}
              isDark={isDark} />
          : narrow
          ? <MobileView
              lanes={lanes} laneBookings={laneBookings} floors={visibleFloors} bookings={bookings}
              now={now} isToday={isToday} view={view}
              selectedId={mobileFloorId} onSelect={setMobileFloorId}
              staffById={staffById} categories={categories}
              placeName={placeName} allCampus={allCampus}
              onOpenDetail={setDetail}
              onCreate={(floorId, startTime) => setForm({ kind: 'create', floorId, date, startTime })}
              colors={{ card, line, lineSoft, text, textMid, textSoft, accent, accentBg }}
              isDark={isDark} btn={btn} />
          : <TimelineView
              scrollRef={scrollRef} lanes={lanes} laneBookings={laneBookings}
              campus={allCampus ? null : campus} isToday={isToday} nowTop={nowTop} nowColor={nowColor} offHours={offHours}
              view={view} placeName={placeName} allCampus={allCampus}
              onOpenDetail={setDetail}
              onCreate={(floorId, startTime) => setForm({ kind: 'create', floorId, date, startTime })}
              colors={{ card, line, lineSoft, text, textMid, textSoft }}
              isDark={isDark} />
        }

        <p style={{ fontSize: 12, color: textSoft, marginTop: 14, lineHeight: 1.7 }}>
          {view === 'place'
            ? '空いているところを押すと予約できます。同じ時間に入れられる件数は場所ごとに決まっています（各場所の名前の下に出ています）。「貸切」で取ると、その時間は他の予約を入れられなくなります。'
            : `${formatDateLabel(date)} から1ヶ月ぶんを${VIEW_LABEL[view]}で出しています。日付を変えると、過去にさかのぼって見ることもできます。新しく予約を入れるときは「場所別」に切り替えてください。`}
          {view === 'place' && campus && ` 基準の営業時間：${campus.open_time.slice(0, 5)}〜${campus.close_time.slice(0, 5)}（この時間外でも予約できます）`}
        </p>
      </div>

      {form && (
        <BookingForm
          mode={form} user={user} floors={floors} campuses={campuses} bookingFor={bookingFor}
          staff={staff} categories={categories} purposeDurations={purposeDurations}
          purposeDetails={purposeDetails}
          onClose={() => setForm(null)}
          onSaved={(msg) => { setForm(null); loadBookings(); showFlash(msg); }}
          isDark={isDark} />
      )}
      {detail && (
        <BookingDetail
          booking={detail} floors={floors} campuses={campuses}
          staff={staff} categories={categories}
          attendanceOptions={attendanceOptions} attendance={attendance}
          canAttendance={canAttendance}
          onAttendanceSaved={() => loadAttendance(bookings.map(b => b.id))}
          onClose={() => {
            setDetail(null);
            // 🚨 詳細の中で出欠→空き枠化ができるようになったので、閉じたら予約表も読み直す
            loadBookings(); loadWaitingCount();
          }}
          onEdit={(b) => { setDetail(null); setForm({ kind: 'edit', booking: b }); }}
          onChanged={(msg) => { setDetail(null); loadBookings(); loadWaitingCount(); showFlash(msg); }}
          isDark={isDark} />
      )}
      {waitlistOpen && (
        <Overlay onClose={() => setWaitlistOpen(false)} isDark={isDark} title="キャンセル待ち" wide>
          <WaitlistSettings floors={floors} campuses={campuses} staff={staff} isDark={isDark}
            onDone={async (msg) => {
              // 繰り上げで予約ができるので、予約表と人数も読み直す
              await loadBookings(); await loadWaitingCount(); showFlash(msg);
            }} />
        </Overlay>
      )}
      {attendanceOpen && (
        <AttendancePanel
          date={date} floorIds={visibleFloors.map(f => f.id)}
          floors={floors} campuses={campuses} staff={staff}
          options={attendanceOptions}
          canWrite={canAttendance}
          onSaved={() => loadAttendance(bookings.map(b => b.id))}
          onClose={() => {
            setAttendanceOpen(false);
            // 🚨 まとめて付ける画面でも空き枠化ができるので、閉じたら予約表を読み直す
            loadBookings(); loadWaitingCount();
          }} isDark={isDark} />
      )}
      {renewal && (
        <BasicSettingsPanel
          campuses={campuses} floors={floors} staff={staff} categories={categories}
          purposeDurations={purposeDurations} purposeDetails={purposeDetails}
          attendanceOptions={attendanceOptions} user={user}
          onBook={(c) => {
            // 基本設定を閉じて予約表に戻し、場所別（＝新規を入れられる並べ方）にする
            setBookingFor(c);
            setRenewal(false);
            selectView('place');
          }}
          onClose={() => setRenewal(false)}
          onDone={async (msg) => {
            await loadMasters(); await loadBookings(); await loadRenewPending(); showFlash(msg);
          }}
          isDark={isDark} />
      )}
      {settings && (
        <SettingsPanel
          campuses={campuses} floors={floors} categories={categories}
          attendanceOptions={attendanceOptions}
          onClose={() => setSettings(false)}
          onChanged={async (msg) => { await loadMasters(); await loadBookings(); showFlash(msg); }}
          isDark={isDark} />
      )}
    </div>
  );
};

// ============================================================
// パソコン向け：縦＝時間、横＝フロアのタイムライン
// ============================================================
const TimelineView: React.FC<{
  scrollRef: React.RefObject<HTMLDivElement | null>;
  lanes: Lane[]; laneBookings: (lane: Lane) => Booking[]; campus: Campus | null;
  isToday: boolean; nowTop: number; nowColor: string; offHours: string;
  view: ViewMode; placeName: (floorId: string, withCampus: boolean) => string; allCampus: boolean;
  onOpenDetail: (b: Booking) => void;
  onCreate: (floorId: string, startTime: string) => void;
  colors: { card: string; line: string; lineSoft: string; text: string; textMid: string; textSoft: string };
  isDark: boolean;
}> = ({ scrollRef, lanes, laneBookings, campus, isToday, nowTop, nowColor, offHours,
        view, placeName, allCampus, onOpenDetail, onCreate, colors, isDark }) => {
  const { card, line, lineSoft, text, textMid, textSoft } = colors;
  const hours = Array.from({ length: VIEW_END_HOUR - VIEW_START_HOUR }, (_, i) => VIEW_START_HOUR + i);
  // 全校表示のときは校ごとに営業時間が違うので、薄いグレーの帯は出さない
  const openMin = campus ? minutesOf(campus.open_time.slice(0, 5)) : 0;
  const closeMin = campus ? minutesOf(campus.close_time.slice(0, 5)) : 24 * 60;

  if (!lanes.length) {
    return <div style={{ background: card, border: `1px solid ${line}`, borderRadius: 12, padding: 30, textAlign: 'center', color: textMid }}>
      {view === 'place' ? 'この校には場所が登録されていません。' : 'この日にはまだ予約がありません。'}
    </div>;
  }

  // 列が多いほど1列は細くなるので、横スクロールできる最小幅を確保する
  const minColWidth = lanes.length > 4 ? 118 : 130;

  return (
    <div style={{ background: card, border: `1px solid ${line}`, borderRadius: 12, overflow: 'hidden' }}>
      {/* 見出し */}
      <div style={{ display: 'grid', gridTemplateColumns: `54px repeat(${lanes.length}, minmax(${minColWidth}px, 1fr))`, borderBottom: `1px solid ${line}`, overflowX: 'hidden', minWidth: 54 + lanes.length * minColWidth }}>
        <div />
        {lanes.map(l => (
          <div key={l.key} style={{ padding: '9px 6px', textAlign: 'center', fontWeight: 700, fontSize: 13, color: text, borderLeft: `1px solid ${lineSoft}` }}>
            {l.title}
            <span style={{ display: 'block', fontSize: 10.5, fontWeight: 400, color: textSoft }}>{l.note}</span>
          </div>
        ))}
      </div>

      {/* 本体 */}
      <div ref={scrollRef} style={{ maxHeight: '62vh', overflowY: 'auto', overflowX: 'auto' }}>
        <div style={{ display: 'grid', gridTemplateColumns: `54px repeat(${lanes.length}, minmax(${minColWidth}px, 1fr))`, position: 'relative', minWidth: 54 + lanes.length * minColWidth }}>

          {/* 時刻の目盛り */}
          <div style={{ position: 'relative', height: VIEW_MIN * PX_PER_MIN }}>
            {hours.map(h => (
              <div key={h} style={{ position: 'absolute', top: (h * 60 - VIEW_TOP_MIN) * PX_PER_MIN, right: 6, fontSize: 11, color: textSoft, fontVariantNumeric: 'tabular-nums', transform: 'translateY(-6px)' }}>
                {h}:00
              </div>
            ))}
          </div>

          {/* 列ごと */}
          {lanes.map(l => {
            const list = laneBookings(l);
            const cols = assignColumns(list);
            return (
              <div key={l.key} style={{ position: 'relative', height: VIEW_MIN * PX_PER_MIN, borderLeft: `1px solid ${lineSoft}` }}>
                {/* 基準営業時間の外を薄く塗る（1つの校を見ているときだけ） */}
                {openMin > VIEW_TOP_MIN && (
                  <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: (openMin - VIEW_TOP_MIN) * PX_PER_MIN, background: offHours, pointerEvents: 'none' }} />
                )}
                {closeMin < VIEW_END_HOUR * 60 && (
                  <div style={{ position: 'absolute', top: (closeMin - VIEW_TOP_MIN) * PX_PER_MIN, left: 0, right: 0, bottom: 0, background: offHours, pointerEvents: 'none' }} />
                )}

                {/* 30分ごとの押せるマス。
                    🚨 場所別のときだけ押せる。担当別・参加者別では「どの場所に入れるか」が
                       決まらないため、押せる見た目にしない（押せるのに何も起きない状態を作らない） */}
                {hours.flatMap(h => [0, 30].map(m => {
                  const t = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
                  const cellStyle: React.CSSProperties = {
                    position: 'absolute', top: (h * 60 + m - VIEW_TOP_MIN) * PX_PER_MIN, left: 0, right: 0,
                    height: 30 * PX_PER_MIN, borderTop: `1px solid ${m === 0 ? line : lineSoft}`,
                    background: 'transparent', padding: 0,
                  };
                  return l.floorId
                    ? <button key={t} onClick={() => onCreate(l.floorId!, t)} aria-label={`${l.title} ${t} に予約する`}
                        style={{ ...cellStyle, border: 'none', cursor: 'pointer' }} />
                    : <div key={t} style={cellStyle} />;
                }))}

                {/* 予約のブロック */}
                {list.map(b => {
                  const s = new Date(b.starts_at), e = new Date(b.ends_at);
                  const top = (s.getHours() * 60 + s.getMinutes() - VIEW_TOP_MIN) * PX_PER_MIN;
                  const height = Math.max(((e.getTime() - s.getTime()) / 60000) * PX_PER_MIN, 18);
                  // 休講は薄いグレーで残す（消すと「空いた」と誤解されて二重に埋まるため）
                  const off = b.status === 'cancelled';
                  // 募集中の枠は、予約と紛れないよう別色＋破線で描く（色だけで区別させない）
                  const open = b.kind === 'open' && !off;
                  const [pf, pb] = open ? openSlotColor(isDark) : purposeColor(b.purpose, isDark);
                  const fg = off ? textSoft : pf;
                  const bgc = off ? (isDark ? '#33334a' : '#f0f1f4') : pb;
                  const c = cols[b.id] ?? { col: 0, cols: 1 };
                  const w = 100 / c.cols;
                  const restSeats = Math.max(0, b.seats - b.filled);
                  return (
                    <button key={b.id} onClick={() => onOpenDetail(b)}
                      style={{
                        position: 'absolute', top, height,
                        left: `calc(${c.col * w}% + 2px)`, width: `calc(${w}% - 4px)`,
                        background: bgc, color: fg,
                        border: open ? `1.5px dashed ${fg}` : 'none',
                        borderLeft: open ? `1.5px dashed ${fg}` : `3px solid ${off ? textSoft : (b.exclusive ? nowColor : fg)}`,
                        borderRadius: 5, padding: '2px 5px', textAlign: 'left', cursor: 'pointer',
                        overflow: 'hidden', fontSize: 11, lineHeight: 1.35,
                        opacity: off ? .75 : 1,
                      }}>
                      <b style={{ display: 'block', fontSize: 11, fontVariantNumeric: 'tabular-nums', textDecoration: off ? 'line-through' : 'none' }}>
                        {open && '🟡'}{b.exclusive && !off && !open && '🔒'}{b.is_fixed && '【固定】'}{hhmm(b.starts_at)}-{hhmm(b.ends_at)}
                      </b>
                      {/* 担当別・参加者別では「どこの場所か」が分からないと使えないので場所を出す */}
                      <span style={{ fontSize: 10.5, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {off ? cancelledLabel(b)
                          : open ? `募集中${b.seats > 1 ? `（あと${restSeats}名）` : ''}`
                          : view === 'place' ? `${purposeWithDetail(b)}${(b.customer_name || b.customer_label) ? ` / ${b.customer_name || b.customer_label}` : ''}`
                          : `${placeName(b.floor_id, allCampus)} / ${purposeWithDetail(b)}`}
                      </span>
                    </button>
                  );
                })}
              </div>
            );
          })}

          {/* いまの時刻の線 */}
          {isToday && nowTop >= 0 && nowTop <= VIEW_MIN * PX_PER_MIN && (
            <div style={{ position: 'absolute', top: nowTop, left: 54, right: 0, height: 2, background: nowColor, pointerEvents: 'none', zIndex: 5 }}>
              <span style={{ position: 'absolute', left: -50, top: -8, fontSize: 10, fontWeight: 700, color: nowColor, fontVariantNumeric: 'tabular-nums' }}>
                {String(new Date().getHours()).padStart(2, '0')}:{String(new Date().getMinutes()).padStart(2, '0')}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* 用途の凡例 */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', padding: '8px 12px', borderTop: `1px solid ${line}`, fontSize: 11.5, color: textMid }}>
        {activePurposes().map(p => {
          const [fg] = purposeColor(p, isDark);
          return <span key={p} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: fg }} />{p}
          </span>;
        })}
        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, border: `1.5px dashed ${openSlotColor(isDark)[0]}` }} />
          🟡 募集中（申込を受けられる枠）
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>🔒 貸切（他の予約を入れられません）</span>
      </div>
    </div>
  );
};

// ============================================================
// 担当別・参加者別：起点日から1ヶ月ぶんを日付ごとに並べる
//
// 🚨 タイムライン（横並び）にしない理由：
//    1ヶ月×16人を格子で描くとマスが小さすぎて中身が読めない。
//    「この先生がいつ・どこに入っているか」を追うのが目的なので、
//    日付見出し＋その日の予約、という素直な縦リストが一番速く読める。
// 予約が1件も無い日は行ごと出さない（空行でスクロールが埋まるため）。
// ============================================================
const RangeList: React.FC<{
  groups: { date: string; list: Booking[] }[];
  view: ViewMode; only: string;
  staffById: (id: string | null) => Staff | null; categories: LessonCategory[];
  placeName: (floorId: string, withCampus: boolean) => string; allCampus: boolean;
  onOpenDetail: (b: Booking) => void;
  colors: { card: string; line: string; lineSoft: string; text: string; textMid: string; textSoft: string };
  isDark: boolean;
}> = ({ groups, view, only, staffById, categories, placeName, allCampus, onOpenDetail, colors, isDark }) => {
  const { card, line, lineSoft, text, textMid, textSoft } = colors;
  const today = todayStr();
  const total = groups.reduce((n, g) => n + g.list.length, 0);

  if (!groups.length) {
    return <div style={{ background: card, border: `1px solid ${line}`, borderRadius: 12, padding: 30, textAlign: 'center', color: textMid }}>
      この期間に{only ? '、選んだ人の' : ''}予約はありません。
    </div>;
  }

  return (
    <div style={{ background: card, border: `1px solid ${line}`, borderRadius: 12, overflow: 'hidden' }}>
      <div style={{ padding: '8px 14px', fontSize: 12.5, color: textMid, borderBottom: `1px solid ${lineSoft}` }}>
        {groups.length}日ぶん・{total}件
      </div>

      {groups.map(g => {
        const wk = isWeekend(g.date);
        const past = g.date < today;
        return (
          <div key={g.date}>
            {/* 日付の見出し。土日は色を変え、過去の日は薄くする */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '7px 14px', borderTop: `1px solid ${line}`,
              background: isDark ? '#26263a' : '#f5f6f8',
              color: wk === 0 ? (isDark ? '#ff9b9b' : '#c0392b')
                   : wk === 6 ? (isDark ? '#8ab4e8' : '#3b6fb5')
                   : text,
              opacity: past ? .7 : 1,
              fontSize: 13.5, fontWeight: 700,
            }}>
              {formatDateLabel(g.date)}
              {g.date === today && (
                <span style={{ fontSize: 11, fontWeight: 700, color: isDark ? '#6bbd92' : '#2f6f4f' }}>今日</span>
              )}
              {past && <span style={{ fontSize: 11, fontWeight: 400, color: textSoft }}>（過去）</span>}
              <span style={{ marginLeft: 'auto', fontSize: 11.5, fontWeight: 400, color: textSoft }}>{g.list.length}件</span>
            </div>

            {g.list.map(b => {
              const off = b.status === 'cancelled';
              const open = b.kind === 'open' && !off;
              const [pf, pb] = open ? openSlotColor(isDark) : purposeColor(b.purpose, isDark);
              const fg = off ? textSoft : pf;
              const bgc = off ? (isDark ? '#33334a' : '#f0f1f4') : pb;
              const st = staffById(b.staff_id);
              const where = placeName(b.floor_id, allCampus);
              const rest = Math.max(0, b.seats - b.filled);
              return (
                <button key={b.id} onClick={() => onOpenDetail(b)}
                  style={{
                    display: 'flex', alignItems: 'flex-start', gap: 10, width: '100%', textAlign: 'left',
                    background: 'transparent', border: 'none', borderTop: `1px solid ${lineSoft}`,
                    padding: '10px 14px', cursor: 'pointer', color: off ? textSoft : text,
                    opacity: past ? .75 : 1,
                  }}>
                  <span style={{
                    fontWeight: 700, fontSize: 13.5, fontVariantNumeric: 'tabular-nums',
                    minWidth: 96, flexShrink: 0, textDecoration: off ? 'line-through' : 'none',
                  }}>
                    {open && '🟡'}{b.exclusive && !off && !open && '🔒'}{b.is_fixed && '【固定】'}{hhmm(b.starts_at)}〜{hhmm(b.ends_at)}
                  </span>
                  <span style={{
                    background: bgc, color: fg, borderRadius: 999, padding: '1px 9px',
                    fontSize: 11, fontWeight: 700, flexShrink: 0,
                    border: open ? `1px dashed ${fg}` : 'none',
                  }}>
                    {off ? cancelledLabel(b) : open ? `募集中${b.seats > 1 ? ` あと${rest}名` : ''}` : purposeWithDetail(b)}
                  </span>
                  {/* 場所／（絞っていなければ）並べている軸の本人／もう一方の軸。
                      1人に絞っているときは、その人の名前を毎行くり返さない */}
                  <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: textMid, lineHeight: 1.55 }}>
                    {[
                      where,
                      ...(view === 'staff'
                        ? [only ? '' : (st ? st.name : '担当なし'), open ? purposeWithDetail(b) : participantLabel(b)]
                        : [only ? '' : participantLabel(b),
                           st ? `${st.name}（${categoryLabel(st, categories) || '区分なし'}）` : '担当なし']),
                    ].filter(Boolean).join('／')}
                  </span>
                </button>
              );
            })}
          </div>
        );
      })}
    </div>
  );
};

// ============================================================
// スマホ向け：いまの空き状況＋1フロアの縦リスト
// ============================================================
const MobileView: React.FC<{
  lanes: Lane[]; laneBookings: (lane: Lane) => Booking[];
  floors: Floor[]; bookings: Booking[]; now: Date; isToday: boolean; view: ViewMode;
  selectedId: string; onSelect: (id: string) => void;
  staffById: (id: string | null) => Staff | null; categories: LessonCategory[];
  placeName: (floorId: string, withCampus: boolean) => string; allCampus: boolean;
  onOpenDetail: (b: Booking) => void;
  onCreate: (floorId: string, startTime: string) => void;
  colors: { card: string; line: string; lineSoft: string; text: string; textMid: string; textSoft: string; accent: string; accentBg: string };
  isDark: boolean;
  btn: (on: boolean, color?: string) => React.CSSProperties;
}> = ({ lanes, laneBookings, floors, bookings, now, isToday, view, selectedId, onSelect,
        staffById, categories, placeName, allCampus, onOpenDetail, onCreate, colors, isDark, btn }) => {
  const { card, line, lineSoft, text, textMid, textSoft } = colors;

  // 場所別のときは従来どおり「選んだ場所の1日」。
  // 担当別・参加者別は列（＝スタッフ／参加者）を選んでその1日を出す。
  const selectedLane = lanes.find(l => l.key === selectedId) ?? lanes[0] ?? null;
  const list = (selectedLane ? laneBookings(selectedLane) : [])
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at));

  const whereOf = (b: Booking) => {
    const f = floors.find(x => x.id === b.floor_id);
    if (!f) return '';
    return placeName(f.id, allCampus);
  };

  return (
    <>
      {/* いまの空き状況（今日・場所別のときだけ。スマホで一番見たいのはこれ） */}
      {isToday && view === 'place' && (
        <div style={{ background: card, border: `1px solid ${line}`, borderRadius: 12, marginBottom: 12, overflow: 'hidden' }}>
          <div style={{ padding: '8px 12px', fontSize: 12.5, fontWeight: 700, color: textMid, borderBottom: `1px solid ${lineSoft}` }}>
            いまの空き状況
          </div>
          {floors.map(f => {
            const busy = floorBusyNow(f, bookings, now);
            const until = usingUntil(f.id, bookings, now);
            const next = nextStart(f.id, bookings, now);
            return (
              <div key={f.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: '10px 12px', borderTop: `1px solid ${lineSoft}` }}>
                <span style={{ fontWeight: 700, fontSize: 14 }}>
                  {placeName(f.id, allCampus)}
                  <span style={{ display: 'block', fontSize: 10.5, fontWeight: 400, color: textSoft }}>同時{f.capacity}件まで</span>
                </span>
                <span style={{ fontSize: 12.5, color: busy ? (isDark ? '#ff9b9b' : '#c0392b') : (isDark ? '#7fd0a4' : '#2f8a5f'), fontWeight: 700, textAlign: 'right' }}>
                  {busy
                    ? `使用中${until ? `（〜${until}）` : ''}`
                    : `空き${next ? `（次は ${next} から）` : ''}`}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* 見るものの切替（場所／スタッフ／参加者） */}
      <div style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 8, marginBottom: 8 }}>
        {lanes.map(l => (
          <button key={l.key} onClick={() => onSelect(l.key)} style={btn(l.key === selectedLane?.key)}>{l.title}</button>
        ))}
      </div>

      {/* 選んだものの1日 */}
      <div style={{ background: card, border: `1px solid ${line}`, borderRadius: 12, overflow: 'hidden' }}>
        {selectedLane && view === 'staff' && (
          <div style={{ padding: '8px 12px', fontSize: 12, color: textMid, borderBottom: `1px solid ${lineSoft}` }}>
            担当できる区分：{selectedLane.note}
          </div>
        )}
        {list.length === 0 && (
          <div style={{ padding: 24, textAlign: 'center', color: textSoft, fontSize: 13.5 }}>この日の予約はまだありません</div>
        )}
        {list.map(b => {
          const off = b.status === 'cancelled';
          const open = b.kind === 'open' && !off;
          const [pf, pb] = open ? openSlotColor(isDark) : purposeColor(b.purpose, isDark);
          const fg = off ? textSoft : pf;
          const bgc = off ? (isDark ? '#33334a' : '#f0f1f4') : pb;
          const st = staffById(b.staff_id);
          const rest = Math.max(0, b.seats - b.filled);
          return (
            <button key={b.id} onClick={() => onOpenDetail(b)}
              style={{ display: 'block', width: '100%', textAlign: 'left', background: 'transparent', border: 'none', borderTop: `1px solid ${lineSoft}`, padding: '11px 12px', cursor: 'pointer', color: off ? textSoft : text }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 700, fontSize: 14, fontVariantNumeric: 'tabular-nums', textDecoration: off ? 'line-through' : 'none' }}>
                  {open && '🟡'}{b.exclusive && !off && !open && '🔒'}{b.is_fixed && '【固定】'}{hhmm(b.starts_at)}〜{hhmm(b.ends_at)}
                </span>
                <span style={{
                  background: bgc, color: fg, borderRadius: 999, padding: '1px 9px', fontSize: 11, fontWeight: 700,
                  border: open ? `1px dashed ${fg}` : 'none',
                }}>
                  {off ? cancelledLabel(b) : open ? `募集中${b.seats > 1 ? ` あと${rest}名` : ''}` : purposeWithDetail(b)}
                </span>
              </div>
              <div style={{ fontSize: 12.5, color: textMid, marginTop: 3 }}>
                {[
                  view !== 'place' ? whereOf(b) : '',
                  open ? purposeWithDetail(b) : '',
                  st ? `${st.name}（${categoryLabel(st, categories) || '区分なし'}）` : '',
                  open ? '' : (b.customer_name || b.customer_label || (b.member_no ? `#${b.member_no}` : '')),
                ].filter(Boolean).join('／') || b.booker_name}
              </div>
            </button>
          );
        })}
        {selectedLane?.floorId && (
          <button onClick={() => onCreate(selectedLane.floorId!, '10:00')}
            style={{ width: '100%', padding: '13px', border: 'none', borderTop: `1px solid ${line}`, background: colors.accentBg, color: colors.accent, fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>
            ＋ この場所に予約を入れる
          </button>
        )}
      </div>
    </>
  );
};

// ============================================================
// 予約フォームの「お客様」1人ぶん（2026-09-01 ユーザー指示）
//
// 会員番号から呼ぶ／お名前から探す の**両方**に対応する。
// 🚨 1,950名を毎回読み込まない。打った文字でDB側から20件だけ絞って引く。
// 🚨 一般（非会員）のお客様もいるので、**見つからないのは異常ではない**。
//    候補は「押せば入る手助け」であって、手で書いたものを消してはいけない。
// ============================================================
interface PersonInput { no: string; name: string }

const ParticipantRow: React.FC<{
  value: PersonInput;
  onChange: (v: PersonInput) => void;
  onRemove: (() => void) | null;
  /** 学年をその予約の日で出すため */
  date: string;
  isDark: boolean;
}> = ({ value, onChange, onRemove, date, isDark }) => {
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [lookingUp, setLookingUp] = useState(false);
  const [cands, setCands] = useState<Customer[]>([]);
  const [searching, setSearching] = useState(false);
  const [openList, setOpenList] = useState(false);
  // 🚨 こちらが入れたお名前を覚えておく。手で書き換えられたものは上書きしない
  const autoFilled = useRef('');

  const line = isDark ? '#3a3a5c' : '#e0e0e0';
  const text = isDark ? '#eeeeee' : '#222222';
  const textMid = isDark ? '#b3b8c6' : '#5b6270';
  const accent = isDark ? '#6bbd92' : '#2f6f4f';
  const cardBg = isDark ? '#2f2f47' : '#ffffff';
  const input: React.CSSProperties = {
    width: '100%', padding: '9px 11px', borderRadius: 8, border: `1px solid ${line}`,
    background: isDark ? '#495057' : '#fff', color: text, fontSize: 16, boxSizing: 'border-box',
  };
  const label: React.CSSProperties = { display: 'block', fontSize: 12.5, color: textMid, marginBottom: 4 };

  // 会員番号 → お客様。打っている途中で毎回問い合わせないよう少し待つ
  useEffect(() => {
    const no = value.no.trim();
    if (!no) { setCustomer(null); setLookingUp(false); return; }
    setLookingUp(true);
    const t = setTimeout(async () => {
      const { data } = await supabase.from('room_customers')
        .select('*').eq('member_no', no).maybeSingle();
      const c = (data as Customer | null) ?? null;
      setCustomer(c);
      setLookingUp(false);
      if (!c) return;
      // 🚨 フルネームで入れる（2026-09-01 方針変更）。display_name は「田中様」形式なので使わない
      const full = customerFullName(c) || c.display_name;
      onChange({
        no: value.no,
        name: (value.name.trim() === '' || value.name === autoFilled.current) ? full : value.name,
      });
      autoFilled.current = full;
    }, 400);
    return () => clearTimeout(t);
    // 🚨 onChange / value.name を見張らない。打つたびに引き直して候補が消える
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.no]);

  // お名前 → 候補。2文字から探す（1文字だと候補が多すぎて選べない）
  useEffect(() => {
    const q = value.name.trim();
    if (q.length < 2 || q === autoFilled.current) { setCands([]); setSearching(false); return; }
    const filter = customerSearchFilter(q);
    if (!filter) { setCands([]); return; }
    setSearching(true);
    const t = setTimeout(async () => {
      // 🚨 DBは最初のかたまりだけで引いている。残りは customerMatches で絞る。
      //    絞ったあと20件に減らすので、多めに取っておく
      const { data } = await supabase.from('room_customers')
        .select('*').or(filter).order('member_no').limit(60);
      setCands(((data ?? []) as Customer[]).filter(c => customerMatches(c, q)).slice(0, 20));
      setSearching(false);
      setOpenList(true);
    }, 350);
    return () => clearTimeout(t);
  }, [value.name]);

  const choose = (c: Customer) => {
    const full = customerFullName(c) || c.display_name;
    autoFilled.current = full;
    onChange({ no: c.member_no, name: full });
    setCustomer(c);
    setOpenList(false);
    setCands([]);
  };

  return (
    <div style={{ position: 'relative' }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
        <div style={{ flex: 1 }}>
          <label style={label}>会員番号（任意）</label>
          <input value={value.no} onChange={e => onChange({ ...value, no: e.target.value })}
            style={input} inputMode="numeric" placeholder="2014052061" />
        </div>
        <div style={{ flex: 1 }}>
          <label style={label}>お客様（任意）</label>
          <input value={value.name}
            onChange={e => onChange({ ...value, name: e.target.value })}
            onFocus={() => { if (cands.length) setOpenList(true); }}
            style={input} placeholder="田中 太郎" />
        </div>
        {onRemove && (
          // 🚨 消す手段を必ず添える。増やせるのに減らせないと、間違えた行が残ったまま保存される
          <button onClick={onRemove} aria-label="この方を消す"
            style={{ padding: '9px 12px', borderRadius: 8, border: `1px solid ${line}`, background: 'transparent', color: textMid, fontSize: 14, cursor: 'pointer', flexShrink: 0 }}>✕</button>
        )}
      </div>

      {/* お名前の候補。押すと会員番号も一緒に入る */}
      {openList && cands.length > 0 && (
        <div style={{
          position: 'absolute', zIndex: 5, left: 0, right: 0, marginTop: 3,
          background: cardBg, border: `1px solid ${line}`, borderRadius: 8,
          maxHeight: 232, overflowY: 'auto', boxShadow: '0 6px 18px rgba(0,0,0,.18)',
        }}>
          {cands.map(c => (
            <button key={c.member_no} onClick={() => choose(c)}
              style={{
                display: 'block', width: '100%', textAlign: 'left', padding: '8px 11px',
                background: 'transparent', border: 'none', borderBottom: `1px solid ${line}`,
                color: text, fontSize: 13.5, cursor: 'pointer',
              }}>
              {customerFullName(c) || c.display_name}
              <span style={{ color: textMid, fontSize: 12, marginLeft: 7 }}>
                {c.member_no}
                {c.birth_date && ` ／ ${gradeOrAge(c.birth_date, date)}`}
                {!c.active && ' ／ 退会'}
              </span>
            </button>
          ))}
          <button onClick={() => setOpenList(false)}
            style={{ display: 'block', width: '100%', textAlign: 'center', padding: '7px', background: 'transparent', border: 'none', color: textMid, fontSize: 12.5, cursor: 'pointer' }}>
            閉じる
          </button>
        </div>
      )}

      <p style={{ fontSize: 11.5, color: customer ? accent : textMid, margin: '5px 0 0', lineHeight: 1.6 }}>
        {lookingUp
          ? 'お客様を探しています...'
          : customer
            ? `${customerName(customer, date)}${customer.full_name ? `（${customer.full_name}）` : ''}`
              + `${customer.birth_date ? ` ${gradeOrAge(customer.birth_date, date)}` : ''}`
              + `${customer.active ? '' : ' ※退会になっています'}`
            : searching
              ? 'お名前で探しています...'
              : value.no.trim()
                ? 'この会員番号は登録がありません。一般のお客様として、お名前を手で入れてください'
                : value.name.trim().length >= 2 && cands.length === 0
                  ? '見つかりませんでした。一般のお客様として、このまま進められます'
                  : 'お名前は「田中 太郎」のようにフルネームで入れてください。'
                    + '会員番号を入れるか、お名前を2文字以上入れると候補が出ます。'}
      </p>
    </div>
  );
};

// ============================================================
// 予約フォーム（新規・変更）
// ============================================================
const BookingForm: React.FC<{
  mode: FormMode; user: AuthUser; floors: Floor[]; campuses: Campus[];
  staff: Staff[]; categories: LessonCategory[]; purposeDurations: PurposeDuration[];
  purposeDetails: PurposeDetail[];
  /** お客様一覧の「予約する」から来たとき。会員番号とお名前を先に入れておく */
  bookingFor: Customer | null;
  onClose: () => void; onSaved: (msg: string) => void; isDark: boolean;
}> = ({ mode, user, floors, campuses, staff, categories, purposeDurations, purposeDetails, bookingFor, onClose, onSaved, isDark }) => {
  const editing = mode.kind === 'edit';
  const base = editing ? mode.booking : null;

  const [floorId] = useState(editing ? base!.floor_id : mode.floorId);
  // 🚨 日付は localDate を通す（ISO文字列の頭10文字はUTCの日付で、朝の予約が前日になる）
  const [date] = useState(editing ? localDate(base!.starts_at) : mode.date);
  const [startTime, setStartTime] = useState(editing ? hhmm(base!.starts_at) : mode.startTime);
  // 🚨 終了の初期値も用途の長さに合わせる。ここを固定の30分にしていたため、
  //    レッスン（50分固定・終了は手で直せない）を開いた直後に 30分 と出て、
  //    ボタンを押すまで矛盾したままだった（2026-08-31 実機確認で発見）
  // 既定は「プライベート」（2026-08-31 ユーザー確定）。いちばん多い使い方のため
  const initialPurpose = editing ? base!.purpose : 'プライベート';
  const initialLength =
    defaultMinutesOf(purposeDurations.find(d => d.purpose === initialPurpose)) ?? 30;
  const [endTime, setEndTime] = useState(
    editing ? hhmm(base!.ends_at) : addMinutes(mode.startTime, initialLength));
  const [purpose, setPurpose] = useState<string>(initialPurpose);
  // 用途の詳細（パーソナルの「体操」など）。'' = 未選択
  const [detail, setDetail] = useState<string>(editing ? (base!.detail ?? '') : '');
  // 「予約する人」は画面に出さず、ログインした人から自動で決める。
  // 🚨 空のままだと保存できない（DBで必須）ので、必ず何か入る形にしておく
  const bookerName = (editing ? base!.booker_name : (user.email?.split('@')[0] ?? '')) || 'スタッフ';
  /**
   * お客様（複数可・2026-09-01 ユーザー指示）。
   * 🚨 保存するときは、いままでと同じ**カンマ区切り**で member_no / customer_label に入れる。
   *    募集枠を埋める room_fill_open_slot が同じ形で書くので、読み方を1つに保てる。
   * 編集で開いたときは participantsOf で人数ぶんに分けて戻す。
   * お客様一覧の「予約する」から来たときは、その方を先に入れておく。
   */
  const [people, setPeople] = useState<PersonInput[]>(() => {
    if (editing) {
      return participantsOf(base!).map(p => ({ no: p.no, name: p.name }));
    }
    if (bookingFor) {
      return [{ no: bookingFor.member_no, name: customerFullName(bookingFor) || bookingFor.display_name }];
    }
    return [{ no: '', name: '' }];
  });
  const memberNo = people.map(p => p.no.trim()).filter(Boolean).join(', ');
  const customerLabel = people.map(p => p.name.trim()).filter(Boolean).join(', ');
  /**
   * 🚨 2名以上で「会員番号を入れた人と入れていない人が混ざる」と、
   *    どの番号が誰のものか復元できないため**会員番号は保存されない**
   *    （lib の participantsOf で捨てている）。画面で先に断っておく。
   */
  const numbersDropped = people.length > 1
    && people.some(p => p.no.trim()) && people.some(p => !p.no.trim());
  // 🚨 会員番号の引き当てとお名前の検索は ParticipantRow が1人ずつ持つ。
  //    ここに戻さないこと（人数ぶんの状態をこの画面で持つと、行を消したときにずれる）
  const [memo, setMemo] = useState(editing ? (base!.memo ?? '') : '');
  const [exclusive, setExclusive] = useState(editing ? base!.exclusive : false);
  // 固定の枠か（人ではなく曜日・時間の枠の性質）。既定は固定でない
  const [isFixed, setIsFixed] = useState(editing ? base!.is_fixed : false);
  const [staffId, setStaffId] = useState<string>(editing ? (base!.staff_id ?? '') : '');
  // 募集中の枠（先に置いて後から埋める）かどうかと、その定員
  const [kind, setKind] = useState<'booking' | 'open'>(editing ? base!.kind : 'booking');
  const [seats, setSeats] = useState<number>(editing ? base!.seats : 1);
  const [repeat, setRepeat] = useState(false);
  const [repeatUntil, setRepeatUntil] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [conflicts, setConflicts] = useState<ConflictInfo[]>([]);
  // 🚨 入れられるかどうかの判断は、画面で計算し直さずサーバーの答え（ok/reason）をそのまま出す。
  //    自前で「あと何件」を数えると、占有のときに「あと2件入れられます」と表示されるのに
  //    保存すると弾かれる、という食い違いが起きる（2026-08-28 の実機確認で発見）。
  const [verdict, setVerdict] = useState<{ ok: boolean; reason: string | null } | null>(null);
  const [checking, setChecking] = useState(false);

  const floor = floors.find(f => f.id === floorId);
  const campus = campuses.find(c => c.id === floor?.campus_id);
  // その校に場所がいくつあるか（1つだけなら見出しに「全体」を出さない）
  const siblingFloors = floors.filter(f => f.campus_id === floor?.campus_id).length;

  const line = isDark ? '#3a3a5c' : '#e0e0e0';
  const text = isDark ? '#eeeeee' : '#222222';
  const textMid = isDark ? '#b3b8c6' : '#5b6270';
  const accent = isDark ? '#6bbd92' : '#2f6f4f';
  const accentBgLocal = isDark ? '#263b33' : '#e8f2ec';
  const fieldBg = isDark ? '#495057' : '#fff';

  // 入力中に重なりを見に行く（気づかせるためのもの。最終判定はサーバー側）
  useEffect(() => {
    const s = toDate(date, startTime), e = toDate(date, endTime);
    if (!s || !e || e <= s) { setConflicts([]); setVerdict(null); return; }
    let cancelled = false;
    setChecking(true);
    const timer = setTimeout(async () => {
      const { data } = await supabase.rpc('room_check_conflict', {
        p_floor_id: floorId, p_starts_at: s.toISOString(), p_ends_at: e.toISOString(),
        p_exclusive: exclusive, p_exclude_id: editing ? base!.id : null,
      });
      if (cancelled) return;
      const row = Array.isArray(data) ? data[0] : data;
      setConflicts((row?.conflicts ?? []) as ConflictInfo[]);
      setVerdict(row ? { ok: !!row.ok, reason: row.reason ?? null } : null);
      setChecking(false);
    }, 400);
    return () => { cancelled = true; clearTimeout(timer); setChecking(false); };
  }, [date, startTime, endTime, floorId, exclusive, editing, base]);


  /**
   * 担当の時間かぶりを見る（2026-09-01 ユーザー指示）。
   *
   * 🚨 **止めない。警告だけ**（「大丈夫ならそのまま予約できてよい」ユーザー確定）。
   * 🚨 サーバー（room_create_booking）は**場所**の重なりしか見ていない。
   *    担当の重なりは判定していないので、画面で気づけるようにするしかない。
   *    一括入力（bookingBulk）と同じ考え方だが、あちらは**弾く**、ここは**警告**。
   * 🚨 繰り返しのときも**入力した日だけ**を見る。各回まで見に行くと重くなるので、
   *    見ていないことを画面にも書く（黙って「問題なし」に見せない）。
   */
  const [staffClash, setStaffClash] = useState<string[]>([]);
  const [staffChecking, setStaffChecking] = useState(false);
  useEffect(() => {
    const s = toDate(date, startTime), e = toDate(date, endTime);
    if (!staffId || !s || !e || e <= s) { setStaffClash([]); setStaffChecking(false); return; }
    let cancelled = false;
    setStaffChecking(true);
    const timer = setTimeout(async () => {
      const dayStart = new Date(`${date}T00:00:00`);
      const dayEnd = new Date(dayStart);
      dayEnd.setDate(dayEnd.getDate() + 1);
      const { data, error: err } = await supabase.from('room_bookings')
        .select('id, starts_at, ends_at, floor_id, purpose, detail, customer_label, kind')
        .eq('staff_id', staffId)
        .is('deleted_at', null)
        .neq('status', 'cancelled')
        .gte('starts_at', dayStart.toISOString())
        .lt('starts_at', dayEnd.toISOString());
      if (cancelled) return;
      setStaffChecking(false);
      // 🚨 読めなかったときは「かぶりなし」にしない。黙って安心させないため
      if (err) { setStaffClash(['この担当の予定を確かめられませんでした（通信を確認してください）']); return; }
      const rows = (data ?? []) as (Pick<Booking, 'id' | 'starts_at' | 'ends_at' | 'floor_id' | 'purpose' | 'detail' | 'customer_label' | 'kind'>)[];
      setStaffClash(rows
        // 変更のときは自分自身を除く
        .filter(r => r.id !== base?.id
          && new Date(r.starts_at) < e && new Date(r.ends_at) > s)
        .sort((a, b) => a.starts_at.localeCompare(b.starts_at))
        .map(r => {
          const f = floors.find(x => x.id === r.floor_id);
          const c = f ? campuses.find(x => x.id === f.campus_id) : null;
          const place = f ? placeLabel(f, c?.name ?? '', floors.filter(x => x.campus_id === f.campus_id).length, true) : '';
          return `${hhmm(r.starts_at)}〜${hhmm(r.ends_at)}　${place}　${purposeWithDetail(r)}`
            + (r.kind === 'open' ? '（募集中）' : r.customer_label ? `　${r.customer_label}` : '');
        }));
    }, 400);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [staffId, date, startTime, endTime, base, floors, campuses]);

  const applyDuration = (min: number) => setEndTime(addMinutes(startTime, min));
  const durationMin = Math.max(0, minutesOf(endTime) - minutesOf(startTime));
  // 用途ごとの長さ（2026-08-29 ユーザー指定）。値はDBにあり、社員が基本設定で変えられる。
  // 知らない用途が来たときは、これまでどおり自由に入れられるようにしておく
  const durOpt = purposeDurations.find(d => d.purpose === purpose) ?? null;
  const durPresets = durOpt ? durOpt.minutes : [...DURATION_PRESETS];
  const allowFreeEnd = durOpt ? durOpt.allow_free : true;
  /**
   * この用途で選べる詳細（2026-09-01 ユーザー指示）。
   * 🚨 いま入っている値は、あとから隠された（active=false）ものでも必ず選択肢に残す。
   *    残さないと、古い予約を開いたときに選択が消えたように見え、
   *    保存し直すと黙って別の値になる。
   */
  const detailOpts = useMemo(() => {
    const list = detailsOf(purpose, purposeDetails).map(d => d.name);
    return detail && !list.includes(detail) ? [...list, detail] : list;
  }, [purpose, purposeDetails, detail]);
  // 必須にするかは用途ごとの設定。🚨 選択肢が1つも無い用途では効かせない（予約できなくなる）
  const detailRequired = (durOpt?.detail_required ?? false) && detailOpts.length > 0;
  // 確認中は押せてよい（結果が出るまで待たせない）。確認が済んで「不可」のときだけ止める
  const blocked = !checking && !!verdict && !verdict.ok;
  // 繰り返しの終わりは「年度末（3/31）まで」が基本（2026-08-29 ユーザー確定）。
  // 年度をまたぐ繰り返しをいつでも作れるようにすると、年度更新の一覧と二重になり
  // 「どちらが正しいのか」が分からなくなるため、通常は今年度末で止める。
  // ただし年度末が近い時期に始まるものは翌年度も続くのが普通なので、
  // 残り60日以内のときだけ「来年度末まで」も選べるようにする。
  const formFy = fiscalYear(date);
  const thisFyEnd = fiscalYearEnd(formFy);
  const nextFyEnd = fiscalYearEnd(formFy + 1);
  const nearFiscalEnd = daysUntil(date, thisFyEnd) <= RENEWAL_NOTICE_DAYS;
  const maxRepeatUntil = nearFiscalEnd ? nextFyEnd : thisFyEnd;
  // 退職などで非表示にしたスタッフは選択肢に出さない。
  // ただし変更中の予約に既に入っている人は、勝手に外れないよう残す
  const activeStaff = staff.filter(s => s.active || s.id === staffId);
  const selectedStaff = staff.find(s => s.id === staffId) ?? null;

  const save = async () => {
    setError('');
    const s = toDate(date, startTime), e = toDate(date, endTime);
    if (!s) { setError('開始の時刻を正しく入れてください（例：10 と 05）'); return; }
    if (!e) { setError('終了の時刻を正しく入れてください'); return; }
    if (e <= s) { setError('終了は開始より後にしてください'); return; }
    // 🚨 詳細が必須の用途は、選ぶまで保存させない（2026-09-01 ユーザー指示）。
    //    detailRequired は「選択肢が1つ以上ある用途」でしか true にならない
    if (detailRequired && !detail) { setError(`${purpose}の詳細を選んでください`); return; }

    setSaving(true);
    if (editing) {
      const { data, error: err } = await supabase.rpc('room_update_booking', {
        p_id: base!.id, p_starts_at: s.toISOString(), p_ends_at: e.toISOString(),
        p_purpose: purpose, p_booker_name: bookerName.trim(),
        p_member_no: memberNo.trim(), p_customer_label: customerLabel.trim(),
        p_memo: memo.trim(), p_exclusive: exclusive, p_staff_id: staffId || null,
        p_kind: kind, p_seats: seats,
      });
      setSaving(false);
      const row = Array.isArray(data) ? data[0] : data;
      if (err) { setError('保存できませんでした。通信を確認してもう一度お試しください。'); return; }
      if (!row?.ok) { setError(row?.reason ?? '保存できませんでした'); setConflicts((row?.conflicts ?? []) as ConflictInfo[]); return; }
      // 固定と詳細は、RPCを通さず後から書き込む。
      // 🚨 room_update_booking には引数を足さない（中心の関数を触らない方針）。
      //    過去に、RPCを古い版で上書きして申請が全部止まった事故がある
      const patch: Record<string, unknown> = {};
      if (isFixed !== base!.is_fixed) patch.is_fixed = isFixed;
      if ((detail || null) !== (base!.detail ?? null)) patch.detail = detail || null;
      if (Object.keys(patch).length > 0) {
        await supabase.from('room_bookings').update(patch).eq('id', base!.id);
      }
      onSaved('予約を変更しました');
      return;
    }

    // 新規。繰り返しのときは同じ曜日の分をまとめて作る
    if (repeat && repeatUntil > maxRepeatUntil) {
      setSaving(false);
      setError(`繰り返しの終わりの日は、${maxRepeatUntil.split('-')[0]}年3月31日（年度末）までにしてください`);
      return;
    }
    const dates = repeat ? weeklyDates(date, repeatUntil) : [date];
    if (repeat && dates.length === 0) { setSaving(false); setError('繰り返しの終わりの日は、開始の日より後にしてください'); return; }

    // 繰り返しは「親のルール1件＋各回の予約」で持つ。
    // 🚨 親を作っておかないと、あとから「今後すべて変更／削除」ができない
    //    （どの予約が同じ約束事なのかを結び付けられなくなる）。
    let recurrenceId: string | null = null;
    if (repeat) {
      const [y, mo, d0] = date.split('-').map(Number);
      const { data: rec, error: recErr } = await supabase.from('room_recurrences').insert({
        floor_id: floorId,
        weekday: new Date(y, mo - 1, d0).getDay(),
        start_time: startTime, end_time: endTime,
        purpose, detail: detail || null, booker_name: bookerName.trim(),
        member_no: memberNo.trim() || null, customer_label: customerLabel.trim() || null,
        memo: memo.trim() || null, exclusive, staff_id: staffId || null,
        kind, seats,
        start_date: date, end_date: repeatUntil || null, generated_to: dates[dates.length - 1],
        // 年度は「終わりの日が属する年度」。3月に来年度末まで作った場合も、
        // その繰り返しは来年度のものとして年度更新の一覧に出したいため
        fiscal_year: fiscalYear(repeatUntil || date),
        created_by: user.id,
      }).select('id').single();
      if (recErr || !rec) { setSaving(false); setError('繰り返しの登録に失敗しました。通信を確認してもう一度お試しください。'); return; }
      recurrenceId = rec.id as string;
    }

    let made = 0;
    const skipped: string[] = [];
    const createdIds: string[] = [];   // 固定の印を後からまとめて付けるため
    for (const d of dates) {
      const ds = toDate(d, startTime), de = toDate(d, endTime);
      if (!ds || !de) continue;
      const { data, error: err } = await supabase.rpc('room_create_booking', {
        p_floor_id: floorId, p_starts_at: ds.toISOString(), p_ends_at: de.toISOString(),
        p_purpose: purpose, p_booker_name: bookerName.trim(),
        p_member_no: memberNo.trim(), p_customer_label: customerLabel.trim(),
        p_memo: memo.trim(), p_exclusive: exclusive, p_recurrence_id: recurrenceId,
        p_staff_id: staffId || null, p_kind: kind, p_seats: seats,
      });
      const row = Array.isArray(data) ? data[0] : data;
      if (err) { skipped.push(`${formatDateLabel(d)}（通信エラー）`); continue; }
      if (!row?.ok) {
        // 1件目（＝今開いている日）が入らないのは入力の問題なので、その場で止めて理由を見せる。
        // 先に作った繰り返しの親は、予約が1件も無い状態で残ると迷子になるので消しておく
        if (d === date) {
          if (recurrenceId) await supabase.from('room_recurrences').delete().eq('id', recurrenceId);
          setSaving(false);
          setError(row?.reason ?? '保存できませんでした');
          setConflicts((row?.conflicts ?? []) as ConflictInfo[]);
          return;
        }
        skipped.push(formatDateLabel(d));
        continue;
      }
      made++;
      if (row?.booking_id) createdIds.push(row.booking_id as string);
    }
    // 詳細も、作ったあとにまとめて書く（RPCには引数を足さない方針のため）。
    // 🚨 繰り返しのときは全部の回に付ける。1回目だけ付くと一覧で食い違う
    if (detail && createdIds.length > 0) {
      await supabase.from('room_bookings').update({ detail }).in('id', createdIds);
    }
    // 固定の枠なら、作った予約にまとめて印を付ける。
    // 🚨 1件ずつ付けずに1回でまとめる。件数が多いと通信が増えて途中で切れやすい
    if (isFixed && createdIds.length > 0) {
      await supabase.from('room_bookings').update({ is_fixed: true }).in('id', createdIds);
      if (recurrenceId) {
        await supabase.from('room_recurrences').update({ is_fixed: true }).eq('id', recurrenceId);
      }
    }
    setSaving(false);
    // 🚨 入らなかった回を黙って捨てない。「全部入った」と誤解させないため必ず件数を出す
    onSaved(skipped.length
      ? `${made}件を予約しました。すでに埋まっていたため入れられなかった日：${skipped.join('、')}`
      : (made > 1 ? `${made}件を予約しました` : '予約しました'));
  };

  const label: React.CSSProperties = { fontSize: 12.5, fontWeight: 700, color: textMid, display: 'block', marginBottom: 4 };
  const input: React.CSSProperties = {
    width: '100%', padding: '8px 10px', borderRadius: 8, border: `1px solid ${line}`,
    background: fieldBg, color: text, fontSize: 16, boxSizing: 'border-box',   // 🚨 16px未満にしない（iOSが拡大する）
  };
  /** 選択式の丸ボタン（長さの 30/45/60/90 分と同じ見た目にそろえる） */
  const pill = (on: boolean): React.CSSProperties => ({
    padding: '6px 13px', borderRadius: 999, fontSize: 13, cursor: 'pointer',
    border: `1px solid ${on ? accent : line}`,
    background: on ? accent : (isDark ? '#35354e' : '#f0f2f5'),
    color: on ? (isDark ? '#1d2a24' : '#fff') : textMid,
    fontWeight: on ? 700 : 400,
  });

  return (
    <Overlay onClose={onClose} isDark={isDark} title={editing ? '予約を変更する' : '予約を入れる'}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

        <div style={{ background: isDark ? '#35354e' : '#f0f2f5', borderRadius: 8, padding: '9px 12px', fontSize: 13.5 }}>
          <b>{placeLabel(floor, campus?.name ?? '', siblingFloors, true)}</b>{' / '}{formatDateLabel(date)}
          <span style={{ display: 'block', fontSize: 12, color: textMid, marginTop: 2 }}>
            同時に入れられるのは {floor?.capacity ?? 3} 件までです
          </span>
        </div>

        {/* 予約か、募集枠か。
            募集枠＝「毎週火曜 16:00〜はレッスンできます」と先に置いておき、申込が入ったら埋める */}
        <div>
          <label style={label}>入れるもの</label>
          <div style={{ display: 'flex', gap: 6 }}>
            {([['booking', '予約', 'もう相手が決まっている'],
               ['open', '募集中の枠', '空けておいて後から埋める']] as const).map(([k, l, note]) => {
              const on = kind === k;
              const [ofg, obg] = openSlotColor(isDark);
              const c = k === 'open' ? ofg : accent;
              return (
                <button key={k} onClick={() => setKind(k)}
                  style={{
                    flex: 1, padding: '9px 10px', borderRadius: 8, fontSize: 13.5, cursor: 'pointer',
                    border: `1px solid ${on ? c : line}`,
                    background: on ? (k === 'open' ? obg : accentBgLocal) : 'transparent',
                    color: on ? c : textMid, fontWeight: on ? 700 : 400, textAlign: 'center',
                  }}>
                  {k === 'open' ? '🟡 ' : ''}{l}
                  <span style={{ display: 'block', fontSize: 11, fontWeight: 400, marginTop: 2 }}>{note}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* 時刻 */}
        <div>
          <label style={label}>開始</label>
          <TimeInput value={startTime} onChange={setStartTime} isDark={isDark} ariaLabel="開始時刻" />
        </div>

        <div>
          <label style={label}>長さ</label>
          {durPresets.length > 0 && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
              {durPresets.map(m => (
                <button key={m} onClick={() => applyDuration(m)}
                  style={{
                    padding: '6px 13px', borderRadius: 999, fontSize: 13, cursor: 'pointer',
                    border: `1px solid ${durationMin === m ? accent : line}`,
                    background: durationMin === m ? accent : (isDark ? '#35354e' : '#f0f2f5'),
                    color: durationMin === m ? (isDark ? '#1d2a24' : '#fff') : textMid,
                    fontWeight: durationMin === m ? 700 : 400,
                  }}>{durationLabel(m)}</button>
              ))}
            </div>
          )}
          <label style={label}>終了</label>
          {/* 長さが決まっている用途（パーソナル・レッスンなど）は終了時刻を触らせない。
              打ち間違いで 10分のパーソナルが 100分 になるのを防ぐ。
              🚨 この可否は基本設定から変えられる（コードに固定しない） */}
          <TimeInput value={endTime} onChange={setEndTime} isDark={isDark}
            disabled={!allowFreeEnd} ariaLabel="終了時刻" />
          {!allowFreeEnd && (
            <p style={{ fontSize: 12.5, color: textMid, margin: '6px 0 0', lineHeight: 1.6 }}>
              この用途は長さが決まっています。上のボタンで選んでください
            </p>
          )}
          {allowFreeEnd && durPresets.length === 0 && (
            <p style={{ fontSize: 12.5, color: textMid, margin: '6px 0 0', lineHeight: 1.6 }}>
              終了時刻を直接入れてください
            </p>
          )}
          {durationMin > 0 && (
            <p style={{ fontSize: 12.5, color: textMid, margin: '6px 0 0' }}>
              → {startTime}〜{endTime}（{durationMin}分）
            </p>
          )}
        </div>

        {/* 重なりの案内。誰と・何時に重なるかまで出す（エラーだけでは調整の判断ができないため）。
            入れられるかどうかは verdict（サーバーの答え）をそのまま使う */}
        {conflicts.length > 0 && (
          <div style={{ background: isDark ? '#3d3226' : '#fdf0e6', border: `1px solid ${isDark ? '#7a5c37' : '#e8b98a'}`, borderRadius: 8, padding: '10px 12px', fontSize: 13 }}>
            <b style={{ color: isDark ? '#e6b980' : '#8a5a1f' }}>⚠ この時間には、すでに {conflicts.length} 件入っています</b>
            <ul style={{ margin: '6px 0 0', paddingLeft: 18, color: textMid }}>
              {conflicts.map(c => (
                <li key={c.id} style={{ marginBottom: 2 }}>
                  {c.exclusive && '🔒'}{hhmm(c.starts_at)}〜{hhmm(c.ends_at)}{' '}{c.purpose}／{c.booker}
                </li>
              ))}
            </ul>
            {verdict && (
              <p style={{ margin: '6px 0 0', fontSize: 12.5, fontWeight: verdict.ok ? 400 : 700, color: verdict.ok ? textMid : (isDark ? '#ff9b9b' : '#c0392b') }}>
                {verdict.ok
                  ? `このまま予約できます（あと ${Math.max(0, (floor?.capacity ?? 3) - conflicts.length)} 件入れられます）`
                  : `${verdict.reason ?? 'この時間には入れられません'}`}
              </p>
            )}
          </div>
        )}
        {/* 重なりは無いが入れられない場合（終了が開始より前など）もサーバーの理由を出す */}
        {conflicts.length === 0 && verdict && !verdict.ok && (
          <div style={{ background: isDark ? '#3d3226' : '#fdf0e6', border: `1px solid ${isDark ? '#7a5c37' : '#e8b98a'}`, borderRadius: 8, padding: '10px 12px', fontSize: 13, fontWeight: 700, color: isDark ? '#ff9b9b' : '#c0392b' }}>
            ⚠ {verdict.reason}
          </div>
        )}
        {checking && <p style={{ fontSize: 12, color: textMid, margin: 0 }}>空きを確認しています…</p>}

        {/* 用途 */}
        <div>
          <label style={label}>用途</label>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {activePurposes().map(p => {
              const on = purpose === p;
              const [fg, bgc] = purposeColor(p, isDark);
              return (
                <button key={p}
                  onClick={() => {
                    setPurpose(p);
                    // 用途を変えたら、その用途の「最初に入る長さ」に合わせる。
                    // 🚨 長さが決まっている用途（終了を手で直せない）は特に必須。
                    //    合っていないまま残ると直す手段が無くなる
                    const opt = purposeDurations.find(d => d.purpose === p);
                    const min = defaultMinutesOf(opt);
                    if (min != null) setEndTime(addMinutes(startTime, min));
                    // 🚨 詳細は用途ごとに違うので、用途を変えたら必ず消す。
                    //    残すと「パーソナルの体操」がレッスンに付いたまま保存される
                    setDetail(prev => detailsOf(p, purposeDetails).some(d => d.name === prev) ? prev : '');
                  }}
                  style={{
                    padding: '6px 13px', borderRadius: 999, fontSize: 13, cursor: 'pointer',
                    border: `1px solid ${on ? fg : line}`, background: on ? bgc : 'transparent',
                    color: on ? fg : textMid, fontWeight: on ? 700 : 400,
                  }}>{p}</button>
              );
            })}
          </div>
        </div>

        {/* 用途の詳細（パーソナルの「体操」「筋トレ」など・2026-09-01 ユーザー指示）。
            🚨 その用途に詳細が登録されているときだけ出す。登録が無ければ欄ごと出さない。
            配色は 🎨🔒 択一トグルの固定ルール（青）に従う。用途ボタンだけが例外的に
            用途色なのは、予約表の色と一致させる意味があるため */}
        {detailOpts.length > 0 && (
          <div>
            <label style={label}>
              詳細{detailRequired ? '' : '（任意）'}
            </label>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {!detailRequired && (
                <button onClick={() => setDetail('')}
                  style={{
                    padding: '6px 13px', borderRadius: 999, fontSize: 13, cursor: 'pointer', fontWeight: 700,
                    border: `2px solid ${detail === '' ? '#1565c0' : '#90caf9'}`,
                    background: detail === '' ? '#1976d2' : '#e3f2fd',
                    color: detail === '' ? '#fff' : '#1565c0',
                  }}>指定なし</button>
              )}
              {detailOpts.map(name => {
                const on = detail === name;
                return (
                  <button key={name} onClick={() => setDetail(name)}
                    style={{
                      padding: '6px 13px', borderRadius: 999, fontSize: 13, cursor: 'pointer', fontWeight: 700,
                      border: `2px solid ${on ? '#1565c0' : '#90caf9'}`,
                      background: on ? '#1976d2' : '#e3f2fd',
                      color: on ? '#fff' : '#1565c0',
                    }}>{name}</button>
                );
              })}
            </div>
          </div>
        )}

        {/* 担当スタッフ。担当できる区分は表示するだけで、選択の制限はしない
            （2026-08-28 ユーザー確定。現場では例外的な割り当てが起きるため） */}
        <div>
          <label style={label}>担当スタッフ</label>
          <select value={staffId} onChange={e => setStaffId(e.target.value)} style={input}>
            <option value="">（選ばない）</option>
            {activeStaff.map(s => (
              <option key={s.id} value={s.id}>
                {s.name}{categoryLabel(s, categories) ? `（${categoryLabel(s, categories)}）` : ''}
              </option>
            ))}
          </select>
          {selectedStaff && (
            <p style={{ fontSize: 11.5, color: textMid, margin: '5px 0 0', lineHeight: 1.6 }}>
              担当できる区分：{categoryLabel(selectedStaff, categories) || '登録がありません'}
              {staffChecking && '　／　この時間に他の予定がないか確認中…'}
            </p>
          )}
          {/* 担当の時間かぶりの警告（2026-09-01 ユーザー指示）。
              🚨 止めない。「大丈夫ならそのまま予約できてよい」というご判断。
                 だから赤（エラー）ではなく黄色（気づき）にしている */}
          {staffClash.length > 0 && (
            <div style={{ background: isDark ? '#4a3f2a' : '#fff6e0', border: `1px solid ${isDark ? '#7a6a44' : '#f0d9a0'}`, color: isDark ? '#e8c98a' : '#8a6a12', borderRadius: 8, padding: '9px 12px', fontSize: 12.5, lineHeight: 1.7, marginTop: 7 }}>
              <b>{selectedStaff?.name ?? 'この担当'}は、この時間に別の予定があります</b>
              {staffClash.map((c, i) => <div key={i}>・{c}</div>)}
              <div style={{ marginTop: 3 }}>
                問題なければ、このまま予約できます。
                {repeat && '（繰り返しは、入力した日のぶんだけ見ています）'}
              </div>
            </div>
          )}
        </div>

        {/* 「予約する人」は画面に出さない（2026-08-31 ユーザー指示）。
            🚨 値そのものは残す。ログインした人の名前を自動で入れて保存している。
               2026-09-01 のユーザー指示で、予約の詳細からも出さなくなった。
               誰が入れたかは room_bookings.booker_name に残っている */}

        {/* 募集枠のときは定員（何名まで受けるか）を選ぶ。基本1名、2名同時希望のときだけ増やす */}
        {kind === 'open' ? (
          <div>
            <label style={label}>受けられる人数</label>
            <div style={{ display: 'flex', gap: 6 }}>
              {[1, 2, 3].map(n => (
                <button key={n} onClick={() => setSeats(n)}
                  style={{
                    padding: '7px 16px', borderRadius: 999, fontSize: 13.5, cursor: 'pointer',
                    border: `1px solid ${seats === n ? accent : line}`,
                    background: seats === n ? accent : 'transparent',
                    color: seats === n ? (isDark ? '#1d2a24' : '#fff') : textMid,
                    fontWeight: seats === n ? 700 : 400,
                  }}>{n}名</button>
              ))}
            </div>
            <p style={{ fontSize: 11.5, color: textMid, margin: '6px 0 0', lineHeight: 1.6 }}>
              ふつうは1名です。「2名で一緒に受けたい」という申込に備えるときだけ増やしてください。
              定員まで埋まると、自動で「予約」に変わります。
            </p>
          </div>
        ) : (
          <>
            {/* お客様。会員番号から呼ぶ／お名前から探す の両方に対応（2026-09-01 ユーザー指示）。
                🚨 一般の方（非会員）もいるので、見つからないのは異常ではない。
                   その場合はお名前を手で入れてもらう（2026-08-29 ユーザー指示） */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {people.map((p, i) => (
                <ParticipantRow key={i} value={p} date={date} isDark={isDark}
                  onChange={v => setPeople(prev => prev.map((x, j) => (j === i ? v : x)))}
                  onRemove={people.length > 1
                    ? () => setPeople(prev => prev.filter((_, j) => j !== i))
                    : null} />
              ))}
            </div>
            <button onClick={() => setPeople(prev => [...prev, { no: '', name: '' }])}
              style={{ alignSelf: 'flex-start', padding: '7px 14px', borderRadius: 8, border: `1px solid ${accent}`, background: 'transparent', color: accent, fontSize: 13.5, fontWeight: 700, cursor: 'pointer' }}>
              ＋ お客様を追加
            </button>
            {numbersDropped && (
              // 🚨 静かに落とさない。保存してから気づけないため、押す前に伝える
              <div style={{ background: isDark ? '#4a3f2a' : '#fff6e0', border: `1px solid ${isDark ? '#7a6a44' : '#f0d9a0'}`, color: isDark ? '#e8c98a' : '#8a6a12', borderRadius: 8, padding: '9px 12px', fontSize: 12.5, lineHeight: 1.7 }}>
                会員番号を入れていない方がいるため、<b>この予約には会員番号が残りません</b>
                （どの番号がどなたのものか分からなくなるためです）。お名前と出欠はふつうに使えます。
                会員番号も残したいときは、<b>全員ぶん入れてください</b>。
              </div>
            )}
          </>
        )}

        <div>
          <label style={label}>メモ（任意）</label>
          <textarea value={memo} onChange={e => setMemo(e.target.value)} rows={2}
            style={{ ...input, resize: 'vertical', fontFamily: 'inherit' }} />
        </div>

        {/* 占有 */}
        <label style={{ display: 'flex', gap: 9, alignItems: 'flex-start', cursor: 'pointer', background: isDark ? '#35354e' : '#f0f2f5', borderRadius: 8, padding: '10px 12px' }}>
          <input type="checkbox" checked={exclusive} onChange={e => setExclusive(e.target.checked)} style={{ width: 18, height: 18, marginTop: 1, flexShrink: 0 }} />
          <span style={{ fontSize: 13.5 }}>
            <b>🔒 貸切にする</b>
            <span style={{ display: 'block', fontSize: 12, color: textMid, marginTop: 2 }}>
              この時間は、他の人が予約を入れられなくなります
            </span>
          </span>
        </label>

        {/* 固定枠。
            🚨 人ではなく「曜日・時間の枠」の性質（2026-08-31 ユーザー明言）。
               来週も入っているかの判断材料になり、パーソナルは金額が変わるので
               見て分かることが大事。入れられるかどうかの判定には関係しない */}
        <label style={{ display: 'flex', gap: 9, alignItems: 'flex-start', cursor: 'pointer', background: isDark ? '#35354e' : '#f0f2f5', borderRadius: 8, padding: '10px 12px' }}>
          <input type="checkbox" checked={isFixed} onChange={e => setIsFixed(e.target.checked)} style={{ width: 18, height: 18, marginTop: 1, flexShrink: 0 }} />
          <span style={{ fontSize: 13.5 }}>
            <b>固定の枠にする</b>
            <span style={{ display: 'block', fontSize: 12, color: textMid, marginTop: 2 }}>
              毎週この曜日・この時間に入っている枠のことです。
              パーソナルは固定かどうかで金額が変わります
            </span>
          </span>
        </label>

        {/* 繰り返し（新規のときだけ） */}
        {!editing && (
          <div style={{ background: isDark ? '#35354e' : '#f0f2f5', borderRadius: 8, padding: '10px 12px' }}>
            <label style={{ display: 'flex', gap: 9, alignItems: 'center', cursor: 'pointer' }}>
              <input type="checkbox" checked={repeat}
                onChange={e => {
                  setRepeat(e.target.checked);
                  // 既定は年度末まで。毎回カレンダーから3/31を探させないため
                  if (e.target.checked && !repeatUntil) setRepeatUntil(thisFyEnd);
                }}
                style={{ width: 18, height: 18, flexShrink: 0 }} />
              <span style={{ fontSize: 13.5, fontWeight: 700 }}>毎週この曜日に繰り返す</span>
            </label>
            {repeat && (
              <div style={{ marginTop: 10 }}>
                <label style={label}>いつまで</label>
                {/* 年度末が近いときだけ、来年度末も選べるようにする（2026-08-29 ユーザー確定）。
                    3月に始まるレッスンは翌年度も続くのが普通なので、
                    ここで作れないと年度更新を待つことになる */}
                {nearFiscalEnd && (
                  <div style={{ display: 'flex', gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>
                    <button type="button" onClick={() => setRepeatUntil(thisFyEnd)}
                      style={pill(repeatUntil === thisFyEnd)}>
                      今年度末まで（{formFy + 1}/3/31）
                    </button>
                    <button type="button" onClick={() => setRepeatUntil(nextFyEnd)}
                      style={pill(repeatUntil === nextFyEnd)}>
                      来年度末まで（{formFy + 2}/3/31）
                    </button>
                  </div>
                )}
                {/* 🚨 max を付けて、打ち間違いで何十年も先の日付が入らないようにする
                    （実機確認で「92520年」と打ててしまい、黙って60回作られる状態だった） */}
                <input type="date" value={repeatUntil} min={shiftDate(date, 7)} max={maxRepeatUntil}
                  onChange={e => setRepeatUntil(e.target.value)} style={input} />
                <p style={{ fontSize: 12, color: textMid, margin: '6px 0 0', lineHeight: 1.6 }}>
                  {repeatUntil
                    ? (() => {
                        const ds = weeklyDates(date, repeatUntil);
                        if (!ds.length) return '終わりの日は、開始の日より後にしてください';
                        const capped = repeatUntil > maxRepeatUntil;
                        return `${ds.length}回 予約します（${ds.slice(0, 3).map(formatDateLabel).join('、')}${ds.length > 3 ? ' …' : ''}）`
                          + (capped
                              ? ` ※${maxRepeatUntil.split('-')[0]}年3月31日（年度末）までにしてください`
                              : '');
                      })()
                    : `終わりの日を入れてください（${formFy + 1}/3/31 の年度末までが基本です）`}
                </p>
              </div>
            )}
          </div>
        )}

        {error && (
          <div style={{ background: isDark ? '#4a2a2a' : '#fdecea', border: `1px solid ${isDark ? '#7a4444' : '#f5c6cb'}`, color: isDark ? '#ffb4b4' : '#a3282a', borderRadius: 8, padding: '10px 12px', fontSize: 13.5 }}>
            {error}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={onClose} disabled={saving}
            style={{ flex: 1, padding: '11px', borderRadius: 8, border: `1px solid ${line}`, background: 'transparent', color: textMid, fontSize: 14, cursor: 'pointer' }}>
            やめる
          </button>
          {/* 🚨 入れられないと分かっているときは押させない。
              押せるのに弾かれる状態は「画面が嘘をつく」ことになる（繰り返しの初回も同じ理由で止まる） */}
          <button onClick={save} disabled={saving || blocked}
            title={blocked ? (verdict?.reason ?? '') : undefined}
            style={{ flex: 2, padding: '11px', borderRadius: 8, border: 'none', background: accent, color: isDark ? '#1d2a24' : '#fff', fontSize: 14, fontWeight: 700, cursor: saving ? 'wait' : (blocked ? 'not-allowed' : 'pointer'), opacity: (saving || blocked) ? .5 : 1 }}>
            {saving ? '保存しています…' : (blocked ? 'この時間には入れられません' : (editing ? '変更を保存する' : '予約する'))}
          </button>
        </div>
      </div>
    </Overlay>
  );
};

// ============================================================
// 出欠の選択肢の設定（社員が変更できる・2026-09-01 ユーザー指示）
//
// 🚨 コードに固定しないこと。あとで「振替」等を足すのにデプロイが要るため。
// 🚨 一度使った選択肢は**消さずに隠す**。過去の記録に名前が残っているため。
// ============================================================
const AttendanceOptionSettings: React.FC<{
  options: AttendanceOption[];
  onDone: (msg: string) => Promise<void>;
  isDark: boolean;
}> = ({ options, onDone, isDark }) => {
  const [name, setName] = useState('');
  const [present, setPresent] = useState(false);
  const [purposes, setPurposes] = useState<string[]>([]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const line = isDark ? '#3a3a5c' : '#e0e0e0';
  const text = isDark ? '#eeeeee' : '#222222';
  const textMid = isDark ? '#b3b8c6' : '#5b6270';
  const accent = isDark ? '#6bbd92' : '#2f6f4f';
  const fieldBg = isDark ? '#495057' : '#fff';
  const input: React.CSSProperties = {
    padding: '7px 9px', borderRadius: 8, border: `1px solid ${line}`,
    background: fieldBg, color: text, fontSize: 16, boxSizing: 'border-box',
  };

  const sorted = [...options].sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name, 'ja'));

  const add = async () => {
    const n = name.trim();
    if (!n) { setError('出欠の名前を入れてください'); return; }
    if (options.some(o => o.name === n)) {
      setError(`「${n}」はもう登録されています（隠している場合は「戻す」を押してください）`);
      return;
    }
    setBusy('__new__'); setError('');
    const { data: me } = await supabase.auth.getUser();
    const orders = options.map(o => o.sort_order);
    const { error: err } = await supabase.from('room_attendance_options').insert({
      name: n, counts_present: present,
      // 🚨 用途を1つも選んでいなければ null（＝全用途で出す）
      purposes: purposes.length ? purposes : null,
      sort_order: (orders.length ? Math.max(...orders) : 0) + 1,
      updated_by: me.user?.id ?? null,
    });
    setBusy('');
    if (err) { setError('追加できませんでした。通信を確認してもう一度お試しください。'); return; }
    setName(''); setPresent(false); setPurposes([]);
    await onDone(`出欠に「${n}」を足しました`);
  };

  /** 出席扱い・表示/非表示の切り替え。🚨 update は0件でもエラーにならないので件数を数える */
  const patch = async (o: AttendanceOption, v: Partial<AttendanceOption>, msg: string) => {
    setBusy(o.id); setError('');
    const { data: me } = await supabase.auth.getUser();
    const { data, error: err } = await supabase.from('room_attendance_options')
      .update({ ...v, updated_at: new Date().toISOString(), updated_by: me.user?.id ?? null })
      .eq('id', o.id).select('id');
    setBusy('');
    if (err || !data || data.length === 0) { setError('変えられませんでした。権限か通信を確認してください。'); return; }
    await onDone(msg);
  };

  const move = async (o: AttendanceOption, dir: -1 | 1) => {
    const i = sorted.findIndex(x => x.id === o.id);
    const other = sorted[i + dir];
    if (!other) return;
    setBusy(o.id); setError('');
    const now = new Date().toISOString();
    const r1 = await supabase.from('room_attendance_options')
      .update({ sort_order: other.sort_order, updated_at: now }).eq('id', o.id).select('id');
    const r2 = await supabase.from('room_attendance_options')
      .update({ sort_order: o.sort_order, updated_at: now }).eq('id', other.id).select('id');
    setBusy('');
    if (r1.error || r2.error || !r1.data?.length || !r2.data?.length) {
      setError('並び替えできませんでした。通信を確認してもう一度お試しください。');
      return;
    }
    await onDone('並びを変えました');
  };

  // 🚨 key は用途名だけにしない。表示用・支払い用・追加用で同じ用途のボタンが並ぶため
  const purposeChip = (key: string, p: string, on: boolean, onClick: () => void) => (
    <button key={key} onClick={onClick}
      style={{
        padding: '3px 10px', borderRadius: 999, fontSize: 12, fontWeight: 700, cursor: 'pointer',
        border: `2px solid ${on ? '#1565c0' : '#90caf9'}`,
        background: on ? '#1976d2' : '#e3f2fd', color: on ? '#fff' : '#1565c0',
      }}>{p}</button>
  );

  return (
    <div>
      <div style={{ background: isDark ? '#35354e' : '#f0f2f5', borderRadius: 8, padding: '10px 12px', fontSize: 13, lineHeight: 1.7, marginBottom: 14, color: textMid }}>
        予約に付ける出欠のボタンを決めます。
        <b>出席扱い</b>を入れると、来ていなくても出席として数えます（「キャン1回消化」など）。
        <br />
        <b>用途</b>を選ぶとその用途だけに出ます。1つも選ばなければ全部の用途に出ます
        （「連絡なし休み」はパーソナルだけ、といった使い方）。
        <br />
        🚨 使わなくなったものは<b>消さずに「隠す」</b>でお願いします（過去の記録に名前が残っているため）。
        <b>出席扱いを後から変えても、すでに付けた記録の意味は変わりません</b>（記録した時点の扱いを残しています）。
      </div>

      {error && (
        <div style={{ background: isDark ? '#4a2a2a' : '#fdecea', border: `1px solid ${isDark ? '#7a4444' : '#f5c6cb'}`, color: isDark ? '#ffb4b4' : '#a3282a', borderRadius: 8, padding: '9px 12px', fontSize: 13, marginBottom: 12 }}>
          {error}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 }}>
        {sorted.map((o, i, arr) => (
          <div key={o.id} style={{ border: `1px solid ${line}`, borderRadius: 8, padding: '9px 11px' }}>
            <div style={{ display: 'flex', gap: 7, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13.5, fontWeight: 700, color: o.active ? text : textMid, minWidth: 108 }}>
                {o.name}{!o.active && '（隠しています）'}
              </span>
              <label style={{ display: 'flex', gap: 5, alignItems: 'center', fontSize: 12.5, cursor: 'pointer', color: textMid }}>
                <input type="checkbox" checked={o.counts_present} disabled={busy === o.id}
                  onChange={e => patch(o, { counts_present: e.target.checked },
                    e.target.checked ? `「${o.name}」を出席扱いにしました` : `「${o.name}」を出席扱いから外しました`)}
                  style={{ width: 16, height: 16 }} />
                出席扱い
              </label>
              <button onClick={() => move(o, -1)} disabled={i === 0 || busy === o.id}
                style={{ padding: '3px 9px', borderRadius: 8, border: `1px solid ${line}`, background: 'transparent', color: textMid, fontSize: 12.5, cursor: i === 0 ? 'default' : 'pointer', opacity: i === 0 ? .4 : 1 }}>↑</button>
              <button onClick={() => move(o, 1)} disabled={i === arr.length - 1 || busy === o.id}
                style={{ padding: '3px 9px', borderRadius: 8, border: `1px solid ${line}`, background: 'transparent', color: textMid, fontSize: 12.5, cursor: i === arr.length - 1 ? 'default' : 'pointer', opacity: i === arr.length - 1 ? .4 : 1 }}>↓</button>
              <button onClick={() => patch(o, { active: !o.active }, o.active ? `「${o.name}」を出さないようにしました` : `「${o.name}」を出すようにしました`)}
                disabled={busy === o.id}
                style={{ padding: '3px 11px', borderRadius: 8, border: `1px solid ${line}`, background: 'transparent', color: textMid, fontSize: 12.5, cursor: busy === o.id ? 'wait' : 'pointer' }}>
                {o.active ? '隠す' : '戻す'}
              </button>
            </div>
            <div style={{ display: 'flex', gap: 5, alignItems: 'center', flexWrap: 'wrap', marginTop: 7 }}>
              <span style={{ fontSize: 12, color: textMid, minWidth: 34 }}>用途</span>
              {activePurposes().map(p => {
                const on = !!o.purposes?.includes(p);
                return purposeChip(`show-${p}`, p, on, () => {
                  const next = on ? (o.purposes ?? []).filter(x => x !== p) : [...(o.purposes ?? []), p];
                  patch(o, { purposes: next.length ? next : null },
                    next.length ? `「${o.name}」を ${next.join('・')} だけに出します` : `「${o.name}」を全部の用途に出します`);
                });
              })}
              {(!o.purposes || o.purposes.length === 0) && (
                <span style={{ fontSize: 12, color: textMid }}>（全部の用途に出ます）</span>
              )}
            </div>
            {/* 支払いの記入欄を出す用途（2026-09-01 ユーザー指示）。
                🚨 上の「用途」とは別物。出席は全用途に出すが、支払い欄はプライベートだけ、
                   という形にできるように分けてある */}
            <div style={{ display: 'flex', gap: 5, alignItems: 'center', flexWrap: 'wrap', marginTop: 5 }}>
              <span style={{ fontSize: 12, color: textMid, minWidth: 34 }}>支払い</span>
              {activePurposes().map(p => {
                const on = !!o.payment_purposes?.includes(p);
                return purposeChip(`pay-${p}`, p, on, () => {
                  const next = on
                    ? (o.payment_purposes ?? []).filter(x => x !== p)
                    : [...(o.payment_purposes ?? []), p];
                  patch(o, { payment_purposes: next.length ? next : null },
                    next.length
                      ? `「${o.name}」に ${next.join('・')} の支払い欄を出します`
                      : `「${o.name}」の支払い欄を出さないようにしました`);
                });
              })}
              {(!o.payment_purposes || o.payment_purposes.length === 0) && (
                <span style={{ fontSize: 12, color: textMid }}>（支払い欄は出ません）</span>
              )}
            </div>
          </div>
        ))}
      </div>

      <div style={{ borderTop: `1px solid ${line}`, paddingTop: 11 }}>
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 7 }}>新しく足す</div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 7 }}>
          <input value={name} onChange={e => setName(e.target.value)}
            placeholder="例：振替" style={{ ...input, flex: 1, minWidth: 140 }} />
          <label style={{ display: 'flex', gap: 5, alignItems: 'center', fontSize: 12.5, cursor: 'pointer', color: textMid }}>
            <input type="checkbox" checked={present} onChange={e => setPresent(e.target.checked)}
              style={{ width: 16, height: 16 }} />
            出席扱い
          </label>
          <button onClick={add} disabled={busy === '__new__'}
            style={{ padding: '7px 14px', borderRadius: 8, border: `1px solid ${accent}`, background: 'transparent', color: accent, fontSize: 13.5, fontWeight: 700, cursor: busy === '__new__' ? 'wait' : 'pointer' }}>
            {busy === '__new__' ? '追加中...' : '追加'}
          </button>
        </div>
        <div style={{ display: 'flex', gap: 5, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, color: textMid, minWidth: 34 }}>用途</span>
          {activePurposes().map(p => purposeChip(`new-${p}`, p, purposes.includes(p), () =>
            setPurposes(prev => prev.includes(p) ? prev.filter(x => x !== p) : [...prev, p])))}
          {purposes.length === 0 && (
            <span style={{ fontSize: 12, color: textMid }}>（選ばなければ全部の用途に出ます）</span>
          )}
        </div>
      </div>
    </div>
  );
};

// ============================================================
// 出欠をまとめて付ける画面（予約表の上のボタンから開く・2026-09-01 ユーザー指示）
//
// 見ている日付の予約を、参加者ごとに1行ずつ並べる。終業後にまとめて押していく用。
// 🚨 未入力に赤いバッジは付けない。押して消せない赤は「関係者全員が自分の番だと思い、
//    結局誰も動かない」形になる（備品購入申請で踏んだ失敗）。件数を出すだけにする。
// ============================================================
/** 出欠の記録に、その予約の情報をくっつけたもの（集計で使う） */
interface AttendanceJoined extends AttendanceRow {
  room_bookings: {
    starts_at: string;
    floor_id: string;
    purpose: string;
    detail: string | null;
    staff_id: string | null;
    deleted_at: string | null;
  } | null;
}

/**
 * 出欠の集計（2026-09-01 ユーザー指示）。
 * お客様ごと・日ごと・担当ごとに切り替えられる。期間は「月」と「開始〜終了」の両方。
 *
 * 🚨 支払いの覚書（「2/10」など）は**計算しない**。書いた文字をそのまま並べるだけ。
 *    「何回目 / 何回払い」であって分数ではないため。照合は人が目で行う。
 */
const AttendanceSummary: React.FC<{
  /** 画面を開いたときに見ていた日。月の初期値をここから決める */
  today: string;
  floors: Floor[];
  campuses: Campus[];
  staff: Staff[];
  options: AttendanceOption[];
  isDark: boolean;
}> = ({ today, floors, campuses, staff, options, isDark }) => {
  const [mode, setMode] = useState<'month' | 'range'>('month');
  const [month, setMonth] = useState(today.slice(0, 7));       // 'YYYY-MM'
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [axis, setAxis] = useState<'customer' | 'day' | 'staff' | 'purpose'>('customer');
  /**
   * 用途の絞り込み（2026-09-01 ユーザー指示）。'' = すべて。
   * 🚨 出欠は用途によって意味が変わる（10回区切りの照合はプライベートだけが対象）。
   *    全用途を混ぜたままだと、どの数字を見ればよいか判断できない。
   */
  const [purposeFilter, setPurposeFilter] = useState('');
  const [rows, setRows] = useState<AttendanceJoined[]>([]);
  // 期間ぶんの予約。未入力を数えるために必要（記録だけだと付けていない予約が見えない）
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [capped, setCapped] = useState(false);

  const line = isDark ? '#3a3a5c' : '#e0e0e0';
  const text = isDark ? '#eeeeee' : '#222222';
  const textMid = isDark ? '#b3b8c6' : '#5b6270';
  const accent = isDark ? '#6bbd92' : '#2f6f4f';
  const fieldBg = isDark ? '#495057' : '#fff';
  const input: React.CSSProperties = {
    padding: '6px 9px', borderRadius: 8, border: `1px solid ${line}`,
    background: fieldBg, color: text, fontSize: 16, boxSizing: 'border-box',
  };
  const smallBtn = (on: boolean): React.CSSProperties => ({
    padding: '5px 12px', borderRadius: 999, fontSize: 12.5, cursor: 'pointer',
    border: `1px solid ${on ? accent : line}`,
    background: on ? accent : 'transparent',
    color: on ? (isDark ? '#1d2a24' : '#fff') : textMid,
    fontWeight: on ? 700 : 400,
  });

  // 期間の始まりと終わり（終わりは「その日を含む」）
  const period = useMemo(() => {
    if (mode === 'month') {
      const [y, m] = month.split('-').map(Number);
      const s = new Date(y, m - 1, 1);
      const e = new Date(y, m, 1);                 // 翌月1日（含まない）
      return { start: s, end: e, label: `${y}年${m}月` };
    }
    const s = new Date(`${from}T00:00:00`);
    const e = new Date(`${to}T00:00:00`);
    e.setDate(e.getDate() + 1);                    // 終了日を含める
    return { start: s, end: e, label: `${formatDateLabel(from)}〜${formatDateLabel(to)}` };
  }, [mode, month, from, to]);

  /**
   * 期間ぶんの「予約」と「出欠」を読む。
   *
   * 🚨 **予約のほうも読む**（2026-09-01 ユーザー指示で未入力を出せるようにした）。
   *    出欠の記録だけを読むと、**まだ付けていない予約が集計に現れない**ため、
   *    「入れ忘れているのか、そもそも予約が無いのか」が分からなかった。
   * 🚨 Supabase は件数を指定しないと **1000件で黙って打ち切る**。
   *    分けて読み、上限に達したら画面に断りを出す（静かに欠けさせない）。
   */
  const load = useCallback(async () => {
    setLoading(true); setError(''); setCapped(false);
    const CHUNK = 1000;
    const MAX = 20000;

    // ① その期間の予約。🚨 休講と募集中の枠は出欠の対象にしない（まとめて付ける画面と同じ条件）。
    //    ただし「お休み」（お客様都合・cancel_kind='absence'）は**含める**。
    //    外すとキャンセル料・キャン1回消化の回数消化が10回区切りの照合から漏れる（2026-09-02）
    const bs: Booking[] = [];
    for (let f = 0; ; f += CHUNK) {
      const { data, error: err } = await supabase
        .from('room_bookings').select('*')
        .is('deleted_at', null)
        .or('status.eq.active,and(status.eq.cancelled,cancel_kind.eq.absence)')
        .neq('kind', 'open')
        .gte('starts_at', period.start.toISOString())
        .lt('starts_at', period.end.toISOString())
        .order('starts_at')
        .range(f, f + CHUNK - 1);
      if (err) {
        setError('集計を読み込めませんでした。通信を確認してもう一度お試しください。');
        setLoading(false); return;
      }
      const part = (data ?? []) as Booking[];
      bs.push(...part);
      if (part.length < CHUNK) break;
      if (bs.length >= MAX) { setCapped(true); break; }
    }

    // ② その期間の出欠。予約に紐づけて絞る（予約のIDを並べて渡すとURLが長くなりすぎる）
    const out: AttendanceJoined[] = [];
    for (let f = 0; ; f += CHUNK) {
      const { data, error: err } = await supabase
        .from('room_booking_attendance')
        .select('*, room_bookings!inner(starts_at, floor_id, purpose, detail, staff_id, deleted_at)')
        .is('room_bookings.deleted_at', null)
        .gte('room_bookings.starts_at', period.start.toISOString())
        .lt('room_bookings.starts_at', period.end.toISOString())
        .range(f, f + CHUNK - 1);
      if (err) {
        setError('集計を読み込めませんでした。通信を確認してもう一度お試しください。');
        setLoading(false); return;
      }
      const part = (data ?? []) as AttendanceJoined[];
      out.push(...part);
      if (part.length < CHUNK) break;
      if (out.length >= MAX) { setCapped(true); break; }
    }

    setBookings(bs);
    setRows(out);
    setLoading(false);
  }, [period]);

  useEffect(() => { load(); }, [load]);

  const staffName = (id: string | null) => staff.find(s => s.id === id)?.name ?? '担当なし';
  const placeOf = (floorId: string) => {
    const f = floors.find(x => x.id === floorId);
    const c = f ? campuses.find(x => x.id === f.campus_id) : null;
    return f ? placeLabel(f, c?.name ?? '', floors.filter(x => x.campus_id === f.campus_id).length, true) : '';
  };

  /**
   * 集計のもとになる「対象」。**参加者1人＝1件**。
   * 出欠が付いていなければ `att` が null（＝未入力）。
   *
   * 🚨 予約から作る（記録から作らない）。記録から作ると、
   *    まだ付けていない予約が数に入らず「未入力」が出せない。
   * 🚨 用途の絞り込みはここで済ませる。表もCSVも件数もこの1つから作るので食い違わない。
   */
  const shown = useMemo(() => {
    const key = (bid: string, no: string, name: string) => `${bid}|${no}|${name}`;
    const map = new Map(rows.map(r => [key(r.booking_id, r.participant_no, r.participant_name), r]));
    return bookings
      .filter(b => !purposeFilter || b.purpose === purposeFilter)
      .flatMap(b => participantsOf(b).map(p => ({
        b, p, att: map.get(key(b.id, p.no, p.name)) ?? null,
      })));
  }, [bookings, rows, purposeFilter]);

  const missing = shown.filter(s => !s.att).length;

  // 並べる軸ごとにまとめる。列は「出欠の種類ごとの件数」
  const groups = useMemo(() => {
    const map = new Map<string, { label: string; counts: Record<string, number>; present: number; missing: number; notes: string[] }>();
    for (const s of shown) {
      const { b, p, att } = s;
      let key: string, label: string;
      if (axis === 'customer') {
        key = `${p.no}|${p.name}`;
        label = p.name && p.no ? `${p.name}（${p.no}）` : participantLabelOf(p);
      } else if (axis === 'day') {
        key = localDate(b.starts_at);
        label = formatDateLabel(key);
      } else if (axis === 'purpose') {
        // 🚨 詳細（体操など）まで分けない。分けたい人は用途で絞ってから見る
        key = b.purpose;
        label = key || '（用途なし）';
      } else {
        key = b.staff_id ?? '__none__';
        label = staffName(b.staff_id);
      }
      const g = map.get(key) ?? { label, counts: {}, present: 0, missing: 0, notes: [] };
      if (att) {
        g.counts[att.status] = (g.counts[att.status] ?? 0) + 1;
        if (att.counted_present) g.present++;
        if (att.payment_note) g.notes.push(att.payment_note);
      } else {
        g.missing++;
      }
      map.set(key, g);
    }
    const list = [...map.entries()].map(([key, g]) => ({ key, ...g }));
    // 用途ごとは予約フォームと同じ並び、日ごとは日付順、それ以外は件数の多い順
    if (axis === 'purpose') {
      return list.sort((a, b) => purposeOrder(a.key) - purposeOrder(b.key) || a.key.localeCompare(b.key, 'ja'));
    }
    return axis === 'day'
      ? list.sort((a, b) => a.key.localeCompare(b.key))
      : list.sort((a, b) => {
          const n = (x: typeof a) => Object.values(x.counts).reduce((s, v) => s + v, 0);
          return n(b) - n(a) || a.label.localeCompare(b.label, 'ja');
        });
  }, [shown, axis, staff]);

  // 表に出す列（隠した選択肢でも、記録があれば出す）
  const columns = useMemo(() => {
    const names = options.filter(o => o.active).map(o => o.name);
    for (const s of shown) if (s.att && !names.includes(s.att.status)) names.push(s.att.status);
    return names;
  }, [options, shown]);

  /**
   * CSVは**明細**（1行＝参加者1人）で出す。
   * 🚨 画面の集計をそのまま出さない。10回区切りの一覧表と突き合わせるには、
   *    いつ・誰が・何回目か が1行ずつ並んでいるほうが照合しやすいため。
   * 🚨 **未入力の行も出す**（出欠の欄が空になる）。入れ忘れを探すのに使えるようにするため。
   */
  const exportCsv = () => {
    const esc = (v: string) => `"${(v ?? '').replace(/"/g, '""')}"`;
    const head = ['日付', '開始', '場所', '用途', '担当', '会員番号', 'お客様', '出欠', '出席扱い', '支払い'];
    const body = shown.map(({ b, p, att }) => [
      localDate(b.starts_at),
      hhmm(b.starts_at),
      placeOf(b.floor_id),
      b.detail ? `${b.purpose}・${b.detail}` : b.purpose,
      staffName(b.staff_id),
      p.no,
      p.name,
      att ? att.status : '',
      att?.counted_present ? '○' : '',
      att?.payment_note ?? '',
    ].map(esc).join(','));
    downloadCSV([head.map(esc).join(','), ...body].join('\r\n'),
      `出欠_${mode === 'month' ? month : `${from}_${to}`}${purposeFilter ? '_' + purposeFilter : ''}.csv`);
  };

  const shiftMonth = (d: number) => {
    const [y, m] = month.split('-').map(Number);
    const dt = new Date(y, m - 1 + d, 1);
    setMonth(`${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`);
  };

  return (
    <div>
      <div style={{ background: isDark ? '#35354e' : '#f0f2f5', borderRadius: 8, padding: '10px 12px', fontSize: 13, lineHeight: 1.7, marginBottom: 12, color: textMid }}>
        期間の出欠をまとめます（<b style={{ color: text }}>全校ぶん</b>）。
        まだ付けていないものは<b style={{ color: text }}>未入力</b>として数えます
        （休講と募集中の枠は数えません）。
        支払いの欄は<b style={{ color: text }}>書いた文字をそのまま</b>並べています
        （「2/10」は分数ではないので足し算はしません）。
        <br />
        10回区切りの一覧表と照合するときは、<b style={{ color: text }}>CSV（明細）</b>のほうが
        1行ずつ並ぶので見比べやすいです。
      </div>

      {/* 期間 */}
      <div style={{ display: 'flex', gap: 7, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
        <button onClick={() => setMode('month')} style={smallBtn(mode === 'month')}>月ごと</button>
        <button onClick={() => setMode('range')} style={smallBtn(mode === 'range')}>期間を指定</button>
        {mode === 'month' ? (
          <>
            <button onClick={() => shiftMonth(-1)} style={{ ...smallBtn(false), padding: '5px 11px' }} aria-label="前の月">◀</button>
            <b style={{ fontSize: 14, minWidth: 96, textAlign: 'center' }}>{period.label}</b>
            <button onClick={() => shiftMonth(1)} style={{ ...smallBtn(false), padding: '5px 11px' }} aria-label="次の月">▶</button>
          </>
        ) : (
          <>
            <input type="date" value={from} onChange={e => setFrom(e.target.value)} style={input} />
            <span style={{ fontSize: 13, color: textMid }}>〜</span>
            <input type="date" value={to} onChange={e => setTo(e.target.value)} style={input} />
          </>
        )}
      </div>

      {/* 用途の絞り込み（2026-09-01 ユーザー指示）。
          🚨 出欠は用途によって意味が変わる（10回区切りの照合はプライベートだけ）。
             混ぜたままだと、どの数字を見ればよいか判断できない。
             色は予約表の用途の色に合わせる（同じ意味には同じ色） */}
      <div style={{ display: 'flex', gap: 7, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
        <span style={{ fontSize: 12.5, color: textMid }}>用途</span>
        <button onClick={() => setPurposeFilter('')} style={smallBtn(purposeFilter === '')}>すべて</button>
        {activePurposes().map(p => {
          const on = purposeFilter === p;
          const [fg, bgc] = purposeColor(p, isDark);
          return (
            <button key={p} onClick={() => setPurposeFilter(on ? '' : p)}
              style={{
                padding: '5px 12px', borderRadius: 999, fontSize: 12.5, cursor: 'pointer',
                border: `1px solid ${on ? fg : line}`,
                background: on ? bgc : 'transparent',
                color: on ? fg : textMid,
                fontWeight: on ? 700 : 400,
              }}>{p}</button>
          );
        })}
      </div>

      {/* 並べ方 */}
      <div style={{ display: 'flex', gap: 7, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <span style={{ fontSize: 12.5, color: textMid }}>並べ方</span>
        <button onClick={() => setAxis('customer')} style={smallBtn(axis === 'customer')}>お客様ごと</button>
        <button onClick={() => setAxis('purpose')} style={smallBtn(axis === 'purpose')}>用途ごと</button>
        <button onClick={() => setAxis('day')} style={smallBtn(axis === 'day')}>日ごと</button>
        <button onClick={() => setAxis('staff')} style={smallBtn(axis === 'staff')}>担当ごと</button>
        <button onClick={exportCsv} disabled={shown.length === 0}
          style={{ ...smallBtn(false), marginLeft: 'auto', opacity: shown.length === 0 ? .5 : 1 }}>
          CSV（明細）
        </button>
      </div>

      {error && (
        <div style={{ background: isDark ? '#4a2a2a' : '#fdecea', border: `1px solid ${isDark ? '#7a4444' : '#f5c6cb'}`, color: isDark ? '#ffb4b4' : '#a3282a', borderRadius: 8, padding: '9px 12px', fontSize: 13, marginBottom: 12 }}>
          {error}
        </div>
      )}
      {capped && (
        <div style={{ background: isDark ? '#4a3f2a' : '#fff6e0', border: `1px solid ${isDark ? '#7a6a44' : '#f0d9a0'}`, color: isDark ? '#e8c98a' : '#8a6a12', borderRadius: 8, padding: '9px 12px', fontSize: 13, marginBottom: 12 }}>
          件数が多いため途中までしか読めていません。期間を短くしてください。
        </div>
      )}

      {loading ? (
        <p style={{ fontSize: 13.5, color: textMid }}>読み込んでいます...</p>
      ) : shown.length === 0 ? (
        <p style={{ fontSize: 13.5, color: textMid, lineHeight: 1.7 }}>
          この期間に出欠を付ける予約がありません（休講と募集中の枠は数えていません）。
        </p>
      ) : (
        <>
          <p style={{ fontSize: 12.5, color: textMid, margin: '0 0 7px' }}>
            対象 {shown.length}人（<b style={{ color: text }}>入力済み {shown.length - missing} ／ 未入力 {missing}</b>）
            ／{axis === 'customer' ? 'お客様' : axis === 'purpose' ? '用途' : axis === 'day' ? '日' : '担当'} {groups.length}件
          </p>
          {/* 🚨 列が多いので横に伸びる。画面ごと横スクロールさせず、表だけを動かす */}
          <div style={{ overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', fontSize: 13, minWidth: 520 }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left', padding: '6px 9px', borderBottom: `2px solid ${line}`, whiteSpace: 'nowrap', color: textMid }}>
                    {axis === 'customer' ? 'お客様' : axis === 'purpose' ? '用途' : axis === 'day' ? '日付' : '担当'}
                  </th>
                  {columns.map(c => (
                    <th key={c} style={{ textAlign: 'right', padding: '6px 9px', borderBottom: `2px solid ${line}`, whiteSpace: 'nowrap', color: textMid }}>{c}</th>
                  ))}
                  <th style={{ textAlign: 'right', padding: '6px 9px', borderBottom: `2px solid ${line}`, whiteSpace: 'nowrap', color: textMid }}>未入力</th>
                  <th style={{ textAlign: 'right', padding: '6px 9px', borderBottom: `2px solid ${line}`, whiteSpace: 'nowrap', color: textMid }}>出席扱い</th>
                  {axis === 'customer' && (
                    <th style={{ textAlign: 'left', padding: '6px 9px', borderBottom: `2px solid ${line}`, whiteSpace: 'nowrap', color: textMid }}>支払い</th>
                  )}
                </tr>
              </thead>
              <tbody>
                {groups.map(g => (
                  <tr key={g.key}>
                    <td style={{ padding: '6px 9px', borderBottom: `1px solid ${line}`, whiteSpace: 'nowrap' }}>{g.label}</td>
                    {columns.map(c => (
                      <td key={c} style={{ padding: '6px 9px', borderBottom: `1px solid ${line}`, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: g.counts[c] ? text : textMid }}>
                        {g.counts[c] ?? 0}
                      </td>
                    ))}
                    <td style={{ padding: '6px 9px', borderBottom: `1px solid ${line}`, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: g.missing ? (isDark ? '#e8c98a' : '#8a6a12') : textMid, fontWeight: g.missing ? 700 : 400 }}>{g.missing}</td>
                    <td style={{ padding: '6px 9px', borderBottom: `1px solid ${line}`, textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{g.present}</td>
                    {axis === 'customer' && (
                      <td style={{ padding: '6px 9px', borderBottom: `1px solid ${line}`, color: textMid, fontVariantNumeric: 'tabular-nums' }}>
                        {g.notes.join('、') || '—'}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
};

const AttendanceDayList: React.FC<{
  date: string;
  bookings: Booking[];
  floors: Floor[];
  campuses: Campus[];
  /** 🚨 出欠が分からないときに「誰に聞けばよいか」が要るので担当を出す（2026-09-01 ユーザー指示） */
  staff: Staff[];
  options: AttendanceOption[];
  attendance: AttendanceRow[];
  canWrite: boolean;
  onSaved: () => void | Promise<void>;
  isDark: boolean;
}> = ({ date, bookings, floors, campuses, staff, options, attendance, canWrite, onSaved, isDark }) => {
  // 未入力だけに絞る（2026-09-01 ユーザー指示）。付け残しを片付けるときに使う
  const [onlyMissing, setOnlyMissing] = useState(false);
  const line = isDark ? '#3a3a5c' : '#e0e0e0';
  const text = isDark ? '#eeeeee' : '#222222';
  const textMid = isDark ? '#b3b8c6' : '#5b6270';
  const accent = isDark ? '#6bbd92' : '#2f6f4f';

  // 出欠を付けられる予約だけ。🚨 募集中の枠（まだ人がいない）と休講は除く。
  //    「お休み」（お客様都合）は**含める**（出欠の記録を見え・直せたままにする）
  const targets = bookings
    .filter(b => b.kind !== 'open' && (b.status !== 'cancelled' || isAbsence(b)))
    .filter(b => localDate(b.starts_at) === date)
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at));

  // 未入力の数え方は「参加者1人＝1つ」。予約の数ではない
  let total = 0, done = 0;
  for (const b of targets) {
    for (const p of participantsOf(b)) {
      total++;
      if (attendance.some(r => r.booking_id === b.id && r.participant_no === p.no && r.participant_name === p.name)) done++;
    }
  }

  const placeOf = (b: Booking) => {
    const f = floors.find(x => x.id === b.floor_id);
    const c = f ? campuses.find(x => x.id === f.campus_id) : null;
    // 第3引数は「その校にいくつ場所があるか」。1つだけならフロア名を書かない作り
    return f ? placeLabel(f, c?.name ?? '', floors.filter(x => x.campus_id === f.campus_id).length, true) : '';
  };

  /**
   * 用途ごとにくくる（2026-09-01 ユーザー指示）。
   * 🚨 出欠は用途によって判断が変わる（キャンセル料の扱い・支払いの要否など）ので、
   *    時刻順に混ぜて並べると付けにくい。用途でまとめ、中を時刻順にする。
   * 並びは予約フォームの用途ボタンと同じ順に揃える。知らない用途は最後にまわす。
   */
  const groups = [...new Set(targets.map(b => b.purpose))]
    .sort((a, b) => purposeOrder(a) - purposeOrder(b) || a.localeCompare(b, 'ja'))
    .map(purpose => {
      const all = targets.filter(b => b.purpose === purpose);
      let t = 0, d = 0;
      for (const b of all) {
        for (const p of participantsOf(b)) {
          t++;
          if (attendance.some(r => r.booking_id === b.id && r.participant_no === p.no && r.participant_name === p.name)) d++;
        }
      }
      /**
       * 「未入力だけ」に絞ったときの出し方。
       * 🚨 **予約ごと**に出す（参加者の行だけ隠さない）。2名のうち1人だけ未入力でも、
       *    もう1人が何になっているか見えないと、付け間違いに気づけない。
       * 🚨 件数（入力済み ◯/◯）は**絞る前の数**のまま。絞ったら残りが減ったように
       *    見えるのは、進み具合が分からなくなって困る。
       */
      const items = onlyMissing
        ? all.filter(b => participantsOf(b).some(p =>
            !attendance.some(r => r.booking_id === b.id && r.participant_no === p.no && r.participant_name === p.name)))
        : all;
      return { purpose, items, total: t, done: d };
    })
    .filter(g => g.items.length > 0);

  return (
      <div>
        <div style={{ background: isDark ? '#35354e' : '#f0f2f5', borderRadius: 8, padding: '10px 12px', fontSize: 13, lineHeight: 1.7, marginBottom: 12, color: textMid }}>
          <b style={{ color: text }}>{formatDateLabel(date)}</b> の予約です。
          押すとその場で保存されます。もう一度同じものを押すと取り消せます。
          <br />
          <b style={{ color: text }}>入力済み {done} / {total} 人</b>
          {total - done > 0 && `（未入力 ${total - done} 人）`}
        </div>

        {/* 未入力だけに絞る（2026-09-01 ユーザー指示）。付け残しを片付けるとき用 */}
        <div style={{ display: 'flex', gap: 7, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
          <span style={{ fontSize: 12.5, color: textMid }}>表示</span>
          {([[false, 'すべて'], [true, '未入力だけ']] as const).map(([v, l]) => (
            <button key={l} onClick={() => setOnlyMissing(v)}
              style={{
                padding: '5px 12px', borderRadius: 999, fontSize: 12.5, cursor: 'pointer',
                border: `1px solid ${onlyMissing === v ? accent : line}`,
                background: onlyMissing === v ? accent : 'transparent',
                color: onlyMissing === v ? (isDark ? '#1d2a24' : '#fff') : textMid,
                fontWeight: onlyMissing === v ? 700 : 400,
              }}>{l}</button>
          ))}
          {onlyMissing && total - done === 0 && (
            <span style={{ fontSize: 12.5, color: accent, fontWeight: 700 }}>すべて入力済みです</span>
          )}
        </div>

        {targets.length === 0 ? (
          <p style={{ fontSize: 13.5, color: textMid, lineHeight: 1.7 }}>
            この日は出欠を付ける予約がありません（募集中の枠と休講は出しません）。
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            {groups.map(g => {
              const [fg, bgc] = purposeColor(g.purpose, isDark);
              return (
                <div key={g.purpose}>
                  {/* 用途の見出し。色は予約表の用途の色に合わせる（同じ意味には同じ色） */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 8, flexWrap: 'wrap' }}>
                    <span style={{ background: bgc, color: fg, borderRadius: 999, padding: '3px 13px', fontSize: 13, fontWeight: 700 }}>
                      {g.purpose}
                    </span>
                    <span style={{ fontSize: 12.5, color: textMid }}>
                      {g.items.length}件／入力済み {g.done} / {g.total} 人
                      {g.total - g.done > 0 && `（未入力 ${g.total - g.done} 人）`}
                    </span>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {g.items.map(b => (
                      <div key={b.id} style={{ border: `1px solid ${line}`, borderRadius: 8, padding: '9px 11px' }}>
                        {/* 🚨 見出しに用途が出ているので、ここでは繰り返さない。
                               詳細（体操など）は用途では分からないので出す */}
                        {/* 🚨 全角スペースで間を空けない。詳細（体操など）が入ると詰まって見える
                               （2026-09-01 実機で指摘）。間隔は gap で決めて、
                               中身が変わっても一定になるようにする */}
                        <div style={{
                          display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'baseline',
                          fontSize: 13, color: textMid, marginBottom: 7, fontVariantNumeric: 'tabular-nums',
                        }}>
                          <span>{hhmm(b.starts_at)}〜{hhmm(b.ends_at)}</span>
                          <span>{placeOf(b)}</span>
                          {b.detail && <span>{b.detail}</span>}
                          {/* 🚨 担当は出欠が分からないときの「聞く先」。担当なしのときも
                                 その旨を出す（空欄だと入れ忘れと見分けが付かない） */}
                          <span style={{ color: text }}>
                            {staff.find(s => s.id === b.staff_id)?.name ?? '担当なし'}
                          </span>
                        </div>
                        <AttendanceEditor booking={b} options={options}
                          rows={attendance.filter(r => r.booking_id === b.id)}
                          canWrite={canWrite} showNameWhenSingle onSaved={onSaved} isDark={isDark} />
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
  );
};

// ============================================================
// 出欠の画面（予約表の上の「出欠」ボタンから開く）
// 「まとめて付ける」と「集計」をタブで切り替える
// ============================================================
const AttendancePanel: React.FC<{
  /** 開いたときに見ていた日。ここを起点に、この画面の中で日付を動かせる */
  date: string;
  /** いま見えている場所（校の絞り込みを引き継ぐ） */
  floorIds: string[];
  floors: Floor[];
  campuses: Campus[];
  staff: Staff[];
  options: AttendanceOption[];
  canWrite: boolean;
  /** 予約表側の出欠も読み直す（予約の詳細と食い違わないように） */
  onSaved: () => void | Promise<void>;
  onClose: () => void;
  isDark: boolean;
}> = ({ date, floorIds, floors, campuses, staff, options, canWrite, onSaved, onClose, isDark }) => {
  const [tab, setTab] = useState<'day' | 'summary'>('day');
  /**
   * この画面の中で見ている日（2026-09-01 ユーザー指示）。
   * 🚨 予約表を閉じて日付を動かす必要があったのをやめ、ここで切り替えられるようにした。
   *    そのため**この画面が自分で予約と出欠を読む**（予約表から渡されたものは使わない）。
   *    渡されたものを使うと、日付を変えたときに前の日のままになる。
   */
  const [viewDate, setViewDate] = useState(date);
  const [dayBookings, setDayBookings] = useState<Booking[]>([]);
  const [dayAttendance, setDayAttendance] = useState<AttendanceRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');

  const loadDay = useCallback(async () => {
    if (floorIds.length === 0) { setDayBookings([]); setDayAttendance([]); return; }
    setLoading(true); setLoadError('');
    const from = new Date(`${viewDate}T00:00:00`);
    const to = new Date(from);
    to.setDate(to.getDate() + 1);
    const { data, error: err } = await supabase.from('room_bookings').select('*')
      .in('floor_id', floorIds)
      .is('deleted_at', null)
      .gte('starts_at', from.toISOString())
      .lt('starts_at', to.toISOString())
      .order('starts_at');
    if (err) { setLoadError('予約を読み込めませんでした。通信を確認してください。'); setLoading(false); return; }
    const bs = (data ?? []) as Booking[];
    setDayBookings(bs);
    // 🚨 予約が0件のときは問い合わせない（in に空の配列を渡す形を作らない）
    if (bs.length === 0) { setDayAttendance([]); setLoading(false); return; }
    const { data: at } = await supabase.from('room_booking_attendance')
      .select('*').in('booking_id', bs.map(b => b.id));
    setDayAttendance((at ?? []) as AttendanceRow[]);
    setLoading(false);
  }, [viewDate, floorIds]);

  useEffect(() => { loadDay(); }, [loadDay]);

  // 出欠を付けたら、この画面と予約表の両方を読み直す
  const saved = async () => { await loadDay(); await onSaved(); };
  const line = isDark ? '#3a3a5c' : '#e0e0e0';
  const textMid = isDark ? '#b3b8c6' : '#5b6270';
  const accent = isDark ? '#6bbd92' : '#2f6f4f';
  const tabBtn = (on: boolean): React.CSSProperties => ({
    padding: '6px 14px', borderRadius: 999, fontSize: 13, cursor: 'pointer',
    border: `1px solid ${on ? accent : line}`,
    background: on ? accent : 'transparent',
    color: on ? (isDark ? '#1d2a24' : '#fff') : textMid,
    fontWeight: on ? 700 : 400,
  });

  return (
    <Overlay onClose={onClose} isDark={isDark} title="出欠" wide>
      <div>
        <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
          <button onClick={() => setTab('day')} style={tabBtn(tab === 'day')}>まとめて付ける</button>
          <button onClick={() => setTab('summary')} style={tabBtn(tab === 'summary')}>集計</button>
        </div>
        {tab === 'day' ? (
          <>
            {/* 日付の切り替え（2026-09-01 ユーザー指示）。
                🚨 別の日の出欠を見るのに、いちいち画面を閉じて予約表を動かさせない */}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
              <button onClick={() => setViewDate(todayStr())} style={tabBtn(viewDate === todayStr())}>今日</button>
              <button onClick={() => setViewDate(shiftDate(viewDate, -1))}
                style={{ ...tabBtn(false), padding: '6px 12px' }} aria-label="前の日">◀</button>
              <input type="date" value={viewDate} onChange={e => setViewDate(e.target.value)}
                style={{ padding: '6px 9px', borderRadius: 8, border: `1px solid ${line}`, background: isDark ? '#495057' : '#fff', color: isDark ? '#eeeeee' : '#222222', fontSize: 16, boxSizing: 'border-box' }} />
              <button onClick={() => setViewDate(shiftDate(viewDate, 1))}
                style={{ ...tabBtn(false), padding: '6px 12px' }} aria-label="次の日">▶</button>
              {loading && <span style={{ fontSize: 12.5, color: textMid }}>読み込んでいます…</span>}
            </div>
            {loadError && (
              <div style={{ background: isDark ? '#4a2a2a' : '#fdecea', border: `1px solid ${isDark ? '#7a4444' : '#f5c6cb'}`, color: isDark ? '#ffb4b4' : '#a3282a', borderRadius: 8, padding: '9px 12px', fontSize: 13, marginBottom: 12 }}>
                {loadError}
              </div>
            )}
            <AttendanceDayList
              date={viewDate} bookings={dayBookings} floors={floors} campuses={campuses} staff={staff}
              options={options} attendance={dayAttendance} canWrite={canWrite}
              onSaved={saved} isDark={isDark} />
          </>
        ) : (
          <AttendanceSummary
            today={viewDate} floors={floors} campuses={campuses} staff={staff}
            options={options} isDark={isDark} />
        )}
      </div>
    </Overlay>
  );
};

// ============================================================
// 出欠の入力（1件ぶん）
//
// 🚨 詳細画面と「まとめて付ける画面」の**両方でこの部品を使う**。
//    見た目と判定を1か所にまとめておかないと、片方だけ直す事故になる。
// ============================================================
const AttendanceEditor: React.FC<{
  booking: Booking;
  options: AttendanceOption[];
  /** この予約ぶんの記録だけ渡す */
  rows: AttendanceRow[];
  /**
   * 出欠を書けるか。🚨 DB側の room_is_staff()（＝パート以外）と同じ条件にすること。
   *    緩めると「押せるのに保存できないボタン」になる。
   */
  canWrite: boolean;
  /**
   * 参加者が1人だけのときにも名前を出すか。
   * 🚨 予約の詳細画面では **false**。すぐ上の「お客様」の欄と同じ名前が並んで邪魔になる
   *    （2026-09-01 実機で指摘）。2人以上のときは、どちらの出欠か分からなくなるので必ず出す。
   *    まとめて付ける画面にはお客様の欄が無いので true。
   */
  showNameWhenSingle: boolean;
  onSaved: () => void | Promise<void>;
  isDark: boolean;
}> = ({ booking: b, options, rows, canWrite, showNameWhenSingle, onSaved, isDark }) => {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  // 空き扱いの出欠（休み・キャンセル料など）を付けた直後に
  // 「キャンセル待ちが◯名います」をその場に出す（2026-09-02 ユーザー承認）。
  // 🚨 通知は飛ばさない。付けた本人にだけ見せる
  const [waitHint, setWaitHint] = useState('');
  // 待ちがいないとき「この回を空き枠にする」ボタンを出すか。
  // 🚨 全自動にはしない（ユーザー確定・1タップ方式）。出欠は押し間違いを取り消せる
  //    作りなので、自動で枠を公開すると取り消したとき空き枠だけ残って二重予約の種になる
  const [vacateOffer, setVacateOffer] = useState(false);

  const line = isDark ? '#3a3a5c' : '#e0e0e0';
  const text = isDark ? '#eeeeee' : '#222222';
  const textMid = isDark ? '#b3b8c6' : '#5b6270';

  // 🚨 休講（当社都合）の回に出欠は無い（その回自体が行われていないため）。
  //    「お休み」（お客様都合・isAbsence）は別もの：出欠の記録を見え・直せたままにする
  if (b.status === 'cancelled' && !isAbsence(b)) {
    return (
      <p style={{ fontSize: 12.5, color: textMid, margin: 0, lineHeight: 1.6 }}>
        休講なので出欠はありません。
      </p>
    );
  }
  const opts = attendanceOptionsFor(b.purpose, options);
  if (opts.length === 0) {
    return (
      <p style={{ fontSize: 12.5, color: textMid, margin: 0, lineHeight: 1.6 }}>
        この用途で選べる出欠がありません（基本設定 → 出欠の選択肢 で足せます）。
      </p>
    );
  }

  const people = participantsOf(b);

  /**
   * 空き扱いの出欠を付けたとき、この枠にキャンセル待ちがいれば案内を出す。
   * 設定（waitlist_open_statuses）と件数は押したときに読む。
   * 🚨 props で渡さない。詳細・まとめて付けるの両画面へ配線すると、
   *    必ずどこかで渡し忘れる（備品購入の「確認した」と同じ方針で自前で読む）
   */
  const checkWaitHint = async (opt: AttendanceOption | null) => {
    setWaitHint(''); setVacateOffer(false);
    if (!opt) return;
    const { data: st } = await supabase.from('room_settings')
      .select('value').eq('key', 'waitlist_open_statuses').maybeSingle();
    const open = (st?.value ?? '休み,キャンセル料').split(',').map((s: string) => s.trim()).filter(Boolean);
    if (!open.includes(opt.name)) return;
    let q = supabase.from('room_waitlist').select('id', { count: 'exact', head: true }).eq('status', 'waiting');
    q = b.recurrence_id
      ? q.or(`booking_id.eq.${b.id},recurrence_id.eq.${b.recurrence_id}`)
      : q.eq('booking_id', b.id);
    const { count } = await q;
    if (count && count > 0) {
      setWaitHint(`この枠にキャンセル待ちが ${count}名 います。予約表の上の「キャンセル待ち」から、この回に繰り上げできます（休講にする必要はありません）。`);
      return;
    }
    // 待ちがいない → 全員が空き扱いなら「空き枠にする」を出す（2026-09-02 ユーザー承認）。
    // 🚨 出欠は保存し直した直後なので、props の rows ではなくDBから読み直す。
    // 🚨 判定は「行の全部」ではなく**いまの参加者1人ずつ**で見る。過去のテストで残った
    //    キーの違う古い行（迷子の行）が1つあるだけで発動しなくなるため（2026-09-02 実機で発覚）。
    //    DB側の room_booking_all_absent() と同じ判定。片方だけ直さないこと
    const { data: att } = await supabase.from('room_booking_attendance')
      .select('participant_no, participant_name, status').eq('booking_id', b.id);
    const rowsA = (att ?? []) as { participant_no: string; participant_name: string; status: string }[];
    const ppl = participantsOf(b);
    const allAbsent = ppl.length > 0 && ppl.every(p => {
      const r = rowsA.find(a => a.participant_no === p.no && a.participant_name === p.name);
      return !!r && open.includes(r.status.trim());
    });
    if (!allAbsent) return;
    // 枠ごとの設定（空き枠を作らない枠では出さない）。単発の予約は常に出す
    if (b.recurrence_id) {
      const { data: rec } = await supabase.from('room_recurrences')
        .select('auto_open_slot').eq('id', b.recurrence_id).maybeSingle();
      if (rec && rec.auto_open_slot === false) return;
    }
    setWaitHint('キャンセル待ちはいません。この回を空き枠（募集中）にできます。');
    setVacateOffer(true);
  };

  /** その回を空き枠にする（休講化＋募集枠の作成をサーバーが1回で行う） */
  const vacate = async () => {
    setBusy('__vacate__'); setError('');
    const { data, error: err } = await supabase.rpc('room_vacate_to_open', { p_booking_id: b.id });
    const row = (Array.isArray(data) ? data[0] : data) as { ok?: boolean; reason?: string } | null;
    setBusy('');
    if (err) { setError('空き枠を作れませんでした。通信を確認してください。'); return; }
    if (!row?.ok) { setError(row?.reason ?? '空き枠を作れませんでした'); return; }
    setVacateOffer(false);
    setWaitHint('空き枠を作りました。この回は「お休み」（グレー）になり、予約表に募集中の枠（黄色の破線）が出ます。');
    await onSaved();
  };

  const pick = async (p: Participant, opt: AttendanceOption | null) => {
    setBusy(p.key); setError('');
    const msg = await saveAttendanceRow(b.id, p, opt);
    setBusy('');
    if (msg) { setError(msg); return; }
    await onSaved();
    await checkWaitHint(opt);
  };
  const savePayment = async (p: Participant, note: string) => {
    setError('');
    const msg = await savePaymentNote(b.id, p, note);
    if (msg) { setError(msg); return; }
    await onSaved();
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {error && (
        <div style={{ background: isDark ? '#4a2a2a' : '#fdecea', border: `1px solid ${isDark ? '#7a4444' : '#f5c6cb'}`, color: isDark ? '#ffb4b4' : '#a3282a', borderRadius: 8, padding: '7px 10px', fontSize: 12.5 }}>
          {error}
        </div>
      )}
      {people.map(p => {
        const cur = rows.find(r => r.participant_no === p.no && r.participant_name === p.name);
        return (
          <div key={p.key} style={{ display: 'flex', gap: 7, alignItems: 'center', flexWrap: 'wrap' }}>
            {(showNameWhenSingle || people.length > 1) && (
              <span style={{ fontSize: 13, color: text, minWidth: 108 }}>{participantLabelOf(p)}</span>
            )}
            {/* 書けない人（パート）には、押せないボタンではなく結果だけを見せる */}
            {!canWrite && (
              <span style={{ fontSize: 13, fontWeight: 700, color: cur ? text : textMid }}>
                {cur ? cur.status : '未入力'}
              </span>
            )}
            {canWrite && opts.map(o => {
              const on = cur?.status === o.name;
              return (
                // 🚨 選んでいるものをもう一度押すと取り消し（付け間違いを直せるように）
                <button key={o.id} disabled={busy === p.key}
                  onClick={() => pick(p, on ? null : o)}
                  style={{
                    padding: '5px 11px', borderRadius: 999, fontSize: 12.5, fontWeight: 700,
                    cursor: busy === p.key ? 'wait' : 'pointer',
                    border: `2px solid ${on ? '#1565c0' : '#90caf9'}`,
                    background: on ? '#1976d2' : '#e3f2fd',
                    color: on ? '#fff' : '#1565c0',
                  }}>{o.name}</button>
              );
            })}
            {canWrite && !cur && (
              <span style={{ fontSize: 12, color: textMid }}>未入力</span>
            )}
            {/* 支払いの覚書（2026-09-01 ユーザー指示）。
                プライベートの「10回区切りの一覧表」との照合に使う。
                🚨 出す・出さないは選択肢ごとの設定（payment_purposes）で決まる。
                   ここに用途名を直書きしないこと */}
            {cur && needsPaymentNote(options.find(o => o.name === cur.status), b.purpose) && (
              canWrite ? (
                <input
                  defaultValue={cur.payment_note ?? ''}
                  // 🚨 打つたびに保存しない。離れたとき（と Enter）だけ書く
                  onBlur={e => savePayment(p, e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                  placeholder="支払い 例：2/10"
                  style={{
                    padding: '4px 8px', borderRadius: 8, border: `1px solid ${line}`,
                    background: isDark ? '#495057' : '#fff', color: text,
                    fontSize: 16, width: 128, boxSizing: 'border-box',
                  }} />
              ) : (
                <span style={{ fontSize: 12.5, color: textMid }}>
                  支払い：{cur.payment_note || '未記入'}
                </span>
              )
            )}
          </div>
        );
      })}
      {waitHint && (
        <div style={{ background: isDark ? '#263b33' : '#e8f2ec', color: isDark ? '#6bbd92' : '#2f6f4f', borderRadius: 8, padding: '7px 10px', fontSize: 12.5, lineHeight: 1.6, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span>{waitHint}</span>
          {vacateOffer && (
            <button onClick={vacate} disabled={busy === '__vacate__'}
              style={{ padding: '5px 12px', borderRadius: 999, fontSize: 12.5, fontWeight: 700, border: 'none', background: isDark ? '#6bbd92' : '#2f6f4f', color: isDark ? '#1d2a24' : '#fff', cursor: busy === '__vacate__' ? 'wait' : 'pointer' }}>
              {busy === '__vacate__' ? '作っています...' : 'この回を空き枠にする'}
            </button>
          )}
        </div>
      )}
      <p style={{ fontSize: 11.5, color: textMid, margin: 0, lineHeight: 1.6, borderTop: `1px solid ${line}`, paddingTop: 6 }}>
        {canWrite
          ? '押すとその場で保存されます。もう一度同じものを押すと取り消せます。'
          : '出欠を付けられるのはパート以外の方です。ここでは記録を見るだけです。'}
      </p>
    </div>
  );
};

// ============================================================
// 予約の詳細（変更・休講・削除）
// ============================================================
const BookingDetail: React.FC<{
  booking: Booking; floors: Floor[]; campuses: Campus[];
  staff: Staff[]; categories: LessonCategory[];
  attendanceOptions: AttendanceOption[]; attendance: AttendanceRow[];
  /** 🚨 DB側の room_is_staff()（＝パート以外）と同じ条件を渡すこと */
  canAttendance: boolean;
  onAttendanceSaved: () => void | Promise<void>;
  onClose: () => void; onEdit: (b: Booking) => void; onChanged: (msg: string) => void; isDark: boolean;
}> = ({ booking: b, floors, campuses, staff, categories, attendanceOptions, attendance, canAttendance, onAttendanceSaved, onClose, onEdit, onChanged, isDark }) => {
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<'none' | 'cancel' | 'delete'>('none');
  // 繰り返しの予約は「この回だけ」か「今後すべて」かを必ず選んでもらう。
  // 🚨 これを省くと「今週だけ休みのつもりが全部消えた」事故になる（Googleカレンダーと同じ流儀）
  const [scope, setScope] = useState<'one' | 'future'>('one');
  const [error, setError] = useState('');
  // キャンセル待ち（この予約の後ろに並んでいる方）
  const [waiting, setWaiting] = useState<Waitlist[]>([]);
  const [adding, setAdding] = useState(false);
  // 🚨 予約フォーム・募集枠と**同じ部品（ParticipantRow）**を使う。
  //    素の入力欄にすると検索（番号→お名前／お名前→候補）が効かない
  //    （2026-09-02 実機で指摘。募集枠で踏んだのと同じ罠）
  const [waitPerson, setWaitPerson] = useState<PersonInput>({ no: '', name: '' });
  // 繰り返しの予約では「毎週この枠を待つ」か「この回だけ待つ」かを選ぶ（既定は毎週）。
  // 実運用は「毎週◯曜のこの枠が空いたら入りたい」がほとんどのため（2026-09-02 ユーザー承認）
  const [waitScope, setWaitScope] = useState<'weekly' | 'once'>('weekly');
  // 枠ごとの設定（2026-09-02 ユーザー承認）。繰り返しの予約でだけ意味を持つ。
  // null = まだ読めていない（読めるまでは既定＝空き枠ON・受付ONとして扱う）
  const [slotSet, setSlotSet] = useState<{ auto_open_slot: boolean; waitlist_closed: boolean } | null>(null);
  // 会員番号のコピー（どの番号をコピーしたか。数秒で消える）
  const [copiedNo, setCopiedNo] = useState('');
  // 募集枠に申込を入れるときの入力
  const [filling, setFilling] = useState(false);
  // 🚨 予約フォームと**同じ部品**を使う（会員番号の引き当て・お名前の検索）。
  //    ここだけ素の入力欄にしていたため、検索が効かなかった（2026-09-01 実機で発覚）
  const [fillPerson, setFillPerson] = useState<PersonInput>({ no: '', name: '' });
  const repeating = !!b.recurrence_id;
  const isOpen = b.kind === 'open' && b.status === 'active';
  const restSeats = Math.max(0, b.seats - b.filled);

  const floor = floors.find(f => f.id === b.floor_id);
  const campus = campuses.find(c => c.id === floor?.campus_id);
  const bStaff = staff.find(s => s.id === b.staff_id) ?? null;
  const siblingFloors = floors.filter(f => f.campus_id === floor?.campus_id).length;
  const line = isDark ? '#3a3a5c' : '#e0e0e0';
  const text = isDark ? '#eeeeee' : '#222222';
  const textMid = isDark ? '#b3b8c6' : '#5b6270';
  const accent = isDark ? '#6bbd92' : '#2f6f4f';
  const [fg, bgc] = purposeColor(b.purpose, isDark);

  /**
   * 変更の対象を決めて書き込む。
   * 「この回だけ」→ 自分1件。「今後すべて」→ 同じ繰り返しの、この回以降の分。
   * 🚨 過去の分には触らない（済んだ記録が書き換わると管理上困るため）。
   */
  const applyTo = async (patch: Record<string, unknown>) => {
    if (scope === 'future' && b.recurrence_id) {
      return supabase.from('room_bookings').update(patch)
        .eq('recurrence_id', b.recurrence_id)
        .gte('starts_at', b.starts_at)      // この回を含む今日以降だけ。過去は触らない
        .is('deleted_at', null);
    }
    return supabase.from('room_bookings').update(patch).eq('id', b.id);
  };

  // この予約（と、繰り返しならその枠）を待っている方を読む。
  // 🚨 キャンセル待ちは「毎週の枠（recurrence）」か「この回だけ（booking）」の
  //    どちらかに付く（2026-09-02〜）。繰り返しの予約では両方を合わせて出す
  const loadWaiting = useCallback(async () => {
    let q = supabase.from('room_waitlist').select('*').eq('status', 'waiting');
    q = b.recurrence_id
      ? q.or(`booking_id.eq.${b.id},recurrence_id.eq.${b.recurrence_id}`)
      : q.eq('booking_id', b.id);
    const { data } = await q.order('position').order('created_at');
    setWaiting((data ?? []) as Waitlist[]);
  }, [b.id, b.recurrence_id]);

  useEffect(() => { loadWaiting(); }, [loadWaiting]);

  // 枠ごとの設定を読む（繰り返しの予約だけ）
  useEffect(() => {
    if (!b.recurrence_id) { setSlotSet(null); return; }
    (async () => {
      const { data } = await supabase.from('room_recurrences')
        .select('auto_open_slot, waitlist_closed').eq('id', b.recurrence_id).maybeSingle();
      if (data) setSlotSet(data as { auto_open_slot: boolean; waitlist_closed: boolean });
    })();
  }, [b.recurrence_id]);

  /** 枠ごとの設定を切り替える。🚨 update は0件でもエラーにならないので件数を見る */
  const patchSlotSet = async (patch: Partial<{ auto_open_slot: boolean; waitlist_closed: boolean }>) => {
    if (!b.recurrence_id) return;
    setBusy(true); setError('');
    const { data, error: err } = await supabase.from('room_recurrences')
      .update(patch).eq('id', b.recurrence_id).select('id');
    setBusy(false);
    if (err || !data?.length) { setError('設定を変えられませんでした。通信を確認してもう一度お試しください。'); return; }
    setSlotSet(prev => ({ auto_open_slot: true, waitlist_closed: false, ...prev, ...patch }));
  };

  const addWaiting = async () => {
    if (!waitPerson.name.trim()) return;
    setBusy(true); setError('');
    const { data: me } = await supabase.auth.getUser();
    if (!me.user?.id) { setBusy(false); setError('ログインし直してください'); return; }
    // 繰り返しの予約で「毎週この枠」を選んだときは枠（recurrence）に付ける。
    // 🚨 どちらか片方だけを入れる（DBの check 制約と同じ約束）
    const weekly = !!b.recurrence_id && waitScope === 'weekly';
    const { error: err } = await supabase.from('room_waitlist').insert({
      booking_id: weekly ? null : b.id,
      recurrence_id: weekly ? b.recurrence_id : null,
      member_no: waitPerson.no.trim() || null,
      customer_label: waitPerson.name.trim(),
      // 末尾に並べる。同じ値でも受け付けた順に出るので、細かく詰め直さない
      position: waiting.length,
      created_by: me.user.id,
    });
    setBusy(false);
    if (err) { setError('追加できませんでした。通信を確認してもう一度お試しください。'); return; }
    setWaitPerson({ no: '', name: '' }); setAdding(false);
    await loadWaiting();
  };

  // 休講にする（枠は残す。消すと「空いた」と誤解されて二重に埋まるため）
  const setCancelled = async () => {
    setBusy(true); setError('');
    // 🚨 手動のこのボタンは「休講」（当社都合）。お客様都合の「お休み」（absence）は
    //    繰り上げ・空き枠化の自動処理だけが付ける
    const { error: err } = await applyTo({ status: 'cancelled', cancel_kind: 'closed', updated_at: new Date().toISOString() });
    setBusy(false);
    if (err) { setError('変更できませんでした。通信を確認してもう一度お試しください。'); return; }
    onChanged(scope === 'future' && repeating ? '今後の分をまとめて休講にしました' : '休講にしました');
  };

  // 休講を取り消して元に戻す。
  // 🚨 休講にしている間に他の予約が入っている可能性があるので、戻す前に必ず空きを確認する。
  //    確認せずに戻すと、上限を超えた状態や占有との重なりが黙って出来上がる。
  const unCancel = async () => {
    setBusy(true); setError('');
    const { data, error: chkErr } = await supabase.rpc('room_check_conflict', {
      p_floor_id: b.floor_id, p_starts_at: b.starts_at, p_ends_at: b.ends_at,
      p_exclusive: b.exclusive, p_exclude_id: b.id,
    });
    const row = Array.isArray(data) ? data[0] : data;
    if (chkErr) { setBusy(false); setError('空きを確認できませんでした。通信を確認してもう一度お試しください。'); return; }
    if (!row?.ok) { setBusy(false); setError(`元に戻せません：${row?.reason ?? 'この時間は他の予約で埋まっています'}`); return; }

    const { error: err } = await supabase.from('room_bookings')
      .update({ status: 'active', cancel_kind: 'closed', updated_at: new Date().toISOString() })
      .eq('id', b.id);
    setBusy(false);
    if (err) { setError('元に戻せませんでした。通信を確認してもう一度お試しください。'); return; }
    onChanged(`${cancelledLabel(b)}を取り消しました`);
  };

  /**
   * 募集中の枠に申込を入れる。
   * 🚨 枠を消して予約を作り直すのではなく、同じ行の種別を変える（DB側の room_fill_open_slot）。
   *    消してから作ると、その一瞬に他の人が入り込む取り合いが起きるため。
   */
  const fillSlot = async () => {
    if (!fillPerson.name.trim()) { setError('お客様のお名前を入れてください'); return; }
    setBusy(true); setError('');
    const { data, error: err } = await supabase.rpc('room_fill_open_slot', {
      p_id: b.id, p_member_no: fillPerson.no.trim(), p_customer_label: fillPerson.name.trim(), p_memo: null,
    });
    setBusy(false);
    const row = Array.isArray(data) ? data[0] : data;
    if (err) { setError('登録できませんでした。通信を確認してもう一度お試しください。'); return; }
    if (!row?.ok) { setError(row?.reason ?? '登録できませんでした'); return; }
    onChanged(row.still_open ? '申込を入れました（まだ空きがあります）' : '申込を入れて予約にしました');
  };

  // 削除は物理削除しない（誰が消したかを残す）
  const softDelete = async () => {
    setBusy(true); setError('');
    const { data: me } = await supabase.auth.getUser();
    const { error: err } = await applyTo({ deleted_at: new Date().toISOString(), deleted_by: me.user?.id ?? null });
    setBusy(false);
    if (err) { setError('削除できませんでした。通信を確認してもう一度お試しください。'); return; }
    onChanged(scope === 'future' && repeating ? '今後の分をまとめて削除しました' : '予約を削除しました');
  };

  const row = (k: string, v: React.ReactNode) => (
    <div style={{ display: 'flex', gap: 12, padding: '7px 0', borderTop: `1px solid ${line}`, fontSize: 13.5 }}>
      <span style={{ width: 86, flexShrink: 0, color: textMid }}>{k}</span>
      <span style={{ flex: 1, minWidth: 0 }}>{v}</span>
    </div>
  );

  return (
    <Overlay onClose={onClose} isDark={isDark} title="予約の内容">
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
          <span style={{ background: bgc, color: fg, borderRadius: 999, padding: '2px 11px', fontSize: 12.5, fontWeight: 700 }}>{purposeWithDetail(b)}</span>
          {isOpen && (
            <span style={{ fontSize: 12.5, fontWeight: 700, color: openSlotColor(isDark)[0] }}>
              🟡 募集中{b.seats > 1 ? `（あと${restSeats}名）` : ''}
            </span>
          )}
          {b.exclusive && <span style={{ fontSize: 12.5, fontWeight: 700 }}>🔒 貸切</span>}
          {repeating && <span style={{ fontSize: 12.5, fontWeight: 700, color: textMid }}>🔁 毎週の繰り返し</span>}
          {b.status === 'cancelled' && <span style={{ fontSize: 12.5, fontWeight: 700, color: textMid }}>{cancelledLabel(b)}</span>}
        </div>
        <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 10, fontVariantNumeric: 'tabular-nums' }}>
          {formatDateLabel(localDate(b.starts_at))} {hhmm(b.starts_at)}〜{hhmm(b.ends_at)}
        </div>

        {row('場所', placeLabel(floor, campus?.name ?? '', siblingFloors, true))}
        {bStaff && row('担当', (
          <>
            {bStaff.name}
            <span style={{ display: 'block', fontSize: 12, color: textMid }}>
              担当できる区分：{categoryLabel(bStaff, categories) || '登録がありません'}
            </span>
          </>
        ))}
        {b.is_fixed && row('固定の枠', 'はい（毎週この曜日・この時間の枠）')}
        {/* 🚨 「予約した人」は画面に出さない（2026-09-01 ユーザー指示）。
               値そのものは保存し続けている（DBでは必須）。誰が入れたかを知りたいときは
               room_bookings.booker_name を見れば分かるが、**画面からは追えなくなった**。 */}
        {/* 名前の横に学年（大学生より上の大人は年齢）を出す・2026-08-31 ユーザー指示。
            🚨 学年はその予約の日を基準に出している（年度で変わるため） */}
        {(b.customer_name || b.customer_label) && row('お客様', (
          <span>
            {b.customer_name || b.customer_label}
            {b.customer_grade && (
              <span style={{ color: textMid, fontSize: 12.5, marginLeft: 7 }}>
                {b.customer_grade}
              </span>
            )}
          </span>
        ))}
        {b.member_no && row('会員番号', (
          <span style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontVariantNumeric: 'tabular-nums' }}>{b.member_no}</span>
            {/* 🚨 2名の予約は会員番号がカンマでつながっているので、分けて渡す。
                   scholaUrl が全角スペースでつなぎ直し、1回で2人ぶん開ける */}
            <a href={scholaUrl(participantsOf(b).map(p => p.no))} target="_blank" rel="noreferrer"
              style={{ color: accent, fontSize: 12.5, fontWeight: 700, textDecoration: 'none', border: `1px solid ${accent}`, borderRadius: 999, padding: '3px 11px' }}>
              スコラプラスで予約 →
            </a>
            {/* 会員番号のコピー（2026-09-02 ユーザー指示）。
                🚨 2名の予約は「A, B」とつながっており、そのままコピーしても貼り先で
                   使えないので、**番号ごとにボタンを分ける**（ユーザー承認済み） */}
            {participantsOf(b).map(p => p.no).filter(Boolean).map((no, _, arr) => (
              <button key={no}
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(no);
                    setCopiedNo(no);
                    setTimeout(() => setCopiedNo(prev => (prev === no ? '' : prev)), 2000);
                  } catch {
                    setError('コピーできませんでした。番号を長押し（または選択）してコピーしてください。');
                  }
                }}
                style={{ color: copiedNo === no ? accent : textMid, fontSize: 12.5, fontWeight: copiedNo === no ? 700 : 400, background: 'transparent', border: `1px solid ${copiedNo === no ? accent : line}`, borderRadius: 999, padding: '3px 11px', cursor: 'pointer' }}>
                {copiedNo === no ? '✓ コピーしました' : (arr.length > 1 ? `📋 ${no}` : '📋 コピー')}
              </button>
            ))}
          </span>
        ))}
        {b.memo && row('メモ', <span style={{ whiteSpace: 'pre-wrap' }}>{b.memo}</span>)}
        {/* 出欠（2026-09-01 ユーザー指示）。
            🚨 募集中の枠はまだ人が入っていないので出さない */}
        {!isOpen && row('出欠', (
          <AttendanceEditor booking={b} options={attendanceOptions}
            rows={attendance.filter(r => r.booking_id === b.id)}
            canWrite={canAttendance} showNameWhenSingle={false}
            onSaved={onAttendanceSaved} isDark={isDark} />
        ))}

        {error && (
          <div style={{ background: isDark ? '#4a2a2a' : '#fdecea', border: `1px solid ${isDark ? '#7a4444' : '#f5c6cb'}`, color: isDark ? '#ffb4b4' : '#a3282a', borderRadius: 8, padding: '10px 12px', fontSize: 13.5, marginTop: 12 }}>
            {error}
          </div>
        )}

        {/* インライン確認（alert / confirm は使わない方針） */}
        {confirm !== 'none' && repeating && (
          <div style={{ background: isDark ? '#35354e' : '#f0f2f5', borderRadius: 8, padding: '11px 13px', marginTop: 14 }}>
            <b style={{ fontSize: 13.5, display: 'block', marginBottom: 3 }}>🔁 これは毎週の繰り返し予約です</b>
            <p style={{ fontSize: 12.5, color: textMid, margin: '0 0 9px' }}>どこまで{confirm === 'cancel' ? '休講に' : '削除'}しますか？</p>
            <div style={{ display: 'flex', gap: 7 }}>
              {([['one', 'この回だけ'], ['future', '今後すべて']] as const).map(([k, labelText]) => (
                <button key={k} onClick={() => setScope(k)}
                  style={{
                    flex: 1, padding: '9px', borderRadius: 8, fontSize: 13.5, cursor: 'pointer',
                    border: `1px solid ${scope === k ? accent : line}`,
                    background: scope === k ? accent : 'transparent',
                    color: scope === k ? (isDark ? '#1d2a24' : '#fff') : textMid,
                    fontWeight: scope === k ? 700 : 400,
                  }}>{labelText}</button>
              ))}
            </div>
            <p style={{ fontSize: 11.5, color: textMid, margin: '7px 0 0', lineHeight: 1.6 }}>
              「今後すべて」はこの回から先の分が対象です。過去の分はそのまま残ります。
            </p>
          </div>
        )}
        {confirm === 'cancel' && (
          <ConfirmBox isDark={isDark} busy={busy}
            title={repeating && scope === 'future' ? 'この回から先を、まとめて休講にしますか？' : 'この予約を休講にしますか？'}
            note="枠は「休講」として残ります。空いたと勘違いして別の予約が入るのを防ぐためです。"
            okLabel="休講にする" onOk={setCancelled} onCancel={() => { setConfirm('none'); setScope('one'); }} />
        )}
        {confirm === 'delete' && (
          <ConfirmBox isDark={isDark} busy={busy}
            title={repeating && scope === 'future' ? 'この回から先を、まとめて削除しますか？' : 'この予約を削除しますか？'}
            note="一覧から消えます。記録は残るので、あとから誰が削除したか分かります。"
            okLabel="削除する" danger onOk={softDelete} onCancel={() => { setConfirm('none'); setScope('one'); }} />
        )}

        {/* 募集中の枠に申込を入れる */}
        {isOpen && confirm === 'none' && (
          filling ? (
            <div style={{ background: isDark ? '#3a3020' : '#fdf3e2', border: `1px solid ${openSlotColor(isDark)[0]}`, borderRadius: 8, padding: '12px 14px', marginTop: 14 }}>
              <b style={{ fontSize: 14 }}>この枠に申込を入れます</b>
              {/* 🚨 予約フォームと同じ部品。会員番号を入れるとお名前が入り、
                     お名前を2文字以上入れると候補が出る（2026-09-01 ユーザー指摘で差し替え） */}
              <div style={{ marginTop: 9 }}>
                <ParticipantRow value={fillPerson} onChange={setFillPerson} onRemove={null}
                  date={localDate(b.starts_at)} isDark={isDark} />
              </div>
              <p style={{ fontSize: 11.5, color: textMid, margin: '7px 0 10px', lineHeight: 1.6 }}>
                {b.seats > 1
                  ? `あと${restSeats}名まで入れられます。定員まで埋まると「予約」に変わります。`
                  : '登録すると、この枠は「予約」に変わります。'}
              </p>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => { setFilling(false); setError(''); }} disabled={busy}
                  style={{ flex: 1, padding: '9px', borderRadius: 8, border: `1px solid ${line}`, background: 'transparent', color: textMid, fontSize: 13.5, cursor: 'pointer' }}>
                  やめる
                </button>
                <button onClick={fillSlot} disabled={busy}
                  style={{ flex: 1, padding: '9px', borderRadius: 8, border: 'none', background: accent, color: isDark ? '#1d2a24' : '#fff', fontSize: 13.5, fontWeight: 700, cursor: busy ? 'wait' : 'pointer', opacity: busy ? .7 : 1 }}>
                  {busy ? '登録しています…' : '申込を入れる'}
                </button>
              </div>
            </div>
          ) : (
            <button onClick={() => setFilling(true)}
              style={{ width: '100%', marginTop: 16, padding: '12px', borderRadius: 8, border: 'none', background: openSlotColor(isDark)[0], color: isDark ? '#241d10' : '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>
              ＋ この枠に申込を入れる
            </button>
          )
        )}

        {/* キャンセル待ち。
            🚨 予約そのものの見た目は変えない（空いていると誤解させないため）。
               ここに人数と一覧を出すだけにする。繰り上げは基本設定の一覧から行う */}
        {confirm === 'none' && !filling && (
          <div style={{ marginTop: 14, borderTop: `1px solid ${line}`, paddingTop: 12 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <b style={{ fontSize: 13 }}>キャンセル待ち {waiting.length}名</b>
              {/* 🚨 受付を締め切った枠にはボタンを出さない（枠ごとの設定・2026-09-02） */}
              {!adding && !(repeating && slotSet?.waitlist_closed) && (
                <button onClick={() => setAdding(true)}
                  style={{ marginLeft: 'auto', padding: '5px 11px', borderRadius: 999, fontSize: 12.5, border: `1px solid ${line}`, background: 'transparent', color: textMid, cursor: 'pointer' }}>
                  ＋ キャンセル待ちを追加
                </button>
              )}
              {repeating && slotSet?.waitlist_closed && (
                <span style={{ marginLeft: 'auto', fontSize: 12, color: textMid }}>
                  受付を締め切っています（下の設定で戻せます）
                </span>
              )}
            </div>

            {waiting.length > 0 && (
              <div style={{ marginTop: 7 }}>
                {waiting.map((w, i) => (
                  <div key={w.id} style={{ fontSize: 12.5, color: textMid, lineHeight: 1.8 }}>
                    {i + 1}. {w.customer_label}
                    {w.member_no ? `（${w.member_no}）` : '（一般）'}
                    {/* 繰り返しの予約では「毎週の枠の待ち」と「この回だけの待ち」が
                        混ざるので、どちらか分かるように印を付ける */}
                    {repeating && (w.recurrence_id ? '〔毎週〕' : '〔この回だけ〕')}
                    {w.note ? ` / ${w.note}` : ''}
                  </div>
                ))}
                <p style={{ fontSize: 11.5, color: textMid, margin: '5px 0 0', lineHeight: 1.6 }}>
                  繰り上げは予約表の上の「キャンセル待ち」から行います
                  （先に入れたい回を休講または取り消してください）
                </p>
              </div>
            )}

            {adding && (
              <div style={{ marginTop: 8 }}>
                {/* 毎週の枠か、この回だけか（繰り返しの予約のときだけ選べる。既定は毎週） */}
                {repeating && (
                  <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                    {(['weekly', 'once'] as const).map(s => (
                      <button key={s} onClick={() => setWaitScope(s)}
                        style={{ padding: '6px 12px', borderRadius: 999, fontSize: 12.5, cursor: 'pointer', border: `1px solid ${waitScope === s ? accent : line}`, background: waitScope === s ? accent : 'transparent', color: waitScope === s ? (isDark ? '#1d2a24' : '#fff') : textMid, fontWeight: waitScope === s ? 700 : 400 }}>
                        {s === 'weekly' ? '毎週この枠' : 'この回だけ'}
                      </button>
                    ))}
                  </div>
                )}
                {/* 🚨 予約フォーム・募集枠と同じ部品。会員番号を入れるとお名前が入り、
                       お名前を2文字以上入れると候補が出る。素の入力欄にすると検索が
                       効かない（2026-09-02 実機で指摘・募集枠と同じ罠） */}
                <ParticipantRow value={waitPerson} onChange={setWaitPerson} onRemove={null}
                  date={localDate(b.starts_at)} isDark={isDark} />
                <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                  <button onClick={addWaiting} disabled={busy || !waitPerson.name.trim()}
                    style={{ padding: '8px 14px', borderRadius: 8, border: 'none', background: accent, color: isDark ? '#1d2a24' : '#fff', fontSize: 13.5, fontWeight: 700, cursor: busy ? 'wait' : 'pointer', opacity: !waitPerson.name.trim() ? .5 : 1 }}>
                    追加
                  </button>
                  <button onClick={() => { setAdding(false); setWaitPerson({ no: '', name: '' }); }}
                    style={{ padding: '8px 12px', borderRadius: 8, border: `1px solid ${line}`, background: 'transparent', color: textMid, fontSize: 13.5, cursor: 'pointer' }}>
                    やめる
                  </button>
                </div>
              </div>
            )}

            {/* 枠ごとの設定（2026-09-02 ユーザー承認）。繰り返しの予約でだけ出す */}
            {repeating && slotSet && (
              <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 5 }}>
                <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12.5, color: textMid, cursor: 'pointer' }}>
                  <input type="checkbox" checked={slotSet.auto_open_slot} disabled={busy}
                    onChange={e => patchSlotSet({ auto_open_slot: e.target.checked })}
                    style={{ width: 16, height: 16 }} />
                  空きが出たら「空き枠にする」を出す（休みの連絡やキャンセル待ちが尽きたとき）
                </label>
                <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12.5, color: textMid, cursor: 'pointer' }}>
                  <input type="checkbox" checked={!slotSet.waitlist_closed} disabled={busy}
                    onChange={e => patchSlotSet({ waitlist_closed: !e.target.checked })}
                    style={{ width: 16, height: 16 }} />
                  キャンセル待ちを受け付ける（外すと、これ以上並べなくなります）
                </label>
              </div>
            )}
          </div>
        )}

        {confirm === 'none' && !filling && (
          <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
            <button onClick={() => onEdit(b)}
              style={{ flex: '1 1 120px', padding: '11px', borderRadius: 8, border: 'none', background: accent, color: isDark ? '#1d2a24' : '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>
              変更する
            </button>
            {b.status === 'active' ? (
              <button onClick={() => setConfirm('cancel')}
                style={{ flex: '1 1 100px', padding: '11px', borderRadius: 8, border: `1px solid ${line}`, background: 'transparent', color: text, fontSize: 14, cursor: 'pointer' }}>
                休講にする
              </button>
            ) : (
              <button onClick={unCancel} disabled={busy}
                style={{ flex: '1 1 100px', padding: '11px', borderRadius: 8, border: `1px solid ${line}`, background: 'transparent', color: text, fontSize: 14, cursor: busy ? 'wait' : 'pointer' }}>
                {cancelledLabel(b)}をやめる
              </button>
            )}
            <button onClick={() => setConfirm('delete')}
              style={{ flex: '1 1 90px', padding: '11px', borderRadius: 8, border: `1px solid ${line}`, background: 'transparent', color: isDark ? '#ff9b9b' : '#c0392b', fontSize: 14, cursor: 'pointer' }}>
              削除
            </button>
          </div>
        )}
      </div>
    </Overlay>
  );
};

// ============================================================
// 年度更新（社員まで・パートは不可）
//
//   毎週の繰り返しは年度末（3/31）で終わる。放っておくと4月以降が空になり、
//   誰も気づかないまま「空いている」と思われて二重に埋まる。
//   ここで一覧を見ながら、続けるものを選んで次の年度に作り直す。
//
//   🚨 自動では増やさない（2026-08-29 ユーザー確定）。休講や重なりの扱いを
//      間違えたときに取り返しがつかないため、人が確認して押す形にしている。
//   🚨 作成そのものはサーバーの room_renew_recurrence に任せる。画面から
//      1回ずつ作ると 30ルール×52回＝1,560回の呼び出しになり、途中で切れると
//      中途半端な状態が残る。
// ============================================================
const WEEKDAY_LABEL = ['日', '月', '火', '水', '木', '金', '土'];

/**
 * 用途詳細の設定（社員が変更できる）。
 * 用途ごとに「選べる長さ」「終了時刻を手で入れてよいか」「詳細（体操・筋トレなど）」を決める。
 * 🚨 2026-09-01 に詳細を足したので、タブ名を「長さの設定」→「用途詳細」に変えた
 *    （長さだけの画面ではなくなったため・ユーザー指示）。
 *
 * 🚨 ここを固定にすると、時間が変わるたびに開発者へ依頼することになる
 *    （2026-08-29 ユーザー指示）。
 */
const PurposeSettings: React.FC<{
  purposeDurations: PurposeDuration[];
  purposeDetails: PurposeDetail[];
  onDone: (msg: string) => Promise<void>;
  isDark: boolean;
}> = ({ purposeDurations, purposeDetails, onDone, isDark }) => {
  const [draft, setDraft] = useState<Record<string, { text: string; free: boolean; def: string; required: boolean }>>(() => {
    const d: Record<string, { text: string; free: boolean; def: string; required: boolean }> = {};
    for (const p of activePurposes()) {
      const cur = purposeDurations.find(x => x.purpose === p);
      d[p] = {
        text: (cur?.minutes ?? []).join('、'),
        free: cur ? cur.allow_free : true,
        def: cur?.default_minutes != null ? String(cur.default_minutes) : '',
        required: cur ? cur.detail_required : true,
      };
    }
    return d;
  });
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  // 詳細（体操・筋トレなど）の編集。用途ごとに「追加する名前」を持つ
  const [newDetail, setNewDetail] = useState<Record<string, string>>({});
  const [detailBusy, setDetailBusy] = useState('');
  // 名前の変更（2026-09-02 ユーザー承認・案A＝過去の予約もまとめて書き換える）
  const [renaming, setRenaming] = useState<string | null>(null);   // 変更中の詳細の id
  const [renameText, setRenameText] = useState('');
  // 「過去◯件も変わります」を見せてから実行する（null = まだ数えていない）
  const [renameCounts, setRenameCounts] = useState<{ bookings: number; recurrences: number } | null>(null);

  const line = isDark ? '#3a3a5c' : '#e0e0e0';
  const text = isDark ? '#eeeeee' : '#222222';
  const textMid = isDark ? '#b3b8c6' : '#5b6270';
  const accent = isDark ? '#6bbd92' : '#2f6f4f';
  const fieldBg = isDark ? '#495057' : '#fff';

  /**
   * 「25、30、50」のような入力を数字の並びに直す。
   * 全角の数字・読点・カンマ・空白のどれで区切っても通す（現場の入力は揃わないため）。
   * 🚨 上限を付けないと、打ち間違いで一日中ふさがる予約が作れてしまう
   */
  const parseMinutes = (raw: string): { list: number[]; bad: boolean } => {
    const half = raw.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
    const parts = half.split(/[,、\s]+/).map(s => s.trim()).filter(Boolean);
    const list: number[] = [];
    let bad = false;
    for (const p of parts) {
      const n = Number(p);
      if (!Number.isInteger(n) || n < 5 || n > 480) { bad = true; continue; }
      if (!list.includes(n)) list.push(n);
    }
    return { list: list.sort((a, b) => a - b), bad };
  };

  const save = async (purpose: string) => {
    const d = draft[purpose] ?? { text: '', free: true, def: '', required: true };
    const { list, bad } = parseMinutes(d.text);
    if (bad) { setError('長さは5〜480の数字で、「25、30、50」のように区切って入れてください'); return; }
    if (!d.free && list.length === 0) {
      setError('終了時刻を手で入れられない用途は、長さを1つ以上入れてください');
      return;
    }
    setBusy(purpose); setError('');
    const { data: me } = await supabase.auth.getUser();
    // 🚨 一覧から消えた値が既定に残らないようにする。
    //    残るとボタンが選択状態にならず「押しても変わらない」ように見える
    const def = d.def && list.includes(Number(d.def)) ? Number(d.def) : null;
    const { error: err } = await supabase.from('room_purpose_durations')
      .upsert({
        purpose, minutes: list, allow_free: d.free, default_minutes: def,
        detail_required: d.required,
        updated_at: new Date().toISOString(), updated_by: me.user?.id ?? null,
      }, { onConflict: 'purpose' });
    setBusy('');
    if (err) { setError('保存できませんでした。通信を確認してもう一度お試しください。'); return; }
    setDraft(prev => ({
      ...prev,
      [purpose]: { ...prev[purpose], text: list.join('、'), def: def != null ? String(def) : '' },
    }));
    await onDone(`${purpose}の長さを変えました`);
  };

  // ---- 詳細（体操・筋トレなど）の編集 ----------------------------------
  // 🚨 一度使った詳細は**消さない**（隠すだけ）。過去の予約に名前が残っており、
  //    消すと「どの詳細だったか」を後から確かめられなくなる。

  const detailsFor = (purpose: string) => purposeDetails
    .filter(d => d.purpose === purpose)
    .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name, 'ja'));

  const addDetail = async (purpose: string) => {
    const name = (newDetail[purpose] ?? '').trim();
    if (!name) { setError('詳細の名前を入れてください'); return; }
    // 🚨 隠してあるものとも重複させない。DBにも (用途,名前) の一意の印がある
    if (purposeDetails.some(d => d.purpose === purpose && d.name === name)) {
      setError(`「${name}」はもう登録されています（隠している場合は「戻す」を押してください）`);
      return;
    }
    setDetailBusy(purpose); setError('');
    const { data: me } = await supabase.auth.getUser();
    const orders = purposeDetails.filter(d => d.purpose === purpose).map(d => d.sort_order);
    const { error: err } = await supabase.from('room_purpose_details').insert({
      purpose, name, sort_order: (orders.length ? Math.max(...orders) : 0) + 1,
      updated_by: me.user?.id ?? null,
    });
    setDetailBusy('');
    if (err) { setError('追加できませんでした。通信を確認してもう一度お試しください。'); return; }
    setNewDetail(prev => ({ ...prev, [purpose]: '' }));
    await onDone(`${purpose}に「${name}」を足しました`);
  };

  const toggleDetail = async (d: PurposeDetail) => {
    setDetailBusy(d.id); setError('');
    const { data: me } = await supabase.auth.getUser();
    // 🚨 update は0件でもエラーにならないので、書けた件数を select で数える
    const { data, error: err } = await supabase.from('room_purpose_details')
      .update({ active: !d.active, updated_at: new Date().toISOString(), updated_by: me.user?.id ?? null })
      .eq('id', d.id).select('id');
    setDetailBusy('');
    if (err || !data || data.length === 0) { setError('変えられませんでした。権限か通信を確認してください。'); return; }
    await onDone(d.active ? `「${d.name}」を出さないようにしました` : `「${d.name}」を出すようにしました`);
  };

  /** 並び替え。となりと順番の数字を入れ替えるだけ */
  const moveDetail = async (d: PurposeDetail, dir: -1 | 1) => {
    const list = detailsFor(d.purpose);
    const i = list.findIndex(x => x.id === d.id);
    const other = list[i + dir];
    if (!other) return;
    setDetailBusy(d.id); setError('');
    const now = new Date().toISOString();
    // 🚨 同じ数字だと並びが決まらないので、必ず両方を書き換える
    const r1 = await supabase.from('room_purpose_details')
      .update({ sort_order: other.sort_order, updated_at: now }).eq('id', d.id).select('id');
    const r2 = await supabase.from('room_purpose_details')
      .update({ sort_order: d.sort_order, updated_at: now }).eq('id', other.id).select('id');
    setDetailBusy('');
    if (r1.error || r2.error || !r1.data?.length || !r2.data?.length) {
      setError('並び替えできませんでした。通信を確認してもう一度お試しください。');
      return;
    }
    await onDone('並びを変えました');
  };

  const startRename = (dt: PurposeDetail) => {
    setRenaming(dt.id); setRenameText(dt.name); setRenameCounts(null); setError('');
  };

  /** 名前を変える前に、影響する件数を数えて見せる（いきなり書き換えない） */
  const checkRename = async (dt: PurposeDetail) => {
    const name = renameText.trim();
    if (!name) { setError('新しい名前を入れてください'); return; }
    if (name === dt.name) { setRenaming(null); return; }
    if (purposeDetails.some(x => x.purpose === dt.purpose && x.name === name)) {
      setError(`「${name}」はもう登録されています（別の名前にしてください）`);
      return;
    }
    setDetailBusy(dt.id); setError('');
    const [rb, rr] = await Promise.all([
      supabase.from('room_bookings').select('id', { count: 'exact', head: true })
        .eq('purpose', dt.purpose).eq('detail', dt.name),
      supabase.from('room_recurrences').select('id', { count: 'exact', head: true })
        .eq('purpose', dt.purpose).eq('detail', dt.name),
    ]);
    setDetailBusy('');
    if (rb.error || rr.error) { setError('件数を数えられませんでした。通信を確認してもう一度お試しください。'); return; }
    setRenameCounts({ bookings: rb.count ?? 0, recurrences: rr.count ?? 0 });
  };

  /**
   * 名前の変更の本体（案A・2026-09-02 ユーザー承認）。
   * 🚨 過去の予約・繰り返しの中身も**まとめて新しい名前に書き換える**。
   *    表記の変更（例：筋トレ→筋力トレーニング）で意味は同じ、が前提。
   *    意味が変わるときは「追加して古いほうを隠す」でやってもらう（画面にも書いてある）。
   * 🚨 3回の書き込みは途中で失敗することがある。予約→繰り返し→選択肢の順に書き、
   *    失敗したらもう一度「変える」を押せば続きから直せる（旧名で残った行だけが対象になるため）。
   */
  const doRename = async (dt: PurposeDetail) => {
    const name = renameText.trim();
    setDetailBusy(dt.id); setError('');
    const { data: me } = await supabase.auth.getUser();
    const now = new Date().toISOString();
    const r1 = await supabase.from('room_bookings').update({ detail: name, updated_at: now })
      .eq('purpose', dt.purpose).eq('detail', dt.name);
    if (r1.error) { setDetailBusy(''); setError('予約の書き換えに失敗しました。もう一度「変える」を押すと続きから直せます。'); return; }
    const r2 = await supabase.from('room_recurrences').update({ detail: name })
      .eq('purpose', dt.purpose).eq('detail', dt.name);
    if (r2.error) { setDetailBusy(''); setError('繰り返しの書き換えに失敗しました。もう一度「変える」を押すと続きから直せます。'); return; }
    // 🚨 選択肢そのものは最後に。update は0件でもエラーにならないので件数を見る
    const r3 = await supabase.from('room_purpose_details')
      .update({ name, updated_at: now, updated_by: me.user?.id ?? null })
      .eq('id', dt.id).select('id');
    setDetailBusy('');
    if (r3.error || !r3.data?.length) { setError('選択肢の名前を変えられませんでした。権限か通信を確認して、もう一度お試しください。'); return; }
    setRenaming(null);
    await onDone(`「${dt.name}」を「${name}」に変えました`);
  };

  const input: React.CSSProperties = {
    padding: '7px 9px', borderRadius: 8, border: `1px solid ${line}`,
    background: fieldBg, color: text, fontSize: 16, boxSizing: 'border-box',
  };

  return (
    <div>
      <div style={{ background: isDark ? '#35354e' : '#f0f2f5', borderRadius: 8, padding: '10px 12px', fontSize: 13, lineHeight: 1.7, marginBottom: 14, color: textMid }}>
        予約フォームの「長さ」ボタンを用途ごとに決めます。
        「25、30、50」のように区切って入れてください。空にするとボタンを出しません。
        <br />
        <b>終了時刻を手で入れられる</b>を外すと、ここで決めた長さからしか選べなくなります
        （パーソナル10分・レッスン50分のように長さが決まっているもの向け）。
        <br />
        <b>詳細</b>は、その用途の中の区分です（パーソナルの「体操」「筋トレ」など）。
        足すと予約フォームに選ぶボタンが出ます。使わなくなったものは
        <b>消さずに「隠す」</b>でお願いします（過去の予約に名前が残っているため）。
      </div>

      {error && (
        <div style={{ background: isDark ? '#4a2a2a' : '#fdecea', border: `1px solid ${isDark ? '#7a4444' : '#f5c6cb'}`, color: isDark ? '#ffb4b4' : '#a3282a', borderRadius: 8, padding: '9px 12px', fontSize: 13, marginBottom: 12 }}>
          {error}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {activePurposes().map(p => {
          // 🚨 この画面を開いたまま ⚙️設定 で用途が増えた場合に備えて、無ければ既定で作る
          const d = draft[p] ?? { text: '', free: true, def: '', required: true };
          const preview = parseMinutes(d.text).list;
          return (
            <div key={p} style={{ border: `1px solid ${line}`, borderRadius: 8, padding: '10px 12px' }}>
              <div style={{ fontSize: 13.5, fontWeight: 700, marginBottom: 8 }}>{p}</div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <input value={d.text}
                  onChange={e => setDraft(prev => ({ ...prev, [p]: { ...prev[p], text: e.target.value } }))}
                  placeholder="例：25、30、50" style={{ ...input, flex: 1, minWidth: 150 }} />
                <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, cursor: 'pointer' }}>
                  <input type="checkbox" checked={d.free}
                    onChange={e => setDraft(prev => ({ ...prev, [p]: { ...prev[p], free: e.target.checked } }))}
                    style={{ width: 17, height: 17 }} />
                  終了時刻を手で入れられる
                </label>
                {/* 最初に入る長さ。並び順とは別に決められる
                    （プライベートは 25/30/50 と並べつつ、既定は30分・ユーザー指示） */}
                <label style={{ display: 'flex', gap: 5, alignItems: 'center', fontSize: 13 }}>
                  最初に入る
                  <select value={d.def}
                    onChange={e => setDraft(prev => ({ ...prev, [p]: { ...prev[p], def: e.target.value } }))}
                    style={{ ...input, padding: '5px 7px' }}>
                    <option value="">先頭（{preview[0] != null ? durationLabel(preview[0]) : 'なし'}）</option>
                    {preview.map(m => <option key={m} value={m}>{durationLabel(m)}</option>)}
                  </select>
                </label>
                <button onClick={() => save(p)} disabled={busy === p}
                  style={{ padding: '7px 14px', borderRadius: 8, border: 'none', background: accent, color: isDark ? '#1d2a24' : '#fff', fontSize: 13.5, fontWeight: 700, cursor: busy === p ? 'wait' : 'pointer' }}>
                  {busy === p ? '保存中...' : '保存'}
                </button>
              </div>
              <p style={{ fontSize: 12.5, color: textMid, margin: '7px 0 0', lineHeight: 1.6 }}>
                {preview.length > 0
                  ? `ボタン：${preview.map(durationLabel).join(' / ')}`
                  : 'ボタンは出ません'}
                {!d.free && preview.length > 0 && '（終了時刻は手で直せません）'}
              </p>

              {/* 詳細（パーソナルの「体操」「筋トレ」など・2026-09-01 ユーザー指示）。
                  🚨 一度使ったものは消さず「隠す」。過去の予約に名前が残っているため */}
              <div style={{ borderTop: `1px solid ${line}`, marginTop: 10, paddingTop: 9 }}>
                <div style={{ fontSize: 12.5, fontWeight: 700, color: textMid, marginBottom: 4 }}>
                  詳細（この用途の中の区分）
                </div>
                <p style={{ fontSize: 12, color: textMid, margin: '0 0 7px', lineHeight: 1.6 }}>
                  「名前を変える」は書き方を直すためのものです（過去の予約の表示もまとめて変わります）。
                  中身が別のものに変わるときは、新しく追加して古いほうを隠してください。
                </p>
                {detailsFor(p).length === 0 && (
                  <p style={{ fontSize: 12.5, color: textMid, margin: '0 0 7px', lineHeight: 1.6 }}>
                    まだありません。足すと、予約フォームに選ぶボタンが出ます。
                  </p>
                )}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
                  {detailsFor(p).map((dt, i, arr) => (
                    <div key={dt.id} style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 13.5, color: dt.active ? text : textMid, minWidth: 96 }}>
                          {dt.name}{!dt.active && '（隠しています）'}
                        </span>
                        <button onClick={() => moveDetail(dt, -1)} disabled={i === 0 || detailBusy === dt.id}
                          style={{ padding: '3px 9px', borderRadius: 8, border: `1px solid ${line}`, background: 'transparent', color: textMid, fontSize: 12.5, cursor: i === 0 ? 'default' : 'pointer', opacity: i === 0 ? .4 : 1 }}>↑</button>
                        <button onClick={() => moveDetail(dt, 1)} disabled={i === arr.length - 1 || detailBusy === dt.id}
                          style={{ padding: '3px 9px', borderRadius: 8, border: `1px solid ${line}`, background: 'transparent', color: textMid, fontSize: 12.5, cursor: i === arr.length - 1 ? 'default' : 'pointer', opacity: i === arr.length - 1 ? .4 : 1 }}>↓</button>
                        <button onClick={() => (renaming === dt.id ? setRenaming(null) : startRename(dt))}
                          disabled={detailBusy === dt.id}
                          style={{ padding: '3px 11px', borderRadius: 8, border: `1px solid ${line}`, background: 'transparent', color: textMid, fontSize: 12.5, cursor: detailBusy === dt.id ? 'wait' : 'pointer' }}>
                          名前を変える
                        </button>
                        <button onClick={() => toggleDetail(dt)} disabled={detailBusy === dt.id}
                          style={{ padding: '3px 11px', borderRadius: 8, border: `1px solid ${line}`, background: 'transparent', color: textMid, fontSize: 12.5, cursor: detailBusy === dt.id ? 'wait' : 'pointer' }}>
                          {dt.active ? '隠す' : '戻す'}
                        </button>
                      </div>
                      {/* 名前の変更（2026-09-02 ユーザー承認・案A）。
                          🚨 いきなり書き換えず、影響する件数を見せてから実行する */}
                      {renaming === dt.id && (
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginLeft: 8, padding: '7px 9px', border: `1px solid ${line}`, borderRadius: 8 }}>
                          <input value={renameText}
                            onChange={e => { setRenameText(e.target.value); setRenameCounts(null); }}
                            placeholder="新しい名前" style={{ ...input, width: 150 }} />
                          {renameCounts === null ? (
                            <button onClick={() => checkRename(dt)} disabled={detailBusy === dt.id}
                              style={{ padding: '7px 14px', borderRadius: 8, border: `1px solid ${accent}`, background: 'transparent', color: accent, fontSize: 13, fontWeight: 700, cursor: detailBusy === dt.id ? 'wait' : 'pointer' }}>
                              {detailBusy === dt.id ? '数えています...' : '次へ'}
                            </button>
                          ) : (
                            <>
                              <span style={{ fontSize: 12.5, color: textMid, lineHeight: 1.6 }}>
                                過去の予約 <b>{renameCounts.bookings}件</b>・繰り返し <b>{renameCounts.recurrences}件</b> の表示も
                                「{renameText.trim()}」に変わります。よろしいですか？
                              </span>
                              <button onClick={() => doRename(dt)} disabled={detailBusy === dt.id}
                                style={{ padding: '7px 14px', borderRadius: 8, border: 'none', background: accent, color: isDark ? '#1d2a24' : '#fff', fontSize: 13, fontWeight: 700, cursor: detailBusy === dt.id ? 'wait' : 'pointer' }}>
                                {detailBusy === dt.id ? '変えています...' : '変える'}
                              </button>
                            </>
                          )}
                          <button onClick={() => setRenaming(null)}
                            style={{ padding: '7px 12px', borderRadius: 8, border: `1px solid ${line}`, background: 'transparent', color: textMid, fontSize: 13, cursor: 'pointer' }}>
                            やめる
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <input value={newDetail[p] ?? ''}
                    onChange={e => setNewDetail(prev => ({ ...prev, [p]: e.target.value }))}
                    placeholder="例：体操" style={{ ...input, flex: 1, minWidth: 130 }} />
                  <button onClick={() => addDetail(p)} disabled={detailBusy === p}
                    style={{ padding: '7px 14px', borderRadius: 8, border: `1px solid ${accent}`, background: 'transparent', color: accent, fontSize: 13.5, fontWeight: 700, cursor: detailBusy === p ? 'wait' : 'pointer' }}>
                    {detailBusy === p ? '追加中...' : '追加'}
                  </button>
                </div>
                {/* 必須にするかどうか。🚨 詳細が1つも無い用途では効かない（予約できなくなるため） */}
                <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, cursor: 'pointer', marginTop: 8 }}>
                  <input type="checkbox" checked={d.required}
                    onChange={e => setDraft(prev => ({ ...prev, [p]: { ...prev[p], required: e.target.checked } }))}
                    style={{ width: 17, height: 17 }} />
                  予約するとき詳細を必ず選ばせる
                  <span style={{ fontSize: 12, color: textMid }}>（変えたら上の「保存」を押してください）</span>
                </label>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

interface RenewRow {
  src: Recurrence;
  checked: boolean;
  floorId: string;
  weekday: number;
  startTime: string;
  endTime: string;
  staffId: string;
  memberNo: string;
  customerLabel: string;
  /** すでに次の年度へ引き継ぎ済み。もう一度作らせない */
  done: boolean;
  result: { made: number; skipped: string[]; error?: string } | null;
}

/**
 * 予約の一括入力（CSV / Excel / テキスト貼り付け）。
 *
 * 🚨 入るものだけ入れて、入らなかった行は必ず一覧で出す（2026-08-31 ユーザー確定・案①）。
 *    50件中1件が重なっただけで全部やり直しでは現場が回らない。
 *    ただし「全部入った」と誤解させないよう、結果は必ず出す。
 * 🚨 重なりの判定は作り直さず、1行ずつ既存の room_create_booking を通す。
 * 🚨 初版は単発の予約のみ。繰り返しは今のフォームのほうが確実なので混ぜない。
 */
const BulkBookingPanel: React.FC<{
  floors: Floor[]; campuses: Campus[]; staff: Staff[];
  purposeDurations: PurposeDuration[]; user: AuthUser;
  isDark: boolean; onDone: (msg: string) => Promise<void>;
}> = ({ floors, campuses, staff, purposeDurations, user, isDark, onDone }) => {
  const [source, setSource] = useState<'paste' | 'file'>('paste');
  const [pasted, setPasted] = useState('');
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<unknown[][]>([]);
  const [map, setMap] = useState<Partial<Record<BookingField, number>>>({});
  const [error, setError] = useState('');
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [made, setMade] = useState<number | null>(null);
  // スタッフの予定表の形で貼られたか。true なら募集枠として作る（2026-09-01 ユーザー指示）
  const [scheduleMode, setScheduleMode] = useState(false);
  // 予定表の行には用途が書かれていないので、画面で選ぶ
  const [schedulePurpose, setSchedulePurpose] = useState<string>('プライベート');
  const [failed, setFailed] = useState<{ label: string; reason: string }[]>([]);

  const today = todayStr();
  const line = isDark ? '#3a3a5c' : '#e0e0e0';
  const lineSoft = isDark ? '#35354e' : '#eef0f3';
  const text = isDark ? '#eeeeee' : '#222222';
  const textMid = isDark ? '#b3b8c6' : '#5b6270';
  const accent = isDark ? '#6bbd92' : '#2f6f4f';
  const fieldBg = isDark ? '#495057' : '#fff';

  const input: React.CSSProperties = {
    padding: '7px 9px', borderRadius: 8, border: `1px solid ${line}`,
    background: fieldBg, color: text, fontSize: 16, boxSizing: 'border-box',
  };
  const smallBtn = (on: boolean): React.CSSProperties => ({
    padding: '4px 10px', borderRadius: 999, fontSize: 12.5, cursor: running ? 'wait' : 'pointer',
    border: `1px solid ${on ? accent : line}`,
    background: on ? accent : 'transparent',
    color: on ? (isDark ? '#1d2a24' : '#fff') : textMid,
    fontWeight: on ? 700 : 400,
  });

  const applyTable = (h: string[], r: unknown[][]) => {
    setHeaders(h); setRows(r); setMap(guessBookingMapping(h));
    setMade(null); setFailed([]);
  };

  const applyPaste = () => {
    setError('');
    // 🚨 まず「スタッフの予定表」の形（【場所】日付 時刻 担当 区分）かを見る。
    //    見出しの無いべた書きなので、表として割る前に判定する（2026-09-01 ユーザー指示）
    const sched = parseScheduleLines(pasted);
    if (sched) {
      setScheduleMode(true);
      applyTable(sched.headers, sched.rows);
      return;
    }
    setScheduleMode(false);
    const grid = splitPasted(pasted);
    if (grid.length < 2) {
      setError('1行目に見出し（日付・場所・開始…）、2行目から中身を貼り付けてください');
      return;
    }
    applyTable(grid[0], grid.slice(1));
  };

  const pickFile = async (file: File | null) => {
    if (!file) return;
    setError('');
    try {
      const { headers: h, rows: r } = await readTable(file);
      if (h.length === 0) { setError('ファイルの中身を読み取れませんでした'); return; }
      applyTable(h, r);
    } catch {
      setError('ファイルを開けませんでした。CSV か Excel を選んでください。');
    }
  };

  const parsed = useMemo(() => (rows.length
    ? buildBookings(rows, map, {
        floors, campuses, staff, purposeDurations,
        // 用途の列が無いときの既定。予定表の形のときは画面で選んだものを使う
        baseDate: today, defaultPurpose: schedulePurpose,
      })
    : null), [rows, map, floors, campuses, staff, purposeDurations, today, schedulePurpose]);

  /**
   * すでに入っている予約と、同じ担当の時間が重なっていないかを見る（2026-09-01 ユーザー指摘）。
   *
   * 🚨 **サーバーは場所の重なりしか見ていない**ので、担当の重なりはここで止めるしかない。
   *    同じ表を2回貼ったときに、同じ担当の枠が二重にできてしまう。
   * 🚨 これは**画面での事前チェック**。サーバー側では止めていないので、
   *    ここを消すと黙って二重に入るようになる。
   */
  const [dbNg, setDbNg] = useState<{ line: number; reason: string }[]>([]);
  const [dupChecking, setDupChecking] = useState(false);
  useEffect(() => {
    const list = parsed?.ok ?? [];
    const staffIds = [...new Set(list.map(b => b.staff_id).filter(Boolean))] as string[];
    if (list.length === 0 || staffIds.length === 0) { setDbNg([]); setDupChecking(false); return; }
    const dates = [...new Set(list.map(b => b.date))].sort();
    let cancelled = false;
    setDupChecking(true);
    (async () => {
      const start = new Date(`${dates[0]}T00:00:00`);
      const end = new Date(`${dates[dates.length - 1]}T00:00:00`);
      end.setDate(end.getDate() + 1);
      const { data, error: err } = await supabase.from('room_bookings')
        .select('starts_at, ends_at, staff_id')
        .is('deleted_at', null)
        .neq('status', 'cancelled')
        .in('staff_id', staffIds)
        .gte('starts_at', start.toISOString())
        .lt('starts_at', end.toISOString());
      if (cancelled) return;
      setDupChecking(false);
      // 🚨 読めなかったときは「重なりなし」にしない。確かめられないことを画面で言う
      if (err) { setDbNg([{ line: 0, reason: 'すでにある予約との重なりを確かめられませんでした（通信を確認してください）' }]); return; }
      const existing = (data ?? []) as { starts_at: string; ends_at: string; staff_id: string }[];
      const out: { line: number; reason: string }[] = [];
      for (const b of list) {
        const hit = existing.find(e =>
          e.staff_id === b.staff_id
          && localDate(e.starts_at) === b.date
          && minutesOf(b.start) < minutesOf(hhmm(e.ends_at))
          && minutesOf(b.end) > minutesOf(hhmm(e.starts_at)));
        if (hit) {
          out.push({
            line: b.line,
            reason: `すでに同じ担当の予約があります（${formatDateLabel(b.date)} ${hhmm(hit.starts_at)}〜${hhmm(hit.ends_at)}）`,
          });
        }
      }
      setDbNg(out);
    })();
    return () => { cancelled = true; };
  }, [parsed]);

  // 解析の結果に、既存予約との重なりを合流させたもの。画面と実行はこちらだけを見る
  const built = useMemo(() => {
    if (!parsed) return null;
    if (dbNg.length === 0) return parsed;
    const bad = new Set(dbNg.map(n => n.line));
    return {
      ok: parsed.ok.filter(b => !bad.has(b.line)),
      ng: [...parsed.ng, ...dbNg].sort((a, b) => a.line - b.line),
    };
  }, [parsed, dbNg]);

  const overLimit = !!built && built.ok.length > BULK_MAX_ROWS;

  const run = async () => {
    if (!built || built.ok.length === 0 || overLimit) return;
    setRunning(true); setError(''); setProgress(0); setMade(null);
    const ng: { label: string; reason: string }[] = [];
    const fixedIds: string[] = [];   // 固定の印を後からまとめて付けるため
    let count = 0;
    for (let i = 0; i < built.ok.length; i++) {
      const b = built.ok[i];
      const ds = toDate(b.date, b.start), de = toDate(b.date, b.end);
      const label = `${formatDateLabel(b.date)} ${b.start} ${b.customer_label || b.purpose}`;
      if (!ds || !de) { ng.push({ label, reason: '時刻を組み立てられませんでした' }); setProgress(i + 1); continue; }
      const { data, error: err } = await supabase.rpc('room_create_booking', {
        p_floor_id: b.floor_id,
        p_starts_at: ds.toISOString(), p_ends_at: de.toISOString(),
        p_purpose: b.purpose, p_booker_name: user.email ?? '',
        p_member_no: b.member_no, p_customer_label: b.customer_label,
        p_memo: b.memo, p_exclusive: false, p_recurrence_id: null,
        // 🚨 予定表から作るときは「募集中の枠」にする（ユーザー確定）。
        //    その行にはお客様が入っていないので、先に枠を置いて後から埋める形が合う
        p_staff_id: b.staff_id, p_kind: scheduleMode ? 'open' : 'booking', p_seats: 1,
      });
      const row = (Array.isArray(data) ? data[0] : data) as
        { ok?: boolean; reason?: string; booking_id?: string } | null;
      if (err) ng.push({ label, reason: '通信エラー' });
      else if (!row?.ok) ng.push({ label, reason: row?.reason ?? '入れられませんでした' });
      else {
        count++;
        if (b.is_fixed && row.booking_id) fixedIds.push(row.booking_id);
      }
      setProgress(i + 1);
    }
    // 固定の印はまとめて付ける（1件ずつ書くと通信が増えて途中で切れやすい）
    if (fixedIds.length > 0) {
      await supabase.from('room_bookings').update({ is_fixed: true }).in('id', fixedIds);
    }
    setRunning(false); setMade(count); setFailed(ng);
    await onDone(ng.length === 0
      ? `${count}件の予約を入れました`
      : `${count}件を入れました（${ng.length}件は入りませんでした）`);
  };

  return (
    <div>
      <div style={{ background: lineSoft, borderRadius: 8, padding: '10px 12px', fontSize: 13, lineHeight: 1.7, marginBottom: 12, color: textMid }}>
        1行に1件ずつ書いた表から、まとめて予約を入れます。1行目は見出しにしてください。
        <br />
        <b>日付 / 場所 / 開始 / 終了 / 用途 / 担当 / 会員番号 / お客様 / メモ</b>
        （日付・場所・開始は必須。終了が空なら用途の長さから計算します）
        <br />
        🚨 <b>入るものだけ入れます。</b>先約と重なった行は入れずに、あとで一覧に出します。
        🚨 繰り返しはここでは入れられません（今までのフォームをお使いください）。
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
        {([['paste', 'テキストを貼り付ける'], ['file', 'ファイルを選ぶ']] as const).map(([k, l]) => (
          <button key={k} onClick={() => !running && setSource(k)} style={smallBtn(source === k)}>{l}</button>
        ))}
      </div>

      {error && (
        <div style={{ background: isDark ? '#4a2a2a' : '#fdecea', border: `1px solid ${isDark ? '#7a4444' : '#f5c6cb'}`, color: isDark ? '#ffb4b4' : '#a3282a', borderRadius: 8, padding: '9px 12px', fontSize: 13, marginBottom: 12 }}>
          {error}
        </div>
      )}

      {source === 'paste' ? (
        <>
          <textarea value={pasted} onChange={e => setPasted(e.target.value)} rows={7}
            placeholder={'日付\t場所\t開始\t終了\t用途\t担当\t会員番号\tお客様\n9/1\t四条本校 3階\t16:00\t16:50\tレッスン\t林 晃平\t2014052061\t田中 太郎'}
            style={{ ...input, width: '100%', fontFamily: 'monospace', fontSize: 13, marginBottom: 8 }} />
          <p style={{ fontSize: 12, color: textMid, margin: '0 0 10px', lineHeight: 1.6 }}>
            Excel の範囲をコピーして、そのまま貼り付けられます。
            <br />
            スタッフの予定表の形（<code>【四条本校5階】9/1(火) 13:10～13:40 森本 純矢 A・B・C・D</code>）
            でも読み取れます。その場合は<b>募集中の枠</b>として作ります。
          </p>
          <button onClick={applyPaste} disabled={running || !pasted.trim()}
            style={{ ...smallBtn(false), opacity: !pasted.trim() ? .5 : 1, marginBottom: 12 }}>
            読み取る
          </button>
        </>
      ) : (
        <input type="file" accept=".csv,.xlsx,.xls,text/csv"
          onChange={e => pickFile(e.target.files?.[0] ?? null)}
          style={{ ...input, width: '100%', marginBottom: 12 }} />
      )}

      {/* 予定表の形で読んだとき。行に用途が書かれていないので、ここで選ぶ
          （2026-09-01 ユーザー確定：貼り付けるときに選ぶ） */}
      {scheduleMode && headers.length > 0 && (
        <div style={{ background: isDark ? '#35354e' : '#f0f2f5', borderRadius: 8, padding: '10px 12px', marginBottom: 12 }}>
          <div style={{ fontSize: 12.5, color: textMid, lineHeight: 1.7, marginBottom: 8 }}>
            スタッフの予定表として読み取りました。<b style={{ color: text }}>募集中の枠</b>として作ります
            （お客様は後から埋めます）。行に用途が書かれていないので、ここで選んでください。
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12.5, color: textMid }}>用途</span>
            {activePurposes().map(p => {
              const on = schedulePurpose === p;
              const [fg, bgc] = purposeColor(p, isDark);
              return (
                <button key={p} onClick={() => setSchedulePurpose(p)}
                  style={{
                    padding: '5px 12px', borderRadius: 999, fontSize: 12.5, cursor: 'pointer',
                    border: `1px solid ${on ? fg : line}`,
                    background: on ? bgc : 'transparent',
                    color: on ? fg : textMid, fontWeight: on ? 700 : 400,
                  }}>{p}</button>
              );
            })}
          </div>
        </div>
      )}

      {headers.length > 0 && (
        <>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: textMid, marginBottom: 8 }}>
            列の対応づけ
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
            {(Object.keys(BOOKING_FIELD_LABEL) as BookingField[]).map(f => (
              <div key={f} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span style={{ fontSize: 13, minWidth: 76 }}>
                  {BOOKING_FIELD_LABEL[f]}
                  {BOOKING_REQUIRED.includes(f) && <span style={{ color: accent }}> *</span>}
                </span>
                <select value={map[f] ?? -1} style={{ ...input, flex: 1 }}
                  onChange={e => {
                    const v = Number(e.target.value);
                    setMap(prev => {
                      const next = { ...prev };
                      if (v < 0) delete next[f]; else next[f] = v;
                      return next;
                    });
                  }}>
                  <option value={-1}>（使わない）</option>
                  {headers.map((h, i) => <option key={i} value={i}>{h || `${i + 1}列目`}</option>)}
                </select>
              </div>
            ))}
          </div>

          {built && (
            <div style={{ border: `1px solid ${line}`, borderRadius: 8, padding: '10px 12px', marginBottom: 12, fontSize: 13, lineHeight: 1.8 }}>
              <b>入れる前の確認</b>
              <div>
                入れられる行 {built.ok.length}件
                {dupChecking && <span style={{ color: textMid }}>（すでにある予約と重なっていないか確認中…）</span>}
              </div>
              {built.ng.length > 0 && (
                <div style={{ color: isDark ? '#ffb4b4' : '#a3282a', marginTop: 4 }}>
                  このままでは入らない行 {built.ng.length}件：
                  <div>
                    {built.ng.slice(0, 6).map(n => (
                      <div key={n.line}>{n.line}行目 … {n.reason}</div>
                    ))}
                    {built.ng.length > 6 && <div>ほか {built.ng.length - 6}件</div>}
                  </div>
                </div>
              )}
              {overLimit && (
                <div style={{ color: isDark ? '#ffb4b4' : '#a3282a', marginTop: 4 }}>
                  一度に入れられるのは{BULK_MAX_ROWS}件までです。分けて入れてください
                </div>
              )}
              <div style={{ color: textMid, marginTop: 4 }}>
                先約と重なるかどうかは、押したときに1件ずつ確かめます
              </div>
            </div>
          )}

          <button onClick={run} disabled={running || !built || built.ok.length === 0 || overLimit}
            style={{ padding: '10px 18px', borderRadius: 8, border: 'none', background: accent, color: isDark ? '#1d2a24' : '#fff', fontSize: 14.5, fontWeight: 700, cursor: running ? 'wait' : 'pointer', opacity: running || !built || built.ok.length === 0 || overLimit ? .6 : 1 }}>
            {running
              ? `入れています... ${progress}/${built?.ok.length ?? 0}件`
              : `${built?.ok.length ?? 0}件を入れる`}
          </button>

          {made !== null && (
            <div style={{ marginTop: 12, fontSize: 13, lineHeight: 1.8 }}>
              <b style={{ color: accent }}>{made}件 入れました</b>
              {failed.length > 0 && (
                <div style={{ color: isDark ? '#ffb4b4' : '#a3282a', marginTop: 4 }}>
                  入らなかった {failed.length}件：
                  {failed.map((f, i) => <div key={i}>{f.label} … {f.reason}</div>)}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
};

/**
 * キャンセル待ちの一覧（枠ごと）。
 *
 * 🚨 待ちは「毎週の枠（recurrence）」か「この回だけ（booking）」のどちらかに付く
 *    （2026-09-02 ユーザー承認・案A）。一覧も**枠ごと**にまとめる。
 *    担当者が違えば繰り返し（recurrence）も別なので、待ち行列は自動的に分かれる。
 * 🚨 曜日は new Date(starts_at).getDay() で取る（端末時刻なので正しい）。
 *    starts_at の文字列を切り出してはいけない（UTC表記で前日になる）。
 */
const WaitlistSettings: React.FC<{
  floors: Floor[]; campuses: Campus[]; staff: Staff[];
  isDark: boolean; onDone: (msg: string) => Promise<void>;
}> = ({ floors, campuses, staff, isDark, onDone }) => {
  const [rows, setRows] = useState<Waitlist[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  // 🚨 お客様の欄は予約フォームと同じ部品（ParticipantRow）を使う。
  //    素の入力欄だと検索（番号→お名前／お名前→候補）が効かない（2026-09-02 実機で指摘）
  const [draft, setDraft] = useState<{ person: PersonInput; note: string }>(
    { person: { no: '', name: '' }, note: '' });
  // 「どの日に入れるか」を選んでいる待ち（毎週の枠の繰り上げ用）
  const [pickFor, setPickFor] = useState<string | null>(null);
  const [occ, setOcc] = useState<Booking[]>([]);
  // 候補の回の出欠（「休みの連絡あり」を出すために読む）
  const [occAtt, setOccAtt] = useState<AttendanceRow[]>([]);
  // その担当の生きた予約（「埋まっています（繰り上げ済みなど）」を出すために読む・2026-09-02）
  const [occBusy, setOccBusy] = useState<Pick<Booking, 'id' | 'starts_at' | 'ends_at'>[]>([]);
  const [vacBusy, setVacBusy] = useState<Pick<Booking, 'id' | 'starts_at' | 'ends_at'>[]>([]);
  const [occLoading, setOccLoading] = useState(false);
  // 空き扱いにする出欠の名前（⚙️設定 → キャンセル待ち。読めないときは既定）
  const [openStatuses, setOpenStatuses] = useState<string[]>(['休み', 'キャンセル料']);
  // 繰り上げ・取り消しの直後に「その方の他の待ち」をどうするか選んでもらう
  // （🚨 自動では消さない。別の枠は引き続き待ちたい場合があるため・2026-09-02 ユーザー承認。
  //    断られた方が「この日の他の待ちもやめる」と言う場合はここでまとめて取り消せる）
  const [afterPromote, setAfterPromote] = useState<{ name: string; items: Waitlist[] } | null>(null);
  // 待ちが0名になった枠 →「空き枠にしますか」の案内（枠の設定 auto_open_slot がONのときだけ）
  const [emptyOffer, setEmptyOffer] = useState<Waitlist | null>(null);
  // 空き枠にする日を選ぶ一覧（emptyOffer が毎週の枠のとき）
  const [vacOcc, setVacOcc] = useState<Booking[]>([]);
  const [vacAtt, setVacAtt] = useState<AttendanceRow[]>([]);
  const [vacLoading, setVacLoading] = useState(false);
  // 枠ごとの「いま繰り上げられる日があるか」の目印（2026-09-02 ユーザー指示）。
  // 鍵は枠（queueKeyOf）、値はいちばん近い空きの日（無ければ null）。
  // null = まだ数えている最中（何も出さない）
  const [avail, setAvail] = useState<Record<string, string | null> | null>(null);

  const line = isDark ? '#3a3a5c' : '#e0e0e0';
  const lineSoft = isDark ? '#35354e' : '#eef0f3';
  const text = isDark ? '#eeeeee' : '#222222';
  const textMid = isDark ? '#b3b8c6' : '#5b6270';
  const accent = isDark ? '#6bbd92' : '#2f6f4f';
  const fieldBg = isDark ? '#495057' : '#fff';

  const input: React.CSSProperties = {
    padding: '6px 8px', borderRadius: 6, border: `1px solid ${line}`,
    background: fieldBg, color: text, fontSize: 16, boxSizing: 'border-box',
  };
  const smallBtn = (on: boolean): React.CSSProperties => ({
    padding: '4px 10px', borderRadius: 999, fontSize: 12.5, cursor: busy ? 'wait' : 'pointer',
    border: `1px solid ${on ? accent : line}`,
    background: on ? accent : 'transparent',
    color: on ? (isDark ? '#1d2a24' : '#fff') : textMid,
    fontWeight: on ? 700 : 400,
  });

  const placeName = useCallback((floorId: string): string => {
    const f = floors.find(x => x.id === floorId) ?? null;
    const c = campuses.find(x => x.id === f?.campus_id);
    const siblings = floors.filter(x => x.campus_id === f?.campus_id).length;
    return placeLabel(f, c?.name ?? '', siblings, true);
  }, [floors, campuses]);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    const [{ data, error: err }, st] = await Promise.all([
      supabase
        .from('room_waitlist')
        // 🚨 room_bookings へは booking_id と promoted_booking_id の**外部キーが2本**ある。
        //    「!booking_id」でどちらで結ぶかを明示しないと PGRST201（曖昧）で
        //    一覧全体が読めなくなる（2026-09-02 実機で発覚。8/31 の作成時からのバグ）
        .select('*, booking:room_bookings!booking_id(id, floor_id, starts_at, ends_at, purpose, status, deleted_at, staff_id, member_no, customer_label, cancel_kind), recurrence:room_recurrences(id, floor_id, weekday, start_time, end_time, purpose, staff_id, active, auto_open_slot, waitlist_closed)')
        .eq('status', 'waiting')
        .order('position')
        .order('created_at'),
      supabase.from('room_settings').select('value').eq('key', 'waitlist_open_statuses').maybeSingle(),
    ]);
    if (st.data?.value) {
      setOpenStatuses(st.data.value.split(',').map((s: string) => s.trim()).filter(Boolean));
    }
    if (err) {
      setError('キャンセル待ちを読み込めませんでした。通信を確認して開き直してください。');
      setLoading(false); return;
    }
    setRows((data ?? []) as Waitlist[]);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  /**
   * 枠ごとにまとめる。
   *   ・毎週の枠の待ち … recurrence ごと（担当が違えば別の枠）
   *   ・この回だけの待ち … 予約ごと
   * 見出しに使う曜日・時刻・担当もここで決めておく。
   */
  type WaitGroup = {
    key: string; kind: 'slot' | 'single'; floorId: string;
    /** 並べ替え用（毎週の枠は曜日、単発は日付） */
    weekday: number; time: string; dateStr: string;
    staffId: string | null; purpose: string; items: Waitlist[];
    /** キャンセル待ちの受付を締め切っている枠（枠の設定・2026-09-02） */
    closed: boolean;
  };
  const groups = useMemo(() => {
    const m = new Map<string, WaitGroup>();
    for (const w of rows) {
      let g: WaitGroup | undefined;
      if (w.recurrence_id && w.recurrence) {
        const r = w.recurrence;
        g = m.get(`r|${r.id}`) ?? {
          key: `r|${r.id}`, kind: 'slot', floorId: r.floor_id,
          weekday: r.weekday, time: r.start_time.slice(0, 5), dateStr: '',
          staffId: r.staff_id, purpose: r.purpose, items: [],
          closed: r.waitlist_closed === true,
        };
      } else if (w.booking_id && w.booking) {
        const b = w.booking;
        if (b.deleted_at) continue;          // 消された予約の「この回だけ」の待ちは出さない
        const d = new Date(b.starts_at);
        g = m.get(`b|${b.id}`) ?? {
          key: `b|${b.id}`, kind: 'single', floorId: b.floor_id,
          weekday: d.getDay(), time: hhmm(b.starts_at), dateStr: localDate(b.starts_at),
          staffId: b.staff_id, purpose: b.purpose, items: [],
          closed: false,
        };
      }
      if (!g) continue;
      g.items.push(w);
      m.set(g.key, g);
    }
    const order = new Map(floors.map((f, i) => [f.id, i]));
    // 毎週の枠を先に（曜日→時刻→場所）、そのあとに単発（日付→時刻）
    return [...m.values()].sort((a, b) =>
      (a.kind === 'single' ? 1 : 0) - (b.kind === 'single' ? 1 : 0)
      || (a.kind === 'single' ? a.dateStr.localeCompare(b.dateStr) : a.weekday - b.weekday)
      || a.time.localeCompare(b.time)
      || (order.get(a.floorId) ?? 99) - (order.get(b.floorId) ?? 99));
  }, [rows, floors]);

  const saveEdit = async (w: Waitlist) => {
    if (!draft.person.name.trim()) { setError('お客様のお名前を入れてください'); return; }
    setBusy(w.id); setError('');
    const { error: err } = await supabase.from('room_waitlist').update({
      member_no: draft.person.no.trim() || null,
      customer_label: draft.person.name.trim(),
      note: draft.note.trim() || null,
      updated_at: new Date().toISOString(),
    }).eq('id', w.id);
    setBusy('');
    if (err) { setError('保存できませんでした。通信を確認してください。'); return; }
    setEditing(null);
    await load();
    await onDone('キャンセル待ちを直しました');
  };

  const move = async (list: Waitlist[], idx: number, dir: -1 | 1) => {
    const to = idx + dir;
    if (to < 0 || to >= list.length) return;
    setBusy(list[idx].id);
    // 並びは position で持つ。入れ替えるのは2件だけなので、その2件を書き換える
    const a = list[idx], b = list[to];
    const [pa, pb] = [a.position, b.position];
    const now = new Date().toISOString();
    const r1 = await supabase.from('room_waitlist')
      .update({ position: pb === pa ? pa + dir : pb, updated_at: now }).eq('id', a.id);
    const r2 = await supabase.from('room_waitlist')
      .update({ position: pa, updated_at: now }).eq('id', b.id);
    setBusy('');
    if (r1.error || r2.error) { setError('順番を変えられませんでした。'); return; }
    await load();
  };

  /** 先頭へ（2026-09-02 ユーザー承認）。いちばん小さい position より小さくするだけ */
  const moveTop = async (list: Waitlist[], idx: number) => {
    if (idx <= 0) return;
    setBusy(list[idx].id);
    const minPos = Math.min(...list.map(x => x.position));
    const { error: err } = await supabase.from('room_waitlist')
      .update({ position: minPos - 1, updated_at: new Date().toISOString() })
      .eq('id', list[idx].id);
    setBusy('');
    if (err) { setError('順番を変えられませんでした。'); return; }
    await load();
  };

  const queueKeyOf = (x: Waitlist) => (x.recurrence_id ? `r|${x.recurrence_id}` : `b|${x.booking_id}`);

  /**
   * 取り消し。askFollowUps=true のとき、続けて2つの案内を出す：
   *   ① その方の他の待ち（都合が悪く、他の枠の待ちもやめる場合がある・2026-09-02 ユーザー指示）
   *   ② 待ちが0名になった枠の「空き枠にしますか」（枠の設定がONのときだけ）
   * 🚨 案内パネルの中から呼ぶときは askFollowUps=false（パネルが自分を上書きしないように）
   */
  const cancel = async (w: Waitlist, askFollowUps = true) => {
    setBusy(w.id);
    const { error: err } = await supabase.from('room_waitlist')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() }).eq('id', w.id);
    setBusy('');
    if (err) { setError('取り消せませんでした。通信を確認してください。'); return; }
    if (askFollowUps) {
      const others = rows.filter(x =>
        x.id !== w.id && x.status === 'waiting'
        && (w.member_no && x.member_no ? x.member_no === w.member_no : x.customer_label === w.customer_label));
      setAfterPromote(others.length ? { name: w.customer_label, items: others } : null);
      const remain = rows.filter(x =>
        x.id !== w.id && x.status === 'waiting' && queueKeyOf(x) === queueKeyOf(w));
      const autoOpen = w.recurrence ? w.recurrence.auto_open_slot !== false : true;
      setEmptyOffer(remain.length === 0 && autoOpen ? w : null);
      setVacOcc([]); setVacAtt([]);
    }
    await load();
    await onDone('キャンセル待ちを取り消しました');
  };

  /** その回を空き枠にする（休講化＋募集枠の作成をサーバーが1回で行う） */
  const vacateOcc = async (bookingId: string) => {
    setBusy('__vacate__'); setError('');
    const { data, error: err } = await supabase.rpc('room_vacate_to_open', { p_booking_id: bookingId });
    const row = (Array.isArray(data) ? data[0] : data) as { ok?: boolean; reason?: string } | null;
    setBusy('');
    if (err) { setError('空き枠を作れませんでした。通信を確認してください。'); return; }
    if (!row?.ok) { setError(row?.reason ?? '空き枠を作れませんでした'); return; }
    setEmptyOffer(null); setVacOcc([]); setVacAtt([]);
    await onDone('空き枠を作りました（予約表に募集中の枠が出ます）');
  };

  /** 空き枠にする日の候補を読む（emptyOffer が毎週の枠のとき） */
  const loadVacOcc = async (recurrenceId: string, staffId: string | null) => {
    setVacLoading(true); setError(''); setVacBusy([]);
    const from = new Date(); from.setHours(0, 0, 0, 0);
    const { data, error: err } = await supabase.from('room_bookings')
      .select('*')
      .eq('recurrence_id', recurrenceId)
      .gte('starts_at', from.toISOString())
      .order('starts_at')
      .limit(12);
    if (err) { setVacLoading(false); setError('枠の日付を読み込めませんでした。通信を確認してください。'); return; }
    const bs = (data ?? []) as Booking[];
    setVacOcc(bs);
    if (bs.length > 0) {
      const { data: at } = await supabase.from('room_booking_attendance')
        .select('*').in('booking_id', bs.map(x => x.id));
      setVacAtt((at ?? []) as AttendanceRow[]);
    }
    setVacBusy(await loadStaffBusy(staffId, bs));
    setVacLoading(false);
  };

  /**
   * 繰り上げの本体。「どの回に入れるか」（予約表の1行）を指定して呼ぶ。
   * 🚨 空きの最終判定はサーバー（room_create_booking）。画面では判定しない。
   */
  const promoteAt = async (w: Waitlist, targetBookingId: string) => {
    setBusy(w.id); setError('');
    const { data, error: err } = await supabase.rpc('room_promote_waitlist_at', {
      p_waitlist_id: w.id, p_target_booking_id: targetBookingId,
    });
    const row = (Array.isArray(data) ? data[0] : data) as
      { ok?: boolean; reason?: string } | null;
    setBusy('');
    if (err) { setError('繰り上げられませんでした。通信を確認してください。'); return; }
    if (!row?.ok) {
      // 多くは「その回がまだ生きている」。先に休講や取り消しが要る
      setError(`${row?.reason ?? '繰り上げられませんでした'}（先にその回を休講または取り消してください）`);
      return;
    }
    setPickFor(null); setOcc([]);
    // 🚨 繰り上げた方が**他の枠でも待っていたら**、その場でどうするか選んでもらう
    //    （残す／取り消す）。自動では消さない（別の枠も待ち続けたい場合があるため）
    const others = rows.filter(x =>
      x.id !== w.id && x.status === 'waiting'
      && (w.member_no && x.member_no ? x.member_no === w.member_no : x.customer_label === w.customer_label));
    setAfterPromote(others.length ? { name: w.customer_label, items: others } : null);
    await load();
    await onDone(`${w.customer_label} を予約に繰り上げました`);
  };

  /**
   * その担当の生きた予約を読む（候補の回と重なるものを探すため）。
   * 🚨 繰り上げでできた予約は recurrence に紐付かないので、枠の回だけ見ても分からない。
   *    担当で引かないと「1人目で埋まった枠に2人目」を見落とす（2026-09-02 実機で発覚）
   */
  const loadStaffBusy = async (staffId: string | null, bs: Booking[]) => {
    if (!staffId || bs.length === 0) return [];
    const from = new Date(); from.setHours(0, 0, 0, 0);
    const { data } = await supabase.from('room_bookings')
      .select('id, starts_at, ends_at')
      .eq('staff_id', staffId)
      .eq('status', 'active')
      .eq('kind', 'booking')
      .is('deleted_at', null)
      .gte('ends_at', from.toISOString())
      .lte('starts_at', bs[bs.length - 1].ends_at);
    return (data ?? []) as Pick<Booking, 'id' | 'starts_at' | 'ends_at'>[];
  };

  /** 毎週の枠の待ち：入れる日の候補（今後の回）を読み込んで選んでもらう */
  const openPick = async (w: Waitlist) => {
    if (!w.recurrence_id) return;
    setPickFor(w.id); setOcc([]); setOccAtt([]); setOccBusy([]); setOccLoading(true); setError('');
    const from = new Date(); from.setHours(0, 0, 0, 0);
    // 🚨 取り消し（deleted_at あり）の回も読む。「取り消して空けた日」こそ入れる先になるため
    const { data, error: err } = await supabase.from('room_bookings')
      .select('*')
      .eq('recurrence_id', w.recurrence_id)
      .gte('starts_at', from.toISOString())
      .order('starts_at')
      .limit(12);
    if (err) { setOccLoading(false); setError('枠の日付を読み込めませんでした。通信を確認してください。'); setPickFor(null); return; }
    const bs = (data ?? []) as Booking[];
    setOcc(bs);
    // 「休みの連絡あり」を出すために出欠も読む（🚨 予約0件のとき in に空配列を渡さない）
    if (bs.length > 0) {
      const { data: at } = await supabase.from('room_booking_attendance')
        .select('*').in('booking_id', bs.map(x => x.id));
      setOccAtt((at ?? []) as AttendanceRow[]);
    }
    setOccBusy(await loadStaffBusy(w.recurrence?.staff_id ?? null, bs));
    setOccLoading(false);
  };

  /** 担当の表示。🚨 空欄だと「担当が無い」のか「出ていない」のか分からないので必ず書く */
  const staffName = (id: string | null): string =>
    id ? (staff.find(s => s.id === id)?.name ?? '担当なし') : '担当なし';

  /** 待ちが付いている枠のことば（「他の待ちをどうしますか」の一覧で使う） */
  const waitSlotLabel = (w: Waitlist): string => {
    if (w.recurrence) {
      const r = w.recurrence;
      return `毎週${WEEKDAY_LABEL[r.weekday]}曜 ${r.start_time.slice(0, 5)} / ${placeName(r.floor_id)} / 担当：${staffName(r.staff_id)}`;
    }
    if (w.booking) {
      return `${formatDateLabel(localDate(w.booking.starts_at))} ${hhmm(w.booking.starts_at)} / ${placeName(w.booking.floor_id)}（この回だけ）`;
    }
    return '';
  };

  /**
   * その回の状態。🚨 空きの最終判定はサーバー。ここは目安を出すだけ。
   * 「休みの連絡あり」＝参加者全員に空き扱いの出欠（休み・キャンセル料など）が
   * 付いている回。この回はそのまま繰り上げられる（サーバーが自動で休講にする）
   */
  const occLabel = (
    o: Booking,
    attList: AttendanceRow[] = occAtt,
    busyList: Pick<Booking, 'id' | 'starts_at' | 'ends_at'>[] = occBusy,
  ): { label: string; free: boolean } => {
    // 🚨 まず担当の重なり。取り消し・お休みで空いたように見える回でも、
    //    繰り上げ済みの予約（recurrence に紐付かない）で埋まっていることがある。
    //    サーバー（room_staff_busy）も同じ判定で止める。ここは目安の表示
    if (busyList.some(x => x.id !== o.id && x.starts_at < o.ends_at && o.starts_at < x.ends_at)) {
      return { label: '埋まっています（繰り上げ済みなど）', free: false };
    }
    if (o.deleted_at) return { label: '取消済み', free: true };
    if (o.status === 'cancelled') return { label: cancelledLabel(o), free: true };
    // 🚨 判定は「行の全部」ではなく**いまの参加者1人ずつ**で見る。過去のテストで残った
    //    キーの違う古い行が1つあるだけで判定が壊れるため（2026-09-02 実機で発覚）。
    //    DB側の room_booking_all_absent() と同じ判定。片方だけ直さないこと
    const att = attList.filter(a => a.booking_id === o.id);
    const ppl = participantsOf(o);
    const matched = ppl.map(p => att.find(a => a.participant_no === p.no && a.participant_name === p.name));
    if (ppl.length > 0 && matched.every(r => !!r && openStatuses.includes(r.status.trim()))) {
      return { label: `休みの連絡あり（${matched[0]!.status}）`, free: true };
    }
    return { label: '予約が入っています', free: false };
  };

  /**
   * 枠ごとの「空きあり（最短◯/◯）／いま空きなし」の先読み（2026-09-02 ユーザー指示）。
   * 押す前に、どの枠を繰り上げられるかが見出しで分かるようにする。
   * 🚨 判定は日付選びの occLabel と**同じもの**を使う（別の式を書かない）。
   *    今後8週間ぶんの 回・出欠・担当の生きた予約 をまとめて読み、枠ごとに照合する
   */
  useEffect(() => {
    let alive = true;
    (async () => {
      setAvail(null);
      if (rows.length === 0) { setAvail({}); return; }
      const from = new Date(); from.setHours(0, 0, 0, 0);
      const to = new Date(from); to.setDate(to.getDate() + 56);
      // ① 毎週の枠の今後の回（🚨 取り消し済みの回も読む。そこが空きになるため）
      const recIds = [...new Set(rows.filter(w => w.recurrence_id).map(w => w.recurrence_id as string))];
      let occs: Booking[] = [];
      if (recIds.length > 0) {
        const { data } = await supabase.from('room_bookings').select('*')
          .in('recurrence_id', recIds)
          .gte('starts_at', from.toISOString())
          .lt('starts_at', to.toISOString())
          .order('starts_at');
        occs = (data ?? []) as Booking[];
      }
      // ② この回だけの待ちは、埋め込みで読んだ予約をそのまま候補にする
      const singles = rows
        .filter(w => w.booking_id && w.booking && !w.booking.deleted_at)
        .map(w => w.booking as unknown as Booking);
      const cands = [...occs, ...singles];
      if (cands.length === 0) { if (alive) setAvail({}); return; }
      // ③ 出欠と、担当の生きた予約（繰り上げ済みの検出用）をまとめて読む
      const { data: at } = await supabase.from('room_booking_attendance')
        .select('*').in('booking_id', cands.map(c => c.id));
      const attAll = (at ?? []) as AttendanceRow[];
      const staffIds = [...new Set(cands.map(c => c.staff_id).filter(Boolean))] as string[];
      let busyAll: { id: string; starts_at: string; ends_at: string; staff_id: string | null }[] = [];
      if (staffIds.length > 0) {
        const { data: sb } = await supabase.from('room_bookings')
          .select('id, starts_at, ends_at, staff_id')
          .in('staff_id', staffIds)
          .eq('status', 'active').eq('kind', 'booking').is('deleted_at', null)
          .gte('ends_at', from.toISOString())
          .lt('starts_at', to.toISOString());
        busyAll = (sb ?? []) as typeof busyAll;
      }
      // ④ 枠ごとに、いちばん近い空きの日を探す
      const map: Record<string, string | null> = {};
      for (const w of rows) {
        const key = queueKeyOf(w);
        if (key in map) continue;
        const list = w.recurrence_id
          ? occs.filter(o => o.recurrence_id === w.recurrence_id)
          : (w.booking && !w.booking.deleted_at ? [w.booking as unknown as Booking] : []);
        const staffId = w.recurrence ? w.recurrence.staff_id : (w.booking?.staff_id ?? null);
        const busyForStaff = staffId ? busyAll.filter(x => x.staff_id === staffId) : [];
        const hit = list.find(o => occLabel(o, attAll, busyForStaff).free);
        map[key] = hit ? localDate(hit.starts_at) : null;
      }
      if (alive) setAvail(map);
    })();
    return () => { alive = false; };
    // 🚨 occLabel と queueKeyOf は毎レンダーで作り直されるので依存に入れない
    //    （入れると無限ループになる）。実質の依存は rows と openStatuses だけ
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, openStatuses]);

  return (
    <div>
      <div style={{ background: lineSoft, borderRadius: 8, padding: '10px 12px', fontSize: 13, lineHeight: 1.7, marginBottom: 12, color: textMid }}>
        いま並んでいる方を、<b>枠ごと</b>（毎週の枠は担当ごとに別）にまとめています。
        <br />
        出欠で<b>{openStatuses.join('・')}</b>が付いた回（＝休みの連絡あり）は、
        そのまま繰り上げられます（繰り上げた瞬間に、その回は自動で<b>お休み</b>（グレー）になります。
        予約も出欠の記録も消えません）。それ以外の回は、先に休講または取り消してから。
        空きが無いまま押すと、理由を出して止まります。
      </div>

      {error && (
        <div style={{ background: isDark ? '#4a2a2a' : '#fdecea', border: `1px solid ${isDark ? '#7a4444' : '#f5c6cb'}`, color: isDark ? '#ffb4b4' : '#a3282a', borderRadius: 8, padding: '9px 12px', fontSize: 13, marginBottom: 12 }}>
          {error}
        </div>
      )}

      {/* 繰り上げた方が他の枠でも待っていたときの案内。
          🚨 自動では消さない（別の枠も待ち続けたい場合があるため）。1件ずつ選んでもらう */}
      {afterPromote && (
        <div style={{ background: isDark ? '#4a4326' : '#fff8e1', border: `1px solid ${isDark ? '#8a7a3a' : '#ffe082'}`, color: isDark ? '#ffe6a3' : '#7a5c00', borderRadius: 8, padding: '10px 12px', fontSize: 13, marginBottom: 12, lineHeight: 1.8 }}>
          <b>{afterPromote.name}</b> さんは、他の枠でも待っています。それぞれどうしますか？
          {afterPromote.items.map(o => (
            <div key={o.id} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 6 }}>
              <span>{waitSlotLabel(o)}</span>
              <span style={{ marginLeft: 'auto', display: 'flex', gap: 5 }}>
                <button onClick={async () => {
                  await cancel(o, false);
                  setAfterPromote(p => {
                    if (!p) return null;
                    const rest = p.items.filter(x => x.id !== o.id);
                    return rest.length ? { ...p, items: rest } : null;
                  });
                }} disabled={!!busy} style={smallBtn(false)}>待ちを取り消す</button>
                <button onClick={() => setAfterPromote(p => {
                  if (!p) return null;
                  const rest = p.items.filter(x => x.id !== o.id);
                  return rest.length ? { ...p, items: rest } : null;
                })} style={smallBtn(false)}>残す</button>
              </span>
            </div>
          ))}
        </div>
      )}

      {/* 待ちが0名になった枠の「空き枠にしますか」（2026-09-02 ユーザー承認）。
          🚨 枠の設定（空き枠を作る）がOFFの枠では出ない。取消済みの回は対象外
          （空きはすでに予約表に見えているので、普通に枠を置けばよい） */}
      {emptyOffer && (
        <div style={{ background: isDark ? '#4a4326' : '#fff8e1', border: `1px solid ${isDark ? '#8a7a3a' : '#ffe082'}`, color: isDark ? '#ffe6a3' : '#7a5c00', borderRadius: 8, padding: '10px 12px', fontSize: 13, marginBottom: 12, lineHeight: 1.8 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span>
              <b>{waitSlotLabel(emptyOffer)}</b> の待ちが 0名 になりました。
              空きの回（休みの連絡あり・休講）を<b>空き枠（募集中）</b>にできます。
            </span>
            <span style={{ marginLeft: 'auto', display: 'flex', gap: 5 }}>
              {emptyOffer.recurrence_id ? (
                <button onClick={() => (vacOcc.length || vacLoading ? (setVacOcc([]), setVacAtt([])) : loadVacOcc(emptyOffer.recurrence_id!, emptyOffer.recurrence?.staff_id ?? null))}
                  disabled={!!busy} style={smallBtn(vacOcc.length > 0 || vacLoading)}>
                  {vacOcc.length || vacLoading ? '日を選ぶのをやめる' : '日を選んで空き枠にする'}
                </button>
              ) : (
                <button onClick={() => emptyOffer.booking_id && vacateOcc(emptyOffer.booking_id)}
                  disabled={!!busy} style={smallBtn(true)}>この回を空き枠にする</button>
              )}
              <button onClick={() => { setEmptyOffer(null); setVacOcc([]); setVacAtt([]); }}
                style={smallBtn(false)}>今はしない</button>
            </span>
          </div>
          {(vacLoading || vacOcc.length > 0) && (
            <div style={{ marginTop: 8, borderTop: `1px solid ${isDark ? '#8a7a3a' : '#ffe082'}`, paddingTop: 7 }}>
              {vacLoading ? (
                <span style={{ fontSize: 12.5 }}>日付を読み込んでいます…</span>
              ) : vacOcc.map(o => {
                const s = occLabel(o, vacAtt, vacBusy);
                return (
                  <div key={o.id} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', padding: '3px 0' }}>
                    <span style={{ fontSize: 13 }}>{formatDateLabel(localDate(o.starts_at))} {hhmm(o.starts_at)}</span>
                    <span style={{ fontSize: 12 }}>{s.label}</span>
                    {!o.deleted_at && (
                      <button onClick={() => vacateOcc(o.id)} disabled={!!busy}
                        style={{ ...smallBtn(s.free), marginLeft: 'auto' }}>この日を空き枠にする</button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {loading ? (
        <p style={{ fontSize: 13.5, color: textMid }}>読み込んでいます...</p>
      ) : groups.length === 0 ? (
        <p style={{ fontSize: 13.5, color: textMid, lineHeight: 1.7 }}>
          いまキャンセル待ちの方はいません。
          予約の詳細を開くと「キャンセル待ちを追加」から登録できます。
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {groups.map(g => (
            <div key={g.key}
              style={{ border: `1px solid ${line}`, borderRadius: 8, padding: '10px 12px' }}>
              <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>
                {g.kind === 'slot'
                  ? <>毎週{WEEKDAY_LABEL[g.weekday]}曜 {g.time}</>
                  : <>{formatDateLabel(g.dateStr)} {g.time}（この回だけ）</>}
                <span style={{ fontSize: 12.5, fontWeight: 400, color: textMid }}>
                  {' / '}{placeName(g.floorId)}{' / '}{g.purpose}
                  {' / '}担当：{staffName(g.staffId)}
                  {' / '}待ち {g.items.length}名
                  {g.closed && <b>（受付停止中）</b>}
                </span>
                {/* 押す前に繰り上げられるか分かる目印（2026-09-02 ユーザー指示）。
                    判定は日付選びと同じ。数えている最中は何も出さない */}
                {avail && (
                  avail[g.key]
                    ? <span style={{ fontSize: 12, fontWeight: 700, color: accent, background: isDark ? '#263b33' : '#e8f2ec', borderRadius: 999, padding: '2px 10px', marginLeft: 8 }}>
                        空きあり（最短 {formatDateLabel(avail[g.key] as string)}）
                      </span>
                    : <span style={{ fontSize: 12, fontWeight: 400, color: textMid, border: `1px solid ${lineSoft}`, borderRadius: 999, padding: '2px 10px', marginLeft: 8 }}>
                        いま空きなし（8週間先まで）
                      </span>
                )}
              </div>

              {g.items.map((w, i) => (
                <div key={w.id} style={{ borderTop: `1px solid ${lineSoft}`, padding: '8px 0' }}>
                  {editing === w.id ? (
                    <div>
                      {/* 🚨 予約フォームと同じ部品。素の入力欄だと検索が効かない */}
                      <ParticipantRow value={draft.person}
                        onChange={v => setDraft(p => ({ ...p, person: v }))}
                        onRemove={null} date={todayStr()} isDark={isDark} />
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 6 }}>
                        <input value={draft.note} placeholder="メモ"
                          onChange={e => setDraft(p => ({ ...p, note: e.target.value }))}
                          style={{ ...input, flex: 1, minWidth: 120 }} />
                        <button onClick={() => saveEdit(w)} disabled={busy === w.id}
                          style={smallBtn(true)}>保存</button>
                        <button onClick={() => setEditing(null)} style={smallBtn(false)}>やめる</button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 12.5, color: textMid, minWidth: 22 }}>{i + 1}.</span>
                        <b style={{ fontSize: 13.5 }}>{w.customer_label}</b>
                        <span style={{ fontSize: 12.5, color: textMid }}>
                          {w.member_no ?? '一般'}
                          {w.staff_id && ` / 希望：${staff.find(s => s.id === w.staff_id)?.name ?? ''}`}
                          {w.note && ` / ${w.note}`}
                        </span>
                        <span style={{ marginLeft: 'auto', display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                          <button onClick={() => move(g.items, i, -1)} disabled={i === 0 || !!busy}
                            style={{ ...smallBtn(false), opacity: i === 0 ? .4 : 1 }} aria-label="順番を上げる">▲</button>
                          <button onClick={() => move(g.items, i, 1)} disabled={i === g.items.length - 1 || !!busy}
                            style={{ ...smallBtn(false), opacity: i === g.items.length - 1 ? .4 : 1 }} aria-label="順番を下げる">▼</button>
                          <button onClick={() => moveTop(g.items, i)} disabled={i === 0 || !!busy}
                            style={{ ...smallBtn(false), opacity: i === 0 ? .4 : 1 }}>先頭へ</button>
                          <button onClick={() => {
                            setEditing(w.id);
                            setDraft({ person: { no: w.member_no ?? '', name: w.customer_label }, note: w.note ?? '' });
                          }} style={smallBtn(false)}>直す</button>
                          {/* 毎週の枠は「どの日に入れるか」を選んでから。この回だけは直接 */}
                          {g.kind === 'slot' ? (
                            <button onClick={() => (pickFor === w.id ? setPickFor(null) : openPick(w))}
                              disabled={!!busy} style={smallBtn(pickFor === w.id)}>
                              {pickFor === w.id ? '日を選ぶのをやめる' : '繰り上げる（日を選ぶ）'}
                            </button>
                          ) : (
                            <button onClick={() => w.booking_id && promoteAt(w, w.booking_id)}
                              disabled={!!busy} style={smallBtn(true)}>繰り上げる</button>
                          )}
                          <button onClick={() => cancel(w)} disabled={!!busy}
                            style={smallBtn(false)}>取り消す</button>
                        </span>
                      </div>

                      {/* どの日に入れるか（毎週の枠の待ちだけ） */}
                      {pickFor === w.id && (
                        <div style={{ margin: '8px 0 2px 30px', border: `1px solid ${lineSoft}`, borderRadius: 8, padding: '8px 10px' }}>
                          {occLoading ? (
                            <p style={{ fontSize: 12.5, color: textMid, margin: 0 }}>日付を読み込んでいます…</p>
                          ) : occ.length === 0 ? (
                            <p style={{ fontSize: 12.5, color: textMid, margin: 0, lineHeight: 1.7 }}>
                              この枠の今後の回が見つかりません（繰り返しの期限が切れているなど）。
                              その場合は予約表から普通に予約を入れてください。
                            </p>
                          ) : (
                            <>
                              <p style={{ fontSize: 12, color: textMid, margin: '0 0 6px', lineHeight: 1.6 }}>
                                入れる日を選んでください。「休みの連絡あり」の日はそのまま入れられます
                                （その回は自動で「お休み」になり、記録は残ります）。「予約が入っています」の日は、
                                先にその回を休講または取り消さないと入りません。
                                「埋まっています」の日は、この担当にすでに別の予約（繰り上げ済みなど）が
                                あるため入れられません（押しても理由を出して止まります）。
                              </p>
                              {occ.map(o => {
                                const s = occLabel(o);
                                return (
                                  <div key={o.id} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', padding: '3px 0' }}>
                                    <span style={{ fontSize: 13 }}>{formatDateLabel(localDate(o.starts_at))} {hhmm(o.starts_at)}</span>
                                    <span style={{ fontSize: 12, color: s.free ? accent : textMid }}>{s.label}</span>
                                    <button onClick={() => promoteAt(w, o.id)} disabled={!!busy}
                                      style={{ ...smallBtn(s.free), marginLeft: 'auto' }}>この日に入れる</button>
                                  </div>
                                );
                              })}
                            </>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

/**
 * お客様（取り込み・一覧）。社員が使う。
 *
 * 🚨 一般の方（非会員）は会員番号を持たないので、ここには載らない。
 *    予約フォームで会員番号が見つからないときは、これまでどおり名前を手入力する。
 * 🚨 取り込みは「会員番号をキーに、あれば更新・なければ追加」。
 *    ファイルに載っていない人は**消さない**。出力条件を間違えただけで
 *    お客様が消えるのは取り返しがつかないため、退会にするかは人が決める。
 */
const CustomerSettings: React.FC<{
  isDark: boolean;
  onDone: (msg: string) => Promise<void>;
  /** 一覧の「予約」ボタン。このお客様で予約を入れる流れに移る */
  onBook: (c: Customer) => void;
}> = ({ isDark, onDone, onBook }) => {
  const [sub, setSub] = useState<'list' | 'import' | 'new'>('list');
  // 手入力での追加（2026-08-31 ユーザー指示）。
  // 🚨 会員番号は必須。お客様を1人と見分ける唯一の手がかりなので、
  //    空を許すと同じ人が二重に増える
  const [form, setForm] = useState({
    member_no: '', last_name: '', first_name: '', last_kana: '', first_kana: '',
    birth_date: '', phone: '', mobile: '', email: '', guardian_name: '', note: '',
  });
  const [saving, setSaving] = useState(false);
  const [list, setList] = useState<Customer[]>([]);
  const [contacts, setContacts] = useState<Record<string, CustomerContact>>({});
  const [canSeeContacts, setCanSeeContacts] = useState(false);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // 一覧のページ切り替え（2026-09-01 ユーザー指示。300名ごと）
  const [page, setPage] = useState(0);
  // 読み込みの上限に達したか（お客様が MAX_CUSTOMERS を超えている）
  const [overCap, setOverCap] = useState(false);

  // 取り込み
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<unknown[][]>([]);
  const [map, setMap] = useState<Partial<Record<CustomerField, number>>>({});
  const [fileName, setFileName] = useState('');
  const [imported, setImported] = useState<{ added: number; updated: number } | null>(null);

  const today = todayStr();
  const line = isDark ? '#3a3a5c' : '#e0e0e0';
  const lineSoft = isDark ? '#35354e' : '#eef0f3';
  const text = isDark ? '#eeeeee' : '#222222';
  const textMid = isDark ? '#b3b8c6' : '#5b6270';
  const accent = isDark ? '#6bbd92' : '#2f6f4f';
  const fieldBg = isDark ? '#495057' : '#fff';

  const input: React.CSSProperties = {
    padding: '7px 9px', borderRadius: 8, border: `1px solid ${line}`,
    background: fieldBg, color: text, fontSize: 16, boxSizing: 'border-box',
  };
  const smallBtn = (on: boolean): React.CSSProperties => ({
    padding: '4px 10px', borderRadius: 999, fontSize: 12.5, cursor: busy ? 'wait' : 'pointer',
    border: `1px solid ${on ? accent : line}`,
    background: on ? accent : 'transparent',
    color: on ? (isDark ? '#1d2a24' : '#fff') : textMid,
    fontWeight: on ? 700 : 400,
  });

  /**
   * お客様と連絡先をまとめて読む。
   * 🚨 1回の問い合わせで返ってくるのは **1000件まで**。件数を指定しないと
   *    1001人目以降が**エラーも出さずに黙って欠ける**（2026-09-01 発覚）。
   *    1000件ずつ範囲を指定して MAX_CUSTOMERS 件まで読む。
   * 🚨 並びは会員番号順（ユーザー指示）。
   */
  const load = useCallback(async () => {
    setLoading(true); setError('');
    const CHUNK = 1000;
    const MAX_CUSTOMERS = 5000;

    const cs: Customer[] = [];
    let hitCap = false;
    for (let from = 0; ; from += CHUNK) {
      const { data, error: err } = await supabase
        .from('room_customers').select('*')
        .order('member_no')
        .range(from, from + CHUNK - 1);
      if (err) {
        setError('お客様の一覧を読み込めませんでした。通信を確認して開き直してください。');
        setLoading(false); return;
      }
      const part = (data ?? []) as Customer[];
      cs.push(...part);
      if (part.length < CHUNK) break;          // これで最後
      if (cs.length >= MAX_CUSTOMERS) { hitCap = true; break; }
    }
    setList(cs);
    setOverCap(hitCap);

    // 連絡先は公開範囲の設定によっては読めない。読めなくてもエラーにしない
    const ks: CustomerContact[] = [];
    let contactsOk = true;
    for (let from = 0; ; from += CHUNK) {
      const { data, error: err } = await supabase
        .from('room_customer_contacts').select('*')
        .order('member_no')
        .range(from, from + CHUNK - 1);
      if (err) { contactsOk = false; break; }
      const part = (data ?? []) as CustomerContact[];
      ks.push(...part);
      if (part.length < CHUNK || ks.length >= MAX_CUSTOMERS) break;
    }
    setCanSeeContacts(contactsOk);
    setContacts(Object.fromEntries(ks.map(k => [k.member_no, k])));
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const pickFile = async (file: File | null) => {
    if (!file) return;
    setError(''); setImported(null); setFileName(file.name);
    try {
      const { headers: h, rows: r } = await readTable(file);
      if (h.length === 0) { setError('ファイルの中身を読み取れませんでした'); return; }
      setHeaders(h); setRows(r); setMap(guessMapping(h));
    } catch {
      setError('ファイルを開けませんでした。CSV か Excel を選んでください。');
    }
  };

  const built = useMemo(() => (rows.length ? buildCustomers(rows, map) : null), [rows, map]);
  const existing = useMemo(() => new Set(list.map(c => c.member_no)), [list]);
  const addCount = built ? built.ok.filter(c => !existing.has(c.member_no)).length : 0;
  const updCount = built ? built.ok.length - addCount : 0;
  const missing = built
    ? list.filter(c => c.active && !built.ok.some(o => o.member_no === c.member_no))
    : [];

  const doImport = async () => {
    if (!built || built.ok.length === 0) return;
    setBusy(true); setError('');
    const { data: me } = await supabase.auth.getUser();
    const now = new Date().toISOString();
    const uid = me.user?.id ?? null;

    // 一度に送る件数を区切る。数千件を1回で送ると途中で切れることがある
    const CHUNK = 200;
    for (let i = 0; i < built.ok.length; i += CHUNK) {
      const part = built.ok.slice(i, i + CHUNK);
      const { error: err1 } = await supabase.from('room_customers').upsert(
        part.map(c => ({
          member_no: c.member_no, display_name: c.display_name, full_name: c.full_name,
          last_name: c.last_name, first_name: c.first_name,
          last_kana: c.last_kana, first_kana: c.first_kana,
          birth_date: c.birth_date, imported_at: now, updated_at: now, updated_by: uid,
        })), { onConflict: 'member_no' });
      if (err1) {
        setBusy(false);
        setError('取り込みの途中で保存できませんでした。もう一度お試しください。');
        await load(); return;
      }
      // 連絡先は、値が1つでもある行だけ入れる
      const withContact = part.filter(c => c.phone || c.mobile || c.email || c.guardian_name);
      if (withContact.length > 0) {
        const { error: err2 } = await supabase.from('room_customer_contacts').upsert(
          withContact.map(c => ({
            member_no: c.member_no, phone: c.phone, mobile: c.mobile, email: c.email,
            guardian_name: c.guardian_name, updated_at: now, updated_by: uid,
          })), { onConflict: 'member_no' });
        if (err2) {
          setBusy(false);
          setError('お名前は取り込めましたが、連絡先を保存できませんでした。');
          await load(); return;
        }
      }
    }
    setBusy(false);
    setImported({ added: addCount, updated: updCount });
    await load();
    await onDone(`お客様を取り込みました（追加${addCount}件・更新${updCount}件）`);
  };

  /**
   * 手入力でお客様を1人追加する。
   * 🚨 ふりがなは、打たれたのがカタカナでも**ひらがなに直して**保存する。
   *    取り込みと同じ持ち方にしないと、予約表の表示や検索が片方だけ崩れる。
   */
  const addOne = async () => {
    const no = form.member_no.trim();
    if (!no) { setError('会員番号を入れてください'); return; }
    if (!form.last_name.trim()) { setError('姓を入れてください'); return; }
    if (list.some(c => c.member_no === no)) {
      setError(`会員番号 ${no} のお客様はすでに登録されています。一覧から探してください`);
      return;
    }
    const birth = form.birth_date.trim() ? parseBirthDate(form.birth_date.trim()) : null;
    if (form.birth_date.trim() && !birth) {
      setError('生年月日は 2020-04-01 のように入れてください'); return;
    }
    setSaving(true); setError('');
    const { data: me } = await supabase.auth.getUser();
    const now = new Date().toISOString();
    const uid = me.user?.id ?? null;
    const lastName = form.last_name.trim();
    const { error: err } = await supabase.from('room_customers').insert({
      member_no: no,
      display_name: `${lastName}様`,
      full_name: [lastName, form.first_name.trim()].filter(Boolean).join(' ') || null,
      last_name: lastName,
      first_name: form.first_name.trim() || null,
      last_kana: toHiragana(form.last_kana.trim()) || null,
      first_kana: toHiragana(form.first_kana.trim()) || null,
      birth_date: birth,
      note: form.note.trim() || null,
      updated_at: now, updated_by: uid,
    });
    if (err) {
      setSaving(false);
      setError('登録できませんでした。会員番号が重なっていないか確認してください。');
      return;
    }
    // 連絡先は、何か入っているときだけ作る
    if (form.phone.trim() || form.mobile.trim() || form.email.trim() || form.guardian_name.trim()) {
      await supabase.from('room_customer_contacts').upsert({
        member_no: no,
        phone: form.phone.trim() || null,
        mobile: form.mobile.trim() || null,
        email: form.email.trim() || null,
        guardian_name: form.guardian_name.trim() || null,
        updated_at: now, updated_by: uid,
      }, { onConflict: 'member_no' });
    }
    setSaving(false);
    setForm({
      member_no: '', last_name: '', first_name: '', last_kana: '', first_kana: '',
      birth_date: '', phone: '', mobile: '', email: '', guardian_name: '', note: '',
    });
    setSub('list');
    await load();
    await onDone(`${lastName}様を登録しました`);
  };

  const setActive = async (c: Customer, v: boolean) => {
    setBusy(true);
    const { error: err } = await supabase.from('room_customers')
      .update({ active: v, updated_at: new Date().toISOString() }).eq('member_no', c.member_no);
    setBusy(false);
    if (err) { setError('変えられませんでした。通信を確認してください。'); return; }
    await load();
  };

  const shown = list.filter(c => {
    if (!q.trim()) return true;
    const k = q.trim().toLowerCase();
    // ふりがなでも探せるようにする（漢字が読めなくても引ける）。
    // 🚨 一覧にはカタカナで出しているので、カタカナで打つ人がいる。
    //    中はひらがなで持っているため、打った文字をひらがなに直してから比べる
    const kh = toHiragana(k);
    return c.member_no.toLowerCase().includes(k)
      || c.display_name.toLowerCase().includes(k)
      || (c.full_name ?? '').toLowerCase().includes(k)
      || `${c.last_name ?? ''}${c.first_name ?? ''}`.toLowerCase().includes(k)
      || `${c.last_kana ?? ''}${c.first_kana ?? ''}`.includes(kh)
      || `${c.last_kana ?? ''} ${c.first_kana ?? ''}`.includes(kh);
  });

  // ---- ページ切り替え（300名ごと）----
  const PAGE_SIZE = 300;
  const pageCount = Math.max(1, Math.ceil(shown.length / PAGE_SIZE));
  // 🚨 絞り込みでページ数が減ったときに空ページを出さないよう、表示は必ず範囲内に丸める
  const safePage = Math.min(page, pageCount - 1);
  const pageStart = safePage * PAGE_SIZE;
  const paged = shown.slice(pageStart, pageStart + PAGE_SIZE);

  const pager = pageCount > 1 ? (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
      padding: '8px 0', flexWrap: 'wrap',
    }}>
      <button
        onClick={() => setPage(p => Math.max(0, Math.min(p, pageCount - 1) - 1))}
        disabled={safePage === 0}
        style={{
          ...smallBtn(false), opacity: safePage === 0 ? 0.4 : 1,
          cursor: safePage === 0 ? 'default' : 'pointer',
        }}
      >← 前へ</button>
      <span style={{ fontSize: 12.5, color: textMid }}>
        {pageStart + 1}〜{Math.min(pageStart + PAGE_SIZE, shown.length)}名
        （{safePage + 1} / {pageCount}ページ）
      </span>
      <button
        onClick={() => setPage(p => Math.min(pageCount - 1, Math.min(p, pageCount - 1) + 1))}
        disabled={safePage >= pageCount - 1}
        style={{
          ...smallBtn(false), opacity: safePage >= pageCount - 1 ? 0.4 : 1,
          cursor: safePage >= pageCount - 1 ? 'default' : 'pointer',
        }}
      >次へ →</button>
    </div>
  ) : null;

  return (
    <div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
        {([['list', '一覧'], ['new', '1人ずつ追加'], ['import', '取り込み']] as const).map(([k, l]) => (
          <button key={k} onClick={() => { setSub(k); setError(''); }} style={smallBtn(sub === k)}>{l}</button>
        ))}
      </div>

      {error && (
        <div style={{ background: isDark ? '#4a2a2a' : '#fdecea', border: `1px solid ${isDark ? '#7a4444' : '#f5c6cb'}`, color: isDark ? '#ffb4b4' : '#a3282a', borderRadius: 8, padding: '9px 12px', fontSize: 13, marginBottom: 12 }}>
          {error}
        </div>
      )}

      {/* ---- 一覧 ---- */}
      {sub === 'list' && (loading ? (
        <p style={{ fontSize: 13.5, color: textMid }}>読み込んでいます...</p>
      ) : (
        <>
          <input value={q} onChange={e => { setQ(e.target.value); setPage(0); }}
            placeholder="会員番号・お名前で探す" style={{ ...input, width: '100%', marginBottom: 10 }} />
          <p style={{ fontSize: 12.5, color: textMid, margin: '0 0 10px', lineHeight: 1.6 }}>
            {list.length}名（表示 {shown.length}名）。会員番号の順に並んでいます。
            学年は生年月日から計算しています。
            {!canSeeContacts && ' 連絡先は、いまの公開範囲では表示されません。'}
            {overCap && ' 🚨 5,000名を超えています。5,000名までを表示しています。'}
          </p>
          {pager}
          {paged.map(c => {
            const k = contacts[c.member_no];
            return (
              <div key={c.member_no} style={{ borderTop: `1px solid ${lineSoft}`, padding: '9px 0' }}>
                <div style={{ display: 'flex', gap: 9, alignItems: 'center', flexWrap: 'wrap' }}>
                  {/* 一覧はフルネーム（漢字）＋カタカナのふりがな（2026-08-31 ユーザー指示）。
                      予約表のほうは「田中 たろう」のまま。用途が違うので出し分ける */}
                  <b style={{ fontSize: 14, color: c.active ? text : textMid }}>
                    {customerFullName(c)}{!c.active && '（退会）'}
                  </b>
                  {customerKana(c) && (
                    <span style={{ fontSize: 12.5, color: textMid }}>{customerKana(c)}</span>
                  )}
                  <span style={{ fontSize: 12.5, color: textMid }}>
                    {c.member_no}
                    {c.birth_date && ` / ${gradeOrAge(c.birth_date, today)}`}
                  </span>
                  <span style={{ marginLeft: 'auto', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {/* この方で予約を入れる流れへ。場所と時間は予約表で選ぶ */}
                    {c.active && (
                      <button disabled={busy} onClick={() => onBook(c)} style={smallBtn(true)}>
                        予約する
                      </button>
                    )}
                    <button disabled={busy} onClick={() => setActive(c, !c.active)}
                      style={smallBtn(false)}>
                      {c.active ? '退会にする' : '在籍に戻す'}
                    </button>
                  </span>
                </div>
                {/* 🚨 固定と携帯が両方あるときは両方出す（2026-08-31 ユーザー指示）。
                       どちらに掛けるかは現場が選ぶので、片方に寄せない */}
                {contactLines(k).length > 0 && (
                  <div style={{ fontSize: 12.5, color: textMid, marginTop: 4 }}>
                    {contactLines(k).join(' / ')}
                  </div>
                )}
              </div>
            );
          })}
          {pager}
          {shown.length === 0 && (
            <p style={{ fontSize: 12.5, color: textMid, marginTop: 10 }}>
              見つかりませんでした。会員番号・お名前・ふりがなで探せます
            </p>
          )}
        </>
      ))}

      {/* ---- 1人ずつ追加 ---- */}
      {sub === 'new' && (
        <>
          <div style={{ background: lineSoft, borderRadius: 8, padding: '10px 12px', fontSize: 13, lineHeight: 1.7, marginBottom: 12, color: textMid }}>
            取り込みを使わずに、1人だけ登録します。
            <br />
            🚨 <b>会員番号は必須</b>です。お客様を1人と見分ける唯一の手がかりなので、
            空のままだと同じ方が二重に増えてしまいます。
            <br />
            会員番号を持たない一般の方は、ここには登録せず、
            予約フォームでお名前を直接入れてください。
            <br />
            ふりがなはカタカナで入れても、ひらがなに直して保存します。
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
            {([
              ['member_no', '会員番号（必須）', '2014052061'],
              ['last_name', '姓（必須）', '田中'],
              ['first_name', '名', '太郎'],
              ['last_kana', 'フリガナ（姓）', 'タナカ'],
              ['first_kana', 'フリガナ（名）', 'タロウ'],
              ['birth_date', '生年月日', '2015-04-02'],
              ['phone', '固定電話', '075-123-4567'],
              ['mobile', '携帯番号', '090-1234-5678'],
              ['email', 'メール', ''],
              ['guardian_name', '保護者名', ''],
              ['note', 'メモ', ''],
            ] as const).map(([key, label, ph]) => (
              <div key={key} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ fontSize: 13, minWidth: 116 }}>{label}</span>
                <input value={form[key]} placeholder={ph}
                  onChange={e => setForm(p => ({ ...p, [key]: e.target.value }))}
                  style={{ ...input, flex: 1, minWidth: 160 }} />
              </div>
            ))}
          </div>

          <button onClick={addOne} disabled={saving}
            style={{ marginTop: 14, padding: '10px 18px', borderRadius: 8, border: 'none', background: accent, color: isDark ? '#1d2a24' : '#fff', fontSize: 14.5, fontWeight: 700, cursor: saving ? 'wait' : 'pointer' }}>
            {saving ? '登録しています...' : '登録する'}
          </button>
        </>
      )}

      {/* ---- 取り込み ---- */}
      {sub === 'import' && (
        <>
          <div style={{ background: lineSoft, borderRadius: 8, padding: '10px 12px', fontSize: 13, lineHeight: 1.7, marginBottom: 12, color: textMid }}>
            スコラプラスから出したファイル（CSV / Excel）を選んでください。
            <b>会員番号をキーに、いる人は更新・いない人は追加</b>します。
            <br />
            🚨 ファイルに載っていない人は<b>消しません</b>。退会にするかどうかは、下の一覧を見て決めてください。
          </div>

          <input type="file" accept=".csv,.xlsx,.xls,text/csv"
            onChange={e => pickFile(e.target.files?.[0] ?? null)}
            style={{ ...input, width: '100%', marginBottom: 12 }} />

          {headers.length > 0 && (
            <>
              <div style={{ fontSize: 12.5, fontWeight: 700, color: textMid, marginBottom: 8 }}>
                列の対応づけ（{fileName}）
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
                {(Object.keys(FIELD_LABEL) as CustomerField[]).map(f => (
                  <div key={f} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span style={{ fontSize: 13, minWidth: 76 }}>
                      {FIELD_LABEL[f]}{REQUIRED_FIELDS.includes(f) && <span style={{ color: accent }}> *</span>}
                    </span>
                    <select value={map[f] ?? -1} style={{ ...input, flex: 1 }}
                      onChange={e => {
                        const v = Number(e.target.value);
                        setMap(prev => {
                          const next = { ...prev };
                          if (v < 0) delete next[f]; else next[f] = v;
                          return next;
                        });
                      }}>
                      <option value={-1}>（使わない）</option>
                      {headers.map((h, i) => (
                        <option key={i} value={i}>{h || `${i + 1}列目`}</option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>

              {built && (
                <div style={{ border: `1px solid ${line}`, borderRadius: 8, padding: '10px 12px', marginBottom: 12, fontSize: 13, lineHeight: 1.8 }}>
                  <b>取り込む前の確認</b>
                  <div>追加 {addCount}件 ／ 更新 {updCount}件</div>
                  {built.ng.length > 0 && (
                    <div style={{ color: isDark ? '#ffb4b4' : '#a3282a', marginTop: 4 }}>
                      読めなかった行 {built.ng.length}件：
                      {built.ng.slice(0, 5).map(n => `${n.line}行目（${n.reason}）`).join('、')}
                      {built.ng.length > 5 && ' …'}
                    </div>
                  )}
                  {missing.length > 0 && (
                    <div style={{ color: textMid, marginTop: 4 }}>
                      このファイルに載っていない在籍者 {missing.length}名（消しません）：
                      {missing.slice(0, 5).map(m => m.display_name).join('、')}
                      {missing.length > 5 && ' …'}
                    </div>
                  )}
                </div>
              )}

              <button onClick={doImport} disabled={busy || !built || built.ok.length === 0}
                style={{ padding: '10px 18px', borderRadius: 8, border: 'none', background: accent, color: isDark ? '#1d2a24' : '#fff', fontSize: 14.5, fontWeight: 700, cursor: busy ? 'wait' : 'pointer', opacity: busy || !built || built.ok.length === 0 ? .6 : 1 }}>
                {busy ? '取り込んでいます...' : `${built?.ok.length ?? 0}件を取り込む`}
              </button>

              {imported && (
                <p style={{ fontSize: 13, color: accent, marginTop: 10, fontWeight: 700 }}>
                  取り込みました（追加{imported.added}件・更新{imported.updated}件）
                </p>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
};

/**
 * スタッフの設定（社員が変更できる。2026-08-29 ユーザー確定で管理者用から移した）。
 * 追加・非表示・担当できる区分の切り替え。
 *
 * 🚨 レッスン区分そのものの追加・文言変更は管理者のまま（ユーザー確定）。
 *    ここで切り替えるのは「誰がどの区分を担当するか」だけ。
 */
const StaffSettings: React.FC<{
  staff: Staff[]; categories: LessonCategory[];
  onChanged: (msg: string) => Promise<void>; isDark: boolean;
}> = ({ staff, categories, onChanged, isDark }) => {
  const [newStaffName, setNewStaffName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const lineSoft = isDark ? '#35354e' : '#eef0f3';
  const line = isDark ? '#3a3a5c' : '#e0e0e0';
  const text = isDark ? '#eeeeee' : '#222222';
  const textMid = isDark ? '#b3b8c6' : '#5b6270';
  const accent = isDark ? '#6bbd92' : '#2f6f4f';
  const fieldBg = isDark ? '#495057' : '#fff';

  const input: React.CSSProperties = {
    padding: '7px 9px', borderRadius: 8, border: `1px solid ${line}`,
    background: fieldBg, color: text, fontSize: 16, boxSizing: 'border-box',
  };
  const smallBtn = (on: boolean): React.CSSProperties => ({
    padding: '4px 10px', borderRadius: 999, fontSize: 12.5, cursor: busy ? 'wait' : 'pointer',
    border: `1px solid ${on ? accent : line}`,
    background: on ? accent : 'transparent',
    color: on ? (isDark ? '#1d2a24' : '#fff') : textMid,
    fontWeight: on ? 700 : 400,
  });

  /** 失敗しても画面を壊さず、理由だけ出す小さなラッパ */
  const run = async (fn: () => Promise<{ error: unknown } | void>, msg: string) => {
    setBusy(true); setError('');
    try {
      const r = await fn();
      if (r && 'error' in r && r.error) {
        setError('保存できませんでした。同じ名前がすでに登録されていないか確認してください。');
        setBusy(false); return;
      }
      await onChanged(msg);
    } catch {
      setError('保存できませんでした。通信を確認してもう一度お試しください。');
    }
    setBusy(false);
  };

  const toggleCategory = (s: Staff, catId: string) => {
    const has = s.categoryIds?.includes(catId);
    run(async () => has
      ? await supabase.from('room_staff_categories').delete().eq('staff_id', s.id).eq('category_id', catId)
      : await supabase.from('room_staff_categories').insert({ staff_id: s.id, category_id: catId }),
      '担当できる区分を変えました');
  };

  return (
    <div>
      {error && (
        <div style={{ background: isDark ? '#4a2a2a' : '#fdecea', border: `1px solid ${isDark ? '#7a4444' : '#f5c6cb'}`, color: isDark ? '#ffb4b4' : '#a3282a', borderRadius: 8, padding: '9px 12px', fontSize: 13, marginBottom: 12 }}>
          {error}
        </div>
      )}
      <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
        <input value={newStaffName} onChange={e => setNewStaffName(e.target.value)}
          placeholder="スタッフの名前（例：山田 太郎）" style={{ ...input, flex: 1 }} />
        <button disabled={busy || !newStaffName.trim()}
          onClick={() => run(async () => {
            const r = await supabase.from('room_staff').insert({
              name: newStaffName.trim(), sort_order: staff.length + 1,
            });
            if (!r.error) setNewStaffName('');
            return r;
          }, 'スタッフを追加しました')}
          style={{ padding: '7px 16px', borderRadius: 8, border: 'none', background: accent, color: isDark ? '#1d2a24' : '#fff', fontSize: 13.5, fontWeight: 700, cursor: busy ? 'wait' : 'pointer', opacity: (busy || !newStaffName.trim()) ? .5 : 1 }}>
          追加
        </button>
      </div>

      <p style={{ fontSize: 12, color: textMid, margin: '0 0 10px', lineHeight: 1.6 }}>
        記号を押すと、そのスタッフが担当できる区分を切り替えられます。
        「表示中／非表示」で、予約フォームの選択肢に出すかどうかを変えられます（過去の予約は残ります）。
      </p>

      {staff.map(s => (
        <div key={s.id} style={{ borderTop: `1px solid ${lineSoft}`, padding: '10px 0' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 7, flexWrap: 'wrap' }}>
            <b style={{ fontSize: 14, color: s.active ? text : textMid }}>
              {s.name}{!s.active && '（非表示）'}
            </b>
            <button disabled={busy}
              onClick={() => run(async () => await supabase.from('room_staff')
                .update({ active: !s.active }).eq('id', s.id),
                s.active ? `${s.name} を非表示にしました` : `${s.name} を表示に戻しました`)}
              style={{ ...smallBtn(false), marginLeft: 'auto' }}>
              {s.active ? '非表示にする' : '表示に戻す'}
            </button>
          </div>
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
            {categories.map(c => (
              <button key={c.id} disabled={busy} onClick={() => toggleCategory(s, c.id)}
                title={c.description}
                style={smallBtn(!!s.categoryIds?.includes(c.id))}>{c.code}</button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
};

const BasicSettingsPanel: React.FC<{
  campuses: Campus[]; floors: Floor[]; staff: Staff[]; categories: LessonCategory[];
  purposeDurations: PurposeDuration[]; purposeDetails: PurposeDetail[];
  attendanceOptions: AttendanceOption[]; user: AuthUser;
  /** 一覧の「予約する」から、そのお客様で予約を入れる流れに移る */
  onBook: (c: Customer) => void;
  onClose: () => void; onDone: (msg: string) => Promise<void>; isDark: boolean;
}> = ({ campuses, floors, staff, categories, purposeDurations, purposeDetails, attendanceOptions, user, onBook, onClose, onDone, isDark }) => {
  const today = todayStr();
  const [tab, setTab] = useState<'renew' | 'duration' | 'attendance' | 'staff' | 'customer' | 'waitlist' | 'bulk'>('renew');
  const [fy, setFy] = useState(fiscalYear(today));
  const [rows, setRows] = useState<RenewRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [finished, setFinished] = useState(false);
  // まとめて置換（担当と場所だけ。参加者は人ごとに違うので行ごとに直す）
  const [staffFrom, setStaffFrom] = useState('');
  const [staffTo, setStaffTo] = useState('');
  const [floorFrom, setFloorFrom] = useState('');
  const [floorTo, setFloorTo] = useState('');

  const line = isDark ? '#3a3a5c' : '#e0e0e0';
  const lineSoft = isDark ? '#35354e' : '#eef0f3';
  const text = isDark ? '#eeeeee' : '#222222';
  const textMid = isDark ? '#b3b8c6' : '#5b6270';
  const accent = isDark ? '#6bbd92' : '#2f6f4f';
  const fieldBg = isDark ? '#495057' : '#fff';

  const input: React.CSSProperties = {
    padding: '5px 7px', borderRadius: 6, border: `1px solid ${line}`,
    background: fieldBg, color: text, fontSize: 16, boxSizing: 'border-box',
  };
  const smallBtn = (on: boolean): React.CSSProperties => ({
    padding: '4px 10px', borderRadius: 999, fontSize: 12.5,
    cursor: running ? 'wait' : 'pointer',
    border: `1px solid ${on ? accent : line}`,
    background: on ? accent : 'transparent',
    color: on ? (isDark ? '#1d2a24' : '#fff') : textMid,
    fontWeight: on ? 700 : 400,
  });

  const placeName = useCallback((floorId: string): string => {
    const f = floors.find(x => x.id === floorId) ?? null;
    const c = campuses.find(x => x.id === f?.campus_id);
    const siblings = floors.filter(x => x.campus_id === f?.campus_id).length;
    return placeLabel(f, c?.name ?? '', siblings, true);
  }, [floors, campuses]);

  const load = useCallback(async () => {
    setLoading(true); setError(''); setFinished(false); setProgress(0);
    const { data, error: err } = await supabase
      .from('room_recurrences').select('*')
      .in('fiscal_year', [fy, fy + 1]).eq('active', true);
    if (err || !data) {
      setError('繰り返しの一覧を読み込めませんでした。通信を確認して開き直してください。');
      setLoading(false); return;
    }
    const all = data as Recurrence[];
    // 引き継ぎ済みは「次の年度の行が renewed_from で自分を指している」もの
    const done = new Set(all.filter(r => r.fiscal_year === fy + 1 && r.renewed_from)
      .map(r => r.renewed_from as string));
    const campusOrder = new Map(campuses.map((c, i) => [c.id, i]));
    const floorOrder = new Map(floors.map((f, i) => [f.id, i]));
    const list: RenewRow[] = all.filter(r => r.fiscal_year === fy).map(r => ({
      src: r,
      checked: !done.has(r.id),      // 大半は続くので、既定は「続ける」
      floorId: r.floor_id,
      weekday: r.weekday,
      startTime: r.start_time.slice(0, 5),
      endTime: r.end_time.slice(0, 5),
      staffId: r.staff_id ?? '',
      memberNo: r.member_no ?? '',
      customerLabel: r.customer_label ?? '',
      done: done.has(r.id),
      result: null,
    }));
    list.sort((a, b) => {
      const fa = floors.find(f => f.id === a.floorId), fb = floors.find(f => f.id === b.floorId);
      const ca = campusOrder.get(fa?.campus_id ?? '') ?? 99;
      const cb = campusOrder.get(fb?.campus_id ?? '') ?? 99;
      if (ca !== cb) return ca - cb;
      const oa = floorOrder.get(a.floorId) ?? 99, ob = floorOrder.get(b.floorId) ?? 99;
      if (oa !== ob) return oa - ob;
      if (a.weekday !== b.weekday) return a.weekday - b.weekday;
      return a.startTime.localeCompare(b.startTime);
    });
    setRows(list);
    setLoading(false);
  }, [fy, campuses, floors]);

  useEffect(() => { load(); }, [load]);

  const patch = (id: string, p: Partial<RenewRow>) =>
    setRows(prev => prev.map(r => (r.src.id === id ? { ...r, ...p } : r)));

  const targets = rows.filter(r => r.checked && !r.done);
  const remaining = rows.filter(r => !r.done).length;

  /** 担当・場所をまとめて置き換える。引き継ぎ済みの行には触らない */
  const applyStaffSwap = () => {
    if (!staffFrom || !staffTo) return;
    setRows(prev => prev.map(r => (!r.done && r.staffId === staffFrom ? { ...r, staffId: staffTo } : r)));
  };
  const applyFloorSwap = () => {
    if (!floorFrom || !floorTo) return;
    setRows(prev => prev.map(r => (!r.done && r.floorId === floorFrom ? { ...r, floorId: floorTo } : r)));
  };

  const run = async () => {
    if (!targets.length) { setError('引き継ぐものを選んでください'); return; }
    setRunning(true); setError(''); setProgress(0); setFinished(false);
    let ok = 0, ng = 0;
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      const { data, error: err } = await supabase.rpc('room_renew_recurrence', {
        p_recurrence_id: t.src.id,
        p_fiscal_year: fy + 1,
        p_floor_id: t.floorId,
        p_weekday: t.weekday,
        p_start_time: t.startTime,
        p_end_time: t.endTime,
        p_staff_id: t.staffId || null,
        p_member_no: t.memberNo.trim(),
        p_customer_label: t.customerLabel.trim(),
      });
      const row = (Array.isArray(data) ? data[0] : data) as
        { ok?: boolean; reason?: string; made?: number; skipped?: string[] } | null;
      if (err) {
        patch(t.src.id, { result: { made: 0, skipped: [], error: '通信に失敗しました' } });
        ng++;
      } else if (row?.ok) {
        patch(t.src.id, { done: true, result: { made: row.made ?? 0, skipped: row.skipped ?? [] } });
        ok++;
      } else {
        patch(t.src.id, {
          result: { made: 0, skipped: row?.skipped ?? [], error: row?.reason ?? '作成できませんでした' },
        });
        ng++;
      }
      setProgress(i + 1);
    }
    setRunning(false); setFinished(true);
    await onDone(ng === 0
      ? `${ok}件を${fy + 1}年度に引き継ぎました`
      : `${ok}件を引き継ぎました（${ng}件は作成できませんでした）`);
  };

  return (
    <Overlay onClose={onClose} isDark={isDark} title="基本設定" wide>
      <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
        {([['renew', '年度更新'], ['waitlist', 'キャンセル待ち'], ['customer', 'お客様'],
           ['bulk', '予約の一括入力'], ['staff', 'スタッフ'], ['duration', '用途詳細'],
           ['attendance', '出欠の選択肢']] as const)
          .map(([k, l]) => (
            <button key={k} onClick={() => !running && setTab(k)} style={smallBtn(tab === k)}>{l}</button>
          ))}
      </div>

      {tab === 'duration' && (
        <PurposeSettings purposeDurations={purposeDurations} purposeDetails={purposeDetails} onDone={onDone} isDark={isDark} />
      )}
      {tab === 'attendance' && (
        <AttendanceOptionSettings options={attendanceOptions} onDone={onDone} isDark={isDark} />
      )}

      {tab === 'staff' && (
        <StaffSettings staff={staff} categories={categories} onChanged={onDone} isDark={isDark} />
      )}

      {tab === 'customer' && (
        <CustomerSettings isDark={isDark} onDone={onDone} onBook={onBook} />
      )}

      {tab === 'waitlist' && (
        <WaitlistSettings floors={floors} campuses={campuses} staff={staff}
          isDark={isDark} onDone={onDone} />
      )}

      {tab === 'bulk' && (
        <BulkBookingPanel floors={floors} campuses={campuses} staff={staff}
          purposeDurations={purposeDurations} user={user} isDark={isDark} onDone={onDone} />
      )}

      {tab === 'renew' && (<>
      {/* 何をする画面なのかを最初に書く。年1回しか使わないので、毎回説明が要る */}
      <div style={{ background: isDark ? '#4a4326' : '#fff8e1', border: `1px solid ${isDark ? '#8a7a3a' : '#ffe082'}`, color: isDark ? '#ffe6a3' : '#7a5c00', borderRadius: 8, padding: '10px 12px', fontSize: 13, lineHeight: 1.7, marginBottom: 14 }}>
        毎週の予約は<b>年度末（3/31）で終わります</b>。続けるものを選んで、次の年度に作り直してください。
        <br />
        担当や場所が変わる場合は、ここで直してから作成できます。
        休講にした回や、この年度だけの変更は引き継がれません。
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12.5, color: textMid }}>引き継ぐ年度</span>
        {[fiscalYear(today) - 1, fiscalYear(today)].map(y => (
          <button key={y} onClick={() => !running && setFy(y)} style={smallBtn(fy === y)}>
            {fiscalYearLabel(y)}
          </button>
        ))}
        <span style={{ fontSize: 12.5, color: textMid, marginLeft: 'auto' }}>
          → <b style={{ color: accent }}>{fy + 1}年度</b>（{fy + 1}/4/1〜{fy + 2}/3/31）に作ります
        </span>
      </div>

      {error && (
        <div style={{ background: isDark ? '#4a2a2a' : '#fdecea', border: `1px solid ${isDark ? '#7a4444' : '#f5c6cb'}`, color: isDark ? '#ffb4b4' : '#a3282a', borderRadius: 8, padding: '9px 12px', fontSize: 13, marginBottom: 12 }}>
          {error}
        </div>
      )}

      {loading ? (
        <p style={{ fontSize: 13.5, color: textMid }}>読み込んでいます...</p>
      ) : rows.length === 0 ? (
        <p style={{ fontSize: 13.5, color: textMid, lineHeight: 1.7 }}>
          {fy}年度の毎週の予約はありません。
        </p>
      ) : (
        <>
          {/* まとめて置換。担当交代・教室移動はまとめて起きるのでここで一度に直す */}
          <div style={{ background: lineSoft, borderRadius: 8, padding: '10px 12px', marginBottom: 12 }}>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: textMid, marginBottom: 8 }}>
              まとめて変える（引き継ぎ済みの行は変わりません）
            </div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
              <span style={{ fontSize: 13, minWidth: 34 }}>担当</span>
              <select value={staffFrom} onChange={e => setStaffFrom(e.target.value)} style={input}>
                <option value="">選んでください</option>
                {staff.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              <span style={{ fontSize: 13 }}>→</span>
              <select value={staffTo} onChange={e => setStaffTo(e.target.value)} style={input}>
                <option value="">選んでください</option>
                {staff.filter(s => s.active).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              <button onClick={applyStaffSwap} disabled={!staffFrom || !staffTo || running}
                style={{ ...smallBtn(false), opacity: !staffFrom || !staffTo ? .5 : 1 }}>
                まとめて変える
              </button>
            </div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13, minWidth: 34 }}>場所</span>
              <select value={floorFrom} onChange={e => setFloorFrom(e.target.value)} style={input}>
                <option value="">選んでください</option>
                {floors.map(f => <option key={f.id} value={f.id}>{placeName(f.id)}</option>)}
              </select>
              <span style={{ fontSize: 13 }}>→</span>
              <select value={floorTo} onChange={e => setFloorTo(e.target.value)} style={input}>
                <option value="">選んでください</option>
                {floors.map(f => <option key={f.id} value={f.id}>{placeName(f.id)}</option>)}
              </select>
              <button onClick={applyFloorSwap} disabled={!floorFrom || !floorTo || running}
                style={{ ...smallBtn(false), opacity: !floorFrom || !floorTo ? .5 : 1 }}>
                まとめて変える
              </button>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
            <button onClick={() => setRows(prev => prev.map(r => (r.done ? r : { ...r, checked: true })))}
              style={smallBtn(false)}>すべて選ぶ</button>
            <button onClick={() => setRows(prev => prev.map(r => ({ ...r, checked: false })))}
              style={smallBtn(false)}>すべて外す</button>
            <span style={{ fontSize: 12.5, color: textMid, marginLeft: 'auto' }}>
              全{rows.length}件／未更新 {remaining}件／選択中 {targets.length}件
            </span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {rows.map(r => (
              <div key={r.src.id}
                style={{ border: `1px solid ${r.done ? accent : line}`, borderRadius: 8, padding: '9px 11px', background: r.done ? (isDark ? '#263b33' : '#e8f2ec') : 'transparent' }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <input type="checkbox" checked={r.checked} disabled={r.done || running}
                    onChange={e => patch(r.src.id, { checked: e.target.checked })}
                    style={{ width: 18, height: 18, flexShrink: 0 }} />
                  <span style={{ fontSize: 13.5, fontWeight: 700 }}>
                    {r.src.purpose}
                    {r.src.kind === 'open' && <span style={{ color: textMid, fontWeight: 400 }}>（募集枠）</span>}
                  </span>
                  {r.done && <span style={{ fontSize: 12, color: accent, fontWeight: 700 }}>✓ 引き継ぎ済み</span>}
                </div>

                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
                  <select value={r.floorId} disabled={r.done || running}
                    onChange={e => patch(r.src.id, { floorId: e.target.value })} style={input}>
                    {floors.map(f => <option key={f.id} value={f.id}>{placeName(f.id)}</option>)}
                  </select>
                  <select value={r.weekday} disabled={r.done || running}
                    onChange={e => patch(r.src.id, { weekday: Number(e.target.value) })} style={input}>
                    {WEEKDAY_LABEL.map((w, i) => <option key={i} value={i}>{w}曜</option>)}
                  </select>
                  {/* 🚨 時刻は type="time" にしない。iOS がドラムを出すうえ、
                         アプリ全体でテンキー入力にそろえてある（lib/timeInput.ts 経由） */}
                  <TimeInput value={r.startTime} onChange={v => patch(r.src.id, { startTime: v })}
                    isDark={isDark} disabled={r.done || running}
                    ariaLabel={`${WEEKDAY_LABEL[r.weekday]}曜 開始時刻`} style={{ width: 118 }} />
                  <span style={{ fontSize: 13 }}>〜</span>
                  <TimeInput value={r.endTime} onChange={v => patch(r.src.id, { endTime: v })}
                    isDark={isDark} disabled={r.done || running}
                    ariaLabel={`${WEEKDAY_LABEL[r.weekday]}曜 終了時刻`} style={{ width: 118 }} />
                  <select value={r.staffId} disabled={r.done || running}
                    onChange={e => patch(r.src.id, { staffId: e.target.value })} style={input}>
                    <option value="">担当なし</option>
                    {staff.filter(s => s.active || s.id === r.staffId)
                      .map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </div>

                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginTop: 6 }}>
                  <span style={{ fontSize: 12.5, color: textMid, minWidth: 46 }}>参加者</span>
                  <input value={r.memberNo} disabled={r.done || running}
                    onChange={e => patch(r.src.id, { memberNo: e.target.value })}
                    placeholder="会員番号" style={{ ...input, width: 118 }} />
                  <input value={r.customerLabel} disabled={r.done || running}
                    onChange={e => patch(r.src.id, { customerLabel: e.target.value })}
                    placeholder="表示名（例：田中 太郎）" style={{ ...input, width: 168 }} />
                </div>

                {/* 🚨 入らなかった回を黙って捨てない。「全部入った」と誤解されると、
                       その時間が空いていると思い込まれて二重に埋まる */}
                {r.result && (
                  <div style={{ marginTop: 8, fontSize: 12.5, lineHeight: 1.7, color: r.result.error ? (isDark ? '#ffb4b4' : '#a3282a') : textMid }}>
                    {r.result.error
                      ? `⚠️ ${r.result.error}`
                      : `${r.result.made}回 作成しました`}
                    {r.result.skipped.length > 0 && (
                      <span style={{ display: 'block' }}>
                        先約があるため入らなかった日（{r.result.skipped.length}回）：
                        {r.result.skipped.map(formatDateLabel).join('、')}
                      </span>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>

          <div style={{ borderTop: `1px solid ${line}`, marginTop: 14, paddingTop: 12, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <button onClick={run} disabled={running || targets.length === 0}
              style={{ padding: '10px 18px', borderRadius: 8, border: 'none', background: accent, color: isDark ? '#1d2a24' : '#fff', fontSize: 14.5, fontWeight: 700, cursor: running || !targets.length ? 'not-allowed' : 'pointer', opacity: running || !targets.length ? .6 : 1 }}>
              {running
                ? `作成しています... ${progress}/${targets.length}件`
                : `選んだ${targets.length}件を${fy + 1}年度に作成する`}
            </button>
            {finished && (
              <span style={{ fontSize: 13, color: textMid }}>
                結果は各行に出しています。閉じると予約表に反映されます
              </span>
            )}
          </div>
        </>
      )}
      </>)}
    </Overlay>
  );
};

// ============================================================
// 設定（管理者だけ）
//   スタッフの追加・非表示・担当区分の変更、レッスン区分の追加・変更、
//   場所の同時予約件数と営業時間の変更。
//   🚨 ここが無いと、スタッフや区分が増えるたびに開発者へ依頼することになる。
//      現場で完結できるようにしておくこと（2026-08-28 ユーザー指示）。
// ============================================================
/**
 * 作業履歴（管理者だけが見る・2026-09-01 ユーザー指示）。
 *
 * 🚨 **新しい記録の仕組みは作っていない**。予約は消しても行が残る作り（deleted_at に印）で、
 *    作成・変更・削除の日時と実行者がすでに保存されているので、そこから組み立てている。
 * 🚨 そのため**限界が2つある**（画面にも書いてある）：
 *    ① 「変更」は**最後の1回だけ**。同じ予約を3回直しても履歴は1件
 *    ② **何を変えたかは分からない**（変更前の値を残していないため）
 *    全部を正確に残すなら変更のたびに書く監査テーブルが要る。そのときは
 *    DB容量（無料枠1GB）と、中心のテーブルにトリガーを付けることを考えること。
 * 🚨 期間は「予約の日」ではなく **作業をした日時** で絞る（履歴なので）。
 */
interface WorkEvent {
  at: string;                    // 作業した日時（ISO）
  kind: '作成' | '変更' | '休講' | '削除' | '出欠';
  who: string;                   // 実行した人
  what: string;                  // 対象の説明
}

const WorkHistory: React.FC<{
  floors: Floor[]; campuses: Campus[]; isDark: boolean;
}> = ({ floors, campuses, isDark }) => {
  const today = todayStr();
  const [mode, setMode] = useState<'month' | 'range'>('month');
  const [month, setMonth] = useState(today.slice(0, 7));
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [kinds, setKinds] = useState<string[]>([]);      // 空 = すべて
  const [events, setEvents] = useState<WorkEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [capped, setCapped] = useState(false);

  const line = isDark ? '#3a3a5c' : '#e0e0e0';
  const text = isDark ? '#eeeeee' : '#222222';
  const textMid = isDark ? '#b3b8c6' : '#5b6270';
  const accent = isDark ? '#6bbd92' : '#2f6f4f';
  const fieldBg = isDark ? '#495057' : '#fff';
  const input: React.CSSProperties = {
    padding: '6px 9px', borderRadius: 8, border: `1px solid ${line}`,
    background: fieldBg, color: text, fontSize: 16, boxSizing: 'border-box',
  };
  const chip = (on: boolean): React.CSSProperties => ({
    padding: '5px 12px', borderRadius: 999, fontSize: 12.5, cursor: 'pointer',
    border: `1px solid ${on ? accent : line}`,
    background: on ? accent : 'transparent',
    color: on ? (isDark ? '#1d2a24' : '#fff') : textMid,
    fontWeight: on ? 700 : 400,
  });

  const period = useMemo(() => {
    if (mode === 'month') {
      const [y, m] = month.split('-').map(Number);
      return { start: new Date(y, m - 1, 1), end: new Date(y, m, 1), label: `${y}年${m}月` };
    }
    const s = new Date(`${from}T00:00:00`);
    const e = new Date(`${to}T00:00:00`);
    e.setDate(e.getDate() + 1);
    return { start: s, end: e, label: `${formatDateLabel(from)}〜${formatDateLabel(to)}` };
  }, [mode, month, from, to]);

  const placeOf = (floorId: string) => {
    const f = floors.find(x => x.id === floorId);
    const c = f ? campuses.find(x => x.id === f.campus_id) : null;
    return f ? placeLabel(f, c?.name ?? '', floors.filter(x => x.campus_id === f.campus_id).length, true) : '';
  };

  const load = useCallback(async () => {
    setLoading(true); setError(''); setCapped(false);
    const CHUNK = 1000;
    const MAX = 20000;
    const s = period.start.toISOString();
    const e = period.end.toISOString();
    const inPeriod = (t: string | null) => !!t && t >= s && t < e;

    // ① 予約。🚨 消したものも含めて読む（削除の履歴を出すため）
    const bs: (Booking & { deleted_at: string | null; deleted_by: string | null })[] = [];
    for (let f = 0; ; f += CHUNK) {
      const { data, error: err } = await supabase.from('room_bookings').select('*')
        // 作成・変更・削除のどれかがこの期間に入っているものを拾う
        .or(`and(created_at.gte.${s},created_at.lt.${e}),`
          + `and(updated_at.gte.${s},updated_at.lt.${e}),`
          + `and(deleted_at.gte.${s},deleted_at.lt.${e})`)
        .order('updated_at', { ascending: false })
        .range(f, f + CHUNK - 1);
      if (err) { setError('作業履歴を読み込めませんでした。通信を確認してください。'); setLoading(false); return; }
      const part = (data ?? []) as (Booking & { deleted_at: string | null; deleted_by: string | null })[];
      bs.push(...part);
      if (part.length < CHUNK) break;
      if (bs.length >= MAX) { setCapped(true); break; }
    }

    // ② 出欠（付けた日時で絞る）
    const ats: (AttendanceRow & { room_bookings: { starts_at: string; floor_id: string; purpose: string } | null })[] = [];
    for (let f = 0; ; f += CHUNK) {
      const { data, error: err } = await supabase.from('room_booking_attendance')
        .select('*, room_bookings(starts_at, floor_id, purpose)')
        .gte('recorded_at', s).lt('recorded_at', e)
        .order('recorded_at', { ascending: false })
        .range(f, f + CHUNK - 1);
      if (err) { setError('作業履歴を読み込めませんでした。通信を確認してください。'); setLoading(false); return; }
      const part = (data ?? []) as typeof ats;
      ats.push(...part);
      if (part.length < CHUNK) break;
      if (ats.length >= MAX) { setCapped(true); break; }
    }

    // ③ 実行した人の名前。🚨 引けないことがある（権限）ので、引けなくても止めない
    const ids = [...new Set([
      ...bs.flatMap(b => [b.created_by, b.updated_by, b.deleted_by]),
      ...ats.map(a => a.recorded_by),
    ].filter(Boolean))] as string[];
    const names: Record<string, string> = {};
    if (ids.length > 0) {
      const { data } = await supabase.from('profiles').select('id, name').in('id', ids);
      for (const p of (data ?? []) as { id: string; name: string | null }[]) {
        if (p.name) names[p.id] = p.name;
      }
    }
    const who = (id: string | null, fallback = '') => (id && names[id]) || fallback || '（分かりません）';

    const out: WorkEvent[] = [];
    for (const b of bs) {
      const when = `${formatDateLabel(localDate(b.starts_at))} ${hhmm(b.starts_at)}〜${hhmm(b.ends_at)}`;
      const target = `${when}　${placeOf(b.floor_id)}　${purposeWithDetail(b)}`
        + (b.customer_label ? `　${b.customer_label}` : '');
      // 🚨 作成した人は booker_name にも残っている。profiles が引けないときの受け皿にする
      if (inPeriod(b.created_at)) out.push({ at: b.created_at, kind: '作成', who: who(b.created_by, b.booker_name), what: target });
      if (inPeriod(b.deleted_at)) out.push({ at: b.deleted_at!, kind: '削除', who: who(b.deleted_by), what: target });
      // 変更は「作成と同じ時刻」なら出さない（作った直後の保存を変更とは呼ばない）
      if (inPeriod(b.updated_at) && b.updated_at !== b.created_at) {
        out.push({
          at: b.updated_at,
          kind: b.status === 'cancelled' ? '休講' : '変更',
          who: who(b.updated_by), what: target,
        });
      }
    }
    for (const a of ats) {
      const rb = a.room_bookings;
      const target = (rb ? `${formatDateLabel(localDate(rb.starts_at))} ${hhmm(rb.starts_at)}　${placeOf(rb.floor_id)}　${rb.purpose}　` : '')
        + `${a.participant_name || a.participant_no || 'お名前なし'} → ${a.status}`
        + (a.payment_note ? `（支払い ${a.payment_note}）` : '');
      out.push({ at: a.recorded_at, kind: '出欠', who: who(a.recorded_by), what: target });
    }
    out.sort((x, y) => y.at.localeCompare(x.at));       // 新しい順
    setEvents(out);
    setLoading(false);
  }, [period, floors, campuses]);

  useEffect(() => { load(); }, [load]);

  const shown = kinds.length === 0 ? events : events.filter(e => kinds.includes(e.kind));
  const shiftMonth = (d: number) => {
    const [y, m] = month.split('-').map(Number);
    const dt = new Date(y, m - 1 + d, 1);
    setMonth(`${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`);
  };
  const stamp = (iso: string) => {
    const d = new Date(iso);
    return `${formatDateLabel(localDate(iso))} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  return (
    <div>
      <div style={{ background: isDark ? '#35354e' : '#f0f2f5', borderRadius: 8, padding: '10px 12px', fontSize: 13, lineHeight: 1.7, marginBottom: 12, color: textMid }}>
        誰がいつ予約を作った・変えた・休講にした・消したかと、出欠を付けた記録が出ます
        （<b style={{ color: text }}>全校ぶん・作業をした日時の順</b>）。
        <br />
        🚨 <b style={{ color: text }}>「変更」は最後の1回だけ</b>です。同じ予約を何度直しても1件しか出ません。
        <b style={{ color: text }}>何を変えたか</b>も残っていません（変更前の値を保存していないため）。
      </div>

      <div style={{ display: 'flex', gap: 7, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
        <button onClick={() => setMode('month')} style={chip(mode === 'month')}>月ごと</button>
        <button onClick={() => setMode('range')} style={chip(mode === 'range')}>期間を指定</button>
        {mode === 'month' ? (
          <>
            <button onClick={() => shiftMonth(-1)} style={{ ...chip(false), padding: '5px 11px' }} aria-label="前の月">◀</button>
            <b style={{ fontSize: 14, minWidth: 96, textAlign: 'center' }}>{period.label}</b>
            <button onClick={() => shiftMonth(1)} style={{ ...chip(false), padding: '5px 11px' }} aria-label="次の月">▶</button>
          </>
        ) : (
          <>
            <input type="date" value={from} onChange={e => setFrom(e.target.value)} style={input} />
            <span style={{ fontSize: 13, color: textMid }}>〜</span>
            <input type="date" value={to} onChange={e => setTo(e.target.value)} style={input} />
          </>
        )}
      </div>

      <div style={{ display: 'flex', gap: 7, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <span style={{ fontSize: 12.5, color: textMid }}>種類</span>
        <button onClick={() => setKinds([])} style={chip(kinds.length === 0)}>すべて</button>
        {(['作成', '変更', '休講', '削除', '出欠'] as const).map(k => (
          <button key={k} style={chip(kinds.includes(k))}
            onClick={() => setKinds(prev => prev.includes(k) ? prev.filter(x => x !== k) : [...prev, k])}>
            {k}
          </button>
        ))}
      </div>

      {error && (
        <div style={{ background: isDark ? '#4a2a2a' : '#fdecea', border: `1px solid ${isDark ? '#7a4444' : '#f5c6cb'}`, color: isDark ? '#ffb4b4' : '#a3282a', borderRadius: 8, padding: '9px 12px', fontSize: 13, marginBottom: 12 }}>
          {error}
        </div>
      )}
      {capped && (
        <div style={{ background: isDark ? '#4a3f2a' : '#fff6e0', border: `1px solid ${isDark ? '#7a6a44' : '#f0d9a0'}`, color: isDark ? '#e8c98a' : '#8a6a12', borderRadius: 8, padding: '9px 12px', fontSize: 13, marginBottom: 12 }}>
          件数が多いため途中までしか読めていません。期間を短くしてください。
        </div>
      )}

      {loading ? (
        <p style={{ fontSize: 13.5, color: textMid }}>読み込んでいます...</p>
      ) : shown.length === 0 ? (
        <p style={{ fontSize: 13.5, color: textMid, lineHeight: 1.7 }}>この期間の作業はありません。</p>
      ) : (
        <>
          <p style={{ fontSize: 12.5, color: textMid, margin: '0 0 7px' }}>{shown.length}件</p>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {shown.map((ev, i) => (
              <div key={i} style={{ display: 'flex', gap: 10, padding: '8px 2px', borderTop: `1px solid ${line}`, fontSize: 13, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                <span style={{ color: textMid, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{stamp(ev.at)}</span>
                <span style={{
                  borderRadius: 999, padding: '1px 10px', fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap',
                  background: ev.kind === '削除' ? (isDark ? '#4a2a2a' : '#fdecea')
                    : ev.kind === '作成' ? (isDark ? '#263b33' : '#e8f2ec')
                    : (isDark ? '#35354e' : '#eef0f3'),
                  color: ev.kind === '削除' ? (isDark ? '#ffb4b4' : '#a3282a')
                    : ev.kind === '作成' ? accent : textMid,
                }}>{ev.kind}</span>
                <span style={{ flex: 1, minWidth: 200 }}>{ev.what}</span>
                <span style={{ color: textMid, whiteSpace: 'nowrap' }}>{ev.who}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
};

// ============================================================
// 用途の設定（管理者のみ・2026-09-02 ユーザー承認・案②）
//
// 🚨 削除はできない（隠すだけ）。過去の予約に用途名が文字で残っているため。
// 🚨 色は PURPOSE_PALETTE の中からだけ選ぶ（自由な色コードを許すと
//    暗い画面で読めない色や、募集中の枠と紛らわしい色が選べてしまう）。
// 🚨 名前の変更は、同じ名前が5か所（予約・繰り返し・長さ設定・詳細・出欠の対象）に
//    あるので**まとめて書き換える**（用途詳細の名前変更と同じ方式・件数確認つき）。
// ============================================================
const PurposeMasterSettings: React.FC<{
  isDark: boolean; onChanged: (msg: string) => Promise<void>;
}> = ({ isDark, onChanged }) => {
  const [rows, setRows] = useState<RoomPurpose[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState('green');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');
  // 「過去◯件も変わります」を見せてから実行する（null = まだ数えていない）
  const [renameCounts, setRenameCounts] = useState<{ bookings: number; recurrences: number; options: number } | null>(null);

  const line = isDark ? '#3a3a5c' : '#e0e0e0';
  const text = isDark ? '#eeeeee' : '#222222';
  const textMid = isDark ? '#b3b8c6' : '#5b6270';
  const accent = isDark ? '#6bbd92' : '#2f6f4f';
  const fieldBg = isDark ? '#495057' : '#fff';
  const input: React.CSSProperties = {
    padding: '7px 9px', borderRadius: 8, border: `1px solid ${line}`,
    background: fieldBg, color: text, fontSize: 16, boxSizing: 'border-box',
  };
  const smallBtn: React.CSSProperties = {
    padding: '3px 11px', borderRadius: 8, border: `1px solid ${line}`, background: 'transparent',
    color: textMid, fontSize: 12.5, cursor: 'pointer',
  };

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error: err } = await supabase.from('room_purposes').select('*').order('sort_order');
    if (err) { setError('用途を読み込めませんでした。通信を確認して開き直してください。'); setLoading(false); return; }
    setRows((data ?? []) as RoomPurpose[]);
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  /** 色を選ぶ丸ボタンの並び */
  const colorPicker = (value: string, onPick: (key: string) => void) => (
    <span style={{ display: 'flex', gap: 5, alignItems: 'center', flexWrap: 'wrap' }}>
      {Object.entries(PURPOSE_PALETTE).map(([key, pal]) => {
        const [fg, bg] = isDark ? pal.dark : pal.light;
        const on = value === key;
        return (
          <button key={key} onClick={() => onPick(key)} aria-label={pal.label} title={pal.label}
            style={{ width: 24, height: 24, borderRadius: '50%', background: bg, cursor: 'pointer',
              border: `2px solid ${on ? fg : 'transparent'}`, boxSizing: 'border-box',
              display: 'flex', alignItems: 'center', justifyContent: 'center', color: fg, fontSize: 12, fontWeight: 700, padding: 0 }}>
            {on ? '✓' : ''}
          </button>
        );
      })}
    </span>
  );

  const add = async () => {
    const name = newName.trim();
    if (!name) { setError('用途の名前を入れてください'); return; }
    if (rows.some(r => r.name === name)) {
      setError(`「${name}」はもう登録されています（隠している場合は「戻す」を押してください）`);
      return;
    }
    setBusy('__new__'); setError('');
    const { data: me } = await supabase.auth.getUser();
    const orders = rows.map(r => r.sort_order);
    const { error: err } = await supabase.from('room_purposes').insert({
      name, color_key: newColor, sort_order: (orders.length ? Math.max(...orders) : 0) + 1,
      updated_by: me.user?.id ?? null,
    });
    setBusy('');
    if (err) { setError('追加できませんでした。通信を確認してもう一度お試しください。'); return; }
    setNewName('');
    await load();
    await onChanged(`用途「${name}」を足しました`);
  };

  const move = async (r: RoomPurpose, dir: -1 | 1) => {
    const i = rows.findIndex(x => x.id === r.id);
    const other = rows[i + dir];
    if (!other) return;
    setBusy(r.id); setError('');
    const now = new Date().toISOString();
    // 🚨 同じ数字だと並びが決まらないので、必ず両方を書き換える
    const r1 = await supabase.from('room_purposes')
      .update({ sort_order: other.sort_order, updated_at: now }).eq('id', r.id).select('id');
    const r2 = await supabase.from('room_purposes')
      .update({ sort_order: r.sort_order, updated_at: now }).eq('id', other.id).select('id');
    setBusy('');
    if (r1.error || r2.error || !r1.data?.length || !r2.data?.length) {
      setError('並び替えできませんでした。通信を確認してもう一度お試しください。'); return;
    }
    await load();
    await onChanged('用途の並びを変えました');
  };

  const toggle = async (r: RoomPurpose) => {
    setBusy(r.id); setError('');
    // 🚨 update は0件でもエラーにならないので、書けた件数を select で数える
    const { data, error: err } = await supabase.from('room_purposes')
      .update({ active: !r.active, updated_at: new Date().toISOString() })
      .eq('id', r.id).select('id');
    setBusy('');
    if (err || !data?.length) { setError('変えられませんでした。権限か通信を確認してください。'); return; }
    await load();
    await onChanged(r.active ? `用途「${r.name}」を出さないようにしました` : `用途「${r.name}」を出すようにしました`);
  };

  const setColor = async (r: RoomPurpose, key: string) => {
    setBusy(r.id); setError('');
    const { data, error: err } = await supabase.from('room_purposes')
      .update({ color_key: key, updated_at: new Date().toISOString() })
      .eq('id', r.id).select('id');
    setBusy('');
    if (err || !data?.length) { setError('色を変えられませんでした。権限か通信を確認してください。'); return; }
    await load();
    await onChanged(`「${r.name}」の色を変えました`);
  };

  const startRename = (r: RoomPurpose) => {
    setRenaming(r.id); setRenameText(r.name); setRenameCounts(null); setError('');
  };

  /** 名前を変える前に、影響する件数を数えて見せる（いきなり書き換えない） */
  const checkRename = async (r: RoomPurpose) => {
    const name = renameText.trim();
    if (!name) { setError('新しい名前を入れてください'); return; }
    if (name === r.name) { setRenaming(null); return; }
    if (rows.some(x => x.name === name)) { setError(`「${name}」はもう登録されています`); return; }
    setBusy(r.id); setError('');
    const [rb, rr, ro] = await Promise.all([
      supabase.from('room_bookings').select('id', { count: 'exact', head: true }).eq('purpose', r.name),
      supabase.from('room_recurrences').select('id', { count: 'exact', head: true }).eq('purpose', r.name),
      supabase.from('room_attendance_options').select('id, purposes, payment_purposes'),
    ]);
    setBusy('');
    if (rb.error || rr.error || ro.error) { setError('件数を数えられませんでした。通信を確認してもう一度お試しください。'); return; }
    const optCount = ((ro.data ?? []) as AttendanceOption[])
      .filter(o => o.purposes?.includes(r.name) || o.payment_purposes?.includes(r.name)).length;
    setRenameCounts({ bookings: rb.count ?? 0, recurrences: rr.count ?? 0, options: optCount });
  };

  /**
   * 名前の変更の本体。表記の変更（意味は同じ）が前提。
   * 🚨 予約 → 繰り返し → 長さ設定 → 詳細 → 出欠の対象 → 用途そのもの の順に書く。
   *    途中で失敗しても、もう一度「変える」を押せば続きから直せる
   *    （旧名で残った行だけが対象になるため）。
   */
  const doRename = async (r: RoomPurpose) => {
    const name = renameText.trim();
    setBusy(r.id); setError('');
    const { data: me } = await supabase.auth.getUser();
    const now = new Date().toISOString();
    const fail = (msg: string) => { setBusy(''); setError(`${msg}。もう一度「変える」を押すと続きから直せます。`); };

    const r1 = await supabase.from('room_bookings').update({ purpose: name, updated_at: now }).eq('purpose', r.name);
    if (r1.error) { fail('予約の書き換えに失敗しました'); return; }
    const r2 = await supabase.from('room_recurrences').update({ purpose: name }).eq('purpose', r.name);
    if (r2.error) { fail('繰り返しの書き換えに失敗しました'); return; }
    const r3 = await supabase.from('room_purpose_durations').update({ purpose: name, updated_at: now }).eq('purpose', r.name);
    if (r3.error) { fail('長さの設定の書き換えに失敗しました'); return; }
    const r4 = await supabase.from('room_purpose_details').update({ purpose: name, updated_at: now }).eq('purpose', r.name);
    if (r4.error) { fail('詳細の書き換えに失敗しました'); return; }
    // 出欠の選択肢の「用途」「支払い」の一覧に旧名が入っていれば差し替える（行数は少ない）
    const { data: opts, error: oErr } = await supabase.from('room_attendance_options').select('id, purposes, payment_purposes');
    if (oErr) { fail('出欠の設定を読めませんでした'); return; }
    for (const o of (opts ?? []) as AttendanceOption[]) {
      if (!o.purposes?.includes(r.name) && !o.payment_purposes?.includes(r.name)) continue;
      const swap = (a: string[] | null) => a ? a.map(x => (x === r.name ? name : x)) : a;
      const { error: uErr } = await supabase.from('room_attendance_options')
        .update({ purposes: swap(o.purposes), payment_purposes: swap(o.payment_purposes) })
        .eq('id', o.id);
      if (uErr) { fail('出欠の設定の書き換えに失敗しました'); return; }
    }
    // 🚨 用途そのものは最後に。update は0件でもエラーにならないので件数を見る
    const r6 = await supabase.from('room_purposes')
      .update({ name, updated_at: now, updated_by: me.user?.id ?? null })
      .eq('id', r.id).select('id');
    setBusy('');
    if (r6.error || !r6.data?.length) { setError('用途の名前を変えられませんでした。権限か通信を確認して、もう一度お試しください。'); return; }
    setRenaming(null);
    await load();
    await onChanged(`用途「${r.name}」を「${name}」に変えました`);
  };

  return (
    <div>
      <div style={{ background: isDark ? '#35354e' : '#f0f2f5', borderRadius: 8, padding: '10px 12px', fontSize: 13, lineHeight: 1.7, marginBottom: 14, color: textMid }}>
        予約の用途（プライベート・パーソナルなど）を足したり、名前や色を変えたりします。
        <br />
        「名前を変える」は書き方を直すためのものです（過去の予約の表示もまとめて変わります）。
        中身が別のものに変わるときは、新しく追加して古いほうを隠してください。
        用途は削除できません（過去の予約に名前が残るため、隠すだけにしています）。
      </div>

      {error && (
        <div style={{ background: isDark ? '#4a2a2a' : '#fdecea', border: `1px solid ${isDark ? '#7a4444' : '#f5c6cb'}`, color: isDark ? '#ffb4b4' : '#a3282a', borderRadius: 8, padding: '9px 12px', fontSize: 13, marginBottom: 12 }}>
          {error}
        </div>
      )}

      {loading ? (
        <p style={{ fontSize: 13.5, color: textMid }}>読み込んでいます...</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 14 }}>
          {rows.map((r, i) => {
            const [fg, bg] = purposeColor(r.name, isDark);
            return (
              <div key={r.id} style={{ border: `1px solid ${line}`, borderRadius: 8, padding: '9px 11px', display: 'flex', flexDirection: 'column', gap: 7 }}>
                <div style={{ display: 'flex', gap: 7, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 13.5, fontWeight: 700, color: fg, background: bg, borderRadius: 6, padding: '3px 10px' }}>{r.name}</span>
                  {!r.active && <span style={{ fontSize: 12, color: textMid }}>（隠しています）</span>}
                  <span style={{ marginLeft: 'auto', display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                    <button onClick={() => move(r, -1)} disabled={i === 0 || !!busy}
                      style={{ ...smallBtn, opacity: i === 0 ? .4 : 1 }}>↑</button>
                    <button onClick={() => move(r, 1)} disabled={i === rows.length - 1 || !!busy}
                      style={{ ...smallBtn, opacity: i === rows.length - 1 ? .4 : 1 }}>↓</button>
                    <button onClick={() => (renaming === r.id ? setRenaming(null) : startRename(r))}
                      disabled={!!busy} style={smallBtn}>名前を変える</button>
                    <button onClick={() => toggle(r)} disabled={!!busy} style={smallBtn}>
                      {r.active ? '隠す' : '戻す'}
                    </button>
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 7, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 12, color: textMid }}>色</span>
                  {colorPicker(r.color_key, key => setColor(r, key))}
                </div>
                {renaming === r.id && (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', padding: '7px 9px', border: `1px solid ${line}`, borderRadius: 8 }}>
                    <input value={renameText}
                      onChange={e => { setRenameText(e.target.value); setRenameCounts(null); }}
                      placeholder="新しい名前" style={{ ...input, width: 150 }} />
                    {renameCounts === null ? (
                      <button onClick={() => checkRename(r)} disabled={busy === r.id}
                        style={{ padding: '7px 14px', borderRadius: 8, border: `1px solid ${accent}`, background: 'transparent', color: accent, fontSize: 13, fontWeight: 700, cursor: busy === r.id ? 'wait' : 'pointer' }}>
                        {busy === r.id ? '数えています...' : '次へ'}
                      </button>
                    ) : (
                      <>
                        <span style={{ fontSize: 12.5, color: textMid, lineHeight: 1.6 }}>
                          過去の予約 <b>{renameCounts.bookings}件</b>・繰り返し <b>{renameCounts.recurrences}件</b>・
                          出欠の設定 <b>{renameCounts.options}件</b> も「{renameText.trim()}」に変わります。よろしいですか？
                        </span>
                        <button onClick={() => doRename(r)} disabled={busy === r.id}
                          style={{ padding: '7px 14px', borderRadius: 8, border: 'none', background: accent, color: isDark ? '#1d2a24' : '#fff', fontSize: 13, fontWeight: 700, cursor: busy === r.id ? 'wait' : 'pointer' }}>
                          {busy === r.id ? '変えています...' : '変える'}
                        </button>
                      </>
                    )}
                    <button onClick={() => setRenaming(null)}
                      style={{ padding: '7px 12px', borderRadius: 8, border: `1px solid ${line}`, background: 'transparent', color: textMid, fontSize: 13, cursor: 'pointer' }}>
                      やめる
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div style={{ borderTop: `1px solid ${line}`, paddingTop: 11 }}>
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 7 }}>新しく足す</div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input value={newName} onChange={e => setNewName(e.target.value)}
            placeholder="例：体験" style={{ ...input, flex: 1, minWidth: 140 }} />
          {colorPicker(newColor, setNewColor)}
          <button onClick={add} disabled={busy === '__new__'}
            style={{ padding: '7px 14px', borderRadius: 8, border: `1px solid ${accent}`, background: 'transparent', color: accent, fontSize: 13.5, fontWeight: 700, cursor: busy === '__new__' ? 'wait' : 'pointer' }}>
            {busy === '__new__' ? '追加中...' : '追加'}
          </button>
        </div>
        <p style={{ fontSize: 12, color: textMid, margin: '7px 0 0', lineHeight: 1.6 }}>
          足したあとは「基本設定 → 用途詳細」で長さの選択肢も決めてください（決めるまでは自由入力になります）。
        </p>
      </div>
    </div>
  );
};

// ============================================================
// キャンセル待ちの発動条件（管理者のみ・2026-09-02 ユーザー承認・案①）
//
// どの出欠を付けたら「空き扱い」（＝休講にしなくても繰り上げられる）に
// するかを決める。値は room_settings の 'waitlist_open_statuses'。
// 🚨 サーバー（room_promote_waitlist_at）と画面の両方がこの設定を読む。
//    条件をコードに直書きしないこと。
// ============================================================
const WaitlistTriggerSettings: React.FC<{
  attendanceOptions: AttendanceOption[];
  isDark: boolean; onChanged: (msg: string) => Promise<void>;
}> = ({ attendanceOptions, isDark, onChanged }) => {
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const line = isDark ? '#3a3a5c' : '#e0e0e0';
  const textMid = isDark ? '#b3b8c6' : '#5b6270';
  const accent = isDark ? '#6bbd92' : '#2f6f4f';

  useEffect(() => {
    (async () => {
      const { data } = await supabase.from('room_settings')
        .select('value').eq('key', 'waitlist_open_statuses').maybeSingle();
      setSelected(data?.value != null
        ? data.value.split(',').map((s: string) => s.trim()).filter(Boolean)
        : ['休み', 'キャンセル料']);
      setLoading(false);
    })();
  }, []);

  const toggle = async (name: string) => {
    const next = selected.includes(name) ? selected.filter(x => x !== name) : [...selected, name];
    setBusy(true); setError('');
    const { data: me } = await supabase.auth.getUser();
    const { error: err } = await supabase.from('room_settings').upsert({
      key: 'waitlist_open_statuses', value: next.join(','),
      updated_at: new Date().toISOString(), updated_by: me.user?.id ?? null,
    }, { onConflict: 'key' });
    setBusy(false);
    if (err) { setError('保存できませんでした。通信を確認してもう一度お試しください。'); return; }
    setSelected(next);
    await onChanged(next.length
      ? `空き扱いにする出欠を ${next.join('・')} にしました`
      : '空き扱いの連動を止めました（休講・取り消しだけで繰り上げます）');
  };

  return (
    <div>
      <div style={{ background: isDark ? '#35354e' : '#f0f2f5', borderRadius: 8, padding: '10px 12px', fontSize: 13, lineHeight: 1.7, marginBottom: 14, color: textMid }}>
        ここで選んだ出欠が付いた回は<b>空き扱い</b>になり、予約を消したり休講にしたりしなくても、
        キャンセル待ちの方をそのまま繰り上げられます（繰り上げた瞬間に、その回は自動で
        <b>お休み</b>（お客様都合のグレー表示）になります。予約と出欠の記録はそのまま残ります）。
        <br />
        🚨 2名の予約は、<b>全員</b>にここで選んだ出欠が付いたときだけ空き扱いになります。
        すべて外すと連動は止まり、休講・取り消しだけで繰り上げる今までの動きになります。
      </div>

      {error && (
        <div style={{ background: isDark ? '#4a2a2a' : '#fdecea', border: `1px solid ${isDark ? '#7a4444' : '#f5c6cb'}`, color: isDark ? '#ffb4b4' : '#a3282a', borderRadius: 8, padding: '9px 12px', fontSize: 13, marginBottom: 12 }}>
          {error}
        </div>
      )}

      {loading ? (
        <p style={{ fontSize: 13.5, color: textMid }}>読み込んでいます...</p>
      ) : (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          {attendanceOptions.filter(o => o.active).map(o => {
            const on = selected.includes(o.name);
            return (
              <button key={o.id} onClick={() => toggle(o.name)} disabled={busy}
                style={{ padding: '6px 14px', borderRadius: 999, fontSize: 13, cursor: busy ? 'wait' : 'pointer',
                  border: `1px solid ${on ? accent : line}`,
                  background: on ? accent : 'transparent',
                  color: on ? (isDark ? '#1d2a24' : '#fff') : textMid,
                  fontWeight: on ? 700 : 400 }}>
                {o.name}
              </button>
            );
          })}
          {attendanceOptions.filter(o => o.active).length === 0 && (
            <span style={{ fontSize: 12.5, color: textMid }}>
              出欠の選択肢がありません（基本設定 → 出欠の選択肢 で足せます）。
            </span>
          )}
        </div>
      )}
    </div>
  );
};

const SettingsPanel: React.FC<{
  campuses: Campus[]; floors: Floor[]; categories: LessonCategory[];
  attendanceOptions: AttendanceOption[];
  onClose: () => void; onChanged: (msg: string) => Promise<void>; isDark: boolean;
}> = ({ campuses, floors, categories, attendanceOptions, onClose, onChanged, isDark }) => {
  // スタッフは基本設定（社員）へ移した。ここに残すのは管理者だけが触るもの
  const [tab, setTab] = useState<'category' | 'place' | 'purposes' | 'waitlist' | 'privacy' | 'basicroles' | 'history'>('category');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [newCatCode, setNewCatCode] = useState('');
  const [newCatDesc, setNewCatDesc] = useState('');

  const line = isDark ? '#3a3a5c' : '#e0e0e0';
  const lineSoft = isDark ? '#35354e' : '#eef0f3';
  const text = isDark ? '#eeeeee' : '#222222';
  const textMid = isDark ? '#b3b8c6' : '#5b6270';
  const accent = isDark ? '#6bbd92' : '#2f6f4f';
  const fieldBg = isDark ? '#495057' : '#fff';

  const input: React.CSSProperties = {
    padding: '7px 9px', borderRadius: 8, border: `1px solid ${line}`,
    background: fieldBg, color: text, fontSize: 16, boxSizing: 'border-box',
  };
  const smallBtn = (on: boolean): React.CSSProperties => ({
    padding: '4px 10px', borderRadius: 999, fontSize: 12.5, cursor: busy ? 'wait' : 'pointer',
    border: `1px solid ${on ? accent : line}`,
    background: on ? accent : 'transparent',
    color: on ? (isDark ? '#1d2a24' : '#fff') : textMid,
    fontWeight: on ? 700 : 400,
  });

  /** 失敗しても画面を壊さず、理由だけ出す小さなラッパ */
  const run = async (fn: () => Promise<{ error: unknown } | void>, msg: string) => {
    setBusy(true); setError('');
    try {
      const r = await fn();
      if (r && 'error' in r && r.error) {
        setError('保存できませんでした。同じ名前がすでに登録されていないか確認してください。');
        setBusy(false); return;
      }
      await onChanged(msg);
    } catch {
      setError('保存できませんでした。通信を確認してもう一度お試しください。');
    }
    setBusy(false);
  };


  return (
    <Overlay onClose={onClose} isDark={isDark} title="管理者の設定" wide>
      <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
        {([['category', 'レッスン区分'], ['place', '場所'], ['purposes', '用途'], ['waitlist', 'キャンセル待ち'], ['basicroles', '基本設定の権限'], ['privacy', '連絡先の公開範囲'], ['history', '作業履歴']] as const).map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)} style={smallBtn(tab === k)}>{l}</button>
        ))}
      </div>

      {error && (
        <div style={{ background: isDark ? '#4a2a2a' : '#fdecea', border: `1px solid ${isDark ? '#7a4444' : '#f5c6cb'}`, color: isDark ? '#ffb4b4' : '#a3282a', borderRadius: 8, padding: '9px 12px', fontSize: 13, marginBottom: 12 }}>
          {error}
        </div>
      )}

      {/* ---- レッスン区分 ---- */}
      {tab === 'category' && (
        <div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
            <input value={newCatCode} onChange={e => setNewCatCode(e.target.value)}
              placeholder="記号（F）" style={{ ...input, width: 90 }} />
            <input value={newCatDesc} onChange={e => setNewCatDesc(e.target.value)}
              placeholder="内容（例：柔軟・体幹トレーニング）" style={{ ...input, flex: 1, minWidth: 180 }} />
            <button disabled={busy || !newCatCode.trim()}
              onClick={() => run(async () => {
                const r = await supabase.from('room_lesson_categories').insert({
                  code: newCatCode.trim(), description: newCatDesc.trim(),
                  sort_order: categories.length + 1,
                });
                if (!r.error) { setNewCatCode(''); setNewCatDesc(''); }
                return r;
              }, '区分を追加しました')}
              style={{ padding: '7px 16px', borderRadius: 8, border: 'none', background: accent, color: isDark ? '#1d2a24' : '#fff', fontSize: 13.5, fontWeight: 700, cursor: busy ? 'wait' : 'pointer', opacity: (busy || !newCatCode.trim()) ? .5 : 1 }}>
              追加
            </button>
          </div>
          <p style={{ fontSize: 12, color: textMid, margin: '0 0 10px', lineHeight: 1.6 }}>
            内容の文章は、欄をクリックして直したあと、外をクリックすると保存されます。
          </p>

          {categories.map(c => (
            <div key={c.id} style={{ borderTop: `1px solid ${lineSoft}`, padding: '10px 0' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                <b style={{ fontSize: 15, minWidth: 26 }}>{c.code}</b>
                <textarea defaultValue={c.description} rows={2}
                  onBlur={e => {
                    if (e.target.value === c.description) return;
                    run(async () => await supabase.from('room_lesson_categories')
                      .update({ description: e.target.value }).eq('id', c.id), `${c.code} の内容を直しました`);
                  }}
                  style={{ ...input, flex: 1, resize: 'vertical', fontFamily: 'inherit', fontSize: 13 }} />
                <button disabled={busy}
                  onClick={() => run(async () => await supabase.from('room_lesson_categories')
                    .update({ active: !c.active }).eq('id', c.id),
                    c.active ? `${c.code} を非表示にしました` : `${c.code} を表示に戻しました`)}
                  style={smallBtn(false)}>{c.active ? '非表示' : '表示'}</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ---- 場所 ---- */}
      {tab === 'place' && (
        <div>
          <p style={{ fontSize: 12, color: textMid, margin: '0 0 10px', lineHeight: 1.6 }}>
            「同時◯件」は、その場所に同じ時間で入れられる予約の数です。数字を直すとすぐ反映されます。
            営業時間は、タイムラインで薄いグレーにする範囲の基準です（この時間外でも予約は入れられます）。
          </p>
          {campuses.map(c => (
            <div key={c.id} style={{ borderTop: `1px solid ${lineSoft}`, padding: '10px 0' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 7, flexWrap: 'wrap' }}>
                <b style={{ fontSize: 14 }}>{c.name}</b>
                <span style={{ fontSize: 12, color: textMid }}>営業</span>
                <input type="time" defaultValue={c.open_time.slice(0, 5)}
                  onBlur={e => e.target.value !== c.open_time.slice(0, 5) && run(async () =>
                    await supabase.from('room_campuses').update({ open_time: e.target.value }).eq('id', c.id),
                    `${c.name} の営業開始を変えました`)}
                  style={{ ...input, width: 110 }} />
                <span style={{ fontSize: 12, color: textMid }}>〜</span>
                <input type="time" defaultValue={c.close_time.slice(0, 5)}
                  onBlur={e => e.target.value !== c.close_time.slice(0, 5) && run(async () =>
                    await supabase.from('room_campuses').update({ close_time: e.target.value }).eq('id', c.id),
                    `${c.name} の営業終了を変えました`)}
                  style={{ ...input, width: 110 }} />
              </div>
              {floors.filter(f => f.campus_id === c.id).map(f => (
                <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0 5px 14px', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 13.5, minWidth: 78 }}>{f.name}</span>
                  <span style={{ fontSize: 12, color: textMid }}>同時</span>
                  <input type="number" min={1} max={20} defaultValue={f.capacity}
                    onBlur={e => {
                      const n = Number(e.target.value);
                      if (!Number.isInteger(n) || n < 1 || n === f.capacity) { e.target.value = String(f.capacity); return; }
                      run(async () => await supabase.from('room_floors').update({ capacity: n }).eq('id', f.id),
                        `${f.name} を同時${n}件にしました`);
                    }}
                    style={{ ...input, width: 74 }} />
                  <span style={{ fontSize: 12, color: textMid }}>件まで</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {/* ---- 基本設定を使える役職 ---- */}
      {tab === 'history' && (
        <WorkHistory floors={floors} campuses={campuses} isDark={isDark} />
      )}

      {tab === 'basicroles' && (
        <BasicSettingsRoles isDark={isDark} onChanged={onChanged} />
      )}

      {/* ---- 連絡先の公開範囲 ---- */}
      {tab === 'purposes' && (
        <PurposeMasterSettings isDark={isDark} onChanged={onChanged} />
      )}
      {tab === 'waitlist' && (
        <WaitlistTriggerSettings attendanceOptions={attendanceOptions} isDark={isDark} onChanged={onChanged} />
      )}
      {tab === 'privacy' && (
        <ContactVisibility isDark={isDark} onChanged={onChanged} />
      )}

      <button onClick={onClose}
        style={{ width: '100%', marginTop: 18, padding: '11px', borderRadius: 8, border: `1px solid ${line}`, background: 'transparent', color: textMid, fontSize: 14, cursor: 'pointer' }}>
        閉じる
      </button>
    </Overlay>
  );
};

// ============================================================
// 「基本設定」を使える役職（管理者だけ）
//
//   正社員の中にも役職があるので、「パートでなければ全員」では粗すぎる
//   （2026-08-31 ユーザー指示）。管理者が役職ごとに決められるようにする。
//
//   🚨 「リーダー以上」のような序列にしない。フロア責任者をどちら側に含めるかで
//      過去に判断が割れているため（CLAUDE.md「役職序列」）。役職ごとのON/OFFにする。
//   🚨 管理者は設定に関わらず常に使える。自分を締め出せてしまうと、
//      設定を戻す手段が無くなる。
// ============================================================
const BASIC_SETTINGS_ROLES_KEY = 'basic_settings_roles';

const BasicSettingsRoles: React.FC<{
  isDark: boolean; onChanged: (msg: string) => Promise<void>;
}> = ({ isDark, onChanged }) => {
  const [roles, setRoles] = useState<{ id: string; name: string }[]>([]);
  const [allowed, setAllowed] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const line = isDark ? '#3a3a5c' : '#e0e0e0';
  const textMid = isDark ? '#b3b8c6' : '#5b6270';
  const accent = isDark ? '#6bbd92' : '#2f6f4f';

  useEffect(() => {
    (async () => {
      const [rRes, sRes] = await Promise.all([
        supabase.from('roles').select('id, name').order('sort_order'),
        supabase.from('room_settings').select('value').eq('key', BASIC_SETTINGS_ROLES_KEY).maybeSingle(),
      ]);
      if (rRes.error) {
        setError('役職の一覧を読み込めませんでした。開き直してください。');
        setLoading(false); return;
      }
      setRoles((rRes.data ?? []) as { id: string; name: string }[]);
      setAllowed((sRes.data?.value ?? '').split(',').map((s: string) => s.trim()).filter(Boolean));
      setLoading(false);
    })();
  }, []);

  const toggle = async (name: string) => {
    const next = allowed.includes(name)
      ? allowed.filter(n => n !== name)
      : [...allowed, name];
    setBusy(true); setError('');
    const { data: me } = await supabase.auth.getUser();
    const { error: err } = await supabase.from('room_settings').upsert({
      key: BASIC_SETTINGS_ROLES_KEY, value: next.join(','),
      updated_at: new Date().toISOString(), updated_by: me.user?.id ?? null,
    }, { onConflict: 'key' });
    setBusy(false);
    if (err) { setError('変えられませんでした。通信を確認してもう一度お試しください。'); return; }
    setAllowed(next);
    await onChanged('基本設定を使える役職を変えました');
  };

  return (
    <div>
      <p style={{ fontSize: 13, color: textMid, margin: '0 0 12px', lineHeight: 1.7 }}>
        <b>基本設定</b>（年度更新・キャンセル待ち・お客様・予約の一括入力・スタッフ・用途詳細）を
        使える役職を決めます。
        <br />
        🚨 <b>パートは、この設定に関わらず使えません。</b>
        <br />
        🚨 <b>管理者は、この設定に関わらず常に使えます。</b>
        全部外しても設定に戻れなくなることはありません。
      </p>
      {error && (
        <div style={{ background: isDark ? '#4a2a2a' : '#fdecea', border: `1px solid ${isDark ? '#7a4444' : '#f5c6cb'}`, color: isDark ? '#ffb4b4' : '#a3282a', borderRadius: 8, padding: '9px 12px', fontSize: 13, marginBottom: 12 }}>
          {error}
        </div>
      )}
      {loading ? (
        <p style={{ fontSize: 13.5, color: textMid }}>読み込んでいます...</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          {roles.map(r => {
            const fixed = r.name === 'パート' || r.name === '管理者';
            const on = r.name === '管理者' ? true : (r.name === 'パート' ? false : allowed.includes(r.name));
            return (
              <label key={r.id}
                style={{ display: 'flex', gap: 9, alignItems: 'center', padding: '9px 12px', borderRadius: 8, border: `1px solid ${on && !fixed ? accent : line}`, cursor: fixed ? 'default' : 'pointer', opacity: fixed ? .65 : 1 }}>
                <input type="checkbox" checked={on} disabled={fixed || busy}
                  onChange={() => !fixed && toggle(r.name)}
                  style={{ width: 17, height: 17 }} />
                <span style={{ fontSize: 13.5, fontWeight: on ? 700 : 400 }}>{r.name}</span>
                {fixed && (
                  <span style={{ fontSize: 12, color: textMid, marginLeft: 'auto' }}>
                    {r.name === 'パート' ? '常に使えません' : '常に使えます'}
                  </span>
                )}
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
};

// ============================================================
// 連絡先の公開範囲（管理者だけ）
//
//   お客様の連絡先を誰まで見せるかを決める。あとから変える前提の設定なので、
//   コードではなくDB（room_settings）に置き、RLS がその値を読む
//   （2026-08-29 ユーザー指示）。ここを変えるとポリシーを書き換えずに範囲が変わる。
// ============================================================
const CONTACT_SCOPES = [
  ['admin', '管理者のみ', 'いちばん狭い。現場で電話をかけたいときは管理者に聞くことになります'],
  ['staff', '社員まで（既定）', 'パートには見えません。名前と学年は全員が見られます'],
  ['all',   'ログインしている全員', 'パートを含む全スタッフが連絡先まで見られます'],
] as const;

const ContactVisibility: React.FC<{
  isDark: boolean; onChanged: (msg: string) => Promise<void>;
}> = ({ isDark, onChanged }) => {
  const [scope, setScope] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const line = isDark ? '#3a3a5c' : '#e0e0e0';
  const textMid = isDark ? '#b3b8c6' : '#5b6270';
  const accent = isDark ? '#6bbd92' : '#2f6f4f';

  useEffect(() => {
    (async () => {
      const { data } = await supabase.from('room_settings')
        .select('value').eq('key', 'contact_visibility').maybeSingle();
      setScope(data?.value ?? 'staff');
    })();
  }, []);

  const save = async (v: string) => {
    setBusy(true); setError('');
    const { data: me } = await supabase.auth.getUser();
    const { error: err } = await supabase.from('room_settings').upsert({
      key: 'contact_visibility', value: v,
      updated_at: new Date().toISOString(), updated_by: me.user?.id ?? null,
    }, { onConflict: 'key' });
    setBusy(false);
    if (err) { setError('変えられませんでした。通信を確認してもう一度お試しください。'); return; }
    setScope(v);
    await onChanged('連絡先の公開範囲を変えました');
  };

  return (
    <div>
      <p style={{ fontSize: 13, color: textMid, margin: '0 0 12px', lineHeight: 1.7 }}>
        お客様の<b>連絡先</b>（電話・メール・保護者名）を、誰まで見せるかを決めます。
        お名前と学年は、この設定にかかわらず予約表で全員が見られます。
      </p>
      {error && (
        <div style={{ background: isDark ? '#4a2a2a' : '#fdecea', border: `1px solid ${isDark ? '#7a4444' : '#f5c6cb'}`, color: isDark ? '#ffb4b4' : '#a3282a', borderRadius: 8, padding: '9px 12px', fontSize: 13, marginBottom: 12 }}>
          {error}
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {CONTACT_SCOPES.map(([v, title, note]) => (
          <button key={v} disabled={busy} onClick={() => save(v)}
            style={{ textAlign: 'left', padding: '11px 13px', borderRadius: 8, cursor: busy ? 'wait' : 'pointer', border: `1px solid ${scope === v ? accent : line}`, background: scope === v ? (isDark ? '#263b33' : '#e8f2ec') : 'transparent', color: scope === v ? accent : textMid }}>
            <b style={{ fontSize: 13.5 }}>{scope === v ? '● ' : '○ '}{title}</b>
            <span style={{ display: 'block', fontSize: 12, marginTop: 3, lineHeight: 1.6 }}>{note}</span>
          </button>
        ))}
      </div>
    </div>
  );
};

// ---- 小さな共通部品 ----

const ConfirmBox: React.FC<{
  isDark: boolean; busy: boolean; title: string; note: string; okLabel: string;
  danger?: boolean; onOk: () => void; onCancel: () => void;
}> = ({ isDark, busy, title, note, okLabel, danger, onOk, onCancel }) => {
  const line = isDark ? '#3a3a5c' : '#e0e0e0';
  const textMid = isDark ? '#b3b8c6' : '#5b6270';
  const dangerColor = isDark ? '#ff8a8a' : '#c0392b';
  return (
    <div style={{ background: isDark ? '#3d3226' : '#fdf0e6', border: `1px solid ${isDark ? '#7a5c37' : '#e8b98a'}`, borderRadius: 8, padding: '12px 14px', marginTop: 14 }}>
      <b style={{ fontSize: 14 }}>{title}</b>
      <p style={{ fontSize: 12.5, color: textMid, margin: '5px 0 10px', lineHeight: 1.6 }}>{note}</p>
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={onCancel} disabled={busy}
          style={{ flex: 1, padding: '9px', borderRadius: 8, border: `1px solid ${line}`, background: 'transparent', color: textMid, fontSize: 13.5, cursor: 'pointer' }}>
          やめる
        </button>
        <button onClick={onOk} disabled={busy}
          style={{ flex: 1, padding: '9px', borderRadius: 8, border: 'none', background: danger ? dangerColor : (isDark ? '#6bbd92' : '#2f6f4f'), color: isDark && !danger ? '#1d2a24' : '#fff', fontSize: 13.5, fontWeight: 700, cursor: busy ? 'wait' : 'pointer', opacity: busy ? .7 : 1 }}>
          {busy ? '処理中…' : okLabel}
        </button>
      </div>
    </div>
  );
};

const Overlay: React.FC<{ onClose: () => void; isDark: boolean; title: string; wide?: boolean; children: React.ReactNode }> =
({ onClose, isDark, title, wide, children }) => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const card = isDark ? '#2d2d3e' : '#ffffff';
  const line = isDark ? '#3a3a5c' : '#e0e0e0';
  const text = isDark ? '#eeeeee' : '#222222';
  return (
    <div onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 1000, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '5vh 12px 12px', overflowY: 'auto' }}>
      <div onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={title}
        style={{ background: card, color: text, border: `1px solid ${line}`, borderRadius: 14, width: '100%', maxWidth: wide ? 680 : 480, padding: 20, boxShadow: '0 10px 40px rgba(0,0,0,.3)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>{title}</h2>
          <button onClick={onClose} aria-label="閉じる"
            style={{ background: 'transparent', border: 'none', color: isDark ? '#b3b8c6' : '#5b6270', fontSize: 22, cursor: 'pointer', lineHeight: 1, padding: '0 4px' }}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
};

/**
 * 開始日から終了日まで、同じ曜日の日付を並べる（最長1年）。
 * 隔週・第◯曜は作らない方針（音楽教室は毎週同曜日がほとんどで、
 * 選択肢を増やすと登録時に迷いやすくなるため）。
 */
function weeklyDates(from: string, until: string): string[] {
  if (!until || until <= from) return [];
  const out: string[] = [];
  let cur = from;
  // 最大64回。年度末が近い時期に「来年度末まで」を選ぶと最長で約61週になるため、
  // 60のままだと最後の1〜2回が黙って落ちる
  for (let i = 0; i < 64; i++) {
    if (cur > until) break;
    out.push(cur);
    cur = shiftDate(cur, 7);
  }
  return out;
}

export default RoomBookingPage;

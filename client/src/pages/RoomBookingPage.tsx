import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import type { AuthUser } from '../types';
import { supabase } from '../lib/supabaseClient';
import { useDarkMode } from '../hooks/useDarkMode';
import TimeInput from '../components/TimeInput';
import {
  PURPOSES, purposeColor, VIEW_START_HOUR, VIEW_END_HOUR, DURATION_PRESETS,
  todayStr, toDate, hhmm, minutesOf, addMinutes, formatDateLabel, shiftDate,
  scholaUrl, floorBusyNow, nextStart, usingUntil, assignColumns, categoryLabel,
  isWeekend, RANGE_DAYS, localDate, placeLabel, openSlotColor, durationLabel, FALLBACK_DURATIONS, gradeOf,
  fiscalYear, fiscalYearEnd, fiscalYearLabel, RENEWAL_NOTICE_DAYS, daysUntil,
  type Campus, type Floor, type Booking, type ConflictInfo,
  type Staff, type LessonCategory, type Recurrence, type PurposeDuration,
  type Customer, type CustomerContact, type Waitlist,
} from '../lib/roomBooking';
import {
  readTable, guessMapping, buildCustomers, FIELD_LABEL, REQUIRED_FIELDS,
  type CustomerField,
} from '../lib/customerImport';
import {
  guessBookingMapping, splitPasted, buildBookings, BOOKING_FIELD_LABEL,
  BOOKING_REQUIRED, BULK_MAX_ROWS, type BookingField,
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

const RoomBookingPage: React.FC<Props> = ({ user, isAdmin: admin, employmentType }) => {
  const isDark = useDarkMode();
  const [campuses, setCampuses] = useState<Campus[]>([]);
  const [floors, setFloors] = useState<Floor[]>([]);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [categories, setCategories] = useState<LessonCategory[]>([]);
  // 用途ごとの長さの選択肢（社員が基本設定から変えられる）
  const [purposeDurations, setPurposeDurations] = useState<PurposeDuration[]>(FALLBACK_DURATIONS);
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
    const [cRes, fRes, sRes, catRes, scRes, durRes] = await Promise.all([
      supabase.from('room_campuses').select('*').eq('active', true).order('sort_order'),
      supabase.from('room_floors').select('*').eq('active', true).order('sort_order'),
      supabase.from('room_staff').select('*').order('sort_order'),
      supabase.from('room_lesson_categories').select('*').order('sort_order'),
      supabase.from('room_staff_categories').select('*'),
      supabase.from('room_purpose_durations').select('*'),
    ]);
    if (cRes.error || fRes.error) {
      setLoadError('場所の情報を読み込めませんでした。時間をおいて開き直してください。');
      return null;
    }
    // 長さの選択肢。読めなかったときだけ既定値で動かす（フォームが開けなくなるのを避ける）
    setPurposeDurations(durRes.data && durRes.data.length
      ? (durRes.data as PurposeDuration[])
      : FALLBACK_DURATIONS);
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

  // 基本設定を開けるのは社員まで（パートは不可）。
  // 🚨 employment_type を自分で読み直さないこと。役職プレビュー（👁️ 確認）で
  //    パートに切り替えても実際の値のままになり、プレビューが効かない。
  //    useAuth が返す「プレビュー込み」の値をそのまま使う。
  // 🚨 これは画面に出すかどうかだけの話。実際に書けるかどうかは
  //    データベース側（room_is_staff）でも見ているので、隠しただけにはならない。
  const canRenew = employmentType !== '' && employmentType !== 'パート';

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
    setBookings((data ?? []) as Booking[]);
  }, [date, visibleFloors, rangeDays]);

  useEffect(() => { loadBookings(); }, [loadBookings]);

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
          {canRenew && (
            <button onClick={() => setRenewal(true)}
              style={{ ...btn(false), marginLeft: 'auto' }}>基本設定</button>
          )}
          {admin && (
            <button onClick={() => setSettings(true)}
              style={{ ...btn(false), marginLeft: canRenew ? 0 : 'auto' }}>⚙️ 設定</button>
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
          mode={form} user={user} floors={floors} campuses={campuses}
          staff={staff} categories={categories} purposeDurations={purposeDurations}
          onClose={() => setForm(null)}
          onSaved={(msg) => { setForm(null); loadBookings(); showFlash(msg); }}
          isDark={isDark} />
      )}
      {detail && (
        <BookingDetail
          booking={detail} floors={floors} campuses={campuses}
          staff={staff} categories={categories}
          onClose={() => setDetail(null)}
          onEdit={(b) => { setDetail(null); setForm({ kind: 'edit', booking: b }); }}
          onChanged={(msg) => { setDetail(null); loadBookings(); showFlash(msg); }}
          isDark={isDark} />
      )}
      {renewal && (
        <BasicSettingsPanel
          campuses={campuses} floors={floors} staff={staff} categories={categories}
          purposeDurations={purposeDurations} user={user}
          onClose={() => setRenewal(false)}
          onDone={async (msg) => {
            await loadMasters(); await loadBookings(); await loadRenewPending(); showFlash(msg);
          }}
          isDark={isDark} />
      )}
      {settings && (
        <SettingsPanel
          campuses={campuses} floors={floors} categories={categories}
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
                        {open && '🟡'}{b.exclusive && !off && !open && '🔒'}{hhmm(b.starts_at)}-{hhmm(b.ends_at)}
                      </b>
                      {/* 担当別・参加者別では「どこの場所か」が分からないと使えないので場所を出す */}
                      <span style={{ fontSize: 10.5, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {off ? '休講'
                          : open ? `募集中${b.seats > 1 ? `（あと${restSeats}名）` : ''}`
                          : view === 'place' ? `${b.purpose}${b.customer_label ? ` / ${b.customer_label}` : ''}`
                          : `${placeName(b.floor_id, allCampus)} / ${b.purpose}`}
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
        {PURPOSES.map(p => {
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
                    {open && '🟡'}{b.exclusive && !off && !open && '🔒'}{hhmm(b.starts_at)}〜{hhmm(b.ends_at)}
                  </span>
                  <span style={{
                    background: bgc, color: fg, borderRadius: 999, padding: '1px 9px',
                    fontSize: 11, fontWeight: 700, flexShrink: 0,
                    border: open ? `1px dashed ${fg}` : 'none',
                  }}>
                    {off ? '休講' : open ? `募集中${b.seats > 1 ? ` あと${rest}名` : ''}` : b.purpose}
                  </span>
                  {/* 場所／（絞っていなければ）並べている軸の本人／もう一方の軸。
                      1人に絞っているときは、その人の名前を毎行くり返さない */}
                  <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: textMid, lineHeight: 1.55 }}>
                    {[
                      where,
                      ...(view === 'staff'
                        ? [only ? '' : (st ? st.name : '担当なし'), open ? b.purpose : participantLabel(b)]
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
                  {open && '🟡'}{b.exclusive && !off && !open && '🔒'}{hhmm(b.starts_at)}〜{hhmm(b.ends_at)}
                </span>
                <span style={{
                  background: bgc, color: fg, borderRadius: 999, padding: '1px 9px', fontSize: 11, fontWeight: 700,
                  border: open ? `1px dashed ${fg}` : 'none',
                }}>
                  {off ? '休講' : open ? `募集中${b.seats > 1 ? ` あと${rest}名` : ''}` : b.purpose}
                </span>
              </div>
              <div style={{ fontSize: 12.5, color: textMid, marginTop: 3 }}>
                {[
                  view !== 'place' ? whereOf(b) : '',
                  open ? b.purpose : '',
                  st ? `${st.name}（${categoryLabel(st, categories) || '区分なし'}）` : '',
                  open ? '' : (b.customer_label || (b.member_no ? `#${b.member_no}` : '')),
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
// 予約フォーム（新規・変更）
// ============================================================
const BookingForm: React.FC<{
  mode: FormMode; user: AuthUser; floors: Floor[]; campuses: Campus[];
  staff: Staff[]; categories: LessonCategory[]; purposeDurations: PurposeDuration[];
  onClose: () => void; onSaved: (msg: string) => void; isDark: boolean;
}> = ({ mode, user, floors, campuses, staff, categories, purposeDurations, onClose, onSaved, isDark }) => {
  const editing = mode.kind === 'edit';
  const base = editing ? mode.booking : null;

  const [floorId] = useState(editing ? base!.floor_id : mode.floorId);
  // 🚨 日付は localDate を通す（ISO文字列の頭10文字はUTCの日付で、朝の予約が前日になる）
  const [date] = useState(editing ? localDate(base!.starts_at) : mode.date);
  const [startTime, setStartTime] = useState(editing ? hhmm(base!.starts_at) : mode.startTime);
  // 🚨 終了の初期値も用途の長さに合わせる。ここを固定の30分にしていたため、
  //    レッスン（50分固定・終了は手で直せない）を開いた直後に 30分 と出て、
  //    ボタンを押すまで矛盾したままだった（2026-08-31 実機確認で発見）
  const initialPurpose = editing ? base!.purpose : 'レッスン';
  const initialLength =
    purposeDurations.find(d => d.purpose === initialPurpose)?.minutes[0] ?? 30;
  const [endTime, setEndTime] = useState(
    editing ? hhmm(base!.ends_at) : addMinutes(mode.startTime, initialLength));
  const [purpose, setPurpose] = useState<string>(initialPurpose);
  const [bookerName, setBookerName] = useState(editing ? base!.booker_name : (user.email?.split('@')[0] ?? ''));
  const [memberNo, setMemberNo] = useState(editing ? (base!.member_no ?? '') : '');
  const [customerLabel, setCustomerLabel] = useState(editing ? (base!.customer_label ?? '') : '');
  // 会員番号から引いたお客様。一般の方は登録が無いので null のまま
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [lookingUp, setLookingUp] = useState(false);
  const [memo, setMemo] = useState(editing ? (base!.memo ?? '') : '');
  const [exclusive, setExclusive] = useState(editing ? base!.exclusive : false);
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

  // 会員番号からお客様を引く。打っている途中で毎回問い合わせないよう少し待つ
  const autoFilled = useRef('');
  useEffect(() => {
    const no = memberNo.trim();
    if (!no) { setCustomer(null); setLookingUp(false); return; }
    setLookingUp(true);
    const t = setTimeout(async () => {
      const { data } = await supabase.from('room_customers')
        .select('*').eq('member_no', no).maybeSingle();
      const c = (data as Customer | null) ?? null;
      setCustomer(c);
      setLookingUp(false);
      if (!c) return;
      // 🚨 手で入れたお名前を上書きしない。空のときか、前回こちらが入れた値のままのときだけ入れる
      setCustomerLabel(prev =>
        (prev.trim() === '' || prev === autoFilled.current) ? c.display_name : prev);
      autoFilled.current = c.display_name;
    }, 400);
    return () => clearTimeout(t);
  }, [memberNo]);

  const applyDuration = (min: number) => setEndTime(addMinutes(startTime, min));
  const durationMin = Math.max(0, minutesOf(endTime) - minutesOf(startTime));
  // 用途ごとの長さ（2026-08-29 ユーザー指定）。値はDBにあり、社員が基本設定で変えられる。
  // 知らない用途が来たときは、これまでどおり自由に入れられるようにしておく
  const durOpt = purposeDurations.find(d => d.purpose === purpose) ?? null;
  const durPresets = durOpt ? durOpt.minutes : [...DURATION_PRESETS];
  const allowFreeEnd = durOpt ? durOpt.allow_free : true;
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
    if (!bookerName.trim()) { setError('予約する人の名前を入れてください'); return; }

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
        purpose, booker_name: bookerName.trim(),
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
            {PURPOSES.map(p => {
              const on = purpose === p;
              const [fg, bgc] = purposeColor(p, isDark);
              return (
                <button key={p}
                  onClick={() => {
                    setPurpose(p);
                    // 長さが決まっている用途に変えたときは、終了時刻もその場で合わせる。
                    // 終了は手で直せないので、合っていないまま残ると直せなくなる
                    const opt = purposeDurations.find(d => d.purpose === p);
                    if (opt && !opt.allow_free && opt.minutes.length > 0) {
                      setEndTime(addMinutes(startTime, opt.minutes[0]));
                    }
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
            </p>
          )}
        </div>

        <div>
          <label style={label}>予約する人</label>
          <input value={bookerName} onChange={e => setBookerName(e.target.value)} style={input} placeholder="山田" />
        </div>

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
            <div style={{ display: 'flex', gap: 10 }}>
              <div style={{ flex: 1 }}>
                <label style={label}>会員番号（任意）</label>
                <input value={memberNo} onChange={e => setMemberNo(e.target.value)} style={input}
                  inputMode="numeric" placeholder="2014052061" />
              </div>
              <div style={{ flex: 1 }}>
                <label style={label}>お客様（任意）</label>
                <input value={customerLabel} onChange={e => setCustomerLabel(e.target.value)} style={input} placeholder="田中様" />
              </div>
            </div>
            {/* 会員番号からお名前を引く。
                🚨 一般の方（非会員）もいるので、見つからないのは異常ではない。
                   その場合はお名前を手で入れてもらう（2026-08-29 ユーザー指示） */}
            <p style={{ fontSize: 11.5, color: customer ? accent : textMid, margin: '-6px 0 0', lineHeight: 1.6 }}>
              {lookingUp
                ? 'お客様を探しています...'
                : customer
                  ? `${customer.display_name}${customer.full_name ? `（${customer.full_name}）` : ''}`
                    + `${customer.birth_date ? ` ${gradeOf(customer.birth_date, date)}` : ''}`
                    + `${customer.active ? '' : ' ※退会になっています'}`
                  : memberNo.trim()
                    ? 'この会員番号は登録がありません。一般のお客様として、お名前を手で入れてください'
                    : 'お名前はフルネームではなく「田中様」のような呼び方で入れてください。'
                      + '会員番号を入れると、登録されているお客様のお名前が自動で入ります。'}
            </p>
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
// 予約の詳細（変更・休講・削除）
// ============================================================
const BookingDetail: React.FC<{
  booking: Booking; floors: Floor[]; campuses: Campus[];
  staff: Staff[]; categories: LessonCategory[];
  onClose: () => void; onEdit: (b: Booking) => void; onChanged: (msg: string) => void; isDark: boolean;
}> = ({ booking: b, floors, campuses, staff, categories, onClose, onEdit, onChanged, isDark }) => {
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<'none' | 'cancel' | 'delete'>('none');
  // 繰り返しの予約は「この回だけ」か「今後すべて」かを必ず選んでもらう。
  // 🚨 これを省くと「今週だけ休みのつもりが全部消えた」事故になる（Googleカレンダーと同じ流儀）
  const [scope, setScope] = useState<'one' | 'future'>('one');
  const [error, setError] = useState('');
  // キャンセル待ち（この予約の後ろに並んでいる方）
  const [waiting, setWaiting] = useState<Waitlist[]>([]);
  const [adding, setAdding] = useState(false);
  const [waitMember, setWaitMember] = useState('');
  const [waitLabel, setWaitLabel] = useState('');
  // 募集枠に申込を入れるときの入力
  const [filling, setFilling] = useState(false);
  const [fillMember, setFillMember] = useState('');
  const [fillLabel, setFillLabel] = useState('');
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

  // この予約を待っている方を読む
  const loadWaiting = useCallback(async () => {
    const { data } = await supabase.from('room_waitlist')
      .select('*').eq('booking_id', b.id).eq('status', 'waiting')
      .order('position').order('created_at');
    setWaiting((data ?? []) as Waitlist[]);
  }, [b.id]);

  useEffect(() => { loadWaiting(); }, [loadWaiting]);

  const addWaiting = async () => {
    if (!waitLabel.trim()) return;
    setBusy(true); setError('');
    const { data: me } = await supabase.auth.getUser();
    if (!me.user?.id) { setBusy(false); setError('ログインし直してください'); return; }
    const { error: err } = await supabase.from('room_waitlist').insert({
      booking_id: b.id,
      member_no: waitMember.trim() || null,
      customer_label: waitLabel.trim(),
      // 末尾に並べる。同じ値でも受け付けた順に出るので、細かく詰め直さない
      position: waiting.length,
      created_by: me.user.id,
    });
    setBusy(false);
    if (err) { setError('追加できませんでした。通信を確認してもう一度お試しください。'); return; }
    setWaitMember(''); setWaitLabel(''); setAdding(false);
    await loadWaiting();
  };

  // 休講にする（枠は残す。消すと「空いた」と誤解されて二重に埋まるため）
  const setCancelled = async () => {
    setBusy(true); setError('');
    const { error: err } = await applyTo({ status: 'cancelled', updated_at: new Date().toISOString() });
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
      .update({ status: 'active', updated_at: new Date().toISOString() })
      .eq('id', b.id);
    setBusy(false);
    if (err) { setError('元に戻せませんでした。通信を確認してもう一度お試しください。'); return; }
    onChanged('休講を取り消しました');
  };

  /**
   * 募集中の枠に申込を入れる。
   * 🚨 枠を消して予約を作り直すのではなく、同じ行の種別を変える（DB側の room_fill_open_slot）。
   *    消してから作ると、その一瞬に他の人が入り込む取り合いが起きるため。
   */
  const fillSlot = async () => {
    if (!fillLabel.trim()) { setError('お客様のお名前を入れてください'); return; }
    setBusy(true); setError('');
    const { data, error: err } = await supabase.rpc('room_fill_open_slot', {
      p_id: b.id, p_member_no: fillMember.trim(), p_customer_label: fillLabel.trim(), p_memo: null,
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
          <span style={{ background: bgc, color: fg, borderRadius: 999, padding: '2px 11px', fontSize: 12.5, fontWeight: 700 }}>{b.purpose}</span>
          {isOpen && (
            <span style={{ fontSize: 12.5, fontWeight: 700, color: openSlotColor(isDark)[0] }}>
              🟡 募集中{b.seats > 1 ? `（あと${restSeats}名）` : ''}
            </span>
          )}
          {b.exclusive && <span style={{ fontSize: 12.5, fontWeight: 700 }}>🔒 貸切</span>}
          {repeating && <span style={{ fontSize: 12.5, fontWeight: 700, color: textMid }}>🔁 毎週の繰り返し</span>}
          {b.status === 'cancelled' && <span style={{ fontSize: 12.5, fontWeight: 700, color: textMid }}>休講</span>}
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
        {row('予約した人', b.booker_name)}
        {b.customer_label && row('お客様', b.customer_label)}
        {b.member_no && row('会員番号', (
          <span style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontVariantNumeric: 'tabular-nums' }}>{b.member_no}</span>
            <a href={scholaUrl(b.member_no)} target="_blank" rel="noreferrer"
              style={{ color: accent, fontSize: 12.5, fontWeight: 700, textDecoration: 'none', border: `1px solid ${accent}`, borderRadius: 999, padding: '3px 11px' }}>
              スコラプラスで見る →
            </a>
          </span>
        ))}
        {b.memo && row('メモ', <span style={{ whiteSpace: 'pre-wrap' }}>{b.memo}</span>)}

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
              <div style={{ display: 'flex', gap: 8, marginTop: 9 }}>
                <input value={fillMember} onChange={e => setFillMember(e.target.value)}
                  placeholder="会員番号（任意）" inputMode="numeric"
                  style={{ flex: 1, padding: '8px 10px', borderRadius: 8, border: `1px solid ${line}`, background: isDark ? '#495057' : '#fff', color: text, fontSize: 16, boxSizing: 'border-box' }} />
                <input value={fillLabel} onChange={e => setFillLabel(e.target.value)}
                  placeholder="田中様"
                  style={{ flex: 1, padding: '8px 10px', borderRadius: 8, border: `1px solid ${line}`, background: isDark ? '#495057' : '#fff', color: text, fontSize: 16, boxSizing: 'border-box' }} />
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
              {!adding && (
                <button onClick={() => setAdding(true)}
                  style={{ marginLeft: 'auto', padding: '5px 11px', borderRadius: 999, fontSize: 12.5, border: `1px solid ${line}`, background: 'transparent', color: textMid, cursor: 'pointer' }}>
                  ＋ キャンセル待ちを追加
                </button>
              )}
            </div>

            {waiting.length > 0 && (
              <div style={{ marginTop: 7 }}>
                {waiting.map((w, i) => (
                  <div key={w.id} style={{ fontSize: 12.5, color: textMid, lineHeight: 1.8 }}>
                    {i + 1}. {w.customer_label}
                    {w.member_no ? `（${w.member_no}）` : '（一般）'}
                    {w.note ? ` / ${w.note}` : ''}
                  </div>
                ))}
                <p style={{ fontSize: 11.5, color: textMid, margin: '5px 0 0', lineHeight: 1.6 }}>
                  繰り上げは「基本設定 → キャンセル待ち」から行います
                  （先にこの予約を休講または取り消してください）
                </p>
              </div>
            )}

            {adding && (
              <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                <input value={waitMember} onChange={e => setWaitMember(e.target.value)}
                  placeholder="会員番号（任意）" inputMode="numeric"
                  style={{ padding: '7px 9px', borderRadius: 8, border: `1px solid ${line}`, background: isDark ? '#495057' : '#fff', color: text, fontSize: 16, width: 130, boxSizing: 'border-box' }} />
                <input value={waitLabel} onChange={e => setWaitLabel(e.target.value)}
                  placeholder="お客様（例：田中様）"
                  style={{ padding: '7px 9px', borderRadius: 8, border: `1px solid ${line}`, background: isDark ? '#495057' : '#fff', color: text, fontSize: 16, flex: 1, minWidth: 150, boxSizing: 'border-box' }} />
                <button onClick={addWaiting} disabled={busy || !waitLabel.trim()}
                  style={{ padding: '8px 14px', borderRadius: 8, border: 'none', background: accent, color: isDark ? '#1d2a24' : '#fff', fontSize: 13.5, fontWeight: 700, cursor: busy ? 'wait' : 'pointer', opacity: !waitLabel.trim() ? .5 : 1 }}>
                  追加
                </button>
                <button onClick={() => { setAdding(false); setWaitMember(''); setWaitLabel(''); }}
                  style={{ padding: '8px 12px', borderRadius: 8, border: `1px solid ${line}`, background: 'transparent', color: textMid, fontSize: 13.5, cursor: 'pointer' }}>
                  やめる
                </button>
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
                休講をやめる
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
 * 長さの設定（社員が変更できる）。
 * 用途ごとに「選べる長さ」と「終了時刻を手で入れてよいか」を決める。
 *
 * 🚨 ここを固定にすると、時間が変わるたびに開発者へ依頼することになる
 *    （2026-08-29 ユーザー指示）。
 */
const DurationSettings: React.FC<{
  purposeDurations: PurposeDuration[];
  onDone: (msg: string) => Promise<void>;
  isDark: boolean;
}> = ({ purposeDurations, onDone, isDark }) => {
  const [draft, setDraft] = useState<Record<string, { text: string; free: boolean }>>(() => {
    const d: Record<string, { text: string; free: boolean }> = {};
    for (const p of PURPOSES) {
      const cur = purposeDurations.find(x => x.purpose === p);
      d[p] = { text: (cur?.minutes ?? []).join('、'), free: cur ? cur.allow_free : true };
    }
    return d;
  });
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

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
    const d = draft[purpose];
    const { list, bad } = parseMinutes(d.text);
    if (bad) { setError('長さは5〜480の数字で、「25、30、50」のように区切って入れてください'); return; }
    if (!d.free && list.length === 0) {
      setError('終了時刻を手で入れられない用途は、長さを1つ以上入れてください');
      return;
    }
    setBusy(purpose); setError('');
    const { data: me } = await supabase.auth.getUser();
    const { error: err } = await supabase.from('room_purpose_durations')
      .upsert({
        purpose, minutes: list, allow_free: d.free,
        updated_at: new Date().toISOString(), updated_by: me.user?.id ?? null,
      }, { onConflict: 'purpose' });
    setBusy('');
    if (err) { setError('保存できませんでした。通信を確認してもう一度お試しください。'); return; }
    setDraft(prev => ({ ...prev, [purpose]: { ...prev[purpose], text: list.join('、') } }));
    await onDone(`${purpose}の長さを変えました`);
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
      </div>

      {error && (
        <div style={{ background: isDark ? '#4a2a2a' : '#fdecea', border: `1px solid ${isDark ? '#7a4444' : '#f5c6cb'}`, color: isDark ? '#ffb4b4' : '#a3282a', borderRadius: 8, padding: '9px 12px', fontSize: 13, marginBottom: 12 }}>
          {error}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {PURPOSES.map(p => {
          const d = draft[p];
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

  const built = useMemo(() => (rows.length
    ? buildBookings(rows, map, {
        floors, campuses, staff, purposeDurations,
        baseDate: today, defaultPurpose: 'レッスン',
      })
    : null), [rows, map, floors, campuses, staff, purposeDurations, today]);

  const overLimit = !!built && built.ok.length > BULK_MAX_ROWS;

  const run = async () => {
    if (!built || built.ok.length === 0 || overLimit) return;
    setRunning(true); setError(''); setProgress(0); setMade(null);
    const ng: { label: string; reason: string }[] = [];
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
        p_staff_id: b.staff_id, p_kind: 'booking', p_seats: 1,
      });
      const row = (Array.isArray(data) ? data[0] : data) as { ok?: boolean; reason?: string } | null;
      if (err) ng.push({ label, reason: '通信エラー' });
      else if (!row?.ok) ng.push({ label, reason: row?.reason ?? '入れられませんでした' });
      else count++;
      setProgress(i + 1);
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
            placeholder={'日付\t場所\t開始\t終了\t用途\t担当\t会員番号\tお客様\n9/1\t四条本校 3階\t16:00\t16:50\tレッスン\t林 晃平\t2014052061\t田中様'}
            style={{ ...input, width: '100%', fontFamily: 'monospace', fontSize: 13, marginBottom: 8 }} />
          <p style={{ fontSize: 12, color: textMid, margin: '0 0 10px', lineHeight: 1.6 }}>
            Excel の範囲をコピーして、そのまま貼り付けられます。
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
              <div>入れられる行 {built.ok.length}件</div>
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
 * キャンセル待ちの一覧（曜日・時間別）。
 *
 * 🚨 日付ごとに並べると、毎週同じ枠を待っている人が散らばって見えない。
 *    「火曜16:00に3名待っている」が分かる形にする（2026-08-31 ユーザー指示）。
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
  const [draft, setDraft] = useState<{ member: string; label: string; note: string }>(
    { member: '', label: '', note: '' });

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
    const { data, error: err } = await supabase
      .from('room_waitlist')
      .select('*, booking:room_bookings(id, floor_id, starts_at, ends_at, purpose, status, deleted_at)')
      .eq('status', 'waiting')
      .order('position')
      .order('created_at');
    if (err) {
      setError('キャンセル待ちを読み込めませんでした。通信を確認して開き直してください。');
      setLoading(false); return;
    }
    setRows((data ?? []) as Waitlist[]);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  /** 場所・曜日・開始時刻でまとめる。毎週同じ枠を待っている人を1つにする */
  const groups = useMemo(() => {
    const m = new Map<string, { floorId: string; weekday: number; time: string; items: Waitlist[] }>();
    for (const w of rows) {
      const b = w.booking;
      if (!b || b.deleted_at) continue;      // 消された予約の待ちは出さない
      const d = new Date(b.starts_at);
      const key = `${b.floor_id}|${d.getDay()}|${hhmm(b.starts_at)}`;
      const g = m.get(key)
        ?? { floorId: b.floor_id, weekday: d.getDay(), time: hhmm(b.starts_at), items: [] };
      g.items.push(w);
      m.set(key, g);
    }
    const order = new Map(floors.map((f, i) => [f.id, i]));
    return [...m.values()].sort((a, b) =>
      a.weekday - b.weekday
      || a.time.localeCompare(b.time)
      || (order.get(a.floorId) ?? 99) - (order.get(b.floorId) ?? 99));
  }, [rows, floors]);

  const saveEdit = async (w: Waitlist) => {
    if (!draft.label.trim()) { setError('お客様のお名前を入れてください'); return; }
    setBusy(w.id); setError('');
    const { error: err } = await supabase.from('room_waitlist').update({
      member_no: draft.member.trim() || null,
      customer_label: draft.label.trim(),
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

  const cancel = async (w: Waitlist) => {
    setBusy(w.id);
    const { error: err } = await supabase.from('room_waitlist')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() }).eq('id', w.id);
    setBusy('');
    if (err) { setError('取り消せませんでした。通信を確認してください。'); return; }
    await load();
    await onDone('キャンセル待ちを取り消しました');
  };

  const promote = async (w: Waitlist) => {
    setBusy(w.id); setError('');
    const { data, error: err } = await supabase.rpc('room_promote_waitlist', { p_waitlist_id: w.id });
    const row = (Array.isArray(data) ? data[0] : data) as
      { ok?: boolean; reason?: string } | null;
    setBusy('');
    if (err) { setError('繰り上げられませんでした。通信を確認してください。'); return; }
    if (!row?.ok) {
      // 多くは「もとの予約がまだ生きている」。先に休講や取り消しが要る
      setError(`${row?.reason ?? '繰り上げられませんでした'}（先にもとの予約を休講または取り消してください）`);
      return;
    }
    await load();
    await onDone(`${w.customer_label} を予約に繰り上げました`);
  };

  return (
    <div>
      <div style={{ background: lineSoft, borderRadius: 8, padding: '10px 12px', fontSize: 13, lineHeight: 1.7, marginBottom: 12, color: textMid }}>
        いま並んでいる方を、<b>曜日・時間ごと</b>にまとめています。
        <br />
        🚨 <b>自動では繰り上げません。</b>もとの予約を休講または取り消したうえで「繰り上げる」を押すと、
        その方の予約ができます。空きが無いまま押すと、理由を出して止まります。
      </div>

      {error && (
        <div style={{ background: isDark ? '#4a2a2a' : '#fdecea', border: `1px solid ${isDark ? '#7a4444' : '#f5c6cb'}`, color: isDark ? '#ffb4b4' : '#a3282a', borderRadius: 8, padding: '9px 12px', fontSize: 13, marginBottom: 12 }}>
          {error}
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
            <div key={`${g.floorId}|${g.weekday}|${g.time}`}
              style={{ border: `1px solid ${line}`, borderRadius: 8, padding: '10px 12px' }}>
              <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>
                {WEEKDAY_LABEL[g.weekday]}曜 {g.time}
                <span style={{ fontSize: 12.5, fontWeight: 400, color: textMid }}>
                  {' / '}{placeName(g.floorId)}{' / '}待ち {g.items.length}名
                </span>
              </div>

              {g.items.map((w, i) => (
                <div key={w.id} style={{ borderTop: `1px solid ${lineSoft}`, padding: '8px 0' }}>
                  {editing === w.id ? (
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                      <input value={draft.member} placeholder="会員番号"
                        onChange={e => setDraft(p => ({ ...p, member: e.target.value }))}
                        style={{ ...input, width: 118 }} />
                      <input value={draft.label} placeholder="お客様（例：田中様）"
                        onChange={e => setDraft(p => ({ ...p, label: e.target.value }))}
                        style={{ ...input, width: 168 }} />
                      <input value={draft.note} placeholder="メモ"
                        onChange={e => setDraft(p => ({ ...p, note: e.target.value }))}
                        style={{ ...input, flex: 1, minWidth: 120 }} />
                      <button onClick={() => saveEdit(w)} disabled={busy === w.id}
                        style={smallBtn(true)}>保存</button>
                      <button onClick={() => setEditing(null)} style={smallBtn(false)}>やめる</button>
                    </div>
                  ) : (
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
                        <button onClick={() => {
                          setEditing(w.id);
                          setDraft({ member: w.member_no ?? '', label: w.customer_label, note: w.note ?? '' });
                        }} style={smallBtn(false)}>直す</button>
                        <button onClick={() => promote(w)} disabled={!!busy}
                          style={smallBtn(true)}>繰り上げる</button>
                        <button onClick={() => cancel(w)} disabled={!!busy}
                          style={smallBtn(false)}>取り消す</button>
                      </span>
                    </div>
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
  isDark: boolean; onDone: (msg: string) => Promise<void>;
}> = ({ isDark, onDone }) => {
  const [sub, setSub] = useState<'list' | 'import'>('list');
  const [list, setList] = useState<Customer[]>([]);
  const [contacts, setContacts] = useState<Record<string, CustomerContact>>({});
  const [canSeeContacts, setCanSeeContacts] = useState(false);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

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

  const load = useCallback(async () => {
    setLoading(true); setError('');
    const [cRes, kRes] = await Promise.all([
      supabase.from('room_customers').select('*').order('display_name'),
      // 連絡先は公開範囲の設定によっては読めない。読めなくてもエラーにしない
      supabase.from('room_customer_contacts').select('*'),
    ]);
    if (cRes.error) {
      setError('お客様の一覧を読み込めませんでした。通信を確認して開き直してください。');
      setLoading(false); return;
    }
    setList((cRes.data ?? []) as Customer[]);
    const ks = (kRes.data ?? []) as CustomerContact[];
    setCanSeeContacts(!kRes.error);
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
          birth_date: c.birth_date, imported_at: now, updated_at: now, updated_by: uid,
        })), { onConflict: 'member_no' });
      if (err1) {
        setBusy(false);
        setError('取り込みの途中で保存できませんでした。もう一度お試しください。');
        await load(); return;
      }
      // 連絡先は、値が1つでもある行だけ入れる
      const withContact = part.filter(c => c.phone || c.email || c.guardian_name);
      if (withContact.length > 0) {
        const { error: err2 } = await supabase.from('room_customer_contacts').upsert(
          withContact.map(c => ({
            member_no: c.member_no, phone: c.phone, email: c.email,
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
    return c.member_no.toLowerCase().includes(k)
      || c.display_name.toLowerCase().includes(k)
      || (c.full_name ?? '').toLowerCase().includes(k);
  });

  return (
    <div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
        {([['list', '一覧'], ['import', '取り込み']] as const).map(([k, l]) => (
          <button key={k} onClick={() => setSub(k)} style={smallBtn(sub === k)}>{l}</button>
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
          <input value={q} onChange={e => setQ(e.target.value)}
            placeholder="会員番号・お名前で探す" style={{ ...input, width: '100%', marginBottom: 10 }} />
          <p style={{ fontSize: 12.5, color: textMid, margin: '0 0 10px', lineHeight: 1.6 }}>
            {list.length}名（表示 {shown.length}名）。学年は生年月日から計算しています。
            {!canSeeContacts && ' 連絡先は、いまの公開範囲では表示されません。'}
          </p>
          {shown.slice(0, 200).map(c => {
            const k = contacts[c.member_no];
            return (
              <div key={c.member_no} style={{ borderTop: `1px solid ${lineSoft}`, padding: '9px 0' }}>
                <div style={{ display: 'flex', gap: 9, alignItems: 'center', flexWrap: 'wrap' }}>
                  <b style={{ fontSize: 14, color: c.active ? text : textMid }}>
                    {c.display_name}{!c.active && '（退会）'}
                  </b>
                  <span style={{ fontSize: 12.5, color: textMid }}>
                    {c.member_no}
                    {c.full_name && ` / ${c.full_name}`}
                    {c.birth_date && ` / ${gradeOf(c.birth_date, today)}`}
                  </span>
                  <button disabled={busy} onClick={() => setActive(c, !c.active)}
                    style={{ ...smallBtn(false), marginLeft: 'auto' }}>
                    {c.active ? '退会にする' : '在籍に戻す'}
                  </button>
                </div>
                {k && (k.phone || k.email || k.guardian_name) && (
                  <div style={{ fontSize: 12.5, color: textMid, marginTop: 4 }}>
                    {[k.phone, k.email, k.guardian_name && `保護者：${k.guardian_name}`]
                      .filter(Boolean).join(' / ')}
                  </div>
                )}
              </div>
            );
          })}
          {shown.length > 200 && (
            <p style={{ fontSize: 12.5, color: textMid, marginTop: 10 }}>
              多いので先頭200名だけ出しています。上の欄で絞り込んでください
            </p>
          )}
        </>
      ))}

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
  purposeDurations: PurposeDuration[]; user: AuthUser;
  onClose: () => void; onDone: (msg: string) => Promise<void>; isDark: boolean;
}> = ({ campuses, floors, staff, categories, purposeDurations, user, onClose, onDone, isDark }) => {
  const today = todayStr();
  const [tab, setTab] = useState<'renew' | 'duration' | 'staff' | 'customer' | 'waitlist' | 'bulk'>('renew');
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
           ['bulk', '予約の一括入力'], ['staff', 'スタッフ'], ['duration', '長さの設定']] as const)
          .map(([k, l]) => (
            <button key={k} onClick={() => !running && setTab(k)} style={smallBtn(tab === k)}>{l}</button>
          ))}
      </div>

      {tab === 'duration' && (
        <DurationSettings purposeDurations={purposeDurations} onDone={onDone} isDark={isDark} />
      )}

      {tab === 'staff' && (
        <StaffSettings staff={staff} categories={categories} onChanged={onDone} isDark={isDark} />
      )}

      {tab === 'customer' && (
        <CustomerSettings isDark={isDark} onDone={onDone} />
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
                    placeholder="表示名（例：田中様）" style={{ ...input, width: 168 }} />
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
const SettingsPanel: React.FC<{
  campuses: Campus[]; floors: Floor[]; categories: LessonCategory[];
  onClose: () => void; onChanged: (msg: string) => Promise<void>; isDark: boolean;
}> = ({ campuses, floors, categories, onClose, onChanged, isDark }) => {
  // スタッフは基本設定（社員）へ移した。ここに残すのは管理者だけが触るもの
  const [tab, setTab] = useState<'category' | 'place' | 'privacy'>('category');
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
        {([['category', 'レッスン区分'], ['place', '場所'], ['privacy', '連絡先の公開範囲']] as const).map(([k, l]) => (
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

      {/* ---- 連絡先の公開範囲 ---- */}
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

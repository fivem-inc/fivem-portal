import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import type { AuthUser } from '../types';
import { supabase } from '../lib/supabaseClient';
import { useDarkMode } from '../hooks/useDarkMode';
import TimeInput from '../components/TimeInput';
import {
  PURPOSES, purposeColor, VIEW_START_HOUR, VIEW_END_HOUR, DURATION_PRESETS,
  todayStr, toDate, hhmm, minutesOf, addMinutes, formatDateLabel, shiftDate,
  scholaUrl, floorBusyNow, nextStart, usingUntil, assignColumns, categoryLabel,
  isWeekend, RANGE_DAYS, localDate, placeLabel, openSlotColor,
  type Campus, type Floor, type Booking, type ConflictInfo,
  type Staff, type LessonCategory,
} from '../lib/roomBooking';

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

const RoomBookingPage: React.FC<Props> = ({ user }) => {
  const isDark = useDarkMode();
  const [campuses, setCampuses] = useState<Campus[]>([]);
  const [floors, setFloors] = useState<Floor[]>([]);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [categories, setCategories] = useState<LessonCategory[]>([]);
  const [campusId, setCampusId] = useState<string>('');
  const [view, setView] = useState<ViewMode>('place');
  // 担当別・参加者別の絞り込み。'' = 全員。それ以外は staff.id または参加者キー
  const [only, setOnly] = useState<string>('');
  const [date, setDate] = useState<string>(todayStr());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [form, setForm] = useState<FormMode | null>(null);
  const [detail, setDetail] = useState<Booking | null>(null);
  const [admin, setAdmin] = useState(false);
  const [settings, setSettings] = useState(false);
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
    const [cRes, fRes, sRes, catRes, scRes] = await Promise.all([
      supabase.from('room_campuses').select('*').eq('active', true).order('sort_order'),
      supabase.from('room_floors').select('*').eq('active', true).order('sort_order'),
      supabase.from('room_staff').select('*').order('sort_order'),
      supabase.from('room_lesson_categories').select('*').order('sort_order'),
      supabase.from('room_staff_categories').select('*'),
    ]);
    if (cRes.error || fRes.error) {
      setLoadError('場所の情報を読み込めませんでした。時間をおいて開き直してください。');
      return null;
    }
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
      // 管理者だけ「場所・スタッフの設定」を開ける
      const { data: me } = await supabase.auth.getUser();
      setAdmin(((me.user?.app_metadata as { role?: string } | undefined)?.role) === 'admin');
      setLoading(false);
    })();
  }, [loadMasters]);

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
          {admin && (
            <button onClick={() => setSettings(true)}
              style={{ ...btn(false), marginLeft: 'auto' }}>⚙️ 設定</button>
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
          staff={staff} categories={categories}
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
      {settings && (
        <SettingsPanel
          campuses={campuses} floors={floors} staff={staff} categories={categories}
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
  staff: Staff[]; categories: LessonCategory[];
  onClose: () => void; onSaved: (msg: string) => void; isDark: boolean;
}> = ({ mode, user, floors, campuses, staff, categories, onClose, onSaved, isDark }) => {
  const editing = mode.kind === 'edit';
  const base = editing ? mode.booking : null;

  const [floorId] = useState(editing ? base!.floor_id : mode.floorId);
  // 🚨 日付は localDate を通す（ISO文字列の頭10文字はUTCの日付で、朝の予約が前日になる）
  const [date] = useState(editing ? localDate(base!.starts_at) : mode.date);
  const [startTime, setStartTime] = useState(editing ? hhmm(base!.starts_at) : mode.startTime);
  const [endTime, setEndTime] = useState(editing ? hhmm(base!.ends_at) : addMinutes(mode.startTime, 30));
  const [purpose, setPurpose] = useState<string>(editing ? base!.purpose : 'レッスン');
  const [bookerName, setBookerName] = useState(editing ? base!.booker_name : (user.email?.split('@')[0] ?? ''));
  const [memberNo, setMemberNo] = useState(editing ? (base!.member_no ?? '') : '');
  const [customerLabel, setCustomerLabel] = useState(editing ? (base!.customer_label ?? '') : '');
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

  const applyDuration = (min: number) => setEndTime(addMinutes(startTime, min));
  const durationMin = Math.max(0, minutesOf(endTime) - minutesOf(startTime));
  // 確認中は押せてよい（結果が出るまで待たせない）。確認が済んで「不可」のときだけ止める
  const blocked = !checking && !!verdict && !verdict.ok;
  // 繰り返しの終わりは最長1年先まで（打ち間違いで大量の予約が入るのを防ぐ）
  const maxRepeatUntil = shiftDate(date, 364);
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
      setError(`繰り返しの終わりの日は、1年先（${formatDateLabel(maxRepeatUntil)}）までにしてください`);
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
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
            {DURATION_PRESETS.map(m => (
              <button key={m} onClick={() => applyDuration(m)}
                style={{
                  padding: '6px 13px', borderRadius: 999, fontSize: 13, cursor: 'pointer',
                  border: `1px solid ${durationMin === m ? accent : line}`,
                  background: durationMin === m ? accent : (isDark ? '#35354e' : '#f0f2f5'),
                  color: durationMin === m ? (isDark ? '#1d2a24' : '#fff') : textMid,
                  fontWeight: durationMin === m ? 700 : 400,
                }}>{m}分</button>
            ))}
          </div>
          <label style={label}>終了</label>
          <TimeInput value={endTime} onChange={setEndTime} isDark={isDark} ariaLabel="終了時刻" />
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
                <button key={p} onClick={() => setPurpose(p)}
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
            <p style={{ fontSize: 11.5, color: textMid, margin: '-6px 0 0', lineHeight: 1.6 }}>
              お名前はフルネームではなく「田中様」のような呼び方で入れてください。
              詳しい情報は、会員番号から開けるスコラプラスでご確認いただけます。
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
              <input type="checkbox" checked={repeat} onChange={e => setRepeat(e.target.checked)} style={{ width: 18, height: 18, flexShrink: 0 }} />
              <span style={{ fontSize: 13.5, fontWeight: 700 }}>毎週この曜日に繰り返す</span>
            </label>
            {repeat && (
              <div style={{ marginTop: 10 }}>
                <label style={label}>いつまで</label>
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
                          + (capped ? ` ※1年先（${formatDateLabel(maxRepeatUntil)}）までにしてください` : '');
                      })()
                    : '終わりの日を入れてください（1年先までにできます）'}
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
// 設定（管理者だけ）
//   スタッフの追加・非表示・担当区分の変更、レッスン区分の追加・変更、
//   場所の同時予約件数と営業時間の変更。
//   🚨 ここが無いと、スタッフや区分が増えるたびに開発者へ依頼することになる。
//      現場で完結できるようにしておくこと（2026-08-28 ユーザー指示）。
// ============================================================
const SettingsPanel: React.FC<{
  campuses: Campus[]; floors: Floor[]; staff: Staff[]; categories: LessonCategory[];
  onClose: () => void; onChanged: (msg: string) => Promise<void>; isDark: boolean;
}> = ({ campuses, floors, staff, categories, onClose, onChanged, isDark }) => {
  const [tab, setTab] = useState<'staff' | 'category' | 'place'>('staff');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [newStaffName, setNewStaffName] = useState('');
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

  const toggleCategory = (s: Staff, catId: string) => {
    const has = s.categoryIds?.includes(catId);
    run(async () => has
      ? await supabase.from('room_staff_categories').delete().eq('staff_id', s.id).eq('category_id', catId)
      : await supabase.from('room_staff_categories').insert({ staff_id: s.id, category_id: catId }),
      '担当できる区分を変えました');
  };

  return (
    <Overlay onClose={onClose} isDark={isDark} title="場所とスタッフの設定" wide>
      <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
        {([['staff', 'スタッフ'], ['category', 'レッスン区分'], ['place', '場所']] as const).map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)} style={smallBtn(tab === k)}>{l}</button>
        ))}
      </div>

      {error && (
        <div style={{ background: isDark ? '#4a2a2a' : '#fdecea', border: `1px solid ${isDark ? '#7a4444' : '#f5c6cb'}`, color: isDark ? '#ffb4b4' : '#a3282a', borderRadius: 8, padding: '9px 12px', fontSize: 13, marginBottom: 12 }}>
          {error}
        </div>
      )}

      {/* ---- スタッフ ---- */}
      {tab === 'staff' && (
        <div>
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

      <button onClick={onClose}
        style={{ width: '100%', marginTop: 18, padding: '11px', borderRadius: 8, border: `1px solid ${line}`, background: 'transparent', color: textMid, fontSize: 14, cursor: 'pointer' }}>
        閉じる
      </button>
    </Overlay>
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
  for (let i = 0; i < 60; i++) {           // 最大60回＝約1年余
    if (cur > until) break;
    out.push(cur);
    cur = shiftDate(cur, 7);
  }
  return out;
}

export default RoomBookingPage;

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient';
import { errorStyle, scrollToFirstError } from '../lib/formHighlight';
import { useDarkMode } from '../hooks/useDarkMode';
import { useFocusHighlight } from '../hooks/useFocusHighlight';
import { dispatchEmail, dispatchSiteNotification, resolveRoleRecipients } from '../lib/notificationDispatch';
import { insertNotification } from '../lib/notifications';
import { DRAFT_KEYS, loadDraft, saveDraft, clearDraft } from '../lib/draftStorage';
import { tripTypeColor, tripCategoryLabel, formatTripNextDates, formatTripDateTime, tripMapUrl } from '../lib/tripReportDisplay';
import SearchableSelect from './common/SearchableSelect';
import HelpLinkButton from './HelpLinkButton';
import type { AuthUser, BusinessTripReport } from '../types';

// 履歴タブに出す1件分（profiles は報告者名の表示にだけ使う）
interface TripHistoryRow {
  id: string;
  user_id: string;
  report_type: string;
  category: string;
  category_other: string | null;
  location: string;
  notes: string | null;
  latitude: number | null;
  longitude: number | null;
  address: string | null;
  next_dates: string | null;
  created_at: string;
  profiles?: { name: string | null } | null;
}

// 出張報告の下書き（GPS・住所は一時情報なので保存しない）
interface TripDraft {
  reportType: '到着' | '終了'; category: string; categoryOther: string;
  location: string; locationCustom: string; useCustomLocation: boolean;
  notes: string; nextDates: string[]; slackComment: string; selectedChannels: string[];
}

const BannerSuccess: React.FC<{ message: string; icon?: 'check' | 'send'; onClose: () => void }> = ({ message, icon = 'check', onClose }) => {
  useEffect(() => { const t = setTimeout(onClose, 3000); return () => clearTimeout(t); }, [onClose]);
  return (
    <div style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', zIndex: 9999 }}>
      <div style={{ background: '#f0fdf4', border: '1.5px solid #b7e4cc', borderRadius: 18, padding: '24px 28px', minWidth: 200, textAlign: 'center', position: 'relative' }}>
        <button onClick={onClose} style={{ position: 'absolute', top: 10, right: 10, background: 'rgba(21,87,36,0.1)', border: 'none', color: '#155724', borderRadius: '50%', width: 26, height: 26, cursor: 'pointer', fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>✕</button>
        <div style={{ width: 60, height: 60, borderRadius: '50%', background: '#d4edda', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 12px' }}>
          <span style={{ fontSize: 26, color: '#28a745' }}>{icon === 'send' ? '📤' : '✓'}</span>
        </div>
        <div style={{ fontSize: 15, fontWeight: 500, color: '#155724' }}>{message}</div>
      </div>
    </div>
  );
};

interface Props {
  user: AuthUser;
  profileName: string | null;
  canHistory: boolean; // 全員分の報告を見られる役職か（管理画面の「出張報告の履歴閲覧」）
}

const SLACK_CHANNELS = [
  { key: 'adult',             label: '03大人へ' },
  { key: 'kids_main',         label: '04本校こどもへ' },
  { key: 'kids_nishijin',     label: '05_2西陣校こどもへ' },
  { key: 'kids_kamikatsura',  label: '05_3上桂校こどもへ' },
  { key: 'kids_rakusaiguchi', label: '05_4洛西口校こどもへ' },
  { key: 'kids_minamisusita', label: '05_5南草津校こどもへ' },
  { key: 'junior',            label: '06ジュニアへ' },
  { key: 'support',           label: '07_1お客様サポートへ' },
];

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

function formatDate(d: Date) {
  return `${d.getMonth() + 1}/${d.getDate()}（${WEEKDAYS[d.getDay()]}）`;
}

interface CalendarProps {
  selected: string[];
  onToggle: (dateStr: string) => void;
  isDark: boolean;
}

const DateCalendar: React.FC<CalendarProps> = ({ selected, onToggle, isDark }) => {
  const today = new Date();
  const [viewYear, setViewYear] = useState(today.getFullYear());
  const [viewMonth, setViewMonth] = useState(today.getMonth());

  const prevMonth = () => {
    if (viewMonth === 0) { setViewMonth(11); setViewYear(y => y - 1); }
    else setViewMonth(m => m - 1);
  };
  const nextMonth = () => {
    if (viewMonth === 11) { setViewMonth(0); setViewYear(y => y + 1); }
    else setViewMonth(m => m + 1);
  };

  const firstDay = new Date(viewYear, viewMonth, 1).getDay();
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const cells: (number | null)[] = [
    ...Array(firstDay).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <button onClick={prevMonth} style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: isDark ? '#fff' : '#333', padding: '4px 10px' }}>‹</button>
        <span style={{ fontWeight: 'bold', color: isDark ? '#fff' : '#333' }}>{viewYear}年{viewMonth + 1}月</span>
        <button onClick={nextMonth} style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: isDark ? '#fff' : '#333', padding: '4px 10px' }}>›</button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2, marginBottom: 4 }}>
        {WEEKDAYS.map((w, i) => (
          <div key={w} style={{ textAlign: 'center', fontSize: 12, fontWeight: 'bold',
            color: i === 0 ? '#e74c3c' : i === 6 ? '#3498db' : isDark ? '#aaa' : '#666' }}>
            {w}
          </div>
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2 }}>
        {cells.map((day, idx) => {
          if (!day) return <div key={idx} />;
          const dateStr = `${viewYear}-${String(viewMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
          const isSelected = selected.includes(dateStr);
          const dow = (firstDay + day - 1) % 7;
          return (
            <button key={idx} onClick={() => onToggle(dateStr)}
              style={{
                padding: '6px 2px', borderRadius: 6, border: 'none', cursor: 'pointer',
                fontWeight: isSelected ? 'bold' : 'normal', fontSize: 14,
                background: isSelected ? '#007bff' : isDark ? '#495057' : '#f8f9fa',
                color: isSelected ? '#fff' : dow === 0 ? '#e74c3c' : dow === 6 ? '#3498db' : isDark ? '#fff' : '#333',
              }}>
              {day}
            </button>
          );
        })}
      </div>
    </div>
  );
};

const BusinessTripReportForm: React.FC<Props> = ({ user, profileName, canHistory }) => {
  const isDark = useDarkMode();
  const topRef = useRef<HTMLDivElement>(null);

  // 表示中のタブ。🚨 URLに持たせる（?tab=history）。
  //  ① 通知をタップして履歴の該当報告へ直接飛べるようにするため
  //  ② スマホの戻るボタンで履歴→フォームに戻れるようにするため（2026-07-07 に他ページと統一した方式）
  //  ③ 下書き（TripDraft）には保存しない。保存すると次に開いたとき履歴タブで開いてしまい、
  //     入力途中の下書きが残っていることに気づけなくなる
  const [searchParams, setSearchParams] = useSearchParams();
  // 🚨 権限が無い人は ?tab=history が付いていてもフォームに着地させる。
  //    タブのボタン自体は canHistory で隠しているが、URLだけで開けてしまうと
  //    「タブが無いのに中身が空の履歴画面」という迷子の画面になる（データはRLSで0件のため）。
  //    通知の宛先に役職を足したのに履歴の権限をONにし忘れたときの保険でもある。
  const tab: 'form' | 'history' = (searchParams.get('tab') === 'history' && canHistory) ? 'history' : 'form';
  const setTab = (next: 'form' | 'history') => {
    setShowConfirm(false); // 送信確認を開いたままタブを切り替えられないようにする
    const p = new URLSearchParams(searchParams);
    if (next === 'history') p.set('tab', 'history');
    else { p.delete('tab'); p.delete('focus'); }
    setSearchParams(p);
  };

  // 全員分の報告を見られる役職か（props で受け取る）。
  // 画面の出し分けはここ、実データの保護はDB側のRLS（has_feature_permission）が担当する。
  // 🚨 RPCで直接DBに聞く方式にすると、役職プレビュー中も実アカウント（管理者）で評価されるため
  //    「一般として表示」でも履歴タブが出てしまう。他機能と同じ useAuth 経由に揃えてある

  // 区分リスト・場所プリセット（DBから取得）
  const [categories, setCategories] = useState<string[]>(['出張', '園指導', '試合', 'イベント（下見）', 'その他']);
  const [locationPresets, setLocationPresets] = useState<Record<string, string[]>>({});

  useEffect(() => {
    Promise.all([
      supabase.from('master_options').select('value, sort_order').eq('category', 'trip_category').order('sort_order'),
      supabase.from('master_options').select('category, value, sort_order').like('category', 'trip_location_%').order('sort_order'),
    ]).then(([catRes, locRes]) => {
      if (catRes.data && catRes.data.length > 0) {
        setCategories(catRes.data.map(r => r.value));
      }
      if (locRes.data) {
        const map: Record<string, string[]> = {};
        locRes.data.forEach(row => {
          const catName = row.category.replace('trip_location_', '');
          if (!map[catName]) map[catName] = [];
          map[catName].push(row.value);
        });
        setLocationPresets(map);
      }
    });
  }, []);

  // 入力中の下書きを端末に自動保存し、開き直したら復元する
  const [td] = useState(() => loadDraft<TripDraft>(DRAFT_KEYS.trip));
  const [formError, setFormError] = useState<string | null>(null); // 入力エラー・失敗のインライントースト（alert廃止）
  // 入力エラーの欄を薄赤にする（lib/formHighlight.ts の共通色）
  const [errFields, setErrFields] = useState<Set<string>>(new Set());
  const [reportType, setReportType] = useState<'到着' | '終了'>(td?.reportType ?? '到着');
  const [category, setCategory] = useState<string>(td?.category ?? '出張');
  const [categoryOther, setCategoryOther] = useState(td?.categoryOther ?? '');
  const [location, setLocation] = useState(td?.location ?? '');
  const [locationCustom, setLocationCustom] = useState(td?.locationCustom ?? ''); // 直接入力
  const [useCustomLocation, setUseCustomLocation] = useState(td?.useCustomLocation ?? false);
  const [notes, setNotes] = useState(td?.notes ?? '');
  const [nextDates, setNextDates] = useState<string[]>(td?.nextDates ?? []);
  const [slackComment, setSlackComment] = useState(td?.slackComment ?? '');
  const [selectedChannels, setSelectedChannels] = useState<string[]>(td?.selectedChannels ?? []);
  const [gps, setGps] = useState<{ lat: number; lng: number; accuracy: number } | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [gpsLoading, setGpsLoading] = useState(false);
  const [gpsAttempted, setGpsAttempted] = useState(false);
  const [gpsUnavailable, setGpsUnavailable] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  // ── 履歴タブ ──
  const [historyRows, setHistoryRows] = useState<TripHistoryRow[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [hType, setHType] = useState<'all' | '到着' | '終了'>('all');
  const [hReporter, setHReporter] = useState('all');
  const [hCategory, setHCategory] = useState('all');
  const [hLocation, setHLocation] = useState('all');
  const [showMoreFilters, setShowMoreFilters] = useState(false);
  const [openMonths, setOpenMonths] = useState<Set<string>>(new Set());
  // 通知から ?focus=<報告ID> で来たとき、その報告カードを黄色く光らせる
  const { highlightId, focusRef } = useFocusHighlight(historyRows);

  const presets = locationPresets[category] ?? [];
  const showNextDates = reportType === '終了' && (category === '出張' || category === '園指導');
  const effectiveLocation = useCustomLocation ? locationCustom : location;

  const fetchHistory = useCallback(async () => {
    setHistoryLoading(true);
    setHistoryError(null);
    // 🚨 error を必ず見る。RLSで見えないときは 0 行が返るだけでエラーにならないため、
    //    握りつぶすと「なぜか空」の原因が分からなくなる（残業ページで実際に踏んだ）
    const { data, error } = await supabase
      .from('business_trip_reports')
      .select('id, user_id, report_type, category, category_other, location, notes, latitude, longitude, address, next_dates, created_at, profiles(name)')
      .order('created_at', { ascending: false });
    if (error) {
      setHistoryError('報告を読み込めませんでした。通信状況を確認してもう一度お試しください。');
      setHistoryLoading(false);
      return;
    }
    setHistoryRows((data ?? []) as unknown as TripHistoryRow[]);
    setHistoryLoading(false);
  }, []);

  useEffect(() => { if (tab === 'history') fetchHistory(); }, [tab, fetchHistory]);

  // 入力中の下書きを自動保存
  useEffect(() => {
    saveDraft(DRAFT_KEYS.trip, { reportType, category, categoryOther, location, locationCustom, useCustomLocation, notes, nextDates, slackComment, selectedChannels });
  }, [reportType, category, categoryOther, location, locationCustom, useCustomLocation, notes, nextDates, slackComment, selectedChannels]);

  // 入力内容をすべて空にする（クリア。GPS等の一時情報も含めリセット）
  const clearTripForm = () => {
    setReportType('到着'); setCategory('出張'); setCategoryOther('');
    setLocation(''); setLocationCustom(''); setUseCustomLocation(false);
    setNotes(''); setNextDates([]); setSlackComment(''); setSelectedChannels([]);
    setGps(null); setAddress(null); setGpsAttempted(false); setGpsUnavailable(false);
    clearDraft(DRAFT_KEYS.trip);
  };

  const toggleNextDate = (dateStr: string) => {
    setNextDates(prev => prev.includes(dateStr) ? prev.filter(d => d !== dateStr) : [...prev, dateStr]);
  };

  const toggleChannel = (key: string) => {
    setSelectedChannels(prev => prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]);
  };

  const handleCategoryChange = (val: typeof category) => {
    setCategory(val);
    setLocation('');
    setLocationCustom('');
    setUseCustomLocation(false);
  };

  const handleGetGps = () => {
    if (!navigator.geolocation) { setFormError('このブラウザはGPSに対応していません'); return; }
    setGpsLoading(true);
    setGpsAttempted(true);
    setGpsUnavailable(false);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude: lat, longitude: lng, accuracy } = pos.coords;
        setGps({ lat, lng, accuracy });
        try {
          const res = await fetch(
            `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&accept-language=ja`,
            { headers: { 'Accept-Language': 'ja' } }
          );
          const data = await res.json();
          if (data?.address) {
            const a = data.address;
            // 「京都市左京区〇〇町」レベルの簡易住所
            const city = a.city || a.town || a.village || a.county || '';
            const district = a.city_district || a.suburb || '';
            const neighbourhood = a.neighbourhood || a.quarter || a.hamlet || a.road || '';
            const simplified = `${city}${district}${neighbourhood}`.trim() || data.display_name;
            setAddress(simplified);
          }
        } catch { /* 失敗は無視 */ }
        setGpsLoading(false);
      },
      () => {
        setGpsLoading(false);
        // 失敗 → チェックボックスを表示（alertは出さない）
      }
    );
  };

  // プレビュー用：Slackのmrkdwn記号（*）を除去して表示
  const buildSlackPreview = () => buildSlackMessage().replace(/\*/g, '');

  const buildSlackMessage = () => {
    const lines = [
      `📝 *【出張終了報告】*`,
      ``,
      `*報告者：* ${profileName || user.email}`,
      `*区分：* ${category === 'その他' ? `その他（${categoryOther}）` : category}`,
      `*場所：* ${effectiveLocation}`,
    ];
    if (nextDates.length > 0) {
      const formatted = [...nextDates].sort().map(d => formatDate(new Date(d)));
      lines.push(`*次回（次月）予定：* ${formatted.join('、')}`);
    }
    if (slackComment) lines.push(`📢 ${slackComment}`);
    return lines.join('\n');
  };

  const handleSubmitConfirm = () => {
    if (!effectiveLocation.trim()) { setFormError('場所を入力してください'); setErrFields(new Set(['location'])); scrollToFirstError(['location']); return; }
    if (category === 'その他' && !categoryOther.trim()) { setFormError('区分（その他）の内容を入力してください'); setErrFields(new Set(['categoryOther'])); scrollToFirstError(['categoryOther']); return; }
    if (!gps && !gpsUnavailable) { setFormError('📍 現在地を取得してください。取得できない場合は「取得できませんでした」にチェックしてください。'); setErrFields(new Set(['gps'])); scrollToFirstError(['gps']); return; }
    setShowConfirm(true);
  };

  const handleSubmit = async () => {
    setIsSubmitting(true);
    try {
      const report: BusinessTripReport = {
        user_id: user.id,
        report_type: reportType,
        category,
        category_other: category === 'その他' ? categoryOther : undefined,
        location: effectiveLocation,
        notes: notes || undefined,
        latitude: gps?.lat ?? null,
        longitude: gps?.lng ?? null,
        accuracy: gps?.accuracy ?? null,
        address: address || undefined,
        next_dates: nextDates.length > 0 ? nextDates.sort().join(',') : undefined,
      };

      // 通知をタップして該当の報告へ飛べるようにするため、登録した報告のIDを受け取る
      const { data: inserted, error } = await supabase
        .from('business_trip_reports').insert([report]).select('id').single();
      if (error) throw error;

      // 終了報告 かつ チャンネルが1つ以上選択されている場合のみSlack送信
      // サイト通知・メール（ON/OFF制御あり）
      {
        // 到着／終了で別のイベントにする（ON/OFFと宛先を別々に設定できるようにするため）。
        // 以前は終了報告にしか通知が無く、到着報告は何も送っていなかった
        const tripEventKey = reportType === '終了' ? 'trip:report_end' : 'trip:report_arrival';
        const tripVars = { 申請者名: profileName || user.email || '' };
        // 宛先で役職（リーダー・マネージャー・社長）を選んでいれば、その人たちにも届くようにする
        // （以前は applicant しか解決しておらず、チェックしても無視されていた）
        const [tripSite, tripMail] = await Promise.all([
          resolveRoleRecipients(user.id, tripEventKey, 'site'),
          resolveRoleRecipients(user.id, tripEventKey, 'email'),
        ]);
        // 🚨 source_type / reference_id を渡す。これが無いと通知に印が付かず、
        //    App.tsx の classifyNotif がどの分岐にも当たらず「タップしても何も起きない」になる
        //    （実際に社長へ届いていた通知が、まさにこの状態だった）
        await dispatchSiteNotification(
          tripEventKey, tripVars, { applicant: user.id, ...tripSite.ids }, insertNotification,
          'trip_report', inserted?.id,
        );
        await dispatchEmail(tripEventKey, tripVars, { applicant: user.email || '', ...tripMail.emails });
      }
      // Slack: 申請者が画面上でチャンネルを手動選択して送信する仕組みのため、ON/OFFチェック対象外
      if (reportType === '終了' && selectedChannels.length > 0) {
        try {
          await supabase.functions.invoke('send-trip-slack', {
            body: { message: buildSlackMessage(), channels: selectedChannels },
          });
        } catch (e) { console.error('Slack通知エラー:', e); }
      }

      setSubmitted(true);
      setTimeout(() => topRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
      setShowConfirm(false);
      setReportType('到着'); setCategory('出張'); setCategoryOther('');
      setLocation(''); setLocationCustom(''); setUseCustomLocation(false);
      setNotes(''); setNextDates([]); setSlackComment('');
      setSelectedChannels([]); setGps(null); setAddress(null);
      setGpsAttempted(false); setGpsUnavailable(false);
      clearDraft(DRAFT_KEYS.trip); // 送信成功で下書きを消す
    } catch {
      setFormError('送信に失敗しました。もう一度試してください。');
    } finally {
      setIsSubmitting(false);
    }
  };

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '8px 12px', borderRadius: 6,
    border: isDark ? '1px solid #666' : '1px solid #ccc',
    fontSize: 16, boxSizing: 'border-box',
    background: isDark ? '#495057' : 'white',
    color: isDark ? '#fff' : '#333',
  };
  // エラーの欄だけ薄赤にする。入力し直したらその欄のハイライトを消す
  const ef = (key: string): React.CSSProperties => ({ ...inputStyle, ...errorStyle(errFields.has(key), isDark) });
  const clearErr = (key: string) => setErrFields(prev => { if (!prev.has(key)) return prev; const n = new Set(prev); n.delete(key); return n; });

  // ── 履歴タブの絞り込み・グループ化 ──
  const hReporterOptions: [string, string][] = Array.from(
    new Map(historyRows.map(r => [r.user_id, r.profiles?.name || '不明'] as [string, string])).entries()
  ).sort((a, b) => a[1].localeCompare(b[1], 'ja'));
  const hCategoryOptions = Array.from(new Set(historyRows.map(r => r.category).filter(Boolean))).sort();
  const hLocationOptions = Array.from(new Set(historyRows.map(r => r.location).filter(Boolean))).sort();

  const hasFilter = hType !== 'all' || hReporter !== 'all' || hCategory !== 'all' || hLocation !== 'all';
  // 折りたたみの中に隠れている条件の数。隠れた条件で「空に見える」事故を防ぐためボタンに出す
  const hiddenFilterCount = (hCategory !== 'all' ? 1 : 0) + (hLocation !== 'all' ? 1 : 0);
  const clearHistoryFilter = () => { setHType('all'); setHReporter('all'); setHCategory('all'); setHLocation('all'); };

  const filteredHistory = historyRows.filter(r => {
    if (hType !== 'all' && r.report_type !== hType) return false;
    if (hReporter !== 'all' && r.user_id !== hReporter) return false;
    if (hCategory !== 'all' && r.category !== hCategory) return false;
    if (hLocation !== 'all' && r.location !== hLocation) return false;
    return true;
  });

  // 年 → 月 でまとめる（新しい順。historyRows が既に created_at の降順）
  const historyGroups: { year: number; months: { ym: string; month: number; rows: TripHistoryRow[] }[] }[] = [];
  filteredHistory.forEach(r => {
    const d = new Date(r.created_at);
    const y = d.getFullYear();
    const m = d.getMonth() + 1;
    const ym = `${y}-${String(m).padStart(2, '0')}`;
    let yg = historyGroups.find(g => g.year === y);
    if (!yg) { yg = { year: y, months: [] }; historyGroups.push(yg); }
    let mg = yg.months.find(x => x.ym === ym);
    if (!mg) { mg = { ym, month: m, rows: [] }; yg.months.push(mg); }
    mg.rows.push(r);
  });

  // 既定で開く月：今月。ただし今月に報告が無ければ、報告がある一番新しい月を開く
  // （出張は毎日あるものではないので、月初は「何も無い画面」になってしまう）
  const nowForHistory = new Date();
  const currentYm = `${nowForHistory.getFullYear()}-${String(nowForHistory.getMonth() + 1).padStart(2, '0')}`;
  const allYms = historyGroups.flatMap(g => g.months.map(m => m.ym));
  const defaultOpenYm = allYms.includes(currentYm) ? currentYm : allYms[0];
  // 🚨 絞り込み中は全部の月を開く。閉じた月の中に結果が隠れて「0件」に見える事故を防ぐ
  const isMonthOpen = (ym: string) => hasFilter || ym === defaultOpenYm || openMonths.has(ym);
  const toggleMonth = (ym: string) => setOpenMonths(prev => {
    const n = new Set(prev);
    if (n.has(ym)) n.delete(ym); else n.add(ym);
    return n;
  });

  const selectStyle: React.CSSProperties = {
    padding: '6px 10px', borderRadius: 8,
    border: isDark ? '1px solid #6c757d' : '1px solid #ccc',
    background: isDark ? '#495057' : '#fff',
    color: isDark ? '#fff' : '#333', fontSize: 13, cursor: 'pointer', maxWidth: '100%',
  };
  // 択一トグル（CLAUDE.md の配色ルール：未選択=薄い青／選択=濃い青ベタ・枠は両方2px）
  const pill = (active: boolean): React.CSSProperties => ({
    padding: '5px 14px', borderRadius: 16, cursor: 'pointer', fontSize: 13, fontWeight: 'bold',
    background: active ? '#1976d2' : '#e3f2fd',
    border: `2px solid ${active ? '#1565c0' : '#90caf9'}`,
    color: active ? '#fff' : '#1565c0',
  });

  const cardBg = isDark ? '#343a40' : 'white';
  const subText = isDark ? '#adb5bd' : '#6c757d';

  const historyView = (
    <div>
      <div style={{ fontSize: 12, color: subText, margin: '0 0 10px', textAlign: 'center' }}>
        ※ 閲覧専用です。削除は管理画面から行えます。
      </div>

      {/* 絞り込み。よく使う「種別」「報告者」は常時、「区分」「場所」は折りたたみの中 */}
      <div style={{ background: cardBg, borderRadius: 12, padding: '14px 16px', marginBottom: 12, boxShadow: '0 2px 8px rgba(0,0,0,0.1)', color: isDark ? '#fff' : '#333' }}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
          {([['all', 'すべて'], ['到着', '到着'], ['終了', '終了']] as const).map(([v, label]) => (
            <button key={v} onClick={() => setHType(v)} style={pill(hType === v)}>{label}</button>
          ))}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <span style={{ fontSize: 13, color: subText, flexShrink: 0 }}>👤 報告者</span>
          <SearchableSelect value={hReporter} options={hReporterOptions} allLabel="全員" onChange={setHReporter} isDarkMode={isDark} />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <button onClick={() => setShowMoreFilters(o => !o)}
            style={{ fontSize: 12, color: isDark ? '#90caf9' : '#1565c0', background: 'none', border: `1px solid ${isDark ? '#4a5f7a' : '#bbdefb'}`, borderRadius: 14, padding: '4px 12px', cursor: 'pointer' }}>
            🔍 絞り込みを追加{hiddenFilterCount > 0 ? `（${hiddenFilterCount}）` : ''} {showMoreFilters ? '▲' : '▼'}
          </button>
          {hasFilter && (
            <button onClick={clearHistoryFilter}
              style={{ fontSize: 12, color: subText, background: 'none', border: `1px solid ${isDark ? '#555' : '#d5dae0'}`, borderRadius: 14, padding: '4px 12px', cursor: 'pointer' }}>
              絞り込み解除
            </button>
          )}
        </div>

        {showMoreFilters && (
          <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${isDark ? '#555' : '#e9ecef'}`, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 13, color: subText, flexShrink: 0, width: 58 }}>📋 区分</span>
              <select value={hCategory} onChange={e => setHCategory(e.target.value)} style={{ ...selectStyle, flex: 1 }}>
                <option value="all">すべて</option>
                {hCategoryOptions.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 13, color: subText, flexShrink: 0, width: 58 }}>📍 場所</span>
              <select value={hLocation} onChange={e => setHLocation(e.target.value)} style={{ ...selectStyle, flex: 1 }}>
                <option value="all">すべて</option>
                {hLocationOptions.map(l => <option key={l} value={l}>{l}</option>)}
              </select>
            </div>
          </div>
        )}
      </div>

      {historyError ? (
        <div style={{ background: '#f8d7da', border: '1px solid #f5c2c7', borderRadius: 8, padding: '12px 14px', color: '#842029', fontSize: 13 }}>
          {historyError}
          <button onClick={fetchHistory} style={{ marginLeft: 10, background: 'none', border: '1px solid #842029', color: '#842029', borderRadius: 12, padding: '2px 10px', cursor: 'pointer', fontSize: 12 }}>
            再読み込み
          </button>
        </div>
      ) : historyLoading ? (
        <p style={{ textAlign: 'center', color: subText, fontSize: 13 }}>読み込んでいます...</p>
      ) : filteredHistory.length === 0 ? (
        <div style={{ textAlign: 'center', color: subText, fontSize: 13, padding: '24px 0' }}>
          {hasFilter ? (
            <>
              <p style={{ margin: '0 0 10px' }}>この条件に当てはまる報告はありません</p>
              <button onClick={clearHistoryFilter}
                style={{ fontSize: 12, color: isDark ? '#90caf9' : '#1565c0', background: 'none', border: `1px solid ${isDark ? '#4a5f7a' : '#bbdefb'}`, borderRadius: 14, padding: '5px 14px', cursor: 'pointer' }}>
                絞り込みを解除する
              </button>
            </>
          ) : '出張報告はまだありません'}
        </div>
      ) : (
        historyGroups.map(yg => (
          <div key={yg.year} style={{ marginBottom: 12 }}>
            <div style={{ padding: '9px 14px', background: isDark ? '#495057' : '#e9ecef', borderRadius: 6, fontWeight: 'bold', fontSize: 13, color: isDark ? '#fff' : '#333', marginBottom: 6 }}>
              {yg.year}年
            </div>
            {yg.months.map(mg => {
              const open = isMonthOpen(mg.ym);
              return (
                <div key={mg.ym} style={{ marginLeft: 10, marginBottom: 6 }}>
                  <div onClick={() => toggleMonth(mg.ym)}
                    style={{ padding: '8px 12px', background: isDark ? '#3d4349' : '#f8f9fa', borderRadius: 4, cursor: 'pointer', color: isDark ? '#fff' : '#333', fontSize: 13, display: 'flex', justifyContent: 'space-between', marginBottom: open ? 6 : 0 }}>
                    <span>{mg.month}月（{mg.rows.length}件）</span>
                    <span style={{ color: subText, fontSize: 12 }}>{open ? '▲ 閉じる' : '▶ 開く'}</span>
                  </div>
                  {open && mg.rows.map(r => {
                    const isHit = highlightId === r.id;
                    const mapUrl = tripMapUrl(r.latitude, r.longitude);
                    const nextD = formatTripNextDates(r.next_dates);
                    return (
                      <div key={r.id}
                        ref={el => { if (el && isHit) focusRef.current = el; }}
                        style={{
                          border: `1px solid ${isHit ? '#f59e0b' : (isDark ? '#495057' : '#dee2e6')}`,
                          borderRadius: 8, padding: '10px 12px', marginBottom: 6,
                          background: isHit ? (isDark ? '#4a4020' : '#fff9c4') : cardBg,
                          transition: 'background 0.6s',
                        }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}>
                          <span style={{ background: tripTypeColor(r.report_type), color: '#fff', fontSize: 10, fontWeight: 'bold', padding: '2px 8px', borderRadius: 4, flexShrink: 0 }}>
                            {r.report_type}
                          </span>
                          <span style={{ fontSize: 13, fontWeight: 'bold', color: isDark ? '#fff' : '#333' }}>
                            {r.profiles?.name || '不明'}
                          </span>
                          <span style={{ fontSize: 11, color: subText, marginLeft: 'auto', flexShrink: 0 }}>
                            {formatTripDateTime(r.created_at)}
                          </span>
                        </div>
                        <p style={{ fontSize: 12, color: isDark ? '#fff' : '#333', margin: '0 0 3px' }}>
                          {tripCategoryLabel(r)}／{r.location}
                        </p>
                        {mapUrl && (
                          <p style={{ fontSize: 11, margin: '0 0 3px' }}>
                            <a href={mapUrl} target="_blank" rel="noreferrer" style={{ color: isDark ? '#64b5f6' : '#17a2b8', wordBreak: 'break-all' }}>
                              📍 {r.address || '地図を開く'}
                            </a>
                          </p>
                        )}
                        {nextD && <p style={{ fontSize: 11, color: subText, margin: '0 0 3px' }}>次回予定：{nextD}</p>}
                        {r.notes && <p style={{ fontSize: 11, color: subText, margin: 0 }}>連絡事項：{r.notes}</p>}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        ))
      )}
    </div>
  );

  return (
    <div style={{ maxWidth: 600, margin: '0 auto', padding: '16px 16px 40px' }}>
      {formError && (
        <div style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', zIndex: 9999, background: '#fff5f5', border: '1px solid #f5b5b5', borderRadius: 12, padding: '16px 22px', boxShadow: '0 4px 20px rgba(0,0,0,0.15)', display: 'flex', alignItems: 'center', gap: 10, maxWidth: 320 }}>
          <span style={{ fontSize: 18, flexShrink: 0 }}>⚠️</span>
          <span style={{ fontSize: 14, fontWeight: 'bold', color: '#dc3545' }}>{formError}</span>
          <button type="button" onClick={() => setFormError(null)} style={{ marginLeft: 'auto', background: 'none', border: 'none', color: '#dc3545', cursor: 'pointer', fontSize: 16, padding: '0 4px', flexShrink: 0 }}>✕</button>
        </div>
      )}
      <div ref={topRef} />
      <h2 style={{ textAlign: 'center', margin: '12px 0 16px', fontSize: 20, fontWeight: 'bold', color: isDark ? '#fff' : '#333' }}>📍 出張報告</h2>

      {/* このページの説明 */}
      <div style={{
        background: '#fff3cd',
        border: '1px solid #ffe0a3',
        borderRadius: 8, padding: '12px 14px', marginBottom: 16, textAlign: 'left',
        position: 'relative', // 右上のFAQボタンの基準
      }}>
        <HelpLinkButton category="出張報告" />
        <p style={{ fontSize: 13, fontWeight: 'bold', color: '#856404', textAlign: 'center', margin: '0 0 10px' }}>【全スタッフ】</p>
        {[
          '出張・園指導・イベント・試合などの勤怠を報告できます',
          '到着時と終了時に送信してください',
        ].map((text, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, margin: '0 0 6px' }}>
            <span style={{ flexShrink: 0, width: 22, height: 22, borderRadius: '50%', background: '#4a90d9', color: '#fff', fontSize: 13, fontWeight: 'bold', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>{i + 1}</span>
            <span style={{ fontSize: 14, fontWeight: 'bold', color: '#664d03', lineHeight: '22px' }}>{text}</span>
          </div>
        ))}
      </div>

      {submitted && (
        <BannerSuccess message="報告を送信しました！" onClose={() => setSubmitted(false)} />
      )}

      {/* タブ：上段＝報告する（到着／終了）、下段＝見る（履歴）。
          🚨 白いカードの外に置く。カードの中（「報告種別」ラベルの直下）に履歴を混ぜると
             「報告種別＝履歴」という意味の通らない構造になり、さらに隣のクリアボタンが
             履歴表示中も残って、押すと入力途中の下書きが消える事故になる。
             他ページ（休暇・勤務変更・備品）も説明枠の下がタブの位置で揃えてある */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 0, borderRadius: 8, overflow: 'hidden', border: `1px solid ${isDark ? '#6c757d' : '#dee2e6'}`, marginBottom: canHistory ? 8 : 0 }}>
          {(['到着', '終了'] as const).map((type) => {
            const active = tab === 'form' && reportType === type;
            return (
              <button
                key={type}
                onClick={() => { setReportType(type); setTab('form'); }}
                style={{
                  flex: 1, padding: '10px 0', border: 'none', cursor: 'pointer', fontSize: 15, fontWeight: 'bold',
                  background: active ? '#28a745' : (isDark ? '#495057' : '#f8f9fa'),
                  color: active ? 'white' : (isDark ? '#fff' : '#333'),
                }}
              >
                {type}
              </button>
            );
          })}
        </div>
        {canHistory && (
          <button
            onClick={() => setTab('history')}
            style={{
              width: '100%', padding: '9px 0', borderRadius: 8, cursor: 'pointer', fontSize: 14, fontWeight: 'bold',
              background: tab === 'history' ? '#1976d2' : '#e3f2fd',
              border: `2px solid ${tab === 'history' ? '#1565c0' : '#90caf9'}`,
              color: tab === 'history' ? '#fff' : '#1565c0',
            }}
          >
            📋 履歴
          </button>
        )}
      </div>

      {tab === 'history' ? historyView : (
      <div style={{ background: isDark ? '#343a40' : 'white', borderRadius: 12, padding: 24, boxShadow: '0 2px 8px rgba(0,0,0,0.1)', color: isDark ? '#fff' : '#333' }}>

        {/* 入力内容のクリア（フォームの操作なので履歴タブには出さない） */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
          <button type="button" onClick={clearTripForm}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: isDark ? '#adb5bd' : '#8a939c', background: 'none', border: `1px solid ${isDark ? '#555' : '#d5dae0'}`, borderRadius: 14, padding: '4px 12px', cursor: 'pointer' }}>
            クリア
          </button>
        </div>

        {/* 到着報告の注意事項 */}
        {reportType === '到着' && (
          <div style={{
            background: isDark ? '#2c3e50' : '#e8f4fd',
            border: `1px solid ${isDark ? '#3d5a73' : '#bee5eb'}`,
            borderRadius: 8, padding: '12px 14px', marginBottom: 20, textAlign: 'left',
          }}>
            <p style={{ fontSize: 13, fontWeight: 'bold', color: isDark ? '#fff' : '#1a4a5a', marginBottom: 8, marginTop: 0 }}>【注意事項】</p>
            <ol style={{ margin: 0, paddingLeft: 20, fontSize: 12, color: isDark ? '#d0dde8' : '#2c5f6e', lineHeight: 1.8 }}>
              <li>現地・集合場所に到着したら、区分・場所・GPS位置情報を選択して到着報告をしてください。</li>
              <li>GPS位置情報は電波状況などで取得できないことがありますが、その場合は「取得できませんでした」を選択すれば送信できます。</li>
            </ol>
          </div>
        )}

        {/* 終了報告の注意事項 */}
        {reportType === '終了' && (
          <div style={{
            background: isDark ? '#2c3e50' : '#e8f4fd',
            border: `1px solid ${isDark ? '#3d5a73' : '#bee5eb'}`,
            borderRadius: 8, padding: '12px 14px', marginBottom: 20, textAlign: 'left',
          }}>
            <p style={{ fontSize: 13, fontWeight: 'bold', color: isDark ? '#fff' : '#1a4a5a', marginBottom: 8, marginTop: 0 }}>【注意事項】</p>
            <ol style={{ margin: 0, paddingLeft: 20, fontSize: 12, color: isDark ? '#d0dde8' : '#2c5f6e', lineHeight: 1.8 }}>
              <li>終了したら、区分・場所・GPS位置情報を選択して終了報告をしてください。</li>
            </ol>
            <div style={{ marginTop: 10, fontSize: 12, color: isDark ? '#d0dde8' : '#2c5f6e', lineHeight: 1.8 }}>
              <div>▷ 担当者（複数の場合は責任者）の報告</div>
              <div style={{ paddingLeft: 16 }}>→ 終了報告時にSlackへ転載を選択してください。</div>
              <div style={{ marginTop: 6 }}>▷ 担当者（責任者を除く）の報告</div>
              <div style={{ paddingLeft: 16 }}>→ 終了報告のみで、Slackの選択は不要です。</div>
            </div>
          </div>
        )}

        {/* 区分 */}
        <div style={{ marginBottom: 20 }}>
          <label style={{ display: 'block', fontWeight: 'bold', marginBottom: 8 }}>区分</label>
          <select value={category} onChange={(e) => handleCategoryChange(e.target.value as any)} style={inputStyle}>
            {categories.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          {category === 'その他' && (
            <input data-err-field="categoryOther" type="text" placeholder="内容を入力" value={categoryOther}
              onChange={(e) => { setCategoryOther(e.target.value); clearErr('categoryOther'); }}
              style={{ ...ef('categoryOther'), marginTop: 8 }} />
          )}
        </div>

        {/* 場所 */}
        <div style={{ marginBottom: 20 }}>
          <label style={{ display: 'block', fontWeight: 'bold', marginBottom: 8 }}>
            場所 <span style={{ color: 'red' }}>*</span>
          </label>

          {presets.length > 0 && !useCustomLocation ? (
            <>
              {/* プリセットボタン */}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
                {presets.map((p) => (
                  <button key={p} onClick={() => setLocation(p)}
                    style={{
                      padding: '8px 14px', borderRadius: 20, fontSize: 14, cursor: 'pointer',
                      border: location === p
                        ? '2px solid #007bff'
                        : isDark ? '1px solid #666' : '1px solid #ccc',
                      background: location === p ? '#007bff' : isDark ? '#495057' : '#f8f9fa',
                      color: location === p ? '#fff' : isDark ? '#fff' : '#333',
                      fontWeight: location === p ? 'bold' : 'normal',
                    }}>
                    {p}
                  </button>
                ))}
              </div>
              <button onClick={() => setUseCustomLocation(true)}
                style={{ background: 'none', border: 'none', color: isDark ? '#80c8ff' : '#007bff', cursor: 'pointer', fontSize: 13, padding: 0, textDecoration: 'underline' }}>
                ＋ 上記以外の場所を入力
              </button>
            </>
          ) : (
            <>
              <input data-err-field="location" type="text" placeholder="出張先・園名など" value={useCustomLocation ? locationCustom : location}
                onChange={(e) => { if (useCustomLocation) setLocationCustom(e.target.value); else setLocation(e.target.value); clearErr('location'); }}
                style={ef('location')} autoFocus={useCustomLocation} />
              {presets.length > 0 && (
                <button onClick={() => { setUseCustomLocation(false); setLocationCustom(''); }}
                  style={{ background: 'none', border: 'none', color: isDark ? '#80c8ff' : '#007bff', cursor: 'pointer', fontSize: 13, padding: 0, marginTop: 4, textDecoration: 'underline' }}>
                  ← リストから選ぶ
                </button>
              )}
            </>
          )}
        </div>

        {/* 経理担当者への連絡事項 */}
        <div style={{ marginBottom: 20 }}>
          <label style={{ display: 'block', fontWeight: 'bold', marginBottom: 8 }}>経理担当者への連絡事項</label>
          <textarea placeholder="連絡事項があれば入力してください" value={notes}
            onChange={(e) => setNotes(e.target.value)} rows={3}
            style={{ ...inputStyle, resize: 'vertical' }} />
        </div>

        {/* GPS */}
        <div style={{ marginBottom: 24 }}>
          <label style={{ display: 'block', fontWeight: 'bold', marginBottom: 8 }}>
            GPS位置情報 <span style={{ color: '#dc3545', fontSize: 13 }}>*</span>
          </label>
          {gps ? (
            <div style={{ background: isDark ? '#1d3a1d' : '#e8f5e9', padding: '10px 14px', borderRadius: 6, fontSize: 14, color: isDark ? '#adf5ad' : '#155724' }}>
              ✅ 取得済み
            </div>
          ) : (
            <div>
              <button onClick={handleGetGps} disabled={gpsLoading}
                style={{ padding: '8px 16px', borderRadius: 6, border: '1px solid #28a745', background: '#28a745', color: 'white', cursor: 'pointer', fontSize: 15 }}>
                {gpsLoading ? '取得中...' : '📍 現在地を取得'}
              </button>
              <div style={{ marginTop: 6, fontSize: 12, color: isDark ? '#adb5bd' : '#888', lineHeight: 1.6, textAlign: 'left' }}>
                <div>・許可を求めるダイアログが出たら「今回のみ」または「許可」を選んでください</div>
                <div>・位置情報はボタンを押したときのみ取得します（常時追跡はしません）</div>
              </div>
              {/* GPS取得試みたが失敗した場合のみチェックボックスを表示 */}
              {gpsAttempted && !gpsLoading && (
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, padding: '10px 12px', background: isDark ? '#3a2800' : '#fff9e6', border: `1px solid ${isDark ? '#5a4400' : '#ffe499'}`, borderRadius: 6, cursor: 'pointer' }}>
                  <input type="checkbox" checked={gpsUnavailable} onChange={(e) => setGpsUnavailable(e.target.checked)} style={{ width: 18, height: 18, accentColor: '#fd7e14' }} />
                  <span style={{ fontSize: 14, color: isDark ? '#ffe082' : '#b8860b' }}>取得できませんでした（チェックして送信）</span>
                </label>
              )}
            </div>
          )}
        </div>

        {/* 次回（次月）予定（終了 かつ 出張・園指導のみ） */}
        {showNextDates && <hr style={{ border: 'none', borderTop: isDark ? '1px solid #555' : '1px solid #dee2e6', margin: '4px 0 20px' }} />}
        {showNextDates && (
          <div style={{ marginBottom: 20 }}>
            <label style={{ display: 'block', fontWeight: 'bold', marginBottom: 8 }}>
              次回（次月）予定 <span style={{ fontWeight: 'normal', fontSize: 13, color: isDark ? '#adb5bd' : '#6c757d' }}>（任意・複数選択可）</span>
            </label>
            <div style={{ fontSize: 12, color: isDark ? '#adb5bd' : '#6c757d', marginBottom: 10, lineHeight: 1.6 }}>
              ※当日決まった予定がある場合は選択してください。<br />
              あわせて、Googleカレンダーにも入力してください。
            </div>
            <div style={{ background: isDark ? '#2c3136' : '#f8f9fa', borderRadius: 8, padding: 12, border: isDark ? '1px solid #555' : '1px solid #dee2e6' }}>
              <DateCalendar selected={nextDates} onToggle={toggleNextDate} isDark={isDark} />
              {nextDates.length > 0 && (
                <div style={{ marginTop: 10, padding: '8px 10px', background: isDark ? '#1a3a1d' : '#e8f5e9', borderRadius: 6, fontSize: 13, color: isDark ? '#adf5ad' : '#155724' }}>
                  📅 選択中: {[...nextDates].sort().map(d => formatDate(new Date(d))).join('、')}
                </div>
              )}
            </div>
          </div>
        )}

        {/* 終了報告時のみ: Slack送信エリア */}
        {reportType === '終了' && (
          <div style={{ borderTop: isDark ? '1px solid #555' : '1px solid #dee2e6', paddingTop: 20 }}>
            <div style={{ fontWeight: 'bold', marginBottom: 4, fontSize: 15 }}>📢 Slack送信先チャンネル</div>
            <div style={{ fontSize: 12, color: isDark ? '#adb5bd' : '#6c757d', marginBottom: 8 }}>
              （選択しない場合、Slackには送信されません。）
            </div>
            <div style={{ fontSize: 13, lineHeight: 1.7, marginBottom: 12, padding: '10px 12px', borderRadius: 8, background: isDark ? '#2c3136' : '#fff8e1', border: isDark ? '1px solid #555' : '1px solid #ffe082', color: isDark ? '#e9ecef' : '#5d4037' }}>
              <div style={{ fontWeight: 'bold', marginBottom: 4 }}>●終了報告</div>
              責任者の方のみ、Slack送信をしてください。<br />
              <br />
              【送信先】<br />
              出張：出張後に向かう校<br />
              直帰・イベント終了時：所属チーム（こどもの場合は本校）<br />
              <span style={{ color: isDark ? '#adb5bd' : '#6c757d' }}>※責任者以外の方は、Slack送信不要。終了報告のみ。</span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16 }}>
              {SLACK_CHANNELS.map((ch) => (
                <label key={ch.key} style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontSize: 15 }}>
                  <input type="checkbox" checked={selectedChannels.includes(ch.key)}
                    onChange={() => toggleChannel(ch.key)}
                    style={{ width: 20, height: 20, cursor: 'pointer' }} />
                  #{ch.label}
                </label>
              ))}
            </div>

            {/* コメント */}
            <div style={{ marginBottom: 16 }}>
              <label style={{ display: 'block', fontWeight: 'bold', marginBottom: 6, fontSize: 14, color: isDark ? '#adb5bd' : '#6c757d' }}>
                💬 コメント <span style={{ fontWeight: 'normal' }}>（任意）</span>
              </label>
              <textarea placeholder="Slackに追加で送るコメントがあれば入力"
                value={slackComment} onChange={(e) => setSlackComment(e.target.value)}
                rows={2} style={{ ...inputStyle, resize: 'vertical' }} />
            </div>

            {/* 送信プレビュー */}
            {selectedChannels.length > 0 && (
              <div style={{ marginBottom: 8 }}>
                <div style={{ fontWeight: 'bold', marginBottom: 6, fontSize: 14, color: isDark ? '#adb5bd' : '#6c757d' }}>
                  📋 送信イメージ
                </div>
                <div style={{
                  background: isDark ? '#1a1a2e' : '#f0f4ff',
                  border: isDark ? '1px solid #444' : '1px solid #c8d8ff',
                  borderRadius: 8, padding: '12px 14px',
                  fontSize: 13, whiteSpace: 'pre-wrap',
                  color: isDark ? '#ddd' : '#333', fontFamily: 'monospace', lineHeight: 1.6,
                }}>
                  {buildSlackPreview()}
                </div>
                <div style={{ fontSize: 12, color: isDark ? '#888' : '#999', marginTop: 4 }}>
                  送信先: {selectedChannels.map(k => '#' + (SLACK_CHANNELS.find(c => c.key === k)?.label ?? k)).join('、')}
                </div>
              </div>
            )}
          </div>
        )}

        {/* 送信ボタン */}
        <button onClick={handleSubmitConfirm}
          style={{ width: '100%', padding: '12px', borderRadius: 8, background: '#007bff', color: 'white', border: 'none', fontSize: 16, fontWeight: 'bold', cursor: 'pointer', marginTop: 20 }}>
          送信
        </button>
      </div>
      )}

      {/* 確認モーダル */}
      {showConfirm && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000
        }}>
          <div style={{ background: isDark ? '#343a40' : 'white', borderRadius: 12, padding: 28, maxWidth: 400, width: '90%', maxHeight: '80vh', overflowY: 'auto' }}>
            <h3 style={{ marginTop: 0, color: isDark ? '#fff' : '#333' }}>📋 送信内容の確認</h3>
            <table style={{ width: '100%', borderCollapse: 'collapse', color: isDark ? '#fff' : '#333' }}>
              <tbody>
                {[
                  ['報告種別', reportType],
                  ['区分', category === 'その他' ? `その他（${categoryOther}）` : category],
                  ['場所', effectiveLocation],
                  ['経理連絡事項', notes || 'なし'],
                  ...(nextDates.length > 0 ? [['次回（次月）予定', [...nextDates].sort().map(d => formatDate(new Date(d))).join('、')]] : []),
                  ['GPS', gps ? `取得済み（精度約${Math.round(gps.accuracy)}m）` : '未取得'],
                ].map(([label, value]) => (
                  <tr key={label}>
                    <td style={{ padding: '6px 8px', fontWeight: 'bold', whiteSpace: 'nowrap', color: '#aaa', verticalAlign: 'top' }}>{label}</td>
                    <td style={{ padding: '6px 8px', wordBreak: 'break-all' }}>{value}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            {reportType === '終了' && selectedChannels.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <div style={{ fontWeight: 'bold', fontSize: 13, color: '#aaa', marginBottom: 4 }}>Slack送信イメージ</div>
                <div style={{
                  background: isDark ? '#1a1a2e' : '#f0f4ff',
                  border: isDark ? '1px solid #444' : '1px solid #c8d8ff',
                  borderRadius: 8, padding: '10px 12px',
                  fontSize: 12, whiteSpace: 'pre-wrap',
                  color: isDark ? '#ddd' : '#333', fontFamily: 'monospace', lineHeight: 1.6,
                }}>
                  {buildSlackPreview()}
                </div>
                <div style={{ fontSize: 12, color: isDark ? '#888' : '#999', marginTop: 4 }}>
                  送信先: {selectedChannels.map(k => '#' + (SLACK_CHANNELS.find(c => c.key === k)?.label ?? k)).join('、')}
                </div>
              </div>
            )}
            {reportType === '終了' && selectedChannels.length === 0 && (
              <div style={{ marginTop: 12, fontSize: 13, color: isDark ? '#adb5bd' : '#6c757d' }}>
                ※ チャンネル未選択のためSlack送信なし
              </div>
            )}

            <div style={{ display: 'flex', gap: 12, marginTop: 20 }}>
              <button onClick={() => setShowConfirm(false)}
                style={{ flex: 1, padding: '10px', borderRadius: 6, border: isDark ? '1px solid #666' : '1px solid #ccc', background: isDark ? '#444' : '#f8f9fa', color: isDark ? '#fff' : '#333', cursor: 'pointer', fontSize: 15 }}>
                戻る
              </button>
              <button onClick={handleSubmit} disabled={isSubmitting}
                style={{ flex: 1, padding: '10px', borderRadius: 6, border: 'none', background: isSubmitting ? '#6c757d' : '#007bff', color: 'white', cursor: isSubmitting ? 'not-allowed' : 'pointer', fontSize: 15, fontWeight: 'bold' }}>
                {isSubmitting ? '送信中...' : '送信する'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default BusinessTripReportForm;

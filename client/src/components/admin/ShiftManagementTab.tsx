import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useAdminPanel } from './AdminPanelContext';
import { useRoles } from '../../hooks/useRoles';
import { rankOf } from '../../lib/roleAttrs';
import { todayJstStr } from '../../lib/breakCalc';
import { isShiftTarget } from '../../lib/shiftExcelImport';
import {
  AREA_COLORS, ROSTER_DAY_LABEL, ROSTER_EXTRA, ROSTER_WEEK,
  dayEquals, deriveFields, minText, placeSteps, prevDate, rowOnDate, rowToDay, shortSchool, timeText, validateDay,
  type RosterDay, type RosterDayKind, type RosterSegment, type WorkArea,
} from '../../lib/shiftRoster';
import {
  addWorkArea, loadPersonHistory, loadRosterData, loadRosterToken, saveRoster, updateWorkArea,
  type RosterData, type RosterPatternRow, type SavePerson,
} from '../../lib/shiftRosterApi';
import { buildRosterPrintHtml, openRosterPrint, type PrintPerson } from '../../lib/shiftRosterPrint';
import ShiftExcelLoader, { type LoadedPerson } from './ShiftExcelLoader';
import StudySessionsPanel from './StudySessionsPanel';
import { shortNameMap } from '../../lib/staffName';
import { dayIssue, studyLabel, versionsOnDate, type StudyVersion } from '../../lib/studySessions';
import { loadStudyData, type StudyData } from '../../lib/studySessionsApi';
import CleaningRosterPanel from './CleaningRosterPanel';
import KidsShiftPanel from './KidsShiftPanel';
import { cellIssues, cellValue, cellVersionOn, rosterCleaningLines, rowPlaceLabel } from '../../lib/cleaningRoster';
import { loadCleaningData, type CleaningData } from '../../lib/cleaningRosterApi';
import { loadKidsData, type KidsData } from '../../lib/kidsShiftApi';
import { cellVersionOn as kidsVersionOn, kidsCellIssues } from '../../lib/kidsShift';

// シフト管理（2026-09-15）。設計・決めたことは docs/計画-管理画面の開放.md の 5-1〜5-3。
// ・表は月〜日。名前を押すと、その人の月〜日（祝・出・過去の履歴）が表の中に開く（C）
// ・1日の中は「時間・校・部門」の区切り。部門の空欄はメインの部門
// ・赤字は「適用開始日の前日に効いている版」と比べて変わったマス
// ・保存は shift_patterns_save 1回。変えた人・曜日だけ新しい版／先の版は残す／今日より前は確認つき／
//   開いたあとに別の人が保存していたら断る（読み込み直す）
// 🚨 表で絞っていても、保存は未保存の変更がある全員（確認に名前を出す）

interface Draft {
  days: Partial<Record<RosterDayKind, RosterDay>>;
  personNote?: string;
  mainAreaId?: string;
}

const ALL_DAYS: RosterDayKind[] = [...ROSTER_WEEK, ...ROSTER_EXTRA];
const COLOR_KEYS = Object.keys(AREA_COLORS);

const ShiftManagementTab: React.FC = () => {
  const { isDarkMode, isAdminUser } = useAdminPanel();
  const roles = useRoles();

  const text = isDarkMode ? '#f8f9fa' : '#212529';
  const subText = isDarkMode ? '#adb5bd' : '#6c757d';
  const borderColor = isDarkMode ? '#495057' : '#dee2e6';
  const cardBg = isDarkMode ? '#343a40' : '#fff';
  const innerBg = isDarkMode ? '#2b3035' : '#f8f9fa';
  const red = isDarkMode ? '#ff8a80' : '#c62828';
  const inputStyle: React.CSSProperties = { padding: '5px 7px', borderRadius: 6, border: `1px solid ${borderColor}`, background: isDarkMode ? '#495057' : '#fff', color: text, fontSize: 13 };
  const toggle = (on: boolean): React.CSSProperties => ({
    padding: '6px 12px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 12.5,
    fontWeight: on ? 'bold' : 'normal', background: on ? '#1976d2' : (isDarkMode ? '#495057' : '#e9ecef'), color: on ? '#fff' : text,
  });

  const [applyFrom, setApplyFrom] = useState(() => todayJstStr());
  const [includePartTime, setIncludePartTime] = useState(false);
  const [areaFilter, setAreaFilter] = useState<string>('all');
  const [onlyDraft, setOnlyDraft] = useState(false);
  const [data, setData] = useState<RosterData | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const [loading, setLoading] = useState(true);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [openId, setOpenId] = useState<string | null>(null);
  const [history, setHistory] = useState<Record<string, RosterPatternRow[] | 'error'>>({});
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState('');
  const [saveMsg, setSaveMsg] = useState('');
  const [stale, setStale] = useState(false);
  const [pdfOpen, setPdfOpen] = useState(false);
  const [pdfLayout, setPdfLayout] = useState<'A' | 'B'>('A');
  const [pdfWho, setPdfWho] = useState<'all' | 'changed'>('all');
  const [pdfRed, setPdfRed] = useState(true);
  const [pdfErr, setPdfErr] = useState('');
  const [areasOpen, setAreasOpen] = useState(false);
  const [areaErr, setAreaErr] = useState('');
  const [newArea, setNewArea] = useState({ name: '', short_name: '', color: 'gray' });
  const [view, setView] = useState<'roster' | 'study' | 'cleaning' | 'kids'>('roster');
  // 🚨 いちど開いた画面は画面から外さずに隠すだけにする（外すと未保存の入力が消えるため・2026-09-16 レビュー U1）
  const [visited, setVisited] = useState<Set<string>>(new Set(['roster']));
  const goView = (v: 'roster' | 'study' | 'cleaning' | 'kids') => {
    setVisited(prev => new Set([...prev, v]));
    setView(v);
  };
  const [cleaning, setCleaning] = useState<CleaningData | null>(null);
  // ⑤ こどもシフト表。🚨 勤務表の保存の確認に「◯件が時間外になります」を出すために読む（2026-09-22）
  const [kids, setKids] = useState<KidsData | null>(null);
  const [cleaningErr, setCleaningErr] = useState('');
  const [kidsErr, setKidsErr] = useState('');
  const [study, setStudy] = useState<StudyData | null>(null);
  const [studyErr, setStudyErr] = useState('');
  const [pdfStudyWarn, setPdfStudyWarn] = useState(false);

  // 勉強会（③）：勤務表の欄・保存の確認・PDF に使う。🚨 読めなくても勤務表は使えるようにする（理由だけ出す）
  const loadStudy = useCallback(async () => {
    const [{ data: s, error }, c, kd] = await Promise.all([
      loadStudyData(prevDate(applyFrom)), loadCleaningData(prevDate(applyFrom)), loadKidsData(prevDate(applyFrom)),
    ]);
    setStudyErr(error ? `勉強会を読み込めませんでした（勤務表の欄に勉強会が出ていません）：${error}` : '');
    if (s) setStudy(s);
    // ④ 掃除担当表：勤務表の欄・保存の確認・PDF A の掃除の列に使う。🚨 読めなくても勤務表は使える
    setCleaningErr(c.error ? `掃除担当表を読み込めませんでした（勤務表の欄に掃除が出ていません）：${c.error}` : '');
    if (c.data) setCleaning(c.data);
    // ⑤ こどもシフト表：保存の確認の「◯件が時間外になります」に使う。
    // 🚨 読めなくても勤務表は使える。ただし黙って0件にせず、確かめられない旨を出す
    setKidsErr(kd.error ? `こどもシフト表を読み込めませんでした（保存の確認に出ません）：${kd.error}` : '');
    if (kd.data) setKids(kd.data);
  }, [applyFrom]);

  // 読み込み：適用開始日の前日（赤字の比べ先）に効いている行と、それより先の行
  const load = useCallback(async (keepDrafts: boolean) => {
    setLoading(true); setLoadErr('');
    const [{ data: d, error }] = await Promise.all([loadRosterData(prevDate(applyFrom)), loadStudy()]);
    if (error || !d) { setLoadErr(error ?? '読み込めませんでした'); setLoading(false); return; }
    const t = await loadRosterToken(d.staff.map(s => s.id));
    if (t.error || t.token == null) { setLoadErr(`保存の準備ができませんでした：${t.error ?? ''}`); setLoading(false); return; }
    setData(d); setToken(t.token); setStale(false);
    if (!keepDrafts) setDrafts({});
    setLoading(false);
  }, [applyFrom, loadStudy]);

  useEffect(() => { void load(true); }, [load]);

  const shortNames = useMemo(() => shortNameMap(study?.staff ?? [], cleaning?.labels ?? new Map()), [study, cleaning]);
  const cleaningRows = useMemo(() => (cleaning?.rows ?? []).filter(r => r.active).sort((a, b) => a.sort_order - b.sort_order), [cleaning]);
  /** 勤務表の「掃除」の欄（その人・その曜日・date に効いている掃除担当表） */
  const cleaningFor = (userId: string, k: RosterDayKind, date: string): string[] =>
    cleaning ? rosterCleaningLines(cleaningRows, rowId => cellValue(cellVersionOn(cleaning.cells, rowId, k, date)), userId) : [];
  /** その人・その曜日に date で効いている勉強会 */
  const studiesFor = (userId: string, k: RosterDayKind, date: string): StudyVersion[] =>
    versionsOnDate(study?.versions ?? [], date).filter(v => v.day_kind === k && v.members.includes(userId))
      .sort((a, b) => a.start_time.localeCompare(b.start_time));

  const rowsByUser = useMemo(() => {
    const m = new Map<string, RosterPatternRow[]>();
    for (const r of data?.patterns ?? []) m.set(r.user_id, [...(m.get(r.user_id) ?? []), r]);
    return m;
  }, [data]);

  const savedDay = useCallback((userId: string, k: RosterDayKind, date: string): RosterDay => {
    const rows = (rowsByUser.get(userId) ?? []).filter(r => r.day_kind === k);
    return rowToDay(rowOnDate(rows, date));
  }, [rowsByUser]);
  const hasAnyRow = useCallback((userId: string) => (rowsByUser.get(userId) ?? []).some(r => r.valid_to === null || r.valid_to >= applyFrom), [rowsByUser, applyFrom]);
  const savedNote = useCallback((userId: string) => rowOnDate((data?.notes ?? []).filter(n => n.user_id === userId), applyFrom)?.note ?? '', [data, applyFrom]);

  const shownDay = (userId: string, k: RosterDayKind): RosterDay => drafts[userId]?.days[k] ?? savedDay(userId, k, applyFrom);
  const baseDay = (userId: string, k: RosterDayKind): RosterDay => savedDay(userId, k, prevDate(applyFrom));
  const mainAreaOf = (userId: string): string | null => drafts[userId]?.mainAreaId ?? data?.mainAreas[userId] ?? null;
  const noteOf = (userId: string): string => drafts[userId]?.personNote ?? savedNote(userId);

  /** 保存したら変わる曜日（適用開始日に効いている値と違う） */
  const draftChangedDays = (userId: string): RosterDayKind[] => {
    const d = drafts[userId];
    if (!d) return [];
    return ALL_DAYS.filter(k => d.days[k] && !dayEquals(d.days[k]!, savedDay(userId, k, applyFrom))
      && !(d.days[k]!.segments.length === 0 && !d.days[k]!.note.trim() && !hasAnyRow(userId)));
  };
  const draftChanged = (userId: string): boolean => {
    const d = drafts[userId];
    if (!d) return false;
    return draftChangedDays(userId).length > 0
      || (d.personNote !== undefined && d.personNote.trim() !== savedNote(userId).trim())
      || (d.mainAreaId !== undefined && d.mainAreaId !== (data?.mainAreas[userId] ?? ''));
  };
  /** 赤字にする曜日（前日の版と違う） */
  const redDays = (userId: string): RosterDayKind[] => ROSTER_WEEK.filter(k => !dayEquals(shownDay(userId, k), baseDay(userId, k)));

  const areas = data?.areas ?? [];
  const activeAreas = areas.filter(a => a.active);
  const areaSort = (id: string | null) => areas.find(a => a.id === id)?.sort_order ?? 999;

  const scoped = useMemo(() => {
    if (!data) return [];
    return data.staff
      .filter(s => isShiftTarget(s.employment_type, includePartTime))
      .sort((a, b) => areaSort(mainAreaOf(a.id)) - areaSort(mainAreaOf(b.id))
        || (rankOf(roles, a.role_title) ?? 99) - (rankOf(roles, b.role_title) ?? 99)
        || a.name.localeCompare(b.name, 'ja'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, includePartTime, roles, drafts]);

  const draftIds = Object.keys(drafts).filter(id => draftChanged(id));
  const visible = scoped.filter(s => (areaFilter === 'all' || mainAreaOf(s.id) === areaFilter) && (!onlyDraft || draftIds.includes(s.id)));

  // ─── 入力 ───
  const editDay = (userId: string, k: RosterDayKind, next: RosterDay) => {
    setSaveMsg(''); setSaveErr('');
    setDrafts(prev => ({ ...prev, [userId]: { ...(prev[userId] ?? { days: {} }), days: { ...(prev[userId]?.days ?? {}), [k]: next } } }));
  };
  const revertDay = (userId: string, k: RosterDayKind) => {
    setDrafts(prev => {
      const d = prev[userId];
      if (!d) return prev;
      const days = { ...d.days };
      delete days[k];
      return { ...prev, [userId]: { ...d, days } };
    });
  };
  const setPersonField = (userId: string, patch: Partial<Omit<Draft, 'days'>>) => {
    setSaveMsg(''); setSaveErr('');
    setDrafts(prev => ({ ...prev, [userId]: { ...(prev[userId] ?? { days: {} }), ...patch } }));
  };

  const openPerson = async (userId: string) => {
    setOpenId(prev => (prev === userId ? null : userId));
    if (history[userId]) return;
    const { rows, error } = await loadPersonHistory(userId);
    setHistory(prev => ({ ...prev, [userId]: error ? 'error' : rows }));
  };

  const onExcelLoad = (from: string | null, people: LoadedPerson[]) => {
    if (from) setApplyFrom(from);
    setDrafts(prev => {
      const next = { ...prev };
      for (const p of people) next[p.userId] = { ...(next[p.userId] ?? { days: {} }), days: { ...(next[p.userId]?.days ?? {}), ...p.days } };
      return next;
    });
  };

  // ─── 保存 ───
  const errors = draftIds.flatMap(id => {
    const name = data?.staff.find(s => s.id === id)?.name ?? '';
    return draftChangedDays(id).map(k => {
      const e = validateDay(drafts[id].days[k]!, data?.workplaces ?? []);
      return e ? `${name}（${ROSTER_DAY_LABEL[k]}）：${e}` : null;
    }).filter((x): x is string => !!x);
  });
  const keptFuture = draftIds.flatMap(id => draftChangedDays(id).map(k => {
    const next = (rowsByUser.get(id) ?? []).filter(r => r.day_kind === k && r.valid_from > applyFrom).map(r => r.valid_from).sort()[0];
    return next ? `${data?.staff.find(s => s.id === id)?.name}さん（${ROSTER_DAY_LABEL[k]}）は ${Number(next.slice(5, 7))}/${Number(next.slice(8, 10))} からのシフトがあるので、${Number(prevDate(next).slice(5, 7))}/${Number(prevDate(next).slice(8, 10))} まで` : null;
  }).filter((x): x is string => !!x));
  const isPast = applyFrom < todayJstStr();
  // 保存すると時間外になる勉強会（今は問題なく、直したあとに ⚠️ になるもの）。判定は lib/studySessions.ts の dayIssue 1か所
  const studyWarnings = draftIds.flatMap(id => draftChangedDays(id).flatMap(k => {
    if (!ROSTER_WEEK.includes(k)) return [];
    const name = data?.staff.find(s => s.id === id)?.name ?? '';
    return (study?.versions ?? [])
      .filter(v => v.day_kind === k && v.members.includes(id) && (v.valid_to === null || v.valid_to >= applyFrom))
      .filter(v => dayIssue(v, drafts[id].days[k]!) && !dayIssue(v, savedDay(id, k, applyFrom)))
      .map(v => `${name}さん（${ROSTER_DAY_LABEL[k]}）：${studyLabel(v, shortNames)}`);
  }));
  // 保存すると時間外になる掃除（今は問題なく、直したあとに ⚠️ になるもの）。判定は lib/cleaningRoster.ts の cellIssues 1か所
  const cleaningWarnings = cleaning ? draftIds.flatMap(id => draftChangedDays(id).flatMap(k => {
    if (!ROSTER_WEEK.includes(k)) return [];
    const name = data?.staff.find(s => s.id === id)?.name ?? '';
    return cleaningRows.flatMap(r => {
      const v = cellValue(cellVersionOn(cleaning.cells, r.id, k, applyFrom));
      const mine = { is_none: false, note: '', entries: v.entries.filter(e => e.user_id === id && e.start) };
      if (v.is_none || mine.entries.length === 0) return [];
      const names = new Map([[id, name]]);
      const before = new Set(cellIssues(r, mine, () => savedDay(id, k, applyFrom), names).map(i => i.key));
      return cellIssues(r, mine, () => drafts[id].days[k]!, names)
        .filter(i => !before.has(i.key))
        .map(i => `${name}さん（${ROSTER_DAY_LABEL[k]}）：${i.start.replace(/^0/, '')} ${rowPlaceLabel(r)}`);
    });
  })) : [];

  // ⑤ こどもシフト表：この保存で新しく時間外になるもの（2026-09-22）。
  // 🚨 掃除・勉強会と同じ形。**直す前は問題なく、直すと ⚠️ になるものだけ**を出す
  //    （もともと ⚠️ のものまで出すと、毎回同じ警告が並んで読まれなくなる）。
  // 🚨 判定は lib/kidsShift.ts の kidsCellIssues 1本（こどもシフト表の画面と同じもの）
  const kidsWarnings = kids ? draftIds.flatMap(id => draftChangedDays(id).flatMap(k => {
    if (!ROSTER_WEEK.includes(k)) return [];
    const name = data?.staff.find(s => s.id === id)?.name ?? '';
    const names = new Map([[id, name]]);
    const modeOf = (rk: string) => kids.rowKinds.find(r => r.key === rk)?.issue_mode ?? 'full';
    return kids.places.filter(p => p.active && p.kind !== 'daynote').flatMap(p => {
      const items = kidsVersionOn(kids.cells, p.id, k, applyFrom)?.items ?? [];
      // その人が入っている行だけに絞る（ほかの人の ⚠️ はこの保存と関係ない）
      const mine = items.map(it => ({ ...it, people: it.people.filter(pe => pe.user_id === id) }))
        .filter(it => it.people.length > 0);
      if (mine.length === 0) return [];
      const before = new Set(
        kidsCellIssues(p.id, k, mine, () => savedDay(id, k, applyFrom), modeOf, names, new Set(), p.school)
          .map(i => i.key));
      return kidsCellIssues(p.id, k, mine, () => drafts[id].days[k]!, modeOf, names, new Set(), p.school)
        .filter(i => !before.has(i.key))
        .map(() => `${name}さん（${ROSTER_DAY_LABEL[k]}）：${p.label}`);
    });
  })) : [];

  const doSave = async () => {
    if (!data || token == null) return;
    setSaving(true); setSaveErr(''); setSaveMsg('');
    const people: SavePerson[] = data.staff.map(s => {
      const d = drafts[s.id];
      if (!d || !draftChanged(s.id)) return { user_id: s.id };
      const p: SavePerson = { user_id: s.id, days: {} };
      for (const k of draftChangedDays(s.id)) p.days![k] = { segments: d.days[k]!.segments, note: d.days[k]!.note };
      if (d.personNote !== undefined) p.person_note = d.personNote;
      if (d.mainAreaId) p.main_area_id = d.mainAreaId;
      return p;
    });
    const { result, error } = await saveRoster({ apply_from: applyFrom, confirm_past: isPast, base_token: token, people });
    setSaving(false);
    if (error || !result) { setSaveErr(`保存できませんでした：${error ?? ''}`); return; }
    if (!result.ok && result.reason === 'stale') {
      setStale(true); setConfirming(false);
      setSaveErr('開いたあとに、別の人がシフトを保存しました。上書きしないよう保存を止めました。「読み込み直す」を押すと、直した内容は残したまま最新の状態と比べ直せます。');
      return;
    }
    if (!result.ok) { setSaveErr('保存できませんでした（今日より前の日付の確認が必要です）'); return; }
    setConfirming(false);
    setSaveMsg(`保存しました（${applyFrom} から・変更あり ${result.changed_people}人・変更なし ${result.unchanged_people}人${result.kept_future.length > 0 ? `・先のシフトを残した曜日 ${result.kept_future.length}` : ''}）`);
    setHistory({});
    await load(false);
  };

  // ─── PDF ───
  const printPdf = () => {
    if (!data) return;
    const who = pdfWho === 'changed' ? visible.filter(s => redDays(s.id).length > 0) : visible;
    if (who.length === 0) { setPdfErr('出す人がいません'); return; }
    const people: PrintPerson[] = who.map(s => {
      const days: Partial<Record<RosterDayKind, RosterDay>> = {};
      for (const k of ROSTER_WEEK) days[k] = shownDay(s.id, k);
      const mainId = mainAreaOf(s.id);
      const studies: PrintPerson['studies'] = {};
      for (const k of ROSTER_WEEK) studies[k] = studiesFor(s.id, k, applyFrom).map(v => ({ text: studyLabel(v, shortNames), warn: !!dayIssue(v, days[k]!) }));
      const cleaningLines: PrintPerson['cleaning'] = {};
      for (const k of ROSTER_WEEK) cleaningLines[k] = cleaningFor(s.id, k, applyFrom);
      return { name: s.name, headNote: noteOf(s.id), mainAreaId: mainId, mainAreaName: areas.find(a => a.id === mainId)?.name ?? '', days, changedDays: redDays(s.id), studies, cleaning: cleaningLines };
    });
    setPdfErr(openRosterPrint(buildRosterPrintHtml({ layout: pdfLayout, applyFrom, people, areas, redChanges: pdfRed, studyWarn: pdfStudyWarn })) ?? '');
  };

  // ─── 部門の一覧 ───
  const saveArea = async (id: string, patch: Partial<WorkArea>) => {
    setAreaErr('');
    const e = await updateWorkArea(id, patch);
    if (e) { setAreaErr(e); return; }
    await load(true);
  };
  const createArea = async () => {
    setAreaErr('');
    if (!newArea.name.trim() || !newArea.short_name.trim()) { setAreaErr('名前と短い名前を入れてください'); return; }
    const e = await addWorkArea({ name: newArea.name.trim(), short_name: newArea.short_name.trim(), color: newArea.color, sort_order: (areas.at(-1)?.sort_order ?? 0) + 1 });
    if (e) { setAreaErr(e); return; }
    setNewArea({ name: '', short_name: '', color: 'gray' });
    await load(true);
  };

  // ─── 表示の部品 ───
  const areaChip = (area: WorkArea | null, label: string) => {
    const c = AREA_COLORS[area?.color ?? 'gray'] ?? AREA_COLORS.gray;
    return <span style={{ display: 'inline-block', padding: '0 4px', borderRadius: 4, fontSize: 11, background: c.bg, color: c.fg, whiteSpace: 'nowrap' }}>{label}</span>;
  };

  const cellView = (userId: string, k: RosterDayKind) => {
    const day = shownDay(userId, k);
    const f = deriveFields(day.segments);
    const isRed = !dayEquals(day, baseDay(userId, k));
    const mainId = mainAreaOf(userId);
    const base = baseDay(userId, k);
    const baseText = deriveFields(base.segments).bands.map(b => `${minText(b.s)}〜${minText(b.e)}`).join(' / ') || '休み';
    return (
      <div style={{ color: isRed ? red : text }}>
        {f.bands.length === 0 ? <span style={{ color: isRed ? red : subText }}>{hasAnyRow(userId) || drafts[userId] ? '休' : '—'}</span>
          : f.bands.map((b, i) => <div key={i} style={{ fontWeight: isRed ? 'bold' : 'normal' }}>{minText(b.s)}-{minText(b.e)}</div>)}
        {/* 休憩・労働は切り替えなしで時刻のすぐ下に出す（2026-09-15 ユーザー要望） */}
        {f.bands.length > 0 && !f.error && (
          <div style={{ fontSize: 11, color: isRed ? red : subText, whiteSpace: 'nowrap' }}>休憩{minText(f.breakMinutes)} 労働{minText(f.laborMinutes)}</div>
        )}
        {f.bands.length > 0 && (
          <div style={{ display: 'flex', gap: 2, justifyContent: 'center', flexWrap: 'wrap', marginTop: 1 }}>
            {placeSteps(day, areas, mainId).map((p, i) => (
              <React.Fragment key={i}>{i > 0 && <span style={{ fontSize: 10, color: subText }}>→</span>}{areaChip(p.area, `${shortSchool(p.school)}${p.area ? `(${p.area.short_name})` : ''}`)}</React.Fragment>
            ))}
          </div>
        )}
        {day.note && <div style={{ fontSize: 10.5, color: subText }}>{day.note}</div>}
        {ROSTER_WEEK.includes(k) && studiesFor(userId, k, applyFrom).map(v => {
          const warn = !!dayIssue(v, day);
          return (
            <div key={v.id} style={{ fontSize: 10.5, color: warn ? red : (isDarkMode ? '#8fd19e' : '#1b5e20'), whiteSpace: 'nowrap' }}
              title={warn ? '勉強会の時間に勤務していない・校が違うなど（勉強会のタブで確かめられます）' : '勉強会'}>
              {warn ? '⚠️' : ''}{studyLabel(v, shortNames)}
            </div>
          );
        })}
        {ROSTER_WEEK.includes(k) && cleaningFor(userId, k, applyFrom).map(t => (
          <div key={t} style={{ fontSize: 10.5, color: subText, whiteSpace: 'nowrap' }} title="掃除担当表から">掃除 {t}</div>
        ))}
        {f.error && <div style={{ fontSize: 10.5, color: red }}>⚠️ 入力を確かめてください</div>}
        {isRed && <div style={{ fontSize: 10, color: subText }}>前：{baseText}</div>}
      </div>
    );
  };

  const segmentEditor = (userId: string, k: RosterDayKind) => {
    const day = shownDay(userId, k);
    const f = deriveFields(day.segments);
    const v = validateDay(day, data?.workplaces ?? []);
    const setSegs = (segs: RosterSegment[]) => editDay(userId, k, { ...day, segments: segs });
    const mainId = mainAreaOf(userId);
    const changed = !dayEquals(day, savedDay(userId, k, applyFrom));
    return (
      <div key={k} style={{ padding: '6px 8px', borderRadius: 8, background: innerBg, marginBottom: 4 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ width: 20, fontWeight: 'bold', color: changed ? red : text, paddingTop: 6 }}>{ROSTER_DAY_LABEL[k]}</span>
          <div style={{ flex: 1, minWidth: 320 }}>
            {day.segments.length === 0 && <span style={{ fontSize: 12.5, color: subText, lineHeight: '30px' }}>休み</span>}
            {day.segments.map((sg, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 3 }}>
                <input type="time" step={300} value={sg.start} style={inputStyle}
                  onChange={e => setSegs(day.segments.map((x, j) => j === i ? { ...x, start: e.target.value } : x))} />
                <span style={{ color: subText }}>〜</span>
                <input type="time" step={300} value={sg.end} style={inputStyle}
                  onChange={e => setSegs(day.segments.map((x, j) => j === i ? { ...x, end: e.target.value } : x))} />
                <select value={sg.location} style={inputStyle}
                  onChange={e => setSegs(day.segments.map((x, j) => j === i ? { ...x, location: e.target.value } : x))}>
                  {!(data?.workplaces ?? []).includes(sg.location) && <option value={sg.location}>{sg.location || '校を選ぶ'}</option>}
                  {(data?.workplaces ?? []).map(w => <option key={w} value={w}>{w}</option>)}
                </select>
                <select value={sg.area_id ?? ''} style={inputStyle}
                  onChange={e => setSegs(day.segments.map((x, j) => j === i ? { ...x, area_id: e.target.value || null } : x))}>
                  <option value="">メインの部門{mainId ? `（${areas.find(a => a.id === mainId)?.name ?? ''}）` : ''}</option>
                  {activeAreas.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
                <button type="button" aria-label="この行を消す" onClick={() => setSegs(day.segments.filter((_, j) => j !== i))}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: subText, fontSize: 14 }}>✕</button>
              </div>
            ))}
            {/* 休憩・労働は時刻のすぐ下に大きく（右端だと見えにくい・2026-09-15 ユーザー要望） */}
            {f.bands.length > 0 && !f.error && (
              <div style={{ fontSize: 13.5, fontWeight: 'bold', color: text, margin: '2px 0 4px' }}>
                休憩 {minText(f.breakMinutes)}<span style={{ marginLeft: '1em' }}>労働 {minText(f.laborMinutes)}</span>
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 2 }}>
              <button type="button" onClick={() => {
                const last = day.segments[day.segments.length - 1];
                setSegs([...day.segments, { start: last?.end ?? '', end: '', location: last?.location ?? (data?.workplaces[0] ?? ''), area_id: null }]);
              }} style={{ background: 'none', border: `1px dashed ${borderColor}`, borderRadius: 6, cursor: 'pointer', padding: '3px 8px', fontSize: 11.5, color: '#0d6efd' }}>
                ＋ 行を足す
              </button>
              {day.segments.length > 0 && (
                <button type="button" onClick={() => setSegs([])}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 11.5, color: subText, textDecoration: 'underline' }}>休みにする</button>
              )}
              {drafts[userId]?.days[k] && (
                <button type="button" onClick={() => revertDay(userId, k)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 11.5, color: subText, textDecoration: 'underline' }}>↩ 直す前に戻す</button>
              )}
              <input type="text" value={day.note} placeholder="書き添え" maxLength={100} style={{ ...inputStyle, flex: 1, minWidth: 160 }}
                onChange={e => editDay(userId, k, { ...day, note: e.target.value })} />
            </div>
            {v && day.segments.length > 0 && <div style={{ fontSize: 12, color: red, marginTop: 2 }}>⚠️ {v}</div>}
          </div>
        </div>
      </div>
    );
  };

  const personPanel = (userId: string) => {
    const s = data?.staff.find(x => x.id === userId);
    const h = history[userId];
    const idx = visible.findIndex(x => x.id === userId);
    const nextPerson = visible[idx + 1];
    return (
      <div style={{ padding: '10px 12px', borderRadius: 10, border: `2px solid #1976d2`, background: cardBg, textAlign: 'left' }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
          <b style={{ fontSize: 14, color: text }}>{s?.name}</b>
          <label style={{ fontSize: 12.5, color: subText, display: 'flex', gap: 6, alignItems: 'center' }}>
            メインの部門
            <select value={mainAreaOf(userId) ?? ''} style={inputStyle} onChange={e => setPersonField(userId, { mainAreaId: e.target.value })}>
              <option value="" disabled>選ぶ</option>
              {activeAreas.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </label>
          <label style={{ fontSize: 12.5, color: subText, display: 'flex', gap: 6, alignItems: 'center', flex: 1, minWidth: 260 }}>
            人の書き添え
            <input type="text" value={noteOf(userId)} maxLength={200} placeholder="例：月1(木)下鴨夢 10:00～12:00" style={{ ...inputStyle, flex: 1 }}
              onChange={e => setPersonField(userId, { personNote: e.target.value })} />
          </label>
        </div>
        {ROSTER_WEEK.map(k => segmentEditor(userId, k))}
        <details style={{ marginTop: 6 }}>
          <summary style={{ fontSize: 12.5, color: subText, cursor: 'pointer' }}>祝（全員休みの日）・出（休館日だけど出勤の日）</summary>
          <div style={{ marginTop: 4 }}>{ROSTER_EXTRA.map(k => segmentEditor(userId, k))}</div>
        </details>
        <details style={{ marginTop: 6 }}>
          <summary style={{ fontSize: 12.5, color: subText, cursor: 'pointer' }}>過去の履歴</summary>
          {h === 'error' ? <p style={{ fontSize: 12, color: red }}>過去の履歴を読み込めませんでした</p>
            : !h ? <p style={{ fontSize: 12, color: subText }}>読み込んでいます...</p>
            : (
              <table style={{ fontSize: 12, color: subText, borderCollapse: 'collapse', marginTop: 4 }}>
                <tbody>
                  {h.map(r => {
                    const d = rowToDay(r);
                    return (
                      <tr key={r.id}>
                        <td style={{ padding: '2px 6px' }}>{ROSTER_DAY_LABEL[r.day_kind as RosterDayKind] ?? r.day_kind}</td>
                        <td style={{ padding: '2px 6px' }}>{deriveFields(d.segments).bands.map(b => `${minText(b.s)}〜${minText(b.e)}`).join(' / ') || '休み'}</td>
                        <td style={{ padding: '2px 6px' }}>{d.segments.map(x => x.location).filter((v, i, a) => a.indexOf(v) === i).join('・')}</td>
                        <td style={{ padding: '2px 6px' }}>{r.valid_from}〜{r.valid_to ?? ''}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
        </details>
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <button type="button" onClick={() => setOpenId(null)} style={{ ...inputStyle, cursor: 'pointer' }}>閉じる</button>
          {nextPerson && <button type="button" onClick={() => openPerson(nextPerson.id)} style={{ ...inputStyle, cursor: 'pointer' }}>次の人 ↓（{nextPerson.name}）</button>}
        </div>
      </div>
    );
  };

  if (loading && !data) return <p style={{ color: subText }}>読み込んでいます...</p>;
  if (loadErr && !data) return <p style={{ color: red }}>{loadErr}</p>;
  if (!data) return null;

  const hiddenDraftNames = draftIds.filter(id => !visible.some(s => s.id === id)).map(id => data.staff.find(s => s.id === id)?.name ?? '');

  const header = (
    <>
      <h3 style={{ margin: '0 0 4px', fontSize: 16, color: text }}>📑 シフト管理</h3>
      <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
        <button type="button" onClick={() => { goView('roster'); void loadStudy(); }} style={toggle(view === 'roster')}>勤務表</button>
        <button type="button" onClick={() => goView('study')} style={toggle(view === 'study')}>勉強会</button>
        <button type="button" onClick={() => goView('cleaning')} style={toggle(view === 'cleaning')}>掃除担当表</button>
        <button type="button" onClick={() => goView('kids')} style={toggle(view === 'kids')}>こどもシフト表</button>
      </div>
    </>
  );

  // 🚨 いちど開いた画面は隠すだけ（外すと未保存の入力が消える）。開いていない画面は読み込みもしない
  const subPanels = (
    <>
      {visited.has('cleaning') && (
        <div style={{ display: view === 'cleaning' ? 'block' : 'none' }}>
          <CleaningRosterPanel isDarkMode={isDarkMode} rosterDraftCount={draftIds.length} />
        </div>
      )}
      {visited.has('study') && (
        <div style={{ display: view === 'study' ? 'block' : 'none' }}>
          {/* 🚨 勤務表の未保存の変更は、勉強会の ⚠️ とプレビューに入らない（保存済みのシフトで判定する） */}
          {draftIds.length > 0 && (
            <div style={{ padding: '8px 12px', borderRadius: 8, background: '#fff3cd', border: '1px solid #ffc107', color: '#856404', fontSize: 13, marginBottom: 10 }}>
              勤務表に未保存の変更が{draftIds.length}人あります（変更は残っています）。勉強会の⚠️と入力のプレビューは、保存済みのシフトで判定します。
            </div>
          )}
          <StudySessionsPanel isDarkMode={isDarkMode} isAdminUser={isAdminUser} />
        </div>
      )}
      {visited.has('kids') && (
        <div style={{ display: view === 'kids' ? 'block' : 'none' }}>
          <KidsShiftPanel isDarkMode={isDarkMode} />
        </div>
      )}
    </>
  );

  return (
    <div>
      {header}
      {subPanels}
      <div style={{ display: view === 'roster' ? 'block' : 'none' }}>
      {studyErr && <div style={{ fontSize: 12.5, color: red, marginBottom: 8 }}>{studyErr}</div>}
      {cleaningErr && <div style={{ fontSize: 12.5, color: red, marginBottom: 8 }}>{cleaningErr}</div>}
      <p style={{ margin: '0 0 10px', fontSize: 12.5, color: subText, lineHeight: 1.7 }}>
        名前を押すと、その人の月〜日を直せます。赤字は、適用開始日の前日に効いているシフトから変わったマスです。<br />
        保存すると、変えた人・曜日だけが適用開始日から切り替わります。先に登録してあるシフトは消えません。
      </p>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
        <label style={{ fontSize: 12.5, color: subText, display: 'flex', alignItems: 'center', gap: 6 }}>
          適用開始日
          <input type="date" value={applyFrom} onChange={e => { if (e.target.value) { setApplyFrom(e.target.value); setConfirming(false); } }} style={inputStyle} />
        </label>
        {isPast && <span style={{ fontSize: 12, color: '#856404' }}>今日より前の日付です</span>}
        <span style={{ fontSize: 12.5, color: subText }}>対象</span>
        <button type="button" onClick={() => setIncludePartTime(false)} style={toggle(!includePartTime)}>正社員だけ</button>
        <button type="button" onClick={() => setIncludePartTime(true)} style={toggle(includePartTime)}>パートも</button>
      </div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
        <span style={{ fontSize: 12.5, color: subText }}>メインの部門</span>
        <button type="button" onClick={() => setAreaFilter('all')} style={toggle(areaFilter === 'all')}>すべて</button>
        {activeAreas.map(a => <button key={a.id} type="button" onClick={() => setAreaFilter(a.id)} style={toggle(areaFilter === a.id)}>{a.name}</button>)}
        <label style={{ fontSize: 12.5, color: subText, display: 'flex', alignItems: 'center', gap: 4, marginLeft: 8 }}>
          <input type="checkbox" checked={onlyDraft} onChange={e => setOnlyDraft(e.target.checked)} />
          直した人だけ表示
        </label>
      </div>

      <ShiftExcelLoader isDarkMode={isDarkMode} staff={data.staff} includePartTime={includePartTime} onLoad={onExcelLoad} />

      {/* 保存・PDF の帯 */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', padding: '8px 10px', borderRadius: 10, background: innerBg, marginBottom: 10 }}>
        <span style={{ fontSize: 13, color: draftIds.length > 0 ? '#e65100' : subText, fontWeight: draftIds.length > 0 ? 'bold' : 'normal' }}>
          未保存の変更 {draftIds.length}人{hiddenDraftNames.length > 0 ? `（うち表示していない人 ${hiddenDraftNames.length}人）` : ''}
        </span>
        <button type="button" disabled={draftIds.length === 0 || saving || stale} onClick={() => { setSaveErr(''); setConfirming(true); }}
          style={{ padding: '7px 18px', borderRadius: 8, border: 'none', cursor: draftIds.length === 0 ? 'default' : 'pointer', fontSize: 13, fontWeight: 'bold', background: '#1976d2', color: '#fff', opacity: draftIds.length === 0 || stale ? 0.5 : 1 }}>
          保存
        </button>
        {draftIds.length > 0 && (
          <button type="button" onClick={() => { setDrafts({}); setConfirming(false); }}
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 12.5, color: subText, textDecoration: 'underline' }}>直した内容をすべて取り消す</button>
        )}
        <button type="button" onClick={() => setPdfOpen(o => !o)} style={{ ...inputStyle, cursor: 'pointer', marginLeft: 'auto' }}>PDF</button>
        <button type="button" onClick={() => setAreasOpen(o => !o)} style={{ ...inputStyle, cursor: 'pointer' }}>部門の一覧</button>
      </div>

      {stale && (
        <div style={{ padding: '10px 12px', borderRadius: 10, background: '#fff3cd', border: '1px solid #ffc107', color: '#856404', fontSize: 13, marginBottom: 10 }}>
          {saveErr}
          <div style={{ marginTop: 8 }}>
            <button type="button" onClick={() => { setSaveErr(''); void load(true); }}
              style={{ padding: '6px 16px', borderRadius: 8, border: '2px solid #1565c0', background: '#1976d2', color: '#fff', cursor: 'pointer', fontWeight: 'bold' }}>読み込み直す</button>
          </div>
        </div>
      )}
      {!stale && saveErr && <div style={{ padding: '8px 12px', borderRadius: 8, background: '#f8d7da', border: '1px solid #f5c2c7', color: '#842029', fontSize: 13, marginBottom: 10 }}>{saveErr}</div>}
      {saveMsg && <div style={{ padding: '8px 12px', borderRadius: 8, background: '#d1e7dd', border: '1px solid #28a745', color: '#0f5132', fontSize: 13, marginBottom: 10 }}>✓ {saveMsg}</div>}

      {confirming && (
        <div style={{ padding: '12px 14px', borderRadius: 10, border: `2px solid ${isPast ? '#ffc107' : '#1976d2'}`, background: cardBg, marginBottom: 10, fontSize: 13, color: text, lineHeight: 1.7 }}>
          <b>{applyFrom} から適用します</b>
          {isPast && <div style={{ padding: '6px 10px', borderRadius: 8, background: '#fff3cd', color: '#856404', margin: '6px 0' }}>⚠️ 今日より前の日付です。受理済みの休暇の時間外調整休の記録は変わりません。</div>}
          <div>・変更あり {draftIds.length}人（{draftIds.map(id => data.staff.find(s => s.id === id)?.name).join('・')}）→ 新しいシフトを作ります</div>
          <div>・変更なし {data.staff.length - draftIds.length}人 → そのまま（表示していない人も含めて確かめます）</div>
          {hiddenDraftNames.length > 0 && <div style={{ color: '#e65100' }}>・表示していない人の変更も保存されます（{hiddenDraftNames.join('・')}）</div>}
          {keptFuture.map(t => <div key={t}>・{t}</div>)}
          {studyWarnings.length > 0 && (
            <div style={{ padding: '6px 10px', borderRadius: 8, background: '#fff3cd', color: '#856404', margin: '6px 0' }}>
              ⚠️ 勉強会{studyWarnings.length}件が時間外になります（保存はできます。勉強会のタブで直せます）
              {studyWarnings.map(t => <div key={t}>・{t}</div>)}
            </div>
          )}
          {cleaningWarnings.length > 0 && (
            <div style={{ padding: '6px 10px', borderRadius: 8, background: '#fff3cd', color: '#856404', margin: '6px 0' }}>
              ⚠️ 掃除{cleaningWarnings.length}件が時間外になります（保存はできます。掃除担当表のタブで直せます）
              {cleaningWarnings.map(t => <div key={t}>・{t}</div>)}
            </div>
          )}
          {kidsWarnings.length > 0 && (
            <div style={{ padding: '6px 10px', borderRadius: 8, background: '#fff3cd', color: '#856404', margin: '6px 0' }}>
              ⚠️ こどもシフト表{kidsWarnings.length}件が時間外になります（保存はできます。こどもシフト表のタブで直せます）
              {kidsWarnings.map(t => <div key={t}>・{t}</div>)}
            </div>
          )}
          {/* 🚨 読めなかったときは黙って0件にしない（「問題なし」と誤解させない） */}
          {kidsErr && (
            <div style={{ padding: '6px 10px', borderRadius: 8, background: '#fff3cd', color: '#856404', margin: '6px 0' }}>
              ⚠️ こどもシフト表が時間外になるかは確かめられませんでした（{kidsErr}）
            </div>
          )}
          {errors.length > 0 && (
            <div style={{ color: red, marginTop: 6 }}>
              入力を確かめてください（保存できません）
              {errors.map(e => <div key={e}>・{e}</div>)}
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button type="button" disabled={saving || errors.length > 0} onClick={doSave}
              style={{ padding: '8px 18px', borderRadius: 8, border: 'none', cursor: errors.length > 0 ? 'default' : 'pointer', fontSize: 13, fontWeight: 'bold', background: '#1976d2', color: '#fff', opacity: errors.length > 0 ? 0.5 : 1 }}>
              {saving ? '保存中…' : isPast ? 'さかのぼって保存する' : '保存する'}
            </button>
            <button type="button" disabled={saving} onClick={() => setConfirming(false)} style={{ ...inputStyle, cursor: 'pointer' }}>やめる</button>
          </div>
        </div>
      )}

      {pdfOpen && (
        <div style={{ padding: '10px 12px', borderRadius: 10, border: `1px solid ${borderColor}`, background: cardBg, marginBottom: 10, fontSize: 13, color: text }}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}>
            <span style={{ color: subText }}>形</span>
            <button type="button" onClick={() => setPdfLayout('A')} style={toggle(pdfLayout === 'A')}>A 1人1ブロック（A4縦）</button>
            <button type="button" onClick={() => setPdfLayout('B')} style={toggle(pdfLayout === 'B')}>B 週の一覧（A4横）</button>
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}>
            <span style={{ color: subText }}>出す人</span>
            <button type="button" onClick={() => setPdfWho('all')} style={toggle(pdfWho === 'all')}>表示している全員</button>
            <button type="button" onClick={() => setPdfWho('changed')} style={toggle(pdfWho === 'changed')}>変更があった人</button>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4, marginLeft: 8 }}>
              <input type="checkbox" checked={pdfRed} onChange={e => setPdfRed(e.target.checked)} />変わった所を赤字にする
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4, marginLeft: 8 }}>
              <input type="checkbox" checked={pdfStudyWarn} onChange={e => setPdfStudyWarn(e.target.checked)} />勉強会の⚠️印も刷る
            </label>
          </div>
          <div style={{ fontSize: 12, color: subText, marginBottom: 6 }}>
            並びはメインの部門ごと・役職の高い順です。{draftIds.length > 0 ? '未保存の変更も含めて出します。' : ''}印刷の画面で「PDFに保存」を選んでください。
          </div>
          <button type="button" onClick={printPdf} style={{ padding: '7px 16px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 'bold', background: '#1976d2', color: '#fff' }}>印刷の画面を開く</button>
          {pdfErr && <div style={{ color: red, marginTop: 6 }}>{pdfErr}</div>}
        </div>
      )}

      {areasOpen && (
        <div style={{ padding: '10px 12px', borderRadius: 10, border: `1px solid ${borderColor}`, background: cardBg, marginBottom: 10, fontSize: 13, color: text }}>
          <div style={{ fontSize: 12, color: subText, marginBottom: 6 }}>時間帯ごとに選ぶ部門です。消さずに「隠す」と、選択肢から外れます（過去のシフトの表示は残ります）。</div>
          {areas.map(a => (
            <div key={a.id} style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: 4, opacity: a.active ? 1 : 0.6 }}>
              <input defaultValue={a.name} maxLength={20} style={{ ...inputStyle, width: 110 }} onBlur={e => { if (e.target.value.trim() && e.target.value.trim() !== a.name) void saveArea(a.id, { name: e.target.value.trim() }); }} />
              <input defaultValue={a.short_name} maxLength={4} style={{ ...inputStyle, width: 50 }} onBlur={e => { if (e.target.value.trim() && e.target.value.trim() !== a.short_name) void saveArea(a.id, { short_name: e.target.value.trim() }); }} />
              <select value={a.color} style={inputStyle} onChange={e => void saveArea(a.id, { color: e.target.value })}>
                {COLOR_KEYS.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
              {areaChip(a, `本校(${a.short_name})`)}
              <button type="button" onClick={() => void saveArea(a.id, { active: !a.active })} style={{ ...inputStyle, cursor: 'pointer' }}>{a.active ? '隠す' : '戻す'}</button>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
            <input value={newArea.name} maxLength={20} placeholder="新しい部門" style={{ ...inputStyle, width: 110 }} onChange={e => setNewArea(v => ({ ...v, name: e.target.value }))} />
            <input value={newArea.short_name} maxLength={4} placeholder="短い名前" style={{ ...inputStyle, width: 70 }} onChange={e => setNewArea(v => ({ ...v, short_name: e.target.value }))} />
            <select value={newArea.color} style={inputStyle} onChange={e => setNewArea(v => ({ ...v, color: e.target.value }))}>
              {COLOR_KEYS.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <button type="button" onClick={() => void createArea()} style={{ ...inputStyle, cursor: 'pointer' }}>追加</button>
          </div>
          {areaErr && <div style={{ color: red, marginTop: 6 }}>{areaErr}</div>}
        </div>
      )}

      {loadErr && <p style={{ color: red }}>{loadErr}</p>}

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, color: text, minWidth: 820 }}>
          <thead>
            <tr>
              <th style={{ position: 'sticky', left: 0, background: cardBg, padding: '6px', borderBottom: `1px solid ${borderColor}`, textAlign: 'left', minWidth: 130 }}>名前</th>
              {ROSTER_WEEK.map(k => <th key={k} style={{ padding: '6px 4px', borderBottom: `1px solid ${borderColor}` }}>{ROSTER_DAY_LABEL[k]}</th>)}
              <th style={{ padding: '6px 4px', borderBottom: `1px solid ${borderColor}` }}>週合計</th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 && (
              <tr><td colSpan={9} style={{ padding: 12, color: subText }}>表示する人がいません。</td></tr>
            )}
            {visible.map((s, i) => {
              const mainId = mainAreaOf(s.id);
              const prevMain = i > 0 ? mainAreaOf(visible[i - 1].id) : undefined;
              const total = ROSTER_WEEK.reduce((sum, k) => sum + deriveFields(shownDay(s.id, k).segments).laborMinutes, 0);
              const baseTotal = ROSTER_WEEK.reduce((sum, k) => sum + deriveFields(baseDay(s.id, k).segments).laborMinutes, 0);
              const dirty = draftIds.includes(s.id);
              return (
                <React.Fragment key={s.id}>
                  {(i === 0 || prevMain !== mainId) && (
                    <tr><td colSpan={9} style={{ padding: '6px', background: innerBg, fontWeight: 'bold', color: subText }}>{areas.find(a => a.id === mainId)?.name ?? 'メインの部門なし'}</td></tr>
                  )}
                  <tr>
                    <td onClick={() => openPerson(s.id)}
                      style={{ position: 'sticky', left: 0, background: cardBg, padding: '5px 6px', borderBottom: `1px solid ${borderColor}`, cursor: 'pointer', whiteSpace: 'nowrap', verticalAlign: 'top' }}>
                      <span style={{ color: '#1976d2' }}>{openId === s.id ? '▼' : '▶'}</span> {s.name}
                      {dirty && <span style={{ fontSize: 10.5, color: '#e65100', marginLeft: 4 }}>未保存</span>}
                      <div style={{ fontSize: 10.5, color: subText }}>{s.role_title}{s.employment_type === 'パート' ? '・パート' : ''}</div>
                      {noteOf(s.id) && <div style={{ fontSize: 10.5, color: subText, whiteSpace: 'normal', maxWidth: 160 }}>{noteOf(s.id)}</div>}
                    </td>
                    {ROSTER_WEEK.map(k => (
                      <td key={k} onClick={() => openPerson(s.id)}
                        style={{ padding: '5px 3px', borderBottom: `1px solid ${borderColor}`, textAlign: 'center', verticalAlign: 'top', cursor: 'pointer' }}>
                        {cellView(s.id, k)}
                      </td>
                    ))}
                    <td style={{ padding: '5px 4px', borderBottom: `1px solid ${borderColor}`, textAlign: 'center', verticalAlign: 'top', whiteSpace: 'nowrap', color: total !== baseTotal ? red : text }}>
                      <b>{minText(total)}</b>
                      {total !== baseTotal && <div style={{ fontSize: 10, color: subText }}>前：{minText(baseTotal)}</div>}
                    </td>
                  </tr>
                  {openId === s.id && (
                    <tr><td colSpan={9} style={{ padding: '6px 0 10px' }}>{personPanel(s.id)}</td></tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <p style={{ margin: '8px 0 0', fontSize: 11.5, color: subText }}>
        ※ 休憩・労働時間は、保存するときに DB でも同じ表で計算し直します。時刻の表示例：{timeText('09:30')}
      </p>
      </div>
    </div>
  );
};

export default ShiftManagementTab;

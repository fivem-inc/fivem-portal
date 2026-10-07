import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useScrollIntoViewWhen } from '../../hooks/useScrollIntoViewWhen';
import { todayJstStr } from '../../lib/breakCalc';
import { ROSTER_DAY_LABEL, compareRosterStaff, minText, normTime, prevDate, shiftDayOn, toMin, type RosterDayKind } from '../../lib/shiftRoster';
import { useRoles } from '../../hooks/useRoles';
import { rankOf } from '../../lib/roleAttrs';
import { studyEndMin, studyLabel, studyStartMin, versionsOnDate, type StudyVersion } from '../../lib/studySessions';
import { loadStudyData } from '../../lib/studySessionsApi';
import { bandIndexOf, bandsOfDay, itemsByBand, poolRowOfBand, type KidsBand } from '../../lib/kidsShiftBands';
import { loadRosterData, type RosterData, type RosterPatternRow } from '../../lib/shiftRosterApi';
import { fullName, shortNameMap } from '../../lib/staffName';
import { openRosterPrint } from '../../lib/shiftRosterPrint';
import {
  KIDS_WEEK, PERSON_ROLE_LABEL, sigOfItems, cellEquals, cellVersionOn, defaultsForGroups, emptyItem, itemText, itemTextWithBlanks,
  kidsCellIssues, kidsGridSheet, kidsListSheet, makeCanLesson, mergeCell, offStaffOfDay, overlapsOfDay, shortfallOf,
  type KidsCellValue, type KidsIssue, type KidsItem, type KidsPerson, type KidsPlace, type KidsPlan, type KidsPlanCell, type ShiftBoard,
} from '../../lib/kidsShift';
import { ADULT_CLASS_KIND, ADULT_ROLES, ADULT_TRIP_KIND, adultLines, splitMinOf, withPersonSpans, type AdultLine } from '../../lib/adultShift';
import { crossEntriesOf, crossOverlaps, kidsRowText, type CrossEntry } from '../../lib/shiftCross';
import { buildAdultPrintHtml } from '../../lib/adultShiftPrint';
import {
  ackKidsIssue, decidePlan, loadKidsData, loadKidsToken, loadPlanCells, savePlan, saveKidsCells, saveKidsSettings,
  saveLessonFlag, saveMasterRow, savePlace, toPayloadCells, type KidsData,
} from '../../lib/kidsShiftApi';
import { buildKidsPrintHtml, type KidsPrintLayout } from '../../lib/kidsShiftPrint';
import { CHANGE_MARK_SPAN, changeCellStyle, diffLines } from '../../lib/changeMark';

// ⑤ こどもシフト表（2026-09-16・段階1の1回目）。設計・決めたことは docs/計画-管理画面の開放.md の 5-9〜5-9-3。
// ・置き場所（列・校の見出し・曜日の書き添え）×曜日のマスを「いつから」で版にする（変えたマスだけ・先の版は残す）
// ・案は「変えたマスだけ」を持つ。決定すると決定済みの表に入り、案は「過去の案」へ（2年で消える・画面の言葉は 2026-10-06 に「しまった案」から変更）
// ・追加必要＝必要な人数に足りない分（班の数から初期値）。重なり＝同じ人が同じ時間に2か所
// 🚨 ⚠️（出勤していない）と「確認した」・案を比べる・Excel・校ごとの PDF は2回目
// 🚨 下書きは「決定済みの表」と「案ごと」で分けて持つ（切り替えで混ざらないように・レビュー U2）

const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
const cellKey = (placeId: string, day: string) => `${placeId}|${day}`;
/** 表をまたぐ重なりに出す置き場所の短い呼び名（本校 3F・6F・出張 など） */
const placeShort = (p: KidsPlace) => (p.kind === 'trip' ? '出張' : p.board === 'adult' ? (p.floor ?? p.label) : p.label.replace('四条本校', '本校'));
/** 案と比べているときの薄い水色の帯（2026-10-06 ユーザー確定 B・黄色は変わったマスに使うため） */
const compareBand = (isDark: boolean): React.CSSProperties => ({ background: isDark ? '#12363d' : '#e0f7fa' });

// 🚨 board='adult' で大人シフト表（2026-10-07・docs/計画-大人シフト表.md §3）。案・保存・決定・比べる・⚠️ はこどもと同じ仕組みで、
//    表の形（縦＝時刻・横＝曜日＋出張の細い列）と入れる欄（前半／後半・補助・映像）だけが違う。マスの読み書きは lib/adultShift.ts
const KidsShiftPanel: React.FC<{ isDarkMode: boolean; board?: ShiftBoard }> = ({ isDarkMode, board = 'kids' }) => {
  const isAdult = board === 'adult';
  const boardName = isAdult ? '大人シフト表' : 'こどもシフト表';
  const text = isDarkMode ? '#f8f9fa' : '#212529';
  const subText = isDarkMode ? '#adb5bd' : '#6c757d';
  const borderColor = isDarkMode ? '#495057' : '#dee2e6';
  const cardBg = isDarkMode ? '#343a40' : '#fff';
  const innerBg = isDarkMode ? '#2b3035' : '#f8f9fa';
  const red = isDarkMode ? '#ff8a80' : '#c62828';
  const inputStyle: React.CSSProperties = { padding: '5px 7px', borderRadius: 6, border: `1px solid ${borderColor}`, background: isDarkMode ? '#495057' : '#fff', color: text, fontSize: 13 };
  const toggle = (on: boolean): React.CSSProperties => ({
    padding: '5px 11px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 12.5,
    fontWeight: on ? 'bold' : 'normal', background: on ? '#1976d2' : (isDarkMode ? '#495057' : '#e9ecef'), color: on ? '#fff' : text,
  });
  const primaryBtn: React.CSSProperties = { padding: '7px 16px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 'bold', background: '#1976d2', color: '#fff' };
  const linkBtn: React.CSSProperties = { background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, color: subText, textDecoration: 'underline' };
  const warnCard: React.CSSProperties = { padding: '8px 12px', borderRadius: 8, background: '#fff3cd', border: '1px solid #ffc107', color: '#856404', fontSize: 13 };
  const okCard: React.CSSProperties = { padding: '8px 12px', borderRadius: 8, background: '#d4edda', border: '1px solid #c3e6cb', color: '#155724', fontSize: 13 };

  const today = todayJstStr();
  const [applyFrom, setApplyFrom] = useState(today);
  const [view, setView] = useState<string>('decided');      // 'decided' か 案のID
  const [day, setDay] = useState<RosterDayKind>('mon');
  const [data, setData] = useState<KidsData | null>(null);
  const [roster, setRoster] = useState<RosterData | null>(null);
  const [planCells, setPlanCells] = useState<KidsPlanCell[]>([]);
  // ［曜日で見る］［人ごとに見る］（2026-10-07）。人ごとは見るだけ
  const [viewMode, setViewMode] = useState<'day' | 'person'>('day');
  const roles = useRoles();
  // 勉強会（2026-10-07）。勉強会の表から自動で出す（ここでは直せない）。🚨 読めなくても表は使える（共通の人から勉強会の時間を外せないだけ）
  const [studyVersions, setStudyVersions] = useState<StudyVersion[]>([]);
  const [studyErr, setStudyErr] = useState('');
  // 相手の表（こどもなら大人・大人ならこども・2026-10-07）。表をまたぐ重なり・「こども」の行・こどもの 6F に使う。
  // 🚨 読めなくても自分の表は使える（重なりを出せないことを断る）
  const otherBoard: ShiftBoard = isAdult ? 'kids' : 'adult';
  const otherName = isAdult ? 'こどもシフト表' : '大人シフト表';
  const [other, setOther] = useState<KidsData | null>(null);
  const [otherErr, setOtherErr] = useState('');
  // 比べる相手＝相手の決定済み（初め）か作業中の案（過去の案は選べない・設計 §4）
  const [otherWith, setOtherWith] = useState<string>('decided');
  const [otherPlanCells, setOtherPlanCells] = useState<KidsPlanCell[]>([]);
  // ── 案を比べる（2026-09-22・2回目の c）──────────────────────────
  // 🚨 いま見ているものと、選んだもう1つを比べて**違うマスに印**を付けるだけ（設計書 5-9）。
  //    書き換えはしない。どちらを採るかは［この案で決定する］のときに選ぶ（既存の仕組み）
  const [compareWith, setCompareWith] = useState<string | null>(null);  // 'decided' か 案のID
  const [compareCells, setCompareCells] = useState<KidsPlanCell[]>([]);
  const [compareErr, setCompareErr] = useState('');
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState('');
  const [drafts, setDrafts] = useState<Record<string, Record<string, KidsCellValue>>>({});
  const [openKey, setOpenKey] = useState<string | null>(null);
  // 大人シフト表：押した帯（その曜日の行のうち、その時刻の帯のものだけを入力に出す）。null＝その曜日のすべて
  const [openBand, setOpenBand] = useState<number | null>(null);
  // 🚨 帯で絞るときは「開いたときにその帯にあった行」を覚えておく（時刻を直して別の帯に移っても、入力中に消えないように）
  const [bandIdx, setBandIdx] = useState<number[] | null>(null);
  // 🚨 帯で絞っているマス（ほかの所からマスを開いたときは絞らない）
  const [bandFor, setBandFor] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  // 🚨 保存の確認は表の下に出るので、開いたらそこまで動かす（2026-09-25・［保存する］が画面の外に出ないように）
  const confirmBoxRef = useScrollIntoViewWhen<HTMLDivElement>(confirming);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState('');
  const [saveMsg, setSaveMsg] = useState('');
  const [stale, setStale] = useState(false);
  const [panel, setPanel] = useState<'none' | 'places' | 'kinds' | 'settings' | 'people' | 'pdf'>('none');
  const [panelErr, setPanelErr] = useState('');
  const [newPlan, setNewPlan] = useState<{ name: string; from: string; copy: string } | null>(null);
  const [decideState, setDecideState] = useState<{ conflicts: { place_id: string; day_kind: string; label: string }[]; keptCount: number; changeCount: number; choices: Record<string, 'plan' | 'decided'> } | null>(null);
  const decideBoxRef = useScrollIntoViewWhen<HTMLDivElement>(decideState);
  const [guard, setGuard] = useState<{ text: string; go: () => void } | null>(null);
  // 変わった所の印（ピンク・2026-10-06）。画面と PDF で別々に外せる（大きく変わったとき・初回の PDF は外す）
  const [markScreen, setMarkScreen] = useState(true);
  const [pdfMark, setPdfMark] = useState(true);
  const [pdfBlank, setPdfBlank] = useState(true);
  // PDF の紙（2026-10-06 ユーザー確定：出すときに選ぶ。A3 は要らない＝プリンターで拡大できる）
  const [pdfLayout, setPdfLayout] = useState<KidsPrintLayout>('two');
  const [showArchived, setShowArchived] = useState(false);

  const plan: KidsPlan | null = useMemo(
    () => (view === 'decided' ? null : (data?.plans ?? []).find(p => p.id === view) ?? null),
    [view, data],
  );
  const baseDate = plan ? plan.apply_from : applyFrom;

  const load = useCallback(async (keepDrafts: boolean) => {
    setLoading(true); setLoadErr('');
    const since = prevDate(baseDate);
    const [k, r, t] = await Promise.all([loadKidsData(since, board), loadRosterData(since), loadKidsToken(board)]);
    if (k.error || !k.data) { setLoadErr(k.error ?? `${boardName}を読み込めませんでした`); setLoading(false); return; }
    if (r.error || !r.data) { setLoadErr(r.error ?? '週のシフトを読み込めませんでした'); setLoading(false); return; }
    if (t.error || t.token == null) { setLoadErr(`保存の準備ができませんでした：${t.error ?? ''}`); setLoading(false); return; }
    setData(k.data); setRoster(r.data); setToken(t.token); setStale(false);
    const st = await loadStudyData(since);
    setStudyVersions(st.data?.versions ?? []);
    setStudyErr(st.error ? `勉強会を読み込めませんでした（勉強会の時間を共通の人から外せません）：${st.error}` : '');
    const o = await loadKidsData(since, otherBoard);
    setOther(o.data);
    setOtherErr(o.error ? `${otherName}を読み込めませんでした（表をまたぐ重なりを出せません）：${o.error}` : '');
    if (!keepDrafts) setDrafts({});
    setLoading(false);
  }, [baseDate, board, boardName, otherBoard, otherName]);

  // 相手の案を選んだら、その案のマスを読む
  useEffect(() => {
    if (otherWith === 'decided') { setOtherPlanCells([]); return; }
    let alive = true;
    void loadPlanCells(otherWith).then(r => {
      if (!alive) return;
      if (r.error) setOtherErr(`${otherName}の案を読み込めませんでした：${r.error}`);
      setOtherPlanCells(r.error ? [] : r.cells);
    });
    return () => { alive = false; };
  }, [otherWith, otherName]);

  useEffect(() => { void load(true); }, [load]);

  // 案を切り替えたら、その案のマスを読む
  useEffect(() => {
    if (!plan) { setPlanCells([]); return; }
    let alive = true;
    void loadPlanCells(plan.id).then(r => {
      if (!alive) return;
      if (r.error) setLoadErr(r.error); else setPlanCells(r.cells);
    });
    return () => { alive = false; };
  }, [plan]);

  const names = useMemo(
    () => shortNameMap((data?.staff ?? []).map(s => ({ id: s.id, name: s.name, is_active: s.is_active })), data?.labels ?? new Map()),
    [data],
  );
  const nameOf = useCallback((id: string) => names.get(id) ?? fullName((data?.staff ?? []).find(s => s.id === id)?.name ?? '（不明）'), [names, data]);
  const canLesson = useMemo(
    () => makeCanLesson(data?.flags ?? new Map(), (data?.staff ?? []).map(s => ({ id: s.id, employment_type: s.employment_type }))),
    [data],
  );
  const inactive = useMemo(() => new Set((data?.staff ?? []).filter(s => !s.is_active).map(s => s.id)), [data]);
  const rowsByUser = useMemo(() => {
    const m = new Map<string, RosterPatternRow[]>();
    for (const r of roster?.patterns ?? []) m.set(r.user_id, [...(m.get(r.user_id) ?? []), r]);
    return m;
  }, [roster]);

  const viewDrafts = useMemo(() => drafts[view] ?? {}, [drafts, view]);
  const dirtyCount = Object.keys(viewDrafts).length;
  const anyDirty = Object.values(drafts).some(d => Object.keys(d).length > 0);

  const savedCell = useCallback((placeId: string, d: string): KidsCellValue => {
    if (!data) return [];
    if (plan) return mergeCell(data.cells, planCells, placeId, d, plan.apply_from);
    return cellVersionOn(data.cells, placeId, d, applyFrom)?.items ?? [];
  }, [data, plan, planCells, applyFrom]);

  const shownCell = useCallback((placeId: string, d: string): KidsCellValue =>
    viewDrafts[cellKey(placeId, d)] ?? savedCell(placeId, d), [viewDrafts, savedCell]);

  // 赤字の比べ先：決定済み＝前の日／案＝決定済みの表（その案の予定の適用開始日）
  const baseCell = useCallback((placeId: string, d: string): KidsCellValue => {
    if (!data) return [];
    const date = plan ? plan.apply_from : prevDate(applyFrom);
    return cellVersionOn(data.cells, placeId, d, date)?.items ?? [];
  }, [data, plan, applyFrom]);

  // 比べる相手の案のマスを読む。🚨 読めなかったときは黙って「同じ」にせず、理由を出す
  useEffect(() => {
    if (!compareWith || compareWith === 'decided') { setCompareCells([]); setCompareErr(''); return; }
    let alive = true;
    void loadPlanCells(compareWith).then(r => {
      if (!alive) return;
      setCompareErr(r.error ? `比べる案を読み込めませんでした：${r.error}` : '');
      setCompareCells(r.error ? [] : r.cells);
    });
    return () => { alive = false; };
  }, [compareWith]);

  /** 比べる相手のマスの中身。🚨 案は「変えたマスだけ」を持つので、
   *  触っていないマスは決定済みの表から借りる（画面と同じ mergeCell を使う） */
  const compareCell = useCallback((placeId: string, d: string): KidsCellValue => {
    if (!data || !compareWith) return [];
    if (compareWith === 'decided') return cellVersionOn(data.cells, placeId, d, applyFrom)?.items ?? [];
    const p = data.plans.find(x => x.id === compareWith);
    return mergeCell(data.cells, compareCells, placeId, d, p?.apply_from ?? applyFrom);
  }, [data, compareWith, compareCells, applyFrom]);

  const isDiff = useCallback((placeId: string, d: string): boolean => {
    if (!compareWith || compareErr) return false;
    return !cellEquals(shownCell(placeId, d), compareCell(placeId, d));
  }, [compareWith, compareErr, shownCell, compareCell]);


  const changedKeys = useMemo(
    () => Object.keys(viewDrafts).filter(k => {
      const [placeId, d] = k.split('|');
      return !cellEquals(viewDrafts[k], savedCell(placeId, d));
    }),
    [viewDrafts, savedCell],
  );

  const setCell = (placeId: string, d: string, v: KidsCellValue) => {
    setSaveMsg(''); setSaveErr('');
    setDrafts(prev => ({ ...prev, [view]: { ...(prev[view] ?? {}), [cellKey(placeId, d)]: v } }));
  };
  const revertCell = (key: string) => setDrafts(prev => {
    const forView = { ...(prev[view] ?? {}) };
    delete forView[key];
    return { ...prev, [view]: forView };
  });

  // 🚨 未保存のまま切り替えると消えるので、切り替える前に聞く（レビュー U1）
  const guarded = (label: string, go: () => void) => {
    if (dirtyCount > 0) { setGuard({ text: label, go }); return; }
    go();
  };

  const places = useMemo(() => data?.places ?? [], [data]);
  const placeLabel = useCallback((id: string) => (data?.places ?? []).find(p => p.id === id)?.label ?? '（不明な列）', [data]);
  const activeColumns = useMemo(() => places.filter(p => p.kind === 'column' && p.active).sort((a, b) => a.sort_order - b.sort_order), [places]);
  const heads = useMemo(() => places.filter(p => p.kind === 'head' && p.active).sort((a, b) => a.sort_order - b.sort_order), [places]);
  const dayNotePlace = useMemo(() => places.find(p => p.kind === 'daynote' && p.active) ?? null, [places]);
  // 大人シフト表の出張の細い列（kind='trip'・大人だけ）
  const tripPlaces = useMemo(() => places.filter(p => p.kind === 'trip' && p.active), [places]);
  /** 終わりが無い行の長さ（行の種類ごと・管理画面で直せる） */
  const defMinOf = useCallback((k: string) => data?.rowKinds.find(r => r.key === k)?.default_minutes ?? (isAdult ? 30 : 50), [data, isAdult]);
  /** ⚠️・重なりの判定に渡す中身。🚨 大人は前後半と終わりの無い行の時間を埋めてから渡す（判定はこどもと同じものを使う） */
  const judgedCell = useCallback((placeId: string, d: string): KidsCellValue =>
    (isAdult ? withPersonSpans(shownCell(placeId, d), defMinOf) : shownCell(placeId, d)), [isAdult, shownCell, defMinOf]);

  // ─── 相手の表（2026-10-07） ───
  const otherPlan = useMemo(() => (otherWith === 'decided' ? null : other?.plans.find(p => p.id === otherWith && p.status === 'open') ?? null), [other, otherWith]);
  /** 相手の表のマス。decidedOnly＝いつも決定済み（決定を止める判定はいつも相手の決定済みで見る・設計 §4） */
  const otherCellOf = useCallback((placeId: string, d: string, decidedOnly = false): KidsCellValue => {
    if (!other) return [];
    if (!decidedOnly && otherPlan) return mergeCell(other.cells, otherPlanCells, placeId, d, otherPlan.apply_from);
    return cellVersionOn(other.cells, placeId, d, baseDate)?.items ?? [];
  }, [other, otherPlan, otherPlanCells, baseDate]);
  /** その表の、その曜日の全員の時間（表をまたぐ重なり・「こども」の行に使う） */
  const entriesFor = useCallback((b: ShiftBoard, d: RosterDayKind, decidedOnly = false): CrossEntry[] => {
    const mine = b === board;
    const src = mine ? data : other;
    if (!src) return [];
    const ps = src.places.filter(p => p.active && (p.kind === 'column' || p.kind === 'trip' || p.kind === 'pool'));
    const cellFn = (pid: string) => (mine ? shownCell(pid, d) : otherCellOf(pid, d, decidedOnly));
    const isCls = (it: KidsItem) => (b === 'adult' ? it.kind === ADULT_CLASS_KIND : !!src.rowKinds.find(k => k.key === it.kind)?.has_groups);
    const def = (k: string) => src.rowKinds.find(r => r.key === k)?.default_minutes ?? (b === 'adult' ? 30 : 50);
    return crossEntriesOf(b, ps.map(p => ({ place: p, items: cellFn(p.id) })), isCls, def, placeShort);
  }, [board, data, other, shownCell, otherCellOf]);
  const crossOf = useCallback((decidedOnly: boolean) => KIDS_WEEK.flatMap(d =>
    crossOverlaps(entriesFor('kids', d, decidedOnly), entriesFor('adult', d, decidedOnly)).map(o => ({ ...o, day: d }))), [entriesFor]);
  /** こども×大人の重なり（いま選んでいる相手と） */
  const cross = useMemo(() => (other ? crossOf(false) : []), [other, crossOf]);
  /** 大人を決定してよいか：こどもの決定済みとの 🔴 の数（設計 §4「大人はこどもとの 🔴 で決定できない」） */
  const crossRedVsDecided = useMemo(() => (other && isAdult ? crossOf(true).filter(o => o.level === 'red').length : 0), [other, isAdult, crossOf]);
  // こどもの表の「本校 6F」＝大人シフト表から自動で出す（6F は大人シフト表だけに入れる決まり・設計 §4）
  const kids6F = useMemo(() => (isAdult ? null : activeColumns.find(c => c.school === '四条本校' && c.floor === '6F') ?? null), [isAdult, activeColumns]);
  const adultMainOfOther = useMemo(() => (isAdult ? null : other?.places.find(p => p.kind === 'column' && p.active) ?? null), [isAdult, other]);
  const adult6FOf = useCallback((d: string): KidsCellValue => (adultMainOfOther ? otherCellOf(adultMainOfOther.id, d) : []), [adultMainOfOther, otherCellOf]);
  // 勉強会（2026-10-07）。その曜日に効いている版を、同じ校・同じ階の列に出す（階が無い勉強会はその校の最初の列）。
  // 🚨 kind='study' の仮の行にして、帯・共通の人の判定に使う（保存はしない・マスの中身にも入れない）
  // 🚨 2026-10-07 担当の依頼：大人の部門の勉強会は、参加者が全員大人の部門なら出さない（記載不要）。
  //    こどもの先生が入っているものは、階が無ければ「本校 6F」の列に出す（3F で勉強会をしているように見えないように）
  const adultAreaId = useMemo(() => roster?.areas.find(a => a.name === '大人')?.id ?? null, [roster]);
  const mainAreaOf = useMemo(() => new Map((data?.staff ?? []).map(s => [s.id, s.main_area ?? ''])), [data]);
  const studyColumnOf = useCallback((v: StudyVersion) => {
    const ofSchool = activeColumns.filter(c => c.school === v.location);
    if (!isAdult && adultAreaId != null && v.area_id === adultAreaId) {
      if (v.members.length > 0 && v.members.every(u => mainAreaOf.get(u) === '大人')) return null;
      return ofSchool.find(c => (v.floor ? c.floor === v.floor : c.floor === '6F')) ?? ofSchool[0] ?? null;
    }
    return ofSchool.find(c => (v.floor ? c.floor === v.floor : true)) ?? null;
  }, [activeColumns, isAdult, adultAreaId, mainAreaOf]);
  const studyOfPlace = useCallback((placeId: string, d: RosterDayKind) =>
    versionsOnDate(studyVersions, baseDate).filter(v => v.day_kind === d && studyColumnOf(v)?.id === placeId)
      .sort((a, b) => studyStartMin(a) - studyStartMin(b)), [studyVersions, baseDate, studyColumnOf]);
  const studyItemsOf = useCallback((placeId: string, d: RosterDayKind): KidsItem[] =>
    studyOfPlace(placeId, d).map(v => ({
      ...emptyItem('study'), start: minText(studyStartMin(v)), end: minText(studyEndMin(v)),
      people: v.members.map(u => ({ user_id: u, role: 'lead' as const, start: '', end: '' })),
    })), [studyOfPlace]);
  // 「3F・5F で動ける人」（共通の人）の置き場所（校ごとに1つ・2026-10-06。いまは四条本校だけ）
  const poolPlaces = useMemo(() => places.filter(p => p.kind === 'pool' && p.active), [places]);
  const poolOfSchool = useCallback((school: string | null) => poolPlaces.find(p => p.school === school) ?? null, [poolPlaces]);
  /** 共通の人で回せる列か（共通の置き場所がある校の 3F・5F） */
  const isPoolColumn = useCallback((p: KidsPlace | undefined) =>
    !!p && p.kind === 'column' && !!poolOfSchool(p.school) && (p.floor === '3F' || p.floor === '5F'), [poolOfSchool]);
  /** クラス（班のある行＝帯の目印・共通で回せる行） */
  const isClassItem = useCallback((it: KidsItem) => !!data?.rowKinds.find(k => k.key === it.kind)?.has_groups, [data]);
  /** その曜日の共通の行を組み立てる材料（画面・PDF で同じものを使う） */
  const poolCtxOf = useCallback((d: RosterDayKind, poolPlace: KidsPlace, cellOf: (placeId: string, d: string) => KidsCellValue = shownCell) => {
    const cell = cellOf(poolPlace.id, d);
    return {
      poolPlace,
      poolItem: cell.find(it => it.kind === 'pool') ?? null,
      sources: activeColumns.map(p => ({ place: p, items: [...cellOf(p.id, d), ...studyItemsOf(p.id, d)] })),
      poolColumnIds: new Set(activeColumns.filter(p => p.school === poolPlace.school && isPoolColumn(p)).map(p => p.id)),
      isClass: isClassItem,
      kindLabel: (k: string) => (k === 'study' ? '勉強会' : data?.rowKinds.find(r => r.key === k)?.label ?? k),
      defaultMinutes: (k: string) => data?.rowKinds.find(r => r.key === k)?.default_minutes ?? 50,
      requiredOf: (it: KidsItem) => it.required ?? (data ? defaultsForGroups(data.settings, it.groups).required : 0),
      shiftOf: (uid: string) => {
        const day = shiftDayOn(rowsByUser.get(uid) ?? [], d, baseDate);
        if (!day) return null;
        return day.segments.map(g => ({ s: toMin(normTime(g.start)) ?? 0, e: toMin(normTime(g.end)) ?? 0 })).filter(x => x.e > x.s);
      },
    };
  }, [shownCell, activeColumns, isPoolColumn, isClassItem, data, studyItemsOf, rowsByUser, baseDate]);

  const hasContent = useCallback((placeId: string, d: string) =>
    shownCell(placeId, d).length > 0 || (placeId === kids6F?.id && adult6FOf(d).length > 0)
    || (!isAdult && studyOfPlace(placeId, d as RosterDayKind).length > 0), [shownCell, kids6F, adult6FOf, isAdult, studyOfPlace]);
  const [extraColumns, setExtraColumns] = useState<Set<string>>(new Set());
  const columnsOfDay = useCallback((d: RosterDayKind) =>
    activeColumns.filter(p => hasContent(p.id, d) || extraColumns.has(`${p.id}|${d}`)), [activeColumns, hasContent, extraColumns]);

  // 追加必要・重なり
  const shortfalls = useMemo(() => {
    if (!data) return [] as { place: KidsPlace; day: RosterDayKind; item: KidsItem; need: number; lessonNeed: number }[];
    const out: { place: KidsPlace; day: RosterDayKind; item: KidsItem; need: number; lessonNeed: number }[] = [];
    for (const d of KIDS_WEEK) for (const p of activeColumns) {
      for (const it of shownCell(p.id, d)) {
        if (it.use_pool && isPoolColumn(p)) continue;   // 共通の人で回すクラスは、共通の行で数える
        const s = shortfallOf(it, data.settings, canLesson, inactive);
        if (s) out.push({ place: p, day: d, item: it, need: s.need, lessonNeed: s.lessonNeed });
      }
    }
    return out;
  }, [data, activeColumns, shownCell, canLesson, inactive, isPoolColumn]);

  // ⚠️（出勤していない・2026-09-22）。
  // 🚨 判定は lib/kidsShift.ts の kidsCellIssues（中身は ④掃除担当表・③勉強会と同じ shiftTimeIssue）。
  //    ここで書き直さない。
  // 🚨 保存は止めない。印を出すだけ（設計書 5-9「保存は止めない・［確認した］」）
  const issuesOf = useCallback((placeId: string, d: RosterDayKind): KidsIssue[] => {
    if (!data) return [];
    const place = data.places.find(p => p.id === placeId);
    return kidsCellIssues(
      placeId, d, judgedCell(placeId, d),
      uid => shiftDayOn(rowsByUser.get(uid) ?? [], d, baseDate) ?? null,
      k => data.rowKinds.find(r => r.key === k)?.issue_mode ?? 'full',
      new Map(data.staff.map(s => [s.id, data.labels.get(s.id) || s.name])),
      inactive,
      place?.school ?? null,
    );
  }, [data, judgedCell, rowsByUser, baseDate, inactive]);

  /** ⚠️ を見る置き場所（こども＝列・校の見出し・共通の人／大人＝クラスの列・出張） */
  const issuePlaces = useMemo(() => (isAdult
    ? [...activeColumns, ...tripPlaces]
    : activeColumns.concat(heads, poolPlaces)), [isAdult, activeColumns, tripPlaces, heads, poolPlaces]);

  /** その ⚠️ が「確認した」になっているか。
   *  🚨 案を見ているときは案のマス、決定済みの表を見ているときはそのマスに付く（別々に数える） */
  const ackOwner = useCallback((placeId: string, d: RosterDayKind): { cellId: string } | { planCellId: string } | null => {
    if (!data) return null;
    if (plan) {
      const pc = planCells.find(c => c.place_id === placeId && c.day_kind === d);
      return pc ? { planCellId: pc.id } : null;
    }
    const v = cellVersionOn(data.cells, placeId, d, applyFrom);
    return v ? { cellId: v.id } : null;
  }, [data, plan, planCells, applyFrom]);

  const isAcked = useCallback((placeId: string, d: RosterDayKind, key: string): boolean => {
    const o = ackOwner(placeId, d);
    if (!o || !data) return false;
    return data.acks.some(a => a.issue_key === key
      && ('cellId' in o ? a.cell_id === o.cellId : a.plan_cell_id === o.planCellId));
  }, [ackOwner, data]);

  /** ⚠️ の数（確認済みを除いたもの／確認済みの数）。見出しの「⚠️ 5件（確認済み 3）」に使う */
  const issueCount = useMemo(() => {
    let open = 0, acked = 0;
    for (const d of KIDS_WEEK) for (const p of issuePlaces) {
      for (const i of issuesOf(p.id, d)) {
        if (isAcked(p.id, d, i.key)) acked++; else open++;
      }
    }
    return { open, acked };
  }, [issuePlaces, issuesOf, isAcked]);

  const ackIssue = async (placeId: string, d: RosterDayKind, key: string) => {
    const o = ackOwner(placeId, d);
    // 🚨 まだ保存していないマスには付けられない（付ける先が無い）。黙って何もしないのではなく断る
    if (!o) { setSaveErr('先にこのマスを保存してください（保存したものに「確認した」を付けます）'); return; }
    setSaveErr('');
    const e = await ackKidsIssue(o, key);
    if (e) { setSaveErr(e); return; }
    await load(true);
  };

  const diffCount = useMemo(() => {
    if (!compareWith) return 0;
    let n = 0;
    for (const d of KIDS_WEEK) for (const p of (isAdult ? [...activeColumns, ...tripPlaces] : activeColumns)) if (isDiff(p.id, d)) n++;
    return n;
  }, [compareWith, activeColumns, tripPlaces, isAdult, isDiff]);
  // 重なり。names＝相手の呼び名（大人は同じ列の中の行どうしも比べるので、行ごとに名前を付ける）
  const overlapData = useMemo(() => {
    const out: { day: RosterDayKind; userId: string; a: string; b: string; start: string; end: string }[] = [];
    const names = new Map<string, string>();
    for (const d of KIDS_WEEK) {
      // 🚨 大人は1つの列（6F）にすべてのクラスが入るので、行ごとに分けて渡す（同じ列の中の掛け持ちも重なり）。
      //    前半と後半の人は personSpanOf の時間で比べる（同じ人が前半サポート・後半担当でも重ならない）
      const sources = isAdult
        ? [...activeColumns, ...tripPlaces].flatMap(p => judgedCell(p.id, d).map((it, i) => {
          const id = `${p.id}#${i}`;
          names.set(id, `${normTime(it.start)} ${it.class_name || (data?.rowKinds.find(r => r.key === it.kind)?.label ?? '')}`.trim());
          return { placeId: id, items: [it] };
        }))
        : activeColumns.map(p => ({ placeId: p.id, items: shownCell(p.id, d) }));
      for (const o of overlapsOfDay(d, sources)) {
        out.push({ day: d, userId: o.userId, a: o.aPlaceId, b: o.bPlaceId, start: o.start, end: o.end });
      }
    }
    return { list: out, names };
  }, [activeColumns, tripPlaces, isAdult, judgedCell, shownCell, data]);
  const overlaps = overlapData.list;

  const offOfDay = useCallback((d: RosterDayKind) => {
    if (!data) return [];
    const has = (uid: string) => !!shiftDayOn(rowsByUser.get(uid) ?? [], d, baseDate)?.segments?.length;
    // 🚨 大人の休みの行＝メインの部門が大人の人（正社員もパートも・2026-10-06 ユーザー確定）で、その曜日に勤務予定がない人
    if (isAdult) return data.staff.filter(s => s.is_active && (s.main_area ?? '') === '大人' && !has(s.id));
    return offStaffOfDay(data.staff, has);
  }, [data, rowsByUser, baseDate, isAdult]);

  // ─── 保存 ───
  const isPast = !plan && applyFrom < today;
  const keptFuture = useMemo(() => changedKeys.map(k => {
    const [placeId, d] = k.split('|');
    const next = (data?.cells ?? []).filter(c => c.place_id === placeId && c.day_kind === d && c.valid_from > baseDate)
      .map(c => c.valid_from).sort()[0];
    return next ? `${placeLabel(placeId)}（${ROSTER_DAY_LABEL[d as RosterDayKind]}）は ${md(next)} からの変更があるので、${md(prevDate(next))} まで` : null;
  }).filter((x): x is string => !!x), [changedKeys, data, baseDate, placeLabel]);

  const emptied = useMemo(() => changedKeys.filter(k => viewDrafts[k].length === 0).length, [changedKeys, viewDrafts]);

  const doSaveDecided = async () => {
    if (token == null) return;
    setSaving(true); setSaveErr(''); setSaveMsg('');
    const r = await saveKidsCells({
      board, apply_from: applyFrom, base_token: token, confirm_past: isPast,
      cells: toPayloadCells(changedKeys.map(k => {
        const [placeId, d] = k.split('|');
        return { placeId, day: d, items: viewDrafts[k] };
      })),
    });
    setSaving(false);
    if (r.error) { setSaveErr(`保存できませんでした：${r.error}`); return; }
    if (!r.ok && r.reason === 'stale') {
      setStale(true); setConfirming(false);
      setSaveErr(`開いたあとに、別の人が${boardName}を保存しました。上書きしないよう保存を止めました。「読み込み直す」を押すと、直した内容は残したまま最新の状態と比べ直せます。`);
      return;
    }
    if (!r.ok) { setSaveErr('保存できませんでした（今日より前の日付の確認が必要です）'); return; }
    setConfirming(false); setOpenKey(null);
    setDrafts(prev => ({ ...prev, decided: {} }));
    setSaveMsg(`保存しました（${applyFrom} から・変えたマス ${r.changed ?? 0}${r.unchanged ? `・同じ内容 ${r.unchanged}` : ''}${(r.kept_future?.length ?? 0) > 0 ? `・先の変更を残したマス ${r.kept_future?.length}` : ''}）`);
    await load(false);
  };

  const doSavePlan = async () => {
    if (!plan) return;
    setSaving(true); setSaveErr(''); setSaveMsg('');
    const r = await savePlan({
      op: 'cells', plan_id: plan.id, revision: plan.revision,
      cells: toPayloadCells(changedKeys.map(k => {
        const [placeId, d] = k.split('|');
        return { placeId, day: d, items: viewDrafts[k] };
      })),
    });
    setSaving(false);
    if (r.error) { setSaveErr(`保存できませんでした：${r.error}`); return; }
    if (!r.ok && r.reason === 'conflict') {
      setSaveErr('開いたあとに、別の人がこの案を保存しました。上書きしないよう保存を止めました。「読み込み直す」を押してください（直した内容は残ります）。');
      setStale(true);
      return;
    }
    if (!r.ok) { setSaveErr(`保存できませんでした（${r.reason ?? ''}）`); return; }
    setConfirming(false); setOpenKey(null);
    setDrafts(prev => ({ ...prev, [plan.id]: {} }));
    setSaveMsg(`${plan.name}を保存しました（変えたマス ${r.changed ?? 0}${(r.removed as number ?? 0) > 0 ? `・決定済みと同じに戻したマス ${r.removed}` : ''}）`);
    await load(false);
  };

  // ─── 案 ───
  const createPlan = async () => {
    if (!newPlan) return;
    if (!newPlan.name.trim()) { setPanelErr('案の名前を入れてください'); return; }
    setPanelErr('');
    const r = await savePlan({ op: 'create', board, name: newPlan.name.trim(), apply_from: newPlan.from, copy_from: newPlan.copy || null });
    if (r.error) { setPanelErr(`作れませんでした：${r.error}`); return; }
    if (!r.ok && r.reason === 'plan_limit') { setPanelErr(`作業中の案が${r.limit}個あります。使わない案を［この案を使わない］で過去の案に移してから、新しい案を作ってください。`); return; }
    if (!r.ok) { setPanelErr(`作れませんでした（${r.reason ?? ''}）`); return; }
    setNewPlan(null);
    await load(true);
    setView(String(r.plan_id));
  };

  const archivePlan = async (p: KidsPlan) => {
    setPanelErr('');
    const r = await savePlan({ op: 'archive', plan_id: p.id, revision: p.revision });
    if (r.error || !r.ok) { setPanelErr(`過去の案に移せませんでした：${r.error ?? r.reason ?? ''}`); return; }
    if (view === p.id) setView('decided');
    await load(true);
  };

  const startDecide = async () => {
    if (!plan || token == null) return;
    // 🚨 大人はこどもの決定済みとの 🔴 があると決定できない（案の保存はできる・設計 §4。決める順番＝こども→大人）
    if (isAdult && crossRedVsDecided > 0) {
      setSaveErr(`こどもシフト表（決定済み）と 🔴 の重なりが ${crossRedVsDecided} 件あります。直してから決定してください（案の保存はできます）。`);
      return;
    }
    setSaving(true); setSaveErr('');
    const r = await decidePlan({ plan_id: plan.id, revision: plan.revision, apply_from: plan.apply_from, confirm: false, base_token: token });
    setSaving(false);
    if (r.error) { setSaveErr(`決定できませんでした：${r.error}`); return; }
    if (r.reason === 'stale') { setStale(true); setSaveErr('開いたあとに、別の人が保存しました。「読み込み直す」を押してください。'); return; }
    if (r.reason === 'conflict') { setStale(true); setSaveErr('開いたあとに、別の人がこの案を保存しました。「読み込み直す」を押してください。'); return; }
    if (r.reason === 'past_confirm') { setSaveErr('予定の適用開始日が今日より前です。案の日付を直してください。'); return; }
    if (r.reason !== 'confirm') { setSaveErr(`決定できませんでした（${r.reason ?? ''}）`); return; }
    const conflicts = (r.conflicts as { place_id: string; day_kind: string; label: string }[]) ?? [];
    setDecideState({
      conflicts,
      keptCount: (r.kept_future as unknown[] ?? []).length,
      changeCount: Number(r.change_count ?? 0),
      choices: Object.fromEntries(conflicts.map(c => [cellKey(c.place_id, c.day_kind), 'plan' as const])),
    });
  };

  const doDecide = async () => {
    if (!plan || token == null || !decideState) return;
    setSaving(true); setSaveErr('');
    const r = await decidePlan({
      plan_id: plan.id, revision: plan.revision, apply_from: plan.apply_from, confirm: true, base_token: token,
      choices: Object.entries(decideState.choices).map(([k, use]) => {
        const [place_id, day_kind] = k.split('|');
        return { place_id, day_kind, use };
      }),
    });
    setSaving(false);
    if (r.error) { setSaveErr(`決定できませんでした：${r.error}`); return; }
    if (!r.ok) { setSaveErr(`決定できませんでした（${r.reason ?? ''}）`); setStale(r.reason === 'stale'); return; }
    setDecideState(null);
    setView('decided');
    setApplyFrom(plan.apply_from);
    setSaveMsg(`${plan.name}を決定しました（${plan.apply_from} から・変えたマス ${r.changed ?? 0}${(r.skipped as number ?? 0) > 0 ? `・決定済みを残したマス ${r.skipped}` : ''}）`);
    await load(false);
  };

  // ─── PDF ───
  /** PDF。onlySchool を渡すとその校だけ出す（校ごとの PDF・2026-09-22） */
  const printPdf = (onlySchool?: string) => {
    if (!data) return;
    const off: Partial<Record<RosterDayKind, string[]>> = {};
    const dayNotes: Partial<Record<RosterDayKind, string[]>> = {};
    for (const d of KIDS_WEEK) {
      off[d] = offOfDay(d).map(s => nameOf(s.id));
      dayNotes[d] = dayNotePlace ? shownCell(dayNotePlace.id, d).map(it => it.note).filter(Boolean) : [];
    }
    // 🚨 画面と同じ組み立て（時刻の帯・共通の行・行の文字）を使う。PDF だけ別の作り方にしない
    const colsOf = (d: RosterDayKind) => columnsOfDay(d).filter(c => !onlySchool || c.school === onlySchool);
    const bandCache = new Map<RosterDayKind, KidsBand[]>();
    const bandsOf = (d: RosterDayKind): KidsBand[] => {
      let b = bandCache.get(d);
      if (!b) {
        b = bandsOfDay(colsOf(d).map(c => ({ placeId: c.id, items: [...shownCell(c.id, d), ...studyItemsOf(c.id, d)] })), isClassItem);
        if (b.length === 0) b = [{ from: 0, to: null, label: '' }];
        bandCache.set(d, b);
      }
      return b;
    };
    const fmtCommon = (r: ReturnType<typeof poolRowOfBand>) => r.common.map(x => `${nameOf(x.userId)}${x.note}`).join('・');
    const fmtOther = (r: ReturnType<typeof poolRowOfBand>) => r.other.map(x => `${nameOf(x.userId)}${x.where ? `（${x.where}）` : ''}`).join('・');
    const html = buildKidsPrintHtml({
      title: `${md(baseDate)}〜 こどもシフト表${plan ? ` ${plan.name}` : ''}${onlySchool ? `（${onlySchool}）` : ''}`,
      asOf: today,
      notes: (data.notes ?? []).filter(n => n.active).map(n => n.body),
      columnsOf: colsOf,
      bandsOf,
      // 🚨 勉強会の行は、いまの文字と比べる先の文字の両方に同じものを足す（勉強会で変わった所の印を付けない）
      cellOf: (placeId, d, bi) => ({
        lines: [...linesOfItems(placeId, itemsByBand(shownCell(placeId, d), bandsOf(d))[bi] ?? [], pdfBlank), ...studyLinesOf(placeId, d, bandsOf(d), bi)],
        base: [...linesOfItems(placeId, itemsByBand(baseCell(placeId, d), bandsOf(d))[bi] ?? [], pdfBlank), ...studyLinesOf(placeId, d, bandsOf(d), bi)],
      }),
      poolOf: (d, bi) => {
        const cs = colsOf(d);
        for (const pp of poolPlaces) {
          const ids = cs.filter(c => c.school === pp.school && isPoolColumn(c)).map(c => c.id);
          if (ids.length === 0) continue;
          const first = cs.findIndex(c => c.id === ids[0]);
          if (!ids.every((id, j) => cs[first + j]?.id === id)) continue;
          const b = bandsOf(d)[bi];
          const r = poolRowOfBand(b, poolCtxOf(d, pp));
          if (!r.show) return null;
          const rb = poolRowOfBand(b, poolCtxOf(d, pp, baseCell));
          return { placeIds: ids, common: fmtCommon(r), other: fmtOther(r), baseCommon: fmtCommon(rb), baseOther: fmtOther(rb) };
        }
        return null;
      },
      headOf: (school, d) => {
        const head = heads.find(h => h.school === school);
        if (!head) return [];
        return shownCell(head.id, d).map(it => itemText(it, nameOf, k => data.roleKinds.find(r => r.key === k)?.label ?? k));
      },
      markChanges: pdfMark, offStaff: off, dayNotes, layout: pdfLayout,
    });
    setPanelErr(openRosterPrint(html) ?? '');
  };

  if (loading && !data) return <p style={{ color: subText }}>読み込んでいます...</p>;
  if (loadErr && !data) return <p style={{ color: red }}>{loadErr}</p>;
  if (!data || !roster) return null;

  /** 校ごとの PDF に出す校（列がある校だけ・並びは列の順） */
  const schools = [...new Set(places.filter(p => p.kind === 'column' && p.active).map(p => p.school).filter(Boolean))] as string[];

  const roleLabel = (k: string) => data.roleKinds.find(r => r.key === k)?.label ?? k;
  const kindLabel = (k: string) => k === 'role' ? '見出しの役割' : k === 'daynote' ? '曜日の書き添え'
    : data.rowKinds.find(r => r.key === k)?.label ?? k;
  /** Excel（2026-09-22・ユーザー確定 案ウ＝シートを2つに分ける）。
   *  🚨 中身の組み立ては lib/kidsShift.ts（画面を開かずに検算できる側）。ここは書き出すだけ。
   *  🚨 xlsx は重いので、押されたときだけ読み込む（ほかの画面を遅くしない・既存のやり方と同じ） */
  const exportExcel = async () => {
    setPanelErr('');
    try {
      const XLSX = await import('xlsx');
      const wb = XLSX.utils.book_new();
      const grid = XLSX.utils.aoa_to_sheet(kidsGridSheet(
        KIDS_WEEK, d => ROSTER_DAY_LABEL[d], places, d => columnsOfDay(d),
        (placeId, d) => cellLinesOf(placeId, d),
        // 共通の行（2026-10-07）。本校 3F・5F の最後の列のすぐ下に、時刻ごとに1行
        poolPlaces.map(pp => {
          const last = activeColumns.filter(c => c.school === pp.school && isPoolColumn(c)).at(-1);
          return {
            afterPlaceId: last?.id ?? '',
            label: `${pp.school} 3F・5F 共通`,
            linesOf: (d: RosterDayKind) => {
              const ctx = poolCtxOf(d, pp);
              const bands = bandsOfDay(activeColumns.map(c => ({ placeId: c.id, items: [...shownCell(c.id, d), ...studyItemsOf(c.id, d)] })), isClassItem);
              return bands.map(b => ({ b, r: poolRowOfBand(b, ctx) })).filter(x => x.r.show).map(({ b, r }) =>
                `${b.label} 共通：${r.common.map(x => `${nameOf(x.userId)}${x.note}`).join('・') || 'なし'}`
                + (r.other.length > 0 ? `／他業務：${r.other.map(o => `${nameOf(o.userId)}${o.where ? `（${o.where}）` : ''}`).join('・')}` : ''));
            },
          };
        }),
      ));
      grid['!cols'] = [{ wch: 16 }, ...KIDS_WEEK.map(() => ({ wch: 26 }))];
      XLSX.utils.book_append_sheet(wb, grid, '表');
      const list = XLSX.utils.aoa_to_sheet(kidsListSheet(
        // 🚨 「3F・5F で動ける人」も一覧に出す（人ごとに何時から何時まで）
        KIDS_WEEK, d => ROSTER_DAY_LABEL[d], d => [...columnsOfDay(d), ...poolPlaces.filter(pp => shownCell(pp.id, d).length > 0)],
        // 🚨 人の役割の呼び名（担当・（ ）・見守り…）。見出しの役割の呼び名（roleLabel）とは別
        (placeId, d) => shownCell(placeId, d), kindLabel, k => PERSON_ROLE_LABEL[k as KidsPerson['role']] ?? k, nameOf,
      ));
      list['!cols'] = [6, 12, 6, 16, 12, 7, 7, 14, 5, 12, 10, 24].map(wch => ({ wch }));
      XLSX.utils.book_append_sheet(wb, list, '一覧');
      const name = `こどもシフト表_${md(baseDate)}${plan ? `_${plan.name}` : ''}`.replace(/[\\/:*?"<>|]/g, '');
      XLSX.writeFile(wb, `${name}.xlsx`);
    } catch (e) {
      // 🚨 黙って何も起きないのがいちばん困る。理由をそのまま出す
      setPanelErr(`Excelを作れませんでした：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const activeStaff = data.staff.filter(s => s.is_active);
  const openPlans = data.plans.filter(p => p.status === 'open');
  const archivedPlans = data.plans.filter(p => p.status === 'archived');

  // ─── マスの入力 ───
  const itemEditor = (placeId: string, d: RosterDayKind, it: KidsItem, i: number, all: KidsCellValue) => {
    const place = places.find(p => p.id === placeId);
    const setItem = (patch: Partial<KidsItem>) =>
      setCell(placeId, d, all.map((x, j) => (j === i ? { ...x, ...patch } : x)));
    const setPerson = (pi: number, patch: Partial<KidsPerson>) =>
      setItem({ people: it.people.map((p, j) => (j === pi ? { ...p, ...patch } : p)) });
    const kind = data.rowKinds.find(k => k.key === it.kind);
    const isRole = it.kind === 'role';
    const isNote = it.kind === 'daynote';
    const def = defaultsForGroups(data.settings, it.groups);
    return (
      <div key={i} style={{ padding: '8px 10px', borderRadius: 8, border: `1px solid ${borderColor}`, background: innerBg, marginBottom: 6 }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <b style={{ fontSize: 12.5 }}>{kindLabel(it.kind)}</b>
          {isRole && (
            <select value={it.role_key ?? ''} style={inputStyle} onChange={e => setItem({ role_key: e.target.value })}>
              <option value="">役割を選ぶ</option>
              {data.roleKinds.filter(r => r.active).map(r => <option key={r.key} value={r.key}>{r.label}</option>)}
            </select>
          )}
          {!isRole && !isNote && (
            <>
              <input type="time" step={300} value={it.start} style={inputStyle} onChange={e => setItem({ start: e.target.value })} />
              <span style={{ color: subText }}>〜</span>
              <input type="time" step={300} value={it.end} style={inputStyle} onChange={e => setItem({ end: e.target.value })} />
            </>
          )}
          {kind?.has_class && (
            <input type="text" value={it.class_name} maxLength={30}
              placeholder={it.kind === ADULT_TRIP_KIND ? '出張先（例：上牧）' : isAdult ? 'クラス名（例：中級）' : 'クラス名（例：リトル）'}
              style={{ ...inputStyle, width: 140 }}
              onChange={e => setItem({ class_name: e.target.value })} />
          )}
          {/* 大人のクラス：前後半の境（空ならちょうど半分）・映像（2026-10-06 ユーザー確定） */}
          {isAdult && it.kind === ADULT_CLASS_KIND && (
            <>
              <span style={{ fontSize: 12, color: subText }}>
                前後半の境
                <input type="time" step={300} value={it.split_time} style={{ ...inputStyle, width: 104, marginLeft: 4 }}
                  onChange={e => setItem({ split_time: e.target.value })} />
                {!it.split_time && splitMinOf(it) != null && `（空＝${minText(splitMinOf(it)!)}）`}
              </span>
              <select value={it.video ?? ''} style={inputStyle} onChange={e => setItem({ video: (e.target.value || null) as KidsItem['video'] })}>
                <option value="">映像なし</option>
                <option value="first">映像（前半）</option>
                <option value="second">映像（後半）</option>
              </select>
            </>
          )}
          {kind?.has_groups && (
            <>
              <input type="number" min={1} max={9} value={it.groups ?? ''} placeholder="班" style={{ ...inputStyle, width: 60 }}
                onChange={e => setItem({ groups: e.target.value === '' ? null : Number(e.target.value) })} />
              <span style={{ fontSize: 12, color: subText }}>
                必要
                <input type="number" min={0} max={20} value={it.required ?? ''} placeholder={String(def.required)} style={{ ...inputStyle, width: 58, marginLeft: 4 }}
                  onChange={e => setItem({ required: e.target.value === '' ? null : Number(e.target.value) })} />
                人／うちレッスンできる人
                <input type="number" min={0} max={20} value={it.min_lesson ?? ''} placeholder={String(def.minLesson)} style={{ ...inputStyle, width: 58, marginLeft: 4 }}
                  onChange={e => setItem({ min_lesson: e.target.value === '' ? null : Number(e.target.value) })} />
                人
              </span>
            </>
          )}
          {kind?.has_groups && isPoolColumn(place) && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12.5 }}>
              <input type="checkbox" checked={it.use_pool} onChange={e => setItem({ use_pool: e.target.checked })} />
              共通の人で回す
            </label>
          )}
          {isRole && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12.5 }}>
              <input type="checkbox" checked={it.is_none} onChange={e => setItem({ is_none: e.target.checked, people: e.target.checked ? [] : it.people })} />
              なし
            </label>
          )}
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            {/* 大人は表に時刻の順で出るので、並べ替えは出さない */}
            {!isAdult && (
              <>
                <button type="button" style={linkBtn} disabled={i === 0}
                  onClick={() => setCell(placeId, d, all.map((x, j) => (j === i - 1 ? all[i] : j === i ? all[i - 1] : x)))}>▲</button>
                <button type="button" style={linkBtn} disabled={i === all.length - 1}
                  onClick={() => setCell(placeId, d, all.map((x, j) => (j === i + 1 ? all[i] : j === i ? all[i + 1] : x)))}>▼</button>
              </>
            )}
            <button type="button" aria-label="この行を消す" style={{ ...linkBtn, color: red }}
              onClick={() => { setCell(placeId, d, all.filter((_, j) => j !== i)); setBandIdx(prev => (prev ? prev.filter(j => j !== i).map(j => (j > i ? j - 1 : j)) : prev)); }}>✕ 消す</button>
          </span>
        </div>

        {!isNote && (kind?.has_people !== false) && (
          <div style={{ marginTop: 6 }}>
            {it.people.map((p, pi) => (
              <div key={pi} style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: 4 }}>
                <select value={p.user_id} style={inputStyle} onChange={e => setPerson(pi, { user_id: e.target.value })}>
                  <option value="">人を選ぶ</option>
                  {!activeStaff.some(s => s.id === p.user_id) && p.user_id && <option value={p.user_id}>{nameOf(p.user_id)}（退職）</option>}
                  {activeStaff.map(s => (
                    <option key={s.id} value={s.id}>
                      {fullName(s.name)}{canLesson(s.id) ? '' : '（レッスン外）'}
                    </option>
                  ))}
                </select>
                <select value={p.role} style={inputStyle} onChange={e => setPerson(pi, { role: e.target.value as KidsPerson['role'] })}>
                  {isAdult ? (
                    // 大人：クラスは前半／後半・補助。P・映像・事務・出張は担当だけ
                    (it.kind === ADULT_CLASS_KIND ? ADULT_ROLES : ADULT_ROLES.slice(0, 1)).map(r => <option key={r.key} value={r.key}>{r.label}</option>)
                  ) : (
                    <>
                      <option value="lead">担当</option>
                      <option value="onduty">（ ）出勤・レッスンに入らない（事務など）</option>
                      <option value="support">サポート</option>
                      <option value="watch">【 】見守り（レッスンに入らない）</option>
                    </>
                  )}
                </select>
                <input type="time" step={300} value={p.start} style={{ ...inputStyle, width: 110 }} onChange={e => setPerson(pi, { start: e.target.value })} />
                <span style={{ color: subText, fontSize: 12 }}>〜</span>
                <input type="time" step={300} value={p.end} style={{ ...inputStyle, width: 110 }} onChange={e => setPerson(pi, { end: e.target.value })} />
                <span style={{ fontSize: 11.5, color: subText }}>（人ごとに時間が違うときだけ）</span>
                <button type="button" aria-label="この人を外す" onClick={() => setItem({ people: it.people.filter((_, j) => j !== pi) })}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: subText, fontSize: 14 }}>✕</button>
              </div>
            ))}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <button type="button" disabled={it.people.length >= 12}
                onClick={() => setItem({
                  // 大人のクラスは、前半の担当がもういれば次は後半の担当を初めに選んでおく
                  people: [...it.people, { user_id: '', role: isAdult && it.kind === ADULT_CLASS_KIND && it.people.some(p => p.role === 'lead') && !it.people.some(p => p.role === 'second') ? 'second' : 'lead', start: '', end: '' }],
                })}
                style={{ background: 'none', border: `1px dashed ${borderColor}`, borderRadius: 6, cursor: 'pointer', padding: '3px 8px', fontSize: 12, color: '#0d6efd' }}>
                ＋ 人を足す
              </button>
              {i > 0 && all[i - 1].people.length > 0 && (
                <button type="button" style={linkBtn} onClick={() => setItem({ people: all[i - 1].people.map(p => ({ ...p })) })}>
                  上の行と同じ人にする
                </button>
              )}
              {kind?.has_groups && (
                <button type="button" style={linkBtn}
                  onClick={() => setItem({ required: (it.required ?? def.required) + 1 })}>
                  {'＋（\u3000）追加必要をひとつ増やす'}
                </button>
              )}
            </div>
          </div>
        )}

        <input type="text" value={it.note} maxLength={200} placeholder={isNote ? '書き添え（例：今田・奥村ー誰か休みの時、各校に午前中出勤可能）' : isAdult ? '書き添え' : '書き添え（例：（月1回）・定員5・打合せ4階）'}
          style={{ ...inputStyle, width: '100%', marginTop: 6 }} onChange={e => setItem({ note: e.target.value })} />
        {place?.kind === 'column' && (kind?.has_groups ?? false) && (() => {
          if (it.use_pool && isPoolColumn(place)) {
            return <div style={{ fontSize: 12, color: subText, marginTop: 4 }}>共通の人で回します（足りるかは表の「共通」の行で見ます）</div>;
          }
          const s = shortfallOf(it, data.settings, canLesson, inactive);
          if (!s) return <div style={{ fontSize: 12, color: subText, marginTop: 4 }}>人数はそろっています</div>;
          return (
            <div style={{ ...warnCard, marginTop: 6 }}>
              追加必要：あと {s.need} 人{s.lessonNeed > 0 ? `（うちレッスンできる人 あと ${s.lessonNeed} 人）` : '（レッスンできる人はそろっています）'}
            </div>
          );
        })()}
      </div>
    );
  };

  /** マスの入力。bands と band を渡すと（大人シフト表）、その時刻の帯の行だけを出し、足す行の時刻をその帯にする */
  const cellEditor = (placeId: string, d: RosterDayKind, bands: KidsBand[] = [], band: number | null = null) => {
    const place = places.find(p => p.id === placeId);
    if (place?.kind === 'pool') return poolEditor(placeId, d);
    const v = shownCell(placeId, d);
    const k = cellKey(placeId, d);
    const kinds = place?.kind === 'head' ? [{ key: 'role', label: '見出しの役割' }]
      : place?.kind === 'daynote' ? [{ key: 'daynote', label: '曜日の書き添え' }]
      : place?.kind === 'trip' ? data.rowKinds.filter(r => r.active && r.key === ADULT_TRIP_KIND).map(r => ({ key: r.key, label: r.label }))
      : data.rowKinds.filter(r => r.active && !(isAdult && r.key === ADULT_TRIP_KIND)).map(r => ({ key: r.key, label: r.label }));
    const useBand = band != null && bands[band] != null && bandIdx != null && bandFor === k && place?.kind !== 'daynote';
    const inBand = (i: number) => !useBand || bandIdx!.includes(i);
    const bandStart = useBand ? normTime(minText(bands[band!].from)) : '';
    const shownCount = v.filter((_, i) => inBand(i)).length;
    return (
      <div style={{ padding: '10px 12px', borderRadius: 10, border: '2px solid #1976d2', background: cardBg, textAlign: 'left', fontSize: 13, color: text, marginTop: 10 }}>
        <b>{place?.label}（{ROSTER_DAY_LABEL[d]}）{useBand ? ` ・${bands[band!].label} の帯` : ''}</b>
        {useBand && v.length > shownCount && (
          <button type="button" style={{ ...linkBtn, marginLeft: 8 }} onClick={() => { setOpenBand(null); setBandIdx(null); }}>この曜日のすべてを出す（{v.length}）</button>
        )}
        <div style={{ marginTop: 8 }}>
          {shownCount === 0 && <div style={{ color: subText, marginBottom: 6 }}>まだ何も入っていません</div>}
          {v.map((it, i) => (inBand(i) ? itemEditor(placeId, d, it, i, v) : null))}
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginTop: 4 }}>
            {kinds.map(kd => (
              <button key={kd.key} type="button" onClick={() => { setCell(placeId, d, [...v, { ...emptyItem(kd.key), start: bandStart }]); if (useBand) setBandIdx(prev => (prev ? [...prev, v.length] : prev)); }}
                style={{ background: 'none', border: `1px dashed ${borderColor}`, borderRadius: 6, cursor: 'pointer', padding: '3px 8px', fontSize: 12, color: '#0d6efd' }}>
                ＋ {kd.label}
              </button>
            ))}
            {viewDrafts[k] && <button type="button" style={linkBtn} onClick={() => revertCell(k)}>↩ 直す前に戻す</button>}
            {plan && (
              <button type="button" style={linkBtn}
                onClick={() => setCell(placeId, d, (cellVersionOn(data.cells, placeId, d, plan.apply_from)?.items ?? []).map(x => ({ ...x })))}>
                決定済みの表に戻す
              </button>
            )}
            <button type="button" onClick={() => setOpenKey(null)} style={{ ...inputStyle, cursor: 'pointer', marginLeft: 'auto' }}>閉じる</button>
          </div>
        </div>
      </div>
    );
  };

  /**
   * 画面・PDF に出す行の形。🚨 共通で回すクラス（本校 3F・5F）は（ ）の人を出さず（共通の行の「他業務」に出るため）、
   * 「（ ）」も付けず（足りるかは共通の行で数える）、最初の行の終わりに「共通」と書く（2026-10-06 ユーザー確定）
   */
  const displayItem = (placeId: string, it: KidsItem): { it: KidsItem; pool: boolean } => {
    const pool = it.use_pool && isPoolColumn(places.find(p => p.id === placeId));
    return pool ? { it: { ...it, people: it.people.filter(p => p.role !== 'onduty' && p.role !== 'watch') }, pool } : { it, pool };
  };
  const linesOfItems = (placeId: string, items: KidsItem[], blanks = true): string[] =>
    items.flatMap(raw => {
      const { it, pool } = displayItem(placeId, raw);
      const s = blanks && !pool ? shortfallOf(it, data.settings, canLesson, inactive) : null;
      const text0 = blanks ? itemTextWithBlanks(it, nameOf, s, roleLabel) : itemText(it, nameOf, roleLabel);
      const lines = text0.split('\n');
      if (pool) lines[0] = `${lines[0]}\u3000共通`;
      return lines;
    });
  const cellLinesOf = (placeId: string, d: RosterDayKind): string[] =>
    [...linesOfItems(placeId, shownCell(placeId, d)), ...studyLinesOf(placeId, d, null, null)];
  /** 勉強会の行の文字（「14:00(15)鈴木・幾田［勉］」）。帯を渡すとその帯の分だけ */
  const studyNames = new Map(data.staff.map(s => [s.id, nameOf(s.id)]));
  function studyLinesOf(placeId: string, d: RosterDayKind, bands: KidsBand[] | null, bi: number | null): string[] {
    return studyOfPlace(placeId, d)
      .filter(v => bands == null || bi == null || bandIndexOf({ ...emptyItem('study'), start: minText(studyStartMin(v)) }, bands) === bi)
      .map(v => `${studyLabel(v, studyNames)}［勉］`);
  }
  /** 1行を、変わった所だけ濃いピンクにして出す */
  const renderMarked = (parts: { text: string; hit: boolean }[]) =>
    parts.map((p, i) => (p.hit ? <span key={i} style={CHANGE_MARK_SPAN}>{p.text}</span> : <React.Fragment key={i}>{p.text}</React.Fragment>));
  /** 前にはあって、いまは無いもの（抜けた名前など）。取り消し線で出す */
  const renderRemoved = (removed: string[], block = false) => (removed.length === 0 ? null : (
    <span style={{ display: block ? 'block' : 'inline', marginLeft: block ? 0 : 6 }}>
      前：{removed.map((r, i) => <React.Fragment key={i}>{i > 0 ? '・' : ''}<span style={{ ...CHANGE_MARK_SPAN, textDecoration: 'line-through' }}>{r}</span></React.Fragment>)}
    </span>
  ));

  const cols = columnsOfDay(day);
  const headBySchool = (school: string) => heads.find(h => h.school === school) ?? null;
  // 時刻の帯（その曜日のクラスの開始時刻から自動で作る）。中身が無い日は1本だけ
  const bandsNow: KidsBand[] = (() => {
    const b = bandsOfDay(cols.map(c => ({ placeId: c.id, items: [...shownCell(c.id, day), ...studyItemsOf(c.id, day), ...(c.id === kids6F?.id ? adult6FOf(day) : [])] })), isClassItem);
    return b.length > 0 ? b : [{ from: 0, to: null, label: '' }];
  })();
  // 共通の行。🚨 その校の 3F・5F が表に並んで出ているときだけ（並んでいないと1行にまとめられない）
  const poolNow = (() => {
    for (const pp of poolPlaces) {
      const ids = cols.filter(c => c.school === pp.school && isPoolColumn(c)).map(c => c.id);
      if (ids.length === 0) continue;
      const first = cols.findIndex(c => c.id === ids[0]);
      if (!ids.every((id, j) => cols[first + j]?.id === id)) continue;
      const ctx = poolCtxOf(day, pp);
      const baseCtx = poolCtxOf(day, pp, baseCell);
      return {
        place: pp, ids: new Set(ids), first, span: ids.length,
        rows: bandsNow.map(b => poolRowOfBand(b, ctx)),
        baseRows: bandsNow.map(b => poolRowOfBand(b, baseCtx)),
      };
    }
    return null;
  })();

  // ─── 人ごとの表（2026-10-07・ユーザー確定：見るだけ。押すとその曜日の表のマスが開く） ───
  // 縦＝その週に出てくる人（勤務表と同じ並び）、横＝月〜日。マスの先頭に校（役割があれば添える）、その下に予定を時刻順
  // 🚨 予定の中身はこどもの表のマス・共通の人・勉強会から作る（ここで書き直さない＝画面の表と同じ材料）
  const personTable = () => {
    type Entry = { min: number; text: string; placeId: string; school: string };
    type DayCell = { entries: Entry[]; roles: string[] };
    const byUser = new Map<string, Partial<Record<RosterDayKind, DayCell>>>();
    const cellFor = (uid: string, d: RosterDayKind): DayCell => {
      const m = byUser.get(uid) ?? {};
      if (!m[d]) m[d] = { entries: [], roles: [] };
      byUser.set(uid, m);
      return m[d]!;
    };
    for (const d of KIDS_WEEK) {
      for (const c of activeColumns) {
        const school = c.school ?? c.label;
        const fl = activeColumns.filter(x => x.school === c.school).length > 1 && c.floor ? `${c.floor} ` : '';
        for (const it of shownCell(c.id, d)) {
          if (it.kind === 'role' || it.kind === 'daynote' || it.is_none) continue;
          for (const p of it.people) {
            if (!p.user_id) continue;
            const st = normTime(it.start);
            let t: string;
            if (it.kind === 'private') t = `［P］${st}`;
            else if (it.kind === 'meeting') t = `［打合せ］${st}`;
            else if (it.kind === 'garden') t = `園指導 ${it.class_name}`;
            else if (isClassItem(it)) t = `${st} ${fl}${it.class_name}${it.groups != null ? `${it.groups}班` : ''}`;
            else t = `${st}${it.end ? `〜${normTime(it.end)}` : ''} ${fl}${it.class_name || kindLabel(it.kind)}`;
            if (p.role === 'onduty') t += '（ ）';
            if (p.role === 'support') t += '（サポート）';
            if (p.role === 'watch') t += '【見守り】';
            if (normTime(p.start) && normTime(p.start) !== st) t += ` ${normTime(p.start)}〜`;
            if (normTime(p.end)) t += ` 〜${normTime(p.end)}`;
            cellFor(p.user_id, d).entries.push({ min: toMin(normTime(p.start) || st) ?? 0, text: t.trim(), placeId: c.id, school });
          }
        }
        for (const v of studyOfPlace(c.id, d)) {
          for (const u of v.members) cellFor(u, d).entries.push({ min: studyStartMin(v), text: `${minText(studyStartMin(v))} 勉強会［勉］`, placeId: c.id, school });
        }
      }
      for (const pp of poolPlaces) {
        for (const p of shownCell(pp.id, d).find(it => it.kind === 'pool')?.people ?? []) {
          if (!p.user_id) continue;
          cellFor(p.user_id, d).entries.push({
            min: toMin(normTime(p.start)) ?? 0, text: `共通 ${normTime(p.start)}〜${normTime(p.end)}`, placeId: pp.id, school: pp.school ?? '',
          });
        }
      }
      for (const h of heads) {
        for (const it of shownCell(h.id, d)) {
          if (it.kind !== 'role' || it.is_none) continue;
          for (const p of it.people) if (p.user_id) cellFor(p.user_id, d).roles.push(`${h.school}（${roleLabel(it.role_key ?? '')}）`);
        }
      }
    }
    const areaOrder = (userId: string) => roster.areas.find(a => a.id === roster.mainAreas[userId])?.sort_order ?? 999;
    const people = [...byUser.keys()]
      .map(id => roster.staff.find(s => s.id === id) ?? { id, name: data.staff.find(s => s.id === id)?.name ?? '', role_title: null })
      .sort((a, b) => compareRosterStaff(a, b, areaOrder, t => rankOf(roles, t) ?? 99));
    if (people.length === 0) return <p style={{ color: subText, fontSize: 13 }}>この表には、まだだれも入っていません</p>;
    return (
      <div style={{ overflowX: 'auto', border: `1px solid ${borderColor}`, borderRadius: 8 }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 900, tableLayout: 'fixed' }}>
          <thead>
            <tr style={{ background: innerBg }}>
              <th style={{ width: 90, padding: '6px 4px', fontSize: 12.5, color: text }}>人</th>
              {KIDS_WEEK.map(d => <th key={d} style={{ padding: '6px 4px', borderLeft: `1px solid ${borderColor}`, fontSize: 12.5, color: text }}>{ROSTER_DAY_LABEL[d]}</th>)}
            </tr>
          </thead>
          <tbody>
            {people.map(p => (
              <tr key={p.id} style={{ borderTop: `1px solid ${borderColor}` }}>
                <td style={{ padding: '4px', fontSize: 12.5, fontWeight: 'bold', color: text, verticalAlign: 'top', background: innerBg }}>{nameOf(p.id)}</td>
                {KIDS_WEEK.map(d => {
                  const cell = byUser.get(p.id)?.[d];
                  const entries = [...(cell?.entries ?? [])].sort((a, b) => a.min - b.min);
                  const schools = [...new Set(entries.map(e => e.school))];
                  const roleText = cell?.roles ?? [];
                  const head = [...schools.filter(s => !roleText.some(r => r.startsWith(s))), ...roleText].join('・');
                  const off = entries.length === 0 && roleText.length === 0 && (shiftDayOn(rowsByUser.get(p.id) ?? [], d, baseDate)?.segments.length ?? 0) === 0;
                  const first = entries[0];
                  return (
                    <td key={d}
                      onClick={() => { if (!first) return; setViewMode('day'); setDay(d); setOpenKey(cellKey(first.placeId, d)); }}
                      style={{ padding: '4px', borderLeft: `1px solid ${borderColor}`, verticalAlign: 'top', fontSize: 12, color: text, cursor: first ? 'pointer' : 'default', lineHeight: 1.55 }}>
                      {head && <div style={{ fontWeight: 'bold' }}>{head}</div>}
                      {entries.map((e, i) => <div key={i}>{e.text}</div>)}
                      {off && <span style={{ color: subText }}>休み</span>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };

  // ─── 「3F・5F で動ける人」の入力（2026-10-06 ユーザー確定：人・何時から・何時まで だけ） ───
  const poolEditor = (placeId: string, d: RosterDayKind) => {
    const place = places.find(p => p.id === placeId);
    if (!place) return null;
    const v = shownCell(placeId, d);
    const item = v.find(it => it.kind === 'pool') ?? null;
    const people = item?.people ?? [];
    const rest = v.filter(it => it.kind !== 'pool');
    const poolCols = activeColumns.filter(c => c.school === place.school && isPoolColumn(c));
    // 時刻のボタン＝その曜日のクラスの時刻（全校の帯と同じ作り方）
    const times = bandsOfDay(activeColumns.map(c => ({ placeId: c.id, items: shownCell(c.id, d) })), isClassItem)
      .filter(b => !b.label.startsWith('〜')).map(b => b.label);
    const setPeople = (next: KidsPerson[]) =>
      setCell(placeId, d, next.length === 0 ? rest : [...rest, { ...(item ?? emptyItem('pool')), people: next }]);
    const setPerson = (pi: number, patch: Partial<KidsPerson>) => setPeople(people.map((p, j) => (j === pi ? { ...p, ...patch } : p)));
    // 🚨 最初の1人を足したときだけ、共通で回すクラスを自動で選ぶ（担当の名前が入っていない 3F・5F のクラス）。あとは下のチェックで直せる
    const addPerson = () => {
      if (people.length === 0) {
        for (const c of poolCols) {
          const cell = shownCell(c.id, d);
          if (!cell.some(it => isClassItem(it) && !it.use_pool && !it.people.some(p => p.role === 'lead'))) continue;
          setCell(c.id, d, cell.map(it => (isClassItem(it) && !it.people.some(p => p.role === 'lead') ? { ...it, use_pool: true } : it)));
        }
      }
      setPeople([...people, { user_id: '', role: 'lead', start: times[0] ?? '', end: '' }]);
    };
    const timeBtns = (value: string, onPick: (t: string) => void) => (
      <span style={{ display: 'inline-flex', gap: 3, flexWrap: 'wrap', alignItems: 'center' }}>
        {times.map(t => (
          <button key={t} type="button" onClick={() => onPick(t)} style={{ ...toggle(normTime(value) === normTime(t)), padding: '2px 6px', fontSize: 11.5 }}>{t}</button>
        ))}
        <input type="time" step={300} value={value} style={{ ...inputStyle, width: 104 }} onChange={e => onPick(e.target.value)} />
      </span>
    );
    const ctx = poolCtxOf(d, place);
    const bands = bandsOfDay(activeColumns.map(c => ({ placeId: c.id, items: shownCell(c.id, d) })), isClassItem);
    return (
      <div style={{ padding: '10px 12px', borderRadius: 10, border: '2px solid #1976d2', background: cardBg, textAlign: 'left', fontSize: 13, color: text, marginTop: 10 }}>
        <b>{place.school} 3F・5F で動ける人（{ROSTER_DAY_LABEL[d]}）</b>
        <div style={{ fontSize: 12, color: subText, margin: '4px 0 8px', lineHeight: 1.6 }}>
          その時間に 3F・5F のどちらにも入れる人を、何時から何時までいるかで入れます。
          クラスの担当・（ ）・P・打合せなどに入っている時間は、自動で共通から外れます（紙と同じ）。
        </div>
        {people.length === 0 && <div style={{ color: subText, marginBottom: 6 }}>まだだれも入っていません</div>}
        {people.map((p, pi) => (
          <div key={pi} style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', padding: '6px 0', borderTop: pi > 0 ? `1px solid ${borderColor}` : 'none' }}>
            <select value={p.user_id} style={inputStyle} onChange={e => setPerson(pi, { user_id: e.target.value })}>
              <option value="">人を選ぶ</option>
              {!activeStaff.some(s => s.id === p.user_id) && p.user_id && <option value={p.user_id}>{nameOf(p.user_id)}（退職）</option>}
              {/* 🚨 同じ人は1回だけ（DB で同じ行に同じ人を2回入れられない） */}
              {activeStaff.filter(s => s.id === p.user_id || !people.some(x => x.user_id === s.id)).map(s => (
                <option key={s.id} value={s.id}>{fullName(s.name)}</option>
              ))}
            </select>
            <span style={{ fontSize: 12, color: subText }}>何時から</span>{timeBtns(p.start, t => setPerson(pi, { start: t }))}
            <span style={{ fontSize: 12, color: subText }}>何時まで</span>{timeBtns(p.end, t => setPerson(pi, { end: t }))}
            <button type="button" aria-label="この人を外す" onClick={() => setPeople(people.filter((_, j) => j !== pi))}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: subText, fontSize: 14 }}>✕</button>
          </div>
        ))}
        <button type="button" onClick={addPerson}
          style={{ background: 'none', border: `1px dashed ${borderColor}`, borderRadius: 6, cursor: 'pointer', padding: '3px 8px', fontSize: 12, color: '#0d6efd', marginTop: 4 }}>
          ＋ 人を足す
        </button>
        <div style={{ fontSize: 11.5, color: subText, marginTop: 4 }}>「何時まで」が空のときは、その日の終わりまでいる扱いです</div>

        {/* 共通で回すクラス（ユーザー確定：初めは自動・ここで直せる） */}
        <div style={{ marginTop: 10 }}>
          <b style={{ fontSize: 12.5 }}>共通の人で回すクラス</b>
          {poolCols.flatMap(c => shownCell(c.id, d).map((it, i) => ({ c, it, i }))).filter(x => isClassItem(x.it)).map(({ c, it, i }) => (
            <label key={`${c.id}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, marginTop: 3, cursor: 'pointer' }}>
              <input type="checkbox" checked={it.use_pool}
                onChange={e => { const cell = shownCell(c.id, d); setCell(c.id, d, cell.map((x, j) => (j === i ? { ...x, use_pool: e.target.checked } : x))); }} />
              {c.floor} {normTime(it.start)}〜 {it.class_name}{it.groups != null ? ` ${it.groups}班` : ''}
            </label>
          ))}
        </div>

        {/* 表に出る形の見本（画面の表と同じ組み立て） */}
        <div style={{ marginTop: 10, padding: '6px 8px', borderRadius: 6, background: innerBg, fontSize: 12, lineHeight: 1.7 }}>
          <b>表に出る形</b>
          {bands.map((b, bi) => {
            const r = poolRowOfBand(b, ctx);
            if (!r.show) return null;
            return (
              <div key={bi}>
                {b.label}{'\u3000'}共通 {r.common.length}人／要る {r.need}：{r.common.map(x => `${nameOf(x.userId)}${x.note}`).join('・') || 'なし'}
                {r.other.length > 0 && `\u3000｜\u3000他業務：${r.other.map(o => `${nameOf(o.userId)}${o.where ? `（${o.where}）` : ''}`).join('・')}`}
              </div>
            );
          })}
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          {viewDrafts[cellKey(placeId, d)] && <button type="button" style={linkBtn} onClick={() => revertCell(cellKey(placeId, d))}>↩ 直す前に戻す</button>}
          <button type="button" onClick={() => setOpenKey(null)} style={{ ...inputStyle, cursor: 'pointer', marginLeft: 'auto' }}>閉じる</button>
        </div>
      </div>
    );
  };

  // ─── 大人シフト表の表（2026-10-07・docs/計画-大人シフト表.md §3） ───
  // 縦＝時刻の帯（その週のクラスの開始時刻から自動・近い時刻はまとめる）、横＝月〜土（日は中身があるときだけ）＋曜日ごとに出張の細い列。
  // マス＝上 時刻とクラス名／担当（大きい字「前半(サポート)/後半」）／補助、下 別の仕事［P］［映］［事］と勉強会［勉］（自動）。
  // Jr合同は灰色の帯。🚨 マスの文字は lib/adultShift.ts の adultLines 1つ（PDF も同じものを使う）
  /** 大人シフト表の組み立て（画面と PDF で同じもの）。🚨 曜日・時刻の帯・勉強会・こどもの行をここ1つで決める */
  const adultLayout = (withSunday = false) => {
    const main = activeColumns[0] ?? null;
    if (!main) return null;
    const trip = tripPlaces[0] ?? null;
    const has = (pid: string | null, d: RosterDayKind) => !!pid && shownCell(pid, d).length > 0;
    const days = KIDS_WEEK.filter(d => d !== 'sun' || has(main.id, d) || has(trip?.id ?? null, d) || withSunday);
    let bands = bandsOfDay(days.map(d => ({ placeId: d, items: shownCell(main.id, d) })), it => it.kind === ADULT_CLASS_KIND);
    if (bands.length === 0) bands = [{ from: 0, to: null, label: '' }];
    // 勉強会：部門が大人のもの＋その曜日に大人シフト表に入っている人が入るもの（自動・ここでは直せない）
    const adultArea = roster.areas.find(a => a.name === '大人')?.id ?? null;
    const studiesOf = (d: RosterDayKind) => {
      const people = new Set([...shownCell(main.id, d), ...(trip ? shownCell(trip.id, d) : [])].flatMap(it => it.people.map(p => p.user_id)));
      return versionsOnDate(studyVersions, baseDate)
        .filter(v => v.day_kind === d && ((adultArea != null && v.area_id === adultArea) || v.members.some(u => people.has(u))))
        .sort((a, b) => studyStartMin(a) - studyStartMin(b));
    };
    const studyLinesAt = (d: RosterDayKind, bi: number) => studiesOf(d)
      .filter(v => bandIndexOf({ ...emptyItem('study'), start: minText(studyStartMin(v)) }, bands) === bi)
      .map(v => `${studyLabel(v, studyNames)}［勉］`);
    // 「こども」の行：その曜日にこどもの担当がある大人シフト表の先生（メインの部門が大人の人＋その日に大人の表に入っている人）
    const kidsRowOf = (d: RosterDayKind): { userId: string; text: string }[] => {
      const teachers = new Set([...entriesFor('adult', d).map(e => e.userId), ...data.staff.filter(s => s.is_active && s.main_area === '大人').map(s => s.id)]);
      const by = new Map<string, CrossEntry[]>();
      for (const e of entriesFor('kids', d)) if (teachers.has(e.userId)) by.set(e.userId, [...(by.get(e.userId) ?? []), e]);
      return [...by.entries()].sort((a, b) => Math.min(...a[1].map(x => x.s)) - Math.min(...b[1].map(x => x.s)))
        .map(([u, es]) => ({ userId: u, text: kidsRowText(es) }));
    };
    return { main, trip, days, bands, studyLinesAt, kidsRowOf };
  };

  /** 大人シフト表の PDF（A4 横 1枚）。🚨 画面と同じ adultLayout・adultLines を使う */
  const printAdultPdf = () => {
    const L = adultLayout();
    if (!L) return;
    const { main, trip, days, bands } = L;
    const html = buildAdultPrintHtml({
      title: `${md(baseDate)}〜 大人シフト表${plan ? ` ${plan.name}` : ''}`,
      asOf: today,
      notes: (data.notes ?? []).filter(n => n.active).map(n => n.body),
      days, bands, hasTrip: !!trip,
      cellOf: (d, bi) => ({
        lines: adultLines(itemsByBand(shownCell(main.id, d), bands)[bi] ?? [], nameOf),
        base: adultLines(itemsByBand(baseCell(main.id, d), bands)[bi] ?? [], nameOf),
        study: L.studyLinesAt(d, bi),
      }),
      tripOf: (d, bi) => (trip ? {
        lines: adultLines(itemsByBand(shownCell(trip.id, d), bands)[bi] ?? [], nameOf),
        base: adultLines(itemsByBand(baseCell(trip.id, d), bands)[bi] ?? [], nameOf),
      } : { lines: [], base: [] }),
      kidsRow: d => L.kidsRowOf(d).map(x => `${nameOf(x.userId)} ${x.text}`),
      offRow: d => offOfDay(d).map(s => nameOf(s.id)),
      dayNotes: d => (dayNotePlace ? shownCell(dayNotePlace.id, d).map(i => i.note).filter(Boolean) : []),
      markChanges: pdfMark,
    });
    setPanelErr(openRosterPrint(html) ?? '');
  };

  const adultGrid = () => {
    const L = adultLayout(!!openKey?.endsWith('|sun'));
    if (!L) return <p style={{ color: subText, fontSize: 13 }}>大人シフト表の列がまだありません（「列の一覧」を確かめてください）</p>;
    const { main, trip, days, bands, studyLinesAt } = L;
    const jrBg = isDarkMode ? '#4a4a46' : '#e4e3df';
    const jrText = isDarkMode ? '#e8e6df' : '#444441';
    const open = (pid: string, d: RosterDayKind, bi: number | null) => {
      const k = cellKey(pid, d);
      if (openKey === k && openBand === bi) { setOpenKey(null); return; }
      setOpenKey(k); setOpenBand(bi); setBandFor(bi == null ? null : k);
      setBandIdx(bi == null ? null : shownCell(pid, d).map((it, i) => ({ it, i })).filter(x => bandIndexOf(x.it, bands) === bi).map(x => x.i));
    };
    const lineStyle = (l: AdultLine, i: number, lines: AdultLine[]): React.CSSProperties => ({
      fontSize: l.kind === 'staff' ? 14 : l.kind === 'head' || l.kind === 'trip' ? 11.5 : l.kind === 'note' ? 11 : 12,
      fontWeight: l.kind === 'staff' || (l.jr && l.kind === 'head') ? 'bold' : 'normal',
      color: l.jr ? jrText : l.kind === 'head' || l.kind === 'note' ? subText : text,
      background: l.jr ? jrBg : undefined,
      padding: l.jr ? '0 3px' : undefined,
      lineHeight: 1.4,
      // 下の段（別の仕事）の始まりに点線
      borderTop: l.kind === 'job' && i > 0 && lines[i - 1].kind !== 'job' && lines[i - 1].kind !== 'note' ? `1px dashed ${borderColor}` : undefined,
      marginTop: l.kind === 'head' && i > 0 ? 3 : undefined,
    });
    const cellBody = (lines: AdultLine[], baseLines: AdultLine[], changed: boolean) => {
      const marked = changed ? diffLines(lines.map(l => l.text), baseLines.map(l => l.text)) : null;
      return (
        <>
          {lines.map((l, i) => <div key={i} style={lineStyle(l, i, lines)}>{marked ? renderMarked(marked.lines[i]) : l.text}</div>)}
          {marked && renderRemoved(marked.removed, true)}
        </>
      );
    };
    const outline = (k: string, bi: number | null) => (openKey === k && openBand === bi ? '2px solid #1976d2' : 'none');
    const dayW = 150;
    const tripW = 64;
    return (
      <>
        {stale && (
          <div style={{ ...warnCard, marginBottom: 8 }}>
            {saveErr}
            <button type="button" style={{ ...primaryBtn, marginLeft: 8 }} onClick={() => void load(true)}>読み込み直す</button>
          </div>
        )}
        {studyErr && <div style={{ ...warnCard, marginBottom: 6 }}>{studyErr}</div>}
        <div style={{ fontSize: 12, color: subText, marginBottom: 6 }}>
          マスを押すと、その曜日・その時刻の帯の行を入れられます（曜日の見出しを押すと、その曜日のすべて）。
          勉強会［勉］は勉強会の表から自動で出ます（ここでは直せません）。
        </div>
        <div style={{ overflowX: 'auto', border: `1px solid ${borderColor}`, borderRadius: 8 }}>
          <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 56 + days.length * (dayW + (trip ? tripW : 0)), tableLayout: 'fixed' }}>
            <colgroup>
              <col style={{ width: 56 }} />
              {days.map(d => (
                <React.Fragment key={d}>
                  <col style={{ width: dayW }} />
                  {trip && <col style={{ width: tripW }} />}
                </React.Fragment>
              ))}
            </colgroup>
            <thead>
              <tr style={{ background: innerBg }}>
                <th style={{ padding: '6px 4px', borderBottom: `1px solid ${borderColor}`, fontSize: 12, color: subText }}>時刻</th>
                {days.map(d => {
                  const ids = [main.id, ...(trip ? [trip.id] : [])];
                  const warn = ids.reduce((n, id) => n + issuesOf(id, d).filter(i => !isAcked(id, d, i.key)).length, 0);
                  const diff = ids.some(id => isDiff(id, d));
                  const dirty = ids.some(id => changedKeys.includes(cellKey(id, d)));
                  return (
                    <React.Fragment key={d}>
                      <th onClick={() => open(main.id, d, null)}
                        style={{
                          padding: '6px 4px', borderBottom: `1px solid ${borderColor}`, borderLeft: `1px solid ${borderColor}`, fontSize: 12.5, color: text, cursor: 'pointer',
                          outline: dirty ? '2px solid #e65100' : outline(cellKey(main.id, d), null), outlineOffset: -2,
                        }}>
                        {ROSTER_DAY_LABEL[d]}{warn > 0 ? ' ⚠️' : ''}{diff ? ' ≠' : ''}
                      </th>
                      {trip && (
                        <th onClick={() => open(trip.id, d, null)}
                          style={{ padding: '6px 2px', borderBottom: `1px solid ${borderColor}`, borderLeft: `1px dashed ${borderColor}`, fontSize: 11, color: subText, cursor: 'pointer', outline: outline(cellKey(trip.id, d), null), outlineOffset: -2 }}>
                          出張
                        </th>
                      )}
                    </React.Fragment>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {bands.map((b, bi) => (
                <tr key={bi}>
                  <td style={{ padding: '4px', borderTop: `1px solid ${borderColor}`, verticalAlign: 'top', fontSize: 12.5, fontWeight: 'bold', color: text, background: innerBg }}>{b.label}</td>
                  {days.map(d => {
                    const items = itemsByBand(shownCell(main.id, d), bands)[bi] ?? [];
                    const baseItems = itemsByBand(baseCell(main.id, d), bands)[bi] ?? [];
                    const changed = markScreen && sigOfItems(items) !== sigOfItems(baseItems);
                    const study = studyLinesAt(d, bi);
                    const tItems = trip ? itemsByBand(shownCell(trip.id, d), bands)[bi] ?? [] : [];
                    const tBase = trip ? itemsByBand(baseCell(trip.id, d), bands)[bi] ?? [] : [];
                    const tChanged = markScreen && sigOfItems(tItems) !== sigOfItems(tBase);
                    return (
                      <React.Fragment key={d}>
                        <td onClick={() => open(main.id, d, bi)}
                          style={{
                            padding: '4px', borderTop: `1px solid ${borderColor}`, borderLeft: `1px solid ${borderColor}`, verticalAlign: 'top', cursor: 'pointer',
                            color: text, ...changeCellStyle(changed), outline: outline(cellKey(main.id, d), bi), outlineOffset: -2,
                          }}>
                          {cellBody(adultLines(items, nameOf), adultLines(baseItems, nameOf), changed)}
                          {study.map((l, i) => (
                            <div key={`s${i}`} style={{ fontSize: 11.5, color: subText, borderTop: i === 0 && items.length > 0 ? `1px dashed ${borderColor}` : undefined }}
                              title="勉強会の表から自動で出ています（ここでは直せません）">{l}</div>
                          ))}
                        </td>
                        {trip && (
                          <td onClick={() => open(trip.id, d, bi)}
                            style={{
                              padding: '3px 2px', borderTop: `1px solid ${borderColor}`, borderLeft: `1px dashed ${borderColor}`, verticalAlign: 'top', cursor: 'pointer',
                              color: text, ...changeCellStyle(tChanged), outline: outline(cellKey(trip.id, d), bi), outlineOffset: -2,
                            }}>
                            {cellBody(adultLines(tItems, nameOf), adultLines(tBase, nameOf), tChanged)}
                          </td>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tr>
              ))}
              {dayNotePlace && (
                <tr>
                  <td style={{ padding: '4px', borderTop: `1px solid ${borderColor}`, fontSize: 11.5, color: subText, background: innerBg }}>書き添え</td>
                  {days.map(d => {
                    const notes = shownCell(dayNotePlace.id, d).map(i => i.note).filter(Boolean);
                    const changed = markScreen && !cellEquals(shownCell(dayNotePlace.id, d), baseCell(dayNotePlace.id, d));
                    return (
                      <td key={d} colSpan={trip ? 2 : 1} onClick={() => open(dayNotePlace.id, d, null)}
                        style={{ padding: '4px', borderTop: `1px solid ${borderColor}`, borderLeft: `1px solid ${borderColor}`, fontSize: 11.5, color: notes.length ? text : subText, cursor: 'pointer', ...changeCellStyle(changed), outline: outline(cellKey(dayNotePlace.id, d), null), outlineOffset: -2 }}>
                        {notes.join('／') || '＋'}
                      </td>
                    );
                  })}
                </tr>
              )}
              {/* 「こども」の行（2026-10-06 ユーザー確定）：その曜日にこどもの担当がある大人シフト表の先生と時間・校（こどもの決定済み・または選んだ案から自動） */}
              <tr>
                <td style={{ padding: '4px', borderTop: `1px solid ${borderColor}`, fontSize: 11.5, color: subText, background: innerBg }}>こども{otherPlan ? '（案）' : ''}</td>
                {days.map(d => {
                  const list = L.kidsRowOf(d);
                  return (
                    <td key={d} colSpan={trip ? 2 : 1}
                      style={{ padding: '4px', borderTop: `1px solid ${borderColor}`, borderLeft: `1px solid ${borderColor}`, fontSize: 11.5, color: text, verticalAlign: 'top', ...(otherPlan ? compareBand(isDarkMode) : {}) }}>
                      {list.map(x => <div key={x.userId}>{nameOf(x.userId)} {x.text}</div>)}
                      {list.length === 0 && <span style={{ color: subText }}>{other ? '—' : '（読めません）'}</span>}
                    </td>
                  );
                })}
              </tr>
              <tr>
                <td style={{ padding: '4px', borderTop: `1px solid ${borderColor}`, fontSize: 11.5, color: subText, background: innerBg }}>休み</td>
                {days.map(d => (
                  <td key={d} colSpan={trip ? 2 : 1} style={{ padding: '4px', borderTop: `1px solid ${borderColor}`, borderLeft: `1px solid ${borderColor}`, fontSize: 11.5, color: text }}>
                    {offOfDay(d).map(s => nameOf(s.id)).join('・') || <span style={{ color: subText }}>—</span>}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 6, fontSize: 12, color: subText }}>
          <span>休み＝メインの部門が大人の人で、その曜日に勤務予定がない人（週のシフトから自動）</span>
          {!days.includes('sun') && (
            <button type="button" style={{ ...inputStyle, cursor: 'pointer' }} onClick={() => open(main.id, 'sun', null)}>＋ 日曜に入れる</button>
          )}
        </div>
        {openKey && (() => {
          const [pid, d] = openKey.split('|');
          return cellEditor(pid, d as RosterDayKind, bands, openBand);
        })()}
      </>
    );
  };

  return (
    <div>
      {/* 表・案の切り替え */}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
        <button type="button" style={toggle(view === 'decided')} onClick={() => guarded('決定済みの表', () => setView('decided'))}>決定済みの表</button>
        {openPlans.map(p => (
          <button key={p.id} type="button" style={toggle(view === p.id)} onClick={() => guarded(p.name, () => setView(p.id))}>
            {p.name}（{md(p.apply_from)}〜）
          </button>
        ))}
        <button type="button" style={{ ...inputStyle, cursor: 'pointer' }}
          onClick={() => setNewPlan({ name: '', from: applyFrom, copy: '' })}>＋ 新しい案</button>
        <span style={{ fontSize: 12, color: subText }}>作業中 {openPlans.length}／{data.settings.plan_limit}</span>
        {archivedPlans.length > 0 && (
          <button type="button" style={linkBtn} onClick={() => setShowArchived(v => !v)}>過去の案 ▼（{archivedPlans.length}）</button>
        )}
      </div>

      {/* 比べる（2026-09-22）。🚨 印を付けるだけ。書き換えはしない */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
        <span style={{ fontSize: 13, color: text }}>比べる</span>
        <select style={inputStyle} value={compareWith ?? ''} onChange={e => setCompareWith(e.target.value || null)}>
          <option value="">比べない</option>
          {view !== 'decided' && <option value="decided">決定済みの表</option>}
          {openPlans.filter(p => p.id !== view).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        {compareWith && !compareErr && (
          <span style={{ fontSize: 12.5, color: subText }}>
            違うマス <b style={{ color: text }}>{diffCount}</b> 件（<b style={{ color: text }}>≠</b> の付いたマス）。
            🚨 印を付けるだけで、書き換えはしません
          </span>
        )}
        {compareErr && <span style={{ fontSize: 12.5, color: red }}>{compareErr}</span>}
      </div>

      {showArchived && (
        <div style={{ padding: '8px 12px', borderRadius: 8, background: innerBg, border: `1px solid ${borderColor}`, marginBottom: 8, fontSize: 12.5, color: text }}>
          {archivedPlans.map(p => (
            <div key={p.id} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4, flexWrap: 'wrap' }}>
              <span>{p.name}（{p.archived_reason === 'decided' ? `${md(p.decided_from ?? p.apply_from)} に決定` : '使わなかった'}）</span>
              <button type="button" style={linkBtn} onClick={() => setNewPlan({ name: `${p.name}の写し`, from: applyFrom, copy: p.id })}>写して新しい案にする</button>
            </div>
          ))}
          <div style={{ color: subText, marginTop: 4 }}>🚨 過去の案は、2年たつと自動的に消えます（決定した日・使わないにした日から）。</div>
        </div>
      )}

      {newPlan && (
        <div style={{ ...warnCard, marginBottom: 8 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span>新しい案</span>
            <input type="text" value={newPlan.name} maxLength={40} placeholder="名前（例：10月の案）" style={inputStyle}
              onChange={e => setNewPlan({ ...newPlan, name: e.target.value })} />
            <span>予定の適用開始日</span>
            <input type="date" value={newPlan.from} style={inputStyle} onChange={e => e.target.value && setNewPlan({ ...newPlan, from: e.target.value })} />
            {newPlan.copy && <span>（写して作ります）</span>}
            <button type="button" style={primaryBtn} onClick={() => void createPlan()}>作る</button>
            <button type="button" style={linkBtn} onClick={() => setNewPlan(null)}>やめる</button>
          </div>
        </div>
      )}

      {plan && (
        <div style={{ ...warnCard, marginBottom: 8 }}>
          <b>{plan.name}を直しています</b>（保存しても決定済みの表は変わりません）／予定の適用開始日{' '}
          <input type="date" value={plan.apply_from} style={inputStyle}
            onChange={e => {
              if (!e.target.value) return;
              void savePlan({ op: 'update', plan_id: plan.id, revision: plan.revision, name: plan.name, apply_from: e.target.value })
                .then(r => { if (r.error || !r.ok) setSaveErr(`予定の適用開始日を変えられませんでした：${r.error ?? r.reason ?? ''}`); return load(true); });
            }} />
          <span style={{ marginLeft: 8, fontSize: 12 }}>最後の保存 {plan.updated_at.slice(0, 16).replace('T', ' ')}</span>
          <button type="button" style={{ ...linkBtn, marginLeft: 8 }} onClick={() => void archivePlan(plan)}>この案を使わない</button>
        </div>
      )}

      {/* 日付と曜日 */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
        {!plan && (
          <>
            <span style={{ fontSize: 13, color: text }}>適用開始日</span>
            <input type="date" value={applyFrom} style={inputStyle}
              onChange={e => e.target.value && guarded('別の日付', () => setApplyFrom(e.target.value))} />
          </>
        )}
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: subText, cursor: 'pointer' }}>
          <input type="checkbox" checked={markScreen} onChange={e => setMarkScreen(e.target.checked)} />
          変わった所に印
          <span style={{ ...changeCellStyle(true), padding: '0 4px', borderRadius: 3 }}>違うマス</span>
          <span style={CHANGE_MARK_SPAN}>違う名前・時刻</span>
          {plan ? `（決定済みの表 ${md(plan.apply_from)} 時点と比べて）` : `（${md(prevDate(applyFrom))} と比べて）`}
        </label>
      </div>

      {!isAdult && <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 8, alignItems: 'center' }}>
        <button type="button" style={toggle(viewMode === 'day')} onClick={() => setViewMode('day')}>曜日で見る</button>
        <button type="button" style={toggle(viewMode === 'person')} onClick={() => { setViewMode('person'); setOpenKey(null); }}>人ごとに見る</button>
        {viewMode === 'person' && <span style={{ fontSize: 12, color: subText }}>見るだけです。マスを押すと、その曜日の表のマスが開きます</span>}
      </div>}
      {!isAdult && viewMode === 'person' && personTable()}
      {isAdult && adultGrid()}
      {!isAdult && viewMode === 'day' && (<>
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 8 }}>
        {KIDS_WEEK.map(d => (
          <button key={d} type="button" style={toggle(day === d)} onClick={() => { setDay(d); setOpenKey(null); }}>
            {ROSTER_DAY_LABEL[d]}
          </button>
        ))}
      </div>

      {stale && (
        <div style={{ ...warnCard, marginBottom: 8 }}>
          {saveErr}
          <button type="button" style={{ ...primaryBtn, marginLeft: 8 }} onClick={() => void load(true)}>読み込み直す</button>
        </div>
      )}

      {/* 校の見出し */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 6, fontSize: 12.5, color: text }}>
        {[...new Set(cols.map(c => c.school ?? ''))].filter(Boolean).map(school => {
          const h = headBySchool(school);
          if (!h) return null;
          const lines = shownCell(h.id, day).map(it => itemText(it, nameOf, roleLabel));
          const isRed = !cellEquals(shownCell(h.id, day), baseCell(h.id, day));
          const mark = isRed && markScreen;
          const marked = mark ? diffLines(lines, baseCell(h.id, day).map(it => itemText(it, nameOf, roleLabel))) : null;
          return (
            <button key={school} type="button" onClick={() => setOpenKey(o => (o === cellKey(h.id, day) ? null : cellKey(h.id, day)))}
              style={{ ...inputStyle, cursor: 'pointer', textAlign: 'left', color: text, ...changeCellStyle(mark) }}>
              <b>{school}</b>{marked
                ? <>{marked.lines.map((ln, i) => <React.Fragment key={i}>{'\u3000'}{renderMarked(ln)}</React.Fragment>)}{renderRemoved(marked.removed)}</>
                : lines.length > 0 ? `\u3000${lines.join('\u3000')}` : '\u3000（見出しの役割を入れる）'}
            </button>
          );
        })}
      </div>

      {studyErr && <div style={{ ...warnCard, marginBottom: 6 }}>{studyErr}</div>}
      {/* 表（左に時刻の列・全校を時刻の帯でそろえる・2026-10-06 ユーザー確定 案E）。
          本校 3F・5F の帯のすぐ下に「共通 ○人／要る ○：…｜他業務：…」。組み立ては lib/kidsShiftBands.ts（PDF と同じ） */}
      <div style={{ overflowX: 'auto', border: `1px solid ${borderColor}`, borderRadius: 8 }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: Math.max(600, cols.length * 150 + 56), tableLayout: 'fixed' }}>
          <thead>
            <tr style={{ background: innerBg }}>
              <th style={{ width: 56, padding: '6px 4px', borderBottom: `1px solid ${borderColor}`, fontSize: 12, color: subText }}>時刻</th>
              {cols.map(c => {
                const k = cellKey(c.id, day);
                // 🚨 確認済みは数えない（押すと薄くなり数から外れる・設計書 5-9）
                const warn = issuesOf(c.id, day).filter(i => !isAcked(c.id, day, i.key)).length;
                const diff = isDiff(c.id, day);   // 比べているときだけ true
                const dirty = changedKeys.includes(k);
                return (
                  <th key={c.id} onClick={() => setOpenKey(o => (o === k ? null : k))}
                    style={{
                      padding: '6px 4px', borderBottom: `1px solid ${borderColor}`, borderLeft: `1px solid ${borderColor}`, fontSize: 12.5, color: text, cursor: 'pointer',
                      outline: dirty ? '2px solid #e65100' : openKey === k ? '2px solid #1976d2' : 'none', outlineOffset: -2,
                    }}>
                    {c.label}{warn > 0 ? ' ⚠️' : ''}{diff ? ' ≠' : ''}
                  </th>
                );
              })}
              {cols.length === 0 && <th style={{ padding: 10, color: subText, fontSize: 13 }}>この曜日には、まだ何も入っていません</th>}
            </tr>
          </thead>
          <tbody>
            {cols.length > 0 && bandsNow.map((b, bi) => {
              const pr = poolNow?.rows[bi];
              const prBase = poolNow?.baseRows[bi];
              const withPool = !!pr?.show;
              return (
                <React.Fragment key={bi}>
                  <tr>
                    <td rowSpan={withPool ? 2 : 1}
                      style={{ padding: '4px', borderTop: `1px solid ${borderColor}`, verticalAlign: 'top', fontSize: 12.5, fontWeight: 'bold', color: text, background: innerBg }}>
                      {b.label}
                    </td>
                    {cols.map(c => {
                      const k = cellKey(c.id, day);
                      const items = itemsByBand(shownCell(c.id, day), bandsNow)[bi];
                      const baseItems = itemsByBand(baseCell(c.id, day), bandsNow)[bi];
                      const lines = linesOfItems(c.id, items);
                      // 変わった所の印は帯ごとに見る（マス全体ではなく、変わった帯だけ薄い黄色）
                      const changed = markScreen && sigOfItems(items) !== sigOfItems(baseItems);
                      const marked = changed ? diffLines(lines, linesOfItems(c.id, baseItems)) : null;
                      const inPool = withPool && !!poolNow?.ids.has(c.id);
                      return (
                        <td key={c.id} rowSpan={withPool && !inPool ? 2 : 1} onClick={() => setOpenKey(o => (o === k ? null : k))}
                          style={{
                            padding: '4px', borderTop: `1px solid ${borderColor}`, borderLeft: `1px solid ${borderColor}`, verticalAlign: 'top', cursor: 'pointer',
                            fontSize: 12, color: text, ...changeCellStyle(changed),
                            outline: openKey === k ? '2px solid #1976d2' : 'none', outlineOffset: -2,
                          }}>
                          {lines.length === 0 && bi === 0 && shownCell(c.id, day).length === 0 && <span style={{ color: subText }}>—</span>}
                          {lines.map((l, i) => <div key={i}>{marked ? renderMarked(marked.lines[i]) : l}</div>)}
                          {marked && renderRemoved(marked.removed, true)}
                          {studyLinesOf(c.id, day, bandsNow, bi).map((l, i) => (
                            <div key={`s${i}`} style={{ color: subText }} title="勉強会の表から自動で出ています（ここでは直せません）">{l}</div>
                          ))}
                          {/* 大人の 6F（大人シフト表から自動・ここでは直せない） */}
                          {c.id === kids6F?.id && adultLines(itemsByBand(adult6FOf(day), bandsNow)[bi] ?? [], nameOf).map((l, i) => (
                            <div key={`a${i}`} title={`大人シフト表から自動で出ています（${otherPlan ? `${otherPlan.name}` : '決定済み'}・ここでは直せません）`}
                              style={{ color: subText, fontSize: l.kind === 'staff' ? 12.5 : 11.5, fontWeight: l.kind === 'staff' ? 'bold' : 'normal', ...(otherPlan ? compareBand(isDarkMode) : {}) }}>
                              {i === 0 && <span style={{ fontSize: 10.5, padding: '0 4px', marginRight: 3, borderRadius: 3, border: `1px solid ${borderColor}` }}>大人</span>}
                              {l.text}
                            </div>
                          ))}
                        </td>
                      );
                    })}
                  </tr>
                  {withPool && pr && poolNow && (
                    <tr>
                      {(() => {
                        const pk = cellKey(poolNow.place.id, day);
                        const text1 = pr.common.map(x => `${nameOf(x.userId)}${x.note}`).join('・') || 'なし';
                        const text2 = pr.other.map(o => `${nameOf(o.userId)}${o.where ? `（${o.where}）` : ''}`).join('・');
                        const baseText = prBase ? [prBase.common.map(x => `${nameOf(x.userId)}${x.note}`).join('・'), prBase.other.map(o => `${nameOf(o.userId)}${o.where ? `（${o.where}）` : ''}`).join('・')] : ['', ''];
                        const changed = markScreen && (text1 !== (baseText[0] || 'なし') || text2 !== baseText[1]);
                        const m1 = changed ? diffLines([text1], [baseText[0]]) : null;
                        const m2 = changed ? diffLines([text2], [baseText[1]]) : null;
                        const short = pr.common.length < pr.need;
                        return (
                          <td colSpan={poolNow.span} onClick={() => setOpenKey(o => (o === pk ? null : pk))}
                            style={{
                              padding: '4px 6px', borderTop: `1px dashed ${borderColor}`, borderLeft: `1px solid ${borderColor}`, cursor: 'pointer',
                              fontSize: 12, color: text, background: isDarkMode ? '#3a3f44' : '#f7f7f5', ...changeCellStyle(changed),
                              outline: openKey === pk ? '2px solid #1976d2' : 'none', outlineOffset: -2,
                            }}>
                            <span style={{ fontSize: 11, padding: '0 5px', borderRadius: 3, marginRight: 6, background: short ? '#fff3cd' : '#d3d1c7', color: short ? '#856404' : '#2c2c2a', border: short ? '1px solid #ffc107' : 'none' }}>
                              共通 {pr.common.length}人／要る {pr.need}{short ? `（あと ${pr.need - pr.common.length} 人）` : ''}
                            </span>
                            {m1 ? renderMarked(m1.lines[0]) : text1}
                            {(text2 || (m2 && m2.removed.length > 0)) && (
                              <span style={{ marginLeft: 10 }}>
                                <span style={{ fontSize: 11, padding: '0 5px', borderRadius: 3, marginRight: 4, border: '1px solid #b4b2a9', background: '#fff', color: '#444441' }}>他業務</span>
                                {m2 ? renderMarked(m2.lines[0]) : text2}
                              </span>
                            )}
                            {m1 && renderRemoved([...m1.removed, ...(m2?.removed ?? [])])}
                          </td>
                        );
                      })()}
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 6 }}>
        <select style={inputStyle} value="" onChange={e => {
          if (!e.target.value) return;
          setExtraColumns(prev => new Set([...prev, `${e.target.value}|${day}`]));
          setOpenKey(cellKey(e.target.value, day));
        }}>
          <option value="">＋ 列を足す（この曜日）</option>
          {activeColumns.filter(c => !cols.some(x => x.id === c.id)).map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>
        {poolPlaces.map(pp => {
          const n = shownCell(pp.id, day).find(it => it.kind === 'pool')?.people.length ?? 0;
          return (
            <button key={pp.id} type="button" style={{ ...inputStyle, cursor: 'pointer' }}
              onClick={() => setOpenKey(o => (o === cellKey(pp.id, day) ? null : cellKey(pp.id, day)))}>
              {pp.school} 3F・5F で動ける人（{ROSTER_DAY_LABEL[day]}）{n > 0 ? `：${n}人` : 'を入れる'}
            </button>
          );
        })}
        {dayNotePlace && (
          <button type="button" style={{ ...inputStyle, cursor: 'pointer' }}
            onClick={() => setOpenKey(o => (o === cellKey(dayNotePlace.id, day) ? null : cellKey(dayNotePlace.id, day)))}>
            曜日の書き添え{shownCell(dayNotePlace.id, day).length > 0 ? `：${shownCell(dayNotePlace.id, day).map(i => i.note).join('／')}` : 'を入れる'}
          </button>
        )}
      </div>

      <div style={{ marginTop: 6, fontSize: 12.5, color: subText }}>
        （社員休み）{offOfDay(day).map(s => nameOf(s.id)).join('・') || 'なし'}
      </div>

      {openKey && openKey.endsWith(`|${day}`) && cellEditor(openKey.split('|')[0], day)}
      </>)}

      {/* 追加必要・重なり */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 12 }}>
        {!isAdult && <div style={{ flex: 1, minWidth: 260, padding: '8px 12px', borderRadius: 8, border: `1px solid ${borderColor}`, background: cardBg }}>
          <b style={{ fontSize: 13, color: text }}>追加必要 {shortfalls.length} 件</b>
          <div style={{ fontSize: 12, color: subText, marginTop: 2 }}>レッスンが回るのに足りない人数です。</div>
          {shortfalls.slice(0, 12).map((s, i) => (
            <div key={i} style={{ fontSize: 12.5, color: text, marginTop: 3 }}>
              <button type="button" style={linkBtn} onClick={() => { setDay(s.day); setOpenKey(cellKey(s.place.id, s.day)); }}>
                {ROSTER_DAY_LABEL[s.day]} {s.place.label} {s.item.start || ''}
              </button>
              {'\u3000あと '}{s.need} 人{s.lessonNeed > 0 ? `（うちレッスンできる人 ${s.lessonNeed} 人）` : ''}
            </div>
          ))}
          {shortfalls.length > 12 && <div style={{ fontSize: 12, color: subText, marginTop: 3 }}>ほか {shortfalls.length - 12} 件</div>}
          {KIDS_WEEK.flatMap(d => poolPlaces.flatMap(pp => {
            const ctx = poolCtxOf(d, pp);
            return bandsOfDay(activeColumns.map(c => ({ placeId: c.id, items: shownCell(c.id, d) })), isClassItem)
              .map(b => ({ d, pp, b, r: poolRowOfBand(b, ctx) }))
              .filter(x => x.r.show && x.r.common.length < x.r.need);
          })).map((x, i) => (
            <div key={`pool${i}`} style={{ fontSize: 12.5, color: text, marginTop: 3 }}>
              <button type="button" style={linkBtn} onClick={() => { setDay(x.d); setOpenKey(cellKey(x.pp.id, x.d)); }}>
                {ROSTER_DAY_LABEL[x.d]} {x.pp.school} 共通 {x.b.label}
              </button>
              {'\u3000あと '}{x.r.need - x.r.common.length} 人（共通 {x.r.common.length}人／要る {x.r.need}）
            </div>
          ))}
        </div>}
        <div style={{ flex: 1, minWidth: 260, padding: '8px 12px', borderRadius: 8, border: `1px solid ${borderColor}`, background: cardBg }}>
          <b style={{ fontSize: 13, color: text }}>重なり {overlaps.length} 件</b>
          <div style={{ fontSize: 12, color: subText, marginTop: 2 }}>同じ人が同じ時間に2か所へ入っています。</div>
          {overlaps.slice(0, 12).map((o, i) => (
            <div key={i} style={{ fontSize: 12.5, color: text, marginTop: 3 }}>
              {ROSTER_DAY_LABEL[o.day]} {nameOf(o.userId)} {o.start}〜{o.end}（{overlapData.names.get(o.a) ?? placeLabel(o.a)}・{overlapData.names.get(o.b) ?? placeLabel(o.b)}）
            </div>
          ))}
          {overlaps.length > 12 && <div style={{ fontSize: 12, color: subText, marginTop: 3 }}>ほか {overlaps.length - 12} 件</div>}
        </div>
        {/* 表をまたぐ重なり（2026-10-07・設計 §4） */}
        <div style={{ flex: 1, minWidth: 300, padding: '8px 12px', borderRadius: 8, border: `1px solid ${borderColor}`, background: cardBg, ...(otherPlan ? compareBand(isDarkMode) : {}) }}>
          <b style={{ fontSize: 13, color: text }}>
            {otherName}との重なり 🔴 {cross.filter(o => o.level === 'red').length} 件 ／ ⚠️ {cross.filter(o => o.level === 'warn').length} 件
          </b>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', fontSize: 12, color: subText, marginTop: 4 }}>
            比べる相手
            <select style={inputStyle} value={otherWith} onChange={e => setOtherWith(e.target.value)}>
              <option value="decided">{otherName}の決定済みの表</option>
              {(other?.plans ?? []).filter(p => p.status === 'open').map(p => <option key={p.id} value={p.id}>{p.name}（作業中の案）</option>)}
            </select>
            {otherPlan && <span>（{otherPlan.name}と比べた場合）</span>}
          </div>
          <div style={{ fontSize: 12, color: subText, marginTop: 4 }}>
            🔴＝直す（担当どうし・出張が絡むもの・担当と別の校）／⚠️＝確かめる（そのほか）。
            {isAdult ? ' 🔴 があると決定できません（こどもの決定済みと比べます）。' : ' 大人との重なりでは保存・決定を止めません（大人の表で直します）。'}
          </div>
          {otherErr && <div style={{ fontSize: 12.5, color: red, marginTop: 4 }}>{otherErr}</div>}
          {isAdult && otherPlan && crossRedVsDecided > 0 && (
            <div style={{ fontSize: 12.5, color: text, marginTop: 4 }}>※ こどもの決定済みとの 🔴：{crossRedVsDecided} 件（決定できるかはこちらで見ます）</div>
          )}
          {cross.slice(0, 15).map((o, i) => {
            const mine = isAdult ? o.adult : o.kids;
            return (
              <div key={i} style={{ fontSize: 12.5, color: text, marginTop: 3 }}>
                <button type="button" style={linkBtn}
                  onClick={() => { if (!isAdult) { setViewMode('day'); setDay(o.day); } setOpenBand(null); setBandFor(null); setOpenKey(cellKey(mine.placeId, o.day)); }}>
                  {o.level === 'red' ? '🔴' : '⚠️'} {ROSTER_DAY_LABEL[o.day]} {nameOf(o.userId)} {minText(o.s)}〜{minText(o.e)}
                </button>
                {' '}{o.kids.label} ／ {o.adult.label}
              </div>
            );
          })}
          {cross.length > 15 && <div style={{ fontSize: 12, color: subText, marginTop: 3 }}>ほか {cross.length - 15} 件</div>}
          {other && cross.length === 0 && <div style={{ fontSize: 12.5, color: subText, marginTop: 4 }}>ありません</div>}
        </div>
      </div>

      {/* ⚠️（出勤していない）。🚨 保存は止めない。印を出すだけ（設計書 5-9） */}
      <div style={{ marginTop: 10, padding: '8px 12px', borderRadius: 8, border: `1px solid ${borderColor}`, background: cardBg }}>
        <b style={{ fontSize: 13, color: text }}>
          ⚠️ {issueCount.open} 件{issueCount.acked > 0 ? `（確認済み ${issueCount.acked}）` : ''}
        </b>
        <div style={{ fontSize: 12, color: subText, marginTop: 2 }}>
          週のシフトでは、その時間に出勤していない方です。保存はできます。
          {/* 🚨 園指導と見出しの役割だけ見方が違うので、その場に書いておく */}
          <br />※ 園指導と見出しの役割は<strong>その曜日が休みかどうかだけ</strong>を見ます（時刻・校は見ません）
        </div>
        {(() => {
          const all = KIDS_WEEK.flatMap(d =>
            issuePlaces
              .flatMap(p => issuesOf(p.id, d).map(i => ({ d, p, i, acked: isAcked(p.id, d, i.key) }))));
          const open = all.filter(x => !x.acked);
          if (all.length === 0) return <div style={{ fontSize: 12.5, color: subText, marginTop: 4 }}>ありません</div>;
          return (
            <>
              {open.slice(0, 12).map((x, n) => (
                <div key={n} style={{ fontSize: 12.5, color: text, marginTop: 4, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <button type="button" style={linkBtn} onClick={() => { setDay(x.d); setOpenKey(cellKey(x.p.id, x.d)); }}>
                    {ROSTER_DAY_LABEL[x.d]} {x.p.label}
                  </button>
                  <span>{x.i.text}</span>
                  <button type="button" style={{ ...linkBtn, color: subText }} onClick={() => void ackIssue(x.p.id, x.d, x.i.key)}>確認した</button>
                </div>
              ))}
              {open.length > 12 && <div style={{ fontSize: 12, color: subText, marginTop: 3 }}>ほか {open.length - 12} 件</div>}
              {open.length === 0 && <div style={{ fontSize: 12.5, color: subText, marginTop: 4 }}>すべて確認済みです</div>}
            </>
          );
        })()}
      </div>

      {/* 保存 */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 12 }}>
        <button type="button" style={{ ...primaryBtn, opacity: changedKeys.length === 0 || saving ? 0.5 : 1 }}
          disabled={changedKeys.length === 0 || saving}
          onClick={() => (plan ? void doSavePlan() : setConfirming(true))}>
          {plan ? `${plan.name}を保存` : `決定済みの表に保存（${md(applyFrom)} から）`}
        </button>
        {plan && (
          <button type="button" style={{ ...inputStyle, cursor: 'pointer', fontWeight: 'bold' }} disabled={saving}
            onClick={() => (changedKeys.length > 0 ? setSaveErr('先に案を保存してから決定してください。') : void startDecide())}>
            この案で決定する
          </button>
        )}
        {changedKeys.length > 0 && <span style={{ fontSize: 12.5, color: '#e65100' }}>未保存のマス {changedKeys.length}</span>}
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button type="button" style={{ ...inputStyle, cursor: 'pointer' }} onClick={() => setPanel(p => (p === 'pdf' ? 'none' : 'pdf'))}>PDF</button>
          <button type="button" style={{ ...inputStyle, cursor: 'pointer' }} onClick={() => setPanel(p => (p === 'places' ? 'none' : 'places'))}>列の一覧</button>
          <button type="button" style={{ ...inputStyle, cursor: 'pointer' }} onClick={() => setPanel(p => (p === 'kinds' ? 'none' : 'kinds'))}>行の種類・書き添え</button>
          {!isAdult && <button type="button" style={{ ...inputStyle, cursor: 'pointer' }} onClick={() => setPanel(p => (p === 'people' ? 'none' : 'people'))}>レッスンできる人</button>}
          <button type="button" style={{ ...inputStyle, cursor: 'pointer' }} onClick={() => setPanel(p => (p === 'settings' ? 'none' : 'settings'))}>設定</button>
        </span>
      </div>

      {saveErr && !stale && <div style={{ color: red, marginTop: 8, fontSize: 13 }}>{saveErr}</div>}
      {saveMsg && <div style={{ ...okCard, marginTop: 8 }}>✓ {saveMsg}</div>}

      {/* 保存の確認（決定済みの表） */}
      {confirming && !plan && (
        <div ref={confirmBoxRef} style={{ ...warnCard, marginTop: 10 }}>
          <b>{md(applyFrom)} から、{changedKeys.length} マスを切り替えます</b>
          <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
            {changedKeys.slice(0, 20).map(k => {
              const [placeId, d] = k.split('|');
              return <li key={k}>{placeLabel(placeId)}（{ROSTER_DAY_LABEL[d as RosterDayKind]}）</li>;
            })}
            {changedKeys.length > 20 && <li>ほか {changedKeys.length - 20} マス</li>}
          </ul>
          {emptied > 0 && <div style={{ marginTop: 6 }}>空に戻すマス：{emptied}</div>}
          {keptFuture.length > 0 && (
            <div style={{ marginTop: 6 }}>先の変更を残すマス：<br />{keptFuture.map((t, i) => <div key={i}>・{t}</div>)}</div>
          )}
          {isPast && <div style={{ marginTop: 6 }}>🚨 今日より前の日付です。さかのぼって保存します。</div>}
          <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            <button type="button" style={primaryBtn} disabled={saving} onClick={() => void doSaveDecided()}>
              {isPast ? 'さかのぼって保存する' : '保存する'}
            </button>
            <button type="button" style={{ ...inputStyle, cursor: 'pointer' }} onClick={() => setConfirming(false)}>やめる</button>
          </div>
        </div>
      )}

      {/* 決定の確認 */}
      {decideState && plan && (
        <div ref={decideBoxRef} style={{ ...warnCard, marginTop: 10 }}>
          <b>{plan.name}を {md(plan.apply_from)} から決定します（変わるマス {decideState.changeCount}）</b>
          {decideState.conflicts.length > 0 ? (
            <div style={{ marginTop: 6 }}>
              ⚠️ 次のマスは、案を作ったあとに決定済みの表でも直されています。どちらを残すか選んでください。
              {decideState.conflicts.map(c => {
                const k = cellKey(c.place_id, c.day_kind);
                const use = decideState.choices[k] ?? 'plan';
                return (
                  <div key={k} style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4, flexWrap: 'wrap' }}>
                    <span>{c.label}（{ROSTER_DAY_LABEL[c.day_kind as RosterDayKind]}）</span>
                    <button type="button" style={toggle(use === 'plan')}
                      onClick={() => setDecideState({ ...decideState, choices: { ...decideState.choices, [k]: 'plan' } })}>案の値にする</button>
                    <button type="button" style={toggle(use === 'decided')}
                      onClick={() => setDecideState({ ...decideState, choices: { ...decideState.choices, [k]: 'decided' } })}>決定済みを残す</button>
                  </div>
                );
              })}
            </div>
          ) : <div style={{ marginTop: 6 }}>決定済みの表とのぶつかりはありません。</div>}
          {decideState.keptCount > 0 && <div style={{ marginTop: 6 }}>先の変更を残すマス：{decideState.keptCount}</div>}
          <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            <button type="button" style={primaryBtn} disabled={saving} onClick={() => void doDecide()}>決定する</button>
            <button type="button" style={{ ...inputStyle, cursor: 'pointer' }} onClick={() => setDecideState(null)}>やめる</button>
          </div>
        </div>
      )}

      {/* 切り替えの確認（未保存が消えないように） */}
      {guard && (
        <div style={{ ...warnCard, marginTop: 10 }}>
          未保存のマスが {dirtyCount} あります。{guard.text} に切り替えると、この直しは消えます。
          <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            <button type="button" style={primaryBtn}
              onClick={() => { const g = guard; setGuard(null); if (plan) { void doSavePlan().then(() => g.go()); } else { setConfirming(true); } }}>
              先に保存する
            </button>
            <button type="button" style={{ ...inputStyle, cursor: 'pointer' }}
              onClick={() => { setDrafts(prev => ({ ...prev, [view]: {} })); const g = guard; setGuard(null); g.go(); }}>
              捨てて切り替える
            </button>
            <button type="button" style={linkBtn} onClick={() => setGuard(null)}>やめる</button>
          </div>
        </div>
      )}

      {/* PDF */}
      {panel === 'pdf' && isAdult && (
        <div style={{ marginTop: 10, padding: '10px 12px', borderRadius: 8, border: `1px solid ${borderColor}`, background: cardBg, fontSize: 13, color: text }}>
          <b>PDF（A4横1枚）</b>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginTop: 6 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <input type="checkbox" checked={pdfMark} onChange={e => setPdfMark(e.target.checked)} />変わった所に印（ピンク）を付ける
            </label>
            <button type="button" style={primaryBtn} onClick={printAdultPdf}>別の窓に出す</button>
          </div>
          <div style={{ fontSize: 12, color: subText, marginTop: 6 }}>
            「こども」の行は{otherPlan ? `${otherPlan.name}（こどもの作業中の案）` : 'こどもシフト表の決定済みの表'}から出します（上の「比べる相手」で切り替え）。Excel は次の段階で作ります。
          </div>
        </div>
      )}
      {panel === 'pdf' && !isAdult && (
        <div style={{ marginTop: 10, padding: '10px 12px', borderRadius: 8, border: `1px solid ${borderColor}`, background: cardBg, fontSize: 13, color: text }}>
          <b>PDF（全校・A4横1枚）</b>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginTop: 6 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <input type="checkbox" checked={pdfMark} onChange={e => setPdfMark(e.target.checked)} />変わった所に印（ピンク）を付ける
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <input type="checkbox" checked={pdfBlank} onChange={e => setPdfBlank(e.target.checked)} />{'追加必要を「（ ）」で刷る'}
            </label>
            <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              紙：
              <button type="button" style={toggle(pdfLayout === 'two')} onClick={() => setPdfLayout('two')}>A4横2枚（月〜水・木〜日）</button>
              <button type="button" style={toggle(pdfLayout === 'one')} onClick={() => setPdfLayout('one')}>A4横1枚（字を小さく詰める）</button>
            </span>
            <button type="button" style={primaryBtn} onClick={() => printPdf()}>全校を別の窓に出す</button>
          </div>
          {/* 校ごとの PDF（2026-09-22）。🚨 その校の列がある曜日だけが出る（中身のある列だけ、の決まりは同じ） */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
            <span style={{ fontSize: 12.5, color: subText }}>校ごとに出す</span>
            {schools.map(sc => (
              <button key={sc} type="button" style={{ ...inputStyle, cursor: 'pointer' }} onClick={() => printPdf(sc)}>{sc}</button>
            ))}
            {schools.length === 0 && <span style={{ fontSize: 12.5, color: subText }}>（列がありません）</span>}
          </div>
          {/* Excel（2026-09-22・ユーザー確定 案ウ＝シートを2つに分ける） */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
            <button type="button" style={{ ...inputStyle, cursor: 'pointer' }} onClick={() => void exportExcel()}>Excel で書き出す</button>
            <span style={{ fontSize: 12, color: subText }}>
              シートは2つ：「表」（紙と同じ見た目）と「一覧」（1行＝1件。並べ替え・絞り込み・集計に使えます）
            </span>
          </div>
        </div>
      )}

      {/* 列の一覧 */}
      {panel === 'places' && (
        <div style={{ marginTop: 10, padding: '10px 12px', borderRadius: 8, border: `1px solid ${borderColor}`, background: cardBg, fontSize: 13, color: text }}>
          <b>列の一覧</b>
          <div style={{ fontSize: 12, color: subText, marginTop: 2 }}>🚨 マスが入っている列の校・階は変えられません（新しい列を足して、この列を隠してください）。</div>
          {places.map(p => (
            <div key={p.id} style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4, flexWrap: 'wrap' }}>
              <span style={{ width: 90, color: subText, fontSize: 12 }}>{p.kind === 'column' ? '列' : p.kind === 'head' ? '校の見出し' : p.kind === 'trip' ? '出張の列' : p.kind === 'pool' ? '共通の人' : '曜日の書き添え'}</span>
              <input type="text" defaultValue={p.label} maxLength={30} style={inputStyle}
                onBlur={e => { if (e.target.value.trim() && e.target.value !== p.label) void savePlace({ id: p.id, label: e.target.value.trim() }).then(er => { setPanelErr(er ?? ''); return load(true); }); }} />
              <button type="button" style={linkBtn}
                onClick={() => void savePlace({ id: p.id, active: !p.active }).then(er => { setPanelErr(er ?? ''); return load(true); })}>
                {p.active ? '隠す' : '戻す'}
              </button>
              {!p.active && <span style={{ fontSize: 12, color: subText }}>（隠しています）</span>}
            </div>
          ))}
        </div>
      )}

      {/* 行の種類・表全体の書き添え */}
      {panel === 'kinds' && (
        <div style={{ marginTop: 10, padding: '10px 12px', borderRadius: 8, border: `1px solid ${borderColor}`, background: cardBg, fontSize: 13, color: text }}>
          <b>行の種類</b>
          {data.rowKinds.map(k => (
            <div key={k.key} style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4, flexWrap: 'wrap' }}>
              <input type="text" defaultValue={k.label} maxLength={20} style={inputStyle}
                onBlur={e => { if (e.target.value.trim() && e.target.value !== k.label) void saveMasterRow('kids_shift_row_kinds', { key: k.key, label: e.target.value.trim() }, 'key').then(er => { setPanelErr(er ?? ''); return load(true); }); }} />
              <span style={{ fontSize: 12, color: subText }}>
                {[k.has_class && 'クラス名', k.has_groups && '班の数', k.has_people && '人'].filter(Boolean).join('・')}
                {k.issue_mode === 'day_only' ? '／⚠️ は曜日の休みだけ' : ''}
              </span>
              <button type="button" style={linkBtn}
                onClick={() => void saveMasterRow('kids_shift_row_kinds', { key: k.key, active: !k.active }, 'key').then(er => { setPanelErr(er ?? ''); return load(true); })}>
                {k.active ? '隠す' : '戻す'}
              </button>
            </div>
          ))}
          <b style={{ display: 'block', marginTop: 10 }}>表全体の書き添え</b>
          {data.notes.map(n => (
            <div key={n.id} style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4, flexWrap: 'wrap' }}>
              <input type="text" defaultValue={n.body} maxLength={300} style={{ ...inputStyle, flex: 1, minWidth: 240 }}
                onBlur={e => { if (e.target.value.trim() && e.target.value !== n.body) void saveMasterRow('kids_shift_notes', { id: n.id, body: e.target.value.trim() }, 'id').then(er => { setPanelErr(er ?? ''); return load(true); }); }} />
              <button type="button" style={linkBtn}
                onClick={() => void saveMasterRow('kids_shift_notes', { id: n.id, active: !n.active }, 'id').then(er => { setPanelErr(er ?? ''); return load(true); })}>
                {n.active ? '隠す' : '戻す'}
              </button>
            </div>
          ))}
          <button type="button" style={{ ...inputStyle, cursor: 'pointer', marginTop: 6 }}
            onClick={() => void saveMasterRow('kids_shift_notes', { __new: true, body: '（新しい書き添え）', sort_order: (data.notes.at(-1)?.sort_order ?? 0) + 10 }, 'id').then(er => { setPanelErr(er ?? ''); return load(true); })}>
            ＋ 書き添えを足す
          </button>
        </div>
      )}

      {/* レッスンできる人 */}
      {panel === 'people' && (
        <div style={{ marginTop: 10, padding: '10px 12px', borderRadius: 8, border: `1px solid ${borderColor}`, background: cardBg, fontSize: 13, color: text }}>
          <b>レッスンできる人</b>
          <div style={{ fontSize: 12, color: subText, marginTop: 2 }}>印が無いときは、正社員＝できる／パート＝できない、として数えます。</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 6 }}>
            {activeStaff.map(s => (
              <label key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 4, width: 220 }}>
                <input type="checkbox" checked={canLesson(s.id)}
                  onChange={e => void saveLessonFlag(s.id, e.target.checked).then(er => { setPanelErr(er ?? ''); return load(true); })} />
                {fullName(s.name)}<span style={{ fontSize: 11.5, color: subText }}>{s.employment_type === 'パート' ? '（パート）' : ''}</span>
              </label>
            ))}
          </div>
        </div>
      )}

      {/* 設定 */}
      {panel === 'settings' && (
        <div style={{ marginTop: 10, padding: '10px 12px', borderRadius: 8, border: `1px solid ${borderColor}`, background: cardBg, fontSize: 13, color: text }}>
          <b>設定</b>
          {!isAdult && <>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6, flexWrap: 'wrap' }}>
            <span>レッスンできる人の確かめ</span>
            <button type="button" style={toggle(data.settings.lesson_check)}
              onClick={() => void saveKidsSettings({ lesson_check: true }).then(er => { setPanelErr(er ?? ''); return load(true); })}>する</button>
            <button type="button" style={toggle(!data.settings.lesson_check)}
              onClick={() => void saveKidsSettings({ lesson_check: false }).then(er => { setPanelErr(er ?? ''); return load(true); })}>しない</button>
          </div>
          <div style={{ marginTop: 8 }}>班の数ごとの人数（初期値）</div>
          {['1', '2', '3', '4', '5'].map(g => (
            <div key={g} style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
              <span style={{ width: 50 }}>{g}班</span>
              <span>必要</span>
              <input type="number" min={0} max={20} defaultValue={data.settings.required_by_groups[g] ?? ''} style={{ ...inputStyle, width: 64 }}
                onBlur={e => void saveKidsSettings({ required_by_groups: { ...data.settings.required_by_groups, [g]: Number(e.target.value) } })
                  .then(er => { setPanelErr(er ?? ''); return load(true); })} />
              <span>人／うちレッスンできる人</span>
              <input type="number" min={0} max={20} defaultValue={data.settings.min_lesson_by_groups[g] ?? ''} style={{ ...inputStyle, width: 64 }}
                onBlur={e => void saveKidsSettings({ min_lesson_by_groups: { ...data.settings.min_lesson_by_groups, [g]: Number(e.target.value) } })
                  .then(er => { setPanelErr(er ?? ''); return load(true); })} />
              <span>人</span>
            </div>
          ))}
          </>}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
            <span>作業中の案の上限{isAdult ? '（こども・大人それぞれ）' : ''}</span>
            <input type="number" min={1} max={50} defaultValue={data.settings.plan_limit} style={{ ...inputStyle, width: 70 }}
              onBlur={e => void saveKidsSettings({ plan_limit: Number(e.target.value) }).then(er => { setPanelErr(er ?? ''); return load(true); })} />
            <span>個</span>
          </div>
        </div>
      )}

      {panelErr && <div style={{ color: red, marginTop: 8, fontSize: 13 }}>{panelErr}</div>}
      {anyDirty && <div style={{ fontSize: 12, color: subText, marginTop: 8 }}>🚨 未保存の直しは、この画面を離れると消えます。</div>}
    </div>
  );
};

export default KidsShiftPanel;

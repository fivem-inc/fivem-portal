import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { todayJstStr } from '../../lib/breakCalc';
import { ROSTER_DAY_LABEL, prevDate, shiftDayOn, type RosterDayKind } from '../../lib/shiftRoster';
import { loadRosterData, type RosterData, type RosterPatternRow } from '../../lib/shiftRosterApi';
import { fullName, shortNameMap } from '../../lib/staffName';
import { openRosterPrint } from '../../lib/shiftRosterPrint';
import {
  KIDS_WEEK, cellEquals, cellVersionOn, defaultsForGroups, emptyItem, itemText, itemTextWithBlanks,
  kidsCellIssues, kidsGridSheet, kidsListSheet, makeCanLesson, mergeCell, offStaffOfDay, overlapsOfDay, shortfallOf,
  type KidsCellValue, type KidsIssue, type KidsItem, type KidsPerson, type KidsPlace, type KidsPlan, type KidsPlanCell,
} from '../../lib/kidsShift';
import {
  ackKidsIssue, decidePlan, loadKidsData, loadKidsToken, loadPlanCells, savePlan, saveKidsCells, saveKidsSettings,
  saveLessonFlag, saveMasterRow, savePlace, toPayloadCells, type KidsData,
} from '../../lib/kidsShiftApi';
import { buildKidsPrintHtml } from '../../lib/kidsShiftPrint';

// ⑤ こどもシフト表（2026-09-16・段階1の1回目）。設計・決めたことは docs/計画-管理画面の開放.md の 5-9〜5-9-3。
// ・置き場所（列・校の見出し・曜日の書き添え）×曜日のマスを「いつから」で版にする（変えたマスだけ・先の版は残す）
// ・案は「変えたマスだけ」を持つ。決定すると決定済みの表に入り、案はしまう（しまった案は2年で消える）
// ・追加必要＝必要な人数に足りない分（班の数から初期値）。重なり＝同じ人が同じ時間に2か所
// 🚨 ⚠️（出勤していない）と「確認した」・案を比べる・Excel・校ごとの PDF は2回目
// 🚨 下書きは「決定済みの表」と「案ごと」で分けて持つ（切り替えで混ざらないように・レビュー U2）

const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
const cellKey = (placeId: string, day: string) => `${placeId}|${day}`;

const KidsShiftPanel: React.FC<{ isDarkMode: boolean }> = ({ isDarkMode }) => {
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
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState('');
  const [saveMsg, setSaveMsg] = useState('');
  const [stale, setStale] = useState(false);
  const [panel, setPanel] = useState<'none' | 'places' | 'kinds' | 'settings' | 'people' | 'pdf'>('none');
  const [panelErr, setPanelErr] = useState('');
  const [newPlan, setNewPlan] = useState<{ name: string; from: string; copy: string } | null>(null);
  const [decideState, setDecideState] = useState<{ conflicts: { place_id: string; day_kind: string; label: string }[]; keptCount: number; changeCount: number; choices: Record<string, 'plan' | 'decided'> } | null>(null);
  const [guard, setGuard] = useState<{ text: string; go: () => void } | null>(null);
  const [pdfRed, setPdfRed] = useState(true);
  const [pdfBlank, setPdfBlank] = useState(true);
  const [showArchived, setShowArchived] = useState(false);

  const plan: KidsPlan | null = useMemo(
    () => (view === 'decided' ? null : (data?.plans ?? []).find(p => p.id === view) ?? null),
    [view, data],
  );
  const baseDate = plan ? plan.apply_from : applyFrom;

  const load = useCallback(async (keepDrafts: boolean) => {
    setLoading(true); setLoadErr('');
    const since = prevDate(baseDate);
    const [k, r, t] = await Promise.all([loadKidsData(since), loadRosterData(since), loadKidsToken()]);
    if (k.error || !k.data) { setLoadErr(k.error ?? 'こどもシフト表を読み込めませんでした'); setLoading(false); return; }
    if (r.error || !r.data) { setLoadErr(r.error ?? '週のシフトを読み込めませんでした'); setLoading(false); return; }
    if (t.error || t.token == null) { setLoadErr(`保存の準備ができませんでした：${t.error ?? ''}`); setLoading(false); return; }
    setData(k.data); setRoster(r.data); setToken(t.token); setStale(false);
    if (!keepDrafts) setDrafts({});
    setLoading(false);
  }, [baseDate]);

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

  const hasContent = useCallback((placeId: string, d: string) => shownCell(placeId, d).length > 0, [shownCell]);
  const [extraColumns, setExtraColumns] = useState<Set<string>>(new Set());
  const columnsOfDay = useCallback((d: RosterDayKind) =>
    activeColumns.filter(p => hasContent(p.id, d) || extraColumns.has(`${p.id}|${d}`)), [activeColumns, hasContent, extraColumns]);

  // 追加必要・重なり
  const shortfalls = useMemo(() => {
    if (!data) return [] as { place: KidsPlace; day: RosterDayKind; item: KidsItem; need: number; lessonNeed: number }[];
    const out: { place: KidsPlace; day: RosterDayKind; item: KidsItem; need: number; lessonNeed: number }[] = [];
    for (const d of KIDS_WEEK) for (const p of activeColumns) {
      for (const it of shownCell(p.id, d)) {
        const s = shortfallOf(it, data.settings, canLesson, inactive);
        if (s) out.push({ place: p, day: d, item: it, need: s.need, lessonNeed: s.lessonNeed });
      }
    }
    return out;
  }, [data, activeColumns, shownCell, canLesson, inactive]);

  // ⚠️（出勤していない・2026-09-22）。
  // 🚨 判定は lib/kidsShift.ts の kidsCellIssues（中身は ④掃除担当表・③勉強会と同じ shiftTimeIssue）。
  //    ここで書き直さない。
  // 🚨 保存は止めない。印を出すだけ（設計書 5-9「保存は止めない・［確認した］」）
  const issuesOf = useCallback((placeId: string, d: RosterDayKind): KidsIssue[] => {
    if (!data) return [];
    const place = data.places.find(p => p.id === placeId);
    return kidsCellIssues(
      placeId, d, shownCell(placeId, d),
      uid => shiftDayOn(rowsByUser.get(uid) ?? [], d, baseDate) ?? null,
      k => data.rowKinds.find(r => r.key === k)?.issue_mode ?? 'full',
      new Map(data.staff.map(s => [s.id, data.labels.get(s.id) || s.name])),
      inactive,
      place?.school ?? null,
    );
  }, [data, shownCell, rowsByUser, baseDate, inactive]);

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
    for (const d of KIDS_WEEK) for (const p of activeColumns.concat(data?.places.filter(x => x.kind === 'head' && x.active) ?? [])) {
      for (const i of issuesOf(p.id, d)) {
        if (isAcked(p.id, d, i.key)) acked++; else open++;
      }
    }
    return { open, acked };
  }, [activeColumns, data, issuesOf, isAcked]);

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
    for (const d of KIDS_WEEK) for (const p of activeColumns) if (isDiff(p.id, d)) n++;
    return n;
  }, [compareWith, activeColumns, isDiff]);
  const overlaps = useMemo(() => {
    const out: { day: RosterDayKind; userId: string; a: string; b: string; start: string; end: string }[] = [];
    for (const d of KIDS_WEEK) {
      const sources = activeColumns.map(p => ({ placeId: p.id, items: shownCell(p.id, d) }));
      for (const o of overlapsOfDay(d, sources)) {
        out.push({ day: d, userId: o.userId, a: o.aPlaceId, b: o.bPlaceId, start: o.start, end: o.end });
      }
    }
    return out;
  }, [activeColumns, shownCell]);


  const offOfDay = useCallback((d: RosterDayKind) => {
    if (!data) return [];
    return offStaffOfDay(data.staff, uid => {
      const rows = rowsByUser.get(uid) ?? [];
      return !!shiftDayOn(rows, d, baseDate)?.segments?.length;
    });
  }, [data, rowsByUser, baseDate]);

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
      apply_from: applyFrom, base_token: token, confirm_past: isPast,
      cells: toPayloadCells(changedKeys.map(k => {
        const [placeId, d] = k.split('|');
        return { placeId, day: d, items: viewDrafts[k] };
      })),
    });
    setSaving(false);
    if (r.error) { setSaveErr(`保存できませんでした：${r.error}`); return; }
    if (!r.ok && r.reason === 'stale') {
      setStale(true); setConfirming(false);
      setSaveErr('開いたあとに、別の人がこどもシフト表を保存しました。上書きしないよう保存を止めました。「読み込み直す」を押すと、直した内容は残したまま最新の状態と比べ直せます。');
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
    const r = await savePlan({ op: 'create', name: newPlan.name.trim(), apply_from: newPlan.from, copy_from: newPlan.copy || null });
    if (r.error) { setPanelErr(`作れませんでした：${r.error}`); return; }
    if (!r.ok && r.reason === 'plan_limit') { setPanelErr(`作業中の案が${r.limit}個あります。使わない案をしまってから、新しい案を作ってください。`); return; }
    if (!r.ok) { setPanelErr(`作れませんでした（${r.reason ?? ''}）`); return; }
    setNewPlan(null);
    await load(true);
    setView(String(r.plan_id));
  };

  const archivePlan = async (p: KidsPlan) => {
    setPanelErr('');
    const r = await savePlan({ op: 'archive', plan_id: p.id, revision: p.revision });
    if (r.error || !r.ok) { setPanelErr(`しまえませんでした：${r.error ?? r.reason ?? ''}`); return; }
    if (view === p.id) setView('decided');
    await load(true);
  };

  const startDecide = async () => {
    if (!plan || token == null) return;
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
    const changed = new Set<string>();
    for (const d of KIDS_WEEK) for (const p of activeColumns) {
      if (!cellEquals(shownCell(p.id, d), baseCell(p.id, d))) changed.add(cellKey(p.id, d));
    }
    const off: Partial<Record<RosterDayKind, string[]>> = {};
    const dayNotes: Partial<Record<RosterDayKind, string[]>> = {};
    for (const d of KIDS_WEEK) {
      off[d] = offOfDay(d).map(s => nameOf(s.id));
      dayNotes[d] = dayNotePlace ? shownCell(dayNotePlace.id, d).map(it => it.note).filter(Boolean) : [];
    }
    const html = buildKidsPrintHtml({
      title: `${md(baseDate)}〜 こどもシフト表${plan ? ` ${plan.name}` : ''}${onlySchool ? `（${onlySchool}）` : ''}`,
      asOf: today,
      notes: (data.notes ?? []).filter(n => n.active).map(n => n.body),
      places: onlySchool ? places.filter(p => p.school === onlySchool) : places,
      columnsOf: d => columnsOfDay(d).filter(c => !onlySchool || c.school === onlySchool),
      linesOf: (placeId, d) => shownCell(placeId, d).flatMap(it => {
        const s = shortfallOf(it, data.settings, canLesson, inactive);
        return (pdfBlank ? itemTextWithBlanks(it, nameOf, s, k => data.roleKinds.find(r => r.key === k)?.label ?? k)
          : itemText(it, nameOf, k => data.roleKinds.find(r => r.key === k)?.label ?? k)).split('\n');
      }),
      headOf: (school, d) => {
        const head = heads.find(h => h.school === school);
        if (!head) return [];
        return shownCell(head.id, d).map(it => itemText(it, nameOf, k => data.roleKinds.find(r => r.key === k)?.label ?? k));
      },
      changed, redChanges: pdfRed, offStaff: off, dayNotes,
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
      ));
      grid['!cols'] = [{ wch: 16 }, ...KIDS_WEEK.map(() => ({ wch: 26 }))];
      XLSX.utils.book_append_sheet(wb, grid, '表');
      const list = XLSX.utils.aoa_to_sheet(kidsListSheet(
        KIDS_WEEK, d => ROSTER_DAY_LABEL[d], d => columnsOfDay(d),
        (placeId, d) => shownCell(placeId, d), kindLabel, roleLabel, nameOf,
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
            <input type="text" value={it.class_name} maxLength={30} placeholder="クラス名（例：リトル）" style={{ ...inputStyle, width: 140 }}
              onChange={e => setItem({ class_name: e.target.value })} />
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
          {isRole && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12.5 }}>
              <input type="checkbox" checked={it.is_none} onChange={e => setItem({ is_none: e.target.checked, people: e.target.checked ? [] : it.people })} />
              なし
            </label>
          )}
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <button type="button" style={linkBtn} disabled={i === 0}
              onClick={() => setCell(placeId, d, all.map((x, j) => (j === i - 1 ? all[i] : j === i ? all[i - 1] : x)))}>▲</button>
            <button type="button" style={linkBtn} disabled={i === all.length - 1}
              onClick={() => setCell(placeId, d, all.map((x, j) => (j === i + 1 ? all[i] : j === i ? all[i + 1] : x)))}>▼</button>
            <button type="button" aria-label="この行を消す" style={{ ...linkBtn, color: red }}
              onClick={() => setCell(placeId, d, all.filter((_, j) => j !== i))}>✕ 消す</button>
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
                  <option value="lead">担当</option>
                  <option value="onduty">勤務中（担当しない）</option>
                  <option value="support">サポート</option>
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
                onClick={() => setItem({ people: [...it.people, { user_id: '', role: 'lead', start: '', end: '' }] })}
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
                  {'＋（　）追加必要をひとつ増やす'}
                </button>
              )}
            </div>
          </div>
        )}

        <input type="text" value={it.note} maxLength={200} placeholder={isNote ? '書き添え（例：今田・奥村ー誰か休みの時、各校に午前中出勤可能）' : '書き添え（例：（月1回）・定員5・打合せ4階）'}
          style={{ ...inputStyle, width: '100%', marginTop: 6 }} onChange={e => setItem({ note: e.target.value })} />
        {place?.kind === 'column' && (kind?.has_groups ?? false) && (() => {
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

  const cellEditor = (placeId: string, d: RosterDayKind) => {
    const place = places.find(p => p.id === placeId);
    const v = shownCell(placeId, d);
    const k = cellKey(placeId, d);
    const kinds = place?.kind === 'head' ? [{ key: 'role', label: '見出しの役割' }]
      : place?.kind === 'daynote' ? [{ key: 'daynote', label: '曜日の書き添え' }]
      : data.rowKinds.filter(r => r.active).map(r => ({ key: r.key, label: r.label }));
    return (
      <div style={{ padding: '10px 12px', borderRadius: 10, border: '2px solid #1976d2', background: cardBg, textAlign: 'left', fontSize: 13, color: text, marginTop: 10 }}>
        <b>{place?.label}（{ROSTER_DAY_LABEL[d]}）</b>
        <div style={{ marginTop: 8 }}>
          {v.length === 0 && <div style={{ color: subText, marginBottom: 6 }}>まだ何も入っていません</div>}
          {v.map((it, i) => itemEditor(placeId, d, it, i, v))}
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginTop: 4 }}>
            {kinds.map(kd => (
              <button key={kd.key} type="button" onClick={() => setCell(placeId, d, [...v, emptyItem(kd.key)])}
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

  const cellLinesOf = (placeId: string, d: RosterDayKind): string[] =>
    shownCell(placeId, d).flatMap(it => {
      const s = shortfallOf(it, data.settings, canLesson, inactive);
      return itemTextWithBlanks(it, nameOf, s, roleLabel).split('\n');
    });

  const cols = columnsOfDay(day);
  const headBySchool = (school: string) => heads.find(h => h.school === school) ?? null;

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
          <button type="button" style={linkBtn} onClick={() => setShowArchived(v => !v)}>しまった案 ▼（{archivedPlans.length}）</button>
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
          <div style={{ color: subText, marginTop: 4 }}>🚨 しまった案は、決定から2年で自動的に消えます。</div>
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
          <button type="button" style={{ ...linkBtn, marginLeft: 8 }} onClick={() => void archivePlan(plan)}>この案をしまう</button>
        </div>
      )}

      {/* 日付と曜日 */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
        {!plan && (
          <>
            <span style={{ fontSize: 13, color: text }}>適用開始日</span>
            <input type="date" value={applyFrom} style={inputStyle}
              onChange={e => e.target.value && guarded('別の日付', () => setApplyFrom(e.target.value))} />
            <span style={{ fontSize: 12, color: subText }}>赤字＝{md(prevDate(applyFrom))} と違うマス</span>
          </>
        )}
        {plan && <span style={{ fontSize: 12, color: subText }}>赤字＝決定済みの表（{md(plan.apply_from)} 時点）と違うマス</span>}
      </div>

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
          return (
            <button key={school} type="button" onClick={() => setOpenKey(o => (o === cellKey(h.id, day) ? null : cellKey(h.id, day)))}
              style={{ ...inputStyle, cursor: 'pointer', textAlign: 'left', color: isRed ? red : text, fontWeight: isRed ? 'bold' : 'normal' }}>
              <b>{school}</b>{lines.length > 0 ? `\u3000${lines.join('\u3000')}` : '\u3000（見出しの役割を入れる）'}
            </button>
          );
        })}
      </div>

      {/* 表 */}
      <div style={{ overflowX: 'auto', border: `1px solid ${borderColor}`, borderRadius: 8 }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: Math.max(600, cols.length * 150) }}>
          <thead>
            <tr style={{ background: innerBg }}>
              {cols.map(c => (
                <th key={c.id} style={{ padding: '6px 4px', borderBottom: `1px solid ${borderColor}`, borderLeft: `1px solid ${borderColor}`, fontSize: 12.5, color: text }}>
                  {c.label}
                </th>
              ))}
              {cols.length === 0 && <th style={{ padding: 10, color: subText, fontSize: 13 }}>この曜日には、まだ何も入っていません</th>}
            </tr>
          </thead>
          <tbody>
            <tr>
              {cols.map(c => {
                const k = cellKey(c.id, day);
                const lines = cellLinesOf(c.id, day);
                const isRed = !cellEquals(shownCell(c.id, day), baseCell(c.id, day));
                const dirty = changedKeys.includes(k);
                // 🚨 確認済みは数えない（押すと薄くなり数から外れる・設計書 5-9）
                const warn = issuesOf(c.id, day).filter(i => !isAcked(c.id, day, i.key)).length;
                const diff = isDiff(c.id, day);   // 比べているときだけ true
                return (
                  <td key={c.id} onClick={() => setOpenKey(o => (o === k ? null : k))}
                    style={{
                      padding: '5px 4px', borderLeft: `1px solid ${borderColor}`, verticalAlign: 'top', cursor: 'pointer',
                      fontSize: 12, color: isRed ? red : text, fontWeight: isRed ? 'bold' : 'normal',
                      outline: dirty ? '2px solid #e65100' : openKey === k ? '2px solid #1976d2' : 'none', outlineOffset: -2,
                    }}>
                    {lines.length === 0
                      ? <span style={{ color: subText }}>{diff ? '≠ ' : ''}—</span>
                      : lines.map((l, i) => <div key={i}>{i === 0 ? `${diff ? '≠' : ''}${warn > 0 ? '⚠️' : ''}` : ''}{l}</div>)}
                  </td>
                );
              })}
            </tr>
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

      {/* 追加必要・重なり */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 12 }}>
        <div style={{ flex: 1, minWidth: 260, padding: '8px 12px', borderRadius: 8, border: `1px solid ${borderColor}`, background: cardBg }}>
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
        </div>
        <div style={{ flex: 1, minWidth: 260, padding: '8px 12px', borderRadius: 8, border: `1px solid ${borderColor}`, background: cardBg }}>
          <b style={{ fontSize: 13, color: text }}>重なり {overlaps.length} 件</b>
          <div style={{ fontSize: 12, color: subText, marginTop: 2 }}>同じ人が同じ時間に2か所へ入っています。</div>
          {overlaps.slice(0, 12).map((o, i) => (
            <div key={i} style={{ fontSize: 12.5, color: text, marginTop: 3 }}>
              {ROSTER_DAY_LABEL[o.day]} {nameOf(o.userId)} {o.start}〜{o.end}（{placeLabel(o.a)}・{placeLabel(o.b)}）
            </div>
          ))}
          {overlaps.length > 12 && <div style={{ fontSize: 12, color: subText, marginTop: 3 }}>ほか {overlaps.length - 12} 件</div>}
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
            (activeColumns.concat((data?.places ?? []).filter(x => x.kind === 'head' && x.active)))
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
          <button type="button" style={{ ...inputStyle, cursor: 'pointer' }} onClick={() => setPanel(p => (p === 'people' ? 'none' : 'people'))}>レッスンできる人</button>
          <button type="button" style={{ ...inputStyle, cursor: 'pointer' }} onClick={() => setPanel(p => (p === 'settings' ? 'none' : 'settings'))}>設定</button>
        </span>
      </div>

      {saveErr && !stale && <div style={{ color: red, marginTop: 8, fontSize: 13 }}>{saveErr}</div>}
      {saveMsg && <div style={{ ...okCard, marginTop: 8 }}>✓ {saveMsg}</div>}

      {/* 保存の確認（決定済みの表） */}
      {confirming && !plan && (
        <div style={{ ...warnCard, marginTop: 10 }}>
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
        <div style={{ ...warnCard, marginTop: 10 }}>
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
      {panel === 'pdf' && (
        <div style={{ marginTop: 10, padding: '10px 12px', borderRadius: 8, border: `1px solid ${borderColor}`, background: cardBg, fontSize: 13, color: text }}>
          <b>PDF（全校・A4横1枚）</b>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginTop: 6 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <input type="checkbox" checked={pdfRed} onChange={e => setPdfRed(e.target.checked)} />変わった所を赤字にする
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <input type="checkbox" checked={pdfBlank} onChange={e => setPdfBlank(e.target.checked)} />{'追加必要を「（　）」で刷る'}
            </label>
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
              <span style={{ width: 90, color: subText, fontSize: 12 }}>{p.kind === 'column' ? '列' : p.kind === 'head' ? '校の見出し' : '曜日の書き添え'}</span>
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
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
            <span>作業中の案の上限</span>
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

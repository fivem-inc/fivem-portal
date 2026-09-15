import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { todayJstStr } from '../../lib/breakCalc';
import { isShiftTarget } from '../../lib/shiftExcelImport';
import { ROSTER_DAY_LABEL, prevDate, type RosterDayKind } from '../../lib/shiftRoster';
import { loadRosterData, type RosterData, type RosterPatternRow } from '../../lib/shiftRosterApi';
import { fullName, shortNameMap } from '../../lib/staffName';
import { openRosterPrint } from '../../lib/shiftRosterPrint';
import {
  CLEANING_WEEK, cellEquals, cellError, cellIsEmpty, cellIssues, cellKey, cellLines, cellValue, cellVersionOn, dayOfFrom,
  offAndUnassigned, type CleaningCellValue, type CleaningRow,
} from '../../lib/cleaningRoster';
import {
  ackCleaningIssue, addCleaningNote, addCleaningRow, loadCleaningData, loadCleaningToken, saveCleaning, saveDisplayName,
  setCleaningExcluded, updateCleaningNote, updateCleaningRow, type CleaningData,
} from '../../lib/cleaningRosterApi';
import { buildCleaningPrintHtml } from '../../lib/cleaningRosterPrint';

// ④ 掃除担当表（2026-09-15）。設計・決めたことは docs/計画-管理画面の開放.md の 5-8〜5-8-2。
// ・表は行（校・階・仕事）×月〜日。マスを押すと、その場で人・時刻・書き添え・この日は無し を入れる
// ・保存は cleaning_save 1回：変えたマスだけ「適用開始日」から切り替え／先の版は残す／今日より前は確認つき／stale で断る
// ・赤字は「適用開始日の前日に効いているマス」と比べて変わったマス。⚠️ は週のシフトから計算（保存は止めない）
// ・表の下の「休み」「担当なし」は週のシフトから自動（掃除の対象外の人は出さない）
// 🚨 判定・名前の決め方は lib（cleaningRoster.ts・staffName.ts）の1か所。勤務表の欄も同じものを使う

const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
const rowTitle = (r: Pick<CleaningRow, 'school' | 'floor' | 'task'>) => `${r.school}${r.floor ? ` ${r.floor}` : ''} ${r.task}`;

const CleaningRosterPanel: React.FC<{ isDarkMode: boolean; rosterDraftCount: number }> = ({ isDarkMode, rosterDraftCount }) => {
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

  const today = todayJstStr();
  const [applyFrom, setApplyFrom] = useState(today);
  const [roster, setRoster] = useState<RosterData | null>(null);
  const [data, setData] = useState<CleaningData | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState('');
  const [drafts, setDrafts] = useState<Record<string, CleaningCellValue>>({});
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState('');
  const [saveMsg, setSaveMsg] = useState('');
  const [stale, setStale] = useState(false);
  const [panel, setPanel] = useState<'none' | 'rows' | 'people' | 'pdf'>('none');
  const [panelErr, setPanelErr] = useState('');
  const [pdfSchool, setPdfSchool] = useState('');
  const [pdfRed, setPdfRed] = useState(true);
  const [pdfWarn, setPdfWarn] = useState(false);
  const [labelEdit, setLabelEdit] = useState<Record<string, string>>({});
  const [labelConfirm, setLabelConfirm] = useState<{ userId: string; label: string; changes: string[] } | null>(null);
  const [newRow, setNewRow] = useState({ school: '', floor: '', task: '', short_name: '', minutes: 15 });
  const [newNote, setNewNote] = useState('');

  // 読み込み：適用開始日の前日（赤字の比べ先）に効いている版と、それより先の版
  const load = useCallback(async (keepDrafts: boolean) => {
    setLoading(true); setLoadErr('');
    const since = prevDate(applyFrom);
    const [r, c, t] = await Promise.all([loadRosterData(since), loadCleaningData(since), loadCleaningToken()]);
    if (r.error || !r.data) { setLoadErr(r.error ?? '週のシフトを読み込めませんでした'); setLoading(false); return; }
    if (c.error || !c.data) { setLoadErr(c.error ?? '掃除担当表を読み込めませんでした'); setLoading(false); return; }
    if (t.error || t.token == null) { setLoadErr(`保存の準備ができませんでした：${t.error ?? ''}`); setLoading(false); return; }
    setRoster(r.data); setData(c.data); setToken(t.token); setStale(false);
    if (!keepDrafts) setDrafts({});
    setLoading(false);
  }, [applyFrom]);

  useEffect(() => { void load(true); }, [load]);

  const rowsByUser = useMemo(() => {
    const m = new Map<string, RosterPatternRow[]>();
    for (const r of roster?.patterns ?? []) m.set(r.user_id, [...(m.get(r.user_id) ?? []), r]);
    return m;
  }, [roster]);
  const names = useMemo(() => shortNameMap(data?.staff ?? [], data?.labels ?? new Map()), [data]);
  const fullNames = useMemo(() => new Map((data?.staff ?? []).map(s => [s.id, fullName(s.name)])), [data]);
  const activeRows = useMemo(() => [...(data?.rows ?? [])].filter(r => r.active).sort((a, b) => a.sort_order - b.sort_order), [data]);
  const allRows = useMemo(() => [...(data?.rows ?? [])].sort((a, b) => a.sort_order - b.sort_order), [data]);
  const activeStaff = useMemo(() => [...(data?.staff ?? [])].filter(s => s.is_active).sort((a, b) => a.name.localeCompare(b.name, 'ja')), [data]);

  if (loading && !data) return <p style={{ color: subText }}>読み込んでいます...</p>;
  if (loadErr && !data) return <p style={{ color: red }}>{loadErr}</p>;
  if (!data || !roster) return null;

  const cells = data.cells;
  const savedAt = (rowId: string, day: RosterDayKind, date: string) => cellValue(cellVersionOn(cells, rowId, day, date));
  const shown = (rowId: string, day: RosterDayKind) => drafts[cellKey(rowId, day)] ?? savedAt(rowId, day, applyFrom);
  const base = (rowId: string, day: RosterDayKind) => savedAt(rowId, day, prevDate(applyFrom));
  const splitKey = (k: string) => { const [rowId, day] = k.split('|'); return { rowId, day: day as RosterDayKind }; };
  const changedKeys = Object.keys(drafts).filter(k => { const { rowId, day } = splitKey(k); return !cellEquals(drafts[k], savedAt(rowId, day, applyFrom)); });
  const rowById = (id: string) => data.rows.find(r => r.id === id);

  const issuesOf = (row: CleaningRow, day: RosterDayKind, v = shown(row.id, day)) =>
    cellIssues(row, v, dayOfFrom(rowsByUser, day, applyFrom), fullNames);
  const isAcked = (row: CleaningRow, day: RosterDayKind, key: string) => {
    if (changedKeys.includes(cellKey(row.id, day))) return false;
    const v = cellVersionOn(cells, row.id, day, applyFrom);
    return !!v && data.acks.some(a => a.cell_id === v.id && a.issue_key === key);
  };
  const allIssues = activeRows.flatMap(r => CLEANING_WEEK.flatMap(d => issuesOf(r, d).map(i => ({ r, d, i, acked: isAcked(r, d, i.key) }))));
  const unacked = allIssues.filter(x => !x.acked);

  const footerOf = (day: RosterDayKind) => {
    const assigned = new Set(activeRows.flatMap(r => shown(r.id, day).entries.map(e => e.user_id)));
    return offAndUnassigned(roster.staff.map(s => s.id), data.excluded, rowsByUser, day, applyFrom, assigned,
      id => isShiftTarget(roster.staff.find(s => s.id === id)?.employment_type ?? null, false));
  };

  // ─── 入力 ───
  const setCell = (rowId: string, day: RosterDayKind, v: CleaningCellValue) => {
    setSaveMsg(''); setSaveErr('');
    setDrafts(prev => ({ ...prev, [cellKey(rowId, day)]: v }));
  };
  const revertCell = (key: string) => setDrafts(prev => { const n = { ...prev }; delete n[key]; return n; });

  // ─── 保存 ───
  const isPast = applyFrom < today;
  const errors = changedKeys.map(k => {
    const { rowId, day } = splitKey(k);
    const e = cellError(drafts[k]);
    const r = rowById(rowId);
    return e && r ? `${rowTitle(r)}（${ROSTER_DAY_LABEL[day]}）：${e}` : null;
  }).filter((x): x is string => !!x);
  const keptFuture = changedKeys.map(k => {
    const { rowId, day } = splitKey(k);
    const next = cells.filter(c => c.row_id === rowId && c.day_kind === day && c.valid_from > applyFrom).map(c => c.valid_from).sort()[0];
    const r = rowById(rowId);
    return next && r ? `${rowTitle(r)}（${ROSTER_DAY_LABEL[day]}）は ${md(next)} からの変更があるので、${md(prevDate(next))} まで` : null;
  }).filter((x): x is string => !!x);
  const newWarnings = changedKeys.flatMap(k => {
    const { rowId, day } = splitKey(k);
    const r = rowById(rowId);
    if (!r) return [];
    const before = new Set(issuesOf(r, day, savedAt(rowId, day, applyFrom)).map(i => i.key));
    return issuesOf(r, day, drafts[k]).filter(i => !before.has(i.key)).map(i => `${rowTitle(r)}（${ROSTER_DAY_LABEL[day]}）：${i.text}`);
  });
  const emptyCount = changedKeys.filter(k => cellIsEmpty(drafts[k])).length;

  const doSave = async () => {
    if (token == null) return;
    setSaving(true); setSaveErr(''); setSaveMsg('');
    const { result, error } = await saveCleaning({
      apply_from: applyFrom, confirm_past: isPast, base_token: token,
      cells: changedKeys.map(k => ({ ...splitKey(k), row_id: splitKey(k).rowId, day_kind: splitKey(k).day, ...drafts[k] })),
    });
    setSaving(false);
    if (error || !result) { setSaveErr(`保存できませんでした：${error ?? ''}`); return; }
    if (!result.ok && result.reason === 'stale') {
      setStale(true); setConfirming(false);
      setSaveErr('開いたあとに、別の人が掃除担当表を保存しました。上書きしないよう保存を止めました。「読み込み直す」を押すと、直した内容は残したまま最新の状態と比べ直せます。');
      return;
    }
    if (!result.ok) { setSaveErr('保存できませんでした（今日より前の日付の確認が必要です）'); return; }
    setConfirming(false); setOpenKey(null);
    setSaveMsg(`保存しました（${applyFrom} から・変えたマス ${result.changed}${result.unchanged ? `・同じ内容 ${result.unchanged}` : ''}${result.kept_future.length > 0 ? `・先の変更を残したマス ${result.kept_future.length}` : ''}）`);
    await load(false);
  };

  const ack = async (row: CleaningRow, day: RosterDayKind, key: string) => {
    const v = cellVersionOn(cells, row.id, day, applyFrom);
    if (!v) return;
    setSaveErr('');
    const e = await ackCleaningIssue(v.id, key);
    if (e) { setSaveErr(e); return; }
    await load(true);
  };

  // ─── 行・注意書き ───
  const runPanel = async (p: Promise<string | null>) => {
    setPanelErr('');
    const e = await p;
    if (e) { setPanelErr(e); return false; }
    await load(true);
    return true;
  };
  const moveRow = async (row: CleaningRow, dir: -1 | 1) => {
    const idx = allRows.findIndex(r => r.id === row.id);
    const other = allRows[idx + dir];
    if (!other) return;
    setPanelErr('');
    const e1 = await updateCleaningRow(row.id, { sort_order: other.sort_order });
    const e2 = e1 ? null : await updateCleaningRow(other.id, { sort_order: row.sort_order });
    if (e1 || e2) setPanelErr(`並べ替えられませんでした。読み込み直しました：${e1 ?? e2}`);
    await load(true);
  };
  const addRow = async () => {
    if (!newRow.school || !newRow.task.trim() || !newRow.short_name.trim()) { setPanelErr('校・仕事・短い名前を入れてください'); return; }
    const ok = await runPanel(addCleaningRow({
      school: newRow.school, floor: newRow.floor.trim() || null, task: newRow.task.trim(), short_name: newRow.short_name.trim(),
      vacuum_mark: false, note_below: null, minutes: newRow.minutes, sort_order: (allRows.at(-1)?.sort_order ?? 0) + 10, active: true,
    }));
    if (ok) setNewRow({ school: '', floor: '', task: '', short_name: '', minutes: 15 });
  };

  // ─── 呼び名 ───
  const askLabel = (userId: string) => {
    const label = (labelEdit[userId] ?? '').trim();
    const next = new Map(data.labels);
    if (label) next.set(userId, label); else next.delete(userId);
    const after = shortNameMap(data.staff, next);
    const changes = activeStaff.filter(s => names.get(s.id) !== after.get(s.id)).map(s => `${fullName(s.name)}：${names.get(s.id)} → ${after.get(s.id)}`);
    setLabelConfirm({ userId, label, changes });
  };
  const doLabel = async () => {
    if (!labelConfirm) return;
    const ok = await runPanel(saveDisplayName(labelConfirm.userId, labelConfirm.label));
    if (ok) {
      setLabelEdit(prev => { const n = { ...prev }; delete n[labelConfirm.userId]; return n; });
      setLabelConfirm(null);
    }
  };

  // ─── PDF ───
  const schools = [...new Set(activeRows.map(r => r.school))];
  const printPdf = () => {
    const rows = activeRows.filter(r => !pdfSchool || r.school === pdfSchool);
    const changed = new Set<string>();
    const warn = new Set<string>();
    for (const r of rows) for (const d of CLEANING_WEEK) {
      if (!cellEquals(shown(r.id, d), base(r.id, d))) changed.add(cellKey(r.id, d));
      if (issuesOf(r, d).some(i => !isAcked(r, d, i.key))) warn.add(cellKey(r.id, d));
    }
    const off: Partial<Record<RosterDayKind, string[]>> = {};
    const unassigned: Partial<Record<RosterDayKind, string[]>> = {};
    for (const d of CLEANING_WEEK) { const f = footerOf(d); off[d] = f.off; unassigned[d] = f.unassigned; }
    const html = buildCleaningPrintHtml({
      applyFrom, rows, valueOf: shown, names, changed, redChanges: pdfRed, warn, showWarn: pdfWarn,
      school: pdfSchool || null, off: pdfSchool ? undefined : off, unassigned: pdfSchool ? undefined : unassigned,
      title: data.notes.find(n => n.kind === 'title' && n.active)?.body ?? '毎日の掃除担当表',
      notes: data.notes.filter(n => n.kind === 'note' && n.active).map(n => n.body),
    });
    setPanelErr(openRosterPrint(html) ?? '');
  };

  // ─── 表示の部品 ───
  const cellEditor = (row: CleaningRow, day: RosterDayKind) => {
    const k = cellKey(row.id, day);
    const v = shown(row.id, day);
    const err = cellError(v);
    const issues = issuesOf(row, day);
    const setV = (next: Partial<CleaningCellValue>) => setCell(row.id, day, { ...v, ...next });
    const schoolRows = activeRows.filter(r => r.school === row.school);
    return (
      <div style={{ padding: '10px 12px', borderRadius: 10, border: '2px solid #1976d2', background: cardBg, textAlign: 'left', fontSize: 13, color: text }}>
        <b>{rowTitle(row)}（{ROSTER_DAY_LABEL[day]}）</b>
        <span style={{ fontSize: 12, color: subText, marginLeft: 8 }}>掃除の長さ {row.minutes}分（⚠️ の判定に使います）</span>
        <div style={{ marginTop: 8 }}>
          {v.is_none && <div style={{ color: subText, marginBottom: 4 }}>この日は無し（斜線）</div>}
          {!v.is_none && v.entries.length === 0 && <div style={{ color: subText, marginBottom: 4 }}>まだ誰も入っていません</div>}
          {v.entries.map((e, i) => (
            <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: 4 }}>
              <select value={e.user_id} style={inputStyle}
                onChange={ev => setV({ entries: v.entries.map((x, j) => j === i ? { ...x, user_id: ev.target.value } : x) })}>
                <option value="">人を選ぶ</option>
                {!activeStaff.some(s => s.id === e.user_id) && e.user_id && <option value={e.user_id}>{fullNames.get(e.user_id) ?? '（削除された人）'}</option>}
                {activeStaff.map(s => {
                  const sn = names.get(s.id);
                  return <option key={s.id} value={s.id}>{fullName(s.name)}{sn && sn !== fullName(s.name) ? `（${sn}）` : ''}</option>;
                })}
              </select>
              <input type="time" step={300} value={e.start} style={inputStyle}
                onChange={ev => setV({ entries: v.entries.map((x, j) => j === i ? { ...x, start: ev.target.value } : x) })} />
              {!e.start && <span style={{ fontSize: 11.5, color: subText }}>時刻なし（⚠️ の判定はしません）</span>}
              <button type="button" aria-label="この人を外す" onClick={() => setV({ entries: v.entries.filter((_, j) => j !== i) })}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: subText, fontSize: 14 }}>✕</button>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 4 }}>
            <button type="button" disabled={v.is_none || v.entries.length >= 6}
              onClick={() => setV({ entries: [...v.entries, { user_id: '', start: v.entries.at(-1)?.start ?? '' }] })}
              style={{ background: 'none', border: `1px dashed ${borderColor}`, borderRadius: 6, cursor: 'pointer', padding: '3px 8px', fontSize: 12, color: '#0d6efd', opacity: v.is_none ? 0.5 : 1 }}>
              ＋ 人を足す
            </button>
            <input type="text" value={v.note} maxLength={100} placeholder="書き添え（例：(会)・授業前・エアコン）" style={{ ...inputStyle, flex: 1, minWidth: 200 }}
              onChange={ev => setV({ note: ev.target.value })} />
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <input type="checkbox" checked={v.is_none} onChange={ev => setV(ev.target.checked ? { is_none: true, entries: [] } : { is_none: false })} />
              この日は無し（斜線）
            </label>
            {schoolRows.length > 1 && (
              <button type="button" style={linkBtn}
                onClick={() => { for (const r of schoolRows) setCell(r.id, day, { is_none: true, note: '', entries: [] }); }}>
                {row.school}の{ROSTER_DAY_LABEL[day]}曜を全部「無し」にする
              </button>
            )}
            {drafts[k] && <button type="button" style={linkBtn} onClick={() => revertCell(k)}>↩ 直す前に戻す</button>}
          </div>
          {err && <div style={{ color: red, marginTop: 6 }}>⚠️ {err}</div>}
          {issues.map(i => {
            const acked = isAcked(row, day, i.key);
            return (
              <div key={i.key} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5, color: acked ? subText : red, marginTop: 4 }}>
                <span>{acked ? '✓' : '⚠️'} {i.text}{acked ? '（確認済み）' : '（保存はできます）'}</span>
                {!acked && !changedKeys.includes(k) && cellVersionOn(cells, row.id, day, applyFrom) && (
                  <button type="button" onClick={() => void ack(row, day, i.key)} style={{ ...inputStyle, cursor: 'pointer', fontSize: 12, padding: '2px 8px' }}>確認した</button>
                )}
              </div>
            );
          })}
          <div style={{ marginTop: 8 }}>
            <button type="button" onClick={() => setOpenKey(null)} style={{ ...inputStyle, cursor: 'pointer' }}>閉じる</button>
          </div>
        </div>
      </div>
    );
  };

  const cellView = (row: CleaningRow, day: RosterDayKind) => {
    const k = cellKey(row.id, day);
    const v = shown(row.id, day);
    const isRed = !cellEquals(v, base(row.id, day));
    const dirty = changedKeys.includes(k);
    const warnCount = issuesOf(row, day).filter(i => !isAcked(row, day, i.key)).length;
    const lines = cellLines(v, names);
    return (
      <td key={day} onClick={() => setOpenKey(o => (o === k ? null : k))}
        style={{
          padding: '4px 3px', borderBottom: `1px solid ${borderColor}`, borderLeft: `1px solid ${borderColor}`, textAlign: 'center', verticalAlign: 'middle',
          cursor: 'pointer', whiteSpace: 'nowrap', color: isRed ? red : text, fontWeight: isRed ? 'bold' : 'normal',
          outline: dirty ? '2px solid #e65100' : openKey === k ? '2px solid #1976d2' : 'none', outlineOffset: -2,
          background: v.is_none ? innerBg : 'transparent',
        }}>
        {v.is_none ? <span style={{ color: subText }}>／</span>
          : lines.length === 0 ? <span style={{ color: subText }}>—</span>
          : lines.map((l, i) => <div key={i}>{i === 0 && warnCount > 0 ? '⚠️' : ''}{l}</div>)}
      </td>
    );
  };

  const hiddenCount = allRows.length - activeRows.length;

  return (
    <div>
      <p style={{ margin: '0 0 10px', fontSize: 12.5, color: subText, lineHeight: 1.7 }}>
        マスを押すと、人・時刻・書き添えを入れられます。赤字は、適用開始日の前日に効いている表から変わったマスです。<br />
        保存すると、変えたマスだけが適用開始日から切り替わります。先に登録してある変更は消えません。
      </p>
      {rosterDraftCount > 0 && (
        <div style={{ padding: '8px 12px', borderRadius: 8, background: '#fff3cd', border: '1px solid #ffc107', color: '#856404', fontSize: 13, marginBottom: 10 }}>
          勤務表に未保存の変更が{rosterDraftCount}人あります（変更は残っています）。掃除担当表の ⚠️ と「休み」「担当なし」は、保存済みのシフトで判定します。
        </div>
      )}

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
        <label style={{ fontSize: 12.5, color: subText, display: 'flex', alignItems: 'center', gap: 6 }}>
          適用開始日
          <input type="date" value={applyFrom} onChange={e => { if (e.target.value) { setApplyFrom(e.target.value); setConfirming(false); } }} style={inputStyle} />
        </label>
        {isPast && <span style={{ fontSize: 12, color: '#856404' }}>今日より前の日付です</span>}
        <span style={{ fontSize: 13, color: unacked.length > 0 ? red : subText, fontWeight: unacked.length > 0 ? 'bold' : 'normal' }}>
          ⚠️ {unacked.length}件{allIssues.length - unacked.length > 0 ? `（確認済み ${allIssues.length - unacked.length}）` : ''}
        </span>
      </div>

      {/* 保存・PDF の帯 */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', padding: '8px 10px', borderRadius: 10, background: innerBg, marginBottom: 10 }}>
        <span style={{ fontSize: 13, color: changedKeys.length > 0 ? '#e65100' : subText, fontWeight: changedKeys.length > 0 ? 'bold' : 'normal' }}>
          未保存の変更 {changedKeys.length}マス
        </span>
        <button type="button" disabled={changedKeys.length === 0 || saving || stale} onClick={() => { setSaveErr(''); setConfirming(true); }}
          style={{ ...primaryBtn, cursor: changedKeys.length === 0 ? 'default' : 'pointer', opacity: changedKeys.length === 0 || stale ? 0.5 : 1 }}>
          保存
        </button>
        {changedKeys.length > 0 && <button type="button" style={linkBtn} onClick={() => { setDrafts({}); setConfirming(false); }}>直した内容をすべて取り消す</button>}
        <button type="button" onClick={() => setPanel(p => p === 'pdf' ? 'none' : 'pdf')} style={{ ...inputStyle, cursor: 'pointer', marginLeft: 'auto' }}>PDF</button>
        <button type="button" onClick={() => setPanel(p => p === 'rows' ? 'none' : 'rows')} style={{ ...inputStyle, cursor: 'pointer' }}>行・注意書きの一覧</button>
        <button type="button" onClick={() => setPanel(p => p === 'people' ? 'none' : 'people')} style={{ ...inputStyle, cursor: 'pointer' }}>呼び名・対象外</button>
      </div>

      {stale && (
        <div style={{ padding: '10px 12px', borderRadius: 10, background: '#fff3cd', border: '1px solid #ffc107', color: '#856404', fontSize: 13, marginBottom: 10 }}>
          {saveErr}
          <div style={{ marginTop: 8 }}><button type="button" onClick={() => { setSaveErr(''); void load(true); }} style={primaryBtn}>読み込み直す</button></div>
        </div>
      )}
      {!stale && saveErr && <div style={{ padding: '8px 12px', borderRadius: 8, background: '#f8d7da', border: '1px solid #f5c2c7', color: '#842029', fontSize: 13, marginBottom: 10 }}>{saveErr}</div>}
      {saveMsg && <div style={{ padding: '8px 12px', borderRadius: 8, background: '#d1e7dd', border: '1px solid #28a745', color: '#0f5132', fontSize: 13, marginBottom: 10 }}>✓ {saveMsg}</div>}

      {confirming && (
        <div style={{ padding: '12px 14px', borderRadius: 10, border: `2px solid ${isPast ? '#ffc107' : '#1976d2'}`, background: cardBg, marginBottom: 10, fontSize: 13, color: text, lineHeight: 1.7 }}>
          <b>{applyFrom} から適用します</b>
          {isPast && <div style={{ padding: '6px 10px', borderRadius: 8, background: '#fff3cd', color: '#856404', margin: '6px 0' }}>⚠️ 今日より前の日付です。</div>}
          <div>・変えたマス {changedKeys.length}（{changedKeys.map(k => { const { rowId, day } = splitKey(k); const r = rowById(rowId); return r ? `${r.school.replace('四条本校', '本校')}${r.floor ?? ''} ${r.short_name}（${ROSTER_DAY_LABEL[day]}）` : ''; }).join('・')}）</div>
          {emptyCount > 0 && <div>・空に戻すマス {emptyCount}（誰も入っていないマスになります）</div>}
          {keptFuture.map(t => <div key={t}>・{t}</div>)}
          {newWarnings.length > 0 && (
            <div style={{ padding: '6px 10px', borderRadius: 8, background: '#fff3cd', color: '#856404', margin: '6px 0' }}>
              ⚠️ 勤務時間と合わないマスが{newWarnings.length}件あります（保存はできます）
              {newWarnings.map(t => <div key={t}>・{t}</div>)}
            </div>
          )}
          {errors.length > 0 && (
            <div style={{ color: red, marginTop: 6 }}>入力を確かめてください（保存できません）{errors.map(e => <div key={e}>・{e}</div>)}</div>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button type="button" disabled={saving || errors.length > 0} onClick={() => void doSave()}
              style={{ ...primaryBtn, cursor: errors.length > 0 ? 'default' : 'pointer', opacity: errors.length > 0 ? 0.5 : 1 }}>
              {saving ? '保存中…' : isPast ? 'さかのぼって保存する' : '保存する'}
            </button>
            <button type="button" disabled={saving} onClick={() => setConfirming(false)} style={{ ...inputStyle, cursor: 'pointer' }}>やめる</button>
          </div>
        </div>
      )}

      {panelErr && <div style={{ padding: '8px 12px', borderRadius: 8, background: '#f8d7da', border: '1px solid #f5c2c7', color: '#842029', fontSize: 13, marginBottom: 10 }}>{panelErr}</div>}

      {panel === 'pdf' && (
        <div style={{ padding: '10px 12px', borderRadius: 10, border: `1px solid ${borderColor}`, background: cardBg, marginBottom: 10, fontSize: 13, color: text }}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}>
            <span style={{ color: subText }}>出す表</span>
            <button type="button" onClick={() => setPdfSchool('')} style={toggle(!pdfSchool)}>全校（紙と同じ A4横）</button>
            <select value={pdfSchool} onChange={e => setPdfSchool(e.target.value)} style={inputStyle}>
              <option value="">校を選ぶ</option>
              {schools.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}><input type="checkbox" checked={pdfRed} onChange={e => setPdfRed(e.target.checked)} />変わった所を赤字にする</label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}><input type="checkbox" checked={pdfWarn} onChange={e => setPdfWarn(e.target.checked)} />⚠️印も刷る</label>
          </div>
          <div style={{ fontSize: 12, color: subText, marginBottom: 6 }}>
            {pdfSchool ? '校ごとの表には「休み」「担当なし」は出ません。' : ''}{changedKeys.length > 0 ? '未保存の変更も含めて出します。' : ''}印刷の画面で「PDFに保存」を選んでください。
          </div>
          <button type="button" onClick={printPdf} style={primaryBtn}>印刷の画面を開く</button>
        </div>
      )}

      {panel === 'rows' && (
        <div style={{ padding: '10px 12px', borderRadius: 10, border: `1px solid ${borderColor}`, background: cardBg, marginBottom: 10, fontSize: 13, color: text }}>
          <div style={{ fontSize: 12, color: subText, marginBottom: 6, lineHeight: 1.6 }}>
            名前・短い名前（勤務表の欄に出します）・＊印・長さ・行の下の注意書きは、入力欄から離れると保存します。直すと全部の表で変わります。<br />
            使わなくなった行は消さずに「隠す」。🚨 マスが入っている行の校・階は変えられません（新しい行を足して、古い行を隠してください）。
          </div>
          <div style={{ fontWeight: 'bold', margin: '4px 0' }}>見出しと注意書き</div>
          {data.notes.map(n => (
            <div key={n.id} style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4, opacity: n.active ? 1 : 0.6 }}>
              <span style={{ width: 44, fontSize: 12, color: subText }}>{n.kind === 'title' ? '見出し' : '注意書き'}</span>
              <input defaultValue={n.body} maxLength={300} style={{ ...inputStyle, flex: 1 }}
                onBlur={e => { const b = e.target.value.trim(); if (b && b !== n.body) void runPanel(updateCleaningNote(n.id, { body: b })); }} />
              {n.kind === 'note' && <button type="button" onClick={() => void runPanel(updateCleaningNote(n.id, { active: !n.active }))} style={{ ...inputStyle, cursor: 'pointer' }}>{n.active ? '隠す' : '戻す'}</button>}
            </div>
          ))}
          <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
            <input value={newNote} maxLength={300} placeholder="注意書きを足す" style={{ ...inputStyle, flex: 1 }} onChange={e => setNewNote(e.target.value)} />
            <button type="button" style={{ ...inputStyle, cursor: 'pointer' }}
              onClick={async () => { if (!newNote.trim()) return; if (await runPanel(addCleaningNote(newNote.trim(), (data.notes.at(-1)?.sort_order ?? 0) + 10))) setNewNote(''); }}>足す</button>
          </div>
          <div style={{ fontWeight: 'bold', margin: '4px 0' }}>行の一覧{hiddenCount > 0 ? `（隠している行 ${hiddenCount}）` : ''}</div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', fontSize: 12.5 }}>
              <thead><tr style={{ color: subText }}><th>校</th><th>階</th><th>仕事</th><th>短い名前</th><th>＊</th><th>長さ</th><th>行の下の注意書き</th><th /></tr></thead>
              <tbody>
                {allRows.map((r, i) => (
                  <tr key={r.id} style={{ opacity: r.active ? 1 : 0.55 }}>
                    <td style={{ padding: 2, whiteSpace: 'nowrap' }}>{r.school}</td>
                    <td style={{ padding: 2 }}><input defaultValue={r.floor ?? ''} maxLength={10} style={{ ...inputStyle, width: 44 }}
                      onBlur={e => { const f = e.target.value.trim() || null; if (f !== r.floor) void runPanel(updateCleaningRow(r.id, { floor: f })); }} /></td>
                    <td style={{ padding: 2 }}><input defaultValue={r.task} maxLength={100} style={{ ...inputStyle, width: 260 }}
                      onBlur={e => { const t = e.target.value.trim(); if (t && t !== r.task) void runPanel(updateCleaningRow(r.id, { task: t })); }} /></td>
                    <td style={{ padding: 2 }}><input defaultValue={r.short_name} maxLength={12} style={{ ...inputStyle, width: 100 }}
                      onBlur={e => { const t = e.target.value.trim(); if (t && t !== r.short_name) void runPanel(updateCleaningRow(r.id, { short_name: t })); }} /></td>
                    <td style={{ padding: 2, textAlign: 'center' }}><input type="checkbox" checked={r.vacuum_mark} onChange={e => void runPanel(updateCleaningRow(r.id, { vacuum_mark: e.target.checked }))} /></td>
                    <td style={{ padding: 2, whiteSpace: 'nowrap' }}><input type="number" min={5} max={120} defaultValue={r.minutes} style={{ ...inputStyle, width: 56 }}
                      onBlur={e => { const m = Number(e.target.value); if (m >= 5 && m <= 120 && m !== r.minutes) void runPanel(updateCleaningRow(r.id, { minutes: m })); }} />分</td>
                    <td style={{ padding: 2 }}><input defaultValue={r.note_below ?? ''} maxLength={200} style={{ ...inputStyle, width: 220 }}
                      onBlur={e => { const t = e.target.value.trim() || null; if (t !== r.note_below) void runPanel(updateCleaningRow(r.id, { note_below: t })); }} /></td>
                    <td style={{ padding: 2, whiteSpace: 'nowrap' }}>
                      <button type="button" aria-label="上へ" disabled={i === 0} onClick={() => void moveRow(r, -1)} style={{ ...inputStyle, cursor: 'pointer', padding: '2px 6px' }}>↑</button>
                      <button type="button" aria-label="下へ" disabled={i === allRows.length - 1} onClick={() => void moveRow(r, 1)} style={{ ...inputStyle, cursor: 'pointer', padding: '2px 6px', marginLeft: 2 }}>↓</button>
                      <button type="button" onClick={() => void runPanel(updateCleaningRow(r.id, { active: !r.active }))} style={{ ...inputStyle, cursor: 'pointer', marginLeft: 4 }}>{r.active ? '隠す' : '戻す'}</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
            <select value={newRow.school} style={inputStyle} onChange={e => setNewRow(v => ({ ...v, school: e.target.value }))}>
              <option value="">校を選ぶ</option>
              {roster.workplaces.map(w => <option key={w} value={w}>{w}</option>)}
            </select>
            <input value={newRow.floor} maxLength={10} placeholder="階（任意）" style={{ ...inputStyle, width: 80 }} onChange={e => setNewRow(v => ({ ...v, floor: e.target.value }))} />
            <input value={newRow.task} maxLength={100} placeholder="仕事" style={{ ...inputStyle, width: 200 }} onChange={e => setNewRow(v => ({ ...v, task: e.target.value }))} />
            <input value={newRow.short_name} maxLength={12} placeholder="短い名前" style={{ ...inputStyle, width: 100 }} onChange={e => setNewRow(v => ({ ...v, short_name: e.target.value }))} />
            <input type="number" min={5} max={120} value={newRow.minutes} style={{ ...inputStyle, width: 60 }} onChange={e => setNewRow(v => ({ ...v, minutes: Number(e.target.value) || 15 }))} />分
            <button type="button" onClick={() => void addRow()} style={{ ...inputStyle, cursor: 'pointer' }}>行を足す</button>
          </div>
        </div>
      )}

      {panel === 'people' && (
        <div style={{ padding: '10px 12px', borderRadius: 10, border: `1px solid ${borderColor}`, background: cardBg, marginBottom: 10, fontSize: 13, color: text }}>
          <div style={{ fontSize: 12, color: subText, marginBottom: 6, lineHeight: 1.6 }}>
            呼び名は掃除担当表と勉強会の欄に出ます。空にすると名字（同じ名字の人がいればフルネーム）で出ます。<br />
            「対象外」の人は表の下の「休み」「担当なし」に出ません（すぐに切り替わります）。
          </div>
          {labelConfirm && (
            <div style={{ padding: '8px 10px', borderRadius: 8, background: '#fff3cd', border: '1px solid #ffc107', color: '#856404', marginBottom: 8 }}>
              {fullNames.get(labelConfirm.userId)}さんの呼び名を「{labelConfirm.label || '（なし）'}」にします。
              {labelConfirm.changes.length > 0
                ? <>表に出る名前が変わる人：{labelConfirm.changes.map(c => <div key={c}>・{c}</div>)}</>
                : <div>表に出る名前が変わる人はいません。</div>}
              <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                <button type="button" onClick={() => void doLabel()} style={primaryBtn}>保存する</button>
                <button type="button" onClick={() => setLabelConfirm(null)} style={{ ...inputStyle, cursor: 'pointer' }}>やめる</button>
              </div>
            </div>
          )}
          <table style={{ borderCollapse: 'collapse', fontSize: 12.5 }}>
            <thead><tr style={{ color: subText }}><th style={{ textAlign: 'left' }}>名前</th><th>呼び名</th><th>表に出る名前</th><th>対象外</th></tr></thead>
            <tbody>
              {activeStaff.map(s => {
                const cur = data.labels.get(s.id) ?? '';
                const editing = labelEdit[s.id];
                return (
                  <tr key={s.id}>
                    <td style={{ padding: '2px 6px', whiteSpace: 'nowrap' }}>{fullName(s.name)}</td>
                    <td style={{ padding: 2, whiteSpace: 'nowrap' }}>
                      <input value={editing ?? cur} maxLength={10} style={{ ...inputStyle, width: 80 }} onChange={e => setLabelEdit(prev => ({ ...prev, [s.id]: e.target.value }))} />
                      {editing !== undefined && editing.trim() !== cur && (
                        <button type="button" onClick={() => askLabel(s.id)} style={{ ...inputStyle, cursor: 'pointer', marginLeft: 4 }}>保存</button>
                      )}
                    </td>
                    <td style={{ padding: '2px 6px', whiteSpace: 'nowrap', color: subText }}>{names.get(s.id)}</td>
                    <td style={{ padding: 2, textAlign: 'center' }}>
                      <input type="checkbox" checked={data.excluded.has(s.id)} aria-label={`${fullName(s.name)}さんを掃除の対象外にする`}
                        onChange={e => void runPanel(setCleaningExcluded(s.id, e.target.checked))} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {unacked.length > 0 && (
        <details style={{ marginBottom: 10, fontSize: 12.5, color: text }}>
          <summary style={{ cursor: 'pointer', color: red }}>⚠️ 勤務時間と合わないマスの一覧（{unacked.length}件）</summary>
          {unacked.map(x => (
            <div key={`${x.r.id}|${x.d}|${x.i.key}`} style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 3 }}>
              <button type="button" style={{ ...linkBtn, color: '#0d6efd' }} onClick={() => setOpenKey(cellKey(x.r.id, x.d))}>{rowTitle(x.r)}（{ROSTER_DAY_LABEL[x.d]}）</button>
              <span style={{ color: red }}>{x.i.text}</span>
            </div>
          ))}
        </details>
      )}

      <div style={{ overflowX: 'auto', maxHeight: '75vh', overflowY: 'auto', border: `1px solid ${borderColor}`, borderRadius: 8 }}>
        <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0, fontSize: 12, color: text, minWidth: 900 }}>
          <thead>
            <tr>
              <th style={{ position: 'sticky', top: 0, left: 0, zIndex: 3, background: cardBg, padding: 6, borderBottom: `1px solid ${borderColor}`, textAlign: 'left', minWidth: 220 }}>校・階・仕事</th>
              {CLEANING_WEEK.map(d => <th key={d} style={{ position: 'sticky', top: 0, zIndex: 2, background: cardBg, padding: 6, borderBottom: `1px solid ${borderColor}`, minWidth: 90 }}>{ROSTER_DAY_LABEL[d]}</th>)}
            </tr>
          </thead>
          <tbody>
            {activeRows.map((r, i) => {
              const newSchool = i === 0 || activeRows[i - 1].school !== r.school;
              const open = openKey && openKey.startsWith(`${r.id}|`) ? splitKey(openKey).day : null;
              return (
                <React.Fragment key={r.id}>
                  {newSchool && <tr><td colSpan={8} style={{ padding: 6, background: innerBg, fontWeight: 'bold', color: subText }}>{r.school}</td></tr>}
                  <tr>
                    <td style={{ position: 'sticky', left: 0, zIndex: 1, background: cardBg, padding: '4px 6px', borderBottom: `1px solid ${borderColor}`, whiteSpace: 'normal' }}>
                      {r.floor && <b style={{ marginRight: 4 }}>{r.floor}</b>}{r.task}{r.vacuum_mark && <span style={{ color: red, fontWeight: 'bold' }}>＊</span>}
                      {r.note_below && <div style={{ fontSize: 10.5, color: subText }}>{r.note_below}</div>}
                    </td>
                    {CLEANING_WEEK.map(d => cellView(r, d))}
                  </tr>
                  {open && <tr><td colSpan={8} style={{ padding: '6px 0 10px' }}>{cellEditor(r, open)}</td></tr>}
                </React.Fragment>
              );
            })}
            {(['off', 'unassigned'] as const).map(kind => (
              <tr key={kind}>
                <td style={{ position: 'sticky', left: 0, background: innerBg, padding: '4px 6px', fontWeight: 'bold', borderTop: `2px solid ${borderColor}` }}>{kind === 'off' ? '休み' : '担当なし'}</td>
                {CLEANING_WEEK.map(d => {
                  const f = footerOf(d);
                  return (
                    <td key={d} style={{ padding: '4px 3px', background: innerBg, fontSize: 11, color: subText, verticalAlign: 'top', borderTop: `2px solid ${borderColor}`, whiteSpace: 'normal' }}>
                      {f[kind].map(id => names.get(id)).join('・')}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {loading && <p style={{ color: subText, fontSize: 12 }}>読み込んでいます...</p>}
      <p style={{ margin: '8px 0 0', fontSize: 11.5, color: subText }}>
        ⚠️ と「休み」「担当なし」は保存済みの週のシフト（{md(applyFrom)} に効いている版）から計算しています。休憩の時刻は持っていないので、休憩と重なるかは分かりません。
      </p>
    </div>
  );
};

export default CleaningRosterPanel;

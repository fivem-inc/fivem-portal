import React, { useState, useRef } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  parseShiftSheet, listSheetNames, normalizeName, sheetNameToDate,
  IMPORT_DAYS, DEFAULT_LOCATION,
} from '../../lib/shiftExcelImport';
import type { ParsedSheet, ImportDayKind, ParsedDay } from '../../lib/shiftExcelImport';
import { calcPatternFields, DAY_KIND_LABELS, todayJstStr } from '../../lib/breakCalc';

// シフトExcel取り込み：ファイル選択→シート選択→名前照合＋差分表示→適用開始日つき一括登録
// 反映先は曜日パターン（月〜日のみ。祝・出パターンは触らない）

interface StaffRow { id: string; name: string; role_title: string; employment_type: string | null; }

interface PatternRow {
  id: string;
  user_id: string;
  day_kind: string;
  start_time: string | null;
  end_time: string | null;
  start_time2: string | null;
  end_time2: string | null;
  location: string | null;
  valid_from: string;
  valid_to: string | null;
}

interface DiffDay {
  kind: ImportDayKind;
  newStart: number | null;
  newEnd: number | null;
  newStart2: number | null;
  newEnd2: number | null;
  newLoc: string;
  oldStart: number | null;
  oldEnd: number | null;
  oldStart2: number | null;
  oldEnd2: number | null;
  oldLoc: string | null;
  changed: boolean;
}

// importable=正社員として取り込める / part_time=パート（対象外） / unregistered=名前が一致しない
type MatchStatus = 'importable' | 'part_time' | 'unregistered';

interface MatchedPerson {
  excelName: string;
  normalizedName: string;
  isDuplicate: boolean;
  staffId: string | null;    // null = アプリに該当スタッフなし
  staffName: string | null;
  status: MatchStatus;
  days: DiffDay[];
  hasChange: boolean;
  selected: boolean;
}

// Supabaseのエラーは Error インスタンスでないため message/details/code を拾って文字列化する
const errMessage = (e: unknown): string => {
  if (e instanceof Error) return e.message;
  if (e && typeof e === 'object') {
    const o = e as { message?: string; details?: string; hint?: string; code?: string };
    const parts = [o.message, o.details, o.hint].filter(Boolean);
    const body = parts.join(' / ') || JSON.stringify(e);
    return o.code ? `${body}（${o.code}）` : body;
  }
  return String(e);
};

const minToHHMM = (m: number | null): string => m == null ? '' : `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;

// 1つ目＋2つ目の時間帯を「10:00〜17:00 ＋ 6:30〜7:15」形式で。休みは「休み」
const bandsLabel = (s1: number | null, e1: number | null, s2: number | null, e2: number | null): string => {
  const parts: string[] = [];
  if (s1 != null && e1 != null) parts.push(`${minToHHMM(s1)}〜${minToHHMM(e1)}`);
  if (s2 != null && e2 != null) parts.push(`${minToHHMM(s2)}〜${minToHHMM(e2)}`);
  return parts.length ? parts.join(' ＋ ') : '休み';
};
const OvertimeShiftImport: React.FC<{
  supabase: SupabaseClient;
  isDarkMode: boolean;
  staff: StaffRow[];
  onImported: () => void;
}> = ({ supabase, isDarkMode, staff, onImported }) => {
  const [open, setOpen] = useState(false);
  const [fileBuf, setFileBuf] = useState<ArrayBuffer | null>(null);
  const [fileName, setFileName] = useState('');
  const [sheetNames, setSheetNames] = useState<string[]>([]);
  const [selectedSheet, setSelectedSheet] = useState('');
  const [applyFrom, setApplyFrom] = useState('');
  const [matched, setMatched] = useState<MatchedPerson[]>([]);
  const [parsedInfo, setParsedInfo] = useState<ParsedSheet | null>(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [showUnchanged, setShowUnchanged] = useState(false);
  // 差分再計算に使う情報（手動で名前を紐付けたときに使う）
  const patternsRef = useRef<PatternRow[]>([]);
  const refDateRef = useRef<string>('');
  // 正規化Excel名 → user_id のエイリアス（旧姓・表記ゆれの紐付け。DB保存）
  const aliasRef = useRef<Map<string, string>>(new Map());

  const text = isDarkMode ? '#f8f9fa' : '#212529';
  const subText = isDarkMode ? '#adb5bd' : '#6c757d';
  const borderColor = isDarkMode ? '#495057' : '#dee2e6';
  const innerBg = isDarkMode ? '#2b3035' : '#f8f9fa';
  const changedBg = isDarkMode ? '#4a3a10' : '#fff8e1';
  const inputStyle: React.CSSProperties = {
    padding: '7px 10px', borderRadius: 8, border: `1px solid ${borderColor}`,
    background: isDarkMode ? '#495057' : '#fff', color: text, fontSize: 13,
  };

  const reset = () => {
    setFileBuf(null); setFileName(''); setSheetNames([]); setSelectedSheet('');
    setApplyFrom(''); setMatched([]); setParsedInfo(null); setErr(''); setMsg(''); setShowConfirm(false);
  };

  const timeToMinLocal = (t: string | null): number | null => {
    if (!t) return null;
    const m = /^(\d{1,2}):(\d{2})/.exec(t);
    return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
  };

  // Excel1名分をアプリのスタッフと照合してMatchedPersonを組み立てる（エイリアスも考慮）
  const buildMatchedPerson = (
    excelName: string,
    normalizedName: string,
    excelDays: Record<ImportDayKind, ParsedDay>,
    isDuplicate: boolean,
    forcedStaffId?: string,
  ): MatchedPerson => {
    const staffById = new Map(staff.map(s => [s.id, s]));
    const staffByName = new Map(staff.map(s => [normalizeName(s.name), s]));
    const aliasId = aliasRef.current.get(normalizedName);
    const s = forcedStaffId ? staffById.get(forcedStaffId)
      : (staffByName.get(normalizedName) ?? (aliasId ? staffById.get(aliasId) : undefined) ?? undefined);

    const days: DiffDay[] = IMPORT_DAYS.map(kind => {
      const nd = excelDays[kind];
      const cur = s ? patternsRef.current.find(x =>
        x.user_id === s.id && x.day_kind === kind
        && x.valid_from <= refDateRef.current && (x.valid_to === null || x.valid_to >= refDateRef.current)) : undefined;
      const oldStart = cur ? timeToMinLocal(cur.start_time) : null;
      const oldEnd = cur ? timeToMinLocal(cur.end_time) : null;
      const oldStart2 = cur ? timeToMinLocal(cur.start_time2) : null;
      const oldEnd2 = cur ? timeToMinLocal(cur.end_time2) : null;
      const oldLoc = cur ? (cur.location ?? null) : null;
      // 勤務がある日のみ校を比較（休みの日は校の差を無視）
      const changed = nd.startMin !== oldStart || nd.endMin !== oldEnd
        || nd.startMin2 !== oldStart2 || nd.endMin2 !== oldEnd2
        || (nd.startMin != null && (oldLoc ?? DEFAULT_LOCATION) !== nd.location);
      return {
        kind, newStart: nd.startMin, newEnd: nd.endMin, newStart2: nd.startMin2, newEnd2: nd.endMin2, newLoc: nd.location,
        oldStart, oldEnd, oldStart2, oldEnd2, oldLoc, changed,
      };
    });

    let status: MatchStatus;
    if (!s) status = 'unregistered';
    else if (s.employment_type === 'パート') status = 'part_time';
    else status = 'importable';
    const hasChange = status === 'importable' && days.some(d => d.changed);
    return {
      excelName, normalizedName, isDuplicate,
      staffId: s?.id ?? null, staffName: s?.name ?? null,
      status, days, hasChange,
      selected: hasChange,
    };
  };

  const sortMatched = (a: MatchedPerson, b: MatchedPerson): number => {
    const rank = (x: MatchedPerson) =>
      x.status === 'unregistered' ? 0            // 要対応（紐付け待ち）を先頭に
      : x.status === 'importable' ? (x.hasChange ? 1 : 2)
      : 3;                                        // パート（対象外）は末尾
    return rank(a) - rank(b) || a.excelName.localeCompare(b.excelName, 'ja');
  };

  // 未登録の行をアプリのスタッフに手動で紐付け、エイリアスをDB保存する
  const linkPerson = async (row: MatchedPerson, staffId: string) => {
    if (!staffId) return;
    const parsedPerson = parsedInfo?.people.find(p => p.name === row.excelName);
    if (!parsedPerson) return;
    // エイリアスを保存（次回以降は自動一致）
    aliasRef.current.set(row.normalizedName, staffId);
    await supabase.from('overtime_name_aliases')
      .upsert({ excel_name: row.normalizedName, user_id: staffId }, { onConflict: 'excel_name' })
      .then(null, () => {});
    const rebuilt = buildMatchedPerson(row.excelName, row.normalizedName, parsedPerson.days, row.isDuplicate, staffId);
    rebuilt.selected = rebuilt.hasChange;
    setMatched(prev => prev.map(m => m.excelName === row.excelName ? rebuilt : m).sort(sortMatched));
  };

  const handleFile = async (f: File | undefined) => {
    if (!f) return;
    setErr(''); setMsg(''); setMatched([]); setParsedInfo(null); setShowConfirm(false);
    try {
      const buf = await f.arrayBuffer();
      const names = await listSheetNames(buf);
      // 日付形式のシート名だけを候補にし、最新（＝日付が最大）を初期選択
      const dated = names.filter(n => sheetNameToDate(n) !== null);
      const candidates = dated.length > 0 ? dated : names;
      const initial = dated.length > 0
        ? dated.reduce((a, b) => (sheetNameToDate(a)! >= sheetNameToDate(b)! ? a : b))
        : names[0];
      setFileBuf(buf);
      setFileName(f.name);
      setSheetNames(candidates);
      setSelectedSheet(initial ?? '');
      if (initial) await parseAndDiff(buf, initial);
    } catch {
      setErr('ファイルを読み込めませんでした。Excel（.xlsx）ファイルか確認してください');
    }
  };

  const parseAndDiff = async (buf: ArrayBuffer, sheetName: string) => {
    setBusy(true); setErr(''); setMsg(''); setShowConfirm(false);
    try {
      const parsed = await parseShiftSheet(buf, sheetName);
      setParsedInfo(parsed);
      const from = parsed.applyFrom ?? '';
      setApplyFrom(from);
      if (parsed.people.length === 0) {
        setErr('このシートからシフトを読み取れませんでした。書式（名前の下に「曜日」ヘッダー）を確認してください');
        setMatched([]);
        return;
      }

      // 現在の曜日パターンと名前エイリアスを取得
      const [{ data: patData }, { data: aliasData }] = await Promise.all([
        supabase.from('weekly_shift_patterns').select('id, user_id, day_kind, start_time, end_time, start_time2, end_time2, location, valid_from, valid_to'),
        supabase.from('overtime_name_aliases').select('excel_name, user_id'),
      ]);
      const patterns = (patData as PatternRow[] | null) ?? [];
      const refDate = from || todayJstStr();
      patternsRef.current = patterns;
      refDateRef.current = refDate;
      aliasRef.current = new Map(((aliasData as { excel_name: string; user_id: string }[] | null) ?? [])
        .map(a => [a.excel_name, a.user_id]));

      const rows: MatchedPerson[] = parsed.people.map(p => buildMatchedPerson(p.name, p.normalizedName, p.days, p.isDuplicate));
      rows.sort(sortMatched);
      setMatched(rows);
    } catch {
      setErr('読み取り中にエラーが発生しました');
    } finally {
      setBusy(false);
    }
  };

  const doImport = async () => {
    const targets = matched.filter(m => m.selected && m.staffId && m.status === 'importable');
    if (targets.length === 0) { setErr('登録対象が選択されていません'); return; }
    if (!applyFrom) { setErr('適用開始日を入力してください'); return; }
    setBusy(true); setErr('');
    try {
      const [y, mo, d] = applyFrom.split('-').map(Number);
      const pd = new Date(y, mo - 1, d - 1);
      const prevDay = `${pd.getFullYear()}-${String(pd.getMonth() + 1).padStart(2, '0')}-${String(pd.getDate()).padStart(2, '0')}`;

      // 対象者の月〜日パターンを取り直して（並行編集対策）締め・削除→新規insert
      const { data: patData } = await supabase.from('weekly_shift_patterns')
        .select('id, user_id, day_kind, valid_from, valid_to')
        .in('user_id', targets.map(t => t.staffId as string))
        .in('day_kind', IMPORT_DAYS);
      const patterns = (patData as PatternRow[] | null) ?? [];

      for (const t of targets) {
        for (const day of t.days) {
          const overlapping = patterns.filter(p =>
            p.user_id === t.staffId && p.day_kind === day.kind
            && (p.valid_to === null || p.valid_to >= applyFrom));
          for (const p of overlapping) {
            if (p.valid_from >= applyFrom) {
              const { error } = await supabase.from('weekly_shift_patterns').delete().eq('id', p.id);
              if (error) throw error;
            } else {
              const { error } = await supabase.from('weekly_shift_patterns').update({ valid_to: prevDay }).eq('id', p.id);
              if (error) throw error;
            }
          }
          const isWork = day.newStart != null && day.newEnd != null;
          const hasBand2 = day.newStart2 != null && day.newEnd2 != null;
          const { breakMinutes, laborMinutes } = calcPatternFields(
            { start: day.newStart, end: day.newEnd },
            { start: day.newStart2, end: day.newEnd2 },
          );
          const { error } = await supabase.from('weekly_shift_patterns').insert({
            user_id: t.staffId,
            day_kind: day.kind,
            start_time: isWork ? minToHHMM(day.newStart) : null,
            end_time: isWork ? minToHHMM(day.newEnd) : null,
            start_time2: hasBand2 ? minToHHMM(day.newStart2) : null,
            end_time2: hasBand2 ? minToHHMM(day.newEnd2) : null,
            location: isWork ? day.newLoc : null,
            break_minutes: breakMinutes,
            labor_minutes: laborMinutes,
            valid_from: applyFrom,
            valid_to: null,
          });
          if (error) throw error;
        }
      }
      setMsg(`${targets.length}名のパターンを登録しました（${applyFrom} から適用）`);
      setShowConfirm(false);
      setMatched([]);
      setParsedInfo(null);
      onImported();
    } catch (e) {
      setErr('登録に失敗しました: ' + errMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const changedCount = matched.filter(m => m.hasChange).length;
  const unregisteredCount = matched.filter(m => m.status === 'unregistered').length;
  const partTimeCount = matched.filter(m => m.status === 'part_time').length;
  const noChangeCount = matched.filter(m => m.status === 'importable' && !m.hasChange).length;
  const selectedCount = matched.filter(m => m.selected && m.staffId && m.status === 'importable').length;
  // 未登録（要対応）は常に表示。変更なし・パートは「変更なしも表示」で開く
  const visibleRows = matched.filter(m => showUnchanged || m.hasChange || m.status === 'unregistered');
  // 手動紐付け用の正社員候補（序列は問わず名前順）
  const linkCandidates = staff.filter(s => s.employment_type !== 'パート');

  return (
    <div style={{ marginTop: 16, borderTop: `1px solid ${borderColor}`, paddingTop: 14 }}>
      <button onClick={() => { setOpen(o => !o); if (open) reset(); }}
        style={{ background: 'none', border: `1px solid ${borderColor}`, borderRadius: 8, cursor: 'pointer', padding: '8px 16px', fontSize: 13, fontWeight: 'bold', color: '#0d6efd' }}>
        📥 Excelから取り込み{open ? ' を閉じる' : ''}
      </button>

      {open && (
        <div style={{ marginTop: 12 }}>
          <p style={{ margin: '0 0 10px', fontSize: 12.5, color: subText, lineHeight: 1.7 }}>
            いつもの勤務表Excel（.xlsx）をそのまま選んでください。シートを選ぶと、現在の曜日パターンとの違いだけを表示します。<br />
            祝・出パターンと、Excelに載っていないスタッフは変更されません。パート（対象外）は取り込みません。<br />
            旧姓・表記ゆれで名前が一致しない人は「この人を選ぶ」から手動で結び付けられます（次回から自動で一致します）。
          </p>

          <input type="file" accept=".xlsx"
            onChange={e => handleFile(e.target.files?.[0])}
            style={{ fontSize: 13, color: text, marginBottom: 10 }} />

          {fileBuf && sheetNames.length > 0 && (
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
              <label style={{ fontSize: 12.5, color: subText, display: 'flex', alignItems: 'center', gap: 6 }}>
                シート
                <select value={selectedSheet}
                  onChange={e => { setSelectedSheet(e.target.value); parseAndDiff(fileBuf, e.target.value); }}
                  style={inputStyle}>
                  {sheetNames.map(n => <option key={n} value={n}>{n}</option>)}
                </select>
              </label>
              <label style={{ fontSize: 12.5, color: subText, display: 'flex', alignItems: 'center', gap: 6 }}>
                適用開始日
                <input type="date" value={applyFrom} onChange={e => setApplyFrom(e.target.value)} style={inputStyle} />
              </label>
            </div>
          )}

          {busy && <p style={{ margin: '8px 0', fontSize: 13, color: subText }}>読み取り中…</p>}
          {err && <p style={{ margin: '8px 0', fontSize: 13, color: '#dc3545' }}>{err}</p>}
          {msg && (
            <div style={{ background: isDarkMode ? '#1b3a1e' : '#d1e7dd', border: '1px solid #28a745', borderRadius: 8, padding: '8px 12px', margin: '8px 0' }}>
              <p style={{ margin: 0, fontSize: 13, color: isDarkMode ? '#8fd19e' : '#0f5132' }}>✅ {msg}</p>
            </div>
          )}

          {matched.length > 0 && (
            <>
              <div style={{ background: innerBg, borderRadius: 8, padding: '8px 12px', marginBottom: 10, fontSize: 12.5, color: subText, lineHeight: 1.7 }}>
                {fileName}／{selectedSheet}：{matched.length}名を読み取り
                ・変更あり <strong style={{ color: text }}>{changedCount}名</strong>
                ・変更なし {noChangeCount}名
                {partTimeCount > 0 && <>・パート {partTimeCount}名（対象外）</>}
                {unregisteredCount > 0 && <>・<span style={{ color: '#e65100' }}>名前が一致しない {unregisteredCount}名（下で結び付け可）</span></>}
                {parsedInfo && parsedInfo.duplicateNames.length > 0 && (
                  <><br />⚠️ 同じ名前のブロックが複数ありました（{parsedInfo.duplicateNames.join('・')}）。下にある新しい方を採用しています</>
                )}
              </div>

              <label style={{ fontSize: 12, color: subText, display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, cursor: 'pointer' }}>
                <input type="checkbox" checked={showUnchanged} onChange={e => setShowUnchanged(e.target.checked)} />
                変更なしの人も表示する
              </label>

              <div style={{ overflowX: 'auto', marginBottom: 12 }}>
                <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse', color: text, minWidth: 640 }}>
                  <thead>
                    <tr>
                      <th style={{ padding: '6px 4px', borderBottom: `1px solid ${borderColor}`, textAlign: 'left' }}>登録</th>
                      <th style={{ padding: '6px 4px', borderBottom: `1px solid ${borderColor}`, textAlign: 'left' }}>名前</th>
                      {IMPORT_DAYS.map(k => (
                        <th key={k} style={{ padding: '6px 4px', borderBottom: `1px solid ${borderColor}`, whiteSpace: 'nowrap' }}>{DAY_KIND_LABELS[k]}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {visibleRows.map(m => {
                      const highlight = m.status === 'importable';
                      return (
                      <tr key={m.excelName} style={{ opacity: m.status === 'part_time' ? 0.55 : 1 }}>
                        <td style={{ padding: '5px 4px', borderBottom: `1px solid ${borderColor}` }}>
                          {m.status === 'importable' && (
                            <input type="checkbox" checked={m.selected}
                              onChange={e => setMatched(prev => prev.map(x => x.excelName === m.excelName ? { ...x, selected: e.target.checked } : x))} />
                          )}
                          {m.status === 'part_time' && <span style={{ fontSize: 11, color: subText }}>パート</span>}
                          {m.status === 'unregistered' && (
                            <select value="" onChange={e => linkPerson(m, e.target.value)}
                              style={{ ...inputStyle, padding: '4px 6px', fontSize: 11, maxWidth: 130 }}>
                              <option value="">この人を選ぶ…</option>
                              {linkCandidates.map(s => <option key={s.id} value={s.id}>{s.name}（{s.role_title}）</option>)}
                            </select>
                          )}
                        </td>
                        <td style={{ padding: '5px 4px', borderBottom: `1px solid ${borderColor}`, whiteSpace: 'nowrap' }}>
                          {m.excelName}
                          {m.isDuplicate && <span title="同名ブロックが複数（新しい方を採用）"> ⚠️</span>}
                        </td>
                        {m.days.map(d => (
                          <td key={d.kind} style={{
                            padding: '5px 4px', borderBottom: `1px solid ${borderColor}`, whiteSpace: 'nowrap', textAlign: 'center',
                            background: d.changed && highlight ? changedBg : undefined,
                          }}>
                            {d.changed && highlight ? (
                              <>
                                <span style={{ color: subText, textDecoration: 'line-through' }}>{bandsLabel(d.oldStart, d.oldEnd, d.oldStart2, d.oldEnd2)}</span>
                                <br />
                                <span style={{ fontWeight: 'bold' }}>{bandsLabel(d.newStart, d.newEnd, d.newStart2, d.newEnd2)}</span>
                                {d.newStart != null && <><br /><span style={{ fontSize: 10, color: subText }}>{d.newLoc}</span></>}
                              </>
                            ) : (
                              <>
                                <span style={{ color: subText }}>{bandsLabel(d.newStart, d.newEnd, d.newStart2, d.newEnd2)}</span>
                                {d.newStart != null && <><br /><span style={{ fontSize: 10, color: subText }}>{d.newLoc}</span></>}
                              </>
                            )}
                          </td>
                        ))}
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {!showConfirm ? (
                <button onClick={() => { setErr(''); if (selectedCount === 0) { setErr('登録対象が選択されていません'); return; } if (!applyFrom) { setErr('適用開始日を入力してください'); return; } setShowConfirm(true); }}
                  disabled={busy}
                  style={{ padding: '10px 24px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: 'bold', background: '#007bff', color: '#fff' }}>
                  {selectedCount}名分を取り込む
                </button>
              ) : (
                <div style={{ background: innerBg, borderRadius: 8, padding: '10px 12px' }}>
                  <p style={{ margin: '0 0 8px', fontSize: 13, color: text }}>
                    <strong>{selectedCount}名</strong>の月〜日パターンを <strong>{applyFrom}</strong> から適用します。
                    それより前の申請・集計は変わりません。よろしいですか？
                  </p>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button onClick={doImport} disabled={busy}
                      style={{ flex: 1, maxWidth: 200, padding: '9px 0', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 'bold', background: '#007bff', color: '#fff', opacity: busy ? 0.6 : 1 }}>
                      {busy ? '登録中…' : '登録する'}
                    </button>
                    <button onClick={() => setShowConfirm(false)} disabled={busy}
                      style={{ flex: 1, maxWidth: 200, padding: '9px 0', borderRadius: 8, border: `1px solid ${borderColor}`, cursor: 'pointer', fontSize: 13, background: 'transparent', color: subText }}>
                      やめる
                    </button>
                  </div>
                </div>
              )}

              <p style={{ margin: '10px 0 0', fontSize: 11.5, color: subText }}>
                ※ 出勤・退勤だけを取り込み、休憩・労働時間はアプリの計算表で自動計算して保存します
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
};

export default OvertimeShiftImport;

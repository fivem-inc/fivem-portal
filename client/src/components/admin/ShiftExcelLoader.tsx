import React, { useState, useRef } from 'react';
import { supabase } from '../../lib/supabaseClient';
import {
  parseShiftSheet, listSheetNames, normalizeName, sheetNameToDate,
  IMPORT_DAYS, DEFAULT_LOCATION, isShiftTarget,
} from '../../lib/shiftExcelImport';
import type { ParsedSheet, ParsedDay } from '../../lib/shiftExcelImport';
import type { RosterDay, RosterDayKind, RosterSegment } from '../../lib/shiftRoster';
import type { RosterStaff } from '../../lib/shiftRosterApi';

// Excel（勤務表.xlsx）を読み取って、シフト管理の表に値を入れる（2026-09-15）。
// 🚨 ここでは保存しない。表に入れたあと、一括編集と同じ確認で保存する（レビュー R10・ユーザー確定）
// 🚨 Excel に部門は無いので、入れた時間帯の部門は「メインの部門」（area_id=null）
// 🚨 Excel に載っていない人は変えない

export interface LoadedPerson {
  userId: string;
  days: Partial<Record<RosterDayKind, RosterDay>>;
}

const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

function toRosterDay(d: ParsedDay): RosterDay {
  const segs: RosterSegment[] = [];
  const loc = d.location || DEFAULT_LOCATION;
  if (d.startMin != null && d.endMin != null) segs.push({ start: hhmm(d.startMin), end: hhmm(d.endMin), location: loc, area_id: null });
  if (d.startMin2 != null && d.endMin2 != null) segs.push({ start: hhmm(d.startMin2), end: hhmm(d.endMin2), location: loc, area_id: null });
  return { segments: segs, note: '' };
}

interface Row { excelName: string; normalized: string; staffId: string | null; inScope: boolean; isDuplicate: boolean }

const ShiftExcelLoader: React.FC<{
  isDarkMode: boolean;
  staff: RosterStaff[];
  includePartTime: boolean;
  onLoad: (applyFrom: string | null, people: LoadedPerson[]) => void;
}> = ({ isDarkMode, staff, includePartTime, onLoad }) => {
  const [open, setOpen] = useState(false);
  const [sheets, setSheets] = useState<string[]>([]);
  const [sheet, setSheet] = useState('');
  const [parsed, setParsed] = useState<ParsedSheet | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const bufRef = useRef<ArrayBuffer | null>(null);
  const aliasRef = useRef<Map<string, string>>(new Map());

  const text = isDarkMode ? '#f8f9fa' : '#212529';
  const subText = isDarkMode ? '#adb5bd' : '#6c757d';
  const borderColor = isDarkMode ? '#495057' : '#dee2e6';
  const inputStyle: React.CSSProperties = { padding: '6px 8px', borderRadius: 8, border: `1px solid ${borderColor}`, background: isDarkMode ? '#495057' : '#fff', color: text, fontSize: 13 };

  const match = (p: ParsedSheet): Row[] => {
    const byName = new Map(staff.map(s => [normalizeName(s.name), s]));
    const byId = new Map(staff.map(s => [s.id, s]));
    return p.people.map(x => {
      const aliasId = aliasRef.current.get(x.normalizedName);
      const s = byName.get(x.normalizedName) ?? (aliasId ? byId.get(aliasId) : undefined);
      return { excelName: x.name, normalized: x.normalizedName, staffId: s?.id ?? null, inScope: s ? isShiftTarget(s.employment_type, includePartTime) : false, isDuplicate: x.isDuplicate };
    });
  };

  const readSheet = async (buf: ArrayBuffer, name: string) => {
    setBusy(true); setErr(''); setMsg('');
    try {
      const p = await parseShiftSheet(buf, name);
      if (p.people.length === 0) { setErr('このシートからシフトを読み取れませんでした。書式（名前の下に「曜日」の見出し）を確認してください'); setParsed(null); setRows([]); return; }
      const { data, error } = await supabase.from('overtime_name_aliases').select('excel_name, user_id');
      if (error) setErr('名前の結び付けを読み込めませんでした。名前が一致しない人が増えることがあります');
      aliasRef.current = new Map(((data ?? []) as { excel_name: string; user_id: string }[]).map(a => [a.excel_name, a.user_id]));
      setParsed(p);
      setRows(match(p));
    } catch {
      setErr('読み取り中にエラーが発生しました');
    } finally {
      setBusy(false);
    }
  };

  const handleFile = async (f: File | undefined) => {
    if (!f) return;
    setErr(''); setMsg(''); setParsed(null); setRows([]);
    try {
      const buf = await f.arrayBuffer();
      const names = await listSheetNames(buf);
      const dated = names.filter(n => sheetNameToDate(n) !== null);
      const initial = dated.length > 0 ? dated.reduce((a, b) => (sheetNameToDate(a)! >= sheetNameToDate(b)! ? a : b)) : names[0];
      bufRef.current = buf;
      setSheets(dated.length > 0 ? dated : names);
      setSheet(initial ?? '');
      if (initial) await readSheet(buf, initial);
    } catch {
      setErr('ファイルを読み込めませんでした。Excel（.xlsx）ファイルか確認してください');
    }
  };

  // 名前が一致しない人を結び付ける。次回から自動で一致するよう覚える（覚えられなくても今回は使える）
  const link = async (row: Row, staffId: string) => {
    if (!staffId || !parsed) return;
    aliasRef.current.set(row.normalized, staffId);
    const { error } = await supabase.from('overtime_name_aliases')
      .upsert({ excel_name: row.normalized, user_id: staffId }, { onConflict: 'excel_name' });
    setErr(error ? '結び付けを覚えられませんでした（今回は使えます。次回はもう一度選んでください）' : '');
    setRows(match(parsed));
  };

  const apply = () => {
    if (!parsed) return;
    const people: LoadedPerson[] = [];
    for (const r of rows) {
      if (!r.staffId || !r.inScope) continue;
      const p = parsed.people.find(x => x.normalizedName === r.normalized);
      if (!p) continue;
      const days: Partial<Record<RosterDayKind, RosterDay>> = {};
      for (const k of IMPORT_DAYS) days[k] = toRosterDay(p.days[k]);
      people.push({ userId: r.staffId, days });
    }
    onLoad(parsed.applyFrom, people);
    const outOfScope = rows.filter(r => r.staffId && !r.inScope).length;
    const unmatched = rows.filter(r => !r.staffId).length;
    setMsg(`${people.length}人の値を表に入れました。表で確かめてから「保存」を押してください。`
      + (outOfScope > 0 ? `（対象外 ${outOfScope}人は入れていません）` : '')
      + (unmatched > 0 ? `（名前が一致しない ${unmatched}人は入れていません）` : ''));
  };

  const unmatched = rows.filter(r => !r.staffId);
  const candidates = staff.filter(s => isShiftTarget(s.employment_type, includePartTime));

  return (
    <div style={{ marginBottom: 12 }}>
      <button type="button" onClick={() => setOpen(o => !o)}
        style={{ background: 'none', border: `1px solid ${borderColor}`, borderRadius: 8, cursor: 'pointer', padding: '7px 14px', fontSize: 13, fontWeight: 'bold', color: '#0d6efd' }}>
        📥 Excelから取り込み{open ? ' を閉じる' : ''}
      </button>
      {open && (
        <div style={{ marginTop: 10, padding: '10px 12px', borderRadius: 10, border: `1px solid ${borderColor}` }}>
          <p style={{ margin: '0 0 8px', fontSize: 12.5, color: subText, lineHeight: 1.7 }}>
            いつもの勤務表Excel（.xlsx）を選ぶと、読み取った値が下の表に入り、変わるマスが赤字になります。まだ保存はされません。<br />
            部門はメインの部門で入ります。Excelに載っていない人は変わりません。
          </p>
          <input type="file" accept=".xlsx" onChange={e => handleFile(e.target.files?.[0])} style={{ fontSize: 13, color: text }} />
          {sheets.length > 0 && bufRef.current && (
            <label style={{ fontSize: 12.5, color: subText, display: 'flex', alignItems: 'center', gap: 6, marginTop: 8 }}>
              シート
              <select value={sheet} onChange={e => { setSheet(e.target.value); if (bufRef.current) readSheet(bufRef.current, e.target.value); }} style={inputStyle}>
                {sheets.map(n => <option key={n} value={n}>{n}</option>)}
              </select>
              {parsed?.applyFrom && <span>（適用開始日 {parsed.applyFrom}）</span>}
            </label>
          )}
          {busy && <p style={{ margin: '8px 0 0', fontSize: 13, color: subText }}>読み取り中…</p>}
          {err && <p style={{ margin: '8px 0 0', fontSize: 13, color: '#dc3545' }}>{err}</p>}
          {parsed && rows.length > 0 && (
            <div style={{ marginTop: 8, fontSize: 12.5, color: text }}>
              {rows.length}人を読み取り（表に入れる {rows.filter(r => r.staffId && r.inScope).length}人
              ・対象外 {rows.filter(r => r.staffId && !r.inScope).length}人
              ・名前が一致しない {unmatched.length}人）
              {parsed.duplicateNames.length > 0 && <div style={{ color: subText }}>⚠️ 同じ名前のブロックが複数ありました（{parsed.duplicateNames.join('・')}）。下にある新しい方を使います</div>}
              {unmatched.map(r => (
                <div key={r.excelName} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                  <span style={{ color: '#e65100' }}>{r.excelName}</span>
                  <select value="" onChange={e => link(r, e.target.value)} style={{ ...inputStyle, padding: '4px 6px', fontSize: 12 }}>
                    <option value="">この人を選ぶ…</option>
                    {candidates.map(s => <option key={s.id} value={s.id}>{s.name}（{s.role_title}）</option>)}
                  </select>
                </div>
              ))}
              <div style={{ marginTop: 10 }}>
                <button type="button" onClick={apply}
                  style={{ padding: '8px 18px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 'bold', background: '#1976d2', color: '#fff' }}>
                  表に入れる
                </button>
              </div>
            </div>
          )}
          {msg && <p style={{ margin: '8px 0 0', fontSize: 13, color: isDarkMode ? '#8fd19e' : '#0f5132' }}>{msg}</p>}
        </div>
      )}
    </div>
  );
};

export default ShiftExcelLoader;

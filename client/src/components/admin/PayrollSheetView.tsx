import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import SearchableSelect from '../common/SearchableSelect';
import { backBtn, tintBtn, TOGGLE_BLUE } from '../../lib/buttonStyles';
import { payMonthLabel, payPeriodLabel, payPeriodEnd } from '../../lib/breakCalc';
import { onRowPick, pickedRowBg } from '../../lib/rowPick';
import { SHEET_DOW, dowOf, sheetMd, sheetHm, daysWithEntries, type PersonSheet, type SheetDay, type SheetPerson } from '../../lib/payrollSheet';
import { exportPayrollSheetsXlsx } from '../../lib/payrollSheetExcel';

/**
 * 給与計算用の［表で見る］の見た目（残業・勤務変更で共用・2026-10-21 ユーザー確定）。
 * 元のスプレッドシートと同じ形：1人ずつ・給与の期の1日1行・従業員番号の順。［◀ 前の人］［次の人 ▶］・←→ キー・名前／番号で探す。
 * 行を押すと薄い青（1行だけ）。理由が長いときは2行で切り、押すと全文
 * 2026-10-22 ユーザー指示：［1人ずつ］［記載のある人を並べて］の切り替え／列の幅は見出しの境目をつまんで変える（端末に覚える）／
 *   ［📥 この給与期間の表を Excel で出す］（一覧＋1人1シート・lib/payrollSheetExcel）
 * 🚨 データの作り方（合計・灰色にする行など）は呼ぶ側の sheetFor。この部品は見せるだけ。1人ずつ・並べて・Excel が同じ sheetFor を使う
 */

type Mode = 'one' | 'stack';
const MODE_KEY = 'fivem_payroll_sheet_mode';
const COLS_KEY = 'fivem_payroll_sheet_cols_v1';
// 日付・曜日・通常シフト時間・労働時間(休憩)・変更(実務)シフト時間・時間数・理由・確認サイン
const DEFAULT_COLS = [52, 32, 110, 92, 120, 72, 280, 120];
const MIN_COL = 28;
const HEADS = ['日付', '', '通常シフト時間', '労働時間(休憩)', '変更(実務)シフト時間', '時間数', '理由', '確認サイン'];

function readCols(): number[] {
  try {
    const v = JSON.parse(localStorage.getItem(COLS_KEY) || 'null');
    if (Array.isArray(v) && v.length === DEFAULT_COLS.length && v.every(n => typeof n === 'number' && n >= MIN_COL)) return v;
  } catch { /* 読めなければ元の幅 */ }
  return DEFAULT_COLS;
}

const PayrollSheetView: React.FC<{
  isDarkMode: boolean;
  onBack: () => void;
  periodOptions: string[];
  period: string;
  onPeriod: (p: string) => void;
  loading: boolean;
  loadErr: string;
  onReload: () => void;
  people: SheetPerson[];
  personId: string | null;
  onPerson: (id: string) => void;
  /** 「残業」「勤務変更」（Excel のファイル名に使う） */
  kindLabel: string;
  /** 1人分の表（合計は呼ぶ側が計算した数字。行の足し算ではない） */
  sheetFor: (id: string) => PersonSheet | null;
}> = ({ isDarkMode, onBack, periodOptions, period, onPeriod, loading, loadErr, onReload, people, personId, onPerson, kindLabel, sheetFor }) => {
  const isDark = isDarkMode;
  const text = isDark ? '#e9ecef' : '#212529';
  const sub = isDark ? '#adb5bd' : '#6c757d';
  const border = isDark ? '#495057' : '#dee2e6';
  const headBg = isDark ? '#343a40' : '#f6f6f6';
  const cardBg = isDark ? '#212529' : '#fff';
  const gray = isDark ? '#8a929a' : '#9aa0a6';
  const bandBg = isDark ? '#3a2a33' : '#fde8ee';

  const [mode, setModeState] = useState<Mode>(() => { try { return localStorage.getItem(MODE_KEY) === 'stack' ? 'stack' : 'one'; } catch { return 'one'; } });
  const setMode = (m: Mode) => { setModeState(m); try { localStorage.setItem(MODE_KEY, m); } catch { /* 覚えられなくても切り替わる */ } };
  const [cols, setCols] = useState<number[]>(readCols);
  const saveCols = (c: number[]) => { try { localStorage.setItem(COLS_KEY, JSON.stringify(c)); } catch { /* 覚えられなくても幅は変わる */ } };
  const colsChanged = cols.some((w, i) => w !== DEFAULT_COLS[i]);
  // 見出しの右の境目をつまんで幅を変える（離したときに端末に覚える）
  const startResize = (i: number) => (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault(); e.stopPropagation();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const x0 = e.clientX, w0 = cols[i];
    let latest = cols;
    const move = (ev: PointerEvent) => { latest = cols.map((w, k) => (k === i ? Math.max(MIN_COL, Math.round(w0 + ev.clientX - x0)) : w)); setCols(latest); };
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); saveCols(latest); };
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  };

  const [picked, setPicked] = useState<string | null>(null);
  // 名前の帯と表の見出しを、表を下へ動かしても上に残す（2026-10-21 ユーザー指示）。
  // 🚨 管理画面の外側の箱が overflow-x: hidden なので、ページ全体に対する position: sticky は効かない。
  //    表を高さの決まった箱の中で動かし（縦も横も）、その箱の中で名前の帯（上・左）と見出し（名前の帯の下）を止める
  const nameRef = useRef<HTMLDivElement>(null);
  const [nameH, setNameH] = useState(0);
  useLayoutEffect(() => {
    const el = nameRef.current;
    if (!el) return;
    const m = () => setNameH(el.offsetHeight);
    m();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(m) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  });
  const [openReason, setOpenReason] = useState<Set<string>>(new Set());
  useEffect(() => { setPicked(null); setOpenReason(new Set()); }, [personId, period, mode]);

  const idx = Math.max(0, people.findIndex(p => p.id === personId));
  const person = people[idx] ?? null;
  const sheet = useMemo(() => (person ? sheetFor(person.id) : null), [person, sheetFor]);
  // 並べて見る：この期に記載のある方だけ（従業員番号の順＝people の順）
  const stacked = useMemo(() => (mode !== 'stack' ? [] : people
    .map(p => ({ p, s: sheetFor(p.id) }))
    .filter((x): x is { p: SheetPerson; s: PersonSheet } => !!x.s && daysWithEntries(x.s.days).length > 0)), [mode, people, sheetFor]);

  const go = useCallback((d: number) => { const n = people[idx + d]; if (n) onPerson(n.id); }, [people, idx, onPerson]);
  // ←／→ で前の人・次の人（1人ずつのときだけ。探す欄・期の選択に入力しているときは動かさない）
  useEffect(() => {
    if (mode !== 'one') return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target;
      if (t instanceof Element && t.closest('input, select, textarea')) return;
      if (e.key === 'ArrowLeft') go(-1);
      if (e.key === 'ArrowRight') go(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go, mode]);

  const periodName = `${payPeriodEnd(period).slice(0, 4)}年${payMonthLabel(period)}`;
  const [xlsxBusy, setXlsxBusy] = useState(false);
  const [xlsxErr, setXlsxErr] = useState('');
  const doExcel = async () => {
    setXlsxBusy(true); setXlsxErr('');
    try { await exportPayrollSheetsXlsx({ kindLabel, periodLabel: periodName, people, sheetFor }); }
    catch (e) { setXlsxErr('Excel を作れませんでした：' + (e instanceof Error ? e.message : String(e))); }
    setXlsxBusy(false);
  };

  const sel: React.CSSProperties = { padding: '5px 10px', borderRadius: 8, border: `1px solid ${isDark ? '#6c757d' : '#ccc'}`, background: isDark ? '#495057' : '#fff', color: text, fontSize: 13 };
  const navBtn = (disabled: boolean): React.CSSProperties => ({ ...backBtn(isDark), padding: '5px 12px', borderRadius: 8, fontSize: 13, cursor: disabled ? 'default' : 'pointer', color: disabled ? gray : undefined });
  const modeBtn = (on: boolean, left: boolean): React.CSSProperties => ({
    padding: '5px 12px', fontSize: 13, cursor: 'pointer', border: `1px solid ${on ? TOGGLE_BLUE : (isDark ? '#6c757d' : '#ccc')}`,
    background: on ? TOGGLE_BLUE : (isDark ? '#343a40' : '#fff'), color: on ? '#fff' : text, fontWeight: on ? 'bold' : 'normal',
    borderRadius: left ? '8px 0 0 8px' : '0 8px 8px 0', marginLeft: left ? 0 : -1,
  });
  const th: React.CSSProperties = { padding: '6px 4px', border: `1px solid ${border}`, background: headBg, color: text, fontWeight: 'normal', fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
  const td: React.CSSProperties = { padding: '6px 6px', borderLeft: `1px solid ${border}`, fontSize: 12.5, color: text, verticalAlign: 'top', overflowWrap: 'anywhere' };
  const tableW = cols.reduce((a, b) => a + b, 0);

  const dayRows = (day: SheetDay, prefix: string) => {
    const dw = dowOf(day.date);
    const dayColor = dw === 6 ? (isDark ? '#8fc5f6' : '#1565c0') : dw === 0 ? (isDark ? '#f1aeb5' : '#c62828') : text;
    const entries = day.entries.length ? day.entries : [{ key: 'none', reason: '', sign: '', actual: '', time: '', muted: false, strike: false }];
    return entries.map((en, i) => {
      const rowKey = `${prefix}|${day.date}|${en.key}`;
      const rowBg = picked === rowKey ? pickedRowBg(isDark) : cardBg;
      const first = i === 0;
      const c = (extra?: React.CSSProperties): React.CSSProperties => ({ ...td, borderTop: first ? `1px solid ${border}` : `1px dotted ${border}`, background: rowBg, ...extra });
      const mutedColor = en.muted ? gray : text;
      const reasonOpen = openReason.has(rowKey);
      const hasNs = day.nsLines.length > 0;
      return (
        <tr key={rowKey} onClick={e => onRowPick(e, rowKey, picked, setPicked)} style={{ cursor: 'pointer' }}>
          <td style={c({ position: 'sticky', left: 0, zIndex: 1, textAlign: 'center', color: dayColor, borderLeft: 'none' })}>{first ? sheetMd(day.date) : ''}</td>
          <td style={c({ position: 'sticky', left: cols[0], zIndex: 1, textAlign: 'center', color: dayColor })}>{first ? SHEET_DOW[dw] : ''}</td>
          <td style={c({ textAlign: 'center', color: hasNs ? text : gray })}>
            {first ? (hasNs ? day.nsLines.map((t, k) => <div key={k}>{t}</div>) : day.offLabel) : ''}
          </td>
          <td style={c({ textAlign: 'center', color: hasNs ? text : gray })}>{first ? day.laborText : ''}</td>
          <td style={c({ textAlign: 'center', color: mutedColor })}>{en.actual}</td>
          <td style={c({ textAlign: 'right', color: en.timeColor ?? mutedColor, fontVariantNumeric: 'tabular-nums', textDecoration: en.strike ? 'line-through' : undefined })}>{en.time}</td>
          <td style={c({ textAlign: 'left', color: mutedColor, textDecoration: en.strike ? 'line-through' : undefined })}
            onClick={() => setOpenReason(prev => { const n = new Set(prev); if (n.has(rowKey)) n.delete(rowKey); else n.add(rowKey); return n; })}>
            <div style={reasonOpen ? { whiteSpace: 'pre-wrap' } : { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{en.reason}</div>
          </td>
          <td style={c({ color: mutedColor, fontSize: 11.5 })}>{en.sign}</td>
        </tr>
      );
    });
  };

  const totalLine = (s: PersonSheet, size: number) => (
    <>合計時間 → <b style={{ fontSize: size, color: s.total != null && s.total < 0 ? '#c62828' : text }}>{s.total == null ? '—' : sheetHm(s.total)}</b></>
  );

  const table = (body: React.ReactNode) => (
    <table style={{ borderCollapse: 'separate', borderSpacing: 0, width: tableW, tableLayout: 'fixed' }}>
      <colgroup>{cols.map((w, i) => <col key={i} style={{ width: w }} />)}</colgroup>
      <thead>
        <tr>
          {HEADS.map((h, i) => (
            <th key={i} style={{ ...th, position: 'sticky', top: nameH, zIndex: i < 2 ? 4 : 3, ...(i < 2 ? { left: i === 0 ? 0 : cols[0] } : {}) }}>
              {h}
              <div onPointerDown={startResize(i)} title="つまんで左右に動かすと、列の幅が変わります"
                style={{ position: 'absolute', top: 0, right: 0, width: 8, height: '100%', cursor: 'col-resize', zIndex: 6, touchAction: 'none' }} />
            </th>
          ))}
        </tr>
      </thead>
      <tbody>{body}</tbody>
    </table>
  );

  const boxStyle: React.CSSProperties = { overflow: 'auto', maxHeight: 'calc(100dvh - 90px)', minHeight: 320, border: `1px solid ${border}`, borderRadius: 8, background: cardBg };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        <button type="button" onClick={onBack} style={{ ...backBtn(isDark), padding: '6px 14px', borderRadius: 8, fontSize: 13, cursor: 'pointer' }}>← 一覧に戻る</button>
        <select value={period} onChange={e => onPeriod(e.target.value)} style={sel}>
          {periodOptions.map(p => <option key={p} value={p}>{payPeriodEnd(p).slice(0, 4)}年{payMonthLabel(p)}（{payPeriodLabel(p)}）</option>)}
        </select>
        <span style={{ display: 'inline-flex' }}>
          <button type="button" onClick={() => setMode('one')} style={modeBtn(mode === 'one', true)}>1人ずつ</button>
          <button type="button" onClick={() => setMode('stack')} style={modeBtn(mode === 'stack', false)}>記載のある人を並べて</button>
        </span>
        <button type="button" onClick={doExcel} disabled={loading || !!loadErr || xlsxBusy || people.length === 0}
          style={{ ...tintBtn(isDark), padding: '5px 12px', borderRadius: 8, fontSize: 13, cursor: loading || xlsxBusy ? 'default' : 'pointer', opacity: loading || !!loadErr || people.length === 0 ? 0.5 : 1 }}>
          {xlsxBusy ? '作っています…' : '📥 この給与期間の表を Excel で出す'}
        </button>
      </div>
      {xlsxErr && <div style={{ fontSize: 12.5, color: isDark ? '#fca5a5' : '#842029', marginBottom: 8 }}>{xlsxErr}</div>}

      {loadErr ? (
        <div style={{ padding: 10, background: isDark ? '#3a1414' : '#fff5f5', border: '1px solid #f5c2c7', borderRadius: 8, color: isDark ? '#fca5a5' : '#842029', fontSize: 13 }}>
          {loadErr} <button type="button" onClick={onReload} style={{ ...backBtn(isDark), padding: '3px 10px', borderRadius: 6, fontSize: 12, marginLeft: 6, cursor: 'pointer' }}>再読み込み</button>
        </div>
      ) : loading ? (
        <p style={{ color: sub, fontSize: 13 }}>読み込み中...</p>
      ) : mode === 'stack' ? (
        stacked.length === 0 ? (
          <p style={{ color: sub, fontSize: 13 }}>この期間に記載のある方はいません</p>
        ) : (
          <>
            <div style={boxStyle}>
              <div ref={nameRef} style={{ position: 'sticky', top: 0, left: 0, zIndex: 5, padding: '8px 12px', background: headBg, borderBottom: `1px solid ${border}`, color: text, fontSize: 13 }}>
                記載のある方 <b>{stacked.length}人</b>（従業員番号の順・記載のある日だけ）
              </div>
              {table(stacked.map(({ p, s }) => (
                <React.Fragment key={p.id}>
                  <tr>
                    <td colSpan={cols.length} style={{ padding: 0, borderTop: `2px solid ${border}`, background: bandBg }}>
                      <div style={{ position: 'sticky', left: 0, display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', gap: '2px 14px', padding: '7px 12px', color: text, maxWidth: 'min(100%, 92vw)', boxSizing: 'border-box' }}>
                        <span style={{ fontSize: 12.5, color: sub }}>{p.employee_no ?? '番号なし'}</span>
                        <span style={{ fontSize: 15, fontWeight: 'bold' }}>{p.name}</span>
                        <span style={{ fontSize: 13.5 }}>{totalLine(s, 15)}</span>
                        {s.plannedText && <span style={{ fontSize: 12, color: text }}>{s.plannedText}</span>}
                        {s.absenceDays > 0 && <span style={{ fontSize: 12, color: sub }}>欠勤 {s.absenceDays}日</span>}
                        {s.pendingText && <span style={{ fontSize: 12, color: '#856404' }}>確認待ちあり</span>}
                      </div>
                    </td>
                  </tr>
                  {daysWithEntries(s.days).map(d => dayRows(d, p.id))}
                </React.Fragment>
              )))}
            </div>
            <div style={{ fontSize: 11.5, color: sub, marginTop: 6 }}>
              合計は人ごとの帯に出ています（{stacked[0].s.totalNote}）。見出しの境目をつまんで動かすと、列の幅が変わります。
              {colsChanged && <button type="button" onClick={() => { setCols(DEFAULT_COLS); saveCols(DEFAULT_COLS); }} style={{ ...backBtn(isDark), padding: '2px 10px', borderRadius: 6, fontSize: 11.5, marginLeft: 8, cursor: 'pointer' }}>列の幅を元に戻す</button>}
            </div>
          </>
        )
      ) : !person || !sheet ? (
        <p style={{ color: sub, fontSize: 13 }}>この期間に表示できる方がいません</p>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
            <button type="button" onClick={() => go(-1)} disabled={idx === 0} style={navBtn(idx === 0)}>◀ 前の人</button>
            <SearchableSelect value={person.id} isDarkMode={isDark} onChange={v => { if (v !== 'all') onPerson(v); }}
              options={people.map(p => [p.id, `${p.employee_no ?? '番号なし'} ${p.name}`] as [string, string])} />
            <button type="button" onClick={() => go(1)} disabled={idx >= people.length - 1} style={navBtn(idx >= people.length - 1)}>次の人 ▶</button>
            <span style={{ fontSize: 12, color: sub }}>{idx + 1} / {people.length}人（←→ キーでも移れます）</span>
          </div>

          {!person.employee_no && (
            <div style={{ fontSize: 12, color: sub, marginBottom: 6 }}>従業員番号が登録されていない方です（管理画面の「👤 ユーザー」で登録できます）</div>
          )}
          {sheet.pendingText && (
            <div style={{ fontSize: 13, color: '#856404', background: '#fff3cd', border: '1px solid #ffc107', borderRadius: 6, padding: '6px 12px', marginBottom: 8 }}>{sheet.pendingText}</div>
          )}
          {sheet.emptyText && <div style={{ fontSize: 12.5, color: sub, marginBottom: 6 }}>{sheet.emptyText}</div>}

          <div style={boxStyle}>
            <div ref={nameRef} style={{ position: 'sticky', top: 0, left: 0, zIndex: 5, display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', gap: '4px 16px', padding: '8px 12px', background: bandBg, borderBottom: `1px solid ${border}`, color: text }}>
              <span style={{ fontSize: 13, color: sub }}>{person.employee_no ?? '番号なし'}</span>
              <span style={{ fontSize: 16, fontWeight: 'bold' }}>{person.name}</span>
              <span style={{ marginLeft: 'auto', fontSize: 14 }}>{totalLine(sheet, 17)}</span>
              {sheet.plannedText && <span style={{ width: '100%', fontSize: 12.5, color: text, textAlign: 'right' }}>{sheet.plannedText}</span>}
              <span style={{ width: '100%', fontSize: 11.5, color: sub, textAlign: 'right' }}>{sheet.totalNote}{sheet.absenceDays > 0 ? `／欠勤 ${sheet.absenceDays}日` : ''}</span>
            </div>
            {table(sheet.days.map(d => dayRows(d, person.id)))}
          </div>
          <div style={{ fontSize: 11.5, color: sub, marginTop: 6 }}>
            行を押すと色が付きます（もう一度押すと消えます）。理由が長いときは、押すと全文が出ます。見出しの境目をつまんで動かすと、列の幅が変わります。
            {colsChanged && <button type="button" onClick={() => { setCols(DEFAULT_COLS); saveCols(DEFAULT_COLS); }} style={{ ...backBtn(isDark), padding: '2px 10px', borderRadius: 6, fontSize: 11.5, marginLeft: 8, cursor: 'pointer' }}>列の幅を元に戻す</button>}
          </div>
        </>
      )}
    </div>
  );
};

export default PayrollSheetView;

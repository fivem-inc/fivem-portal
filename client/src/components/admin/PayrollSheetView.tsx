import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import SearchableSelect from '../common/SearchableSelect';
import { backBtn } from '../../lib/buttonStyles';
import { payMonthLabel, payPeriodLabel, payPeriodEnd } from '../../lib/breakCalc';
import { onRowPick, pickedRowBg } from '../../lib/rowPick';
import { SHEET_DOW, dowOf, sheetMd, sheetHm, type SheetDay, type SheetPerson } from '../../lib/payrollSheet';

/**
 * 給与計算用の［表で見る］の見た目（残業・勤務変更で共用・2026-10-21 ユーザー確定）。
 * 元のスプレッドシートと同じ形：1人ずつ・給与の期の1日1行・従業員番号の順。［◀ 前の人］［次の人 ▶］・←→ キー・名前／番号で探す。
 * 行を押すと薄い青（1行だけ）。理由が長いときは2行で切り、押すと全文
 * 🚨 データの作り方（合計・灰色にする行など）は呼ぶ側。この部品は見せるだけ
 */
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
  /** 合計（呼ぶ側が計算した数字。行の足し算ではない） */
  total: number | null;
  totalNote: string;
  /** 見込み（確認待ち・実績報告待ちも足した時間）の1行。無ければ null（2026-10-21 ユーザー指示：残業の画面と同じく見込みも出す） */
  plannedText: string | null;
  absenceDays: number;
  pendingText: string | null;
  emptyText: string | null;
  days: SheetDay[];
}> = ({ isDarkMode, onBack, periodOptions, period, onPeriod, loading, loadErr, onReload, people, personId, onPerson, total, totalNote, plannedText, absenceDays, pendingText, emptyText, days }) => {
  const isDark = isDarkMode;
  const text = isDark ? '#e9ecef' : '#212529';
  const sub = isDark ? '#adb5bd' : '#6c757d';
  const border = isDark ? '#495057' : '#dee2e6';
  const headBg = isDark ? '#343a40' : '#f6f6f6';
  const cardBg = isDark ? '#212529' : '#fff';
  const gray = isDark ? '#8a929a' : '#9aa0a6';

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
  useEffect(() => { setPicked(null); setOpenReason(new Set()); }, [personId, period]);

  const idx = Math.max(0, people.findIndex(p => p.id === personId));
  const person = people[idx] ?? null;
  const go = useCallback((d: number) => { const n = people[idx + d]; if (n) onPerson(n.id); }, [people, idx, onPerson]);
  // ←／→ で前の人・次の人（探す欄・期の選択に入力しているときは動かさない）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target;
      if (t instanceof Element && t.closest('input, select, textarea')) return;
      if (e.key === 'ArrowLeft') go(-1);
      if (e.key === 'ArrowRight') go(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go]);

  const sel: React.CSSProperties = { padding: '5px 10px', borderRadius: 8, border: `1px solid ${isDark ? '#6c757d' : '#ccc'}`, background: isDark ? '#495057' : '#fff', color: text, fontSize: 13 };
  const navBtn = (disabled: boolean): React.CSSProperties => ({ ...backBtn(isDark), padding: '5px 12px', borderRadius: 8, fontSize: 13, cursor: disabled ? 'default' : 'pointer', color: disabled ? gray : undefined });
  const th: React.CSSProperties = { padding: '6px 4px', border: `1px solid ${border}`, background: headBg, color: text, fontWeight: 'normal', fontSize: 12, whiteSpace: 'nowrap' };
  const td: React.CSSProperties = { padding: '6px 6px', borderLeft: `1px solid ${border}`, fontSize: 12.5, color: text, verticalAlign: 'top' };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        <button type="button" onClick={onBack} style={{ ...backBtn(isDark), padding: '6px 14px', borderRadius: 8, fontSize: 13, cursor: 'pointer' }}>← 一覧に戻る</button>
        <select value={period} onChange={e => onPeriod(e.target.value)} style={sel}>
          {periodOptions.map(p => <option key={p} value={p}>{payPeriodEnd(p).slice(0, 4)}年{payMonthLabel(p)}（{payPeriodLabel(p)}）</option>)}
        </select>
      </div>

      {loadErr ? (
        <div style={{ padding: 10, background: isDark ? '#3a1414' : '#fff5f5', border: '1px solid #f5c2c7', borderRadius: 8, color: isDark ? '#fca5a5' : '#842029', fontSize: 13 }}>
          {loadErr} <button type="button" onClick={onReload} style={{ ...backBtn(isDark), padding: '3px 10px', borderRadius: 6, fontSize: 12, marginLeft: 6, cursor: 'pointer' }}>再読み込み</button>
        </div>
      ) : loading ? (
        <p style={{ color: sub, fontSize: 13 }}>読み込み中...</p>
      ) : !person ? (
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
          {pendingText && (
            <div style={{ fontSize: 13, color: '#856404', background: '#fff3cd', border: '1px solid #ffc107', borderRadius: 6, padding: '6px 12px', marginBottom: 8 }}>{pendingText}</div>
          )}
          {emptyText && <div style={{ fontSize: 12.5, color: sub, marginBottom: 6 }}>{emptyText}</div>}

          <div style={{ overflow: 'auto', maxHeight: 'calc(100dvh - 90px)', minHeight: 320, border: `1px solid ${border}`, borderRadius: 8, background: cardBg }}>
            <div ref={nameRef} style={{ position: 'sticky', top: 0, left: 0, zIndex: 5, display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', gap: '4px 16px', padding: '8px 12px', background: isDark ? '#3a2a33' : '#fde8ee', borderBottom: `1px solid ${border}`, color: text }}>
              <span style={{ fontSize: 13, color: sub }}>{person.employee_no ?? '番号なし'}</span>
              <span style={{ fontSize: 16, fontWeight: 'bold' }}>{person.name}</span>
              <span style={{ marginLeft: 'auto', fontSize: 14 }}>
                合計時間 → <b style={{ fontSize: 17, color: total != null && total < 0 ? '#c62828' : text }}>{total == null ? '—' : sheetHm(total)}</b>
              </span>
              {plannedText && <span style={{ width: '100%', fontSize: 12.5, color: text, textAlign: 'right' }}>{plannedText}</span>}
              <span style={{ width: '100%', fontSize: 11.5, color: sub, textAlign: 'right' }}>{totalNote}{absenceDays > 0 ? `／欠勤 ${absenceDays}日` : ''}</span>
            </div>
            <table style={{ borderCollapse: 'separate', borderSpacing: 0, width: '100%', minWidth: 780, tableLayout: 'fixed' }}>
              <colgroup>
                <col style={{ width: 52 }} /><col style={{ width: 32 }} /><col style={{ width: 110 }} /><col style={{ width: 92 }} />
                <col style={{ width: 120 }} /><col style={{ width: 72 }} /><col /><col style={{ width: 120 }} />
              </colgroup>
              <thead>
                <tr>
                  <th style={{ ...th, position: 'sticky', top: nameH, left: 0, zIndex: 4 }}>日付</th>
                  <th style={{ ...th, position: 'sticky', top: nameH, left: 52, zIndex: 4 }}></th>
                  <th style={{ ...th, position: 'sticky', top: nameH, zIndex: 3 }}>通常シフト時間</th>
                  <th style={{ ...th, position: 'sticky', top: nameH, zIndex: 3 }}>労働時間(休憩)</th>
                  <th style={{ ...th, position: 'sticky', top: nameH, zIndex: 3 }}>変更(実務)シフト時間</th>
                  <th style={{ ...th, position: 'sticky', top: nameH, zIndex: 3 }}>時間数</th>
                  <th style={{ ...th, position: 'sticky', top: nameH, zIndex: 3 }}>理由</th>
                  <th style={{ ...th, position: 'sticky', top: nameH, zIndex: 3 }}>確認サイン</th>
                </tr>
              </thead>
              <tbody>
                {days.map(day => {
                  const dw = dowOf(day.date);
                  const dayColor = dw === 6 ? (isDark ? '#8fc5f6' : '#1565c0') : dw === 0 ? (isDark ? '#f1aeb5' : '#c62828') : text;
                  const entries = day.entries.length ? day.entries : [{ key: 'none', reason: '', sign: '', actual: '', time: '', muted: false, strike: false }];
                  return entries.map((en, i) => {
                    const rowKey = `${day.date}|${en.key}`;
                    const rowBg = picked === rowKey ? pickedRowBg(isDark) : cardBg;
                    const first = i === 0;
                    const c = (extra?: React.CSSProperties): React.CSSProperties => ({ ...td, borderTop: first ? `1px solid ${border}` : `1px dotted ${border}`, background: rowBg, ...extra });
                    const mutedColor = en.muted ? gray : text;
                    const reasonOpen = openReason.has(rowKey);
                    const hasNs = day.nsLines.length > 0;
                    return (
                      <tr key={rowKey} onClick={e => onRowPick(e, rowKey, picked, setPicked)} style={{ cursor: 'pointer' }}>
                        <td style={c({ position: 'sticky', left: 0, zIndex: 1, textAlign: 'center', color: dayColor, borderLeft: 'none' })}>{first ? sheetMd(day.date) : ''}</td>
                        <td style={c({ position: 'sticky', left: 52, zIndex: 1, textAlign: 'center', color: dayColor })}>{first ? SHEET_DOW[dw] : ''}</td>
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
                })}
              </tbody>
            </table>
          </div>
          <div style={{ fontSize: 11.5, color: sub, marginTop: 6 }}>
            行を押すと色が付きます（もう一度押すと消えます）。理由が長いときは、押すと全文が出ます。
          </div>
        </>
      )}
    </div>
  );
};

export default PayrollSheetView;

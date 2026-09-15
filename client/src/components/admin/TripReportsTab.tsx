import React, { useState } from 'react';
import { useAdminPanel } from './AdminPanelContext';
// 種別の色・区分ラベル・次回予定の書式は lib/tripReportDisplay.ts に集約している。
// スタッフ側の履歴タブ（BusinessTripReport.tsx）と同じ報告を表示するため、
// ここに直接書くと必ず食い違う（過去に種別ラベルの二重定義で管理画面が真っ白になった）
import { tripTypeColor, tripCategoryLabel, formatTripNextDates } from '../../lib/tripReportDisplay';
import { payMonthLabel, payPeriodLabel, todayJstStr } from '../../lib/breakCalc';
import {
  TRIP_DAY_HEADERS, TRIP_LIST_HEADERS, tripDayRows, tripListRows, tripNextDate, tripPeriodOptions, tripPeriodRange,
  type TripPeriodMode,
} from '../../lib/tripReportExport';
import type { BusinessTripReport } from '../../types';

const TripReportsTab: React.FC = () => {
  const ctx = useAdminPanel();
  const { isDarkMode, tripReports, loadingTripReports, expandedTripYearMonths, setExpandedTripYearMonths, tripReportFilter, setTripReportFilter, setShowLocationEditor, fetchTripReports, fetchLocationEditor, supabase, setErrorMsg } = ctx;
  const [confirmDialog, setConfirmDialog] = useState<{ message: string; onConfirm: () => void } | null>(null); // 共通インライン確認（confirm廃止）

  // 区分・報告者・場所での絞り込み
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [reporterFilter, setReporterFilter] = useState<string>('all');
  const [locationFilter, setLocationFilter] = useState<string>('all');

  // Excel出力（2026-09-15・ユーザー依頼）。期間は報告した日で絞る：給与期間／月／カスタム。今の絞り込みを効かせるか選べる
  const today = todayJstStr();
  const periodOpts = tripPeriodOptions(tripReports, today);
  const [showExport, setShowExport] = useState(false);
  const [exMode, setExMode] = useState<TripPeriodMode>('payperiod');
  const [exPayPeriod, setExPayPeriod] = useState('');
  const [exMonth, setExMonth] = useState('');
  const [exFrom, setExFrom] = useState('');
  const [exTo, setExTo] = useState('');
  const [exUseFilters, setExUseFilters] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [exErr, setExErr] = useState('');

  // 🚨 一覧と Excel の両方がこの1つの絞り込みを使う（2か所に書かない）
  const matchesFilters = (r: BusinessTripReport) => {
    if (tripReportFilter !== 'all' && r.report_type !== tripReportFilter) return false;
    if (categoryFilter !== 'all' && r.category !== categoryFilter) return false;
    if (reporterFilter !== 'all' && (r.profiles?.name || r.profiles?.email || '不明') !== reporterFilter) return false;
    if (locationFilter !== 'all' && r.location !== locationFilter) return false;
    return true;
  };
  const filterParts = [
    tripReportFilter !== 'all' ? `種別：${tripReportFilter}` : '',
    reporterFilter !== 'all' ? `報告者：${reporterFilter}` : '',
    categoryFilter !== 'all' ? `区分：${categoryFilter}` : '',
    locationFilter !== 'all' ? `場所：${locationFilter}` : '',
  ].filter(Boolean);

  const openExport = () => {
    setExPayPeriod(periodOpts.payperiods[0] ?? '');
    setExMonth(periodOpts.months[0] ?? '');
    setExErr(''); setExUseFilters(true); setShowExport(true);
  };

  const doExport = async () => {
    if (exMode === 'custom' && (!exFrom || !exTo || exFrom > exTo)) { setExErr('開始日と終了日を入れてください（開始日は終了日より前）'); return; }
    const [from, to] = tripPeriodRange(exMode, exMode === 'payperiod' ? exPayPeriod : exMonth, exFrom, exTo);
    setExporting(true); setExErr('');
    // 🚨 画面に読み込んだ一覧ではなく、期間で読み直す（件数が増えても欠けないように）
    const { data, error } = await supabase.from('business_trip_reports').select('*, profiles(name, email)')
      .gte('created_at', `${from}T00:00:00+09:00`).lt('created_at', `${tripNextDate(to)}T00:00:00+09:00`)
      .order('created_at').limit(10000);
    if (error) { setExporting(false); setExErr(`出張報告を読み込めませんでした：${error.message}`); return; }
    const all = (data ?? []) as BusinessTripReport[];
    const useFilters = exUseFilters && filterParts.length > 0;
    const rows = useFilters ? all.filter(matchesFilters) : all;
    if (rows.length === 0) { setExporting(false); setExErr('この期間（と絞り込み）に出せる報告はありません'); return; }
    const periodName = exMode === 'payperiod' ? `${payMonthLabel(from)}（${payPeriodLabel(from)}）`
      : exMode === 'month' ? `${Number(from.slice(0, 4))}年${Number(from.slice(5, 7))}月` : `${from}〜${to}`;
    try {
      // xlsx は重いので押されたときだけ読み込む（残業の Excel 出力と同じ）
      const XLSX = await import('xlsx');
      const sheet = (headers: string[], body: (string | number)[][], formats: Record<number, string>, widths: number[]) => {
        const ws = XLSX.utils.aoa_to_sheet([headers, ...body]);
        for (let row = 1; row <= body.length; row++) {
          for (const [col, z] of Object.entries(formats)) {
            const cell = ws[XLSX.utils.encode_cell({ r: row, c: Number(col) })];
            if (cell && typeof cell.v === 'number') cell.z = z;
          }
        }
        ws['!cols'] = widths.map(wch => ({ wch }));
        return ws;
      };
      const list = tripListRows(rows);
      const listWs = sheet(TRIP_LIST_HEADERS, list, { 0: 'yyyy/m/d', 1: 'h:mm' }, [11, 7, 14, 6, 16, 22, 30, 36, 14, 22]);
      // 地図の列は押すと Google マップが開くリンクにする
      list.forEach((r, i) => {
        const cell = listWs[XLSX.utils.encode_cell({ r: i + 1, c: 8 })];
        if (cell && typeof r[8] === 'string' && r[8]) { cell.l = { Target: r[8] }; cell.v = '地図を開く'; }
      });
      const dayWs = sheet(TRIP_DAY_HEADERS, tripDayRows(rows), { 0: 'yyyy/m/d', 4: 'h:mm', 5: 'h:mm', 6: '[h]:mm' }, [11, 14, 16, 26, 7, 7, 7, 8, 28]);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, listWs, '報告一覧');
      XLSX.utils.book_append_sheet(wb, dayWs, '日ごと');
      const suffix = useFilters ? `_${filterParts.map(p => p.split('：')[1]).join('_')}` : '';
      XLSX.writeFile(wb, `出張報告_${periodName}${suffix}.xlsx`.replace(/[\\/:*?"<>|]/g, ''));
      setShowExport(false);
    } catch (e) {
      setExErr('Excelファイルを作成できませんでした：' + (e instanceof Error ? e.message : String(e)));
    }
    setExporting(false);
  };

  // ドロップダウン用の一覧（重複なし）
  const categoryOptions = Array.from(new Set(
    tripReports.map(r => r.category).filter(Boolean)
  )).sort();
  const reporterOptions = Array.from(new Set(
    tripReports.map(r => r.profiles?.name || r.profiles?.email || '不明')
  )).sort();
  const locationOptions = Array.from(new Set(
    tripReports.map(r => r.location).filter(Boolean)
  )).sort();

  const selectStyle: React.CSSProperties = {
    padding: '6px 10px', borderRadius: 8,
    border: isDarkMode ? '1px solid #666' : '1px solid #ccc',
    background: isDarkMode ? '#343a40' : '#fff',
    color: isDarkMode ? '#fff' : '#333', fontSize: 13, cursor: 'pointer',
  };

  return (
          <div>
            {confirmDialog && (
              <div style={{ position: 'fixed', inset: 0, zIndex: 5000, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }} onClick={() => setConfirmDialog(null)}>
                <div onClick={e => e.stopPropagation()} style={{ background: isDarkMode ? '#343a40' : 'white', borderRadius: 12, padding: '22px 24px', boxShadow: '0 4px 20px rgba(0,0,0,0.25)', maxWidth: 360, width: '100%' }}>
                  <p style={{ fontSize: 15, fontWeight: 'bold', color: isDarkMode ? '#fff' : '#333', margin: '0 0 18px', lineHeight: 1.6, whiteSpace: 'pre-line' }}>{confirmDialog.message}</p>
                  <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                    <button onClick={() => setConfirmDialog(null)} style={{ padding: '8px 18px', background: 'transparent', color: isDarkMode ? '#adb5bd' : '#666', border: `1px solid ${isDarkMode ? '#6c757d' : '#ccc'}`, borderRadius: 8, cursor: 'pointer', fontSize: 14 }}>キャンセル</button>
                    <button onClick={() => { const cb = confirmDialog.onConfirm; setConfirmDialog(null); cb(); }} style={{ padding: '8px 18px', background: '#dc3545', color: 'white', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 'bold', fontSize: 14 }}>削除する</button>
                  </div>
                </div>
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 30 }}>
              <div style={{ flex: 1 }} />
              <h3 style={{ margin: 0, color: isDarkMode ? '#fff' : '#000', textAlign: 'center' }}>📍 出張報告一覧</h3>
              <div style={{ flex: 1, display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
                <button onClick={openExport}
                  style={{ padding: '6px 14px', borderRadius: 8, border: 'none', background: '#28a745', color: '#fff', fontSize: 13, fontWeight: 'bold', cursor: 'pointer' }}>
                  📥 Excel出力
                </button>
                <button
                  onClick={() => { fetchLocationEditor(); setShowLocationEditor(true); }}
                  style={{ padding: '6px 14px', borderRadius: 6, border: isDarkMode ? '1px solid #666' : '1px solid #ccc', background: isDarkMode ? '#495057' : '#f8f9fa', color: isDarkMode ? '#fff' : '#333', cursor: 'pointer', fontSize: 13 }}
                >
                  ⚙️ 区分・行き先リストを管理
                </button>
              </div>
            </div>

            {/* Excel出力（残業・勤務変更の出力と同じ形のモーダル） */}
            {showExport && (() => {
              const t = isDarkMode ? '#fff' : '#333';
              const sub = isDarkMode ? '#adb5bd' : '#666';
              const border = isDarkMode ? '#6c757d' : '#ccc';
              const input: React.CSSProperties = { width: '100%', padding: '8px 10px', borderRadius: 8, border: `1px solid ${border}`, background: isDarkMode ? '#495057' : '#fff', color: t, fontSize: 13, boxSizing: 'border-box', colorScheme: isDarkMode ? 'dark' : 'light' };
              return (
                <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 16px' }}>
                  <div style={{ background: isDarkMode ? '#343a40' : '#fff', borderRadius: 14, padding: 24, width: '100%', maxWidth: 380 }}>
                    <div style={{ fontSize: 15, fontWeight: 'bold', color: t, marginBottom: 6 }}>📥 Excel出力 — 出張報告</div>
                    <div style={{ fontSize: 11.5, color: sub, marginBottom: 14, lineHeight: 1.6 }}>シート「報告一覧」（1報告1行）と「日ごと」（人×日で到着・終了・滞在）の2枚です。報告した日で絞ります。</div>
                    <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
                      {([['payperiod', '給与期間'], ['month', '月'], ['custom', 'カスタム期間']] as const).map(([m, lbl]) => (
                        <button key={m} onClick={() => { setExMode(m); setExErr(''); }}
                          style={{ flex: 1, padding: '7px 0', borderRadius: 8, border: 'none', fontSize: 12, fontWeight: 'bold', cursor: 'pointer', background: exMode === m ? '#007bff' : (isDarkMode ? '#495057' : '#e9ecef'), color: exMode === m ? '#fff' : t }}>
                          {lbl}
                        </button>
                      ))}
                    </div>
                    {exMode === 'payperiod' && (
                      <div>
                        <label style={{ fontSize: 12, color: sub, display: 'block', marginBottom: 6 }}>給与期間（16日〜翌15日）</label>
                        <select value={exPayPeriod} onChange={e => setExPayPeriod(e.target.value)} style={input}>
                          {periodOpts.payperiods.map(p => <option key={p} value={p}>{payMonthLabel(p)}（{payPeriodLabel(p)}）</option>)}
                        </select>
                      </div>
                    )}
                    {exMode === 'month' && (
                      <div>
                        <label style={{ fontSize: 12, color: sub, display: 'block', marginBottom: 6 }}>月（1日〜末日）</label>
                        <select value={exMonth} onChange={e => setExMonth(e.target.value)} style={input}>
                          {periodOpts.months.map(m => <option key={m} value={m}>{Number(m.slice(0, 4))}年{Number(m.slice(5, 7))}月</option>)}
                        </select>
                      </div>
                    )}
                    {exMode === 'custom' && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                        <div>
                          <label style={{ fontSize: 12, color: sub, display: 'block', marginBottom: 4 }}>報告日（開始）</label>
                          <input type="date" value={exFrom} onChange={e => { setExFrom(e.target.value); setExErr(''); }} style={input} />
                        </div>
                        <div>
                          <label style={{ fontSize: 12, color: sub, display: 'block', marginBottom: 4 }}>報告日（終了）</label>
                          <input type="date" value={exTo} onChange={e => { setExTo(e.target.value); setExErr(''); }} style={input} />
                        </div>
                      </div>
                    )}
                    {filterParts.length > 0 && (
                      <label style={{ display: 'flex', gap: 6, alignItems: 'flex-start', marginTop: 14, fontSize: 13, color: t, cursor: 'pointer' }}>
                        <input type="checkbox" checked={exUseFilters} onChange={e => setExUseFilters(e.target.checked)} style={{ marginTop: 3 }} />
                        <span>今の絞り込みも効かせる<span style={{ display: 'block', fontSize: 11.5, color: sub }}>{filterParts.join('・')}</span></span>
                      </label>
                    )}
                    {exErr && <div style={{ marginTop: 12, fontSize: 12.5, color: '#dc3545' }}>{exErr}</div>}
                    <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
                      <button onClick={() => setShowExport(false)} disabled={exporting}
                        style={{ flex: 1, padding: 10, borderRadius: 8, border: `1px solid ${border}`, background: 'none', color: sub, fontSize: 14, cursor: 'pointer' }}>
                        閉じる
                      </button>
                      <button onClick={() => void doExport()} disabled={exporting}
                        style={{ flex: 1, padding: 10, borderRadius: 8, border: 'none', background: '#28a745', color: '#fff', fontSize: 14, fontWeight: 'bold', cursor: exporting ? 'default' : 'pointer', opacity: exporting ? 0.6 : 1 }}>
                        {exporting ? '作成中…' : 'ダウンロード'}
                      </button>
                    </div>
                  </div>
                </div>
              );
            })()}

            {/* フィルターボタン */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
              {(['all', '到着', '終了'] as const).map((f) => {
                const label = f === 'all' ? 'すべて' : f;
                const isActive = tripReportFilter === f;
                return (
                  <button key={f} onClick={() => setTripReportFilter(f)}
                    style={{
                      padding: '6px 18px', borderRadius: 20, border: 'none', cursor: 'pointer',
                      fontWeight: isActive ? 'bold' : 'normal', fontSize: 14,
                      background: isActive
                        ? (f === '到着' ? '#17a2b8' : f === '終了' ? '#28a745' : '#007bff')
                        : isDarkMode ? '#495057' : '#e9ecef',
                      color: isActive ? '#fff' : isDarkMode ? '#fff' : '#333',
                    }}>
                    {label}
                  </button>
                );
              })}
            </div>

            {/* 区分・報告者・場所での絞り込み */}
            <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 13, color: isDarkMode ? '#adb5bd' : '#555' }}>📋 区分</span>
                <select value={categoryFilter} onChange={e => setCategoryFilter(e.target.value)} style={selectStyle}>
                  <option value="all">すべて</option>
                  {categoryOptions.map(cat => <option key={cat} value={cat}>{cat}</option>)}
                </select>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 13, color: isDarkMode ? '#adb5bd' : '#555' }}>👤 報告者</span>
                <select value={reporterFilter} onChange={e => setReporterFilter(e.target.value)} style={selectStyle}>
                  <option value="all">すべて</option>
                  {reporterOptions.map(name => <option key={name} value={name}>{name}</option>)}
                </select>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 13, color: isDarkMode ? '#adb5bd' : '#555' }}>📍 場所</span>
                <select value={locationFilter} onChange={e => setLocationFilter(e.target.value)} style={selectStyle}>
                  <option value="all">すべて</option>
                  {locationOptions.map(loc => <option key={loc} value={loc}>{loc}</option>)}
                </select>
              </div>
              {(categoryFilter !== 'all' || reporterFilter !== 'all' || locationFilter !== 'all') && (
                <button onClick={() => { setCategoryFilter('all'); setReporterFilter('all'); setLocationFilter('all'); }}
                  style={{ padding: '5px 12px', borderRadius: 8, border: isDarkMode ? '1px solid #666' : '1px solid #ccc', background: 'none', color: isDarkMode ? '#adb5bd' : '#666', cursor: 'pointer', fontSize: 12 }}>
                  絞り込み解除
                </button>
              )}
            </div>

            {loadingTripReports ? (
              <p style={{ textAlign: 'center', color: isDarkMode ? '#fff' : '#000' }}>読み込み中...</p>
            ) : tripReports.length === 0 ? (
              <p style={{ textAlign: 'center', color: isDarkMode ? '#aaa' : '#666' }}>出張報告はありません</p>
            ) : (() => {
              // フィルタリング（種別 + 区分 + 報告者 + 場所）
              const filtered = tripReports.filter(matchesFilters);

              if (filtered.length === 0) return (
                <p style={{ textAlign: 'center', color: isDarkMode ? '#aaa' : '#666' }}>該当する報告はありません</p>
              );

              // 年月でグループ化
              const now = new Date();
              const currentYearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

              const grouped: Record<string, Record<string, any[]>> = {};
              filtered.forEach(report => {
                const d = new Date(report.created_at || '');
                const year = `${d.getFullYear()}年度`;
                const month = `${String(d.getMonth() + 1).padStart(2, '0')}月`;
                const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
                if (!grouped[year]) grouped[year] = {};
                if (!grouped[year][month]) grouped[year][month] = [];
                grouped[year][month].push({ ...report, _ym: ym });
              });

              return (
                <div>
                  {Object.entries(grouped).map(([year, months]) => (
                    <div key={year} style={{ marginBottom: 12 }}>
                      <div style={{ padding: '10px 16px', background: isDarkMode ? '#495057' : '#e9ecef', borderRadius: 6, fontWeight: 'bold', color: isDarkMode ? '#fff' : '#000', marginBottom: 4 }}>
                        {year}
                      </div>
                      {Object.entries(months).map(([month, reports]) => {
                        const ym = reports[0]._ym;
                        const isCurrentMonth = ym === currentYearMonth;
                        const isOpen = isCurrentMonth || expandedTripYearMonths.has(ym);
                        return (
                          <div key={month} style={{ marginBottom: 4, marginLeft: 16 }}>
                            <div
                              onClick={() => {
                                if (isCurrentMonth) return;
                                setExpandedTripYearMonths(prev => {
                                  const next = new Set(prev);
                                  if (next.has(ym)) next.delete(ym); else next.add(ym);
                                  return next;
                                });
                              }}
                              style={{ padding: '8px 14px', background: isDarkMode ? '#3d4349' : '#f8f9fa', borderRadius: 4, cursor: isCurrentMonth ? 'default' : 'pointer', color: isDarkMode ? '#fff' : '#000', marginBottom: isOpen ? 4 : 0, display: 'flex', justifyContent: 'space-between' }}
                            >
                              <span>{month}（{reports.length}件）</span>
                              <span>{isCurrentMonth ? '▼ 当月' : isOpen ? '▲ 閉じる' : '▶ 開く'}</span>
                            </div>
                            {isOpen && (
                              <div style={{ overflowX: 'auto', marginBottom: 8 }}>
                                <table style={{ width: '100%', borderCollapse: 'collapse', color: isDarkMode ? '#fff' : '#000' }}>
                                  <thead>
                                    <tr style={{ background: isDarkMode ? '#495057' : '#f8f9fa' }}>
                                      {['報告日時', '報告者', '種別', '区分', '場所', '備考', 'GPS・住所', '次回予定', '操作'].map(h => (
                                        <th key={h} style={{ padding: '8px 12px', textAlign: 'left', borderBottom: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, whiteSpace: 'nowrap', color: isDarkMode ? '#fff' : '#000', fontSize: 13 }}>{h}</th>
                                      ))}
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {reports.map((report, i) => {
                                      const date = new Date(report.created_at);
                                      const dateStr = `${date.getFullYear()}/${date.getMonth()+1}/${date.getDate()} ${date.getHours()}:${String(date.getMinutes()).padStart(2,'0')}`;
                                      return (
                                        <tr key={report.id} style={{ background: i % 2 === 0 ? (isDarkMode ? '#343a40' : 'white') : (isDarkMode ? '#3d4349' : '#f8f9fa') }}>
                                          <td style={{ padding: '8px 12px', borderBottom: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, whiteSpace: 'nowrap', fontSize: 13 }}>{dateStr}</td>
                                          <td style={{ padding: '8px 12px', borderBottom: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, fontSize: 13 }}>{report.profiles?.name || report.profiles?.email || '不明'}</td>
                                          <td style={{ padding: '8px 12px', borderBottom: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, fontSize: 13 }}>
                                            <span style={{ display: 'inline-block', padding: '3px 10px', borderRadius: 4, background: tripTypeColor(report.report_type), color: '#fff', fontSize: 12, fontWeight: 'bold', whiteSpace: 'nowrap' }}>
                                              {report.report_type}
                                            </span>
                                          </td>
                                          <td style={{ padding: '8px 12px', borderBottom: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, fontSize: 13 }}>
                                            {tripCategoryLabel(report)}
                                          </td>
                                          <td style={{ padding: '8px 12px', borderBottom: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, fontSize: 13 }}>{report.location}</td>
                                          <td style={{ padding: '8px 12px', borderBottom: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, fontSize: 13 }}>{report.notes || '-'}</td>
                                          <td style={{ padding: '8px 12px', borderBottom: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, fontSize: 12 }}>
                                            {report.latitude ? (
                                              report.address ? (
                                                <a href={`https://www.google.com/maps?q=${report.latitude},${report.longitude}`} target="_blank" rel="noreferrer"
                                                  style={{ color: '#17a2b8', textDecoration: 'underline', wordBreak: 'break-all' }}>
                                                  {report.address}
                                                </a>
                                              ) : (
                                                <a href={`https://www.google.com/maps?q=${report.latitude},${report.longitude}`} target="_blank" rel="noreferrer"
                                                  style={{ color: '#17a2b8' }}>
                                                  地図を開く
                                                </a>
                                              )
                                            ) : '-'}
                                          </td>
                                          <td style={{ padding: '8px 12px', borderBottom: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, fontSize: 12, color: isDarkMode ? '#ccc' : '#555' }}>
                                            {formatTripNextDates(report.next_dates) || '-'}
                                          </td>
                                          <td style={{ padding: '8px 12px', borderBottom: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, fontSize: 13 }}>
                                            <button
                                              onClick={() => {
                                                const reporter = report.profiles?.name || report.profiles?.email || '不明';
                                                const dateStr = new Date(report.created_at).toLocaleString('ja-JP');
                                                setConfirmDialog({ message: `以下の出張報告を削除しますか？\n\n報告者: ${reporter}\n日時: ${dateStr}\n場所: ${report.location}\n\nこの操作は取り消せません。`, onConfirm: async () => {
                                                  const { error } = await supabase
                                                    .from('business_trip_reports')
                                                    .delete()
                                                    .eq('id', report.id);
                                                  if (error) {
                                                    setErrorMsg('⚠️ 削除に失敗しました: ' + error.message);
                                                  } else {
                                                    fetchTripReports();
                                                  }
                                                } });
                                              }}
                                              style={{
                                                padding: '3px 10px',
                                                background: '#dc3545',
                                                color: 'white',
                                                border: 'none',
                                                borderRadius: 4,
                                                cursor: 'pointer',
                                                fontSize: 12
                                              }}
                                            >
                                              削除
                                            </button>
                                          </td>
                                        </tr>
                                      );
                                    })}
                                  </tbody>
                                </table>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </div>
              );
            })()}
          </div>
  );
};

export default TripReportsTab;


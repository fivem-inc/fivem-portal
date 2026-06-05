import React from 'react';
import { useAdminPanel } from './AdminPanelContext';

const TripReportsTab: React.FC = () => {
  const ctx = useAdminPanel();
  const { isDarkMode, tripReports, loadingTripReports, expandedTripYearMonths, setExpandedTripYearMonths, tripReportFilter, setTripReportFilter, setShowLocationEditor, fetchTripReports, fetchLocationEditor, supabase } = ctx;

  return (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 30 }}>
              <div style={{ flex: 1 }} />
              <h3 style={{ margin: 0, color: isDarkMode ? '#fff' : '#000', textAlign: 'center' }}>📍 出張報告一覧</h3>
              <div style={{ flex: 1, display: 'flex', justifyContent: 'flex-end' }}>
                <button
                  onClick={() => { fetchLocationEditor(); setShowLocationEditor(true); }}
                  style={{ padding: '6px 14px', borderRadius: 6, border: isDarkMode ? '1px solid #666' : '1px solid #ccc', background: isDarkMode ? '#495057' : '#f8f9fa', color: isDarkMode ? '#fff' : '#333', cursor: 'pointer', fontSize: 13 }}
                >
                  ⚙️ 区分・勤務先リストを管理
                </button>
              </div>
            </div>

            {/* フィルターボタン */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
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

            {loadingTripReports ? (
              <p style={{ textAlign: 'center', color: isDarkMode ? '#fff' : '#000' }}>読み込み中...</p>
            ) : tripReports.length === 0 ? (
              <p style={{ textAlign: 'center', color: isDarkMode ? '#aaa' : '#666' }}>出張報告はありません</p>
            ) : (() => {
              // フィルタリング
              const filtered = tripReportFilter === 'all'
                ? tripReports
                : tripReports.filter(r => r.report_type === tripReportFilter);

              if (filtered.length === 0) return (
                <p style={{ textAlign: 'center', color: isDarkMode ? '#aaa' : '#666' }}>該当する報告はありません</p>
              );

              // 年月でグループ化
              const now = new Date();
              const currentYearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

              const grouped: Record<string, Record<string, any[]>> = {};
              filtered.forEach(report => {
                const d = new Date(report.created_at);
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
                                      const dateStr = `${date.getFullYear()}/${String(date.getMonth()+1).padStart(2,'0')}/${String(date.getDate()).padStart(2,'0')} ${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`;
                                      return (
                                        <tr key={report.id} style={{ background: i % 2 === 0 ? (isDarkMode ? '#343a40' : 'white') : (isDarkMode ? '#3d4349' : '#f8f9fa') }}>
                                          <td style={{ padding: '8px 12px', borderBottom: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, whiteSpace: 'nowrap', fontSize: 13 }}>{dateStr}</td>
                                          <td style={{ padding: '8px 12px', borderBottom: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, fontSize: 13 }}>{report.profiles?.name || report.profiles?.email || '不明'}</td>
                                          <td style={{ padding: '8px 12px', borderBottom: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, fontSize: 13 }}>
                                            <span style={{ display: 'inline-block', padding: '3px 10px', borderRadius: 4, background: report.report_type === '到着' ? '#17a2b8' : '#28a745', color: '#fff', fontSize: 12, fontWeight: 'bold', whiteSpace: 'nowrap' }}>
                                              {report.report_type}
                                            </span>
                                          </td>
                                          <td style={{ padding: '8px 12px', borderBottom: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, fontSize: 13 }}>
                                            {report.category === 'その他' ? `その他（${report.category_other}）` : report.category}
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
                                            {report.next_dates
                                              ? report.next_dates.split(',').map((d: string) => {
                                                  const dt = new Date(d);
                                                  const wd = ['日','月','火','水','木','金','土'][dt.getDay()];
                                                  return `${dt.getMonth()+1}/${dt.getDate()}（${wd}）`;
                                                }).join('\n')
                                              : '-'}
                                          </td>
                                          <td style={{ padding: '8px 12px', borderBottom: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, fontSize: 13 }}>
                                            <button
                                              onClick={async () => {
                                                const reporter = report.profiles?.name || report.profiles?.email || '不明';
                                                const dateStr = new Date(report.created_at).toLocaleString('ja-JP');
                                                if (!window.confirm(`以下の出張報告を削除しますか？\n\n報告者: ${reporter}\n日時: ${dateStr}\n場所: ${report.location}\n\nこの操作は取り消せません。`)) return;
                                                const { error } = await supabase
                                                  .from('business_trip_reports')
                                                  .delete()
                                                  .eq('id', report.id);
                                                if (error) {
                                                  alert('削除に失敗しました: ' + error.message);
                                                } else {
                                                  fetchTripReports();
                                                }
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


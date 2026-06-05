import React from 'react';
import { useAdminPanel } from './AdminPanelContext';

const TripReportsTab: React.FC = () => {
  const ctx = useAdminPanel();
  const { isDarkMode, tripReports, loadingTripReports, expandedTripYearMonths, setExpandedTripYearMonths, tripReportFilter, setTripReportFilter, showLocationEditor, setShowLocationEditor, tripCategories, locationOptions, newLocationByCategory, setNewLocationByCategory, newCategoryName, setNewCategoryName, renamingCategoryId, setRenamingCategoryId, renamingCategoryValue, setRenamingCategoryValue, fetchTripReports, fetchLocationEditor, handleAddCategory, handleDeleteCategory, handleRenameCategory, handleAddLocation, handleDeleteLocation, supabase } = ctx;

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
                  ⚙️ 区分・場所リストを管理
                </button>
              </div>
            </div>

            {/* 区分・場所リスト管理モーダル */}
            {showLocationEditor && (
              <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2000 }}>
                <div style={{ background: isDarkMode ? '#343a40' : 'white', borderRadius: 12, padding: 28, width: '90%', maxWidth: 500, maxHeight: '85vh', overflowY: 'auto', color: isDarkMode ? '#fff' : '#333' }}>
                  <h3 style={{ marginTop: 0 }}>⚙️ 区分・場所リスト管理</h3>

                  {/* ── 区分の管理 ── */}
                  <div style={{ marginBottom: 24 }}>
                    <div style={{ fontWeight: 'bold', fontSize: 15, marginBottom: 10, borderBottom: isDarkMode ? '1px solid #555' : '1px solid #dee2e6', paddingBottom: 6 }}>
                      区分の管理
                    </div>
                    {tripCategories.map(cat => (
                      <div key={cat.id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                        {renamingCategoryId === cat.id ? (
                          <>
                            <input
                              autoFocus
                              value={renamingCategoryValue}
                              onChange={e => setRenamingCategoryValue(e.target.value)}
                              onKeyDown={e => { if (e.key === 'Enter') handleRenameCategory(cat.id, cat.value); if (e.key === 'Escape') setRenamingCategoryId(null); }}
                              style={{ flex: 1, padding: '5px 8px', borderRadius: 6, border: '2px solid #007bff', background: isDarkMode ? '#495057' : 'white', color: isDarkMode ? '#fff' : '#333', fontSize: 14 }}
                            />
                            <button onClick={() => handleRenameCategory(cat.id, cat.value)}
                              style={{ padding: '4px 10px', background: '#007bff', color: 'white', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>保存</button>
                            <button onClick={() => setRenamingCategoryId(null)}
                              style={{ padding: '4px 10px', background: isDarkMode ? '#555' : '#e9ecef', color: isDarkMode ? '#fff' : '#333', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>取消</button>
                          </>
                        ) : (
                          <>
                            <span style={{ flex: 1, fontSize: 14, padding: '5px 8px', background: isDarkMode ? '#495057' : '#f8f9fa', borderRadius: 6 }}>{cat.value}</span>
                            <button onClick={() => { setRenamingCategoryId(cat.id); setRenamingCategoryValue(cat.value); }}
                              style={{ padding: '4px 10px', background: isDarkMode ? '#555' : '#e9ecef', color: isDarkMode ? '#fff' : '#333', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>名前変更</button>
                            <button onClick={() => handleDeleteCategory(cat.id, cat.value)}
                              style={{ padding: '4px 10px', background: '#dc3545', color: 'white', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>削除</button>
                          </>
                        )}
                      </div>
                    ))}
                    {/* 区分追加 */}
                    <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                      <input
                        type="text"
                        placeholder="新しい区分名を入力"
                        value={newCategoryName}
                        onChange={e => setNewCategoryName(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') handleAddCategory(); }}
                        style={{ flex: 1, padding: '7px 10px', borderRadius: 6, border: isDarkMode ? '1px solid #666' : '1px solid #ccc', background: isDarkMode ? '#495057' : 'white', color: isDarkMode ? '#fff' : '#333', fontSize: 14 }}
                      />
                      <button onClick={handleAddCategory} disabled={!newCategoryName.trim()}
                        style={{ padding: '7px 14px', borderRadius: 6, background: '#28a745', color: 'white', border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: 'bold' }}>
                        ＋追加
                      </button>
                    </div>
                  </div>

                  {/* ── 場所リスト（区分ごと） ── */}
                  {tripCategories.map(cat => {
                    const locKey = `trip_location_${cat.value}`;
                    const items = locationOptions.filter(o => o.category === locKey);
                    const newVal = newLocationByCategory[cat.value] || '';
                    return (
                      <div key={cat.id} style={{ marginBottom: 20 }}>
                        <div style={{ fontWeight: 'bold', fontSize: 14, marginBottom: 8, borderBottom: isDarkMode ? '1px solid #555' : '1px solid #dee2e6', paddingBottom: 5, color: isDarkMode ? '#adb5bd' : '#6c757d' }}>
                          【{cat.value}】の場所リスト
                        </div>
                        {items.length === 0 && (
                          <div style={{ color: isDarkMode ? '#888' : '#999', fontSize: 13, marginBottom: 6 }}>（未登録）</div>
                        )}
                        {items.map(item => (
                          <div key={item.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '5px 10px', marginBottom: 4, background: isDarkMode ? '#495057' : '#f8f9fa', borderRadius: 6 }}>
                            <span style={{ fontSize: 13 }}>{item.value}</span>
                            <button onClick={() => handleDeleteLocation(item.id)}
                              style={{ padding: '2px 8px', background: '#dc3545', color: 'white', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>削除</button>
                          </div>
                        ))}
                        <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                          <input
                            type="text"
                            placeholder={`${cat.value}の場所を追加`}
                            value={newVal}
                            onChange={e => setNewLocationByCategory(prev => ({ ...prev, [cat.value]: e.target.value }))}
                            onKeyDown={e => { if (e.key === 'Enter') handleAddLocation(cat.value); }}
                            style={{ flex: 1, padding: '6px 10px', borderRadius: 6, border: isDarkMode ? '1px solid #666' : '1px solid #ccc', background: isDarkMode ? '#495057' : 'white', color: isDarkMode ? '#fff' : '#333', fontSize: 13 }}
                          />
                          <button onClick={() => handleAddLocation(cat.value)} disabled={!newVal.trim()}
                            style={{ padding: '6px 12px', borderRadius: 6, background: '#007bff', color: 'white', border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 'bold' }}>
                            ＋
                          </button>
                        </div>
                      </div>
                    );
                  })}

                  <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
                    <button onClick={() => setShowLocationEditor(false)}
                      style={{ padding: '8px 20px', borderRadius: 6, border: isDarkMode ? '1px solid #666' : '1px solid #ccc', background: isDarkMode ? '#444' : '#f8f9fa', color: isDarkMode ? '#fff' : '#333', cursor: 'pointer', fontSize: 14 }}>
                      閉じる
                    </button>
                  </div>
                </div>
              </div>
            )}

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


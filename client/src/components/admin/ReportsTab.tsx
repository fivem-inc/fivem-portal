import React from 'react';
import { formatAmount } from '../../utils';
import { useAdminPanel } from './AdminPanelContext';
import type { ReportStats } from '../../types';

const ReportsTab: React.FC = () => {
  const ctx = useAdminPanel();
  const { isDarkMode, reportStats, loadingReports, fetchReportStats } = ctx;

  return (
          <div>
            <h3 style={{ textAlign: 'center', marginBottom: '30px', color: isDarkMode ? '#fff' : '#000' }}>レポート・分析</h3>

            {loadingReports || !reportStats ? (
              <div style={{ textAlign: 'center', padding: '40px' }}>
                <p style={{ color: isDarkMode ? '#fff' : '#000' }}>統計データを計算中...</p>
                <div style={{ margin: '20px 0' }}>
                  <div style={{ 
                    width: '40px', 
                    height: '40px', 
                    border: '4px solid #f3f3f3',
                    borderTop: '4px solid #007bff',
                    borderRadius: '50%',
                    animation: 'spin 1s linear infinite',
                    margin: '0 auto'
                  }}></div>
                </div>
              </div>
            ) : reportStats ? (
              <div>
                {/* ダッシュボード統計 */}
                <div style={{ marginBottom: '40px' }}>
                  <h4 style={{ textAlign: 'center', marginBottom: '20px', color: isDarkMode ? '#fff' : '#000' }}>📊 ダッシュボード</h4>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '20px', marginBottom: '20px' }}>
                    <div style={{ padding: '20px', backgroundColor: isDarkMode ? '#1a3a52' : '#e3f2fd', borderRadius: '8px', textAlign: 'center' }}>
                      <h5 style={{ margin: '0 0 10px 0', color: isDarkMode ? '#64b5f6' : '#1976d2' }}>総申請数</h5>
                      <p style={{ margin: 0, fontSize: '24px', fontWeight: 'bold', color: isDarkMode ? '#fff' : '#000' }}>{reportStats.overview.totalSubmissions}</p>
                    </div>
                    <div style={{ padding: '20px', backgroundColor: isDarkMode ? '#4a3800' : '#fff3e0', borderRadius: '8px', textAlign: 'center' }}>
                      <h5 style={{ margin: '0 0 10px 0', color: isDarkMode ? '#ffb74d' : '#f57c00' }}>申請中</h5>
                      <p style={{ margin: 0, fontSize: '24px', fontWeight: 'bold', color: isDarkMode ? '#fff' : '#000' }}>{reportStats.overview.pendingSubmissions}</p>
                    </div>
                    <div style={{ padding: '20px', backgroundColor: isDarkMode ? '#1b4d1b' : '#e8f5e8', borderRadius: '8px', textAlign: 'center' }}>
                      <h5 style={{ margin: '0 0 10px 0', color: isDarkMode ? '#81c784' : '#388e3c' }}>承認済み</h5>
                      <p style={{ margin: 0, fontSize: '24px', fontWeight: 'bold', color: isDarkMode ? '#fff' : '#000' }}>{reportStats.overview.approvedSubmissions}</p>
                    </div>
                    <div style={{ padding: '20px', backgroundColor: isDarkMode ? '#5a1a1a' : '#ffebee', borderRadius: '8px', textAlign: 'center' }}>
                      <h5 style={{ margin: '0 0 10px 0', color: isDarkMode ? '#e57373' : '#d32f2f' }}>却下</h5>
                      <p style={{ margin: 0, fontSize: '24px', fontWeight: 'bold', color: isDarkMode ? '#fff' : '#000' }}>{reportStats.overview.rejectedSubmissions}</p>
                    </div>
                    <div style={{ padding: '20px', backgroundColor: isDarkMode ? '#4a1a5a' : '#f3e5f5', borderRadius: '8px', textAlign: 'center' }}>
                      <h5 style={{ margin: '0 0 10px 0', color: isDarkMode ? '#ba68c8' : '#7b1fa2' }}>承認率</h5>
                      <p style={{ margin: 0, fontSize: '24px', fontWeight: 'bold', color: isDarkMode ? '#fff' : '#000' }}>{reportStats.overview.approvalRate}%</p>
                    </div>
                  </div>
                </div>

                {/* ユーザー別統計 */}
                <div style={{ marginBottom: '40px' }}>
                  <h4 style={{ textAlign: 'center', marginBottom: '20px', color: isDarkMode ? '#fff' : '#000' }}>👥 ユーザー別統計</h4>
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <thead>
                        <tr style={{ backgroundColor: isDarkMode ? '#495057' : '#f8f9fa' }}>
                          <th style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '12px', textAlign: 'left', color: isDarkMode ? '#fff' : '#000' }}>ユーザー</th>
                          <th style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '12px', textAlign: 'center', color: isDarkMode ? '#fff' : '#000' }}>申請数</th>
                          <th style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '12px', textAlign: 'center', color: isDarkMode ? '#fff' : '#000' }}>承認数</th>
                          <th style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '12px', textAlign: 'center', color: isDarkMode ? '#fff' : '#000' }}>承認率</th>
                          <th style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '12px', textAlign: 'right', color: isDarkMode ? '#fff' : '#000' }}>総額（承認済み）</th>
                        </tr>
                      </thead>
                      <tbody>
                        {reportStats.userStats.map((user: ReportStats['userStats'][0], index: number) => (
                          <tr key={user.email} style={{ backgroundColor: index % 2 === 0 ? (isDarkMode ? '#495057' : '#f8f9fa') : (isDarkMode ? '#343a40' : 'white') }}>
                            <td style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '12px', color: isDarkMode ? '#fff' : '#000' }}>
                              <strong>{user.name}</strong><br />
                              <small style={{ color: isDarkMode ? '#adb5bd' : '#6c757d' }}>{user.email}</small>
                            </td>
                            <td style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '12px', textAlign: 'center', color: isDarkMode ? '#fff' : '#000' }}>
                              {user.totalSubmissions}
                            </td>
                            <td style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '12px', textAlign: 'center', color: isDarkMode ? '#fff' : '#000' }}>
                              {user.approvedSubmissions}
                            </td>
                            <td style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '12px', textAlign: 'center' }}>
                              <span style={{
                                padding: '4px 8px',
                                borderRadius: '4px',
                                backgroundColor: parseFloat(user.approvalRate) >= 80 ? '#d4edda' : parseFloat(user.approvalRate) >= 50 ? '#fff3cd' : '#f8d7da',
                                color: parseFloat(user.approvalRate) >= 80 ? '#155724' : parseFloat(user.approvalRate) >= 50 ? '#856404' : '#721c24',
                                fontSize: '12px',
                                fontWeight: 'bold'
                              }}>
                                {user.approvalRate}%
                              </span>
                            </td>
                            <td style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '12px', textAlign: 'right', fontWeight: 'bold', color: isDarkMode ? '#fff' : '#000' }}>
                              {formatAmount(user.totalAmount.toString())}円
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* 月次レポート */}
                <div style={{ marginBottom: '40px' }}>
                  <h4 style={{ textAlign: 'center', marginBottom: '20px', color: isDarkMode ? '#fff' : '#000' }}>📅 月次レポート</h4>
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <thead>
                        <tr style={{ backgroundColor: isDarkMode ? '#495057' : '#f8f9fa' }}>
                          <th style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '12px', textAlign: 'left', color: isDarkMode ? '#fff' : '#000' }}>月</th>
                          <th style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '12px', textAlign: 'center', color: isDarkMode ? '#fff' : '#000' }}>総申請数</th>
                          <th style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '12px', textAlign: 'center', color: isDarkMode ? '#fff' : '#000' }}>承認</th>
                          <th style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '12px', textAlign: 'center', color: isDarkMode ? '#fff' : '#000' }}>申請中</th>
                          <th style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '12px', textAlign: 'center', color: isDarkMode ? '#fff' : '#000' }}>却下</th>
                          <th style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '12px', textAlign: 'right', color: isDarkMode ? '#fff' : '#000' }}>承認済み総額</th>
                        </tr>
                      </thead>
                      <tbody>
                        {reportStats.monthlyStats.map((month: ReportStats['monthlyStats'][0], index: number) => (
                          <tr key={month.month} style={{ backgroundColor: index % 2 === 0 ? (isDarkMode ? '#495057' : '#f8f9fa') : (isDarkMode ? '#343a40' : 'white') }}>
                            <td style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '12px', fontWeight: 'bold', color: isDarkMode ? '#fff' : '#000' }}>
                              {month.month}
                            </td>
                            <td style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '12px', textAlign: 'center', color: isDarkMode ? '#fff' : '#000' }}>
                              {month.total}
                            </td>
                            <td style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '12px', textAlign: 'center' }}>
                              <span style={{ color: isDarkMode ? '#81c784' : '#28a745', fontWeight: 'bold' }}>{month.approved}</span>
                            </td>
                            <td style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '12px', textAlign: 'center' }}>
                              <span style={{ color: isDarkMode ? '#ffb74d' : '#ffc107', fontWeight: 'bold' }}>{month.pending}</span>
                            </td>
                            <td style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '12px', textAlign: 'center' }}>
                              <span style={{ color: isDarkMode ? '#e57373' : '#dc3545', fontWeight: 'bold' }}>{month.rejected}</span>
                            </td>
                            <td style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '12px', textAlign: 'right', fontWeight: 'bold', color: isDarkMode ? '#fff' : '#000' }}>
                              {formatAmount(month.amount.toString())}円
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                <div style={{ textAlign: 'center', marginTop: '20px' }}>
                  <button 
                    onClick={fetchReportStats}
                    style={{ 
                      padding: '10px 20px', 
                      backgroundColor: '#007bff', 
                      color: 'white', 
                      border: 'none', 
                      borderRadius: '4px',
                      cursor: 'pointer'
                    }}
                  >
                    統計を更新
                  </button>
                </div>
              </div>
            ) : (
              <div style={{ textAlign: 'center' }}>
                <p>統計データを読み込めませんでした。</p>
                <button 
                  onClick={fetchReportStats}
                  style={{ 
                    padding: '10px 20px', 
                    backgroundColor: '#007bff', 
                    color: 'white', 
                    border: 'none', 
                    borderRadius: '4px',
                    cursor: 'pointer'
                  }}
                >
                  再読み込み
                </button>
              </div>
            )}
          </div>
  );
};

export default ReportsTab;


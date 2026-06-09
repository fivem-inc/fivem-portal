import React from 'react';
import { formatAmount } from '../../utils';
import { useAdminPanel } from './AdminPanelContext';
import type { ReportStats } from '../../types';

const thStyle = (isDarkMode: boolean): React.CSSProperties => ({
  border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`,
  padding: '10px',
  textAlign: 'center',
  color: isDarkMode ? '#fff' : '#000',
  backgroundColor: isDarkMode ? '#495057' : '#f8f9fa',
  whiteSpace: 'nowrap',
});
const thLeft = (isDarkMode: boolean): React.CSSProperties => ({ ...thStyle(isDarkMode), textAlign: 'left' });
const thRight = (isDarkMode: boolean): React.CSSProperties => ({ ...thStyle(isDarkMode), textAlign: 'right' });
const td = (isDarkMode: boolean, idx: number): React.CSSProperties => ({
  border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`,
  padding: '10px',
  textAlign: 'center',
  color: isDarkMode ? '#fff' : '#000',
  backgroundColor: idx % 2 === 0 ? (isDarkMode ? '#495057' : '#f8f9fa') : (isDarkMode ? '#343a40' : 'white'),
});
const tdLeft = (isDarkMode: boolean, idx: number): React.CSSProperties => ({ ...td(isDarkMode, idx), textAlign: 'left' });
const tdRight = (isDarkMode: boolean, idx: number): React.CSSProperties => ({ ...td(isDarkMode, idx), textAlign: 'right' });

const Card: React.FC<{ bg: string; labelColor: string; label: string; value: React.ReactNode; isDarkMode: boolean }> = ({ bg, labelColor, label, value, isDarkMode }) => (
  <div style={{ padding: '20px', backgroundColor: bg, borderRadius: '8px', textAlign: 'center' }}>
    <h5 style={{ margin: '0 0 10px 0', color: labelColor, fontSize: '13px' }}>{label}</h5>
    <p style={{ margin: 0, fontSize: '22px', fontWeight: 'bold', color: isDarkMode ? '#fff' : '#000' }}>{value}</p>
  </div>
);

const SectionTitle: React.FC<{ children: React.ReactNode; isDarkMode: boolean }> = ({ children, isDarkMode }) => (
  <h4 style={{ textAlign: 'center', marginBottom: '20px', color: isDarkMode ? '#fff' : '#000' }}>{children}</h4>
);

const ReportsTab: React.FC = () => {
  const ctx = useAdminPanel();
  const { isDarkMode, reportStats, loadingReports, fetchReportStats } = ctx;

  if (loadingReports || !reportStats) {
    return (
      <div>
        <h3 style={{ textAlign: 'center', marginBottom: '30px', color: isDarkMode ? '#fff' : '#000' }}>レポート・分析</h3>
        <div style={{ textAlign: 'center', padding: '40px' }}>
          <p style={{ color: isDarkMode ? '#fff' : '#000' }}>統計データを計算中...</p>
          <div style={{ width: '40px', height: '40px', border: '4px solid #f3f3f3', borderTop: '4px solid #007bff', borderRadius: '50%', animation: 'spin 1s linear infinite', margin: '20px auto' }} />
        </div>
      </div>
    );
  }

  const { overview, userStats, monthlyStats, leaveStats } = reportStats;

  return (
    <div>
      <h3 style={{ textAlign: 'center', marginBottom: '30px', color: isDarkMode ? '#fff' : '#000' }}>レポート・分析</h3>

      {/* ─── 交通費 ダッシュボード ─── */}
      <div style={{ marginBottom: '40px' }}>
        <SectionTitle isDarkMode={isDarkMode}>💴 交通費 ダッシュボード</SectionTitle>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '16px', marginBottom: '16px' }}>
          <Card isDarkMode={isDarkMode} bg={isDarkMode ? '#1a3a52' : '#e3f2fd'} labelColor={isDarkMode ? '#64b5f6' : '#1976d2'} label="総申請数" value={overview.totalSubmissions} />
          <Card isDarkMode={isDarkMode} bg={isDarkMode ? '#4a3800' : '#fff3e0'} labelColor={isDarkMode ? '#ffb74d' : '#f57c00'} label="申請中" value={overview.pendingSubmissions} />
          <Card isDarkMode={isDarkMode} bg={isDarkMode ? '#1b4d1b' : '#e8f5e8'} labelColor={isDarkMode ? '#81c784' : '#388e3c'} label="承認済み" value={overview.approvedSubmissions} />
          <Card isDarkMode={isDarkMode} bg={isDarkMode ? '#5a1a1a' : '#ffebee'} labelColor={isDarkMode ? '#e57373' : '#d32f2f'} label="却下" value={overview.rejectedSubmissions} />
          <Card isDarkMode={isDarkMode} bg={isDarkMode ? '#4a1a5a' : '#f3e5f5'} labelColor={isDarkMode ? '#ba68c8' : '#7b1fa2'} label="承認率" value={`${overview.approvalRate}%`} />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px' }}>
          <Card isDarkMode={isDarkMode} bg={isDarkMode ? '#1a3a3a' : '#e0f7fa'} labelColor={isDarkMode ? '#4dd0e1' : '#00796b'} label="定期 承認済み総額" value={`${formatAmount(overview.regularAmount.toString())}円`} />
          <Card isDarkMode={isDarkMode} bg={isDarkMode ? '#3a2a1a' : '#fff8e1'} labelColor={isDarkMode ? '#ffcc80' : '#ef6c00'} label="その他 承認済み総額" value={`${formatAmount(overview.otherAmount.toString())}円`} />
          <Card isDarkMode={isDarkMode} bg={isDarkMode ? '#1a2a3a' : '#e8eaf6'} labelColor={isDarkMode ? '#7986cb' : '#3949ab'} label="合計 承認済み総額" value={`${formatAmount((overview.regularAmount + overview.otherAmount).toString())}円`} />
        </div>
      </div>

      {/* ─── ユーザー別 交通費統計 ─── */}
      <div style={{ marginBottom: '40px' }}>
        <SectionTitle isDarkMode={isDarkMode}>👥 ユーザー別 交通費統計</SectionTitle>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
            <thead>
              <tr>
                <th style={thLeft(isDarkMode)}>ユーザー</th>
                <th style={thStyle(isDarkMode)}>申請数</th>
                <th style={thStyle(isDarkMode)}>承認数</th>
                <th style={thStyle(isDarkMode)}>承認率</th>
                <th style={thRight(isDarkMode)}>定期（承認済み）</th>
                <th style={thRight(isDarkMode)}>その他（承認済み）</th>
                <th style={thRight(isDarkMode)}>合計（承認済み）</th>
              </tr>
            </thead>
            <tbody>
              {userStats.map((user: ReportStats['userStats'][0], index: number) => (
                <tr key={user.email}>
                  <td style={tdLeft(isDarkMode, index)}>
                    <strong>{user.name}</strong><br />
                    <small style={{ color: isDarkMode ? '#adb5bd' : '#6c757d' }}>{user.email}</small>
                  </td>
                  <td style={td(isDarkMode, index)}>{user.totalSubmissions}</td>
                  <td style={td(isDarkMode, index)}>{user.approvedSubmissions}</td>
                  <td style={td(isDarkMode, index)}>
                    <span style={{
                      padding: '3px 7px', borderRadius: '4px', fontSize: '12px', fontWeight: 'bold',
                      backgroundColor: parseFloat(user.approvalRate) >= 80 ? '#d4edda' : parseFloat(user.approvalRate) >= 50 ? '#fff3cd' : '#f8d7da',
                      color: parseFloat(user.approvalRate) >= 80 ? '#155724' : parseFloat(user.approvalRate) >= 50 ? '#856404' : '#721c24',
                    }}>{user.approvalRate}%</span>
                  </td>
                  <td style={tdRight(isDarkMode, index)}>{formatAmount(user.regularAmount.toString())}円</td>
                  <td style={tdRight(isDarkMode, index)}>{formatAmount(user.otherAmount.toString())}円</td>
                  <td style={{ ...tdRight(isDarkMode, index), fontWeight: 'bold' }}>{formatAmount(user.totalAmount.toString())}円</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ─── 月次 交通費レポート ─── */}
      <div style={{ marginBottom: '40px' }}>
        <SectionTitle isDarkMode={isDarkMode}>📅 月次 交通費レポート</SectionTitle>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
            <thead>
              <tr>
                <th style={thLeft(isDarkMode)}>月</th>
                <th style={thStyle(isDarkMode)}>申請数</th>
                <th style={thStyle(isDarkMode)}>承認</th>
                <th style={thStyle(isDarkMode)}>申請中</th>
                <th style={thStyle(isDarkMode)}>却下</th>
                <th style={thRight(isDarkMode)}>定期（承認済み）</th>
                <th style={thRight(isDarkMode)}>その他（承認済み）</th>
                <th style={thRight(isDarkMode)}>合計（承認済み）</th>
              </tr>
            </thead>
            <tbody>
              {monthlyStats.map((month: ReportStats['monthlyStats'][0], index: number) => (
                <tr key={month.month}>
                  <td style={{ ...tdLeft(isDarkMode, index), fontWeight: 'bold' }}>{month.month}</td>
                  <td style={td(isDarkMode, index)}>{month.total}</td>
                  <td style={td(isDarkMode, index)}><span style={{ color: isDarkMode ? '#81c784' : '#28a745', fontWeight: 'bold' }}>{month.approved}</span></td>
                  <td style={td(isDarkMode, index)}><span style={{ color: isDarkMode ? '#ffb74d' : '#ffc107', fontWeight: 'bold' }}>{month.pending}</span></td>
                  <td style={td(isDarkMode, index)}><span style={{ color: isDarkMode ? '#e57373' : '#dc3545', fontWeight: 'bold' }}>{month.rejected}</span></td>
                  <td style={tdRight(isDarkMode, index)}>{formatAmount(month.regularAmount.toString())}円</td>
                  <td style={tdRight(isDarkMode, index)}>{formatAmount(month.otherAmount.toString())}円</td>
                  <td style={{ ...tdRight(isDarkMode, index), fontWeight: 'bold' }}>{formatAmount(month.amount.toString())}円</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ─── 休暇申請 ─── */}
      <div style={{ marginBottom: '40px' }}>
        <SectionTitle isDarkMode={isDarkMode}>🏖️ 休暇申請 ダッシュボード</SectionTitle>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '16px', marginBottom: '30px' }}>
          <Card isDarkMode={isDarkMode} bg={isDarkMode ? '#1a3a52' : '#e3f2fd'} labelColor={isDarkMode ? '#64b5f6' : '#1976d2'} label="総申請数" value={leaveStats.total} />
          <Card isDarkMode={isDarkMode} bg={isDarkMode ? '#4a3800' : '#fff3e0'} labelColor={isDarkMode ? '#ffb74d' : '#f57c00'} label="申請中" value={leaveStats.pending} />
          <Card isDarkMode={isDarkMode} bg={isDarkMode ? '#1b4d1b' : '#e8f5e8'} labelColor={isDarkMode ? '#81c784' : '#388e3c'} label="承認済み" value={leaveStats.approved} />
          <Card isDarkMode={isDarkMode} bg={isDarkMode ? '#5a1a1a' : '#ffebee'} labelColor={isDarkMode ? '#e57373' : '#d32f2f'} label="却下" value={leaveStats.rejected} />
        </div>

        {leaveStats.userStats.length > 0 && (
          <div style={{ marginBottom: '30px' }}>
            <h5 style={{ textAlign: 'center', marginBottom: '12px', color: isDarkMode ? '#fff' : '#000' }}>👥 ユーザー別 休暇申請</h5>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                <thead>
                  <tr>
                    <th style={thLeft(isDarkMode)}>ユーザー</th>
                    <th style={thStyle(isDarkMode)}>申請数</th>
                    <th style={thStyle(isDarkMode)}>承認数</th>
                    <th style={thStyle(isDarkMode)}>承認率</th>
                  </tr>
                </thead>
                <tbody>
                  {leaveStats.userStats.map((u, i) => (
                    <tr key={u.email}>
                      <td style={tdLeft(isDarkMode, i)}><strong>{u.name}</strong><br /><small style={{ color: isDarkMode ? '#adb5bd' : '#6c757d' }}>{u.email}</small></td>
                      <td style={td(isDarkMode, i)}>{u.total}</td>
                      <td style={td(isDarkMode, i)}>{u.approved}</td>
                      <td style={td(isDarkMode, i)}>
                        <span style={{
                          padding: '3px 7px', borderRadius: '4px', fontSize: '12px', fontWeight: 'bold',
                          backgroundColor: u.total > 0 && (u.approved / u.total) >= 0.8 ? '#d4edda' : u.total > 0 && (u.approved / u.total) >= 0.5 ? '#fff3cd' : '#f8d7da',
                          color: u.total > 0 && (u.approved / u.total) >= 0.8 ? '#155724' : u.total > 0 && (u.approved / u.total) >= 0.5 ? '#856404' : '#721c24',
                        }}>{u.total > 0 ? (u.approved / u.total * 100).toFixed(1) : '0'}%</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {leaveStats.monthlyStats.length > 0 && (
          <div>
            <h5 style={{ textAlign: 'center', marginBottom: '12px', color: isDarkMode ? '#fff' : '#000' }}>📅 月次 休暇申請</h5>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                <thead>
                  <tr>
                    <th style={thLeft(isDarkMode)}>月</th>
                    <th style={thStyle(isDarkMode)}>申請数</th>
                    <th style={thStyle(isDarkMode)}>承認</th>
                    <th style={thStyle(isDarkMode)}>申請中</th>
                    <th style={thStyle(isDarkMode)}>却下</th>
                  </tr>
                </thead>
                <tbody>
                  {leaveStats.monthlyStats.map((m, i) => (
                    <tr key={m.month}>
                      <td style={{ ...tdLeft(isDarkMode, i), fontWeight: 'bold' }}>{m.month}</td>
                      <td style={td(isDarkMode, i)}>{m.total}</td>
                      <td style={td(isDarkMode, i)}><span style={{ color: isDarkMode ? '#81c784' : '#28a745', fontWeight: 'bold' }}>{m.approved}</span></td>
                      <td style={td(isDarkMode, i)}><span style={{ color: isDarkMode ? '#ffb74d' : '#ffc107', fontWeight: 'bold' }}>{m.pending}</span></td>
                      <td style={td(isDarkMode, i)}><span style={{ color: isDarkMode ? '#e57373' : '#dc3545', fontWeight: 'bold' }}>{m.rejected}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      <div style={{ textAlign: 'center', marginTop: '20px' }}>
        <button
          onClick={fetchReportStats}
          style={{ padding: '10px 20px', backgroundColor: '#007bff', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
        >
          統計を更新
        </button>
      </div>
    </div>
  );
};

export default ReportsTab;

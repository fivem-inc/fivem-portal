import React, { useState, useMemo } from 'react';
import { formatAmount } from '../../utils';
import { useAdminPanel } from './AdminPanelContext';

const thStyle = (isDarkMode: boolean): React.CSSProperties => ({
  border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`,
  padding: '10px',
  textAlign: 'center',
  color: isDarkMode ? '#fff' : '#000',
  backgroundColor: isDarkMode ? '#495057' : '#f8f9fa',
  whiteSpace: 'nowrap',
});
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

const selectStyle = (isDarkMode: boolean): React.CSSProperties => ({
  padding: '6px 10px',
  borderRadius: '4px',
  border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`,
  backgroundColor: isDarkMode ? '#343a40' : '#fff',
  color: isDarkMode ? '#fff' : '#000',
  fontSize: '14px',
  cursor: 'pointer',
});

const ReportsTab: React.FC = () => {
  const ctx = useAdminPanel();
  const { isDarkMode, reportStats, loadingReports, fetchReportStats, users } = ctx;

  const [selectedYear, setSelectedYear] = useState(String(new Date().getFullYear()));
  const [selectedMonth, setSelectedMonth] = useState('');
  const [userStatsYear, setUserStatsYear] = useState(String(new Date().getFullYear()));
  const [userStatsMonth, setUserStatsMonth] = useState('');
  const [userStatsOpen, setUserStatsOpen] = useState(false);
  const [neverSubmittedOpen, setNeverSubmittedOpen] = useState(false);
  const [leaveYear, setLeaveYear] = useState(() => {
    const now = new Date(); return String(now.getMonth() + 1 >= 4 ? now.getFullYear() : now.getFullYear() - 1);
  });
  const [leaveMonth, setLeaveMonth] = useState('');
  const [leaveUserStatsOpen, setLeaveUserStatsOpen] = useState(false);

  const availableYears = useMemo(() => {
    if (!reportStats) return [];
    const years = new Set(reportStats.monthlyStats.map(m => m.month.slice(0, 4)));
    return Array.from(years).sort((a, b) => b.localeCompare(a));
  }, [reportStats]);

  const filteredMonthlyStats = useMemo(() => {
    if (!reportStats) return [];
    return reportStats.monthlyStats.filter(m => {
      const [y, mo] = m.month.split('-');
      if (selectedYear && y !== selectedYear) return false;
      if (selectedMonth && mo !== selectedMonth.padStart(2, '0')) return false;
      return true;
    });
  }, [reportStats, selectedYear, selectedMonth]);

  const filteredOverview = useMemo(() => {
    const totalCount = filteredMonthlyStats.reduce((s, m) => s + m.total, 0);
    const approvedCount = filteredMonthlyStats.reduce((s, m) => s + m.approved, 0);
    const pendingCount = filteredMonthlyStats.reduce((s, m) => s + m.pending, 0);
    const rejectedCount = filteredMonthlyStats.reduce((s, m) => s + m.rejected, 0);
    const approvalRate = totalCount > 0 ? (approvedCount / totalCount * 100).toFixed(1) : '0';
    const r = (key: keyof typeof filteredMonthlyStats[0]) => filteredMonthlyStats.reduce((s, m) => s + (m[key] as number), 0);
    return {
      totalCount, approvedCount, pendingCount, rejectedCount, approvalRate,
      approvedAmt: { regular: r('regularAmount'),         oneTime: r('oneTimeAmount'),         businessTrip: r('businessTripAmount'),         other: r('otherAmount') },
      pendingAmt:  { regular: r('pendingRegularAmount'),  oneTime: r('pendingOneTimeAmount'),  businessTrip: r('pendingBusinessTripAmount'),  other: r('pendingOtherAmount') },
      rejectedAmt: { regular: r('rejectedRegularAmount'), oneTime: r('rejectedOneTimeAmount'), businessTrip: r('rejectedBusinessTripAmount'), other: r('rejectedOtherAmount') },
    };
  }, [filteredMonthlyStats]);

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

  const { leaveStats } = reportStats;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '30px' }}>
        <h3 style={{ margin: 0, color: isDarkMode ? '#fff' : '#000' }}>レポート・分析</h3>
        <button
          onClick={fetchReportStats}
          style={{ padding: '8px 16px', backgroundColor: isDarkMode ? '#1a6aaa' : '#007bff', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '13px', whiteSpace: 'nowrap' }}
        >
          ⟳ 最新データに更新
        </button>
      </div>

      {/* ─── 交通費 ダッシュボード ─── */}
      <div style={{ marginBottom: '40px' }}>
        <SectionTitle isDarkMode={isDarkMode}>💴 交通費 ダッシュボード</SectionTitle>

        {/* フィルタ */}
        <div style={{ display: 'flex', gap: '12px', justifyContent: 'center', alignItems: 'center', marginBottom: '20px', flexWrap: 'wrap' }}>
          <select
            style={selectStyle(isDarkMode)}
            value={selectedYear}
            onChange={e => { setSelectedYear(e.target.value); setSelectedMonth(''); }}
          >
            <option value="">全年度</option>
            {availableYears.map(y => <option key={y} value={y}>{y}年</option>)}
          </select>

          <select
            style={{ ...selectStyle(isDarkMode), opacity: selectedYear ? 1 : 0.4, pointerEvents: selectedYear ? 'auto' : 'none' }}
            value={selectedMonth}
            onChange={e => setSelectedMonth(e.target.value)}
            disabled={!selectedYear}
          >
            <option value="">全月</option>
            {Array.from({ length: 12 }, (_, i) => i + 1).map(m => (
              <option key={m} value={String(m)}>{m}月</option>
            ))}
          </select>

          {(selectedYear || selectedMonth) && (
            <button
              onClick={() => { setSelectedYear(''); setSelectedMonth(''); }}
              style={{ padding: '6px 12px', border: 'none', borderRadius: '4px', backgroundColor: isDarkMode ? '#6c757d' : '#e0e0e0', color: isDarkMode ? '#fff' : '#333', cursor: 'pointer', fontSize: '13px' }}
            >
              リセット
            </button>
          )}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '16px', marginBottom: '16px' }}>
          <Card isDarkMode={isDarkMode} bg={isDarkMode ? '#1a3a52' : '#e3f2fd'} labelColor={isDarkMode ? '#64b5f6' : '#1976d2'} label="総申請数" value={filteredOverview.totalCount} />
          <Card isDarkMode={isDarkMode} bg={isDarkMode ? '#4a3800' : '#fff3e0'} labelColor={isDarkMode ? '#ffb74d' : '#f57c00'} label="申請中" value={filteredOverview.pendingCount} />
          <Card isDarkMode={isDarkMode} bg={isDarkMode ? '#1b4d1b' : '#e8f5e8'} labelColor={isDarkMode ? '#81c784' : '#388e3c'} label="承認済み" value={filteredOverview.approvedCount} />
          <Card isDarkMode={isDarkMode} bg={isDarkMode ? '#5a1a1a' : '#ffebee'} labelColor={isDarkMode ? '#e57373' : '#d32f2f'} label="却下" value={filteredOverview.rejectedCount} />
          <Card isDarkMode={isDarkMode} bg={isDarkMode ? '#4a1a5a' : '#f3e5f5'} labelColor={isDarkMode ? '#ba68c8' : '#7b1fa2'} label="承認率" value={`${filteredOverview.approvalRate}%`} />
        </div>
        {(() => {
          const rows = [
            { label: '申請中',   amt: filteredOverview.pendingAmt,  color: isDarkMode ? '#ffb74d' : '#f57c00' },
            { label: '承認済み', amt: filteredOverview.approvedAmt, color: isDarkMode ? '#81c784' : '#388e3c' },
            { label: '却下',     amt: filteredOverview.rejectedAmt, color: isDarkMode ? '#e57373' : '#d32f2f' },
          ];
          const colTotal = (key: keyof typeof filteredOverview.approvedAmt) =>
            rows.reduce((s, r) => s + r.amt[key], 0);
          const rowTotal = (amt: typeof filteredOverview.approvedAmt) =>
            amt.regular + amt.oneTime + amt.businessTrip + amt.other;
          const rowSubtotal = (amt: typeof filteredOverview.approvedAmt) =>
            amt.regular + amt.oneTime;
          const borderTop = `2px solid ${isDarkMode ? '#adb5bd' : '#999'}`;
          const subtotalBg = isDarkMode ? '#3a3500' : '#fffde7';
          return (
            <div style={{ overflowX: 'auto', marginTop: '16px' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                <thead>
                  <tr>
                    <th style={thStyle(isDarkMode)}>ステータス</th>
                    <th style={thStyle(isDarkMode)}>通勤（単発）</th>
                    <th style={thStyle(isDarkMode)}>定期</th>
                    <th style={{ ...thStyle(isDarkMode), backgroundColor: isDarkMode ? '#2a3540' : '#dce8f0' }}>通勤計</th>
                    <th style={thStyle(isDarkMode)}>出張（園指導等）</th>
                    <th style={thStyle(isDarkMode)}>その他</th>
                    <th style={thStyle(isDarkMode)}>合計</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, i) => (
                    <tr key={row.label}>
                      <td style={{ ...td(isDarkMode, i), fontWeight: 'bold', color: row.color }}>{row.label}</td>
                      <td style={tdRight(isDarkMode, i)}>{formatAmount(row.amt.oneTime.toString())}円</td>
                      <td style={tdRight(isDarkMode, i)}>{formatAmount(row.amt.regular.toString())}円</td>
                      <td style={{ ...tdRight(isDarkMode, i), backgroundColor: subtotalBg, fontWeight: 'bold' }}>{formatAmount(rowSubtotal(row.amt).toString())}円</td>
                      <td style={tdRight(isDarkMode, i)}>{formatAmount(row.amt.businessTrip.toString())}円</td>
                      <td style={tdRight(isDarkMode, i)}>{formatAmount(row.amt.other.toString())}円</td>
                      <td style={{ ...tdRight(isDarkMode, i), fontWeight: 'bold' }}>{formatAmount(rowTotal(row.amt).toString())}円</td>
                    </tr>
                  ))}
                  <tr>
                    {(['合計', 'oneTime', 'regular', 'subtotal', 'businessTrip', 'other', 'total'] as const).map((col, ci) => {
                      const base = { ...tdRight(isDarkMode, 1), fontWeight: 'bold', borderTop };
                      if (col === '合計') return <td key={ci} style={{ ...td(isDarkMode, 1), fontWeight: 'bold', borderTop }}>{col}</td>;
                      if (col === 'subtotal') return <td key={ci} style={{ ...base, backgroundColor: subtotalBg }}>{formatAmount((colTotal('regular') + colTotal('oneTime')).toString())}円</td>;
                      if (col === 'total') return <td key={ci} style={base}>{formatAmount((colTotal('regular') + colTotal('oneTime') + colTotal('businessTrip') + colTotal('other')).toString())}円</td>;
                      return <td key={ci} style={base}>{formatAmount(colTotal(col).toString())}円</td>;
                    })}
                  </tr>
                </tbody>
              </table>
            </div>
          );
        })()}
      </div>

      {/* ─── ユーザー別 交通費統計 ─── */}
      <div style={{ marginBottom: '40px' }}>
        <button
          onClick={() => setUserStatsOpen(o => !o)}
          style={{
            width: '100%', cursor: 'pointer', padding: '10px 16px', marginBottom: userStatsOpen ? '16px' : 0,
            background: isDarkMode ? '#2c3e50' : '#f0f4f8',
            border: `1px solid ${isDarkMode ? '#495057' : '#cdd5df'}`,
            borderRadius: userStatsOpen ? '8px 8px 0 0' : '8px',
            transition: 'background 0.2s',
          }}
        >
          <h4 style={{ margin: 0, color: isDarkMode ? '#fff' : '#333', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', fontSize: '15px' }}>
            👥 ユーザー別 交通費統計
            <span style={{ fontSize: '11px', color: isDarkMode ? '#adb5bd' : '#6c757d' }}>{userStatsOpen ? '▲' : '▼'}</span>
          </h4>
        </button>

        {userStatsOpen && (() => {
          const availableUserYears = Object.keys(reportStats.userStatsByYear).sort((a, b) => b.localeCompare(a));
          const mergeEntries = (list: typeof reportStats.userStatsByYear[string][]) =>
            list.flat().reduce((acc, u) => {
              const ex = acc.find(e => e.email === u.email);
              if (ex) { ex.apRegular += u.apRegular; ex.apOneTime += u.apOneTime; ex.apBusinessTrip += u.apBusinessTrip; ex.apOther += u.apOther; ex.approvedCount += u.approvedCount; ex.pendingCount += u.pendingCount; }
              else acc.push({ ...u });
              return acc;
            }, [] as typeof reportStats.userStatsByYear[string])
            .sort((a, b) => (b.apRegular + b.apOneTime + b.apBusinessTrip + b.apOther) - (a.apRegular + a.apOneTime + a.apBusinessTrip + a.apOther));
          const rows = userStatsYear && userStatsMonth
            ? (reportStats.userStatsByYearMonth[userStatsYear]?.[userStatsMonth] || [])
            : userStatsYear
            ? (reportStats.userStatsByYear[userStatsYear] || [])
            : mergeEntries(Object.values(reportStats.userStatsByYear));
          const subtotalBg = isDarkMode ? '#3a3500' : '#fffde7';
          const borderTop = `2px solid ${isDarkMode ? '#adb5bd' : '#999'}`;
          const totals = rows.reduce((acc, u) => ({
            apRegular: acc.apRegular + u.apRegular,
            apOneTime: acc.apOneTime + u.apOneTime,
            apBusinessTrip: acc.apBusinessTrip + u.apBusinessTrip,
            apOther: acc.apOther + u.apOther,
          }), { apRegular: 0, apOneTime: 0, apBusinessTrip: 0, apOther: 0 });

          return (
            <div>
              {/* 年度セレクト */}
              <div style={{ display: 'flex', gap: '12px', justifyContent: 'center', alignItems: 'center', marginBottom: '16px', flexWrap: 'wrap' }}>
                <select style={selectStyle(isDarkMode)} value={userStatsYear} onChange={e => { setUserStatsYear(e.target.value); setUserStatsMonth(''); }}>
                  <option value="">全年度</option>
                  {availableUserYears.map(y => <option key={y} value={y}>{y}年</option>)}
                </select>
                <select style={{ ...selectStyle(isDarkMode), opacity: userStatsYear ? 1 : 0.4, pointerEvents: userStatsYear ? 'auto' : 'none' }} value={userStatsMonth} onChange={e => setUserStatsMonth(e.target.value)} disabled={!userStatsYear}>
                  <option value="">全月</option>
                  {Array.from({ length: 12 }, (_, i) => i + 1).map(m => (
                    <option key={m} value={String(m).padStart(2, '0')}>{m}月</option>
                  ))}
                </select>
                {(userStatsYear || userStatsMonth) && (
                  <button
                    onClick={() => { setUserStatsYear(''); setUserStatsMonth(''); }}
                    style={{ padding: '6px 12px', border: 'none', borderRadius: '4px', backgroundColor: isDarkMode ? '#6c757d' : '#e0e0e0', color: isDarkMode ? '#fff' : '#333', cursor: 'pointer', fontSize: '13px' }}
                  >
                    リセット
                  </button>
                )}
              </div>

              {rows.length === 0 ? (
                <p style={{ textAlign: 'center', color: isDarkMode ? '#adb5bd' : '#6c757d' }}>データがありません</p>
              ) : (
                <div>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                    <thead>
                      <tr>
                        <th style={thStyle(isDarkMode)}>ユーザー</th>
                        <th style={thStyle(isDarkMode)}>承認</th>
                        <th style={thStyle(isDarkMode)}>申請中</th>
                        <th style={thStyle(isDarkMode)}>通勤（単発）</th>
                        <th style={thStyle(isDarkMode)}>定期</th>
                        <th style={{ ...thStyle(isDarkMode), backgroundColor: subtotalBg }}>通勤計</th>
                        <th style={thStyle(isDarkMode)}>出張（園指導等）</th>
                        <th style={thStyle(isDarkMode)}>その他</th>
                        <th style={thStyle(isDarkMode)}>合計</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((u, i) => {
                        const total = u.apRegular + u.apOneTime + u.apBusinessTrip + u.apOther;
                        return (
                          <tr key={u.email}>
                            <td style={tdLeft(isDarkMode, i)}>
                              <strong>{u.name}</strong><br />
                              <small style={{ color: isDarkMode ? '#adb5bd' : '#6c757d' }}>{u.email}</small>
                            </td>
                            <td style={td(isDarkMode, i)}>{u.approvedCount}</td>
                            <td style={td(isDarkMode, i)}>{u.pendingCount}</td>
                            <td style={tdRight(isDarkMode, i)}>{formatAmount(u.apOneTime.toString())}円</td>
                            <td style={tdRight(isDarkMode, i)}>{formatAmount(u.apRegular.toString())}円</td>
                            <td style={{ ...tdRight(isDarkMode, i), backgroundColor: subtotalBg, fontWeight: 'bold' }}>{formatAmount((u.apRegular + u.apOneTime).toString())}円</td>
                            <td style={tdRight(isDarkMode, i)}>{formatAmount(u.apBusinessTrip.toString())}円</td>
                            <td style={tdRight(isDarkMode, i)}>{formatAmount(u.apOther.toString())}円</td>
                            <td style={{ ...tdRight(isDarkMode, i), fontWeight: 'bold' }}>{formatAmount(total.toString())}円</td>
                          </tr>
                        );
                      })}
                      <tr>
                        <td style={{ ...tdLeft(isDarkMode, 1), fontWeight: 'bold', borderTop }} colSpan={3}>合計</td>
                        <td style={{ ...tdRight(isDarkMode, 1), fontWeight: 'bold', borderTop }}>{formatAmount(totals.apOneTime.toString())}円</td>
                        <td style={{ ...tdRight(isDarkMode, 1), fontWeight: 'bold', borderTop }}>{formatAmount(totals.apRegular.toString())}円</td>
                        <td style={{ ...tdRight(isDarkMode, 1), fontWeight: 'bold', borderTop, backgroundColor: subtotalBg }}>{formatAmount((totals.apRegular + totals.apOneTime).toString())}円</td>
                        <td style={{ ...tdRight(isDarkMode, 1), fontWeight: 'bold', borderTop }}>{formatAmount(totals.apBusinessTrip.toString())}円</td>
                        <td style={{ ...tdRight(isDarkMode, 1), fontWeight: 'bold', borderTop }}>{formatAmount(totals.apOther.toString())}円</td>
                        <td style={{ ...tdRight(isDarkMode, 1), fontWeight: 'bold', borderTop }}>{formatAmount((totals.apRegular + totals.apOneTime + totals.apBusinessTrip + totals.apOther).toString())}円</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                {/* 未申請ユーザー */}
                {(() => {
                  const submittedEmails = new Set(
                    userStatsYear
                      ? (reportStats.userStatsByYear[userStatsYear] || []).map(u => u.email)
                      : reportStats.userStats.filter(u => u.totalSubmissions > 0).map(u => u.email)
                  );
                  const notSubmitted = users.filter(u => u.is_active !== false && u.email && !submittedEmails.has(u.email));
                  if (notSubmitted.length === 0) return null;
                  return (
                    <div style={{ marginTop: '16px' }}>
                      <button
                        onClick={() => setNeverSubmittedOpen(o => !o)}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '4px 0', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', color: isDarkMode ? '#adb5bd' : '#6c757d' }}
                      >
                        <span>未申請ユーザー {notSubmitted.length}名　<span style={{ fontSize: '11px', color: isDarkMode ? '#6c757d' : '#999' }}>（{userStatsYear ? `${userStatsYear}年度` : '全年度'}）</span></span>
                        <span style={{ fontSize: '11px' }}>{neverSubmittedOpen ? '▲' : '▼'}</span>
                      </button>
                      {neverSubmittedOpen && (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '8px' }}>
                          {notSubmitted.map(u => (
                            <span key={u.email} style={{
                              padding: '4px 10px', borderRadius: '14px', fontSize: '12px',
                              backgroundColor: isDarkMode ? '#4a3800' : '#fff3cd',
                              color: isDarkMode ? '#ffb74d' : '#856404',
                              border: `1px solid ${isDarkMode ? '#7a5c00' : '#ffc107'}`,
                            }}>
                              {u.name || u.email}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })()}
                  </div>
              )}
            </div>
          );
        })()}
      </div>



      {/* ─── 休暇申請 ─── */}
      <div style={{ marginBottom: '40px' }}>
        <SectionTitle isDarkMode={isDarkMode}>🏖️ 休暇申請 ダッシュボード</SectionTitle>

        {/* 年度フィルタ */}
        {(() => {
          const fyYears = Object.keys(leaveStats.leaveStatsByYear).sort((a, b) => b.localeCompare(a));
          const fyLabel = (fy: string) => `${fy}年度 (${fy}/4/1〜${Number(fy)+1}/3/31)`;
          return (
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'center', alignItems: 'center', marginBottom: '20px', flexWrap: 'wrap' }}>
              <select style={selectStyle(isDarkMode)} value={leaveYear} onChange={e => { setLeaveYear(e.target.value); setLeaveMonth(''); }}>
                <option value="">全年度</option>
                {fyYears.map(fy => <option key={fy} value={fy}>{fyLabel(fy)}</option>)}
              </select>
              <select
                style={{ ...selectStyle(isDarkMode), opacity: leaveYear ? 1 : 0.4, pointerEvents: leaveYear ? 'auto' : 'none' }}
                value={leaveMonth}
                onChange={e => setLeaveMonth(e.target.value)}
                disabled={!leaveYear}
              >
                <option value="">全月</option>
                {Array.from({ length: 12 }, (_, i) => i + 1).map(m => (
                  <option key={m} value={String(m).padStart(2, '0')}>{m}月</option>
                ))}
              </select>
              {(leaveYear || leaveMonth) && (
                <button onClick={() => { setLeaveYear(''); setLeaveMonth(''); }} style={{ padding: '6px 12px', border: 'none', borderRadius: '4px', backgroundColor: isDarkMode ? '#6c757d' : '#e0e0e0', color: isDarkMode ? '#fff' : '#333', cursor: 'pointer', fontSize: '13px' }}>
                  リセット
                </button>
              )}
            </div>
          );
        })()}

        {(() => {
          const lv = leaveYear && leaveMonth
            ? leaveStats.leaveStatsByYearMonth?.[leaveYear]?.[leaveMonth]
            : leaveYear ? leaveStats.leaveStatsByYear[leaveYear] : leaveStats;
          if (!lv) return null;
          return (
            <>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '16px', marginBottom: '30px' }}>
          <Card isDarkMode={isDarkMode} bg={isDarkMode ? '#1a3a52' : '#e3f2fd'} labelColor={isDarkMode ? '#64b5f6' : '#1976d2'} label="総申請数" value={lv.total} />
          <Card isDarkMode={isDarkMode} bg={isDarkMode ? '#4a3800' : '#fff3e0'} labelColor={isDarkMode ? '#ffb74d' : '#f57c00'} label="申請中" value={lv.pending} />
          <Card isDarkMode={isDarkMode} bg={isDarkMode ? '#1b4d1b' : '#e8f5e8'} labelColor={isDarkMode ? '#81c784' : '#388e3c'} label="承認済み" value={lv.approved} />
          <Card isDarkMode={isDarkMode} bg={isDarkMode ? '#5a1a1a' : '#ffebee'} labelColor={isDarkMode ? '#e57373' : '#d32f2f'} label="却下" value={lv.rejected} />
        </div>

        {/* 休暇種別内訳 */}
        {Object.keys(lv.byType).length > 0 && (() => {
          const PAID_TYPES = ['有給休暇', 'バースデー休暇（有給）', 'その他'];
          const OTHER_TYPES = ['慶弔休暇'];
          const COL_LABELS: Record<string, [string, string]> = {
            '有給休暇':           ['有給',      '休暇'],
            'バースデー休暇（有給）': ['バースデー', '休暇'],
            'その他':             ['その他',    '（病欠など）'],
            '慶弔休暇':           ['慶弔',      '休暇'],
          };
          const byType = lv.byType;
          const paidCols = PAID_TYPES.filter(t => byType[t]);
          const otherCols = OTHER_TYPES.filter(t => byType[t]);
          const unknownCols = Object.keys(byType).filter(t => !PAID_TYPES.includes(t) && !OTHER_TYPES.includes(t));
          const allCols = [...paidCols, ...otherCols, ...unknownCols];
          type LeaveKey = 'pending' | 'approved' | 'rejected' | 'total';
          type LeaveDayKey = 'pendingDays' | 'approvedDays' | 'rejectedDays' | 'totalDays';
          const dayKey = (k: LeaveKey): LeaveDayKey => `${k}Days` as LeaveDayKey;
          const get = (type: string, key: LeaveKey) => byType[type]?.[key] ?? 0;
          const getDays = (type: string, key: LeaveKey) => byType[type]?.[dayKey(key)] ?? 0;
          const paidSum = (key: LeaveKey) => paidCols.reduce((s, t) => s + get(t, key), 0);
          const paidSumDays = (key: LeaveKey) => paidCols.reduce((s, t) => s + getDays(t, key), 0);
          const grandSum = (key: LeaveKey) => allCols.reduce((s, t) => s + get(t, key), 0);
          const grandSumDays = (key: LeaveKey) => allCols.reduce((s, t) => s + getDays(t, key), 0);
          const STATUS_ROWS = [
            { key: 'pending'  as const, label: '申請中',   color: isDarkMode ? '#ffb74d' : '#f57c00' },
            { key: 'approved' as const, label: '承認済み', color: isDarkMode ? '#81c784' : '#388e3c' },
            { key: 'rejected' as const, label: '却下',     color: isDarkMode ? '#e57373' : '#d32f2f' },
          ];
          const thN = (isDM: boolean): React.CSSProperties => ({ ...thStyle(isDM), whiteSpace: 'pre-line', lineHeight: '1.3', padding: '6px 8px', minWidth: '52px' });
          const subtotalBgL = isDarkMode ? '#3a3500' : '#fffde7';
          const borderTop = `2px solid ${isDarkMode ? '#adb5bd' : '#999'}`;
          const val = (count: number, days: number) => count > 0
            ? <>{count}件<span style={{ color: isDarkMode ? '#adb5bd' : '#999', margin: '0 3px' }}>|</span>{days}日</>
            : <span>—</span>;
          return (
            <div style={{ marginBottom: '20px', overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                <thead>
                  <tr>
                    <th style={thStyle(isDarkMode)}>ステータス</th>
                    {paidCols.map(t => <th key={t} style={thN(isDarkMode)}>{(COL_LABELS[t] ?? [t, ''])[0]}<br />{(COL_LABELS[t] ?? [t, ''])[1]}</th>)}
                    {paidCols.length > 0 && <th style={{ ...thN(isDarkMode), backgroundColor: subtotalBgL }}>有給{'\n'}小計</th>}
                    {[...otherCols, ...unknownCols].map(t => <th key={t} style={thN(isDarkMode)}>{(COL_LABELS[t] ?? [t, ''])[0]}<br />{(COL_LABELS[t] ?? [t, ''])[1]}</th>)}
                    <th style={thStyle(isDarkMode)}>合計</th>
                  </tr>
                </thead>
                <tbody>
                  {STATUS_ROWS.map((row, i) => (
                    <tr key={row.key}>
                      <td style={{ ...td(isDarkMode, i), fontWeight: 'bold', color: row.color }}>{row.label}</td>
                      {paidCols.map(t => <td key={t} style={td(isDarkMode, i)}>{val(get(t, row.key), getDays(t, row.key))}</td>)}
                      {paidCols.length > 0 && <td style={{ ...td(isDarkMode, i), backgroundColor: subtotalBgL, fontWeight: 'bold' }}>{val(paidSum(row.key), paidSumDays(row.key))}</td>}
                      {[...otherCols, ...unknownCols].map(t => <td key={t} style={td(isDarkMode, i)}>{val(get(t, row.key), getDays(t, row.key))}</td>)}
                      <td style={{ ...td(isDarkMode, i), fontWeight: 'bold' }}>{val(grandSum(row.key), grandSumDays(row.key))}</td>
                    </tr>
                  ))}
                  <tr>
                    <td style={{ ...td(isDarkMode, 1), fontWeight: 'bold', borderTop }}>合計</td>
                    {paidCols.map(t => <td key={t} style={{ ...td(isDarkMode, 1), fontWeight: 'bold', borderTop }}>{val(get(t, 'total'), getDays(t, 'total'))}</td>)}
                    {paidCols.length > 0 && <td style={{ ...td(isDarkMode, 1), backgroundColor: subtotalBgL, fontWeight: 'bold', borderTop }}>{val(paidSum('total'), paidSumDays('total'))}</td>}
                    {[...otherCols, ...unknownCols].map(t => <td key={t} style={{ ...td(isDarkMode, 1), fontWeight: 'bold', borderTop }}>{val(get(t, 'total'), getDays(t, 'total'))}</td>)}
                    <td style={{ ...td(isDarkMode, 1), fontWeight: 'bold', borderTop }}>{val(grandSum('total'), grandSumDays('total'))}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          );
        })()}

        {lv.userStats.length > 0 && (
          <div style={{ marginBottom: '16px' }}>
            <button
              onClick={() => setLeaveUserStatsOpen(o => !o)}
              style={{ width: '100%', cursor: 'pointer', padding: '10px 16px', marginBottom: leaveUserStatsOpen ? '12px' : 0, background: isDarkMode ? '#2c3e50' : '#f0f4f8', border: `1px solid ${isDarkMode ? '#495057' : '#cdd5df'}`, borderRadius: leaveUserStatsOpen ? '8px 8px 0 0' : '8px' }}
            >
              <h5 style={{ margin: 0, color: isDarkMode ? '#fff' : '#333', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', fontSize: '14px' }}>
                👥 ユーザー別 休暇申請
                <span style={{ fontSize: '11px', color: isDarkMode ? '#adb5bd' : '#6c757d' }}>{leaveUserStatsOpen ? '▲' : '▼'}</span>
              </h5>
            </button>
            {leaveUserStatsOpen && (
              <div style={{ textAlign: 'center', padding: '4px 0 12px', fontSize: '12px', color: isDarkMode ? '#adb5bd' : '#6c757d' }}>
                {leaveYear && leaveMonth ? `${leaveYear}年${Number(leaveMonth)}月` : leaveYear ? `${leaveYear}年度 (${leaveYear}/4/1〜${Number(leaveYear)+1}/3/31)` : '全年度'}
              </div>
            )}
            {leaveUserStatsOpen && (() => {
              const PAID_TYPES = ['有給休暇', 'バースデー休暇（有給）', 'その他'];
              const OTHER_TYPES = ['慶弔休暇'];
              const COL_LABELS: Record<string, [string, string]> = {
                '有給休暇':           ['有給',      '休暇'],
                'バースデー休暇（有給）': ['バースデー', '休暇'],
                'その他':             ['その他',    '（病欠など）'],
                '慶弔休暇':           ['慶弔',      '休暇'],
              };
              const allTypes = new Set<string>();
              lv.userStats.forEach(u => Object.keys(u.byType).forEach(t => allTypes.add(t)));
              const paidCols = PAID_TYPES.filter(t => allTypes.has(t));
              const otherCols = OTHER_TYPES.filter(t => allTypes.has(t));
              const unknownCols = [...allTypes].filter(t => !PAID_TYPES.includes(t) && !OTHER_TYPES.includes(t));
              const thN = (isDM: boolean): React.CSSProperties => ({ ...thStyle(isDM), whiteSpace: 'pre-line', lineHeight: '1.3', padding: '6px 8px', minWidth: '52px' });
              const subtotalBgL = isDarkMode ? '#3a3500' : '#fffde7';
              const borderTop = `2px solid ${isDarkMode ? '#adb5bd' : '#999'}`;
              const val = (count: number, days: number) => count > 0
                ? <>{count}件<span style={{ color: isDarkMode ? '#adb5bd' : '#999', margin: '0 3px' }}>|</span>{days}日</>
                : <span>—</span>;
              const get = (u: typeof lv.userStats[0], t: string, k: 'total' | 'approved' | 'pending' | 'rejected') => u.byType[t]?.[k] ?? 0;
              const getDays = (u: typeof lv.userStats[0], t: string, k: 'totalDays' | 'approvedDays' | 'pendingDays' | 'rejectedDays') => u.byType[t]?.[k] ?? 0;
              const paidSum = (u: typeof lv.userStats[0]) => paidCols.reduce((s, t) => s + get(u, t, 'total'), 0);
              const paidSumDays = (u: typeof lv.userStats[0]) => paidCols.reduce((s, t) => s + getDays(u, t, 'totalDays'), 0);
              const colTotal = (t: string, k: 'total' | 'approved' | 'pending' | 'rejected') => lv.userStats.reduce((s, u) => s + get(u, t, k), 0);
              const colTotalDays = (t: string, k: 'totalDays' | 'approvedDays' | 'pendingDays' | 'rejectedDays') => lv.userStats.reduce((s, u) => s + getDays(u, t, k), 0);
              const grandTotal = lv.userStats.reduce((s, u) => s + u.total, 0);
              const grandTotalDays = lv.userStats.reduce((s, u) => s + [...Object.values(u.byType)].reduce((ss, b) => ss + b.totalDays, 0), 0);
              return (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                    <thead>
                      <tr>
                        <th style={thStyle(isDarkMode)}>ユーザー</th>
                        <th style={thStyle(isDarkMode)}>受理</th>
                        <th style={thStyle(isDarkMode)}>申請中</th>
                        {paidCols.map(t => <th key={t} style={thN(isDarkMode)}>{(COL_LABELS[t] ?? [t, ''])[0]}<br />{(COL_LABELS[t] ?? [t, ''])[1]}</th>)}
                        {paidCols.length > 0 && <th style={{ ...thN(isDarkMode), backgroundColor: subtotalBgL }}>有給{'\n'}小計</th>}
                        {[...otherCols, ...unknownCols].map(t => <th key={t} style={thN(isDarkMode)}>{(COL_LABELS[t] ?? [t, ''])[0]}<br />{(COL_LABELS[t] ?? [t, ''])[1]}</th>)}
                        <th style={thStyle(isDarkMode)}>合計</th>
                      </tr>
                    </thead>
                    <tbody>
                      {lv.userStats.map((u, i) => (
                        <tr key={u.email}>
                          <td style={tdLeft(isDarkMode, i)}><strong>{u.name}</strong><br /><small style={{ color: isDarkMode ? '#adb5bd' : '#6c757d' }}>{u.email}</small></td>
                          <td style={td(isDarkMode, i)}><span style={{ color: isDarkMode ? '#81c784' : '#388e3c', fontWeight: 'bold' }}>{u.approved}</span></td>
                          <td style={td(isDarkMode, i)}><span style={{ color: isDarkMode ? '#ffb74d' : '#f57c00', fontWeight: 'bold' }}>{u.pending}</span></td>
                          {paidCols.map(t => <td key={t} style={td(isDarkMode, i)}>{val(get(u, t, 'total'), getDays(u, t, 'totalDays'))}</td>)}
                          {paidCols.length > 0 && <td style={{ ...td(isDarkMode, i), backgroundColor: subtotalBgL, fontWeight: 'bold' }}>{val(paidSum(u), paidSumDays(u))}</td>}
                          {[...otherCols, ...unknownCols].map(t => <td key={t} style={td(isDarkMode, i)}>{val(get(u, t, 'total'), getDays(u, t, 'totalDays'))}</td>)}
                          <td style={{ ...td(isDarkMode, i), fontWeight: 'bold' }}>{val(u.total, [...Object.values(u.byType)].reduce((s, b) => s + b.totalDays, 0))}</td>
                        </tr>
                      ))}
                      <tr>
                        <td style={{ ...tdLeft(isDarkMode, 1), fontWeight: 'bold', borderTop }}>合計</td>
                        <td style={{ ...td(isDarkMode, 1), fontWeight: 'bold', borderTop }}><span style={{ color: isDarkMode ? '#81c784' : '#388e3c' }}>{lv.userStats.reduce((s, u) => s + u.approved, 0)}</span></td>
                        <td style={{ ...td(isDarkMode, 1), fontWeight: 'bold', borderTop }}><span style={{ color: isDarkMode ? '#ffb74d' : '#f57c00' }}>{lv.userStats.reduce((s, u) => s + u.pending, 0)}</span></td>
                        {paidCols.map(t => <td key={t} style={{ ...td(isDarkMode, 1), fontWeight: 'bold', borderTop }}>{val(colTotal(t, 'total'), colTotalDays(t, 'totalDays'))}</td>)}
                        {paidCols.length > 0 && <td style={{ ...td(isDarkMode, 1), backgroundColor: subtotalBgL, fontWeight: 'bold', borderTop }}>{val(paidCols.reduce((s, t) => s + colTotal(t, 'total'), 0), paidCols.reduce((s, t) => s + colTotalDays(t, 'totalDays'), 0))}</td>}
                        {[...otherCols, ...unknownCols].map(t => <td key={t} style={{ ...td(isDarkMode, 1), fontWeight: 'bold', borderTop }}>{val(colTotal(t, 'total'), colTotalDays(t, 'totalDays'))}</td>)}
                        <td style={{ ...td(isDarkMode, 1), fontWeight: 'bold', borderTop }}>{val(grandTotal, grandTotalDays)}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              );
            })()}
          </div>
        )}

            </>
          );
        })()}
      </div>

    </div>
  );
};

export default ReportsTab;

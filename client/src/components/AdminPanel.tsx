import React, { useState, useCallback } from 'react';
import type { PendingApproval, Submission } from '../types';
import { groupSubmissionsByYearAndMonth, generateCSVData, downloadCSV } from '../utils';
import { supabase } from '../lib/supabaseClient';

interface AdminPanelProps {
  pendingApprovals: PendingApproval[];
  submissions: Submission[];
  isLoading: boolean;
  onRefresh: () => void;
}

const AdminPanel: React.FC<AdminPanelProps> = ({ 
  pendingApprovals, 
  submissions, 
  isLoading, 
  onRefresh 
}) => {
  const [csvStartDate, setCsvStartDate] = useState<string>('');
  const [csvEndDate, setCsvEndDate] = useState<string>('');
  const [expandedAdminYears, setExpandedAdminYears] = useState<Set<string>>(new Set());
  const [expandedMonths, setExpandedMonths] = useState<Set<string>>(new Set());

  const handleApproval = useCallback(async (id: string, newStatus: 'pending' | 'approved' | 'rejected') => {
    const updateData: { 
      status: 'pending' | 'approved' | 'rejected'; 
      approved_at?: string | null; 
      rejected_at?: string | null; 
    } = { status: newStatus };

    if (newStatus === 'approved') {
      updateData.approved_at = new Date().toISOString();
      updateData.rejected_at = null;
    } else if (newStatus === 'rejected') {
      updateData.rejected_at = new Date().toISOString();
      updateData.approved_at = null;
    } else {
      updateData.approved_at = null;
      updateData.rejected_at = null;
    }

    const { error } = await supabase
      .from('expenses')
      .update(updateData)
      .eq('id', id);

    if (error) {
      alert('更新に失敗しました: ' + error.message);
    } else {
      alert(`ステータスを「${newStatus === 'pending' ? '申請中' : newStatus === 'approved' ? '承認' : '却下'}」に更新しました。`);
      onRefresh();
    }
  }, [onRefresh]);

  const handleDeleteSubmission = useCallback(async (id: string) => {
    if (!window.confirm('本当にこの申請を削除しますか？')) {
      return;
    }

    const confirmationText = prompt('削除を確定するには「削除」と入力してください。');
    if (confirmationText !== '削除') {
      alert('削除がキャンセルされました。');
      return;
    }

    const { error } = await supabase
      .from('expenses')
      .delete()
      .eq('id', id);

    if (error) {
      alert('削除に失敗しました: ' + error.message);
    } else {
      alert('申請を削除しました。');
      onRefresh();
    }
  }, [onRefresh]);

  const handleExportCsv = useCallback(async () => {
    let query = supabase
      .from('expenses')
      .select('*, profiles(name, email)')
      .eq('status', 'approved');

    if (csvStartDate) {
      query = query.gte('created_at', `${csvStartDate}T00:00:00Z`);
    }
    if (csvEndDate) {
      query = query.lte('created_at', `${csvEndDate}T23:59:59Z`);
    }

    const { data, error } = await query.order('created_at', { ascending: true });

    if (error) {
      console.error('Error fetching approved expenses:', error.message);
      alert('CSV出力に失敗しました。');
      return;
    }

    if (!data || data.length === 0) {
      alert('承認済みの交通費がありません。');
      return;
    }

    const csvContent = generateCSVData(data);
    downloadCSV(csvContent);
    alert('CSVを出力しました。');
  }, [csvStartDate, csvEndDate]);

  const toggleYearExpansion = useCallback((year: string) => {
    setExpandedAdminYears(prev => {
      const newSet = new Set(prev);
      if (newSet.has(year)) {
        newSet.delete(year);
      } else {
        newSet.add(year);
      }
      return newSet;
    });
  }, []);

  const toggleMonthExpansion = useCallback((yearMonth: string) => {
    setExpandedMonths(prev => {
      const newSet = new Set(prev);
      if (newSet.has(yearMonth)) {
        newSet.delete(yearMonth);
      } else {
        newSet.add(yearMonth);
      }
      return newSet;
    });
  }, []);

  const groupedSubmissions = groupSubmissionsByYearAndMonth(submissions);

  return (
    <div style={{ marginTop: 40, borderTop: '1px solid #eee', paddingTop: 20 }}>
      <h2 style={{ textAlign: 'center' }}>経理承認</h2>
      
      {/* CSV出力セクション */}
      <div style={{ textAlign: 'center', marginBottom: 20 }}>
        <div style={{ marginBottom: 10 }}>
          <label htmlFor="csvStartDate">開始日:</label>
          <input
            type="date"
            id="csvStartDate"
            value={csvStartDate}
            onChange={(e) => setCsvStartDate(e.target.value)}
            style={{ marginRight: 10, padding: 5 }}
          />
          <label htmlFor="csvEndDate">終了日:</label>
          <input
            type="date"
            id="csvEndDate"
            value={csvEndDate}
            onChange={(e) => setCsvEndDate(e.target.value)}
            style={{ padding: 5 }}
          />
        </div>
        <button onClick={handleExportCsv}>承認済みCSV出力</button>
      </div>

      {/* 承認待ち一覧 */}
      <h3>承認待ち一覧</h3>
      {isLoading ? (
        <p>読み込み中...</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {pendingApprovals.map(p => (
            <li key={p.id} style={{ border: '1px solid #ccc', padding: 10, marginBottom: 10, borderRadius: 4 }}>
              <strong>申請者:</strong> {p.profiles?.name || p.profiles?.email || '不明'} <br />
              <strong>申請日:</strong> {new Date(p.created_at).toLocaleString()} <br />
              <strong>ステータス:</strong> {p.status === 'pending' ? '申請中' : p.status === 'approved' ? '承認' : '却下'} <br />
              <strong>合計金額:</strong> {p.expenses_data.reduce((sum, exp) => sum + (parseInt(exp.amount || '0') || 0), 0)}円 <br />
              {p.approved_at && (
                <><strong>承認日:</strong> {new Date(p.approved_at).toLocaleString()} <br /></>
              )}
              {p.rejected_at && (
                <><strong>却下日:</strong> {new Date(p.rejected_at).toLocaleString()} <br /></>
              )}
              <ul>
                {p.expenses_data.map((e, i) => (
                  <li key={i}>
                    {e.type === 'regular' ? '定期' : e.type === 'business_trip' ? '出張' : '単発'}: 
                    {e.type === 'regular' 
                      ? `${e.start_date || '未設定'} ~ ${e.end_date || '未設定'}` 
                      : `${e.start_date || '未設定'}`
                    } | 
                    {e.from_station} - {e.to_station}: {e.amount}円
                    {e.notes && ` (備考: ${e.notes})`}
                  </li>
                ))}
              </ul>
              <button 
                onClick={() => handleApproval(p.id, 'approved')} 
                style={{ marginRight: 10 }}
              >
                承認
              </button>
              <button onClick={() => handleApproval(p.id, 'rejected')}>却下</button>
            </li>
          ))}
        </ul>
      )}

      {/* すべての申請履歴 */}
      <h3 style={{ marginTop: 40 }}>すべての申請履歴</h3>
      {isLoading ? (
        <p>読み込み中...</p>
      ) : (
        Object.entries(groupedSubmissions)
          .sort(([yearA], [yearB]) => parseInt(yearB) - parseInt(yearA))
          .map(([year, months]) => (
            <div key={year} style={{ marginBottom: 20, border: '1px solid #eee', borderRadius: 4, padding: 10 }}>
              <h4 
                onClick={() => toggleYearExpansion(year)} 
                style={{ cursor: 'pointer', margin: 0, padding: 5, background: '#f0f0f0' }}
              >
                {year}年度 ({expandedAdminYears.has(year) ? '閉じる' : '開く'})
              </h4>
              {expandedAdminYears.has(year) && (
                Object.entries(months)
                  .sort(([monthA], [monthB]) => parseInt(monthB) - parseInt(monthA))
                  .map(([month, monthSubmissions]) => (
                    <div key={`${year}-${month}`} style={{ marginTop: 10, border: '1px solid #ddd', borderRadius: 4, padding: 5 }}>
                      <h5 
                        onClick={() => toggleMonthExpansion(`${year}-${month}`)} 
                        style={{ cursor: 'pointer', margin: 0, padding: 5, background: '#f9f9f9' }}
                      >
                        {month}月 ({expandedMonths.has(`${year}-${month}`) ? '閉じる' : '開く'})
                      </h5>
                      {expandedMonths.has(`${year}-${month}`) && (
                        <ul style={{ listStyle: 'none', padding: 0 }}>
                          {monthSubmissions.map(s => (
                            <li key={s.id} style={{ border: '1px solid #ccc', padding: 10, marginBottom: 10, borderRadius: 4 }}>
                              <strong>申請者:</strong> {s.profiles?.name || s.profiles?.email || '不明'} <br />
                              <strong>申請日:</strong> {new Date(s.created_at).toLocaleString()} <br />
                              <strong>ステータス:</strong> {s.status === 'pending' ? '申請中' : s.status === 'approved' ? '承認' : '却下'} <br />
                              <strong>合計金額:</strong> {s.expenses_data.reduce((sum, exp) => sum + (parseInt(exp.amount || '0') || 0), 0)}円 <br />
                              {s.approved_at && (
                                <><strong>承認日:</strong> {new Date(s.approved_at).toLocaleString()} <br /></>
                              )}
                              {s.rejected_at && (
                                <><strong>却下日:</strong> {new Date(s.rejected_at).toLocaleString()} <br /></>
                              )}
                              <ul>
                                {s.expenses_data.map((e, i) => (
                                  <li key={i}>
                                    {e.type === 'regular' ? '定期' : e.type === 'business_trip' ? '出張' : '単発'}: 
                                    {e.type === 'regular' 
                                      ? `${e.start_date || '未設定'} ~ ${e.end_date || '未設定'}` 
                                      : `${e.start_date || '未設定'}`
                                    } | 
                                    {e.from_station} - {e.to_station}: {e.amount}円
                                    {e.notes && ` (備考: ${e.notes})`}
                                  </li>
                                ))}
                              </ul>
                              <div style={{ marginTop: 10 }}>
                                <select
                                  defaultValue={s.status}
                                  onChange={(e) => handleApproval(s.id, e.target.value as 'pending' | 'approved' | 'rejected')}
                                  style={{ marginRight: 10, padding: 8 }}
                                >
                                  <option value="pending">申請中</option>
                                  <option value="approved">承認</option>
                                  <option value="rejected">却下</option>
                                </select>
                                <button onClick={() => handleApproval(s.id, s.status)} style={{ padding: '8px 12px' }}>更新</button>
                                <button 
                                  onClick={() => handleDeleteSubmission(s.id)} 
                                  style={{ 
                                    marginLeft: 10, 
                                    padding: '8px 12px', 
                                    background: '#dc3545', 
                                    color: 'white', 
                                    border: 'none', 
                                    borderRadius: 4, 
                                    cursor: 'pointer' 
                                  }}
                                >
                                  削除
                                </button>
                              </div>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ))
              )}
            </div>
          ))
      )}
    </div>
  );
};

export default AdminPanel;
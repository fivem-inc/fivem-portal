import React, { useState, useCallback, useEffect } from 'react';
import type { PendingApproval, Submission } from '../types';
import { groupSubmissionsByYearAndMonth, generateCSVData, downloadCSV, formatAmount } from '../utils';
import { supabase } from '../lib/supabaseClient';

interface AdminPanelProps {
  pendingApprovals: PendingApproval[];
  submissions: Submission[];
  isLoading: boolean;
  onRefresh: () => void;
}

type AdminTab = 'approvals' | 'users' | 'reports';

const AdminPanel: React.FC<AdminPanelProps> = ({ 
  pendingApprovals, 
  submissions, 
  isLoading, 
  onRefresh 
}) => {
  const [activeTab, setActiveTab] = useState<AdminTab>('approvals');
  const [csvStartDate, setCsvStartDate] = useState<string>('');
  const [csvEndDate, setCsvEndDate] = useState<string>('');
  const [expandedAdminYears, setExpandedAdminYears] = useState<Set<string>>(new Set());
  const [expandedMonths, setExpandedMonths] = useState<Set<string>>(new Set());
  
  // ユーザー管理用の状態
  const [users, setUsers] = useState<any[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [editingUser, setEditingUser] = useState<string | null>(null);
  const [editName, setEditName] = useState<string>('');
  
  // レポート用の状態
  const [reportStats, setReportStats] = useState<any>(null);
  const [loadingReports, setLoadingReports] = useState(false);
  
  // 却下理由の状態
  const [rejectReason, setRejectReason] = useState<string>('');
  const [showRejectModal, setShowRejectModal] = useState(false);
  const [rejectingSubmissionId, setRejectingSubmissionId] = useState<string | null>(null);

  // ユーザー一覧取得
  const fetchUsers = useCallback(async () => {
    setLoadingUsers(true);
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select(`
          id,
          email,
          name
        `)
        .order('email', { ascending: true });

      if (error) {
        console.error('ユーザー取得エラー:', error);
        alert('ユーザー情報の取得に失敗しました: ' + error.message);
      } else {
        setUsers(data || []);
      }
    } catch (error) {
      console.error('ユーザー取得エラー:', error);
      alert('ユーザー情報の取得中にエラーが発生しました');
    }
    setLoadingUsers(false);
  }, []);

  // ユーザー名編集機能
  const handleEditName = useCallback((userId: string, currentName: string) => {
    setEditingUser(userId);
    setEditName(currentName || '');
  }, []);

  const handleSaveName = useCallback(async (userId: string) => {
    try {
      console.log('=== 名前更新開始 ===');
      console.log('対象ユーザーID:', userId);
      console.log('新しい名前:', editName.trim());

      // profilesテーブルを更新
      const { error: profileError } = await supabase
        .from('profiles')
        .update({ name: editName.trim() || null })
        .eq('id', userId);
      
      if (profileError) {
        console.error('profiles更新エラー:', profileError);
        alert('名前の更新に失敗しました: ' + profileError.message);
      } else {
        console.log('✅ profiles名前保存成功');
        
        // auth.usersテーブルのuser_metadataも更新（SQLで直接実行）
        try {
          const { error: metadataError } = await supabase.rpc('update_user_metadata', {
            user_id: userId,
            metadata: { 
              name: editName.trim(),
              display_name: editName.trim(),
              full_name: editName.trim()
            }
          });
          
          if (metadataError) {
            console.warn('user_metadata更新エラー:', metadataError);
            // profilesは更新されたのでエラーにはしない
          }
        } catch (metaError) {
          console.warn('user_metadata更新例外:', metaError);
        }
        
        alert('名前を更新しました');
        setEditingUser(null);
        setEditName('');
        // ユーザーリストを更新
        fetchUsers();
      }
    } catch (error) {
      console.error('名前更新例外エラー:', error);
      alert('名前の更新中にエラーが発生しました: ' + error);
    }
  }, [editName, fetchUsers]);

  const handleCancelEdit = useCallback(() => {
    setEditingUser(null);
    setEditName('');
  }, []);

  // レポート統計を取得
  const fetchReportStats = useCallback(async () => {
    if (users.length === 0 || submissions.length === 0) {
      setLoadingReports(false);
      return;
    }
    
    setLoadingReports(true);
    try {
      // 基本統計の計算
      const totalSubmissions = submissions.length;
      const pendingSubmissions = submissions.filter(s => s.status === 'pending').length;
      const approvedSubmissions = submissions.filter(s => s.status === 'approved').length;
      const rejectedSubmissions = submissions.filter(s => s.status === 'rejected').length;
      
      const approvalRate = totalSubmissions > 0 ? (approvedSubmissions / totalSubmissions * 100).toFixed(1) : '0';
      
      // ユーザー別統計
      const userStats = users.map(user => {
        const userSubmissions = submissions.filter(s => s.profiles?.email === user.email);
        const userApproved = userSubmissions.filter(s => s.status === 'approved');
        const totalAmount = userApproved.reduce((sum, s) => {
          return sum + s.expenses_data.reduce((expSum, exp) => expSum + (parseInt(exp.amount || '0') || 0), 0);
        }, 0);
        
        return {
          name: user.name || user.email,
          email: user.email,
          totalSubmissions: userSubmissions.length,
          approvedSubmissions: userApproved.length,
          totalAmount,
          approvalRate: userSubmissions.length > 0 ? (userApproved.length / userSubmissions.length * 100).toFixed(1) : '0'
        };
      }).sort((a, b) => b.totalAmount - a.totalAmount);
      
      // 月別統計
      const monthlyStats = submissions.reduce((acc, submission) => {
        const date = new Date(submission.created_at);
        const monthKey = `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, '0')}`;
        
        if (!acc[monthKey]) {
          acc[monthKey] = { month: monthKey, total: 0, approved: 0, rejected: 0, pending: 0, amount: 0 };
        }
        
        acc[monthKey].total++;
        acc[monthKey][submission.status]++;
        
        if (submission.status === 'approved') {
          const amount = submission.expenses_data.reduce((sum, exp) => sum + (parseInt(exp.amount || '0') || 0), 0);
          acc[monthKey].amount += amount;
        }
        
        return acc;
      }, {} as Record<string, any>);
      
      const sortedMonthlyStats = Object.values(monthlyStats).sort((a: any, b: any) => b.month.localeCompare(a.month));
      
      setReportStats({
        overview: {
          totalSubmissions,
          pendingSubmissions,
          approvedSubmissions,
          rejectedSubmissions,
          approvalRate
        },
        userStats,
        monthlyStats: sortedMonthlyStats
      });
    } catch (error) {
      console.error('レポート統計取得エラー:', error);
    }
    setLoadingReports(false);
  }, [submissions, users]);

  // タブが変更された時にデータを読み込み
  useEffect(() => {
    if (activeTab === 'users') {
      fetchUsers();
    }
  }, [activeTab, fetchUsers]);

  // レポートタブでデータが準備できたら統計を計算
  useEffect(() => {
    if (activeTab === 'reports' && users.length > 0 && submissions.length > 0) {
      fetchReportStats();
    }
  }, [activeTab, users, submissions, fetchReportStats]);

  const handleApproval = useCallback(async (id: string, newStatus: 'pending' | 'approved' | 'rejected', reason?: string) => {
    const updateData: { 
      status: 'pending' | 'approved' | 'rejected'; 
      approved_at?: string | null; 
      rejected_at?: string | null;
      rejected_reason?: string | null;
    } = { status: newStatus };

    if (newStatus === 'approved') {
      updateData.approved_at = new Date().toISOString();
      updateData.rejected_at = null;
      updateData.rejected_reason = null;
    } else if (newStatus === 'rejected') {
      updateData.rejected_at = new Date().toISOString();
      updateData.approved_at = null;
      updateData.rejected_reason = reason || null;
    } else {
      updateData.approved_at = null;
      updateData.rejected_at = null;
      updateData.rejected_reason = null;
    }

    const { error } = await supabase
      .from('expenses')
      .update(updateData)
      .eq('id', id);

    if (error) {
      alert('更新に失敗しました: ' + error.message);
    } else {
      // 却下時のメール通知
      if (newStatus === 'rejected') {
        try {
          const { error: emailError } = await supabase.functions.invoke('send-rejection-email', {
            body: { submissionId: id, reason: reason || '' }
          });
          
          if (emailError) {
            console.warn('メール送信エラー:', emailError);
          }
        } catch (emailError) {
          console.warn('メール送信例外:', emailError);
        }
      }
      
      alert(`ステータスを「${newStatus === 'pending' ? '申請中' : newStatus === 'approved' ? '承認' : '却下'}」に更新しました。`);
      onRefresh();
    }
  }, [onRefresh]);

  // 一括承認機能
  const handleBulkApproval = useCallback(async (newStatus: 'approved' | 'rejected') => {
    if (pendingApprovals.length === 0) {
      alert('承認待ちの申請がありません。');
      return;
    }

    const confirmMessage = newStatus === 'approved' 
      ? `${pendingApprovals.length}件の申請をすべて承認しますか？` 
      : `${pendingApprovals.length}件の申請をすべて却下しますか？`;
    
    if (!window.confirm(confirmMessage)) {
      return;
    }

    let reason = '';
    if (newStatus === 'rejected') {
      reason = prompt('却下理由を入力してください:') || '';
    }

    let successCount = 0;
    let errorCount = 0;

    for (const approval of pendingApprovals) {
      try {
        const updateData: { 
          status: 'approved' | 'rejected'; 
          approved_at?: string | null; 
          rejected_at?: string | null;
          rejected_reason?: string | null;
        } = { status: newStatus };

        if (newStatus === 'approved') {
          updateData.approved_at = new Date().toISOString();
          updateData.rejected_at = null;
          updateData.rejected_reason = null;
        } else {
          updateData.rejected_at = new Date().toISOString();
          updateData.approved_at = null;
          updateData.rejected_reason = reason || null;
        }

        const { error } = await supabase
          .from('expenses')
          .update(updateData)
          .eq('id', approval.id);

        if (error) {
          console.error(`申請ID ${approval.id} の更新に失敗:`, error);
          errorCount++;
        } else {
          successCount++;
          
          // 却下時のメール通知
          if (newStatus === 'rejected') {
            try {
              const { error: emailError } = await supabase.functions.invoke('send-rejection-email', {
                body: { submissionId: approval.id, reason: reason || '' }
              });
              
              if (emailError) {
                console.warn('メール送信エラー:', emailError);
              }
            } catch (emailError) {
              console.warn('メール送信例外:', emailError);
            }
          }
        }
      } catch (error) {
        console.error(`申請ID ${approval.id} の処理中にエラー:`, error);
        errorCount++;
      }
    }

    const statusText = newStatus === 'approved' ? '承認' : '却下';
    if (errorCount > 0) {
      alert(`${successCount}件の申請を${statusText}しました。${errorCount}件でエラーが発生しました。`);
    } else {
      alert(`${successCount}件の申請をすべて${statusText}しました。`);
    }
    
    onRefresh();
  }, [pendingApprovals, onRefresh]);

  // 個別却下機能（理由入力付き）
  const handleIndividualReject = useCallback((id: string) => {
    setRejectingSubmissionId(id);
    setShowRejectModal(true);
    setRejectReason('');
  }, []);

  // 却下理由確定
  const handleConfirmReject = useCallback(async () => {
    if (!rejectingSubmissionId) return;

    await handleApproval(rejectingSubmissionId, 'rejected', rejectReason);
    setShowRejectModal(false);
    setRejectingSubmissionId(null);
    setRejectReason('');
  }, [rejectingSubmissionId, rejectReason, handleApproval]);

  // 却下キャンセル
  const handleCancelReject = useCallback(() => {
    setShowRejectModal(false);
    setRejectingSubmissionId(null);
    setRejectReason('');
  }, []);

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

  // タブのスタイル
  const tabStyle = (isActive: boolean) => ({
    padding: '12px 24px',
    marginRight: '4px',
    background: isActive ? '#007bff' : '#f8f9fa',
    color: isActive ? 'white' : '#333',
    border: `1px solid ${isActive ? '#007bff' : '#dee2e6'}`,
    borderBottom: isActive ? 'none' : '1px solid #dee2e6',
    borderRadius: '8px 8px 0 0',
    cursor: 'pointer',
    fontSize: '16px',
    fontWeight: isActive ? 'bold' : 'normal',
    transition: 'all 0.2s ease'
  });

  const tabContentStyle = {
    border: '1px solid #dee2e6',
    borderTop: 'none',
    borderRadius: '0 8px 8px 8px',
    padding: '20px',
    background: 'white',
    minHeight: '400px'
  };

  return (
    <div style={{ marginTop: 40, borderTop: '1px solid #eee', paddingTop: 20 }}>
      <style>{`
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
      `}</style>
      <h2 style={{ textAlign: 'center', marginBottom: '30px' }}>管理画面</h2>
      
      {/* 却下理由入力モーダル */}
      {showRejectModal && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.5)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000
        }}>
          <div style={{
            backgroundColor: 'white',
            padding: '30px',
            borderRadius: '8px',
            width: '90%',
            maxWidth: '500px',
            boxShadow: '0 4px 6px rgba(0, 0, 0, 0.1)'
          }}>
            <h3 style={{ marginBottom: '20px', textAlign: 'center' }}>却下理由を入力</h3>
            <textarea
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="却下理由を入力してください（省略可）"
              style={{
                width: '100%',
                minHeight: '100px',
                padding: '10px',
                border: '1px solid #ccc',
                borderRadius: '4px',
                marginBottom: '20px',
                resize: 'vertical'
              }}
            />
            <div style={{ textAlign: 'right', display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
              <button
                onClick={handleCancelReject}
                style={{
                  padding: '10px 20px',
                  backgroundColor: '#6c757d',
                  color: 'white',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer'
                }}
              >
                キャンセル
              </button>
              <button
                onClick={handleConfirmReject}
                style={{
                  padding: '10px 20px',
                  backgroundColor: '#dc3545',
                  color: 'white',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer'
                }}
              >
                却下する
              </button>
            </div>
          </div>
        </div>
      )}
      
      {/* タブナビゲーション */}
      <div style={{ display: 'flex', marginBottom: '0', justifyContent: 'center' }}>
        <button
          style={tabStyle(activeTab === 'approvals')}
          onClick={() => setActiveTab('approvals')}
        >
          承認管理
        </button>
        <button
          style={tabStyle(activeTab === 'users')}
          onClick={() => setActiveTab('users')}
        >
          ユーザー管理
        </button>
        <button
          style={tabStyle(activeTab === 'reports')}
          onClick={() => setActiveTab('reports')}
        >
          レポート・分析
        </button>
      </div>

      {/* タブコンテンツ */}
      <div style={tabContentStyle}>
        {activeTab === 'approvals' && (
          <div>
            <h3 style={{ textAlign: 'center', marginBottom: '30px' }}>承認管理</h3>
            
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
            <h4 style={{ textAlign: 'left' }}>承認待ち一覧</h4>
            {isLoading ? (
              <p style={{ textAlign: 'left' }}>読み込み中...</p>
            ) : (
              <div>
                {pendingApprovals.length > 0 && (
                  <div style={{ marginBottom: '20px' }}>
                    <button 
                      onClick={() => handleBulkApproval('approved')}
                      style={{ 
                        padding: '10px 20px', 
                        marginRight: '10px', 
                        backgroundColor: '#28a745', 
                        color: 'white', 
                        border: 'none', 
                        borderRadius: '4px',
                        cursor: 'pointer'
                      }}
                    >
                      全て承認
                    </button>
                    <button 
                      onClick={() => handleBulkApproval('rejected')}
                      style={{ 
                        padding: '10px 20px', 
                        backgroundColor: '#dc3545', 
                        color: 'white', 
                        border: 'none', 
                        borderRadius: '4px',
                        cursor: 'pointer'
                      }}
                    >
                      全て却下
                    </button>
                  </div>
                )}
                <ul style={{ listStyle: 'none', padding: 0, textAlign: 'left' }}>
                  {pendingApprovals.map(p => (
                    <li key={p.id} style={{ border: '1px solid #ccc', padding: 10, marginBottom: 10, borderRadius: 4 }}>
                      <strong>申請者:</strong> {p.profiles?.name || p.profiles?.email || '不明'} <br />
                      <strong>申請日:</strong> {new Date(p.created_at).toLocaleString()} <br />
                      <strong>ステータス:</strong> {p.status === 'pending' ? '申請中' : p.status === 'approved' ? '承認' : '却下'} <br />
                      <strong>合計金額:</strong> {formatAmount(p.expenses_data.reduce((sum, exp) => sum + (parseInt(exp.amount || '0') || 0), 0).toString())}円 <br />
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
                            {e.transportation && `[${e.transportation}] `}
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
                      <button 
                        onClick={() => handleIndividualReject(p.id)}
                        style={{ marginRight: 10 }}
                      >
                        却下
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* すべての申請履歴 */}
            <h4 style={{ marginTop: 40, textAlign: 'left' }}>すべての申請履歴</h4>
            {isLoading ? (
              <p style={{ textAlign: 'left' }}>読み込み中...</p>
            ) : (
              <div style={{ textAlign: 'left' }}>
              {Object.entries(groupedSubmissions)
                .sort(([yearA], [yearB]) => parseInt(yearB) - parseInt(yearA))
                .map(([year, months]) => (
                  <div key={year} style={{ marginBottom: 20, border: '1px solid #eee', borderRadius: 4, padding: 10 }}>
                    <h5 
                      onClick={() => toggleYearExpansion(year)} 
                      style={{ 
                        cursor: 'pointer', 
                        margin: 0, 
                        padding: 8, 
                        background: '#f0f0f0',
                        color: '#333',
                        fontWeight: 'bold',
                        borderRadius: 4,
                        border: '1px solid #ddd'
                      }}
                    >
                      {year}年度 ({expandedAdminYears.has(year) ? '閉じる' : '開く'})
                    </h5>
                    {expandedAdminYears.has(year) && (
                      Object.entries(months)
                        .sort(([monthA], [monthB]) => parseInt(monthB) - parseInt(monthA))
                        .map(([month, monthSubmissions]) => (
                          <div key={`${year}-${month}`} style={{ marginTop: 10, border: '1px solid #ddd', borderRadius: 4, padding: 5 }}>
                            <h6 
                              onClick={() => toggleMonthExpansion(`${year}-${month}`)} 
                              style={{ 
                                cursor: 'pointer', 
                                margin: 0, 
                                padding: 8, 
                                background: '#f9f9f9',
                                color: '#333',
                                fontWeight: 'bold',
                                borderRadius: 4,
                                border: '1px solid #ccc'
                              }}
                            >
                              {month}月 ({expandedMonths.has(`${year}-${month}`) ? '閉じる' : '開く'})
                            </h6>
                            {expandedMonths.has(`${year}-${month}`) && (
                              <ul style={{ listStyle: 'none', padding: 0 }}>
                                {monthSubmissions.map(s => (
                                  <li key={s.id} style={{ border: '1px solid #ccc', padding: 10, marginBottom: 10, borderRadius: 4 }}>
                                    <strong>申請者:</strong> {s.profiles?.name || s.profiles?.email || '不明'} <br />
                                    <strong>申請日:</strong> {new Date(s.created_at).toLocaleString()} <br />
                                    <strong>ステータス:</strong> {s.status === 'pending' ? '申請中' : s.status === 'approved' ? '承認' : '却下'} <br />
                                    <strong>合計金額:</strong> {formatAmount(s.expenses_data.reduce((sum, exp) => sum + (parseInt(exp.amount || '0') || 0), 0).toString())}円 <br />
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
                                          {e.transportation && `[${e.transportation}] `}
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
                ))}
              </div>
            )}
          </div>
        )}

        {/* ユーザー管理タブ */}
        {activeTab === 'users' && (
          <div>
            <h3 style={{ textAlign: 'center', marginBottom: '30px' }}>ユーザー管理</h3>
            {loadingUsers ? (
              <p style={{ textAlign: 'center' }}>読み込み中...</p>
            ) : (
              <div>
                <div style={{ marginBottom: '20px', textAlign: 'center' }}>
                  <p>登録ユーザー数: {users.length}人</p>
                  <button onClick={fetchUsers} style={{ padding: '8px 16px' }}>
                    更新
                  </button>
                </div>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ backgroundColor: '#f8f9fa' }}>
                        <th style={{ border: '1px solid #dee2e6', padding: '12px', textAlign: 'left' }}>名前</th>
                        <th style={{ border: '1px solid #dee2e6', padding: '12px', textAlign: 'left' }}>メールアドレス</th>
                        <th style={{ border: '1px solid #dee2e6', padding: '12px', textAlign: 'left' }}>申請数</th>
                        <th style={{ border: '1px solid #dee2e6', padding: '12px', textAlign: 'left' }}>権限</th>
                        <th style={{ border: '1px solid #dee2e6', padding: '12px', textAlign: 'left' }}>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {users.map(user => (
                        <tr key={user.id}>
                          <td style={{ border: '1px solid #dee2e6', padding: '12px' }}>
                            {editingUser === user.id ? (
                              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                <input
                                  type="text"
                                  value={editName}
                                  onChange={(e) => setEditName(e.target.value)}
                                  style={{ 
                                    flex: 1, 
                                    padding: '4px 8px', 
                                    border: '1px solid #ccc', 
                                    borderRadius: '4px',
                                    fontSize: '14px'
                                  }}
                                  placeholder="名前を入力"
                                  onKeyPress={(e) => {
                                    if (e.key === 'Enter') {
                                      handleSaveName(user.id);
                                    }
                                  }}
                                />
                                <button
                                  onClick={() => handleSaveName(user.id)}
                                  style={{
                                    padding: '4px 8px',
                                    background: '#28a745',
                                    color: 'white',
                                    border: 'none',
                                    borderRadius: '4px',
                                    cursor: 'pointer',
                                    fontSize: '12px'
                                  }}
                                >
                                  保存
                                </button>
                                <button
                                  onClick={handleCancelEdit}
                                  style={{
                                    padding: '4px 8px',
                                    background: '#6c757d',
                                    color: 'white',
                                    border: 'none',
                                    borderRadius: '4px',
                                    cursor: 'pointer',
                                    fontSize: '12px'
                                  }}
                                >
                                  キャンセル
                                </button>
                              </div>
                            ) : (
                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                <span>{user.name || '未設定'}</span>
                                <button
                                  onClick={() => handleEditName(user.id, user.name)}
                                  style={{
                                    padding: '2px 6px',
                                    background: '#ffc107',
                                    color: '#212529',
                                    border: 'none',
                                    borderRadius: '3px',
                                    cursor: 'pointer',
                                    fontSize: '11px',
                                    marginLeft: '8px'
                                  }}
                                  title="名前を編集"
                                >
                                  編集
                                </button>
                              </div>
                            )}
                          </td>
                          <td style={{ border: '1px solid #dee2e6', padding: '12px' }}>
                            {user.email}
                          </td>
                          <td style={{ border: '1px solid #dee2e6', padding: '12px' }}>
                            {submissions.filter(s => s.profiles?.email === user.email).length}
                          </td>
                          <td style={{ border: '1px solid #dee2e6', padding: '12px' }}>
                            {user.email === 'fivem.kyoto@gmail.com' ? '管理者' : '一般ユーザー'}
                          </td>
                          <td style={{ border: '1px solid #dee2e6', padding: '12px' }}>
                            <button 
                              style={{ 
                                padding: '4px 8px', 
                                marginRight: '5px',
                                background: '#17a2b8',
                                color: 'white',
                                border: 'none',
                                borderRadius: '4px',
                                cursor: 'pointer'
                              }}
                              onClick={() => {
                                setActiveTab('reports');
                              }}
                            >
                              履歴確認
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}

        {/* レポート・分析タブ */}
        {activeTab === 'reports' && (
          <div>
            <h3 style={{ textAlign: 'center', marginBottom: '30px' }}>レポート・分析</h3>
            
            {loadingReports || !reportStats ? (
              <div style={{ textAlign: 'center', padding: '40px' }}>
                <p>統計データを計算中...</p>
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
                  <h4 style={{ textAlign: 'center', marginBottom: '20px' }}>📊 ダッシュボード</h4>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '20px', marginBottom: '20px' }}>
                    <div style={{ padding: '20px', backgroundColor: '#e3f2fd', borderRadius: '8px', textAlign: 'center' }}>
                      <h5 style={{ margin: '0 0 10px 0', color: '#1976d2' }}>総申請数</h5>
                      <p style={{ margin: 0, fontSize: '24px', fontWeight: 'bold' }}>{reportStats.overview.totalSubmissions}</p>
                    </div>
                    <div style={{ padding: '20px', backgroundColor: '#fff3e0', borderRadius: '8px', textAlign: 'center' }}>
                      <h5 style={{ margin: '0 0 10px 0', color: '#f57c00' }}>申請中</h5>
                      <p style={{ margin: 0, fontSize: '24px', fontWeight: 'bold' }}>{reportStats.overview.pendingSubmissions}</p>
                    </div>
                    <div style={{ padding: '20px', backgroundColor: '#e8f5e8', borderRadius: '8px', textAlign: 'center' }}>
                      <h5 style={{ margin: '0 0 10px 0', color: '#388e3c' }}>承認済み</h5>
                      <p style={{ margin: 0, fontSize: '24px', fontWeight: 'bold' }}>{reportStats.overview.approvedSubmissions}</p>
                    </div>
                    <div style={{ padding: '20px', backgroundColor: '#ffebee', borderRadius: '8px', textAlign: 'center' }}>
                      <h5 style={{ margin: '0 0 10px 0', color: '#d32f2f' }}>却下</h5>
                      <p style={{ margin: 0, fontSize: '24px', fontWeight: 'bold' }}>{reportStats.overview.rejectedSubmissions}</p>
                    </div>
                    <div style={{ padding: '20px', backgroundColor: '#f3e5f5', borderRadius: '8px', textAlign: 'center' }}>
                      <h5 style={{ margin: '0 0 10px 0', color: '#7b1fa2' }}>承認率</h5>
                      <p style={{ margin: 0, fontSize: '24px', fontWeight: 'bold' }}>{reportStats.overview.approvalRate}%</p>
                    </div>
                  </div>
                </div>

                {/* ユーザー別統計 */}
                <div style={{ marginBottom: '40px' }}>
                  <h4 style={{ textAlign: 'center', marginBottom: '20px' }}>👥 ユーザー別統計</h4>
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <thead>
                        <tr style={{ backgroundColor: '#f8f9fa' }}>
                          <th style={{ border: '1px solid #dee2e6', padding: '12px', textAlign: 'left' }}>ユーザー</th>
                          <th style={{ border: '1px solid #dee2e6', padding: '12px', textAlign: 'center' }}>申請数</th>
                          <th style={{ border: '1px solid #dee2e6', padding: '12px', textAlign: 'center' }}>承認数</th>
                          <th style={{ border: '1px solid #dee2e6', padding: '12px', textAlign: 'center' }}>承認率</th>
                          <th style={{ border: '1px solid #dee2e6', padding: '12px', textAlign: 'right' }}>総額（承認済み）</th>
                        </tr>
                      </thead>
                      <tbody>
                        {reportStats.userStats.map((user: any, index: number) => (
                          <tr key={user.email} style={{ backgroundColor: index % 2 === 0 ? '#f8f9fa' : 'white' }}>
                            <td style={{ border: '1px solid #dee2e6', padding: '12px' }}>
                              <strong>{user.name}</strong><br />
                              <small style={{ color: '#6c757d' }}>{user.email}</small>
                            </td>
                            <td style={{ border: '1px solid #dee2e6', padding: '12px', textAlign: 'center' }}>
                              {user.totalSubmissions}
                            </td>
                            <td style={{ border: '1px solid #dee2e6', padding: '12px', textAlign: 'center' }}>
                              {user.approvedSubmissions}
                            </td>
                            <td style={{ border: '1px solid #dee2e6', padding: '12px', textAlign: 'center' }}>
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
                            <td style={{ border: '1px solid #dee2e6', padding: '12px', textAlign: 'right', fontWeight: 'bold' }}>
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
                  <h4 style={{ textAlign: 'center', marginBottom: '20px' }}>📅 月次レポート</h4>
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <thead>
                        <tr style={{ backgroundColor: '#f8f9fa' }}>
                          <th style={{ border: '1px solid #dee2e6', padding: '12px', textAlign: 'left' }}>月</th>
                          <th style={{ border: '1px solid #dee2e6', padding: '12px', textAlign: 'center' }}>総申請数</th>
                          <th style={{ border: '1px solid #dee2e6', padding: '12px', textAlign: 'center' }}>承認</th>
                          <th style={{ border: '1px solid #dee2e6', padding: '12px', textAlign: 'center' }}>申請中</th>
                          <th style={{ border: '1px solid #dee2e6', padding: '12px', textAlign: 'center' }}>却下</th>
                          <th style={{ border: '1px solid #dee2e6', padding: '12px', textAlign: 'right' }}>承認済み総額</th>
                        </tr>
                      </thead>
                      <tbody>
                        {reportStats.monthlyStats.map((month: any, index: number) => (
                          <tr key={month.month} style={{ backgroundColor: index % 2 === 0 ? '#f8f9fa' : 'white' }}>
                            <td style={{ border: '1px solid #dee2e6', padding: '12px', fontWeight: 'bold' }}>
                              {month.month}
                            </td>
                            <td style={{ border: '1px solid #dee2e6', padding: '12px', textAlign: 'center' }}>
                              {month.total}
                            </td>
                            <td style={{ border: '1px solid #dee2e6', padding: '12px', textAlign: 'center' }}>
                              <span style={{ color: '#28a745', fontWeight: 'bold' }}>{month.approved}</span>
                            </td>
                            <td style={{ border: '1px solid #dee2e6', padding: '12px', textAlign: 'center' }}>
                              <span style={{ color: '#ffc107', fontWeight: 'bold' }}>{month.pending}</span>
                            </td>
                            <td style={{ border: '1px solid #dee2e6', padding: '12px', textAlign: 'center' }}>
                              <span style={{ color: '#dc3545', fontWeight: 'bold' }}>{month.rejected}</span>
                            </td>
                            <td style={{ border: '1px solid #dee2e6', padding: '12px', textAlign: 'right', fontWeight: 'bold' }}>
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
        )}
      </div>
    </div>
  );
};

export default AdminPanel;
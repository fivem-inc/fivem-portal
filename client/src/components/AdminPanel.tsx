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
  const [csvDateType, setCsvDateType] = useState<'created' | 'approved'>('approved'); // 日付種別（申請日 or 承認日）
  const [expandedAdminYears, setExpandedAdminYears] = useState<Set<string>>(new Set());
  const [expandedMonths, setExpandedMonths] = useState<Set<string>>(new Set());
  
  // ユーザー管理用の状態
  const [users, setUsers] = useState<any[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [editingUser, setEditingUser] = useState<string | null>(null);
  const [editName, setEditName] = useState<string>('');
  const [showRetired, setShowRetired] = useState(false); // 退職者表示切り替え
  
  // レポート用の状態
  const [reportStats, setReportStats] = useState<any>(null);
  const [loadingReports, setLoadingReports] = useState(false);
  
  // 却下理由の状態
  const [rejectReason, setRejectReason] = useState<string>('');
  const [showRejectModal, setShowRejectModal] = useState(false);
  const [rejectingSubmissionId, setRejectingSubmissionId] = useState<string | null>(null);

  // 印刷機能用の状態
  const [selectedForPrint, setSelectedForPrint] = useState<Set<string>>(new Set());
  const [showPrintPreview, setShowPrintPreview] = useState(false);
  
  // フィルター機能用の状態
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  
  // 申請内容編集用の状態
  const [editingSubmissionId, setEditingSubmissionId] = useState<string | null>(null);
  const [editingExpenses, setEditingExpenses] = useState<any[]>([]);
  interface PrintVoucher {
    submissionId: string;
    submitterName: string;
    submittedDate: string;
    expenses: any[];
    total: number;
    submissionTotal: number;
    isLastPage: boolean;
    voucherNumber: string;
    printDate: string;
    currentPage: number;
    totalPages: number;
    pageInfo: string;
    submissionIndex: number;
    totalSubmissions: number;
  }
  
  interface PrintPage {
    pageNumber: number;
    totalPages: number;
    vouchers: PrintVoucher[];
  }
  
  const [printData, setPrintData] = useState<PrintPage[]>([]);

  // フィルタリング関数
  const getFilteredSubmissions = useCallback(() => {
    return submissions.filter(submission => {
      // ステータスフィルター
      if (statusFilter !== 'all' && submission.status !== statusFilter) {
        return false;
      }
      
      // 申請種別フィルター
      if (typeFilter !== 'all') {
        const hasMatchingType = submission.expenses_data?.some(expense => expense.type === typeFilter);
        if (!hasMatchingType) {
          return false;
        }
      }
      
      return true;
    });
  }, [submissions, typeFilter, statusFilter]);

  // フィルター済み承認待ちデータ
  const filteredPending = React.useMemo(() => {
    return getFilteredSubmissions().filter(s => s.status === 'pending');
  }, [getFilteredSubmissions]);

  // ユーザー一覧取得
  const fetchUsers = useCallback(async () => {
    setLoadingUsers(true);
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select(`
          id,
          email,
          name,
          is_active
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

  const handleCancelUserEdit = useCallback(() => {
    setEditingUser(null);
    setEditName('');
  }, []);

  // 退職・復活切り替え
  const handleToggleActive = useCallback(async (userId: string, currentIsActive: boolean) => {
    const action = currentIsActive ? '退職済みにします' : '現役に戻します';
    if (!window.confirm(`このユーザーを${action}。よろしいですか？`)) return;
    const { error } = await supabase
      .from('profiles')
      .update({ is_active: !currentIsActive })
      .eq('id', userId);
    if (error) {
      alert('更新に失敗しました: ' + error.message);
    } else {
      fetchUsers();
    }
  }, [fetchUsers]);

  // ユーザー完全削除
  const handleDeleteUser = useCallback(async (userId: string, userName: string) => {
    if (!window.confirm(`「${userName}」を完全に削除します。この操作は取り消せません。よろしいですか？`)) return;
    const { error } = await supabase
      .from('profiles')
      .delete()
      .eq('id', userId);
    if (error) {
      alert('削除に失敗しました: ' + error.message);
    } else {
      alert('削除しました');
      fetchUsers();
    }
  }, [fetchUsers]);

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
      
      alert(`ステータスを「${newStatus === 'pending' ? '申請中' : newStatus === 'approved' ? '承認' : '却下'}」に更新しました。`);
      onRefresh();
    }
  }, [onRefresh]);

  // 一括承認機能
  const handleBulkApproval = useCallback(async (newStatus: 'approved' | 'rejected') => {
    if (filteredPending.length === 0) {
      alert('承認待ちの申請がありません。');
      return;
    }

    const confirmMessage = newStatus === 'approved' 
      ? `${filteredPending.length}件の申請をすべて承認しますか？` 
      : `${filteredPending.length}件の申請をすべて却下しますか？`;
    
    if (!window.confirm(confirmMessage)) {
      return;
    }

    let reason = '';
    if (newStatus === 'rejected') {
      reason = prompt('却下理由を入力してください:') || '';
    }

    let successCount = 0;
    let errorCount = 0;

    for (const approval of filteredPending) {
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
  }, [filteredPending, onRefresh]);

  // 個別却下機能（理由入力付き）
  const handleIndividualReject = useCallback((id: string) => {
    setRejectingSubmissionId(id);
    setShowRejectModal(true);
    setRejectReason('');
  }, []);

  // 印刷選択処理
  const handlePrintSelect = useCallback((submissionId: string, checked: boolean) => {
    setSelectedForPrint(prev => {
      const newSet = new Set(prev);
      if (checked) {
        newSet.add(submissionId);
      } else {
        newSet.delete(submissionId);
      }
      return newSet;
    });
  }, []);

  // 印刷用伝票データ生成（重複排除付き）
  const getVouchersForPrint = useCallback(() => {
    // 承認待ちと申請履歴から重複を排除して取得
    const allSubmissions = [...pendingApprovals, ...submissions];
    const uniqueSubmissions = allSubmissions.filter((submission, index, self) => 
      selectedForPrint.has(submission.id) && 
      self.findIndex(s => s.id === submission.id) === index
    );

    // 伝票データ生成 (デバッグ)
    
    // 現在の日時を取得（YYYYMMDD-HHMM形式）
    const today = new Date();
    const dateStr = today.getFullYear().toString() + 
                   (today.getMonth() + 1).toString().padStart(2, '0') + 
                   today.getDate().toString().padStart(2, '0');
    const timeStr = today.getHours().toString().padStart(2, '0') + 
                   today.getMinutes().toString().padStart(2, '0');

    const vouchers = [];
    const printDate = today.toLocaleDateString('ja-JP') + ' ' + 
                     today.getHours().toString().padStart(2, '0') + ':' + 
                     today.getMinutes().toString().padStart(2, '0');
    let voucherCounter = 1;
    
    for (const submission of uniqueSubmissions) {
      const expenses = submission.expenses_data;
      const expensesPerVoucher = 12;
      const totalVouchersForSubmission = Math.ceil(expenses.length / expensesPerVoucher);
      
      // 申請全体の合計金額を計算
      const submissionTotal = expenses.reduce((sum, exp) => 
        sum + (parseInt(exp.amount || '0') || 0), 0
      );
      
      for (let i = 0; i < expenses.length; i += expensesPerVoucher) {
        const voucherExpenses = expenses.slice(i, i + expensesPerVoucher);
        const voucherTotal = voucherExpenses.reduce((sum, exp) => 
          sum + (parseInt(exp.amount || '0') || 0), 0
        );
        const voucherPageNum = Math.floor(i / expensesPerVoucher) + 1;
        const isLastPage = voucherPageNum === totalVouchersForSubmission;
        
        // 時刻ベースの伝票番号生成
        const voucherNumber = `#${dateStr}-${timeStr}-${voucherCounter.toString().padStart(2, '0')}`;
        voucherCounter++;
        
        vouchers.push({
          submissionId: submission.id,
          submitterName: submission.profiles?.name || submission.profiles?.email || '不明',
          submittedDate: new Date(submission.created_at).toLocaleDateString('ja-JP'),
          expenses: voucherExpenses,
          total: voucherTotal,
          submissionTotal: submissionTotal,
          isLastPage: isLastPage,
          voucherNumber: voucherNumber,
          printDate: printDate,
          currentPage: voucherPageNum,
          totalPages: totalVouchersForSubmission,
          pageInfo: totalVouchersForSubmission > 1 ? `【${voucherPageNum}/${totalVouchersForSubmission}】` : '',
          submissionIndex: uniqueSubmissions.indexOf(submission) + 1,
          totalSubmissions: uniqueSubmissions.length
        });
      }
    }
    
    console.log(`最終: ${vouchers.length}伝票生成`);
    return vouchers;
  }, [pendingApprovals, submissions, selectedForPrint]);

  // ページ分割された伝票データ生成（1ページに1つの伝票）
  const getPaginatedVouchers = useCallback(() => {
    const vouchers = getVouchersForPrint();
    const pages = [];
    
    for (let i = 0; i < vouchers.length; i += 1) {
      const pageVouchers = vouchers.slice(i, i + 1);
      pages.push({
        pageNumber: i + 1,
        totalPages: vouchers.length,
        vouchers: pageVouchers
      });
    }
    
    console.log(`ページ分割: ${vouchers.length}伝票 → ${pages.length}ページ`);
    
    return pages;
  }, [getVouchersForPrint]);

  // 印刷プレビュー表示
  const handlePrintPreview = useCallback(() => {
    if (selectedForPrint.size === 0) {
      alert('印刷する申請を選択してください');
      return;
    }
    // 印刷データを固定保存
    const currentPrintData = getPaginatedVouchers();
    
    // 印刷プレビューデバッグ (簡素版)
    console.log(`印刷プレビュー: ${selectedForPrint.size}申請選択 → ${currentPrintData.length}ページ生成`);
    
    setPrintData(currentPrintData);
    setShowPrintPreview(true);
  }, [selectedForPrint, getPaginatedVouchers, getVouchersForPrint]);

  // 実際の印刷実行（印刷専用ウィンドウ使用）
  const executePrint = useCallback(async () => {
    const currentUser = await supabase.auth.getUser();
    
    console.log(`印刷実行: ${printData.length}ページ, ${selectedForPrint.size}件の申請`);
    console.log('印刷データ詳細:', printData);
    
    if (currentUser.data.user) {
      const updatePromises = Array.from(selectedForPrint).map(submissionId =>
        supabase
          .from('expenses')
          .update({
            printed_at: new Date().toISOString(),
            printed_by: currentUser.data.user?.id
          })
          .eq('id', submissionId)
      );
      
      await Promise.all(updatePromises);
    }

    // 印刷専用ウィンドウを作成
    const printWindow = window.open('', '_blank', 'width=800,height=600');
    if (!printWindow) {
      alert('ポップアップがブロックされました。ポップアップを許可してから再試行してください。');
      return;
    }

    // 印刷用HTMLを生成
    const printHTML = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>交通費請求明細書</title>
  <style>
    @page { 
      size: A4 portrait;
      margin: 5mm;
    }
    
    * {
      -webkit-print-color-adjust: exact !important;
      color-adjust: exact !important;
    }
    
    body {
      font-family: "MS Gothic", "Yu Gothic", monospace;
      margin: 0;
      padding: 0;
    }
    
    .print-page {
      page-break-before: auto;
      page-break-inside: avoid;
      page-break-after: always;
      width: 100%;
      height: 287mm;
      display: flex;
      flex-direction: column;
      justify-content: flex-start;
      align-items: center;
      padding: 0;
      margin: 0;
      overflow: hidden;
    }
    
    .print-page:last-child {
      page-break-after: avoid;
    }
    
    .print-voucher-grid {
      display: flex !important;
      justify-content: center;
      align-items: flex-start;
      width: 100%;
      height: 100%;
      margin: 0;
      padding: 2mm 0;
    }
    
    .print-voucher {
      width: 180mm !important;
      height: 280mm !important;
      max-height: 280mm !important;
      margin: 0 !important;
      overflow: hidden !important;
      border: 1px solid #000 !important;
      padding: 2mm !important;
      page-break-inside: avoid !important;
      page-break-after: avoid !important;
      display: flex !important;
      flex-direction: column !important;
      font-family: "MS Gothic", "Yu Gothic", monospace !important;
      color: #000 !important;
      background: white !important;
      box-sizing: border-box !important;
    }
    
    .print-voucher-header {
      text-align: center;
      font-weight: bold;
      margin-bottom: 2mm;
      border-bottom: 2px solid #000;
      padding-bottom: 1mm;
      color: #000 !important;
      white-space: nowrap;
      font-size: 18pt;
    }
    
    .print-title-main {
      font-size: 24pt;
    }
    
    .print-title-number {
      font-size: 16pt;
    }
    
    .print-title-page {
      font-size: 18pt;
      font-weight: bold;
    }
    
    .print-title-date {
      font-size: 14pt;
    }
    
    .print-voucher-content {
      display: flex;
      flex-direction: column;
    }
    
    .print-voucher-row {
      display: flex;
      justify-content: space-between;
      margin-bottom: 2mm;
      font-size: 16pt;
      font-weight: bold;
      color: #000 !important;
    }
    
    .print-expense-list {
      margin: 1mm 0 0 0;
    }
    
    .print-expense-item {
      display: grid;
      grid-template-columns: 12mm 30mm 1fr 30mm;
      gap: 1mm;
      margin-bottom: 0.3mm;
      align-items: flex-start;
      font-size: 12pt;
      min-height: 8mm;
      color: #000 !important;
    }
    
    .print-expense-number {
      text-align: center;
      font-weight: bold;
      border: 2px solid #000;
      padding: 0.5mm;
      color: #000 !important;
      background: white;
      font-size: 12pt;
    }
    
    .print-expense-type {
      text-align: center;
      padding: 0.5mm;
      border: 2px solid #000;
      color: #000 !important;
      font-size: 11pt;
      font-weight: bold;
    }
    
    .print-expense-detail {
      padding: 1mm;
      border: 2px solid #000;
      color: #000 !important;
      font-size: 10pt;
      line-height: 1.3;
      min-height: 8mm;
      display: flex;
      flex-direction: column;
      justify-content: flex-start;
      font-weight: 500;
    }
    
    .print-expense-amount {
      text-align: right;
      padding: 0.5mm;
      border: 2px solid #000;
      color: #000 !important;
      font-size: 14pt;
      font-weight: bold;
    }
    
    .print-voucher-amount {
      text-align: center;
      font-size: 20pt;
      font-weight: bold;
      margin: 2mm 0 0 0;
      padding: 3mm;
      border: 3px solid #000;
      color: #000 !important;
      background: #f0f0f0;
    }
    
    .print-voucher-footer {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8mm;
      font-size: 14pt;
      font-weight: bold;
      margin: 2mm 0 0 0;
      padding: 2mm 0;
      color: #000 !important;
    }
    
    .print-voucher-footer-item {
      display: flex;
      align-items: center;
      gap: 5mm;
    }
    
    .print-voucher-footer-space {
      border-bottom: 2px solid #000;
      height: 8mm;
      flex: 1;
    }
  </style>
</head>
<body>
${printData.map((page) => `
  <div class="print-page">
    <div class="print-voucher-grid">
      ${page.vouchers.map((voucher) => `
        <div class="print-voucher">
          <div class="print-voucher-header">
            [交通費請求明細書] ${voucher.voucherNumber} ${voucher.pageInfo || ''}
          </div>
          
          <div class="print-voucher-content">
            <div class="print-voucher-row">
              <span>申請者: ${voucher.submitterName}</span>
              <span>申請日: ${voucher.submittedDate}</span>
            </div>
            
            <div class="print-expense-list">
              ${Array.from({ length: 12 }, (_, i) => {
                const expense = voucher.expenses[i];
                return `
                  <div class="print-expense-item">
                    <div class="print-expense-number">
                      ${expense ? i + 1 : ''}
                    </div>
                    <div class="print-expense-type">
                      ${expense ? (expense.type === 'regular' ? '定期' : 
                                   expense.type === 'business_trip' ? '出張（園指導等）' : '通勤（単発）') : ''}
                    </div>
                    <div class="print-expense-detail">
                      ${expense ? `
                        <div>${expense.type === 'regular' && expense.start_date && expense.end_date ? 
                          `期間:${new Date(expense.start_date).toLocaleDateString('ja-JP', {year: 'numeric', month: '2-digit', day: '2-digit'})}~${new Date(expense.end_date).toLocaleDateString('ja-JP', {year: 'numeric', month: '2-digit', day: '2-digit'})}` :
                          expense.start_date ? `利用日:${new Date(expense.start_date).toLocaleDateString('ja-JP', {year: 'numeric', month: '2-digit', day: '2-digit'})}` : ''
                        }${expense.workplace ? ` 勤務先:${expense.workplace}` : ''}</div>
                        <div>${expense.transportation || ''} ${expense.from_station}→${expense.to_station}</div>
                        <div>${expense.notes || ''}</div>
                      ` : ''}
                    </div>
                    <div class="print-expense-amount">
                      ${expense ? `¥${parseInt(expense.amount || '0').toLocaleString()}` : ''}
                    </div>
                  </div>
                `;
              }).join('')}
            </div>
            
            <div class="print-voucher-amount">
              ${voucher.isLastPage ? 
                `申請合計: ¥${voucher.submissionTotal.toLocaleString()}` : 
                `ページ小計: ¥${voucher.total.toLocaleString()}`
              }
            </div>
            ${voucher.isLastPage && voucher.totalPages > 1 ? 
              `<div style="font-size: 12pt; text-align: center; margin-top: 2mm; padding: 1mm; border: 1px solid #000; background: #e0e0e0;">
                (このページ: ¥${voucher.total.toLocaleString()})
              </div>` : ''
            }
            
            <div class="print-voucher-footer">
              <div class="print-voucher-footer-item">
                <span>承認印:</span>
                <div class="print-voucher-footer-space"></div>
              </div>
              <div class="print-voucher-footer-item">
                <span>受付日:</span>
                <div class="print-voucher-footer-space"></div>
              </div>
            </div>
          </div>
        </div>
      `).join('')}
    </div>
  </div>
`).join('')}
</body>
</html>`;

    // HTMLを印刷ウィンドウに書き込み
    printWindow.document.write(printHTML);
    printWindow.document.close();

    // 印刷ウィンドウが読み込まれてから印刷実行
    printWindow.onload = () => {
      setTimeout(() => {
        printWindow.print();
        
        // 印刷実行後のイベントハンドラ
        printWindow.onafterprint = () => {
          // 印刷が実行された場合のみデータベース更新
          setShowPrintPreview(false);
          setSelectedForPrint(new Set());
          onRefresh();
          printWindow.close();
        };
        
        // 印刷ダイアログのキャンセルを検知するため、一定時間後にウィンドウの状態をチェック
        setTimeout(() => {
          // 印刷ダイアログが表示されてから3秒後に、まだウィンドウが開いていて印刷されていない場合
          if (!printWindow.closed) {
            // 印刷がキャンセルされた可能性が高い
            try {
              // フォーカスをチェックして印刷ダイアログの状態を確認
              printWindow.focus();
              
              // さらに少し待ってからウィンドウを閉じる
              setTimeout(() => {
                if (!printWindow.closed) {
                  setShowPrintPreview(false);
                  printWindow.close();
                }
              }, 1000);
            } catch (e) {
              // エラーが発生した場合もウィンドウを閉じる
              setShowPrintPreview(false);
              if (!printWindow.closed) {
                printWindow.close();
              }
            }
          }
        }, 3000);
        
        // ウィンドウが閉じられた場合のハンドラ
        printWindow.onbeforeunload = () => {
          setShowPrintPreview(false);
        };
      }, 500);
    };
  }, [selectedForPrint, onRefresh, printData]);

  // 印刷キャンセル
  const cancelPrint = useCallback(() => {
    setShowPrintPreview(false);
  }, []);

  // 全選択/全解除機能
  const handleSelectAll = useCallback(() => {
    const filteredSubmissions = getFilteredSubmissions();
    const allIds = new Set(filteredSubmissions.map(s => s.id));
    setSelectedForPrint(allIds);
  }, [getFilteredSubmissions]);

  // 承認待ち一覧のみ全選択
  const handleSelectPendingOnly = useCallback(() => {
    const pendingIds = new Set(filteredPending.map(p => p.id));
    setSelectedForPrint(pendingIds);
  }, [filteredPending]);

  const handleDeselectAll = useCallback(() => {
    setSelectedForPrint(new Set());
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

  // 申請内容編集開始
  const handleStartEdit = useCallback((submissionId: string, expensesData: any[]) => {
    setEditingSubmissionId(submissionId);
    setEditingExpenses([...expensesData]);
  }, []);

  // 申請内容編集キャンセル
  const handleCancelEdit = useCallback(() => {
    setEditingSubmissionId(null);
    setEditingExpenses([]);
  }, []);

  // 申請内容編集保存
  const handleSaveEdit = useCallback(async (submissionId: string) => {
    if (!window.confirm('申請内容を更新しますか？')) {
      return;
    }

    // まず現在のedit_countを取得
    const { data: currentData, error: fetchError } = await supabase
      .from('expenses')
      .select('edit_count')
      .eq('id', submissionId)
      .single();

    if (fetchError) {
      console.error('edit_count取得エラー:', fetchError);
    }

    const currentEditCount = currentData?.edit_count || 0;
    console.log('現在のedit_count:', currentEditCount);

    // 編集履歴も同時に更新
    const updateData = { 
      expenses_data: editingExpenses,
      last_edited_at: new Date().toISOString(),
      last_edited_by: '管理者',
      edit_count: currentEditCount + 1
    };
    
    console.log('更新データ:', updateData);

    const { error } = await supabase
      .from('expenses')
      .update(updateData)
      .eq('id', submissionId);

    if (error) {
      console.error('更新エラー:', error);
      alert('更新に失敗しました: ' + error.message);
    } else {
      console.log('更新成功');
      alert('申請内容を更新しました。');
      setEditingSubmissionId(null);
      setEditingExpenses([]);
      onRefresh();
    }
  }, [editingExpenses, onRefresh]);

  // 編集中の費用項目更新
  const handleUpdateEditingExpense = useCallback((index: number, field: string, value: string) => {
    setEditingExpenses(prev => {
      const updated = [...prev];
      updated[index] = { ...updated[index], [field]: value };
      return updated;
    });
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
    // 日付種別に応じてフィールドを選択
    const dateField = csvDateType === 'approved' ? 'approved_at' : 'created_at';

    let query = supabase
      .from('expenses')
      .select('*, profiles(name, email)')
      .eq('status', 'approved');

    if (csvStartDate) {
      query = query.gte(dateField, `${csvStartDate}T00:00:00Z`);
    }
    if (csvEndDate) {
      query = query.lte(dateField, `${csvEndDate}T23:59:59Z`);
    }

    const { data, error } = await query.order(dateField, { ascending: true });

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
  }, [csvStartDate, csvEndDate, csvDateType]);

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

  const groupedSubmissions = groupSubmissionsByYearAndMonth(getFilteredSubmissions());

  // ダークモード検出
  const isDarkMode = window.matchMedia('(prefers-color-scheme: dark)').matches;

  // タブのスタイル
  const tabStyle = (isActive: boolean) => ({
    padding: '12px 24px',
    marginRight: '4px',
    background: isActive ? '#007bff' : (isDarkMode ? '#495057' : '#f8f9fa'),
    color: isActive ? 'white' : (isDarkMode ? '#fff' : '#333'),
    border: `1px solid ${isActive ? '#007bff' : (isDarkMode ? '#6c757d' : '#dee2e6')}`,
    borderBottom: isActive ? 'none' : `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`,
    borderRadius: '8px 8px 0 0',
    cursor: 'pointer',
    fontSize: '16px',
    fontWeight: isActive ? 'bold' : 'normal',
    transition: 'all 0.2s ease'
  });

  const tabContentStyle = {
    border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`,
    borderTop: 'none',
    borderRadius: '0 8px 8px 8px',
    padding: '20px',
    background: isDarkMode ? '#343a40' : 'white',
    color: isDarkMode ? '#fff' : '#000',
    minHeight: '400px'
  };

  return (
    <div style={{ marginTop: 40, borderTop: '1px solid #eee', paddingTop: 20 }}>
      <style>{`
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
        
        @media print {
          @page { 
            size: A4 portrait;
            margin: 15mm;
          }
          
          * {
            -webkit-print-color-adjust: exact !important;
            color-adjust: exact !important;
          }
          
          body * {
            visibility: hidden !important;
          }
          
          .print-area, .print-area * {
            visibility: visible !important;
          }
          
          .print-area {
            position: absolute !important;
            left: 0 !important;
            top: 0 !important;
            width: 100% !important;
            height: auto !important;
            display: block !important;
          }
          
          .print-page {
            page-break-before: auto;
            page-break-inside: avoid;
            page-break-after: always;
            width: 100%;
            height: 297mm;
            display: flex;
            flex-direction: column;
            justify-content: flex-start;
            align-items: center;
            padding: 0;
            margin: 0;
            overflow: hidden;
          }
          
          .print-page:last-child {
            page-break-after: avoid;
          }
          
          .print-voucher-grid {
            display: flex !important;
            justify-content: center;
            align-items: flex-start;
            width: 100%;
            height: 100%;
            margin: 0;
            padding: 15mm 0;
          }
          
          .print-voucher {
            width: 150mm !important;
            height: 267mm !important;
            max-height: 267mm !important;
            margin: 0 !important;
            overflow: hidden !important;
            border: 1px solid #000 !important;
            padding: 2mm !important;
            page-break-inside: avoid !important;
            page-break-after: avoid !important;
            display: flex !important;
            flex-direction: column !important;
            font-family: "MS Gothic", "Yu Gothic", monospace !important;
            color: #000 !important;
            background: white !important;
            box-sizing: border-box !important;
          }
          
          .print-voucher-header {
            text-align: center;
            font-size: 14pt;
            font-weight: bold;
            margin-bottom: 2mm;
            border-bottom: 1px solid #000;
            padding-bottom: 1mm;
            color: #000 !important;
          }
          
          .print-voucher-content {
            display: flex;
            flex-direction: column;
          }
          
          .print-voucher-row {
            display: flex;
            justify-content: space-between;
            margin-bottom: 2mm;
            font-size: 10pt;
            color: #000 !important;
          }
          
          .print-expense-list {
            margin: 1mm 0 0 0;
          }
          
          .print-expense-item {
            display: grid;
            grid-template-columns: 15mm 25mm 1fr 25mm;
            gap: 0.5mm;
            margin-bottom: 0.3mm;
            align-items: center;
            font-size: 7pt;
            min-height: 5mm;
            color: #000 !important;
          }
          
          .print-expense-number {
            text-align: center;
            font-weight: bold;
            border: 1px solid #000;
            padding: 0.1mm;
            color: #000 !important;
            background: white;
            font-size: 5pt;
          }
          
          .print-expense-type {
            text-align: center;
            padding: 0.1mm;
            border: 1px solid #000;
            color: #000 !important;
            font-size: 7pt;
            font-weight: bold;
          }
          
          .print-expense-detail {
            padding: 0.1mm;
            border: 1px solid #000;
            color: #000 !important;
            font-size: 7pt;
            line-height: 1.3;
            min-height: 5mm;
            display: flex;
            flex-direction: column;
            justify-content: center;
          }
          
          .print-expense-amount {
            text-align: right;
            padding: 0.1mm;
            border: 1px solid #000;
            color: #000 !important;
            font-size: 7pt;
          }
          
          .print-voucher-amount {
            text-align: center;
            font-size: 10pt;
            font-weight: bold;
            margin: 1mm 0 0 0;
            padding: 2mm;
            border: 1px solid #000;
            color: #000 !important;
            background: #f8f8f8;
          }
          
          .print-voucher-footer {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 8mm;
            font-size: 8pt;
            margin: 1mm 0 0 0;
            padding: 1mm 0;
            color: #000 !important;
          }
          
          .print-voucher-footer-item {
            display: flex;
            align-items: center;
            gap: 5mm;
          }
          
          .print-voucher-footer-space {
            border-bottom: 1px solid #000;
            height: 5mm;
            flex: 1;
          }
        }
        
        @media screen {
          .print-area {
            display: none !important;
          }
        }
        
        @media print {
          html, body {
            width: 100% !important;
            height: auto !important;
            margin: 0 !important;
            padding: 0 !important;
          }
        }
        
        /* プレビュー用スタイル */
        .preview-modal {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          backgroundColor: rgba(0, 0, 0, 0.5);
          display: flex;
          alignItems: center;
          justifyContent: center;
          z-index: 1000;
        }
        
        .preview-content {
          width: 90vw;
          height: 95vh;
          backgroundColor: white;
          borderRadius: 8px;
          padding: 20px;
          position: relative;
          overflow-y: auto;
          overflow-x: hidden;
        }
        
        .preview-page {
          width: 210mm;
          height: 297mm;
          border: 1px solid #ddd;
          background: white;
          margin: 0 auto 20px auto;
          position: relative;
          transform: scale(0.5);
          transform-origin: top center;
        }
        
        .preview-voucher-grid {
          display: flex;
          justify-content: center;
          align-items: flex-start;
          padding: 15mm;
          width: 100%;
          height: 100%;
        }
        
        .preview-voucher-grid .print-voucher {
          width: 150mm;
          height: 267mm;
          max-width: 150mm;
          max-height: 267mm;
          border: 1px solid #000;
          padding: 2mm;
          display: flex;
          flex-direction: column;
          font-family: "MS Gothic", "Yu Gothic", monospace;
          color: #000 !important;
          background: white;
          font-size: 8pt;
          overflow: hidden;
          box-sizing: border-box;
        }
        
        .preview-voucher-grid .print-voucher-header {
          text-align: center;
          font-size: 8pt;
          font-weight: bold;
          margin-bottom: 1mm;
          border-bottom: 1px solid #000;
          padding-bottom: 0.5mm;
          color: #000 !important;
        }
        
        .preview-voucher-grid .print-expense-item {
          display: grid;
          grid-template-columns: 15mm 25mm 1fr 25mm;
          gap: 0.5mm;
          margin-bottom: 0.3mm;
          align-items: center;
          font-size: 7pt;
          min-height: 5mm;
          color: #000 !important;
        }
        
        .preview-voucher-grid .print-expense-number,
        .preview-voucher-grid .print-expense-type,
        .preview-voucher-grid .print-expense-detail,
        .preview-voucher-grid .print-expense-amount {
          border: 1px solid #000;
          padding: 0.1mm;
          color: #000 !important;
          font-size: 7pt;
        }
        
        .preview-voucher-grid .print-expense-type {
          text-align: center;
          font-weight: bold;
        }
      `}</style>
      <h2 style={{ textAlign: 'center', marginBottom: '30px', color: isDarkMode ? '#fff' : '#000' }}>管理画面</h2>
      
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
            backgroundColor: isDarkMode ? '#343a40' : 'white',
            color: isDarkMode ? '#fff' : '#000',
            padding: '30px',
            borderRadius: '8px',
            width: '90%',
            maxWidth: '500px',
            boxShadow: '0 4px 6px rgba(0, 0, 0, 0.1)'
          }}>
            <h3 style={{ marginBottom: '20px', textAlign: 'center', color: isDarkMode ? '#fff' : '#000' }}>却下理由を入力</h3>
            <textarea
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="却下理由を入力してください（省略可）"
              style={{
                width: '100%',
                minHeight: '100px',
                padding: '10px',
                border: `1px solid ${isDarkMode ? '#6c757d' : '#ccc'}`,
                borderRadius: '4px',
                marginBottom: '20px',
                resize: 'vertical',
                backgroundColor: isDarkMode ? '#495057' : 'white',
                color: isDarkMode ? '#fff' : '#000'
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
            <h3 style={{ textAlign: 'center', marginBottom: '30px', color: isDarkMode ? '#fff' : '#000' }}>承認管理</h3>
            
            {/* CSV出力セクション */}
            <div style={{ textAlign: 'center', marginBottom: 20 }}>
              {/* 日付種別選択（ラジオボタン） */}
              <div style={{ marginBottom: 15 }}>
                <label style={{ color: isDarkMode ? '#fff' : '#000', fontWeight: 'bold', marginRight: 20 }}>抽出基準:</label>
                <label style={{ marginRight: 20, color: isDarkMode ? '#fff' : '#000', cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name="csvDateType"
                    value="approved"
                    checked={csvDateType === 'approved'}
                    onChange={(e) => setCsvDateType(e.target.value as 'created' | 'approved')}
                    style={{ marginRight: 5 }}
                  />
                  承認日
                </label>
                <label style={{ color: isDarkMode ? '#fff' : '#000', cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name="csvDateType"
                    value="created"
                    checked={csvDateType === 'created'}
                    onChange={(e) => setCsvDateType(e.target.value as 'created' | 'approved')}
                    style={{ marginRight: 5 }}
                  />
                  申請日
                </label>
              </div>
              <div style={{ marginBottom: 10 }}>
                <label htmlFor="csvStartDate" style={{ color: isDarkMode ? '#fff' : '#000' }}>開始日:</label>
                <input
                  type="date"
                  id="csvStartDate"
                  value={csvStartDate}
                  onChange={(e) => setCsvStartDate(e.target.value)}
                  style={{
                    marginRight: 10,
                    padding: 5,
                    backgroundColor: isDarkMode ? '#495057' : 'white',
                    color: isDarkMode ? '#fff' : '#000',
                    border: `1px solid ${isDarkMode ? '#6c757d' : '#ccc'}`
                  }}
                />
                <label htmlFor="csvEndDate" style={{ color: isDarkMode ? '#fff' : '#000' }}>終了日:</label>
                <input
                  type="date"
                  id="csvEndDate"
                  value={csvEndDate}
                  onChange={(e) => setCsvEndDate(e.target.value)}
                  style={{
                    padding: 5,
                    backgroundColor: isDarkMode ? '#495057' : 'white',
                    color: isDarkMode ? '#fff' : '#000',
                    border: `1px solid ${isDarkMode ? '#6c757d' : '#ccc'}`
                  }}
                />
              </div>
              <button onClick={handleExportCsv}>承認済みCSV出力</button>
            </div>
            
            {/* フィルターセクション */}
            <div style={{
              display: 'flex',
              justifyContent: 'center',
              gap: '20px',
              marginBottom: '20px',
              alignItems: 'center'
            }}>
              <div>
                <label htmlFor="typeFilter" style={{ marginRight: '8px', color: isDarkMode ? '#fff' : '#000' }}>申請種別:</label>
                <select
                  id="typeFilter"
                  value={typeFilter}
                  onChange={(e) => setTypeFilter(e.target.value)}
                  style={{
                    padding: '6px 10px',
                    borderRadius: '4px',
                    border: `1px solid ${isDarkMode ? '#6c757d' : '#ccc'}`,
                    backgroundColor: isDarkMode ? '#495057' : 'white',
                    color: isDarkMode ? '#fff' : '#000'
                  }}
                >
                  <option value="all">すべて</option>
                  <option value="one_time">通勤（単発）</option>
                  <option value="regular">定期</option>
                  <option value="business_trip">出張（園指導等）</option>
                </select>
              </div>
              <div>
                <label htmlFor="statusFilter" style={{ marginRight: '8px', color: isDarkMode ? '#fff' : '#000' }}>ステータス:</label>
                <select
                  id="statusFilter"
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                  style={{
                    padding: '6px 10px',
                    borderRadius: '4px',
                    border: `1px solid ${isDarkMode ? '#6c757d' : '#ccc'}`,
                    backgroundColor: isDarkMode ? '#495057' : 'white',
                    color: isDarkMode ? '#fff' : '#000'
                  }}
                >
                  <option value="all">すべて</option>
                  <option value="pending">申請中</option>
                  <option value="approved">承認済み</option>
                  <option value="rejected">却下</option>
                </select>
              </div>
            </div>

            {/* 承認待ち一覧 */}
            <h4 style={{ textAlign: 'left', color: isDarkMode ? '#fff' : '#000' }}>承認待ち一覧</h4>
            {isLoading ? (
              <p style={{ textAlign: 'left', color: isDarkMode ? '#fff' : '#000' }}>読み込み中...</p>
            ) : (
              <div>
                {filteredPending.length > 0 && (
                  <>
                    {/* 印刷操作ボタン */}
                    <div style={{ marginBottom: '10px', padding: '10px', backgroundColor: '#f8f9fa', borderRadius: '4px' }}>
                      <strong>印刷操作:</strong>
                      <button 
                        onClick={handlePrintPreview}
                        style={{ 
                          padding: '8px 16px', 
                          marginLeft: '10px',
                          marginRight: '8px', 
                          backgroundColor: '#17a2b8', 
                          color: 'white', 
                          border: 'none', 
                          borderRadius: '4px',
                          cursor: 'pointer'
                        }}
                      >
                        選択印刷 ({selectedForPrint.size})
                      </button>
                      <button 
                        onClick={handleSelectPendingOnly}
                        style={{ 
                          padding: '8px 16px', 
                          marginRight: '8px', 
                          backgroundColor: '#6c757d', 
                          color: 'white', 
                          border: 'none', 
                          borderRadius: '4px',
                          cursor: 'pointer'
                        }}
                      >
                        承認待ち全選択
                      </button>
                      <button 
                        onClick={handleSelectAll}
                        style={{ 
                          padding: '8px 16px', 
                          marginRight: '8px', 
                          backgroundColor: '#6c757d', 
                          color: 'white', 
                          border: 'none', 
                          borderRadius: '4px',
                          cursor: 'pointer'
                        }}
                      >
                        全選択
                      </button>
                      <button 
                        onClick={handleDeselectAll}
                        style={{ 
                          padding: '8px 16px', 
                          backgroundColor: '#6c757d', 
                          color: 'white', 
                          border: 'none', 
                          borderRadius: '4px',
                          cursor: 'pointer'
                        }}
                      >
                        全解除
                      </button>
                    </div>
                    
                    {/* 承認・却下操作ボタン */}
                    <div style={{ marginBottom: '20px' }}>
                      <strong>承認操作:</strong>
                      <button 
                        onClick={() => handleBulkApproval('approved')}
                        style={{ 
                          padding: '10px 20px', 
                          marginLeft: '10px',
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
                  </>
                )}
                <ul style={{ listStyle: 'none', padding: 0, textAlign: 'left' }}>
                  {filteredPending.map(p => (
                    <li key={p.id} style={{ border: '1px solid #ccc', padding: 10, marginBottom: 10, borderRadius: 4 }}>
                      <div style={{ display: 'flex', alignItems: 'center', marginBottom: '8px' }}>
                        <input
                          type="checkbox"
                          checked={selectedForPrint.has(p.id)}
                          onChange={(e) => handlePrintSelect(p.id, e.target.checked)}
                          style={{ marginRight: '8px' }}
                        />
                        <label style={{ fontWeight: 'bold' }}>印刷選択</label>
                        {p.printed_at && (
                          <span style={{ 
                            marginLeft: '10px', 
                            padding: '2px 6px', 
                            backgroundColor: '#28a745', 
                            color: 'white', 
                            borderRadius: '3px', 
                            fontSize: '12px',
                            fontWeight: 'bold',
                            cursor: 'pointer'
                          }}
                          title={`印刷日時: ${new Date(p.printed_at).toLocaleString()}`}
                          >
                            ✓ 印刷済み ({new Date(p.printed_at).toLocaleString()})
                          </span>
                        )}
                      </div>
                      <strong>申請者:</strong> {p.profiles?.name || p.profiles?.email || '不明'} <br />
                      <strong>申請日:</strong> {new Date(p.created_at).toLocaleString()} <br />
                      <strong>ステータス:</strong> {
                        p.status === 'pending' ? '申請中' : 
                        p.status === 'approved' ? <span style={{ color: '#007bff', fontWeight: 'bold' }}>承認</span> : 
                        <span style={{ color: '#dc3545', fontWeight: 'bold' }}>却下</span>
                      } <br />
                      <strong>合計金額:</strong> {formatAmount(p.expenses_data.reduce((sum, exp) => sum + (parseInt(exp.amount || '0') || 0), 0).toString())}円 <br />
                      {p.printed_at && (
                        <><strong>印刷日時:</strong> {new Date(p.printed_at).toLocaleString()} <br /></>
                      )}
                      {p.printed_by && (
                        <><strong>印刷者ID:</strong> {p.printed_by} <br /></>
                      )}
                      {((p.edit_count && p.edit_count > 0) || p.last_edited_at) && (
                        <>
                          <span style={{ 
                            backgroundColor: '#ffc107', 
                            color: '#000', 
                            padding: '2px 6px', 
                            borderRadius: '4px', 
                            fontSize: '12px',
                            fontWeight: 'bold'
                          }}>
                            編集済み ({p.edit_count || 0}回)
                          </span> <br />
                          <strong>最終編集:</strong> {(() => {
                            if (!p.last_edited_at) return '';
                            const utcDate = new Date(p.last_edited_at);
                            const jpDate = new Date(utcDate.getTime() + (9 * 60 * 60 * 1000)); // UTC+9
                            return jpDate.toLocaleString('ja-JP').replace(/\//g, '/');
                          })()} ({p.last_edited_by || ''}) <br />
                        </>
                      )}
                      {p.approved_at && (
                        <><strong>承認日:</strong> {new Date(p.approved_at).toLocaleString()} <br /></>
                      )}
                      {p.rejected_at && (
                        <><strong>却下日:</strong> {new Date(p.rejected_at).toLocaleString()} <br /></>
                      )}
                      {p.rejected_reason && (
                        <><strong>却下理由:</strong> {p.rejected_reason} <br /></>
                      )}
                      <ul>
                        {p.expenses_data.map((e, i) => (
                          <li key={i}>
                            {e.type === 'regular' ? '定期' : e.type === 'business_trip' ? '出張（園指導等）' : '通勤（単発）'}: 
                            {e.type === 'regular' 
                              ? `${e.start_date || '未設定'} ~ ${e.end_date || '未設定'}` 
                              : `${e.start_date || '未設定'}`
                            } | 
                            {e.transportation && `[${e.transportation}] `}
                            {e.from_station} - {e.to_station}: {e.amount}円
                            {e.workplace && ` [勤務先: ${e.workplace}]`}
                            {e.notes && ` (備考: ${e.notes})`}
                          </li>
                        ))}
                      </ul>
                      <button 
                        onClick={() => handleApproval(p.id, 'approved')} 
                        style={{ 
                          marginRight: 10, 
                          padding: '8px 16px',
                          backgroundColor: '#28a745',
                          color: 'white',
                          border: '2px solid #1e7e34',
                          borderRadius: '4px',
                          cursor: 'pointer',
                          fontWeight: 'bold'
                        }}
                      >
                        承認
                      </button>
                      <button 
                        onClick={() => handleIndividualReject(p.id)}
                        style={{ 
                          marginRight: 10,
                          padding: '8px 16px',
                          backgroundColor: '#dc3545',
                          color: 'white',
                          border: '2px solid #bd2130',
                          borderRadius: '4px',
                          cursor: 'pointer',
                          fontWeight: 'bold'
                        }}
                      >
                        却下
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* すべての申請履歴 */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 40 }}>
              <h4 style={{ textAlign: 'left', margin: 0, color: isDarkMode ? '#fff' : '#000' }}>すべての申請履歴</h4>
              <div>
                <button 
                  onClick={handlePrintPreview}
                  style={{ 
                    padding: '8px 16px', 
                    marginRight: '8px',
                    backgroundColor: '#17a2b8', 
                    color: 'white', 
                    border: 'none', 
                    borderRadius: '4px',
                    cursor: 'pointer'
                  }}
                >
                  選択印刷 ({selectedForPrint.size})
                </button>
                <button 
                  onClick={handleSelectAll}
                  style={{ 
                    padding: '8px 16px', 
                    marginRight: '8px',
                    backgroundColor: '#6c757d', 
                    color: 'white', 
                    border: 'none', 
                    borderRadius: '4px',
                    cursor: 'pointer'
                  }}
                >
                  全選択
                </button>
                <button 
                  onClick={handleDeselectAll}
                  style={{ 
                    padding: '8px 16px', 
                    backgroundColor: '#6c757d', 
                    color: 'white', 
                    border: 'none', 
                    borderRadius: '4px',
                    cursor: 'pointer'
                  }}
                >
                  全解除
                </button>
              </div>
            </div>
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
                                    <div style={{ display: 'flex', alignItems: 'center', marginBottom: '8px' }}>
                                      <input
                                        type="checkbox"
                                        checked={selectedForPrint.has(s.id)}
                                        onChange={(e) => handlePrintSelect(s.id, e.target.checked)}
                                        style={{ marginRight: '8px' }}
                                      />
                                      <label style={{ fontWeight: 'bold' }}>印刷選択</label>
                                      {s.printed_at && (
                                        <span style={{ 
                                          marginLeft: '10px', 
                                          padding: '2px 6px', 
                                          backgroundColor: '#28a745', 
                                          color: 'white', 
                                          borderRadius: '3px', 
                                          fontSize: '12px',
                                          fontWeight: 'bold',
                                          cursor: 'pointer'
                                        }}
                                        title={`印刷日時: ${new Date(s.printed_at).toLocaleString()}`}
                                        >
                                          ✓ 印刷済み ({new Date(s.printed_at).toLocaleString()})
                                        </span>
                                      )}
                                    </div>
                                    <strong>申請者:</strong> {s.profiles?.name || s.profiles?.email || '不明'} <br />
                                    <strong>申請日:</strong> {new Date(s.created_at).toLocaleString()} <br />
                                    <strong>ステータス:</strong> {
                                      s.status === 'pending' ? '申請中' : 
                                      s.status === 'approved' ? <span style={{ color: '#007bff', fontWeight: 'bold' }}>承認</span> : 
                                      <span style={{ color: '#dc3545', fontWeight: 'bold' }}>却下</span>
                                    } <br />
                                    <strong>合計金額:</strong> {formatAmount(s.expenses_data.reduce((sum, exp) => sum + (parseInt(exp.amount || '0') || 0), 0).toString())}円 <br />
                                    {s.printed_at && (
                                      <><strong>印刷日時:</strong> {new Date(s.printed_at).toLocaleString()} <br /></>
                                    )}
                                    {s.printed_by && (
                                      <><strong>印刷者ID:</strong> {s.printed_by} <br /></>
                                    )}
                                    {((s.edit_count && s.edit_count > 0) || s.last_edited_at) && (
                                      <>
                                        <span style={{ 
                                          backgroundColor: '#ffc107', 
                                          color: '#000', 
                                          padding: '2px 6px', 
                                          borderRadius: '4px', 
                                          fontSize: '12px',
                                          fontWeight: 'bold'
                                        }}>
                                          編集済み ({s.edit_count || 0}回)
                                        </span> <br />
                                        <strong>最終編集:</strong> {(() => {
                                          if (!s.last_edited_at) return '';
                                          const utcDate = new Date(s.last_edited_at);
                                          const jpDate = new Date(utcDate.getTime() + (9 * 60 * 60 * 1000)); // UTC+9
                                          return jpDate.toLocaleString('ja-JP').replace(/\//g, '/');
                                        })()} ({s.last_edited_by || ''}) <br />
                                      </>
                                    )}
                                    {s.approved_at && (
                                      <><strong>承認日:</strong> {new Date(s.approved_at).toLocaleString()} <br /></>
                                    )}
                                    {s.rejected_at && (
                                      <><strong>却下日:</strong> {new Date(s.rejected_at).toLocaleString()} <br /></>
                                    )}
                                    <ul>
                                      {(editingSubmissionId === s.id ? editingExpenses : s.expenses_data).map((e, i) => (
                                        <li key={i} style={{ marginBottom: '10px' }}>
                                          {editingSubmissionId === s.id ? (
                                            <div style={{ border: '1px solid #ddd', padding: '10px', borderRadius: '4px', backgroundColor: '#f8f9fa' }}>
                                              <div style={{ marginBottom: '8px' }}>
                                                <strong>申請種別:</strong>
                                                <select
                                                  value={e.type || 'commute'}
                                                  onChange={(event) => handleUpdateEditingExpense(i, 'type', event.target.value)}
                                                  style={{ marginLeft: '10px', padding: '4px' }}
                                                >
                                                  <option value="commute">通勤（単発）</option>
                                                  <option value="regular">定期</option>
                                                  <option value="business_trip">出張（園指導等）</option>
                                                </select>
                                              </div>
                                              <div style={{ marginBottom: '8px' }}>
                                                <strong>日付:</strong>
                                                <input
                                                  type="date"
                                                  value={e.start_date || ''}
                                                  onChange={(event) => handleUpdateEditingExpense(i, 'start_date', event.target.value)}
                                                  style={{ marginLeft: '10px', padding: '4px' }}
                                                />
                                                {e.type === 'regular' && (
                                                  <>
                                                    <span style={{ margin: '0 10px' }}>〜</span>
                                                    <input
                                                      type="date"
                                                      value={e.end_date || ''}
                                                      onChange={(event) => handleUpdateEditingExpense(i, 'end_date', event.target.value)}
                                                      style={{ padding: '4px' }}
                                                    />
                                                  </>
                                                )}
                                              </div>
                                              <div style={{ marginBottom: '8px' }}>
                                                <strong>交通手段:</strong>
                                                <input
                                                  type="text"
                                                  value={e.transportation || ''}
                                                  onChange={(event) => handleUpdateEditingExpense(i, 'transportation', event.target.value)}
                                                  style={{ marginLeft: '10px', padding: '4px', width: '100px' }}
                                                />
                                              </div>
                                              <div style={{ marginBottom: '8px' }}>
                                                <strong>出発地:</strong>
                                                <input
                                                  type="text"
                                                  value={e.from_station || ''}
                                                  onChange={(event) => handleUpdateEditingExpense(i, 'from_station', event.target.value)}
                                                  style={{ marginLeft: '10px', padding: '4px', width: '120px' }}
                                                />
                                                <strong style={{ marginLeft: '10px' }}>到着地:</strong>
                                                <input
                                                  type="text"
                                                  value={e.to_station || ''}
                                                  onChange={(event) => handleUpdateEditingExpense(i, 'to_station', event.target.value)}
                                                  style={{ marginLeft: '10px', padding: '4px', width: '120px' }}
                                                />
                                              </div>
                                              <div style={{ marginBottom: '8px' }}>
                                                <strong>金額:</strong>
                                                <input
                                                  type="number"
                                                  value={e.amount || ''}
                                                  onChange={(event) => handleUpdateEditingExpense(i, 'amount', event.target.value)}
                                                  style={{ marginLeft: '10px', padding: '4px', width: '80px' }}
                                                />円
                                                <strong style={{ marginLeft: '20px' }}>勤務先:</strong>
                                                <input
                                                  type="text"
                                                  value={e.workplace || ''}
                                                  onChange={(event) => handleUpdateEditingExpense(i, 'workplace', event.target.value)}
                                                  style={{ marginLeft: '10px', padding: '4px', width: '100px' }}
                                                />
                                              </div>
                                              <div>
                                                <strong>備考:</strong>
                                                <input
                                                  type="text"
                                                  value={e.notes || ''}
                                                  onChange={(event) => handleUpdateEditingExpense(i, 'notes', event.target.value)}
                                                  style={{ marginLeft: '10px', padding: '4px', width: '200px' }}
                                                />
                                              </div>
                                            </div>
                                          ) : (
                                            <>
                                              {e.type === 'regular' ? '定期' : e.type === 'business_trip' ? '出張（園指導等）' : '通勤（単発）'}: 
                                              {e.type === 'regular' 
                                                ? `${e.start_date || '未設定'} ~ ${e.end_date || '未設定'}` 
                                                : `${e.start_date || '未設定'}`
                                              } | 
                                              {e.transportation && `[${e.transportation}] `}
                                              {e.from_station} - {e.to_station}: {e.amount}円
                                              {e.workplace && ` [勤務先: ${e.workplace}]`}
                                              {e.notes && ` (備考: ${e.notes})`}
                                            </>
                                          )}
                                        </li>
                                      ))}
                                    </ul>
                                    <div style={{ marginTop: 10 }}>
                                      {editingSubmissionId === s.id ? (
                                        <div>
                                          <button 
                                            onClick={() => handleSaveEdit(s.id)}
                                            style={{ 
                                              marginRight: 10, 
                                              padding: '8px 16px', 
                                              backgroundColor: '#28a745', 
                                              color: 'white', 
                                              border: 'none', 
                                              borderRadius: 4, 
                                              cursor: 'pointer',
                                              fontWeight: 'bold'
                                            }}
                                          >
                                            保存
                                          </button>
                                          <button 
                                            onClick={handleCancelEdit}
                                            style={{ 
                                              padding: '8px 16px', 
                                              backgroundColor: '#6c757d', 
                                              color: 'white', 
                                              border: 'none', 
                                              borderRadius: 4, 
                                              cursor: 'pointer' 
                                            }}
                                          >
                                            キャンセル
                                          </button>
                                        </div>
                                      ) : (
                                        <div>
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
                                          {(s.status === 'approved' || s.status === 'rejected') && (
                                            <button 
                                              onClick={() => handleStartEdit(s.id, s.expenses_data)}
                                              style={{ 
                                                marginLeft: 10, 
                                                padding: '8px 12px', 
                                                backgroundColor: '#007bff', 
                                                color: 'white', 
                                                border: 'none', 
                                                borderRadius: 4, 
                                                cursor: 'pointer' 
                                              }}
                                            >
                                              編集
                                            </button>
                                          )}
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
                                      )}
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
            <h3 style={{ textAlign: 'center', marginBottom: '30px', color: isDarkMode ? '#fff' : '#000' }}>ユーザー管理</h3>
            {loadingUsers ? (
              <p style={{ textAlign: 'center', color: isDarkMode ? '#fff' : '#000' }}>読み込み中...</p>
            ) : (
              <div>
                <div style={{ marginBottom: '20px', textAlign: 'center' }}>
                  <p style={{ color: isDarkMode ? '#fff' : '#000' }}>
                    現役: {users.filter(u => u.is_active !== false).length}人 ／ 退職済み: {users.filter(u => u.is_active === false).length}人
                  </p>
                  <div style={{ display: 'flex', justifyContent: 'center', gap: '8px', flexWrap: 'wrap' }}>
                    <button
                      onClick={() => setShowRetired(!showRetired)}
                      style={{
                        padding: '8px 16px',
                        background: showRetired ? '#6c757d' : '#17a2b8',
                        color: 'white',
                        border: 'none',
                        borderRadius: '4px',
                        cursor: 'pointer'
                      }}
                    >
                      {showRetired ? '現役のみ表示' : '退職者も表示'}
                    </button>
                    <button onClick={fetchUsers} style={{ padding: '8px 16px' }}>更新</button>
                  </div>
                </div>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ backgroundColor: isDarkMode ? '#495057' : '#f8f9fa' }}>
                        <th style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '12px', textAlign: 'left', color: isDarkMode ? '#fff' : '#000' }}>名前</th>
                        <th style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '12px', textAlign: 'left', color: isDarkMode ? '#fff' : '#000' }}>メールアドレス</th>
                        <th style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '12px', textAlign: 'left', color: isDarkMode ? '#fff' : '#000' }}>申請数</th>
                        <th style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '12px', textAlign: 'left', color: isDarkMode ? '#fff' : '#000' }}>権限</th>
                        <th style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '12px', textAlign: 'left', color: isDarkMode ? '#fff' : '#000' }}>状態</th>
                        <th style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '12px', textAlign: 'left', color: isDarkMode ? '#fff' : '#000' }}>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {users.filter(u => showRetired ? true : u.is_active !== false).map(user => (
                        <tr key={user.id} style={{ opacity: user.is_active === false ? 0.6 : 1 }}>
                          <td style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '12px', color: isDarkMode ? '#fff' : '#000' }}>
                            {editingUser === user.id ? (
                              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                <input
                                  type="text"
                                  value={editName}
                                  onChange={(e) => setEditName(e.target.value)}
                                  style={{
                                    flex: 1,
                                    padding: '4px 8px',
                                    border: `1px solid ${isDarkMode ? '#6c757d' : '#ccc'}`,
                                    borderRadius: '4px',
                                    fontSize: '14px',
                                    backgroundColor: isDarkMode ? '#495057' : 'white',
                                    color: isDarkMode ? '#fff' : '#000'
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
                                  onClick={handleCancelUserEdit}
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
                                <span style={{ color: isDarkMode ? '#fff' : '#000' }}>{user.name || '未設定'}</span>
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
                          <td style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '12px', color: isDarkMode ? '#fff' : '#000' }}>
                            {user.email}
                          </td>
                          <td style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '12px', color: isDarkMode ? '#fff' : '#000' }}>
                            {submissions.filter(s => s.profiles?.email === user.email).length}
                          </td>
                          <td style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '12px', color: isDarkMode ? '#fff' : '#000' }}>
                            {user.email === 'fivem.kyoto@gmail.com' ? '管理者' : '一般ユーザー'}
                          </td>
                          <td style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '12px' }}>
                            {user.is_active === false ? (
                              <span style={{ color: '#dc3545', fontWeight: 'bold', fontSize: '12px' }}>退職済み</span>
                            ) : (
                              <span style={{ color: '#28a745', fontWeight: 'bold', fontSize: '12px' }}>現役</span>
                            )}
                          </td>
                          <td style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '12px', color: isDarkMode ? '#fff' : '#000' }}>
                            <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                              <button
                                style={{
                                  padding: '4px 8px',
                                  background: '#17a2b8',
                                  color: 'white',
                                  border: 'none',
                                  borderRadius: '4px',
                                  cursor: 'pointer',
                                  fontSize: '12px'
                                }}
                                onClick={() => setActiveTab('reports')}
                              >
                                履歴確認
                              </button>
                              {user.email !== 'fivem.kyoto@gmail.com' && (
                                <>
                                  <button
                                    style={{
                                      padding: '4px 8px',
                                      background: user.is_active === false ? '#28a745' : '#fd7e14',
                                      color: 'white',
                                      border: 'none',
                                      borderRadius: '4px',
                                      cursor: 'pointer',
                                      fontSize: '12px'
                                    }}
                                    onClick={() => handleToggleActive(user.id, user.is_active !== false)}
                                  >
                                    {user.is_active === false ? '復活' : '退職'}
                                  </button>
                                  {user.is_active === false && (
                                    <button
                                      style={{
                                        padding: '4px 8px',
                                        background: '#dc3545',
                                        color: 'white',
                                        border: 'none',
                                        borderRadius: '4px',
                                        cursor: 'pointer',
                                        fontSize: '12px'
                                      }}
                                      onClick={() => handleDeleteUser(user.id, user.name || user.email)}
                                    >
                                      完全削除
                                    </button>
                                  )}
                                </>
                              )}
                            </div>
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
                        {reportStats.userStats.map((user: any, index: number) => (
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
                        {reportStats.monthlyStats.map((month: any, index: number) => (
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
        )}
      </div>

      {/* 印刷プレビューモーダル */}
      {showPrintPreview && (
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
          <div className="preview-content">
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: '20px',
              borderBottom: '1px solid #ddd',
              paddingBottom: '10px'
            }}>
              <h3>印刷プレビュー (A4)</h3>
              <div>
                <button 
                  onClick={executePrint}
                  style={{
                    padding: '8px 16px',
                    marginRight: '10px',
                    backgroundColor: '#007bff',
                    color: 'white',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: 'pointer'
                  }}
                >
                  印刷実行
                </button>
                <button 
                  onClick={cancelPrint}
                  style={{
                    padding: '8px 16px',
                    backgroundColor: '#6c757d',
                    color: 'white',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: 'pointer'
                  }}
                >
                  キャンセル
                </button>
              </div>
            </div>
            
            {printData.map((page, pageIndex) => (
              <div key={pageIndex} className="preview-page">
                <div style={{ 
                  position: 'absolute', 
                  top: '5mm', 
                  right: '5mm', 
                  fontSize: '12px', 
                  color: '#666',
                  zIndex: 10 
                }}>
                  ページ {pageIndex + 1} / {printData.length}
                </div>
                <div className="preview-voucher-grid">
                  {page.vouchers.map((voucher, index) => (
                <div key={index} className="print-voucher">
                  <div className="print-voucher-header">
                    交通費請求明細書 #{voucher.voucherNumber}
                    {voucher.pageInfo && <span style={{ marginLeft: '10px', fontSize: '6pt' }}>({voucher.pageInfo})</span>}
                  </div>
                  
                  <div className="print-voucher-content">
                    <div className="print-voucher-row">
                      <span>申請者: {voucher.submitterName}</span>
                      <span>申請日: {voucher.submittedDate}</span>
                    </div>
                    
                    <div className="print-expense-list">
                      {Array.from({ length: 20 }, (_, i) => {
                        const expense = voucher.expenses[i];
                        return (
                          <div key={i} className="print-expense-item">
                            <div className="print-expense-number">
                              {expense ? i + 1 : ''}
                            </div>
                            <div className="print-expense-type">
                              {expense ? (expense.type === 'regular' ? '定期' : 
                                         expense.type === 'business_trip' ? '出張（園指導等）' : '通勤（単発）') : ''}
                            </div>
                            <div className="print-expense-detail">
                              {expense ? (
                                <>
                                  {expense.type === 'regular' && expense.start_date && expense.end_date ? 
                                    `期間:${new Date(expense.start_date).toLocaleDateString('ja-JP', {year: 'numeric', month: '2-digit', day: '2-digit'})}~${new Date(expense.end_date).toLocaleDateString('ja-JP', {year: 'numeric', month: '2-digit', day: '2-digit'})}` :
                                    expense.start_date ? `利用日:${new Date(expense.start_date).toLocaleDateString('ja-JP', {year: 'numeric', month: '2-digit', day: '2-digit'})}` : ''
                                  }<br/>
                                  {expense.from_station} → {expense.to_station}
                                  {expense.transportation && ` [${expense.transportation}]`}<br/>
                                  {expense.workplace && `勤務先:${expense.workplace} `}
                                  {expense.notes || ''}
                                </>
                              ) : ''}
                            </div>
                            <div className="print-expense-amount">
                              {expense ? `¥${expense.amount}` : ''}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    
                    <div className="print-voucher-amount">
                      合計: ¥{voucher.total.toLocaleString()}
                    </div>
                    
                    <div className="print-voucher-footer">
                      <div className="print-voucher-footer-item">
                        <span>承認印:</span>
                        <div className="print-voucher-footer-space"></div>
                      </div>
                      <div className="print-voucher-footer-item">
                        <span>受付日:</span>
                        <div className="print-voucher-footer-space"></div>
                      </div>
                    </div>
                    </div>
                  </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 印刷用エリア（非表示） */}
      <div className="print-area">
        {/* 印刷デバッグ情報 */}
        <div style={{ display: 'none' }}>
          印刷ページ数: {printData.length}ページ
        </div>
        {printData.map((page, pageIndex) => (
          <div key={pageIndex} className="print-page">
            <div className="print-voucher-grid">
              {page.vouchers.map((voucher, index) => (
                <div key={index} className="print-voucher">
                  <div className="print-voucher-header">
                    交通費請求明細書 #{voucher.voucherNumber}
                    {voucher.pageInfo && <span style={{ marginLeft: '10px', fontSize: '6pt' }}>({voucher.pageInfo})</span>}
                  </div>
                  
                  <div className="print-voucher-content">
                    <div className="print-voucher-row">
                      <span>申請者: {voucher.submitterName}</span>
                      <span>申請日: {voucher.submittedDate}</span>
                    </div>
                    
                    <div className="print-expense-list">
                      {Array.from({ length: 20 }, (_, i) => {
                        const expense = voucher.expenses[i];
                        return (
                          <div key={i} className="print-expense-item">
                            <div className="print-expense-number">
                              {expense ? i + 1 : ''}
                            </div>
                            <div className="print-expense-type">
                              {expense ? (expense.type === 'regular' ? '定期' : 
                                         expense.type === 'business_trip' ? '出張（園指導等）' : '通勤（単発）') : ''}
                            </div>
                            <div className="print-expense-detail">
                              {expense ? (
                                <>
                                  {expense.type === 'regular' && expense.start_date && expense.end_date ? 
                                    `期間:${new Date(expense.start_date).toLocaleDateString('ja-JP', {year: 'numeric', month: '2-digit', day: '2-digit'})}~${new Date(expense.end_date).toLocaleDateString('ja-JP', {year: 'numeric', month: '2-digit', day: '2-digit'})}` :
                                    expense.start_date ? `利用日:${new Date(expense.start_date).toLocaleDateString('ja-JP', {year: 'numeric', month: '2-digit', day: '2-digit'})}` : ''
                                  }<br/>
                                  {expense.from_station} → {expense.to_station}
                                  {expense.transportation && ` [${expense.transportation}]`}<br/>
                                  {expense.workplace && `勤務先:${expense.workplace} `}
                                  {expense.notes || ''}
                                </>
                              ) : ''}
                            </div>
                            <div className="print-expense-amount">
                              {expense ? `¥${expense.amount}` : ''}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    
                    <div className="print-voucher-amount">
                      合計: ¥{voucher.total.toLocaleString()}
                    </div>
                    
                    <div className="print-voucher-footer">
                      <div className="print-voucher-footer-item">
                        <span>承認印:</span>
                        <div className="print-voucher-footer-space"></div>
                      </div>
                      <div className="print-voucher-footer-item">
                        <span>受付日:</span>
                        <div className="print-voucher-footer-space"></div>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default AdminPanel;
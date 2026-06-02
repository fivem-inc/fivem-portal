import React, { useState, useCallback, useEffect } from 'react';
import { Routes, Route, Navigate, Outlet, BrowserRouter, useNavigate, useLocation } from 'react-router-dom';
import SignIn from './pages/SignIn';
import ResetPassword from './pages/ResetPassword';
import ChangeEmail from './pages/ChangeEmail';
import SupabaseSettingsCheck from './pages/SupabaseSettingsCheck';
import ExpenseForm from './components/ExpenseForm';
import AdminPanel from './components/AdminPanel';
import HistoryView from './components/HistoryView';
import MonthlyApplicationStatus from './components/MonthlyApplicationStatus';
import BusinessTripReportForm from './components/BusinessTripReport';
import LeaveRequestForm from './components/LeaveRequest';
import LeaveApprovals from './components/LeaveApprovals';
import { AuthProvider } from './contexts/AuthContext.tsx';
import { useAuth } from './hooks/useAuth';
import { supabase } from './lib/supabaseClient';
import { useExpenses } from './hooks/useExpenses';
import type { Expense, Submission } from './types';

// 保護されたルートのためのレイアウト
const ProtectedLayout: React.FC = () => {
  const { user } = useAuth();

  if (!user) {
    return <Navigate to="/signin" />;
  }

  return <Outlet />;
};

// ナビゲーションバー
const NavBar: React.FC<{ isAdmin: boolean; onLogout: () => void; email: string; profileName: string | null; canLeave?: boolean }> = ({ isAdmin: _isAdmin, onLogout, email, profileName, canLeave }) => {
  const navigate = useNavigate();
  const location = useLocation();

  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, zIndex: 100,
      background: '#1a1a2e', color: 'white', padding: '10px 20px',
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      boxShadow: '0 2px 8px rgba(0,0,0,0.3)'
    }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button
          onClick={() => navigate('/')}
          style={{
            padding: '6px 14px', borderRadius: 6, border: 'none', cursor: 'pointer',
            background: location.pathname === '/' ? '#007bff' : '#444', color: 'white', fontSize: 14
          }}
        >
          🏠 交通費申請
        </button>
        <button
          onClick={() => navigate('/trip-report')}
          style={{
            padding: '6px 14px', borderRadius: 6, border: 'none', cursor: 'pointer',
            background: location.pathname === '/trip-report' ? '#007bff' : '#444', color: 'white', fontSize: 14
          }}
        >
          📍 出張報告
        </button>
        {canLeave && (
          <button
            onClick={() => navigate('/leave')}
            style={{
              padding: '6px 14px', borderRadius: 6, border: 'none', cursor: 'pointer',
              background: location.pathname === '/leave' ? '#28a745' : '#444', color: 'white', fontSize: 14
            }}
          >
            🌿 休暇申請
          </button>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ fontSize: 13, opacity: 0.8 }}>{profileName || email}</span>
        <button
          onClick={onLogout}
          style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid #aaa', background: 'transparent', color: 'white', cursor: 'pointer', fontSize: 14 }}
        >
          ログアウト
        </button>
      </div>
    </div>
  );
};

// 休暇申請の承認待ち通知バナー
const LeaveApprovalBanner: React.FC<{ userId: string; roleTitle: string; isAdmin: boolean }> = ({ userId, roleTitle, isAdmin }) => {
  const navigate = useNavigate();
  const [pendingCount, setPendingCount] = useState(0);

  useEffect(() => {
    const approverRoles = ['リーダー', 'マネージャー', '社長', '管理者'];
    if (!isAdmin && !approverRoles.includes(roleTitle)) return;

    const fetchPending = async () => {
      // 自分の番の申請のみカウント
      // 一人目: status=pending かつ approver_id=自分
      // 二人目: status=step2_pending かつ approver2_id=自分
      const { data: d1 } = await supabase
        .from('leave_requests')
        .select('id')
        .eq('status', 'pending')
        .eq('approver_id', userId);
      const { data: d2 } = await supabase
        .from('leave_requests')
        .select('id')
        .eq('status', 'step2_pending')
        .eq('approver2_id', userId);
      // 社長: admin_approved ステータスをカウント
      const { data: d3 } = roleTitle === '社長'
        ? await supabase.from('leave_requests').select('id').eq('status', 'admin_approved')
        : { data: [] };
      const data = [...(d1 || []), ...(d2 || []), ...(d3 || [])];
      if (data) setPendingCount(data.length);
    };
    fetchPending();
  }, [userId, roleTitle, isAdmin]);

  if (pendingCount === 0) return null;

  return (
    <div
      onClick={() => navigate('/leave-approvals')}
      style={{
        margin: '0 0 16px 0',
        padding: '12px 16px',
        background: '#fff3cd',
        border: '2px solid #ffc107',
        borderRadius: 10,
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        fontSize: 15,
        color: '#856404',
        fontWeight: 'bold',
      }}
    >
      <span style={{ fontSize: 22 }}>🌿</span>
      <span>休暇申請の承認依頼が {pendingCount}件 あります</span>
      <span style={{ marginLeft: 'auto', fontSize: 13, fontWeight: 'normal' }}>タップして確認 →</span>
    </div>
  );
};

// メインのDashboardコンポーネント
const Dashboard: React.FC = () => {
  // 通常のダッシュボード処理（パスワードリセットは専用ページで処理）

  const {
    user,
    isAdmin,
    profileName,
    roleTitle,
    canLeave,
    leaveRequestEnabled,
    handleLogout
  } = useAuth();

  const { submissions, pendingApprovals, isLoading, fetchExpenses } = useExpenses(user, isAdmin);

  const [expenses, setExpensesState] = useState<Expense[]>([
    { type: 'one_time', from_station: '', to_station: '', amount: '', start_date: '', end_date: '' }
  ]);

  const setExpenses = useCallback((value: React.SetStateAction<Expense[]>) => {
    setExpensesState(value);
  }, []);

  const handleApplyTemplate = useCallback((submission: Submission) => {
    const templateExpenses = submission.expenses_data;

    if (!templateExpenses || templateExpenses.length === 0) {
      alert('適用できるテンプレートデータがありません。');
      return;
    }

    let currentExpenses = [...expenses];
    let appliedCount = 0;

    templateExpenses.forEach(templateItem => {
      let appliedToExistingRow = false;
      
      for (let i = 0; i < currentExpenses.length; i++) {
        const expense = currentExpenses[i];
        if (!expense.from_station && !expense.to_station && !expense.amount) {
          currentExpenses[i] = { ...templateItem, start_date: '', end_date: '' };
          appliedToExistingRow = true;
          appliedCount++;
          break;
        }
      }

      if (!appliedToExistingRow) {
        currentExpenses = [...currentExpenses, { ...templateItem, start_date: '', end_date: '' }];
        appliedCount++;
      }
    });

    setExpensesState(currentExpenses);
    alert(`${appliedCount}件の項目をフォームに適用しました。`);
  }, [expenses]);

  if (!user) {
    return <div>読み込んでいます...</div>;
  }

  return (
    <div style={{ maxWidth: 800, margin: '40px auto', position: 'relative', paddingTop: '80px' }}>
      <NavBar isAdmin={isAdmin} onLogout={handleLogout} email={user.email || ''} profileName={profileName} canLeave={canLeave} />

      {/* 有給申請フォーム送信通知バナー（パート向け） */}
      {leaveRequestEnabled && (
        <div
          onClick={() => window.location.href = '/leave'}
          style={{ background: '#28a745', color: 'white', borderRadius: 10, padding: '14px 20px', marginBottom: 16, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 12, boxShadow: '0 2px 8px rgba(40,167,69,0.4)' }}
        >
          <span style={{ fontSize: 24 }}>📨</span>
          <div>
            <div style={{ fontWeight: 'bold', fontSize: 15 }}>申請フォームが届いています</div>
            <div style={{ fontSize: 13, opacity: 0.9 }}>タップして申請画面へ →</div>
          </div>
        </div>
      )}

      {/* 休暇申請承認バナー（承認者のみ） */}
      <LeaveApprovalBanner userId={user.id} roleTitle={roleTitle} isAdmin={isAdmin} />

      {/* 交通費申請フォーム */}
      <ExpenseForm 
        user={user} 
        onSubmissionComplete={fetchExpenses} 
        expenses={expenses}
        setExpenses={setExpenses}
        profileName={profileName}
      />

      {/* 月別申請状況 - 一般ユーザーのみ表示 */}
      {!isAdmin && (
        <MonthlyApplicationStatus
          user={user}
          submissions={submissions}
          userName={profileName || user.email || ''}
        />
      )}

      {/* 管理者パネル */}
      {isAdmin && (
        <AdminPanel
          pendingApprovals={pendingApprovals}
          submissions={submissions}
          isLoading={isLoading}
          onRefresh={fetchExpenses}
        />
      )}

      {/* 申請履歴 */}
      <HistoryView
        submissions={submissions}
        user={user}
        isLoading={isLoading}
        onApplyTemplate={handleApplyTemplate}
      />
    </div>
  );
};

// 出張報告ページ
const TripReportPage: React.FC = () => {
  const { user, isAdmin, profileName, canLeave, handleLogout } = useAuth();
  if (!user) return <div>読み込んでいます...</div>;
  return (
    <div style={{ paddingTop: '60px' }}>
      <NavBar isAdmin={isAdmin} onLogout={handleLogout} email={user.email || ''} profileName={profileName} canLeave={canLeave} />
      <BusinessTripReportForm user={user} profileName={profileName} />
    </div>
  );
};

// 休暇申請ページ
const LeaveRequestPage: React.FC = () => {
  const { user, isAdmin, profileName, roleTitle, canLeave, leaveRequestEnabled, handleLogout } = useAuth();
  if (!user) return <div>読み込んでいます...</div>;
  return (
    <div style={{ paddingTop: '60px' }}>
      <NavBar isAdmin={isAdmin} onLogout={handleLogout} email={user.email || ''} profileName={profileName} canLeave={canLeave} />
      <LeaveRequestForm user={user} profileName={profileName} roleTitle={roleTitle} leaveRequestEnabled={leaveRequestEnabled} />
    </div>
  );
};

// 休暇申請承認ページ（リーダー・マネージャー・管理者用）
const LeaveApprovalsPage: React.FC = () => {
  const { user, isAdmin, profileName, roleTitle, canLeave, handleLogout, loading } = useAuth();
  if (!user || loading) return <div style={{ padding: 40, textAlign: 'center' }}>読み込んでいます...</div>;
  const approverRoles = ['リーダー', 'マネージャー', '社長', '管理者'];
  // roleTitle が空の場合はまだプロフィール未取得なので弾かない
  if (roleTitle && !isAdmin && !approverRoles.includes(roleTitle)) return <Navigate to="/" />;
  return (
    <div style={{ paddingTop: '60px' }}>
      <NavBar isAdmin={isAdmin} onLogout={handleLogout} email={user.email || ''} profileName={profileName} canLeave={canLeave} />
      <LeaveApprovals user={user} profileName={profileName} isAdmin={isAdmin} roleTitle={roleTitle} />
    </div>
  );
};

// メインのAppコンポーネント
function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/signin" element={<SignIn />} />
          <Route path="/reset-password" element={<ResetPassword />} />
          <Route path="/" element={<ProtectedLayout />}>
            <Route index element={<Dashboard />} />
            <Route path="/trip-report" element={<TripReportPage />} />
            <Route path="/leave" element={<LeaveRequestPage />} />
            <Route path="/leave-approvals" element={<LeaveApprovalsPage />} />
            <Route path="/change-email" element={<ChangeEmail />} />
            <Route path="/settings-check" element={<SupabaseSettingsCheck />} />
          </Route>
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;
import React, { useState, useCallback } from 'react';
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
import { AuthProvider } from './contexts/AuthContext.tsx';
import { useAuth } from './hooks/useAuth';
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
const NavBar: React.FC<{ isAdmin: boolean; onLogout: () => void; email: string; profileName: string | null }> = ({ isAdmin: _isAdmin, onLogout, email, profileName }) => {
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
          🏠 申請
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

// メインのDashboardコンポーネント
const Dashboard: React.FC = () => {
  // 通常のダッシュボード処理（パスワードリセットは専用ページで処理）

  const { 
    user, 
    isAdmin, 
    profileName, 
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
      <NavBar isAdmin={isAdmin} onLogout={handleLogout} email={user.email || ''} profileName={profileName} />

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
  const { user, isAdmin, profileName, handleLogout } = useAuth();
  if (!user) return <div>読み込んでいます...</div>;
  return (
    <div style={{ paddingTop: '60px' }}>
      <NavBar isAdmin={isAdmin} onLogout={handleLogout} email={user.email || ''} profileName={profileName} />
      <BusinessTripReportForm user={user} profileName={profileName} />
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
            <Route path="/change-email" element={<ChangeEmail />} />
            <Route path="/settings-check" element={<SupabaseSettingsCheck />} />
          </Route>
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;
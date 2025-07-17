import React, { useState, useCallback } from 'react';
import { Routes, Route, Navigate, Outlet, BrowserRouter } from 'react-router-dom';
import SignIn from './pages/SignIn';
import ResetPassword from './pages/ResetPassword';
import ChangeEmail from './pages/ChangeEmail';
import SupabaseSettingsCheck from './pages/SupabaseSettingsCheck';
import ExpenseForm from './components/ExpenseForm';
import AdminPanel from './components/AdminPanel';
import HistoryView from './components/HistoryView';
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
    <div style={{ maxWidth: 800, margin: '40px auto', position: 'relative', paddingTop: '120px' }}>
      {/* ヘッダー部分 - スマホ対応 */}
      <div style={{ 
        position: 'absolute', 
        top: 20, 
        left: 20, 
        right: 20,
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'flex-start',
        flexWrap: 'wrap',
        gap: '10px'
      }}>
        {/* ユーザー情報表示 */}
        <div style={{ textAlign: 'left', minWidth: '200px', flex: '1' }}>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4, flexWrap: 'wrap', gap: '8px' }}>
            <p style={{ margin: 0, fontWeight: 'bold' }}>{user.email}</p>
            <button 
              onClick={() => window.location.href = '/change-email'}
              style={{ 
                padding: '2px 8px', 
                fontSize: '12px', 
                whiteSpace: 'nowrap',
                background: '#17a2b8',
                color: 'white',
                border: '1px solid #17a2b8',
                borderRadius: '4px',
                cursor: 'pointer'
              }}
            >
              メール変更
            </button>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', marginTop: 4, flexWrap: 'wrap', gap: '8px' }}>
            <p style={{ margin: 0 }}>{profileName || '名前未設定'}</p>
          </div>
        </div>

        {/* ログアウトボタン */}
        <button
          onClick={handleLogout}
          style={{
            padding: '10px 20px',
            whiteSpace: 'nowrap',
            alignSelf: 'flex-start'
          }}
        >
          ログアウト
        </button>
      </div>

      {/* 交通費申請フォーム */}
      <ExpenseForm 
        user={user} 
        onSubmissionComplete={fetchExpenses} 
        expenses={expenses}
        setExpenses={setExpenses}
        profileName={profileName}
      />

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
            <Route path="/change-email" element={<ChangeEmail />} />
            <Route path="/settings-check" element={<SupabaseSettingsCheck />} />
          </Route>
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;
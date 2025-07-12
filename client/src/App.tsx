import React, { useState, useCallback } from 'react';
import { Routes, Route, Navigate, Outlet, BrowserRouter } from 'react-router-dom';
import SignIn from './pages/SignIn';
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
  const { 
    user, 
    isAdmin, 
    profileName, 
    showNameInput, 
    setProfileName, 
    handleSaveName, 
    handleLogout, 
    startEditingName
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
      {/* ユーザー情報表示 */}
      <div style={{ position: 'absolute', top: 20, left: 20, textAlign: 'left' }}>
        <p style={{ margin: 0, fontWeight: 'bold' }}>{user.email}</p>
        {showNameInput ? (
          <div style={{ display: 'flex', alignItems: 'center', marginTop: 4 }}>
            <input
              type="text"
              placeholder="名前を入力"
              value={profileName}
              onChange={(e) => setProfileName(e.target.value)}
              style={{ padding: '4px 8px', marginRight: 8, border: '1px solid #ccc', borderRadius: 4 }}
            />
            <button onClick={handleSaveName} style={{ padding: '4px 10px' }}>
              保存
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', marginTop: 4 }}>
            <p style={{ margin: 0, marginRight: 8 }}>{profileName}</p>
            <button onClick={startEditingName} style={{ padding: '2px 8px', fontSize: '12px' }}>
              編集
            </button>
          </div>
        )}
      </div>

      {/* ログアウトボタン */}
      <button
        onClick={handleLogout}
        style={{
          position: 'absolute',
          top: 20,
          right: 20,
          padding: '10px 20px'
        }}
      >
        ログアウト
      </button>

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
          <Route path="/" element={<ProtectedLayout />}>
            <Route index element={<Dashboard />} />
          </Route>
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;
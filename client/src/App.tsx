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
  // パスワードリセット検知処理（ルートパスでも実行）
  React.useEffect(() => {
    const currentUrl = window.location.href;
    const urlObj = new URL(currentUrl);
    
    console.log('Dashboard: 詳細URL解析', {
      href: currentUrl,
      hash: urlObj.hash,
      search: urlObj.search,
      hashLength: urlObj.hash.length,
      rawHash: window.location.hash,
      locationHref: window.location.href
    });
    
    // 空のハッシュでもパスワードリセットの可能性があるかチェック
    const hasEmptyHash = currentUrl.includes('#') && !urlObj.hash;
    console.log('Dashboard: 空ハッシュ検知:', hasEmptyHash);
    
    // 最近のパスワードリセット試行をlocalStorageで確認
    const recentPasswordReset = localStorage.getItem('recentPasswordResetAttempt');
    const now = Date.now();
    
    if (recentPasswordReset) {
      const resetTime = parseInt(recentPasswordReset);
      const timeDiff = now - resetTime;
      console.log('Dashboard: 最近のパスワードリセット:', { timeDiff, withinWindow: timeDiff < 300000 }); // 5分以内
      
      if (timeDiff < 300000 && (hasEmptyHash || urlObj.hash)) { // 5分以内
        console.log('Dashboard: 最近のパスワードリセット + ハッシュ検知 - 強制的にサインイン画面へ');
        localStorage.removeItem('recentPasswordResetAttempt');
        alert('パスワードリセットのリダイレクトを検知しました。サインイン画面に移動します。');
        window.location.href = '/signin';
        return;
      }
    }
    
    // URLハッシュにトークンがある場合はサインイン画面にリダイレクト
    if (urlObj.hash) {
      const hashParams = new URLSearchParams(urlObj.hash.substring(1));
      const accessToken = hashParams.get('access_token');
      const type = hashParams.get('type');
      
      console.log('Dashboard: ハッシュパラメータ', { hasAccessToken: !!accessToken, type });
      
      if (accessToken && type === 'recovery') {
        console.log('Dashboard: パスワードリセットトークン検知 - サインイン画面にリダイレクト');
        window.location.href = '/signin' + urlObj.hash;
        return;
      }
    }
  }, []);

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
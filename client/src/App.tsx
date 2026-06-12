import React, { useState, useCallback, useEffect, useLayoutEffect, Suspense, useRef } from 'react';
import { Routes, Route, Navigate, Outlet, BrowserRouter, useNavigate, useLocation } from 'react-router-dom';
import SignIn from './pages/SignIn';
import ResetPassword from './pages/ResetPassword';
import ChangeEmail from './pages/ChangeEmail';
import ChangePassword from './pages/ChangePassword';
import AccountSettings from './pages/AccountSettings';
import SupabaseSettingsCheck from './pages/SupabaseSettingsCheck';
import ExpenseForm from './components/ExpenseForm';

const AdminPanel = React.lazy(() => import('./components/AdminPanel'));
const HistoryView = React.lazy(() => import('./components/HistoryView'));
const MonthlyApplicationStatus = React.lazy(() => import('./components/MonthlyApplicationStatus'));
const BusinessTripReportForm = React.lazy(() => import('./components/BusinessTripReport'));
const LeaveRequestForm = React.lazy(() => import('./components/LeaveRequest'));
const LeaveApprovals = React.lazy(() => import('./components/LeaveApprovals'));
const CalendarPage = React.lazy(() => import('./pages/CalendarPage'));

const PageLoader: React.FC = () => (
  <div style={{ padding: 40, textAlign: 'center', color: '#888' }}>読み込んでいます...</div>
);
import { AuthProvider } from './contexts/AuthContext.tsx';
import { useAuth } from './hooks/useAuth';
import { supabase } from './lib/supabaseClient';
import { useExpenses } from './hooks/useExpenses';
import type { Expense, Submission } from './types';

// ページ遷移のたびにスクロールをトップへ戻す
const ScrollToTop: React.FC = () => {
  const { pathname } = useLocation();
  // useLayoutEffect fires synchronously before paint, preventing the "content appears lower" flash
  useLayoutEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' as ScrollBehavior });
    // Also reset document.documentElement and body in case either is the scroll container
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  }, [pathname]);
  return null;
};

// 保護されたルートのためのレイアウト
const ProtectedLayout: React.FC = () => {
  const { user } = useAuth();

  if (!user) {
    return <Navigate to="/signin" />;
  }

  return <Outlet />;
};

// ナビゲーションバー
const CALENDAR_ROLES = ['リーダー', 'マネージャー', '社長', '管理者'];

interface NotificationRow { id: string; message: string; sub_message: string | null; read: boolean; created_at: string; }

const BellIcon: React.FC<{ userId: string }> = ({ userId }) => {
  const [notifs, setNotifs] = useState<NotificationRow[]>([]);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const fetchNotifs = useCallback(async () => {
    const { data } = await supabase.from('notifications').select('id, message, sub_message, read, created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(30);
    if (data) setNotifs(data);
  }, [userId]);

  useEffect(() => { fetchNotifs(); const t = setInterval(fetchNotifs, 30000); return () => clearInterval(t); }, [fetchNotifs]);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  const unread = notifs.filter(n => !n.read).length;

  const markAllRead = async () => {
    const ids = notifs.filter(n => !n.read).map(n => n.id);
    if (ids.length > 0) {
      await supabase.from('notifications').update({ read: true }).in('id', ids);
      setNotifs(prev => prev.map(n => ({ ...n, read: true })));
    }
  };

  const dismissOne = async (id: string) => {
    await supabase.from('notifications').update({ read: true }).eq('id', id);
    setNotifs(prev => prev.filter(n => n.id !== id));
  };

  const handleOpen = () => { setOpen(o => !o); if (!open) markAllRead(); };

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button onClick={handleOpen} style={{ position: 'relative', background: 'transparent', border: 'none', color: 'white', cursor: 'pointer', fontSize: 20, padding: '4px 6px', lineHeight: 1 }}>
        🔔
        {unread > 0 && (
          <span style={{ position: 'absolute', top: 0, right: 0, background: '#dc3545', color: '#fff', borderRadius: '50%', fontSize: 10, width: 16, height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold', lineHeight: 1 }}>{unread > 9 ? '9+' : unread}</span>
        )}
      </button>
      {open && (
        <div style={{ position: 'absolute', right: 0, top: '100%', marginTop: 4, width: 300, background: '#fff', borderRadius: 10, boxShadow: '0 4px 20px rgba(0,0,0,0.2)', zIndex: 999, overflow: 'hidden' }}>
          <div style={{ padding: '10px 14px', borderBottom: '1px solid #eee', fontSize: 13, fontWeight: 'bold', color: '#333' }}>通知</div>
          <div style={{ maxHeight: 320, overflowY: 'auto' }}>
            {notifs.length === 0 ? (
              <div style={{ padding: '20px', textAlign: 'center', color: '#888', fontSize: 13 }}>通知はありません</div>
            ) : notifs.map(n => (
              <div key={n.id} style={{ padding: '10px 14px', borderBottom: '1px solid #f0f0f0', background: n.read ? '#fff' : '#f0f8ff', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, color: '#333', fontWeight: n.read ? 'normal' : 'bold' }}>{n.message}</div>
                  {n.sub_message && <div style={{ fontSize: 11, color: '#666', marginTop: 2 }}>{n.sub_message}</div>}
                  <div style={{ fontSize: 10, color: '#aaa', marginTop: 4 }}>{new Date(n.created_at).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</div>
                </div>
                <button onClick={() => dismissOne(n.id)} style={{ background: 'none', border: 'none', color: '#bbb', cursor: 'pointer', fontSize: 14, padding: '0 2px', flexShrink: 0, lineHeight: 1 }}>✕</button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

const NavBar: React.FC<{ isAdmin: boolean; onLogout: () => void; email: string; profileName: string | null; canLeave?: boolean; canApprove?: boolean; roleTitle?: string; userId?: string }> = ({ isAdmin, onLogout, email, profileName, canLeave, canApprove: _canApprove, roleTitle, userId }) => {
  const navigate = useNavigate();
  const location = useLocation();
  const [isMobile, setIsMobile] = useState(window.innerWidth < 640);
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 640);
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  const btnStyle = (active: boolean, activeColor = '#007bff') => isMobile ? ({
    width: 52, height: 52, borderRadius: 8, border: 'none', cursor: 'pointer',
    background: active ? activeColor : '#444',
    color: 'white', fontSize: 10, display: 'flex', flexDirection: 'column' as const,
    alignItems: 'center', justifyContent: 'center', gap: 1, padding: 0, flexShrink: 0,
  }) : ({
    padding: '6px 14px', borderRadius: 6, border: 'none', cursor: 'pointer',
    background: active ? activeColor : '#444', color: 'white', fontSize: 14, whiteSpace: 'nowrap' as const,
  });

  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, zIndex: 100,
      background: '#1a1a2e', color: 'white', padding: '8px 12px',
      display: 'flex', justifyContent: 'space-between', alignItems: isMobile ? 'flex-start' : 'center',
      boxShadow: '0 2px 8px rgba(0,0,0,0.3)'
    }}>
      <div style={{ display: 'flex', gap: 4, flexWrap: isMobile ? 'nowrap' : 'wrap', alignItems: 'center', flex: 1 }}>
        {isAdmin && (
          <button onClick={() => navigate('/admin')} style={btnStyle(location.pathname === '/admin', '#6f42c1')}>
            {isMobile ? <><span style={{ fontSize: 20 }}>⚙️</span><span>管理</span></> : '⚙️ 管理'}
          </button>
        )}
        <button onClick={() => navigate('/')} style={btnStyle(location.pathname === '/')}>
          {isMobile ? <><span style={{ fontSize: 20 }}>🏠</span><span>交通費</span></> : '🏠 交通費'}
        </button>
        <button onClick={() => navigate('/trip-report')} style={btnStyle(location.pathname === '/trip-report')}>
          {isMobile ? <><span style={{ fontSize: 20 }}>📍</span><span>出張報告</span></> : '📍 出張報告'}
        </button>
        {canLeave && (
          <button onClick={() => navigate('/leave')} style={btnStyle(location.pathname === '/leave', '#28a745')}>
            {isMobile ? <><span style={{ fontSize: 20 }}>🌿</span><span>休暇申請</span></> : '🌿 休暇申請'}
          </button>
        )}
        {(isAdmin || (roleTitle && CALENDAR_ROLES.includes(roleTitle))) && (
          <button onClick={() => navigate('/calendar')} style={btnStyle(location.pathname === '/calendar', '#4a90d9')}>
            {isMobile ? <><span style={{ fontSize: 20 }}>📅</span><span>休暇</span></> : '📅 休暇'}
          </button>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0, paddingLeft: 8 }}>
        {userId && <BellIcon userId={userId} />}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
          <span
            onClick={() => navigate('/account')}
            style={{ fontSize: 12, opacity: 0.8, cursor: 'pointer', textDecoration: 'underline dotted', textUnderlineOffset: 3, whiteSpace: 'nowrap', maxWidth: 80, overflow: 'hidden', textOverflow: 'ellipsis' }}
            title="タップでアカウント設定"
          >
            {profileName || email}
          </span>
          <button
            onClick={onLogout}
            style={{ padding: '2px 8px', borderRadius: 6, border: '1px solid #aaa', background: 'transparent', color: 'white', cursor: 'pointer', fontSize: 11, whiteSpace: 'nowrap' }}
          >
            ログアウト
          </button>
        </div>
      </div>
    </div>
  );
};

// 通知バナー（notifications テーブルから未読を表示）
const NotifItem: React.FC<{ n: { id: string; message: string; sub_message: string | null; read: boolean }; onDismiss: (id: string) => void }> = ({ n, onDismiss }) => {
  const [visible, setVisible] = useState(true);
  const isReject = n.message.includes('差し戻し') || n.message.includes('差し戻され');

  useEffect(() => {
    const t = setTimeout(() => {
      setVisible(false);
      setTimeout(() => onDismiss(n.id), 400);
    }, 5000);
    return () => clearTimeout(t);
  }, [n.id, onDismiss]);

  return (
    <div style={{
      background: isReject ? '#dc3545' : '#28a745', color: 'white', borderRadius: 10, padding: '12px 16px', marginBottom: 10,
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      boxShadow: `0 2px 8px ${isReject ? 'rgba(220,53,69,0.4)' : 'rgba(40,167,69,0.4)'}`,
      opacity: visible ? 1 : 0, transition: 'opacity 0.4s ease',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 20 }}>{isReject ? '⚠️' : '✅'}</span>
        <div>
          <div style={{ fontWeight: 'bold', fontSize: 14 }}>{n.message}</div>
          {n.sub_message && <div style={{ fontSize: 12, opacity: 0.9 }}>{n.sub_message}</div>}
        </div>
      </div>
      <button onClick={() => { setVisible(false); setTimeout(() => onDismiss(n.id), 400); }}
        style={{ background: 'rgba(255,255,255,0.25)', border: 'none', color: 'white', borderRadius: '50%', width: 24, height: 24, cursor: 'pointer', fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>✕</button>
    </div>
  );
};

const NotificationBanner: React.FC<{ userId: string }> = ({ userId }) => {
  const [notifs, setNotifs] = useState<{ id: string; message: string; sub_message: string | null; read: boolean }[]>([]);

  const fetchNotifs = useCallback(async () => {
    const { data } = await supabase
      .from('notifications')
      .select('id, message, sub_message, read')
      .eq('user_id', userId)
      .eq('read', false)
      .order('created_at', { ascending: false });
    if (data) setNotifs(data);
  }, [userId]);

  useEffect(() => { fetchNotifs(); }, [fetchNotifs]);

  const dismiss = useCallback(async (id: string) => {
    await supabase.from('notifications').update({ read: true }).eq('id', id);
    setNotifs(prev => prev.filter(n => n.id !== id));
  }, []);

  if (notifs.length === 0) return null;

  return (
    <>
      {notifs.map(n => <NotifItem key={n.id} n={n} onDismiss={dismiss} />)}
    </>
  );
};

// 休暇申請の承認待ち通知バナー
const LeaveApprovalBanner: React.FC<{ userId: string; roleTitle: string; isAdmin: boolean }> = ({ userId, roleTitle, isAdmin }) => {
  const navigate = useNavigate();
  const [pendingCount, setPendingCount] = useState(0);

  useEffect(() => {
        if (!isAdmin && !['リーダー', 'マネージャー', '社長', '管理者'].includes(roleTitle)) return;

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
    isApprover,
    profileName,
    roleTitle,
    canLeave,
    leaveRequestEnabled,
    handleLogout
  } = useAuth();

  const { submissions, pendingApprovals, isLoading, fetchExpenses } = useExpenses(user, isAdmin);

  const [expenses, setExpensesState] = useState<Expense[]>([]);
  const [templateQueue, setTemplateQueue] = useState<Expense[]>([]);

  const setExpenses = useCallback((value: React.SetStateAction<Expense[]>) => {
    setExpensesState(value);
  }, []);

  const handleApplyTemplate = useCallback((submission: Submission) => {
    const items = (submission.expenses_data || [])
      .map(e => ({ ...e, start_date: '', end_date: '' }));
    if (items.length === 0) {
      alert('適用できるテンプレートデータがありません。');
      return;
    }
    setTemplateQueue(items);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  if (!user) {
    return <div>読み込んでいます...</div>;
  }


  return (
    <div style={{ maxWidth: 800, margin: '0 auto', position: 'relative', padding: '110px 16px 0', boxSizing: 'border-box' as const, width: '100%' }}>
      <NavBar isAdmin={isAdmin} onLogout={handleLogout} email={user.email || ''} profileName={profileName} canLeave={canLeave} canApprove={isApprover} roleTitle={roleTitle} userId={user.id} />

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

      {/* 通知バナー（申請者向け） */}
      {!isAdmin && <NotificationBanner userId={user.id} />}

      {/* 休暇申請承認バナー（承認者のみ） */}
      <LeaveApprovalBanner userId={user.id} roleTitle={roleTitle} isAdmin={isAdmin} />

      {/* 交通費申請フォーム */}
      <ExpenseForm
        user={user}
        onSubmissionComplete={fetchExpenses}
        expenses={expenses}
        setExpenses={setExpenses}
        profileName={profileName}
        pendingTemplates={templateQueue}
        onTemplateApplied={() => setTemplateQueue([])}
      />

      {/* 月別申請状況 - 一般ユーザーのみ表示 */}
      {!isAdmin && (
        <Suspense fallback={<PageLoader />}>
          <MonthlyApplicationStatus
            user={user}
            submissions={submissions}
            userName={profileName || user.email || ''}
          />
        </Suspense>
      )}

      {/* 申請履歴 */}
      <Suspense fallback={<PageLoader />}>
        <HistoryView
          submissions={submissions}
          user={user}
          isLoading={isLoading}
          onApplyTemplate={handleApplyTemplate}
        />
      </Suspense>
    </div>
  );
};

// 出張報告ページ
const TripReportPage: React.FC = () => {
  const { user, isAdmin, isApprover, profileName, roleTitle, canLeave, handleLogout } = useAuth();
  if (!user) return <div>読み込んでいます...</div>;
  return (
    <div style={{ padding: '110px 16px 0' }}>
      <NavBar isAdmin={isAdmin} onLogout={handleLogout} email={user.email || ''} profileName={profileName} canLeave={canLeave} canApprove={isApprover} roleTitle={roleTitle} userId={user.id} />
      <Suspense fallback={<PageLoader />}>
        <BusinessTripReportForm user={user} profileName={profileName} />
      </Suspense>
    </div>
  );
};

// 休暇申請ページ
const LeaveRequestPage: React.FC = () => {
  const { user, isAdmin, isApprover, profileName, roleTitle, canLeave, leaveRequestEnabled, handleLogout } = useAuth();
  if (!user) return <div>読み込んでいます...</div>;
  return (
    <div style={{ padding: '110px 16px 0' }}>
      <NavBar isAdmin={isAdmin} onLogout={handleLogout} email={user.email || ''} profileName={profileName} canLeave={canLeave} canApprove={isApprover} roleTitle={roleTitle} userId={user.id} />
      <Suspense fallback={<PageLoader />}>
        <LeaveRequestForm user={user} profileName={profileName} roleTitle={roleTitle} leaveRequestEnabled={leaveRequestEnabled} />
      </Suspense>
    </div>
  );
};

// 休暇申請承認ページ（リーダー・マネージャー・管理者用）
const LeaveApprovalsPage: React.FC = () => {
  const { user, isAdmin, isApprover, profileName, roleTitle, canLeave, handleLogout, loading } = useAuth();
  if (!user || loading) return <div style={{ padding: 40, textAlign: 'center' }}>読み込んでいます...</div>;
  if (roleTitle && !isApprover) return <Navigate to="/" />;
  return (
    <div style={{ padding: '110px 16px 0' }}>
      <NavBar isAdmin={isAdmin} onLogout={handleLogout} email={user.email || ''} profileName={profileName} canLeave={canLeave} canApprove={isApprover} roleTitle={roleTitle} userId={user.id} />
      <Suspense fallback={<PageLoader />}>
        <LeaveApprovals user={user} profileName={profileName} isAdmin={isAdmin} roleTitle={roleTitle} />
      </Suspense>
    </div>
  );
};

// チームカレンダーページ
const TeamCalendarPage: React.FC = () => {
  const { user, isAdmin, isApprover, profileName, roleTitle, canLeave, handleLogout, loading } = useAuth();
  if (!user || loading) return <div style={{ padding: 40, textAlign: 'center' }}>読み込んでいます...</div>;
  if (roleTitle && !isAdmin && !CALENDAR_ROLES.includes(roleTitle)) return <Navigate to="/" />;
  return (
    <div style={{ padding: '110px 16px 0' }}>
      <NavBar isAdmin={isAdmin} onLogout={handleLogout} email={user.email || ''} profileName={profileName} canLeave={canLeave} canApprove={isApprover} roleTitle={roleTitle} userId={user.id} />
      <Suspense fallback={<PageLoader />}>
        <CalendarPage user={user} roleTitle={roleTitle} isAdmin={isAdmin} isApprover={isApprover} />
      </Suspense>
    </div>
  );
};

// 管理画面ページ（/admin）
const AdminPage: React.FC = () => {
  const { user, isAdmin, isApprover, profileName, roleTitle, canLeave, handleLogout, loading } = useAuth();
  const { submissions, pendingApprovals, isLoading, fetchExpenses } = useExpenses(user, isAdmin);
  if (!user || loading) return <div style={{ padding: 40, textAlign: 'center' }}>読み込んでいます...</div>;
  if (!isAdmin) return <Navigate to="/" />;
  return (
    <div style={{ padding: '110px 16px 0' }}>
      <NavBar isAdmin={isAdmin} onLogout={handleLogout} email={user.email || ''} profileName={profileName} canLeave={canLeave} canApprove={isApprover} roleTitle={roleTitle} userId={user.id} />
<Suspense fallback={<PageLoader />}>
        <AdminPanel
          pendingApprovals={pendingApprovals}
          submissions={submissions}
          isLoading={isLoading}
          onRefresh={fetchExpenses}
        />
      </Suspense>
    </div>
  );
};

// メインのAppコンポーネント
function App() {
  return (
    <BrowserRouter>
      <ScrollToTop />
      <AuthProvider>
        <Routes>
          <Route path="/signin" element={<SignIn />} />
          <Route path="/reset-password" element={<ResetPassword />} />
          <Route path="/" element={<ProtectedLayout />}>
            <Route index element={<Dashboard />} />
            <Route path="/trip-report" element={<TripReportPage />} />
            <Route path="/leave" element={<LeaveRequestPage />} />
            <Route path="/leave-approvals" element={<LeaveApprovalsPage />} />
            <Route path="/calendar" element={<TeamCalendarPage />} />
            <Route path="/admin" element={<AdminPage />} />
            <Route path="/account" element={<AccountSettings />} />
            <Route path="/change-email" element={<ChangeEmail />} />
            <Route path="/change-password" element={<ChangePassword />} />
            <Route path="/settings-check" element={<SupabaseSettingsCheck />} />
          </Route>
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;

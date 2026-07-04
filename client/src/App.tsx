import React, { useState, useCallback, useEffect, useLayoutEffect, Suspense, useRef, useContext } from 'react';
import ReactDOM from 'react-dom';
import { Routes, Route, Navigate, Outlet, BrowserRouter, useNavigate, useLocation } from 'react-router-dom';
import SignIn from './pages/SignIn';
import ResetPassword from './pages/ResetPassword';
import ChangeEmail from './pages/ChangeEmail';
import ChangePassword from './pages/ChangePassword';
import AccountSettings from './pages/AccountSettings';
import NotificationSettings from './pages/NotificationSettings';
import SupabaseSettingsCheck from './pages/SupabaseSettingsCheck';
import ExpenseForm from './components/ExpenseForm';

const AdminPanel = React.lazy(() => import('./components/AdminPanel'));
const HistoryView = React.lazy(() => import('./components/HistoryView'));
const MonthlyApplicationStatus = React.lazy(() => import('./components/MonthlyApplicationStatus'));
const BusinessTripReportForm = React.lazy(() => import('./components/BusinessTripReport'));
const LeaveRequestForm = React.lazy(() => import('./components/LeaveRequest'));
const LeaveApprovals = React.lazy(() => import('./components/LeaveApprovals'));
const CalendarPage     = React.lazy(() => import('./pages/CalendarPage'));
const BoardPage        = React.lazy(() => import('./pages/BoardPage'));
const ShiftReportPage  = React.lazy(() => import('./pages/ShiftReportPage'));
const PurchaseRequestPage = React.lazy(() => import('./pages/PurchaseRequestPage'));

const PageLoader: React.FC = () => (
  <div style={{ padding: 40, textAlign: 'center', color: '#888' }}>読み込んでいます...</div>
);
import { AuthProvider, AuthContext } from './contexts/AuthContext.tsx';
import { useAuth } from './hooks/useAuth';
import { useFeaturePublished, isFeaturePublished } from './hooks/useFeaturePublished';
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

interface NotificationRow { id: string; message: string; sub_message: string | null; read: boolean; created_at: string; source_type: string | null; reference_id: string | null; }

const BellIcon: React.FC<{ userId: string }> = ({ userId }) => {
  const [notifs, setNotifs] = useState<NotificationRow[]>([]);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const portalRef = useRef<HTMLDivElement>(null);

  const fetchNotifs = useCallback(async () => {
    const { data } = await supabase.from('notifications').select('id, message, sub_message, read, created_at, source_type, reference_id').eq('user_id', userId).eq('dismissed', false).or('source_type.is.null,source_type.neq.board').order('created_at', { ascending: false }).limit(30);
    if (data) setNotifs(data);
  }, [userId]);

  useEffect(() => { fetchNotifs(); const t = setInterval(fetchNotifs, 30000); return () => clearInterval(t); }, [fetchNotifs]);
  useEffect(() => {
    const h = (e: MouseEvent) => {
      const inside = (ref.current?.contains(e.target as Node)) || (portalRef.current?.contains(e.target as Node));
      if (!inside) setOpen(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  const unread = notifs.filter(n => !n.read).length;

  const dismissOne = async (id: string) => {
    console.log('[notification] dismiss clicked', id);
    const { error } = await supabase.from('notifications').update({ dismissed: true }).eq('id', id);
    if (error) { console.error('[notification] dismiss error', error); return; }
    console.log('[notification] dismiss success', id);
    setNotifs(prev => prev.filter(n => n.id !== id));
  };

  const btnRef = useRef<HTMLButtonElement>(null);
  const [dropRect, setDropRect] = useState<DOMRect | null>(null);

  const handleOpen = () => {
    if (!open && btnRef.current) setDropRect(btnRef.current.getBoundingClientRect());
    setOpen(o => {
      const opening = !o;
      if (opening) {
        const unreadIds = notifs.filter(n => !n.read).map(n => n.id);
        if (unreadIds.length > 0) {
          setNotifs(prev => prev.map(n => unreadIds.includes(n.id) ? { ...n, read: true } : n));
          supabase.from('notifications').update({ read: true, read_at: new Date().toISOString() }).in('id', unreadIds).then(null, () => {});
        }
      }
      return opening;
    });
  };

  return (
    <div ref={ref}>
      <button ref={btnRef} onClick={handleOpen} style={{ position: 'relative', background: 'transparent', border: 'none', color: 'white', cursor: 'pointer', fontSize: 20, padding: '4px 6px', lineHeight: 1 }}>
        🔔
        {unread > 0 && (
          <span style={{ position: 'absolute', top: 0, right: 0, background: '#dc3545', color: '#fff', borderRadius: '50%', fontSize: 10, width: 16, height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold', lineHeight: 1 }}>{unread > 9 ? '9+' : unread}</span>
        )}
      </button>
      {open && dropRect && ReactDOM.createPortal(
        <div ref={portalRef} style={{ position: 'fixed', top: dropRect.bottom + 4, right: window.innerWidth - dropRect.right, width: 300, background: '#fff', borderRadius: 10, boxShadow: '0 4px 20px rgba(0,0,0,0.2)', zIndex: 9999, overflow: 'hidden' }}>
          <div style={{ padding: '10px 14px', borderBottom: '1px solid #eee', fontSize: 13, fontWeight: 'bold', color: '#333' }}>通知</div>
          <div style={{ maxHeight: 320, overflowY: 'auto' }}>
            {notifs.length === 0 ? (
              <div style={{ padding: '20px', textAlign: 'center', color: '#888', fontSize: 13 }}>通知はありません</div>
            ) : notifs.map(n => (
              <div key={n.id} style={{ padding: '10px 14px', borderBottom: '1px solid #f0f0f0', background: n.read ? '#fff' : '#f0f8ff', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, color: '#333', fontWeight: n.read ? 'normal' : 'bold' }}>{n.message}</div>
                  {n.sub_message && <div style={{ fontSize: 11, color: '#666', marginTop: 2 }}>{n.sub_message}</div>}
                  <div style={{ fontSize: 10, color: '#aaa', marginTop: 4 }}>{(() => { const d = new Date(n.created_at); const now = new Date(); if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: 'numeric', minute: '2-digit' }); const m = d.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric' }); const day = d.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', day: 'numeric' }); const time = d.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' }); return `${m}/${day} ${time}`; })()}</div>
                </div>
                <button onClick={() => dismissOne(n.id)} style={{ background: 'none', border: 'none', color: '#bbb', cursor: 'pointer', fontSize: 14, padding: '0 2px', flexShrink: 0, lineHeight: 1 }}>✕</button>
              </div>
            ))}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
};

const AvatarMenu: React.FC<{ userId: string; profileName: string | null; email: string; onLogout: () => void }> = ({ userId: _userId, profileName, email, onLogout }) => {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const portalRef2 = useRef<HTMLDivElement>(null);
  const btnRef2 = useRef<HTMLDivElement>(null);
  const [dropRect2, setDropRect2] = useState<DOMRect | null>(null);

  useEffect(() => {
    const h = (e: MouseEvent) => {
      const inside = (ref.current?.contains(e.target as Node)) || (portalRef2.current?.contains(e.target as Node));
      if (!inside) setOpen(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  const initial = (profileName || email || '?')[0].toUpperCase();

  return (
    <div ref={ref} style={{ flexShrink: 0 }}>
      <div ref={btnRef2} onClick={() => { if (!open && btnRef2.current) setDropRect2(btnRef2.current.getBoundingClientRect()); setOpen(o => !o); }} style={{ width: 38, height: 38, borderRadius: '50%', background: '#4a90d9', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 15, fontWeight: 'bold', cursor: 'pointer', userSelect: 'none' }}>
        {initial}
      </div>
      {open && dropRect2 && ReactDOM.createPortal(
        <div ref={portalRef2} style={{ position: 'fixed', top: dropRect2.bottom + 6, right: window.innerWidth - dropRect2.right, width: 200, background: '#fff', borderRadius: 12, boxShadow: '0 4px 20px rgba(0,0,0,0.2)', zIndex: 9999, overflow: 'hidden' }}>
          <div style={{ padding: '12px 14px', borderBottom: '1px solid #eee', display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ width: 32, height: 32, borderRadius: '50%', background: '#4a90d9', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 13, fontWeight: 'bold', flexShrink: 0 }}>{initial}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 'bold', color: '#333', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{profileName || email}</div>
              <div onClick={() => { navigate('/account'); setOpen(false); }} style={{ fontSize: 11, color: '#4a90d9', cursor: 'pointer', marginTop: 2 }}>アカウント設定 →</div>
            </div>
          </div>
          <div style={{ padding: '10px 14px' }}>
            <button onClick={onLogout} style={{ width: '100%', padding: '8px', borderRadius: 8, border: '1px solid #ddd', background: 'transparent', color: '#666', cursor: 'pointer', fontSize: 13 }}>ログアウト</button>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
};

const useBoardUnread = (userId: string | undefined, pathname: string) => {
  const [channelCount, setChannelCount] = useState(0);
  const [inboxCount,   setInboxCount]   = useState(0);
  const prevPath = useRef(pathname);

  const fetchCount = useCallback(async () => {
    if (!userId) return;

    const [memberRes, inboxRes] = await Promise.all([
      supabase.from('board_channel_members').select('channel_id').eq('user_id', userId),
      supabase.from('board_message_recipients').select('message_id').eq('user_id', userId).eq('archived', false),
    ]);

    // チャンネル未読（board_reads を唯一の既読判定ソースとして使用）
    let channelUnread = 0;
    if (memberRes.data && memberRes.data.length > 0) {
      const channelIds = memberRes.data.map((r: any) => r.channel_id);
      const { data: msgs } = await supabase.from('board_messages').select('id').in('channel_id', channelIds).is('parent_id', null).neq('user_id', userId);
      if (msgs && msgs.length > 0) {
        const msgIds = msgs.map((m: any) => m.id);
        const { data: reads } = await supabase.from('board_reads').select('message_id').eq('user_id', userId).in('message_id', msgIds);
        const readSet = new Set((reads || []).map((r: any) => r.message_id));
        channelUnread = msgIds.filter((id: string) => !readSet.has(id)).length;
      }
    }

    // 受信トレイ未読（予約中(status='scheduled')はまだ送信されていないためカウントしない）
    let inboxUnread = 0;
    if (inboxRes.data && inboxRes.data.length > 0) {
      const inboxMsgIds = inboxRes.data.map((r: any) => r.message_id);
      const { data: sentMsgs } = await supabase.from('board_messages').select('id').in('id', inboxMsgIds).eq('status', 'sent');
      const sentMsgIds = (sentMsgs || []).map((m: any) => m.id);
      const { data: reads } = await supabase.from('board_reads').select('message_id').eq('user_id', userId).in('message_id', sentMsgIds);
      const readSet = new Set((reads || []).map((r: any) => r.message_id));
      inboxUnread = sentMsgIds.filter((id: string) => !readSet.has(id)).length;
    }

    setChannelCount(channelUnread);
    setInboxCount(inboxUnread);
  }, [userId]);

  useEffect(() => {
    if (prevPath.current === '/board' && pathname !== '/board') {
      fetchCount();
    }
    prevPath.current = pathname;
  }, [pathname, fetchCount]);

  useEffect(() => { fetchCount(); const t = setInterval(fetchCount, 30000); return () => clearInterval(t); }, [fetchCount]);
  return { total: channelCount + inboxCount, channelOnly: channelCount };
};

const NavBar: React.FC<{ isAdmin: boolean; onLogout: () => void; email: string; profileName: string | null; canLeave?: boolean; canApprove?: boolean; canShiftReport?: boolean; canCalendar?: boolean; canPurchaseRequest?: boolean; roleTitle?: string; userId?: string }> = ({ isAdmin, onLogout, email, profileName, canLeave, canApprove: _canApprove, canShiftReport, canCalendar, canPurchaseRequest, roleTitle, userId }) => {
  const navigate = useNavigate();
  const location = useLocation();
  const { previewRole, setPreviewRole, user: ctxUser } = useContext(AuthContext);
  const realIsAdmin = ctxUser?.app_metadata?.role === 'admin';
  // 機能の公開/非公開（管理者は常に表示）
  // 全公開ON → 全員 / 全公開OFF+リーダー以上ON → リーダー以上のみ / 両方OFF → 管理者のみ
  const featurePublishState = useFeaturePublished();
  const isPub = (key: string) => isFeaturePublished(key, featurePublishState, isAdmin, roleTitle);
  const navTo = (path: string) => {
    if (location.pathname === path) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
      if (path === '/board') {
        window.dispatchEvent(new CustomEvent('board-reset'));
      }
      return;
    }
    navigate(path);
  };
  const [isMobile, setIsMobile] = useState(window.innerWidth < 640);
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 640);
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);
  const { total: boardUnread } = useBoardUnread(userId, location.pathname);

  // モバイルでボタンが画面幅に収まらない時の横スワイプ対応：
  // 端までスクロールできることを示すフェードの表示/非表示を判定
  const navScrollRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const updateScrollFade = useCallback(() => {
    const el = navScrollRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 2);
    setCanScrollRight(el.scrollWidth - el.clientWidth - el.scrollLeft > 2);
  }, []);
  useEffect(() => {
    updateScrollFade();
    window.addEventListener('resize', updateScrollFade);
    return () => window.removeEventListener('resize', updateScrollFade);
    // isPub の判定材料（featurePublishState等）が非同期で確定してボタン数が変わった時にも再計算する
  }, [updateScrollFade, isMobile, featurePublishState, isAdmin, canLeave, canShiftReport, canCalendar]);

  const btnStyle = (active: boolean, activeColor = '#007bff') => isMobile ? ({
    width: 44, height: 44, borderRadius: 8, border: 'none', cursor: 'pointer',
    background: active ? activeColor : '#444',
    color: 'white', fontSize: 9, display: 'flex', flexDirection: 'column' as const,
    alignItems: 'center', justifyContent: 'center', gap: 1, padding: 0, flexShrink: 0,
  }) : ({
    padding: '6px 14px', borderRadius: 6, border: 'none', cursor: 'pointer',
    background: active ? activeColor : '#444', color: 'white', fontSize: 14, whiteSpace: 'nowrap' as const,
  });

  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, zIndex: 300,
      background: '#1a1a2e', color: 'white',
      boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
    }}>
      {/* メインナビ行 */}
      <div style={{
        height: 60, padding: '0 12px', display: 'flex',
        justifyContent: 'space-between', alignItems: 'center',
        overflow: 'hidden', boxSizing: 'border-box',
      }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 0, alignSelf: 'stretch', display: 'flex', alignItems: 'center' }}>
        <div
          ref={navScrollRef}
          onScroll={updateScrollFade}
          className={isMobile ? 'navbar-scroll' : undefined}
          style={{
            display: 'flex', gap: 4, flexWrap: isMobile ? 'nowrap' : 'wrap', alignItems: 'center',
            flex: 1, minWidth: 0, overflowX: isMobile ? 'auto' : 'visible',
            scrollbarWidth: 'none', padding: isMobile ? '6px 4px' : 0, boxSizing: 'border-box',
          }}
        >
          {isAdmin && (
            <button onClick={() => navTo('/admin')} style={btnStyle(location.pathname === '/admin', '#6f42c1')}>
              {isMobile ? <><span style={{ fontSize: 20 }}>⚙️</span><span>管理</span></> : '⚙️ 管理'}
            </button>
          )}
          {isPub('expense') && (
            <button onClick={() => navTo('/')} style={btnStyle(location.pathname === '/')}>
              {isMobile ? <><span style={{ fontSize: 20 }}>🏠</span><span>交通費</span></> : '🏠 交通費'}
            </button>
          )}
          {isPub('trip_report') && (
            <button onClick={() => navTo('/trip-report')} style={btnStyle(location.pathname === '/trip-report')}>
              {isMobile ? <><span style={{ fontSize: 20 }}>📍</span><span>出張報告</span></> : '📍 出張報告'}
            </button>
          )}
          {canLeave && isPub('leave_request') && (
            <button onClick={() => navTo('/leave')} style={btnStyle(location.pathname === '/leave', '#28a745')}>
              {isMobile ? <><span style={{ fontSize: 20 }}>🌿</span><span>休暇申請</span></> : '🌿 休暇申請'}
            </button>
          )}
          {(isAdmin || canCalendar) && isPub('leave_calendar') && (
            <button onClick={() => navTo('/calendar')} style={btnStyle(location.pathname === '/calendar', '#4a90d9')}>
              {isMobile ? <><span style={{ fontSize: 20 }}>📅</span><span>休暇</span></> : '📅 休暇'}
            </button>
          )}
          {canShiftReport && isPub('shift_report') && (
            <button onClick={() => navTo('/shift-report')} style={btnStyle(location.pathname === '/shift-report', '#c0392b')}>
              {isMobile ? <><span style={{ fontSize: 20 }}>⏰</span><span>勤務変更</span></> : '⏰ 勤務変更'}
            </button>
          )}
          {canPurchaseRequest && isPub('purchase_request') && (
            <button onClick={() => navTo('/purchase')} style={btnStyle(location.pathname === '/purchase', '#17a2b8')}>
              {isMobile ? <><span style={{ fontSize: 20 }}>🧾</span><span>備品精算</span></> : '🧾 備品精算'}
            </button>
          )}
          {isPub('board') && (
          <div style={{ position: 'relative', display: 'inline-block', flexShrink: 0 }}>
            <button onClick={() => navTo('/board')} style={btnStyle(location.pathname === '/board', '#e67e22')}>
              {isMobile ? <><span style={{ fontSize: 20 }}>💬</span><span>連絡板</span></> : '💬 連絡板'}
            </button>
            {boardUnread > 0 && location.pathname !== '/board' && (
              <span style={{ position: 'absolute', top: -4, right: -4, background: '#dc3545', color: '#fff', borderRadius: 10, fontSize: 10, minWidth: 18, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold', padding: '0 3px', border: '2px solid #1a1a2e', pointerEvents: 'none' }}>
                {boardUnread > 99 ? '99+' : boardUnread}
              </span>
            )}
          </div>
          )}
        </div>
        {isMobile && canScrollLeft && (
          <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 20, background: 'linear-gradient(to right, #1a1a2e, transparent)', pointerEvents: 'none' }} />
        )}
        {isMobile && canScrollRight && (
          <div style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: 20, background: 'linear-gradient(to left, #1a1a2e, transparent)', pointerEvents: 'none' }} />
        )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0, paddingLeft: 6 }}>
          {realIsAdmin && (
            <select
              value={previewRole || ''}
              onChange={e => setPreviewRole(e.target.value || null)}
              title="役職プレビュー"
              style={{
                fontSize: 11, padding: '3px 4px', borderRadius: 6,
                border: previewRole ? '2px solid #ffc107' : '1px solid #555',
                background: previewRole ? '#ffc107' : '#2d2d4e',
                color: previewRole ? '#333' : '#aaa',
                cursor: 'pointer', maxWidth: isMobile ? 54 : 100,
              }}
            >
              <option value="">👁 確認</option>
              <option value="パート">パート</option>
              <option value="一般">正社員（一般）</option>
              <option value="リーダー">リーダー</option>
              <option value="マネージャー">マネージャー</option>
              <option value="フロア責任者">フロア責任者</option>
              <option value="社長">社長</option>
            </select>
          )}
          {userId && <BellIcon userId={userId} />}
          {userId && <AvatarMenu userId={userId} profileName={profileName} email={email} onLogout={onLogout} />}
        </div>
      </div>
      {/* プレビューバナー行（NavBar内に統合） */}
      {previewRole && (
        <div style={{
          background: '#ffc107', color: '#333', fontSize: 12, fontWeight: 'bold',
          padding: '5px 16px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
        }}>
          👁 プレビュー中：{previewRole} として表示
          <button onClick={() => setPreviewRole(null)}
            style={{ fontSize: 11, padding: '2px 10px', borderRadius: 4, border: 'none', background: '#333', color: '#fff', cursor: 'pointer' }}>
            × 終了
          </button>
        </div>
      )}
    </div>
  );
};

// プレビュー時にページコンテンツを下にずらす（NavBarのバナー行分）
const PreviewBodyOffset: React.FC = () => {
  const { previewRole } = useContext(AuthContext);
  useEffect(() => {
    const offset = previewRole ? '32px' : '0px';
    const topbarHeight = previewRole ? '92px' : '60px';
    document.body.style.paddingTop = offset;
    document.documentElement.style.setProperty('--topbar-height', topbarHeight);
    return () => {
      document.body.style.paddingTop = '0px';
      document.documentElement.style.setProperty('--topbar-height', '60px');
    };
  }, [previewRole]);
  return null;
};

// 通知バナー（notifications テーブルから未読を表示）
const NotifItem: React.FC<{ n: { id: string; message: string; sub_message: string | null; read: boolean; source_type: string | null; reference_id: string | null }; onDismiss: (id: string) => void }> = ({ n, onDismiss }) => {
  const navigate = useNavigate();
  const isEnc = n.message.includes('有給奨励日');
  const isUnconfirmedReminder = n.message.includes('への対応がまだ完了していません');
  const isBoard = !isUnconfirmedReminder && (n.source_type === 'inbox' || n.message.includes('お知らせ') || n.message.includes('メッセージが届き') || n.message.includes('リマインド'));

  // source_typeで種別を判定（休暇申請・勤務変更申請）。文言ではなくsource_typeを正とする
  const isLeavePendingApproval = n.source_type === 'leave_request:pending_approval'; // 承認者：要対応
  const isLeavePendingResubmit = n.source_type === 'leave_request:pending_resubmit'; // 申請者：再提出/取消待ち
  const isLeaveResult          = n.source_type === 'leave_request';                  // 申請者：結果報告のみ
  const isShiftPendingApproval = n.source_type === 'shift_report:pending_approval';  // レビュアー：要対応
  const isShiftPendingResubmit = n.source_type === 'shift_report:pending_resubmit';  // 申請者：再提出/取消待ち
  const isShiftResult          = n.source_type === 'shift_report';                   // 申請者：結果報告のみ
  const isTimeAdjustment       = n.source_type === 'time_adjustment';                // 上長：FYI（対応不要）
  const isPurchasePendingApproval = n.source_type === 'purchase_request:pending_approval'; // リーダー：要対応
  const isPurchaseResult          = n.source_type === 'purchase_request';                  // 申請者：結果報告のみ
  const isPendingAction = isLeavePendingApproval || isLeavePendingResubmit || isShiftPendingApproval || isShiftPendingResubmit || isPurchasePendingApproval;
  const isResultOnly = isLeaveResult || isShiftResult || isTimeAdjustment || isPurchaseResult;
  // 旧来のフォールバック（source_typeが無い通知向け）
  const isLegacyReject = !isPendingAction && !isResultOnly && (n.message.includes('差し戻し') || n.message.includes('差し戻され'));

  const isGreenTone = isBoard || isPendingAction || isResultOnly || isUnconfirmedReminder;

  const bgColor    = isLegacyReject ? '#fff5f5' : isGreenTone ? '#f0fdf4' : '#f0fdf4';
  const borderMain = isLegacyReject ? '#dc3545' : isGreenTone ? '#28a745' : '#28a745';
  const borderSub  = isLegacyReject ? '#f5b8bb' : isGreenTone ? '#b7e4cc' : '#b7e4cc';
  const textColor  = isLegacyReject ? '#721c24' : isGreenTone ? '#155724' : '#155724';
  const subColor   = isLegacyReject ? '#a03030' : isGreenTone ? '#3a7d52' : '#3a7d52';

  // タップ＝詳細画面への移動。結果報告のみ（A分類）はタップで閉じる。要対応（B分類）は対応完了まで残る。
  const handleTap = () => {
    if (isEnc) { navigate('/leave'); return; }
    if (isBoard || isUnconfirmedReminder) {
      if (n.reference_id) { navigate(`/board?openInboxId=${n.reference_id}`); } else { navigate('/board'); }
      return;
    }
    if (isLeavePendingApproval) { navigate('/leave-approvals'); return; }
    if (isLeavePendingResubmit) { navigate('/leave?tab=history'); return; }
    if (isLeaveResult) { navigate('/leave?tab=history'); onDismiss(n.id); return; }
    if (isShiftPendingApproval) { navigate('/shift-report?view=confirm'); return; }
    if (isShiftPendingResubmit) { navigate('/shift-report?tab=history'); return; }
    if (isShiftResult) { navigate('/shift-report?tab=history'); onDismiss(n.id); return; }
    if (isTimeAdjustment) { onDismiss(n.id); return; }
    if (isPurchasePendingApproval) { navigate('/purchase?tab=approvals'); return; }
    if (isPurchaseResult) { navigate('/purchase?tab=history'); onDismiss(n.id); return; }
    if (isLegacyReject) { navigate('/leave'); return; }
  };

  return (
    <div style={{
      background: bgColor, border: `1px solid ${borderSub}`,
      borderLeft: `4px solid ${borderMain}`,
      borderRadius: '0 10px 10px 0',
      padding: '12px 16px', marginBottom: 10,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <div onClick={handleTap} style={{ flex: 1, cursor: 'pointer' }}>
          <div style={{ fontWeight: 500, fontSize: 14, color: textColor }}>{n.message}</div>
          {n.sub_message && <div style={{ fontSize: 12, color: subColor }}>{n.sub_message}</div>}
        </div>
        <div onClick={handleTap} style={{ fontSize: 12, color: subColor, whiteSpace: 'nowrap', flexShrink: 0, cursor: 'pointer', marginTop: 2 }}>タップして確認 →</div>
        <button onClick={() => onDismiss(n.id)} title="このお知らせを閉じる"
          style={{ background: 'none', border: 'none', color: subColor, cursor: 'pointer', fontSize: 15, padding: '0 2px', flexShrink: 0, lineHeight: 1 }}>✕</button>
      </div>
    </div>
  );
};

const NotificationBanner: React.FC<{ userId: string }> = ({ userId }) => {
  const [notifs, setNotifs] = useState<{ id: string; message: string; sub_message: string | null; read: boolean; source_type: string | null; reference_id: string | null }[]>([]);
  const [expanded, setExpanded] = useState(false);

  const fetchNotifs = useCallback(async () => {
    const { data } = await supabase
      .from('notifications')
      .select('id, message, sub_message, read, source_type, reference_id')
      .eq('user_id', userId)
      .eq('banner_dismissed', false)
      .not('message', 'like', '%有給奨励日%')
      // 「要対応」の承認待ちは専用の集計バナー(LeaveApprovalBanner/ShiftReportApprovalBanner)が別途出るため、ここでは重複表示しない
      .not('source_type', 'in', '(leave_request:pending_approval,shift_report:pending_approval)')
      .or('source_type.is.null,source_type.neq.board')
      .order('created_at', { ascending: false });
    if (!data) return;

    // 連絡板メッセージは、本体を既に読んでいたら(board_reads)バナーも自動で消す
    // （連絡板の通知は source_type が null で保存されるため、表示側と同じくメッセージ文言で判定する）
    // ただし「未対応の催促リマインド」は"読んだだけ"では対応完了にならないため、board_confirmations（回答済みか）で別判定する
    const isUnconfirmedReminder = (n: typeof data[number]) => n.message.includes('への対応がまだ完了していません');
    const isBoardNotif = (n: typeof data[number]) => !isUnconfirmedReminder(n) && (n.source_type === 'inbox' || n.message.includes('お知らせ') || n.message.includes('メッセージが届き') || n.message.includes('リマインド'));

    const boardMsgIds = [...new Set(data.filter(n => isBoardNotif(n) && n.reference_id).map(n => n.reference_id as string))];
    const confirmMsgIds = [...new Set(data.filter(n => isUnconfirmedReminder(n) && n.reference_id).map(n => n.reference_id as string))];

    let alreadyRead = new Set<string>();
    if (boardMsgIds.length > 0) {
      const { data: reads } = await supabase.from('board_reads').select('message_id').eq('user_id', userId).in('message_id', boardMsgIds);
      alreadyRead = new Set((reads || []).map(r => r.message_id));
    }
    let alreadyConfirmed = new Set<string>();
    if (confirmMsgIds.length > 0) {
      const { data: confs } = await supabase.from('board_confirmations').select('message_id').eq('user_id', userId).in('message_id', confirmMsgIds);
      alreadyConfirmed = new Set((confs || []).map(c => c.message_id));
    }

    // 休暇申請・勤務変更申請の「要対応」通知は、対象レコードのステータスが進んだら自動で消す
    // （N+1を避けるため、休暇申請・勤務変更申請それぞれ1回のクエリにまとめて取得する）
    const leaveIds = [...new Set(data.filter(n => (n.source_type === 'leave_request:pending_approval' || n.source_type === 'leave_request:pending_resubmit') && n.reference_id).map(n => n.reference_id as string))];
    const shiftIds = [...new Set(data.filter(n => (n.source_type === 'shift_report:pending_approval' || n.source_type === 'shift_report:pending_resubmit') && n.reference_id).map(n => n.reference_id as string))];

    const leaveMap = new Map<string, { status: string; user_id: string; approver_id: string | null; approver2_id: string | null }>();
    if (leaveIds.length > 0) {
      const { data: rows } = await supabase.from('leave_requests').select('id, status, user_id, approver_id, approver2_id').in('id', leaveIds);
      (rows || []).forEach((r: any) => leaveMap.set(r.id, r));
    }
    const shiftMap = new Map<string, { status: string; applicant_id: string; reviewer_id: string | null }>();
    if (shiftIds.length > 0) {
      const { data: rows } = await supabase.from('shift_reports').select('id, status, applicant_id, reviewer_id').in('id', shiftIds);
      (rows || []).forEach((r: any) => shiftMap.set(r.id, r));
    }

    // データが取れない場合（RLS等）は安全側に倒して「まだ対応中」扱いにし、消さない
    const isResolvedPending = (n: typeof data[number]): boolean => {
      if (!n.reference_id) return false;
      if (n.source_type === 'leave_request:pending_approval') {
        const r = leaveMap.get(n.reference_id);
        if (!r) return false;
        const stillPending = (r.status === 'pending' && r.approver_id === userId) || (r.status === 'step2_pending' && r.approver2_id === userId);
        return !stillPending;
      }
      if (n.source_type === 'leave_request:pending_resubmit') {
        const r = leaveMap.get(n.reference_id);
        if (!r) return false;
        return !(r.status === 'rejected' && r.user_id === userId);
      }
      if (n.source_type === 'shift_report:pending_approval') {
        const r = shiftMap.get(n.reference_id);
        if (!r) return false;
        const stillPending = r.reviewer_id === userId && (r.status === 'pending' || r.status === 'resubmitted');
        return !stillPending;
      }
      if (n.source_type === 'shift_report:pending_resubmit') {
        const r = shiftMap.get(n.reference_id);
        if (!r) return false;
        return !(r.status === 'returned' && r.applicant_id === userId);
      }
      return false;
    };

    const isAlreadyReadInBoard = (n: typeof data[number]) =>
      (isBoardNotif(n) && !!n.reference_id && alreadyRead.has(n.reference_id)) ||
      (isUnconfirmedReminder(n) && !!n.reference_id && alreadyConfirmed.has(n.reference_id));

    const shouldAutoDismiss = (n: typeof data[number]) => isAlreadyReadInBoard(n) || isResolvedPending(n);

    const toAutoDismiss = data.filter(shouldAutoDismiss);
    if (toAutoDismiss.length > 0) {
      supabase.from('notifications').update({ read: true, banner_dismissed: true }).in('id', toAutoDismiss.map(n => n.id)).then(null, () => {});
    }
    setNotifs(data.filter(n => !shouldAutoDismiss(n)));
  }, [userId]);

  useEffect(() => { fetchNotifs(); }, [fetchNotifs]);

  const dismiss = useCallback(async (id: string) => {
    await supabase.from('notifications').update({ read: true, banner_dismissed: true }).eq('id', id);
    setNotifs(prev => prev.filter(n => n.id !== id));
  }, []);

  if (notifs.length === 0) return null;

  const visible = expanded ? notifs : notifs.slice(0, 2);
  const hiddenCount = notifs.length - 2;

  return (
    <>
      {visible.map(n => <NotifItem key={n.id} n={n} onDismiss={dismiss} />)}
      {!expanded && hiddenCount > 0 && (
        <div onClick={() => setExpanded(true)}
          style={{ textAlign: 'center', fontSize: 12, color: '#3b82f6', padding: '4px 0 8px', cursor: 'pointer' }}>
          他{hiddenCount}件を表示 ▼
        </div>
      )}
    </>
  );
};

const DOW = ['日', '月', '火', '水', '木', '金', '土'];
const fmtDow = (dateStr: string) => {
  const d = new Date(dateStr + 'T00:00:00Z');
  return `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日(${DOW[d.getUTCDay()]})`;
};

// 有給奨励日バナー（消せない固定バナー）
type EncDay = { id: string; target_date: string; deadline: string };
const EncouragementBanner: React.FC<{ userId: string; refreshKey: number; onAnswer: (day: EncDay) => void }> = ({ userId, refreshKey, onAnswer }) => {
  const [pending, setPending] = useState<EncDay[]>([]);

  useEffect(() => {
    const fetch = async () => {
      const { data: targets } = await supabase.from('paid_leave_encouragement_targets').select('encouragement_day_id').eq('user_id', userId);
      if (!targets || targets.length === 0) { setPending([]); return; }
      const dayIds = targets.map((t: { encouragement_day_id: string }) => t.encouragement_day_id);
      const { data: responses } = await supabase.from('paid_leave_encouragement_responses').select('encouragement_day_id').eq('user_id', userId).in('encouragement_day_id', dayIds);
      const answeredIds = new Set((responses || []).map((r: { encouragement_day_id: string }) => r.encouragement_day_id));
      const unansweredIds = dayIds.filter((id: string) => !answeredIds.has(id));
      if (unansweredIds.length === 0) { setPending([]); return; }
      const { data: days } = await supabase.from('paid_leave_encouragement_days').select('id, target_date, deadline').in('id', unansweredIds).order('deadline', { ascending: true });
      if (days) setPending(days);
    };
    fetch();
  }, [userId, refreshKey]);

  if (pending.length === 0) return null;

  return (
    <>
      {pending.map(d => {
        const today = new Date().toISOString().slice(0, 10);
        const diff = Math.round((new Date(d.deadline + 'T00:00:00Z').getTime() - new Date(today + 'T00:00:00Z').getTime()) / 86400000);
        const dateLabel = `${Number(d.deadline.slice(5,7))}月${Number(d.deadline.slice(8,10))}日`;
        let msg: string;
        if (diff > 3) msg = `📅 有給奨励日の回答をお願いします（期限：${dateLabel}）`;
        else if (diff === 3) msg = `⚠️ 有給奨励日の回答期限まで3日です`;
        else if (diff === 2) msg = `⚠️ 有給奨励日の回答期限まで2日です`;
        else if (diff === 1) msg = `⚠️ 有給奨励日の回答期限まで1日です`;
        else if (diff === 0) msg = `🔴 本日が回答期限です！`;
        else msg = `❗ 有給奨励日の回答が未完了です`;
        const bg = diff <= 0 ? '#dc3545' : diff <= 1 ? '#fd7e14' : diff <= 3 ? '#ffc107' : '#007bff';
        return (
          <div key={d.id} onClick={() => onAnswer(d)}
            style={{ cursor: 'pointer', marginBottom: 10, padding: '12px 16px', borderRadius: 10,
              background: bg, color: '#fff', fontSize: 14, fontWeight: 'bold',
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              boxShadow: '0 2px 8px rgba(0,0,0,0.15)' }}>
            <span>{msg}　（対象日: {fmtDow(d.target_date)}）</span>
            <span style={{ fontSize: 12, opacity: 0.85, whiteSpace: 'nowrap', marginLeft: 8 }}>タップして回答 →</span>
          </div>
        );
      })}
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

// 勤務変更申請の承認待ち通知バナー
const ShiftReportApprovalBanner: React.FC<{ userId: string; roleTitle: string; isAdmin: boolean; canShiftReport: boolean }> = ({ userId, roleTitle, isAdmin, canShiftReport }) => {
  const navigate = useNavigate();
  const [pendingCount, setPendingCount] = useState(0);

  useEffect(() => {
    if (!canShiftReport) return;
    if (!isAdmin && !['リーダー', 'マネージャー', 'フロア責任者', '社長', '管理者'].includes(roleTitle)) return;

    const fetchPending = async () => {
      const { data } = await supabase
        .from('shift_reports')
        .select('id')
        .eq('reviewer_id', userId)
        .in('status', ['pending', 'resubmitted']);
      setPendingCount(data?.length ?? 0);
    };
    fetchPending();
  }, [userId, roleTitle, isAdmin, canShiftReport]);

  if (pendingCount === 0) return null;

  return (
    <div
      onClick={() => navigate('/shift-report?view=confirm')}
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
      <span style={{ fontSize: 22 }}>⏰</span>
      <span>勤務変更申請の確認依頼が {pendingCount}件 あります</span>
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
    canShiftReport,
    canCalendar,
    canPurchaseRequest,
    leaveRequestEnabled,
    handleLogout
  } = useAuth();

  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { submissions, isLoading, fetchExpenses } = useExpenses(user, isAdmin);

  const [expenses, setExpensesState] = useState<Expense[]>([]);
  const [templateQueue, setTemplateQueue] = useState<Expense[]>([]);
  const [encAnsweringDay, setEncAnsweringDay] = useState<EncDay | null>(null);
  const [encAnswerChoice, setEncAnswerChoice] = useState<number | null>(null);
  const [encAnswerNote, setEncAnswerNote] = useState('');
  const [encAnswerSubmitting, setEncAnswerSubmitting] = useState(false);
  const [encRefreshKey, setEncRefreshKey] = useState(0);
  const [encAnswerSuccess, setEncAnswerSuccess] = useState(false);
  const [showLeaveModal, setShowLeaveModal] = useState(false);
  const [leaveSubmitted, setLeaveSubmitted] = useState(false);
  const { channelOnly: boardChannelUnread } = useBoardUnread(user?.id, pathname);

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

  const encAnswerModal = encAnsweringDay ? (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 3000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ background: '#343a40', borderRadius: 16, padding: 24, width: '100%', maxWidth: 420, boxSizing: 'border-box' }}>
        <h3 style={{ margin: '0 0 4px', color: '#fff', fontSize: 16 }}>📅 有給奨励日への回答</h3>
        <p style={{ margin: '0 0 16px', fontSize: 13, color: '#adb5bd' }}>対象日: {fmtDow(encAnsweringDay.target_date)}　期限: {fmtDow(encAnsweringDay.deadline)}</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
          {([1, 2, 3, 4] as const).map(n => {
            const labels: Record<number, string> = { 1: '有給休暇', 2: '欠勤（調整休）', 3: '定休日', 4: 'その他' };
            const colors: Record<number, string> = { 1: '#28a745', 2: '#fd7e14', 3: '#17a2b8', 4: '#6c757d' };
            const selected = encAnswerChoice === n;
            return (
              <button key={n} onClick={() => setEncAnswerChoice(n)} style={{
                padding: '12px 16px', borderRadius: 10,
                border: selected ? `2px solid ${colors[n]}` : '1px solid #6c757d',
                background: selected ? colors[n] : '#495057',
                color: '#fff', fontSize: 14, fontWeight: selected ? 'bold' : 'normal', cursor: 'pointer', textAlign: 'left',
              }}>{labels[n]}</button>
            );
          })}
        </div>
        {encAnswerChoice === 4 && (
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 12, color: '#adb5bd', display: 'block', marginBottom: 4 }}>備考（必須）</label>
            <textarea value={encAnswerNote} onChange={e => setEncAnswerNote(e.target.value)} rows={3}
              style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid #6c757d', background: '#495057', color: '#fff', fontSize: 13, resize: 'vertical', boxSizing: 'border-box' }}
              placeholder="詳細を入力してください" />
          </div>
        )}
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={() => { setEncAnsweringDay(null); setEncAnswerChoice(null); setEncAnswerNote(''); }}
            style={{ flex: 1, padding: '10px 0', background: '#495057', color: '#fff', border: 'none', borderRadius: 10, cursor: 'pointer', fontSize: 13 }}>キャンセル</button>
          <button disabled={!encAnswerChoice || (encAnswerChoice === 4 && !encAnswerNote.trim()) || encAnswerSubmitting}
            onClick={async () => {
              if (!encAnswerChoice || !encAnsweringDay) return;
              if (encAnswerChoice === 4 && !encAnswerNote.trim()) return;
              setEncAnswerSubmitting(true);
              await supabase.from('paid_leave_encouragement_responses').insert({
                encouragement_day_id: encAnsweringDay.id,
                user_id: user.id,
                choice: encAnswerChoice,
                note: encAnswerNote.trim() || null,
              });
              // TODO: 申請フォーム送信後の追加処理（例：奨励日との照合・連携）をここに追加
              {
                const encLeaveType = encAnswerChoice === 1 ? '有給休暇' : encAnswerChoice === 2 ? '調整休' : 'その他';
                const encLeaveTypeOther = encAnswerChoice === 3 ? '定休日' : encAnswerChoice === 4 ? (encAnswerNote.trim() || 'その他') : undefined;
                await supabase.from('leave_requests').insert({
                  user_id: user.id,
                  leave_type: encLeaveType,
                  ...(encLeaveTypeOther ? { leave_type_other: encLeaveTypeOther } : {}),
                  leave_dates: JSON.stringify([encAnsweringDay.target_date]),
                  start_date: encAnsweringDay.target_date,
                  end_date: encAnsweringDay.target_date,
                  purpose: '有給奨励日',
                  reason: '【有給奨励日】',
                  status: 'approved',
                  current_approver: 'none',
                });
              }
              setEncAnswerSubmitting(false);
              setEncAnsweringDay(null); setEncAnswerChoice(null); setEncAnswerNote('');
              setEncRefreshKey(k => k + 1);
              setEncAnswerSuccess(true);
              setTimeout(() => setEncAnswerSuccess(false), 3000);
            }}
            style={{ flex: 2, padding: '10px 0', background: encAnswerSubmitting ? '#6c757d' : '#28a745', color: '#fff', border: 'none', borderRadius: 10, cursor: encAnswerSubmitting ? 'default' : 'pointer', fontSize: 13, fontWeight: 'bold' }}>
            {encAnswerSubmitting ? '送信中...' : '回答を送信'}
          </button>
        </div>
      </div>
    </div>
  ) : null;

  return (
    <div style={{ maxWidth: 800, margin: '0 auto', position: 'relative', padding: '70px 16px 0', boxSizing: 'border-box' as const, width: '100%' }}>
      {encAnswerModal}
      {encAnswerSuccess && (
        <div style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', zIndex: 4000, background: '#f0fdf4', border: '1.5px solid #b7e4cc', borderRadius: 18, padding: '24px 32px', textAlign: 'center', boxShadow: '0 4px 20px rgba(0,0,0,0.2)' }}>
          <div style={{ fontSize: 40, marginBottom: 10 }}>✅</div>
          <div style={{ fontSize: 15, fontWeight: 'bold', color: '#155724' }}>回答を送信しました</div>
        </div>
      )}
      <NavBar isAdmin={isAdmin} onLogout={handleLogout} email={user.email || ''} profileName={profileName} canLeave={canLeave} canApprove={isApprover} canShiftReport={canShiftReport} canCalendar={canCalendar} canPurchaseRequest={canPurchaseRequest} roleTitle={roleTitle} userId={user.id} />

      {/* ① お知らせ通知バナー（申請者向け） */}
      {!isAdmin && <NotificationBanner userId={user.id} />}

      {/* ② 連絡板未読バナー（グループのみ・消えない） */}
      {boardChannelUnread > 0 && location.pathname !== '/board' && (
        <div onClick={() => navigate('/board')} style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 10, padding: '12px 16px', marginBottom: 10, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ width: 32, height: 32, borderRadius: '50%', background: '#3b82f6', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 15, flexShrink: 0 }}>💬</div>
          <div style={{ fontSize: 14, fontWeight: 'bold', color: '#1e40af', flex: 1 }}>連絡板に未読が{boardChannelUnread}件あります</div>
          <div style={{ fontSize: 12, color: '#3b82f6', whiteSpace: 'nowrap', flexShrink: 0 }}>タップして確認 →</div>
        </div>
      )}

      {/* ③ 有給奨励日バナー（消せない） */}
      <EncouragementBanner userId={user.id} refreshKey={encRefreshKey} onAnswer={d => { setEncAnsweringDay(d); setEncAnswerChoice(null); setEncAnswerNote(''); }} />

      {/* ④ 休暇申請承認バナー（承認者のみ） */}
      <LeaveApprovalBanner userId={user.id} roleTitle={roleTitle} isAdmin={isAdmin} />

      {/* ④-2 勤務変更申請確認バナー（承認者のみ） */}
      <ShiftReportApprovalBanner userId={user.id} roleTitle={roleTitle} isAdmin={isAdmin} canShiftReport={canShiftReport} />

      {/* ⑤ 有給申請バナー（パート向け） */}
      {leaveRequestEnabled && !leaveSubmitted && (
        <div
          onClick={() => setShowLeaveModal(true)}
          style={{ background: '#28a745', color: 'white', borderRadius: 10, padding: '14px 20px', marginBottom: 16, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 12, boxShadow: '0 2px 8px rgba(40,167,69,0.4)' }}
        >
          <span style={{ fontSize: 24 }}>📨</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 'bold', fontSize: 15 }}>有給申請を送信してください</div>
          </div>
          <div style={{ fontSize: 13, opacity: 0.9, whiteSpace: 'nowrap', flexShrink: 0 }}>タップして申請する →</div>
        </div>
      )}
      {showLeaveModal && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 4000, background: '#fff', overflowY: 'auto' }}>
          <div style={{ position: 'sticky', top: 0, zIndex: 10, background: '#fff', padding: '12px 16px', borderBottom: '1px solid #dee2e6', display: 'flex', alignItems: 'center', gap: 12 }}>
            <button onClick={() => setShowLeaveModal(false)}
              style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: '#333', lineHeight: 1 }}>✕</button>
            <span style={{ fontWeight: 'bold', fontSize: 16 }}>休暇申請</span>
          </div>
          <Suspense fallback={<PageLoader />}>
            <LeaveRequestForm user={user} profileName={profileName} roleTitle={roleTitle} leaveRequestEnabled={leaveRequestEnabled} onSubmitSuccess={() => { setShowLeaveModal(false); setLeaveSubmitted(true); }} />
          </Suspense>
        </div>
      )}

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
  const { user, isAdmin, isApprover, profileName, roleTitle, canLeave, canShiftReport, canCalendar, canPurchaseRequest, handleLogout } = useAuth();
  if (!user) return <div>読み込んでいます...</div>;
  return (
    <div style={{ padding: '70px 16px 0' }}>
      <NavBar isAdmin={isAdmin} onLogout={handleLogout} email={user.email || ''} profileName={profileName} canLeave={canLeave} canApprove={isApprover} canShiftReport={canShiftReport} canCalendar={canCalendar} canPurchaseRequest={canPurchaseRequest} roleTitle={roleTitle} userId={user.id} />
      <Suspense fallback={<PageLoader />}>
        <BusinessTripReportForm user={user} profileName={profileName} />
      </Suspense>
    </div>
  );
};

// 休暇申請ページ
const LeaveRequestPage: React.FC = () => {
  const { user, isAdmin, isApprover, profileName, roleTitle, canLeave, canShiftReport, canCalendar, canPurchaseRequest, leaveRequestEnabled, handleLogout } = useAuth();
  if (!user) return <div>読み込んでいます...</div>;
  return (
    <div style={{ padding: '70px 16px 0' }}>
      <NavBar isAdmin={isAdmin} onLogout={handleLogout} email={user.email || ''} profileName={profileName} canLeave={canLeave} canApprove={isApprover} canShiftReport={canShiftReport} canCalendar={canCalendar} canPurchaseRequest={canPurchaseRequest} roleTitle={roleTitle} userId={user.id} />
      <Suspense fallback={<PageLoader />}>
        <LeaveRequestForm user={user} profileName={profileName} roleTitle={roleTitle} leaveRequestEnabled={leaveRequestEnabled} />
      </Suspense>
    </div>
  );
};

// 休暇申請承認ページ（リーダー・マネージャー・管理者用）
const LeaveApprovalsPage: React.FC = () => {
  const { user, isAdmin, isApprover, profileName, roleTitle, canLeave, canShiftReport, canCalendar, canPurchaseRequest, handleLogout, loading } = useAuth();
  if (!user || loading) return <div style={{ padding: 40, textAlign: 'center' }}>読み込んでいます...</div>;
  if (roleTitle && !isApprover) return <Navigate to="/" />;
  return (
    <div style={{ padding: '110px 16px 0' }}>
      <NavBar isAdmin={isAdmin} onLogout={handleLogout} email={user.email || ''} profileName={profileName} canLeave={canLeave} canApprove={isApprover} canShiftReport={canShiftReport} canCalendar={canCalendar} canPurchaseRequest={canPurchaseRequest} roleTitle={roleTitle} userId={user.id} />
      <Suspense fallback={<PageLoader />}>
        <LeaveApprovals user={user} profileName={profileName} isAdmin={isAdmin} roleTitle={roleTitle} />
      </Suspense>
    </div>
  );
};

// チームカレンダーページ
const TeamCalendarPage: React.FC = () => {
  const { user, isAdmin, isApprover, profileName, roleTitle, canLeave, canShiftReport, canCalendar, canPurchaseRequest, handleLogout, loading } = useAuth();
  if (!user || loading) return <div style={{ padding: 40, textAlign: 'center' }}>読み込んでいます...</div>;
  if (!isAdmin && !canCalendar) return <Navigate to="/" />;
  return (
    <div style={{ padding: '70px 16px 0' }}>
      <NavBar isAdmin={isAdmin} onLogout={handleLogout} email={user.email || ''} profileName={profileName} canLeave={canLeave} canApprove={isApprover} canShiftReport={canShiftReport} canCalendar={canCalendar} canPurchaseRequest={canPurchaseRequest} roleTitle={roleTitle} userId={user.id} />
      <Suspense fallback={<PageLoader />}>
        <CalendarPage user={user} roleTitle={roleTitle} isAdmin={isAdmin} isApprover={isApprover} />
      </Suspense>
    </div>
  );
};

// 管理画面ページ（/admin）
const AdminPage: React.FC = () => {
  const { user, isAdmin, isApprover, profileName, roleTitle, canLeave, canShiftReport, canCalendar, canPurchaseRequest, handleLogout, loading } = useAuth();
  const { submissions, pendingApprovals, isLoading, fetchExpenses } = useExpenses(user, isAdmin);
  if (!user || loading) return <div style={{ padding: 40, textAlign: 'center' }}>読み込んでいます...</div>;
  if (!isAdmin) return <Navigate to="/" />;
  return (
    <div style={{ padding: '110px 16px 0' }}>
      <NavBar isAdmin={isAdmin} onLogout={handleLogout} email={user.email || ''} profileName={profileName} canLeave={canLeave} canApprove={isApprover} canShiftReport={canShiftReport} canCalendar={canCalendar} canPurchaseRequest={canPurchaseRequest} roleTitle={roleTitle} userId={user.id} />
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

// 連絡板ページ（/board）
const BoardPageWrapper: React.FC = () => {
  const { user, isAdmin, isApprover, profileName, roleTitle, canLeave, canShiftReport, canCalendar, canPurchaseRequest, handleLogout, loading } = useAuth();
  const featurePublishState = useFeaturePublished();
  if (!user || loading) return <div style={{ padding: 40, textAlign: 'center' }}>読み込んでいます...</div>;
  if (!isFeaturePublished('board', featurePublishState, isAdmin, roleTitle)) return <Navigate to="/" />;
  return (
    <>
      <NavBar isAdmin={isAdmin} onLogout={handleLogout} email={user.email || ''} profileName={profileName} canLeave={canLeave} canApprove={isApprover} canShiftReport={canShiftReport} canCalendar={canCalendar} canPurchaseRequest={canPurchaseRequest} roleTitle={roleTitle} userId={user.id} />
      <Suspense fallback={<PageLoader />}>
        <BoardPage />
      </Suspense>
    </>
  );
};

// シフト実績申請ページ（/shift-report）
const ShiftReportPageWrapper: React.FC = () => {
  const { user, isAdmin, isApprover, profileName, roleTitle, canLeave, canShiftReport, canCalendar, canPurchaseRequest, handleLogout, loading } = useAuth();
  if (!user || loading) return <div style={{ padding: 40, textAlign: 'center' }}>読み込んでいます...</div>;
  return (
    <>
      <NavBar isAdmin={isAdmin} onLogout={handleLogout} email={user.email || ''} profileName={profileName} canLeave={canLeave} canApprove={isApprover} canShiftReport={canShiftReport} canCalendar={canCalendar} canPurchaseRequest={canPurchaseRequest} roleTitle={roleTitle} userId={user.id} />
      <Suspense fallback={<PageLoader />}>
        <ShiftReportPage user={user} profileName={profileName} roleTitle={roleTitle} isAdmin={isAdmin} />
      </Suspense>
    </>
  );
};

// 備品精算ページ（/purchase）
const PurchaseRequestPageWrapper: React.FC = () => {
  const { user, isAdmin, isApprover, profileName, roleTitle, canLeave, canShiftReport, canCalendar, canPurchaseRequest, handleLogout, loading } = useAuth();
  if (!user || loading) return <div style={{ padding: 40, textAlign: 'center' }}>読み込んでいます...</div>;
  if (!isAdmin && !canPurchaseRequest) return <Navigate to="/" />;
  return (
    <>
      <NavBar isAdmin={isAdmin} onLogout={handleLogout} email={user.email || ''} profileName={profileName} canLeave={canLeave} canApprove={isApprover} canShiftReport={canShiftReport} canCalendar={canCalendar} canPurchaseRequest={canPurchaseRequest} roleTitle={roleTitle} userId={user.id} />
      <Suspense fallback={<PageLoader />}>
        <PurchaseRequestPage user={user} roleTitle={roleTitle} isAdmin={isAdmin} />
      </Suspense>
    </>
  );
};

// メインのAppコンポーネント
function App() {
  return (
    <BrowserRouter>
      <ScrollToTop />
      <AuthProvider>
        <PreviewBodyOffset />
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
            <Route path="/notification-settings" element={<NotificationSettings />} />
            <Route path="/change-email" element={<ChangeEmail />} />
            <Route path="/change-password" element={<ChangePassword />} />
            <Route path="/settings-check" element={<SupabaseSettingsCheck />} />
            <Route path="/board" element={<BoardPageWrapper />} />
            <Route path="/shift-report" element={<ShiftReportPageWrapper />} />
            <Route path="/purchase" element={<PurchaseRequestPageWrapper />} />
          </Route>
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;

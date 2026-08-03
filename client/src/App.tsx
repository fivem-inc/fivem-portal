import React, { useState, useCallback, useEffect, useLayoutEffect, Suspense, useRef, useContext } from 'react';
import ReactDOM from 'react-dom';
import { Routes, Route, Navigate, Outlet, BrowserRouter, useNavigate, useLocation } from 'react-router-dom';
import SignIn from './pages/SignIn';
import ResetPassword from './pages/ResetPassword';
import ExpenseForm from './components/ExpenseForm';
import { todayJstStr } from './lib/breakCalc';

// 設定系ページは起動直後のランディング（ホーム）に不要なので遅延読込にして初期バンドルを軽くする
const ChangeEmail = React.lazy(() => import('./pages/ChangeEmail'));
const ChangePassword = React.lazy(() => import('./pages/ChangePassword'));
const AccountSettings = React.lazy(() => import('./pages/AccountSettings'));
const NotificationSettings = React.lazy(() => import('./pages/NotificationSettings'));
const SupabaseSettingsCheck = React.lazy(() => import('./pages/SupabaseSettingsCheck'));

const AdminPanel = React.lazy(() => import('./components/AdminPanel'));
const HistoryView = React.lazy(() => import('./components/HistoryView'));
const MonthlyApplicationStatus = React.lazy(() => import('./components/MonthlyApplicationStatus'));
const BusinessTripReportForm = React.lazy(() => import('./components/BusinessTripReport'));
const LeaveRequestForm = React.lazy(() => import('./components/LeaveRequest'));
const LeaveApprovals = React.lazy(() => import('./components/LeaveApprovals'));
const CalendarPage     = React.lazy(() => import('./pages/CalendarPage'));
const BoardPage        = React.lazy(() => import('./pages/BoardPage'));
const ShiftReportPage  = React.lazy(() => import('./pages/ShiftReportPage'));
const OvertimePage     = React.lazy(() => import('./pages/OvertimePage'));
const ShiftDirectoryPage = React.lazy(() => import('./pages/ShiftDirectoryPage'));
const PurchaseRequestPage = React.lazy(() => import('./pages/PurchaseRequestPage'));
const SafetyCheckPage = React.lazy(() => import('./pages/SafetyCheckPage'));

const PageLoader: React.FC = () => (
  <div style={{ padding: 40, textAlign: 'center', color: '#888' }}>読み込んでいます...</div>
);
import { AuthProvider, AuthContext } from './contexts/AuthContext.tsx';
import { useAuth } from './hooks/useAuth';
import { requestPushPermission, getPushPermissionStatus } from './utils/pushNotification';
import { fetchPushBannerConfig, DEFAULT_PUSH_BANNER_MESSAGE, DEFAULT_PUSH_BANNER_TITLE, DEFAULT_PUSH_BANNER_ENABLE_LABEL, DEFAULT_PUSH_BANNER_LATER_LABEL, type PushBannerConfig } from './lib/pushBannerConfig';
import { fetchActiveAnnouncements, type Announcement } from './lib/announcements';
import { isInRemindWindow } from './lib/announcementDates';
import { useFeaturePublished, isFeaturePublished } from './hooks/useFeaturePublished';
import { supabase } from './lib/supabaseClient';
import { isFullDayReport } from './lib/overtimeTypes';
import { useExpenses } from './hooks/useExpenses';
import { useLeavePendingCount } from './hooks/useLeavePendingCount';
import { usePurchasePendingCount } from './hooks/usePurchasePendingCount';
import { useSafetyPendingCount } from './hooks/useSafetyPendingCount';
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

// プッシュ通知の有効化を促すバナー（まだONにしていない人にだけ表示）。
// iPhone(Safari・ホーム画面未追加)はプッシュ非対応なので「ホーム画面に追加」手順を、
// それ以外(Android等)はその場で押せる「許可する」ボタンを出し分ける。
const PUSH_BANNER_DISMISS_KEY = 'push_banner_dismissed_until';
const PushEnableBanner: React.FC = () => {
  const [status, setStatus] = useState<'granted' | 'denied' | 'default' | 'unsupported' | 'loading'>('loading');
  const [hidden, setHidden] = useState(false);
  const [working, setWorking] = useState(false);
  // 管理画面（通知設定タブ）の設定。null=読み込み中（読み込み完了までバナーを出さない＝一瞬表示→消えるちらつき防止）
  const [config, setConfig] = useState<PushBannerConfig | null>(null);

  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent);
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches
    || (navigator as unknown as { standalone?: boolean }).standalone === true;

  useEffect(() => {
    getPushPermissionStatus().then((s) => setStatus(s as typeof status));
    fetchPushBannerConfig().then(setConfig);
    try {
      const until = Number(localStorage.getItem(PUSH_BANNER_DISMISS_KEY) || 0);
      if (until > Date.now()) setHidden(true);
    } catch { /* ignore */ }
  }, []);

  // 既にON・拒否済み・読み込み中・「後で」で閉じた場合・管理画面でOFFの場合は出さない
  if (hidden || status === 'loading' || status === 'granted' || status === 'denied') return null;
  if (!config || !config.enabled) return null;

  // iPhone(Safari)でホーム画面未追加 → プッシュ非対応なので追加手順を案内
  const iosNeedsInstall = isIOS && !isStandalone && status === 'unsupported';
  // 非対応かつiOSでもない（古いブラウザ等）は案内しても無意味なので出さない
  if (status === 'unsupported' && !iosNeedsInstall) return null;

  const dismiss = () => {
    try { localStorage.setItem(PUSH_BANNER_DISMISS_KEY, String(Date.now() + config.redisplayDays * 86400000)); } catch { /* ignore */ }
    setHidden(true);
  };
  const enable = async () => {
    setWorking(true);
    const r = await requestPushPermission();
    setStatus(r);
    setWorking(false);
  };

  return (
    <div style={{ background: '#eef7ee', border: '1px solid #b7e0b7', borderRadius: 10, padding: '12px 14px', marginBottom: 10 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <span style={{ fontSize: 20, flexShrink: 0 }}>🔔</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 'bold', color: '#1b5e20', marginBottom: 2 }}>{config.title.trim() || DEFAULT_PUSH_BANNER_TITLE}</div>
          {iosNeedsInstall ? (
            <div style={{ fontSize: 12.5, color: '#33691e', lineHeight: 1.8 }}>
              iPhoneで通知を受け取るには、ひと手間必要です：<br />
              ① 下の共有ボタン（□に↑）をタップ<br />
              ② 「ホーム画面に追加」をタップ<br />
              ③ 追加されたアイコンから開き直す<br />
              ④ 右上のアイコン →「アカウント設定」→「許可する」
            </div>
          ) : (
            <div style={{ fontSize: 12.5, color: '#33691e', lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>
              {config.message.trim() || DEFAULT_PUSH_BANNER_MESSAGE}
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            {!iosNeedsInstall && (
              <button onClick={enable} disabled={working}
                style={{ padding: '7px 18px', borderRadius: 20, border: 'none', background: '#4CAF50', color: '#fff', fontSize: 13, fontWeight: 600, cursor: working ? 'default' : 'pointer', opacity: working ? 0.6 : 1 }}>
                {working ? '...' : (config.enableLabel.trim() || DEFAULT_PUSH_BANNER_ENABLE_LABEL)}
              </button>
            )}
            <button onClick={dismiss}
              style={{ padding: '7px 16px', borderRadius: 20, border: '1px solid #b7e0b7', background: 'transparent', color: '#558b2f', fontSize: 13, cursor: 'pointer' }}>
              {config.laterLabel.trim() || DEFAULT_PUSH_BANNER_LATER_LABEL}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

// 社内お知らせバナー（管理者が出した「表示中」のお知らせを全スタッフのホーム上部に表示）。
// スタッフは右上の ✕ で個別に閉じられる（localStorage に閉じたIDを保存）。
//
// リマインド再表示: お知らせが「アプリ内リマインド期間」に入ると、通常フェーズで
// 一度閉じた人にももう一度だけ表示する。閉じるフェーズ（通常／リマインド）ごとに
// 別キーで閉じたIDを持つことで、「閉じた→期限が近づいて再表示→また閉じたら終わり」を実現する。
const ANNOUNCEMENT_DISMISS_KEY = 'announcement_dismissed_ids';
const ANNOUNCEMENT_REMIND_DISMISS_KEY = 'announcement_remind_dismissed_ids';

const readDismissedIds = (key: string): string[] => {
  try {
    const raw = localStorage.getItem(key);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((v): v is string => typeof v === 'string') : [];
  } catch { return []; }
};

const writeDismissedIds = (key: string, ids: string[]) => {
  try { localStorage.setItem(key, JSON.stringify(ids)); } catch { /* ignore */ }
};

const AnnouncementBanner: React.FC = () => {
  const [items, setItems] = useState<Announcement[]>([]);
  const [dismissed, setDismissed] = useState<string[]>(() => readDismissedIds(ANNOUNCEMENT_DISMISS_KEY));
  const [remindDismissed, setRemindDismissed] = useState<string[]>(() => readDismissedIds(ANNOUNCEMENT_REMIND_DISMISS_KEY));
  const [expanded, setExpanded] = useState<string[]>([]); // 初期は全て閉じた状態
  const toggle = (id: string) => setExpanded(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);

  useEffect(() => {
    fetchActiveAnnouncements().then(list => {
      setItems(list);
      // 表示対象でなくなったID（削除・期間切れ）を両キーから剪定してゴミが溜まらないようにする
      const liveIds = new Set(list.map(a => a.id));
      setDismissed(prev => {
        const next = prev.filter(id => liveIds.has(id));
        if (next.length !== prev.length) writeDismissedIds(ANNOUNCEMENT_DISMISS_KEY, next);
        return next;
      });
      setRemindDismissed(prev => {
        const next = prev.filter(id => liveIds.has(id));
        if (next.length !== prev.length) writeDismissedIds(ANNOUNCEMENT_REMIND_DISMISS_KEY, next);
        return next;
      });
    });
  }, []);

  const dismiss = (a: Announcement) => {
    // リマインド期間中に閉じたらリマインド用キーへ、それ以外は通常キーへ
    if (isInRemindWindow(a)) {
      setRemindDismissed(prev => {
        const next = prev.includes(a.id) ? prev : [...prev, a.id];
        writeDismissedIds(ANNOUNCEMENT_REMIND_DISMISS_KEY, next);
        return next;
      });
    } else {
      setDismissed(prev => {
        const next = prev.includes(a.id) ? prev : [...prev, a.id];
        writeDismissedIds(ANNOUNCEMENT_DISMISS_KEY, next);
        return next;
      });
    }
  };

  const visible = items.filter(a => {
    const remindPhase = isInRemindWindow(a);
    // リマインド期間中は通常フェーズで閉じたかどうかを無視し、リマインド用キーだけで判定
    // （＝一度閉じた人にも再表示する）。それ以外は通常キーで判定。
    return remindPhase ? !remindDismissed.includes(a.id) : !dismissed.includes(a.id);
  });
  if (visible.length === 0) return null;

  return (
    <>
      {visible.map(a => {
        const remindPhase = isInRemindWindow(a);
        const isOpen = expanded.includes(a.id);
        return (
        <div key={a.id} style={{ background: '#e7f1fb', border: '1px solid #b6d4f2', borderRadius: 10, padding: isOpen ? '12px 14px' : '10px 14px', marginBottom: 10 }}>
          <div style={{ display: 'flex', alignItems: isOpen ? 'flex-start' : 'center', gap: 10 }}>
            <span style={{ fontSize: isOpen ? 20 : 18, flexShrink: 0 }}>📢</span>
            {/* タイトル部＝タップで開閉。普段はタイトル1行だけのコンパクト表示 */}
            <div onClick={() => toggle(a.id)} style={{ flex: 1, minWidth: 0, cursor: 'pointer' }}>
              <div style={{ fontSize: 14, fontWeight: 'bold', color: '#0d47a1', marginBottom: isOpen ? 4 : 0, display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ flex: 1, overflow: isOpen ? 'visible' : 'hidden', textOverflow: 'ellipsis', whiteSpace: isOpen ? 'normal' : 'nowrap' }}>
                  {remindPhase && <span style={{ fontSize: 11, fontWeight: 700, color: '#c62828', marginRight: 6 }}>【再掲・もうすぐ期限】</span>}
                  {a.title}
                </span>
                <span style={{ fontSize: 12, fontWeight: 400, color: '#5a8bc0', flexShrink: 0 }}>{isOpen ? '▲ 閉じる' : '▼ 開く'}</span>
              </div>
              {isOpen && (
                <div style={{ fontSize: 12.5, color: '#1565c0', lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>{a.body}</div>
              )}
            </div>
            <button onClick={() => dismiss(a)} aria-label="閉じる"
              style={{ background: 'none', border: 'none', fontSize: 16, color: '#5a8bc0', cursor: 'pointer', flexShrink: 0, lineHeight: 1, padding: 0 }}>✕</button>
          </div>
        </div>
        );
      })}
    </>
  );
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

// 勤務変更申請：自分の番の確認待ち件数（ShiftReportApprovalBannerと同じ判定ロジック）
const useShiftPendingCount = (userId: string | undefined, roleTitle: string | undefined, isAdmin: boolean, canShiftReport: boolean | undefined) => {
  const [pendingCount, setPendingCount] = useState(0);

  const fetchPending = useCallback(async () => {
    if (!userId || !canShiftReport) { setPendingCount(0); return; }
    if (!isAdmin && !['リーダー', 'マネージャー', 'フロア責任者', '社長', '管理者'].includes(roleTitle ?? '')) { setPendingCount(0); return; }

    const { data } = await supabase.from('shift_reports').select('id').eq('reviewer_id', userId).in('status', ['pending', 'resubmitted']);
    setPendingCount(data?.length ?? 0);
  }, [userId, roleTitle, isAdmin, canShiftReport]);

  useEffect(() => { fetchPending(); const t = setInterval(fetchPending, 30000); return () => clearInterval(t); }, [fetchPending]);
  useEffect(() => {
    window.addEventListener('shift-pending-changed', fetchPending);
    return () => window.removeEventListener('shift-pending-changed', fetchPending);
  }, [fetchPending]);
  return { pendingCount };
};

// 残業・時間管理：自分宛の確認待ち件数
const useOvertimePendingCount = (userId: string | undefined, canOvertime: boolean | undefined) => {
  const [pendingCount, setPendingCount] = useState(0);

  const fetchPending = useCallback(async () => {
    if (!userId || !canOvertime) { setPendingCount(0); return; }
    const { data } = await supabase.from('overtime_reports')
      .select('id')
      .eq('reviewer_id', userId)
      .eq('entry_type', 'manual')
      .in('status', ['requested', 'reported']);
    setPendingCount(data?.length ?? 0);
  }, [userId, canOvertime]);

  useEffect(() => { fetchPending(); const t = setInterval(fetchPending, 30000); return () => clearInterval(t); }, [fetchPending]);
  useEffect(() => {
    window.addEventListener('overtime-pending-changed', fetchPending);
    return () => window.removeEventListener('overtime-pending-changed', fetchPending);
  }, [fetchPending]);
  return { pendingCount };
};

// 自分の「実績が未報告の事前申請」（受理済み request_confirmed で勤務日を過ぎた・終日除く）件数。
// 本人へのリマインド（ホームバナー＋タブバッジ）に使う。
const useOvertimeUnreportedCount = (userId: string | undefined, canOvertime: boolean | undefined) => {
  const [count, setCount] = useState(0);
  const [dates, setDates] = useState<string[]>([]);
  const fetchUnreported = useCallback(async () => {
    if (!userId || !canOvertime) { setCount(0); setDates([]); return; }
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' }); // YYYY-MM-DD(JST)
    const { data } = await supabase.from('overtime_reports')
      .select('id, work_date, application_types')
      .eq('applicant_id', userId)
      .eq('status', 'request_confirmed');
    const list = ((data ?? []) as { work_date: string; application_types: string[] | null }[])
      .filter(r => r.work_date < today && !isFullDayReport(r.application_types))
      .map(r => r.work_date).sort();
    setCount(list.length); setDates(list);
  }, [userId, canOvertime]);
  useEffect(() => { fetchUnreported(); const t = setInterval(fetchUnreported, 30000); return () => clearInterval(t); }, [fetchUnreported]);
  useEffect(() => {
    window.addEventListener('overtime-pending-changed', fetchUnreported);
    return () => window.removeEventListener('overtime-pending-changed', fetchUnreported);
  }, [fetchUnreported]);
  return { count, dates };
};

const NavBar: React.FC<{ isAdmin: boolean; onLogout: () => void; email: string; profileName: string | null; canLeave?: boolean; canApprove?: boolean; canShiftReport?: boolean; canCalendar?: boolean; canPurchaseRequest?: boolean; canOvertime?: boolean; roleTitle?: string; userId?: string }> = ({ isAdmin, onLogout, email, profileName, canLeave, canApprove: _canApprove, canShiftReport, canCalendar, canPurchaseRequest, canOvertime, roleTitle, userId }) => {
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
  const { total: boardUnreadRaw } = useBoardUnread(userId, location.pathname);
  const { pendingCount: safetyPendingRaw } = useSafetyPendingCount(userId);
  const safetyPending = isPub('safety_check') ? safetyPendingRaw : 0;
  const boardUnread = boardUnreadRaw + safetyPending; // 連絡板の未読バッジに安否確認の未回答分も合算
  const { pendingCount: purchasePending } = usePurchasePendingCount(userId, canPurchaseRequest);
  const { pendingCount: leavePending } = useLeavePendingCount(userId, roleTitle, isAdmin);
  const { pendingCount: shiftPending } = useShiftPendingCount(userId, roleTitle, isAdmin, canShiftReport);
  const { pendingCount: overtimePending } = useOvertimePendingCount(userId, canOvertime);
  const { count: overtimeUnreported } = useOvertimeUnreportedCount(userId, canOvertime);
  const overtimeBadge = overtimePending + overtimeUnreported; // 確認依頼＋自分の実績未報告

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

  // モバイルナビのラベル。44px固定幅に対し4文字までは9px、5文字以上は縮小して改行を防ぐ
  const navLabel = (t: string) => (
    <span style={{ fontSize: t.length >= 5 ? 8 : 9, whiteSpace: 'nowrap' as const, lineHeight: 1 }}>{t}</span>
  );

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
              {isMobile ? <><span style={{ fontSize: 20 }}>⚙️</span>{navLabel('管理')}</> : '⚙️ 管理'}
            </button>
          )}
          {isPub('expense') && (
            <button onClick={() => navTo('/')} style={btnStyle(location.pathname === '/')}>
              {isMobile ? <><span style={{ fontSize: 20 }}>🏠</span>{navLabel('交通費')}</> : '🏠 交通費'}
            </button>
          )}
          {isPub('trip_report') && (
            <button onClick={() => navTo('/trip-report')} style={btnStyle(location.pathname === '/trip-report')}>
              {isMobile ? <><span style={{ fontSize: 20 }}>📍</span>{navLabel('出張報告')}</> : '📍 出張報告'}
            </button>
          )}
          {canLeave && isPub('leave_request') && (
            <div style={{ position: 'relative', display: 'inline-block', flexShrink: 0 }}>
              <button onClick={() => navTo('/leave')} style={btnStyle(location.pathname === '/leave', '#28a745')}>
                {isMobile ? <><span style={{ fontSize: 20 }}>🌿</span>{navLabel('休暇申請')}</> : '🌿 休暇申請'}
              </button>
              {leavePending > 0 && (
                <span style={{ position: 'absolute', top: -4, right: -4, background: '#dc3545', color: '#fff', borderRadius: 10, fontSize: 10, minWidth: 18, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold', padding: '0 3px', border: '2px solid #1a1a2e', pointerEvents: 'none' }}>
                  {leavePending > 99 ? '99+' : leavePending}
                </span>
              )}
            </div>
          )}
          {(isAdmin || canCalendar) && isPub('leave_calendar') && (
            <button onClick={() => navTo('/calendar')} style={btnStyle(location.pathname === '/calendar', '#4a90d9')}>
              {isMobile ? <><span style={{ fontSize: 20 }}>📅</span>{navLabel('カレンダー')}</> : '📅 カレンダー'}
            </button>
          )}
          {canShiftReport && isPub('shift_report') && (
            <div style={{ position: 'relative', display: 'inline-block', flexShrink: 0 }}>
              <button onClick={() => navTo('/shift-report')} style={btnStyle(location.pathname === '/shift-report', '#c0392b')}>
                {isMobile ? <><span style={{ fontSize: 20 }}>⏰</span>{navLabel('勤務変更')}</> : '⏰ 勤務変更'}
              </button>
              {shiftPending > 0 && (
                <span style={{ position: 'absolute', top: -4, right: -4, background: '#dc3545', color: '#fff', borderRadius: 10, fontSize: 10, minWidth: 18, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold', padding: '0 3px', border: '2px solid #1a1a2e', pointerEvents: 'none' }}>
                  {shiftPending > 99 ? '99+' : shiftPending}
                </span>
              )}
            </div>
          )}
          {canOvertime && isPub('overtime') && (
            <div style={{ position: 'relative', display: 'inline-block', flexShrink: 0 }}>
              <button onClick={() => navTo('/overtime')} style={btnStyle(location.pathname === '/overtime', '#1565c0')}>
                {isMobile ? <><span style={{ fontSize: 20 }}>🕐</span>{navLabel('残業')}</> : '🕐 残業・時間'}
              </button>
              {overtimeBadge > 0 && (
                <span style={{ position: 'absolute', top: -4, right: -4, background: '#dc3545', color: '#fff', borderRadius: 10, fontSize: 10, minWidth: 18, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold', padding: '0 3px', border: '2px solid #1a1a2e', pointerEvents: 'none' }}>
                  {overtimeBadge > 99 ? '99+' : overtimeBadge}
                </span>
              )}
            </div>
          )}
          {canPurchaseRequest && isPub('purchase_request') && (
            <div style={{ position: 'relative', display: 'inline-block', flexShrink: 0 }}>
              <button onClick={() => navTo('/purchase')} style={btnStyle(location.pathname === '/purchase', '#17a2b8')}>
                {isMobile ? <><span style={{ fontSize: 20 }}>📦</span>{navLabel('備品精算')}</> : '📦 備品精算'}
              </button>
              {purchasePending > 0 && (
                <span style={{ position: 'absolute', top: -4, right: -4, background: '#dc3545', color: '#fff', borderRadius: 10, fontSize: 10, minWidth: 18, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold', padding: '0 3px', border: '2px solid #1a1a2e', pointerEvents: 'none' }}>
                  {purchasePending > 99 ? '99+' : purchasePending}
                </span>
              )}
            </div>
          )}
          {isPub('board') && (
          <div style={{ position: 'relative', display: 'inline-block', flexShrink: 0 }}>
            <button onClick={() => navTo('/board')} style={btnStyle(location.pathname === '/board', '#e67e22')}>
              {isMobile ? <><span style={{ fontSize: 20 }}>💬</span>{navLabel('連絡板')}</> : '💬 連絡板'}
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
  const isSafety = n.source_type === 'safety_check' || n.source_type === 'safety_check_cancelled'; // 安否確認：isBoardの文言判定より先に見る
  const isBoard = !isUnconfirmedReminder && !isSafety && (n.source_type === 'inbox' || n.message.includes('お知らせ') || n.message.includes('メッセージが届き') || n.message.includes('リマインド'));

  // source_typeで種別を判定（休暇申請・勤務変更申請）。文言ではなくsource_typeを正とする
  const isLeavePendingApproval = n.source_type === 'leave_request:pending_approval'; // 承認者：要対応
  const isLeavePendingResubmit = n.source_type === 'leave_request:pending_resubmit'; // 申請者：再提出/取消待ち
  const isLeaveResult          = n.source_type === 'leave_request';                  // 申請者：結果報告のみ
  const isLeaveFyi             = n.source_type === 'leave_request:fyi';              // 上長：FYI（誰がいつ休むか共有・カレンダー着地）
  const isShiftPendingApproval = n.source_type === 'shift_report:pending_approval';  // レビュアー：要対応
  const isShiftPendingResubmit = n.source_type === 'shift_report:pending_resubmit';  // 申請者：再提出/取消待ち
  const isShiftResult          = n.source_type === 'shift_report';                   // 申請者：結果報告のみ
  const isTimeAdjustment       = n.source_type === 'time_adjustment';                // 上長：FYI（対応不要）
  const isAttendance           = n.source_type === 'attendance';                     // 上長・本人：欠勤登録のFYI（対応不要）
  const isAttendanceCancelled  = n.source_type === 'attendance:cancelled';           // 上長・本人：勤怠の取消のお知らせ（飛び先の行はもう無い）
  const isPurchasePendingApproval = n.source_type === 'purchase_request:pending_approval'; // リーダー：要対応
  const isPurchaseResult          = n.source_type === 'purchase_request';                  // 申請者：結果報告のみ
  const isOvertimePendingApproval = n.source_type === 'overtime_request:pending_approval'; // 確認者：要対応
  const isOvertimePendingResubmit = n.source_type === 'overtime_request:pending_resubmit'; // 申請者：再提出待ち
  const isOvertimeResult          = n.source_type === 'overtime_request';                  // 申請者：結果報告のみ
  const isOtProposalReceived      = n.source_type === 'overtime_proposal:received';         // 相手：残業調整の提案が届いた（任意・催促しない）
  const isOtProposalResponded     = n.source_type === 'overtime_proposal:responded';        // 提案者：相手が回答した
  const isOvertimeUnreported      = n.source_type === 'overtime:unreported';                // 本人：実績未報告リマインド
  const isPendingAction = isLeavePendingApproval || isLeavePendingResubmit || isShiftPendingApproval || isShiftPendingResubmit || isPurchasePendingApproval || isOvertimePendingApproval || isOvertimePendingResubmit;
  const isResultOnly = isLeaveResult || isLeaveFyi || isShiftResult || isTimeAdjustment || isAttendance || isAttendanceCancelled || isPurchaseResult || isOvertimeResult || isOtProposalReceived || isOtProposalResponded || isOvertimeUnreported;
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
    if (isSafety) {
      navigate(n.reference_id ? `/safety?check=${n.reference_id}` : '/safety');
      // 未回答のうちはSafetyCheckBannerが別途出続けるので、ここでは常に閉じてよい（対応済みならこのタップで完了）
      onDismiss(n.id);
      return;
    }
    if (isBoard || isUnconfirmedReminder) {
      if (n.reference_id) { navigate(`/board?openInboxId=${n.reference_id}`); } else { navigate('/board'); }
      return;
    }
    // reference_id（申請ID）があれば ?focus= を付け、飛び先で該当申請を強調する
    const fq = n.reference_id ? `focus=${n.reference_id}` : '';
    if (isLeavePendingApproval) { navigate(`/leave-approvals${fq ? `?${fq}` : ''}`); return; }
    if (isLeavePendingResubmit) { navigate(`/leave?tab=history${fq ? `&${fq}` : ''}`); return; }
    if (isLeaveResult) { navigate(`/leave?tab=history${fq ? `&${fq}` : ''}`); onDismiss(n.id); return; }
    // 受理FYI（上長向け・誰がいつ休むか）はカレンダーの該当日へ。view=fyi のときだけ全チーム表示に切替（一般スタッフの欠勤動線には影響しない）
    if (isLeaveFyi) {
      const focus = n.reference_id && /^\d{4}-\d{2}-\d{2}$/.test(n.reference_id) ? `focus=${n.reference_id}&` : '';
      navigate(`/calendar?${focus}view=fyi`); onDismiss(n.id); return;
    }
    if (isShiftPendingApproval) { navigate(`/shift-report?view=confirm${fq ? `&${fq}` : ''}`); return; }
    if (isShiftPendingResubmit) { navigate(`/shift-report?tab=history${fq ? `&${fq}` : ''}`); return; }
    if (isShiftResult) { navigate(`/shift-report?tab=history${fq ? `&${fq}` : ''}`); onDismiss(n.id); return; }
    // 勤怠の取消：飛び先の予定はもう消えているため移動しない（その場で閉じるだけ）。誰が・何を・いつ は文面に入っている
    if (isAttendanceCancelled) { onDismiss(n.id); return; }
    // 欠勤登録：reference_idに対象日(YYYY-MM-DD)があれば、その月へジャンプして該当行を強調する
    if (isAttendance) {
      const focus = n.reference_id && /^\d{4}-\d{2}-\d{2}$/.test(n.reference_id) ? `?focus=${n.reference_id}` : '';
      navigate(`/calendar${focus}`); onDismiss(n.id); return;
    }
    // 時間調整はFYI。チームカレンダーで確認できる（タップで閉じる）
    if (isTimeAdjustment) { navigate('/calendar'); onDismiss(n.id); return; }
    if (isPurchasePendingApproval) { navigate(`/purchase?tab=approvals${fq ? `&${fq}` : ''}`); return; }
    if (isPurchaseResult) { navigate(`/purchase?tab=history${fq ? `&${fq}` : ''}`); onDismiss(n.id); return; }
    if (isOvertimePendingApproval) { navigate(`/overtime?view=confirm${fq ? `&${fq}` : ''}`); return; }
    if (isOvertimePendingResubmit) { navigate(`/overtime?tab=history${fq ? `&${fq}` : ''}`); return; }
    if (isOvertimeResult) { navigate(`/overtime?tab=history${fq ? `&${fq}` : ''}`); onDismiss(n.id); return; }
    // 残業調整の提案（相手＝受信／提案者＝回答通知）。どちらも催促しない＝タップで開いて閉じる。
    if (isOtProposalReceived || isOtProposalResponded) {
      navigate(n.reference_id ? `/overtime?proposal=${n.reference_id}` : '/overtime'); onDismiss(n.id); return;
    }
    // 実績未報告リマインド → 履歴（実績を報告する場所）へ
    if (isOvertimeUnreported) { navigate('/overtime?tab=history'); onDismiss(n.id); return; }
    if (isLegacyReject) { navigate('/leave'); return; }
    // どの種別にも当てはまらない通知（古いデータ等）はタップで閉じる（無反応にしない保険）
    onDismiss(n.id);
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
        {/* 取消のお知らせは移動しない（その場で閉じるだけ）ので、動きに合わせて文言を変える */}
        <div onClick={handleTap} style={{ fontSize: 12, color: subColor, whiteSpace: 'nowrap', flexShrink: 0, cursor: 'pointer', marginTop: 2 }}>{isAttendanceCancelled ? 'タップして閉じる' : 'タップして確認 →'}</div>
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
      // 「要対応」の承認待ちは専用の集計バナー(LeaveApprovalBanner/ShiftReportApprovalBanner/PurchaseApprovalBanner)が別途出るため、ここでは重複表示しない
      // 安否確認も専用の赤バナー(SafetyCheckBanner)が別途出るため、ここでは重複表示しない
      .not('source_type', 'in', '(leave_request:pending_approval,shift_report:pending_approval,purchase_request:pending_approval,overtime_request:pending_approval,safety_check,safety_check_cancelled)')
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
    // 取得成功したかを記録：成功したのにレコードが無い＝削除済み、失敗（通信エラー等）＝不明、で扱いを分ける
    let leaveFetchOk = true;
    if (leaveIds.length > 0) {
      const { data: rows, error } = await supabase.from('leave_requests').select('id, status, user_id, approver_id, approver2_id').in('id', leaveIds);
      if (error) leaveFetchOk = false;
      (rows || []).forEach((r: any) => leaveMap.set(r.id, r));
    }
    const shiftMap = new Map<string, { status: string; applicant_id: string; reviewer_id: string | null }>();
    let shiftFetchOk = true;
    if (shiftIds.length > 0) {
      const { data: rows, error } = await supabase.from('shift_reports').select('id, status, applicant_id, reviewer_id').in('id', shiftIds);
      if (error) shiftFetchOk = false;
      (rows || []).forEach((r: any) => shiftMap.set(r.id, r));
    }
    const overtimeIds = [...new Set(data.filter(n => (n.source_type === 'overtime_request:pending_approval' || n.source_type === 'overtime_request:pending_resubmit') && n.reference_id).map(n => n.reference_id as string))];
    const overtimeMap = new Map<string, { status: string; applicant_id: string; reviewer_id: string | null }>();
    let overtimeFetchOk = true;
    if (overtimeIds.length > 0) {
      const { data: rows, error } = await supabase.from('overtime_reports').select('id, status, applicant_id, reviewer_id').in('id', overtimeIds);
      if (error) overtimeFetchOk = false;
      (rows || []).forEach((r: any) => overtimeMap.set(r.id, r));
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
        // 取得成功したのに申請が無い＝対象申請が削除済み → 古いバナーなので消す。取得失敗時は安全側で残す
        if (!r) return leaveFetchOk;
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
        // 取得成功したのに報告が無い＝対象報告が削除済み → 古いバナーなので消す。取得失敗時は安全側で残す
        if (!r) return shiftFetchOk;
        return !(r.status === 'returned' && r.applicant_id === userId);
      }
      if (n.source_type === 'overtime_request:pending_approval') {
        const r = overtimeMap.get(n.reference_id);
        if (!r) return false;
        const stillPending = r.reviewer_id === userId && (r.status === 'requested' || r.status === 'reported');
        return !stillPending;
      }
      if (n.source_type === 'overtime_request:pending_resubmit') {
        const r = overtimeMap.get(n.reference_id);
        // 取得成功したのに申請が無い＝対象申請が削除済み → 古いバナーなので消す。取得失敗時は安全側で残す
        if (!r) return overtimeFetchOk;
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
        const today = todayJstStr();
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
      <span>休暇申請の確認依頼が {pendingCount}件 あります</span>
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
      <span>勤務変更報告の確認依頼が {pendingCount}件 あります</span>
      <span style={{ marginLeft: 'auto', fontSize: 13, fontWeight: 'normal' }}>タップして確認 →</span>
    </div>
  );
};

// 安否確認の未回答バナー（消せない・回答すると自動で消える。全スタッフ対象）
const SafetyCheckBanner: React.FC<{ userId: string; isAdmin: boolean; roleTitle: string }> = ({ userId, isAdmin, roleTitle }) => {
  const navigate = useNavigate();
  const { pendingCount, activeChecks } = useSafetyPendingCount(userId);
  const featurePublishState = useFeaturePublished();

  if (!isFeaturePublished('safety_check', featurePublishState, isAdmin, roleTitle)) return null;
  if (pendingCount === 0) return null;
  const first = activeChecks[0];

  return (
    <div
      onClick={() => navigate(`/safety${first ? `?check=${first.id}` : ''}`)}
      style={{
        margin: '0 0 16px 0',
        padding: '14px 16px',
        background: '#f8d7da',
        border: '2px solid #dc3545',
        borderRadius: 10,
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
      }}
    >
      <span style={{ fontSize: 24 }}>🆘</span>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 15, fontWeight: 'bold', color: '#721c24' }}>安否確認に回答してください</div>
        {first && <div style={{ fontSize: 12, color: '#842029', marginTop: 2 }}>{first.body}</div>}
      </div>
      <span style={{ fontSize: 13, fontWeight: 'bold', color: '#721c24', whiteSpace: 'nowrap' }}>タップして回答 →</span>
    </div>
  );
};

// 備品購入申請の承認待ち通知バナー（消せない・自分が回答すると自動で消える）
const PurchaseApprovalBanner: React.FC<{ userId: string; canPurchaseRequest: boolean }> = ({ userId, canPurchaseRequest }) => {
  const navigate = useNavigate();
  const { pendingCount } = usePurchasePendingCount(userId, canPurchaseRequest);

  if (pendingCount === 0) return null;

  return (
    <div
      onClick={() => navigate('/purchase?tab=approvals')}
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
      <span style={{ fontSize: 22 }}>📦</span>
      <span>備品購入申請の確認依頼が {pendingCount}件 あります</span>
      <span style={{ marginLeft: 'auto', fontSize: 13, fontWeight: 'normal' }}>タップして確認 →</span>
    </div>
  );
};

// 残業・時間調整の確認待ち集計バナー（確認者のみ・対応すると自動で消える）
const OvertimeApprovalBanner: React.FC<{ userId: string; canOvertime: boolean }> = ({ userId, canOvertime }) => {
  const navigate = useNavigate();
  const { pendingCount } = useOvertimePendingCount(userId, canOvertime);

  if (pendingCount === 0) return null;

  return (
    <div
      onClick={() => navigate('/overtime?view=confirm')}
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
      <span style={{ fontSize: 22 }}>🕐</span>
      <span>残業・時間調整の確認依頼が {pendingCount}件 あります</span>
      <span style={{ marginLeft: 'auto', fontSize: 13, fontWeight: 'normal' }}>タップして確認 →</span>
    </div>
  );
};

// 自分の「実績未報告」リマインドバナー（ホーム）。タップで /overtime（自分の履歴）へ飛び、実績報告できる。
const OvertimeUnreportedBanner: React.FC<{ userId: string; canOvertime: boolean }> = ({ userId, canOvertime }) => {
  const navigate = useNavigate();
  const { count, dates } = useOvertimeUnreportedCount(userId, canOvertime);
  if (count === 0) return null;
  const label = dates.map(d => d.slice(5).replace('-', '/')).join('・');
  return (
    <div
      onClick={() => navigate('/overtime')}
      style={{ margin: '0 0 16px 0', padding: '12px 16px', background: '#fff3cd', border: '2px solid #f59e0b', borderRadius: 10, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10, fontSize: 15, color: '#856404', fontWeight: 'bold' }}
    >
      <span style={{ fontSize: 22 }}>🔔</span>
      <span>実績が未報告の事前申請が {count}件 あります（{label}）</span>
      <span style={{ marginLeft: 'auto', fontSize: 13, fontWeight: 'normal', whiteSpace: 'nowrap' }}>タップして報告 →</span>
    </div>
  );
};

// 残業超過FYIバナー（本人＋リーダー(自チーム)＋マネージャー以上。タップ/✕で閉じる・調整提案は任意）
const OvertimeThresholdBanner: React.FC<{ userId: string; roleTitle: string; isAdmin: boolean; canOvertime: boolean }> = ({ userId, roleTitle, isAdmin, canOvertime }) => {
  const navigate = useNavigate();
  const [items, setItems] = useState<{ targetId: string; name: string | null; total: number; isSelf: boolean }[]>([]);
  const [threshold, setThreshold] = useState(600);
  const [periodStart, setPeriodStart] = useState('');

  useEffect(() => {
    if (!canOvertime && !isAdmin) return;
    (async () => {
      // JSTの今日から今期（16日〜翌15日）を求める
      const now = new Date();
      const y = now.getFullYear(); const m = now.getMonth() + 1; const d = now.getDate();
      const ps = d >= 16
        ? `${y}-${String(m).padStart(2, '0')}-16`
        : `${m === 1 ? y - 1 : y}-${String(m === 1 ? 12 : m - 1).padStart(2, '0')}-16`;
      setPeriodStart(ps);

      const [setRes, repRes, dismissRes, permRes] = await Promise.all([
        supabase.from('overtime_settings').select('threshold_minutes, banner_group_names').eq('id', 1).maybeSingle(),
        supabase.from('overtime_reports').select('applicant_id, diff_minutes').eq('pay_period_start', ps).eq('status', 'confirmed').gt('diff_minutes', 0),
        supabase.from('overtime_banner_dismissals').select('target_user_id').eq('user_id', userId).eq('pay_period_start', ps),
        supabase.rpc('has_feature_permission', { p_feature: 'overtime_summary' }),
      ]);
      const th = (setRes.data?.threshold_minutes as number | undefined) ?? 600;
      setThreshold(th);
      const whitelist: string[] = (setRes.data?.banner_group_names as string[] | null) ?? [];
      const dismissed = new Set(((dismissRes.data as { target_user_id: string }[] | null) ?? []).map(r => r.target_user_id));
      const canSummary = isAdmin || permRes.data === true;

      // 残業（プラス分のみ）を人別に合算
      const totals = new Map<string, number>();
      for (const r of (repRes.data as { applicant_id: string; diff_minutes: number | null }[] | null) ?? []) {
        totals.set(r.applicant_id, (totals.get(r.applicant_id) ?? 0) + (r.diff_minutes ?? 0));
      }
      const overIds = [...totals.entries()].filter(([, v]) => v > th).map(([id]) => id);
      if (overIds.length === 0) { setItems([]); return; }

      // 名前・グループ（リーダーは自チームのみ）
      const { data: profs } = await supabase.from('profiles').select('id, name, group_names').in('id', [...new Set([...overIds, userId])]);
      const profMap = new Map(((profs as { id: string; name: string | null; group_names: string[] | null }[] | null) ?? []).map(p => [p.id, p]));
      const myGroups = new Set(((profMap.get(userId)?.group_names ?? []) as string[]).filter(g => whitelist.includes(g)));
      const isManagerPlus = isAdmin || ['マネージャー', '社長', '管理者'].includes(roleTitle);
      const isLeader = roleTitle === 'リーダー';

      const result: { targetId: string; name: string | null; total: number; isSelf: boolean }[] = [];
      for (const id of overIds) {
        if (dismissed.has(id)) continue;
        const isSelf = id === userId;
        if (isSelf) { result.push({ targetId: id, name: null, total: totals.get(id)!, isSelf: true }); continue; }
        if (!canSummary) continue;
        if (isManagerPlus) { result.push({ targetId: id, name: profMap.get(id)?.name ?? '', total: totals.get(id)!, isSelf: false }); continue; }
        if (isLeader) {
          const targetGroups = (profMap.get(id)?.group_names ?? []) as string[];
          if (targetGroups.some(g => myGroups.has(g))) {
            result.push({ targetId: id, name: profMap.get(id)?.name ?? '', total: totals.get(id)!, isSelf: false });
          }
        }
      }
      result.sort((a, b) => (a.isSelf === b.isSelf) ? b.total - a.total : (a.isSelf ? -1 : 1));
      setItems(result);
    })();
  }, [userId, roleTitle, isAdmin, canOvertime]);

  if (items.length === 0) return null;

  const fmtH = (min: number) => {
    const h = Math.floor(min / 60); const m2 = min % 60;
    return m2 > 0 ? `${h}時間${m2}分` : `${h}時間`;
  };
  const fmtSigned = (min: number) => `＋${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`;
  const periodLabel = (() => {
    if (!periodStart) return '';
    const [, m2] = periodStart.split('-').map(Number);
    const nm = m2 === 12 ? 1 : m2 + 1;
    return `${m2}/16〜${nm}/15`;
  })();

  const dismiss = async (targetId: string) => {
    setItems(prev => prev.filter(i => i.targetId !== targetId));
    await supabase.from('overtime_banner_dismissals')
      .upsert({ user_id: userId, target_user_id: targetId, pay_period_start: periodStart })
      .then(null, () => {});
  };

  return (
    <>
      {items.map(item => (
        <div key={item.targetId} style={{
          margin: '0 0 10px 0', padding: '12px 16px',
          background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 10,
          display: 'flex', alignItems: 'flex-start', gap: 10,
        }}>
          <span style={{ fontSize: 20, flexShrink: 0 }}>🕐</span>
          <div onClick={() => { navigate('/overtime?tab=history'); }} style={{ flex: 1, cursor: 'pointer' }}>
            {item.isSelf ? (
              <div style={{ fontSize: 13.5, color: '#1e40af', lineHeight: 1.7 }}>
                <span style={{ fontWeight: 'bold' }}>今月（{periodLabel}）の残業が{fmtH(threshold)}を超えました。</span><br />
                時間調整をお願いします。調整する日がわからない場合はリーダー・マネージャーにご相談ください。
              </div>
            ) : (
              <div style={{ fontSize: 13.5, color: '#1e40af', lineHeight: 1.7 }}>
                <span style={{ fontWeight: 'bold' }}>{item.name}さんの今月（{periodLabel}）の残業が{fmtH(threshold)}を超えています（現在 {fmtSigned(item.total)}）。</span><br />
                必要に応じて時間調整の相談をご検討ください。
              </div>
            )}
          </div>
          <button onClick={() => dismiss(item.targetId)} title="このお知らせを閉じる"
            style={{ background: 'none', border: 'none', color: '#3b82f6', cursor: 'pointer', fontSize: 15, padding: '0 2px', flexShrink: 0, lineHeight: 1 }}>✕</button>
        </div>
      ))}
    </>
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
    canOvertime,
    leaveRequestEnabled,
    handleLogout
  } = useAuth();

  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { submissions, isLoading, fetchExpenses, rejectionNotice, clearRejectionNotice } = useExpenses(user, isAdmin);

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
  const [templateMsg, setTemplateMsg] = useState<string | null>(null); // テンプレ適用時のインライン通知（alert廃止）
  const { channelOnly: boardChannelUnread } = useBoardUnread(user?.id, pathname);

  const setExpenses = useCallback((value: React.SetStateAction<Expense[]>) => {
    setExpensesState(value);
  }, []);

  const handleApplyTemplate = useCallback((submission: Submission) => {
    const items = (submission.expenses_data || [])
      .map(e => ({ ...e, start_date: '', end_date: '' }));
    if (items.length === 0) {
      setTemplateMsg('適用できるテンプレートデータがありません。');
      setTimeout(() => setTemplateMsg(null), 3000);
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
      {templateMsg && (
        <div style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', zIndex: 9999, background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 12, padding: '18px 24px', boxShadow: '0 4px 20px rgba(0,0,0,0.15)', display: 'flex', alignItems: 'center', gap: 10, maxWidth: 320 }}>
          <span style={{ fontSize: 18 }}>⚠️</span>
          <span style={{ fontSize: 14, fontWeight: 'bold', color: '#92400e' }}>{templateMsg}</span>
          <button type="button" onClick={() => setTemplateMsg(null)} style={{ marginLeft: 'auto', background: 'none', border: 'none', color: '#92400e', cursor: 'pointer', fontSize: 16, padding: '0 4px' }}>✕</button>
        </div>
      )}
      {rejectionNotice && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }} onClick={clearRejectionNotice}>
          <div onClick={e => e.stopPropagation()} style={{ background: '#fff5f5', border: '1px solid #f5b5b5', borderRadius: 12, padding: '20px 24px', boxShadow: '0 4px 20px rgba(0,0,0,0.2)', maxWidth: 360, width: '100%' }}>
            <p style={{ fontSize: 14, color: '#a32d2d', margin: '0 0 16px', lineHeight: 1.7, whiteSpace: 'pre-line' }}>{rejectionNotice}</p>
            <div style={{ textAlign: 'right' }}>
              <button type="button" onClick={clearRejectionNotice} style={{ padding: '8px 18px', background: '#dc3545', color: 'white', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 'bold', fontSize: 14 }}>閉じる</button>
            </div>
          </div>
        </div>
      )}
      {encAnswerModal}
      {encAnswerSuccess && (
        <div style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', zIndex: 4000, background: '#f0fdf4', border: '1.5px solid #b7e4cc', borderRadius: 18, padding: '24px 32px', textAlign: 'center', boxShadow: '0 4px 20px rgba(0,0,0,0.2)' }}>
          <div style={{ fontSize: 40, marginBottom: 10 }}>✅</div>
          <div style={{ fontSize: 15, fontWeight: 'bold', color: '#155724' }}>回答を送信しました</div>
        </div>
      )}
      <NavBar isAdmin={isAdmin} onLogout={handleLogout} email={user.email || ''} profileName={profileName} canLeave={canLeave} canApprove={isApprover} canShiftReport={canShiftReport} canCalendar={canCalendar} canPurchaseRequest={canPurchaseRequest} canOvertime={canOvertime} roleTitle={roleTitle} userId={user.id} />

      {/* ⓪-0 安否確認の未回答バナー（最優先。消せない） */}
      <SafetyCheckBanner userId={user.id} isAdmin={isAdmin} roleTitle={roleTitle} />

      {/* ⓪ プッシュ通知の有効化を促すバナー（未ONの人にのみ表示） */}
      <PushEnableBanner />

      {/* ⓪-2 社内お知らせバナー（管理者が出したお知らせ・全員表示・個別に閉じられる） */}
      <AnnouncementBanner />

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

      {/* ④-3 備品購入申請承認バナー（承認者のみ） */}
      <PurchaseApprovalBanner userId={user.id} canPurchaseRequest={canPurchaseRequest} />

      {/* ④-4 残業・時間調整の確認待ちバナー（確認者のみ） */}
      <OvertimeApprovalBanner userId={user.id} canOvertime={canOvertime} />
      <OvertimeUnreportedBanner userId={user.id} canOvertime={canOvertime} />

      {/* ④-5 残業超過FYIバナー（本人・リーダー自チーム・マネージャー以上。閉じられる） */}
      <OvertimeThresholdBanner userId={user.id} roleTitle={roleTitle} isAdmin={isAdmin} canOvertime={canOvertime} />

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
  const { user, isAdmin, isApprover, profileName, roleTitle, canLeave, canShiftReport, canCalendar, canPurchaseRequest, canOvertime, handleLogout } = useAuth();
  if (!user) return <div>読み込んでいます...</div>;
  return (
    <div style={{ padding: '70px 16px 0' }}>
      <NavBar isAdmin={isAdmin} onLogout={handleLogout} email={user.email || ''} profileName={profileName} canLeave={canLeave} canApprove={isApprover} canShiftReport={canShiftReport} canCalendar={canCalendar} canPurchaseRequest={canPurchaseRequest} canOvertime={canOvertime} roleTitle={roleTitle} userId={user.id} />
      <Suspense fallback={<PageLoader />}>
        <BusinessTripReportForm user={user} profileName={profileName} />
      </Suspense>
    </div>
  );
};

// 休暇申請ページ
const LeaveRequestPage: React.FC = () => {
  const { user, isAdmin, isApprover, profileName, roleTitle, canLeave, canShiftReport, canCalendar, canPurchaseRequest, canOvertime, leaveRequestEnabled, handleLogout } = useAuth();
  if (!user) return <div>読み込んでいます...</div>;
  return (
    <div style={{ padding: '70px 16px 0' }}>
      <NavBar isAdmin={isAdmin} onLogout={handleLogout} email={user.email || ''} profileName={profileName} canLeave={canLeave} canApprove={isApprover} canShiftReport={canShiftReport} canCalendar={canCalendar} canPurchaseRequest={canPurchaseRequest} canOvertime={canOvertime} roleTitle={roleTitle} userId={user.id} />
      <Suspense fallback={<PageLoader />}>
        <LeaveRequestForm user={user} profileName={profileName} roleTitle={roleTitle} leaveRequestEnabled={leaveRequestEnabled} />
      </Suspense>
    </div>
  );
};

// 休暇申請承認ページ（リーダー・マネージャー・管理者用）
const LeaveApprovalsPage: React.FC = () => {
  const { user, isAdmin, isApprover, profileName, roleTitle, canLeave, canShiftReport, canCalendar, canPurchaseRequest, canOvertime, handleLogout, loading } = useAuth();
  if (!user || loading) return <div style={{ padding: 40, textAlign: 'center' }}>読み込んでいます...</div>;
  if (roleTitle && !isApprover) return <Navigate to="/" />;
  return (
    <div style={{ padding: '110px 16px 0' }}>
      <NavBar isAdmin={isAdmin} onLogout={handleLogout} email={user.email || ''} profileName={profileName} canLeave={canLeave} canApprove={isApprover} canShiftReport={canShiftReport} canCalendar={canCalendar} canPurchaseRequest={canPurchaseRequest} canOvertime={canOvertime} roleTitle={roleTitle} userId={user.id} />
      <Suspense fallback={<PageLoader />}>
        <LeaveApprovals user={user} profileName={profileName} isAdmin={isAdmin} roleTitle={roleTitle} />
      </Suspense>
    </div>
  );
};

// チームカレンダーページ
const TeamCalendarPage: React.FC = () => {
  const { user, isAdmin, isApprover, profileName, roleTitle, canLeave, canShiftReport, canCalendar, canPurchaseRequest, canOvertime, handleLogout, loading } = useAuth();
  if (!user || loading) return <div style={{ padding: 40, textAlign: 'center' }}>読み込んでいます...</div>;
  if (!isAdmin && !canCalendar) return <Navigate to="/" />;
  return (
    <div style={{ padding: '70px 16px 0' }}>
      <NavBar isAdmin={isAdmin} onLogout={handleLogout} email={user.email || ''} profileName={profileName} canLeave={canLeave} canApprove={isApprover} canShiftReport={canShiftReport} canCalendar={canCalendar} canPurchaseRequest={canPurchaseRequest} canOvertime={canOvertime} roleTitle={roleTitle} userId={user.id} />
      <Suspense fallback={<PageLoader />}>
        <CalendarPage user={user} roleTitle={roleTitle} isAdmin={isAdmin} isApprover={isApprover} />
      </Suspense>
    </div>
  );
};

// 管理画面ページ（/admin）
const AdminPage: React.FC = () => {
  const { user, isAdmin, isApprover, profileName, roleTitle, canLeave, canShiftReport, canCalendar, canPurchaseRequest, canOvertime, handleLogout, loading } = useAuth();
  const { submissions, pendingApprovals, isLoading, fetchExpenses } = useExpenses(user, isAdmin);
  if (!user || loading) return <div style={{ padding: 40, textAlign: 'center' }}>読み込んでいます...</div>;
  if (!isAdmin) return <Navigate to="/" />;
  return (
    <div style={{ padding: '110px 16px 0' }}>
      <NavBar isAdmin={isAdmin} onLogout={handleLogout} email={user.email || ''} profileName={profileName} canLeave={canLeave} canApprove={isApprover} canShiftReport={canShiftReport} canCalendar={canCalendar} canPurchaseRequest={canPurchaseRequest} canOvertime={canOvertime} roleTitle={roleTitle} userId={user.id} />
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
  const { user, isAdmin, isApprover, profileName, roleTitle, canLeave, canShiftReport, canCalendar, canPurchaseRequest, canOvertime, handleLogout, loading } = useAuth();
  const featurePublishState = useFeaturePublished();
  if (!user || loading) return <div style={{ padding: 40, textAlign: 'center' }}>読み込んでいます...</div>;
  if (!isFeaturePublished('board', featurePublishState, isAdmin, roleTitle)) return <Navigate to="/" />;
  return (
    <>
      <NavBar isAdmin={isAdmin} onLogout={handleLogout} email={user.email || ''} profileName={profileName} canLeave={canLeave} canApprove={isApprover} canShiftReport={canShiftReport} canCalendar={canCalendar} canPurchaseRequest={canPurchaseRequest} canOvertime={canOvertime} roleTitle={roleTitle} userId={user.id} />
      <Suspense fallback={<PageLoader />}>
        <BoardPage />
      </Suspense>
    </>
  );
};

// シフト実績申請ページ（/shift-report）
const ShiftReportPageWrapper: React.FC = () => {
  const { user, isAdmin, isApprover, profileName, roleTitle, canLeave, canShiftReport, canCalendar, canPurchaseRequest, canOvertime, handleLogout, loading } = useAuth();
  if (!user || loading) return <div style={{ padding: 40, textAlign: 'center' }}>読み込んでいます...</div>;
  return (
    <>
      <NavBar isAdmin={isAdmin} onLogout={handleLogout} email={user.email || ''} profileName={profileName} canLeave={canLeave} canApprove={isApprover} canShiftReport={canShiftReport} canCalendar={canCalendar} canPurchaseRequest={canPurchaseRequest} canOvertime={canOvertime} roleTitle={roleTitle} userId={user.id} />
      <Suspense fallback={<PageLoader />}>
        <ShiftReportPage user={user} profileName={profileName} roleTitle={roleTitle} isAdmin={isAdmin} />
      </Suspense>
    </>
  );
};

// 残業・時間管理ページ（/overtime・正社員用）
const OvertimePageWrapper: React.FC = () => {
  const { user, isAdmin, isApprover, profileName, roleTitle, canLeave, canShiftReport, canCalendar, canPurchaseRequest, canOvertime, handleLogout, loading } = useAuth();
  const featurePublishState = useFeaturePublished();
  if (!user || loading) return <div style={{ padding: 40, textAlign: 'center' }}>読み込んでいます...</div>;
  if (!isFeaturePublished('overtime', featurePublishState, isAdmin, roleTitle)) return <Navigate to="/" />;
  if (!isAdmin && !canOvertime) return <Navigate to="/" />;
  return (
    <div style={{ padding: '70px 0 0' }}>
      <NavBar isAdmin={isAdmin} onLogout={handleLogout} email={user.email || ''} profileName={profileName} canLeave={canLeave} canApprove={isApprover} canShiftReport={canShiftReport} canCalendar={canCalendar} canPurchaseRequest={canPurchaseRequest} canOvertime={canOvertime} roleTitle={roleTitle} userId={user.id} />
      <Suspense fallback={<PageLoader />}>
        <OvertimePage user={user} profileName={profileName} roleTitle={roleTitle} isAdmin={isAdmin} />
      </Suspense>
    </div>
  );
};

// 全員のシフト予定 閲覧ページ（/shift-patterns・リーダー以上）
const ShiftDirectoryPageWrapper: React.FC = () => {
  const { user, isAdmin, isApprover, profileName, roleTitle, canLeave, canShiftReport, canCalendar, canPurchaseRequest, canOvertime, handleLogout, loading } = useAuth();
  if (!user || loading) return <div style={{ padding: 40, textAlign: 'center' }}>読み込んでいます...</div>;
  return (
    <div style={{ padding: '70px 0 0' }}>
      <NavBar isAdmin={isAdmin} onLogout={handleLogout} email={user.email || ''} profileName={profileName} canLeave={canLeave} canApprove={isApprover} canShiftReport={canShiftReport} canCalendar={canCalendar} canPurchaseRequest={canPurchaseRequest} canOvertime={canOvertime} roleTitle={roleTitle} userId={user.id} />
      <Suspense fallback={<PageLoader />}>
        <ShiftDirectoryPage user={user} roleTitle={roleTitle} isAdmin={isAdmin} />
      </Suspense>
    </div>
  );
};

// 安否確認ページ（/safety・回答は全員対象。発信操作の制限はページ内で役職を見て行う）
//   ⚠️ ナビの出し分けだけでなくルート側にもガードを入れる（連絡板で抜けていた事故と同型）
const SafetyCheckPageWrapper: React.FC = () => {
  const { user, isAdmin, isApprover, profileName, roleTitle, canLeave, canShiftReport, canCalendar, canPurchaseRequest, canOvertime, handleLogout, loading } = useAuth();
  const featurePublishState = useFeaturePublished();
  if (!user || loading) return <div style={{ padding: 40, textAlign: 'center' }}>読み込んでいます...</div>;
  if (!isFeaturePublished('safety_check', featurePublishState, isAdmin, roleTitle)) return <Navigate to="/" />;
  return (
    <div style={{ padding: '70px 0 0' }}>
      <NavBar isAdmin={isAdmin} onLogout={handleLogout} email={user.email || ''} profileName={profileName} canLeave={canLeave} canApprove={isApprover} canShiftReport={canShiftReport} canCalendar={canCalendar} canPurchaseRequest={canPurchaseRequest} canOvertime={canOvertime} roleTitle={roleTitle} userId={user.id} />
      <Suspense fallback={<PageLoader />}>
        <SafetyCheckPage user={user} roleTitle={roleTitle} isAdmin={isAdmin} />
      </Suspense>
    </div>
  );
};

// 備品精算ページ（/purchase）
const PurchaseRequestPageWrapper: React.FC = () => {
  const { user, isAdmin, isApprover, profileName, roleTitle, canLeave, canShiftReport, canCalendar, canPurchaseRequest, canOvertime, handleLogout, loading } = useAuth();
  if (!user || loading) return <div style={{ padding: 40, textAlign: 'center' }}>読み込んでいます...</div>;
  if (!isAdmin && !canPurchaseRequest) return <Navigate to="/" />;
  return (
    <>
      <NavBar isAdmin={isAdmin} onLogout={handleLogout} email={user.email || ''} profileName={profileName} canLeave={canLeave} canApprove={isApprover} canShiftReport={canShiftReport} canCalendar={canCalendar} canPurchaseRequest={canPurchaseRequest} canOvertime={canOvertime} roleTitle={roleTitle} userId={user.id} />
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
            <Route path="/account" element={<Suspense fallback={<PageLoader />}><AccountSettings /></Suspense>} />
            <Route path="/notification-settings" element={<Suspense fallback={<PageLoader />}><NotificationSettings /></Suspense>} />
            <Route path="/change-email" element={<Suspense fallback={<PageLoader />}><ChangeEmail /></Suspense>} />
            <Route path="/change-password" element={<Suspense fallback={<PageLoader />}><ChangePassword /></Suspense>} />
            <Route path="/settings-check" element={<Suspense fallback={<PageLoader />}><SupabaseSettingsCheck /></Suspense>} />
            <Route path="/board" element={<BoardPageWrapper />} />
            <Route path="/shift-report" element={<ShiftReportPageWrapper />} />
            <Route path="/overtime" element={<OvertimePageWrapper />} />
            <Route path="/shift-patterns" element={<ShiftDirectoryPageWrapper />} />
            <Route path="/purchase" element={<PurchaseRequestPageWrapper />} />
            <Route path="/safety" element={<SafetyCheckPageWrapper />} />
          </Route>
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;

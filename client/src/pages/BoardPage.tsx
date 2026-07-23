import React, { useState, useEffect, useCallback, useRef, useMemo, useContext } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient';
import { insertNotification } from '../lib/notifications';
import { dispatchBoardEmail } from '../lib/notificationDispatch';
import { DRAFT_KEYS, loadDraft, saveDraft, clearDraft } from '../lib/draftStorage';
import { todayJstStr } from '../lib/breakCalc';

const BOARD_LINK = 'https://fivem-portal.vercel.app/board';
import { useAuth } from '../hooks/useAuth';
import { useDarkMode } from '../hooks/useDarkMode';
import { AuthContext } from '../contexts/AuthContext.tsx';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

interface SendPermissions {
  employment_types: string[];
  role_titles: string[];
}

interface Channel {
  id: string;
  type: 'group' | 'dm' | 'sent_mail';
  name: string | null;
  created_by: string | null;
  created_at: string;
  send_permissions: SendPermissions | null;
  show_read_detail: 'all' | 'permitted' | 'none';
}

interface ChannelMember {
  channel_id: string;
  user_id: string;
  profile: { name: string | null; role_title: string | null } | null;
}

interface BoardMessage {
  id: string;
  channel_id: string | null;
  parent_id: string | null;
  user_id: string;
  body: string;
  edited_at: string | null;
  created_at: string;
  deadline: string | null;
  deadline_type: string | null;
  requires_confirmation: boolean;
  scheduled_at: string | null;
  sent_at: string | null;
  title: string | null;
  subject: string | null;
  status: string | null;
  answer_prompt: string | null;
  answer_location: string | null;
  answer_link: string | null;
  broadcast_recipients: { id: string; name: string }[] | null;
  profile: { name: string | null } | null;
  outbox_hidden?: boolean;
}

type View = 'inbox' | 'outbox' | 'compose' | 'channel' | 'search' | 'favorites';

interface SimpleProfile {
  id: string;
  name: string | null;
  role_title: string | null;
  employment_type: string | null;
  group_names: string[] | null;
}

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

const fmtTime = (ts: string) => {
  const d = new Date(ts);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  if (isToday)
    return d.toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: 'numeric', minute: '2-digit' });
  return d.toLocaleDateString('ja-JP', {
    timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
};
// 年月日+時刻（送信トレイ・グループチャット用）
const fmtFull = (ts: string) => {
  const d = new Date(ts);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  if (isToday)
    return d.toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: 'numeric', minute: '2-digit' });
  return d.toLocaleDateString('ja-JP', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: 'numeric', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
};
// 確認・回答日時表示用：今日でも省略せず常に年月日時分を出す
const fmtConfirmDate = (ts: string) => {
  const d = new Date(ts);
  return d.toLocaleString('ja-JP', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: 'numeric', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
};
// (fmtNotif は App.tsx の通知ベルで使用)
// 送信予約input の min用：toISOString()はUTC基準になり、JST(UTC+9)では実際の現在より9時間前がminになってしまうため、ローカル時刻で組み立てる
const localDatetimeMin = (offsetMs = 60000) => {
  const d = new Date(Date.now() + offsetMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const avatarLetter = (name: string | null | undefined) => (name || '?')[0];

const DEADLINE_TYPES = [
  { value: 'read',    label: '📖 読了',    reportLabel: '読了報告',  doneLabel: '読了済み', promptPlaceholder: '例：2026年経営方針',   locationPlaceholder: '例：Slackのcanvas',      linkPlaceholder: 'https://...' },
  { value: 'answer',  label: '✏️ 回答',   reportLabel: '回答報告',  doneLabel: '回答済み', promptPlaceholder: '例：短期シフト',       locationPlaceholder: '例：スプレッドシート',   linkPlaceholder: 'https://forms.google.com/...' },
  { value: 'submit',  label: '📤 提出',   reportLabel: '提出報告',  doneLabel: '提出済み', promptPlaceholder: '例：年末調整資料',     locationPlaceholder: '例：経理担当者に提出',   linkPlaceholder: 'https://...' },
  { value: 'approve', label: '✅ 承認',   reportLabel: '承認報告',  doneLabel: '承認済み', promptPlaceholder: '例：〇〇企画書',       locationPlaceholder: '例：スプレッドシート',   linkPlaceholder: 'https://...' },
  { value: 'confirm', label: '☑️ 確認',   reportLabel: '確認報告',  doneLabel: '確認済み', promptPlaceholder: '例：シフト変更のご確認', locationPlaceholder: '例：スプレッドシート',  linkPlaceholder: 'https://...' },
] as const;

// ────────────────────────────────────────────────────────────────
// Icons
// ────────────────────────────────────────────────────────────────

const ArchiveIcon: React.FC<{ size?: number }> = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
    <path d="M21 8v13H3V8" />
    <rect x="1" y="3" width="22" height="5" rx="1" />
    <polyline points="10 13 12 15 14 13" />
    <line x1="12" y1="9" x2="12" y2="15" />
  </svg>
);

// ────────────────────────────────────────────────────────────────
// Component
// ────────────────────────────────────────────────────────────────

const BoardPage: React.FC = () => {
  const { user, isAdmin, profileName, roleTitle, employmentType } = useAuth();
  const { previewRole } = useContext(AuthContext);
  const isDark = useDarkMode();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const bg        = isDark ? '#1a1a2e' : '#f0f2f5';
  const sidebarBg = isDark ? '#16213e' : '#f8f9fa';
  const cardBg    = isDark ? '#2d2d3e' : '#ffffff';
  const textColor = isDark ? '#eeeeee' : '#222222';
  const subColor  = isDark ? '#aaaaaa' : '#666666';
  const border    = isDark ? '#3a3a5c' : '#e0e0e0';
  const inputBg   = isDark ? '#3a3a5c' : '#f8f9fa';

  // ── State ───────────────────────────────────────────────────────

  const [channels,    setChannels]    = useState<Channel[]>([]);
  const [members,     setMembers]     = useState<ChannelMember[]>([]);
  const [messages,    setMessages]    = useState<BoardMessage[]>([]);
  const [lastSeen,          setLastSeen]          = useState<Record<string, string>>({});
  const [prevChannelLastSeen, setPrevChannelLastSeen] = useState<string | null>(null);
  const [readCounts,  setReadCounts]  = useState<Record<string, number>>({});
  const [allProfiles, setAllProfiles] = useState<SimpleProfile[]>([]);
  const [dmDefaultPerms, setDmDefaultPerms] = useState<SendPermissions | null>(null);
  const [noticeSendRoles, setNoticeSendRoles] = useState<string[]>([]); // 空=全員OK
  const [noticeCCUserIds, setNoticeCCUserIds] = useState<string[]>([]);  // 管理者・代表者自動CC
  const [groupCreateUserIds, setGroupCreateUserIds] = useState<string[]>([]); // グループ作成できる人（管理者は常に可）
  const [composeIncludeCC, setComposeIncludeCC] = useState(true);
  const [channelDeleteConfirmId, setChannelDeleteConfirmId] = useState<string | null>(null);

  // ── URL連動の画面状態 ─────────────────────────────────────────────
  // スマホの戻るボタンで受信トレイ詳細→一覧のように1段階ずつ戻れるよう、
  // 画面の深さをURLパラメータ(bv/bsb/bch/bin/bout/bth)に反映する。
  // 同一イベント内での複数setステートはマイクロタスクでまとめて1回のpush/replaceに合成する
  // （1タップで履歴が複数積まれて戻るボタンが効かなくなるのを防ぐため）。
  const boardPatchRef = useRef<Record<string, string | null> | null>(null);
  const boardPatchReplaceRef = useRef(false);
  const boardFlushScheduledRef = useRef(false);
  const patchBoardParams = useCallback((patch: Record<string, string | null>, opts?: { replace?: boolean }) => {
    boardPatchRef.current = { ...(boardPatchRef.current || {}), ...patch };
    if (opts?.replace) boardPatchReplaceRef.current = true;
    if (!boardFlushScheduledRef.current) {
      boardFlushScheduledRef.current = true;
      queueMicrotask(() => {
        boardFlushScheduledRef.current = false;
        const p = boardPatchRef.current;
        const replace = boardPatchReplaceRef.current;
        boardPatchRef.current = null;
        boardPatchReplaceRef.current = false;
        if (!p) return;
        setSearchParams(prev => {
          const next = new URLSearchParams(prev);
          Object.entries(p).forEach(([k, v]) => { if (v === null) next.delete(k); else next.set(k, v); });
          return next;
        }, { replace });
      });
    }
  }, [setSearchParams]);
  // メッセージ削除等の副作用でstateを補正するだけの場合はreplaceで履歴を汚さない
  const silentClearBoardParam = useCallback((key: string) => patchBoardParams({ [key]: null }, { replace: true }), [patchBoardParams]);

  const view              = (searchParams.get('bv') as View) || 'inbox';
  const showSidebar       = searchParams.get('bsb') !== '0';
  const selectedChannelId = searchParams.get('bch');
  const threadMsgId       = searchParams.get('bth');
  const setView              = useCallback((v: View) => patchBoardParams({ bv: v === 'inbox' ? null : v }), [patchBoardParams]);
  const setShowSidebar       = useCallback((v: boolean) => patchBoardParams({ bsb: v ? null : '0' }), [patchBoardParams]);
  const setSelectedChannelId = useCallback((v: string | null) => patchBoardParams({ bch: v }), [patchBoardParams]);
  const setThreadMsgId       = useCallback((v: string | null) => patchBoardParams({ bth: v }), [patchBoardParams]);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [showChannelList,    setShowChannelList]     = useState(true);

  // 受信トレイ
  const [inboxMessages,    setInboxMessages]    = useState<BoardMessage[]>([]);
  const [inboxFilter,      setInboxFilter]      = useState<'all' | 'unread' | 'pending' | 'read' | 'answer' | 'submit' | 'approve' | 'archived'>('all');
  const inboxDetailId = searchParams.get('bin');
  const setInboxDetailId = useCallback((v: string | null) => patchBoardParams({ bin: v }), [patchBoardParams]);
  const [inboxRecipients,  setInboxRecipients]  = useState<Record<string, string[]>>({});
  const [archivedMessages, setArchivedMessages] = useState<BoardMessage[]>([]);
  const [inboxDetailRecipients,   setInboxDetailRecipients]   = useState<string[]>([]);
  const [inboxDetailUnconfirmed,  setInboxDetailUnconfirmed]  = useState<string[]>([]);
  const [inboxRemindSending,      setInboxRemindSending]      = useState(false);
  const [archiveBulkPeriod,       setArchiveBulkPeriod]       = useState<'1m' | '3m' | '1y' | 'all' | ''>('');
  const [archiveBulkDeleting] = useState(false);

  // 送信トレイ
  const [outboxMessages,         setOutboxMessages]         = useState<BoardMessage[]>([]);
  const [outboxArchivedMessages, setOutboxArchivedMessages] = useState<BoardMessage[]>([]);
  const [outboxTab,              setOutboxTab]              = useState<'sent' | 'scheduled' | 'draft' | 'archive'>('sent');
  const [, setOutboxArchiveConfirmId] = useState<string | null>(null);
  const [outboxArchiveSelected,  setOutboxArchiveSelected]  = useState<Set<string>>(new Set());
  const [outboxArchiveDelConfirm, setOutboxArchiveDelConfirm] = useState(false);
  const [inboxArchiveSelected,   setInboxArchiveSelected]   = useState<Set<string>>(new Set());
  const [inboxArchiveDelConfirm,  setInboxArchiveDelConfirm]  = useState(false);
  const outboxDetailId = searchParams.get('bout');
  const setOutboxDetailId = useCallback((v: string | null) => patchBoardParams({ bout: v }), [patchBoardParams]);
  const [showAllOutboxRecipients, setShowAllOutboxRecipients] = useState(false);
  // 送信メッセージ修正・削除
  const [editingNoticeId,    setEditingNoticeId]    = useState<string | null>(null);
  const [editingNoticeSubj,  setEditingNoticeSubj]  = useState('');
  const [editingNoticeBody,  setEditingNoticeBody]  = useState('');
  const [deleteConfirmId,    setDeleteConfirmId]    = useState<string | null>(null);
  const [noticeActionBanner, setNoticeActionBanner] = useState<'saved' | 'deleted' | null>(null);

  // グループ/DM 折りたたみ
  const [expandGroups,     setExpandGroups]     = useState(false);
  const [expandDMs,        setExpandDMs]        = useState(false);

  // 送信フロー（compose）。入力中の下書きを端末に自動保存し、開き直したら復元する
  interface ComposeDraft {
    subject: string; body: string; recipientIds: string[]; deadlineType: string;
    deadline: string; scheduledAt: string; answerPrompt: string; answerLocation: string; answerLink: string;
  }
  const [cd] = useState(() => loadDraft<ComposeDraft>(DRAFT_KEYS.boardCompose));
  const [composeSubject,       setComposeSubject]       = useState(cd?.subject ?? '');
  const [composeBody,          setComposeBody]          = useState(cd?.body ?? '');
  const [composeRecipientIds,  setComposeRecipientIds]  = useState<string[]>(cd?.recipientIds ?? []);
  const [composeDeadlineType,  setComposeDeadlineType]  = useState(cd?.deadlineType ?? '');
  const [composeDeadline,      setComposeDeadline]      = useState(cd?.deadline ?? '');
  const [composeScheduledAt,   setComposeScheduledAt]   = useState(cd?.scheduledAt ?? '');
  const [composeOptions,        setComposeOptions]        = useState(true);
  const [_composeDraftId,       setComposeDraftId]        = useState<string | null>(null);
  const [composeQuery,          setComposeQuery]          = useState('');
  const [composeAnswerPrompt,   setComposeAnswerPrompt]   = useState(cd?.answerPrompt ?? '');
  const [composeAnswerLocation, setComposeAnswerLocation] = useState(cd?.answerLocation ?? '');
  const [composeAnswerLink,     setComposeAnswerLink]     = useState(cd?.answerLink ?? '');
  const [showComposeSendConfirm, setShowComposeSendConfirm] = useState(false);
  const [showAllRecipients, setShowAllRecipients] = useState(false);
  const [showSearch,  setShowSearch]  = useState(false);
  const [searchText,  setSearchText]  = useState('');
  const [searchResults, setSearchResults] = useState<BoardMessage[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);

  // Compose
  const [newBody,              setNewBody]              = useState('');
  const [newDeadline,          setNewDeadline]          = useState('');
  const [newDeadlineType,      setNewDeadlineType]      = useState('');
  const [newScheduledAt,       setNewScheduledAt]       = useState('');
  const [showOptionsExpanded,  setShowOptionsExpanded]  = useState(false);
  const [confirmations,        setConfirmations]        = useState<Record<string, {user_id: string; comment: string | null; confirmed_at?: string}[]>>({});
  const [myConfirmTimes,       setMyConfirmTimes]       = useState<Record<string, string>>({});
  const [unconfirmedMsgId,     setUnconfirmedMsgId]     = useState<string | null>(null);
  const [answerInputId,        setAnswerInputId]        = useState<string | null>(null);
  const [answerText,           setAnswerText]           = useState('');
  const [newTitle,             setNewTitle]             = useState('');
  const [newAnswerPrompt,      setNewAnswerPrompt]      = useState('');
  const [newAnswerLocation,    setNewAnswerLocation]    = useState('');
  const [newAnswerLink,        setNewAnswerLink]        = useState('');
  const [replyBody,            setReplyBody]            = useState('');
  const [inboxReadIds,          setInboxReadIds]          = useState<Set<string>>(new Set());
  const [sending,               setSending]               = useState(false);
  const [sendError,             setSendError]             = useState<string | null>(null); // 送信失敗のインライントースト（alert廃止）
  const [confirmDialog,         setConfirmDialog]         = useState<{ message: string; onConfirm: () => void } | null>(null); // 共通インライン確認（confirm廃止）
  const [showSendConfirm,       setShowSendConfirm]       = useState(false);
  const [showReplySendConfirm,  setShowReplySendConfirm]  = useState(false);

  // Modals
  const [showGroupModal,   setShowGroupModal]   = useState(false);
  const [groupName,        setGroupName]        = useState('');
  const [groupMemberIds,   setGroupMemberIds]   = useState<string[]>([]);
  const [showMemberModal,  setShowMemberModal]  = useState(false);
  const [pendingMemberIds, setPendingMemberIds] = useState<string[]>([]);
  const [memberSaving,     setMemberSaving]     = useState(false);
  const [memberBanner,     setMemberBanner]     = useState(false);
  const [chipExpanded,     setChipExpanded]     = useState(false);
  const [showDMSearch,     setShowDMSearch]     = useState(false);
  const [dmQuery,          setDmQuery]          = useState('');
  const [dmSelectedIds,    setDmSelectedIds]    = useState<string[]>([]);
  const [dmError,          setDmError]          = useState('');
  const [dmCreating,       setDmCreating]       = useState(false);
  const [broadcastMessage, setBroadcastMessage] = useState('');
  const [loadingData,      setLoadingData]      = useState(true);
  const [readDetailMsgId,  setReadDetailMsgId]  = useState<string | null>(null);
  const [readDetailUsers,  setReadDetailUsers]  = useState<{ user_id: string; read_at: string }[]>([]);
  const [_showReadDetail,  setShowReadDetail]   = useState(true); // 設定: 全員が既読詳細を見れるか

  const [saveBanner, setSaveBanner] = useState(false);
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);

  // お気に入り
  const [favChannelIds,  setFavChannelIds]  = useState<Set<string>>(new Set());
  const [favMessageIds,  setFavMessageIds]  = useState<Set<string>>(new Set());
  const [favMessages,    setFavMessages]    = useState<BoardMessage[]>([]);
  const [favUnreadIds,   setFavUnreadIds]   = useState<Set<string>>(new Set());
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const channelListRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  // ── Load ────────────────────────────────────────────────────────

  const loadAll = useCallback(async () => {
    if (!user) return;
    setLoadingData(true);

    // My channel IDs
    const { data: myMem } = await supabase
      .from('board_channel_members')
      .select('channel_id')
      .eq('user_id', user.id);
    const cids = (myMem || []).map((m: { channel_id: string }) => m.channel_id);

    if (cids.length === 0) {
      setChannels([]); setMessages([]); setLoadingData(false); return;
    }

    const [chRes, memRes, msgRes, lsRes, profRes, settingsRes, dmSettingsRes, noticeSendRes, ccSettingsRes, groupCreateRes] = await Promise.all([
      supabase.from('board_channels').select('id, type, name, created_by, created_at, send_permissions, show_read_detail').in('id', cids),
      supabase.from('board_channel_members').select('channel_id, user_id').in('channel_id', cids),
      supabase.from('board_messages').select('id, channel_id, parent_id, user_id, body, edited_at, created_at, deadline, deadline_type, requires_confirmation, scheduled_at, sent_at, title, answer_prompt, answer_location, answer_link, broadcast_recipients').in('channel_id', cids).order('created_at', { ascending: false }).limit(500),
      supabase.from('board_channel_last_seen').select('channel_id, last_seen_at').eq('user_id', user.id),
      supabase.from('profiles').select('id, name, role_title, employment_type, group_names').eq('is_active', true).order('name'),
      supabase.from('master_options').select('value').eq('category', 'board_show_read_detail').limit(1),
      supabase.from('app_settings').select('value').eq('key', 'dm_default_send_permissions').maybeSingle(),
      supabase.from('app_settings').select('value').eq('key', 'board_notice_send_roles').maybeSingle(),
      supabase.from('app_settings').select('value').eq('key', 'board_notice_cc_user_ids').maybeSingle(),
      supabase.from('app_settings').select('value').eq('key', 'board_group_create_user_ids').maybeSingle(),
    ]);
    if (dmSettingsRes.data?.value) setDmDefaultPerms(dmSettingsRes.data.value as SendPermissions);
    if (noticeSendRes.data?.value) setNoticeSendRoles(noticeSendRes.data.value as string[]);
    if (ccSettingsRes?.data?.value) setNoticeCCUserIds(ccSettingsRes.data.value as string[]);
    if (groupCreateRes?.data?.value) setGroupCreateUserIds(groupCreateRes.data.value as string[]);

    setChannels((chRes.data || []) as Channel[]);
    setMembers((memRes.data || []).map((m: any) => ({ channel_id: m.channel_id, user_id: m.user_id, profile: null })));
    const now = new Date().toISOString();
    setMessages((msgRes.data || []).filter((m: any) => !m.scheduled_at || m.scheduled_at <= now).map((m: any) => ({ ...m, profile: null })));

    // requires_confirmation / deadline_type ありの投稿の確認者を取得
    const confirmMsgIds = (msgRes.data || []).filter((m: any) => m.requires_confirmation || m.deadline_type).map((m: any) => m.id);
    if (confirmMsgIds.length > 0) {
      const { data: confData } = await supabase.from('board_confirmations').select('message_id, user_id, comment, confirmed_at').in('message_id', confirmMsgIds);
      const confMap: Record<string, {user_id: string; comment: string | null; confirmed_at?: string}[]> = {};
      (confData || []).forEach((c: { message_id: string; user_id: string; comment: string | null; confirmed_at: string }) => {
        if (!confMap[c.message_id]) confMap[c.message_id] = [];
        confMap[c.message_id].push({ user_id: c.user_id, comment: c.comment, confirmed_at: c.confirmed_at });
      });
      setConfirmations(confMap);
    }

    const ls: Record<string, string> = {};
    (lsRes.data || []).forEach((r: any) => { ls[r.channel_id] = r.last_seen_at; });
    setLastSeen(ls);

    setAllProfiles((profRes.data || []) as SimpleProfile[]);
    if (settingsRes.data && settingsRes.data.length > 0) {
      setShowReadDetail(settingsRes.data[0].value !== 'false');
    }

    // Read counts
    const msgIds = (msgRes.data || []).map((m: any) => m.id);
    if (msgIds.length > 0) {
      const { data: rcData } = await supabase.from('board_reads').select('message_id').in('message_id', msgIds);
      const rc: Record<string, number> = {};
      (rcData || []).forEach((r: any) => { rc[r.message_id] = (rc[r.message_id] || 0) + 1; });
      setReadCounts(prev => ({ ...prev, ...rc }));
    }

    setLoadingData(false);
  }, [user]);

  const loadFavorites = useCallback(async () => {
    if (!user) return;
    const { data } = await supabase
      .from('board_favorites')
      .select('message_id, channel_id')
      .eq('user_id', user.id);
    const chIds  = new Set<string>();
    const msgIds = new Set<string>();
    (data || []).forEach((f: any) => {
      if (f.channel_id) chIds.add(f.channel_id);
      if (f.message_id) msgIds.add(f.message_id);
    });
    setFavChannelIds(chIds);
    setFavMessageIds(msgIds);
    if (msgIds.size > 0) {
      const [msgsRes, readsRes] = await Promise.all([
        supabase
          .from('board_messages')
          .select('id, channel_id, parent_id, user_id, body, edited_at, created_at, deadline, deadline_type, requires_confirmation, scheduled_at, sent_at, title, subject, status, answer_prompt, answer_location, answer_link')
          .in('id', [...msgIds])
          .order('created_at', { ascending: false }),
        supabase
          .from('board_reads')
          .select('message_id')
          .eq('user_id', user.id)
          .in('message_id', [...msgIds]),
      ]);
      setFavMessages((msgsRes.data || []) as BoardMessage[]);
      const readSet = new Set((readsRes.data || []).map((r: any) => r.message_id));
      setFavUnreadIds(new Set([...msgIds].filter(id => !readSet.has(id))));
    } else {
      setFavMessages([]);
      setFavUnreadIds(new Set());
    }
  }, [user]);

  useEffect(() => { loadAll(); }, [loadAll]);
  useEffect(() => { loadFavorites(); }, [loadFavorites]);

  const toggleFavChannel = async (e: React.MouseEvent, chId: string) => {
    e.stopPropagation();
    if (!user) return;
    const isFav = favChannelIds.has(chId);
    if (isFav) {
      await supabase.from('board_favorites').delete().eq('user_id', user.id).eq('channel_id', chId);
      setFavChannelIds(prev => { const s = new Set(prev); s.delete(chId); return s; });
    } else {
      await supabase.from('board_favorites').insert({ user_id: user.id, channel_id: chId });
      setFavChannelIds(prev => new Set([...prev, chId]));
    }
  };

  const toggleFavMessage = async (e: React.MouseEvent, msgId: string, msg: BoardMessage) => {
    e.stopPropagation();
    if (!user) return;
    const isFav = favMessageIds.has(msgId);
    if (isFav) {
      await supabase.from('board_favorites').delete().eq('user_id', user.id).eq('message_id', msgId);
      setFavMessageIds(prev => { const s = new Set(prev); s.delete(msgId); return s; });
      setFavMessages(prev => prev.filter(m => m.id !== msgId));
    } else {
      await supabase.from('board_favorites').insert({ user_id: user.id, message_id: msgId });
      setFavMessageIds(prev => new Set([...prev, msgId]));
      setFavMessages(prev => [msg, ...prev.filter(m => m.id !== msgId)]);
    }
  };

  // 連絡板ボタン再タップ → サイドバーTOPにリセット
  const resetToTop = useCallback(() => {
    // タブ再タップでのTOPリセットは「1段階戻る」ではなく根本へのジャンプなので
    // pushではなくreplaceでURLパラメータを一括クリアする
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      ['bv', 'bsb', 'bch', 'bin', 'bout', 'bth'].forEach(k => next.delete(k));
      return next;
    }, { replace: true });
    setShowSearch(false);
    setSearchText('');
    setSearchResults([]);
  }, [setSearchParams]);

  useEffect(() => {
    window.addEventListener('board-reset', resetToTop);
    return () => window.removeEventListener('board-reset', resetToTop);
  }, [resetToTop]);


  // メッセージ全文検索（300msデバウンス）
  useEffect(() => {
    if (!searchText.trim() || searchText.trim().length < 2) {
      setSearchResults([]);
      if (view === 'search') navigate(-1);
      return;
    }
    const timer = setTimeout(async () => {
      if (!user) return;
      setSearchLoading(true);
      setView('search');
      setShowSidebar(false);

      // 自分がメンバーのチャンネルID
      const { data: myMem } = await supabase
        .from('board_channel_members')
        .select('channel_id')
        .eq('user_id', user.id);
      const cids = (myMem || []).map((m: any) => m.channel_id);

      // 受信トレイメッセージID
      const { data: recData } = await supabase
        .from('board_message_recipients')
        .select('message_id')
        .eq('user_id', user.id);
      const inboxIds = (recData || []).map((r: any) => r.message_id);

      const q = `%${searchText.trim()}%`;

      // チャンネルメッセージ検索
      const channelQuery = cids.length > 0
        ? supabase
            .from('board_messages')
            .select('id, channel_id, parent_id, user_id, body, edited_at, created_at, deadline, deadline_type, requires_confirmation, scheduled_at, sent_at, title, subject, status, answer_prompt, answer_location, answer_link')
            .in('channel_id', cids)
            .or(`body.ilike.${q},subject.ilike.${q}`)
            .order('created_at', { ascending: false })
            .limit(30)
        : Promise.resolve({ data: [] });

      // 受信トレイメッセージ検索
      const inboxQuery = inboxIds.length > 0
        ? supabase
            .from('board_messages')
            .select('id, channel_id, parent_id, user_id, body, edited_at, created_at, deadline, deadline_type, requires_confirmation, scheduled_at, sent_at, title, subject, status, answer_prompt, answer_location, answer_link')
            .in('id', inboxIds)
            .or(`body.ilike.${q},subject.ilike.${q}`)
            .order('created_at', { ascending: false })
            .limit(30)
        : Promise.resolve({ data: [] });

      const [chRes, inRes] = await Promise.all([channelQuery, inboxQuery]);

      // 重複排除してマージ
      const seen = new Set<string>();
      const merged: BoardMessage[] = [];
      for (const m of [...((chRes.data || []) as any[]), ...((inRes.data || []) as any[])]) {
        if (!seen.has(m.id)) {
          seen.add(m.id);
          merged.push({ ...m, broadcast_recipients: null, profile: null });
        }
      }
      merged.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

      setSearchResults(merged.slice(0, 50));
      setSearchLoading(false);
    }, 300);
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchText, user]);

  const loadInbox = useCallback(async () => {
    if (!user) return;
    // 自分が受信者のメッセージを取得（archived=falseのみ）
    const { data: recData } = await supabase
      .from('board_message_recipients')
      .select('message_id')
      .eq('user_id', user.id)
      .eq('archived', false);
    const msgIds = (recData || []).map((r: any) => r.message_id);
    if (msgIds.length === 0) { setInboxMessages([]); return; }

    // メッセージ・既読・カウントを並行取得してフラッシュを防ぐ
    const [{ data: msgData }, { data: readData }, { data: rcData }] = await Promise.all([
      supabase
        .from('board_messages')
        .select('id, channel_id, parent_id, user_id, body, edited_at, created_at, deadline, deadline_type, requires_confirmation, scheduled_at, sent_at, title, subject, status, answer_prompt, answer_location, answer_link')
        .in('id', msgIds)
        .is('parent_id', null)
        .order('created_at', { ascending: false }),
      supabase.from('board_reads').select('message_id').in('message_id', msgIds).eq('user_id', user.id),
      supabase.from('board_reads').select('message_id').in('message_id', msgIds),
    ]);

    // status='scheduled'（未送信）は受信トレイに出さない。cronがstatus='sent'に切り替えるまで非表示
    // ※クライアント時計とscheduled_atの比較ではなく、DBが確定させたstatusで判定する（送信時刻の表示崩れ・表示タイミングのズレを防ぐ）
    setInboxMessages((msgData || [])
      .filter((m: any) => m.status !== 'scheduled')
      .map((m: any) => ({ ...m, broadcast_recipients: null, profile: null })));
    setInboxReadIds(new Set((readData || []).map((r: any) => r.message_id)));
    const rc: Record<string, number> = {};
    (rcData || []).forEach((r: any) => { rc[r.message_id] = (rc[r.message_id] || 0) + 1; });
    setReadCounts(prev => ({ ...prev, ...rc }));

    // confirmations を読む（deadline_type / requires_confirmation があるもの）
    const confirmMsgIds = (msgData || []).filter((m: any) => m.requires_confirmation || m.deadline_type).map((m: any) => m.id);
    if (confirmMsgIds.length > 0) {
      const { data: confData } = await supabase.from('board_confirmations').select('message_id, user_id, comment, confirmed_at').in('message_id', confirmMsgIds);
      const confMap: Record<string, {user_id: string; comment: string | null; confirmed_at?: string}[]> = {};
      (confData || []).forEach((c: any) => {
        if (!confMap[c.message_id]) confMap[c.message_id] = [];
        confMap[c.message_id].push({ user_id: c.user_id, comment: c.comment, confirmed_at: c.confirmed_at });
      });
      setConfirmations(prev => ({ ...prev, ...confMap }));
    }
  }, [user]);

  const loadArchived = useCallback(async () => {
    if (!user) return;
    const { data: recData } = await supabase
      .from('board_message_recipients')
      .select('message_id')
      .eq('user_id', user.id)
      .eq('archived', true);
    const msgIds = (recData || []).map((r: any) => r.message_id);
    if (msgIds.length === 0) { setArchivedMessages([]); return; }
    const { data: msgData } = await supabase
      .from('board_messages')
      .select('id, channel_id, parent_id, user_id, body, edited_at, created_at, deadline, deadline_type, requires_confirmation, scheduled_at, sent_at, title, subject, status, answer_prompt, answer_location, answer_link')
      .in('id', msgIds)
      .is('parent_id', null)
      .order('created_at', { ascending: false });
    setArchivedMessages((msgData || []).map((m: any) => ({ ...m, broadcast_recipients: null, profile: null })));
  }, [user]);

  const archiveMessage = async (msgId: string, archive: boolean) => {
    if (!user) return;
    await supabase
      .from('board_message_recipients')
      .update({ archived: archive })
      .eq('message_id', msgId)
      .eq('user_id', user.id);
    if (archive) {
      setInboxMessages(prev => prev.filter(m => m.id !== msgId));
      if (inboxDetailId === msgId) silentClearBoardParam('bin');
    } else {
      setArchivedMessages(prev => prev.filter(m => m.id !== msgId));
      await loadInbox();
    }
  };

  const loadOutbox = useCallback(async () => {
    if (!user) return;
    const SEL = 'id, channel_id, parent_id, user_id, body, edited_at, created_at, deadline, deadline_type, requires_confirmation, scheduled_at, sent_at, title, subject, status, answer_prompt, answer_location, answer_link, outbox_hidden, cc_user_ids';
    const [{ data }, { data: archData }, { data: ccData }] = await Promise.all([
      supabase.from('board_messages').select(SEL)
        .eq('user_id', user.id).is('channel_id', null).is('parent_id', null)
        .or('outbox_hidden.is.null,outbox_hidden.eq.false')
        .order('created_at', { ascending: false }),
      supabase.from('board_messages').select(SEL)
        .eq('user_id', user.id).is('channel_id', null).is('parent_id', null)
        .eq('outbox_hidden', true)
        .order('created_at', { ascending: false }),
      supabase.from('board_messages').select(SEL)
        .contains('cc_user_ids', [user.id]).is('channel_id', null).is('parent_id', null)
        .or('outbox_hidden.is.null,outbox_hidden.eq.false')
        .order('created_at', { ascending: false }),
    ]);
    const ownIds = new Set((data || []).map((m: any) => m.id));
    const ccOnly = (ccData || []).filter((m: any) => !ownIds.has(m.id));
    const allSent = [...(data || []), ...ccOnly].sort((a: any, b: any) => b.created_at.localeCompare(a.created_at));
    setOutboxMessages(allSent.map((m: any) => ({ ...m, broadcast_recipients: null, profile: null })));
    setOutboxArchivedMessages((archData || []).map((m: any) => ({ ...m, broadcast_recipients: null, profile: null })));

    // recipients を取得
    const ids = (data || []).map((m: any) => m.id);
    if (ids.length > 0) {
      const { data: recData } = await supabase
        .from('board_message_recipients')
        .select('message_id, user_id')
        .in('message_id', ids);
      const map: Record<string, string[]> = {};
      (recData || []).forEach((r: any) => {
        if (!map[r.message_id]) map[r.message_id] = [];
        map[r.message_id].push(r.user_id);
      });
      setInboxRecipients(prev => ({ ...prev, ...map }));

      // 既読カウント取得
      const { data: rcData } = await supabase.from('board_reads').select('message_id').in('message_id', ids);
      const rc: Record<string, number> = {};
      (rcData || []).forEach((r: any) => { rc[r.message_id] = (rc[r.message_id] || 0) + 1; });
      setReadCounts(prev => ({ ...prev, ...rc }));

      // confirmations を読む（deadline_type / requires_confirmation があるもの。送信トレイの対応状況表示に必要）
      const confirmMsgIds = (data || []).filter((m: any) => m.requires_confirmation || m.deadline_type).map((m: any) => m.id);
      if (confirmMsgIds.length > 0) {
        const { data: confData } = await supabase.from('board_confirmations').select('message_id, user_id, comment, confirmed_at').in('message_id', confirmMsgIds);
        const confMap: Record<string, {user_id: string; comment: string | null; confirmed_at?: string}[]> = {};
        (confData || []).forEach((c: any) => {
          if (!confMap[c.message_id]) confMap[c.message_id] = [];
          confMap[c.message_id].push({ user_id: c.user_id, comment: c.comment, confirmed_at: c.confirmed_at });
        });
        setConfirmations(prev => ({ ...prev, ...confMap }));
      }
    }
  }, [user]);

  useEffect(() => { loadInbox(); }, [loadInbox]);
  useEffect(() => { loadArchived(); }, [loadArchived]);
  useEffect(() => { loadOutbox(); }, [loadOutbox]);

  // URLパラメータ openInboxId で受信トレイ詳細を自動展開
  useEffect(() => {
    const openId = searchParams.get('openInboxId');
    if (!openId || inboxMessages.length === 0) return;
    const msg = inboxMessages.find(m => m.id === openId);
    if (!msg) return;
    // まず現在のエントリを受信トレイ一覧のベース状態に置き換え（replace）、
    // その上で詳細エントリをpush → 戻るボタンで一覧に戻れるようにする
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      ['openInboxId', 'bv', 'bin', 'bch', 'bout', 'bth'].forEach(k => next.delete(k));
      next.set('bsb', '0');
      return next;
    }, { replace: true });
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      next.set('bin', openId);
      return next;
    }, { replace: false });
    if (!inboxReadIds.has(openId) && user) {
      supabase.from('board_reads').upsert({ message_id: openId, user_id: user.id }, { onConflict: 'message_id,user_id', ignoreDuplicates: true })
        .then(() => setInboxReadIds(prev => new Set([...prev, openId])));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, inboxMessages]);

  // 受信トレイ詳細を開いた時、送信者 or 管理者なら受信者＋未対応者を取得
  useEffect(() => {
    if (!inboxDetailId || !user) { setInboxDetailRecipients([]); setInboxDetailUnconfirmed([]); return; }
    const msg = inboxMessages.find(m => m.id === inboxDetailId) || archivedMessages.find(m => m.id === inboxDetailId);
    if (!msg) return;
    (async () => {
      const [{ data: recData }, { data: confData }] = await Promise.all([
        supabase.from('board_message_recipients').select('user_id').eq('message_id', inboxDetailId),
        supabase.from('board_confirmations').select('user_id').eq('message_id', inboxDetailId),
      ]);
      const allIds = (recData || []).map((r: any) => r.user_id as string);
      const confirmedIds = new Set((confData || []).map((c: any) => c.user_id as string));
      setInboxDetailRecipients(allIds);
      setInboxDetailUnconfirmed(allIds.filter(id => !confirmedIds.has(id)));
      setInboxRecipients(prev => ({ ...prev, [inboxDetailId]: allIds }));
    })();
  }, [inboxDetailId, user, isAdmin, inboxMessages, archivedMessages]);

  useEffect(() => {
    if (selectedChannelId) messagesEndRef.current?.scrollIntoView({ behavior: 'instant' });
  }, [messages.length, selectedChannelId]);

  // お知らせ作成フォームの下書きを自動保存（別アプリへ調べに行って戻っても消えない）。
  // 全項目が空なら下書きを残さない（送信・クリア後に空の下書きが復活するのを防ぐ）。
  useEffect(() => {
    const hasContent = composeSubject || composeBody || composeRecipientIds.length > 0 ||
      composeDeadlineType || composeDeadline || composeScheduledAt ||
      composeAnswerPrompt || composeAnswerLocation || composeAnswerLink;
    if (hasContent) {
      saveDraft(DRAFT_KEYS.boardCompose, {
        subject: composeSubject, body: composeBody, recipientIds: composeRecipientIds,
        deadlineType: composeDeadlineType, deadline: composeDeadline, scheduledAt: composeScheduledAt,
        answerPrompt: composeAnswerPrompt, answerLocation: composeAnswerLocation, answerLink: composeAnswerLink,
      });
    } else {
      clearDraft(DRAFT_KEYS.boardCompose);
    }
  }, [composeSubject, composeBody, composeRecipientIds, composeDeadlineType, composeDeadline, composeScheduledAt, composeAnswerPrompt, composeAnswerLocation, composeAnswerLink]);

  // 既読状況ポップアップを開いたとき、受信者が未取得なら取得する
  useEffect(() => {
    if (!readDetailMsgId || !user) return;
    if (inboxRecipients[readDetailMsgId]) return; // 既に取得済み
    const allMsgs = [...messages, ...inboxMessages, ...outboxMessages, ...archivedMessages];
    const msg = allMsgs.find(m => m.id === readDetailMsgId);
    if (!msg || msg.channel_id) return; // チャンネルメッセージは members を使う
    supabase.from('board_message_recipients').select('user_id').eq('message_id', readDetailMsgId)
      .then(({ data }) => {
        if (data) setInboxRecipients(prev => ({ ...prev, [readDetailMsgId]: data.map((r: any) => r.user_id) }));
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readDetailMsgId, user]);

  useEffect(() => {
    if (showChannelList) {
      const id = setTimeout(() => {
        if (channelListRef.current) channelListRef.current.scrollTop = 0;
      }, 0);
      return () => clearTimeout(id);
    }
  }, [showChannelList]);

  // ── Computed ────────────────────────────────────────────────────

  const channelDisplayName = (ch: Channel) => {
    if (ch.type === 'group') return ch.name || 'グループ';
    if (ch.type === 'sent_mail') return '送信メール';
    const other = members.find(m => m.channel_id === ch.id && m.user_id !== user?.id);
    return allProfiles.find(p => p.id === other?.user_id)?.name || 'DM';
  };

  const channelLastMsg = (channelId: string) =>
    messages
      .filter(m => m.channel_id === channelId && !m.parent_id)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];

  const channelUnread = (channelId: string) => {
    const seen = lastSeen[channelId];
    if (!seen) return messages.filter(m => m.channel_id === channelId && !m.parent_id).length;
    return messages.filter(m => m.channel_id === channelId && !m.parent_id && new Date(m.created_at) > new Date(seen)).length;
  };

  const sortedChannels = useMemo(() =>
    [...channels].sort((a, b) => {
      const al = channelLastMsg(a.id);
      const bl = channelLastMsg(b.id);
      if (!al && !bl) return 0;
      if (!al) return 1;
      if (!bl) return -1;
      return new Date(bl.created_at).getTime() - new Date(al.created_at).getTime();
    }),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [channels, messages]);

  const selectedChannel = channels.find(c => c.id === selectedChannelId);
  const channelMessages = messages
    .filter(m => m.channel_id === selectedChannelId && !m.parent_id)
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  const threadReplies = (parentId: string) =>
    messages.filter(m => m.parent_id === parentId)
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  const currentMembers = members.filter(m => m.channel_id === selectedChannelId);

  // ── Actions ─────────────────────────────────────────────────────

  const selectChannel = async (channelId: string) => {
    // 「ここから未読」表示用に前回の lastSeen を保存してから更新
    setPrevChannelLastSeen(lastSeen[channelId] || null);
    setSelectedChannelId(channelId);

    setNewBody('');
    setShowOptionsExpanded(false);
    setNewDeadline(''); setNewDeadlineType(''); setNewScheduledAt(''); setNewTitle(''); setNewAnswerPrompt(''); setNewAnswerLocation(''); setNewAnswerLink('');
    setShowChannelList(false);

    await supabase.from('board_channel_last_seen').upsert(
      { channel_id: channelId, user_id: user!.id, last_seen_at: new Date().toISOString() },
      { onConflict: 'channel_id,user_id' }
    );
    setLastSeen(prev => ({ ...prev, [channelId]: new Date().toISOString() }));

    // Mark parent messages as read
    const parentMsgs = messages.filter(m => m.channel_id === channelId && !m.parent_id);
    if (parentMsgs.length > 0) {
      const reads = parentMsgs.map(m => ({ message_id: m.id, user_id: user!.id }));
      await supabase.from('board_reads').upsert(reads, { onConflict: 'message_id,user_id', ignoreDuplicates: true });
      const update: Record<string, number> = {};
      parentMsgs.forEach(m => { update[m.id] = (readCounts[m.id] || 0) + (readCounts[m.id] ? 0 : 1); });
      setReadCounts(prev => ({ ...prev, ...update }));
    }
  };

  const canSendInChannel = (channelId: string): boolean => {
    if (isAdmin) return true;
    const ch = channels.find(c => c.id === channelId);
    if (!ch) return true;
    const perms = ch.type === 'dm' ? dmDefaultPerms : ch.send_permissions;
    if (!perms) return true;
    const { employment_types, role_titles } = perms;
    if (employment_types.length === 0 && role_titles.length === 0) return true;
    return employment_types.includes(employmentType) || role_titles.includes(roleTitle);
  };

  // DM送信権限（管理者は常に可・未設定なら全員可）
  const canStartDM = (() => {
    if (isAdmin) return true;
    if (!dmDefaultPerms) return true;
    const { employment_types, role_titles } = dmDefaultPerms;
    if (employment_types.length === 0 && role_titles.length === 0) return true;
    return employment_types.includes(employmentType) || role_titles.includes(roleTitle);
  })();

  // グループ作成権限（管理者は常に可・設定で選ばれた人・未設定ならCC代表者と同じ人）
  const canCreateGroup = isAdmin
    || groupCreateUserIds.includes(user?.id ?? '')
    || (groupCreateUserIds.length === 0 && noticeCCUserIds.includes(user?.id ?? ''));

  const sendMessage = async (parentId?: string) => {
    if (!selectedChannelId || !user) return;
    const body = parentId ? replyBody : newBody;
    if (!body.trim()) return;
    setSending(true);

    const insertData: Record<string, unknown> = {
      channel_id: selectedChannelId,
      parent_id: parentId || null,
      user_id: user.id,
      body: body.trim(),
    };
    if (!parentId && newDeadline) insertData.deadline = newDeadline;
    if (!parentId && newDeadlineType) {
      insertData.deadline_type = newDeadlineType;
      insertData.requires_confirmation = true;
    }
    if (!parentId && newScheduledAt) insertData.scheduled_at = new Date(newScheduledAt).toISOString();
    if (!parentId && newTitle.trim()) insertData.title = newTitle.trim();
    if (!parentId && newDeadlineType) {
      if (newAnswerPrompt.trim()) insertData.answer_prompt = newAnswerPrompt.trim();
      if (newAnswerLocation.trim()) insertData.answer_location = newAnswerLocation.trim();
      if (newAnswerLink.trim()) insertData.answer_link = newAnswerLink.trim();
    }

    const { data, error } = await supabase
      .from('board_messages')
      .insert(insertData)
      .select('id, channel_id, parent_id, user_id, body, edited_at, created_at, deadline, deadline_type, requires_confirmation, scheduled_at, sent_at, title, answer_prompt, answer_location, answer_link')
      .single();

    if (!error && data) {
      const msg: BoardMessage = { ...data, subject: null, status: 'sent', broadcast_recipients: null, profile: { name: profileName || null } };
      setMessages(prev => [...prev, msg]);
      await supabase.from('board_reads').upsert({ message_id: data.id, user_id: user.id }, { onConflict: 'message_id,user_id', ignoreDuplicates: true });
      setReadCounts(prev => ({ ...prev, [data.id]: 1 }));

      // リプライ通知: スレッド参加者（親メッセージ投稿者 + 既存リプライ投稿者）に通知
      if (parentId) {
        const parentMsg = messages.find(m => m.id === parentId);
        const threadParticipants = new Set<string>();
        if (parentMsg) threadParticipants.add(parentMsg.user_id);
        messages.filter(m => m.parent_id === parentId).forEach(m => threadParticipants.add(m.user_id));
        threadParticipants.delete(user.id); // 自分には送らない
        const senderName = profileName || '誰か';
        const chName = selectedChannel ? (selectedChannel.name || 'チャンネル') : 'チャンネル';
        await Promise.all([...threadParticipants].map(uid =>
          insertNotification(uid, `${senderName}がスレッドにリプライしました`, `${chName}: ${body.trim().slice(0, 40)}`, 'board')
        ));
      }

      // グループ・DMへの新規投稿（スレッド返信ではない）：ベル通知
      if (!parentId && selectedChannel && (selectedChannel.type === 'group' || selectedChannel.type === 'dm')) {
        const recipientIds = members
          .filter(m => m.channel_id === selectedChannelId && m.user_id !== user.id)
          .map(m => m.user_id);
        if (recipientIds.length > 0) {
          const senderName = profileName || '誰か';
          const preview = body.trim().slice(0, 40);
          const bellMessage = selectedChannel.type === 'group'
            ? `${selectedChannel.name || 'グループ'}に${senderName}からメッセージが届きました`
            : `${senderName}からメッセージが届きました`;
          await Promise.all(recipientIds.map(uid =>
            insertNotification(uid, bellMessage, preview, undefined, data.id,
              selectedChannel.type === 'group' ? 'board:group_message' : 'board:dm_message')
          ));
        }
      }

      // メール通知（管理画面の通知設定でON時のみ送信、OFFなら何もしない）
      if (selectedChannel && (selectedChannel.type === 'group' || selectedChannel.type === 'dm')) {
        const recipientIds = members
          .filter(m => m.channel_id === selectedChannelId && m.user_id !== user.id)
          .map(m => m.user_id);
        if (recipientIds.length > 0) {
          const senderName = profileName || '誰か';
          if (selectedChannel.type === 'group') {
            dispatchBoardEmail('board:group_message', { '送信者名': senderName, 'グループ名': selectedChannel.name || 'グループ', 'リンク': BOARD_LINK }, recipientIds);
          } else {
            dispatchBoardEmail('board:dm_message', { '送信者名': senderName, 'リンク': BOARD_LINK }, recipientIds);
          }
        }
      }
    }
    if (parentId) setReplyBody(''); else { setNewBody(''); setNewDeadline(''); setNewDeadlineType(''); setNewScheduledAt(''); setNewTitle(''); setNewAnswerPrompt(''); setNewAnswerLocation(''); setNewAnswerLink(''); setShowOptionsExpanded(false); }
    setSending(false);
  };

  const deleteMessage = async (id: string) => {
    const { error } = await supabase.from('board_messages').delete().eq('id', id);
    if (!error) setMessages(prev => prev.filter(m => m.id !== id && m.parent_id !== id));
    setChannelDeleteConfirmId(null);
  };

  // お知らせの修正（送信者・管理者）
  const saveNoticeEdit = async (msgId: string) => {
    if (!editingNoticeBody.trim() || !editingNoticeSubj.trim()) return;
    const { error } = await supabase
      .from('board_messages')
      .update({ subject: editingNoticeSubj.trim(), body: editingNoticeBody.trim(), edited_at: new Date().toISOString() })
      .eq('id', msgId);
    if (!error) {
      setOutboxMessages(prev => prev.map(m => m.id === msgId ? { ...m, subject: editingNoticeSubj.trim(), body: editingNoticeBody.trim(), edited_at: new Date().toISOString() } : m));
      setInboxMessages(prev => prev.map(m => m.id === msgId ? { ...m, subject: editingNoticeSubj.trim(), body: editingNoticeBody.trim(), edited_at: new Date().toISOString() } : m));
      setEditingNoticeId(null);
      setNoticeActionBanner('saved');
      setTimeout(() => setNoticeActionBanner(null), 3000);
    }
  };

  // お知らせの完全削除（送信者・管理者）
  const deleteNotice = async (msgId: string) => {
    await supabase.from('board_confirmations').delete().eq('message_id', msgId);
    await supabase.from('board_reads').delete().eq('message_id', msgId);
    await supabase.from('board_message_recipients').delete().eq('message_id', msgId);
    await supabase.from('board_messages').delete().eq('id', msgId);
    setOutboxMessages(prev => prev.filter(m => m.id !== msgId));
    setOutboxArchivedMessages(prev => prev.filter(m => m.id !== msgId));
    setInboxMessages(prev => prev.filter(m => m.id !== msgId));
    setArchivedMessages(prev => prev.filter(m => m.id !== msgId));
    setDeleteConfirmId(null);
    if (outboxDetailId === msgId) { silentClearBoardParam('bout'); setShowAllOutboxRecipients(false); }
    if (inboxDetailId === msgId) silentClearBoardParam('bin');
    setNoticeActionBanner('deleted');
    setTimeout(() => setNoticeActionBanner(null), 3000);
  };

  const archiveOutboxMsg = async (msgId: string) => {
    await supabase.from('board_messages').update({ outbox_hidden: true }).eq('id', msgId);
    const msg = outboxMessages.find(m => m.id === msgId);
    setOutboxMessages(prev => prev.filter(m => m.id !== msgId));
    if (msg) setOutboxArchivedMessages(prev => [{ ...msg, outbox_hidden: true }, ...prev]);
    setOutboxArchiveConfirmId(null);
    if (outboxDetailId === msgId) { silentClearBoardParam('bout'); setShowAllOutboxRecipients(false); }
  };

  // チャンネル作成（トークン更新直後の403は1回だけセッション再取得してリトライ）
  const insertBoardChannel = async (payload: { type: 'dm' | 'group' | 'sent_mail'; created_by: string }) => {
    let { data, error } = await supabase.from('board_channels').insert(payload).select().single();
    if (error) {
      await supabase.auth.refreshSession();
      ({ data, error } = await supabase.from('board_channels').insert(payload).select().single());
    }
    return { data, error };
  };

  const startDM = async (targetId: string) => {
    if (!user) return;
    // 既存DMを探す
    for (const ch of channels.filter(c => c.type === 'dm')) {
      const mems = members.filter(m => m.channel_id === ch.id);
      if (mems.some(m => m.user_id === targetId) && mems.some(m => m.user_id === user.id)) {
        selectChannel(ch.id); setShowDMSearch(false); return;
      }
    }
    setDmError('');
    setDmCreating(true);
    const { data: ch } = await insertBoardChannel({ type: 'dm', created_by: user.id });
    if (ch) {
      await supabase.from('board_channel_members').insert([
        { channel_id: ch.id, user_id: user.id },
        { channel_id: ch.id, user_id: targetId },
      ]);
      await loadAll();
      selectChannel(ch.id);
      setShowDMSearch(false); setDmQuery('');
    } else {
      setDmError('DMの作成に失敗しました。もう一度お試しください（直らない場合はページを再読み込みしてください）');
    }
    setDmCreating(false);
  };

  const sendBroadcast = async () => {
    if (!user || dmSelectedIds.length === 0 || !broadcastMessage.trim()) return;
    setSending(true);

    // 送信メールチャンネルを取得or作成
    let sentMailCh = channels.find(c => c.type === 'sent_mail' && c.created_by === user.id);
    if (!sentMailCh) {
      const { data: newCh } = await insertBoardChannel({ type: 'sent_mail', created_by: user.id });
      if (newCh) {
        await supabase.from('board_channel_members').insert({ channel_id: newCh.id, user_id: user.id });
        sentMailCh = newCh as Channel;
      }
    }

    // 各受信者に個別DMを送信
    for (const targetId of dmSelectedIds) {
      let dmCh = channels.find(c => {
        if (c.type !== 'dm') return false;
        const mems = members.filter(m => m.channel_id === c.id);
        return mems.some(m => m.user_id === targetId) && mems.some(m => m.user_id === user.id);
      });
      if (!dmCh) {
        const { data: newDm } = await insertBoardChannel({ type: 'dm', created_by: user.id });
        if (newDm) {
          await supabase.from('board_channel_members').insert([
            { channel_id: newDm.id, user_id: user.id },
            { channel_id: newDm.id, user_id: targetId },
          ]);
          dmCh = newDm as Channel;
        }
      }
      if (dmCh) {
        const { data: dmMsg } = await supabase.from('board_messages').insert({ channel_id: dmCh.id, user_id: user.id, body: broadcastMessage.trim() }).select('id').single();
        await insertNotification(targetId, `${profileName || '誰か'}からメッセージが届きました`, broadcastMessage.trim().slice(0, 40), undefined, dmMsg?.id, 'board:dm_message');
      }
    }

    // 送信メールチャンネルに記録
    if (sentMailCh) {
      const recipients = dmSelectedIds.map(id => {
        const p = allProfiles.find(ap => ap.id === id);
        return { id, name: p?.name || '?' };
      });
      await supabase.from('board_messages').insert({
        channel_id: sentMailCh.id,
        user_id: user.id,
        body: broadcastMessage.trim(),
        broadcast_recipients: recipients,
      });
    }

    await loadAll();
    setSending(false);
    setShowDMSearch(false);
    setDmSelectedIds([]);
    setBroadcastMessage('');
    setDmQuery('');
  };

  const createGroup = async () => {
    if (!groupName.trim() || groupMemberIds.length === 0 || !user) return;
    const { data: ch } = await supabase
      .from('board_channels')
      .insert({ type: 'group', name: groupName.trim(), created_by: user.id })
      .select().single();
    if (ch) {
      const mems = [...new Set([...groupMemberIds, user.id])].map(uid => ({ channel_id: ch.id, user_id: uid }));
      await supabase.from('board_channel_members').insert(mems);
      await loadAll();
      selectChannel(ch.id);
    }
    setShowGroupModal(false); setGroupName(''); setGroupMemberIds([]);
  };

  const openMemberModal = () => {
    setPendingMemberIds(currentMembers.map(m => m.user_id));
    setShowMemberModal(true);
  };

  const resetCompose = () => {
    setComposeSubject(''); setComposeBody(''); setComposeRecipientIds([]);
    setComposeDeadlineType(''); setComposeDeadline(''); setComposeScheduledAt('');
    setComposeOptions(true); setComposeDraftId(null); setComposeQuery('');
    setComposeAnswerPrompt(''); setComposeAnswerLocation(''); setComposeAnswerLink('');
    clearDraft(DRAFT_KEYS.boardCompose); // 送信成功・🗑クリアで下書きを消す
  };

  // 作成画面を開く。書きかけの下書きがあれば消さずに保持したまま開く（別アプリ移動対策）。
  // 無ければ初期化して開く。
  const openCompose = () => {
    if (!loadDraft(DRAFT_KEYS.boardCompose)) resetCompose();
    else { setComposeOptions(true); setComposeQuery(''); setComposeDraftId(null); }
    setView('compose'); setShowSidebar(false);
  };

  const sendNotice = async () => {
    if (!user || composeRecipientIds.length === 0 || !composeBody.trim() || !composeSubject.trim()) return;
    setSending(true);
    const isScheduled = !!composeScheduledAt;
    const insertData: Record<string, unknown> = {
      user_id: user.id,
      body: composeBody.trim(),
      status: isScheduled ? 'scheduled' : 'sent',
    };
    if (!isScheduled) insertData.sent_at = new Date().toISOString();
    if (composeSubject.trim())         insertData.subject         = composeSubject.trim();
    if (composeDeadlineType)           { insertData.deadline_type = composeDeadlineType; insertData.requires_confirmation = true; }
    if (composeDeadline)               insertData.deadline        = composeDeadline;
    if (composeScheduledAt)            insertData.scheduled_at    = new Date(composeScheduledAt).toISOString();
    if (composeAnswerPrompt.trim())    insertData.answer_prompt   = composeAnswerPrompt.trim();
    if (composeAnswerLocation.trim())  insertData.answer_location = composeAnswerLocation.trim();
    if (composeAnswerLink.trim())      insertData.answer_link     = composeAnswerLink.trim();

    const { data, error } = await supabase.from('board_messages').insert(insertData).select('id').single();
    if (!error && data) {
      // CC: 受信トレイには入らず送信トレイ（cc_user_ids）にのみ追加
      const ccIds = composeIncludeCC
        ? noticeCCUserIds.filter(uid => uid !== user.id && !composeRecipientIds.includes(uid))
        : [];
      if (ccIds.length > 0) {
        await supabase.from('board_messages').update({ cc_user_ids: ccIds }).eq('id', data.id);
      }
      const recs = composeRecipientIds.map(uid => ({ message_id: data.id, user_id: uid }));
      await supabase.from('board_message_recipients').insert(recs);

      if (!isScheduled) {
        const senderName = profileName || '誰か';
        const preview = (composeSubject.trim() || composeBody.trim()).slice(0, 40);
        const recipientIds = composeRecipientIds.filter(uid => uid !== user.id);
        await Promise.all(recipientIds.map(uid =>
          insertNotification(uid, `${senderName}からお知らせが届きました`, preview, undefined, data.id, 'board:notice')
        ));
        dispatchBoardEmail('board:notice', {
          '送信者名': senderName,
          '件名': composeSubject.trim(),
          'リンク': `${BOARD_LINK}?openInboxId=${data.id}`,
        }, recipientIds);
      }

      resetCompose();
      await loadOutbox();
      setView('outbox');
      setShowSidebar(false);
    } else {
      setSendError('送信に失敗しました。' + (error?.message || '不明なエラー'));
      setTimeout(() => setSendError(null), 4000);
    }
    setSending(false);
  };

  const deleteChannel = (chId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmDialog({ message: 'このチャンネルを削除しますか？\nメッセージもすべて削除されます。', onConfirm: async () => {
      await supabase.from('board_channel_members').delete().eq('channel_id', chId);
      await supabase.from('board_messages').delete().eq('channel_id', chId);
      await supabase.from('board_channels').delete().eq('id', chId);
      if (selectedChannelId === chId) { silentClearBoardParam('bch'); setShowChannelList(true); }
      await loadAll();
    } });
  };

  const saveMemberChanges = async () => {
    if (!selectedChannelId) return;
    setMemberSaving(true);
    const currentIds = currentMembers.map(m => m.user_id);
    const toAdd    = pendingMemberIds.filter(id => !currentIds.includes(id));
    const toRemove = currentIds.filter(id => !pendingMemberIds.includes(id) && id !== user?.id);
    if (toAdd.length > 0)
      await supabase.from('board_channel_members').insert(toAdd.map(uid => ({ channel_id: selectedChannelId, user_id: uid })));
    for (const uid of toRemove)
      await supabase.from('board_channel_members').delete().eq('channel_id', selectedChannelId).eq('user_id', uid);
    await loadAll();
    setMemberSaving(false);
    setMemberBanner(true);
    setTimeout(() => setMemberBanner(false), 3000);
    setShowMemberModal(false);
  };

  // ── Message render ───────────────────────────────────────────────

  const renderMsg = (msg: BoardMessage, isReply = false, isOutboxView = false) => {
    const isOwn = msg.user_id === user?.id;
    const canEdit = isOwn || isAdmin;
    const replies = isReply ? [] : threadReplies(msg.id);
    const replyCount = replies.length;

    const readCount = readCounts[msg.id] || 0;
    const senderName = allProfiles.find(p => p.id === msg.user_id)?.name || msg.profile?.name || '不明';
    const confirmedIdsTop = (confirmations[msg.id] || []).map(c => c.user_id);
    const isConfirmable = (msg.deadline_type || msg.requires_confirmation) && !msg.parent_id;
    const alreadyConfirmedTop = isConfirmable && confirmedIdsTop.includes(user?.id ?? '');

    return (
      <div key={msg.id} style={{ marginBottom: isReply ? 4 : 14 }}>
        <div style={{
          background: cardBg, borderRadius: isReply ? 6 : 10,
          padding: isReply ? '6px 10px' : '10px 14px',
          border: alreadyConfirmedTop ? '1.5px solid #22c55e' : `1px solid ${border}`,
          marginLeft: isReply ? 36 : 0,
        }}>
          {/* Header row */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ width: 28, height: 28, borderRadius: '50%', background: isReply ? '#28a745' : '#4a90d9', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 12, fontWeight: 'bold', flexShrink: 0 }}>
                {avatarLetter(senderName)}
              </div>
              <span style={{ fontSize: 13, fontWeight: 'bold', color: textColor }}>{senderName}</span>
              {isOutboxView && msg.scheduled_at ? (
                <span style={{ fontSize: 11, color: subColor }}>
                  予約作成 {fmtFull(msg.created_at)}
                  {msg.sent_at
                    ? <> → 送信済 {fmtFull(msg.sent_at)}</>
                    : <span style={{ color: '#3b82f6' }}> → {fmtFull(msg.scheduled_at)}に送信予定</span>}
                </span>
              ) : (
                <span style={{ fontSize: 11, color: subColor }}>{fmtFull(msg.sent_at || msg.created_at)}</span>
              )}
              {msg.edited_at && <span style={{ fontSize: 10, color: subColor }}>(編集済み)</span>}
            </div>
            <div style={{ display: 'flex', gap: 2, alignItems: 'center' }}>
              <button type="button" onClick={e => toggleFavMessage(e, msg.id, msg)}
                title={favMessageIds.has(msg.id) ? 'お気に入り解除' : 'お気に入りに追加'}
                style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, padding: '2px 3px', color: favMessageIds.has(msg.id) ? '#f59e0b' : (isDark ? '#888' : '#bbb') }}>
                {favMessageIds.has(msg.id) ? '★' : '☆'}
              </button>
              {canEdit && msg.channel_id && (
                <button type="button" onClick={() => setChannelDeleteConfirmId(channelDeleteConfirmId === msg.id ? null : msg.id)} title="削除" style={{ background: 'none', border: 'none', color: '#dc3545', cursor: 'pointer', fontSize: 13, padding: '2px 4px' }}>🗑️</button>
              )}
            </div>
          </div>

          {/* 種別ラベル＋期限バッジ */}
          {msg.deadline_type && !msg.parent_id && (() => {
            const today = todayJstStr();
            const isOverdue = msg.deadline ? msg.deadline < today : false;
            const isToday = msg.deadline ? msg.deadline === today : false;
            const badgeMemberIds = msg.channel_id
              ? members.filter(m => m.channel_id === msg.channel_id).map(m => m.user_id)
              : (inboxRecipients[msg.id] || []);
            const allRecipientsConfirmed = badgeMemberIds.length > 0 && badgeMemberIds.every(id => confirmedIdsTop.includes(id));
            const isConfirmedByMe = confirmedIdsTop.includes(user?.id || '') || (isOwn && allRecipientsConfirmed);
            const dtConfig = DEADLINE_TYPES.find(d => d.value === msg.deadline_type);
            const typeText = dtConfig ? dtConfig.label.replace(/^\S+\s/, '') : '確認';
            const accentColor = !isConfirmedByMe && isOverdue ? '#dc2626' : isToday ? '#d97706' : '#1d4ed8';
            const dateLabel = msg.deadline ? (() => {
              const [y, m, d] = msg.deadline.split('-');
              return `${y}/${parseInt(m)}/${parseInt(d)}まで`;
            })() : '';
            const badgeLeftText = isOverdue ? '期限切れ' : isToday ? '本日締切' : '期限';
            return (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: (msg.title || msg.subject) ? 6 : 8, paddingBottom: (msg.title || msg.subject) ? 6 : 8, borderBottom: (msg.title || msg.subject) ? 'none' : `1px solid ${border}` }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 0, flexShrink: 0 }}>
                    <div style={{ width: 3, height: 22, background: accentColor, borderRadius: 2, marginRight: 8, flexShrink: 0 }} />
                    <span style={{ fontSize: 17, fontWeight: 700, color: textColor }}>{typeText === '確認' ? typeText : `${typeText}確認`}</span>
                  </div>
                  {msg.deadline && (
                    isConfirmedByMe && isOverdue ? (
                      <span style={{ fontSize: 12, color: subColor }}>{dateLabel}</span>
                    ) : (
                      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 0, borderRadius: 20, overflow: 'hidden', border: `1.5px solid ${accentColor}` }}>
                        <span style={{ fontSize: 12, fontWeight: 700, color: '#fff', background: accentColor, padding: '2px 9px' }}>{badgeLeftText}</span>
                        <span style={{ fontSize: 11, color: accentColor, padding: '2px 9px' }}>{dateLabel}</span>
                      </div>
                    )
                  )}
                </div>
              </div>
            );
          })()}
          {/* 件名（種別バッジの下・本文の上） */}
          {(msg.title || msg.subject) && !msg.parent_id && (
            <div style={{ fontSize: 16, fontWeight: 700, color: textColor, marginBottom: 8, paddingBottom: 8, borderBottom: `1px solid ${border}`, textAlign: 'left' }}>{msg.title || msg.subject}</div>
          )}
          {/* Body / Edit field */}
          {/* 回答タイプの質問内容・場所 */}
          {msg.deadline_type && !msg.parent_id && (msg.answer_prompt || msg.answer_location || msg.answer_link) && (
            <div style={{ margin: '6px 0 4px', padding: '8px 12px', background: isDark ? '#1e2a3a' : '#eff6ff', borderRadius: 8, borderLeft: `3px solid ${isDark ? '#3b82f6' : '#3b82f6'}` }}>
              {msg.answer_prompt && (
                <div style={{ display: 'flex', gap: 8, fontSize: 13, color: textColor, marginBottom: msg.answer_location || msg.answer_link ? 4 : 0 }}>
                  <span style={{ color: isDark ? '#93c5fd' : '#3b82f6', flexShrink: 0, minWidth: 36, fontSize: 12 }}>内容</span>
                  <span>{msg.answer_prompt}</span>
                </div>
              )}
              {msg.answer_location && (
                <div style={{ display: 'flex', gap: 8, fontSize: 13, color: textColor, marginBottom: msg.answer_link ? 4 : 0 }}>
                  <span style={{ color: isDark ? '#93c5fd' : '#3b82f6', flexShrink: 0, minWidth: 36, fontSize: 12 }}>保存先</span>
                  <span>{msg.answer_location}</span>
                </div>
              )}
              {msg.answer_link && (
                <div style={{ display: 'flex', gap: 8, fontSize: 13 }}>
                  <span style={{ color: isDark ? '#93c5fd' : '#3b82f6', flexShrink: 0, minWidth: 36, fontSize: 12 }}>URL</span>
                  <a href={msg.answer_link} target="_blank" rel="noopener noreferrer" style={{ color: '#2563eb', wordBreak: 'break-all' }}>{msg.answer_link}</a>
                </div>
              )}
            </div>
          )}
          {/* 回答一覧（回答タイプで送信済みのもの）：受信者は自分の回答のみ、送信者(送信トレイ)は全員分 */}
          {msg.deadline_type && !msg.parent_id && (() => {
            const allAnswers = (confirmations[msg.id] || []).filter(c => c.comment);
            const answers = isOutboxView ? allAnswers : allAnswers.filter(c => c.user_id === user?.id);
            if (answers.length === 0) return null;
            return (
              <div style={{ margin: '6px 0 8px', padding: '8px 10px', background: isDark ? '#1a3a28' : '#f0fdf4', borderRadius: 8, border: `1px solid ${isDark ? '#16532a' : '#86efac'}` }}>
                <div style={{ fontSize: 11, fontWeight: 'bold', color: '#166534', marginBottom: 4 }}>📝 回答</div>
                {answers.map(c => {
                  const name = allProfiles.find(p => p.id === c.user_id)?.name || '不明';
                  return (
                    <div key={c.user_id} style={{ fontSize: 13, color: textColor, padding: '4px 0', borderBottom: `1px solid ${isDark ? '#16532a' : '#bbf7d0'}` }}>
                      <div>
                        <span style={{ fontWeight: 500, color: '#166534' }}>{name}：</span>{c.comment}
                      </div>
                      {c.confirmed_at && (
                        <div style={{ fontSize: 10, color: subColor, marginTop: 2 }}>{fmtConfirmDate(c.confirmed_at)}</div>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })()}
          <div style={{ fontSize: 14, color: textColor, whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.5, textAlign: 'left' }}>{msg.body}</div>
          {/* 送信メールチャンネルの宛先表示 */}
          {msg.broadcast_recipients && msg.broadcast_recipients.length > 0 && (
            <div style={{ marginTop: 6, padding: '4px 8px', background: isDark ? '#1e2d1e' : '#f0fdf4', borderRadius: 6, fontSize: 12, color: isDark ? '#86efac' : '#166534' }}>
              宛先: {msg.broadcast_recipients.map(r => r.name).join('、')}
            </div>
          )}

          {/* チャンネルメッセージ削除インライン確認 */}
          {canEdit && msg.channel_id && channelDeleteConfirmId === msg.id && (
            <div style={{ marginTop: 8, padding: '8px 12px', background: isDark ? '#2d1515' : '#fff5f5', border: '1.5px solid #dc3545', borderRadius: 8, display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 13, color: '#dc3545', flex: 1 }}>このメッセージをチャンネル内から削除しますか？</span>
              <button type="button" onClick={() => deleteMessage(msg.id)} style={{ padding: '4px 14px', background: '#dc3545', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>削除</button>
              <button type="button" onClick={() => setChannelDeleteConfirmId(null)} style={{ padding: '4px 10px', background: 'none', border: `1px solid ${border}`, color: subColor, borderRadius: 6, cursor: 'pointer', fontSize: 13 }}>✕</button>
            </div>
          )}

          {/* 確認ボタン（deadline_type / requires_confirmation ありの親投稿） */}
          {(msg.deadline_type || msg.requires_confirmation) && !msg.parent_id && (() => {
            const confirmedObjs = confirmations[msg.id] || [];
            const confirmedIds = confirmedObjs.map(c => c.user_id);
            const alreadyConfirmed = confirmedIds.includes(user?.id ?? '');
            const myConfirmTime = myConfirmTimes[msg.id] || confirmedObjs.find(c => c.user_id === user?.id)?.confirmed_at;
            const channelMemberIds = msg.channel_id
              ? members.filter(m => m.channel_id === msg.channel_id).map(m => m.user_id)
              : (inboxRecipients[msg.id] || []);
            const unconfirmedIds = channelMemberIds.filter(id => !confirmedIds.includes(id));
            const dtConfig = DEADLINE_TYPES.find(d => d.value === msg.deadline_type);
            const reportLabel = dtConfig ? dtConfig.reportLabel : '確認報告';
            const doneLabel   = dtConfig ? dtConfig.doneLabel   : '確認済み';
            const isAnswerRequired = msg.deadline_type === 'answer';
            return (
              <div style={{ marginTop: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                  {isOutboxView ? (
                    <span />
                  ) : !alreadyConfirmed ? (
                    <button type="button" onClick={() => {
                      setAnswerInputId(answerInputId === msg.id ? null : msg.id);
                      setAnswerText('');
                    }} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 12px', background: cardBg, border: '1.5px solid #22c55e', borderRadius: 20, cursor: 'pointer', fontSize: 13, fontWeight: 500, color: '#166534' }}>
                      <span style={{ fontSize: 15, lineHeight: 1 }}>○</span> {reportLabel}
                    </button>
                  ) : (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 12px', background: '#22c55e', border: '1.5px solid #22c55e', borderRadius: 20, fontSize: 13, fontWeight: 500, color: '#fff' }}>
                      <span style={{ fontSize: 15, lineHeight: 1 }}>✓</span> {doneLabel}（{myConfirmTime ? fmtConfirmDate(myConfirmTime) : '済み'}）
                    </span>
                  )}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 12, color: subColor }}>{confirmedIds.length}人/{channelMemberIds.length}人</span>
                    {isAdmin && unconfirmedIds.length > 0 && (
                      <button type="button" onClick={() => setUnconfirmedMsgId(msg.id)}
                        style={{ padding: '4px 12px', background: 'none', color: '#f59e0b', border: '1.5px solid #f59e0b', borderRadius: 20, cursor: 'pointer', fontSize: 12, fontWeight: 500 }}>
                        リマインド送信
                      </button>
                    )}
                  </div>
                </div>
                {/* 入力欄（全種別・回答のみ必須） */}
                {answerInputId === msg.id && !alreadyConfirmed && (
                  <div style={{ marginTop: 8, display: 'flex', gap: 6 }}>
                    <textarea
                      value={answerText}
                      onChange={e => setAnswerText(e.target.value)}
                      placeholder={isAnswerRequired ? '回答内容を入力（必須）...' : 'コメントを入力（任意）...'}
                      rows={2}
                      autoFocus
                      ref={el => { if (el) { el.focus(); el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } }}
                      style={{ flex: 1, padding: '6px 10px', borderRadius: 8, border: `1px solid ${isAnswerRequired && !answerText.trim() ? '#ef4444' : border}`, background: inputBg, color: textColor, fontSize: 13, resize: 'none', fontFamily: 'inherit', lineHeight: 1.4 }}
                    />
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <button type="button" disabled={isAnswerRequired && !answerText.trim()} onClick={async () => {
                        if (!user) return;
                        if (isAnswerRequired && !answerText.trim()) return;
                        const now = new Date().toISOString();
                        await supabase.from('board_confirmations').upsert(
                          { message_id: msg.id, user_id: user.id, comment: answerText.trim() || null },
                          { onConflict: 'message_id,user_id' }
                        );
                        setConfirmations(prev => ({ ...prev, [msg.id]: [...(prev[msg.id] || []).filter(c => c.user_id !== user.id), { user_id: user.id, comment: answerText.trim() || null, confirmed_at: now }] }));
                        setMyConfirmTimes(prev => ({ ...prev, [msg.id]: now }));
                        setAnswerInputId(null);
                        setAnswerText('');
                      }} style={{ padding: '6px 10px', background: '#22c55e', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 500, opacity: isAnswerRequired && !answerText.trim() ? 0.5 : 1 }}>
                        {isAnswerRequired ? '回答して完了' : '完了'}
                      </button>
                      <button type="button" onClick={() => { setAnswerInputId(null); setAnswerText(''); }}
                        style={{ padding: '6px 10px', background: 'none', border: `1px solid ${border}`, borderRadius: 6, color: subColor, cursor: 'pointer', fontSize: 12 }}>
                        キャンセル
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })()}

          {/* Footer (parent only) */}
          {!isReply && (
            <div style={{ marginTop: 6 }}>
              {/* 最新リプライのプレビュー（チャンネル/DMのみ。お知らせには出さない） */}
              {!!msg.channel_id && replyCount > 0 && (() => {
                const latestReply = replies[replies.length - 1];
                const replierName = allProfiles.find(p => p.id === latestReply.user_id)?.name || '不明';
                const myLastSeen = lastSeen[msg.channel_id ?? ''] || '';
                const unreadReplies = replies.filter(r => r.user_id !== user?.id && r.created_at > myLastSeen).length;
                return (
                  <button type="button" onClick={() => setThreadMsgId(msg.id)}
                    style={{ width: '100%', background: isDark ? '#1e2328' : '#f0f4ff', border: `1px solid ${isDark ? '#3d4349' : '#c7d4f5'}`, borderRadius: 8, padding: '6px 10px', cursor: 'pointer', textAlign: 'left', marginBottom: 6 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                      <span style={{ fontSize: 11, fontWeight: 'bold', color: isDark ? '#90b4e8' : '#3b5bdb' }}>💬 {replierName}</span>
                      <span style={{ fontSize: 10, color: subColor }}>{fmtFull(latestReply.created_at)}</span>
                      <span style={{ fontSize: 10, color: subColor, marginLeft: 'auto' }}>リプライ {replyCount}件{unreadReplies > 0 ? `（未読${unreadReplies}）` : ''}</span>
                    </div>
                    <div style={{ fontSize: 12, color: textColor, whiteSpace: 'pre-wrap', wordBreak: 'break-word', overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
                      {latestReply.body}
                    </div>
                  </button>
                );
              })()}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
              <button type="button" onClick={() => setThreadMsgId(msg.id)}
                style={{ background: 'none', border: 'none', color: '#4a90d9', cursor: 'pointer', fontSize: 12, padding: 0 }}>
                {msg.channel_id && replyCount === 0 ? '💬 リプライ' : null}
              </button>
              {(() => {
                const chMemberCount = msg.channel_id
                  ? members.filter(m => m.channel_id === msg.channel_id).length
                  : (inboxRecipients[msg.id] || []).length;
                const unreadCount = Math.max(0, chMemberCount - readCount);
                const label = (
                  <span style={{ fontSize: 11, color: subColor }}>
                    既読{readCount} 未読{unreadCount}
                  </span>
                );
                const rdSetting = selectedChannel?.show_read_detail ?? 'all';
                const canSeeReadDetail =
                  rdSetting === 'all' ||
                  (rdSetting === 'permitted' && canSendInChannel(selectedChannelId ?? ''));
                return (canSeeReadDetail) ? (
                  <button type="button" onClick={async () => {
                    const { data } = await supabase.from('board_reads').select('user_id, read_at').eq('message_id', msg.id);
                    setReadDetailUsers((data || []).map((r: any) => ({ user_id: r.user_id, read_at: r.read_at })));
                    setReadDetailMsgId(msg.id);
                  }} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, padding: 0, textDecoration: 'underline dotted', textUnderlineOffset: 2, color: subColor }}>
                    {label}
                  </button>
                ) : label;
              })()}
              </div>
            </div>
          )}
        </div>

      </div>
    );
  };

  // ── Modals ───────────────────────────────────────────────────────

  const overlayStyle: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 };
  const modalStyle: React.CSSProperties = { background: cardBg, borderRadius: 12, padding: 24, width: '90%', maxWidth: 440, maxHeight: '80vh', overflowY: 'auto' };

  // ── Thread Panel ─────────────────────────────────────────────────
  const threadPanel = threadMsgId ? (() => {
    const parentMsg = messages.find(m => m.id === threadMsgId);
    if (!parentMsg) return null;
    const threadRepliesList = messages.filter(m => m.parent_id === threadMsgId)
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    const parentSender = allProfiles.find(p => p.id === parentMsg.user_id)?.name || '不明';
    return (
      <div style={{ position: 'fixed', top: 'var(--topbar-height, 60px)' as string, left: 0, right: 0, bottom: 0, zIndex: 200, background: bg, display: 'flex', flexDirection: 'column' }}>
        {/* Thread header */}
        <div style={{ padding: '10px 14px', borderBottom: `1px solid ${border}`, background: cardBg, display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0, position: 'sticky', top: 0, zIndex: 10 }}>
          <button type="button" onClick={() => { navigate(-1); setReplyBody(''); }}
            style={{ background: 'none', border: 'none', color: '#4a90d9', cursor: 'pointer', fontSize: 22, padding: '0 6px', fontWeight: 'bold' }}>←</button>
          <span style={{ fontSize: 15, fontWeight: 'bold', color: textColor }}>スレッド</span>
        </div>
        {/* Scrollable area */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px 14px' }}>
          {/* Parent message */}
          <div style={{ background: isDark ? '#2a2a3e' : '#f0f4ff', border: `1px solid ${isDark ? '#3a3a6c' : '#c7d4f5'}`, borderRadius: 10, padding: '10px 14px', marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <div style={{ width: 28, height: 28, borderRadius: '50%', background: '#4a90d9', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 12, fontWeight: 'bold', flexShrink: 0 }}>
                {avatarLetter(parentSender)}
              </div>
              <span style={{ fontSize: 13, fontWeight: 'bold', color: textColor }}>{parentSender}</span>
              <span style={{ fontSize: 11, color: subColor }}>{fmtFull(parentMsg.created_at)}</span>
            </div>
            {parentMsg.deadline_type && (
              <div style={{ fontSize: 12, color: isDark ? '#93c5fd' : '#3b82f6', marginBottom: 4 }}>
                {DEADLINE_TYPES.find(d => d.value === parentMsg.deadline_type)?.label}
              </div>
            )}
            <div style={{ fontSize: 14, color: textColor, whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.5, textAlign: 'left' }}>{parentMsg.body}</div>
          </div>
          {/* Replies */}
          {threadRepliesList.length === 0 && (
            <div style={{ textAlign: 'center', color: subColor, fontSize: 13, marginTop: 20 }}>まだリプライはありません</div>
          )}
          {threadRepliesList.map(r => {
            const rSender = allProfiles.find(p => p.id === r.user_id)?.name || '不明';
            return (
              <div key={r.id} style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
                <div style={{ width: 32, height: 32, borderRadius: '50%', background: '#28a745', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 13, fontWeight: 'bold', flexShrink: 0 }}>
                  {avatarLetter(rSender)}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
                    <span style={{ fontSize: 13, fontWeight: 'bold', color: textColor }}>{rSender}</span>
                    <span style={{ fontSize: 11, color: subColor }}>{fmtFull(r.created_at)}</span>
                  </div>
                  <div style={{ fontSize: 14, color: textColor, whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.5, background: cardBg, border: `1px solid ${border}`, borderRadius: 8, padding: '8px 12px', textAlign: 'left' }}>{r.body}</div>
                  {(() => {
                    const chMembers = members.filter(m => m.channel_id === selectedChannelId);
                    const readN = readCounts[r.id] || 0;
                    const unreadN = Math.max(0, chMembers.length - readN);
                    return (
                      <div style={{ display: 'flex', gap: 8, marginTop: 4, fontSize: 11, color: subColor, justifyContent: 'flex-end' }}>
                        <span>既読{readN}</span>
                        <span>未読{unreadN}</span>
                      </div>
                    );
                  })()}
                </div>
              </div>
            );
          })}
          <div ref={messagesEndRef} />
        </div>
        {/* Fixed input */}
        <div style={{ padding: '10px 14px', borderTop: `1px solid ${border}`, background: cardBg, flexShrink: 0 }}>
          {!canSendInChannel(selectedChannelId!) ? (
            <div style={{ textAlign: 'center', color: subColor, fontSize: 13, padding: '8px 0' }}>
              このチャンネルへの送信権限がありません
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 8 }}>
              <textarea
                value={replyBody}
                onChange={e => setReplyBody(e.target.value)}
                placeholder="リプライを入力... (Ctrl+Enterで送信)"
                rows={2}
                onKeyDown={e => { if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); if (replyBody.trim()) setShowReplySendConfirm(true); } }}
                style={{ flex: 1, padding: '8px 10px', borderRadius: 8, border: `1px solid ${border}`, background: inputBg, color: textColor, fontSize: 13, resize: 'none', fontFamily: 'inherit' }}
              />
              <button type="button" onClick={() => { if (replyBody.trim()) setShowReplySendConfirm(true); }} disabled={sending || !replyBody.trim()}
                style={{ padding: '8px 14px', background: '#28a745', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 500, opacity: sending || !replyBody.trim() ? 0.5 : 1, alignSelf: 'flex-end' }}>
                送信
              </button>
            </div>
          )}
        </div>
      </div>
    );
  })() : null;

  // グループ作成モーダル用: 雇用形態→役職でグループ化
  const EMP_ORDER = ['正社員', 'パート'];
  const ROLE_ORDER = ['管理者', '社長', 'マネージャー', 'リーダー', '一般', 'その他'];
  const activeOthers = allProfiles.filter(p => p.id !== user?.id);
  const empTypes = ([...new Set(activeOthers.map(p => p.employment_type || 'その他'))] as string[])
    .sort((a, b) => {
      const ai = EMP_ORDER.indexOf(a), bi = EMP_ORDER.indexOf(b);
      if (ai === -1 && bi === -1) return a > b ? 1 : -1;
      if (ai === -1) return 1; if (bi === -1) return -1;
      return ai - bi;
    });

  const groupModal = showGroupModal ? (
    <div style={overlayStyle}>
      <div style={{ ...modalStyle, maxWidth: 520 }}>
        <div style={{ fontSize: 16, fontWeight: 'bold', color: textColor, marginBottom: 14 }}>グループを作成</div>
        <input
          value={groupName}
          onChange={e => setGroupName(e.target.value)}
          placeholder="グループ名（例: リーダー連絡、西陣校チームなど）"
          style={{ width: '100%', padding: '8px 12px', borderRadius: 6, border: `1px solid ${border}`, background: inputBg, color: textColor, fontSize: 14, marginBottom: 12, boxSizing: 'border-box' }}
        />

        {/* 雇用形態一括ボタン */}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
          {empTypes.map(et => {
            const ids = activeOthers.filter(p => (p.employment_type || 'その他') === et).map(p => p.id);
            const allSel = ids.every(id => groupMemberIds.includes(id));
            return (
              <button key={et} type="button" onClick={() => {
                setGroupMemberIds(prev => allSel ? prev.filter(id => !ids.includes(id)) : [...new Set([...prev, ...ids])]);
              }} style={{ padding: '4px 10px', borderRadius: 12, border: 'none', cursor: 'pointer', fontSize: 12, background: allSel ? '#007bff' : (isDark ? '#495057' : '#e9ecef'), color: allSel ? '#fff' : (isDark ? '#fff' : '#333') }}>
                {et}を一括選択
              </button>
            );
          })}
          <button type="button" onClick={() => setGroupMemberIds(activeOthers.map(p => p.id))}
            style={{ padding: '4px 10px', borderRadius: 12, border: 'none', cursor: 'pointer', fontSize: 12, background: isDark ? '#495057' : '#e9ecef', color: isDark ? '#fff' : '#333' }}>全員</button>
          <button type="button" onClick={() => setGroupMemberIds([])}
            style={{ padding: '4px 10px', borderRadius: 12, border: 'none', cursor: 'pointer', fontSize: 12, background: isDark ? '#495057' : '#e9ecef', color: isDark ? '#fff' : '#333' }}>全解除</button>
        </div>

        {/* 雇用形態→役職別グリッド */}
        <div style={{ maxHeight: 320, overflowY: 'auto', border: `1px solid ${border}`, borderRadius: 8 }}>
          {empTypes.map((et, gi) => {
            const etProfiles = activeOthers.filter(p => (p.employment_type || 'その他') === et);
            const roles = [...new Set(etProfiles.map(p => p.role_title || 'その他'))].sort();
            return (
              <div key={et}>
                {/* 雇用形態ヘッダー */}
                <div style={{ padding: '5px 10px', background: isDark ? '#2d3136' : '#e9ecef', borderTop: gi > 0 ? `2px solid ${isDark ? '#6c757d' : '#bbb'}` : undefined, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 12, fontWeight: 'bold', color: isDark ? '#adb5bd' : '#444' }}>{et}</span>
                  <span style={{ fontSize: 11, color: isDark ? '#6c757d' : '#999' }}>{etProfiles.filter(p => groupMemberIds.includes(p.id)).length}/{etProfiles.length}</span>
                </div>
                {/* 役職別横並び */}
                <div style={{ display: 'flex', flexWrap: 'wrap', borderBottom: `1px solid ${isDark ? '#3d4349' : '#e0e0e0'}` }}>
                  {roles.map((role, ri) => {
                    const roleProfiles = etProfiles.filter(p => (p.role_title || 'その他') === role).sort((a, b) => (a.name || '') > (b.name || '') ? 1 : -1);
                    const allRoleSel = roleProfiles.every(p => groupMemberIds.includes(p.id));
                    return (
                      <div key={role} style={{ flex: '1 1 140px', borderLeft: ri > 0 ? `1px solid ${isDark ? '#3d4349' : '#e0e0e0'}` : undefined, padding: '6px 8px' }}>
                        <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, marginBottom: 4, paddingBottom: 3, borderBottom: `1px solid ${isDark ? '#3d4349' : '#eee'}`, cursor: 'pointer' }}>
                          <input type="checkbox" checked={allRoleSel && roleProfiles.length > 0}
                            onChange={() => {
                              const ids = roleProfiles.map(p => p.id);
                              setGroupMemberIds(prev => allRoleSel ? prev.filter(id => !ids.includes(id)) : [...new Set([...prev, ...ids])]);
                            }} />
                          <span style={{ fontSize: 10, fontWeight: 'bold', color: isDark ? '#adb5bd' : '#555' }}>{role}</span>
                        </label>
                        {roleProfiles.map(p => (
                          <label key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0', cursor: 'pointer', fontSize: 12, color: textColor }}>
                            <input type="checkbox" checked={groupMemberIds.includes(p.id)}
                              onChange={e => setGroupMemberIds(prev => e.target.checked ? [...prev, p.id] : prev.filter(id => id !== p.id))} />
                            <span>{p.name}</span>
                          </label>
                        ))}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
        <p style={{ fontSize: 12, color: subColor, marginTop: 4 }}>{groupMemberIds.length}人選択中</p>

        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <button type="button" onClick={() => { setShowGroupModal(false); setGroupName(''); setGroupMemberIds([]); }}
            style={{ flex: 1, padding: 10, background: '#6c757d', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 14 }}>キャンセル</button>
          <button type="button" onClick={createGroup} disabled={!groupName.trim() || groupMemberIds.length === 0}
            style={{ flex: 1, padding: 10, background: '#007bff', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 14, opacity: !groupName.trim() || groupMemberIds.length === 0 ? 0.5 : 1 }}>
            作成（{groupMemberIds.length}人）
          </button>
        </div>
      </div>
    </div>
  ) : null;

  const memberModal = showMemberModal && selectedChannel ? (() => {
    const isGroup = selectedChannel.type === 'group';
    const others = allProfiles.filter(p => p.id !== user?.id);
    const empTypes = ([...new Set(others.map(p => p.employment_type || 'その他'))] as string[])
      .sort((a, b) => { const o = EMP_ORDER; const ai = o.indexOf(a), bi = o.indexOf(b); if (ai === -1 && bi === -1) return a > b ? 1 : -1; if (ai === -1) return 1; if (bi === -1) return -1; return ai - bi; });
    return (
      <div style={overlayStyle}>
        <div style={{ ...modalStyle, maxWidth: 520 }}>
          <div style={{ fontSize: 16, fontWeight: 'bold', color: textColor, marginBottom: 10 }}>
            {isGroup ? `👥 ${channelDisplayName(selectedChannel)}` : 'メンバー'}
          </div>

          {isAdmin && isGroup && pendingMemberIds.length > 0 && (() => {
            const CHIP_LIMIT = 10;
            const visible = chipExpanded ? pendingMemberIds : pendingMemberIds.slice(0, CHIP_LIMIT);
            const hasMore = pendingMemberIds.length > CHIP_LIMIT;
            return (
              <div style={{ marginBottom: 10, padding: '8px 10px', background: isDark ? '#1e2328' : '#f0f4ff', border: `1px solid ${isDark ? '#3d4349' : '#c7d4f5'}`, borderRadius: 8 }}>
                <div style={{ fontSize: 11, fontWeight: 'bold', color: isDark ? '#8fa8e8' : '#3b5bdb', marginBottom: 6 }}>選択中 {pendingMemberIds.length}人</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                  {visible.map(id => {
                    const p = allProfiles.find(ap => ap.id === id);
                    if (!p) return null;
                    const isSelf = id === user?.id;
                    return (
                      <span key={id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 12, fontSize: 12, background: isSelf ? (isDark ? '#2d4a2d' : '#dcfce7') : (isDark ? '#2c3e50' : '#e0e7ff'), color: isSelf ? (isDark ? '#86efac' : '#166534') : textColor, border: `1px solid ${isSelf ? (isDark ? '#4ade80' : '#86efac') : (isDark ? '#4a5568' : '#c7d4f5')}` }}>
                        {p.name}
                        {!isSelf && (
                          <button type="button" onClick={() => setPendingMemberIds(prev => prev.filter(i => i !== id))}
                            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, lineHeight: 1, color: isDark ? '#adb5bd' : '#888', fontSize: 13 }}>✕</button>
                        )}
                      </span>
                    );
                  })}
                  {hasMore && (
                    <button type="button" onClick={() => setChipExpanded(e => !e)}
                      style={{ padding: '2px 10px', borderRadius: 12, fontSize: 12, background: 'none', border: `1px solid ${isDark ? '#4a5568' : '#c7d4f5'}`, color: isDark ? '#8fa8e8' : '#3b5bdb', cursor: 'pointer' }}>
                      {chipExpanded ? '▲ 閉じる' : `▼ あと${pendingMemberIds.length - CHIP_LIMIT}人`}
                    </button>
                  )}
                </div>
              </div>
            );
          })()}

          {isAdmin && isGroup ? (
            <>
              {/* 一括ボタン */}
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                {empTypes.map(et => {
                  const ids = others.filter(p => (p.employment_type || 'その他') === et).map(p => p.id);
                  const allSel = ids.every(id => pendingMemberIds.includes(id));
                  return (
                    <button key={et} type="button" onClick={() => setPendingMemberIds(prev => allSel ? prev.filter(id => !ids.includes(id)) : [...new Set([...prev, ...ids])])}
                      style={{ padding: '4px 10px', borderRadius: 12, border: 'none', cursor: 'pointer', fontSize: 12, background: allSel ? '#007bff' : (isDark ? '#495057' : '#e9ecef'), color: allSel ? '#fff' : (isDark ? '#fff' : '#333') }}>
                      {et}を一括選択
                    </button>
                  );
                })}
                <button type="button" onClick={() => setPendingMemberIds(others.map(p => p.id))}
                  style={{ padding: '4px 10px', borderRadius: 12, border: 'none', cursor: 'pointer', fontSize: 12, background: isDark ? '#495057' : '#e9ecef', color: isDark ? '#fff' : '#333' }}>全員</button>
                <button type="button" onClick={() => setPendingMemberIds(user ? [user.id] : [])}
                  style={{ padding: '4px 10px', borderRadius: 12, border: 'none', cursor: 'pointer', fontSize: 12, background: isDark ? '#495057' : '#e9ecef', color: isDark ? '#fff' : '#333' }}>全解除</button>
              </div>

              {/* 雇用形態→役職グリッド */}
              <div style={{ maxHeight: 340, overflowY: 'auto', border: `1px solid ${border}`, borderRadius: 8, marginBottom: 8 }}>
                {empTypes.map((et, gi) => {
                  const etProfiles = others.filter(p => (p.employment_type || 'その他') === et);
                  const roles = [...new Set(etProfiles.map(p => p.role_title || 'その他'))].sort();
                  return (
                    <div key={et}>
                      <div style={{ padding: '5px 10px', background: isDark ? '#2d3136' : '#e9ecef', borderTop: gi > 0 ? `2px solid ${isDark ? '#6c757d' : '#bbb'}` : undefined, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontSize: 12, fontWeight: 'bold', color: isDark ? '#adb5bd' : '#444' }}>{et}</span>
                        <span style={{ fontSize: 11, color: isDark ? '#6c757d' : '#999' }}>{etProfiles.filter(p => pendingMemberIds.includes(p.id)).length}/{etProfiles.length}</span>
                      </div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', borderBottom: `1px solid ${isDark ? '#3d4349' : '#e0e0e0'}` }}>
                        {roles.map((role, ri) => {
                          const roleProfiles = etProfiles.filter(p => (p.role_title || 'その他') === role).sort((a, b) => (a.name || '') > (b.name || '') ? 1 : -1);
                          const allRoleSel = roleProfiles.every(p => pendingMemberIds.includes(p.id));
                          return (
                            <div key={role} style={{ flex: '1 1 140px', borderLeft: ri > 0 ? `1px solid ${isDark ? '#3d4349' : '#e0e0e0'}` : undefined, padding: '6px 8px' }}>
                              <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, marginBottom: 4, paddingBottom: 3, borderBottom: `1px solid ${isDark ? '#3d4349' : '#eee'}`, cursor: 'pointer' }}>
                                <input type="checkbox" checked={allRoleSel && roleProfiles.length > 0}
                                  onChange={() => { const ids = roleProfiles.map(p => p.id); setPendingMemberIds(prev => allRoleSel ? prev.filter(id => !ids.includes(id)) : [...new Set([...prev, ...ids])]); }} />
                                <span style={{ fontSize: 10, fontWeight: 'bold', color: isDark ? '#adb5bd' : '#555' }}>{role}</span>
                              </label>
                              {roleProfiles.map(p => (
                                <label key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0', cursor: 'pointer', fontSize: 12, color: textColor }}>
                                  <input type="checkbox" checked={pendingMemberIds.includes(p.id)}
                                    onChange={e => setPendingMemberIds(prev => e.target.checked ? [...prev, p.id] : prev.filter(id => id !== p.id))} />
                                  <span>{p.name}</span>
                                </label>
                              ))}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
              <p style={{ fontSize: 12, color: subColor, marginTop: 4 }}>自分は常に含まれます</p>
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <button type="button" onClick={() => setShowMemberModal(false)}
                  style={{ flex: 1, padding: 10, background: '#6c757d', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 14 }}>キャンセル</button>
                <button type="button" onClick={saveMemberChanges} disabled={memberSaving}
                  style={{ flex: 1, padding: 10, background: '#007bff', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 14, opacity: memberSaving ? 0.6 : 1 }}>
                  {memberSaving ? '保存中...' : '保存'}
                </button>
              </div>
            </>
          ) : (
            <>
              <div style={{ fontSize: 13, color: subColor, marginBottom: 8 }}>参加メンバー ({currentMembers.length}人)</div>
              {currentMembers.map(m => {
                const p = allProfiles.find(ap => ap.id === m.user_id);
                return (
                  <div key={m.user_id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', borderBottom: `1px solid ${border}` }}>
                    <div style={{ width: 28, height: 28, borderRadius: '50%', background: '#4a90d9', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 12 }}>{avatarLetter(p?.name)}</div>
                    <span style={{ fontSize: 13, color: textColor }}>{p?.name || '不明'}</span>
                    <span style={{ fontSize: 11, color: subColor }}>{p?.role_title}</span>
                  </div>
                );
              })}
              <button type="button" onClick={() => setShowMemberModal(false)} style={{ width: '100%', marginTop: 16, padding: 10, background: '#6c757d', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 14 }}>閉じる</button>
            </>
          )}
        </div>
      </div>
    );
  })() : null;

  const dmModal = showDMSearch ? (() => {
    const dmEmpTypes = ([...new Set(activeOthers.map(p => p.employment_type || 'その他'))] as string[])
      .sort((a, b) => { const ai = EMP_ORDER.indexOf(a), bi = EMP_ORDER.indexOf(b); if (ai === -1 && bi === -1) return a > b ? 1 : -1; if (ai === -1) return 1; if (bi === -1) return -1; return ai - bi; });
    const filteredProfiles = activeOthers.filter(p => !dmQuery || (p.name || '').includes(dmQuery));
    const isSingle = dmSelectedIds.length === 1;
    const isMulti = dmSelectedIds.length > 1;
    return (
      <div style={overlayStyle}>
        <div style={{ ...modalStyle, maxWidth: 520 }}>
          <div style={{ fontSize: 16, fontWeight: 'bold', color: textColor, marginBottom: 12 }}>
            {isMulti ? '一斉送信' : 'メッセージを送る'}
          </div>
          <input
            value={dmQuery}
            onChange={e => setDmQuery(e.target.value)}
            placeholder="名前で検索..."
            autoFocus
            style={{ width: '100%', padding: '8px 12px', borderRadius: 6, border: `1px solid ${border}`, background: inputBg, color: textColor, fontSize: 14, marginBottom: 10, boxSizing: 'border-box' }}
          />
          {/* 一括ボタン */}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
            {dmEmpTypes.map(et => {
              const ids = filteredProfiles.filter(p => (p.employment_type || 'その他') === et).map(p => p.id);
              const allSel = ids.length > 0 && ids.every(id => dmSelectedIds.includes(id));
              return (
                <button key={et} type="button" onClick={() => {
                  setDmSelectedIds(prev => allSel ? prev.filter(id => !ids.includes(id)) : [...new Set([...prev, ...ids])]);
                }} style={{ padding: '4px 10px', borderRadius: 12, border: 'none', cursor: 'pointer', fontSize: 12, background: allSel ? '#007bff' : (isDark ? '#495057' : '#e9ecef'), color: allSel ? '#fff' : (isDark ? '#fff' : '#333') }}>
                  {et}を一括選択
                </button>
              );
            })}
            <button type="button" onClick={() => setDmSelectedIds(filteredProfiles.map(p => p.id))}
              style={{ padding: '4px 10px', borderRadius: 12, border: 'none', cursor: 'pointer', fontSize: 12, background: isDark ? '#495057' : '#e9ecef', color: isDark ? '#fff' : '#333' }}>全員</button>
            <button type="button" onClick={() => setDmSelectedIds([])}
              style={{ padding: '4px 10px', borderRadius: 12, border: 'none', cursor: 'pointer', fontSize: 12, background: isDark ? '#495057' : '#e9ecef', color: isDark ? '#fff' : '#333' }}>全解除</button>
          </div>
          {/* チェックボックスグリッド */}
          <div style={{ maxHeight: 260, overflowY: 'auto', border: `1px solid ${border}`, borderRadius: 8 }}>
            {dmEmpTypes.map((et, gi) => {
              const etProfiles = filteredProfiles.filter(p => (p.employment_type || 'その他') === et);
              if (etProfiles.length === 0) return null;
              const roles = [...new Set(etProfiles.map(p => p.role_title || 'その他'))].sort((a, b) => {
                const ai = ROLE_ORDER.indexOf(a), bi = ROLE_ORDER.indexOf(b);
                if (ai === -1 && bi === -1) return a > b ? 1 : -1;
                if (ai === -1) return 1; if (bi === -1) return -1; return ai - bi;
              });
              return (
                <div key={et}>
                  <div style={{ padding: '5px 10px', background: isDark ? '#2d3136' : '#e9ecef', borderTop: gi > 0 ? `2px solid ${isDark ? '#6c757d' : '#bbb'}` : undefined, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: 12, fontWeight: 'bold', color: isDark ? '#adb5bd' : '#444' }}>{et}</span>
                    <span style={{ fontSize: 11, color: isDark ? '#6c757d' : '#999' }}>{etProfiles.filter(p => dmSelectedIds.includes(p.id)).length}/{etProfiles.length}</span>
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', borderBottom: `1px solid ${isDark ? '#3d4349' : '#e0e0e0'}` }}>
                    {roles.map((role, ri) => {
                      const roleProfiles = etProfiles.filter(p => (p.role_title || 'その他') === role).sort((a, b) => (a.name || '') > (b.name || '') ? 1 : -1);
                      const allRoleSel = roleProfiles.every(p => dmSelectedIds.includes(p.id));
                      return (
                        <div key={role} style={{ flex: '1 1 140px', borderLeft: ri > 0 ? `1px solid ${isDark ? '#3d4349' : '#e0e0e0'}` : undefined, padding: '6px 8px' }}>
                          <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, marginBottom: 4, paddingBottom: 3, borderBottom: `1px solid ${isDark ? '#3d4349' : '#eee'}`, cursor: 'pointer' }}>
                            <input type="checkbox" checked={allRoleSel && roleProfiles.length > 0}
                              onChange={() => {
                                const ids = roleProfiles.map(p => p.id);
                                setDmSelectedIds(prev => allRoleSel ? prev.filter(id => !ids.includes(id)) : [...new Set([...prev, ...ids])]);
                              }} />
                            <span style={{ fontSize: 10, fontWeight: 'bold', color: isDark ? '#adb5bd' : '#555' }}>{role}</span>
                          </label>
                          {roleProfiles.map(p => (
                            <label key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0', cursor: 'pointer', fontSize: 12, color: textColor }}>
                              <input type="checkbox" checked={dmSelectedIds.includes(p.id)}
                                onChange={e => setDmSelectedIds(prev => e.target.checked ? [...prev, p.id] : prev.filter(id => id !== p.id))} />
                              <span>{p.name}</span>
                            </label>
                          ))}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
          <p style={{ fontSize: 12, color: subColor, marginTop: 4 }}>{dmSelectedIds.length}人選択中</p>
          {/* 複数選択時: メッセージ入力 */}
          {isMulti && (
            <textarea
              value={broadcastMessage}
              onChange={e => setBroadcastMessage(e.target.value)}
              placeholder="メッセージを入力..."
              rows={3}
              style={{ width: '100%', padding: '8px 12px', borderRadius: 6, border: `1px solid ${border}`, background: inputBg, color: textColor, fontSize: 14, marginTop: 8, boxSizing: 'border-box', resize: 'vertical' }}
            />
          )}
          {dmError && (
            <div style={{ marginTop: 8, padding: '8px 10px', background: isDark ? '#2d1a1a' : '#fff5f5', border: `1px solid ${isDark ? '#7f1d1d' : '#fca5a5'}`, borderRadius: 6, color: '#dc2626', fontSize: 12 }}>
              {dmError}
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button type="button" onClick={() => { setShowDMSearch(false); setDmQuery(''); setDmSelectedIds([]); setBroadcastMessage(''); setDmError(''); }}
              style={{ flex: 1, padding: 10, background: '#6c757d', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 14 }}>キャンセル</button>
            {isSingle && (
              <button type="button" onClick={() => startDM(dmSelectedIds[0])} disabled={dmCreating}
                style={{ flex: 1, padding: 10, background: '#007bff', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 14, opacity: dmCreating ? 0.6 : 1 }}>
                {dmCreating ? '作成中...' : 'DMを開始'}
              </button>
            )}
            {isMulti && (
              <button type="button" onClick={sendBroadcast} disabled={!broadcastMessage.trim() || sending}
                style={{ flex: 1, padding: 10, background: '#007bff', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 14, opacity: !broadcastMessage.trim() || sending ? 0.5 : 1 }}>
                一斉送信（{dmSelectedIds.length}人）
              </button>
            )}
          </div>
        </div>
      </div>
    );
  })() : null;

  // ── Panels ───────────────────────────────────────────────────────

  // サイドバー用 チャンネルリスト行
  const renderChannelRow = (ch: Channel) => {
    const last = channelLastMsg(ch.id);
    const unread = channelUnread(ch.id);
    const isSelected = view === 'channel' && ch.id === selectedChannelId;
    const canDelete = isAdmin || ch.created_by === user?.id;
    return (
      <div key={ch.id} onClick={() => { selectChannel(ch.id); setView('channel'); setShowSidebar(false); setShowChannelList(false); }} style={{
        padding: '8px 14px', cursor: 'pointer', borderBottom: `1px solid ${border}`,
        background: isSelected ? (isDark ? '#2d3561' : '#e8f0fe') : 'transparent',
        display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left',
      }}>
        <div style={{ width: 34, height: 34, borderRadius: ch.type === 'group' ? 8 : '50%', background: ch.type === 'group' ? '#6f42c1' : '#4a90d9', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 14, flexShrink: 0 }}>
          {ch.type === 'group' ? '👥' : avatarLetter(channelDisplayName(ch))}
        </div>
        <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 13, fontWeight: unread > 0 ? 'bold' : 'normal', color: textColor, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, textAlign: 'left' }}>{channelDisplayName(ch)}</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
              <span style={{ fontSize: 10, color: subColor }}>{last ? fmtTime(last.created_at) : ''}</span>
              <button type="button" onClick={e => toggleFavChannel(e, ch.id)}
                title={favChannelIds.has(ch.id) ? 'お気に入り解除' : 'お気に入り追加'}
                style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, padding: '0 3px', lineHeight: 1, color: favChannelIds.has(ch.id) ? '#f59e0b' : (isDark ? '#888' : '#bbb') }}>
                {favChannelIds.has(ch.id) ? '★' : '☆'}
              </button>
              {canDelete && (
                <button type="button" onClick={e => deleteChannel(ch.id, e)}
                  title="削除"
                  style={{ background: 'none', border: 'none', color: '#dc3545', cursor: 'pointer', fontSize: 13, padding: '0 2px', lineHeight: 1 }}>🗑️</button>
              )}
            </div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 1 }}>
            <span style={{ fontSize: 12, color: subColor, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '80%', textAlign: 'left' }}>{last?.body || 'まだメッセージがありません'}</span>
            {unread > 0 && (
              <span style={{ background: '#dc3545', color: '#fff', borderRadius: 10, fontSize: 10, minWidth: 18, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 4px', fontWeight: 'bold', flexShrink: 0 }}>{unread > 99 ? '99+' : unread}</span>
            )}
          </div>
        </div>
      </div>
    );
  };

  const searchLower = searchText.toLowerCase();
  const groupChannels = sortedChannels.filter(c => c.type === 'group' && (!searchText || channelDisplayName(c).toLowerCase().includes(searchLower)));
  const dmChannels    = sortedChannels.filter(c => c.type === 'dm'    && (!searchText || channelDisplayName(c).toLowerCase().includes(searchLower)));
  const inboxUnread   = inboxMessages.filter(m => !inboxReadIds.has(m.id)).length;

  const channelListPanel = (
    <div style={{ width: isMobile ? '100%' : 280, background: sidebarBg, borderRight: isMobile ? 'none' : `1px solid ${border}`, display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, flexShrink: 0 }}>
      <div ref={channelListRef} style={{ overflowY: 'auto', flex: 1, minHeight: 0, paddingTop: showSearch ? 96 : 56 }}>
        {/* ── 受信・送信・お気に入り ── */}
        {[
          { key: 'inbox'  as const, icon: '📨', label: '受信トレイ', bg: isDark ? '#1e3a5f' : '#dbeafe', badge: inboxUnread, onClick: () => { setView('inbox'); setInboxFilter('all'); setShowSidebar(false); setInboxDetailId(null); } },
          { key: 'outbox' as const, icon: '📤', label: '送信トレイ',   bg: isDark ? '#1e3a2a' : '#dcfce7', badge: 0,           onClick: () => { setView('outbox'); setShowSidebar(false); setOutboxDetailId(null); } },
        ].map(item => {
          const isActive = view === item.key && !showSidebar;
          return (
            <div key={item.key} onClick={item.onClick} style={{
              padding: '10px 14px', cursor: 'pointer', borderBottom: `1px solid ${border}`,
              background: isActive ? (isDark ? '#2d3561' : '#e8f0fe') : 'transparent',
              display: 'flex', alignItems: 'center', gap: 12, textAlign: 'left',
            }}>
              <div style={{ width: 38, height: 38, borderRadius: 10, background: item.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, flexShrink: 0 }}>{item.icon}</div>
              <span style={{ flex: 1, fontSize: 14, fontWeight: isActive ? 700 : 500, color: textColor, textAlign: 'left' }}>{item.label}</span>
              {item.badge > 0 && (
                <span
                  onClick={item.key === 'inbox' ? (e => { e.stopPropagation(); setView('inbox'); setInboxFilter('unread'); setShowSidebar(false); setInboxDetailId(null); }) : undefined}
                  title={item.key === 'inbox' ? '未読だけ表示' : undefined}
                  style={{ background: '#dc3545', color: '#fff', borderRadius: 10, fontSize: 11, minWidth: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 5px', fontWeight: 'bold', flexShrink: 0, cursor: item.key === 'inbox' ? 'pointer' : 'inherit' }}>{item.badge}</span>
              )}
            </div>
          );
        })}
        {/* ── お気に入り（常時表示） ── */}
        {(() => {
          const isActive = view === 'favorites' && !showSidebar;
          const favCount = favChannelIds.size + favMessageIds.size;
          return (
            <div onClick={() => { setView('favorites'); setShowSidebar(false); }} style={{
              padding: '10px 14px', cursor: 'pointer', borderBottom: `1px solid ${border}`,
              background: isActive ? (isDark ? '#2d3561' : '#e8f0fe') : 'transparent',
              display: 'flex', alignItems: 'center', gap: 12, textAlign: 'left',
            }}>
              <div style={{ width: 38, height: 38, borderRadius: 10, background: isDark ? '#3a3020' : '#fef9c3', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, flexShrink: 0 }}>⭐</div>
              <span style={{ flex: 1, fontSize: 14, fontWeight: isActive ? 700 : 500, color: textColor }}>お気に入り</span>
              {favCount > 0 && (
                <span style={{ background: '#f59e0b', color: '#fff', borderRadius: 10, fontSize: 11, minWidth: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 5px', fontWeight: 'bold' }}>{favCount}</span>
              )}
            </div>
          );
        })()}

        {/* ── 区切り線 ── */}
        <div style={{ margin: '4px 0', borderBottom: `2px solid ${border}` }} />

        {/* ── グループ ── */}
        {loadingData ? null : (
          <>
            <div style={{ padding: '8px 14px 4px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: subColor, letterSpacing: 0.5 }}>👥 グループ</span>
              {canCreateGroup && (
                <button type="button" onClick={() => setShowGroupModal(true)}
                  style={{ background: '#6f42c1', border: 'none', borderRadius: 6, color: '#fff', cursor: 'pointer', fontSize: 11, padding: '4px 9px', fontWeight: 700, display: 'flex', alignItems: 'center', gap: 3, lineHeight: 1 }} title="グループ作成">＋グループ作成</button>
              )}
            </div>
            {groupChannels.slice(0, expandGroups ? undefined : 3).map(renderChannelRow)}
            {groupChannels.length > 3 && (
              <button type="button" onClick={() => setExpandGroups(e => !e)}
                style={{ width: '100%', padding: '6px 0', background: 'none', border: 'none', color: '#4a90d9', cursor: 'pointer', fontSize: 12, borderBottom: `1px solid ${border}` }}>
                {expandGroups ? '▲ 閉じる' : `▼ あと${groupChannels.length - 3}件`}
              </button>
            )}
            {groupChannels.length === 0 && (
              <div style={{ padding: '8px 16px', fontSize: 12, color: subColor }}>グループがありません</div>
            )}

            {/* ── DM ── */}
            <div style={{ padding: '10px 16px 4px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: subColor, letterSpacing: 1 }}>💬 DM</span>
              {canStartDM && (
                <button type="button" onClick={() => setShowDMSearch(true)}
                  style={{ background: '#4a90d9', border: 'none', borderRadius: 6, color: '#fff', cursor: 'pointer', fontSize: 11, padding: '4px 9px', fontWeight: 700, display: 'flex', alignItems: 'center', gap: 3, lineHeight: 1 }} title="DM送信">＋DM送信</button>
              )}
            </div>
            {dmChannels.slice(0, expandDMs ? undefined : 3).map(renderChannelRow)}
            {dmChannels.length > 3 && (
              <button type="button" onClick={() => setExpandDMs(e => !e)}
                style={{ width: '100%', padding: '6px 0', background: 'none', border: 'none', color: '#4a90d9', cursor: 'pointer', fontSize: 12, borderBottom: `1px solid ${border}` }}>
                {expandDMs ? '▲ 閉じる' : `▼ あと${dmChannels.length - 3}件`}
              </button>
            )}
            {dmChannels.length === 0 && (
              <div style={{ padding: '8px 16px', fontSize: 12, color: subColor }}>DMがありません</div>
            )}
          </>
        )}
      </div>
    </div>
  );

  // ── 受信トレイ ────────────────────────────────────────────────
  const INBOX_FILTERS = [
    { key: 'all',      label: 'すべて' },
    { key: 'unread',   label: '未読' },
    { key: 'pending',  label: '未対応' },
    { key: 'read',     label: '読了' },
    { key: 'answer',   label: '回答' },
    { key: 'submit',   label: '提出' },
    { key: 'approve',  label: '承認' },
    { key: 'archived', label: 'アーカイブ' },
  ] as const;

  const filteredInbox = inboxFilter === 'archived' ? archivedMessages : inboxMessages.filter(m => {
    if (inboxFilter === 'all') return true;
    if (inboxFilter === 'unread') return !inboxReadIds.has(m.id);
    if (inboxFilter === 'pending') {
      const confirmed = (confirmations[m.id] || []).some(c => c.user_id === user?.id);
      return (m.requires_confirmation || m.deadline_type) && !confirmed;
    }
    return m.deadline_type === inboxFilter;
  });

  const inboxDetail = inboxDetailId
    ? (inboxMessages.find(m => m.id === inboxDetailId) || archivedMessages.find(m => m.id === inboxDetailId))
    : null;

  const inboxPanel = (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: bg }}>
      {inboxDetail ? (
        /* 詳細ビュー */
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={{ paddingTop: 58 }} />
          <div style={{ flex: 1, overflowY: 'auto', padding: '16px 14px' }}>
            {/* 宛先タグ */}
            {(inboxRecipients[inboxDetail.id] || []).length > 0 && (() => {
              const allIds = inboxRecipients[inboxDetail.id] || [];
              return (
                <div style={{ marginBottom: 12, padding: '8px 12px', background: isDark ? '#1e2a3a' : '#eff6ff', borderRadius: 8 }}>
                  <div style={{ fontSize: 12, color: isDark ? '#93c5fd' : '#3b82f6', fontWeight: 700, marginBottom: 6 }}>宛先 {allIds.length}人</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                    {allIds.map(uid => (
                      <span key={uid} style={{ padding: '2px 8px', background: isDark ? '#2d3561' : '#dbeafe', color: isDark ? '#93c5fd' : '#1d4ed8', borderRadius: 12, fontSize: 11, fontWeight: 500 }}>
                        {allProfiles.find(p => p.id === uid)?.name || '不明'}
                      </span>
                    ))}
                  </div>
                </div>
              );
            })()}
            {/* 修正モード（受信トレイ側・送信者 or 管理者） */}
            {(inboxDetail.user_id === user?.id || isAdmin) && editingNoticeId === inboxDetail.id ? (
              <div style={{ marginTop: 16, padding: '14px', background: isDark ? '#1e2a1e' : '#f0fdf4', border: `1px solid ${isDark ? '#166534' : '#86efac'}`, borderRadius: 10 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: isDark ? '#86efac' : '#166534', marginBottom: 10 }}>✏️ お知らせを修正</div>
                <div style={{ marginBottom: 8 }}>
                  <div style={{ fontSize: 11, color: subColor, marginBottom: 4 }}>件名</div>
                  <input value={editingNoticeSubj} onChange={e => setEditingNoticeSubj(e.target.value)}
                    style={{ width: '100%', padding: '7px 10px', borderRadius: 6, border: `1px solid ${border}`, background: inputBg, color: textColor, fontSize: 13, boxSizing: 'border-box' }} />
                </div>
                <div style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 11, color: subColor, marginBottom: 4 }}>本文</div>
                  <textarea value={editingNoticeBody} onChange={e => setEditingNoticeBody(e.target.value)} rows={5}
                    style={{ width: '100%', padding: '7px 10px', borderRadius: 6, border: `1px solid ${border}`, background: inputBg, color: textColor, fontSize: 13, resize: 'vertical', fontFamily: 'inherit', boxSizing: 'border-box' }} />
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="button" onClick={() => setEditingNoticeId(null)}
                    style={{ flex: 1, padding: '8px 0', background: 'none', border: `1px solid ${border}`, color: subColor, borderRadius: 8, cursor: 'pointer', fontSize: 13 }}>キャンセル</button>
                  <button type="button" onClick={() => saveNoticeEdit(inboxDetail.id)}
                    disabled={!editingNoticeSubj.trim() || !editingNoticeBody.trim()}
                    style={{ flex: 1, padding: '8px 0', background: '#28a745', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600, opacity: (!editingNoticeSubj.trim() || !editingNoticeBody.trim()) ? 0.5 : 1 }}>保存する</button>
                </div>
              </div>
            ) : renderMsg(inboxDetail)}
            {/* 削除確認（受信トレイ側） */}
            {(inboxDetail.user_id === user?.id || isAdmin) && deleteConfirmId === inboxDetail.id && (
              <div style={{ marginTop: 16, padding: '12px 14px', background: isDark ? '#2d1a1a' : '#fff5f5', border: `1px solid ${isDark ? '#7f1d1d' : '#fca5a5'}`, borderRadius: 10 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#dc2626', marginBottom: 8 }}>本当に削除しますか？</div>
                <div style={{ fontSize: 12, color: subColor, marginBottom: 12 }}>受信者全員の受信トレイからも削除されます。この操作は元に戻せません。</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="button" onClick={() => setDeleteConfirmId(null)}
                    style={{ flex: 1, padding: '8px 0', background: 'none', border: `1px solid ${border}`, color: subColor, borderRadius: 8, cursor: 'pointer', fontSize: 13 }}>キャンセル</button>
                  <button type="button" onClick={() => deleteNotice(inboxDetail.id)}
                    style={{ flex: 1, padding: '8px 0', background: '#dc2626', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>削除する</button>
                </div>
              </div>
            )}
            {/* 送信者・管理者アクションボタン（受信トレイ詳細） */}
            {(inboxDetail.user_id === user?.id || isAdmin) && editingNoticeId !== inboxDetail.id && deleteConfirmId !== inboxDetail.id && (
              <div style={{ marginTop: 12, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button type="button"
                  onClick={() => { setEditingNoticeId(inboxDetail.id); setEditingNoticeSubj(inboxDetail.subject || inboxDetail.title || ''); setEditingNoticeBody(inboxDetail.body); }}
                  style={{ padding: '7px 14px', background: 'none', border: `1.5px solid ${isDark ? '#4ade80' : '#16a34a'}`, color: isDark ? '#4ade80' : '#16a34a', borderRadius: 8, cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
                  ✏️ 修正する
                </button>
                <button type="button" onClick={() => setDeleteConfirmId(inboxDetail.id)}
                  style={{ padding: '7px 14px', background: 'none', border: '1.5px solid #dc3545', color: '#dc3545', borderRadius: 8, cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
                  🗑️ 取消・削除
                </button>
              </div>
            )}
            {/* リマインド（送信者 or 管理者かつ確認系メッセージのみ） */}
            {(inboxDetail.user_id === user?.id || isAdmin) && (inboxDetail.requires_confirmation || inboxDetail.deadline_type) && inboxDetailRecipients.length > 0 && (
              <div style={{ marginTop: 16, padding: '12px 14px', background: isDark ? '#2a1f00' : '#fffbeb', border: `1px solid ${isDark ? '#5a3e00' : '#fcd34d'}`, borderRadius: 10 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: isDark ? '#fcd34d' : '#92400e', marginBottom: 8 }}>
                  🔔 対応状況 {inboxDetailRecipients.length - inboxDetailUnconfirmed.length}/{inboxDetailRecipients.length}人 完了
                </div>
                {inboxDetailUnconfirmed.length > 0 ? (
                  <>
                    <div style={{ fontSize: 12, color: isDark ? '#fcd34d' : '#92400e', marginBottom: 8 }}>
                      未対応 {inboxDetailUnconfirmed.length}人：
                      {inboxDetailUnconfirmed.map(uid => allProfiles.find(p => p.id === uid)?.name || '不明').join('、')}
                    </div>
                    <button type="button" disabled={inboxRemindSending}
                      onClick={async () => {
                        if (!user) return;
                        setInboxRemindSending(true);
                        await Promise.all(inboxDetailUnconfirmed.map(uid =>
                          insertNotification(uid, `【リマインド】${inboxDetail.subject || inboxDetail.title || 'お知らせ'}への対応がまだ完了していません`, undefined, undefined, inboxDetail.id, 'board:confirm_request')
                        ));
                        setInboxRemindSending(false);
                        setSaveBanner(true);
                        setTimeout(() => setSaveBanner(false), 3000);
                      }}
                      style={{ padding: '7px 16px', background: '#f59e0b', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600, opacity: inboxRemindSending ? 0.6 : 1 }}>
                      {inboxRemindSending ? '送信中...' : `🔔 ${inboxDetailUnconfirmed.length}人にリマインドを送る`}
                    </button>
                  </>
                ) : (
                  <div style={{ fontSize: 13, color: '#22c55e', fontWeight: 600 }}>✅ 全員対応済みです</div>
                )}
              </div>
            )}
          </div>
        </div>
      ) : (
        /* 一覧ビュー */
        <>
          <div style={{ paddingTop: 56, flexShrink: 0 }}>
            {/* フィルタータブ */}
            <div style={{ display: 'flex', overflowX: 'auto', borderBottom: `1px solid ${border}`, background: cardBg, padding: '0 8px' }}>
              {INBOX_FILTERS.map(f => (
                <button key={f.key} type="button" onClick={() => { setInboxFilter(f.key); if (f.key === 'archived') loadArchived(); }}
                  style={{ padding: '10px 14px', background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: inboxFilter === f.key ? 700 : 400, color: inboxFilter === f.key ? '#007bff' : subColor, borderBottom: inboxFilter === f.key ? '2px solid #007bff' : '2px solid transparent', whiteSpace: 'nowrap', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 4 }}>
                  {f.key === 'archived' ? <><ArchiveIcon size={13} /> アーカイブ</> : f.label}
                </button>
              ))}
            </div>
          </div>
          {/* アーカイブ一括削除UI */}
          {inboxFilter === 'archived' && (
            <div style={{ borderBottom: `1px solid ${border}` }}>
              {/* 期間指定一括削除 */}
              <div style={{ padding: '8px 12px', background: isDark ? '#2a1a1a' : '#fff5f5', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12, color: subColor, flexShrink: 0 }}>🗑️ 一括削除：</span>
                {([['1m', '1ヶ月以上前'], ['3m', '3ヶ月以上前'], ['1y', '1年以上前'], ['all', 'すべて']] as const).map(([key, label]) => (
                  <button key={key} type="button" onClick={() => setArchiveBulkPeriod(archiveBulkPeriod === key ? '' : key)}
                    style={{ padding: '4px 10px', borderRadius: 20, border: `1.5px solid ${archiveBulkPeriod === key ? '#dc3545' : border}`, background: archiveBulkPeriod === key ? '#dc3545' : 'none', color: archiveBulkPeriod === key ? '#fff' : subColor, cursor: 'pointer', fontSize: 12, fontWeight: archiveBulkPeriod === key ? 700 : 400 }}>
                    {label}
                  </button>
                ))}
                {archiveBulkPeriod && (
                  <button type="button" disabled={archiveBulkDeleting} onClick={async () => {
                    const now = new Date();
                    let cutoff: Date | null = null;
                    if (archiveBulkPeriod === '1m') cutoff = new Date(now.setMonth(now.getMonth() - 1));
                    else if (archiveBulkPeriod === '3m') cutoff = new Date(now.setMonth(now.getMonth() - 3));
                    else if (archiveBulkPeriod === '1y') cutoff = new Date(now.setFullYear(now.getFullYear() - 1));
                    const targets = cutoff ? archivedMessages.filter(m => new Date(m.created_at) < cutoff!) : archivedMessages;
                    if (targets.length === 0) return;
                    setInboxArchiveDelConfirm(true);
                    setInboxArchiveSelected(new Set(targets.map(m => m.id)));
                  }} style={{ padding: '4px 14px', borderRadius: 20, border: 'none', background: '#dc3545', color: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 700 }}>
                    削除実行
                  </button>
                )}
              </div>
              {/* チェックボックス選択バー */}
              <div style={{ padding: '6px 12px', background: isDark ? '#1a1a2a' : '#f0f4ff', display: 'flex', alignItems: 'center', gap: 8 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, cursor: 'pointer', color: textColor }}>
                  <input type="checkbox"
                    checked={inboxArchiveSelected.size === archivedMessages.length && archivedMessages.length > 0}
                    onChange={e => setInboxArchiveSelected(e.target.checked ? new Set(archivedMessages.map(m => m.id)) : new Set())} />
                  全て選択
                </label>
                {inboxArchiveSelected.size > 0 && (
                  <button type="button" onClick={() => setInboxArchiveDelConfirm(true)}
                    style={{ padding: '3px 12px', borderRadius: 14, border: 'none', background: '#dc3545', color: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
                    選択した {inboxArchiveSelected.size} 件を削除
                  </button>
                )}
                {inboxArchiveSelected.size > 0 && (
                  <button type="button" onClick={() => setInboxArchiveSelected(new Set())}
                    style={{ padding: '3px 8px', borderRadius: 14, border: `1px solid ${border}`, background: 'none', color: subColor, cursor: 'pointer', fontSize: 12 }}>
                    外す
                  </button>
                )}
              </div>
              {/* 削除確認パネル */}
              {inboxArchiveDelConfirm && (
                <div style={{ padding: '10px 12px', background: isDark ? '#2d1a1a' : '#fff5f5', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 13, color: '#dc3545', flex: 1 }}>
                    {inboxArchiveSelected.size}件を完全に削除します。元に戻せません。
                  </span>
                  <button type="button" onClick={() => setInboxArchiveDelConfirm(false)}
                    style={{ padding: '4px 12px', border: `1px solid ${border}`, borderRadius: 6, background: 'none', color: subColor, cursor: 'pointer', fontSize: 12 }}>キャンセル</button>
                  <button type="button" onClick={async () => {
                    const ids = [...inboxArchiveSelected];
                    await supabase.from('board_message_recipients').delete().in('message_id', ids).eq('user_id', user!.id);
                    setArchivedMessages(prev => prev.filter(m => !ids.includes(m.id)));
                    setInboxArchiveSelected(new Set());
                    setInboxArchiveDelConfirm(false);
                    setArchiveBulkPeriod('');
                  }} style={{ padding: '4px 14px', border: 'none', borderRadius: 6, background: '#dc3545', color: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 700 }}>削除する</button>
                </div>
              )}
            </div>
          )}
          <div style={{ flex: 1, overflowY: 'auto', padding: '8px 12px' }}>
            {filteredInbox.length === 0 ? (
              <div style={{ textAlign: 'center', color: subColor, fontSize: 13, marginTop: 40 }}>
                {inboxFilter === 'all' ? 'お知らせはありません' : inboxFilter === 'unread' ? '未読のお知らせはありません' : '該当するお知らせはありません'}
              </div>
            ) : filteredInbox.map(msg => {
              const senderName = allProfiles.find(p => p.id === msg.user_id)?.name || '不明';
              const confirmed = (confirmations[msg.id] || []).some(c => c.user_id === user?.id);
              const today = todayJstStr();
              const isOverdue = msg.deadline ? msg.deadline < today : false;
              const dtConfig = DEADLINE_TYPES.find(d => d.value === msg.deadline_type);
              const isArchived = inboxFilter === 'archived';
              const accentColor = isOverdue ? '#dc2626' : '#1d4ed8';
              const typeText = dtConfig ? dtConfig.label.replace(/^\S+\s/, '') : '';
              const inboxSel = inboxArchiveSelected.has(msg.id);
              const cardBorder = isArchived && inboxSel ? '1.5px solid #3b82f6' : confirmed ? '1.5px solid #22c55e' : `1px solid ${border}`;
              const cardLeftBorder = !inboxReadIds.has(msg.id) && !confirmed ? '3px solid #4a90d9' : cardBorder;
              return (
                <div key={msg.id}
                  style={{ background: cardBg, borderTop: cardBorder, borderRight: cardBorder, borderBottom: cardBorder, borderLeft: cardLeftBorder, borderRadius: 10, padding: '10px 12px', marginBottom: 6, position: 'relative' }}>
                  {/* ヘッダー行：送信者 + 時刻 + ★ + 📦 */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      {isArchived && (
                        <input type="checkbox" checked={inboxSel}
                          onChange={e => { e.stopPropagation(); setInboxArchiveSelected(prev => { const s = new Set(prev); e.target.checked ? s.add(msg.id) : s.delete(msg.id); return s; }); }}
                          onClick={e => e.stopPropagation()}
                          style={{ width: 15, height: 15, flexShrink: 0, cursor: 'pointer', accentColor: '#3b82f6' }} />
                      )}
                      <div style={{ width: 22, height: 22, borderRadius: '50%', background: '#4a90d9', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 10, fontWeight: 'bold', flexShrink: 0 }}>
                        {avatarLetter(senderName)}
                      </div>
                      <span style={{ fontSize: 12, fontWeight: 'bold', color: textColor }}>{senderName}</span>
                      <span style={{ fontSize: 10, color: subColor }}>{fmtFull(msg.sent_at || msg.created_at)}</span>
                      {confirmed && !isArchived && <span style={{ fontSize: 10, color: '#22c55e', fontWeight: 700 }}>✓ 完了</span>}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                      <button type="button" onClick={e => toggleFavMessage(e, msg.id, msg)}
                        title={favMessageIds.has(msg.id) ? 'お気に入り解除' : 'お気に入りに追加'}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 15, padding: '1px 3px', color: favMessageIds.has(msg.id) ? '#f59e0b' : (isDark ? '#666' : '#ccc') }}>
                        {favMessageIds.has(msg.id) ? '★' : '☆'}
                      </button>
                      <button type="button" onClick={e => { e.stopPropagation(); archiveMessage(msg.id, !isArchived); }}
                        title={isArchived ? '受信トレイに戻す' : 'アーカイブ'}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '1px 3px', color: subColor, display: 'flex', alignItems: 'center' }}>
                        {isArchived
                          ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}><path d="M21 8v13H3V8" /><rect x="1" y="3" width="22" height="5" rx="1" /><polyline points="10 11 12 9 14 11" /><line x1="12" y1="9" x2="12" y2="15" /></svg>
                          : <ArchiveIcon size={14} />}
                      </button>
                    </div>
                  </div>
                  {/* クリック領域 */}
                  <div onClick={async () => {
                    setInboxDetailId(msg.id);
                    if (!inboxReadIds.has(msg.id) && user) {
                      await supabase.from('board_reads').upsert({ message_id: msg.id, user_id: user.id }, { onConflict: 'message_id,user_id', ignoreDuplicates: true });
                      setInboxReadIds(prev => new Set([...prev, msg.id]));
                      setReadCounts(prev => ({ ...prev, [msg.id]: (prev[msg.id] || 0) + 1 }));
                    }
                  }} style={{ cursor: 'pointer', textAlign: 'left' }}>
                    {/* 種別タイトル */}
                    {dtConfig && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                        <div style={{ width: 3, height: 16, background: accentColor, borderRadius: 2, flexShrink: 0 }} />
                        <span style={{ fontSize: 13, fontWeight: 700, color: textColor }}>{typeText === '確認' ? typeText : `${typeText}確認`}</span>
                        {msg.deadline && (
                          confirmed ? (
                            <span style={{ fontSize: 10, color: subColor }}>{msg.deadline}まで</span>
                          ) : isOverdue ? (
                            <span style={{ fontSize: 10, display: 'flex', alignItems: 'center', gap: 4 }}>
                              <span style={{ color: '#dc2626', fontWeight: 600 }}>期限切れ</span>
                              <span style={{ color: subColor }}>{msg.deadline}まで</span>
                            </span>
                          ) : (
                            <span style={{ fontSize: 10, color: '#d97706', fontWeight: 600 }}>{msg.deadline}まで</span>
                          )
                        )}
                      </div>
                    )}
                    {/* 件名 */}
                    {(msg.subject || msg.title) && (
                      <div style={{ fontSize: 13, fontWeight: 700, color: textColor, marginBottom: 4, paddingBottom: 4, borderBottom: `1px solid ${border}` }}>{msg.subject || msg.title}</div>
                    )}
                    {/* 本文（3行） */}
                    <div style={{ fontSize: 12, color: subColor, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', wordBreak: 'break-word' }}>
                      {msg.body}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );

  // ── 送信フロー（Compose） ─────────────────────────────────────────
  const activeOthersForCompose = allProfiles; // 自分も含む
  const composeFiltered = activeOthersForCompose.filter(p => !composeQuery || (p.name || '').includes(composeQuery));
  const composeEmpTypes = ([...new Set(activeOthersForCompose.map(p => p.employment_type || 'その他'))] as string[])
    .sort((a, b) => { const o = EMP_ORDER; const ai = o.indexOf(a), bi = o.indexOf(b); if (ai === -1 && bi === -1) return a > b ? 1 : -1; if (ai === -1) return 1; if (bi === -1) return -1; return ai - bi; });

  // グループタグ設定（こども/大人/管理部のみ表示）
  const COMPOSE_GTAG = [
    { name: 'こども', bg: isDark ? '#1e3a5f' : '#dbeafe', color: isDark ? '#93c5fd' : '#1d4ed8' },
    { name: '大人',   bg: isDark ? '#14532d' : '#dcfce7', color: isDark ? '#86efac' : '#15803d' },
    { name: '管理部', bg: isDark ? '#451a03' : '#fef3c7', color: isDark ? '#fcd34d' : '#b45309' },
  ];

  // 一括ボタン定義（固定順序）
  const COMPOSE_QUICK_BTNS = [
    { label: '正社員',               getIds: () => composeFiltered.filter(p => p.employment_type === '正社員').map(p => p.id) },
    { label: 'パート',               getIds: () => composeFiltered.filter(p => p.employment_type === 'パート').map(p => p.id) },
    { label: 'マネージャー・リーダー', getIds: () => composeFiltered.filter(p => (p.group_names || []).includes('マネージャー・リーダー')).map(p => p.id) },
    { label: 'こども',               getIds: () => composeFiltered.filter(p => (p.group_names || []).includes('こども')).map(p => p.id) },
    { label: '大人',                 getIds: () => composeFiltered.filter(p => (p.group_names || []).includes('大人')).map(p => p.id) },
    { label: '管理部',               getIds: () => composeFiltered.filter(p => (p.group_names || []).includes('管理部')).map(p => p.id) },
  ];

  const composePanel = (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: bg }}>
      <div style={{ flex: 1, overflowY: 'auto', padding: '0 12px 16px', paddingTop: 58 }}>
        {/* 入力内容クリア */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 4 }}>
          <button type="button" onClick={resetCompose}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: subColor, background: 'none', border: `1px solid ${border}`, borderRadius: 14, padding: '4px 12px', cursor: 'pointer' }}>
            🗑 クリア
          </button>
        </div>
        {/* 宛先 */}
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: subColor, marginBottom: 6, marginTop: 8 }}>宛先を選択 <span style={{ color: '#dc3545', fontSize: 11 }}>*必須</span></div>
          <input value={composeQuery} onChange={e => setComposeQuery(e.target.value)} placeholder="名前で検索..."
            style={{ width: '100%', padding: '7px 10px', borderRadius: 8, border: `1px solid ${border}`, background: inputBg, color: textColor, fontSize: 13, boxSizing: 'border-box', marginBottom: 6 }} />
          {/* 一括ボタン（全員→各グループ→全解除の固定順） */}
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 6 }}>
            <button type="button" onClick={() => setComposeRecipientIds(composeFiltered.map(p => p.id))}
              style={{ padding: '3px 8px', borderRadius: 10, border: 'none', cursor: 'pointer', fontSize: 11, background: isDark ? '#495057' : '#e9ecef', color: isDark ? '#fff' : '#333' }}>全員</button>
            {COMPOSE_QUICK_BTNS.map(btn => {
              const ids = btn.getIds();
              const allInSel = ids.length > 0 && ids.every(id => composeRecipientIds.includes(id));
              const allSel = allInSel && composeRecipientIds.length === ids.length;
              return (
                <button key={btn.label} type="button"
                  onClick={() => {
                    if (allInSel && composeRecipientIds.length === ids.length) {
                      setComposeRecipientIds([]);
                    } else if (allInSel) {
                      setComposeRecipientIds(ids);
                    } else {
                      setComposeRecipientIds(prev => [...new Set([...prev, ...ids])]);
                    }
                  }}
                  style={{ padding: '3px 8px', borderRadius: 10, border: 'none', cursor: 'pointer', fontSize: 11, background: allInSel ? '#007bff' : (isDark ? '#495057' : '#e9ecef'), color: allInSel ? '#fff' : (isDark ? '#fff' : '#333'), opacity: allSel ? 1 : allInSel ? 0.75 : 1 }}>
                  {btn.label}
                </button>
              );
            })}
            <button type="button" onClick={() => setComposeRecipientIds([])}
              style={{ padding: '3px 8px', borderRadius: 10, border: 'none', cursor: 'pointer', fontSize: 11, background: isDark ? '#495057' : '#e9ecef', color: isDark ? '#fff' : '#333' }}>全解除</button>
          </div>
          {/* メンバーグリッド */}
          <div style={{ maxHeight: 200, overflowY: 'auto', border: `1px solid ${border}`, borderRadius: 8 }}>
            {composeEmpTypes.map((et, gi) => {
              const etProfiles = composeFiltered.filter(p => (p.employment_type || 'その他') === et);
              if (etProfiles.length === 0) return null;
              const roles = [...new Set(etProfiles.map(p => p.role_title || 'その他'))].sort((a, b) => { const ai = ROLE_ORDER.indexOf(a), bi = ROLE_ORDER.indexOf(b); if (ai === -1 && bi === -1) return a > b ? 1 : -1; if (ai === -1) return 1; if (bi === -1) return -1; return ai - bi; });
              return (
                <div key={et}>
                  <div style={{ padding: '4px 10px', background: isDark ? '#2d3136' : '#e9ecef', borderTop: gi > 0 ? `2px solid ${isDark ? '#6c757d' : '#bbb'}` : undefined }}>
                    <span style={{ fontSize: 11, fontWeight: 'bold', color: isDark ? '#adb5bd' : '#444' }}>{et}</span>
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap' }}>
                    {roles.map((role, ri) => {
                      const roleProfiles = etProfiles.filter(p => (p.role_title || 'その他') === role).sort((a, b) => (a.name || '') > (b.name || '') ? 1 : -1);
                      const allRoleSel = roleProfiles.every(p => composeRecipientIds.includes(p.id));
                      return (
                        <div key={role} style={{ flex: '1 1 130px', borderLeft: ri > 0 ? `1px solid ${isDark ? '#3d4349' : '#e0e0e0'}` : undefined, padding: '5px 8px' }}>
                          <label style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 3, cursor: 'pointer' }}>
                            <input type="checkbox" checked={allRoleSel && roleProfiles.length > 0}
                              onChange={() => { const ids = roleProfiles.map(p => p.id); setComposeRecipientIds(prev => allRoleSel ? prev.filter(id => !ids.includes(id)) : [...new Set([...prev, ...ids])]); }} />
                            <span style={{ fontSize: 10, fontWeight: 'bold', color: isDark ? '#adb5bd' : '#555' }}>{role}</span>
                          </label>
                          {roleProfiles.map(p => {
                            const gTags = COMPOSE_GTAG.filter(g => (p.group_names || []).includes(g.name));
                            return (
                              <label key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '2px 0', cursor: 'pointer', fontSize: 12, color: textColor, flexWrap: 'wrap' }}>
                                <input type="checkbox" checked={composeRecipientIds.includes(p.id)}
                                  onChange={e => setComposeRecipientIds(prev => e.target.checked ? [...prev, p.id] : prev.filter(id => id !== p.id))} />
                                <span style={{ flexShrink: 0 }}>
                                  {p.name}
                                  {p.id === user?.id && <span style={{ fontSize: 10, color: subColor }}> (自分)</span>}
                                </span>
                                {gTags.map(g => (
                                  <span key={g.name} style={{ fontSize: 9, padding: '1px 4px', borderRadius: 3, background: g.bg, color: g.color, whiteSpace: 'nowrap', flexShrink: 0 }}>{g.name}</span>
                                ))}
                              </label>
                            );
                          })}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
          {composeRecipientIds.length > 0 && (
            <div style={{ fontSize: 12, color: '#007bff', marginTop: 4 }}>{composeRecipientIds.length}人選択中</div>
          )}
        </div>

        {/* ⚙️ 設定（折りたたみ） */}
        <div style={{ marginBottom: 10 }}>
          <button type="button" onClick={() => setComposeOptions(e => !e)}
            style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '7px 10px', borderRadius: composeOptions ? '8px 8px 0 0' : 8, border: `1px solid ${border}`, background: inputBg, cursor: 'pointer', color: textColor, fontSize: 12, fontWeight: 600 }}>
            <span>⚙️ 件名・種別・期限・送信予約</span>
            <span style={{ fontSize: 11, color: subColor }}>{composeOptions ? '▲ 閉じる' : '▼ 開く'}</span>
          </button>
          {composeOptions && (
            <div style={{ padding: '10px 12px', background: inputBg, borderRadius: '0 0 8px 8px', border: `1px solid ${border}`, borderTop: 'none', display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div>
                <div style={{ fontSize: 11, color: textColor, fontWeight: 600, marginBottom: 4 }}>件名 <span style={{ color: '#dc3545' }}>*必須</span></div>
                <input value={composeSubject} onChange={e => setComposeSubject(e.target.value)} placeholder="件名を入力してください"
                  style={{ width: '100%', padding: '6px 10px', borderRadius: 6, border: `1.5px solid ${composeSubject.trim() ? border : '#dc3545'}`, background: 'transparent', color: textColor, fontSize: 13, boxSizing: 'border-box' }} />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                {DEADLINE_TYPES.map(dt => (
                  <button key={dt.value} type="button" onClick={() => setComposeDeadlineType(prev => prev === dt.value ? '' : dt.value)}
                    style={{ padding: '7px 4px', borderRadius: 8, border: `2px solid ${composeDeadlineType === dt.value ? '#007bff' : border}`, background: composeDeadlineType === dt.value ? '#007bff' : 'transparent', color: composeDeadlineType === dt.value ? '#fff' : textColor, cursor: 'pointer', fontSize: 13, fontWeight: composeDeadlineType === dt.value ? 'bold' : 'normal' }}>
                    {dt.label}
                  </button>
                ))}
              </div>
              {/* 内容・保存先・URL（種別選択時のみ） */}
              {composeDeadlineType && (() => {
                const dt = DEADLINE_TYPES.find(d => d.value === composeDeadlineType);
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 10px', background: isDark ? '#1e2a3a' : '#eff6ff', borderRadius: 8, border: `1px solid ${isDark ? '#3b82f6' : '#bfdbfe'}` }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: isDark ? '#93c5fd' : '#3b82f6', marginBottom: 2 }}>{dt?.label} の詳細（任意）</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontSize: 12, color: subColor, flexShrink: 0, minWidth: 38 }}>内容</span>
                      <input value={composeAnswerPrompt} onChange={e => setComposeAnswerPrompt(e.target.value)}
                        placeholder={dt?.promptPlaceholder || '例：タイトルや件名'}
                        style={{ flex: 1, padding: '5px 8px', borderRadius: 6, border: `1px solid ${border}`, background: 'transparent', color: textColor, fontSize: 12 }} />
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontSize: 12, color: subColor, flexShrink: 0, minWidth: 38 }}>保存先</span>
                      <input value={composeAnswerLocation} onChange={e => setComposeAnswerLocation(e.target.value)}
                        placeholder={dt?.locationPlaceholder || '例：スプレッドシート'}
                        style={{ flex: 1, padding: '5px 8px', borderRadius: 6, border: `1px solid ${border}`, background: 'transparent', color: textColor, fontSize: 12 }} />
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontSize: 12, color: subColor, flexShrink: 0, minWidth: 38 }}>URL</span>
                      <input value={composeAnswerLink} onChange={e => setComposeAnswerLink(e.target.value)}
                        placeholder={dt?.linkPlaceholder || 'https://...'}
                        style={{ flex: 1, padding: '5px 8px', borderRadius: 6, border: `1px solid ${border}`, background: 'transparent', color: textColor, fontSize: 12 }} />
                    </div>
                  </div>
                );
              })()}
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 12, color: subColor, flexShrink: 0 }}>⏰ 期限日{composeDeadlineType && <span style={{ color: '#dc3545' }}> *必須</span>}</span>
                  <input type="date" value={composeDeadline} onChange={e => setComposeDeadline(e.target.value)} min={todayJstStr()}
                    style={{ fontSize: 12, padding: '4px 8px', borderRadius: 6, border: `1.5px solid ${composeDeadlineType && !composeDeadline ? '#dc3545' : border}`, background: 'transparent', color: textColor, flex: 1 }} />
                  {composeDeadline && <button type="button" onClick={() => setComposeDeadline('')} style={{ fontSize: 11, color: subColor, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>✕</button>}
                </div>
                {composeDeadlineType && !composeDeadline && (
                  <div style={{ fontSize: 11, color: '#dc3545', marginTop: 3 }}>種別を選んだ場合、期限日の入力が必要です</div>
                )}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 12, color: subColor, flexShrink: 0 }}>🕐 送信予約</span>
                <input type="datetime-local" value={composeScheduledAt} onChange={e => setComposeScheduledAt(e.target.value)} min={localDatetimeMin()}
                  style={{ fontSize: 12, padding: '4px 8px', borderRadius: 6, border: `1px solid ${border}`, background: 'transparent', color: textColor, flex: 1 }} />
                {composeScheduledAt && <button type="button" onClick={() => setComposeScheduledAt('')} style={{ fontSize: 11, color: subColor, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>✕</button>}
              </div>
              {!previewRole && noticeCCUserIds.length > 0 && noticeCCUserIds.includes(user?.id ?? '') && (
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 12, color: textColor }}>
                  <input type="checkbox" checked={composeIncludeCC} onChange={e => setComposeIncludeCC(e.target.checked)} style={{ accentColor: '#22c55e' }} />
                  <span>他の代表者の送信履歴に加える</span>
                </label>
              )}
            </div>
          )}
        </div>

      </div>

      {/* 本文 + 送信（チャンネルと同レイアウト） */}
      <div style={{ padding: '10px 14px', borderTop: `1px solid ${border}`, background: cardBg, flexShrink: 0, display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <textarea value={composeBody} onChange={e => setComposeBody(e.target.value)} placeholder="本文を入力... *必須 (Ctrl+Enterで送信)"
          rows={2}
          onKeyDown={e => { if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); if (composeBody.trim() && composeSubject.trim() && composeRecipientIds.length > 0 && (!composeDeadlineType || composeDeadline)) setShowComposeSendConfirm(true); }}}
          style={{ flex: 1, padding: '8px 12px', borderRadius: 8, border: `1px solid ${border}`, background: inputBg, color: textColor, fontSize: 14, resize: 'none', fontFamily: 'inherit', lineHeight: 1.4 }} />
        <button type="button" onClick={() => { if (composeBody.trim() && composeSubject.trim() && composeRecipientIds.length > 0 && (!composeDeadlineType || composeDeadline)) setShowComposeSendConfirm(true); }}
          disabled={!composeBody.trim() || !composeSubject.trim() || composeRecipientIds.length === 0 || (!!composeDeadlineType && !composeDeadline) || sending}
          style={{ padding: '10px 18px', background: '#007bff', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 14, alignSelf: 'flex-end', opacity: (!composeBody.trim() || !composeSubject.trim() || composeRecipientIds.length === 0 || (!!composeDeadlineType && !composeDeadline) || sending) ? 0.5 : 1, whiteSpace: 'nowrap' }}>
          {sending ? '送信中...' : `送信（${composeRecipientIds.length}人）`}
        </button>
      </div>
    </div>
  );

  // ── 送信トレイ ────────────────────────────────────────────────────
  const outboxDetail = outboxDetailId ? outboxMessages.find(m => m.id === outboxDetailId) : null;

  const outboxPanel = (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: bg }}>
      {outboxDetail ? (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={{ paddingTop: 58 }} />
          <div style={{ flex: 1, overflowY: 'auto', padding: '16px 14px' }}>
            {/* 宛先タグ（10人以上折りたたみ） */}
            {(inboxRecipients[outboxDetail.id] || []).length > 0 && (() => {
              const allIds = inboxRecipients[outboxDetail.id] || [];
              const LIMIT = 10;
              const shown = showAllOutboxRecipients ? allIds : allIds.slice(0, LIMIT);
              return (
                <div style={{ marginBottom: 12, padding: '8px 12px', background: isDark ? '#1e2a3a' : '#eff6ff', borderRadius: 8 }}>
                  <div style={{ fontSize: 12, color: isDark ? '#93c5fd' : '#3b82f6', fontWeight: 700, marginBottom: 6 }}>宛先 {allIds.length}人</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                    {shown.map(uid => (
                      <span key={uid} style={{ padding: '2px 8px', background: isDark ? '#2d3561' : '#dbeafe', color: isDark ? '#93c5fd' : '#1d4ed8', borderRadius: 12, fontSize: 11, fontWeight: 500 }}>
                        {allProfiles.find(p => p.id === uid)?.name || '不明'}
                      </span>
                    ))}
                  </div>
                  {allIds.length > LIMIT && (
                    <button type="button" onClick={() => setShowAllOutboxRecipients(v => !v)}
                      style={{ marginTop: 6, background: 'none', border: 'none', color: '#4a90d9', cursor: 'pointer', fontSize: 12, padding: 0 }}>
                      {showAllOutboxRecipients ? '▲ 閉じる' : `▼ あと${allIds.length - LIMIT}人を表示`}
                    </button>
                  )}
                </div>
              );
            })()}
            {/* 修正モード */}
            {editingNoticeId === outboxDetail.id ? (
              <div style={{ marginTop: 16, padding: '14px', background: isDark ? '#1e2a1e' : '#f0fdf4', border: `1px solid ${isDark ? '#166534' : '#86efac'}`, borderRadius: 10 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: isDark ? '#86efac' : '#166534', marginBottom: 10 }}>✏️ お知らせを修正</div>
                <div style={{ marginBottom: 8 }}>
                  <div style={{ fontSize: 11, color: subColor, marginBottom: 4 }}>件名</div>
                  <input value={editingNoticeSubj} onChange={e => setEditingNoticeSubj(e.target.value)}
                    style={{ width: '100%', padding: '7px 10px', borderRadius: 6, border: `1px solid ${border}`, background: inputBg, color: textColor, fontSize: 13, boxSizing: 'border-box' }} />
                </div>
                <div style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 11, color: subColor, marginBottom: 4 }}>本文</div>
                  <textarea value={editingNoticeBody} onChange={e => setEditingNoticeBody(e.target.value)} rows={5}
                    style={{ width: '100%', padding: '7px 10px', borderRadius: 6, border: `1px solid ${border}`, background: inputBg, color: textColor, fontSize: 13, resize: 'vertical', fontFamily: 'inherit', boxSizing: 'border-box' }} />
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="button" onClick={() => setEditingNoticeId(null)}
                    style={{ flex: 1, padding: '8px 0', background: 'none', border: `1px solid ${border}`, color: subColor, borderRadius: 8, cursor: 'pointer', fontSize: 13 }}>キャンセル</button>
                  <button type="button" onClick={() => saveNoticeEdit(outboxDetail.id)}
                    disabled={!editingNoticeSubj.trim() || !editingNoticeBody.trim()}
                    style={{ flex: 1, padding: '8px 0', background: '#28a745', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600, opacity: (!editingNoticeSubj.trim() || !editingNoticeBody.trim()) ? 0.5 : 1 }}>保存する</button>
                </div>
              </div>
            ) : renderMsg(outboxDetail, false, true)}
            {/* 削除確認 */}
            {deleteConfirmId === outboxDetail.id ? (
              <div style={{ marginTop: 16, padding: '12px 14px', background: isDark ? '#2d1a1a' : '#fff5f5', border: `1px solid ${isDark ? '#7f1d1d' : '#fca5a5'}`, borderRadius: 10 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#dc2626', marginBottom: 6 }}>受信者からも完全削除しますか？</div>
                <div style={{ fontSize: 12, color: subColor, marginBottom: 12 }}>受信者全員の受信トレイからも削除されます。この操作は元に戻せません。</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="button" onClick={() => setDeleteConfirmId(null)}
                    style={{ flex: 1, padding: '8px 0', background: 'none', border: `1px solid ${border}`, color: subColor, borderRadius: 8, cursor: 'pointer', fontSize: 13 }}>キャンセル</button>
                  <button type="button" onClick={() => deleteNotice(outboxDetail.id)}
                    style={{ flex: 1, padding: '8px 0', background: '#dc2626', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>完全削除する</button>
                </div>
              </div>
            ) : editingNoticeId !== outboxDetail.id && (
              <div style={{ marginTop: 16, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button type="button"
                  onClick={() => { setEditingNoticeId(outboxDetail.id); setEditingNoticeSubj(outboxDetail.subject || outboxDetail.title || ''); setEditingNoticeBody(outboxDetail.body); }}
                  style={{ padding: '8px 16px', background: 'none', border: `1.5px solid ${isDark ? '#4ade80' : '#16a34a'}`, color: isDark ? '#4ade80' : '#16a34a', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
                  ✏️ 修正する
                </button>
                {!outboxDetail.outbox_hidden && (
                  <button type="button" onClick={() => archiveOutboxMsg(outboxDetail.id)}
                    title="アーカイブ"
                    style={{ padding: '8px 16px', background: 'none', border: `1.5px solid ${isDark ? '#fd7e14' : '#e67e22'}`, color: isDark ? '#fd7e14' : '#e67e22', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 5 }}>
                    <ArchiveIcon size={14} /> アーカイブ
                  </button>
                )}
                <button type="button" onClick={() => setDeleteConfirmId(outboxDetail.id)}
                  style={{ padding: '8px 16px', background: 'none', border: '1.5px solid #dc3545', color: '#dc3545', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
                  🗑️ 完全削除
                </button>
              </div>
            )}
          </div>
        </div>
      ) : (
        <>
          <div style={{ paddingTop: 56, flexShrink: 0 }}>
            <div style={{ display: 'flex', borderBottom: `1px solid ${border}`, background: cardBg }}>
              {([['sent', '送信済み'], ['scheduled', '📅 予約済み'], ['draft', '下書き'], ['archive', 'アーカイブ']] as const).map(([tab, label]) => (
                <button key={tab} type="button" onClick={() => setOutboxTab(tab)}
                  style={{ flex: 1, padding: '10px 0', background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, fontWeight: outboxTab === tab ? 700 : 400, color: outboxTab === tab ? '#007bff' : subColor, borderBottom: outboxTab === tab ? '2px solid #007bff' : '2px solid transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 3 }}>
                  {tab === 'archive' ? <><ArchiveIcon size={12} /> {label}</> : label}
                </button>
              ))}
            </div>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '8px 12px' }}>
            {outboxTab === 'archive' ? (
              <>
                {/* 一括削除・チェック操作バー */}
                <div style={{ marginBottom: 8 }}>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', padding: '8px 0', background: isDark ? '#2d1a1a' : '#fff5f5', border: `1px solid ${isDark ? '#7f1d1d' : '#fca5a5'}`, borderRadius: 8, marginBottom: 6, paddingLeft: 10 }}>
                    <span style={{ fontSize: 11, color: subColor, alignSelf: 'center', marginRight: 2 }}>🗑️ 一括：</span>
                    {[{ label: '1ヶ月以上前', months: 1 }, { label: '3ヶ月以上前', months: 3 }, { label: '1年以上前', months: 12 }, { label: 'すべて', months: null }].map(({ label, months }) => {
                      const cutoff = months ? new Date(Date.now() - months * 30 * 24 * 60 * 60 * 1000) : null;
                      const targets = cutoff ? outboxArchivedMessages.filter(m => new Date(m.created_at) < cutoff) : outboxArchivedMessages;
                      return (
                        <button key={label} type="button" disabled={targets.length === 0}
                          onClick={() => { setOutboxArchiveSelected(new Set(targets.map(m => m.id))); setOutboxArchiveDelConfirm(true); }}
                          style={{ padding: '3px 10px', borderRadius: 20, border: `1px solid ${isDark ? '#7f1d1d' : '#fca5a5'}`, background: 'none', color: targets.length === 0 ? subColor : '#dc3545', cursor: targets.length === 0 ? 'default' : 'pointer', fontSize: 11, opacity: targets.length === 0 ? 0.5 : 1 }}>
                          {label}（{targets.length}件）
                        </button>
                      );
                    })}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 4px' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, cursor: 'pointer', color: textColor }}>
                      <input type="checkbox"
                        checked={outboxArchiveSelected.size === outboxArchivedMessages.length && outboxArchivedMessages.length > 0}
                        onChange={e => setOutboxArchiveSelected(e.target.checked ? new Set(outboxArchivedMessages.map(m => m.id)) : new Set())} />
                      全て選択
                    </label>
                    {outboxArchiveSelected.size > 0 && (
                      <button type="button" onClick={() => setOutboxArchiveDelConfirm(true)}
                        style={{ padding: '3px 12px', borderRadius: 14, border: 'none', background: '#dc3545', color: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
                        選択した {outboxArchiveSelected.size} 件を削除
                      </button>
                    )}
                    {outboxArchiveSelected.size > 0 && (
                      <button type="button" onClick={() => setOutboxArchiveSelected(new Set())}
                        style={{ padding: '3px 8px', borderRadius: 14, border: `1px solid ${border}`, background: 'none', color: subColor, cursor: 'pointer', fontSize: 12 }}>
                        外す
                      </button>
                    )}
                  </div>
                  {/* 削除確認パネル */}
                  {outboxArchiveDelConfirm && (
                    <div style={{ padding: '10px 12px', background: isDark ? '#2d1a1a' : '#fff5f5', border: `1px solid ${isDark ? '#7f1d1d' : '#fca5a5'}`, borderRadius: 8, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 6 }}>
                      <span style={{ fontSize: 13, color: '#dc3545', flex: 1 }}>
                        {outboxArchiveSelected.size}件を完全削除します。受信者からも削除されます。元に戻せません。
                      </span>
                      <button type="button" onClick={() => setOutboxArchiveDelConfirm(false)}
                        style={{ padding: '4px 12px', border: `1px solid ${border}`, borderRadius: 6, background: 'none', color: subColor, cursor: 'pointer', fontSize: 12 }}>キャンセル</button>
                      <button type="button" onClick={async () => {
                        const ids = [...outboxArchiveSelected];
                        for (const id of ids) {
                          await supabase.from('board_confirmations').delete().eq('message_id', id);
                          await supabase.from('board_reads').delete().eq('message_id', id);
                          await supabase.from('board_message_recipients').delete().eq('message_id', id);
                          await supabase.from('board_messages').delete().eq('id', id);
                        }
                        setOutboxArchivedMessages(prev => prev.filter(m => !ids.includes(m.id)));
                        setOutboxArchiveSelected(new Set());
                        setOutboxArchiveDelConfirm(false);
                      }} style={{ padding: '4px 14px', border: 'none', borderRadius: 6, background: '#dc3545', color: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 700 }}>削除する</button>
                    </div>
                  )}
                </div>
                {outboxArchivedMessages.length === 0 ? (
                  <div style={{ textAlign: 'center', color: subColor, fontSize: 13, marginTop: 30 }}>アーカイブはありません</div>
                ) : outboxArchivedMessages.map(msg => {
                  const recipientIds = inboxRecipients[msg.id] || [];
                  const recipientNames = recipientIds.slice(0, 3).map(uid => allProfiles.find(p => p.id === uid)?.name || '不明');
                  const outSel = outboxArchiveSelected.has(msg.id);
                  return (
                    <div key={msg.id}
                      style={{ background: cardBg, border: outSel ? '1.5px solid #3b82f6' : `1px solid ${border}`, borderRadius: 10, padding: '10px 12px', marginBottom: 6, opacity: 0.85 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <input type="checkbox" checked={outSel}
                            onChange={e => setOutboxArchiveSelected(prev => { const s = new Set(prev); e.target.checked ? s.add(msg.id) : s.delete(msg.id); return s; })}
                            onClick={e => e.stopPropagation()}
                            style={{ width: 15, height: 15, cursor: 'pointer', accentColor: '#3b82f6' }} />
                          <span style={{ fontSize: 10, color: subColor }}>{fmtFull(msg.sent_at || msg.created_at)}</span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ fontSize: 10, color: subColor }}>{recipientIds.length}人</span>
                          <button type="button" onClick={async e => {
                            e.stopPropagation();
                            await supabase.from('board_messages').update({ outbox_hidden: false }).eq('id', msg.id);
                            setOutboxArchivedMessages(prev => prev.filter(m => m.id !== msg.id));
                            setOutboxMessages(prev => [{ ...msg, outbox_hidden: false }, ...prev].sort((a, b) => b.created_at.localeCompare(a.created_at)));
                          }} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 15, padding: '1px 3px', color: subColor }}>
                            📤
                          </button>
                        </div>
                      </div>
                      <div onClick={() => { setOutboxDetailId(msg.id); setShowAllOutboxRecipients(false); }} style={{ cursor: 'pointer' }}>
                        {(msg.subject || msg.title) && (
                          <div style={{ fontSize: 13, fontWeight: 700, color: textColor, marginBottom: 4, paddingBottom: 4, borderBottom: `1px solid ${border}` }}>{msg.subject || msg.title}</div>
                        )}
                        <div style={{ fontSize: 12, color: subColor, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', wordBreak: 'break-word' }}>{msg.body}</div>
                        {recipientNames.length > 0 && (
                          <div style={{ fontSize: 10, color: isDark ? '#93c5fd' : '#3b82f6', marginTop: 4 }}>
                            宛先: {recipientNames.join('、')}{recipientIds.length > 3 ? ` 他${recipientIds.length - 3}人` : ''}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </>
            ) : (
              <>
                {outboxMessages.filter(m => outboxTab === 'sent' ? (m.status !== 'draft' && m.status !== 'scheduled') : m.status === outboxTab).length === 0 ? (
                  <div style={{ textAlign: 'center', color: subColor, fontSize: 13, marginTop: 40 }}>
                    {outboxTab === 'sent' ? '送信済みのお知らせはありません' : outboxTab === 'scheduled' ? '予約済みのお知らせはありません' : '下書きはありません'}
                  </div>
                ) : outboxMessages.filter(m => outboxTab === 'sent' ? (m.status !== 'draft' && m.status !== 'scheduled') : m.status === outboxTab).map(msg => {
                  const recipientIds = inboxRecipients[msg.id] || [];
                  const recipientNames = recipientIds.slice(0, 3).map(uid => allProfiles.find(p => p.id === uid)?.name || '不明');
                  const today = todayJstStr();
                  const isOverdue = msg.deadline ? msg.deadline < today : false;
                  const dtConfig = DEADLINE_TYPES.find(d => d.value === msg.deadline_type);
                  const typeText = dtConfig ? dtConfig.label.replace(/^\S+\s/, '') : '';
                  const confirmedIdsOutbox = (confirmations[msg.id] || []).map(c => c.user_id);
                  const allConfirmed = recipientIds.length > 0 && recipientIds.every(id => confirmedIdsOutbox.includes(id));
                  const accentColor = isOverdue ? '#dc2626' : '#1d4ed8';
                  return (
                    <div key={msg.id}
                      style={{ background: cardBg, border: `1px solid ${border}`, borderRadius: 10, padding: '10px 12px', marginBottom: 6, textAlign: 'left' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}
                        onClick={() => { setOutboxDetailId(msg.id); setShowAllOutboxRecipients(false); }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                          <span style={{ fontSize: 10, color: subColor }}>{fmtFull(outboxTab === 'sent' ? (msg.sent_at || msg.created_at) : msg.created_at)}</span>
                          {outboxTab === 'sent' && msg.scheduled_at && (
                            <span style={{ fontSize: 10, fontWeight: 700, color: '#3b82f6', background: isDark ? '#1e3a5f' : '#dbeafe', borderRadius: 10, padding: '1px 6px' }}>
                              📅予約送信済み
                            </span>
                          )}
                          {outboxTab === 'scheduled' && msg.scheduled_at && (
                            <span style={{ fontSize: 10, color: '#3b82f6' }}>
                              → {fmtFull(msg.scheduled_at)}に送信
                            </span>
                          )}
                          {dtConfig && allConfirmed && <span style={{ fontSize: 10, color: '#22c55e', fontWeight: 700 }}>✓ 完了</span>}
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ fontSize: 10, color: subColor }}>{recipientIds.length}人</span>
                          <button type="button"
                            onClick={e => { e.stopPropagation(); archiveOutboxMsg(msg.id); }}
                            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '1px 3px', color: subColor, display: 'flex', alignItems: 'center' }}
                            title="アーカイブ"><ArchiveIcon size={14} /></button>
                        </div>
                      </div>
                      <div onClick={() => { setOutboxDetailId(msg.id); setShowAllOutboxRecipients(false); }} style={{ cursor: 'pointer' }}>
                        {dtConfig && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                            <div style={{ width: 3, height: 16, background: accentColor, borderRadius: 2, flexShrink: 0 }} />
                            <span style={{ fontSize: 12, fontWeight: 700, color: textColor }}>{typeText === '確認' ? typeText : `${typeText}確認`}</span>
                            {msg.deadline && (
                              allConfirmed ? (
                                <span style={{ fontSize: 10, color: subColor }}>{msg.deadline}まで</span>
                              ) : isOverdue ? (
                                <span style={{ fontSize: 10, display: 'flex', alignItems: 'center', gap: 4 }}>
                                  <span style={{ color: '#dc2626', fontWeight: 600 }}>期限切れ</span>
                                  <span style={{ color: subColor }}>{msg.deadline}まで</span>
                                </span>
                              ) : (
                                <span style={{ fontSize: 10, color: '#d97706', fontWeight: 600 }}>{msg.deadline}まで</span>
                              )
                            )}
                          </div>
                        )}
                        {(msg.subject || msg.title) && (
                          <div style={{ fontSize: 13, fontWeight: 700, color: textColor, marginBottom: 4, paddingBottom: 4, borderBottom: `1px solid ${border}` }}>{msg.subject || msg.title}</div>
                        )}
                        <div style={{ fontSize: 12, color: subColor, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', wordBreak: 'break-word', marginBottom: recipientNames.length > 0 ? 4 : 0 }}>
                          {msg.body}
                        </div>
                        {recipientNames.length > 0 && (
                          <div style={{ fontSize: 10, color: isDark ? '#93c5fd' : '#3b82f6' }}>
                            宛先: {recipientNames.join('、')}{recipientIds.length > 3 ? ` 他${recipientIds.length - 3}人` : ''}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );

  const messagePanel = selectedChannelId && selectedChannel ? (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Messages */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 14px', paddingTop: 110, background: bg }}>
        {channelMessages.length === 0 && (
          <div style={{ textAlign: 'center', color: subColor, fontSize: 13, marginTop: 40 }}>まだメッセージがありません</div>
        )}
        {(() => {
          const unreadStartIdx = prevChannelLastSeen
            ? channelMessages.findIndex(m => new Date(m.created_at) > new Date(prevChannelLastSeen))
            : -1;
          return channelMessages.map((msg, idx) => (
            <React.Fragment key={msg.id}>
              {unreadStartIdx !== -1 && idx === unreadStartIdx && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '10px 0' }}>
                  <div style={{ flex: 1, height: 1, background: '#3b82f6', opacity: 0.5 }} />
                  <span style={{ fontSize: 11, fontWeight: 700, color: '#3b82f6', whiteSpace: 'nowrap', padding: '2px 8px', border: '1px solid #3b82f6', borderRadius: 20 }}>ここから未読</span>
                  <div style={{ flex: 1, height: 1, background: '#3b82f6', opacity: 0.5 }} />
                </div>
              )}
              {renderMsg(msg)}
            </React.Fragment>
          ));
        })()}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      {selectedChannel?.type === 'sent_mail' ? (
        <div style={{ padding: '10px 14px', borderTop: `1px solid ${border}`, background: cardBg, flexShrink: 0, textAlign: 'center', color: subColor, fontSize: 13 }}>
          送信した連絡の履歴です（返信不可）
        </div>
      ) : (
      <div style={{ padding: '10px 14px', borderTop: `1px solid ${border}`, background: cardBg, flexShrink: 0 }}>
        {!canSendInChannel(selectedChannelId) && (
          <div style={{ textAlign: 'center', color: subColor, fontSize: 13, padding: '8px 0' }}>
            このチャンネルへの送信権限がありません
          </div>
        )}
        {canSendInChannel(selectedChannelId) && <>
        {/* 詳細設定（折りたたみ） */}
        <div style={{ marginBottom: 6 }}>
          <button type="button" onClick={() => setShowOptionsExpanded(e => !e)}
            style={{
              width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '6px 10px', borderRadius: showOptionsExpanded ? '8px 8px 0 0' : 8,
              border: `1px solid ${border}`, background: inputBg,
              cursor: 'pointer', color: textColor, fontSize: 12, fontWeight: 600,
            }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 13 }}>⚙️</span>
              件名・期限・種別・送信予約
              {(newTitle || newDeadlineType || newDeadline || newScheduledAt) && (
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#007bff', display: 'inline-block' }} />
              )}
            </span>
            <span style={{ fontSize: 11, color: subColor }}>{showOptionsExpanded ? '▲ 閉じる' : '▼ 開く'}</span>
          </button>
          {showOptionsExpanded && (
            <div style={{ padding: '10px 12px', background: inputBg, borderRadius: '0 0 8px 8px', border: `1px solid ${border}`, borderTop: 'none', display: 'flex', flexDirection: 'column', gap: 10 }}>
              {/* 件名 */}
              <div>
                <div style={{ fontSize: 11, color: textColor, fontWeight: 600, marginBottom: 4 }}>件名（省略可）</div>
                <input type="text" value={newTitle} onChange={e => setNewTitle(e.target.value)}
                  placeholder="件名を入力..."
                  style={{ width: '100%', padding: '6px 10px', borderRadius: 6, border: `1px solid ${border}`, background: isDark ? '#2a2a42' : '#fff', color: textColor, fontSize: 13, boxSizing: 'border-box' }} />
              </div>
              {/* 種別ボタングリッド */}
              <div>
                <div style={{ fontSize: 11, color: textColor, fontWeight: 600, marginBottom: 6 }}>種別（選ぶと確認ボタンが付きます）</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                  {DEADLINE_TYPES.map(dt => (
                    <button key={dt.value} type="button"
                      onClick={() => setNewDeadlineType(prev => prev === dt.value ? '' : dt.value)}
                      style={{ padding: '8px 4px', borderRadius: 8, border: `2px solid ${newDeadlineType === dt.value ? '#007bff' : border}`, background: newDeadlineType === dt.value ? '#007bff' : 'transparent', color: newDeadlineType === dt.value ? '#fff' : textColor, cursor: 'pointer', fontSize: 13, fontWeight: newDeadlineType === dt.value ? 'bold' : 'normal' }}>
                      {dt.label}
                    </button>
                  ))}
                </div>
              </div>
              {/* 内容・場所・URL */}
              {newDeadlineType && (
                <>
                  <div>
                    <div style={{ fontSize: 11, color: textColor, fontWeight: 600, marginBottom: 4 }}>内容（何を{DEADLINE_TYPES.find(d => d.value === newDeadlineType)?.label.replace(/\S+\s/, '') ?? ''}するのか）</div>
                    <input type="text" value={newAnswerPrompt} onChange={e => setNewAnswerPrompt(e.target.value)}
                      placeholder={DEADLINE_TYPES.find(d => d.value === newDeadlineType)?.promptPlaceholder ?? ''}
                      style={{ width: '100%', padding: '6px 10px', borderRadius: 6, border: `1px solid ${border}`, background: isDark ? '#2a2a42' : '#fff', color: textColor, fontSize: 13, boxSizing: 'border-box' }} />
                  </div>
                  <div>
                    <div style={{ fontSize: 11, color: textColor, fontWeight: 600, marginBottom: 4 }}>保存先（どこで{DEADLINE_TYPES.find(d => d.value === newDeadlineType)?.label.replace(/\S+\s/, '') ?? ''}するのか）</div>
                    <input type="text" value={newAnswerLocation} onChange={e => setNewAnswerLocation(e.target.value)}
                      placeholder={DEADLINE_TYPES.find(d => d.value === newDeadlineType)?.locationPlaceholder ?? ''}
                      style={{ width: '100%', padding: '6px 10px', borderRadius: 6, border: `1px solid ${border}`, background: isDark ? '#2a2a42' : '#fff', color: textColor, fontSize: 13, boxSizing: 'border-box' }} />
                  </div>
                  <div>
                    <div style={{ fontSize: 11, color: textColor, fontWeight: 600, marginBottom: 4 }}>リンク（URL）</div>
                    <input type="url" value={newAnswerLink} onChange={e => setNewAnswerLink(e.target.value)}
                      placeholder={DEADLINE_TYPES.find(d => d.value === newDeadlineType)?.linkPlaceholder ?? 'https://...'}
                      style={{ width: '100%', padding: '6px 10px', borderRadius: 6, border: `1px solid ${border}`, background: isDark ? '#2a2a42' : '#fff', color: textColor, fontSize: 13, boxSizing: 'border-box' }} />
                  </div>
                </>
              )}
              {/* 期限日 */}
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 12, color: textColor, fontWeight: 600, flexShrink: 0 }}>⏰ 期限日{newDeadlineType && <span style={{ color: '#dc3545' }}> *必須</span>}</span>
                  <input type="date" value={newDeadline} onChange={e => setNewDeadline(e.target.value)}
                    min={todayJstStr()}
                    style={{ fontSize: 12, padding: '4px 8px', borderRadius: 6, border: `1.5px solid ${newDeadlineType && !newDeadline ? '#dc3545' : border}`, background: isDark ? '#2a2a42' : '#fff', color: textColor, cursor: 'pointer', flex: 1 }} />
                  {newDeadline && <button type="button" onClick={() => setNewDeadline('')} style={{ fontSize: 11, color: subColor, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>✕</button>}
                </div>
                {newDeadlineType && !newDeadline && (
                  <div style={{ fontSize: 11, color: '#dc3545', marginTop: 3 }}>種別を選んだ場合、期限日の入力が必要です</div>
                )}
              </div>
              {/* 送信予約 */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 12, color: textColor, fontWeight: 600, flexShrink: 0 }}>🕐 送信予約</span>
                <input type="datetime-local" value={newScheduledAt} onChange={e => setNewScheduledAt(e.target.value)}
                  min={localDatetimeMin()}
                  style={{ fontSize: 12, padding: '4px 8px', borderRadius: 6, border: `1px solid ${border}`, background: isDark ? '#2a2a42' : '#fff', color: textColor, cursor: 'pointer', flex: 1 }} />
                {newScheduledAt && <button type="button" onClick={() => setNewScheduledAt('')} style={{ fontSize: 11, color: subColor, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>✕</button>}
              </div>
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <textarea
            value={newBody}
            onChange={e => setNewBody(e.target.value)}
            placeholder="メッセージを入力... (Ctrl+Enterで送信)"
            rows={2}
            onKeyDown={e => { if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); if (newBody.trim() && (!newDeadlineType || newDeadline)) setShowSendConfirm(true); }}}
            style={{ flex: 1, padding: '8px 12px', borderRadius: 8, border: `1px solid ${border}`, background: inputBg, color: textColor, fontSize: 14, resize: 'none', fontFamily: 'inherit', lineHeight: 1.4 }}
          />
          <button
            type="button"
            onClick={() => { if (newBody.trim() && (!newDeadlineType || newDeadline)) setShowSendConfirm(true); }}
            disabled={sending || !newBody.trim() || (!!newDeadlineType && !newDeadline)}
            style={{ padding: '10px 18px', background: '#007bff', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 14, alignSelf: 'flex-end', opacity: sending || !newBody.trim() || (!!newDeadlineType && !newDeadline) ? 0.5 : 1 }}
          >
            {sending ? '送信中' : '送信'}
          </button>
        </div>
        </>}
      </div>
      )}
    </div>
  ) : (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: bg }}>
      <div style={{ fontSize: 48, marginBottom: 12 }}>💬</div>
      <div style={{ fontSize: 15, color: subColor }}>チャンネルを選択してください</div>
      {isAdmin && (
        <button type="button" onClick={() => setShowGroupModal(true)} style={{ marginTop: 16, padding: '10px 20px', background: '#6f42c1', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 14 }}>＋ グループを作成</button>
      )}
    </div>
  );

  // ── Render ───────────────────────────────────────────────────────

  const viewTitle: Record<View, string> = {
    inbox:     '📥 受信トレイ',
    outbox:    '📤 送信トレイ',
    compose:   '✉️ お知らせを作成',
    channel:   selectedChannel ? (selectedChannel.type === 'group' ? `👥 ${channelDisplayName(selectedChannel)}` : channelDisplayName(selectedChannel)) : '',
    search:    `🔍 「${searchText}」の検索結果`,
    favorites: '⭐ お気に入り',
  };

  // ── 検索結果のマッチ箇所をハイライト ──────────────────────────────
  const highlightMatch = (text: string, query: string) => {
    if (!query) return <span>{text}</span>;
    const idx = text.toLowerCase().indexOf(query.toLowerCase());
    if (idx < 0) return <span>{text}</span>;
    const start = Math.max(0, idx - 30);
    const excerpt = (start > 0 ? '…' : '') + text.slice(start, start + 120) + (start + 120 < text.length ? '…' : '');
    const eIdx = excerpt.toLowerCase().indexOf(query.toLowerCase());
    if (eIdx < 0) return <span>{excerpt}</span>;
    return (
      <span>
        {excerpt.slice(0, eIdx)}
        <mark style={{ background: isDark ? '#854d0e' : '#fef08a', color: textColor, borderRadius: 2, padding: '0 2px' }}>
          {excerpt.slice(eIdx, eIdx + query.length)}
        </mark>
        {excerpt.slice(eIdx + query.length)}
      </span>
    );
  };

  const favoritesPanel = (
    <div style={{ flex: 1, overflowY: 'auto', padding: '12px 14px', paddingTop: 62 }}>
      {favChannelIds.size === 0 && favMessageIds.size === 0 ? (
        <div style={{ textAlign: 'center', color: subColor, fontSize: 14, marginTop: 60 }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>⭐</div>
          <div>お気に入りがまだありません</div>
          <div style={{ fontSize: 12, marginTop: 8 }}>チャンネルやメッセージの ☆ をタップして追加できます</div>
        </div>
      ) : (
        <>
          {favChannelIds.size > 0 && (
            <>
              <div style={{ fontSize: 12, fontWeight: 700, color: subColor, marginBottom: 8, marginTop: 4 }}>チャンネル</div>
              {channels.filter(c => favChannelIds.has(c.id)).map(ch => (
                <div key={`fav-ch-${ch.id}`} onClick={() => { selectChannel(ch.id); setView('channel'); setShowSidebar(false); }} style={{
                  background: cardBg, border: `1px solid ${border}`, borderRadius: 10, padding: '10px 14px',
                  marginBottom: 8, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 12,
                }}>
                  <div style={{ width: 34, height: 34, borderRadius: ch.type === 'group' ? 8 : '50%', background: ch.type === 'group' ? '#6f42c1' : '#4a90d9', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 16, flexShrink: 0 }}>
                    {ch.type === 'group' ? '👥' : avatarLetter(channelDisplayName(ch))}
                  </div>
                  <span style={{ flex: 1, fontSize: 14, fontWeight: 500, color: textColor }}>{channelDisplayName(ch)}</span>
                  <button type="button" onClick={e => toggleFavChannel(e, ch.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, padding: 0, color: '#f59e0b' }}>★</button>
                </div>
              ))}
            </>
          )}
          {favMessages.length > 0 && (
            <>
              <div style={{ fontSize: 12, fontWeight: 700, color: subColor, marginBottom: 8, marginTop: favChannelIds.size > 0 ? 16 : 4 }}>メッセージ</div>
              {favMessages.map(msg => {
                const senderName = allProfiles.find(p => p.id === msg.user_id)?.name || '不明';
                const ch = channels.find(c => c.id === msg.channel_id);
                const isGroupOrDm = !!ch && (ch.type === 'group' || ch.type === 'dm');
                const borderColor = ch
                  ? (ch.type === 'group' ? '#4a90d9' : ch.type === 'dm' ? '#6f42c1' : '#f59e0b')
                  : '#f59e0b';
                const typeLabel = ch
                  ? (ch.type === 'group'
                      ? `# ${ch.name || 'グループ'}`
                      : ch.type === 'dm'
                        ? `💬 ${channelDisplayName(ch)}`
                        : `📢 ${msg.title || 'お知らせ'}`)
                  : `📢 ${msg.title || 'お知らせ'}`;
                const isUnread = favUnreadIds.has(msg.id);

                const handleFavMsgClick = async () => {
                  if (isUnread && user) {
                    await supabase.from('board_reads').upsert(
                      { message_id: msg.id, user_id: user.id },
                      { onConflict: 'message_id,user_id', ignoreDuplicates: true }
                    );
                    setFavUnreadIds(prev => { const s = new Set(prev); s.delete(msg.id); return s; });
                  }
                  if (isGroupOrDm && msg.channel_id) {
                    selectChannel(msg.channel_id); setView('channel'); setShowSidebar(false);
                  } else {
                    setInboxDetailId(msg.id); setView('inbox'); setShowSidebar(false);
                  }
                };

                return (
                  <div key={`fav-msg-${msg.id}`} onClick={handleFavMsgClick} style={{
                    background: cardBg,
                    borderTop: `1px solid ${border}`,
                    borderRight: `1px solid ${border}`,
                    borderBottom: `1px solid ${border}`,
                    borderLeft: `4px solid ${borderColor}`,
                    borderRadius: 10,
                    padding: '10px 14px',
                    marginBottom: 8,
                    cursor: 'pointer',
                  }}>
                    {/* 種別ラベル行 */}
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                      <span style={{ fontSize: 11, fontWeight: 600, color: borderColor }}>{typeLabel}</span>
                      {isUnread && (
                        <span style={{ width: 9, height: 9, borderRadius: '50%', background: '#3b82f6', display: 'inline-block', flexShrink: 0 }} />
                      )}
                    </div>
                    {/* 送信者行 */}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div style={{ width: 28, height: 28, borderRadius: '50%', background: '#4a90d9', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 12, fontWeight: 'bold', flexShrink: 0 }}>
                          {avatarLetter(senderName)}
                        </div>
                        <span style={{ fontSize: 13, fontWeight: 'bold', color: textColor }}>{senderName}</span>
                        <span style={{ fontSize: 11, color: subColor }}>{fmtFull(msg.created_at)}</span>
                      </div>
                      <button type="button" onClick={e => toggleFavMessage(e, msg.id, msg)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, padding: 0, color: '#f59e0b', flexShrink: 0 }}>★</button>
                    </div>
                    {/* タイトル */}
                    {(msg.subject || msg.title) && (
                      <div style={{ fontSize: 14, fontWeight: 700, color: textColor, marginTop: 6, paddingBottom: 6, borderBottom: `1px solid ${border}`, textAlign: 'left' }}>{msg.subject || msg.title}</div>
                    )}
                    {/* 本文プレビュー */}
                    <div style={{ fontSize: 13, color: subColor, marginTop: 4, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', wordBreak: 'break-word', textAlign: 'left' }}>{msg.body}</div>
                  </div>
                );
              })}
            </>
          )}
        </>
      )}
    </div>
  );

  const searchPanel = (
    <div style={{ flex: 1, overflowY: 'auto', padding: '12px 14px', paddingTop: 62 }}>
      {searchLoading ? (
        <div style={{ textAlign: 'center', color: subColor, fontSize: 14, marginTop: 40 }}>検索中...</div>
      ) : searchResults.length === 0 ? (
        <div style={{ textAlign: 'center', color: subColor, fontSize: 14, marginTop: 40 }}>
          「{searchText}」に一致するメッセージがありません
        </div>
      ) : (
        <>
          <div style={{ fontSize: 12, color: subColor, marginBottom: 10 }}>{searchResults.length}件のメッセージが見つかりました</div>
          {searchResults.map(msg => {
            const senderName = allProfiles.find(p => p.id === msg.user_id)?.name || '不明';
            const ch = channels.find(c => c.id === msg.channel_id);
            const chLabel = ch ? (ch.type === 'group' ? `👥 ${ch.name || 'グループ'}` : ch.type === 'dm' ? '💬 DM' : '📧 送信メール') : '📥 受信トレイ';
            const matchBody = msg.body.toLowerCase().includes(searchText.toLowerCase());
            const matchSubject = msg.subject && msg.subject.toLowerCase().includes(searchText.toLowerCase());
            return (
              <div key={msg.id}
                onClick={() => {
                  if (msg.channel_id) {
                    selectChannel(msg.channel_id);
                    setView('channel');
                  } else {
                    setView('inbox');
                    setInboxDetailId(msg.id);
                  }
                  setShowSearch(false);
                  setSearchText('');
                }}
                style={{ background: cardBg, border: `1px solid ${border}`, borderRadius: 10, padding: '10px 14px', marginBottom: 10, cursor: 'pointer' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <span style={{ fontSize: 11, color: '#4a90d9', fontWeight: 600 }}>{chLabel}</span>
                  <span style={{ fontSize: 11, color: subColor }}>·</span>
                  <span style={{ fontSize: 11, fontWeight: 600, color: textColor }}>{senderName}</span>
                  <span style={{ fontSize: 11, color: subColor, marginLeft: 'auto' }}>{fmtFull(msg.created_at)}</span>
                </div>
                {(matchSubject || msg.subject) && (
                  <div style={{ fontSize: 13, fontWeight: 700, color: textColor, marginBottom: 6, paddingBottom: 6, borderBottom: `1px solid ${border}`, textAlign: 'left' }}>
                    {matchSubject ? highlightMatch(msg.subject!, searchText) : msg.subject}
                  </div>
                )}
                <div style={{ fontSize: 13, color: subColor, lineHeight: 1.5, textAlign: 'left' }}>
                  {matchBody ? highlightMatch(msg.body, searchText) : <span>{msg.body.slice(0, 80)}{msg.body.length > 80 ? '…' : ''}</span>}
                </div>
              </div>
            );
          })}
        </>
      )}
    </div>
  );

  return (
    <div style={{ height: '100dvh', display: 'flex', flexDirection: 'column', background: bg, overflow: 'hidden', paddingTop: 60, boxSizing: 'border-box' } as React.CSSProperties}>
      {sendError && (
        <div style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', zIndex: 9999, background: '#fff5f5', border: '1px solid #f5b5b5', borderRadius: 12, padding: '16px 22px', boxShadow: '0 4px 20px rgba(0,0,0,0.15)', display: 'flex', alignItems: 'center', gap: 10, maxWidth: 320 }}>
          <span style={{ fontSize: 18 }}>⚠️</span>
          <span style={{ fontSize: 14, fontWeight: 'bold', color: '#dc3545' }}>{sendError}</span>
          <button type="button" onClick={() => setSendError(null)} style={{ marginLeft: 'auto', background: 'none', border: 'none', color: '#dc3545', cursor: 'pointer', fontSize: 16, padding: '0 4px' }}>✕</button>
        </div>
      )}
      {confirmDialog && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }} onClick={() => setConfirmDialog(null)}>
          <div onClick={e => e.stopPropagation()} style={{ background: cardBg, borderRadius: 12, padding: '22px 24px', boxShadow: '0 4px 20px rgba(0,0,0,0.25)', maxWidth: 360, width: '100%' }}>
            <p style={{ fontSize: 15, fontWeight: 'bold', color: textColor, margin: '0 0 18px', lineHeight: 1.6, whiteSpace: 'pre-line' }}>{confirmDialog.message}</p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setConfirmDialog(null)} style={{ padding: '8px 18px', background: 'transparent', color: subColor, border: `1px solid ${border}`, borderRadius: 8, cursor: 'pointer', fontSize: 14 }}>キャンセル</button>
              <button onClick={() => { const cb = confirmDialog.onConfirm; setConfirmDialog(null); cb(); }} style={{ padding: '8px 18px', background: '#dc3545', color: 'white', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 'bold', fontSize: 14 }}>削除する</button>
            </div>
          </div>
        </div>
      )}
      {/* サイドバーヘッダー */}
      {(showSidebar || !isMobile) && (
        <div style={{ position: 'fixed', top: 'var(--topbar-height, 60px)' as string, left: 0, zIndex: 50, background: cardBg, width: isMobile ? '100%' : 280, boxSizing: 'border-box' }}>
          <div style={{ padding: '8px 12px', height: 56, boxSizing: 'border-box', borderBottom: `1px solid ${border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
            <span style={{ fontSize: 15, fontWeight: 'bold', color: textColor, flexShrink: 0 }}>💬 連絡板</span>
            <div style={{ display: 'flex', gap: 5, flexWrap: 'nowrap', flexShrink: 0 }}>
              <button type="button" title="検索" onClick={() => { setShowSearch(s => !s); setSearchText(''); setSearchResults([]); if (view === 'search') navigate(-1); }}
                style={{ background: 'none', border: `1px solid ${border}`, borderRadius: 6, color: subColor, cursor: 'pointer', fontSize: 14, padding: '5px 7px', lineHeight: 1, flexShrink: 0 }}>🔍</button>
              {(isAdmin || noticeSendRoles.length === 0 || noticeSendRoles.includes(roleTitle)) && (
                <button type="button" onClick={openCompose}
                  style={{ background: '#007bff', border: 'none', borderRadius: 6, color: '#fff', cursor: 'pointer', fontSize: 12, padding: '5px 10px', fontWeight: 'bold', whiteSpace: 'nowrap', flexShrink: 0 }}>＋お知らせ送信</button>
              )}
              <button type="button" title="通知設定" onClick={() => navigate('/notification-settings')}
                style={{ background: 'none', border: `1px solid ${border}`, borderRadius: 6, color: isDark ? '#6b7280' : '#9ca3af', cursor: 'pointer', fontSize: 11, padding: '5px 8px', lineHeight: 1, flexShrink: 0, whiteSpace: 'nowrap' }}>通知設定</button>
            </div>
          </div>
          {showSearch && (
            <div style={{ padding: '0 14px 10px' }}>
              <input
                autoFocus
                value={searchText}
                onChange={e => setSearchText(e.target.value)}
                placeholder="メッセージを検索..."
                style={{ width: '100%', boxSizing: 'border-box', padding: '6px 10px', borderRadius: 8, border: `1px solid ${border}`, background: bg, color: textColor, fontSize: 13 }}
              />
            </div>
          )}
        </div>
      )}
      {/* コンテンツヘッダー（モバイル: サイドバー非表示時、デスクトップ: 常時） */}
      {(!showSidebar || !isMobile) && (
        <div style={{ position: 'fixed', top: 'var(--topbar-height, 60px)' as string, left: isMobile ? 0 : 280, right: 0, zIndex: 50, padding: '8px 14px', height: 56, boxSizing: 'border-box', borderBottom: `1px solid ${border}`, background: cardBg, display: 'flex', alignItems: 'center', gap: 8 }}>
          {isMobile && (
            <button type="button" onClick={() => navigate(-1)}
              style={{ background: 'none', border: 'none', color: '#4a90d9', cursor: 'pointer', fontSize: 22, padding: '0 6px', lineHeight: 1, fontWeight: 'bold' }}>←</button>
          )}
          {view === 'channel' && selectedChannel ? (
            <>
              <div style={{ width: 32, height: 32, borderRadius: selectedChannel.type === 'group' ? 8 : '50%', background: selectedChannel.type === 'group' ? '#6f42c1' : '#4a90d9', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 14, flexShrink: 0 }}>
                {selectedChannel.type === 'group' ? '👥' : avatarLetter(channelDisplayName(selectedChannel))}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 'bold', color: textColor, lineHeight: 1.2 }}>{channelDisplayName(selectedChannel)}</div>
                <div style={{ fontSize: 11, color: subColor, lineHeight: 1.2 }}>{currentMembers.length}人</div>
              </div>
              <button type="button" onClick={openMemberModal} style={{ background: 'none', border: `1px solid ${border}`, borderRadius: 6, color: subColor, cursor: 'pointer', fontSize: 12, padding: '4px 8px', flexShrink: 0 }}>👥 メンバー</button>
            </>
          ) : (
            <span style={{ fontSize: 15, fontWeight: 'bold', color: textColor }}>
              {view === 'inbox' && inboxDetailId ? '📨 受信メッセージ'
                : view === 'outbox' && outboxDetailId ? '📤 送信メッセージ'
                : viewTitle[view]}
            </span>
          )}
        </div>
      )}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* サイドバー */}
        {(showSidebar || !isMobile) && channelListPanel}
        {/* コンテンツエリア */}
        {(!showSidebar || !isMobile) && (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            {view === 'favorites' && favoritesPanel}
            {view === 'search'    && searchPanel}
            {view === 'inbox'     && inboxPanel}
            {view === 'outbox'    && outboxPanel}
            {view === 'compose'   && composePanel}
            {view === 'channel'   && messagePanel}
          </div>
        )}
      </div>
      {threadPanel}
      {groupModal}
      {memberModal}
      {dmModal}
      {readDetailMsgId && (() => {
        const readDetailMsg = [...messages, ...inboxMessages, ...outboxMessages, ...archivedMessages].find(m => m.id === readDetailMsgId);
        const chMembers = readDetailMsg?.channel_id
          ? members.filter(m => m.channel_id === readDetailMsg.channel_id).map(m => ({ user_id: m.user_id }))
          : (inboxRecipients[readDetailMsgId] || []).map(uid => ({ user_id: uid }));
        const readMap = new Map(readDetailUsers.map(r => [r.user_id, r.read_at]));
        const fmtReadAt = (at: string | null | undefined) => {
          if (!at) return '';
          const hasOffset = at.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(at);
          const d = new Date(hasOffset ? at : at + 'Z');
          if (isNaN(d.getTime())) return '';
          return `${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
        };
        const readMembers   = chMembers.filter(m => readMap.has(m.user_id));
        const unreadMembers = chMembers.filter(m => !readMap.has(m.user_id));
        const headerColor = isDark ? '#8fa8c8' : '#4a6a9a';
        return (
          <div style={overlayStyle} onClick={() => setReadDetailMsgId(null)}>
            <div style={{ ...modalStyle, maxWidth: 340 }} onClick={e => e.stopPropagation()}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
                <span style={{ fontSize: 16, fontWeight: 'bold', color: textColor }}>既読状況</span>
                <button type="button" onClick={() => setReadDetailMsgId(null)} style={{ background: 'none', border: 'none', color: subColor, cursor: 'pointer', fontSize: 18, padding: 0 }}>✕</button>
              </div>
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 12, fontWeight: 'bold', color: headerColor, marginBottom: 6 }}>既読 {readMembers.length}人</div>
                {readMembers.length === 0
                  ? <div style={{ fontSize: 13, color: subColor }}>まだ誰も読んでいません</div>
                  : readMembers.map((m, i) => {
                    const name = allProfiles.find(p => p.id === m.user_id)?.name || '不明';
                    const at = readMap.get(m.user_id) || '';
                    return (
                      <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13, color: textColor, padding: '5px 0', borderBottom: `1px solid ${border}` }}>
                        <span>{name}</span>
                        <span style={{ fontSize: 11, color: subColor }}>{fmtReadAt(at)}</span>
                      </div>
                    );
                  })
                }
              </div>
              <div>
                <div style={{ fontSize: 12, fontWeight: 'bold', color: headerColor, marginBottom: 6 }}>未読 {unreadMembers.length}人</div>
                {unreadMembers.length === 0
                  ? <div style={{ fontSize: 13, color: subColor }}>全員が既読です</div>
                  : unreadMembers.map((m, i) => {
                    const name = allProfiles.find(p => p.id === m.user_id)?.name || '不明';
                    return (
                      <div key={i} style={{ fontSize: 13, color: textColor, padding: '5px 0', borderBottom: `1px solid ${border}` }}>{name}</div>
                    );
                  })
                }
              </div>
            </div>
          </div>
        );
      })()}
      {/* 送信確認モーダル */}
      {showSendConfirm && (() => {
        const dtConfig = DEADLINE_TYPES.find(d => d.value === newDeadlineType);
        const today = todayJstStr();
        const isOverdue = newDeadline ? newDeadline < today : false;
        const isToday   = newDeadline ? newDeadline === today : false;
        const accentColor = isOverdue ? '#dc2626' : isToday ? '#d97706' : '#1d4ed8';
        return (
          <div onClick={() => setShowSendConfirm(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 5000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
            <div onClick={e => e.stopPropagation()} style={{ background: cardBg, borderRadius: 16, padding: '16px 16px 20px', width: '100%', maxWidth: 420, boxSizing: 'border-box' }}>
              <p style={{ margin: '0 0 12px', fontSize: 15, fontWeight: 'bold', color: textColor, textAlign: 'center' }}>送信プレビュー</p>
              {/* メッセージカードプレビュー */}
              <div style={{ background: isDark ? '#2a2a3e' : '#f8f9fa', borderRadius: 10, padding: '12px 14px', border: `1px solid ${border}`, marginBottom: 14 }}>
                {/* 送信者行 */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <div style={{ width: 28, height: 28, borderRadius: '50%', background: '#4a90d9', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 12, fontWeight: 'bold', flexShrink: 0 }}>
                    {avatarLetter(profileName)}
                  </div>
                  <span style={{ fontSize: 13, fontWeight: 'bold', color: textColor }}>{profileName || '自分'}</span>
                  <span style={{ fontSize: 11, color: subColor }}>今</span>
                </div>
                {/* 件名 */}
                {newTitle && (
                  <div style={{ fontSize: 15, fontWeight: 700, color: textColor, marginBottom: 6, textAlign: 'left' }}>{newTitle}</div>
                )}
                {/* 種別・期限バッジ */}
                {dtConfig && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, paddingBottom: 8, borderBottom: `1px solid ${border}` }}>
                    {(() => { const t = dtConfig.label.replace(/^\S+\s/, ''); return <span style={{ fontSize: 17, fontWeight: 700, color: textColor }}>{t === '確認' ? t : `${t}確認`}</span>; })()}
                    {newDeadline && (
                      <div style={{ display: 'inline-flex', alignItems: 'center', borderRadius: 20, overflow: 'hidden', border: `1.5px solid ${accentColor}` }}>
                        <span style={{ fontSize: 11, fontWeight: 700, color: '#fff', background: accentColor, padding: '2px 8px' }}>{isOverdue ? '期限切れ' : isToday ? '本日締切' : '期限'}</span>
                        <span style={{ fontSize: 11, color: accentColor, padding: '2px 8px' }}>{newDeadline.replace(/-/g, '/')}まで</span>
                      </div>
                    )}
                  </div>
                )}
                {/* 内容・保存先・URL */}
                {(newAnswerPrompt || newAnswerLocation || newAnswerLink) && (
                  <div style={{ marginBottom: 8, padding: '7px 10px', background: isDark ? '#1e2a3a' : '#eff6ff', borderRadius: 8, borderLeft: '3px solid #3b82f6', display: 'flex', flexDirection: 'column', gap: 4, textAlign: 'left' }}>
                    {newAnswerPrompt && <div style={{ fontSize: 12, color: textColor }}><span style={{ color: '#3b82f6', marginRight: 6 }}>内容</span>{newAnswerPrompt}</div>}
                    {newAnswerLocation && <div style={{ fontSize: 12, color: textColor }}><span style={{ color: '#3b82f6', marginRight: 6 }}>保存先</span>{newAnswerLocation}</div>}
                    {newAnswerLink && <div style={{ fontSize: 12, color: '#2563eb', wordBreak: 'break-all' }}><span style={{ color: '#3b82f6', marginRight: 6 }}>URL</span>{newAnswerLink}</div>}
                  </div>
                )}
                {/* 本文 */}
                <div style={{ fontSize: 14, color: textColor, whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.6, maxHeight: 180, overflowY: 'auto', textAlign: 'left' }}>
                  {newBody}
                </div>
                {/* 送信予約 */}
                {newScheduledAt && (
                  <div style={{ marginTop: 8, fontSize: 12, color: '#6f42c1' }}>
                    🕐 送信予約: {new Date(newScheduledAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <button type="button" onClick={() => setShowSendConfirm(false)}
                  style={{ flex: 1, padding: '10px 0', background: 'none', border: `1px solid ${border}`, borderRadius: 8, color: subColor, cursor: 'pointer', fontSize: 14 }}>
                  キャンセル
                </button>
                <button type="button" onClick={() => { setShowSendConfirm(false); sendMessage(); }}
                  style={{ flex: 2, padding: '10px 0', background: '#007bff', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 14, fontWeight: 'bold' }}>
                  送信する
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* リプライ送信確認モーダル */}
      {showReplySendConfirm && threadMsgId && (
        <div onClick={() => setShowReplySendConfirm(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 5000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div onClick={e => e.stopPropagation()} style={{ background: cardBg, borderRadius: 16, padding: 20, width: '100%', maxWidth: 420, boxSizing: 'border-box' }}>
            <p style={{ margin: '0 0 12px', fontSize: 16, fontWeight: 'bold', color: textColor }}>リプライを送信しますか？</p>
            <div style={{ background: inputBg, borderRadius: 10, padding: '12px 14px', marginBottom: 16, fontSize: 14, color: textColor, whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.6, maxHeight: 200, overflowY: 'auto', textAlign: 'left' }}>
              {replyBody}
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button type="button" onClick={() => setShowReplySendConfirm(false)}
                style={{ flex: 1, padding: '10px 0', background: 'none', border: `1px solid ${border}`, borderRadius: 8, color: subColor, cursor: 'pointer', fontSize: 14 }}>
                キャンセル
              </button>
              <button type="button" onClick={() => { setShowReplySendConfirm(false); sendMessage(threadMsgId); }}
                style={{ flex: 2, padding: '10px 0', background: '#28a745', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 14, fontWeight: 'bold' }}>
                送信する
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 未確認者一覧モーダル */}
      {unconfirmedMsgId && (() => {
        const msg = messages.find(m => m.id === unconfirmedMsgId);
        if (!msg) return null;
        const confirmedObjs2 = confirmations[unconfirmedMsgId] || [];
        const confirmedIds = confirmedObjs2.map(c => c.user_id);
        const channelMemberIds = members.filter(m => m.channel_id === msg.channel_id).map(m => m.user_id);
        const unconfirmedUserIds = channelMemberIds.filter(id => !confirmedIds.includes(id));
        return (
          <div style={overlayStyle} onClick={() => setUnconfirmedMsgId(null)}>
            <div style={{ ...modalStyle, maxWidth: 380 }} onClick={e => e.stopPropagation()}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
                <span style={{ fontSize: 16, fontWeight: 'bold', color: textColor }}>確認状況</span>
                <button type="button" onClick={() => setUnconfirmedMsgId(null)} style={{ background: 'none', border: 'none', color: subColor, cursor: 'pointer', fontSize: 18, padding: 0 }}>✕</button>
              </div>
              <div style={{ fontSize: 12, color: subColor, marginBottom: 12, padding: '8px 10px', background: inputBg, borderRadius: 8, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {msg.body.slice(0, 80)}{msg.body.length > 80 ? '…' : ''}
              </div>
              {unconfirmedUserIds.length > 0 && (
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 12, fontWeight: 'bold', color: '#dc3545', marginBottom: 6 }}>未確認 {unconfirmedUserIds.length}人</div>
                  {unconfirmedUserIds.map(uid => {
                    const p = allProfiles.find(ap => ap.id === uid);
                    return <div key={uid} style={{ fontSize: 13, color: textColor, padding: '5px 0', borderBottom: `1px solid ${border}` }}>{p?.name || '不明'}</div>;
                  })}
                </div>
              )}
              {confirmedIds.length > 0 && (
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 12, fontWeight: 'bold', color: '#28a745', marginBottom: 6 }}>確認済み {confirmedIds.length}人</div>
                  {confirmedObjs2.map(c => {
                    const p = allProfiles.find(ap => ap.id === c.user_id);
                    return (
                      <div key={c.user_id} style={{ fontSize: 13, color: subColor, padding: '5px 0', borderBottom: `1px solid ${border}` }}>
                        ✅ {p?.name || '不明'}
                        {c.comment && <span style={{ display: 'block', fontSize: 12, color: textColor, marginTop: 2, paddingLeft: 18 }}>{c.comment}</span>}
                      </div>
                    );
                  })}
                </div>
              )}
              {unconfirmedUserIds.length === 0 && (
                <div style={{ fontSize: 14, color: '#28a745', textAlign: 'center', padding: '12px 0' }}>全員が確認済みです ✅</div>
              )}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
                {unconfirmedUserIds.length > 0 && (
                  <button type="button" onClick={async () => {
                    // ベル通知を登録すると、push_queueトリガー→push-dispatchワーカー経由で
                    // プッシュ通知も自動で届く（プッシュ文面はワーカー側の固定の安全文面）
                    await Promise.all(unconfirmedUserIds.map(uid =>
                      insertNotification(uid, `【リマインド】${msg.subject || 'お知らせ'}への対応がまだ完了していません`, msg.body.slice(0, 40), undefined, unconfirmedMsgId ?? undefined, 'board:confirm_request')
                    ));
                    setUnconfirmedMsgId(null);
                    setSaveBanner(true);
                    setTimeout(() => setSaveBanner(false), 3000);
                  }} style={{ padding: '10px 0', background: '#fd7e14', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 14, fontWeight: 'bold' }}>
                    🔔 {unconfirmedUserIds.length}人にリマインドを送る
                  </button>
                )}
                <button type="button" onClick={() => setUnconfirmedMsgId(null)}
                  style={{ padding: '10px 0', background: 'none', border: `1px solid ${border}`, borderRadius: 8, color: subColor, cursor: 'pointer', fontSize: 14 }}>閉じる</button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* お知らせ送信確認モーダル */}
      {showComposeSendConfirm && (() => {
        const dtConfig = DEADLINE_TYPES.find(d => d.value === composeDeadlineType);
        const today = todayJstStr();
        const isOverdue = composeDeadline ? composeDeadline < today : false;
        const isToday   = composeDeadline ? composeDeadline === today : false;
        const accentColor = isOverdue ? '#dc2626' : isToday ? '#d97706' : '#1d4ed8';
        const allRecipientNames = composeRecipientIds.map(id => allProfiles.find(p => p.id === id)?.name || '').filter(Boolean);
        return (
          <div onClick={() => { setShowComposeSendConfirm(false); setShowAllRecipients(false); }} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 5000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
            <div onClick={e => e.stopPropagation()} style={{ background: cardBg, borderRadius: 16, padding: '16px 16px 20px', width: '100%', maxWidth: 420, maxHeight: '90vh', overflowY: 'auto', boxSizing: 'border-box' }}>
              <p style={{ margin: '0 0 8px', fontSize: 15, fontWeight: 'bold', color: textColor, textAlign: 'center' }}>送信プレビュー</p>
              {/* 宛先表示（10人以上は折りたたみ） */}
              <div style={{ marginBottom: 12, padding: '10px 12px', background: isDark ? '#1e2a3a' : '#eff6ff', borderRadius: 8, border: `1px solid ${isDark ? '#3b82f6' : '#bfdbfe'}` }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: isDark ? '#93c5fd' : '#3b82f6' }}>宛先（{composeRecipientIds.length}人）</span>
                  {allRecipientNames.length >= 10 && (
                    <button type="button" onClick={() => setShowAllRecipients(v => !v)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, color: isDark ? '#93c5fd' : '#3b82f6', padding: 0 }}>
                      {showAllRecipients ? '▲ 閉じる' : '▼ 全員見る'}
                    </button>
                  )}
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {(allRecipientNames.length >= 10 && !showAllRecipients
                    ? allRecipientNames.slice(0, 9)
                    : allRecipientNames
                  ).map((name, i) => (
                    <span key={i} style={{ fontSize: 12, padding: '2px 8px', background: isDark ? '#2d3a4a' : '#dbeafe', color: isDark ? '#93c5fd' : '#1d4ed8', borderRadius: 12 }}>{name}</span>
                  ))}
                  {allRecipientNames.length >= 10 && !showAllRecipients && (
                    <button type="button" onClick={() => setShowAllRecipients(true)}
                      style={{ fontSize: 12, padding: '2px 8px', background: 'none', border: `1px dashed ${isDark ? '#3b82f6' : '#93c5fd'}`, color: isDark ? '#93c5fd' : '#3b82f6', borderRadius: 12, cursor: 'pointer' }}>
                      +{allRecipientNames.length - 9}人
                    </button>
                  )}
                </div>
              </div>
              {/* メッセージカードプレビュー */}
              <div style={{ background: isDark ? '#2a2a3e' : '#f8f9fa', borderRadius: 10, padding: '12px 14px', border: `1px solid ${border}`, marginBottom: 14 }}>
                {/* 送信者行 */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <div style={{ width: 28, height: 28, borderRadius: '50%', background: '#4a90d9', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 12, fontWeight: 'bold', flexShrink: 0 }}>
                    {avatarLetter(profileName)}
                  </div>
                  <span style={{ fontSize: 13, fontWeight: 'bold', color: textColor }}>{profileName || '自分'}</span>
                  <span style={{ fontSize: 11, color: subColor }}>今</span>
                </div>
                {/* 種別・期限バッジ */}
                {dtConfig && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: composeSubject ? 6 : 8, paddingBottom: composeSubject ? 6 : 8, borderBottom: composeSubject ? 'none' : `1px solid ${border}` }}>
                    {(() => { const t = dtConfig.label.replace(/^\S+\s/, ''); return <span style={{ fontSize: 17, fontWeight: 700, color: textColor }}>{t === '確認' ? t : `${t}確認`}</span>; })()}
                    {composeDeadline && (
                      <div style={{ display: 'inline-flex', alignItems: 'center', borderRadius: 20, overflow: 'hidden', border: `1.5px solid ${accentColor}` }}>
                        <span style={{ fontSize: 11, fontWeight: 700, color: '#fff', background: accentColor, padding: '2px 8px' }}>{isOverdue ? '期限切れ' : isToday ? '本日締切' : '期限'}</span>
                        <span style={{ fontSize: 11, color: accentColor, padding: '2px 8px' }}>{composeDeadline.replace(/-/g, '/')}まで</span>
                      </div>
                    )}
                  </div>
                )}
                {/* 件名 */}
                {composeSubject && (
                  <div style={{ fontSize: 15, fontWeight: 700, color: textColor, marginBottom: 8, paddingBottom: 8, borderBottom: `1px solid ${border}`, textAlign: 'left' }}>{composeSubject}</div>
                )}
                {/* 内容・保存先・URL */}
                {(composeAnswerPrompt || composeAnswerLocation || composeAnswerLink) && (
                  <div style={{ marginBottom: 8, padding: '7px 10px', background: isDark ? '#1e2a3a' : '#eff6ff', borderRadius: 8, borderLeft: '3px solid #3b82f6', display: 'flex', flexDirection: 'column', gap: 4, textAlign: 'left' }}>
                    {composeAnswerPrompt && <div style={{ fontSize: 12, color: textColor }}><span style={{ color: '#3b82f6', marginRight: 6 }}>内容</span>{composeAnswerPrompt}</div>}
                    {composeAnswerLocation && <div style={{ fontSize: 12, color: textColor }}><span style={{ color: '#3b82f6', marginRight: 6 }}>保存先</span>{composeAnswerLocation}</div>}
                    {composeAnswerLink && <div style={{ fontSize: 12, color: '#2563eb', wordBreak: 'break-all' }}><span style={{ color: '#3b82f6', marginRight: 6 }}>URL</span>{composeAnswerLink}</div>}
                  </div>
                )}
                {/* 本文 */}
                <div style={{ fontSize: 14, color: textColor, whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.6, maxHeight: 160, overflowY: 'auto', textAlign: 'left' }}>
                  {composeBody}
                </div>
                {/* 送信予約 */}
                {composeScheduledAt && (
                  <div style={{ marginTop: 8, fontSize: 12, color: '#6f42c1' }}>
                    🕐 送信予約: {new Date(composeScheduledAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <button type="button" onClick={() => { setShowComposeSendConfirm(false); setShowAllRecipients(false); }}
                  style={{ flex: 1, padding: '10px 0', background: 'none', border: `1px solid ${border}`, borderRadius: 8, color: subColor, cursor: 'pointer', fontSize: 14 }}>キャンセル</button>
                <button type="button" onClick={() => { setShowComposeSendConfirm(false); setShowAllRecipients(false); sendNotice(); }}
                  style={{ flex: 2, padding: '10px 0', background: '#007bff', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 14, fontWeight: 'bold' }}>送信する</button>
              </div>
            </div>
          </div>
        );
      })()}

      {(saveBanner || memberBanner) && (
        <div style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', zIndex: 9999, background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 12, padding: '20px 28px', boxShadow: '0 4px 20px rgba(0,0,0,0.15)', display: 'flex', alignItems: 'center', gap: 12, minWidth: 220 }}>
          <div style={{ width: 36, height: 36, borderRadius: '50%', background: '#22c55e', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 18, flexShrink: 0 }}>✓</div>
          <span style={{ fontSize: 15, fontWeight: 'bold', color: '#166534' }}>{memberBanner ? 'メンバーを保存しました' : '保存しました'}</span>
          <button type="button" onClick={() => { setSaveBanner(false); setMemberBanner(false); }} style={{ marginLeft: 'auto', background: 'none', border: 'none', color: '#166534', cursor: 'pointer', fontSize: 16, padding: '0 4px' }}>✕</button>
        </div>
      )}
      {noticeActionBanner && (
        <div style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', zIndex: 9999, background: noticeActionBanner === 'deleted' ? '#fff5f5' : '#f0fdf4', border: `1px solid ${noticeActionBanner === 'deleted' ? '#dc2626' : '#86efac'}`, borderRadius: 12, padding: '20px 28px', boxShadow: '0 4px 20px rgba(0,0,0,0.15)', display: 'flex', alignItems: 'center', gap: 12, minWidth: 220 }}>
          <div style={{ width: 36, height: 36, borderRadius: '50%', background: noticeActionBanner === 'deleted' ? '#dc2626' : '#22c55e', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 18, flexShrink: 0 }}>
            {noticeActionBanner === 'deleted' ? '🗑️' : '✓'}
          </div>
          <span style={{ fontSize: 15, fontWeight: 'bold', color: noticeActionBanner === 'deleted' ? '#dc2626' : '#166534' }}>
            {noticeActionBanner === 'deleted' ? '削除しました' : '修正を保存しました'}
          </span>
          <button type="button" onClick={() => setNoticeActionBanner(null)} style={{ marginLeft: 'auto', background: 'none', border: 'none', color: noticeActionBanner === 'deleted' ? '#dc2626' : '#166534', cursor: 'pointer', fontSize: 16, padding: '0 4px' }}>✕</button>
        </div>
      )}
    </div>
  );
};

export default BoardPage;

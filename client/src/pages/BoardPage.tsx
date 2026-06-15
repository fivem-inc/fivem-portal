import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient';
import { insertNotification } from '../lib/notifications';
import { useAuth } from '../hooks/useAuth';
import { useDarkMode } from '../hooks/useDarkMode';

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
  title: string | null;
  subject: string | null;
  status: string | null;
  comment_enabled: boolean;
  answer_prompt: string | null;
  answer_location: string | null;
  answer_link: string | null;
  broadcast_recipients: { id: string; name: string }[] | null;
  profile: { name: string | null } | null;
}

type View = 'inbox' | 'outbox' | 'compose' | 'channel' | 'search' | 'favorites';

interface SimpleProfile {
  id: string;
  name: string | null;
  role_title: string | null;
  employment_type: string | null;
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

const avatarLetter = (name: string | null | undefined) => (name || '?')[0];

const DEADLINE_TYPES = [
  { value: 'read',    label: '📖 読了',  reportLabel: '読了報告',  doneLabel: '読了済み', promptPlaceholder: '例：2026年経営方針',   locationPlaceholder: '例：Slackのcanvas',      linkPlaceholder: 'https://...' },
  { value: 'answer',  label: '✏️ 回答', reportLabel: '回答報告',  doneLabel: '回答済み', promptPlaceholder: '例：短期シフト',       locationPlaceholder: '例：スプレッドシート',   linkPlaceholder: 'https://forms.google.com/...' },
  { value: 'submit',  label: '📤 提出', reportLabel: '提出報告',  doneLabel: '提出済み', promptPlaceholder: '例：年末調整資料',     locationPlaceholder: '例：経理担当者に提出',   linkPlaceholder: 'https://...' },
  { value: 'approve', label: '✅ 承認', reportLabel: '承認報告',  doneLabel: '承認済み', promptPlaceholder: '例：〇〇企画書',       locationPlaceholder: '例：スプレッドシート',   linkPlaceholder: 'https://...' },
] as const;

// ────────────────────────────────────────────────────────────────
// Component
// ────────────────────────────────────────────────────────────────

const BoardPage: React.FC = () => {
  const { user, isAdmin, profileName } = useAuth();
  const isDark = useDarkMode();
  const navigate = useNavigate();

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
  const [lastSeen,    setLastSeen]    = useState<Record<string, string>>({});
  const [readCounts,  setReadCounts]  = useState<Record<string, number>>({});
  const [allProfiles, setAllProfiles] = useState<SimpleProfile[]>([]);
  const [dmDefaultPerms, setDmDefaultPerms] = useState<SendPermissions | null>(null);

  const [view,               setView]               = useState<View>('inbox');
  const [showSidebar,        setShowSidebar]         = useState(true);
  const [selectedChannelId,  setSelectedChannelId]  = useState<string | null>(null);
  const [threadMsgId,        setThreadMsgId]        = useState<string | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [showChannelList,    setShowChannelList]     = useState(true);

  // 受信トレイ
  const [inboxMessages,    setInboxMessages]    = useState<BoardMessage[]>([]);
  const [inboxFilter,      setInboxFilter]      = useState<'all' | 'pending' | 'read' | 'answer' | 'submit' | 'approve' | 'archived'>('all');
  const [inboxDetailId,    setInboxDetailId]    = useState<string | null>(null);
  const [inboxRecipients,  setInboxRecipients]  = useState<Record<string, string[]>>({});
  const [archivedMessages, setArchivedMessages] = useState<BoardMessage[]>([]);
  const [inboxCommentOpen, setInboxCommentOpen] = useState<Record<string, boolean>>({});
  const [inboxComments,    setInboxComments]    = useState<Record<string, BoardMessage[]>>({});
  const [inboxCommentBody, setInboxCommentBody] = useState<Record<string, string>>({}); // message_id -> user_ids

  // 送信トレイ
  const [outboxMessages,   setOutboxMessages]   = useState<BoardMessage[]>([]);
  const [outboxTab,        setOutboxTab]        = useState<'sent' | 'draft'>('sent');
  const [outboxDetailId,   setOutboxDetailId]   = useState<string | null>(null);

  // グループ/DM 折りたたみ
  const [expandGroups,     setExpandGroups]     = useState(false);
  const [expandDMs,        setExpandDMs]        = useState(false);

  // 送信フロー（compose）
  const [composeSubject,       setComposeSubject]       = useState('');
  const [composeBody,          setComposeBody]          = useState('');
  const [composeRecipientIds,  setComposeRecipientIds]  = useState<string[]>([]);
  const [composeDeadlineType,  setComposeDeadlineType]  = useState('');
  const [composeDeadline,      setComposeDeadline]      = useState('');
  const [composeScheduledAt,   setComposeScheduledAt]   = useState('');
  const [composeOptions,        setComposeOptions]        = useState(true);
  const [_composeDraftId,       setComposeDraftId]        = useState<string | null>(null);
  const [composeQuery,          setComposeQuery]          = useState('');
  const [composeAnswerPrompt,   setComposeAnswerPrompt]   = useState('');
  const [composeAnswerLocation, setComposeAnswerLocation] = useState('');
  const [composeAnswerLink,     setComposeAnswerLink]     = useState('');
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
  const [confirmations,        setConfirmations]        = useState<Record<string, {user_id: string; comment: string | null}[]>>({});
  const [myConfirmTimes,       setMyConfirmTimes]       = useState<Record<string, string>>({});
  const [unconfirmedMsgId,     setUnconfirmedMsgId]     = useState<string | null>(null);
  const [answerInputId,        setAnswerInputId]        = useState<string | null>(null);
  const [answerText,           setAnswerText]           = useState('');
  const [newTitle,             setNewTitle]             = useState('');
  const [newAnswerPrompt,      setNewAnswerPrompt]      = useState('');
  const [newAnswerLocation,    setNewAnswerLocation]    = useState('');
  const [newAnswerLink,        setNewAnswerLink]        = useState('');
  const [replyBody,            setReplyBody]            = useState('');
  const [editingId,   setEditingId]   = useState<string | null>(null);
  const [editBody,         setEditBody]         = useState('');
  const [sending,               setSending]               = useState(false);
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
  const [broadcastMessage, setBroadcastMessage] = useState('');
  const [loadingData,      setLoadingData]      = useState(true);
  const [readDetailMsgId,  setReadDetailMsgId]  = useState<string | null>(null);
  const [readDetailUsers,  setReadDetailUsers]  = useState<{ user_id: string; read_at: string }[]>([]);
  const [_showReadDetail,  setShowReadDetail]   = useState(true); // 設定: 全員が既読詳細を見れるか

  const [saveBanner, setSaveBanner] = useState(false);
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);

  // お気に入り
  const [favChannelIds, setFavChannelIds] = useState<Set<string>>(new Set());
  const [favMessageIds, setFavMessageIds] = useState<Set<string>>(new Set());
  const [favMessages,   setFavMessages]   = useState<BoardMessage[]>([]);
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

    const [chRes, memRes, msgRes, lsRes, profRes, settingsRes, dmSettingsRes] = await Promise.all([
      supabase.from('board_channels').select('id, type, name, created_by, created_at, send_permissions, show_read_detail').in('id', cids),
      supabase.from('board_channel_members').select('channel_id, user_id').in('channel_id', cids),
      supabase.from('board_messages').select('id, channel_id, parent_id, user_id, body, edited_at, created_at, deadline, deadline_type, requires_confirmation, scheduled_at, title, answer_prompt, answer_location, answer_link, broadcast_recipients').in('channel_id', cids).order('created_at', { ascending: false }).limit(500),
      supabase.from('board_channel_last_seen').select('channel_id, last_seen_at').eq('user_id', user.id),
      supabase.from('profiles').select('id, name, role_title, employment_type').eq('is_active', true).order('name'),
      supabase.from('master_options').select('value').eq('category', 'board_show_read_detail').limit(1),
      supabase.from('app_settings').select('value').eq('key', 'dm_default_send_permissions').maybeSingle(),
    ]);
    if (dmSettingsRes.data?.value) setDmDefaultPerms(dmSettingsRes.data.value as SendPermissions);

    setChannels((chRes.data || []) as Channel[]);
    setMembers((memRes.data || []).map((m: any) => ({ channel_id: m.channel_id, user_id: m.user_id, profile: null })));
    const now = new Date().toISOString();
    setMessages((msgRes.data || []).filter((m: any) => !m.scheduled_at || m.scheduled_at <= now).map((m: any) => ({ ...m, profile: null })));

    // requires_confirmation / deadline_type ありの投稿の確認者を取得
    const confirmMsgIds = (msgRes.data || []).filter((m: any) => m.requires_confirmation || m.deadline_type).map((m: any) => m.id);
    if (confirmMsgIds.length > 0) {
      const { data: confData } = await supabase.from('board_confirmations').select('message_id, user_id, comment').in('message_id', confirmMsgIds);
      const confMap: Record<string, {user_id: string; comment: string | null}[]> = {};
      (confData || []).forEach((c: { message_id: string; user_id: string; comment: string | null }) => {
        if (!confMap[c.message_id]) confMap[c.message_id] = [];
        confMap[c.message_id].push({ user_id: c.user_id, comment: c.comment });
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
      setReadCounts(rc);
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
      const { data: msgs } = await supabase
        .from('board_messages')
        .select('id, channel_id, parent_id, user_id, body, edited_at, created_at, deadline, deadline_type, requires_confirmation, scheduled_at, title, subject, status, comment_enabled, answer_prompt, answer_location, answer_link')
        .in('id', [...msgIds])
        .order('created_at', { ascending: false });
      setFavMessages((msgs || []) as BoardMessage[]);
    } else {
      setFavMessages([]);
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
    setView('inbox');
    setShowSidebar(true);
    setSelectedChannelId(null);
    setInboxDetailId(null);
    setOutboxDetailId(null);
    setThreadMsgId(null);
    setShowSearch(false);
    setSearchText('');
    setSearchResults([]);
  }, []);

  useEffect(() => {
    window.addEventListener('board-reset', resetToTop);
    return () => window.removeEventListener('board-reset', resetToTop);
  }, [resetToTop]);

  // スマホ戻るボタン対応：BoardPage内の遷移を履歴に積む
  useEffect(() => {
    // 内部状態が変わるたびにダミー履歴を積む
    const hasDetail = view !== 'inbox' || !showSidebar || selectedChannelId || inboxDetailId || outboxDetailId || threadMsgId;
    if (hasDetail) {
      window.history.pushState({ boardInternal: true }, '');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, showSidebar, selectedChannelId, inboxDetailId, outboxDetailId, threadMsgId]);

  useEffect(() => {
    const onPopState = (e: PopStateEvent) => {
      if (e.state?.boardInternal !== true) {
        // 内部履歴でない場合のみ通常の戻る動作（ページ離脱）を許可
        return;
      }
      // 内部履歴 → ページ離脱せずリセット
      e.preventDefault?.();
      if (threadMsgId) { setThreadMsgId(null); return; }
      if (inboxDetailId) { setInboxDetailId(null); return; }
      if (outboxDetailId) { setOutboxDetailId(null); return; }
      if (selectedChannelId && !showSidebar) { setShowSidebar(true); setSelectedChannelId(null); return; }
      if (!showSidebar) { setShowSidebar(true); return; }
      if (view !== 'inbox') { setView('inbox'); return; }
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [view, showSidebar, selectedChannelId, inboxDetailId, outboxDetailId, threadMsgId]);

  // メッセージ全文検索（300msデバウンス）
  useEffect(() => {
    if (!searchText.trim() || searchText.trim().length < 2) {
      setSearchResults([]);
      if (view === 'search') setView('inbox');
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
            .select('id, channel_id, parent_id, user_id, body, edited_at, created_at, deadline, deadline_type, requires_confirmation, scheduled_at, title, subject, status, comment_enabled, answer_prompt, answer_location, answer_link')
            .in('channel_id', cids)
            .or(`body.ilike.${q},subject.ilike.${q}`)
            .order('created_at', { ascending: false })
            .limit(30)
        : Promise.resolve({ data: [] });

      // 受信トレイメッセージ検索
      const inboxQuery = inboxIds.length > 0
        ? supabase
            .from('board_messages')
            .select('id, channel_id, parent_id, user_id, body, edited_at, created_at, deadline, deadline_type, requires_confirmation, scheduled_at, title, subject, status, comment_enabled, answer_prompt, answer_location, answer_link')
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

    const { data: msgData } = await supabase
      .from('board_messages')
      .select('id, channel_id, parent_id, user_id, body, edited_at, created_at, deadline, deadline_type, requires_confirmation, scheduled_at, title, subject, status, comment_enabled, answer_prompt, answer_location, answer_link')
      .in('id', msgIds)
      .is('parent_id', null)
      .order('created_at', { ascending: false });

    const now = new Date().toISOString();
    setInboxMessages((msgData || [])
      .filter((m: any) => !m.scheduled_at || m.scheduled_at <= now)
      .map((m: any) => ({ ...m, broadcast_recipients: null, profile: null })));

    // confirmations を読む（deadline_type / requires_confirmation があるもの）
    const confirmMsgIds = (msgData || []).filter((m: any) => m.requires_confirmation || m.deadline_type).map((m: any) => m.id);
    if (confirmMsgIds.length > 0) {
      const { data: confData } = await supabase.from('board_confirmations').select('message_id, user_id, comment').in('message_id', confirmMsgIds);
      const confMap: Record<string, {user_id: string; comment: string | null}[]> = {};
      (confData || []).forEach((c: any) => {
        if (!confMap[c.message_id]) confMap[c.message_id] = [];
        confMap[c.message_id].push({ user_id: c.user_id, comment: c.comment });
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
      .select('id, channel_id, parent_id, user_id, body, edited_at, created_at, deadline, deadline_type, requires_confirmation, scheduled_at, title, subject, status, comment_enabled, answer_prompt, answer_location, answer_link')
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
      if (inboxDetailId === msgId) setInboxDetailId(null);
    } else {
      setArchivedMessages(prev => prev.filter(m => m.id !== msgId));
      await loadInbox();
    }
  };

  const loadOutbox = useCallback(async () => {
    if (!user) return;
    const { data } = await supabase
      .from('board_messages')
      .select('id, channel_id, parent_id, user_id, body, edited_at, created_at, deadline, deadline_type, requires_confirmation, scheduled_at, title, subject, status, comment_enabled, answer_prompt, answer_location, answer_link')
      .eq('user_id', user.id)
      .is('channel_id', null)
      .is('parent_id', null)
      .order('created_at', { ascending: false });
    setOutboxMessages((data || []).map((m: any) => ({ ...m, broadcast_recipients: null, profile: null })));

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
    }
  }, [user]);

  useEffect(() => { loadInbox(); }, [loadInbox]);
  useEffect(() => { loadArchived(); }, [loadArchived]);
  useEffect(() => { loadOutbox(); }, [loadOutbox]);

  useEffect(() => {
    if (selectedChannelId) messagesEndRef.current?.scrollIntoView({ behavior: 'instant' });
  }, [messages.length, selectedChannelId]);

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
    const myProfile = allProfiles.find(p => p.id === user?.id);
    if (!myProfile) return false;
    return employment_types.includes(myProfile.employment_type || '') || role_titles.includes(myProfile.role_title || '');
  };

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
    if (!parentId && newDeadlineType) {
      if (newTitle.trim()) insertData.title = newTitle.trim();
      if (newAnswerPrompt.trim()) insertData.answer_prompt = newAnswerPrompt.trim();
      if (newAnswerLocation.trim()) insertData.answer_location = newAnswerLocation.trim();
      if (newAnswerLink.trim()) insertData.answer_link = newAnswerLink.trim();
    }

    const { data, error } = await supabase
      .from('board_messages')
      .insert(insertData)
      .select('id, channel_id, parent_id, user_id, body, edited_at, created_at, deadline, deadline_type, requires_confirmation, scheduled_at, title, answer_prompt, answer_location, answer_link')
      .single();

    if (!error && data) {
      const msg: BoardMessage = { ...data, subject: null, status: 'sent', comment_enabled: false, broadcast_recipients: null, profile: { name: profileName || null } };
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
    }
    if (parentId) setReplyBody(''); else { setNewBody(''); setNewDeadline(''); setNewDeadlineType(''); setNewScheduledAt(''); setNewTitle(''); setNewAnswerPrompt(''); setNewAnswerLocation(''); setNewAnswerLink(''); }
    setSending(false);
  };

  const saveEdit = async (id: string) => {
    if (!editBody.trim()) return;
    const { error } = await supabase
      .from('board_messages')
      .update({ body: editBody.trim(), edited_at: new Date().toISOString() })
      .eq('id', id)
      .select('id');
    if (!error) {
      setMessages(prev => prev.map(m => m.id === id ? { ...m, body: editBody.trim(), edited_at: new Date().toISOString() } : m));
      setSaveBanner(true);
      setTimeout(() => setSaveBanner(false), 3000);
    }
    setEditingId(null);
  };

  const deleteMessage = async (id: string) => {
    if (!window.confirm('このメッセージを削除しますか？')) return;
    const { error } = await supabase.from('board_messages').delete().eq('id', id);
    if (!error) setMessages(prev => prev.filter(m => m.id !== id && m.parent_id !== id));
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
    // 新規DM作成
    const { data: ch } = await supabase
      .from('board_channels')
      .insert({ type: 'dm', created_by: user.id })
      .select().single();
    if (ch) {
      await supabase.from('board_channel_members').insert([
        { channel_id: ch.id, user_id: user.id },
        { channel_id: ch.id, user_id: targetId },
      ]);
      await loadAll();
      selectChannel(ch.id);
    }
    setShowDMSearch(false); setDmQuery('');
  };

  const sendBroadcast = async () => {
    if (!user || dmSelectedIds.length === 0 || !broadcastMessage.trim()) return;
    setSending(true);

    // 送信メールチャンネルを取得or作成
    let sentMailCh = channels.find(c => c.type === 'sent_mail' && c.created_by === user.id);
    if (!sentMailCh) {
      const { data: newCh } = await supabase
        .from('board_channels')
        .insert({ type: 'sent_mail', created_by: user.id })
        .select().single();
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
        const { data: newDm } = await supabase
          .from('board_channels')
          .insert({ type: 'dm', created_by: user.id })
          .select().single();
        if (newDm) {
          await supabase.from('board_channel_members').insert([
            { channel_id: newDm.id, user_id: user.id },
            { channel_id: newDm.id, user_id: targetId },
          ]);
          dmCh = newDm as Channel;
        }
      }
      if (dmCh) {
        await supabase.from('board_messages').insert({ channel_id: dmCh.id, user_id: user.id, body: broadcastMessage.trim() });
        await insertNotification(targetId, `${profileName || '誰か'}からメッセージが届きました`, broadcastMessage.trim().slice(0, 40), 'board');
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
  };

  const sendNotice = async () => {
    if (!user || composeRecipientIds.length === 0 || !composeBody.trim()) return;
    setSending(true);
    const insertData: Record<string, unknown> = {
      user_id: user.id,
      body: composeBody.trim(),
      status: 'sent',
    };
    if (composeSubject.trim())         insertData.subject         = composeSubject.trim();
    if (composeDeadlineType)           { insertData.deadline_type = composeDeadlineType; insertData.requires_confirmation = true; }
    if (composeDeadline)               insertData.deadline        = composeDeadline;
    if (composeScheduledAt)            insertData.scheduled_at    = new Date(composeScheduledAt).toISOString();
    if (composeAnswerPrompt.trim())    insertData.answer_prompt   = composeAnswerPrompt.trim();
    if (composeAnswerLocation.trim())  insertData.answer_location = composeAnswerLocation.trim();
    if (composeAnswerLink.trim())      insertData.answer_link     = composeAnswerLink.trim();

    const { data, error } = await supabase.from('board_messages').insert(insertData).select('id').single();
    if (!error && data) {
      const recs = composeRecipientIds.map(uid => ({ message_id: data.id, user_id: uid }));
      await supabase.from('board_message_recipients').insert(recs);

      // 受信者に通知
      const senderName = profileName || '誰か';
      const preview = (composeSubject.trim() || composeBody.trim()).slice(0, 40);
      await Promise.all(composeRecipientIds.map(uid =>
        insertNotification(uid, `${senderName}からお知らせが届きました`, preview, 'board')
      ));

      resetCompose();
      await loadOutbox();
      setView('outbox');
      setShowSidebar(false);
    }
    setSending(false);
  };

  const deleteChannel = async (chId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!window.confirm('このチャンネルを削除しますか？\nメッセージもすべて削除されます。')) return;
    await supabase.from('board_channel_members').delete().eq('channel_id', chId);
    await supabase.from('board_messages').delete().eq('channel_id', chId);
    await supabase.from('board_channels').delete().eq('id', chId);
    if (selectedChannelId === chId) { setSelectedChannelId(null); setShowChannelList(true); }
    await loadAll();
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

  const renderMsg = (msg: BoardMessage, isReply = false) => {
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
              <span style={{ fontSize: 11, color: subColor }}>{fmtTime(msg.created_at)}</span>
              {msg.edited_at && <span style={{ fontSize: 10, color: subColor }}>(編集済み)</span>}
            </div>
            <div style={{ display: 'flex', gap: 2, alignItems: 'center' }}>
              <button type="button" onClick={e => toggleFavMessage(e, msg.id, msg)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 15, padding: '2px 3px', color: favMessageIds.has(msg.id) ? '#f59e0b' : subColor, opacity: favMessageIds.has(msg.id) ? 1 : 0.4 }}>
                {favMessageIds.has(msg.id) ? '★' : '☆'}
              </button>
              {canEdit && (
                <>
                  <button type="button" onClick={() => { setEditingId(msg.id); setEditBody(msg.body); }} style={{ background: 'none', border: 'none', color: subColor, cursor: 'pointer', fontSize: 13, padding: '2px 4px' }}>✏️</button>
                  <button type="button" onClick={() => deleteMessage(msg.id)} style={{ background: 'none', border: 'none', color: '#dc3545', cursor: 'pointer', fontSize: 13, padding: '2px 4px' }}>🗑️</button>
                </>
              )}
            </div>
          </div>

          {/* 種別ラベル＋期限バッジ（案C: 左ボーダー＋右端バッジ） */}
          {msg.deadline_type && !msg.parent_id && (() => {
            const today = new Date().toISOString().slice(0, 10);
            const isOverdue = msg.deadline ? msg.deadline < today : false;
            const isToday = msg.deadline ? msg.deadline === today : false;
            const dtConfig = DEADLINE_TYPES.find(d => d.value === msg.deadline_type);
            const typeText = dtConfig ? dtConfig.label.replace(/^\S+\s/, '') : '確認';
            const accentColor = isOverdue ? '#dc2626' : isToday ? '#d97706' : '#1d4ed8';
            const dateLabel = msg.deadline ? (() => {
              const [y, m, d] = msg.deadline.split('-');
              return `${y}/${parseInt(m)}/${parseInt(d)}まで`;
            })() : '';
            const badgeLeftText = isOverdue ? '期限切れ' : isToday ? '本日締切' : '期限';
            return (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, paddingBottom: 8, borderBottom: `1px solid ${border}` }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 0, flexShrink: 0 }}>
                    <div style={{ width: 3, height: 22, background: accentColor, borderRadius: 2, marginRight: 8, flexShrink: 0 }} />
                    <span style={{ fontSize: 20, fontWeight: 800, color: textColor }}>{typeText}確認</span>
                  </div>
                  {msg.deadline && (
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 0, borderRadius: 20, overflow: 'hidden', border: `1.5px solid ${accentColor}` }}>
                      <span style={{ fontSize: 12, fontWeight: 700, color: '#fff', background: accentColor, padding: '2px 9px' }}>{badgeLeftText}</span>
                      <span style={{ fontSize: 11, color: accentColor, padding: '2px 9px' }}>{dateLabel}</span>
                    </div>
                  )}
                </div>
              </div>
            );
          })()}
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
          {/* 回答一覧（回答タイプで送信済みのもの） */}
          {msg.deadline_type && !msg.parent_id && (() => {
            const answers = (confirmations[msg.id] || []).filter(c => c.comment);
            if (answers.length === 0) return null;
            return (
              <div style={{ margin: '6px 0 8px', padding: '8px 10px', background: isDark ? '#1a3a28' : '#f0fdf4', borderRadius: 8, border: `1px solid ${isDark ? '#16532a' : '#86efac'}` }}>
                <div style={{ fontSize: 11, fontWeight: 'bold', color: isDark ? '#4ade80' : '#166534', marginBottom: 4 }}>📝 回答</div>
                {answers.map(c => {
                  const name = allProfiles.find(p => p.id === c.user_id)?.name || '不明';
                  return (
                    <div key={c.user_id} style={{ fontSize: 13, color: textColor, padding: '4px 0', borderBottom: `1px solid ${isDark ? '#16532a' : '#bbf7d0'}` }}>
                      <span style={{ fontWeight: 500, color: isDark ? '#4ade80' : '#166534' }}>{name}：</span>{c.comment}
                    </div>
                  );
                })}
              </div>
            );
          })()}
          {editingId === msg.id ? (
            <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
              <input
                value={editBody}
                onChange={e => setEditBody(e.target.value)}
                autoFocus
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveEdit(msg.id); }}}
                style={{ flex: 1, padding: '6px 8px', borderRadius: 6, border: `1px solid ${border}`, background: inputBg, color: textColor, fontSize: 13 }}
              />
              <button type="button" onClick={() => saveEdit(msg.id)} style={{ padding: '6px 10px', background: '#007bff', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12 }}>保存</button>
              <button type="button" onClick={() => setEditingId(null)} style={{ padding: '6px 8px', background: '#6c757d', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12 }}>✕</button>
            </div>
          ) : (
            <div style={{ fontSize: 14, color: textColor, whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.5, textAlign: 'left' }}>{msg.body}</div>
          )}
          {/* 送信メールチャンネルの宛先表示 */}
          {msg.broadcast_recipients && msg.broadcast_recipients.length > 0 && (
            <div style={{ marginTop: 6, padding: '4px 8px', background: isDark ? '#1e2d1e' : '#f0fdf4', borderRadius: 6, fontSize: 12, color: isDark ? '#86efac' : '#166534' }}>
              宛先: {msg.broadcast_recipients.map(r => r.name).join('、')}
            </div>
          )}

          {/* 確認ボタン（deadline_type / requires_confirmation ありの親投稿） */}
          {(msg.deadline_type || msg.requires_confirmation) && !msg.parent_id && (() => {
            const confirmedObjs = confirmations[msg.id] || [];
            const confirmedIds = confirmedObjs.map(c => c.user_id);
            const alreadyConfirmed = confirmedIds.includes(user?.id ?? '');
            const myConfirmTime = myConfirmTimes[msg.id];
            const channelMemberIds = members.filter(m => m.channel_id === msg.channel_id).map(m => m.user_id);
            const unconfirmedIds = channelMemberIds.filter(id => !confirmedIds.includes(id));
            const dtConfig = DEADLINE_TYPES.find(d => d.value === msg.deadline_type);
            const reportLabel = dtConfig ? dtConfig.reportLabel : '確認報告';
            const doneLabel   = dtConfig ? dtConfig.doneLabel   : '確認済み';
            const isAnswerType = !!msg.deadline_type;
            return (
              <div style={{ marginTop: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                  {!alreadyConfirmed ? (
                    <button type="button" onClick={() => {
                      if (isAnswerType) {
                        setAnswerInputId(answerInputId === msg.id ? null : msg.id);
                        setAnswerText('');
                      } else {
                        (async () => {
                          if (!user) return;
                          const now = new Date().toISOString();
                          await supabase.from('board_confirmations').upsert({ message_id: msg.id, user_id: user.id, comment: null }, { onConflict: 'message_id,user_id' });
                          setConfirmations(prev => ({ ...prev, [msg.id]: [...(prev[msg.id] || []).filter(c => c.user_id !== user.id), { user_id: user.id, comment: null }] }));
                          setMyConfirmTimes(prev => ({ ...prev, [msg.id]: now }));
                        })();
                      }
                    }} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 12px', background: cardBg, border: '1.5px solid #22c55e', borderRadius: 20, cursor: 'pointer', fontSize: 13, fontWeight: 500, color: isDark ? '#4ade80' : '#166534' }}>
                      <span style={{ fontSize: 15, lineHeight: 1 }}>○</span> {reportLabel}
                    </button>
                  ) : (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 12px', background: '#22c55e', border: '1.5px solid #22c55e', borderRadius: 20, fontSize: 13, fontWeight: 500, color: '#fff' }}>
                      <span style={{ fontSize: 15, lineHeight: 1 }}>✓</span> {doneLabel}（{myConfirmTime ? fmtTime(myConfirmTime) : '済み'}）
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
                {/* 回答入力欄 */}
                {isAnswerType && answerInputId === msg.id && !alreadyConfirmed && (
                  <div style={{ marginTop: 8, display: 'flex', gap: 6 }}>
                    <textarea
                      value={answerText}
                      onChange={e => setAnswerText(e.target.value)}
                      placeholder="回答内容を入力..."
                      rows={2}
                      autoFocus
                      style={{ flex: 1, padding: '6px 10px', borderRadius: 8, border: `1px solid ${border}`, background: inputBg, color: textColor, fontSize: 13, resize: 'none', fontFamily: 'inherit', lineHeight: 1.4 }}
                    />
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <button type="button" disabled={!answerText.trim()} onClick={async () => {
                        if (!user || !answerText.trim()) return;
                        const now = new Date().toISOString();
                        await supabase.from('board_confirmations').upsert(
                          { message_id: msg.id, user_id: user.id, comment: answerText.trim() },
                          { onConflict: 'message_id,user_id' }
                        );
                        setConfirmations(prev => ({ ...prev, [msg.id]: [...(prev[msg.id] || []).filter(c => c.user_id !== user.id), { user_id: user.id, comment: answerText.trim() }] }));
                        setMyConfirmTimes(prev => ({ ...prev, [msg.id]: now }));
                        setAnswerInputId(null);
                        setAnswerText('');
                      }} style={{ padding: '6px 10px', background: '#22c55e', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 500, opacity: !answerText.trim() ? 0.5 : 1 }}>
                        回答して完了
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
              {/* 最新リプライのプレビュー */}
              {replyCount > 0 && (() => {
                const latestReply = replies[replies.length - 1];
                const replierName = allProfiles.find(p => p.id === latestReply.user_id)?.name || '不明';
                const myLastSeen = lastSeen[msg.channel_id ?? ''] || '';
                const unreadReplies = replies.filter(r => r.user_id !== user?.id && r.created_at > myLastSeen).length;
                return (
                  <button type="button" onClick={() => setThreadMsgId(msg.id)}
                    style={{ width: '100%', background: isDark ? '#1e2328' : '#f0f4ff', border: `1px solid ${isDark ? '#3d4349' : '#c7d4f5'}`, borderRadius: 8, padding: '6px 10px', cursor: 'pointer', textAlign: 'left', marginBottom: 6 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                      <span style={{ fontSize: 11, fontWeight: 'bold', color: isDark ? '#90b4e8' : '#3b5bdb' }}>💬 {replierName}</span>
                      <span style={{ fontSize: 10, color: subColor }}>{fmtTime(latestReply.created_at)}</span>
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
                {replyCount === 0 ? '💬 リプライ' : null}
              </button>
              {(() => {
                const chMemberCount = members.filter(m => m.channel_id === msg.channel_id).length;
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
      <div style={{ position: 'fixed', top: 60, left: 0, right: 0, bottom: 0, zIndex: 200, background: bg, display: 'flex', flexDirection: 'column' }}>
        {/* Thread header */}
        <div style={{ padding: '10px 14px', borderBottom: `1px solid ${border}`, background: cardBg, display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0, position: 'sticky', top: 0, zIndex: 10 }}>
          <button type="button" onClick={() => { setThreadMsgId(null); setReplyBody(''); }}
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
              <span style={{ fontSize: 11, color: subColor }}>{fmtTime(parentMsg.created_at)}</span>
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
                    <span style={{ fontSize: 11, color: subColor }}>{fmtTime(r.created_at)}</span>
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
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button type="button" onClick={() => { setShowDMSearch(false); setDmQuery(''); setDmSelectedIds([]); setBroadcastMessage(''); }}
              style={{ flex: 1, padding: 10, background: '#6c757d', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 14 }}>キャンセル</button>
            {isSingle && (
              <button type="button" onClick={() => startDM(dmSelectedIds[0])}
                style={{ flex: 1, padding: 10, background: '#007bff', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 14 }}>
                DMを開始
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
                style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, padding: '0 2px', lineHeight: 1, color: favChannelIds.has(ch.id) ? '#f59e0b' : subColor, opacity: favChannelIds.has(ch.id) ? 1 : 0.4 }}>
                {favChannelIds.has(ch.id) ? '★' : '☆'}
              </button>
              {canDelete && (
                <button type="button" onClick={e => deleteChannel(ch.id, e)}
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
  const inboxUnread   = inboxMessages.filter(m => !(confirmations[m.id] || []).find(c => c.user_id === user?.id) && (m.requires_confirmation || m.deadline_type)).length;

  const channelListPanel = (
    <div style={{ width: isMobile ? '100%' : 280, background: sidebarBg, borderRight: isMobile ? 'none' : `1px solid ${border}`, display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, flexShrink: 0 }}>
      <div ref={channelListRef} style={{ overflowY: 'auto', flex: 1, minHeight: 0, paddingTop: showSearch ? 92 : 52 }}>
        {/* ── 受信・送信・お気に入り ── */}
        {[
          { key: 'inbox'  as const, icon: '📨', label: '受信トレイ', bg: isDark ? '#1e3a5f' : '#dbeafe', badge: inboxUnread, onClick: () => { setView('inbox'); setShowSidebar(false); setInboxDetailId(null); } },
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
                <span style={{ background: '#dc3545', color: '#fff', borderRadius: 10, fontSize: 11, minWidth: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 5px', fontWeight: 'bold', flexShrink: 0 }}>{item.badge}</span>
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
              {isAdmin && (
                <button type="button" onClick={() => setShowGroupModal(true)}
                  style={{ background: 'none', border: 'none', color: '#6f42c1', cursor: 'pointer', fontSize: 18, padding: 0, lineHeight: 1 }} title="グループ作成">＋</button>
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
              <button type="button" onClick={() => setShowDMSearch(true)}
                style={{ background: 'none', border: 'none', color: '#4a90d9', cursor: 'pointer', fontSize: 16, padding: 0, lineHeight: 1 }} title="DM開始">＋</button>
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
    { key: 'pending',  label: '未対応' },
    { key: 'read',     label: '読了' },
    { key: 'answer',   label: '回答' },
    { key: 'submit',   label: '提出' },
    { key: 'approve',  label: '承認' },
    { key: 'archived', label: '📦 アーカイブ' },
  ] as const;

  const filteredInbox = inboxFilter === 'archived' ? archivedMessages : inboxMessages.filter(m => {
    if (inboxFilter === 'all') return true;
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
          <div style={{ padding: '10px 14px', background: cardBg, borderBottom: `1px solid ${border}`, flexShrink: 0, paddingTop: 58 }}>
            <button type="button" onClick={() => setInboxDetailId(null)}
              style={{ background: 'none', border: 'none', color: '#4a90d9', cursor: 'pointer', fontSize: 22, padding: '0 6px 0 0', fontWeight: 'bold', verticalAlign: 'middle' }}>←</button>
            <span style={{ fontSize: 15, fontWeight: 'bold', color: textColor, verticalAlign: 'middle' }}>
              {inboxDetail.subject || inboxDetail.title || 'お知らせ'}
            </span>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '16px 14px' }}>
            {renderMsg(inboxDetail)}
            {/* コメント折りたたみ（comment_enabled=true の場合のみ） */}
            {inboxDetail.comment_enabled && (
              <div style={{ marginTop: 16 }}>
                <button type="button"
                  onClick={async () => {
                    const isOpen = !!inboxCommentOpen[inboxDetail.id];
                    if (!isOpen && !inboxComments[inboxDetail.id]) {
                      const { data } = await supabase
                        .from('board_messages')
                        .select('id, channel_id, parent_id, user_id, body, edited_at, created_at, deadline, deadline_type, requires_confirmation, scheduled_at, title, subject, status, comment_enabled, answer_prompt, answer_location, answer_link')
                        .eq('parent_id', inboxDetail.id)
                        .order('created_at', { ascending: true });
                      setInboxComments(prev => ({ ...prev, [inboxDetail.id]: (data || []).map((m: any) => ({ ...m, broadcast_recipients: null, profile: null })) }));
                    }
                    setInboxCommentOpen(prev => ({ ...prev, [inboxDetail.id]: !isOpen }));
                  }}
                  style={{ width: '100%', padding: '8px 14px', background: isDark ? '#2d2d3e' : '#f3f4f6', border: `1px solid ${border}`, borderRadius: 8, cursor: 'pointer', color: textColor, fontSize: 13, fontWeight: 600, textAlign: 'left', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span>💬 コメント</span>
                  <span style={{ fontSize: 12, color: subColor }}>{inboxCommentOpen[inboxDetail.id] ? '▲ 閉じる' : '▼ 開く'}</span>
                </button>
                {inboxCommentOpen[inboxDetail.id] && (
                  <div style={{ marginTop: 8, padding: '10px 12px', background: cardBg, border: `1px solid ${border}`, borderRadius: 8 }}>
                    {(inboxComments[inboxDetail.id] || []).length === 0 ? (
                      <div style={{ fontSize: 13, color: subColor, textAlign: 'center', padding: '8px 0' }}>コメントはまだありません</div>
                    ) : (
                      (inboxComments[inboxDetail.id] || []).map(c => {
                        const cName = allProfiles.find(p => p.id === c.user_id)?.name || '不明';
                        return (
                          <div key={c.id} style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                            <div style={{ width: 26, height: 26, borderRadius: '50%', background: '#28a745', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 11, fontWeight: 'bold', flexShrink: 0 }}>
                              {avatarLetter(cName)}
                            </div>
                            <div style={{ flex: 1 }}>
                              <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 2 }}>
                                <span style={{ fontSize: 12, fontWeight: 700, color: textColor }}>{cName}</span>
                                <span style={{ fontSize: 11, color: subColor }}>{fmtTime(c.created_at)}</span>
                              </div>
                              <div style={{ fontSize: 13, color: textColor, whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.5 }}>{c.body}</div>
                            </div>
                          </div>
                        );
                      })
                    )}
                    {/* コメント入力 */}
                    <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                      <textarea
                        value={inboxCommentBody[inboxDetail.id] || ''}
                        onChange={e => setInboxCommentBody(prev => ({ ...prev, [inboxDetail.id]: e.target.value }))}
                        placeholder="コメントを入力..."
                        rows={2}
                        style={{ flex: 1, padding: '6px 10px', borderRadius: 8, border: `1px solid ${border}`, background: inputBg, color: textColor, fontSize: 13, resize: 'none', fontFamily: 'inherit' }}
                      />
                      <button type="button"
                        disabled={!(inboxCommentBody[inboxDetail.id] || '').trim()}
                        onClick={async () => {
                          const body = (inboxCommentBody[inboxDetail.id] || '').trim();
                          if (!body || !user) return;
                          const { data } = await supabase
                            .from('board_messages')
                            .insert({ parent_id: inboxDetail.id, user_id: user.id, body })
                            .select('id, channel_id, parent_id, user_id, body, edited_at, created_at, deadline, deadline_type, requires_confirmation, scheduled_at, title, subject, status, comment_enabled, answer_prompt, answer_location, answer_link')
                            .single();
                          if (data) {
                            const newComment: BoardMessage = { ...data, broadcast_recipients: null, profile: null };
                            setInboxComments(prev => ({ ...prev, [inboxDetail.id]: [...(prev[inboxDetail.id] || []), newComment] }));
                            setInboxCommentBody(prev => ({ ...prev, [inboxDetail.id]: '' }));
                          }
                        }}
                        style={{ padding: '6px 12px', background: '#007bff', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, alignSelf: 'flex-end', opacity: !(inboxCommentBody[inboxDetail.id] || '').trim() ? 0.5 : 1 }}>
                        送信
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      ) : (
        /* 一覧ビュー */
        <>
          <div style={{ paddingTop: 52, flexShrink: 0 }}>
            {/* フィルタータブ */}
            <div style={{ display: 'flex', overflowX: 'auto', borderBottom: `1px solid ${border}`, background: cardBg, padding: '0 8px' }}>
              {INBOX_FILTERS.map(f => (
                <button key={f.key} type="button" onClick={() => { setInboxFilter(f.key); if (f.key === 'archived') loadArchived(); }}
                  style={{ padding: '10px 14px', background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: inboxFilter === f.key ? 700 : 400, color: inboxFilter === f.key ? '#007bff' : subColor, borderBottom: inboxFilter === f.key ? '2px solid #007bff' : '2px solid transparent', whiteSpace: 'nowrap', flexShrink: 0 }}>
                  {f.label}
                </button>
              ))}
            </div>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '8px 12px' }}>
            {filteredInbox.length === 0 ? (
              <div style={{ textAlign: 'center', color: subColor, fontSize: 13, marginTop: 40 }}>
                {inboxFilter === 'all' ? 'お知らせはありません' : '該当するお知らせはありません'}
              </div>
            ) : filteredInbox.map(msg => {
              const senderName = allProfiles.find(p => p.id === msg.user_id)?.name || '不明';
              const confirmed = (confirmations[msg.id] || []).some(c => c.user_id === user?.id);
              const today = new Date().toISOString().slice(0, 10);
              const isOverdue = msg.deadline ? msg.deadline < today : false;
              const dtConfig = DEADLINE_TYPES.find(d => d.value === msg.deadline_type);
              const isArchived = inboxFilter === 'archived';
              return (
                <div key={msg.id}
                  style={{ background: cardBg, border: confirmed ? '1.5px solid #22c55e' : `1px solid ${border}`, borderRadius: 10, padding: '12px 14px', marginBottom: 8, position: 'relative' }}>
                  <div onClick={() => setInboxDetailId(msg.id)} style={{ cursor: 'pointer' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 4 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div style={{ width: 28, height: 28, borderRadius: '50%', background: '#4a90d9', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 12, fontWeight: 'bold', flexShrink: 0 }}>
                          {avatarLetter(senderName)}
                        </div>
                        <span style={{ fontSize: 13, fontWeight: 'bold', color: textColor }}>{senderName}</span>
                        <span style={{ fontSize: 11, color: subColor }}>{fmtTime(msg.created_at)}</span>
                      </div>
                      {confirmed && !isArchived && <span style={{ fontSize: 11, color: '#22c55e', fontWeight: 700, flexShrink: 0 }}>✓ 完了</span>}
                    </div>
                    {(msg.subject || msg.title) && (
                      <div style={{ fontSize: 14, fontWeight: 700, color: textColor, marginBottom: 4 }}>{msg.subject || msg.title}</div>
                    )}
                    <div style={{ fontSize: 13, color: subColor, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', wordBreak: 'break-word', marginBottom: dtConfig ? 6 : 0 }}>
                      {msg.body}
                    </div>
                    {dtConfig && !isArchived && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
                        <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, background: isDark ? '#1e2a3a' : '#eff6ff', color: '#3b82f6', fontWeight: 600 }}>{dtConfig.label}</span>
                        {msg.deadline && (
                          <span style={{ fontSize: 11, color: isOverdue ? '#dc2626' : '#d97706', fontWeight: 600 }}>
                            {isOverdue ? '期限切れ' : `${msg.deadline}まで`}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                  {/* アーカイブ・お気に入りボタン */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
                    <button type="button"
                      onClick={e => toggleFavMessage(e, msg.id, msg)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, padding: '2px 4px', color: favMessageIds.has(msg.id) ? '#f59e0b' : subColor, opacity: favMessageIds.has(msg.id) ? 1 : 0.4 }}>
                      {favMessageIds.has(msg.id) ? '★' : '☆'}
                    </button>
                    <button type="button"
                      onClick={e => { e.stopPropagation(); archiveMessage(msg.id, !isArchived); }}
                      style={{ background: 'none', border: `1px solid ${border}`, borderRadius: 6, color: subColor, cursor: 'pointer', fontSize: 11, padding: '3px 8px' }}>
                      {isArchived ? '📥 受信トレイに戻す' : '📦 アーカイブ'}
                    </button>
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
  const activeOthersForCompose = allProfiles.filter(p => p.id !== user?.id);
  const composeFiltered = activeOthersForCompose.filter(p => !composeQuery || (p.name || '').includes(composeQuery));
  const composeEmpTypes = ([...new Set(activeOthersForCompose.map(p => p.employment_type || 'その他'))] as string[])
    .sort((a, b) => { const o = EMP_ORDER; const ai = o.indexOf(a), bi = o.indexOf(b); if (ai === -1 && bi === -1) return a > b ? 1 : -1; if (ai === -1) return 1; if (bi === -1) return -1; return ai - bi; });

  const composePanel = (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: bg }}>
      <div style={{ flex: 1, overflowY: 'auto', padding: '0 12px 16px', paddingTop: 58 }}>
        {/* 宛先 */}
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: subColor, marginBottom: 6, marginTop: 8 }}>宛先を選択 <span style={{ color: '#dc3545', fontSize: 11 }}>*必須</span></div>
          <input value={composeQuery} onChange={e => setComposeQuery(e.target.value)} placeholder="名前で検索..."
            style={{ width: '100%', padding: '7px 10px', borderRadius: 8, border: `1px solid ${border}`, background: inputBg, color: textColor, fontSize: 13, boxSizing: 'border-box', marginBottom: 6 }} />
          {/* 一括ボタン */}
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 6 }}>
            {composeEmpTypes.map(et => {
              const ids = composeFiltered.filter(p => (p.employment_type || 'その他') === et).map(p => p.id);
              const allSel = ids.length > 0 && ids.every(id => composeRecipientIds.includes(id));
              return (
                <button key={et} type="button" onClick={() => setComposeRecipientIds(prev => allSel ? prev.filter(id => !ids.includes(id)) : [...new Set([...prev, ...ids])])}
                  style={{ padding: '3px 8px', borderRadius: 10, border: 'none', cursor: 'pointer', fontSize: 11, background: allSel ? '#007bff' : (isDark ? '#495057' : '#e9ecef'), color: allSel ? '#fff' : (isDark ? '#fff' : '#333') }}>
                  {et}
                </button>
              );
            })}
            <button type="button" onClick={() => setComposeRecipientIds(composeFiltered.map(p => p.id))}
              style={{ padding: '3px 8px', borderRadius: 10, border: 'none', cursor: 'pointer', fontSize: 11, background: isDark ? '#495057' : '#e9ecef', color: isDark ? '#fff' : '#333' }}>全員</button>
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
                          {roleProfiles.map(p => (
                            <label key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '2px 0', cursor: 'pointer', fontSize: 12, color: textColor }}>
                              <input type="checkbox" checked={composeRecipientIds.includes(p.id)}
                                onChange={e => setComposeRecipientIds(prev => e.target.checked ? [...prev, p.id] : prev.filter(id => id !== p.id))} />
                              {p.name}
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
              <input value={composeSubject} onChange={e => setComposeSubject(e.target.value)} placeholder="件名（任意）"
                style={{ width: '100%', padding: '6px 10px', borderRadius: 6, border: `1px solid ${border}`, background: 'transparent', color: textColor, fontSize: 13, boxSizing: 'border-box' }} />
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
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 12, color: subColor, flexShrink: 0 }}>⏰ 期限日</span>
                <input type="date" value={composeDeadline} onChange={e => setComposeDeadline(e.target.value)} min={new Date().toISOString().slice(0, 10)}
                  style={{ fontSize: 12, padding: '4px 8px', borderRadius: 6, border: `1px solid ${border}`, background: 'transparent', color: textColor, flex: 1 }} />
                {composeDeadline && <button type="button" onClick={() => setComposeDeadline('')} style={{ fontSize: 11, color: subColor, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>✕</button>}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 12, color: subColor, flexShrink: 0 }}>🕐 送信予約</span>
                <input type="datetime-local" value={composeScheduledAt} onChange={e => setComposeScheduledAt(e.target.value)} min={new Date(Date.now() + 60000).toISOString().slice(0, 16)}
                  style={{ fontSize: 12, padding: '4px 8px', borderRadius: 6, border: `1px solid ${border}`, background: 'transparent', color: textColor, flex: 1 }} />
                {composeScheduledAt && <button type="button" onClick={() => setComposeScheduledAt('')} style={{ fontSize: 11, color: subColor, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>✕</button>}
              </div>
            </div>
          )}
        </div>

      </div>

      {/* 本文 + 送信（チャンネルと同レイアウト） */}
      <div style={{ padding: '10px 14px', borderTop: `1px solid ${border}`, background: cardBg, flexShrink: 0, display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <textarea value={composeBody} onChange={e => setComposeBody(e.target.value)} placeholder="本文を入力... *必須 (Ctrl+Enterで送信)"
          rows={2}
          onKeyDown={e => { if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); if (composeBody.trim() && composeRecipientIds.length > 0) setShowComposeSendConfirm(true); }}}
          style={{ flex: 1, padding: '8px 12px', borderRadius: 8, border: `1px solid ${border}`, background: inputBg, color: textColor, fontSize: 14, resize: 'none', fontFamily: 'inherit', lineHeight: 1.4 }} />
        <button type="button" onClick={() => { if (composeBody.trim() && composeRecipientIds.length > 0) setShowComposeSendConfirm(true); }}
          disabled={!composeBody.trim() || composeRecipientIds.length === 0 || sending}
          style={{ padding: '10px 18px', background: '#007bff', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 14, alignSelf: 'flex-end', opacity: (!composeBody.trim() || composeRecipientIds.length === 0 || sending) ? 0.5 : 1, whiteSpace: 'nowrap' }}>
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
          <div style={{ padding: '10px 14px', background: cardBg, borderBottom: `1px solid ${border}`, flexShrink: 0, paddingTop: 58 }}>
            <button type="button" onClick={() => setOutboxDetailId(null)}
              style={{ background: 'none', border: 'none', color: '#4a90d9', cursor: 'pointer', fontSize: 22, padding: '0 6px 0 0', fontWeight: 'bold', verticalAlign: 'middle' }}>←</button>
            <span style={{ fontSize: 15, fontWeight: 'bold', color: textColor, verticalAlign: 'middle' }}>
              {outboxDetail.subject || outboxDetail.title || 'お知らせ'}
            </span>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '16px 14px' }}>
            {/* 宛先リスト */}
            {(inboxRecipients[outboxDetail.id] || []).length > 0 && (
              <div style={{ marginBottom: 12, padding: '8px 12px', background: isDark ? '#1e2a3a' : '#eff6ff', borderRadius: 8, fontSize: 12 }}>
                <span style={{ color: isDark ? '#93c5fd' : '#3b82f6', fontWeight: 700 }}>宛先：</span>
                <span style={{ color: textColor }}>
                  {(inboxRecipients[outboxDetail.id] || []).map(uid => allProfiles.find(p => p.id === uid)?.name || '不明').join('、')}
                </span>
              </div>
            )}
            {renderMsg(outboxDetail)}
          </div>
        </div>
      ) : (
        <>
          <div style={{ paddingTop: 52, flexShrink: 0 }}>
            <div style={{ display: 'flex', borderBottom: `1px solid ${border}`, background: cardBg }}>
              {(['sent', 'draft'] as const).map(tab => (
                <button key={tab} type="button" onClick={() => setOutboxTab(tab)}
                  style={{ flex: 1, padding: '10px 0', background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: outboxTab === tab ? 700 : 400, color: outboxTab === tab ? '#007bff' : subColor, borderBottom: outboxTab === tab ? '2px solid #007bff' : '2px solid transparent' }}>
                  {tab === 'sent' ? '送信済み' : '下書き'}
                </button>
              ))}
            </div>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '8px 12px' }}>
            {outboxMessages.filter(m => outboxTab === 'sent' ? m.status !== 'draft' : m.status === 'draft').length === 0 ? (
              <div style={{ textAlign: 'center', color: subColor, fontSize: 13, marginTop: 40 }}>
                {outboxTab === 'sent' ? '送信済みのお知らせはありません' : '下書きはありません'}
              </div>
            ) : outboxMessages.filter(m => outboxTab === 'sent' ? m.status !== 'draft' : m.status === 'draft').map(msg => {
              const recipientIds = inboxRecipients[msg.id] || [];
              const recipientNames = recipientIds.slice(0, 3).map(uid => allProfiles.find(p => p.id === uid)?.name || '不明');
              return (
                <div key={msg.id} onClick={() => setOutboxDetailId(msg.id)}
                  style={{ background: cardBg, border: `1px solid ${border}`, borderRadius: 10, padding: '12px 14px', marginBottom: 8, cursor: 'pointer' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                    <span style={{ fontSize: 11, color: subColor }}>{fmtTime(msg.created_at)}</span>
                    <span style={{ fontSize: 11, color: subColor }}>{recipientIds.length}人</span>
                  </div>
                  {(msg.subject || msg.title) && (
                    <div style={{ fontSize: 14, fontWeight: 700, color: textColor, marginBottom: 4 }}>{msg.subject || msg.title}</div>
                  )}
                  <div style={{ fontSize: 13, color: subColor, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', wordBreak: 'break-word', marginBottom: 4 }}>
                    {msg.body}
                  </div>
                  {recipientNames.length > 0 && (
                    <div style={{ fontSize: 11, color: isDark ? '#93c5fd' : '#3b82f6' }}>
                      宛先: {recipientNames.join('、')}{recipientIds.length > 3 ? ` 他${recipientIds.length - 3}人` : ''}
                    </div>
                  )}
                </div>
              );
            })}
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
        {channelMessages.map(msg => renderMsg(msg))}
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
              期限・種別・送信予約
              {(newDeadlineType || newDeadline || newScheduledAt) && (
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#007bff', display: 'inline-block' }} />
              )}
            </span>
            <span style={{ fontSize: 11, color: subColor }}>{showOptionsExpanded ? '▲ 閉じる' : '▼ 開く'}</span>
          </button>
          {showOptionsExpanded && (
            <div style={{ padding: '10px 12px', background: inputBg, borderRadius: '0 0 8px 8px', border: `1px solid ${border}`, borderTop: 'none', display: 'flex', flexDirection: 'column', gap: 10 }}>
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
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 12, color: textColor, fontWeight: 600, flexShrink: 0 }}>⏰ 期限日</span>
                <input type="date" value={newDeadline} onChange={e => setNewDeadline(e.target.value)}
                  min={new Date().toISOString().slice(0, 10)}
                  style={{ fontSize: 12, padding: '4px 8px', borderRadius: 6, border: `1px solid ${border}`, background: isDark ? '#2a2a42' : '#fff', color: textColor, cursor: 'pointer', flex: 1 }} />
                {newDeadline && <button type="button" onClick={() => setNewDeadline('')} style={{ fontSize: 11, color: subColor, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>✕</button>}
              </div>
              {/* 送信予約 */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 12, color: textColor, fontWeight: 600, flexShrink: 0 }}>🕐 送信予約</span>
                <input type="datetime-local" value={newScheduledAt} onChange={e => setNewScheduledAt(e.target.value)}
                  min={new Date(Date.now() + 60000).toISOString().slice(0, 16)}
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
            onKeyDown={e => { if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); if (newBody.trim()) setShowSendConfirm(true); }}}
            style={{ flex: 1, padding: '8px 12px', borderRadius: 8, border: `1px solid ${border}`, background: inputBg, color: textColor, fontSize: 14, resize: 'none', fontFamily: 'inherit', lineHeight: 1.4 }}
          />
          <button
            type="button"
            onClick={() => { if (newBody.trim()) setShowSendConfirm(true); }}
            disabled={sending || !newBody.trim()}
            style={{ padding: '10px 18px', background: '#007bff', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 14, alignSelf: 'flex-end', opacity: sending || !newBody.trim() ? 0.5 : 1 }}
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
                return (
                  <div key={`fav-msg-${msg.id}`} onClick={() => { setInboxDetailId(msg.id); setView('inbox'); setShowSidebar(false); }} style={{
                    background: cardBg, border: `1px solid ${border}`, borderRadius: 10, padding: '10px 14px',
                    marginBottom: 8, cursor: 'pointer',
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div style={{ width: 28, height: 28, borderRadius: '50%', background: '#4a90d9', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 12, fontWeight: 'bold', flexShrink: 0 }}>
                          {avatarLetter(senderName)}
                        </div>
                        <span style={{ fontSize: 13, fontWeight: 'bold', color: textColor }}>{senderName}</span>
                        <span style={{ fontSize: 11, color: subColor }}>{fmtTime(msg.created_at)}</span>
                      </div>
                      <button type="button" onClick={e => toggleFavMessage(e, msg.id, msg)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, padding: 0, color: '#f59e0b', flexShrink: 0 }}>★</button>
                    </div>
                    {(msg.subject || msg.title) && (
                      <div style={{ fontSize: 14, fontWeight: 700, color: textColor, marginTop: 6 }}>{msg.subject || msg.title}</div>
                    )}
                    <div style={{ fontSize: 13, color: subColor, marginTop: 4, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', wordBreak: 'break-word' }}>{msg.body}</div>
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
                  <span style={{ fontSize: 11, color: subColor, marginLeft: 'auto' }}>{fmtTime(msg.created_at)}</span>
                </div>
                {(matchSubject || msg.subject) && (
                  <div style={{ fontSize: 13, fontWeight: 600, color: textColor, marginBottom: 4 }}>
                    {matchSubject ? highlightMatch(msg.subject!, searchText) : msg.subject}
                  </div>
                )}
                <div style={{ fontSize: 13, color: subColor, lineHeight: 1.5 }}>
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
      {/* サイドバーヘッダー */}
      {(showSidebar || !isMobile) && (
        <div style={{ position: 'fixed', top: 60, left: 0, zIndex: 100, background: cardBg, borderBottom: `1px solid ${border}`, width: isMobile ? '100%' : 280, boxSizing: 'border-box' }}>
          <div style={{ padding: '10px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 15, fontWeight: 'bold', color: textColor }}>💬 連絡板</span>
            <div style={{ display: 'flex', gap: 6 }}>
              <button type="button" onClick={() => { setShowSearch(s => !s); setSearchText(''); setSearchResults([]); if (view === 'search') setView('inbox'); }}
                style={{ background: 'none', border: `1px solid ${border}`, borderRadius: 6, color: subColor, cursor: 'pointer', fontSize: 14, padding: '4px 8px', lineHeight: 1 }}>🔍</button>
              <button type="button" onClick={() => { resetCompose(); setView('compose'); setShowSidebar(false); }}
                style={{ background: '#007bff', border: 'none', borderRadius: 6, color: '#fff', cursor: 'pointer', fontSize: 13, padding: '5px 12px', fontWeight: 'bold' }}>＋送信</button>
              <button type="button" onClick={() => navigate('/notification-settings')}
                style={{ background: 'none', border: `1px solid ${border}`, borderRadius: 6, color: subColor, cursor: 'pointer', fontSize: 12, padding: '4px 8px' }}>通知設定</button>
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
        <div style={{ position: 'fixed', top: 60, left: isMobile ? 0 : 280, right: 0, zIndex: 100, padding: '10px 14px', borderBottom: `1px solid ${border}`, background: cardBg, display: 'flex', alignItems: 'center', gap: 8 }}>
          {isMobile && (
            <button type="button" onClick={() => { setShowSidebar(true); if (view === 'channel') { setSelectedChannelId(null); setShowChannelList(true); } }}
              style={{ background: 'none', border: 'none', color: '#4a90d9', cursor: 'pointer', fontSize: 22, padding: '0 6px', lineHeight: 1, fontWeight: 'bold' }}>←</button>
          )}
          {view === 'channel' && selectedChannel ? (
            <>
              <div style={{ width: 32, height: 32, borderRadius: selectedChannel.type === 'group' ? 8 : '50%', background: selectedChannel.type === 'group' ? '#6f42c1' : '#4a90d9', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 14, flexShrink: 0 }}>
                {selectedChannel.type === 'group' ? '👥' : avatarLetter(channelDisplayName(selectedChannel))}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 'bold', color: textColor }}>{channelDisplayName(selectedChannel)}</div>
                <div style={{ fontSize: 11, color: subColor }}>{currentMembers.length}人</div>
              </div>
              <button type="button" onClick={openMemberModal} style={{ background: 'none', border: `1px solid ${border}`, borderRadius: 6, color: subColor, cursor: 'pointer', fontSize: 12, padding: '4px 8px', flexShrink: 0 }}>👥 メンバー</button>
            </>
          ) : (
            <span style={{ fontSize: 15, fontWeight: 'bold', color: textColor }}>{viewTitle[view]}</span>
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
        const chMembers = members.filter(m => m.channel_id === selectedChannelId);
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
        const today = new Date().toISOString().slice(0, 10);
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
                {/* 種別・期限バッジ */}
                {dtConfig && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, paddingBottom: 8, borderBottom: `1px solid ${border}` }}>
                    <span style={{ fontSize: 18, fontWeight: 800, color: textColor }}>{dtConfig.label.replace(/^\S+\s/, '')}確認</span>
                    {newDeadline && (
                      <div style={{ display: 'inline-flex', alignItems: 'center', borderRadius: 20, overflow: 'hidden', border: `1.5px solid ${accentColor}` }}>
                        <span style={{ fontSize: 11, fontWeight: 700, color: '#fff', background: accentColor, padding: '2px 8px' }}>{isOverdue ? '期限切れ' : isToday ? '本日締切' : '期限'}</span>
                        <span style={{ fontSize: 11, color: accentColor, padding: '2px 8px' }}>{newDeadline.replace(/-/g, '/')}まで</span>
                      </div>
                    )}
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
        const dtConfig = DEADLINE_TYPES.find(d => d.value === msg.deadline_type);
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
                    await supabase.functions.invoke('send-push', {
                      body: {
                        user_ids: unconfirmedUserIds,
                        title: `📌 ${dtConfig ? dtConfig.label + 'をお願いします' : '確認をお願いします'}`,
                        body: msg.body.slice(0, 50),
                        url: '/board',
                        tag: `confirm-${unconfirmedMsgId}`,
                      },
                    });
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
        const today = new Date().toISOString().slice(0, 10);
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
                {/* 件名 */}
                {composeSubject && (
                  <div style={{ fontSize: 15, fontWeight: 700, color: textColor, marginBottom: 6 }}>{composeSubject}</div>
                )}
                {/* 種別・期限バッジ */}
                {dtConfig && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, paddingBottom: 8, borderBottom: `1px solid ${border}` }}>
                    <span style={{ fontSize: 18, fontWeight: 800, color: textColor }}>{dtConfig.label.replace(/^\S+\s/, '')}確認</span>
                    {composeDeadline && (
                      <div style={{ display: 'inline-flex', alignItems: 'center', borderRadius: 20, overflow: 'hidden', border: `1.5px solid ${accentColor}` }}>
                        <span style={{ fontSize: 11, fontWeight: 700, color: '#fff', background: accentColor, padding: '2px 8px' }}>{isOverdue ? '期限切れ' : isToday ? '本日締切' : '期限'}</span>
                        <span style={{ fontSize: 11, color: accentColor, padding: '2px 8px' }}>{composeDeadline.replace(/-/g, '/')}まで</span>
                      </div>
                    )}
                  </div>
                )}
                {/* 内容・保存先・URL */}
                {(composeAnswerPrompt || composeAnswerLocation || composeAnswerLink) && (
                  <div style={{ marginBottom: 8, padding: '7px 10px', background: isDark ? '#1e2a3a' : '#eff6ff', borderRadius: 8, borderLeft: '3px solid #3b82f6', display: 'flex', flexDirection: 'column', gap: 4 }}>
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
        <div style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', zIndex: 9999, background: isDark ? '#1a3a28' : '#f0fdf4', border: `1px solid ${isDark ? '#16532a' : '#86efac'}`, borderRadius: 12, padding: '20px 28px', boxShadow: '0 4px 20px rgba(0,0,0,0.15)', display: 'flex', alignItems: 'center', gap: 12, minWidth: 220 }}>
          <div style={{ width: 36, height: 36, borderRadius: '50%', background: '#22c55e', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 18, flexShrink: 0 }}>✓</div>
          <span style={{ fontSize: 15, fontWeight: 'bold', color: isDark ? '#4ade80' : '#166534' }}>{memberBanner ? 'メンバーを保存しました' : '保存しました'}</span>
          <button type="button" onClick={() => { setSaveBanner(false); setMemberBanner(false); }} style={{ marginLeft: 'auto', background: 'none', border: 'none', color: isDark ? '#4ade80' : '#166534', cursor: 'pointer', fontSize: 16, padding: '0 4px' }}>✕</button>
        </div>
      )}
    </div>
  );
};

export default BoardPage;

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient';
import { useAuth } from '../hooks/useAuth';
import { useDarkMode } from '../hooks/useDarkMode';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

interface Channel {
  id: string;
  type: 'group' | 'dm';
  name: string | null;
  created_by: string | null;
  created_at: string;
}

interface ChannelMember {
  channel_id: string;
  user_id: string;
  profile: { name: string | null; role_title: string | null } | null;
}

interface BoardMessage {
  id: string;
  channel_id: string;
  parent_id: string | null;
  user_id: string;
  body: string;
  edited_at: string | null;
  created_at: string;
  deadline: string | null;
  deadline_type: string | null;
  requires_confirmation: boolean;
  scheduled_at: string | null;
  profile: { name: string | null } | null;
}

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
  { value: 'read',    label: '📖 読了',  reportLabel: '読了報告',  doneLabel: '読了済み' },
  { value: 'answer',  label: '✏️ 回答', reportLabel: '回答報告',  doneLabel: '回答済み' },
  { value: 'submit',  label: '📤 提出', reportLabel: '提出報告',  doneLabel: '提出済み' },
  { value: 'approve', label: '✅ 承認', reportLabel: '承認報告',  doneLabel: '承認済み' },
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

  const [selectedChannelId,  setSelectedChannelId]  = useState<string | null>(null);
  const [expandedThreadId,   setExpandedThreadId]   = useState<string | null>(null);
  const [showChannelList,    setShowChannelList]     = useState(true);

  // Compose
  const [newBody,              setNewBody]              = useState('');
  const [newDeadline,          setNewDeadline]          = useState('');
  const [newDeadlineType,      setNewDeadlineType]      = useState('');
  const [newScheduledAt,       setNewScheduledAt]       = useState('');
  const [showOptionsExpanded,  setShowOptionsExpanded]  = useState(false);
  const [confirmations,        setConfirmations]        = useState<Record<string, string[]>>({});
  const [myConfirmTimes,       setMyConfirmTimes]       = useState<Record<string, string>>({});
  const [unconfirmedMsgId,     setUnconfirmedMsgId]     = useState<string | null>(null);
  const [replyBody,            setReplyBody]            = useState('');
  const [editingId,   setEditingId]   = useState<string | null>(null);
  const [editBody,         setEditBody]         = useState('');
  const [sending,          setSending]          = useState(false);
  const [showSendConfirm,  setShowSendConfirm]  = useState(false);

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
  const [loadingData,      setLoadingData]      = useState(true);
  const [readDetailMsgId,  setReadDetailMsgId]  = useState<string | null>(null);
  const [readDetailUsers,  setReadDetailUsers]  = useState<{ user_id: string; read_at: string }[]>([]);
  const [showReadDetail,   setShowReadDetail]   = useState(true); // 設定: 全員が既読詳細を見れるか

  const [saveBanner, setSaveBanner] = useState(false);
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);
  const messagesEndRef = useRef<HTMLDivElement>(null);

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

    const [chRes, memRes, msgRes, lsRes, profRes, settingsRes] = await Promise.all([
      supabase.from('board_channels').select('*').in('id', cids),
      supabase.from('board_channel_members').select('channel_id, user_id').in('channel_id', cids),
      supabase.from('board_messages').select('id, channel_id, parent_id, user_id, body, edited_at, created_at, deadline, deadline_type, requires_confirmation, scheduled_at').in('channel_id', cids).or(`scheduled_at.is.null,scheduled_at.lte.${new Date().toISOString()}`).order('created_at', { ascending: false }).limit(500),
      supabase.from('board_channel_last_seen').select('channel_id, last_seen_at').eq('user_id', user.id),
      supabase.from('profiles').select('id, name, role_title, employment_type').eq('is_active', true).order('name'),
      supabase.from('master_options').select('value').eq('category', 'board_show_read_detail').limit(1),
    ]);

    setChannels((chRes.data || []) as Channel[]);
    setMembers((memRes.data || []).map((m: any) => ({ channel_id: m.channel_id, user_id: m.user_id, profile: null })));
    setMessages((msgRes.data || []).map((m: any) => ({ ...m, profile: null })));

    // requires_confirmation / deadline_type ありの投稿の確認者を取得
    const confirmMsgIds = (msgRes.data || []).filter((m: any) => m.requires_confirmation || m.deadline_type).map((m: any) => m.id);
    if (confirmMsgIds.length > 0) {
      const { data: confData } = await supabase.from('board_confirmations').select('message_id, user_id').in('message_id', confirmMsgIds);
      const confMap: Record<string, string[]> = {};
      (confData || []).forEach((c: { message_id: string; user_id: string }) => {
        if (!confMap[c.message_id]) confMap[c.message_id] = [];
        confMap[c.message_id].push(c.user_id);
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

  useEffect(() => { loadAll(); }, [loadAll]);

  useEffect(() => {
    if (selectedChannelId) messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, selectedChannelId]);

  // ── Computed ────────────────────────────────────────────────────

  const channelDisplayName = (ch: Channel) => {
    if (ch.type === 'group') return ch.name || 'グループ';
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
    setExpandedThreadId(null);
    setNewBody('');
    if (isMobile) setShowChannelList(false);

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

    const { data, error } = await supabase
      .from('board_messages')
      .insert(insertData)
      .select('id, channel_id, parent_id, user_id, body, edited_at, created_at, deadline, deadline_type, requires_confirmation, scheduled_at')
      .single();

    if (!error && data) {
      const msg: BoardMessage = { ...data, profile: { name: profileName || null } };
      setMessages(prev => [...prev, msg]);
      await supabase.from('board_reads').upsert({ message_id: data.id, user_id: user.id }, { onConflict: 'message_id,user_id', ignoreDuplicates: true });
      setReadCounts(prev => ({ ...prev, [data.id]: 1 }));
    }
    if (parentId) setReplyBody(''); else { setNewBody(''); setNewDeadline(''); setNewDeadlineType(''); setNewScheduledAt(''); }
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
    const isExpanded = expandedThreadId === msg.id;
    const readCount = readCounts[msg.id] || 0;
    const senderName = allProfiles.find(p => p.id === msg.user_id)?.name || msg.profile?.name || '不明';
    const confirmedIdsTop = confirmations[msg.id] || [];
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
                {avatarLetter(msg.profile?.name)}
              </div>
              <span style={{ fontSize: 13, fontWeight: 'bold', color: textColor }}>{senderName}</span>
              <span style={{ fontSize: 11, color: subColor }}>{fmtTime(msg.created_at)}</span>
              {msg.edited_at && <span style={{ fontSize: 10, color: subColor }}>(編集済み)</span>}
            </div>
            {canEdit && (
              <div style={{ display: 'flex', gap: 2 }}>
                <button type="button" onClick={() => { setEditingId(msg.id); setEditBody(msg.body); }} style={{ background: 'none', border: 'none', color: subColor, cursor: 'pointer', fontSize: 13, padding: '2px 4px' }}>✏️</button>
                <button type="button" onClick={() => deleteMessage(msg.id)} style={{ background: 'none', border: 'none', color: '#dc3545', cursor: 'pointer', fontSize: 13, padding: '2px 4px' }}>🗑️</button>
              </div>
            )}
          </div>

          {/* Body / Edit field */}
          {msg.deadline && !msg.parent_id && (() => {
            const today = new Date().toISOString().slice(0, 10);
            const isOverdue = msg.deadline < today;
            const isToday = msg.deadline === today;
            const dtConfig = DEADLINE_TYPES.find(d => d.value === msg.deadline_type);
            return (
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginTop: 4, marginBottom: 2, padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 'bold', background: isOverdue ? '#fee2e2' : isToday ? '#fef3c7' : '#e0f2fe', color: isOverdue ? '#991b1b' : isToday ? '#92400e' : '#0369a1' }}>
                {isOverdue ? '⚠️ 期限切れ' : isToday ? '⏰ 本日期限' : dtConfig ? `📅 ${dtConfig.label}` : '📅 期限'}
                {' '}{msg.deadline.replace(/-/g, '/') + 'まで'}
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
            <div style={{ fontSize: 14, color: textColor, whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.5 }}>{msg.body}</div>
          )}

          {/* 確認ボタン（deadline_type / requires_confirmation ありの親投稿） */}
          {(msg.deadline_type || msg.requires_confirmation) && !msg.parent_id && (() => {
            const confirmedIds = confirmations[msg.id] || [];
            const alreadyConfirmed = confirmedIds.includes(user?.id ?? '');
            const myConfirmTime = myConfirmTimes[msg.id];
            const channelMemberIds = members.filter(m => m.channel_id === msg.channel_id).map(m => m.user_id);
            const unconfirmedIds = channelMemberIds.filter(id => !confirmedIds.includes(id));
            const dtConfig = DEADLINE_TYPES.find(d => d.value === msg.deadline_type);
            const reportLabel = dtConfig ? dtConfig.reportLabel : '確認報告';
            const doneLabel   = dtConfig ? dtConfig.doneLabel   : '確認済み';
            return (
              <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                {!alreadyConfirmed ? (
                  <button type="button" onClick={async () => {
                    if (!user) return;
                    const now = new Date().toISOString();
                    await supabase.from('board_confirmations').upsert({ message_id: msg.id, user_id: user.id }, { onConflict: 'message_id,user_id', ignoreDuplicates: true });
                    setConfirmations(prev => ({ ...prev, [msg.id]: [...(prev[msg.id] || []), user.id] }));
                    setMyConfirmTimes(prev => ({ ...prev, [msg.id]: now }));
                  }} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '8px 18px', background: '#fff', border: '2px solid #22c55e', borderRadius: 24, cursor: 'pointer', fontSize: 14, fontWeight: 500, color: '#166534' }}>
                    <span style={{ fontSize: 18, lineHeight: 1 }}>○</span> {reportLabel}
                  </button>
                ) : (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '8px 18px', background: '#22c55e', border: '2px solid #22c55e', borderRadius: 24, fontSize: 14, fontWeight: 500, color: '#fff' }}>
                    <span style={{ fontSize: 18, lineHeight: 1 }}>✓</span> {doneLabel}（{myConfirmTime ? fmtTime(myConfirmTime) : '済み'}）
                  </span>
                )}
                <span style={{ fontSize: 13, color: subColor }}>
                  {confirmedIds.length}人確認済み
                </span>
                {isAdmin && unconfirmedIds.length > 0 && (
                  <button type="button" onClick={() => setUnconfirmedMsgId(msg.id)}
                    style={{ padding: '4px 12px', background: '#fd7e14', color: '#fff', border: 'none', borderRadius: 20, cursor: 'pointer', fontSize: 12 }}>
                    未確認者を確認・リマインド
                  </button>
                )}
              </div>
            );
          })()}

          {/* Footer (parent only) */}
          {!isReply && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6 }}>
              <button type="button" onClick={() => setExpandedThreadId(isExpanded ? null : msg.id)} style={{ background: 'none', border: 'none', color: '#4a90d9', cursor: 'pointer', fontSize: 12, padding: 0 }}>
                {isExpanded ? '▲ 閉じる' : replyCount > 0 ? `▼ リプライ ${replyCount}件` : '💬 リプライ'}
              </button>
              {(() => {
                const chMemberCount = members.filter(m => m.channel_id === msg.channel_id).length;
                const unreadCount = Math.max(0, chMemberCount - readCount);
                const label = <span style={{ fontSize: 11, color: subColor }}>既読{readCount} 未読{unreadCount}</span>;
                return showReadDetail ? (
                  <button type="button" onClick={async () => {
                    const { data } = await supabase.from('board_reads').select('user_id, read_at').eq('message_id', msg.id);
                    setReadDetailUsers((data || []).map((r: any) => ({ user_id: r.user_id, read_at: r.read_at })));
                    setReadDetailMsgId(msg.id);
                  }} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, padding: 0, textDecoration: 'underline dotted', textUnderlineOffset: 2, color: subColor }}>
                    {label}
                  </button>
                ) : (
                  <span style={{ fontSize: 11 }}>{label}</span>
                );
              })()}
            </div>
          )}
        </div>

        {/* Thread replies */}
        {!isReply && isExpanded && (
          <div style={{ marginTop: 4 }}>
            {replies.map(r => renderMsg(r, true))}
            <div style={{ marginLeft: 36, marginTop: 6, display: 'flex', gap: 6 }}>
              <input
                value={replyBody}
                onChange={e => setReplyBody(e.target.value)}
                placeholder="リプライを入力..."
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(msg.id); }}}
                style={{ flex: 1, padding: '6px 10px', borderRadius: 6, border: `1px solid ${border}`, background: inputBg, color: textColor, fontSize: 13 }}
              />
              <button type="button" onClick={() => sendMessage(msg.id)} disabled={sending || !replyBody.trim()} style={{ padding: '6px 12px', background: '#28a745', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, opacity: sending || !replyBody.trim() ? 0.5 : 1 }}>送信</button>
            </div>
          </div>
        )}
      </div>
    );
  };

  // ── Modals ───────────────────────────────────────────────────────

  const overlayStyle: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 };
  const modalStyle: React.CSSProperties = { background: cardBg, borderRadius: 12, padding: 24, width: '90%', maxWidth: 440, maxHeight: '80vh', overflowY: 'auto' };

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

  const dmModal = showDMSearch ? (
    <div style={overlayStyle}>
      <div style={modalStyle}>
        <div style={{ fontSize: 16, fontWeight: 'bold', color: textColor, marginBottom: 12 }}>個人メッセージを送る</div>
        <input
          value={dmQuery}
          onChange={e => setDmQuery(e.target.value)}
          placeholder="名前で検索..."
          autoFocus
          style={{ width: '100%', padding: '8px 12px', borderRadius: 6, border: `1px solid ${border}`, background: inputBg, color: textColor, fontSize: 14, marginBottom: 10, boxSizing: 'border-box' }}
        />
        <div style={{ maxHeight: 300, overflowY: 'auto', border: `1px solid ${border}`, borderRadius: 8 }}>
          {(() => {
            const filtered = allProfiles
              .filter(p => p.id !== user?.id && (p.name || '').includes(dmQuery))
              .sort((a, b) => {
                const ea = EMP_ORDER.indexOf(a.employment_type || 'その他');
                const eb = EMP_ORDER.indexOf(b.employment_type || 'その他');
                const ei = (ea === -1 ? 99 : ea) - (eb === -1 ? 99 : eb);
                if (ei !== 0) return ei;
                const ra = ROLE_ORDER.indexOf(a.role_title || 'その他');
                const rb = ROLE_ORDER.indexOf(b.role_title || 'その他');
                const ri = (ra === -1 ? 99 : ra) - (rb === -1 ? 99 : rb);
                if (ri !== 0) return ri;
                return (a.name || '') > (b.name || '') ? 1 : -1;
              });
            let lastEmp = '';
            let lastRole = '';
            return filtered.map((p, i) => {
              const emp = p.employment_type || 'その他';
              const role = p.role_title || 'その他';
              const showEmpHeader = emp !== lastEmp;
              const showRoleHeader = showEmpHeader || role !== lastRole;
              lastEmp = emp; lastRole = role;
              return (
                <div key={p.id}>
                  {showEmpHeader && (
                    <div style={{ padding: '5px 12px', background: isDark ? '#1e2328' : '#dde3ee', borderTop: i > 0 ? `2px solid ${isDark ? '#4a5568' : '#8fa0c0'}` : undefined, fontSize: 12, fontWeight: 'bold', color: isDark ? '#90b4e8' : '#2c4a8a' }}>
                      {emp}
                    </div>
                  )}
                  {showRoleHeader && !showEmpHeader && (
                    <div style={{ padding: '3px 12px 3px 20px', background: isDark ? '#2d3136' : '#f0f0f0', borderTop: `1px solid ${isDark ? '#3d4349' : '#ccc'}`, fontSize: 11, color: isDark ? '#adb5bd' : '#666' }}>
                      {role}
                    </div>
                  )}
                  {showRoleHeader && showEmpHeader && (
                    <div style={{ padding: '3px 12px 3px 20px', background: isDark ? '#2d3136' : '#f0f0f0', fontSize: 11, color: isDark ? '#adb5bd' : '#666' }}>
                      {role}
                    </div>
                  )}
                  <div onClick={() => startDM(p.id)} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderBottom: `1px solid ${border}`, cursor: 'pointer' }}>
                    <div style={{ width: 32, height: 32, borderRadius: '50%', background: '#4a90d9', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 14, fontWeight: 'bold', flexShrink: 0 }}>{avatarLetter(p.name)}</div>
                    <div style={{ fontSize: 14, color: textColor, fontWeight: 'bold' }}>{p.name}</div>
                  </div>
                </div>
              );
            });
          })()}
        </div>
        <button type="button" onClick={() => { setShowDMSearch(false); setDmQuery(''); }} style={{ width: '100%', marginTop: 12, padding: 10, background: '#6c757d', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 14 }}>キャンセル</button>
      </div>
    </div>
  ) : null;

  // ── Panels ───────────────────────────────────────────────────────

  const channelListPanel = (
    <div style={{ width: isMobile ? '100%' : 280, background: sidebarBg, borderRight: isMobile ? 'none' : `1px solid ${border}`, display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', flexShrink: 0 }}>
      {/* Sidebar header */}
      <div style={{ padding: '12px 14px', borderBottom: `1px solid ${border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0 }}>
        <span style={{ fontSize: 15, fontWeight: 'bold', color: textColor }}>💬 連絡板</span>
        <div style={{ display: 'flex', gap: 6 }}>
          <button type="button" onClick={() => navigate('/account')} title="通知設定" style={{ background: 'none', border: `1px solid ${border}`, borderRadius: 6, color: subColor, cursor: 'pointer', fontSize: 14, padding: '4px 8px' }}>🔔</button>
          <button type="button" onClick={() => setShowDMSearch(true)} title="個人メッセージ" style={{ background: 'none', border: `1px solid ${border}`, borderRadius: 6, color: subColor, cursor: 'pointer', fontSize: 14, padding: '4px 8px' }}>✉️</button>
          {isAdmin && (
            <button type="button" onClick={() => setShowGroupModal(true)} title="グループ作成" style={{ background: 'none', border: `1px solid ${border}`, borderRadius: 6, color: subColor, cursor: 'pointer', fontSize: 14, padding: '4px 8px' }}>＋</button>
          )}
        </div>
      </div>

      {/* Channel list */}
      <div style={{ overflowY: 'auto', flex: 1 }}>
        {loadingData ? (
          <div style={{ padding: 20, textAlign: 'center', color: subColor, fontSize: 13 }}>読み込み中...</div>
        ) : sortedChannels.length === 0 ? (
          <div style={{ padding: 20, textAlign: 'center', color: subColor, fontSize: 13 }}>チャンネルがありません</div>
        ) : sortedChannels.map(ch => {
          const last = channelLastMsg(ch.id);
          const unread = channelUnread(ch.id);
          const isSelected = ch.id === selectedChannelId;
          return (
            <div key={ch.id} onClick={() => selectChannel(ch.id)} style={{
              padding: '10px 14px', cursor: 'pointer', borderBottom: `1px solid ${border}`,
              background: isSelected ? (isDark ? '#2d3561' : '#e8f0fe') : 'transparent',
              display: 'flex', alignItems: 'center', gap: 10,
            }}>
              <div style={{ width: 38, height: 38, borderRadius: ch.type === 'group' ? 8 : '50%', background: ch.type === 'group' ? '#6f42c1' : '#4a90d9', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 15, flexShrink: 0 }}>
                {ch.type === 'group' ? '👥' : avatarLetter(channelDisplayName(ch))}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 13, fontWeight: unread > 0 ? 'bold' : 'normal', color: textColor, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 140 }}>{channelDisplayName(ch)}</span>
                  <span style={{ fontSize: 10, color: subColor, flexShrink: 0 }}>{last ? fmtTime(last.created_at) : ''}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 2 }}>
                  <span style={{ fontSize: 12, color: subColor, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '75%' }}>{last?.body || 'まだメッセージがありません'}</span>
                  {unread > 0 && (
                    <span style={{ background: '#dc3545', color: '#fff', borderRadius: 10, fontSize: 10, minWidth: 18, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 4px', fontWeight: 'bold', flexShrink: 0 }}>{unread > 99 ? '99+' : unread}</span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );

  const messagePanel = selectedChannelId && selectedChannel ? (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Channel header */}
      <div style={{ padding: '10px 14px', borderBottom: `1px solid ${border}`, background: cardBg, display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        {isMobile && (
          <button type="button" onClick={() => { setShowChannelList(true); setSelectedChannelId(null); }} style={{ background: 'none', border: 'none', color: '#4a90d9', cursor: 'pointer', fontSize: 20, padding: '0 4px', lineHeight: 1 }}>←</button>
        )}
        <div style={{ width: 32, height: 32, borderRadius: selectedChannel.type === 'group' ? 8 : '50%', background: selectedChannel.type === 'group' ? '#6f42c1' : '#4a90d9', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 14, flexShrink: 0 }}>
          {selectedChannel.type === 'group' ? '👥' : avatarLetter(channelDisplayName(selectedChannel))}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 'bold', color: textColor }}>{channelDisplayName(selectedChannel)}</div>
          <div style={{ fontSize: 11, color: subColor }}>{currentMembers.length}人</div>
        </div>
        {isAdmin && (
          <button type="button" onClick={async () => {
            const next = !showReadDetail;
            setShowReadDetail(next);
            await supabase.from('master_options').delete().eq('category', 'board_show_read_detail');
            await supabase.from('master_options').insert({ category: 'board_show_read_detail', value: String(next), sort_order: 0 });
          }} title={showReadDetail ? '既読詳細: 全員表示中（タップでOFF）' : '既読詳細: 非表示中（タップでON）'} style={{ background: 'none', border: `1px solid ${showReadDetail ? '#22c55e' : border}`, borderRadius: 6, color: showReadDetail ? '#22c55e' : subColor, cursor: 'pointer', fontSize: 12, padding: '4px 8px', flexShrink: 0 }}>
            👁 既読
          </button>
        )}
        <button type="button" onClick={openMemberModal} style={{ background: 'none', border: `1px solid ${border}`, borderRadius: 6, color: subColor, cursor: 'pointer', fontSize: 12, padding: '4px 8px', flexShrink: 0 }}>👥 メンバー</button>
      </div>

      {/* Messages */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 14px', background: bg }}>
        {channelMessages.length === 0 && (
          <div style={{ textAlign: 'center', color: subColor, fontSize: 13, marginTop: 40 }}>まだメッセージがありません</div>
        )}
        {channelMessages.map(msg => renderMsg(msg))}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div style={{ padding: '10px 14px', borderTop: `1px solid ${border}`, background: cardBg, flexShrink: 0 }}>
        {/* 詳細設定（折りたたみ） */}
        <div style={{ marginBottom: 6 }}>
          <button type="button" onClick={() => setShowOptionsExpanded(e => !e)}
            style={{ background: 'none', border: 'none', color: subColor, cursor: 'pointer', fontSize: 12, padding: 0, display: 'flex', alignItems: 'center', gap: 4 }}>
            {showOptionsExpanded ? '▲' : '▼'} 期限・種別・送信予約
            {(newDeadlineType || newDeadline || newScheduledAt) && (
              <span style={{ color: '#007bff', fontWeight: 'bold', fontSize: 14 }}>●</span>
            )}
          </button>
          {showOptionsExpanded && (
            <div style={{ marginTop: 8, padding: '10px 12px', background: inputBg, borderRadius: 8, border: `1px solid ${border}`, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {/* 種別ボタングリッド */}
              <div>
                <div style={{ fontSize: 11, color: subColor, marginBottom: 6 }}>種別（選ぶと確認ボタンが付きます）</div>
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
              {/* 期限日 */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 12, color: subColor, flexShrink: 0 }}>⏰ 期限日</span>
                <input type="date" value={newDeadline}
                  onChange={e => setNewDeadline(e.target.value)}
                  min={new Date().toISOString().slice(0, 10)}
                  style={{ fontSize: 12, padding: '4px 8px', borderRadius: 6, border: `1px solid ${border}`, background: 'transparent', color: textColor, cursor: 'pointer', flex: 1 }} />
                {newDeadline && <button type="button" onClick={() => setNewDeadline('')} style={{ fontSize: 11, color: subColor, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>✕</button>}
              </div>
              {/* 送信予約 */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 12, color: subColor, flexShrink: 0 }}>🕐 送信予約</span>
                <input type="datetime-local" value={newScheduledAt}
                  onChange={e => setNewScheduledAt(e.target.value)}
                  min={new Date(Date.now() + 60000).toISOString().slice(0, 16)}
                  style={{ fontSize: 12, padding: '4px 8px', borderRadius: 6, border: `1px solid ${border}`, background: 'transparent', color: textColor, cursor: 'pointer', flex: 1 }} />
                {newScheduledAt && <button type="button" onClick={() => setNewScheduledAt('')} style={{ fontSize: 11, color: subColor, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>✕</button>}
              </div>
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <textarea
            value={newBody}
            onChange={e => setNewBody(e.target.value)}
            placeholder="メッセージを入力... (Enterで送信、Shift+Enterで改行)"
            rows={2}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }}}
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
      </div>
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

  return (
    <div style={{ paddingTop: 60, height: '100vh', display: 'flex', flexDirection: 'column', background: bg, overflow: 'hidden' }}>
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {(!isMobile || showChannelList)  && channelListPanel}
        {(!isMobile || !showChannelList) && messagePanel}
      </div>
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
      {showSendConfirm && (
        <div onClick={() => setShowSendConfirm(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 5000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div onClick={e => e.stopPropagation()} style={{ background: cardBg, borderRadius: 16, padding: 20, width: '100%', maxWidth: 420, boxSizing: 'border-box' }}>
            <p style={{ margin: '0 0 12px', fontSize: 16, fontWeight: 'bold', color: textColor }}>送信確認</p>
            <div style={{ background: inputBg, borderRadius: 10, padding: '12px 14px', marginBottom: 12, fontSize: 14, color: textColor, whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.6, maxHeight: 200, overflowY: 'auto' }}>
              {newBody}
            </div>
            {newDeadlineType && (
              <p style={{ margin: '0 0 8px', fontSize: 12, color: '#007bff' }}>
                種別: {DEADLINE_TYPES.find(d => d.value === newDeadlineType)?.label}（確認ボタンあり）
              </p>
            )}
            {newDeadline && (
              <p style={{ margin: '0 0 8px', fontSize: 12, color: '#0369a1' }}>📅 期限: {newDeadline}</p>
            )}
            {newScheduledAt && (
              <p style={{ margin: '0 0 8px', fontSize: 12, color: '#6f42c1' }}>
                🕐 送信予約: {new Date(newScheduledAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
              </p>
            )}
            <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
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
      )}

      {/* 未確認者一覧モーダル */}
      {unconfirmedMsgId && (() => {
        const msg = messages.find(m => m.id === unconfirmedMsgId);
        if (!msg) return null;
        const confirmedIds = confirmations[unconfirmedMsgId] || [];
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
                  {confirmedIds.map(uid => {
                    const p = allProfiles.find(ap => ap.id === uid);
                    return <div key={uid} style={{ fontSize: 13, color: subColor, padding: '5px 0', borderBottom: `1px solid ${border}` }}>✅ {p?.name || '不明'}</div>;
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

      {(saveBanner || memberBanner) && (
        <div style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', zIndex: 9999, background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 12, padding: '20px 28px', boxShadow: '0 4px 20px rgba(0,0,0,0.15)', display: 'flex', alignItems: 'center', gap: 12, minWidth: 220 }}>
          <div style={{ width: 36, height: 36, borderRadius: '50%', background: '#22c55e', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 18, flexShrink: 0 }}>✓</div>
          <span style={{ fontSize: 15, fontWeight: 'bold', color: '#166534' }}>{memberBanner ? 'メンバーを保存しました' : '保存しました'}</span>
          <button type="button" onClick={() => { setSaveBanner(false); setMemberBanner(false); }} style={{ marginLeft: 'auto', background: 'none', border: 'none', color: '#166534', cursor: 'pointer', fontSize: 16, padding: '0 4px' }}>✕</button>
        </div>
      )}
    </div>
  );
};

export default BoardPage;

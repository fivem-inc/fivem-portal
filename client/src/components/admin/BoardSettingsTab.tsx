import React, { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabaseClient';
import { useDarkMode } from '../../hooks/useDarkMode';
import { useAuth } from '../../hooks/useAuth';

interface SendPermissions {
  employment_types: string[];
  role_titles: string[];
}

interface Channel {
  id: string;
  name: string | null;
  type: 'group' | 'dm';
  send_permissions: SendPermissions | null;
  member_names?: string[];
}

interface Profile {
  id: string;
  name: string | null;
  employment_type: string | null;
  role_title: string | null;
}

const EMP_ORDER = ['正社員', 'パート'];
const DM_SETTINGS_KEY = 'dm_default_send_permissions';

const BoardSettingsTab: React.FC = () => {
  const isDark = useDarkMode();
  const { user } = useAuth();
  const [channels, setChannels] = useState<Channel[]>([]);
  const [allProfiles, setAllProfiles] = useState<Profile[]>([]);
  const [empTypes, setEmpTypes] = useState<string[]>([]);
  const [roleTitles, setRoleTitles] = useState<string[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pendingPerms, setPendingPerms] = useState<SendPermissions>({ employment_types: [], role_titles: [] });
  const [saving, setSaving] = useState(false);
  const [banner, setBanner] = useState(false);

  // DMデフォルト権限
  const [dmPerms, setDmPerms] = useState<SendPermissions>({ employment_types: [], role_titles: [] });
  const [editingDm, setEditingDm] = useState(false);
  const [pendingDmPerms, setPendingDmPerms] = useState<SendPermissions>({ employment_types: [], role_titles: [] });

  // グループチャンネル作成
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newChannelName, setNewChannelName] = useState('');
  const [selectedMemberIds, setSelectedMemberIds] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);

  // 既読詳細表示設定
  const [showReadDetail, setShowReadDetail] = useState(true);

  const text   = isDark ? '#ffffff' : '#212529';
  const sub    = isDark ? '#adb5bd' : '#6c757d';
  const border = isDark ? '#6c757d' : '#dee2e6';
  const rowBg  = isDark ? '#2d3136' : '#f8f9fa';
  const editBg = isDark ? '#1e2328' : '#eff6ff';

  useEffect(() => {
    (async () => {
      const [chRes, profRes, memRes, dmSettingsRes, readDetailRes] = await Promise.all([
        supabase.from('board_channels').select('id, name, type, send_permissions').order('type').order('created_at'),
        supabase.from('profiles').select('id, name, employment_type, role_title').eq('is_active', true),
        supabase.from('board_channel_members').select('channel_id, user_id'),
        supabase.from('app_settings').select('value').eq('key', DM_SETTINGS_KEY).maybeSingle(),
        supabase.from('master_options').select('value').eq('category', 'board_show_read_detail').limit(1),
      ]);
      const profiles: Profile[] = profRes.data || [];
      setAllProfiles(profiles);
      const profileMap: Record<string, string> = {};
      profiles.forEach((p: { id: string; name: string | null }) => { profileMap[p.id] = p.name || '不明'; });
      const membersByChannel: Record<string, string[]> = {};
      (memRes.data || []).forEach((m: { channel_id: string; user_id: string }) => {
        if (!membersByChannel[m.channel_id]) membersByChannel[m.channel_id] = [];
        membersByChannel[m.channel_id].push(profileMap[m.user_id] || '不明');
      });
      const chs = (chRes.data || []).map((ch: Channel) => ({
        ...ch,
        member_names: membersByChannel[ch.id] || [],
      }));
      setChannels(chs as Channel[]);

      if (dmSettingsRes.data?.value) {
        setDmPerms(dmSettingsRes.data.value as SendPermissions);
      }
      if (readDetailRes.data && readDetailRes.data.length > 0) {
        setShowReadDetail(readDetailRes.data[0].value !== 'false');
      }

      const ets = [...new Set(profiles.map((p: Profile) => p.employment_type).filter(Boolean))] as string[];
      const rts = [...new Set(profiles.map((p: Profile) => p.role_title).filter(Boolean))] as string[];
      setEmpTypes(ets.sort((a, b) => {
        const ai = EMP_ORDER.indexOf(a), bi = EMP_ORDER.indexOf(b);
        if (ai === -1 && bi === -1) return a > b ? 1 : -1;
        if (ai === -1) return 1; if (bi === -1) return -1;
        return ai - bi;
      }));
      setRoleTitles(rts);
    })();
  }, []);

  const startEdit = (ch: Channel) => {
    setEditingId(ch.id);
    setPendingPerms(ch.send_permissions
      ? { ...ch.send_permissions }
      : { employment_types: [], role_titles: [] }
    );
  };

  const save = async (chId: string) => {
    setSaving(true);
    const perms: SendPermissions | null =
      pendingPerms.employment_types.length === 0 && pendingPerms.role_titles.length === 0
        ? null
        : pendingPerms;
    await supabase.from('board_channels').update({ send_permissions: perms }).eq('id', chId);
    setChannels(prev => prev.map(ch => ch.id === chId ? { ...ch, send_permissions: perms } : ch));
    setEditingId(null);
    setSaving(false);
    showBanner();
  };

  const saveDm = async () => {
    setSaving(true);
    const perms: SendPermissions =
      pendingDmPerms.employment_types.length === 0 && pendingDmPerms.role_titles.length === 0
        ? { employment_types: [], role_titles: [] }
        : pendingDmPerms;
    await supabase.from('app_settings').upsert({ key: DM_SETTINGS_KEY, value: perms, updated_at: new Date().toISOString() });
    setDmPerms(perms);
    setEditingDm(false);
    setSaving(false);
    showBanner();
  };

  const createChannel = async () => {
    const name = newChannelName.trim();
    if (!name || !user) return;
    setCreating(true);
    const { data } = await supabase
      .from('board_channels')
      .insert({ name, type: 'group', created_by: user.id })
      .select('id, name, type, send_permissions')
      .single();
    if (data) {
      // 作成者 + 選択メンバーを登録
      const memberIds = [...new Set([user.id, ...selectedMemberIds])];
      await supabase.from('board_channel_members').insert(
        memberIds.map(uid => ({ channel_id: data.id, user_id: uid }))
      );
      const memberNames = memberIds
        .map(uid => allProfiles.find(p => p.id === uid)?.name || '不明')
        .filter(n => n !== '不明' || memberIds.some(id => allProfiles.find(p => p.id === id)));
      setChannels(prev => [...prev, { ...data, member_names: memberNames }]);
    }
    setNewChannelName('');
    setSelectedMemberIds([]);
    setShowCreateForm(false);
    setCreating(false);
    showBanner();
  };

  const deleteChannel = async (chId: string, chName: string) => {
    if (!window.confirm(`「${chName}」を削除しますか？\nメッセージ・メンバー情報もすべて削除されます。`)) return;
    await supabase.from('board_channel_members').delete().eq('channel_id', chId);
    await supabase.from('board_messages').delete().eq('channel_id', chId);
    await supabase.from('board_channels').delete().eq('id', chId);
    setChannels(prev => prev.filter(ch => ch.id !== chId));
    showBanner();
  };

  const showBanner = () => {
    setBanner(true);
    setTimeout(() => setBanner(false), 3000);
  };

  const toggleEmp = (et: string) => {
    setPendingPerms(prev => ({
      ...prev,
      employment_types: prev.employment_types.includes(et)
        ? prev.employment_types.filter(x => x !== et)
        : [...prev.employment_types, et],
    }));
  };

  const toggleRole = (rt: string) => {
    setPendingPerms(prev => ({
      ...prev,
      role_titles: prev.role_titles.includes(rt)
        ? prev.role_titles.filter(x => x !== rt)
        : [...prev.role_titles, rt],
    }));
  };

  const toggleDmEmp = (et: string) => {
    setPendingDmPerms(prev => ({
      ...prev,
      employment_types: prev.employment_types.includes(et)
        ? prev.employment_types.filter(x => x !== et)
        : [...prev.employment_types, et],
    }));
  };

  const toggleDmRole = (rt: string) => {
    setPendingDmPerms(prev => ({
      ...prev,
      role_titles: prev.role_titles.includes(rt)
        ? prev.role_titles.filter(x => x !== rt)
        : [...prev.role_titles, rt],
    }));
  };

  const chDisplayName = (ch: Channel): string =>
    ch.type === 'group'
      ? (ch.name || 'グループ')
      : `DM: ${(ch.member_names || []).join(' ・ ')}`;

  const permLabel = (p: SendPermissions | null): React.ReactNode => {
    if (!p || (p.employment_types.length === 0 && p.role_titles.length === 0)) {
      return <span style={{ color: '#22c55e', fontSize: 12 }}>全員が送信可</span>;
    }
    const parts: string[] = [...p.employment_types, ...p.role_titles];
    return <span style={{ color: '#3b82f6', fontSize: 12 }}>{parts.join('・')} のみ送信可</span>;
  };

  const pillStyle = (active: boolean) => ({
    display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer', fontSize: 13,
    color: text, padding: '4px 12px', borderRadius: 20,
    border: `1.5px solid ${active ? '#3b82f6' : border}`,
    background: active ? (isDark ? '#1e3a5f' : '#dbeafe') : 'transparent',
  });

  const renderEditPanel = (
    pending: SendPermissions,
    onToggleEmp: (et: string) => void,
    onToggleRole: (rt: string) => void,
    onSave: () => void,
    onCancel: () => void,
    onSetPerms: (p: SendPermissions) => void,
  ) => (
    <div style={{ padding: '14px 16px', background: editBg, borderTop: `1px solid ${border}` }}>
      <p style={{ fontSize: 12, color: sub, marginBottom: 12 }}>
        チェックした雇用形態・役職のみ送信できます。何も選択しない = 全員送信可
      </p>
      <div style={{ marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 'bold', color: isDark ? '#93c5fd' : '#3b82f6' }}>雇用形態</div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button type="button" onClick={() => onSetPerms({ ...pending, employment_types: [...empTypes] })}
              style={{ fontSize: 11, padding: '2px 8px', border: `1px solid ${border}`, borderRadius: 4, background: 'none', color: sub, cursor: 'pointer' }}>全選択</button>
            <button type="button" onClick={() => onSetPerms({ ...pending, employment_types: [] })}
              style={{ fontSize: 11, padding: '2px 8px', border: `1px solid ${border}`, borderRadius: 4, background: 'none', color: sub, cursor: 'pointer' }}>全解除</button>
          </div>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {empTypes.map(et => (
            <label key={et} style={pillStyle(pending.employment_types.includes(et))}>
              <input type="checkbox" checked={pending.employment_types.includes(et)} onChange={() => onToggleEmp(et)} style={{ accentColor: '#3b82f6' }} />
              {et}
            </label>
          ))}
        </div>
      </div>
      <div style={{ marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 'bold', color: isDark ? '#93c5fd' : '#3b82f6' }}>役職</div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button type="button" onClick={() => onSetPerms({ ...pending, role_titles: [...roleTitles] })}
              style={{ fontSize: 11, padding: '2px 8px', border: `1px solid ${border}`, borderRadius: 4, background: 'none', color: sub, cursor: 'pointer' }}>全選択</button>
            <button type="button" onClick={() => onSetPerms({ ...pending, role_titles: [] })}
              style={{ fontSize: 11, padding: '2px 8px', border: `1px solid ${border}`, borderRadius: 4, background: 'none', color: sub, cursor: 'pointer' }}>全解除</button>
          </div>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {roleTitles.map(rt => (
            <label key={rt} style={pillStyle(pending.role_titles.includes(rt))}>
              <input type="checkbox" checked={pending.role_titles.includes(rt)} onChange={() => onToggleRole(rt)} style={{ accentColor: '#3b82f6' }} />
              {rt}
            </label>
          ))}
        </div>
      </div>
      {(pending.employment_types.length > 0 || pending.role_titles.length > 0) && (
        <div style={{ marginBottom: 12, padding: '8px 12px', background: isDark ? '#1a2a3a' : '#eff6ff', borderRadius: 8, fontSize: 12, color: '#3b82f6' }}>
          送信できる人：{[...pending.employment_types, ...pending.role_titles].join('・')} ＋ 管理者
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button type="button" onClick={onCancel}
          style={{ padding: '5px 14px', background: 'none', border: `1px solid ${border}`, borderRadius: 6, color: sub, cursor: 'pointer', fontSize: 12 }}>
          キャンセル
        </button>
        <button type="button" onClick={onSave} disabled={saving}
          style={{ padding: '5px 16px', background: '#007bff', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 'bold', opacity: saving ? 0.6 : 1 }}>
          {saving ? '保存中...' : '保存'}
        </button>
      </div>
    </div>
  );

  return (
    <div style={{ color: text }}>
      <div style={{ fontSize: 18, fontWeight: 'bold', marginBottom: 16 }}>📨 連絡板 送信権限設定</div>
      <p style={{ fontSize: 13, color: sub, marginBottom: 20 }}>
        チャンネルごとに「誰が送信できるか」を設定します。
        何も選択しない場合は全員が送信できます。管理者は常に送信可能です。
      </p>

      {/* ── 既読詳細表示設定 ── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, padding: '10px 14px', background: rowBg, borderRadius: 8, border: `1px solid ${border}` }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 'bold', color: text }}>👁 既読詳細の表示</div>
          <div style={{ fontSize: 12, color: sub, marginTop: 2 }}>ONにすると、全員がメッセージの既読者リストを確認できます</div>
        </div>
        <button type="button" onClick={async () => {
          const next = !showReadDetail;
          setShowReadDetail(next);
          await supabase.from('master_options').delete().eq('category', 'board_show_read_detail');
          await supabase.from('master_options').insert({ category: 'board_show_read_detail', value: String(next), sort_order: 0 });
        }} style={{ padding: '6px 14px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 'bold', background: showReadDetail ? '#22c55e' : '#6c757d', color: '#fff', flexShrink: 0 }}>
          {showReadDetail ? 'ON' : 'OFF'}
        </button>
      </div>

      {/* ── グループチャンネル ── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, marginTop: 4 }}>
        <div style={{ fontSize: 13, fontWeight: 'bold', color: sub }}>👥 グループチャンネル</div>
        <button type="button" onClick={() => { setShowCreateForm(v => !v); setNewChannelName(''); setSelectedMemberIds([]); }}
          style={{ padding: '4px 12px', background: showCreateForm ? 'none' : '#6f42c1', color: showCreateForm ? sub : '#fff', border: showCreateForm ? `1px solid ${border}` : 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 'bold' }}>
          {showCreateForm ? 'キャンセル' : '＋ 新規作成'}
        </button>
      </div>

      {showCreateForm && (
        <div style={{ marginBottom: 12, padding: '14px 16px', border: `1px solid ${border}`, borderRadius: 10, background: rowBg }}>
          {/* チャンネル名 */}
          <input
            type="text"
            value={newChannelName}
            onChange={e => setNewChannelName(e.target.value)}
            placeholder="グループ名（例: リーダー連絡、西陣校チームなど）"
            style={{ width: '100%', padding: '8px 12px', borderRadius: 6, border: `1px solid ${border}`, background: isDark ? '#1e2328' : '#fff', color: text, fontSize: 13, marginBottom: 10, boxSizing: 'border-box' }}
            autoFocus
          />

          {/* 雇用形態一括ボタン */}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
            {empTypes.map(et => {
              const ids = allProfiles.filter(p => p.id !== user?.id && (p.employment_type || 'その他') === et).map(p => p.id);
              const allSel = ids.length > 0 && ids.every(id => selectedMemberIds.includes(id));
              return (
                <button key={et} type="button" onClick={() =>
                  setSelectedMemberIds(prev => allSel ? prev.filter(id => !ids.includes(id)) : [...new Set([...prev, ...ids])])
                } style={{ padding: '4px 10px', borderRadius: 12, border: 'none', cursor: 'pointer', fontSize: 12, background: allSel ? '#007bff' : (isDark ? '#495057' : '#e9ecef'), color: allSel ? '#fff' : (isDark ? '#fff' : '#333') }}>
                  {et}を一括選択
                </button>
              );
            })}
            <button type="button" onClick={() => setSelectedMemberIds(allProfiles.filter(p => p.id !== user?.id).map(p => p.id))}
              style={{ padding: '4px 10px', borderRadius: 12, border: 'none', cursor: 'pointer', fontSize: 12, background: isDark ? '#495057' : '#e9ecef', color: isDark ? '#fff' : '#333' }}>全員</button>
            <button type="button" onClick={() => setSelectedMemberIds([])}
              style={{ padding: '4px 10px', borderRadius: 12, border: 'none', cursor: 'pointer', fontSize: 12, background: isDark ? '#495057' : '#e9ecef', color: isDark ? '#fff' : '#333' }}>全解除</button>
          </div>

          {/* 雇用形態→役職別グリッド */}
          <div style={{ maxHeight: 300, overflowY: 'auto', border: `1px solid ${border}`, borderRadius: 8, marginBottom: 8 }}>
            {empTypes.map((et, gi) => {
              const etProfiles = allProfiles.filter(p => p.id !== user?.id && (p.employment_type || 'その他') === et);
              const roles = [...new Set(etProfiles.map(p => p.role_title || 'その他'))].sort();
              return (
                <div key={et}>
                  <div style={{ padding: '5px 10px', background: isDark ? '#2d3136' : '#e9ecef', borderTop: gi > 0 ? `2px solid ${isDark ? '#6c757d' : '#bbb'}` : undefined, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: 12, fontWeight: 'bold', color: isDark ? '#adb5bd' : '#444' }}>{et}</span>
                    <span style={{ fontSize: 11, color: isDark ? '#6c757d' : '#999' }}>{etProfiles.filter(p => selectedMemberIds.includes(p.id)).length}/{etProfiles.length}</span>
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', borderBottom: `1px solid ${isDark ? '#3d4349' : '#e0e0e0'}` }}>
                    {roles.map((role, ri) => {
                      const roleProfiles = etProfiles.filter(p => (p.role_title || 'その他') === role).sort((a, b) => (a.name || '') > (b.name || '') ? 1 : -1);
                      const allRoleSel = roleProfiles.length > 0 && roleProfiles.every(p => selectedMemberIds.includes(p.id));
                      return (
                        <div key={role} style={{ flex: '1 1 140px', borderLeft: ri > 0 ? `1px solid ${isDark ? '#3d4349' : '#e0e0e0'}` : undefined, padding: '6px 8px' }}>
                          <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, marginBottom: 4, paddingBottom: 3, borderBottom: `1px solid ${isDark ? '#3d4349' : '#eee'}`, cursor: 'pointer' }}>
                            <input type="checkbox" checked={allRoleSel}
                              onChange={() => {
                                const ids = roleProfiles.map(p => p.id);
                                setSelectedMemberIds(prev => allRoleSel ? prev.filter(id => !ids.includes(id)) : [...new Set([...prev, ...ids])]);
                              }} />
                            <span style={{ fontSize: 10, fontWeight: 'bold', color: isDark ? '#adb5bd' : '#555' }}>{role}</span>
                          </label>
                          {roleProfiles.map(p => (
                            <label key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0', cursor: 'pointer', fontSize: 12, color: text }}>
                              <input type="checkbox" checked={selectedMemberIds.includes(p.id)}
                                onChange={e => setSelectedMemberIds(prev => e.target.checked ? [...prev, p.id] : prev.filter(id => id !== p.id))} />
                              <span>{p.name || '不明'}</span>
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

          <p style={{ fontSize: 12, color: sub, marginBottom: 10 }}>{selectedMemberIds.length}人選択中</p>

          {/* 作成ボタン */}
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" onClick={() => { setShowCreateForm(false); setNewChannelName(''); setSelectedMemberIds([]); }}
              style={{ flex: 1, padding: '8px 0', background: '#6c757d', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 14 }}>
              キャンセル
            </button>
            <button type="button" onClick={createChannel} disabled={creating || !newChannelName.trim()}
              style={{ flex: 1, padding: '8px 0', background: '#007bff', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 14, fontWeight: 'bold', opacity: (creating || !newChannelName.trim()) ? 0.5 : 1 }}>
              {creating ? '作成中...' : `作成（${selectedMemberIds.length}人）`}
            </button>
          </div>
        </div>
      )}

      {channels.filter(ch => ch.type === 'group').map(ch => (
        <div key={ch.id} style={{ marginBottom: 10, border: `1px solid ${border}`, borderRadius: 10, overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', background: rowBg }}>
            <div>
              <span style={{ fontSize: 14, fontWeight: 'bold', marginRight: 10 }}>👥 {chDisplayName(ch)}</span>
              {permLabel(ch.send_permissions)}
            </div>
            {editingId === ch.id ? (
              <div style={{ display: 'flex', gap: 6 }}>
                <button type="button" onClick={() => setEditingId(null)}
                  style={{ padding: '4px 12px', background: 'none', border: `1px solid ${border}`, borderRadius: 6, color: sub, cursor: 'pointer', fontSize: 12 }}>
                  キャンセル
                </button>
                <button type="button" onClick={() => save(ch.id)} disabled={saving}
                  style={{ padding: '4px 14px', background: '#007bff', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 'bold', opacity: saving ? 0.6 : 1 }}>
                  {saving ? '保存中...' : '保存'}
                </button>
              </div>
            ) : (
              <div style={{ display: 'flex', gap: 6 }}>
                <button type="button" onClick={() => startEdit(ch)}
                  style={{ padding: '4px 12px', background: 'none', border: `1px solid ${border}`, borderRadius: 6, color: sub, cursor: 'pointer', fontSize: 12 }}>
                  ✏️ 編集
                </button>
                <button type="button" onClick={() => deleteChannel(ch.id, ch.name || 'チャンネル')}
                  style={{ padding: '4px 10px', background: 'none', border: `1px solid #dc3545`, borderRadius: 6, color: '#dc3545', cursor: 'pointer', fontSize: 12 }}>
                  🗑
                </button>
              </div>
            )}
          </div>
          {editingId === ch.id && renderEditPanel(pendingPerms, toggleEmp, toggleRole, () => save(ch.id), () => setEditingId(null), setPendingPerms)}
        </div>
      ))}

      {/* ── 個別連絡（DM）デフォルト設定 ── */}
      <div style={{ fontSize: 13, fontWeight: 'bold', color: sub, marginBottom: 8, marginTop: 24 }}>💬 個別連絡（DM）デフォルト設定</div>
      <p style={{ fontSize: 12, color: sub, marginBottom: 10 }}>
        個別メッセージ全体に適用されます。チャンネルごとの個別設定はありません。
      </p>
      <div style={{ marginBottom: 10, border: `1px solid ${border}`, borderRadius: 10, overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', background: rowBg }}>
          <div>
            <span style={{ fontSize: 14, fontWeight: 'bold', marginRight: 10 }}>💬 DM送信権限</span>
            {permLabel(dmPerms.employment_types.length === 0 && dmPerms.role_titles.length === 0 ? null : dmPerms)}
          </div>
          {editingDm ? (
            <div style={{ display: 'flex', gap: 6 }}>
              <button type="button" onClick={() => setEditingDm(false)}
                style={{ padding: '4px 12px', background: 'none', border: `1px solid ${border}`, borderRadius: 6, color: sub, cursor: 'pointer', fontSize: 12 }}>
                キャンセル
              </button>
              <button type="button" onClick={saveDm} disabled={saving}
                style={{ padding: '4px 14px', background: '#007bff', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 'bold', opacity: saving ? 0.6 : 1 }}>
                {saving ? '保存中...' : '保存'}
              </button>
            </div>
          ) : (
            <button type="button" onClick={() => { setEditingDm(true); setPendingDmPerms({ ...dmPerms }); }}
              style={{ padding: '4px 12px', background: 'none', border: `1px solid ${border}`, borderRadius: 6, color: sub, cursor: 'pointer', fontSize: 12 }}>
              ✏️ 編集
            </button>
          )}
        </div>
        {editingDm && renderEditPanel(pendingDmPerms, toggleDmEmp, toggleDmRole, saveDm, () => setEditingDm(false), setPendingDmPerms)}
      </div>

      {banner && (
        <div style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', zIndex: 9999, background: isDark ? '#1a3a28' : '#f0fdf4', border: `1px solid ${isDark ? '#16532a' : '#86efac'}`, borderRadius: 12, padding: '16px 24px', boxShadow: '0 4px 20px rgba(0,0,0,0.15)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 18 }}>✓</span>
          <span style={{ fontSize: 14, fontWeight: 'bold', color: isDark ? '#4ade80' : '#166534' }}>保存しました</span>
        </div>
      )}
    </div>
  );
};

export default BoardSettingsTab;

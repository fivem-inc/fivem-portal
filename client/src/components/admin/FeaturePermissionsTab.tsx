import React, { useState, useEffect, useCallback } from 'react';
import { useAdminPanel } from './AdminPanelContext';

interface Role {
  id: string;
  name: string;
  sort_order: number;
  is_fixed: boolean;
}

interface FeaturePermission {
  role_id: string;
  feature_key: string;
  enabled: boolean;
}

interface StaffMember {
  id: string;
  name: string;
  role_title: string;
}

const FEATURES = [
  { key: 'leave_request',   icon: '🌿', label: '休暇申請',       note: 'パートは別フロー' },
  { key: 'leave_calendar',  icon: '📅', label: '勤怠カレンダー', note: '' },
  { key: 'leave_approvals', icon: '✅', label: '休暇承認',       note: '承認者向けページ' },
  { key: 'shift_report',    icon: '⏰', label: '勤務変更報告',   note: '' },
  { key: 'expense',         icon: '🚃', label: '交通費申請',     note: '' },
  { key: 'trip_report',     icon: '📍', label: '出張報告',       note: '' },
  { key: 'board',           icon: '💬', label: '連絡板',         note: '' },
  { key: 'purchase_request', icon: '🧾', label: '備品購入申請・経費精算', note: 'パートも精算のみ利用可' },
  { key: 'overtime',        icon: '🕐', label: '残業・時間管理（正社員）', note: 'パートは勤務変更報告を利用' },
  { key: 'overtime_summary', icon: '📊', label: '残業の集計・超過バナー閲覧', note: '全員分を見られる役職' },
  { key: 'shift_pattern_directory', icon: '🗓', label: '全員のシフト予定 閲覧', note: 'パート含む全員の通常シフトを見られる役職' },
  // 安否確認は災害時に全員へ届く必要があるため、役職別のトグルは使わず公開/非公開だけで運用する
  // （役職で絞ると、その役職の人に安否確認が届かなくなってしまう）
  { key: 'safety_check',    icon: '🆘', label: '安否・緊急連絡',  note: '発信はマネージャー以上・回答は全員' },
] as const;

const FeaturePermissionsTab: React.FC = () => {
  const { isDarkMode, supabase, setSuccessMsg } = useAdminPanel();

  const [roles, setRoles] = useState<Role[]>([]);
  const [perms, setPerms] = useState<Record<string, Record<string, boolean>>>({});
  const [savedPerms, setSavedPerms] = useState<Record<string, Record<string, boolean>>>({});
  // 機能の公開/非公開（値が無いキーは公開扱い）
  const [published, setPublished] = useState<Record<string, boolean>>({});
  const [savedPublished, setSavedPublished] = useState<Record<string, boolean>>({});
  // リーダー以上公開（値が無いキーは false）
  const [publishedLeader, setPublishedLeader] = useState<Record<string, boolean>>({});
  const [savedPublishedLeader, setSavedPublishedLeader] = useState<Record<string, boolean>>({});
  // 社長のみ公開（値が無いキーは false）新機能の先行テスト用
  const [publishedPresident, setPublishedPresident] = useState<Record<string, boolean>>({});
  const [savedPublishedPresident, setSavedPublishedPresident] = useState<Record<string, boolean>>({});
  const [isEditMode, setIsEditMode] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [isRoleEditMode, setIsRoleEditMode] = useState(false);
  const [newRoleName, setNewRoleName] = useState('');
  const [addingRole, setAddingRole] = useState(false);

  const [editingRole, setEditingRole] = useState<Role | null>(null);
  const [editRoleName, setEditRoleName] = useState('');

  // 削除確認モーダル
  const [deleteTarget, setDeleteTarget] = useState<{ role: Role; staffCount: number } | null>(null);

  // スタッフ割り当てモーダル
  const [staffCounts, setStaffCounts] = useState<Record<string, number>>({});
  const [assignTarget, setAssignTarget] = useState<{ role: Role; staff: StaffMember[] } | null>(null);
  const [staffRoleChanges, setStaffRoleChanges] = useState<Record<string, string>>({});
  const [savingAssign, setSavingAssign] = useState(false);

  const bg       = isDarkMode ? '#1e2328' : '#f8f9fa';
  const cardBg   = isDarkMode ? '#2d3136' : '#ffffff';
  const border   = isDarkMode ? '#495057' : '#dee2e6';
  const text     = isDarkMode ? '#ffffff' : '#333333';
  const subText  = isDarkMode ? '#adb5bd' : '#666666';
  const headerBg = isDarkMode ? '#3d4147' : '#f0f4ff';

  const fetchAll = useCallback(async () => {
    setLoading(true);
    const [{ data: rolesData }, { data: permsData }, pubRes, pubLeaderRes, pubPresRes] = await Promise.all([
      supabase.from('roles').select('*').order('sort_order'),
      supabase.from('feature_permissions').select('role_id, feature_key, enabled'),
      supabase.from('app_settings').select('value').eq('key', 'feature_published').maybeSingle(),
      supabase.from('app_settings').select('value').eq('key', 'feature_published_leader').maybeSingle(),
      supabase.from('app_settings').select('value').eq('key', 'feature_published_president').maybeSingle(),
    ]);

    const pubMap = (pubRes?.data?.value as Record<string, boolean>) || {};
    setPublished(pubMap);
    setSavedPublished({ ...pubMap });
    const pubLeaderMap = (pubLeaderRes?.data?.value as Record<string, boolean>) || {};
    setPublishedLeader(pubLeaderMap);
    setSavedPublishedLeader({ ...pubLeaderMap });
    const pubPresMap = (pubPresRes?.data?.value as Record<string, boolean>) || {};
    setPublishedPresident(pubPresMap);
    setSavedPublishedPresident({ ...pubPresMap });

    const rolesList: Role[] = (rolesData as Role[]) || [];
    setRoles(rolesList);

    const permsMap: Record<string, Record<string, boolean>> = {};
    rolesList.forEach(r => { permsMap[r.id] = {}; });
    ((permsData as FeaturePermission[]) || []).forEach(p => {
      if (permsMap[p.role_id]) permsMap[p.role_id][p.feature_key] = p.enabled;
    });
    setPerms(permsMap);
    setSavedPerms(JSON.parse(JSON.stringify(permsMap)));
    setIsDirty(false);
    setIsEditMode(false);

    // スタッフ人数を役職名ごとに集計
    const { data: profilesData } = await supabase.from('profiles').select('role_title');
    const counts: Record<string, number> = {};
    (profilesData || []).forEach((p: { role_title: string }) => {
      if (p.role_title) counts[p.role_title] = (counts[p.role_title] || 0) + 1;
    });
    setStaffCounts(counts);

    setLoading(false);
  }, [supabase]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const togglePerm = (roleId: string, featureKey: string) => {
    setPerms(prev => ({
      ...prev,
      [roleId]: {
        ...prev[roleId],
        [featureKey]: !(prev[roleId]?.[featureKey] ?? false),
      },
    }));
    setIsDirty(true);
  };

  const togglePublish = (featureKey: string) => {
    setPublished(prev => ({
      ...prev,
      [featureKey]: !(prev[featureKey] !== false), // 値なし=公開なので、押すと非公開に
    }));
    setIsDirty(true);
  };

  const togglePublishLeader = (featureKey: string) => {
    setPublishedLeader(prev => ({
      ...prev,
      [featureKey]: !(prev[featureKey] === true), // 値なし=OFFなので、押すとON
    }));
    setIsDirty(true);
  };

  const togglePublishPresident = (featureKey: string) => {
    setPublishedPresident(prev => ({
      ...prev,
      [featureKey]: !(prev[featureKey] === true), // 値なし=OFFなので、押すとON
    }));
    setIsDirty(true);
  };

  const handleSavePerms = async () => {
    setSaving(true);
    const upserts = roles.flatMap(role =>
      FEATURES.map(feat => ({
        role_id:     role.id,
        feature_key: feat.key,
        enabled:     role.is_fixed ? true : (perms[role.id]?.[feat.key] ?? false),
        updated_at:  new Date().toISOString(),
      }))
    );
    const [{ error }, { error: pubError }, { error: pubLeaderError }, { error: pubPresError }] = await Promise.all([
      supabase.from('feature_permissions').upsert(upserts, { onConflict: 'role_id,feature_key' }),
      supabase.from('app_settings').upsert({ key: 'feature_published', value: published, updated_at: new Date().toISOString() }, { onConflict: 'key' }),
      supabase.from('app_settings').upsert({ key: 'feature_published_leader', value: publishedLeader, updated_at: new Date().toISOString() }, { onConflict: 'key' }),
      supabase.from('app_settings').upsert({ key: 'feature_published_president', value: publishedPresident, updated_at: new Date().toISOString() }, { onConflict: 'key' }),
    ]);
    setSaving(false);
    if (error || pubError || pubLeaderError || pubPresError) { setSuccessMsg('⚠ 保存に失敗しました: ' + (error?.message || pubError?.message || pubLeaderError?.message || pubPresError?.message)); return; }
    setSavedPerms(JSON.parse(JSON.stringify(perms)));
    setSavedPublished({ ...published });
    setSavedPublishedLeader({ ...publishedLeader });
    setSavedPublishedPresident({ ...publishedPresident });
    setIsDirty(false);
    setIsEditMode(false);
    setSuccessMsg('権限設定を保存しました');
  };

  // ── 並び替え ──
  const handleMove = async (role: Role, direction: 'up' | 'down') => {
    const sortable = roles.filter(r => !r.is_fixed);
    const idx = sortable.findIndex(r => r.id === role.id);
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= sortable.length) return;

    const target = sortable[swapIdx];
    const newOrderA = target.sort_order;
    const newOrderB = role.sort_order;

    await Promise.all([
      supabase.from('roles').update({ sort_order: newOrderA }).eq('id', role.id),
      supabase.from('roles').update({ sort_order: newOrderB }).eq('id', target.id),
    ]);
    fetchAll();
  };

  // ── 役職追加 ──
  const handleAddRole = async () => {
    const name = newRoleName.trim();
    if (!name) return;
    if (roles.some(r => r.name === name)) { setSuccessMsg('⚠ 同じ名前の役職がすでにあります'); return; }
    setAddingRole(true);
    const adminOrder = roles.find(r => r.is_fixed)?.sort_order ?? 99;
    const maxNonFixed = Math.max(...roles.filter(r => !r.is_fixed).map(r => r.sort_order), 0);
    const newOrder = Math.min(maxNonFixed + 1, adminOrder - 1);
    const { data, error } = await supabase
      .from('roles')
      .insert({ name, sort_order: newOrder, is_fixed: false })
      .select()
      .single();
    if (error || !data) { setSuccessMsg('⚠ 追加に失敗しました'); setAddingRole(false); return; }
    await supabase.from('feature_permissions').insert(
      FEATURES.map(f => ({ role_id: data.id, feature_key: f.key, enabled: false }))
    );
    setNewRoleName('');
    setAddingRole(false);
    fetchAll();
    setSuccessMsg(`「${name}」を追加しました`);
  };

  // ── 役職名編集 ──
  const handleOpenEdit = (role: Role) => {
    setEditingRole(role);
    setEditRoleName(role.name);
  };

  const handleSaveEditRole = async () => {
    if (!editingRole) return;
    const name = editRoleName.trim();
    if (!name) return;
    if (roles.some(r => r.name === name && r.id !== editingRole.id)) {
      setSuccessMsg('⚠ 同じ名前の役職がすでにあります');
      return;
    }
    const oldName = editingRole.name;
    await supabase.from('roles').update({ name }).eq('id', editingRole.id);
    await supabase.from('profiles').update({ role_title: name }).eq('role_title', oldName);
    setEditingRole(null);
    fetchAll();
    setSuccessMsg(`「${oldName}」→「${name}」に変更しました`);
  };

  // ── 役職削除（確認モーダル用） ──
  const handleClickDelete = async (role: Role) => {
    const { count } = await supabase
      .from('profiles')
      .select('id', { count: 'exact', head: true })
      .eq('role_title', role.name);
    setDeleteTarget({ role, staffCount: count ?? 0 });
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    await supabase.from('roles').delete().eq('id', deleteTarget.role.id);
    const name = deleteTarget.role.name;
    setDeleteTarget(null);
    fetchAll();
    setSuccessMsg(`「${name}」を削除しました`);
  };

  // ── スタッフ割り当てモーダル ──
  const handleOpenAssign = async (role: Role) => {
    const { data } = await supabase
      .from('profiles')
      .select('id, name, role_title')
      .eq('role_title', role.name)
      .order('name');
    setAssignTarget({ role, staff: (data as StaffMember[]) || [] });
    setStaffRoleChanges({});
  };

  const handleSaveAssignments = async () => {
    if (!assignTarget) return;
    setSavingAssign(true);
    await Promise.all(
      Object.entries(staffRoleChanges).map(([id, newRole]) =>
        supabase.from('profiles').update({ role_title: newRole }).eq('id', id)
      )
    );
    setSavingAssign(false);
    setAssignTarget(null);
    fetchAll();
    setSuccessMsg('スタッフの役職を更新しました');
  };

  const btnBase: React.CSSProperties = {
    padding: '6px 14px', borderRadius: 8,
    border: `1px solid ${border}`, cursor: 'pointer',
    fontSize: 12, background: isDarkMode ? '#495057' : '#f8f9fa', color: text,
  };

  const sortable = roles.filter(r => !r.is_fixed);

  if (loading) {
    return <p style={{ textAlign: 'center', color: subText, padding: 40 }}>読み込み中...</p>;
  }

  return (
    <div style={{ background: bg, minHeight: '60vh', padding: '0 0 40px' }}>
      <h3 style={{ textAlign: 'center', color: text, marginBottom: 6 }}>⚙️ 役職・機能権限管理</h3>
      <p style={{ textAlign: 'center', fontSize: 13, color: subText, marginBottom: 20 }}>
        役職の追加・編集・並べ替え・削除と、各役職が使える機能を設定します。
      </p>

      {/* ── 役職管理カード ── */}
      <div style={{ maxWidth: 820, margin: '0 auto 20px', padding: '0 12px' }}>
        <div style={{ background: cardBg, borderRadius: 12, border: `1px solid ${border}`, overflow: 'hidden' }}>
          <div style={{ padding: '12px 16px', background: isRoleEditMode ? (isDarkMode ? '#3a2e00' : '#fffbeb') : headerBg, borderBottom: `1px solid ${isRoleEditMode ? '#f59e0b' : border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', transition: 'background .2s' }}>
            <span style={{ fontWeight: 'bold', fontSize: 14, color: text }}>👥 役職一覧</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {isRoleEditMode && <span style={{ fontSize: 12, color: '#d97706', fontWeight: 'bold' }}>✏️ 編集中</span>}
              {!isRoleEditMode ? (
                <button onClick={() => setIsRoleEditMode(true)}
                  style={{ ...btnBase, background: '#f59e0b', color: '#fff', border: 'none', fontWeight: 'bold', padding: '5px 12px', fontSize: 12 }}>
                  ✏️ 変更する
                </button>
              ) : (
                <button onClick={() => { setIsRoleEditMode(false); setNewRoleName(''); }}
                  style={{ ...btnBase, background: '#6c757d', color: '#fff', border: 'none', padding: '5px 12px', fontSize: 12 }}>
                  完了
                </button>
              )}
            </div>
          </div>

          <div style={{ padding: '8px 0' }}>
            {roles.map((role) => {
              const nonFixedIdx = sortable.findIndex(r => r.id === role.id);
              const canUp   = !role.is_fixed && nonFixedIdx > 0;
              const canDown = !role.is_fixed && nonFixedIdx < sortable.length - 1;

              return (
                <div key={role.id} style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '9px 16px',
                  borderBottom: `1px solid ${border}`,
                  background: role.is_fixed
                    ? (isDarkMode ? '#1a3a6b22' : '#eff6ff')
                    : 'transparent',
                }}>
                  {/* 並び替えボタン（編集モード時のみ・固定役職はスペーサー） */}
                  {isRoleEditMode && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 1, flexShrink: 0, width: 14 }}>
                      {!role.is_fixed && <>
                        <button onClick={() => handleMove(role, 'up')} disabled={!canUp} title="上へ"
                          style={{ background: 'none', border: 'none', cursor: canUp ? 'pointer' : 'default', color: canUp ? subText : (isDarkMode ? '#444' : '#ddd'), fontSize: 10, padding: 0, lineHeight: 1 }}>
                          ▲
                        </button>
                        <button onClick={() => handleMove(role, 'down')} disabled={!canDown} title="下へ"
                          style={{ background: 'none', border: 'none', cursor: canDown ? 'pointer' : 'default', color: canDown ? subText : (isDarkMode ? '#444' : '#ddd'), fontSize: 10, padding: 0, lineHeight: 1 }}>
                          ▼
                        </button>
                      </>}
                    </div>
                  )}
                  {/* 役職名 */}
                  <span style={{ fontSize: 13, fontWeight: 500, color: text, flex: 1, textAlign: 'left' }}>{role.name}</span>
                  {/* スタッフ人数バッジ（クリックで割り当てモーダル） */}
                  <button
                    onClick={() => handleOpenAssign(role)}
                    title="スタッフ一覧を確認・変更"
                    style={{ background: 'none', border: `1px solid ${border}`, borderRadius: 10, padding: '2px 8px', fontSize: 11, color: subText, cursor: 'pointer', flexShrink: 0 }}
                  >
                    {staffCounts[role.name] || 0}人
                  </button>
                  {/* 固定バッジ or 編集/削除ボタン */}
                  {role.is_fixed ? (
                    <span style={{ fontSize: 10, background: '#3b82f6', color: '#fff', borderRadius: 8, padding: '2px 8px', flexShrink: 0 }}>固定</span>
                  ) : isRoleEditMode ? (
                    <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                      <button onClick={() => handleOpenEdit(role)} title="名前を変更"
                        style={{ ...btnBase, padding: '4px 10px', fontSize: 12 }}>
                        ✏️ 編集
                      </button>
                      <button onClick={() => handleClickDelete(role)} title="削除"
                        style={{ ...btnBase, padding: '4px 10px', fontSize: 12, color: '#dc3545', borderColor: '#fca5a5' }}>
                        ✕ 削除
                      </button>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>

          {/* 追加フォーム（編集モード時のみ） */}
          {isRoleEditMode && (
            <div style={{ padding: '8px 16px 14px', display: 'flex', gap: 8 }}>
              <input
                type="text"
                value={newRoleName}
                onChange={e => setNewRoleName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleAddRole(); }}
                placeholder="新しい役職名を入力..."
                style={{
                  flex: 1, padding: '7px 12px', borderRadius: 8,
                  border: `1px solid ${border}`,
                  background: isDarkMode ? '#3d4147' : '#fff',
                  color: text, fontSize: 13,
                }}
              />
              <button
                onClick={handleAddRole}
                disabled={addingRole || !newRoleName.trim()}
                style={{ ...btnBase, background: '#3b82f6', color: '#fff', border: 'none', opacity: !newRoleName.trim() ? 0.5 : 1 }}
              >
                {addingRole ? '追加中...' : '+ 追加'}
              </button>
            </div>
          )}

        </div>
      </div>

      {/* ── 役職名編集モーダル ── */}
      {editingRole && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2000 }}>
          <div style={{ background: cardBg, borderRadius: 12, padding: 24, width: 320, color: text, boxShadow: '0 4px 20px rgba(0,0,0,0.3)' }}>
            <h4 style={{ margin: '0 0 14px', fontSize: 15 }}>✏️ 役職名を編集</h4>
            <input
              type="text"
              value={editRoleName}
              onChange={e => setEditRoleName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleSaveEditRole(); }}
              autoFocus
              style={{
                width: '100%', padding: '8px 12px', borderRadius: 8,
                border: `1px solid ${border}`,
                background: isDarkMode ? '#3d4147' : '#fff',
                color: text, fontSize: 14, boxSizing: 'border-box', marginBottom: 10,
              }}
            />
            <p style={{ fontSize: 12, color: '#dc3545', margin: '0 0 14px', background: isDarkMode ? '#3a1a1a' : '#fff5f5', padding: '6px 10px', borderRadius: 6 }}>
              ⚠️ 名前を変更すると、この役職のスタッフ全員に反映されます
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setEditingRole(null)} style={btnBase}>キャンセル</button>
              <button onClick={handleSaveEditRole}
                style={{ ...btnBase, background: '#3b82f6', color: '#fff', border: 'none' }}>
                保存する
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── 削除確認モーダル ── */}
      {deleteTarget && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2000 }}>
          <div style={{ background: cardBg, borderRadius: 12, padding: 24, width: 320, color: text, boxShadow: '0 4px 20px rgba(0,0,0,0.3)' }}>
            <h4 style={{ margin: '0 0 10px', fontSize: 15, color: '#dc3545' }}>🚫 役職を削除</h4>
            <p style={{ fontSize: 14, margin: '0 0 10px', color: text }}>
              <strong>「{deleteTarget.role.name}」</strong> を削除しますか？
            </p>
            {deleteTarget.staffCount > 0 ? (
              <div style={{ background: isDarkMode ? '#3a1a1a' : '#fff3cd', border: `1px solid ${isDarkMode ? '#7a3030' : '#ffc107'}`, borderRadius: 8, padding: '10px 12px', marginBottom: 14 }}>
                <p style={{ margin: 0, fontSize: 13, color: isDarkMode ? '#fca5a5' : '#856404', fontWeight: 'bold' }}>
                  ⚠️ この役職のスタッフが <strong>{deleteTarget.staffCount} 人</strong>います。
                </p>
                <p style={{ margin: '4px 0 0', fontSize: 12, color: isDarkMode ? '#fca5a5' : '#856404' }}>
                  削除するとそのスタッフの役職が空欄になります。
                </p>
              </div>
            ) : (
              <p style={{ fontSize: 13, color: subText, margin: '0 0 14px' }}>
                この操作は取り消せません。
              </p>
            )}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setDeleteTarget(null)} style={btnBase}>キャンセル</button>
              <button onClick={handleConfirmDelete}
                style={{ ...btnBase, background: '#dc3545', color: '#fff', border: 'none' }}>
                削除する
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── スタッフ割り当てモーダル ── */}
      {assignTarget && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2000 }}>
          <div style={{ background: cardBg, borderRadius: 12, padding: 24, width: 400, maxWidth: '92vw', maxHeight: '80vh', display: 'flex', flexDirection: 'column', color: text, boxShadow: '0 4px 20px rgba(0,0,0,0.3)' }}>
            <h4 style={{ margin: '0 0 4px', fontSize: 15 }}>👥 {assignTarget.role.name} のスタッフ</h4>
            <p style={{ margin: '0 0 14px', fontSize: 12, color: subText }}>役職を変更する場合はドロップダウンで選択して保存してください</p>

            <div style={{ overflowY: 'auto', flex: 1, marginBottom: 14 }}>
              {assignTarget.staff.length === 0 ? (
                <p style={{ textAlign: 'center', color: subText, fontSize: 13, padding: '20px 0' }}>この役職のスタッフはいません</p>
              ) : (
                assignTarget.staff.map(staff => {
                  const currentRole = staffRoleChanges[staff.id] ?? staff.role_title;
                  const changed = staffRoleChanges[staff.id] !== undefined && staffRoleChanges[staff.id] !== staff.role_title;
                  return (
                    <div key={staff.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: `1px solid ${border}` }}>
                      <span style={{ flex: 1, fontSize: 13, color: text }}>{staff.name}</span>
                      <select
                        value={currentRole}
                        onChange={e => setStaffRoleChanges(prev => ({ ...prev, [staff.id]: e.target.value }))}
                        style={{
                          padding: '4px 8px', borderRadius: 6, fontSize: 12,
                          border: `1px solid ${changed ? '#f59e0b' : border}`,
                          background: changed ? (isDarkMode ? '#3a2e00' : '#fffbeb') : (isDarkMode ? '#3d4147' : '#fff'),
                          color: text, cursor: 'pointer',
                        }}
                      >
                        {roles.map(r => (
                          <option key={r.id} value={r.name}>{r.name}</option>
                        ))}
                      </select>
                    </div>
                  );
                })
              )}
            </div>

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setAssignTarget(null)} style={btnBase}>閉じる</button>
              {Object.keys(staffRoleChanges).some(id => staffRoleChanges[id] !== assignTarget.staff.find(s => s.id === id)?.role_title) && (
                <button
                  onClick={handleSaveAssignments}
                  disabled={savingAssign}
                  style={{ ...btnBase, background: '#22c55e', color: '#fff', border: 'none', fontWeight: 'bold' }}
                >
                  {savingAssign ? '保存中...' : '✓ 保存する'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── 機能別権限マトリクス ── */}
      <div style={{ maxWidth: 820, margin: '0 auto', padding: '0 12px' }}>
        <div style={{ background: cardBg, borderRadius: 12, border: `1px solid ${isEditMode ? '#f59e0b' : border}`, overflow: 'hidden', transition: 'border-color .2s' }}>
          <div style={{ padding: '12px 16px', background: isEditMode ? (isDarkMode ? '#3a2e00' : '#fffbeb') : headerBg, borderBottom: `1px solid ${isEditMode ? '#f59e0b' : border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', transition: 'background .2s' }}>
            <span style={{ fontWeight: 'bold', fontSize: 14, color: text }}>🔐 機能別 表示権限</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {isEditMode && <span style={{ fontSize: 12, color: '#d97706', fontWeight: 'bold' }}>✏️ 編集中</span>}
              {!isEditMode ? (
                <button onClick={() => setIsEditMode(true)}
                  style={{ ...btnBase, background: '#f59e0b', color: '#fff', border: 'none', fontWeight: 'bold', padding: '5px 12px', fontSize: 12 }}>
                  ✏️ 変更する
                </button>
              ) : (
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    onClick={() => { setPerms(JSON.parse(JSON.stringify(savedPerms))); setPublished({ ...savedPublished }); setPublishedLeader({ ...savedPublishedLeader }); setPublishedPresident({ ...savedPublishedPresident }); setIsDirty(false); setIsEditMode(false); }}
                    style={{ ...btnBase, padding: '5px 12px', fontSize: 12 }}
                  >
                    キャンセル
                  </button>
                  <button
                    onClick={handleSavePerms}
                    disabled={saving || !isDirty}
                    style={{
                      ...btnBase, padding: '5px 12px', fontSize: 12, border: 'none',
                      background: saving ? '#6c757d' : isDirty ? '#22c55e' : (isDarkMode ? '#495057' : '#e9ecef'),
                      color: isDirty || saving ? '#fff' : subText,
                      opacity: !isDirty && !saving ? 0.5 : 1,
                      cursor: isDirty ? 'pointer' : 'default',
                      fontWeight: isDirty ? 'bold' : 'normal',
                      transition: 'background .2s',
                    }}
                  >
                    {saving ? '保存中...' : isDirty ? '✓ 保存する' : '変更なし'}
                  </button>
                </div>
              )}
            </div>
          </div>

          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 480 }}>
              <thead>
                <tr>
                  <th style={{ fontSize: 12, color: subText, padding: '10px 14px', textAlign: 'left', background: isDarkMode ? '#2d3136' : '#fafafa', borderBottom: `1px solid ${border}`, minWidth: 140 }}>
                    機能
                  </th>
                  <th style={{ fontSize: 11, color: text, padding: '10px 6px', textAlign: 'center', background: isDarkMode ? '#1a2e1a' : '#f0fff4', borderBottom: `1px solid ${border}`, whiteSpace: 'nowrap', minWidth: 64 }}>
                    全公開
                    <div style={{ fontSize: 9, color: subText, fontWeight: 'normal', marginTop: 1 }}>全員に表示</div>
                  </th>
                  <th style={{ fontSize: 11, color: text, padding: '10px 6px', textAlign: 'center', background: isDarkMode ? '#1a2030' : '#eef4ff', borderBottom: `1px solid ${border}`, whiteSpace: 'nowrap', minWidth: 72 }}>
                    リーダー以上
                    <div style={{ fontSize: 9, color: subText, fontWeight: 'normal', marginTop: 1 }}>先行公開</div>
                  </th>
                  <th style={{ fontSize: 11, color: text, padding: '10px 6px', textAlign: 'center', background: isDarkMode ? '#2e1a30' : '#faeeff', borderBottom: `1px solid ${border}`, borderRight: `2px solid ${border}`, whiteSpace: 'nowrap', minWidth: 64 }}>
                    社長のみ
                    <div style={{ fontSize: 9, color: subText, fontWeight: 'normal', marginTop: 1 }}>テスト用</div>
                  </th>
                  {roles.map(role => (
                    <th key={role.id} style={{ fontSize: 11, color: subText, padding: '10px 6px', textAlign: 'center', background: isDarkMode ? '#2d3136' : '#fafafa', borderBottom: `1px solid ${border}`, whiteSpace: 'nowrap', minWidth: 68 }}>
                      {role.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {FEATURES.map(feat => (
                  <tr key={feat.key}>
                    <td style={{ padding: '10px 14px', fontSize: 13, color: text, borderBottom: `1px solid ${border}` }}>
                      <span style={{ marginRight: 5 }}>{feat.icon}</span>
                      {feat.label}
                      {feat.note && <div style={{ fontSize: 10, color: subText, marginTop: 2 }}>{feat.note}</div>}
                    </td>
                    {/* 全公開トグル（非公開なら管理者以外には非表示） */}
                    {(() => {
                      const pub = published[feat.key] !== false; // 値なし=公開
                      return (
                        <td style={{ textAlign: 'center', padding: '8px 6px', borderBottom: `1px solid ${border}`, background: isDarkMode ? '#1a2e1a55' : '#f0fff488' }}>
                          <button
                            onClick={() => { if (isEditMode) togglePublish(feat.key); }}
                            disabled={!isEditMode}
                            title={!isEditMode ? '「変更する」を押して編集モードに入ってください' : pub ? '全公開中（押すと非公開）' : '非公開（押すと全員に公開）'}
                            style={{
                              width: 36, height: 20, borderRadius: 10, border: 'none', padding: 0,
                              position: 'relative',
                              cursor: !isEditMode ? 'default' : 'pointer',
                              background: pub ? '#22c55e' : (isDarkMode ? '#555' : '#ccc'),
                              opacity: !isEditMode ? 0.7 : 1,
                              transition: 'background .15s, opacity .15s',
                            }}
                          >
                            <span style={{
                              position: 'absolute', top: 3,
                              left: pub ? 19 : 3,
                              width: 14, height: 14, borderRadius: '50%',
                              background: '#fff', transition: 'left .15s', display: 'block',
                            }} />
                          </button>
                        </td>
                      );
                    })()}
                    {/* リーダー以上 先行公開トグル */}
                    {(() => {
                      const pubL = publishedLeader[feat.key] === true; // 値なし=OFF
                      return (
                        <td style={{ textAlign: 'center', padding: '8px 6px', borderBottom: `1px solid ${border}`, background: isDarkMode ? '#1a203055' : '#eef4ff88' }}>
                          <button
                            onClick={() => { if (isEditMode) togglePublishLeader(feat.key); }}
                            disabled={!isEditMode}
                            title={!isEditMode ? '「変更する」を押して編集モードに入ってください' : pubL ? 'リーダー以上に公開中（押すとOFF）' : 'OFF（押すとリーダー以上に先行公開）'}
                            style={{
                              width: 36, height: 20, borderRadius: 10, border: 'none', padding: 0,
                              position: 'relative',
                              cursor: !isEditMode ? 'default' : 'pointer',
                              background: pubL ? '#3b82f6' : (isDarkMode ? '#555' : '#ccc'),
                              opacity: !isEditMode ? 0.7 : 1,
                              transition: 'background .15s, opacity .15s',
                            }}
                          >
                            <span style={{
                              position: 'absolute', top: 3,
                              left: pubL ? 19 : 3,
                              width: 14, height: 14, borderRadius: '50%',
                              background: '#fff', transition: 'left .15s', display: 'block',
                            }} />
                          </button>
                        </td>
                      );
                    })()}
                    {/* 社長のみ 先行公開トグル（新機能テスト用） */}
                    {(() => {
                      const pubP = publishedPresident[feat.key] === true; // 値なし=OFF
                      return (
                        <td style={{ textAlign: 'center', padding: '8px 6px', borderBottom: `1px solid ${border}`, borderRight: `2px solid ${border}`, background: isDarkMode ? '#2e1a3055' : '#faeeff88' }}>
                          <button
                            onClick={() => { if (isEditMode) togglePublishPresident(feat.key); }}
                            disabled={!isEditMode}
                            title={!isEditMode ? '「変更する」を押して編集モードに入ってください' : pubP ? '社長のみに公開中（押すとOFF）' : 'OFF（押すと社長のみに先行公開）'}
                            style={{
                              width: 36, height: 20, borderRadius: 10, border: 'none', padding: 0,
                              position: 'relative',
                              cursor: !isEditMode ? 'default' : 'pointer',
                              background: pubP ? '#a855f7' : (isDarkMode ? '#555' : '#ccc'),
                              opacity: !isEditMode ? 0.7 : 1,
                              transition: 'background .15s, opacity .15s',
                            }}
                          >
                            <span style={{
                              position: 'absolute', top: 3,
                              left: pubP ? 19 : 3,
                              width: 14, height: 14, borderRadius: '50%',
                              background: '#fff', transition: 'left .15s', display: 'block',
                            }} />
                          </button>
                        </td>
                      );
                    })()}
                    {roles.map(role => {
                      const isFixed = role.is_fixed;
                      const on = isFixed ? true : (perms[role.id]?.[feat.key] ?? false);
                      return (
                        <td key={role.id} style={{ textAlign: 'center', padding: '8px 6px', borderBottom: `1px solid ${border}` }}>
                          <button
                            onClick={() => { if (!isFixed && isEditMode) togglePerm(role.id, feat.key); }}
                            disabled={isFixed || !isEditMode}
                            title={isFixed ? '管理者は常にすべての機能を利用できます' : !isEditMode ? '「変更する」を押して編集モードに入ってください' : undefined}
                            style={{
                              width: 36, height: 20, borderRadius: 10, border: 'none', padding: 0,
                              position: 'relative',
                              cursor: isFixed || !isEditMode ? 'default' : 'pointer',
                              background: isFixed ? '#93c5fd' : on ? '#22c55e' : (isDarkMode ? '#555' : '#ccc'),
                              opacity: !isEditMode && !isFixed ? 0.7 : 1,
                              transition: 'background .15s, opacity .15s',
                            }}
                          >
                            <span style={{
                              position: 'absolute', top: 3,
                              left: on || isFixed ? 19 : 3,
                              width: 14, height: 14, borderRadius: '50%',
                              background: '#fff', transition: 'left .15s', display: 'block',
                            }} />
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ padding: '8px 14px', fontSize: 11, color: subText, lineHeight: 1.7 }}>
            🟢 <strong>全公開</strong>ON … 全員に表示／ 🔵 <strong>リーダー以上</strong>ON … リーダー・マネージャー・社長に先行表示（フロア責任者は含みません）／ 🟣 <strong>社長のみ</strong>ON … 社長・管理者だけに表示（新機能のテスト用）。<br />
            ・全公開ON → 全員に表示（他の設定は無視）<br />
            ・全公開OFF＋リーダー以上ON → <strong>リーダー以上だけ</strong>に表示（一般・パートには非表示）<br />
            ・全公開OFF＋社長のみON → <strong>社長・管理者だけ</strong>に表示<br />
            ・すべてOFF → <strong>管理者のみ</strong>（公開前の準備状態）<br />
            🔵 管理者は常にすべての機能を利用できます（変更不可）。各役職のトグルは表示される機能の中での可否です。
          </div>

        </div>
      </div>
    </div>
  );
};

export default FeaturePermissionsTab;

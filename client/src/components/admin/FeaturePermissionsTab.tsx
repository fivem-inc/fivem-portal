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

const FEATURES = [
  { key: 'leave_request',   icon: '🌿', label: '休暇申請',       note: 'パートは別フロー' },
  { key: 'leave_calendar',  icon: '📅', label: '休暇カレンダー', note: '' },
  { key: 'leave_approvals', icon: '✅', label: '休暇承認',       note: '承認者向けページ' },
  { key: 'shift_report',    icon: '⏰', label: '勤務変更申請',   note: '' },
  { key: 'expense',         icon: '🚃', label: '交通費申請',     note: '' },
  { key: 'trip_report',     icon: '📍', label: '出張報告',       note: '' },
  { key: 'board',           icon: '💬', label: '連絡板',         note: '' },
] as const;

const FeaturePermissionsTab: React.FC = () => {
  const { isDarkMode, supabase, setSuccessMsg } = useAdminPanel();

  const [roles, setRoles] = useState<Role[]>([]);
  const [perms, setPerms] = useState<Record<string, Record<string, boolean>>>({});
  const [savedPerms, setSavedPerms] = useState<Record<string, Record<string, boolean>>>({});
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

  const bg       = isDarkMode ? '#1e2328' : '#f8f9fa';
  const cardBg   = isDarkMode ? '#2d3136' : '#ffffff';
  const border   = isDarkMode ? '#495057' : '#dee2e6';
  const text     = isDarkMode ? '#ffffff' : '#333333';
  const subText  = isDarkMode ? '#adb5bd' : '#666666';
  const headerBg = isDarkMode ? '#3d4147' : '#f0f4ff';

  const fetchAll = useCallback(async () => {
    setLoading(true);
    const [{ data: rolesData }, { data: permsData }] = await Promise.all([
      supabase.from('roles').select('*').order('sort_order'),
      supabase.from('feature_permissions').select('role_id, feature_key, enabled'),
    ]);

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
    const { error } = await supabase
      .from('feature_permissions')
      .upsert(upserts, { onConflict: 'role_id,feature_key' });
    setSaving(false);
    if (error) { alert('保存に失敗しました: ' + error.message); return; }
    setSavedPerms(JSON.parse(JSON.stringify(perms)));
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
    if (roles.some(r => r.name === name)) { alert('同じ名前の役職がすでにあります'); return; }
    setAddingRole(true);
    const adminOrder = roles.find(r => r.is_fixed)?.sort_order ?? 99;
    const maxNonFixed = Math.max(...roles.filter(r => !r.is_fixed).map(r => r.sort_order), 0);
    const newOrder = Math.min(maxNonFixed + 1, adminOrder - 1);
    const { data, error } = await supabase
      .from('roles')
      .insert({ name, sort_order: newOrder, is_fixed: false })
      .select()
      .single();
    if (error || !data) { alert('追加に失敗しました'); setAddingRole(false); return; }
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
      alert('同じ名前の役職がすでにあります');
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
            {isRoleEditMode
              ? <span style={{ fontSize: 12, color: '#d97706', fontWeight: 'bold' }}>✏️ 編集中</span>
              : null}
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
                  {/* 並び替えボタン（編集モード時のみ） */}
                  {isRoleEditMode && !role.is_fixed && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 1, flexShrink: 0 }}>
                      <button onClick={() => handleMove(role, 'up')} disabled={!canUp} title="上へ"
                        style={{ background: 'none', border: 'none', cursor: canUp ? 'pointer' : 'default', color: canUp ? subText : (isDarkMode ? '#444' : '#ddd'), fontSize: 10, padding: 0, lineHeight: 1 }}>
                        ▲
                      </button>
                      <button onClick={() => handleMove(role, 'down')} disabled={!canDown} title="下へ"
                        style={{ background: 'none', border: 'none', cursor: canDown ? 'pointer' : 'default', color: canDown ? subText : (isDarkMode ? '#444' : '#ddd'), fontSize: 10, padding: 0, lineHeight: 1 }}>
                        ▼
                      </button>
                    </div>
                  )}
                  {/* 役職名 */}
                  <span style={{ fontSize: 13, fontWeight: 500, color: text, flex: 1 }}>{role.name}</span>
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

          {/* フッターボタン */}
          <div style={{ padding: '10px 16px', borderTop: `1px solid ${border}`, display: 'flex', justifyContent: 'flex-end' }}>
            {!isRoleEditMode ? (
              <button
                onClick={() => setIsRoleEditMode(true)}
                style={{ ...btnBase, background: '#f59e0b', color: '#fff', border: 'none', fontWeight: 'bold' }}
              >
                ✏️ 変更する
              </button>
            ) : (
              <button
                onClick={() => { setIsRoleEditMode(false); setNewRoleName(''); }}
                style={{ ...btnBase, background: '#6c757d', color: '#fff', border: 'none' }}
              >
                完了
              </button>
            )}
          </div>
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
            <h4 style={{ margin: '0 0 10px', fontSize: 15, color: '#dc3545' }}>🗑️ 役職を削除</h4>
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

      {/* ── 機能別権限マトリクス ── */}
      <div style={{ maxWidth: 820, margin: '0 auto', padding: '0 12px' }}>
        <div style={{ background: cardBg, borderRadius: 12, border: `1px solid ${isEditMode ? '#f59e0b' : border}`, overflow: 'hidden', transition: 'border-color .2s' }}>
          <div style={{ padding: '12px 16px', background: isEditMode ? (isDarkMode ? '#3a2e00' : '#fffbeb') : headerBg, borderBottom: `1px solid ${isEditMode ? '#f59e0b' : border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', transition: 'background .2s' }}>
            <span style={{ fontWeight: 'bold', fontSize: 14, color: text }}>🔐 機能別 表示権限</span>
            {isEditMode && <span style={{ fontSize: 12, color: '#d97706', fontWeight: 'bold' }}>✏️ 編集中</span>}
          </div>

          <div style={{ padding: '14px 16px', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12 }}>
            {roles.map(role => {
              const isFixed = role.is_fixed;
              return (
                <div key={role.id} style={{
                  background: isFixed
                    ? (isDarkMode ? '#1a3a6b22' : '#eff6ff')
                    : (isDarkMode ? '#3d4147' : '#fafafa'),
                  border: `1px solid ${isFixed ? '#93c5fd55' : border}`,
                  borderRadius: 10, overflow: 'hidden',
                }}>
                  {/* 役職名ヘッダー */}
                  <div style={{
                    padding: '8px 12px',
                    background: isFixed
                      ? (isDarkMode ? '#1a3a6b' : '#dbeafe')
                      : (isDarkMode ? '#495057' : '#e9ecef'),
                    display: 'flex', alignItems: 'center', gap: 6,
                  }}>
                    <span style={{ fontSize: 13, fontWeight: 'bold', color: text }}>{role.name}</span>
                    {isFixed && (
                      <span style={{ fontSize: 10, background: '#3b82f6', color: '#fff', borderRadius: 8, padding: '1px 6px' }}>固定</span>
                    )}
                  </div>
                  {/* 機能一覧 */}
                  <div style={{ padding: '6px 0' }}>
                    {FEATURES.map(feat => {
                      const on = isFixed ? true : (perms[role.id]?.[feat.key] ?? false);
                      return (
                        <div key={feat.key} style={{
                          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                          padding: '6px 12px',
                          opacity: !isEditMode && !isFixed ? 0.75 : 1,
                        }}>
                          <span style={{ fontSize: 12, color: text }}>
                            {feat.icon} {feat.label}
                          </span>
                          <button
                            onClick={() => { if (!isFixed && isEditMode) togglePerm(role.id, feat.key); }}
                            disabled={isFixed || !isEditMode}
                            title={isFixed ? '管理者は常にすべての機能を利用できます' : !isEditMode ? '「変更する」を押して編集モードに入ってください' : undefined}
                            style={{
                              width: 34, height: 19, borderRadius: 10, border: 'none', padding: 0,
                              position: 'relative', flexShrink: 0,
                              cursor: isFixed || !isEditMode ? 'default' : 'pointer',
                              background: isFixed ? '#93c5fd' : on ? '#22c55e' : (isDarkMode ? '#555' : '#ccc'),
                              transition: 'background .15s',
                            }}
                          >
                            <span style={{
                              position: 'absolute', top: 2.5,
                              left: on || isFixed ? 17 : 2.5,
                              width: 14, height: 14, borderRadius: '50%',
                              background: '#fff', transition: 'left .15s', display: 'block',
                            }} />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>

          <div style={{ padding: '8px 14px', fontSize: 11, color: subText }}>
            🔵 管理者は常にすべての機能を利用できます（変更不可）
          </div>

          <div style={{ padding: '12px 16px', borderTop: `1px solid ${border}`, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            {!isEditMode ? (
              <button
                onClick={() => setIsEditMode(true)}
                style={{ ...btnBase, background: '#f59e0b', color: '#fff', border: 'none', fontWeight: 'bold' }}
              >
                ✏️ 変更する
              </button>
            ) : (
              <>
                <button
                  onClick={() => {
                    setPerms(JSON.parse(JSON.stringify(savedPerms)));
                    setIsDirty(false);
                    setIsEditMode(false);
                  }}
                  style={btnBase}
                >
                  キャンセル
                </button>
                <button
                  onClick={handleSavePerms}
                  disabled={saving || !isDirty}
                  style={{
                    ...btnBase,
                    background: saving ? '#6c757d' : isDirty ? '#22c55e' : (isDarkMode ? '#495057' : '#e9ecef'),
                    color: isDirty || saving ? '#fff' : subText,
                    border: 'none',
                    opacity: !isDirty && !saving ? 0.5 : 1,
                    cursor: isDirty ? 'pointer' : 'default',
                    fontWeight: isDirty ? 'bold' : 'normal',
                    transition: 'background .2s',
                  }}
                >
                  {saving ? '保存中...' : isDirty ? '✓ 保存する' : '変更なし'}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default FeaturePermissionsTab;

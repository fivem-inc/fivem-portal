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
  // perms[role_id][feature_key] = true/false
  const [perms, setPerms] = useState<Record<string, Record<string, boolean>>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [newRoleName, setNewRoleName] = useState('');
  const [addingRole, setAddingRole] = useState(false);

  const [editingRole, setEditingRole] = useState<Role | null>(null);
  const [editRoleName, setEditRoleName] = useState('');

  const bg      = isDarkMode ? '#1e2328' : '#f8f9fa';
  const cardBg  = isDarkMode ? '#2d3136' : '#ffffff';
  const border  = isDarkMode ? '#495057' : '#dee2e6';
  const text    = isDarkMode ? '#ffffff' : '#333333';
  const subText = isDarkMode ? '#adb5bd' : '#666666';
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
    setSuccessMsg('権限設定を保存しました');
  };

  const handleAddRole = async () => {
    const name = newRoleName.trim();
    if (!name) return;
    if (roles.some(r => r.name === name)) { alert('同じ名前の役職がすでにあります'); return; }
    setAddingRole(true);
    // 管理者の直前の sort_order に挿入
    const adminOrder = roles.find(r => r.is_fixed)?.sort_order ?? 99;
    const { data, error } = await supabase
      .from('roles')
      .insert({ name, sort_order: adminOrder - 0.5, is_fixed: false })
      .select()
      .single();
    if (error || !data) { alert('追加に失敗しました'); setAddingRole(false); return; }
    // 新役職のデフォルト権限（全てOFF）を挿入
    await supabase.from('feature_permissions').insert(
      FEATURES.map(f => ({ role_id: data.id, feature_key: f.key, enabled: false }))
    );
    setNewRoleName('');
    setAddingRole(false);
    fetchAll();
    setSuccessMsg(`「${name}」を追加しました`);
  };

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
    // roles テーブルを更新
    await supabase.from('roles').update({ name }).eq('id', editingRole.id);
    // この役職のスタッフの role_title も更新（画面表示に影響するため）
    await supabase.from('profiles').update({ role_title: name }).eq('role_title', oldName);
    setEditingRole(null);
    fetchAll();
    setSuccessMsg(`「${oldName}」→「${name}」に変更しました`);
  };

  const handleDeleteRole = async (role: Role) => {
    const count = await supabase
      .from('profiles')
      .select('id', { count: 'exact', head: true })
      .eq('role_title', role.name);
    const staffCount = count.count ?? 0;
    const msg = staffCount > 0
      ? `「${role.name}」を削除しますか？\n⚠️ この役職のスタッフが ${staffCount} 人います。削除すると役職が空になります。`
      : `「${role.name}」を削除しますか？`;
    if (!window.confirm(msg)) return;
    await supabase.from('roles').delete().eq('id', role.id);
    fetchAll();
    setSuccessMsg(`「${role.name}」を削除しました`);
  };

  const btnBase: React.CSSProperties = {
    padding: '6px 14px', borderRadius: 8,
    border: `1px solid ${border}`, cursor: 'pointer',
    fontSize: 12, background: isDarkMode ? '#495057' : '#f8f9fa', color: text,
  };

  if (loading) {
    return <p style={{ textAlign: 'center', color: subText, padding: 40 }}>読み込み中...</p>;
  }

  return (
    <div style={{ background: bg, minHeight: '60vh', padding: '0 0 40px' }}>
      <h3 style={{ textAlign: 'center', color: text, marginBottom: 6 }}>⚙️ 役職・機能権限管理</h3>
      <p style={{ textAlign: 'center', fontSize: 13, color: subText, marginBottom: 20 }}>
        役職の追加・編集・削除と、各役職が使える機能を設定します。
      </p>

      {/* ── 役職管理カード ── */}
      <div style={{ maxWidth: 820, margin: '0 auto 20px', padding: '0 12px' }}>
        <div style={{ background: cardBg, borderRadius: 12, border: `1px solid ${border}`, overflow: 'hidden' }}>
          <div style={{ padding: '12px 16px', background: headerBg, borderBottom: `1px solid ${border}`, fontWeight: 'bold', fontSize: 14, color: text }}>
            👥 役職一覧
          </div>

          {/* 役職チップ */}
          <div style={{ padding: '12px 16px', display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {roles.map(role => (
              <div key={role.id} style={{
                display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 10px',
                borderRadius: 20, border: `1px solid ${border}`, fontSize: 13, color: text,
                background: role.is_fixed
                  ? (isDarkMode ? '#1a3a6b' : '#dbeafe')
                  : (isDarkMode ? '#3d4147' : '#f8f9fa'),
              }}>
                <span>{role.name}</span>
                {role.is_fixed ? (
                  <span style={{ fontSize: 10, background: '#3b82f6', color: '#fff', borderRadius: 8, padding: '1px 6px' }}>固定</span>
                ) : (
                  <>
                    <button onClick={() => handleOpenEdit(role)} title="編集"
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: subText, fontSize: 13, padding: '0 2px', lineHeight: 1 }}>
                      ✏️
                    </button>
                    <button onClick={() => handleDeleteRole(role)} title="削除"
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#dc3545', fontSize: 14, padding: '0 2px', lineHeight: 1 }}>
                      ✕
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>

          {/* 新規追加 */}
          <div style={{ padding: '8px 16px 16px', display: 'flex', gap: 8 }}>
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
        </div>
      </div>

      {/* ── 役職名編集モーダル ── */}
      {editingRole && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2000 }}>
          <div style={{ background: cardBg, borderRadius: 12, padding: 24, width: 320, color: text, boxShadow: '0 4px 20px rgba(0,0,0,0.3)' }}>
            <h4 style={{ margin: '0 0 14px', fontSize: 15 }}>役職名を編集</h4>
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
            <p style={{ fontSize: 12, color: '#dc3545', margin: '0 0 14px', background: '#fff5f5', padding: '6px 10px', borderRadius: 6 }}>
              ⚠️ 名前を変更すると、この役職のスタッフ全員に反映されます
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setEditingRole(null)} style={btnBase}>キャンセル</button>
              <button onClick={handleSaveEditRole}
                style={{ ...btnBase, background: '#3b82f6', color: '#fff', border: 'none' }}>
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── 機能別権限マトリクス ── */}
      <div style={{ maxWidth: 820, margin: '0 auto', padding: '0 12px' }}>
        <div style={{ background: cardBg, borderRadius: 12, border: `1px solid ${border}`, overflow: 'hidden' }}>
          <div style={{ padding: '12px 16px', background: headerBg, borderBottom: `1px solid ${border}`, fontWeight: 'bold', fontSize: 14, color: text }}>
            🔐 機能別 表示権限
          </div>

          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 480 }}>
              <thead>
                <tr>
                  <th style={{
                    fontSize: 12, color: subText, padding: '10px 14px',
                    textAlign: 'left', background: isDarkMode ? '#2d3136' : '#fafafa',
                    borderBottom: `1px solid ${border}`, minWidth: 140,
                  }}>
                    機能
                  </th>
                  {roles.map(role => (
                    <th key={role.id} style={{
                      fontSize: 11, color: subText, padding: '10px 6px',
                      textAlign: 'center', background: isDarkMode ? '#2d3136' : '#fafafa',
                      borderBottom: `1px solid ${border}`, whiteSpace: 'nowrap', minWidth: 68,
                    }}>
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
                      {feat.note && (
                        <div style={{ fontSize: 10, color: subText, marginTop: 2 }}>{feat.note}</div>
                      )}
                    </td>
                    {roles.map(role => {
                      const isFixed = role.is_fixed;
                      const on = isFixed ? true : (perms[role.id]?.[feat.key] ?? false);
                      return (
                        <td key={role.id} style={{ textAlign: 'center', padding: '8px 6px', borderBottom: `1px solid ${border}` }}>
                          <button
                            onClick={() => { if (!isFixed) togglePerm(role.id, feat.key); }}
                            disabled={isFixed}
                            title={isFixed ? '管理者は常にすべての機能を利用できます' : undefined}
                            style={{
                              width: 36, height: 20, borderRadius: 10, border: 'none', padding: 0,
                              position: 'relative', cursor: isFixed ? 'default' : 'pointer',
                              background: isFixed ? '#93c5fd' : on ? '#22c55e' : (isDarkMode ? '#555' : '#ccc'),
                              transition: 'background .15s',
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

          <div style={{ padding: '8px 14px', fontSize: 11, color: subText }}>
            🔵 管理者は常にすべての機能を利用できます（変更不可）
          </div>

          <div style={{ padding: '12px 16px', borderTop: `1px solid ${border}`, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button onClick={fetchAll} style={btnBase}>リセット</button>
            <button
              onClick={handleSavePerms}
              disabled={saving}
              style={{ ...btnBase, background: saving ? '#6c757d' : '#28a745', color: '#fff', border: 'none' }}
            >
              {saving ? '保存中...' : '✓ 保存する'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default FeaturePermissionsTab;

import React from 'react';
import { useAdminPanel } from './AdminPanelContext';

const GroupsTab: React.FC = () => {
  const ctx = useAdminPanel();
  const { isDarkMode, selectedGroup, setSelectedGroup, editingGroupName, setEditingGroupName, editGroupNameValue, setEditGroupNameValue, newGroupName, setNewGroupName, showAddGroup, setShowAddGroup, masterOptions, users, setUsers, isUserEditMode, setIsUserEditMode, fetchMasterOptions, fetchUsers, supabase } = ctx;

  return (
          <div>
            <h3 style={{ textAlign: 'center', marginBottom: 20, color: isDarkMode ? '#fff' : '#000' }}>
              {selectedGroup ? (
                <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                  <button onClick={() => { setSelectedGroup(null); setEditingGroupName(false); setIsUserEditMode(false); }} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: isDarkMode ? '#fff' : '#000' }}>←</button>
                  {editingGroupName ? (
                    <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <input value={editGroupNameValue} onChange={e => setEditGroupNameValue(e.target.value)} style={{ fontSize: 16, padding: '4px 8px', border: '1px solid #ccc', borderRadius: 4, background: isDarkMode ? '#495057' : 'white', color: isDarkMode ? '#fff' : '#000' }} autoFocus />
                      <button onClick={async () => {
                        if (!editGroupNameValue.trim()) return;
                        // master_optionsのvalueを更新
                        await supabase.from('master_options').update({ value: editGroupNameValue }).eq('category', 'group').eq('value', selectedGroup);
                        // 全ユーザーのgroup_namesを更新
                        const affected = users.filter(u => (u.group_names || []).includes(selectedGroup));
                        for (const u of affected) {
                          const next = (u.group_names || []).map((g: string) => g === selectedGroup ? editGroupNameValue : g);
                          await supabase.from('profiles').update({ group_names: next }).eq('id', u.id);
                        }
                        await fetchMasterOptions();
                        await fetchUsers();
                        setSelectedGroup(editGroupNameValue);
                        setEditingGroupName(false);
                      }} style={{ padding: '4px 12px', background: '#007bff', color: 'white', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 13 }}>保存</button>
                      <button onClick={() => setEditingGroupName(false)} style={{ padding: '4px 10px', background: '#6c757d', color: 'white', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 13 }}>キャンセル</button>
                    </span>
                  ) : (
                    <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      {selectedGroup}
                      <button onClick={() => { setEditingGroupName(true); setEditGroupNameValue(selectedGroup); }} style={{ padding: '2px 8px', background: '#ffc107', color: '#212529', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>✏️名前変更</button>
                    </span>
                  )}
                </span>
              ) : 'グループ管理'}
            </h3>

            {!selectedGroup ? (
              /* グループ一覧 */
              <div style={{ maxWidth: 600, margin: '0 auto' }}>
                {masterOptions.group.map(g => {
                  const memberCount = users.filter(u => u.is_active !== false && (u.group_names || []).includes(g)).length;
                  return (
                    <div key={g} onClick={() => setSelectedGroup(g)}
                      style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 20px', marginBottom: 8, background: isDarkMode ? '#343a40' : 'white', border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, borderRadius: 10, cursor: 'pointer', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}
                    >
                      <span style={{ fontWeight: 'bold', color: isDarkMode ? '#fff' : '#000' }}>{g}</span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                        <span style={{ fontSize: 13, color: isDarkMode ? '#adb5bd' : '#666' }}>メンバー {memberCount}人</span>
                        <span style={{ color: '#fd7e14', fontSize: 18 }}>›</span>
                      </div>
                    </div>
                  );
                })}

                {/* グループ追加 */}
                <div style={{ marginTop: 16, textAlign: 'center' }}>
                  {showAddGroup ? (
                    <div style={{ display: 'flex', gap: 8, justifyContent: 'center', alignItems: 'center' }}>
                      <input
                        value={newGroupName}
                        onChange={e => setNewGroupName(e.target.value)}
                        placeholder="新しいグループ名"
                        style={{ padding: '8px 12px', border: `1px solid ${isDarkMode ? '#6c757d' : '#ccc'}`, borderRadius: 6, fontSize: 14, background: isDarkMode ? '#495057' : 'white', color: isDarkMode ? '#fff' : '#000', width: 200 }}
                        autoFocus
                      />
                      <button onClick={async () => {
                        if (!newGroupName.trim()) return;
                        const maxOrder = masterOptions.group.length + 1;
                        const { error } = await supabase.from('master_options').insert({ category: 'group', value: newGroupName.trim(), sort_order: maxOrder });
                        if (error) { alert('グループの追加に失敗しました。\n' + error.message); return; }
                        await fetchMasterOptions();
                        setNewGroupName('');
                        setShowAddGroup(false);
                      }} style={{ padding: '8px 16px', background: '#007bff', color: 'white', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 'bold' }}>追加</button>
                      <button onClick={() => { setShowAddGroup(false); setNewGroupName(''); }} style={{ padding: '8px 12px', background: '#6c757d', color: 'white', border: 'none', borderRadius: 6, cursor: 'pointer' }}>キャンセル</button>
                    </div>
                  ) : (
                    <button onClick={() => setShowAddGroup(true)} style={{ padding: '10px 24px', background: '#fd7e14', color: 'white', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 'bold', fontSize: 14 }}>＋ グループを追加</button>
                  )}
                </div>
              </div>
            ) : (
              /* メンバー一覧 */
              <div style={{ maxWidth: 600, margin: '0 auto' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                  <span style={{ color: isDarkMode ? '#adb5bd' : '#666', fontSize: 14 }}>
                    メンバー {users.filter(u => u.is_active !== false && (u.group_names || []).includes(selectedGroup)).length}人
                  </span>
                  {isUserEditMode ? (
                    <button onClick={() => setIsUserEditMode(false)} style={{ padding: '5px 14px', background: '#28a745', color: 'white', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 'bold', fontSize: 12 }}>✅ 編集終了</button>
                  ) : (
                    <button onClick={() => setIsUserEditMode(true)} style={{ padding: '5px 14px', background: '#fd7e14', color: 'white', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 'bold', fontSize: 12 }}>✏️ メンバーを編集</button>
                  )}
                </div>

                {/* 現在のメンバー */}
                {users.filter(u => u.is_active !== false && (u.group_names || []).includes(selectedGroup)).map(u => (
                  <div key={u.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', marginBottom: 6, background: isDarkMode ? '#343a40' : 'white', border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, borderRadius: 8 }}>
                    <div>
                      <span style={{ fontWeight: 'bold', color: isDarkMode ? '#fff' : '#000' }}>{u.name || '未設定'}</span>
                      <span style={{ fontSize: 12, color: isDarkMode ? '#adb5bd' : '#888', marginLeft: 8 }}>{u.email}</span>
                    </div>
                    {isUserEditMode && (
                      <button onClick={async () => {
                        const next = (u.group_names || []).filter((x: string) => x !== selectedGroup);
                        await supabase.from('profiles').update({ group_names: next }).eq('id', u.id);
                        setUsers(prev => prev.map(p => p.id === u.id ? { ...p, group_names: next } : p));
                      }} style={{ padding: '3px 10px', background: '#dc3545', color: 'white', border: 'none', borderRadius: 20, cursor: 'pointer', fontSize: 12 }}>削除</button>
                    )}
                  </div>
                ))}

                {/* 追加できるメンバー */}
                {isUserEditMode && (
                  <div style={{ marginTop: 20 }}>
                    <p style={{ color: isDarkMode ? '#adb5bd' : '#666', fontSize: 13, marginBottom: 8 }}>＋ 追加できるメンバー</p>
                    {users.filter(u => u.is_active !== false && !(u.group_names || []).includes(selectedGroup)).map(u => (
                      <div key={u.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 16px', marginBottom: 6, background: isDarkMode ? '#3d4349' : '#f8f9fa', border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, borderRadius: 8, opacity: 0.8 }}>
                        <div>
                          <span style={{ color: isDarkMode ? '#fff' : '#000' }}>{u.name || '未設定'}</span>
                          <span style={{ fontSize: 12, color: isDarkMode ? '#adb5bd' : '#888', marginLeft: 8 }}>{u.email}</span>
                        </div>
                        <button onClick={async () => {
                          const next = [...(u.group_names || []), selectedGroup];
                          await supabase.from('profiles').update({ group_names: next }).eq('id', u.id);
                          setUsers(prev => prev.map(p => p.id === u.id ? { ...p, group_names: next } : p));
                        }} style={{ padding: '3px 10px', background: '#007bff', color: 'white', border: 'none', borderRadius: 20, cursor: 'pointer', fontSize: 12 }}>＋追加</button>
                      </div>
                    ))}
                  </div>
                )}

                {/* グループ削除 */}
                {isUserEditMode && (
                  <div style={{ marginTop: 32, textAlign: 'center' }}>
                    <button onClick={async () => {
                      if (!window.confirm(`「${selectedGroup}」を削除しますか？\nメンバーのグループ設定からも削除されます。`)) return;
                      await supabase.from('master_options').delete().eq('category', 'group').eq('value', selectedGroup);
                      const affected = users.filter(u => (u.group_names || []).includes(selectedGroup));
                      for (const u of affected) {
                        const next = (u.group_names || []).filter((g: string) => g !== selectedGroup);
                        await supabase.from('profiles').update({ group_names: next }).eq('id', u.id);
                      }
                      await fetchMasterOptions();
                      await fetchUsers();
                      setSelectedGroup(null);
                      setIsUserEditMode(false);
                    }} style={{ padding: '8px 20px', background: '#dc3545', color: 'white', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13 }}>
                      🗑 このグループを削除
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
  );
};

export default GroupsTab;


import React from 'react';
import { useAdminPanel } from './AdminPanelContext';

const UsersTab: React.FC = () => {
  const ctx = useAdminPanel();
  const { isDarkMode, users, loadingUsers, sortedUsers, userSortKey, userSortAsc, handleUserSort, editingUser, editName, setEditName, handleEditName, handleSaveName, handleCancelUserEdit, showRetired, setShowRetired, editingSortOrder, setEditingSortOrder, editSortOrderValue, setEditSortOrderValue, handleSaveSortOrder, masterOptions, isUserEditMode, setIsUserEditMode, confirmChange, setConfirmChange, submissions, fetchUsers, handleToggleActive, handleDeleteUser, setActiveTab, supabase } = ctx;

  return (
          <div>
            <h3 style={{ textAlign: 'center', marginBottom: '30px', color: isDarkMode ? '#fff' : '#000' }}>ユーザー管理</h3>
            {loadingUsers ? (
              <p style={{ textAlign: 'center', color: isDarkMode ? '#fff' : '#000' }}>読み込み中...</p>
            ) : (
              <div>
                <div style={{ marginBottom: '20px', textAlign: 'center' }}>
                  <p style={{ color: isDarkMode ? '#fff' : '#000' }}>
                    現役: {users.filter(u => u.is_active !== false).length}人 ／ 退職済み: {users.filter(u => u.is_active === false).length}人
                  </p>
                  <div style={{ display: 'flex', justifyContent: 'center', gap: '8px', flexWrap: 'wrap' }}>
                    <button
                      onClick={() => setShowRetired('active')}
                      style={{ padding: '8px 16px', background: showRetired === 'active' ? '#007bff' : '#6c757d', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
                    >
                      現役のみ
                    </button>
                    <button
                      onClick={() => setShowRetired('retired')}
                      style={{ padding: '8px 16px', background: showRetired === 'retired' ? '#dc3545' : '#6c757d', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
                    >
                      退職者のみ
                    </button>
                    <button
                      onClick={() => setShowRetired('all')}
                      style={{ padding: '8px 16px', background: showRetired === 'all' ? '#28a745' : '#6c757d', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
                    >
                      全員表示
                    </button>
                    <button onClick={fetchUsers} style={{ padding: '8px 16px' }}>更新</button>
                  </div>
                </div>
                {/* 編集モードボタン */}
                <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                  {isUserEditMode && (
                    <span style={{ color: '#fd7e14', fontSize: 11 }}>⚠️ 編集モード中（変更は確認後に保存）</span>
                  )}
                  {isUserEditMode ? (
                    <button
                      onClick={() => { setIsUserEditMode(false); }}
                      style={{ padding: '5px 14px', background: '#28a745', color: 'white', border: '2px solid #1e7e34', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold', fontSize: 12 }}
                    >
                      ✅ 編集終了
                    </button>
                  ) : (
                    <button
                      onClick={() => setIsUserEditMode(true)}
                      style={{ padding: '5px 14px', background: '#fd7e14', color: 'white', border: '2px solid #e8690b', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold', fontSize: 12 }}
                    >
                      ✏️ 雇用形態・役職を編集
                    </button>
                  )}
                </div>

                {/* 変更確認ポップアップ */}
                {confirmChange && (
                  <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <div style={{ background: isDarkMode ? '#343a40' : 'white', borderRadius: 8, padding: 24, minWidth: 300, boxShadow: '0 4px 20px rgba(0,0,0,0.3)' }}>
                      <h4 style={{ margin: '0 0 16px', color: isDarkMode ? '#fff' : '#000' }}>変更の確認</h4>
                      <p style={{ color: isDarkMode ? '#ddd' : '#333', marginBottom: 8 }}>
                        <strong>{confirmChange.label}</strong> を変更します
                      </p>
                      <div style={{ background: isDarkMode ? '#495057' : '#f8f9fa', borderRadius: 6, padding: '10px 14px', marginBottom: 16, fontSize: 14 }}>
                        <span style={{ color: '#dc3545' }}>「{confirmChange.oldVal}」</span>
                        <span style={{ color: isDarkMode ? '#ddd' : '#666', margin: '0 8px' }}>→</span>
                        <span style={{ color: '#28a745', fontWeight: 'bold' }}>「{confirmChange.newVal}」</span>
                      </div>
                      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                        <button
                          onClick={() => setConfirmChange(null)}
                          style={{ padding: '6px 16px', background: '#6c757d', color: 'white', border: 'none', borderRadius: 4, cursor: 'pointer' }}
                        >
                          キャンセル
                        </button>
                        <button
                          onClick={async () => {
                            await supabase.from('profiles').update({ [confirmChange.field]: confirmChange.newVal }).eq('id', confirmChange.userId);
                            fetchUsers();
                            setConfirmChange(null);
                          }}
                          style={{ padding: '6px 16px', background: '#007bff', color: 'white', border: 'none', borderRadius: 4, cursor: 'pointer', fontWeight: 'bold' }}
                        >
                          保存する
                        </button>
                      </div>
                    </div>
                  </div>
                )}
                {/* 並び替えボタン */}
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
                  {[
                    { key: 'sort_order', label: 'No.順' },
                    { key: 'name', label: '名前順' },
                    { key: 'registered_at', label: '登録日順' },
                    { key: 'submission_count', label: '申請数順' },
                  ].map(({ key, label }) => (
                    <button
                      key={key}
                      onClick={() => handleUserSort(key as any)}
                      style={{
                        padding: '6px 12px', borderRadius: 6, border: 'none', cursor: 'pointer',
                        background: userSortKey === key ? '#007bff' : (isDarkMode ? '#495057' : '#e9ecef'),
                        color: userSortKey === key ? 'white' : (isDarkMode ? '#fff' : '#333'),
                        fontSize: 13, fontWeight: userSortKey === key ? 'bold' : 'normal'
                      }}
                    >
                      {label} {userSortKey === key ? (userSortAsc ? '▲' : '▼') : ''}
                    </button>
                  ))}
                </div>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ backgroundColor: isDarkMode ? '#495057' : '#f8f9fa' }}>
                        <th style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '4px 6px', textAlign: 'center', color: isDarkMode ? '#fff' : '#000', width: 45, fontSize: 12 }}>No.</th>
                        <th style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '4px 6px', textAlign: 'left', color: isDarkMode ? '#fff' : '#000', fontSize: 12, width: 100 }}>名前</th>
                        <th style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '4px 6px', textAlign: 'left', color: isDarkMode ? '#fff' : '#000', fontSize: 12 }}>メール</th>
                        <th style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '4px 6px', textAlign: 'center', color: isDarkMode ? '#fff' : '#000', fontSize: 12, width: 80 }}>雇用形態</th>
                        <th style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '4px 6px', textAlign: 'center', color: isDarkMode ? '#fff' : '#000', fontSize: 12, width: 110 }}>役職</th>
                        <th style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '4px 6px', textAlign: 'center', color: isDarkMode ? '#fff' : '#000', fontSize: 12, width: 50 }}>件数</th>
                        <th style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '4px 6px', textAlign: 'left', color: isDarkMode ? '#fff' : '#000', fontSize: 12, width: 85 }}>登録日</th>
                        <th style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '4px 6px', textAlign: 'left', color: isDarkMode ? '#fff' : '#000', fontSize: 12, width: 55 }}>状態</th>
                        <th style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '4px 6px', textAlign: 'left', color: isDarkMode ? '#fff' : '#000', fontSize: 12 }}>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedUsers.map(user => {
                        const regDate = user.registered_at ? new Date(new Date(user.registered_at).getTime() + 9*60*60*1000) : null;
                        const regDateStr = regDate ? `${regDate.getFullYear()}/${String(regDate.getMonth()+1).padStart(2,'0')}/${String(regDate.getDate()).padStart(2,'0')}` : '-';
                        return (
                          <tr key={user.id} style={{ opacity: user.is_active === false ? 0.6 : 1, background: sortedUsers.indexOf(user) % 2 === 0 ? (isDarkMode ? '#343a40' : 'white') : (isDarkMode ? '#3d4349' : '#f8f9fa') }}>
                            {/* No.列 */}
                            <td style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '4px 6px', textAlign: 'center', color: isDarkMode ? '#fff' : '#000' }}>
                              {editingSortOrder === user.id ? (
                                <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                                  <input
                                    type="number"
                                    value={editSortOrderValue}
                                    onChange={e => setEditSortOrderValue(e.target.value)}
                                    style={{ width: 50, padding: '2px 4px', textAlign: 'center', background: isDarkMode ? '#495057' : 'white', color: isDarkMode ? '#fff' : '#000', border: '1px solid #ccc', borderRadius: 4 }}
                                    onKeyPress={e => e.key === 'Enter' && handleSaveSortOrder(user.id)}
                                    autoFocus
                                  />
                                  <button onClick={() => handleSaveSortOrder(user.id)} style={{ padding: '2px 6px', background: '#28a745', color: 'white', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 11 }}>✓</button>
                                  <button onClick={() => setEditingSortOrder(null)} style={{ padding: '2px 6px', background: '#6c757d', color: 'white', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 11 }}>✕</button>
                                </div>
                              ) : (
                                <span
                                  onClick={() => { setEditingSortOrder(user.id); setEditSortOrderValue(String(user.sort_order ?? '')); }}
                                  style={{ cursor: 'pointer', fontWeight: 'bold', color: isDarkMode ? '#adb5bd' : '#666' }}
                                  title="クリックして変更"
                                >
                                  {user.sort_order ?? '-'}
                                </span>
                              )}
                            </td>
                            {/* 名前列 */}
                            <td style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '4px 6px', color: isDarkMode ? '#fff' : '#000', fontSize: 12 }}>
                              {editingUser === user.id ? (
                                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                  <input
                                    type="text"
                                    value={editName}
                                    onChange={(e) => setEditName(e.target.value)}
                                    style={{ flex: 1, padding: '4px 8px', border: `1px solid ${isDarkMode ? '#6c757d' : '#ccc'}`, borderRadius: '4px', fontSize: '14px', backgroundColor: isDarkMode ? '#495057' : 'white', color: isDarkMode ? '#fff' : '#000' }}
                                    placeholder="名前を入力"
                                    onKeyPress={(e) => { if (e.key === 'Enter') handleSaveName(user.id); }}
                                  />
                                  <button onClick={() => handleSaveName(user.id)} style={{ padding: '4px 8px', background: '#28a745', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '12px' }}>保存</button>
                                  <button onClick={handleCancelUserEdit} style={{ padding: '4px 8px', background: '#6c757d', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '12px' }}>キャンセル</button>
                                </div>
                              ) : (
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                  <span>{user.name || '未設定'}</span>
                                  <button onClick={() => handleEditName(user.id, user.name || '')} style={{ padding: '2px 6px', background: '#ffc107', color: '#212529', border: 'none', borderRadius: '3px', cursor: 'pointer', fontSize: '11px', marginLeft: '8px' }}>編集</button>
                                </div>
                              )}
                            </td>
                            <td style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '4px 6px', color: isDarkMode ? '#adb5bd' : '#555', fontSize: 11, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={user.email}>{user.email}</td>
                            <td style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '4px 6px', textAlign: 'center' }}>
                              <select
                                value={user.employment_type || '正社員'}
                                disabled={!isUserEditMode}
                                onChange={(e) => {
                                  setConfirmChange({ userId: user.id, field: 'employment_type', label: `${user.name || user.email} の雇用形態`, oldVal: user.employment_type || '正社員', newVal: e.target.value });
                                }}
                                style={{ padding: '2px 2px', fontSize: 11, background: isDarkMode ? '#495057' : 'white', color: isDarkMode ? '#fff' : '#000', border: `1px solid ${isDarkMode ? '#6c757d' : '#ccc'}`, borderRadius: 4, width: '100%', opacity: isUserEditMode ? 1 : 0.7, cursor: isUserEditMode ? 'pointer' : 'default', appearance: isUserEditMode ? 'auto' : 'none' as any }}
                              >
                                {masterOptions.employment_type.map(v => <option key={v}>{v}</option>)}
                              </select>
                            </td>
                            <td style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '4px 6px', textAlign: 'center' }}>
                              <select
                                value={user.role_title || '一般'}
                                disabled={!isUserEditMode}
                                onChange={(e) => {
                                  setConfirmChange({ userId: user.id, field: 'role_title', label: `${user.name || user.email} の役職`, oldVal: user.role_title || '一般', newVal: e.target.value });
                                }}
                                style={{ padding: '2px 2px', fontSize: 11, background: isDarkMode ? '#495057' : 'white', color: isDarkMode ? '#fff' : '#000', border: `1px solid ${isDarkMode ? '#6c757d' : '#ccc'}`, borderRadius: 4, width: '100%', opacity: isUserEditMode ? 1 : 0.7, cursor: isUserEditMode ? 'pointer' : 'default', appearance: isUserEditMode ? 'auto' : 'none' as any }}
                              >
                                {masterOptions.role_title.map(v => <option key={v}>{v}</option>)}
                              </select>
                            </td>
                            <td style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '4px 6px', textAlign: 'center', color: isDarkMode ? '#fff' : '#000', fontSize: 12 }}>{submissions.filter(s => s.profiles?.email === user.email).length}</td>
                            <td style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '4px 6px', color: isDarkMode ? '#adb5bd' : '#666', fontSize: 11, whiteSpace: 'nowrap' }}>{regDateStr}</td>
                            <td style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '4px 6px' }}>
                              {user.is_active === false ? (
                                <span style={{ color: '#dc3545', fontWeight: 'bold', fontSize: '11px' }}>退職済</span>
                              ) : (
                                <span style={{ color: '#28a745', fontWeight: 'bold', fontSize: '11px' }}>現役</span>
                              )}
                            </td>
                            <td style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, padding: '4px 6px' }}>
                              <div style={{ display: 'flex', gap: '3px', flexWrap: 'wrap' }}>
                                <button style={{ padding: '3px 6px', background: '#17a2b8', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '11px' }} onClick={() => setActiveTab('reports')}>履歴</button>
                                {user.email !== 'fivem.kyoto@gmail.com' && (
                                  <>
                                    <button style={{ padding: '3px 6px', background: user.is_active === false ? '#28a745' : '#fd7e14', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '11px' }} onClick={() => handleToggleActive(user.id, user.is_active !== false)}>
                                      {user.is_active === false ? '復活' : '退職'}
                                    </button>
                                    {user.is_active === false && (
                                      <button style={{ padding: '3px 6px', background: '#dc3545', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '11px' }} onClick={() => handleDeleteUser(user.id, user.name || user.email || '')}>削除</button>
                                    )}
                                  </>
                                )}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
  );
};

export default UsersTab;


import React from 'react';
import { useAdminPanel } from './AdminPanelContext';
import type { AdminLeaveRequest } from '../../types';

const LeaveRequestsTab: React.FC = () => {
  const ctx = useAdminPanel();
  const {
    isDarkMode, leaveRequests, loadingLeaveRequests, leaveStatusFilter, setLeaveStatusFilter,
    users, fetchLeaveRequests, fetchUsers,
    setAdminManagerList, setAdminSelectedManagerId, setAdminSelectingManagerFor,
    sendLeaveSlack, supabase,
  } = ctx;
          const leaveFilters = [
            { key: 'active',   label: '確認待ち' },
            { key: 'approved', label: '受理済み' },
            { key: 'rejected', label: '差し戻し' },
            { key: 'all',      label: 'すべて' },
          ];
          const filteredLeave = leaveRequests
            .filter(r => {
              if (leaveStatusFilter === 'all') return true;
              if (leaveStatusFilter === 'active') return !['approved','rejected'].includes(r.status);
              return r.status === leaveStatusFilter;
            })
            .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

          const getStatusDisplay = (req: AdminLeaveRequest): { role: string; name: string; color: string } => {
            if (req.status === 'pending')          return { role: req.approver?.role_title ? `① ${req.approver.role_title}` : '①', name: req.approver?.name || '確認待ち', color: '#e67e22' };
            if (req.status === 'step2_pending')    return { role: '② マネージャー', name: req.approver2?.name || '-', color: '#d35400' };
            if (req.status === 'manager_approved') return { role: '③ 経理', name: '管理者', color: '#17a2b8' };
            if (req.status === 'admin_approved')   return { role: '', name: '④ 社長', color: '#6f42c1' };
            if (req.status === 'approved')         return { role: '', name: '受理済み', color: '#28a745' };
            if (req.status === 'rejected')         return { role: '', name: '差し戻し', color: '#dc3545' };
            return { role: '', name: req.status, color: '#999' };
          };

          const partUsers = users.filter(u => u.is_active !== false && u.employment_type === 'パート');

          return (
            <div>
              <h3 style={{ textAlign: 'center', marginBottom: 8, color: isDarkMode ? '#fff' : '#000' }}>🌿 休暇申請一覧</h3>
              <p style={{ textAlign: 'center', fontSize: 13, color: isDarkMode ? '#adb5bd' : '#666', marginBottom: 16 }}>
                管理者として全ての申請を確認・承認できます。承認が止まっている場合は強制的に次のステップへ進められます。
              </p>

              {/* パートへ有給申請フォーム送信 */}
              <div style={{ background: isDarkMode ? '#2d3136' : '#f8f9fa', border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, borderRadius: 10, padding: '12px 16px', marginBottom: 20, maxWidth: 500, marginLeft: 'auto', marginRight: 'auto' }}>
                <p style={{ fontWeight: 'bold', fontSize: 13, color: isDarkMode ? '#fff' : '#333', marginBottom: 8 }}>📨 パートへ有給申請フォームを送信</p>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <select
                    id="part-leave-target"
                    style={{ flex: 1, minWidth: 160, padding: '6px 8px', borderRadius: 6, border: `1px solid ${isDarkMode ? '#6c757d' : '#ccc'}`, background: isDarkMode ? '#495057' : 'white', color: isDarkMode ? '#fff' : '#000', fontSize: 13 }}
                  >
                    <option value="">-- パートを選択 --</option>
                    {partUsers.map(u => (
                      <option key={u.id} value={u.id}>{u.name || u.email}</option>
                    ))}
                  </select>
                  <button
                    onClick={async () => {
                      const sel = document.getElementById('part-leave-target') as HTMLSelectElement;
                      const userId = sel?.value;
                      if (!userId) { alert('パートを選択してください'); return; }
                      const target = partUsers.find(u => u.id === userId);
                      if (!target) return;
                      if (!window.confirm(`「${target.name || target.email}」さんに有給申請フォームを送信しますか？`)) return;
                      const { error } = await supabase.from('profiles').update({ leave_request_enabled: true, leave_enabled_by: (await supabase.auth.getUser()).data.user?.id }).eq('id', userId);
                      if (error) { alert('送信に失敗しました: ' + error.message); return; }
                      await fetchUsers();
                      alert(`「${target.name || target.email}」さんに有給申請フォームを送信しました。`);
                    }}
                    style={{ padding: '6px 16px', background: '#28a745', color: 'white', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 'bold', fontSize: 13, whiteSpace: 'nowrap' }}
                  >送信</button>
                </div>
                {partUsers.filter(u => u.leave_request_enabled).length > 0 && (
                  <div style={{ marginTop: 10 }}>
                    <p style={{ fontSize: 12, color: isDarkMode ? '#adb5bd' : '#666', marginBottom: 4 }}>現在フォーム表示中のパート：</p>
                    {partUsers.filter(u => u.leave_request_enabled).map(u => (
                      <div key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                        <span style={{ fontSize: 13, color: isDarkMode ? '#fff' : '#333' }}>✅ {u.name || u.email}</span>
                        <button
                          onClick={async () => {
                            await supabase.from('profiles').update({ leave_request_enabled: false, leave_enabled_by: null }).eq('id', u.id);
                            await fetchUsers();
                          }}
                          style={{ padding: '2px 8px', background: '#dc3545', color: 'white', border: 'none', borderRadius: 10, cursor: 'pointer', fontSize: 11 }}
                        >取り消し</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* フィルターボタン */}
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 16, justifyContent: 'center' }}>
                {leaveFilters.map(f => (
                  <button
                    key={f.key}
                    onClick={() => setLeaveStatusFilter(f.key)}
                    style={{
                      padding: '5px 12px', borderRadius: 16, border: 'none', cursor: 'pointer', fontSize: 12,
                      background: leaveStatusFilter === f.key ? '#007bff' : (isDarkMode ? '#495057' : '#e9ecef'),
                      color: leaveStatusFilter === f.key ? 'white' : (isDarkMode ? '#fff' : '#333'),
                      fontWeight: leaveStatusFilter === f.key ? 'bold' : 'normal',
                    }}
                  >{f.label}</button>
                ))}
              </div>

              {loadingLeaveRequests ? (
                <p style={{ textAlign: 'center', color: isDarkMode ? '#fff' : '#000' }}>読み込み中...</p>
              ) : filteredLeave.length === 0 ? (
                <p style={{ textAlign: 'center', color: isDarkMode ? '#aaa' : '#666' }}>該当する申請はありません</p>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', color: isDarkMode ? '#fff' : '#000', fontSize: 13 }}>
                    <thead>
                      <tr style={{ background: isDarkMode ? '#495057' : '#f8f9fa' }}>
                        {[
                          { label: '申請日', w: 70 }, { label: '申請者', w: 65 }, { label: '申請先', w: 65 },
                          { label: '種別', w: 55 }, { label: '休暇日', w: 100 },
                          { label: '日数', w: 40 }, { label: '事由・備考', w: 100 }, { label: '確認状況', w: 85 }, { label: '操作', w: 90 },
                        ].map(col => (
                          <th key={col.label} style={{ padding: '8px 4px', textAlign: 'center', borderBottom: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, color: isDarkMode ? '#fff' : '#000', width: col.w, fontSize: 12 }}>{col.label}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {filteredLeave.map((req, i) => {
                        const leaveDates: string[] = (() => { try { return req.leave_dates ? JSON.parse(req.leave_dates) : []; } catch { return []; } })();
                        const days = leaveDates.length > 0
                          ? leaveDates.length
                          : Math.max(1, Math.floor((new Date(req.end_date || '').getTime() - new Date(req.start_date || '').getTime()) / (1000 * 60 * 60 * 24)) + 1);
                        // 休暇日を "2026/6/3・4・8、7/1・2" 形式に整形
                        const dateDisplay = (() => {
                          if (leaveDates.length > 0) {
                            const year = leaveDates[0].substring(0, 4);
                            const groups = new Map<string, number[]>();
                            leaveDates.forEach(d => {
                              const m = String(parseInt(d.substring(5, 7)));
                              const day = parseInt(d.substring(8));
                              if (!groups.has(m)) groups.set(m, []);
                              groups.get(m)!.push(day);
                            });
                            const parts = [...groups.entries()].map(([m, ds]) => `${m}/${ds.join('・')}`);
                            return `${year}/${parts.join('、')}`;
                          }
                          // fallback: 旧形式
                          if (req.start_date === req.end_date) return req.start_date;
                          return `${(req.start_date || '').slice(5)}～${(req.end_date || '').slice(5)}`;
                        })();
                        const jst = new Date(new Date(req.created_at).getTime() + 9 * 60 * 60 * 1000);
                        const st = getStatusDisplay(req);
                        return (
                          <tr key={req.id} style={{ background: i % 2 === 0 ? (isDarkMode ? '#343a40' : 'white') : (isDarkMode ? '#3d4349' : '#f8f9fa') }}>
                            <td style={{ padding: '8px 4px', borderBottom: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, textAlign: 'center', fontSize: 12 }}>
                              <div>{jst.getFullYear()}</div><div>{jst.getMonth()+1}/{jst.getDate()}</div>
                            </td>
                            <td style={{ padding: '8px 4px', borderBottom: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, textAlign: 'center', fontSize: 12 }}>
                              {(req.profile?.name || '-').split(/[\s　]/).map((s: string, j: number) => <div key={j}>{s}</div>)}
                            </td>
                            <td style={{ padding: '8px 4px', borderBottom: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, textAlign: 'center', fontSize: 12 }}>
                              {(req.approver?.name || '-').split(/[\s　]/).map((s: string, j: number) => <div key={j}>{s}</div>)}
                            </td>
                            <td style={{ padding: '8px 4px', borderBottom: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, textAlign: 'center', fontSize: 12, wordBreak: 'break-word' }}>{req.leave_type === 'その他' ? req.leave_type_other : req.leave_type}</td>
                            <td style={{ padding: '8px 4px', borderBottom: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, textAlign: 'center', fontSize: 11 }}>{dateDisplay}</td>
                            <td style={{ padding: '8px 4px', borderBottom: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, textAlign: 'center', fontSize: 12 }}>{days}日</td>
                            <td style={{ padding: '8px 4px', borderBottom: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, textAlign: 'left', fontSize: 12, wordBreak: 'break-word' }}>
                              {req.purpose && <div>{req.purpose}</div>}
                              {req.reason && <div style={{ color: isDarkMode ? '#adb5bd' : '#666', fontSize: 11 }}>備考: {req.reason}</div>}
                              {!req.purpose && !req.reason && <span>-</span>}
                            </td>
                            <td style={{ padding: '8px 4px', borderBottom: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, textAlign: 'center' }}>
                              <div style={{ display: 'inline-block', padding: '3px 8px', borderRadius: 8, background: st.color, color: 'white', textAlign: 'center', lineHeight: 1.4 }}>
                                {st.role && <div style={{ fontSize: 9, opacity: 0.9, whiteSpace: 'nowrap' }}>{st.role}</div>}
                                <div style={{ fontWeight: 'bold', fontSize: 11, whiteSpace: 'nowrap' }}>{st.name}</div>
                              </div>
                            </td>
                            <td style={{ padding: '8px 4px', borderBottom: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, textAlign: 'center' }}>
                              <div style={{ display: 'flex', gap: 4, justifyContent: 'center', alignItems: 'center' }}>
                              {req.status === 'rejected' && (
                                <button
                                  onClick={async () => {
                                    if (!window.confirm('差し戻しを取り消して最初に戻しますか？')) return;
                                    await supabase.from('leave_requests').update({ status: 'pending', rejected_reason: null }).eq('id', req.id);
                                    fetchLeaveRequests();
                                  }}
                                  style={{ padding: '4px 8px', background: '#6c757d', color: 'white', border: '2px solid #545b62', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 'bold' }}
                                >↩ 取り消し</button>
                              )}
                              {req.status === 'approved' && (
                                <button
                                  onClick={async () => {
                                    if (!window.confirm('受理済みを差し戻しますか？\n申請者に差し戻し通知が届きます。')) return;
                                    const reason = window.prompt('差し戻し理由を入力してください（任意）') ?? '';
                                    if (reason === null) return;
                                    await supabase.from('leave_requests').update({ status: 'rejected', rejected_reason: reason || null }).eq('id', req.id);
                                    fetchLeaveRequests();
                                  }}
                                  style={{ padding: '4px 8px', background: '#dc3545', color: 'white', border: '2px solid #bd2130', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 'bold' }}
                                >差戻</button>
                              )}
                              {req.status !== 'approved' && req.status !== 'rejected' && (
                                <div style={{ display: 'flex', gap: 4 }}>
                                  <button
                                    onClick={async () => {
                                      if (req.status === 'pending') {
                                        // マネージャー選択モーダルを開く
                                        const { data: mgrs } = await supabase.from('profiles').select('id, name, role_title').eq('role_title', 'マネージャー').eq('is_active', true).order('name');
                                        setAdminManagerList(mgrs || []);
                                        setAdminSelectedManagerId(mgrs && mgrs.length > 0 ? mgrs[0].id : '');
                                        setAdminSelectingManagerFor(req);
                                      } else {
                                        if (!window.confirm('受理しますか？')) return;
                                        const nextStatus: Record<string, string> = { step2_pending: 'manager_approved', manager_approved: 'admin_approved', admin_approved: 'approved' };
                                        await supabase.from('leave_requests').update({ status: nextStatus[req.status] || 'approved' }).eq('id', req.id);
                                        // 管理者が自分のステップ（経理）を進めた時のみ社長へ通知
                                        if (req.status === 'manager_approved') {
                                          await sendLeaveSlack('accounting_approved', '経理担当者', '管理者');
                                        }
                                        // pending/step2_pending/admin_approvedを管理者が代わりに進めた場合は通知なし
                                        fetchLeaveRequests();
                                      }
                                    }}
                                    style={{ padding: '4px 8px', background: '#28a745', color: 'white', border: '2px solid #1e7e34', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 'bold' }}
                                  >受理</button>
                                  <button
                                    onClick={async () => {
                                      const reason = window.prompt('差し戻し理由を入力してください（任意）');
                                      if (reason === null) return;
                                      await supabase.from('leave_requests').update({ status: 'rejected', rejected_reason: reason || null }).eq('id', req.id);
                                      fetchLeaveRequests();
                                    }}
                                    style={{ padding: '4px 8px', background: '#dc3545', color: 'white', border: '2px solid #bd2130', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 'bold' }}
                                  >差戻</button>
                                </div>
                              )}
                              <button
                                onClick={async () => {
                                  if (!window.confirm('この申請を削除しますか？')) return;
                                  if (!window.confirm('本当に削除します。この操作は取り消せません。')) return;
                                  const { error } = await supabase.from('leave_requests').delete().eq('id', req.id);
                                  if (error) { alert('削除に失敗しました: ' + error.message); return; }
                                  fetchLeaveRequests();
                                }}
                                style={{ padding: '4px 3px', background: 'transparent', color: isDarkMode ? '#888' : '#aaa', border: `1px solid ${isDarkMode ? '#555' : '#ddd'}`, borderRadius: 4, cursor: 'pointer', fontSize: 9, writingMode: 'vertical-rl', letterSpacing: 1 }}
                              >削除</button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          );
};

export default LeaveRequestsTab;

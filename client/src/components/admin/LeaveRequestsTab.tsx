import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useAdminPanel } from './AdminPanelContext';
import { useAuth } from '../../hooks/useAuth';
import type { AdminLeaveRequest } from '../../types';
import { insertNotification } from '../../lib/notifications';
import { shouldSend, getNotificationTemplate, getNotificationRecipient, dispatchEmail, getUserEmail } from '../../lib/notificationDispatch';

const SearchableSelect: React.FC<{
  value: string;
  options: [string, string][];
  allLabel?: string;
  onChange: (v: string) => void;
  isDarkMode: boolean;
}> = ({ value, options, allLabel = '全員', onChange, isDarkMode }) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const currentLabel = value === 'all' ? allLabel : (options.find(([id]) => id === value)?.[1] ?? allLabel);
  const filtered = query ? options.filter(([, name]) => name.includes(query)) : options;

  useEffect(() => {
    const handler = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  useEffect(() => { if (open) { setQuery(''); setTimeout(() => inputRef.current?.focus(), 0); } }, [open]);

  const bg = isDarkMode ? '#495057' : '#fff';
  const border = isDarkMode ? '#6c757d' : '#ccc';
  const textColor = isDarkMode ? '#fff' : '#333';
  const dropBg = isDarkMode ? '#343a40' : '#fff';
  const hoverBg = isDarkMode ? '#495057' : '#f0f4ff';

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
      <div onClick={() => setOpen(o => !o)}
        style={{ padding: '5px 28px 5px 10px', borderRadius: 8, border: `1px solid ${border}`, background: bg, color: textColor, fontSize: 12, cursor: 'pointer', minWidth: 120, position: 'relative', userSelect: 'none' }}>
        {currentLabel}
        <span style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', fontSize: 10, color: textColor }}>▼</span>
      </div>
      {open && (
        <div style={{ position: 'absolute', top: '100%', left: 0, zIndex: 1000, background: dropBg, border: `1px solid ${border}`, borderRadius: 8, boxShadow: '0 4px 12px rgba(0,0,0,0.15)', minWidth: 180, marginTop: 2 }}>
          <div style={{ padding: '6px 8px', borderBottom: `1px solid ${border}` }}>
            <input ref={inputRef} value={query} onChange={e => setQuery(e.target.value)} placeholder="名前で検索..."
              style={{ width: '100%', padding: '4px 8px', borderRadius: 6, border: `1px solid ${border}`, background: bg, color: textColor, fontSize: 12, boxSizing: 'border-box' }} />
          </div>
          <div style={{ maxHeight: 200, overflowY: 'auto' }}>
            <div onClick={() => { onChange('all'); setOpen(false); }}
              style={{ padding: '7px 12px', fontSize: 12, cursor: 'pointer', background: value === 'all' ? '#007bff' : 'transparent', color: value === 'all' ? '#fff' : textColor }}
              onMouseEnter={e => { if (value !== 'all') (e.currentTarget as HTMLDivElement).style.background = hoverBg; }}
              onMouseLeave={e => { if (value !== 'all') (e.currentTarget as HTMLDivElement).style.background = 'transparent'; }}>
              {allLabel}
            </div>
            {filtered.map(([id, name]) => (
              <div key={id} onClick={() => { onChange(id); setOpen(false); }}
                style={{ padding: '7px 12px', fontSize: 12, cursor: 'pointer', background: value === id ? '#007bff' : 'transparent', color: value === id ? '#fff' : textColor }}
                onMouseEnter={e => { if (value !== id) (e.currentTarget as HTMLDivElement).style.background = hoverBg; }}
                onMouseLeave={e => { if (value !== id) (e.currentTarget as HTMLDivElement).style.background = 'transparent'; }}>
                {name}
              </div>
            ))}
            {filtered.length === 0 && <div style={{ padding: '7px 12px', fontSize: 12, color: isDarkMode ? '#adb5bd' : '#888' }}>見つかりません</div>}
          </div>
        </div>
      )}
    </div>
  );
};

interface AbsenceRec {
  id: string;
  user_id: string;
  date: string;
  type: 'absent' | 'late' | 'early_leave' | 'late_start' | 'early_end';
  actual_time: string | null;
  notes: string | null;
  created_at: string;
  created_by: string | null;
  targetName: string;
  creatorName: string;
}

const ABSENCE_LABEL: Record<string, string> = { absent: '全欠勤', late: '遅刻', early_leave: '早退', late_start: '遅出', early_end: '早退(残業調整)' };
const ABSENCE_COLOR: Record<string, { bg: string; text: string }> = {
  absent:      { bg: '#fde8e8', text: '#c0392b' },
  late:        { bg: '#ff9800', text: '#fff' },
  early_leave: { bg: '#e3f2fd', text: '#1565c0' },
  late_start:  { bg: '#8bc34a', text: '#fff' },
  early_end:   { bg: '#e1bee7', text: '#6a1b9a' },
};

const LeaveRequestsTab: React.FC = () => {
  const ctx = useAdminPanel();
  const {
    isDarkMode, leaveRequests, loadingLeaveRequests, leaveStatusFilter, setLeaveStatusFilter,
    users, fetchLeaveRequests, fetchUsers,
    setAdminManagerList, setAdminSelectedManagerId, setAdminSelectingManagerFor,
    sendLeaveSlack, supabase,
  } = ctx;
  const { user: authUser } = useAuth();

  const [absenceView, setAbsenceView] = useState(false);
  const [rejectModal, setRejectModal] = useState<AdminLeaveRequest | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [rejectNewType, setRejectNewType] = useState('');
  const LEAVE_TYPES = ['有給休暇', 'BD休暇', '慶弔休', '調整休', 'その他', '病欠'];
  const [filterFY, setFilterFY] = useState<string>('__current__'); // 'all' | '__current__' | '2026' ...
  const [filterPerson, setFilterPerson] = useState<string>('all');
  const [absFilterFY, setAbsFilterFY] = useState<string>('__current__');
  const [absFilterPerson, setAbsFilterPerson] = useState<string>('all');
  const [absenceRecs, setAbsenceRecs] = useState<AbsenceRec[]>([]);
  const [absenceLoading, setAbsenceLoading] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<AbsenceRec | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [expandedReapply, setExpandedReapply] = useState<string | null>(null);
  const [expandedModify, setExpandedModify] = useState<string | null>(null);

  const fetchAbsences = useCallback(async () => {
    setAbsenceLoading(true);
    const { data } = await supabase
      .from('attendance_exceptions')
      .select('id, user_id, date, type, actual_time, notes, created_at, created_by')
      .order('date', { ascending: false });
    if (!data || data.length === 0) { setAbsenceRecs([]); setAbsenceLoading(false); return; }
    const ids = [...new Set([...data.map((r: { user_id: string }) => r.user_id), ...data.map((r: { created_by: string | null }) => r.created_by).filter(Boolean)])] as string[];
    const { data: profs } = await supabase.from('profiles').select('id, name').in('id', ids);
    const map: Record<string, string> = {};
    (profs || []).forEach((p: { id: string; name: string }) => { map[p.id] = p.name; });
    setAbsenceRecs((data as AbsenceRec[]).map(r => ({ ...r, targetName: map[r.user_id] || '不明', creatorName: r.created_by ? (map[r.created_by] || '不明') : '不明' })));
    setAbsenceLoading(false);
  }, [supabase]);

  useEffect(() => { if (absenceView) fetchAbsences(); }, [absenceView, fetchAbsences]);

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    await supabase.from('attendance_exceptions').delete().eq('id', deleteTarget.id);
    setDeleting(false);
    setDeleteTarget(null);
    fetchAbsences();
  };

          // 年度ヘルパー（4月始まり）
          const toFiscalYear = (dateStr: string) => {
            const d = new Date(dateStr);
            return d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
          };
          const nowFY = (() => { const n = new Date(); return n.getMonth() >= 3 ? n.getFullYear() : n.getFullYear() - 1; })();
          const fyOptions = [...new Set(leaveRequests.map(r => toFiscalYear(r.created_at)))].sort((a,b)=>b-a);
          if (!fyOptions.includes(nowFY)) fyOptions.unshift(nowFY);

          const leaveFilters = [
            { key: 'active',    label: '確認待ち' },
            { key: 'approved',  label: '受理済み' },
            { key: 'rejected',  label: '差し戻し' },
            { key: 'cancelled', label: '取消済み' },
            { key: 'all',       label: 'すべて' },
          ];
          // 完了していないものは年度・月・人フィルター不問で常に表示
          const isIncomplete = (r: AdminLeaveRequest) => !['approved','rejected','cancelled'].includes(r.status);
          const filteredLeave = leaveRequests
            .filter(r => {
              // ステータスフィルター
              if (leaveStatusFilter !== 'all') {
                if (leaveStatusFilter === 'active' && !isIncomplete(r)) return false;
                if (leaveStatusFilter !== 'active' && r.status !== leaveStatusFilter) return false;
              }
              // 人フィルターは未完了でも適用
              if (filterPerson !== 'all' && r.user_id !== filterPerson) return false;
              // 未完了は年度フィルターをスキップ（人フィルターのみ適用）
              if (isIncomplete(r)) return true;
              // 年度フィルター
              const activeFY = filterFY === '__current__' ? nowFY : (filterFY === 'all' ? null : Number(filterFY));
              if (activeFY !== null && toFiscalYear(r.created_at) !== activeFY) return false;
              return true;
            })
            .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

          // ツリー構造を組み立て（再申請は親の直下に表示）
          const extractParentId = (reason: string | null | undefined): string | null => {
            if (!reason) return null;
            const m = reason.match(/【再申請】元申請ID: (\S+)/);
            return m ? m[1] : null;
          };
          // filteredLeave の中で親子関係を組み立て
          const filteredIds = new Set(filteredLeave.map(r => r.id));
          type TreeRow = { req: AdminLeaveRequest; indent: boolean };
          const treeRows: TreeRow[] = [];
          const added = new Set<string>();
          for (const r of filteredLeave) {
            if (added.has(r.id)) continue;
            const parentId = extractParentId(r.reason);
            if (parentId && filteredIds.has(parentId)) continue; // 親がいる場合は親のあとに追加
            treeRows.push({ req: r, indent: false });
            added.add(r.id);
            // 子（この申請を親とする再申請）を探して直下に追加
            for (const child of filteredLeave) {
              if (added.has(child.id)) continue;
              if (extractParentId(child.reason) === r.id) {
                treeRows.push({ req: child, indent: true });
                added.add(child.id);
              }
            }
          }
          // 親がフィルター外の再申請（孤立した子）をツリー末尾に追加
          for (const r of filteredLeave) {
            if (!added.has(r.id)) treeRows.push({ req: r, indent: false });
          }

          // 人フィルター用の一覧（重複除去）
          const personOptions = [...new Map(leaveRequests.map(r => [r.user_id, r.profile?.name || r.user_id])).entries()]
            .sort((a,b) => (a[1] > b[1] ? 1 : -1));

          const getStatusDisplay = (req: AdminLeaveRequest): { role: string; name: string; color: string } => {
            if (req.status === 'pending')          return { role: req.approver?.role_title ? `① ${req.approver.role_title}` : '①', name: req.approver?.name || '確認待ち', color: '#e67e22' };
            if (req.status === 'step2_pending')    return { role: '② マネージャー', name: req.approver2?.name || '-', color: '#d35400' };
            if (req.status === 'manager_approved') return { role: '③ 経理', name: '管理者', color: '#17a2b8' };
            if (req.status === 'admin_approved')   return { role: '', name: '④ 社長', color: '#6f42c1' };
            if (req.status === 'approved')         return { role: '', name: '受理済み', color: '#28a745' };
            if (req.status === 'rejected')         return { role: '', name: '差し戻し', color: '#dc3545' };
            if (req.status === 'cancelled')        return { role: '', name: '取消済み', color: '#6c757d' };
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
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 16, justifyContent: 'center', alignItems: 'center' }}>
                {leaveFilters.map(f => (
                  <button
                    key={f.key}
                    onClick={() => { setAbsenceView(false); setLeaveStatusFilter(f.key); }}
                    style={{
                      padding: '5px 12px', borderRadius: 16, border: 'none', cursor: 'pointer', fontSize: 12,
                      background: !absenceView && leaveStatusFilter === f.key ? '#007bff' : (isDarkMode ? '#495057' : '#e9ecef'),
                      color: !absenceView && leaveStatusFilter === f.key ? 'white' : (isDarkMode ? '#fff' : '#333'),
                      fontWeight: !absenceView && leaveStatusFilter === f.key ? 'bold' : 'normal',
                    }}
                  >{f.label}</button>
                ))}
                <span style={{ color: isDarkMode ? '#6c757d' : '#ccc', fontSize: 16, margin: '0 4px' }}>┊</span>
                <button
                  onClick={() => setAbsenceView(true)}
                  style={{
                    padding: '5px 14px', borderRadius: 16, border: absenceView ? 'none' : `1px solid ${isDarkMode ? '#dc3545' : '#dc3545'}`, cursor: 'pointer', fontSize: 12,
                    background: absenceView ? '#dc3545' : 'transparent',
                    color: absenceView ? 'white' : '#dc3545',
                    fontWeight: absenceView ? 'bold' : 'normal',
                  }}
                >欠勤</button>
              </div>

              {/* 絞り込みフィルター（欠勤ビュー以外） */}
              {!absenceView && (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14, alignItems: 'center', justifyContent: 'center' }}>
                  <select value={filterFY === '__current__' ? String(nowFY) : filterFY} onChange={e => setFilterFY(e.target.value)}
                    style={{ padding: '5px 10px', borderRadius: 8, border: `1px solid ${isDarkMode ? '#6c757d' : '#ccc'}`, background: isDarkMode ? '#495057' : '#fff', color: isDarkMode ? '#fff' : '#333', fontSize: 12 }}>
                    <option value="all">全年度</option>
                    {fyOptions.map(fy => <option key={fy} value={String(fy)}>{fy}年度（{fy}/4/1〜{fy+1}/3/31）</option>)}
                  </select>
                  <SearchableSelect value={filterPerson} options={personOptions} onChange={setFilterPerson} isDarkMode={isDarkMode} />
                  {(filterFY !== '__current__' || filterPerson !== 'all') && (
                    <button onClick={() => { setFilterFY('__current__'); setFilterPerson('all'); }}
                      style={{ padding: '4px 10px', borderRadius: 8, border: 'none', background: '#6c757d', color: '#fff', fontSize: 11, cursor: 'pointer' }}>
                      リセット
                    </button>
                  )}
                  <span style={{ fontSize: 11, color: isDarkMode ? '#adb5bd' : '#888' }}>
                    ※ 未完了の申請は年度に関わらず常に表示（人名で絞れます）
                  </span>
                </div>
              )}

              {absenceView ? (() => {
                const toAbsFY = (dateStr: string) => { const d = new Date(dateStr); return d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1; };
                const absFyOptions = [...new Set(absenceRecs.map(r => toAbsFY(r.date)))].sort((a,b)=>b-a);
                if (!absFyOptions.includes(nowFY)) absFyOptions.unshift(nowFY);
                const absPersonOptions = [...new Map(absenceRecs.map(r => [r.user_id, r.targetName])).entries()].sort((a,b)=>a[1]>b[1]?1:-1);
                const activeFY = absFilterFY === '__current__' ? nowFY : (absFilterFY === 'all' ? null : Number(absFilterFY));
                const filteredAbsRecs = absenceRecs.filter(r => {
                  if (activeFY !== null && toAbsFY(r.date) !== activeFY) return false;
                  if (absFilterPerson !== 'all' && r.user_id !== absFilterPerson) return false;
                  return true;
                });
                return (
                  <>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14, alignItems: 'center', justifyContent: 'center' }}>
                      <select value={absFilterFY === '__current__' ? String(nowFY) : absFilterFY} onChange={e => setAbsFilterFY(e.target.value)}
                        style={{ padding: '5px 10px', borderRadius: 8, border: `1px solid ${isDarkMode ? '#6c757d' : '#ccc'}`, background: isDarkMode ? '#495057' : '#fff', color: isDarkMode ? '#fff' : '#333', fontSize: 12 }}>
                        <option value="all">全年度</option>
                        {absFyOptions.map(fy => <option key={fy} value={String(fy)}>{fy}年度（{fy}/4/1〜{fy+1}/3/31）</option>)}
                      </select>
                      <SearchableSelect value={absFilterPerson} options={absPersonOptions} onChange={setAbsFilterPerson} isDarkMode={isDarkMode} />
                      {(absFilterFY !== '__current__' || absFilterPerson !== 'all') && (
                        <button onClick={() => { setAbsFilterFY('__current__'); setAbsFilterPerson('all'); }}
                          style={{ padding: '4px 10px', borderRadius: 8, border: 'none', background: '#6c757d', color: '#fff', fontSize: 11, cursor: 'pointer' }}>
                          リセット
                        </button>
                      )}
                    </div>
                    {absenceLoading ? (
                      <p style={{ textAlign: 'center', color: isDarkMode ? '#fff' : '#000' }}>読み込み中...</p>
                    ) : filteredAbsRecs.length === 0 ? (
                      <p style={{ textAlign: 'center', color: isDarkMode ? '#aaa' : '#666' }}>欠勤記録はありません</p>
                    ) : (
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', color: isDarkMode ? '#fff' : '#000', fontSize: 13 }}>
                      <thead>
                        <tr style={{ background: isDarkMode ? '#5a1a1a' : '#fdf0f0' }}>
                          {['日付','対象者','種別','時間','追加日','追加者','備考','操作'].map(label => (
                            <th key={label} style={{ padding: '8px 6px', textAlign: 'center', borderBottom: `2px solid #dc3545`, color: isDarkMode ? '#fff' : '#333', fontSize: 12 }}>{label}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {filteredAbsRecs.map((rec, i) => {
                          const c = ABSENCE_COLOR[rec.type];
                          const addedDate = new Date(new Date(rec.created_at).getTime() + 9 * 60 * 60 * 1000);
                          return (
                            <tr key={rec.id} style={{ background: i % 2 === 0 ? (isDarkMode ? '#343a40' : 'white') : (isDarkMode ? '#3d4349' : '#fdf8f8') }}>
                              <td style={{ padding: '8px 6px', borderBottom: `1px solid ${isDarkMode ? '#6c757d' : '#f0d0d0'}`, textAlign: 'center', fontSize: 12 }}>{rec.date}</td>
                              <td style={{ padding: '8px 6px', borderBottom: `1px solid ${isDarkMode ? '#6c757d' : '#f0d0d0'}`, textAlign: 'center', fontSize: 12, fontWeight: 'bold' }}>{rec.targetName}</td>
                              <td style={{ padding: '8px 6px', borderBottom: `1px solid ${isDarkMode ? '#6c757d' : '#f0d0d0'}`, textAlign: 'center' }}>
                                <span style={{ padding: '2px 8px', borderRadius: 6, background: c.bg, color: c.text, fontSize: 11, fontWeight: 'bold' }}>{ABSENCE_LABEL[rec.type]}</span>
                              </td>
                              <td style={{ padding: '8px 6px', borderBottom: `1px solid ${isDarkMode ? '#6c757d' : '#f0d0d0'}`, textAlign: 'center', fontSize: 12 }}>{rec.actual_time ? rec.actual_time.slice(0, 5) : '—'}</td>
                              <td style={{ padding: '8px 6px', borderBottom: `1px solid ${isDarkMode ? '#6c757d' : '#f0d0d0'}`, textAlign: 'center', fontSize: 11, color: isDarkMode ? '#adb5bd' : '#666' }}>
                                <div>{addedDate.getFullYear()}</div><div>{addedDate.getMonth()+1}/{addedDate.getDate()}</div>
                              </td>
                              <td style={{ padding: '8px 6px', borderBottom: `1px solid ${isDarkMode ? '#6c757d' : '#f0d0d0'}`, textAlign: 'center', fontSize: 12 }}>{rec.creatorName}</td>
                              <td style={{ padding: '8px 6px', borderBottom: `1px solid ${isDarkMode ? '#6c757d' : '#f0d0d0'}`, textAlign: 'left', fontSize: 12, color: isDarkMode ? '#adb5bd' : '#666' }}>{rec.notes || '—'}</td>
                              <td style={{ padding: '8px 6px', borderBottom: `1px solid ${isDarkMode ? '#6c757d' : '#f0d0d0'}`, textAlign: 'center' }}>
                                <button onClick={() => setDeleteTarget(rec)} style={{ padding: '3px 10px', background: 'transparent', border: '1px solid #dc3545', color: '#dc3545', borderRadius: 6, cursor: 'pointer', fontSize: 11 }}>取消</button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                    )}
                  </>
                );
              })() : loadingLeaveRequests ? (
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
                      {treeRows.map(({ req, indent }, i) => {
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
                          <React.Fragment key={req.id}>
                          <tr style={{ background: indent ? (isDarkMode ? '#1e3a1e' : '#f0fff4') : (i % 2 === 0 ? (isDarkMode ? '#343a40' : 'white') : (isDarkMode ? '#3d4349' : '#f8f9fa')) }}>
                            <td style={{ padding: '8px 4px', borderBottom: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, textAlign: 'center', fontSize: 12, borderLeft: indent ? '3px solid #28a745' : undefined, paddingLeft: indent ? 8 : undefined }}>
                              {indent && <div style={{ fontSize: 9, color: '#28a745', lineHeight: 1 }}>└→</div>}
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
                              {req.reason && (() => {
                                const displayReason = req.reason.replace(/[\s　]?【再申請】元申請ID: \S+/g, '').replace(/【管理者が種別変更】[^　]+(（変更して受理）)?/g, '').trim();
                                const isReapply = req.reason.includes('【再申請】');
                                const isModified = !!req.modified_by;
                                return (
                                  <>
                                    {displayReason && <div style={{ color: isDarkMode ? '#adb5bd' : '#666', fontSize: 11 }}>備考: {displayReason}</div>}
                                    {isReapply && (() => {
                                      const parentId = req.reason?.match(/【再申請】元申請ID: (\S+)/)?.[1] ?? null;
                                      const isOpen = expandedReapply === req.id;
                                      return (
                                        <button onClick={() => setExpandedReapply(isOpen ? null : req.id)}
                                          style={{ fontSize: 10, background: '#007bff', color: '#fff', borderRadius: 4, padding: '2px 6px', marginTop: 3, display: 'inline-block', border: 'none', cursor: 'pointer' }}>
                                          {isOpen ? '▼ 再申請' : '▶ 再申請'}
                                        </button>
                                      );
                                      void parentId;
                                    })()}
                                    {isModified && (() => {
                                      const isOpen = expandedModify === req.id;
                                      return (
                                        <button onClick={() => setExpandedModify(isOpen ? null : req.id)}
                                          style={{ fontSize: 10, background: '#fd7e14', color: '#fff', borderRadius: 4, padding: '2px 6px', marginTop: 3, marginLeft: 3, display: 'inline-block', border: 'none', cursor: 'pointer' }}>
                                          {isOpen ? '▼ 修正' : '▶ 修正'}
                                        </button>
                                      );
                                    })()}
                                  </>
                                );
                              })()}
                              {!req.purpose && !req.reason && !req.modified_by && <span>-</span>}
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
                                  onClick={() => { setRejectModal(req); setRejectReason(''); setRejectNewType(''); }}
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
                                        const typeName = req.leave_type === 'その他' ? (req.leave_type_other || 'その他') : req.leave_type;
                                        if (req.status === 'step2_pending') {
                                          const daysCount = req.leave_dates ? (() => { try { return String(JSON.parse(req.leave_dates).length); } catch { return ''; } })() : '';
                                          const vars = { 休暇種別: typeName, 申請日数: daysCount };
                                          if (await shouldSend('leave:manager_approved', 'site')) {
                                            const t = await getNotificationTemplate('leave:manager_approved', 'site', vars);
                                            await insertNotification(req.user_id, t?.template ?? `休暇申請がマネージャーに受理されました`, t?.subject || `種別：${typeName}`);
                                          }
                                          if (await shouldSend('leave:manager_approved', 'slack')) {
                                            await sendLeaveSlack('manager_approved', '管理者', 'マネージャー');
                                          }
                                          const applicantEmail = await getUserEmail(req.user_id) ?? '';
                                          await dispatchEmail('leave:manager_approved', vars, { applicant: applicantEmail });
                                        }
                                        if (req.status === 'manager_approved' && await shouldSend('leave:manager_approved', 'slack')) {
                                          await sendLeaveSlack('accounting_approved', '経理担当者', '管理者');
                                        }
                                        fetchLeaveRequests();
                                      }
                                    }}
                                    style={{ padding: '4px 8px', background: '#28a745', color: 'white', border: '2px solid #1e7e34', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 'bold' }}
                                  >受理</button>
                                  <button
                                    onClick={() => { setRejectModal(req); setRejectReason(''); setRejectNewType(''); }}
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
                          {/* 再申請展開行：元申請の情報を同列フォーマットで表示 */}
                          {expandedReapply === req.id && (() => {
                            const parentId = req.reason?.match(/【再申請】元申請ID: (\S+)/)?.[1];
                            const parent = parentId ? leaveRequests.find(r => r.id === parentId) : null;
                            if (!parent) return (
                              <tr key={`expand-${req.id}`}>
                                <td colSpan={9} style={{ padding: '6px 12px', background: isDarkMode ? '#2a3a2a' : '#f0fff4', fontSize: 11, color: isDarkMode ? '#adb5bd' : '#666', borderBottom: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}` }}>
                                  元申請のデータが見つかりません
                                </td>
                              </tr>
                            );
                            const pLeaveDates: string[] = (() => { try { return parent.leave_dates ? JSON.parse(parent.leave_dates) : []; } catch { return []; } })();
                            const pDays = pLeaveDates.length > 0 ? pLeaveDates.length : Math.max(1, Math.floor((new Date(parent.end_date || '').getTime() - new Date(parent.start_date || '').getTime()) / (1000 * 60 * 60 * 24)) + 1);
                            const pDateDisplay = pLeaveDates.length > 0
                              ? (() => {
                                  const year = pLeaveDates[0].substring(0, 4);
                                  const groups = new Map<string, string[]>();
                                  pLeaveDates.forEach(d => { const [,m,day] = d.split('-'); const key = `${m}`; if (!groups.has(key)) groups.set(key, []); groups.get(key)!.push(day.replace(/^0/, '')); });
                                  return `${year}/${[...groups.entries()].map(([m, ds]) => `${m}/${ds.join('・')}`).join('、')}`;
                                })()
                              : (parent.start_date === parent.end_date ? parent.start_date : `${(parent.start_date || '').slice(5)}～${(parent.end_date || '').slice(5)}`);
                            const pJst = new Date(new Date(parent.created_at).getTime() + 9 * 60 * 60 * 1000);
                            const pSt = getStatusDisplay(parent);
                            const pDisplayReason = (parent.reason || '').replace(/[\s　]?【再申請】元申請ID: \S+/g, '').trim();
                            return (
                              <tr key={`expand-${req.id}`} style={{ background: isDarkMode ? '#1e3a1e' : '#f0fff4' }}>
                                <td style={{ padding: '6px 4px', borderBottom: `2px solid #28a745`, textAlign: 'center', fontSize: 11, borderLeft: '4px solid #28a745', color: isDarkMode ? '#adb5bd' : '#555' }}>
                                  <div style={{ fontSize: 9, color: '#28a745' }}>元申請</div>
                                  <div>{pJst.getFullYear()}</div><div>{pJst.getMonth()+1}/{pJst.getDate()}</div>
                                </td>
                                <td style={{ padding: '6px 4px', borderBottom: `2px solid #28a745`, textAlign: 'center', fontSize: 11, color: isDarkMode ? '#adb5bd' : '#555' }}>
                                  {(parent.profile?.name || '-').split(/[\s　]/).map((s: string, j: number) => <div key={j}>{s}</div>)}
                                </td>
                                <td style={{ padding: '6px 4px', borderBottom: `2px solid #28a745`, textAlign: 'center', fontSize: 11, color: isDarkMode ? '#adb5bd' : '#555' }}>
                                  {(parent.approver?.name || '-').split(/[\s　]/).map((s: string, j: number) => <div key={j}>{s}</div>)}
                                </td>
                                <td style={{ padding: '6px 4px', borderBottom: `2px solid #28a745`, textAlign: 'center', fontSize: 11, color: isDarkMode ? '#adb5bd' : '#555' }}>{parent.leave_type === 'その他' ? parent.leave_type_other : parent.leave_type}</td>
                                <td style={{ padding: '6px 4px', borderBottom: `2px solid #28a745`, textAlign: 'center', fontSize: 10, color: isDarkMode ? '#adb5bd' : '#555' }}>{pDateDisplay}</td>
                                <td style={{ padding: '6px 4px', borderBottom: `2px solid #28a745`, textAlign: 'center', fontSize: 11, color: isDarkMode ? '#adb5bd' : '#555' }}>{pDays}日</td>
                                <td style={{ padding: '6px 4px', borderBottom: `2px solid #28a745`, textAlign: 'left', fontSize: 11, wordBreak: 'break-word', color: isDarkMode ? '#adb5bd' : '#555' }}>
                                  {parent.purpose && <div>{parent.purpose}</div>}
                                  {pDisplayReason && <div style={{ fontSize: 10 }}>備考: {pDisplayReason}</div>}
                                  {parent.rejected_reason && <div style={{ fontSize: 10, color: '#dc3545' }}>差し戻し理由: {parent.rejected_reason}</div>}
                                </td>
                                <td style={{ padding: '6px 4px', borderBottom: `2px solid #28a745`, textAlign: 'center' }}>
                                  <div style={{ display: 'inline-block', padding: '3px 8px', borderRadius: 8, background: pSt.color, color: 'white', textAlign: 'center', lineHeight: 1.4 }}>
                                    <div style={{ fontWeight: 'bold', fontSize: 11 }}>{pSt.name}</div>
                                  </div>
                                </td>
                                <td style={{ padding: '6px 4px', borderBottom: `2px solid #28a745` }} />
                              </tr>
                            );
                          })()}
                          {/* 修正展開行 */}
                          {expandedModify === req.id && (() => {
                            const match = req.reason?.match(/【管理者が種別変更】(.+?) → (.+?)（変更して受理）/);
                            const modifiedAtJst = req.modified_at ? new Date(req.modified_at) : null;
                            return (
                              <tr key={`modify-${req.id}`} style={{ background: isDarkMode ? '#2a1e00' : '#fff8f0' }}>
                                <td colSpan={9} style={{ padding: '7px 12px', borderBottom: `2px solid #fd7e14`, borderLeft: '4px solid #fd7e14', fontSize: 11, color: isDarkMode ? '#ffe082' : '#7c4d00' }}>
                                  <span style={{ fontSize: 10, color: '#fd7e14', fontWeight: 'bold', marginRight: 8 }}>🖊 修正履歴</span>
                                  <strong>{req.modifier?.name ?? '管理者'}</strong>
                                  {modifiedAtJst && <span style={{ marginLeft: 8 }}>{modifiedAtJst.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>}
                                  {match && <span style={{ marginLeft: 8 }}>「{match[1]}」→「{match[2]}」に変更して受理</span>}
                                </td>
                              </tr>
                            );
                          })()}
                        </React.Fragment>
                      );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              {/* 取消確認モーダル */}
              {deleteTarget && (
                <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
                  <div style={{ background: isDarkMode ? '#343a40' : '#fff', borderRadius: 14, padding: 24, width: '100%', maxWidth: 340 }}>
                    <div style={{ fontSize: 16, fontWeight: 'bold', marginBottom: 16, color: '#dc3545' }}>取消の確認</div>
                    <div style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#e0e0e0'}`, borderRadius: 8, padding: 12, marginBottom: 20, fontSize: 14, color: isDarkMode ? '#fff' : '#333' }}>
                      <div><strong>{deleteTarget.targetName}</strong></div>
                      <div style={{ marginTop: 4 }}>{deleteTarget.date}　{ABSENCE_LABEL[deleteTarget.type]}{deleteTarget.actual_time ? `　${deleteTarget.actual_time.slice(0, 5)}` : ''}</div>
                      <div style={{ marginTop: 4, fontSize: 12, color: isDarkMode ? '#adb5bd' : '#666' }}>追加者：{deleteTarget.creatorName}</div>
                      {deleteTarget.notes && <div style={{ marginTop: 4, fontSize: 12, color: isDarkMode ? '#adb5bd' : '#666' }}>備考：{deleteTarget.notes}</div>}
                    </div>
                    <div style={{ fontSize: 13, color: isDarkMode ? '#adb5bd' : '#666', marginBottom: 16 }}>このレコードを削除します。元に戻せません。</div>
                    <div style={{ display: 'flex', gap: 10 }}>
                      <button onClick={() => setDeleteTarget(null)} style={{ flex: 1, padding: 12, background: '#6c757d', color: '#fff', border: 'none', borderRadius: 10, fontSize: 15, cursor: 'pointer' }}>戻る</button>
                      <button onClick={handleDelete} disabled={deleting} style={{ flex: 2, padding: 12, background: '#dc3545', color: '#fff', border: 'none', borderRadius: 10, fontSize: 15, fontWeight: 'bold', cursor: deleting ? 'not-allowed' : 'pointer', opacity: deleting ? 0.7 : 1 }}>
                        {deleting ? '削除中...' : '取消を確定する'}
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* 差し戻しモーダル（管理画面） */}
              {rejectModal && (
                <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
                  <div style={{ background: isDarkMode ? '#343a40' : '#fff', borderRadius: 14, padding: 24, width: '100%', maxWidth: 400 }}>
                    <div style={{ fontSize: 16, fontWeight: 'bold', marginBottom: 4, color: isDarkMode ? '#fff' : '#333' }}>差し戻し</div>
                    <div style={{ fontSize: 13, color: isDarkMode ? '#adb5bd' : '#666', marginBottom: 16 }}>
                      {rejectModal.profile?.name}　{rejectModal.leave_type === 'その他' ? rejectModal.leave_type_other : rejectModal.leave_type}
                    </div>
                    <div style={{ marginBottom: 12 }}>
                      <div style={{ fontSize: 13, color: isDarkMode ? '#adb5bd' : '#666', marginBottom: 6 }}>種別を変更する（任意）</div>
                      <select value={rejectNewType} onChange={e => setRejectNewType(e.target.value)}
                        style={{ width: '100%', padding: '8px', border: `1px solid ${isDarkMode ? '#6c757d' : '#ccc'}`, borderRadius: 8, fontSize: 14, background: isDarkMode ? '#495057' : '#fff', color: isDarkMode ? '#fff' : '#333' }}>
                        <option value="">変更しない</option>
                        {LEAVE_TYPES.filter(t => t !== rejectModal.leave_type).map(t => <option key={t} value={t}>{t}</option>)}
                      </select>
                      {rejectNewType && <div style={{ fontSize: 12, color: '#e65100', marginTop: 4 }}>「{rejectModal.leave_type}」→「{rejectNewType}」に変更して差し戻します</div>}
                    </div>
                    <div style={{ marginBottom: 16 }}>
                      <div style={{ fontSize: 13, color: isDarkMode ? '#adb5bd' : '#666', marginBottom: 6 }}>
                        差し戻し理由（任意）
                        <span style={{ fontSize: 11, color: isDarkMode ? '#adb5bd' : '#999', marginLeft: 8 }}>※種別変更なしの場合、申請者への通知に含まれます</span>
                      </div>
                      <textarea value={rejectReason} onChange={e => setRejectReason(e.target.value)} placeholder="差し戻し理由を入力してください" rows={3}
                        style={{ width: '100%', padding: '10px', border: `1px solid ${isDarkMode ? '#6c757d' : '#ccc'}`, borderRadius: 8, fontSize: 14, boxSizing: 'border-box', background: isDarkMode ? '#495057' : '#fff', color: isDarkMode ? '#fff' : '#333', resize: 'vertical' }} />
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {/* キャンセル：上・横全幅 */}
                      <button onClick={() => { setRejectModal(null); setRejectReason(''); setRejectNewType(''); }}
                        style={{ width: '100%', padding: '10px', background: '#6c757d', color: '#fff', border: 'none', borderRadius: 10, fontSize: 14, cursor: 'pointer' }}>
                        キャンセル
                      </button>
                      {/* 下：緑＋赤 横並び（種別変更ありの場合のみ） */}
                      <div style={{ display: 'flex', gap: 8 }}>
                        {rejectNewType && (
                          <button onClick={async () => {
                            const origType = rejectModal.leave_type === 'その他' ? (rejectModal.leave_type_other || 'その他') : rejectModal.leave_type;
                            const autoNote = `【管理者が種別変更】${origType} → ${rejectNewType}（変更して受理）`;
                            await supabase.from('leave_requests').update({ leave_type: rejectNewType, status: 'approved', reason: rejectReason ? `${rejectReason}　${autoNote}` : autoNote, modified_by: authUser?.id ?? null, modified_at: new Date().toISOString() }).eq('id', rejectModal.id);
                            if (await shouldSend('leave:rejected_type_changed', 'site')) {
                              const t = await getNotificationTemplate('leave:rejected_type_changed', 'site', { 元種別: origType, 新種別: rejectNewType });
                              await insertNotification(rejectModal.user_id, t?.template ?? `「${origType}」が「${rejectNewType}」に変更され、受理されました`);
                            }
                            setRejectModal(null); setRejectReason(''); setRejectNewType('');
                            fetchLeaveRequests();
                          }} style={{ flex: 1, padding: '14px 8px', background: '#28a745', color: '#fff', border: 'none', borderRadius: 10, fontSize: 13, fontWeight: 'bold', cursor: 'pointer', lineHeight: 1.4 }}>
                            差戻なし<br />「{rejectNewType}」に<br />変更して受理
                          </button>
                        )}
                        <button onClick={async () => {
                          const origType = rejectModal.leave_type === 'その他' ? (rejectModal.leave_type_other || 'その他') : rejectModal.leave_type;
                          const finalReason = rejectNewType
                            ? `種別を「${rejectNewType}」に変更しました。${rejectReason ? `　理由：${rejectReason}` : ''}`
                            : (rejectReason || null);
                          const update: Record<string, string | null> = { status: 'rejected', rejected_reason: finalReason };
                          if (rejectNewType) update.leave_type = rejectNewType;
                          await supabase.from('leave_requests').update(update).eq('id', rejectModal.id);
                          if (rejectNewType) {
                            // 種別変更あり → 新申請を受理済みで自動作成
                            const autoNote = `【管理者が種別変更】${origType} → ${rejectNewType}（元の申請から自動作成）`;
                            await supabase.from('leave_requests').insert({
                              user_id: rejectModal.user_id,
                              leave_type: rejectNewType,
                              leave_dates: rejectModal.leave_dates,
                              start_date: rejectModal.start_date,
                              end_date: rejectModal.end_date,
                              reason: autoNote,
                              status: 'approved',
                              approver_id: rejectModal.approver_id,
                              approver2_id: rejectModal.approver2_id,
                            });
                            if (await shouldSend('leave:rejected_reapplied', 'site')) {
                              const t = await getNotificationTemplate('leave:rejected_reapplied', 'site', { 元種別: origType, 新種別: rejectNewType });
                              await insertNotification(rejectModal.user_id, t?.template ?? `${origType}が差し戻され、${rejectNewType}で再申請・受理済みです`);
                            }
                          } else {
                            if (await shouldSend('leave:rejected', 'site')) {
                              const t = await getNotificationTemplate('leave:rejected', 'site', { 申請者名: '', 休暇種別: rejectModal.leave_type, 差し戻し理由: rejectReason || '' });
                              await insertNotification(rejectModal.user_id, t?.template ?? `休暇申請が差し戻されました`, t?.subject || rejectReason || undefined);
                            }
                            if (await shouldSend('leave:rejected', 'slack')) {
                              const targetChannel = await getNotificationRecipient('leave:rejected', 'slack');
                              await sendLeaveSlack('rejected', '管理者', '管理者', undefined, undefined, targetChannel ?? 'leader');
                            }
                            const rejectedEmail = await getUserEmail(rejectModal.user_id) ?? '';
                            await dispatchEmail('leave:rejected', { 申請者名: '', 休暇種別: rejectModal.leave_type, 差し戻し理由: rejectReason || '' }, { applicant: rejectedEmail });
                          }
                          setRejectModal(null); setRejectReason(''); setRejectNewType('');
                          fetchLeaveRequests();
                        }} style={{ flex: 1, padding: '14px 8px', background: '#dc3545', color: '#fff', border: 'none', borderRadius: 10, fontSize: 13, fontWeight: 'bold', cursor: 'pointer', lineHeight: 1.4 }}>
                          {rejectNewType
                            ? <>「{rejectModal.leave_type}」を差戻し<br />「{rejectNewType}」の<br />受理を追加</>
                            : '差し戻す'
                          }
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
};

export default LeaveRequestsTab;

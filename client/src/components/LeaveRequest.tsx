import React, { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient';
import { sendLeaveSlack } from '../lib/leaveSlack';
import { useDarkMode } from '../hooks/useDarkMode';
import type { AuthUser, AdminLeaveRequest } from '../types';

interface Props {
  user: AuthUser;
  profileName: string | null;
  roleTitle: string;
  leaveRequestEnabled?: boolean;
}

interface Approver {
  id: string;
  name: string;
  role_title: string;
}

interface LeaveRecord {
  id: string;
  leave_type: string;
  leave_type_other: string | null;
  leave_dates: string | null;
  start_date: string;
  end_date: string;
  purpose: string | null;
  reason: string | null;
  status: string;
  created_at: string;
  rejected_reason: string | null;
  approver?: { name: string; role_title: string } | null;
  approver2?: { name: string; role_title: string } | null;
}

type LeaveType = '有給休暇' | 'バースデー休暇（有給）' | '慶弔休暇' | 'その他';

const STATUS_LABEL: Record<string, { label: string; color: string }> = {
  pending:          { label: '確認中（一人目）',      color: '#856404' },
  step2_pending:    { label: '確認中（マネージャー）', color: '#856404' },
  manager_approved: { label: 'マネージャー受理済み',   color: '#0c5460' },
  admin_approved:   { label: '経理受理済み',           color: '#0c5460' },
  approved:         { label: '受理済み',               color: '#155724' },
  rejected:         { label: '差し戻し',               color: '#721c24' },
};

// ---- カレンダーコンポーネント ----
const MultiDatePicker: React.FC<{
  selectedDates: string[];
  onChange: (dates: string[]) => void;
  isDark: boolean;
}> = ({ selectedDates, onChange, isDark }) => {
  const today = new Date();
  const [viewYear, setViewYear] = useState(today.getFullYear());
  const [viewMonth, setViewMonth] = useState(today.getMonth());

  const text = isDark ? '#fff' : '#333';
  const borderColor = isDark ? '#6c757d' : '#ddd';

  const getDaysInMonth = (y: number, m: number) => new Date(y, m + 1, 0).getDate();
  const getFirstDayOfWeek = (y: number, m: number) => new Date(y, m, 1).getDay();
  const fmt = (y: number, m: number, d: number) =>
    `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

  const toggleDate = (dateStr: string) => {
    let newDates: string[];
    if (selectedDates.includes(dateStr)) {
      newDates = selectedDates.filter(d => d !== dateStr);
    } else {
      newDates = [...selectedDates, dateStr].sort();
      // 2か月以上またがる選択を禁止
      const months = [...new Set(newDates.map(d => d.substring(0, 7)))].sort();
      if (months.length > 1) {
        const first = new Date(months[0] + '-01');
        const last = new Date(months[months.length - 1] + '-01');
        const diff =
          (last.getFullYear() - first.getFullYear()) * 12 +
          last.getMonth() - first.getMonth();
        if (diff > 1) {
          alert('2か月を超える期間は選択できません（例：5月と7月の同時選択は不可）');
          return;
        }
      }
    }
    onChange(newDates);
  };

  const prevMonth = () => {
    if (viewMonth === 0) { setViewYear(y => y - 1); setViewMonth(11); }
    else setViewMonth(m => m - 1);
  };
  const nextMonth = () => {
    if (viewMonth === 11) { setViewYear(y => y + 1); setViewMonth(0); }
    else setViewMonth(m => m + 1);
  };

  const daysInMonth = getDaysInMonth(viewYear, viewMonth);
  const firstDay = getFirstDayOfWeek(viewYear, viewMonth);
  const monthNames = ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];
  const dayNames = ['日','月','火','水','木','金','土'];
  const todayStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;

  const cells: (number | null)[] = [];
  for (let i = 0; i < firstDay; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  return (
    <div style={{ background: isDark ? '#495057' : '#f8f9fa', borderRadius: 10, padding: 12, border: `1px solid ${borderColor}` }}>
      {/* ヘッダー */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <button onClick={prevMonth} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: text, padding: '0 10px', lineHeight: 1 }}>‹</button>
        <span style={{ fontWeight: 'bold', color: text, fontSize: 15 }}>{viewYear}年 {monthNames[viewMonth]}</span>
        <button onClick={nextMonth} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: text, padding: '0 10px', lineHeight: 1 }}>›</button>
      </div>
      {/* 曜日ヘッダー */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2, marginBottom: 4 }}>
        {dayNames.map((d, i) => (
          <div key={d} style={{ textAlign: 'center', fontSize: 11, fontWeight: 'bold', color: i === 0 ? '#e74c3c' : i === 6 ? '#3498db' : text, padding: '3px 0' }}>
            {d}
          </div>
        ))}
      </div>
      {/* 日付グリッド */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2 }}>
        {cells.map((day, i) => {
          if (!day) return <div key={`e-${i}`} />;
          const dateStr = fmt(viewYear, viewMonth, day);
          const isSelected = selectedDates.includes(dateStr);
          const dow = (firstDay + day - 1) % 7;
          const isToday = dateStr === todayStr;
          const isSun = dow === 0;
          const isSat = dow === 6;
          return (
            <button
              key={dateStr}
              onClick={() => toggleDate(dateStr)}
              style={{
                padding: '10px 2px',
                minHeight: 40,
                borderRadius: 6,
                border: isToday ? '2px solid #007bff' : '1px solid transparent',
                background: isSelected ? '#28a745' : 'transparent',
                color: isSelected ? 'white' : isSun ? '#e74c3c' : isSat ? '#3498db' : text,
                cursor: 'pointer',
                fontSize: 13,
                fontWeight: isSelected ? 'bold' : 'normal',
                textAlign: 'center',
              }}
            >
              {day}
            </button>
          );
        })}
      </div>
      {/* 選択中表示 */}
      {selectedDates.length > 0 && (
        <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, color: '#28a745', fontWeight: 'bold' }}>✓ {selectedDates.length}日選択中</span>
          <button
            onClick={() => onChange([])}
            style={{ padding: '2px 10px', background: '#dc3545', color: 'white', border: 'none', borderRadius: 10, cursor: 'pointer', fontSize: 11 }}
          >クリア</button>
        </div>
      )}
    </div>
  );
};

// 選択日の表示用ヘルパー
const formatSelectedDates = (dates: string[]): string => {
  if (dates.length === 0) return '';
  if (dates.length === 1) return dates[0];
  return `${dates[0]} ～ ${dates[dates.length - 1]}（${dates.length}日選択）`;
};

// ---- メインコンポーネント ----
const LeaveRequestForm: React.FC<Props> = ({ user, profileName, roleTitle: _roleTitle = '', leaveRequestEnabled }) => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [tab, setTab] = useState<'form' | 'history'>(searchParams.get('tab') === 'history' ? 'history' : 'form');

  const [leaveType, setLeaveType] = useState<LeaveType>('有給休暇');
  const [leaveTypeOther, setLeaveTypeOther] = useState('');
  const [selectedDates, setSelectedDates] = useState<string[]>([]);
  const [purpose, setPurpose] = useState('');
  const [notes, setNotes] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [approvers, setApprovers] = useState<Approver[]>([]);
  const [selectedApproverId, setSelectedApproverId] = useState('');
  const [showApproverGuide, setShowApproverGuide] = useState(false);
  const [leaderAssignments, setLeaderAssignments] = useState<{ id: string; course: string; school: string; leader: string; manager: string }[]>([]);
  const [loadingAssignments, setLoadingAssignments] = useState(true);

  useEffect(() => {
    supabase
      .from('leader_assignments')
      .select('id, course, school, leader, manager')
      .order('display_order', { ascending: true })
      .then(({ data, error }) => {
        if (!error && data) setLeaderAssignments(data);
        setLoadingAssignments(false);
      });
  }, []);

  const [history, setHistory] = useState<LeaveRecord[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [openFiscalYears, setOpenFiscalYears] = useState<Record<string, boolean>>({});
  const [showPastYears, setShowPastYears] = useState(false);
  const [selectedFY, setSelectedFY] = useState<string>(() => {
    const now = new Date();
    const m = now.getMonth() + 1;
    const y = now.getFullYear();
    return String(m >= 4 ? y : y - 1);
  });

  useEffect(() => {
    supabase
      .from('profiles')
      .select('id, name, role_title')
      .in('role_title', ['リーダー', 'マネージャー'])
      .eq('is_active', true)
      .order('role_title', { ascending: false })
      .order('name')
      .then(({ data, error }) => {
        if (!error && data) {
          setApprovers(data);
          if (data.length > 0) setSelectedApproverId(data[0].id);
        }
      });
  }, []);

  useEffect(() => {
    if (tab !== 'history') return;
    const fetchHistory = async () => {
      setLoadingHistory(true);
      const { data, error } = await supabase
        .from('leave_requests')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false });
      if (!error && data) {
        const allIds = [...new Set([
          ...data.map((r: AdminLeaveRequest) => r.approver_id),
          ...data.map((r: AdminLeaveRequest) => r.approver2_id),
        ].filter(Boolean))];
        let profileMap: Record<string, { name: string; role_title: string }> = {};
        if (allIds.length > 0) {
          const { data: profiles } = await supabase
            .from('profiles').select('id, name, role_title').in('id', allIds);
          if (profiles) profiles.forEach((p: { id: string; name: string; role_title: string }) => { profileMap[p.id] = p; });
        }
        setHistory(data.map((r: AdminLeaveRequest) => ({
          ...r,
          leave_type_other: r.leave_type_other ?? null,
          leave_dates: r.leave_dates ?? null,
          start_date: r.start_date ?? '',
          end_date: r.end_date ?? '',
          purpose: r.purpose ?? null,
          reason: r.reason ?? null,
          rejected_reason: r.rejected_reason ?? null,
          approver: profileMap[r.approver_id ?? ''] || null,
          approver2: profileMap[r.approver2_id ?? ''] || null,
        })));
      }
      setLoadingHistory(false);
    };
    fetchHistory();
  }, [tab, user.id]);

  const selectedApprover = approvers.find(a => a.id === selectedApproverId);

  const handleSubmit = async () => {
    setIsSubmitting(true);
    try {
      const startDate = selectedDates[0] || '';
      const endDate = selectedDates[selectedDates.length - 1] || '';
      const { error } = await supabase.from('leave_requests').insert({
        user_id: user.id,
        leave_type: leaveType,
        leave_type_other: leaveType === 'その他' ? leaveTypeOther : null,
        leave_dates: JSON.stringify(selectedDates),
        start_date: startDate,
        end_date: endDate,
        purpose: purpose,
        reason: notes || null,
        status: 'pending',
        current_approver: 'first',
        approver_id: selectedApproverId,
      });
      if (error) throw error;
      await supabase.from('profiles').update({ leave_request_enabled: false, leave_enabled_by: null }).eq('id', user.id);
      // Slack通知（申請先の役職に応じてチャンネルを切り替え）
      if (selectedApprover) {
        await sendLeaveSlack('new_request', selectedApprover.name, selectedApprover.role_title);
      }
      setSubmitted(true);
      setShowConfirm(false);
    } catch (err: unknown) {
      alert('送信に失敗しました。\n' + (err instanceof Error ? err.message : JSON.stringify(err)));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleReset = () => {
    setLeaveType('有給休暇');
    setLeaveTypeOther('');
    setSelectedDates([]);
    setPurpose('');
    setNotes('');
    setSubmitted(false);
    if (approvers.length > 0) setSelectedApproverId(approvers[0].id);
  };

  const isDark = useDarkMode();
  const bg = isDark ? '#343a40' : 'white';
  const text = isDark ? '#fff' : '#333';
  const subText = isDark ? '#adb5bd' : '#666';
  const inputBg = isDark ? '#495057' : 'white';
  const borderColor = isDark ? '#6c757d' : '#ddd';

  if (submitted) {
    return (
      <div style={{ maxWidth: 500, margin: '40px auto', padding: 24, background: bg, borderRadius: 12, boxShadow: '0 2px 12px rgba(0,0,0,0.1)', textAlign: 'center' }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>✅</div>
        <h2 style={{ color: '#28a745', marginBottom: 8 }}>申請しました</h2>
        <p style={{ color: subText, marginBottom: 24 }}>担当者に通知されます。</p>
        <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
          <button onClick={() => navigate('/')} style={{ padding: '10px 24px', background: '#28a745', color: 'white', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 15 }}>
            🏠 ホームに戻る
          </button>
          {!leaveRequestEnabled && (
            <>
              <button onClick={handleReset} style={{ padding: '10px 24px', background: '#007bff', color: 'white', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 15 }}>
                続けて申請する
              </button>
              <button onClick={() => { handleReset(); setTab('history'); }} style={{ padding: '10px 24px', background: '#6c757d', color: 'white', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 15 }}>
                申請履歴を確認
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  const isApprover = ['リーダー', 'マネージャー', '社長', '管理者'].includes(_roleTitle);

  return (
    <div style={{ maxWidth: 600, width: '100%', margin: '20px auto', padding: '0 12px', boxSizing: 'border-box' }}>
      {/* タブ切替 */}
      <div style={{ display: 'flex', marginBottom: 0, borderRadius: '10px 10px 0 0', overflow: 'hidden', boxShadow: '0 2px 8px rgba(0,0,0,0.08)' }}>
        <button
          onClick={() => setTab('form')}
          style={{ flex: 1, padding: '12px', background: tab === 'form' ? '#28a745' : (isDark ? '#495057' : '#f8f9fa'), color: tab === 'form' ? 'white' : text, border: 'none', cursor: 'pointer', fontSize: 15, fontWeight: tab === 'form' ? 'bold' : 'normal' }}
        >
          🌿 新規申請
        </button>
        {!leaveRequestEnabled && (
          <button
            onClick={() => setTab('history')}
            style={{ flex: 1, padding: '12px', background: tab === 'history' ? '#28a745' : (isDark ? '#495057' : '#f8f9fa'), color: tab === 'history' ? 'white' : text, border: 'none', cursor: 'pointer', fontSize: 15, fontWeight: tab === 'history' ? 'bold' : 'normal' }}
          >
            📋 申請履歴
          </button>
        )}
      </div>

      {isApprover && (
        <button
          onClick={() => navigate('/leave-approvals')}
          style={{ width: '100%', padding: '10px', background: '#fd7e14', color: 'white', border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: 'bold', marginTop: 8, borderRadius: 8 }}
        >
          ✅ 受理ページへ
        </button>
      )}

      {/* 申請フォーム */}
      {tab === 'form' && (
        <div style={{ padding: 24, background: bg, borderRadius: '0 0 12px 12px', boxShadow: '0 2px 12px rgba(0,0,0,0.1)', boxSizing: 'border-box', width: '100%' }}>
          <h2 style={{ marginBottom: 12, fontSize: 20, color: text }}>🌿 休暇申請</h2>

          {/* 注意事項 */}
          <div style={{
            background: isDark ? '#2c3e50' : '#e8f4fd',
            border: `1px solid ${isDark ? '#3d5a73' : '#bee5eb'}`,
            borderRadius: 8, padding: '12px 14px', marginBottom: 20, textAlign: 'left',
          }}>
            <p style={{ fontSize: 13, fontWeight: 'bold', color: isDark ? '#fff' : '#1a4a5a', marginBottom: 8 }}>【注意事項】</p>
            <ol style={{ margin: 0, paddingLeft: 20, fontSize: 12, color: isDark ? '#d0dde8' : '#2c5f6e', lineHeight: 1.8, textAlign: 'left' }}>
              <li>休暇申請は、できるだけ休暇予定日の<strong>2週間前まで</strong>に行ってください。</li>
              <li>申請先は、休暇を取得する日の<strong>勤務校リーダー</strong>を選択してください。</li>
              <li>申請後、選択したリーダーへ<strong>直接相談</strong>してください。</li>
              <li>申請が受理されると、交通費申請ページに通知が表示されます。</li>
              <li>パートタイマーの方も、正社員と同様に申請してください。</li>
            </ol>

            <button
              type="button"
              onClick={() => setShowApproverGuide(v => !v)}
              style={{
                marginTop: 10, padding: '6px 12px', fontSize: 12, fontWeight: 'bold',
                background: isDark ? '#3d5a73' : '#bee5eb', color: isDark ? '#fff' : '#1a4a5a',
                border: 'none', borderRadius: 6, cursor: 'pointer',
              }}
            >
              {showApproverGuide ? '▲ 勤務校リーダー・マネージャー 一覧を閉じる' : '▼ 勤務校リーダー・マネージャー 一覧を表示'}
            </button>

            {showApproverGuide && (
              <div style={{
                marginTop: 10, padding: '12px 14px', borderRadius: 8,
                background: isDark ? '#343a40' : '#ffffff',
                border: `1px solid ${isDark ? '#495057' : '#bee5eb'}`,
                fontSize: 12, lineHeight: 1.8, color: isDark ? '#d0dde8' : '#2c5f6e', textAlign: 'left',
              }}>
                {(() => {
                  const th: React.CSSProperties = { textAlign: 'left', padding: '8px', background: isDark ? '#2c3e50' : '#e8f4fd', fontWeight: 'bold' };
                  const td: React.CSSProperties = { padding: '7px 8px', borderBottom: `1px solid ${isDark ? '#495057' : '#e5eef1'}`, verticalAlign: 'middle' };
                  const sectionTd: React.CSSProperties = { padding: '6px 8px', background: '#1a4a5a', color: '#fff', fontWeight: 'bold' };
                  const Section = ({ label }: { label: string }) => (
                    <tr><td colSpan={3} style={sectionTd}>{label}</td></tr>
                  );

                  if (loadingAssignments) return <p style={{ margin: 0 }}>読み込み中...</p>;
                  if (leaderAssignments.length === 0) return <p style={{ margin: 0 }}>担当者情報が登録されていません。</p>;

                  const courses: string[] = [];
                  leaderAssignments.forEach(a => { if (!courses.includes(a.course)) courses.push(a.course); });

                  return (
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <colgroup><col style={{ width: '32%' }} /><col style={{ width: '38%' }} /><col style={{ width: '30%' }} /></colgroup>
                      <thead><tr><th style={th}>校・コース</th><th style={th}>リーダー</th><th style={th}>マネージャー</th></tr></thead>
                      <tbody>
                        {courses.map(course => (
                          <React.Fragment key={course}>
                            <Section label={`【${course}】`} />
                            {leaderAssignments.filter(a => a.course === course).map(a => (
                              <tr key={a.id}>
                                <td style={td}>{a.school.split('\n').map((line, i) => <React.Fragment key={i}>{i > 0 && <br/>}{line}</React.Fragment>)}</td>
                                <td style={td}>{a.leader.split('\n').map((line, i) => <React.Fragment key={i}>{i > 0 && <br/>}{line}</React.Fragment>)}</td>
                                <td style={td}>{a.manager}</td>
                              </tr>
                            ))}
                          </React.Fragment>
                        ))}
                      </tbody>
                    </table>
                  );
                })()}
              </div>
            )}
          </div>

          {/* 申請者 */}
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'block', fontWeight: 'bold', marginBottom: 6, color: text }}>申請者</label>
            <div style={{ padding: '10px 14px', background: isDark ? '#495057' : '#f8f9fa', borderRadius: 8, color: text }}>
              {profileName || user.email}
            </div>
          </div>

          {/* 申請先 */}
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'block', fontWeight: 'bold', marginBottom: 6, color: text }}>申請先 *</label>
            {approvers.length === 0 ? (
              <div style={{ padding: '10px 14px', background: '#fff3cd', borderRadius: 8, color: '#856404', fontSize: 14 }}>
                承認者が登録されていません
              </div>
            ) : (
              <select
                value={selectedApproverId}
                onChange={e => setSelectedApproverId(e.target.value)}
                style={{ width: '100%', padding: '10px 14px', border: `1px solid ${borderColor}`, borderRadius: 8, fontSize: 15, background: inputBg, color: text }}
              >
                {approvers.map(a => (
                  <option key={a.id} value={a.id}>{a.name}（{a.role_title}）</option>
                ))}
              </select>
            )}
          </div>

          {/* 休暇種別 */}
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'block', fontWeight: 'bold', marginBottom: 6, color: text }}>休暇種別 *</label>
            <select
              value={leaveType}
              onChange={e => setLeaveType(e.target.value as LeaveType)}
              style={{ width: '100%', padding: '10px 14px', border: `1px solid ${borderColor}`, borderRadius: 8, fontSize: 15, background: inputBg, color: text }}
            >
              <option value="有給休暇">有給休暇</option>
              <option value="バースデー休暇（有給）">バースデー休暇（有給）</option>
              <option value="慶弔休暇">慶弔休暇</option>
              <option value="その他">その他</option>
            </select>
            {leaveType === 'その他' && (
              <input
                type="text"
                value={leaveTypeOther}
                onChange={e => setLeaveTypeOther(e.target.value)}
                placeholder="種別を入力"
                style={{ width: '100%', marginTop: 8, padding: '10px 14px', border: `1px solid ${borderColor}`, borderRadius: 8, fontSize: 15, boxSizing: 'border-box', background: inputBg, color: text }}
              />
            )}
          </div>

          {/* 休暇日 カレンダー */}
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'block', fontWeight: 'bold', marginBottom: 6, color: text }}>
              休暇日 * <span style={{ fontSize: 12, fontWeight: 'normal', color: subText }}>（日付をタップして選択・解除）</span>
            </label>
            <MultiDatePicker
              selectedDates={selectedDates}
              onChange={setSelectedDates}
              isDark={isDark}
            />
            {selectedDates.length > 0 && (
              <div style={{ marginTop: 8, padding: '8px 12px', background: isDark ? '#1b4d1b' : '#d4edda', borderRadius: 6, fontSize: 13, color: isDark ? '#75d475' : '#155724' }}>
                選択中の日付：{selectedDates.join('、')}
              </div>
            )}
          </div>

          {/* 事由（必須） */}
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'block', fontWeight: 'bold', marginBottom: 6, color: text }}>
              事由 * <span style={{ fontSize: 12, fontWeight: 'normal', color: '#dc3545' }}>（必須）</span>
            </label>
            <textarea
              value={purpose}
              onChange={e => setPurpose(e.target.value)}
              placeholder="休暇取得の理由を入力してください"
              rows={3}
              style={{ width: '100%', padding: '10px 14px', border: `1px solid ${borderColor}`, borderRadius: 8, fontSize: 15, boxSizing: 'border-box', resize: 'vertical', background: inputBg, color: text }}
            />
          </div>

          {/* 備考（任意） */}
          <div style={{ marginBottom: 24 }}>
            <label style={{ display: 'block', fontWeight: 'bold', marginBottom: 6, color: text }}>
              備考 <span style={{ fontSize: 12, fontWeight: 'normal', color: subText }}>（任意）</span>
            </label>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="その他、連絡事項があれば入力"
              rows={2}
              style={{ width: '100%', padding: '10px 14px', border: `1px solid ${borderColor}`, borderRadius: 8, fontSize: 15, boxSizing: 'border-box', resize: 'vertical', background: inputBg, color: text }}
            />
          </div>

          <button
            onClick={() => {
              if (!selectedApproverId) { alert('申請先を選んでください'); return; }
              if (selectedDates.length === 0) { alert('休暇日を選択してください'); return; }
              if (!purpose.trim()) { alert('事由を入力してください'); return; }
              if (leaveType === 'その他' && !leaveTypeOther) { alert('種別を入力してください'); return; }
              setShowConfirm(true);
            }}
            style={{ width: '100%', padding: '12px', background: '#28a745', color: 'white', border: 'none', borderRadius: 8, fontSize: 16, fontWeight: 'bold', cursor: 'pointer' }}
          >
            申請内容を確認する
          </button>
        </div>
      )}

      {/* 申請履歴 */}
      {tab === 'history' && (
        <div style={{ padding: 24, background: bg, borderRadius: '0 0 12px 12px', boxShadow: '0 2px 12px rgba(0,0,0,0.1)', boxSizing: 'border-box', width: '100%' }}>
          <h2 style={{ marginBottom: 12, fontSize: 20, color: text }}>📋 休暇申請履歴</h2>

          {/* ── 取得状況 ── */}
          {!loadingHistory && history.length > 0 && (() => {
            const getFY = (dateStr: string) => {
              const d = new Date(dateStr);
              const m = d.getMonth() + 1;
              const y = d.getFullYear();
              return m >= 4 ? y : y - 1;
            };
            type FYData = { pending: number; approved: number };
            // 有給にまとめる種別（バースデーは有給休暇行に合算）
            const YUKYU_MERGE = ['有給休暇', 'バースデー休暇（有給）', '有給'];
            const KEICHO = ['慶弔休暇'];
            // 年度 → { yukyu: {有給休暇, その他各種}, keicho: {慶弔休暇} }
            const fyMap: Record<number, { yukyu: Record<string, FYData>; keicho: Record<string, FYData> }> = {};
            history.forEach(req => {
              if (req.status === 'rejected') return;
              // 特別休暇は旧データのため集計除外
              if (req.leave_type === '特別休暇' || req.leave_type_other === '特別休暇') return;
              const fy = getFY(req.start_date || req.created_at);
              if (!fyMap[fy]) fyMap[fy] = { yukyu: {}, keicho: {} };
              let days = 1;
              try { if (req.leave_dates) days = JSON.parse(req.leave_dates).length || 1; } catch {}
              const isApproved = req.status === 'approved';
              if (YUKYU_MERGE.includes(req.leave_type)) {
                // バースデーも有給休暇行に合算
                const key = '有給休暇';
                if (!fyMap[fy].yukyu[key]) fyMap[fy].yukyu[key] = { pending: 0, approved: 0 };
                if (isApproved) fyMap[fy].yukyu[key].approved += days;
                else fyMap[fy].yukyu[key].pending += days;
              } else if (KEICHO.includes(req.leave_type)) {
                const key = '慶弔休暇';
                if (!fyMap[fy].keicho[key]) fyMap[fy].keicho[key] = { pending: 0, approved: 0 };
                if (isApproved) fyMap[fy].keicho[key].approved += days;
                else fyMap[fy].keicho[key].pending += days;
              } else {
                // その他（病欠など）
                const key = 'その他（病欠など）';
                if (!fyMap[fy].yukyu[key]) fyMap[fy].yukyu[key] = { pending: 0, approved: 0 };
                if (isApproved) fyMap[fy].yukyu[key].approved += days;
                else fyMap[fy].yukyu[key].pending += days;
              }
            });
            const fyList = Object.entries(fyMap).sort(([a], [b]) => Number(b) - Number(a));
            if (fyList.length === 0) return null;

            // 直近2年のキー
            const recentFYs = fyList.slice(0, 2).map(([fy]) => fy);
            const pastFYs = fyList.slice(2);

            const Row = ({ label, data }: { label: string; data: FYData }) => (
              <div style={{ display: 'flex', fontSize: 12, marginBottom: 3, alignItems: 'center' }}>
                <div style={{ flex: 3, color: text, fontSize: 11 }}>{label}</div>
                <div style={{ flex: 1, textAlign: 'center', color: data.pending > 0 ? '#e67e22' : subText, fontWeight: data.pending > 0 ? 'bold' : 'normal' }}>{data.pending > 0 ? `${data.pending}日` : '—'}</div>
                <div style={{ flex: 1, textAlign: 'center', color: data.approved > 0 ? '#28a745' : subText, fontWeight: data.approved > 0 ? 'bold' : 'normal' }}>{data.approved > 0 ? `${data.approved}日` : '—'}</div>
                <div style={{ flex: 1, textAlign: 'center', color: text }}>{data.pending + data.approved > 0 ? `${data.pending + data.approved}日` : '—'}</div>
              </div>
            );

            const FYBlock = ({ fy, yukyu, keicho, defaultOpen }: { fy: string; yukyu: Record<string, FYData>; keicho: Record<string, FYData>; defaultOpen: boolean }) => {
              const fyNum = Number(fy);
              const label = `${fyNum}年度（${fyNum}/4/1 〜 ${fyNum + 1}/3/31）`;
              const isOpen = openFiscalYears[fy] ?? defaultOpen;
              const yukyuTotal: FYData = Object.values(yukyu).reduce((s, v) => ({ pending: s.pending + v.pending, approved: s.approved + v.approved }), { pending: 0, approved: 0 });
              const colHeader = (
                <div style={{ display: 'flex', fontSize: 11, color: subText, marginBottom: 4, borderBottom: `1px solid ${borderColor}`, paddingBottom: 3 }}>
                  <div style={{ flex: 3 }}>種別</div>
                  <div style={{ flex: 1, textAlign: 'center' }}>申請中</div>
                  <div style={{ flex: 1, textAlign: 'center' }}>受理済み</div>
                  <div style={{ flex: 1, textAlign: 'center' }}>合計</div>
                </div>
              );
              return (
                <div style={{ marginBottom: 6, border: `1px solid ${borderColor}`, borderRadius: 8, overflow: 'hidden', boxSizing: 'border-box' }}>
                  <button
                    onClick={() => setOpenFiscalYears(prev => ({ ...prev, [fy]: !isOpen }))}
                    style={{ width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', background: isDark ? '#495057' : '#f0f4f8', border: 'none', cursor: 'pointer' }}
                  >
                    <span style={{ fontSize: 13, fontWeight: 'bold', color: text }}>{label}</span>
                    <span style={{ fontSize: 12, color: subText }}>{isOpen ? '▲' : '▼'}</span>
                  </button>
                  {isOpen && (
                    <div style={{ padding: '10px 12px', background: bg }}>
                      <div style={{ fontSize: 11, fontWeight: 'bold', color: '#28a745', marginBottom: 4 }}>【有給】</div>
                      {colHeader}
                      {Object.entries(yukyu)
                        .sort(([a], [b]) => { if (a === '有給休暇') return -1; if (b === '有給休暇') return 1; if (a.startsWith('その他')) return 1; if (b.startsWith('その他')) return -1; return 0; })
                        .map(([typeName, data]) => <Row key={typeName} label={typeName} data={data} />)}
                      <div style={{ display: 'flex', fontSize: 12, borderTop: `1px solid ${borderColor}`, paddingTop: 4, marginTop: 2, marginBottom: Object.keys(keicho).length > 0 ? 10 : 0 }}>
                        <div style={{ flex: 3, color: text, fontWeight: 'bold', fontSize: 11 }}>有給 合計</div>
                        <div style={{ flex: 1, textAlign: 'center', color: yukyuTotal.pending > 0 ? '#e67e22' : subText, fontWeight: 'bold' }}>{yukyuTotal.pending > 0 ? `${yukyuTotal.pending}日` : '—'}</div>
                        <div style={{ flex: 1, textAlign: 'center', color: yukyuTotal.approved > 0 ? '#28a745' : subText, fontWeight: 'bold' }}>{yukyuTotal.approved > 0 ? `${yukyuTotal.approved}日` : '—'}</div>
                        <div style={{ flex: 1, textAlign: 'center', color: text, fontWeight: 'bold' }}>{yukyuTotal.pending + yukyuTotal.approved > 0 ? `${yukyuTotal.pending + yukyuTotal.approved}日` : '—'}</div>
                      </div>
                      {Object.keys(keicho).length > 0 && (
                        <>
                          <div style={{ fontSize: 11, fontWeight: 'bold', color: subText, marginBottom: 4 }}>【その他の休暇】</div>
                          {colHeader}
                          {Object.entries(keicho).map(([typeName, data]) => <Row key={typeName} label={typeName} data={data} />)}
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            };

            return (
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 12, fontWeight: 'bold', color: subText, marginBottom: 8, textAlign: 'left' }}>【 取得状況 】</div>
                {/* 直近2年：デフォルト閉じる */}
                {recentFYs.map(fy => {
                  const { yukyu, keicho } = fyMap[Number(fy)];
                  return <FYBlock key={fy} fy={fy} yukyu={yukyu} keicho={keicho} defaultOpen={false} />;
                })}
                {/* 過去の年度 */}
                {pastFYs.length > 0 && (
                  <div style={{ marginTop: 4 }}>
                    <button
                      onClick={() => setShowPastYears(v => !v)}
                      style={{ width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', background: isDark ? '#3a3f44' : '#e9ecef', border: `1px solid ${borderColor}`, borderRadius: 8, cursor: 'pointer', marginBottom: showPastYears ? 6 : 0 }}
                    >
                      <span style={{ fontSize: 12, color: subText }}>過去の取得状況</span>
                      <span style={{ fontSize: 12, color: subText }}>{showPastYears ? '▲' : '▼'}</span>
                    </button>
                    {showPastYears && pastFYs.map(([fy, { yukyu, keicho }]) => (
                      <FYBlock key={fy} fy={fy} yukyu={yukyu} keicho={keicho} defaultOpen={false} />
                    ))}
                  </div>
                )}
              </div>
            );
          })()}

          {/* ── 申請一覧 ── */}
          {!loadingHistory && history.length > 0 && (() => {
            const getFY2 = (dateStr: string) => { const d = new Date(dateStr); const m = d.getMonth() + 1; const y = d.getFullYear(); return m >= 4 ? y : y - 1; };
            const fyOptions = [...new Set(history.map(r => String(getFY2(r.start_date || r.created_at))))].sort((a, b) => Number(b) - Number(a));
            return (
              <div style={{ marginBottom: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <div style={{ fontSize: 12, fontWeight: 'bold', color: subText }}>【 申請一覧 】</div>
                  <select
                    value={selectedFY}
                    onChange={e => setSelectedFY(e.target.value)}
                    style={{ padding: '4px 8px', fontSize: 12, border: `1px solid ${borderColor}`, borderRadius: 6, background: inputBg, color: text }}
                  >
                    <option value="all">すべて</option>
                    {fyOptions.map(fy => <option key={fy} value={fy}>{fy}年度</option>)}
                  </select>
                </div>
              </div>
            );
          })()}

          {loadingHistory ? (
            <p style={{ textAlign: 'center', color: subText }}>読み込み中...</p>
          ) : history.length === 0 ? (
            <p style={{ textAlign: 'center', color: subText }}>申請履歴はありません</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {history.filter(req => {
                if (selectedFY === 'all') return true;
                const d = new Date(req.start_date || req.created_at);
                const m = d.getMonth() + 1;
                const y = d.getFullYear();
                const fy = m >= 4 ? y : y - 1;
                return String(fy) === selectedFY;
              }).map(req => {
                // leave_dates があれば使用、なければ start_date/end_date にフォールバック
                let dates: string[] = [];
                try { if (req.leave_dates) dates = JSON.parse(req.leave_dates); } catch {}
                const dayCount = dates.length > 0
                  ? dates.length
                  : Math.max(0, Math.floor((new Date(req.end_date).getTime() - new Date(req.start_date).getTime()) / (1000*60*60*24)) + 1);
                const dateDisplay = dates.length > 0
                  ? (dates.length === 1 ? `${dates[0]}（1日）` : `${dates[0]} ～ ${dates[dates.length-1]}（${dates.length}日）`)
                  : (req.start_date === req.end_date
                    ? `${req.start_date}（1日）`
                    : `${req.start_date} ～ ${req.end_date}（${dayCount}日間）`);

                const st = STATUS_LABEL[req.status] || { label: req.status, color: '#333' };
                const isApproved = req.status === 'approved';
                const isRejected = req.status === 'rejected';
                return (
                  <div
                    key={req.id}
                    style={{
                      padding: '10px 12px', borderRadius: 8,
                      border: `2px solid ${isApproved ? '#28a745' : isRejected ? '#dc3545' : borderColor}`,
                      background: isApproved ? (isDark ? '#1b4d1b' : '#f0fff4') : isRejected ? (isDark ? '#5a1a1a' : '#fff5f5') : (isDark ? '#495057' : '#fafafa'),
                      boxSizing: 'border-box',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4, flexWrap: 'wrap', gap: 4 }}>
                      <div style={{ fontWeight: 'bold', fontSize: 14, color: text }}>
                        {req.leave_type === 'その他' ? req.leave_type_other : req.leave_type}
                      </div>
                      <span style={{
                        padding: '2px 8px', borderRadius: 20, fontSize: 11, fontWeight: 'bold',
                        background: isApproved ? '#28a745' : isRejected ? '#dc3545' : '#e67e22',
                        color: 'white', whiteSpace: 'nowrap',
                      }}>
                        {st.label}
                      </span>
                    </div>
                    {/* 取得日 + 申請日 同じ行 */}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, marginBottom: 2 }}>
                      <span style={{ color: subText }}>{dateDisplay}</span>
                      <span style={{ color: isDark ? '#6c757d' : '#aaa', fontSize: 11 }}>申請日: {new Date(req.created_at).toLocaleDateString('ja-JP')}</span>
                    </div>
                    {/* 申請先 + 受理者 同じ行 */}
                    <div style={{ display: 'flex', gap: 12, fontSize: 12, color: subText, flexWrap: 'wrap' }}>
                      {req.approver && <span>申請先: {req.approver.name}</span>}
                      {req.approver2 && <span>受理者: {req.approver2.name}</span>}
                    </div>
                    {req.purpose && (
                      <div style={{ color: subText, fontSize: 12, marginTop: 2, textAlign: 'left' }}>事由: {req.purpose}</div>
                    )}
                    {req.reason && (
                      <div style={{ color: subText, fontSize: 12, marginTop: 1, textAlign: 'left' }}>備考: {req.reason}</div>
                    )}
                    {isRejected && req.rejected_reason && (
                      <div style={{ marginTop: 4, padding: '4px 8px', background: isDark ? '#721c24' : '#f8d7da', borderRadius: 6, color: isDark ? '#f5c6cb' : '#721c24', fontSize: 12, textAlign: 'left' }}>
                        差し戻し理由: {req.rejected_reason}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

        </div>
      )}

      {/* 確認モーダル */}
      {showConfirm && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div style={{ background: isDark ? '#343a40' : 'white', borderRadius: 12, padding: 24, maxWidth: 440, width: '100%', color: text, maxHeight: '90vh', overflowY: 'auto' }}>
            <h3 style={{ marginBottom: 16, color: text }}>申請内容の確認</h3>
            <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 20 }}>
              <tbody>
                <tr><td style={{ padding: '8px 0', color: subText, width: '30%', verticalAlign: 'top' }}>申請者</td><td style={{ padding: '8px 0', fontWeight: 'bold', color: text }}>{profileName || user.email}</td></tr>
                <tr><td style={{ padding: '8px 0', color: subText, verticalAlign: 'top' }}>申請先</td><td style={{ padding: '8px 0', fontWeight: 'bold', color: text }}>{selectedApprover?.name}（{selectedApprover?.role_title}）</td></tr>
                <tr><td style={{ padding: '8px 0', color: subText, verticalAlign: 'top' }}>休暇種別</td><td style={{ padding: '8px 0', fontWeight: 'bold', color: text }}>{leaveType === 'その他' ? leaveTypeOther : leaveType}</td></tr>
                <tr>
                  <td style={{ padding: '8px 0', color: subText, verticalAlign: 'top' }}>休暇日</td>
                  <td style={{ padding: '8px 0', fontWeight: 'bold', color: '#007bff' }}>
                    {formatSelectedDates(selectedDates)}
                    <div style={{ marginTop: 4, fontSize: 12, color: subText, fontWeight: 'normal' }}>
                      {selectedDates.slice(0, 10).join('、')}{selectedDates.length > 10 ? `…他${selectedDates.length - 10}日` : ''}
                    </div>
                  </td>
                </tr>
                <tr><td style={{ padding: '8px 0', color: subText, verticalAlign: 'top' }}>事由</td><td style={{ padding: '8px 0', color: text }}>{purpose}</td></tr>
                {notes && <tr><td style={{ padding: '8px 0', color: subText, verticalAlign: 'top' }}>備考</td><td style={{ padding: '8px 0', color: text }}>{notes}</td></tr>}
              </tbody>
            </table>
            <div style={{ display: 'flex', gap: 12 }}>
              <button
                onClick={() => setShowConfirm(false)}
                style={{ flex: 1, padding: '10px', background: isDark ? '#495057' : '#f8f9fa', border: `1px solid ${borderColor}`, borderRadius: 8, cursor: 'pointer', fontSize: 15, color: text }}
              >
                修正する
              </button>
              <button
                onClick={handleSubmit}
                disabled={isSubmitting}
                style={{ flex: 1, padding: '10px', background: isSubmitting ? '#6c757d' : '#28a745', color: 'white', border: 'none', borderRadius: 8, cursor: isSubmitting ? 'not-allowed' : 'pointer', fontSize: 15, fontWeight: 'bold' }}
              >
                {isSubmitting ? '送信中...' : '申請する'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default LeaveRequestForm;

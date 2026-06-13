import React, { useState, useEffect } from 'react';

const BannerSuccess: React.FC<{ message: string; onClose: () => void }> = ({ message, onClose }) => {
  useEffect(() => { const t = setTimeout(onClose, 3000); return () => clearTimeout(t); }, [onClose]);
  return (
    <div style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', zIndex: 9999 }}>
      <div style={{ background: '#f0fdf4', border: '1.5px solid #b7e4cc', borderRadius: 18, padding: '24px 28px', minWidth: 200, textAlign: 'center', position: 'relative' }}>
        <button onClick={onClose} style={{ position: 'absolute', top: 10, right: 10, background: 'rgba(21,87,36,0.1)', border: 'none', color: '#155724', borderRadius: '50%', width: 26, height: 26, cursor: 'pointer', fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>✕</button>
        <div style={{ width: 60, height: 60, borderRadius: '50%', background: '#d4edda', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 12px' }}>
          <span style={{ fontSize: 26, color: '#28a745' }}>✓</span>
        </div>
        <div style={{ fontSize: 15, fontWeight: 500, color: '#155724' }}>{message}</div>
      </div>
    </div>
  );
};
import { useNavigate, useSearchParams } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient';
import { sendLeaveSlack } from '../lib/leaveSlack';
import { shouldSend, dispatchEmail, dispatchSiteNotification, getUserEmail } from '../lib/notificationDispatch';
import { insertNotification } from '../lib/notifications';
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
  approver_id?: string | null;
  approver2_id?: string | null;
  approver?: { name: string; role_title: string } | null;
  approver2?: { name: string; role_title: string } | null;
}

type LeaveType = '有給休暇' | 'バースデー休暇（有給）' | '慶弔休暇' | '調整休' | 'その他';

const STATUS_LABEL: Record<string, { label: string; color: string }> = {
  pending:          { label: '確認中（一人目）',      color: '#856404' },
  step2_pending:    { label: '確認中（マネージャー）', color: '#856404' },
  manager_approved: { label: 'マネージャー受理済み',   color: '#0c5460' },
  admin_approved:   { label: '経理受理済み',           color: '#0c5460' },
  approved:         { label: '受理済み',               color: '#155724' },
  rejected:         { label: '差し戻し',               color: '#721c24' },
  cancelled:        { label: '取消済み',               color: '#6c757d' },
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
  const [tab, setTab] = useState<'form' | 'history' | 'adjustment'>(searchParams.get('tab') === 'history' ? 'history' : 'form');

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
  const [reapplySourceId, setReapplySourceId] = useState<string | null>(null);
  // 時間調整フォーム用
  const [adjLateStart, setAdjLateStart] = useState(false);
  const [adjEarlyEnd, setAdjEarlyEnd] = useState(false);
  const [adjDate, setAdjDate] = useState<string>('');
  const [adjLateTime, setAdjLateTime] = useState('');
  const [adjEarlyTime, setAdjEarlyTime] = useState('');
  const [adjReason, setAdjReason] = useState('');
  const [adjApproverMode, setAdjApproverMode] = useState<'select' | 'free'>('select');
  const [adjApproverSelectedId, setAdjApproverSelectedId] = useState('');
  const [adjApproverFree, setAdjApproverFree] = useState('');
  const [adjSubmitting, setAdjSubmitting] = useState(false);
  const [adjBanner, setAdjBanner] = useState(false);
  const [adjError, setAdjError] = useState('');
  const [adjCalYear, setAdjCalYear] = useState(() => new Date().getFullYear());
  const [adjCalMonth, setAdjCalMonth] = useState(() => new Date().getMonth());
  // 調整休専用
  const [choseiSubType, setChoseiSubType] = useState<'furikae' | 'zangyou'>('furikae');
  const [choseiOriginDates, setChoseiOriginDates] = useState<string[]>([]);
  const [encPending, setEncPending] = useState<{ id: string; target_date: string; deadline: string }[]>([]);
  const [encAnsweringId, setEncAnsweringId] = useState<string | null>(null);
  const [encAnswerChoice, setEncAnswerChoice] = useState<number | null>(null);
  const [encAnswerNote, setEncAnswerNote] = useState('');
  const [encAnswerSubmitting, setEncAnswerSubmitting] = useState(false);

  const fetchEncPending = async () => {
    const { data: targets } = await supabase
      .from('paid_leave_encouragement_targets')
      .select('encouragement_day_id')
      .eq('user_id', user.id);
    if (!targets || targets.length === 0) { setEncPending([]); return; }
    const dayIds = targets.map((t: { encouragement_day_id: string }) => t.encouragement_day_id);
    const { data: responses } = await supabase
      .from('paid_leave_encouragement_responses')
      .select('encouragement_day_id')
      .eq('user_id', user.id)
      .in('encouragement_day_id', dayIds);
    const answeredIds = new Set((responses || []).map((r: { encouragement_day_id: string }) => r.encouragement_day_id));
    const unansweredIds = dayIds.filter((id: string) => !answeredIds.has(id));
    if (unansweredIds.length === 0) { setEncPending([]); return; }
    const { data: days } = await supabase
      .from('paid_leave_encouragement_days')
      .select('id, target_date, deadline')
      .in('id', unansweredIds)
      .order('deadline', { ascending: true });
    setEncPending(days || []);
  };

  useEffect(() => { fetchEncPending(); }, [user.id]);

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
  const [adjHistory, setAdjHistory] = useState<{ id: string; date: string; type: string; actual_time: string | null; notes: string | null; created_at: string }[]>([]);
  const [historySubTab, setHistorySubTab] = useState<'leave' | 'adjustment'>('leave');
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
          // 初期選択なし（ユーザーに明示的に選ばせる）
        }
      });
  }, []);

  useEffect(() => {
    if (tab !== 'history') return;
    supabase
      .from('attendance_exceptions')
      .select('id, date, type, actual_time, notes, created_at')
      .eq('user_id', user.id)
      .eq('created_by', user.id)
      .in('type', ['late_start', 'early_end'])
      .order('date', { ascending: false })
      .then(({ data }) => { if (data) setAdjHistory(data); });
  }, [tab, user.id]);

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
      // 調整休の場合、種別と振替元日付を reason に付加
      let reasonValue = notes || null;
      if (leaveType === '調整休') {
        const subLabel = choseiSubType === 'furikae' ? `振替休日（振替元：${choseiOriginDates.join('、')}）` : '時間外調整休';
        reasonValue = [subLabel, notes].filter(Boolean).join(' / ');
      }
      if (reapplySourceId) {
        const reapplyNote = `【再申請】元申請ID: ${reapplySourceId}`;
        reasonValue = reasonValue ? `${reasonValue}　${reapplyNote}` : reapplyNote;
      }
      const { error } = await supabase.from('leave_requests').insert({
        user_id: user.id,
        leave_type: leaveType,
        leave_type_other: leaveType === 'その他' ? leaveTypeOther : null,
        leave_dates: JSON.stringify(selectedDates),
        start_date: startDate,
        end_date: endDate,
        purpose: purpose,
        reason: reasonValue,
        status: 'pending',
        current_approver: 'first',
        approver_id: selectedApproverId,
      });
      if (error) throw error;
      // 再申請の場合、元申請を取消済みにする
      if (reapplySourceId) {
        await supabase.from('leave_requests').update({ status: 'cancelled' }).eq('id', reapplySourceId);
        setReapplySourceId(null);
      }
      await supabase.from('profiles').update({ leave_request_enabled: false, leave_enabled_by: null }).eq('id', user.id);
      // Slack通知（申請先の役職に応じてチャンネルを切り替え）
      if (selectedApprover && await shouldSend('leave:new_request', 'slack')) {
        await sendLeaveSlack('new_request', selectedApprover.name, selectedApprover.role_title);
      }
      // サイト通知・メール（申請者 or 承認者）
      const vars = { 申請者名: profileName || user.email || '', 休暇種別: leaveType, 申請日数: String(selectedDates.length) };
      const applicantEmail = user.email || '';
      const leaderEmail = selectedApprover ? (await getUserEmail(selectedApprover.id) ?? '') : '';
      await dispatchSiteNotification('leave:new_request', vars, { applicant: user.id, leader: selectedApprover?.id }, insertNotification);
      await dispatchEmail('leave:new_request', vars, { applicant: applicantEmail, leader: leaderEmail, approver: leaderEmail });
      // TODO: 申請フォーム送信後の追加処理（例：奨励日との照合・連携）をここに追加
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
    setChoseiSubType('furikae');
    setChoseiOriginDates([]);
    setReapplySourceId(null);
    // 初期選択なし（ユーザーに明示的に選ばせる）
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

  const encAnsweringDay = encPending.find(d => d.id === encAnsweringId) || null;

  const encBannerList = encPending.map(d => {
    const today = new Date().toISOString().slice(0, 10);
    const deadlineDate = new Date(d.deadline + 'Z');
    const todayDate = new Date(today + 'T00:00:00Z');
    const diffDays = Math.round((deadlineDate.getTime() - todayDate.getTime()) / 86400000);
    const dateLabel = `${Number(d.deadline.slice(5,7))}月${Number(d.deadline.slice(8,10))}日`;
    let msg: string;
    if (diffDays > 3) msg = `📅 有給奨励日の回答をお願いします（期限：${dateLabel}）`;
    else if (diffDays === 3) msg = `⚠️ 有給奨励日の回答期限まで3日です`;
    else if (diffDays === 2) msg = `⚠️ 有給奨励日の回答期限まで2日です`;
    else if (diffDays === 1) msg = `⚠️ 有給奨励日の回答期限まで1日です`;
    else if (diffDays === 0) msg = `🔴 本日が回答期限です！`;
    else msg = `❗ 有給奨励日の回答が未完了です`;
    return { ...d, msg, diffDays };
  });

  const encAnswerModal = encAnsweringDay ? (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 3000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ background: isDark ? '#343a40' : '#fff', borderRadius: 16, padding: 24, width: '100%', maxWidth: 420, boxSizing: 'border-box' }}>
        <h3 style={{ margin: '0 0 4px', color: text, fontSize: 16 }}>📅 有給奨励日への回答</h3>
        <p style={{ margin: '0 0 16px', fontSize: 13, color: subText }}>対象日: {(() => { const d = new Date(encAnsweringDay.target_date + 'T00:00:00Z'); return `${d.getUTCFullYear()}年${d.getUTCMonth()+1}月${d.getUTCDate()}日(${['日','月','火','水','木','金','土'][d.getUTCDay()]})`; })()}　期限: {(() => { const d = new Date(encAnsweringDay.deadline + 'T00:00:00Z'); return `${d.getUTCFullYear()}年${d.getUTCMonth()+1}月${d.getUTCDate()}日(${['日','月','火','水','木','金','土'][d.getUTCDay()]})`; })()}</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
          {([1, 2, 3, 4] as const).map(n => {
            const labels: Record<number, string> = { 1: '有給休暇', 2: '欠勤（調整休）', 3: '定休日', 4: 'その他' };
            const colors: Record<number, string> = { 1: '#28a745', 2: '#fd7e14', 3: '#17a2b8', 4: '#6c757d' };
            const selected = encAnswerChoice === n;
            return (
              <button key={n} onClick={() => setEncAnswerChoice(n)} style={{
                padding: '12px 16px', borderRadius: 10, border: selected ? `2px solid ${colors[n]}` : `1px solid ${isDark ? '#6c757d' : '#dee2e6'}`,
                background: selected ? colors[n] : (isDark ? '#495057' : '#f8f9fa'),
                color: selected ? '#fff' : text, fontSize: 14, fontWeight: selected ? 'bold' : 'normal', cursor: 'pointer', textAlign: 'left',
              }}>{labels[n]}</button>
            );
          })}
        </div>
        {encAnswerChoice === 4 && (
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 12, color: subText, display: 'block', marginBottom: 4 }}>備考（必須）</label>
            <textarea value={encAnswerNote} onChange={e => setEncAnswerNote(e.target.value)} rows={3}
              style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: `1px solid ${isDark ? '#6c757d' : '#ccc'}`, background: inputBg, color: text, fontSize: 13, resize: 'vertical', boxSizing: 'border-box' }}
              placeholder="詳細を入力してください" />
          </div>
        )}
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={() => { setEncAnsweringId(null); setEncAnswerChoice(null); setEncAnswerNote(''); }}
            style={{ flex: 1, padding: '10px 0', background: isDark ? '#495057' : '#e9ecef', color: text, border: 'none', borderRadius: 10, cursor: 'pointer', fontSize: 13 }}>キャンセル</button>
          <button disabled={!encAnswerChoice || (encAnswerChoice === 4 && !encAnswerNote.trim()) || encAnswerSubmitting}
            onClick={async () => {
              if (!encAnswerChoice) return;
              if (encAnswerChoice === 4 && !encAnswerNote.trim()) return;
              setEncAnswerSubmitting(true);
              await supabase.from('paid_leave_encouragement_responses').insert({
                encouragement_day_id: encAnsweringDay.id,
                user_id: user.id,
                choice: encAnswerChoice,
                note: encAnswerNote.trim() || null,
              });
              // TODO: 申請フォーム送信時と同じ追加処理をここで行う
              {
                const encLeaveType = encAnswerChoice === 1 ? '有給休暇' : encAnswerChoice === 2 ? '調整休' : 'その他';
                const encLeaveTypeOther = encAnswerChoice === 3 ? '定休日' : encAnswerChoice === 4 ? (encAnswerNote.trim() || 'その他') : undefined;
                await supabase.from('leave_requests').insert({
                  user_id: user.id,
                  leave_type: encLeaveType,
                  ...(encLeaveTypeOther ? { leave_type_other: encLeaveTypeOther } : {}),
                  leave_dates: JSON.stringify([encAnsweringDay.target_date]),
                  start_date: encAnsweringDay.target_date,
                  end_date: encAnsweringDay.target_date,
                  purpose: '有給奨励日',
                  reason: '【有給奨励日】',
                  status: 'approved',
                  current_approver: 'none',
                });
              }
              setEncAnswerSubmitting(false);
              setEncAnsweringId(null); setEncAnswerChoice(null); setEncAnswerNote('');
              fetchEncPending();
            }}
            style={{ flex: 2, padding: '10px 0', background: encAnswerSubmitting ? '#6c757d' : '#28a745', color: '#fff', border: 'none', borderRadius: 10, cursor: encAnswerSubmitting ? 'default' : 'pointer', fontSize: 13, fontWeight: 'bold' }}>
            {encAnswerSubmitting ? '送信中...' : '回答を送信'}
          </button>
        </div>
      </div>
    </div>
  ) : null;

  return (
    <div style={{ maxWidth: 600, width: '100%', margin: '20px auto', padding: '0 12px', boxSizing: 'border-box' }}>
      {encAnswerModal}
      {encBannerList.map(d => (
        <div key={d.id} onClick={() => { setEncAnsweringId(d.id); setEncAnswerChoice(null); setEncAnswerNote(''); }}
          style={{
            cursor: 'pointer', marginBottom: 8, padding: '10px 14px', borderRadius: 10,
            background: d.diffDays <= 0 ? '#dc3545' : d.diffDays <= 1 ? '#fd7e14' : d.diffDays <= 3 ? '#ffc107' : '#007bff',
            color: '#fff', fontSize: 13, fontWeight: 'bold', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            boxShadow: '0 2px 6px rgba(0,0,0,0.15)',
          }}>
          <span>{d.msg}　（対象日: {(() => { const dt = new Date(d.target_date + 'T00:00:00Z'); return `${dt.getUTCFullYear()}年${dt.getUTCMonth()+1}月${dt.getUTCDate()}日(${['日','月','火','水','木','金','土'][dt.getUTCDay()]})`; })()}）</span>
          <span style={{ fontSize: 11, opacity: 0.85 }}>タップして回答 →</span>
        </div>
      ))}
      {/* タブ切替 */}
      <div style={{ display: 'flex', marginBottom: 0, borderRadius: '10px 10px 0 0', overflow: 'hidden', boxShadow: '0 2px 8px rgba(0,0,0,0.08)' }}>
        <button
          onClick={() => { setTab('form'); window.scrollTo({ top: 0, left: 0, behavior: 'instant' as ScrollBehavior }); document.documentElement.scrollTop = 0; document.body.scrollTop = 0; }}
          style={{ flex: 1, padding: '12px', background: tab === 'form' ? '#28a745' : (isDark ? '#495057' : '#f8f9fa'), color: tab === 'form' ? 'white' : text, border: 'none', cursor: 'pointer', fontSize: 15, fontWeight: tab === 'form' ? 'bold' : 'normal' }}
        >
          🌿 休暇
        </button>
        <button
          onClick={() => { setTab('adjustment'); window.scrollTo({ top: 0, left: 0, behavior: 'instant' as ScrollBehavior }); document.documentElement.scrollTop = 0; document.body.scrollTop = 0; }}
          style={{ flex: 1, padding: '12px', background: tab === 'adjustment' ? '#28a745' : (isDark ? '#495057' : '#f8f9fa'), color: tab === 'adjustment' ? 'white' : text, border: 'none', cursor: 'pointer', fontSize: 15, fontWeight: tab === 'adjustment' ? 'bold' : 'normal', borderLeft: `1px solid ${isDark ? '#6c757d' : '#dee2e6'}` }}
        >
          🕐 時間調整
        </button>
        {!leaveRequestEnabled && (
          <button
            onClick={() => { setTab('history'); window.scrollTo({ top: 0, left: 0, behavior: 'instant' as ScrollBehavior }); document.documentElement.scrollTop = 0; document.body.scrollTop = 0; }}
            style={{ flex: 1, padding: '12px', background: tab === 'history' ? '#28a745' : (isDark ? '#495057' : '#f8f9fa'), color: tab === 'history' ? 'white' : text, border: 'none', cursor: 'pointer', fontSize: 15, fontWeight: tab === 'history' ? 'bold' : 'normal', borderLeft: `1px solid ${isDark ? '#6c757d' : '#dee2e6'}` }}
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

          {/* 再申請バナー */}
          {reapplySourceId && (
            <div style={{ background: isDark ? '#0d3a5e' : '#cce5ff', border: `1px solid ${isDark ? '#1a6fa8' : '#b8daff'}`, borderRadius: 8, padding: '10px 14px', marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontWeight: 'bold', fontSize: 13, color: isDark ? '#90c9f5' : '#004085' }}>🔄 再申請モード</div>
                <div style={{ fontSize: 12, color: isDark ? '#adb5bd' : '#555', marginTop: 2 }}>差し戻された申請の内容がセットされています。修正して申請してください。送信すると元の申請は自動で取消済みになります。</div>
              </div>
              <button onClick={() => { handleReset(); }} style={{ marginLeft: 12, padding: '4px 10px', background: 'transparent', border: `1px solid ${isDark ? '#90c9f5' : '#004085'}`, borderRadius: 6, color: isDark ? '#90c9f5' : '#004085', fontSize: 11, cursor: 'pointer', whiteSpace: 'nowrap' }}>
                キャンセル
              </button>
            </div>
          )}

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
            <label style={{ display: 'block', fontWeight: 'bold', marginBottom: 6, color: text }}>申請先 <span style={{ color: '#dc3545' }}>*</span></label>
            {approvers.length === 0 ? (
              <div style={{ padding: '10px 14px', background: '#fff3cd', borderRadius: 8, color: '#856404', fontSize: 14 }}>
                承認者が登録されていません
              </div>
            ) : (
              <select
                value={selectedApproverId}
                onChange={e => setSelectedApproverId(e.target.value)}
                style={{ width: '100%', padding: '10px 14px', border: `1px solid ${borderColor}`, borderRadius: 8, fontSize: 15, background: inputBg, color: selectedApproverId ? text : subText }}
              >
                <option value="" disabled>申請先を選択してください</option>
                {approvers.map(a => (
                  <option key={a.id} value={a.id}>{a.name}（{a.role_title}）</option>
                ))}
              </select>
            )}
          </div>

          {/* 休暇種別 */}
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'block', fontWeight: 'bold', marginBottom: 6, color: text }}>休暇種別 <span style={{ color: '#dc3545' }}>*</span></label>
            <select
              value={leaveType}
              onChange={e => { setLeaveType(e.target.value as LeaveType); setPurpose(''); }}
              style={{ width: '100%', padding: '10px 14px', border: `1px solid ${borderColor}`, borderRadius: 8, fontSize: 15, background: inputBg, color: text }}
            >
              <option value="有給休暇">有給休暇</option>
              <option value="バースデー休暇（有給）">バースデー休暇（有給）</option>
              <option value="慶弔休暇">慶弔休暇</option>
              <option value="調整休">調整休</option>
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
            {leaveType === '調整休' && (
              <div style={{ marginTop: 12, padding: 14, background: isDark ? '#2a2f35' : '#f8f9ff', borderRadius: 8, border: `1px solid ${isDark ? '#495057' : '#c8d6f0'}` }}>
                <div style={{ fontWeight: 'bold', fontSize: 14, color: text, marginBottom: 10 }}>調整休の種類 <span style={{ color: '#dc3545' }}>*</span></div>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, cursor: 'pointer', color: text }}>
                  <input type="radio" name="choseiSubType" value="furikae" checked={choseiSubType === 'furikae'} onChange={() => { setChoseiSubType('furikae'); setPurpose(''); }} />
                  <span>振替休日 <span style={{ fontSize: 12, color: subText }}>（休日出勤・特定日の振替）</span></span>
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', color: text }}>
                  <input type="radio" name="choseiSubType" value="zangyou" checked={choseiSubType === 'zangyou'} onChange={() => { setChoseiSubType('zangyou'); setPurpose(''); }} />
                  <span>時間外調整休 <span style={{ fontSize: 12, color: subText }}>（勤務調整のため取得）</span></span>
                </label>

                {choseiSubType === 'furikae' && (
                  <div style={{ marginTop: 12 }}>
                    <label style={{ display: 'block', fontSize: 14, fontWeight: 'bold', marginBottom: 6, color: text }}>
                      振替元の勤務日 <span style={{ color: '#dc3545' }}>*</span> <span style={{ fontSize: 12, fontWeight: 'normal', color: subText }}>（日付をタップして選択・解除）</span>
                    </label>
                    <MultiDatePicker
                      selectedDates={choseiOriginDates}
                      onChange={setChoseiOriginDates}
                      isDark={isDark}
                    />
                    {choseiOriginDates.length > 0 && (
                      <div style={{ marginTop: 8, padding: '8px 12px', background: isDark ? '#1b4d1b' : '#d4edda', borderRadius: 6, fontSize: 13, color: isDark ? '#75d475' : '#155724' }}>
                        選択中の日付：{choseiOriginDates.join('、')}
                      </div>
                    )}
                    <label style={{ display: 'block', fontSize: 14, fontWeight: 'bold', marginTop: 12, marginBottom: 6, color: text }}>
                      理由 <span style={{ color: '#dc3545' }}>*</span>
                    </label>
                    <textarea
                      value={purpose}
                      onChange={e => setPurpose(e.target.value)}
                      placeholder="〇〇により休日出勤したため"
                      rows={2}
                      style={{ width: '100%', padding: '10px 14px', border: `1px solid ${borderColor}`, borderRadius: 8, fontSize: 14, boxSizing: 'border-box', resize: 'vertical', background: inputBg, color: text }}
                    />
                    <button
                      type="button"
                      onClick={() => setPurpose('〇〇により休日出勤したため')}
                      style={{ marginTop: 6, fontSize: 12, padding: '4px 12px', border: '1px solid #29b6f6', borderRadius: 6, background: '#e1f5fe', color: '#0277bd', cursor: 'pointer' }}
                    >
                      文例を使う → 「〇〇により休日出勤したため」
                    </button>
                  </div>
                )}
                {choseiSubType === 'zangyou' && (
                  <div style={{ marginTop: 12 }}>
                    <label style={{ display: 'block', fontSize: 14, fontWeight: 'bold', marginBottom: 6, color: text }}>
                      理由 <span style={{ color: '#dc3545' }}>*</span>
                    </label>
                    <textarea
                      value={purpose}
                      onChange={e => setPurpose(e.target.value)}
                      placeholder="〇〇イベント準備により時間外労働が発生したため"
                      rows={2}
                      style={{ width: '100%', padding: '10px 14px', border: `1px solid ${borderColor}`, borderRadius: 8, fontSize: 14, boxSizing: 'border-box', resize: 'vertical', background: inputBg, color: text }}
                    />
                    <button
                      type="button"
                      onClick={() => setPurpose('〇〇イベント準備により時間外労働が発生したため')}
                      style={{ marginTop: 6, fontSize: 12, padding: '4px 12px', border: '1px solid #29b6f6', borderRadius: 6, background: '#e1f5fe', color: '#0277bd', cursor: 'pointer' }}
                    >
                      文例を使う → 「〇〇イベント準備により時間外労働が発生したため」
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* 休暇日 カレンダー */}
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'block', fontWeight: 'bold', marginBottom: 6, color: text }}>
              休暇日 <span style={{ color: '#dc3545' }}>*</span> <span style={{ fontSize: 12, fontWeight: 'normal', color: subText }}>（日付をタップして選択・解除）</span>
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

          {/* 事由（必須）調整休は専用欄を使うため非表示 */}
          {leaveType !== '調整休' && <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'block', fontWeight: 'bold', marginBottom: 6, color: text }}>
              事由 <span style={{ color: '#dc3545' }}>*</span>
            </label>
            <textarea
              value={purpose}
              onChange={e => setPurpose(e.target.value)}
              placeholder="休暇取得の理由を入力してください"
              rows={3}
              style={{ width: '100%', padding: '10px 14px', border: `1px solid ${borderColor}`, borderRadius: 8, fontSize: 15, boxSizing: 'border-box', resize: 'vertical', background: inputBg, color: text }}
            />
          </div>}

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
              if (leaveType === '調整休' && choseiSubType === 'furikae' && choseiOriginDates.length === 0) { alert('振替元の勤務日を選択してください'); return; }
              if (leaveType === '調整休' && choseiSubType === 'furikae' && choseiOriginDates.length !== selectedDates.length) { alert(`振替元の勤務日（${choseiOriginDates.length}日）と休暇日（${selectedDates.length}日）の日数が一致していません`); return; }
              if (!purpose.trim() && leaveType !== '調整休') { alert('事由を入力してください'); return; }
              if (leaveType === '調整休' && !purpose.trim()) { alert('理由を入力してください'); return; }
              if (leaveType === 'その他' && !leaveTypeOther) { alert('種別を入力してください'); return; }
              setShowConfirm(true);
            }}
            style={{ width: '100%', padding: '12px', background: '#28a745', color: 'white', border: 'none', borderRadius: 8, fontSize: 16, fontWeight: 'bold', cursor: 'pointer' }}
          >
            申請内容を確認する
          </button>
        </div>
      )}

      {/* 時間調整フォーム */}
      {tab === 'adjustment' && (() => {
        const today = new Date();
        const todayStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
        const daysInMonth = new Date(adjCalYear, adjCalMonth + 1, 0).getDate();
        const firstDow = new Date(adjCalYear, adjCalMonth, 1).getDay();
        const HOURS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'));
        const MINS = ['00', '05', '10', '15', '20', '25', '30', '35', '40', '45', '50', '55'];
        const fmtDate = (y: number, m: number, d: number) => `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
        const adjDateLabel = adjDate ? `${parseInt(adjDate.slice(5,7))}月${parseInt(adjDate.slice(8,10))}日（${'日月火水木金土'[new Date(adjDate).getDay()]}）` : '';

        const handleAdjSubmit = async () => {
          setAdjError('');
          if (!adjLateStart && !adjEarlyEnd) { setAdjError('種別を選択してください'); return; }
          if (!adjDate) { setAdjError('日付を選択してください'); return; }
          if (adjDate < todayStr) { setAdjError('当日より前の日付は登録できません'); return; }
          if (adjLateStart && adjEarlyEnd) {
            const [lh, lm] = adjLateTime.split(':').map(Number);
            const [eh, em] = adjEarlyTime.split(':').map(Number);
            if (lh * 60 + lm >= eh * 60 + em) { setAdjError('遅出時刻は早退時刻より前にしてください'); return; }
          }
          if (adjLateStart && !adjLateTime) { setAdjError('調整遅出の出勤時刻を選択してください'); return; }
          if (adjEarlyEnd && !adjEarlyTime) { setAdjError('調整早退の退勤時刻を選択してください'); return; }
          if (!adjReason.trim()) { setAdjError('理由を入力してください'); return; }
          setAdjSubmitting(true);
          try {
            const approverName = adjApproverMode === 'select'
              ? (approvers.find(a => a.id === adjApproverSelectedId)?.name ?? '')
              : adjApproverFree.trim();
            const notesVal = approverName ? `【了承者】${approverName}　${adjReason.trim()}` : adjReason.trim();
            const records: { user_id: string; date: string; type: string; actual_time: string; notes: string; created_by: string }[] = [];
            if (adjLateStart) records.push({ user_id: user.id, date: adjDate, type: 'late_start', actual_time: adjLateTime, notes: notesVal, created_by: user.id });
            if (adjEarlyEnd)  records.push({ user_id: user.id, date: adjDate, type: 'early_end',  actual_time: adjEarlyTime, notes: notesVal, created_by: user.id });
            const { data: inserted, error: err } = await supabase.from('attendance_exceptions').insert(records).select('id, type, date, actual_time');
            if (err) {
              if (err.code === '23505') { setAdjError('この日付・種別はすでに登録済みです'); }
              else { setAdjError('保存に失敗しました: ' + err.message); }
              setAdjSubmitting(false);
              return;
            }
            // gcal-sync
            for (const rec of inserted ?? []) {
              try {
                await supabase.functions.invoke('gcal-sync', {
                  body: { action: 'upsert', source_type: 'absence', source_id: rec.id, dates: [rec.date], name: profileName ?? '', absence_type: rec.type, time: rec.actual_time ? rec.actual_time.slice(0, 5) : undefined },
                });
              } catch (e) { console.error('[gcal-sync] 時間調整書き込み失敗:', e); }
            }
            // 通知 Edge Function
            try {
              await supabase.functions.invoke('time-adjustment-notify', {
                body: { user_id: user.id, user_name: profileName ?? '', date: adjDate, types: records.map(r => r.type), reason: adjReason.trim() },
              });
            } catch (e) { console.error('[time-adjustment-notify] 通知失敗:', e); }
            // リセット＆バナー
            setAdjLateStart(false); setAdjEarlyEnd(false);
            setAdjDate(''); setAdjLateTime(''); setAdjEarlyTime('');
            setAdjReason(''); setAdjApproverSelectedId(''); setAdjApproverFree('');
            setAdjBanner(true);
          } finally {
            setAdjSubmitting(false);
          }
        };

        const calCells: (number | null)[] = [];
        for (let i = 0; i < firstDow; i++) calCells.push(null);
        for (let d = 1; d <= daysInMonth; d++) calCells.push(d);

        return (
          <div style={{ padding: 20, background: bg, borderRadius: '0 0 12px 12px', boxShadow: '0 2px 12px rgba(0,0,0,0.1)', boxSizing: 'border-box', width: '100%' }}>
            {/* 登録完了バナー */}
            {adjBanner && (
              <BannerSuccess message="登録しました" onClose={() => setAdjBanner(false)} />
            )}

            {/* info-box */}
            <div style={{ background: isDark ? '#1a3a4a' : '#e8f4fd', border: `1px solid ${isDark ? '#2a6a8a' : '#bee5eb'}`, borderRadius: 10, padding: '12px 14px', marginBottom: 14 }}>
              <div style={{ fontWeight: 'bold', fontSize: 13, color: isDark ? '#90d0f0' : '#0c4a6e', marginBottom: 6 }}>自己登録（申請不要）</div>
              <div style={{ fontSize: 12, color: isDark ? '#a8cfe8' : '#0e5a8a', lineHeight: 1.7 }}>
                時間調整は承認フローがありません。登録するとGoogleカレンダーにも反映されます。<br />
                <span style={{ opacity: 0.85 }}>※ 有給休暇などの休暇申請とは異なり、承認待ちにはなりません。</span><br />
                <span style={{ opacity: 0.85 }}>※ 登録の取り消しはリーダー・マネージャーまたは経理担当者へご連絡ください。</span>
              </div>
            </div>

            {/* 注意文 */}
            <div style={{ background: isDark ? '#3a2e00' : '#fff8e1', borderLeft: '4px solid #f59e0b', borderRadius: '0 8px 8px 0', padding: '10px 14px', marginBottom: 18, fontSize: 13, color: isDark ? '#ffd54f' : '#92400e', lineHeight: 1.6 }}>
              ⚠️ 事前にフロア責任者・リーダー（マネージャー）へ必ず相談し、了承を得てから登録してください
            </div>

            {/* 種別 */}
            <div style={{ marginBottom: 18 }}>
              <label style={{ display: 'block', fontWeight: 'bold', marginBottom: 8, color: text, fontSize: 14 }}>種別 <span style={{ color: '#dc3545' }}>*</span> <span style={{ fontSize: 11, fontWeight: 'normal', color: subText }}>（複数選択可）</span></label>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                {/* 調整遅出 */}
                <div
                  onClick={() => setAdjLateStart(v => !v)}
                  style={{ border: adjLateStart ? '2px solid #28a745' : `1px solid ${borderColor}`, borderRadius: 10, padding: 12, cursor: 'pointer', background: adjLateStart ? (isDark ? '#1b4d1b' : '#f0fff4') : bg }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: adjLateStart ? 10 : 0 }}>
                    <div style={{ width: 16, height: 16, borderRadius: 4, border: adjLateStart ? 'none' : `1.5px solid ${borderColor}`, background: adjLateStart ? '#28a745' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                      {adjLateStart && <span style={{ color: '#fff', fontSize: 11, lineHeight: 1 }}>✓</span>}
                    </div>
                    <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#4caf50', flexShrink: 0, display: 'inline-block' }} />
                    <span style={{ fontSize: 14, fontWeight: 'bold', color: text }}>調整遅出</span>
                  </div>
                  {adjLateStart && (
                    <div onClick={e => e.stopPropagation()}>
                      <label style={{ fontSize: 12, color: subText, marginBottom: 4, display: 'block' }}>出勤時刻 <span style={{ color: '#dc3545' }}>*</span></label>
                      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                        <select value={adjLateTime.split(':')[0] ?? ''} onChange={e => setAdjLateTime(e.target.value + ':' + (adjLateTime.split(':')[1] || '00'))}
                          style={{ flex: 1, padding: '6px 4px', borderRadius: 6, border: `1px solid ${!adjLateTime ? '#dc3545' : borderColor}`, fontSize: 13, background: inputBg, color: text }}>
                          <option value="" disabled>時</option>
                          {HOURS.map(h => <option key={h} value={h}>{h}</option>)}
                        </select>
                        <span style={{ color: subText, fontSize: 12 }}>時</span>
                        <select value={adjLateTime.split(':')[1] ?? ''} onChange={e => setAdjLateTime((adjLateTime.split(':')[0] || '09') + ':' + e.target.value)}
                          style={{ flex: 1, padding: '6px 4px', borderRadius: 6, border: `1px solid ${!adjLateTime ? '#dc3545' : borderColor}`, fontSize: 13, background: inputBg, color: text }}>
                          <option value="" disabled>分</option>
                          {MINS.map(m => <option key={m} value={m}>{m}</option>)}
                        </select>
                        <span style={{ color: subText, fontSize: 12 }}>分</span>
                      </div>
                    </div>
                  )}
                </div>
                {/* 調整早退 */}
                <div
                  onClick={() => setAdjEarlyEnd(v => !v)}
                  style={{ border: adjEarlyEnd ? '2px solid #28a745' : `1px solid ${borderColor}`, borderRadius: 10, padding: 12, cursor: 'pointer', background: adjEarlyEnd ? (isDark ? '#1b4d1b' : '#f0fff4') : bg }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: adjEarlyEnd ? 10 : 0 }}>
                    <div style={{ width: 16, height: 16, borderRadius: 4, border: adjEarlyEnd ? 'none' : `1.5px solid ${borderColor}`, background: adjEarlyEnd ? '#28a745' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                      {adjEarlyEnd && <span style={{ color: '#fff', fontSize: 11, lineHeight: 1 }}>✓</span>}
                    </div>
                    <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#9c27b0', flexShrink: 0, display: 'inline-block' }} />
                    <span style={{ fontSize: 14, fontWeight: 'bold', color: text }}>調整早退</span>
                  </div>
                  {adjEarlyEnd && (
                    <div onClick={e => e.stopPropagation()}>
                      <label style={{ fontSize: 12, color: subText, marginBottom: 4, display: 'block' }}>退勤時刻 <span style={{ color: '#dc3545' }}>*</span></label>
                      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                        <select value={adjEarlyTime.split(':')[0] ?? ''} onChange={e => setAdjEarlyTime(e.target.value + ':' + (adjEarlyTime.split(':')[1] || '00'))}
                          style={{ flex: 1, padding: '6px 4px', borderRadius: 6, border: `1px solid ${!adjEarlyTime ? '#dc3545' : borderColor}`, fontSize: 13, background: inputBg, color: text }}>
                          <option value="" disabled>時</option>
                          {HOURS.map(h => <option key={h} value={h}>{h}</option>)}
                        </select>
                        <span style={{ color: subText, fontSize: 12 }}>時</span>
                        <select value={adjEarlyTime.split(':')[1] ?? ''} onChange={e => setAdjEarlyTime((adjEarlyTime.split(':')[0] || '17') + ':' + e.target.value)}
                          style={{ flex: 1, padding: '6px 4px', borderRadius: 6, border: `1px solid ${!adjEarlyTime ? '#dc3545' : borderColor}`, fontSize: 13, background: inputBg, color: text }}>
                          <option value="" disabled>分</option>
                          {MINS.map(m => <option key={m} value={m}>{m}</option>)}
                        </select>
                        <span style={{ color: subText, fontSize: 12 }}>分</span>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* 日付カレンダー */}
            <div style={{ marginBottom: 18 }}>
              <label style={{ display: 'block', fontWeight: 'bold', marginBottom: 8, color: text, fontSize: 14 }}>
                日付 <span style={{ color: '#dc3545' }}>*</span> <span style={{ fontSize: 11, fontWeight: 'normal', color: subText }}>（日付をタップして選択・当日以降のみ）</span>
              </label>
              <div style={{ background: isDark ? '#495057' : '#f8f9fa', borderRadius: 10, padding: 12, border: `1px solid ${borderColor}` }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <button onClick={() => { if (adjCalMonth === 0) { setAdjCalYear(y => y-1); setAdjCalMonth(11); } else setAdjCalMonth(m => m-1); }}
                    style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: text, padding: '0 10px', lineHeight: 1 }}>‹</button>
                  <span style={{ fontWeight: 'bold', color: text, fontSize: 15 }}>{adjCalYear}年 {adjCalMonth+1}月</span>
                  <button onClick={() => { if (adjCalMonth === 11) { setAdjCalYear(y => y+1); setAdjCalMonth(0); } else setAdjCalMonth(m => m+1); }}
                    style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: text, padding: '0 10px', lineHeight: 1 }}>›</button>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2, marginBottom: 4 }}>
                  {['日','月','火','水','木','金','土'].map((d, i) => (
                    <div key={d} style={{ textAlign: 'center', fontSize: 11, fontWeight: 'bold', color: i === 0 ? '#e74c3c' : i === 6 ? '#3498db' : text, padding: '3px 0' }}>{d}</div>
                  ))}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2 }}>
                  {calCells.map((d, i) => {
                    if (d === null) return <div key={i} />;
                    const ds = fmtDate(adjCalYear, adjCalMonth, d);
                    const isPast = ds < todayStr;
                    const isSelected = ds === adjDate;
                    const dow = (firstDow + d - 1) % 7;
                    const color = dow === 0 ? '#e74c3c' : dow === 6 ? '#3498db' : text;
                    return (
                      <button
                        key={i}
                        onClick={() => !isPast && setAdjDate(ds)}
                        disabled={isPast}
                        style={{
                          padding: '6px 2px', textAlign: 'center', fontSize: 13, border: 'none', cursor: isPast ? 'default' : 'pointer', borderRadius: 6,
                          background: isSelected ? '#28a745' : 'transparent',
                          color: isSelected ? '#fff' : isPast ? (isDark ? '#6c757d' : '#ccc') : color,
                          fontWeight: ds === todayStr ? 'bold' : 'normal',
                          outline: ds === todayStr && !isSelected ? `2px solid #28a745` : 'none',
                        }}
                      >{d}</button>
                    );
                  })}
                </div>
              </div>
              {adjDate && (
                <div style={{ marginTop: 8, padding: '8px 12px', background: isDark ? '#1b4d1b' : '#d4edda', borderRadius: 6, fontSize: 13, color: isDark ? '#75d475' : '#155724' }}>
                  選択中：{adjDateLabel}
                </div>
              )}
            </div>

            {/* 了承者（任意） */}
            <div style={{ marginBottom: 18 }}>
              <label style={{ display: 'block', fontWeight: 'bold', marginBottom: 8, color: text, fontSize: 14 }}>
                了承者 <span style={{ fontSize: 11, fontWeight: 'normal', color: subText }}>（任意）</span>
              </label>
              <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                <button onClick={() => setAdjApproverMode('select')}
                  style={{ flex: 1, padding: '7px 0', borderRadius: 6, border: `1px solid ${adjApproverMode === 'select' ? '#28a745' : borderColor}`, background: adjApproverMode === 'select' ? (isDark ? '#1b4d1b' : '#f0fff4') : bg, color: adjApproverMode === 'select' ? '#28a745' : text, cursor: 'pointer', fontSize: 13, fontWeight: adjApproverMode === 'select' ? 'bold' : 'normal' }}>
                  リストから選択
                </button>
                <button onClick={() => setAdjApproverMode('free')}
                  style={{ flex: 1, padding: '7px 0', borderRadius: 6, border: `1px solid ${adjApproverMode === 'free' ? '#28a745' : borderColor}`, background: adjApproverMode === 'free' ? (isDark ? '#1b4d1b' : '#f0fff4') : bg, color: adjApproverMode === 'free' ? '#28a745' : text, cursor: 'pointer', fontSize: 13, fontWeight: adjApproverMode === 'free' ? 'bold' : 'normal' }}>
                  直接入力
                </button>
              </div>
              {adjApproverMode === 'select' ? (
                <select value={adjApproverSelectedId} onChange={e => setAdjApproverSelectedId(e.target.value)}
                  style={{ width: '100%', padding: '10px 14px', border: `1px solid ${borderColor}`, borderRadius: 8, fontSize: 14, background: inputBg, color: adjApproverSelectedId ? text : subText }}>
                  <option value="">了承者を選択（任意）</option>
                  {approvers.map(a => <option key={a.id} value={a.id}>{a.name}（{a.role_title}）</option>)}
                </select>
              ) : (
                <input type="text" value={adjApproverFree} onChange={e => setAdjApproverFree(e.target.value)}
                  placeholder="了承者名を入力（任意）"
                  style={{ width: '100%', padding: '10px 14px', border: `1px solid ${borderColor}`, borderRadius: 8, fontSize: 14, background: inputBg, color: text, boxSizing: 'border-box' }} />
              )}
            </div>

            {/* 理由 */}
            <div style={{ marginBottom: 24 }}>
              <label style={{ display: 'block', fontWeight: 'bold', marginBottom: 8, color: text, fontSize: 14 }}>理由 <span style={{ color: '#dc3545' }}>*</span></label>
              <textarea
                value={adjReason}
                onChange={e => setAdjReason(e.target.value)}
                placeholder="〇〇により時間外労働が発生したため"
                rows={3}
                style={{ width: '100%', padding: '10px 14px', border: `1px solid ${borderColor}`, borderRadius: 8, fontSize: 14, boxSizing: 'border-box', resize: 'vertical', background: inputBg, color: text }}
              />
              <button type="button" onClick={() => setAdjReason('〇〇により時間外労働が発生したため')}
                style={{ marginTop: 6, fontSize: 12, padding: '6px 14px', border: `1px solid #29b6f6`, borderRadius: 6, background: isDark ? '#0d3a5e' : '#e1f5fe', color: isDark ? '#90caf9' : '#0277bd', cursor: 'pointer', width: '100%' }}>
                文例を使う ー「〇〇により時間外労働が発生したため」
              </button>
            </div>

            {adjError && (
              <div style={{ marginBottom: 12, padding: '10px 14px', background: isDark ? '#5a1a1a' : '#f8d7da', borderRadius: 8, color: isDark ? '#f5c6cb' : '#721c24', fontSize: 13 }}>
                {adjError}
              </div>
            )}

            <button
              onClick={handleAdjSubmit}
              disabled={adjSubmitting}
              style={{ width: '100%', padding: '13px', background: adjSubmitting ? '#6c757d' : '#28a745', color: 'white', border: 'none', borderRadius: 8, fontSize: 16, fontWeight: 'bold', cursor: adjSubmitting ? 'not-allowed' : 'pointer' }}
            >
              {adjSubmitting ? '登録中...' : '登録する'}
            </button>
          </div>
        );
      })()}

      {/* 申請履歴 */}
      {tab === 'history' && (
        <div style={{ padding: 24, background: bg, borderRadius: '0 0 12px 12px', boxShadow: '0 2px 12px rgba(0,0,0,0.1)', boxSizing: 'border-box', width: '100%' }}>
          <h2 style={{ marginBottom: 12, fontSize: 20, color: text }}>📋 申請履歴</h2>

          {/* ── 履歴サブタブ ── */}
          <div style={{ display: 'flex', marginBottom: 16, borderRadius: 8, overflow: 'hidden', border: `1px solid ${borderColor}` }}>
            <button onClick={() => setHistorySubTab('leave')}
              style={{ flex: 1, padding: '9px 0', background: historySubTab === 'leave' ? '#28a745' : (isDark ? '#495057' : '#f8f9fa'), color: historySubTab === 'leave' ? '#fff' : text, border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: historySubTab === 'leave' ? 'bold' : 'normal' }}>
              🌿 休暇申請
            </button>
            <button onClick={() => setHistorySubTab('adjustment')}
              style={{ flex: 1, padding: '9px 0', background: historySubTab === 'adjustment' ? '#28a745' : (isDark ? '#495057' : '#f8f9fa'), color: historySubTab === 'adjustment' ? '#fff' : text, border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: historySubTab === 'adjustment' ? 'bold' : 'normal', borderLeft: `1px solid ${borderColor}` }}>
              🕐 時間調整
            </button>
          </div>

          {/* ── 時間調整履歴 ── */}
          {historySubTab === 'adjustment' && (() => {
            const getFY = (d: string) => { const dt = new Date(d); const m = dt.getMonth()+1; const y = dt.getFullYear(); return m >= 4 ? y : y - 1; };
            const fyList = [...new Set(adjHistory.map(r => String(getFY(r.date))))].sort((a,b) => Number(b)-Number(a));
            const adjFY = adjHistory.length > 0 && !fyList.includes(String(selectedFY))
              ? fyList[0]
              : String(selectedFY);
            const filtered = adjHistory.filter(r => String(getFY(r.date)) === adjFY);
            const months = [...new Set(filtered.map(r => r.date.slice(0,7)))].sort((a,b) => b.localeCompare(a));
            return (
              <div>
                {adjHistory.length === 0 ? (
                  <div style={{ textAlign: 'center', color: subText, fontSize: 14, padding: '24px 0' }}>時間調整の記録はありません</div>
                ) : (
                  <>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
                      {fyList.map(fy => (
                        <button key={fy} onClick={() => setSelectedFY(fy)}
                          style={{ padding: '5px 12px', borderRadius: 999, border: `1px solid ${adjFY === fy ? '#28a745' : borderColor}`, fontSize: 12, background: adjFY === fy ? '#28a745' : bg, color: adjFY === fy ? '#fff' : text, cursor: 'pointer', fontWeight: adjFY === fy ? 'bold' : 'normal' }}>
                          {fy}年度
                        </button>
                      ))}
                    </div>
                    {filtered.length === 0 ? (
                      <div style={{ textAlign: 'center', color: subText, fontSize: 14, padding: '16px 0' }}>この年度の記録はありません</div>
                    ) : (
                      months.map(ym => {
                        const recs = filtered.filter(r => r.date.slice(0,7) === ym);
                        const [y, m] = ym.split('-');
                        return (
                          <div key={ym} style={{ marginBottom: 14 }}>
                            <div style={{ fontSize: 12, fontWeight: 'bold', color: subText, borderBottom: `1px solid ${borderColor}`, paddingBottom: 5, marginBottom: 8 }}>
                              {y}年 {parseInt(m)}月
                            </div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                              {recs.map(rec => {
                                const typeLabel = rec.type === 'late_start' ? '調整遅出' : '調整早退';
                                const dotColor = rec.type === 'late_start' ? '#4caf50' : '#9c27b0';
                                const dateStr = `${parseInt(rec.date.slice(5,7))}月${parseInt(rec.date.slice(8,10))}日（${'日月火水木金土'[new Date(rec.date).getDay()]}）`;
                                const timeLabel = rec.actual_time ? `　${rec.type === 'late_start' ? '出勤' : '退勤'}：${rec.actual_time}` : '';
                                return (
                                  <div key={rec.id} style={{ padding: '10px 12px', borderRadius: 8, border: `1px solid ${borderColor}`, background: bg }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
                                      <span style={{ width: 9, height: 9, borderRadius: '50%', background: dotColor, flexShrink: 0, display: 'inline-block' }} />
                                      <span style={{ fontWeight: 'bold', fontSize: 13, color: text }}>{typeLabel}</span>
                                      <span style={{ marginLeft: 'auto', fontSize: 11, color: subText }}>{new Date(rec.created_at).toLocaleDateString('ja-JP')} 登録</span>
                                    </div>
                                    <div style={{ fontSize: 12, color: subText, paddingLeft: 17 }}>{dateStr}{timeLabel}</div>
                                    {rec.notes && <div style={{ fontSize: 11, color: subText, marginTop: 2, paddingLeft: 17 }}>{rec.notes}</div>}
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })
                    )}
                  </>
                )}
              </div>
            );
          })()}

          {historySubTab === 'leave' && (<>

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
              if (req.status === 'rejected' || req.status === 'cancelled') return;
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
                {/* 選択年度の有給サマリー */}
                {selectedFY !== 'all' && (() => {
                  const filtered = history.filter(req => {
                    if (req.status === 'rejected' || req.status === 'cancelled') return false;
                    const d = new Date(req.start_date || req.created_at);
                    const fy = (d.getMonth() + 1) >= 4 ? d.getFullYear() : d.getFullYear() - 1;
                    return String(fy) === selectedFY && ['有給休暇', 'バースデー休暇（有給）', '有給'].includes(req.leave_type);
                  });
                  let pending = 0, approved = 0;
                  filtered.forEach(req => {
                    let days = 1;
                    try { if (req.leave_dates) days = JSON.parse(req.leave_dates).length || 1; } catch {}
                    if (req.status === 'approved') approved += days;
                    else pending += days;
                  });
                  return (
                    <div style={{ marginTop: 8, padding: '10px 14px', background: isDark ? '#1a2e1a' : '#f0fff4', border: `1px solid ${isDark ? '#2d5a2d' : '#c3e6cb'}`, borderRadius: 8, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 12, fontWeight: 'bold', color: isDark ? '#75d475' : '#155724' }}>🌿 有給取得状況（{selectedFY}年度）</span>
                      <span style={{ fontSize: 12, color: isDark ? '#d0e8d0' : '#1e5631' }}>確認中：<strong>{pending}日</strong></span>
                      <span style={{ fontSize: 12, color: isDark ? '#d0e8d0' : '#1e5631' }}>受理済み：<strong>{approved}日</strong></span>
                      <span style={{ fontSize: 12, color: isDark ? '#d0e8d0' : '#1e5631' }}>合計：<strong>{pending + approved}日</strong></span>
                    </div>
                  );
                })()}
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
                const isCancelled = req.status === 'cancelled';
                return (
                  <div
                    key={req.id}
                    style={{
                      padding: '10px 12px', borderRadius: 8,
                      border: `2px solid ${isApproved ? '#28a745' : isRejected ? '#dc3545' : isCancelled ? '#6c757d' : borderColor}`,
                      background: isApproved ? (isDark ? '#1b4d1b' : '#f0fff4') : isRejected ? (isDark ? '#5a1a1a' : '#fff5f5') : isCancelled ? (isDark ? '#343a40' : '#f8f9fa') : (isDark ? '#495057' : '#fafafa'),
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
                    {isRejected && (
                      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                        <button onClick={async () => {
                          if (!window.confirm('この申請を取り消しますか？')) return;
                          await supabase.from('leave_requests').update({ status: 'cancelled' }).eq('id', req.id);
                          setHistory(h => h.map(r => r.id === req.id ? { ...r, status: 'cancelled' } : r));
                        }} style={{ flex: 1, padding: '6px 0', background: '#6c757d', color: '#fff', border: 'none', borderRadius: 8, fontSize: 12, fontWeight: 'bold', cursor: 'pointer' }}>
                          取消
                        </button>
                        <button onClick={() => {
                          // フォームに元申請の内容をセットしてフォームタブへ
                          setLeaveType((req.leave_type as LeaveType) || '有給休暇');
                          setLeaveTypeOther(req.leave_type_other || '');
                          try { setSelectedDates(req.leave_dates ? JSON.parse(req.leave_dates) : []); } catch { setSelectedDates([]); }
                          setPurpose(req.purpose || '');
                          if (req.approver_id) setSelectedApproverId(req.approver_id);
                          // 再申請元のIDを備考に埋め込む（送信時に追記）
                          setReapplySourceId(req.id);
                          setTab('form');
                          window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
                        }} style={{ flex: 1, padding: '6px 0', background: '#007bff', color: '#fff', border: 'none', borderRadius: 8, fontSize: 12, fontWeight: 'bold', cursor: 'pointer' }}>
                          再申請
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          </>)}

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

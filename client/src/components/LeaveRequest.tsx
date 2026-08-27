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
import { fetchLatestCorrectionByTarget } from '../lib/correctionRequest';
import type { CorrectionRequestRow } from '../lib/correctionRequest';
import CorrectionBadgeAndButton from './CorrectionBadgeAndButton';
import { PageTabs } from './PageTabs';
import HelpLinkButton from './HelpLinkButton';
import { shouldSend, dispatchEmail, dispatchSiteNotification, getUserEmail } from '../lib/notificationDispatch';
import { insertNotification } from '../lib/notifications';
import { useDarkMode } from '../hooks/useDarkMode';
import { useFocusHighlight } from '../hooks/useFocusHighlight';
import { useLeavePendingCount } from '../hooks/useLeavePendingCount';
import { todayJstStr } from '../lib/breakCalc';
import type { CalendarKind } from '../lib/breakCalc';
import { useCompanyCalendar, CALENDAR_CELL_STYLE, CALENDAR_NOTICE } from '../hooks/useCompanyCalendar';
import { DRAFT_KEYS, loadDraft, saveDraft, clearDraft } from '../lib/draftStorage';
import type { AuthUser, AdminLeaveRequest } from '../types';
import { normalizeTime } from '../lib/timeInput';
import TimeInput from './TimeInput';

// 休暇申請フォームの下書き
interface LeaveDraft {
  leaveType: LeaveType; leaveTypeOther: string; selectedDates: string[];
  dateLocations: Record<string, string>; purpose: string; notes: string;
  choseiSubType: 'furikae' | 'zangyou'; choseiOriginDates: string[];
  originLocations: Record<string, string>; selectedApproverId: string;
}
// 時間調整フォームの下書き
interface AdjDraft {
  adjLateStart: boolean; adjEarlyEnd: boolean; adjDate: string;
  adjLateTime: string; adjEarlyTime: string; adjReason: string; adjLocation: string;
  adjApproverMode: 'select' | 'free'; adjApproverSelectedId: string; adjApproverFree: string;
}

interface Props {
  user: AuthUser;
  profileName: string | null;
  roleTitle: string;
  leaveRequestEnabled?: boolean;
  onSubmitSuccess?: () => void;
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
  leave_locations: string | null;
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
  calendarKinds?: Record<string, CalendarKind>;
}> = ({ selectedDates, onChange, isDark, calendarKinds }) => {
  const today = new Date();
  const [viewYear, setViewYear] = useState(today.getFullYear());
  const [viewMonth, setViewMonth] = useState(today.getMonth());
  const [rangeError, setRangeError] = useState(''); // 2か月超選択のインラインエラー（alert廃止）

  const text = isDark ? '#fff' : '#333';
  const borderColor = isDark ? '#6c757d' : '#ddd';

  const getDaysInMonth = (y: number, m: number) => new Date(y, m + 1, 0).getDate();
  const getFirstDayOfWeek = (y: number, m: number) => new Date(y, m, 1).getDay();
  const fmt = (y: number, m: number, d: number) =>
    `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

  const toggleDate = (dateStr: string) => {
    setRangeError('');
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
          setRangeError('2か月を超える期間は選択できません（例：5月と7月の同時選択は不可）');
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
  // 月によって週の数が変わると高さが変わり、下のボタンや「‹ ›」の位置が動く。常に6週間ぶんにする
  while (cells.length < 42) cells.push(null);

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
          // 会社カレンダー（休館日・出勤日）。選択中の緑が優先されるので、選んだ日は今までどおり
          const ck = calendarKinds?.[dateStr];
          const cs = ck ? CALENDAR_CELL_STYLE[ck] : null;
          return (
            <button
              key={dateStr}
              onClick={() => toggleDate(dateStr)}
              title={cs ? CALENDAR_NOTICE[ck as CalendarKind] : undefined}
              style={{
                padding: '10px 2px',
                minHeight: 40,
                borderRadius: 6,
                border: isToday ? '2px solid #007bff' : '1px solid transparent',
                background: isSelected ? '#28a745' : cs ? cs.bg : 'transparent',
                color: isSelected ? 'white' : cs ? cs.text : isSun ? '#e74c3c' : isSat ? '#3498db' : text,
                cursor: 'pointer',
                fontSize: 13,
                fontWeight: isSelected ? 'bold' : 'normal',
                textAlign: 'center',
                lineHeight: 1.2,
              }}
            >
              {day}
              {cs && <div style={{ fontSize: 8, fontWeight: 'bold', color: isSelected ? 'rgba(255,255,255,0.9)' : cs.text }}>{cs.short}</div>}
            </button>
          );
        })}
      </div>
      {rangeError && (
        <div style={{ marginTop: 8, fontSize: 12, color: '#dc3545', background: '#fff5f5', border: `1px solid ${'#f5b5b5'}`, borderRadius: 6, padding: '6px 10px' }}>⚠️ {rangeError}</div>
      )}
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

// 日付の短い表示（7/2（木））
const shortDateLabel = (d: string): string =>
  `${parseInt(d.slice(5, 7))}/${parseInt(d.slice(8, 10))}（${'日月火水木金土'[new Date(d + 'T00:00:00').getDay()]}）`;

// 日付ごとの校選択リスト（1日1行）。休暇日と振替元の勤務日で共用。
// 選択済み日付の一覧表示を兼ねる（緑の「選択中の日付」枠の置き換え）。
const DateLocationPicker: React.FC<{
  dates: string[];
  locations: Record<string, string>;
  workplaces: string[];
  bulk: string;
  onBulk: (v: string) => void;
  onSelect: (date: string, v: string) => void;
  isDark: boolean;
}> = ({ dates, locations, workplaces, bulk, onBulk, onSelect, isDark }) => {
  const text = isDark ? '#fff' : '#333';
  const subText = isDark ? '#adb5bd' : '#666';
  const inputBg = isDark ? '#495057' : 'white';
  const borderColor = isDark ? '#6c757d' : '#ddd';
  if (dates.length === 0) return null;
  const sorted = [...dates].sort();
  return (
    <div style={{ marginTop: 8 }}>
      {dates.length > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, padding: '8px 12px', background: isDark ? '#3d4349' : '#f4f7fb', borderRadius: 8 }}>
          <span style={{ fontSize: 13, color: subText, flexShrink: 0 }}>すべて同じ校にする：</span>
          <select
            value={bulk}
            onChange={e => onBulk(e.target.value)}
            style={{ flex: 1, padding: '8px 10px', border: `1px solid ${borderColor}`, borderRadius: 8, fontSize: 14, background: inputBg, color: text }}
          >
            <option value="">選択してください</option>
            {workplaces.map(w => <option key={w} value={w}>{w}</option>)}
          </select>
        </div>
      )}
      <div style={{ border: `1px solid ${borderColor}`, borderRadius: 8, overflow: 'hidden' }}>
        {sorted.map((d, i) => {
          const missing = !locations[d];
          return (
            <div key={d} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderTop: i > 0 ? `1px solid ${borderColor}` : 'none', background: missing ? (isDark ? '#4a2b30' : '#fdecea') : 'transparent' }}>
              <span style={{ fontSize: 13, color: text, fontWeight: missing ? 'bold' : 'normal', flexShrink: 0, minWidth: 74 }}>{shortDateLabel(d)}</span>
              <select
                value={locations[d] ?? ''}
                onChange={e => onSelect(d, e.target.value)}
                style={{ flex: 1, padding: '8px 10px', border: `1px solid ${missing ? '#e24b4a' : borderColor}`, borderRadius: 8, fontSize: 14, background: inputBg, color: text }}
              >
                <option value="">選択してください</option>
                {workplaces.map(w => <option key={w} value={w}>{w}</option>)}
              </select>
            </div>
          );
        })}
      </div>
    </div>
  );
};

// ---- メインコンポーネント ----
const LeaveRequestForm: React.FC<Props> = ({ user, profileName, roleTitle: _roleTitle = '', leaveRequestEnabled, onSubmitSuccess }) => {
  const navigate = useNavigate();
  // 会社カレンダー（休館日・出勤日）。カレンダーの色分けと、選んだあとの注意書きに使う
  const calendarKinds = useCompanyCalendar();
  const [searchParams] = useSearchParams();
  const tabParam = searchParams.get('tab');
  const focusParam = searchParams.get('focus');
  const [tab, setTab] = useState<'form' | 'history' | 'adjustment'>(tabParam === 'history' ? 'history' : 'form');
  // 🚨 同じページを開いたまま通知をタップされたときも履歴タブに切り替える。
  // 画面は作り直されないので、開いた瞬間の1回だけでは切り替わらない。
  // 依存はURLの「値」なので、画面内のタブ操作（URLは変わらない）とは干渉しない
  useEffect(() => {
    if (tabParam === 'history') setTab('history');
  }, [tabParam, focusParam]);

  // 入力中の下書きを端末に自動保存し、開き直したら復元する
  const [ld] = useState(() => loadDraft<LeaveDraft>(DRAFT_KEYS.leave));
  const [ad] = useState(() => loadDraft<AdjDraft>(DRAFT_KEYS.leaveAdjustment));
  const [leaveType, setLeaveType] = useState<LeaveType>(ld?.leaveType ?? '有給休暇');
  const [leaveTypeOther, setLeaveTypeOther] = useState(ld?.leaveTypeOther ?? '');
  const [selectedDates, setSelectedDates] = useState<string[]>(ld?.selectedDates ?? []);
  // 校（勤務校）：日付ごとに選択。カレンダーのタイトルに［校名］で表示される
  const [workplaces, setWorkplaces] = useState<string[]>([]);
  const [dateLocations, setDateLocations] = useState<Record<string, string>>(ld?.dateLocations ?? {});
  const [bulkLocation, setBulkLocation] = useState('');
  const [locError, setLocError] = useState(''); // 入力エラーのインライン表示（複数行を\n区切りで保持・alertは使わない）
  const [errFields, setErrFields] = useState<Set<string>>(new Set()); // 赤ハイライトする入力欄のキー集合
  // 振替元の勤務日の校（調整休・振替休日のみ。日付→校）
  const [originLocations, setOriginLocations] = useState<Record<string, string>>(ld?.originLocations ?? {});
  const [originBulkLocation, setOriginBulkLocation] = useState('');
  const [purpose, setPurpose] = useState(ld?.purpose ?? '');
  const [notes, setNotes] = useState(ld?.notes ?? '');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null); // 送信失敗のモーダル内インラインエラー（alert廃止）
  const [showConfirm, setShowConfirm] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [approvers, setApprovers] = useState<Approver[]>([]);
  const [selectedApproverId, setSelectedApproverId] = useState(ld?.selectedApproverId ?? '');
  const [showApproverGuide, setShowApproverGuide] = useState(false);
  const [leaderAssignments, setLeaderAssignments] = useState<{ id: string; course: string; school: string; leader: string; manager: string }[]>([]);
  const [loadingAssignments, setLoadingAssignments] = useState(true);
  const [reapplySourceId, setReapplySourceId] = useState<string | null>(null);
  // 未承認(pending)の自分の申請を本人が編集中：対象ID。insertでなくedit_own_leave RPCで更新する
  const [editLeaveId, setEditLeaveId] = useState<string | null>(null);
  // 本人取消のインライン確認（window.confirm禁止のためカード内で確認）
  const [cancelConfirmId, setCancelConfirmId] = useState<string | null>(null);
  const [cancelingId, setCancelingId] = useState<string | null>(null);
  // 時間調整フォーム用
  const [adjLateStart, setAdjLateStart] = useState(ad?.adjLateStart ?? false);
  const [adjEarlyEnd, setAdjEarlyEnd] = useState(ad?.adjEarlyEnd ?? false);
  const [adjDate, setAdjDate] = useState<string>(ad?.adjDate ?? '');
  const [adjLateTime, setAdjLateTime] = useState(ad?.adjLateTime ?? '');
  const [adjEarlyTime, setAdjEarlyTime] = useState(ad?.adjEarlyTime ?? '');
  const [adjReason, setAdjReason] = useState(ad?.adjReason ?? '');
  const [adjApproverMode, setAdjApproverMode] = useState<'select' | 'free'>(ad?.adjApproverMode ?? 'select');
  const [adjApproverSelectedId, setAdjApproverSelectedId] = useState(ad?.adjApproverSelectedId ?? '');
  const [adjApproverFree, setAdjApproverFree] = useState(ad?.adjApproverFree ?? '');
  const [adjSubmitting, setAdjSubmitting] = useState(false);
  const [adjBanner, setAdjBanner] = useState(false);
  const [adjError, setAdjError] = useState('');
  const [adjLocation, setAdjLocation] = useState(ad?.adjLocation ?? ''); // 時間調整の校（必須）
  const [adjCalYear, setAdjCalYear] = useState(() => new Date().getFullYear());
  const [adjCalMonth, setAdjCalMonth] = useState(() => new Date().getMonth());
  // 調整休専用
  const [choseiSubType, setChoseiSubType] = useState<'furikae' | 'zangyou'>(ld?.choseiSubType ?? 'furikae');
  const [choseiOriginDates, setChoseiOriginDates] = useState<string[]>(ld?.choseiOriginDates ?? []);
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

  // 休暇申請フォームの下書きを自動保存
  useEffect(() => {
    saveDraft(DRAFT_KEYS.leave, { leaveType, leaveTypeOther, selectedDates, dateLocations, purpose, notes, choseiSubType, choseiOriginDates, originLocations, selectedApproverId });
  }, [leaveType, leaveTypeOther, selectedDates, dateLocations, purpose, notes, choseiSubType, choseiOriginDates, originLocations, selectedApproverId]);
  // 時間調整フォームの下書きを自動保存
  useEffect(() => {
    saveDraft(DRAFT_KEYS.leaveAdjustment, { adjLateStart, adjEarlyEnd, adjDate, adjLateTime, adjEarlyTime, adjReason, adjLocation, adjApproverMode, adjApproverSelectedId, adjApproverFree });
  }, [adjLateStart, adjEarlyEnd, adjDate, adjLateTime, adjEarlyTime, adjReason, adjLocation, adjApproverMode, adjApproverSelectedId, adjApproverFree]);

  useEffect(() => {
    supabase
      .from('leader_assignments')
      .select('id, course, school, leader, manager')
      .order('display_order', { ascending: true })
      .then(({ data, error }) => {
        if (!error && data) setLeaderAssignments(data);
        setLoadingAssignments(false);
      });
    // 校（勤務地マスタ。勤務変更報告と同じ選択肢）
    supabase.from('master_options').select('value').eq('category', 'workplace').order('sort_order')
      .then(({ data }) => { if (data) setWorkplaces(data.map((r: { value: string }) => r.value)); });
  }, []);

  const [history, setHistory] = useState<LeaveRecord[]>([]);
  // 通知バナーから ?focus=<申請ID> で来たとき履歴の該当カードを強調
  const { highlightId, focusRef } = useFocusHighlight(history);
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
      .in('role_title', ['リーダー', 'マネージャー', 'フロア責任者'])
      .eq('is_active', true)
      .order('name')
      .then(({ data, error }) => {
        if (!error && data) {
          // リーダー→マネージャー→フロア責任者の順（ShiftReportPageの報告先と同じ並び）
          const ord: Record<string, number> = { 'リーダー': 0, 'マネージャー': 1, 'フロア責任者': 2 };
          setApprovers([...data].sort((a, b) => (ord[a.role_title] ?? 9) - (ord[b.role_title] ?? 9) || a.name.localeCompare(b.name, 'ja')));
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
          leave_locations: (r as { leave_locations?: string | null }).leave_locations ?? null,
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

  // 各申請に紐づく最新の修正依頼（修正依頼中/対応済みバッジ用）
  const [corrections, setCorrections] = useState<Map<string, CorrectionRequestRow>>(new Map());
  const reloadCorrections = React.useCallback(() => {
    const ids = history.map(h => h.id);
    if (ids.length === 0) { setCorrections(new Map()); return; }
    fetchLatestCorrectionByTarget('leave', ids).then(setCorrections);
  }, [history]);
  useEffect(() => { reloadCorrections(); }, [reloadCorrections]);

  // 本人が未承認/差戻しの自分の申請を取り消す（承認前のみDB側で保証）
  const doCancelLeave = async (id: string) => {
    setCancelingId(id);
    const { error } = await supabase.rpc('cancel_own_leave', { p_id: id });
    setCancelingId(null);
    setCancelConfirmId(null);
    if (error) { console.error('[cancel_own_leave]', error); return; }
    setHistory(h => h.map(r => r.id === id ? { ...r, status: 'cancelled' } : r));
  };

  // 未承認の自分の申請をフォームに読み込んで編集モードにする
  const startEditLeave = (req: LeaveRecord) => {
    setLeaveType((req.leave_type as LeaveType) || '有給休暇');
    setLeaveTypeOther(req.leave_type_other || '');
    try { setSelectedDates(req.leave_dates ? JSON.parse(req.leave_dates) : []); } catch { setSelectedDates([]); }
    try { if (req.leave_locations) setDateLocations(JSON.parse(req.leave_locations)); } catch { /* 校の復元失敗は無視 */ }
    setPurpose(req.purpose || '');
    setNotes(req.reason || '');
    if (req.approver_id) setSelectedApproverId(req.approver_id);
    setReapplySourceId(null);
    setEditLeaveId(req.id);
    setTab('form');
    window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
  };

  // 休暇申請の「申請先」はリーダー・マネージャーのみ（フロア責任者は時間調整の了承者としてのみ選択可）
  const leaveApprovers = approvers.filter(a => a.role_title !== 'フロア責任者');
  const selectedApprover = approvers.find(a => a.id === selectedApproverId);

  const handleSubmit = async () => {
    setSubmitError(null);
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
      // 未承認の自分の申請を編集：insertでなくRPCで更新（承認前のみDB側で保証）
      if (editLeaveId) {
        const { error: editErr } = await supabase.rpc('edit_own_leave', {
          p_id: editLeaveId,
          p_leave_type: leaveType,
          p_leave_type_other: leaveType === 'その他' ? leaveTypeOther : null,
          p_leave_dates: JSON.stringify(selectedDates),
          p_leave_locations: JSON.stringify(Object.fromEntries(selectedDates.map(d => [d, dateLocations[d]]))),
          p_purpose: purpose,
          p_reason: reasonValue,
          p_start_date: startDate,
          p_end_date: endDate,
          // 調整休の種類。これが 'zangyou' でないと受理時に残業台帳へマイナス行が作られない
          p_chosei_sub_type: leaveType === '調整休' ? choseiSubType : null,
        });
        if (editErr) throw editErr;
        setEditLeaveId(null);
        setSubmitted(true);
        setShowConfirm(false);
        clearDraft(DRAFT_KEYS.leave);
        setIsSubmitting(false);
        return;
      }
      const { data: newRequest, error } = await supabase.from('leave_requests').insert({
        user_id: user.id,
        leave_type: leaveType,
        leave_type_other: leaveType === 'その他' ? leaveTypeOther : null,
        leave_dates: JSON.stringify(selectedDates),
        leave_locations: JSON.stringify(Object.fromEntries(selectedDates.map(d => [d, dateLocations[d]]))),
        // 🚨 調整休の種類は必ずこの列に入れる。
        // 受理されたとき sync_overtime_from_leave トリガーが
        // 「leave_type='調整休' かつ chosei_sub_type='zangyou'」で残業台帳にマイナス行を作る。
        // 以前は reason の文章に「時間外調整休」と書くだけで列に入れておらず、
        // 時間外調整休を取っても残業の合計時間数が1分も減らなかった
        chosei_sub_type: leaveType === '調整休' ? choseiSubType : null,
        // 振替元の勤務日の校（調整休・振替休日のみ。日付はreasonの文章、校はこの列と役割を分ける）
        chosei_origin_locations: (leaveType === '調整休' && choseiSubType === 'furikae' && choseiOriginDates.length > 0)
          ? JSON.stringify(Object.fromEntries(choseiOriginDates.map(d => [d, originLocations[d]])))
          : null,
        start_date: startDate,
        end_date: endDate,
        purpose: purpose,
        reason: reasonValue,
        status: 'pending',
        current_approver: 'first',
        approver_id: selectedApproverId,
      }).select('id').single();
      if (error) throw error;
      // 再申請の場合、元申請を取消済みにする
      if (reapplySourceId) {
        await supabase.from('leave_requests').update({ status: 'cancelled' }).eq('id', reapplySourceId);
        setReapplySourceId(null);
      }
      // 🚨 直接UPDATEしない。profiles の直接更新はRLSで管理者のみに絞ってあるため、
      //    本人が自分の分を閉じるための RPC 経由にする（2026-08-10）
      await supabase.rpc('clear_own_leave_request_enabled');
      // Slack通知（申請先の役職に応じてチャンネルを切り替え）
      if (selectedApprover && await shouldSend('leave:new_request', 'slack')) {
        await sendLeaveSlack('new_request', selectedApprover.name, selectedApprover.role_title);
      }
      // サイト通知・メール（申請者 or 承認者）
      const vars = { 申請者名: profileName || user.email || '', 休暇種別: leaveType, 申請日数: String(selectedDates.length), リンク: 'https://fivem-portal.vercel.app/leave-approvals' };
      const applicantEmail = user.email || '';
      const leaderEmail = selectedApprover ? (await getUserEmail(selectedApprover.id) ?? '') : '';
      // leave:new_request は承認者(要対応)のみが対象（申請者向け変数が無いため、宛先設定にapplicantは無い）
      // 🚨 申請先は「その申請の相手」。役職によって leader / manager のどちらにもなりうるので
      // 両方＋approverキーに同じ人を渡す。approver を渡していなかったため、宛先設定が
      // 「申請先（承認者）」のときサイト通知が誰にも届いていなかった
      const apprKey = selectedApprover?.role_title === 'マネージャー' ? 'manager' : 'leader';
      await dispatchSiteNotification('leave:new_request', vars, { applicant: user.id, [apprKey]: selectedApprover?.id, approver: selectedApprover?.id }, insertNotification, 'leave_request:pending_approval', newRequest?.id);
      await dispatchEmail('leave:new_request', vars, { applicant: applicantEmail, [apprKey]: leaderEmail, approver: leaderEmail });
      // TODO: 申請フォーム送信後の追加処理（例：奨励日との照合・連携）をここに追加
      setSubmitted(true);
      setShowConfirm(false);
      clearDraft(DRAFT_KEYS.leave); // 送信成功で下書きを消す
    } catch (err: unknown) {
      setSubmitError('送信に失敗しました。' + (err instanceof Error ? err.message : JSON.stringify(err)));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleReset = () => {
    setLeaveType('有給休暇');
    setLeaveTypeOther('');
    setSelectedDates([]);
    setDateLocations({});
    setBulkLocation('');
    setOriginLocations({});
    setOriginBulkLocation('');
    setLocError('');
    setPurpose('');
    setNotes('');
    setSubmitted(false);
    setChoseiSubType('furikae');
    setChoseiOriginDates([]);
    setReapplySourceId(null);
    // 初期選択なし（ユーザーに明示的に選ばせる）
  };

  // 休暇申請フォームのクリア（入力内容をすべて空にして下書きも消す）
  const clearLeaveForm = () => {
    handleReset();
    setSelectedApproverId('');
    clearDraft(DRAFT_KEYS.leave);
  };
  // 時間調整フォームのクリア
  const clearAdjForm = () => {
    setAdjLateStart(false); setAdjEarlyEnd(false);
    setAdjDate(''); setAdjLateTime(''); setAdjEarlyTime('');
    setAdjLocation(''); setAdjReason('');
    setAdjApproverMode('select'); setAdjApproverSelectedId(''); setAdjApproverFree('');
    setAdjError('');
    clearDraft(DRAFT_KEYS.leaveAdjustment);
  };

  const isDark = useDarkMode();
  const bg = isDark ? '#343a40' : 'white';
  const text = isDark ? '#fff' : '#333';
  const subText = isDark ? '#adb5bd' : '#666';
  const inputBg = isDark ? '#495057' : 'white';
  const borderColor = isDark ? '#6c757d' : '#ddd';

  const isApprover = ['リーダー', 'マネージャー', '社長', '管理者'].includes(_roleTitle);
  // 🚨 Hook は必ず早期returnより前で呼ぶ。
  // 以前はこの行が下の `if (submitted)` の後ろにあり、申請を送信した瞬間に
  // Hookの数が変わってReactが落ち、画面が真っ黒になっていた（2026-07-25〜）
  const { pendingCount: approvalPendingCount } = useLeavePendingCount(user.id, _roleTitle, false);

  if (submitted) {
    return <BannerSuccess message="申請しました" onClose={() => { if (onSubmitSuccess) { onSubmitSuccess(); } else { handleReset(); navigate('/'); } }} />;
  }

  const encAnsweringDay = encPending.find(d => d.id === encAnsweringId) || null;

  const encBannerList = encPending.map(d => {
    const today = todayJstStr();
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
      {/* ページタイトル */}
      <div style={{ textAlign: 'center', padding: '8px 0 12px' }}>
        <h1 style={{ fontSize: 20, fontWeight: 'bold', color: text, margin: 0 }}>🌿 休暇申請</h1>
      </div>

      {/* このページの説明 */}
      <div style={{
        background: '#fff3cd',
        border: '1px solid #ffe0a3',
        borderRadius: 8, padding: '12px 14px', marginBottom: 16, textAlign: 'left',
        position: 'relative', // 右上のFAQボタンの基準
      }}>
        <HelpLinkButton category="休暇申請" />
        <p style={{ fontSize: 13, fontWeight: 'bold', color: '#856404', textAlign: 'center', margin: '0 0 10px' }}>【全スタッフ】</p>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, margin: '0 0 8px' }}>
          <span style={{ flexShrink: 0, width: 22, height: 22, borderRadius: '50%', background: '#4a90d9', color: '#fff', fontSize: 13, fontWeight: 'bold', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>1</span>
          <span style={{ fontSize: 14, fontWeight: 'bold', color: '#664d03', lineHeight: '22px' }}>有給・慶弔休・調整休などを申請できます</span>
        </div>
        <p style={{ fontSize: 12, color: '#856404', lineHeight: 1.8, margin: 0 }}>※申請が受理されると、Googleカレンダーに自動登録されます。</p>
      </div>

      {/* タブ切替（共通部品 PageTabs。パートへのフォーム送信中は休暇タブのみ） */}
      <PageTabs
        variant="shadow"
        isDark={isDark}
        inactiveColor={text}
        tabs={leaveRequestEnabled
          ? [{ key: 'form' as const, label: '🌿 休暇' }]
          : [
              { key: 'form' as const, label: '🌿 休暇' },
              { key: 'adjustment' as const, label: '🕐 時間調整' },
              { key: 'history' as const, label: '📋 申請履歴' },
            ]}
        active={tab}
        onChange={t => { setTab(t); window.scrollTo({ top: 0, left: 0, behavior: 'instant' as ScrollBehavior }); document.documentElement.scrollTop = 0; document.body.scrollTop = 0; }}
      />

      {isApprover && (
        <button
          onClick={() => navigate('/leave-approvals')}
          style={{ width: '100%', padding: '9px', background: '#fd7e14', color: 'white', border: 'none', cursor: 'pointer', marginTop: 8, borderRadius: 8, lineHeight: 1.4 }}
        >
          <div style={{ fontSize: 14, fontWeight: 'bold', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
            ✅ 受理ページへ
            {approvalPendingCount > 0 && (
              <span style={{ background: '#dc3545', color: '#fff', borderRadius: 10, fontSize: 11, minWidth: 19, height: 19, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold', padding: '0 4px' }}>
                {approvalPendingCount > 99 ? '99+' : approvalPendingCount}
              </span>
            )}
          </div>
          <div style={{ fontSize: 11, opacity: 0.95, marginTop: 1 }}>パートへの申請フォーム送信</div>
        </button>
      )}

      {/* 申請フォーム */}
      {tab === 'form' && (
        <div style={{ padding: 24, background: bg, borderRadius: '0 0 12px 12px', boxShadow: '0 2px 12px rgba(0,0,0,0.1)', boxSizing: 'border-box', width: '100%' }}>
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

          {/* 入力内容クリア（注意事項の下・入力欄の直前に配置。再申請モード中は非表示） */}
          {!reapplySourceId && (
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
              <button type="button" onClick={clearLeaveForm}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: subText, background: 'none', border: `1px solid ${borderColor}`, borderRadius: 14, padding: '4px 12px', cursor: 'pointer' }}>
                クリア
              </button>
            </div>
          )}

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
            {leaveApprovers.length === 0 ? (
              <div style={{ padding: '10px 14px', background: '#fff3cd', borderRadius: 8, color: '#856404', fontSize: 14 }}>
                受理者が登録されていません
              </div>
            ) : (
              <select
                value={selectedApproverId}
                onChange={e => { setSelectedApproverId(e.target.value); if (e.target.value) setErrFields(prev => { const n = new Set(prev); n.delete('approver'); return n; }); }}
                style={{ width: '100%', padding: '10px 14px', border: `1px solid ${errFields.has('approver') ? '#e24b4a' : borderColor}`, borderRadius: 8, fontSize: 15, background: errFields.has('approver') ? (isDark ? '#4a2b30' : '#fdecea') : inputBg, color: selectedApproverId ? text : subText }}
              >
                <option value="" disabled>申請先を選択してください</option>
                {leaveApprovers.map(a => (
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
              disabled={!!leaveRequestEnabled}
              style={{ width: '100%', padding: '10px 14px', border: `1px solid ${borderColor}`, borderRadius: 8, fontSize: 15, background: inputBg, color: text }}
            >
              <option value="有給休暇">有給休暇</option>
              {!leaveRequestEnabled && <option value="バースデー休暇（有給）">バースデー休暇（有給）</option>}
              {!leaveRequestEnabled && <option value="慶弔休暇">慶弔休暇</option>}
              {!leaveRequestEnabled && <option value="調整休">調整休</option>}
              {!leaveRequestEnabled && <option value="その他">その他</option>}
            </select>
            {leaveType === 'その他' && (
              <input
                type="text"
                value={leaveTypeOther}
                onChange={e => { setLeaveTypeOther(e.target.value); if (e.target.value) setErrFields(prev => { const n = new Set(prev); n.delete('type'); return n; }); }}
                placeholder="種別を入力"
                style={{ width: '100%', marginTop: 8, padding: '10px 14px', border: `1px solid ${errFields.has('type') ? '#e24b4a' : borderColor}`, borderRadius: 8, fontSize: 15, boxSizing: 'border-box', background: errFields.has('type') ? (isDark ? '#4a2b30' : '#fdecea') : inputBg, color: text }}
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
                    <label style={{ display: 'block', fontSize: 14, fontWeight: 'bold', marginBottom: 6, color: errFields.has('originDates') ? '#dc3545' : text }}>
                      振替元の勤務日 <span style={{ color: '#dc3545' }}>*</span> <span style={{ fontSize: 12, fontWeight: 'normal', color: subText }}>（日付をタップして選択・解除）</span>
                    </label>
                    <MultiDatePicker
                      selectedDates={choseiOriginDates}
                      onChange={dates => {
                        setChoseiOriginDates(dates);
                        // 選択解除された日付の校情報を削除
                        setOriginLocations(prev => Object.fromEntries(dates.filter(d => prev[d]).map(d => [d, prev[d]])));
                      }}
                      isDark={isDark}
                    />
                    {/* 振替元の日付ごとの校選択（選択日の一覧を兼ねる・1日1行） */}
                    {choseiOriginDates.length > 0 && (
                      <div style={{ marginTop: 10 }}>
                        <label style={{ display: 'block', fontSize: 14, fontWeight: 'bold', marginBottom: 2, color: errFields.has('originLocations') ? '#dc3545' : text }}>
                          振替元の勤務校 <span style={{ color: '#dc3545' }}>*</span>
                          <span style={{ fontSize: 12, fontWeight: 'normal', color: subText, marginLeft: 6 }}>（日付ごとに選択）</span>
                        </label>
                        <DateLocationPicker
                          dates={choseiOriginDates}
                          locations={originLocations}
                          workplaces={workplaces}
                          bulk={originBulkLocation}
                          onBulk={v => {
                            setOriginBulkLocation(v);
                            if (v) { setOriginLocations(Object.fromEntries(choseiOriginDates.map(d => [d, v]))); setLocError(''); }
                          }}
                          onSelect={(d, v) => {
                            setOriginLocations(prev => ({ ...prev, [d]: v }));
                            setOriginBulkLocation('');
                            if (v) setLocError('');
                          }}
                          isDark={isDark}
                        />
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
            <label style={{ display: 'block', fontWeight: 'bold', marginBottom: 6, color: errFields.has('dates') ? '#dc3545' : text }}>
              休暇日 <span style={{ color: '#dc3545' }}>*</span> <span style={{ fontSize: 12, fontWeight: 'normal', color: subText }}>（日付をタップして選択・解除）</span>
            </label>
            <MultiDatePicker
              selectedDates={selectedDates}
              onChange={dates => {
                setSelectedDates(dates);
                if (dates.length > 0) setErrFields(prev => { const n = new Set(prev); n.delete('dates'); return n; });
                // 選択解除された日付の校情報を削除（残すと送信データにゴミが混ざる）
                setDateLocations(prev => Object.fromEntries(dates.filter(d => prev[d]).map(d => [d, prev[d]])));
              }}
              isDark={isDark}
              calendarKinds={calendarKinds}
            />
            {/* 会社の休館日を選んだときの注意書き。
                止めない（試合・イベントで出勤する日もある）。気づいてもらうだけ */}
            {(() => {
              const hits = selectedDates.filter(d => calendarKinds[d]);
              if (hits.length === 0) return null;
              return (
                <div style={{ marginTop: 8, background: '#fff3cd', border: '1px solid #ffe0a3', borderRadius: 8, padding: '9px 11px' }}>
                  {hits.map(d => (
                    <p key={d} style={{ margin: '0 0 2px', fontSize: 13, fontWeight: 'bold', color: '#856404' }}>
                      {d.slice(5).replace('-', '/')}　{CALENDAR_NOTICE[calendarKinds[d]]}
                    </p>
                  ))}
                  <p style={{ margin: '4px 0 0', fontSize: 12, color: '#856404' }}>申請内容にお間違いはありませんか？</p>
                </div>
              );
            })()}
            {/* 日付ごとの校選択（選択日の一覧を兼ねる・1日1行） */}
            {selectedDates.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <label style={{ display: 'block', fontWeight: 'bold', marginBottom: 2, color: errFields.has('locations') ? '#dc3545' : text, fontSize: 14 }}>
                  勤務校 <span style={{ color: '#dc3545' }}>*</span>
                  <span style={{ fontSize: 12, fontWeight: 'normal', color: subText, marginLeft: 6 }}>（日付ごとに選択）</span>
                </label>
                <DateLocationPicker
                  dates={selectedDates}
                  locations={dateLocations}
                  workplaces={workplaces}
                  bulk={bulkLocation}
                  onBulk={v => {
                    setBulkLocation(v);
                    if (v) { setDateLocations(Object.fromEntries(selectedDates.map(d => [d, v]))); setLocError(''); }
                  }}
                  onSelect={(d, v) => {
                    setDateLocations(prev => ({ ...prev, [d]: v }));
                    setBulkLocation(''); // 個別に変えたら「一括」表示は解除
                    if (v) setLocError('');
                  }}
                  isDark={isDark}
                />
              </div>
            )}
          </div>

          {/* 事由（必須）調整休は専用欄を使うため非表示 */}
          {leaveType !== '調整休' && <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'block', fontWeight: 'bold', marginBottom: 6, color: errFields.has('purpose') ? '#dc3545' : text }}>
              事由 <span style={{ color: '#dc3545' }}>*</span>
            </label>
            <textarea
              value={purpose}
              onChange={e => { setPurpose(e.target.value); if (e.target.value.trim()) setErrFields(prev => { const n = new Set(prev); n.delete('purpose'); return n; }); }}
              placeholder="休暇取得の理由を入力してください"
              rows={3}
              style={{ width: '100%', padding: '10px 14px', border: `1px solid ${errFields.has('purpose') ? '#e24b4a' : borderColor}`, borderRadius: 8, fontSize: 15, boxSizing: 'border-box', resize: 'vertical', background: inputBg, color: text }}
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

          {locError && (
            <div style={{ color: '#dc3545', fontSize: 13, marginBottom: 12, padding: '10px 12px', background: '#fff5f5', border: `1px solid ${'#f5b5b5'}`, borderRadius: 6 }}>
              {locError.split('\n').map((line, i) => (
                <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'flex-start', marginTop: i === 0 ? 0 : 5 }}>
                  <span style={{ flexShrink: 0 }}>⚠️</span><span>{line}</span>
                </div>
              ))}
            </div>
          )}
          <button
            onClick={() => {
              // 入力チェックを1回で全部集め、足りない項目をまとめてバナー表示＋該当欄を赤ハイライト（alertは使わない）
              const errs: string[] = [];
              const bad = new Set<string>();
              const isFurikae = leaveType === '調整休' && choseiSubType === 'furikae';
              if (!selectedApproverId) { errs.push('申請先を選んでください'); bad.add('approver'); }
              if (selectedDates.length === 0) { errs.push('休暇日を選択してください'); bad.add('dates'); }
              if (isFurikae && choseiOriginDates.length === 0) { errs.push('振替元の勤務日を選択してください'); bad.add('originDates'); }
              if (isFurikae && choseiOriginDates.length > 0 && choseiOriginDates.length !== selectedDates.length) { errs.push(`振替元の勤務日（${choseiOriginDates.length}日）と休暇日（${selectedDates.length}日）の日数が一致していません`); bad.add('originDates'); }
              if (!purpose.trim() && leaveType !== '調整休') { errs.push('事由を入力してください'); bad.add('purpose'); }
              if (leaveType === '調整休' && !purpose.trim()) { errs.push('理由を入力してください'); bad.add('purpose'); }
              if (leaveType === 'その他' && !leaveTypeOther) { errs.push('種別を入力してください'); bad.add('type'); }
              if (selectedDates.some(d => !dateLocations[d])) { errs.push('すべての日付で勤務校を選択してください'); bad.add('locations'); }
              if (isFurikae && choseiOriginDates.some(d => !originLocations[d])) { errs.push('振替元のすべての日付で勤務校を選択してください'); bad.add('originLocations'); }
              if (errs.length > 0) { setLocError(errs.join('\n')); setErrFields(bad); return; }
              setLocError(''); setErrFields(new Set());
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
        const _HOURS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0')); void _HOURS;
        const _MINS = ['00', '05', '10', '15', '20', '25', '30', '35', '40', '45', '50', '55']; void _MINS;
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
          // 🚨 type="time" をやめた分、時刻の形は自分で確かめる（空でないかだけでは足りない）
          if (adjLateStart && normalizeTime(adjLateTime) === null) { setAdjError('調整遅出の出勤時刻を正しく入力してください（例 9:30）'); return; }
          if (adjEarlyEnd && normalizeTime(adjEarlyTime) === null) { setAdjError('調整早退の退勤時刻を正しく入力してください（例 17:30）'); return; }
          if (!adjLocation) { setAdjError('校を選択してください'); return; }
          if (!adjReason.trim()) { setAdjError('理由を入力してください'); return; }
          setAdjSubmitting(true);
          try {
            const approverName = adjApproverMode === 'select'
              ? (approvers.find(a => a.id === adjApproverSelectedId)?.name ?? '')
              : adjApproverFree.trim();
            const notesVal = approverName ? `【了承者】${approverName}　${adjReason.trim()}` : adjReason.trim();
            const records: { user_id: string; date: string; type: string; actual_time: string; notes: string; created_by: string; location: string }[] = [];
            if (adjLateStart) records.push({ user_id: user.id, date: adjDate, type: 'late_start', actual_time: adjLateTime, notes: notesVal, created_by: user.id, location: adjLocation });
            if (adjEarlyEnd)  records.push({ user_id: user.id, date: adjDate, type: 'early_end',  actual_time: adjEarlyTime, notes: notesVal, created_by: user.id, location: adjLocation });
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
                  body: { action: 'upsert', source_type: 'absence', source_id: rec.id, dates: [rec.date], name: profileName ?? '', absence_type: rec.type, time: rec.actual_time ? rec.actual_time.slice(0, 5) : undefined, locations: { [rec.date]: adjLocation } },
                });
              } catch (e) { console.error('[gcal-sync] 時間調整書き込み失敗:', e); }
            }
            // 通知 Edge Function
            try {
              await supabase.functions.invoke('time-adjustment-notify', {
                body: {
                  user_id: user.id, user_name: profileName ?? '', date: adjDate,
                  types: records.map(r => r.type), reason: adjReason.trim(),
                  // Slack本文に出す時間（理由はSlackには載せない）
                  details: records.map(r => ({ type: r.type, time: r.actual_time })),
                },
              });
            } catch (e) { console.error('[time-adjustment-notify] 通知失敗:', e); }
            // リセット＆バナー
            setAdjLateStart(false); setAdjEarlyEnd(false);
            setAdjDate(''); setAdjLateTime(''); setAdjEarlyTime('');
            setAdjLocation('');
            setAdjReason(''); setAdjApproverSelectedId(''); setAdjApproverFree('');
            clearDraft(DRAFT_KEYS.leaveAdjustment); // 送信成功で下書きを消す
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

            {/* 入力内容クリア */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
              <button type="button" onClick={clearAdjForm}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: subText, background: 'none', border: `1px solid ${borderColor}`, borderRadius: 14, padding: '4px 12px', cursor: 'pointer' }}>
                クリア
              </button>
            </div>

            {/* info-box */}
            <div style={{ background: isDark ? '#1a3a4a' : '#e8f4fd', border: `1px solid ${isDark ? '#2a6a8a' : '#bee5eb'}`, borderRadius: 10, padding: '12px 14px', marginBottom: 14 }}>
              <div style={{ fontWeight: 'bold', fontSize: 13, color: isDark ? '#90d0f0' : '#0c4a6e', marginBottom: 6 }}>自己登録（申請不要）</div>
              <div style={{ fontSize: 12, color: isDark ? '#a8cfe8' : '#0e5a8a', lineHeight: 1.7 }}>
                時間調整は受理フローがありません。登録するとGoogleカレンダーにも反映されます。<br />
                <span style={{ opacity: 0.85 }}>※ 有給休暇などの休暇申請とは異なり、受理待ちにはなりません。</span><br />
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
                  style={{ border: 'none', borderRadius: 10, padding: 12, cursor: 'pointer', background: adjLateStart ? '#1976d2' : (isDark ? '#495057' : '#e9ecef') }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: adjLateStart ? 10 : 0 }}>
                    <div style={{ width: 16, height: 16, borderRadius: 4, border: adjLateStart ? 'none' : '1.5px solid #1976d2', background: adjLateStart ? '#fff' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                      {adjLateStart && <span style={{ color: '#1976d2', fontSize: 11, lineHeight: 1, fontWeight: 'bold' }}>✓</span>}
                    </div>
                    <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#4caf50', flexShrink: 0, display: 'inline-block' }} />
                    <span style={{ fontSize: 14, fontWeight: 'bold', color: adjLateStart ? '#fff' : text }}>調整遅出</span>
                  </div>
                  {adjLateStart && (
                    <div onClick={e => e.stopPropagation()}>
                      <label style={{ fontSize: 12, color: '#e3f2fd', marginBottom: 4, display: 'block' }}>出勤時刻 <span style={{ color: '#ffcdd2' }}>*</span></label>
                      <TimeInput value={adjLateTime} onChange={setAdjLateTime} isDark={isDark}
                        invalid={!adjLateTime} ariaLabel="調整遅出 出勤時刻" style={{ width: '100%' }} />
                    </div>
                  )}
                </div>
                {/* 調整早退 */}
                <div
                  onClick={() => setAdjEarlyEnd(v => !v)}
                  style={{ border: 'none', borderRadius: 10, padding: 12, cursor: 'pointer', background: adjEarlyEnd ? '#1976d2' : (isDark ? '#495057' : '#e9ecef') }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: adjEarlyEnd ? 10 : 0 }}>
                    <div style={{ width: 16, height: 16, borderRadius: 4, border: adjEarlyEnd ? 'none' : '1.5px solid #1976d2', background: adjEarlyEnd ? '#fff' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                      {adjEarlyEnd && <span style={{ color: '#1976d2', fontSize: 11, lineHeight: 1, fontWeight: 'bold' }}>✓</span>}
                    </div>
                    <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#9c27b0', flexShrink: 0, display: 'inline-block' }} />
                    <span style={{ fontSize: 14, fontWeight: 'bold', color: adjEarlyEnd ? '#fff' : text }}>調整早退</span>
                  </div>
                  {adjEarlyEnd && (
                    <div onClick={e => e.stopPropagation()}>
                      <label style={{ fontSize: 12, color: '#e3f2fd', marginBottom: 4, display: 'block' }}>退勤時刻 <span style={{ color: '#ffcdd2' }}>*</span></label>
                      <TimeInput value={adjEarlyTime} onChange={setAdjEarlyTime} isDark={isDark}
                        invalid={!adjEarlyTime} ariaLabel="調整早退 退勤時刻" style={{ width: '100%' }} />
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

            {/* 校（カレンダーのタイトルに［校名］で表示される） */}
            <div style={{ marginBottom: 16 }}>
              <label style={{ display: 'block', fontWeight: 'bold', marginBottom: 8, color: text, fontSize: 14 }}>勤務校 <span style={{ color: '#dc3545' }}>*</span></label>
              <select value={adjLocation} onChange={e => setAdjLocation(e.target.value)}
                style={{ width: '100%', padding: '10px 14px', border: `1px solid ${borderColor}`, borderRadius: 8, fontSize: 14, background: inputBg, color: text, boxSizing: 'border-box' }}>
                <option value="">選択してください</option>
                {workplaces.map(w => <option key={w} value={w}>{w}</option>)}
              </select>
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
              <div style={{ marginBottom: 12, padding: '10px 14px', background: '#f8d7da', borderRadius: 8, color: '#721c24', fontSize: 13 }}>
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
                const isFocused = highlightId === req.id;
                return (
                  <div
                    key={req.id}
                    ref={el => { if (el && isFocused) focusRef.current = el; }}
                    style={{
                      padding: '10px 12px', borderRadius: 8,
                      border: `2px solid ${isFocused ? '#f0c000' : isApproved ? '#28a745' : isRejected ? '#dc3545' : isCancelled ? '#6c757d' : borderColor}`,
                      background: isFocused ? (isDark ? '#4a4423' : '#fff9c4') : isApproved ? (isDark ? '#1b4d1b' : '#f0fff4') : isRejected ? (isDark ? '#5a1a1a' : '#fff5f5') : isCancelled ? (isDark ? '#343a40' : '#f8f9fa') : (isDark ? '#495057' : '#fafafa'),
                      boxSizing: 'border-box', transition: 'background 0.6s, border-color 0.6s',
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
                      <div style={{ marginTop: 4, padding: '4px 8px', background: '#f8d7da', borderRadius: 6, color: '#721c24', fontSize: 12, textAlign: 'left' }}>
                        差し戻し理由: {req.rejected_reason}
                      </div>
                    )}
                    {/* 未承認(pending)：本人が自分で編集・取消できる（承認が入ったら下の依頼へ） */}
                    {req.status === 'pending' && (
                      cancelConfirmId === req.id ? (
                        <div style={{ marginTop: 8, background: '#fff5f5', border: '1px solid #dc3545', borderRadius: 8, padding: 10 }}>
                          <div style={{ fontSize: 12, color: '#721c24', marginBottom: 8 }}>この申請を取り消しますか？</div>
                          <div style={{ display: 'flex', gap: 8 }}>
                            <button onClick={() => doCancelLeave(req.id)} disabled={cancelingId === req.id}
                              style={{ flex: 1, padding: '6px 0', background: '#dc3545', color: '#fff', border: 'none', borderRadius: 8, fontSize: 12, fontWeight: 'bold', cursor: 'pointer' }}>
                              {cancelingId === req.id ? '取消中…' : '取り消す'}
                            </button>
                            <button onClick={() => setCancelConfirmId(null)}
                              style={{ flex: 1, padding: '6px 0', background: '#fff', color: '#721c24', border: '1px solid #f5b5b5', borderRadius: 8, fontSize: 12, cursor: 'pointer' }}>
                              やめる
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div style={{ marginTop: 8 }}>
                          <div style={{ fontSize: 11, color: subText, marginBottom: 4 }}>まだ承認前なので、自分で直せます</div>
                          <div style={{ display: 'flex', gap: 8 }}>
                            <button onClick={() => startEditLeave(req)}
                              style={{ flex: 1, padding: '6px 0', background: '#007bff', color: '#fff', border: 'none', borderRadius: 8, fontSize: 12, fontWeight: 'bold', cursor: 'pointer' }}>
                              編集
                            </button>
                            <button onClick={() => setCancelConfirmId(req.id)}
                              style={{ flex: 1, padding: '6px 0', background: '#6c757d', color: '#fff', border: 'none', borderRadius: 8, fontSize: 12, fontWeight: 'bold', cursor: 'pointer' }}>
                              取消
                            </button>
                          </div>
                        </div>
                      )
                    )}
                    {/* 差戻し：取消（インライン確認）＋再申請 */}
                    {isRejected && (
                      cancelConfirmId === req.id ? (
                        <div style={{ marginTop: 8, background: '#fff5f5', border: '1px solid #dc3545', borderRadius: 8, padding: 10 }}>
                          <div style={{ fontSize: 12, color: '#721c24', marginBottom: 8 }}>この申請を取り消しますか？</div>
                          <div style={{ display: 'flex', gap: 8 }}>
                            <button onClick={() => doCancelLeave(req.id)} disabled={cancelingId === req.id}
                              style={{ flex: 1, padding: '6px 0', background: '#dc3545', color: '#fff', border: 'none', borderRadius: 8, fontSize: 12, fontWeight: 'bold', cursor: 'pointer' }}>
                              {cancelingId === req.id ? '取消中…' : '取り消す'}
                            </button>
                            <button onClick={() => setCancelConfirmId(null)}
                              style={{ flex: 1, padding: '6px 0', background: '#fff', color: '#721c24', border: '1px solid #f5b5b5', borderRadius: 8, fontSize: 12, cursor: 'pointer' }}>
                              やめる
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                          <button onClick={() => setCancelConfirmId(req.id)}
                            style={{ flex: 1, padding: '6px 0', background: '#6c757d', color: '#fff', border: 'none', borderRadius: 8, fontSize: 12, fontWeight: 'bold', cursor: 'pointer' }}>
                            取消
                          </button>
                          <button onClick={() => {
                            setLeaveType((req.leave_type as LeaveType) || '有給休暇');
                            setLeaveTypeOther(req.leave_type_other || '');
                            try { setSelectedDates(req.leave_dates ? JSON.parse(req.leave_dates) : []); } catch { setSelectedDates([]); }
                            setPurpose(req.purpose || '');
                            if (req.approver_id) setSelectedApproverId(req.approver_id);
                            setReapplySourceId(req.id);
                            setTab('form');
                            window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
                          }} style={{ flex: 1, padding: '6px 0', background: '#007bff', color: '#fff', border: 'none', borderRadius: 8, fontSize: 12, fontWeight: 'bold', cursor: 'pointer' }}>
                            再申請
                          </button>
                        </div>
                      )
                    )}
                    {/* 1人でも承認〜受理済み：本人は触れず、修正/取消を依頼 */}
                    {['step2_pending', 'manager_approved', 'admin_approved', 'approved'].includes(req.status) && (
                      <>
                        <div style={{ fontSize: 11, color: subText, marginTop: 8 }}>受理手続き中／受理済みのため、変更は管理者へ依頼します</div>
                        <CorrectionBadgeAndButton
                          targetType="leave"
                          targetId={req.id}
                          targetLabel={`休暇 ${dateDisplay}`}
                          fields={[
                            { key: 'dates', label: '日付', current: dateDisplay },
                            { key: 'type', label: '種別', current: req.leave_type === 'その他' ? (req.leave_type_other || 'その他') : req.leave_type },
                          ]}
                          requesterName={profileName || user.email || 'スタッフ'}
                          isDark={isDark}
                          latest={corrections.get(req.id) ?? null}
                          canRequest
                          onSubmitted={reloadCorrections}
                        />
                      </>
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
                  <td style={{ padding: '8px 0', color: text }}>
                    <div style={{ fontWeight: 'bold', color: '#007bff', marginBottom: 4 }}>{formatSelectedDates(selectedDates)}</div>
                    {/* 1日1行：日付＋校 */}
                    {[...selectedDates].sort().slice(0, 10).map(d => (
                      <div key={d} style={{ fontSize: 13, padding: '2px 0' }}>{shortDateLabel(d)}　{dateLocations[d] ?? '—'}</div>
                    ))}
                    {selectedDates.length > 10 && <div style={{ fontSize: 12, color: subText }}>…他{selectedDates.length - 10}日</div>}
                  </td>
                </tr>
                {leaveType === '調整休' && choseiSubType === 'furikae' && choseiOriginDates.length > 0 && (
                  <tr>
                    <td style={{ padding: '8px 0', color: subText, verticalAlign: 'top' }}>振替元</td>
                    <td style={{ padding: '8px 0', color: text }}>
                      {[...choseiOriginDates].sort().slice(0, 10).map(d => (
                        <div key={d} style={{ fontSize: 13, padding: '2px 0' }}>{shortDateLabel(d)}　{originLocations[d] ?? '—'}</div>
                      ))}
                      {choseiOriginDates.length > 10 && <div style={{ fontSize: 12, color: subText }}>…他{choseiOriginDates.length - 10}日</div>}
                    </td>
                  </tr>
                )}
                <tr><td style={{ padding: '8px 0', color: subText, verticalAlign: 'top' }}>事由</td><td style={{ padding: '8px 0', color: text }}>{purpose}</td></tr>
                {notes && <tr><td style={{ padding: '8px 0', color: subText, verticalAlign: 'top' }}>備考</td><td style={{ padding: '8px 0', color: text }}>{notes}</td></tr>}
              </tbody>
            </table>
            {submitError && (
              <div style={{ marginBottom: 12, fontSize: 13, color: '#dc3545', background: '#fff5f5', border: `1px solid ${'#f5b5b5'}`, borderRadius: 6, padding: '8px 12px' }}>⚠️ {submitError}</div>
            )}
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

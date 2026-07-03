import React, { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient';
import { useDarkMode } from '../hooks/useDarkMode';
import type { AuthUser } from '../types';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────
type ApplicationType = 'overtime' | 'holiday_work' | 'early_leave' | 'tardiness' | 'absence' | 'early_start' | 'location_change';

interface ShiftReport {
  id: string;
  applicant_id: string;
  submitted_by: string;
  work_date: string;
  pay_period_start: string;
  application_type: ApplicationType;
  application_types: ApplicationType[];
  reason: string;
  original_location: string | null;
  original_start: string | null;
  original_end: string | null;
  original_outing_start: string | null;
  original_outing_end: string | null;
  actual_location: string | null;
  actual_start: string | null;
  actual_end: string | null;
  actual_outing_start: string | null;
  actual_outing_end: string | null;
  break_minutes: number | null;
  labor_minutes: number | null;
  reviewer_id: string | null;
  status: 'pending' | 'confirmed' | 'resubmitted' | 'cancelled' | 'returned';
  confirmed_by: string | null;
  confirmed_at: string | null;
  created_at: string;
  applicant?: { name: string | null } | null;
  reviewer?: { name: string | null } | null;
}
interface Reviewer { id: string; name: string; role_title: string; }
interface Staff    { id: string; name: string; role_title: string; employment_type: string; }

interface Props {
  user: AuthUser;
  profileName: string | null;
  roleTitle: string;
  isAdmin: boolean;
}

// ────────────────────────────────────────────────────────────────
// Constants & Utilities
// ────────────────────────────────────────────────────────────────
const REVIEWER_ROLES = ['リーダー', 'マネージャー', 'フロア責任者', '社長', '管理者'];
const IS_APPROVER = (role: string, admin: boolean) => admin || REVIEWER_ROLES.includes(role);
const DOW = ['日', '月', '火', '水', '木', '金', '土'];

function toMin(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}
function calcBreakMinutes(start: string, end: string): number {
  const s = toMin(start), d = toMin(end) - s;
  if (d <= 0)               return 0;
  if (d < 255)              return 0;
  if (s >= 780 && d <= 345) return 0;
  if (s >= 780 && d <= 375) return 15;
  if (d <= 390)             return 30;
  if (d <= 525)             return 45;
  return 60;
}
function formatMin(min: number): string {
  const h = Math.floor(Math.abs(min) / 60), m = Math.abs(min) % 60;
  return `${h}時間${m > 0 ? m + '分' : ''}`;
}
function calcPayPeriodStart(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  if (d.getDate() >= 16)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-16`;
  const prev = new Date(d.getFullYear(), d.getMonth() - 1, 16);
  return `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}-16`;
}
function payPeriodLabel(startStr: string): string {
  const d = new Date(startStr + 'T00:00:00');
  const nm = d.getMonth() + 2;
  const y = nm > 12 ? d.getFullYear() + 1 : d.getFullYear();
  const m = ((nm - 1) % 12) + 1;
  return `${y}年${m}月給与分`;
}
function todayStr(): string { return new Date().toISOString().slice(0, 10); }
function dow(dateStr: string): string { return DOW[new Date(dateStr + 'T00:00:00').getDay()]; }
function origDuration(start: string | null, end: string | null): number {
  if (!start || !end) return 0;
  return toMin(end) - toMin(start);
}

const TYPE_INFO: Record<ApplicationType, { label: string; color: string; emoji: string }> = {
  overtime:     { label: '残業',     color: '#1565c0', emoji: '⏰' },
  holiday_work: { label: '休日出勤', color: '#0f766e', emoji: '🏢' },
  early_leave:  { label: '早退',     color: '#e65100', emoji: '🏃' },
  tardiness:    { label: '遅刻',     color: '#7b1fa2', emoji: '⏱️' },
  absence:      { label: '欠勤',     color: '#c62828', emoji: '❌' },
  early_start:  { label: '早出',     color: '#0891b2', emoji: '🌅' },
  location_change: { label: '勤務地変更', color: '#6d28d9', emoji: '📍' },
};

const TYPE_PRIORITY: ApplicationType[] = ['absence', 'holiday_work', 'overtime', 'early_start', 'tardiness', 'early_leave', 'location_change'];
function primaryType(types: ApplicationType[]): ApplicationType {
  return TYPE_PRIORITY.find(t => types.includes(t)) ?? types[0] ?? 'overtime';
}
function typesLabel(types: ApplicationType[]): string {
  return types.map(t => `${TYPE_INFO[t].emoji} ${TYPE_INFO[t].label}`).join(' ＋ ');
}

// 排他チェック（pure function）
function isBlockedWith(current: ApplicationType[], t: ApplicationType): boolean {
  if (current.includes('absence') && t !== 'absence') return true;
  if (t === 'absence' && current.length > 0 && !current.includes('absence')) return true;
  if (t === 'tardiness'   && current.includes('early_start')) return true;
  if (t === 'early_start' && current.includes('tardiness'))   return true;
  if (t === 'early_leave' && current.includes('overtime'))    return true;
  if (t === 'overtime'    && current.includes('early_leave')) return true;
  if (t === 'holiday_work'     && current.includes('location_change')) return true;
  if (t === 'location_change'  && current.includes('holiday_work'))    return true;
  return false;
}
function blockReason(current: ApplicationType[], t: ApplicationType): string {
  if (current.includes('absence')) return '欠勤を選択中は他を選べません';
  if (t === 'absence') return '他の種別が選択中は欠勤を選べません';
  if (t === 'tardiness'   && current.includes('early_start')) return '早出と遅刻は同時に選べません';
  if (t === 'early_start' && current.includes('tardiness'))   return '遅刻と早出は同時に選べません';
  if (t === 'early_leave' && current.includes('overtime'))    return '残業と早退は同時に選べません';
  if (t === 'overtime'    && current.includes('early_leave')) return '早退と残業は同時に選べません';
  if (t === 'holiday_work'    && current.includes('location_change')) return '休日出勤と勤務地変更は同時に選べません';
  if (t === 'location_change' && current.includes('holiday_work'))    return '勤務地変更と休日出勤は同時に選べません';
  return '';
}
const STATUS_INFO: Record<string, { label: string; color: string; bg: string }> = {
  pending:     { label: '申請中',   color: '#856404', bg: '#fff3cd' },
  resubmitted: { label: '申請中',   color: '#856404', bg: '#fff3cd' },
  confirmed:   { label: '受理済み', color: '#065f46', bg: '#d1fae5' },
  cancelled:   { label: '取消済み', color: '#6c757d', bg: '#e9ecef' },
  returned:    { label: '差戻し',   color: '#9d174d', bg: '#fce7f3' },
};

// ────────────────────────────────────────────────────────────────
// Single Date Calendar
// ────────────────────────────────────────────────────────────────
const SingleDatePicker: React.FC<{ value: string; onChange: (d: string) => void; isDark: boolean }> = ({ value, onChange, isDark }) => {
  const today = new Date();
  const [year, setYear]   = useState(value ? new Date(value + 'T00:00:00').getFullYear() : today.getFullYear());
  const [month, setMonth] = useState(value ? new Date(value + 'T00:00:00').getMonth()    : today.getMonth());
  const firstDay    = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const prev = () => { if (month === 0) { setYear(y => y - 1); setMonth(11); } else setMonth(m => m - 1); };
  const next = () => { if (month === 11) { setYear(y => y + 1); setMonth(0); } else setMonth(m => m + 1); };
  const cells: (number | null)[] = [...Array(firstDay).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => i + 1)];
  const calBg = isDark ? '#495057' : '#f8f9fa';
  const calText = isDark ? '#fff' : '#333';
  const calBorder = isDark ? '#6c757d' : '#ddd';

  return (
    <div style={{ background: calBg, border: `1px solid ${calBorder}`, borderRadius: 10, padding: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <button onClick={prev} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: calText, padding: '0 8px', lineHeight: 1 }}>‹</button>
        <span style={{ fontWeight: 'bold', fontSize: 15, color: calText }}>{year}年 {month + 1}月</span>
        <button onClick={next} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: calText, padding: '0 8px', lineHeight: 1 }}>›</button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2, marginBottom: 4 }}>
        {['日', '月', '火', '水', '木', '金', '土'].map((d, i) => (
          <div key={d} style={{ textAlign: 'center', fontSize: 11, fontWeight: 'bold', color: i === 0 ? '#e74c3c' : i === 6 ? '#3498db' : calText, padding: '3px 0' }}>{d}</div>
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2 }}>
        {cells.map((day, i) => {
          if (!day) return <div key={i} />;
          const iso = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
          const sel = iso === value, isT = iso === todayStr();
          const d = (firstDay + day - 1) % 7;
          const col = d === 0 ? '#e74c3c' : d === 6 ? '#3498db' : calText;
          return (
            <button key={i} onClick={() => onChange(iso)}
              style={{ padding: '10px 2px', minHeight: 38, borderRadius: 6, border: isT ? '2px solid #007bff' : '1px solid transparent', background: sel ? '#28a745' : 'transparent', color: sel ? '#fff' : col, cursor: 'pointer', fontSize: 13, fontWeight: sel ? 'bold' : 'normal', textAlign: 'center' }}>
              {day}
            </button>
          );
        })}
      </div>
      {value && (
        <div style={{ marginTop: 10, fontSize: 13, color: '#28a745', fontWeight: 'bold' }}>✓ {value}（{dow(value)}）を選択中</div>
      )}
    </div>
  );
};


// ────────────────────────────────────────────────────────────────
// Confirm Modal (pre-submit review)
// ────────────────────────────────────────────────────────────────
interface ConfirmData {
  date: string; types: ApplicationType[]; reason: string;
  origLoc: string; origStart: string; origEnd: string; origDayOff: boolean;
  origOutingOn: boolean; origOutingStart: string; origOutingEnd: string;
  actLoc: string; actStart: string; actEnd: string;
  actOutingOn: boolean; actOutingStart: string; actOutingEnd: string;
  actNotes: string;
  breakMin: number; laborMin: number; reviewerName: string; isSelfReview: boolean;
  applicantName: string; isProxy: boolean;
}
const ConfirmModal: React.FC<{ data: ConfirmData; onBack: () => void; onSubmit: () => void; saving: boolean }> = ({ data, onBack, onSubmit, saving }) => {
  const isDark = useDarkMode();
  const bg = isDark ? '#343a40' : '#fff';
  const text = isDark ? '#fff' : '#1a1a2e';
  const border = isDark ? '#495057' : '#dee2e6';
  const origMin = data.origDayOff ? 0 : origDuration(data.origStart, data.origEnd);
  const hasAbsence = data.types.includes('absence');
  const diffMin = !hasAbsence ? data.laborMin - origMin : -origMin;

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1100, display: 'flex', alignItems: 'flex-end' }}>
      <div style={{ background: bg, width: '100%', maxHeight: '90vh', borderRadius: '16px 16px 0 0', overflowY: 'auto', paddingBottom: 32 }}>
        <div style={{ position: 'sticky', top: 0, background: bg, padding: '16px 16px 12px', borderBottom: `1px solid ${border}`, display: 'flex', alignItems: 'center', gap: 12 }}>
          <button onClick={onBack} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: text }}>‹</button>
          <span style={{ fontWeight: 'bold', fontSize: 16, color: text }}>申請内容を確認</span>
        </div>
        <div style={{ padding: '16px 20px' }}>
          {data.isProxy && (
            <div style={{ background: isDark ? '#1a2e4a' : '#e0f2fe', border: '1px solid #38bdf8', borderRadius: 8, padding: '8px 12px', marginBottom: 12, fontSize: 13, color: isDark ? '#7dd3fc' : '#0369a1', fontWeight: 500 }}>
              👤 代行申請：<b>{data.applicantName}</b> さんの申請
            </div>
          )}
          <CRow label="申請者"     value={data.applicantName} textColor={text} />
          <CRow label="日付"       value={`${data.date}（${dow(data.date)}）`} textColor={text} />
          <CRow label="種別"       value={typesLabel(data.types)} textColor={text} />
          <CRow label="理由"       value={data.reason} textColor={text} />
          {!hasAbsence && (
            <>
              <Sep isDark={isDark} />
              <div style={{ fontSize: 11, color: '#888', marginBottom: 6 }}>📋 通常シフト（もともとの予定）</div>
              {data.origDayOff
                ? <CRow label="" value="休みの日" textColor={text} />
                : <CRow label="" value={`${data.origLoc || '—'}　${data.origStart}〜${data.origEnd}`} textColor={text} />
              }
              {!data.origDayOff && data.origOutingOn && (
                <CRow label="外出・戻り" value={`${data.origOutingStart}〜${data.origOutingEnd}`} textColor={text} />
              )}
              <Sep isDark={isDark} />
              <div style={{ fontSize: 11, color: '#888', marginBottom: 6 }}>✅ 実際に勤務した時間</div>
              <CRow label="勤務地"  value={data.actLoc || '—'} textColor={text} />
              <CRow label="時間"    value={`${data.actStart}〜${data.actEnd}`} textColor={text} />
              {data.actOutingOn && (
                <CRow label="外出・戻り" value={`${data.actOutingStart}〜${data.actOutingEnd}`} textColor={text} />
              )}
              <CRow label="休憩"    value={`${data.breakMin}分`} textColor={text} />
              <CRow label="実労働"  value={formatMin(data.laborMin)} textColor={text} />
              {data.actNotes && <CRow label="備考" value={data.actNotes} textColor={text} />}
              {!data.origDayOff && origMin > 0 && diffMin !== 0 && (
                <div style={{ background: isDark ? '#1e3a5f' : '#eff6ff', borderRadius: 8, padding: '8px 12px', marginTop: 4 }}>
                  {data.types.includes('early_start') && <div style={{ fontSize: 13, fontWeight: 'bold', color: '#22d3ee' }}>🌅 早出：{formatMin(Math.max(0, toMin(data.origStart) - toMin(data.actStart)))}</div>}
                  {data.types.includes('tardiness') && <div style={{ fontSize: 13, fontWeight: 'bold', color: '#c084fc' }}>⏱️ 遅刻：{formatMin(Math.max(0, toMin(data.actStart) - toMin(data.origStart)))}</div>}
                  {data.types.includes('early_leave') && <div style={{ fontSize: 13, fontWeight: 'bold', color: '#fb923c' }}>🏃 早退：{formatMin(Math.max(0, toMin(data.origEnd) - toMin(data.actEnd)))}</div>}
                </div>
              )}
            </>
          )}
          <Sep isDark={isDark} />
          <CRow label="確認依頼先" value={data.reviewerName} textColor={text} />
          {data.isSelfReview && (
            <div style={{ background: isDark ? '#1e3d2f' : '#d1fae5', borderRadius: 8, padding: '8px 12px', marginTop: 4 }}>
              <span style={{ fontSize: 12, fontWeight: 'bold', color: isDark ? '#4ade80' : '#065f46' }}>✓ 申請と同時に受理済みになります</span>
            </div>
          )}
          <button onClick={onSubmit} disabled={saving}
            style={{ width: '100%', padding: 14, marginTop: 20, background: saving ? '#6c757d' : '#28a745', color: '#fff', border: 'none', borderRadius: 10, fontSize: 15, fontWeight: 'bold', cursor: saving ? 'default' : 'pointer' }}>
            {saving ? '送信中...' : '✓ この内容で申請する'}
          </button>
        </div>
      </div>
    </div>
  );
};
const CRow: React.FC<{ label: string; value: string; textColor?: string }> = ({ label, value, textColor = '#1a1a2e' }) => (
  <div style={{ display: 'flex', gap: 12, marginBottom: 8, fontSize: 14 }}>
    {label && <span style={{ color: '#888', minWidth: 72, flexShrink: 0 }}>{label}</span>}
    <span style={{ color: textColor, fontWeight: 500 }}>{value}</span>
  </div>
);
const Sep: React.FC<{ isDark?: boolean }> = ({ isDark }) => <div style={{ height: 1, background: isDark ? '#495057' : '#f0f0f0', margin: '10px 0' }} />;

// ────────────────────────────────────────────────────────────────
// Form Modal (bottom sheet)
// ────────────────────────────────────────────────────────────────
interface LeaderAssignment { id: string; course: string; school: string; leader: string; manager: string; }

const ShiftReportForm: React.FC<{
  user: AuthUser; profileName: string | null; roleTitle: string; isAdmin: boolean;
  editTarget?: ShiftReport | null;
  reviewers: Reviewer[];
  workplaces: string[];
  leaderAssignments: LeaderAssignment[];
  inline?: boolean;
  onClose: () => void; onSaved: () => void;
}> = ({ user, profileName, roleTitle, isAdmin, editTarget, reviewers, workplaces, leaderAssignments: _leaderAssignments, inline = false, onClose, onSaved }) => {
  const canProxy = IS_APPROVER(roleTitle, isAdmin);
  const [staffList, setStaffList]     = useState<Staff[]>([]);
  const [showConfirm, setShowConfirm] = useState(false);
  const [saving, setSaving]           = useState(false);
  const [error, setError]             = useState('');

  const [applicantId, setApplicantId] = useState(editTarget?.applicant_id ?? user.id);
  const [date, setDate]               = useState(editTarget?.work_date ?? todayStr());
  const [types, setTypes]             = useState<ApplicationType[]>(
    editTarget?.application_types?.length ? editTarget.application_types
    : editTarget?.application_type        ? [editTarget.application_type]
    : []
  );
  const [blockMsg, setBlockMsg]       = useState('');
  const [reason, setReason]           = useState(editTarget?.reason ?? '');
  const [origDayOff, setOrigDayOff]   = useState(false);

  // 勤務地：ドロップダウン値（「その他」選択時はカスタム入力を使う）
  const savedOrigLoc = editTarget?.original_location ?? '';
  const savedActLoc  = editTarget?.actual_location ?? '';
  const [origLoc, setOrigLoc]           = useState(workplaces.includes(savedOrigLoc) || savedOrigLoc === '' ? savedOrigLoc : 'その他');
  const [origLocCustom, setOrigLocCustom] = useState(workplaces.includes(savedOrigLoc) ? '' : savedOrigLoc);
  const [actLoc, setActLoc]             = useState(workplaces.includes(savedActLoc) || savedActLoc === '' ? savedActLoc : 'その他');
  const [actLocCustom, setActLocCustom]   = useState(workplaces.includes(savedActLoc) ? '' : savedActLoc);

  const finalOrigLoc = origLoc === 'その他' ? origLocCustom : origLoc;
  const finalActLoc  = actLoc  === 'その他' ? actLocCustom  : actLoc;

  const [origStart, setOrigStart]     = useState(editTarget?.original_start?.slice(0, 5) ?? '12:00');
  const [origEnd, setOrigEnd]         = useState(editTarget?.original_end?.slice(0, 5) ?? '12:00');
  const [actStart, setActStart]       = useState(editTarget?.actual_start?.slice(0, 5) ?? '12:00');
  const [actEnd, setActEnd]           = useState(editTarget?.actual_end?.slice(0, 5) ?? '12:00');
  const [origOutingOn, setOrigOutingOn] = useState(!!(editTarget?.original_outing_start));
  const [origOutingStart, setOrigOutingStart] = useState(editTarget?.original_outing_start?.slice(0, 5) ?? '14:00');
  const [origOutingEnd, setOrigOutingEnd]     = useState(editTarget?.original_outing_end?.slice(0, 5) ?? '15:00');
  const [actOutingOn, setActOutingOn]   = useState(!!(editTarget?.actual_outing_start));
  const [actOutingStart, setActOutingStart]   = useState(editTarget?.actual_outing_start?.slice(0, 5) ?? '14:00');
  const [actOutingEnd, setActOutingEnd]       = useState(editTarget?.actual_outing_end?.slice(0, 5) ?? '15:00');
  const [reviewerId, setReviewerId]   = useState(editTarget?.reviewer_id ?? '');
  const [actNotes, setActNotes]       = useState('');
  const [changeSummary, setChangeSummary] = useState('');

  const hasAbsence    = types.includes('absence');
  const hasHoliday    = types.includes('holiday_work');
  const pType         = primaryType(types);

  const toggleType = (t: ApplicationType) => {
    if (isBlockedWith(types, t)) {
      setBlockMsg(blockReason(types, t));
      setTimeout(() => setBlockMsg(''), 2200);
      return;
    }
    setTypes(prev => {
      if (t === 'absence') return prev.includes('absence') ? [] : ['absence'];
      const without = prev.filter(x => x !== 'absence');
      const EXCL: Partial<Record<ApplicationType, ApplicationType>> = {
        early_start: 'tardiness', tardiness: 'early_start',
        overtime: 'early_leave', early_leave: 'overtime',
      };
      const excl = EXCL[t];
      const base = excl ? without.filter(x => x !== excl) : without;
      return base.includes(t) ? base.filter(x => x !== t) : [...base, t];
    });
  };

  const breakMin = actStart && actEnd && !hasAbsence ? calcBreakMinutes(actStart, actEnd) : 0;
  const actOutingMin = actOutingOn && actOutingStart && actOutingEnd ? Math.max(0, toMin(actOutingEnd) - toMin(actOutingStart)) : 0;
  const laborMin = actStart && actEnd && !hasAbsence
    ? Math.max(0, (toMin(actEnd) - toMin(actStart)) - breakMin - actOutingMin) : 0;
  const origOutingMin = origOutingOn && origOutingStart && origOutingEnd ? Math.max(0, toMin(origOutingEnd) - toMin(origOutingStart)) : 0;
  const origMin  = (origDayOff || hasHoliday) ? 0 : Math.max(0, origDuration(origStart, origEnd) - origOutingMin);

  useEffect(() => {
    if (!canProxy) return;
    // 代行対象はパート・アルバイトのみ（employment_type='パート'）
    supabase.from('profiles').select('id, name, role_title, employment_type').eq('is_active', true).order('name')
      .then(({ data }) => {
        if (data) setStaffList((data as Staff[]).filter(s => s.employment_type === 'パート'));
      });
  }, [canProxy]);

  const validate = () => {
    if (!date)          return '日付を選択してください';
    if (types.length === 0) return '種別を選択してください';
    if (!reason.trim()) return '理由を入力してください';
    if (!origDayOff && !hasHoliday && !hasAbsence && (!origStart || !origEnd)) return '通常シフトの時間を入力してください';
    if (!origDayOff && !hasHoliday && !hasAbsence && origStart && origEnd && origStart === origEnd) return '通常シフトの開始・終了が同じ時間です。正しい時間を入力してください';
    if (!origDayOff && !hasHoliday && !hasAbsence && !origLoc) return '通常シフトの勤務地を選択してください';
    if (!origDayOff && !hasHoliday && !hasAbsence && origLoc === 'その他' && !origLocCustom.trim()) return '通常シフトの場所を入力してください';
    if (!origDayOff && !hasHoliday && !hasAbsence && origOutingOn && (!origOutingStart || !origOutingEnd || origOutingStart === origOutingEnd)) return '通常シフトの外出・戻り時間を正しく入力してください';
    if (!hasAbsence && (!actStart || !actEnd)) return '実際の時間を入力してください';
    if (!hasAbsence && actStart && actEnd && actStart === actEnd) return '開始時間と終了時間が同じです。正しい時間を入力してください';
    if (!hasAbsence && !actLoc) return '実際の勤務地を選択してください';
    if (!hasAbsence && actLoc === 'その他' && !actLocCustom.trim()) return '実際の勤務場所を入力してください';
    if (!hasAbsence && actOutingOn && (!actOutingStart || !actOutingEnd || actOutingStart === actOutingEnd)) return '実際の外出・戻り時間を正しく入力してください';
    if (!reviewerId)    return '確認依頼先を選択してください';
    if (editTarget && !changeSummary.trim()) return '修正内容を入力してください';
    return '';
  };

  const handleConfirmOpen = () => {
    const err = validate();
    if (err) { setError(err); return; }
    setError(''); setShowConfirm(true);
  };

  const handleSubmit = async () => {
    setSaving(true);
    try {
      const isSelfReview = reviewerId === user.id;
      const now = new Date().toISOString();
      const record = {
        applicant_id:      applicantId,
        submitted_by:      user.id,
        work_date:         date,
        pay_period_start:  calcPayPeriodStart(date),
        application_type:  pType,
        application_types: types,
        reason:            reason.trim() + (actNotes.trim() ? `\n備考：${actNotes.trim()}` : ''),
        original_location: (origDayOff || hasHoliday || hasAbsence) ? null : (finalOrigLoc || null),
        original_start:    (origDayOff || hasHoliday || hasAbsence) ? null : (origStart || null),
        original_end:      (origDayOff || hasHoliday || hasAbsence) ? null : (origEnd || null),
        original_outing_start: (origDayOff || hasHoliday || hasAbsence || !origOutingOn) ? null : (origOutingStart || null),
        original_outing_end:   (origDayOff || hasHoliday || hasAbsence || !origOutingOn) ? null : (origOutingEnd || null),
        actual_location:   !hasAbsence ? (finalActLoc || null) : null,
        actual_start:      !hasAbsence ? (actStart || null) : null,
        actual_end:        !hasAbsence ? (actEnd || null) : null,
        actual_outing_start: (!hasAbsence && actOutingOn) ? (actOutingStart || null) : null,
        actual_outing_end:   (!hasAbsence && actOutingOn) ? (actOutingEnd || null) : null,
        break_minutes:     !hasAbsence && actStart && actEnd ? breakMin : null,
        labor_minutes:     !hasAbsence && actStart && actEnd ? laborMin : null,
        reviewer_id:       reviewerId,
        status:       isSelfReview ? 'confirmed' : (editTarget ? 'resubmitted' : 'pending'),
        confirmed_by: isSelfReview ? user.id : null,
        confirmed_at: isSelfReview ? now : null,
      };
      if (editTarget) {
        await supabase.from('shift_report_history').insert({ report_id: editTarget.id, changed_by: user.id, change_summary: changeSummary.trim(), snapshot: editTarget });
        await supabase.from('shift_reports').update(record).eq('id', editTarget.id);
      } else {
        const { data: newReport, error: err } = await supabase.from('shift_reports').insert(record).select('id').single();
        if (err) {
          console.error('[insert shift_reports] error:', err);
          setError(err.code === '23505' ? '同じ日付の申請がすでにあります' : err.message);
          setSaving(false); setShowConfirm(false);
          return;
        }
        if (!isSelfReview) {
          // 通知：レビュアーへ
          supabase.from('notifications').insert({
            user_id: reviewerId,
            message: `${profileName ?? ''}さんから勤務変更申請が届きました`,
            sub_message: `${types.map(t => TYPE_INFO[t].label).join('＋')}　${date}`,
            source_type: 'shift_report:pending_approval',
            reference_id: newReport?.id,
            read: false,
          }).then(null, () => {});
        } else {
          // 自己受理の場合は即confirmedになるため、同グループの該当役職者へ一斉通知
          supabase.functions.invoke('shift-report-confirmed-notify', {
            body: {
              user_id: applicantId,
              user_name: applicantId === user.id ? (profileName ?? '') : (staffList.find(s => s.id === applicantId)?.name ?? ''),
              date,
              types,
              location: hasAbsence ? '' : (finalActLoc || finalOrigLoc || ''),
            },
          }).then(null, () => {});
        }
      }
      setSaving(false);
      onSaved();
    } catch (e) {
      console.error('[handleSubmit] unexpected error:', e);
      setSaving(false);
      setShowConfirm(false);
      setError('送信中にエラーが発生しました。もう一度お試しください。');
    }
  };

  const isDark = useDarkMode();
  const modalBg   = isDark ? '#343a40' : '#fff';
  const cardBg    = isDark ? '#495057' : '#f8f9fa';
  const cardBg2   = isDark ? '#1e3d2f' : '#f0fdf4';
  const textColor = isDark ? '#fff' : '#333';
  const subColor  = isDark ? '#adb5bd' : '#555';
  const borderCol = isDark ? '#6c757d' : '#ddd';

  const reviewerName = reviewers.find(r => r.id === reviewerId)?.name ?? '';
  const f: React.CSSProperties = { width: '100%', padding: '9px 12px', borderRadius: 8, border: `1px solid ${borderCol}`, fontSize: 14, boxSizing: 'border-box', background: isDark ? '#495057' : 'white', color: textColor, colorScheme: isDark ? 'dark' : 'light' };
  const L: React.CSSProperties = { fontSize: 12, color: subColor, marginBottom: 4, display: 'block' };
  const Req = <span style={{ color: '#dc3545' }}>*</span>;

  const formBody = (
    <div style={{ padding: inline ? '12px 0 0' : '16px 16px 0' }}>
            {/* 代行バナー */}
            {canProxy && applicantId !== user.id && (
              <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 10, padding: '10px 14px', marginBottom: 12, fontSize: 13, color: '#1e40af' }}>
                👤 <b>{staffList.find(s => s.id === applicantId)?.name}</b> さんの代わりに申請中
              </div>
            )}
            {/* 代行選択 */}
            {canProxy && (
              <div style={{ marginBottom: 14 }}>
                <label style={L}>対象スタッフ</label>
                <select value={applicantId} onChange={e => setApplicantId(e.target.value)} style={f}>
                  <option value={user.id}>{profileName}（自分）</option>
                  {staffList.filter(s => s.id !== user.id).map(s => (
                    <option key={s.id} value={s.id}>{s.name}（パート）</option>
                  ))}
                </select>
              </div>
            )}
            {/* 日付 */}
            <div style={{ marginBottom: 14 }}>
              <label style={L}>日付 {Req}</label>
              <SingleDatePicker value={date} onChange={setDate} isDark={isDark} />
            </div>
            {/* 種別 */}
            <div style={{ marginBottom: 14 }}>
              <label style={L}>種別 {Req}（複数選択可）</label>
              {/* 1段目：休日出勤・欠勤 */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
                {(['holiday_work', 'absence'] as ApplicationType[]).map(t => {
                  const sel = types.includes(t);
                  const blk = isBlockedWith(types, t) && !sel;
                  return (
                    <button key={t} onClick={() => toggleType(t)} disabled={blk}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 12px', borderRadius: 10, border: `2px solid ${sel ? TYPE_INFO[t].color : t === 'absence' ? '#fecaca' : '#e5e7eb'}`, background: sel ? (isDark ? '#1a2e2a' : '#f0fdf4') : t === 'absence' ? (isDark ? '#2d1215' : '#fff8f8') : (isDark ? '#495057' : 'white'), cursor: blk ? 'not-allowed' : 'pointer', opacity: blk ? 0.35 : 1, transition: 'all 0.15s', textAlign: 'left' as const }}>
                      <div style={{ width: 18, height: 18, borderRadius: 4, border: `2px solid ${sel ? TYPE_INFO[t].color : '#d1d5db'}`, background: sel ? TYPE_INFO[t].color : 'transparent', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontSize: 11, fontWeight: 'bold' }}>{sel ? '✓' : ''}</div>
                      <span style={{ fontSize: 14 }}>{TYPE_INFO[t].emoji}</span>
                      <span style={{ fontSize: 13, fontWeight: sel ? 'bold' : 'normal', color: sel ? TYPE_INFO[t].color : (t === 'absence' ? '#991b1b' : textColor) }}>{TYPE_INFO[t].label}</span>
                      {t === 'absence' && <span style={{ fontSize: 10, color: sel ? TYPE_INFO[t].color : '#f87171', border: `1px solid ${sel ? TYPE_INFO[t].color : '#fecaca'}`, borderRadius: 4, padding: '1px 5px', marginLeft: 'auto', background: sel ? '#fee2e2' : '#fff5f5', fontWeight: 600 }}>単独</span>}
                    </button>
                  );
                })}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 8, marginBottom: 8 }}>
                {(['location_change'] as ApplicationType[]).map(t => {
                  const sel = types.includes(t);
                  const blk = isBlockedWith(types, t) && !sel;
                  const locColor = isDark ? '#c4b5fd' : TYPE_INFO[t].color;
                  return (
                    <button key={t} onClick={() => toggleType(t)} disabled={blk}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 12px', borderRadius: 10, border: `2px solid ${sel ? locColor : '#e5e7eb'}`, background: sel ? (isDark ? '#3b2f57' : '#f5f3ff') : (isDark ? '#495057' : 'white'), cursor: blk ? 'not-allowed' : 'pointer', opacity: blk ? 0.35 : 1, transition: 'all 0.15s', textAlign: 'left' as const }}>
                      <div style={{ width: 18, height: 18, borderRadius: 4, border: `2px solid ${sel ? locColor : '#d1d5db'}`, background: sel ? locColor : 'transparent', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: isDark ? '#1a1a2e' : 'white', fontSize: 11, fontWeight: 'bold' }}>{sel ? '✓' : ''}</div>
                      <span style={{ fontSize: 14 }}>{TYPE_INFO[t].emoji}</span>
                      <span style={{ fontSize: 13, fontWeight: sel ? 'bold' : 'normal', color: sel ? locColor : textColor }}>{TYPE_INFO[t].label}</span>
                    </button>
                  );
                })}
              </div>
              {/* 2段目：出勤時 */}
              <div style={{ fontSize: 10, fontWeight: 700, color: '#9ca3af', letterSpacing: '0.06em', marginBottom: 6 }}>🌅 出勤時</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
                {(['early_start', 'tardiness'] as ApplicationType[]).map(t => {
                  const sel = types.includes(t);
                  const blk = isBlockedWith(types, t) && !sel;
                  return (
                    <button key={t} onClick={() => toggleType(t)} disabled={blk}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 12px', borderRadius: 10, border: `2px solid ${sel ? TYPE_INFO[t].color : '#e5e7eb'}`, background: sel ? (isDark ? '#1a2e3a' : '#f0f9ff') : (isDark ? '#495057' : 'white'), cursor: blk ? 'not-allowed' : 'pointer', opacity: blk ? 0.35 : 1, transition: 'all 0.15s', textAlign: 'left' as const }}>
                      <div style={{ width: 18, height: 18, borderRadius: 4, border: `2px solid ${sel ? TYPE_INFO[t].color : '#d1d5db'}`, background: sel ? TYPE_INFO[t].color : 'transparent', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontSize: 11, fontWeight: 'bold' }}>{sel ? '✓' : ''}</div>
                      <span style={{ fontSize: 14 }}>{TYPE_INFO[t].emoji}</span>
                      <span style={{ fontSize: 13, fontWeight: sel ? 'bold' : 'normal', color: sel ? TYPE_INFO[t].color : textColor }}>{TYPE_INFO[t].label}</span>
                    </button>
                  );
                })}
              </div>
              {/* 3段目：退勤時 */}
              <div style={{ fontSize: 10, fontWeight: 700, color: '#9ca3af', letterSpacing: '0.06em', marginBottom: 6 }}>🌙 退勤時</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                {(['overtime', 'early_leave'] as ApplicationType[]).map(t => {
                  const sel = types.includes(t);
                  const blk = isBlockedWith(types, t) && !sel;
                  return (
                    <button key={t} onClick={() => toggleType(t)} disabled={blk}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 12px', borderRadius: 10, border: `2px solid ${sel ? TYPE_INFO[t].color : '#e5e7eb'}`, background: sel ? (isDark ? '#1a2e3a' : '#f0f9ff') : (isDark ? '#495057' : 'white'), cursor: blk ? 'not-allowed' : 'pointer', opacity: blk ? 0.35 : 1, transition: 'all 0.15s', textAlign: 'left' as const }}>
                      <div style={{ width: 18, height: 18, borderRadius: 4, border: `2px solid ${sel ? TYPE_INFO[t].color : '#d1d5db'}`, background: sel ? TYPE_INFO[t].color : 'transparent', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontSize: 11, fontWeight: 'bold' }}>{sel ? '✓' : ''}</div>
                      <span style={{ fontSize: 14 }}>{TYPE_INFO[t].emoji}</span>
                      <span style={{ fontSize: 13, fontWeight: sel ? 'bold' : 'normal', color: sel ? TYPE_INFO[t].color : textColor }}>{TYPE_INFO[t].label}</span>
                    </button>
                  );
                })}
              </div>
              {/* 選択中サマリー / ブロック理由 */}
              {blockMsg ? (
                <div style={{ marginTop: 8, fontSize: 12, color: '#f97316', fontWeight: 500 }}>⚠️ {blockMsg}</div>
              ) : types.length > 0 ? (
                <div style={{ marginTop: 8, padding: '6px 12px', background: isDark ? '#1e3d2f' : '#f0fdf4', border: `1px solid ${isDark ? '#166534' : '#bbf7d0'}`, borderRadius: 8, fontSize: 12, color: isDark ? '#4ade80' : '#065f46', fontWeight: 600 }}>
                  ✓ {typesLabel(types)}
                </div>
              ) : null}
            </div>
            {/* 理由 */}
            <div style={{ marginBottom: 14 }}>
              <label style={L}>理由 {Req}</label>
              <textarea value={reason} onChange={e => setReason(e.target.value)} rows={2} placeholder="例：保護者対応のため、レッスン応援要請のため" style={{ ...f, resize: 'none' }} />
              <div style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
                {(['保護者対応のため', 'レッスン応援要請のため'] as const).map(ex => (
                  <button key={ex} type="button" onClick={() => setReason(ex)}
                    style={{ fontSize: 12, padding: '4px 10px', border: `1px solid #29b6f6`, borderRadius: 6, background: isDark ? '#0d3a5e' : '#e1f5fe', color: isDark ? '#90caf9' : '#0277bd', cursor: 'pointer' }}>
                    文例 ー「{ex}」
                  </button>
                ))}
              </div>
            </div>

            {/* 通常シフト（休日出勤・欠勤選択時は非表示） */}
            {!hasHoliday && !hasAbsence && (
            <div style={{ background: cardBg, borderRadius: 10, padding: '12px 14px', marginBottom: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 'bold', color: subColor, marginBottom: 10 }}>📋 通常シフト（もともとの予定）</div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: textColor, marginBottom: 10, cursor: 'pointer' }}>
                <input type="checkbox" checked={origDayOff} onChange={e => setOrigDayOff(e.target.checked)}
                  style={{ width: 16, height: 16, accentColor: '#28a745', cursor: 'pointer' }} />
                もともと休みの日
              </label>
              {!origDayOff && (
                <>
                  <div style={{ marginBottom: 8 }}>
                    <label style={L}>勤務地 {Req}</label>
                    <select value={origLoc} onChange={e => setOrigLoc(e.target.value)} style={f}>
                      <option value="">選択してください</option>
                      {workplaces.map(w => <option key={w} value={w}>{w}</option>)}
                      <option value="その他">その他（自由入力）</option>
                    </select>
                    {origLoc === 'その他' && (
                      <input type="text" value={origLocCustom} onChange={e => setOrigLocCustom(e.target.value)}
                        placeholder="勤務地を入力してください" style={{ ...f, marginTop: 6 }} />
                    )}
                  </div>
                  <label style={L}>時間 {Req}</label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                    <input type="time" value={origStart} onChange={e => setOrigStart(e.target.value)} style={{ ...f, flex: 1 }} />
                    <span style={{ color: '#888', flexShrink: 0 }}>〜</span>
                    <input type="time" value={origEnd} onChange={e => setOrigEnd(e.target.value)} style={{ ...f, flex: 1 }} />
                  </div>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: textColor, cursor: 'pointer' }}>
                    <input type="checkbox" checked={origOutingOn} onChange={e => setOrigOutingOn(e.target.checked)}
                      style={{ width: 16, height: 16, accentColor: '#28a745', cursor: 'pointer' }} />
                    外出・戻りを入力する
                  </label>
                  {origOutingOn && (
                    <div style={{ marginTop: 8 }}>
                      <label style={L}>外出・戻り</label>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <input type="time" value={origOutingStart} onChange={e => setOrigOutingStart(e.target.value)} style={{ ...f, flex: 1 }} />
                        <span style={{ color: '#888', flexShrink: 0 }}>〜</span>
                        <input type="time" value={origOutingEnd} onChange={e => setOrigOutingEnd(e.target.value)} style={{ ...f, flex: 1 }} />
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
            )}

            {/* 実際のシフト */}
            {!hasAbsence && (
              <div style={{ background: cardBg2, borderRadius: 10, padding: '12px 14px', marginBottom: 12 }}>
                <div style={{ fontSize: 12, fontWeight: 'bold', color: subColor, marginBottom: 10 }}>✅ 実際に勤務した時間</div>
                <div style={{ marginBottom: 8 }}>
                  <label style={L}>勤務地・場所 {Req}</label>
                  <select value={actLoc} onChange={e => setActLoc(e.target.value)} style={f}>
                    <option value="">選択してください</option>
                    {workplaces.map(w => <option key={w} value={w}>{w}</option>)}
                    <option value="その他">その他（自由入力）</option>
                  </select>
                  {actLoc === 'その他' && (
                    <input type="text" value={actLocCustom} onChange={e => setActLocCustom(e.target.value)}
                      placeholder="勤務地を入力してください" style={{ ...f, marginTop: 6 }} />
                  )}
                </div>
                <label style={L}>時間 {Req}</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                  <input type="time" value={actStart} onChange={e => setActStart(e.target.value)} style={{ ...f, flex: 1 }} />
                  <span style={{ color: '#888', flexShrink: 0 }}>〜</span>
                  <input type="time" value={actEnd} onChange={e => setActEnd(e.target.value)} style={{ ...f, flex: 1 }} />
                </div>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: textColor, cursor: 'pointer', marginBottom: 8 }}>
                  <input type="checkbox" checked={actOutingOn} onChange={e => setActOutingOn(e.target.checked)}
                    style={{ width: 16, height: 16, accentColor: '#28a745', cursor: 'pointer' }} />
                  外出・戻りを入力する
                </label>
                {actOutingOn && (
                  <div style={{ marginBottom: 8 }}>
                    <label style={L}>外出・戻り</label>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <input type="time" value={actOutingStart} onChange={e => setActOutingStart(e.target.value)} style={{ ...f, flex: 1 }} />
                      <span style={{ color: '#888', flexShrink: 0 }}>〜</span>
                      <input type="time" value={actOutingEnd} onChange={e => setActOutingEnd(e.target.value)} style={{ ...f, flex: 1 }} />
                    </div>
                  </div>
                )}
                {actStart && actEnd && laborMin > 0 && (
                  <div style={{ background: isDark ? '#1e3d2f' : '#dcfce7', borderRadius: 8, padding: '8px 12px' }}>
                    <div style={{ fontSize: 12, color: isDark ? '#4ade80' : '#166534' }}>🕐 休憩 {breakMin}分{actOutingMin > 0 ? `　＋　外出 ${formatMin(actOutingMin)}` : ''}　／　実労働 {formatMin(laborMin)}</div>
                    {!origDayOff && !hasHoliday && origMin > 0 && (
                      <div style={{ marginTop: 4 }}>
                        {types.includes('early_start') && toMin(origStart) > toMin(actStart) && <div style={{ fontSize: 13, fontWeight: 'bold', color: '#0891b2' }}>🌅 早出：{formatMin(toMin(origStart) - toMin(actStart))}</div>}
                        {types.includes('tardiness') && toMin(actStart) > toMin(origStart) && <div style={{ fontSize: 13, fontWeight: 'bold', color: '#7b1fa2' }}>⏱️ 遅刻：{formatMin(toMin(actStart) - toMin(origStart))}</div>}
                        {types.includes('early_leave') && toMin(origEnd) > toMin(actEnd) && <div style={{ fontSize: 13, fontWeight: 'bold', color: '#c2410c' }}>🏃 早退：{formatMin(toMin(origEnd) - toMin(actEnd))}</div>}
                      </div>
                    )}
                  </div>
                )}
                <div style={{ marginTop: 10 }}>
                  <label style={L}>備考 <span style={{ fontWeight: 'normal', color: '#888' }}>（任意）</span></label>
                  <textarea value={actNotes} onChange={e => setActNotes(e.target.value)} rows={2}
                    placeholder="その他、連絡事項があれば入力"
                    style={{ ...f, resize: 'none' }} />
                </div>
              </div>
            )}

            {/* 確認依頼先 */}
            <div style={{ marginBottom: 14 }}>
              <label style={L}>確認依頼先 {Req}</label>
              <select value={reviewerId} onChange={e => setReviewerId(e.target.value)} style={f}>
                <option value="">選択してください</option>
                {/* 自分が承認者の場合は最上部に表示 */}
                {reviewers.find(r => r.id === user.id) && (
                  <option value={user.id}>
                    ✓ {reviewers.find(r => r.id === user.id)!.name}（自分）※申請と同時に受理されます
                  </option>
                )}
                {[...reviewers.filter(r => r.id !== user.id && r.role_title !== '管理者' && r.role_title !== '社長')]
                  .sort((a, b) => {
                    const ord: Record<string, number> = { 'リーダー': 0, 'マネージャー': 1, 'フロア責任者': 2 };
                    const aO = ord[a.role_title] ?? 99;
                    const bO = ord[b.role_title] ?? 99;
                    return aO !== bO ? aO - bO : a.name.localeCompare(b.name);
                  })
                  .map(r => <option key={r.id} value={r.id}>{r.name}（{r.role_title}）</option>)}
              </select>
            </div>

            {/* 修正コメント（編集時） */}
            {editTarget && (
              <div style={{ marginBottom: 14 }}>
                <label style={L}>修正内容 {Req}</label>
                <textarea value={changeSummary} onChange={e => setChangeSummary(e.target.value)} rows={2}
                  placeholder="例：退勤時刻を19:00→20:00に変更 理由：残業が延長したため"
                  style={{ ...f, resize: 'none' }} />
              </div>
            )}

            {error && <div style={{ color: '#dc3545', fontSize: 13, marginBottom: 12 }}>⚠️ {error}</div>}
            <button type="button" onClick={handleConfirmOpen}
              style={{ width: '100%', padding: 14, background: '#28a745', color: '#fff', border: 'none', borderRadius: 10, fontSize: 15, fontWeight: 'bold', cursor: 'pointer' }}>
              申請内容を確認する
            </button>
    </div>
  );

  const confirmModal = showConfirm ? (
    <ConfirmModal
      data={{ date, types, reason, origLoc: finalOrigLoc, origStart, origEnd, origDayOff: origDayOff || hasHoliday, origOutingOn, origOutingStart, origOutingEnd, actLoc: finalActLoc, actStart, actEnd, actOutingOn, actOutingStart, actOutingEnd, actNotes, breakMin, laborMin, reviewerName, isSelfReview: reviewerId === user.id, applicantName: applicantId === user.id ? (profileName ?? '') : (staffList.find(s => s.id === applicantId)?.name ?? ''), isProxy: applicantId !== user.id }}
      onBack={() => setShowConfirm(false)}
      onSubmit={handleSubmit}
      saving={saving}
    />
  ) : null;

  if (inline) {
    return (
      <>
        {formBody}
        {confirmModal}
      </>
    );
  }

  return (
    <>
      <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'flex-end' }}>
        <div style={{ background: modalBg, width: '100%', maxHeight: '92vh', borderRadius: '16px 16px 0 0', overflowY: 'auto', paddingBottom: 32 }}>
          <div style={{ position: 'sticky', top: 0, background: modalBg, padding: '16px 16px 12px', borderBottom: `1px solid ${borderCol}`, display: 'flex', alignItems: 'center', gap: 12, zIndex: 1 }}>
            <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: textColor, lineHeight: 1 }}>✕</button>
            <span style={{ fontWeight: 'bold', fontSize: 16, color: textColor }}>{editTarget ? '申請を修正' : '勤務変更申請'}</span>
          </div>
          {formBody}
        </div>
      </div>
      {confirmModal}
    </>
  );
};

// ────────────────────────────────────────────────────────────────
// Main Page
// ────────────────────────────────────────────────────────────────
const ShiftReportPage: React.FC<Props> = ({ user, profileName, roleTitle, isAdmin }) => {
  const isDark = useDarkMode();
  const bg        = isDark ? '#343a40' : 'white';
  const text      = isDark ? '#fff' : '#1a1a2e';
  const subText   = isDark ? '#adb5bd' : '#666';
  const borderCol = isDark ? '#495057' : '#dee2e6';
  const cardShadow = isDark ? '0 2px 12px rgba(0,0,0,0.4)' : '0 2px 12px rgba(0,0,0,0.1)';
  const inactiveBg = isDark ? '#495057' : '#f8f9fa';
  const noteBg    = isDark ? '#1a2e3a' : '#e8f4fd';
  const noteBorder = isDark ? '#2d5a6e' : '#bee5eb';
  const noteText  = isDark ? '#90cdf4' : '#2c5f6e';
  const noteTitleColor = isDark ? '#90cdf4' : '#1a4a5a';
  const noteBtn   = isDark ? '#2d5a6e' : '#bee5eb';

  const isApprover = IS_APPROVER(roleTitle, isAdmin);
  const canSeeAll  = isAdmin || ['リーダー', 'マネージャー', '管理者'].includes(roleTitle);

  const [searchParams] = useSearchParams();
  const [tab, setTab]                   = useState<'apply' | 'history'>(searchParams.get('tab') === 'history' ? 'history' : 'apply');
  const [formKey, setFormKey]           = useState(0);
  const [cancelTarget, setCancelTarget] = useState<ShiftReport | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  const [confirmView, setConfirmView]   = useState(searchParams.get('view') === 'confirm');
  const [showForm, setShowForm]         = useState(false);
  const [editTarget, setEditTarget]     = useState<ShiftReport | null>(null);
  const [myReports, setMyReports]       = useState<ShiftReport[]>([]);
  const [pendingReports, setPendingReports] = useState<ShiftReport[]>([]);
  const [openPeriods, setOpenPeriods]   = useState<Set<string>>(new Set());
  const [successMsg, setSuccessMsg]     = useState('');
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [showReviewerGuide, setShowReviewerGuide] = useState(false);
  const [showAllBreakRules, setShowAllBreakRules] = useState(false);
  const [reviewers, setReviewers]       = useState<Reviewer[]>([]);
  const [workplaces, setWorkplaces]     = useState<string[]>([]);
  const [leaderAssignments, setLeaderAssignments] = useState<LeaderAssignment[]>([]);
  const [loadingAssignments, setLoadingAssignments] = useState(true);

  // 差戻し
  const [returnTarget, setReturnTarget] = useState<ShiftReport | null>(null);
  const [returnComment, setReturnComment] = useState('');
  const [returningId, setReturningId]   = useState<string | null>(null);

  // 履歴タブ モード
  const [histMode, setHistMode] = useState<'own' | 'reviewed' | 'proxy' | 'all'>(
    () => !IS_APPROVER(roleTitle, isAdmin) ? 'own'
        : (isAdmin || ['リーダー', 'マネージャー', '管理者'].includes(roleTitle)) ? 'all'
        : 'reviewed'
  );
  const [reviewedReports, setReviewedReports] = useState<ShiftReport[]>([]);
  const [proxyReports, setProxyReports]       = useState<ShiftReport[]>([]);
  const [allReports, setAllReports]           = useState<ShiftReport[]>([]);
  const [histGroupFilter, setHistGroupFilter] = useState('all');
  const [histStatusFilter, setHistStatusFilter] = useState('all');
  const [groupOptions, setGroupOptions] = useState<string[]>([]);
  const [groupMap, setGroupMap]         = useState<Record<string, string[]>>({});

  const fetchMyReports = useCallback(async () => {
    const { data } = await supabase
      .from('shift_reports')
      .select('*')
      .eq('applicant_id', user.id)
      .order('work_date', { ascending: false });
    if (data) {
      setMyReports(data as ShiftReport[]);
      if (data.length > 0) setOpenPeriods(new Set([data[0].pay_period_start]));
    }
  }, [user.id]);

  const fetchPending = useCallback(async () => {
    if (!isApprover) return;
    const { data } = await supabase
      .from('shift_reports')
      .select('*')
      .eq('reviewer_id', user.id)
      .in('status', ['pending', 'resubmitted'])
      .order('work_date', { ascending: false });
    if (!data || data.length === 0) { setPendingReports([]); return; }
    // profiles を別クエリで取得（FK がないため）
    const ids = [...new Set(data.map((r: ShiftReport) => r.applicant_id))];
    const { data: profs } = await supabase.from('profiles').select('id, name').in('id', ids);
    const nameMap = Object.fromEntries((profs || []).map((p: { id: string; name: string }) => [p.id, p.name]));
    setPendingReports(data.map((r: ShiftReport) => ({ ...r, applicant: { name: nameMap[r.applicant_id] ?? '不明' } })) as ShiftReport[]);
  }, [isApprover, user.id]);

  const fetchReviewedReports = useCallback(async () => {
    if (!isApprover) return;
    const { data } = await supabase.from('shift_reports').select('*').eq('reviewer_id', user.id).order('work_date', { ascending: false });
    if (!data || data.length === 0) { setReviewedReports([]); return; }
    const ids = [...new Set(data.map((r: ShiftReport) => r.applicant_id))];
    const { data: profs } = await supabase.from('profiles').select('id, name').in('id', ids);
    const nm = Object.fromEntries((profs || []).map((p: { id: string; name: string }) => [p.id, p.name]));
    setReviewedReports(data.map((r: ShiftReport) => ({ ...r, applicant: { name: nm[r.applicant_id] ?? '不明' } })));
  }, [isApprover, user.id]);

  const fetchProxyReports = useCallback(async () => {
    if (!isApprover) return;
    const { data } = await supabase.from('shift_reports').select('*').eq('submitted_by', user.id).neq('applicant_id', user.id).order('work_date', { ascending: false });
    if (!data || data.length === 0) { setProxyReports([]); return; }
    const ids = [...new Set(data.map((r: ShiftReport) => r.applicant_id))];
    const { data: profs } = await supabase.from('profiles').select('id, name').in('id', ids);
    const nm = Object.fromEntries((profs || []).map((p: { id: string; name: string }) => [p.id, p.name]));
    setProxyReports(data.map((r: ShiftReport) => ({ ...r, applicant: { name: nm[r.applicant_id] ?? '不明' } })));
  }, [isApprover, user.id]);

  const fetchAllReports = useCallback(async () => {
    if (!canSeeAll) return;
    const { data } = await supabase.from('shift_reports').select('*').order('work_date', { ascending: false });
    if (!data || data.length === 0) { setAllReports([]); return; }
    const ids = [...new Set(data.map((r: ShiftReport) => r.applicant_id))];
    const { data: profs } = await supabase.from('profiles').select('id, name, group_names').in('id', ids);
    const nm = Object.fromEntries((profs || []).map((p: { id: string; name: string }) => [p.id, p.name]));
    const gm: Record<string, string[]> = {};
    (profs || []).forEach((p: { id: string; group_names?: string[] }) => { gm[p.id] = p.group_names ?? []; });
    setGroupMap(gm);
    setAllReports(data.map((r: ShiftReport) => ({ ...r, applicant: { name: nm[r.applicant_id] ?? '不明' } })));
  }, [canSeeAll, user.id]);

  useEffect(() => {
    fetchMyReports();
    fetchPending();
    fetchReviewedReports();
    fetchProxyReports();
    fetchAllReports();
    supabase.from('master_options').select('value').eq('category', 'workplace').order('sort_order')
      .then(({ data }) => { if (data) setWorkplaces(data.map(r => r.value)); });
    supabase.from('profiles').select('id, name, role_title').in('role_title', REVIEWER_ROLES).eq('is_active', true).order('role_title').order('name')
      .then(({ data }) => { if (data) setReviewers(data as Reviewer[]); });
    supabase.from('leader_assignments').select('id, course, school, leader, manager').order('display_order', { ascending: true })
      .then(({ data }) => { if (data) setLeaderAssignments(data as LeaderAssignment[]); setLoadingAssignments(false); });
    supabase.from('master_options').select('value').eq('category', 'shift_report_group').order('sort_order')
      .then(({ data }) => { if (data) setGroupOptions(data.map((r: { value: string }) => r.value)); });
  }, [fetchMyReports, fetchPending, fetchReviewedReports, fetchProxyReports, fetchAllReports]);

  const handleSaved = () => {
    setShowForm(false); setEditTarget(null);
    setFormKey(k => k + 1);
    setSuccessMsg('申請を送信しました ✓');
    fetchMyReports(); fetchPending(); fetchReviewedReports(); fetchProxyReports(); fetchAllReports();
    setTab('history');
  };

  const handleConfirm = async (report: ShiftReport) => {
    setConfirmingId(report.id);
    await supabase.from('shift_reports').update({
      status: 'confirmed', confirmed_by: user.id, confirmed_at: new Date().toISOString()
    }).eq('id', report.id);
    // 通知：申請者へ受理を通知
    await supabase.from('notifications').insert({
      user_id: report.applicant_id,
      message: `勤務変更申請が受理されました`,
      sub_message: `${TYPE_INFO[report.application_type].label}　${report.work_date}`,
      source_type: 'shift_report',
      reference_id: report.id,
      read: false,
    }).then(null, () => {});
    // 通知：同グループの該当役職者へ一斉通知（管理画面「勤務変更申請」設定に従う）
    supabase.functions.invoke('shift-report-confirmed-notify', {
      body: {
        user_id: report.applicant_id,
        user_name: report.applicant?.name ?? '',
        date: report.work_date,
        types: report.application_types?.length ? report.application_types : [report.application_type],
        location: report.actual_location ?? report.original_location ?? '',
      },
    }).then(null, () => {});
    setConfirmingId(null);
    setSuccessMsg('受理しました ✓');
    fetchPending(); fetchMyReports();
  };

  const executeCancelReport = async () => {
    if (!cancelTarget) return;
    const r = cancelTarget;
    const summary = cancelReason.trim() ? `申請を取り消しました\n取り消し理由：${cancelReason.trim()}` : '申請を取り消しました';
    const { error } = await supabase.from('shift_reports').update({ status: 'cancelled' }).eq('id', r.id);
    if (error) { console.error('[cancelReport]', error); setCancelTarget(null); setCancelReason(''); return; }
    await supabase.from('shift_report_history').insert({ report_id: r.id, changed_by: user.id, change_summary: summary, snapshot: r }).then(null, () => {});
    // レビュアーが取り消した場合は申請者に通知
    if (r.applicant_id !== user.id) {
      await supabase.from('notifications').insert({
        user_id: r.applicant_id, message: '勤務変更申請が取り消されました',
        sub_message: `${TYPE_INFO[r.application_type].label}　${r.work_date}`,
        source_type: 'shift_report', reference_id: r.id, read: false,
      }).then(null, () => {});
    }
    setCancelTarget(null); setCancelReason('');
    fetchMyReports(); fetchPending(); fetchReviewedReports(); fetchProxyReports(); fetchAllReports();
    setSuccessMsg('取り消しました');
  };

  const handleReturn = async () => {
    if (!returnTarget) return;
    const r = returnTarget;
    setReturningId(r.id);
    await supabase.from('shift_reports').update({ status: 'returned' }).eq('id', r.id);
    const comment = returnComment.trim();
    await supabase.from('shift_report_history').insert({
      report_id: r.id, changed_by: user.id,
      change_summary: comment ? `差戻し：${comment}` : '差戻しました', snapshot: r,
    }).then(null, () => {});
    await supabase.from('notifications').insert({
      user_id: r.applicant_id, message: '勤務変更申請が差戻されました',
      sub_message: `${TYPE_INFO[r.application_type].label}　${r.work_date}${comment ? `\n理由：${comment}` : ''}`,
      source_type: 'shift_report:pending_resubmit', reference_id: r.id, read: false,
    }).then(null, () => {});
    setReturningId(null); setReturnTarget(null); setReturnComment('');
    fetchPending(); fetchReviewedReports(); fetchAllReports();
    setSuccessMsg('差戻しました');
  };

  const hardDeleteReport = async (r: ShiftReport) => {
    if (!window.confirm(`「${TYPE_INFO[r.application_type].label}」を完全削除しますか？この操作は取り消せません。`)) return;
    await supabase.from('shift_report_history').delete().eq('report_id', r.id);
    await supabase.from('shift_reports').delete().eq('id', r.id);
    fetchMyReports(); fetchPending();
    setSuccessMsg('削除しました');
  };

  const histReports = React.useMemo(() => {
    let base = histMode === 'own' ? myReports
      : histMode === 'reviewed' ? reviewedReports
      : histMode === 'proxy'    ? proxyReports
      : allReports;
    if (histStatusFilter !== 'all') base = base.filter(r => r.status === histStatusFilter);
    if (histMode === 'all' && histGroupFilter !== 'all') {
      base = base.filter(r => (groupMap[r.applicant_id] ?? []).includes(histGroupFilter));
    }
    return base;
  }, [histMode, myReports, reviewedReports, proxyReports, allReports, histStatusFilter, histGroupFilter, groupMap]);

  const histGrouped = histReports.reduce<Record<string, ShiftReport[]>>((acc, r) => {
    if (!acc[r.pay_period_start]) acc[r.pay_period_start] = [];
    acc[r.pay_period_start].push(r);
    return acc;
  }, {});

  const togglePeriod = (key: string) => {
    setOpenPeriods(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
  };

  // ─── 確認ページ（承認者専用ビュー）───
  if (confirmView) {
    return (
      <div style={{ paddingTop: 70, maxWidth: 600, margin: '0 auto', paddingBottom: 24 }}>
        {successMsg && <BannerSuccess message={successMsg} onClose={() => setSuccessMsg('')} />}
        <div style={{ padding: '16px 16px 0' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
            <button onClick={() => setConfirmView(false)} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: text }}>‹</button>
            <span style={{ fontWeight: 'bold', fontSize: 16, color: text }}>確認ページ</span>
            {pendingReports.length > 0 && (
              <span style={{ background: '#dc3545', color: '#fff', borderRadius: 10, fontSize: 11, padding: '2px 8px', fontWeight: 'bold' }}>{pendingReports.length}件</span>
            )}
          </div>
          {pendingReports.length === 0 ? (
            <div style={{ textAlign: 'center', color: '#aaa', padding: 48, fontSize: 14 }}>確認待ちの申請はありません</div>
          ) : pendingReports.map(r => {
            return (
              <div key={r.id} style={{ background: bg, borderRadius: 10, border: `1px solid ${borderCol}`, marginBottom: 10, padding: '14px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <span style={{ fontSize: 13, fontWeight: 'bold', color: text }}>{(r.applicant as { name: string | null } | null)?.name ?? '不明'}</span>
                  <span style={{ fontSize: 11, color: '#888' }}>{r.work_date.slice(5).replace('-', '/')}（{dow(r.work_date)}）</span>
                  <span style={{ fontSize: 11, fontWeight: 'bold', color: TYPE_INFO[r.application_type].color, marginLeft: 'auto' }}>
                    {(r.application_types?.length ? r.application_types : [r.application_type]).map(t => `${TYPE_INFO[t].emoji} ${TYPE_INFO[t].label}`).join(' ＋ ')}
                  </span>
                </div>
                {r.original_start
                  ? <div style={{ fontSize: 12, color: '#555', marginBottom: 2 }}>変更前：{r.original_location} {r.original_start.slice(0, 5)}〜{r.original_end?.slice(0, 5)}{r.original_outing_start && `（外出 ${r.original_outing_start.slice(0, 5)}〜${r.original_outing_end?.slice(0, 5)}）`}</div>
                  : (r.application_type !== 'holiday_work' && r.application_type !== 'absence')
                    ? <div style={{ fontSize: 12, color: '#aaa', marginBottom: 2 }}>変更前：もともと休みの日</div>
                    : null
                }
                {r.actual_start && (
                  <div style={{ fontSize: 12, color: isDark ? '#4ade80' : '#166534', marginBottom: 4 }}>
                    変更後：{r.actual_location} {r.actual_start.slice(0, 5)}〜{r.actual_end?.slice(0, 5)}{r.actual_outing_start && `（外出 ${r.actual_outing_start.slice(0, 5)}〜${r.actual_outing_end?.slice(0, 5)}）`}　休憩 {r.break_minutes ?? 0}分　実労働 {r.labor_minutes ? formatMin(r.labor_minutes) : '-'}
                  </div>
                )}
                <div style={{ fontSize: 12, color: '#888', marginBottom: 10 }}>{r.reason}</div>
                {r.status === 'resubmitted' && (
                  <div style={{ fontSize: 11, color: '#9d174d', background: '#fce7f3', borderRadius: 6, padding: '4px 8px', marginBottom: 8 }}>⚠️ 修正されました（再確認をお願いします）</div>
                )}
                <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                  <button onClick={() => handleConfirm(r)} disabled={confirmingId === r.id}
                    style={{ flex: 2, padding: '10px 0', background: confirmingId === r.id ? '#6c757d' : '#28a745', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 'bold', cursor: confirmingId === r.id ? 'default' : 'pointer' }}>
                    {confirmingId === r.id ? '処理中...' : '✓ 受理'}
                  </button>
                  <button onClick={() => { setEditTarget(r); setShowForm(true); }}
                    style={{ flex: 1, padding: '10px 0', background: 'none', border: `1px solid ${borderCol}`, borderRadius: 8, fontSize: 13, color: text, cursor: 'pointer' }}>
                    修正
                  </button>
                  <button onClick={() => { setReturnTarget(r); setReturnComment(''); }}
                    style={{ flex: 1, padding: '10px 0', background: '#fff3cd', border: '1px solid #ffc107', borderRadius: 8, fontSize: 13, color: '#856404', cursor: 'pointer' }}>
                    差戻
                  </button>
                  <button onClick={() => { setCancelTarget(r); setCancelReason(''); }}
                    style={{ flex: 1, padding: '10px 0', background: 'none', border: '1px solid #dc3545', borderRadius: 8, fontSize: 13, color: '#dc3545', cursor: 'pointer' }}>
                    取消
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // ─── 通常ページ ───
  return (
    <div style={{ paddingTop: 70, maxWidth: 600, margin: '0 auto', paddingBottom: 32 }}>
      {successMsg && <BannerSuccess message={successMsg} onClose={() => setSuccessMsg('')} />}

      {/* ページタイトル */}
      <div style={{ textAlign: 'center', padding: '16px 0 16px' }}>
        <div style={{ fontSize: 13, color: subText, fontWeight: 'bold', marginBottom: 4 }}>パート・アルバイト</div>
        <h1 style={{ fontSize: 20, fontWeight: 'bold', color: text, margin: 0 }}>⏰ 勤務変更申請</h1>
      </div>

      <div style={{ padding: '0 16px' }}>
        {/* タブ（休暇申請と同スタイル） */}
        <div style={{ display: 'flex', marginBottom: 0, borderRadius: '10px 10px 0 0', overflow: 'hidden', boxShadow: '0 2px 8px rgba(0,0,0,0.08)' }}>
          <button onClick={() => setTab('apply')}
            style={{ flex: 1, padding: '12px', background: tab === 'apply' ? '#28a745' : inactiveBg, color: tab === 'apply' ? '#fff' : text, border: 'none', cursor: 'pointer', fontSize: 15, fontWeight: tab === 'apply' ? 'bold' : 'normal' }}>
            ✏️ 申請
          </button>
          <button onClick={() => setTab('history')}
            style={{ flex: 1, padding: '12px', background: tab === 'history' ? '#28a745' : inactiveBg, color: tab === 'history' ? '#fff' : text, border: 'none', cursor: 'pointer', fontSize: 15, fontWeight: tab === 'history' ? 'bold' : 'normal', borderLeft: `1px solid ${borderCol}` }}>
            📋 履歴
          </button>
        </div>

        {/* 確認ページへ（承認者のみ・タブ直下） */}
        {isApprover && (
          <button onClick={() => setConfirmView(true)}
            style={{ width: '100%', padding: '10px', background: '#fd7e14', color: 'white', border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: 'bold', marginTop: 8, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, boxSizing: 'border-box' }}>
            <span>✅ 確認ページへ</span>
            {pendingReports.length > 0 && (
              <span style={{ background: '#fff', color: '#fd7e14', borderRadius: 10, padding: '1px 8px', fontSize: 12, fontWeight: 'bold' }}>{pendingReports.length}件</span>
            )}
          </button>
        )}

        {/* ─ 申請タブ ─ */}
        {tab === 'apply' && (
          <div style={{ padding: 24, background: bg, borderRadius: '0 0 12px 12px', boxShadow: cardShadow, boxSizing: 'border-box' }}>
            {/* 注意事項（常時表示） */}
            <div style={{ background: noteBg, border: `1px solid ${noteBorder}`, borderRadius: 8, padding: '12px 14px', marginBottom: 20, textAlign: 'left' }}>
              <p style={{ fontSize: 13, fontWeight: 'bold', color: noteTitleColor, marginBottom: 8, marginTop: 0 }}>【注意事項】</p>
              <ol style={{ margin: 0, paddingLeft: 20, fontSize: 12, color: noteText, lineHeight: 1.8 }}>
                <li>残業・早退・遅刻・欠勤が発生した場合に申請してください。</li>
                <li>申請先は、出勤する校の担当のリーダー・マネージャー（フロア責任者）を選択してください。</li>
                <li>受理されると「受理済み」に変わります。</li>
                <li>間違えた場合は、担当のリーダー・マネージャーにお知らせください。</li>
              </ol>

              <button type="button" onClick={() => setShowReviewerGuide(v => !v)}
                style={{ marginTop: 10, padding: '6px 12px', fontSize: 12, fontWeight: 'bold', background: noteBtn, color: noteTitleColor, border: 'none', borderRadius: 6, cursor: 'pointer' }}>
                {showReviewerGuide ? '▲ 勤務校リーダー・マネージャー 一覧を閉じる' : '▼ 勤務校リーダー・マネージャー 一覧を表示'}
              </button>

              {showReviewerGuide && (
                <div style={{ marginTop: 10, padding: '12px 14px', borderRadius: 8, background: bg, border: `1px solid ${noteBorder}`, fontSize: 12, lineHeight: 1.8, color: noteText }}>
                  {loadingAssignments ? (
                    <p style={{ margin: 0 }}>読み込み中...</p>
                  ) : leaderAssignments.length === 0 ? (
                    <p style={{ margin: 0 }}>担当者情報が登録されていません。</p>
                  ) : (() => {
                    const th: React.CSSProperties = { textAlign: 'left', padding: '8px', background: noteBg, fontWeight: 'bold', fontSize: 11, color: noteTitleColor };
                    const td: React.CSSProperties = { padding: '7px 8px', borderBottom: `1px solid ${noteBorder}`, verticalAlign: 'middle', color: noteText, fontSize: 11 };
                    const sectionTd: React.CSSProperties = { padding: '6px 8px', background: '#1a4a5a', color: '#fff', fontWeight: 'bold', fontSize: 11 };
                    const courses: string[] = [];
                    leaderAssignments.forEach(a => { if (!courses.includes(a.course)) courses.push(a.course); });
                    return (
                      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                        <colgroup><col style={{ width: '32%' }} /><col style={{ width: '38%' }} /><col style={{ width: '30%' }} /></colgroup>
                        <thead><tr><th style={th}>校・コース</th><th style={th}>リーダー</th><th style={th}>マネージャー</th></tr></thead>
                        <tbody>
                          {courses.map(course => (
                            <React.Fragment key={course}>
                              <tr><td colSpan={3} style={sectionTd}>【{course}】</td></tr>
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

              <div style={{ marginTop: 10, padding: '12px 14px', borderRadius: 8, background: bg, border: `1px solid ${noteBorder}`, fontSize: 12, lineHeight: 1.9, color: noteText }}>
                <p style={{ margin: '0 0 6px', fontWeight: 'bold', color: noteTitleColor }}>《 休憩時間ルール 》</p>
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  <li>昼休憩をはさむ（12:59までに出勤する）場合は、休憩時間の最低時間単位は0:30</li>
                  {showAllBreakRules && (
                    <>
                      <li>（13:00以降に出勤する場合に限り）勤務時間が5:45を超え、6:15までの場合は0:15</li>
                      <li>勤務時間が6:15を超え、6:30までの場合は0:30</li>
                      <li>勤務時間が6:30を超え、8:45までの場合は0:45</li>
                      <li>勤務時間が8:45を超える場合は1:00</li>
                    </>
                  )}
                </ul>
                <button type="button" onClick={() => setShowAllBreakRules(v => !v)}
                  style={{ marginTop: 6, padding: 0, fontSize: 12, fontWeight: 'bold', background: 'none', color: noteTitleColor, border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>
                  {showAllBreakRules ? '▲ 閉じる' : '▼ 休憩時間ルールを全て表示'}
                </button>
              </div>
            </div>

            {/* インライン申請フォーム（key で申請後リセット） */}
            <ShiftReportForm
              key={formKey}
              user={user} profileName={profileName} roleTitle={roleTitle} isAdmin={isAdmin}
              editTarget={null}
              reviewers={reviewers}
              workplaces={workplaces}
              leaderAssignments={leaderAssignments}
              inline={true}
              onClose={() => {}}
              onSaved={handleSaved}
            />
          </div>
        )}

        {/* ─ 履歴タブ ─ */}
        {tab === 'history' && (
          <div style={{ background: bg, borderRadius: '0 0 12px 12px', boxShadow: cardShadow, padding: '16px', boxSizing: 'border-box' }}>

            {/* モードチップ（承認者のみ） */}
            {isApprover && (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
                {([
                  ['own',      '自分の申請'],
                  ['reviewed', '確認した申請'],
                  ['proxy',    '代行した申請'],
                  ...(canSeeAll ? [['all', '全スタッフ']] : []),
                ] as [typeof histMode, string][]).map(([key, label]) => (
                  <button key={key} onClick={() => setHistMode(key)}
                    style={{ fontSize: 12, padding: '4px 12px', borderRadius: 20, border: histMode === key ? '1.5px solid #28a745' : `1px solid ${borderCol}`, background: histMode === key ? '#d1fae5' : 'transparent', color: histMode === key ? '#065f46' : subText, cursor: 'pointer', fontWeight: histMode === key ? 'bold' : 'normal' }}>
                    {label}
                  </button>
                ))}
              </div>
            )}

            {/* フィルタ行（全スタッフ時のグループ + ステータス） */}
            {(histMode === 'all' || isApprover) && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12, alignItems: 'center' }}>
                {histMode === 'all' && groupOptions.length > 0 && (
                  <select value={histGroupFilter} onChange={e => setHistGroupFilter(e.target.value)}
                    style={{ fontSize: 12, padding: '4px 8px', borderRadius: 8, border: `1px solid ${borderCol}`, background: isDark ? '#495057' : '#fff', color: text }}>
                    <option value="all">全グループ</option>
                    {groupOptions.map(g => <option key={g} value={g}>{g}</option>)}
                  </select>
                )}
                <select value={histStatusFilter} onChange={e => setHistStatusFilter(e.target.value)}
                  style={{ fontSize: 12, padding: '4px 8px', borderRadius: 8, border: `1px solid ${borderCol}`, background: isDark ? '#495057' : '#fff', color: text }}>
                  <option value="all">全ステータス</option>
                  <option value="pending">申請中</option>
                  <option value="confirmed">受理済み</option>
                  <option value="returned">差戻し</option>
                  <option value="cancelled">取消済み</option>
                </select>
              </div>
            )}

            {Object.keys(histGrouped).sort((a, b) => b.localeCompare(a)).map(period => (
              <div key={period} style={{ borderRadius: 10, border: `1px solid ${borderCol}`, marginBottom: 8, overflow: 'hidden' }}>
                <div onClick={() => togglePeriod(period)} style={{ display: 'flex', alignItems: 'center', padding: '12px 14px', cursor: 'pointer', background: inactiveBg }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 'bold', color: text }}>{payPeriodLabel(period)}</div>
                    <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>{period.slice(5).replace('-', '/')} 〜 翌月15日　{histGrouped[period].length}件</div>
                  </div>
                  <span style={{ fontSize: 12, color: '#aaa', display: 'inline-block', transform: openPeriods.has(period) ? 'rotate(180deg)' : 'none' }}>▼</span>
                </div>
                {openPeriods.has(period) && (
                  <div style={{ background: bg }}>
                    {histGrouped[period].map(r => {
                      const oMin = origDuration(r.original_start?.slice(0, 5) ?? null, r.original_end?.slice(0, 5) ?? null);
                      const dMin = r.labor_minutes != null ? r.labor_minutes - oMin : null;
                      return (
                        <div key={r.id} style={{ padding: '10px 14px', borderBottom: `1px solid ${isDark ? '#495057' : '#f5f5f5'}`, display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                          <div style={{ fontSize: 11, color: isDark ? '#adb5bd' : '#555', minWidth: 52, flexShrink: 0, marginTop: 2 }}>
                            {r.work_date.slice(5).replace('-', '/')}（{dow(r.work_date)}）
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            {histMode !== 'own' && (
                              <div style={{ fontSize: 12, fontWeight: 'bold', color: text, marginBottom: 2 }}>
                                {(r.applicant as { name: string | null } | null)?.name ?? '不明'}
                              </div>
                            )}
                            <div style={{ fontSize: 11, fontWeight: 'bold', color: TYPE_INFO[r.application_type].color, marginBottom: 2 }}>
                              {(r.application_types?.length ? r.application_types : [r.application_type]).map(t => `${TYPE_INFO[t].emoji} ${TYPE_INFO[t].label}`).join(' ＋ ')}
                            </div>
                            {r.original_start
                              ? <div style={{ fontSize: 11, color: isDark ? '#adb5bd' : '#888' }}>変更前：{r.original_location} {r.original_start.slice(0, 5)}〜{r.original_end?.slice(0, 5)}{r.original_outing_start && `（外出 ${r.original_outing_start.slice(0, 5)}〜${r.original_outing_end?.slice(0, 5)}）`}</div>
                              : (r.application_type !== 'holiday_work' && r.application_type !== 'absence')
                                ? <div style={{ fontSize: 11, color: isDark ? '#adb5bd' : '#bbb' }}>変更前：もともと休みの日</div>
                                : null
                            }
                            {r.actual_start && (
                              <div style={{ fontSize: 11, color: isDark ? '#4ade80' : '#166534' }}>
                                変更後：{r.actual_location ? `${r.actual_location}　` : ''}{r.actual_start.slice(0, 5)}〜{r.actual_end?.slice(0, 5)}{r.actual_outing_start && `（外出 ${r.actual_outing_start.slice(0, 5)}〜${r.actual_outing_end?.slice(0, 5)}）`}　休憩 {r.break_minutes ?? 0}分　実労働 {r.labor_minutes ? formatMin(r.labor_minutes) : '-'}
                                {dMin != null && oMin > 0 && r.application_type === 'tardiness' && (
                                  <span style={{ marginLeft: 4, color: isDark ? '#c084fc' : '#7b1fa2', fontWeight: 'bold' }}>
                                    ／遅刻 {formatMin(Math.abs(Math.min(0, dMin)))}
                                  </span>
                                )}
                              </div>
                            )}
                            <div style={{ fontSize: 11, color: isDark ? '#adb5bd' : '#888', marginTop: 2 }}>{r.reason}</div>
                          </div>
                          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, flexShrink: 0 }}>
                            <span style={{ fontSize: 10, fontWeight: 'bold', color: (STATUS_INFO[r.status] ?? STATUS_INFO['pending']).color, background: (STATUS_INFO[r.status] ?? STATUS_INFO['pending']).bg, borderRadius: 10, padding: '2px 8px', whiteSpace: 'nowrap' }}>
                              {(STATUS_INFO[r.status] ?? STATUS_INFO['pending']).label}
                            </span>
                            {!['cancelled'].includes(r.status) && (
                              <button onClick={() => { setEditTarget(r); setShowForm(true); }}
                                style={{ fontSize: 11, color: '#28a745', background: 'none', border: '1px solid #28a745', borderRadius: 6, padding: '2px 8px', cursor: 'pointer' }}>
                                修正
                              </button>
                            )}
                            {!['cancelled'].includes(r.status) && (
                              <button onClick={() => { setCancelTarget(r); setCancelReason(''); }}
                                style={{ fontSize: 11, color: '#dc3545', background: 'none', border: '1px solid #dc3545', borderRadius: 6, padding: '2px 8px', cursor: 'pointer' }}>
                                取消
                              </button>
                            )}
                            {isAdmin && (
                              <button onClick={() => hardDeleteReport(r)}
                                style={{ fontSize: 11, color: '#6c757d', background: 'none', border: '1px solid #6c757d', borderRadius: 6, padding: '2px 8px', cursor: 'pointer' }}>
                                完全削除
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ))}
            {Object.keys(histGrouped).length === 0 && (
              <div style={{ textAlign: 'center', color: '#aaa', padding: 48, fontSize: 14 }}>申請履歴がありません</div>
            )}
          </div>
        )}
      </div>

      {/* 取り消し理由モーダル */}
      {cancelTarget && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 16px' }}>
          <div style={{ background: isDark ? '#343a40' : '#fff', borderRadius: 14, padding: 24, width: '100%', maxWidth: 340, boxShadow: '0 4px 24px rgba(0,0,0,0.2)' }}>
            <div style={{ fontSize: 15, fontWeight: 'bold', color: isDark ? '#fff' : '#1a1a2e', marginBottom: 6 }}>
              申請を取り消す
            </div>
            <div style={{ fontSize: 13, color: isDark ? '#adb5bd' : '#555', marginBottom: 16 }}>
              {(cancelTarget.application_types?.length ? cancelTarget.application_types : [cancelTarget.application_type]).map(t => `${TYPE_INFO[t].emoji} ${TYPE_INFO[t].label}`).join(' ＋ ')}　{cancelTarget.work_date.slice(5).replace('-', '/')}
            </div>
            <label style={{ fontSize: 12, color: isDark ? '#adb5bd' : '#666', display: 'block', marginBottom: 6 }}>
              取り消し理由（任意）
            </label>
            <textarea
              value={cancelReason}
              onChange={e => setCancelReason(e.target.value)}
              rows={3}
              placeholder="例：日程変更になったため"
              style={{ width: '100%', padding: '9px 12px', borderRadius: 8, border: `1px solid ${isDark ? '#6c757d' : '#ddd'}`, fontSize: 14, boxSizing: 'border-box', background: isDark ? '#495057' : '#fff', color: isDark ? '#fff' : '#333', resize: 'none' }}
            />
            <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
              <button type="button" onClick={() => { setCancelTarget(null); setCancelReason(''); }}
                style={{ flex: 1, padding: '10px', borderRadius: 8, border: `1px solid ${isDark ? '#6c757d' : '#ddd'}`, background: 'none', color: isDark ? '#adb5bd' : '#555', fontSize: 14, cursor: 'pointer' }}>
                閉じる
              </button>
              <button type="button" onClick={executeCancelReport}
                style={{ flex: 1, padding: '10px', borderRadius: 8, border: 'none', background: '#dc3545', color: '#fff', fontSize: 14, fontWeight: 'bold', cursor: 'pointer' }}>
                取り消す
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 差戻しコメントモーダル */}
      {returnTarget && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 16px' }}>
          <div style={{ background: isDark ? '#343a40' : '#fff', borderRadius: 14, padding: 24, width: '100%', maxWidth: 340, boxShadow: '0 4px 24px rgba(0,0,0,0.2)' }}>
            <div style={{ fontSize: 15, fontWeight: 'bold', color: isDark ? '#fff' : '#1a1a2e', marginBottom: 6 }}>差戻し</div>
            <div style={{ fontSize: 13, color: isDark ? '#adb5bd' : '#555', marginBottom: 16 }}>
              {(returnTarget.application_types?.length ? returnTarget.application_types : [returnTarget.application_type]).map(t => `${TYPE_INFO[t].emoji} ${TYPE_INFO[t].label}`).join(' ＋ ')}　{returnTarget.work_date.slice(5).replace('-', '/')}
              <br /><span style={{ fontSize: 12 }}>（{(returnTarget.applicant as { name: string | null } | null)?.name ?? '不明'}）</span>
            </div>
            <label style={{ fontSize: 12, color: isDark ? '#adb5bd' : '#666', display: 'block', marginBottom: 6 }}>差戻し理由（任意・本人に通知されます）</label>
            <textarea
              value={returnComment}
              onChange={e => setReturnComment(e.target.value)}
              rows={3}
              placeholder="例：時間の記録を確認してください"
              style={{ width: '100%', padding: '9px 12px', borderRadius: 8, border: `1px solid ${isDark ? '#6c757d' : '#ddd'}`, fontSize: 14, boxSizing: 'border-box', background: isDark ? '#495057' : '#fff', color: isDark ? '#fff' : '#333', resize: 'none' }}
            />
            <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
              <button type="button" onClick={() => { setReturnTarget(null); setReturnComment(''); }}
                style={{ flex: 1, padding: '10px', borderRadius: 8, border: `1px solid ${isDark ? '#6c757d' : '#ddd'}`, background: 'none', color: isDark ? '#adb5bd' : '#555', fontSize: 14, cursor: 'pointer' }}>
                閉じる
              </button>
              <button type="button" onClick={handleReturn} disabled={returningId === returnTarget.id}
                style={{ flex: 1, padding: '10px', borderRadius: 8, border: 'none', background: returningId === returnTarget.id ? '#6c757d' : '#ffc107', color: '#856404', fontSize: 14, fontWeight: 'bold', cursor: 'pointer' }}>
                {returningId === returnTarget.id ? '処理中...' : '差戻す'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showForm && (
        <ShiftReportForm
          user={user} profileName={profileName} roleTitle={roleTitle} isAdmin={isAdmin}
          editTarget={editTarget}
          reviewers={reviewers}
          workplaces={workplaces}
          leaderAssignments={leaderAssignments}
          onClose={() => { setShowForm(false); setEditTarget(null); }}
          onSaved={handleSaved}
        />
      )}
    </div>
  );
};

// ────────────────────────────────────────────────────────────────
// BannerSuccess（画面中央の緑カード）
// ────────────────────────────────────────────────────────────────
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

export default ShiftReportPage;

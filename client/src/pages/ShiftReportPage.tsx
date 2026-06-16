import React, { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabaseClient';
import { useDarkMode } from '../hooks/useDarkMode';
import type { AuthUser } from '../types';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────
interface ShiftReport {
  id: string;
  applicant_id: string;
  submitted_by: string;
  work_date: string;
  pay_period_start: string;
  application_type: 'overtime' | 'early_leave' | 'tardiness' | 'absence';
  reason: string;
  original_location: string | null;
  original_start: string | null;
  original_end: string | null;
  actual_location: string | null;
  actual_start: string | null;
  actual_end: string | null;
  break_minutes: number | null;
  labor_minutes: number | null;
  reviewer_id: string | null;
  status: 'pending' | 'confirmed' | 'resubmitted';
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

const TYPE_INFO: Record<string, { label: string; color: string; emoji: string }> = {
  overtime:    { label: '残業',   color: '#1565c0', emoji: '⏰' },
  early_leave: { label: '早退',   color: '#e65100', emoji: '🏃' },
  tardiness:   { label: '遅刻',   color: '#7b1fa2', emoji: '⏱️' },
  absence:     { label: '欠勤',   color: '#c62828', emoji: '❌' },
};
const STATUS_INFO: Record<string, { label: string; color: string; bg: string }> = {
  pending:     { label: '申請中',   color: '#856404', bg: '#fff3cd' },
  resubmitted: { label: '申請中',   color: '#856404', bg: '#fff3cd' },
  confirmed:   { label: '受理済み', color: '#065f46', bg: '#d1fae5' },
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
  date: string; type: 'overtime' | 'early_leave' | 'tardiness' | 'absence'; reason: string;
  origLoc: string; origStart: string; origEnd: string; origDayOff: boolean;
  actLoc: string; actStart: string; actEnd: string;
  breakMin: number; laborMin: number; reviewerName: string; isSelfReview: boolean;
}
const ConfirmModal: React.FC<{ data: ConfirmData; onBack: () => void; onSubmit: () => void; saving: boolean }> = ({ data, onBack, onSubmit, saving }) => {
  const isDark = useDarkMode();
  const bg = isDark ? '#343a40' : '#fff';
  const text = isDark ? '#fff' : '#1a1a2e';
  const border = isDark ? '#495057' : '#dee2e6';
  const origMin = data.origDayOff ? 0 : origDuration(data.origStart, data.origEnd);
  const diffMin = data.type !== 'absence' ? data.laborMin - origMin : -origMin;

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1100, display: 'flex', alignItems: 'flex-end' }}>
      <div style={{ background: bg, width: '100%', maxHeight: '90vh', borderRadius: '16px 16px 0 0', overflowY: 'auto', paddingBottom: 32 }}>
        <div style={{ position: 'sticky', top: 0, background: bg, padding: '16px 16px 12px', borderBottom: `1px solid ${border}`, display: 'flex', alignItems: 'center', gap: 12 }}>
          <button onClick={onBack} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: text }}>‹</button>
          <span style={{ fontWeight: 'bold', fontSize: 16, color: text }}>申請内容を確認</span>
        </div>
        <div style={{ padding: '16px 20px' }}>
          <CRow label="日付"       value={`${data.date}（${dow(data.date)}）`} textColor={text} />
          <CRow label="種別"       value={`${TYPE_INFO[data.type].emoji} ${TYPE_INFO[data.type].label}`} textColor={text} />
          <CRow label="理由"       value={data.reason} textColor={text} />
          <Sep isDark={isDark} />
          <div style={{ fontSize: 11, color: '#888', marginBottom: 6 }}>📋 通常シフト（もともとの予定）</div>
          {data.origDayOff
            ? <CRow label="" value="もともと休みの日" textColor={text} />
            : <CRow label="" value={`${data.origLoc || '—'}　${data.origStart}〜${data.origEnd}（${formatMin(origMin)}）`} textColor={text} />
          }
          {data.type !== 'absence' && (
            <>
              <Sep isDark={isDark} />
              <div style={{ fontSize: 11, color: '#888', marginBottom: 6 }}>✅ 実際に働いた時間</div>
              <CRow label="勤務地"  value={data.actLoc || '—'} textColor={text} />
              <CRow label="時間"    value={`${data.actStart}〜${data.actEnd}`} textColor={text} />
              <CRow label="休憩"    value={`${data.breakMin}分`} textColor={text} />
              <CRow label="実労働"  value={formatMin(data.laborMin)} textColor={text} />
              {!data.origDayOff && origMin > 0 && (
                <div style={{ background: data.type === 'overtime' ? (isDark ? '#1e3a5f' : '#eff6ff') : data.type === 'tardiness' ? (isDark ? '#2d1b4e' : '#f3e8ff') : (isDark ? '#431407' : '#fff7ed'), borderRadius: 8, padding: '8px 12px', marginTop: 4 }}>
                  <span style={{ fontSize: 13, fontWeight: 'bold', color: data.type === 'overtime' ? '#60a5fa' : data.type === 'tardiness' ? '#c084fc' : '#fb923c' }}>
                    {data.type === 'overtime'
                      ? `⏰ 時間外労働：${formatMin(Math.max(0, diffMin))}`
                      : data.type === 'tardiness'
                      ? `⏱️ 遅刻時間：${formatMin(Math.abs(Math.min(0, diffMin)))}`
                      : `🏃 早退・短縮：${formatMin(Math.abs(Math.min(0, diffMin)))}`}
                  </span>
                </div>
              )}
            </>
          )}
          <Sep isDark={isDark} />
          <CRow label="確認依頼先" value={data.reviewerName} textColor={text} />
          {data.isSelfReview && (
            <div style={{ background: isDark ? '#1e3d2f' : '#d1fae5', borderRadius: 8, padding: '8px 12px', marginTop: 4 }}>
              <span style={{ fontSize: 12, fontWeight: 'bold', color: '#065f46' }}>✓ 申請と同時に受理済みになります</span>
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
const ShiftReportForm: React.FC<{
  user: AuthUser; profileName: string | null; roleTitle: string; isAdmin: boolean;
  editTarget?: ShiftReport | null;
  reviewers: Reviewer[];
  workplaces: string[];
  onClose: () => void; onSaved: () => void;
}> = ({ user, profileName, roleTitle, isAdmin, editTarget, reviewers, workplaces, onClose, onSaved }) => {
  const canProxy = IS_APPROVER(roleTitle, isAdmin);
  const [staffList, setStaffList]     = useState<Staff[]>([]);
  const [showConfirm, setShowConfirm] = useState(false);
  const [saving, setSaving]           = useState(false);
  const [error, setError]             = useState('');

  const [applicantId, setApplicantId] = useState(editTarget?.applicant_id ?? user.id);
  const [date, setDate]               = useState(editTarget?.work_date ?? todayStr());
  const [type, setType]               = useState<'overtime' | 'early_leave' | 'tardiness' | 'absence'>(editTarget?.application_type ?? 'overtime');
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
  const [reviewerId, setReviewerId]   = useState(editTarget?.reviewer_id ?? '');
  const [changeSummary, setChangeSummary] = useState('');

  const breakMin = actStart && actEnd && type !== 'absence' ? calcBreakMinutes(actStart, actEnd) : 0;
  const laborMin = actStart && actEnd && type !== 'absence'
    ? Math.max(0, (toMin(actEnd) - toMin(actStart)) - breakMin) : 0;
  const origMin  = origDayOff ? 0 : origDuration(origStart, origEnd);
  const diffMin  = type !== 'absence' ? laborMin - origMin : -origMin;

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
    if (!reason.trim()) return '理由を入力してください';
    if (!origDayOff && (!origStart || !origEnd)) return '通常シフトの時間を入力してください';
    if (!origDayOff && origLoc === 'その他' && !origLocCustom.trim()) return '通常シフトの場所を入力してください';
    if (type !== 'absence' && (!actStart || !actEnd)) return '実際の時間を入力してください';
    if (type !== 'absence' && actLoc === 'その他' && !actLocCustom.trim()) return '実際の勤務場所を入力してください';
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
    const isSelfReview = reviewerId === user.id;
    const now = new Date().toISOString();
    const record = {
      applicant_id:      applicantId,
      submitted_by:      user.id,
      work_date:         date,
      pay_period_start:  calcPayPeriodStart(date),
      application_type:  type,
      reason:            reason.trim(),
      original_location: origDayOff ? null : (finalOrigLoc || null),
      original_start:    origDayOff ? null : (origStart || null),
      original_end:      origDayOff ? null : (origEnd || null),
      actual_location:   type !== 'absence' ? (finalActLoc || null) : null,
      actual_start:      type !== 'absence' ? (actStart || null) : null,
      actual_end:        type !== 'absence' ? (actEnd || null) : null,
      break_minutes:     type !== 'absence' && actStart && actEnd ? breakMin : null,
      labor_minutes:     type !== 'absence' && actStart && actEnd ? laborMin : null,
      reviewer_id:       reviewerId,
      // 自分を確認者に選んだ場合は申請と同時に受理済みにする
      status:       isSelfReview ? 'confirmed' : (editTarget ? 'resubmitted' : 'pending'),
      confirmed_by: isSelfReview ? user.id : null,
      confirmed_at: isSelfReview ? now : null,
    };
    if (editTarget) {
      await supabase.from('shift_report_history').insert({ report_id: editTarget.id, changed_by: user.id, change_summary: changeSummary.trim(), snapshot: editTarget });
      await supabase.from('shift_reports').update(record).eq('id', editTarget.id);
    } else {
      const { error: err } = await supabase.from('shift_reports').insert(record);
      if (err) {
        setSaving(false); setShowConfirm(false);
        setError(err.code === '23505' ? '同じ日付の申請がすでにあります' : err.message);
        return;
      }
    }
    setSaving(false);
    onSaved();
  };

  const isDark = useDarkMode();
  const modalBg   = isDark ? '#343a40' : '#fff';
  const cardBg    = isDark ? '#495057' : '#f8f9fa';
  const cardBg2   = isDark ? '#1e3d2f' : '#f0fdf4';
  const textColor = isDark ? '#fff' : '#333';
  const subColor  = isDark ? '#adb5bd' : '#555';
  const borderCol = isDark ? '#6c757d' : '#ddd';

  const reviewerName = reviewers.find(r => r.id === reviewerId)?.name ?? '';
  const f: React.CSSProperties = { width: '100%', padding: '9px 12px', borderRadius: 8, border: `1px solid ${borderCol}`, fontSize: 14, boxSizing: 'border-box', background: isDark ? '#495057' : 'white', color: textColor };
  const L: React.CSSProperties = { fontSize: 12, color: subColor, marginBottom: 4, display: 'block' };
  const Req = <span style={{ color: '#dc3545' }}>*</span>;

  return (
    <>
      <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'flex-end' }}>
        <div style={{ background: modalBg, width: '100%', maxHeight: '92vh', borderRadius: '16px 16px 0 0', overflowY: 'auto', paddingBottom: 32 }}>
          <div style={{ position: 'sticky', top: 0, background: modalBg, padding: '16px 16px 12px', borderBottom: `1px solid ${borderCol}`, display: 'flex', alignItems: 'center', gap: 12, zIndex: 1 }}>
            <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: textColor, lineHeight: 1 }}>✕</button>
            <span style={{ fontWeight: 'bold', fontSize: 16, color: textColor }}>{editTarget ? '申請を修正' : '勤務変更申請'}</span>
          </div>
          <div style={{ padding: '16px 16px 0' }}>
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
              <label style={L}>種別 {Req}</label>
              <div style={{ display: 'flex', gap: 8 }}>
                {(['overtime', 'early_leave', 'tardiness', 'absence'] as const).map(t => (
                  <button key={t} onClick={() => setType(t)}
                    style={{ flex: 1, padding: '9px 4px', borderRadius: 8, border: `2px solid ${type === t ? TYPE_INFO[t].color : '#dee2e6'}`, background: type === t ? TYPE_INFO[t].color : '#fff', color: type === t ? '#fff' : '#555', fontSize: 12, fontWeight: type === t ? 'bold' : 'normal', cursor: 'pointer' }}>
                    {TYPE_INFO[t].emoji} {TYPE_INFO[t].label}
                  </button>
                ))}
              </div>
            </div>
            {/* 理由 */}
            <div style={{ marginBottom: 14 }}>
              <label style={L}>理由 {Req}</label>
              <textarea value={reason} onChange={e => setReason(e.target.value)} rows={2} placeholder="例：保護者対応のため、急病のため" style={{ ...f, resize: 'none' }} />
            </div>

            {/* 通常シフト */}
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
                    <label style={L}>勤務地</label>
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
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <input type="time" value={origStart} onChange={e => setOrigStart(e.target.value)} style={{ ...f, flex: 1 }} />
                    <span style={{ color: '#888', flexShrink: 0 }}>〜</span>
                    <input type="time" value={origEnd} onChange={e => setOrigEnd(e.target.value)} style={{ ...f, flex: 1 }} />
                  </div>
                  {origStart && origEnd && origMin > 0 && (
                    <div style={{ fontSize: 11, color: '#888', marginTop: 6 }}>シフト時間：{formatMin(origMin)}</div>
                  )}
                </>
              )}
            </div>

            {/* 実際のシフト */}
            {type !== 'absence' && (
              <div style={{ background: cardBg2, borderRadius: 10, padding: '12px 14px', marginBottom: 12 }}>
                <div style={{ fontSize: 12, fontWeight: 'bold', color: subColor, marginBottom: 10 }}>✅ 実際に働いた時間</div>
                <div style={{ marginBottom: 8 }}>
                  <label style={L}>勤務地・場所</label>
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
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <input type="time" value={actStart} onChange={e => setActStart(e.target.value)} style={{ ...f, flex: 1 }} />
                  <span style={{ color: '#888', flexShrink: 0 }}>〜</span>
                  <input type="time" value={actEnd} onChange={e => setActEnd(e.target.value)} style={{ ...f, flex: 1 }} />
                </div>
                {actStart && actEnd && laborMin > 0 && (
                  <div style={{ background: '#dcfce7', borderRadius: 8, padding: '8px 12px' }}>
                    <div style={{ fontSize: 12, color: '#166534' }}>🕐 休憩 {breakMin}分　／　実労働 {formatMin(laborMin)}</div>
                    {!origDayOff && origMin > 0 && diffMin !== 0 && (
                      <div style={{ fontSize: 13, fontWeight: 'bold', color: type === 'overtime' ? '#1565c0' : type === 'tardiness' ? '#7b1fa2' : '#c2410c', marginTop: 4 }}>
                        {type === 'overtime'
                          ? `⏰ 時間外労働：${formatMin(Math.max(0, diffMin))}`
                          : type === 'tardiness'
                          ? `⏱️ 遅刻時間：${formatMin(Math.abs(Math.min(0, diffMin)))}`
                          : `🏃 早退・短縮時間：${formatMin(Math.abs(Math.min(0, diffMin)))}`}
                      </div>
                    )}
                  </div>
                )}
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
                {reviewers.filter(r => r.id !== user.id && !['フロア責任者', '管理者'].includes(r.role_title)).length > 0 && (
                  <optgroup label="リーダー・マネージャー">
                    {reviewers.filter(r => r.id !== user.id && !['フロア責任者', '管理者'].includes(r.role_title)).map(r => (
                      <option key={r.id} value={r.id}>{r.name}（{r.role_title}）</option>
                    ))}
                  </optgroup>
                )}
                {reviewers.filter(r => r.id !== user.id && r.role_title === 'フロア責任者').length > 0 && (
                  <optgroup label="フロア責任者">
                    {reviewers.filter(r => r.id !== user.id && r.role_title === 'フロア責任者').map(r => (
                      <option key={r.id} value={r.id}>{r.name}</option>
                    ))}
                  </optgroup>
                )}
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
            <button onClick={handleConfirmOpen}
              style={{ width: '100%', padding: 14, background: '#28a745', color: '#fff', border: 'none', borderRadius: 10, fontSize: 15, fontWeight: 'bold', cursor: 'pointer' }}>
              申請内容を確認する →
            </button>
          </div>
        </div>
      </div>

      {showConfirm && (
        <ConfirmModal
          data={{ date, type, reason, origLoc: finalOrigLoc, origStart, origEnd, origDayOff, actLoc: finalActLoc, actStart, actEnd, breakMin, laborMin, reviewerName, isSelfReview: reviewerId === user.id }}
          onBack={() => setShowConfirm(false)}
          onSubmit={handleSubmit}
          saving={saving}
        />
      )}
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
  const [tab, setTab]                   = useState<'apply' | 'history'>('apply');
  const [confirmView, setConfirmView]   = useState(false);
  const [showForm, setShowForm]         = useState(false);
  const [editTarget, setEditTarget]     = useState<ShiftReport | null>(null);
  const [myReports, setMyReports]       = useState<ShiftReport[]>([]);
  const [pendingReports, setPendingReports] = useState<ShiftReport[]>([]);
  const [openPeriods, setOpenPeriods]   = useState<Set<string>>(new Set());
  const [successMsg, setSuccessMsg]     = useState('');
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [showReviewerGuide, setShowReviewerGuide] = useState(false);
  const [reviewers, setReviewers]       = useState<Reviewer[]>([]);
  const [workplaces, setWorkplaces]     = useState<string[]>([]);

  const fetchMyReports = useCallback(async () => {
    const { data } = await supabase
      .from('shift_reports')
      .select('*, reviewer:profiles!shift_reports_reviewer_id_fkey(name)')
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
      .select('*, applicant:profiles!shift_reports_applicant_id_fkey(name)')
      .eq('reviewer_id', user.id)
      .in('status', ['pending', 'resubmitted'])
      .order('work_date', { ascending: false });
    if (data) setPendingReports(data as ShiftReport[]);
  }, [isApprover, user.id]);

  useEffect(() => {
    fetchMyReports();
    fetchPending();
    supabase.from('master_options').select('value').eq('category', 'workplace').order('sort_order')
      .then(({ data }) => { if (data) setWorkplaces(data.map(r => r.value)); });
    supabase.from('profiles').select('id, name, role_title').in('role_title', REVIEWER_ROLES).eq('is_active', true).order('role_title').order('name')
      .then(({ data }) => { if (data) setReviewers(data as Reviewer[]); });
  }, [fetchMyReports, fetchPending]);

  const handleSaved = () => {
    setShowForm(false); setEditTarget(null);
    setSuccessMsg('申請を送信しました ✓');
    setTimeout(() => setSuccessMsg(''), 3500);
    fetchMyReports(); fetchPending();
    setTab('history');
  };

  const handleConfirm = async (report: ShiftReport) => {
    setConfirmingId(report.id);
    await supabase.from('shift_reports').update({
      status: 'confirmed', confirmed_by: user.id, confirmed_at: new Date().toISOString()
    }).eq('id', report.id);
    setConfirmingId(null);
    setSuccessMsg('受理しました ✓');
    setTimeout(() => setSuccessMsg(''), 3000);
    fetchPending(); fetchMyReports();
  };

  const grouped = myReports.reduce<Record<string, ShiftReport[]>>((acc, r) => {
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
        {successMsg && <Toast msg={successMsg} />}
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
            const oMin = origDuration(r.original_start?.slice(0, 5) ?? null, r.original_end?.slice(0, 5) ?? null);
            const dMin = r.labor_minutes != null ? r.labor_minutes - oMin : null;
            return (
              <div key={r.id} style={{ background: bg, borderRadius: 10, border: `1px solid ${borderCol}`, marginBottom: 10, padding: '14px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <span style={{ fontSize: 13, fontWeight: 'bold', color: text }}>{(r.applicant as { name: string | null } | null)?.name ?? '不明'}</span>
                  <span style={{ fontSize: 11, color: '#888' }}>{r.work_date.slice(5).replace('-', '/')}（{dow(r.work_date)}）</span>
                  <span style={{ fontSize: 11, fontWeight: 'bold', color: TYPE_INFO[r.application_type].color, marginLeft: 'auto' }}>
                    {TYPE_INFO[r.application_type].emoji} {TYPE_INFO[r.application_type].label}
                  </span>
                </div>
                {r.original_start
                  ? <div style={{ fontSize: 12, color: '#555', marginBottom: 2 }}>📋 {r.original_location} {r.original_start.slice(0, 5)}〜{r.original_end?.slice(0, 5)}（{formatMin(oMin)}）</div>
                  : <div style={{ fontSize: 12, color: '#aaa', marginBottom: 2 }}>📋 もともと休みの日</div>
                }
                {r.actual_start && (
                  <div style={{ fontSize: 12, color: '#166534', marginBottom: 4 }}>
                    ✅ {r.actual_location} {r.actual_start.slice(0, 5)}〜{r.actual_end?.slice(0, 5)}　実労働 {r.labor_minutes ? formatMin(r.labor_minutes) : '-'}
                    {dMin != null && oMin > 0 && (
                      <span style={{ marginLeft: 6, color: r.application_type === 'overtime' ? '#1565c0' : '#c2410c', fontWeight: 'bold' }}>
                        （{r.application_type === 'overtime'
                          ? `時間外 ${formatMin(Math.max(0, dMin))}`
                          : `短縮 ${formatMin(Math.abs(Math.min(0, dMin)))}`}）
                      </span>
                    )}
                  </div>
                )}
                <div style={{ fontSize: 12, color: '#888', marginBottom: 10 }}>{r.reason}</div>
                {r.status === 'resubmitted' && (
                  <div style={{ fontSize: 11, color: '#9d174d', background: '#fce7f3', borderRadius: 6, padding: '4px 8px', marginBottom: 8 }}>⚠️ 修正されました（再確認をお願いします）</div>
                )}
                <button onClick={() => handleConfirm(r)} disabled={confirmingId === r.id}
                  style={{ width: '100%', padding: '10px 0', background: confirmingId === r.id ? '#6c757d' : '#28a745', color: '#fff', border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 'bold', cursor: confirmingId === r.id ? 'default' : 'pointer' }}>
                  {confirmingId === r.id ? '処理中...' : '✓ 受理する'}
                </button>
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
      {successMsg && <Toast msg={successMsg} />}

      {/* ページタイトル */}
      <div style={{ textAlign: 'center', padding: '16px 0 16px' }}>
        <div style={{ fontSize: 24, marginBottom: 4 }}>⏰</div>
        <div style={{ fontSize: 13, color: subText, fontWeight: 'bold', marginBottom: 2 }}>パート・アルバイト</div>
        <h1 style={{ fontSize: 18, fontWeight: 'bold', color: text, margin: 0 }}>勤務変更申請</h1>
      </div>

      <div style={{ padding: '0 16px' }}>
        {/* タブ（休暇申請と同スタイル） */}
        <div style={{ display: 'flex', marginBottom: 0, borderRadius: '10px 10px 0 0', overflow: 'hidden', boxShadow: '0 2px 8px rgba(0,0,0,0.08)' }}>
          <button onClick={() => setTab('apply')}
            style={{ flex: 1, padding: '12px', background: tab === 'apply' ? '#28a745' : inactiveBg, color: tab === 'apply' ? '#fff' : text, border: 'none', cursor: 'pointer', fontSize: 15, fontWeight: tab === 'apply' ? 'bold' : 'normal' }}>
            ＋ 申請
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
                <li>申請先は、出勤する校の担当のリーダー・マネージャー（スタッフ）を選択してください。</li>
                <li>受理されると「受理済み」に変わります。</li>
                <li>間違えた場合は、担当のリーダー・マネージャー（スタッフ）にお知らせください。</li>
              </ol>

              <button type="button" onClick={() => setShowReviewerGuide(v => !v)}
                style={{ marginTop: 10, padding: '6px 12px', fontSize: 12, fontWeight: 'bold', background: noteBtn, color: noteTitleColor, border: 'none', borderRadius: 6, cursor: 'pointer' }}>
                {showReviewerGuide ? '▲ 確認依頼先スタッフ 一覧を閉じる' : '▼ 確認依頼先スタッフ 一覧を表示'}
              </button>

              {showReviewerGuide && (
                <div style={{ marginTop: 10, padding: '12px 14px', borderRadius: 8, background: bg, border: `1px solid ${noteBorder}`, fontSize: 12, lineHeight: 1.8, color: noteText }}>
                  {reviewers.length === 0 ? (
                    <p style={{ margin: 0 }}>スタッフ情報が登録されていません。</p>
                  ) : (
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <thead>
                        <tr>
                          <th style={{ textAlign: 'left', padding: '6px 8px', background: noteBg, fontWeight: 'bold', fontSize: 11, color: noteTitleColor }}>名前</th>
                          <th style={{ textAlign: 'left', padding: '6px 8px', background: noteBg, fontWeight: 'bold', fontSize: 11, color: noteTitleColor }}>役職</th>
                        </tr>
                      </thead>
                      <tbody>
                        {['リーダー', 'マネージャー', 'フロア責任者', '社長', '管理者'].map(role => {
                          const members = reviewers.filter(r => r.role_title === role);
                          if (members.length === 0) return null;
                          return (
                            <React.Fragment key={role}>
                              <tr><td colSpan={2} style={{ padding: '5px 8px', background: isDark ? '#1a4a5a' : '#1a4a5a', color: '#fff', fontWeight: 'bold', fontSize: 11 }}>【{role}】</td></tr>
                              {members.map(r => (
                                <tr key={r.id}>
                                  <td style={{ padding: '6px 8px', borderBottom: `1px solid ${noteBorder}`, color: noteText }}>{r.name}</td>
                                  <td style={{ padding: '6px 8px', borderBottom: `1px solid ${noteBorder}`, color: '#888' }}>{r.role_title}</td>
                                </tr>
                              ))}
                            </React.Fragment>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </div>
              )}
            </div>

            {/* 申請ボタン */}
            <div style={{ textAlign: 'center' }}>
              <button onClick={() => { setEditTarget(null); setShowForm(true); }}
                style={{ width: '100%', maxWidth: 320, padding: '14px 0', background: '#28a745', color: '#fff', border: 'none', borderRadius: 10, fontSize: 15, fontWeight: 'bold', cursor: 'pointer' }}>
                ＋ 新規申請する
              </button>
            </div>
          </div>
        )}

        {/* ─ 履歴タブ ─ */}
        {tab === 'history' && (
          <div style={{ background: bg, borderRadius: '0 0 12px 12px', boxShadow: cardShadow, padding: '16px', boxSizing: 'border-box' }}>
            {Object.keys(grouped).sort((a, b) => b.localeCompare(a)).map(period => (
              <div key={period} style={{ borderRadius: 10, border: `1px solid ${borderCol}`, marginBottom: 8, overflow: 'hidden' }}>
                <div onClick={() => togglePeriod(period)} style={{ display: 'flex', alignItems: 'center', padding: '12px 14px', cursor: 'pointer', background: inactiveBg }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 'bold', color: text }}>{payPeriodLabel(period)}</div>
                    <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>{period.slice(5).replace('-', '/')} 〜 翌月15日　{grouped[period].length}件</div>
                  </div>
                  <span style={{ fontSize: 12, color: '#aaa', display: 'inline-block', transform: openPeriods.has(period) ? 'rotate(180deg)' : 'none' }}>▼</span>
                </div>
                {openPeriods.has(period) && (
                  <div style={{ background: bg }}>
                    {grouped[period].map(r => {
                      const oMin = origDuration(r.original_start?.slice(0, 5) ?? null, r.original_end?.slice(0, 5) ?? null);
                      const dMin = r.labor_minutes != null ? r.labor_minutes - oMin : null;
                      return (
                        <div key={r.id} style={{ padding: '10px 14px', borderBottom: `1px solid ${isDark ? '#495057' : '#f5f5f5'}`, display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                          <div style={{ fontSize: 11, color: '#555', minWidth: 52, flexShrink: 0, marginTop: 2 }}>
                            {r.work_date.slice(5).replace('-', '/')}（{dow(r.work_date)}）
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 11, fontWeight: 'bold', color: TYPE_INFO[r.application_type].color, marginBottom: 2 }}>
                              {TYPE_INFO[r.application_type].emoji} {TYPE_INFO[r.application_type].label}
                            </div>
                            {r.original_start
                              ? <div style={{ fontSize: 11, color: '#888' }}>📋 {r.original_location} {r.original_start.slice(0, 5)}〜{r.original_end?.slice(0, 5)}</div>
                              : <div style={{ fontSize: 11, color: '#bbb' }}>📋 もともと休みの日</div>
                            }
                            {r.actual_start && (
                              <div style={{ fontSize: 11, color: '#166534' }}>
                                ✅ {r.actual_start.slice(0, 5)}〜{r.actual_end?.slice(0, 5)}　実労働 {r.labor_minutes ? formatMin(r.labor_minutes) : '-'}
                                {dMin != null && oMin > 0 && (
                                  <span style={{ marginLeft: 4, color: r.application_type === 'overtime' ? '#1565c0' : r.application_type === 'tardiness' ? '#7b1fa2' : '#c2410c', fontWeight: 'bold' }}>
                                    ／{r.application_type === 'overtime'
                                      ? `時間外 ${formatMin(Math.max(0, dMin))}`
                                      : r.application_type === 'tardiness'
                                      ? `遅刻 ${formatMin(Math.abs(Math.min(0, dMin)))}`
                                      : `短縮 ${formatMin(Math.abs(Math.min(0, dMin)))}`}
                                  </span>
                                )}
                              </div>
                            )}
                            <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>{r.reason}</div>
                          </div>
                          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, flexShrink: 0 }}>
                            <span style={{ fontSize: 10, fontWeight: 'bold', color: STATUS_INFO[r.status].color, background: STATUS_INFO[r.status].bg, borderRadius: 10, padding: '2px 8px', whiteSpace: 'nowrap' }}>
                              {STATUS_INFO[r.status].label}
                            </span>
                            {IS_APPROVER(roleTitle, isAdmin) && (r.status === 'pending' || r.status === 'resubmitted') && (
                              <button onClick={() => { setEditTarget(r); setShowForm(true); }}
                                style={{ fontSize: 11, color: '#28a745', background: 'none', border: '1px solid #28a745', borderRadius: 6, padding: '2px 8px', cursor: 'pointer' }}>
                                修正
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
            {Object.keys(grouped).length === 0 && (
              <div style={{ textAlign: 'center', color: '#aaa', padding: 48, fontSize: 14 }}>申請履歴がありません</div>
            )}
          </div>
        )}
      </div>

      {showForm && (
        <ShiftReportForm
          user={user} profileName={profileName} roleTitle={roleTitle} isAdmin={isAdmin}
          editTarget={editTarget}
          reviewers={reviewers}
          workplaces={workplaces}
          onClose={() => { setShowForm(false); setEditTarget(null); }}
          onSaved={handleSaved}
        />
      )}
    </div>
  );
};

// ────────────────────────────────────────────────────────────────
// Toast
// ────────────────────────────────────────────────────────────────
const Toast: React.FC<{ msg: string }> = ({ msg }) => (
  <div style={{ position: 'fixed', top: 70, left: 0, right: 0, zIndex: 500, background: '#d1fae5', borderBottom: '1px solid #6ee7b7', padding: '12px 16px', textAlign: 'center', fontSize: 14, fontWeight: 'bold', color: '#065f46' }}>
    {msg}
  </div>
);

export default ShiftReportPage;

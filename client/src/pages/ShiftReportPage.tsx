import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient';
import { notifyShiftReportReturned } from '../lib/shiftReportReturnedNotify';
import { useDarkMode } from '../hooks/useDarkMode';
import { useFocusHighlight } from '../hooks/useFocusHighlight';
import { DRAFT_KEYS, loadDraft, saveDraft, clearDraft } from '../lib/draftStorage';
import { calcSegsBreak, parseSegments, segMinutes, formatSegs, formatSegsFromRecord, segFirstStart, segLastEnd, joinSegLocations, MAX_SEGS, type Seg } from '../lib/shiftCalc';
import { errorStyle, errorLabelColor, scrollToFirstError } from '../lib/formHighlight';
import type { AuthUser } from '../types';
import CorrectionBadgeAndButton from '../components/CorrectionBadgeAndButton';
import { PageTabs } from '../components/PageTabs';
import HelpLinkButton from '../components/HelpLinkButton';
import { fetchLatestCorrectionByTarget } from '../lib/correctionRequest';
import type { CorrectionRequestRow } from '../lib/correctionRequest';
import { useCompanyCalendar, CALENDAR_CELL_STYLE, CALENDAR_NOTICE } from '../hooks/useCompanyCalendar';
import type { CalendarKind } from '../lib/breakCalc';

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
  original_segments: unknown;  // jsonb（勤務した時間帯 最大3つ）。古い報告は null で、上の列＋外出から復元する
  actual_location: string | null;
  actual_start: string | null;
  actual_end: string | null;
  actual_outing_start: string | null;
  actual_outing_end: string | null;
  actual_segments: unknown;    // jsonb（勤務した時間帯 最大3つ）
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
// toISOString()はUTC基準のためJST深夜0:00〜8:59に前日を返す。必ずローカル(JST)で組み立てる
function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function dow(dateStr: string): string { return DOW[new Date(dateStr + 'T00:00:00').getDay()]; }
function origDuration(start: string | null, end: string | null): number {
  if (!start || !end) return 0;
  return toMin(end) - toMin(start);
}

const TYPE_INFO: Record<ApplicationType, { label: string; color: string; darkBg: string; emoji: string }> = {
  overtime:     { label: '残業',     color: '#1565c0', darkBg: '#1e3a5f', emoji: '⏰' },
  holiday_work: { label: '休日出勤', color: '#0f766e', darkBg: '#123a35', emoji: '🏢' },
  early_leave:  { label: '早退',     color: '#e65100', darkBg: '#4a2c0a', emoji: '🏃' },
  tardiness:    { label: '遅刻',     color: '#7b1fa2', darkBg: '#3a1f4d', emoji: '🕐' },
  absence:      { label: '欠勤',     color: '#c62828', darkBg: '#4a1515', emoji: '❌' },
  early_start:  { label: '早出',     color: '#0891b2', darkBg: '#123a42', emoji: '🌅' },
  location_change: { label: '勤務地変更', color: '#6d28d9', darkBg: '#2e1a5c', emoji: '📍' },
};

function typeBadgeStyle(color: string, darkBg: string, isDark: boolean): React.CSSProperties {
  return {
    fontSize: 11, fontWeight: 'bold', padding: '2px 8px', borderRadius: 10,
    border: `1px solid ${color}`,
    background: isDark ? darkBg : `${color}1a`,
    color: isDark ? '#fff' : color,
  };
}

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
  pending:     { label: '確認待ち',   color: '#856404', bg: '#fff3cd' },
  resubmitted: { label: '確認待ち',   color: '#856404', bg: '#fff3cd' },
  confirmed:   { label: '受理済み', color: '#065f46', bg: '#d1fae5' },
  cancelled:   { label: '取消済み', color: '#6c757d', bg: '#e9ecef' },
  returned:    { label: '差戻し',   color: '#9d174d', bg: '#fce7f3' },
};

// ────────────────────────────────────────────────────────────────
// Single Date Calendar
// ────────────────────────────────────────────────────────────────
const SingleDatePicker: React.FC<{ value: string; onChange: (d: string) => void; isDark: boolean; calendarKinds?: Record<string, CalendarKind>; hasError?: boolean }> = ({ value, onChange, isDark, calendarKinds, hasError }) => {
  const today = new Date();
  const [year, setYear]   = useState(value ? new Date(value + 'T00:00:00').getFullYear() : today.getFullYear());
  const [month, setMonth] = useState(value ? new Date(value + 'T00:00:00').getMonth()    : today.getMonth());
  const firstDay    = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const prev = () => { if (month === 0) { setYear(y => y - 1); setMonth(11); } else setMonth(m => m - 1); };
  const next = () => { if (month === 11) { setYear(y => y + 1); setMonth(0); } else setMonth(m => m + 1); };
  // 月によって週の数が変わると高さが動き、下のボタンや「‹ ›」の位置がずれる。常に6週間ぶんにする
  const cells: (number | null)[] = [
    ...Array(firstDay).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
    ...Array(Math.max(0, 42 - firstDay - daysInMonth)).fill(null),
  ];
  const calBg = isDark ? '#495057' : '#f8f9fa';
  const calText = isDark ? '#fff' : '#333';
  const calBorder = isDark ? '#6c757d' : '#ddd';

  return (
    <div style={{ background: calBg, border: `1px solid ${calBorder}`, borderRadius: 10, padding: 12, ...errorStyle(!!hasError, isDark) }}>
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
          // 会社の休館日（全社員休み／社員出勤日）を背景で示す
          const ck = calendarKinds?.[iso];
          const cs = ck ? CALENDAR_CELL_STYLE[ck] : null;
          return (
            <button key={i} onClick={() => onChange(iso)}
              title={cs ? CALENDAR_NOTICE[ck as CalendarKind] : undefined}
              style={{ padding: '10px 2px', minHeight: 38, borderRadius: 6, border: isT ? '2px solid #007bff' : '1px solid transparent', background: sel ? '#28a745' : cs ? cs.bg : 'transparent', color: sel ? '#fff' : cs ? cs.text : col, cursor: 'pointer', fontSize: 13, fontWeight: sel ? 'bold' : 'normal', textAlign: 'center', lineHeight: 1.2 }}>
              {day}
              {cs && <div style={{ fontSize: 8, fontWeight: 'bold', color: sel ? 'rgba(255,255,255,0.9)' : cs.text }}>{cs.short}</div>}
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
  origSegs: Seg[];
  actLoc: string; actStart: string; actEnd: string;
  actSegs: Seg[];
  actNotes: string;
  breakMin: number; laborMin: number; reviewerName: string; isSelfReview: boolean;
  applicantName: string; isProxy: boolean;
}
const ConfirmModal: React.FC<{ data: ConfirmData; onBack: () => void; onSubmit: () => void; saving: boolean }> = ({ data, onBack, onSubmit, saving }) => {
  const isDark = useDarkMode();
  const bg = isDark ? '#343a40' : '#fff';
  const text = isDark ? '#fff' : '#1a1a2e';
  const border = isDark ? '#495057' : '#dee2e6';
  const origMin = data.origDayOff ? 0 : segMinutes(data.origSegs);
  const hasAbsence = data.types.includes('absence');
  const diffMin = !hasAbsence ? data.laborMin - origMin : -origMin;

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1100, display: 'flex', alignItems: 'flex-end' }}>
      <div style={{ background: bg, width: '100%', maxHeight: '90vh', borderRadius: '16px 16px 0 0', overflowY: 'auto', paddingBottom: 32 }}>
        <div style={{ position: 'sticky', top: 0, background: bg, padding: '16px 16px 12px', borderBottom: `1px solid ${border}`, display: 'flex', alignItems: 'center', gap: 12 }}>
          <button onClick={onBack} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: text }}>‹</button>
          <span style={{ fontWeight: 'bold', fontSize: 16, color: text }}>報告内容を確認</span>
        </div>
        <div style={{ padding: '16px 20px' }}>
          {data.isProxy && (
            <div style={{ background: isDark ? '#1a2e4a' : '#e0f2fe', border: '1px solid #38bdf8', borderRadius: 8, padding: '8px 12px', marginBottom: 12, fontSize: 13, color: isDark ? '#7dd3fc' : '#0369a1', fontWeight: 500 }}>
              👤 代行報告：<b>{data.applicantName}</b> さんの報告
            </div>
          )}
          <CRow label="報告者"     value={data.applicantName} textColor={text} />
          <CRow label="日付"       value={`${data.date}（${dow(data.date)}）`} textColor={text} />
          {/* 種別は入力画面と同じ色のバッジで出す（文字だけだと見分けにくいため） */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: '5px 0' }}>
            <span style={{ fontSize: 13, color: '#8a929a', flexShrink: 0 }}>種別</span>
            <span style={{ display: 'flex', gap: 5, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              {data.types.map(t => (
                <span key={t} style={typeBadgeStyle(TYPE_INFO[t].color, TYPE_INFO[t].darkBg, isDark)}>
                  {TYPE_INFO[t].emoji} {TYPE_INFO[t].label}
                </span>
              ))}
            </span>
          </div>
          <CRow label="理由"       value={data.reason} textColor={text} />
          {!hasAbsence && (
            <>
              <Sep isDark={isDark} />
              <div style={{ fontSize: 11, color: '#888', marginBottom: 6 }}>
                {data.types.includes('holiday_work') && !data.origDayOff ? '📋 予定していた時間' : '📋 通常シフト（もともとの予定）'}
              </div>
              {/* 外出があるときは「9:00〜14:00 / 15:00〜18:00」と実際に働いた時間帯だけを並べる */}
              {data.origDayOff
                ? <CRow label="" value="休みの日" textColor={text} />
                : <CRow label="" value={`${data.origLoc || '—'}　${formatSegs(data.origSegs)}`} textColor={text} />
              }
              <Sep isDark={isDark} />
              <div style={{ fontSize: 11, color: '#888', marginBottom: 6 }}>✅ 実際に勤務した時間</div>
              <CRow label="勤務地"  value={data.actLoc || '—'} textColor={text} />
              <CRow label="時間"    value={formatSegs(data.actSegs)} textColor={text} />
              <CRow label="休憩"    value={`${data.breakMin}分`} textColor={text} />
              <CRow label="実労働"  value={formatMin(data.laborMin)} textColor={text} />
              {data.actNotes && <CRow label="備考" value={data.actNotes} textColor={text} />}
              {!data.origDayOff && origMin > 0 && diffMin !== 0 && (
                <div style={{ background: isDark ? '#1e3a5f' : '#eff6ff', borderRadius: 8, padding: '8px 12px', marginTop: 4 }}>
                  {data.types.includes('early_start') && <div style={{ fontSize: 13, fontWeight: 'bold', color: '#22d3ee' }}>🌅 早出：{formatMin(Math.max(0, toMin(data.origStart) - toMin(data.actStart)))}</div>}
                  {data.types.includes('tardiness') && <div style={{ fontSize: 13, fontWeight: 'bold', color: '#c084fc' }}>🕐 遅刻：{formatMin(Math.max(0, toMin(data.actStart) - toMin(data.origStart)))}</div>}
                  {data.types.includes('early_leave') && <div style={{ fontSize: 13, fontWeight: 'bold', color: '#fb923c' }}>🏃 早退：{formatMin(Math.max(0, toMin(data.origEnd) - toMin(data.actEnd)))}</div>}
                </div>
              )}
            </>
          )}
          <Sep isDark={isDark} />
          <CRow label="確認依頼先" value={data.reviewerName} textColor={text} />
          {data.isSelfReview && (
            <div style={{ background: isDark ? '#1e3d2f' : '#d1fae5', borderRadius: 8, padding: '8px 12px', marginTop: 4 }}>
              <span style={{ fontSize: 12, fontWeight: 'bold', color: isDark ? '#4ade80' : '#065f46' }}>✓ 報告と同時に受理されます</span>
            </div>
          )}
          <button onClick={onSubmit} disabled={saving}
            style={{ width: '100%', padding: 14, marginTop: 20, background: saving ? '#6c757d' : '#28a745', color: '#fff', border: 'none', borderRadius: 10, fontSize: 15, fontWeight: 'bold', cursor: saving ? 'default' : 'pointer' }}>
            {saving ? '送信中...' : '✓ この内容で報告する'}
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
  // 会社の休館日（全社員休み／社員出勤日）を日付カレンダーに出す
  const calendarKinds = useCompanyCalendar();
  // 確認者が他人の報告を修正するときは、確認依頼先を変えられない。
  // DBのRLS（reviewer_confirm）が「自分が確認者である報告」しか更新を許さないため、
  // 変えて保存すると必ず失敗する。選べないようにしたうえで、差戻しで行う旨を案内する。
  // 本人が自分の未承認の報告を直すときと、管理者は従来どおり変更できる。
  const lockReviewer = !!editTarget && !isAdmin && editTarget.applicant_id !== user.id;
  const [staffList, setStaffList]     = useState<Staff[]>([]);
  const [showConfirm, setShowConfirm] = useState(false);
  const [saving, setSaving]           = useState(false);
  const [error, setError]             = useState('');
  // 入力エラーの欄を薄赤にする（lib/formHighlight.ts の共通色）
  const [errFields, setErrFields] = useState<Set<string>>(new Set());

  // 入力中の下書きを端末に自動保存し、開き直したら復元する（新規報告のみ。修正モードは対象外）
  interface ShiftDraft {
    applicantId: string; date: string; types: ApplicationType[]; reason: string; origDayOff: boolean;
    origSegs: Seg[]; actSegs: Seg[];
    reviewerId: string; actNotes: string;
  }
  const [sd] = useState(() => (editTarget ? null : loadDraft<ShiftDraft>(DRAFT_KEYS.shiftReport)));

  const [applicantId, setApplicantId] = useState(editTarget?.applicant_id ?? sd?.applicantId ?? user.id);
  const [date, setDate]               = useState(editTarget?.work_date ?? sd?.date ?? todayStr());
  const [types, setTypes]             = useState<ApplicationType[]>(
    editTarget?.application_types?.length ? editTarget.application_types
    : editTarget?.application_type        ? [editTarget.application_type]
    : sd?.types ?? []
  );
  const [blockMsg, setBlockMsg]       = useState('');
  const [absencePrompt, setAbsencePrompt] = useState<'none' | 'confirm' | 'declined'>('none');
  const absencePanelRef = useRef<HTMLDivElement>(null);
  const [reason, setReason]           = useState(editTarget?.reason ?? sd?.reason ?? '');
  // 修正で開いたときは元の報告から復元する。予定の時刻が無く、休日出勤でも欠勤でもない
  // ＝「もともと休みの日」として登録された報告。復元しないと修正のたびに
  // チェックが外れ、入力していない予定時刻が保存されてしまう
  const [origDayOff, setOrigDayOff]   = useState(
    editTarget
      ? (!editTarget.original_start
         && !editTarget.application_types?.includes('holiday_work')
         && !editTarget.application_types?.includes('absence'))
      : (sd?.origDayOff ?? false)
  );
  // 理由履歴（自分が過去に入力した理由）
  const [pastReasons, setPastReasons] = useState<string[]>([]);
  const [showAllReasons, setShowAllReasons] = useState(false);
  // 履歴は過去の報告から自動抽出するため、✕は「候補として今後出さない」（端末に記憶）
  const hiddenReasonsKey = `fivem_hidden_reasons_shift_${applicantId}`;
  const [hiddenReasons, setHiddenReasons] = useState<string[]>(() => {
    try { const v = JSON.parse(localStorage.getItem(hiddenReasonsKey) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
  });
  const hideReason = (r: string) => {
    setHiddenReasons(prev => {
      const next = prev.includes(r) ? prev : [...prev, r];
      try { localStorage.setItem(hiddenReasonsKey, JSON.stringify(next)); } catch { /* 保存できなくても表示は消す */ }
      return next;
    });
  };
  const visiblePastReasons = useMemo(() => pastReasons.filter(r => !hiddenReasons.includes(r)), [pastReasons, hiddenReasons]);
  useEffect(() => {
    supabase.from('shift_reports').select('reason, created_at').eq('applicant_id', applicantId)
      .not('reason', 'is', null).order('created_at', { ascending: false }).limit(50)
      .then(({ data }) => {
        const seen = new Set<string>(); const list: string[] = [];
        for (const r of (data ?? []) as { reason: string | null }[]) {
          const t = (r.reason ?? '').trim();
          if (t && !seen.has(t)) { seen.add(t); list.push(t); }
        }
        setPastReasons(list.slice(0, 12));
      }, () => {});
  }, [applicantId]);

  // 修正で開いたときは空のままにする（既定の12:00を入れると、入力していない時刻が
  // そのまま予定として保存され、静かにデータが化ける。空なら送信前に必ず弾かれる）
  // 勤務した時間帯（最大3つ・残業ページと同じ形）。間の空きが外出・中抜けになる。
  // 古い報告は「開始〜終了から外出を抜く」形で時間帯に復元する
  const [origSegs, setOrigSegs] = useState<Seg[]>(
    editTarget
      ? parseSegments(editTarget.original_segments, editTarget.original_start, editTarget.original_end, editTarget.original_outing_start, editTarget.original_outing_end, editTarget.original_location)
      : (sd?.origSegs ?? [{ start: '', end: '' }])
  );
  const [actSegs, setActSegs] = useState<Seg[]>(
    editTarget
      ? parseSegments(editTarget.actual_segments, editTarget.actual_start, editTarget.actual_end, editTarget.actual_outing_start, editTarget.actual_outing_end, editTarget.actual_location)
      : (sd?.actSegs ?? [{ start: '', end: '' }])
  );
  // 勤務地は時間帯ごとに選ぶ（午前は四条本校・午後は西陣校 のように校をまたぐ日があるため）。
  // 「その他（自由入力）」を選んだかどうかだけ別に覚え、値は各時間帯の location に直接入れる
  const [origLocOther, setOrigLocOther] = useState<boolean[]>([]);
  const [actLocOther, setActLocOther]   = useState<boolean[]>([]);
  // 保存済みの校が勤務地リストに無い＝「その他」で入力された値なので、自由入力欄で開く
  const isOtherLoc = (flags: boolean[], s: Seg, i: number): boolean =>
    flags[i] ?? (!!s.location && workplaces.length > 0 && !workplaces.includes(s.location));
  // 従来の勤務地の列には校をつないだ文字列を入れる（例：四条本校→西陣校）
  const finalOrigLoc = joinSegLocations(origSegs);
  const finalActLoc  = joinSegLocations(actSegs);
  // 開始・終了は「最初の時間帯の開始」「最後の時間帯の終了」。
  // 遅刻・早退の判定や保存はこれまでどおりこの2つを使う
  const origStart = segFirstStart(origSegs);
  const origEnd   = segLastEnd(origSegs);
  const actStart  = segFirstStart(actSegs);
  const actEnd    = segLastEnd(actSegs);
  const [reviewerId, setReviewerId]   = useState(editTarget?.reviewer_id ?? sd?.reviewerId ?? '');
  const [actNotes, setActNotes]       = useState(sd?.actNotes ?? '');
  const [changeSummary, setChangeSummary] = useState('');

  // 入力中の下書きを自動保存（新規報告のみ）
  useEffect(() => {
    if (editTarget) return;
    saveDraft(DRAFT_KEYS.shiftReport, {
      applicantId, date, types, reason, origDayOff,
      origSegs, actSegs, reviewerId, actNotes,
    });
  }, [editTarget, applicantId, date, types, reason, origDayOff, origSegs, actSegs, reviewerId, actNotes]);

  const hasAbsence    = types.includes('absence');
  const hasHoliday    = types.includes('holiday_work');
  // 「予定と比べて初めて意味が決まる」種別。休日出勤の日でも
  // （イベントを9:00〜17:00で頼まれた等）予定より遅れた・延びたは起こるので、
  // これらを選んだときは休日出勤でも「予定していた時間」を入力してもらう。
  // 入力させないと「何時の予定に遅れたのか」がどこにも残らない。
  const hasDiffType   = types.some(t => t === 'early_start' || t === 'tardiness' || t === 'early_leave' || t === 'overtime');
  // 予定の時間そのものが無い状態＝欄を出さない・nullで保存・差分を出さない。
  // ⚠️ 入力欄の表示条件／validate／保存／確認画面は必ずこの1つの判定に揃えること。
  //    片方だけ直すと「入力できないのに必須」「送信できたのに予定が残らない」事故になる。
  const noPlan        = hasAbsence || (hasHoliday ? !hasDiffType : origDayOff);
  // 予定の入力セクション自体を出すか（origDayOff は欄の中のチェックなのでここには含めない）
  const planVisible   = !hasAbsence && (!hasHoliday || hasDiffType);
  const planWord      = hasHoliday ? '予定していた' : '通常シフトの';
  const pType         = primaryType(types);

  const toggleType = (t: ApplicationType) => {
    if (isBlockedWith(types, t)) {
      setBlockMsg(blockReason(types, t));
      setTimeout(() => setBlockMsg(''), 2200);
      return;
    }
    // 欠勤を新規に選ぶとき（本人・新規報告のみ）は「連絡済みか」の事前確認を挟む
    if (t === 'absence' && !types.includes('absence') && !editTarget && !canProxy) {
      setAbsencePrompt('confirm');
      return;
    }
    setAbsencePrompt('none');
    clearErr('types');
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

  // 🚨 休憩は時間帯ごとに計算して合算する（残業ページと同じ）。
  // 最初〜最後の拘束で判定すると、中抜けの長い日に休憩を引きすぎる
  const breakMin = !hasAbsence ? calcSegsBreak(actSegs) : 0;
  // 実労働＝勤務した時間帯の合計 − 休憩（時間帯の間の空き＝外出は最初から含まれない）
  const actOutingMin = Math.max(0, (actStart && actEnd ? toMin(actEnd) - toMin(actStart) : 0) - segMinutes(actSegs));
  const laborMin = !hasAbsence ? Math.max(0, segMinutes(actSegs) - breakMin) : 0;
  const origMin  = noPlan ? 0 : segMinutes(origSegs);

  useEffect(() => {
    if (absencePrompt !== 'none') {
      absencePanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [absencePrompt]);

  useEffect(() => {
    if (!canProxy) return;
    // 代行対象はパート・アルバイトのみ（employment_type='パート'）
    supabase.from('profiles').select('id, name, role_title, employment_type').eq('is_active', true).order('name')
      .then(({ data }) => {
        if (data) setStaffList((data as Staff[]).filter(s => s.employment_type === 'パート'));
      });
  }, [canProxy]);

  // メッセージだけでなく「どの欄が原因か」も返す。赤いメッセージが出ても
  // 欄が分からないと直せないため（他ページと同じ薄赤ハイライトに使う）
  const validate = (): { msg: string; field?: string } => {
    // 予定を持つ状態のときだけ、予定の入力を必須にする（noPlan と必ず対で判断する）
    const noShift = !noPlan;
    if (!date)          return { msg: '日付を選択してください', field: 'date' };
    if (types.length === 0) return { msg: '種別を選択してください', field: 'types' };
    if (!reason.trim()) return { msg: '理由を入力してください', field: 'reason' };
    if (noShift && origSegs.some(s => !s.start || !s.end)) return { msg: `${planWord}時間を入力してください`, field: 'origTime' };
    if (noShift && origSegs.some(s => s.start === s.end)) return { msg: `${planWord}開始・終了が同じ時間です。正しい時間を入力してください`, field: 'origTime' };
    if (noShift && origSegs.some(s => !(s.location ?? '').trim())) return { msg: `${planWord}勤務地を選択してください`, field: 'origLoc' };
    // 時間帯が前の帯と重なっている／逆順だと労働時間が合わなくなるので止める
    if (noShift && origSegs.some((s, i) => i > 0 && s.start && origSegs[i - 1].end && toMin(s.start) < toMin(origSegs[i - 1].end))) return { msg: `${planWord}勤務の時間が重なっています。順番に入力してください`, field: 'origTime' };
    if (!hasAbsence && actSegs.some(s => !s.start || !s.end)) return { msg: '実際の時間を入力してください', field: 'actTime' };
    if (!hasAbsence && actSegs.some(s => s.start === s.end)) return { msg: '開始時間と終了時間が同じです。正しい時間を入力してください', field: 'actTime' };
    if (!hasAbsence && actSegs.some((s, i) => i > 0 && s.start && actSegs[i - 1].end && toMin(s.start) < toMin(actSegs[i - 1].end))) return { msg: '勤務の時間が重なっています。順番に入力してください', field: 'actTime' };
    if (!hasAbsence && actSegs.some(s => !(s.location ?? '').trim())) return { msg: '実際の勤務地を選択してください', field: 'actLoc' };
    if (!reviewerId)    return { msg: '確認依頼先を選択してください', field: 'reviewer' };
    if (editTarget && !changeSummary.trim()) return { msg: '修正内容を入力してください', field: 'changeSummary' };
    return { msg: '' };
  };

  const handleConfirmOpen = () => {
    const { msg, field } = validate();
    if (msg) {
      setError(msg);
      setErrFields(field ? new Set([field]) : new Set());
      if (field) scrollToFirstError([field]);
      return;
    }
    setError(''); setErrFields(new Set()); setShowConfirm(true);
  };

  const handleSubmit = async () => {
    setSaving(true);
    try {
      const isSelfReview = reviewerId === user.id;
      const now = new Date().toISOString();
      const record = {
        applicant_id:      applicantId,
        // 修正のときは「最初に出した人」を書き換えない（書き換えると代行表示が別人になってしまう）
        submitted_by:      editTarget ? editTarget.submitted_by : user.id,
        work_date:         date,
        pay_period_start:  calcPayPeriodStart(date),
        application_type:  pType,
        application_types: types,
        reason:            reason.trim() + (actNotes.trim() ? `\n備考：${actNotes.trim()}` : ''),
        original_location: noPlan ? null : (finalOrigLoc || null),
        original_start:    noPlan ? null : (origStart || null),
        original_end:      noPlan ? null : (origEnd || null),
        // 勤務した時間帯は jsonb に全部（最大3つ）入れる。
        // 2つ目以降があるとき、最初の空き（＝外出）を従来の列にも書いて、
        // 過去データ向けの表示・CSV・管理画面がそのまま動くようにする
        original_segments:     noPlan ? null : origSegs,
        original_outing_start: (noPlan || origSegs.length < 2) ? null : origSegs[0].end,
        original_outing_end:   (noPlan || origSegs.length < 2) ? null : origSegs[1].start,
        actual_location:   !hasAbsence ? (finalActLoc || null) : null,
        actual_start:      !hasAbsence ? (actStart || null) : null,
        actual_end:        !hasAbsence ? (actEnd || null) : null,
        actual_segments:     !hasAbsence ? actSegs : null,
        actual_outing_start: (!hasAbsence && actSegs.length >= 2) ? actSegs[0].end : null,
        actual_outing_end:   (!hasAbsence && actSegs.length >= 2) ? actSegs[1].start : null,
        break_minutes:     !hasAbsence && actStart && actEnd ? breakMin : null,
        labor_minutes:     !hasAbsence && actStart && actEnd ? laborMin : null,
        reviewer_id:       reviewerId,
        status:       isSelfReview ? 'confirmed' : (editTarget ? 'resubmitted' : 'pending'),
        confirmed_by: isSelfReview ? user.id : null,
        confirmed_at: isSelfReview ? now : null,
      };
      if (editTarget) {
        await supabase.from('shift_report_history').insert({ report_id: editTarget.id, changed_by: user.id, change_summary: changeSummary.trim(), snapshot: editTarget });
        // 更新できたか必ず確認する。権限が足りないと0件更新で静かに失敗し、直したつもりで直っていない事故になる
        const { data: updated, error: updErr } = await supabase.from('shift_reports').update(record).eq('id', editTarget.id).select('id');
        if (updErr || !updated || updated.length === 0) {
          console.error('[update shift_reports] error:', updErr);
          setError(updErr ? updErr.message : 'この報告を修正する権限がありません');
          setSaving(false); setShowConfirm(false);
          return;
        }
      } else {
        const { data: newReport, error: err } = await supabase.from('shift_reports').insert(record).select('id').single();
        if (err) {
          console.error('[insert shift_reports] error:', err);
          setError(err.code === '23505' ? '同じ日付の報告がすでにあります' : err.message);
          setSaving(false); setShowConfirm(false);
          return;
        }
        if (!isSelfReview) {
          // 通知：レビュアーへ
          supabase.from('notifications').insert({
            user_id: reviewerId,
            message: `${profileName ?? ''}さんから勤務変更報告が届きました`,
            sub_message: `${types.map(t => TYPE_INFO[t].label).join('＋')}　${date}`,
            source_type: 'shift_report:pending_approval',
            reference_id: newReport?.id,
            event_key: 'shift_report:new_request',
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
              segments: hasAbsence ? null : actSegs, // Slack本文の「時間」に使う
              report_id: newReport?.id, // 通知タップで該当行をハイライトするため
            },
          }).then(null, () => {});
        }
      }
      if (!editTarget) clearDraft(DRAFT_KEYS.shiftReport); // 送信成功で下書きを消す（新規のみ）
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

  const ef = (key: string): React.CSSProperties => ({ ...f, ...errorStyle(errFields.has(key), isDark) });
  const clearErr = (key: string) => setErrFields(prev => { if (!prev.has(key)) return prev; const n = new Set(prev); n.delete(key); return n; });  const L: React.CSSProperties = { fontSize: 12, color: subColor, marginBottom: 4, display: 'block' };
  const Req = <span style={{ color: '#dc3545' }}>*</span>;

  // 入力内容クリア（新規報告のみ。入力欄を初期状態に戻して下書きも消す）
  const clearShiftForm = () => {
    setApplicantId(user.id); setDate(todayStr()); setTypes([]); setReason(''); setOrigDayOff(false);
    setOrigLocOther([]); setActLocOther([]);
    setOrigSegs([{ start: '', end: '' }]); setActSegs([{ start: '', end: '' }]);
    setReviewerId(''); setActNotes(''); setError('');
    clearDraft(DRAFT_KEYS.shiftReport);
  };

  const formBody = (
    <div style={{ padding: inline ? '12px 0 0' : '16px 16px 0' }}>
            {/* 入力内容クリア（修正モードでは非表示） */}
            {!editTarget && (
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
                <button type="button" onClick={clearShiftForm}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: subColor, background: 'none', border: `1px solid ${borderCol}`, borderRadius: 14, padding: '4px 12px', cursor: 'pointer' }}>
                  クリア
                </button>
              </div>
            )}
            {/* 代行バナー */}
            {canProxy && applicantId !== user.id && (
              <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 10, padding: '10px 14px', marginBottom: 12, fontSize: 13, color: '#1e40af' }}>
                👤 <b>{staffList.find(s => s.id === applicantId)?.name}</b> さんの代わりに報告中
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
            <div style={{ marginBottom: 14 }} data-err-field="date">
              <label style={{ ...L, color: errorLabelColor(errFields.has('date'), subColor) }}>日付 {Req}</label>
              <SingleDatePicker value={date} onChange={d => { setDate(d); clearErr('date'); }} isDark={isDark} calendarKinds={calendarKinds} hasError={errFields.has('date')} />
            </div>
            {/* 種別 */}
            <div style={{ marginBottom: 14 }}>
              <label style={{ ...L, color: errorLabelColor(errFields.has('types'), subColor) }}>種別 {Req}（複数選択可）</label>
              {/* 未選択のまま送信したときは、ボタン群ごと薄赤で囲む（1つずつ赤くすると種別ごとの色と喧嘩するため） */}
              <div data-err-field="types" style={{ border: '1px solid transparent', borderRadius: 10, padding: 8, ...errorStyle(errFields.has('types'), isDark) }}>
              {/* 1段目：休日出勤・欠勤 */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
                {(['holiday_work', 'absence'] as ApplicationType[]).map(t => {
                  const sel = types.includes(t);
                  const blk = isBlockedWith(types, t) && !sel;
                  return (
                    <button key={t} onClick={() => toggleType(t)} disabled={blk}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 12px', borderRadius: 10, border: `2px solid ${sel ? TYPE_INFO[t].color : t === 'absence' ? '#fecaca' : (isDark ? '#6c757d' : '#e5e7eb')}`, background: sel ? '#f0fdf4' : t === 'absence' ? (isDark ? '#2d1215' : '#fff8f8') : (isDark ? '#495057' : 'white'), cursor: blk ? 'not-allowed' : 'pointer', opacity: blk ? 0.5 : 1, transition: 'all 0.15s', textAlign: 'left' as const }}>
                      <div style={{ width: 18, height: 18, borderRadius: 4, border: `2px solid ${sel ? TYPE_INFO[t].color : (isDark ? '#adb5bd' : '#d1d5db')}`, background: sel ? TYPE_INFO[t].color : 'transparent', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontSize: 11, fontWeight: 'bold' }}>{sel ? '✓' : ''}</div>
                      <span style={{ fontSize: 14 }}>{TYPE_INFO[t].emoji}</span>
                      <span style={{ fontSize: 13, fontWeight: sel ? 'bold' : 'normal', color: sel ? TYPE_INFO[t].color : (t === 'absence' ? (isDark ? '#ff8a80' : '#991b1b') : textColor) }}>{TYPE_INFO[t].label}</span>
                      {t === 'absence' && <span style={{ fontSize: 10, color: sel ? TYPE_INFO[t].color : (isDark ? '#ffb4a9' : '#f87171'), border: `1px solid ${sel ? TYPE_INFO[t].color : (isDark ? '#8a4040' : '#fecaca')}`, borderRadius: 4, padding: '1px 5px', marginLeft: 'auto', background: sel ? '#fee2e2' : (isDark ? '#5a2a2a' : '#fff5f5'), fontWeight: 600 }}>単独</span>}
                    </button>
                  );
                })}
              </div>
              {/* 欠勤：連絡確認／連絡方法（押した欠勤ボタンの直下に表示。ライト/ダーク共通の明るいアンバー） */}
              <div ref={absencePanelRef}>
                {absencePrompt === 'confirm' && (
                  <div role="group" aria-live="polite" style={{ marginBottom: 8, padding: '12px 14px', background: '#fff8e1', border: '2px solid #f59e0b', borderRadius: 10 }}>
                    <div style={{ fontSize: 14, fontWeight: 'bold', color: '#b45309', marginBottom: 6 }}>⚠️ 欠勤の連絡はお済みですか？</div>
                    <div style={{ fontSize: 12, color: '#92400e', lineHeight: 1.7, marginBottom: 10 }}>このページは事後報告用です。連絡がまだの場合は、先にリーダー・マネージャーへ連絡をお願いします。</div>
                    <button type="button" onClick={() => { setTypes(['absence']); setAbsencePrompt('none'); clearErr('types'); }}
                      style={{ display: 'block', width: '100%', padding: '12px', marginBottom: 8, background: '#fff', border: '1.5px solid #b45309', borderRadius: 8, color: '#b45309', fontSize: 13, fontWeight: 'bold', cursor: 'pointer' }}>
                      連絡済みです（報告をつづける）
                    </button>
                    <button type="button" onClick={() => setAbsencePrompt('declined')}
                      style={{ display: 'block', width: '100%', padding: '12px', background: '#f59e0b', border: 'none', borderRadius: 8, color: '#fff', fontSize: 13, fontWeight: 'bold', cursor: 'pointer' }}>
                      まだ連絡していない
                    </button>
                  </div>
                )}
                {absencePrompt === 'declined' && (
                  <div role="group" aria-live="polite" style={{ marginBottom: 8, padding: '12px 14px', background: '#fff8e1', border: '2px solid #f59e0b', borderRadius: 10 }}>
                    <div style={{ fontSize: 14, fontWeight: 'bold', color: '#b45309', marginBottom: 8 }}>📞 欠勤の連絡方法</div>
                    <div style={{ fontSize: 12, color: '#92400e', lineHeight: 1.9 }}>
                      ・前日まで：リーダー・マネージャーへ連絡<br />
                      ・当日の朝：チームマネージャーへなるべく電話（7:30までに）<br />
                      ・営業時間内：下記へ電話
                    </div>
                    <a href="tel:0755854018" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, width: '100%', padding: '12px', margin: '8px 0 4px', background: '#b45309', border: 'none', borderRadius: 8, color: '#fff', fontSize: 14, fontWeight: 'bold', textDecoration: 'none', boxSizing: 'border-box' }}>📞 075-585-4018 に電話する</a>
                    <div style={{ fontSize: 11, color: '#a16207', marginBottom: 8 }}>受付：平日 9:30-20:00／土 9:30-18:00／日 9:30-16:00</div>
                    <div style={{ fontSize: 12, color: '#92400e', lineHeight: 1.7 }}>連絡が済んだら、もう一度「❌ 欠勤」を押してください。</div>
                    <button type="button" onClick={() => setAbsencePrompt('none')}
                      style={{ marginTop: 8, padding: '6px 14px', background: 'transparent', border: '1px solid #f0c675', borderRadius: 8, color: '#b45309', fontSize: 12, cursor: 'pointer' }}>閉じる</button>
                  </div>
                )}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 8, marginBottom: 8 }}>
                {(['location_change'] as ApplicationType[]).map(t => {
                  const sel = types.includes(t);
                  const blk = isBlockedWith(types, t) && !sel;
                  const locColor = TYPE_INFO[t].color;
                  return (
                    <button key={t} onClick={() => toggleType(t)} disabled={blk}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 12px', borderRadius: 10, border: `2px solid ${sel ? locColor : (isDark ? '#6c757d' : '#e5e7eb')}`, background: sel ? '#f5f3ff' : (isDark ? '#495057' : 'white'), cursor: blk ? 'not-allowed' : 'pointer', opacity: blk ? 0.5 : 1, transition: 'all 0.15s', textAlign: 'left' as const }}>
                      <div style={{ width: 18, height: 18, borderRadius: 4, border: `2px solid ${sel ? locColor : (isDark ? '#adb5bd' : '#d1d5db')}`, background: sel ? locColor : 'transparent', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: isDark ? '#1a1a2e' : 'white', fontSize: 11, fontWeight: 'bold' }}>{sel ? '✓' : ''}</div>
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
                      style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 12px', borderRadius: 10, border: `2px solid ${sel ? TYPE_INFO[t].color : (isDark ? '#6c757d' : '#e5e7eb')}`, background: sel ? '#f0f9ff' : (isDark ? '#495057' : 'white'), cursor: blk ? 'not-allowed' : 'pointer', opacity: blk ? 0.5 : 1, transition: 'all 0.15s', textAlign: 'left' as const }}>
                      <div style={{ width: 18, height: 18, borderRadius: 4, border: `2px solid ${sel ? TYPE_INFO[t].color : (isDark ? '#adb5bd' : '#d1d5db')}`, background: sel ? TYPE_INFO[t].color : 'transparent', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontSize: 11, fontWeight: 'bold' }}>{sel ? '✓' : ''}</div>
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
                      style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 12px', borderRadius: 10, border: `2px solid ${sel ? TYPE_INFO[t].color : (isDark ? '#6c757d' : '#e5e7eb')}`, background: sel ? '#f0f9ff' : (isDark ? '#495057' : 'white'), cursor: blk ? 'not-allowed' : 'pointer', opacity: blk ? 0.5 : 1, transition: 'all 0.15s', textAlign: 'left' as const }}>
                      <div style={{ width: 18, height: 18, borderRadius: 4, border: `2px solid ${sel ? TYPE_INFO[t].color : (isDark ? '#adb5bd' : '#d1d5db')}`, background: sel ? TYPE_INFO[t].color : 'transparent', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontSize: 11, fontWeight: 'bold' }}>{sel ? '✓' : ''}</div>
                      <span style={{ fontSize: 14 }}>{TYPE_INFO[t].emoji}</span>
                      <span style={{ fontSize: 13, fontWeight: sel ? 'bold' : 'normal', color: sel ? TYPE_INFO[t].color : textColor }}>{TYPE_INFO[t].label}</span>
                    </button>
                  );
                })}
              </div>
              </div>
              {/* 選択中サマリー / ブロック理由 */}
              {blockMsg ? (
                <div style={{ marginTop: 8, fontSize: 12, color: '#f97316', fontWeight: 500 }}>⚠️ {blockMsg}</div>
              ) : types.length > 0 ? (
                <div style={{ marginTop: 8, padding: '6px 12px', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8, fontSize: 12, color: '#065f46', fontWeight: 600 }}>
                  ✓ {typesLabel(types)}
                </div>
              ) : null}
            </div>
            {/* 理由 */}
            <div style={{ marginBottom: 14 }}>
              <label style={L}>理由 {Req}</label>
              <textarea data-err-field="reason" value={reason} onChange={e => { setReason(e.target.value); clearErr('reason'); }} rows={2} placeholder="例：保護者対応のため、レッスン応援要請のため" style={{ ...ef('reason'), resize: 'none' }} />
              <div style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
                {(['保護者対応のため', 'レッスン応援要請のため'] as const).map(ex => (
                  <button key={ex} type="button" onClick={() => setReason(ex)}
                    style={{ fontSize: 12, fontWeight: 'bold', padding: '5px 12px', border: `1px solid ${isDark ? '#3d5166' : '#90caf9'}`, borderRadius: 6, background: isDark ? '#2c3e50' : '#e8f4fd', color: isDark ? '#fff' : '#1565c0', cursor: 'pointer' }}>
                    文例 ー「{ex}」
                  </button>
                ))}
              </div>
              {/* 理由履歴（過去に自分が入力した理由・押すと入力） */}
              {visiblePastReasons.length > 0 && (
                <div style={{ background: isDark ? '#243447' : '#e8f4fd', border: `1px solid ${isDark ? '#3d5166' : '#90caf9'}`, borderRadius: 8, padding: '8px 10px', marginTop: 8 }}>
                  <div style={{ fontSize: 11.5, fontWeight: 'bold', color: isDark ? '#fff' : '#1565c0', marginBottom: 6 }}>📋 過去に入力した理由</div>
                  {(showAllReasons ? visiblePastReasons : visiblePastReasons.slice(0, 3)).map((rz, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px', background: isDark ? '#2c3e50' : '#fff', border: `1px solid ${isDark ? '#3d5166' : '#bbdefb'}`, borderRadius: 5, marginBottom: 5 }}>
                      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12, color: isDark ? '#fff' : '#333' }}>{rz}</span>
                      <button type="button" onClick={() => setReason(rz)}
                        style={{ flexShrink: 0, background: '#1976d2', color: '#fff', fontSize: 11, fontWeight: 'bold', padding: '4px 12px', border: 'none', borderRadius: 4, cursor: 'pointer' }}>入力</button>
                      <button type="button" onClick={() => hideReason(rz)} title="この候補を消す"
                        style={{ flexShrink: 0, background: 'none', border: 'none', color: isDark ? '#adb5bd' : '#90a4ae', fontSize: 14, lineHeight: 1, padding: '2px 4px', cursor: 'pointer' }}>✕</button>
                    </div>
                  ))}
                  {visiblePastReasons.length > 3 && (
                    <button type="button" onClick={() => setShowAllReasons(v => !v)}
                      style={{ width: '100%', padding: '4px', background: 'none', border: `1px dashed ${isDark ? '#5a6b7d' : '#90caf9'}`, borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 'bold', color: isDark ? '#e9ecef' : '#1565c0', marginTop: 2 }}>
                      {showAllReasons ? '▲ 閉じる' : `▼ もっと見る（あと${visiblePastReasons.length - 3}件）`}
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* 予定していた時間（欠勤は非表示。休日出勤は早出・遅刻・早退・残業を選んだときだけ表示） */}
            {planVisible && (
            <div style={{ background: cardBg, borderRadius: 10, padding: '12px 14px', marginBottom: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 'bold', color: subColor, marginBottom: hasHoliday ? 4 : 10 }}>
                {hasHoliday ? '📋 予定していた時間' : '📋 通常シフト（もともとの予定）'}
              </div>
              {hasHoliday && (
                <div style={{ fontSize: 11, color: subColor, marginBottom: 10, lineHeight: 1.6 }}>
                  休日出勤で予定していた時間を入力してください。遅刻・早退などはこの時間と比べて記録されます。
                </div>
              )}
              {!hasHoliday && (
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: textColor, marginBottom: 10, cursor: 'pointer' }}>
                  <input type="checkbox" checked={origDayOff} onChange={e => setOrigDayOff(e.target.checked)}
                    style={{ width: 16, height: 16, accentColor: '#28a745', cursor: 'pointer' }} />
                  もともと休みの日
                </label>
              )}
              {!noPlan && (
                <>
                  <label style={L}>勤務時間・勤務地 {Req}</label>
                  {/* 勤務した時間帯を最大3つ。残業ページと同じ形（間の空きが外出・中抜けになる）。
                      校をまたぐ日があるため、勤務地は時間帯ごとに選ぶ */}
                  {origSegs.map((s, i) => {
                    const other = isOtherLoc(origLocOther, s, i);
                    // 入力漏れの行だけを薄赤にする（どの行を直せばよいか分かるように）
                    const badTime = errFields.has('origTime') && (!s.start || !s.end || s.start === s.end);
                    const badLoc  = errFields.has('origLoc') && !(s.location ?? '').trim();
                    return (
                    <div key={i} style={{ marginBottom: 10 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                        <span style={{ fontSize: 12, color: '#888', minWidth: 44, flexShrink: 0 }}>勤務{i + 1}</span>
                        <input type="time" data-err-field={i === 0 ? 'origTime' : undefined} value={s.start} onChange={e => { setOrigSegs(prev => prev.map((p, j) => j === i ? { ...p, start: e.target.value } : p)); clearErr('origTime'); }} style={{ ...f, ...errorStyle(badTime, isDark), flex: 1, minWidth: 0 }} />
                        <span style={{ color: '#888', flexShrink: 0 }}>〜</span>
                        <input type="time" value={s.end} onChange={e => { setOrigSegs(prev => prev.map((p, j) => j === i ? { ...p, end: e.target.value } : p)); clearErr('origTime'); }} style={{ ...f, ...errorStyle(badTime, isDark), flex: 1, minWidth: 0 }} />
                        {origSegs.length > 1 && (
                          <button type="button" onClick={() => { setOrigSegs(prev => prev.filter((_, j) => j !== i)); setOrigLocOther(prev => prev.filter((_, j) => j !== i)); }}
                            aria-label={`勤務${i + 1}を削除`}
                            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, color: '#888', flexShrink: 0 }}>🚫</button>
                        )}
                      </div>
                      <div style={{ paddingLeft: 52 }}>
                        <select data-err-field={i === 0 ? 'origLoc' : undefined}
                          value={other ? 'その他' : (s.location ?? '')}
                          onChange={e => {
                            const v = e.target.value;
                            setOrigLocOther(prev => { const n = [...prev]; n[i] = v === 'その他'; return n; });
                            setOrigSegs(prev => prev.map((p, j) => j === i ? { ...p, location: v === 'その他' ? '' : v } : p));
                            clearErr('origLoc');
                          }} style={{ ...f, ...errorStyle(badLoc, isDark) }}>
                          <option value="">勤務地を選択してください</option>
                          {workplaces.map(w => <option key={w} value={w}>{w}</option>)}
                          <option value="その他">その他（自由入力）</option>
                        </select>
                        {other && (
                          <input type="text" value={s.location ?? ''} onChange={e => setOrigSegs(prev => prev.map((p, j) => j === i ? { ...p, location: e.target.value } : p))}
                            placeholder="勤務地を入力してください" style={{ ...f, marginTop: 6 }} />
                        )}
                      </div>
                    </div>
                    );
                  })}
                  {origSegs.length < MAX_SEGS && (
                    <button type="button" onClick={() => setOrigSegs(prev => [...prev, { start: '', end: '' }])}
                      style={{ background: isDark ? '#2c3e50' : '#e8f4fd', border: `1px solid ${isDark ? '#4a90d9' : '#90caf9'}`, borderRadius: 8, cursor: 'pointer', padding: '6px 12px', fontSize: 12.5, color: isDark ? '#fff' : '#1565c0', width: '100%' }}>
                      ＋ 勤務時間帯を追加（外出・戻りがある場合）
                    </button>
                  )}
                </>
              )}
            </div>
            )}

            {/* 実際のシフト */}
            {!hasAbsence && (
              <div style={{ background: cardBg2, borderRadius: 10, padding: '12px 14px', marginBottom: 12 }}>
                <div style={{ fontSize: 12, fontWeight: 'bold', color: subColor, marginBottom: 10 }}>✅ 実際に勤務した時間</div>
                <label style={L}>勤務時間・勤務地 {Req}</label>
                {/* 勤務した時間帯を最大3つ。校をまたぐ日があるため勤務地は時間帯ごとに選ぶ */}
                {actSegs.map((s, i) => {
                  const other = isOtherLoc(actLocOther, s, i);
                  // 入力漏れの行だけを薄赤にする（どの行を直せばよいか分かるように）
                  const badTime = errFields.has('actTime') && (!s.start || !s.end || s.start === s.end);
                  const badLoc  = errFields.has('actLoc') && !(s.location ?? '').trim();
                  return (
                  <div key={i} style={{ marginBottom: 10 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                      <span style={{ fontSize: 12, color: '#888', minWidth: 44, flexShrink: 0 }}>勤務{i + 1}</span>
                      <input type="time" data-err-field={i === 0 ? 'actTime' : undefined} value={s.start} onChange={e => { setActSegs(prev => prev.map((p, j) => j === i ? { ...p, start: e.target.value } : p)); clearErr('actTime'); }} style={{ ...f, ...errorStyle(badTime, isDark), flex: 1, minWidth: 0 }} />
                      <span style={{ color: '#888', flexShrink: 0 }}>〜</span>
                      <input type="time" value={s.end} onChange={e => { setActSegs(prev => prev.map((p, j) => j === i ? { ...p, end: e.target.value } : p)); clearErr('actTime'); }} style={{ ...f, ...errorStyle(badTime, isDark), flex: 1, minWidth: 0 }} />
                      {actSegs.length > 1 && (
                        <button type="button" onClick={() => { setActSegs(prev => prev.filter((_, j) => j !== i)); setActLocOther(prev => prev.filter((_, j) => j !== i)); }}
                          aria-label={`勤務${i + 1}を削除`}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, color: '#888', flexShrink: 0 }}>🚫</button>
                      )}
                    </div>
                    <div style={{ paddingLeft: 52 }}>
                      <select data-err-field={i === 0 ? 'actLoc' : undefined}
                        value={other ? 'その他' : (s.location ?? '')}
                        onChange={e => {
                          const v = e.target.value;
                          setActLocOther(prev => { const n = [...prev]; n[i] = v === 'その他'; return n; });
                          setActSegs(prev => prev.map((p, j) => j === i ? { ...p, location: v === 'その他' ? '' : v } : p));
                          clearErr('actLoc');
                        }} style={{ ...f, ...errorStyle(badLoc, isDark) }}>
                        <option value="">勤務地を選択してください</option>
                        {workplaces.map(w => <option key={w} value={w}>{w}</option>)}
                        <option value="その他">その他（自由入力）</option>
                      </select>
                      {other && (
                        <input type="text" value={s.location ?? ''} onChange={e => setActSegs(prev => prev.map((p, j) => j === i ? { ...p, location: e.target.value } : p))}
                          placeholder="勤務地を入力してください" style={{ ...f, marginTop: 6 }} />
                      )}
                    </div>
                  </div>
                  );
                })}
                {actSegs.length < MAX_SEGS && (
                  <button type="button" onClick={() => setActSegs(prev => [...prev, { start: '', end: '' }])}
                    style={{ background: isDark ? '#2c3e50' : '#e8f4fd', border: `1px solid ${isDark ? '#4a90d9' : '#90caf9'}`, borderRadius: 8, cursor: 'pointer', padding: '6px 12px', fontSize: 12.5, color: isDark ? '#fff' : '#1565c0', width: '100%', marginBottom: 8 }}>
                    ＋ 勤務時間帯を追加（外出・戻りがある場合）
                  </button>
                )}
                {actStart && actEnd && laborMin > 0 && (
                  <div style={{ background: isDark ? '#1e3d2f' : '#dcfce7', borderRadius: 8, padding: '8px 12px' }}>
                    <div style={{ fontSize: 12, color: isDark ? '#4ade80' : '#166534' }}>🕐 休憩 {breakMin}分{actOutingMin > 0 ? `　＋　外出 ${formatMin(actOutingMin)}` : ''}　／　実労働 {formatMin(laborMin)}</div>
                    {!noPlan && origMin > 0 && (
                      <div style={{ marginTop: 4 }}>
                        {types.includes('early_start') && toMin(origStart) > toMin(actStart) && <div style={{ fontSize: 13, fontWeight: 'bold', color: '#0891b2' }}>🌅 早出：{formatMin(toMin(origStart) - toMin(actStart))}</div>}
                        {types.includes('tardiness') && toMin(actStart) > toMin(origStart) && <div style={{ fontSize: 13, fontWeight: 'bold', color: '#7b1fa2' }}>🕐 遅刻：{formatMin(toMin(actStart) - toMin(origStart))}</div>}
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

            {/* 確認依頼先。
                確認者が他人の報告を修正するときは変更できない（DBのRLS reviewer_confirm が
                「自分が確認者である報告」しか更新を許さないため、変えると保存自体が失敗する）。
                本人が自分の未承認の報告を直すときと、管理者は変更できる。 */}
            <div style={{ marginBottom: 14 }}>
              <label style={L}>確認依頼先 {!lockReviewer && Req}</label>
              {lockReviewer ? (
                <>
                  <div style={{ ...f, background: isDark ? '#2c3136' : '#f1f3f5', color: isDark ? '#adb5bd' : '#555', display: 'flex', alignItems: 'center' }}>
                    {reviewers.find(r => r.id === reviewerId)?.name ?? '—'}
                  </div>
                  <div style={{ marginTop: 6, background: isDark ? '#2c3e50' : '#e8f4fd', border: `1px solid ${isDark ? '#3d5a73' : '#bee5eb'}`, borderRadius: 8, padding: '9px 11px', fontSize: 12, lineHeight: 1.7, color: isDark ? '#d0dde8' : '#2c5f6e' }}>
                    確認依頼先は、この画面では変更できません。<br />
                    他の方に確認を依頼する場合は、この画面を閉じ、確認ページの「差戻」から本人に差し戻してください。差し戻された報告は、本人が確認依頼先を選び直して再提出できます。
                  </div>
                </>
              ) : (
              <select data-err-field="reviewer" value={reviewerId} onChange={e => { setReviewerId(e.target.value); clearErr('reviewer'); }} style={ef('reviewer')}>
                <option value="">選択してください</option>
                {/* 自分が承認者の場合は最上部に表示 */}
                {reviewers.find(r => r.id === user.id) && (
                  <option value={user.id}>
                    ✓ {reviewers.find(r => r.id === user.id)!.name}（自分）※報告と同時に受理されます
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
              )}
            </div>

            {/* 修正コメント（編集時） */}
            {editTarget && (
              <div style={{ marginBottom: 14 }}>
                <label style={L}>修正内容 {Req}</label>
                <textarea data-err-field="changeSummary" value={changeSummary} onChange={e => { setChangeSummary(e.target.value); clearErr('changeSummary'); }} rows={2}
                  placeholder="例：退勤時刻を19:00→20:00に変更 理由：残業が延長したため"
                  style={{ ...ef('changeSummary'), resize: 'none' }} />
              </div>
            )}

            {error && <div style={{ color: '#dc3545', fontSize: 13, marginBottom: 12 }}>⚠️ {error}</div>}
            <button type="button" onClick={handleConfirmOpen}
              style={{ width: '100%', padding: 14, background: '#28a745', color: '#fff', border: 'none', borderRadius: 10, fontSize: 15, fontWeight: 'bold', cursor: 'pointer' }}>
              報告内容を確認する
            </button>
    </div>
  );

  const confirmModal = showConfirm ? (
    <ConfirmModal
      data={{ date, types, reason, origLoc: finalOrigLoc, origStart, origEnd, origDayOff: noPlan, origSegs, actLoc: finalActLoc, actStart, actEnd, actSegs, actNotes, breakMin, laborMin, reviewerName, isSelfReview: reviewerId === user.id, applicantName: applicantId === user.id ? (profileName ?? '') : (staffList.find(s => s.id === applicantId)?.name ?? ''), isProxy: applicantId !== user.id }}
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
            <span style={{ fontWeight: 'bold', fontSize: 16, color: textColor }}>{editTarget ? '報告を修正' : '勤務変更報告'}</span>
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
  const noteBg    = isDark ? '#2c3e50' : '#e8f4fd';
  const noteBorder = isDark ? '#3d5a73' : '#bee5eb';
  const noteText  = isDark ? '#d0dde8' : '#2c5f6e';
  const noteTitleColor = isDark ? '#fff' : '#1a4a5a';
  const noteBtn   = isDark ? '#3d5a73' : '#bee5eb';

  const isApprover = IS_APPROVER(roleTitle, isAdmin);
  // RLS（approver_select）で全件閲覧可の役職と揃える。社長・フロア責任者はレビュー担当にならないため、
  // ここに含めないと通知バナーのタップ先（履歴）で何も表示されない
  const canSeeAll  = isAdmin || ['リーダー', 'マネージャー', 'フロア責任者', '社長', '管理者'].includes(roleTitle);

  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam                        = searchParams.get('tab');
  const focusParam                      = searchParams.get('focus');
  const [tab, setTab]                   = useState<'apply' | 'history'>(tabParam === 'history' ? 'history' : 'apply');
  // 🚨 同じページを開いたまま通知をタップされたときも履歴タブに切り替える。
  // 画面は作り直されないので、開いた瞬間の1回だけでは切り替わらない。
  // 依存はURLの「値」なので、確認ページの開閉（view の出し入れ）とは干渉しない
  useEffect(() => {
    if (tabParam === 'history') setTab('history');
  }, [tabParam, focusParam]);
  const [formKey, setFormKey]           = useState(0);
  const [cancelTarget, setCancelTarget] = useState<ShiftReport | null>(null);
  const [hardDeleteTargetId, setHardDeleteTargetId] = useState<string | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  // 確認ページはURLパラメータ(view=confirm)と連動させ、戻るボタンでTOPに戻れるようにする
  const confirmView = searchParams.get('view') === 'confirm';
  const setConfirmView = useCallback((v: boolean) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      if (v) next.set('view', 'confirm'); else next.delete('view');
      return next;
    }, { replace: false });
  }, [setSearchParams]);
  // 通知リンク等でview=confirmを持ったままこのページに直接遷移してきた場合、
  // その手前にTOP（申請/履歴タブ）のエントリが無いと戻るボタンで離脱してしまう。
  // 現エントリをTOPにreplaceしてから確認ページをpushし直し、戻れるようにする
  useEffect(() => {
    if (searchParams.get('view') === 'confirm') {
      setSearchParams(prev => {
        const next = new URLSearchParams(prev);
        next.delete('view');
        return next;
      }, { replace: true });
      setSearchParams(prev => {
        const next = new URLSearchParams(prev);
        next.set('view', 'confirm');
        return next;
      }, { replace: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
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
        : (isAdmin || ['リーダー', 'マネージャー', 'フロア責任者', '社長', '管理者'].includes(roleTitle)) ? 'all'
        : 'reviewed'
  );
  const [reviewedReports, setReviewedReports] = useState<ShiftReport[]>([]);
  const [proxyReports, setProxyReports]       = useState<ShiftReport[]>([]);
  const [allReports, setAllReports]           = useState<ShiftReport[]>([]);

  // 受理済み(confirmed)の自分の報告に紐づく最新の修正/取消依頼（バッジ用）
  const [corrections, setCorrections] = useState<Map<string, CorrectionRequestRow>>(new Map());
  const reloadCorrections = useCallback(() => {
    const ids = myReports.filter(r => r.status === 'confirmed').map(r => r.id);
    if (ids.length === 0) { setCorrections(new Map()); return; }
    fetchLatestCorrectionByTarget('shift', ids).then(setCorrections);
  }, [myReports]);
  useEffect(() => { reloadCorrections(); }, [reloadCorrections]);
  // 通知バナーから ?focus=<報告ID> で来たとき確認ビュー/履歴の該当カードを強調
  const { highlightId, focusRef } = useFocusHighlight(pendingReports.length + reviewedReports.length + allReports.length);
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
    setSuccessMsg('報告を送信しました ✓');
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
      message: `勤務変更報告が受理されました`,
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
        // Slack本文の「時間」に使う。古い報告は開始・終了の列しか持たないので parseSegments で復元する
        segments: parseSegments(report.actual_segments, report.actual_start, report.actual_end, report.actual_outing_start, report.actual_outing_end, report.actual_location),
        report_id: report.id, // 通知タップで該当行をハイライトするため
      },
    }).then(null, () => {});
    setConfirmingId(null);
    setSuccessMsg('受理しました ✓');
    window.dispatchEvent(new CustomEvent('shift-pending-changed'));
    fetchPending(); fetchMyReports();
  };

  const executeCancelReport = async () => {
    if (!cancelTarget) return;
    const r = cancelTarget;
    const summary = cancelReason.trim() ? `報告を取り消しました\n取り消し理由：${cancelReason.trim()}` : '報告を取り消しました';
    const { error } = await supabase.from('shift_reports').update({ status: 'cancelled' }).eq('id', r.id);
    if (error) { console.error('[cancelReport]', error); setCancelTarget(null); setCancelReason(''); return; }
    await supabase.from('shift_report_history').insert({ report_id: r.id, changed_by: user.id, change_summary: summary, snapshot: r }).then(null, () => {});
    // レビュアーが取り消した場合は申請者に通知
    if (r.applicant_id !== user.id) {
      await supabase.from('notifications').insert({
        user_id: r.applicant_id, message: '勤務変更報告が取り消されました',
        sub_message: `${TYPE_INFO[r.application_type].label}　${r.work_date}`,
        source_type: 'shift_report', reference_id: r.id, read: false,
      }).then(null, () => {});
    }
    setCancelTarget(null); setCancelReason('');
    window.dispatchEvent(new CustomEvent('shift-pending-changed'));
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
    // 🚨 差し戻しはDBで確定済み。画面を閉じて一覧を更新するのを通知より先にする。
    // 通知で例外が出るとここに到達せず、モーダルが開いたまま固まっていた
    setReturningId(null); setReturnTarget(null); setReturnComment('');
    window.dispatchEvent(new CustomEvent('shift-pending-changed'));
    fetchPending(); fetchReviewedReports(); fetchAllReports();
    setSuccessMsg('差戻しました');

    try {
      await notifyShiftReportReturned({
        reportId: r.id,
        applicantId: r.applicant_id,
        applicantName: (r.applicant as { name: string | null } | null)?.name ?? '',
        typeLabels: (r.application_types?.length ? r.application_types : [r.application_type]).map(t => TYPE_INFO[t]?.label ?? t).join('＋'),
        workDate: r.work_date,
        reason: comment,
      });
    } catch (e) {
      console.error('[shift] 差し戻し後の通知に失敗:', e);
      setSuccessMsg('⚠ 差戻しましたが、通知の送信に失敗しました。相手に直接お知らせしてください。');
    }
  };

  // 完全削除はアプリ規約によりwindow.confirmを使わず、ボタンの2段階インライン確認で行う
  const hardDeleteReport = async (r: ShiftReport) => {
    await supabase.from('shift_report_history').delete().eq('report_id', r.id);
    await supabase.from('shift_reports').delete().eq('id', r.id);
    setHardDeleteTargetId(null);
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

  // 強調対象が古い期間（折りたたみ中）にある場合はその期間を自動で開く
  useEffect(() => {
    if (!highlightId) return;
    const target = histReports.find(r => r.id === highlightId);
    if (target) setOpenPeriods(prev => prev.has(target.pay_period_start) ? prev : new Set(prev).add(target.pay_period_start));
  }, [highlightId, histReports]);

  const togglePeriod = (key: string) => {
    setOpenPeriods(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
  };

  // 取消・差戻し・修正フォームは「確認ページ」と「通常ページ」の両方から開く。
  // ⚠️ 以前ここを通常ページ側だけに置いていたため、確認ページではボタンを押しても
  //    何も出ない（＝効かない）状態だった。早期returnがあるので必ず両方に描画すること。
  const modals = (
    <>
      {/* 取り消し理由モーダル */}
      {cancelTarget && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 16px' }}>
          <div style={{ background: isDark ? '#343a40' : '#fff', borderRadius: 14, padding: 24, width: '100%', maxWidth: 340, boxShadow: '0 4px 24px rgba(0,0,0,0.2)' }}>
            <div style={{ fontSize: 15, fontWeight: 'bold', color: isDark ? '#fff' : '#1a1a2e', marginBottom: 6 }}>
              報告を取り消す
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
    </>
  );

  // ─── 確認ページ（承認者専用ビュー）───
  if (confirmView) {
    return (
      <div style={{ paddingTop: 70, maxWidth: 600, margin: '0 auto', paddingBottom: 24 }}>
        {successMsg && <BannerSuccess message={successMsg} onClose={() => setSuccessMsg('')} />}
        <div style={{ padding: '16px 16px 0' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
            <button onClick={() => navigate(-1)} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: text }}>‹</button>
            <span style={{ fontWeight: 'bold', fontSize: 16, color: text }}>確認ページ</span>
            {pendingReports.length > 0 && (
              <span style={{ background: '#dc3545', color: '#fff', borderRadius: 10, fontSize: 11, padding: '2px 8px', fontWeight: 'bold' }}>{pendingReports.length}件</span>
            )}
          </div>
          {pendingReports.length === 0 ? (
            <div style={{ textAlign: 'center', color: '#aaa', padding: 48, fontSize: 14 }}>確認待ちの報告はありません</div>
          ) : pendingReports.map(r => {
            const isFocused = highlightId === r.id;
            return (
              <div key={r.id} ref={el => { if (el && isFocused) focusRef.current = el; }} style={{ background: isFocused ? (isDark ? '#4a4423' : '#fff9c4') : bg, borderRadius: 10, border: `1px solid ${isFocused ? '#f0c000' : borderCol}`, marginBottom: 10, padding: '14px', transition: 'background 0.6s, border-color 0.6s' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <span style={{ fontSize: 13, fontWeight: 'bold', color: text }}>{(r.applicant as { name: string | null } | null)?.name ?? '不明'}</span>
                  <span style={{ fontSize: 11, color: '#888' }}>{r.work_date.slice(5).replace('-', '/')}（{dow(r.work_date)}）</span>
                  <span style={{ ...typeBadgeStyle(TYPE_INFO[r.application_type].color, TYPE_INFO[r.application_type].darkBg, isDark), marginLeft: 'auto' }}>
                    {(r.application_types?.length ? r.application_types : [r.application_type]).map(t => `${TYPE_INFO[t].emoji} ${TYPE_INFO[t].label}`).join(' ＋ ')}
                  </span>
                </div>
                {r.original_start
                  ? <div style={{ fontSize: 12, color: '#555', marginBottom: 2 }}>変更前：{r.original_location} {formatSegsFromRecord(r.original_segments, r.original_start, r.original_end, r.original_outing_start, r.original_outing_end, r.original_location)}</div>
                  : (r.application_type !== 'holiday_work' && r.application_type !== 'absence')
                    ? <div style={{ fontSize: 12, color: '#aaa', marginBottom: 2 }}>変更前：もともと休みの日</div>
                    : null
                }
                {r.actual_start && (
                  <div style={{ fontSize: 12, color: isDark ? '#4ade80' : '#166534', marginBottom: 4 }}>
                    変更後：{r.actual_location} {formatSegsFromRecord(r.actual_segments, r.actual_start, r.actual_end, r.actual_outing_start, r.actual_outing_end, r.actual_location)}　休憩 {r.break_minutes ?? 0}分　実労働 {r.labor_minutes ? formatMin(r.labor_minutes) : '-'}
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
        {modals}
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
        <h1 style={{ fontSize: 20, fontWeight: 'bold', color: text, margin: 0 }}>⏰ 勤務変更報告</h1>
      </div>

      <div style={{ padding: '0 16px' }}>
        {/* このページの説明 */}
        <div style={{
          background: '#fff3cd',
          border: '1px solid #ffe0a3',
          borderRadius: 8, padding: '12px 14px', marginBottom: 16, textAlign: 'left',
          position: 'relative', // 右上のFAQボタンの基準
        }}>
          <HelpLinkButton category="勤務変更報告" />
          <p style={{ fontSize: 13, fontWeight: 'bold', color: '#856404', textAlign: 'center', margin: '0 0 10px' }}>【パート・アルバイトスタッフ専用】</p>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, margin: '0 0 8px' }}>
            <span style={{ flexShrink: 0, width: 22, height: 22, borderRadius: '50%', background: '#4a90d9', color: '#fff', fontSize: 13, fontWeight: 'bold', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>1</span>
            <span style={{ fontSize: 14, fontWeight: 'bold', color: '#664d03', lineHeight: '22px' }}>発生した「休日出勤・残業・早退・遅刻・欠勤」を事後報告できます</span>
          </div>
          <p style={{ fontSize: 12, color: '#856404', lineHeight: 1.8, margin: '0 0 8px' }}>（これまでの残業申請表の代わりです。）</p>
          <p style={{ fontSize: 12, color: '#856404', lineHeight: 1.8, margin: 0 }}>※このページは「報告」用です。ここから休暇・お休みの申請はできません。</p>
          <p style={{ fontSize: 12, color: '#856404', lineHeight: 1.8, margin: 0 }}>（リーダー・マネージャーに連絡済みの「欠勤・勤務時間の変更」は、事前に入力できます。）</p>
          <p style={{ fontSize: 12, color: '#856404', lineHeight: 1.8, margin: 0 }}>※欠勤・遅刻・早退の連絡は、これまで通りリーダー・マネージャーへ直接連絡してください。</p>
        </div>

        {/* タブ（共通部品 PageTabs・休暇申請と同スタイル）
            dividerColor は従来この画面が使っていた borderCol（ダークでは非選択背景と同色＝実質見えない）を
            そのまま渡して見た目を維持している。休暇申請と完全に揃えたければこの prop を外す */}
        <PageTabs
          variant="shadow"
          isDark={isDark}
          inactiveColor={text}
          dividerColor={borderCol}
          tabs={[
            { key: 'apply' as const, label: '✏️ 報告' },
            { key: 'history' as const, label: '📋 履歴' },
          ]}
          active={tab}
          onChange={setTab}
        />

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
                <li>残業・早退・遅刻・欠勤が発生した場合に報告してください。</li>
                <li>報告先は、出勤する校の担当のリーダー・マネージャー（フロア責任者）を選択してください。</li>
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
                  ['own',      '自分の報告'],
                  ['reviewed', '確認した報告'],
                  ['proxy',    '代行した報告'],
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
                  <option value="pending">確認待ち</option>
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
                      const isFocused = highlightId === r.id;
                      // 本人が自分で直せる/取り消せるのは「未承認（承認前）」のときだけ。受理済みは修正/取消依頼へ。
                      const canSelfEdit = r.applicant_id === user.id && ['pending', 'resubmitted', 'returned'].includes(r.status);
                      return (
                        <div key={r.id} ref={el => { if (el && isFocused) focusRef.current = el; }} style={{ padding: '10px 14px', borderBottom: `1px solid ${isDark ? '#495057' : '#f5f5f5'}`, background: isFocused ? (isDark ? '#4a4423' : '#fff9c4') : 'transparent', display: 'flex', alignItems: 'flex-start', gap: 10, transition: 'background 0.6s' }}>
                          <div style={{ fontSize: 11, color: isDark ? '#adb5bd' : '#555', minWidth: 52, flexShrink: 0, marginTop: 2 }}>
                            {r.work_date.slice(5).replace('-', '/')}（{dow(r.work_date)}）
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            {histMode !== 'own' && (
                              <div style={{ fontSize: 12, fontWeight: 'bold', color: text, marginBottom: 2 }}>
                                {(r.applicant as { name: string | null } | null)?.name ?? '不明'}
                              </div>
                            )}
                            <div style={{ marginBottom: 4 }}>
                              <span style={typeBadgeStyle(TYPE_INFO[r.application_type].color, TYPE_INFO[r.application_type].darkBg, isDark)}>
                                {(r.application_types?.length ? r.application_types : [r.application_type]).map(t => `${TYPE_INFO[t].emoji} ${TYPE_INFO[t].label}`).join(' ＋ ')}
                              </span>
                            </div>
                            {r.original_start
                              ? <div style={{ fontSize: 11, color: isDark ? '#adb5bd' : '#888' }}>変更前：{r.original_location} {formatSegsFromRecord(r.original_segments, r.original_start, r.original_end, r.original_outing_start, r.original_outing_end, r.original_location)}</div>
                              : (r.application_type !== 'holiday_work' && r.application_type !== 'absence')
                                ? <div style={{ fontSize: 11, color: isDark ? '#adb5bd' : '#bbb' }}>変更前：もともと休みの日</div>
                                : null
                            }
                            {r.actual_start && (
                              <div style={{ fontSize: 11, color: isDark ? '#4ade80' : '#166534' }}>
                                変更後：{r.actual_location ? `${r.actual_location}　` : ''}{formatSegsFromRecord(r.actual_segments, r.actual_start, r.actual_end, r.actual_outing_start, r.actual_outing_end, r.actual_location)}　休憩 {r.break_minutes ?? 0}分　実労働 {r.labor_minutes ? formatMin(r.labor_minutes) : '-'}
                                {dMin != null && oMin > 0 && r.application_type === 'tardiness' && (
                                  <span style={{ marginLeft: 4, color: isDark ? '#c084fc' : '#7b1fa2', fontWeight: 'bold' }}>
                                    ／遅刻 {formatMin(Math.abs(Math.min(0, dMin)))}
                                  </span>
                                )}
                              </div>
                            )}
                            <div style={{ fontSize: 11, color: isDark ? '#adb5bd' : '#888', marginTop: 2 }}>{r.reason}</div>
                            {r.applicant_id === user.id && r.status === 'confirmed' && (
                              <CorrectionBadgeAndButton
                                targetType="shift"
                                targetId={r.id}
                                targetLabel={`勤務変更 ${r.work_date.slice(5).replace('-', '/')}（${dow(r.work_date)}）`}
                                fields={[
                                  { key: 'date', label: '日付', current: r.work_date, inputType: 'date' },
                                  { key: 'time', label: '時間', current: r.actual_start ? `${r.actual_start.slice(0,5)}〜${r.actual_end?.slice(0,5) ?? ''}` : '' },
                                  { key: 'location', label: '校', current: r.actual_location ?? '' },
                                ]}
                                requesterName={profileName || user.email || 'スタッフ'}
                                isDark={isDark}
                                latest={corrections.get(r.id) ?? null}
                                canRequest
                                onSubmitted={reloadCorrections}
                              />
                            )}
                          </div>
                          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, flexShrink: 0 }}>
                            <span style={{ fontSize: 10, fontWeight: 'bold', color: (STATUS_INFO[r.status] ?? STATUS_INFO['pending']).color, background: (STATUS_INFO[r.status] ?? STATUS_INFO['pending']).bg, borderRadius: 10, padding: '2px 8px', whiteSpace: 'nowrap' }}>
                              {(STATUS_INFO[r.status] ?? STATUS_INFO['pending']).label}
                            </span>
                            {canSelfEdit && (
                              <button onClick={() => { setEditTarget(r); setShowForm(true); }}
                                style={{ fontSize: 11, color: '#28a745', background: 'none', border: '1px solid #28a745', borderRadius: 6, padding: '2px 8px', cursor: 'pointer' }}>
                                修正
                              </button>
                            )}
                            {canSelfEdit && (
                              <button onClick={() => { setCancelTarget(r); setCancelReason(''); }}
                                style={{ fontSize: 11, color: '#dc3545', background: 'none', border: '1px solid #dc3545', borderRadius: 6, padding: '2px 8px', cursor: 'pointer' }}>
                                取消
                              </button>
                            )}
                            {isAdmin && (
                              hardDeleteTargetId === r.id ? (
                                <>
                                  <button onClick={() => hardDeleteReport(r)}
                                    style={{ fontSize: 11, color: '#fff', background: '#dc3545', border: '1px solid #dc3545', borderRadius: 6, padding: '2px 8px', cursor: 'pointer', fontWeight: 'bold' }}>
                                    完全削除する（取り消せません）
                                  </button>
                                  <button onClick={() => setHardDeleteTargetId(null)}
                                    style={{ fontSize: 11, color: '#6c757d', background: 'none', border: '1px solid #6c757d', borderRadius: 6, padding: '2px 8px', cursor: 'pointer' }}>
                                    やめる
                                  </button>
                                </>
                              ) : (
                                <button onClick={() => setHardDeleteTargetId(r.id)}
                                  style={{ fontSize: 11, color: '#6c757d', background: 'none', border: '1px solid #6c757d', borderRadius: 6, padding: '2px 8px', cursor: 'pointer' }}>
                                  完全削除
                                </button>
                              )
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
              <div style={{ textAlign: 'center', color: '#aaa', padding: 48, fontSize: 14 }}>報告履歴がありません</div>
            )}
          </div>
        )}
      </div>

      {modals}
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

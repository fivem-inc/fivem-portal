import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient';
import { useDarkMode } from '../hooks/useDarkMode';
import { DRAFT_KEYS, loadDraft, saveDraft, clearDraft } from '../lib/draftStorage';
import {
  calcTotalBreak, calcLaborMinutes, calcSegmentBreak, checkLegalBreak,
  timeToMin, minToTime, formatSignedMin, formatMin,
  todayJstStr, calcPayPeriodStartJst, payPeriodLabel, payMonthLabel,
  resolveDayKind, DAY_KIND_LABELS,
} from '../lib/breakCalc';
import type { WorkSegment, DayKind, CalendarKind } from '../lib/breakCalc';
import type { AuthUser } from '../types';
import CorrectionBadgeAndButton from '../components/CorrectionBadgeAndButton';
import { OT_TYPE_INFO, isOvertimeType, FULL_DAY_TYPES, isFullDayReport } from '../lib/overtimeTypes';
import type { OvertimeType } from '../lib/overtimeTypes';
import { fetchLatestCorrectionByTarget } from '../lib/correctionRequest';
import type { CorrectionRequestRow } from '../lib/correctionRequest';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────
type OvertimeStatus = 'requested' | 'request_confirmed' | 'reported' | 'confirmed' | 'returned' | 'cancelled';

interface NormalShiftSnapshot {
  day_kind: DayKind;
  calendar_kind: CalendarKind | null;
  start_time: string | null;   // "HH:MM:SS" or "HH:MM"
  end_time: string | null;
  start_time2?: string | null; // 2つ目の時間帯（外出・戻り・テレワーク）
  end_time2?: string | null;
  location?: string | null;    // 校
  break_minutes: number;
  labor_minutes: number;
  manual_override?: boolean;   // 申請時に本人が修正した場合true
}

interface SegmentRow {
  id?: string;
  report_id?: string;
  phase: 'planned' | 'actual';
  seg_no: number;
  start_min: number;
  end_min: number;
}

interface OvertimeReport {
  id: string;
  applicant_id: string;
  submitted_by: string;
  work_date: string;
  pay_period_start: string;
  entry_type: 'manual' | 'leave_auto';
  is_post_hoc: boolean;
  status: OvertimeStatus;
  normal_shift: NormalShiftSnapshot | null;
  break_minutes: number | null;
  break_manual: boolean;
  labor_minutes: number | null;
  diff_minutes: number | null;
  legal_warning: boolean;
  reason: string | null;
  location: string | null;
  application_types: string[] | null;
  furikae_origin_date: string | null;
  furikae_origin_location: string | null;
  reviewer_id: string | null;
  confirmed_by: string | null;
  confirmed_at: string | null;
  return_comment: string | null;
  source_leave_request_id: string | null;
  created_at: string;
  applicant?: { name: string | null } | null;
  reviewer?: { name: string | null } | null;
  segments?: SegmentRow[];
}

interface PatternRow {
  id: string;
  user_id: string;
  day_kind: DayKind;
  start_time: string | null;
  end_time: string | null;
  start_time2: string | null;
  end_time2: string | null;
  location: string | null;
  break_minutes: number;
  labor_minutes: number;
  valid_from: string;
  valid_to: string | null;
}

interface Reviewer { id: string; name: string; role_title: string; }

interface Props {
  user: AuthUser;
  profileName: string | null;
  roleTitle: string;
  isAdmin: boolean;
}

// ────────────────────────────────────────────────────────────────
// Constants & Utilities
// ────────────────────────────────────────────────────────────────
const REVIEWER_ROLES = ['リーダー', 'マネージャー'];
// 役職の序列（社長・管理者＞マネージャー＞リーダー＞フロア責任者＞一般）。数字が小さいほど上位。部門集計の並びに使う。
const ROLE_RANK: Record<string, number> = { '社長': 1, '管理者': 1, 'マネージャー': 2, 'リーダー': 3, 'フロア責任者': 4, '一般': 5 };
const roleRank = (role: string) => ROLE_RANK[role] ?? 99;
// 自己受理はマネージャー以上（2026-07-21ユーザー確定。リーダーは毎回マネージャー以上に申請）
const SELF_REVIEW_ROLES = ['マネージャー', '社長', '管理者'];
// 欠勤の受理者はマネージャー以上のみ（リーダー不可）
const ABSENCE_REVIEWER_ROLES = ['マネージャー'];
const DOW = ['日', '月', '火', '水', '木', '金', '土'];
const SELF_REVIEW_VALUE = '__self__';

function dowLabel(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return DOW[new Date(y, m - 1, d).getDay()];
}

// ステータス表示（既存STATUS_INFOの配色規約に合わせる。グレー=取消済みのため事後報告はティール）
const STATUS_INFO: Record<OvertimeStatus, { label: string; color: string; darkBg: string }> = {
  requested:         { label: '事前申請 確認待ち', color: '#e65100', darkBg: '#4a2c0a' },
  request_confirmed: { label: '事前申請 受理済み', color: '#2e7d32', darkBg: '#1b3a1e' },
  reported:          { label: '実績 確認待ち',     color: '#e65100', darkBg: '#4a2c0a' },
  confirmed:         { label: '確認済み',          color: '#1565c0', darkBg: '#1e3a5f' },
  returned:          { label: '差し戻し',          color: '#c62828', darkBg: '#4a1515' },
  cancelled:         { label: '取消済み',          color: '#6c757d', darkBg: '#3a3f44' },
};

function badgeStyle(color: string, darkBg: string, isDark: boolean): React.CSSProperties {
  return {
    fontSize: 11, fontWeight: 'bold', padding: '2px 8px', borderRadius: 10,
    border: `1px solid ${color}`,
    background: isDark ? darkBg : `${color}1a`,
    color: isDark ? '#fff' : color,
    whiteSpace: 'nowrap',
  };
}

/** 種別チップ列（履歴カード・確認カード・確認ダイアログで共通利用） */
const TypeChips: React.FC<{ types: string[] | null | undefined; isDark: boolean }> = ({ types, isDark }) => {
  const list = (types ?? []).filter(isOvertimeType);
  if (list.length === 0) return null;
  return (
    <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap', verticalAlign: 'middle' }}>
      {list.map(t => (
        <span key={t} style={badgeStyle(OT_TYPE_INFO[t].color, OT_TYPE_INFO[t].darkBg, isDark)}>{OT_TYPE_INFO[t].label}</span>
      ))}
    </span>
  );
};

// 事後報告バッジ（ティール系。グレーは取消済みと衝突するため不可）
const POSTHOC_BADGE = { color: '#0f766e', darkBg: '#123a35' };
// 自動計上バッジ（調整休の紫に合わせる）
const AUTO_BADGE = { color: '#7d3c98', darkBg: '#3a1f4d' };

const PLUS_COLOR = '#1565c0';
const MINUS_COLOR = '#e65100';

function diffColor(min: number, isDark: boolean): string {
  if (min > 0) return isDark ? '#64b5f6' : PLUS_COLOR;
  if (min < 0) return isDark ? '#ffb74d' : MINUS_COLOR;
  return isDark ? '#adb5bd' : '#6c757d';
}

// 見込み(予定込み)合計に加算する未確定ステータス。
// request_confirmed（事前受理済み・実績待ち）を含めないと受理済みの時間が消えるため必ず含める。
// returned（差し戻し中）・cancelled（取消済み）は合計に入れない（cancelledは同日再申請で行が残存＝足すと二重計上）。
const PLANNED_STATUSES: OvertimeStatus[] = ['requested', 'request_confirmed', 'reported'];

export interface BalanceSummary {
  total: number;         // 確定合計 = Σ diff_minutes（confirmed）。給与に効く数字
  plannedDelta: number;  // 見込みの増分 = Σ diff_minutes（未確定ステータス）
  plannedTotal: number;  // 見込み合計 = total + plannedDelta
  plus: number;          // 残業（確定・プラス分）
  choseiMinus: number;   // 調整休（確定・マイナス分）
  otherMinus: number;    // 早退・調整（確定・マイナス分）
  minus: number;
  absenceDays: number;   // 欠勤（確定・日数別枠。時間には入れない）
  absencePending: number;// 欠勤（申請中）
  pendingCount: number;  // 確認待ち件数（requested/reported）
}

// 合計時間数の内訳を計算する純関数。本人カード・部門集計・個人詳細で共用する。
// allRows: 任意ユーザーの overtime_reports（複数期間を含んでよい）。period で対象期を絞る。
export function computeBalance(allRows: OvertimeReport[], period: string): BalanceSummary {
  const inPeriod = allRows.filter(r => r.pay_period_start === period);
  const confirmed = inPeriod.filter(r => r.status === 'confirmed');

  // 二重減算防止: 同日に確定済みの leave_auto（休暇由来の自動マイナス行）がある場合、
  // 同日の手動 chosei_off は計上しない（leave_auto を正とする）。両者は別々の部分ユニークで共存し得る。
  const autoDates = new Set(confirmed.filter(r => r.entry_type === 'leave_auto').map(r => r.work_date));
  const isDupChosei = (r: OvertimeReport) =>
    r.entry_type === 'manual' && (r.application_types ?? []).includes('chosei_off') && autoDates.has(r.work_date);
  const counted = confirmed.filter(r => !isDupChosei(r));

  const isChosei = (r: OvertimeReport) => r.entry_type === 'leave_auto' || (r.application_types ?? []).includes('chosei_off');
  const total = counted.reduce((s, r) => s + (r.diff_minutes ?? 0), 0);
  const plus = counted.filter(r => (r.diff_minutes ?? 0) > 0).reduce((s, r) => s + (r.diff_minutes ?? 0), 0);
  const choseiMinus = counted.filter(r => (r.diff_minutes ?? 0) < 0 && isChosei(r)).reduce((s, r) => s + (r.diff_minutes ?? 0), 0);
  const otherMinus = counted.filter(r => (r.diff_minutes ?? 0) < 0 && !isChosei(r)).reduce((s, r) => s + (r.diff_minutes ?? 0), 0);
  const minus = choseiMinus + otherMinus;

  // 見込み: 未確定ステータスの diff を加算（終日欠勤は diff=0 のため時間には影響しない）
  const plannedDelta = inPeriod.filter(r => PLANNED_STATUSES.includes(r.status)).reduce((s, r) => s + (r.diff_minutes ?? 0), 0);
  const plannedTotal = total + plannedDelta;

  // 欠勤は時間に入れず日数で別枠カウント
  const absenceDays = counted.filter(r => (r.application_types ?? []).includes('absence')).length;
  const absencePending = inPeriod.filter(r => r.status === 'requested' && (r.application_types ?? []).includes('absence')).length;
  const pendingCount = inPeriod.filter(r => r.status === 'requested' || r.status === 'reported').length;

  return { total, plannedDelta, plannedTotal, plus, choseiMinus, otherMinus, minus, absenceDays, absencePending, pendingCount };
}

// 部門集計の一覧行（1人分）。total=確定合計 / plannedTotal=見込み合計 / absenceDays=欠勤日数（別枠）
interface SummaryRow { userId: string; name: string; group: string; role: string; total: number; plannedTotal: number; absenceDays: number; }
type ProfLite = { id: string; name: string; group_names: string[] | null; role_title: string | null };

/** "HH:MM(:SS)" → "HH:MM" 表示用 */
function fmtTime(t: string | null | undefined): string {
  if (!t) return '-';
  return t.slice(0, 5);
}

/** 分 → <input type="time"> 用の "HH:MM"（時を必ずゼロ埋め・翌日印は除去）。
 * minToTime は表示用で時をゼロ埋めしないため（例 "9:15"）、そのまま value に入れると
 * time入力が不正値扱いで空表示になる。入力欄へ渡すときはこの関数で "09:15" に整える。 */
function toTimeInputValue(min: number): string {
  const [h, m] = minToTime(min).replace('翌', '').split(':');
  return `${h.padStart(2, '0')}:${m}`;
}

/** 時間帯配列（分）→「10:00〜17:20 / 18:00〜19:00」表示 */
function segmentsLabel(segs: SegmentRow[] | WorkSegment[]): string {
  const list = (segs as (SegmentRow | WorkSegment)[]).map(s => {
    const start = 'start_min' in s ? s.start_min : s.startMin;
    const end = 'end_min' in s ? s.end_min : s.endMin;
    return `${minToTime(start)}〜${minToTime(end)}`;
  });
  return list.join(' / ');
}

/** 曜日パターンから該当日の通常シフトを解決 */
function resolveNormalShift(
  patterns: PatternRow[], dateStr: string, calendarKind: CalendarKind | null
): NormalShiftSnapshot {
  const dayKind = resolveDayKind(dateStr, calendarKind);
  const sameKind = patterns.filter(p => p.day_kind === dayKind);
  let row = sameKind.find(p =>
    p.valid_from <= dateStr
    && (p.valid_to === null || p.valid_to >= dateStr)
  );
  // 事後報告などで、パターン登録日(valid_from)より前の過去日を選ぶと該当レンジが無く「休み」に
  // なってしまう。その曜日のパターンがある場合は最も近いもの（過去日なら最古／それ以外は最新）で代用する。
  if (!row && sameKind.length > 0) {
    const sorted = [...sameKind].sort((a, b) => (a.valid_from < b.valid_from ? -1 : 1));
    row = dateStr < sorted[0].valid_from ? sorted[0] : sorted[sorted.length - 1];
  }
  return {
    day_kind: dayKind,
    calendar_kind: calendarKind,
    start_time: row?.start_time ?? null,
    end_time: row?.end_time ?? null,
    start_time2: row?.start_time2 ?? null,
    end_time2: row?.end_time2 ?? null,
    location: row?.location ?? null,
    break_minutes: row?.break_minutes ?? 0,
    labor_minutes: row?.labor_minutes ?? 0,
  };
}

// 単一日付のタップ即確定カレンダー（スマホで「設定」を押させないため native input を置換）。
// min/max で選べる範囲を制限（事前申請=当日以降・事後報告=当日以前）。
const SingleDatePicker: React.FC<{
  value: string;
  onChange: (date: string) => void;
  isDark: boolean;
  minDate?: string;
  maxDate?: string;
}> = ({ value, onChange, isDark, minDate, maxDate }) => {
  const text = isDark ? '#f8f9fa' : '#212529';
  const borderColor = isDark ? '#6c757d' : '#dee2e6';
  const base = value ? new Date(value + 'T00:00:00') : new Date();
  const [viewYear, setViewYear] = useState(base.getFullYear());
  const [viewMonth, setViewMonth] = useState(base.getMonth());
  // 選択中の日付にビューを追従（モード切替で当日にジャンプ等）
  useEffect(() => {
    if (!value) return;
    const d = new Date(value + 'T00:00:00');
    setViewYear(d.getFullYear()); setViewMonth(d.getMonth());
  }, [value]);

  const fmt = (y: number, m: number, d: number) => `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const firstDay = new Date(viewYear, viewMonth, 1).getDay();
  const dayNames = ['日', '月', '火', '水', '木', '金', '土'];
  const t = new Date();
  const todayStr = fmt(t.getFullYear(), t.getMonth(), t.getDate());
  const prevMonth = () => { if (viewMonth === 0) { setViewYear(y => y - 1); setViewMonth(11); } else setViewMonth(m => m - 1); };
  const nextMonth = () => { if (viewMonth === 11) { setViewYear(y => y + 1); setViewMonth(0); } else setViewMonth(m => m + 1); };
  const cells: (number | null)[] = [];
  for (let i = 0; i < firstDay; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  return (
    <div style={{ background: isDark ? '#495057' : '#f8f9fa', borderRadius: 10, padding: 12, border: `1px solid ${borderColor}` }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <button type="button" onClick={prevMonth} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: text, padding: '0 10px', lineHeight: 1 }}>‹</button>
        <span style={{ fontWeight: 'bold', color: text, fontSize: 15 }}>{viewYear}年 {viewMonth + 1}月</span>
        <button type="button" onClick={nextMonth} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: text, padding: '0 10px', lineHeight: 1 }}>›</button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2, marginBottom: 4 }}>
        {dayNames.map((d, i) => (
          <div key={d} style={{ textAlign: 'center', fontSize: 11, fontWeight: 'bold', color: i === 0 ? '#e74c3c' : i === 6 ? '#3498db' : text, padding: '3px 0' }}>{d}</div>
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2 }}>
        {cells.map((day, i) => {
          if (!day) return <div key={`e-${i}`} />;
          const dateStr = fmt(viewYear, viewMonth, day);
          const isSelected = dateStr === value;
          const dow = (firstDay + day - 1) % 7;
          const isToday = dateStr === todayStr;
          const disabled = (!!minDate && dateStr < minDate) || (!!maxDate && dateStr > maxDate);
          return (
            <button key={dateStr} type="button" disabled={disabled}
              onClick={() => onChange(dateStr)}
              style={{
                padding: '10px 2px', minHeight: 40, borderRadius: 6,
                border: isToday ? '2px solid #007bff' : '1px solid transparent',
                background: isSelected ? '#28a745' : 'transparent',
                color: disabled ? (isDark ? '#5c636a' : '#c4c9cf') : isSelected ? 'white' : dow === 0 ? '#e74c3c' : dow === 6 ? '#3498db' : text,
                cursor: disabled ? 'default' : 'pointer', fontSize: 13,
                fontWeight: isSelected ? 'bold' : 'normal', textAlign: 'center',
              }}>
              {day}
            </button>
          );
        })}
      </div>
      {value && (
        <p style={{ margin: '10px 0 0', fontSize: 13, color: '#28a745', fontWeight: 'bold' }}>
          ✓ {parseInt(value.slice(5, 7))}/{parseInt(value.slice(8, 10))}（{dayNames[new Date(value + 'T00:00:00').getDay()]}）を選択中
        </p>
      )}
    </div>
  );
};

// ────────────────────────────────────────────────────────────────
// 申請・報告フォーム
// ────────────────────────────────────────────────────────────────
interface FormDraft {
  mode: 'advance' | 'posthoc';
  date: string;
  segments: { start: string; end: string }[];
  breakManual: boolean;
  breakManualMin: string;
  reason: string;
  location: string;
  locationCustom: string;
  reviewerId: string;
  normOverride: boolean;
  normStart: string;
  normEnd: string;
  fullDay?: boolean;
  fullDayType?: string;
  furikaeOriginDate?: string;
  furikaeOriginLocation?: string;
}

const EMPTY_SEG = { start: '', end: '' };

const OvertimeForm: React.FC<{
  user: AuthUser;
  profileName: string | null;
  roleTitle: string;
  isAdmin: boolean;
  reviewers: Reviewer[];
  workplaces: string[];
  patterns: PatternRow[];
  /** 実績報告・再提出の対象（新規はnull） */
  editTarget: OvertimeReport | null;
  onSaved: (gcalWarning?: string) => void;
  onClose: () => void;
}> = ({ user, profileName, roleTitle, isAdmin, reviewers, workplaces, patterns, editTarget, onSaved, onClose }) => {
  const isDark = useDarkMode();
  const draft = editTarget ? null : loadDraft<FormDraft>(DRAFT_KEYS.overtime);

  const isReportPhase = !!editTarget && ['requested', 'request_confirmed'].includes(editTarget.status);
  const isResubmit = !!editTarget && editTarget.status === 'returned';

  const [mode, setMode] = useState<'advance' | 'posthoc'>(() => {
    if (editTarget) return editTarget.is_post_hoc ? 'posthoc' : 'advance';
    return draft?.mode ?? 'advance';
  });
  const [date, setDate] = useState(() => editTarget?.work_date ?? draft?.date ?? '');
  const [segments, setSegments] = useState<{ start: string; end: string }[]>(() => {
    if (editTarget) {
      // 実績報告は予定をプリフィル、再提出は実績を復元
      const phase = isReportPhase ? 'planned' : 'actual';
      const rows = (editTarget.segments ?? []).filter(s => s.phase === phase).sort((a, b) => a.seg_no - b.seg_no);
      const fallback = (editTarget.segments ?? []).filter(s => s.phase === 'planned').sort((a, b) => a.seg_no - b.seg_no);
      const use = rows.length > 0 ? rows : fallback;
      if (use.length > 0) return use.map(s => ({ start: toTimeInputValue(s.start_min), end: toTimeInputValue(s.end_min) }));
      return [{ ...EMPTY_SEG }];
    }
    return draft?.segments?.length ? draft.segments : [{ ...EMPTY_SEG }];
  });
  const [breakManual, setBreakManual] = useState(() => editTarget?.break_manual ?? draft?.breakManual ?? false);
  const [breakManualMin, setBreakManualMin] = useState(() =>
    editTarget?.break_manual && editTarget.break_minutes != null ? String(editTarget.break_minutes) : (draft?.breakManualMin ?? ''));
  const [reason, setReason] = useState(() => editTarget?.reason ?? draft?.reason ?? '');
  // 勤務地：登録済みの校以外の値（自由入力）は「その他」＋カスタム欄に復元する
  const [location, setLocation] = useState(() => {
    const loc = editTarget?.location ?? '';
    if (loc.includes('→')) return '移動あり';
    if (loc) return workplaces.includes(loc) ? loc : 'その他';
    return draft?.location ?? '';
  });
  const [locationCustom, setLocationCustom] = useState(() => {
    const loc = editTarget?.location ?? '';
    if (loc && !loc.includes('→') && !workplaces.includes(loc)) return loc;
    return draft?.locationCustom ?? '';
  });
  // 勤務地変更（移動）：開始校→移動先校。effectiveLocation で「A→B」に合成する
  const [locMoveStart, setLocMoveStart] = useState(() => { const l = editTarget?.location ?? ''; return l.includes('→') ? l.split('→')[0] : ''; });
  const [locMoveEnd, setLocMoveEnd] = useState(() => { const l = editTarget?.location ?? ''; return l.includes('→') ? (l.split('→')[1] ?? '') : ''; });
  // 理由履歴（自分が過去に入力した理由）
  const [pastReasons, setPastReasons] = useState<string[]>([]);
  const [showAllReasons, setShowAllReasons] = useState(false);
  const [reviewerId, setReviewerId] = useState(() => editTarget?.reviewer_id ?? draft?.reviewerId ?? '');
  const [normOverride, setNormOverride] = useState(() => editTarget?.normal_shift?.manual_override ?? draft?.normOverride ?? false);
  const [normStart, setNormStart] = useState(() => fmtTime(editTarget?.normal_shift?.start_time) !== '-' ? fmtTime(editTarget?.normal_shift?.start_time) : (draft?.normStart ?? ''));
  const [normEnd, setNormEnd] = useState(() => fmtTime(editTarget?.normal_shift?.end_time) !== '-' ? fmtTime(editTarget?.normal_shift?.end_time) : (draft?.normEnd ?? ''));

  // 終日（調整休・欠勤）モード。時刻入力の代わりに種別3択（時間外調整休/振替休日/欠勤）で申請する
  const [fullDay, setFullDay] = useState<boolean>(() => {
    if (editTarget) return isFullDayReport(editTarget.application_types);
    return draft?.fullDay ?? false;
  });
  const [fullDayType, setFullDayType] = useState<OvertimeType | null>(() => {
    if (editTarget) {
      const t = (editTarget.application_types ?? []).find(x => (FULL_DAY_TYPES as string[]).includes(x));
      return t ? (t as OvertimeType) : null;
    }
    const d = draft?.fullDayType;
    return d && isOvertimeType(d) && FULL_DAY_TYPES.includes(d) ? d : null;
  });
  const [fullDayError, setFullDayError] = useState('');
  // 振替休日の振替元（実際に出勤した日＋その日の勤務校）
  const [furikaeOriginDate, setFurikaeOriginDate] = useState<string>(() => editTarget?.furikae_origin_date ?? draft?.furikaeOriginDate ?? '');
  const [furikaeOriginLocation, setFurikaeOriginLocation] = useState<string>(() => editTarget?.furikae_origin_location ?? draft?.furikaeOriginLocation ?? '');

  const [calendarKind, setCalendarKind] = useState<CalendarKind | null>(editTarget?.normal_shift?.calendar_kind ?? null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [breakRecalcNote, setBreakRecalcNote] = useState(false);
  const [showRules, setShowRules] = useState(false);

  // 下書き自動保存（新規のみ）
  useEffect(() => {
    if (editTarget) return;
    saveDraft(DRAFT_KEYS.overtime, {
      mode, date, segments, breakManual, breakManualMin, reason, location, locationCustom, reviewerId,
      normOverride, normStart, normEnd, fullDay, fullDayType: fullDayType ?? undefined,
      furikaeOriginDate, furikaeOriginLocation,
    } satisfies FormDraft);
  }, [editTarget, mode, date, segments, breakManual, breakManualMin, reason, location, locationCustom, reviewerId, normOverride, normStart, normEnd, fullDay, fullDayType, furikaeOriginDate, furikaeOriginLocation]);

  // 日付変更→会社カレンダー取得
  useEffect(() => {
    if (!date) { setCalendarKind(null); return; }
    let alive = true;
    supabase.from('company_calendar').select('kind').eq('date', date).maybeSingle()
      .then(({ data }) => { if (alive) setCalendarKind((data?.kind as CalendarKind) ?? null); }, () => {});
    return () => { alive = false; };
  }, [date]);

  // 通常シフト解決（スナップショット元）
  const normalShift: NormalShiftSnapshot = useMemo(() => {
    if (!date) return { day_kind: 'mon', calendar_kind: null, start_time: null, end_time: null, break_minutes: 0, labor_minutes: 0 };
    const base = resolveNormalShift(patterns, date, calendarKind);
    if (!normOverride) return base;
    const s = timeToMin(normStart);
    const e = timeToMin(normEnd);
    if (s == null || e == null || e <= s) return { ...base, manual_override: true };
    const br = calcSegmentBreak(s, e);
    return {
      ...base, manual_override: true,
      start_time: normStart, end_time: normEnd,
      break_minutes: br, labor_minutes: (e - s) - br,
    };
  }, [date, patterns, calendarKind, normOverride, normStart, normEnd]);

  // 勤務地が未選択なら通常シフトの校を初期値として入れる（新規のみ）
  useEffect(() => {
    if (editTarget || location) return;
    const loc = normalShift.location;
    if (!loc) return;
    if (loc.includes('→')) { setLocation('移動あり'); setLocMoveStart(loc.split('→')[0]); setLocMoveEnd(loc.split('→')[1] ?? ''); }
    else if (workplaces.includes(loc)) setLocation(loc);
    else { setLocation('その他'); setLocationCustom(loc); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [normalShift.location]);

  // 通常シフトの時間帯（band1＋band2）を {start,end} の配列にしたもの
  const normalSegs = useMemo(() => {
    const segs: { start: string; end: string }[] = [];
    if (normalShift.start_time) segs.push({ start: fmtTime(normalShift.start_time), end: fmtTime(normalShift.end_time) });
    if (normalShift.start_time2) segs.push({ start: fmtTime(normalShift.start_time2), end: fmtTime(normalShift.end_time2) });
    return segs;
  }, [normalShift.start_time, normalShift.end_time, normalShift.start_time2, normalShift.end_time2]);

  // 日付を選ぶ／変えると、その日の通常シフトで「予定の勤務時間」を埋め直す（新規のみ・日付ごとに1回）。
  // 利用者はここから残業・早退などの差分に直して送信する。日付を変えれば新しい日のシフトに連動する。
  // 下書き復元時・同一日付での再計算（休憩手修正など）では上書きしない（filledForDateRefで制御）。
  const filledForDateRef = useRef<string | null>(editTarget?.work_date ?? draft?.date ?? null);
  useEffect(() => {
    if (editTarget || !date) return;
    if (filledForDateRef.current === date) return;
    filledForDateRef.current = date;
    setSegments(normalSegs.length > 0 ? normalSegs.map(s => ({ ...s })) : [{ ...EMPTY_SEG }]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, normalSegs]);

  // 勤務地の実効値（保存・検証に使う）。移動あり＝「開始校→移動先校」
  const effectiveLocation =
    location === 'その他' ? locationCustom.trim()
    : location === '移動あり' ? (locMoveStart && locMoveEnd ? `${locMoveStart}→${locMoveEnd}` : '')
    : location;

  // 自分が過去に入力した理由（重複除去・新しい順）を取得
  useEffect(() => {
    supabase.from('overtime_reports').select('reason, created_at').eq('applicant_id', user.id)
      .not('reason', 'is', null).order('created_at', { ascending: false }).limit(50)
      .then(({ data }) => {
        const seen = new Set<string>(); const list: string[] = [];
        for (const r of (data ?? []) as { reason: string | null }[]) {
          const t = (r.reason ?? '').trim();
          if (t && !seen.has(t)) { seen.add(t); list.push(t); }
        }
        setPastReasons(list.slice(0, 12));
      }, () => {});
  }, [user.id]);

  // 実務時間帯（分）
  const workSegments: WorkSegment[] = useMemo(() =>
    segments
      .map(s => {
        const st = timeToMin(s.start);
        let en = timeToMin(s.end);
        if (st == null || en == null) return null;
        if (en <= st) en += 1440; // 深夜跨ぎは翌日扱い
        return { startMin: st, endMin: en };
      })
      .filter((s): s is WorkSegment => s !== null),
  [segments]);

  const autoBreak = useMemo(() => calcTotalBreak(workSegments), [workSegments]);
  const breakMin = breakManual ? (parseInt(breakManualMin, 10) || 0) : autoBreak;
  const laborMin = calcLaborMinutes(workSegments, breakMin);
  const diffMin = laborMin - normalShift.labor_minutes;
  const legal = checkLegalBreak(workSegments, breakMin);
  const hasInput = workSegments.length > 0;

  // ---- 種別の自動判定 ----
  // 時刻・勤務地の入力からシステムが種別を提案する。迷いやすい「調整か遅刻/早退か」だけ2択バナーで確定。
  // デフォルトは未選択(null)。本人が押さないと送信できない（validateでブロック）。
  const [lateChoice, setLateChoice] = useState<'adj' | 'tardiness' | null>(() => {
    const t = editTarget?.application_types ?? [];
    if (t.includes('tardiness')) return 'tardiness';
    if (t.includes('late_start_adj')) return 'adj';
    return null;
  });
  const [earlyChoice, setEarlyChoice] = useState<'adj' | 'early_leave' | null>(() => {
    const t = editTarget?.application_types ?? [];
    if (t.includes('early_leave')) return 'early_leave';
    if (t.includes('early_end_adj')) return 'adj';
    return null;
  });

  const typeDetect = useMemo(() => {
    if (!hasInput || !date) return { fixed: [] as OvertimeType[], lateQ: false, earlyQ: false };
    const fixed: OvertimeType[] = [];
    let lateQ = false, earlyQ = false;
    const sorted = [...workSegments].sort((a, b) => a.startMin - b.startMin);
    const firstStart = sorted[0].startMin;
    const lastEnd = sorted[sorted.length - 1].endMin;
    if (!normalShift.start_time) {
      fixed.push('holiday_work');
    } else {
      const ns = timeToMin(fmtTime(normalShift.start_time)) ?? 0;
      let ne = timeToMin(fmtTime(normalShift.end_time)) ?? ns;
      if (ne <= ns) ne += 1440; // 深夜跨ぎシフト
      if (lastEnd > ne) fixed.push('overtime');
      if (firstStart < ns) fixed.push('early_start');
      if (firstStart > ns) lateQ = true;
      if (lastEnd < ne) earlyQ = true;
    }
    // 勤務地がシフトの校と違う／移動あり → 勤務地変更
    const normLoc = normalShift.location ?? '';
    if (effectiveLocation && (effectiveLocation.includes('→') || (normLoc && effectiveLocation !== normLoc))) {
      fixed.push('location_change');
    }
    return { fixed, lateQ, earlyQ };
  }, [hasInput, date, workSegments, normalShift.start_time, normalShift.end_time, normalShift.location, effectiveLocation]);

  const applicationTypes: OvertimeType[] = useMemo(() => {
    if (fullDay && fullDayType) return [fullDayType]; // 終日は単独付与（DB制約と対応）
    const t = [...typeDetect.fixed];
    if (typeDetect.lateQ && lateChoice) t.push(lateChoice === 'adj' ? 'late_start_adj' : 'tardiness');
    if (typeDetect.earlyQ && earlyChoice) t.push(earlyChoice === 'adj' ? 'early_end_adj' : 'early_leave');
    return t;
  }, [typeDetect, lateChoice, earlyChoice, fullDay, fullDayType]);

  // 終日モードの派生値
  const fullDayMode = fullDay && !!fullDayType;
  const fdDiffMin = fullDayType === 'chosei_off' ? -normalShift.labor_minutes : 0;
  // 終日の勤務地はシフトの校を自動使用（シフトに校が無い日だけ手動選択）
  const fdLocation = normalShift.location ?? effectiveLocation;

  // 振替元の勤務日を選ぶと、その日のシフト（曜日パターン）から勤務校を自動取得（間違っていれば手修正）
  const furikaeFilledRef = useRef<string>(editTarget?.furikae_origin_date ?? '');
  useEffect(() => {
    if (!furikaeOriginDate) return;
    if (furikaeFilledRef.current === furikaeOriginDate) return;
    furikaeFilledRef.current = furikaeOriginDate;
    const loc = resolveNormalShift(patterns, furikaeOriginDate, null).location;
    setFurikaeOriginLocation(loc ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [furikaeOriginDate, patterns]);

  // 時間帯変更時：手修正中なら注意表示
  useEffect(() => {
    if (breakManual && hasInput) setBreakRecalcNote(true);
    else setBreakRecalcNote(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(segments)]);

  const canSelfReview = isAdmin || SELF_REVIEW_ROLES.includes(roleTitle);
  const isSelfReview = reviewerId === SELF_REVIEW_VALUE;

  const today = todayJstStr();

  // モード切替で選択日が範囲外になったらクリア（無効な日が選択済みに見えるのを防ぐ・新規のみ）
  useEffect(() => {
    if (editTarget || !date) return;
    if (mode === 'advance' && date < today) setDate('');
    if (mode === 'posthoc' && date > today) setDate('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const validate = (): string => {
    if (!date) return '日付を選択してください';
    if (mode === 'advance' && !editTarget && date < today) return '事前申請は当日以降の日付を選択してください';
    if (mode === 'posthoc' && date > today) return '事後報告は当日以前の日付を選択してください';
    // 終日（調整休・欠勤）は時刻・休憩・勤務地の検証をスキップし、専用の検証のみ行う
    if (fullDay) {
      if (!normalShift.start_time) return 'この日はシフトが休みです。出勤予定日のみ登録できます';
      if (!fullDayType) return '種別（時間外調整休・振替休日・欠勤）を選択してください';
      if (!fdLocation) return '勤務地を選択してください';
      if (fullDayType === 'furikae_off') {
        if (!furikaeOriginDate) return '振替元の勤務日を選択してください';
        if (!furikaeOriginLocation) return '振替元の勤務校を選択してください';
      }
      if (!reason.trim()) return '理由を入力してください';
      if (!reviewerId) return '申請先を選択してください';
      if (fullDayType === 'absence' && isSelfReview) return '欠勤は本人以外の受理が必要です';
      return '';
    }
    if (workSegments.length === 0) return '勤務時間帯を入力してください';
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i];
      if ((s.start && !s.end) || (!s.start && s.end)) return `時間帯${i + 1}の開始・終了を両方入力してください`;
    }
    // 帯の重複チェック
    const sorted = [...workSegments].sort((a, b) => a.startMin - b.startMin);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].startMin < sorted[i - 1].endMin) return '時間帯が重なっています。開始・終了時刻を確認してください';
    }
    if (breakManual && (breakManualMin === '' || isNaN(parseInt(breakManualMin, 10)) || parseInt(breakManualMin, 10) < 0)) {
      return '休憩時間（分）を入力してください';
    }
    if (!location) return '勤務地を選択してください';
    if (location === 'その他' && !locationCustom.trim()) return '勤務地を入力してください';
    if (location === '移動あり' && (!locMoveStart || !locMoveEnd)) return '移動元・移動先の校を選択してください';
    if (!reason.trim()) return '理由を入力してください';
    if (!reviewerId) return '申請先を選択してください';
    // 通常シフトと全く同じ内容（時間帯・休憩・勤務地に変更なし）では送信不可
    const sameSegs = segments.length === normalSegs.length
      && segments.every((s, i) => s.start === normalSegs[i].start && s.end === normalSegs[i].end);
    if (sameSegs && !breakManual && effectiveLocation === (normalShift.location ?? '')) {
      return '通常シフトと同じ内容です。残業・早退・調整など、変更した点を入力してください';
    }
    // 種別の2択（開始が遅い／早く終わる）は本人が選ぶまで送信不可
    if (typeDetect.lateQ && !lateChoice) return '「開始が遅い理由は？」を選択してください';
    if (typeDetect.earlyQ && !earlyChoice) return '「早く終わる理由は？」を選択してください';
    return '';
  };

  const handleSubmit = async () => {
    setError('');
    const v = validate();
    if (v) { setError(v); return; }
    setShowConfirm(true);
  };

  const doSubmit = async () => {
    setSaving(true);
    try {
      const phase: 'planned' | 'actual' = (mode === 'posthoc' || isReportPhase || (isResubmit && editTarget?.is_post_hoc) || (isResubmit && (editTarget?.segments ?? []).some(s => s.phase === 'actual')))
        ? 'actual' : 'planned';

      // 二重計上防止：休暇申請の時間外調整休（自動計上）が同日に既にある場合はブロック
      if (fullDayMode && fullDayType === 'chosei_off' && !editTarget) {
        const { data: dup } = await supabase.from('overtime_reports')
          .select('id').eq('applicant_id', user.id).eq('work_date', date).eq('entry_type', 'leave_auto').limit(1);
        if ((dup ?? []).length > 0) {
          setError('この日は休暇申請の時間外調整休がすでに計上されています');
          setSaving(false); setShowConfirm(false); return;
        }
      }

      const record = {
        work_date: date,
        pay_period_start: calcPayPeriodStartJst(date),
        is_post_hoc: mode === 'posthoc',
        // 終日は実績報告の概念がないため、自己受理=確定・他者宛=申請（受理でconfirmed直行）
        status: (fullDayMode
          ? (isSelfReview ? 'confirmed' : 'requested')
          : (phase === 'actual'
            ? (isSelfReview ? 'confirmed' : 'reported')
            : (isSelfReview ? 'request_confirmed' : 'requested'))) as OvertimeStatus,
        normal_shift: normalShift,
        break_minutes: fullDayMode ? 0 : breakMin,
        break_manual: fullDayMode ? false : breakManual,
        labor_minutes: fullDayMode ? 0 : laborMin,
        diff_minutes: fullDayMode ? fdDiffMin : diffMin,
        legal_warning: fullDayMode ? false : !legal.ok,
        reason: reason.trim(),
        location: fullDayMode ? fdLocation : effectiveLocation,
        application_types: applicationTypes,
        // 振替休日のみ振替元を保存（他種別ではnullで上書き＝再提出で種別が変わった場合の掃除）
        furikae_origin_date: (fullDayMode && fullDayType === 'furikae_off') ? furikaeOriginDate : null,
        furikae_origin_location: (fullDayMode && fullDayType === 'furikae_off') ? furikaeOriginLocation : null,
        reviewer_id: isSelfReview ? user.id : reviewerId,
        ...(isSelfReview ? { confirmed_by: user.id, confirmed_at: new Date().toISOString() } : {}),
        ...(isResubmit ? { return_comment: null } : {}),
      };

      let reportId: string;
      if (editTarget) {
        // 修正履歴を残してから更新
        await supabase.from('overtime_report_history').insert({
          report_id: editTarget.id,
          changed_by: user.id,
          change_summary: isReportPhase ? '実績報告' : '再提出',
          snapshot: editTarget as unknown as Record<string, unknown>,
        }).then(null, () => {});
        const { error: err } = await supabase.from('overtime_reports').update(record).eq('id', editTarget.id);
        if (err) { setError('保存に失敗しました: ' + err.message); setSaving(false); setShowConfirm(false); return; }
        reportId = editTarget.id;
        // 対象phaseの時間帯を入れ替え
        await supabase.from('overtime_report_segments').delete().eq('report_id', reportId).eq('phase', phase);
      } else {
        const { data: inserted, error: err } = await supabase.from('overtime_reports')
          .insert({ applicant_id: user.id, submitted_by: user.id, entry_type: 'manual', ...record })
          .select('id').single();
        if (err) {
          setError(err.code === '23505' ? '同じ日付の申請がすでにあります（取消済みを除く）' : '保存に失敗しました: ' + err.message);
          setSaving(false); setShowConfirm(false); return;
        }
        reportId = inserted.id;
      }

      // 終日（調整休・欠勤）は時間帯を持たない
      const segRows = fullDayMode ? [] : workSegments.map((s, i) => ({
        report_id: reportId, phase, seg_no: i + 1, start_min: s.startMin, end_min: s.endMin,
      }));
      if (segRows.length > 0) {
        const { error: segErr } = await supabase.from('overtime_report_segments').insert(segRows);
        if (segErr) { setError('時間帯の保存に失敗しました: ' + segErr.message); setSaving(false); setShowConfirm(false); return; }
      }

      // 通知
      if (!isSelfReview && reviewerId) {
        const phaseLabel = phase === 'actual' ? '実績報告' : '事前申請';
        supabase.from('notifications').insert({
          user_id: reviewerId,
          message: `${profileName ?? ''}さんから残業・時間調整の${phaseLabel}が届きました`,
          sub_message: `${date}（${dowLabel(date)}）　${formatSignedMin(diffMin)}`,
          source_type: 'overtime_request:pending_approval',
          reference_id: reportId,
          event_key: 'overtime:new_request',
          read: false,
        }).then(null, () => {});
      }

      // カレンダー同期：自己受理（送信＝受理）と、既存申請の実績報告・再提出はイベントに影響するため同期する。
      // gcal-sync の action:'sync' は現在状態から再計算する冪等処理（未受理なら何もしない）。
      let gcalWarn: string | undefined;
      if (isSelfReview || editTarget) {
        const { data: syncRes, error: syncErr } = await supabase.functions.invoke('gcal-sync', {
          body: { action: 'sync', source_type: 'overtime', source_id: reportId },
        });
        const sr = syncRes as { success?: boolean; error?: string } | null;
        if (syncErr || sr?.success === false) {
          gcalWarn = '送信は完了しましたが、Googleカレンダーへの反映に失敗しました。時間をおいて再同期してください。';
        }
      }

      if (!editTarget) clearDraft(DRAFT_KEYS.overtime);
      setSaving(false);
      onSaved(gcalWarn);
    } catch {
      setSaving(false);
      setShowConfirm(false);
      setError('送信中にエラーが発生しました。もう一度お試しください。');
    }
  };

  // ---- styles ----
  const text = isDark ? '#f8f9fa' : '#212529';
  const subText = isDark ? '#adb5bd' : '#6c757d';
  const cardBg = isDark ? '#343a40' : '#fff';
  const innerBg = isDark ? '#2b3035' : '#f8f9fa';
  const borderColor = isDark ? '#495057' : '#dee2e6';
  const inputStyle: React.CSSProperties = {
    padding: '9px 12px', borderRadius: 8, border: `1px solid ${borderColor}`,
    background: isDark ? '#495057' : '#fff', color: text, fontSize: 14,
    boxSizing: 'border-box', colorScheme: isDark ? 'dark' : 'light',
  };
  // 勤務変更ページと同じ全幅フィールド
  const fieldStyle: React.CSSProperties = { ...inputStyle, width: '100%' };
  const labelStyle: React.CSSProperties = { fontSize: 13, fontWeight: 'bold', color: text, marginBottom: 6, display: 'block' };
  const req = <span style={{ color: '#dc3545' }}> *</span>;

  const normalBand2 = normalShift.start_time2 ? `　＋　${fmtTime(normalShift.start_time2)}〜${fmtTime(normalShift.end_time2)}` : '';
  const normalLoc = normalShift.location ? `　［${normalShift.location}］` : '';
  const normalLabel = normalShift.start_time
    ? `${fmtTime(normalShift.start_time)}〜${fmtTime(normalShift.end_time)}${normalBand2}${normalLoc}（休憩${formatMin(normalShift.break_minutes)}・労働${formatMin(normalShift.labor_minutes)}）`
    : '休み';

  // 入力内容をすべてクリア（新規フォームのみ）
  const handleClear = () => {
    setDate(''); setSegments([{ ...EMPTY_SEG }]); setBreakManual(false); setBreakManualMin('');
    setReason(''); setLocation(''); setLocationCustom(''); setLocMoveStart(''); setLocMoveEnd('');
    setReviewerId(''); setNormOverride(false); setNormStart(''); setNormEnd('');
    setFullDay(false); setFullDayType(null); setFullDayError('');
    setFurikaeOriginDate(''); setFurikaeOriginLocation('');
    setError(''); setShowConfirm(false);
    clearDraft(DRAFT_KEYS.overtime);
  };

  return (
    <div style={{ background: cardBg, borderRadius: 12, border: `1px solid ${borderColor}`, padding: '16px 16px 20px', marginBottom: 16 }}>
      {editTarget && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <span style={{ fontSize: 15, fontWeight: 'bold', color: text }}>
            {isReportPhase ? '📝 実績を報告する' : '再提出'}（{editTarget.work_date}）
          </span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: subText }}>✕</button>
        </div>
      )}

      {/* 注意事項（出張報告と同配色・新規のみ） */}
      {!editTarget && (
        <div style={{
          background: isDark ? '#2c3e50' : '#e8f4fd',
          border: `1px solid ${isDark ? '#3d5a73' : '#bee5eb'}`,
          borderRadius: 8, padding: '12px 14px', marginBottom: 16, textAlign: 'left',
        }}>
          <p style={{ fontSize: 13, fontWeight: 'bold', color: isDark ? '#fff' : '#1a4a5a', marginBottom: 8, marginTop: 0 }}>【注意事項】</p>
          <ol style={{ margin: 0, paddingLeft: 20, fontSize: 12, color: isDark ? '#d0dde8' : '#2c5f6e', lineHeight: 1.8 }}>
            <li>残業・時間調整の申請と報告は、このページで行ってください（タイムカードの打刻＋このページの申請の2つセット。Slackへの個人の残業申請入力は不要です）。</li>
            <li>突発的な残業（急なお客様対応など）を除き、残業は事前に申請してください。申請がない場合は通常のシフト時間での勤務となります。</li>
            <li>事前申請が受理されると、「履歴・通算」タブのその日のカードに「実績を報告する」ボタンが表示されます。業務のあと、変更がなければそのまま送信（内容は入力済みです）、時間が変わった場合は直してから送信してください。</li>
            <li>休憩は自動計算されます。突発的な残業などで自動計算どおりに取れなかった場合は、休憩の「修正」から実際の時間に直してください（休憩後は1分以上業務をしてから退勤してください）。</li>
            <li>時間は1分単位で入力できます。外出・戻りのあるシフトは「＋時間帯を追加」で入力してください。</li>
            <li>正社員の方は、残業分を別日で調整（時間調整・調整休）していただくようお願いします。</li>
            <li>調整休・欠勤（終日）は受理された時点で完了します（実績報告は不要です）。</li>
          </ol>

          <button type="button" onClick={() => setShowRules(v => !v)}
            style={{ marginTop: 10, padding: '6px 12px', fontSize: 12, fontWeight: 'bold', background: isDark ? '#3d5a73' : '#d2e9f7', color: isDark ? '#fff' : '#1a4a5a', border: 'none', borderRadius: 6, cursor: 'pointer' }}>
            {showRules ? '▲ 休憩時間ルール・タイムカードの押し方を閉じる' : '▼ 休憩時間ルール・タイムカードの押し方を表示'}
          </button>

          {showRules && (
            <div style={{ marginTop: 10, padding: '12px 14px', borderRadius: 8, background: cardBg, border: `1px solid ${isDark ? '#3d5a73' : '#bee5eb'}`, fontSize: 12, lineHeight: 1.8, color: isDark ? '#d0dde8' : '#2c5f6e' }}>
              <p style={{ margin: '0 0 4px', fontWeight: 'bold' }}>《休憩時間ルール（自動計算の基準）》</p>
              <ul style={{ margin: '0 0 10px', paddingLeft: 18 }}>
                <li>昼休憩をはさむ（12:59までに出勤する）場合の休憩の最低単位は0:30</li>
                <li>13:00以降に出勤する場合に限り、勤務時間が5:45を超え6:15までは0:15</li>
                <li>勤務時間が6:15を超え6:30までは0:30</li>
                <li>勤務時間が6:30を超え8:45までは0:45</li>
                <li>勤務時間が8:45を超える場合は1:00</li>
              </ul>
              <p style={{ margin: '0 0 4px', fontWeight: 'bold' }}>《タイムカードの押し方》</p>
              <ul style={{ margin: '0 0 10px', paddingLeft: 18 }}>
                <li>出勤時間の変更：「出勤」＋「早出」→「退勤」＋「残業」</li>
                <li>退勤時間の変更：「退勤」＋「残業」</li>
                <li>※1日トータルの時間がいつもの勤務とズレる場合は、退勤時に必ず「残業」ボタンを押してください</li>
              </ul>
              <p style={{ margin: '0 0 4px', fontWeight: 'bold' }}>《着替え時間》</p>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                <li>出勤時：着替え前に打刻し、2分30秒以内に着替えを完了して業務を開始してください</li>
                <li>退勤時：2分30秒以内に着替えを完了し、速やかに打刻してください</li>
              </ul>
            </div>
          )}
        </div>
      )}

      {/* クリア（入力欄の先頭に配置） */}
      {!editTarget && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
          <button type="button" onClick={handleClear}
            style={{ background: isDark ? '#495057' : '#f1f3f5', border: `1px solid ${isDark ? '#6c757d' : '#ced4da'}`, borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 'bold', color: isDark ? '#e9ecef' : '#495057', padding: '5px 14px' }}>
            🗑 クリア
          </button>
        </div>
      )}

      {/* 種別 */}
      {!editTarget && (
        <div style={{ marginBottom: 14 }}>
          <span style={labelStyle}>種別</span>
          <div style={{ display: 'flex', gap: 8 }}>
            {(['advance', 'posthoc'] as const).map(m => (
              <button key={m} onClick={() => setMode(m)}
                style={{
                  flex: 1, padding: '10px 0', borderRadius: 10, cursor: 'pointer', fontSize: 13.5,
                  fontWeight: mode === m ? 'bold' : 'normal',
                  border: mode === m ? '2px solid #28a745' : `1px solid ${borderColor}`,
                  background: mode === m ? (isDark ? '#1b3a1e' : '#eaf6ec') : 'transparent',
                  color: mode === m ? (isDark ? '#8fd19e' : '#2e7d32') : subText,
                }}>
                {m === 'advance' ? '事前申請' : '事後報告'}
              </button>
            ))}
          </div>
          {mode === 'posthoc' && (
            <p style={{ fontSize: 12, color: subText, margin: '6px 0 0' }}>事前申請ができなかった場合の報告です。そのまま確認フローに乗ります。</p>
          )}
        </div>
      )}

      {/* 日付 */}
      <div style={{ marginBottom: 12 }}>
        <span style={labelStyle}>日付{req}
          {!editTarget && <span style={{ fontSize: 11, fontWeight: 'normal', color: subText }}>（日付をタップして選択・{mode === 'advance' ? '当日以降' : '当日以前'}のみ）</span>}
        </span>
        {editTarget ? (
          // 実績報告・再提出は勤務日固定。誤操作防止のため表示のみ
          <div style={{ ...fieldStyle, background: isDark ? '#3a3f44' : '#f1f3f5', color: subText }}>
            {date}（{dowLabel(date)}）
          </div>
        ) : (
          <SingleDatePicker value={date} onChange={setDate} isDark={isDark}
            minDate={mode === 'advance' ? today : undefined}
            maxDate={mode === 'posthoc' ? today : undefined} />
        )}
      </div>

      {/* 通常シフト自動表示 */}
      {date && (
        <div style={{ background: innerBg, borderRadius: 10, padding: '10px 12px', marginBottom: 14 }}>
          <p style={{ margin: 0, fontSize: 13, color: subText }}>
            この日の通常シフト：<span style={{ fontWeight: 'bold', color: text }}>{normalLabel}</span>
          </p>
          <p style={{ margin: '4px 0 0', fontSize: 12, color: subText }}>
            {date}（{dowLabel(date)}）
            {normalShift.calendar_kind === 'closed_all' && '・会社カレンダー：全員休み'}
            {normalShift.calendar_kind === 'work_on_closed' && '・会社カレンダー：休館日だけど出勤日'}
            {!normalShift.calendar_kind && `・${DAY_KIND_LABELS[normalShift.day_kind]}曜パターン`}
          </p>
          {!normOverride ? (
            <button onClick={() => { setNormOverride(true); setNormStart(fmtTime(normalShift.start_time) === '-' ? '' : fmtTime(normalShift.start_time)); setNormEnd(fmtTime(normalShift.end_time) === '-' ? '' : fmtTime(normalShift.end_time)); }}
              style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, marginTop: 6, fontSize: 12, color: '#0d6efd', textDecoration: 'underline' }}>
              この日のシフトが違う場合は修正
            </button>
          ) : (
            <div style={{ marginTop: 8 }}>
              <span style={{ fontSize: 12, color: subText }}>通常シフトを修正：</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
                <input type="time" value={normStart} onChange={e => setNormStart(e.target.value)} style={{ ...inputStyle, padding: '6px 8px' }} />
                <span style={{ color: subText }}>〜</span>
                <input type="time" value={normEnd} onChange={e => setNormEnd(e.target.value)} style={{ ...inputStyle, padding: '6px 8px' }} />
                <button onClick={() => setNormOverride(false)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, color: '#0d6efd', textDecoration: 'underline' }}>
                  パターンに戻す
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* 終日（調整休・欠勤）トグル。日付選択後に意味を持つためシフト表示カードの直後に配置 */}
      {date && (!editTarget || fullDay) && (
        <div style={{ marginBottom: 12 }}>
          {!editTarget && (
            <button type="button"
              onClick={() => {
                if (!normalShift.start_time) { setFullDayError('この日はシフトが休みです。出勤予定日のみ登録できます'); return; }
                setFullDayError('');
                setFullDay(v => !v);
              }}
              style={{
                width: '100%', padding: '10px 0', borderRadius: 10, cursor: 'pointer', fontSize: 13.5,
                fontWeight: fullDay ? 'bold' : 'normal',
                border: fullDay ? '2px solid #d4537e' : `1px dashed ${borderColor}`,
                background: fullDay ? (isDark ? '#4b1528' : '#fbeaf0') : 'transparent',
                color: fullDay ? (isDark ? '#f4c0d1' : '#993556') : subText,
              }}>
              {fullDay ? '✓ 調整休・欠勤（終日）で申請中 ─ 押すと時間の申請に戻ります' : '🌙 調整休・欠勤（終日）はこちら'}
            </button>
          )}
          {fullDayError && (
            <div style={{ background: isDark ? '#4a1515' : '#f8d7da', border: '1px solid #dc3545', borderRadius: 8, padding: '8px 12px', marginTop: 6 }}>
              <p style={{ margin: 0, fontSize: 13, color: isDark ? '#f5b5ba' : '#842029' }}>{fullDayError}</p>
            </div>
          )}

          {/* 種別3択（説明付き・休暇側と同一文言） */}
          {fullDay && (
            <div style={{ marginTop: 10 }}>
              <span style={labelStyle}>種別{req}</span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {([
                  ['chosei_off', '時間外調整休', '勤務調整のため取得'],
                  ['furikae_off', '振替休日', '休日出勤・特定日の振替'],
                  ['absence', '欠勤', '出勤予定日に休んだ場合'],
                ] as const).map(([v, label, desc]) => (
                  <button key={v} type="button"
                    onClick={() => {
                      setFullDayType(v);
                      if (v === 'absence' && reviewerId === SELF_REVIEW_VALUE) setReviewerId('');
                    }}
                    style={{
                      padding: '10px 12px', borderRadius: 10, cursor: 'pointer', textAlign: 'left',
                      border: fullDayType === v ? '2px solid #28a745' : `1px solid ${borderColor}`,
                      background: fullDayType === v ? (isDark ? '#1b3a1e' : '#eaf6ec') : 'transparent',
                    }}>
                    <span style={{ display: 'block', fontSize: 13.5, fontWeight: fullDayType === v ? 'bold' : 'normal', color: fullDayType === v ? (isDark ? '#8fd19e' : '#2e7d32') : text }}>{label}</span>
                    <span style={{ display: 'block', fontSize: 11.5, color: subText, marginTop: 2 }}>{desc}</span>
                  </button>
                ))}
              </div>

              {/* この申請が合計時間数にどう効くか（本人が一番不安な点を1行で明示） */}
              {fullDayType && (
                <div style={{ background: isDark ? '#1b3a1e' : '#d1e7dd', border: '1px solid #28a745', borderRadius: 8, padding: '8px 12px', marginTop: 8 }}>
                  <p style={{ margin: 0, fontSize: 12.5, color: isDark ? '#8fd19e' : '#0f5132' }}>
                    {fullDayType === 'chosei_off' && `シフト労働分 ${formatSignedMin(-normalShift.labor_minutes)} を合計時間数から差し引きます`}
                    {fullDayType === 'furikae_off' && '休日出勤の振替として記録します'}
                    {fullDayType === 'absence' && '欠勤1日として記録します'}
                  </p>
                </div>
              )}

              {/* 振替休日：振替元（実際に出勤した日）＋その日の勤務校（シフトから自動・修正可） */}
              {fullDayType === 'furikae_off' && (
                <div style={{ marginTop: 10 }}>
                  <span style={{ ...labelStyle, marginBottom: 4 }}>振替元の勤務日{req}
                    <span style={{ fontSize: 11, fontWeight: 'normal', color: subText }}>（実際に出勤した日をタップ）</span>
                  </span>
                  <SingleDatePicker value={furikaeOriginDate} onChange={setFurikaeOriginDate} isDark={isDark} />
                  <div style={{ marginTop: 8 }}>
                    <span style={{ ...labelStyle, marginBottom: 4 }}>振替元の勤務校{req}
                      <span style={{ fontSize: 11, fontWeight: 'normal', color: subText }}>（シフトから自動・違えば修正）</span>
                    </span>
                    <select value={furikaeOriginLocation} onChange={e => setFurikaeOriginLocation(e.target.value)} style={fieldStyle}>
                      <option value="">選択してください</option>
                      {workplaces.map(w => <option key={w} value={w}>{w}</option>)}
                      {furikaeOriginLocation && !workplaces.includes(furikaeOriginLocation) && (
                        <option value={furikaeOriginLocation}>{furikaeOriginLocation}</option>
                      )}
                    </select>
                  </div>
                </div>
              )}

              {/* 勤務地はシフトから自動（校が取れない日だけ下の勤務地欄で選択） */}
              {normalShift.location && (
                <p style={{ margin: '8px 0 0', fontSize: 12, color: subText }}>勤務地：{normalShift.location}（シフトから自動）</p>
              )}
            </div>
          )}
        </div>
      )}

      {/* 実務の勤務時間帯 */}
      {!fullDay && (
      <div style={{ marginBottom: 12 }}>
        <span style={labelStyle}>{mode === 'advance' && !isReportPhase && !(editTarget && isResubmit && (editTarget.segments ?? []).some(s => s.phase === 'actual')) ? '予定の勤務時間' : '実務の勤務時間'}{req}</span>
        {segments.map((s, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <span style={{ fontSize: 12, color: subText, minWidth: 44 }}>時間帯{i + 1}</span>
            <input type="time" value={s.start} onChange={e => setSegments(prev => prev.map((p, j) => j === i ? { ...p, start: e.target.value } : p))} style={{ ...inputStyle, flex: 1, minWidth: 0 }} />
            <span style={{ color: subText }}>〜</span>
            <input type="time" value={s.end} onChange={e => setSegments(prev => prev.map((p, j) => j === i ? { ...p, end: e.target.value } : p))} style={{ ...inputStyle, flex: 1, minWidth: 0 }} />
            {segments.length > 1 && (
              <button onClick={() => setSegments(prev => prev.filter((_, j) => j !== i))}
                aria-label={`時間帯${i + 1}を削除`}
                style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, color: subText }}>🗑</button>
            )}
          </div>
        ))}
        {segments.length < 3 && (
          <button onClick={() => setSegments(prev => [...prev, { ...EMPTY_SEG }])}
            style={{ background: isDark ? '#2c3e50' : '#e8f4fd', border: `1px solid ${isDark ? '#4a90d9' : '#90caf9'}`, borderRadius: 8, cursor: 'pointer', padding: '6px 12px', fontSize: 12.5, color: isDark ? '#fff' : '#1565c0', width: '100%' }}>
            ＋ 時間帯を追加（外出・戻りがある場合）
          </button>
        )}
        <p style={{ fontSize: 11.5, color: subText, margin: '6px 0 0' }}>終了が深夜0時を越える場合は、終了時刻をそのまま入力してください（翌日として計算します）</p>
      </div>
      )}

      {/* 休憩・労働時間・差分 */}
      {!fullDay && hasInput && (
        <div style={{ background: innerBg, borderRadius: 10, padding: '10px 12px', marginBottom: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13, marginBottom: 4 }}>
            <span style={{ color: subText }}>休憩{breakManual ? '（手修正）' : '（自動計算）'}</span>
            <span style={{ color: text }}>
              {breakManual ? (
                <>
                  <input type="number" inputMode="numeric" min={0} step={1} value={breakManualMin}
                    onChange={e => setBreakManualMin(e.target.value)}
                    style={{ ...inputStyle, width: 70, padding: '4px 8px', textAlign: 'right' }} />
                  <span style={{ marginLeft: 4 }}>分</span>
                  <button onClick={() => { setBreakManual(false); setBreakManualMin(''); setBreakRecalcNote(false); }}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, color: '#0d6efd', textDecoration: 'underline', marginLeft: 8 }}>
                    自動計算に戻す（{formatMin(autoBreak)}）
                  </button>
                </>
              ) : (
                <>
                  {formatMin(autoBreak)}
                  <button onClick={() => { setBreakManual(true); setBreakManualMin(String(autoBreak)); }}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, color: '#0d6efd', textDecoration: 'underline', marginLeft: 8 }}>
                    修正
                  </button>
                </>
              )}
            </span>
          </div>
          {breakRecalcNote && (
            <p style={{ fontSize: 11.5, color: '#e65100', margin: '0 0 4px' }}>時間帯を変更しました。休憩は手修正の値のままです（自動計算に戻す場合は上のリンク）</p>
          )}
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 4 }}>
            <span style={{ color: subText }}>労働時間</span>
            <span style={{ fontWeight: 'bold', color: text }}>{formatMin(laborMin)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, borderTop: `1px solid ${borderColor}`, paddingTop: 6 }}>
            <span style={{ fontWeight: 'bold', color: text }}>シフトとの差分</span>
            <span style={{ fontWeight: 'bold', color: diffColor(diffMin, isDark) }}>
              {formatSignedMin(diffMin)}
              {diffMin > 0 ? '（残業）' : diffMin < 0 ? '（早退・調整）' : ''}
            </span>
          </div>
          {applicationTypes.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', borderTop: `1px solid ${borderColor}`, marginTop: 6, paddingTop: 8 }}>
              <span style={{ fontSize: 12.5, color: subText }}>種別：</span>
              <TypeChips types={applicationTypes} isDark={isDark} />
            </div>
          )}
        </div>
      )}

      {/* 種別の2択バナー（調整か遅刻/早退かだけ本人に確認） */}
      {!fullDay && hasInput && typeDetect.lateQ && (
        <div style={{ marginBottom: 12 }}>
          <span style={{ fontSize: 13, color: subText, display: 'block', marginBottom: 6 }}>開始が遅い理由は？</span>
          <div style={{ display: 'flex', gap: 8 }}>
            {([['adj', '事前の調整 → 調整遅出'], ['tardiness', '遅刻 → 遅刻']] as const).map(([v, label]) => (
              <button key={v} type="button" onClick={() => setLateChoice(v)}
                style={{
                  flex: 1, padding: '11px 4px', borderRadius: 10, cursor: 'pointer', fontSize: 13,
                  fontWeight: lateChoice === v ? 'bold' : 'normal',
                  border: lateChoice === v ? '2px solid #28a745' : `1px solid ${borderColor}`,
                  background: lateChoice === v ? (isDark ? '#1b3a1e' : '#eaf6ec') : 'transparent',
                  color: lateChoice === v ? (isDark ? '#8fd19e' : '#2e7d32') : subText,
                }}>
                {label}
              </button>
            ))}
          </div>
        </div>
      )}
      {!fullDay && hasInput && typeDetect.earlyQ && (
        <div style={{ marginBottom: 12 }}>
          <span style={{ fontSize: 13, color: subText, display: 'block', marginBottom: 6 }}>早く終わる理由は？</span>
          <div style={{ display: 'flex', gap: 8 }}>
            {([['adj', '事前の調整 → 調整早退'], ['early_leave', '当日の事情 → 早退']] as const).map(([v, label]) => (
              <button key={v} type="button" onClick={() => setEarlyChoice(v)}
                style={{
                  flex: 1, padding: '11px 4px', borderRadius: 10, cursor: 'pointer', fontSize: 13,
                  fontWeight: earlyChoice === v ? 'bold' : 'normal',
                  border: earlyChoice === v ? '2px solid #28a745' : `1px solid ${borderColor}`,
                  background: earlyChoice === v ? (isDark ? '#1b3a1e' : '#eaf6ec') : 'transparent',
                  color: earlyChoice === v ? (isDark ? '#8fd19e' : '#2e7d32') : subText,
                }}>
                {label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 法定チェック警告（本人側にも表示） */}
      {!fullDay && hasInput && !legal.ok && (
        <div style={{ background: isDark ? '#4a3a10' : '#fff8e1', border: '1px solid #f59e0b', borderRadius: 10, padding: '10px 12px', marginBottom: 12 }}>
          <p style={{ margin: 0, fontSize: 12.5, color: isDark ? '#ffd54f' : '#856404', lineHeight: 1.7 }}>
            ⚠️ この日は労働{laborMin > 480 ? '8時間' : '6時間'}超のため、法律上{legal.requiredMinutes}分以上の休憩が必要です
            （現在の休憩＋外出の合計：{legal.actualRestMinutes}分）。休憩時間を確認してください。このまま提出することもできます。
          </p>
        </div>
      )}

      {/* 勤務地（勤務変更報告と同様に自由入力あり）。終日でシフトに校がある日は自動使用のため非表示 */}
      {!(fullDay && normalShift.location) && (
      <div style={{ marginBottom: 12 }}>
        <span style={labelStyle}>勤務地{req}</span>
        <select value={location} onChange={e => setLocation(e.target.value)} style={fieldStyle}>
          <option value="">選択してください</option>
          {workplaces.map(w => <option key={w} value={w}>{w}</option>)}
          <option value="移動あり">移動あり（校が変わる）</option>
          <option value="その他">その他（自由入力）</option>
        </select>
        {location === 'その他' && (
          <input type="text" value={locationCustom} onChange={e => setLocationCustom(e.target.value)}
            placeholder="勤務地を入力してください"
            style={{ ...fieldStyle, marginTop: 6 }} />
        )}
        {location === '移動あり' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
            <select value={locMoveStart} onChange={e => setLocMoveStart(e.target.value)} style={{ ...fieldStyle, flex: 1 }}>
              <option value="">移動元の校</option>
              {workplaces.map(w => <option key={w} value={w}>{w}</option>)}
            </select>
            <span style={{ color: subText, fontWeight: 'bold' }}>→</span>
            <select value={locMoveEnd} onChange={e => setLocMoveEnd(e.target.value)} style={{ ...fieldStyle, flex: 1 }}>
              <option value="">移動先の校</option>
              {workplaces.map(w => <option key={w} value={w}>{w}</option>)}
            </select>
          </div>
        )}
      </div>
      )}

      {/* 理由 */}
      <div style={{ marginBottom: 12 }}>
        <span style={labelStyle}>理由{req}</span>
        <textarea value={reason} onChange={e => setReason(e.target.value)} rows={2}
          placeholder="例：お客様対応のため"
          style={{ ...fieldStyle, resize: 'vertical' }} />
        {/* 文例ボタン（2つ） */}
        <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
          {(fullDay ? ['勤務時間調整のため', '体調不良のため'] : ['お客様対応のため', '〇〇準備のため']).map(ex => (
            <button key={ex} type="button" onClick={() => setReason(ex)}
              style={{ padding: '5px 12px', borderRadius: 6, border: `1px solid ${isDark ? '#3d5166' : '#90caf9'}`, background: isDark ? '#2c3e50' : '#e8f4fd', color: isDark ? '#fff' : '#1565c0', fontSize: 11.5, fontWeight: 'bold', cursor: 'pointer' }}>
              文例 ー「{ex}」
            </button>
          ))}
        </div>
        {/* 理由履歴（過去に自分が入力した理由・押すと入力） */}
        {pastReasons.length > 0 && (
          <div style={{ background: isDark ? '#243447' : '#e8f4fd', border: `1px solid ${isDark ? '#3d5166' : '#90caf9'}`, borderRadius: 8, padding: '8px 10px', marginTop: 8 }}>
            <div style={{ fontSize: 11.5, fontWeight: 'bold', color: isDark ? '#fff' : '#1565c0', marginBottom: 6 }}>📋 過去に入力した理由</div>
            {(showAllReasons ? pastReasons : pastReasons.slice(0, 3)).map((rz, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px', background: isDark ? '#2c3e50' : '#fff', border: `1px solid ${isDark ? '#3d5166' : '#bbdefb'}`, borderRadius: 5, marginBottom: 5 }}>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12, color: isDark ? '#fff' : '#333' }}>{rz}</span>
                <button type="button" onClick={() => setReason(rz)}
                  style={{ flexShrink: 0, background: '#1976d2', color: '#fff', fontSize: 11, fontWeight: 'bold', padding: '4px 12px', border: 'none', borderRadius: 4, cursor: 'pointer' }}>入力</button>
              </div>
            ))}
            {pastReasons.length > 3 && (
              <button type="button" onClick={() => setShowAllReasons(v => !v)}
                style={{ width: '100%', padding: '4px', background: 'none', border: `1px dashed ${isDark ? '#5a6b7d' : '#90caf9'}`, borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 'bold', color: isDark ? '#e9ecef' : '#1565c0', marginTop: 2 }}>
                {showAllReasons ? '▲ 閉じる' : `▼ もっと見る（あと${pastReasons.length - 3}件）`}
              </button>
            )}
          </div>
        )}
      </div>

      {/* 申請先 */}
      <div style={{ marginBottom: 16 }}>
        <span style={labelStyle}>申請先{req}</span>
        <select value={reviewerId} onChange={e => setReviewerId(e.target.value)} style={fieldStyle}>
          <option value="">選択してください</option>
          {reviewers
            .filter(r => r.id !== user.id)
            .filter(r => !(fullDay && fullDayType === 'absence') || ABSENCE_REVIEWER_ROLES.includes(r.role_title))
            .map(r => (
              <option key={r.id} value={r.id}>{r.name}（{r.role_title}）</option>
            ))}
          {canSelfReview && !(fullDay && fullDayType === 'absence') && <option value={SELF_REVIEW_VALUE}>自己受理（自分で確認する）</option>}
        </select>
        {fullDay && fullDayType === 'absence' && (
          <p style={{ margin: '6px 0 0', fontSize: 12, color: subText }}>欠勤はマネージャー以上の受理が必要です（自己受理はできません）</p>
        )}
      </div>

      {error && (
        <div style={{ background: isDark ? '#4a1515' : '#f8d7da', border: '1px solid #dc3545', borderRadius: 8, padding: '8px 12px', marginBottom: 12 }}>
          <p style={{ margin: 0, fontSize: 13, color: isDark ? '#f5b5ba' : '#842029' }}>{error}</p>
        </div>
      )}

      {/* 送信（インライン確認） */}
      {!showConfirm ? (
        <button onClick={handleSubmit} disabled={saving}
          style={{ width: '100%', padding: '12px 0', borderRadius: 10, border: 'none', cursor: 'pointer', fontSize: 15, fontWeight: 'bold', background: '#28a745', color: '#fff' }}>
          {isReportPhase ? '実績を報告する' : isResubmit ? '再提出する' : mode === 'advance' ? '事前申請する' : '報告する'}
        </button>
      ) : (
        <div style={{ background: innerBg, borderRadius: 10, padding: '12px 14px' }}>
          <p style={{ margin: '0 0 6px', fontSize: 13.5, fontWeight: 'bold', color: text }}>この内容で送信しますか？</p>
          {fullDayMode ? (
            <p style={{ margin: '0 0 6px', fontSize: 12.5, color: subText, lineHeight: 1.7 }}>
              {date}（{dowLabel(date)}）　終日：{fullDayType ? OT_TYPE_INFO[fullDayType].label : ''}<br />
              {fullDayType === 'furikae_off' && furikaeOriginDate && <>振替元：{furikaeOriginDate.slice(5).replace('-', '/')}（{dowLabel(furikaeOriginDate)}）{furikaeOriginLocation && `・${furikaeOriginLocation}`}<br /></>}
              {fullDayType === 'chosei_off' && <>シフト労働分 {formatSignedMin(fdDiffMin)} を合計時間数から差し引きます<br /></>}
              {fullDayType === 'furikae_off' && <>休日出勤の振替として記録します<br /></>}
              {fullDayType === 'absence' && <>欠勤1日として記録します<br /></>}
              {isSelfReview ? '自己受理のため、送信と同時に確定します' : `申請先：${reviewers.find(r => r.id === reviewerId)?.name ?? ''}さん（受理で確定します）`}
            </p>
          ) : (
          <p style={{ margin: '0 0 6px', fontSize: 12.5, color: subText, lineHeight: 1.7 }}>
            {date}（{dowLabel(date)}）　{segmentsLabel(workSegments)}<br />
            休憩{formatMin(breakMin)}・労働{formatMin(laborMin)}・差分 {formatSignedMin(diffMin)}<br />
            {isSelfReview ? '自己受理のため、送信と同時に受理されます' : `申請先：${reviewers.find(r => r.id === reviewerId)?.name ?? ''}さん`}
          </p>
          )}
          {applicationTypes.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', margin: '0 0 10px' }}>
              <span style={{ fontSize: 12.5, color: subText }}>種別：</span>
              <TypeChips types={applicationTypes} isDark={isDark} />
            </div>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={doSubmit} disabled={saving}
              style={{ flex: 1, padding: '10px 0', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: 'bold', background: '#28a745', color: '#fff', opacity: saving ? 0.6 : 1 }}>
              {saving ? '送信中…' : '送信する'}
            </button>
            <button onClick={() => setShowConfirm(false)} disabled={saving}
              style={{ flex: 1, padding: '10px 0', borderRadius: 8, border: `1px solid ${borderColor}`, cursor: 'pointer', fontSize: 14, background: 'transparent', color: subText }}>
              戻る
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

// ────────────────────────────────────────────────────────────────
// メインページ
// ────────────────────────────────────────────────────────────────
const OvertimePage: React.FC<Props> = ({ user, profileName, roleTitle, isAdmin }) => {
  const isDark = useDarkMode();
  const [searchParams, setSearchParams] = useSearchParams();
  const isConfirmView = searchParams.get('view') === 'confirm';

  const [tab, setTab] = useState<'form' | 'history'>(searchParams.get('tab') === 'history' ? 'history' : 'form');
  const [reports, setReports] = useState<OvertimeReport[]>([]);
  const [pendingForMe, setPendingForMe] = useState<OvertimeReport[]>([]);
  const [reviewers, setReviewers] = useState<Reviewer[]>([]);
  const [workplaces, setWorkplaces] = useState<string[]>([]);
  const [patterns, setPatterns] = useState<PatternRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [editTarget, setEditTarget] = useState<OvertimeReport | null>(null);
  const [savedBanner, setSavedBanner] = useState(false);
  const [cancelTargetId, setCancelTargetId] = useState<string | null>(null);
  const [historyMode, setHistoryMode] = useState<'own' | 'summary'>(searchParams.get('staff') ? 'summary' : 'own');
  const [canSummary, setCanSummary] = useState(false);

  // 集計モード用
  const [summaryPeriod, setSummaryPeriod] = useState(() => calcPayPeriodStartJst(todayJstStr()));
  const [summaryRows, setSummaryRows] = useState<SummaryRow[]>([]);
  const [myGroups, setMyGroups] = useState<string[]>([]);           // 閲覧者自身の部門（初期スコープ用）
  const [summaryDept, setSummaryDept] = useState('');               // 部門(チーム)フィルタ。''=自所属を初期選択 / '__all__'=全チーム
  const [summaryNameQuery, setSummaryNameQuery] = useState('');      // 名前検索
  const [summaryFilterOpen, setSummaryFilterOpen] = useState(false); // 「絞り込み」折りたたみ
  const [selectedStaffId, setSelectedStaffId] = useState<string | null>(searchParams.get('staff')); // 個人詳細で選択中の対象者

  // 受理画面用
  const [returnTargetId, setReturnTargetId] = useState<string | null>(null);
  const [returnComment, setReturnComment] = useState('');
  const [actingId, setActingId] = useState<string | null>(null);

  // 読み込み・操作のエラー／カレンダー同期の警告（.catch禁止ルール：握りつぶさずインライン表示）
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [gcalWarning, setGcalWarning] = useState<{ message: string; reportId: string | null } | null>(null);
  const [retrying, setRetrying] = useState(false);

  const currentPeriod = calcPayPeriodStartJst(todayJstStr());

  const text = isDark ? '#f8f9fa' : '#212529';
  const subText = isDark ? '#adb5bd' : '#6c757d';
  const cardBg = isDark ? '#343a40' : '#fff';
  const innerBg = isDark ? '#2b3035' : '#f8f9fa';
  const borderColor = isDark ? '#495057' : '#dee2e6';

  // ---- data fetch ----
  // profiles への embed は auth.users 向きの既存FKでは解決できないため、
  // 20260727 マイグレーションで追加した profiles 向き named FK を使う。
  const fetchOwn = useCallback(async () => {
    const { data, error } = await supabase.from('overtime_reports')
      .select('*, applicant:profiles!overtime_reports_applicant_profiles_fkey(name), reviewer:profiles!overtime_reports_reviewer_profiles_fkey(name), segments:overtime_report_segments(*)')
      .eq('applicant_id', user.id)
      .order('work_date', { ascending: false })
      .limit(100);
    if (error) { setLoadError('履歴の読み込みに失敗しました：' + error.message); return; }
    setLoadError('');
    setReports((data as OvertimeReport[] | null) ?? []);
  }, [user.id]);

  const fetchPendingForMe = useCallback(async () => {
    const { data, error } = await supabase.from('overtime_reports')
      .select('*, applicant:profiles!overtime_reports_applicant_profiles_fkey(name), segments:overtime_report_segments(*)')
      .eq('reviewer_id', user.id)
      .eq('entry_type', 'manual')
      .in('status', ['requested', 'reported'])
      .order('work_date', { ascending: true });
    if (error) { setLoadError('確認待ちの読み込みに失敗しました：' + error.message); return; }
    setPendingForMe((data as OvertimeReport[] | null) ?? []);
  }, [user.id]);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const [, , revRes, wpRes, patRes, permRes, myProfRes] = await Promise.all([
        fetchOwn(),
        fetchPendingForMe(),
        supabase.from('profiles').select('id, name, role_title').in('role_title', REVIEWER_ROLES).eq('is_active', true).order('role_title').order('name'),
        supabase.from('master_options').select('value').eq('category', 'workplace').order('sort_order'),
        supabase.from('weekly_shift_patterns').select('*').eq('user_id', user.id),
        supabase.rpc('has_feature_permission', { p_feature: 'overtime_summary' }),
        supabase.from('profiles').select('group_names').eq('id', user.id).maybeSingle(),
      ]);
      setReviewers((revRes.data as Reviewer[] | null) ?? []);
      setWorkplaces(((wpRes.data as { value: string }[] | null) ?? []).map(w => w.value));
      setPatterns((patRes.data as PatternRow[] | null) ?? []);
      setCanSummary(isAdmin || permRes.data === true);
      setMyGroups(((myProfRes.data as { group_names: string[] | null } | null)?.group_names) ?? []);
      setLoading(false);
    })();
  }, [fetchOwn, fetchPendingForMe, user.id, isAdmin]);

  // 集計モードのデータ取得。確定・見込みの2値を出すため全ステータスを取得（集約のみ・segmentsは詳細で遅延取得）。
  useEffect(() => {
    if (historyMode !== 'summary' || !canSummary) return;
    (async () => {
      const [repRes, setRes] = await Promise.all([
        supabase.from('overtime_reports')
          .select('applicant_id, work_date, pay_period_start, entry_type, status, diff_minutes, application_types')
          .eq('pay_period_start', summaryPeriod),
        supabase.from('overtime_settings').select('banner_group_names').eq('id', 1).maybeSingle(),
      ]);
      const whitelist: string[] = (setRes.data?.banner_group_names as string[] | null) ?? [];

      const repRows = (repRes.data as OvertimeReport[] | null) ?? [];
      const ids = [...new Set(repRows.map(r => r.applicant_id))];

      // 名簿の解決:
      //  - 全アクティブ正社員(employment_type != 'パート') → 未申請でも 0:00 で一覧に出す。
      //    追跡部門(banner_group_names)が未設定でも全員が「その他」に並ぶよう、部門所属では絞らない。
      //    部門を設定すれば group で自動的に部門分けされる。
      //  - その期に行を持つ applicant（退職者を含む）→ id で解決（is_active で絞らない＝退職者も名前が出る）
      const [rosterRes, rowProfRes] = await Promise.all([
        supabase.from('profiles').select('id, name, group_names, role_title').eq('is_active', true).neq('employment_type', 'パート'),
        ids.length > 0
          ? supabase.from('profiles').select('id, name, group_names, role_title').in('id', ids)
          : Promise.resolve({ data: [] as ProfLite[] }),
      ]);
      const rosterProfs = (rosterRes.data as ProfLite[] | null) ?? [];
      const profMap = new Map<string, ProfLite>();
      for (const p of [...rosterProfs, ...((rowProfRes.data as ProfLite[] | null) ?? [])]) profMap.set(p.id, p);

      const byUser = new Map<string, OvertimeReport[]>();
      for (const r of repRows) {
        const arr = byUser.get(r.applicant_id) ?? [];
        arr.push(r);
        byUser.set(r.applicant_id, arr);
      }
      // 名簿（追跡部門メンバー）＋ 行を持つ人 の和集合。未申請者は 0:00 で並ぶ。
      const memberIds = [...new Set([...rosterProfs.map(p => p.id), ...ids])];
      const rows: SummaryRow[] = memberIds.map(userId => {
        const p = profMap.get(userId);
        // 部門(チーム)は「部門ホワイトリスト(banner_group_names)」に一致する group のみ採用する。
        // group_names には権限・配信グループも混在するため、勝手に先頭を拾わない。未登録は「未所属」。
        const group = whitelist.find(g => (p?.group_names ?? []).includes(g)) ?? '未所属';
        const b = computeBalance(byUser.get(userId) ?? [], summaryPeriod);
        return { userId, name: p?.name ?? '不明', group, role: p?.role_title ?? '', total: b.total, plannedTotal: b.plannedTotal, absenceDays: b.absenceDays };
      });
      // チーム内は役職の序列順（上位→下位）、同役職は名前順。チーム自体は名前順のまま。
      rows.sort((a, b) => {
        if (a.group !== b.group) return a.group.localeCompare(b.group, 'ja');
        return roleRank(a.role) - roleRank(b.role) || a.name.localeCompare(b.name, 'ja');
      });
      setSummaryRows(rows);
    })();
  }, [historyMode, canSummary, summaryPeriod]);

  // 個人詳細の選択/解除。ブラウザ戻る対応のため ?staff= を URL に載せる（他のクエリは保持）。
  const selectStaff = useCallback((id: string) => {
    setSelectedStaffId(id);
    setSearchParams(prev => { const n = new URLSearchParams(prev); n.set('staff', id); return n; });
    window.scrollTo({ top: 0 });
  }, [setSearchParams]);
  const clearSelectedStaff = useCallback(() => {
    setSelectedStaffId(null);
    setSearchParams(prev => { const n = new URLSearchParams(prev); n.delete('staff'); return n; });
  }, [setSearchParams]);

  // ---- 合計時間数（今期通算） ---- 本人カード・部門集計・個人詳細で共通の computeBalance を使う
  const balance = useMemo(() => computeBalance(reports, currentPeriod), [reports, currentPeriod]);

  const prevPeriodBalance = useMemo(() => {
    const [y, m] = currentPeriod.split('-').map(Number);
    const py = m === 1 ? y - 1 : y;
    const pm = m === 1 ? 12 : m - 1;
    const prev = `${py}-${String(pm).padStart(2, '0')}-16`;
    return reports.filter(r => r.pay_period_start === prev && r.status === 'confirmed')
      .reduce((s, r) => s + (r.diff_minutes ?? 0), 0);
  }, [reports, currentPeriod]);

  // 実績未報告の受理済み事前申請（勤務日を過ぎたもの）。終日（調整休・欠勤）は実績報告の概念がないため除外
  const unreportedRequests = useMemo(() =>
    reports.filter(r => r.status === 'request_confirmed' && r.work_date < todayJstStr() && !isFullDayReport(r.application_types)),
  [reports]);

  // ---- 受理・差し戻し・取消（Edge Function overtime-approve に集約） ----
  // ステータス更新・通知・GCal同期をサーバー側で直列実行し、同期失敗を握りつぶさず表示する。
  const callApproveFunction = async (
    reportId: string, action: 'approve' | 'return' | 'cancel', comment?: string,
  ): Promise<{ ok: boolean; error?: string; gcalOk?: boolean }> => {
    const { data, error } = await supabase.functions.invoke('overtime-approve', {
      body: { report_id: reportId, action, comment },
    });
    const res = data as { success?: boolean; error?: string; gcal_ok?: boolean } | null;
    if (error || !res?.success) return { ok: false, error: res?.error ?? error?.message ?? '通信エラー' };
    return { ok: true, gcalOk: res.gcal_ok !== false };
  };

  // GCal同期の再試行（警告カードのボタンから）
  const retryGcalSync = async () => {
    if (!gcalWarning?.reportId) { setGcalWarning(null); return; }
    setRetrying(true);
    const { data, error } = await supabase.functions.invoke('gcal-sync', {
      body: { action: 'sync', source_type: 'overtime', source_id: gcalWarning.reportId },
    });
    const res = data as { success?: boolean } | null;
    if (!error && res?.success !== false) setGcalWarning(null);
    setRetrying(false);
  };

  // ---- 取消（本人） ----
  const doCancel = async (r: OvertimeReport) => {
    setActingId(r.id);
    setActionError('');
    const res = await callApproveFunction(r.id, 'cancel');
    if (!res.ok) {
      setActionError('取消に失敗しました：' + (res.error ?? ''));
    } else if (res.gcalOk === false) {
      setGcalWarning({ message: '取消は完了しましたが、Googleカレンダーからの削除に失敗しました。', reportId: r.id });
    }
    setCancelTargetId(null);
    setActingId(null);
    fetchOwn();
  };

  // ---- 受理（確認者）。旧 attendance_exceptions 連携は gcal-sync(action:'sync') に置き換え済み ----
  const doApprove = async (r: OvertimeReport) => {
    setActingId(r.id);
    setActionError('');
    const res = await callApproveFunction(r.id, 'approve');
    if (!res.ok) {
      setActionError('受理に失敗しました：' + (res.error ?? ''));
    } else if (res.gcalOk === false) {
      setGcalWarning({ message: '受理は完了しましたが、Googleカレンダーへの反映に失敗しました。', reportId: r.id });
    }
    setActingId(null);
    fetchPendingForMe();
    fetchOwn();
  };

  const doReturn = async (r: OvertimeReport) => {
    if (!returnComment.trim()) return;
    setActingId(r.id);
    setActionError('');
    const res = await callApproveFunction(r.id, 'return', returnComment.trim());
    if (!res.ok) {
      setActionError('差し戻しに失敗しました：' + (res.error ?? ''));
    } else if (res.gcalOk === false) {
      setGcalWarning({ message: '差し戻しは完了しましたが、Googleカレンダーからの削除に失敗しました。', reportId: r.id });
    }
    setReturnTargetId(null);
    setReturnComment('');
    setActingId(null);
    fetchPendingForMe();
  };

  // 履歴・修正依頼系の派生値とフックは、?view=confirm の早期returnより前に置くこと。
  // 早期returnの後ろに Hook があると、通常ビュー⇄確認ビューの切替で Hook 数が変わり React がクラッシュ
  // （確認ページが真っ白になる）。Rules of Hooks 順守のため必ずここで宣言する。
  const ownHistory = reports.filter(r => r.entry_type === 'manual' || r.entry_type === 'leave_auto');
  // 受理済みの残業に紐づく最新の修正依頼（修正依頼中/対応済みバッジ用）
  const [corrections, setCorrections] = useState<Map<string, CorrectionRequestRow>>(new Map());
  const reloadCorrections = useCallback(() => {
    const ids = ownHistory.filter(r => r.status === 'confirmed' && r.entry_type === 'manual').map(r => r.id);
    if (ids.length === 0) { setCorrections(new Map()); return; }
    fetchLatestCorrectionByTarget('overtime', ids).then(setCorrections);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reports]);
  useEffect(() => { reloadCorrections(); }, [reloadCorrections]);

  // ────────────────────────────────────────────
  // 確認者ビュー（?view=confirm）
  // ────────────────────────────────────────────
  if (isConfirmView) {
    return (
      <div style={{ maxWidth: 600, margin: '0 auto', padding: '16px 16px 40px' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
            <button onClick={() => { setSearchParams({}); window.scrollTo({ top: 0 }); }}
              style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: text }}>←</button>
            <h2 style={{ margin: 0, fontSize: 17, color: text }}>✅ 残業・時間調整の確認</h2>
            {pendingForMe.length > 0 && (
              <span style={badgeStyle('#c62828', '#4a1515', isDark)}>{pendingForMe.length}件</span>
            )}
          </div>

          {loadError && (
            <div style={{ background: isDark ? '#4a1515' : '#f8d7da', border: '1px solid #dc3545', borderRadius: 10, padding: '10px 12px', marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
              <p style={{ margin: 0, fontSize: 13, color: isDark ? '#f5b5ba' : '#842029' }}>{loadError}</p>
              <button onClick={() => { fetchOwn(); fetchPendingForMe(); }}
                style={{ flexShrink: 0, padding: '6px 12px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 'bold', background: '#dc3545', color: '#fff' }}>再読み込み</button>
            </div>
          )}
          {actionError && (
            <div style={{ background: isDark ? '#4a1515' : '#f8d7da', border: '1px solid #dc3545', borderRadius: 10, padding: '10px 12px', marginBottom: 12 }}>
              <p style={{ margin: 0, fontSize: 13, color: isDark ? '#f5b5ba' : '#842029' }}>{actionError}</p>
            </div>
          )}
          {gcalWarning && (
            <div style={{ background: isDark ? '#4a3a10' : '#fff8e1', border: '1px solid #f59e0b', borderRadius: 10, padding: '10px 12px', marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
              <p style={{ margin: 0, fontSize: 12.5, color: isDark ? '#ffd54f' : '#856404' }}>⚠️ {gcalWarning.message}</p>
              {gcalWarning.reportId && (
                <button onClick={retryGcalSync} disabled={retrying}
                  style={{ flexShrink: 0, padding: '6px 12px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 'bold', background: '#f59e0b', color: '#fff', opacity: retrying ? 0.6 : 1 }}>
                  {retrying ? '再同期中…' : 'カレンダー再同期'}
                </button>
              )}
              <button onClick={() => setGcalWarning(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, color: subText }}>✕</button>
            </div>
          )}

          {pendingForMe.length === 0 && (
            <div style={{ background: cardBg, borderRadius: 12, border: `1px solid ${borderColor}`, padding: '24px 16px', textAlign: 'center' }}>
              <p style={{ margin: 0, fontSize: 14, color: subText }}>確認待ちの申請はありません</p>
            </div>
          )}

          {pendingForMe.map(r => {
            const planned = (r.segments ?? []).filter(s => s.phase === 'planned').sort((a, b) => a.seg_no - b.seg_no);
            const actual = (r.segments ?? []).filter(s => s.phase === 'actual').sort((a, b) => a.seg_no - b.seg_no);
            const isAdvance = r.status === 'requested';
            const isFullDay = isFullDayReport(r.application_types);
            const fdType = (r.application_types ?? []).find(isOvertimeType);
            const legal = r.legal_warning;
            return (
              <div key={r.id} style={{ background: cardBg, borderRadius: 12, border: `1px solid ${borderColor}`, padding: '14px 16px', marginBottom: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6, gap: 8 }}>
                  <span style={{ fontSize: 15, fontWeight: 'bold', color: text }}>
                    {r.applicant?.name ?? ''}　{r.work_date}（{dowLabel(r.work_date)}）
                  </span>
                  <div style={{ display: 'flex', gap: 4 }}>
                    {r.is_post_hoc && <span style={badgeStyle(POSTHOC_BADGE.color, POSTHOC_BADGE.darkBg, isDark)}>事後報告</span>}
                    <span style={badgeStyle(STATUS_INFO[r.status].color, STATUS_INFO[r.status].darkBg, isDark)}>{STATUS_INFO[r.status].label}</span>
                  </div>
                </div>

                <div style={{ background: innerBg, borderRadius: 8, padding: '8px 10px', marginBottom: 8, fontSize: 12.5, lineHeight: 1.8, color: text }}>
                  <span style={{ color: subText }}>通常シフト：</span>
                  {r.normal_shift?.start_time ? `${fmtTime(r.normal_shift.start_time)}〜${fmtTime(r.normal_shift.end_time)}（労働${formatMin(r.normal_shift.labor_minutes)}）` : '休み'}
                  {r.normal_shift?.manual_override && <span style={{ color: '#e65100' }}>（本人修正）</span>}
                  <br />
                  {isFullDay ? (
                    <>
                      <span style={{ color: subText }}>申請内容　：</span>
                      <span style={{ fontWeight: 'bold' }}>終日　{fdType ? OT_TYPE_INFO[fdType].label : ''}</span><br />
                      {r.furikae_origin_date && (
                        <><span style={{ color: subText }}>振替元　　：</span>{r.furikae_origin_date.slice(5).replace('-', '/')}（{dowLabel(r.furikae_origin_date)}）{r.furikae_origin_location ? `・${r.furikae_origin_location}` : ''}<br /></>
                      )}
                      <span style={{ color: subText }}>
                        {fdType === 'chosei_off' && <>合計時間数 <span style={{ fontWeight: 'bold', color: diffColor(r.diff_minutes ?? 0, isDark) }}>{formatSignedMin(r.diff_minutes ?? 0)}</span>（受理で確定します）</>}
                        {fdType === 'furikae_off' && '休日出勤の振替として記録（受理で確定します）'}
                        {fdType === 'absence' && '欠勤1日として記録（受理で確定します）'}
                      </span>
                    </>
                  ) : (
                    <>
                      {planned.length > 0 && (
                        <><span style={{ color: subText }}>事前申請　：</span>{segmentsLabel(planned)}<br /></>
                      )}
                      {actual.length > 0 && (
                        <><span style={{ color: subText }}>実績　　　：</span><span style={{ fontWeight: 'bold' }}>{segmentsLabel(actual)}</span><br /></>
                      )}
                      <span style={{ color: subText }}>休憩{formatMin(r.break_minutes ?? 0)}{r.break_manual ? '（手修正）' : ''}・労働{formatMin(r.labor_minutes ?? 0)}・差分 </span>
                      <span style={{ fontWeight: 'bold', color: diffColor(r.diff_minutes ?? 0, isDark) }}>{formatSignedMin(r.diff_minutes ?? 0)}</span>
                    </>
                  )}
                </div>

                {legal && (
                  <div style={{ background: isDark ? '#4a3a10' : '#fff8e1', border: '1px solid #f59e0b', borderRadius: 8, padding: '8px 10px', marginBottom: 8 }}>
                    <p style={{ margin: 0, fontSize: 12, color: isDark ? '#ffd54f' : '#856404', lineHeight: 1.7 }}>
                      ⚠️ この日は休憩が法定基準に足りていません。実態を確認のうえ受理してください。
                    </p>
                  </div>
                )}

                {(r.application_types ?? []).length > 0 && (
                  <div style={{ margin: '0 0 8px' }}>
                    <TypeChips types={r.application_types} isDark={isDark} />
                  </div>
                )}
                <p style={{ margin: '0 0 10px', fontSize: 12.5, color: subText }}>理由：{r.reason}　／　勤務地：{r.location ?? '-'}</p>

                {returnTargetId === r.id ? (
                  <div style={{ background: innerBg, borderRadius: 8, padding: '10px 12px' }}>
                    <span style={{ fontSize: 12.5, fontWeight: 'bold', color: text, display: 'block', marginBottom: 6 }}>差し戻しの理由 <span style={{ color: '#dc3545' }}>*</span></span>
                    <textarea value={returnComment} onChange={e => setReturnComment(e.target.value)} rows={2}
                      style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 8, border: `1px solid ${borderColor}`, background: isDark ? '#495057' : '#fff', color: text, fontSize: 13, resize: 'vertical' }} />
                    <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                      <button onClick={() => doReturn(r)} disabled={!returnComment.trim() || actingId === r.id}
                        style={{ flex: 1, padding: '9px 0', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 'bold', background: '#dc3545', color: '#fff', opacity: !returnComment.trim() ? 0.5 : 1 }}>
                        差し戻す
                      </button>
                      <button onClick={() => { setReturnTargetId(null); setReturnComment(''); }}
                        style={{ flex: 1, padding: '9px 0', borderRadius: 8, border: `1px solid ${borderColor}`, cursor: 'pointer', fontSize: 13, background: 'transparent', color: subText }}>
                        やめる
                      </button>
                    </div>
                  </div>
                ) : (
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button onClick={() => doApprove(r)} disabled={actingId === r.id}
                      style={{ flex: 1, padding: '10px 0', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: 'bold', background: '#28a745', color: '#fff', opacity: actingId === r.id ? 0.6 : 1 }}>
                      {isAdvance ? '事前申請を受理' : '受理'}
                    </button>
                    <button onClick={() => { setReturnTargetId(r.id); setReturnComment(''); }}
                      style={{ flex: 1, padding: '10px 0', borderRadius: 8, border: `1px solid ${borderColor}`, cursor: 'pointer', fontSize: 14, background: 'transparent', color: subText }}>
                      差し戻し
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // ────────────────────────────────────────────
  // 通常ビュー
  // ────────────────────────────────────────────
  return (
    <div style={{ maxWidth: 600, margin: '0 auto', padding: '16px 16px 40px' }}>
      <div>
        <h2 style={{ textAlign: 'center', margin: '12px 0 16px', fontSize: 20, fontWeight: 'bold', color: isDark ? '#fff' : '#333' }}>⏱ 残業・時間管理</h2>

        {/* このページの説明（他ページと同様式） */}
        <div style={{ background: '#fff3cd', border: '1px solid #ffe0a3', borderRadius: 8, padding: '12px 14px', marginBottom: 16, textAlign: 'left' }}>
          <p style={{ fontSize: 13, fontWeight: 'bold', color: '#856404', textAlign: 'center', margin: '0 0 10px' }}>【正社員専用】</p>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, margin: '0 0 8px' }}>
            <span style={{ flexShrink: 0, width: 22, height: 22, borderRadius: '50%', background: '#4a90d9', color: '#fff', fontSize: 13, fontWeight: 'bold', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>1</span>
            <span style={{ fontSize: 14, fontWeight: 'bold', color: '#664d03', lineHeight: '22px' }}>シフトと違う勤務（残業・早退・調整）を事前申請・事後報告できます</span>
          </div>
          <p style={{ fontSize: 12, color: '#856404', lineHeight: 1.8, margin: '0 0 8px' }}>（これまでの残業申請表の代わりです。）</p>
          <p style={{ fontSize: 12, color: '#856404', lineHeight: 1.8, margin: 0 }}>※シフトと違う勤務は必ず事前申請してください。急なお客様対応などは事後報告でも大丈夫です。</p>
          <p style={{ fontSize: 12, color: '#856404', lineHeight: 1.8, margin: '0 0 8px' }}>※今期：{payMonthLabel(currentPeriod)}（{payPeriodLabel(currentPeriod)}）</p>
          {/* 通常シフト（曜日パターン）確認：この案内枠の中に配置。押したら開く。
              枠は常に黄色（ダークでも #fff3cd）なので、中身はライト配色固定で読めるようにする */}
          <MyPatternToggle isDark={false} patterns={patterns} />
        </div>

        {loadError && (
          <div style={{ background: isDark ? '#4a1515' : '#f8d7da', border: '1px solid #dc3545', borderRadius: 10, padding: '10px 12px', marginBottom: 14, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <p style={{ margin: 0, fontSize: 13, color: isDark ? '#f5b5ba' : '#842029' }}>{loadError}</p>
            <button onClick={() => { fetchOwn(); fetchPendingForMe(); }}
              style={{ flexShrink: 0, padding: '6px 12px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 'bold', background: '#dc3545', color: '#fff' }}>再読み込み</button>
          </div>
        )}
        {actionError && (
          <div style={{ background: isDark ? '#4a1515' : '#f8d7da', border: '1px solid #dc3545', borderRadius: 10, padding: '10px 12px', marginBottom: 14 }}>
            <p style={{ margin: 0, fontSize: 13, color: isDark ? '#f5b5ba' : '#842029' }}>{actionError}</p>
          </div>
        )}
        {gcalWarning && (
          <div style={{ background: isDark ? '#4a3a10' : '#fff8e1', border: '1px solid #f59e0b', borderRadius: 10, padding: '10px 12px', marginBottom: 14, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <p style={{ margin: 0, fontSize: 12.5, color: isDark ? '#ffd54f' : '#856404' }}>⚠️ {gcalWarning.message}</p>
            {gcalWarning.reportId && (
              <button onClick={retryGcalSync} disabled={retrying}
                style={{ flexShrink: 0, padding: '6px 12px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 'bold', background: '#f59e0b', color: '#fff', opacity: retrying ? 0.6 : 1 }}>
                {retrying ? '再同期中…' : 'カレンダー再同期'}
              </button>
            )}
            <button onClick={() => setGcalWarning(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, color: subText }}>✕</button>
          </div>
        )}

        {/* 送信完了バナー */}
        {savedBanner && (
          <div style={{ background: isDark ? '#1b3a1e' : '#d1e7dd', border: '1px solid #28a745', borderRadius: 10, padding: '10px 14px', marginBottom: 14, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <p style={{ margin: 0, fontSize: 13, fontWeight: 'bold', color: isDark ? '#8fd19e' : '#0f5132' }}>✅ 送信しました。履歴・通算タブで状況を確認できます</p>
            <button onClick={() => setSavedBanner(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, color: subText }}>✕</button>
          </div>
        )}

        {/* タブ */}
        <div style={{ display: 'flex', borderRadius: '10px 10px 0 0', overflow: 'hidden', border: `1px solid ${borderColor}`, borderBottom: 'none' }}>
          {(['form', 'history'] as const).map(t => (
            <button key={t} onClick={() => { setTab(t); setEditTarget(null); }}
              style={{
                flex: 1, padding: '12px 0', border: 'none', cursor: 'pointer', fontSize: 15,
                fontWeight: tab === t ? 'bold' : 'normal',
                background: tab === t ? '#28a745' : (isDark ? '#495057' : '#f8f9fa'),
                color: tab === t ? '#fff' : text,
              }}>
              {t === 'form' ? '申請・報告' : '履歴・通算'}
            </button>
          ))}
        </div>

        {/* 確認ページへ（確認者・集計閲覧者のみ・タブ直下） */}
        {(canSummary || pendingForMe.length > 0) && (
          <button onClick={() => { setSearchParams({ view: 'confirm' }); window.scrollTo({ top: 0 }); }}
            style={{ width: '100%', padding: '10px', background: '#fd7e14', color: 'white', border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: 'bold', marginTop: 8, marginBottom: 8, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, boxSizing: 'border-box' }}>
            <span>✅ 確認ページへ</span>
            {pendingForMe.length > 0 && (
              <span style={{ background: '#fff', color: '#fd7e14', borderRadius: 10, padding: '1px 8px', fontSize: 12, fontWeight: 'bold' }}>{pendingForMe.length}件</span>
            )}
          </button>
        )}

        <div style={{ background: isDark ? '#2b3035' : '#fff', border: `1px solid ${borderColor}`, borderRadius: '0 0 12px 12px', padding: '16px 14px' }}>
          {loading ? (
            <p style={{ margin: 0, fontSize: 13, color: subText, textAlign: 'center' }}>読み込み中…</p>
          ) : tab === 'form' ? (
            <OvertimeForm
              user={user} profileName={profileName} roleTitle={roleTitle} isAdmin={isAdmin}
              reviewers={reviewers} workplaces={workplaces} patterns={patterns}
              editTarget={editTarget}
              onSaved={(gcalWarn) => {
                setSavedBanner(true);
                if (gcalWarn) setGcalWarning({ message: gcalWarn, reportId: editTarget?.id ?? null });
                setEditTarget(null); setTab('history'); fetchOwn(); window.scrollTo({ top: 0 });
              }}
              onClose={() => setEditTarget(null)}
            />
          ) : (
            <>
              {/* 集計モード切替（権限者のみ） */}
              {canSummary && (
                <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
                  {(['own', 'summary'] as const).map(m => (
                    <button key={m} onClick={() => { setHistoryMode(m); if (m === 'own') clearSelectedStaff(); }}
                      style={{
                        flex: 1, padding: '8px 0', borderRadius: 8, cursor: 'pointer', fontSize: 13,
                        fontWeight: historyMode === m ? 'bold' : 'normal',
                        border: historyMode === m ? '2px solid #28a745' : `1px solid ${borderColor}`,
                        background: historyMode === m ? (isDark ? '#1b3a1e' : '#eaf6ec') : 'transparent',
                        color: historyMode === m ? (isDark ? '#8fd19e' : '#2e7d32') : subText,
                      }}>
                      {m === 'own' ? '自分の履歴' : '部門集計'}
                    </button>
                  ))}
                </div>
              )}

              {historyMode === 'summary' && canSummary ? (
                selectedStaffId ? (
                  <MemberDetailView
                    isDark={isDark}
                    userId={selectedStaffId}
                    name={summaryRows.find(r => r.userId === selectedStaffId)?.name ?? ''}
                    period={summaryPeriod}
                    onBack={clearSelectedStaff}
                  />
                ) : (
                  <SummaryView
                    isDark={isDark} rows={summaryRows}
                    period={summaryPeriod} onChangePeriod={setSummaryPeriod}
                    myGroups={myGroups} dept={summaryDept} onChangeDept={setSummaryDept}
                    nameQuery={summaryNameQuery} onChangeName={setSummaryNameQuery}
                    filterOpen={summaryFilterOpen} onToggleFilter={() => setSummaryFilterOpen(o => !o)}
                    onSelect={selectStaff}
                  />
                )
              ) : (
                <>
                  {/* 合計時間数カード */}
                  <div style={{ background: innerBg, borderRadius: 12, padding: '14px 16px', marginBottom: 8 }}>
                    <p style={{ margin: 0, fontSize: 12.5, color: subText }}>今期の合計時間数（{payPeriodLabel(currentPeriod)}・{payMonthLabel(currentPeriod)}）</p>
                    <p style={{ margin: '4px 0 2px', fontSize: 26, fontWeight: 'bold', color: diffColor(balance.total, isDark) }}>
                      {formatSignedMin(balance.total)}
                    </p>
                    {balance.plannedDelta !== 0 && (
                      <p style={{ margin: '0 0 6px', fontSize: 12.5, color: subText }}>
                        見込み {formatSignedMin(balance.plannedTotal)}（確認待ち反映後）
                      </p>
                    )}
                    <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 4, fontSize: 12.5, color: subText, borderTop: `1px solid ${borderColor}`, paddingTop: 8 }}>
                      <span>残業 {formatSignedMin(balance.plus)}</span>
                      <span>調整休 {formatSignedMin(balance.choseiMinus)}</span>
                      <span>早退・調整 {formatSignedMin(balance.otherMinus)}</span>
                    </div>
                    {balance.absenceDays + balance.absencePending > 0 && (
                      <p style={{ margin: '6px 0 0', fontSize: 12, color: subText }}>
                        欠勤 {balance.absenceDays}日{balance.absencePending > 0 && `（確認待ち${balance.absencePending}件）`}
                      </p>
                    )}
                    <p style={{ margin: '8px 0 0', fontSize: 11.5, color: subText }}>
                      期ごとの過不足管理（毎期リセット・繰り越しなし）・前期確定 {formatSignedMin(prevPeriodBalance)}
                      {balance.pendingCount > 0 && `・確認待ち${balance.pendingCount}件は未計上`}
                    </p>
                  </div>

                  {/* 曜日パターン確認 */}
                  <div style={{ textAlign: 'right', marginBottom: 12 }}>
                    <MyPatternToggle isDark={isDark} patterns={patterns} />
                  </div>

                  {/* 実績未報告リマインド */}
                  {unreportedRequests.length > 0 && (
                    <div style={{ background: isDark ? '#4a3a10' : '#fff8e1', border: '1px solid #f59e0b', borderRadius: 10, padding: '10px 12px', marginBottom: 12 }}>
                      <p style={{ margin: 0, fontSize: 12.5, fontWeight: 'bold', color: isDark ? '#ffd54f' : '#856404' }}>
                        🔔 実績が未報告の事前申請が{unreportedRequests.length}件あります（{unreportedRequests.map(r => r.work_date.slice(5).replace('-', '/')).join('・')}）
                      </p>
                    </div>
                  )}

                  {/* 履歴リスト */}
                  {ownHistory.length === 0 && (
                    <p style={{ margin: '16px 0', fontSize: 13, color: subText, textAlign: 'center' }}>まだ申請・報告はありません</p>
                  )}
                  {ownHistory.map(r => {
                    const isAuto = r.entry_type === 'leave_auto';
                    const isFullDay = isFullDayReport(r.application_types);
                    const canReport = r.status === 'request_confirmed' && !isFullDay;
                    const canResubmit = r.status === 'returned';
                    const canCancel = ['requested', 'request_confirmed', 'reported', 'returned'].includes(r.status) && !isAuto;
                    const actual = (r.segments ?? []).filter(s => s.phase === 'actual').sort((a, b) => a.seg_no - b.seg_no);
                    const planned = (r.segments ?? []).filter(s => s.phase === 'planned').sort((a, b) => a.seg_no - b.seg_no);
                    const segs = actual.length > 0 ? actual : planned;
                    return (
                      <div key={r.id} style={{ background: cardBg, borderRadius: 12, border: `1px solid ${borderColor}`, padding: '12px 14px', marginBottom: 10 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4, gap: 6, flexWrap: 'wrap' }}>
                          <span style={{ fontSize: 14, fontWeight: 'bold', color: text }}>
                            {r.work_date.slice(5).replace('-', '/')}（{dowLabel(r.work_date)}）
                            <span style={{ color: diffColor(r.diff_minutes ?? 0, isDark), marginLeft: 6 }}>{formatSignedMin(r.diff_minutes ?? 0)}</span>
                          </span>
                          <div style={{ display: 'flex', gap: 4 }}>
                            {isAuto && <span style={badgeStyle(AUTO_BADGE.color, AUTO_BADGE.darkBg, isDark)}>自動計上</span>}
                            {!isAuto && r.is_post_hoc && <span style={badgeStyle(POSTHOC_BADGE.color, POSTHOC_BADGE.darkBg, isDark)}>事後報告</span>}
                            {!isAuto && <span style={badgeStyle(STATUS_INFO[r.status].color, STATUS_INFO[r.status].darkBg, isDark)}>{STATUS_INFO[r.status].label}</span>}
                          </div>
                        </div>

                        {isAuto ? (
                          <p style={{ margin: 0, fontSize: 12.5, color: subText }}>
                            🌿 休暇申請（時間外調整休）の受理により自動計上
                          </p>
                        ) : (
                          <>
                            {(r.application_types ?? []).length > 0 && (
                              <div style={{ margin: '2px 0 4px' }}>
                                <TypeChips types={r.application_types} isDark={isDark} />
                              </div>
                            )}
                            <p style={{ margin: 0, fontSize: 12.5, color: subText }}>
                              {isFullDay && '終日　'}
                              {isFullDay && r.furikae_origin_date && `振替元：${r.furikae_origin_date.slice(5).replace('-', '/')}（${dowLabel(r.furikae_origin_date)}）${r.furikae_origin_location ? '・' + r.furikae_origin_location : ''}　`}
                              {!isFullDay && segs.length > 0 && `${actual.length > 0 ? '実績' : '予定'}：${segmentsLabel(segs)}　`}
                              {r.reviewer?.name && `申請先：${r.reviewer.name}さん`}
                            </p>
                            {r.status === 'returned' && r.return_comment && (
                              <p style={{ margin: '4px 0 0', fontSize: 12.5, color: isDark ? '#f5b5ba' : '#c62828' }}>差し戻し理由：{r.return_comment}</p>
                            )}
                          </>
                        )}

                        {(canReport || canResubmit || canCancel) && (
                          <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                            {canReport && (
                              <button onClick={() => { setEditTarget(r); setTab('form'); window.scrollTo({ top: 0 }); }}
                                style={{ flex: 2, minWidth: 160, padding: '9px 0', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 'bold', background: '#28a745', color: '#fff' }}>
                                実績を報告する
                              </button>
                            )}
                            {canResubmit && (
                              <button onClick={() => { setEditTarget(r); setTab('form'); window.scrollTo({ top: 0 }); }}
                                style={{ flex: 2, minWidth: 120, padding: '9px 0', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 'bold', background: '#0d6efd', color: '#fff' }}>
                                修正して再提出
                              </button>
                            )}
                            {canCancel && (
                              cancelTargetId === r.id ? (
                                <div style={{ flex: 1, display: 'flex', gap: 6, minWidth: 180 }}>
                                  <button onClick={() => doCancel(r)} disabled={actingId === r.id}
                                    style={{ flex: 1, padding: '9px 0', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 12.5, fontWeight: 'bold', background: '#dc3545', color: '#fff' }}>
                                    取消を確定
                                  </button>
                                  <button onClick={() => setCancelTargetId(null)}
                                    style={{ flex: 1, padding: '9px 0', borderRadius: 8, border: `1px solid ${borderColor}`, cursor: 'pointer', fontSize: 12.5, background: 'transparent', color: subText }}>
                                    やめる
                                  </button>
                                </div>
                              ) : (
                                <button onClick={() => setCancelTargetId(r.id)}
                                  style={{ flex: 1, minWidth: 70, padding: '9px 0', borderRadius: 8, border: `1px solid ${borderColor}`, cursor: 'pointer', fontSize: 13, background: 'transparent', color: subText }}>
                                  取消
                                </button>
                              )
                            )}
                          </div>
                        )}

                        {!isAuto && r.status === 'confirmed' && (
                          <CorrectionBadgeAndButton
                            targetType="overtime"
                            targetId={r.id}
                            targetLabel={`残業 ${r.work_date.slice(5).replace('-', '/')}（${dowLabel(r.work_date)}）`}
                            fields={[
                              { key: 'date', label: '日付', current: r.work_date, inputType: 'date' },
                              { key: 'time', label: '時間', current: segs.length > 0 ? segmentsLabel(segs) : '' },
                              { key: 'location', label: '校', current: r.location ?? '' },
                            ]}
                            requesterName={profileName || user.email || 'スタッフ'}
                            isDark={isDark}
                            latest={corrections.get(r.id) ?? null}
                            canRequest
                            onSubmitted={reloadCorrections}
                          />
                        )}
                      </div>
                    );
                  })}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};

// ────────────────────────────────────────────────────────────────
// 自分の曜日パターン表示（読み取り専用・UX指摘14）
// ────────────────────────────────────────────────────────────────
const MyPatternToggle: React.FC<{ isDark: boolean; patterns: PatternRow[] }> = ({ isDark, patterns }) => {
  const [open, setOpen] = useState(false);
  const text = isDark ? '#f8f9fa' : '#212529';
  const subText = isDark ? '#adb5bd' : '#6c757d';
  const borderColor = isDark ? '#495057' : '#dee2e6';
  const today = todayJstStr();
  const active = patterns.filter(p => p.valid_from <= today && (p.valid_to === null || p.valid_to >= today));
  const order: DayKind[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun', 'holiday', 'work_on_closed'];
  return (
    <div style={{ textAlign: 'left' }}>
      <div style={{ textAlign: 'right' }}>
        <button onClick={() => setOpen(o => !o)}
          style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, color: '#0d6efd', textDecoration: 'underline' }}>
          自分の通常シフトを{open ? '閉じる' : '確認'}
        </button>
      </div>
      {open && (
        <div style={{ border: `1px solid ${borderColor}`, borderRadius: 10, padding: '10px 12px', marginTop: 6 }}>
          {active.length === 0 ? (
            <p style={{ margin: 0, fontSize: 12.5, color: subText }}>曜日パターンが未登録です。管理者にご連絡ください。</p>
          ) : (
            <>
              <table style={{ width: '100%', fontSize: 12.5, borderCollapse: 'collapse', color: text }}>
                <tbody>
                  {order.filter(k => active.some(p => p.day_kind === k)).map((k, i) => {
                    const p = active.find(x => x.day_kind === k)!;
                    const rowStyle: React.CSSProperties = { borderTop: i > 0 ? `1px solid ${borderColor}` : 'none' };
                    const cell: React.CSSProperties = { padding: '6px 0', verticalAlign: 'top' };
                    return (
                      <tr key={k} style={rowStyle}>
                        <td style={{ ...cell, color: subText, whiteSpace: 'nowrap', paddingRight: 10, fontWeight: 'bold', width: 44 }}>{DAY_KIND_LABELS[k]}</td>
                        <td style={cell}>
                          {p.start_time ? (
                            <>
                              <span style={{ whiteSpace: 'nowrap' }}>{fmtTime(p.start_time)}〜{fmtTime(p.end_time)}</span>
                              {p.start_time2 && <span style={{ whiteSpace: 'nowrap' }}>　＋　{fmtTime(p.start_time2)}〜{fmtTime(p.end_time2)}</span>}
                              <span style={{ display: 'block', fontSize: 11, color: subText, marginTop: 1 }}>休憩{formatMin(p.break_minutes)}・労働{formatMin(p.labor_minutes)}</span>
                            </>
                          ) : <span style={{ color: subText }}>休み</span>}
                        </td>
                        <td style={{ ...cell, color: subText, textAlign: 'right', whiteSpace: 'nowrap', paddingLeft: 8 }}>
                          {p.start_time ? (p.location ?? '') : ''}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p style={{ margin: '6px 0 0', fontSize: 11.5, color: subText }}>内容が実際と違う場合は管理者にご連絡ください</p>
            </>
          )}
        </div>
      )}
    </div>
  );
};

// 期間の選択肢（今期から過去6期分）
function recentPeriods(count = 6): string[] {
  const opts: string[] = [];
  let p = calcPayPeriodStartJst(todayJstStr());
  for (let i = 0; i < count; i++) {
    opts.push(p);
    const [y, m] = p.split('-').map(Number);
    const py = m === 1 ? y - 1 : y;
    const pm = m === 1 ? 12 : m - 1;
    p = `${py}-${String(pm).padStart(2, '0')}-16`;
  }
  return opts;
}

// ────────────────────────────────────────────────────────────────
// 部門集計ビュー（リーダー以上）。行タップで個人詳細へ。合計は確定を主・見込みを併記。
// ────────────────────────────────────────────────────────────────
const SummaryView: React.FC<{
  isDark: boolean;
  rows: SummaryRow[];
  period: string;
  onChangePeriod: (p: string) => void;
  myGroups: string[];
  dept: string;
  onChangeDept: (v: string) => void;
  nameQuery: string;
  onChangeName: (v: string) => void;
  filterOpen: boolean;
  onToggleFilter: () => void;
  onSelect: (userId: string) => void;
}> = ({ isDark, rows, period, onChangePeriod, myGroups, dept, onChangeDept, nameQuery, onChangeName, filterOpen, onToggleFilter, onSelect }) => {
  const text = isDark ? '#f8f9fa' : '#212529';
  const subText = isDark ? '#adb5bd' : '#6c757d';
  const borderColor = isDark ? '#495057' : '#dee2e6';
  const innerBg = isDark ? '#2b3035' : '#f8f9fa';
  const inputBg = isDark ? '#495057' : '#fff';

  const periodOptions = useMemo(() => recentPeriods(6), []);

  // 部門(チーム)の選択肢は実際のメンバーの group から作る。未所属/その他は末尾。
  const deptOptions = useMemo(() => {
    const set = new Set(rows.map(r => r.group));
    const list = [...set].sort((a, b) => a.localeCompare(b, 'ja'));
    const tail = ['未所属', 'その他'];
    return [...list.filter(g => !tail.includes(g)), ...list.filter(g => tail.includes(g))];
  }, [rows]);

  // 実効の部門フィルタ。dept='' なら自所属を初期選択（無ければ全チーム）。'__all__'=全チーム。
  const activeDept = dept !== '' ? dept : (myGroups.find(g => deptOptions.includes(g)) ?? '__all__');

  const visibleRows = rows.filter(r => {
    if (nameQuery.trim() && !r.name.includes(nameQuery.trim())) return false;
    if (activeDept !== '__all__' && r.group !== activeDept) return false;
    return true;
  });
  const groupOrder = deptOptions.filter(g => visibleRows.some(r => r.group === g));
  const total = visibleRows.reduce((s, r) => s + r.total, 0);
  const plannedTotal = visibleRows.reduce((s, r) => s + r.plannedTotal, 0);

  const selectStyle: React.CSSProperties = { padding: '6px 10px', borderRadius: 8, border: `1px solid ${borderColor}`, background: inputBg, color: text, fontSize: 13 };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 14, fontWeight: 'bold', color: text }}>📊 月次集計</span>
        <select value={period} onChange={e => onChangePeriod(e.target.value)} style={selectStyle}>
          {periodOptions.map(p => <option key={p} value={p}>{payMonthLabel(p)}（{payPeriodLabel(p)}）</option>)}
        </select>
      </div>

      {/* 常時: 部門(チーム)フィルタ＋名前検索。初期は自所属チーム。 */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        <select value={activeDept} onChange={e => onChangeDept(e.target.value)} style={{ ...selectStyle, flex: '0 0 auto' }}>
          <option value="__all__">すべてのチーム</option>
          {deptOptions.map(g => <option key={g} value={g}>{g}</option>)}
        </select>
        <input value={nameQuery} onChange={e => onChangeName(e.target.value)} placeholder="名前で絞り込み"
          style={{ flex: 1, minWidth: 120, boxSizing: 'border-box', padding: '8px 10px', borderRadius: 8, border: `1px solid ${borderColor}`, background: inputBg, color: text, fontSize: 13 }} />
      </div>
      <button onClick={onToggleFilter} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, color: '#0d6efd', padding: 0, marginBottom: 10 }}>
        絞り込み{filterOpen ? ' ▲' : ' ▼'}
      </button>
      {filterOpen && (
        <div style={{ border: `1px solid ${borderColor}`, borderRadius: 10, padding: '10px 12px', marginBottom: 10, fontSize: 12.5, color: subText }}>
          <p style={{ margin: 0 }}>合計は<strong style={{ color: text }}>確定</strong>を主に表示し、<strong style={{ color: text }}>見込</strong>（申請中・受理済み・報告待ちを反映）を下に併記します。差し戻し・取消は合計に含みません。</p>
        </div>
      )}

      {visibleRows.length === 0 ? (
        <p style={{ margin: '16px 0', fontSize: 13, color: subText, textAlign: 'center' }}>該当する記録はありません</p>
      ) : (
        <>
          {groupOrder.map(g => {
            const grows = visibleRows.filter(r => r.group === g);
            const sub = grows.reduce((s, r) => s + r.total, 0);
            return (
              <div key={g} style={{ marginBottom: 14 }}>
                <p style={{ margin: '0 0 6px', fontSize: 12.5, fontWeight: 'bold', color: subText }}>{g}</p>
                <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse', color: text }}>
                  <tbody>
                    {grows.map(r => (
                      <tr key={r.userId} onClick={() => onSelect(r.userId)} style={{ cursor: 'pointer' }}>
                        <td style={{ padding: '7px 0', borderBottom: `1px solid ${borderColor}` }}>
                          {r.name}
                          {r.absenceDays > 0 && <span style={{ marginLeft: 6, fontSize: 11, color: subText }}>欠{r.absenceDays}日</span>}
                          {(r.group !== '未所属' || r.role) && (
                            <span style={{ display: 'block', fontSize: 11, color: subText }}>
                              {[r.group !== '未所属' ? r.group : null, r.role || null].filter(Boolean).join('・')}
                            </span>
                          )}
                        </td>
                        <td style={{ padding: '7px 0', borderBottom: `1px solid ${borderColor}`, textAlign: 'right' }}>
                          <span style={{ color: diffColor(r.total, isDark), fontWeight: 'bold' }}>{formatSignedMin(r.total)}</span>
                          {r.plannedTotal !== r.total && (
                            <span style={{ display: 'block', fontSize: 11, color: subText }}>見込 {formatSignedMin(r.plannedTotal)}</span>
                          )}
                        </td>
                        <td style={{ padding: '7px 0 7px 8px', borderBottom: `1px solid ${borderColor}`, textAlign: 'right', color: subText, width: 14 }}>›</td>
                      </tr>
                    ))}
                    <tr>
                      <td style={{ padding: '5px 0', fontWeight: 'bold' }}>小計</td>
                      <td style={{ padding: '5px 0', textAlign: 'right', fontWeight: 'bold', color: diffColor(sub, isDark) }}>{formatSignedMin(sub)}</td>
                      <td />
                    </tr>
                  </tbody>
                </table>
              </div>
            );
          })}
          <div style={{ background: innerBg, borderRadius: 8, padding: '10px 12px', fontSize: 14, fontWeight: 'bold', color: text }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>総合計（確定）</span>
              <span style={{ color: diffColor(total, isDark) }}>{formatSignedMin(total)}</span>
            </div>
            {plannedTotal !== total && (
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, fontWeight: 'normal', color: subText, marginTop: 2 }}>
                <span>見込み合計</span>
                <span>{formatSignedMin(plannedTotal)}</span>
              </div>
            )}
          </div>
          <p style={{ margin: '8px 0 0', fontSize: 11.5, color: subText }}>名前をタップすると個人の申請履歴を確認できます。確定＝給与に効く数字です。</p>
        </>
      )}
    </div>
  );
};

// ────────────────────────────────────────────────────────────────
// 個人詳細ビュー（部門集計から名前タップで遷移。閲覧専用・その人の当期の全履歴）
// ────────────────────────────────────────────────────────────────
const MemberDetailView: React.FC<{
  isDark: boolean;
  userId: string;
  name: string;
  period: string;
  onBack: () => void;
}> = ({ isDark, userId, name, period, onBack }) => {
  const text = isDark ? '#f8f9fa' : '#212529';
  const subText = isDark ? '#adb5bd' : '#6c757d';
  const borderColor = isDark ? '#495057' : '#dee2e6';
  const innerBg = isDark ? '#2b3035' : '#f8f9fa';
  const cardBg = isDark ? '#343a40' : '#fff';

  const [rows, setRows] = useState<OvertimeReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    let alive = true;
    setLoading(true);
    (async () => {
      const { data, error } = await supabase.from('overtime_reports')
        .select('*, applicant:profiles!overtime_reports_applicant_profiles_fkey(name), reviewer:profiles!overtime_reports_reviewer_profiles_fkey(name), segments:overtime_report_segments(*)')
        .eq('applicant_id', userId)
        .eq('pay_period_start', period)
        .order('work_date', { ascending: false });
      if (!alive) return;
      if (error) { setLoadError('履歴の読み込みに失敗しました：' + error.message); setLoading(false); return; }
      setLoadError('');
      setRows((data as OvertimeReport[] | null) ?? []);
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [userId, period]);

  const b = useMemo(() => computeBalance(rows, period), [rows, period]);
  // 取消済みは表示しない。差し戻しは表示する。
  const visible = rows.filter(r => r.status !== 'cancelled');

  return (
    <div>
      {/* パンくず＋戻る */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        <button onClick={onBack} style={{ background: 'none', border: `1px solid ${borderColor}`, borderRadius: 8, cursor: 'pointer', fontSize: 12.5, color: subText, padding: '5px 10px' }}>← 一覧へ戻る</button>
        <span style={{ fontSize: 12.5, color: subText }}>部門集計 › <span style={{ color: text, fontWeight: 'bold' }}>{name || '個人'}</span></span>
      </div>

      {/* 合計時間数カード（確定・見込み・内訳） */}
      <div style={{ background: innerBg, borderRadius: 12, padding: '14px 16px', marginBottom: 10 }}>
        <p style={{ margin: 0, fontSize: 12.5, color: subText }}>{payMonthLabel(period)}（{payPeriodLabel(period)}）の合計時間数</p>
        <p style={{ margin: '4px 0 2px', fontSize: 24, fontWeight: 'bold', color: diffColor(b.total, isDark) }}>{formatSignedMin(b.total)}</p>
        {b.plannedDelta !== 0 && (
          <p style={{ margin: '0 0 6px', fontSize: 12.5, color: subText }}>見込み {formatSignedMin(b.plannedTotal)}（確認待ち反映後）</p>
        )}
        <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 4, fontSize: 12.5, color: subText, borderTop: `1px solid ${borderColor}`, paddingTop: 8 }}>
          <span>残業 {formatSignedMin(b.plus)}</span>
          <span>調整休 {formatSignedMin(b.choseiMinus)}</span>
          <span>早退・調整 {formatSignedMin(b.otherMinus)}</span>
        </div>
        {b.absenceDays + b.absencePending > 0 && (
          <p style={{ margin: '6px 0 0', fontSize: 12, color: subText }}>
            欠勤 {b.absenceDays}日{b.absencePending > 0 && `（確認待ち${b.absencePending}件）`}
          </p>
        )}
      </div>

      {loadError && <p style={{ margin: '8px 0', fontSize: 12.5, color: isDark ? '#f5b5ba' : '#c62828' }}>{loadError}</p>}
      {loading ? (
        <p style={{ margin: '16px 0', fontSize: 13, color: subText, textAlign: 'center' }}>読み込み中…</p>
      ) : visible.length === 0 ? (
        <p style={{ margin: '16px 0', fontSize: 13, color: subText, textAlign: 'center' }}>この期間の申請・報告はありません</p>
      ) : (
        visible.map(r => <ReadonlyReportCard key={r.id} r={r} isDark={isDark} cardBg={cardBg} borderColor={borderColor} text={text} subText={subText} />)
      )}
    </div>
  );
};

// 個人詳細の1申請カード（閲覧専用。アクションボタンは持たない）
const ReadonlyReportCard: React.FC<{
  r: OvertimeReport; isDark: boolean; cardBg: string; borderColor: string; text: string; subText: string;
}> = ({ r, isDark, cardBg, borderColor, text, subText }) => {
  const isAuto = r.entry_type === 'leave_auto';
  const isFullDay = isFullDayReport(r.application_types);
  const actual = (r.segments ?? []).filter(s => s.phase === 'actual').sort((a, b) => a.seg_no - b.seg_no);
  const planned = (r.segments ?? []).filter(s => s.phase === 'planned').sort((a, b) => a.seg_no - b.seg_no);
  const segs = actual.length > 0 ? actual : planned;
  return (
    <div style={{ background: cardBg, borderRadius: 12, border: `1px solid ${borderColor}`, padding: '12px 14px', marginBottom: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4, gap: 6, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 14, fontWeight: 'bold', color: text }}>
          {r.work_date.slice(5).replace('-', '/')}（{dowLabel(r.work_date)}）
          <span style={{ color: diffColor(r.diff_minutes ?? 0, isDark), marginLeft: 6 }}>{formatSignedMin(r.diff_minutes ?? 0)}</span>
        </span>
        <div style={{ display: 'flex', gap: 4 }}>
          {isAuto && <span style={badgeStyle(AUTO_BADGE.color, AUTO_BADGE.darkBg, isDark)}>自動計上</span>}
          {!isAuto && r.is_post_hoc && <span style={badgeStyle(POSTHOC_BADGE.color, POSTHOC_BADGE.darkBg, isDark)}>事後報告</span>}
          {!isAuto && <span style={badgeStyle(STATUS_INFO[r.status].color, STATUS_INFO[r.status].darkBg, isDark)}>{STATUS_INFO[r.status].label}</span>}
        </div>
      </div>
      {isAuto ? (
        <p style={{ margin: 0, fontSize: 12.5, color: subText }}>🌿 休暇申請（時間外調整休）の受理により自動計上</p>
      ) : (
        <>
          {(r.application_types ?? []).length > 0 && (
            <div style={{ margin: '2px 0 4px' }}><TypeChips types={r.application_types} isDark={isDark} /></div>
          )}
          <p style={{ margin: 0, fontSize: 12.5, color: subText }}>
            {isFullDay && '終日　'}
            {isFullDay && r.furikae_origin_date && `振替元：${r.furikae_origin_date.slice(5).replace('-', '/')}（${dowLabel(r.furikae_origin_date)}）${r.furikae_origin_location ? '・' + r.furikae_origin_location : ''}　`}
            {!isFullDay && segs.length > 0 && `${actual.length > 0 ? '実績' : '予定'}：${segmentsLabel(segs)}　`}
            {!isFullDay && r.location && `勤務地：${r.location}　`}
            {r.reviewer?.name && `申請先：${r.reviewer.name}さん`}
          </p>
          {r.status === 'returned' && r.return_comment && (
            <p style={{ margin: '4px 0 0', fontSize: 12.5, color: isDark ? '#f5b5ba' : '#c62828' }}>差し戻し理由：{r.return_comment}</p>
          )}
        </>
      )}
    </div>
  );
};

export default OvertimePage;

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient';
import OvertimeProposalSheet, { type DraftCandidate } from '../components/OvertimeProposalSheet';
import OvertimeProposalResponse from '../components/OvertimeProposalResponse';
import { useDarkMode } from '../hooks/useDarkMode';
import { DRAFT_KEYS, loadDraft, saveDraft, clearDraft } from '../lib/draftStorage';
import {
  calcTotalBreak, calcLaborMinutes, calcSegmentBreak, checkLegalBreak,
  timeToMin, minToTime, formatSignedMin, formatMin,
  todayJstStr, calcPayPeriodStartJst, payPeriodLabel, payMonthLabel,
  payMonthPeriodLabel, payPeriodCloseCutoff, isPayPeriodClosed,
  DAY_KIND_LABELS,
} from '../lib/breakCalc';
import type { WorkSegment, DayKind, CalendarKind } from '../lib/breakCalc';
import { resolveNormalShift } from '../lib/overtimeShift';
import type { PatternRow, NormalShiftSnapshot } from '../lib/overtimeShift';
import type { AuthUser } from '../types';
import CorrectionBadgeAndButton from '../components/CorrectionBadgeAndButton';
import { OT_TYPE_INFO, isOvertimeType, FULL_DAY_TYPES, isFullDayReport } from '../lib/overtimeTypes';
import type { OvertimeType } from '../lib/overtimeTypes';
import { fetchLatestCorrectionByTarget } from '../lib/correctionRequest';
import { notifyOvertimeNewRequest } from '../lib/overtimeNotify';
import type { CorrectionRequestRow } from '../lib/correctionRequest';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────
type OvertimeStatus = 'requested' | 'request_confirmed' | 'reported' | 'confirmed' | 'returned' | 'cancelled';

// NormalShiftSnapshot / PatternRow / resolveNormalShift は lib/overtimeShift.ts に集約（受諾処理と共用）

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
  change_reason?: string | null;
  location: string | null;
  application_types: string[] | null;
  furikae_origin_date: string | null;
  furikae_origin_location: string | null;
  furikae_origin_start: string | null;
  furikae_origin_end: string | null;
  furikae_origin_break_minutes: number | null;
  furikae_origin_labor_minutes: number | null;
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

  // 調整休系（休みによる貸借）= 時間外調整休 / 休暇由来の自動計上 / 振替休日。
  // 振替休日の差分は net（振替元労働 − 対象日労働）で ± どちらもあり得るが、負のときは
  // 「早退・調整」ではなく「調整休」バケットに入れる（休みによる調整のため）。
  const isChosei = (r: OvertimeReport) => r.entry_type === 'leave_auto'
    || (r.application_types ?? []).includes('chosei_off')
    || (r.application_types ?? []).includes('furikae_off');
  const total = counted.reduce((s, r) => s + (r.diff_minutes ?? 0), 0);
  const plus = counted.filter(r => (r.diff_minutes ?? 0) > 0).reduce((s, r) => s + (r.diff_minutes ?? 0), 0);
  const choseiMinus = counted.filter(r => (r.diff_minutes ?? 0) < 0 && isChosei(r)).reduce((s, r) => s + (r.diff_minutes ?? 0), 0);
  const otherMinus = counted.filter(r => (r.diff_minutes ?? 0) < 0 && !isChosei(r)).reduce((s, r) => s + (r.diff_minutes ?? 0), 0);
  const minus = choseiMinus + otherMinus;

  // 見込み: 未確定ステータスの diff を加算（終日欠勤は diff=0 のため時間には影響しない）
  // 確定合計と同じ二重減算防止を適用: 同日に確定 leave_auto がある未確定の手動 chosei_off は見込みに入れない
  const plannedDelta = inPeriod.filter(r => PLANNED_STATUSES.includes(r.status) && !isDupChosei(r)).reduce((s, r) => s + (r.diff_minutes ?? 0), 0);
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

// resolveNormalShift は lib/overtimeShift.ts へ移設（受諾処理と共用・計算の単一化）

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
  furikaeOriginStart?: string;
  furikaeOriginEnd?: string;
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
  // 履歴は過去の申請から自動抽出するため、✕は「候補として今後出さない」（端末に記憶）
  const hiddenReasonsKey = `fivem_hidden_reasons_overtime_${user.id}`;
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
  // 振替休日の振替元（実際に出勤した日＋その日の勤務校＋出退勤時刻）。時刻から労働時間を出し、差分＝振替元労働−対象日労働。
  const [furikaeOriginDate, setFurikaeOriginDate] = useState<string>(() => editTarget?.furikae_origin_date ?? draft?.furikaeOriginDate ?? '');
  const [furikaeOriginLocation, setFurikaeOriginLocation] = useState<string>(() => editTarget?.furikae_origin_location ?? draft?.furikaeOriginLocation ?? '');
  const [furikaeOriginStart, setFurikaeOriginStart] = useState<string>(() => (editTarget?.furikae_origin_start ? editTarget.furikae_origin_start.slice(0, 5) : draft?.furikaeOriginStart ?? ''));
  const [furikaeOriginEnd, setFurikaeOriginEnd] = useState<string>(() => (editTarget?.furikae_origin_end ? editTarget.furikae_origin_end.slice(0, 5) : draft?.furikaeOriginEnd ?? ''));

  // 経理から締め後申請を許可された給与期間（pay_period_start の集合）。締めロックの救済に使う。
  const [grantedPeriods, setGrantedPeriods] = useState<Set<string>>(new Set());
  useEffect(() => {
    supabase.from('overtime_submission_grants').select('pay_period_start').eq('user_id', user.id).is('revoked_at', null)
      .then(({ data }) => setGrantedPeriods(new Set((data ?? []).map((g: { pay_period_start: string }) => g.pay_period_start))), () => {});
  }, [user.id]);

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
      furikaeOriginDate, furikaeOriginLocation, furikaeOriginStart, furikaeOriginEnd,
    } satisfies FormDraft);
  }, [editTarget, mode, date, segments, breakManual, breakManualMin, reason, location, locationCustom, reviewerId, normOverride, normStart, normEnd, fullDay, fullDayType, furikaeOriginDate, furikaeOriginLocation, furikaeOriginStart, furikaeOriginEnd]);

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
  // 理由の文例は「いま検知している種別」に合わせて出す（残業前提の固定文だと早退・遅刻等で使えないため）。
  // 複数該当時は 早退/遅刻 ＞ 残業/早出/休日出勤 ＞ 勤務地変更 の順で選ぶ。
  const reasonExamples = useMemo<string[]>(() => {
    if (fullDay) {
      if (fullDayType === 'chosei_off') return ['〇〇イベント準備により時間外労働が発生したため', '勤務時間調整のため'];
      if (fullDayType === 'furikae_off') return ['休日出勤の振替のため'];
      if (fullDayType === 'absence') return ['体調不良のため', '私用のため'];
      return ['勤務時間調整のため', '体調不良のため'];
    }
    const byType: Partial<Record<OvertimeType, string[]>> = {
      early_leave: ['体調不良のため', '通院のため'],
      tardiness: ['電車遅延のため', '私用のため'],
      early_end_adj: ['勤務時間調整のため', '残業が多いため時間調整'],
      late_start_adj: ['勤務時間調整のため', '残業が多いため時間調整'],
      holiday_work: ['イベント対応のため', '試合対応のため'],
      overtime: ['保護者対応のため', '翌日のレッスン準備のため'],
      early_start: ['朝のレッスン準備のため', '保護者対応のため'],
      location_change: ['〇〇校の応援のため', 'レッスン応援要請のため'],
    };
    const order: OvertimeType[] = ['early_leave', 'tardiness', 'early_end_adj', 'late_start_adj', 'holiday_work', 'overtime', 'early_start', 'location_change'];
    const hit = order.find(t => applicationTypes.includes(t));
    return (hit && byType[hit]) || ['保護者対応のため', '翌日のレッスン準備のため'];
  }, [fullDay, fullDayType, applicationTypes]);

  const fullDayMode = fullDay && !!fullDayType;

  // 振替元の勤務時間（自動休憩・労働）。振替休日の差分＝振替元労働−対象日（休む日）の通常シフト労働。
  const furikaeOriginSegs: WorkSegment[] = useMemo(() => {
    const st = timeToMin(furikaeOriginStart);
    let en = timeToMin(furikaeOriginEnd);
    if (st == null || en == null) return [];
    if (en <= st) en += 1440;
    return [{ startMin: st, endMin: en }];
  }, [furikaeOriginStart, furikaeOriginEnd]);
  const furikaeOriginBreak = useMemo(() => calcTotalBreak(furikaeOriginSegs), [furikaeOriginSegs]);
  const furikaeOriginLabor = useMemo(() => (furikaeOriginSegs.length ? calcLaborMinutes(furikaeOriginSegs, furikaeOriginBreak) : 0), [furikaeOriginSegs, furikaeOriginBreak]);
  const furikaeHasTime = furikaeOriginSegs.length > 0;

  // 終日の合計時間数への効き（差分）。
  //  時間外調整休 = −対象日の通常シフト労働／振替休日 = 振替元労働 − 対象日の通常シフト労働（自己完結）／欠勤 = 0
  const fdDiffMin =
    fullDayType === 'chosei_off' ? -normalShift.labor_minutes
    : fullDayType === 'furikae_off' ? (furikaeOriginLabor - normalShift.labor_minutes)
    : 0;
  // 終日の勤務地はシフトの校を自動使用（シフトに校が無い日だけ手動選択）
  const fdLocation = normalShift.location ?? effectiveLocation;
  // 振替元の日付が過去（すでに出勤済み）＝事後の振替（ブロックせず注意表示）
  const furikaeIsPostHoc = fullDayType === 'furikae_off' && !!furikaeOriginDate && furikaeOriginDate < todayJstStr();

  // 締めロック：新規申請のみ。対象日の給与期間が締め（支給月17日）を過ぎ、経理の許可窓が無いとき送信不可。
  const targetPeriodStart = date ? calcPayPeriodStartJst(date) : '';
  const closeLockedRaw = !editTarget && !!date && isPayPeriodClosed(date, todayJstStr());
  const hasGrantForTarget = targetPeriodStart ? grantedPeriods.has(targetPeriodStart) : false;
  const closeLocked = closeLockedRaw && !hasGrantForTarget;

  // 振替元の勤務日を選ぶと、その日のシフト（曜日パターン）から勤務校＋勤務時刻を自動取得（間違っていれば手修正）
  const furikaeFilledRef = useRef<string>(editTarget?.furikae_origin_date ?? '');
  useEffect(() => {
    if (!furikaeOriginDate) return;
    if (furikaeFilledRef.current === furikaeOriginDate) return;
    furikaeFilledRef.current = furikaeOriginDate;
    const ns = resolveNormalShift(patterns, furikaeOriginDate, null);
    setFurikaeOriginLocation(ns.location ?? '');
    // 振替元がシフト上「出勤日」なら初期値としてその時刻を入れる（休みの日＝時刻なしなら空のまま本人が入力）
    if (ns.start_time && ns.end_time) {
      setFurikaeOriginStart(fmtTime(ns.start_time));
      setFurikaeOriginEnd(fmtTime(ns.end_time));
    }
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

  // ── 実績報告フェーズの「予定→実績」差分検知（案A）──
  // editTarget は update 前なので本体値＝予定値。planned セグメント＋本体値をベースラインにする。
  const [changeReason, setChangeReason] = useState('');
  const [showPlanDetail, setShowPlanDetail] = useState(false);
  const plannedBaseline = useMemo(() => {
    if (!isReportPhase || !editTarget) return null;
    const pseg = (editTarget.segments ?? []).filter(s => s.phase === 'planned').sort((a, b) => a.seg_no - b.seg_no).map(s => ({ s: s.start_min, e: s.end_min }));
    return { segs: pseg, breakMin: editTarget.break_minutes ?? 0, location: editTarget.location ?? '', types: [...(editTarget.application_types ?? [])].sort() };
  }, [isReportPhase, editTarget]);
  // 差分検知の基準は「開いた直後の実績入力（＝予定プリフィル）」を一度だけスナップショットする。
  // 保存値と再計算値を比べると計算差で誤検知するため、再計算値どうし（初期live vs 現在live）で比べる。
  const [diffBase, setDiffBase] = useState<{ segs: { s: number; e: number }[]; breakMin: number; location: string; types: string[] } | null>(null);
  useEffect(() => {
    if (!isReportPhase || fullDay || diffBase) return;
    setDiffBase({
      segs: [...workSegments].sort((a, b) => a.startMin - b.startMin).map(s => ({ s: s.startMin, e: s.endMin })),
      breakMin, location: effectiveLocation, types: [...applicationTypes].sort(),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReportPhase, fullDay, workSegments, breakMin, effectiveLocation, applicationTypes, diffBase]);
  const changedAxes = useMemo(() => {
    if (!diffBase || fullDay) return [] as string[];
    const live = [...workSegments].sort((a, b) => a.startMin - b.startMin).map(s => ({ s: s.startMin, e: s.endMin }));
    const base = [...diffBase.segs].sort((a, b) => a.s - b.s);
    const ax: string[] = [];
    if (live.length !== base.length || live.some((x, i) => x.s !== base[i].s || x.e !== base[i].e)) ax.push('時間帯');
    if (breakMin !== diffBase.breakMin) ax.push('休憩');
    if (effectiveLocation !== diffBase.location) ax.push('勤務地');
    if (JSON.stringify([...applicationTypes].sort()) !== JSON.stringify(diffBase.types)) ax.push('種別');
    return ax;
  }, [diffBase, fullDay, workSegments, breakMin, effectiveLocation, applicationTypes]);
  const hasChanges = changedAxes.length > 0;
  // 残業なし（実際は通常どおり）＝労働が通常シフトと同じ・種別なし。差分0は承認者確認をスキップ（自己確定）。
  const isPureZero = isReportPhase && !fullDay && diffMin === 0 && applicationTypes.length === 0;
  // 「残業なし（通常どおり）」ワンタップ：時間帯を通常シフトに、勤務地を通常校に、休憩自動・種別なしにリセット。
  const applyNoOvertime = () => {
    setSegments(normalSegs.length > 0 ? normalSegs.map(s => ({ ...s })) : [{ ...EMPTY_SEG }]);
    setBreakManual(false);
    if (normalShift.location) { setLocation(normalShift.location); setLocMoveStart(''); setLocMoveEnd(''); setLocationCustom(''); }
    setLateChoice(null); setEarlyChoice(null);
  };

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
    if (closeLocked) return `この対象日は【${payMonthPeriodLabel(targetPeriodStart)}】の申請です。締め切り（${payPeriodCloseCutoff(targetPeriodStart).replace(/-/g, '/')}）を過ぎているため申請できません。経理に申請の許可を依頼してください。`;
    // 終日（調整休・欠勤）は時刻・休憩・勤務地の検証をスキップし、専用の検証のみ行う
    if (fullDay) {
      if (!normalShift.start_time) return 'この日はシフトが休みです。出勤予定日のみ登録できます';
      if (!fullDayType) return '種別（時間外調整休・振替休日・欠勤）を選択してください';
      if (!fdLocation) return '勤務地を選択してください';
      if (fullDayType === 'furikae_off') {
        if (!furikaeOriginDate) return '振替元の勤務日を選択してください';
        if (!furikaeOriginLocation) return '振替元の勤務校を選択してください';
        if (!furikaeOriginStart || !furikaeOriginEnd) return '振替元の出勤・退勤の時刻を入力してください';
        if (!furikaeHasTime) return '振替元の時刻が正しくありません（開始・終了を確認してください）';
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
    // 通常シフトと全く同じ内容（時間帯・休憩・勤務地に変更なし）では送信不可。
    // ※実績報告は除外＝「事前申請では残業予定だったが実際は通常どおりだった（残業ゼロ）」も正当に報告できるようにする。
    if (!isReportPhase) {
      const sameSegs = segments.length === normalSegs.length
        && segments.every((s, i) => s.start === normalSegs[i].start && s.end === normalSegs[i].end);
      if (sameSegs && !breakManual && effectiveLocation === (normalShift.location ?? '')) {
        return '通常シフトと同じ内容です。残業・早退・調整など、変更した点を入力してください';
      }
    }
    // 実績報告で予定から変わっている場合は変更理由が必須（ただし「残業なし＝通常どおり」は理由不要）
    if (isReportPhase && !fullDay && hasChanges && !isPureZero && !changeReason.trim()) {
      return '予定から変わった理由を入力してください';
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
            ? ((isSelfReview || isPureZero) ? 'confirmed' : 'reported')
            : (isSelfReview ? 'request_confirmed' : 'requested'))) as OvertimeStatus,
        normal_shift: normalShift,
        break_minutes: fullDayMode ? 0 : breakMin,
        break_manual: fullDayMode ? false : breakManual,
        labor_minutes: fullDayMode ? 0 : laborMin,
        diff_minutes: fullDayMode ? fdDiffMin : diffMin,
        legal_warning: fullDayMode ? false : !legal.ok,
        reason: reason.trim(),
        // 予定から変わった理由（実績報告で変更ありのときだけ・承認者/履歴で表示）。予定どおり・残業なし・新規はnullで上書き
        change_reason: (isReportPhase && hasChanges && !isPureZero) ? changeReason.trim() : null,
        location: fullDayMode ? fdLocation : effectiveLocation,
        application_types: applicationTypes,
        // 振替休日のみ振替元（日付・校・出退勤時刻・休憩・労働）を保存（他種別ではnullで上書き＝再提出で種別が変わった場合の掃除）
        furikae_origin_date: (fullDayMode && fullDayType === 'furikae_off') ? furikaeOriginDate : null,
        furikae_origin_location: (fullDayMode && fullDayType === 'furikae_off') ? furikaeOriginLocation : null,
        furikae_origin_start: (fullDayMode && fullDayType === 'furikae_off' && furikaeHasTime) ? furikaeOriginStart : null,
        furikae_origin_end: (fullDayMode && fullDayType === 'furikae_off' && furikaeHasTime) ? furikaeOriginEnd : null,
        furikae_origin_break_minutes: (fullDayMode && fullDayType === 'furikae_off' && furikaeHasTime) ? furikaeOriginBreak : null,
        furikae_origin_labor_minutes: (fullDayMode && fullDayType === 'furikae_off' && furikaeHasTime) ? furikaeOriginLabor : null,
        reviewer_id: isSelfReview ? user.id : reviewerId,
        ...((isSelfReview || isPureZero) ? { confirmed_by: user.id, confirmed_at: new Date().toISOString() } : {}),
        ...(isResubmit ? { return_comment: null } : {}),
      };

      // DBトリガー由来のエラーを分かりやすい日本語に変換（締めロック・振替の二重計上防止）
      const friendlyDbError = (msg: string, code?: string): string => {
        if (msg.includes('OVERTIME_CLOSED')) return 'この対象日の給与期間は締め切りを過ぎています。経理に申請の許可を依頼してください。';
        if (msg.includes('FURIKAE_DUP_ORIGIN')) return '振替元の日には別の申請があります。振替休日は振替元の勤務時間を含むため、その日を別途「休日出勤」等で申請しないでください。';
        if (msg.includes('FURIKAE_DUP_WORKDATE')) return 'この日は振替休日の振替元として申請済みです。二重計上になるため、この日は別途申請できません。';
        if (code === '23505') return '同じ日付の申請がすでにあります（取消済みを除く）';
        return '保存に失敗しました: ' + msg;
      };

      let reportId: string;
      if (editTarget) {
        // 修正履歴を残してから更新
        await supabase.from('overtime_report_history').insert({
          report_id: editTarget.id,
          changed_by: user.id,
          change_summary: isReportPhase ? (isPureZero ? '残業なし（通常どおり）で報告' : hasChanges ? `実績報告（変更あり：${changedAxes.join('・')}）` : '実績報告（予定どおり）') : '再提出',
          change_reason: (isReportPhase && hasChanges) ? changeReason.trim() : null,
          snapshot: editTarget as unknown as Record<string, unknown>,
        }).then(null, () => {});
        const { error: err } = await supabase.from('overtime_reports').update(record).eq('id', editTarget.id);
        if (err) { setError(friendlyDbError(err.message, err.code)); setSaving(false); setShowConfirm(false); return; }
        reportId = editTarget.id;
        // 対象phaseの時間帯を入れ替え
        await supabase.from('overtime_report_segments').delete().eq('report_id', reportId).eq('phase', phase);
      } else {
        const { data: inserted, error: err } = await supabase.from('overtime_reports')
          .insert({ applicant_id: user.id, submitted_by: user.id, entry_type: 'manual', ...record })
          .select('id').single();
        if (err) {
          setError(friendlyDbError(err.message, err.code));
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

      // 通知（管理画面「通知設定」の overtime:new_request に従う）
      // isPureZero（残業なし＝差分0の実績報告）は自己確定するため確認者のキューに入らない。
      // 通知すると「押しても該当申請が無い」空振りになるので送らない。
      if (!isSelfReview && !isPureZero && reviewerId) {
        notifyOvertimeNewRequest({
          reportId,
          reviewerId,
          applicantName: profileName ?? '',
          phaseLabel: phase === 'actual' ? '実績報告' : '事前申請',
          dateLabel: `${date}（${dowLabel(date)}）`,
          timeLabel: formatSignedMin(diffMin),
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

      {/* 事前申請の内容（受理済み・変更不可）。実績報告フェーズのみ折りたたみ表示 */}
      {isReportPhase && !fullDay && plannedBaseline && (
        <div style={{ background: innerBg, borderRadius: 10, padding: '10px 12px', marginBottom: 12, border: `1px solid ${borderColor}` }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, fontWeight: 'bold', color: subText }}>📋 事前申請の内容（受理済み・変更できません）</span>
            <button type="button" onClick={() => setShowPlanDetail(v => !v)} style={{ background: 'none', border: 'none', color: subText, cursor: 'pointer', fontSize: 12, whiteSpace: 'nowrap' }}>詳細 {showPlanDetail ? '▲' : '▼'}</button>
          </div>
          <div style={{ fontSize: 12.5, color: text, marginTop: 6, lineHeight: 1.6 }}>
            {editTarget.work_date.slice(5).replace('-', '/')}（{dowLabel(editTarget.work_date)}）｜予定 {segmentsLabel((editTarget.segments ?? []).filter(s => s.phase === 'planned'))}{plannedBaseline.location ? `［${plannedBaseline.location}］` : ''}
          </div>
          <div style={{ marginTop: 4 }}><TypeChips types={editTarget.application_types} isDark={isDark} /></div>
          {showPlanDetail && (
            <div style={{ fontSize: 12, color: subText, marginTop: 6, lineHeight: 1.7, borderTop: `1px solid ${borderColor}`, paddingTop: 6 }}>
              休憩 {plannedBaseline.breakMin}分　労働 {Math.floor((editTarget.labor_minutes ?? 0) / 60)}時間{(editTarget.labor_minutes ?? 0) % 60}分<br />
              {editTarget.reason && <>理由：{editTarget.reason}</>}
            </div>
          )}
        </div>
      )}

      {/* 残業なし（通常どおり）ワンタップ。押すと時間帯を通常シフトに戻す＝残業ゼロで報告できる */}
      {isReportPhase && !fullDay && !isPureZero && (
        <button type="button" onClick={applyNoOvertime}
          style={{ width: '100%', padding: '12px', marginBottom: 12, borderRadius: 10, border: '1.5px solid #64b5f6', background: '#e3f2fd', color: '#1565c0', fontSize: 13.5, fontWeight: 'bold', cursor: 'pointer' }}>
          🚫 残業なし（通常どおりにする）
        </button>
      )}
      {isReportPhase && !fullDay && isPureZero && (
        <div style={{ marginBottom: 12, padding: '9px 12px', borderRadius: 8, background: isDark ? '#1b3a1e' : '#eaf6ec', border: `1px solid ${isDark ? '#2d5a2d' : '#c3e6cb'}`, fontSize: 12.5, color: isDark ? '#8fd19e' : '#1e7e34', textAlign: 'center', lineHeight: 1.6 }}>
          ✓ 残業なし（通常どおり）で報告します。承認者の確認は不要です。
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
            <li>事前申請が受理されると、「履歴・実績報告」タブのその日のカードに「実績を報告する」ボタンが表示されます。業務のあと、変更がなければそのまま送信（内容は入力済みです）、時間が変わった場合は直してから送信してください。</li>
            <li>休憩は自動計算されます。突発的な残業などで自動計算どおりに取れなかった場合は、休憩の「修正」から実際の時間に直してください（休憩後は1分以上業務をしてから退勤してください）。</li>
            <li>時間は1分単位で入力できます。外出・戻りのあるシフトは「＋時間帯を追加」で入力してください。</li>
            <li>正社員の方は、残業分を別日で調整（時間調整・調整休）していただくようお願いします。</li>
            <li>調整休・欠勤（終日）は受理された時点で完了します（実績報告は不要です）。</li>
            <li>新規の申請は、支給月の17日までに提出してください。それ以降は前の給与期間の新規申請ができません（締め後に申請したい場合は経理にご相談ください）。</li>
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
                  flex: 1, padding: '10px 0', borderRadius: 10, cursor: 'pointer', fontSize: 13.5, fontWeight: 'bold',
                  border: mode === m ? '2px solid #1565c0' : '2px solid #90caf9',
                  background: mode === m ? '#1976d2' : '#e3f2fd',
                  color: mode === m ? '#fff' : '#1565c0',
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

      {/* 締めロック予告：締め切りを過ぎた期の新規申請は送信できない（送信前に気づけるよう日付選択時に表示） */}
      {closeLocked && (
        <div style={{ background: '#f8d7da', border: '1px solid #f5c2c7', borderRadius: 10, padding: '10px 12px', marginBottom: 14 }}>
          <p style={{ margin: 0, fontSize: 12.5, fontWeight: 'bold', color: '#842029' }}>
            🔒 この対象日は【{payMonthPeriodLabel(targetPeriodStart)}】の申請です
          </p>
          <p style={{ margin: '4px 0 0', fontSize: 12, color: '#842029', lineHeight: 1.6 }}>
            締め切り（{payPeriodCloseCutoff(targetPeriodStart).replace(/-/g, '/')}）を過ぎているため申請できません。この期の申請が必要な場合は、経理に申請の許可を依頼してください。
          </p>
        </div>
      )}
      {/* 経理から締め後申請を許可された期の案内 */}
      {!editTarget && date && closeLockedRaw && hasGrantForTarget && (
        <div style={{ background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 10, padding: '10px 12px', marginBottom: 14 }}>
          <p style={{ margin: 0, fontSize: 12.5, color: '#166534', lineHeight: 1.6 }}>
            ✓ 経理から【{payMonthPeriodLabel(targetPeriodStart)}】の締め後申請が許可されています。この期の申請ができます。
          </p>
        </div>
      )}

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
                fontWeight: 'bold',
                border: `2px solid ${text}`,
                background: 'transparent',
                color: text,
              }}>
              {fullDay ? '✓ 調整休・欠勤（終日）で申請中 ─ 押すと時間の申請に戻ります' : '🌙 調整休・欠勤（終日）の場合はこちらを押す'}
            </button>
          )}
          {fullDayError && (
            <div style={{ background: '#f8d7da', border: '1px solid #f5c2c7', borderRadius: 8, padding: '8px 12px', marginTop: 6 }}>
              <p style={{ margin: 0, fontSize: 13, color: '#842029' }}>{fullDayError}</p>
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
                      border: fullDayType === v ? '2px solid #1565c0' : '2px solid #90caf9',
                      background: fullDayType === v ? '#1976d2' : '#e3f2fd',
                    }}>
                    <span style={{ display: 'block', fontSize: 13.5, fontWeight: 'bold', color: fullDayType === v ? '#fff' : '#1565c0' }}>{label}</span>
                    <span style={{ display: 'block', fontSize: 11.5, color: fullDayType === v ? '#e3f2fd' : '#1976d2', marginTop: 2 }}>{desc}</span>
                  </button>
                ))}
              </div>

              {/* この申請が合計時間数にどう効くか（本人が一番不安な点を1行で明示） */}
              {fullDayType && (
                <div style={{ background: isDark ? '#1b3a1e' : '#d1e7dd', border: '1px solid #28a745', borderRadius: 8, padding: '8px 12px', marginTop: 8 }}>
                  <p style={{ margin: 0, fontSize: 12.5, color: isDark ? '#8fd19e' : '#0f5132' }}>
                    {fullDayType === 'chosei_off' && `シフト労働分 ${formatSignedMin(-normalShift.labor_minutes)} を合計時間数から差し引きます`}
                    {fullDayType === 'furikae_off' && (furikaeHasTime
                      ? `振替元の労働 ${formatMin(furikaeOriginLabor)} − 休む日の労働 ${formatMin(normalShift.labor_minutes)} ＝ 合計時間数 ${formatSignedMin(fdDiffMin)}`
                      : '下で振替元の出勤時刻を入れると、合計時間数への反映（差分）が計算されます')}
                    {fullDayType === 'absence' && '欠勤1日として記録します'}
                  </p>
                </div>
              )}

              {/* 振替休日：① 振替元（実際に出勤した日・校・出退勤時刻）／② 休む日（対象日）。差分を自己完結で計算 */}
              {fullDayType === 'furikae_off' && (
                <div style={{ marginTop: 12, border: `1px solid ${borderColor}`, borderRadius: 10, padding: '12px 12px 14px' }}>
                  <p style={{ margin: '0 0 8px', fontSize: 12.5, fontWeight: 'bold', color: text }}>① 実際に出勤した日（振替元）</p>
                  {/* 二重計上防止の案内（入力欄のすぐ上に常設） */}
                  <div style={{ background: '#fff3cd', border: '1px solid #ffe0a3', borderRadius: 8, padding: '7px 10px', marginBottom: 10 }}>
                    <p style={{ margin: 0, fontSize: 11.5, color: '#856404', lineHeight: 1.6 }}>
                      ※ 出勤した日（振替元）は、ここに時刻を入れて記録します。<b>別途「休日出勤」として申請しないでください</b>（二重計上になります）。
                    </p>
                  </div>
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
                  {/* 振替元の出退勤時刻（自動休憩） */}
                  <div style={{ marginTop: 10 }}>
                    <span style={{ ...labelStyle, marginBottom: 4 }}>振替元の勤務時間{req}
                      <span style={{ fontSize: 11, fontWeight: 'normal', color: subText }}>（出勤〜退勤）</span>
                    </span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <input type="time" value={furikaeOriginStart} onChange={e => setFurikaeOriginStart(e.target.value)} style={{ ...inputStyle, flex: 1, minWidth: 0 }} />
                      <span style={{ color: subText }}>〜</span>
                      <input type="time" value={furikaeOriginEnd} onChange={e => setFurikaeOriginEnd(e.target.value)} style={{ ...inputStyle, flex: 1, minWidth: 0 }} />
                    </div>
                    {furikaeHasTime && (
                      <p style={{ margin: '6px 0 0', fontSize: 12, color: subText }}>
                        休憩 {formatMin(furikaeOriginBreak)}（自動）・労働 {formatMin(furikaeOriginLabor)}
                      </p>
                    )}
                  </div>
                  {/* 事後の振替（振替元が過去日）＝注意表示（ブロックはしない） */}
                  {furikaeIsPostHoc && (
                    <div style={{ background: '#fff3cd', border: '1px solid #ffe0a3', borderRadius: 8, padding: '7px 10px', marginTop: 10 }}>
                      <p style={{ margin: 0, fontSize: 11.5, color: '#856404', lineHeight: 1.6 }}>
                        振替休日は、休日に出勤する前の申請が原則です。今後は事前にお願いします。
                      </p>
                    </div>
                  )}
                  <div style={{ borderTop: `1px dashed ${borderColor}`, margin: '12px 0 8px' }} />
                  <p style={{ margin: 0, fontSize: 12.5, fontWeight: 'bold', color: text }}>
                    ② 休む日（振替休日）：{date ? `${date.slice(5).replace('-', '/')}（${dowLabel(date)}）` : '上のカレンダーで選択'}
                    {normalShift.start_time && <span style={{ fontWeight: 'normal', color: subText }}>　通常シフト労働 {formatMin(normalShift.labor_minutes)}</span>}
                  </p>
                </div>
              )}

              {/* 勤務地はシフトから自動（校が取れない日だけ下の勤務地欄で選択）。振替休日は振替元に専用の勤務校欄があるため対象外 */}
              {fullDayType !== 'furikae_off' && normalShift.location && (
                <p style={{ margin: '8px 0 0', fontSize: 12, color: subText }}>勤務地：{normalShift.location}（シフトから自動）</p>
              )}
            </div>
          )}
        </div>
      )}

      {/* 実務の勤務時間帯 */}
      {!fullDay && (
      <div style={{ marginBottom: 12 }}>
        <span style={labelStyle}>{isReportPhase ? '実際に勤務した時間' : (mode === 'advance' && !(editTarget && isResubmit && (editTarget.segments ?? []).some(s => s.phase === 'actual')) ? '予定の勤務時間' : '実務の勤務時間')}{req}</span>
        {isReportPhase && (
          <p style={{ margin: '2px 0 8px', fontSize: 11.5, color: subText, lineHeight: 1.6 }}>予定が入っています。実際と違う場合は直してください。</p>
        )}
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
          <span style={{ fontSize: 13, color: subText, display: 'block', marginBottom: 6 }}>開始が遅い理由は？{req}</span>
          <div style={{ display: 'flex', gap: 8 }}>
            {([['adj', '時間調整で遅く出勤'], ['tardiness', '寝坊・私用などで遅刻']] as const).map(([v, label]) => (
              <button key={v} type="button" onClick={() => setLateChoice(v)}
                style={{
                  flex: 1, padding: '11px 4px', borderRadius: 10, cursor: 'pointer', fontSize: 13, fontWeight: 'bold',
                  border: lateChoice === v ? '2px solid #1565c0' : '2px solid #90caf9',
                  background: lateChoice === v ? '#1976d2' : '#e3f2fd',
                  color: lateChoice === v ? '#fff' : '#1565c0',
                }}>
                {label}
              </button>
            ))}
          </div>
        </div>
      )}
      {!fullDay && hasInput && typeDetect.earlyQ && (
        <div style={{ marginBottom: 12 }}>
          <span style={{ fontSize: 13, color: subText, display: 'block', marginBottom: 6 }}>早く終わる理由は？{req}</span>
          <div style={{ display: 'flex', gap: 8 }}>
            {([['adj', '時間調整で早退'], ['early_leave', '体調・私用などで早退']] as const).map(([v, label]) => (
              <button key={v} type="button" onClick={() => setEarlyChoice(v)}
                style={{
                  flex: 1, padding: '11px 4px', borderRadius: 10, cursor: 'pointer', fontSize: 13, fontWeight: 'bold',
                  border: earlyChoice === v ? '2px solid #1565c0' : '2px solid #90caf9',
                  background: earlyChoice === v ? '#1976d2' : '#e3f2fd',
                  color: earlyChoice === v ? '#fff' : '#1565c0',
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

      {/* 勤務地。実績報告フェーズは事前申請どおりで固定（読み取り専用） */}
      {isReportPhase && !fullDay && (
        <div style={{ marginBottom: 12 }}>
          <span style={labelStyle}>勤務地</span>
          <div style={{ ...fieldStyle, background: innerBg, color: text, display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 22 }}>{effectiveLocation || '—'}</div>
        </div>
      )}
      {/* 勤務地（勤務変更報告と同様に自由入力あり）。終日でシフトに校がある日は自動使用のため非表示 */}
      {!(fullDay && normalShift.location) && !isReportPhase && (
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
        <span style={labelStyle}>理由{isReportPhase ? '' : req}</span>
        {isReportPhase && !fullDay ? (
          <div style={{ ...fieldStyle, background: innerBg, color: text, minHeight: 22, whiteSpace: 'pre-wrap', textAlign: 'center' }}>{reason || '—'}</div>
        ) : (<>
        <textarea value={reason} onChange={e => setReason(e.target.value)} rows={2}
          placeholder={`例：${reasonExamples[0]}`}
          style={{ ...fieldStyle, resize: 'vertical' }} />
        {/* 文例ボタン（種別に応じて中身が変わる） */}
        <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
          {reasonExamples.map(ex => (
            <button key={ex} type="button" onClick={() => setReason(ex)}
              style={{ padding: '5px 12px', borderRadius: 6, border: `1px solid ${isDark ? '#3d5166' : '#90caf9'}`, background: isDark ? '#2c3e50' : '#e8f4fd', color: isDark ? '#fff' : '#1565c0', fontSize: 11.5, fontWeight: 'bold', cursor: 'pointer' }}>
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
        </>)}
      </div>

      {/* 予定から変わった理由（実績報告フェーズで差分がある時だけ必須。残業なし＝通常どおりは理由不要） */}
      {isReportPhase && !fullDay && hasChanges && !isPureZero && (
        <div style={{ marginBottom: 12, background: isDark ? '#3a2c12' : '#fff8e1', border: `1px solid ${isDark ? '#7a5a1e' : '#ffe0a3'}`, borderRadius: 8, padding: '10px 12px' }}>
          <div style={{ fontSize: 12, fontWeight: 'bold', color: isDark ? '#ffcf87' : '#8a6d1a', marginBottom: 6 }}>
            予定から変わっています（{changedAxes.join('・')}）
          </div>
          <span style={{ ...labelStyle, color: isDark ? '#ffcf87' : '#8a6d1a' }}>予定から変わった理由 <span style={{ color: '#dc3545' }}>*必須</span></span>
          <textarea value={changeReason} onChange={e => setChangeReason(e.target.value)} rows={2}
            placeholder="例：お客様対応が長引いたため"
            style={{ ...fieldStyle, resize: 'vertical' }} />
        </div>
      )}

      {/* 申請先 */}
      <div style={{ marginBottom: 16 }}>
        <span style={labelStyle}>申請先{isReportPhase ? '' : req}</span>
        {isReportPhase && !fullDay ? (
          <div style={{ ...fieldStyle, background: innerBg, color: text, minHeight: 22, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            {reviewerId === SELF_REVIEW_VALUE ? '自己受理（自分で確認）' : (editTarget?.reviewer?.name ?? reviewers.find(rv => rv.id === reviewerId)?.name ?? '')}
          </div>
        ) : (
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
        )}
        {fullDay && fullDayType === 'absence' && (
          <p style={{ margin: '6px 0 0', fontSize: 12, color: subText }}>欠勤はマネージャー以上の受理が必要です（自己受理はできません）</p>
        )}
      </div>

      {error && (
        <div style={{ background: '#f8d7da', border: '1px solid #f5c2c7', borderRadius: 8, padding: '8px 12px', marginBottom: 12 }}>
          <p style={{ margin: 0, fontSize: 13, color: '#842029' }}>{error}</p>
        </div>
      )}

      {/* 送信（インライン確認） */}
      {!showConfirm ? (
        <button onClick={handleSubmit} disabled={saving}
          style={{ width: '100%', padding: '12px 0', borderRadius: 10, border: 'none', cursor: 'pointer', fontSize: 15, fontWeight: 'bold', background: '#28a745', color: '#fff' }}>
          {isReportPhase ? (isPureZero ? '残業なしで報告する（確定）' : hasChanges ? '実績を報告する（変更あり）' : '実績を報告する（予定どおり）') : isResubmit ? '再提出する' : mode === 'advance' ? '事前申請する' : '報告する'}
        </button>
      ) : (
        <div style={{ background: innerBg, borderRadius: 10, padding: '12px 14px' }}>
          <p style={{ margin: '0 0 6px', fontSize: 13.5, fontWeight: 'bold', color: text }}>この内容で送信しますか？</p>
          {fullDayMode ? (
            <p style={{ margin: '0 0 6px', fontSize: 12.5, color: subText, lineHeight: 1.7 }}>
              {date}（{dowLabel(date)}）　終日：{fullDayType ? OT_TYPE_INFO[fullDayType].label : ''}<br />
              {fullDayType === 'furikae_off' && furikaeOriginDate && <>振替元：{furikaeOriginDate.slice(5).replace('-', '/')}（{dowLabel(furikaeOriginDate)}）{furikaeOriginLocation && `・${furikaeOriginLocation}`}{furikaeHasTime && `・${furikaeOriginStart}〜${furikaeOriginEnd}（労働${formatMin(furikaeOriginLabor)}）`}<br /></>}
              {fullDayType === 'chosei_off' && <>シフト労働分 {formatSignedMin(fdDiffMin)} を合計時間数から差し引きます<br /></>}
              {fullDayType === 'furikae_off' && <>振替元の労働 {formatMin(furikaeOriginLabor)} − 休む日の労働 {formatMin(normalShift.labor_minutes)} ＝ 合計時間数 {formatSignedMin(fdDiffMin)}<br /></>}
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
  // 送信完了バナーは数秒で自動消去（アプリ標準の成功フィードバックに合わせる）
  useEffect(() => {
    if (!savedBanner) return;
    const t = setTimeout(() => setSavedBanner(false), 4000);
    return () => clearTimeout(t);
  }, [savedBanner]);
  const [cancelTargetId, setCancelTargetId] = useState<string | null>(null);
  const [historyMode, setHistoryMode] = useState<'own' | 'summary'>(searchParams.get('staff') ? 'summary' : 'own');
  const [canSummary, setCanSummary] = useState(false);
  const [canShiftDirectory, setCanShiftDirectory] = useState(false); // 全員のシフト予定ページへの導線表示
  const navigate = useNavigate();

  // 集計モード用
  const [summaryPeriod, setSummaryPeriod] = useState(() => calcPayPeriodStartJst(todayJstStr()));
  const [summaryRows, setSummaryRows] = useState<SummaryRow[]>([]);
  const [myGroups, setMyGroups] = useState<string[]>([]);           // 閲覧者自身の部門（初期スコープ用）
  const [summaryDept, setSummaryDept] = useState('');               // 部門(チーム)フィルタ。''=自所属を初期選択 / '__all__'=全チーム
  const [summaryNameQuery, setSummaryNameQuery] = useState('');      // 名前検索
  const [summaryFilterOpen, setSummaryFilterOpen] = useState(false); // 「絞り込み」折りたたみ
  // 個人詳細で選択中の対象者。?staff= を単一の真実として派生させる（別stateにしない）。
  // これによりブラウザ/スマホの「戻る」でURLから staff が消えたとき、自動的に一覧表示へ戻る。
  const selectedStaffId = searchParams.get('staff');

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
      const [, , revRes, wpRes, patRes, permRes, myProfRes, dirRes] = await Promise.all([
        fetchOwn(),
        fetchPendingForMe(),
        supabase.from('profiles').select('id, name, role_title').in('role_title', REVIEWER_ROLES).eq('is_active', true).order('role_title').order('name'),
        supabase.from('master_options').select('value').eq('category', 'workplace').order('sort_order'),
        supabase.from('weekly_shift_patterns').select('*').eq('user_id', user.id),
        supabase.rpc('has_feature_permission', { p_feature: 'overtime_summary' }),
        supabase.from('profiles').select('group_names').eq('id', user.id).maybeSingle(),
        supabase.rpc('has_feature_permission', { p_feature: 'shift_pattern_directory' }),
      ]);
      setReviewers((revRes.data as Reviewer[] | null) ?? []);
      setWorkplaces(((wpRes.data as { value: string }[] | null) ?? []).map(w => w.value));
      setPatterns((patRes.data as PatternRow[] | null) ?? []);
      setCanSummary(isAdmin || permRes.data === true);
      setCanShiftDirectory(isAdmin || dirRes.data === true);
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
      // 名簿は overtime_visible_roster() RPC で取得（役職階層フィルタと役職解決を DB に一本化）。
      // 「自分と同格・下位のみ」が DB 側で適用されるため、上位者は名簿からも消える（RLSと判定がズレない）。
      const [rosterRes, rowProfRes] = await Promise.all([
        supabase.rpc('overtime_visible_roster'),
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
    setSearchParams(prev => { const n = new URLSearchParams(prev); n.set('staff', id); return n; });
    window.scrollTo({ top: 0 });
  }, [setSearchParams]);
  const clearSelectedStaff = useCallback(() => {
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

  // 取消して、その内容を下書きにコピー→新規フォームを開く（間違えて出した申請を作り直す動線）
  const cancelAndCopy = async (r: OvertimeReport) => {
    setActingId(r.id);
    setActionError('');
    const res = await callApproveFunction(r.id, 'cancel');
    if (!res.ok) { setActionError('取消に失敗しました：' + (res.error ?? '')); setActingId(null); return; }
    const segPhase = (r.segments ?? []).some(s => s.phase === 'actual') ? 'actual' : 'planned';
    const segs = (r.segments ?? []).filter(s => s.phase === segPhase).sort((a, b) => a.seg_no - b.seg_no);
    const draftCopy: FormDraft = {
      mode: r.is_post_hoc ? 'posthoc' : 'advance',
      date: r.work_date,
      segments: segs.length > 0 ? segs.map(s => ({ start: toTimeInputValue(s.start_min), end: toTimeInputValue(s.end_min) })) : [{ start: '', end: '' }],
      breakManual: r.break_manual ?? false,
      breakManualMin: (r.break_manual && r.break_minutes != null) ? String(r.break_minutes) : '',
      reason: r.reason ?? '',
      location: (r.location && !r.location.includes('→')) ? r.location : '',
      locationCustom: '',
      reviewerId: (r.reviewer_id && r.reviewer_id !== user.id) ? r.reviewer_id : '',
      normOverride: r.normal_shift?.manual_override ?? false,
      normStart: r.normal_shift?.start_time ? fmtTime(r.normal_shift.start_time) : '',
      normEnd: r.normal_shift?.end_time ? fmtTime(r.normal_shift.end_time) : '',
    };
    saveDraft(DRAFT_KEYS.overtime, draftCopy);
    setCancelTargetId(null);
    setActingId(null);
    setEditTarget(null);
    setTab('form');
    window.scrollTo({ top: 0 });
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
  const otTodayStr = todayJstStr();
  const ownHistoryAll = reports.filter(r => r.entry_type === 'manual' || r.entry_type === 'leave_auto');
  // 本人の履歴は「前期＋今期」まで常に表示（それより古い期は非表示）。管理者は全件。給与明細照合のため直近1期は残す。
  const [curPY, curPM] = currentPeriod.split('-').map(Number);
  const prevPeriodStart = `${curPM === 1 ? curPY - 1 : curPY}-${String(curPM === 1 ? 12 : curPM - 1).padStart(2, '0')}-16`;
  const ownHistory = isAdmin ? ownHistoryAll : ownHistoryAll.filter(r => !r.pay_period_start || r.pay_period_start >= prevPeriodStart);
  // 「あなたの対応待ち」（要報告＝受理済み・勤務日超過・終日以外／差し戻し）を上にピン留め。残りは記入順のまま。
  const isOtActionRow = (r: OvertimeReport) =>
    r.status === 'returned' ||
    (r.status === 'request_confirmed' && r.work_date < otTodayStr && !isFullDayReport(r.application_types));
  const ownActionRows = ownHistory.filter(isOtActionRow);
  const ownRestRows = ownHistory.filter(r => !isOtActionRow(r));
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
  // 残業調整 提案の回答/閲覧ビュー（?proposal=<id>）
  // ────────────────────────────────────────────
  const proposalIdParam = searchParams.get('proposal');
  if (proposalIdParam) {
    return (
      <div style={{ maxWidth: 600, margin: '0 auto', padding: '16px 16px 40px' }}>
        <OvertimeProposalResponse
          proposalId={proposalIdParam}
          currentUserId={user.id}
          isDark={isDark}
          onClose={() => setSearchParams(prev => { const n = new URLSearchParams(prev); n.delete('proposal'); return n; })}
        />
      </div>
    );
  }

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
            <div style={{ background: '#f8d7da', border: '1px solid #f5c2c7', borderRadius: 10, padding: '10px 12px', marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
              <p style={{ margin: 0, fontSize: 13, color: '#842029' }}>{loadError}</p>
              <button onClick={() => { fetchOwn(); fetchPendingForMe(); }}
                style={{ flexShrink: 0, padding: '6px 12px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 'bold', background: '#dc3545', color: '#fff' }}>再読み込み</button>
            </div>
          )}
          {actionError && (
            <div style={{ background: '#f8d7da', border: '1px solid #f5c2c7', borderRadius: 10, padding: '10px 12px', marginBottom: 12 }}>
              <p style={{ margin: 0, fontSize: 13, color: '#842029' }}>{actionError}</p>
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

                {r.change_reason && (
                  <div style={{ background: isDark ? '#3a2c12' : '#fff8e1', border: `1px solid ${isDark ? '#7a5a1e' : '#ffe0a3'}`, borderRadius: 8, padding: '8px 10px', marginBottom: 8 }}>
                    <p style={{ margin: 0, fontSize: 12.5, color: isDark ? '#ffcf87' : '#8a6d1a', lineHeight: 1.7 }}>
                      <b>予定から変わった理由：</b>{r.change_reason}
                    </p>
                  </div>
                )}

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
        <h2 style={{ textAlign: 'center', margin: '12px 0 16px', fontSize: 20, fontWeight: 'bold', color: isDark ? '#fff' : '#333' }}>🕐 残業・時間管理</h2>

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
          <div style={{ background: '#f8d7da', border: '1px solid #f5c2c7', borderRadius: 10, padding: '10px 12px', marginBottom: 14, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <p style={{ margin: 0, fontSize: 13, color: '#842029' }}>{loadError}</p>
            <button onClick={() => { fetchOwn(); fetchPendingForMe(); }}
              style={{ flexShrink: 0, padding: '6px 12px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 'bold', background: '#dc3545', color: '#fff' }}>再読み込み</button>
          </div>
        )}
        {actionError && (
          <div style={{ background: '#f8d7da', border: '1px solid #f5c2c7', borderRadius: 10, padding: '10px 12px', marginBottom: 14 }}>
            <p style={{ margin: 0, fontSize: 13, color: '#842029' }}>{actionError}</p>
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
          <div style={{ background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 12, padding: '14px 18px', marginBottom: 14, display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ width: 36, height: 36, borderRadius: '50%', background: '#22c55e', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 18, flexShrink: 0 }}>✓</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <p style={{ margin: 0, fontSize: 15, fontWeight: 'bold', color: '#166534' }}>送信しました</p>
              <p style={{ margin: '2px 0 0', fontSize: 12.5, color: '#15803d' }}>履歴・実績報告タブで状況を確認できます</p>
            </div>
            <button onClick={() => setSavedBanner(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, color: '#166534', flexShrink: 0 }}>✕</button>
          </div>
        )}

        {/* タブ */}
        <div style={{ display: 'flex', borderRadius: '10px 10px 0 0', overflow: 'hidden', border: `1px solid ${borderColor}`, borderBottom: 'none' }}>
          {(['form', 'history'] as const).map(t => (
            <button key={t} onClick={() => { setTab(t); setEditTarget(null); }}
              style={{
                flex: 1, padding: '12px 4px', border: 'none', cursor: 'pointer', fontSize: 13.5,
                fontWeight: tab === t ? 'bold' : 'normal',
                background: tab === t ? '#28a745' : (isDark ? '#495057' : '#f8f9fa'),
                color: tab === t ? '#fff' : text,
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, lineHeight: 1.3,
              }}>
              {t === 'form' ? '事前申請・事後報告' : '履歴・実績報告'}
              {/* 履歴タブに「実績未報告（要報告）」件数を表示。開いた瞬間どこに何件あるか分かる */}
              {t === 'history' && unreportedRequests.length > 0 && (
                <span style={{ background: '#dc3545', color: '#fff', borderRadius: 10, minWidth: 18, height: 18, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 'bold', padding: '0 5px' }}>
                  {unreportedRequests.length}
                </span>
              )}
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
              {/* 履歴タブの説明＋変更・取消ルール（申請タブの注意事項と同じ見た目） */}
              <div style={{
                background: isDark ? '#2c3e50' : '#e8f4fd',
                border: `1px solid ${isDark ? '#3d5a73' : '#bee5eb'}`,
                borderRadius: 8, padding: '12px 14px', marginBottom: 14, textAlign: 'left',
              }}>
                <p style={{ fontSize: 13, fontWeight: 'bold', color: isDark ? '#fff' : '#1a4a5a', margin: '0 0 8px' }}>【注意事項】</p>
                <p style={{ fontSize: 12, fontWeight: 'bold', color: isDark ? '#fff' : '#1a4a5a', margin: '0 0 4px' }}>■ このページでできること</p>
                <ol style={{ margin: '0 0 10px', paddingLeft: 20, fontSize: 12, color: isDark ? '#d0dde8' : '#2c5f6e', lineHeight: 1.8 }}>
                  <li>申請・報告した内容と、今期の合計時間数を確認できます。</li>
                  <li>事前申請が受理された日は「実績を報告する」から実績を送信します（<b>残業が無かった日も「残業なし」で報告できます</b>）。</li>
                  <li>差し戻された申請は、内容を直して再提出できます。</li>
                </ol>
                <p style={{ fontSize: 12, fontWeight: 'bold', color: isDark ? '#fff' : '#1a4a5a', margin: '0 0 4px' }}>■ 変更・取消のルール</p>
                <ul style={{ margin: 0, paddingLeft: 20, fontSize: 12, color: isDark ? '#d0dde8' : '#2c5f6e', lineHeight: 1.8 }}>
                  <li><b>申請中／事前申請 受理済み／差し戻し</b>は、自分で「この申請を取消する」から取消できます。内容を直したいときは、取消の確認画面にある「<b>取消して、この内容で作り直す</b>」が便利です。</li>
                  <li><b>実績報告済み・確認済み</b>は自分では変更・取消できません。「<b>📩 管理者に修正を依頼</b>」または「<b>取消を依頼</b>」から依頼してください（依頼はあとから取り下げられます）。</li>
                  <li>自分で取消できるのは<b>支給月の17日まで</b>です。それ以降は管理者へご依頼ください。</li>
                  <li>調整休の受理により自動で計上された記録は、変更・取消の対象外です（もとの休暇申請を取り消してください）。</li>
                  <li>振替休日は「休日出勤した日の実際の勤務時間」と「休みを取る日の通常の勤務時間」の差分が合計時間数に反映されます。休日出勤した日を別途「休日出勤」として申請すると二重計上になるため、申請しないでください。</li>
                </ul>
              </div>
              {/* 全員のシフト予定ページへの導線（権限者のみ・履歴タブの両モードで表示） */}
              {canShiftDirectory && (
                <div style={{ textAlign: 'right', marginBottom: 10 }}>
                  <button onClick={() => navigate('/shift-patterns')}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, color: '#0d6efd', textDecoration: 'underline' }}>
                    🗓 全員のシフト予定を見る
                  </button>
                </div>
              )}
              {/* 集計モード切替（権限者のみ） */}
              {canSummary && (
                <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
                  {(['own', 'summary'] as const).map(m => (
                    <button key={m} onClick={() => { setHistoryMode(m); if (m === 'own') clearSelectedStaff(); }}
                      style={{
                        flex: 1, padding: '8px 0', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 'bold',
                        border: historyMode === m ? '2px solid #1565c0' : '2px solid #90caf9',
                        background: historyMode === m ? '#1976d2' : '#e3f2fd',
                        color: historyMode === m ? '#fff' : '#1565c0',
                      }}>
                      {m === 'own' ? '自分の履歴' : '部門集計'}
                    </button>
                  ))}
                </div>
              )}

              {historyMode === 'summary' && canSummary ? (
                selectedStaffId ? (
                  // 権限判定は「役職rank比較」で行う（データ有無や当該期の申請有無に依存させない）。
                  // 上位者への ?staff= 直アクセスは MemberDetailView 内で権限エラーを出す。
                  <MemberDetailView
                    isDark={isDark}
                    userId={selectedStaffId}
                    name={summaryRows.find(r => r.userId === selectedStaffId)?.name ?? ''}
                    period={summaryPeriod}
                    viewerRank={roleRank(roleTitle)}
                    isAdmin={isAdmin}
                    proposerId={user.id}
                    proposerName={profileName ?? ''}
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

                  {/* 曜日パターン確認（全員のシフト予定への導線は履歴タブ上部に集約済み） */}
                  <div style={{ textAlign: 'right', marginBottom: 12 }}>
                    <MyPatternToggle isDark={isDark} patterns={patterns} />
                  </div>

                  {/* 実績未報告リマインド */}
                  {unreportedRequests.length > 0 && (
                    <div style={{ background: isDark ? '#4a3a10' : '#fff8e1', border: '1px solid #f59e0b', borderRadius: 10, padding: '10px 12px', marginBottom: 12 }}>
                      <p style={{ margin: 0, fontSize: 12.5, fontWeight: 'bold', color: isDark ? '#ffffff' : '#856404' }}>
                        🔔 実績が未報告の事前申請が{unreportedRequests.length}件あります（{unreportedRequests.map(r => r.work_date.slice(5).replace('-', '/')).join('・')}）
                      </p>
                    </div>
                  )}

                  {/* 履歴リスト */}
                  {ownHistory.length === 0 && (
                    <p style={{ margin: '16px 0', fontSize: 13, color: subText, textAlign: 'center' }}>まだ申請・報告はありません</p>
                  )}
                  {(() => {
                  const renderOwnCard = (r: OvertimeReport) => {
                    const isAuto = r.entry_type === 'leave_auto';
                    const isFullDay = isFullDayReport(r.application_types);
                    const isOverdue = r.status === 'request_confirmed' && !isFullDay && r.work_date < otTodayStr;
                    const isFuturePlanned = r.status === 'request_confirmed' && !isFullDay && r.work_date >= otTodayStr;
                    const canReport = isOverdue; // 実績報告ボタンは勤務日を過ぎた分だけ（未来は勤務後に案内）
                    const canResubmit = r.status === 'returned';
                    // 取消ルール：reported(実績報告済＝実態あり)は本人不可（上長が差し戻す/管理者）。
                    // 本人可は事前段階(requested/request_confirmed)＋差し戻し(returned)のみ。期間は支給月17日まで、以降は管理者のみ。確定は不可（既存）。
                    const cancelLockedByPeriod = !isAdmin && otTodayStr > payPeriodCloseCutoff(r.pay_period_start);
                    const isReportedLock = !isAdmin && r.status === 'reported' && !isAuto;
                    const selfCancelStatus = ['requested', 'request_confirmed', 'returned'].includes(r.status) && !isAuto;
                    const adminCancelStatus = ['requested', 'request_confirmed', 'reported', 'returned'].includes(r.status) && !isAuto;
                    const canCancel = isAdmin ? adminCancelStatus : (selfCancelStatus && !cancelLockedByPeriod);
                    const actual = (r.segments ?? []).filter(s => s.phase === 'actual').sort((a, b) => a.seg_no - b.seg_no);
                    const planned = (r.segments ?? []).filter(s => s.phase === 'planned').sort((a, b) => a.seg_no - b.seg_no);
                    const segs = actual.length > 0 ? actual : planned;
                    return (
                      <div key={r.id} style={{ background: cardBg, borderRadius: 12, border: `1px solid ${borderColor}`, borderLeft: (isOverdue || r.status === 'returned') ? '4px solid #f59e0b' : `1px solid ${borderColor}`, padding: '12px 14px', marginBottom: 10 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4, gap: 6, flexWrap: 'wrap' }}>
                          <span style={{ fontSize: 14, fontWeight: 'bold', color: text }}>
                            {r.work_date.slice(5).replace('-', '/')}（{dowLabel(r.work_date)}）
                            <span style={{ color: diffColor(r.diff_minutes ?? 0, isDark), marginLeft: 6 }}>{formatSignedMin(r.diff_minutes ?? 0)}</span>
                          </span>
                          <div style={{ display: 'flex', gap: 4 }}>
                            {isAuto && <span style={badgeStyle(AUTO_BADGE.color, AUTO_BADGE.darkBg, isDark)}>自動計上</span>}
                            {!isAuto && r.is_post_hoc && <span style={badgeStyle(POSTHOC_BADGE.color, POSTHOC_BADGE.darkBg, isDark)}>事後報告</span>}
                            {!isAuto && (isOverdue
                              ? <span style={badgeStyle('#e65100', '#4a2c0a', isDark)}>⚠️ 要報告</span>
                              : <span style={badgeStyle(STATUS_INFO[r.status].color, STATUS_INFO[r.status].darkBg, isDark)}>{STATUS_INFO[r.status].label}</span>
                            )}
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
                              {isFullDay && r.furikae_origin_date && `振替元：${r.furikae_origin_date.slice(5).replace('-', '/')}（${dowLabel(r.furikae_origin_date)}）${r.furikae_origin_location ? '・' + r.furikae_origin_location : ''}${r.furikae_origin_start ? `・${r.furikae_origin_start.slice(0, 5)}〜${(r.furikae_origin_end ?? '').slice(0, 5)}（労働${formatMin(r.furikae_origin_labor_minutes ?? 0)}）` : ''}　`}
                              {!isFullDay && segs.length > 0 && `${actual.length > 0 ? '実績' : '予定'}：${segmentsLabel(segs)}　`}
                              {r.reviewer?.name && `申請先：${r.reviewer.name}`}
                            </p>
                            {r.status === 'returned' && r.return_comment && (
                              <p style={{ margin: '4px 0 0', fontSize: 12.5, color: isDark ? '#f5b5ba' : '#c62828' }}>差し戻し理由：{r.return_comment}</p>
                            )}
                            {r.change_reason && (
                              <p style={{ margin: '4px 0 0', fontSize: 12.5, color: isDark ? '#ffcf87' : '#8a6d1a' }}>予定から変わった理由：{r.change_reason}</p>
                            )}
                          </>
                        )}

                        {isFuturePlanned && (
                          <p style={{ margin: '8px 0 0', fontSize: 12, color: subText }}>🗓 勤務後に「実績を報告する」ボタンが出ます</p>
                        )}
                        {isReportedLock && (
                          <p style={{ margin: '8px 0 0', fontSize: 12, color: subText }}>🔒 実績報告済みのため取消できません。申請先の担当者に取り下げ（差し戻し）を依頼してください</p>
                        )}
                        {selfCancelStatus && cancelLockedByPeriod && (
                          <p style={{ margin: '8px 0 0', fontSize: 12, color: subText }}>🔒 給与計算が始まっているため（毎月17日以降）、取消は管理者に依頼してください</p>
                        )}
                        {(canReport || canResubmit || canCancel) && (
                          <div style={{ marginTop: 10 }}>
                            {/* 要報告：実績を報告するを主役に。残業ゼロも報告できる旨を案内 */}
                            {canReport && (
                              <>
                                <button onClick={() => { setEditTarget(r); setTab('form'); window.scrollTo({ top: 0 }); }}
                                  style={{ width: '100%', padding: '12px 0', borderRadius: 10, border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: 'bold', background: '#28a745', color: '#fff' }}>
                                  実績を報告する
                                </button>
                                <p style={{ margin: '6px 0 0', fontSize: 11.5, color: subText, textAlign: 'center', lineHeight: 1.6 }}>
                                  残業が無かった日も、こちらから「残業なし」で報告できます
                                </p>
                              </>
                            )}
                            {canResubmit && (
                              <button onClick={() => { setEditTarget(r); setTab('form'); window.scrollTo({ top: 0 }); }}
                                style={{ width: '100%', padding: '11px 0', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: 'bold', background: '#0d6efd', color: '#fff' }}>
                                修正して再提出
                              </button>
                            )}
                            {canCancel && (
                              cancelTargetId === r.id ? (
                                <div style={{ marginTop: 10 }}>
                                  <p style={{ margin: '0 0 8px', fontSize: 11.5, color: subText, background: innerBg, borderRadius: 8, padding: '8px 10px', lineHeight: 1.7 }}>
                                    その日は<b style={{ color: text }}>出勤しませんでしたか？</b> 残業が無かっただけなら「実績を報告する」へ（残業ゼロで報告できます）。間違えて出した申請もこちらで取消できます。
                                  </p>
                                  <div style={{ display: 'flex', gap: 6 }}>
                                    <button onClick={() => doCancel(r)} disabled={actingId === r.id}
                                      style={{ flex: 1, padding: '9px 0', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 12.5, fontWeight: 'bold', background: '#dc3545', color: '#fff' }}>
                                      取消を確定
                                    </button>
                                    <button onClick={() => setCancelTargetId(null)}
                                      style={{ flex: 1, padding: '9px 0', borderRadius: 8, border: `1px solid ${borderColor}`, cursor: 'pointer', fontSize: 12.5, background: 'transparent', color: subText }}>
                                      やめる
                                    </button>
                                  </div>
                                  <button onClick={() => cancelAndCopy(r)} disabled={actingId === r.id}
                                    style={{ width: '100%', marginTop: 6, padding: '9px 0', borderRadius: 8, border: `1px solid ${isDark ? '#3d5166' : '#90caf9'}`, cursor: 'pointer', fontSize: 12.5, fontWeight: 'bold', background: isDark ? '#243447' : '#e8f4fd', color: isDark ? '#90caf9' : '#1565c0' }}>
                                    取消して、この内容で作り直す
                                  </button>
                                </div>
                              ) : (
                                // 取消は常に控えめ（中央・小さめ・同じ文言）。主役は実績報告・内容の確認。
                                <div style={{ textAlign: 'center', marginTop: 10 }}>
                                  <button onClick={() => setCancelTargetId(r.id)}
                                    style={{ padding: '6px 16px', borderRadius: 8, border: `1px solid ${borderColor}`, cursor: 'pointer', fontSize: 12, background: 'transparent', color: subText }}>
                                    この申請を取消する
                                  </button>
                                </div>
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
                  };
                  return (
                    <>
                      {ownActionRows.length > 0 && (
                        <div style={{ fontSize: 12.5, fontWeight: 'bold', color: isDark ? '#ffcf8f' : '#b7770d', margin: '4px 0 8px' }}>⚠️ あなたの対応待ち（{ownActionRows.length}）</div>
                      )}
                      {ownActionRows.map(renderOwnCard)}
                      {ownActionRows.length > 0 && ownRestRows.length > 0 && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '14px 0 8px' }}>
                          <div style={{ flex: 1, height: 1, background: borderColor }} />
                          <span style={{ fontSize: 11.5, color: subText, whiteSpace: 'nowrap' }}>これまでの申請・報告</span>
                          <div style={{ flex: 1, height: 1, background: borderColor }} />
                        </div>
                      )}
                      {ownRestRows.map(renderOwnCard)}
                    </>
                  );
                  })()}
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
        数字の見かた{filterOpen ? ' ▲' : ' ▼'}
      </button>
      {/* 役職階層の可視性ルールを常設で明示（人が黙って消えることによる誤解＝バグ/集計漏れ/隠蔽の誤認を防ぐ）。囲みで視認性を上げる。 */}
      <div style={{ background: innerBg, borderRadius: 8, padding: '8px 10px', margin: '0 0 10px', fontSize: 11.5, color: subText, lineHeight: 1.5, display: 'flex', gap: 6 }}>
        <span aria-hidden>ℹ️</span>
        <span>この一覧には、<strong style={{ color: text }}>あなたと同じ役職か、それより下の役職</strong>の方だけが表示されます（上の役職の方は表示されません）。合計も、表示中の方だけの集計です。</span>
      </div>
      {filterOpen && (
        <div style={{ border: `1px solid ${borderColor}`, borderRadius: 10, padding: '10px 12px', marginBottom: 10, fontSize: 12.5, color: subText }}>
          <p style={{ margin: 0 }}>合計は<strong style={{ color: text }}>確定</strong>を主に表示し、<strong style={{ color: text }}>見込</strong>（申請中・受理済み・報告待ちを反映）を下に併記します。差し戻し・取消は合計に含みません。</p>
        </div>
      )}

      {visibleRows.length === 0 ? (
        <p style={{ margin: '16px 0', fontSize: 13, color: subText, textAlign: 'center', lineHeight: 1.6 }}>
          {rows.length === 0
            ? '表示できる方がいません。この一覧には、あなたと同じ役職か、それより下の役職の方だけが表示されます。'
            : '該当する方がいません'}
        </p>
      ) : (
        <>
          <div style={{ background: innerBg, borderRadius: 8, padding: '10px 12px', marginBottom: 12, fontSize: 14, fontWeight: 'bold', color: text }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>表示中の合計（確定）</span>
              <span style={{ color: diffColor(total, isDark) }}>{formatSignedMin(total)}</span>
            </div>
            {plannedTotal !== total && (
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, fontWeight: 'normal', color: subText, marginTop: 2 }}>
                <span>見込み合計</span>
                <span>{formatSignedMin(plannedTotal)}</span>
              </div>
            )}
          </div>
          <p style={{ margin: '0 0 12px', fontSize: 11.5, color: subText }}>名前をタップすると個人の申請履歴を確認できます。確定＝給与に効く数字です。</p>
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
                        <td style={{ padding: '7px 10px 7px 0', borderBottom: `1px solid ${borderColor}`, whiteSpace: 'nowrap' }}>{r.name}</td>
                        <td style={{ padding: '7px 0', borderBottom: `1px solid ${borderColor}`, width: '100%', fontSize: 11, color: subText }}>
                          {[r.group !== '未所属' ? r.group : null, r.role || null].filter(Boolean).join('・')}
                          {r.absenceDays > 0 && <span style={{ marginLeft: 8 }}>欠{r.absenceDays}日</span>}
                        </td>
                        <td style={{ padding: '7px 0', borderBottom: `1px solid ${borderColor}`, textAlign: 'right', whiteSpace: 'nowrap' }}>
                          <span style={{ color: diffColor(r.total, isDark), fontWeight: 'bold' }}>{formatSignedMin(r.total)}</span>
                          {r.plannedTotal !== r.total && (
                            <span style={{ display: 'block', fontSize: 11, color: subText }}>見込 {formatSignedMin(r.plannedTotal)}</span>
                          )}
                        </td>
                        <td style={{ padding: '7px 0 7px 8px', borderBottom: `1px solid ${borderColor}`, textAlign: 'right', color: subText, width: 14 }}>›</td>
                      </tr>
                    ))}
                    <tr>
                      <td colSpan={2} style={{ padding: '5px 0', fontWeight: 'bold' }}>小計</td>
                      <td style={{ padding: '5px 0', textAlign: 'right', fontWeight: 'bold', color: diffColor(sub, isDark), whiteSpace: 'nowrap' }}>{formatSignedMin(sub)}</td>
                      <td />
                    </tr>
                  </tbody>
                </table>
              </div>
            );
          })}
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
  viewerRank: number;   // 閲覧者の役職rank（roleRank）。権限判定に使用
  isAdmin: boolean;
  proposerId: string;   // 閲覧者＝提案者の user.id
  proposerName: string; // 閲覧者の氏名（提案通知の差出人名）
  onBack: () => void;
}> = ({ isDark, userId, name, period, viewerRank, isAdmin, proposerId, proposerName, onBack }) => {
  const text = isDark ? '#f8f9fa' : '#212529';
  const subText = isDark ? '#adb5bd' : '#6c757d';
  const borderColor = isDark ? '#495057' : '#dee2e6';
  const innerBg = isDark ? '#2b3035' : '#f8f9fa';
  const cardBg = isDark ? '#343a40' : '#fff';

  const [rows, setRows] = useState<OvertimeReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [denied, setDenied] = useState(false);
  const [showPropose, setShowPropose] = useState(false);
  const [proposeSent, setProposeSent] = useState(false);
  const [templateDraft, setTemplateDraft] = useState<DraftCandidate[] | undefined>(undefined);
  const [templateRemarks, setTemplateRemarks] = useState('');
  interface HistOption { kind: string; work_date: string; adjust_time: string | null; location: string | null; note: string | null; selection: string }
  const [proposalHistory, setProposalHistory] = useState<{ id: string; created_at: string; status: string; remarks: string | null; options: HistOption[] }[]>([]);

  // 権限判定は役職rankの比較で行う（当該期のデータ有無に左右されない）。
  // 対象者が自分より上位（rankが小さい）なら閲覧不可。役職不明の対象者は最上位(1)扱い＝
  // DBの overtime_role_rank_target と同じ fail-closed。
  useEffect(() => {
    if (isAdmin) { setDenied(false); return; }
    let alive = true;
    (async () => {
      const { data } = await supabase.from('profiles').select('role_title').eq('id', userId).maybeSingle();
      if (!alive) return;
      const targetRank = ROLE_RANK[(data as { role_title: string | null } | null)?.role_title ?? ''] ?? 1;
      setDenied(targetRank < viewerRank);
    })();
    return () => { alive = false; };
  }, [userId, viewerRank, isAdmin]);

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

  // 提案者向け：この相手への提案履歴（テンプレ複製・状況把握）。RLSで閲覧可能なぶんのみ返る。
  useEffect(() => {
    if (userId === proposerId) return;
    let alive = true;
    supabase.from('overtime_adjustment_proposals')
      .select('id, created_at, status, remarks, options:overtime_adjustment_proposal_options(kind, work_date, adjust_time, location, note, selection)')
      .eq('recipient_id', userId).order('created_at', { ascending: false })
      .then(({ data }) => { if (alive) setProposalHistory((data as { id: string; created_at: string; status: string; remarks: string | null; options: HistOption[] }[] | null) ?? []); });
    return () => { alive = false; };
  }, [userId, proposerId, proposeSent]);

  return (
    <div>
      {/* パンくず＋戻る */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        <button onClick={onBack} style={{ background: 'none', border: `1px solid ${borderColor}`, borderRadius: 8, cursor: 'pointer', fontSize: 12.5, color: subText, padding: '5px 10px' }}>← 一覧へ戻る</button>
        <span style={{ fontSize: 12.5, color: subText }}>部門集計 › <span style={{ color: text, fontWeight: 'bold' }}>{name || '個人'}</span></span>
      </div>

      {denied ? (
        <p style={{ margin: '24px 0', fontSize: 13, color: subText, textAlign: 'center', lineHeight: 1.7 }}>
          この方の記録を表示する権限がありません。<br />部門集計では、あなたと同じか、下の役職の方だけを閲覧できます。
        </p>
      ) : (
      <>
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

      {/* 残業調整の提案。自分自身には出さない */}
      {userId !== proposerId && (
        <div style={{ marginBottom: 10 }}>
          <button onClick={() => { setTemplateDraft(undefined); setTemplateRemarks(''); setProposeSent(false); setShowPropose(true); }}
            style={{ width: '100%', padding: 11, borderRadius: 10, border: 'none', background: '#1565c0', color: '#fff', fontSize: 14, fontWeight: 'bold', cursor: 'pointer' }}>
            🕐 調整を提案する
          </button>
          {proposeSent && (
            <div style={{ marginTop: 8, padding: '10px 12px', background: isDark ? '#1b4d1b' : '#f0fff4', border: `1px solid ${isDark ? '#2d5a2d' : '#c3e6cb'}`, borderRadius: 8, fontSize: 12.5, color: isDark ? '#a3d9a3' : '#1e7e34' }}>
              ✓ 提案を送りました。相手のお返事をお待ちください。
            </div>
          )}
          {/* 提案履歴（テンプレ複製・状況把握） */}
          {proposalHistory.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <div style={{ fontSize: 12, fontWeight: 'bold', color: subText, marginBottom: 6 }}>これまでの提案</div>
              {proposalHistory.map(p => (
                <div key={p.id} style={{ border: `1px solid ${borderColor}`, borderRadius: 8, padding: '8px 10px', marginBottom: 6, fontSize: 12, color: text }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6, flexWrap: 'wrap' }}>
                    <span>{p.created_at.slice(0, 10)}　候補{p.options.length}件</span>
                    <span style={{ color: p.status === 'responded' ? '#1e8449' : subText }}>{p.status === 'open' ? '未回答' : p.status === 'responded' ? '回答あり' : '取り下げ'}</span>
                  </div>
                  <button onClick={() => {
                    setTemplateDraft(p.options.map(o => ({ kind: o.kind as DraftCandidate['kind'], date: o.work_date, time: (o.adjust_time ?? '').slice(0, 5), location: o.location ?? '', note: o.note ?? '' })));
                    setTemplateRemarks(p.remarks ?? '');
                    setProposeSent(false); setShowPropose(true);
                  }} style={{ marginTop: 6, fontSize: 11.5, color: '#1565c0', background: 'none', border: `1px solid ${borderColor}`, borderRadius: 6, padding: '3px 10px', cursor: 'pointer' }}>これをもとに新規作成</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {showPropose && (
        <OvertimeProposalSheet
          proposerId={proposerId} proposerName={proposerName}
          recipientId={userId} recipientName={name}
          period={period} currentOvertimeMinutes={b.total} isDark={isDark}
          initialCandidates={templateDraft} initialRemarks={templateRemarks}
          onClose={() => setShowPropose(false)}
          onSubmitted={() => setProposeSent(true)}
        />
      )}

      {loadError && <p style={{ margin: '8px 0', fontSize: 12.5, color: isDark ? '#f5b5ba' : '#c62828' }}>{loadError}</p>}
      {loading ? (
        <p style={{ margin: '16px 0', fontSize: 13, color: subText, textAlign: 'center' }}>読み込み中…</p>
      ) : visible.length === 0 ? (
        <p style={{ margin: '16px 0', fontSize: 13, color: subText, textAlign: 'center' }}>この期間の申請・報告はありません</p>
      ) : (
        visible.map(r => <ReadonlyReportCard key={r.id} r={r} isDark={isDark} cardBg={cardBg} borderColor={borderColor} text={text} subText={subText} />)
      )}
      </>
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
          <p style={{ margin: 0, fontSize: 12.5, color: subText, lineHeight: 1.75 }}>
            {r.normal_shift?.start_time
              ? <>通常シフト：{fmtTime(r.normal_shift.start_time)}〜{fmtTime(r.normal_shift.end_time)}（労働{formatMin(r.normal_shift.labor_minutes)}）{r.normal_shift.location ? `　${r.normal_shift.location}` : ''}<br /></>
              : (!isFullDay ? <>通常シフト：休み<br /></> : null)}
            {isFullDay && <>終日{r.furikae_origin_date ? `　振替元：${r.furikae_origin_date.slice(5).replace('-', '/')}（${dowLabel(r.furikae_origin_date)}）${r.furikae_origin_location ? '・' + r.furikae_origin_location : ''}${r.furikae_origin_start ? `・${r.furikae_origin_start.slice(0, 5)}〜${(r.furikae_origin_end ?? '').slice(0, 5)}（労働${formatMin(r.furikae_origin_labor_minutes ?? 0)}）` : ''}` : ''}{('furikae_off' === (r.application_types ?? [])[0] || (r.application_types ?? []).includes('furikae_off')) && r.diff_minutes != null ? `　合計時間数 ${formatSignedMin(r.diff_minutes)}` : ''}<br /></>}
            {!isFullDay && segs.length > 0 && <>{actual.length > 0 ? '実績' : '予定'}：{segmentsLabel(segs)}{r.location ? `　勤務地：${r.location}` : ''}<br /></>}
            {!isFullDay && segs.length === 0 && r.location && <>勤務地：{r.location}<br /></>}
            {(r.reason || r.reviewer?.name) && (
              <>
                {r.reason && `理由：${r.reason}`}
                {r.reason && r.reviewer?.name && '　／　'}
                {r.reviewer?.name && `申請先：${r.reviewer.name}`}
              </>
            )}
          </p>
          {r.status === 'returned' && r.return_comment && (
            <p style={{ margin: '4px 0 0', fontSize: 12.5, color: isDark ? '#f5b5ba' : '#c62828' }}>差し戻し理由：{r.return_comment}</p>
          )}
          {r.change_reason && (
            <p style={{ margin: '4px 0 0', fontSize: 12.5, color: isDark ? '#ffcf87' : '#8a6d1a' }}>予定から変わった理由：{r.change_reason}</p>
          )}
        </>
      )}
    </div>
  );
};

export default OvertimePage;

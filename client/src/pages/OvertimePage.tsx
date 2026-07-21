import React, { useState, useEffect, useCallback, useMemo } from 'react';
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
import { OT_TYPE_INFO, isOvertimeType } from '../lib/overtimeTypes';
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
const SELF_REVIEW_ROLES = ['リーダー', 'マネージャー', '社長', '管理者'];
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

/** "HH:MM(:SS)" → "HH:MM" 表示用 */
function fmtTime(t: string | null | undefined): string {
  if (!t) return '-';
  return t.slice(0, 5);
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
      if (use.length > 0) return use.map(s => ({ start: minToTime(s.start_min).replace('翌', ''), end: minToTime(s.end_min).replace('翌', '') }));
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
      normOverride, normStart, normEnd,
    } satisfies FormDraft);
  }, [editTarget, mode, date, segments, breakManual, breakManualMin, reason, location, locationCustom, reviewerId, normOverride, normStart, normEnd]);

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

  // 日付を選ぶと、時間帯が空のときだけ通常シフトの時間を自動入力（新規のみ）。
  // 利用者はここから残業・早退などの差分に直して送信する。
  useEffect(() => {
    if (editTarget) return;
    if (normalSegs.length === 0) return;
    const allEmpty = segments.every(s => !s.start && !s.end);
    if (!allEmpty) return;
    setSegments(normalSegs.map(s => ({ ...s })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [normalSegs, date]);

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
  const [lateChoice, setLateChoice] = useState<'adj' | 'tardiness'>(() =>
    (editTarget?.application_types ?? []).includes('tardiness') ? 'tardiness' : 'adj');
  const [earlyChoice, setEarlyChoice] = useState<'adj' | 'early_leave'>(() =>
    (editTarget?.application_types ?? []).includes('early_leave') ? 'early_leave' : 'adj');

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
    const t = [...typeDetect.fixed];
    if (typeDetect.lateQ) t.push(lateChoice === 'adj' ? 'late_start_adj' : 'tardiness');
    if (typeDetect.earlyQ) t.push(earlyChoice === 'adj' ? 'early_end_adj' : 'early_leave');
    return t;
  }, [typeDetect, lateChoice, earlyChoice]);

  // 時間帯変更時：手修正中なら注意表示
  useEffect(() => {
    if (breakManual && hasInput) setBreakRecalcNote(true);
    else setBreakRecalcNote(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(segments)]);

  const canSelfReview = isAdmin || SELF_REVIEW_ROLES.includes(roleTitle);
  const isSelfReview = reviewerId === SELF_REVIEW_VALUE;

  const today = todayJstStr();

  const validate = (): string => {
    if (!date) return '日付を選択してください';
    if (mode === 'advance' && !editTarget && date < today) return '事前申請は当日以降の日付を選択してください';
    if (mode === 'posthoc' && date > today) return '事後報告は当日以前の日付を選択してください';
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
      const record = {
        work_date: date,
        pay_period_start: calcPayPeriodStartJst(date),
        is_post_hoc: mode === 'posthoc',
        status: (phase === 'actual'
          ? (isSelfReview ? 'confirmed' : 'reported')
          : (isSelfReview ? 'request_confirmed' : 'requested')) as OvertimeStatus,
        normal_shift: normalShift,
        break_minutes: breakMin,
        break_manual: breakManual,
        labor_minutes: laborMin,
        diff_minutes: diffMin,
        legal_warning: !legal.ok,
        reason: reason.trim(),
        location: effectiveLocation,
        application_types: applicationTypes,
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

      const segRows = workSegments.map((s, i) => ({
        report_id: reportId, phase, seg_no: i + 1, start_min: s.startMin, end_min: s.endMin,
      }));
      const { error: segErr } = await supabase.from('overtime_report_segments').insert(segRows);
      if (segErr) { setError('時間帯の保存に失敗しました: ' + segErr.message); setSaving(false); setShowConfirm(false); return; }

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
        <span style={labelStyle}>日付{req}</span>
        <input type="date" value={date} onChange={e => setDate(e.target.value)}
          disabled={!!editTarget}
          min={mode === 'advance' && !editTarget ? today : undefined}
          max={mode === 'posthoc' ? today : undefined}
          style={fieldStyle} />
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

      {/* 実務の勤務時間帯 */}
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

      {/* 休憩・労働時間・差分 */}
      {hasInput && (
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
      {hasInput && typeDetect.lateQ && (
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
      {hasInput && typeDetect.earlyQ && (
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
      {hasInput && !legal.ok && (
        <div style={{ background: isDark ? '#4a3a10' : '#fff8e1', border: '1px solid #f59e0b', borderRadius: 10, padding: '10px 12px', marginBottom: 12 }}>
          <p style={{ margin: 0, fontSize: 12.5, color: isDark ? '#ffd54f' : '#856404', lineHeight: 1.7 }}>
            ⚠️ この日は労働{laborMin > 480 ? '8時間' : '6時間'}超のため、法律上{legal.requiredMinutes}分以上の休憩が必要です
            （現在の休憩＋外出の合計：{legal.actualRestMinutes}分）。休憩時間を確認してください。このまま提出することもできます。
          </p>
        </div>
      )}

      {/* 勤務地（勤務変更報告と同様に自由入力あり） */}
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

      {/* 理由 */}
      <div style={{ marginBottom: 12 }}>
        <span style={labelStyle}>理由{req}</span>
        <textarea value={reason} onChange={e => setReason(e.target.value)} rows={2}
          placeholder="例：お客様対応のため"
          style={{ ...fieldStyle, resize: 'vertical' }} />
        {/* 文例ボタン（2つ） */}
        <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
          {['お客様対応のため', '〇〇準備のため'].map(ex => (
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
          {reviewers.filter(r => r.id !== user.id).map(r => (
            <option key={r.id} value={r.id}>{r.name}（{r.role_title}）</option>
          ))}
          {canSelfReview && <option value={SELF_REVIEW_VALUE}>自己受理（自分で確認する）</option>}
        </select>
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
          <p style={{ margin: '0 0 6px', fontSize: 12.5, color: subText, lineHeight: 1.7 }}>
            {date}（{dowLabel(date)}）　{segmentsLabel(workSegments)}<br />
            休憩{formatMin(breakMin)}・労働{formatMin(laborMin)}・差分 {formatSignedMin(diffMin)}<br />
            {isSelfReview ? '自己受理のため、送信と同時に受理されます' : `申請先：${reviewers.find(r => r.id === reviewerId)?.name ?? ''}さん`}
          </p>
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
  const [historyMode, setHistoryMode] = useState<'own' | 'summary'>('own');
  const [canSummary, setCanSummary] = useState(false);

  // 集計モード用
  const [summaryPeriod, setSummaryPeriod] = useState(() => calcPayPeriodStartJst(todayJstStr()));
  const [summaryRows, setSummaryRows] = useState<{ userId: string; name: string; group: string; total: number }[]>([]);
  const [summaryGroups, setSummaryGroups] = useState<string[]>([]);

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
      const [, , revRes, wpRes, patRes, permRes] = await Promise.all([
        fetchOwn(),
        fetchPendingForMe(),
        supabase.from('profiles').select('id, name, role_title').in('role_title', REVIEWER_ROLES).eq('is_active', true).order('role_title').order('name'),
        supabase.from('master_options').select('value').eq('category', 'workplace').order('sort_order'),
        supabase.from('weekly_shift_patterns').select('*').eq('user_id', user.id),
        supabase.rpc('has_feature_permission', { p_feature: 'overtime_summary' }),
      ]);
      setReviewers((revRes.data as Reviewer[] | null) ?? []);
      setWorkplaces(((wpRes.data as { value: string }[] | null) ?? []).map(w => w.value));
      setPatterns((patRes.data as PatternRow[] | null) ?? []);
      setCanSummary(isAdmin || permRes.data === true);
      setLoading(false);
    })();
  }, [fetchOwn, fetchPendingForMe, user.id, isAdmin]);

  // 集計モードのデータ取得
  useEffect(() => {
    if (historyMode !== 'summary' || !canSummary) return;
    (async () => {
      const [repRes, profRes, setRes] = await Promise.all([
        supabase.from('overtime_reports')
          .select('applicant_id, diff_minutes, status')
          .eq('pay_period_start', summaryPeriod)
          .eq('status', 'confirmed'),
        supabase.from('profiles').select('id, name, group_names, employment_type').eq('is_active', true),
        supabase.from('overtime_settings').select('banner_group_names').eq('id', 1).maybeSingle(),
      ]);
      const whitelist: string[] = (setRes.data?.banner_group_names as string[] | null) ?? [];
      setSummaryGroups(whitelist);
      const totals = new Map<string, number>();
      for (const r of (repRes.data as { applicant_id: string; diff_minutes: number | null }[] | null) ?? []) {
        totals.set(r.applicant_id, (totals.get(r.applicant_id) ?? 0) + (r.diff_minutes ?? 0));
      }
      const profs = (profRes.data as { id: string; name: string; group_names: string[] | null; employment_type: string | null }[] | null) ?? [];
      const rows = [...totals.entries()].map(([userId, total]) => {
        const p = profs.find(x => x.id === userId);
        const group = whitelist.find(g => (p?.group_names ?? []).includes(g)) ?? 'その他';
        return { userId, name: p?.name ?? '不明', group, total };
      });
      rows.sort((a, b) => a.group === b.group ? a.name.localeCompare(b.name, 'ja') : a.group.localeCompare(b.group, 'ja'));
      setSummaryRows(rows);
    })();
  }, [historyMode, canSummary, summaryPeriod]);

  // ---- 残高（今期通算） ----
  const balance = useMemo(() => {
    const rows = reports.filter(r => r.pay_period_start === currentPeriod && r.status === 'confirmed');
    const total = rows.reduce((s, r) => s + (r.diff_minutes ?? 0), 0);
    const plus = rows.filter(r => (r.diff_minutes ?? 0) > 0).reduce((s, r) => s + (r.diff_minutes ?? 0), 0);
    const minus = rows.filter(r => (r.diff_minutes ?? 0) < 0).reduce((s, r) => s + (r.diff_minutes ?? 0), 0);
    const pendingCount = reports.filter(r => r.pay_period_start === currentPeriod && ['requested', 'reported'].includes(r.status)).length;
    return { total, plus, minus, pendingCount };
  }, [reports, currentPeriod]);

  const prevPeriodBalance = useMemo(() => {
    const [y, m] = currentPeriod.split('-').map(Number);
    const py = m === 1 ? y - 1 : y;
    const pm = m === 1 ? 12 : m - 1;
    const prev = `${py}-${String(pm).padStart(2, '0')}-16`;
    return reports.filter(r => r.pay_period_start === prev && r.status === 'confirmed')
      .reduce((s, r) => s + (r.diff_minutes ?? 0), 0);
  }, [reports, currentPeriod]);

  // 実績未報告の受理済み事前申請（勤務日を過ぎたもの）
  const unreportedRequests = useMemo(() =>
    reports.filter(r => r.status === 'request_confirmed' && r.work_date < todayJstStr()),
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

  // ────────────────────────────────────────────
  // 確認者ビュー（?view=confirm）
  // ────────────────────────────────────────────
  if (isConfirmView) {
    return (
      <div style={{ maxWidth: 600, margin: '0 auto', padding: '16px 16px 40px' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
            <button onClick={() => setSearchParams({})}
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
                  {planned.length > 0 && (
                    <><span style={{ color: subText }}>事前申請　：</span>{segmentsLabel(planned)}<br /></>
                  )}
                  {actual.length > 0 && (
                    <><span style={{ color: subText }}>実績　　　：</span><span style={{ fontWeight: 'bold' }}>{segmentsLabel(actual)}</span><br /></>
                  )}
                  <span style={{ color: subText }}>休憩{formatMin(r.break_minutes ?? 0)}{r.break_manual ? '（手修正）' : ''}・労働{formatMin(r.labor_minutes ?? 0)}・差分 </span>
                  <span style={{ fontWeight: 'bold', color: diffColor(r.diff_minutes ?? 0, isDark) }}>{formatSignedMin(r.diff_minutes ?? 0)}</span>
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
          <button onClick={() => setSearchParams({ view: 'confirm' })}
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
                    <button key={m} onClick={() => setHistoryMode(m)}
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
                <SummaryView
                  isDark={isDark} rows={summaryRows} groups={summaryGroups}
                  period={summaryPeriod} onChangePeriod={setSummaryPeriod}
                />
              ) : (
                <>
                  {/* 残高カード */}
                  <div style={{ background: innerBg, borderRadius: 12, padding: '14px 16px', marginBottom: 8 }}>
                    <p style={{ margin: 0, fontSize: 12.5, color: subText }}>今期の通算（{payPeriodLabel(currentPeriod)}・{payMonthLabel(currentPeriod)}）</p>
                    <p style={{ margin: '4px 0 6px', fontSize: 26, fontWeight: 'bold', color: diffColor(balance.total, isDark) }}>
                      {formatSignedMin(balance.total)}
                    </p>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, color: subText, borderTop: `1px solid ${borderColor}`, paddingTop: 8 }}>
                      <span>残業 {formatSignedMin(balance.plus)}</span>
                      <span>調整・早退 {formatSignedMin(balance.minus)}</span>
                    </div>
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
                    const canReport = r.status === 'request_confirmed';
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
                              {segs.length > 0 && `${actual.length > 0 ? '実績' : '予定'}：${segmentsLabel(segs)}　`}
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
                  {order.filter(k => active.some(p => p.day_kind === k)).map(k => {
                    const p = active.find(x => x.day_kind === k)!;
                    return (
                      <tr key={k}>
                        <td style={{ padding: '3px 0', color: subText, width: 130 }}>{DAY_KIND_LABELS[k]}</td>
                        <td style={{ padding: '3px 0' }}>
                          {p.start_time ? (
                            <>
                              {fmtTime(p.start_time)}〜{fmtTime(p.end_time)}
                              {p.start_time2 && `　＋　${fmtTime(p.start_time2)}〜${fmtTime(p.end_time2)}`}
                              （休憩{formatMin(p.break_minutes)}・労働{formatMin(p.labor_minutes)}）
                              {p.location && <span style={{ color: subText }}>　／　{p.location}</span>}
                            </>
                          ) : '休み'}
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

// ────────────────────────────────────────────────────────────────
// 部門集計ビュー（リーダー以上）
// ────────────────────────────────────────────────────────────────
const SummaryView: React.FC<{
  isDark: boolean;
  rows: { userId: string; name: string; group: string; total: number }[];
  groups: string[];
  period: string;
  onChangePeriod: (p: string) => void;
}> = ({ isDark, rows, groups, period, onChangePeriod }) => {
  const text = isDark ? '#f8f9fa' : '#212529';
  const subText = isDark ? '#adb5bd' : '#6c757d';
  const borderColor = isDark ? '#495057' : '#dee2e6';
  const innerBg = isDark ? '#2b3035' : '#f8f9fa';

  // 期間の選択肢（今期から過去6期分）
  const periodOptions = useMemo(() => {
    const opts: string[] = [];
    let p = calcPayPeriodStartJst(todayJstStr());
    for (let i = 0; i < 6; i++) {
      opts.push(p);
      const [y, m] = p.split('-').map(Number);
      const py = m === 1 ? y - 1 : y;
      const pm = m === 1 ? 12 : m - 1;
      p = `${py}-${String(pm).padStart(2, '0')}-16`;
    }
    return opts;
  }, []);

  const groupOrder = [...groups, 'その他'].filter(g => rows.some(r => r.group === g));
  const total = rows.reduce((s, r) => s + r.total, 0);

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <span style={{ fontSize: 14, fontWeight: 'bold', color: text }}>📊 月次集計</span>
        <select value={period} onChange={e => onChangePeriod(e.target.value)}
          style={{ padding: '6px 10px', borderRadius: 8, border: `1px solid ${borderColor}`, background: isDark ? '#495057' : '#fff', color: text, fontSize: 13 }}>
          {periodOptions.map(p => <option key={p} value={p}>{payMonthLabel(p)}（{payPeriodLabel(p)}）</option>)}
        </select>
      </div>

      {rows.length === 0 ? (
        <p style={{ margin: '16px 0', fontSize: 13, color: subText, textAlign: 'center' }}>この期間の確定データはまだありません</p>
      ) : (
        <>
          {groupOrder.map(g => {
            const grows = rows.filter(r => r.group === g);
            const sub = grows.reduce((s, r) => s + r.total, 0);
            return (
              <div key={g} style={{ marginBottom: 14 }}>
                <p style={{ margin: '0 0 6px', fontSize: 12.5, fontWeight: 'bold', color: subText }}>{g}</p>
                <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse', color: text }}>
                  <tbody>
                    {grows.map(r => (
                      <tr key={r.userId}>
                        <td style={{ padding: '5px 0', borderBottom: `1px solid ${borderColor}` }}>{r.name}</td>
                        <td style={{ padding: '5px 0', borderBottom: `1px solid ${borderColor}`, textAlign: 'right', color: diffColor(r.total, isDark), fontWeight: 'bold' }}>
                          {formatSignedMin(r.total)}
                        </td>
                      </tr>
                    ))}
                    <tr>
                      <td style={{ padding: '5px 0', fontWeight: 'bold' }}>小計</td>
                      <td style={{ padding: '5px 0', textAlign: 'right', fontWeight: 'bold', color: diffColor(sub, isDark) }}>{formatSignedMin(sub)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            );
          })}
          <div style={{ background: innerBg, borderRadius: 8, padding: '10px 12px', display: 'flex', justifyContent: 'space-between', fontSize: 14, fontWeight: 'bold', color: text }}>
            <span>総合計</span>
            <span style={{ color: diffColor(total, isDark) }}>{formatSignedMin(total)}</span>
          </div>
          <p style={{ margin: '8px 0 0', fontSize: 11.5, color: subText }}>確認済み（確定）分のみを集計しています</p>
        </>
      )}
    </div>
  );
};

export default OvertimePage;

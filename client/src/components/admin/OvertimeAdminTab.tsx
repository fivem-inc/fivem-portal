import React, { useState, useEffect, useCallback } from 'react';
import { useAdminPanel } from './AdminPanelContext';
import OvertimeShiftImport from './OvertimeShiftImport';
import {
  calcPatternFields, timeToMin, minToTime, formatMin, formatSignedMin, todayJstStr,
  DAY_KIND_LABELS, CALENDAR_KIND_LABELS,
} from '../../lib/breakCalc';
import type { DayKind, CalendarKind } from '../../lib/breakCalc';
import { DEFAULT_LOCATION } from '../../lib/shiftExcelImport';
import { HistoryBadge, DiffList, type ChangeKind } from './editHistoryBadge';
import OvertimeEditModal, { type OvertimeRecord } from './OvertimeEditModal';
import { OT_TYPE_INFO, isOvertimeType } from '../../lib/overtimeTypes';

const OT_STATUS_LABEL: Record<string, { label: string; color: string }> = {
  requested:         { label: '事前申請', color: '#f59e0b' },
  request_confirmed: { label: '事前受理済み', color: '#2e7d32' },
  reported:          { label: '実績報告', color: '#f59e0b' },
  confirmed:         { label: '確認済み', color: '#1565c0' },
  returned:          { label: '差し戻し', color: '#dc3545' },
  cancelled:         { label: '取消済み', color: '#6c757d' },
};
const OT_FIELD_LABELS: Record<string, string> = { work_date: '勤務日', segments: '時間帯', break_minutes: '休憩', diff_minutes: '差分時間', location: '校', reason: '理由' };
const OT_KIND_LABELS: Partial<Record<ChangeKind, string>> = { resubmit: '本人が再提出' };

interface OtHistoryRow {
  id: string;
  change_kind: ChangeKind | null;
  change_summary: string | null;
  change_reason: string | null;
  changes: Record<string, { old: unknown; new: unknown }> | null;
  changed_by: string | null;
  changed_at: string;
  changerName?: string;
}

// 残業・時間管理の管理タブ：曜日パターン／会社カレンダー／設定

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

interface CalendarRow {
  date: string;
  kind: CalendarKind;
  note: string | null;
}

interface StaffRow {
  id: string;
  name: string;
  role_title: string;
  employment_type: string | null;
}

const DAY_ORDER: DayKind[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun', 'holiday', 'work_on_closed'];
// 週の労働時間合計に含める曜日（祝・出は特別区分なので除く）
const WEEK_DAYS: DayKind[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

// 役職の序列（社長＞マネージャー＞リーダー＞フロア責任者＞一般）。スタッフ一覧の並び順に使う
const ROLE_RANK: Record<string, number> = {
  '社長': 1, '管理者': 1, 'マネージャー': 2, 'リーダー': 3, 'フロア責任者': 4, '一般': 5,
};
const ROLE_GROUP_ORDER = ['社長', '管理者', 'マネージャー', 'リーダー', 'フロア責任者', '一般'];

const OvertimeAdminTab: React.FC = () => {
  const ctx = useAdminPanel();
  const { isDarkMode, supabase } = ctx;

  const [section, setSection] = useState<'reports' | 'patterns' | 'calendar' | 'settings'>('reports');

  // ─────────── 受理済み一覧（残業レコードの管理） ───────────
  const [otReports, setOtReports] = useState<OvertimeRecord[]>([]);
  const [otStatusMap, setOtStatusMap] = useState<Record<string, string>>({});
  const [otLoading, setOtLoading] = useState(false);
  const [otMsg, setOtMsg] = useState('');
  const [otErr, setOtErr] = useState('');
  const [editingOt, setEditingOt] = useState<OvertimeRecord | null>(null);
  const [otHistoryOpen, setOtHistoryOpen] = useState<Set<string>>(new Set());
  const [otHistory, setOtHistory] = useState<Record<string, OtHistoryRow[]>>({});
  const [otHistoryExistIds, setOtHistoryExistIds] = useState<Set<string>>(new Set());
  const [otReturnTarget, setOtReturnTarget] = useState<OvertimeRecord | null>(null);
  const [otReturnComment, setOtReturnComment] = useState('');
  const [otDeleteTarget, setOtDeleteTarget] = useState<OvertimeRecord | null>(null);
  const [otCancelTarget, setOtCancelTarget] = useState<OvertimeRecord | null>(null);
  const [otActing, setOtActing] = useState(false);

  const fetchOtReports = useCallback(async () => {
    setOtLoading(true); setOtErr('');
    const { data, error } = await supabase.from('overtime_reports')
      .select('id, applicant_id, work_date, entry_type, status, normal_shift, break_minutes, break_manual, labor_minutes, diff_minutes, reason, location, application_types')
      .eq('entry_type', 'manual')
      .order('work_date', { ascending: false }).limit(300);
    if (error) { setOtErr('読み込みに失敗しました：' + error.message); setOtLoading(false); return; }
    const rows = data || [];
    const ids = rows.map((r: { id: string }) => r.id);
    const applicantIds = [...new Set(rows.map((r: { applicant_id: string }) => r.applicant_id))];
    const [{ data: segs }, { data: profs }, { data: histIds }] = await Promise.all([
      ids.length ? supabase.from('overtime_report_segments').select('report_id, phase, seg_no, start_min, end_min').in('report_id', ids) : Promise.resolve({ data: [] }),
      applicantIds.length ? supabase.from('profiles').select('id, name').in('id', applicantIds) : Promise.resolve({ data: [] }),
      ids.length ? supabase.from('overtime_report_history').select('report_id').in('report_id', ids) : Promise.resolve({ data: [] }),
    ]);
    setOtHistoryExistIds(new Set((histIds || []).map((h: { report_id: string }) => h.report_id)));
    const nameMap = Object.fromEntries((profs || []).map((p: { id: string; name: string }) => [p.id, p.name]));
    const segMap: Record<string, { phase: 'planned' | 'actual'; seg_no: number; start_min: number; end_min: number }[]> = {};
    (segs || []).forEach((s: { report_id: string; phase: 'planned' | 'actual'; seg_no: number; start_min: number; end_min: number }) => {
      (segMap[s.report_id] = segMap[s.report_id] || []).push(s);
    });
    const statusMap: Record<string, string> = {};
    setOtReports(rows.map((r: { id: string; applicant_id: string; work_date: string; entry_type: string; status: string; normal_shift: OvertimeRecord['normal_shift']; break_minutes: number | null; break_manual: boolean; labor_minutes: number | null; diff_minutes: number | null; reason: string | null; location: string | null; application_types: string[] | null }) => {
      statusMap[r.id] = r.status;
      return { id: r.id, applicant_id: r.applicant_id, applicantName: nameMap[r.applicant_id] || '不明', work_date: r.work_date, entry_type: r.entry_type, normal_shift: r.normal_shift, break_minutes: r.break_minutes, break_manual: r.break_manual, labor_minutes: r.labor_minutes, diff_minutes: r.diff_minutes, reason: r.reason, location: r.location, application_types: r.application_types, segments: segMap[r.id] || [] };
    }));
    setOtStatusMap(statusMap);
    setOtLoading(false);
  }, [supabase]);

  useEffect(() => { if (section === 'reports') fetchOtReports(); }, [section, fetchOtReports]);

  const loadOtHistory = useCallback(async (reportId: string, force = false) => {
    if (!force && otHistory[reportId]) return;
    const { data } = await supabase.from('overtime_report_history')
      .select('id, change_kind, change_summary, change_reason, changes, changed_by, changed_at')
      .eq('report_id', reportId).order('changed_at', { ascending: false });
    const rows = (data || []) as OtHistoryRow[];
    const ids = [...new Set(rows.map(r => r.changed_by).filter(Boolean))] as string[];
    let nm: Record<string, string> = {};
    if (ids.length) { const { data: p } = await supabase.from('profiles').select('id, name').in('id', ids); nm = Object.fromEntries((p || []).map((x: { id: string; name: string }) => [x.id, x.name])); }
    setOtHistory(prev => ({ ...prev, [reportId]: rows.map(r => ({ ...r, changerName: r.changed_by ? (nm[r.changed_by] || '不明') : '管理者' })) }));
  }, [supabase, otHistory]);

  // GCal同期の再計算（受理後の修正・差戻し・取消・削除でカレンダーの整合を保つ）。
  // 失敗しても操作自体は完了しているため、警告として表示する。
  const syncOvertimeGcal = async (reportId: string): Promise<boolean> => {
    const { data, error } = await supabase.functions.invoke('gcal-sync', {
      body: { action: 'sync', source_type: 'overtime', source_id: reportId },
    });
    const res = data as { success?: boolean } | null;
    return !error && res?.success !== false;
  };

  const doOtReturn = async () => {
    if (!otReturnTarget || !otReturnComment.trim()) return;
    setOtActing(true);
    const r = otReturnTarget;
    await supabase.from('overtime_report_history').insert({
      report_id: r.id, changed_by: (await supabase.auth.getUser()).data.user?.id, change_kind: 'rejected',
      change_summary: `差し戻し：${otReturnComment.trim()}`, change_reason: otReturnComment.trim(),
      snapshot: r as unknown as Record<string, unknown>,
    }).then(null, () => {});
    const { error } = await supabase.from('overtime_reports').update({ status: 'returned', return_comment: otReturnComment.trim() }).eq('id', r.id);
    if (error) { setOtErr('差し戻しに失敗しました：' + error.message); setOtActing(false); return; }
    await supabase.from('notifications').insert({
      user_id: r.applicant_id, message: '残業・時間調整の申請が差し戻されました',
      sub_message: `${r.work_date}　理由：${otReturnComment.trim()}`, source_type: 'overtime_request:pending_resubmit',
      reference_id: r.id, event_key: 'overtime:returned', read: false,
    }).then(null, () => {});
    const gcalOk = await syncOvertimeGcal(r.id);
    setOtReturnTarget(null); setOtReturnComment(''); setOtActing(false);
    setOtMsg('差し戻しました');
    if (!gcalOk) setOtErr('差し戻しは完了しましたが、Googleカレンダーへの反映に失敗しました。');
    fetchOtReports();
  };

  const doOtDelete = async () => {
    if (!otDeleteTarget) return;
    setOtActing(true);
    const targetId = otDeleteTarget.id;
    const { data: deleted, error } = await supabase.from('overtime_reports').delete().eq('id', targetId).select('id');
    if (error) { setOtErr('削除に失敗しました：' + error.message); setOtActing(false); return; }
    if (!deleted || deleted.length === 0) { setOtErr('削除できませんでした（権限/RLSの可能性）。'); setOtActing(false); return; }
    // 削除後に同期→レコード無しとしてカレンダーイベントも削除される
    const gcalOk = await syncOvertimeGcal(targetId);
    setOtDeleteTarget(null); setOtActing(false);
    setOtMsg('削除しました');
    if (!gcalOk) setOtErr('削除は完了しましたが、Googleカレンダーへの反映に失敗しました。');
    fetchOtReports();
  };

  // 論理取消（判子）。status='cancelled' にすると、紐づくopen依頼はトリガーが自動で対応済みにし本人へ通知する。
  const doOtCancel = async () => {
    if (!otCancelTarget) return;
    setOtActing(true);
    const { data: updated, error } = await supabase.from('overtime_reports').update({ status: 'cancelled' }).eq('id', otCancelTarget.id).select('id');
    if (error) { setOtErr('取消に失敗しました：' + error.message); setOtActing(false); return; }
    if (!updated || updated.length === 0) { setOtErr('取消できませんでした（権限/RLSの可能性）。'); setOtActing(false); return; }
    const gcalOk = await syncOvertimeGcal(otCancelTarget.id);
    setOtCancelTarget(null); setOtActing(false);
    setOtMsg('取り消しました');
    if (!gcalOk) setOtErr('取消は完了しましたが、Googleカレンダーへの反映に失敗しました。');
    fetchOtReports();
  };

  // CSV出力：元の勤務時間（通常シフト）と、実際の時間帯・差分を並べて「どう変わったか」を可視化する
  const exportOtCsv = () => {
    const esc = (v: string | number) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const fmtT = (t: unknown) => (typeof t === 'string' && t ? t.slice(0, 5) : '');
    const headers = ['申請者', '勤務日', '状況', '通常シフト開始', '通常シフト終了', '通常シフト実労働', '実際の勤務時間帯', '休憩(分)', '実労働', '差分(元→実績)', '校', '理由'];
    const rows = otReports.map(r => {
      const ns = (r.normal_shift ?? {}) as Record<string, unknown>;
      const actualSegs = r.segments.filter(s => s.phase === (r.segments.some(x => x.phase === 'actual') ? 'actual' : 'planned')).sort((a, b) => a.seg_no - b.seg_no);
      const segText = actualSegs.length ? actualSegs.map(s => `${minToTime(s.start_min)}〜${minToTime(s.end_min)}`).join('、') : '';
      const normLabor = typeof ns.labor_minutes === 'number' ? formatMin(ns.labor_minutes) : '';
      return [
        r.applicantName ?? '', r.work_date, OT_STATUS_LABEL[otStatusMap[r.id]]?.label ?? otStatusMap[r.id] ?? '',
        fmtT(ns.start_time), fmtT(ns.end_time), normLabor,
        segText, r.break_minutes ?? 0, formatMin(r.labor_minutes ?? 0), formatSignedMin(r.diff_minutes ?? 0),
        r.location ?? '', r.reason ?? '',
      ].map(esc).join(',');
    });
    const csv = '﻿' + [headers.map(esc).join(','), ...rows].join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `残業_受理済み一覧_${todayJstStr()}.csv`;
    a.click(); URL.revokeObjectURL(url);
  };

  const text = isDarkMode ? '#f8f9fa' : '#212529';
  const subText = isDarkMode ? '#adb5bd' : '#6c757d';
  const borderColor = isDarkMode ? '#495057' : '#dee2e6';
  const cardBg = isDarkMode ? '#343a40' : '#fff';
  const innerBg = isDarkMode ? '#2b3035' : '#f8f9fa';
  const inputStyle: React.CSSProperties = {
    padding: '7px 10px', borderRadius: 8, border: `1px solid ${borderColor}`,
    background: isDarkMode ? '#495057' : '#fff', color: text, fontSize: 13,
  };

  // ─────────── 曜日パターン ───────────
  const [staff, setStaff] = useState<StaffRow[]>([]);
  const [selectedStaffId, setSelectedStaffId] = useState('');
  const [patterns, setPatterns] = useState<PatternRow[]>([]);
  const [editTimes, setEditTimes] = useState<Record<string, { start: string; end: string; start2: string; end2: string; location: string }>>({});
  const [applyFrom, setApplyFrom] = useState(() => todayJstStr());
  const [patternMsg, setPatternMsg] = useState('');
  const [patternErr, setPatternErr] = useState('');
  const [savingPattern, setSavingPattern] = useState(false);
  // 全員の現在の適用パターン一覧（いま何が適用されているかの確認用）
  const [overview, setOverview] = useState<{ staffId: string; name: string; role: string; days: Record<string, PatternRow | undefined> }[]>([]);
  const [showOverview, setShowOverview] = useState(false);

  const fetchStaff = useCallback(async () => {
    // 全アクティブスタッフを取得（Excel照合でパートも判定に使うため）。ドロップダウンは正社員のみ表示
    const { data } = await supabase.from('profiles')
      .select('id, name, role_title, employment_type')
      .eq('is_active', true)
      .order('name');
    // 役職の序列順に並べ替え（社長＞マネージャー＞リーダー＞フロア責任者＞一般）。同役職内は名前順
    const rows = (data as StaffRow[] | null) ?? [];
    rows.sort((a, b) =>
      (ROLE_RANK[a.role_title] ?? 99) - (ROLE_RANK[b.role_title] ?? 99)
      || a.name.localeCompare(b.name, 'ja'));
    setStaff(rows);
  }, [supabase]);

  const fetchPatterns = useCallback(async (userId: string) => {
    if (!userId) { setPatterns([]); return; }
    const { data } = await supabase.from('weekly_shift_patterns')
      .select('*').eq('user_id', userId).order('valid_from', { ascending: false });
    const rows = (data as PatternRow[] | null) ?? [];
    setPatterns(rows);
    // 現在有効なパターンを編集欄へ
    const today = todayJstStr();
    const active = rows.filter(p => p.valid_from <= today && (p.valid_to === null || p.valid_to >= today));
    const next: Record<string, { start: string; end: string; start2: string; end2: string; location: string }> = {};
    for (const k of DAY_ORDER) {
      const p = active.find(x => x.day_kind === k);
      next[k] = {
        start: p?.start_time?.slice(0, 5) ?? '', end: p?.end_time?.slice(0, 5) ?? '',
        start2: p?.start_time2?.slice(0, 5) ?? '', end2: p?.end_time2?.slice(0, 5) ?? '',
        location: p?.location ?? '',
      };
    }
    setEditTimes(next);
  }, [supabase]);

  // 全員の「今日時点で有効な」曜日パターンを集めて一覧化
  const fetchOverview = useCallback(async () => {
    const { data } = await supabase.from('weekly_shift_patterns')
      .select('id, user_id, day_kind, start_time, end_time, start_time2, end_time2, location, break_minutes, labor_minutes, valid_from, valid_to');
    const rows = (data as PatternRow[] | null) ?? [];
    const today = todayJstStr();
    const seishain = staff.filter(s => s.employment_type !== 'パート');
    const list = seishain.map(s => {
      const days: Record<string, PatternRow | undefined> = {};
      for (const k of DAY_ORDER) {
        days[k] = rows.find(p => p.user_id === s.id && p.day_kind === k
          && p.valid_from <= today && (p.valid_to === null || p.valid_to >= today));
      }
      return { staffId: s.id, name: s.name, role: s.role_title, days };
    }).filter(x => DAY_ORDER.some(k => x.days[k] !== undefined)); // 未登録の人は出さない
    setOverview(list);
  }, [supabase, staff]);

  useEffect(() => { fetchStaff(); }, [fetchStaff]);
  useEffect(() => { fetchPatterns(selectedStaffId); setPatternMsg(''); setPatternErr(''); }, [selectedStaffId, fetchPatterns]);
  useEffect(() => { if (section === 'patterns' && staff.length > 0) fetchOverview(); }, [section, staff, fetchOverview]);

  const savePatterns = async () => {
    setPatternErr(''); setPatternMsg('');
    if (!selectedStaffId) { setPatternErr('スタッフを選択してください'); return; }
    if (!applyFrom) { setPatternErr('適用開始日を入力してください'); return; }
    // 入力チェック
    for (const k of DAY_ORDER) {
      const t = editTimes[k] ?? { start: '', end: '', start2: '', end2: '', location: '' };
      if ((t.start && !t.end) || (!t.start && t.end)) {
        setPatternErr(`${DAY_KIND_LABELS[k]}の開始・終了を両方入力してください（休みの場合は両方空欄）`);
        return;
      }
      const s = timeToMin(t.start); const e = timeToMin(t.end);
      if (s != null && e != null && e <= s) {
        setPatternErr(`${DAY_KIND_LABELS[k]}の終了時刻は開始より後にしてください`);
        return;
      }
      if ((t.start2 && !t.end2) || (!t.start2 && t.end2)) {
        setPatternErr(`${DAY_KIND_LABELS[k]}の2つ目の時間帯は開始・終了を両方入力してください`);
        return;
      }
      const s2 = timeToMin(t.start2); const e2 = timeToMin(t.end2);
      if (s2 != null && e2 != null && e2 <= s2) {
        setPatternErr(`${DAY_KIND_LABELS[k]}の2つ目の時間帯の終了は開始より後にしてください`);
        return;
      }
      if (s2 != null && s == null) {
        setPatternErr(`${DAY_KIND_LABELS[k]}は1つ目の時間帯を入力してから2つ目を入力してください`);
        return;
      }
    }
    setSavingPattern(true);
    try {
      const prevDay = (() => {
        const [y, m, d] = applyFrom.split('-').map(Number);
        const dt = new Date(y, m - 1, d - 1);
        return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
      })();

      for (const k of DAY_ORDER) {
        const t = editTimes[k] ?? { start: '', end: '', start2: '', end2: '', location: '' };
        // 適用開始日以降と重なる既存行を締める/消す
        const overlapping = patterns.filter(p =>
          p.day_kind === k && (p.valid_to === null || p.valid_to >= applyFrom));
        for (const p of overlapping) {
          if (p.valid_from >= applyFrom) {
            await supabase.from('weekly_shift_patterns').delete().eq('id', p.id);
          } else {
            await supabase.from('weekly_shift_patterns').update({ valid_to: prevDay }).eq('id', p.id);
          }
        }
        const s = timeToMin(t.start); const e = timeToMin(t.end);
        const s2 = timeToMin(t.start2); const e2 = timeToMin(t.end2);
        const isWork = s != null && e != null;
        const { breakMinutes, laborMinutes } = calcPatternFields({ start: s, end: e }, { start: s2, end: e2 });
        const { error } = await supabase.from('weekly_shift_patterns').insert({
          user_id: selectedStaffId,
          day_kind: k,
          start_time: t.start || null,
          end_time: t.end || null,
          start_time2: (s2 != null) ? t.start2 : null,
          end_time2: (e2 != null) ? t.end2 : null,
          location: isWork ? (t.location.trim() || DEFAULT_LOCATION) : null,
          break_minutes: breakMinutes,
          labor_minutes: laborMinutes,
          valid_from: applyFrom,
          valid_to: null,
        });
        if (error) throw error;
      }
      setPatternMsg(`保存しました（${applyFrom} から適用）`);
      fetchPatterns(selectedStaffId);
      fetchOverview();
    } catch (e) {
      setPatternErr('保存に失敗しました: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setSavingPattern(false);
    }
  };

  // ─────────── 会社カレンダー ───────────
  const [calRows, setCalRows] = useState<CalendarRow[]>([]);
  const [calDate, setCalDate] = useState('');
  const [calKind, setCalKind] = useState<CalendarKind>('closed_all');
  const [calNote, setCalNote] = useState('');
  const [calErr, setCalErr] = useState('');
  const [calMsg, setCalMsg] = useState('');
  const [calDeleteTarget, setCalDeleteTarget] = useState<string | null>(null);

  const fetchCalendar = useCallback(async () => {
    const { data } = await supabase.from('company_calendar')
      .select('date, kind, note')
      .gte('date', `${new Date().getFullYear() - 1}-01-01`)
      .order('date', { ascending: true });
    setCalRows((data as CalendarRow[] | null) ?? []);
  }, [supabase]);

  useEffect(() => { if (section === 'calendar') fetchCalendar(); }, [section, fetchCalendar]);

  const addCalendar = async () => {
    setCalErr(''); setCalMsg('');
    if (!calDate) { setCalErr('日付を選択してください'); return; }
    const { error } = await supabase.from('company_calendar')
      .upsert({ date: calDate, kind: calKind, note: calNote || null });
    if (error) { setCalErr('保存に失敗しました: ' + error.message); return; }
    setCalMsg(`${calDate} を「${CALENDAR_KIND_LABELS[calKind]}」として保存しました`);
    setCalDate(''); setCalNote('');
    fetchCalendar();
  };

  const deleteCalendar = async (date: string) => {
    await supabase.from('company_calendar').delete().eq('date', date);
    setCalDeleteTarget(null);
    fetchCalendar();
  };

  // ─────────── 設定 ───────────
  const [thresholdHours, setThresholdHours] = useState('10');
  const [thresholdMins, setThresholdMins] = useState('0');
  const [groupOptions, setGroupOptions] = useState<string[]>([]);
  const [bannerGroups, setBannerGroups] = useState<string[]>([]);
  const [settingsMsg, setSettingsMsg] = useState('');
  const [settingsErr, setSettingsErr] = useState('');

  const fetchSettings = useCallback(async () => {
    const [setRes, grpRes] = await Promise.all([
      supabase.from('overtime_settings').select('threshold_minutes, banner_group_names').eq('id', 1).maybeSingle(),
      supabase.from('master_options').select('value').eq('category', 'group').order('sort_order'),
    ]);
    const th = (setRes.data?.threshold_minutes as number | undefined) ?? 600;
    setThresholdHours(String(Math.floor(th / 60)));
    setThresholdMins(String(th % 60));
    setBannerGroups((setRes.data?.banner_group_names as string[] | null) ?? []);
    setGroupOptions(((grpRes.data as { value: string }[] | null) ?? []).map(g => g.value));
  }, [supabase]);

  useEffect(() => { if (section === 'settings') fetchSettings(); }, [section, fetchSettings]);

  const saveSettings = async () => {
    setSettingsErr(''); setSettingsMsg('');
    const h = parseInt(thresholdHours, 10);
    const m = parseInt(thresholdMins, 10);
    if (isNaN(h) || h < 0 || isNaN(m) || m < 0 || m > 59) {
      setSettingsErr('しきい値は「時間（0以上）」「分（0〜59）」で入力してください');
      return;
    }
    const { error } = await supabase.from('overtime_settings')
      .update({ threshold_minutes: h * 60 + m, banner_group_names: bannerGroups })
      .eq('id', 1);
    if (error) { setSettingsErr('保存に失敗しました: ' + error.message); return; }
    setSettingsMsg('設定を保存しました');
  };

  // ─────────── render ───────────
  const sectionBtn = (key: typeof section, label: string) => (
    <button key={key} onClick={() => setSection(key)}
      style={{
        flex: 1, padding: '9px 0', borderRadius: 8, cursor: 'pointer', fontSize: 13,
        fontWeight: section === key ? 'bold' : 'normal',
        border: section === key ? '2px solid #007bff' : `1px solid ${borderColor}`,
        background: section === key ? (isDarkMode ? '#1e3a5f' : '#e7f1ff') : 'transparent',
        color: section === key ? (isDarkMode ? '#8fc5f6' : '#0d6efd') : subText,
      }}>
      {label}
    </button>
  );

  return (
    <div>
      <h3 style={{ margin: '0 0 4px', fontSize: 16, color: text }}>⏱ 残業・時間管理（正社員）</h3>
      <p style={{ margin: '0 0 12px', fontSize: 12, color: subText }}>
        通常シフトの曜日パターン・会社カレンダー・超過バナーの設定を管理します
      </p>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        {sectionBtn('reports', '受理済み一覧')}
        {sectionBtn('patterns', '曜日パターン')}
        {sectionBtn('calendar', '会社カレンダー')}
        {sectionBtn('settings', '設定')}
      </div>

      {/* ─── 受理済み一覧（修正／差戻／削除／履歴） ─── */}
      {section === 'reports' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
            <p style={{ fontSize: 12, color: subText, margin: 0, flex: 1, minWidth: 200 }}>
              正社員の残業・時間調整の記録一覧です。受理済みも含めて修正・差し戻し・削除ができます（自動計上分は対象外）。
            </p>
            <button onClick={exportOtCsv} disabled={otReports.length === 0}
              style={{ flexShrink: 0, padding: '6px 14px', borderRadius: 8, border: 'none', background: otReports.length === 0 ? '#6c757d' : '#28a745', color: '#fff', fontSize: 13, fontWeight: 'bold', cursor: otReports.length === 0 ? 'default' : 'pointer' }}>
              📥 CSV出力
            </button>
          </div>
          {otMsg && <div style={{ padding: 10, background: isDarkMode ? '#0f2e1a' : '#e8f5e9', border: '1px solid #28a745', borderRadius: 8, color: isDarkMode ? '#7ee2a8' : '#1b5e20', fontSize: 13, marginBottom: 10 }}>{otMsg}</div>}
          {otErr && <div style={{ padding: 10, background: isDarkMode ? '#3a1414' : '#fff5f5', border: '1px solid #f5c2c7', borderRadius: 8, color: isDarkMode ? '#fca5a5' : '#842029', fontSize: 13, marginBottom: 10 }}>{otErr}</div>}
          {otLoading ? (
            <p style={{ color: subText, fontSize: 13 }}>読み込み中...</p>
          ) : otReports.length === 0 ? (
            <p style={{ color: subText, fontSize: 13 }}>記録はありません</p>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', color: text, fontSize: 13 }}>
                <thead>
                  <tr style={{ background: isDarkMode ? '#495057' : '#f8f9fa' }}>
                    {[
                      { label: '申請者', w: 70 }, { label: '勤務日', w: 78 }, { label: '勤務時間（元/実）', w: 160 },
                      { label: '休憩/実労働', w: 90 }, { label: '校（元→実）', w: 72 }, { label: '差分', w: 55 },
                      { label: '状況', w: 70 }, { label: '操作', w: 150 },
                    ].map(col => (
                      <th key={col.label} style={{ padding: '8px 4px', textAlign: 'center', borderBottom: `1px solid ${borderColor}`, width: col.w, fontSize: 12 }}>{col.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {otReports.map(r => {
                    const st = otStatusMap[r.id];
                    const stInfo = OT_STATUS_LABEL[st] ?? { label: st, color: '#6c757d' };
                    const actualSegs = r.segments.filter(s => s.phase === (r.segments.some(x => x.phase === 'actual') ? 'actual' : 'planned')).sort((a, b) => a.seg_no - b.seg_no);
                    const segText = actualSegs.length ? actualSegs.map(s => `${minToTime(s.start_min)}〜${minToTime(s.end_min)}`).join('、') : '(なし)';
                    const ns = (r.normal_shift ?? {}) as { start_time?: string | null; end_time?: string | null; location?: string | null };
                    const nsTime = ns.start_time ? `${String(ns.start_time).slice(0, 5)}〜${ns.end_time ? String(ns.end_time).slice(0, 5) : ''}` : '休み';
                    const nsLoc = ns.location || '';
                    const isOpen = otHistoryOpen.has(r.id);
                    const cell: React.CSSProperties = { padding: '7px 4px', borderBottom: `1px solid ${borderColor}`, textAlign: 'center', verticalAlign: 'top' };
                    return (
                      <React.Fragment key={r.id}>
                        <tr>
                          <td style={{ ...cell, fontWeight: 'bold', textAlign: 'left' }}>{r.applicantName}</td>
                          <td style={{ ...cell, whiteSpace: 'nowrap' }}>{r.work_date}</td>
                          <td style={{ ...cell, textAlign: 'left', fontSize: 12 }}>
                            <div style={{ color: subText, fontSize: 11 }}>元 {nsTime}</div>
                            <div>実 {segText}</div>
                            {(r.application_types ?? []).filter(isOvertimeType).length > 0 && (
                              <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap', marginTop: 2 }}>
                                {(r.application_types ?? []).filter(isOvertimeType).map(t => (
                                  <span key={t} style={{ padding: '1px 6px', borderRadius: 6, border: `1px solid ${OT_TYPE_INFO[t].color}`, color: isDarkMode ? '#fff' : OT_TYPE_INFO[t].color, background: isDarkMode ? OT_TYPE_INFO[t].darkBg : `${OT_TYPE_INFO[t].color}1a`, fontSize: 10, fontWeight: 'bold', whiteSpace: 'nowrap' }}>
                                    {OT_TYPE_INFO[t].label}
                                  </span>
                                ))}
                              </div>
                            )}
                            {r.reason && <div style={{ color: subText, fontSize: 11, marginTop: 2 }}>{r.reason}</div>}
                          </td>
                          <td style={{ ...cell, fontSize: 12, whiteSpace: 'nowrap' }}>休{r.break_minutes ?? 0}分<br />{formatMin(r.labor_minutes ?? 0)}</td>
                          <td style={{ ...cell, fontSize: 12 }}>
                            {nsLoc && nsLoc !== (r.location || '') ? (
                              <><span style={{ color: subText, fontSize: 11 }}>{nsLoc}</span><br /><span>↓</span><br />{r.location || '—'}</>
                            ) : (r.location || nsLoc || '—')}
                          </td>
                          <td style={{ ...cell, fontWeight: 'bold', whiteSpace: 'nowrap' }}>{formatSignedMin(r.diff_minutes ?? 0)}</td>
                          <td style={cell}><span style={{ padding: '2px 6px', borderRadius: 6, background: stInfo.color, color: '#fff', fontSize: 10, fontWeight: 'bold', whiteSpace: 'nowrap' }}>{stInfo.label}</span></td>
                          <td style={cell}>
                            <div style={{ display: 'flex', gap: 3, justifyContent: 'center', flexWrap: 'wrap' }}>
                              <button onClick={() => setEditingOt(r)} style={{ padding: '3px 8px', borderRadius: 6, border: 'none', background: '#fd7e14', color: '#fff', cursor: 'pointer', fontSize: 11, fontWeight: 'bold' }}>🖊修正</button>
                              {st !== 'returned' && st !== 'cancelled' && (
                                <button onClick={() => { setOtReturnTarget(r); setOtReturnComment(''); }} style={{ padding: '3px 8px', borderRadius: 6, border: 'none', background: '#dc3545', color: '#fff', cursor: 'pointer', fontSize: 11, fontWeight: 'bold' }}>差戻</button>
                              )}
                              {st !== 'cancelled' && r.entry_type === 'manual' && (
                                <button onClick={() => setOtCancelTarget(r)} style={{ padding: '3px 8px', borderRadius: 6, border: '1px solid #6c757d', background: 'transparent', color: subText, cursor: 'pointer', fontSize: 11 }}>取消</button>
                              )}
                              <button onClick={() => setOtDeleteTarget(r)} style={{ padding: '3px 8px', borderRadius: 6, border: `1px solid ${borderColor}`, background: 'transparent', color: subText, cursor: 'pointer', fontSize: 11 }}>削除</button>
                              {otHistoryExistIds.has(r.id) && (
                                <button onClick={() => { if (!isOpen) loadOtHistory(r.id); setOtHistoryOpen(prev => { const n = new Set(prev); isOpen ? n.delete(r.id) : n.add(r.id); return n; }); }} style={{ padding: '3px 8px', borderRadius: 6, border: '1px solid #fd7e14', background: 'transparent', color: '#fd7e14', cursor: 'pointer', fontSize: 11 }}>{isOpen ? '▼履歴' : '▶履歴'}</button>
                              )}
                            </div>
                          </td>
                        </tr>
                        {isOpen && (
                          <tr>
                            <td colSpan={8} style={{ padding: '8px 12px', background: isDarkMode ? '#2a1e00' : '#fff8f0', borderBottom: `2px solid #fd7e14`, borderLeft: '4px solid #fd7e14' }}>
                              <div style={{ fontSize: 12, fontWeight: 'bold', color: isDarkMode ? '#ffe082' : '#7c4d00', marginBottom: 6 }}>修正履歴</div>
                              {!otHistory[r.id] ? <p style={{ fontSize: 12, color: subText, margin: 0 }}>読み込み中...</p>
                                : otHistory[r.id].length === 0 ? <p style={{ fontSize: 12, color: subText, margin: 0 }}>履歴なし</p>
                                : (
                                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                                    {otHistory[r.id].map(h => (
                                      <div key={h.id} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                                        {h.change_kind && <HistoryBadge kind={h.change_kind} isDarkMode={isDarkMode} labelOverride={OT_KIND_LABELS} />}
                                        <div style={{ fontSize: 12 }}>
                                          <div style={{ color: subText }}>{new Date(h.changed_at).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}　{h.changerName}</div>
                                          {h.changes ? <DiffList changes={h.changes} fieldLabels={OT_FIELD_LABELS} isDarkMode={isDarkMode} /> : <span style={{ color: text }}>{h.change_summary}</span>}
                                          {h.change_reason && <div style={{ color: subText, marginTop: 2 }}>理由：{h.change_reason}</div>}
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                )}
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* 修正モーダル */}
          {editingOt && (
            <OvertimeEditModal
              record={editingOt}
              isDarkMode={isDarkMode}
              onClose={() => setEditingOt(null)}
              onSaved={() => {
                const id = editingOt.id;
                setEditingOt(null);
                setOtMsg('残業・時間調整を修正し、本人へ通知しました');
                fetchOtReports();
                setOtHistoryExistIds(prev => new Set(prev).add(id));
                setOtHistoryOpen(prev => new Set(prev).add(id));
                loadOtHistory(id, true);
              }}
            />
          )}

          {/* 差戻し確認 */}
          {otReturnTarget && (
            <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
              <div style={{ background: cardBg, borderRadius: 14, padding: 22, width: '100%', maxWidth: 380 }}>
                <div style={{ fontSize: 15, fontWeight: 'bold', color: text, marginBottom: 6 }}>差し戻し</div>
                <div style={{ fontSize: 13, color: subText, marginBottom: 12 }}>{otReturnTarget.applicantName}　{otReturnTarget.work_date}</div>
                <textarea value={otReturnComment} onChange={e => setOtReturnComment(e.target.value)} placeholder="差し戻し理由（本人へ通知）" rows={3} style={{ width: '100%', boxSizing: 'border-box', padding: 10, borderRadius: 8, border: `1px solid ${borderColor}`, background: isDarkMode ? '#495057' : '#fff', color: text, fontSize: 13, marginBottom: 12 }} />
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={() => { setOtReturnTarget(null); setOtReturnComment(''); }} disabled={otActing} style={{ flex: 1, padding: 10, borderRadius: 8, border: `1px solid ${borderColor}`, background: 'transparent', color: text, cursor: 'pointer', fontSize: 14 }}>やめる</button>
                  <button onClick={doOtReturn} disabled={otActing || !otReturnComment.trim()} style={{ flex: 2, padding: 10, borderRadius: 8, border: 'none', background: !otReturnComment.trim() ? '#6c757d' : '#dc3545', color: '#fff', fontWeight: 'bold', cursor: 'pointer', fontSize: 14 }}>{otActing ? '処理中...' : '差し戻す'}</button>
                </div>
              </div>
            </div>
          )}

          {/* 削除確認 */}
          {otDeleteTarget && (
            <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
              <div style={{ background: cardBg, borderRadius: 14, padding: 22, width: '100%', maxWidth: 360 }}>
                <div style={{ fontSize: 15, fontWeight: 'bold', color: '#dc3545', marginBottom: 12 }}>削除の確認</div>
                <div style={{ fontSize: 13, color: text, marginBottom: 6 }}>{otDeleteTarget.applicantName}　{otDeleteTarget.work_date}　差分{formatSignedMin(otDeleteTarget.diff_minutes ?? 0)}</div>
                <div style={{ fontSize: 12, color: subText, marginBottom: 16 }}>このレコードを完全に削除します。元に戻せません。</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={() => setOtDeleteTarget(null)} disabled={otActing} style={{ flex: 1, padding: 10, borderRadius: 8, border: `1px solid ${borderColor}`, background: 'transparent', color: text, cursor: 'pointer', fontSize: 14 }}>戻る</button>
                  <button onClick={doOtDelete} disabled={otActing} style={{ flex: 2, padding: 10, borderRadius: 8, border: 'none', background: '#dc3545', color: '#fff', fontWeight: 'bold', cursor: 'pointer', fontSize: 14 }}>{otActing ? '削除中...' : '削除する'}</button>
                </div>
              </div>
            </div>
          )}

          {/* 取消確認（判子。記録は残る。取消依頼への対応にも使う） */}
          {otCancelTarget && (
            <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
              <div style={{ background: cardBg, borderRadius: 14, padding: 22, width: '100%', maxWidth: 360 }}>
                <div style={{ fontSize: 15, fontWeight: 'bold', color: '#6c757d', marginBottom: 12 }}>取消の確認</div>
                <div style={{ fontSize: 13, color: text, marginBottom: 6 }}>{otCancelTarget.applicantName}　{otCancelTarget.work_date}　差分{formatSignedMin(otCancelTarget.diff_minutes ?? 0)}</div>
                <div style={{ fontSize: 12, color: subText, marginBottom: 16 }}>「取消済み」にします（記録は残ります）。この申請への修正/取消依頼があれば、自動で対応済みになり本人へ通知されます。</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={() => setOtCancelTarget(null)} disabled={otActing} style={{ flex: 1, padding: 10, borderRadius: 8, border: `1px solid ${borderColor}`, background: 'transparent', color: text, cursor: 'pointer', fontSize: 14 }}>戻る</button>
                  <button onClick={doOtCancel} disabled={otActing} style={{ flex: 2, padding: 10, borderRadius: 8, border: 'none', background: '#6c757d', color: '#fff', fontWeight: 'bold', cursor: 'pointer', fontSize: 14 }}>{otActing ? '取消中...' : '取り消す'}</button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ─── 曜日パターン ─── */}
      {section === 'patterns' && (
        <div style={{ background: cardBg, borderRadius: 12, border: `1px solid ${borderColor}`, padding: '14px 16px' }}>
          <p style={{ margin: '0 0 10px', fontSize: 12.5, color: subText, lineHeight: 1.7 }}>
            スタッフごとの通常シフト（曜日パターン）を登録します。休みの曜日は空欄のままにしてください。<br />
            変更は「適用開始日」以降に反映され、それより前の申請・集計は変わりません（履歴型）。
          </p>

          <OvertimeShiftImport
            supabase={supabase}
            isDarkMode={isDarkMode}
            staff={staff}
            onImported={() => { if (selectedStaffId) fetchPatterns(selectedStaffId); fetchOverview(); }}
          />

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12, marginTop: 14 }}>
            <select value={selectedStaffId} onChange={e => setSelectedStaffId(e.target.value)} style={{ ...inputStyle, minWidth: 200 }}>
              <option value="">スタッフを選択</option>
              {ROLE_GROUP_ORDER.map(role => {
                const members = staff.filter(s => s.role_title === role && s.employment_type !== 'パート');
                if (members.length === 0) return null;
                return (
                  <optgroup key={role} label={role}>
                    {members.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </optgroup>
                );
              })}
              {/* 序列に載っていない役職（想定外・パートを除く）は末尾に */}
              {(() => {
                const others = staff.filter(s => !ROLE_GROUP_ORDER.includes(s.role_title) && s.employment_type !== 'パート');
                if (others.length === 0) return null;
                return (
                  <optgroup label="その他">
                    {others.map(s => <option key={s.id} value={s.id}>{s.name}（{s.role_title}）</option>)}
                  </optgroup>
                );
              })()}
            </select>
            <label style={{ fontSize: 12.5, color: subText, display: 'flex', alignItems: 'center', gap: 6 }}>
              適用開始日
              <input type="date" value={applyFrom} onChange={e => setApplyFrom(e.target.value)} style={inputStyle} />
            </label>
          </div>

          {selectedStaffId && (
            <>
              <p style={{ margin: '0 0 8px', fontSize: 11.5, color: subText }}>
                外出・戻り・テレワークがある日は「＋2つ目」に入力してください。校が空欄の日は{DEFAULT_LOCATION}になります。
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {DAY_ORDER.map(k => {
                  const t = editTimes[k] ?? { start: '', end: '', start2: '', end2: '', location: '' };
                  const s = timeToMin(t.start); const e = timeToMin(t.end);
                  const s2 = timeToMin(t.start2); const e2 = timeToMin(t.end2);
                  const valid = s != null && e != null && e > s;
                  const { breakMinutes, laborMinutes } = calcPatternFields({ start: s, end: e }, { start: s2, end: e2 });
                  const has2 = t.start2 || t.end2;
                  return (
                    <div key={k} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, padding: '6px 8px', borderRadius: 8, background: innerBg }}>
                      <span style={{ color: subText, whiteSpace: 'nowrap', minWidth: 110, fontSize: 12.5 }}>{DAY_KIND_LABELS[k]}</span>
                      <input type="time" value={t.start}
                        onChange={ev => setEditTimes(prev => ({ ...prev, [k]: { ...t, start: ev.target.value } }))}
                        style={inputStyle} />
                      <span style={{ color: subText }}>〜</span>
                      <input type="time" value={t.end}
                        onChange={ev => setEditTimes(prev => ({ ...prev, [k]: { ...t, end: ev.target.value } }))}
                        style={inputStyle} />
                      {!has2 ? (
                        <button onClick={() => setEditTimes(prev => ({ ...prev, [k]: { ...t, start2: '00:00', end2: '00:00' } }))}
                          disabled={!valid}
                          style={{ background: 'none', border: `1px dashed ${borderColor}`, borderRadius: 6, cursor: valid ? 'pointer' : 'default', padding: '5px 8px', fontSize: 11, color: valid ? '#0d6efd' : subText, opacity: valid ? 1 : 0.5 }}>
                          ＋2つ目
                        </button>
                      ) : (
                        <>
                          <span style={{ color: subText, fontSize: 11 }}>2つ目</span>
                          <input type="time" value={t.start2}
                            onChange={ev => setEditTimes(prev => ({ ...prev, [k]: { ...t, start2: ev.target.value } }))}
                            style={inputStyle} />
                          <span style={{ color: subText }}>〜</span>
                          <input type="time" value={t.end2}
                            onChange={ev => setEditTimes(prev => ({ ...prev, [k]: { ...t, end2: ev.target.value } }))}
                            style={inputStyle} />
                          <button onClick={() => setEditTimes(prev => ({ ...prev, [k]: { ...t, start2: '', end2: '' } }))}
                            aria-label="2つ目の時間帯を削除" style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, color: subText }}>🗑</button>
                        </>
                      )}
                      {valid && (
                        <input type="text" value={t.location}
                          onChange={ev => setEditTimes(prev => ({ ...prev, [k]: { ...t, location: ev.target.value } }))}
                          placeholder={DEFAULT_LOCATION}
                          style={{ ...inputStyle, width: 96 }} />
                      )}
                      {(t.start || t.end) && (
                        <button onClick={() => setEditTimes(prev => ({ ...prev, [k]: { start: '', end: '', start2: '', end2: '', location: '' } }))}
                          aria-label={`${DAY_KIND_LABELS[k]}を休みにする`}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, color: subText }}>休みにする</button>
                      )}
                      <span style={{ marginLeft: 'auto', fontSize: 11.5, color: subText, whiteSpace: 'nowrap' }}>
                        {valid ? `休憩${formatMin(breakMinutes)}・労働${formatMin(laborMinutes)}` : '休み'}
                      </span>
                    </div>
                  );
                })}
              </div>

              {(() => {
                const weekTotal = WEEK_DAYS.reduce((sum, k) => {
                  const t = editTimes[k] ?? { start: '', end: '', start2: '', end2: '', location: '' };
                  const { laborMinutes } = calcPatternFields(
                    { start: timeToMin(t.start), end: timeToMin(t.end) },
                    { start: timeToMin(t.start2), end: timeToMin(t.end2) },
                  );
                  return sum + laborMinutes;
                }, 0);
                return (
                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8, fontSize: 13, color: text }}>
                    <span style={{ color: subText }}>週の労働時間合計</span>
                    <span style={{ fontWeight: 'bold' }}>{formatMin(weekTotal)}</span>
                  </div>
                );
              })()}

              {patternErr && <p style={{ margin: '10px 0 0', fontSize: 13, color: '#dc3545' }}>{patternErr}</p>}
              {patternMsg && (
                <div style={{ background: isDarkMode ? '#1b3a1e' : '#d1e7dd', border: '1px solid #28a745', borderRadius: 8, padding: '8px 12px', marginTop: 10 }}>
                  <p style={{ margin: 0, fontSize: 13, color: isDarkMode ? '#8fd19e' : '#0f5132' }}>✅ {patternMsg}</p>
                </div>
              )}

              <button onClick={savePatterns} disabled={savingPattern}
                style={{ marginTop: 12, padding: '10px 24px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: 'bold', background: '#007bff', color: '#fff', opacity: savingPattern ? 0.6 : 1 }}>
                {savingPattern ? '保存中…' : 'この内容で保存'}
              </button>

              {/* 過去の履歴 */}
              {patterns.some(p => p.valid_to !== null) && (
                <details style={{ marginTop: 14 }}>
                  <summary style={{ fontSize: 12.5, color: subText, cursor: 'pointer' }}>過去のパターン履歴を表示</summary>
                  <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse', color: subText, marginTop: 8 }}>
                    <tbody>
                      {patterns.filter(p => p.valid_to !== null).map(p => (
                        <tr key={p.id}>
                          <td style={{ padding: '3px 4px' }}>{DAY_KIND_LABELS[p.day_kind]}</td>
                          <td style={{ padding: '3px 4px' }}>{p.start_time ? `${p.start_time.slice(0, 5)}〜${p.end_time?.slice(0, 5)}` : '休み'}</td>
                          <td style={{ padding: '3px 4px' }}>{p.valid_from}〜{p.valid_to}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </details>
              )}
            </>
          )}

          {/* いま適用されている曜日パターン一覧（全員） */}
          <div style={{ marginTop: 18, borderTop: `1px solid ${borderColor}`, paddingTop: 14 }}>
            <button onClick={() => { setShowOverview(v => !v); if (!showOverview) fetchOverview(); }}
              style={{ background: 'none', border: `1px solid ${borderColor}`, borderRadius: 8, cursor: 'pointer', padding: '8px 16px', fontSize: 13, fontWeight: 'bold', color: '#0d6efd' }}>
              📋 いま適用中のパターン一覧{showOverview ? ' を閉じる' : `（${overview.length}名）`}
            </button>

            {showOverview && (
              <div style={{ marginTop: 12 }}>
                <p style={{ margin: '0 0 8px', fontSize: 12, color: subText }}>本日（{todayJstStr()}）時点で有効な通常シフトです。</p>
                {overview.length === 0 ? (
                  <p style={{ margin: 0, fontSize: 12.5, color: subText }}>まだ登録されたパターンはありません。</p>
                ) : (
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', fontSize: 11.5, borderCollapse: 'collapse', color: text, minWidth: 720 }}>
                      <thead>
                        <tr>
                          <th style={{ padding: '6px 6px', borderBottom: `1px solid ${borderColor}`, textAlign: 'left', whiteSpace: 'nowrap', position: 'sticky', left: 0, background: cardBg }}>名前</th>
                          {WEEK_DAYS.map(k => (
                            <th key={k} style={{ padding: '6px 4px', borderBottom: `1px solid ${borderColor}`, whiteSpace: 'nowrap' }}>{DAY_KIND_LABELS[k].replace(/（.*）/, '')}</th>
                          ))}
                          <th style={{ padding: '6px 6px', borderBottom: `1px solid ${borderColor}`, whiteSpace: 'nowrap', borderLeft: `1px solid ${borderColor}` }}>週合計</th>
                        </tr>
                      </thead>
                      <tbody>
                        {overview.map(row => {
                          const weekTotal = WEEK_DAYS.reduce((sum, k) => sum + (row.days[k]?.labor_minutes ?? 0), 0);
                          return (
                          <tr key={row.staffId}>
                            <td style={{ padding: '5px 6px', borderBottom: `1px solid ${borderColor}`, whiteSpace: 'nowrap', position: 'sticky', left: 0, background: cardBg }}>{row.name}</td>
                            {WEEK_DAYS.map(k => {
                              const p = row.days[k];
                              return (
                                <td key={k} style={{ padding: '5px 4px', borderBottom: `1px solid ${borderColor}`, textAlign: 'center', whiteSpace: 'nowrap', color: p?.start_time ? text : subText }}>
                                  {p?.start_time ? (
                                    <>
                                      {p.start_time.slice(0, 5)}〜{p.end_time?.slice(0, 5)}
                                      {p.start_time2 && <><br />＋{p.start_time2.slice(0, 5)}〜{p.end_time2?.slice(0, 5)}</>}
                                      <br /><span style={{ fontSize: 10, color: subText }}>{p.location ?? DEFAULT_LOCATION}</span>
                                    </>
                                  ) : '休'}
                                </td>
                              );
                            })}
                            <td style={{ padding: '5px 6px', borderBottom: `1px solid ${borderColor}`, textAlign: 'right', whiteSpace: 'nowrap', fontWeight: 'bold', borderLeft: `1px solid ${borderColor}` }}>{formatMin(weekTotal)}</td>
                          </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ─── 会社カレンダー ─── */}
      {section === 'calendar' && (
        <div style={{ background: cardBg, borderRadius: 12, border: `1px solid ${borderColor}`, padding: '14px 16px' }}>
          <p style={{ margin: '0 0 10px', fontSize: 12.5, color: subText, lineHeight: 1.7 }}>
            曜日パターンより優先される特別な日を登録します。<br />
            「全員休み」＝会社休日（祝パターン適用）／「休館日だけど出勤日」＝出パターン適用
          </p>

          <div style={{ background: innerBg, borderRadius: 10, padding: '10px 12px', marginBottom: 14 }}>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <input type="date" value={calDate} onChange={e => setCalDate(e.target.value)} style={inputStyle} />
              <select value={calKind} onChange={e => setCalKind(e.target.value as CalendarKind)} style={inputStyle}>
                <option value="closed_all">全員休み</option>
                <option value="work_on_closed">休館日だけど出勤日</option>
              </select>
              <input type="text" value={calNote} onChange={e => setCalNote(e.target.value)} placeholder="メモ（任意）" style={{ ...inputStyle, minWidth: 140 }} />
              <button onClick={addCalendar}
                style={{ padding: '8px 18px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 'bold', background: '#007bff', color: '#fff' }}>
                追加・更新
              </button>
            </div>
            {calErr && <p style={{ margin: '8px 0 0', fontSize: 13, color: '#dc3545' }}>{calErr}</p>}
            {calMsg && <p style={{ margin: '8px 0 0', fontSize: 13, color: isDarkMode ? '#8fd19e' : '#0f5132' }}>✅ {calMsg}</p>}
          </div>

          {calRows.length === 0 ? (
            <p style={{ margin: 0, fontSize: 13, color: subText }}>登録済みの特別日はありません</p>
          ) : (
            <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse', color: text }}>
              <tbody>
                {calRows.map(r => (
                  <tr key={r.date}>
                    <td style={{ padding: '5px 4px', borderBottom: `1px solid ${borderColor}`, whiteSpace: 'nowrap' }}>{r.date}</td>
                    <td style={{ padding: '5px 4px', borderBottom: `1px solid ${borderColor}` }}>{CALENDAR_KIND_LABELS[r.kind]}</td>
                    <td style={{ padding: '5px 4px', borderBottom: `1px solid ${borderColor}`, color: subText }}>{r.note ?? ''}</td>
                    <td style={{ padding: '5px 4px', borderBottom: `1px solid ${borderColor}`, textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {calDeleteTarget === r.date ? (
                        <>
                          <button onClick={() => deleteCalendar(r.date)}
                            style={{ padding: '4px 10px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 12, background: '#dc3545', color: '#fff', marginRight: 4 }}>
                            削除する
                          </button>
                          <button onClick={() => setCalDeleteTarget(null)}
                            style={{ padding: '4px 10px', borderRadius: 6, border: `1px solid ${borderColor}`, cursor: 'pointer', fontSize: 12, background: 'transparent', color: subText }}>
                            やめる
                          </button>
                        </>
                      ) : (
                        <button onClick={() => setCalDeleteTarget(r.date)}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, color: subText }}>🗑</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* ─── 設定 ─── */}
      {section === 'settings' && (
        <div style={{ background: cardBg, borderRadius: 12, border: `1px solid ${borderColor}`, padding: '14px 16px' }}>
          <div style={{ marginBottom: 16 }}>
            <p style={{ margin: '0 0 6px', fontSize: 13.5, fontWeight: 'bold', color: text }}>超過バナーのしきい値</p>
            <p style={{ margin: '0 0 8px', fontSize: 12, color: subText, lineHeight: 1.7 }}>
              今期の残業通算がこの時間を超えたスタッフについて、本人・リーダー（自チームのみ）・マネージャー以上にお知らせバナーを表示します。
            </p>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="number" inputMode="numeric" min={0} step={1} value={thresholdHours}
                onChange={e => setThresholdHours(e.target.value)} style={{ ...inputStyle, width: 70, textAlign: 'right' }} />
              <span style={{ fontSize: 13, color: text }}>時間</span>
              <input type="number" inputMode="numeric" min={0} max={59} step={1} value={thresholdMins}
                onChange={e => setThresholdMins(e.target.value)} style={{ ...inputStyle, width: 70, textAlign: 'right' }} />
              <span style={{ fontSize: 13, color: text }}>分</span>
            </div>
          </div>

          <div style={{ marginBottom: 16 }}>
            <p style={{ margin: '0 0 6px', fontSize: 13.5, fontWeight: 'bold', color: text }}>部門として扱うグループ</p>
            <p style={{ margin: '0 0 8px', fontSize: 12, color: subText, lineHeight: 1.7 }}>
              集計の部門分けと、リーダーの「自チーム」判定に使うグループを選びます。<br />
              役職系のグループ（例：マネージャー・リーダー）は選ばないでください。
            </p>
            {groupOptions.length === 0 ? (
              <p style={{ margin: 0, fontSize: 12.5, color: subText }}>グループが登録されていません（グループタブで作成できます）</p>
            ) : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {groupOptions.map(g => {
                  const on = bannerGroups.includes(g);
                  return (
                    <button key={g}
                      onClick={() => setBannerGroups(prev => on ? prev.filter(x => x !== g) : [...prev, g])}
                      style={{
                        padding: '6px 14px', borderRadius: 16, cursor: 'pointer', fontSize: 13,
                        border: on ? '2px solid #007bff' : `1px solid ${borderColor}`,
                        background: on ? (isDarkMode ? '#1e3a5f' : '#e7f1ff') : 'transparent',
                        color: on ? (isDarkMode ? '#8fc5f6' : '#0d6efd') : subText,
                        fontWeight: on ? 'bold' : 'normal',
                      }}>
                      {on ? '✓ ' : ''}{g}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {settingsErr && <p style={{ margin: '0 0 8px', fontSize: 13, color: '#dc3545' }}>{settingsErr}</p>}
          {settingsMsg && (
            <div style={{ background: isDarkMode ? '#1b3a1e' : '#d1e7dd', border: '1px solid #28a745', borderRadius: 8, padding: '8px 12px', marginBottom: 8 }}>
              <p style={{ margin: 0, fontSize: 13, color: isDarkMode ? '#8fd19e' : '#0f5132' }}>✅ {settingsMsg}</p>
            </div>
          )}
          <button onClick={saveSettings}
            style={{ padding: '10px 24px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: 'bold', background: '#007bff', color: '#fff' }}>
            設定を保存
          </button>

          <p style={{ margin: '14px 0 0', fontSize: 11.5, color: subText, lineHeight: 1.7 }}>
            ※ バナーの本人向け文言：「今月（7/16〜8/15）の残業が◯時間を超えました。時間調整をお願いします。調整する日がわからない場合はリーダー・マネージャーにご相談ください。」（期間・時間は自動で入ります）
          </p>
        </div>
      )}
    </div>
  );
};

export default OvertimeAdminTab;

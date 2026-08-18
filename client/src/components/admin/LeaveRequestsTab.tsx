import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useAdminPanel } from './AdminPanelContext';
import { useAuth } from '../../hooks/useAuth';
import type { AdminLeaveRequest } from '../../types';
import { insertNotification, formatLeaveDateSummary } from '../../lib/notifications';
import { todayJstStr } from '../../lib/breakCalc';
import { shouldSend, getNotificationTemplate, getNotificationRecipient, dispatchEmail, dispatchSiteNotification, getUserEmail, resolveRoleRecipients } from '../../lib/notificationDispatch';
import SearchableSelect from '../common/SearchableSelect';
import LeaveEditModal from './LeaveEditModal';
import { HistoryBadge, DiffList, type ChangeKind } from './editHistoryBadge';
import {
  ABSENCE_LABEL, absenceLabel, absenceColor, formatSegments, parseSegments,
  type AttendanceType, type WorkSegment,
} from '../../lib/attendanceTypes';

// 休暇の履歴行（leave_request_history）
interface LeaveHistoryRow {
  id: string;
  change_kind: ChangeKind;
  change_summary: string | null;
  change_reason: string | null;
  changes: Record<string, { old: unknown; new: unknown }> | null;
  changed_by: string | null;
  changed_at: string;
  changerName?: string;
}
const LEAVE_FIELD_LABELS: Record<string, string> = { leave_type: '種別', leave_dates: '休暇日', leave_locations: '校', purpose: '用途', reason: '理由' };
const LEAVE_KIND_LABELS: Partial<Record<ChangeKind, string>> = { resubmit: '本人が再申請' };

// leave_locations（日付→校のJSON文字列）をパース。null・破損はundefined（校なし）扱い
const parseLeaveLocations = (s?: string | null): Record<string, string> | undefined => {
  try { return s ? JSON.parse(s) : undefined; } catch { return undefined; }
};

interface AbsenceRec {
  id: string;
  user_id: string;
  date: string;
  type: AttendanceType;
  actual_time: string | null;
  notes: string | null;
  location: string | null; // 校（過去データはnull）。移動がある場合は '四条本校→洛西口校'
  work_segments: WorkSegment[]; // 勤務時間帯。無い場合は空配列
  original_location: string | null; // 勤務地変更の「変更前の校」
  created_at: string;
  created_by: string | null;
  targetName: string;
  creatorName: string;
}

interface EncDay {
  id: string;
  fiscal_year: number;
  target_date: string;
  deadline: string;
  created_by: string | null;
  created_at: string;
  targetCount: number;
  responseCount: number;
}

interface EncResponse {
  user_id: string;
  userName: string;
  choice: number | null;
  note: string | null;
  responded_at: string | null;
}

const ENC_CHOICE_LABEL: Record<number, string> = { 1: '有給休暇', 2: '欠勤（調整休）', 3: '定休日', 4: 'その他' };
const ENC_DOW = ['日', '月', '火', '水', '木', '金', '土'];
const fmtEncDow = (dateStr: string) => { const d = new Date(dateStr + 'T00:00:00Z'); return `${d.getUTCFullYear()}年${d.getUTCMonth()+1}月${d.getUTCDate()}日(${ENC_DOW[d.getUTCDay()]})`; };

// 種別のラベル・配色は lib/attendanceTypes.ts に集約（休暇カレンダーと共用）。
// 以前はこのファイルにも別の表があり、ラベルがずれていた（遅出 / 遅出(調整)）。

const LeaveRequestsTab: React.FC = () => {
  const ctx = useAdminPanel();
  const {
    isDarkMode, leaveRequests, loadingLeaveRequests, leaveStatusFilter, setLeaveStatusFilter,
    users, fetchLeaveRequests, fetchUsers,
    setAdminManagerList, setAdminSelectedManagerId, setAdminSelectingManagerFor,
    sendLeaveSlack, supabase, setSuccessMsg, focusTarget, setFocusTarget,
  } = ctx;
  const { user: authUser } = useAuth();

  // 修正依頼タブから飛んできたとき、対象の行を光らせる。
  // 🚨 絞り込みは解除する（既定が「確認待ち」なので受理済みの申請は一覧に出ず、探せなかった）
  const focusId = focusTarget?.type === 'leave' ? focusTarget.id : null;
  const focusRowRef = useRef<HTMLTableRowElement | null>(null);

  const [absenceView, setAbsenceView] = useState(false);
  const [rejectModal, setRejectModal] = useState<AdminLeaveRequest | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [rejectNewType, setRejectNewType] = useState('');
  const [confirmDialog, setConfirmDialog] = useState<{ message: string; onConfirm: () => void } | null>(null); // 共通インライン確認（window.confirm廃止）
  const LEAVE_TYPES = ['有給休暇', 'BD休暇', '慶弔休', '調整休', 'その他', '病欠'];
  const [filterFY, setFilterFY] = useState<string>('__current__'); // 'all' | '__current__' | '2026' ...
  const [filterPerson, setFilterPerson] = useState<string>('all');
  const [absFilterFY, setAbsFilterFY] = useState<string>('__current__');
  const [absFilterPerson, setAbsFilterPerson] = useState<string>('all');
  const [absFilterType, setAbsFilterType] = useState<string>('all');
  const [absSortKey, setAbsSortKey] = useState<'date' | 'created_at'>('created_at');
  const [absSortAsc, setAbsSortAsc] = useState(false);
  const [absenceRecs, setAbsenceRecs] = useState<AbsenceRec[]>([]);
  const [absenceLoading, setAbsenceLoading] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<AbsenceRec | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [expandedReapply, setExpandedReapply] = useState<string | null>(null);
  const [expandedModify, setExpandedModify] = useState<Set<string>>(new Set());
  const [editingLeave, setEditingLeave] = useState<AdminLeaveRequest | null>(null);
  const [leaveHistory, setLeaveHistory] = useState<Record<string, LeaveHistoryRow[]>>({});
  const [historyReqIds, setHistoryReqIds] = useState<Set<string>>(new Set());
  const [filterType, setFilterType] = useState<string>('all');

  useEffect(() => {
    if (!focusId) return;
    setAbsenceView(false);
    setLeaveStatusFilter('all'); setFilterFY('all'); setFilterPerson('all'); setFilterType('all');
    const t1 = setTimeout(() => focusRowRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 400);
    const t2 = setTimeout(() => setFocusTarget(null), 6000);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [focusId, setLeaveStatusFilter, setFocusTarget]);

  const [encDays, setEncDays] = useState<EncDay[]>([]);
  const [encLoading, setEncLoading] = useState(false);
  const [expandedEncDays, setExpandedEncDays] = useState<Set<string>>(new Set());
  const [encDeleteId, setEncDeleteId] = useState<string | null>(null);
  const [encDeleting, setEncDeleting] = useState(false);
  const [encFY, setEncFY] = useState<string>('__current__');
  const [showEncCreate, setShowEncCreate] = useState(false);
  const [encCreateDate, setEncCreateDate] = useState('');
  const [encCreateDeadline, setEncCreateDeadline] = useState('');
  const [encCreateTargets, setEncCreateTargets] = useState<string[]>([]);
  const [encCreating, setEncCreating] = useState(false);
  const [showEncConfirm, setShowEncConfirm] = useState(false);
  const [showAllEncTargets, setShowAllEncTargets] = useState(false);
  const [showEncDetail, setShowEncDetail] = useState<string | null>(null);
  const [encDetailDay, setEncDetailDay] = useState<EncDay | null>(null);
  const [encResponses, setEncResponses] = useState<EncResponse[]>([]);
  const [encDetailLoading, setEncDetailLoading] = useState(false);
  const [encSendingMail, setEncSendingMail] = useState(false);
  const [encShowAddTargets, setEncShowAddTargets] = useState(false);
  const [encAddTargetIds, setEncAddTargetIds] = useState<string[]>([]);
  const [encAddingTargets, setEncAddingTargets] = useState(false);
  const [encEditingUserId, setEncEditingUserId] = useState<string | null>(null);
  const [encEditChoice, setEncEditChoice] = useState<number | null>(null);
  const [encEditNote, setEncEditNote] = useState('');
  const [encEditSaving, setEncEditSaving] = useState(false);
  const [encEditError, setEncEditError] = useState<string | null>(null);
  const [encEditSuccess, setEncEditSuccess] = useState<string | null>(null);

  // CSV export state
  const [showLeaveCsvModal, setShowLeaveCsvModal]   = useState(false);
  const [leaveCsvMode, setLeaveCsvMode]             = useState<'fy' | 'custom'>('fy');
  const [leaveCsvFy, setLeaveCsvFy]                 = useState<string>('');
  const [leaveCsvFrom, setLeaveCsvFrom]             = useState('');
  const [leaveCsvTo, setLeaveCsvTo]                 = useState('');
  const [leaveCsvExporting, setLeaveCsvExporting]   = useState(false);

  const toFiscalYearStatic = (dateStr: string) => { const d = new Date(dateStr); return d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1; };
  const nowFyStatic = (() => { const n = new Date(); return n.getMonth() >= 3 ? n.getFullYear() : n.getFullYear() - 1; })();
  const fyList = [...new Set(leaveRequests.map(r => toFiscalYearStatic(r.created_at)))].sort((a, b) => b - a);

  const STATUS_LABEL: Record<string, string> = {
    pending: '申請中', step2_pending: '申請中（2次待ち）', manager_approved: '申請中（経理待ち）',
    admin_approved: '申請中（社長待ち）', approved: '受理済み', rejected: '差戻し', cancelled: '取消済み',
  };

  const exportLeavesCsv = async () => {
    setLeaveCsvExporting(true);
    let query = supabase.from('leave_requests').select('*').order('created_at', { ascending: true });
    if (leaveCsvMode === 'fy') {
      const fy = leaveCsvFy ? Number(leaveCsvFy) : nowFyStatic;
      const from = `${fy}-04-01`; const to = `${fy + 1}-03-31`;
      query = query.gte('created_at', from).lte('created_at', to + 'T23:59:59');
    } else {
      if (leaveCsvFrom) query = query.gte('created_at', leaveCsvFrom);
      if (leaveCsvTo)   query = query.lte('created_at', leaveCsvTo + 'T23:59:59');
    }
    const { data } = await query;
    if (!data || data.length === 0) { setLeaveCsvExporting(false); setSuccessMsg('⚠ データがありません'); return; }
    const ids = [...new Set([
      ...data.map((r: AdminLeaveRequest) => r.user_id),
      ...data.map((r: AdminLeaveRequest) => r.approver_id).filter(Boolean),
      ...data.map((r: AdminLeaveRequest) => r.approver2_id).filter(Boolean),
    ])] as string[];
    const { data: profs } = await supabase.from('profiles').select('id, name').in('id', ids);
    const nm: Record<string, string> = Object.fromEntries((profs || []).map((p: { id: string; name: string }) => [p.id, p.name]));
    const esc = (v: string | number | null | undefined) => {
      const s = v == null ? '' : String(v);
      return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
    };
    // 1申請=1行ではなく「1日=1行」で出力する（複数日の申請は日数分の行に分解）
    const headers = ['申請日', '申請者', '種別', '休暇日', '校', '申請日数', '理由・目的', '第一承認者', '第二承認者', 'ステータス'];
    const rows = (data as AdminLeaveRequest[]).flatMap(r => {
      // 休暇日リスト（leave_datesはJSON配列の文字列。旧データはstart/endから展開）
      let dates: string[] = [];
      try { if (r.leave_dates) dates = JSON.parse(r.leave_dates); } catch { /* 旧形式は下のフォールバックへ */ }
      if (dates.length === 0 && r.start_date) {
        const s = new Date(r.start_date), e = new Date(r.end_date || r.start_date);
        for (const d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) dates.push(d.toISOString().slice(0, 10));
      }
      if (dates.length === 0) dates = [''];
      const locs = parseLeaveLocations(r.leave_locations) ?? {};
      const common = {
        created: r.created_at.slice(0, 10),
        name: nm[r.user_id] ?? '不明',
        type: r.leave_type_other ? `${r.leave_type}（${r.leave_type_other}）` : r.leave_type,
        days: dates.filter(Boolean).length || '',
        reason: r.purpose ?? r.reason ?? '',
        ap1: r.approver_id ? (nm[r.approver_id] ?? '') : '',
        ap2: r.approver2_id ? (nm[r.approver2_id] ?? '') : '',
        status: STATUS_LABEL[r.status] ?? r.status,
      };
      return dates.map(d => [
        common.created, common.name, common.type,
        d, d ? (locs[d] ?? '') : '',
        common.days, common.reason, common.ap1, common.ap2, common.status,
      ].map(esc).join(','));
    });
    const csv = '﻿' + [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const label = leaveCsvMode === 'fy' ? `${leaveCsvFy || nowFyStatic}年度` : `${leaveCsvFrom}〜${leaveCsvTo}`;
    a.href = url; a.download = `休暇申請_${label}.csv`; a.click();
    URL.revokeObjectURL(url);
    setLeaveCsvExporting(false); setShowLeaveCsvModal(false);
  };

  const fetchAbsences = useCallback(async () => {
    setAbsenceLoading(true);
    const { data } = await supabase
      .from('attendance_exceptions')
      .select('id, user_id, date, type, actual_time, notes, location, work_segments, original_location, created_at, created_by')
      .order('date', { ascending: false });
    if (!data || data.length === 0) { setAbsenceRecs([]); setAbsenceLoading(false); return; }
    const ids = [...new Set([...data.map((r: { user_id: string }) => r.user_id), ...data.map((r: { created_by: string | null }) => r.created_by).filter(Boolean)])] as string[];
    const { data: profs } = await supabase.from('profiles').select('id, name').in('id', ids);
    const map: Record<string, string> = {};
    (profs || []).forEach((p: { id: string; name: string }) => { map[p.id] = p.name; });
    setAbsenceRecs((data as (AbsenceRec & { work_segments: unknown })[]).map(r => ({
      ...r,
      work_segments: parseSegments(r.work_segments),
      targetName: map[r.user_id] || '不明',
      creatorName: r.created_by ? (map[r.created_by] || '不明') : '不明',
    })));
    setAbsenceLoading(false);
  }, [supabase]);

  useEffect(() => { if (absenceView) fetchAbsences(); }, [absenceView, fetchAbsences]);

  // 履歴が存在する申請ID一覧（「修正履歴」インジケーター表示用）
  useEffect(() => {
    const ids = leaveRequests.map(r => r.id);
    if (ids.length === 0) { setHistoryReqIds(new Set()); return; }
    supabase.from('leave_request_history').select('leave_request_id').in('leave_request_id', ids)
      .then(({ data }) => { setHistoryReqIds(new Set((data || []).map((r: { leave_request_id: string }) => r.leave_request_id))); });
  }, [leaveRequests, supabase]);

  // 個別申請の履歴を読み込む（展開時）
  const loadLeaveHistory = useCallback(async (reqId: string) => {
    const { data } = await supabase.from('leave_request_history')
      .select('id, change_kind, change_summary, change_reason, changes, changed_by, changed_at')
      .eq('leave_request_id', reqId).order('changed_at', { ascending: false });
    const rows = (data || []) as LeaveHistoryRow[];
    const changerIds = [...new Set(rows.map(r => r.changed_by).filter(Boolean))] as string[];
    let nameMap: Record<string, string> = {};
    if (changerIds.length > 0) {
      const { data: profs } = await supabase.from('profiles').select('id, name').in('id', changerIds);
      nameMap = Object.fromEntries((profs || []).map((p: { id: string; name: string }) => [p.id, p.name]));
    }
    setLeaveHistory(prev => ({ ...prev, [reqId]: rows.map(r => ({ ...r, changerName: r.changed_by ? (nameMap[r.changed_by] || '不明') : '管理者' })) }));
  }, [supabase]);

  const fetchEncDays = useCallback(async () => {
    setEncLoading(true);
    const { data: days } = await supabase
      .from('paid_leave_encouragement_days')
      .select('*')
      .order('target_date', { ascending: false });
    if (!days || days.length === 0) { setEncDays([]); setEncLoading(false); return; }
    const dayIds = days.map((d: { id: string }) => d.id);
    const [{ data: targets }, { data: responses }] = await Promise.all([
      supabase.from('paid_leave_encouragement_targets').select('encouragement_day_id').in('encouragement_day_id', dayIds),
      supabase.from('paid_leave_encouragement_responses').select('encouragement_day_id').in('encouragement_day_id', dayIds),
    ]);
    const tgtCounts: Record<string, number> = {};
    (targets || []).forEach((t: { encouragement_day_id: string }) => { tgtCounts[t.encouragement_day_id] = (tgtCounts[t.encouragement_day_id] || 0) + 1; });
    const resCounts: Record<string, number> = {};
    (responses || []).forEach((r: { encouragement_day_id: string }) => { resCounts[r.encouragement_day_id] = (resCounts[r.encouragement_day_id] || 0) + 1; });
    const merged = days.map((d: EncDay) => ({ ...d, targetCount: tgtCounts[d.id] || 0, responseCount: resCounts[d.id] || 0 }));
    setEncDays(merged);
    setEncLoading(false);
  }, [supabase]);

  const fetchEncDetail = useCallback(async (dayId: string) => {
    setEncDetailLoading(true);
    setEncDetailDay(encDays.find(d => d.id === dayId) || null);
    const { data: targets } = await supabase
      .from('paid_leave_encouragement_targets')
      .select('user_id')
      .eq('encouragement_day_id', dayId);
    if (!targets || targets.length === 0) { setEncResponses([]); setEncDetailLoading(false); return; }
    const userIds = targets.map((t: { user_id: string }) => t.user_id);
    const [{ data: profiles }, { data: responses }] = await Promise.all([
      supabase.from('profiles').select('id, name').in('id', userIds),
      supabase.from('paid_leave_encouragement_responses').select('*').eq('encouragement_day_id', dayId),
    ]);
    const nameMap: Record<string, string> = {};
    (profiles || []).forEach((p: { id: string; name: string }) => { nameMap[p.id] = p.name || p.id; });
    const resMap: Record<string, { choice: number; note: string | null; responded_at: string }> = {};
    (responses || []).forEach((r: { user_id: string; choice: number; note: string | null; responded_at: string }) => { resMap[r.user_id] = r; });
    setEncResponses(userIds.map((uid: string) => ({
      user_id: uid,
      userName: nameMap[uid] || '不明',
      choice: resMap[uid]?.choice ?? null,
      note: resMap[uid]?.note ?? null,
      responded_at: resMap[uid]?.responded_at ?? null,
    })));
    setEncDetailLoading(false);
  }, [supabase, encDays]);

  useEffect(() => { fetchEncDays(); }, [fetchEncDays]);

  // 有給奨励日を「日ごと削除」する。
  // 既存の「個人ごとの✕（対象から削除）」を全員に行うのと同じ挙動：
  // 回答 → 対象者 → その日に自動作成された承認済み有給申請 → 奨励日本体 の順に削除。
  const handleDeleteEncDay = useCallback(async (day: EncDay) => {
    setEncDeleting(true);
    const child = await Promise.all([
      supabase.from('paid_leave_encouragement_responses').delete().eq('encouragement_day_id', day.id),
      supabase.from('paid_leave_encouragement_targets').delete().eq('encouragement_day_id', day.id),
      supabase.from('leave_requests').delete()
        .eq('start_date', day.target_date).eq('reason', '【有給奨励日】').eq('status', 'approved'),
    ]);
    const childErr = child.find(r => r.error)?.error;
    if (childErr) {
      setEncDeleting(false); setEncDeleteId(null);
      setSuccessMsg(`⚠ 削除に失敗しました：${childErr.message}`);
      return;
    }
    // 奨励日本体。RLSで拒否されると error なしで0件になることがあるため .select() で実削除を確認
    const { data: deleted, error: dayErr } = await supabase
      .from('paid_leave_encouragement_days').delete().eq('id', day.id).select('id');
    setEncDeleting(false); setEncDeleteId(null);
    if (dayErr) { setSuccessMsg(`⚠ 削除に失敗しました：${dayErr.message}`); return; }
    if (!deleted || deleted.length === 0) {
      setSuccessMsg('⚠ 奨励日を削除できませんでした（権限/RLSの可能性）。管理者権限をご確認ください。');
      fetchEncDays();
      return;
    }
    setSuccessMsg(`奨励日（${fmtEncDow(day.target_date)}）を削除しました`);
    fetchEncDays();
  }, [supabase, fetchEncDays, setSuccessMsg]);

  // 休暇のカレンダーイベントを消す。
  // 🚨 invoke は 4xx/5xx でも throw しないので error と success を必ず見る。
  // 以前は try/catch で握りつぶしていたため、「アプリからは消えたのにカレンダーに残る」ことに
  // 誰も気づけなかった（実際に発生）。失敗したら必ず画面に出す
  const deleteLeaveGcal = async (id: string): Promise<boolean> => {
    const { data, error } = await supabase.functions.invoke('gcal-sync', {
      body: { action: 'delete', source_type: 'leave', source_id: id },
    });
    const res = data as { success?: boolean } | null;
    if (error || res?.success === false) {
      console.error('[gcal-sync] 休暇の削除失敗:', error);
      return false;
    }
    return true;
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    await supabase.from('attendance_exceptions').delete().eq('id', deleteTarget.id);
    // Googleカレンダーからも削除。invoke は 4xx/5xx でも throw しないので error を必ず見る
    const { data: syncRes, error: syncErr } = await supabase.functions.invoke('gcal-sync', {
      body: { action: 'delete', source_type: 'absence', source_id: deleteTarget.id },
    });
    const sr = syncRes as { success?: boolean } | null;
    if (syncErr || sr?.success === false) {
      console.error('[gcal-sync] 勤怠の削除失敗:', syncErr);
      setSuccessMsg('⚠ 取消しましたが、Googleカレンダーからの削除に失敗しました。カレンダーを確認してください。');
    }
    // 取消したことをリーダー以上へ通知（通知設定 attendance:cancelled に従う）。
    // 勤怠カレンダー側の取消と同じ処理。片方だけに入れると「その画面から消したときは通知が来ない」ことになる
    const { error: notifyErr } = await supabase.functions.invoke('attendance-notify', {
      body: {
        user_id: deleteTarget.user_id, user_name: deleteTarget.targetName,
        dates: [deleteTarget.date], types: [deleteTarget.type], mode: 'cancelled',
      },
    });
    if (notifyErr) console.error('[attendance-notify] 取消通知の送信失敗:', notifyErr);
    setDeleting(false);
    setDeleteTarget(null);
    fetchAbsences();
  };

          // 年度ヘルパー（4月始まり）
          const toFiscalYear = (dateStr: string) => {
            const d = new Date(dateStr);
            return d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
          };
          const nowFY = (() => { const n = new Date(); return n.getMonth() >= 3 ? n.getFullYear() : n.getFullYear() - 1; })();
          const fyOptions = [...new Set(leaveRequests.map(r => toFiscalYear(r.created_at)))].sort((a,b)=>b-a);
          if (!fyOptions.includes(nowFY)) fyOptions.unshift(nowFY);

          const leaveFilters = [
            { key: 'active',    label: '確認待ち' },
            { key: 'approved',  label: '受理済み' },
            { key: 'rejected',  label: '差し戻し' },
            { key: 'cancelled', label: '取消済み' },
            { key: 'all',       label: 'すべて' },
          ];
          // 完了していないものは年度・月・人フィルター不問で常に表示
          const isIncomplete = (r: AdminLeaveRequest) => !['approved','rejected','cancelled'].includes(r.status);
          const filteredLeave = leaveRequests
            .filter(r => {
              // ステータスフィルター
              if (leaveStatusFilter !== 'all') {
                if (leaveStatusFilter === 'active' && !isIncomplete(r)) return false;
                if (leaveStatusFilter !== 'active' && r.status !== leaveStatusFilter) return false;
              }
              // 人フィルターは未完了でも適用
              if (filterPerson !== 'all' && r.user_id !== filterPerson) return false;
              if (filterType !== 'all' && r.leave_type !== filterType) return false;
              // 未完了は年度フィルターをスキップ（人フィルターのみ適用）
              if (isIncomplete(r)) return true;
              // 年度フィルター
              const activeFY = filterFY === '__current__' ? nowFY : (filterFY === 'all' ? null : Number(filterFY));
              if (activeFY !== null && toFiscalYear(r.created_at) !== activeFY) return false;
              return true;
            })
            .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

          // ツリー構造を組み立て（再申請は親の直下に表示）
          const extractParentId = (reason: string | null | undefined): string | null => {
            if (!reason) return null;
            const m = reason.match(/【再申請】元申請ID: (\S+)/);
            return m ? m[1] : null;
          };
          // filteredLeave の中で親子関係を組み立て
          const filteredIds = new Set(filteredLeave.map(r => r.id));
          type TreeRow = { req: AdminLeaveRequest; indent: boolean };
          const treeRows: TreeRow[] = [];
          const added = new Set<string>();
          for (const r of filteredLeave) {
            if (added.has(r.id)) continue;
            const parentId = extractParentId(r.reason);
            if (parentId && filteredIds.has(parentId)) continue; // 親がいる場合は親のあとに追加
            treeRows.push({ req: r, indent: false });
            added.add(r.id);
            // 子（この申請を親とする再申請）を探して直下に追加
            for (const child of filteredLeave) {
              if (added.has(child.id)) continue;
              if (extractParentId(child.reason) === r.id) {
                treeRows.push({ req: child, indent: true });
                added.add(child.id);
              }
            }
          }
          // 親がフィルター外の再申請（孤立した子）をツリー末尾に追加
          for (const r of filteredLeave) {
            if (!added.has(r.id)) treeRows.push({ req: r, indent: false });
          }

          // 人フィルター用の一覧（重複除去）
          const personOptions = [...new Map(leaveRequests.map(r => [r.user_id, r.profile?.name || r.user_id])).entries()]
            .sort((a,b) => (a[1] > b[1] ? 1 : -1));

          const getStatusDisplay = (req: AdminLeaveRequest): { role: string; name: string; color: string } => {
            if (req.status === 'pending')          return { role: req.approver?.role_title ? `① ${req.approver.role_title}` : '①', name: req.approver?.name || '確認待ち', color: '#e67e22' };
            if (req.status === 'step2_pending')    return { role: '② マネージャー', name: req.approver2?.name || '-', color: '#d35400' };
            if (req.status === 'manager_approved') return { role: '③ 経理', name: '管理者', color: '#17a2b8' };
            if (req.status === 'admin_approved')   return { role: '', name: '④ 社長', color: '#6f42c1' };
            if (req.status === 'approved')         return { role: '', name: '受理済み', color: '#28a745' };
            if (req.status === 'rejected')         return { role: '', name: '差し戻し', color: '#dc3545' };
            if (req.status === 'cancelled')        return { role: '', name: '取消済み', color: '#6c757d' };
            return { role: '', name: req.status, color: '#999' };
          };

          const typeOptions: string[] = [...new Set(leaveRequests.map(r => r.leave_type))].sort();

          const activeUsers = users.filter(u => u.is_active !== false);
          const EMP_ORDER = ['正社員', 'パート'];
          const employmentTypes = ([...new Set(activeUsers.map(u => u.employment_type).filter(Boolean))] as string[])
            .sort((a,b) => {
              const ai = EMP_ORDER.indexOf(a); const bi = EMP_ORDER.indexOf(b);
              if (ai === -1 && bi === -1) return a > b ? 1 : -1;
              if (ai === -1) return 1; if (bi === -1) return -1;
              return ai - bi;
            });

          const encFYDisplay = encFY === '__current__' ? nowFY : (encFY === 'all' ? null : Number(encFY));
          const filteredEncDays = encFYDisplay === null ? encDays : encDays.filter(d => d.fiscal_year === encFYDisplay);

          const encCreateModal = showEncCreate ? (
            <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
              <div style={{ background: isDarkMode ? '#343a40' : '#fff', borderRadius: 16, padding: 24, width: '100%', maxWidth: 500, maxHeight: '90vh', overflowY: 'auto', boxSizing: 'border-box' }}>
                <h3 style={{ margin: '0 0 16px', color: isDarkMode ? '#fff' : '#333', fontSize: 16 }}>📅 有給奨励日 新規作成</h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <div>
                    <label style={{ fontSize: 12, color: isDarkMode ? '#adb5bd' : '#666', display: 'block', marginBottom: 4 }}>対象日</label>
                    <input type="date" value={encCreateDate} onChange={e => setEncCreateDate(e.target.value)}
                      style={{ width: '100%', padding: '7px 10px', borderRadius: 8, border: `1px solid ${isDarkMode ? '#6c757d' : '#ccc'}`, background: isDarkMode ? '#495057' : '#fff', color: isDarkMode ? '#fff' : '#333', fontSize: 14, boxSizing: 'border-box' }} />
                  </div>
                  <div>
                    <label style={{ fontSize: 12, color: isDarkMode ? '#adb5bd' : '#666', display: 'block', marginBottom: 4 }}>回答期限</label>
                    <input type="date" value={encCreateDeadline} onChange={e => setEncCreateDeadline(e.target.value)}
                      style={{ width: '100%', padding: '7px 10px', borderRadius: 8, border: `1px solid ${isDarkMode ? '#6c757d' : '#ccc'}`, background: isDarkMode ? '#495057' : '#fff', color: isDarkMode ? '#fff' : '#333', fontSize: 14, boxSizing: 'border-box' }} />
                  </div>
                  <div>
                    <label style={{ fontSize: 12, color: isDarkMode ? '#adb5bd' : '#666', display: 'block', marginBottom: 6 }}>対象者</label>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                      {employmentTypes.map(et => (
                        <button key={et} onClick={() => {
                          const ids = activeUsers.filter(u => u.employment_type === et).map(u => u.id);
                          const allSelected = ids.every(id => encCreateTargets.includes(id));
                          setEncCreateTargets(prev => allSelected ? prev.filter(id => !ids.includes(id)) : [...new Set([...prev, ...ids])]);
                        }} style={{ padding: '4px 10px', borderRadius: 12, border: 'none', cursor: 'pointer', fontSize: 12,
                          background: activeUsers.filter(u => u.employment_type === et).every(u => encCreateTargets.includes(u.id)) ? '#007bff' : (isDarkMode ? '#495057' : '#e9ecef'),
                          color: activeUsers.filter(u => u.employment_type === et).every(u => encCreateTargets.includes(u.id)) ? '#fff' : (isDarkMode ? '#fff' : '#333'),
                        }}>{et}を一括選択</button>
                      ))}
                      <button onClick={() => setEncCreateTargets(activeUsers.map(u => u.id))}
                        style={{ padding: '4px 10px', borderRadius: 12, border: 'none', cursor: 'pointer', fontSize: 12, background: isDarkMode ? '#495057' : '#e9ecef', color: isDarkMode ? '#fff' : '#333' }}>全員</button>
                      <button onClick={() => setEncCreateTargets([])}
                        style={{ padding: '4px 10px', borderRadius: 12, border: 'none', cursor: 'pointer', fontSize: 12, background: isDarkMode ? '#495057' : '#e9ecef', color: isDarkMode ? '#fff' : '#333' }}>クリア</button>
                    </div>
                    <div style={{ maxHeight: 300, overflowY: 'auto', border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, borderRadius: 8 }}>
                      {employmentTypes.map((et, gi) => {
                        const etUsers = activeUsers.filter(u => u.employment_type === et);
                        const roles = [...new Set(etUsers.map(u => u.role_title || 'その他'))].sort();
                        return (
                          <div key={et}>
                            {/* 雇用形態ヘッダー */}
                            <div style={{ padding: '5px 10px', background: isDarkMode ? '#2d3136' : '#e9ecef', borderTop: gi > 0 ? `2px solid ${isDarkMode ? '#6c757d' : '#bbb'}` : undefined, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                              <span style={{ fontSize: 12, fontWeight: 'bold', color: isDarkMode ? '#adb5bd' : '#444' }}>{et}</span>
                              <span style={{ fontSize: 11, color: isDarkMode ? '#6c757d' : '#999' }}>{etUsers.filter(u => encCreateTargets.includes(u.id)).length}/{etUsers.length}</span>
                            </div>
                            {/* 役職別横並び */}
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 0, borderBottom: `1px solid ${isDarkMode ? '#3d4349' : '#e0e0e0'}` }}>
                              {roles.map((role, ri) => {
                                const roleUsers = etUsers.filter(u => (u.role_title || 'その他') === role).sort((a,b) => (a.name||'') > (b.name||'') ? 1 : -1);
                                return (
                                  <div key={role} style={{ flex: '1 1 140px', borderLeft: ri > 0 ? `1px solid ${isDarkMode ? '#3d4349' : '#e0e0e0'}` : undefined, padding: '6px 8px' }}>
                                    <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, marginBottom: 4, paddingBottom: 3, borderBottom: `1px solid ${isDarkMode ? '#3d4349' : '#eee'}`, cursor: 'pointer', userSelect: 'none' }}>
                                      <input type="checkbox"
                                        checked={roleUsers.length > 0 && roleUsers.every(u => encCreateTargets.includes(u.id))}
                                        onChange={() => {
                                          const ids = roleUsers.map(u => u.id);
                                          const allSelected = ids.every(id => encCreateTargets.includes(id));
                                          setEncCreateTargets(prev => allSelected ? prev.filter(id => !ids.includes(id)) : [...new Set([...prev, ...ids])]);
                                        }} />
                                      <span style={{ fontSize: 10, fontWeight: 'bold', color: isDarkMode ? '#adb5bd' : '#555' }}>{role}</span>
                                    </label>
                                    {roleUsers.map(u => (
                                      <label key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0', cursor: 'pointer', fontSize: 12, color: isDarkMode ? '#fff' : '#333' }}>
                                        <input type="checkbox" checked={encCreateTargets.includes(u.id)} onChange={e => {
                                          setEncCreateTargets(prev => e.target.checked ? [...prev, u.id] : prev.filter(id => id !== u.id));
                                        }} />
                                        <span>{u.name || u.email}</span>
                                      </label>
                                    ))}
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    <p style={{ fontSize: 12, color: isDarkMode ? '#adb5bd' : '#888', marginTop: 4 }}>{encCreateTargets.length}人選択中</p>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
                  <button onClick={() => { setShowEncCreate(false); setEncCreateDate(''); setEncCreateDeadline(''); setEncCreateTargets([]); }}
                    style={{ flex: 1, padding: '10px 0', background: isDarkMode ? '#495057' : '#e9ecef', color: isDarkMode ? '#fff' : '#333', border: 'none', borderRadius: 10, cursor: 'pointer', fontSize: 13 }}>キャンセル</button>
                  <button disabled={!encCreateDate || !encCreateDeadline || encCreateTargets.length === 0}
                    onClick={() => setShowEncConfirm(true)}
                    style={{ flex: 2, padding: '10px 0', background: (!encCreateDate || !encCreateDeadline || encCreateTargets.length === 0) ? '#6c757d' : '#007bff', color: '#fff', border: 'none', borderRadius: 10, cursor: (!encCreateDate || !encCreateDeadline || encCreateTargets.length === 0) ? 'default' : 'pointer', fontSize: 13, fontWeight: 'bold' }}>
                    内容を確認して送信
                  </button>
                </div>
              </div>
            </div>
          ) : null;

          const encConfirmModal = showEncConfirm ? (() => {
            const d = encCreateDate ? new Date(encCreateDate) : null;
            const dateLabel = d ? `${d.getFullYear()}年${d.getMonth()+1}月${d.getDate()}日` : '';
            const allTargetNames = encCreateTargets.map(id => activeUsers.find(u => u.id === id)?.name || '').filter(Boolean);
            return (
              <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 3000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
                <div style={{ background: isDarkMode ? '#343a40' : '#fff', borderRadius: 16, padding: '20px 20px 24px', width: '100%', maxWidth: 420, maxHeight: '90vh', overflowY: 'auto', boxSizing: 'border-box' }}>
                  <p style={{ margin: '0 0 4px', fontSize: 15, fontWeight: 'bold', color: isDarkMode ? '#fff' : '#333', textAlign: 'center' }}>送信内容を確認</p>
                  <p style={{ margin: '0 0 14px', fontSize: 12, color: isDarkMode ? '#adb5bd' : '#888', textAlign: 'center' }}>以下の内容でベル通知を送信します</p>
                  <div style={{ background: isDarkMode ? '#2d3136' : '#f8f9fa', borderRadius: 10, padding: '14px 16px', border: `1px solid ${isDarkMode ? '#495057' : '#dee2e6'}`, marginBottom: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <span style={{ fontSize: 12, color: isDarkMode ? '#adb5bd' : '#888', minWidth: 60, flexShrink: 0 }}>対象日</span>
                      <span style={{ fontSize: 13, fontWeight: 700, color: isDarkMode ? '#fff' : '#333' }}>{dateLabel || '—'}</span>
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <span style={{ fontSize: 12, color: isDarkMode ? '#adb5bd' : '#888', minWidth: 60, flexShrink: 0 }}>回答期限</span>
                      <span style={{ fontSize: 13, fontWeight: 700, color: '#dc2626' }}>{encCreateDeadline || '—'}</span>
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <span style={{ fontSize: 12, color: isDarkMode ? '#adb5bd' : '#888', minWidth: 60, flexShrink: 0 }}>通知人数</span>
                      <span style={{ fontSize: 13, fontWeight: 700, color: isDarkMode ? '#fff' : '#333' }}>{encCreateTargets.length}人</span>
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <span style={{ fontSize: 12, color: isDarkMode ? '#adb5bd' : '#888', minWidth: 60, flexShrink: 0, paddingTop: 2 }}>対象者</span>
                      <div style={{ flex: 1 }}>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: allTargetNames.length >= 10 ? 4 : 0 }}>
                          {(allTargetNames.length >= 10 && !showAllEncTargets
                            ? allTargetNames.slice(0, 9)
                            : allTargetNames
                          ).map((name, i) => (
                            <span key={i} style={{ fontSize: 12, padding: '2px 8px', background: isDarkMode ? '#2d3a4a' : '#dbeafe', color: isDarkMode ? '#93c5fd' : '#1d4ed8', borderRadius: 12 }}>{name}</span>
                          ))}
                          {allTargetNames.length >= 10 && !showAllEncTargets && (
                            <button onClick={() => setShowAllEncTargets(true)}
                              style={{ fontSize: 12, padding: '2px 8px', background: 'none', border: `1px dashed ${isDarkMode ? '#3b82f6' : '#93c5fd'}`, color: isDarkMode ? '#93c5fd' : '#3b82f6', borderRadius: 12, cursor: 'pointer' }}>
                              +{allTargetNames.length - 9}人
                            </button>
                          )}
                        </div>
                        {allTargetNames.length >= 10 && showAllEncTargets && (
                          <button onClick={() => setShowAllEncTargets(false)}
                            style={{ fontSize: 11, background: 'none', border: 'none', color: isDarkMode ? '#93c5fd' : '#3b82f6', cursor: 'pointer', padding: '2px 0', marginTop: 2 }}>
                            ▲ 閉じる
                          </button>
                        )}
                      </div>
                    </div>
                    <div style={{ padding: '10px 12px', background: isDarkMode ? '#1e2a3a' : '#eff6ff', borderRadius: 8, borderLeft: '3px solid #3b82f6' }}>
                      <p style={{ margin: 0, fontSize: 12, color: isDarkMode ? '#93c5fd' : '#1d4ed8' }}>
                        📅 有給奨励日の回答をお願いします（{dateLabel}、期限：{encCreateDeadline}）
                      </p>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 10 }}>
                    <button onClick={() => { setShowEncConfirm(false); setShowAllEncTargets(false); }}
                      style={{ flex: 1, padding: '10px 0', background: isDarkMode ? '#495057' : '#e9ecef', color: isDarkMode ? '#fff' : '#333', border: 'none', borderRadius: 10, cursor: 'pointer', fontSize: 13 }}>
                      戻る
                    </button>
                    <button disabled={encCreating} onClick={async () => {
                      if (!encCreateDate || !encCreateDeadline || encCreateTargets.length === 0) return;
                      setEncCreating(true);
                      const d2 = new Date(encCreateDate);
                      const fy = d2.getMonth() >= 3 ? d2.getFullYear() : d2.getFullYear() - 1;
                      const { data: newDay, error } = await supabase
                        .from('paid_leave_encouragement_days')
                        .insert({ fiscal_year: fy, target_date: encCreateDate, deadline: encCreateDeadline, created_by: authUser?.id })
                        .select('id').single();
                      if (error || !newDay) { setSuccessMsg('⚠ 作成に失敗しました: ' + error?.message); setEncCreating(false); return; }
                      await supabase.from('paid_leave_encouragement_targets').insert(
                        encCreateTargets.map(uid => ({ encouragement_day_id: newDay.id, user_id: uid }))
                      );
                      const dl2 = `${d2.getMonth()+1}月${d2.getDate()}日`;
                      await supabase.from('notifications').insert(
                        encCreateTargets.map(uid => ({ user_id: uid, message: `📅 有給奨励日の回答をお願いします（${dl2}、期限：${encCreateDeadline}）`, event_key: 'reminder:encouragement' }))
                      );
                      setEncCreating(false);
                      setShowEncConfirm(false); setShowAllEncTargets(false);
                      setShowEncCreate(false); setEncCreateDate(''); setEncCreateDeadline(''); setEncCreateTargets([]);
                      fetchEncDays();
                    }}
                      style={{ flex: 2, padding: '10px 0', background: encCreating ? '#6c757d' : '#007bff', color: '#fff', border: 'none', borderRadius: 10, cursor: encCreating ? 'default' : 'pointer', fontSize: 13, fontWeight: 'bold' }}>
                      {encCreating ? '送信中...' : '送信する'}
                    </button>
                  </div>
                </div>
              </div>
            );
          })() : null;

          const encDetailModal = showEncDetail ? (
            <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
              <div style={{ background: isDarkMode ? '#343a40' : '#fff', borderRadius: 16, padding: 24, width: '100%', maxWidth: 560, maxHeight: '90vh', overflowY: 'auto', boxSizing: 'border-box' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                  <div>
                    <h3 style={{ margin: 0, color: isDarkMode ? '#fff' : '#333', fontSize: 16 }}>📅 奨励日回答状況</h3>
                    {encDetailDay && (
                      <p style={{ margin: '4px 0 0', fontSize: 12, color: isDarkMode ? '#adb5bd' : '#888' }}>
                        {fmtEncDow(encDetailDay.target_date)}　期限: {fmtEncDow(encDetailDay.deadline)}　{encDetailDay.responseCount}/{encDetailDay.targetCount}人回答済み
                      </p>
                    )}
                  </div>
                  <button onClick={() => { setShowEncDetail(null); setEncDetailDay(null); setEncResponses([]); setEncShowAddTargets(false); setEncAddTargetIds([]); setEncEditingUserId(null); setEncEditError(null); }}
                    style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: isDarkMode ? '#adb5bd' : '#666', lineHeight: 1 }}>✕</button>
                </div>

                {encDetailLoading ? (
                  <p style={{ textAlign: 'center', fontSize: 13, color: isDarkMode ? '#adb5bd' : '#888' }}>読み込み中...</p>
                ) : (
                  <>
                    {/* ヘッダー */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 12px', marginBottom: 4 }}>
                      <span style={{ fontSize: 11, fontWeight: 'bold', color: isDarkMode ? '#adb5bd' : '#888', minWidth: 80 }}>名前</span>
                      <span style={{ fontSize: 11, fontWeight: 'bold', color: isDarkMode ? '#adb5bd' : '#888', flex: 1 }}>回答</span>
                      <span style={{ fontSize: 11, fontWeight: 'bold', color: isDarkMode ? '#adb5bd' : '#888', width: 80, textAlign: 'center' }}>回答日時</span>
                      <span style={{ width: 36 }} />
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 16 }}>
                      {encResponses.map(r => {
                        const isEditing = encEditingUserId === r.user_id;
                        return (
                        <div key={r.user_id} style={{
                          borderRadius: 8, overflow: 'hidden',
                          background: r.choice ? (isDarkMode ? '#495057' : '#f8f9fa') : (isDarkMode ? '#4a2a2a' : '#fff5f5'),
                          border: `1px solid ${r.choice ? (isDarkMode ? '#6c757d' : '#dee2e6') : '#dc3545'}`,
                        }}>
                          {/* 通常行 */}
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', flexWrap: 'wrap' }}>
                            <span style={{ fontSize: 13, color: isDarkMode ? '#fff' : '#333', fontWeight: 'bold', minWidth: 80 }}>{r.userName}</span>
                            {r.choice ? (
                              <>
                                <span style={{ fontSize: 12, padding: '2px 10px', borderRadius: 10, whiteSpace: 'nowrap',
                                  background: r.choice === 1 ? '#28a745' : r.choice === 2 ? '#fd7e14' : r.choice === 3 ? '#17a2b8' : '#6c757d',
                                  color: '#fff' }}>{ENC_CHOICE_LABEL[r.choice]}</span>
                                {r.note && <span style={{ fontSize: 11, color: isDarkMode ? '#adb5bd' : '#666', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.note}</span>}
                                {r.responded_at && (() => {
                                  const d = new Date(r.responded_at);
                                  const date = d.toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'numeric', day: 'numeric' });
                                  const time = d.toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: 'numeric', minute: '2-digit' });
                                  return (
                                    <span style={{ fontSize: 10, color: isDarkMode ? '#adb5bd' : '#888', whiteSpace: 'nowrap', marginLeft: 'auto', textAlign: 'center', lineHeight: 1.4 }}>
                                      <span style={{ display: 'block' }}>{date}</span>
                                      <span style={{ display: 'block' }}>{time}</span>
                                    </span>
                                  );
                                })()}
                              </>
                            ) : (
                              <span style={{ fontSize: 12, color: '#dc3545', fontWeight: 'bold', marginLeft: 'auto' }}>未回答</span>
                            )}
                            {/* 編集ボタン */}
                            <button onClick={() => {
                              if (isEditing) { setEncEditingUserId(null); return; }
                              setEncEditingUserId(r.user_id);
                              setEncEditChoice(r.choice);
                              setEncEditNote(r.note || '');
                            }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: isDarkMode ? '#adb5bd' : '#999', fontSize: 13, padding: '0 2px', lineHeight: 1, flexShrink: 0 }}
                              title="編集">✏️</button>
                            <button onClick={() => {
                              setConfirmDialog({ message: `「${r.userName}」を対象から削除しますか？`, onConfirm: async () => {
                                await supabase.from('paid_leave_encouragement_responses').delete().eq('encouragement_day_id', showEncDetail).eq('user_id', r.user_id);
                                await supabase.from('paid_leave_encouragement_targets').delete().eq('encouragement_day_id', showEncDetail).eq('user_id', r.user_id);
                                if (encDetailDay) {
                                  await supabase.from('leave_requests').delete()
                                    .eq('user_id', r.user_id)
                                    .eq('start_date', encDetailDay.target_date)
                                    .eq('reason', '【有給奨励日】')
                                    .eq('status', 'approved');
                                }
                                fetchEncDetail(showEncDetail!);
                                fetchEncDays();
                              } });
                            }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: isDarkMode ? '#6c757d' : '#ccc', fontSize: 14, padding: '0 2px', lineHeight: 1, flexShrink: 0 }}
                              title="対象から削除">✕</button>
                          </div>
                          {/* 編集パネル */}
                          {isEditing && (
                            <div style={{ padding: '10px 12px', borderTop: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, background: isDarkMode ? '#3d4349' : '#fff' }}>
                              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                                {([1, 2, 3, 4] as const).map(n => {
                                  const colors: Record<number, string> = { 1: '#28a745', 2: '#fd7e14', 3: '#17a2b8', 4: '#6c757d' };
                                  const sel = encEditChoice === n;
                                  return (
                                    <button key={n} onClick={() => setEncEditChoice(n)} style={{
                                      padding: '5px 12px', borderRadius: 8, fontSize: 12,
                                      border: sel ? `2px solid ${colors[n]}` : `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`,
                                      background: sel ? colors[n] : (isDarkMode ? '#495057' : '#f8f9fa'),
                                      color: sel ? '#fff' : (isDarkMode ? '#fff' : '#333'), cursor: 'pointer', fontWeight: sel ? 'bold' : 'normal',
                                    }}>{ENC_CHOICE_LABEL[n]}</button>
                                  );
                                })}
                              </div>
                              {encEditChoice === 4 && (
                                <input value={encEditNote} onChange={e => setEncEditNote(e.target.value)} placeholder="備考（必須）"
                                  style={{ width: '100%', padding: '6px 10px', borderRadius: 6, border: `1px solid ${isDarkMode ? '#6c757d' : '#ccc'}`, fontSize: 12, background: isDarkMode ? '#495057' : '#fff', color: isDarkMode ? '#fff' : '#333', boxSizing: 'border-box', marginBottom: 8 }} />
                              )}
                              {encEditChoice !== 4 && (
                                <input value={encEditNote} onChange={e => setEncEditNote(e.target.value)} placeholder="備考（任意）"
                                  style={{ width: '100%', padding: '6px 10px', borderRadius: 6, border: `1px solid ${isDarkMode ? '#6c757d' : '#ccc'}`, fontSize: 12, background: isDarkMode ? '#495057' : '#fff', color: isDarkMode ? '#fff' : '#333', boxSizing: 'border-box', marginBottom: 8 }} />
                              )}
                              {encEditError && (
                                <div style={{ marginBottom: 8, padding: '6px 10px', borderRadius: 6, background: '#f8d7da', border: '1px solid #f5c6cb', color: '#721c24', fontSize: 11 }}>
                                  ⚠️ {encEditError}
                                </div>
                              )}
                              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                                <button onClick={() => { setEncEditingUserId(null); setEncEditError(null); }}
                                  style={{ padding: '5px 14px', borderRadius: 6, border: `1px solid ${isDarkMode ? '#6c757d' : '#ccc'}`, background: isDarkMode ? '#495057' : '#e9ecef', color: isDarkMode ? '#fff' : '#333', cursor: 'pointer', fontSize: 12 }}>キャンセル</button>
                                <button disabled={!encEditChoice || (encEditChoice === 4 && !encEditNote.trim()) || encEditSaving}
                                  onClick={async () => {
                                    if (!encEditChoice) return;
                                    setEncEditError(null);
                                    setEncEditSaving(true);
                                    if (r.choice) {
                                      await supabase.from('paid_leave_encouragement_responses')
                                        .update({ choice: encEditChoice, note: encEditNote.trim() || null })
                                        .eq('encouragement_day_id', showEncDetail).eq('user_id', r.user_id).select('id');
                                    } else {
                                      await supabase.from('paid_leave_encouragement_responses').insert({
                                        encouragement_day_id: showEncDetail,
                                        user_id: r.user_id,
                                        choice: encEditChoice,
                                        note: encEditNote.trim() || null,
                                      });
                                    }
                                    // 既存の回答がある場合、leave_requestsから削除してから再挿入
                                    if (encDetailDay) {
                                      await supabase.from('leave_requests')
                                        .delete()
                                        .eq('user_id', r.user_id)
                                        .eq('start_date', encDetailDay.target_date)
                                        .eq('reason', '【有給奨励日】')
                                        .eq('status', 'approved');
                                      const encLeaveType = encEditChoice === 1 ? '有給休暇' : encEditChoice === 2 ? '調整休' : 'その他';
                                      const encLeaveTypeOther = encEditChoice === 3 ? '定休日' : encEditChoice === 4 ? (encEditNote.trim() || 'その他') : undefined;
                                      const { error: lrErr } = await supabase.from('leave_requests').insert({
                                        user_id: r.user_id,
                                        leave_type: encLeaveType,
                                        ...(encLeaveTypeOther ? { leave_type_other: encLeaveTypeOther } : {}),
                                        leave_dates: JSON.stringify([encDetailDay.target_date]),
                                        start_date: encDetailDay.target_date,
                                        end_date: encDetailDay.target_date,
                                        purpose: '有給奨励日',
                                        reason: '【有給奨励日】',
                                        status: 'approved',
                                        current_approver: 'none',
                                      });
                                      if (lrErr) { setEncEditError(lrErr.message); setEncEditSaving(false); return; }
                                    }
                                    setEncEditingUserId(null);
                                    setEncEditError(null);
                                    setEncEditSaving(false);
                                    setEncEditSuccess('登録しました');
                                    setTimeout(() => setEncEditSuccess(null), 3000);
                                    fetchEncDetail(showEncDetail!);
                                    fetchEncDays();
                                  }}
                                  style={{ padding: '5px 14px', borderRadius: 6, border: 'none', background: encEditSaving ? '#6c757d' : '#28a745', color: '#fff', cursor: encEditSaving ? 'default' : 'pointer', fontSize: 12, fontWeight: 'bold' }}>
                                  {encEditSaving ? '保存中...' : '保存'}
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                        );
                      })}
                    </div>

                    {/* 対象者を追加 */}
                    <div style={{ marginBottom: 12 }}>
                      <button onClick={() => { setEncShowAddTargets(v => !v); setEncAddTargetIds([]); }}
                        style={{ padding: '7px 14px', background: isDarkMode ? '#495057' : '#e9ecef', color: isDarkMode ? '#fff' : '#333', border: `1px solid ${isDarkMode ? '#6c757d' : '#ccc'}`, borderRadius: 8, cursor: 'pointer', fontSize: 12, fontWeight: 'bold' }}>
                        {encShowAddTargets ? '▲ 閉じる' : '＋ 対象者を追加'}
                      </button>
                      {encShowAddTargets && (() => {
                        const existingIds = new Set(encResponses.map(r => r.user_id));
                        const addableUsers = activeUsers.filter(u => !existingIds.has(u.id));
                        const addRoles = [...new Set(addableUsers.map(u => u.employment_type || 'その他'))];
                        return (
                          <div style={{ marginTop: 8, border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, borderRadius: 8 }}>
                            {addableUsers.length === 0 ? (
                              <p style={{ padding: '10px 12px', fontSize: 12, color: isDarkMode ? '#adb5bd' : '#888', margin: 0 }}>追加できるスタッフがいません</p>
                            ) : (
                              <>
                                <div style={{ maxHeight: 220, overflowY: 'auto' }}>
                                  {addRoles.map((et, gi) => {
                                    const group = addableUsers.filter(u => (u.employment_type || 'その他') === et).sort((a,b) => (a.name||'') > (b.name||'') ? 1 : -1);
                                    const roles = [...new Set(group.map(u => u.role_title || 'その他'))].sort();
                                    return (
                                      <div key={et}>
                                        <div style={{ padding: '4px 10px', background: isDarkMode ? '#2d3136' : '#e9ecef', borderTop: gi > 0 ? `2px solid ${isDarkMode ? '#6c757d' : '#bbb'}` : undefined }}>
                                          <span style={{ fontSize: 11, fontWeight: 'bold', color: isDarkMode ? '#adb5bd' : '#444' }}>{et}</span>
                                        </div>
                                        <div style={{ display: 'flex', flexWrap: 'wrap' }}>
                                          {roles.map((role, ri) => {
                                            const ru = group.filter(u => (u.role_title || 'その他') === role);
                                            return (
                                              <div key={role} style={{ flex: '1 1 130px', borderLeft: ri > 0 ? `1px solid ${isDarkMode ? '#3d4349' : '#e0e0e0'}` : undefined, padding: '4px 8px' }}>
                                                <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, marginBottom: 3, paddingBottom: 2, borderBottom: `1px solid ${isDarkMode ? '#3d4349' : '#eee'}`, cursor: 'pointer', userSelect: 'none' }}>
                                                  <input type="checkbox"
                                                    checked={ru.length > 0 && ru.every(u => encAddTargetIds.includes(u.id))}
                                                    onChange={() => {
                                                      const ids = ru.map(u => u.id);
                                                      const allSelected = ids.every(id => encAddTargetIds.includes(id));
                                                      setEncAddTargetIds(prev => allSelected ? prev.filter(id => !ids.includes(id)) : [...new Set([...prev, ...ids])]);
                                                    }} />
                                                  <span style={{ fontSize: 10, fontWeight: 'bold', color: isDarkMode ? '#adb5bd' : '#555' }}>{role}</span>
                                                </label>
                                                {ru.map(u => (
                                                  <label key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '2px 0', cursor: 'pointer', fontSize: 12, color: isDarkMode ? '#fff' : '#333' }}>
                                                    <input type="checkbox" checked={encAddTargetIds.includes(u.id)} onChange={e => {
                                                      setEncAddTargetIds(prev => e.target.checked ? [...prev, u.id] : prev.filter(id => id !== u.id));
                                                    }} />
                                                    <span>{u.name || u.email}</span>
                                                  </label>
                                                ))}
                                              </div>
                                            );
                                          })}
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>
                                <div style={{ padding: '8px 10px', borderTop: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                  <span style={{ fontSize: 12, color: isDarkMode ? '#adb5bd' : '#888' }}>{encAddTargetIds.length}人選択中</span>
                                  <button disabled={encAddTargetIds.length === 0 || encAddingTargets}
                                    onClick={async () => {
                                      if (!showEncDetail || encAddTargetIds.length === 0) return;
                                      setEncAddingTargets(true);
                                      await supabase.from('paid_leave_encouragement_targets').insert(
                                        encAddTargetIds.map(uid => ({ encouragement_day_id: showEncDetail, user_id: uid }))
                                      );
                                      const d = encDetailDay;
                                      if (d) {
                                        const dateLabel = `${Number(d.target_date.slice(5,7))}月${Number(d.target_date.slice(8,10))}日`;
                                        await supabase.from('notifications').insert(
                                          encAddTargetIds.map(uid => ({ user_id: uid, message: `📅 有給奨励日の回答をお願いします（${dateLabel}、期限：${d.deadline}）`, event_key: 'reminder:encouragement' }))
                                        );
                                      }
                                      setEncAddingTargets(false);
                                      setEncShowAddTargets(false); setEncAddTargetIds([]);
                                      fetchEncDetail(showEncDetail);
                                      fetchEncDays();
                                    }}
                                    style={{ padding: '6px 14px', background: encAddingTargets ? '#6c757d' : '#007bff', color: '#fff', border: 'none', borderRadius: 7, cursor: encAddingTargets ? 'default' : 'pointer', fontSize: 12, fontWeight: 'bold' }}>
                                    {encAddingTargets ? '追加中...' : '追加してベル通知'}
                                  </button>
                                </div>
                              </>
                            )}
                          </div>
                        );
                      })()}
                    </div>

                    {encEditSuccess && (
                      <div style={{ marginBottom: 10, padding: '8px 14px', borderRadius: 8, background: '#d4edda', border: '1px solid #c3e6cb', color: '#155724', fontSize: 13, fontWeight: 'bold', textAlign: 'center' }}>
                        ✓ {encEditSuccess}
                      </div>
                    )}

                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <button onClick={() => {
                        const header = '名前,回答,備考,回答日時';
                        const rows = encResponses.map(r => [
                          r.userName,
                          r.choice ? ENC_CHOICE_LABEL[r.choice] : '未回答',
                          r.note || '',
                          r.responded_at ? new Date(r.responded_at + 'Z').toLocaleString('ja-JP') : '',
                        ].map(v => `"${v}"`).join(','));
                        const csv = [header, ...rows].join('\n');
                        const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
                        const a = document.createElement('a');
                        a.href = URL.createObjectURL(blob);
                        a.download = `奨励日回答_${encDetailDay?.target_date || ''}.csv`;
                        a.click();
                      }} style={{ padding: '8px 16px', background: '#28a745', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 12, fontWeight: 'bold' }}>
                        CSV出力
                      </button>
                      <button disabled={encSendingMail} onClick={async () => {
                        const unanswered = encResponses.filter(r => !r.choice);
                        if (unanswered.length === 0) { setSuccessMsg('未回答者はいません'); return; }
                        setConfirmDialog({ message: `未回答の${unanswered.length}人にメールを送信しますか？`, onConfirm: async () => {
                          setEncSendingMail(true);
                          const { data: profiles } = await supabase.from('profiles').select('id, email').in('id', unanswered.map(r => r.user_id));
                          const emailMap: Record<string, string> = {};
                          (profiles || []).forEach((p: { id: string; email: string }) => { emailMap[p.id] = p.email; });
                          for (const r of unanswered) {
                            const email = emailMap[r.user_id];
                            if (!email) continue;
                            await supabase.functions.invoke('send-email', {
                              body: { to: email, subject: '有給奨励日の回答をお願いします', text: `${r.userName}さん\n\n有給奨励日（${encDetailDay?.target_date}）の回答期限（${encDetailDay?.deadline}）が近づいています。\nサイトよりご回答ください。` },
                            });
                          }
                          setEncSendingMail(false);
                          setSuccessMsg(`${unanswered.length}人にメールを送信しました`);
                        } });
                      }} style={{ padding: '8px 16px', background: encSendingMail ? '#6c757d' : '#fd7e14', color: '#fff', border: 'none', borderRadius: 8, cursor: encSendingMail ? 'default' : 'pointer', fontSize: 12, fontWeight: 'bold' }}>
                        {encSendingMail ? '送信中...' : `未回答者（${encResponses.filter(r => !r.choice).length}人）にメール`}
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          ) : null;

          const partUsers = users.filter(u => u.is_active !== false && u.employment_type === 'パート');

          const confirmDialogModal = confirmDialog ? (
            <div style={{ position: 'fixed', inset: 0, zIndex: 5000, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }} onClick={() => setConfirmDialog(null)}>
              <div onClick={e => e.stopPropagation()} style={{ background: isDarkMode ? '#343a40' : 'white', borderRadius: 12, padding: '22px 24px', boxShadow: '0 4px 20px rgba(0,0,0,0.25)', maxWidth: 360, width: '100%' }}>
                <p style={{ fontSize: 15, fontWeight: 'bold', color: isDarkMode ? '#fff' : '#333', margin: '0 0 18px', lineHeight: 1.6, whiteSpace: 'pre-line' }}>{confirmDialog.message}</p>
                <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                  <button onClick={() => setConfirmDialog(null)} style={{ padding: '8px 18px', background: 'transparent', color: isDarkMode ? '#adb5bd' : '#666', border: `1px solid ${isDarkMode ? '#6c757d' : '#ccc'}`, borderRadius: 8, cursor: 'pointer', fontSize: 14 }}>キャンセル</button>
                  <button onClick={() => { const cb = confirmDialog.onConfirm; setConfirmDialog(null); cb(); }} style={{ padding: '8px 18px', background: '#28a745', color: 'white', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 'bold', fontSize: 14 }}>はい</button>
                </div>
              </div>
            </div>
          ) : null;

          return (
            <div>
              {confirmDialogModal}
              {encCreateModal}
              {encConfirmModal}
              {encDetailModal}
              <h3 style={{ textAlign: 'center', marginBottom: 8, color: isDarkMode ? '#fff' : '#000' }}>🌿 休暇申請一覧</h3>
              <p style={{ textAlign: 'center', fontSize: 13, color: isDarkMode ? '#adb5bd' : '#666', marginBottom: 4 }}>
                管理者として全ての申請を確認・受理できます。受理が止まっている場合は強制的に次のステップへ進められます。
              </p>
              <div style={{ display: 'flex', justifyContent: 'flex-end', paddingRight: 16, marginBottom: 8 }}>
                <button onClick={() => { setLeaveCsvFy(String(nowFyStatic)); setShowLeaveCsvModal(true); }}
                  style={{ padding: '5px 12px', borderRadius: 6, border: 'none', background: '#28a745', color: '#fff', fontSize: 12, fontWeight: 'bold', cursor: 'pointer' }}>
                  📥 CSV出力
                </button>
              </div>

              {/* パートへ有給申請フォーム送信 */}
              <div style={{ background: isDarkMode ? '#2d3136' : '#f8f9fa', border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, borderRadius: 10, padding: '12px 16px', marginBottom: 20, maxWidth: 500, marginLeft: 'auto', marginRight: 'auto' }}>
                <p style={{ fontWeight: 'bold', fontSize: 13, color: isDarkMode ? '#fff' : '#333', marginBottom: 8 }}>📨 パート・アルバイトへ休暇申請フォームを送信</p>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <select
                    id="part-leave-target"
                    style={{ flex: 1, minWidth: 160, padding: '6px 8px', borderRadius: 6, border: `1px solid ${isDarkMode ? '#6c757d' : '#ccc'}`, background: isDarkMode ? '#495057' : 'white', color: isDarkMode ? '#fff' : '#000', fontSize: 13 }}
                  >
                    <option value="">-- パート・アルバイトを選択 --</option>
                    {partUsers.map(u => (
                      <option key={u.id} value={u.id}>{u.name || u.email}</option>
                    ))}
                  </select>
                  <button
                    onClick={() => {
                      const sel = document.getElementById('part-leave-target') as HTMLSelectElement;
                      const userId = sel?.value;
                      if (!userId) { setSuccessMsg('⚠ パートを選択してください'); return; }
                      const target = partUsers.find(u => u.id === userId);
                      if (!target) return;
                      setConfirmDialog({ message: `「${target.name || target.email}」さんに有給申請フォームを送信しますか？`, onConfirm: async () => {
                        // 🚨 直接UPDATEしない。profiles の直接更新はRLSで管理者のみに絞ってあるため、
                        //    リーダー・マネージャーからも呼べる RPC 経由にする（2026-08-10）
                        const { error } = await supabase.rpc('set_leave_request_enabled', { p_user_id: userId, p_enabled: true });
                        if (error) { setSuccessMsg('⚠ 送信に失敗しました: ' + error.message); return; }
                        await fetchUsers();
                        setSuccessMsg(`「${target.name || target.email}」さんに送信しました`);
                      } });
                    }}
                    style={{ padding: '6px 16px', background: '#28a745', color: 'white', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 'bold', fontSize: 13, whiteSpace: 'nowrap' }}
                  >送信</button>
                </div>
                {partUsers.filter(u => u.leave_request_enabled).length > 0 && (
                  <div style={{ marginTop: 10 }}>
                    <p style={{ fontSize: 12, color: isDarkMode ? '#adb5bd' : '#666', marginBottom: 4 }}>現在フォーム表示中のパート：</p>
                    {partUsers.filter(u => u.leave_request_enabled).map(u => (
                      <div key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                        <span style={{ fontSize: 13, color: isDarkMode ? '#fff' : '#333' }}>✅ {u.name || u.email}</span>
                        <button
                          onClick={async () => {
                            await supabase.rpc('set_leave_request_enabled', { p_user_id: u.id, p_enabled: false });
                            await fetchUsers();
                          }}
                          style={{ padding: '2px 8px', background: '#dc3545', color: 'white', border: 'none', borderRadius: 10, cursor: 'pointer', fontSize: 11 }}
                        >取り消し</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* 有給奨励日 */}
              <div style={{ background: isDarkMode ? '#2d3136' : '#f8f9fa', border: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, borderRadius: 10, padding: '12px 16px', marginBottom: 20, maxWidth: 500, marginLeft: 'auto', marginRight: 'auto' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <p style={{ fontWeight: 'bold', fontSize: 13, color: isDarkMode ? '#fff' : '#333', margin: 0 }}>📅 有給奨励日</p>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <select value={encFY} onChange={e => setEncFY(e.target.value)}
                      style={{ padding: '4px 8px', borderRadius: 6, border: `1px solid ${isDarkMode ? '#6c757d' : '#ccc'}`, background: isDarkMode ? '#495057' : '#fff', color: isDarkMode ? '#fff' : '#333', fontSize: 11 }}>
                      <option value="__current__">{nowFY}年度</option>
                      {[...new Set(encDays.map(d => d.fiscal_year))].sort((a,b) => b-a).filter(fy => fy !== nowFY).map(fy => <option key={fy} value={String(fy)}>{fy}年度</option>)}
                      <option value="all">全年度</option>
                    </select>
                    <button onClick={() => setShowEncCreate(true)}
                      style={{ padding: '4px 12px', background: '#007bff', color: '#fff', border: 'none', borderRadius: 6, fontSize: 12, cursor: 'pointer', fontWeight: 'bold' }}>＋ 新規作成</button>
                  </div>
                </div>
                {encLoading ? (
                  <p style={{ textAlign: 'center', fontSize: 12, color: isDarkMode ? '#adb5bd' : '#888', margin: 0 }}>読み込み中...</p>
                ) : filteredEncDays.length === 0 ? (
                  <p style={{ textAlign: 'center', fontSize: 12, color: isDarkMode ? '#adb5bd' : '#888', margin: 0 }}>奨励日がありません</p>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {filteredEncDays.map(d => {
                      const pct = d.targetCount > 0 ? Math.round((d.responseCount / d.targetCount) * 100) : 0;
                      const today = todayJstStr();
                      const isPast = d.deadline < today;
                      const isExpanded = expandedEncDays.has(d.id);
                      return (
                        <div key={d.id} style={{ background: isDarkMode ? '#495057' : '#fff', borderRadius: 8, padding: '8px 12px', border: `1px solid ${isDarkMode ? '#6c757d' : '#e0e0e0'}` }}>
                          <div
                            onClick={() => setExpandedEncDays(prev => {
                              const next = new Set(prev);
                              if (next.has(d.id)) next.delete(d.id); else next.add(d.id);
                              return next;
                            })}
                            style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: isExpanded ? 4 : 0, cursor: 'pointer' }}>
                            <div>
                              <span style={{ fontWeight: 'bold', fontSize: 13, color: isDarkMode ? '#fff' : '#333' }}>{fmtEncDow(d.target_date)}</span>
                              <span style={{ fontSize: 11, color: isPast ? '#dc3545' : (isDarkMode ? '#adb5bd' : '#888'), marginLeft: 8 }}>
                                期限: {fmtEncDow(d.deadline)}{isPast ? '（期限超過）' : ''}
                              </span>
                            </div>
                            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                              <span style={{ fontSize: 11, color: isDarkMode ? '#adb5bd' : '#666' }}>{d.responseCount}/{d.targetCount}人</span>
                              <span style={{ fontSize: 11, color: isDarkMode ? '#adb5bd' : '#888' }}>{isExpanded ? '▲' : '▼'}</span>
                            </div>
                          </div>
                          {isExpanded && (
                            <>
                              <div style={{ height: 6, borderRadius: 3, background: isDarkMode ? '#6c757d' : '#e9ecef', overflow: 'hidden' }}>
                                <div style={{ height: '100%', borderRadius: 3, background: pct === 100 ? '#28a745' : '#007bff', width: `${pct}%`, transition: 'width 0.3s' }} />
                              </div>
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginTop: 6 }}>
                                {encDeleteId === d.id ? (
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', flex: 1 }}>
                                    <span style={{ fontSize: 11, color: '#dc3545', fontWeight: 'bold' }}>削除しますか？対象者・回答・承認済みの有給申請もすべて消えます（元に戻せません）</span>
                                    <button onClick={() => handleDeleteEncDay(d)} disabled={encDeleting}
                                      style={{ padding: '3px 10px', background: '#dc3545', color: '#fff', border: 'none', borderRadius: 6, fontSize: 11, cursor: encDeleting ? 'default' : 'pointer', fontWeight: 'bold' }}>
                                      {encDeleting ? '削除中...' : '削除する'}</button>
                                    <button onClick={() => setEncDeleteId(null)} disabled={encDeleting}
                                      style={{ padding: '3px 10px', background: 'none', color: isDarkMode ? '#fff' : '#333', border: `1px solid ${isDarkMode ? '#6c757d' : '#ccc'}`, borderRadius: 6, fontSize: 11, cursor: 'pointer' }}>やめる</button>
                                  </div>
                                ) : (
                                  <>
                                    <button onClick={() => setEncDeleteId(d.id)}
                                      style={{ padding: '3px 10px', background: 'none', color: '#dc3545', border: '1px solid #dc3545', borderRadius: 6, fontSize: 11, cursor: 'pointer' }}>削除</button>
                                    <button onClick={() => { setShowEncDetail(d.id); fetchEncDetail(d.id); }}
                                      style={{ padding: '3px 10px', background: '#17a2b8', color: '#fff', border: 'none', borderRadius: 6, fontSize: 11, cursor: 'pointer' }}>確認</button>
                                  </>
                                )}
                              </div>
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* フィルターボタン */}
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 16, justifyContent: 'center', alignItems: 'center' }}>
                {leaveFilters.map(f => (
                  <button
                    key={f.key}
                    onClick={() => { setAbsenceView(false); setLeaveStatusFilter(f.key); }}
                    style={{
                      padding: '5px 12px', borderRadius: 16, border: 'none', cursor: 'pointer', fontSize: 12,
                      background: !absenceView && leaveStatusFilter === f.key ? '#007bff' : (isDarkMode ? '#495057' : '#e9ecef'),
                      color: !absenceView && leaveStatusFilter === f.key ? 'white' : (isDarkMode ? '#fff' : '#333'),
                      fontWeight: !absenceView && leaveStatusFilter === f.key ? 'bold' : 'normal',
                    }}
                  >{f.label}</button>
                ))}
                <span style={{ color: isDarkMode ? '#6c757d' : '#ccc', fontSize: 16, margin: '0 4px' }}>┊</span>
                <button
                  onClick={() => setAbsenceView(true)}
                  style={{
                    padding: '5px 14px', borderRadius: 16, border: absenceView ? 'none' : `1px solid ${isDarkMode ? '#dc3545' : '#dc3545'}`, cursor: 'pointer', fontSize: 12,
                    background: absenceView ? '#dc3545' : 'transparent',
                    color: absenceView ? 'white' : '#dc3545',
                    fontWeight: absenceView ? 'bold' : 'normal',
                  }}
                >欠勤</button>
              </div>

              {/* 絞り込みフィルター（欠勤ビュー以外） */}
              {!absenceView && (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14, alignItems: 'center', justifyContent: 'center' }}>
                  <select value={filterFY === '__current__' ? String(nowFY) : filterFY} onChange={e => setFilterFY(e.target.value)}
                    style={{ padding: '5px 10px', borderRadius: 8, border: `1px solid ${isDarkMode ? '#6c757d' : '#ccc'}`, background: isDarkMode ? '#495057' : '#fff', color: isDarkMode ? '#fff' : '#333', fontSize: 12 }}>
                    <option value="all">全年度</option>
                    {fyOptions.map(fy => <option key={fy} value={String(fy)}>{fy}年度（{fy}/4/1〜{fy+1}/3/31）</option>)}
                  </select>
                  <SearchableSelect value={filterPerson} options={personOptions} onChange={setFilterPerson} isDarkMode={isDarkMode} />
                  <select value={filterType} onChange={e => setFilterType(e.target.value)}
                    style={{ padding: '5px 10px', borderRadius: 8, border: `1px solid ${isDarkMode ? '#6c757d' : '#ccc'}`, background: isDarkMode ? '#495057' : '#fff', color: isDarkMode ? '#fff' : '#333', fontSize: 12 }}>
                    <option value="all">全種別</option>
                    {typeOptions.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                  {(filterFY !== '__current__' || filterPerson !== 'all' || filterType !== 'all') && (
                    <button onClick={() => { setFilterFY('__current__'); setFilterPerson('all'); setFilterType('all'); }}
                      style={{ padding: '4px 10px', borderRadius: 8, border: 'none', background: '#6c757d', color: '#fff', fontSize: 11, cursor: 'pointer' }}>
                      リセット
                    </button>
                  )}
                  <span style={{ fontSize: 11, color: isDarkMode ? '#adb5bd' : '#888' }}>
                    ※ 未完了の申請は年度に関わらず常に表示（人名で絞れます）
                  </span>
                </div>
              )}

              {absenceView ? (() => {
                const toAbsFY = (dateStr: string) => { const d = new Date(dateStr); return d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1; };
                const absFyOptions = [...new Set(absenceRecs.map(r => toAbsFY(r.date)))].sort((a,b)=>b-a);
                if (!absFyOptions.includes(nowFY)) absFyOptions.unshift(nowFY);
                const absPersonOptions = [...new Map(absenceRecs.map(r => [r.user_id, r.targetName])).entries()].sort((a,b)=>a[1]>b[1]?1:-1);
                const activeFY = absFilterFY === '__current__' ? nowFY : (absFilterFY === 'all' ? null : Number(absFilterFY));
                const filteredAbsRecs = absenceRecs.filter(r => {
                  if (activeFY !== null && toAbsFY(r.date) !== activeFY) return false;
                  if (absFilterPerson !== 'all' && r.user_id !== absFilterPerson) return false;
                  if (absFilterType !== 'all' && r.type !== absFilterType) return false;
                  return true;
                }).sort((a, b) => {
                  const av = absSortKey === 'date' ? a.date : a.created_at;
                  const bv = absSortKey === 'date' ? b.date : b.created_at;
                  return absSortAsc ? av.localeCompare(bv) : bv.localeCompare(av);
                });
                return (
                  <>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14, alignItems: 'center', justifyContent: 'center' }}>
                      <select value={absFilterFY === '__current__' ? String(nowFY) : absFilterFY} onChange={e => setAbsFilterFY(e.target.value)}
                        style={{ padding: '5px 10px', borderRadius: 8, border: `1px solid ${isDarkMode ? '#6c757d' : '#ccc'}`, background: isDarkMode ? '#495057' : '#fff', color: isDarkMode ? '#fff' : '#333', fontSize: 12 }}>
                        <option value="all">全年度</option>
                        {absFyOptions.map(fy => <option key={fy} value={String(fy)}>{fy}年度（{fy}/4/1〜{fy+1}/3/31）</option>)}
                      </select>
                      <SearchableSelect value={absFilterPerson} options={absPersonOptions} onChange={setAbsFilterPerson} isDarkMode={isDarkMode} />
                      <select value={absFilterType} onChange={e => setAbsFilterType(e.target.value)}
                        style={{ padding: '5px 10px', borderRadius: 8, border: `1px solid ${isDarkMode ? '#6c757d' : '#ccc'}`, background: isDarkMode ? '#495057' : '#fff', color: isDarkMode ? '#fff' : '#333', fontSize: 12 }}>
                        <option value="all">全種別</option>
                        {Object.entries(ABSENCE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                      </select>
                      {(absFilterFY !== '__current__' || absFilterPerson !== 'all' || absFilterType !== 'all') && (
                        <button onClick={() => { setAbsFilterFY('__current__'); setAbsFilterPerson('all'); setAbsFilterType('all'); }}
                          style={{ padding: '4px 10px', borderRadius: 8, border: 'none', background: '#6c757d', color: '#fff', fontSize: 11, cursor: 'pointer' }}>
                          リセット
                        </button>
                      )}
                      {/* 欠勤・遅刻・早退CSV（表示中の絞り込み結果を1日1行で出力） */}
                      <button onClick={() => {
                        if (filteredAbsRecs.length === 0) return;
                        const esc = (v: string | number | null | undefined) => {
                          const s = v == null ? '' : String(v);
                          return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
                        };
                        const headers = ['日付', '対象者', '種別', '時間', '校', '勤務時間帯', '備考', '追加者', '追加日'];
                        const rows = [...filteredAbsRecs]
                          .sort((a, b) => a.date.localeCompare(b.date))
                          .map(r => [
                            r.date, r.targetName, absenceLabel(r.type),
                            r.actual_time ? r.actual_time.slice(0, 5) : '',
                            r.original_location ? `${r.original_location}→${r.location ?? ''}` : (r.location ?? ''),
                            r.work_segments.length > 0 ? formatSegments(r.work_segments) : '',
                            r.notes ?? '', r.creatorName,
                            r.created_at.slice(0, 10),
                          ].map(esc).join(','));
                        const csv = '﻿' + [headers.join(','), ...rows].join('\n');
                        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
                        const a = document.createElement('a');
                        a.href = URL.createObjectURL(blob);
                        a.download = `欠勤遅刻早退_${absFilterFY === 'all' ? '全年度' : `${activeFY}年度`}.csv`;
                        a.click();
                        URL.revokeObjectURL(a.href);
                      }} style={{ padding: '4px 12px', borderRadius: 8, border: 'none', background: '#28a745', color: '#fff', fontSize: 11, fontWeight: 'bold', cursor: 'pointer' }}>
                        📥 CSV出力
                      </button>
                    </div>
                    {absenceLoading ? (
                      <p style={{ textAlign: 'center', color: isDarkMode ? '#fff' : '#000' }}>読み込み中...</p>
                    ) : filteredAbsRecs.length === 0 ? (
                      <p style={{ textAlign: 'center', color: isDarkMode ? '#aaa' : '#666' }}>欠勤記録はありません</p>
                    ) : (
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', color: isDarkMode ? '#fff' : '#000', fontSize: 13 }}>
                      <thead>
                        <tr style={{ background: isDarkMode ? '#5a1a1a' : '#fdf0f0' }}>
                          {[
                            { label: '追加日', sortKey: 'created_at' as const },
                            { label: '追加者' },
                            { label: '対象者' },
                            { label: '種別' },
                            { label: '日付', sortKey: 'date' as const },
                            { label: '時間' },
                            { label: '校' },
                            { label: '備考' },
                            { label: '操作' },
                          ].map(col => (
                            <th key={col.label} style={{ padding: '8px 6px', textAlign: 'center', borderBottom: `2px solid #dc3545`, color: isDarkMode ? '#fff' : '#333', fontSize: 12, cursor: col.sortKey ? 'pointer' : 'default', userSelect: 'none' }}
                              onClick={() => {
                                if (!col.sortKey) return;
                                if (absSortKey === col.sortKey) setAbsSortAsc(v => !v);
                                else { setAbsSortKey(col.sortKey); setAbsSortAsc(false); }
                              }}>
                              {col.label}{col.sortKey && (absSortKey === col.sortKey ? (absSortAsc ? ' ▲' : ' ▼') : ' ↕')}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {filteredAbsRecs.map((rec, i) => {
                          const c = absenceColor(rec.type);
                          const addedDate = new Date(rec.created_at);
                          // 時間帯がある場合（休日出勤・校の移動）は時刻・校の欄をその内訳で置き換える
                          const segs = rec.work_segments;
                          const timeCell = segs.length > 0 ? formatSegments(segs) : (rec.actual_time ? rec.actual_time.slice(0, 5) : '—');
                          return (
                            <tr key={rec.id} style={{ background: i % 2 === 0 ? (isDarkMode ? '#343a40' : 'white') : (isDarkMode ? '#3d4349' : '#fdf8f8') }}>
                              <td style={{ padding: '8px 6px', borderBottom: `1px solid ${isDarkMode ? '#6c757d' : '#f0d0d0'}`, textAlign: 'center', fontSize: 11, color: isDarkMode ? '#adb5bd' : '#666' }}>
                                <div>{addedDate.toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'numeric', day: 'numeric' })}</div>
                                <div>{addedDate.toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: 'numeric', minute: '2-digit' })}</div>
                              </td>
                              <td style={{ padding: '8px 6px', borderBottom: `1px solid ${isDarkMode ? '#6c757d' : '#f0d0d0'}`, textAlign: 'center', fontSize: 12 }}>{rec.creatorName}</td>
                              <td style={{ padding: '8px 6px', borderBottom: `1px solid ${isDarkMode ? '#6c757d' : '#f0d0d0'}`, textAlign: 'center', fontSize: 12, fontWeight: 'bold' }}>{rec.targetName}</td>
                              <td style={{ padding: '8px 6px', borderBottom: `1px solid ${isDarkMode ? '#6c757d' : '#f0d0d0'}`, textAlign: 'center' }}>
                                <span style={{ padding: '2px 8px', borderRadius: 6, background: c.bg, color: c.text, fontSize: 11, fontWeight: 'bold' }}>{absenceLabel(rec.type)}</span>
                              </td>
                              <td style={{ padding: '8px 6px', borderBottom: `1px solid ${isDarkMode ? '#6c757d' : '#f0d0d0'}`, textAlign: 'center', fontSize: 12 }}>{rec.date}</td>
                              <td style={{ padding: '8px 6px', borderBottom: `1px solid ${isDarkMode ? '#6c757d' : '#f0d0d0'}`, textAlign: 'center', fontSize: 12, whiteSpace: segs.length > 0 ? 'normal' : 'nowrap' }}>{timeCell}</td>
                              <td style={{ padding: '8px 6px', borderBottom: `1px solid ${isDarkMode ? '#6c757d' : '#f0d0d0'}`, textAlign: 'center', fontSize: 12 }}>
                                {rec.original_location ? `${rec.original_location}→${rec.location || ''}` : (rec.location || '—')}
                              </td>
                              <td style={{ padding: '8px 6px', borderBottom: `1px solid ${isDarkMode ? '#6c757d' : '#f0d0d0'}`, textAlign: 'left', fontSize: 12, color: isDarkMode ? '#adb5bd' : '#666' }}>{rec.notes || '—'}</td>
                              <td style={{ padding: '8px 6px', borderBottom: `1px solid ${isDarkMode ? '#6c757d' : '#f0d0d0'}`, textAlign: 'center' }}>
                                <button onClick={() => setDeleteTarget(rec)} style={{ padding: '3px 10px', background: 'transparent', border: '1px solid #dc3545', color: '#dc3545', borderRadius: 6, cursor: 'pointer', fontSize: 11 }}>取消</button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                    )}
                  </>
                );
              })() : loadingLeaveRequests ? (
                <p style={{ textAlign: 'center', color: isDarkMode ? '#fff' : '#000' }}>読み込み中...</p>
              ) : filteredLeave.length === 0 ? (
                <p style={{ textAlign: 'center', color: isDarkMode ? '#aaa' : '#666' }}>該当する申請はありません</p>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', color: isDarkMode ? '#fff' : '#000', fontSize: 13 }}>
                    <thead>
                      <tr style={{ background: isDarkMode ? '#495057' : '#f8f9fa' }}>
                        {[
                          { label: '申請日', w: 70 }, { label: '申請者', w: 65 }, { label: '申請先', w: 65 },
                          { label: '種別', w: 55 }, { label: '休暇日', w: 100 },
                          { label: '日数', w: 40 }, { label: '事由・備考', w: 100 }, { label: '確認状況', w: 85 }, { label: '操作', w: 90 },
                        ].map(col => (
                          <th key={col.label} style={{ padding: '8px 4px', textAlign: 'center', borderBottom: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, color: isDarkMode ? '#fff' : '#000', width: col.w, fontSize: 12 }}>{col.label}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {treeRows.map(({ req, indent }, i) => {
                        const leaveDates: string[] = (() => { try { return req.leave_dates ? JSON.parse(req.leave_dates) : []; } catch { return []; } })();
                        const days = leaveDates.length > 0
                          ? leaveDates.length
                          : Math.max(1, Math.floor((new Date(req.end_date || '').getTime() - new Date(req.start_date || '').getTime()) / (1000 * 60 * 60 * 24)) + 1);
                        // 休暇日を "2026/6/3・4・8、7/1・2" 形式に整形
                        const dateDisplay = (() => {
                          if (leaveDates.length > 0) {
                            const year = leaveDates[0].substring(0, 4);
                            const groups = new Map<string, number[]>();
                            leaveDates.forEach(d => {
                              const m = String(parseInt(d.substring(5, 7)));
                              const day = parseInt(d.substring(8));
                              if (!groups.has(m)) groups.set(m, []);
                              groups.get(m)!.push(day);
                            });
                            const parts = [...groups.entries()].map(([m, ds]) => `${m}/${ds.join('・')}`);
                            return `${year}/${parts.join('、')}`;
                          }
                          // fallback: 旧形式
                          if (req.start_date === req.end_date) return req.start_date;
                          return `${(req.start_date || '').slice(5)}～${(req.end_date || '').slice(5)}`;
                        })();
                        const jst = new Date(req.created_at);
                        const jstParts = Object.fromEntries(new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: false }).formatToParts(jst).map(p => [p.type, p.value]));
                        const jstY = jstParts.year; const jstM = Number(jstParts.month); const jstD = Number(jstParts.day); const jstH = Number(jstParts.hour); const jstMin = jstParts.minute;
                        const st = getStatusDisplay(req);
                        return (
                          <React.Fragment key={req.id}>
                          <tr
                            ref={req.id === focusId ? focusRowRef : undefined}
                            style={{ background: req.id === focusId ? (isDarkMode ? '#4a3f1a' : '#fff9c4') : indent ? (isDarkMode ? '#1e3a1e' : '#f0fff4') : (i % 2 === 0 ? (isDarkMode ? '#343a40' : 'white') : (isDarkMode ? '#3d4349' : '#f8f9fa')), transition: 'background 0.6s' }}
                          >
                            <td style={{ padding: '8px 4px', borderBottom: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, textAlign: 'center', fontSize: 12, borderLeft: indent ? '3px solid #28a745' : undefined, paddingLeft: indent ? 8 : undefined }}>
                              {indent && <div style={{ fontSize: 9, color: '#28a745', lineHeight: 1 }}>└→</div>}
                              <div>{jstY}/{jstM}/{jstD}</div><div>{jstH}:{jstMin}</div>
                            </td>
                            <td style={{ padding: '8px 4px', borderBottom: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, textAlign: 'center', fontSize: 12 }}>
                              {req.profile?.name || '-'}
                            </td>
                            <td style={{ padding: '8px 4px', borderBottom: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, textAlign: 'center', fontSize: 12 }}>
                              {req.approver?.name || '-'}
                            </td>
                            <td style={{ padding: '8px 4px', borderBottom: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, textAlign: 'center', fontSize: 12, wordBreak: 'break-word' }}>{req.leave_type === 'その他' ? req.leave_type_other : req.leave_type}</td>
                            <td style={{ padding: '8px 4px', borderBottom: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, textAlign: 'center', fontSize: 11 }}>{dateDisplay}</td>
                            <td style={{ padding: '8px 4px', borderBottom: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, textAlign: 'center', fontSize: 12 }}>{days}日</td>
                            <td style={{ padding: '8px 4px', borderBottom: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, textAlign: 'left', fontSize: 12, wordBreak: 'break-word' }}>
                              {req.purpose && <div>{req.purpose}</div>}
                              {req.reason && (() => {
                                const displayReason = req.reason.replace(/[\s　]?【再申請】元申請ID: \S+/g, '').replace(/【管理者が種別変更】[^　]+(（変更して受理）)?/g, '').trim();
                                const isReapply = req.reason.includes('【再申請】');
                                const isModified = !!req.modified_by;
                                return (
                                  <>
                                    {displayReason && <div style={{ color: isDarkMode ? '#adb5bd' : '#666', fontSize: 11 }}>備考: {displayReason}</div>}
                                    {isReapply && (() => {
                                      const parentId = req.reason?.match(/【再申請】元申請ID: (\S+)/)?.[1] ?? null;
                                      const isOpen = expandedReapply === req.id;
                                      return (
                                        <button onClick={() => setExpandedReapply(isOpen ? null : req.id)}
                                          style={{ fontSize: 10, background: '#007bff', color: '#fff', borderRadius: 4, padding: '2px 6px', marginTop: 3, display: 'inline-block', border: 'none', cursor: 'pointer' }}>
                                          {isOpen ? '▼ 再申請' : '▶ 再申請'}
                                        </button>
                                      );
                                      void parentId;
                                    })()}
                                    {(isModified || historyReqIds.has(req.id)) && (() => {
                                      const isOpen = expandedModify.has(req.id);
                                      return (
                                        <button onClick={() => { if (!isOpen && !leaveHistory[req.id]) loadLeaveHistory(req.id); setExpandedModify(prev => { const next = new Set(prev); isOpen ? next.delete(req.id) : next.add(req.id); return next; }); }}
                                          style={{ fontSize: 10, background: '#fd7e14', color: '#fff', borderRadius: 4, padding: '2px 6px', marginTop: 3, marginLeft: 3, display: 'inline-block', border: 'none', cursor: 'pointer' }}>
                                          {isOpen ? '▼ 修正履歴' : '▶ 修正履歴'}
                                        </button>
                                      );
                                    })()}
                                  </>
                                );
                              })()}
                              {!req.purpose && !req.reason && !req.modified_by && !historyReqIds.has(req.id) && <span>-</span>}
                            </td>
                            <td style={{ padding: '8px 4px', borderBottom: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, textAlign: 'center' }}>
                              <div style={{ display: 'inline-block', padding: '3px 8px', borderRadius: 8, background: st.color, color: 'white', textAlign: 'center', lineHeight: 1.4 }}>
                                {st.role && <div style={{ fontSize: 9, opacity: 0.9, whiteSpace: 'nowrap' }}>{st.role}</div>}
                                <div style={{ fontWeight: 'bold', fontSize: 11, whiteSpace: 'nowrap' }}>{st.name}</div>
                              </div>
                            </td>
                            <td style={{ padding: '8px 4px', borderBottom: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}`, textAlign: 'center' }}>
                              <div style={{ display: 'flex', gap: 4, justifyContent: 'center', alignItems: 'center' }}>
                              {req.status !== 'cancelled' && (
                                <button
                                  onClick={() => setEditingLeave(req)}
                                  style={{ padding: '4px 8px', background: '#fd7e14', color: 'white', border: '2px solid #d96b0c', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 'bold' }}
                                >📋 修正</button>
                              )}
                              {req.status === 'rejected' && (
                                <button
                                  onClick={() => {
                                    setConfirmDialog({ message: '差し戻しを取り消して最初に戻しますか？', onConfirm: async () => {
                                      await supabase.from('leave_requests').update({ status: 'pending', rejected_reason: null }).eq('id', req.id);
                                      fetchLeaveRequests();
                                    } });
                                  }}
                                  style={{ padding: '4px 8px', background: '#6c757d', color: 'white', border: '2px solid #545b62', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 'bold' }}
                                >↩ 取り消し</button>
                              )}
                              {req.status === 'approved' && (
                                <button
                                  onClick={() => { setRejectModal(req); setRejectReason(''); setRejectNewType(''); }}
                                  style={{ padding: '4px 8px', background: '#dc3545', color: 'white', border: '2px solid #bd2130', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 'bold' }}
                                >差戻</button>
                              )}
                              {req.status !== 'approved' && req.status !== 'rejected' && (
                                <div style={{ display: 'flex', gap: 4 }}>
                                  <button
                                    onClick={async () => {
                                      if (req.status === 'pending') {
                                        // マネージャー選択モーダルを開く
                                        const { data: mgrs } = await supabase.from('profiles').select('id, name, role_title').eq('role_title', 'マネージャー').eq('is_active', true).order('name');
                                        setAdminManagerList(mgrs || []);
                                        setAdminSelectedManagerId(mgrs && mgrs.length > 0 ? mgrs[0].id : '');
                                        setAdminSelectingManagerFor(req);
                                      } else {
                                        setConfirmDialog({ message: '受理しますか？', onConfirm: async () => {
                                        // 調整休はマネージャー受理で完了（経理・社長ステップをスキップ）。受理ページ(LeaveApprovals)と挙動を揃える
                                        const isChosei = req.leave_type === '調整休';
                                        const nextStatus: Record<string, string> = { step2_pending: isChosei ? 'approved' : 'manager_approved', manager_approved: 'admin_approved', admin_approved: 'approved' };
                                        const nextSt = nextStatus[req.status] || 'approved';
                                        // 二重受理防止（楽観ロック）：自分が見た状態と一致する時だけ更新
                                        const { data: locked } = await supabase.from('leave_requests').update({ status: nextSt }).eq('id', req.id).eq('status', req.status).select('id');
                                        if (!locked || locked.length === 0) { setSuccessMsg('⚠ この申請は他の受理者が先に処理したため、最新の状態に更新しました'); fetchLeaveRequests(); return; }

                                        // 🚨 受理はDBで確定済み。画面の更新は通知（数秒かかる）より先に行う
                                        setSuccessMsg('受理しました');
                                        fetchLeaveRequests();

                                        // マネージャー受理時にGoogleカレンダーへ書き込む
                                        if (nextSt === 'manager_approved' || nextSt === 'approved') {
                                          try {
                                            const dates: string[] = req.leave_dates ? JSON.parse(req.leave_dates) : [];
                                            if (dates.length > 0) {
                                              await supabase.functions.invoke('gcal-sync', {
                                                body: {
                                                  action: 'upsert',
                                                  source_type: 'leave',
                                                  source_id: req.id,
                                                  dates,
                                                  name: req.profile?.name ?? '',
                                                  leave_type: req.leave_type,
                                                  locations: parseLeaveLocations(req.leave_locations),
                                                },
                                              });
                                            }
                                          } catch (e) {
                                            console.error('[gcal-sync] 書き込み失敗:', e);
                                          }
                                        }

                                        // 🚨 通知の失敗を受理の成否に巻き込まない。
                                        // 以前はここで例外が出ると下の fetchLeaveRequests() に到達せず、
                                        // 「はいを押しても画面が変わらない・リロードすると受理済み」になっていた
                                        try {
                                        const typeName = req.leave_type === 'その他' ? (req.leave_type_other || 'その他') : req.leave_type;
                                        if (req.status === 'step2_pending') {
                                          const daysCount = req.leave_dates ? (() => { try { return String(JSON.parse(req.leave_dates).length); } catch { return ''; } })() : '';
                                          const vars = { 休暇種別: typeName, 申請日数: daysCount, リンク: 'https://fivem-portal.vercel.app/leave?tab=history' };
                                          if (await shouldSend('leave:manager_approved', 'site')) {
                                            const t = await getNotificationTemplate('leave:manager_approved', 'site', vars);
                                            // 🚨 event_key を渡さないとプッシュが飛ばない（2026-08-18 修正・受理ページ側と同じ）
                                            await insertNotification(req.user_id, t?.template ?? `休暇申請がマネージャーに受理されました`, t?.subject || `種別：${typeName}`, 'leave_request', req.id, 'leave:manager_approved');
                                          }
                                          // リーダー・マネージャー・社長へ FYI（誰がいつ休むか共有／カレンダー着地）。範囲は通知設定 leave:approved_fyi に従う
                                          try {
                                            let fyiDates: string[] = [];
                                            try { if (req.leave_dates) fyiDates = JSON.parse(req.leave_dates); } catch { /* leave_datesなし→start_dateで補完 */ }
                                            if (fyiDates.length === 0 && req.start_date) fyiDates = [req.start_date];
                                            if (fyiDates.length > 0) {
                                              await supabase.functions.invoke('leave-approved-notify', {
                                                body: { applicant_id: req.user_id, applicant_name: req.profile?.name ?? '', leave_dates: fyiDates, leave_type: typeName },
                                              });
                                            }
                                          } catch (e) { console.error('[leave-approved-notify] FYI通知失敗:', e); }
                                          if (await shouldSend('leave:manager_approved', 'slack')) {
                                            await sendLeaveSlack('manager_approved', '管理者', 'マネージャー');
                                          }
                                          const applicantEmail = await getUserEmail(req.user_id) ?? '';
                                          // 宛先で役職を選んでいれば上長にも共有（受理ページ側と同じ配線にする）
                                          const [mgrSite, mgrMail] = await Promise.all([
                                            resolveRoleRecipients(req.user_id, 'leave:manager_approved', 'site'),
                                            resolveRoleRecipients(req.user_id, 'leave:manager_approved', 'email'),
                                          ]);
                                          await dispatchSiteNotification('leave:manager_approved', vars, mgrSite.ids, insertNotification, 'leave_request', req.id);
                                          await dispatchEmail('leave:manager_approved', vars, { applicant: applicantEmail, ...mgrMail.emails });
                                        }
                                        if (req.status === 'manager_approved' && await shouldSend('leave:manager_approved', 'slack')) {
                                          await sendLeaveSlack('accounting_approved', '経理担当者', '管理者');
                                        }
                                        } catch (e) {
                                          console.error('[leave] 受理後の通知に失敗:', e);
                                          setSuccessMsg('⚠ 受理しましたが、通知の送信に失敗しました。相手に直接お知らせしてください。');
                                        }
                                        } });
                                      }
                                    }}
                                    style={{ padding: '4px 8px', background: '#28a745', color: 'white', border: '2px solid #1e7e34', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 'bold' }}
                                  >受理</button>
                                  <button
                                    onClick={() => { setRejectModal(req); setRejectReason(''); setRejectNewType(''); }}
                                    style={{ padding: '4px 8px', background: '#dc3545', color: 'white', border: '2px solid #bd2130', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 'bold' }}
                                  >差戻</button>
                                </div>
                              )}
                              <button
                                onClick={() => {
                                  setConfirmDialog({ message: 'この申請を削除します。\n本当に削除しますか？この操作は取り消せません。', onConfirm: async () => {
                                    // 🚨 削除件数を必ず見る。RLSで0件でもエラーは返らないため、
                                    // 権限が足りないと「消えたように見えて実は残っている」ことになる
                                    const { data: deleted, error } = await supabase.from('leave_requests').delete().eq('id', req.id).select('id');
                                    if (error) { setSuccessMsg('⚠ 削除に失敗しました: ' + error.message); return; }
                                    if (!deleted || deleted.length === 0) {
                                      setSuccessMsg('⚠ 削除できませんでした（権限/RLSの可能性）。管理者アカウントでログインしているかご確認ください。');
                                      fetchLeaveRequests();
                                      return;
                                    }
                                    const gcalOk = await deleteLeaveGcal(req.id);
                                    setSuccessMsg(gcalOk
                                      ? '申請を削除しました'
                                      : '⚠ 削除しましたが、Googleカレンダーからの削除に失敗しました。カレンダーを確認してください。');
                                    fetchLeaveRequests();
                                  } });
                                }}
                                style={{ padding: '4px 3px', background: 'transparent', color: isDarkMode ? '#888' : '#aaa', border: `1px solid ${isDarkMode ? '#555' : '#ddd'}`, borderRadius: 4, cursor: 'pointer', fontSize: 9, writingMode: 'vertical-rl', letterSpacing: 1 }}
                              >削除</button>
                              </div>
                            </td>
                          </tr>
                          {/* 再申請展開行：元申請の情報を同列フォーマットで表示 */}
                          {expandedReapply === req.id && (() => {
                            const parentId = req.reason?.match(/【再申請】元申請ID: (\S+)/)?.[1];
                            const parent = parentId ? leaveRequests.find(r => r.id === parentId) : null;
                            if (!parent) return (
                              <tr key={`expand-${req.id}`}>
                                <td colSpan={9} style={{ padding: '6px 12px', background: isDarkMode ? '#2a3a2a' : '#f0fff4', fontSize: 11, color: isDarkMode ? '#adb5bd' : '#666', borderBottom: `1px solid ${isDarkMode ? '#6c757d' : '#dee2e6'}` }}>
                                  元申請のデータが見つかりません
                                </td>
                              </tr>
                            );
                            const pLeaveDates: string[] = (() => { try { return parent.leave_dates ? JSON.parse(parent.leave_dates) : []; } catch { return []; } })();
                            const pDays = pLeaveDates.length > 0 ? pLeaveDates.length : Math.max(1, Math.floor((new Date(parent.end_date || '').getTime() - new Date(parent.start_date || '').getTime()) / (1000 * 60 * 60 * 24)) + 1);
                            const pDateDisplay = pLeaveDates.length > 0
                              ? (() => {
                                  const year = pLeaveDates[0].substring(0, 4);
                                  const groups = new Map<string, string[]>();
                                  pLeaveDates.forEach(d => { const [,m,day] = d.split('-'); const key = `${m}`; if (!groups.has(key)) groups.set(key, []); groups.get(key)!.push(day.replace(/^0/, '')); });
                                  return `${year}/${[...groups.entries()].map(([m, ds]) => `${m}/${ds.join('・')}`).join('、')}`;
                                })()
                              : (parent.start_date === parent.end_date ? parent.start_date : `${(parent.start_date || '').slice(5)}～${(parent.end_date || '').slice(5)}`);
                            const pJst = new Date(parent.created_at);
                            const pJstParts = Object.fromEntries(new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: false }).formatToParts(pJst).map(p => [p.type, p.value]));
                            const pJstY = pJstParts.year; const pJstM = Number(pJstParts.month); const pJstD = Number(pJstParts.day); const pJstH = Number(pJstParts.hour); const pJstMin = pJstParts.minute;
                            const pSt = getStatusDisplay(parent);
                            const pDisplayReason = (parent.reason || '').replace(/[\s　]?【再申請】元申請ID: \S+/g, '').trim();
                            return (
                              <tr key={`expand-${req.id}`} style={{ background: isDarkMode ? '#1e3a1e' : '#f0fff4' }}>
                                <td style={{ padding: '6px 4px', borderBottom: `2px solid #28a745`, textAlign: 'center', fontSize: 11, borderLeft: '4px solid #28a745', color: isDarkMode ? '#adb5bd' : '#555' }}>
                                  <div style={{ fontSize: 9, color: '#28a745' }}>元申請</div>
                                  <div>{pJstY}/{pJstM}/{pJstD}</div><div>{pJstH}:{pJstMin}</div>
                                </td>
                                <td style={{ padding: '6px 4px', borderBottom: `2px solid #28a745`, textAlign: 'center', fontSize: 11, color: isDarkMode ? '#adb5bd' : '#555' }}>
                                  {parent.profile?.name || '-'}
                                </td>
                                <td style={{ padding: '6px 4px', borderBottom: `2px solid #28a745`, textAlign: 'center', fontSize: 11, color: isDarkMode ? '#adb5bd' : '#555' }}>
                                  {parent.approver?.name || '-'}
                                </td>
                                <td style={{ padding: '6px 4px', borderBottom: `2px solid #28a745`, textAlign: 'center', fontSize: 11, color: isDarkMode ? '#adb5bd' : '#555' }}>{parent.leave_type === 'その他' ? parent.leave_type_other : parent.leave_type}</td>
                                <td style={{ padding: '6px 4px', borderBottom: `2px solid #28a745`, textAlign: 'center', fontSize: 10, color: isDarkMode ? '#adb5bd' : '#555' }}>{pDateDisplay}</td>
                                <td style={{ padding: '6px 4px', borderBottom: `2px solid #28a745`, textAlign: 'center', fontSize: 11, color: isDarkMode ? '#adb5bd' : '#555' }}>{pDays}日</td>
                                <td style={{ padding: '6px 4px', borderBottom: `2px solid #28a745`, textAlign: 'left', fontSize: 11, wordBreak: 'break-word', color: isDarkMode ? '#adb5bd' : '#555' }}>
                                  {parent.purpose && <div>{parent.purpose}</div>}
                                  {pDisplayReason && <div style={{ fontSize: 10 }}>備考: {pDisplayReason}</div>}
                                  {parent.rejected_reason && <div style={{ fontSize: 10, color: '#dc3545' }}>差し戻し理由: {parent.rejected_reason}</div>}
                                </td>
                                <td style={{ padding: '6px 4px', borderBottom: `2px solid #28a745`, textAlign: 'center' }}>
                                  <div style={{ display: 'inline-block', padding: '3px 8px', borderRadius: 8, background: pSt.color, color: 'white', textAlign: 'center', lineHeight: 1.4 }}>
                                    <div style={{ fontWeight: 'bold', fontSize: 11 }}>{pSt.name}</div>
                                  </div>
                                </td>
                                <td style={{ padding: '6px 4px', borderBottom: `2px solid #28a745` }} />
                              </tr>
                            );
                          })()}
                          {/* 修正展開行 */}
                          {expandedModify.has(req.id) && (() => {
                            const rows = leaveHistory[req.id];
                            // 旧データ（履歴テーブルが無い時代の種別変更）フォールバック
                            const matchChange = req.reason?.match(/【管理者が種別変更】(.+?) → (.+?)（変更して受理）/);
                            const modifiedAtJst = req.modified_at ? new Date(req.modified_at) : null;
                            const fmtDt = (s: string) => new Date(s).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' });
                            return (
                              <tr key={`modify-${req.id}`} style={{ background: isDarkMode ? '#2a1e00' : '#fff8f0' }}>
                                <td colSpan={9} style={{ padding: '8px 12px', borderBottom: `2px solid #fd7e14`, borderLeft: '4px solid #fd7e14' }}>
                                  <div style={{ fontSize: 12, fontWeight: 'bold', color: isDarkMode ? '#ffe082' : '#7c4d00', marginBottom: 6 }}>修正履歴</div>
                                  {!rows ? (
                                    <div style={{ fontSize: 12, color: isDarkMode ? '#adb5bd' : '#666' }}>読み込み中...</div>
                                  ) : rows.length === 0 ? (
                                    matchChange ? (
                                      <div style={{ fontSize: 12, color: isDarkMode ? '#eee' : '#333' }}>
                                        <HistoryBadge kind="type_change" isDarkMode={isDarkMode} labelOverride={LEAVE_KIND_LABELS} />
                                        <span style={{ marginLeft: 8 }}>{req.modifier?.name ?? '管理者'}</span>
                                        {modifiedAtJst && <span style={{ marginLeft: 8, color: isDarkMode ? '#adb5bd' : '#666' }}>{modifiedAtJst.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>}
                                        <span style={{ marginLeft: 8 }}>「{matchChange[1]}」→「{matchChange[2]}」に変更して受理</span>
                                      </div>
                                    ) : <div style={{ fontSize: 12, color: isDarkMode ? '#adb5bd' : '#666' }}>履歴なし</div>
                                  ) : (
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                                      {rows.map(h => (
                                        <div key={h.id} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                                          <HistoryBadge kind={h.change_kind} isDarkMode={isDarkMode} labelOverride={LEAVE_KIND_LABELS} />
                                          <div style={{ fontSize: 12 }}>
                                            <div style={{ color: isDarkMode ? '#adb5bd' : '#666' }}>{fmtDt(h.changed_at)}　{h.changerName}</div>
                                            {h.changes && <DiffList changes={h.changes} fieldLabels={LEAVE_FIELD_LABELS} isDarkMode={isDarkMode} />}
                                            {h.change_reason && <div style={{ color: isDarkMode ? '#adb5bd' : '#666', marginTop: 2 }}>理由：{h.change_reason}</div>}
                                          </div>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </td>
                              </tr>
                            );
                          })()}
                        </React.Fragment>
                      );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              {/* 管理者による内容修正モーダル */}
              {editingLeave && (
                <LeaveEditModal
                  record={editingLeave}
                  isDarkMode={isDarkMode}
                  onClose={() => setEditingLeave(null)}
                  onSaved={() => {
                    const id = editingLeave.id;
                    setEditingLeave(null);
                    setSuccessMsg('申請内容を修正し、本人へ通知しました');
                    fetchLeaveRequests();
                    setHistoryReqIds(prev => new Set(prev).add(id));
                    loadLeaveHistory(id);
                    setExpandedModify(prev => new Set(prev).add(id));
                  }}
                />
              )}

              {/* 取消確認モーダル */}
              {deleteTarget && (
                <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
                  <div style={{ background: isDarkMode ? '#343a40' : '#fff', borderRadius: 14, padding: 24, width: '100%', maxWidth: 340 }}>
                    <div style={{ fontSize: 16, fontWeight: 'bold', marginBottom: 16, color: '#dc3545' }}>取消の確認</div>
                    <div style={{ border: `1px solid ${isDarkMode ? '#6c757d' : '#e0e0e0'}`, borderRadius: 8, padding: 12, marginBottom: 20, fontSize: 14, color: isDarkMode ? '#fff' : '#333' }}>
                      <div><strong>{deleteTarget.targetName}</strong></div>
                      <div style={{ marginTop: 4 }}>{deleteTarget.date}　{absenceLabel(deleteTarget.type)}{deleteTarget.actual_time ? `　${deleteTarget.actual_time.slice(0, 5)}` : ''}</div>
                      {deleteTarget.work_segments.length > 0 && (
                        <div style={{ marginTop: 4, fontSize: 12, color: isDarkMode ? '#adb5bd' : '#666' }}>勤務：{formatSegments(deleteTarget.work_segments)}</div>
                      )}
                      <div style={{ marginTop: 4, fontSize: 12, color: isDarkMode ? '#adb5bd' : '#666' }}>追加者：{deleteTarget.creatorName}</div>
                      {deleteTarget.notes && <div style={{ marginTop: 4, fontSize: 12, color: isDarkMode ? '#adb5bd' : '#666' }}>備考：{deleteTarget.notes}</div>}
                    </div>
                    <div style={{ fontSize: 13, color: isDarkMode ? '#adb5bd' : '#666', marginBottom: 16 }}>このレコードを削除します。元に戻せません。</div>
                    <div style={{ display: 'flex', gap: 10 }}>
                      <button onClick={() => setDeleteTarget(null)} style={{ flex: 1, padding: 12, background: '#6c757d', color: '#fff', border: 'none', borderRadius: 10, fontSize: 15, cursor: 'pointer' }}>戻る</button>
                      <button onClick={handleDelete} disabled={deleting} style={{ flex: 2, padding: 12, background: '#dc3545', color: '#fff', border: 'none', borderRadius: 10, fontSize: 15, fontWeight: 'bold', cursor: deleting ? 'not-allowed' : 'pointer', opacity: deleting ? 0.7 : 1 }}>
                        {deleting ? '削除中...' : '取消を確定する'}
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* 差し戻しモーダル（管理画面） */}
              {rejectModal && (
                <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
                  <div style={{ background: isDarkMode ? '#343a40' : '#fff', borderRadius: 14, padding: 24, width: '100%', maxWidth: 400 }}>
                    <div style={{ fontSize: 16, fontWeight: 'bold', marginBottom: 4, color: isDarkMode ? '#fff' : '#333' }}>差し戻し</div>
                    <div style={{ fontSize: 13, color: isDarkMode ? '#adb5bd' : '#666', marginBottom: 16 }}>
                      {rejectModal.profile?.name}　{rejectModal.leave_type === 'その他' ? rejectModal.leave_type_other : rejectModal.leave_type}
                    </div>
                    <div style={{ marginBottom: 12 }}>
                      <div style={{ fontSize: 13, color: isDarkMode ? '#adb5bd' : '#666', marginBottom: 6 }}>種別を変更する（任意）</div>
                      <select value={rejectNewType} onChange={e => setRejectNewType(e.target.value)}
                        style={{ width: '100%', padding: '8px', border: `1px solid ${isDarkMode ? '#6c757d' : '#ccc'}`, borderRadius: 8, fontSize: 14, background: isDarkMode ? '#495057' : '#fff', color: isDarkMode ? '#fff' : '#333' }}>
                        <option value="">変更しない</option>
                        {LEAVE_TYPES.filter(t => t !== rejectModal.leave_type).map(t => <option key={t} value={t}>{t}</option>)}
                      </select>
                      {rejectNewType && <div style={{ fontSize: 12, color: '#e65100', marginTop: 4 }}>「{rejectModal.leave_type}」→「{rejectNewType}」に変更して差し戻します</div>}
                    </div>
                    <div style={{ marginBottom: 16 }}>
                      <div style={{ fontSize: 13, color: isDarkMode ? '#adb5bd' : '#666', marginBottom: 6 }}>
                        差し戻し理由（任意）
                        <span style={{ fontSize: 11, color: isDarkMode ? '#adb5bd' : '#999', marginLeft: 8 }}>※種別変更なしの場合、申請者への通知に含まれます</span>
                      </div>
                      <textarea value={rejectReason} onChange={e => setRejectReason(e.target.value)} placeholder="差し戻し理由を入力してください" rows={3}
                        style={{ width: '100%', padding: '10px', border: `1px solid ${isDarkMode ? '#6c757d' : '#ccc'}`, borderRadius: 8, fontSize: 14, boxSizing: 'border-box', background: isDarkMode ? '#495057' : '#fff', color: isDarkMode ? '#fff' : '#333', resize: 'vertical' }} />
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {/* キャンセル：上・横全幅 */}
                      <button onClick={() => { setRejectModal(null); setRejectReason(''); setRejectNewType(''); }}
                        style={{ width: '100%', padding: '10px', background: '#6c757d', color: '#fff', border: 'none', borderRadius: 10, fontSize: 14, cursor: 'pointer' }}>
                        キャンセル
                      </button>
                      {/* 下：緑＋赤 横並び（種別変更ありの場合のみ） */}
                      <div style={{ display: 'flex', gap: 8 }}>
                        {rejectNewType && (
                          <button onClick={async () => {
                            const origType = rejectModal.leave_type === 'その他' ? (rejectModal.leave_type_other || 'その他') : rejectModal.leave_type;
                            const autoNote = `【管理者が種別変更】${origType} → ${rejectNewType}（変更して受理）`;
                            await supabase.from('leave_requests').update({ leave_type: rejectNewType, status: 'approved', reason: rejectReason ? `${rejectReason}　${autoNote}` : autoNote, modified_by: authUser?.id ?? null, modified_at: new Date().toISOString() }).eq('id', rejectModal.id);
                            if (await shouldSend('leave:rejected_type_changed', 'site')) {
                              const t = await getNotificationTemplate('leave:rejected_type_changed', 'site', { 元種別: origType, 新種別: rejectNewType });
                              await insertNotification(rejectModal.user_id, t?.template ?? `「${origType}」が「${rejectNewType}」に変更され、受理されました`, undefined, 'leave_request', rejectModal.id);
                            }
                            // 種別変更して受理 → カレンダーを新種別でupsert
                            try {
                              const dates: string[] = rejectModal.leave_dates ? JSON.parse(rejectModal.leave_dates) : [];
                              if (dates.length > 0) {
                                await supabase.functions.invoke('gcal-sync', {
                                  body: { action: 'upsert', source_type: 'leave', source_id: rejectModal.id, dates, name: rejectModal.profile?.name ?? '', leave_type: rejectNewType, locations: parseLeaveLocations(rejectModal.leave_locations) },
                                });
                              }
                            } catch (e) { console.error('[gcal-sync] upsert失敗:', e); }
                            setRejectModal(null); setRejectReason(''); setRejectNewType('');
                            fetchLeaveRequests();
                          }} style={{ flex: 1, padding: '14px 8px', background: '#28a745', color: '#fff', border: 'none', borderRadius: 10, fontSize: 13, fontWeight: 'bold', cursor: 'pointer', lineHeight: 1.4 }}>
                            差戻なし<br />「{rejectNewType}」に<br />変更して受理
                          </button>
                        )}
                        <button onClick={async () => {
                          const origType = rejectModal.leave_type === 'その他' ? (rejectModal.leave_type_other || 'その他') : rejectModal.leave_type;
                          const finalReason = rejectNewType
                            ? `種別を「${rejectNewType}」に変更しました。${rejectReason ? `　理由：${rejectReason}` : ''}`
                            : (rejectReason || null);
                          const update: Record<string, string | null> = { status: 'rejected', rejected_reason: finalReason };
                          if (rejectNewType) update.leave_type = rejectNewType;
                          await supabase.from('leave_requests').update(update).eq('id', rejectModal.id);
                          // 差戻し元のカレンダーイベントを削除
                          if (!(await deleteLeaveGcal(rejectModal.id))) {
                            setSuccessMsg('⚠ 差し戻しましたが、Googleカレンダーからの削除に失敗しました。カレンダーを確認してください。');
                          }
                          if (rejectNewType) {
                            // 種別変更あり → 新申請を受理済みで自動作成
                            const autoNote = `【管理者が種別変更】${origType} → ${rejectNewType}（元の申請から自動作成）`;
                            const { data: newReq } = await supabase.from('leave_requests').insert({
                              user_id: rejectModal.user_id,
                              leave_type: rejectNewType,
                              leave_dates: rejectModal.leave_dates,
                              leave_locations: rejectModal.leave_locations, // 校の引き継ぎ
                              start_date: rejectModal.start_date,
                              end_date: rejectModal.end_date,
                              reason: autoNote,
                              status: 'approved',
                              approver_id: rejectModal.approver_id,
                              approver2_id: rejectModal.approver2_id,
                            }).select('id').single();
                            // 新申請をカレンダーにupsert
                            if (newReq?.id) {
                              try {
                                const dates: string[] = rejectModal.leave_dates ? JSON.parse(rejectModal.leave_dates) : [];
                                if (dates.length > 0) {
                                  await supabase.functions.invoke('gcal-sync', {
                                    body: { action: 'upsert', source_type: 'leave', source_id: newReq.id, dates, name: rejectModal.profile?.name ?? '', leave_type: rejectNewType, locations: parseLeaveLocations(rejectModal.leave_locations) },
                                  });
                                }
                              } catch (e) { console.error('[gcal-sync] upsert失敗:', e); }
                            }
                            if (await shouldSend('leave:rejected_reapplied', 'site')) {
                              const t = await getNotificationTemplate('leave:rejected_reapplied', 'site', { 元種別: origType, 新種別: rejectNewType });
                              await insertNotification(rejectModal.user_id, t?.template ?? `${origType}が差し戻され、${rejectNewType}で再申請・受理済みです`, undefined, 'leave_request', newReq?.id);
                            }
                          } else {
                            if (await shouldSend('leave:rejected', 'site')) {
                              const t = await getNotificationTemplate('leave:rejected', 'site', { 申請者名: '', 休暇種別: rejectModal.leave_type, 差し戻し理由: rejectReason || '' });
                              // バナー2行目にはどの申請か分かるよう休暇日を表示（例：7/26 有給休暇（1日））。差し戻し理由はタップ先の申請履歴で確認できる
                              const dateSummary = formatLeaveDateSummary(rejectModal.leave_dates, rejectModal.start_date, rejectModal.end_date, origType);
                              await insertNotification(rejectModal.user_id, t?.template ?? `休暇申請が差し戻されました`, dateSummary, 'leave_request:pending_resubmit', rejectModal.id, 'leave:rejected');
                            }
                            if (await shouldSend('leave:rejected', 'slack')) {
                              const targetChannel = await getNotificationRecipient('leave:rejected', 'slack');
                              await sendLeaveSlack('rejected', '管理者', '管理者', undefined, undefined, targetChannel ?? 'leader');
                            }
                            const rejectedEmail = await getUserEmail(rejectModal.user_id) ?? '';
                            const rejVars = { 申請者名: '', 休暇種別: rejectModal.leave_type, 差し戻し理由: rejectReason || '', リンク: 'https://fivem-portal.vercel.app/leave?tab=history' };
                            // 宛先で役職を選んでいれば上長にも共有（受理ページ側と同じ配線にする）
                            const [rejSite, rejMail] = await Promise.all([
                              resolveRoleRecipients(rejectModal.user_id, 'leave:rejected', 'site'),
                              resolveRoleRecipients(rejectModal.user_id, 'leave:rejected', 'email'),
                            ]);
                            await dispatchSiteNotification('leave:rejected', rejVars, rejSite.ids, insertNotification, 'leave_request', rejectModal.id);
                            await dispatchEmail('leave:rejected', rejVars, { applicant: rejectedEmail, ...rejMail.emails });
                          }
                          setRejectModal(null); setRejectReason(''); setRejectNewType('');
                          fetchLeaveRequests();
                        }} style={{ flex: 1, padding: '14px 8px', background: '#dc3545', color: '#fff', border: 'none', borderRadius: 10, fontSize: 13, fontWeight: 'bold', cursor: 'pointer', lineHeight: 1.4 }}>
                          {rejectNewType
                            ? <>「{rejectModal.leave_type}」を差戻し<br />「{rejectNewType}」の<br />受理を追加</>
                            : '差し戻す'
                          }
                        </button>
                        <button onClick={() => {
                          setConfirmDialog({ message: `「${rejectModal.leave_type}」の受理を取り消しますか？\n申請者への通知を送り、カレンダーのイベントを削除します。\n（申請記録は残ります）`, onConfirm: async () => {
                          await supabase.from('leave_requests').update({
                            status: 'cancelled',
                            rejected_reason: rejectReason || '管理者が受理を取り消しました',
                            modified_by: authUser?.id ?? null,
                            modified_at: new Date().toISOString(),
                          }).eq('id', rejectModal.id);
                          // カレンダーから削除
                          if (!(await deleteLeaveGcal(rejectModal.id))) {
                            setSuccessMsg('⚠ 取り消しましたが、Googleカレンダーからの削除に失敗しました。カレンダーを確認してください。');
                          }
                          // 社長（宛先で「社長」を選んだ場合の届け先。複数人いても全員に届ける）
                          const cancelType = rejectModal.leave_type === 'その他' ? (rejectModal.leave_type_other || 'その他') : rejectModal.leave_type;
                          const cancelVars = { 申請者名: rejectModal.profile?.name ?? '', 休暇種別: cancelType, 取り消し理由: rejectReason || '' };
                          // 🚨 以前は社長だけを直接引いていたため、宛先でリーダー・マネージャーに
                          // チェックを入れても解決されず届いていなかった。
                          // 役職の宛先は所属チームで絞り込んで解決する（管理画面のグループ絞り込み設定に従う）
                          const [cancelSite, cancelMail] = await Promise.all([
                            resolveRoleRecipients(rejectModal.user_id, 'leave:cancelled', 'site'),
                            resolveRoleRecipients(rejectModal.user_id, 'leave:cancelled', 'email'),
                          ]);
                          // 申請者に通知（従来どおり直接送信）
                          if (await shouldSend('leave:cancelled', 'site')) {
                            await insertNotification(rejectModal.user_id, `休暇申請（${rejectModal.leave_type}）の受理が取り消されました${rejectReason ? `。理由：${rejectReason}` : ''}`, undefined, 'leave_request', rejectModal.id);
                          }
                          // 宛先で選ばれた役職（リーダー・マネージャー・社長）にもサイト通知＋メール（applicantは上で送信済み）
                          await dispatchSiteNotification('leave:cancelled', cancelVars, cancelSite.ids, insertNotification, 'leave_request', rejectModal.id);
                          await dispatchEmail('leave:cancelled', cancelVars, cancelMail.emails);
                          setRejectModal(null); setRejectReason(''); setRejectNewType('');
                          fetchLeaveRequests();
                          } });
                        }} style={{ flex: 1, padding: '14px 8px', background: '#fd7e14', color: '#fff', border: 'none', borderRadius: 10, fontSize: 13, fontWeight: 'bold', cursor: 'pointer', lineHeight: 1.4 }}>
                          取り消し
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* CSV出力モーダル */}
              {showLeaveCsvModal && (
                <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 16px' }}>
                  <div style={{ background: isDarkMode ? '#343a40' : '#fff', borderRadius: 14, padding: 24, width: '100%', maxWidth: 360 }}>
                    <div style={{ fontSize: 15, fontWeight: 'bold', color: isDarkMode ? '#fff' : '#333', marginBottom: 16 }}>📥 CSV出力 — 休暇申請</div>

                    <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
                      {(['fy', 'custom'] as const).map(m => (
                        <button key={m} onClick={() => setLeaveCsvMode(m)}
                          style={{ flex: 1, padding: '7px 0', borderRadius: 8, border: 'none', fontSize: 12, fontWeight: 'bold', cursor: 'pointer', background: leaveCsvMode === m ? '#007bff' : (isDarkMode ? '#495057' : '#e9ecef'), color: leaveCsvMode === m ? '#fff' : (isDarkMode ? '#fff' : '#333') }}>
                          {m === 'fy' ? '年度で選択' : 'カスタム期間'}
                        </button>
                      ))}
                    </div>

                    {leaveCsvMode === 'fy' ? (
                      <div>
                        <label style={{ fontSize: 12, color: isDarkMode ? '#adb5bd' : '#666', display: 'block', marginBottom: 6 }}>年度（4月〜翌3月）</label>
                        <select value={leaveCsvFy || String(nowFyStatic)} onChange={e => setLeaveCsvFy(e.target.value)}
                          style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: `1px solid ${isDarkMode ? '#6c757d' : '#ddd'}`, background: isDarkMode ? '#495057' : '#fff', color: isDarkMode ? '#fff' : '#333', fontSize: 13 }}>
                          {(fyList.length > 0 ? fyList : [nowFyStatic]).map(fy => (
                            <option key={fy} value={String(fy)}>{fy}年度（{fy}/4/1〜{fy+1}/3/31）</option>
                          ))}
                        </select>
                      </div>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                        <div>
                          <label style={{ fontSize: 12, color: isDarkMode ? '#adb5bd' : '#666', display: 'block', marginBottom: 4 }}>申請日（開始）</label>
                          <input type="date" value={leaveCsvFrom} onChange={e => setLeaveCsvFrom(e.target.value)}
                            style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: `1px solid ${isDarkMode ? '#6c757d' : '#ddd'}`, background: isDarkMode ? '#495057' : '#fff', color: isDarkMode ? '#fff' : '#333', fontSize: 13, boxSizing: 'border-box' }} />
                        </div>
                        <div>
                          <label style={{ fontSize: 12, color: isDarkMode ? '#adb5bd' : '#666', display: 'block', marginBottom: 4 }}>申請日（終了）</label>
                          <input type="date" value={leaveCsvTo} onChange={e => setLeaveCsvTo(e.target.value)}
                            style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: `1px solid ${isDarkMode ? '#6c757d' : '#ddd'}`, background: isDarkMode ? '#495057' : '#fff', color: isDarkMode ? '#fff' : '#333', fontSize: 13, boxSizing: 'border-box' }} />
                        </div>
                      </div>
                    )}

                    <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
                      <button onClick={() => setShowLeaveCsvModal(false)}
                        style={{ flex: 1, padding: 10, borderRadius: 8, border: `1px solid ${isDarkMode ? '#6c757d' : '#ddd'}`, background: 'none', color: isDarkMode ? '#adb5bd' : '#666', fontSize: 14, cursor: 'pointer' }}>
                        閉じる
                      </button>
                      <button onClick={exportLeavesCsv} disabled={leaveCsvExporting}
                        style={{ flex: 1, padding: 10, borderRadius: 8, border: 'none', background: leaveCsvExporting ? '#6c757d' : '#28a745', color: '#fff', fontSize: 14, fontWeight: 'bold', cursor: 'pointer' }}>
                        {leaveCsvExporting ? '出力中...' : 'ダウンロード'}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
};

export default LeaveRequestsTab;

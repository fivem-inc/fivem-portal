import React, { useState, useEffect, useCallback } from 'react';
import { useAdminPanel } from './AdminPanelContext';

type AppType = 'overtime' | 'holiday_work' | 'early_leave' | 'tardiness' | 'absence' | 'early_start' | 'location_change';

interface ShiftReport {
  id: string;
  applicant_id: string;
  submitted_by: string;
  work_date: string;
  pay_period_start: string;
  application_type: AppType;
  application_types: AppType[];
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
  applicantName?: string;
  reviewerName?: string;
  confirmerName?: string;
  submitterName?: string;
}

interface HistoryRec {
  id: string;
  changed_at: string;
  change_summary: string;
  changerName?: string;
}


const TYPE_INFO: Record<AppType, { label: string; color: string; emoji: string }> = {
  overtime:     { label: '残業',     color: '#1565c0', emoji: '⏰' },
  holiday_work: { label: '休日出勤', color: '#0f766e', emoji: '🏢' },
  early_leave:  { label: '早退',     color: '#e65100', emoji: '🏃' },
  tardiness:    { label: '遅刻',     color: '#7b1fa2', emoji: '⏱️' },
  absence:      { label: '欠勤',     color: '#c62828', emoji: '❌' },
  early_start:  { label: '早出',     color: '#0891b2', emoji: '🌅' },
  location_change: { label: '勤務地変更', color: '#6d28d9', emoji: '📍' },
};
function getTypes(r: ShiftReport): AppType[] {
  return r.application_types?.length ? r.application_types : [r.application_type];
}

const STATUS_INFO: Record<string, { label: string; color: string }> = {
  pending:     { label: '確認待ち',     color: '#856404' },
  resubmitted: { label: '確認待ち(再)', color: '#856404' },
  confirmed:   { label: '受理済み', color: '#065f46' },
  cancelled:   { label: '取消済み', color: '#6c757d' },
  returned:    { label: '差戻し',   color: '#9d174d' },
};
const STATUS_BG: Record<string, string> = {
  pending: '#e67e22', resubmitted: '#e67e22', confirmed: '#28a745',
  cancelled: '#6c757d', returned: '#dc3545',
};

const DOW = ['日', '月', '火', '水', '木', '金', '土'];
function dow(d: string) { return DOW[new Date(d + 'T00:00:00').getDay()]; }
function fmtMin(m: number) { const h = Math.floor(m / 60), min = m % 60; return min > 0 ? `${h}時間${min}分` : `${h}時間`; }
function payPeriodLabel(s: string) {
  const d = new Date(s + 'T00:00:00');
  const nm = d.getMonth() + 2; const y = nm > 12 ? d.getFullYear() + 1 : d.getFullYear();
  return `${y}年${((nm - 1) % 12) + 1}月給与分`;
}

type StatusFilter = 'active' | 'confirmed' | 'cancelled' | 'all';

const ShiftReportsTab: React.FC = () => {
  const { isDarkMode, supabase, setSuccessMsg } = useAdminPanel();

  const [reports, setReports]           = useState<ShiftReport[]>([]);
  const [loading, setLoading]           = useState(true);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [personFilter, setPersonFilter] = useState('all');
  const [groupFilter, setGroupFilter]   = useState('all');
  const [typeFilter, setTypeFilter]     = useState('all');
  const [periodFilter, setPeriodFilter] = useState('__current__');
  const [groupOptions, setGroupOptions] = useState<string[]>([]);
  const [groupMap, setGroupMap]         = useState<Record<string, string[]>>({});
  const [confirming, setConfirming]     = useState<string | null>(null);
  const [deleteError, setDeleteError]   = useState('');
  const [expandedHistory, setExpandedHistory] = useState<Set<string>>(new Set());
  const [historyData, setHistoryData]   = useState<Record<string, HistoryRec[]>>({});
  const [historyExistIds, setHistoryExistIds] = useState<Set<string>>(new Set());
  const [returnTarget, setReturnTarget] = useState<ShiftReport | null>(null);
  const [returnComment, setReturnComment] = useState('');
  const [returning, setReturning]       = useState(false);
  const [sortKey, setSortKey]           = useState<'created_at' | 'work_date' | 'applicantName'>('created_at');
  const [sortDir, setSortDir]           = useState<'asc' | 'desc'>('desc');

  const bg        = isDarkMode ? '#1e2328' : '#f8f9fa';
  const border    = isDarkMode ? '#495057' : '#dee2e6';
  const text      = isDarkMode ? '#ffffff' : '#333333';
  const sub       = isDarkMode ? '#adb5bd' : '#666666';
  const selBg     = isDarkMode ? '#495057' : '#fff';
  const rowEven   = isDarkMode ? '#343a40' : 'white';
  const rowOdd    = isDarkMode ? '#3d4349' : '#f8f9fa';

  const btnBase: React.CSSProperties = { padding: '4px 8px', borderRadius: 4, border: 'none', cursor: 'pointer', fontSize: 11, fontWeight: 'bold' };

  const currentPeriod = (() => {
    const t = new Date();
    if (t.getDate() >= 16) return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-16`;
    const p = new Date(t.getFullYear(), t.getMonth() - 1, 16);
    return `${p.getFullYear()}-${String(p.getMonth() + 1).padStart(2, '0')}-16`;
  })();


  const fetchReports = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase.from('shift_reports').select('*').order('work_date', { ascending: false });
    if (!data || data.length === 0) { setReports([]); setLoading(false); return; }
    const ids = [...new Set([
      ...data.map((r: ShiftReport) => r.applicant_id),
      ...data.map((r: ShiftReport) => r.submitted_by).filter(Boolean),
      ...data.map((r: ShiftReport) => r.reviewer_id).filter(Boolean),
      ...data.map((r: ShiftReport) => r.confirmed_by).filter(Boolean),
    ])] as string[];
    const { data: profs } = await supabase.from('profiles').select('id, name, group_names').in('id', ids);
    const nm = Object.fromEntries((profs || []).map((p: { id: string; name: string }) => [p.id, p.name]));
    const gm: Record<string, string[]> = {};
    (profs || []).forEach((p: { id: string; group_names?: string[] }) => { gm[p.id] = p.group_names ?? []; });
    setGroupMap(gm);
    setReports(data.map((r: ShiftReport) => ({
      ...r,
      applicantName:  nm[r.applicant_id] ?? '不明',
      reviewerName:   r.reviewer_id  ? (nm[r.reviewer_id]  ?? '—') : '—',
      confirmerName:  r.confirmed_by ? (nm[r.confirmed_by] ?? '—') : '—',
      submitterName:  r.submitted_by && r.submitted_by !== r.applicant_id ? (nm[r.submitted_by] ?? '不明') : undefined,
    })));
    // 修正履歴ボタンの色分け用：履歴が実際に存在するreport_idだけをまとめて取得
    const reportIds = data.map((r: ShiftReport) => r.id);
    const { data: histRows } = await supabase.from('shift_report_history').select('report_id').in('report_id', reportIds);
    setHistoryExistIds(new Set((histRows || []).map((h: { report_id: string }) => h.report_id)));
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    fetchReports();
    supabase.from('master_options').select('value').eq('category', 'shift_report_group').order('sort_order')
      .then(({ data }) => { if (data) setGroupOptions(data.map((r: { value: string }) => r.value)); });
  }, [fetchReports]);

  const loadHistory = useCallback(async (reportId: string) => {
    if (historyData[reportId]) return;
    const { data } = await supabase.from('shift_report_history').select('id, changed_at, change_summary, changed_by').eq('report_id', reportId).order('changed_at', { ascending: false });
    if (!data || data.length === 0) { setHistoryData(prev => ({ ...prev, [reportId]: [] })); return; }
    const ids = [...new Set(data.map((h: { changed_by: string }) => h.changed_by))];
    const { data: profs } = await supabase.from('profiles').select('id, name').in('id', ids);
    const nm = Object.fromEntries((profs || []).map((p: { id: string; name: string }) => [p.id, p.name]));
    setHistoryData(prev => ({
      ...prev,
      [reportId]: data.map((h: { id: string; changed_at: string; change_summary: string; changed_by: string }) => ({
        id: h.id, changed_at: h.changed_at, change_summary: h.change_summary,
        changerName: nm[h.changed_by] ?? '不明',
      })),
    }));
  }, [supabase, historyData]);

  const toggleHistory = (reportId: string) => {
    const next = new Set(expandedHistory);
    if (next.has(reportId)) { next.delete(reportId); }
    else { next.add(reportId); loadHistory(reportId); }
    setExpandedHistory(next);
  };

  const handleConfirm = async (r: ShiftReport) => {
    if (!window.confirm(`「${r.applicantName}」の報告を受理しますか？`)) return;
    setConfirming(r.id);
    const { data: { user } } = await supabase.auth.getUser();
    await supabase.from('shift_reports').update({ status: 'confirmed', confirmed_by: user?.id, confirmed_at: new Date().toISOString() }).eq('id', r.id);
    await supabase.from('shift_report_history').insert({ report_id: r.id, changed_by: user?.id, change_summary: '管理者が受理しました', snapshot: r }).then(null, () => {});
    await supabase.from('notifications').insert({
      user_id: r.applicant_id, message: '勤務変更報告が受理されました',
      sub_message: `${getTypes(r).map(t => TYPE_INFO[t]?.label ?? t).join('＋')}　${r.work_date}`,
      source_type: 'shift_report', reference_id: r.id, read: false,
    }).then(null, () => {});
    // 通知：同グループの該当役職者へ一斉通知（管理画面「勤務変更申請」設定に従う）
    supabase.functions.invoke('shift-report-confirmed-notify', {
      body: {
        user_id: r.applicant_id,
        user_name: r.applicantName ?? '',
        date: r.work_date,
        types: getTypes(r),
        location: r.actual_location ?? r.original_location ?? '',
      },
    }).then(null, () => {});
    setConfirming(null);
    setSuccessMsg('受理しました');
    fetchReports();
  };

  const handleReturn = async () => {
    if (!returnTarget) return;
    const r = returnTarget;
    setReturning(true);
    const { data: { user } } = await supabase.auth.getUser();
    await supabase.from('shift_reports').update({ status: 'returned' }).eq('id', r.id);
    const comment = returnComment.trim();
    await supabase.from('shift_report_history').insert({
      report_id: r.id, changed_by: user?.id,
      change_summary: comment ? `差戻し：${comment}` : '差戻しました', snapshot: r,
    }).then(null, () => {});
    await supabase.from('notifications').insert({
      user_id: r.applicant_id, message: '勤務変更報告が差戻されました',
      sub_message: `${getTypes(r).map(t => TYPE_INFO[t]?.label ?? t).join('＋')}　${r.work_date}${comment ? `\n理由：${comment}` : ''}`,
      source_type: 'shift_report:pending_resubmit', reference_id: r.id, event_key: 'shift_report:returned', read: false,
    }).then(null, () => {});
    setReturning(false); setReturnTarget(null); setReturnComment('');
    setSuccessMsg('差戻しました');
    fetchReports();
  };

  const handleDelete = async (r: ShiftReport) => {
    if (!window.confirm(`「${r.applicantName}」の報告を完全削除しますか？`)) return;
    setDeleteError('');
    // 履歴は shift_reports の削除で on delete cascade により自動削除される
    const { data: deleted, error } = await supabase.from('shift_reports').delete().eq('id', r.id).select('id');
    if (error) { setDeleteError(`削除に失敗しました：${error.message}`); return; }
    if (!deleted || deleted.length === 0) {
      setDeleteError('削除できませんでした（権限が不足しているか、すでに削除済みです）');
      return;
    }
    setSuccessMsg('削除しました');
    fetchReports();
  };

  // フィルタ
  const periods = [...new Set(reports.map(r => r.pay_period_start))].sort((a, b) => b.localeCompare(a));
  const activeCount = reports.filter(r => ['pending', 'resubmitted'].includes(r.status)).length;

  const filtered = reports.filter(r => {
    if (statusFilter === 'active'    && !['pending', 'resubmitted'].includes(r.status)) return false;
    if (statusFilter === 'confirmed' && r.status !== 'confirmed') return false;
    if (statusFilter === 'cancelled' && r.status !== 'cancelled') return false;
    if (personFilter !== 'all'       && r.applicant_id !== personFilter) return false;
    if (typeFilter !== 'all'         && r.application_type !== typeFilter) return false;
    if (groupFilter !== 'all') {
      const userGroups = groupMap[r.applicant_id] ?? [];
      if (!userGroups.includes(groupFilter)) return false;
    }
    if (statusFilter !== 'active') {
      const p = periodFilter === '__current__' ? currentPeriod : (periodFilter === 'all' ? null : periodFilter);
      if (p !== null && r.pay_period_start !== p) return false;
    }
    return true;
  });

  const sorted = [...filtered].sort((a, b) => {
    let va = '', vb = '';
    if (sortKey === 'created_at') { va = a.created_at; vb = b.created_at; }
    else if (sortKey === 'work_date') { va = a.work_date; vb = b.work_date; }
    else { va = a.applicantName ?? ''; vb = b.applicantName ?? ''; }
    return sortDir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
  });

  const personOptions = [...new Map(reports.map(r => [r.applicant_id, r.applicantName ?? r.applicant_id])).entries()].sort((a, b) => a[1].localeCompare(b[1]));

  // CSV export
  const [showCsvModal, setShowCsvModal]   = useState(false);
  const [csvMode, setCsvMode]             = useState<'payperiod' | 'custom'>('payperiod');
  const [csvPayPeriod, setCsvPayPeriod]   = useState(currentPeriod);
  const [csvFrom, setCsvFrom]             = useState('');
  const [csvTo, setCsvTo]                 = useState('');
  const [csvExporting, setCsvExporting]   = useState(false);

  const exportCsv = async () => {
    setCsvExporting(true);
    let query = supabase.from('shift_reports').select('*');
    if (csvMode === 'payperiod') {
      query = query.eq('pay_period_start', csvPayPeriod);
    } else {
      if (csvFrom) query = query.gte('work_date', csvFrom);
      if (csvTo)   query = query.lte('work_date', csvTo);
    }
    const { data } = await query.order('work_date', { ascending: true });
    if (!data || data.length === 0) { setCsvExporting(false); alert('データがありません'); return; }

    const ids = [...new Set([
      ...data.map((r: ShiftReport) => r.applicant_id),
      ...data.map((r: ShiftReport) => r.submitted_by).filter(Boolean),
      ...data.map((r: ShiftReport) => r.reviewer_id).filter(Boolean),
    ])] as string[];
    const { data: profs } = await supabase.from('profiles').select('id, name').in('id', ids);
    const nm: Record<string, string> = Object.fromEntries((profs || []).map((p: { id: string; name: string }) => [p.id, p.name]));

    const esc = (v: string | number | null | undefined) => {
      const s = v == null ? '' : String(v);
      return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const headers = ['報告日', '報告者', '代行者', '種別', '勤務日', '変更前勤務地', '変更前開始', '変更前終了', '変更前外出', '変更前戻り', '変更後勤務地', '変更後開始', '変更後終了', '変更後外出', '変更後戻り', '労働時間(分)', '休憩時間(分)', '理由', '確認者', 'ステータス'];
    const rows = (data as ShiftReport[]).map(r => [
      r.created_at.slice(0, 10),
      nm[r.applicant_id] ?? '不明',
      r.submitted_by && r.submitted_by !== r.applicant_id ? (nm[r.submitted_by] ?? '') : '',
      getTypes(r).map(t => TYPE_INFO[t]?.label ?? t).join('＋'),
      r.work_date,
      r.original_location ?? '',
      r.original_start ?? '',
      r.original_end ?? '',
      r.original_outing_start ?? '',
      r.original_outing_end ?? '',
      r.actual_location ?? '',
      r.actual_start ?? '',
      r.actual_end ?? '',
      r.actual_outing_start ?? '',
      r.actual_outing_end ?? '',
      r.labor_minutes ?? '',
      r.break_minutes ?? '',
      r.reason,
      r.reviewer_id ? (nm[r.reviewer_id] ?? '') : '',
      STATUS_INFO[r.status]?.label ?? r.status,
    ].map(esc).join(','));

    const csv = '﻿' + [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const label = csvMode === 'payperiod' ? payPeriodLabel(csvPayPeriod) : `${csvFrom}〜${csvTo}`;
    a.href = url; a.download = `勤務変更報告_${label}.csv`; a.click();
    URL.revokeObjectURL(url);
    setCsvExporting(false); setShowCsvModal(false);
  };

  const fmtDateTime = (iso: string) => {
    const d = new Date(iso);
    const y = d.toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' });
    const t = d.toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' });
    return { date: y, time: t };
  };

  return (
    <div style={{ background: bg, minHeight: '60vh', padding: '0 0 40px' }}>
      <h3 style={{ textAlign: 'center', marginBottom: 6, color: text }}>⏰ 勤務変更報告一覧</h3>
      <p style={{ textAlign: 'center', fontSize: 13, color: sub, marginBottom: 8 }}>パートスタッフの残業・早退・遅刻・欠勤の報告を管理します。</p>
      {deleteError && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, maxWidth: 560, margin: '0 auto 10px', padding: '10px 14px', background: isDarkMode ? '#4a1515' : '#fdecea', border: `1px solid ${isDarkMode ? '#7f1d1d' : '#f5c6cb'}`, borderRadius: 8 }}>
          <span style={{ fontSize: 13, color: isDarkMode ? '#fca5a5' : '#b71c1c', fontWeight: 'bold', flex: 1 }}>⚠️ {deleteError}</span>
          <button onClick={() => setDeleteError('')} style={{ background: 'none', border: 'none', color: isDarkMode ? '#fca5a5' : '#b71c1c', fontSize: 16, cursor: 'pointer', lineHeight: 1 }}>✕</button>
        </div>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', paddingRight: 16, marginBottom: 8 }}>
        <button onClick={() => setShowCsvModal(true)}
          style={{ ...btnBase, padding: '5px 12px', fontSize: 12, background: '#28a745', color: '#fff', border: 'none' }}>
          📥 CSV出力
        </button>
      </div>

      {/* フィルタ行1：ステータス */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center', marginBottom: 8 }}>
        {([
          ['all',       'すべて'],
          ['active',    `確認待ち${activeCount > 0 ? ` (${activeCount})` : ''}`],
          ['confirmed', '受理済み'],
          ['cancelled', '取消済み'],
        ] as [StatusFilter, string][]).map(([key, label]) => (
          <button key={key} onClick={() => setStatusFilter(key)}
            style={{ ...btnBase, padding: '5px 14px', fontSize: 12, background: statusFilter === key ? '#007bff' : (isDarkMode ? '#495057' : '#e9ecef'), color: statusFilter === key ? '#fff' : text }}>
            {label}
          </button>
        ))}
        <button onClick={fetchReports} style={{ ...btnBase, padding: '5px 14px', fontSize: 12, background: isDarkMode ? '#495057' : '#e9ecef', color: text }}>更新</button>
      </div>

      {/* フィルタ行2 */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center', marginBottom: 16, alignItems: 'center' }}>
        {statusFilter !== 'active' && (
          <select value={periodFilter} onChange={e => setPeriodFilter(e.target.value)}
            style={{ padding: '4px 8px', borderRadius: 8, border: `1px solid ${border}`, background: selBg, color: text, fontSize: 12 }}>
            <option value="__current__">{payPeriodLabel(currentPeriod)}</option>
            {periods.filter(p => p !== currentPeriod).map(p => <option key={p} value={p}>{payPeriodLabel(p)}</option>)}
            <option value="all">全期間</option>
          </select>
        )}
        <select value={groupFilter} onChange={e => setGroupFilter(e.target.value)}
          style={{ padding: '4px 8px', borderRadius: 8, border: `1px solid ${border}`, background: selBg, color: text, fontSize: 12 }}>
          <option value="all">全グループ</option>
          {groupOptions.map(g => <option key={g} value={g}>{g}</option>)}
        </select>
        <select value={personFilter} onChange={e => setPersonFilter(e.target.value)}
          style={{ padding: '4px 8px', borderRadius: 8, border: `1px solid ${border}`, background: selBg, color: text, fontSize: 12 }}>
          <option value="all">全員</option>
          {personOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
        <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)}
          style={{ padding: '4px 8px', borderRadius: 8, border: `1px solid ${border}`, background: selBg, color: text, fontSize: 12 }}>
          <option value="all">全種別</option>
          {Object.entries(TYPE_INFO).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
      </div>

      {/* ソート行 */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center', marginBottom: 12, alignItems: 'center' }}>
        <span style={{ fontSize: 12, color: sub }}>並び順：</span>
        <select value={sortKey} onChange={e => setSortKey(e.target.value as typeof sortKey)}
          style={{ padding: '4px 8px', borderRadius: 8, border: `1px solid ${border}`, background: selBg, color: text, fontSize: 12 }}>
          <option value="created_at">報告日</option>
          <option value="work_date">勤務日</option>
          <option value="applicantName">報告者</option>
        </select>
        <button onClick={() => setSortDir(d => d === 'asc' ? 'desc' : 'asc')}
          style={{ ...btnBase, padding: '4px 10px', fontSize: 12, background: isDarkMode ? '#495057' : '#e9ecef', color: text }}>
          {sortDir === 'desc' ? '▼ 新しい順' : '▲ 古い順'}
        </button>
        <button onClick={() => { setSortKey('created_at'); setSortDir('desc'); setStatusFilter('all'); setPersonFilter('all'); setGroupFilter('all'); setTypeFilter('all'); setPeriodFilter('__current__'); }}
          style={{ ...btnBase, padding: '4px 10px', fontSize: 12, background: isDarkMode ? '#6c757d' : '#dee2e6', color: sub }}>
          クリア
        </button>
      </div>

      {/* テーブル */}
      {loading ? (
        <p style={{ textAlign: 'center', color: sub }}>読み込み中...</p>
      ) : filtered.length === 0 ? (
        <p style={{ textAlign: 'center', color: sub, marginTop: 40 }}>該当する報告はありません</p>
      ) : (
        <div style={{ overflowX: 'auto', padding: '0 8px' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', color: text, fontSize: 13 }}>
            <thead>
              <tr style={{ background: isDarkMode ? '#495057' : '#f8f9fa' }}>
                {[
                  { label: '報告日',   w: 70 },
                  { label: '報告者',   w: 70 },
                  { label: '種別',     w: 70 },
                  { label: '変更前',   w: 100 },
                  { label: '変更後',   w: 100 },
                  { label: '理由・備考', w: 120 },
                  { label: '確認状況', w: 90 },
                  { label: '操作',     w: 110 },
                ].map(col => (
                  <th key={col.label} style={{ padding: '8px 4px', textAlign: 'center', borderBottom: `1px solid ${border}`, color: text, width: col.w, fontSize: 12 }}>{col.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map((r, i) => {
                const rTypes  = getTypes(r);
                const stBg    = STATUS_BG[r.status] ?? '#6c757d';
                const isPend  = ['pending', 'resubmitted'].includes(r.status);
                const isReSub = r.status === 'resubmitted';
                const isRet   = r.status === 'returned';
                const hasHist = expandedHistory.has(r.id);
                const { date: cDate, time: cTime } = fmtDateTime(r.created_at);
                const rowBg   = isPend ? (isDarkMode ? '#3a2c00' : '#fffbeb') : (i % 2 === 0 ? rowEven : rowOdd);

                return (
                  <React.Fragment key={r.id}>
                    <tr style={{ background: rowBg, borderLeft: isPend ? '3px solid #ffc107' : undefined }}>
                      {/* 申請日 */}
                      <td style={{ padding: '8px 4px', borderBottom: `1px solid ${border}`, textAlign: 'center', fontSize: 12 }}>
                        <div>{cDate}</div><div style={{ color: sub }}>{cTime}</div>
                      </td>
                      {/* 申請者 */}
                      <td style={{ padding: '8px 4px', borderBottom: `1px solid ${border}`, textAlign: 'center', fontSize: 12 }}>
                        <div>{r.applicantName ?? '不明'}</div>
                        {r.submitterName && (
                          <div style={{ marginTop: 2 }}>
                            <span style={{ fontSize: 9, background: '#6f42c1', color: '#fff', borderRadius: 3, padding: '1px 4px' }}>
                              代行：{r.submitterName}
                            </span>
                          </div>
                        )}
                      </td>
                      {/* 種別 */}
                      <td style={{ padding: '8px 4px', borderBottom: `1px solid ${border}`, textAlign: 'center' }}>
                        {rTypes.map(t => {
                          const inf = TYPE_INFO[t] ?? { label: t, color: '#888', emoji: '📋' };
                          return <div key={t} style={{ fontSize: 11, fontWeight: 'bold', color: inf.color, lineHeight: 1.4 }}>{inf.emoji} {inf.label}</div>;
                        })}
                      </td>
                      {/* 変更前 */}
                      <td style={{ padding: '8px 4px', borderBottom: `1px solid ${border}`, textAlign: 'center', fontSize: 12 }}>
                        <div>{r.work_date.slice(5).replace('-', '/')}（{dow(r.work_date)}）</div>
                        {r.original_location && (
                          <div style={{ fontSize: 11, color: sub }}>{r.original_location}</div>
                        )}
                        {r.original_start && (
                          <div style={{ fontSize: 11, color: sub }}>{r.original_start.slice(0, 5)}〜{r.original_end?.slice(0, 5)}</div>
                        )}
                        {r.original_outing_start && (
                          <div style={{ fontSize: 11, color: sub }}>外出 {r.original_outing_start.slice(0, 5)}〜{r.original_outing_end?.slice(0, 5)}</div>
                        )}
                        {!r.original_location && !r.original_start && (
                          <div style={{ fontSize: 11, color: sub }}>—</div>
                        )}
                      </td>
                      {/* 変更後 */}
                      <td style={{ padding: '8px 4px', borderBottom: `1px solid ${border}`, textAlign: 'center', fontSize: 12 }}>
                        {r.actual_location && (
                          <div style={{ fontSize: 11, color: '#166534', fontWeight: 'bold' }}>{r.actual_location}</div>
                        )}
                        {r.actual_start && (
                          <div style={{ fontSize: 11, color: '#166534', fontWeight: 'bold' }}>{r.actual_start.slice(0, 5)}〜{r.actual_end?.slice(0, 5)}</div>
                        )}
                        {r.actual_outing_start && (
                          <div style={{ fontSize: 11, color: '#166534' }}>外出 {r.actual_outing_start.slice(0, 5)}〜{r.actual_outing_end?.slice(0, 5)}</div>
                        )}
                        {r.actual_start && (
                          <div style={{ fontSize: 11, color: '#166534' }}>休憩 {r.break_minutes ?? 0}分</div>
                        )}
                        {r.labor_minutes != null && r.labor_minutes > 0 && (
                          <div style={{ fontSize: 11, color: '#166534' }}>実労働 {fmtMin(r.labor_minutes)}</div>
                        )}
                        {!r.actual_location && !r.actual_start && (
                          <div style={{ fontSize: 11, color: sub }}>—</div>
                        )}
                      </td>
                      {/* 理由・バッジ */}
                      <td style={{ padding: '8px 4px', borderBottom: `1px solid ${border}`, textAlign: 'left', fontSize: 12, wordBreak: 'break-word' }}>
                        <div style={{ color: sub }}>{r.reason}</div>
                        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: isReSub || isRet ? 3 : 0 }}>
                          {isReSub && (
                            <button onClick={() => toggleHistory(r.id)}
                              style={{ ...btnBase, background: '#007bff', color: '#fff', borderRadius: 4, padding: '2px 6px', fontSize: 10 }}>
                              {hasHist ? '▼ 再報告' : '▶ 再報告'}
                            </button>
                          )}
                          {isRet && (
                            <button onClick={() => toggleHistory(r.id)}
                              style={{ ...btnBase, background: '#dc3545', color: '#fff', borderRadius: 4, padding: '2px 6px', fontSize: 10 }}>
                              {hasHist ? '▼ 差戻し' : '▶ 差戻し'}
                            </button>
                          )}
                          {!isReSub && !isRet && r.status !== 'pending' && historyExistIds.has(r.id) && (
                            <button onClick={() => toggleHistory(r.id)}
                              style={{ ...btnBase, background: '#007bff', color: '#fff', borderRadius: 4, padding: '2px 6px', fontSize: 10 }}>
                              {hasHist ? '▼ 修正履歴' : '▶ 修正履歴'}
                            </button>
                          )}
                        </div>
                      </td>
                      {/* 確認状況 */}
                      <td style={{ padding: '8px 4px', borderBottom: `1px solid ${border}`, textAlign: 'center' }}>
                        <div style={{ display: 'inline-block', padding: '3px 8px', borderRadius: 8, background: stBg, color: 'white', lineHeight: 1.4 }}>
                          <div style={{ fontSize: 9, opacity: 0.9 }}>{r.reviewerName}</div>
                          <div style={{ fontWeight: 'bold', fontSize: 11, whiteSpace: 'nowrap' }}>{STATUS_INFO[r.status]?.label ?? r.status}</div>
                        </div>
                      </td>
                      {/* 操作 */}
                      <td style={{ padding: '8px 4px', borderBottom: `1px solid ${border}`, textAlign: 'center' }}>
                        <div style={{ display: 'flex', gap: 4, justifyContent: 'center', flexWrap: 'wrap' }}>
                          {isPend && (
                            <button disabled={confirming === r.id} onClick={() => handleConfirm(r)}
                              style={{ ...btnBase, background: confirming === r.id ? '#6c757d' : '#28a745', color: '#fff', border: '2px solid ' + (confirming === r.id ? '#545b62' : '#1e7e34') }}>
                              {confirming === r.id ? '...' : '受理'}
                            </button>
                          )}
                          {!['cancelled', 'returned'].includes(r.status) && (
                            <button onClick={() => { setReturnTarget(r); setReturnComment(''); }}
                              style={{ ...btnBase, background: '#dc3545', color: '#fff', border: '2px solid #bd2130' }}>
                              差戻
                            </button>
                          )}
                          <button onClick={() => handleDelete(r)}
                            style={{ ...btnBase, background: isDarkMode ? '#495057' : '#e9ecef', color: sub, border: `1px solid ${border}` }}>
                            削除
                          </button>
                        </div>
                      </td>
                    </tr>
                    {/* 展開：修正履歴 */}
                    {hasHist && (
                      <tr>
                        <td colSpan={8} style={{ padding: '0 8px 8px 40px', background: isDarkMode ? '#1a2030' : '#f0f4ff', borderBottom: `1px solid ${border}` }}>
                          {!historyData[r.id] ? (
                            <p style={{ fontSize: 12, color: sub, margin: '8px 0' }}>読み込み中...</p>
                          ) : historyData[r.id].length === 0 ? (
                            <p style={{ fontSize: 12, color: sub, margin: '8px 0' }}>履歴なし</p>
                          ) : (
                            <div style={{ paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
                              {historyData[r.id].map(h => {
                                const { date: hd, time: ht } = fmtDateTime(h.changed_at);
                                return (
                                  <div key={h.id} style={{ display: 'flex', gap: 10, fontSize: 12 }}>
                                    <span style={{ color: sub, whiteSpace: 'nowrap' }}>{hd} {ht}</span>
                                    <span style={{ fontWeight: 'bold', color: text }}>{h.changerName}</span>
                                    <span style={{ color: text }}>{h.change_summary}</span>
                                  </div>
                                );
                              })}
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

      {/* CSV出力モーダル */}
      {showCsvModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 16px' }}>
          <div style={{ background: isDarkMode ? '#343a40' : '#fff', borderRadius: 14, padding: 24, width: '100%', maxWidth: 360 }}>
            <div style={{ fontSize: 15, fontWeight: 'bold', color: text, marginBottom: 16 }}>📥 CSV出力 — 勤務変更報告</div>

            {/* モード切替 */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
              {(['payperiod', 'custom'] as const).map(m => (
                <button key={m} onClick={() => setCsvMode(m)}
                  style={{ ...btnBase, flex: 1, padding: '7px 0', fontSize: 12, background: csvMode === m ? '#007bff' : (isDarkMode ? '#495057' : '#e9ecef'), color: csvMode === m ? '#fff' : text }}>
                  {m === 'payperiod' ? '給与期間で選択' : 'カスタム期間'}
                </button>
              ))}
            </div>

            {csvMode === 'payperiod' ? (
              <div>
                <label style={{ fontSize: 12, color: sub, display: 'block', marginBottom: 6 }}>給与期間</label>
                <select value={csvPayPeriod} onChange={e => setCsvPayPeriod(e.target.value)}
                  style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: `1px solid ${isDarkMode ? '#6c757d' : '#ddd'}`, background: isDarkMode ? '#495057' : '#fff', color: text, fontSize: 13 }}>
                  {periods.map(p => <option key={p} value={p}>{payPeriodLabel(p)}</option>)}
                </select>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div>
                  <label style={{ fontSize: 12, color: sub, display: 'block', marginBottom: 4 }}>勤務日（開始）</label>
                  <input type="date" value={csvFrom} onChange={e => setCsvFrom(e.target.value)}
                    style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: `1px solid ${isDarkMode ? '#6c757d' : '#ddd'}`, background: isDarkMode ? '#495057' : '#fff', color: text, fontSize: 13, boxSizing: 'border-box' }} />
                </div>
                <div>
                  <label style={{ fontSize: 12, color: sub, display: 'block', marginBottom: 4 }}>勤務日（終了）</label>
                  <input type="date" value={csvTo} onChange={e => setCsvTo(e.target.value)}
                    style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: `1px solid ${isDarkMode ? '#6c757d' : '#ddd'}`, background: isDarkMode ? '#495057' : '#fff', color: text, fontSize: 13, boxSizing: 'border-box' }} />
                </div>
              </div>
            )}

            <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
              <button onClick={() => setShowCsvModal(false)}
                style={{ flex: 1, padding: 10, borderRadius: 8, border: `1px solid ${isDarkMode ? '#6c757d' : '#ddd'}`, background: 'none', color: sub, fontSize: 14, cursor: 'pointer' }}>
                閉じる
              </button>
              <button onClick={exportCsv} disabled={csvExporting}
                style={{ flex: 1, padding: 10, borderRadius: 8, border: 'none', background: csvExporting ? '#6c757d' : '#28a745', color: '#fff', fontSize: 14, fontWeight: 'bold', cursor: 'pointer' }}>
                {csvExporting ? '出力中...' : 'ダウンロード'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 差戻しモーダル */}
      {returnTarget && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 16px' }}>
          <div style={{ background: isDarkMode ? '#343a40' : '#fff', borderRadius: 14, padding: 24, width: '100%', maxWidth: 340 }}>
            <div style={{ fontSize: 15, fontWeight: 'bold', color: text, marginBottom: 6 }}>差戻し</div>
            <div style={{ fontSize: 13, color: sub, marginBottom: 16 }}>
              {TYPE_INFO[returnTarget.application_type]?.emoji} {TYPE_INFO[returnTarget.application_type]?.label}　{returnTarget.work_date}
              <br /><span style={{ fontSize: 12 }}>（{returnTarget.applicantName}）</span>
            </div>
            <label style={{ fontSize: 12, color: sub, display: 'block', marginBottom: 6 }}>差戻し理由（任意・本人に通知）</label>
            <textarea value={returnComment} onChange={e => setReturnComment(e.target.value)} rows={3}
              placeholder="例：時間の記録を確認してください"
              style={{ width: '100%', padding: '9px 12px', borderRadius: 8, border: `1px solid ${isDarkMode ? '#6c757d' : '#ddd'}`, fontSize: 14, boxSizing: 'border-box', background: isDarkMode ? '#495057' : '#fff', color: text, resize: 'none' }} />
            <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
              <button onClick={() => { setReturnTarget(null); setReturnComment(''); }}
                style={{ flex: 1, padding: 10, borderRadius: 8, border: `1px solid ${isDarkMode ? '#6c757d' : '#ddd'}`, background: 'none', color: sub, fontSize: 14, cursor: 'pointer' }}>
                閉じる
              </button>
              <button onClick={handleReturn} disabled={returning}
                style={{ flex: 1, padding: 10, borderRadius: 8, border: 'none', background: returning ? '#6c757d' : '#dc3545', color: '#fff', fontSize: 14, fontWeight: 'bold', cursor: 'pointer' }}>
                {returning ? '処理中...' : '差戻す'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ShiftReportsTab;

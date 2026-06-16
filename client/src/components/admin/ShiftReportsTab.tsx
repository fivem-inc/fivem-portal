import React, { useState, useEffect, useCallback } from 'react';
import { useAdminPanel } from './AdminPanelContext';

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
  is_holiday: boolean | null;
  applicant?: { name: string | null } | null;
  reviewer?: { name: string | null } | null;
  confirmer?: { name: string | null } | null;
}

const TYPE_INFO: Record<string, { label: string; color: string; emoji: string }> = {
  overtime:    { label: '残業',   color: '#1565c0', emoji: '⏰' },
  early_leave: { label: '早退',   color: '#e65100', emoji: '🏃' },
  tardiness:   { label: '遅刻',   color: '#7b1fa2', emoji: '⏱️' },
  absence:     { label: '欠勤',   color: '#c62828', emoji: '❌' },
};

const STATUS_INFO: Record<string, { label: string; color: string; bg: string }> = {
  pending:     { label: '申請中',   color: '#856404', bg: '#fff3cd' },
  resubmitted: { label: '再申請中', color: '#856404', bg: '#fff3cd' },
  confirmed:   { label: '受理済み', color: '#065f46', bg: '#d1fae5' },
};

const DOW = ['日', '月', '火', '水', '木', '金', '土'];

function dow(dateStr: string): string {
  return DOW[new Date(dateStr + 'T00:00:00').getDay()];
}

function payPeriodLabel(startStr: string): string {
  const d = new Date(startStr + 'T00:00:00');
  const nm = d.getMonth() + 2;
  const y = nm > 12 ? d.getFullYear() + 1 : d.getFullYear();
  const m = ((nm - 1) % 12) + 1;
  return `${y}年${m}月給与分`;
}

const ShiftReportsTab: React.FC = () => {
  const { isDarkMode, supabase, setSuccessMsg } = useAdminPanel();

  const [reports, setReports] = useState<ShiftReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<'active' | 'confirmed' | 'all'>('active');
  const [periodFilter, setPeriodFilter] = useState<string>('__current__');
  const [personFilter, setPersonFilter] = useState<string>('all');
  const [confirming, setConfirming] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const bg         = isDarkMode ? '#1e2328' : '#f8f9fa';
  const cardBg     = isDarkMode ? '#2d3136' : '#ffffff';
  const border     = isDarkMode ? '#495057' : '#dee2e6';
  const textColor  = isDarkMode ? '#ffffff' : '#333333';
  const subText    = isDarkMode ? '#adb5bd' : '#666666';

  const fetchReports = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from('shift_reports')
      .select(`
        *,
        applicant:profiles!shift_reports_applicant_id_fkey(name),
        reviewer:profiles!shift_reports_reviewer_id_fkey(name),
        confirmer:profiles!shift_reports_confirmed_by_fkey(name)
      `)
      .order('work_date', { ascending: false });
    setReports((data as ShiftReport[]) || []);
    setLoading(false);
  }, [supabase]);

  useEffect(() => { fetchReports(); }, [fetchReports]);

  const handleConfirm = async (report: ShiftReport) => {
    if (!window.confirm(`「${report.applicant?.name ?? '不明'}」の${TYPE_INFO[report.application_type].label}申請を受理しますか？`)) return;
    setConfirming(report.id);
    const { data: { user } } = await supabase.auth.getUser();
    await supabase.from('shift_reports').update({
      status: 'confirmed',
      confirmed_by: user?.id,
      confirmed_at: new Date().toISOString(),
    }).eq('id', report.id);
    await supabase.from('shift_report_history').insert({
      report_id: report.id,
      changed_by: user?.id,
      change_summary: '管理者が受理しました',
      snapshot: report,
    });
    await supabase.from('notifications').insert({
      user_id: report.applicant_id,
      message: `✅ 勤務変更申請（${report.work_date} ${TYPE_INFO[report.application_type].label}）が受理されました`,
    });
    setConfirming(null);
    setSuccessMsg('受理しました');
    fetchReports();
  };

  // 給与期間の選択肢を生成
  const periods = [...new Set(reports.map(r => r.pay_period_start))].sort((a, b) => b.localeCompare(a));
  const currentPeriod = (() => {
    const today = new Date();
    const d = today.getDate() >= 16
      ? `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-16`
      : (() => {
          const prev = new Date(today.getFullYear(), today.getMonth() - 1, 16);
          return `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}-16`;
        })();
    return d;
  })();

  const filtered = reports.filter(r => {
    if (statusFilter === 'active' && r.status === 'confirmed') return false;
    if (statusFilter === 'confirmed' && r.status !== 'confirmed') return false;
    if (personFilter !== 'all' && r.applicant_id !== personFilter) return false;
    if (statusFilter !== 'active') {
      const activePeriod = periodFilter === '__current__' ? currentPeriod : (periodFilter === 'all' ? null : periodFilter);
      if (activePeriod !== null && r.pay_period_start !== activePeriod) return false;
    }
    return true;
  });

  // 人フィルター用の選択肢
  const personOptions = [...new Map(reports.map(r => [r.applicant_id, r.applicant?.name || r.applicant_id])).entries()]
    .sort((a, b) => (a[1] > b[1] ? 1 : -1));

  const activeCount = reports.filter(r => r.status !== 'confirmed').length;

  const btnBase: React.CSSProperties = {
    padding: '5px 14px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 'bold',
  };

  return (
    <div style={{ background: bg, minHeight: '60vh', padding: '0 0 40px' }}>
      <h3 style={{ textAlign: 'center', marginBottom: 6, color: textColor }}>⏰ 勤務変更申請一覧</h3>
      <p style={{ textAlign: 'center', fontSize: 13, color: subText, marginBottom: 16 }}>
        パートスタッフの残業・早退・遅刻・欠勤の申請を管理します。
      </p>

      {/* フィルター行 */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center', marginBottom: 16 }}>
        {/* ステータス */}
        {([['active', `申請中${activeCount > 0 ? ` (${activeCount})` : ''}`], ['confirmed', '受理済み'], ['all', 'すべて']] as const).map(([key, label]) => (
          <button key={key} onClick={() => setStatusFilter(key)}
            style={{ ...btnBase, background: statusFilter === key ? '#007bff' : (isDarkMode ? '#495057' : '#e9ecef'), color: statusFilter === key ? '#fff' : textColor }}>
            {label}
          </button>
        ))}

        {/* 給与期間（申請中以外で表示） */}
        {statusFilter !== 'active' && (
          <select value={periodFilter} onChange={e => setPeriodFilter(e.target.value)}
            style={{ padding: '5px 10px', borderRadius: 8, border: `1px solid ${border}`, background: isDarkMode ? '#495057' : '#fff', color: textColor, fontSize: 12 }}>
            <option value="__current__">{payPeriodLabel(currentPeriod)}</option>
            {periods.filter(p => p !== currentPeriod).map(p => (
              <option key={p} value={p}>{payPeriodLabel(p)}</option>
            ))}
            <option value="all">全期間</option>
          </select>
        )}

        {/* 申請者フィルター */}
        <select value={personFilter} onChange={e => setPersonFilter(e.target.value)}
          style={{ padding: '5px 10px', borderRadius: 8, border: `1px solid ${border}`, background: isDarkMode ? '#495057' : '#fff', color: textColor, fontSize: 12 }}>
          <option value="all">全員</option>
          {personOptions.map(([id, name]) => (
            <option key={id} value={id}>{name}</option>
          ))}
        </select>

        <button onClick={fetchReports}
          style={{ ...btnBase, background: isDarkMode ? '#495057' : '#e9ecef', color: textColor }}>
          更新
        </button>
      </div>

      {/* 一覧 */}
      {loading ? (
        <p style={{ textAlign: 'center', color: subText }}>読み込み中...</p>
      ) : filtered.length === 0 ? (
        <p style={{ textAlign: 'center', color: subText, marginTop: 40 }}>該当する申請はありません</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 700, margin: '0 auto', padding: '0 12px' }}>
          {filtered.map(r => {
            const info = TYPE_INFO[r.application_type];
            const st   = STATUS_INFO[r.status];
            const isOpen = expanded === r.id;
            const isPending = r.status === 'pending' || r.status === 'resubmitted';

            return (
              <div key={r.id} style={{ background: cardBg, borderRadius: 12, border: `1px solid ${isPending ? '#ffc107' : border}`, overflow: 'hidden', boxShadow: isPending ? '0 0 0 2px #ffc10740' : undefined }}>
                {/* ヘッダー行 */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', cursor: 'pointer' }}
                  onClick={() => setExpanded(isOpen ? null : r.id)}>
                  {/* 種別バッジ */}
                  <span style={{ fontSize: 13, fontWeight: 'bold', color: info.color, minWidth: 54 }}>
                    {info.emoji} {info.label}
                  </span>
                  {/* 日付 */}
                  <span style={{ fontSize: 13, color: textColor, fontWeight: 'bold', minWidth: 100 }}>
                    {r.work_date}（{dow(r.work_date)}）
                  </span>
                  {/* 申請者 */}
                  <span style={{ fontSize: 13, color: textColor, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {r.applicant?.name ?? '不明'}
                  </span>
                  {/* ステータス */}
                  <span style={{ fontSize: 11, fontWeight: 'bold', color: st.color, background: st.bg, borderRadius: 10, padding: '2px 8px', whiteSpace: 'nowrap' }}>
                    {st.label}
                  </span>
                  <span style={{ color: subText, fontSize: 12 }}>{isOpen ? '▲' : '▼'}</span>
                </div>

                {/* 展開詳細 */}
                {isOpen && (
                  <div style={{ borderTop: `1px solid ${border}`, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <Row label="給与期間" value={payPeriodLabel(r.pay_period_start)} sub={subText} text={textColor} />
                    <Row label="申請者"   value={r.applicant?.name ?? '不明'} sub={subText} text={textColor} />
                    <Row label="受取担当" value={r.reviewer?.name ?? '—'} sub={subText} text={textColor} />
                    {r.original_location && (
                      <Row label="勤務予定" value={`${r.original_location} ${r.original_start ?? ''}〜${r.original_end ?? ''}`} sub={subText} text={textColor} />
                    )}
                    {r.actual_location && (
                      <Row label="実際の勤務" value={`${r.actual_location} ${r.actual_start ?? ''}〜${r.actual_end ?? ''}`} sub={subText} text={textColor} />
                    )}
                    {r.is_holiday && (
                      <Row label="休日出勤" value="もともと休みの日" sub={subText} text={textColor} />
                    )}
                    {(r.labor_minutes != null && r.labor_minutes > 0) && (
                      <Row label="労働時間" value={`${Math.floor(r.labor_minutes / 60)}時間${r.labor_minutes % 60 > 0 ? r.labor_minutes % 60 + '分' : ''}`} sub={subText} text={textColor} />
                    )}
                    {r.reason && (
                      <Row label="理由" value={r.reason} sub={subText} text={textColor} />
                    )}
                    {r.status === 'confirmed' && r.confirmed_at && (
                      <Row label="受理日時"
                        value={`${new Date(r.confirmed_at).toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo' })} ${new Date(r.confirmed_at).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' })}（${r.confirmer?.name ?? '管理者'}）`}
                        sub={subText} text={textColor} />
                    )}
                    <Row label="申請日時"
                      value={`${new Date(r.created_at).toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo' })} ${new Date(r.created_at).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' })}`}
                      sub={subText} text={textColor} />

                    {isPending && (
                      <div style={{ marginTop: 6, display: 'flex', justifyContent: 'flex-end' }}>
                        <button
                          disabled={confirming === r.id}
                          onClick={() => handleConfirm(r)}
                          style={{ ...btnBase, padding: '8px 24px', background: confirming === r.id ? '#6c757d' : '#28a745', color: '#fff', fontSize: 14 }}>
                          {confirming === r.id ? '処理中...' : '✓ 受理する'}
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

const Row: React.FC<{ label: string; value: string; sub: string; text: string }> = ({ label, value, sub, text }) => (
  <div style={{ display: 'flex', gap: 10 }}>
    <span style={{ fontSize: 12, color: sub, minWidth: 70, flexShrink: 0 }}>{label}</span>
    <span style={{ fontSize: 13, color: text }}>{value}</span>
  </div>
);

export default ShiftReportsTab;

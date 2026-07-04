import React, { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { AuthUser } from '../types';
import { supabase } from '../lib/supabaseClient';
import { useDarkMode } from '../hooks/useDarkMode';
import ReimbursementForm from '../components/ReimbursementForm';
import PurchaseRequestForm, { type ResubmitRecord } from '../components/PurchaseRequestForm';
import PurchaseApprovals from '../components/PurchaseApprovals';

interface PurchaseRequestPageProps {
  user: AuthUser;
  roleTitle: string;
  isAdmin: boolean;
}

interface PurchaseRecord {
  id: string;
  user_id: string;
  request_type: 'reimbursement' | 'purchase_request';
  status: 'recorded' | 'pending_leader' | 'leader_approved' | 'pending_manager' | 'manager_approved' | 'self_judgment_shared' | 'returned';
  item_name: string;
  quantity: number | null;
  amount: number;
  purchased_at: string | null;
  requested_purchase_date: string | null;
  store_name: string | null;
  purpose: string | null;
  instructed_by: string | null;
  payment_method: 'cash' | 'company_card' | null;
  receipt_type: 'photo' | 'physical' | 'none' | null;
  receipt_missing_reason: string | null;
  returned_reason: string | null;
  leader_id: string | null;
  requested_manager_ids: string[] | null;
  shared_manager_ids: string[] | null;
  is_self_judgment: boolean;
  notes: string | null;
  quotes: { vendor: string; amount: number }[] | null;
  quote_file_path: string | null;
  created_at: string;
}

const PAYMENT_LABEL: Record<string, string> = { cash: '立替（返金あり）', company_card: '会社カード（返金なし）' };
const RECEIPT_LABEL: Record<string, string> = { photo: '写真あり', physical: '直接提出', none: 'なし' };
const STATUS_LABEL: Record<string, { label: string; color: string }> = {
  recorded:             { label: '精算記録', color: '#6c757d' },
  pending_leader:       { label: '承認待ち（リーダー）', color: '#e0a800' },
  leader_approved:      { label: '承認済み', color: '#28a745' },
  pending_manager:      { label: '承認待ち（マネージャー）', color: '#e0a800' },
  manager_approved:     { label: '承認済み', color: '#28a745' },
  self_judgment_shared: { label: '共有済み（自己判断）', color: '#6c757d' },
  returned:             { label: '差し戻し', color: '#dc3545' },
};

interface OpinionRow { purchase_request_id: string; manager_id: string; opinion: 'approve' | 'deny' | 'undecided' | 'other'; comment: string | null }
const OPINION_LABEL: Record<string, string> = { approve: '承認', deny: '否認', undecided: '判断できない', other: 'その他' };

const HistoryList: React.FC<{ isDarkMode: boolean; isManagerPlus: boolean; userId: string; onResubmit: (record: ResubmitRecord) => void }> = ({ isDarkMode, isManagerPlus, userId, onResubmit }) => {
  const [records, setRecords] = useState<PurchaseRecord[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [opinions, setOpinions] = useState<Record<string, OpinionRow[]>>({});
  const [loading, setLoading] = useState(true);

  const cardBg = isDarkMode ? '#2d2d3e' : '#ffffff';
  const border = isDarkMode ? '#3a3a5c' : '#e0e0e0';
  const text = isDarkMode ? '#eeeeee' : '#222222';
  const subText = isDarkMode ? '#aaaaaa' : '#666666';

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from('purchase_requests')
      .select('id, user_id, request_type, status, item_name, quantity, amount, purchased_at, requested_purchase_date, store_name, purpose, instructed_by, payment_method, receipt_type, receipt_missing_reason, returned_reason, leader_id, requested_manager_ids, shared_manager_ids, is_self_judgment, notes, quotes, quote_file_path, created_at')
      .order('created_at', { ascending: false });
    const rows = (data ?? []) as PurchaseRecord[];
    setRecords(rows);

    const namesToFetch = new Set<string>();
    if (isManagerPlus) rows.forEach(r => namesToFetch.add(r.user_id));

    // マネージャー承認ルートの自分の申請には、共有可の意見（RLSでvisible_to_applicant=trueのみ返る）を表示する
    const managerRouteIds = rows.filter(r => r.user_id === userId && r.requested_manager_ids?.length).map(r => r.id);
    if (managerRouteIds.length > 0) {
      const { data: ops } = await supabase
        .from('purchase_request_manager_opinions')
        .select('purchase_request_id, manager_id, opinion, comment')
        .in('purchase_request_id', managerRouteIds);
      const grouped: Record<string, OpinionRow[]> = {};
      (ops ?? []).forEach((o: OpinionRow) => { (grouped[o.purchase_request_id] ??= []).push(o); namesToFetch.add(o.manager_id); });
      setOpinions(grouped);
    }

    if (namesToFetch.size > 0) {
      const { data: profs } = await supabase.from('profiles').select('id, name').in('id', [...namesToFetch]);
      const map: Record<string, string> = {};
      (profs ?? []).forEach((p: { id: string; name: string }) => { map[p.id] = p.name; });
      setNames(map);
    }
    setLoading(false);
  }, [isManagerPlus, userId]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div style={{ padding: 20, textAlign: 'center', color: subText }}>読み込み中...</div>;
  if (records.length === 0) return <div style={{ padding: 20, textAlign: 'center', color: subText }}>記録はまだありません</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {records.map(r => {
        const statusInfo = STATUS_LABEL[r.status];
        return (
        <div key={r.id} style={{ background: cardBg, border: `1px solid ${border}`, borderRadius: 10, padding: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6, gap: 8 }}>
            <span style={{ fontSize: 15, fontWeight: 'bold', color: text }}>{r.item_name}</span>
            <span style={{ fontSize: 15, fontWeight: 'bold', color: text, whiteSpace: 'nowrap' }}>¥{r.amount.toLocaleString()}</span>
          </div>
          <div style={{ fontSize: 12, color: subText, display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 4 }}>
            <span style={{ color: '#fff', background: r.request_type === 'reimbursement' ? '#6c757d' : '#4a90d9', borderRadius: 4, padding: '1px 6px' }}>
              {r.request_type === 'reimbursement' ? '精算' : '申請'}
            </span>
            {statusInfo && r.request_type === 'purchase_request' && (
              <span style={{ color: '#fff', background: statusInfo.color, borderRadius: 4, padding: '1px 6px' }}>{statusInfo.label}</span>
            )}
            <span>📅 {r.purchased_at ?? r.requested_purchase_date}</span>
            {r.payment_method && <span>💳 {PAYMENT_LABEL[r.payment_method]}</span>}
            {r.receipt_type && <span>🧾 {RECEIPT_LABEL[r.receipt_type]}</span>}
            {isManagerPlus && r.user_id !== userId && <span>👤 {names[r.user_id] ?? '不明'}</span>}
          </div>
          {(r.store_name || r.purpose || r.instructed_by) && (
            <div style={{ fontSize: 12, color: subText, marginTop: 4 }}>
              {r.store_name && <span>購入先：{r.store_name}　</span>}
              {r.purpose && <span>用途：{r.purpose}　</span>}
              {r.instructed_by && <span>指示者：{r.instructed_by}</span>}
            </div>
          )}
          {r.receipt_type === 'none' && r.receipt_missing_reason && (
            <div style={{ fontSize: 12, color: subText, marginTop: 4 }}>レシートなし理由：{r.receipt_missing_reason}</div>
          )}
          {r.notes && <div style={{ fontSize: 12, color: subText, marginTop: 4 }}>備考：{r.notes}</div>}
          {r.quotes && r.quotes.length > 0 && (
            <div style={{ fontSize: 12, color: subText, marginTop: 4 }}>
              相見積もり：{r.quotes.map(q => `${q.vendor}（¥${q.amount.toLocaleString()}）`).join('　')}
              {r.quote_file_path && '　📎見積書あり'}
            </div>
          )}
          {opinions[r.id] && opinions[r.id].length > 0 && (
            <div style={{ fontSize: 12, color: subText, marginTop: 6, padding: '6px 8px', background: isDarkMode ? '#20304a' : '#eef6ff', borderRadius: 6 }}>
              共有された意見：{opinions[r.id].map(o => `${names[o.manager_id] ?? '不明'}（${OPINION_LABEL[o.opinion]}${o.comment ? '：' + o.comment : ''}）`).join('　')}
            </div>
          )}
          {r.status === 'returned' && r.returned_reason && (
            <div style={{ fontSize: 12, color: '#dc3545', marginTop: 6 }}>差し戻し理由：{r.returned_reason}</div>
          )}
          {r.status === 'returned' && r.user_id === userId && (
            <button
              type="button"
              onClick={() => onResubmit({
                id: r.id, item_name: r.item_name, quantity: r.quantity, amount: r.amount,
                requested_purchase_date: r.requested_purchase_date, store_name: r.store_name,
                purpose: r.purpose, notes: r.notes, leader_id: r.leader_id, returned_reason: r.returned_reason,
                requested_manager_ids: r.requested_manager_ids, shared_manager_ids: r.shared_manager_ids, is_self_judgment: r.is_self_judgment,
                quotes: r.quotes, quote_file_path: r.quote_file_path,
              })}
              style={{ marginTop: 8, width: '100%', padding: '8px', borderRadius: 8, border: 'none', background: '#4a90d9', color: '#fff', fontSize: 13, fontWeight: 'bold', cursor: 'pointer' }}
            >
              修正して再申請する
            </button>
          )}
        </div>
        );
      })}
    </div>
  );
};

const PurchaseRequestPage: React.FC<PurchaseRequestPageProps> = ({ user, roleTitle, isAdmin }) => {
  const isDarkMode = useDarkMode();
  const [searchParams, setSearchParams] = useSearchParams();
  const validTabs = ['reimbursement', 'request', 'history', 'approvals'] as const;
  type Tab = typeof validTabs[number];
  const tabParam = searchParams.get('tab');
  const tab: Tab = (validTabs as readonly string[]).includes(tabParam ?? '') ? (tabParam as Tab) : 'reimbursement';
  const setTab = (t: Tab) => setSearchParams(t === 'reimbursement' ? {} : { tab: t });
  const [resubmitRecord, setResubmitRecord] = useState<ResubmitRecord | null>(null);
  const isManagerPlus = isAdmin || ['マネージャー', '社長'].includes(roleTitle);
  const canApprovePurchase = isAdmin || ['リーダー', 'マネージャー', '社長'].includes(roleTitle);

  const bg = isDarkMode ? '#1a1a2e' : '#f0f2f5';
  const cardBg = isDarkMode ? '#2d2d3e' : '#ffffff';
  const border = isDarkMode ? '#3a3a5c' : '#e0e0e0';
  const text = isDarkMode ? '#eeeeee' : '#222222';

  const tabDefs: { key: Tab; label: string }[] = [
    { key: 'reimbursement', label: '💰 精算' },
    { key: 'request', label: '📝 申請' },
    { key: 'history', label: '📋 履歴' },
    ...(canApprovePurchase ? [{ key: 'approvals' as Tab, label: '✅ 承認' }] : []),
  ];

  return (
    <div style={{ minHeight: '100vh', background: bg }}>
      <div style={{ maxWidth: 600, margin: '0 auto', padding: '70px 16px 40px' }}>
      <div style={{ textAlign: 'center', padding: '28px 0 12px' }}>
        <h1 style={{ fontSize: 20, fontWeight: 'bold', color: text, margin: 0 }}>🧾 備品精算</h1>
      </div>

      <div style={{ display: 'flex', background: cardBg, border: `1px solid ${border}`, borderRadius: 10, overflow: 'hidden', marginBottom: 14 }}>
        {tabDefs.map(({ key, label }) => (
          <button
            key={key}
            type="button" onClick={() => { setResubmitRecord(null); setTab(key); }}
            style={{ flex: 1, padding: '10px 4px', border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: tab === key ? 'bold' : 'normal', background: tab === key ? '#28a745' : 'transparent', color: tab === key ? '#fff' : text }}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'reimbursement' && <ReimbursementForm user={user} roleTitle={roleTitle} />}
      {tab === 'request' && (
        <PurchaseRequestForm
          user={user} roleTitle={roleTitle} isAdmin={isAdmin}
          resubmitRecord={resubmitRecord}
          onDoneResubmit={() => { setResubmitRecord(null); setTab('history'); }}
        />
      )}
      {tab === 'history' && (
        <HistoryList
          isDarkMode={isDarkMode} isManagerPlus={isManagerPlus} userId={user.id}
          onResubmit={record => { setResubmitRecord(record); setTab('request'); }}
        />
      )}
      {tab === 'approvals' && canApprovePurchase && <PurchaseApprovals userId={user.id} />}
      </div>
    </div>
  );
};

export default PurchaseRequestPage;

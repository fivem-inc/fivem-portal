import React, { useState, useEffect, useCallback } from 'react';
import type { AuthUser } from '../types';
import { supabase } from '../lib/supabaseClient';
import { useDarkMode } from '../hooks/useDarkMode';
import ReimbursementForm from '../components/ReimbursementForm';

interface PurchaseRequestPageProps {
  user: AuthUser;
  roleTitle: string;
  isAdmin: boolean;
}

interface PurchaseRecord {
  id: string;
  user_id: string;
  item_name: string;
  amount: number;
  purchased_at: string;
  store_name: string | null;
  purpose: string | null;
  instructed_by: string | null;
  payment_method: 'cash' | 'company_card';
  receipt_type: 'photo' | 'physical' | 'none';
  receipt_missing_reason: string | null;
  notes: string | null;
  created_at: string;
}

const PAYMENT_LABEL: Record<string, string> = { cash: '立替（返金あり）', company_card: '会社カード（返金なし）' };
const RECEIPT_LABEL: Record<string, string> = { photo: '写真あり', physical: '直接提出', none: 'なし' };

const HistoryList: React.FC<{ isDarkMode: boolean; isManagerPlus: boolean; userId: string }> = ({ isDarkMode, isManagerPlus, userId }) => {
  const [records, setRecords] = useState<PurchaseRecord[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  const cardBg = isDarkMode ? '#2d2d3e' : '#ffffff';
  const border = isDarkMode ? '#3a3a5c' : '#e0e0e0';
  const text = isDarkMode ? '#eeeeee' : '#222222';
  const subText = isDarkMode ? '#aaaaaa' : '#666666';

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from('purchase_requests')
      .select('id, user_id, item_name, amount, purchased_at, store_name, purpose, instructed_by, payment_method, receipt_type, receipt_missing_reason, notes, created_at')
      .order('purchased_at', { ascending: false });
    const rows = (data ?? []) as PurchaseRecord[];
    setRecords(rows);

    if (isManagerPlus) {
      const userIds = [...new Set(rows.map(r => r.user_id))];
      if (userIds.length > 0) {
        const { data: profs } = await supabase.from('profiles').select('id, name').in('id', userIds);
        const map: Record<string, string> = {};
        (profs ?? []).forEach((p: { id: string; name: string }) => { map[p.id] = p.name; });
        setNames(map);
      }
    }
    setLoading(false);
  }, [isManagerPlus]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div style={{ padding: 20, textAlign: 'center', color: subText }}>読み込み中...</div>;
  if (records.length === 0) return <div style={{ padding: 20, textAlign: 'center', color: subText }}>記録はまだありません</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {records.map(r => (
        <div key={r.id} style={{ background: cardBg, border: `1px solid ${border}`, borderRadius: 10, padding: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
            <span style={{ fontSize: 15, fontWeight: 'bold', color: text }}>{r.item_name}</span>
            <span style={{ fontSize: 15, fontWeight: 'bold', color: text }}>¥{r.amount.toLocaleString()}</span>
          </div>
          <div style={{ fontSize: 12, color: subText, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <span>📅 {r.purchased_at}</span>
            <span>💳 {PAYMENT_LABEL[r.payment_method]}</span>
            <span>🧾 {RECEIPT_LABEL[r.receipt_type]}</span>
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
        </div>
      ))}
    </div>
  );
};

const PurchaseRequestPage: React.FC<PurchaseRequestPageProps> = ({ user, roleTitle, isAdmin }) => {
  const isDarkMode = useDarkMode();
  const [tab, setTab] = useState<'reimbursement' | 'history'>('reimbursement');
  const isManagerPlus = isAdmin || ['マネージャー', '社長'].includes(roleTitle);

  const bg = isDarkMode ? '#1a1a2e' : '#f0f2f5';
  const cardBg = isDarkMode ? '#2d2d3e' : '#ffffff';
  const border = isDarkMode ? '#3a3a5c' : '#e0e0e0';
  const text = isDarkMode ? '#eeeeee' : '#222222';

  return (
    <div style={{ minHeight: '100vh', background: bg }}>
      <div style={{ maxWidth: 600, margin: '0 auto', padding: '70px 16px 40px' }}>
      <div style={{ textAlign: 'center', padding: '28px 0 12px' }}>
        <h1 style={{ fontSize: 20, fontWeight: 'bold', color: text, margin: 0 }}>🧾 備品精算</h1>
      </div>

      <div style={{ display: 'flex', background: cardBg, border: `1px solid ${border}`, borderRadius: 10, overflow: 'hidden', marginBottom: 14 }}>
        <button
          type="button" onClick={() => setTab('reimbursement')}
          style={{ flex: 1, padding: '10px', border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: tab === 'reimbursement' ? 'bold' : 'normal', background: tab === 'reimbursement' ? '#28a745' : 'transparent', color: tab === 'reimbursement' ? '#fff' : text }}
        >
          💰 精算
        </button>
        <button
          type="button" onClick={() => setTab('history')}
          style={{ flex: 1, padding: '10px', border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: tab === 'history' ? 'bold' : 'normal', background: tab === 'history' ? '#28a745' : 'transparent', color: tab === 'history' ? '#fff' : text }}
        >
          📋 履歴
        </button>
      </div>

      {tab === 'reimbursement' && <ReimbursementForm user={user} roleTitle={roleTitle} />}
      {tab === 'history' && <HistoryList isDarkMode={isDarkMode} isManagerPlus={isManagerPlus} userId={user.id} />}
      </div>
    </div>
  );
};

export default PurchaseRequestPage;

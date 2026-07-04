import React, { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabaseClient';
import { useDarkMode } from '../hooks/useDarkMode';
import { insertNotification } from '../lib/notifications';
import { dispatchSiteNotification } from '../lib/notificationDispatch';

type Route = 'leader' | 'manager';

interface PendingRequest {
  id: string;
  user_id: string;
  item_name: string;
  quantity: number | null;
  amount: number;
  requested_purchase_date: string | null;
  store_name: string | null;
  purpose: string | null;
  notes: string | null;
  quotes: { vendor: string; amount: number }[] | null;
  quote_file_path: string | null;
  created_at: string;
  route: Route;
}

interface Props {
  userId: string;
}

const SELECT_COLUMNS = 'id, user_id, item_name, quantity, amount, requested_purchase_date, store_name, purpose, notes, quotes, quote_file_path, created_at';

const PurchaseApprovals: React.FC<Props> = ({ userId }) => {
  const isDarkMode = useDarkMode();
  const [requests, setRequests] = useState<PendingRequest[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [returningId, setReturningId] = useState<string | null>(null);
  const [returnReason, setReturnReason] = useState('');
  const [processingId, setProcessingId] = useState<string | null>(null);

  const cardBg = isDarkMode ? '#2d2d3e' : '#ffffff';
  const border = isDarkMode ? '#3a3a5c' : '#e0e0e0';
  const text = isDarkMode ? '#eeeeee' : '#222222';
  const subText = isDarkMode ? '#aaaaaa' : '#666666';
  const inputBg = isDarkMode ? '#3a3a5c' : '#f8f9fa';

  const load = useCallback(async () => {
    setLoading(true);
    // リーダー承認待ち・マネージャー承認待ちは別々にクエリしてマージする
    // （配列列と単数列が混在するため.or()で無理に一本化せず可読性を優先）
    const [leaderRes, managerRes] = await Promise.all([
      supabase.from('purchase_requests').select(SELECT_COLUMNS).eq('leader_id', userId).eq('status', 'pending_leader'),
      supabase.from('purchase_requests').select(SELECT_COLUMNS).eq('manager_id', userId).eq('status', 'pending_manager'),
    ]);
    const rows: PendingRequest[] = [
      ...((leaderRes.data ?? []) as Omit<PendingRequest, 'route'>[]).map(r => ({ ...r, route: 'leader' as const })),
      ...((managerRes.data ?? []) as Omit<PendingRequest, 'route'>[]).map(r => ({ ...r, route: 'manager' as const })),
    ].sort((a, b) => a.created_at.localeCompare(b.created_at));
    setRequests(rows);

    const userIds = [...new Set(rows.map(r => r.user_id))];
    if (userIds.length > 0) {
      const { data: profs } = await supabase.from('profiles').select('id, name').in('id', userIds);
      const map: Record<string, string> = {};
      (profs ?? []).forEach((p: { id: string; name: string }) => { map[p.id] = p.name; });
      setNames(map);
    }
    setLoading(false);
  }, [userId]);

  useEffect(() => { load(); }, [load]);

  const handleApprove = async (req: PendingRequest) => {
    setProcessingId(req.id);
    const update = req.route === 'leader'
      ? { status: 'leader_approved', leader_approved_at: new Date().toISOString() }
      : { status: 'manager_approved', manager_approved_at: new Date().toISOString() };
    const eventKey = req.route === 'leader' ? 'purchase_request:leader_approved' : 'purchase_request:manager_approved';
    const { error } = await supabase.from('purchase_requests').update(update).eq('id', req.id);

    if (!error) {
      const vars = { '品目名': req.item_name };
      await dispatchSiteNotification(eventKey, vars, { applicant: req.user_id }, insertNotification, 'purchase_request', req.id);
      setRequests(prev => prev.filter(r => r.id !== req.id));
    }
    setProcessingId(null);
  };

  const handleReturn = async () => {
    if (!returningId || !returnReason.trim()) return;
    const req = requests.find(r => r.id === returningId);
    if (!req) return;

    setProcessingId(returningId);
    const { error } = await supabase.from('purchase_requests').update({
      status: 'returned',
      returned_reason: returnReason.trim(),
    }).eq('id', returningId);

    if (!error) {
      const vars = { '品目名': req.item_name };
      await dispatchSiteNotification('purchase_request:returned', vars, { applicant: req.user_id }, insertNotification, 'purchase_request', req.id);
      setRequests(prev => prev.filter(r => r.id !== returningId));
    }
    setProcessingId(null);
    setReturningId(null);
    setReturnReason('');
  };

  if (loading) return <div style={{ padding: 20, textAlign: 'center', color: subText }}>読み込み中...</div>;
  if (requests.length === 0) return <div style={{ padding: 20, textAlign: 'center', color: subText }}>承認待ちの申請はありません</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {requests.map(r => (
        <div key={r.id} style={{ background: cardBg, border: `1px solid ${border}`, borderRadius: 10, padding: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6, gap: 8 }}>
            <span style={{ fontSize: 15, fontWeight: 'bold', color: text }}>{r.item_name}</span>
            <span style={{ fontSize: 15, fontWeight: 'bold', color: text, whiteSpace: 'nowrap' }}>¥{r.amount.toLocaleString()}</span>
          </div>
          <div style={{ fontSize: 12, color: subText, display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 6 }}>
            <span style={{ color: '#fff', background: r.route === 'leader' ? '#4a90d9' : '#8a5cd9', borderRadius: 4, padding: '1px 6px' }}>
              あなたの承認が必要（{r.route === 'leader' ? 'リーダー' : 'マネージャー'}）
            </span>
            <span>👤 {names[r.user_id] ?? '不明'}</span>
            {r.requested_purchase_date && <span>📅 購入予定：{r.requested_purchase_date}</span>}
            {r.quantity != null && <span>数量：{r.quantity}</span>}
          </div>
          {(r.store_name || r.purpose) && (
            <div style={{ fontSize: 12, color: subText, marginBottom: 6 }}>
              {r.store_name && <span>購入先：{r.store_name}　</span>}
              {r.purpose && <span>用途：{r.purpose}</span>}
            </div>
          )}
          {r.notes && <div style={{ fontSize: 12, color: subText, marginBottom: 8 }}>備考：{r.notes}</div>}
          {r.quotes && r.quotes.length > 0 && (
            <div style={{ fontSize: 12, color: subText, marginBottom: 8 }}>
              相見積もり：{r.quotes.map(q => `${q.vendor}（¥${q.amount.toLocaleString()}）`).join('　')}
              {r.quote_file_path && '　📎見積書あり'}
            </div>
          )}

          {returningId === r.id ? (
            <div style={{ marginTop: 8 }}>
              <textarea
                value={returnReason} onChange={e => setReturnReason(e.target.value)}
                placeholder="差し戻し理由を入力してください" rows={2}
                style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 8, border: `1px solid ${border}`, background: inputBg, color: text, fontSize: 13, resize: 'vertical' as const, marginBottom: 8 }}
              />
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button" onClick={() => { setReturningId(null); setReturnReason(''); }}
                  style={{ flex: 1, padding: '8px', borderRadius: 8, border: `1px solid ${border}`, background: 'transparent', color: text, fontSize: 13, cursor: 'pointer' }}
                >
                  キャンセル
                </button>
                <button
                  type="button" onClick={handleReturn} disabled={!returnReason.trim() || processingId === r.id}
                  style={{ flex: 1, padding: '8px', borderRadius: 8, border: 'none', background: '#dc3545', color: '#fff', fontSize: 13, fontWeight: 'bold', cursor: 'pointer' }}
                >
                  差し戻す
                </button>
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button" onClick={() => setReturningId(r.id)}
                style={{ flex: 1, padding: '10px', borderRadius: 8, border: `1px solid ${border}`, background: 'transparent', color: text, fontSize: 13, cursor: 'pointer' }}
              >
                差し戻す
              </button>
              <button
                type="button" onClick={() => handleApprove(r)} disabled={processingId === r.id}
                style={{ flex: 1, padding: '10px', borderRadius: 8, border: 'none', background: '#28a745', color: '#fff', fontSize: 13, fontWeight: 'bold', cursor: 'pointer' }}
              >
                {processingId === r.id ? '処理中...' : '承認する'}
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
};

export default PurchaseApprovals;

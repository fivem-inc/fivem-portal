import React, { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabaseClient';
import { useDarkMode } from '../hooks/useDarkMode';
import { insertNotification } from '../lib/notifications';
import { dispatchSiteNotification, getNotificationTemplate } from '../lib/notificationDispatch';

type Route = 'leader' | 'manager';
type OpinionValue = 'approve' | 'deny' | 'undecided' | 'other';

const OPINION_LABEL: Record<OpinionValue, string> = { approve: '承認', deny: '否認', undecided: '判断できない', other: 'その他' };
const OPINION_OPTIONS: OpinionValue[] = ['approve', 'deny', 'undecided', 'other'];

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
  requested_manager_ids: string[] | null;
}

interface OpinionRow {
  purchase_request_id: string;
  manager_id: string;
  opinion: OpinionValue;
  comment: string | null;
  visible_to_applicant: boolean;
}

interface Props {
  userId: string;
}

const SELECT_COLUMNS = 'id, user_id, item_name, quantity, amount, requested_purchase_date, store_name, purpose, notes, quotes, quote_file_path, created_at, requested_manager_ids';

const PurchaseApprovals: React.FC<Props> = ({ userId }) => {
  const isDarkMode = useDarkMode();
  const [requests, setRequests] = useState<PendingRequest[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [opinions, setOpinions] = useState<Record<string, OpinionRow[]>>({});
  const [loading, setLoading] = useState(true);
  const [returningId, setReturningId] = useState<string | null>(null);
  const [returnReason, setReturnReason] = useState('');
  const [processingId, setProcessingId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, { opinion: OpinionValue | ''; comment: string; visibleToApplicant: boolean }>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  const cardBg = isDarkMode ? '#2d2d3e' : '#ffffff';
  const border = isDarkMode ? '#3a3a5c' : '#e0e0e0';
  const text = isDarkMode ? '#eeeeee' : '#222222';
  const subText = isDarkMode ? '#aaaaaa' : '#666666';
  const inputBg = isDarkMode ? '#3a3a5c' : '#f8f9fa';
  const warnBg = isDarkMode ? '#3a3220' : '#fff8e1';
  const warnBorder = isDarkMode ? '#5c5430' : '#ffe082';
  const warnText = isDarkMode ? '#ffe082' : '#8a6d00';

  const load = useCallback(async () => {
    setLoading(true);
    // リーダー承認待ち・マネージャー承認待ちは別々にクエリしてマージする
    // （配列列と単数列が混在するため.or()で無理に一本化せず可読性を優先）
    const [leaderRes, managerRes] = await Promise.all([
      supabase.from('purchase_requests').select(SELECT_COLUMNS).eq('leader_id', userId).eq('status', 'pending_leader'),
      supabase.from('purchase_requests').select(SELECT_COLUMNS).contains('requested_manager_ids', [userId]).eq('status', 'pending_manager'),
    ]);
    const rows: PendingRequest[] = [
      ...((leaderRes.data ?? []) as Omit<PendingRequest, 'route'>[]).map(r => ({ ...r, route: 'leader' as const })),
      ...((managerRes.data ?? []) as Omit<PendingRequest, 'route'>[]).map(r => ({ ...r, route: 'manager' as const })),
    ].sort((a, b) => a.created_at.localeCompare(b.created_at));
    setRequests(rows);

    const managerRouteIds = rows.filter(r => r.route === 'manager').map(r => r.id);
    let opinionRows: OpinionRow[] = [];
    if (managerRouteIds.length > 0) {
      const { data: ops } = await supabase
        .from('purchase_request_manager_opinions')
        .select('purchase_request_id, manager_id, opinion, comment, visible_to_applicant')
        .in('purchase_request_id', managerRouteIds);
      opinionRows = (ops ?? []) as OpinionRow[];
      const grouped: Record<string, OpinionRow[]> = {};
      opinionRows.forEach(o => { (grouped[o.purchase_request_id] ??= []).push(o); });
      setOpinions(grouped);

      // 自分の既存意見をドラフトに反映（編集可能にする）
      setDrafts(prev => {
        const next = { ...prev };
        for (const id of managerRouteIds) {
          const mine = opinionRows.find(o => o.purchase_request_id === id && o.manager_id === userId);
          if (mine && !next[id]) {
            next[id] = { opinion: mine.opinion, comment: mine.comment ?? '', visibleToApplicant: mine.visible_to_applicant };
          } else if (!next[id]) {
            next[id] = { opinion: '', comment: '', visibleToApplicant: false };
          }
        }
        return next;
      });
    }

    const userIds = new Set(rows.map(r => r.user_id));
    rows.forEach(r => (r.requested_manager_ids ?? []).forEach(id => userIds.add(id)));
    opinionRows.forEach(o => userIds.add(o.manager_id));
    if (userIds.size > 0) {
      const { data: profs } = await supabase.from('profiles').select('id, name').in('id', [...userIds]);
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
    } else {
      setErrors(prev => ({ ...prev, [req.id]: '最終決定に失敗しました: ' + error.message }));
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
      setReturningId(null);
      setReturnReason('');
    } else {
      setErrors(prev => ({ ...prev, [returningId]: '差し戻しに失敗しました: ' + error.message }));
    }
    setProcessingId(null);
  };

  const submitOpinion = async (req: PendingRequest) => {
    const draft = drafts[req.id];
    if (!draft?.opinion) return;
    setProcessingId(req.id);

    const { error } = await supabase.from('purchase_request_manager_opinions').upsert({
      purchase_request_id: req.id,
      manager_id: userId,
      opinion: draft.opinion,
      comment: draft.comment.trim() || null,
      visible_to_applicant: draft.visibleToApplicant,
    }, { onConflict: 'purchase_request_id,manager_id' });

    if (error) {
      setErrors(prev => ({ ...prev, [req.id]: '意見の送信に失敗しました: ' + error.message }));
      setProcessingId(null);
      return;
    }
    setErrors(prev => { const next = { ...prev }; delete next[req.id]; return next; });

    const { data: ops } = await supabase
      .from('purchase_request_manager_opinions')
      .select('purchase_request_id, manager_id, opinion, comment, visible_to_applicant')
      .eq('purchase_request_id', req.id);
    const rows = (ops ?? []) as OpinionRow[];
    setOpinions(prev => ({ ...prev, [req.id]: rows }));

    const others = (req.requested_manager_ids ?? []).filter(id => id !== userId);
    const vars = { '回答者名': names[userId] ?? '', '品目名': req.item_name };
    const allAnswered = rows.length >= (req.requested_manager_ids?.length ?? 0);
    const eventKey = allAnswered ? 'purchase_request:manager_opinions_ready' : 'purchase_request:manager_opinion_submitted';
    const tpl = await getNotificationTemplate(eventKey, 'site', vars);
    if (tpl && others.length > 0) {
      await Promise.all(others.map(id => insertNotification(id, tpl.template, tpl.subject || undefined, 'purchase_request:pending_approval', req.id)));
    }

    setProcessingId(null);
  };

  if (loading) return <div style={{ padding: 20, textAlign: 'center', color: subText }}>読み込み中...</div>;
  if (requests.length === 0) return <div style={{ padding: 20, textAlign: 'center', color: subText }}>承認待ちの申請はありません</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {requests.map(r => {
        const requestOpinions = opinions[r.id] ?? [];
        const requestedIds = r.requested_manager_ids ?? [];
        const unanswered = requestedIds.filter(id => !requestOpinions.some(o => o.manager_id === id));
        const allAnswered = r.route === 'leader' || unanswered.length === 0;
        const draft = drafts[r.id] ?? { opinion: '', comment: '', visibleToApplicant: false };

        return (
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

          {r.route === 'manager' && (
            <div style={{ marginBottom: 10, padding: '10px 12px', background: isDarkMode ? '#20304a' : '#eef6ff', border: `1px solid ${isDarkMode ? '#2e4a70' : '#cfe4ff'}`, borderRadius: 8 }}>
              <div style={{ fontSize: 12, fontWeight: 'bold', color: text, marginBottom: 6 }}>依頼された{requestedIds.length}名の意見</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 10 }}>
                {requestedIds.map(id => {
                  const o = requestOpinions.find(x => x.manager_id === id);
                  return (
                    <div key={id} style={{ fontSize: 12, color: text, display: 'flex', gap: 6 }}>
                      <span style={{ minWidth: 80 }}>{names[id] ?? '不明'}</span>
                      {o ? (
                        <span>{OPINION_LABEL[o.opinion]}{o.comment ? `：${o.comment}` : ''}</span>
                      ) : (
                        <span style={{ color: subText }}>未回答</span>
                      )}
                    </div>
                  );
                })}
              </div>

              <div style={{ fontSize: 12, fontWeight: 'bold', color: text, marginBottom: 6 }}>あなたの意見</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
                {OPINION_OPTIONS.map(opt => (
                  <label key={opt} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: text, cursor: 'pointer' }}>
                    <input
                      type="radio" checked={draft.opinion === opt}
                      onChange={() => setDrafts(prev => ({ ...prev, [r.id]: { ...draft, opinion: opt } }))}
                    />
                    {OPINION_LABEL[opt]}
                  </label>
                ))}
              </div>
              <textarea
                value={draft.comment}
                onChange={e => setDrafts(prev => ({ ...prev, [r.id]: { ...draft, comment: e.target.value } }))}
                placeholder="コメント（任意）" rows={2}
                style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 8, border: `1px solid ${border}`, background: inputBg, color: text, fontSize: 12, resize: 'vertical' as const, marginBottom: 8 }}
              />
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: subText, marginBottom: 8, cursor: 'pointer' }}>
                <input
                  type="checkbox" checked={draft.visibleToApplicant}
                  onChange={e => setDrafts(prev => ({ ...prev, [r.id]: { ...draft, visibleToApplicant: e.target.checked } }))}
                />
                申請者にもこの意見を共有する
              </label>
              <button
                type="button" onClick={() => submitOpinion(r)} disabled={!draft.opinion || processingId === r.id}
                style={{ width: '100%', padding: '8px', borderRadius: 8, border: 'none', background: draft.opinion ? '#4a90d9' : subText, color: '#fff', fontSize: 13, fontWeight: 'bold', cursor: draft.opinion ? 'pointer' : 'default' }}
              >
                意見を送る
              </button>
            </div>
          )}

          {errors[r.id] && (
            <div style={{ marginBottom: 10, padding: '8px 10px', background: '#fff5f5', border: '1px solid #f5c2c7', borderRadius: 8, color: '#842029', fontSize: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
              <span>{errors[r.id]}</span>
              <button type="button" onClick={() => setErrors(prev => { const next = { ...prev }; delete next[r.id]; return next; })} style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: '#842029', fontSize: 14 }}>✕</button>
            </div>
          )}

          {r.route === 'manager' && !allAnswered && (
            <div style={{ marginBottom: 10, padding: '8px 10px', background: warnBg, border: `1px solid ${warnBorder}`, borderRadius: 8, fontSize: 12, color: warnText }}>
              あと{unanswered.length}名（{unanswered.map(id => names[id] ?? '不明').join('・')}）の意見待ちのため、最終決定はまだできません。
            </div>
          )}
          {r.route === 'manager' && allAnswered && (
            <div style={{ marginBottom: 10, padding: '8px 10px', background: warnBg, border: `1px solid ${warnBorder}`, borderRadius: 8, fontSize: 12, color: warnText }}>
              全員の意見が出揃いました。全員一致でなくても構いません。意見が割れている場合は話し合いのうえ、どなたか1名が最終決定してください。
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
                  最終決定：差し戻す
                </button>
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button" onClick={() => setReturningId(r.id)} disabled={!allAnswered}
                style={{ flex: 1, padding: '10px', borderRadius: 8, border: `1px solid ${border}`, background: 'transparent', color: allAnswered ? text : subText, fontSize: 13, cursor: allAnswered ? 'pointer' : 'default' }}
              >
                最終決定：差し戻す
              </button>
              <button
                type="button" onClick={() => handleApprove(r)} disabled={processingId === r.id || !allAnswered}
                style={{ flex: 1, padding: '10px', borderRadius: 8, border: 'none', background: allAnswered ? '#28a745' : subText, color: '#fff', fontSize: 13, fontWeight: 'bold', cursor: allAnswered ? 'pointer' : 'default' }}
              >
                {processingId === r.id ? '処理中...' : '最終決定：承認する'}
              </button>
            </div>
          )}
        </div>
        );
      })}
    </div>
  );
};

export default PurchaseApprovals;

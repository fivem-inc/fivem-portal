import React, { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabaseClient';
import { useDarkMode } from '../hooks/useDarkMode';
import { useFocusHighlight } from '../hooks/useFocusHighlight';
import { insertNotification } from '../lib/notifications';
import { dispatchEmail, getNotificationTemplate, getUserEmail } from '../lib/notificationDispatch';
import { sendPurchaseSlackForEvent } from '../lib/purchaseSlack';
import { approvePurchaseRequestAction, returnPurchaseRequestAction } from '../lib/purchaseApprovalActions';
import { resolveItems } from '../lib/purchaseItemsFallback';
import PurchaseItemsSummary from './PurchaseItemsSummary';
import type { PurchaseRequestItem, PurchaseRequestItemQuote } from '../types';
import PurchaseCommentThread from './PurchaseCommentThread';
import { fetchPurchaseComments, type PurchaseComment } from '../lib/purchaseComments';

type Route = 'leader' | 'manager' | 'board';
type OpinionValue = 'approve' | 'deny' | 'undecided' | 'other';

const OPINION_LABEL: Record<OpinionValue, string> = { approve: '承認', deny: '否認', undecided: '判断できない', other: 'その他' };
const OPINION_OPTIONS: OpinionValue[] = ['approve', 'deny', 'undecided', 'other'];

// 自分の意見提出をもって全員承認が揃った場合に、明示的なフィードバックとして表示するバナー
const BoardAllApprovedBanner: React.FC<{ message: string; onClose: () => void }> = ({ message, onClose }) => {
  React.useEffect(() => { const t = setTimeout(onClose, 4000); return () => clearTimeout(t); }, [onClose]);
  return (
    <div style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', zIndex: 9999 }}>
      <div style={{ background: '#f0fdf4', border: '1.5px solid #b7e4cc', borderRadius: 18, padding: '24px 28px', minWidth: 220, maxWidth: 300, textAlign: 'center', position: 'relative' }}>
        <button onClick={onClose} style={{ position: 'absolute', top: 10, right: 10, background: 'rgba(21,87,36,0.1)', border: 'none', color: '#155724', borderRadius: '50%', width: 26, height: 26, cursor: 'pointer', fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>✕</button>
        <div style={{ width: 60, height: 60, borderRadius: '50%', background: '#d4edda', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 12px' }}>
          <span style={{ fontSize: 26, color: '#28a745' }}>✓</span>
        </div>
        <div style={{ fontSize: 15, fontWeight: 500, color: '#155724' }}>{message}</div>
      </div>
    </div>
  );
};

interface PendingRequest {
  id: string;
  user_id: string;
  item_name: string;
  quantity: number | null;
  amount: number;
  requested_purchase_date: string | null;
  store_name: string | null;
  purpose: string | null;
  reason: string | null;
  notes: string | null;
  quotes: { vendor: string; amount: number; note?: string }[] | null;
  quote_file_path: string | null;
  created_at: string;
  route: Route;
  requested_manager_ids: string[] | null;
  board_approver_ids: string[] | null;
  approval_round: number;
  items_subtotal: number | null;
  amount_diff_reason: string | null;
  amount_diff_flag: boolean | null;
  location: string | null;
}

interface OpinionRow {
  purchase_request_id: string;
  manager_id: string;
  opinion: OpinionValue;
  comment: string | null;
  visible_to_applicant: boolean;
  approval_round: number;
}

interface Props {
  userId: string;
}

const SELECT_COLUMNS = 'id, user_id, item_name, quantity, amount, requested_purchase_date, store_name, purpose, reason, notes, quotes, quote_file_path, created_at, requested_manager_ids, board_approver_ids, approval_round, items_subtotal, amount_diff_reason, amount_diff_flag, location';

const PurchaseApprovals: React.FC<Props> = ({ userId }) => {
  const isDarkMode = useDarkMode();
  const [requests, setRequests] = useState<PendingRequest[]>([]);
  // 通知バナーから ?focus=<申請ID> で来たとき該当カードを強調
  const { highlightId, focusRef } = useFocusHighlight(requests);
  const [names, setNames] = useState<Record<string, string>>({});
  const [roles, setRoles] = useState<Record<string, string>>({});
  const [comments, setComments] = useState<Record<string, PurchaseComment[]>>({});
  const [opinions, setOpinions] = useState<Record<string, OpinionRow[]>>({});
  const [loading, setLoading] = useState(true);
  const [returningId, setReturningId] = useState<string | null>(null);
  const [returnReason, setReturnReason] = useState('');
  const [processingId, setProcessingId] = useState<string | null>(null);
  const [editingIds, setEditingIds] = useState<Set<string>>(new Set());
  const [drafts, setDrafts] = useState<Record<string, { opinion: OpinionValue | ''; comment: string; visibleToApplicant: boolean }>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [allApprovedBanner, setAllApprovedBanner] = useState<string | null>(null);
  // 承認時のひとこと（任意）。差し戻し理由と違い必須ではない
  const [approvalComments, setApprovalComments] = useState<Record<string, string>>({});
  const [itemsByRequest, setItemsByRequest] = useState<Record<string, PurchaseRequestItem[]>>({});

  const cardBg = isDarkMode ? '#343a40' : '#ffffff';
  const border = isDarkMode ? '#495057' : '#e0e0e0';
  const text = isDarkMode ? '#eeeeee' : '#222222';
  const subText = isDarkMode ? '#aaaaaa' : '#666666';
  const inputBg = isDarkMode ? '#495057' : '#f8f9fa';
  const warnBg = isDarkMode ? '#3a3220' : '#fff8e1';
  const warnBorder = isDarkMode ? '#5c5430' : '#ffe082';
  const warnText = isDarkMode ? '#ffe082' : '#8a6d00';

  const load = useCallback(async () => {
    setLoading(true);
    // リーダー承認待ち・マネージャー承認待ち・全員承認待ちは別々にクエリしてマージする
    // （配列列と単数列が混在するため.or()で無理に一本化せず可読性を優先）
    const [leaderRes, managerRes, boardRes] = await Promise.all([
      supabase.from('purchase_requests').select(SELECT_COLUMNS).eq('leader_id', userId).eq('status', 'pending_leader'),
      supabase.from('purchase_requests').select(SELECT_COLUMNS).contains('requested_manager_ids', [userId]).eq('status', 'pending_manager'),
      supabase.from('purchase_requests').select(SELECT_COLUMNS).contains('board_approver_ids', [userId]).eq('status', 'pending_board'),
    ]);
    const rows: PendingRequest[] = [
      ...((leaderRes.data ?? []) as Omit<PendingRequest, 'route'>[]).map(r => ({ ...r, route: 'leader' as const })),
      ...((managerRes.data ?? []) as Omit<PendingRequest, 'route'>[]).map(r => ({ ...r, route: 'manager' as const })),
      ...((boardRes.data ?? []) as Omit<PendingRequest, 'route'>[]).map(r => ({ ...r, route: 'board' as const })),
    ].sort((a, b) => a.created_at.localeCompare(b.created_at));
    setRequests(rows);

    // 明細（複数商品）と商品ごとの相見積もりをまとめて取得し、request_idごとにグルーピングする
    const requestIds = rows.map(r => r.id);
    if (requestIds.length > 0) {
      const { data: itemRows } = await supabase
        .from('purchase_request_items')
        .select('id, purchase_request_id, sort_order, item_name, quantity, amount, amount_manually_overridden, store_name, single_vendor_reason, breakdown, amount_override_note')
        .in('purchase_request_id', requestIds);
      const items = (itemRows ?? []) as (PurchaseRequestItem & { purchase_request_id: string })[];

      const itemIds = items.map(it => it.id).filter((id): id is string => !!id);
      let quotes: (PurchaseRequestItemQuote & { purchase_request_item_id: string })[] = [];
      if (itemIds.length > 0) {
        const { data: quoteRows } = await supabase
          .from('purchase_request_item_quotes')
          .select('id, purchase_request_item_id, vendor, unit_amount, note, quote_file_path, is_selected, sort_order')
          .in('purchase_request_item_id', itemIds);
        quotes = (quoteRows ?? []) as (PurchaseRequestItemQuote & { purchase_request_item_id: string })[];
      }

      const grouped: Record<string, PurchaseRequestItem[]> = {};
      items
        .sort((a, b) => a.sort_order - b.sort_order)
        .forEach(it => {
          const itemQuotes = quotes
            .filter(q => q.purchase_request_item_id === it.id)
            .sort((a, b) => a.sort_order - b.sort_order)
            .map(({ purchase_request_item_id: _purchase_request_item_id, ...q }) => q);
          (grouped[it.purchase_request_id] ??= []).push({ ...it, quotes: itemQuotes });
        });
      setItemsByRequest(grouped);
    } else {
      setItemsByRequest({});
    }

    const opinionTargetIds = rows.filter(r => r.route === 'manager' || r.route === 'board').map(r => r.id);
    let opinionRows: OpinionRow[] = [];
    if (opinionTargetIds.length > 0) {
      const roundById: Record<string, number> = {};
      rows.forEach(r => { roundById[r.id] = r.approval_round; });
      const { data: ops } = await supabase
        .from('purchase_request_manager_opinions')
        .select('purchase_request_id, manager_id, opinion, comment, visible_to_applicant, approval_round')
        .in('purchase_request_id', opinionTargetIds);
      // 過去ラウンドの意見は「回答状況」に含めない。現在のapproval_roundの意見のみを対象にする
      opinionRows = ((ops ?? []) as OpinionRow[]).filter(o => o.approval_round === roundById[o.purchase_request_id]);
      const grouped: Record<string, OpinionRow[]> = {};
      opinionRows.forEach(o => { (grouped[o.purchase_request_id] ??= []).push(o); });
      setOpinions(grouped);

      // 自分の既存意見をドラフトに反映（編集可能にする）
      setDrafts(prev => {
        const next = { ...prev };
        for (const id of opinionTargetIds) {
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
    rows.forEach(r => (r.board_approver_ids ?? []).forEach(id => userIds.add(id)));
    opinionRows.forEach(o => userIds.add(o.manager_id));
    userIds.add(userId);   // 自分の名前（質問の投稿者名に使う）

    const cmts = await fetchPurchaseComments(rows.map(r => r.id));
    setComments(cmts);
    Object.values(cmts).forEach(list => list.forEach(c => userIds.add(c.author_id)));

    if (userIds.size > 0) {
      const { data: profs } = await supabase.from('profiles').select('id, name, role_title').in('id', [...userIds]);
      const map: Record<string, string> = {};
      const roleMap: Record<string, string> = {};
      (profs ?? []).forEach((p: { id: string; name: string; role_title: string | null }) => {
        map[p.id] = p.name;
        if (p.role_title) roleMap[p.id] = p.role_title;
      });
      setNames(map);
      setRoles(roleMap);
    }
    setLoading(false);
  }, [userId]);

  useEffect(() => { load(); }, [load]);

  // 通知文言用の品目名サマリー（複数商品の場合は「1件目（他N件）」形式にする）
  const itemNameSummary = (req: PendingRequest): string => {
    const resolvedItems = resolveItems(req, itemsByRequest[req.id] ?? []);
    const first = resolvedItems[0]?.item_name ?? req.item_name;
    return resolvedItems.length > 1 ? `${first}（他${resolvedItems.length - 1}件）` : first;
  };

  const handleApprove = async (req: PendingRequest) => {
    setProcessingId(req.id);
    const fromStatus = req.route === 'leader' ? 'pending_leader' : 'pending_manager';
    const errorMessage = await approvePurchaseRequestAction({
      id: req.id, route: req.route, fromStatus,
      applicantUserId: req.user_id, applicantName: names[req.user_id] ?? '',
      itemNameSummary: itemNameSummary(req), amount: req.amount,
      comment: approvalComments[req.id],
    });

    if (!errorMessage) {
      setApprovalComments(prev => { const next = { ...prev }; delete next[req.id]; return next; });
      setRequests(prev => prev.filter(r => r.id !== req.id));
      window.dispatchEvent(new CustomEvent('purchase-pending-changed'));
    } else {
      setErrors(prev => ({ ...prev, [req.id]: errorMessage }));
    }
    setProcessingId(null);
  };

  const handleReturn = async () => {
    if (!returningId || !returnReason.trim()) return;
    const req = requests.find(r => r.id === returningId);
    if (!req) return;

    setProcessingId(returningId);
    const fromStatus = req.route === 'leader' ? 'pending_leader' : req.route === 'manager' ? 'pending_manager' : 'pending_board';
    const errorMessage = await returnPurchaseRequestAction({
      id: req.id, route: req.route, fromStatus,
      applicantUserId: req.user_id, applicantName: names[req.user_id] ?? '',
      itemNameSummary: itemNameSummary(req), amount: req.amount, reason: returnReason.trim(),
    });

    if (!errorMessage) {
      setRequests(prev => prev.filter(r => r.id !== returningId));
      setReturningId(null);
      setReturnReason('');
      window.dispatchEvent(new CustomEvent('purchase-pending-changed'));
    } else {
      setErrors(prev => ({ ...prev, [returningId]: errorMessage }));
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
      approval_round: req.approval_round,
    }, { onConflict: 'purchase_request_id,manager_id,approval_round' });

    if (error) {
      setErrors(prev => ({ ...prev, [req.id]: '意見の送信に失敗しました: ' + error.message }));
      setProcessingId(null);
      return;
    }
    setErrors(prev => { const next = { ...prev }; delete next[req.id]; return next; });

    const { data: ops } = await supabase
      .from('purchase_request_manager_opinions')
      .select('purchase_request_id, manager_id, opinion, comment, visible_to_applicant, approval_round')
      .eq('purchase_request_id', req.id)
      .eq('approval_round', req.approval_round);
    const rows = (ops ?? []) as OpinionRow[];
    setOpinions(prev => ({ ...prev, [req.id]: rows }));

    const others = (req.requested_manager_ids ?? []).filter(id => id !== userId);
    const vars = { '回答者名': names[userId] ?? '', '品目名': itemNameSummary(req) };
    const allAnswered = rows.length >= (req.requested_manager_ids?.length ?? 0);
    const eventKey = allAnswered ? 'purchase_request:manager_opinions_ready' : 'purchase_request:manager_opinion_submitted';
    const tpl = await getNotificationTemplate(eventKey, 'site', vars);
    if (tpl && others.length > 0) {
      await Promise.all(others.map(id => insertNotification(id, tpl.template, tpl.subject || undefined, 'purchase_request:pending_approval', req.id)));
    }

    setProcessingId(null);
    setEditingIds(prev => { const next = new Set(prev); next.delete(req.id); return next; });
    window.dispatchEvent(new CustomEvent('purchase-pending-changed'));
  };

  // 全員承認ルート専用: submit_board_opinion RPCを呼び出す。
  // 全員が承認で揃った場合、RPCがtrueを返しDB側でboard_approvedへ自動確定される。
  // Phase3の既存submitOpinion（直接upsert）はboardルートでは使わない。
  const submitBoardOpinion = async (req: PendingRequest) => {
    const draft = drafts[req.id];
    if (!draft?.opinion) return;
    setProcessingId(req.id);

    const { data: allApproved, error } = await supabase.rpc('submit_board_opinion', {
      p_purchase_request_id: req.id,
      p_opinion: draft.opinion,
      p_comment: draft.comment.trim() || null,
      p_visible_to_applicant: draft.visibleToApplicant,
    });

    if (error) {
      setErrors(prev => ({ ...prev, [req.id]: '意見の送信に失敗しました: ' + error.message }));
      setProcessingId(null);
      return;
    }
    setErrors(prev => { const next = { ...prev }; delete next[req.id]; return next; });

    const { data: ops } = await supabase
      .from('purchase_request_manager_opinions')
      .select('purchase_request_id, manager_id, opinion, comment, visible_to_applicant, approval_round')
      .eq('purchase_request_id', req.id)
      .eq('approval_round', req.approval_round);
    const rows = (ops ?? []) as OpinionRow[];
    setOpinions(prev => ({ ...prev, [req.id]: rows }));

    const others = (req.board_approver_ids ?? []).filter(id => id !== userId);
    const vars = { '回答者名': names[userId] ?? '', '品目名': itemNameSummary(req) };

    if (allApproved) {
      setAllApprovedBanner('これで全員承認が完了しました');
      const tpl = await getNotificationTemplate('purchase_request:board_all_approved', 'site', vars);
      if (tpl) await insertNotification(req.user_id, tpl.template, tpl.subject || undefined, 'purchase_request', req.id, 'purchase_request:board_all_approved');
      sendPurchaseSlackForEvent('purchase_request:board_all_approved', 'board_all_approved', 'board', names[req.user_id] ?? '不明', itemNameSummary(req), req.amount).then(null, () => {});
      (async () => {
        const emailVars = { '申請者名': names[req.user_id] ?? '', '品目名': itemNameSummary(req), '金額': req.amount.toLocaleString() };
        const applicantEmail = await getUserEmail(req.user_id);
        if (applicantEmail) await dispatchEmail('purchase_request:board_all_approved', emailVars, { applicant: applicantEmail });
      })().then(null, () => {});
      setRequests(prev => prev.filter(r => r.id !== req.id));
    } else {
      const tpl = await getNotificationTemplate('purchase_request:board_opinion_submitted', 'site', vars);
      if (tpl && others.length > 0) {
        await Promise.all(others.map(id => insertNotification(id, tpl.template, tpl.subject || undefined, 'purchase_request:pending_approval', req.id)));
      }
      // 初めて否認が出た時点（1回のみ）で全員へ通知する
      const hasDenial = rows.some(o => o.opinion === 'deny');
      const isFirstDenial = draft.opinion === 'deny' && !rows.some(o => o.manager_id !== userId && o.opinion === 'deny');
      if (hasDenial && isFirstDenial) {
        const denialTpl = await getNotificationTemplate('purchase_request:board_denial_present', 'site', vars);
        if (denialTpl) {
          await Promise.all((req.board_approver_ids ?? []).map(id => insertNotification(id, denialTpl.template, denialTpl.subject || undefined, 'purchase_request:pending_approval', req.id)));
        }
      }
      setEditingIds(prev => { const next = new Set(prev); next.delete(req.id); return next; });
    }

    setProcessingId(null);
    window.dispatchEvent(new CustomEvent('purchase-pending-changed'));
  };

  if (loading) return <div style={{ padding: 20, textAlign: 'center', color: subText }}>読み込み中...</div>;
  if (requests.length === 0) return <div style={{ padding: 20, textAlign: 'center', color: subText }}>承認待ちの申請はありません</div>;

  const ROUTE_LABEL: Record<Route, string> = { leader: 'リーダー', manager: 'マネージャー', board: '全員承認' };
  const ROUTE_COLOR: Record<Route, string> = { leader: '#4a90d9', manager: '#8a5cd9', board: '#d98a4a' };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {allApprovedBanner && (
        <BoardAllApprovedBanner message={allApprovedBanner} onClose={() => setAllApprovedBanner(null)} />
      )}
      {requests.map(r => {
        const requestOpinions = opinions[r.id] ?? [];
        const requestedIds = r.route === 'board' ? (r.board_approver_ids ?? []) : (r.requested_manager_ids ?? []);
        const unanswered = requestedIds.filter(id => !requestOpinions.some(o => o.manager_id === id));
        const allAnswered = r.route === 'leader' || unanswered.length === 0;
        const hasDenial = requestOpinions.some(o => o.opinion === 'deny');
        const draft = drafts[r.id] ?? { opinion: '', comment: '', visibleToApplicant: false };
        const resolvedItems = resolveItems(r, itemsByRequest[r.id] ?? []);

        const isFocused = highlightId === r.id;
        return (
        <div key={r.id} ref={el => { if (el && isFocused) focusRef.current = el; }} style={{ background: isFocused ? (isDarkMode ? '#4a4423' : '#fff9c4') : cardBg, border: `1px solid ${isFocused ? '#f0c000' : border}`, borderRadius: 10, padding: 14, transition: 'background 0.6s, border-color 0.6s' }}>
          {r.amount_diff_flag && (
            <div style={{ marginBottom: 10, padding: '8px 10px', background: warnBg, border: `1px solid ${warnBorder}`, borderRadius: 8, fontSize: 12, color: warnText }}>
              ⚠️ 明細合計（¥{(r.items_subtotal ?? 0).toLocaleString()}）と申請金額（¥{r.amount.toLocaleString()}）に差があります
              {r.amount_diff_reason && `：理由「${r.amount_diff_reason}」`}
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6, gap: 8 }}>
            <span style={{ fontSize: 15, fontWeight: 'bold', color: text }}>{r.item_name}</span>
            <span style={{ fontSize: 15, fontWeight: 'bold', color: text, whiteSpace: 'nowrap' }}>¥{r.amount.toLocaleString()}</span>
          </div>
          <div style={{ fontSize: 12, color: subText, display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 6 }}>
            <span style={{ color: '#fff', background: ROUTE_COLOR[r.route], borderRadius: 4, padding: '1px 6px' }}>
              あなたの承認が必要（{ROUTE_LABEL[r.route]}）
            </span>
            <span>👤 {names[r.user_id] ?? '不明'}</span>
            {r.requested_purchase_date && <span>📅 購入予定：{r.requested_purchase_date}</span>}
            {r.quantity != null && <span>数量：{r.quantity}</span>}
          </div>
          {r.reason && (
            <div style={{ marginBottom: 8, padding: '8px 10px', background: isDarkMode ? '#20304a' : '#eef6ff', border: `1px solid ${isDarkMode ? '#2e4a70' : '#cfe4ff'}`, borderRadius: 8, fontSize: 13, color: text }}>
              <span style={{ fontWeight: 'bold' }}>申請理由：</span>{r.reason}
            </div>
          )}
          {(r.store_name || r.purpose || r.location) && (
            <div style={{ fontSize: 12, color: subText, marginBottom: 6 }}>
              {r.store_name && <span>購入先：{r.store_name}　</span>}
              {r.purpose && <span>用途：{r.purpose}　</span>}
              {r.location && <span>使用先：{r.location}</span>}
            </div>
          )}
          {r.notes && <div style={{ fontSize: 12, color: subText, marginBottom: 8 }}>備考：{r.notes}</div>}
          <div style={{ marginBottom: 8 }}>
            <PurchaseItemsSummary items={resolvedItems} isDarkMode={isDarkMode} canViewFile />
          </div>

          {(r.route === 'manager' || r.route === 'board') && (
            <div style={{ marginBottom: 10, padding: '10px 12px', background: isDarkMode ? '#20304a' : '#eef6ff', border: `1px solid ${isDarkMode ? '#2e4a70' : '#cfe4ff'}`, borderRadius: 8 }}>
              <div style={{ fontSize: 12, fontWeight: 'bold', color: text, marginBottom: 6 }}>
                {r.route === 'board' ? `${requestedIds.length}名中${requestOpinions.length}名回答済み` : `依頼された${requestedIds.length}名の意見`}
              </div>
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

              {(() => {
                const myOpinion = requestOpinions.find(o => o.manager_id === userId);
                const isEditing = editingIds.has(r.id);
                const isLocked = !!myOpinion && !isEditing;
                return (
                  <>
                    {isLocked && (
                      <div style={{ marginBottom: 8, padding: '6px 8px', background: isDarkMode ? '#1f3a24' : '#eaf7ee', border: '1px solid #28a745', borderRadius: 6, fontSize: 12, color: text, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <span>✅ 送信しました：{OPINION_LABEL[myOpinion!.opinion]}{myOpinion!.comment ? `（${myOpinion!.comment}）` : ''}</span>
                        <button
                          type="button"
                          onClick={() => setEditingIds(prev => new Set(prev).add(r.id))}
                          style={{ marginLeft: 'auto', background: 'none', border: '1px solid #28a745', color: '#28a745', borderRadius: 6, padding: '2px 10px', fontSize: 12, cursor: 'pointer' }}
                        >
                          ✏️ 修正する
                        </button>
                      </div>
                    )}
                    {/* 「聞いてから決める」順になるよう、意見より前に質問を置く */}
                    <PurchaseCommentThread
                      requestId={r.id} itemName={r.item_name}
                      comments={comments[r.id] ?? []} names={names} roles={roles}
                      currentUserId={userId} currentUserName={names[userId] ?? ''}
                      isDark={isDarkMode} defaultOpen onPosted={load}
                    />
                    <div style={{ fontSize: 12, fontWeight: 'bold', color: text, margin: '10px 0 6px' }}>承認の意見（記録に残ります）</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8, opacity: isLocked ? 0.6 : 1 }}>
                      {OPINION_OPTIONS.map(opt => (
                        <label key={opt} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: text, cursor: isLocked ? 'default' : 'pointer' }}>
                          <input
                            type="radio" checked={draft.opinion === opt} disabled={isLocked}
                            onChange={() => setDrafts(prev => ({ ...prev, [r.id]: { ...draft, opinion: opt } }))}
                          />
                          {OPINION_LABEL[opt]}
                        </label>
                      ))}
                    </div>
                    <textarea
                      value={draft.comment} disabled={isLocked}
                      onChange={e => setDrafts(prev => ({ ...prev, [r.id]: { ...draft, comment: e.target.value } }))}
                      placeholder="コメント（任意）" rows={2}
                      style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 8, border: `1px solid ${border}`, background: isLocked ? border : inputBg, color: text, fontSize: 12, resize: 'vertical' as const, marginBottom: 8, opacity: isLocked ? 0.6 : 1 }}
                    />
                    {/* このチェックが効くのは「マネージャー未満の申請者」に対してだけ。
                        マネージャー以上の申請者にはRLSで常に全件（名前・承認/否認・コメント）が見える。
                        マネージャー未満の申請者は、チェックが無ければ回答した人数しか分からない。
                        文言を具体的に書かないと「外せば誰にも見えない」と誤解される */}
                    <label style={{ display: 'flex', alignItems: 'flex-start', gap: 6, fontSize: 12, color: subText, marginBottom: 8, cursor: isLocked ? 'default' : 'pointer', opacity: isLocked ? 0.6 : 1 }}>
                      <input
                        type="checkbox" checked={draft.visibleToApplicant} disabled={isLocked}
                        onChange={e => setDrafts(prev => ({ ...prev, [r.id]: { ...draft, visibleToApplicant: e.target.checked } }))}
                        style={{ marginTop: 2, flexShrink: 0 }}
                      />
                      <span>
                        この意見をマネージャー以外の申請者にも共有する
                        <span style={{ display: 'block', fontSize: 11, opacity: 0.85 }}>
                          申請者がマネージャー以上の場合は、チェックの有無に関係なく共有されます。
                          外すと、マネージャー以外の申請者には回答した人数だけが伝わります。
                        </span>
                      </span>
                    </label>
                    {!isLocked && (
                      <button
                        type="button"
                        onClick={() => (r.route === 'board' ? submitBoardOpinion(r) : submitOpinion(r))}
                        disabled={!draft.opinion || processingId === r.id}
                        style={{ width: '100%', padding: '8px', borderRadius: 8, border: 'none', background: draft.opinion ? '#4a90d9' : subText, color: '#fff', fontSize: 13, fontWeight: 'bold', cursor: draft.opinion ? 'pointer' : 'default' }}
                      >
                        {processingId === r.id ? '送信中...' : isEditing ? '変更を送信' : '意見を送信'}
                      </button>
                    )}
                  </>
                );
              })()}
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

          {r.route === 'board' && !allAnswered && (
            <div style={{ marginBottom: 10, padding: '8px 10px', background: warnBg, border: `1px solid ${warnBorder}`, borderRadius: 8, fontSize: 12, color: warnText }}>
              あと{unanswered.length}名（{unanswered.map(id => names[id] ?? '不明').join('・')}）の回答待ちです。全員が承認すると自動で確定します。
            </div>
          )}
          {r.route === 'board' && allAnswered && hasDenial && (
            <div style={{ marginBottom: 10, padding: '8px 10px', background: '#fff5f5', border: '1px solid #f5c2c7', borderRadius: 8, fontSize: 12, color: '#842029' }}>
              否認意見があります。差し戻すか、話し合いのうえで判断してください。
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
          ) : r.route === 'board' ? (
            // 全員承認ルートは全員が承認で揃うと自動確定するため、手動の承認ボタンは出さない。
            // 否認が混ざっている場合のみ差し戻すボタンを活性化する
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button" onClick={() => setReturningId(r.id)} disabled={!allAnswered || !hasDenial}
                style={{ flex: 1, padding: '10px', borderRadius: 8, border: `1px solid ${border}`, background: 'transparent', color: (allAnswered && hasDenial) ? text : subText, fontSize: 13, cursor: (allAnswered && hasDenial) ? 'pointer' : 'default' }}
              >
                最終決定：差し戻す
              </button>
            </div>
          ) : (
            <>
            {/* 承認時のひとこと（任意）。差し戻しには理由があるのに承認には何も残せなかったため追加 */}
            <div style={{ marginBottom: 8 }}>
              <label style={{ fontSize: 12, color: subText, display: 'block', marginBottom: 4 }}>
                承認するときのひとこと（任意・申請者にも見えます）
              </label>
              <textarea
                value={approvalComments[r.id] ?? ''} rows={2}
                onChange={e => setApprovalComments(prev => ({ ...prev, [r.id]: e.target.value }))}
                placeholder="例：今回は認めます。次回は事前にご相談ください。"
                style={{ width: '100%', boxSizing: 'border-box', padding: '6px 8px', borderRadius: 6, border: `1px solid ${border}`, background: isDarkMode ? '#495057' : '#fff', color: text, fontSize: 13, resize: 'vertical' }}
              />
            </div>
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
            </>
          )}
        </div>
        );
      })}
    </div>
  );
};

export default PurchaseApprovals;

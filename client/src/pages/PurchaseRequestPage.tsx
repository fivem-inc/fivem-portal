import React, { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { AuthUser, PurchaseRequestItem, PurchaseRequestItemQuote } from '../types';
import { supabase } from '../lib/supabaseClient';
import { useDarkMode } from '../hooks/useDarkMode';
import { useFocusHighlight } from '../hooks/useFocusHighlight';
import { usePurchasePendingCount } from '../hooks/usePurchasePendingCount';
import ReimbursementForm from '../components/ReimbursementForm';
import PurchaseRequestForm, { type ResubmitRecord } from '../components/PurchaseRequestForm';
import PurchaseApprovals from '../components/PurchaseApprovals';
import { resolveItems } from '../lib/purchaseItemsFallback';
import PurchaseItemsSummary from '../components/PurchaseItemsSummary';
import { paymentMethodLabel } from '../utils';
import ReceiptViewButton from '../components/ReceiptViewButton';
import { openReceiptImage } from '../lib/receiptView';

interface PurchaseRequestPageProps {
  user: AuthUser;
  roleTitle: string;
  isAdmin: boolean;
}

interface PurchaseRecord {
  id: string;
  user_id: string;
  request_type: 'reimbursement' | 'purchase_request';
  status: 'recorded' | 'pending_leader' | 'leader_approved' | 'pending_manager' | 'manager_approved' | 'self_judgment_shared' | 'pending_board' | 'board_approved' | 'returned';
  item_name: string;
  quantity: number | null;
  amount: number;
  purchased_at: string | null;
  requested_purchase_date: string | null;
  store_name: string | null;
  purpose: string | null;
  reason: string | null;
  instructed_by: string | null;
  payment_method: 'cash' | 'company_paid' | null;
  payment_method_detail: 'company_card' | 'bank_transfer' | 'cash_on_delivery' | 'other' | null;
  payment_method_other: string | null;
  receipt_type: 'photo' | 'physical' | 'none' | null;
  receipt_missing_reason: string | null;
  receipt_storage_path: string | null;
  returned_reason: string | null;
  approval_comment: string | null;
  leader_id: string | null;
  requested_manager_ids: string[] | null;
  shared_manager_ids: string[] | null;
  is_self_judgment: boolean;
  president_self_judgment: boolean;
  board_approver_ids: string[] | null;
  notes: string | null;
  quotes: { vendor: string; amount: number }[] | null;
  quote_file_path: string | null;
  created_at: string;
  approval_round: number;
  items_subtotal: number | null;
  amount_diff_reason: string | null;
  amount_diff_flag: boolean | null;
  location: string | null;
}

const RECEIPT_LABEL: Record<string, string> = { photo: '写真あり', physical: '直接提出', none: 'なし' };
const STATUS_LABEL: Record<string, { label: string; color: string }> = {
  recorded:             { label: '精算記録', color: '#6c757d' },
  pending_leader:       { label: '承認待ち（リーダー）', color: '#e0a800' },
  leader_approved:      { label: '承認済み', color: '#28a745' },
  pending_manager:      { label: '承認待ち（マネージャー）', color: '#e0a800' },
  manager_approved:     { label: '承認済み', color: '#28a745' },
  self_judgment_shared: { label: '共有済み（自己判断）', color: '#6c757d' },
  pending_board:        { label: '承認待ち（全員承認）', color: '#e0a800' },
  board_approved:       { label: '承認済み（全員承認）', color: '#28a745' },
  returned:             { label: '差し戻し', color: '#dc3545' },
};

interface OpinionRow { purchase_request_id: string; manager_id: string; opinion: 'approve' | 'deny' | 'undecided' | 'other'; comment: string | null; approval_round: number }
const OPINION_LABEL: Record<string, string> = { approve: '承認', deny: '否認', undecided: '判断できない', other: 'その他' };

const HistoryList: React.FC<{ isDarkMode: boolean; isManagerPlus: boolean; isAdmin: boolean; userId: string; onResubmit: (record: ResubmitRecord) => void }> = ({ isDarkMode, isManagerPlus, isAdmin, userId, onResubmit }) => {
  const [records, setRecords] = useState<PurchaseRecord[]>([]);
  // 通知バナーから ?focus=<申請ID> で来たとき履歴の該当カードを強調
  const { highlightId, focusRef } = useFocusHighlight(records);
  const [names, setNames] = useState<Record<string, string>>({});
  const [opinions, setOpinions] = useState<Record<string, OpinionRow[]>>({});
  // answers は「誰がどう答えたか」（コメントは含まない）。名前を見せてよい相手でなければ
  // pendingIds・answers はDB関数側で空配列にされ、件数だけが返る
  const [boardProgress, setBoardProgress] = useState<Record<string, {
    answered: number; required: number; pendingIds: string[];
    answers: { manager_id: string; opinion: string }[];
  }>>({});
  const [loading, setLoading] = useState(true);
  const [itemsByRequest, setItemsByRequest] = useState<Record<string, PurchaseRequestItem[]>>({});

  const cardBg = isDarkMode ? '#343a40' : '#ffffff';
  const border = isDarkMode ? '#495057' : '#e0e0e0';
  const text = isDarkMode ? '#eeeeee' : '#222222';
  const subText = isDarkMode ? '#aaaaaa' : '#666666';
  const warnBg = isDarkMode ? '#3a3220' : '#fff8e1';
  const warnBorder = isDarkMode ? '#5c5430' : '#ffe082';
  const warnText = isDarkMode ? '#ffe082' : '#8a6d00';

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from('purchase_requests')
      .select('id, user_id, request_type, status, item_name, quantity, amount, purchased_at, requested_purchase_date, store_name, purpose, reason, instructed_by, payment_method, payment_method_detail, payment_method_other, receipt_type, receipt_missing_reason, receipt_storage_path, returned_reason, approval_comment, leader_id, requested_manager_ids, shared_manager_ids, is_self_judgment, president_self_judgment, board_approver_ids, notes, quotes, quote_file_path, created_at, approval_round, items_subtotal, amount_diff_reason, amount_diff_flag, location')
      .order('created_at', { ascending: false });
    const rows = (data ?? []) as PurchaseRecord[];
    setRecords(rows);

    // 明細（複数商品）と商品ごとの相見積もりをまとめて取得し、request_idごとにグルーピングする
    const requestIds = rows.map(r => r.id);
    if (requestIds.length > 0) {
      const { data: itemRows } = await supabase
        .from('purchase_request_items')
        .select('id, purchase_request_id, sort_order, item_name, quantity, amount, amount_manually_overridden, store_name, single_vendor_reason, breakdown')
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

    const namesToFetch = new Set<string>();
    if (isManagerPlus) rows.forEach(r => namesToFetch.add(r.user_id));

    // 自分の申請だけでなく、履歴に出ているすべての申請の進み具合・意見を取りに行く。
    // 承認する人は「誰がもう答えたか」を過去の申請も含めて見られないと判断できない
    // （以前は自分の申請だけだったため、他人の申請では進捗が何も出ていなかった）。
    // 実際に何を返すかはDB側で決まる：RLSと集計関数が「申請者・その申請の承認者・
    // マネージャー以上・管理者」以外には返さない＝ここを広げても見えてよい範囲は変わらない
    const managerRouteIds = rows.filter(r => r.requested_manager_ids?.length).map(r => r.id);
    const boardRouteIds = rows.filter(r => r.board_approver_ids?.length).map(r => r.id);
    const opinionTargetIds = [...new Set([...managerRouteIds, ...boardRouteIds])];
    if (opinionTargetIds.length > 0) {
      const { data: ops } = await supabase
        .from('purchase_request_manager_opinions')
        .select('purchase_request_id, manager_id, opinion, comment, approval_round')
        .in('purchase_request_id', opinionTargetIds);
      const roundById: Record<string, number> = {};
      rows.forEach(r => { roundById[r.id] = r.approval_round; });
      const grouped: Record<string, OpinionRow[]> = {};
      // 過去ラウンドの意見は今回は表示しない。対象purchase_requestの現在のapproval_roundと
      // 一致する意見のみを「現在の意見」として扱う
      (ops ?? []).forEach((o: OpinionRow) => {
        if (o.approval_round !== roundById[o.purchase_request_id]) return;
        (grouped[o.purchase_request_id] ??= []).push(o);
        namesToFetch.add(o.manager_id);
      });
      setOpinions(grouped);

      // 進捗は grouped（=自分が読める意見）から数えてはいけない。RLSにより申請者には
      // 「共有する」を選んだ意見しか返らないため、4名回答済みでも1名と表示されてしまう。
      // 正しい件数と未回答者は集計用のDB関数（SECURITY DEFINER）から取得する
      if (boardRouteIds.length > 0) {
        const { data: prog, error: progError } = await supabase
          .rpc('purchase_request_approval_progress', { p_ids: boardRouteIds });
        if (progError) {
          console.error('[purchase] 承認の進み具合の取得に失敗', progError);
        } else {
          const progress: Record<string, { answered: number; required: number; pendingIds: string[]; answers: { manager_id: string; opinion: string }[] }> = {};
          (prog ?? []).forEach((p: { purchase_request_id: string; answered: number; required: number; pending_ids: string[] | null; answers: { manager_id: string; opinion: string }[] | null }) => {
            const pendingIds = p.pending_ids ?? [];
            const answers = p.answers ?? [];
            progress[p.purchase_request_id] = { answered: p.answered, required: p.required, pendingIds, answers };
            pendingIds.forEach(id => namesToFetch.add(id));
            answers.forEach(x => namesToFetch.add(x.manager_id));
          });
          setBoardProgress(progress);
        }
      }
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
          <div style={{ fontSize: 12, color: subText, display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 4 }}>
            <span style={{ color: '#fff', background: r.request_type === 'reimbursement' ? '#6c757d' : '#4a90d9', borderRadius: 4, padding: '1px 6px' }}>
              {r.request_type === 'reimbursement' ? '精算' : '申請'}
            </span>
            {statusInfo && r.request_type === 'purchase_request' && (
              <span style={{ color: '#fff', background: statusInfo.color, borderRadius: 4, padding: '1px 6px' }}>{statusInfo.label}</span>
            )}
            <span>📅 {r.purchased_at ?? r.requested_purchase_date}</span>
            {r.payment_method && r.request_type === 'reimbursement' && <span>💳 {paymentMethodLabel(r)}</span>}
            {r.receipt_type && <span>🧾 {RECEIPT_LABEL[r.receipt_type]}</span>}
            {isManagerPlus && r.user_id !== userId && <span>👤 {names[r.user_id] ?? '不明'}</span>}
          </div>
          {(r.store_name || r.purpose || r.instructed_by || r.location) && (
            <div style={{ fontSize: 12, color: subText, marginTop: 4 }}>
              {r.store_name && <span>購入先：{r.store_name}　</span>}
              {r.purpose && <span>用途：{r.purpose}　</span>}
              {r.instructed_by && <span>指示者：{r.instructed_by}　</span>}
              {r.location && <span>使用先：{r.location}</span>}
            </div>
          )}
          {r.reason && <div style={{ fontSize: 12, color: subText, marginTop: 4 }}>申請理由：{r.reason}</div>}
          {r.receipt_type === 'none' && r.receipt_missing_reason && (
            <div style={{ fontSize: 12, color: subText, marginTop: 4 }}>レシートなし理由：{r.receipt_missing_reason}</div>
          )}
          {r.notes && <div style={{ fontSize: 12, color: subText, marginTop: 4 }}>備考：{r.notes}</div>}
          <div style={{ marginTop: 8 }}>
            <PurchaseItemsSummary items={resolvedItems} isDarkMode={isDarkMode} onViewFile={path => { openReceiptImage(path, false); }} />
          </div>
          {r.receipt_type === 'photo' && r.receipt_storage_path && (r.user_id === userId || isAdmin) && (
            <ReceiptViewButton path={r.receipt_storage_path} isDarkMode={isDarkMode} canDownload={isAdmin} />
          )}
          {opinions[r.id] && opinions[r.id].length > 0 && (
            <div style={{ fontSize: 12, color: subText, marginTop: 6, padding: '6px 8px', background: isDarkMode ? '#20304a' : '#eef6ff', borderRadius: 6 }}>
              共有された意見：{opinions[r.id].map(o => `${names[o.manager_id] ?? '不明'}（${OPINION_LABEL[o.opinion]}${o.comment ? '：' + o.comment : ''}）`).join('　')}
            </div>
          )}
          {/* 全員承認ルートの進み具合。
              ・「全員の承認が必要」ではない（全員の回答がそろってから審議して決める）ので文言に注意
              ・名前を見せてよい相手（マネージャー以上の申請者・承認者・管理者）にだけ内訳を出す。
                それ以外は件数だけ（DB関数が名前を空で返すので、ここは受け取った内容をそのまま描くだけ） */}
          {(r.status === 'pending_board' || r.status === 'board_approved') && boardProgress[r.id] && (() => {
            const p = boardProgress[r.id];
            const remaining = Math.max(p.required - p.answered, 0);
            const canSeeNames = p.answers.length > 0 || p.pendingIds.length > 0;
            const nameList = (ids: string[]) => ids.map(id => names[id] ?? '不明').join('、');
            const idsOf = (...ops: string[]) => p.answers.filter(x => ops.includes(x.opinion)).map(x => x.manager_id);
            const approved = idsOf('approve');
            const denied = idsOf('deny');
            const held = idsOf('undecided', 'other');
            const rowStyle: React.CSSProperties = { fontSize: 12, color: subText, marginTop: 2, paddingLeft: 10 };
            return (
              <div style={{ fontSize: 12, color: subText, marginTop: 6 }}>
                {r.status === 'board_approved' ? (
                  <div>{p.required}名全員が承認しました</div>
                ) : remaining === 0 ? (
                  <div>全員の回答が揃いました。審議中です（{p.required}名中{p.answered}名回答済み）</div>
                ) : (
                  <div>
                    全員の回答がそろってから決定します：{p.required}名中{p.answered}名回答済み
                    {!canSeeNames && <>（残り{remaining}名）</>}
                  </div>
                )}
                {canSeeNames && (
                  <>
                    {approved.length > 0 && <div style={rowStyle}>承認（{approved.length}名）：{nameList(approved)}</div>}
                    {denied.length > 0 && <div style={rowStyle}>否認（{denied.length}名）：{nameList(denied)}</div>}
                    {held.length > 0 && <div style={rowStyle}>判断できない・その他（{held.length}名）：{nameList(held)}</div>}
                    {p.pendingIds.length > 0 && <div style={rowStyle}>未回答（{p.pendingIds.length}名）：{nameList(p.pendingIds)}</div>}
                  </>
                )}
              </div>
            );
          })()}
          {r.status === 'returned' && r.returned_reason && (
            <div style={{ fontSize: 12, color: '#dc3545', marginTop: 6 }}>差し戻し理由：{r.returned_reason}</div>
          )}
          {/* 承認時のひとこと（任意）。差し戻し理由と同じ場所に並べる */}
          {r.approval_comment && (
            <div style={{ fontSize: 12, color: subText, marginTop: 6, padding: '6px 8px', background: isDarkMode ? '#20304a' : '#eef6ff', borderRadius: 6 }}>
              承認時のひとこと：{r.approval_comment}
            </div>
          )}
          {r.status === 'returned' && r.user_id === userId && (
            <button
              type="button"
              onClick={() => onResubmit({
                id: r.id, item_name: r.item_name, quantity: r.quantity, amount: r.amount,
                requested_purchase_date: r.requested_purchase_date, store_name: r.store_name,
                purpose: r.purpose, reason: r.reason, notes: r.notes, leader_id: r.leader_id, returned_reason: r.returned_reason,
                requested_manager_ids: r.requested_manager_ids, shared_manager_ids: r.shared_manager_ids, is_self_judgment: r.is_self_judgment,
                president_self_judgment: r.president_self_judgment,
                quotes: r.quotes, quote_file_path: r.quote_file_path, approval_round: r.approval_round,
                items: resolveItems(r, itemsByRequest[r.id] ?? []),
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
  // 「✅ 承認」タブに出す件数バッジ（ナビバーの赤バッジと同じ数え方・同じ共通フック）
  const { pendingCount: purchasePending } = usePurchasePendingCount(user.id, canApprovePurchase);

  const cardBg = isDarkMode ? '#343a40' : '#ffffff';
  const border = isDarkMode ? '#495057' : '#e0e0e0';
  const text = isDarkMode ? '#eeeeee' : '#222222';

  const tabDefs: { key: Tab; label: string }[] = [
    { key: 'reimbursement', label: '💰 精算' },
    { key: 'request', label: '📝 申請' },
    { key: 'history', label: '📋 履歴' },
    ...(canApprovePurchase ? [{ key: 'approvals' as Tab, label: '✅ 承認' }] : []),
  ];

  return (
    <div style={{ minHeight: '100vh' }}>
      <div style={{ maxWidth: 600, margin: '0 auto', padding: '70px 16px 40px' }}>
      <div style={{ textAlign: 'center', padding: '28px 0 12px' }}>
        <h1 style={{ fontSize: 20, fontWeight: 'bold', color: text, margin: 0 }}>📦 備品精算</h1>
      </div>

      {/* このページの説明 */}
      <div style={{
        background: '#fff3cd',
        border: '1px solid #ffe0a3',
        borderRadius: 8, padding: '12px 14px', marginBottom: 14, textAlign: 'left',
      }}>
        <p style={{ fontSize: 13, fontWeight: 'bold', color: '#856404', textAlign: 'center', margin: '0 0 10px' }}>【全スタッフ】</p>
        {[
          '立て替えた備品の精算ができます',
          '備品購入の申請ができます',
        ].map((label, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, margin: '0 0 6px' }}>
            <span style={{ flexShrink: 0, width: 22, height: 22, borderRadius: '50%', background: '#4a90d9', color: '#fff', fontSize: 13, fontWeight: 'bold', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>{i + 1}</span>
            <span style={{ fontSize: 14, fontWeight: 'bold', color: '#664d03', lineHeight: '22px' }}>{label}</span>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', background: cardBg, border: `1px solid ${border}`, borderRadius: 10, overflow: 'hidden', marginBottom: 14 }}>
        {tabDefs.map(({ key, label }) => (
          <button
            key={key}
            type="button" onClick={() => { setResubmitRecord(null); setTab(key); }}
            style={{ position: 'relative', flex: 1, padding: '10px 4px', border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: tab === key ? 'bold' : 'normal', background: tab === key ? '#28a745' : 'transparent', color: tab === key ? '#fff' : text }}
          >
            {label}
            {/* 自分の回答・承認を待っている件数。ナビバーの赤バッジと同じ数え方（共通フック） */}
            {key === 'approvals' && purchasePending > 0 && (
              <span style={{
                position: 'absolute', top: 4, right: 4,
                minWidth: 16, height: 16, padding: '0 4px', borderRadius: 8,
                background: '#dc3545', color: '#fff', fontSize: 10, fontWeight: 'bold',
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1,
              }}>
                {purchasePending > 99 ? '99+' : purchasePending}
              </span>
            )}
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
          isDarkMode={isDarkMode} isManagerPlus={isManagerPlus} isAdmin={isAdmin} userId={user.id}
          onResubmit={record => { setResubmitRecord(record); setTab('request'); }}
        />
      )}
      {tab === 'approvals' && canApprovePurchase && <PurchaseApprovals userId={user.id} />}
      </div>
    </div>
  );
};

export default PurchaseRequestPage;

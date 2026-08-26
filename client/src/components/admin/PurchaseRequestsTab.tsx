import React, { useState, useEffect, useCallback } from 'react';
import { useAdminPanel } from './AdminPanelContext';
import { resolveItems } from '../../lib/purchaseItemsFallback';
import { supabase } from '../../lib/supabaseClient';
import { todayJstStr } from '../../lib/breakCalc';
import type { PurchaseRequestCSVRow } from '../../utils';
import { PAYMENT_DETAIL_LABEL } from '../../utils';
import { approvePurchaseRequestAction, returnPurchaseRequestAction, cancelReturnedPurchaseRequest, type PurchaseApprovalRoute } from '../../lib/purchaseApprovalActions';
import { downloadReceiptsAsZip } from '../../lib/purchaseReceiptBulkDownload';
import PurchaseItemsSummary from '../PurchaseItemsSummary';
import ReceiptViewButton from '../ReceiptViewButton';
import PurchaseCommentThread from '../PurchaseCommentThread';
import { fetchPurchaseComments, type PurchaseComment } from '../../lib/purchaseComments';
import SearchableSelect from '../common/SearchableSelect';
import PurchaseRequestEditModal from './PurchaseRequestEditModal';
import PurchaseRequestEditHistoryModal from './PurchaseRequestEditHistoryModal';
import PurchaseApproverEditModal from './PurchaseApproverEditModal';

interface OpinionRow { purchase_request_id: string; manager_id: string; opinion: 'approve' | 'deny' | 'undecided' | 'other'; comment: string | null; approval_round: number }
const OPINION_LABEL: Record<string, string> = { approve: '承認', deny: '否認', undecided: '判断できない', other: 'その他' };

const REQUEST_TYPE_FILTERS: { key: 'all' | 'purchase_request' | 'reimbursement'; label: string }[] = [
  { key: 'all', label: 'すべて' },
  { key: 'purchase_request', label: '申請' },
  { key: 'reimbursement', label: '精算' },
];
const STATUS_FILTERS: { key: string; label: string }[] = [
  { key: 'all', label: 'すべて' },
  { key: 'pending', label: '確認待ち' },
  { key: 'approved', label: '受理済み' },
  { key: 'returned', label: '差し戻し' },
  // 削除済みだけは別のテーブル（削除の控え）を読むので、一覧の中身ごと差し替わる
  { key: 'deleted', label: '削除済み' },
];
// 削除された申請・精算の控え（purchase_request_deletion_log）1件ぶん。
// 消える直前の中身が snapshot に丸ごと入っている
type DeletionLogRow = {
  id: string;
  purchase_request_id: string;
  request_type: string | null;
  applicant_id: string | null;
  amount: number | null;
  item_name: string | null;
  deleted_by: string | null;
  deleted_at: string;
  snapshot: { request?: Record<string, unknown>; items?: unknown[] } | null;
};

const PENDING_STATUSES = ['pending_leader', 'pending_manager', 'pending_board'];
const APPROVED_STATUSES = ['leader_approved', 'manager_approved', 'board_approved', 'self_judgment_shared', 'recorded'];

const routeForStatus = (status: string): PurchaseApprovalRoute | null => {
  if (status === 'pending_leader') return 'leader';
  if (status === 'pending_manager') return 'manager';
  if (status === 'pending_board') return 'board';
  return null;
};

const toFiscalYear = (dateStr: string) => {
  const d = new Date(dateStr);
  return d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
};
const nowFY = (() => { const n = new Date(); return n.getMonth() >= 3 ? n.getFullYear() : n.getFullYear() - 1; })();

const PurchaseRequestsTab: React.FC = () => {
  const ctx = useAdminPanel();
  const { isDarkMode } = ctx;
  const {
    purchaseCsvStartDate, setPurchaseCsvStartDate,
    purchaseCsvEndDate, setPurchaseCsvEndDate,
    purchaseCsvDateType, setPurchaseCsvDateType,
    handleExportPurchaseCsv, purchaseCsvError,
    purchaseRequestsList, purchaseRequestsListLoading, purchaseRequestNames,
    purchaseRequestLastDownload, purchaseRequestEditLogCounts, purchaseRequestRemovedApprovers, fetchPurchaseRequestsList,
  } = ctx;
  // 質問・回答（履歴・承認画面と同じ lib / 同じ部品を使う）
  const [comments, setComments] = useState<Record<string, PurchaseComment[]>>({});
  const [commentRoles, setCommentRoles] = useState<Record<string, string>>({});
  const [myId, setMyId] = useState('');
  const loadComments = useCallback(async () => {
    const ids = purchaseRequestsList.map(r => r.id);
    if (ids.length === 0) { setComments({}); return; }
    const cmts = await fetchPurchaseComments(ids);
    setComments(cmts);
    const authorIds = new Set<string>();
    Object.values(cmts).forEach(list => list.forEach(c => authorIds.add(c.author_id)));
    if (authorIds.size > 0) {
      const { data } = await supabase.from('profiles').select('id, role_title').in('id', [...authorIds]);
      const m: Record<string, string> = {};
      (data ?? []).forEach((p: { id: string; role_title: string | null }) => { if (p.role_title) m[p.id] = p.role_title; });
      setCommentRoles(m);
    }
  }, [purchaseRequestsList]);
  useEffect(() => { loadComments(); }, [loadComments]);
  useEffect(() => { supabase.auth.getUser().then(({ data }) => setMyId(data.user?.id ?? ''), () => {}); }, []);

  const [statusFilter, setStatusFilter] = useState('all');
  const [requestTypeFilter, setRequestTypeFilter] = useState<'all' | 'purchase_request' | 'reimbursement'>('all');
  const [fyFilter, setFyFilter] = useState('__current__');
  const [applicantFilter, setApplicantFilter] = useState('all');
  const [locationFilter, setLocationFilter] = useState('all');
  const [unreimbursedOnly, setUnreimbursedOnly] = useState(false);
  // 取引の中身で探す絞り込み（購入先・金額・購入日）。
  // 経理が「あの店にいくら払ったか」を後から追えるようにするためのもの。
  const [storeFilter, setStoreFilter] = useState('');
  const [amountMin, setAmountMin] = useState('');
  const [amountMax, setAmountMax] = useState('');
  const [purchasedFrom, setPurchasedFrom] = useState('');
  const [purchasedTo, setPurchasedTo] = useState('');

  // 削除済みの控え。めったに見ないので、タブを開いたときに1度だけ読み込む
  const [deletedRows, setDeletedRows] = useState<DeletionLogRow[]>([]);
  const [deletedNames, setDeletedNames] = useState<Record<string, string>>({});
  const [deletedLoading, setDeletedLoading] = useState(false);
  const [deletedError, setDeletedError] = useState('');
  const [deletedLoaded, setDeletedLoaded] = useState(false);

  const [editingRecord, setEditingRecord] = useState<PurchaseRequestCSVRow | null>(null);
  const [editingApproversRecord, setEditingApproversRecord] = useState<PurchaseRequestCSVRow | null>(null);
  const [historyRequestId, setHistoryRequestId] = useState<string | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');

  const [opinionsByRequest, setOpinionsByRequest] = useState<Record<string, OpinionRow[]>>({});
  const [processingId, setProcessingId] = useState<string | null>(null);
  const [returningId, setReturningId] = useState<string | null>(null);
  const [returnReason, setReturnReason] = useState('');
  // 承認時のひとこと（任意）。申請者にも見える
  const [approvalComments, setApprovalComments] = useState<Record<string, string>>({});
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({});

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkDownloading, setBulkDownloading] = useState(false);
  const [bulkDownloadError, setBulkDownloadError] = useState('');

  const [reimbursingId, setReimbursingId] = useState<string | null>(null);
  const [editingReimbursedId, setEditingReimbursedId] = useState<string | null>(null);
  const [reimbursedDraftDate, setReimbursedDraftDate] = useState('');

  const cardBg = isDarkMode ? '#2d2d3e' : '#ffffff';
  const border = isDarkMode ? '#3a3a5c' : '#e0e0e0';
  const text = isDarkMode ? '#eeeeee' : '#222222';
  const subText = isDarkMode ? '#aaaaaa' : '#666666';
  const warnBg = isDarkMode ? '#3a3220' : '#fff8e1';
  const warnBorder = isDarkMode ? '#5c5430' : '#ffe082';
  const warnText = isDarkMode ? '#ffe082' : '#8a6d00';

  // マネージャー/全員承認ルートの回答状況（badge表示・全員回答済み判定に必要）
  useEffect(() => {
    const targetIds = purchaseRequestsList
      .filter(r => r.status === 'pending_manager' || r.status === 'pending_board')
      .map(r => r.id);
    if (targetIds.length === 0) { setOpinionsByRequest({}); return; }
    (async () => {
      const { data } = await supabase
        .from('purchase_request_manager_opinions')
        .select('purchase_request_id, manager_id, opinion, comment, approval_round')
        .in('purchase_request_id', targetIds);
      const roundById: Record<string, number> = {};
      purchaseRequestsList.forEach(r => { roundById[r.id] = r.approval_round; });
      const grouped: Record<string, OpinionRow[]> = {};
      ((data ?? []) as OpinionRow[])
        .filter(o => o.approval_round === roundById[o.purchase_request_id])
        .forEach(o => { (grouped[o.purchase_request_id] ??= []).push(o); });
      setOpinionsByRequest(grouped);
    })();
  }, [purchaseRequestsList]);

  const handleDelete = async (id: string) => {
    setDeleting(true);
    setDeleteError('');
    const { error } = await supabase.from('purchase_requests').delete().eq('id', id);
    setDeleting(false);
    if (error) {
      setDeleteError('削除に失敗しました: ' + error.message);
      return;
    }
    setConfirmingDeleteId(null);
    fetchPurchaseRequestsList();
  };

  const startEditReimbursed = (r: PurchaseRequestCSVRow) => {
    setEditingReimbursedId(r.id);
    setReimbursedDraftDate(r.reimbursed_at ? r.reimbursed_at.slice(0, 10) : todayJstStr());
  };
  const cancelEditReimbursed = () => setEditingReimbursedId(null);

  const confirmReimbursed = useCallback(async (r: PurchaseRequestCSVRow) => {
    if (!reimbursedDraftDate) return;
    setReimbursingId(r.id);
    const { error } = await supabase.from('purchase_requests')
      .update({ reimbursed_at: new Date(`${reimbursedDraftDate}T00:00:00`).toISOString() })
      .eq('id', r.id);
    setReimbursingId(null);
    setEditingReimbursedId(null);
    if (!error) fetchPurchaseRequestsList();
  }, [reimbursedDraftDate, fetchPurchaseRequestsList]);

  const unmarkReimbursed = useCallback(async (r: PurchaseRequestCSVRow) => {
    setReimbursingId(r.id);
    const { error } = await supabase.from('purchase_requests').update({ reimbursed_at: null }).eq('id', r.id);
    setReimbursingId(null);
    setEditingReimbursedId(null);
    if (!error) fetchPurchaseRequestsList();
  }, [fetchPurchaseRequestsList]);

  const itemNameSummaryOf = (r: PurchaseRequestCSVRow) => {
    const resolvedItems = resolveItems(r, r.items ?? []);
    const first = resolvedItems[0]?.item_name ?? r.item_name;
    return resolvedItems.length > 1 ? `${first}（他${resolvedItems.length - 1}件）` : first;
  };

  const handleApprove = useCallback(async (r: PurchaseRequestCSVRow) => {
    const route = routeForStatus(r.status);
    if (!route || route === 'board') return;
    setProcessingId(r.id);
    const errorMessage = await approvePurchaseRequestAction({
      id: r.id, route, fromStatus: r.status,
      applicantUserId: r.user_id, applicantName: purchaseRequestNames[r.user_id] ?? '',
      itemNameSummary: itemNameSummaryOf(r), amount: r.amount,
      comment: approvalComments[r.id],
    });
    setProcessingId(null);
    if (errorMessage) {
      setActionErrors(prev => ({ ...prev, [r.id]: errorMessage }));
    } else {
      setActionErrors(prev => { const next = { ...prev }; delete next[r.id]; return next; });
      setApprovalComments(prev => { const next = { ...prev }; delete next[r.id]; return next; });
      fetchPurchaseRequestsList();
    }
  }, [purchaseRequestNames, fetchPurchaseRequestsList, approvalComments]);

  const handleReturnSubmit = useCallback(async (r: PurchaseRequestCSVRow) => {
    const route = routeForStatus(r.status);
    if (!route || !returnReason.trim()) return;
    setProcessingId(r.id);
    const errorMessage = await returnPurchaseRequestAction({
      id: r.id, route, fromStatus: r.status,
      applicantUserId: r.user_id, applicantName: purchaseRequestNames[r.user_id] ?? '',
      itemNameSummary: itemNameSummaryOf(r), amount: r.amount, reason: returnReason.trim(),
    });
    setProcessingId(null);
    if (errorMessage) {
      setActionErrors(prev => ({ ...prev, [r.id]: errorMessage }));
    } else {
      setActionErrors(prev => { const next = { ...prev }; delete next[r.id]; return next; });
      setReturningId(null);
      setReturnReason('');
      fetchPurchaseRequestsList();
    }
  }, [purchaseRequestNames, returnReason, fetchPurchaseRequestsList]);

  const handleCancelReturn = useCallback(async (r: PurchaseRequestCSVRow) => {
    setProcessingId(r.id);
    const errorMessage = await cancelReturnedPurchaseRequest({
      id: r.id, amount: r.amount, is_self_judgment: false,
      president_self_judgment: false, approval_round: r.approval_round,
    });
    setProcessingId(null);
    if (errorMessage) {
      setActionErrors(prev => ({ ...prev, [r.id]: errorMessage }));
    } else {
      setActionErrors(prev => { const next = { ...prev }; delete next[r.id]; return next; });
      fetchPurchaseRequestsList();
    }
  }, [fetchPurchaseRequestsList]);

  // 年度・申請者・使用先の選択肢
  const fyOptions = [...new Set(purchaseRequestsList.map(r => toFiscalYear(r.created_at)))].sort((a, b) => b - a);
  if (!fyOptions.includes(nowFY)) fyOptions.unshift(nowFY);
  const applicantOptions: [string, string][] = [...new Set(purchaseRequestsList.map(r => r.user_id))]
    .map(id => [id, purchaseRequestNames[id] ?? '不明'] as [string, string])
    .sort((a, b) => a[1].localeCompare(b[1], 'ja'));
  const locationOptions = [...new Set(purchaseRequestsList.map(r => r.location).filter((l): l is string => !!l))].sort((a, b) => a.localeCompare(b, 'ja'));

  const isIncomplete = (r: PurchaseRequestCSVRow) => PENDING_STATUSES.includes(r.status);

  // 削除済みタブを開いたときだけ、削除の控えを読み込む
  const isDeletedView = statusFilter === 'deleted';
  useEffect(() => {
    if (statusFilter !== 'deleted' || deletedLoaded) return;
    let cancelled = false;
    (async () => {
      setDeletedLoading(true);
      setDeletedError('');
      const { data, error } = await supabase
        .from('purchase_request_deletion_log')
        .select('id, purchase_request_id, request_type, applicant_id, amount, item_name, deleted_by, deleted_at, snapshot')
        .order('deleted_at', { ascending: false });
      if (cancelled) return;
      if (error) {
        setDeletedError('削除済みの記録を読み込めませんでした：' + error.message);
        setDeletedLoading(false);
        return;
      }
      const rows = (data ?? []) as DeletionLogRow[];
      setDeletedRows(rows);
      // 控えにはIDしか入っていないので、申請者と「削除した人」の名前を引く
      const ids = [...new Set(rows.flatMap(r => [r.applicant_id, r.deleted_by]).filter((v): v is string => !!v))];
      if (ids.length > 0) {
        const { data: profs } = await supabase.from('profiles').select('id, name').in('id', ids);
        if (!cancelled && profs) {
          setDeletedNames(Object.fromEntries((profs as { id: string; name: string | null }[]).map(p => [p.id, p.name ?? ''])));
        }
      }
      if (!cancelled) { setDeletedLoaded(true); setDeletedLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [statusFilter, deletedLoaded]);

  const storeQuery = storeFilter.trim().toLowerCase();
  const amountMinNum = amountMin.trim() === '' ? null : Number(amountMin);
  const amountMaxNum = amountMax.trim() === '' ? null : Number(amountMax);
  // 購入先は本体の列と商品明細の両方を見る（商品が複数あるときは明細側に入るため、
  // 片方だけ見ると「入力したのに出てこない」になる）
  const matchesStore = (r: (typeof purchaseRequestsList)[number]) => {
    if (!storeQuery) return true;
    if ((r.store_name || '').toLowerCase().includes(storeQuery)) return true;
    return resolveItems(r, r.items ?? []).some(it => (it.store_name || '').toLowerCase().includes(storeQuery));
  };

  const filteredList = purchaseRequestsList.filter(r => {
    if (requestTypeFilter !== 'all' && r.request_type !== requestTypeFilter) return false;
    if (statusFilter === 'pending' && !PENDING_STATUSES.includes(r.status)) return false;
    if (statusFilter === 'approved' && !APPROVED_STATUSES.includes(r.status)) return false;
    if (statusFilter === 'returned' && r.status !== 'returned') return false;
    if (applicantFilter !== 'all' && r.user_id !== applicantFilter) return false;
    if (locationFilter !== 'all' && r.location !== locationFilter) return false;
    if (unreimbursedOnly && !(r.payment_method === 'cash' && !r.reimbursed_at)) return false;
    // 🚨 購入先・金額・購入日は必ず isIncomplete より前で判定する。
    // 後ろに置くと「承認待ちだけ絞り込みを無視して出てくる」ことになる
    if (!matchesStore(r)) return false;
    if (amountMinNum !== null && !Number.isNaN(amountMinNum) && r.amount < amountMinNum) return false;
    if (amountMaxNum !== null && !Number.isNaN(amountMaxNum) && r.amount > amountMaxNum) return false;
    if (purchasedFrom || purchasedTo) {
      // 精算は購入日、申請は購入予定日。どちらも無い場合は日付で絞ったときの対象外にする
      const pdate = r.purchased_at || r.requested_purchase_date;
      if (!pdate) return false;
      if (purchasedFrom && pdate < purchasedFrom) return false;
      if (purchasedTo && pdate > purchasedTo) return false;
    }
    if (isIncomplete(r)) return true;
    const activeFY = fyFilter === '__current__' ? nowFY : (fyFilter === 'all' ? null : Number(fyFilter));
    if (activeFY !== null && toFiscalYear(r.created_at) !== activeFY) return false;
    return true;
  });

  const filtersAreDefault = statusFilter === 'all' && requestTypeFilter === 'all' && fyFilter === '__current__' && applicantFilter === 'all' && locationFilter === 'all' && !unreimbursedOnly
    && storeFilter.trim() === '' && amountMin.trim() === '' && amountMax.trim() === '' && purchasedFrom === '' && purchasedTo === '';
  const resetFilters = () => {
    setStatusFilter('all'); setRequestTypeFilter('all'); setFyFilter('__current__');
    setApplicantFilter('all'); setLocationFilter('all'); setUnreimbursedOnly(false);
    setStoreFilter(''); setAmountMin(''); setAmountMax(''); setPurchasedFrom(''); setPurchasedTo('');
  };

  const downloadableList = filteredList.filter(r => r.receipt_type === 'photo' && r.receipt_storage_path);
  const selectedDownloadableCount = downloadableList.filter(r => selectedIds.has(r.id)).length;
  const selectedNonDownloadableCount = selectedIds.size - selectedDownloadableCount;

  const toggleSelectAll = (checked: boolean) => {
    setSelectedIds(checked ? new Set(filteredList.map(r => r.id)) : new Set());
  };
  const toggleSelectOne = (id: string, checked: boolean) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (checked) next.add(id); else next.delete(id);
      return next;
    });
  };

  const handleBulkDownload = async () => {
    const paths = filteredList
      .filter(r => selectedIds.has(r.id) && r.receipt_type === 'photo' && r.receipt_storage_path)
      .map(r => r.receipt_storage_path as string);
    if (paths.length === 0) { setBulkDownloadError('画像のある申請が選択されていません。'); return; }
    setBulkDownloading(true);
    setBulkDownloadError('');
    const errorMessage = await downloadReceiptsAsZip(paths);
    setBulkDownloading(false);
    if (errorMessage) {
      setBulkDownloadError(errorMessage);
    } else {
      fetchPurchaseRequestsList();
    }
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, margin: '0 0 14px' }}>
        <h3 style={{ margin: 0, fontSize: 16, color: isDarkMode ? '#fff' : '#000' }}>🧾 購入申請</h3>
        <button
          type="button"
          onClick={() => fetchPurchaseRequestsList()}
          disabled={purchaseRequestsListLoading}
          style={{ padding: '3px 8px', borderRadius: 6, fontSize: 11, border: `1px solid ${border}`, background: 'transparent', color: text, cursor: purchaseRequestsListLoading ? 'default' : 'pointer' }}
        >
          🔄 更新
        </button>
      </div>

      {purchaseCsvError && (
        <div style={{ maxWidth: 500, margin: '0 auto 12px', padding: '8px 10px', background: '#fff5f5', border: '1px solid #f5c2c7', borderRadius: 8, color: '#842029', fontSize: 12 }}>
          {purchaseCsvError}
        </div>
      )}

      {/* CSV出力セクション */}
      <div style={{ textAlign: 'center', marginBottom: 14 }}>
        <div style={{ marginBottom: 6, color: isDarkMode ? '#adb5bd' : '#6c757d', fontSize: 12 }}>
          全ステータスの申請・精算記録をCSV出力します。
        </div>
        <div style={{ marginBottom: 8, fontSize: 12 }}>
          <label style={{ color: isDarkMode ? '#fff' : '#000', fontWeight: 'bold', marginRight: 12 }}>抽出基準:</label>
          <label style={{ marginRight: 12, color: isDarkMode ? '#fff' : '#000', cursor: 'pointer' }}>
            <input type="radio" name="purchaseCsvDateType" value="created" checked={purchaseCsvDateType === 'created'}
              onChange={(e) => setPurchaseCsvDateType(e.target.value as 'created' | 'decided')} style={{ marginRight: 4 }} />
            申請日
          </label>
          <label style={{ color: isDarkMode ? '#fff' : '#000', cursor: 'pointer' }}>
            <input type="radio" name="purchaseCsvDateType" value="decided" checked={purchaseCsvDateType === 'decided'}
              onChange={(e) => setPurchaseCsvDateType(e.target.value as 'created' | 'decided')} style={{ marginRight: 4 }} />
            承認確定日
          </label>
        </div>
        <div style={{ marginBottom: 8 }}>
          <label htmlFor="purchaseCsvStartDate" style={{ color: isDarkMode ? '#fff' : '#000', fontSize: 12 }}>開始日:</label>
          <input type="date" id="purchaseCsvStartDate" value={purchaseCsvStartDate} onChange={(e) => setPurchaseCsvStartDate(e.target.value)}
            style={{ marginRight: 8, padding: 4, fontSize: 12, backgroundColor: isDarkMode ? '#495057' : 'white', color: isDarkMode ? '#fff' : '#000', border: `1px solid ${isDarkMode ? '#6c757d' : '#ccc'}` }} />
          <label htmlFor="purchaseCsvEndDate" style={{ color: isDarkMode ? '#fff' : '#000', fontSize: 12 }}>終了日:</label>
          <input type="date" id="purchaseCsvEndDate" value={purchaseCsvEndDate} onChange={(e) => setPurchaseCsvEndDate(e.target.value)}
            style={{ padding: 4, fontSize: 12, backgroundColor: isDarkMode ? '#495057' : 'white', color: isDarkMode ? '#fff' : '#000', border: `1px solid ${isDarkMode ? '#6c757d' : '#ccc'}` }} />
        </div>
        <div style={{ display: 'flex', gap: 6, justifyContent: 'center', flexWrap: 'wrap' }}>
          <button onClick={() => handleExportPurchaseCsv('all')} style={{ fontSize: 12 }}>CSV出力（全て）</button>
          <button onClick={() => handleExportPurchaseCsv('purchase_request')} style={{ fontSize: 12 }}>CSV出力（申請のみ）</button>
          <button onClick={() => handleExportPurchaseCsv('reimbursement')} style={{ fontSize: 12 }}>CSV出力（精算のみ）</button>
        </div>
      </div>

      {/* 申請/精算タブ */}
      <div style={{ display: 'flex', gap: 6, justifyContent: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
        {REQUEST_TYPE_FILTERS.map(f => (
          <button key={f.key} onClick={() => setRequestTypeFilter(f.key)}
            style={{
              padding: '4px 10px', borderRadius: 16, cursor: 'pointer', fontSize: 11,
              border: `1px solid ${requestTypeFilter === f.key ? '#28a745' : border}`,
              background: requestTypeFilter === f.key ? '#28a745' : 'transparent',
              color: requestTypeFilter === f.key ? '#fff' : text,
            }}
          >
            {f.label}
          </button>
        ))}
      </div>
      {/* ステータスタブ */}
      <div style={{ display: 'flex', gap: 6, justifyContent: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
        {STATUS_FILTERS.map(f => (
          <button key={f.key} onClick={() => setStatusFilter(f.key)}
            style={{
              padding: '5px 12px', borderRadius: 16, cursor: 'pointer', fontSize: 12,
              border: `1px solid ${statusFilter === f.key ? '#007bff' : border}`,
              background: statusFilter === f.key ? '#007bff' : 'transparent',
              color: statusFilter === f.key ? '#fff' : text,
            }}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* 削除済みタブは別のデータを出すので、通常の絞り込みと一覧はまとめて隠す */}
      {!isDeletedView && (<>
      {/* 年度・申請者・使用先フィルタ */}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginBottom: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <select value={fyFilter} onChange={e => setFyFilter(e.target.value)} style={{ fontSize: 12, padding: '4px 8px' }}>
          <option value="__current__">{nowFY}年度</option>
          {fyOptions.filter(fy => fy !== nowFY).map(fy => <option key={fy} value={String(fy)}>{fy}年度</option>)}
          <option value="all">全年度</option>
        </select>
        <SearchableSelect value={applicantFilter} options={applicantOptions} allLabel="申請者：全員" onChange={setApplicantFilter} isDarkMode={isDarkMode} />
        <select value={locationFilter} onChange={e => setLocationFilter(e.target.value)} style={{ fontSize: 12, padding: '4px 8px' }}>
          <option value="all">使用先：すべて</option>
          {locationOptions.map(loc => <option key={loc} value={loc}>{loc}</option>)}
        </select>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: text, margin: 0, cursor: 'pointer' }}>
          <input type="checkbox" checked={unreimbursedOnly} onChange={e => setUnreimbursedOnly(e.target.checked)} style={{ width: 'auto' }} />
          💳 未返金のみ
        </label>
        {!filtersAreDefault && (
          <button type="button" onClick={resetFilters} style={{ padding: '4px 10px', borderRadius: 6, fontSize: 11, border: `1px solid ${border}`, background: 'transparent', color: subText, cursor: 'pointer' }}>
            リセット
          </button>
        )}
      </div>

      {/* 購入先・金額・購入日で探す（「あの店にいくら払ったか」を後から追えるように） */}
      <div style={{ display: 'flex', gap: 6, justifyContent: 'center', marginBottom: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input type="text" value={storeFilter} onChange={e => setStoreFilter(e.target.value)} placeholder="購入先で探す"
          style={{ fontSize: 12, padding: '4px 8px', width: 130 }} />
        <span style={{ fontSize: 12, color: subText }}>金額</span>
        <input type="number" value={amountMin} onChange={e => setAmountMin(e.target.value)} placeholder="下限"
          style={{ fontSize: 12, padding: '4px 8px', width: 80 }} />
        <span style={{ fontSize: 12, color: subText }}>〜</span>
        <input type="number" value={amountMax} onChange={e => setAmountMax(e.target.value)} placeholder="上限"
          style={{ fontSize: 12, padding: '4px 8px', width: 80 }} />
        <span style={{ fontSize: 12, color: subText }}>購入日</span>
        <input type="date" value={purchasedFrom} onChange={e => setPurchasedFrom(e.target.value)}
          style={{ fontSize: 12, padding: '4px 8px', colorScheme: isDarkMode ? 'dark' : 'light' }} />
        <span style={{ fontSize: 12, color: subText }}>〜</span>
        <input type="date" value={purchasedTo} onChange={e => setPurchasedTo(e.target.value)}
          style={{ fontSize: 12, padding: '4px 8px', colorScheme: isDarkMode ? 'dark' : 'light' }} />
      </div>
      <div style={{ textAlign: 'center', fontSize: 11, color: subText, marginBottom: 10 }}>
        ※ 確認待ちの申請は年度に関わらず常に表示されます（申請者名で絞れます）
      </div>

      {/* 一括選択・一括ダウンロード */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: isDarkMode ? '#22222e' : '#f5f5f5', borderRadius: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: text, margin: 0, cursor: 'pointer' }}>
          <input type="checkbox" checked={filteredList.length > 0 && selectedIds.size === filteredList.length}
            onChange={e => toggleSelectAll(e.target.checked)} style={{ width: 'auto' }} />
          全選択
        </label>
        <span style={{ fontSize: 12, color: subText }}>{selectedIds.size > 0 ? `${selectedIds.size}件選択中${selectedNonDownloadableCount > 0 ? `（うち画像なし${selectedNonDownloadableCount}件）` : ''}` : '選択なし'}</span>
        <button
          type="button" onClick={handleBulkDownload} disabled={bulkDownloading || selectedDownloadableCount === 0}
          style={{ marginLeft: 'auto', padding: '6px 12px', borderRadius: 6, fontSize: 12, fontWeight: 'bold', border: 'none', background: selectedDownloadableCount === 0 ? subText : '#4a90d9', color: '#fff', cursor: selectedDownloadableCount === 0 ? 'default' : 'pointer' }}
        >
          {bulkDownloading ? 'zip作成中...' : `⬇ 選択した画像をダウンロード（zip）${selectedDownloadableCount > 0 ? `（${selectedDownloadableCount}件）` : ''}`}
        </button>
      </div>
      {bulkDownloadError && (
        <div style={{ maxWidth: 500, margin: '0 auto 12px', padding: '8px 10px', background: '#fff5f5', border: '1px solid #f5c2c7', borderRadius: 8, color: '#842029', fontSize: 12 }}>
          {bulkDownloadError}
        </div>
      )}

      {purchaseRequestsListLoading && (
        <div style={{ padding: 16, textAlign: 'center', color: subText, fontSize: 13 }}>読み込み中...</div>
      )}
      {!purchaseRequestsListLoading && filteredList.length === 0 && (
        <div style={{ padding: 16, textAlign: 'center', color: subText, fontSize: 13 }}>該当する申請はありません</div>
      )}
      </>)}

      {/* 削除済みの控え（管理者のみ閲覧可・書き換え不可） */}
      {isDeletedView && (
        <div style={{ maxWidth: 700, margin: '0 auto' }}>
          <div style={{ padding: '8px 12px', background: isDarkMode ? '#2c3e50' : '#e8f4fd', border: `1px solid ${isDarkMode ? '#3d5a73' : '#bee5eb'}`, borderRadius: 8, fontSize: 12, color: isDarkMode ? '#d0dde8' : '#2c5f6e', marginBottom: 10 }}>
            削除された申請・精算の記録です。消える直前の内容がそのまま残っています（あとから書き換え・削除はできません）。
          </div>
          {deletedLoading && (
            <div style={{ padding: 16, textAlign: 'center', color: subText, fontSize: 13 }}>読み込み中...</div>
          )}
          {deletedError && (
            <div style={{ padding: '8px 10px', background: '#f8d7da', border: '1px solid #f5c2c7', borderRadius: 8, color: '#842029', fontSize: 12, marginBottom: 10 }}>{deletedError}</div>
          )}
          {!deletedLoading && !deletedError && deletedRows.length === 0 && (
            <div style={{ padding: 16, textAlign: 'center', color: subText, fontSize: 13 }}>削除された記録はありません</div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {deletedRows.map(d => {
              const req = (d.snapshot?.request ?? {}) as Record<string, unknown>;
              const itemCount = Array.isArray(d.snapshot?.items) ? d.snapshot.items.length : 0;
              const str = (v: unknown) => (typeof v === 'string' ? v : '');
              return (
                <div key={d.id} style={{ border: `1px solid ${border}`, borderRadius: 8, padding: '10px 12px', background: cardBg }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
                    <span style={{ fontSize: 12, color: subText }}>
                      {new Date(d.deleted_at).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })} に {deletedNames[d.deleted_by ?? ''] || '不明'} が削除
                    </span>
                    <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, background: d.request_type === 'reimbursement' ? '#6f42c1' : '#28a745', color: '#fff' }}>
                      {d.request_type === 'reimbursement' ? '精算' : '申請'}
                    </span>
                  </div>
                  <div style={{ fontSize: 14, fontWeight: 'bold', color: text }}>
                    {d.item_name || '(品目なし)'}{itemCount > 1 && `（他${itemCount - 1}件）`}　¥{(d.amount ?? 0).toLocaleString()}
                  </div>
                  <div style={{ fontSize: 12, color: subText, marginTop: 4, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                    <span>申請者：{deletedNames[d.applicant_id ?? ''] || '不明'}</span>
                    {str(req.store_name) && <span>購入先：{str(req.store_name)}</span>}
                    {str(req.purchased_at) && <span>購入日：{str(req.purchased_at)}</span>}
                    {str(req.location) && <span>使用先：{str(req.location)}</span>}
                  </div>
                  {str(req.reason) && (
                    <div style={{ fontSize: 12, color: subText, marginTop: 4 }}>申請理由：{str(req.reason)}</div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 700, margin: '0 auto' }}>
        {!isDeletedView && filteredList.map(r => {
          const resolvedItems = resolveItems(r, r.items ?? []);
          const route = routeForStatus(r.status);
          const opinions = opinionsByRequest[r.id] ?? [];
          const requestedIds = r.status === 'pending_board' ? (r.board_approver_ids ?? []) : (r.requested_manager_ids ?? []);
          const unanswered = requestedIds.filter(id => !opinions.some(o => o.manager_id === id));
          const allAnswered = route === 'leader' || unanswered.length === 0;
          const hasDenial = opinions.some(o => o.opinion === 'deny');

          return (
            <div key={r.id} style={{ background: cardBg, border: `1px solid ${border}`, borderRadius: 10, padding: 10 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                <input type="checkbox" checked={selectedIds.has(r.id)} onChange={e => toggleSelectOne(r.id, e.target.checked)} style={{ width: 'auto', marginTop: 4 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  {r.amount_diff_flag && (
                    <div style={{ marginBottom: 6, padding: '6px 8px', background: warnBg, border: `1px solid ${warnBorder}`, borderRadius: 8, fontSize: 11, color: warnText }}>
                      ⚠️ 明細合計（¥{(r.items_subtotal ?? 0).toLocaleString()}）と申請金額（¥{r.amount.toLocaleString()}）に差があります
                      {r.amount_diff_reason && `：理由「${r.amount_diff_reason}」`}
                    </div>
                  )}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4, gap: 8 }}>
                    <span style={{ fontSize: 14, fontWeight: 'bold', color: text }}>{resolvedItems[0]?.item_name ?? r.item_name}{resolvedItems.length > 1 && `（他${resolvedItems.length - 1}件）`}</span>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                      {r.payment_method && r.request_type === 'reimbursement' && (
                        <PaymentBadge
                          record={r} isDarkMode={isDarkMode} reimbursingId={reimbursingId}
                          isEditing={editingReimbursedId === r.id}
                          draftDate={reimbursedDraftDate} onDraftDateChange={setReimbursedDraftDate}
                          onStartEdit={startEditReimbursed} onConfirm={confirmReimbursed}
                          onCancel={cancelEditReimbursed} onUnmark={unmarkReimbursed}
                        />
                      )}
                      <span style={{ fontSize: 14, fontWeight: 'bold', color: text, whiteSpace: 'nowrap' }}>¥{r.amount.toLocaleString()}</span>
                    </div>
                  </div>
                  <div style={{ fontSize: 11, color: subText, display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 4 }}>
                    <span style={{ color: '#fff', background: r.request_type === 'reimbursement' ? '#6c757d' : '#4a90d9', borderRadius: 4, padding: '1px 6px' }}>
                      {r.request_type === 'reimbursement' ? '精算' : '申請'}
                    </span>
                    <span>👤 {purchaseRequestNames[r.user_id] ?? '不明'}</span>
                    <span>📅 {r.purchased_at ?? r.requested_purchase_date ?? r.created_at.slice(0, 10)}</span>
                    {r.location && <span>使用先：{r.location}</span>}
                    {r.store_name && <span>購入先：{r.store_name}</span>}
                    {r.purpose && <span>用途：{r.purpose}</span>}
                    {r.instructed_by && <span>指示者：{r.instructed_by}</span>}
                  </div>
                  {r.reason && <div style={{ fontSize: 11, color: text, marginBottom: 4 }}><span style={{ fontWeight: 'bold' }}>申請理由：</span>{r.reason}</div>}
                  {r.notes && <div style={{ fontSize: 11, color: subText, marginBottom: 4 }}>備考：{r.notes}</div>}

                  {/* 確認状況バッジ */}
                  {r.request_type === 'reimbursement' && (
                    <div style={{ fontSize: 11, color: subText, marginBottom: 4 }}>精算記録のため承認操作はありません</div>
                  )}
                  {r.request_type === 'purchase_request' && r.status === 'self_judgment_shared' && (
                    <div style={{ fontSize: 11, color: subText, marginBottom: 4 }}>決裁権限内のため承認操作はありません</div>
                  )}
                  {/* 受理済み：誰が・いつ承認したかまで出す（結果だけだと経理が管理できないため） */}
                  {r.request_type === 'purchase_request' && APPROVED_STATUSES.includes(r.status) && r.status !== 'self_judgment_shared' && (() => {
                    const fmtAt = (s: string | null | undefined) => {
                      if (!s) return '';
                      const d = new Date(s.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(s) ? s : s + 'Z');
                      return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
                    };
                    // 承認ルートごとに「最終的に受理を確定させた人と日時」を出す
                    const route =
                      r.status === 'board_approved'
                        ? { label: '全員承認', at: r.board_approved_at, who: (r.board_approver_ids ?? []).map(id => purchaseRequestNames[id] ?? '不明').join('・') }
                        : r.status === 'manager_approved'
                        ? { label: 'マネージャー承認', at: r.manager_approved_at, who: (r.requested_manager_ids ?? []).map(id => purchaseRequestNames[id] ?? '不明').join('・') }
                        : { label: 'リーダー承認', at: r.leader_approved_at, who: purchaseRequestNames[r.leader_id ?? ''] ?? '' };
                    return (
                      <div style={{ marginBottom: 4 }}>
                        <div style={{ display: 'inline-block', padding: '3px 8px', borderRadius: 6, background: '#28a745', color: '#fff', fontSize: 11, fontWeight: 'bold' }}>受理済み</div>
                        <span style={{ fontSize: 11, color: subText, marginLeft: 8 }}>
                          {route.label}
                          {route.who && `：${route.who}`}
                          {route.at && `（${fmtAt(route.at)}）`}
                        </span>
                      </div>
                    );
                  })()}
                  {r.status === 'returned' && (
                    <div style={{ padding: '4px 8px', borderRadius: 6, background: '#f8d7da', color: '#842029', fontSize: 11, marginBottom: 4 }}>
                      差し戻し{r.returned_reason && `：${r.returned_reason}`}
                      {/* 差し戻しには専用の日時列が無いため、最後に更新された日時を使う */}
                      {r.updated_at && (() => {
                        const s = r.updated_at;
                        const d = new Date(s.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(s) ? s : s + 'Z');
                        return <span style={{ marginLeft: 6 }}>（{`${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`}）</span>;
                      })()}
                    </div>
                  )}
                  {/* 承認時のひとこと（任意・申請者にも見えている内容） */}
                  {r.approval_comment && (
                    <div style={{ padding: '4px 8px', borderRadius: 6, background: isDarkMode ? '#20304a' : '#eef6ff', color: subText, fontSize: 11, marginBottom: 4 }}>
                      承認時のひとこと：{r.approval_comment}
                    </div>
                  )}
                  {r.status === 'pending_leader' && (
                    <div style={{ display: 'inline-block', padding: '3px 8px', borderRadius: 6, background: warnBg, border: `1px solid ${warnBorder}`, color: warnText, fontSize: 11, marginBottom: 4 }}>
                      ① {purchaseRequestNames[r.leader_id ?? ''] ?? '不明'}さん確認待ち
                    </div>
                  )}
                  {r.status === 'pending_manager' && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', borderRadius: 6, background: warnBg, border: `1px solid ${warnBorder}`, color: warnText, fontSize: 11, marginBottom: 4 }}>
                      <span style={{ flex: 1 }}>
                        {unanswered.length === 0
                          ? '② マネージャー全員回答済み・最終決定待ち'
                          : `② マネージャー確認待ち（残${unanswered.length}名：${unanswered.map(id => purchaseRequestNames[id] ?? '不明').join('・')}）`}
                      </span>
                      <button type="button" onClick={() => setEditingApproversRecord(r)}
                        style={{ padding: '2px 6px', borderRadius: 4, border: `1px solid ${warnText}`, background: 'transparent', color: warnText, fontSize: 10, fontWeight: 'bold', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                        👤 メンバー編集
                      </button>
                    </div>
                  )}
                  {r.status === 'pending_board' && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', borderRadius: 6, background: warnBg, border: `1px solid ${warnBorder}`, color: warnText, fontSize: 11, marginBottom: 4 }}>
                      <span style={{ flex: 1 }}>
                        {unanswered.length === 0
                          ? (hasDenial ? '全員承認（全員回答済み・否認あり）' : '全員承認により自動確定待ちです')
                          : `全員承認待ち（残${unanswered.length}名：${unanswered.map(id => purchaseRequestNames[id] ?? '不明').join('・')}）`}
                      </span>
                      <button type="button" onClick={() => setEditingApproversRecord(r)}
                        style={{ padding: '2px 6px', borderRadius: 4, border: `1px solid ${warnText}`, background: 'transparent', color: warnText, fontSize: 10, fontWeight: 'bold', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                        👤 メンバー編集
                      </button>
                    </div>
                  )}

                  {(r.status === 'pending_manager' || r.status === 'pending_board') && opinions.length > 0 && (
                    <div style={{ marginBottom: 4, display: 'flex', flexDirection: 'column', gap: 2 }}>
                      {[...opinions]
                        .sort((a, b) => requestedIds.indexOf(a.manager_id) - requestedIds.indexOf(b.manager_id))
                        .map(o => {
                          const color = o.opinion === 'approve' ? '#28a745' : o.opinion === 'deny' ? '#dc3545' : subText;
                          return (
                            <div key={o.manager_id} style={{ fontSize: 10, display: 'flex', alignItems: 'baseline', gap: 4 }}>
                              <span style={{ color, fontWeight: 'bold', whiteSpace: 'nowrap' }}>
                                {purchaseRequestNames[o.manager_id] ?? '不明'}（{OPINION_LABEL[o.opinion]}）
                              </span>
                              {o.comment && <span style={{ color: subText }}>{o.comment}</span>}
                            </div>
                          );
                        })}
                    </div>
                  )}

                  {(purchaseRequestRemovedApprovers[r.id]?.length ?? 0) > 0 && (
                    <div style={{ marginBottom: 4 }}>
                      {purchaseRequestRemovedApprovers[r.id].map(entry => (
                        <div key={entry.id} style={{ fontSize: 10, color: subText }}>
                          外したメンバー：{purchaseRequestNames[entry.id] ?? '不明'}{entry.reason && `（理由：${entry.reason}）`}
                        </div>
                      ))}
                    </div>
                  )}

                  <PurchaseItemsSummary items={resolvedItems} isDarkMode={isDarkMode} canViewFile />

                  {/* 質問・回答（履歴・承認画面と同じ部品）。経理もここから質問できる */}
                  <PurchaseCommentThread
                    requestId={r.id} itemName={r.item_name}
                    comments={comments[r.id] ?? []} names={purchaseRequestNames} roles={commentRoles}
                    currentUserId={myId} currentUserName={purchaseRequestNames[myId] ?? ''}
                    isDark={isDarkMode} onPosted={loadComments}
                  />

                  {confirmingDeleteId === r.id ? (
                    <div style={{ marginTop: 8, padding: 8, background: '#fff5f5', border: '1px solid #f5c2c7', borderRadius: 8 }}>
                      <div style={{ fontSize: 12, color: '#842029', marginBottom: 6 }}>この申請を完全に削除します。元に戻せません。よろしいですか？</div>
                      {deleteError && <div style={{ fontSize: 11, color: '#842029', marginBottom: 6 }}>{deleteError}</div>}
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                        <button type="button" onClick={() => { setConfirmingDeleteId(null); setDeleteError(''); }} disabled={deleting}
                          style={{ padding: '6px', borderRadius: 6, border: '1px solid #f5c2c7', background: '#fff', color: '#842029', fontSize: 11, fontWeight: 'bold', cursor: deleting ? 'default' : 'pointer' }}>
                          キャンセル
                        </button>
                        <button type="button" onClick={() => handleDelete(r.id)} disabled={deleting}
                          style={{ padding: '6px', borderRadius: 6, border: 'none', background: '#dc3545', color: '#fff', fontSize: 11, fontWeight: 'bold', cursor: deleting ? 'default' : 'pointer' }}>
                          {deleting ? '削除中...' : '完全に削除する'}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      {r.receipt_type === 'photo' && r.receipt_storage_path ? (
                        <ReceiptViewButton
                          path={r.receipt_storage_path} isDarkMode={isDarkMode} canDownload onDownloaded={fetchPurchaseRequestsList}
                          extraActions={
                            <ActionButtons text={text} border={border} hasHistory={(purchaseRequestEditLogCounts[r.id] ?? 0) > 0}
                              onEdit={() => setEditingRecord(r)} onHistory={() => setHistoryRequestId(r.id)} onDeleteRequest={() => setConfirmingDeleteId(r.id)} />
                          }
                        />
                      ) : (
                        <div style={{ marginTop: 4, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                          <ActionButtons text={text} border={border} hasHistory={(purchaseRequestEditLogCounts[r.id] ?? 0) > 0}
                            onEdit={() => setEditingRecord(r)} onHistory={() => setHistoryRequestId(r.id)} onDeleteRequest={() => setConfirmingDeleteId(r.id)} />
                        </div>
                      )}
                      {r.receipt_type === 'photo' && r.receipt_storage_path && purchaseRequestLastDownload[r.id] && (
                        <div style={{ marginTop: 4, fontSize: 10, color: '#e0a800' }}>
                          最終ダウンロード：{new Date(purchaseRequestLastDownload[r.id].downloadedAt).toLocaleString('ja-JP')}（{purchaseRequestLastDownload[r.id].downloadedByName}）
                        </div>
                      )}
                    </>
                  )}

                  {actionErrors[r.id] && (
                    <div style={{ marginTop: 6, padding: '6px 8px', background: '#fff5f5', border: '1px solid #f5c2c7', borderRadius: 6, color: '#842029', fontSize: 11 }}>
                      {actionErrors[r.id]}
                    </div>
                  )}

                  {/* 管理者代行の承認/差し戻し操作 */}
                  {route && confirmingDeleteId !== r.id && (
                    returningId === r.id ? (
                      <div style={{ marginTop: 6 }}>
                        <textarea value={returnReason} onChange={e => setReturnReason(e.target.value)} placeholder="差し戻し理由を入力してください" rows={2}
                          style={{ width: '100%', boxSizing: 'border-box', padding: '6px 8px', borderRadius: 6, border: `1px solid ${border}`, background: isDarkMode ? '#3a3a5c' : '#f8f9fa', color: text, fontSize: 12, resize: 'vertical' as const, marginBottom: 6 }} />
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button type="button" onClick={() => { setReturningId(null); setReturnReason(''); }}
                            style={{ padding: '4px 8px', background: '#6c757d', color: '#fff', border: '2px solid #545b62', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 'bold' }}>
                            キャンセル
                          </button>
                          <button type="button" onClick={() => handleReturnSubmit(r)} disabled={!returnReason.trim() || processingId === r.id}
                            style={{ padding: '4px 8px', background: '#dc3545', color: '#fff', border: '2px solid #bd2130', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 'bold' }}>
                            差し戻す
                          </button>
                        </div>
                      </div>
                    ) : route === 'board' ? (
                      <div style={{ marginTop: 6 }}>
                        <button type="button" onClick={() => setReturningId(r.id)} disabled={!allAnswered || !hasDenial}
                          style={{ padding: '4px 8px', background: (allAnswered && hasDenial) ? '#dc3545' : subText, color: '#fff', border: `2px solid ${(allAnswered && hasDenial) ? '#bd2130' : subText}`, borderRadius: 4, cursor: (allAnswered && hasDenial) ? 'pointer' : 'default', fontSize: 11, fontWeight: 'bold' }}>
                          差し戻す
                        </button>
                      </div>
                    ) : (
                      <div style={{ marginTop: 6 }}>
                        {/* 承認時のひとこと（任意・申請者にも見える） */}
                        <textarea
                          value={approvalComments[r.id] ?? ''} rows={2}
                          onChange={e => setApprovalComments(prev => ({ ...prev, [r.id]: e.target.value }))}
                          placeholder="承認するときのひとこと（任意・申請者にも見えます）"
                          style={{ width: '100%', boxSizing: 'border-box', padding: '6px 8px', borderRadius: 6, border: `1px solid ${border}`, background: isDarkMode ? '#3a3a5c' : '#f8f9fa', color: text, fontSize: 12, resize: 'vertical' as const, marginBottom: 6 }}
                        />
                        <div style={{ display: 'flex', gap: 6 }}>
                        <button type="button" onClick={() => handleApprove(r)} disabled={!allAnswered || processingId === r.id}
                          style={{ padding: '4px 8px', background: allAnswered ? '#28a745' : subText, color: '#fff', border: `2px solid ${allAnswered ? '#1e7e34' : subText}`, borderRadius: 4, cursor: allAnswered ? 'pointer' : 'default', fontSize: 11, fontWeight: 'bold' }}>
                          {processingId === r.id ? '処理中...' : '承認して進める'}
                        </button>
                        <button type="button" onClick={() => setReturningId(r.id)} disabled={!allAnswered}
                          style={{ padding: '4px 8px', background: allAnswered ? '#dc3545' : subText, color: '#fff', border: `2px solid ${allAnswered ? '#bd2130' : subText}`, borderRadius: 4, cursor: allAnswered ? 'pointer' : 'default', fontSize: 11, fontWeight: 'bold' }}>
                          差し戻す
                        </button>
                        </div>
                      </div>
                    )
                  )}
                  {r.status === 'returned' && confirmingDeleteId !== r.id && (
                    <div style={{ marginTop: 6 }}>
                      <button type="button" onClick={() => handleCancelReturn(r)} disabled={processingId === r.id}
                        style={{ padding: '4px 8px', background: '#6c757d', color: '#fff', border: '2px solid #545b62', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 'bold' }}>
                        {processingId === r.id ? '処理中...' : '↩ 取り消し'}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {editingRecord && (
        <PurchaseRequestEditModal record={editingRecord} isDarkMode={isDarkMode} onClose={() => setEditingRecord(null)}
          onSaved={() => { setEditingRecord(null); fetchPurchaseRequestsList(); }} />
      )}

      {editingApproversRecord && (
        <PurchaseApproverEditModal record={editingApproversRecord} isDarkMode={isDarkMode} names={purchaseRequestNames}
          onClose={() => setEditingApproversRecord(null)}
          onChanged={fetchPurchaseRequestsList} />
      )}

      {historyRequestId && (
        <PurchaseRequestEditHistoryModal purchaseRequestId={historyRequestId} isDarkMode={isDarkMode} onClose={() => setHistoryRequestId(null)} />
      )}
    </div>
  );
};

const ActionButtons: React.FC<{
  text: string; border: string; hasHistory: boolean;
  onEdit: () => void; onHistory: () => void; onDeleteRequest: () => void;
}> = ({ text, border, hasHistory, onEdit, onHistory, onDeleteRequest }) => {
  const smallBtnStyle: React.CSSProperties = {
    padding: '4px 10px', borderRadius: 6, fontSize: 12, fontWeight: 'bold',
    border: `1px solid ${border}`, background: 'transparent', color: text, cursor: 'pointer',
  };
  return (
    <>
      <button type="button" onClick={onEdit} style={smallBtnStyle}>✏️ 修正</button>
      {hasHistory && (
        <button type="button" onClick={onHistory} style={{ ...smallBtnStyle, border: '1px solid #4a90d9', color: '#4a90d9' }}>🕘 履歴</button>
      )}
      <button type="button" onClick={onDeleteRequest} style={{ ...smallBtnStyle, border: '1px solid #dc3545', color: '#dc3545' }}>削除</button>
    </>
  );
};

const PaymentBadge: React.FC<{
  record: PurchaseRequestCSVRow; isDarkMode: boolean; reimbursingId: string | null;
  isEditing: boolean; draftDate: string; onDraftDateChange: (v: string) => void;
  onStartEdit: (r: PurchaseRequestCSVRow) => void; onConfirm: (r: PurchaseRequestCSVRow) => void;
  onCancel: () => void; onUnmark: (r: PurchaseRequestCSVRow) => void;
}> = ({ record, isDarkMode, reimbursingId, isEditing, draftDate, onDraftDateChange, onStartEdit, onConfirm, onCancel, onUnmark }) => {
  if (record.payment_method === 'company_paid') {
    const detail = record.payment_method_detail === 'other'
      ? (record.payment_method_other || 'その他')
      : PAYMENT_DETAIL_LABEL[record.payment_method_detail ?? ''] ?? '';
    return (
      <span style={{ fontSize: 12, fontWeight: 'bold', color: isDarkMode ? '#aaaaaa' : '#666666', whiteSpace: 'nowrap' }}>
        💳 会社支払（返金なし）{detail && `：${detail}`}
      </span>
    );
  }
  if (record.payment_method !== 'cash') return null;

  const reimbursed = Boolean(record.reimbursed_at);
  const loading = reimbursingId === record.id;

  if (isEditing) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <input
          type="date" value={draftDate} onChange={e => onDraftDateChange(e.target.value)}
          style={{ fontSize: 11, padding: '2px 4px', width: 130 }}
        />
        <button type="button" onClick={() => onConfirm(record)} disabled={loading || !draftDate}
          style={{ fontSize: 11, fontWeight: 'bold', padding: '2px 6px', border: 'none', borderRadius: 4, background: '#28a745', color: '#fff', cursor: loading ? 'default' : 'pointer' }}>
          確定
        </button>
        {reimbursed && (
          <button type="button" onClick={() => onUnmark(record)} disabled={loading}
            style={{ fontSize: 11, padding: '2px 6px', border: 'none', borderRadius: 4, background: '#dc3545', color: '#fff', cursor: loading ? 'default' : 'pointer' }}>
            未返金に戻す
          </button>
        )}
        <button type="button" onClick={onCancel} disabled={loading}
          style={{ fontSize: 11, padding: '2px 6px', border: `1px solid ${isDarkMode ? '#3a3a5c' : '#e0e0e0'}`, borderRadius: 4, background: 'transparent', color: isDarkMode ? '#eee' : '#222', cursor: loading ? 'default' : 'pointer' }}>
          キャンセル
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onStartEdit(record)}
      disabled={loading}
      title={reimbursed ? 'クリックで返金日を修正・未返金に戻す' : 'クリックで返金日を記録する'}
      style={{
        fontSize: 12, fontWeight: 'bold', whiteSpace: 'nowrap', cursor: loading ? 'default' : 'pointer',
        border: 'none', background: 'transparent', padding: 0,
        color: reimbursed ? '#28a745' : '#dc3545',
      }}
    >
      💳 {reimbursed ? `返金済み：${new Date(record.reimbursed_at as string).toLocaleDateString('ja-JP')}` : '立替（未返金）'}
    </button>
  );
};

export default PurchaseRequestsTab;

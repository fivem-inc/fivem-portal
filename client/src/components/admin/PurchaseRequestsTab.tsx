import React, { useState } from 'react';
import { useAdminPanel } from './AdminPanelContext';
import { resolveItems } from '../../lib/purchaseItemsFallback';
import PurchaseItemsSummary from '../PurchaseItemsSummary';
import ReceiptViewButton from '../ReceiptViewButton';

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
const STATUS_FILTERS: { key: string; label: string }[] = [
  { key: 'all', label: '全て' },
  { key: 'pending', label: '承認待ち' },
  { key: 'approved', label: '承認済み' },
  { key: 'returned', label: '差し戻し' },
];
const REQUEST_TYPE_FILTERS: { key: 'all' | 'purchase_request' | 'reimbursement'; label: string }[] = [
  { key: 'all', label: '全て' },
  { key: 'purchase_request', label: '申請' },
  { key: 'reimbursement', label: '精算' },
];
const PENDING_STATUSES = ['pending_leader', 'pending_manager', 'pending_board'];
const APPROVED_STATUSES = ['leader_approved', 'manager_approved', 'board_approved', 'self_judgment_shared', 'recorded'];

const PurchaseRequestsTab: React.FC = () => {
  const ctx = useAdminPanel();
  const { isDarkMode } = ctx;
  const {
    purchaseCsvStartDate, setPurchaseCsvStartDate,
    purchaseCsvEndDate, setPurchaseCsvEndDate,
    purchaseCsvDateType, setPurchaseCsvDateType,
    handleExportPurchaseCsv, purchaseCsvError,
    purchaseRequestsList, purchaseRequestsListLoading, purchaseRequestNames,
    fetchPurchaseRequestsList,
  } = ctx;
  const [statusFilter, setStatusFilter] = useState('all');
  const [requestTypeFilter, setRequestTypeFilter] = useState<'all' | 'purchase_request' | 'reimbursement'>('all');

  const cardBg = isDarkMode ? '#2d2d3e' : '#ffffff';
  const border = isDarkMode ? '#3a3a5c' : '#e0e0e0';
  const text = isDarkMode ? '#eeeeee' : '#222222';
  const subText = isDarkMode ? '#aaaaaa' : '#666666';

  const filteredList = purchaseRequestsList.filter(r => {
    if (requestTypeFilter !== 'all' && r.request_type !== requestTypeFilter) return false;
    if (statusFilter === 'all') return true;
    if (statusFilter === 'pending') return PENDING_STATUSES.includes(r.status);
    if (statusFilter === 'approved') return APPROVED_STATUSES.includes(r.status);
    if (statusFilter === 'returned') return r.status === 'returned';
    return true;
  });

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, margin: '0 0 20px' }}>
        <h3 style={{ margin: 0, color: isDarkMode ? '#fff' : '#000' }}>🧾 購入申請</h3>
        <button
          type="button"
          onClick={() => fetchPurchaseRequestsList()}
          disabled={purchaseRequestsListLoading}
          style={{ padding: '4px 10px', borderRadius: 6, fontSize: 12, border: `1px solid ${border}`, background: 'transparent', color: text, cursor: purchaseRequestsListLoading ? 'default' : 'pointer' }}
        >
          🔄 更新
        </button>
      </div>

      {purchaseCsvError && (
        <div style={{ maxWidth: 500, margin: '0 auto 16px', padding: '10px 12px', background: '#fff5f5', border: '1px solid #f5c2c7', borderRadius: 8, color: '#842029', fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span>{purchaseCsvError}</span>
        </div>
      )}

      {/* CSV出力セクション */}
      <div style={{ textAlign: 'center', marginBottom: 20 }}>
        <div style={{ marginBottom: 10, color: isDarkMode ? '#adb5bd' : '#6c757d', fontSize: 13 }}>
          全ステータス（申請中・差し戻しも含む）の申請・精算記録をCSV出力します。
        </div>
        {/* 日付種別選択（ラジオボタン） */}
        <div style={{ marginBottom: 15 }}>
          <label style={{ color: isDarkMode ? '#fff' : '#000', fontWeight: 'bold', marginRight: 20 }}>抽出基準:</label>
          <label style={{ marginRight: 20, color: isDarkMode ? '#fff' : '#000', cursor: 'pointer' }}>
            <input
              type="radio"
              name="purchaseCsvDateType"
              value="created"
              checked={purchaseCsvDateType === 'created'}
              onChange={(e) => setPurchaseCsvDateType(e.target.value as 'created' | 'decided')}
              style={{ marginRight: 5 }}
            />
            申請日
          </label>
          <label style={{ color: isDarkMode ? '#fff' : '#000', cursor: 'pointer' }}>
            <input
              type="radio"
              name="purchaseCsvDateType"
              value="decided"
              checked={purchaseCsvDateType === 'decided'}
              onChange={(e) => setPurchaseCsvDateType(e.target.value as 'created' | 'decided')}
              style={{ marginRight: 5 }}
            />
            承認確定日
          </label>
        </div>
        <div style={{ marginBottom: 10 }}>
          <label htmlFor="purchaseCsvStartDate" style={{ color: isDarkMode ? '#fff' : '#000' }}>開始日:</label>
          <input
            type="date"
            id="purchaseCsvStartDate"
            value={purchaseCsvStartDate}
            onChange={(e) => setPurchaseCsvStartDate(e.target.value)}
            style={{
              marginRight: 10,
              padding: 5,
              backgroundColor: isDarkMode ? '#495057' : 'white',
              color: isDarkMode ? '#fff' : '#000',
              border: `1px solid ${isDarkMode ? '#6c757d' : '#ccc'}`
            }}
          />
          <label htmlFor="purchaseCsvEndDate" style={{ color: isDarkMode ? '#fff' : '#000' }}>終了日:</label>
          <input
            type="date"
            id="purchaseCsvEndDate"
            value={purchaseCsvEndDate}
            onChange={(e) => setPurchaseCsvEndDate(e.target.value)}
            style={{
              padding: 5,
              backgroundColor: isDarkMode ? '#495057' : 'white',
              color: isDarkMode ? '#fff' : '#000',
              border: `1px solid ${isDarkMode ? '#6c757d' : '#ccc'}`
            }}
          />
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
          <button onClick={() => handleExportPurchaseCsv('all')}>CSV出力（全て）</button>
          <button onClick={() => handleExportPurchaseCsv('purchase_request')}>CSV出力（申請のみ）</button>
          <button onClick={() => handleExportPurchaseCsv('reimbursement')}>CSV出力（精算のみ）</button>
        </div>
      </div>

      {/* 申請一覧 */}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
        {REQUEST_TYPE_FILTERS.map(f => (
          <button
            key={f.key}
            onClick={() => setRequestTypeFilter(f.key)}
            style={{
              padding: '6px 14px', borderRadius: 20, cursor: 'pointer', fontSize: 13,
              border: `1px solid ${requestTypeFilter === f.key ? '#28a745' : border}`,
              background: requestTypeFilter === f.key ? '#28a745' : 'transparent',
              color: requestTypeFilter === f.key ? '#fff' : text,
            }}
          >
            {f.label}
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
        {STATUS_FILTERS.map(f => (
          <button
            key={f.key}
            onClick={() => setStatusFilter(f.key)}
            style={{
              padding: '6px 14px', borderRadius: 20, cursor: 'pointer', fontSize: 13,
              border: `1px solid ${statusFilter === f.key ? '#4a90d9' : border}`,
              background: statusFilter === f.key ? '#4a90d9' : 'transparent',
              color: statusFilter === f.key ? '#fff' : text,
            }}
          >
            {f.label}
          </button>
        ))}
      </div>

      {purchaseRequestsListLoading && (
        <div style={{ padding: 20, textAlign: 'center', color: subText }}>読み込み中...</div>
      )}
      {!purchaseRequestsListLoading && filteredList.length === 0 && (
        <div style={{ padding: 20, textAlign: 'center', color: subText }}>該当する申請はありません</div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 700, margin: '0 auto' }}>
        {filteredList.map(r => {
          const statusInfo = STATUS_LABEL[r.status];
          const resolvedItems = resolveItems(r, r.items ?? []);
          return (
            <div key={r.id} style={{ background: cardBg, border: `1px solid ${border}`, borderRadius: 10, padding: 14 }}>
              {r.amount_diff_flag && (
                <div style={{ marginBottom: 10, padding: '8px 10px', background: isDarkMode ? '#3a3220' : '#fff8e1', border: `1px solid ${isDarkMode ? '#5c5430' : '#ffe082'}`, borderRadius: 8, fontSize: 12, color: isDarkMode ? '#ffe082' : '#8a6d00' }}>
                  ⚠️ 明細合計（¥{(r.items_subtotal ?? 0).toLocaleString()}）と申請金額（¥{r.amount.toLocaleString()}）に差があります
                  {r.amount_diff_reason && `：理由「${r.amount_diff_reason}」`}
                </div>
              )}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6, gap: 8 }}>
                <span style={{ fontSize: 15, fontWeight: 'bold', color: text }}>{resolvedItems[0]?.item_name ?? r.item_name}{resolvedItems.length > 1 && `（他${resolvedItems.length - 1}件）`}</span>
                <span style={{ fontSize: 15, fontWeight: 'bold', color: text, whiteSpace: 'nowrap' }}>¥{r.amount.toLocaleString()}</span>
              </div>
              <div style={{ fontSize: 12, color: subText, display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 6 }}>
                <span style={{ color: '#fff', background: r.request_type === 'reimbursement' ? '#6c757d' : '#4a90d9', borderRadius: 4, padding: '1px 6px' }}>
                  {r.request_type === 'reimbursement' ? '精算' : '申請'}
                </span>
                {statusInfo && r.request_type === 'purchase_request' && (
                  <span style={{ color: '#fff', background: statusInfo.color, borderRadius: 4, padding: '1px 6px' }}>{statusInfo.label}</span>
                )}
                <span>👤 {purchaseRequestNames[r.user_id] ?? '不明'}</span>
                <span>📅 {r.purchased_at ?? r.requested_purchase_date ?? r.created_at.slice(0, 10)}</span>
                {r.location && <span>使用先：{r.location}</span>}
              </div>
              {r.status === 'returned' && r.returned_reason && (
                <div style={{ fontSize: 12, color: '#dc3545', marginBottom: 6 }}>差し戻し理由：{r.returned_reason}</div>
              )}
              <PurchaseItemsSummary items={resolvedItems} isDarkMode={isDarkMode} />
              {r.receipt_type === 'photo' && r.receipt_storage_path && (
                <ReceiptViewButton path={r.receipt_storage_path} isDarkMode={isDarkMode} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default PurchaseRequestsTab;

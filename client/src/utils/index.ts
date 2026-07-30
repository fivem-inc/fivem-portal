import type { Submission, GroupedSubmissions, PurchaseRequestItem } from '../types';

// 金額をカンマ区切りにするヘルパー関数
export const formatAmount = (value: string): string => {
  if (!value) return '';
  const num = parseInt(value.replace(/,/g, ''), 10);
  return isNaN(num) ? '' : num.toLocaleString();
};

// カンマを取り除き数値文字列を返すヘルパー関数（全角数字→半角に変換）
export const parseAmount = (value: string): string => {
  return value
    .replace(/[！-～]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/[^0-9]/g, '');
};

// 申請データを年度と月ごとにグループ化するヘルパー関数
export const groupSubmissionsByYearAndMonth = (submissions: Submission[]): GroupedSubmissions => {
  const grouped: GroupedSubmissions = {};
  
  submissions.forEach(s => {
    const date = new Date(s.created_at);
    const year = date.getFullYear().toString();
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    
    if (!grouped[year]) {
      grouped[year] = {};
    }
    if (!grouped[year][month]) {
      grouped[year][month] = [];
    }
    grouped[year][month].push(s);
  });
  
  return grouped;
};

// CSVエクスポート用のデータ生成
export const generateCSVData = (submissions: Submission[]): string => {
  const headers = [
    '申請NO', '申請ID', '申請者', '申請日', 'ステータス', 'タイプ', 
    '利用日', '定期期間', '交通機関', '出発駅', '帰着駅', '金額', 
    '行き先', '備考欄', '承認日', '却下日'
  ];
  
  let csvContent = headers.join(',') + '\r\n';
  let submissionCounter = 0;

  submissions.forEach(submission => {
    submissionCounter++;
    submission.expenses_data.forEach(expense => {
      const row = [
        submissionCounter,
        submission.id,
        submission.profiles?.name || submission.profiles?.email || '不明',
        new Date(submission.created_at).toLocaleString(),
        submission.status === 'pending' ? '申請中' : submission.status === 'approved' ? '承認' : '却下',
        expense.type === 'regular' ? '定期' : expense.type === 'business_trip' ? '出張（園指導等）' : '通勤（単発）',
        expense.type !== 'regular' ? (expense.start_date || '') : '',
        expense.type === 'regular' ? `${expense.start_date || ''} ~ ${expense.end_date || ''}` : '',
        expense.transportation || '',
        expense.from_station,
        expense.to_station,
        expense.amount,
        expense.workplace || '',
        expense.notes || '',
        submission.approved_at ? new Date(submission.approved_at).toLocaleString() : '',
        submission.rejected_at ? new Date(submission.rejected_at).toLocaleString() : '',
      ];
      csvContent += row.map(item => `"${item}"`).join(',') + '\r\n';
    });
  });

  return csvContent;
};

// 備品購入申請CSV出力用の型（全ステータス対象。氏名解決は呼び出し側でMapを渡す）
export interface PurchaseRequestCSVRow {
  id: string;
  user_id: string;
  applicant_role_title: string;
  request_type: 'reimbursement' | 'purchase_request';
  amount: number;
  item_name: string;
  quantity: number | null;
  requested_purchase_date: string | null;
  purchased_at: string | null;
  store_name: string | null;
  purpose: string | null;
  instructed_by: string | null;
  payment_method: 'cash' | 'company_paid' | null;
  payment_method_detail: 'company_card' | 'bank_transfer' | 'cash_on_delivery' | 'other' | null;
  payment_method_other: string | null;
  notes: string | null;
  status: string;
  leader_id: string | null;
  requested_manager_ids: string[] | null;
  shared_manager_ids: string[] | null;
  board_approver_ids: string[] | null;
  is_self_judgment: boolean;
  president_self_judgment: boolean;
  quotes: { vendor: string; amount: number }[] | null;
  created_at: string;
  leader_approved_at: string | null;
  manager_approved_at: string | null;
  board_approved_at: string | null;
  returned_reason: string | null;
  approval_comment: string | null;
  approval_round: number;
  location: string | null;
  items_subtotal: number | null;
  amount_diff_reason: string | null;
  amount_diff_flag: boolean | null;
  receipt_type: 'photo' | 'physical' | 'none' | null;
  receipt_storage_path: string | null;
  reimbursed_at: string | null;
  reason: string | null;
  // 明細（複数商品）。呼び出し側でpurchase_request_items・purchase_request_item_quotesを
  // まとめて取得し、resolveItems()でフォールバック解決した配列を渡す
  items: PurchaseRequestItem[];
}

const PURCHASE_STATUS_LABEL: Record<string, string> = {
  recorded: '精算記録',
  pending_leader: '承認待ち（リーダー）',
  leader_approved: '承認済み',
  pending_manager: '承認待ち（マネージャー）',
  manager_approved: '承認済み',
  self_judgment_shared: '共有済み（自己判断）',
  pending_board: '承認待ち（全員承認）',
  board_approved: '承認済み（全員承認）',
  returned: '差し戻し',
};

export const PAYMENT_DETAIL_LABEL: Record<string, string> = {
  company_card: '会社カード', bank_transfer: '振込', cash_on_delivery: '代引き', other: 'その他',
};

export const paymentMethodLabel = (row: Pick<PurchaseRequestCSVRow, 'payment_method' | 'payment_method_detail' | 'payment_method_other'>): string => {
  if (row.payment_method === 'cash') return '立替（返金あり）';
  if (row.payment_method === 'company_paid') {
    const detail = row.payment_method_detail === 'other'
      ? (row.payment_method_other || 'その他')
      : PAYMENT_DETAIL_LABEL[row.payment_method_detail ?? ''] ?? '';
    return `会社支払（返金なし）${detail ? `：${detail}` : ''}`;
  }
  return '';
};

const purchaseAmountBand = (row: PurchaseRequestCSVRow): string => {
  if (row.request_type !== 'purchase_request') return '';
  if (row.amount <= 10000) return 'リーダー';
  if (row.amount <= 30000) return 'マネージャー';
  return '全員承認';
};

const purchaseRouteType = (row: PurchaseRequestCSVRow): string => {
  if (row.request_type !== 'purchase_request') return '';
  if (row.president_self_judgment || row.is_self_judgment) return '自己判断（共有のみ）';
  if (row.amount <= 10000) return 'リーダー承認';
  if (row.amount <= 30000) return 'マネージャー承認';
  return '全員承認';
};

// 備品購入申請CSV出力用のデータ生成（全ステータス対象）
// 1申請につき明細（商品）の数だけ行を展開する。申請共通列は各行で繰り返し、「商品連番」列で1,2,3...を振る。
// nameOf: user_idから氏名を解決するMap（呼び出し側でprofilesをまとめて取得して渡す）
export const generatePurchaseRequestCSVData = (
  rows: PurchaseRequestCSVRow[],
  nameOf: (userId: string | null | undefined) => string
): string => {
  const headers = [
    '申請ID', '商品連番', '申請者名', '申請時役職', '申請区分', '金額帯',
    '品目名', '数量', '店舗名', '商品金額', '商品金額手動上書き有無',
    '選択業者名', '選択業者単価', '相見積もり件数', '相見積もり内容(全業者;区切り)',
    '商品数', '明細合計金額', '申請金額', '金額乖離フラグ', '金額乖離理由',
    '使用先', '購入予定日', '購入日', '指示者', '用途', '申請理由', '支払方法', '返金日', '備考',
    'ステータス', '承認ルート種別', '承認依頼先氏名', '自己判断フラグ', '共有先氏名一覧',
    '申請日', '承認確定日', '差し戻し理由', '承認時のひとこと', '差し戻しラウンド',
  ];

  let csvContent = headers.join(',') + '\r\n';

  rows.forEach(row => {
    const approverNames = (() => {
      if (row.request_type !== 'purchase_request') return '';
      if (row.leader_id) return nameOf(row.leader_id);
      if (row.requested_manager_ids?.length) return row.requested_manager_ids.map(id => nameOf(id)).join('・');
      if (row.board_approver_ids?.length) return row.board_approver_ids.map(id => nameOf(id)).join('・');
      return '';
    })();

    const approvedAt = row.leader_approved_at || row.manager_approved_at || row.board_approved_at || '';
    const itemCount = row.items.length;

    row.items.forEach((item, index) => {
      const selectedQuote = item.quotes.find(q => q.is_selected) ?? null;
      const quotesText = item.quotes.map(q => `${q.vendor}:${q.unit_amount}`).join(';');

      const rowData = [
        row.id,
        index + 1,
        nameOf(row.user_id),
        row.applicant_role_title,
        row.request_type === 'reimbursement' ? '精算' : '申請',
        purchaseAmountBand(row),
        item.item_name,
        item.quantity ?? '',
        item.store_name || '',
        item.amount,
        item.amount_manually_overridden ? 'はい' : 'いいえ',
        selectedQuote?.vendor || '',
        selectedQuote?.unit_amount ?? '',
        item.quotes.length,
        quotesText,
        itemCount,
        row.items_subtotal ?? '',
        row.amount,
        row.amount_diff_flag ? 'はい' : 'いいえ',
        row.amount_diff_reason || '',
        row.location || '',
        row.requested_purchase_date || '',
        row.purchased_at || '',
        row.instructed_by || '',
        row.purpose || '',
        row.reason || '',
        paymentMethodLabel(row),
        row.reimbursed_at ? new Date(row.reimbursed_at).toLocaleDateString() : '',
        row.notes || '',
        PURCHASE_STATUS_LABEL[row.status] || row.status,
        purchaseRouteType(row),
        approverNames,
        row.is_self_judgment || row.president_self_judgment ? 'はい' : 'いいえ',
        (row.shared_manager_ids ?? []).map(id => nameOf(id)).join('・'),
        new Date(row.created_at).toLocaleString(),
        approvedAt ? new Date(approvedAt).toLocaleString() : '',
        row.returned_reason || '',
        row.approval_comment || '',
        row.approval_round,
      ];
      csvContent += rowData.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',') + '\r\n';
    });
  });

  return csvContent;
};

// CSVファイルをダウンロード
export const downloadCSV = (csvContent: string, filename: string = 'approved_expenses.csv'): void => {
  const bom = new Uint8Array([0xEF, 0xBB, 0xBF]);
  const blob = new Blob([bom, csvContent], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  
  if (link.download !== undefined) {
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', filename);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }
};
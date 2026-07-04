import type { Submission, GroupedSubmissions } from '../types';

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
        (expense.type === 'one_time' || expense.type === 'business_trip') ? (expense.start_date || '') : '',
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
  payment_method: 'cash' | 'company_card' | null;
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
  approval_round: number;
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
// nameOf: user_idから氏名を解決するMap（呼び出し側でprofilesをまとめて取得して渡す）
export const generatePurchaseRequestCSVData = (
  rows: PurchaseRequestCSVRow[],
  nameOf: (userId: string | null | undefined) => string
): string => {
  const headers = [
    '申請ID', '申請者名', '申請時役職', '申請区分', '金額帯',
    '品目名', '数量', '金額', '購入予定日', '購入日',
    '指示者', '購入先', '用途', '支払方法', '備考',
    'ステータス', '承認ルート種別', '承認依頼先氏名',
    '自己判断フラグ', '共有先氏名一覧', '相見積もり内容', '申請日',
    '承認確定日', '差し戻し理由', '差し戻しラウンド',
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

    const quotesText = (row.quotes ?? []).map(q => `${q.vendor}:${q.amount}`).join(';');
    const approvedAt = row.leader_approved_at || row.manager_approved_at || row.board_approved_at || '';

    const rowData = [
      row.id,
      nameOf(row.user_id),
      row.applicant_role_title,
      row.request_type === 'reimbursement' ? '精算' : '申請',
      purchaseAmountBand(row),
      row.item_name,
      row.quantity ?? '',
      row.amount,
      row.requested_purchase_date || '',
      row.purchased_at || '',
      row.instructed_by || '',
      row.store_name || '',
      row.purpose || '',
      row.payment_method === 'cash' ? '立替（返金あり）' : row.payment_method === 'company_card' ? '会社カード（返金なし）' : '',
      row.notes || '',
      PURCHASE_STATUS_LABEL[row.status] || row.status,
      purchaseRouteType(row),
      approverNames,
      row.is_self_judgment || row.president_self_judgment ? 'はい' : 'いいえ',
      (row.shared_manager_ids ?? []).map(id => nameOf(id)).join('・'),
      quotesText,
      new Date(row.created_at).toLocaleString(),
      approvedAt ? new Date(approvedAt).toLocaleString() : '',
      row.returned_reason || '',
      row.approval_round,
    ];
    csvContent += rowData.map(item => `"${String(item).replace(/"/g, '""')}"`).join(',') + '\r\n';
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
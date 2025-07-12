import type { Submission, GroupedSubmissions } from '../types';

// 金額をカンマ区切りにするヘルパー関数
export const formatAmount = (value: string): string => {
  if (!value) return '';
  const num = parseInt(value.replace(/,/g, ''), 10);
  return isNaN(num) ? '' : num.toLocaleString();
};

// カンマを取り除き数値文字列を返すヘルパー関数
export const parseAmount = (value: string): string => {
  return value.replace(/,/g, '');
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
    '備考欄', '承認日', '却下日'
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
        expense.type === 'regular' ? '定期' : expense.type === 'business_trip' ? '出張' : '単発',
        (expense.type === 'one_time' || expense.type === 'business_trip') ? (expense.start_date || '') : '',
        expense.type === 'regular' ? `${expense.start_date || ''} ~ ${expense.end_date || ''}` : '',
        expense.transportation || '',
        expense.from_station,
        expense.to_station,
        expense.amount,
        expense.notes || '',
        submission.approved_at ? new Date(submission.approved_at).toLocaleString() : '',
        submission.rejected_at ? new Date(submission.rejected_at).toLocaleString() : '',
      ];
      csvContent += row.map(item => `"${item}"`).join(',') + '\r\n';
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
import React, { useState, useCallback } from 'react';
import type { Submission, AuthUser } from '../types';
import { groupSubmissionsByYearAndMonth } from '../utils';

interface HistoryViewProps {
  submissions: Submission[];
  user: AuthUser | null;
  isLoading: boolean;
  onApplyTemplate: (submission: Submission) => void;
}

const HistoryView: React.FC<HistoryViewProps> = ({ 
  submissions, 
  user, 
  isLoading, 
  onApplyTemplate 
}) => {
  const [expandedUserYears, setExpandedUserYears] = useState<Set<string>>(new Set());
  const [expandedMonths, setExpandedMonths] = useState<Set<string>>(new Set());

  const toggleYearExpansion = useCallback((year: string) => {
    setExpandedUserYears(prev => {
      const newSet = new Set(prev);
      if (newSet.has(year)) {
        newSet.delete(year);
      } else {
        newSet.add(year);
      }
      return newSet;
    });
  }, []);

  const toggleMonthExpansion = useCallback((yearMonth: string) => {
    setExpandedMonths(prev => {
      const newSet = new Set(prev);
      if (newSet.has(yearMonth)) {
        newSet.delete(yearMonth);
      } else {
        newSet.add(yearMonth);
      }
      return newSet;
    });
  }, []);

  // ユーザーの申請履歴のみをフィルタリング
  const userSubmissions = submissions.filter(s => s.user_id === user?.id);
  const groupedSubmissions = groupSubmissionsByYearAndMonth(userSubmissions);

  return (
    <div style={{ marginTop: 40, borderTop: '1px solid #eee', paddingTop: 20 }}>
      <h3>あなたの申請履歴</h3>
      {isLoading ? (
        <p>読み込み中...</p>
      ) : (
        Object.entries(groupedSubmissions)
          .sort(([yearA], [yearB]) => parseInt(yearB) - parseInt(yearA))
          .map(([year, months]) => (
            <div key={year} style={{ marginBottom: 20, border: '1px solid #eee', borderRadius: 4, padding: 10 }}>
              <h4 
                onClick={() => toggleYearExpansion(year)} 
                style={{ cursor: 'pointer', margin: 0, padding: 5, background: '#f0f0f0' }}
              >
                {year}年度 ({expandedUserYears.has(year) ? '閉じる' : '開く'})
              </h4>
              {expandedUserYears.has(year) && (
                Object.entries(months)
                  .sort(([monthA], [monthB]) => parseInt(monthB) - parseInt(monthA))
                  .map(([month, monthSubmissions]) => (
                    <div key={`${year}-${month}`} style={{ marginTop: 10, border: '1px solid #ddd', borderRadius: 4, padding: 5 }}>
                      <h5 
                        onClick={() => toggleMonthExpansion(`${year}-${month}`)} 
                        style={{ cursor: 'pointer', margin: 0, padding: 5, background: '#f9f9f9' }}
                      >
                        {month}月 ({expandedMonths.has(`${year}-${month}`) ? '閉じる' : '開く'})
                      </h5>
                      {expandedMonths.has(`${year}-${month}`) && (
                        <ul style={{ listStyle: 'none', padding: 0 }}>
                          {monthSubmissions.map(s => (
                            <li key={s.id} style={{ border: '1px solid #ccc', padding: 10, marginBottom: 10, borderRadius: 4 }}>
                              <strong>申請者:</strong> {s.profiles?.name || s.profiles?.email || '不明'} <br />
                              <strong>申請日:</strong> {new Date(s.created_at).toLocaleString()} <br />
                              <strong>ステータス:</strong> {s.status === 'pending' ? '申請中' : s.status === 'approved' ? '承認' : '却下'} <br />
                              <strong>合計金額:</strong> {s.expenses_data.reduce((sum, exp) => sum + (parseInt(exp.amount || '0') || 0), 0)}円 <br />
                              {s.approved_at && (
                                <><strong>承認日:</strong> {new Date(s.approved_at).toLocaleString()} <br /></>
                              )}
                              {s.rejected_at && (
                                <><strong>却下日:</strong> {new Date(s.rejected_at).toLocaleString()} <br /></>
                              )}
                              <ul>
                                {s.expenses_data.map((e, i) => (
                                  <li key={i}>
                                    {e.type === 'regular' ? '定期' : e.type === 'business_trip' ? '出張' : '単発'}: 
                                    {e.type === 'regular' 
                                      ? `${e.start_date || '未設定'} ~ ${e.end_date || '未設定'}` 
                                      : `${e.start_date || '未設定'}`
                                    } | 
                                    {e.from_station} - {e.to_station}: {e.amount}円
                                    {e.notes && ` (備考: ${e.notes})`}
                                  </li>
                                ))}
                              </ul>
                              <button 
                                onClick={() => onApplyTemplate(s)} 
                                style={{ marginTop: 10, padding: '8px 12px' }}
                              >
                                テンプレートとして適用
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ))
              )}
            </div>
          ))
      )}
    </div>
  );
};

export default HistoryView;
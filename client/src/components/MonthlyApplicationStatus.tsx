import React, { useState, useMemo } from 'react';
import type { Submission, AuthUser, Expense } from '../types';

interface ApplicationInfo {
  day: number;
  dayOfWeek: string;
  date: string;
  submissionDate: Date;
  expense: Expense;
}

interface MonthlyApplicationStatusProps {
  user: AuthUser;
  submissions: Submission[];
  userName: string;
}

const MonthlyApplicationStatus: React.FC<MonthlyApplicationStatusProps> = ({
  submissions,
  userName
}) => {
  const [currentDate, setCurrentDate] = useState(new Date());

  // 日本の曜日名
  const dayNames = ['日', '月', '火', '水', '木', '金', '土'];

  // 現在表示中の年月
  const currentYear = currentDate.getFullYear();
  const currentMonth = currentDate.getMonth() + 1;

  // 該当月の申請データを種別別に分類
  const monthlyApplications = useMemo(() => {
    const filteredSubmissions = submissions.filter(submission => {
      const submissionDate = new Date(submission.created_at);
      return submissionDate.getFullYear() === currentYear && 
             submissionDate.getMonth() + 1 === currentMonth;
    });

    const regular: ApplicationInfo[] = [];
    const oneTime: ApplicationInfo[] = [];
    const businessTrip: ApplicationInfo[] = [];

    filteredSubmissions.forEach(submission => {
      const submissionDate = new Date(submission.created_at);
      const day = submissionDate.getDate();
      const dayOfWeek = dayNames[submissionDate.getDay()];
      
      // 各申請の項目を種別別に分類
      submission.expenses_data.forEach(expense => {
        const applicationInfo = {
          day,
          dayOfWeek,
          date: submissionDate.toISOString().split('T')[0],
          submissionDate: submissionDate,
          expense: expense
        };

        if (expense.type === 'regular') {
          regular.push(applicationInfo);
        } else if (expense.type === 'one_time') {
          oneTime.push(applicationInfo);
        } else if (expense.type === 'business_trip') {
          businessTrip.push(applicationInfo);
        }
      });
    });

    return {
      regular: regular.sort((a, b) => a.submissionDate.getTime() - b.submissionDate.getTime()),
      oneTime: oneTime.sort((a, b) => a.submissionDate.getTime() - b.submissionDate.getTime()),
      businessTrip: businessTrip.sort((a, b) => a.submissionDate.getTime() - b.submissionDate.getTime())
    };
  }, [submissions, currentYear, currentMonth]);

  // 前月に移動
  const goToPreviousMonth = () => {
    setCurrentDate(prev => {
      const newDate = new Date(prev);
      newDate.setMonth(prev.getMonth() - 1);
      return newDate;
    });
  };

  // 次月に移動
  const goToNextMonth = () => {
    const today = new Date();
    const nextMonth = new Date(currentDate);
    nextMonth.setMonth(currentDate.getMonth() + 1);
    
    // 未来の月は選択不可
    if (nextMonth <= today) {
      setCurrentDate(nextMonth);
    }
  };

  // 次月ボタンが無効かどうか
  const isNextMonthDisabled = () => {
    const today = new Date();
    const nextMonth = new Date(currentDate);
    nextMonth.setMonth(currentDate.getMonth() + 1);
    return nextMonth > today;
  };

  return (
    <div style={{
      backgroundColor: '#f8f9fa',
      padding: '15px',
      borderRadius: '8px',
      margin: '20px 0',
      border: '1px solid #e9ecef',
      color: '#212529'
    }}>
      {/* ヘッダー部分 */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: '15px'
      }}>
        <h3 style={{ margin: 0, color: '#212529' }}>
          {userName} - {currentYear}年{currentMonth}月申請状況
        </h3>
        
        <div style={{ display: 'flex', gap: '10px' }}>
          <button
            onClick={goToPreviousMonth}
            style={{
              padding: '5px 10px',
              fontSize: '14px',
              backgroundColor: '#6c757d',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer'
            }}
          >
            ← 前月
          </button>
          
          <button
            onClick={goToNextMonth}
            disabled={isNextMonthDisabled()}
            style={{
              padding: '5px 10px',
              fontSize: '14px',
              backgroundColor: isNextMonthDisabled() ? '#ced4da' : '#6c757d',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: isNextMonthDisabled() ? 'not-allowed' : 'pointer'
            }}
          >
            次月 →
          </button>
        </div>
      </div>

      {/* 種別別申請状況表示 */}
      <div>
        {/* 定期申請 */}
        {monthlyApplications.regular.length > 0 && (
          <div style={{ marginBottom: '8px' }}>
            <strong>定期申請: </strong>{monthlyApplications.regular.length}件
            {monthlyApplications.regular.map((app, index) => (
              <div key={`regular-${app.date}-${index}`} style={{ marginLeft: '20px', fontSize: '14px', color: '#212529' }}>
                {currentMonth}/{app.day}({app.dayOfWeek})申請: {app.expense.start_date}〜{app.expense.end_date}
              </div>
            ))}
          </div>
        )}

        {/* 通勤（単発）申請 */}
        {monthlyApplications.oneTime.length > 0 && (
          <div style={{ marginBottom: '8px' }}>
            <strong>通勤（単発）申請: </strong>{monthlyApplications.oneTime.length}日
            <span style={{ marginLeft: '10px' }}>
              (
              {monthlyApplications.oneTime.map((app, index) => (
                <span key={`onetime-${app.date}-${index}`}>
                  {currentMonth}/{app.day}({app.dayOfWeek})
                  {index < monthlyApplications.oneTime.length - 1 ? '、' : ''}
                </span>
              ))}
              )
            </span>
          </div>
        )}

        {/* 出張（園指導等）申請 */}
        {monthlyApplications.businessTrip.length > 0 && (
          <div style={{ marginBottom: '8px' }}>
            <strong>出張（園指導等）申請: </strong>{monthlyApplications.businessTrip.length}日
            <span style={{ marginLeft: '10px' }}>
              (
              {monthlyApplications.businessTrip.map((app, index) => (
                <span key={`business-${app.date}-${index}`}>
                  {currentMonth}/{app.day}({app.dayOfWeek})
                  {index < monthlyApplications.businessTrip.length - 1 ? '、' : ''}
                </span>
              ))}
              )
            </span>
          </div>
        )}

        {/* 申請なしの場合 */}
        {monthlyApplications.regular.length === 0 && 
         monthlyApplications.oneTime.length === 0 && 
         monthlyApplications.businessTrip.length === 0 && (
          <span style={{ color: '#495057' }}>申請なし</span>
        )}
      </div>
    </div>
  );
};

export default MonthlyApplicationStatus;
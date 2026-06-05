import React, { useState, useEffect, useCallback } from 'react';
import type { Expense, AuthUser } from '../types';
import { formatAmount, parseAmount } from '../utils';
import { supabase } from '../lib/supabaseClient';

interface ExpenseFormProps {
  user: AuthUser | null;
  onSubmissionComplete: () => void;
  expenses: Expense[];
  setExpenses: React.Dispatch<React.SetStateAction<Expense[]>>;
  profileName?: string;
}

const ExpenseForm: React.FC<ExpenseFormProps> = ({ user, onSubmissionComplete, expenses, setExpenses, profileName: parentProfileName }) => {
  const [totalAmount, setTotalAmount] = useState(0);
  const [profileName, setProfileName] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string>('');
  const [submitSuccess, setSubmitSuccess] = useState(false);

  // 合計金額を計算
  useEffect(() => {
    const calculatedTotal = expenses.reduce((sum, expense) => {
      const amount = parseInt(expense.amount || '0');
      return sum + (isNaN(amount) ? 0 : amount);
    }, 0);
    setTotalAmount(calculatedTotal);
  }, [expenses]);

  // プロファイル名を取得
  useEffect(() => {
    const fetchProfileName = async () => {
      if (!user) return;
      
      try {
        const { data, error } = await supabase
          .from('profiles')
          .select('name')
          .eq('id', user.id)
          .single();

        if (!error && data && data.name) {
          setProfileName(data.name);
        }
      } catch (error) {
        console.error('プロファイル名の取得に失敗:', error);
      }
    };

    fetchProfileName();
  }, [user]);

  const handleInputChange = useCallback((index: number, field: keyof Expense, value: string) => {
    setExpenses(prev => {
      const newExpenses = [...prev];
      newExpenses[index] = { ...newExpenses[index], [field]: value };
      return newExpenses;
    });
  }, [setExpenses]);

  const handleClearRow = useCallback((index: number) => {
    setExpenses(prev => {
      const newExpenses = [...prev];
      newExpenses[index] = { type: 'one_time', from_station: '', to_station: '', amount: '', start_date: '', end_date: '', workplace: '' };
      return newExpenses;
    });
  }, [setExpenses]);

  const handleAddRow = useCallback(() => {
    setExpenses(prev => {
      return [...prev, { type: 'one_time', from_station: '', to_station: '', amount: '', start_date: '', end_date: '', workplace: '' }];
    });
  }, [setExpenses]);

  const handleRemoveRow = useCallback((index: number) => {
    setExpenses(prev => {
      const newExpenses = [...prev];
      newExpenses.splice(index, 1);
      return newExpenses;
    });
  }, [setExpenses]);

  const handleMakeRoundTrip = useCallback((index: number) => {
    const originalExpense = expenses[index];
    if (!originalExpense || !originalExpense.from_station || !originalExpense.to_station) {
      setFormError('往復にするには、出発駅と到着駅を入力してください。');
      return;
    }

    setExpenses(prev => {
      const newExpenses = [...prev];
      const returnExpense: Expense = {
        ...originalExpense,
        from_station: originalExpense.to_station,
        to_station: originalExpense.from_station,
        start_date: originalExpense.start_date,
        end_date: originalExpense.end_date
      };
      newExpenses.splice(index + 1, 0, returnExpense);
      return newExpenses;
    });
  }, [expenses, setExpenses]);

  const handleSubmit = async () => {
    if (!user) return;

    // 送信中フラグをオンにする
    setIsSubmitting(true);

    const expensesToSubmit = expenses.filter(e =>
      e.from_station.trim() ||
      e.to_station.trim() ||
      e.amount.trim() ||
      (e.type !== 'regular' && e.start_date?.trim()) ||
      (e.type === 'regular' && (e.start_date?.trim() || e.end_date?.trim())) ||
      e.transportation?.trim()
    );

    setFormError('');

    if (expensesToSubmit.length === 0) {
      setFormError('申請する項目がありません。');
      setIsSubmitting(false);
      return;
    }

    const hasRegular = expensesToSubmit.some(expense => expense.type === 'regular');
    const hasOther = expensesToSubmit.some(expense => expense.type !== 'regular');
    if (hasRegular && hasOther) {
      setFormError('定期券の申請と他の申請（単発・出張）は混ぜて申請できません。別々に申請してください。');
      setIsSubmitting(false);
      return;
    }

    for (const expense of expensesToSubmit) {
      if (!expense.from_station.trim()) {
        setFormError('出発駅を入力してください。');
        setIsSubmitting(false);
        return;
      }
      if (!expense.to_station.trim()) {
        setFormError('帰着駅を入力してください。');
        setIsSubmitting(false);
        return;
      }
      const parsedAmount = parseInt(expense.amount.replace(/,/g, ''), 10);
      if (!expense.amount.trim() || isNaN(parsedAmount)) {
        setFormError('金額を正しく入力してください。');
        setIsSubmitting(false);
        return;
      }
      if (expense.type === 'one_time' || expense.type === 'business_trip') {
        if (!expense.start_date?.trim()) {
          setFormError('単発または出張の場合、利用日を入力してください。');
          setIsSubmitting(false);
          return;
        }
      } else if (expense.type === 'regular') {
        if (!expense.start_date?.trim() || !expense.end_date?.trim()) {
          setFormError('定期の場合、開始日と終了日を入力してください。');
          setIsSubmitting(false);
          return;
        }
      }
      if (!expense.transportation?.trim()) {
        setFormError('交通機関を入力してください。');
        setIsSubmitting(false);
        return;
      }
      if (!expense.workplace?.trim()) {
        setFormError('勤務先を入力してください。');
        setIsSubmitting(false);
        return;
      }
    }

    const { error } = await supabase.from('expenses').insert([
      { user_id: user.id, expenses_data: expensesToSubmit, status: 'pending' }
    ]);

    if (error) {
      setFormError('登録に失敗しました: ' + error.message);
      setIsSubmitting(false);
    } else {
      // 🚀 Slack通知を送信
      try {
        // Slackメッセージを作成（シンプル版）
        const applicantName = (parentProfileName || profileName).trim() || user.email;
        const totalAmount = expensesToSubmit.reduce((sum, exp) => sum + (parseInt(exp.amount || '0') || 0), 0);
        
        const slackPayload = {
          expense: {
            user_name: applicantName,
            date: new Date().toLocaleDateString('ja-JP'),
            total_amount: totalAmount,
            items_count: expensesToSubmit.length,
            items: expensesToSubmit.map(item => ({
              type: item.type,
              from_station: item.from_station,
              to_station: item.to_station,
              amount: item.amount,
              start_date: item.start_date,
              end_date: item.end_date,
              notes: item.notes,
              transportation: item.transportation
            }))
          }
        };

        const { error: slackInvokeError } = await supabase.functions.invoke('slack-notify', {
          body: slackPayload,
        });
        if (slackInvokeError) throw slackInvokeError;
      } catch (slackError) {
        console.error('Slack通知の送信に失敗:', slackError);
        // エラーでも申請は成功させる
      }
      
      setSubmitSuccess(true);
      setFormError('');
      setExpenses([{ type: 'one_time', from_station: '', to_station: '', amount: '', start_date: '', end_date: '', workplace: '' }]);
      onSubmissionComplete();

      setTimeout(() => {
        setIsSubmitting(false);
        setSubmitSuccess(false);
      }, 6000);
    }
  };

  return (
    <div>
      <h2 style={{ textAlign: 'center' }}>ファイブM 交通費精算フォーム</h2>

      
      <div style={{ 
        backgroundColor: '#f8f9fa', 
        border: '1px solid #dee2e6', 
        borderRadius: '8px', 
        padding: '16px', 
        margin: '16px 0',
        fontSize: '14px',
        lineHeight: '1.6'
      }}>
        <div style={{ marginBottom: '8px', color: '#000' }}>
          📋 申請は「まとめて申請」 ・ 「都度申請」どちらでも大丈夫です。<br />
          申請履歴をテンプレートとして使用できます。
        </div>
        <div style={{ 
          padding: '12px', 
          backgroundColor: '#fff3cd', 
          border: '1px solid #ffeaa7', 
          borderRadius: '6px',
          color: '#856404'
        }}>
          <strong>⚠️</strong> 定期券の申請と他の申請（単発・出張）は混ぜないでください。別々に申請してください。
        </div>
      </div>
      
      <form>
        {expenses.map((expense, index) => (
          <div key={index} className="expense-row">
            <span className="expense-number">{index + 1}</span>
            <select
              value={expense.type}
              onChange={(e) => handleInputChange(index, 'type', e.target.value as 'regular' | 'business_trip' | 'one_time')}
              className="expense-input single-select"
            >
              <option value="one_time">通勤（単発）</option>
              <option value="regular">定期</option>
              <option value="business_trip">出張（園指導等）</option>
            </select>
            
            {(expense.type === 'one_time' || expense.type === 'business_trip') && (
              <div className="date-input-wrapper" data-hasvalue={Boolean(expense.start_date)}>
                <input
                  type="date"
                  value={expense.start_date || ''}
                  onChange={(e) => handleInputChange(index, 'start_date', e.target.value)}
                  className="expense-input date-input"
                  required
                />
                <span className="date-placeholder">利用日</span>
              </div>
            )}
            
            {expense.type === 'regular' && (
              <>
                <div className="date-input-wrapper" data-hasvalue={Boolean(expense.start_date)}>
                  <input
                    type="date"
                    value={expense.start_date || ''}
                    onChange={(e) => handleInputChange(index, 'start_date', e.target.value)}
                    className="expense-input date-input"
                    required
                  />
                  <span className="date-placeholder">開始日</span>
                </div>
                <div className="date-input-wrapper" data-hasvalue={Boolean(expense.end_date)}>
                  <input
                    type="date"
                    value={expense.end_date || ''}
                    onChange={(e) => handleInputChange(index, 'end_date', e.target.value)}
                    className="expense-input date-input"
                    required
                  />
                  <span className="date-placeholder">終了日</span>
                </div>
              </>
            )}
            
            <input
              type="text"
              placeholder="交通機関(JR,阪急,市バス)"
              value={expense.transportation || ''}
              onChange={(e) => handleInputChange(index, 'transportation', e.target.value)}
              className="expense-input transportation-input"
            />
            
            <input
              type="text"
              placeholder="出発駅"
              value={expense.from_station}
              onChange={(e) => handleInputChange(index, 'from_station', e.target.value)}
              className="expense-input"
            />
            
            <input
              type="text"
              placeholder="帰着駅"
              value={expense.to_station}
              onChange={(e) => handleInputChange(index, 'to_station', e.target.value)}
              className="expense-input"
            />
            
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              placeholder="金額"
              value={formatAmount(expense.amount)}
              onChange={(e) => handleInputChange(index, 'amount', parseAmount(e.target.value))}
              className="expense-input amount-input"
            />
            
            <input
              type="text"
              placeholder="勤務先"
              value={expense.workplace || ''}
              onChange={(e) => handleInputChange(index, 'workplace', e.target.value)}
              className="expense-input workplace-input"
              style={{ maxWidth: '120px' }}
            />
            
            <input
              type="text"
              placeholder={expense.type === 'regular' ? "備考（経由地がある場合はご記入ください）" : "備考"}
              value={expense.notes || ''}
              onChange={(e) => handleInputChange(index, 'notes', e.target.value)}
              className="expense-input notes-input"
            />
            
            <div style={{ display: 'flex', gap: '5px', marginTop: '5px' }}>
              <button 
                type="button" 
                onClick={() => handleClearRow(index)} 
                style={{ 
                  width: 24, 
                  height: 24, 
                  background: 'black', 
                  color: 'white', 
                  border: 'none', 
                  borderRadius: '50%', 
                  cursor: 'pointer', 
                  display: 'flex', 
                  justifyContent: 'center', 
                  alignItems: 'center', 
                  fontSize: '0.8em', 
                  fontWeight: 'bold' 
                }}
              >
                x
              </button>
              
              {expense.type !== 'regular' && (
                <button 
                  type="button" 
                  onClick={() => handleMakeRoundTrip(index)} 
                  style={{ 
                    padding: '8px 12px', 
                    background: '#28a745', 
                    color: 'white', 
                    border: 'none', 
                    borderRadius: 4, 
                    cursor: 'pointer' 
                  }}
                >
                  往復
                </button>
              )}
              
              {expenses.length > 1 && (
                <button 
                  type="button" 
                  onClick={() => handleRemoveRow(index)} 
                  style={{ 
                    width: 24, 
                    height: 24, 
                    background: '#dc3545', 
                    color: 'white', 
                    border: 'none', 
                    borderRadius: '50%', 
                    cursor: 'pointer', 
                    display: 'flex', 
                    justifyContent: 'center', 
                    alignItems: 'center', 
                    fontSize: '0.8em', 
                    fontWeight: 'bold' 
                  }}
                >
                  -
                </button>
              )}
            </div>
          </div>
        ))}
        
        <button 
          type="button" 
          onClick={handleAddRow} 
          style={{ 
            width: '100%', 
            padding: 10, 
            marginTop: 10, 
            background: '#6c757d', 
            color: 'white', 
            border: 'none', 
            borderRadius: 4, 
            cursor: 'pointer' 
          }}
        >
          行を追加
        </button>
        
        <div style={{ textAlign: 'right', marginTop: 10, fontSize: '1.2em', fontWeight: 'bold' }}>
          合計金額: {formatAmount(totalAmount.toString())}円
        </div>
        
        <button
          type="button"
          onClick={handleSubmit}
          disabled={isSubmitting}
          style={{
            width: '100%',
            padding: 10,
            marginTop: 20,
            background: isSubmitting ? '#6c757d' : '#007bff',
            color: 'white',
            border: 'none',
            borderRadius: 4,
            cursor: isSubmitting ? 'not-allowed' : 'pointer',
            opacity: isSubmitting ? 0.6 : 1
          }}
        >
          {isSubmitting ? '送信中...' : '申請する'}
        </button>

        {formError && (
          <div style={{
            background: '#f8d7da', border: '1px solid #f5c6cb', borderRadius: 8,
            padding: '12px 16px', marginTop: 12, color: '#721c24', fontSize: 14,
            display: 'flex', alignItems: 'center', gap: 8,
          }}>
            <span style={{ fontSize: 18 }}>⚠️</span>
            <span>{formError}</span>
            <button onClick={() => setFormError('')} style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: '#721c24', fontSize: 18, lineHeight: 1 }}>✕</button>
          </div>
        )}

        {submitSuccess && (
          <div style={{
            background: '#d4edda', border: '1px solid #c3e6cb', borderRadius: 8,
            padding: '14px 16px', marginTop: 12, color: '#155724', fontSize: 15,
            display: 'flex', alignItems: 'center', gap: 8, fontWeight: 'bold',
          }}>
            <span style={{ fontSize: 20 }}>✅</span>
            <span>登録しました。承認をお待ちください。</span>
          </div>
        )}
      </form>
    </div>
  );
};

export default ExpenseForm;
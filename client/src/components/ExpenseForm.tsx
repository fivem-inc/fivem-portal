import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import type { Expense, AuthUser } from '../types';
import { formatAmount, parseAmount } from '../utils';
import { supabase } from '../lib/supabaseClient';
import { useDarkMode } from '../hooks/useDarkMode';

// タップで即確定するカスタム日付ピッカー
const SingleDatePicker: React.FC<{
  value: string;
  onChange: (date: string) => void;
  onClose: () => void;
}> = ({ value, onChange, onClose }) => {
  const today = new Date();
  const initYear = value ? parseInt(value.slice(0, 4)) : today.getFullYear();
  const initMonth = value ? parseInt(value.slice(5, 7)) - 1 : today.getMonth();
  const [viewYear, setViewYear] = useState(initYear);
  const [viewMonth, setViewMonth] = useState(initMonth);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const firstDay = new Date(viewYear, viewMonth, 1).getDay();
  const monthNames = ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];
  const dayNames = ['日','月','火','水','木','金','土'];
  const todayStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
  const cells: (number|null)[] = [];
  for (let i = 0; i < firstDay; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  const fmt = (y: number, m: number, d: number) =>
    `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;

  const prevMonth = () => { if (viewMonth === 0) { setViewYear(y => y-1); setViewMonth(11); } else setViewMonth(m => m-1); };
  const nextMonth = () => { if (viewMonth === 11) { setViewYear(y => y+1); setViewMonth(0); } else setViewMonth(m => m+1); };

  return (
    <div ref={ref} style={{
      position: 'fixed', zIndex: 500, background: 'white', border: '1px solid #ccc',
      borderRadius: 10, padding: 10, boxShadow: '0 4px 16px rgba(0,0,0,0.2)',
      width: 'min(300px, 90vw)',
      top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <button onClick={prevMonth} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', padding: '0 10px' }}>‹</button>
        <span style={{ fontWeight: 'bold', fontSize: 14 }}>{viewYear}年 {monthNames[viewMonth]}</span>
        <button onClick={nextMonth} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', padding: '0 10px' }}>›</button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2, marginBottom: 4 }}>
        {dayNames.map((d, i) => (
          <div key={d} style={{ textAlign: 'center', fontSize: 11, fontWeight: 'bold', color: i===0?'#e74c3c':i===6?'#3498db':'#666', padding: '2px 0' }}>{d}</div>
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2 }}>
        {cells.map((day, i) => {
          if (!day) return <div key={`e-${i}`} />;
          const dateStr = fmt(viewYear, viewMonth, day);
          const isSelected = dateStr === value;
          const isToday = dateStr === todayStr;
          const dow = (firstDay + day - 1) % 7;
          return (
            <button key={dateStr} onClick={() => { onChange(dateStr); onClose(); }} style={{
              padding: '8px 2px', minHeight: 36, borderRadius: 6,
              border: isToday ? '2px solid #007bff' : '1px solid transparent',
              background: isSelected ? '#007bff' : 'transparent',
              color: isSelected ? 'white' : dow===0 ? '#e74c3c' : dow===6 ? '#3498db' : '#333',
              cursor: 'pointer', fontSize: 13, fontWeight: isSelected ? 'bold' : 'normal',
            }}>{day}</button>
          );
        })}
      </div>
      {value && (
        <div style={{ textAlign: 'center', marginTop: 8, fontSize: 12, color: '#666' }}>
          選択中: {value}
          <button onClick={() => { onChange(''); onClose(); }} style={{ marginLeft: 8, fontSize: 11, color: '#dc3545', background: 'none', border: 'none', cursor: 'pointer' }}>クリア</button>
        </div>
      )}
    </div>
  );
};

interface ExpenseFormProps {
  user: AuthUser | null;
  onSubmissionComplete: () => void;
  expenses: Expense[];
  setExpenses: React.Dispatch<React.SetStateAction<Expense[]>>;
  profileName?: string;
}

const TRANSPORT_PRESETS = ['JR', '阪急', '京阪', '京都地下鉄', '京都市バス'];

const ExpenseForm: React.FC<ExpenseFormProps> = ({ user, onSubmissionComplete, expenses, setExpenses, profileName: parentProfileName }) => {
  const totalAmount = useMemo(() => {
    return expenses.reduce((sum, expense) => {
      const amount = parseInt(parseAmount(expense.amount || '0'), 10);
      return sum + (isNaN(amount) ? 0 : amount);
    }, 0);
  }, [expenses]);
  const [profileName, setProfileName] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string>('');
  const [locationsByCategory, setLocationsByCategory] = useState<Record<string, string[]>>({});
  const [workplaceOptions, setWorkplaceOptions] = useState<string[]>([]);
  const [customExpenseTypes, setCustomExpenseTypes] = useState<string[]>([]);
  const [expenseTypeLabels, setExpenseTypeLabels] = useState<{ sort_order: number; value: string }[]>([]);
  const [submitSuccess, setSubmitSuccess] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [confirmedExpenses, setConfirmedExpenses] = useState<typeof expenses>([]);
  // 日付ピッカー表示管理: key = `${rowIndex}-start` | `${rowIndex}-end`
  const [openDatePicker, setOpenDatePicker] = useState<string | null>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const isDarkMode = useDarkMode();

  // エラー発生時に自動スクロール
  useEffect(() => {
    if (formError && errorRef.current) {
      errorRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [formError]);


  // 区分・場所リストを取得
  useEffect(() => {
    const fetchMasterOptions = async () => {
      const { data } = await supabase.from('master_options').select('category, value, sort_order').order('sort_order');
      if (data) {
        const locs: Record<string, string[]> = {};
        data.filter(r => r.category.startsWith('trip_location_')).forEach(r => {
          const cat = r.category.replace('trip_location_', '');
          if (!locs[cat]) locs[cat] = [];
          locs[cat].push(r.value);
        });
        setLocationsByCategory(locs);
        setWorkplaceOptions(data.filter(r => r.category === 'workplace').map(r => r.value));
        setCustomExpenseTypes(data.filter(r => r.category === 'expense_type').map(r => r.value));
        setExpenseTypeLabels(data.filter(r => r.category === 'expense_type_label').map(r => ({ sort_order: r.sort_order, value: r.value })));
      }
    };
    fetchMasterOptions();
  }, []);

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

  const handleMultiUpdate = useCallback((index: number, fields: Partial<Expense>) => {
    setExpenses(prev => {
      const next = [...prev];
      next[index] = { ...next[index], ...fields };
      return next;
    });
  }, [setExpenses]);

  const handleClearRow = useCallback((index: number) => {
    setExpenses(prev => {
      const newExpenses = [...prev];
      newExpenses[index] = { type: 'one_time', from_station: '', to_station: '', amount: '', start_date: '', end_date: '', transportation: '', workplace: '', trip_category: '', type_other: '', transportation_other: '', workplace_other: '' };
      return newExpenses;
    });
  }, [setExpenses]);

  const handleAddRow = useCallback(() => {
    setExpenses(prev => {
      return [...prev, { type: 'one_time', from_station: '', to_station: '', amount: '', start_date: '', end_date: '', transportation: '', workplace: '', trip_category: '', type_other: '', transportation_other: '', workplace_other: '' }];
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

  // バリデーションして確認モーダルを表示
  const handleValidateAndConfirm = () => {
    if (!user) return;
    setFormError('');

    const expensesToSubmit = expenses.filter(e =>
      e.from_station.trim() || e.to_station.trim() || e.amount.trim() ||
      (e.type !== 'regular' && e.start_date?.trim()) ||
      (e.type === 'regular' && (e.start_date?.trim() || e.end_date?.trim())) ||
      e.transportation?.trim()
    );

    if (expensesToSubmit.length === 0) { setFormError('申請する項目がありません。'); return; }

    const hasRegular = expensesToSubmit.some(e => e.type === 'regular');
    const hasOther = expensesToSubmit.some(e => e.type !== 'regular');
    if (hasRegular && hasOther) { setFormError('定期券の申請と他の申請（単発・出張）は混ぜて申請できません。別々に申請してください。'); return; }

    for (const expense of expensesToSubmit) {
      if (!expense.from_station.trim()) { setFormError('出発駅を入力してください。'); return; }
      if (!expense.to_station.trim()) { setFormError('帰着駅を入力してください。'); return; }
      const parsedAmount = parseInt(expense.amount.replace(/,/g, ''), 10);
      if (!expense.amount.trim() || isNaN(parsedAmount)) { setFormError('金額を正しく入力してください。'); return; }
      if ((expense.type === 'one_time' || expense.type === 'business_trip' || expense.type === 'other') && !expense.start_date?.trim()) {
        setFormError('利用日を入力してください。'); return;
      }
      if (expense.type === 'regular' && (!expense.start_date?.trim() || !expense.end_date?.trim())) {
        setFormError('定期の場合、開始日と終了日を入力してください。'); return;
      }
      const effectiveTransport = expense.transportation === 'その他' ? expense.transportation_other : expense.transportation;
      if (!effectiveTransport?.trim()) { setFormError('交通機関を入力してください。'); return; }
      if (expense.type === 'business_trip' && !expense.trip_category?.trim()) { setFormError('区分を選択してください。'); return; }
      const effectiveWorkplace = expense.workplace === 'その他' ? expense.workplace_other : expense.workplace;
      if (!effectiveWorkplace?.trim()) { setFormError('勤務先を入力してください。'); return; }
    }

    // 送信前に transportation/workplace の "その他" テキストをマージ
    const mergeExpense = (e: typeof expensesToSubmit[0]) => ({
      ...e,
      transportation: e.transportation === 'その他' ? (e.transportation_other || '') : (e.transportation || ''),
      workplace: e.workplace === 'その他' ? (e.workplace_other || '') : (e.workplace || ''),
    });
    setConfirmedExpenses(expensesToSubmit.map(mergeExpense));
    setShowConfirm(true);
  };

  // 確認後の実際の送信
  const handleSubmit = async () => {
    if (!user) return;
    setShowConfirm(false);
    setIsSubmitting(true);
    const expensesToSubmit = confirmedExpenses;

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
            {(() => {
              // カスタム区分選択中かどうかを判定
              const isCustomType = expense.type === 'other' && !!expense.type_other && customExpenseTypes.includes(expense.type_other);
              const typeSelectValue = isCustomType ? `custom:${expense.type_other}` : expense.type;
              return (
                <>
                  {(() => {
                    const ORDER_TO_TYPE: Record<number, string> = { 1: 'one_time', 2: 'regular', 3: 'business_trip', 4: 'other' };
                    const getLabel = (sortOrder: number, fallback: string) =>
                      expenseTypeLabels.find(l => l.sort_order === sortOrder)?.value ?? fallback;
                    return (
                      <select
                        value={typeSelectValue}
                        onChange={(e) => {
                          const val = e.target.value;
                          if (val.startsWith('custom:')) {
                            const label = val.slice(7);
                            handleMultiUpdate(index, { type: 'other', type_other: label, trip_category: '', workplace: '', workplace_other: '' });
                          } else {
                            handleMultiUpdate(index, { type: val as Expense['type'], type_other: '', trip_category: '', workplace: '', workplace_other: '' });
                          }
                        }}
                        className="expense-input single-select"
                      >
                        <option value="one_time">{getLabel(1, '通勤（単発）')}</option>
                        <option value="regular">{getLabel(2, '定期')}</option>
                        <option value="business_trip">{getLabel(3, '出張（園指導等）')}</option>
                        {customExpenseTypes.map(ct => (
                          <option key={ct} value={`custom:${ct}`}>{ct}</option>
                        ))}
                        <option value="other">{getLabel(4, 'その他')}</option>
                      </select>
                    );
                    void ORDER_TO_TYPE;
                  })()}
                  {expense.type === 'other' && !isCustomType && (
                    <input
                      type="text"
                      placeholder="内容を入力"
                      value={expense.type_other || ''}
                      onChange={(e) => handleInputChange(index, 'type_other', e.target.value)}
                      className="expense-input"
                      style={{ minWidth: 120, maxWidth: 200 }}
                    />
                  )}
                </>
              );
            })()}
            
            {(expense.type === 'one_time' || expense.type === 'business_trip') && (
              <div style={{ position: 'relative' }}>
                <button type="button" onClick={() => setOpenDatePicker(openDatePicker === `${index}-start` ? null : `${index}-start`)}
                  className="expense-input date-input"
                  style={{ textAlign: 'left', cursor: 'pointer', background: isDarkMode ? '#495057' : (expense.start_date ? 'white' : '#f8f9fa'), color: expense.start_date ? (isDarkMode ? '#fff' : '#333') : (isDarkMode ? '#adb5bd' : '#999') }}
                >
                  {expense.start_date || '利用日'}
                </button>
                {openDatePicker === `${index}-start` && (
                  <SingleDatePicker value={expense.start_date || ''} onChange={v => handleInputChange(index, 'start_date', v)} onClose={() => setOpenDatePicker(null)} />
                )}
              </div>
            )}

            {expense.type === 'regular' && (
              <>
                <div style={{ position: 'relative' }}>
                  <button type="button" onClick={() => setOpenDatePicker(openDatePicker === `${index}-start` ? null : `${index}-start`)}
                    className="expense-input date-input"
                    style={{ textAlign: 'left', cursor: 'pointer', background: isDarkMode ? '#495057' : (expense.start_date ? 'white' : '#f8f9fa'), color: expense.start_date ? (isDarkMode ? '#fff' : '#333') : (isDarkMode ? '#adb5bd' : '#999') }}
                  >
                    {expense.start_date || '開始日'}
                  </button>
                  {openDatePicker === `${index}-start` && (
                    <SingleDatePicker value={expense.start_date || ''} onChange={v => handleInputChange(index, 'start_date', v)} onClose={() => setOpenDatePicker(null)} />
                  )}
                </div>
                <div style={{ position: 'relative' }}>
                  <button type="button" onClick={() => setOpenDatePicker(openDatePicker === `${index}-end` ? null : `${index}-end`)}
                    className="expense-input date-input"
                    style={{ textAlign: 'left', cursor: 'pointer', background: isDarkMode ? '#495057' : (expense.end_date ? 'white' : '#f8f9fa'), color: expense.end_date ? (isDarkMode ? '#fff' : '#333') : (isDarkMode ? '#adb5bd' : '#999') }}
                  >
                    {expense.end_date || '終了日'}
                  </button>
                  {openDatePicker === `${index}-end` && (
                    <SingleDatePicker value={expense.end_date || ''} onChange={v => handleInputChange(index, 'end_date', v)} onClose={() => setOpenDatePicker(null)} />
                  )}
                </div>
              </>
            )}
            
            <select
              value={expense.transportation || ''}
              onChange={(e) => {
                handleMultiUpdate(index, { transportation: e.target.value, transportation_other: '' });
              }}
              className="expense-input"
              style={{ minWidth: 110, maxWidth: 140 }}
            >
              <option value="">交通機関</option>
              {TRANSPORT_PRESETS.map(t => <option key={t} value={t}>{t}</option>)}
              <option value="その他">その他</option>
            </select>
            {expense.transportation === 'その他' && (
              <input
                type="text"
                placeholder="交通機関を入力"
                value={expense.transportation_other || ''}
                onChange={(e) => handleInputChange(index, 'transportation_other', e.target.value)}
                className="expense-input"
                style={{ minWidth: 120, maxWidth: 180 }}
              />
            )}
            
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
            
            {expense.type === 'other' ? (
              <input
                type="text"
                placeholder="勤務先を入力"
                value={expense.workplace || ''}
                onChange={(e) => handleInputChange(index, 'workplace', e.target.value)}
                className="expense-input"
                style={{ minWidth: 120, maxWidth: 180 }}
              />
            ) : expense.type === 'business_trip' ? (
              <>
                <select
                  value={expense.workplace || ''}
                  onChange={(e) => handleMultiUpdate(index, { workplace: e.target.value, workplace_other: '' })}
                  className="expense-input"
                  style={{ minWidth: 130, maxWidth: 200 }}
                >
                  <option value="">勤務先</option>
                  {Object.values(locationsByCategory).flat().map(loc => (
                    <option key={loc} value={loc}>{loc}</option>
                  ))}
                  <option value="その他">その他</option>
                </select>
                {expense.workplace === 'その他' && (
                  <input
                    type="text"
                    placeholder="場所を入力"
                    value={expense.workplace_other || ''}
                    onChange={(e) => handleInputChange(index, 'workplace_other', e.target.value)}
                    className="expense-input"
                    style={{ minWidth: 120, maxWidth: 180 }}
                  />
                )}
              </>
            ) : (
              <>
                <select
                  value={expense.workplace || ''}
                  onChange={(e) => handleMultiUpdate(index, { workplace: e.target.value, workplace_other: '' })}
                  className="expense-input"
                  style={{ minWidth: 110, maxWidth: 160 }}
                >
                  <option value="">勤務先</option>
                  {workplaceOptions.map(s => <option key={s} value={s}>{s}</option>)}
                  <option value="その他">その他</option>
                </select>
                {expense.workplace === 'その他' && (
                  <input
                    type="text"
                    placeholder="勤務先を入力"
                    value={expense.workplace_other || ''}
                    onChange={(e) => handleInputChange(index, 'workplace_other', e.target.value)}
                    className="expense-input"
                    style={{ minWidth: 120, maxWidth: 180 }}
                  />
                )}
              </>
            )}
            
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
                  <span translate="no">往復</span>
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
          onClick={handleValidateAndConfirm}
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
          <div ref={errorRef} style={{
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

      {/* 確認モーダル */}
      {showConfirm && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.6)', zIndex: 1000,
          display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
        }} onClick={() => setShowConfirm(false)}>
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: 'white', borderRadius: '16px 16px 0 0',
              padding: '24px 20px', width: '100%', maxWidth: 480,
              maxHeight: '80vh', overflowY: 'auto',
            }}
          >
            <h3 style={{ margin: '0 0 16px', fontSize: 17, textAlign: 'center', color: '#333' }}>
              📋 申請内容の確認
            </h3>

            {confirmedExpenses.map((e, i) => {
              const typeLabel = e.type === 'regular' ? '⭐定期' : e.type === 'business_trip' ? `出張（${e.trip_category || ''}）` : e.type === 'other' ? (e.type_other || 'その他') : '単発';
              const dateLabel = e.type === 'regular'
                ? `${e.start_date} 〜 ${e.end_date}`
                : e.start_date;
              return (
                <div key={i} style={{
                  background: '#f8f9fa', borderRadius: 8, padding: '12px 14px',
                  marginBottom: 10, fontSize: 14, color: '#333',
                }}>
                  <div style={{ fontWeight: 'bold', marginBottom: 4 }}>{i + 1}. {typeLabel}　{e.transportation}</div>
                  <div>{e.from_station} → {e.to_station}</div>
                  <div>{dateLabel}　　<strong>{formatAmount(e.amount)}円</strong></div>
                  {e.workplace && <div style={{ color: '#666', fontSize: 12 }}>勤務先: {e.workplace}</div>}
                  {e.notes && <div style={{ color: '#666', fontSize: 12 }}>備考: {e.notes}</div>}
                </div>
              );
            })}

            <div style={{ textAlign: 'right', fontWeight: 'bold', fontSize: 16, margin: '12px 0 20px' }}>
              合計: {formatAmount(confirmedExpenses.reduce((s, e) => s + (parseInt(e.amount.replace(/,/g, '')) || 0), 0).toString())}円
            </div>

            <div style={{ display: 'flex', gap: 10 }}>
              <button
                onClick={() => setShowConfirm(false)}
                style={{ flex: 1, padding: 12, background: '#6c757d', color: 'white', border: 'none', borderRadius: 8, fontSize: 15, cursor: 'pointer' }}
              >
                修正する
              </button>
              <button
                onClick={handleSubmit}
                disabled={isSubmitting}
                style={{ flex: 2, padding: 12, background: '#007bff', color: 'white', border: 'none', borderRadius: 8, fontSize: 15, fontWeight: 'bold', cursor: 'pointer' }}
              >
                {isSubmitting ? '送信中...' : '✅ この内容で申請する'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ExpenseForm;
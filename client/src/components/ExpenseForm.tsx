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
        <button type="button" onClick={prevMonth} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', padding: '0 10px', color: '#333' }}>‹</button>
        <span style={{ fontWeight: 'bold', fontSize: 14, color: '#333' }}>{viewYear}年 {monthNames[viewMonth]}</span>
        <button type="button" onClick={nextMonth} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', padding: '0 10px', color: '#333' }}>›</button>
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
            <button key={dateStr} type="button" onClick={() => { onChange(dateStr); onClose(); }} style={{
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
          <button type="button" onClick={() => { onChange(''); onClose(); }} style={{ marginLeft: 8, fontSize: 11, color: '#dc3545', background: 'none', border: 'none', cursor: 'pointer' }}>クリア</button>
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
  pendingTemplates?: Expense[];
  onTemplateApplied?: () => void;
}

const TRANSPORT_PRESETS = ['JR', '阪急', '京阪', '京都地下鉄', '京都市バス'];

const ExpenseForm: React.FC<ExpenseFormProps> = ({ user, onSubmissionComplete, expenses, setExpenses, profileName: parentProfileName, pendingTemplates, onTemplateApplied }) => {
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
  const [recentTemplates, setRecentTemplates] = useState<Expense[]>([]);
  const [showAllTemplates, setShowAllTemplates] = useState(false);
  const [highlightFields, setHighlightFields] = useState<Set<string>>(new Set());
  const emptyDraft: Expense = { type: 'one_time', from_station: '', to_station: '', amount: '', start_date: '', end_date: '', transportation: '', workplace: '', trip_category: '', type_other: '', transportation_other: '', workplace_other: '', notes: '' };
  const [draftExpense, setDraftExpense] = useState<Expense>(emptyDraft);
  const [draftDatePicker, setDraftDatePicker] = useState<string | null>(null);
  const [showTransportPicker, setShowTransportPicker] = useState(false);
  const [templateQueue, setTemplateQueue] = useState<Expense[]>([]);
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

  useEffect(() => {
    if (!user) return;
    const fetchRecentTemplates = async () => {
      const { data } = await supabase
        .from('expenses')
        .select('expenses_data, created_at')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(50);
      if (!data) return;

      // 頻度カウント + 最新のアイテムを保持
      const countMap = new Map<string, { count: number; item: Expense; lastUsed: string }>();
      for (const row of data) {
        const items: Expense[] = row.expenses_data || [];
        for (const item of items) {
          if (!item.from_station || !item.to_station) continue;
          const key = `${item.type}|${item.from_station}|${item.to_station}|${item.transportation}`;
          const existing = countMap.get(key);
          if (existing) {
            existing.count += 1;
          } else {
            countMap.set(key, { count: 1, item: { ...item, start_date: '', end_date: '' }, lastUsed: row.created_at });
          }
        }
      }

      // 頻度降順→最新順でソート、上位5件
      const sorted = Array.from(countMap.values())
        .sort((a, b) => b.count - a.count || b.lastUsed.localeCompare(a.lastUsed))
        .slice(0, 10)
        .map(v => v.item);

      setRecentTemplates(sorted);
    };
    fetchRecentTemplates();
  }, [user]);

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


  const handleRemoveRow = useCallback((index: number) => {
    setExpenses(prev => {
      const newExpenses = [...prev];
      newExpenses.splice(index, 1);
      return newExpenses;
    });
  }, [setExpenses]);

  // 保存済みexpenseをドラフト形式に変換（transportationやworkplaceがマージされている場合を戻す）
  const toDraft = useCallback((item: Expense): Expense => {
    const t = item.transportation || '';
    const w = item.workplace || '';
    // 複数選択対応: ・区切りで分割し全てプリセットかチェック
    const tParts = t.split('・').filter(Boolean);
    const tIsPreset = t === '' || tParts.every(p => TRANSPORT_PRESETS.includes(p) || p === 'その他');
    const wIsPreset = item.type === 'other' || workplaceOptions.includes(w) || Object.values(locationsByCategory).flat().includes(w) || w === '' || w === 'その他';
    return {
      ...item,
      start_date: '',
      end_date: '',
      transportation: tIsPreset ? t : 'その他',
      transportation_other: tIsPreset ? (item.transportation_other || '') : t,
      workplace: wIsPreset ? w : 'その他',
      workplace_other: wIsPreset ? (item.workplace_other || '') : w,
    };
  }, [workplaceOptions, locationsByCategory]);

  // テンプレートキュー処理
  useEffect(() => {
    if (!pendingTemplates || pendingTemplates.length === 0) return;
    setDraftExpense(toDraft(pendingTemplates[0]));
    setTemplateQueue(pendingTemplates.slice(1));
    setHighlightFields(new Set(['start_date']));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingTemplates]);

  const validateDraft = useCallback(() => {
    // 定期と単発・出張の混在チェック
    if (expenses.length > 0) {
      const hasRegular = expenses.some(e => e.type === 'regular');
      const hasOther = expenses.some(e => e.type !== 'regular');
      if (draftExpense.type === 'regular' && hasOther) {
        setFormError('定期券と単発・出張の申請は混ぜられません。先に追加済みの申請を送信してから、定期券を別途申請してください。');
        return false;
      }
      if (draftExpense.type !== 'regular' && hasRegular) {
        setFormError('定期券と単発・出張の申請は混ぜられません。先に追加済みの申請を送信してから、単発・出張を別途申請してください。');
        return false;
      }
    }

    const missing: string[] = [];
    const selectedTransports = (draftExpense.transportation || '').split('・').filter(Boolean);
    if (selectedTransports.length === 0) missing.push('交通機関');
    if (selectedTransports.includes('その他') && !draftExpense.transportation_other?.trim()) missing.push('交通機関（その他）');
    if (!draftExpense.from_station) missing.push('出発駅');
    if (!draftExpense.to_station) missing.push('帰着駅');
    if (draftExpense.amount === '' || draftExpense.amount === undefined) missing.push('金額');
    const effectiveWorkplace = draftExpense.workplace === 'その他' ? draftExpense.workplace_other : draftExpense.workplace;
    if (!effectiveWorkplace?.trim()) missing.push('勤務先');
    if (draftExpense.type !== 'regular' && !draftExpense.start_date) missing.push('利用日');
    if (draftExpense.type === 'regular' && !draftExpense.start_date) missing.push('開始日');
    if (draftExpense.type === 'regular' && !draftExpense.end_date) missing.push('終了日');
    if (missing.length > 0) {
      setFormError(`未入力の必須項目があります：${missing.join('、')}`);
      const fieldMap: Record<string, string> = {
        '交通機関': 'transportation', '交通機関（その他）': 'transportation_other',
        '出発駅': 'from_station', '帰着駅': 'to_station', '金額': 'amount',
        '利用日': 'start_date', '開始日': 'start_date', '終了日': 'end_date', '勤務先': 'workplace'
      };
      setHighlightFields(new Set(missing.map(m => fieldMap[m]).filter(Boolean)));
      return false;
    }
    // 定期：終了日が開始日より前はNG
    if (draftExpense.type === 'regular' && draftExpense.start_date && draftExpense.end_date) {
      if (draftExpense.end_date < draftExpense.start_date) {
        setFormError('終了日は開始日より後の日付を入力してください。');
        return false;
      }
    }
    return true;
  }, [draftExpense, expenses]);

  const handleAddDraft = useCallback(() => {
    if (!validateDraft()) return;
    setExpenses(prev => [...prev, { ...draftExpense }]);
    if (templateQueue.length > 0) {
      setDraftExpense(toDraft(templateQueue[0]));
      setTemplateQueue(prev => prev.slice(1));
      setHighlightFields(new Set(['start_date']));
    } else {
      setDraftExpense(emptyDraft);
      setHighlightFields(new Set());
      if (onTemplateApplied) onTemplateApplied();
    }
    setFormError('');
  }, [draftExpense, emptyDraft, setExpenses, templateQueue, onTemplateApplied, validateDraft]);

  const handleAddRoundTripDraft = useCallback(() => {
    if (!validateDraft()) return;
    const returnExpense: Expense = { ...draftExpense, from_station: draftExpense.to_station, to_station: draftExpense.from_station };
    setExpenses(prev => [...prev, { ...draftExpense }, returnExpense]);
    setDraftExpense(emptyDraft);
    if (onTemplateApplied) onTemplateApplied();
    setFormError('');
  }, [draftExpense, emptyDraft, setExpenses, onTemplateApplied, validateDraft]);


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
      const transportParts = (expense.transportation || '').split('・').filter(Boolean);
      const effectiveTransport = transportParts.map(p => p === 'その他' ? (expense.transportation_other || '') : p).filter(Boolean).join('・');
      if (!effectiveTransport?.trim()) { setFormError('交通機関を入力してください。'); return; }
      const effectiveWorkplace = expense.workplace === 'その他' ? expense.workplace_other : expense.workplace;
      if (!effectiveWorkplace?.trim()) { setFormError('勤務先を入力してください。'); return; }
    }

    // 送信前に transportation/workplace の "その他" テキストをマージ
    const mergeExpense = (e: typeof expensesToSubmit[0]) => ({
      ...e,
      transportation: (e.transportation || '').split('・').map(p => p === 'その他' ? (e.transportation_other || '') : p).filter(Boolean).join('・'),
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
      <div style={{ textAlign: 'center', marginBottom: 12, paddingBottom: 12, borderBottom: `1px solid ${isDarkMode ? '#2c2c3e' : '#e9ecef'}` }}>
        <p style={{ margin: '0 0 3px', fontSize: 10, letterSpacing: '0.22em', color: isDarkMode ? '#6c757d' : '#adb5bd', fontWeight: 700 }}>ファイブMスタッフサイト</p>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: isDarkMode ? '#fff' : '#1a1a2e', letterSpacing: '0.04em', lineHeight: 1.2 }} aria-label="交通費申請フォーム">🚃 交通費申請</h1>
      </div>

      
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
      
      {/* よく使う経路テンプレート */}
      {recentTemplates.length > 0 && (
        <div style={{
          background: isDarkMode ? '#1e2a38' : '#e8f4fd',
          border: `1px solid ${isDarkMode ? '#2d4a6a' : '#90caf9'}`,
          borderRadius: 8, padding: '10px 12px', marginBottom: 16
        }}>
          <div style={{ fontSize: 12, fontWeight: 'bold', color: isDarkMode ? '#7fb3d3' : '#1565c0', marginBottom: 8 }}>
            📋 よく使う経路
          </div>
          {(showAllTemplates ? recentTemplates : recentTemplates.slice(0, 3)).map((tpl, i) => {
            const typeLabels: Record<string, string> = { one_time: '通勤（単発）', regular: '定期', business_trip: '出張（園指導等）', other: tpl.type_other || 'その他' };
            const typeLabel = typeLabels[tpl.type] || tpl.type;
            return (
              <div key={i} style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '6px 8px',
                background: isDarkMode ? '#2c3e50' : '#fff',
                border: `1px solid ${isDarkMode ? '#3d5166' : '#bbdefb'}`,
                borderRadius: 5, marginBottom: 5, fontSize: 12
              }}>
                <span style={{ flex: 1, color: isDarkMode ? '#ccc' : '#333', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {typeLabel} {tpl.transportation} {tpl.from_station}→{tpl.to_station} ¥{parseInt(tpl.amount || '0').toLocaleString()}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setDraftExpense(toDraft(tpl));
                    setHighlightFields(new Set(['start_date']));
                  }}
                  style={{ background: '#1976d2', color: '#fff', fontSize: 11, padding: '4px 10px', border: 'none', borderRadius: 4, cursor: 'pointer', flexShrink: 0 }}
                >
                  入力
                </button>
              </div>
            );
          })}
          {recentTemplates.length > 3 && (
            <button
              type="button"
              onClick={() => setShowAllTemplates(prev => !prev)}
              style={{ width: '100%', padding: '5px', background: 'none', border: `1px dashed ${isDarkMode ? '#4a7aaa' : '#90caf9'}`, borderRadius: 4, cursor: 'pointer', fontSize: 11, color: isDarkMode ? '#7fb3d3' : '#1565c0', marginTop: 2 }}
            >
              {showAllTemplates ? '▲ 閉じる' : `▼ もっと見る（あと${recentTemplates.length - 3}件）`}
            </button>
          )}
        </div>
      )}

      <form>
        {/* テンプレートキュー残り件数 */}
        {templateQueue.length > 0 && (
          <div style={{ background: '#fff3cd', border: '1px solid #ffc107', borderRadius: 6, padding: '8px 12px', marginBottom: 8, fontSize: 13, color: '#856404', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span>📋</span>
            <span>テンプレート適用中：残り <strong>{templateQueue.length}件</strong>（利用日を入力して「追加」してください）</span>
          </div>
        )}

        {/* ===== 入力フォーム（1件ずつ） ===== */}
        {(() => {
          const isCustomType = draftExpense.type === 'other' && !!draftExpense.type_other && customExpenseTypes.includes(draftExpense.type_other);
          const typeSelectValue = isCustomType ? `custom:${draftExpense.type_other}` : draftExpense.type;
          const getLabel = (sortOrder: number, fallback: string) => expenseTypeLabels.find(l => l.sort_order === sortOrder)?.value ?? fallback;
          const inp = { background: isDarkMode ? '#495057' : undefined, color: isDarkMode ? '#fff' : undefined, borderColor: isDarkMode ? '#6c757d' : undefined };
          const hl = (field: string) => highlightFields.has(field) ? { ...inp, background: isDarkMode ? '#4a2030' : '#ffe4e8', borderColor: '#f06292' } : inp;
          const clearHL = (field: string) => setHighlightFields(prev => { const s = new Set(prev); s.delete(field); return s; });
          return (
            <div style={{ background: isDarkMode ? '#2c3e50' : '#fff', border: '2px solid #0d6efd', borderRadius: 8, padding: 16, marginBottom: 8, boxShadow: isDarkMode ? 'none' : '0 2px 8px rgba(0,0,0,0.06)' }}>
              {/* 区分 */}
              <div style={{ marginBottom: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', border: `1px solid ${isDarkMode ? '#6c757d' : '#ccc'}`, borderRadius: 4 }}>
                  <span style={{ background: isDarkMode ? '#6c757d' : '#9e9e9e', color: '#fff', fontSize: 12, padding: '0 8px', whiteSpace: 'nowrap', flexShrink: 0, borderRadius: '3px 0 0 3px', alignSelf: 'stretch', display: 'flex', alignItems: 'center' }}>区分</span>
                  <select value={typeSelectValue} onChange={(e) => { const val = e.target.value; if (val.startsWith('custom:')) { setDraftExpense(prev => ({ ...prev, type: 'other', type_other: val.slice(7), trip_category: '', workplace: '', workplace_other: '' })); } else { setDraftExpense(prev => ({ ...prev, type: val as Expense['type'], type_other: '', trip_category: '', workplace: '', workplace_other: '' })); } }} style={{ border: 'none', outline: 'none', flex: 1, padding: '7px 6px', fontSize: 14, background: isDarkMode ? '#495057' : '#fff', color: isDarkMode ? '#fff' : '#333', minWidth: 0 }}>
                    <option value="one_time">{getLabel(1, '通勤（単発）')}</option>
                    <option value="regular">{getLabel(2, '定期')}</option>
                    <option value="business_trip">{getLabel(3, '出張（園指導等）')}</option>
                    {customExpenseTypes.map(ct => <option key={ct} value={`custom:${ct}`}>{ct}</option>)}
                    <option value="other">{getLabel(4, 'その他')}</option>
                  </select>
                </div>
                {draftExpense.type === 'other' && !isCustomType && (
                  <input type="text" placeholder="内容を入力" value={draftExpense.type_other || ''} onChange={(e) => setDraftExpense(prev => ({ ...prev, type_other: e.target.value }))} className="expense-input form-input-full" style={{ marginTop: 6, ...inp }} />
                )}
              </div>

              {/* 利用日 or 開始日〜終了日 */}
              {draftExpense.type !== 'regular' ? (
                <div style={{ marginBottom: 8 }}>
                  <div style={{ position: 'relative' }}>
                    <div style={{ display: 'flex', alignItems: 'center', border: `1px solid ${highlightFields.has('start_date') ? '#f06292' : (isDarkMode ? '#6c757d' : '#ccc')}`, borderRadius: 4, background: highlightFields.has('start_date') ? (isDarkMode ? '#4a2030' : '#ffe4e8') : 'transparent' }}>
                      <span style={{ background: isDarkMode ? '#6c757d' : '#9e9e9e', color: '#fff', fontSize: 12, padding: '0 8px', whiteSpace: 'nowrap', flexShrink: 0, borderRadius: '3px 0 0 3px', alignSelf: 'stretch', display: 'flex', alignItems: 'center' }}>利用日</span>
                      <button type="button" onClick={() => { setDraftDatePicker(draftDatePicker === 'start' ? null : 'start'); clearHL('start_date'); }} style={{ border: 'none', outline: 'none', flex: 1, padding: '7px 6px', fontSize: 14, background: 'transparent', color: draftExpense.start_date ? (isDarkMode ? '#fff' : '#333') : (isDarkMode ? '#adb5bd' : '#999'), textAlign: 'left', cursor: 'pointer' }}>
                        {draftExpense.start_date || '日付を選択'}
                      </button>
                    </div>
                    {draftDatePicker === 'start' && <SingleDatePicker value={draftExpense.start_date || ''} onChange={v => { setDraftExpense(prev => ({ ...prev, start_date: v })); setDraftDatePicker(null); }} onClose={() => setDraftDatePicker(null)} />}
                  </div>
                </div>
              ) : (
                <div style={{ marginBottom: 8 }}>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', border: `1px solid ${highlightFields.has('start_date') ? '#f06292' : (isDarkMode ? '#6c757d' : '#ccc')}`, borderRadius: 4, background: highlightFields.has('start_date') ? (isDarkMode ? '#4a2030' : '#ffe4e8') : 'transparent' }}>
                        <span style={{ background: isDarkMode ? '#6c757d' : '#9e9e9e', color: '#fff', fontSize: 12, padding: '0 8px', whiteSpace: 'nowrap', flexShrink: 0, borderRadius: '3px 0 0 3px', alignSelf: 'stretch', display: 'flex', alignItems: 'center' }}>開始日</span>
                        <button type="button" onClick={() => { setDraftDatePicker(draftDatePicker === 'start' ? null : 'start'); clearHL('start_date'); }} style={{ border: 'none', outline: 'none', flex: 1, padding: '7px 6px', fontSize: 14, background: 'transparent', color: draftExpense.start_date ? (isDarkMode ? '#fff' : '#333') : (isDarkMode ? '#adb5bd' : '#999'), textAlign: 'left', cursor: 'pointer', width: '100%' }}>
                          {draftExpense.start_date || '開始日'}
                        </button>
                      </div>
                      {draftDatePicker === 'start' && <SingleDatePicker value={draftExpense.start_date || ''} onChange={v => { setDraftExpense(prev => ({ ...prev, start_date: v })); setDraftDatePicker(null); clearHL('start_date'); }} onClose={() => setDraftDatePicker(null)} />}
                    </div>
                    <span style={{ color: '#999', flexShrink: 0 }}>〜</span>
                    <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', border: `1px solid ${highlightFields.has('end_date') ? '#f06292' : (isDarkMode ? '#6c757d' : '#ccc')}`, borderRadius: 4, background: highlightFields.has('end_date') ? (isDarkMode ? '#4a2030' : '#ffe4e8') : 'transparent' }}>
                        <span style={{ background: isDarkMode ? '#6c757d' : '#9e9e9e', color: '#fff', fontSize: 12, padding: '0 8px', whiteSpace: 'nowrap', flexShrink: 0, borderRadius: '3px 0 0 3px', alignSelf: 'stretch', display: 'flex', alignItems: 'center' }}>終了日</span>
                        <button type="button" onClick={() => { setDraftDatePicker(draftDatePicker === 'end' ? null : 'end'); clearHL('end_date'); }} style={{ border: 'none', outline: 'none', flex: 1, padding: '7px 6px', fontSize: 14, background: 'transparent', color: draftExpense.end_date ? (isDarkMode ? '#fff' : '#333') : (isDarkMode ? '#adb5bd' : '#999'), textAlign: 'left', cursor: 'pointer', width: '100%' }}>
                          {draftExpense.end_date || '終了日'}
                        </button>
                      </div>
                      {draftDatePicker === 'end' && <SingleDatePicker value={draftExpense.end_date || ''} onChange={v => { setDraftExpense(prev => ({ ...prev, end_date: v })); setDraftDatePicker(null); clearHL('end_date'); }} onClose={() => setDraftDatePicker(null)} />}
                    </div>
                  </div>
                </div>
              )}

              {/* 交通機関（複数選択） */}
              {(() => {
                const selectedTransports = (draftExpense.transportation || '').split('・').filter(Boolean);
                const BUS = '京都市バス';
                const toggleTransport = (t: string) => {
                  let next: string[];
                  if (selectedTransports.includes(t)) {
                    next = selectedTransports.filter(x => x !== t);
                  } else if (t === BUS) {
                    // バスを選ぶ → 他を全解除
                    next = [BUS];
                  } else {
                    // 他を選ぶ → バスを解除
                    next = [...selectedTransports.filter(x => x !== BUS), t];
                  }
                  setDraftExpense(prev => ({ ...prev, transportation: next.join('・'), transportation_other: next.includes('その他') ? prev.transportation_other : '' }));
                  clearHL('transportation');
                };
                return (
                  <div style={{ marginBottom: 8, position: 'relative' }}>
                    <div onClick={() => setShowTransportPicker(p => !p)} style={{ display: 'flex', alignItems: 'center', border: `1px solid ${highlightFields.has('transportation') ? '#f06292' : (isDarkMode ? '#6c757d' : '#ccc')}`, borderRadius: 4, cursor: 'pointer', minHeight: 36, background: highlightFields.has('transportation') ? (isDarkMode ? '#4a2030' : '#ffe4e8') : 'transparent' }}>
                      <span style={{ background: isDarkMode ? '#6c757d' : '#9e9e9e', color: '#fff', fontSize: 12, padding: '0 8px', whiteSpace: 'nowrap', flexShrink: 0, borderRadius: '3px 0 0 3px', alignSelf: 'stretch', display: 'flex', alignItems: 'center' }}>交通機関</span>
                      <div style={{ flex: 1, padding: '4px 6px', display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center', minHeight: 30 }}>
                        {selectedTransports.length === 0
                          ? <span style={{ color: isDarkMode ? '#adb5bd' : '#999', fontSize: 14 }}>選択してください</span>
                          : selectedTransports.map(t => <span key={t} style={{ background: isDarkMode ? '#1e3d5c' : '#e3f2fd', color: isDarkMode ? '#90caf9' : '#1565c0', borderRadius: 3, padding: '2px 7px', fontSize: 13 }}>{t}</span>)
                        }
                      </div>
                      <span style={{ color: isDarkMode ? '#adb5bd' : '#999', padding: '0 8px', fontSize: 12 }}>{showTransportPicker ? '▲' : '▼'}</span>
                    </div>
                    {showTransportPicker && (
                      <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: isDarkMode ? '#343a40' : '#fff', border: `1px solid ${isDarkMode ? '#6c757d' : '#ccc'}`, borderRadius: 4, zIndex: 200, boxShadow: '0 4px 12px rgba(0,0,0,0.18)', padding: '4px 0' }}>
                        <div style={{ fontSize: 13, color: isDarkMode ? '#90caf9' : '#1565c0', background: isDarkMode ? '#3d3000' : '#fff9e6', padding: '8px 14px', borderBottom: `1px solid ${isDarkMode ? '#5a4400' : '#ffe499'}`, textAlign: 'left' }}>ℹ️ 複数選択可（🚌バス除く）</div>
                        {[...TRANSPORT_PRESETS, 'その他'].map(t => {
                          const checked = selectedTransports.includes(t);
                          return (
                            <label key={t} style={{ display: 'flex', alignItems: 'center', padding: '10px 14px', cursor: 'pointer', borderBottom: `1px solid ${isDarkMode ? '#495057' : '#f0f0f0'}`, background: checked ? (isDarkMode ? '#1e3d5c' : '#e8f4fd') : 'transparent' }}>
                              <input type="checkbox" checked={checked} onChange={() => toggleTransport(t)} style={{ width: 18, height: 18, marginRight: 12, accentColor: '#0d6efd' }} />
                              <span style={{ fontSize: 15, color: isDarkMode ? '#fff' : '#333' }}>{t}</span>
                            </label>
                          );
                        })}
                        <div style={{ padding: '6px 8px' }}>
                          <button type="button" onClick={() => setShowTransportPicker(false)} style={{ width: '100%', padding: '8px', background: '#0d6efd', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 14, fontWeight: 'bold' }}>決定</button>
                        </div>
                      </div>
                    )}
                    {selectedTransports.includes('その他') && (
                      <input type="text" placeholder="交通機関を入力" value={draftExpense.transportation_other || ''} onChange={(e) => { setDraftExpense(prev => ({ ...prev, transportation_other: e.target.value })); clearHL('transportation_other'); }} className="expense-input form-input-full" style={{ marginTop: 6, ...hl('transportation_other') }} />
                    )}
                  </div>
                );
              })()}

              {/* 出発駅 ⇄ 帰着駅 */}
              <div style={{ marginBottom: 10 }}>
                <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                  {/* 出発 */}
                  <div style={{ display: 'flex', alignItems: 'center', flex: 1, minWidth: 0, border: `1px solid ${highlightFields.has('from_station') ? '#f06292' : (isDarkMode ? '#6c757d' : '#ccc')}`, borderRadius: 4, background: highlightFields.has('from_station') ? (isDarkMode ? '#4a2030' : '#ffe4e8') : 'transparent' }}>
                    <span style={{ background: isDarkMode ? '#6c757d' : '#9e9e9e', color: '#fff', fontSize: 12, padding: '0 8px', whiteSpace: 'nowrap', flexShrink: 0, borderRadius: '3px 0 0 3px', alignSelf: 'stretch', display: 'flex', alignItems: 'center' }}>出発</span>
                    <input type="text" placeholder="駅、バス停" value={draftExpense.from_station} onChange={(e) => { setDraftExpense(prev => ({ ...prev, from_station: e.target.value })); clearHL('from_station'); }} style={{ border: 'none', outline: 'none', flex: 1, minWidth: 0, padding: '7px 6px', fontSize: 14, background: 'transparent', color: isDarkMode ? '#fff' : '#333' }} />
                  </div>
                  {/* 反転ボタン */}
                  <button type="button" onClick={() => setDraftExpense(prev => ({ ...prev, from_station: prev.to_station, to_station: prev.from_station }))} style={{ flexShrink: 0, background: isDarkMode ? '#495057' : '#f0f0f0', border: `1px solid ${isDarkMode ? '#6c757d' : '#ccc'}`, borderRadius: 4, padding: '6px 8px', cursor: 'pointer', fontSize: 16, color: isDarkMode ? '#fff' : '#555' }} title="出発・到着を入れ替え">⇄</button>
                  {/* 到着 */}
                  <div style={{ display: 'flex', alignItems: 'center', flex: 1, minWidth: 0, border: `1px solid ${highlightFields.has('to_station') ? '#f06292' : (isDarkMode ? '#6c757d' : '#ccc')}`, borderRadius: 4, background: highlightFields.has('to_station') ? (isDarkMode ? '#4a2030' : '#ffe4e8') : 'transparent' }}>
                    <span style={{ background: isDarkMode ? '#6c757d' : '#9e9e9e', color: '#fff', fontSize: 12, padding: '0 8px', whiteSpace: 'nowrap', flexShrink: 0, borderRadius: '3px 0 0 3px', alignSelf: 'stretch', display: 'flex', alignItems: 'center' }}>到着</span>
                    <input type="text" placeholder="駅、バス停" value={draftExpense.to_station} onChange={(e) => { setDraftExpense(prev => ({ ...prev, to_station: e.target.value })); clearHL('to_station'); }} style={{ border: 'none', outline: 'none', flex: 1, minWidth: 0, padding: '7px 6px', fontSize: 14, background: 'transparent', color: isDarkMode ? '#fff' : '#333' }} />
                  </div>
                </div>
              </div>

              {/* 金額 + 勤務先 */}
              <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: 8, marginBottom: 10 }}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', border: `1px solid ${highlightFields.has('amount') ? '#f06292' : (isDarkMode ? '#6c757d' : '#ccc')}`, borderRadius: 4, background: highlightFields.has('amount') ? (isDarkMode ? '#4a2030' : '#ffe4e8') : 'transparent' }}>
                    <span style={{ background: isDarkMode ? '#6c757d' : '#9e9e9e', color: '#fff', fontSize: 12, padding: '0 8px', whiteSpace: 'nowrap', flexShrink: 0, borderRadius: '3px 0 0 3px', alignSelf: 'stretch', display: 'flex', alignItems: 'center' }}>金額</span>
                    <input type="text" inputMode="numeric" pattern="[0-9]*" placeholder="0" value={formatAmount(draftExpense.amount)} onChange={(e) => { setDraftExpense(prev => ({ ...prev, amount: parseAmount(e.target.value) })); clearHL('amount'); }} style={{ border: 'none', outline: 'none', flex: 1, minWidth: 0, padding: '7px 6px', fontSize: 14, background: 'transparent', color: isDarkMode ? '#fff' : '#333' }} />
                  </div>
                </div>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', border: `1px solid ${highlightFields.has('workplace') ? '#f06292' : (isDarkMode ? '#6c757d' : '#ccc')}`, borderRadius: 4, background: highlightFields.has('workplace') ? (isDarkMode ? '#4a2030' : '#ffe4e8') : 'transparent' }}>
                    <span style={{ background: isDarkMode ? '#6c757d' : '#9e9e9e', color: '#fff', fontSize: 12, padding: '0 8px', whiteSpace: 'nowrap', flexShrink: 0, borderRadius: '3px 0 0 3px', alignSelf: 'stretch', display: 'flex', alignItems: 'center' }}>勤務先</span>
                    {draftExpense.type === 'other' ? (
                      <input type="text" placeholder="勤務先を入力" value={draftExpense.workplace || ''} onChange={(e) => { setDraftExpense(prev => ({ ...prev, workplace: e.target.value })); clearHL('workplace'); }} style={{ border: 'none', outline: 'none', flex: 1, minWidth: 0, padding: '7px 6px', fontSize: 14, background: 'transparent', color: isDarkMode ? '#fff' : '#333' }} />
                    ) : draftExpense.type === 'business_trip' ? (
                      <select value={draftExpense.workplace || ''} onChange={(e) => { setDraftExpense(prev => ({ ...prev, workplace: e.target.value, workplace_other: '' })); clearHL('workplace'); }} style={{ border: 'none', outline: 'none', flex: 1, padding: '7px 4px', fontSize: 14, background: isDarkMode ? '#495057' : '#fff', color: isDarkMode ? '#fff' : '#333', minWidth: 0 }}>
                        <option value="">選択</option>
                        {Object.values(locationsByCategory).flat().map(loc => <option key={loc} value={loc}>{loc}</option>)}
                        <option value="その他">その他</option>
                      </select>
                    ) : (
                      <select value={draftExpense.workplace || ''} onChange={(e) => { setDraftExpense(prev => ({ ...prev, workplace: e.target.value, workplace_other: '' })); clearHL('workplace'); }} style={{ border: 'none', outline: 'none', flex: 1, padding: '7px 4px', fontSize: 14, background: isDarkMode ? '#495057' : '#fff', color: isDarkMode ? '#fff' : '#333', minWidth: 0 }}>
                        <option value="">選択</option>
                        {workplaceOptions.map(s => <option key={s} value={s}>{s}</option>)}
                        <option value="その他">その他</option>
                      </select>
                    )}
                  </div>
                  {draftExpense.workplace === 'その他' && draftExpense.type !== 'other' && (
                    <input type="text" placeholder="勤務先を入力" value={draftExpense.workplace_other || ''} onChange={(e) => { setDraftExpense(prev => ({ ...prev, workplace_other: e.target.value })); clearHL('workplace'); }} className="expense-input form-input-full" style={{ marginTop: 4, ...hl('workplace') }} />
                  )}
                </div>
              </div>

              {/* 備考 */}
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 11, color: isDarkMode ? '#adb5bd' : '#6c757d', marginBottom: 3 }}>備考（任意）</div>
                <input type="text" placeholder="経由地など" value={draftExpense.notes || ''} onChange={(e) => setDraftExpense(prev => ({ ...prev, notes: e.target.value }))} className="expense-input form-input-full" style={{ ...inp }} />
              </div>

              {/* 追加ボタン */}
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" onClick={handleAddDraft} style={{ flex: 1, padding: 10, background: '#0d6efd', color: 'white', border: 'none', borderRadius: 6, fontSize: 14, fontWeight: 'bold', cursor: 'pointer' }}>
                  ＋ 申請リストに追加
                </button>
                {draftExpense.type !== 'regular' && (
                  <button type="button" onClick={handleAddRoundTripDraft} style={{ flex: 1, padding: 10, background: '#198754', color: 'white', border: 'none', borderRadius: 6, fontSize: 13, fontWeight: 'bold', cursor: 'pointer' }}>
                    ⇄ 往復で申請リストに追加
                  </button>
                )}
                <button type="button" onClick={() => { setDraftExpense(emptyDraft); setHighlightFields(new Set()); setFormError(''); }} style={{ padding: '10px 12px', background: '#6c757d', color: 'white', border: 'none', borderRadius: 6, fontSize: 13, cursor: 'pointer', flexShrink: 0 }}>
                  クリア
                </button>
              </div>
            </div>
          );
        })()}

        {formError && (
          <div ref={errorRef} style={{ background: '#f8d7da', border: '1px solid #f5c6cb', borderRadius: 8, padding: '12px 16px', marginTop: 12, color: '#721c24', fontSize: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 18 }}>⚠️</span>
            <span>{formError}</span>
            <button type="button" onClick={() => setFormError('')} style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: '#721c24', fontSize: 18 }}>✕</button>
          </div>
        )}

        {/* ===== 追加済みリスト ===== */}
        {expenses.length > 0 && (
          <>
            <hr style={{ border: 'none', borderTop: `1px dashed ${isDarkMode ? '#555' : '#ccc'}`, margin: '16px 0' }} />
            <div style={{ fontSize: 12, color: isDarkMode ? '#adb5bd' : '#888', marginBottom: 8 }}>✅ 追加済み（{expenses.length}件）</div>
            {expenses.map((expense, index) => {
              const typeLabel = expense.type === 'regular' ? '定期' : expense.type === 'business_trip' ? '出張（園指導等）' : expense.type === 'other' ? (expense.type_other || 'その他') : '通勤（単発）';
              const dateLabel = expense.type === 'regular' ? `${expense.start_date || ''} 〜 ${expense.end_date || ''}` : (expense.start_date || '');
              const isTeiki = expense.type === 'regular';
              return (
                <div key={index} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', background: isDarkMode ? (isTeiki ? '#1e3d2a' : '#2c3e50') : (isTeiki ? '#f6fff8' : '#f8fbff'), border: `1px solid ${isDarkMode ? (isTeiki ? '#2d5a3d' : '#344a5e') : (isTeiki ? '#d4edda' : '#cfe2ff')}`, borderLeft: `3px solid ${isTeiki ? '#198754' : '#0d6efd'}`, borderRadius: 6, marginBottom: 6, fontSize: 13 }}>
                  <span style={{ background: isDarkMode ? '#444' : '#e9ecef', borderRadius: 4, padding: '3px 8px', fontWeight: 'bold', fontSize: 12, flexShrink: 0 }}>{index + 1}</span>
                  <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                    <div style={{ fontSize: 11, color: isDarkMode ? '#adb5bd' : '#6c757d' }}>{typeLabel}　{expense.transportation}　{dateLabel}{expense.workplace === 'その他' ? `　${expense.workplace_other}` : expense.workplace ? `　${expense.workplace}` : ''}</div>
                    <div style={{ fontWeight: 'bold', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: isDarkMode ? '#fff' : '#333', fontSize: 14 }}>{expense.from_station} → {expense.to_station}</div>
                  </div>
                  <div style={{ fontWeight: 'bold', color: isDarkMode ? '#4a9eff' : '#0d6efd', flexShrink: 0 }}>¥{parseInt(expense.amount || '0').toLocaleString()}</div>
                  <button type="button" onClick={() => { setDraftExpense(toDraft(expense)); setTimeout(() => setHighlightFields(new Set(['start_date'])), 0); }} style={{ background: '#6c757d', color: 'white', border: 'none', borderRadius: 4, padding: '4px 8px', fontSize: 11, cursor: 'pointer', flexShrink: 0 }}>複製</button>
                  <button type="button" onClick={() => handleRemoveRow(index)} style={{ background: '#dc3545', color: 'white', border: 'none', borderRadius: 4, padding: '4px 8px', fontSize: 11, cursor: 'pointer', flexShrink: 0 }}>削除</button>
                </div>
              );
            })}
          </>
        )}

        <div style={{ textAlign: 'right', marginTop: 10, fontSize: '1.2em', fontWeight: 'bold', color: isDarkMode ? '#fff' : '#333' }}>
          合計金額: {formatAmount(totalAmount.toString())}円
        </div>

        <button type="button" onClick={handleValidateAndConfirm} disabled={isSubmitting || expenses.length === 0}
          style={{ width: '100%', padding: 12, marginTop: 12, background: isSubmitting || expenses.length === 0 ? '#6c757d' : '#007bff', color: 'white', border: 'none', borderRadius: 4, cursor: isSubmitting || expenses.length === 0 ? 'not-allowed' : 'pointer', opacity: isSubmitting || expenses.length === 0 ? 0.6 : 1, fontSize: 15, fontWeight: 'bold' }}>
          {isSubmitting ? '送信中...' : `申請する${expenses.length > 0 ? `（${expenses.length}件）` : ''}`}
        </button>

        {submitSuccess && (
          <div style={{ background: '#d4edda', border: '1px solid #c3e6cb', borderRadius: 8, padding: '14px 16px', marginTop: 12, color: '#155724', fontSize: 15, display: 'flex', alignItems: 'center', gap: 8, fontWeight: 'bold' }}>
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
              const typeLabel = e.type === 'regular' ? '⭐定期' : e.type === 'business_trip' ? '出張' : e.type === 'other' ? (e.type_other || 'その他') : '単発';
              const dateLabel = e.type === 'regular' ? `${e.start_date}〜${e.end_date}` : e.start_date;
              const isTeiki = e.type === 'regular';
              return (
                <div key={i} style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '7px 10px',
                  background: isTeiki ? '#f6fff8' : '#f8f9fa',
                  borderLeft: `3px solid ${isTeiki ? '#198754' : '#0d6efd'}`,
                  borderRadius: 4, marginBottom: 6, fontSize: 13,
                }}>
                  <span style={{ color: '#888', fontSize: 11, flexShrink: 0, minWidth: 18 }}>{i + 1}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 11, color: '#666', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {typeLabel}　{e.transportation}　{dateLabel}{e.workplace === 'その他' ? `　${e.workplace_other}` : e.workplace ? `　${e.workplace}` : ''}
                    </div>
                    <div style={{ fontWeight: 'bold', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {e.from_station} → {e.to_station}
                    </div>
                    {e.notes && <div style={{ fontSize: 11, color: '#888' }}>備考: {e.notes}</div>}
                  </div>
                  <div style={{ fontWeight: 'bold', color: '#0d6efd', flexShrink: 0, fontSize: 14 }}>
                    ¥{parseInt(e.amount || '0').toLocaleString()}
                  </div>
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

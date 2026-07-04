import React, { useState } from 'react';
import type { AuthUser } from '../types';
import { formatAmount, parseAmount } from '../utils';
import { supabase } from '../lib/supabaseClient';
import { useDarkMode } from '../hooks/useDarkMode';
import ReceiptUploader, { type ReceiptValue } from './ReceiptUploader';

const BannerSuccess: React.FC<{ message: string; sub?: string; onClose: () => void }> = ({ message, sub, onClose }) => {
  React.useEffect(() => { const t = setTimeout(onClose, 4000); return () => clearTimeout(t); }, [onClose]);
  return (
    <div style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', zIndex: 9999 }}>
      <div style={{ background: '#f0fdf4', border: '1.5px solid #b7e4cc', borderRadius: 18, padding: '24px 28px', minWidth: 220, maxWidth: 300, textAlign: 'center', position: 'relative' }}>
        <button onClick={onClose} style={{ position: 'absolute', top: 10, right: 10, background: 'rgba(21,87,36,0.1)', border: 'none', color: '#155724', borderRadius: '50%', width: 26, height: 26, cursor: 'pointer', fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>✕</button>
        <div style={{ width: 60, height: 60, borderRadius: '50%', background: '#d4edda', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 12px' }}>
          <span style={{ fontSize: 26, color: '#28a745' }}>✓</span>
        </div>
        <div style={{ fontSize: 15, fontWeight: 500, color: '#155724' }}>{message}</div>
        {sub && <div style={{ fontSize: 12, color: '#155724', marginTop: 6 }}>{sub}</div>}
      </div>
    </div>
  );
};

interface ReimbursementFormProps {
  user: AuthUser;
  roleTitle: string;
}

const emptyReceipt: ReceiptValue = { receiptType: '', receiptStoragePath: null, receiptMissingReason: '' };

const ReimbursementForm: React.FC<ReimbursementFormProps> = ({ user, roleTitle }) => {
  const isDarkMode = useDarkMode();
  const cardBg = isDarkMode ? '#2d2d3e' : '#ffffff';
  const border = isDarkMode ? '#3a3a5c' : '#e0e0e0';
  const text = isDarkMode ? '#eeeeee' : '#222222';
  const subText = isDarkMode ? '#aaaaaa' : '#666666';
  const inputBg = isDarkMode ? '#3a3a5c' : '#f8f9fa';

  const [draftId] = useState(() => crypto.randomUUID());
  const [itemName, setItemName] = useState('');
  const [amount, setAmount] = useState('');
  const [purchasedAt, setPurchasedAt] = useState(() => new Date().toISOString().slice(0, 10));
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'company_card' | ''>('');
  const [receipt, setReceipt] = useState<ReceiptValue>(emptyReceipt);
  const [showDetails, setShowDetails] = useState(false);
  const [quantity, setQuantity] = useState('');
  const [storeName, setStoreName] = useState('');
  const [purpose, setPurpose] = useState('');
  const [instructedBy, setInstructedBy] = useState('');
  const [notes, setNotes] = useState('');

  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [successBanner, setSuccessBanner] = useState(false);

  const resetForm = () => {
    setItemName(''); setAmount(''); setPurchasedAt(new Date().toISOString().slice(0, 10));
    setPaymentMethod(''); setReceipt(emptyReceipt); setShowDetails(false);
    setQuantity(''); setStoreName(''); setPurpose(''); setInstructedBy(''); setNotes('');
  };

  const handleSubmit = async () => {
    setFormError('');
    if (!itemName.trim()) { setFormError('品目名を入力してください。'); return; }
    const parsedAmount = parseInt(parseAmount(amount), 10);
    if (!amount.trim() || isNaN(parsedAmount)) { setFormError('金額を正しく入力してください。'); return; }
    if (!purchasedAt) { setFormError('購入日を入力してください。'); return; }
    if (!paymentMethod) { setFormError('支払方法を選択してください。'); return; }
    if (!receipt.receiptType) { setFormError('レシートの提出方法を選択してください。'); return; }
    if (receipt.receiptType === 'photo' && !receipt.receiptStoragePath) { setFormError('レシート写真のアップロードを完了してください。'); return; }
    if (receipt.receiptType === 'none' && !receipt.receiptMissingReason.trim()) { setFormError('レシートがない理由を入力してください。'); return; }

    setSubmitting(true);
    const { error } = await supabase.from('purchase_requests').insert({
      id: draftId,
      user_id: user.id,
      applicant_role_title: roleTitle,
      request_type: 'reimbursement',
      item_name: itemName.trim(),
      quantity: quantity.trim() ? parseInt(quantity, 10) : null,
      amount: parsedAmount,
      purchased_at: purchasedAt,
      instructed_by: instructedBy.trim() || null,
      store_name: storeName.trim() || null,
      purpose: purpose.trim() || null,
      payment_method: paymentMethod,
      notes: notes.trim() || null,
      receipt_type: receipt.receiptType,
      receipt_missing_reason: receipt.receiptType === 'none' ? receipt.receiptMissingReason.trim() : null,
      receipt_storage_path: receipt.receiptType === 'photo' ? receipt.receiptStoragePath : null,
      status: 'recorded',
    });
    setSubmitting(false);

    if (error) {
      setFormError('登録に失敗しました: ' + error.message);
      return;
    }

    supabase.functions.invoke('purchase-reimbursement-notify', {
      body: { user_id: user.id, user_name: user.user_metadata?.name ?? '', item_name: itemName.trim(), amount: parsedAmount },
    }).then(null, () => {});

    setSuccessBanner(true);
    resetForm();
  };

  const labelStyle: React.CSSProperties = { fontSize: 13, fontWeight: 'bold', color: text, marginBottom: 6, display: 'block' };
  const inputStyle: React.CSSProperties = { width: '100%', boxSizing: 'border-box', padding: '10px 12px', borderRadius: 8, border: `1px solid ${border}`, background: inputBg, color: text, fontSize: 14 };

  return (
    <div>
      {successBanner && (
        <BannerSuccess
          message="精算を記録しました"
          sub="内容は履歴タブから確認できます"
          onClose={() => setSuccessBanner(false)}
        />
      )}

      <div style={{ background: cardBg, border: `1px solid ${border}`, borderRadius: 12, padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div>
          <label style={labelStyle}>品目名 <span style={{ color: '#dc3545' }}>*</span></label>
          <input type="text" value={itemName} onChange={e => setItemName(e.target.value)} placeholder="例：トイレットペーパー" style={inputStyle} />
        </div>

        <div>
          <label style={labelStyle}>金額 <span style={{ color: '#dc3545' }}>*</span></label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ color: text, fontSize: 14 }}>¥</span>
            <input
              type="text" inputMode="numeric" value={amount}
              onChange={e => setAmount(formatAmount(parseAmount(e.target.value)))}
              placeholder="0" style={inputStyle}
            />
          </div>
        </div>

        <div>
          <label style={labelStyle}>購入日 <span style={{ color: '#dc3545' }}>*</span></label>
          <input type="date" value={purchasedAt} onChange={e => setPurchasedAt(e.target.value)} style={inputStyle} />
        </div>

        <div>
          <label style={labelStyle}>この支出はどちらで払いましたか？ <span style={{ color: '#dc3545' }}>*</span></label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {[
              { key: 'cash' as const, label: '① 自分で立替えた（後日返金されます）' },
              { key: 'company_card' as const, label: '② 会社カードで払った（記録のみ・返金なし）' },
            ].map(opt => {
              const active = paymentMethod === opt.key;
              return (
                <button
                  key={opt.key} type="button" onClick={() => setPaymentMethod(opt.key)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', borderRadius: 10,
                    cursor: 'pointer', background: cardBg, border: `2px solid ${active ? '#28a745' : border}`,
                    textAlign: 'left', width: '100%', boxSizing: 'border-box',
                  }}
                >
                  <span style={{ fontSize: 13, color: text, fontWeight: active ? 'bold' : 'normal' }}>{opt.label}</span>
                  {active && <span style={{ marginLeft: 'auto', color: '#28a745', fontSize: 16 }}>✓</span>}
                </button>
              );
            })}
          </div>
          {paymentMethod === 'company_card' && (
            <div style={{ marginTop: 8, padding: '8px 12px', background: isDarkMode ? '#3a3a20' : '#fff8e1', border: `1px solid ${isDarkMode ? '#5c5430' : '#ffe082'}`, borderRadius: 8, fontSize: 12, color: isDarkMode ? '#ffe082' : '#8a6d00' }}>
              ℹ️ 会社カード払いのため、この記録に返金は発生しません。
            </div>
          )}
        </div>

        <ReceiptUploader isDarkMode={isDarkMode} userId={user.id} draftId={draftId} value={receipt} onChange={patch => setReceipt(prev => ({ ...prev, ...patch }))} />

        <div>
          <button
            type="button"
            onClick={() => setShowDetails(s => !s)}
            style={{ background: 'none', border: 'none', color: '#4a90d9', fontSize: 13, cursor: 'pointer', padding: 0 }}
          >
            {showDetails ? '▲ 詳しい入力を閉じる' : '▼ 詳しく入力する（数量・購入先・用途など）'}
          </button>
        </div>

        {showDetails && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, paddingTop: 4 }}>
            <div>
              <label style={labelStyle}>数量</label>
              <input type="number" min="0" value={quantity} onChange={e => setQuantity(e.target.value)} style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>購入先（店舗名）</label>
              <input type="text" value={storeName} onChange={e => setStoreName(e.target.value)} placeholder="例：〇〇ホームセンター" style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>用途・使用先</label>
              <input type="text" value={purpose} onChange={e => setPurpose(e.target.value)} placeholder="例：〇〇教室のトイレ用" style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>指示者（誰からの依頼か）</label>
              <input list="instructed-by-list" type="text" value={instructedBy} onChange={e => setInstructedBy(e.target.value)} placeholder="例：総務部、〇〇マネージャー" style={inputStyle} />
              <datalist id="instructed-by-list">
                <option value="総務部" />
              </datalist>
            </div>
            <div>
              <label style={labelStyle}>備考</label>
              <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} style={{ ...inputStyle, resize: 'vertical' as const }} />
            </div>
          </div>
        )}

        {formError && (
          <div style={{ padding: '10px 12px', background: '#fff5f5', border: '1px solid #f5c2c7', borderRadius: 8, color: '#842029', fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span>{formError}</span>
            <button type="button" onClick={() => setFormError('')} style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: '#842029', fontSize: 16 }}>✕</button>
          </div>
        )}

        <button
          type="button"
          onClick={handleSubmit}
          disabled={submitting}
          style={{ width: '100%', padding: '14px', borderRadius: 10, border: 'none', background: submitting ? subText : '#28a745', color: '#fff', fontSize: 15, fontWeight: 'bold', cursor: submitting ? 'default' : 'pointer' }}
        >
          {submitting ? '記録しています...' : '記録する'}
        </button>
      </div>
    </div>
  );
};

export default ReimbursementForm;

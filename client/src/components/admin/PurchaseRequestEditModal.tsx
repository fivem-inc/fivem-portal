import React, { useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import type { PurchaseRequestCSVRow } from '../../utils';

const PAYMENT_OPTIONS: { value: string; label: string }[] = [
  { value: 'cash', label: '立替（返金あり）' },
  { value: 'company_card', label: '会社カード（返金なし）' },
];

interface PurchaseRequestEditModalProps {
  record: PurchaseRequestCSVRow;
  isDarkMode: boolean;
  onClose: () => void;
  onSaved: () => void;
}

const PurchaseRequestEditModal: React.FC<PurchaseRequestEditModalProps> = ({ record, isDarkMode, onClose, onSaved }) => {
  const [itemName, setItemName] = useState(record.item_name);
  const [quantity, setQuantity] = useState(String(record.quantity ?? 1));
  const [amount, setAmount] = useState(String(record.amount));
  const [purchasedAt, setPurchasedAt] = useState(record.purchased_at ?? record.requested_purchase_date ?? '');
  const [storeName, setStoreName] = useState(record.store_name ?? '');
  const [purpose, setPurpose] = useState(record.purpose ?? '');
  const [location, setLocation] = useState(record.location ?? '');
  const [instructedBy, setInstructedBy] = useState(record.instructed_by ?? '');
  const [paymentMethod, setPaymentMethod] = useState(record.payment_method ?? '');
  const [notes, setNotes] = useState(record.notes ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const cardBg = isDarkMode ? '#2d2d3e' : '#ffffff';
  const border = isDarkMode ? '#3a3a5c' : '#e0e0e0';
  const text = isDarkMode ? '#eeeeee' : '#222222';
  const inputBg = isDarkMode ? '#3a3a5c' : '#f8f9fa';
  const hasMultipleItems = (record.items?.length ?? 0) > 1;

  const inputStyle: React.CSSProperties = {
    width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 8,
    border: `1px solid ${border}`, background: inputBg, color: text, fontSize: 14,
  };
  const labelStyle: React.CSSProperties = { fontSize: 12, fontWeight: 'bold', color: text, marginBottom: 4, display: 'block' };

  const handleSave = async () => {
    setError('');
    const parsedQuantity = parseInt(quantity, 10);
    const parsedAmount = parseInt(amount, 10);
    if (!itemName.trim()) { setError('品目名を入力してください。'); return; }
    if (isNaN(parsedQuantity) || parsedQuantity < 1) { setError('数量を正しく入力してください。'); return; }
    if (isNaN(parsedAmount)) { setError('金額を正しく入力してください。'); return; }

    const nextValues: Record<string, string | number | null> = {
      item_name: itemName.trim(),
      quantity: parsedQuantity,
      amount: parsedAmount,
      purchased_at: purchasedAt || null,
      store_name: storeName.trim() || null,
      purpose: purpose.trim() || null,
      location: location.trim() || null,
      instructed_by: instructedBy.trim() || null,
      payment_method: paymentMethod || null,
      notes: notes.trim() || null,
    };
    const prevValues: Record<string, string | number | null> = {
      item_name: record.item_name,
      quantity: record.quantity,
      amount: record.amount,
      purchased_at: record.purchased_at ?? record.requested_purchase_date ?? null,
      store_name: record.store_name,
      purpose: record.purpose,
      location: record.location,
      instructed_by: record.instructed_by,
      payment_method: record.payment_method,
      notes: record.notes,
    };
    const changes: Record<string, { old: string | number | null; new: string | number | null }> = {};
    Object.keys(nextValues).forEach(key => {
      if (String(prevValues[key] ?? '') !== String(nextValues[key] ?? '')) {
        changes[key] = { old: prevValues[key], new: nextValues[key] };
      }
    });

    if (Object.keys(changes).length === 0) {
      onSaved();
      return;
    }

    setSaving(true);
    const { error: updateError } = await supabase.from('purchase_requests').update(nextValues).eq('id', record.id);
    if (updateError) {
      setSaving(false);
      setError('保存に失敗しました: ' + updateError.message);
      return;
    }

    const { data: { user } } = await supabase.auth.getUser();
    await supabase.from('purchase_request_edit_log').insert({
      purchase_request_id: record.id,
      edited_by: user?.id ?? null,
      changes,
    });

    setSaving(false);
    onSaved();
  };

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 10000, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ background: cardBg, borderRadius: 12, padding: 20, width: '100%', maxWidth: 420, maxHeight: '90vh', overflowY: 'auto' }}>
        <div style={{ fontSize: 16, fontWeight: 'bold', color: text, marginBottom: 12 }}>申請内容を修正</div>

        {hasMultipleItems && (
          <div style={{ marginBottom: 10, padding: 10, background: isDarkMode ? '#3a3220' : '#fff8e1', border: `1px solid ${isDarkMode ? '#5c5430' : '#ffe082'}`, borderRadius: 8, fontSize: 12, color: isDarkMode ? '#ffe082' : '#8a6d00' }}>
            この申請は複数商品の明細を持っています。ここでの編集は申請全体の代表項目のみで、商品明細（{record.items.length}件）は変更されません。
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div>
            <label style={labelStyle}>品目名</label>
            <input style={inputStyle} value={itemName} onChange={e => setItemName(e.target.value)} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div>
              <label style={labelStyle}>数量</label>
              <input style={inputStyle} type="number" min={1} value={quantity} onChange={e => setQuantity(e.target.value)} />
            </div>
            <div>
              <label style={labelStyle}>金額</label>
              <input style={inputStyle} type="number" value={amount} onChange={e => setAmount(e.target.value)} />
            </div>
          </div>
          <div>
            <label style={labelStyle}>購入日</label>
            <input style={inputStyle} type="date" value={purchasedAt} onChange={e => setPurchasedAt(e.target.value)} />
          </div>
          <div>
            <label style={labelStyle}>購入先</label>
            <input style={inputStyle} value={storeName} onChange={e => setStoreName(e.target.value)} />
          </div>
          <div>
            <label style={labelStyle}>用途</label>
            <input style={inputStyle} value={purpose} onChange={e => setPurpose(e.target.value)} />
          </div>
          <div>
            <label style={labelStyle}>使用先</label>
            <input style={inputStyle} value={location} onChange={e => setLocation(e.target.value)} />
          </div>
          <div>
            <label style={labelStyle}>指示者</label>
            <input style={inputStyle} value={instructedBy} onChange={e => setInstructedBy(e.target.value)} />
          </div>
          <div>
            <label style={labelStyle}>支払方法</label>
            <select style={inputStyle} value={paymentMethod} onChange={e => setPaymentMethod(e.target.value)}>
              <option value="">選択してください</option>
              {PAYMENT_OPTIONS.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
            </select>
          </div>
          <div>
            <label style={labelStyle}>備考</label>
            <textarea style={{ ...inputStyle, minHeight: 60, resize: 'vertical' }} value={notes} onChange={e => setNotes(e.target.value)} />
          </div>
        </div>

        {error && (
          <div style={{ marginTop: 10, padding: 10, background: '#fff5f5', border: '1px solid #f5c2c7', borderRadius: 8, color: '#842029', fontSize: 13 }}>
            {error}
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 16 }}>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            style={{ padding: '10px', borderRadius: 8, border: `1px solid ${border}`, background: 'transparent', color: text, fontWeight: 'bold', cursor: saving ? 'default' : 'pointer' }}
          >
            キャンセル
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            style={{ padding: '10px', borderRadius: 8, border: 'none', background: saving ? '#777' : '#28a745', color: '#fff', fontWeight: 'bold', cursor: saving ? 'default' : 'pointer' }}
          >
            {saving ? '保存中...' : '保存する'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default PurchaseRequestEditModal;

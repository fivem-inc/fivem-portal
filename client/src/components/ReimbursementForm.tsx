import React, { useState, useEffect } from 'react';
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

  const [draftId, setDraftId] = useState(() => crypto.randomUUID());
  const [itemName, setItemName] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [amount, setAmount] = useState('');
  const [purchasedAt, setPurchasedAt] = useState(() => new Date().toISOString().slice(0, 10));
  const [storeName, setStoreName] = useState('');
  const [location, setLocation] = useState('');
  const [purpose, setPurpose] = useState('');
  const [purposeDetail, setPurposeDetail] = useState('');
  const [instructedBySelect, setInstructedBySelect] = useState('');
  const [instructedByCustom, setInstructedByCustom] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'company_card' | ''>('');
  const [receipt, setReceipt] = useState<ReceiptValue>(emptyReceipt);
  const [receiptUploading, setReceiptUploading] = useState(false);
  const [notes, setNotes] = useState('');
  const [instructors, setInstructors] = useState<{ name: string; role_title: string }[]>([]);
  const [workplaceOptions, setWorkplaceOptions] = useState<string[]>([]);
  const [purposeOptions, setPurposeOptions] = useState<string[]>([]);
  const draftStorageKey = `reimbursement-draft:${user.id}`;
  const [draftReady, setDraftReady] = useState(false);

  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(draftStorageKey);
      if (saved) {
        const draft = JSON.parse(saved);
        if (typeof draft.draftId === 'string') setDraftId(draft.draftId);
        if (typeof draft.itemName === 'string') setItemName(draft.itemName);
        if (typeof draft.quantity === 'string') setQuantity(draft.quantity);
        if (typeof draft.amount === 'string') setAmount(draft.amount);
        if (typeof draft.purchasedAt === 'string') setPurchasedAt(draft.purchasedAt);
        if (typeof draft.storeName === 'string') setStoreName(draft.storeName);
        if (typeof draft.location === 'string') setLocation(draft.location);
        if (typeof draft.purpose === 'string') setPurpose(draft.purpose);
        if (typeof draft.purposeDetail === 'string') setPurposeDetail(draft.purposeDetail);
        if (typeof draft.instructedBySelect === 'string') setInstructedBySelect(draft.instructedBySelect);
        if (typeof draft.instructedByCustom === 'string') setInstructedByCustom(draft.instructedByCustom);
        if (draft.paymentMethod === 'cash' || draft.paymentMethod === 'company_card' || draft.paymentMethod === '') setPaymentMethod(draft.paymentMethod);
        if (draft.receipt && typeof draft.receipt === 'object') setReceipt({ ...emptyReceipt, ...draft.receipt });
        if (typeof draft.notes === 'string') setNotes(draft.notes);
      }
    } catch {
      sessionStorage.removeItem(draftStorageKey);
    } finally {
      setDraftReady(true);
    }
  }, [draftStorageKey]);

  useEffect(() => {
    if (!draftReady) return;
    const hasDraft = Boolean(
      itemName.trim() || amount.trim() || storeName.trim() || location.trim() || purpose.trim() || purposeDetail.trim() ||
      instructedBySelect || instructedByCustom.trim() || paymentMethod || receipt.receiptType || notes.trim() || quantity !== '1'
    );
    if (!hasDraft) {
      sessionStorage.removeItem(draftStorageKey);
      return;
    }
    sessionStorage.setItem(draftStorageKey, JSON.stringify({
      draftId, itemName, quantity, amount, purchasedAt, storeName, location, purpose, purposeDetail,
      instructedBySelect, instructedByCustom, paymentMethod, receipt, notes,
    }));
  }, [draftReady, draftStorageKey, draftId, itemName, quantity, amount, purchasedAt, storeName, location, purpose, purposeDetail, instructedBySelect, instructedByCustom, paymentMethod, receipt, notes]);

  useEffect(() => {
    supabase.from('profiles').select('name, role_title').eq('is_active', true)
      .in('role_title', ['リーダー', 'マネージャー']).order('role_title').order('name').then(
        ({ data }) => setInstructors((data ?? []) as { name: string; role_title: string }[]),
        () => {}
      );

    supabase.from('master_options').select('category, value, sort_order').order('sort_order').then(
      ({ data }) => {
        const rows = (data ?? []) as { category: string; value: string; sort_order: number }[];
        setWorkplaceOptions(rows.filter(r => r.category === 'workplace').map(r => r.value));
        setPurposeOptions(rows.filter(r => r.category === 'purchase_purpose').map(r => r.value));
      },
      () => {}
    );
  }, []);

  const instructedBy = instructedBySelect === 'その他' ? instructedByCustom.trim() : instructedBySelect;
  const finalPurpose = purposeOptions.includes(purpose) && purposeDetail.trim()
    ? `${purpose}（${purposeDetail.trim()}）`
    : purpose;

  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [successBanner, setSuccessBanner] = useState(false);

  const resetForm = () => {
    setItemName(''); setQuantity('1'); setAmount(''); setPurchasedAt(new Date().toISOString().slice(0, 10));
    setStoreName(''); setLocation(''); setPurpose(''); setPurposeDetail(''); setInstructedBySelect(''); setInstructedByCustom('');
    setPaymentMethod(''); setReceipt(emptyReceipt); setReceiptUploading(false); setNotes('');
    setDraftId(crypto.randomUUID());
    sessionStorage.removeItem(draftStorageKey);
  };

  const handleSubmit = async () => {
    setFormError('');
    if (!itemName.trim()) { setFormError('品目名を入力してください。'); return; }
    const parsedQuantity = parseInt(quantity, 10);
    if (!quantity.trim() || isNaN(parsedQuantity) || parsedQuantity < 1) { setFormError('購入点数を1以上で入力してください。'); return; }
    const parsedAmount = parseInt(parseAmount(amount), 10);
    if (!amount.trim() || isNaN(parsedAmount)) { setFormError('金額を正しく入力してください。'); return; }
    if (!purchasedAt) { setFormError('購入日を入力してください。'); return; }
    if (!storeName.trim()) { setFormError('購入先を入力してください。'); return; }
    if (!location.trim()) { setFormError('使用先を入力してください。'); return; }
    if (!finalPurpose.trim()) { setFormError('用途を入力してください。'); return; }
    if (!paymentMethod) { setFormError('支払方法を選択してください。'); return; }
    if (!receipt.receiptType) { setFormError('レシートの提出方法を選択してください。'); return; }
    if (receiptUploading) { setFormError('レシート写真をアップロード中です。完了までお待ちください。'); return; }
    if (receipt.receiptType === 'photo' && !receipt.receiptStoragePath) { setFormError('レシート写真のアップロードがまだ完了していません。レシート欄に『レシートを添付しました』と表示されてから送信してください。'); return; }
    if (receipt.receiptType === 'none' && !receipt.receiptMissingReason.trim()) { setFormError('レシートがない理由を入力してください。'); return; }

    setSubmitting(true);
    const { error } = await supabase.from('purchase_requests').insert({
      id: draftId,
      user_id: user.id,
      applicant_role_title: roleTitle,
      request_type: 'reimbursement',
      item_name: itemName.trim(),
      quantity: parsedQuantity,
      amount: parsedAmount,
      purchased_at: purchasedAt,
      instructed_by: instructedBy.trim() || null,
      store_name: storeName.trim(),
      purpose: finalPurpose.trim(),
      location: location.trim(),
      payment_method: paymentMethod,
      notes: notes.trim() || null,
      receipt_type: receipt.receiptType,
      receipt_missing_reason: receipt.receiptType === 'none' ? receipt.receiptMissingReason.trim() : null,
      receipt_storage_path: receipt.receiptType === 'photo' ? receipt.receiptStoragePath : null,
      status: 'recorded',
    });
    setSubmitting(false);

    if (error) {
      setFormError('送信に失敗しました: ' + error.message);
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
  const required = <span style={{ color: '#dc3545' }}>*</span>;

  return (
    <div>
      {successBanner && (
        <BannerSuccess
          message="精算を送信しました"
          sub="内容は履歴タブから確認できます"
          onClose={() => setSuccessBanner(false)}
        />
      )}

      <div style={{ background: cardBg, border: `1px solid ${border}`, borderRadius: 12, padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div>
          <label style={labelStyle}>品目名 {required}</label>
          <input type="text" value={itemName} onChange={e => setItemName(e.target.value)} placeholder="例：トイレットペーパー" style={inputStyle} />
        </div>

        <div>
          <label style={labelStyle}>購入点数 {required}</label>
          <input type="number" min="1" value={quantity} onChange={e => setQuantity(e.target.value)} style={inputStyle} />
        </div>

        <div>
          <label style={labelStyle}>金額 {required}</label>
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
          <label style={labelStyle}>購入日 {required}</label>
          <input type="date" value={purchasedAt} onChange={e => setPurchasedAt(e.target.value)} style={inputStyle} />
        </div>

        <div>
          <label style={labelStyle}>購入先 {required}</label>
          <input type="text" value={storeName} onChange={e => setStoreName(e.target.value)} placeholder="例：〇〇ホームセンター" style={inputStyle} />
        </div>

        <div>
          <label style={labelStyle}>使用先 {required}</label>
          {workplaceOptions.length > 0 ? (
            <>
              <select
                value={workplaceOptions.includes(location) ? location : (location ? 'その他' : '')}
                onChange={e => setLocation(e.target.value === 'その他' ? '' : e.target.value)}
                style={inputStyle}
              >
                <option value="">選択してください</option>
                {workplaceOptions.map(loc => <option key={loc} value={loc}>{loc}</option>)}
                <option value="その他">その他</option>
              </select>
              {!workplaceOptions.includes(location) && (
                <input
                  type="text" value={location} onChange={e => setLocation(e.target.value)}
                  placeholder="使用先を入力" style={{ ...inputStyle, marginTop: 6 }}
                />
              )}
            </>
          ) : (
            <input type="text" value={location} onChange={e => setLocation(e.target.value)} placeholder="使用先を入力" style={inputStyle} />
          )}
        </div>

        <div>
          <label style={labelStyle}>用途 {required}</label>
          {purposeOptions.length > 0 ? (
            <>
              <select
                value={purposeOptions.includes(purpose) ? purpose : (purpose ? 'その他' : '')}
                onChange={e => setPurpose(e.target.value === 'その他' ? '' : e.target.value)}
                style={inputStyle}
              >
                <option value="">選択してください</option>
                {purposeOptions.filter(p => p !== 'その他').map(p => <option key={p} value={p}>{p}</option>)}
                <option value="その他">その他</option>
              </select>
              {!purposeOptions.includes(purpose) ? (
                <input
                  type="text" value={purpose} onChange={e => setPurpose(e.target.value)}
                  placeholder="用途を入力" style={{ ...inputStyle, marginTop: 6 }}
                />
              ) : (
                <input
                  type="text" value={purposeDetail} onChange={e => setPurposeDetail(e.target.value)}
                  placeholder="詳細（任意）" style={{ ...inputStyle, marginTop: 6 }}
                />
              )}
            </>
          ) : (
            <input type="text" value={purpose} onChange={e => setPurpose(e.target.value)} placeholder="用途を入力" style={inputStyle} />
          )}
        </div>

        <div>
          <label style={labelStyle}>指示者（誰からの依頼か）</label>
          <select value={instructedBySelect} onChange={e => setInstructedBySelect(e.target.value)} style={inputStyle}>
            <option value="">選択してください（任意）</option>
            <option value="総務部">総務部</option>
            {instructors.map(p => (
              <option key={p.name} value={`${p.name}（${p.role_title}）`}>{p.name}（{p.role_title}）</option>
            ))}
            <option value="その他">その他（自由記述）</option>
          </select>
          {instructedBySelect === 'その他' && (
            <input
              type="text" value={instructedByCustom} onChange={e => setInstructedByCustom(e.target.value)}
              placeholder="指示者名を入力してください" style={{ ...inputStyle, marginTop: 8 }}
            />
          )}
        </div>

        <div>
          <label style={labelStyle}>この支出はどちらで払いましたか？ {required}</label>
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
              会社カード払いのため、この記録に返金は発生しません。
            </div>
          )}
        </div>

        <ReceiptUploader
          isDarkMode={isDarkMode}
          userId={user.id}
          draftId={draftId}
          value={receipt}
          onChange={patch => setReceipt(prev => ({ ...prev, ...patch }))}
          onUploadingChange={setReceiptUploading}
        />

        <div style={{ padding: '8px 12px', background: isDarkMode ? '#243447' : '#eef6ff', border: `1px solid ${isDarkMode ? '#375a7f' : '#b6dcff'}`, borderRadius: 8, fontSize: 12, color: isDarkMode ? '#d6ecff' : '#174a7c' }}>
          原本確認が必要になる場合があります。紙のレシートは少なくとも3か月は保管してください。
        </div>

        <div>
          <label style={labelStyle}>備考</label>
          <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} style={{ ...inputStyle, resize: 'vertical' as const }} />
        </div>

        {formError && (
          <div style={{ padding: '10px 12px', background: '#fff5f5', border: '1px solid #f5c2c7', borderRadius: 8, color: '#842029', fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span>{formError}</span>
            <button type="button" onClick={() => setFormError('')} style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: '#842029', fontSize: 16 }}>✕</button>
          </div>
        )}

        <button
          type="button"
          onClick={handleSubmit}
          disabled={submitting || receiptUploading}
          style={{ width: '100%', padding: '14px', borderRadius: 10, border: 'none', background: submitting || receiptUploading ? subText : '#28a745', color: '#fff', fontSize: 15, fontWeight: 'bold', cursor: submitting || receiptUploading ? 'default' : 'pointer' }}
        >
          {submitting ? '送信しています...' : receiptUploading ? 'レシートをアップロード中...' : '送信する'}
        </button>
      </div>
    </div>
  );
};

export default ReimbursementForm;

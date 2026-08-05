import React, { useState, useEffect } from 'react';
import type { AuthUser } from '../types';
import { formatAmount, parseAmount, paymentMethodLabel } from '../utils';
import { supabase } from '../lib/supabaseClient';
import { useDarkMode } from '../hooks/useDarkMode';
import ReceiptUploader, { type ReceiptValue } from './ReceiptUploader';
import { todayJstStr } from '../lib/breakCalc';
import { errorStyle, scrollToFirstError } from '../lib/formHighlight';
import { getUserName } from '../lib/notificationDispatch';

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
  const cardBg = isDarkMode ? '#343a40' : '#ffffff';
  const border = isDarkMode ? '#495057' : '#e0e0e0';
  const text = isDarkMode ? '#eeeeee' : '#222222';
  const subText = isDarkMode ? '#aaaaaa' : '#666666';
  const inputBg = isDarkMode ? '#495057' : '#f8f9fa';

  const [draftId, setDraftId] = useState(() => crypto.randomUUID());
  const [itemName, setItemName] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [amount, setAmount] = useState('');
  const [purchasedAt, setPurchasedAt] = useState(() => todayJstStr());
  const [storeName, setStoreName] = useState('');
  const [location, setLocation] = useState('');
  const [purpose, setPurpose] = useState('');
  const [purposeDetail, setPurposeDetail] = useState('');
  const [instructedBySelect, setInstructedBySelect] = useState('');
  const [instructedByCustom, setInstructedByCustom] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'company_paid' | ''>('');
  const [paymentMethodDetail, setPaymentMethodDetail] = useState<'company_card' | 'bank_transfer' | 'cash_on_delivery' | 'other' | ''>('');
  const [paymentMethodOther, setPaymentMethodOther] = useState('');
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
      const saved = localStorage.getItem(draftStorageKey);
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
        if (draft.paymentMethod === 'cash' || draft.paymentMethod === 'company_paid' || draft.paymentMethod === '') setPaymentMethod(draft.paymentMethod);
        if (['company_card', 'bank_transfer', 'cash_on_delivery', 'other', ''].includes(draft.paymentMethodDetail)) setPaymentMethodDetail(draft.paymentMethodDetail);
        if (typeof draft.paymentMethodOther === 'string') setPaymentMethodOther(draft.paymentMethodOther);
        if (draft.receipt && typeof draft.receipt === 'object') setReceipt({ ...emptyReceipt, ...draft.receipt });
        if (typeof draft.notes === 'string') setNotes(draft.notes);
      }
    } catch {
      localStorage.removeItem(draftStorageKey);
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
      localStorage.removeItem(draftStorageKey);
      return;
    }
    localStorage.setItem(draftStorageKey, JSON.stringify({
      draftId, itemName, quantity, amount, purchasedAt, storeName, location, purpose, purposeDetail,
      instructedBySelect, instructedByCustom, paymentMethod, paymentMethodDetail, paymentMethodOther, receipt, notes,
    }));
  }, [draftReady, draftStorageKey, draftId, itemName, quantity, amount, purchasedAt, storeName, location, purpose, purposeDetail, instructedBySelect, instructedByCustom, paymentMethod, paymentMethodDetail, paymentMethodOther, receipt, notes]);

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
  // 入力漏れの欄を薄赤にするためのキー集合（lib/formHighlight.ts の共通色を使う）
  const [errFields, setErrFields] = useState<Set<string>>(new Set());
  // 送信前の確認画面
  const [showConfirm, setShowConfirm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [successBanner, setSuccessBanner] = useState(false);

  const resetForm = () => {
    setItemName(''); setQuantity('1'); setAmount(''); setPurchasedAt(todayJstStr());
    setStoreName(''); setLocation(''); setPurpose(''); setPurposeDetail(''); setInstructedBySelect(''); setInstructedByCustom('');
    setPaymentMethod(''); setPaymentMethodDetail(''); setPaymentMethodOther(''); setReceipt(emptyReceipt); setReceiptUploading(false); setNotes('');
    setDraftId(crypto.randomUUID());
    localStorage.removeItem(draftStorageKey);
  };

  const handleSubmit = async () => {
    setFormError('');
    // 足りない項目をまとめて集め、赤バナー＋該当欄のハイライト＋最初の欄へスクロールで知らせる
    // （1件ずつ返す作りだと「どこが原因か分からない」と実機で指摘された）
    const missing: { key: string; label: string }[] = [];
    const parsedQuantity = parseInt(quantity, 10);
    const parsedAmount = parseInt(parseAmount(amount), 10);

    if (!itemName.trim()) missing.push({ key: 'itemName', label: '品目名' });
    if (!quantity.trim() || isNaN(parsedQuantity) || parsedQuantity < 1) missing.push({ key: 'quantity', label: '購入点数（1以上）' });
    if (!amount.trim() || isNaN(parsedAmount) || parsedAmount < 1) missing.push({ key: 'amount', label: '金額（1円以上）' });
    if (!purchasedAt) missing.push({ key: 'purchasedAt', label: '購入日' });
    if (!storeName.trim()) missing.push({ key: 'storeName', label: '購入先' });
    if (!location.trim()) missing.push({ key: 'location', label: '使用先' });
    if (!finalPurpose.trim()) missing.push({ key: 'purpose', label: '用途' });
    if (!paymentMethod) missing.push({ key: 'paymentMethod', label: '支払方法' });
    if (paymentMethod === 'company_paid' && !paymentMethodDetail) missing.push({ key: 'paymentMethodDetail', label: '会社支払の内訳' });
    if (paymentMethodDetail === 'other' && !paymentMethodOther.trim()) missing.push({ key: 'paymentMethodOther', label: '支払方法（その他）の内容' });
    if (!receipt.receiptType) missing.push({ key: 'receiptType', label: 'レシートの提出方法' });
    if (receipt.receiptType === 'none' && !receipt.receiptMissingReason.trim()) missing.push({ key: 'receiptMissingReason', label: 'レシートがない理由' });

    if (missing.length > 0) {
      setErrFields(new Set(missing.map(m => m.key)));
      setFormError(`次の項目を入力してください：${missing.map(m => m.label).join('、')}`);
      scrollToFirstError(missing.map(m => m.key));
      return;
    }
    setErrFields(new Set());

    // アップロード中・未完了は入力漏れではないので、ハイライトではなくメッセージだけで止める
    if (receiptUploading) { setFormError('レシート写真をアップロード中です。完了までお待ちください。'); return; }
    if (receipt.receiptType === 'photo' && !receipt.receiptStoragePath) { setFormError('レシート写真のアップロードがまだ完了していません。レシート欄に『レシートを添付しました』と表示されてから送信してください。'); return; }

    // 送信前に内容を確認できるようにする（他の申請ページと同じ流れに揃えた）
    setShowConfirm(true);
  };

  const doSubmit = async () => {
    setShowConfirm(false);
    const parsedQuantity = parseInt(quantity, 10);
    const parsedAmount = parseInt(parseAmount(amount), 10);
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
      payment_method_detail: paymentMethod === 'company_paid' ? paymentMethodDetail : null,
      payment_method_other: paymentMethodDetail === 'other' ? paymentMethodOther.trim() : null,
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

    // 氏名は profiles.name から取る（user_metadata は full_name で入っている人がいて空になる）
    getUserName(user.id).then(nm => {
      supabase.functions.invoke('purchase-reimbursement-notify', {
        body: { user_id: user.id, user_name: nm, item_name: itemName.trim(), amount: parsedAmount },
      }).then(null, () => {});
    }, () => {});

    setSuccessBanner(true);
    resetForm();
  };

  const labelStyle: React.CSSProperties = { fontSize: 13, fontWeight: 'bold', color: text, marginBottom: 6, display: 'block' };
  const inputStyle: React.CSSProperties = { width: '100%', boxSizing: 'border-box', padding: '10px 12px', borderRadius: 8, border: `1px solid ${border}`, background: inputBg, color: text, fontSize: 14 };
  // エラーの欄だけ薄赤にする。入力し直したらその欄のハイライトを消す
  const errStyle = (key: string): React.CSSProperties => ({ ...inputStyle, ...errorStyle(errFields.has(key), isDarkMode) });
  const clearErr = (key: string) => setErrFields(prev => {
    if (!prev.has(key)) return prev;
    const next = new Set(prev); next.delete(key); return next;
  });
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
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: -6 }}>
          <button type="button" onClick={resetForm}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: subText, background: 'none', border: `1px solid ${border}`, borderRadius: 14, padding: '4px 12px', cursor: 'pointer' }}>
            クリア
          </button>
        </div>
        <div>
          <label style={labelStyle}>品目名 {required}</label>
          <input data-err-field="itemName" type="text" value={itemName} onChange={e => { setItemName(e.target.value); clearErr('itemName'); }} placeholder="例：トイレットペーパー" style={errStyle('itemName')} />
        </div>

        <div>
          <label style={labelStyle}>購入点数 {required}</label>
          <input data-err-field="quantity" type="number" min="1" value={quantity} onChange={e => { setQuantity(e.target.value); clearErr('quantity'); }} style={errStyle('quantity')} />
        </div>

        <div>
          <label style={labelStyle}>金額 {required}</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ color: text, fontSize: 14 }}>¥</span>
            <input
              type="text" inputMode="numeric" value={amount}
              onChange={e => { setAmount(formatAmount(parseAmount(e.target.value))); clearErr('amount'); }}
              placeholder="0" style={errStyle('amount')} data-err-field="amount"
            />
          </div>
        </div>

        <div>
          <label style={labelStyle}>購入日 {required}</label>
          <input data-err-field="purchasedAt" type="date" value={purchasedAt} onChange={e => { setPurchasedAt(e.target.value); clearErr('purchasedAt'); }} style={errStyle('purchasedAt')} />
        </div>

        <div>
          <label style={labelStyle}>購入先 {required}</label>
          <input data-err-field="storeName" type="text" value={storeName} onChange={e => { setStoreName(e.target.value); clearErr('storeName'); }} placeholder="例：〇〇ホームセンター" style={errStyle('storeName')} />
        </div>

        <div>
          <label style={labelStyle}>使用先 {required}</label>
          {workplaceOptions.length > 0 ? (
            <>
              <select
                value={workplaceOptions.includes(location) ? location : (location ? 'その他' : '')}
                onChange={e => { setLocation(e.target.value === 'その他' ? '' : e.target.value); clearErr('location'); }}
                style={errStyle('location')} data-err-field="location"
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
                data-err-field="purpose"
                value={purposeOptions.includes(purpose) ? purpose : (purpose ? 'その他' : '')}
                onChange={e => { setPurpose(e.target.value === 'その他' ? '' : e.target.value); clearErr('purpose'); }}
                style={errStyle('purpose')}
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
              { key: 'company_paid' as const, label: '② 会社支払（記録のみ・返金なし）' },
            ].map(opt => {
              const active = paymentMethod === opt.key;
              return (
                <button
                  key={opt.key} type="button"
                  onClick={() => { setPaymentMethod(opt.key); if (opt.key === 'cash') { setPaymentMethodDetail(''); setPaymentMethodOther(''); } }}
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
          {paymentMethod === 'company_paid' && (
            <div style={{ marginTop: 10 }}>
              <label style={labelStyle}>内訳 {required}</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {[
                  { key: 'company_card' as const, label: '会社カード' },
                  { key: 'bank_transfer' as const, label: '振込' },
                  { key: 'cash_on_delivery' as const, label: '代引き' },
                  { key: 'other' as const, label: 'その他' },
                ].map(opt => {
                  const active = paymentMethodDetail === opt.key;
                  return (
                    <button
                      key={opt.key} type="button" onClick={() => setPaymentMethodDetail(opt.key)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderRadius: 10,
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
              {paymentMethodDetail === 'other' && (
                <input
                  type="text" value={paymentMethodOther} onChange={e => setPaymentMethodOther(e.target.value)}
                  placeholder="支払方法を入力してください" style={{ ...inputStyle, marginTop: 8 }}
                />
              )}
              <div style={{ marginTop: 8, padding: '8px 12px', background: isDarkMode ? '#3a3a20' : '#fff8e1', border: `1px solid ${isDarkMode ? '#5c5430' : '#ffe082'}`, borderRadius: 8, fontSize: 12, color: isDarkMode ? '#fff' : '#8a6d00' }}>
                会社支払のため、この記録に返金は発生しません。
              </div>
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

      {/* 送信前の確認画面。精算は承認ルートが無いので、内容の読み合わせだけ */}
      {showConfirm && (() => {
        const row = (label: string, value: React.ReactNode) => (
          <div style={{ display: 'flex', gap: 8, fontSize: 13, color: text, marginBottom: 4 }}>
            <span style={{ color: subText, flexShrink: 0, minWidth: 76 }}>{label}</span>
            <span style={{ flex: 1, wordBreak: 'break-word' }}>{value}</span>
          </div>
        );
        // 支払方法の表示は他画面と同じ共通関数に揃える（表記のズレを作らない）
        const paymentText = paymentMethodLabel({
          payment_method: paymentMethod || null,
          payment_method_detail: paymentMethodDetail || null,
          payment_method_other: paymentMethodOther.trim() || null,
        });
        const receiptText = receipt.receiptType === 'photo' ? '写真を添付'
          : receipt.receiptType === 'physical' ? '直接提出する'
          : `なし（${receipt.receiptMissingReason}）`;
        return (
          <div
            onClick={() => setShowConfirm(false)}
            style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 9998, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
          >
            <div onClick={e => e.stopPropagation()} style={{ background: cardBg, borderRadius: 12, padding: 18, width: '100%', maxWidth: 440, maxHeight: '85vh', overflowY: 'auto' }}>
              <div style={{ fontSize: 15, fontWeight: 'bold', color: text, marginBottom: 12, textAlign: 'center' }}>この内容で記録します</div>

              {row('品目', `${itemName} × ${quantity}`)}
              {row('金額', <span style={{ fontWeight: 'bold' }}>¥{amount}</span>)}
              {row('購入日', purchasedAt)}
              {row('購入先', storeName)}
              {row('使用先', location)}
              {row('用途', finalPurpose)}
              {instructedBy && row('指示者', instructedBy)}
              {row('支払方法', paymentText)}
              {row('レシート', receiptText)}
              {notes.trim() && row('備考', notes)}

              <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
                <button
                  type="button" onClick={() => setShowConfirm(false)}
                  style={{ flex: 1, padding: '12px', borderRadius: 8, border: `1px solid ${border}`, background: 'transparent', color: text, fontSize: 14, cursor: 'pointer' }}
                >
                  修正する
                </button>
                <button
                  type="button" onClick={doSubmit} disabled={submitting}
                  style={{ flex: 1, padding: '12px', borderRadius: 8, border: 'none', background: submitting ? subText : '#28a745', color: '#fff', fontSize: 14, fontWeight: 'bold', cursor: submitting ? 'default' : 'pointer' }}
                >
                  {submitting ? '送信しています...' : 'この内容で記録する'}
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
};

export default ReimbursementForm;

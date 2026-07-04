import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import type { AuthUser } from '../types';
import { formatAmount, parseAmount } from '../utils';
import { supabase } from '../lib/supabaseClient';
import { useDarkMode } from '../hooks/useDarkMode';
import { insertNotification } from '../lib/notifications';
import { dispatchSiteNotification, getNotificationTemplate } from '../lib/notificationDispatch';
import QuoteFileUploader from './QuoteFileUploader';

const LEADER_LIMIT = 10000;
const MANAGER_LIMIT = 30000;
const QUOTES_REQUIRED_THRESHOLD = 10000;

type Tier = 'none' | 'leader' | 'manager' | 'over';
const tierOf = (amount: number): Tier => {
  if (isNaN(amount)) return 'none';
  if (amount <= LEADER_LIMIT) return 'leader';
  if (amount <= MANAGER_LIMIT) return 'manager';
  return 'over';
};
const TIER_LABEL: Record<Tier, string> = { none: '', leader: '1万円以下', manager: '1万円超〜3万円', over: '3万円超' };

interface QuoteRow { vendor: string; amount: string }
const emptyQuoteRow = (): QuoteRow => ({ vendor: '', amount: '' });

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

export interface ResubmitRecord {
  id: string;
  item_name: string;
  quantity: number | null;
  amount: number;
  requested_purchase_date: string | null;
  store_name: string | null;
  purpose: string | null;
  notes: string | null;
  leader_id: string | null;
  manager_id: string | null;
  shared_manager_ids: string[] | null;
  is_self_judgment: boolean;
  returned_reason: string | null;
  quotes: { vendor: string; amount: number }[] | null;
  quote_file_path: string | null;
}

interface PurchaseRequestFormProps {
  user: AuthUser;
  roleTitle: string;
  resubmitRecord?: ResubmitRecord | null;
  onDoneResubmit?: () => void;
}

const PurchaseRequestForm: React.FC<PurchaseRequestFormProps> = ({ user, roleTitle, resubmitRecord, onDoneResubmit }) => {
  const isDarkMode = useDarkMode();
  const navigate = useNavigate();
  const cardBg = isDarkMode ? '#2d2d3e' : '#ffffff';
  const border = isDarkMode ? '#3a3a5c' : '#e0e0e0';
  const text = isDarkMode ? '#eeeeee' : '#222222';
  const subText = isDarkMode ? '#aaaaaa' : '#666666';
  const inputBg = isDarkMode ? '#3a3a5c' : '#f8f9fa';
  const warnBg = isDarkMode ? '#3a3220' : '#fff8e1';
  const warnBorder = isDarkMode ? '#5c5430' : '#ffe082';
  const warnText = isDarkMode ? '#ffe082' : '#8a6d00';

  const isResubmit = !!resubmitRecord;
  const [draftId] = useState(() => resubmitRecord?.id ?? crypto.randomUUID());

  const [itemName, setItemName] = useState(resubmitRecord?.item_name ?? '');
  const [quantity, setQuantity] = useState(resubmitRecord?.quantity != null ? String(resubmitRecord.quantity) : '');
  const [amount, setAmount] = useState(resubmitRecord ? formatAmount(String(resubmitRecord.amount)) : '');
  const [requestedDate, setRequestedDate] = useState(resubmitRecord?.requested_purchase_date ?? new Date().toISOString().slice(0, 10));
  const [storeName, setStoreName] = useState(resubmitRecord?.store_name ?? '');
  const [purpose, setPurpose] = useState(resubmitRecord?.purpose ?? '');
  const [notes, setNotes] = useState(resubmitRecord?.notes ?? '');
  const [leaderId, setLeaderId] = useState(resubmitRecord?.leader_id ?? '');
  const [approvalMode, setApprovalMode] = useState<'approval' | 'self_judgment'>(resubmitRecord?.is_self_judgment ? 'self_judgment' : 'approval');
  const [managerId, setManagerId] = useState(resubmitRecord?.manager_id ?? '');
  const [sharedManagerIds, setSharedManagerIds] = useState<string[]>(resubmitRecord?.shared_manager_ids ?? []);
  const [leaders, setLeaders] = useState<{ id: string; name: string; role_title: string }[]>([]);
  const [managers, setManagers] = useState<{ id: string; name: string }[]>([]);
  const [showDetails, setShowDetails] = useState(isResubmit);
  const [quoteRows, setQuoteRows] = useState<QuoteRow[]>(() => {
    if (resubmitRecord?.quotes?.length) {
      return resubmitRecord.quotes.map(q => ({ vendor: q.vendor, amount: formatAmount(String(q.amount)) }));
    }
    return [emptyQuoteRow(), emptyQuoteRow()];
  });
  const [quoteFilePath, setQuoteFilePath] = useState<string | null>(resubmitRecord?.quote_file_path ?? null);

  useEffect(() => {
    supabase.from('profiles').select('id, name, role_title').eq('is_active', true)
      .in('role_title', ['リーダー', 'マネージャー']).order('role_title').order('name').then(
        ({ data }) => setLeaders((data ?? []) as { id: string; name: string; role_title: string }[]),
        () => {}
      );
    supabase.from('profiles').select('id, name').eq('is_active', true).eq('role_title', 'マネージャー').order('name').then(
      ({ data }) => setManagers((data ?? []) as { id: string; name: string }[]),
      () => {}
    );
  }, []);

  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [successBanner, setSuccessBanner] = useState(false);
  const [tierBanner, setTierBanner] = useState<string | null>(null);

  const parsedAmount = amount.trim() ? parseInt(parseAmount(amount), 10) : NaN;
  const tier = tierOf(parsedAmount);
  const quotesRequired = !isNaN(parsedAmount) && parsedAmount >= QUOTES_REQUIRED_THRESHOLD;

  // 金額帯(tier)が変わったら承認ルート関連の入力だけをリセットし、変化に気づけるようバナーを出す
  // （品目名・数量・購入予定日・購入先・用途・備考・相見積もりは保持する）
  const prevTierRef = useRef<Tier | null>(null);
  useEffect(() => {
    if (prevTierRef.current !== null && prevTierRef.current !== tier && tier !== 'none') {
      setTierBanner(`${TIER_LABEL[tier]}の金額になったため、承認に関する入力項目が変わりました`);
      setLeaderId(''); setManagerId(''); setSharedManagerIds([]); setApprovalMode('approval');
    }
    prevTierRef.current = tier;
  }, [tier]);

  const filledQuoteRows = quoteRows.filter(q => q.vendor.trim() && q.amount.trim());

  const updateQuoteRow = (index: number, patch: Partial<QuoteRow>) => {
    setQuoteRows(rows => rows.map((r, i) => i === index ? { ...r, ...patch } : r));
  };
  const addQuoteRow = () => setQuoteRows(rows => [...rows, emptyQuoteRow()]);
  const removeQuoteRow = (index: number) => setQuoteRows(rows => rows.length <= 1 ? rows : rows.filter((_, i) => i !== index));

  const toggleSharedManager = (id: string) => {
    setSharedManagerIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  const resetForm = () => {
    setItemName(''); setQuantity(''); setAmount(''); setRequestedDate(new Date().toISOString().slice(0, 10));
    setStoreName(''); setPurpose(''); setNotes(''); setLeaderId(''); setManagerId(''); setSharedManagerIds([]); setApprovalMode('approval'); setShowDetails(false);
    setQuoteRows([emptyQuoteRow(), emptyQuoteRow()]); setQuoteFilePath(null);
  };

  const handleSubmit = async () => {
    setFormError('');
    if (!itemName.trim()) { setFormError('品目名を入力してください。'); return; }
    if (!amount.trim() || isNaN(parsedAmount)) { setFormError('金額を正しく入力してください。'); return; }
    if (tier === 'over') { setFormError('現在3万円を超える申請フローは対応していません。連絡板で総務部にご相談ください。'); return; }
    if (!requestedDate) { setFormError('購入予定日を入力してください。'); return; }
    if (tier === 'leader' && !leaderId) { setFormError('承認を依頼するリーダーを選択してください。'); return; }
    if (tier === 'manager' && approvalMode === 'approval' && !managerId) { setFormError('承認を依頼するマネージャーを選択してください。'); return; }
    if (tier === 'manager' && approvalMode === 'self_judgment' && sharedManagerIds.length === 0) { setFormError('共有先のマネージャーを1名以上選択してください。'); return; }
    if (quotesRequired && filledQuoteRows.length < 2) { setFormError('1万円以上の申請は相見積もり（2社以上）の入力が必須です。'); return; }

    const quotesPayload = filledQuoteRows.length > 0
      ? filledQuoteRows.map(q => ({ vendor: q.vendor.trim(), amount: parseInt(parseAmount(q.amount), 10) }))
      : null;

    const isSelfJudgment = tier === 'manager' && approvalMode === 'self_judgment';
    const status = tier === 'leader' ? 'pending_leader' : isSelfJudgment ? 'self_judgment_shared' : 'pending_manager';
    const routeFields = {
      leader_id: tier === 'leader' ? leaderId : null,
      manager_id: tier === 'manager' && !isSelfJudgment ? managerId : null,
      shared_manager_ids: isSelfJudgment ? sharedManagerIds : null,
      is_self_judgment: isSelfJudgment,
    };

    setSubmitting(true);

    const commonFields = {
      item_name: itemName.trim(),
      quantity: quantity.trim() ? parseInt(quantity, 10) : null,
      amount: parsedAmount,
      requested_purchase_date: requestedDate,
      store_name: storeName.trim() || null,
      purpose: purpose.trim() || null,
      notes: notes.trim() || null,
      quotes: quotesPayload,
      quote_file_path: quoteFilePath,
      ...routeFields,
      status,
    };

    const vars = { '申請者名': user.user_metadata?.name ?? '', '品目名': itemName.trim(), '金額': parsedAmount.toLocaleString() };

    const notify = async (recordId: string) => {
      if (tier === 'leader') {
        await dispatchSiteNotification('purchase_request:submitted', vars, { leader: leaderId }, insertNotification, 'purchase_request:pending_approval', recordId);
      } else if (isSelfJudgment) {
        const tpl = await getNotificationTemplate('purchase_request:self_judgment_shared', 'site', vars);
        if (tpl) {
          await Promise.all(sharedManagerIds.map(id => insertNotification(id, tpl.template, tpl.subject || undefined, 'purchase_request', recordId)));
        }
      } else {
        await dispatchSiteNotification('purchase_request:submitted_manager', vars, { manager: managerId }, insertNotification, 'purchase_request:pending_approval', recordId);
      }
    };

    if (isResubmit && resubmitRecord) {
      const { error } = await supabase.from('purchase_requests').update({
        ...commonFields,
        returned_reason: null,
        leader_approved_at: null,
        manager_approved_at: null,
      }).eq('id', resubmitRecord.id);
      setSubmitting(false);

      if (error) { setFormError('再申請に失敗しました: ' + error.message); return; }

      await notify(resubmitRecord.id);
      setSuccessBanner(true);
      onDoneResubmit?.();
      return;
    }

    const { data, error } = await supabase.from('purchase_requests').insert({
      user_id: user.id,
      applicant_role_title: roleTitle,
      request_type: 'purchase_request',
      ...commonFields,
    }).select('id').single();
    setSubmitting(false);

    if (error || !data) {
      setFormError('申請に失敗しました: ' + (error?.message ?? '不明なエラー'));
      return;
    }

    await notify(data.id);
    setSuccessBanner(true);
    resetForm();
  };

  const labelStyle: React.CSSProperties = { fontSize: 13, fontWeight: 'bold', color: text, marginBottom: 6, display: 'block' };
  const inputStyle: React.CSSProperties = { width: '100%', boxSizing: 'border-box', padding: '10px 12px', borderRadius: 8, border: `1px solid ${border}`, background: inputBg, color: text, fontSize: 14 };

  return (
    <div>
      {successBanner && (
        <BannerSuccess
          message={isResubmit ? '再申請しました' : '申請しました'}
          sub="内容は履歴タブから確認できます"
          onClose={() => setSuccessBanner(false)}
        />
      )}

      {isResubmit && resubmitRecord?.returned_reason && (
        <div style={{ marginBottom: 14, padding: '10px 12px', background: isDarkMode ? '#3a2020' : '#fff5f5', border: `1px solid ${isDarkMode ? '#5c3030' : '#f5c2c7'}`, borderRadius: 8, fontSize: 13, color: isDarkMode ? '#f5b8bb' : '#842029' }}>
          差し戻し理由：{resubmitRecord.returned_reason}
        </div>
      )}

      <div style={{ marginBottom: 14, padding: '10px 12px', background: isDarkMode ? '#20304a' : '#eef6ff', border: `1px solid ${isDarkMode ? '#2e4a70' : '#cfe4ff'}`, borderRadius: 8, fontSize: 12, color: isDarkMode ? '#9cc6ff' : '#004085' }}>
        ℹ️ まだ購入していないものの購入前承認はこちら。すでに購入済みの実費精算は「💰精算」タブをご利用ください。
      </div>

      {tierBanner && (
        <div style={{ marginBottom: 14, padding: '10px 12px', background: warnBg, border: `1px solid ${warnBorder}`, borderRadius: 8, fontSize: 12, color: warnText, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span>ℹ️ {tierBanner}</span>
          <button type="button" onClick={() => setTierBanner(null)} style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: warnText, fontSize: 14 }}>✕</button>
        </div>
      )}

      <div style={{ background: cardBg, border: `1px solid ${border}`, borderRadius: 12, padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div>
          <label style={labelStyle}>品目名 <span style={{ color: '#dc3545' }}>*</span></label>
          <input type="text" value={itemName} onChange={e => setItemName(e.target.value)} placeholder="例：プロジェクター用ケーブル" style={inputStyle} />
        </div>

        <div>
          <label style={labelStyle}>金額（見積り） <span style={{ color: '#dc3545' }}>*</span></label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ color: text, fontSize: 14 }}>¥</span>
            <input
              type="text" inputMode="numeric" value={amount}
              onChange={e => setAmount(formatAmount(parseAmount(e.target.value)))}
              placeholder="0" style={inputStyle}
            />
          </div>
          {tier === 'over' && (
            <div style={{ marginTop: 8, padding: '10px 12px', background: isDarkMode ? '#3a2020' : '#fff5f5', border: `1px solid ${isDarkMode ? '#5c3030' : '#f5c2c7'}`, borderRadius: 8, fontSize: 12, color: isDarkMode ? '#f5b8bb' : '#842029' }}>
              現在3万円を超える申請フローは対応していません。連絡板で総務部にご相談ください。
              <button
                type="button" onClick={() => navigate('/board')}
                style={{ display: 'block', marginTop: 8, background: '#4a90d9', color: '#fff', border: 'none', borderRadius: 6, padding: '6px 12px', fontSize: 12, cursor: 'pointer' }}
              >
                連絡板で総務部に相談する
              </button>
            </div>
          )}
        </div>

        {tier !== 'over' && (
        <div>
          <label style={labelStyle}>
            相見積もり（価格の比較） {quotesRequired ? <span style={{ color: '#dc3545' }}>*</span> : <span style={{ color: subText, fontWeight: 'normal' }}>（任意）</span>}
          </label>
          <div style={{ fontSize: 12, color: subText, marginBottom: 8 }}>
            {quotesRequired
              ? '1万円以上の申請は、2社以上の価格を比較して入力してください。'
              : '少額でも、他の店舗・価格と比較した場合は記録しておくとコスト意識の共有に役立ちます。'}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {quoteRows.map((row, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                  type="text" value={row.vendor} onChange={e => updateQuoteRow(i, { vendor: e.target.value })}
                  placeholder={`業者名 ${i + 1}`} style={{ ...inputStyle, flex: 2 }}
                />
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1 }}>
                  <span style={{ color: text, fontSize: 14 }}>¥</span>
                  <input
                    type="text" inputMode="numeric" value={row.amount}
                    onChange={e => updateQuoteRow(i, { amount: formatAmount(parseAmount(e.target.value)) })}
                    placeholder="0" style={inputStyle}
                  />
                </div>
                {quoteRows.length > 1 && (
                  <button type="button" onClick={() => removeQuoteRow(i)} style={{ background: 'none', border: 'none', color: subText, fontSize: 16, cursor: 'pointer', padding: 4 }}>✕</button>
                )}
              </div>
            ))}
          </div>
          <button
            type="button" onClick={addQuoteRow}
            style={{ marginTop: 8, background: 'none', border: 'none', color: '#4a90d9', fontSize: 12, cursor: 'pointer', padding: 0 }}
          >
            + 業者を追加する
          </button>

          <div style={{ marginTop: 10 }}>
            <QuoteFileUploader isDarkMode={isDarkMode} userId={user.id} draftId={draftId} value={quoteFilePath} onChange={setQuoteFilePath} />
          </div>
        </div>
        )}

        {tier !== 'over' && (
        <div>
          <label style={labelStyle}>購入予定日 <span style={{ color: '#dc3545' }}>*</span></label>
          <input type="date" value={requestedDate} onChange={e => setRequestedDate(e.target.value)} style={inputStyle} />
        </div>
        )}

        {tier === 'leader' && (
          <div>
            <label style={labelStyle}>承認を依頼するリーダー <span style={{ color: '#dc3545' }}>*</span></label>
            <select value={leaderId} onChange={e => setLeaderId(e.target.value)} style={{ ...inputStyle, border: `2px solid ${leaderId ? '#28a745' : border}` }}>
              <option value="">選択してください</option>
              {leaders.map(l => (
                <option key={l.id} value={l.id}>{l.name}（{l.role_title}）</option>
              ))}
            </select>
          </div>
        )}

        {tier === 'manager' && (
          <div>
            <label style={labelStyle}>承認の進め方 <span style={{ color: '#dc3545' }}>*</span></label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderRadius: 8, border: `2px solid ${approvalMode === 'approval' ? '#28a745' : border}`, cursor: 'pointer' }}>
                <input type="radio" checked={approvalMode === 'approval'} onChange={() => setApprovalMode('approval')} />
                <span style={{ fontSize: 13, color: text }}>承認を依頼する</span>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderRadius: 8, border: `2px solid ${approvalMode === 'self_judgment' ? '#e0a800' : border}`, cursor: 'pointer' }}>
                <input type="radio" checked={approvalMode === 'self_judgment'} onChange={() => setApprovalMode('self_judgment')} />
                <span style={{ fontSize: 13, color: text }}>自己判断で購入し、共有のみ行う</span>
              </label>
            </div>

            {approvalMode === 'approval' ? (
              <div style={{ marginTop: 10 }}>
                <label style={labelStyle}>承認を依頼するマネージャー <span style={{ color: '#dc3545' }}>*</span></label>
                <select value={managerId} onChange={e => setManagerId(e.target.value)} style={{ ...inputStyle, border: `2px solid ${managerId ? '#28a745' : border}` }}>
                  <option value="">選択してください</option>
                  {managers.map(m => (
                    <option key={m.id} value={m.id}>{m.name}</option>
                  ))}
                </select>
              </div>
            ) : (
              <div style={{ marginTop: 10, padding: '10px 12px', background: warnBg, border: `1px solid ${warnBorder}`, borderRadius: 8 }}>
                <div style={{ fontSize: 12, color: warnText, marginBottom: 8 }}>
                  ⚠️ 承認は不要になり、選択したマネージャーへの通知のみになります。
                </div>
                <label style={{ fontSize: 13, fontWeight: 'bold', color: text, marginBottom: 6, display: 'block' }}>
                  共有先マネージャー <span style={{ color: '#dc3545' }}>*</span>
                  <span style={{ fontWeight: 'normal', color: subText }}>（{sharedManagerIds.length}名選択中）</span>
                </label>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {managers.map(m => (
                    <label key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: text, cursor: 'pointer' }}>
                      <input type="checkbox" checked={sharedManagerIds.includes(m.id)} onChange={() => toggleSharedManager(m.id)} />
                      {m.name}
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {tier !== 'over' && (
        <div>
          <button
            type="button"
            onClick={() => setShowDetails(s => !s)}
            style={{ background: 'none', border: 'none', color: '#4a90d9', fontSize: 13, cursor: 'pointer', padding: 0 }}
          >
            {showDetails ? '▲ 詳しい入力を閉じる' : '▼ 詳しく入力する（数量・購入先・用途など）'}
          </button>
        </div>
        )}

        {tier !== 'over' && showDetails && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, paddingTop: 4 }}>
            <div>
              <label style={labelStyle}>数量</label>
              <input type="number" min="0" value={quantity} onChange={e => setQuantity(e.target.value)} style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>購入予定先（店舗名）</label>
              <input type="text" value={storeName} onChange={e => setStoreName(e.target.value)} placeholder="例：〇〇ホームセンター" style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>用途・使用先</label>
              <input type="text" value={purpose} onChange={e => setPurpose(e.target.value)} placeholder="例：〇〇教室のプロジェクター用" style={inputStyle} />
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

        {tier !== 'over' && (
        <button
          type="button"
          onClick={handleSubmit}
          disabled={submitting}
          style={{ width: '100%', padding: '14px', borderRadius: 10, border: 'none', background: submitting ? subText : '#28a745', color: '#fff', fontSize: 15, fontWeight: 'bold', cursor: submitting ? 'default' : 'pointer' }}
        >
          {submitting ? '送信しています...' : isResubmit ? '修正して再申請する' : approvalMode === 'self_judgment' && tier === 'manager' ? '共有する' : '申請する'}
        </button>
        )}
      </div>
    </div>
  );
};

export default PurchaseRequestForm;

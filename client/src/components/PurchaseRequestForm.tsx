import React, { useState, useEffect, useRef } from 'react';
import type { AuthUser } from '../types';
import { formatAmount, parseAmount } from '../utils';
import { supabase } from '../lib/supabaseClient';
import { useDarkMode } from '../hooks/useDarkMode';
import { insertNotification } from '../lib/notifications';
import { dispatchSiteNotification, dispatchEmail, getNotificationTemplate, getUserEmail, shouldSend } from '../lib/notificationDispatch';
import { sendPurchaseSlackForEvent } from '../lib/purchaseSlack';
import QuoteFileUploader from './QuoteFileUploader';

const LEADER_LIMIT = 10000;
const MANAGER_LIMIT = 30000;
const QUOTES_REQUIRED_THRESHOLD = 10000;

type Tier = 'none' | 'leader' | 'manager' | 'board';
const tierOf = (amount: number): Tier => {
  if (isNaN(amount)) return 'none';
  if (amount <= LEADER_LIMIT) return 'leader';
  if (amount <= MANAGER_LIMIT) return 'manager';
  return 'board';
};
const TIER_LABEL: Record<Tier, string> = { none: '', leader: '1万円以下', manager: '1万円超〜3万円', board: '3万円超' };

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
  requested_manager_ids: string[] | null;
  shared_manager_ids: string[] | null;
  is_self_judgment: boolean;
  president_self_judgment: boolean;
  returned_reason: string | null;
  quotes: { vendor: string; amount: number }[] | null;
  quote_file_path: string | null;
  approval_round: number;
}

interface PurchaseRequestFormProps {
  user: AuthUser;
  roleTitle: string;
  isAdmin: boolean;
  resubmitRecord?: ResubmitRecord | null;
  onDoneResubmit?: () => void;
}

const PurchaseRequestForm: React.FC<PurchaseRequestFormProps> = ({ user, roleTitle, isAdmin, resubmitRecord, onDoneResubmit }) => {
  const isDarkMode = useDarkMode();
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
  const [requestedManagerIds, setRequestedManagerIds] = useState<string[]>(resubmitRecord?.requested_manager_ids ?? []);
  const [sharedManagerIds, setSharedManagerIds] = useState<string[]>(resubmitRecord?.shared_manager_ids ?? []);
  const [presidentSelfJudgment, setPresidentSelfJudgment] = useState<boolean>(resubmitRecord?.president_self_judgment ?? false);
  const [leaders, setLeaders] = useState<{ id: string; name: string; role_title: string }[]>([]);
  const [managers, setManagers] = useState<{ id: string; name: string }[]>([]);
  const [shareCandidates, setShareCandidates] = useState<{ id: string; name: string }[]>([]);
  const [boardApprovers, setBoardApprovers] = useState<{ id: string; name: string; role_title: string }[]>([]);
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
    // 自己判断（共有のみ）の共有先候補は、マネージャーだけでなく社長も含める
    supabase.from('profiles').select('id, name, role_title').eq('is_active', true)
      .in('role_title', ['マネージャー', '社長']).order('role_title').order('name').then(
        ({ data }) => setShareCandidates((data ?? []) as { id: string; name: string }[]),
        () => {}
      );
    // 3万円超・全員承認フローの対象者プレビュー（読み取り専用、選択不可）
    // 全マネージャー・社長のうち休職中(is_active=false)を除き、申請者自身も除外する
    supabase.from('profiles').select('id, name, role_title').eq('is_active', true)
      .in('role_title', ['マネージャー', '社長']).neq('id', user.id).order('role_title').order('name').then(
        ({ data }) => setBoardApprovers((data ?? []) as { id: string; name: string; role_title: string }[]),
        () => {}
      );
  }, [user.id]);

  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [successBanner, setSuccessBanner] = useState(false);
  const [tierBanner, setTierBanner] = useState<string | null>(null);

  const parsedAmount = amount.trim() ? parseInt(parseAmount(amount), 10) : NaN;
  const tier = tierOf(parsedAmount);
  const quotesRequired = !isNaN(parsedAmount) && parsedAmount >= QUOTES_REQUIRED_THRESHOLD;

  // 自己判断（承認不要・共有のみ）が使えるかは申請者自身の役職の決裁権限で自動的に決まる
  // （ユーザーが選ぶラジオボタンではない）。リーダー以上は1万円まで、マネージャー以上は3万円まで自己判断可
  const isLeaderPlus = isAdmin || ['リーダー', 'マネージャー', '社長'].includes(roleTitle);
  const isManagerPlus = isAdmin || ['マネージャー', '社長'].includes(roleTitle);
  const isPresident = !isAdmin && roleTitle === '社長';
  const canSelfJudge = tier === 'leader' ? isLeaderPlus : tier === 'manager' ? isManagerPlus : false;

  // 金額帯(tier)が変わったら承認ルート関連の入力だけをリセットし、変化に気づけるようバナーを出す
  // （品目名・数量・購入予定日・購入先・用途・備考・相見積もりは保持する）
  const prevTierRef = useRef<Tier | null>(null);
  useEffect(() => {
    if (prevTierRef.current !== null && prevTierRef.current !== tier && tier !== 'none') {
      setTierBanner(`${TIER_LABEL[tier]}の金額になったため、承認に関する入力項目が変わりました`);
      setLeaderId(''); setRequestedManagerIds([]); setSharedManagerIds([]); setPresidentSelfJudgment(false);
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
  const toggleRequestedManager = (id: string) => {
    setRequestedManagerIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  const resetForm = () => {
    setItemName(''); setQuantity(''); setAmount(''); setRequestedDate(new Date().toISOString().slice(0, 10));
    setStoreName(''); setPurpose(''); setNotes(''); setLeaderId(''); setRequestedManagerIds([]); setSharedManagerIds([]); setShowDetails(false);
    setPresidentSelfJudgment(false);
    setQuoteRows([emptyQuoteRow(), emptyQuoteRow()]); setQuoteFilePath(null);
  };

  const handleSubmit = async () => {
    setFormError('');
    if (!itemName.trim()) { setFormError('品目名を入力してください。'); return; }
    if (!amount.trim() || isNaN(parsedAmount)) { setFormError('金額を正しく入力してください。'); return; }
    if (!requestedDate) { setFormError('購入予定日を入力してください。'); return; }
    if (tier === 'leader' && !canSelfJudge && !leaderId) { setFormError('承認を依頼するリーダーを選択してください。'); return; }
    if (tier === 'manager' && !canSelfJudge && requestedManagerIds.length === 0) { setFormError('承認を依頼するマネージャーを1名以上選択してください。'); return; }
    if (canSelfJudge && sharedManagerIds.length === 0) { setFormError('共有先のマネージャーを1名以上選択してください。'); return; }
    if (tier === 'board' && !isPresident && boardApprovers.length === 0) { setFormError('承認対象者（マネージャー・社長）が現在0名のため、申請できません。管理者にご連絡ください。'); return; }
    if (quotesRequired && filledQuoteRows.length < 2) { setFormError('1万円以上の申請は相見積もり（2社以上）の入力が必須です。'); return; }

    const quotesPayload = filledQuoteRows.length > 0
      ? filledQuoteRows.map(q => ({ vendor: q.vendor.trim(), amount: parseInt(parseAmount(q.amount), 10) }))
      : null;

    const isSelfJudgment = tier === 'board' ? false : canSelfJudge;
    const presidentSelfJudge = tier === 'board' && isPresident && presidentSelfJudgment;
    const status = tier === 'board'
      ? (presidentSelfJudge ? 'self_judgment_shared' : 'pending_board')
      : isSelfJudgment ? 'self_judgment_shared' : tier === 'leader' ? 'pending_leader' : 'pending_manager';
    const routeFields = {
      leader_id: tier === 'leader' && !isSelfJudgment ? leaderId : null,
      requested_manager_ids: tier === 'manager' && !isSelfJudgment ? requestedManagerIds : null,
      shared_manager_ids: isSelfJudgment ? sharedManagerIds : null,
      is_self_judgment: isSelfJudgment,
      president_self_judgment: presidentSelfJudge,
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

    const applicantName = user.user_metadata?.name ?? '';

    // 複数宛先イベント向け: 対象者リストへメール送信する（サイト通知と同じ手動ループパターン）
    const notifyEmailToMany = async (eventKey: string, userIds: string[]) => {
      try {
        if (!(await shouldSend(eventKey, 'email'))) return;
        const tpl = await getNotificationTemplate(eventKey, 'email', vars);
        if (!tpl) return;
        await Promise.all(userIds.map(async id => {
          const to = await getUserEmail(id);
          if (!to) return;
          const { error } = await supabase.functions.invoke('send-email', { body: { to, subject: tpl.subject, text: tpl.template } });
          if (error) console.error('[notify email] 送信失敗', { id, error });
        }));
      } catch (e) {
        console.error('[notify email] 失敗', e);
      }
    };

    const notify = async (recordId: string) => {
      if (tier === 'board' && presidentSelfJudge) {
        // 社長の自己判断（共有のみ）は全マネージャーへ共有通知
        const tpl = await getNotificationTemplate('purchase_request:self_judgment_shared', 'site', vars);
        if (tpl) {
          await Promise.all(managers.map(m => insertNotification(m.id, tpl.template, tpl.subject || undefined, 'purchase_request', recordId)));
        }
        sendPurchaseSlackForEvent('purchase_request:self_judgment_shared', 'submitted', 'self_judgment', applicantName, itemName.trim(), parsedAmount).then(null, () => {});
        notifyEmailToMany('purchase_request:self_judgment_shared', managers.map(m => m.id)).then(null, () => {});
      } else if (tier === 'board') {
        const tpl = await getNotificationTemplate('purchase_request:submitted_board', 'site', vars);
        if (tpl) {
          await Promise.all(boardApprovers.map(a => insertNotification(a.id, tpl.template, tpl.subject || undefined, 'purchase_request:pending_approval', recordId)));
        }
        sendPurchaseSlackForEvent('purchase_request:submitted_board', 'submitted', 'board', applicantName, itemName.trim(), parsedAmount).then(null, () => {});
        notifyEmailToMany('purchase_request:submitted_board', boardApprovers.map(a => a.id)).then(null, () => {});
      } else if (isSelfJudgment) {
        const tpl = await getNotificationTemplate('purchase_request:self_judgment_shared', 'site', vars);
        if (tpl) {
          await Promise.all(sharedManagerIds.map(id => insertNotification(id, tpl.template, tpl.subject || undefined, 'purchase_request', recordId)));
        }
        sendPurchaseSlackForEvent('purchase_request:self_judgment_shared', 'submitted', 'self_judgment', applicantName, itemName.trim(), parsedAmount).then(null, () => {});
        notifyEmailToMany('purchase_request:self_judgment_shared', sharedManagerIds).then(null, () => {});
      } else if (tier === 'leader') {
        await dispatchSiteNotification('purchase_request:submitted', vars, { leader: leaderId }, insertNotification, 'purchase_request:pending_approval', recordId);
        sendPurchaseSlackForEvent('purchase_request:submitted', 'submitted', 'leader', applicantName, itemName.trim(), parsedAmount).then(null, () => {});
        (async () => {
          const leaderEmail = await getUserEmail(leaderId);
          if (leaderEmail) await dispatchEmail('purchase_request:submitted', vars, { leader: leaderEmail });
        })().then(null, () => {});
      } else {
        const tpl = await getNotificationTemplate('purchase_request:submitted_manager', 'site', vars);
        if (tpl) {
          await Promise.all(requestedManagerIds.map(id => insertNotification(id, tpl.template, tpl.subject || undefined, 'purchase_request:pending_approval', recordId)));
        }
        sendPurchaseSlackForEvent('purchase_request:submitted_manager', 'submitted', 'manager', applicantName, itemName.trim(), parsedAmount).then(null, () => {});
        notifyEmailToMany('purchase_request:submitted_manager', requestedManagerIds).then(null, () => {});
      }
    };

    if (isResubmit && resubmitRecord) {
      const { error } = await supabase.from('purchase_requests').update({
        ...commonFields,
        returned_reason: null,
        leader_approved_at: null,
        manager_approved_at: null,
        board_approved_at: null,
        approval_round: (resubmitRecord.approval_round ?? 1) + 1,
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
        <div style={{ marginBottom: 6 }}>ℹ️ まだ購入していないものの購入前承認はこちら。すでに購入済みの実費精算は「💰精算」タブをご利用ください。</div>
        <div style={{ fontWeight: 'bold', marginBottom: 2 }}>承認ルール（金額の目安）</div>
        <div>・1万円以下：リーダー以上は決裁権限内のため自己判断（共有のみ）／一般スタッフはリーダーかマネージャーの承認が必要</div>
        <div>・1万円超〜3万円：マネージャー以上は決裁権限内のため自己判断（共有のみ）／それ以外はマネージャーの承認が必要（相見積もりも必須）</div>
        <div>・3万円超：全マネージャー・社長の全員承認が必要（相見積もりも必須）。社長ご本人の申請のみ自己判断（共有のみ）を選択できます</div>
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
        </div>

        {tier === 'board' && !isPresident && (
          <div style={{ padding: '10px 12px', background: isDarkMode ? '#20304a' : '#eef6ff', border: `1px solid ${isDarkMode ? '#2e4a70' : '#cfe4ff'}`, borderRadius: 8 }}>
            <div style={{ fontSize: 12, fontWeight: 'bold', color: text, marginBottom: 6 }}>承認対象者（自動選出・全員承認）</div>
            <div style={{ fontSize: 12, color: subText, marginBottom: 8 }}>全マネージャー・社長に自動で審議を依頼します（休職中の方は自動的に除外されます）。</div>
            {boardApprovers.length === 0 ? (
              <div style={{ padding: '8px 10px', background: '#fff5f5', border: '1px solid #f5c2c7', borderRadius: 8, color: '#842029', fontSize: 12 }}>
                現在、承認対象者（マネージャー・社長）が0名のため申請できません。管理者にご連絡ください。
              </div>
            ) : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {boardApprovers.map(a => (
                  <span key={a.id} style={{ fontSize: 12, color: text, background: isDarkMode ? '#3a3a5c' : '#f8f9fa', border: `1px solid ${border}`, borderRadius: 6, padding: '2px 8px' }}>
                    {a.name}（{a.role_title}）
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        {tier === 'board' && isPresident && (
          <div style={{ padding: '10px 12px', background: warnBg, border: `1px solid ${warnBorder}`, borderRadius: 8 }}>
            <div style={{ fontSize: 12, color: warnText, marginBottom: 8 }}>
              ℹ️ ご自身（社長）の申請です。承認方法を選択してください。
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: text, cursor: 'pointer' }}>
                <input type="radio" checked={presidentSelfJudgment} onChange={() => setPresidentSelfJudgment(true)} />
                自己判断（共有のみ、全マネージャーに共有通知）
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: text, cursor: 'pointer' }}>
                <input type="radio" checked={!presidentSelfJudgment} onChange={() => setPresidentSelfJudgment(false)} />
                全マネージャーに審議を依頼する（全員承認）
              </label>
            </div>
          </div>
        )}

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

        <div>
          <label style={labelStyle}>購入予定日 <span style={{ color: '#dc3545' }}>*</span></label>
          <input type="date" value={requestedDate} onChange={e => setRequestedDate(e.target.value)} style={inputStyle} />
        </div>

        {tier !== 'board' && canSelfJudge && (
          <div style={{ padding: '10px 12px', background: warnBg, border: `1px solid ${warnBorder}`, borderRadius: 8 }}>
            <div style={{ fontSize: 12, color: warnText, marginBottom: 8 }}>
              ℹ️ あなたの役職（{roleTitle}）はこの金額の決裁権限内のため、承認は不要です。共有先を選んでください。
            </div>
            <label style={{ fontSize: 13, fontWeight: 'bold', color: text, marginBottom: 6, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span>
                共有先 <span style={{ color: '#dc3545' }}>*</span>
                <span style={{ fontWeight: 'normal', color: subText }}>（{sharedManagerIds.length}名選択中）</span>
              </span>
              <button
                type="button"
                onClick={() => setSharedManagerIds(
                  sharedManagerIds.length === shareCandidates.length ? [] : shareCandidates.map(m => m.id)
                )}
                style={{ background: 'none', border: 'none', color: '#1565c0', fontSize: 12, fontWeight: 'normal', cursor: 'pointer', padding: 0 }}
              >
                {sharedManagerIds.length === shareCandidates.length ? '全員解除' : '全員選択'}
              </button>
            </label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {shareCandidates.map(m => (
                <label key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: text, cursor: 'pointer' }}>
                  <input type="checkbox" checked={sharedManagerIds.includes(m.id)} onChange={() => toggleSharedManager(m.id)} />
                  {m.name}
                </label>
              ))}
            </div>
          </div>
        )}

        {tier === 'leader' && !canSelfJudge && (
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

        {tier === 'manager' && !canSelfJudge && (
          <div>
            <label style={labelStyle}>
              承認を依頼するマネージャー <span style={{ color: '#dc3545' }}>*</span>
              <span style={{ fontWeight: 'normal', color: subText }}>（{requestedManagerIds.length}名選択中）</span>
            </label>
            <div style={{ fontSize: 12, color: subText, marginBottom: 8 }}>
              複数選択できます。依頼した全員の回答（承認・否認・判断できない・その他）が揃うまで最終決定はできません。全員一致でなくても、意見が揃った後は依頼したどなたか1名が最終決定できます。
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {managers.map(m => (
                <label key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: text, cursor: 'pointer' }}>
                  <input type="checkbox" checked={requestedManagerIds.includes(m.id)} onChange={() => toggleRequestedManager(m.id)} />
                  {m.name}
                </label>
              ))}
            </div>
          </div>
        )}

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

        <button
          type="button"
          onClick={handleSubmit}
          disabled={submitting || (tier === 'board' && !isPresident && boardApprovers.length === 0)}
          style={{ width: '100%', padding: '14px', borderRadius: 10, border: 'none', background: submitting ? subText : '#28a745', color: '#fff', fontSize: 15, fontWeight: 'bold', cursor: submitting ? 'default' : 'pointer' }}
        >
          {submitting ? '送信しています...' : isResubmit ? '修正して再申請する' : (canSelfJudge || (tier === 'board' && isPresident && presidentSelfJudgment)) ? '共有する' : '申請する'}
        </button>
      </div>
    </div>
  );
};

export default PurchaseRequestForm;

import React, { useState, useEffect, useRef } from 'react';
import type { AuthUser, PurchaseRequestItem } from '../types';
import { formatAmount, parseAmount } from '../utils';
import { supabase } from '../lib/supabaseClient';
import { useDarkMode } from '../hooks/useDarkMode';
import { insertNotification } from '../lib/notifications';
import { todayJstStr } from '../lib/breakCalc';
import { dispatchSiteNotification, dispatchEmail, getNotificationTemplate, getUserEmail, shouldSend } from '../lib/notificationDispatch';
import { sendPurchaseSlackForEvent } from '../lib/purchaseSlack';
import { resolveItems } from '../lib/purchaseItemsFallback';
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

// 相見積もり1行分の下書き。isSelectedは商品内でラジオボタンにより排他選択される
// （「金額を直接入力する」を選ぶとuseManualAmount=trueになり、どのquoteのisSelectedもfalseになる）
interface QuoteDraft {
  vendor: string;
  unitAmount: string;
  note: string;
  quoteFilePath: string | null;
  isSelected: boolean;
}
const emptyQuoteDraft = (): QuoteDraft => ({ vendor: '', unitAmount: '', note: '', quoteFilePath: null, isSelected: false });

// 商品1件分の下書き
interface ItemDraft {
  id?: string;
  itemName: string;
  quantity: string;
  amount: string;
  amountManuallyOverridden: boolean;
  storeName: string;
  quotes: QuoteDraft[];
  useManualAmount: boolean;
  collapsed: boolean;
}
const emptyItemDraft = (): ItemDraft => ({
  itemName: '', quantity: '', amount: '', amountManuallyOverridden: false, storeName: '',
  quotes: [emptyQuoteDraft(), emptyQuoteDraft()], useManualAmount: true, collapsed: false,
});

const itemDraftFromRecord = (item: PurchaseRequestItem): ItemDraft => {
  const quotes = item.quotes.length > 0
    ? item.quotes.map(q => ({
        vendor: q.vendor, unitAmount: formatAmount(String(q.unit_amount)), note: q.note ?? '',
        quoteFilePath: q.quote_file_path, isSelected: q.is_selected,
      }))
    : [emptyQuoteDraft(), emptyQuoteDraft()];
  const hasSelected = quotes.some(q => q.isSelected);
  return {
    id: item.id,
    itemName: item.item_name,
    quantity: item.quantity != null ? String(item.quantity) : '',
    amount: formatAmount(String(item.amount)),
    amountManuallyOverridden: item.amount_manually_overridden,
    storeName: item.store_name ?? '',
    quotes,
    useManualAmount: !hasSelected,
    collapsed: false,
  };
};

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
  reason: string | null;
  notes: string | null;
  leader_id: string | null;
  requested_manager_ids: string[] | null;
  shared_manager_ids: string[] | null;
  is_self_judgment: boolean;
  president_self_judgment: boolean;
  returned_reason: string | null;
  quotes: { vendor: string; amount: number; note?: string }[] | null;
  quote_file_path: string | null;
  approval_round: number;
  items?: PurchaseRequestItem[];
}

interface PurchaseRequestFormProps {
  user: AuthUser;
  roleTitle: string;
  isAdmin: boolean;
  resubmitRecord?: ResubmitRecord | null;
  onDoneResubmit?: () => void;
}

// 申請フォームの入力内容を一時保存するlocalStorageキー
const DRAFT_STORAGE_KEY = 'fivem_purchase_request_draft';

const PurchaseRequestForm: React.FC<PurchaseRequestFormProps> = ({ user, roleTitle, isAdmin, resubmitRecord, onDoneResubmit }) => {
  const isDarkMode = useDarkMode();
  const cardBg = isDarkMode ? '#343a40' : '#ffffff';
  const border = isDarkMode ? '#495057' : '#e0e0e0';
  const text = isDarkMode ? '#eeeeee' : '#222222';
  const subText = isDarkMode ? '#aaaaaa' : '#666666';
  const inputBg = isDarkMode ? '#495057' : '#f8f9fa';
  const warnBg = isDarkMode ? '#3a3220' : '#fff8e1';
  const warnBorder = isDarkMode ? '#5c5430' : '#ffe082';
  const warnText = isDarkMode ? '#ffe082' : '#8a6d00';

  const isResubmit = !!resubmitRecord;
  const [draftId] = useState(() => resubmitRecord?.id ?? crypto.randomUUID());

  // スマホで参考リンクを探しに別アプリへ移動するとページが破棄され入力が消える問題への対策。
  // 入力内容をlocalStorageへ自動保存し、戻ってきたら復元する（再申請時は使わない）
  interface FormDraft {
    items: ItemDraft[];
    requestedDate: string; purpose: string; purposeDetail: string; reason: string;
    notes: string; location: string; leaderId: string;
    requestedManagerIds: string[]; sharedManagerIds: string[];
    presidentSelfJudgment: boolean; selfJudgeConfirmFirst: boolean;
    manualTotalOverride: string; totalManuallyOverridden: boolean; amountDiffReason: string;
  }
  const [savedDraft] = useState<Partial<FormDraft> | null>(() => {
    if (resubmitRecord) return null;
    try {
      const raw = localStorage.getItem(DRAFT_STORAGE_KEY);
      return raw ? (JSON.parse(raw) as Partial<FormDraft>) : null;
    } catch { return null; }
  });

  const initialItems = (): ItemDraft[] => {
    if (!resubmitRecord) {
      if (savedDraft?.items && savedDraft.items.length > 0) return savedDraft.items;
      return [emptyItemDraft()];
    }
    const items = resolveItems(
      {
        item_name: resubmitRecord.item_name,
        quantity: resubmitRecord.quantity,
        amount: resubmitRecord.amount,
        store_name: resubmitRecord.store_name,
        quotes: resubmitRecord.quotes,
      },
      resubmitRecord.items ?? []
    );
    return items.map(itemDraftFromRecord);
  };

  const [items, setItems] = useState<ItemDraft[]>(initialItems);
  const [requestedDate, setRequestedDate] = useState(resubmitRecord?.requested_purchase_date ?? savedDraft?.requestedDate ?? todayJstStr());
  const [purpose, setPurpose] = useState(resubmitRecord?.purpose ?? savedDraft?.purpose ?? '');
  // 用途を選択肢から選んだ場合でも、補足の詳細を書けるようにする任意欄
  const [purposeDetail, setPurposeDetail] = useState(savedDraft?.purposeDetail ?? '');
  const [reason, setReason] = useState(resubmitRecord?.reason ?? savedDraft?.reason ?? '');
  const [notes, setNotes] = useState(resubmitRecord?.notes ?? savedDraft?.notes ?? '');
  const [location, setLocation] = useState(savedDraft?.location ?? '');
  const [workplaceOptions, setWorkplaceOptions] = useState<string[]>([]);
  const [purposeOptions, setPurposeOptions] = useState<string[]>([]);
  const [leaderId, setLeaderId] = useState(resubmitRecord?.leader_id ?? savedDraft?.leaderId ?? '');
  const [requestedManagerIds, setRequestedManagerIds] = useState<string[]>(resubmitRecord?.requested_manager_ids ?? savedDraft?.requestedManagerIds ?? []);
  const [sharedManagerIds, setSharedManagerIds] = useState<string[]>(resubmitRecord?.shared_manager_ids ?? savedDraft?.sharedManagerIds ?? []);
  const [presidentSelfJudgment, setPresidentSelfJudgment] = useState<boolean>(resubmitRecord?.president_self_judgment ?? savedDraft?.presidentSelfJudgment ?? false);
  // 決裁権限内（自己判断可能）でも、購入前に確認してもらいたい場合に選べる（デフォルトは従来通り共有のみ）
  // 再申請時は前回選んだ進め方（is_self_judgmentがfalseなら「事前確認」を選んでいた）を引き継ぐ
  const [selfJudgeConfirmFirst, setSelfJudgeConfirmFirst] = useState<boolean>(
    resubmitRecord ? !resubmitRecord.is_self_judgment : (savedDraft?.selfJudgeConfirmFirst ?? false)
  );
  const [leaders, setLeaders] = useState<{ id: string; name: string; role_title: string }[]>([]);
  const [managers, setManagers] = useState<{ id: string; name: string }[]>([]);
  const [shareCandidates, setShareCandidates] = useState<{ id: string; name: string; role_title: string }[]>([]);
  const [boardApprovers, setBoardApprovers] = useState<{ id: string; name: string; role_title: string }[]>([]);

  const [manualTotalOverride, setManualTotalOverride] = useState(savedDraft?.manualTotalOverride ?? '');
  const [totalManuallyOverridden, setTotalManuallyOverridden] = useState(savedDraft?.totalManuallyOverridden ?? false);
  const [amountDiffReason, setAmountDiffReason] = useState(savedDraft?.amountDiffReason ?? '');

  // 入力内容をlocalStorageへ自動保存（再申請時は保存しない）
  useEffect(() => {
    if (isResubmit) return;
    try {
      localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify({
        items, requestedDate, purpose, purposeDetail, reason, notes, location,
        leaderId, requestedManagerIds, sharedManagerIds, presidentSelfJudgment,
        selfJudgeConfirmFirst, manualTotalOverride, totalManuallyOverridden, amountDiffReason,
      }));
    } catch { /* 保存容量超過などは無視 */ }
  }, [isResubmit, items, requestedDate, purpose, purposeDetail, reason, notes, location, leaderId, requestedManagerIds, sharedManagerIds, presidentSelfJudgment, selfJudgeConfirmFirst, manualTotalOverride, totalManuallyOverridden, amountDiffReason]);

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
        ({ data }) => setShareCandidates((data ?? []) as { id: string; name: string; role_title: string }[]),
        () => {}
      );
    // 3万円超・全員承認フローの対象者プレビュー（読み取り専用、選択不可）
    // 全マネージャー・社長のうち休職中(is_active=false)を除き、申請者自身も除外する
    supabase.from('profiles').select('id, name, role_title').eq('is_active', true)
      .in('role_title', ['マネージャー', '社長']).neq('id', user.id).order('role_title').order('name').then(
        ({ data }) => setBoardApprovers((data ?? []) as { id: string; name: string; role_title: string }[]),
        () => {}
      );
    // 使用先はファイブMの校舎（workplaceカテゴリ。ExpenseForm.tsxの社内スタッフ向け行き先と同じマスタ）を使う
    // （trip_location_*は交通費の訪問先=お客様先のマスタなので、備品購入の使用先には使わない）
    supabase.from('master_options').select('category, value, sort_order').order('sort_order').then(
      ({ data }) => {
        if (!data) return;
        setWorkplaceOptions(data.filter(r => r.category === 'workplace').map(r => r.value));
        setPurposeOptions(data.filter(r => r.category === 'purchase_purpose').map(r => r.value));
      },
      () => {}
    );
  }, [user.id]);

  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [successBanner, setSuccessBanner] = useState(false);
  const [tierBanner, setTierBanner] = useState<string | null>(null);

  // 商品ごとの確定金額(readonly風の自動計算 or 手動)の数値化と、合計計算
  const itemAmountNum = (item: ItemDraft): number => {
    const n = item.amount.trim() ? parseInt(parseAmount(item.amount), 10) : NaN;
    return isNaN(n) ? 0 : n;
  };
  const itemsSubtotal = items.reduce((sum, it) => sum + itemAmountNum(it), 0);

  // 1件なら商品自体の金額、2件以上なら合計金額欄（手動編集可）の値が最終的な申請金額
  const amount = items.length === 1 ? items[0].amount : manualTotalOverride;
  const parsedAmount = amount.trim() ? parseInt(parseAmount(amount), 10) : NaN;
  const tier = tierOf(parsedAmount);
  const quotesRequired = !isNaN(parsedAmount) && parsedAmount >= QUOTES_REQUIRED_THRESHOLD;

  // 合計金額欄を手動編集した結果、商品合計とtierが変わった場合の警告
  const subtotalTier = tierOf(itemsSubtotal);
  const manualTotalNum = manualTotalOverride.trim() ? parseInt(parseAmount(manualTotalOverride), 10) : NaN;
  const manualTotalTier = tierOf(manualTotalNum);
  const showAmountDiffWarning = items.length >= 2 && !isNaN(manualTotalNum) && manualTotalTier !== subtotalTier;

  // 商品が2件以上になった直後、1件に戻ったタイミングでtotalManuallyOverriddenをリセットする
  // （合計欄自体が非表示になるため、次回2件以上になった時にまた自動追従から始まるように）
  const prevItemsCountRef = useRef(items.length);
  useEffect(() => {
    if (prevItemsCountRef.current >= 2 && items.length === 1) {
      setTotalManuallyOverridden(false);
    }
    prevItemsCountRef.current = items.length;
  }, [items.length]);

  // 合計金額欄をユーザーがまだ手動編集していない間は、各商品の金額合計に自動追従し続ける
  // （商品ごとの金額欄と同じ「自動追従→手動編集したら追従停止」パターン）
  useEffect(() => {
    if (items.length >= 2 && !totalManuallyOverridden) {
      setManualTotalOverride(formatAmount(String(itemsSubtotal)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemsSubtotal, items.length, totalManuallyOverridden]);

  // 自己判断（承認不要・共有のみ）が使えるかは申請者自身の役職の決裁権限で自動的に決まる
  // （ユーザーが選ぶラジオボタンではない）。リーダー以上は1万円まで、マネージャー以上は3万円まで自己判断可
  const isLeaderPlus = isAdmin || ['リーダー', 'マネージャー', '社長'].includes(roleTitle);
  const isManagerPlus = isAdmin || ['マネージャー', '社長'].includes(roleTitle);
  const isPresident = !isAdmin && roleTitle === '社長';
  const canSelfJudge = tier === 'leader' ? isLeaderPlus : tier === 'manager' ? isManagerPlus : false;
  // 決裁権限内でも「事前に確認してもらう」を選んだ場合は自己判断扱いにしない
  const isSelfJudgment = tier === 'board' ? false : (canSelfJudge && !selfJudgeConfirmFirst);

  // 金額帯(tier)が変わったら承認ルート関連の入力だけをリセットし、変化に気づけるようバナーを出す
  // （品目名・数量・購入予定日・購入先・用途・備考・相見積もりは保持する）
  const prevTierRef = useRef<Tier | null>(null);
  useEffect(() => {
    if (prevTierRef.current !== null && prevTierRef.current !== tier && tier !== 'none') {
      setTierBanner(`${TIER_LABEL[tier]}の金額になったため、承認に関する入力項目が変わりました`);
      setLeaderId(''); setRequestedManagerIds([]); setSharedManagerIds([]); setPresidentSelfJudgment(false); setSelfJudgeConfirmFirst(false);
    }
    prevTierRef.current = tier;
  }, [tier]);

  const toggleSharedManager = (id: string) => {
    setSharedManagerIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };
  const toggleRequestedManager = (id: string) => {
    setRequestedManagerIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  // ----- 商品カード操作 -----
  const updateItem = (index: number, patch: Partial<ItemDraft>) => {
    setItems(prev => prev.map((it, i) => i === index ? { ...it, ...patch } : it));
  };
  const addItem = () => {
    setItems(prev => [...prev.map(it => ({ ...it, collapsed: true })), emptyItemDraft()]);
  };
  // 商品追加後、新しく増えたカードの入力開始位置までスクロールする（今どこにいるか分からなくなる問題への対応）
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const prevItemsLenForScrollRef = useRef(items.length);
  useEffect(() => {
    if (items.length > prevItemsLenForScrollRef.current) {
      const el = itemRefs.current[items.length - 1];
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    prevItemsLenForScrollRef.current = items.length;
  }, [items.length]);
  const removeItem = (index: number) => {
    setItems(prev => prev.length <= 1 ? prev : prev.filter((_, i) => i !== index));
  };
  const toggleItemCollapsed = (index: number) => {
    setItems(prev => prev.map((it, i) => i === index ? { ...it, collapsed: !it.collapsed } : it));
  };

  // 商品ごとの単価×数量の自動計算。amountManuallyOverriddenがtrueなら自動計算は行わない
  const recalcItemAmount = (item: ItemDraft): ItemDraft => {
    if (item.useManualAmount || item.amountManuallyOverridden) return item;
    const selected = item.quotes.find(q => q.isSelected);
    if (!selected) return item;
    const unit = selected.unitAmount.trim() ? parseInt(parseAmount(selected.unitAmount), 10) : NaN;
    if (isNaN(unit)) return item;
    const qty = item.quantity.trim() ? parseInt(item.quantity, 10) : 1;
    const total = unit * Math.max(isNaN(qty) ? 1 : qty, 1);
    return { ...item, amount: formatAmount(String(total)) };
  };

  const updateQuote = (itemIndex: number, quoteIndex: number, patch: Partial<QuoteDraft>) => {
    setItems(prev => prev.map((it, i) => {
      if (i !== itemIndex) return it;
      const quotes = it.quotes.map((q, qi) => qi === quoteIndex ? { ...q, ...patch } : q);
      const next = recalcItemAmount({ ...it, quotes });
      return next;
    }));
  };
  const addQuote = (itemIndex: number) => {
    setItems(prev => prev.map((it, i) => i === itemIndex ? { ...it, quotes: [...it.quotes, emptyQuoteDraft()] } : it));
  };
  const removeQuote = (itemIndex: number, quoteIndex: number) => {
    setItems(prev => prev.map((it, i) => {
      if (i !== itemIndex) return it;
      if (it.quotes.length <= 1) return it;
      const quotes = it.quotes.filter((_, qi) => qi !== quoteIndex);
      return recalcItemAmount({ ...it, quotes });
    }));
  };

  // ラジオボタンで「この業者から購入予定」を選択。同じ商品内の他のquoteは自動的に非選択になる
  const selectQuote = (itemIndex: number, quoteIndex: number) => {
    setItems(prev => prev.map((it, i) => {
      if (i !== itemIndex) return it;
      const quotes = it.quotes.map((q, qi) => ({ ...q, isSelected: qi === quoteIndex }));
      // 業者選択が変わったのでamountManuallyOverriddenをリセットし、自動計算に戻す
      const next = recalcItemAmount({ ...it, quotes, useManualAmount: false, amountManuallyOverridden: false });
      return next;
    }));
  };
  // 「金額を直接入力する（相見積もりを使わない）」を選択
  const selectManualAmount = (itemIndex: number) => {
    setItems(prev => prev.map((it, i) => {
      if (i !== itemIndex) return it;
      const quotes = it.quotes.map(q => ({ ...q, isSelected: false }));
      return { ...it, quotes, useManualAmount: true };
    }));
  };
  // 自動計算値を手動で上書きするモードに切り替え
  const overrideItemAmount = (itemIndex: number) => {
    updateItem(itemIndex, { amountManuallyOverridden: true });
  };

  // 商品1の業者情報（業者名のみ）をコピーして対象商品に複製する。単価は商品ごとに異なりうるためコピーしない。
  // isSelectedもリセットし、ファイル添付も複製しない
  const copyVendorInfoFromFirstItem = (itemIndex: number) => {
    setItems(prev => {
      const source = prev[0];
      if (!source) return prev;
      const copiedQuotes = source.quotes.map(q => ({
        vendor: q.vendor, unitAmount: '', note: '',
        quoteFilePath: null, isSelected: false,
      }));
      return prev.map((it, i) => i === itemIndex ? { ...it, quotes: copiedQuotes } : it);
    });
  };

  const resetForm = () => {
    setItems([emptyItemDraft()]);
    setRequestedDate(todayJstStr());
    setPurpose(''); setPurposeDetail(''); setReason(''); setNotes(''); setLocation('');
    setLeaderId(''); setRequestedManagerIds([]); setSharedManagerIds([]);
    setPresidentSelfJudgment(false); setSelfJudgeConfirmFirst(false);
    setManualTotalOverride(''); setTotalManuallyOverridden(false); setAmountDiffReason('');
    try { localStorage.removeItem(DRAFT_STORAGE_KEY); } catch { /* ignore */ }
  };

  const handleSubmit = async () => {
    setFormError('');
    for (const item of items) {
      if (!item.itemName.trim()) { setFormError('すべての商品の品目名を入力してください。'); return; }
      const itemQty = item.quantity.trim() ? parseInt(item.quantity, 10) : NaN;
      if (!item.quantity.trim() || isNaN(itemQty) || itemQty < 1) { setFormError('すべての商品の数量を1以上で入力してください。'); return; }
      const itemAmt = item.amount.trim() ? parseInt(parseAmount(item.amount), 10) : NaN;
      if (!item.amount.trim() || isNaN(itemAmt)) { setFormError('すべての商品の金額を正しく入力してください。'); return; }
    }
    if (!amount.trim() || isNaN(parsedAmount)) { setFormError('金額を正しく入力してください。'); return; }
    if (!requestedDate) { setFormError('購入予定日を入力してください。'); return; }
    if (!location.trim()) { setFormError('使用先を入力してください。'); return; }
    if (!purpose.trim()) { setFormError('用途を選択または入力してください。'); return; }
    if (!reason.trim()) { setFormError('申請理由を入力してください。'); return; }
    if (tier === 'leader' && !isSelfJudgment && !leaderId) { setFormError('確認を依頼するリーダー・マネージャーを選択してください。'); return; }
    if (tier === 'manager' && !isSelfJudgment && requestedManagerIds.length === 0) { setFormError('承認を依頼するマネージャーを1名以上選択してください。'); return; }
    if (isSelfJudgment && sharedManagerIds.length === 0) { setFormError('共有先のマネージャーを1名以上選択してください。'); return; }
    if (tier === 'board' && !isPresident && boardApprovers.length === 0) { setFormError('承認対象者（マネージャー・社長）が現在0名のため、申請できません。管理者にご連絡ください。'); return; }
    if (quotesRequired) {
      for (const item of items) {
        const filled = item.quotes.filter(q => q.vendor.trim() && q.unitAmount.trim());
        if (filled.length < 2) { setFormError('1万円以上の申請は、各商品につき価格比較（2社以上）の入力が必須です。'); return; }
      }
    }
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

    const firstItemName = items[0].itemName.trim();
    const itemNameVar = items.length > 1 ? `${firstItemName}（他${items.length - 1}件）` : firstItemName;
    const vars = { '申請者名': user.user_metadata?.name ?? '', '品目名': itemNameVar, '金額': parsedAmount.toLocaleString() };

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
          await Promise.all(managers.map(m => insertNotification(m.id, tpl.template, tpl.subject || undefined, 'purchase_request', recordId, 'purchase_request:self_judgment_shared')));
        }
        sendPurchaseSlackForEvent('purchase_request:self_judgment_shared', 'submitted', 'self_judgment', applicantName, itemNameVar, parsedAmount).then(null, () => {});
        notifyEmailToMany('purchase_request:self_judgment_shared', managers.map(m => m.id)).then(null, () => {});
      } else if (tier === 'board') {
        const tpl = await getNotificationTemplate('purchase_request:submitted_board', 'site', vars);
        if (tpl) {
          await Promise.all(boardApprovers.map(a => insertNotification(a.id, tpl.template, tpl.subject || undefined, 'purchase_request:pending_approval', recordId, 'purchase_request:submitted_board')));
        }
        sendPurchaseSlackForEvent('purchase_request:submitted_board', 'submitted', 'board', applicantName, itemNameVar, parsedAmount).then(null, () => {});
        notifyEmailToMany('purchase_request:submitted_board', boardApprovers.map(a => a.id)).then(null, () => {});
      } else if (isSelfJudgment) {
        const tpl = await getNotificationTemplate('purchase_request:self_judgment_shared', 'site', vars);
        if (tpl) {
          await Promise.all(sharedManagerIds.map(id => insertNotification(id, tpl.template, tpl.subject || undefined, 'purchase_request', recordId, 'purchase_request:self_judgment_shared')));
        }
        sendPurchaseSlackForEvent('purchase_request:self_judgment_shared', 'submitted', 'self_judgment', applicantName, itemNameVar, parsedAmount).then(null, () => {});
        notifyEmailToMany('purchase_request:self_judgment_shared', sharedManagerIds).then(null, () => {});
      } else if (tier === 'leader') {
        await dispatchSiteNotification('purchase_request:submitted', vars, { leader: leaderId }, insertNotification, 'purchase_request:pending_approval', recordId);
        sendPurchaseSlackForEvent('purchase_request:submitted', 'submitted', 'leader', applicantName, itemNameVar, parsedAmount).then(null, () => {});
        (async () => {
          const leaderEmail = await getUserEmail(leaderId);
          if (leaderEmail) await dispatchEmail('purchase_request:submitted', vars, { leader: leaderEmail });
        })().then(null, () => {});
      } else {
        const tpl = await getNotificationTemplate('purchase_request:submitted_manager', 'site', vars);
        if (tpl) {
          await Promise.all(requestedManagerIds.map(id => insertNotification(id, tpl.template, tpl.subject || undefined, 'purchase_request:pending_approval', recordId, 'purchase_request:submitted_manager')));
        }
        sendPurchaseSlackForEvent('purchase_request:submitted_manager', 'submitted', 'manager', applicantName, itemNameVar, parsedAmount).then(null, () => {});
        notifyEmailToMany('purchase_request:submitted_manager', requestedManagerIds).then(null, () => {});
      }
    };

    // 相見積もりで業者を選択している場合は、その業者名を購入予定先として使う
    const effectiveStoreName = (item: ItemDraft): string | null => {
      if (item.useManualAmount) return item.storeName.trim() || null;
      const selected = item.quotes.find(q => q.isSelected);
      return selected?.vendor.trim() || null;
    };

    // 用途を選択肢から選んだ場合は、補足の詳細（任意）があれば「区分（詳細）」の形にまとめて保存する
    const finalPurpose = purposeOptions.includes(purpose) && purposeDetail.trim()
      ? `${purpose}（${purposeDetail.trim()}）`
      : purpose;

    const p_header = {
      amount: parsedAmount,
      requested_purchase_date: requestedDate,
      store_name: effectiveStoreName(items[0]),
      purpose: finalPurpose.trim() || null,
      reason: reason.trim() || null,
      location: location.trim() || null,
      notes: notes.trim() || null,
      amount_diff_reason: amountDiffReason.trim() || null,
      applicant_role_title: roleTitle,
      leader_id: routeFields.leader_id,
      requested_manager_ids: routeFields.requested_manager_ids,
      shared_manager_ids: routeFields.shared_manager_ids,
      is_self_judgment: routeFields.is_self_judgment,
      president_self_judgment: routeFields.president_self_judgment,
      status,
    };

    const p_items = items.map((item, i) => ({
      sort_order: i,
      item_name: item.itemName.trim(),
      quantity: item.quantity.trim() ? parseInt(item.quantity, 10) : null,
      amount: parseInt(parseAmount(item.amount), 10),
      amount_manually_overridden: item.amountManuallyOverridden,
      store_name: effectiveStoreName(item),
      quotes: item.useManualAmount ? [] : item.quotes
        .filter(q => q.vendor.trim() && q.unitAmount.trim())
        .map((q, qi) => ({
          vendor: q.vendor.trim(),
          unit_amount: parseInt(parseAmount(q.unitAmount), 10),
          note: q.note.trim() || null,
          quote_file_path: q.quoteFilePath,
          is_selected: q.isSelected,
          sort_order: qi,
        })),
    }));

    const { data, error } = await supabase.rpc('submit_purchase_request', {
      p_request_id: draftId,
      p_is_resubmit: isResubmit,
      p_header,
      p_items,
    });
    setSubmitting(false);

    if (error || !data) {
      setFormError((isResubmit ? '再申請' : '申請') + 'に失敗しました: ' + (error?.message ?? '不明なエラー'));
      return;
    }

    await notify(data as string);
    setSuccessBanner(true);
    if (isResubmit) {
      onDoneResubmit?.();
    } else {
      resetForm();
    }
  };

  const labelStyle: React.CSSProperties = { fontSize: 13, fontWeight: 'bold', color: text, marginBottom: 6, display: 'block' };
  const inputStyle: React.CSSProperties = { width: '100%', boxSizing: 'border-box', padding: '10px 12px', borderRadius: 8, border: `1px solid ${border}`, background: inputBg, color: text, fontSize: 14 };
  const locationOptions = workplaceOptions;

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

      <div style={{ marginBottom: 14, padding: '10px 12px', background: isDarkMode ? '#20304a' : '#eef6ff', border: `1px solid ${isDarkMode ? '#2e4a70' : '#cfe4ff'}`, borderRadius: 8, fontSize: 12, color: isDarkMode ? '#fff' : '#004085' }}>
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
        {!isResubmit && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: -6 }}>
            <button type="button" onClick={resetForm}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: subText, background: 'none', border: `1px solid ${border}`, borderRadius: 14, padding: '4px 12px', cursor: 'pointer' }}>
              🗑 クリア
            </button>
          </div>
        )}
        <div>
          <label style={labelStyle}>使用先 <span style={{ color: '#dc3545' }}>*</span></label>
          {locationOptions.length > 0 ? (
            <>
              <select
                value={locationOptions.includes(location) ? location : (location ? 'その他' : '')}
                onChange={e => setLocation(e.target.value === 'その他' ? '' : e.target.value)}
                style={inputStyle}
              >
                <option value="">選択してください</option>
                {locationOptions.map(loc => <option key={loc} value={loc}>{loc}</option>)}
                <option value="その他">その他</option>
              </select>
              {(!locationOptions.includes(location)) && (
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
          <label style={labelStyle}>用途 <span style={{ color: '#dc3545' }}>*</span></label>
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
              {(!purposeOptions.includes(purpose)) ? (
                <input
                  type="text" value={purpose} onChange={e => setPurpose(e.target.value)}
                  placeholder="上記のどれにも当てはまらない場合は入力してください" style={{ ...inputStyle, marginTop: 6 }}
                />
              ) : (
                <input
                  type="text" value={purposeDetail} onChange={e => setPurposeDetail(e.target.value)}
                  placeholder="詳細（任意）" style={{ ...inputStyle, marginTop: 6 }}
                />
              )}
            </>
          ) : (
            <input type="text" value={purpose} onChange={e => setPurpose(e.target.value)} placeholder="上記のどれにも当てはまらない場合は入力してください" style={inputStyle} />
          )}
        </div>

        <div>
          <label style={labelStyle}>申請理由 <span style={{ color: '#dc3545' }}>*</span></label>
          <div style={{ fontSize: 12, color: subText, marginBottom: 6 }}>
            組織として必要なコストか承認者が判断できるよう記入してください。
          </div>
          <textarea
            value={reason} onChange={e => setReason(e.target.value)} rows={2}
            placeholder="例：現在のマットが老朽化し安全に使用できなくなったため、同等品に交換する必要がある"
            style={{ ...inputStyle, resize: 'vertical' as const }}
          />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {items.map((item, itemIndex) => {
            const showHeader = items.length >= 2;
            const itemQuotesRequired = quotesRequired;

            return (
              <div key={itemIndex} ref={el => { itemRefs.current[itemIndex] = el; }} style={{ border: `1px solid ${border}`, borderRadius: 10, overflow: 'hidden', scrollMarginTop: 70 }}>
                {showHeader && (
                  <div
                    onClick={() => toggleItemCollapsed(itemIndex)}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', background: inputBg, cursor: 'pointer', fontSize: 13, color: text, fontWeight: 'bold' }}
                  >
                    <span>商品{itemIndex + 1}　{item.itemName || '(未入力)'}</span>
                    <span style={{ marginLeft: 'auto' }}>¥{item.amount || '0'}</span>
                    <span style={{ color: subText, fontSize: 11 }}>{item.collapsed ? '▼' : '▲'}</span>
                  </div>
                )}

                {(!showHeader || !item.collapsed) && (
                  <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 14 }}>
                    <div>
                      <label style={labelStyle}>品目名 <span style={{ color: '#dc3545' }}>*</span></label>
                      <input
                        type="text" value={item.itemName} onChange={e => updateItem(itemIndex, { itemName: e.target.value })}
                        placeholder="具体的な品名を入力してください" style={inputStyle}
                      />
                    </div>

                    <div>
                      <label style={labelStyle}>数量 <span style={{ color: '#dc3545' }}>*</span></label>
                      <input
                        type="number" min="1" value={item.quantity}
                        onChange={e => updateItem(itemIndex, recalcItemAmount({ ...item, quantity: e.target.value }))}
                        style={inputStyle}
                      />
                    </div>

                    <div>
                      <label style={labelStyle}>
                        価格比較 {itemQuotesRequired ? <span style={{ color: '#dc3545' }}>*（必須）</span> : <span style={{ color: subText, fontWeight: 'normal' }}>（任意）</span>}
                      </label>
                      <div style={{ fontSize: 12, color: subText, marginBottom: 4 }}>
                        {itemQuotesRequired
                          ? '1万円以上の申請は、2社以上の価格比較の入力が必須です。'
                          : '少額でも、複数の業者・店舗で価格比較しておくとコスト意識の共有に役立ちます。任意ですが、できるだけ入力にご協力ください。'}
                      </div>
                      <div style={{ fontSize: 12, color: subText, marginBottom: 8 }}>
                        ◯を付けた業者から購入する前提で、金額欄に自動反映されます。
                      </div>
                      {itemIndex > 0 && (
                        <button
                          type="button" onClick={() => copyVendorInfoFromFirstItem(itemIndex)}
                          style={{ marginBottom: 8, background: 'none', border: `1px solid ${border}`, color: '#4a90d9', fontSize: 12, cursor: 'pointer', padding: '6px 10px', borderRadius: 6 }}
                        >
                          商品1の業者情報をコピー
                        </button>
                      )}
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px', border: `1px solid ${item.useManualAmount ? '#28a745' : border}`, borderRadius: 8, cursor: 'pointer', fontSize: 13, color: text }}>
                          <input
                            type="radio" name={`quote-${itemIndex}`} checked={item.useManualAmount}
                            onChange={() => selectManualAmount(itemIndex)}
                          />
                          金額を直接入力する（相見積もりを使わない）
                        </label>

                        {item.useManualAmount && (
                          <div style={{ padding: '0 8px' }}>
                            <label style={labelStyle}>購入予定先（店舗名）</label>
                            <input
                              type="text" value={item.storeName} onChange={e => updateItem(itemIndex, { storeName: e.target.value })}
                              placeholder="例：〇〇ホームセンター" style={inputStyle}
                            />
                          </div>
                        )}

                        {item.quotes.map((q, qi) => (
                          <div key={qi} style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '8px', border: `1px solid ${q.isSelected ? '#28a745' : border}`, borderRadius: 8 }}>
                            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                              <input
                                type="radio" name={`quote-${itemIndex}`} checked={q.isSelected}
                                onChange={() => selectQuote(itemIndex, qi)}
                              />
                              <input
                                type="text" value={q.vendor} onChange={e => updateQuote(itemIndex, qi, { vendor: e.target.value })}
                                placeholder={`業者名 ${qi + 1}`} style={{ ...inputStyle, flex: 2 }}
                              />
                              <div style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1 }}>
                                <span style={{ color: text, fontSize: 14 }}>¥</span>
                                <input
                                  type="text" inputMode="numeric" value={q.unitAmount}
                                  onChange={e => updateQuote(itemIndex, qi, { unitAmount: formatAmount(parseAmount(e.target.value)) })}
                                  placeholder="単価（税込み）" style={inputStyle}
                                />
                              </div>
                              {item.quotes.length > 1 && (
                                <button type="button" onClick={() => removeQuote(itemIndex, qi)} style={{ background: 'none', border: 'none', color: subText, fontSize: 16, cursor: 'pointer', padding: 4 }}>✕</button>
                              )}
                            </div>
                            <input
                              type="text" value={q.note} onChange={e => updateQuote(itemIndex, qi, { note: e.target.value })}
                              placeholder="コメント・リンク（任意）" style={{ ...inputStyle, fontSize: 13 }}
                            />
                            <QuoteFileUploader
                              isDarkMode={isDarkMode} userId={user.id} draftId={`${draftId}-${itemIndex}-${qi}`}
                              value={q.quoteFilePath} onChange={path => updateQuote(itemIndex, qi, { quoteFilePath: path })}
                            />
                          </div>
                        ))}
                      </div>
                      <button
                        type="button" onClick={() => addQuote(itemIndex)}
                        style={{ marginTop: 8, background: 'none', border: 'none', color: '#4a90d9', fontSize: 12, cursor: 'pointer', padding: 0 }}
                      >
                        + 見積もり業者を追加
                      </button>
                    </div>

                    <div>
                      <label style={labelStyle}>金額（見積り） <span style={{ color: '#dc3545' }}>*</span></label>
                      {item.useManualAmount ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ color: text, fontSize: 14 }}>¥</span>
                          <input
                            type="text" inputMode="numeric" value={item.amount}
                            onChange={e => updateItem(itemIndex, { amount: formatAmount(parseAmount(e.target.value)) })}
                            placeholder="0" style={inputStyle}
                          />
                        </div>
                      ) : item.amountManuallyOverridden ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ color: text, fontSize: 14 }}>¥</span>
                          <input
                            type="text" inputMode="numeric" value={item.amount}
                            onChange={e => updateItem(itemIndex, { amount: formatAmount(parseAmount(e.target.value)) })}
                            placeholder="0" style={inputStyle}
                          />
                        </div>
                      ) : (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <div style={{ ...inputStyle, background: isDarkMode ? '#232336' : '#f0f0f0', color: subText, flex: 1 }}>
                            ¥{item.amount || '0'}（単価×数量で自動計算）
                          </div>
                          <button
                            type="button" onClick={() => overrideItemAmount(itemIndex)}
                            style={{ background: 'none', border: 'none', color: '#4a90d9', fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap' }}
                          >
                            上書きする
                          </button>
                        </div>
                      )}
                    </div>

                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, paddingTop: 4, borderTop: `1px solid ${border}` }}>
                      <span />
                      <button
                        type="button"
                        onClick={() => removeItem(itemIndex)}
                        disabled={items.length <= 1}
                        title={items.length <= 1 ? '商品が1件のみのため削除できません' : undefined}
                        style={{ background: 'none', border: 'none', color: items.length <= 1 ? subText : '#dc3545', fontSize: 12, cursor: items.length <= 1 ? 'default' : 'pointer', padding: 0 }}
                      >
                        この商品を削除
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div>
          <button
            type="button" onClick={addItem}
            style={{ background: 'none', border: `1px dashed ${border}`, color: '#4a90d9', fontSize: 13, cursor: 'pointer', padding: '10px', width: '100%', borderRadius: 8 }}
          >
            ＋ 商品を追加
          </button>
        </div>

        {items.length >= 2 && (
          <div style={{ overflowX: 'auto' }}>
            <label style={labelStyle}>商品一覧</label>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, color: text }}>
              <thead>
                <tr style={{ background: inputBg }}>
                  <th style={{ textAlign: 'left', padding: '6px 8px', border: `1px solid ${border}` }}>品目名</th>
                  <th style={{ textAlign: 'right', padding: '6px 8px', border: `1px solid ${border}` }}>数量</th>
                  <th style={{ textAlign: 'right', padding: '6px 8px', border: `1px solid ${border}` }}>単価</th>
                  <th style={{ textAlign: 'right', padding: '6px 8px', border: `1px solid ${border}` }}>金額</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it, i) => {
                  const selected = it.quotes.find(q => q.isSelected);
                  const unitAmount = !it.useManualAmount && selected?.unitAmount.trim() ? `¥${selected.unitAmount}` : '';
                  return (
                    <tr key={i}>
                      <td style={{ padding: '6px 8px', border: `1px solid ${border}` }}>{it.itemName || '(未入力)'}</td>
                      <td style={{ textAlign: 'right', padding: '6px 8px', border: `1px solid ${border}` }}>{it.quantity || ''}</td>
                      <td style={{ textAlign: 'right', padding: '6px 8px', border: `1px solid ${border}` }}>{unitAmount}</td>
                      <td style={{ textAlign: 'right', padding: '6px 8px', border: `1px solid ${border}` }}>¥{it.amount || '0'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {items.length >= 2 && (
          <div>
            <label style={labelStyle}>合計金額 <span style={{ color: '#dc3545' }}>*</span></label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ color: text, fontSize: 14 }}>¥</span>
              <input
                type="text" inputMode="numeric" value={manualTotalOverride}
                onChange={e => { setTotalManuallyOverridden(true); setManualTotalOverride(formatAmount(parseAmount(e.target.value))); }}
                placeholder="0" style={inputStyle}
              />
            </div>
            <div style={{ fontSize: 12, color: subText, marginTop: 4 }}>各商品の金額合計：¥{itemsSubtotal.toLocaleString()}</div>

            {showAmountDiffWarning && (
              <div style={{ marginTop: 8, padding: '10px 12px', background: warnBg, border: `1px solid ${warnBorder}`, borderRadius: 8 }}>
                <div style={{ fontSize: 12, color: warnText, marginBottom: 8 }}>
                  ℹ️ 合計金額が各商品の金額合計と異なり、金額帯（承認ルート）が変わります。差異の理由があれば入力してください（任意）。
                </div>
                <input
                  type="text" value={amountDiffReason} onChange={e => setAmountDiffReason(e.target.value)}
                  placeholder="差異の理由（任意）" style={inputStyle}
                />
              </div>
            )}
          </div>
        )}

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
                  <span key={a.id} style={{ fontSize: 12, color: text, background: isDarkMode ? '#495057' : '#f8f9fa', border: `1px solid ${border}`, borderRadius: 6, padding: '2px 8px' }}>
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
          <label style={labelStyle}>購入予定日 <span style={{ color: '#dc3545' }}>*</span></label>
          <input type="date" value={requestedDate} onChange={e => setRequestedDate(e.target.value)} style={inputStyle} />
        </div>

        {tier !== 'board' && canSelfJudge && (
          <div style={{ padding: '10px 12px', background: warnBg, border: `1px solid ${warnBorder}`, borderRadius: 8 }}>
            <div style={{ fontSize: 12, color: warnText, marginBottom: 8 }}>
              ℹ️ あなたの役職（{roleTitle}）はこの金額の決裁権限内のため、承認は必須ではありません。進め方を選んでください。
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: isSelfJudgment ? 12 : 0 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: text, cursor: 'pointer' }}>
                <input type="radio" checked={!selfJudgeConfirmFirst} onChange={() => setSelfJudgeConfirmFirst(false)} />
                共有のみ（購入後に共有）
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: text, cursor: 'pointer' }}>
                <input type="radio" checked={selfJudgeConfirmFirst} onChange={() => setSelfJudgeConfirmFirst(true)} />
                事前に確認してもらう（{tier === 'leader' ? 'リーダー' : 'マネージャー'}に依頼）
              </label>
            </div>

            {isSelfJudgment && (
              <div style={{ borderTop: `1px solid ${warnBorder}`, paddingTop: 10 }}>
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
                      {m.name}（{m.role_title}）
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {tier === 'leader' && !isSelfJudgment && (
          <div>
            <label style={labelStyle}>確認を依頼するリーダー・マネージャー <span style={{ color: '#dc3545' }}>*</span></label>
            <select value={leaderId} onChange={e => setLeaderId(e.target.value)} style={{ ...inputStyle, border: `2px solid ${leaderId ? '#28a745' : border}` }}>
              <option value="">選択してください</option>
              {leaders.map(l => (
                <option key={l.id} value={l.id}>{l.name}（{l.role_title}）</option>
              ))}
            </select>
          </div>
        )}

        {tier === 'manager' && !isSelfJudgment && (
          <div>
            <label style={labelStyle}>
              承認を依頼するマネージャー <span style={{ color: '#dc3545' }}>*</span>
              <span style={{ fontWeight: 'normal', color: subText }}>（{requestedManagerIds.length}名選択中）</span>
            </label>
            <div style={{ fontSize: 12, color: subText, marginBottom: 8 }}>
              複数選択できます。依頼した全員の回答（承認・否認・判断できない・その他）が揃うまで最終決定はできません。全員一致でなくても、意見が揃った後は依頼したどなたか1名が最終決定できます。
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {shareCandidates.map(m => (
                <label key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: text, cursor: 'pointer' }}>
                  <input type="checkbox" checked={requestedManagerIds.includes(m.id)} onChange={() => toggleRequestedManager(m.id)} />
                  {m.name}（{m.role_title}）
                </label>
              ))}
            </div>
          </div>
        )}

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
          disabled={submitting || (tier === 'board' && !isPresident && boardApprovers.length === 0)}
          style={{ width: '100%', padding: '14px', borderRadius: 10, border: 'none', background: submitting ? subText : '#28a745', color: '#fff', fontSize: 15, fontWeight: 'bold', cursor: submitting ? 'default' : 'pointer' }}
        >
          {submitting ? '送信しています...' : isResubmit ? '修正して再申請する' : (isSelfJudgment || (tier === 'board' && isPresident && presidentSelfJudgment)) ? '共有する' : '申請する'}
        </button>
      </div>
    </div>
  );
};

export default PurchaseRequestForm;

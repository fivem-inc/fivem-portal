import React, { useState, useEffect, useRef } from 'react';
import type { AuthUser, PurchaseRequestItem } from '../types';
import { formatAmount, parseAmount } from '../utils';
import { supabase } from '../lib/supabaseClient';
import { useDarkMode } from '../hooks/useDarkMode';
import { insertNotification } from '../lib/notifications';
import { todayJstStr } from '../lib/breakCalc';
import { dispatchSiteNotification, dispatchEmail, getNotificationTemplate, getUserEmail, getUserName, shouldSend } from '../lib/notificationDispatch';
import { sendPurchaseSlackForEvent } from '../lib/purchaseSlack';
import { resolveItems } from '../lib/purchaseItemsFallback';
import { errorStyle, scrollToFirstError, ERROR_BORDER, errorBg } from '../lib/formHighlight';
import QuoteFileUploader from './QuoteFileUploader';
// 金額帯の定義は lib/purchaseTiers.ts に集約（管理画面の修正モーダルからも同じ値を使う）
import { QUOTES_REQUIRED_THRESHOLD, TIER_LABEL, tierOf } from '../lib/purchaseTiers';
import type { Tier } from '../lib/purchaseTiers';

// 相見積もり1行分の下書き。isSelectedは商品内でラジオボタンにより排他選択される
// （どの業者から購入するかは「購入予定先を選択」セクションのラジオで選ぶ。isSelectedは商品内で1件だけtrue）
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
  // 金額に関係しないサイズ・色などの補足メモ。金額が異なる内訳は商品を分けて書く運用
  // （「この商品をコピーして追加」で楽に分けられる）
  breakdown: string;
  // 1万円以上で価格比較が1社しか無いときの理由（1万円未満では使わない）
  singleVendorReason: string;
  // 金額を手で上書きしたときの理由（送料込み・値引き後など）。
  // 単価×数量と違う金額になった理由が承認者に分からないため
  amountOverrideNote: string;
  collapsed: boolean;
}
// 業者カードは最低2枠を常に表示する（1枠目=購入先として必須・2枠目=比較を促すための空欄）
const emptyItemDraft = (): ItemDraft => ({
  itemName: '', quantity: '', amount: '', amountManuallyOverridden: false, storeName: '',
  quotes: [emptyQuoteDraft(), emptyQuoteDraft()], breakdown: '', singleVendorReason: '', amountOverrideNote: '', collapsed: false,
});

// 下書き（localStorage）や過去データを現在の形に揃える。
// 旧「金額を直接入力する（相見積もりを使わない）」モード（useManualAmount）は廃止したため、
// 店舗名＋金額を「業者1件（選択済み）」の形に変換する。フィールド追加時の undefined クラッシュも防ぐ
const normalizeItemDraft = (raw: Partial<ItemDraft> & { useManualAmount?: boolean }): ItemDraft => {
  const base: ItemDraft = {
    ...emptyItemDraft(),
    ...raw,
    quotes: (raw.quotes ?? []).map(q => ({ ...emptyQuoteDraft(), ...q })),
  };
  if (raw.useManualAmount && (raw.storeName ?? '').trim() && !base.quotes.some(q => q.isSelected)) {
    // 単価×数量の内訳は分からないので、金額をそのまま単価欄に入れ、自動計算はしない（上書き済み扱い）
    const converted: QuoteDraft = { ...emptyQuoteDraft(), vendor: (raw.storeName ?? '').trim(), unitAmount: raw.amount ?? '', isSelected: true };
    const emptyIdx = base.quotes.findIndex(q => !q.vendor.trim() && !q.unitAmount.trim());
    if (emptyIdx >= 0) base.quotes[emptyIdx] = converted; else base.quotes.unshift(converted);
    base.amountManuallyOverridden = true;
  }
  while (base.quotes.length < 2) base.quotes.push(emptyQuoteDraft());
  return base;
};

const itemDraftFromRecord = (item: PurchaseRequestItem): ItemDraft => {
  const quotes = item.quotes.map(q => ({
    vendor: q.vendor, unitAmount: formatAmount(String(q.unit_amount)), note: q.note ?? '',
    quoteFilePath: q.quote_file_path, isSelected: q.is_selected,
  }));
  const hasSelected = quotes.some(q => q.isSelected);
  // 旧「金額を直接入力する」モードで作られたデータ（選択済み業者が無く店舗名だけある）は
  // 購入先を業者1件（選択済み）として変換する。金額は保持したいので自動計算には戻さない
  if (!hasSelected && item.store_name) {
    quotes.unshift({ vendor: item.store_name, unitAmount: formatAmount(String(item.amount)), note: '', quoteFilePath: null, isSelected: true });
  }
  while (quotes.length < 2) quotes.push(emptyQuoteDraft());
  return {
    id: item.id,
    itemName: item.item_name,
    quantity: item.quantity != null ? String(item.quantity) : '',
    amount: formatAmount(String(item.amount)),
    amountManuallyOverridden: item.amount_manually_overridden || !hasSelected,
    storeName: item.store_name ?? '',
    quotes,
    breakdown: item.breakdown ?? '',
    singleVendorReason: item.single_vendor_reason ?? '',
    amountOverrideNote: item.amount_override_note ?? '',
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
    requestedDate: string; purpose: string; reason: string;
    notes: string; location: string;
    leaderId?: string;      // 旧形式の下書き（単数）。読み込み時だけ使う
    leaderIds: string[];
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
      // 保存済み下書きは必ず正規化してから使う（旧形式・フィールド追加後の undefined を吸収）
      if (savedDraft?.items && savedDraft.items.length > 0) return savedDraft.items.map(it => normalizeItemDraft(it));
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
  const [reason, setReason] = useState(resubmitRecord?.reason ?? savedDraft?.reason ?? '');
  const [notes, setNotes] = useState(resubmitRecord?.notes ?? savedDraft?.notes ?? '');
  const [location, setLocation] = useState(savedDraft?.location ?? '');
  const [workplaceOptions, setWorkplaceOptions] = useState<string[]>([]);
  const [purposeOptions, setPurposeOptions] = useState<string[]>([]);
  // 確認の依頼先（複数選べる。1人なら従来どおり pending_leader、2人以上は全員の回答を待つ審議ルート）
  // 再申請時：旧データは leader_id（単数）だが、複数依頼だった場合は requested_manager_ids に入っている
  const [leaderIds, setLeaderIds] = useState<string[]>(
    resubmitRecord?.leader_id ? [resubmitRecord.leader_id]
      : (resubmitRecord?.requested_manager_ids && resubmitRecord.requested_manager_ids.length > 0 && (resubmitRecord.amount ?? 0) <= 10000)
        ? resubmitRecord.requested_manager_ids
        : (savedDraft?.leaderIds ?? (savedDraft?.leaderId ? [savedDraft.leaderId] : []))
  );
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
  const [managerPlusIds, setManagerPlusIds] = useState<string[]>([]);
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
        items, requestedDate, purpose, reason, notes, location,
        leaderIds, requestedManagerIds, sharedManagerIds, presidentSelfJudgment,
        selfJudgeConfirmFirst, manualTotalOverride, totalManuallyOverridden, amountDiffReason,
      }));
    } catch { /* 保存容量超過などは無視 */ }
  }, [isResubmit, items, requestedDate, purpose, reason, notes, location, leaderIds, requestedManagerIds, sharedManagerIds, presidentSelfJudgment, selfJudgeConfirmFirst, manualTotalOverride, totalManuallyOverridden, amountDiffReason]);

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
    // 決裁権限内の購入（承認不要）を共有する相手。
    // 申請者が選んだ共有先だけだと1人しか知らない状態になり「何が買われているか把握できない」ため、
    // マネージャー・社長・管理者（経理）にも届ける。⚠️ 経理にはホームのバナーは出ない（App.tsxが !isAdmin）
    supabase.from('profiles').select('id').eq('is_active', true)
      .in('role_title', ['マネージャー', '社長', '管理者']).neq('id', user.id).then(
        ({ data }) => setManagerPlusIds(((data ?? []) as { id: string }[]).map(m => m.id)),
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
  // 入力漏れの欄を薄赤にするためのキー集合（lib/formHighlight.ts の共通色を使う）
  const [errFields, setErrFields] = useState<Set<string>>(new Set());
  // 送信前の確認画面。承認ルートと承認者名を見せるのが目的
  const [showConfirm, setShowConfirm] = useState(false);

  // 購入予定先＝選択した業者。旧「金額を直接入力する」モードは廃止した
  // （確認画面と送信処理の両方で使うのでコンポーネント直下に置く）
  const effectiveStoreName = (item: ItemDraft): string | null => {
    const selected = item.quotes.find(q => q.isSelected);
    return selected?.vendor.trim() || null;
  };
  // 業者名と単価が両方入った業者だけが「購入予定先」の選択肢になる
  const validQuotes = (item: ItemDraft) => item.quotes.filter(q => q.vendor.trim() && q.unitAmount.trim());
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
      // 実際に承認関連の入力を消したときだけバナーを出す
      // （初めて金額を入れただけ＝リセット対象が無いのに毎回出すのはノイズになる）
      const hadRouteInput = leaderIds.length > 0 || requestedManagerIds.length > 0 || sharedManagerIds.length > 0 || presidentSelfJudgment || selfJudgeConfirmFirst;
      if (hadRouteInput) setTierBanner(`${TIER_LABEL[tier]}の金額になったため、承認に関する入力項目が変わりました`);
      setLeaderIds([]); setRequestedManagerIds([]); setSharedManagerIds([]); setPresidentSelfJudgment(false); setSelfJudgeConfirmFirst(false);
    }
    prevTierRef.current = tier;
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  // 商品が複数あるとき、開くカードは常に1つだけにする（縦に長くなって迷子になるのを防ぐ）
  const openOnly = (index: number) => setItems(prev => prev.map((it, i) => ({ ...it, collapsed: i !== index })));
  // コピー直後に品目名へカーソルを入れて全選択するための指定（同じ名前が並ぶのが混乱の主因なので、すぐ直せるようにする）
  const [focusItemName, setFocusItemName] = useState<number | null>(null);
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
  // ヘッダー・目次からの開閉。開くときは他を閉じて1つだけにする
  const toggleItemCollapsed = (index: number) => {
    setItems(prev => prev[index]?.collapsed
      ? prev.map((it, i) => ({ ...it, collapsed: i !== index }))
      : prev.map((it, i) => i === index ? { ...it, collapsed: true } : it));
  };
  // 目次（商品一覧）から該当カードを開いてスクロールする
  const jumpToItem = (index: number) => {
    openOnly(index);
    requestAnimationFrame(() => itemRefs.current[index]?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };

  // 商品ごとの単価×数量の自動計算。amountManuallyOverriddenがtrueなら自動計算は行わない
  const recalcItemAmount = (item: ItemDraft): ItemDraft => {
    if (item.amountManuallyOverridden) return item;
    const selected = item.quotes.find(q => q.isSelected);
    if (!selected) return item;
    const unit = selected.unitAmount.trim() ? parseInt(parseAmount(selected.unitAmount), 10) : NaN;
    if (isNaN(unit)) return item;
    const qty = item.quantity.trim() ? parseInt(parseAmount(item.quantity), 10) : 1;
    const total = unit * Math.max(isNaN(qty) ? 1 : qty, 1);
    return { ...item, amount: formatAmount(String(total)) };
  };

  const updateQuote = (itemIndex: number, quoteIndex: number, patch: Partial<QuoteDraft>) => {
    setItems(prev => prev.map((it, i) => {
      if (i !== itemIndex) return it;
      const hadSelected = it.quotes.some(q => q.isSelected);
      const quotes = it.quotes.map((q, qi) => {
        if (qi !== quoteIndex) return q;
        const nq = { ...q, ...patch };
        // 業者名か単価を空にしたら「購入予定」の選択を外す（選択だけが宙に浮くのを防ぐ）
        if (nq.isSelected && (!nq.vendor.trim() || !nq.unitAmount.trim())) nq.isSelected = false;
        return nq;
      });
      const next: ItemDraft = { ...it, quotes };
      // 選択が外れたら古い金額を残さない（自動計算値のままだと実態とズレる）
      if (hadSelected && !quotes.some(q => q.isSelected) && !it.amountManuallyOverridden) next.amount = '';
      return recalcItemAmount(next);
    }));
  };
  const addQuote = (itemIndex: number) => {
    setItems(prev => prev.map((it, i) => i === itemIndex ? { ...it, quotes: [...it.quotes, emptyQuoteDraft()] } : it));
  };
  const removeQuote = (itemIndex: number, quoteIndex: number) => {
    setItems(prev => prev.map((it, i) => {
      if (i !== itemIndex) return it;
      if (it.quotes.length <= 2) return it; // 最低2枠は常に表示（比較を促す）
      const wasSelected = it.quotes[quoteIndex]?.isSelected;
      const quotes = it.quotes.filter((_, qi) => qi !== quoteIndex);
      const next: ItemDraft = { ...it, quotes };
      if (wasSelected && !it.amountManuallyOverridden) next.amount = '';
      return recalcItemAmount(next);
    }));
  };

  // ラジオボタンで「この業者から購入予定」を選択。同じ商品内の他のquoteは自動的に非選択になる
  const selectQuote = (itemIndex: number, quoteIndex: number) => {
    setItems(prev => prev.map((it, i) => {
      if (i !== itemIndex) return it;
      const quotes = it.quotes.map((q, qi) => ({ ...q, isSelected: qi === quoteIndex }));
      // 業者選択が変わったのでamountManuallyOverriddenをリセットし、自動計算に戻す
      return recalcItemAmount({ ...it, quotes, amountManuallyOverridden: false });
    }));
  };
  // 自動計算値を手動で上書きするモードに切り替え
  const overrideItemAmount = (itemIndex: number) => {
    updateItem(itemIndex, { amountManuallyOverridden: true });
  };

  // この商品をコピーして末尾に追加する。サイズ・色違いなど「金額の異なる内訳」は
  // 商品を分けて書く運用のための補助（業者名・単価もコピーし、品目名と数量だけ直せば済むように）。
  // ファイル添付は複製しない（同じ見積書を2回数えないため）
  const copyItem = (index: number) => {
    setItems(prev => {
      const src = prev[index];
      if (!src) return prev;
      const copy: ItemDraft = {
        ...src,
        id: undefined,
        quotes: src.quotes.map(q => ({ ...q, quoteFilePath: null })),
        collapsed: false,
      };
      // 追加した直後に品目名へカーソルを入れて全選択する（同じ名前が並ぶのを避ける）
      setFocusItemName(prev.length);
      return [...prev.map(it => ({ ...it, collapsed: true })), copy];
    });
  };

  const resetForm = () => {
    setItems([emptyItemDraft()]);
    setRequestedDate(todayJstStr());
    setPurpose(''); setReason(''); setNotes(''); setLocation('');
    setLeaderIds([]); setRequestedManagerIds([]); setSharedManagerIds([]);
    setPresidentSelfJudgment(false); setSelfJudgeConfirmFirst(false);
    setManualTotalOverride(''); setTotalManuallyOverridden(false); setAmountDiffReason('');
    try { localStorage.removeItem(DRAFT_STORAGE_KEY); } catch { /* ignore */ }
  };

  const handleSubmit = async () => {
    setFormError('');
    // 足りない項目をまとめて集め、赤バナー＋該当欄のハイライト＋最初の欄へスクロールで知らせる
    // （1件ずつ返す作りだと「どこが原因か分からない」と実機で指摘された。数量の入力漏れが典型）
    const missing: { key: string; label: string }[] = [];
    const label = (i: number, name: string) => items.length > 1 ? `商品${i + 1}の${name}` : name;

    // pushの順序は画面の並び（①使用先・用途 → ②商品 → ③申請理由 → ④承認）に合わせる。
    // scrollToFirstError は missing[0] へスクロールするため、順序がズレると
    // 画面上部の入力漏れを飛ばして中段へスクロールしてしまう
    if (!location.trim()) missing.push({ key: 'location', label: '使用先' });
    if (!purpose.trim()) missing.push({ key: 'purpose', label: '用途' });

    items.forEach((item, i) => {
      if (!item.itemName.trim()) missing.push({ key: `itemName-${i}`, label: label(i, '品目名') });
      const itemQty = item.quantity.trim() ? parseInt(parseAmount(item.quantity), 10) : NaN;
      if (!item.quantity.trim() || isNaN(itemQty) || itemQty < 1) missing.push({ key: `quantity-${i}`, label: label(i, '数量（1以上）') });
      // 業者を選んで購入する場合、その単価が0円だと商品の金額も0円になるため単価も1円以上を必須にする
      item.quotes.forEach((q, qi) => {
        if (!q.vendor.trim() && !q.unitAmount.trim()) return;
        const unit = q.unitAmount.trim() ? parseInt(parseAmount(q.unitAmount), 10) : NaN;
        if (q.unitAmount.trim() && (isNaN(unit) || unit < 1)) missing.push({ key: `quote-${i}-${qi}`, label: label(i, '価格比較の単価（1円以上）') });
      });
      // 購入先の入力と「購入予定先の選択」。
      // 以前は未選択だと「金額を入力してください」という無関係なエラーになり、原因が分からなかった
      const valid = validQuotes(item);
      if (valid.length === 0) {
        missing.push({ key: `quote-${i}-0`, label: label(i, '購入先（業者1の業者名と単価）') });
      } else if (!item.quotes.some(q => q.isSelected)) {
        missing.push({ key: `purchaseFrom-${i}`, label: label(i, '購入予定先の選択') });
      }
      // 1万円以上は各商品につき2社以上の価格比較が必須。
      // ただし取扱いが1社だけ・緊急などで取れない実務があるため、理由を書けば通せる（理由は承認者にも見える）
      if (quotesRequired && valid.length === 1 && !item.singleVendorReason.trim()) {
        missing.push({ key: `singleVendor-${i}`, label: label(i, '1社しか選べない理由') });
      }
      const itemAmt = item.amount.trim() ? parseInt(parseAmount(item.amount), 10) : NaN;
      // 0円を許すと、金額で決まる承認ルートがいちばん緩いリーダー承認に落ちてしまう（相見積もりの必須判定も外れる）
      if (valid.length > 0 && (!item.amount.trim() || isNaN(itemAmt) || itemAmt < 1)) missing.push({ key: `amount-${i}`, label: label(i, '金額（1円以上）') });
    });

    if (items.length > 1 && (!amount.trim() || isNaN(parsedAmount) || parsedAmount < 1)) missing.push({ key: 'total', label: '合計金額（1円以上）' });
    if (!requestedDate) missing.push({ key: 'requestedDate', label: '購入予定日' });
    if (!reason.trim()) missing.push({ key: 'reason', label: '申請理由' });
    if (tier === 'leader' && !isSelfJudgment && leaderIds.length === 0) missing.push({ key: 'leader', label: '確認を依頼するリーダー・マネージャー' });
    if (tier === 'manager' && !isSelfJudgment && requestedManagerIds.length === 0) missing.push({ key: 'managers', label: '承認を依頼するマネージャー（1名以上）' });
    if (isSelfJudgment && sharedManagerIds.length === 0) missing.push({ key: 'sharedManagers', label: '共有先のマネージャー（1名以上）' });

    if (missing.length > 0) {
      setErrFields(new Set(missing.map(m => m.key)));
      setFormError(`次の項目を入力してください：${missing.map(m => m.label).join('、')}`);
      scrollToFirstError(missing.map(m => m.key));
      return;
    }
    setErrFields(new Set());

    // 入力漏れではないので、ハイライトではなくメッセージだけで止める
    if (!amount.trim() || isNaN(parsedAmount) || parsedAmount < 1) { setFormError('金額を正しく入力してください（1円以上）。'); return; }
    if (tier === 'board' && !isPresident && boardApprovers.length === 0) { setFormError('承認対象者（マネージャー・社長）が現在0名のため、申請できません。管理者にご連絡ください。'); return; }

    // 送信前に確認画面を出す。金額によって承認ルートが変わるのに、
    // これまでは誰に承認を依頼するのか送信するまで分からなかった（ケタ違いの金額にも気づけない）
    setShowConfirm(true);
  };

  const doSubmit = async () => {
    setShowConfirm(false);
    const presidentSelfJudge = tier === 'board' && isPresident && presidentSelfJudgment;
    // 1万円以下でも確認を複数人に依頼したときは、全員の回答を待つ審議ルート(pending_manager)に乗せる。
    // 1人だけなら従来どおり pending_leader（そのまま承認で確定・シンプル）。
    const leaderMulti = tier === 'leader' && !isSelfJudgment && leaderIds.length > 1;
    const status = tier === 'board'
      ? (presidentSelfJudge ? 'self_judgment_shared' : 'pending_board')
      : isSelfJudgment ? 'self_judgment_shared'
      : tier === 'leader' ? (leaderMulti ? 'pending_manager' : 'pending_leader')
      : 'pending_manager';
    const routeFields = {
      leader_id: tier === 'leader' && !isSelfJudgment && !leaderMulti ? (leaderIds[0] ?? null) : null,
      requested_manager_ids: leaderMulti ? leaderIds
        : tier === 'manager' && !isSelfJudgment ? requestedManagerIds : null,
      shared_manager_ids: isSelfJudgment ? sharedManagerIds : null,
      is_self_judgment: isSelfJudgment,
      president_self_judgment: presidentSelfJudge,
    };

    setSubmitting(true);

    const firstItemName = items[0].itemName.trim();
    const itemNameVar = items.length > 1 ? `${firstItemName}（他${items.length - 1}件）` : firstItemName;
    // 氏名は profiles.name から取る（user_metadata は full_name で入っている人がいて空になる）
    const applicantName = await getUserName(user.id);
    const vars = { '申請者名': applicantName, '品目名': itemNameVar, '金額': parsedAmount.toLocaleString() };

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
        // ベル・プッシュは「選んだ共有先＋マネージャー以上＋経理」に広げる（何が買われているかの把握のため）。
        // メールは選んだ共有先だけに留める（Resend無料枠は1日100通。ベル＋プッシュ＋バナーで足りる）
        const shareTargets = [...new Set([...sharedManagerIds, ...managerPlusIds])].filter(id => id !== user.id);
        const tpl = await getNotificationTemplate('purchase_request:self_judgment_shared', 'site', vars);
        if (tpl) {
          await Promise.all(shareTargets.map(id => insertNotification(id, tpl.template, tpl.subject || undefined, 'purchase_request', recordId, 'purchase_request:self_judgment_shared')));
        }
        sendPurchaseSlackForEvent('purchase_request:self_judgment_shared', 'submitted', 'self_judgment', applicantName, itemNameVar, parsedAmount).then(null, () => {});
        notifyEmailToMany('purchase_request:self_judgment_shared', sharedManagerIds).then(null, () => {});
      } else if (tier === 'leader' && !leaderMulti) {
        // 1人だけに依頼した場合（従来どおり）
        await dispatchSiteNotification('purchase_request:submitted', vars, { leader: leaderIds[0] }, insertNotification, 'purchase_request:pending_approval', recordId);
        sendPurchaseSlackForEvent('purchase_request:submitted', 'submitted', 'leader', applicantName, itemNameVar, parsedAmount).then(null, () => {});
        (async () => {
          const leaderEmail = await getUserEmail(leaderIds[0]);
          if (leaderEmail) await dispatchEmail('purchase_request:submitted', vars, { leader: leaderEmail });
        })().then(null, () => {});
      } else if (leaderMulti) {
        // 複数人に依頼した場合は審議ルートに乗るので、そちらの通知を使う（全員に届ける）
        const tpl = await getNotificationTemplate('purchase_request:submitted_manager', 'site', vars);
        if (tpl) {
          await Promise.all(leaderIds.map(id => insertNotification(id, tpl.template, tpl.subject || undefined, 'purchase_request:pending_approval', recordId, 'purchase_request:submitted_manager')));
        }
        sendPurchaseSlackForEvent('purchase_request:submitted_manager', 'submitted', 'manager', applicantName, itemNameVar, parsedAmount).then(null, () => {});
        notifyEmailToMany('purchase_request:submitted_manager', leaderIds).then(null, () => {});
      } else {
        const tpl = await getNotificationTemplate('purchase_request:submitted_manager', 'site', vars);
        if (tpl) {
          await Promise.all(requestedManagerIds.map(id => insertNotification(id, tpl.template, tpl.subject || undefined, 'purchase_request:pending_approval', recordId, 'purchase_request:submitted_manager')));
        }
        sendPurchaseSlackForEvent('purchase_request:submitted_manager', 'submitted', 'manager', applicantName, itemNameVar, parsedAmount).then(null, () => {});
        notifyEmailToMany('purchase_request:submitted_manager', requestedManagerIds).then(null, () => {});
      }
    };

    const finalPurpose = purpose;

    const p_header = {
      amount: parsedAmount,
      requested_purchase_date: requestedDate,
      store_name: effectiveStoreName(items[0]),
      purpose: finalPurpose.trim() || null,
      reason: reason.trim() || null,
      location: location.trim() || null,
      notes: notes.trim() || null,
      // 乖離警告が消えているのに古い理由だけ残さない
      amount_diff_reason: showAmountDiffWarning ? (amountDiffReason.trim() || null) : null,
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
      quantity: item.quantity.trim() ? parseInt(parseAmount(item.quantity), 10) : null,
      amount: parseInt(parseAmount(item.amount), 10),
      amount_manually_overridden: item.amountManuallyOverridden,
      store_name: effectiveStoreName(item),
      breakdown: item.breakdown.trim(),
      // 上書きしていないときは残さない（自動計算に戻したのに古い理由が残るのを防ぐ）
      amount_override_note: item.amountManuallyOverridden ? item.amountOverrideNote.trim() : '',
      // 1万円以上で価格比較が1社しか無い場合のみ意味を持つ（それ以外は空で送る）
      single_vendor_reason: quotesRequired && validQuotes(item).length < 2 ? item.singleVendorReason.trim() : '',
      quotes: validQuotes(item)
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

    // 通知の失敗で成功処理（バナー・フォームのリセット）を止めない。
    // ここでthrowされると、申請は登録済みなのに失敗に見え、再送すると主キー重複で二重申請騒ぎになる
    try {
      await notify(data as string);
    } catch (e) {
      console.error('[purchase notify] 通知処理に失敗（申請自体は完了しています）', e);
    }
    setSuccessBanner(true);
    if (isResubmit) {
      onDoneResubmit?.();
    } else {
      resetForm();
    }
  };

  const labelStyle: React.CSSProperties = { fontSize: 13, fontWeight: 'bold', color: text, marginBottom: 6, display: 'block' };
  // fontSize は16px。14pxだとiPhoneが入力欄にフォーカスした瞬間に画面を勝手に拡大し、
  // 金額が読めない・レイアウトが飛ぶという実機の指摘があった（Safariは16px未満で自動ズームする）
  const inputStyle: React.CSSProperties = { width: '100%', boxSizing: 'border-box', padding: '10px 12px', borderRadius: 8, border: `1px solid ${border}`, background: inputBg, color: text, fontSize: 16 };
  // エラーの欄だけ薄赤にする。入力し直したらその欄のハイライトを消す
  const errStyle = (key: string): React.CSSProperties => ({ ...inputStyle, ...errorStyle(errFields.has(key), isDarkMode) });
  const clearErr = (key: string) => setErrFields(prev => {
    if (!prev.has(key)) return prev;
    const next = new Set(prev); next.delete(key); return next;
  });
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
        <div>・1万円以下：リーダー以上は決裁権限内のため承認不要（購入後に共有）／一般スタッフはリーダーかマネージャーの承認が必要</div>
        <div>・1万円超〜3万円：マネージャー以上は決裁権限内のため承認不要（購入後に共有）／それ以外はマネージャーの承認が必要（相見積もりも必須）</div>
        <div>・3万円超：全マネージャー・社長の全員承認が必要（相見積もりも必須）。社長ご本人の申請のみ承認不要（購入後に共有）を選択できます</div>
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

        {/* 並び順は「目的（①②）→ 商品（③）→ 確認・承認（④）」（2026-07-30ユーザー決定）。
            意図が不明確なまま業者を調べると調べる時間が無駄になるため、
            使用先・用途・申請理由を商品の入力より先に置く。申請理由は金額に依存しないので前に書ける */}
        <div>
          <div style={{ fontSize: 13, fontWeight: 'bold', color: text }}>① 何に使うか</div>
        </div>

        <div>
          <label style={labelStyle}>使用先 <span style={{ color: '#dc3545' }}>*</span></label>
          {locationOptions.length > 0 ? (
            <>
              <select
                data-err-field="location"
                value={locationOptions.includes(location) ? location : (location ? 'その他' : '')}
                onChange={e => { setLocation(e.target.value === 'その他' ? '' : e.target.value); clearErr('location'); }}
                style={errStyle('location')}
              >
                <option value="">選択してください</option>
                {locationOptions.map(loc => <option key={loc} value={loc}>{loc}</option>)}
                <option value="その他">その他</option>
              </select>
              {(!locationOptions.includes(location)) && (
                <input
                  type="text" value={location} onChange={e => { setLocation(e.target.value); clearErr('location'); }}
                  placeholder="使用先を入力" style={{ ...inputStyle, marginTop: 6 }}
                />
              )}
            </>
          ) : (
            <input data-err-field="location" type="text" value={location} onChange={e => { setLocation(e.target.value); clearErr('location'); }} placeholder="使用先を入力" style={errStyle('location')} />
          )}
        </div>

        <div>
          <label style={labelStyle}>用途 <span style={{ color: '#dc3545' }}>*</span></label>
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
              {/* プリセットを選んだときの「詳細（任意）」欄は廃止した。
                  用途の直下に自由入力欄があると、そこに商品名を書きたくなり品目名と紛らわしい
                  という実機の指摘（2026-07-30）。補足は「備考」に書く運用にする */}
              {(!purposeOptions.includes(purpose)) && (
                <input
                  type="text" value={purpose} onChange={e => { setPurpose(e.target.value); clearErr('purpose'); }}
                  placeholder="上記のどれにも当てはまらない場合は入力してください" style={{ ...inputStyle, marginTop: 6 }}
                />
              )}
            </>
          ) : (
            <input data-err-field="purpose" type="text" value={purpose} onChange={e => { setPurpose(e.target.value); clearErr('purpose'); }} placeholder="上記のどれにも当てはまらない場合は入力してください" style={errStyle('purpose')} />
          )}
        </div>

        <div style={{ borderTop: `1px solid ${border}`, paddingTop: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 'bold', color: text }}>② 何を買うか</div>
          {/* 総額見積（一式）と品目ごとの購入で書き方が変わるため、入力の前に目安を示す。
              仕組みは1つのまま「品目名を一式にするか、商品を分けるか」の判断に落としている */}
          <div style={{ fontSize: 12, color: subText, marginTop: 6 }}>
            ・業者に一式で見積を取った場合 → 商品は1件にして「〇〇一式」。業者ごとに総額と内訳を書きます<br />
            ・品目ごとに買う場合 → 商品を分けて、それぞれに購入先と単価を書きます
          </div>
        </div>
        {/* 商品が2件以上のときの目次。商品カードの「上」に置き、行をタップするとそのカードを開いて
            そこまでスクロールする。以前は一番下にあり、コピーで増やすと何がどこにあるか分からなくなっていた */}
        {items.length >= 2 && (
          <div>
            <label style={labelStyle}>商品一覧 <span style={{ color: subText, fontWeight: 'normal' }}>（タップで開く）</span></label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {items.map((it, i) => {
                const isOpen = !it.collapsed;
                // 商品ごとに選ぶ業者が違うことがあるので、目次で選択中の業者が分かるようにする
                const selectedVendor = it.quotes.find(q => q.isSelected)?.vendor.trim();
                return (
                  <button
                    key={i} type="button" onClick={() => jumpToItem(i)}
                    style={{
                      display: 'flex', alignItems: 'flex-start', gap: 8, width: '100%', textAlign: 'left',
                      padding: '8px 10px', borderRadius: 8, cursor: 'pointer', fontSize: 13, color: text,
                      border: `${isOpen ? 2 : 1}px solid ${isOpen ? '#28a745' : border}`,
                      background: isOpen ? (isDarkMode ? '#1e3a26' : '#f3fbf5') : 'transparent',
                    }}
                  >
                    <span style={{ color: subText, flexShrink: 0 }}>{i + 1}</span>
                    <span style={{ flex: 1 }}>
                      {it.itemName || '(未入力)'}
                      {it.quantity.trim() && <span style={{ color: subText }}>　×{it.quantity}</span>}
                      {it.breakdown.trim() && (
                        <span style={{ display: 'block', fontSize: 11, color: subText }}>{it.breakdown}</span>
                      )}
                      <span style={{ display: 'block', fontSize: 11, color: selectedVendor ? subText : '#dc3545' }}>
                        {selectedVendor ? `購入予定先：${selectedVendor}` : '購入予定先が未選択'}
                      </span>
                    </span>
                    <span style={{ whiteSpace: 'nowrap', fontWeight: 'bold' }}>¥{it.amount || '0'}</span>
                    {isOpen && <span style={{ color: '#28a745', fontSize: 11, flexShrink: 0 }}>今ここ</span>}
                  </button>
                );
              })}
            </div>
            <div style={{ textAlign: 'right', fontSize: 12, color: subText, marginTop: 4 }}>
              各商品の金額合計：¥{itemsSubtotal.toLocaleString()}
            </div>
          </div>
        )}


        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {items.map((item, itemIndex) => {
            const showHeader = items.length >= 2;
            const itemQuotesRequired = quotesRequired;

            return (
              <div
                key={itemIndex} ref={el => { itemRefs.current[itemIndex] = el; }}
                style={{
                  // 開いているカードの枠を緑にして「今どこを編集しているか」を分かるようにする
                  border: `${showHeader && !item.collapsed ? 2 : 1}px solid ${showHeader && !item.collapsed ? '#28a745' : border}`,
                  borderRadius: 10, overflow: 'hidden', scrollMarginTop: 70,
                }}
              >
                {showHeader && (
                  <div
                    onClick={() => toggleItemCollapsed(itemIndex)}
                    style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '10px 12px', background: inputBg, cursor: 'pointer', fontSize: 13, color: text, fontWeight: 'bold' }}
                  >
                    <span style={{ flex: 1 }}>
                      商品{itemIndex + 1}　{item.itemName || '(未入力)'}
                      {/* 同じ品目名が並んだときの見分けになるので内訳も出す */}
                      {item.breakdown.trim() && (
                        <span style={{ display: 'block', fontSize: 11, fontWeight: 'normal', color: subText }}>{item.breakdown}</span>
                      )}
                    </span>
                    <span style={{ whiteSpace: 'nowrap' }}>¥{item.amount || '0'}</span>
                    <span style={{ color: subText, fontSize: 11 }}>{item.collapsed ? '▼' : '▲'}</span>
                  </div>
                )}

                {(!showHeader || !item.collapsed) && (
                  <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 14 }}>
                    <div>
                      <label style={labelStyle}>品目名 <span style={{ color: '#dc3545' }}>*</span></label>
                      {/* 鉛筆・消しゴム等のまとめ買いで「何を書けばいいか分からない」への案内（2026-07-30） */}
                      <div style={{ fontSize: 12, color: subText, marginBottom: 6 }}>
                        まとめて買う場合は「事務用品」「〇〇一式」などでも構いません。
                      </div>
                      <input
                        data-err-field={`itemName-${itemIndex}`}
                        // コピー直後だけカーソルを入れて全選択する（「Sサイズ」等にすぐ直せるように）
                        ref={el => {
                          if (el && focusItemName === itemIndex) {
                            el.focus(); el.select();
                            setFocusItemName(null);
                          }
                        }}
                        type="text" value={item.itemName} onChange={e => { updateItem(itemIndex, { itemName: e.target.value }); clearErr(`itemName-${itemIndex}`); }}
                        placeholder="例：ミニハードル／ロイター板" style={errStyle(`itemName-${itemIndex}`)}
                      />
                    </div>

                    <div>
                      <label style={labelStyle}>内訳・仕様 <span style={{ color: subText, fontWeight: 'normal' }}>（任意）</span></label>
                      <div style={{ fontSize: 12, color: subText, marginBottom: 6 }}>
                        サイズ・色などのメモです。単価が違うものは「この商品をコピーして追加」で分けてください。
                      </div>
                      <input
                        type="text" value={item.breakdown}
                        onChange={e => updateItem(itemIndex, { breakdown: e.target.value })}
                        placeholder="例：高さ30cm×10本／幅60cm" style={inputStyle}
                      />
                    </div>

                    <div>
                      <label style={labelStyle}>数量 <span style={{ color: '#dc3545' }}>*</span></label>
                      <div style={{ fontSize: 12, color: subText, marginBottom: 6 }}>
                        業者に一式で見積を取った場合は数量1にして、下の金額に見積総額を入れてください。
                      </div>
                      <input
                        data-err-field={`quantity-${itemIndex}`}
                        type="number" min="1" value={item.quantity}
                        onChange={e => { updateItem(itemIndex, recalcItemAmount({ ...item, quantity: e.target.value })); clearErr(`quantity-${itemIndex}`); }}
                        style={errStyle(`quantity-${itemIndex}`)}
                      />
                    </div>

                    {/* 価格比較（購入先の入力）。
                        スマホで単価が見えない・購入予定を行内ラジオで選ぶのが分かりにくい、という
                        実機指摘を受けて、1業者=1カードの縦積みにし、選択は下の専用セクションへ移した。
                        比較を促すため業者カードは最低2枠を常に表示する */}
                    <div>
                      <label style={labelStyle}>
                        購入先・価格比較 {itemQuotesRequired ? <span style={{ color: '#dc3545' }}>*（2社以上必須）</span> : <span style={{ color: '#dc3545' }}>*</span>}
                      </label>
                      {/* 1万円以上は赤いバナーで「必須」を明示（2026-07-30ユーザー承認済みの文言・固定の明るい赤） */}
                      {itemQuotesRequired ? (
                        <div style={{ marginBottom: 6, padding: '8px 10px', background: '#f8d7da', border: '1px solid #f5c2c7', borderRadius: 8, fontSize: 12, fontWeight: 'bold', color: '#842029' }}>
                          申請合計が1万円以上のため、2社以上の価格比較が必須です
                        </div>
                      ) : (
                        <div style={{ fontSize: 12, color: subText, marginBottom: 4 }}>
                          1万円未満でも、複数の業者・店舗で価格を比べておくとコスト意識の共有に役立ちます。1社目は購入先として必ず入力してください（2社目以降は任意です）。
                        </div>
                      )}
                      {/* 商品ごとに業者を打ち直す手間は「この商品をコピーして追加」（カード下部）で解消するため、
                          旧「商品1の業者情報をコピー」ボタンは廃止した */}
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                        {item.quotes.map((q, qi) => (
                          <div key={qi} style={{ padding: 10, border: `1px solid ${q.isSelected ? '#28a745' : border}`, borderRadius: 8, background: q.isSelected ? (isDarkMode ? '#1e3a26' : '#f3fbf5') : 'transparent' }}>
                            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
                              <span style={{ fontSize: 12, fontWeight: 'bold', color: subText }}>
                                業者 {qi + 1}{qi === 0 ? '（購入先）' : ''}
                                {/* 1万円以上は2社目が必須になることを枠の見出しにも示す */}
                                {qi === 1 && itemQuotesRequired && <span style={{ color: '#dc3545', marginLeft: 4 }}>（必須）</span>}
                                {q.isSelected && <span style={{ color: '#28a745', marginLeft: 6 }}>購入予定</span>}
                              </span>
                              {item.quotes.length > 2 && (
                                <button
                                  type="button" onClick={() => removeQuote(itemIndex, qi)} title="この業者を削除"
                                  style={{ marginLeft: 'auto', background: 'none', border: 'none', color: subText, fontSize: 18, cursor: 'pointer', width: 40, height: 40, lineHeight: 1 }}
                                >✕</button>
                              )}
                            </div>
                            <input
                              data-err-field={`quote-${itemIndex}-${qi}`}
                              type="text" value={q.vendor}
                              onChange={e => { updateQuote(itemIndex, qi, { vendor: e.target.value }); clearErr(`quote-${itemIndex}-${qi}`); clearErr(`purchaseFrom-${itemIndex}`); }}
                              placeholder="業者名・店舗名" style={errStyle(`quote-${itemIndex}-${qi}`)}
                            />
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
                              <span style={{ color: text, fontSize: 16 }}>¥</span>
                              <input
                                type="text" inputMode="numeric" value={q.unitAmount}
                                onChange={e => { updateQuote(itemIndex, qi, { unitAmount: formatAmount(parseAmount(e.target.value)) }); clearErr(`quote-${itemIndex}-${qi}`); clearErr(`purchaseFrom-${itemIndex}`); }}
                                placeholder="金額（税込み）" style={inputStyle}
                              />
                            </div>
                            {/* 業者に一式で見積を取った場合、機器構成・工事費・送料・値引きをここに書く。
                                業者ごとに取扱いや構成が違っても、総額同士を比べられるようにするため複数行にした */}
                            <textarea
                              value={q.note} onChange={e => updateQuote(itemIndex, qi, { note: e.target.value })}
                              rows={2}
                              placeholder="内訳・条件（任意）　例：ミニハードル10本／収納袋付き／送料無料／値引き -3,000"
                              style={{ ...inputStyle, marginTop: 6, resize: 'vertical' as const }}
                            />
                            <div style={{ marginTop: 6 }}>
                              <QuoteFileUploader
                                isDarkMode={isDarkMode} userId={user.id} draftId={`${draftId}-${itemIndex}-${qi}`}
                                value={q.quoteFilePath} onChange={path => updateQuote(itemIndex, qi, { quoteFilePath: path })}
                              />
                            </div>
                          </div>
                        ))}
                      </div>
                      <button
                        type="button" onClick={() => addQuote(itemIndex)}
                        style={{ marginTop: 8, background: 'none', border: `1px dashed ${border}`, color: '#4a90d9', fontSize: 13, cursor: 'pointer', padding: '8px', width: '100%', borderRadius: 8 }}
                      >
                        ＋ 業者を追加
                      </button>
                    </div>

                    {/* 購入予定先の選択。入力（上）→選択（下）の順にすると作業の流れと画面の流れが一致する。
                        入力済みの業者だけを選択肢に出すので、空欄を選んでしまう事故が起きない */}
                    <div data-err-field={`purchaseFrom-${itemIndex}`} style={{ scrollMarginTop: 70 }}>
                      <label style={{ ...labelStyle, color: errFields.has(`purchaseFrom-${itemIndex}`) ? '#dc3545' : text }}>
                        購入予定先を選択 <span style={{ color: '#dc3545' }}>*</span>
                      </label>
                      {validQuotes(item).length === 0 ? (
                        <div style={{ fontSize: 12, color: subText, padding: '10px 12px', border: `1px dashed ${border}`, borderRadius: 8 }}>
                          上で業者名と単価を入力すると、ここで購入予定先を選べます。
                        </div>
                      ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                          {item.quotes.map((q, qi) => {
                            if (!q.vendor.trim() || !q.unitAmount.trim()) return null;
                            const unit = parseInt(parseAmount(q.unitAmount), 10);
                            const qty = item.quantity.trim() ? parseInt(parseAmount(item.quantity), 10) : NaN;
                            return (
                              <label
                                key={qi}
                                style={{
                                  display: 'flex', alignItems: 'flex-start', gap: 8, padding: '10px',
                                  border: `1px solid ${q.isSelected ? '#28a745' : (errFields.has(`purchaseFrom-${itemIndex}`) ? ERROR_BORDER : border)}`,
                                  borderRadius: 8, cursor: 'pointer', fontSize: 14, color: text,
                                  background: errFields.has(`purchaseFrom-${itemIndex}`) && !q.isSelected ? errorBg(isDarkMode) : 'transparent',
                                }}
                              >
                                <input
                                  type="radio" name={`purchase-from-${itemIndex}`} checked={q.isSelected}
                                  onChange={() => { selectQuote(itemIndex, qi); clearErr(`purchaseFrom-${itemIndex}`); clearErr(`amount-${itemIndex}`); }}
                                  style={{ marginTop: 3, flexShrink: 0 }}
                                />
                                <span>
                                  {q.vendor}
                                  <span style={{ display: 'block', fontSize: 13, color: subText }}>
                                    {isNaN(unit) ? '' : `¥${unit.toLocaleString()}`}
                                    {!isNaN(unit) && !isNaN(qty) && qty > 0 && (
                                      <> × {qty} ＝ <span style={{ fontWeight: 'bold', color: text }}>¥{(unit * qty).toLocaleString()}</span></>
                                    )}
                                    {!isNaN(unit) && isNaN(qty) && <>（単価）</>}
                                  </span>
                                </span>
                              </label>
                            );
                          })}
                        </div>
                      )}

                      {/* 1万円以上で価格比較が1社しか無い場合の逃げ道。行き止まりを作らないための仕組み */}
                      {itemQuotesRequired && validQuotes(item).length === 1 && (
                        <div style={{ marginTop: 10, padding: 10, background: warnBg, border: `1px solid ${warnBorder}`, borderRadius: 8 }}>
                          <label style={{ ...labelStyle, color: errFields.has(`singleVendor-${itemIndex}`) ? '#dc3545' : warnText }}>
                            1社しか選べない理由 <span style={{ color: '#dc3545' }}>*</span>
                          </label>
                          <div style={{ fontSize: 11, color: warnText, marginBottom: 6 }}>
                            取扱いが1社だけ・緊急で相見積もりを取れない場合は理由を書けば申請できます（理由は承認する人にも見えます）。
                          </div>
                          <input
                            data-err-field={`singleVendor-${itemIndex}`}
                            type="text" value={item.singleVendorReason}
                            onChange={e => { updateItem(itemIndex, { singleVendorReason: e.target.value }); clearErr(`singleVendor-${itemIndex}`); }}
                            placeholder="例：同規格の取扱いがこの業者のみのため"
                            style={errStyle(`singleVendor-${itemIndex}`)}
                          />
                        </div>
                      )}
                    </div>

                    <div>
                      <label style={labelStyle}>金額（見積り） <span style={{ color: '#dc3545' }}>*</span></label>
                      {item.amountManuallyOverridden ? (
                        <>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span style={{ color: text, fontSize: 16 }}>¥</span>
                            <input
                              data-err-field={`amount-${itemIndex}`}
                              type="text" inputMode="numeric" value={item.amount}
                              onChange={e => { updateItem(itemIndex, { amount: formatAmount(parseAmount(e.target.value)) }); clearErr(`amount-${itemIndex}`); }}
                              placeholder="0" style={errStyle(`amount-${itemIndex}`)}
                            />
                          </div>
                          {/* 単価×数量と違う金額にした理由。書かないと承認者が金額の根拠を追えない */}
                          <input
                            type="text" value={item.amountOverrideNote}
                            onChange={e => updateItem(itemIndex, { amountOverrideNote: e.target.value })}
                            placeholder="金額の内訳・調整理由（任意）　例：配送設置費込み／値引き後"
                            style={{ ...inputStyle, marginTop: 6 }}
                          />
                        </>
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

                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, paddingTop: 8, borderTop: `1px solid ${border}` }}>
                      {/* サイズ・色違いなど「金額の異なる内訳」は商品を分けて書く運用のため、
                          業者情報ごとコピーして品目名と数量だけ直せば済むようにする */}
                      <button
                        type="button" onClick={() => copyItem(itemIndex)}
                        style={{ background: 'none', border: 'none', color: '#4a90d9', fontSize: 12, cursor: 'pointer', padding: 0 }}
                      >
                        この商品をコピーして追加
                      </button>
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
          <div>
            <label style={labelStyle}>申請する合計金額 <span style={{ color: '#dc3545' }}>*</span></label>
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

        {/* 承認ルートのチップ。金額を決める場所の近くで「今の金額だと誰の承認になるか」を常に見せる
            （2026-07-30ユーザー承認）。色は固定＝leader緑/manager青/boardアンバー。赤はエラーと誤認するため使わない */}
        {tier !== 'none' && (() => {
          const selfJ = isSelfJudgment || (tier === 'board' && isPresident && presidentSelfJudgment);
          const routeName = selfJ ? '決裁権限内（承認不要）' : tier === 'leader' ? 'リーダー確認' : tier === 'manager' ? 'マネージャー承認' : '全員承認';
          const c = tier === 'leader'
            ? { bg: '#f0fdf4', bd: '#86efac', fg: '#166534' }
            : tier === 'manager'
              ? { bg: '#e3f2fd', bd: '#90caf9', fg: '#1565c0' }
              : { bg: '#fff8e1', bd: '#ffe082', fg: '#8a6d00' };
          return (
            <div>
              <span style={{ display: 'inline-block', padding: '4px 10px', borderRadius: 8, fontSize: 12, fontWeight: 'bold', background: c.bg, border: `1px solid ${c.bd}`, color: c.fg }}>
                承認ルート：{routeName}（{TIER_LABEL[tier]}）
              </span>
            </div>
          );
        })()}

        <div>
          <label style={labelStyle}>購入予定日 <span style={{ color: '#dc3545' }}>*</span></label>
          <input data-err-field="requestedDate" type="date" value={requestedDate} onChange={e => { setRequestedDate(e.target.value); clearErr('requestedDate'); }} style={errStyle('requestedDate')} />
        </div>

        {/* ③ 申請理由。使用先・用途（①）は商品を選ぶ前に決まっているが、
            申請理由は「何をいくらで買うか」が決まってから書いた方が具体的に書ける（2026-07-30ユーザー決定）。
            用途の直下に自由入力欄を置くと品目名と紛らわしいという指摘への対応も兼ねる */}
        <div style={{ borderTop: `1px solid ${border}`, paddingTop: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 'bold', color: text }}>③ 購入の理由</div>
        </div>

        <div>
          <label style={labelStyle}>申請理由 <span style={{ color: '#dc3545' }}>*</span></label>
          <div style={{ fontSize: 12, color: subText, marginBottom: 6 }}>
            組織として必要なコストか承認者が判断できるよう記入してください。
          </div>
          <textarea
            data-err-field="reason" value={reason} onChange={e => { setReason(e.target.value); clearErr('reason'); }} rows={2}
            placeholder="例：ロイター板が割れて、踏み切り時の安全が確保できないため交換する"
            style={{ ...inputStyle, resize: 'vertical' as const }}
          />
        </div>

        {/* 備考は理由セクションに置く。承認先を選んだあと（送信直前）に空の入力欄が現れると、
            任意欄なのに最後の関門のように見えるという指摘への対応 */}
        <div>
          <label style={labelStyle}>備考 <span style={{ color: subText, fontWeight: 'normal' }}>（任意）</span></label>
          <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} style={{ ...inputStyle, resize: 'vertical' as const }} />
        </div>

        {/* ④ 確認・承認セクションの見出し。金額が決まるまで承認関連UIが一切描画されず
            「承認は誰に頼むのか」が画面上どこにも見えない、という指摘への対応。
            未入力のうちから枠と案内を出して、この先に承認の話があることを見せる */}
        <div style={{ borderTop: `1px solid ${border}`, paddingTop: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 'bold', color: text }}>④ 確認・承認</div>
          {tier === 'none' && (
            <div style={{ fontSize: 12, color: subText, marginTop: 6, padding: '10px 12px', border: `1px dashed ${border}`, borderRadius: 8 }}>
              金額を入力すると、承認の依頼先がここに表示されます。
            </div>
          )}
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
                このまま購入する（承認不要・全マネージャーに共有）
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: text, cursor: 'pointer' }}>
                <input type="radio" checked={!presidentSelfJudgment} onChange={() => setPresidentSelfJudgment(false)} />
                全マネージャーに審議を依頼する（全員承認）
              </label>
            </div>
          </div>
        )}

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
                {/* 依頼先の選択肢は tier='leader' ならリーダー＋マネージャー、それ以外はマネージャー。
                    ラベルと実際の選択肢を必ず一致させる（以前「リーダーに依頼」と書いていたが実際は両方選べた） */}
                事前に確認してもらう（{tier === 'leader' ? 'リーダー・マネージャー' : 'マネージャー'}に依頼）
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
          <div data-err-field="leader">
            <label style={labelStyle}>
              確認を依頼するリーダー・マネージャー <span style={{ color: '#dc3545' }}>*</span>
              <span style={{ fontWeight: 'normal', color: subText }}>（{leaderIds.length}名選択中）</span>
            </label>
            <div style={{ fontSize: 12, color: subText, marginBottom: 8 }}>
              複数選べます。2名以上に依頼した場合は、依頼した全員の回答が揃ってから決定します（金額は小さいが全員に見てほしいとき）。
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, border: `2px solid ${leaderIds.length > 0 ? '#28a745' : border}`, borderRadius: 8, padding: 10 }}>
              {leaders.map(l => (
                <label key={l.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: text, cursor: 'pointer' }}>
                  <input type="checkbox" checked={leaderIds.includes(l.id)}
                    onChange={() => setLeaderIds(prev => prev.includes(l.id) ? prev.filter(x => x !== l.id) : [...prev, l.id])} />
                  {l.name}（{l.role_title}）
                </label>
              ))}
            </div>
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

      {/* 送信前の確認画面。
          金額によって承認ルート（誰が承認するか）が変わるのに、これまでは送信するまで
          確認できなかった。ここで「3万円超のため全員承認になります」を見せることで、
          金額のケタ違いや0円のような入力ミスにも気づける */}
      {showConfirm && (() => {
        const routeText = isSelfJudgment || (tier === 'board' && isPresident && presidentSelfJudgment)
          ? '決裁権限内（承認不要・購入後に共有）'
          : tier === 'leader' ? (leaderIds.length > 1 ? '確認依頼（依頼した全員の回答がそろってから決定）' : 'リーダー承認')
          : tier === 'manager' ? 'マネージャー承認（依頼した全員の回答がそろってから決定）'
          : '全員承認（全マネージャー＋社長の回答がそろってから決定）';
        const approverNames = isSelfJudgment
          ? shareCandidates.filter(m => sharedManagerIds.includes(m.id)).map(m => m.name)
          : tier === 'leader' ? leaders.filter(l => leaderIds.includes(l.id)).map(l => l.name)
          // 選択のチェックボックスは shareCandidates（マネージャー＋社長）を使っているので、
          // 名前の解決も同じ配列から行う（managers だけだと社長を選んだとき名前が消える）
          : tier === 'manager' ? shareCandidates.filter(m => requestedManagerIds.includes(m.id)).map(m => m.name)
          : (tier === 'board' && isPresident && presidentSelfJudgment) ? managers.map(m => m.name)
          : boardApprovers.map(a => a.name);
        const approverLabel = isSelfJudgment || (tier === 'board' && isPresident && presidentSelfJudgment)
          ? '共有する人' : '承認をお願いする人';
        const row = (label: string, value: React.ReactNode) => (
          <div style={{ display: 'flex', gap: 8, fontSize: 13, color: text, marginBottom: 4 }}>
            <span style={{ color: subText, flexShrink: 0, minWidth: 84 }}>{label}</span>
            <span style={{ flex: 1, wordBreak: 'break-word' }}>{value}</span>
          </div>
        );
        return (
          <div
            onClick={() => setShowConfirm(false)}
            style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 9998, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
          >
            <div onClick={e => e.stopPropagation()} style={{ background: cardBg, borderRadius: 12, padding: 18, width: '100%', maxWidth: 460, maxHeight: '85vh', overflowY: 'auto' }}>
              <div style={{ fontSize: 15, fontWeight: 'bold', color: text, marginBottom: 12, textAlign: 'center' }}>
                この内容で{isResubmit ? '再申請' : (isSelfJudgment || (tier === 'board' && isPresident && presidentSelfJudgment)) ? '共有' : '申請'}します
              </div>

              <div style={{ border: `1px solid ${border}`, borderRadius: 8, padding: 10, marginBottom: 10 }}>
                <div style={{ fontSize: 12, color: subText, marginBottom: 6 }}>商品（{items.length}件）</div>
                {items.map((item, i) => (
                  <div key={i} style={{ fontSize: 13, color: text, marginBottom: 6 }}>
                    {items.length > 1 && <span style={{ color: subText }}>[{i + 1}] </span>}
                    {item.itemName} × {item.quantity}
                    <span style={{ fontWeight: 'bold', marginLeft: 6 }}>¥{item.amount || '0'}</span>
                    <div style={{ fontSize: 12, color: subText, paddingLeft: items.length > 1 ? 16 : 0 }}>
                      {item.breakdown.trim() && <div>内訳・仕様：{item.breakdown}</div>}
                      購入予定先：{effectiveStoreName(item) || '（未選択）'}
                      {`（価格比較 ${validQuotes(item).length}社）`}
                      {quotesRequired && validQuotes(item).length < 2 && item.singleVendorReason.trim() && (
                        <div style={{ color: '#8a6d00' }}>1社しか選べない理由：{item.singleVendorReason}</div>
                      )}
                    </div>
                  </div>
                ))}
                <div style={{ textAlign: 'right', fontSize: 14, fontWeight: 'bold', color: text, borderTop: `1px solid ${border}`, paddingTop: 6 }}>
                  合計 ¥{parsedAmount.toLocaleString()}
                </div>
              </div>

              {/* 行順は入力画面の並び（使用先→用途→購入予定日→申請理由→備考）に合わせる。
                  入力順と確認順がズレると読み合わせで照合ミスが起きるため */}
              {row('使用先', location)}
              {row('用途', purpose)}
              {row('購入予定日', requestedDate)}
              {row('申請理由', reason)}
              {notes.trim() && row('備考', notes)}

              {/* ここが確認画面の主目的 */}
              <div style={{ marginTop: 10, padding: 10, borderRadius: 8, background: warnBg, border: `1px solid ${warnBorder}` }}>
                <div style={{ fontSize: 13, fontWeight: 'bold', color: warnText, marginBottom: 4 }}>
                  {TIER_LABEL[tier]}のため「{routeText}」になります
                </div>
                <div style={{ fontSize: 12, color: warnText }}>
                  {approverLabel}（{approverNames.length}名）：{approverNames.length > 0 ? approverNames.join('、') : '（未選択）'}
                </div>
              </div>

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
                  {submitting ? '送信しています...' : `この内容で${isResubmit ? '再申請' : (isSelfJudgment || (tier === 'board' && isPresident && presidentSelfJudgment)) ? '共有' : '申請'}する`}
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
};

export default PurchaseRequestForm;

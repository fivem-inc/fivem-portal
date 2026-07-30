import type { PurchaseRequestItem } from '../types';

// 明細テーブル(purchase_request_items)が0件の場合、本体列(item_name/quantity/amount/store_name/quotes)から
// 1商品分のPurchaseRequestItem配列を合成するフォールバック関数。
// 明細が1件以上あればそのまま返す（複数商品対応より前に作成された既存データ・既存画面との後方互換用）。
export function resolveItems(
  request: {
    item_name: string;
    quantity: number | null;
    amount: number;
    store_name: string | null;
    quotes: { vendor: string; amount: number; note?: string }[] | null;
  },
  items: PurchaseRequestItem[]
): PurchaseRequestItem[] {
  if (items.length > 0) return items;

  return [{
    sort_order: 0,
    item_name: request.item_name,
    quantity: request.quantity,
    amount: request.amount,
    amount_manually_overridden: false,
    store_name: request.store_name,
    // 明細テーブルより後に追加した列。旧データには存在しないので明示的にnullで埋める
    single_vendor_reason: null,
    breakdown: null,
    amount_override_note: null,
    quotes: (request.quotes ?? []).map((q, i) => ({
      vendor: q.vendor,
      unit_amount: q.amount,
      note: q.note ?? null,
      quote_file_path: null,
      is_selected: false,
      sort_order: i,
    })),
  }];
}

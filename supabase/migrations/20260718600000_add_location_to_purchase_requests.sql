-- 備品購入申請フォーム改修（複数商品対応）に伴い、「使用先」を独立した項目として追加する。
-- 既存のpurpose列（用途）とは別に、交通費申請と同じtrip_location_*マスタから選択（または
-- その他で自由入力）できる使用先を保存する列を新設する。

ALTER TABLE public.purchase_requests
  ADD COLUMN location text;

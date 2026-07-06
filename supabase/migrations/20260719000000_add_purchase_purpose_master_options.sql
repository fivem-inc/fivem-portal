-- 備品購入申請フォームの「用途」を自由入力からプルダウン選択（+その他自由入力）に変更するため、
-- master_optionsテーブルに新カテゴリ purchase_purpose を追加する。
-- master_optionsに一意制約が無いため、既に同一カテゴリ・値の行が存在する場合は挿入しない防御的なガードを入れる。

insert into public.master_options (category, value, sort_order)
select v.category, v.value, v.sort_order
from (values
  ('purchase_purpose', 'レッスン用品', 1),
  ('purchase_purpose', '清掃用品', 2),
  ('purchase_purpose', '事務用品', 3),
  ('purchase_purpose', '教材', 4),
  ('purchase_purpose', '設備・備品', 5),
  ('purchase_purpose', 'イベント', 6),
  ('purchase_purpose', 'その他', 7)
) as v(category, value, sort_order)
where not exists (
  select 1 from public.master_options m
  where m.category = v.category and m.value = v.value
);

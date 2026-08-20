-- データベースの使用量を管理画面に出すための関数
--
-- 【背景】
-- 画像（ストレージ）の使用量は get_storage_usage_mb() で管理画面に出していたが、
-- データベース本体の使用量は誰も見ていなかった。
-- 実際、cronの実行記録が115MBまで膨らみ、無料枠500MBの27%を占めていたのに
-- 気づけなかった（2026-08-20に発覚・掃除して32MBに）。
--
-- 無料プランの上限は データベース500MB／ファイル1GB と別枠なので、
-- 画像とは分けて表示する。

create or replace function public.get_database_usage_mb()
returns numeric
language sql
security definer
as $$
  select round(pg_database_size(current_database()) / 1024.0 / 1024.0, 1);
$$;

grant execute on function public.get_database_usage_mb() to authenticated;

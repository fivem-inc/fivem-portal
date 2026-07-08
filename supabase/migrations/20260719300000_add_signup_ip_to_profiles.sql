-- 新規登録時の接続元IPアドレス・国・都市を記録する列を追加
-- 承認待ちの新規登録が怪しいものかどうか、管理画面上で判断できるようにするため

alter table public.profiles
  add column if not exists signup_ip text,
  add column if not exists signup_country text,
  add column if not exists signup_city text;

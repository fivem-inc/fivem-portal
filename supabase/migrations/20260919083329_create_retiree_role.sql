-- 退職者の申請期間・2段目の手順2（2026-09-19・設計書 §8-5）
-- 退職者専用の DB の役割 retiree を作る。🚨 表・関数の権限はここでは何も付けない（初めから何も使えない）。
-- 許すもの（申請に要る表・関数・storage）は手順3で1つずつ付ける。
-- ログインの鍵（JWT）の role を retiree にするのは手順5の Hook。それまでは誰もこの役割にならない＝利用者への影響なし
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'retiree') then
    create role retiree nologin noinherit;
  end if;
end $$;
-- PostgREST（authenticator）が JWT の role に切り替えられるようにする
grant retiree to authenticator;
-- スキーマに入れるだけ（中の表・関数は何も許さない）
grant usage on schema public to retiree;
comment on role retiree is '退職者の申請期間中だけ使う役割（2026-09-19）。許したものだけ使える。付けるのは手順3の migration だけ';

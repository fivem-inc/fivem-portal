-- お客様向けFAQ：電話の受付時間を、管理画面から直せる設定にする（2026-09-17 ユーザー確定）
--
-- 背景：お客様向けFAQ（ホームページに埋め込むウィジェット）の「お答えできませんでした」の案内に、
--       四条本校の電話受付時間を出すことにした。時間はホームページのフッターにも書かれており、
--       コードに直書きすると「フッターだけ直してFAQが古いまま」になる。
--       → app_settings の 'faq_contact_phone_hours'（文字の配列・1要素＝1行）に持ち、
--         管理画面 → FAQ から管理者が直せるようにする。
--
-- 🚨 ウィジェットは**ログインなし（anon）**で動く。app_settings の読み取りは authenticated だけなので、
--    そのままでは読めない。かといって app_settings を anon に開けると、ほかの設定まで読めてしまう。
--    → **この1つの鍵だけを返す関数**を作り、anon に実行を許す。
--    🚨 ふだんは新しい関数から anon を外すのが決まりだが、これは**意図して anon に許す**もの
--       （既存の faq_public_data() と同じ扱い・同じ security definer / stable）。
--       返すのは受付時間の文字だけで、ほかの設定には触れない。
--
-- 🚨 記録を貯める仕組みではない（1行の設定）ので、掃除の cron は不要。

create or replace function public.faq_public_contact()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'phone_hours',
    coalesce(
      (select s.value
         from public.app_settings s
        where s.key = 'faq_contact_phone_hours'
          and jsonb_typeof(s.value) = 'array'),
      '[]'::jsonb
    )
  );
$$;

comment on function public.faq_public_contact() is
  'お客様向けFAQウィジェットが読む問い合わせ先の設定（いまは電話の受付時間だけ）。未ログインから呼べる。app_settings のうち faq_contact_phone_hours だけを返す';

revoke execute on function public.faq_public_contact() from public;
grant  execute on function public.faq_public_contact() to anon, authenticated;

-- 初期値：ホームページの全ページ共通フッター「ファイブM 本校 電話受付時間」（2026-09-17 時点）
insert into public.app_settings (key, value)
values ('faq_contact_phone_hours', '["月〜金 9:30〜12:15／13:15〜20:00", "土 9:30〜12:40"]'::jsonb)
on conflict (key) do nothing;

-- 社内FAQ：パソコンで、ログイン画面に戻っていたとき（2026-10-16 ユーザー確定 案3）
-- ・パソコンは最後に使ってから30日で自動ログアウト（purge_idle_pc_sessions・20261016181404）
-- ・共有のパソコン（「この端末は共有です」にチェック）は、しばらく操作しないとその時点でログアウト（lib/idleLogout）
-- 🚨 日数は管理画面「👤 ユーザー」で変えられる（app_settings 'pc_idle_session_days'）。変えたらこの文の「30日」も直すこと

begin;

insert into public.faq_topics (id, question, keywords, category, audience, is_published, sort_order)
values (
  'df2fa813-3153-4bec-90f3-62b90baf791a',
  'パソコンで、ログイン画面に戻っていました',
  array['ログアウト', 'ログイン', 'ログイン画面', '自動ログアウト', 'パソコン', '共有', '共有パソコン', '30日', 'パスワード'],
  'アカウント・通知',
  'internal',
  true,
  1080
)
on conflict (id) do nothing;

insert into public.faq_answers (id, topic_id, body, valid_from)
values (
  '17941b45-7576-4628-9ff4-61e7c2b494a1',
  'df2fa813-3153-4bec-90f3-62b90baf791a',
  $faq$会社の情報を守るため、パソコンは、最後に使ってから30日たつと自動でログアウトします。
パスワードを入れて、もう一度ログインしてください。
スマホはログアウトしません。

なお、共有のパソコン（ログイン画面で「この端末は共有です」にチェックした端末）は、しばらく操作しないと、その時点でログアウトします。$faq$,
  '2026-10-16'
)
on conflict (id) do nothing;

commit;

-- 定期リマインドの「最後の配信結果」を残す
--
-- 【なぜ必要か】配信処理はベル通知の作成に失敗しても、ログに書くだけで誰にも知らせない。
-- ログは普段誰も見ないので、実質「気づけない」状態だった。
-- 失敗を通知で知らせる案もあるが、その通知自体が失敗したらどうするのかという同じ問題が
-- 一段深いところで再発する。そこで「管理画面を開けば分かる」形にする。
--
-- 対応記録（scheduled_reminder_responses）が作れなかった場合はそもそも配信を中止するため、
-- ここに記録が残るのは「配信は行われた」ケースだけ。last_error はその中での部分的な失敗
-- （ベル通知が作れなかった／メールが一部届かなかった）を表す。

alter table public.board_scheduled_reminders
  add column if not exists last_sent_at    timestamptz,
  add column if not exists last_sent_count int,
  add column if not exists last_error      text;

comment on column public.board_scheduled_reminders.last_error is
  '最後の配信で起きた部分的な失敗。成功していれば null';

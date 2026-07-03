-- ベル通知：バッジ用の read と、リスト表示用の dismissed を分離する
alter table notifications add column if not exists dismissed boolean default false;
alter table notifications add column if not exists read_at timestamptz;

-- 既存の既読データは read_at が無いため、created_at を暫定値として入れておく
update notifications set read_at = created_at where read = true and read_at is null;

-- 既存の「既読30日で自動削除」cronジョブを read_at 基準に更新する。
-- ジョブ名が分からない場合は、まず下記で既存ジョブを確認してから unschedule すること。
-- select jobid, jobname, schedule, command from cron.job;
-- select cron.unschedule('既存のjobname');

select cron.schedule(
  'delete_old_read_notifications',
  '0 18 * * *', -- 毎日 UTC18:00 = JST 3:00
  $$
    delete from notifications
    where read = true
      and read_at < now() - interval '30 days';
  $$
);

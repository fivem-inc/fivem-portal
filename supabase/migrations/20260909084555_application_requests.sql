-- ============================================================
-- 2026-09-09  申請の依頼（上長 → スタッフ）
-- ============================================================
-- きっかけ：シフト変更の相談を受けた上長が「残業申請に書いてね」と口頭で伝えても
-- 漏れる人がいる。上長から「この内容で、いつまでに申請してね」を送れるようにする。
--
-- 🚨 既存の「残業調整の提案」（overtime_adjustment_proposals）とは目的が違う。
--    提案は「受諾した瞬間に記録ができる」もの。依頼は「本人が自分で申請する」もので、
--    本文はメモ程度（本人が書き直す前提）。混ぜると、受諾で記録ができるのか
--    自分で申請するのかが分からなくなるので、表を分ける。

create table if not exists application_requests (
  id           uuid primary key default gen_random_uuid(),
  requester_id uuid not null references auth.users(id) on delete cascade,
  recipient_id uuid not null references auth.users(id) on delete cascade,
  -- 何の申請をお願いするか
  kind         text not null check (kind in ('overtime', 'leave')),
  -- 対象日（複数可）。1日だけのことが多いが、連休の休暇もあるので配列で持つ
  target_dates date[] not null default '{}',
  -- 相談で聞いた内容のメモ。本人はこれを見ながら自分で申請を書く
  memo         text,
  -- いつまでに申請してほしいか（任意）
  due_date     date,
  -- open=未申請／applied=申請済み／dismissed=相手が「対応しない」／withdrawn=依頼者が取り下げ
  -- 🚨 open のまま残ると、ホームの案内が消えなくなる。dismissed と withdrawn を必ず用意する
  status       text not null default 'open' check (status in ('open', 'applied', 'dismissed', 'withdrawn')),
  -- 申請されたとき、その申請を指す（overtime_reports か leave_requests のID）
  linked_id    uuid,
  -- 相手が「対応しない」を選んだときの理由
  recipient_note text,
  responded_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

comment on table application_requests is
  '上長からスタッフへの「この内容で申請してください」の依頼。本人が自分で申請するためのメモで、受諾で記録ができる「提案」とは別物';
comment on column application_requests.linked_id is
  '申請されたときの申請ID（overtime_reports / leave_requests）。対象の申請が取り消されたらトリガーが status を open に戻し、ここを null にする';

create index if not exists idx_appreq_recipient on application_requests(recipient_id, status);
create index if not exists idx_appreq_requester on application_requests(requester_id, status);
create index if not exists idx_appreq_linked    on application_requests(linked_id) where linked_id is not null;

-- ------------------------------------------------------------
-- RLS
-- ------------------------------------------------------------
alter table application_requests enable row level security;

-- 見られるのは、依頼した本人・依頼された本人・管理者だけ
drop policy if exists appreq_select on application_requests;
create policy appreq_select on application_requests for select to authenticated
  using (
    requester_id = auth.uid()
    or recipient_id = auth.uid()
    or coalesce((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin', false)
  );

-- 🚨 作れるのは「申請の依頼」の権限がある役職だけ。画面側（useAuth の canApplicationRequest）と
--    同じ feature_permissions を見る。役職名をここに書かない（管理画面で変えたときに片方だけ古くなる）。
-- 🚨 requester_id は必ず自分。他人の名前で依頼を作れないようにする。
drop policy if exists appreq_insert on application_requests;
create policy appreq_insert on application_requests for insert to authenticated
  with check (
    requester_id = auth.uid()
    and (
      coalesce((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin', false)
      or exists (
        select 1 from feature_permissions fp
          join roles r on r.id = fp.role_id
          join profiles p on p.role_title = r.name
         where fp.feature_key = 'application_request'
           and fp.enabled
           and p.id = auth.uid())
    )
  );

-- 更新できるのは、依頼した本人（取り下げ）と依頼された本人（申請済み・対応しない）と管理者
drop policy if exists appreq_update on application_requests;
create policy appreq_update on application_requests for update to authenticated
  using (
    requester_id = auth.uid()
    or recipient_id = auth.uid()
    or coalesce((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin', false)
  );

-- 消せるのは管理者だけ（履歴として残す）
drop policy if exists appreq_delete on application_requests;
create policy appreq_delete on application_requests for delete to authenticated
  using (coalesce((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin', false));

-- ------------------------------------------------------------
-- 申請が取り消されたら、依頼を「未申請」に戻す
-- ------------------------------------------------------------
-- 🚨 status='applied' を保存したままにすると、紐づけた申請が取り消されたときに
--    依頼だけが「申請済み」で残り、linked_id は取消済みの行を指し続ける。
--    利用者から見ると「申請したことになっているのに申請が無い」状態になる。
--    既にある resolve_corrections_on_cancel と同じ考え方で、トリガーで追従させる。
-- 🚨 差し戻し（returned / rejected）では戻さない。同じ申請を直して再提出するため。
create or replace function reopen_application_request_on_cancel() returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.status = 'cancelled' and old.status is distinct from 'cancelled' then
    update application_requests
       set status = 'open', linked_id = null, updated_at = now()
     where linked_id = new.id and status = 'applied';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_overtime_cancel_reopen_appreq on overtime_reports;
create trigger trg_overtime_cancel_reopen_appreq after update on overtime_reports
  for each row execute function reopen_application_request_on_cancel();

drop trigger if exists trg_leave_cancel_reopen_appreq on leave_requests;
create trigger trg_leave_cancel_reopen_appreq after update on leave_requests
  for each row execute function reopen_application_request_on_cancel();

-- ------------------------------------------------------------
-- 掃除（貯める仕組みには掃除をセットで作る）
-- ------------------------------------------------------------
-- 終わった依頼は90日、返事の無い依頼は期限から60日で消す。
-- 🚨 掃除を作らないと、1件ずつは小さくても年単位で溜まる（cron の記録が130,817件・115MBまで
--    膨らんだ前例がある。無料枠に達すると DB が読み取り専用になり、申請が保存できなくなる）。
select cron.unschedule('purge-application-requests-daily')
 where exists (select 1 from cron.job where jobname = 'purge-application-requests-daily');

select cron.schedule(
  'purge-application-requests-daily',
  '40 18 * * *',   -- UTC18:40 = JST 3:40（他の掃除とずらす）
  $$
  delete from application_requests
   where (status in ('applied', 'dismissed', 'withdrawn') and updated_at < now() - interval '90 days')
      or (status = 'open' and coalesce(due_date, created_at::date) < (now() at time zone 'Asia/Tokyo')::date - interval '60 days');
  $$
);

-- ------------------------------------------------------------
-- 通知設定（新しい種類は必ず宛先ごと登録する）
-- ------------------------------------------------------------
-- 🚨 設定行が無いイベントは push-dispatch が「ON扱い」で処理する。
--    宛先は「依頼された本人ひとり」なので、送る側のコードで user_id を指定する
--    （役職での絞り込みは使わない）。ここでは ON/OFF の受け皿だけ作る。
insert into notification_settings (event_key, channel, enabled, recipient, subject, template) values
  ('application_request:received', 'site',  true,  null, null, null),
  ('application_request:received', 'push',  true,  null, null, null),
  ('application_request:received', 'email', false, null, '申請のお願いが届いています',
   E'{{依頼者}}さんから、{{対象日}}の{{種類}}について申請のお願いが届いています。\n{{期限}}\n\n下記から申請してください。\n{{リンク}}')
on conflict (event_key, channel) do nothing;

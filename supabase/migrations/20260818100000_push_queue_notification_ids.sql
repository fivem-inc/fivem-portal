-- ============================================================
-- push_queue に「元になったベル通知のID」を持たせる（プッシュ→ベル連動の土台）
-- ============================================================
-- 目的：プッシュを押したとき、そのプッシュに対応するベル通知を画面側で特定できるようにする。
--   これまではプッシュとベルが完全に別管理で、押しても「どの通知の話か」が分からなかった。
--
-- 🚨 単一列ではなく配列にする理由：
--   トリガーは「同一 user×event×reference の pending が既にあれば積まない」(dedupe) 作りなので、
--   単一列だと2件目以降のベルIDが落ちる。array_append で足していけば全件たどれる。
-- 🚨 外部キーは付けない：
--   notifications は「既読30日で削除」のcronがあり、push_queue の failed 行は永久に残る。
--   FKがあると、その削除が失敗してcronごと止まる。
-- ・トリガーの EXCEPTION 握りつぶしは維持（キュー投入の失敗でベル通知本体を巻き込まない）
-- ・何度実行しても同じ結果

alter table public.push_queue
  add column if not exists notification_ids uuid[] not null default '{}';

create or replace function enqueue_push_notification()
returns trigger
security definer
set search_path = public
language plpgsql as $$
declare
  v_existing_id uuid;
begin
  begin
    if NEW.event_key is not null
       -- プッシュを許可している（購読がある）ユーザーだけ積む
       and exists (select 1 from push_subscriptions s where s.user_id = NEW.user_id)
    then
      -- 同一ユーザー×同一イベント×同一対象の送信待ちを探す
      select q.id into v_existing_id
        from push_queue q
       where q.user_id = NEW.user_id
         and q.event_key = NEW.event_key
         and q.status = 'pending'
         and coalesce(q.reference_id, '') = coalesce(NEW.reference_id, '')
       limit 1;

      if v_existing_id is null then
        insert into push_queue (user_id, event_key, reference_id, notification_ids)
        values (NEW.user_id, NEW.event_key, NEW.reference_id, array[NEW.id]);
      else
        -- 既に送信待ちがある（＝プッシュは1通にまとめる）。ベルのIDだけ足しておく
        update push_queue
           set notification_ids = array_append(notification_ids, NEW.id)
         where id = v_existing_id;
      end if;
    end if;
  exception when others then
    -- キュー投入の失敗でベル通知本体のINSERTを巻き込まない
    null;
  end;
  return NEW;
end $$;

-- トリガー本体は既存のまま（関数の中身だけ差し替え）

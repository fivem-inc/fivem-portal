-- ============================================================
-- プッシュの「元になったベル通知のID」を積む処理を戻す（2026-09-24）
-- ============================================================
-- 🚨 何が起きていたか：
--   20260818100000 で enqueue_push_notification に notification_ids を積む処理を足したが、
--   20260826000000（受信時間帯・緊急フラグ）が **その処理を含まない古い版から起こして上書き**していた。
--   以後、push_queue.notification_ids は常に空（2026-09-24 実測：残っている133件すべて空）。
--   → push-dispatch の bell: true（押すとベルが開いて該当の通知が光る）が**一度も効いていなかった**。
--      ID が無いと url に nids / bell=1 が付かず、着地画面に着くだけになる。
--
-- 直し方：本番の実定義（＝20260826 版）を起点に、20260818 の「IDを積む」を足し戻す。
--   ・新規：notification_ids = array[NEW.id]、urgent は今までどおり
--   ・既存の送信待ちに合流：IDを array_append で足す。新規が緊急なら既存行を緊急に格上げ（今までどおり）
--   ・キュー投入の失敗でベル通知本体の INSERT を巻き込まない（今までどおり握りつぶす）
-- 🚨 この関数を次に直す人へ：**必ず本番の実定義から起こすこと**
--    （select pg_get_functiondef(p.oid) … proname='enqueue_push_notification'）。
--    ここを古い版で上書きすると、ベルとの連動が**エラーも出さずに**消える。
-- ・トリガー本体（notifications の after insert）は変えない。関数の中身だけ差し替え
-- ・何度実行しても同じ結果

create or replace function public.enqueue_push_notification()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
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
        insert into push_queue (user_id, event_key, reference_id, urgent, notification_ids)
        values (NEW.user_id, NEW.event_key, NEW.reference_id, coalesce(NEW.push_urgent, false), array[NEW.id]);
      else
        -- 既に送信待ちがある（＝プッシュは1通にまとめる）。ベルのIDを足し、
        -- 新規が緊急なら既存行を緊急に格上げする（緊急フラグの握りつぶし防止）
        update push_queue
           set notification_ids = array_append(notification_ids, NEW.id),
               urgent = urgent or coalesce(NEW.push_urgent, false)
         where id = v_existing_id;
      end if;
    end if;
  exception when others then
    -- キュー投入の失敗でベル通知本体のINSERTを巻き込まない
    null;
  end;
  return NEW;
end $function$;

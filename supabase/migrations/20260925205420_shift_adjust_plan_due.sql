-- ============================================================
-- 2026-09-25  シフト調整：案の「意見の期限」を過ぎたら、案を作った人に1回だけ知らせる（4段目）
-- ============================================================
-- 仕様は docs/計画-シフト調整.md §6-2。ベルの文面は林さんの端末で試したもの（ユーザー確認済み）：
--   見出し「🔁 9/30（火）の案1、意見の期限を過ぎました」／本文「確認 2人：森本さん・西村さん」（0人なら「確認はまだありません」）
-- ・15分ごとの見回り（毎朝のまとめの cron とは別。まとめは送る時間帯の外だとすぐ終わるため）
-- 🚨 2回送らない：対象を取るときに expired_notified_at を立て、立てた行にだけ知らせる（update … returning）
-- 🚨 対象は 未調整・調整中 の場だけ（決定・閉じた場の案はトリガーが消す。現行シフトでも消す）
-- 🚨 作った人がもう在籍していない・見る権限が無いときは送らない（印だけ立てる）
-- 🚨 管理画面「通知」でベルを OFF にしていたら送らない（印は立てる＝ON に戻したときにまとめて飛ばない）
-- 🚨 新しい関数は public・anon・authenticated から実行を外す（cron＝postgres からだけ呼ぶ）

create or replace function public.shift_adjust_notify_plan_due()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_on   boolean;
  v_sent int := 0;
  v_seen int := 0;
  r      record;
  v_names text;
  v_cnt   int;
begin
  select ns.enabled into v_on
    from notification_settings ns
   where ns.event_key = 'shift_adjust:plan_due' and ns.channel = 'site';

  for r in
    with due as (
      update shift_adjust_plans pl
         set expired_notified_at = now()
        from shift_adjust_slots s
       where s.id = pl.slot_id
         and pl.review_due_at is not null
         and pl.review_due_at < now()
         and pl.expired_notified_at is null
         and s.status in ('pending', 'working')
         and s.purged_at is null
      returning pl.id, pl.plan_no, pl.created_by, s.id as slot_id, s.target_date
    )
    select * from due
  loop
    v_seen := v_seen + 1;
    if v_on is false then continue; end if;
    if not exists (select 1 from profiles p where p.id = r.created_by and p.is_active) then continue; end if;
    if not public.user_has_feature_permission(r.created_by, 'shift_adjust_view') then continue; end if;

    select count(*), string_agg(coalesce(p.name, '（名前なし）') || 'さん', '・' order by rv.created_at)
      into v_cnt, v_names
      from shift_adjust_plan_reviews rv
      left join profiles p on p.id = rv.user_id
     where rv.plan_id = r.id;

    insert into notifications (user_id, message, sub_message, source_type, event_key, reference_id)
    values (
      r.created_by,
      '🔁 ' || public.shift_adjust_date_label(r.target_date) || 'の案' || r.plan_no::text || '、意見の期限を過ぎました',
      case when coalesce(v_cnt, 0) = 0 then '確認はまだありません' else '確認 ' || v_cnt::text || '人：' || v_names end,
      'shift_adjust:plan_due',
      'shift_adjust:plan_due',
      r.slot_id
    );
    v_sent := v_sent + 1;
  end loop;

  return jsonb_build_object('ok', true, 'due', v_seen, 'sent', v_sent);
end $$;
revoke execute on function public.shift_adjust_notify_plan_due() from public;
revoke execute on function public.shift_adjust_notify_plan_due() from anon;
revoke execute on function public.shift_adjust_notify_plan_due() from authenticated;

-- 15分ごと（何度流しても1つ）
select cron.unschedule('shift-adjust-plan-due')
 where exists (select 1 from cron.job where jobname = 'shift-adjust-plan-due');
select cron.schedule('shift-adjust-plan-due', '*/15 * * * *', $cron$select public.shift_adjust_notify_plan_due();$cron$);

-- 戻し版（この migration を取り消すとき）:
--   select cron.unschedule('shift-adjust-plan-due');
--   drop function public.shift_adjust_notify_plan_due();

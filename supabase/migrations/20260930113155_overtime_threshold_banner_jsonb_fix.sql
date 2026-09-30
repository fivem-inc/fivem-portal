-- 2026-09-30  残業の目安超えのホームのバナーが、誰にも出ていなかった不具合を直す
--
-- overtime_threshold_banner() が overtime_settings.banner_group_names（jsonb）を text[] の変数へそのまま入れていて、
-- 呼ぶたびに「malformed array literal」で失敗していた。画面（OvertimeThresholdBanner）は失敗したら何も出さない作りのため、
-- 本人向け・上長向けとも、オレンジのバナーが1度も出ていなかった（お知らせのベル・プッシュ・メールは別の経路なので届いていた）。
-- 本番の実定義（pg_get_functiondef・2026-09-30）から起こし、変えたのは部門の読み方の1行だけ。
-- 引数・戻り値は同じなので create or replace のみ（権限はそのまま残る）。

CREATE OR REPLACE FUNCTION public.overtime_threshold_banner(p_period date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_viewer     uuid := auth.uid();
  v_rank       integer;
  v_teams      text[];
  v_my_teams   text[];
  v_org_wide   boolean := false;
  v_role       text;
  v_last_sent  timestamptz;
  v_self       jsonb := null;
  v_members    jsonb := '[]'::jsonb;
  v_recipient  text;
begin
  if v_viewer is null then return jsonb_build_object('self', null, 'members', '[]'::jsonb); end if;

  select role_title into v_role from profiles where id = v_viewer;
  v_rank := overtime_role_rank(v_viewer);

  -- 部門として扱うグループ（管理画面で選んだもの）と、自分が属する部門
  -- 🚨 banner_group_names は jsonb（["こども","大人",…]）。text[] にそのまま入れると
  --    「malformed array literal」で関数ごと失敗し、ホームのバナーが誰にも出ていなかった（2026-09-30 発見）
  select array(select jsonb_array_elements_text(coalesce(banner_group_names, '[]'::jsonb)))
    into v_teams from overtime_settings where id = 1;
  select array(select unnest(coalesce(group_names, '{}'::text[]))
               intersect select unnest(coalesce(v_teams, '{}'::text[])))
    into v_my_teams from profiles where id = v_viewer;

  -- 通知設定の「絞り込みの対象外にする役職」に自分の役職が入っていれば全部門を見る
  select recipient into v_recipient from notification_settings
   where event_key = 'overtime:threshold' and channel = 'site';
  if v_recipient is not null and v_role is not null then
    v_org_wide := (v_recipient::jsonb -> 'orgWideRoles') ? v_role;
  end if;

  -- 直近の配信時刻（これより後に閉じたバナーは出さない）
  select max(created_at) into v_last_sent
    from overtime_threshold_notifications where pay_period_start = p_period;

  -- 自分の分
  select jsonb_build_object(
           'total', o.total_minutes,
           'confirmed', o.confirmed_minutes,
           'threshold', o.threshold_minutes)
    into v_self
    from overtime_threshold_over(p_period) o
   where o.user_id = v_viewer
     and not exists (
       select 1 from overtime_banner_dismissals d
        where d.user_id = v_viewer and d.target_user_id = v_viewer
          and d.pay_period_start = p_period
          and (
            (d.remind_after is not null and d.remind_after > now())
            or (d.remind_after is null and v_last_sent is not null
                and d.dismissed_at is not null and d.dismissed_at >= v_last_sent)
          )
     );

  -- 部下の分（部門集計を見られる権限がある人だけ）
  if has_feature_permission('overtime_summary') or
     (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin' then
    select coalesce(jsonb_agg(
             jsonb_build_object(
               'user_id', x.user_id,
               'name', x.name,
               'team', x.team,
               'total', x.total_minutes,
               'prev', x.prev_total,
               'is_new', x.prev_total is null
             ) order by x.total_minutes desc), '[]'::jsonb)
      into v_members
      from (
        select o.user_id, p.name, o.total_minutes,
               (select array_to_string(array(
                  select unnest(coalesce(p.group_names, '{}'::text[]))
                  intersect select unnest(coalesce(v_teams, '{}'::text[]))
                ), '・')) as team,
               (select n.total_minutes from overtime_threshold_notifications n
                 where n.user_id = o.user_id and n.pay_period_start = p_period
                   and n.kind = 'scheduled'
                 order by n.created_at desc offset 1 limit 1) as prev_total
          from overtime_threshold_over(p_period) o
          join profiles p on p.id = o.user_id
         where o.user_id <> v_viewer
           and overtime_role_rank_target(o.user_id) >= v_rank
           and (v_org_wide or coalesce(p.group_names, '{}'::text[]) && coalesce(v_my_teams, '{}'::text[]))
           and not exists (
             select 1 from overtime_banner_dismissals d
              where d.user_id = v_viewer and d.target_user_id = o.user_id
                and d.pay_period_start = p_period
                and (
                  (d.remind_after is not null and d.remind_after > now())
                  or (d.remind_after is null and v_last_sent is not null
                      and d.dismissed_at is not null and d.dismissed_at >= v_last_sent)
                )
           )
      ) x;
  end if;

  return jsonb_build_object(
    'self', v_self,
    'members', v_members,
    'last_sent', v_last_sent
  );
end;
$function$;

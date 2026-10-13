-- 10/14 12:00（JST）に、残業申請の公開と 10/16 の切り替えの案内をまとめて出す予約（2026-10-13 ユーザー確定）
-- ・今夜：区切りの日（overtime_unify_cutoff）を空にし、休暇申請の案内・止めをいったん隠す。社内FAQ の新しい版も下書きに戻す
-- ・10/14 12:00 JST（03:00 UTC）に1回だけ動く cron（overtime-open-20261014）：
--     ①残業申請の権限を一般・フロア責任者にもオン（feature_permissions）②全員に公開（feature_published.overtime=true）
--     ③区切りの日 2026-10-16 を入れる ④社内FAQ を新しい版に切り替え・時間調整タブの質問を公開
--     終わったら予約は自分で消える。🚨 日付が 2026-10-14（JST）でなければ何もしない（来年の同じ日に動かないための守り）
-- ・ID は 2026-10-13 に本番で確かめたもの（役職名では引かない）
begin;

-- ── 今夜：いったん隠す
update public.app_settings set value = 'null'::jsonb, updated_at = now() where key = 'overtime_unify_cutoff';
update public.faq_answers set valid_from = null, updated_at = now()
 where id in ('7d5ad62c-911c-4535-881d-234a3d5edd0c', '141a76e9-862b-402c-8dce-567d88073eaa', '00c7e542-d068-455b-a622-cb75385e5bb5',
              '5b91e0e9-ec5b-4d3e-b9a9-792009e5dae2', '53c8ceff-baf0-49d3-9cb4-1e609f347d32');
update public.faq_answers set valid_until = null, updated_at = now()
 where id in ('0ed12d96-ba68-4c5e-be12-5e2826d05f5e', 'ced7df7c-e9e5-4b31-aece-f042db2f5d3c', '7b29507f-b4d2-419f-a831-1d9c9207afe3',
              'a081d319-9e77-459a-91bb-5bba726cd871', 'fa4ad670-aad5-4a8a-910d-971d283f021a');
update public.faq_topics set is_published = false
 where id = (select topic_id from public.faq_answers where id = 'a081d319-9e77-459a-91bb-5bba726cd871');

-- ── 明日 12:00 にまとめて出す
create or replace function public.overtime_open_20261014()
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if (now() at time zone 'Asia/Tokyo')::date <> date '2026-10-14' then
    return;
  end if;
  -- ① 残業申請の権限：一般・フロア責任者
  update feature_permissions set enabled = true, updated_at = now()
   where id in ('8bd7a94b-5131-4346-b3e4-5ff0691f3b95', '5b9c282b-cb9e-40bb-a8bf-bad92e70df87');
  -- ② 全員に公開
  update app_settings set value = jsonb_set(value, '{overtime}', 'true'::jsonb), updated_at = now()
   where key = 'feature_published';
  -- ③ 区切りの日
  insert into app_settings (key, value, updated_at) values ('overtime_unify_cutoff', '"2026-10-16"'::jsonb, now())
  on conflict (key) do update set value = excluded.value, updated_at = now();
  -- ④ 社内FAQ を新しい版に
  update faq_answers set valid_until = '2026-10-13', updated_at = now()
   where id in ('0ed12d96-ba68-4c5e-be12-5e2826d05f5e', 'ced7df7c-e9e5-4b31-aece-f042db2f5d3c', '7b29507f-b4d2-419f-a831-1d9c9207afe3',
                'a081d319-9e77-459a-91bb-5bba726cd871', 'fa4ad670-aad5-4a8a-910d-971d283f021a');
  update faq_answers set valid_from = '2026-10-14', updated_at = now()
   where id in ('7d5ad62c-911c-4535-881d-234a3d5edd0c', '141a76e9-862b-402c-8dce-567d88073eaa', '00c7e542-d068-455b-a622-cb75385e5bb5',
                '5b91e0e9-ec5b-4d3e-b9a9-792009e5dae2', '53c8ceff-baf0-49d3-9cb4-1e609f347d32');
  update faq_topics set is_published = true
   where id = (select topic_id from faq_answers where id = 'a081d319-9e77-459a-91bb-5bba726cd871');
end;
$function$;
revoke execute on function public.overtime_open_20261014() from public;
revoke execute on function public.overtime_open_20261014() from anon;
revoke execute on function public.overtime_open_20261014() from authenticated;

select cron.unschedule('overtime-open-20261014') where exists (select 1 from cron.job where jobname = 'overtime-open-20261014');
select cron.schedule('overtime-open-20261014', '0 3 14 10 *',
  $cron$select public.overtime_open_20261014(); select cron.unschedule('overtime-open-20261014');$cron$);

commit;

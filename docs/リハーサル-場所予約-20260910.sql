-- ============================================================
-- 場所予約：本番に流す前の確認（2026-09-10）
--   対象の migration
--     supabase/migrations/20260910105837_room_can_see_contacts_null.sql
--     supabase/migrations/20260910105920_room_basic_settings_role_ids.sql
--
-- 🚨 このファイルは本番を1行も変えません。
--    【手順1】は読むだけ。【手順2】は当ててから rollback で取り消します。
--
-- 使い方：Supabase の SQL Editor に【手順1】だけを貼って実行 → 結果を確認。
--         そのあと【手順2】だけを貼って実行 → エラーが出なければ合格。
--         （【手順2】は合否をエラーの有無で知らせます。表は出ません）
-- ============================================================


-- ============================================================
-- 【手順1】読むだけの事前確認（1つの表で全部出ます）
-- ============================================================
with allowed_names as (
  -- 🚨 配列そのものを CTE に置くと `= any ((select …))` が
  --    「副問い合わせの any」と解釈されて型が合わない。文字列で持ち、使う側で配列にする
  select coalesce((select value from room_settings where key = 'basic_settings_roles'),
                  '一般,リーダー,フロア責任者,マネージャー,社長,管理者') as csv
),
before_can as (
  select p.id, p.role_title, p.employment_type,
         (coalesce(p.employment_type, '') <> 'パート'
          and coalesce(p.role_title, '') = any (
            string_to_array((select csv from allowed_names), ','))) as can
    from profiles p
),
after_ids as (
  select coalesce(
           (select string_agg(r.id::text, ',' order by r.sort_order)
              from roles r
             where r.name = any (
               string_to_array((select csv from allowed_names), ','))), '') as ids
),
after_can as (
  select p.id,
         (coalesce(p.employment_type, '') <> 'パート'
          and p.role_id is not null
          and p.role_id::text = any (string_to_array((select ids from after_ids), ','))) as can
    from profiles p
)
select * from (
  select 1 as no, '① 連絡先の公開範囲（contact_visibility）' as 確認すること,
         coalesce((select value from room_settings where key = 'contact_visibility'),
                  '(行なし＝staff として扱われる)') as いまの値
  union all
  select 2, '② role_id が空の人（🚨 0 でなければ流さない）',
         (select count(*)::text from profiles where role_id is null)
  union all
  select 3, '③ いまの basic_settings_roles（役職名）',
         coalesce((select value from room_settings where key = 'basic_settings_roles'),
                  '(行なし＝既定値が使われている)')
  union all
  select 4, '④ 移したあとの一覧（id を役職名に戻して表示・③と同じなら正しい）',
         coalesce((select string_agg(r.name, ',' order by r.sort_order) from roles r
                    where r.id::text = any (string_to_array((select ids from after_ids), ','))), '(空)')
  union all
  select 5, '⑤ いま基本設定を使える人数',
         (select (count(*) filter (where can))::text from before_can)
  union all
  select 6, '⑥ 移したあとに使える人数（⑤と同じであること）',
         (select (count(*) filter (where can))::text from after_can)
  union all
  select 7, '⑦ 🚨 判定が変わる人の数（0 でなければ流さない）',
         (select count(*)::text from before_can b join after_can a using (id)
           where b.can is distinct from a.can)
  union all
  select 8, '⑧ 変わる人の内訳（⑦が0なら「なし」）',
         coalesce((select string_agg(distinct b.role_title || '／' || coalesce(b.employment_type, '未設定'), '、')
                     from before_can b join after_can a using (id)
                    where b.can is distinct from a.can), 'なし')
) t order by no;


-- ============================================================
-- 【手順2】試して取り消す（当ててから rollback）
--   🚨 エラーが出なければ合格。エラーが出たら、その内容が理由です。
--   🚨 最後の rollback で、当てたものは全部消えます。
-- ============================================================
begin;

-- 🚨 移す前の判定を控えるための一時テーブルは**作らない**。
--    SQL Editor が create table を見て「RLSが無い」と警告を出すため（一時テーブルへの誤検知）。
--    移す前の判定は role_title と旧キー basic_settings_roles だけで決まり、
--    どちらもこの migration では変わらないので、当てたあとに計算しても同じ結果になる。

-- ---- migration 1本目 ----
create or replace function room_can_see_contacts() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(
    case coalesce((select value from room_settings where key = 'contact_visibility'), 'staff')
      when 'all'   then auth.uid() is not null
      when 'admin' then (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
      else room_is_staff()
    end, false);
$$;

-- ---- migration 2本目 ----
insert into room_settings (key, value, updated_at)
select
  'basic_settings_role_ids',
  coalesce(
    (select string_agg(r.id::text, ',' order by r.sort_order)
       from roles r
      where r.name = any (
        string_to_array(
          coalesce((select value from room_settings where key = 'basic_settings_roles'),
                   '一般,リーダー,フロア責任者,マネージャー,社長,管理者'),
          ','))),
    ''),
  now()
where not exists (select 1 from room_settings where key = 'basic_settings_role_ids');

create or replace function room_can_use_basic_settings() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(case
    when (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin' then true
    when not room_is_staff() then false
    when (select value from room_settings where key = 'basic_settings_role_ids') is null then true
    else exists (
      select 1 from profiles p
       where p.id = auth.uid()
         and p.role_id is not null
         and p.role_id::text = any (
           string_to_array(
             (select value from room_settings where key = 'basic_settings_role_ids'), ','))
    )
  end, false);
$$;

-- ---- 検算（合わなければ、ここで止まります） ----
do $$
declare
  v_diff int;
  v_null int;
  v_ret  boolean;
begin
  select count(*) into v_null from profiles where role_id is null;
  if v_null <> 0 then
    raise exception '🚨 role_id が空の人が % 人います。この人たちは基本設定を使えなくなります。流さないでください', v_null;
  end if;

  -- 移す前（役職名で判定）と、移したあと（role_id で判定）を、1人ずつ突き合わせる
  select count(*) into v_diff
    from profiles p
   where
     -- 移す前の判定
     (coalesce(p.employment_type, '') <> 'パート'
      and coalesce(p.role_title, '') = any (
        string_to_array(
          coalesce((select value from room_settings where key = 'basic_settings_roles'),
                   '一般,リーダー,フロア責任者,マネージャー,社長,管理者'), ',')))
     is distinct from
     -- 移したあとの判定
     (coalesce(p.employment_type, '') <> 'パート'
      and p.role_id is not null
      and p.role_id::text = any (
        string_to_array(
          (select value from room_settings where key = 'basic_settings_role_ids'), ',')));
  if v_diff <> 0 then
    raise exception '🚨 基本設定を使える／使えないが変わる人が % 人います。流さないでください', v_diff;
  end if;

  v_ret := room_can_see_contacts();
  if v_ret is null then
    raise exception '🚨 room_can_see_contacts() がまだ NULL を返しています';
  end if;

  if not exists (select 1 from room_settings where key = 'basic_settings_roles') then
    raise exception '🚨 旧キー basic_settings_roles が消えています（戻せなくなります）';
  end if;

  raise notice '✅ 合格：判定が変わる人は0人、room_can_see_contacts() は % を返しました', v_ret;
end $$;

-- ---- 取り消す ----
rollback;

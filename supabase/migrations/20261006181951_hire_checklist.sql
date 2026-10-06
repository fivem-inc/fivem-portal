-- 入社の確認のチェック表（2026-10-06 ユーザー確定）。退職の確認（retire_checklist_*・retire_notes）と同じ作り。
--
-- 決まったこと：
--   ・項目17個（下の初期値）。管理者が画面で足す・直す・隠す・消す
--   ・見る・済みにする＝マネージャー以上と管理者（退職と同じ）
--   ・対象＝入社日（profiles.hire_date）が入っている人。全部済めば一覧から消える（「すべて済んだ方も表示」で見られる）
--   ・画面は退職の確認と同じ部品で［入社］［退職］を切り替える（/retire?tab=hire）
--   ・お知らせ：登録したとき（ベルだけ）／入社日の 7・3・1 日前の朝9時（残りがあるときだけ・ベルとスマホ）／
--     入社日の朝9時「今日入社」（必ず1回・ベルとスマホ）。何日前・時刻・オンオフ・宛先は管理画面で変えられる
--   ・🚨 これまで入社日の 0:01（hire_daily）に出ていた「今日から使えます」のベルは、朝9時の「今日入社」にまとめた
--
-- 🚨 退職の表には手を入れない（動いている退職の確認を巻き込まない）。表は別、画面の部品は1つ。
-- 🚨 hire_daily・notify_first_login は本番の pg_get_functiondef（2026-10-06 取得）から起こした。
-- 🚨 通知の送った記録（hire_notify_log）は、同じ関数の中で 400 日より古い行を消す（記録を貯める仕組みには掃除を付ける）。

begin;

-- ════════════════════════════════════════════════════════════
-- 1. 項目
-- ════════════════════════════════════════════════════════════
create table if not exists public.hire_checklist_items (
  id uuid primary key default gen_random_uuid(),
  label text not null check (length(btrim(label)) > 0),
  required boolean not null default true,
  sort_order integer not null default 0,
  active boolean not null default true,
  -- 択一で答える項目の選択肢（退職と同じ。null＝ふつうのチェック）
  choices text[],
  -- 自動で「済み」になる項目。first_login＝本人が初めてログインしたとき（notify_first_login が記録する）
  auto_key text check (auto_key is null or auto_key in ('first_login')),
  created_at timestamptz not null default now()
);
create unique index if not exists hire_checklist_items_auto_key_uniq on public.hire_checklist_items (auto_key) where auto_key is not null;
alter table public.hire_checklist_items enable row level security;
drop policy if exists hire_checklist_items_select on public.hire_checklist_items;
create policy hire_checklist_items_select on public.hire_checklist_items
  for select to authenticated using (is_manager_plus());
drop policy if exists hire_checklist_items_write on public.hire_checklist_items;
create policy hire_checklist_items_write on public.hire_checklist_items
  for all to authenticated using (is_admin()) with check (is_admin());
comment on table public.hire_checklist_items is '入社の確認の項目（2026-10-06）。見る＝マネージャー以上、直す＝管理者';

-- 初期値（2026-10-06 ユーザー確定・すべて必須）。すでに行があれば入れない
insert into public.hire_checklist_items (label, required, sort_order, auto_key)
select v.label, true, v.ord, v.auto
from (values
  ('同意書を印刷して、サインをもらった', 10, null),
  ('契約書を印刷して、本人に渡した', 20, null),
  ('サインした契約書（会社用の1部）が返ってきた', 30, null),
  ('返ってきた契約書を会社で保管した', 40, null),
  ('履歴書を、人事から経理に渡した', 50, null),
  ('入社書類を受け取った（マイナンバー・扶養控除の申告書・振込口座・通勤経路）', 60, null),
  ('社会保険・雇用保険の加入の手続きをした', 70, null),
  ('給与の登録をした', 80, null),
  ('制服を用意した', 90, null),
  ('名札を作った', 100, null),
  ('鍵・備品を渡した', 110, null),
  ('初回の説明をした', 120, null),
  ('勤務表（シフト）に入れた', 130, null),
  ('掃除担当表に入れた', 140, null),
  ('Slack に招待した', 150, null),
  ('Google カレンダーを共有した', 160, null),
  ('アプリに初めてログインした', 170, 'first_login')
) as v(label, ord, auto)
where not exists (select 1 from public.hire_checklist_items);

-- ════════════════════════════════════════════════════════════
-- 2. 済み・対象外の記録（行がある＝片付いた。退職と同じ）
-- ════════════════════════════════════════════════════════════
create table if not exists public.hire_checklist_checks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  -- 🚨 項目を消しても記録を残すため set null（何の記録だったかは item_label で分かる）
  item_id uuid references public.hire_checklist_items(id) on delete set null,
  item_label text,
  choice text,
  na boolean not null default false,
  -- 🚨 null＝自動で済みになった（初めてのログイン）か、押した人が削除された
  done_by uuid references public.profiles(id) on delete set null default auth.uid(),
  done_at timestamptz not null default now(),
  unique (user_id, item_id)
);
create index if not exists hire_checklist_checks_user_idx on public.hire_checklist_checks (user_id);
alter table public.hire_checklist_checks enable row level security;
drop policy if exists hire_checklist_checks_select on public.hire_checklist_checks;
create policy hire_checklist_checks_select on public.hire_checklist_checks
  for select to authenticated using (is_manager_plus());
-- 🚨 済みにできるのは「入社日が入っている人」だけ・done_by は自分
drop policy if exists hire_checklist_checks_insert on public.hire_checklist_checks;
create policy hire_checklist_checks_insert on public.hire_checklist_checks
  for insert to authenticated
  with check (
    is_manager_plus()
    and done_by = auth.uid()
    and exists (select 1 from public.profiles p where p.id = user_id and p.hire_date is not null)
  );
drop policy if exists hire_checklist_checks_delete on public.hire_checklist_checks;
create policy hire_checklist_checks_delete on public.hire_checklist_checks
  for delete to authenticated using (is_manager_plus());
comment on table public.hire_checklist_checks is '入社の確認の済み・対象外の記録。行がある＝片付いた（na=true は対象外）';

-- ════════════════════════════════════════════════════════════
-- 3. メモ（🚨 チェックの記録とは別の表。同じ表だと「メモを書いただけで残りが減る」）
-- ════════════════════════════════════════════════════════════
create table if not exists public.hire_notes (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  item_id    uuid references public.hire_checklist_items(id) on delete set null,
  item_label text,
  memo       text not null check (length(btrim(memo)) > 0),
  updated_by uuid references public.profiles(id) on delete set null default auth.uid(),
  updated_at timestamptz not null default now(),
  unique (user_id, item_id)
);
create unique index if not exists hire_notes_overall_uniq
  on public.hire_notes (user_id) where item_id is null and item_label is null;
create index if not exists hire_notes_user_idx on public.hire_notes (user_id);
alter table public.hire_notes enable row level security;
drop policy if exists hire_notes_select on public.hire_notes;
create policy hire_notes_select on public.hire_notes
  for select to authenticated using (is_manager_plus());
drop policy if exists hire_notes_write on public.hire_notes;
create policy hire_notes_write on public.hire_notes
  for all to authenticated
  using (is_manager_plus())
  with check (
    is_manager_plus()
    and updated_by = auth.uid()
    and exists (select 1 from public.profiles p where p.id = user_id and p.hire_date is not null)
  );
comment on table public.hire_notes is '入社の確認のメモ（項目ごと・削除された項目・その方ぜんたい）。チェックの記録とは別の表';

revoke all on public.hire_checklist_items, public.hire_checklist_checks, public.hire_notes from anon;
grant select, insert, update, delete on public.hire_checklist_items, public.hire_checklist_checks, public.hire_notes to authenticated;
grant all on public.hire_checklist_items, public.hire_checklist_checks, public.hire_notes to service_role;

-- ════════════════════════════════════════════════════════════
-- 4. 通知の送った記録（同じ日に二重に送らないため）。🚨 掃除は hire_checklist_notify の中で行う
-- ════════════════════════════════════════════════════════════
create table if not exists public.hire_notify_log (
  user_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null check (kind in ('remind', 'hired')),
  on_date date not null,
  sent_at timestamptz not null default now(),
  primary key (user_id, kind, on_date)
);
alter table public.hire_notify_log enable row level security;  -- ポリシー無し＝画面からは読めない・書けない
revoke all on public.hire_notify_log from anon, authenticated;
comment on table public.hire_notify_log is '入社の確認のお知らせを送った記録（同じ日の二重送信を防ぐ）。400日より古い行は hire_checklist_notify が消す';

-- ════════════════════════════════════════════════════════════
-- 5. 宛先の設定・何日前の設定
-- ════════════════════════════════════════════════════════════
insert into public.notification_settings (event_key, channel, enabled, recipient) values
  ('hire:registered', 'site',  true,  '{"roles":["マネージャー","社長","管理者"],"groupFilter":"all"}'),
  ('hire:registered', 'push',  false, null),
  ('hire:registered', 'email', false, null),
  ('hire:registered', 'slack', false, null),
  ('hire:remind',     'site',  true,  '{"roles":["マネージャー","社長","管理者"],"groupFilter":"all"}'),
  ('hire:remind',     'push',  true,  null),
  ('hire:remind',     'email', false, null),
  ('hire:remind',     'slack', false, null)
on conflict (event_key, channel) do nothing;
-- 「今日入社」（staff:hired）はスマホにも送る（2026-10-06 ユーザー確定）
update public.notification_settings set enabled = true, updated_at = now()
 where event_key = 'staff:hired' and channel = 'push';

insert into public.reminder_days_settings (event_key, days_before, send_hour, send_minute)
values ('hire_checklist_notify', array[7, 3, 1], 9, 0)
on conflict (event_key) do nothing;

-- ════════════════════════════════════════════════════════════
-- 6. 入社予定の人を登録したとき（入社日が初めて入ったとき）にベル
-- ════════════════════════════════════════════════════════════
create or replace function public.notify_hire_registered()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_items integer;
begin
  if new.hire_date is not null
     and (tg_op = 'INSERT' or old.hire_date is null)
     and coalesce(new.is_active, false) = false
     and new.retired_at is null
     and new.hire_date >= (now() at time zone 'Asia/Tokyo')::date then
    select count(*) into v_items from hire_checklist_items where active and required;
    perform public.notify_event('hire:registered', array[new.id],
      format('👤 入社予定：%sさん（%s 入社）', regexp_replace(coalesce(new.name, ''), '[[:space:]　]+', ' ', 'g'),
             to_char(new.hire_date, 'FMMM/FMDD')),
      format('入社の準備を始めてください（確認 %s件）', v_items),
      'hire:registered', auth.uid(), auth.uid());
  end if;
  return new;
exception when others then
  return new;   -- 🚨 通知の失敗で登録を止めない
end;
$function$;
revoke execute on function public.notify_hire_registered() from public, anon, authenticated;

drop trigger if exists trg_profiles_hire_registered on public.profiles;
create trigger trg_profiles_hire_registered
  after insert or update of hire_date on public.profiles
  for each row execute function public.notify_hire_registered();

-- ════════════════════════════════════════════════════════════
-- 7. 入社日の切り替え（本番の版から、0:01 のベルだけを外した。ベルは朝9時の「今日入社」へ）
-- ════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.hire_daily()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  r record;
  v_count integer := 0;
begin
  for r in
    select id, name from profiles
     where is_active = false
       and hire_date is not null
       and hire_date <= (now() at time zone 'Asia/Tokyo')::date
       and retired_at is null
       and retire_date is null
       and coalesce(approval_status, '') <> 'pending'
  loop
    -- 🚨 1人ずつ失敗を受け止める（retire_daily と同じ）。失敗した人は入社予定のまま残り、管理画面に「切り替えに失敗」と出る
    begin
      update profiles set is_active = true, approval_status = 'approved' where id = r.id;
      v_count := v_count + 1;
      -- 🚨 2026-10-06：ここで出していた「今日から使えます」のベルは、夜中 0:01 に届いて見えたため外した。
      --    朝9時の hire_checklist_notify が「今日入社」として送る
    exception when others then
      raise warning '[hire_daily] % の在籍への切り替えに失敗しました: %', r.id, sqlerrm;
    end;
  end loop;
  return v_count;
end;
$function$;

-- ════════════════════════════════════════════════════════════
-- 8. 初めてのログイン（本番の版に、入社の確認の自動の項目を「済み」にする処理を足した）
-- ════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.notify_first_login()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_name text;
begin
  if old.last_sign_in_at is null and new.last_sign_in_at is not null then
    select name into v_name from profiles where id = new.id and hire_date is not null;
    if found then
      -- 入社の確認「アプリに初めてログインした」を自動で済みにする（2026-10-06）。done_by は null＝自動
      insert into hire_checklist_checks (user_id, item_id, item_label, done_by)
      select new.id, i.id, i.label, null from hire_checklist_items i where i.auto_key = 'first_login'
      on conflict (user_id, item_id) do nothing;
      perform public.notify_event('staff:first_login', array[new.id],
        format('👤 %sさんが初めてログインしました', regexp_replace(coalesce(v_name, ''), '[[:space:]　]+', ' ', 'g')),
        null, 'staff:first_login', new.id, null);
    end if;
  end if;
  return new;
exception when others then
  return new;   -- 🚨 通知の失敗でログインを止めない
end;
$function$;

-- すでに初めてのログインを済ませた入社の人（この変更より前）を、自動の項目で済みにしておく
insert into public.hire_checklist_checks (user_id, item_id, item_label, done_by, done_at)
select p.id, i.id, i.label, null, coalesce(u.last_sign_in_at, now())
  from public.profiles p
  join auth.users u on u.id = p.id
  cross join public.hire_checklist_items i
 where i.auto_key = 'first_login'
   and p.hire_date is not null
   and u.last_sign_in_at is not null
on conflict (user_id, item_id) do nothing;

-- ════════════════════════════════════════════════════════════
-- 9. 朝のお知らせ（5分ごとに動き、送る時刻を過ぎていて、その日まだ送っていない人にだけ送る）
-- ════════════════════════════════════════════════════════════
create or replace function public.hire_checklist_notify()
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_now timestamp := now() at time zone 'Asia/Tokyo';
  v_today date := (now() at time zone 'Asia/Tokyo')::date;
  v_days int[];
  v_hour int;
  v_minute int;
  r record;
  v_d integer;
  v_rest text;
  v_sent integer := 0;
  v_ins integer;
begin
  select days_before, send_hour, send_minute into v_days, v_hour, v_minute
    from reminder_days_settings where event_key = 'hire_checklist_notify';
  v_days := coalesce(v_days, array[7, 3, 1]);
  -- 送る時刻より前なら何もしない
  if v_now < v_today + make_time(coalesce(v_hour, 9), coalesce(v_minute, 0), 0) then
    return 0;
  end if;

  -- 掃除（記録を貯める仕組みには掃除を付ける）
  delete from hire_notify_log where on_date < v_today - 400;

  for r in
    select p.id, p.name, p.hire_date,
           (select count(*) from hire_checklist_items i
             where i.active and i.required
               and not exists (select 1 from hire_checklist_checks c where c.user_id = p.id and c.item_id = i.id)) as remaining,
           (select string_agg(i.label, '・' order by i.sort_order) from (
              select i2.label, i2.sort_order from hire_checklist_items i2
               where i2.active and i2.required
                 and not exists (select 1 from hire_checklist_checks c where c.user_id = p.id and c.item_id = i2.id)
               order by i2.sort_order limit 3) i) as first3
      from profiles p
     where p.hire_date is not null
       and p.hire_date >= v_today
       and p.hire_date <= v_today + 31
       and p.retired_at is null
       and p.retire_date is null
       and coalesce(p.approval_status, '') <> 'pending'
  loop
    v_d := r.hire_date - v_today;
    v_rest := case when r.remaining > 3 then r.first3 || ' ほか' else r.first3 end;
    begin
      if v_d = 0 then
        -- 入社日の朝：必ず1回（全部済んでいても「今日入社」を知らせる）
        insert into hire_notify_log (user_id, kind, on_date) values (r.id, 'hired', v_today) on conflict do nothing;
        get diagnostics v_ins = row_count;
        if v_ins > 0 then
          v_sent := v_sent + public.notify_event('staff:hired', array[r.id],
            format('👤 今日入社：%sさん', regexp_replace(coalesce(r.name, ''), '[[:space:]　]+', ' ', 'g')),
            case when r.remaining > 0 then format('入社の確認が残り %s件：%s', r.remaining, v_rest)
                 else '入社の確認はすべて済んでいます' end,
            'staff:hired', null, null);
        end if;
      elsif v_d = any (v_days) and r.remaining > 0 then
        -- 入社日の◯日前の朝：残っているときだけ
        insert into hire_notify_log (user_id, kind, on_date) values (r.id, 'remind', v_today) on conflict do nothing;
        get diagnostics v_ins = row_count;
        if v_ins > 0 then
          v_sent := v_sent + public.notify_event('hire:remind', array[r.id],
            format('📋 入社の準備：%sさん（あと%s日・%s 入社）', regexp_replace(coalesce(r.name, ''), '[[:space:]　]+', ' ', 'g'),
                   v_d, to_char(r.hire_date, 'FMMM/FMDD')),
            format('入社の確認が残り %s件：%s', r.remaining, v_rest),
            'hire:remind', null, null);
        end if;
      end if;
    exception when others then
      -- 🚨 1人の失敗でほかの人のお知らせを止めない
      raise warning '[hire_checklist_notify] % のお知らせに失敗しました: %', r.id, sqlerrm;
    end;
  end loop;
  return v_sent;
end;
$function$;
revoke execute on function public.hire_checklist_notify() from public, anon, authenticated;

-- 🚨 この変更を入れた日にすでに入社した人（0:01 のベルが出ている）には、同じ日に「今日入社」を重ねて送らない
insert into public.hire_notify_log (user_id, kind, on_date)
select p.id, 'hired', (now() at time zone 'Asia/Tokyo')::date
  from public.profiles p
 where p.hire_date = (now() at time zone 'Asia/Tokyo')::date
on conflict do nothing;

-- cron（5分ごと・鍵を使わず SQL の関数を直接呼ぶ）
select cron.unschedule(jobid) from cron.job where jobname = 'hire-checklist-notify';
select cron.schedule('hire-checklist-notify', '*/5 * * * *', $cron$select public.hire_checklist_notify();$cron$);

commit;

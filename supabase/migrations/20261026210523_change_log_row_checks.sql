-- 「受理済みの変更」を1行ずつ確認済みにする（2026-10-26 ユーザー確定・UI/UX の専門家のレビュー）
-- ・前は時刻1つの印（payroll_check_marks）で「その時刻までは全部確認済み」にしていた。
--   🚨 絞り込み（残業だけ等）で押すと、画面に出ていない休暇・勤務変更まで確認済みになっていた
-- ・これからは記録の行（application_change_log の id）ごとに印を付ける。画面の1行（3分以内の続けての直しをまとめたもの）は、まとめた行の id を全部付ける
-- ・一括は「選んだ行をまとめて」付けるだけ（同じ batch_id）。［元に戻す］は batch_id で外す
-- ・payroll_check_marks は「データを出した時刻」の記録として残す（表で見るの Excel など）。確認の判定には使わない
-- ・読むのも書くのも管理者だけ（関数の中で is_admin()）。表は画面から直接は触れない

create table if not exists public.change_log_checks (
  log_id      uuid primary key references public.application_change_log(id) on delete cascade,
  checked_at  timestamptz not null default now(),
  checked_by  uuid,
  batch_id    uuid not null
);
create index if not exists change_log_checks_batch_idx on public.change_log_checks (batch_id);
alter table public.change_log_checks enable row level security;
revoke all on public.change_log_checks from anon, authenticated;
grant all on public.change_log_checks to service_role;
comment on table public.change_log_checks is '受理済みの変更の、行ごとの「確認済み」の印（管理者だけ・関数から読み書き）';

-- 印を付ける。返り値 { batch, count }（count＝新しく付けた数）
create or replace function public.admin_change_log_check(p_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_batch uuid := gen_random_uuid();
  v_n integer;
begin
  if not is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  insert into change_log_checks (log_id, checked_by, batch_id)
  select distinct x, auth.uid(), v_batch
    from unnest(coalesce(p_ids, '{}'::uuid[])) x
   where exists (select 1 from application_change_log l where l.id = x)
  on conflict (log_id) do nothing;
  get diagnostics v_n = row_count;
  return jsonb_build_object('batch', v_batch, 'count', v_n);
end;
$$;

-- 印を外す（行を指定 or 一度に付けた batch ごと）。返り値＝外した数
create or replace function public.admin_change_log_uncheck(p_ids uuid[] default null, p_batch uuid default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_n integer;
begin
  if not is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  delete from change_log_checks
   where (p_ids is not null and log_id = any(p_ids))
      or (p_batch is not null and batch_id = p_batch);
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- 画面に出している行の印を読む
create or replace function public.admin_change_log_checks(p_ids uuid[])
returns table (log_id uuid, checked_at timestamptz, checked_by_name text, batch_id uuid)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  return query
    select c.log_id, c.checked_at, p.name, c.batch_id
      from change_log_checks c
      left join profiles p on p.id = c.checked_by
     where c.log_id = any(coalesce(p_ids, '{}'::uuid[]));
end;
$$;

do $$
declare f text;
begin
  foreach f in array array['admin_change_log_check(uuid[])', 'admin_change_log_uncheck(uuid[], uuid)', 'admin_change_log_checks(uuid[])'] loop
    execute format('revoke execute on function public.%s from public', f);
    execute format('revoke execute on function public.%s from anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

-- 退職の手続きにメモを書けるようにする（2026-09-22 ユーザー承認・案A）
--
-- きっかけ：チェック表は「誰が・いつ済みにしたか」しか残らず、**中身が残らない**。
--   ・「いつ・どこの鍵を返却してもらったか」
--   ・「離職票は何月分が、いつまでに必要か」
--   どちらも**チェックする前に書いておきたい**ことなので、
--   「済みにするときに書くメモ」では足りない。
--
-- 【🚨 なぜ既存の retire_checklist_checks に memo 列を足さないのか（案B を採らない理由）】
--   いまの仕組みは「**その項目に記録の行があれば、片付いたと数える**」という形で、
--   画面（lib/retire.ts の retireRemaining）と朝9時の通知（retire_checklist_notify の
--   not exists）の**両方**がこの数え方に乗っている。
--   ここにメモを混ぜると「**メモを書いただけで必須の残りから消える**」という事故になる。
--   → メモは別の表に持ち、**残り件数の数え方には一切触らない**。
--
-- 【この表が持つ3種類のメモ】
--   ① 項目ごとのメモ        … item_id あり（item_label はそのときの項目名の写し）
--   ② 削除された項目のメモ  … item_id が null ＋ item_label あり
--   ③ その方ぜんたいの申し送り … item_id も item_label も null
--   🚨 ①の項目を消したときに②へ「化ける」だけで、③と混ざらない（item_label の有無で見分ける）。
--      チェックの記録（retire_checklist_checks）と同じ考え方で、項目を消しても中身が残る。
--
-- 【🚨 掃除について】
--   この表は青天井にならない：行数は「退職日が入っている人 × 項目数 ＋ 1」で頭打ちで、
--   退職は年に数件。しかも retire_cancel（退職日の取り消し）と profiles の削除で消える。
--   そのため毎晩の cron は付けていない（上限のある表なので、掃除の仕組みは不要と判断した）。

-- ─────────────────────────────────────────
-- 1. 表
-- ─────────────────────────────────────────
create table if not exists public.retire_notes (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  -- 🚨 項目を消してもメモを残すため set null。何のメモだったかは item_label で分かる
  item_id    uuid references public.retire_checklist_items(id) on delete set null,
  item_label text,
  memo       text not null check (length(btrim(memo)) > 0),
  updated_by uuid references public.profiles(id) on delete set null default auth.uid(),
  updated_at timestamptz not null default now(),
  -- 項目ごとのメモは1項目に1つ（🚨 item_id が null の行はこの制約が効かないので、下の索引で補う）
  unique (user_id, item_id)
);

comment on table public.retire_notes is
  '退職の手続きのメモ。🚨 チェックの記録（retire_checklist_checks）とは別の表にしている。'
  '同じ表にすると「メモを書いただけで必須の残り件数から消える」事故になるため';
comment on column public.retire_notes.item_id is
  'どの項目のメモか。null＝「削除された項目のメモ」か「その方ぜんたいの申し送り」（item_label の有無で見分ける）';
comment on column public.retire_notes.item_label is
  '書いた時点の項目名の写し。null＝その方ぜんたいの申し送り。'
  '🚨 項目の文字を直しても消しても、メモがどの項目のものだったかが分かるようにするため';

-- 🚨 その方ぜんたいの申し送りは1人に1つ。unique(user_id, item_id) は null を別物として扱うので、
--    これが無いと同じ人に何行でも入ってしまう
create unique index if not exists retire_notes_overall_uniq
  on public.retire_notes (user_id)
  where item_id is null and item_label is null;

create index if not exists retire_notes_user_idx on public.retire_notes (user_id);

-- ─────────────────────────────────────────
-- 2. 権限（チェック表と同じ：マネージャー以上）
-- ─────────────────────────────────────────
alter table public.retire_notes enable row level security;

drop policy if exists retire_notes_select on public.retire_notes;
create policy retire_notes_select on public.retire_notes
  for select to authenticated using (is_manager_plus());

-- 🚨 書けるのは「退職日が入っている人」のぶんだけ・updated_by は自分（誰が直したかを必ず残す）
drop policy if exists retire_notes_write on public.retire_notes;
create policy retire_notes_write on public.retire_notes
  for all to authenticated
  using (is_manager_plus())
  with check (
    is_manager_plus()
    and updated_by = auth.uid()
    and exists (select 1 from public.profiles p where p.id = user_id and p.retire_date is not null)
  );

-- 🚨 退職者（retiree）と anon には1行も見せない
revoke all on public.retire_notes from anon;
grant select, insert, update, delete on public.retire_notes to authenticated;
grant all on public.retire_notes to service_role;

-- ─────────────────────────────────────────
-- 3. 退職日の取り消し・復活でメモも消す
-- ─────────────────────────────────────────
-- 🚨 本番の実定義（pg_get_functiondef）から起こしている。
--    足したのは「delete from retire_notes」の1行だけで、ほかは1文字も変えていない。
-- 🚨 retire_cancel が返す件数は「消したチェックの数」のまま（get diagnostics の位置を動かさない）。
--    メモの削除はそのあとに置く
create or replace function public.retire_cancel(p_user uuid)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_n integer;
begin
  if not is_admin() then raise exception '管理者だけが操作できます' using errcode = '42501'; end if;
  update profiles set retire_date = null, retiree_access_until = null
   where id = p_user and is_active = true and retire_date is not null;
  if not found then raise exception '退職日が予約されている在籍中の人だけ取り消せます'; end if;
  delete from retire_checklist_checks where user_id = p_user;
  get diagnostics v_n = row_count;
  delete from retire_notes where user_id = p_user;
  return v_n;
end;
$function$;

create or replace function public.retire_restore(p_user uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_app_role text;
begin
  if not is_admin() then raise exception '管理者だけが操作できます' using errcode = '42501'; end if;
  select retired_app_role into v_app_role from profiles where id = p_user;
  update profiles
     set is_active = true,
         retire_date = null,
         retiree_access_until = null,
         retired_at = null,
         retired_role_id = null,
         retired_employment_type = null,
         retired_app_role = null
   where id = p_user
     and is_active = false
     and coalesce(approval_status, '') <> 'pending';
  if not found then raise exception '退職済みの人だけ復活できます（承認待ちの人は対象外）'; end if;
  delete from retire_checklist_checks where user_id = p_user;
  delete from retire_notes where user_id = p_user;
  -- ログインの停止を解く＋退職のときに外した権限（管理者など）を戻す
  update auth.users
     set banned_until = null,
         raw_app_meta_data = case
           when v_app_role is null then raw_app_meta_data
           else jsonb_set(coalesce(raw_app_meta_data, '{}'::jsonb), '{role}', to_jsonb(v_app_role))
         end
   where id = p_user;
  -- 付け替えの記録（retire_reassignments）は残す：誰の退職で移したかの履歴のため
end;
$function$;

-- 🚨 実行権限は今までどおり（作り直しても anon に付かないことを適用後に実測する）
revoke execute on function public.retire_cancel(uuid)  from public, anon;
revoke execute on function public.retire_restore(uuid) from public, anon;
grant  execute on function public.retire_cancel(uuid)  to authenticated, service_role;
grant  execute on function public.retire_restore(uuid) to authenticated, service_role;

-- ─────────────────────────────────────────
-- 取り消すとき
-- ─────────────────────────────────────────
--   🚨 retire_cancel / retire_restore は「delete from retire_notes」の行を消した版に戻す
--   drop table if exists public.retire_notes;

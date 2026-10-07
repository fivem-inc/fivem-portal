-- 区分・行き先リスト管理に「終了」「並び替え」（2026-10-07 ユーザー指示）
--
-- ・ended_at … 終了にした日（空＝使っている）。終了にした項目は、新しく入力する画面の選択肢に出さない。
--   🚨 消さない。これまでの報告・申請は場所の名前を文字で持っているので、終了にしても過去の記録はそのまま
-- ・master_options_reorder … 並び替えを1回で保存する（1件ずつ update すると、途中で失敗したとき並びが崩れる）
-- ・「JEUGIA 西友山科」を今日で終了（近くの「山科」へ移ったため）

begin;

alter table public.master_options add column if not exists ended_at date;
comment on column public.master_options.ended_at is
  '終了にした日。空＝使っている。終了した項目は入力の選択肢に出さない（過去の記録は名前を文字で持つので消さない）';

create or replace function public.master_options_reorder(p_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n integer;
begin
  if coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') <> 'admin' then
    raise exception '並び替えは管理者だけができます';
  end if;
  if (select count(distinct category) from master_options where id = any (p_ids)) > 1 then
    raise exception '別の一覧の項目が混ざっています';
  end if;
  update master_options m
     set sort_order = o.ord
    from unnest(p_ids) with ordinality as o(id, ord)
   where m.id = o.id;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke execute on function public.master_options_reorder(uuid[]) from public;
revoke execute on function public.master_options_reorder(uuid[]) from anon;
grant execute on function public.master_options_reorder(uuid[]) to authenticated;

update public.master_options set ended_at = date '2026-10-07'
 where category = 'trip_location_出張' and value = 'JEUGIA 西友山科' and ended_at is null;

commit;

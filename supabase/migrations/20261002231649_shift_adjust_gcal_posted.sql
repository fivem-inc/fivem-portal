-- シフト調整の決定済みの画面に「Google カレンダーに掲載済み／未掲載」を出すための読み取り関数（2026-10-02 ユーザー確定・案1）
--
-- きっかけ：10/10 の古家さんの決定が Google カレンダーに載っていなかった（決定の処理が書いていなかった）。
--   直したあと、画面から「載っているかどうか」が分かるようにしてほしい、とユーザー指示。
-- 🚨 gcal_events は RLS が有効で許可が1つも無い（画面からは読めない）。表そのものは開けず、
--    「シフト調整の決定で作った勤怠の記録のうち、Google カレンダーに予定があるもの」だけを答える。
-- 🚨 渡された ID のうち、shift_adjust_assignments に載っている勤怠の記録だけを見る（ほかの勤怠の記録の有無は答えない）。
-- 🚨 シフト調整を見る権限（shift_adjust_view）か管理者だけ。休んでいる本人の場は答えない（表の RLS と同じ考え方）。
-- 🚨 Supabase は新しい関数に anon の実行権限を自動で付けるので、from anon を明示して外す。

create or replace function public.shift_adjust_gcal_posted(p_attendance_ids uuid[])
returns table(attendance_exception_id uuid)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
begin
  if not (coalesce((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin', false)
          or public.has_feature_permission('shift_adjust_view')) then
    return;
  end if;

  return query
    select distinct a.attendance_exception_id
      from shift_adjust_assignments a
      join shift_adjust_slots s on s.id = a.slot_id
     where a.attendance_exception_id = any(p_attendance_ids)
       and s.target_user_id is distinct from auth.uid()
       and exists (select 1 from gcal_events g
                    where g.source_type = 'absence'
                      and g.source_id = a.attendance_exception_id);
end $function$;

revoke execute on function public.shift_adjust_gcal_posted(uuid[]) from public;
revoke execute on function public.shift_adjust_gcal_posted(uuid[]) from anon;
grant execute on function public.shift_adjust_gcal_posted(uuid[]) to authenticated;

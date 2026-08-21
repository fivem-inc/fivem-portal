-- カレンダー掲載（show_on_calendar）の切り替えを、本人と管理者ができるようにする
--
-- 🚨 RLS ではなく RPC にした理由
--    overtime_reports の UPDATE ポリシーは「実績報告済みは本人不可」のように状態で制限している。
--    RLS では列単位の制限が書けないため、本人の UPDATE を広げると
--    勤務時間や差分まで書き換えられてしまう。
--    （CLAUDE.md 2026-08-10「列単位で権限を絞りたいときはRLSではなくRPCに寄せる」）
--
-- 🚨 受理後でも変えられてよい理由
--    show_on_calendar は「他の人に見せるかどうか」の設定であって、労働時間の記録ではない。
--    後から変えても合計時間数・差分・給与計算は一切変わらない。
--    そもそもマネージャーは自己受理するため「受理前」という時間が存在せず、
--    受理前だけ許可する設計にすると、いちばん使う人が変更できなくなる。

create or replace function public.set_overtime_show_on_calendar(p_id uuid, p_value boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid;
begin
  select applicant_id into v_owner from overtime_reports where id = p_id;

  if v_owner is null then
    raise exception '対象の申請が見つかりません';
  end if;

  if v_owner <> auth.uid()
     and (auth.jwt() -> 'app_metadata' ->> 'role') <> 'admin' then
    raise exception 'この申請を変更する権限がありません';
  end if;

  update overtime_reports
     set show_on_calendar = p_value
   where id = p_id;
end;
$$;

grant execute on function public.set_overtime_show_on_calendar(uuid, boolean) to authenticated;

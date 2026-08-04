-- 時間外調整休を取っても残業の合計時間数から引かれない不具合の修正
--
-- 原因：休暇申請フォームは画面で「振替休日／時間外調整休」を選ばせているのに、
--       その結果を leave_requests.chosei_sub_type に保存せず、reason の文章に
--       「時間外調整休」と書くだけだった。
--       受理時に走る sync_overtime_from_leave トリガーの条件は
--         leave_type = '調整休' and chosei_sub_type = 'zangyou'
--       なので、この列が null のままだと永久に発火せず、残業台帳に
--       マイナス行（entry_type='leave_auto'）が作られない。
--
-- クライアント側（LeaveRequest.tsx の insert）は同時に修正済み。
-- ここでは「本人が未承認の申請を編集する」経路も直す。

-- 1) edit_own_leave に調整休の種類を追加
--    引数は末尾に default つきで足す（古いクライアントからの9引数の呼び出しも通る）。
--    渡されなかったときは既存値を据え置き、調整休以外に変えたときは null に落とす。
create or replace function edit_own_leave(
  p_id uuid,
  p_leave_type text,
  p_leave_type_other text,
  p_leave_dates text,
  p_leave_locations text,
  p_purpose text,
  p_reason text,
  p_start_date date,
  p_end_date date,
  p_chosei_sub_type text default null
) returns void
language plpgsql security definer set search_path = public
as $$
begin
  update leave_requests set
    leave_type       = p_leave_type,
    leave_type_other = p_leave_type_other,
    leave_dates      = p_leave_dates,
    leave_locations  = p_leave_locations,
    purpose          = p_purpose,
    reason           = p_reason,
    start_date       = p_start_date,
    end_date         = p_end_date,
    chosei_sub_type  = case
                         when p_leave_type = '調整休'
                           then coalesce(p_chosei_sub_type, chosei_sub_type)
                         else null
                       end
  where id = p_id and user_id = auth.uid() and status = 'pending';
  if not found then
    raise exception '編集できません（承認済みか対象外です）' using errcode = 'P0001';
  end if;
end;
$$;

grant execute on function edit_own_leave(uuid, text, text, text, text, text, text, date, date, text) to authenticated;

-- 2) 既存データの取りこぼしを埋める（reason の文章から種類を判定する）
--    20260724000000 でも同じ backfill を1回流しているが、その後に作られた分が
--    null のまま残っている。受理済みの行を更新してもトリガーは走らない
--    （発火は status が approved に変わる瞬間のみ）ので、既存の残業台帳は動かない。
update leave_requests
set chosei_sub_type = 'zangyou'
where leave_type = '調整休' and chosei_sub_type is null and reason like '%時間外調整休%';

update leave_requests
set chosei_sub_type = 'furikae'
where leave_type = '調整休' and chosei_sub_type is null and reason like '%振替休日%';

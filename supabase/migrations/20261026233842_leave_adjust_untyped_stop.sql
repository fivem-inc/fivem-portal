-- 2026-10-26 言葉をそろえる 段1 不具合6（計画 docs/計画-言葉をそろえる-休暇の種類の変更.md）
--
-- ① enforce_leave_adjust_moved：区切りの日（overtime_unify_cutoff）以降の「種類の無い調整休」（chosei_sub_type が空）も止める。
--    前は chosei_sub_type が空なら素通りで、上長・管理者が種類を「調整休」に変えると、時間外調整休の印の無い休みが
--    区切りの日以降にできていた（受理しても残業の時間から引かれない）。適用前の本番で該当0件（2026-10-26 実測）。
--    あわせて、UPDATE で種類・日付が1つも変わっていないときは通す（管理者の［修正］で理由だけ直すときに止まらないように。
--    UPDATE OF の列は値が同じでも SET に入っていれば動くため）。
--    本番の実定義（2026-10-26 pg_get_functiondef）から起こし、変えたのは上の2か所だけ。
--
-- ② admin_edit_leave_request：管理者の［修正］で時間外調整休・振替休日を選べるように、p_chosei_sub_type を足す。
--    既定 '__keep__'＝古い画面（引数12個）からの呼び出しは、調整休のままなら今の印を残す・調整休でなくなったら空にする。
--    🚨 引数を足すので古い版は drop してから作る（同じ名前が2つあると PostgREST が PGRST203 で全部失敗する）。
--    本番の実定義から起こし、変えたのは引数と chosei_sub_type の1行だけ。

create or replace function public.enforce_leave_adjust_moved()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_cut date := public.overtime_unify_cutoff();
begin
  if v_cut is null then return new; end if;
  -- 2026-10-26 種類の無い調整休（chosei_sub_type が空）も止める（前は空なら素通り）
  if new.leave_type is distinct from '調整休' then return new; end if;
  -- 2026-10-26 UPDATE で種類・日付が変わっていなければ通す（理由だけの修正などで止めない）
  if tg_op = 'UPDATE'
     and (old.leave_type, old.chosei_sub_type, old.leave_dates, old.start_date, old.end_date)
         is not distinct from (new.leave_type, new.chosei_sub_type, new.leave_dates, new.start_date, new.end_date) then
    return new;
  end if;
  if coalesce(new.purpose, '') = '残業調整（提案受諾）' then return new; end if;
  -- 2026-10-20 奨励日の回答から作る調整休（時間外調整休の印つき）は通す。🚨 理由欄の文字では通さない（本人が書ける）。
  --   印 app.enc_answer は answer_encouragement_day／admin_set_encouragement_answer の中だけで立つ
  if coalesce(current_setting('app.enc_answer', true), '') = '1' then return new; end if;
  if coalesce(new.status, '') in ('cancelled', 'rejected', 'withdrawn') then return new; end if;
  if exists (select 1 from unnest(public.shift_adjust_days(new.leave_dates, new.start_date, new.end_date)) d where d >= v_cut) then
    raise exception 'LEAVE_ADJUST_MOVED: %以降の調整休（時間外調整休・振替休日）は「残業申請」で申請してください', to_char(v_cut, 'FMMM/FMDD')
      using errcode = 'check_violation';
  end if;
  return new;
end;
$function$;

drop function if exists public.admin_edit_leave_request(uuid, text, text, text, text, text, text, date, date, jsonb, text, text);

create function public.admin_edit_leave_request(p_id uuid, p_leave_type text, p_leave_type_other text, p_leave_dates text, p_leave_locations text, p_purpose text, p_reason text, p_start_date date, p_end_date date, p_changes jsonb, p_change_summary text, p_change_reason text, p_chosei_sub_type text default '__keep__')
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_snapshot jsonb;
begin
  if not coalesce(is_admin(), false) then
    raise exception 'permission denied: admin only' using errcode = '42501';
  end if;

  if p_chosei_sub_type is not null and p_chosei_sub_type not in ('__keep__', 'zangyou', 'furikae') then
    raise exception 'invalid chosei_sub_type: %', p_chosei_sub_type using errcode = '22023';
  end if;

  select to_jsonb(lr.*) into v_snapshot from leave_requests lr where lr.id = p_id;
  if v_snapshot is null then
    raise exception 'leave_request not found: %', p_id using errcode = 'P0002';
  end if;

  update leave_requests set
    leave_type       = p_leave_type,
    leave_type_other = p_leave_type_other,
    -- 2026-10-26 調整休でなければ印は空。調整休なら選んだ印（古い画面からは今の印のまま）
    chosei_sub_type  = case when p_leave_type is distinct from '調整休' then null
                            when p_chosei_sub_type = '__keep__' then chosei_sub_type
                            else p_chosei_sub_type end,
    leave_dates      = p_leave_dates,
    leave_locations  = p_leave_locations,
    purpose          = p_purpose,
    reason           = p_reason,
    start_date       = p_start_date,
    end_date         = p_end_date,
    modified_by      = auth.uid(),
    modified_at      = now()
  where id = p_id;

  insert into leave_request_history
    (leave_request_id, change_kind, change_summary, change_reason, changes, snapshot, changed_by)
  values
    (p_id, 'admin_edit', p_change_summary, p_change_reason, p_changes, v_snapshot, auth.uid());
end;
$function$;

revoke execute on function public.admin_edit_leave_request(uuid, text, text, text, text, text, text, date, date, jsonb, text, text, text) from public;
revoke execute on function public.admin_edit_leave_request(uuid, text, text, text, text, text, text, date, date, jsonb, text, text, text) from anon;
grant execute on function public.admin_edit_leave_request(uuid, text, text, text, text, text, text, date, date, jsonb, text, text, text) to authenticated, service_role;

-- シフト調整の作業場：休みが決まったら、調整の場を自動で作る（手順4）
-- 設計は docs/計画-シフト調整.md。手順2（表の土台）・手順3（古いボタンとの同期）の続き。
--
-- 【このファイルでやること】
--   (A) 「その人・その日は、いま休みか」を数え直す1つの関数を作る（何度動いても同じ結果）
--   (B) 休暇（leave_requests）と欠勤（attendance_exceptions）の変化で、その関数を呼ぶ
--   (C) 🚨 逆向き：新しい作業場の状態が変わったら、古い列
--       `leave_requests.shift_adjust_status` も書き換える
--       （**入れないと、新しい側で片付けても既存のお知らせが止まらない**）
--
-- 【🚨 利用者から見える変化は無い】
--   ・新しい表を読む画面はまだ無い
--   ・逆向きの書き換えは「場の状態が変わったとき」だけ。いま場の状態を変えられるのは
--     手順3で差し替えた古いボタンだけで、そのボタンは**同じ値を古い列にも書いている**。
--     ＝結果が変わらないので書き込み自体が起きない（`is distinct from` で止めてある）
--   ・すでにある休暇63件には場は作られない（トリガーは「変化したとき」だけ動く）。
--     まとめて作るのは公開の手順9(a)
--
-- ══════════════════════════════════════════════════════════════════
-- 🚨 設計書からの訂正（2026-09-12 本番データで判明）
-- ══════════════════════════════════════════════════════════════════
-- 設計書には「有給奨励日（purpose='有給奨励日'）は対象外」と書いたが、**purpose では判定しない**。
--   ・purpose は**本人が自由に打つ欄**で、実データに purpose='奨励日'（reason は空）が1件ある。
--     これは本人が普通に出した休暇で、**調整の場が必要**。purpose で外すと取りこぼす
--   ・逆に、奨励日の回答が作る行は reason = '【有給奨励日】' で**コードが固定して入れている**
--     （answer_encouragement_day / LeaveRequestsTab が同じ文字で引いている）
--   → **判定は reason = '【有給奨励日】'**。実測：この形は50件、purpose='有給奨励日' も同じ50件、
--     purpose='奨励日' の1件は reason が空＝普通の休暇として扱う

-- ───────────────────────────────────────────────────────────────
-- 1. 休暇の「実際に休む日」を取り出す
-- ───────────────────────────────────────────────────────────────
-- 🚨 leave_dates は **text**。::jsonb のキャストが失敗すると文ごと巻き戻るので、
--    必ず例外で受けて、読めないときは start_date〜end_date で代用する。
--    実測（2026-09-12・71件）：全件が JSON配列（例 ["2026-07-15"]）で、
--    2件だけ「飛び飛びの休み」＝ start..end の日数と一致しない。**leave_dates のほうが正**。
-- 🚨 代用するときの日数に上限（62日）を掛けている。年を打ち間違えた1件で
--    何千もの場が生まれるのを防ぐため。
create or replace function public.shift_adjust_days(
  p_leave_dates text,
  p_start       date,
  p_end         date
) returns date[]
language plpgsql
stable
set search_path to 'public'
as $function$
declare
  v date[];
begin
  begin
    select array_agg(distinct t.d::date)
      into v
      from jsonb_array_elements_text(p_leave_dates::jsonb) as t(d)
     where t.d ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$';
  exception when others then
    v := null;
  end;

  if v is null or array_length(v, 1) is null then
    if p_start is null then
      return array[]::date[];
    end if;
    select array_agg(g::date)
      into v
      from generate_series(p_start,
                           least(coalesce(p_end, p_start), p_start + 61),
                           interval '1 day') as g;
  end if;

  return coalesce(v, array[]::date[]);
end $function$;

comment on function public.shift_adjust_days(text, date, date) is
  '休暇の「実際に休む日」を配列で返す。leave_dates（JSON配列の文字列）が読めないときだけ start..end で代用（最大62日）。';

-- ───────────────────────────────────────────────────────────────
-- 2. その人・その日を数え直す（作る／きっかけを直す／きっかけが消えたら閉じる）
-- ───────────────────────────────────────────────────────────────
-- 🚨 **何度呼んでも同じ結果になる形**にしてある（作る・消す・もう一度作るに耐える）。
--    「◯◯が起きたら作る」ではなく「いまの事実に合わせる」と書くと、
--    受理→取消→もう一度受理のような行き来で食い違いが出ない。
create or replace function public.shift_adjust_recompute(
  p_user_id uuid,
  p_date    date
) returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_leave_id     uuid;
  v_leave_old    text;
  v_absent_id    uuid;
  v_slot_id      uuid;
  v_slot_status  text;
  v_has_assign   boolean;
  v_cause        text;
  v_seed         text;
  v_today        date := (now() at time zone 'Asia/Tokyo')::date;
begin
  if p_user_id is null or p_date is null then
    return;
  end if;

  -- (1) その日を含む「受理済みの休暇」。🚨 奨励日の回答が作った行は除く（上の訂正を参照）
  select lr.id, lr.shift_adjust_status
    into v_leave_id, v_leave_old
    from leave_requests lr
   where lr.user_id = p_user_id
     and lr.status in ('manager_approved', 'admin_approved', 'approved')
     and coalesce(lr.reason, '') <> '【有給奨励日】'
     and p_date = any (public.shift_adjust_days(lr.leave_dates, lr.start_date, lr.end_date))
   order by lr.created_at nulls last, lr.id
   limit 1;

  -- (2) その日の欠勤
  select ae.id
    into v_absent_id
    from attendance_exceptions ae
   where ae.user_id = p_user_id
     and ae.date = p_date
     and ae.type = 'absent'
   order by ae.created_at nulls last, ae.id
   limit 1;

  select s.id, s.status
    into v_slot_id, v_slot_status
    from shift_adjust_slots s
   where s.target_user_id = p_user_id
     and s.target_date = p_date;

  -- (3) 休みがもう無い＝きっかけが消えた
  if v_leave_id is null and v_absent_id is null then
    -- 🚨 場は消さない。**決めた割り当てが残っているかもしれない**ので、
    --    「休みが取り消されました」と分かる状態にして、人に片付けてもらう
    if v_slot_id is not null and v_slot_status <> 'cause_cancelled' then
      update shift_adjust_slots
         set status = 'cause_cancelled',
             updated_at = now()
       where id = v_slot_id;
    end if;
    return;
  end if;

  -- 🚨 同じ日に休暇と欠勤が重なることがある（本番に2件）。場は1つで、きっかけは休暇を優先する
  v_cause := case when v_leave_id is not null then 'leave' else 'absent' end;

  -- (4) まだ場が無い＝新しく作る
  if v_slot_id is null then
    -- 🚨🚨 生まれたときの状態は、**古い列から引き継ぐ**。
    --    いつも pending で作ると、すでに「調整済み」にしてある休暇（本番に7件）を
    --    触っただけで場が pending で生まれ、逆向きの同期で古い列が未調整に戻り、
    --    カレンダーの印が巻き戻る。手順3の対応（adjusted→decided）と同じ向きで揃える
    v_seed := case v_leave_old
                when 'adjusted'  then 'decided'
                when 'no_change' then 'no_change'
                else                  'pending'
              end;

    -- 過ぎた日は知らせない（設計書 1.）。🚨 閉じた状態で作るので逆向きの同期もしない
    --    ＝古い列は今までどおり「未調整」のまま。カレンダーの印は変わらない
    if v_seed = 'pending' and p_date < v_today then
      v_seed := 'closed_past';
    end if;

    insert into shift_adjust_slots
      (target_user_id, target_date, cause,
       cause_leave_request_id, cause_attendance_exception_id, status)
    values
      (p_user_id, p_date, v_cause, v_leave_id, v_absent_id, v_seed)
    on conflict (target_user_id, target_date) do nothing;
    return;
  end if;

  -- (5) すでにある場：きっかけを今の事実に合わせる
  select exists (select 1 from shift_adjust_assignments a where a.slot_id = v_slot_id)
    into v_has_assign;

  update shift_adjust_slots s
     set cause                          = v_cause,
         cause_leave_request_id         = v_leave_id,
         cause_attendance_exception_id  = v_absent_id,
         -- 🚨 状態は原則そのまま。**いちど消えた休みが戻ったときだけ**呼び戻す。
         --    割り当てが残っていれば decided に、無ければ pending に
         status = case when s.status = 'cause_cancelled'
                       then (case when v_has_assign then 'decided' else 'pending' end)
                       else s.status
                  end,
         updated_at = now()
   where s.id = v_slot_id;
end $function$;

comment on function public.shift_adjust_recompute(uuid, date) is
  'その人・その日が「いま休みか」を数え直し、調整の場を作る／きっかけを直す／きっかけが消えたら閉じる。何度呼んでも同じ結果。';

-- ───────────────────────────────────────────────────────────────
-- 3. 🚨 逆向き：場の状態を、古い列 leave_requests.shift_adjust_status に書き写す
-- ───────────────────────────────────────────────────────────────
-- **これが無いと、新しい側で片付けても既存のお知らせ（cron remind-leave-shift-adjust-daily）が
--   shift_adjust_status = 'pending' を見続けて飛び続ける。**
-- 🚨 休暇1件に対して場は**日ごとに複数**できる（3日間の休暇なら3つ）。
--    1つの列にまとめるので、まとめ方を決める：
--      1つでも未調整（pending / working）がある → pending
--      そうでなく1つでも decided がある        → adjusted
--      そうでなければ                          → no_change
-- 🚨 closed_past（過ぎた日）と cause_cancelled（休みが消えた）は**数に入れない**。
--    入れると「未調整のまま過ぎた休暇」が勝手に調整済みになり、カレンダーの印が嘘をつく。
create or replace function public.shift_adjust_sync_leave_status(p_leave_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_new text;
  v_by  uuid;
  v_at  timestamptz;
begin
  if p_leave_id is null then
    return;
  end if;

  select case
           when count(*) filter (where s.status in ('pending', 'working')) > 0 then 'pending'
           when count(*) filter (where s.status = 'decided')                > 0 then 'adjusted'
           when count(*) filter (where s.status = 'no_change')              > 0 then 'no_change'
           else null
         end
    into v_new
    from shift_adjust_slots s
   where s.cause_leave_request_id = p_leave_id
     and s.status in ('pending', 'working', 'decided', 'no_change');

  -- 数に入る場が1つも無ければ、古い列には触らない（今までの値を守る）
  if v_new is null then
    return;
  end if;

  select s.decided_by, s.decided_at
    into v_by, v_at
    from shift_adjust_slots s
   where s.cause_leave_request_id = p_leave_id
     and s.decided_at is not null
   order by s.decided_at desc
   limit 1;

  -- 🚨 値が変わるときだけ書く。同じ値の書き込みを繰り返すと、
  --    古いボタン（set_leave_shift_adjust）との間で行ったり来たりする芽になる
  update leave_requests lr
     set shift_adjust_status = v_new,
         shift_adjusted_at   = case when v_new = 'pending' then null else coalesce(v_at, now()) end,
         shift_adjusted_by   = case when v_new = 'pending' then null else v_by end
   where lr.id = p_leave_id
     and lr.shift_adjust_status is distinct from v_new;
end $function$;

comment on function public.shift_adjust_sync_leave_status(uuid) is
  '新しい作業場の状態を、古い列 leave_requests.shift_adjust_status に書き写す。🚨 これが無いと既存のお知らせが止まらない。';

-- ───────────────────────────────────────────────────────────────
-- 4. トリガーの中身
-- ───────────────────────────────────────────────────────────────
-- 🚨 どれも本体を begin … exception when others then raise warning …; end; で包む。
--    **失敗しても、休暇の受理や欠勤の登録を巻き戻さない。**
--    新しい仕組みはまだテスト中で、こちらの都合で本番の運用を止めてはいけない。

create or replace function public.trg_shift_adjust_from_leave()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  d date;
begin
  begin
    -- 変更前の日（休む日が減った・人が変わった場合に、古いほうを閉じるため）
    if tg_op in ('UPDATE', 'DELETE') then
      foreach d in array public.shift_adjust_days(old.leave_dates, old.start_date, old.end_date) loop
        perform public.shift_adjust_recompute(old.user_id, d);
      end loop;
    end if;
    -- 変更後の日
    if tg_op in ('INSERT', 'UPDATE') then
      foreach d in array public.shift_adjust_days(new.leave_dates, new.start_date, new.end_date) loop
        perform public.shift_adjust_recompute(new.user_id, d);
      end loop;
    end if;
  exception when others then
    raise warning '[shift_adjust] 休暇からの作業場の更新に失敗しました: %', sqlerrm;
  end;
  return null;
end $function$;

create or replace function public.trg_shift_adjust_from_attendance()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  begin
    if tg_op in ('UPDATE', 'DELETE') then
      perform public.shift_adjust_recompute(old.user_id, old.date);
    end if;
    if tg_op in ('INSERT', 'UPDATE') then
      perform public.shift_adjust_recompute(new.user_id, new.date);
    end if;
  exception when others then
    raise warning '[shift_adjust] 勤怠からの作業場の更新に失敗しました: %', sqlerrm;
  end;
  return null;
end $function$;

create or replace function public.trg_shift_adjust_to_leave()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  begin
    perform public.shift_adjust_sync_leave_status(new.cause_leave_request_id);
    if old.cause_leave_request_id is distinct from new.cause_leave_request_id then
      perform public.shift_adjust_sync_leave_status(old.cause_leave_request_id);
    end if;
  exception when others then
    raise warning '[shift_adjust] 古い列への書き写しに失敗しました: %', sqlerrm;
  end;
  return null;
end $function$;

-- ───────────────────────────────────────────────────────────────
-- 5. トリガーを付ける
-- ───────────────────────────────────────────────────────────────
-- 🚨 名前は既存より後ろ（trg_zz_）。同じ AFTER のトリガーは**名前順**に動くので、
--    既存の leave_requests_sync_overtime / trg_leave_cancel_* を先に終わらせる。
--    実測（2026-09-12）の既存：
--      attendance_exceptions | BEFORE I-U | trg_enforce_attendance_exclusive
--      leave_requests        | AFTER  --U | leave_requests_sync_overtime
--      leave_requests        | AFTER  --U | trg_leave_cancel_reopen_appreq
--      leave_requests        | AFTER  --U | trg_leave_cancel_resolve
--      leave_requests        | AFTER  -D- | trg_leave_correction_cleanup
-- 🚨 INSERT / UPDATE / DELETE を1本にまとめられない。
--    when の条件で INSERT は new しか、DELETE は old しか使えないため。3本に分ける。

drop trigger if exists trg_zz_shift_adjust_leave_ins on public.leave_requests;
create trigger trg_zz_shift_adjust_leave_ins
  after insert on public.leave_requests
  for each row
  when (new.status in ('manager_approved', 'admin_approved', 'approved')
        and coalesce(new.reason, '') <> '【有給奨励日】')
  execute function public.trg_shift_adjust_from_leave();

drop trigger if exists trg_zz_shift_adjust_leave_upd on public.leave_requests;
create trigger trg_zz_shift_adjust_leave_upd
  after update on public.leave_requests
  for each row
  -- 🚨 shift_adjust_status は**わざと入れていない**。入れると、逆向きの書き写しが
  --    またこのトリガーを呼び、行ったり来たりになる
  when (old.status      is distinct from new.status
     or old.leave_dates is distinct from new.leave_dates
     or old.start_date  is distinct from new.start_date
     or old.end_date    is distinct from new.end_date
     or old.user_id     is distinct from new.user_id
     or old.reason      is distinct from new.reason)
  execute function public.trg_shift_adjust_from_leave();

drop trigger if exists trg_zz_shift_adjust_leave_del on public.leave_requests;
create trigger trg_zz_shift_adjust_leave_del
  after delete on public.leave_requests
  for each row
  when (old.status in ('manager_approved', 'admin_approved', 'approved'))
  execute function public.trg_shift_adjust_from_leave();

drop trigger if exists trg_zz_shift_adjust_att_ins on public.attendance_exceptions;
create trigger trg_zz_shift_adjust_att_ins
  after insert on public.attendance_exceptions
  for each row
  when (new.type = 'absent')
  execute function public.trg_shift_adjust_from_attendance();

drop trigger if exists trg_zz_shift_adjust_att_upd on public.attendance_exceptions;
create trigger trg_zz_shift_adjust_att_upd
  after update on public.attendance_exceptions
  for each row
  when (old.type    is distinct from new.type
     or old.date    is distinct from new.date
     or old.user_id is distinct from new.user_id)
  execute function public.trg_shift_adjust_from_attendance();

drop trigger if exists trg_zz_shift_adjust_att_del on public.attendance_exceptions;
create trigger trg_zz_shift_adjust_att_del
  after delete on public.attendance_exceptions
  for each row
  when (old.type = 'absent')
  execute function public.trg_shift_adjust_from_attendance();

-- 逆向き（場 → 古い列）。🚨 **状態が変わったときだけ**。
--    作られたときは動かさない（作るときに古い列から引き継いでいるので、書き戻す必要が無い）
drop trigger if exists trg_zz_shift_adjust_to_leave on public.shift_adjust_slots;
create trigger trg_zz_shift_adjust_to_leave
  after update on public.shift_adjust_slots
  for each row
  when (old.status                 is distinct from new.status
     or old.cause_leave_request_id is distinct from new.cause_leave_request_id)
  execute function public.trg_shift_adjust_to_leave();

-- ───────────────────────────────────────────────────────────────
-- 6. 実行の許可（CLAUDE.md の決まり）
-- ───────────────────────────────────────────────────────────────
-- 🚨 Supabase は新しい関数に anon の実行権限を自動で付ける。from public だけでは外れない。
--    この6つは**トリガーからしか呼ばない**ので、誰にも与えない
--    （トリガーが動くときに EXECUTE の権限は確かめられない）。
revoke execute on function public.shift_adjust_days(text, date, date)  from public, anon, authenticated;
revoke execute on function public.shift_adjust_recompute(uuid, date)   from public, anon, authenticated;
revoke execute on function public.shift_adjust_sync_leave_status(uuid) from public, anon, authenticated;
revoke execute on function public.trg_shift_adjust_from_leave()        from public, anon, authenticated;
revoke execute on function public.trg_shift_adjust_from_attendance()   from public, anon, authenticated;
revoke execute on function public.trg_shift_adjust_to_leave()          from public, anon, authenticated;

-- 打刻の確認機能
--   ① 本人が「打刻が遅れただけ（残業なし）」を自分で記録できるようにする
--   ② 経理（管理者）が本人に「この日の打刻が遅いが残業か」を確認し、本人が3択で答える
--
-- UI/UXデザイナー＋シニアエンジニアの2体レビュー反映版。
-- すべて additive・冪等。既存データは変更しない。

-- ============================================================
-- 0) 後片付け：edit_own_leave の旧版（9引数）を削除
--    20260804400000 で p_chosei_sub_type を足したが、
--    create or replace は「引数が違うと別関数として追加」されるため旧版が残っていた。
--    今はクライアントが10引数で呼ぶので新版が選ばれるが、
--    9引数で呼ぶと "function is not unique" になる地雷。
--    （同型の事故：submit_safety_response の旧4引数版）
-- ============================================================
drop function if exists public.edit_own_leave(uuid, text, text, text, text, text, text, date, date);

-- ============================================================
-- 1) overtime_reports に列を追加
--    打刻時刻は「参考情報」であり、労働時間・差分の計算には一切使わない。
--    （segments に入れると労働時間として計算されてしまうので絶対に入れない）
-- ============================================================
alter table public.overtime_reports
  add column if not exists clock_in_reported     time,
  add column if not exists clock_out_reported    time,
  add column if not exists accounting_checked_at timestamptz,
  add column if not exists accounting_checked_by uuid references auth.users(id);

comment on column public.overtime_reports.clock_out_reported is
  'タイムカードの退勤打刻（参考値）。労働時間・差分の計算には使わない';
comment on column public.overtime_reports.accounting_checked_at is
  '経理が突き合わせ済みにした日時。null の間は本人が「打刻ズレ」の記録を取消できる';

-- ============================================================
-- 2) 締め後申請の許可に「どこで付いた許可か」を持たせる
--    'manual'       = 経理が手で付与（既存）
--    'clock_inquiry'= 打刻の確認の送信で自動付与（回答が済んだら閉じる）
-- ============================================================
alter table public.overtime_submission_grants
  add column if not exists source text not null default 'manual';

-- ============================================================
-- 3) 打刻の確認（経理 → 本人）
-- ============================================================
create table if not exists public.overtime_clock_inquiries (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,  -- 本人
  sender_id   uuid not null references auth.users(id),                    -- 経理
  message     text,                                                       -- 一言（任意）
  status      text not null default 'open' check (status in ('open','answered','withdrawn')),
  answered_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists idx_oci_user   on public.overtime_clock_inquiries(user_id);
create index if not exists idx_oci_sender on public.overtime_clock_inquiries(sender_id);
create index if not exists idx_oci_status on public.overtime_clock_inquiries(status);

drop trigger if exists trg_oci_updated_at on public.overtime_clock_inquiries;
create trigger trg_oci_updated_at before update on public.overtime_clock_inquiries
  for each row execute function public.set_updated_at();

-- 日ごとの明細。回答も日ごとに持つ（「この日はしていた／この日はしていない」が普通に混ざるため）
create table if not exists public.overtime_clock_inquiry_days (
  id            uuid primary key default gen_random_uuid(),
  inquiry_id    uuid not null references public.overtime_clock_inquiries(id) on delete cascade,
  work_date     date not null,
  shift_start   time,                 -- 送信時点の通常シフト（スナップショット）
  shift_end     time,
  clock_in      time,                 -- 経理が入力した打刻
  clock_out     time,
  answer        text not null default 'pending'
                  check (answer in ('pending','worked','not_worked','unknown')),
  answer_reason text,                 -- not_worked のときの理由
  answer_note   text,                 -- unknown/その他の自由記入
  result_report_id uuid references public.overtime_reports(id) on delete set null,
  unique (inquiry_id, work_date)
);
create index if not exists idx_ocid_inquiry on public.overtime_clock_inquiry_days(inquiry_id);
create index if not exists idx_ocid_date    on public.overtime_clock_inquiry_days(work_date);

-- ============================================================
-- 4) RLS
--    ⚠️ クロステーブル参照は「days → inquiries」の片方向のみ。
--       inquiries 側から days を参照すると相互再帰になり全件消失する
--       （board_message_recipients で実際に起きた事故）。
--       可視判定は SECURITY DEFINER 関数に切り出す。
-- ============================================================
alter table public.overtime_clock_inquiries     enable row level security;
alter table public.overtime_clock_inquiry_days  enable row level security;

create or replace function public.oci_can_view(p_user uuid, p_sender uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select p_user   = auth.uid()
      or p_sender = auth.uid()
      or (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin';
$$;
revoke execute on function public.oci_can_view(uuid, uuid) from public;
grant  execute on function public.oci_can_view(uuid, uuid) to authenticated;

drop policy if exists oci_select on public.overtime_clock_inquiries;
create policy oci_select on public.overtime_clock_inquiries
  for select using (public.oci_can_view(user_id, sender_id));

-- 作成・取り下げは管理者のみ（通常は RPC 経由。直接操作の保険）
drop policy if exists oci_admin_write on public.overtime_clock_inquiries;
create policy oci_admin_write on public.overtime_clock_inquiries
  for all using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
       with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

drop policy if exists ocid_select on public.overtime_clock_inquiry_days;
create policy ocid_select on public.overtime_clock_inquiry_days
  for select using (exists (
    select 1 from public.overtime_clock_inquiries i
    where i.id = public.overtime_clock_inquiry_days.inquiry_id
      and public.oci_can_view(i.user_id, i.sender_id)
  ));

drop policy if exists ocid_admin_write on public.overtime_clock_inquiry_days;
create policy ocid_admin_write on public.overtime_clock_inquiry_days
  for all using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
       with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');
-- ※ 本人の回答・結果の紐付けは UPDATE ポリシーを与えず、
--   すべて下の SECURITY DEFINER の RPC 経由にする（本人が他の列を書き換えられない）

-- ============================================================
-- 5) RPC：確認を送る（経理）
--    inquiry・days・締め後の許可・本人への通知を1トランザクションで作る。
--    クライアントから4回に分けて呼ぶと部分成功する。
-- ============================================================
create or replace function public.send_overtime_clock_inquiry(
  p_user_id uuid,
  p_days    jsonb,   -- [{work_date, shift_start, shift_end, clock_in, clock_out}, ...]
  p_message text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_id        uuid;
  v_today     date := (now() at time zone 'Asia/Tokyo')::date;
  e           jsonb;
  v_date      date;
  v_pps       date;
  v_deadline  date;
  v_dates     date[] := '{}';
  v_label     text;
  v_site_on   boolean;
begin
  if (auth.jwt() -> 'app_metadata' ->> 'role') <> 'admin' then
    raise exception '打刻の確認を送れるのは経理（管理者）だけです';
  end if;
  if p_user_id is null then
    raise exception '対象者を選んでください';
  end if;
  if jsonb_typeof(p_days) <> 'array' or jsonb_array_length(p_days) = 0 then
    raise exception '対象の日を1日以上選んでください';
  end if;

  -- 同じ日に未回答の確認が既にあるなら送らない。
  -- 二度聞きになるうえ、両方に「打刻が遅れただけ」と答えると
  -- 2件目の記録作成が uq_overtime_manual_per_day で 23505 になる。
  if exists (
    select 1
      from public.overtime_clock_inquiry_days d
      join public.overtime_clock_inquiries i on i.id = d.inquiry_id
     where i.user_id = p_user_id
       and i.status  = 'open'
       and d.work_date in (
         select (x ->> 'work_date')::date from jsonb_array_elements(p_days) x
       )
  ) then
    raise exception 'この日はすでに確認を送っています（未回答）' using errcode = 'P0001';
  end if;

  insert into public.overtime_clock_inquiries (user_id, sender_id, message)
  values (p_user_id, auth.uid(), nullif(btrim(coalesce(p_message, '')), ''))
  returning id into v_id;

  for e in select * from jsonb_array_elements(p_days) loop
    v_date := (e ->> 'work_date')::date;
    if v_date is null then
      raise exception '日付が正しくありません';
    end if;

    insert into public.overtime_clock_inquiry_days
      (inquiry_id, work_date, shift_start, shift_end, clock_in, clock_out)
    values (
      v_id, v_date,
      nullif(e ->> 'shift_start', '')::time,
      nullif(e ->> 'shift_end',   '')::time,
      nullif(e ->> 'clock_in',    '')::time,
      nullif(e ->> 'clock_out',   '')::time
    )
    on conflict (inquiry_id, work_date) do nothing;

    if not (v_date = any(v_dates)) then
      v_dates := v_dates || v_date;   -- 同じ日を2回渡されても件数ラベルを狂わせない
    end if;

    -- 締め後でも本人が報告できるよう、その日だけ許可を付ける。
    -- ただし給与データ確定日を過ぎた期には付けない（支給済みの期に新規行が入る道を作らない）
    v_pps      := public.calc_pay_period_start(v_date);
    v_deadline := public.overtime_grant_deadline(v_pps);
    if v_deadline is null or v_today <= v_deadline then
      insert into public.overtime_submission_grants (user_id, work_date, granted_by, note, source)
      values (p_user_id, v_date, auth.uid(),
              '打刻の確認（' || to_char(v_date, 'MM/DD') || '）', 'clock_inquiry')
      -- 生きている許可がある日は触らない。
      -- 経理が手で付けた許可を clock_inquiry に乗っ取ると、
      -- 回答後に link_clock_inquiry_result が勝手に閉じてしまう。
      -- 取消済みの行だけ、打刻の確認由来として引き取る（回答後に閉じられる状態にする）。
      on conflict (user_id, work_date) do update
        set revoked_at = null,
            revoked_by = null,
            granted_by = excluded.granted_by,
            note       = excluded.note,
            source     = excluded.source
        where overtime_submission_grants.revoked_at is not null;
    end if;
  end loop;

  -- 本人への通知（管理者が送るので RLS は通るが、部分成功を避けるためここで作る）
  -- ⚠️ 本文に「お知らせ」「リマインド」「メッセージが届き」「への対応がまだ完了していません」を入れない
  --    （App.tsx の連絡板判定・催促判定が先に効いてタップで /board に飛ぶ）
  select to_char(min(t.d), 'MM/DD') ||
         case when count(*) > 1 then ' 他' || (count(*) - 1) || '日' else '' end
    into v_label
    from unnest(v_dates) as t(d);

  -- 管理画面のON/OFFに従う（行が無ければ送る）。設定はあるのに効かない「死に設定」を作らない
  select enabled into v_site_on from public.notification_settings
   where event_key = 'overtime:clock_inquiry' and channel = 'site';

  if coalesce(v_site_on, true) then
    insert into public.notifications
      (user_id, message, sub_message, source_type, reference_id, event_key)
    values (
      p_user_id,
      '経理から勤務時間の確認です',
      v_label || '　タップして回答してください',
      'overtime:clock_inquiry', v_id::text, 'overtime:clock_inquiry'
    );
  end if;

  return v_id;
end; $$;
revoke execute on function public.send_overtime_clock_inquiry(uuid, jsonb, text) from public;
grant  execute on function public.send_overtime_clock_inquiry(uuid, jsonb, text) to authenticated;

-- ============================================================
-- 6) RPC：確認に回答する（本人）
--    open → answered を1回だけ成立させる（二重回答防止）。
--    🚨 経理への通知はこの中で作る。
--       notifications の INSERT ポリシーはリーダー以上限定で、
--       回答者（一般・パート・フロア責任者）はクライアントから insert できない。
-- ============================================================
create or replace function public.answer_overtime_clock_inquiry(
  p_inquiry_id uuid,
  p_days       jsonb,  -- [{day_id, answer, reason, note}, ...]
  p_note       text default null
) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_claimed  int;
  v_sender   uuid;
  v_name     text;
  v_worked   int;
  v_not      int;
  v_unknown  int;
  v_summary  text;
  v_site_on  boolean;
begin
  update public.overtime_clock_inquiries
     set status = 'answered', answered_at = now()
   where id = p_inquiry_id and user_id = auth.uid() and status = 'open'
  returning sender_id into v_sender;

  get diagnostics v_claimed = row_count;
  if v_claimed = 0 then
    return false;  -- 既に回答済み or 権限なし → 呼び出し側で案内を出す
  end if;

  update public.overtime_clock_inquiry_days d set
    answer        = coalesce(nullif(e ->> 'answer', ''), d.answer),
    answer_reason = nullif(e ->> 'reason', ''),
    answer_note   = nullif(e ->> 'note',   '')
  from jsonb_array_elements(coalesce(p_days, '[]'::jsonb)) e
  where d.id = (e ->> 'day_id')::uuid and d.inquiry_id = p_inquiry_id;

  -- 反映漏れ・空配列で「回答済みなのに全部 未回答」を作らない。
  -- この RPC は open のときだけ成立する＝やり直しがきかないので、ここで止める。
  -- 例外なら上の status 更新ごとロールバックされ、open のまま再試行できる。
  if exists (
    select 1 from public.overtime_clock_inquiry_days
     where inquiry_id = p_inquiry_id and answer = 'pending'
  ) then
    raise exception 'まだ回答していない日があります' using errcode = 'P0001';
  end if;

  select count(*) filter (where answer = 'worked'),
         count(*) filter (where answer = 'not_worked'),
         count(*) filter (where answer = 'unknown')
    into v_worked, v_not, v_unknown
    from public.overtime_clock_inquiry_days where inquiry_id = p_inquiry_id;

  select name into v_name from public.profiles where id = auth.uid();

  v_summary := concat_ws('／',
    case when v_not     > 0 then '打刻が遅れただけ ' || v_not     || '日' end,
    case when v_worked  > 0 then '業務をしていた '   || v_worked  || '日' end,
    case when v_unknown > 0 then '思い出せない '     || v_unknown || '日' end
  );
  if nullif(btrim(coalesce(p_note, '')), '') is not null then
    v_summary := v_summary || '　' || btrim(p_note);
  end if;

  select enabled into v_site_on from public.notification_settings
   where event_key = 'overtime:clock_inquiry_answered' and channel = 'site';

  if coalesce(v_site_on, true) then
    insert into public.notifications
      (user_id, message, sub_message, source_type, reference_id, event_key)
    values (
      v_sender,
      coalesce(v_name, 'スタッフ') || 'さんが勤務時間の確認に回答しました',
      v_summary,
      'overtime:clock_inquiry_answered', p_inquiry_id::text, 'overtime:clock_inquiry_answered'
    );
  end if;

  return true;
end; $$;
revoke execute on function public.answer_overtime_clock_inquiry(uuid, jsonb, text) from public;
grant  execute on function public.answer_overtime_clock_inquiry(uuid, jsonb, text) to authenticated;

-- ============================================================
-- 7) RPC：作った記録を確認に紐付ける（本人）
--    回答は先に確定するので、レコード作成に失敗しても
--    「answer が worked/not_worked なのに result_report_id が null」で検出できる。
--    紐付けが済んだ日は、自動で付けた締め後の許可を閉じる。
-- ============================================================
create or replace function public.link_clock_inquiry_result(
  p_day_id    uuid,
  p_report_id uuid
) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_user uuid;
  v_date date;
begin
  select i.user_id, d.work_date into v_user, v_date
    from public.overtime_clock_inquiry_days d
    join public.overtime_clock_inquiries i on i.id = d.inquiry_id
   where d.id = p_day_id;

  if v_user is null or v_user <> auth.uid() then
    return false;
  end if;
  -- 自分の申請以外・別の日の申請は紐付けさせない
  -- （日を見ないと、8/4の確認に7/20の申請を紐付けて8/4の許可だけ閉じられてしまう）
  if not exists (select 1 from public.overtime_reports
                  where id = p_report_id
                    and applicant_id = auth.uid()
                    and work_date = v_date) then
    return false;
  end if;

  update public.overtime_clock_inquiry_days
     set result_report_id = p_report_id
   where id = p_day_id;

  -- 打刻の確認で自動的に開けた許可を閉じる（開きっぱなしにしない）
  update public.overtime_submission_grants
     set revoked_at = now()
   where user_id = v_user and work_date = v_date
     and source = 'clock_inquiry' and revoked_at is null;

  return true;
end; $$;
revoke execute on function public.link_clock_inquiry_result(uuid, uuid) from public;
grant  execute on function public.link_clock_inquiry_result(uuid, uuid) to authenticated;

-- ============================================================
-- 8) 本人が「打刻ズレ」の記録を取り消す
--
--    🚨 これは RLS ポリシーでは絶対に実現できない。
--       PostgreSQL の permissive ポリシーは USING 群と WITH CHECK 群が
--       「別々に」OR されるため、既存 overtime_update_own の USING（旧行）と
--       新ポリシーの WITH CHECK（新行）を組み合わせると
--       「実績報告済みの残業を cancelled + clock_only に書き換える」が通ってしまう。
--       ＝ overtime-approve の「実績報告済は取消不可」「17日以降は取消不可」
--          「締め後アラート」をまるごと迂回できる。
--    条件を1文の where に閉じ込めるため RPC にする。
-- ============================================================
drop policy if exists overtime_cancel_own_clock_only on public.overtime_reports;

create or replace function public.cancel_own_clock_only_report(p_id uuid)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_snapshot jsonb;
  v_updated  int;
begin
  -- 取消前の姿を控えておく（UPDATE の後では取れない）
  select to_jsonb(r.*) into v_snapshot
    from public.overtime_reports r where r.id = p_id;

  update public.overtime_reports
     set status = 'cancelled'
   where id = p_id
     and applicant_id = auth.uid()
     and entry_type   = 'manual'
     and status       = 'confirmed'
     and accounting_checked_at is null          -- 経理が突き合わせ済みにしたら消せない
     and application_types @> array['clock_only']::text[];
  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    return false;   -- 対象外／経理が確認済み／既に取消済み
  end if;

  insert into public.overtime_report_history
    (report_id, changed_by, change_kind, change_summary, snapshot)
  values (p_id, auth.uid(), 'cancelled', '打刻ズレの記録を本人が取消',
          coalesce(v_snapshot, '{}'::jsonb));

  -- 打刻の確認から作った記録なら紐付けをほどく（未作成として作り直せるようにする）
  update public.overtime_clock_inquiry_days
     set result_report_id = null
   where result_report_id = p_id;

  return true;
end; $$;
revoke execute on function public.cancel_own_clock_only_report(uuid) from public;
grant  execute on function public.cancel_own_clock_only_report(uuid) to authenticated;

-- ============================================================
-- 8-2) 確認を取り下げる（経理）
--      取り下げたら、自動で開けた締め後の許可も閉じる（開きっぱなしにしない）
-- ============================================================
create or replace function public.withdraw_overtime_clock_inquiry(p_inquiry_id uuid)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_user    uuid;
  v_updated int;
begin
  if (auth.jwt() -> 'app_metadata' ->> 'role') <> 'admin' then
    raise exception '取り下げできるのは経理（管理者）だけです';
  end if;

  update public.overtime_clock_inquiries
     set status = 'withdrawn'
   where id = p_inquiry_id and status = 'open'
  returning user_id into v_user;
  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    return false;   -- 既に回答済み／取り下げ済み
  end if;

  update public.overtime_submission_grants g
     set revoked_at = now(), revoked_by = auth.uid()
   where g.user_id = v_user
     and g.source = 'clock_inquiry'
     and g.revoked_at is null
     and g.work_date in (
       select d.work_date from public.overtime_clock_inquiry_days d
        where d.inquiry_id = p_inquiry_id
     );

  return true;
end; $$;
revoke execute on function public.withdraw_overtime_clock_inquiry(uuid) from public;
grant  execute on function public.withdraw_overtime_clock_inquiry(uuid) to authenticated;

-- ============================================================
-- 9) 通知設定（管理画面のON/OFF用）
--    🚨 push-dispatch は「設定行が無いイベントはON扱い」なので、
--       この seed を実行してから Edge Function をデプロイすること。
--    メールは既定ON（ユーザー要望）。管理画面からOFFにできる。
-- ============================================================
insert into public.notification_settings (event_key, channel, enabled, recipient, subject, template)
values
  ('overtime:clock_inquiry', 'site',  true,  null, null, null),
  ('overtime:clock_inquiry', 'push',  true,  null, null, null),
  ('overtime:clock_inquiry', 'email', true,  null,
   '勤務時間の確認のお願い',
   E'{{対象者名}} さん\n\n経理から勤務時間の確認が届いています。\n対象日：{{日付}}\n\n下記のリンクから回答してください。\n{{リンク}}'),
  ('overtime:clock_inquiry_answered', 'site',  true,  null, null, null),
  ('overtime:clock_inquiry_answered', 'push',  true,  null, null, null),
  ('overtime:clock_inquiry_answered', 'email', false, null,
   '勤務時間の確認に回答がありました',
   E'{{対象者名}} さんが勤務時間の確認に回答しました。\n\n{{内容}}\n\n下記のリンクからご確認ください。\n{{リンク}}')
on conflict (event_key, channel) do nothing;

-- ============================================================
-- 場所予約：月次更新（繰り返しをローリングで延長する）
--            （2026-09-02 ユーザー承認・案A）
--
-- 背景：これまで繰り返しは「年度末まで一括生成」だったが、実際の運用は
--   「週の型を正として、翌月分だけ作る」。プライベートは変更が多く、
--   遠い未来まで作ると直し作業が膨らむ。
--   → 繰り返しルールを週のマスターとして育て、**月に1回ボタンで翌月分を生成**する。
--     期限なし（end_date null）の繰り返しを既定にし、生成済みの位置は
--     generated_to（設計時から用意されていた未使用の列）で管理する。
--
-- 🚨 自動では増やさない（従来方針）。人が「月次更新」で押す。
-- 🚨 キャンセル待ちは枠（recurrence）に付いているので、月次更新で作った
--    翌月の回にもそのまま効く。月ごとに待ちを作り直さないこと。
-- 🚨 生成は room_create_booking を1回ずつ呼ぶ（重なり判定を作り直さない・
--    中心の関数に手を入れない）。作れなかった回は理由つきで返す。
--
-- ロールバック手順:
--   drop function if exists room_extend_recurrence(uuid, date);
-- ============================================================

create or replace function room_extend_recurrence(
  p_recurrence_id uuid,
  p_until         date
)
returns table (ok boolean, reason text, created int, skipped text[])
language plpgsql
security definer
set search_path = public
as $$
declare
  r         room_recurrences;
  v_from    date;
  v_until   date;
  d         date;
  v_res     record;
  v_created int    := 0;
  v_skip    text[] := '{}';
begin
  if auth.uid() is null then
    return query select false, 'ログインし直してください', 0, '{}'::text[];
    return;
  end if;
  -- 月次更新は「基本設定を使える人」（年度更新と同じ層）
  if not room_can_use_basic_settings() then
    return query select false, '月次更新は基本設定を使える方だけが実行できます', 0, '{}'::text[];
    return;
  end if;

  -- 🚨 二度押し・2人同時の実行で二重に作らないよう、ルール単位で直列化する
  perform pg_advisory_xact_lock(hashtext('room_extend_' || p_recurrence_id::text));

  select * into r from room_recurrences where id = p_recurrence_id;
  if not found then
    return query select false, '繰り返しが見つかりませんでした', 0, '{}'::text[];
    return;
  end if;
  if not r.active then
    return query select false, 'この繰り返しは止まっています', 0, '{}'::text[];
    return;
  end if;

  -- どこから・どこまで作るか。期限（end_date）があればそこまで
  v_until := least(p_until, coalesce(r.end_date, p_until));
  v_from  := greatest(coalesce(r.generated_to, r.start_date - 1) + 1, r.start_date);
  if v_from > v_until then
    -- もう作成済み。何もしない（二度押ししても増えない）
    return query select true, null::text, 0, '{}'::text[];
    return;
  end if;

  -- v_from 以降で最初にその曜日になる日
  d := v_from + ((r.weekday - extract(dow from v_from)::int + 7) % 7);

  while d <= v_until loop
    -- 🚨 時刻は日本時間として組み立てる（timestamp を素で入れるとUTC扱いで9時間ずれる）
    select * into v_res from room_create_booking(
      r.floor_id,
      (d::timestamp + r.start_time) at time zone 'Asia/Tokyo',
      (d::timestamp + r.end_time)   at time zone 'Asia/Tokyo',
      r.purpose,
      r.booker_name,
      r.member_no,
      r.customer_label,
      r.memo,
      r.exclusive,
      r.id,
      r.staff_id,
      r.kind,
      r.seats
    );
    if coalesce(v_res.ok, false) then
      v_created := v_created + 1;
      -- 詳細と【固定】はルールから引き継ぐ（room_create_booking に引数が無いため後書き）
      update room_bookings
         set detail = r.detail, is_fixed = r.is_fixed
       where id = v_res.booking_id;
    else
      -- 🚨 黙って欠けさせない。作れなかった回は理由つきで返す（一括入力と同じ流儀）
      v_skip := v_skip || (to_char(d, 'YYYY-MM-DD') || '：' || coalesce(v_res.reason, '作れませんでした'));
    end if;
    d := d + 7;
  end loop;

  -- 作れなかった回があっても「ここまで処理した」は進める。
  -- 🚨 進めないと、次回また同じ重なりで失敗し続けて先へ進めなくなる
  update room_recurrences set generated_to = v_until where id = r.id;

  return query select true, null::text, v_created, v_skip;
end;
$$;

-- 🚨 新しい関数には anon の実行権限が自動で付く。必ず外す
revoke execute on function room_extend_recurrence(uuid, date) from public;
revoke execute on function room_extend_recurrence(uuid, date) from anon;
grant  execute on function room_extend_recurrence(uuid, date) to authenticated;
grant  execute on function room_extend_recurrence(uuid, date) to service_role;

-- 確認用:
--   select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public' and p.proname = 'room_extend_recurrence';

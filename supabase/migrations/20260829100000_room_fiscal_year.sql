-- ============================================================
-- 場所予約：年度（4/1〜翌3/31）と年度更新（2026-08-29 ユーザー確定）
--
-- 何をするものか:
--   毎週の繰り返し予約を「年度」で区切って持ち、年度が変わるときに
--   まとめて次の年度へ引き継げるようにする。
--
-- なぜ必要か:
--   これまでは繰り返しの「いつまで」が最長1年先で、そこまでの予約を
--   登録時に作るだけだった。つまり **1年経つと予約が黙って無くなる**。
--   誰も気づけないまま4月以降が空になり、二重に埋まる事故につながる。
--   自動で増やす作りにはしない（休講や重なりの扱いを間違えると
--   取り返しがつかないため）。**人が一覧を見て選んで引き継ぐ**形にする。
--
-- 設計の判断:
--   ・fiscal_year を列として持つ。end_date から推測しないのは、途中でやめた
--     繰り返し（end_date が年度末でない）の年度が判定できなくなるため。
--   ・renewed_from で「どのルールから引き継いだか」を残す。これが無いと
--     二度押しで同じ予約が二重に作られる。
--   ・作成は1ルールぶんをこの関数の中でまとめて行う。画面から1回ずつ
--     叩くと 30ルール×52回＝1,560回の呼び出しになり、途中で切れると
--     中途半端な状態が残るため。
--   ・重なりの判定は自前で数え直さず、既存の room_create_booking に任せる。
--     🚨 画面やコピー先で判定を作り直すと、サーバーの判定とズレて嘘をつく
--        （貸切なのに「あと2件入れられます」と出た件と同じ轍）。
--   ・日時は必ず `at time zone 'Asia/Tokyo'` を通す。
--     🚨 (日付 + 時刻) をそのまま timestamptz に入れると UTC として保存され、
--        画面が9時間ずれる（実測で確認済み）。
--
-- 権限:
--   年度更新は **社員まで**（パートは不可）。判定は画面だけに置かず
--   この関数の中でも行う（判定が2か所に散ると、片方だけ直して嘘をつく）。
--   既存の RLS ポリシーには触っていない。
--
-- 実行前に確認すること:
--   select count(*) from room_recurrences;
--   （0件でない場合、fiscal_year の埋め方が意図どおりか確認してから流す）
--
-- ロールバック手順:
--   drop function if exists room_renew_recurrence(uuid, int, uuid, int, time, time, uuid, text, text);
--   drop function if exists room_is_staff();   -- 🚨 他の機能でも使うので、単独では消さないこと
--   drop function if exists room_fiscal_year(date);
--   drop function if exists room_fiscal_start(int);
--   drop function if exists room_fiscal_end(int);
--   alter table room_recurrences drop column fiscal_year, drop column renewed_from;
-- ============================================================

-- ------------------------------------------------------------
-- 0) 「社員かどうか」の判定（パートは false）
--
--    🚨 判定はここ1か所にまとめる。同じ条件をあちこちに書くと、
--       片方だけ直したときに画面とサーバーで食い違い、嘘をつく。
--    残業まわりで使われている `employment_type <> 'パート'` と同じ考え方。
--    プロフィールが読めない場合は false（＝できない側）に倒す。
-- ------------------------------------------------------------
create or replace function room_is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from profiles p
     where p.id = auth.uid()
       and coalesce(p.employment_type, '') <> 'パート'
  );
$$;

-- ------------------------------------------------------------
-- 1) 年度の計算（4/1〜翌3/31 を1つの年度とする）
-- ------------------------------------------------------------
create or replace function room_fiscal_year(p_date date) returns int
language sql immutable as $$
  select case when extract(month from p_date) >= 4
              then extract(year from p_date)::int
              else extract(year from p_date)::int - 1
         end;
$$;

create or replace function room_fiscal_start(p_fy int) returns date
language sql immutable as $$ select make_date(p_fy, 4, 1); $$;

create or replace function room_fiscal_end(p_fy int) returns date
language sql immutable as $$ select make_date(p_fy + 1, 3, 31); $$;

-- ------------------------------------------------------------
-- 2) 繰り返しに年度と引き継ぎ元を持たせる
-- ------------------------------------------------------------
alter table room_recurrences
  add column if not exists fiscal_year  int,
  add column if not exists renewed_from uuid references room_recurrences(id) on delete set null;

-- 既存行の年度を埋める（開始日が属する年度）
update room_recurrences
   set fiscal_year = room_fiscal_year(start_date)
 where fiscal_year is null;

-- 入れ忘れの保険。画面からは常に明示的に入れる
alter table room_recurrences
  alter column fiscal_year set default room_fiscal_year((now() at time zone 'Asia/Tokyo')::date);

alter table room_recurrences
  alter column fiscal_year set not null;

-- 年度の一覧を出すため（更新の画面で毎回使う）
create index if not exists idx_room_recurrences_fiscal_year
  on room_recurrences (fiscal_year) where active;

-- 「もう引き継ぎ済みか」を引くため
create index if not exists idx_room_recurrences_renewed_from
  on room_recurrences (renewed_from) where renewed_from is not null;

-- ------------------------------------------------------------
-- 3) 1つの繰り返しを、次の年度へ引き継ぐ
--
--    引数の扱い:
--      p_floor_id / p_weekday / p_start_time / p_end_time
--        … null なら「変更なし（元のまま）」
--      p_staff_id / p_member_no / p_customer_label
--        … 画面が必ず値を送る。null は「なし（担当未定・参加者未定）」の意味
--
--    戻り値:
--      ok       … 1件でも作れたら true
--      reason   … 作れなかった理由（画面にそのまま出す）
--      made     … 作れた回数
--      skipped  … 先約と重なって入らなかった日
--                 🚨 入らなかった回を黙って捨てないこと。「全部入った」と
--                    誤解されると、その時間が空いていると思い込まれる
-- ------------------------------------------------------------
create or replace function room_renew_recurrence(
  p_recurrence_id  uuid,
  p_fiscal_year    int,
  p_floor_id       uuid default null,
  p_weekday        int  default null,
  p_start_time     time default null,
  p_end_time       time default null,
  p_staff_id       uuid default null,
  p_member_no      text default null,
  p_customer_label text default null
)
returns table (ok boolean, reason text, new_recurrence_id uuid, made int, skipped date[])
language plpgsql
security definer
set search_path = public
as $$
declare
  v_src     room_recurrences;
  v_floor   uuid;
  v_wd      int;
  v_st      time;
  v_et      time;
  v_member  text;
  v_label   text;
  v_today   date := (now() at time zone 'Asia/Tokyo')::date;
  v_from    date;
  v_to      date;
  v_d       date;
  v_new     uuid;
  v_made    int := 0;
  v_skipped date[] := '{}';
  v_res     record;
begin
  if auth.uid() is null then
    return query select false, 'ログインし直してください', null::uuid, 0, '{}'::date[];
    return;
  end if;

  -- 社員まで。パートは不可
  if not room_is_staff() then
    return query select false, '年度更新は社員のみ行えます', null::uuid, 0, '{}'::date[];
    return;
  end if;

  select * into v_src from room_recurrences where id = p_recurrence_id;
  if not found then
    return query select false, 'もとの繰り返しが見つかりませんでした', null::uuid, 0, '{}'::date[];
    return;
  end if;

  -- 🚨 二度押しで同じ予約が二重に作られるのを防ぐ
  if exists (select 1 from room_recurrences
              where renewed_from = p_recurrence_id and fiscal_year = p_fiscal_year) then
    return query select false, 'この繰り返しは、すでにこの年度へ引き継ぎ済みです',
                        null::uuid, 0, '{}'::date[];
    return;
  end if;

  v_floor  := coalesce(p_floor_id,   v_src.floor_id);
  v_wd     := coalesce(p_weekday,    v_src.weekday);
  v_st     := coalesce(p_start_time, v_src.start_time);
  v_et     := coalesce(p_end_time,   v_src.end_time);
  v_member := nullif(btrim(coalesce(p_member_no, '')), '');
  v_label  := nullif(btrim(coalesce(p_customer_label, '')), '');

  if v_et <= v_st then
    return query select false, '終了は開始より後にしてください', null::uuid, 0, '{}'::date[];
    return;
  end if;
  if v_wd < 0 or v_wd > 6 then
    return query select false, '曜日の指定が正しくありません', null::uuid, 0, '{}'::date[];
    return;
  end if;

  -- その年度の範囲。過ぎた日には作らない
  v_from := greatest(room_fiscal_start(p_fiscal_year), v_today);
  v_to   := room_fiscal_end(p_fiscal_year);
  if v_from > v_to then
    return query select false, 'その年度はすでに終わっています', null::uuid, 0, '{}'::date[];
    return;
  end if;

  -- 最初の該当曜日まで進める（0=日曜。JS の getDay と同じ）
  while extract(dow from v_from)::int <> v_wd loop
    v_from := v_from + 1;
  end loop;
  if v_from > v_to then
    return query select false, 'その年度に対象の曜日がありません', null::uuid, 0, '{}'::date[];
    return;
  end if;

  insert into room_recurrences (
    floor_id, weekday, start_time, end_time, purpose, booker_name,
    member_no, customer_label, memo, exclusive, staff_id, kind, seats,
    start_date, end_date, generated_to, fiscal_year, renewed_from, created_by
  ) values (
    v_floor, v_wd, v_st, v_et, v_src.purpose, v_src.booker_name,
    v_member, v_label, v_src.memo, v_src.exclusive, p_staff_id, v_src.kind, v_src.seats,
    v_from, v_to, v_to, p_fiscal_year, p_recurrence_id, auth.uid()
  ) returning id into v_new;

  v_d := v_from;
  while v_d <= v_to loop
    -- 🚨 重なりの判定は作り直さない。既存の関数にそのまま任せる
    select * into v_res from room_create_booking(
      v_floor,
      (v_d + v_st) at time zone 'Asia/Tokyo',
      (v_d + v_et) at time zone 'Asia/Tokyo',
      v_src.purpose,
      v_src.booker_name,
      v_member,
      v_label,
      v_src.memo,
      v_src.exclusive,
      v_new,
      p_staff_id,
      v_src.kind,
      v_src.seats
    );
    if coalesce(v_res.ok, false) then
      v_made := v_made + 1;
    else
      v_skipped := v_skipped || v_d;
    end if;
    v_d := v_d + 7;
  end loop;

  -- 1件も入らなかったら、親だけが残って迷子になるので消しておく
  if v_made = 0 then
    delete from room_recurrences where id = v_new;
    return query select false, 'すべての回が先約と重なったため、1件も作成できませんでした',
                        null::uuid, 0, v_skipped;
    return;
  end if;

  return query select true, null::text, v_new, v_made, v_skipped;
end;
$$;

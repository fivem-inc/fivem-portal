-- お知らせへの返信（2026-09-21 ユーザー承認）
--
-- 【決まったこと】
--   ・お知らせを送るときに「返信を受け付ける」チェック（既定はOFF）
--   ・返信は元のお知らせにぶら下げる。**DM は作らない**＝やり取りできる場所を残さない
--   ・読めるのは「送った人」と「その返信を書いた人」の2人だけ（他の宛先には見えない）
--   ・30日で自動的に終了する。送信者はいつでも早く終了でき、終了後は送信者だけが再開できる
--   ・再開すると、その日からまた30日
--
-- 【この migration を安全と判断した根拠（本番で実測・2026-09-21）】
--   ・既存のお知らせ 68件はすべて allow_reply=false になる＝**いままでと同じ（返信なし）**
--   ・「お知らせにぶら下がる投稿」（channel_id is null かつ parent_id あり）は **本番に0件**。
--     だから下で書き込みのポリシーを締めても、既存の動きは1つも変わらない
--
-- 🚨 新しい表は作らない（返信は既存の board_messages に入る）。
-- 🚨 2026-09-19 に public の関数から PUBLIC の実行許可を外したので、
--    新しい関数には authenticated への grant を**明示的に**書くこと。書き忘れると画面から呼べない。

-- ─────────────────────────────────────────
-- 1. 列
-- ─────────────────────────────────────────
alter table public.board_messages
  add column if not exists allow_reply     boolean not null default false,
  add column if not exists reply_until     date,
  add column if not exists reply_closed_at timestamptz;

comment on column public.board_messages.allow_reply is
  '返信を受け付けるお知らせか。送信画面のチェック（既定OFF）。false の間は返信を1件も作れない';
comment on column public.board_messages.reply_until is
  'この日まで返信を書ける（JST の日付・当日も書ける）。送信時にトリガーが board_reply_days() 日後を入れる';
comment on column public.board_messages.reply_closed_at is
  '送信者が手で終了した日時。null＝手では終了していない。再開すると null に戻る';

-- 返信を読むときに親で引くので索引を付ける（すでにあれば何もしない）
create index if not exists board_messages_parent_idx on public.board_messages (parent_id);

-- ─────────────────────────────────────────
-- 2. 返信を受け付ける日数（30日）
-- ─────────────────────────────────────────
-- 🚨 日数を持つのは**ここ1か所だけ**。画面は自分で 30 を持たない
--    （退職の retire_access_default() と同じ考え方。変えるときはこの関数だけを直す）
create or replace function public.board_reply_days()
returns integer
language sql
immutable
as $$ select 30 $$;

comment on function public.board_reply_days() is
  'お知らせの返信を受け付ける日数。30日で自動的に終了する。日数を変えるときはここだけを直す';

revoke execute on function public.board_reply_days() from public, anon;
grant  execute on function public.board_reply_days() to authenticated, service_role;

-- ─────────────────────────────────────────
-- 3. 送信したときに期限を自動で入れる
-- ─────────────────────────────────────────
-- 🚨 画面から日付を渡させない。渡させると「30日」が2か所に散る
create or replace function public.board_reply_set_until()
returns trigger
language plpgsql
as $$
begin
  if new.allow_reply and new.reply_until is null then
    new.reply_until := (now() at time zone 'Asia/Tokyo')::date + public.board_reply_days();
  end if;
  return new;
end;
$$;

drop trigger if exists trg_board_reply_set_until on public.board_messages;
create trigger trg_board_reply_set_until
  before insert on public.board_messages
  for each row execute function public.board_reply_set_until();

-- ─────────────────────────────────────────
-- 4. いま書けるか（判定は1か所）
-- ─────────────────────────────────────────
-- 🚨 画面（lib/boardReply.ts）とこの関数が同じ3つを見る。
--    画面だけで隠すと、締めたあとでも書けてしまう（場所予約の㉕と同型の失敗）
create or replace function public.board_reply_open(p_message_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(m.allow_reply, false)
     and m.reply_closed_at is null
     and m.reply_until is not null
     and m.reply_until >= (now() at time zone 'Asia/Tokyo')::date
    from public.board_messages m
   where m.id = p_message_id;
$$;

comment on function public.board_reply_open(uuid) is
  'そのお知らせにいま返信を書けるか。①返信を受け付ける ②手で終了していない ③期限内、の3つ';

revoke execute on function public.board_reply_open(uuid) from public, anon;
grant  execute on function public.board_reply_open(uuid) to authenticated, service_role;

-- ─────────────────────────────────────────
-- 5. その返信に関われる人か（送った人 or 受け取った人）
-- ─────────────────────────────────────────
create or replace function public.board_reply_party(p_message_id uuid, p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.board_messages m
     where m.id = p_message_id and m.user_id = p_user
  ) or exists (
    select 1 from public.board_message_recipients r
     where r.message_id = p_message_id and r.user_id = p_user
  );
$$;

comment on function public.board_reply_party(uuid, uuid) is
  'そのお知らせの当事者か（送った人 or 宛先の人）。返信を書ける人を決めるのに使う';

revoke execute on function public.board_reply_party(uuid, uuid) from public, anon;
grant  execute on function public.board_reply_party(uuid, uuid) to authenticated, service_role;

-- ─────────────────────────────────────────
-- 6. 書き込みのポリシー（返信だけを締める）
-- ─────────────────────────────────────────
-- 🚨 本番の実定義から起こしている。**変えたのは「channel_id is null」の1行を2つに割ったところだけ**で、
--    チャンネル（グループ・DM）の枝と「自分が送る」の条件には1文字も触っていない。
--      旧： or (channel_id is null)
--      新： or (channel_id is null and parent_id is null)                    ← ふつうのお知らせ（今までどおり）
--           or (channel_id is null and parent_id is not null and 開いている and 当事者)  ← 返信
drop policy if exists board_messages_insert on public.board_messages;
create policy board_messages_insert on public.board_messages
  for insert to authenticated
  with check (
    (user_id = auth.uid())
    and (
      (
        (channel_id is not null)
        and (
          (channel_id in (
            select board_channel_members.channel_id
              from public.board_channel_members
             where board_channel_members.user_id = auth.uid()
          ))
          or (((auth.jwt() -> 'app_metadata') ->> 'role') = 'admin')
        )
      )
      or (channel_id is null and parent_id is null)
      or (
        channel_id is null
        and parent_id is not null
        and public.board_reply_open(parent_id)
        and public.board_reply_party(parent_id, auth.uid())
      )
    )
  );

-- ─────────────────────────────────────────
-- 7. 終了する／再開する（送信者と管理者だけ）
-- ─────────────────────────────────────────
-- 🚨 security invoker のまま（＝呼んだ人の権限で動く）。board_messages の UPDATE ポリシーが
--    「自分が送ったもの or 管理者」なので、受け取った側は押しても1件も更新されない。
--    件数を返すので、画面は 0 件なら失敗として扱う（黙って成功にしない）
create or replace function public.board_reply_close(p_message_id uuid)
returns integer
language plpgsql
as $$
declare v_count integer;
begin
  update public.board_messages
     set reply_closed_at = now()
   where id = p_message_id
     and allow_reply
     and reply_closed_at is null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function public.board_reply_close(uuid) is
  'お知らせのやり取りを終了する。更新できた件数を返す（0＝権限が無いか、すでに終了している）';

revoke execute on function public.board_reply_close(uuid) from public, anon;
grant  execute on function public.board_reply_close(uuid) to authenticated, service_role;

create or replace function public.board_reply_reopen(p_message_id uuid)
returns integer
language plpgsql
as $$
declare v_count integer;
begin
  -- 🚨 再開したら、その日からまた board_reply_days() 日。無期限にはしない
  update public.board_messages
     set reply_closed_at = null,
         reply_until     = (now() at time zone 'Asia/Tokyo')::date + public.board_reply_days()
   where id = p_message_id
     and allow_reply;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function public.board_reply_reopen(uuid) is
  'お知らせのやり取りを再開する。その日から board_reply_days() 日でまた終了する。更新できた件数を返す';

revoke execute on function public.board_reply_reopen(uuid) from public, anon;
grant  execute on function public.board_reply_reopen(uuid) to authenticated, service_role;

-- ─────────────────────────────────────────
-- 取り消すとき（この migration を戻す手順）
-- ─────────────────────────────────────────
--   drop trigger if exists trg_board_reply_set_until on public.board_messages;
--   drop function if exists public.board_reply_set_until();
--   drop function if exists public.board_reply_reopen(uuid);
--   drop function if exists public.board_reply_close(uuid);
--   drop function if exists public.board_reply_party(uuid, uuid);
--   drop function if exists public.board_reply_open(uuid);
--   drop function if exists public.board_reply_days();
--   -- ポリシーは上の「旧」の形（or (channel_id is null)）に戻す
--   alter table public.board_messages
--     drop column if exists reply_closed_at,
--     drop column if exists reply_until,
--     drop column if exists allow_reply;

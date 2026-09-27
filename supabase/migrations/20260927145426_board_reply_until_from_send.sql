-- ============================================================
-- 2026-09-27  お知らせの返信の受付期限を「送った日から」にする／送ったあとに返信を ON にできるようにする
-- ============================================================
-- きっかけ（ユーザー指摘・2026-09-27）：受付期限（30日）が**予約した日**から数えられていた。
--   例：9/24 に予約・9/25 に届いた栗木先生あて → 10/24 まで（届いた日からなら 10/25）。
--   トリガー board_reply_set_until が insert の時点の日付（now()）で数えていたため。予約が先の日付ほど受付期間が短くなる。
-- ✅ ユーザー決定：
--   ・これから送るものは「届いた日から 30 日」。🚨 **すでにある2件（栗木先生 10/24・山田さん 10/27）はそのまま**
--   ・送ったあと（予約中を含む）も、送った本人が返信を OFF→ON にできる（画面は BoardPage。本人かは RLS の board_messages_update と画面で見る）
--
-- 直し方（本番の実定義から起こした。30 日は board_reply_days() の1か所のまま）：
--   ・基準日＝予約中なら予約日（JST）、それ以外は今日（JST）
--   ・insert：allow_reply なら 基準日＋30（予約は予約日から）
--   ・update：allow_reply が false→true（あとから ON）なら 基準日＋30、手で終了した印は外す
--             予約の日時を変えたら、新しい予約日から数え直す
--             予約が届いた（scheduled→sent）とき、**新しい計算で入れた期限（予約日＋30）のときだけ**届いた日＋30 に数え直す
--             （予約の送信が日付をまたいで遅れたときの保険。山田さんの 10/27 は古い計算＝予約した日から なので触らない）
--   ・トリガーは insert と、allow_reply・status・scheduled_at の update のときだけ動く（reply_until を書き換える再開の関数とは干渉しない）

create or replace function public.board_reply_set_until()
returns trigger
language plpgsql
as $$
declare
  v_today date := (now() at time zone 'Asia/Tokyo')::date;
  v_base  date;
begin
  v_base := case
    when new.status = 'scheduled' and new.scheduled_at is not null
      then (new.scheduled_at at time zone 'Asia/Tokyo')::date
    else v_today
  end;

  if tg_op = 'INSERT' then
    if new.allow_reply and new.reply_until is null then
      new.reply_until := v_base + public.board_reply_days();
    end if;
    return new;
  end if;

  -- UPDATE
  if new.allow_reply and not coalesce(old.allow_reply, false) then
    -- あとから返信を ON にした
    new.reply_until := v_base + public.board_reply_days();
    new.reply_closed_at := null;
  elsif new.allow_reply and new.status = 'scheduled'
        and new.scheduled_at is distinct from old.scheduled_at then
    -- 予約の日時を変えた
    new.reply_until := v_base + public.board_reply_days();
  elsif new.allow_reply and old.status = 'scheduled' and new.status = 'sent'
        and new.reply_closed_at is null
        and old.scheduled_at is not null
        and old.reply_until = (old.scheduled_at at time zone 'Asia/Tokyo')::date + public.board_reply_days() then
    -- 予約が届いた：届いた日から数え直す（新しい計算で入れた期限のときだけ）
    new.reply_until := v_today + public.board_reply_days();
  end if;
  return new;
end;
$$;

comment on function public.board_reply_set_until() is
  'お知らせの返信の受付期限（reply_until）を入れる。予約は予約日から、届いたら届いた日から、あとから ON にしたらその日（予約中は予約日）から board_reply_days() 日';

drop trigger if exists trg_board_reply_set_until on public.board_messages;
create trigger trg_board_reply_set_until
  before insert or update of allow_reply, status, scheduled_at on public.board_messages
  for each row execute function public.board_reply_set_until();

comment on column public.board_messages.reply_until is
  'この日まで返信を書ける（JST の日付・当日も書ける）。トリガーが「届いた日（予約は予約日）＋ board_reply_days() 日」を入れる';

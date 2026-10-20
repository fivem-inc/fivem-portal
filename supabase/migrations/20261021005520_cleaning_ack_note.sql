-- ============================================================
-- 2026-10-21  掃除担当表の［確認した］に理由（任意）を残せるようにする（ユーザー確定）
-- ============================================================
-- ・きっかけ：成田先生の「同じ時間に こども 西陣校 17:40 チャレンジ（サポート）にも入っています」の ⚠️。
--   チャレンジの日（月1回ほど）は終わってからごみ捨てをするので問題ないが、［確認した］では理由が残らず、あとで見た人に分からない
-- ・cleaning_acks に note（空でも可・200字まで）を足すだけ。権限（シフト管理を開ける人だけ読める・自分の名前でだけ足せる）は今のまま。
--   直す手段は作らない（マスの中身を変えると確認済みは外れ、もう一度確かめる形＝今と同じ）
-- ・🔴 には［確認した］を出さない（画面の決まり・今までどおり）

begin;

alter table public.cleaning_acks
  add column if not exists note text;

alter table public.cleaning_acks
  drop constraint if exists cleaning_acks_note_len;
alter table public.cleaning_acks
  add constraint cleaning_acks_note_len check (note is null or length(btrim(note)) between 1 and 200);

comment on column public.cleaning_acks.note is '［確認した］のときの理由（任意・200字まで）。例：チャレンジの日（月1回ほど）は、終わってからごみ捨てをする';

commit;

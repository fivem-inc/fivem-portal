-- 連絡板：お知らせに「宛先をどう選んだか」を残す（2026-09-08 ユーザー確定・案A）
--
-- 背景：送信トレイから「コピーして作成」できるようにする。これまで宛先は人のID一覧
--       （board_message_recipients）しか残っておらず、コピーすると「当時の10人」になり、
--       昇格した人は入らず、外れた人は残ったままになる。
--
-- ・recipient_presets   … 送信時に「全員が宛先に入っていた一括ボタン」の名前
--                         （例：{マネージャー・リーダー}）。押した記録ではなく、送信時の宛先から
--                         機械的に判定する（押し忘れ・押し直しに左右されない）
-- ・recipient_extra_ids … どのボタンにも含まれず、個別に足した人
-- コピー時の宛先 ＝ ボタンの「いまの該当者」 ∪ 個別に足した人（在籍者のみ）。
-- 🚨 過去のお知らせは両方 null。その場合は当時のID一覧（在籍者のみ）で復元し、
--    「役職が変わった人は反映されません」と案内する。
-- 読み書きの権限は既存の board_messages のポリシーのまま（本人 or 管理者が書く）。

alter table public.board_messages
  add column if not exists recipient_presets   text[],
  add column if not exists recipient_extra_ids uuid[];

comment on column public.board_messages.recipient_presets   is '送信時に全員が宛先に入っていた一括ボタン名（コピーして作成で「いまの該当者」に当て直す）';
comment on column public.board_messages.recipient_extra_ids is 'ボタン以外で個別に足した宛先（コピーして作成で在籍者のみ引き継ぐ）';

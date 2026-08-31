-- ============================================================
-- 場所予約：お客様の姓名・ふりがな・携帯番号（2026-08-31 ユーザー指示）
--
-- やりたいこと:
--   ・名字と名前を両方出す
--   ・下の名前は**ひらがな**で出す（例「田中 たろう」）
--   ・固定電話と携帯の両方があるときは両方出す
--
-- 🚨 漢字からひらがなは作れない（同じ漢字でも読みが複数ある）。
--    スコラプラスの出力に**カタカナのフリガナ列がある**ことを確認したうえで、
--    取り込み時にカタカナ→ひらがなへ直す。この変換は文字コードの計算だけで
--    できるので、推測が入らず安全。
--
-- 列の分け方:
--   full_name（氏名まるごと）は今までどおり残す。取り込み元をそのまま持っておくと、
--   分け方を間違えたときに元に戻せる。
--   そのうえで last_name / first_name / last_kana / first_kana を足す。
--   🚨 CSVが「氏名」1列でも「姓」「名」2列でも取り込めるようにするため、
--      画面側で両方に対応する（列の対応づけで選べる）。
--
-- 連絡先:
--   phone（固定）に加えて mobile（携帯）を足す。
--   🚨 どちらか片方しか無いことも多いので、両方 null 可。ある方だけ出す。
--
-- ロールバック手順:
--   alter table room_customers drop column last_name, drop column first_name,
--     drop column last_kana, drop column first_kana;
--   alter table room_customer_contacts drop column mobile;
-- ============================================================

alter table room_customers
  add column if not exists last_name  text,   -- 姓（漢字）例：田中
  add column if not exists first_name text,   -- 名（漢字）例：太郎
  add column if not exists last_kana  text,   -- 姓のふりがな（ひらがなで入れる）
  add column if not exists first_kana text;   -- 名のふりがな（ひらがなで入れる）例：たろう

comment on column room_customers.first_kana is
  '名のふりがな。ひらがなで持つ。取り込み時にカタカナから変換する。予約表の表示に使う';

alter table room_customer_contacts
  add column if not exists mobile text;       -- 携帯番号。phone は固定電話

comment on column room_customer_contacts.phone  is '固定電話（家電）';
comment on column room_customer_contacts.mobile is '携帯番号。両方あるときは両方出す';

-- 確認用:
--   select member_no, last_name, first_name, first_kana, display_name
--     from room_customers order by member_no limit 20;

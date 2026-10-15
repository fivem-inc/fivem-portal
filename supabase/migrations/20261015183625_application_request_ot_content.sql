-- 申請の依頼に「申請内容」を持たせる（2026-10-15 ユーザー確定）
-- きっかけ：上長が調整休の依頼を「休暇」で作り、本人が申請できずにやり直しになった（10/15 実例）。
-- ・依頼の種類が「残業・時間管理」のとき、上長が申請内容を必ず選ぶ（画面で必須）：
--     time        … 時間（残業・早出・早退・遅出）。本人が時刻を入れると種別は自動で決まる
--     chosei_off  … 時間外調整休
--     furikae_off … 振替休日
--     absence     … 欠勤
--     self        … 本人が選択（上長が決められないとき・今までと同じ）
-- ・本人が依頼から申請を始めると、終日の3つ（chosei_off / furikae_off / absence）は申請の画面に最初から入る
-- 🚨 DB では空を許す（休暇の依頼・シフト調整の決定で作る依頼・これまでの依頼は空のまま）。必須にするのは画面だけ
-- 🚨 値は残業の申請の種別（overtime_reports.application_types）と同じ綴り。新しい綴りを作らない

begin;

alter table public.application_requests add column if not exists ot_content text;

alter table public.application_requests drop constraint if exists application_requests_ot_content_check;
alter table public.application_requests add constraint application_requests_ot_content_check
  check (ot_content is null or (kind = 'overtime' and ot_content in ('time', 'chosei_off', 'furikae_off', 'absence', 'self')));

comment on column public.application_requests.ot_content is
  '残業の依頼の申請内容（time／chosei_off／furikae_off／absence／self＝本人が選択）。終日の3つは本人の申請画面に最初から入る。休暇の依頼は空';

commit;

-- 残業：事前申請を上長が受理した日時を残す
--
-- 【背景】
-- これまで事前受理は status を 'request_confirmed' に変えるだけで、
-- 日時も履歴も残していなかった（overtime_report_history に書くのは取消のときだけ）。
-- そのため実績報告で status が 'reported' に進むと、
-- 「事前に受理されていたのか、受理を飛ばして報告されたのか」がどこにも残らない。
--
-- 2026-08-25 に「受理を待たずに実績報告できる」ようにしたので、
-- 上長が確認画面を見たときに
--   ・事前受理済み → 予定との差だけ見ればよい
--   ・事前受理なし → 予定の妥当性と実績をまとめて判断する必要がある
-- という判断ができるように、受理の日時を1列だけ持つ。
--
-- 🚨 既存の行はすべて null になるが、この変更より前は必ず事前受理を経ているため
--    「null＝導入前で不明」として扱えばよい（実害なし）。
--    画面では created_at がこの導入日より後の行だけ「事前受理なし」と表示する。

alter table public.overtime_reports
  add column if not exists request_confirmed_at timestamptz;

comment on column public.overtime_reports.request_confirmed_at is
  '事前申請を上長が受理した日時。null は「受理を経ていない」または「2026-08-25 の導入より前」';

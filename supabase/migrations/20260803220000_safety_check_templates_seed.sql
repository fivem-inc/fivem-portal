-- 安否確認の定型メッセージ 初期データ（管理画面から追加・編集・削除可能。これはあくまで見本）
-- 冪等：同じタイトルが既にあれば挿入しない（再実行しても増殖しない）
insert into safety_check_templates (title, body, pattern, sort_order)
select v.title, v.body, v.pattern, v.sort_order
from (values
  ('地震の安否確認', '地震が発生しました。皆さんの安否を確認します。ボタンで回答してください。', 'safety3', 1),
  ('台風・大雪の安否＋出勤確認', '台風（大雪）の影響が予想されます。安否と出勤の可否を確認します。ボタンで回答してください。', 'safety4', 2),
  ('緊急の出勤確認', '緊急のご連絡です。本日の出勤の可否を確認します。本日出勤予定でない方にもお送りしています。全員回答をお願いします。', 'attendance2', 3),
  ('【訓練】安否確認の訓練', 'これは訓練です。実際の災害ではありません。安否確認の操作を確認するため、ボタンで回答してください。', 'safety3', 4)
) as v(title, body, pattern, sort_order)
where not exists (select 1 from safety_check_templates t where t.title = v.title);

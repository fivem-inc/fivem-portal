-- 定型メッセージの並び順・本文の見直し
--   ・地震を2つ並べ、その次に台風・大雪（実際に使う順に合わせる）
--   ・訓練は災害の定型文と混ざらないよう最後にまとめる（画面側でも別グループに表示）
--   ・出勤確認の本文に「〇〇が発生しました」の穴埋め例を入れ、そのまま送らず状況を書き足せるようにする

update safety_check_templates set sort_order = 1 where title = '地震の安否確認';
update safety_check_templates set sort_order = 2 where title = '地震の安否確認（出勤可否つき）';
update safety_check_templates set sort_order = 3 where title = '台風・大雪の安否＋出勤確認';
update safety_check_templates set sort_order = 4 where title = '緊急の出勤確認';
update safety_check_templates set sort_order = 5 where title = '応援要請（急な人手不足）';
update safety_check_templates set sort_order = 9 where title = '【訓練】安否確認の訓練';

update safety_check_templates
   set body = '緊急のご連絡です。〇〇が発生しました。本日の出勤の可否を確認します。本日出勤予定の方は、出勤の可否をお知らせください。予定がない方も、応援に入れる場合はお知らせください。'
 where title = '緊急の出勤確認';

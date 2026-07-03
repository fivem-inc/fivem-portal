-- 未使用機能（お知らせのコメント欄）の削除：UIから作成する手段が無く、一度もtrueにならないため
alter table public.board_messages drop column if exists comment_enabled;

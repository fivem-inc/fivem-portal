-- メールテンプレートの本文に「\n」という文字列がそのまま(バックスラッシュ+n)入っており、
-- 実際の改行として送信されず、メール本文に \n が文字通り表示されるバグを修正する。
-- （通常の'...'リテラルはPostgreSQLではバックスラッシュをエスケープとして解釈しないため）
update notification_settings
set template = replace(template, '\n', chr(10))
where channel = 'email' and template like '%\n%';

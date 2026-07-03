-- 上部お知らせバナーの表示可否を、ベル通知の read/dismissed とは独立させる
alter table notifications add column if not exists banner_dismissed boolean default false;

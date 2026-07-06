-- 「用途」選択肢からユーザー指摘により「イベント」を削除する
DELETE FROM public.master_options WHERE category = 'purchase_purpose' AND value = 'イベント';

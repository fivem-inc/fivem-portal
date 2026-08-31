-- ============================================================
-- 場所予約（/rooms）を「マネージャー以上」に絞る（2026-08-31 ユーザー確定・案A）
--
-- これまで:
--   場所予約だけ役職で絞らず、ログインしていれば全員に出していた
--   （App.tsx にも「権限では絞らない（全スタッフが使う）」と書いてあった）。
--
-- これから:
--   他のページと同じく feature_permissions（役職×機能のON/OFF）で出し分ける。
--   管理画面「役職・機能権限」から、あとで自由に変えられる。
--
-- 初期値（ユーザー確定）:
--   ON  … マネージャー ／ 社長 ／ 管理者
--   OFF … パート ／ 一般 ／ リーダー ／ フロア責任者
--
--   🚨 **フロア責任者は含めない**（案A）。
--      CLAUDE.md「役職序列」のとおり、フロア責任者はリーダーより下位という
--      整理だが、roles テーブルの sort_order ではマネージャーより後ろに
--      並んでいる（パート1/一般2/リーダー3/マネージャー4/フロア責任者5/社長6）。
--      **並び順と序列が一致していない**ので、「マネージャー以上」を
--      sort_order で判定してはいけない。役職名を明示して入れる。
--
-- 🚨 このファイルは feature_permissions に行を足すだけで、
--    既存の役職・既存の権限行には触らない。
--
-- ロールバック手順:
--   delete from feature_permissions where feature_key = 'room_booking';
-- ============================================================

insert into public.feature_permissions (role_id, feature_key, enabled)
select r.id,
       'room_booking',
       r.name in ('マネージャー', '社長', '管理者')
  from public.roles r
on conflict (role_id, feature_key) do nothing;

-- 確認用（実行後に目視すると安心）:
--   select r.name, fp.enabled
--     from public.feature_permissions fp
--     join public.roles r on r.id = fp.role_id
--    where fp.feature_key = 'room_booking'
--    order by r.sort_order;

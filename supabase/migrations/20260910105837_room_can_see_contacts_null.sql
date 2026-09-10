-- ============================================================
-- 場所予約：room_can_see_contacts() が NULL を返すのをやめる
--            （2026-09-10 ユーザー承認）
--
-- 何が起きていたか:
--   連絡先の公開範囲が 'admin'（管理者のみ）のとき、
--     (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
--   は、app_metadata.role を持たない人（＝一般スタッフ全員）で
--   「false」ではなく **NULL** になる。case 全体の値も NULL になる。
--
-- いま実害が出ていない理由:
--   この関数を呼んでいるのは room_customer_contacts_select の
--   `using (room_can_see_contacts())` 1か所だけで、RLS の using は
--   NULL を「不許可」として扱う＝閉じる側に倒れている。
--   `not room_can_see_contacts()` の形はコードにもSQLにも1件も無い（2026-09-10 実測）。
--
-- なぜ直すか:
--   将来「not 判定()」を書いた人が、NULL のせいで権限チェックを素通りさせてしまう。
--   申請系で同じ形の穴が7本見つかっている（20260909213655）。
--
-- 🚨 誰の見え方も変わらない:
--   唯一の呼び出し先では NULL がすでに false と同じ扱いなので、
--   false に確定させても結果は同一。「見えるべき人が見えなくなる」ことはない。
--
-- ロールバック手順:
--   20260829400000_room_customers.sql の 150 行目からの定義を流し直す
--   （coalesce を外すだけ）。
-- ============================================================

create or replace function room_can_see_contacts() returns boolean
language sql stable security definer set search_path = public as $$
  -- 🚨 coalesce で false に確定させる。真ん中の枝が NULL を返しうるため
  --    （app_metadata.role を持たない人では NULL = 'admin' が NULL になる）
  select coalesce(
    case coalesce((select value from room_settings where key = 'contact_visibility'), 'staff')
      when 'all'   then auth.uid() is not null
      when 'admin' then (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
      else room_is_staff()
    end, false);
$$;

comment on function room_can_see_contacts() is
  'お客様の連絡先を見てよいか。設定 contact_visibility（all/staff/admin）で決まる。'
  '🚨 NULL を返さない（2026-09-10）。判定関数が NULL を返すと、呼び出し側の not 判定() が NULL になり権限チェックが素通りする';

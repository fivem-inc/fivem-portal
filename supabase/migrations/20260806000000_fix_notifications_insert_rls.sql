-- 🚨 一般・パート・フロア責任者が出した申請の通知が、丸ごと消えていた不具合の修正
--
-- 症状：申請しても承認者のベル一覧に出ず、プッシュも飛ばない。
--       （ホームの集計バナー・ナビの件数バッジ・Slack・メールは別経路なので生きていた）
-- 原因：notifications の INSERT ポリシーが「リーダー以上」限定
--       （20260610100000_create_notifications.sql:16）。通知はクライアントから
--       直接 insert しているため、それ未満の役職では 42501 で弾かれていた。
--       insertNotification は console.error に出すだけ、呼び出し側も
--       .then(null, () => {}) で握りつぶすので、誰も気づけなかった。
--
-- 影響していた経路（すべてこの1本で直る）
--   休暇申請・交通費・出張報告・備品購入申請・残業申請・連絡板（DM/お知らせ/リマインド）
--   ＋ 勤務変更報告（ShiftReportPage.tsx:587 は insertNotification を通さず直接 insert
--      しているため、関数側だけ直す案では取り残されるところだった）
--
-- 方針：ゲートを「ログイン中の本人が、自分名義で作る」に緩め、created_by で追跡できるようにする。
--       ・機能ごとに専用RPCを作る案は、宛先解決（誰が承認者か）をSQLに複製することになり、
--         このプロジェクトが何度も事故っている「同じルールを2か所に書く」型になるため採らない。
--       ・連絡板のDM/お知らせは宛先が「画面で選んだ任意の人」なので、
--         専用RPCにしても守れる不変条件がそもそも存在しない。
--
-- 追加＋ポリシー差し替えのみ。既存データは無傷・冪等。

-- 誰が作った通知かの記録。
-- ⚠️ on delete set null は必須。
--    省略すると、削除対象の人が作った通知が他人宛に残っているときに外部キー違反となり、
--    delete-user（新規登録の「拒否して削除」で使うアカウント完全削除）が失敗する。
alter table public.notifications
  add column if not exists created_by uuid references auth.users(id) on delete set null;

-- 既定値で入れる＝クライアント側は一切変更不要。
--   ・Edge Function（service_role）は auth.uid() が null → created_by も null。RLS自体を素通り
--   ・SECURITY DEFINER の RPC（correction / safety / clock_inquiry / proposal）は
--     auth.uid() が呼び出した本人を返すので、そのまま実行者が記録される
alter table public.notifications
  alter column created_by set default auth.uid();

create index if not exists idx_notifications_created_by
  on public.notifications (created_by);

drop policy if exists "Approvers can insert notifications" on public.notifications;

-- 既定値のまま insert すれば必ず一致する。created_by を他人に詐称することはできない。
create policy "Authenticated can insert own-authored notifications"
  on public.notifications for insert to authenticated
  with check (created_by = auth.uid());

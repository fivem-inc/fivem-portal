-- 出張報告の「履歴」タブ（全員分の報告を閲覧）を役職ごとに許可できるようにする
--
-- きっかけ：社長にサイト通知・プッシュが毎回届いているのに、報告の中身を見る画面が
--   管理者アカウント専用（/admin）しか無く、社長では1件も閲覧できなかった。
--   しかも RLS は「見えない」ときエラーではなく 0 行を返すので、誰も気づけない状態だった。
--
-- 🚨 notification_settings の trip:report_arrival / trip:report_end の宛先に役職を足すときは、
--    この feature_permissions の trip_report_history にも同じ役職をONにすること。
--    片方だけ変えると「通知は届くのに履歴が空」という、エラーの出ない不整合が再発する。

-- ① 役職ごとの権限行を作る（既定は社長のみON）
--    FeaturePermissionsTab は「保存ボタンを押したとき」に全役職×全機能を upsert する作りなので、
--    seed しておかないと、管理画面で一度保存するまで行が1件も存在しない
insert into public.feature_permissions (role_id, feature_key, enabled)
select r.id, 'trip_report_history', (r.name = '社長')
from public.roles r
on conflict (role_id, feature_key) do nothing;

-- ② 権限を持つ役職は全員分の出張報告を閲覧できる
--    has_feature_permission() は SECURITY DEFINER（profiles / roles / feature_permissions を
--    RLS を通さずに読む）ため相互再帰しない。管理者判定も app_metadata 経由で正しい。
--    既に overtime_summary / shift_pattern_directory で本番稼働している方式に揃えた。
--    ※ 閲覧のみ。INSERT / UPDATE / DELETE の権限は増やさない（削除は従来どおり管理者のみ）
drop policy if exists "trip_history_viewer_select" on public.business_trip_reports;
create policy "trip_history_viewer_select" on public.business_trip_reports
  for select to authenticated
  using (public.has_feature_permission('trip_report_history'));

-- ③ 内容が完全に同一の管理者 SELECT ポリシーが2本あったので1本に整理する
--    （どちらも app_metadata.role = 'admin' 判定。"Admins can view all reports" を残す）
drop policy if exists "Admins can view all trip reports" on public.business_trip_reports;

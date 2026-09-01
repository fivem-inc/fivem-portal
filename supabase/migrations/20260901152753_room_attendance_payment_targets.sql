-- ============================================================
-- 場所予約：支払いの記入欄を出す出欠を入れ替える（2026-09-01 ユーザー指示）
--
--   キャンセル料   … 支払い欄は **不要**（外す）
--   キャン1回消化 … 支払い欄が **必要**（付ける）
--
-- 「キャン1回消化」は来ていないが**回数を1回使っている**（出席扱い）ので、
-- 10回区切りの一覧表と突き合わせる対象になる。キャンセル料は回数を使わないため要らない。
--
-- 🚨 この設定は**画面からも変えられる**（基本設定 → 出欠の選択肢 → 支払いのチップ）。
--    ここに書くのは、新しい環境を作り直したときに同じ初期値になるようにするため。
--    今後の変更はSQLではなく画面から行ってよい。
--
-- ロールバック手順:
--   update room_attendance_options set payment_purposes = '{プライベート}' where name = 'キャンセル料';
--   update room_attendance_options set payment_purposes = null            where name = 'キャン1回消化';
-- ============================================================

update room_attendance_options
   set payment_purposes = null, updated_at = now()
 where name = 'キャンセル料';

update room_attendance_options
   set payment_purposes = '{プライベート}', updated_at = now()
 where name = 'キャン1回消化';

-- 確認用:
--   select name, purposes, payment_purposes from room_attendance_options order by sort_order;
--   → 支払い欄が出るのは「出席」と「キャン1回消化」の2つだけになる

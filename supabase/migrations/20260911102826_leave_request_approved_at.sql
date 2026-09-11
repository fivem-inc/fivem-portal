-- 休暇の「1人目・2人目がいつ受理したか」を残す（2026-09-11 ユーザー要望・案Aで確定）
--
-- きっかけ：確認待ち一覧に「最初の受理者：◯◯ ✓ ／ 2人目の受理者：◯◯ ✓」と出したところ、
--   「いつかもみえるかな？？」と聞かれた。調べると**どこにも記録が無かった**。
--
-- 🚨 **`updated_at` では代用できない。** あれは「最後に何かが起きた日時」なので、
--    2人目が受理したあとに1人目の日時として出すと**嘘になる**
--    （「相談した日」を created_at で代用しなかったのと同じ理由）。
-- 🚨 `leave_approvals`（受理の履歴を1行ずつ残す表）は**存在するが0行＝一度も使われていない**。
--    そちらを使い始める案（案B）は、書き込み箇所が増えるうえ
--    **記録が貯まるので掃除の仕組みもセットで必要**になる。いま欲しいのは「いつ受理したか」の
--    1点なので、まず列で持つ。必要になったら、この値を最初の履歴として案Bへ移せる。
-- 🚨 **過去の申請は空のまま**（遡って入れられない）。空のときは画面に日付を出さない。
--    推測して入れない（間違った日付を事実として出すことになる）。
-- 🚨 時刻まで持つ（timestamptz）。表示は日付だけにするが、
--    同じ日に2人が受理したときの前後を後から追えるようにしておく。
-- 🚨 **新しい許可（ポリシー）は足していない。** 既存の leave_requests の更新の許可で書ける。
--    列を足すだけなので、行の見え方は1件も変わらない。
--
-- 書き込む場所は client/src/components/LeaveApprovals.tsx の **3か所だけ**：
--   ① handleApproveWithManager … 1人目が受理してマネージャーを指名  → approved_at
--   ② handleApproveAsSelf      … 1人目が2人目を兼ねて受理           → approved_at と approved2_at の両方
--   ③ handleApprove（step2_pending のとき）… 2人目の受理            → approved2_at
--   🚨 経理・社長の受理（manager_approved → admin_approved → approved）では書かない。
--      この2列は「1人目・2人目」専用。

alter table public.leave_requests
  add column if not exists approved_at  timestamptz,
  add column if not exists approved2_at timestamptz;

comment on column public.leave_requests.approved_at is
  '1人目（approver_id）が受理した日時。2026-09-11 より前の申請は null（遡って入れていない）。経理・社長の受理では更新しない';
comment on column public.leave_requests.approved2_at is
  '2人目（approver2_id）が受理した日時。2026-09-11 より前の申請は null（遡って入れていない）。経理・社長の受理では更新しない';

-- 自己受理した事前申請に「事前受理の日時」を埋める（2026-09-20・長岡さんの指摘）
--
-- 【何が起きていたか】
--   上長が受理する経路（Edge Function overtime-approve）は request_confirmed_at を入れる。
--   ところが自己受理（マネージャー以上）はその経路を通らず、画面から直接
--   status='request_confirmed' で保存していたため、**日時だけ空**だった。
--   空のまま実績を報告すると、確認の画面が
--   「⚠️ 事前申請の受理をしていません。予定と実績をまとめて確認してください。」と出す。
--   状態としては受理できているのに、画面が嘘をつく。
--
-- 【これから】画面側で、自己受理の事前申請にも日時を入れるよう直した（同じ日の push）
-- 【これまで】この migration で、空欄に「送信した日時」を入れる。
--   🚨 自己受理は**送信と同時に受理**なので、created_at が実際の受理時刻そのもの。
--
-- 🚨 絞り込みの条件（他人が受理した行・事後報告・事前申請を経ていない行を触らない）
--   ・request_confirmed_at が空
--   ・自分で受理した（confirmed_by = applicant_id）
--   ・手入力・事後報告ではない
--   ・**事前申請の予定（planned の内訳）が残っている**＝本当に事前申請を経た行だけ
--   ・日時を記録し始めた 2026-08-25 以降（それより前は「不明」のままにする。画面も警告を出さない）

update public.overtime_reports o
   set request_confirmed_at = o.created_at
 where o.request_confirmed_at is null
   and o.status in ('request_confirmed', 'reported', 'confirmed')
   and o.entry_type = 'manual'
   and o.is_post_hoc = false
   and o.confirmed_by = o.applicant_id
   and o.created_at >= '2026-08-25'
   and exists (
     select 1 from public.overtime_report_segments s
      where s.report_id = o.id and s.phase = 'planned'
   );

-- 戻し版（この migration を取り消すとき）:
--   🚨 「もともと空だった行」を選び直せないので、戻すなら適用前に id の一覧を控えておくこと。
--      控えが無い場合は、request_confirmed_at = created_at かつ confirmed_by = applicant_id の行が対象。

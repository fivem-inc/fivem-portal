-- ============================================================
-- 新しく使いはじめた event_key のプッシュ設定を作る（キルスイッチの確保）
-- ============================================================
-- 🚨 push-dispatch は「設定行が無い event_key はON扱い」で送る。
--    行を作っておかないと、管理画面からOFFにする手段が無くなる（止めたいときに止められない）。
-- 対象3件（すべて 2026-08-18 に飛び先・文面の総点検で追加）
--   overtime:threshold_summary        … 残業の目安超過（上長向けのまとめ）。本人向けと event_key を
--                                        共用していたため上長が自分の履歴に着地していた
--   purchase_request:opinion_submitted … 備品の審議中の回覧。event_key が無くプッシュが飛んでいなかった
--   overtime_proposal:responded 等は既存行があるため対象外
-- ・既定はON（今までプッシュが飛んでいた/飛ぶべきだったものを止めないため）
-- ・何度実行しても同じ結果

insert into public.notification_settings (event_key, channel, enabled, recipient, subject, template)
values
  ('overtime:threshold_summary','push', true, null, null, null),
  ('purchase_request:opinion_submitted','push', true, null, null, null)
on conflict (event_key, channel) do nothing;

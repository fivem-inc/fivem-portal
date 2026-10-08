-- 大人シフト表の P を「固定」と「目安」に分ける（2026-10-08 ユーザー確定）
-- きっかけ：大人の先生から「P（プライベート）は会員様の希望で毎週変わる。表に書いてある P も流動的で、
--          代理分や 7月以降に増えた分は入っていない」。表の P を全部そのまま重なりの判定に使うと、合っていない ⚠️ が出る。
-- ・private（P）       … 毎週決まっている予約。今までどおり表に出し、こどもシフト表などとの重なりも見る
-- ・private_tbd（P（目安）） … 週ごとに変わる予約。表には薄く出すが、重なりは見ない（画面側で外す・lib/shiftCross.ts ほか）
-- ・issue_mode は day_only（その曜日が休みかどうかだけ見る。時刻は流動的なので勤務時間の外でも ⚠️ にしない）
-- 🚨 表の作り（列）は変えない。行の種類を1つ足すだけ（kids_shift_check_items は kids_shift_row_kinds を読んで判定する）

insert into public.kids_shift_row_kinds (key, label, has_class, has_groups, has_people, issue_mode, sort_order, active, boards, default_minutes)
values ('private_tbd', 'P（目安）', false, false, true, 'day_only', 25, true, array['adult'], 30)
on conflict (key) do nothing;

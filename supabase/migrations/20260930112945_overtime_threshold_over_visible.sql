-- 2026-09-30  部門集計に「目安超え」の札を出すための関数（ユーザー確定）
--
-- 部門集計（残業ページ → 履歴 → 部門集計）で、目安を超えた人の名前の横に札を出し、
-- 上長向けのお知らせ（overtime:threshold_summary）から来たときはその行を光らせる。
--
-- 🚨 ホームのバナー用の overtime_threshold_banner() は使えない。
--    バナーを「✕」「後で」で閉じた人を外して返す作りなので、閉じたあとは札が消えてしまう。
-- 🚨 返すのは部門集計に並ぶ人（overtime_visible_roster()＝部門集計の権限があり、自分と同じか下の役職）だけ。
--    範囲の判定を書き写さず、名簿の関数をそのまま使う（片方だけ直す事故を防ぐ）。
-- 🚨 自分は返さない。本人には札を出さない（2026-09-30 ユーザー確定：申請をためらわせないため。本人は通知から来たときに光るだけ）

create or replace function public.overtime_threshold_over_visible(p_period date)
returns table(user_id uuid, total_minutes integer, threshold_minutes integer)
language sql
stable
security definer
set search_path to 'public'
as $$
  select o.user_id, o.total_minutes, o.threshold_minutes
  from overtime_threshold_over(p_period) o
  join overtime_visible_roster() v on v.id = o.user_id
  where o.user_id <> auth.uid();
$$;

comment on function public.overtime_threshold_over_visible(date) is
  '部門集計の「目安超え」の札。部門集計に並ぶ人（overtime_visible_roster）のうち、その期に目安を超えた人。自分は含めない';

-- 🚨 Supabase は新しい関数に anon の実行権限を自動で付ける。from public だけでは外れない
revoke execute on function public.overtime_threshold_over_visible(date) from public;
revoke execute on function public.overtime_threshold_over_visible(date) from anon;
grant execute on function public.overtime_threshold_over_visible(date) to authenticated;

-- 緊急修正（2026-09-19）：20260918223959 で profiles.retired_role_id に roles への外部キーを付けたため、
-- profiles→roles の埋め込み（roles!inner(...) 等）が PGRST201（どちらの参照で結ぶか決められない）で全部失敗していた。
-- 休暇申請の申請先が「受理者が登録されていません」になる等。列と値は残し、外部キーだけ外す。
-- 🚨 profiles に roles への外部キーを2本目として足さないこと（埋め込みが壊れる）
alter table public.profiles drop constraint if exists profiles_retired_role_id_fkey;
notify pgrst, 'reload schema';

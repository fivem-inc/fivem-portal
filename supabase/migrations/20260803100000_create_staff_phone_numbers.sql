-- ========================================
-- 安否確認機能 Phase 1：緊急連絡先（電話番号）
--   ⚠️ profiles は SELECT using(true)＝全認証ユーザーが読めるため、
--      電話番号は profiles に列追加せず必ずこの専用テーブルに置く（プライバシー）。
--   閲覧＝本人＋マネージャー以上のみ。
--   Phase 2（安否確認コア）で「進行中の安否確認がある間だけリーダーも閲覧可」を
--   このテーブルの SELECT ポリシー再作成で追加する予定。
-- 追加のみ・既存データ無傷。
-- ========================================

-- 役職ヘルパー（Phase 2 以降の安否確認RLSでも共用する土台）
-- SECURITY DEFINER＝RLSを通さず profiles を読む。ポリシー内のクロステーブル参照を
-- この関数に寄せることで、RLS相互再帰（board_message_recipients で実際に起きた事故）を防ぐ。
create or replace function is_manager_plus() returns boolean
language sql stable security definer set search_path = public
as $$
  select is_admin() or exists (
    select 1 from profiles
     where id = auth.uid()
       and role_title in ('マネージャー','社長','管理者')
       and is_active = true
  );
$$;

create or replace function is_leader() returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from profiles
     where id = auth.uid()
       and role_title = 'リーダー'
       and is_active = true
  );
$$;

-- 緊急連絡先（1人1行）
create table if not exists staff_phone_numbers (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  phone      text not null,
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now()
);

-- updated_by / updated_at はトリガーで自動記録（クライアントの渡し忘れを防ぐ）
create or replace function set_staff_phone_audit() returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  new.updated_by := auth.uid();
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_staff_phone_audit on staff_phone_numbers;
create trigger trg_staff_phone_audit
  before insert or update on staff_phone_numbers
  for each row execute function set_staff_phone_audit();

alter table staff_phone_numbers enable row level security;

-- 閲覧：本人＋マネージャー以上（Phase 2 で「is_leader() and 進行中の本番安否確認あり」を追加予定）
drop policy if exists spn_select on staff_phone_numbers;
create policy spn_select on staff_phone_numbers for select to authenticated
  using (user_id = auth.uid() or is_manager_plus());

-- 登録・修正・削除：本人＋管理者（管理者が初期登録を行う運用。新規入社者は本人が登録）
drop policy if exists spn_insert on staff_phone_numbers;
create policy spn_insert on staff_phone_numbers for insert to authenticated
  with check (user_id = auth.uid() or is_admin());

drop policy if exists spn_update on staff_phone_numbers;
create policy spn_update on staff_phone_numbers for update to authenticated
  using (user_id = auth.uid() or is_admin())
  with check (user_id = auth.uid() or is_admin());

drop policy if exists spn_delete on staff_phone_numbers;
create policy spn_delete on staff_phone_numbers for delete to authenticated
  using (user_id = auth.uid() or is_admin());

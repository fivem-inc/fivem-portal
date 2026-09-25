-- ============================================================
-- 2026-09-25  残業：「自分で確定（自己受理）」をマネージャー以上だけに締める
-- ============================================================
-- 【見つけたこと】
--   ① 自己受理を「マネージャー以上だけ」にしていたのは**画面だけ**だった。
--      overtime_insert_own / overtime_update_own は欠勤しか止めておらず、仕組みを知っていれば
--      一般の方でも自分の残業を confirmed（確定）や request_confirmed（事前受理）で保存できた。
--   ② 欠勤の自己確定の判定 `overtime_role_rank(auth.uid()) <= 2` が、9/10 の役職の属性化で
--      **管理者(1)・社長(2) だけ**を指すようになっていた（マネージャーは 3 に下がった）。
--      画面は「欠勤の自己受理はマネージャー以上」なので、マネージャーが欠勤を自己受理すると DB に弾かれる状態だった
--      （これまで試した人がいない：欠勤の自己確定は本番で0件）。
--
-- 【直すこと】
--   ・欠勤の判定を役職の属性 is_manager_plus()（管理者を含む）にする（2つの許可を本番の実定義から起こして差し替え）
--   ・書き込む直前の確かめ（トリガー）を足す。**本人が自分の申請を** confirmed / request_confirmed に**変える**ときだけ見る。
--     通すのは：マネージャー以上（自己受理）／「残業なし」の実績報告（差分0・種別なし）／「打刻ズレ」（差分0・clock_only）
--     見ないもの：サーバー（auth.uid() が空）／上長・管理者が他人の申請を受理するとき／状態を変えない書き換え
--     （例：受理済みの事前申請の「カレンダーに載せるか」を本人が切り替える）
--   🚨 RLS の WITH CHECK では「前の状態」が見えないので、状態を変えない書き換えまで止めてしまう。トリガーにしたのはそのため
-- 🚨 この許可を次に直すときは、本番の実定義（pg_policies）から起こすこと

-- ① 欠勤の自己確定：順位ではなく属性で判定する
drop policy if exists overtime_insert_own on overtime_reports;
create policy overtime_insert_own on overtime_reports
  for insert to authenticated
  with check (
    submitted_by = auth.uid()
    and applicant_id = auth.uid()
    and entry_type = 'manual'
    and (
      not ('absence' = any (application_types))
      or confirmed_by is distinct from auth.uid()
      or is_manager_plus()
    )
  );

drop policy if exists overtime_update_own on overtime_reports;
create policy overtime_update_own on overtime_reports
  for update to authenticated
  using (
    applicant_id = auth.uid()
    and entry_type = 'manual'
    and status in ('requested', 'request_confirmed', 'reported', 'returned')
  )
  with check (
    applicant_id = auth.uid()
    and entry_type = 'manual'
    and (
      status in ('requested', 'request_confirmed', 'reported', 'returned')
      or (
        status = 'confirmed'
        and confirmed_by = auth.uid()
        and (not ('absence' = any (application_types)) or is_manager_plus())
      )
    )
  );

-- ② 本人が自分の申請を確定・事前受理に変えるときの確かめ
create or replace function public.enforce_overtime_self_confirm()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- サーバー（cron・Edge Function・service_role）
  if auth.uid() is null then return new; end if;
  -- 本人以外（上長・管理者が他人の申請を受理する）
  if new.applicant_id is distinct from auth.uid() then return new; end if;
  -- 自動計上（休暇由来など）は対象外
  if new.entry_type is distinct from 'manual' then return new; end if;
  -- 確定・事前受理に「する」ときだけ見る
  if new.status not in ('confirmed', 'request_confirmed') then return new; end if;
  if tg_op = 'UPDATE' and old.status = new.status then return new; end if;
  -- マネージャー以上（管理者を含む）は自己受理できる
  if is_manager_plus() then return new; end if;
  -- だれでも自分で確定できるもの：「残業なし」の実績報告／「打刻ズレ」（どちらも差分0）
  if new.status = 'confirmed' and coalesce(new.diff_minutes, 0) = 0
     and (coalesce(cardinality(new.application_types), 0) = 0 or new.application_types = array['clock_only']::text[]) then
    return new;
  end if;
  raise exception '自分で受理（自己受理）できるのはマネージャー以上です。申請先を選んで送ってください'
    using errcode = '42501';
end;
$$;

revoke execute on function public.enforce_overtime_self_confirm() from public;
revoke execute on function public.enforce_overtime_self_confirm() from anon;

drop trigger if exists trg_enforce_overtime_self_confirm on overtime_reports;
create trigger trg_enforce_overtime_self_confirm
  before insert or update on overtime_reports
  for each row execute function public.enforce_overtime_self_confirm();

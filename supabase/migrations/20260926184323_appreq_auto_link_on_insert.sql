-- ============================================================
-- 2026-09-26  申請の依頼：申請が保存された瞬間に、同じ人・同じ種類・同じ日の開いている依頼を自動で「申請済み」にする
-- ============================================================
-- きっかけ（2026-09-26 実データ）：長岡さんが馬場さんに 9/26 の休暇の依頼 → 馬場さんはベルを読んで（14:13）、
--   依頼のカードを使わず休暇ページから 9/26 の有給を申請（14:17）→ 依頼は「開いたまま」残り、あとで長岡さんが手で取り下げた。
--   依頼のカード（「この依頼から申請」）を通ったときだけ結び付ける作りだったため。
-- ✅ ユーザー確定（案A）：DB 側で自動で結び付ける。1件フォーム・表入力・休暇ページ、どこから出しても効く。
--
-- 条件：依頼の宛先＝申請した本人／種類が同じ（overtime / leave）／依頼の対象日に申請の日が含まれる／依頼が open。
--   ・残業：overtime_reports の insert（entry_type='manual'。休暇由来の自動計上は対象外）
--   ・休暇：leave_requests の insert（leave_dates の日付のどれかが対象日に含まれる。leave_dates が空なら start_date〜end_date）
-- 🚨 取消の逆向き（申請が取消されたら依頼を open に戻す）は既存の reopen_application_request_on_cancel が担当。両方で1組
-- 🚨 画面側の「依頼のカードから申請したときに結び付ける」処理はそのまま（このトリガーが先に結び付けていれば 0件になるだけ）
-- 🚨 security definer：本人は application_requests を update できる（appreq_update）が、トリガーは本人の権限に依らず確実に動かす

create or replace function public.link_application_request_on_insert()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_kind text;
  v_user uuid;
  v_dates date[];
begin
  if tg_table_name = 'overtime_reports' then
    if new.entry_type is distinct from 'manual' or new.status = 'cancelled' then return new; end if;
    v_kind := 'overtime';
    v_user := new.applicant_id;
    v_dates := array[new.work_date];
  elsif tg_table_name = 'leave_requests' then
    if new.status = 'cancelled' then return new; end if;
    v_kind := 'leave';
    v_user := new.user_id;
    begin
      select coalesce(array_agg(d::date), array[]::date[]) into v_dates
        from jsonb_array_elements_text(new.leave_dates::jsonb) as d;
    exception when others then
      v_dates := array[]::date[];
    end;
    if coalesce(array_length(v_dates, 1), 0) = 0 and new.start_date is not null then
      select array_agg(g::date) into v_dates
        from generate_series(new.start_date, coalesce(new.end_date, new.start_date), interval '1 day') as g;
    end if;
  else
    return new;
  end if;

  if v_user is null or coalesce(array_length(v_dates, 1), 0) = 0 then return new; end if;

  update application_requests
     set status = 'applied', linked_id = new.id, responded_at = now(), updated_at = now()
   where recipient_id = v_user
     and kind = v_kind
     and status = 'open'
     and target_dates && v_dates;
  return new;
end;
$$;

revoke execute on function public.link_application_request_on_insert() from public;
revoke execute on function public.link_application_request_on_insert() from anon;

drop trigger if exists trg_overtime_insert_link_appreq on overtime_reports;
create trigger trg_overtime_insert_link_appreq after insert on overtime_reports
  for each row execute function link_application_request_on_insert();

drop trigger if exists trg_leave_insert_link_appreq on leave_requests;
create trigger trg_leave_insert_link_appreq after insert on leave_requests
  for each row execute function link_application_request_on_insert();

-- 確認用:
--   select tgname from pg_trigger where tgrelid in ('public.overtime_reports'::regclass, 'public.leave_requests'::regclass) and tgname like '%link_appreq';

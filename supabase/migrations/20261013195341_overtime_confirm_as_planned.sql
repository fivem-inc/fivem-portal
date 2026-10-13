-- 事前申請が受理済みで、実績が予定とまったく同じなら、上長の受理を省いて確認済みにする（2026-10-13 ユーザー確定）
-- ・本人が実績報告を送ったあと、画面が overtime_confirm_as_planned(p_id) を呼ぶ。条件に合えば confirmed にして true、合わなければ何もせず false
--   （false のときは今までどおり「実績 確認待ち」のまま・上長へ受理のお願いが届く）
-- ・「同じか」は DB で比べる（画面だけで判断すると、だれでも確認済みにできる抜け道になる）
--     時間帯：overtime_report_segments の planned と actual が本数・開始・終了とも同じ
--     休憩・勤務地・種別：実績報告の直前の控え（overtime_report_history の snapshot・状態が request_confirmed のもの）と今の行が同じ
-- ・上長へはベルだけ（event_key を付けない＝プッシュは出ない）。設定 overtime:new_request（サイト）が切られていれば送らない
-- ・🚨 enforce_overtime_self_confirm は本番の実定義から起こし、この関数の中だけ通す印（app.ot_as_planned）を足した
begin;

create or replace function public.enforce_overtime_self_confirm()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  -- サーバー（cron・Edge Function・service_role）
  if auth.uid() is null then return new; end if;
  -- 予定どおりの実績報告（overtime_confirm_as_planned の中だけ立つ印・2026-10-13）
  if coalesce(current_setting('app.ot_as_planned', true), '') = 'on' then return new; end if;
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
$function$;

create or replace function public.overtime_confirm_as_planned(p_id uuid)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_r     overtime_reports%rowtype;
  v_snap  jsonb;
  v_name  text;
  v_site  boolean;
  v_same  boolean;
begin
  select * into v_r from overtime_reports where id = p_id for update;
  if not found then return false; end if;
  -- 本人が、たったいま出した実績報告だけ
  if v_r.applicant_id is distinct from auth.uid() then return false; end if;
  if v_r.entry_type <> 'manual' or v_r.status <> 'reported' then return false; end if;
  -- 事前申請を上長が受理している（自己受理の人は今までどおり別の道で確定する）
  if v_r.request_confirmed_at is null or v_r.reviewer_id is null or v_r.reviewer_id = v_r.applicant_id then return false; end if;

  -- 実績報告の直前の控え（状態が「事前申請 受理済み」だったもの）
  select h.snapshot into v_snap
    from overtime_report_history h
   where h.report_id = p_id and h.changed_by = auth.uid()
   order by h.changed_at desc
   limit 1;
  if v_snap is null or v_snap->>'status' <> 'request_confirmed' then return false; end if;

  -- 休憩・勤務地・種別が予定のときと同じ
  if coalesce((v_snap->>'break_minutes')::int, -1) <> coalesce(v_r.break_minutes, -1) then return false; end if;
  if coalesce(v_snap->>'location', '') <> coalesce(v_r.location, '') then return false; end if;
  if (select coalesce(array_agg(x order by x), '{}') from jsonb_array_elements_text(coalesce(v_snap->'application_types', '[]'::jsonb)) x)
     <> (select coalesce(array_agg(x order by x), '{}') from unnest(v_r.application_types) x) then
    return false;
  end if;

  -- 時間帯：予定と実績が本数・開始・終了とも同じ（1本以上）
  select (select count(*) from overtime_report_segments where report_id = p_id and phase = 'actual') > 0
     and not exists (
       (select start_min, end_min from overtime_report_segments where report_id = p_id and phase = 'planned'
        except all
        select start_min, end_min from overtime_report_segments where report_id = p_id and phase = 'actual')
       union all
       (select start_min, end_min from overtime_report_segments where report_id = p_id and phase = 'actual'
        except all
        select start_min, end_min from overtime_report_segments where report_id = p_id and phase = 'planned')
     )
    into v_same;
  if not coalesce(v_same, false) then return false; end if;

  -- 確認済みにする（この中だけ自己受理の決まりを通す）
  perform set_config('app.ot_as_planned', 'on', true);
  update overtime_reports
     set status = 'confirmed', confirmed_by = v_r.reviewer_id, confirmed_at = now()
   where id = p_id and status = 'reported';
  perform set_config('app.ot_as_planned', 'off', true);

  insert into overtime_report_history (report_id, changed_by, change_summary, snapshot)
  values (p_id, auth.uid(), '予定どおりの実績報告のため、受理を省いて確認済み（事前申請は受理済み）', to_jsonb(v_r));

  -- 上長へベルだけ（プッシュなし）。押しても何も開かないお知らせ
  select enabled into v_site from notification_settings where event_key = 'overtime:new_request' and channel = 'site';
  if coalesce(v_site, true) then
    select name into v_name from profiles where id = v_r.applicant_id;
    insert into notifications (user_id, message, sub_message, source_type, reference_id, event_key, read)
    values (v_r.reviewer_id,
            '🕐 ' || coalesce(v_name, '') || 'さんの実績報告は予定どおりでした（受理は不要です）',
            to_char(v_r.work_date, 'YYYY-MM-DD') || '（' || (array['日','月','火','水','木','金','土'])[extract(dow from v_r.work_date)::int + 1] || '）',
            null, null, null, false);
  end if;

  return true;
end;
$function$;

revoke execute on function public.overtime_confirm_as_planned(uuid) from public;
revoke execute on function public.overtime_confirm_as_planned(uuid) from anon;
grant execute on function public.overtime_confirm_as_planned(uuid) to authenticated;

commit;

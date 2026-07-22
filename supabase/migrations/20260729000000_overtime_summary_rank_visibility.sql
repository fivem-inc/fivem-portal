-- ========================================
-- 残業「部門集計」に役職階層の閲覧制御を追加（2体レビュー×2回反映版）
--
-- 「自分と同格か、自分より下位の役職の人だけ見える」階層フィルタを RLS に追加。
-- 順位の正（実態に合う）はフロントの ROLE_RANK と同一。
--   社長=1 / 管理者=1 / マネージャー=2 / リーダー=3 / フロア責任者=4 / 一般=5 / パート=6
--   ※ roles.sort_order は表示順で実態とズレるため RLS 基準には使わない。
--   ※ 役職を新設したら下の case に追加すること。
--
-- ルール: 申請者rank >= 自分rank なら閲覧可（同格含む・上位不可）。
--   - 社長・管理者は rank=1 → 相手は必ず 1 以上 → 全員閲覧可。
--   - 自分の申請は overtime_select_own で常に閲覧可。承認者は overtime_select_reviewer。
--
-- ★ fail の向きを役割で分ける（レビュー指摘）:
--   - 自分側(overtime_role_rank): 役職不明は 99（最下位）→ ほぼ誰も見えない＝安全。
--   - 対象者側(overtime_role_rank_target): 役職不明は 1（最上位）→ 誰にも見せない＝安全。
--     （対象者不明を 99 にすると「全 summary 閲覧者に露出」する fail-open になるため）
--
-- 反映:
--   #1 抜け道封じ: overtime_report_segments / overtime_report_history にも同条件。
--   #2 名簿ズレ対策: overtime_visible_roster() RPC で判定を DB に一本化。
--   #3 対象者不明は fail-closed（overtime_role_rank_target）。
--   #4 roster に admin バイパス。employment_type NULL は旧挙動どおり除外。
--   ※ シフト予定 weekly_shift_patterns は本件では対象外。
-- ========================================

begin;

-- 1a) 自分側の rank（不明=99=最下位/fail-closed）
create or replace function overtime_role_rank(p_uid uuid)
returns int
language sql stable security definer set search_path = public
as $$
  select coalesce(
    (
      select case coalesce(r.name, p.role_title)
        when '社長' then 1 when '管理者' then 1 when 'マネージャー' then 2
        when 'リーダー' then 3 when 'フロア責任者' then 4 when '一般' then 5
        when 'パート' then 6 else 99
      end
      from profiles p left join roles r on r.id = p.role_id
      where p.id = p_uid
    ),
    99
  );
$$;

-- 1b) 対象者側の rank（不明=1=最上位/fail-closed＝誰にも見せない）
create or replace function overtime_role_rank_target(p_uid uuid)
returns int
language sql stable security definer set search_path = public
as $$
  select coalesce(
    (
      select case coalesce(r.name, p.role_title)
        when '社長' then 1 when '管理者' then 1 when 'マネージャー' then 2
        when 'リーダー' then 3 when 'フロア責任者' then 4 when '一般' then 5
        when 'パート' then 6 else 1
      end
      from profiles p left join roles r on r.id = p.role_id
      where p.id = p_uid
    ),
    1
  );
$$;

revoke execute on function overtime_role_rank(uuid)        from public;
revoke execute on function overtime_role_rank_target(uuid) from public;
grant  execute on function overtime_role_rank(uuid)        to authenticated;
grant  execute on function overtime_role_rank_target(uuid) to authenticated;

-- 2) 集計名簿の取得 RPC（フロントの rank 判定を DB に一本化）
--    未申請者も 0:00 で出す名簿。overtime_summary 権限が無ければ空（fail-closed）。
--    admin は rank に関わらず全員（overtime_reports 側の admin_all と整合）。
create or replace function overtime_visible_roster()
returns table (
  id          uuid,
  name        text,
  group_names text[],
  role_title  text,
  rank        int
)
language sql stable security definer set search_path = public
as $$
  select
    p.id, p.name, p.group_names,
    coalesce(r.name, p.role_title)      as role_title,
    overtime_role_rank_target(p.id)     as rank
  from profiles p
  left join roles r on r.id = p.role_id
  where p.is_active
    and p.employment_type is not null
    and p.employment_type <> 'パート'
    and has_feature_permission('overtime_summary')
    and (
      (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
      or overtime_role_rank_target(p.id) >= (select overtime_role_rank(auth.uid()))
    );
$$;

revoke execute on function overtime_visible_roster() from public;
grant  execute on function overtime_visible_roster() to authenticated;

-- 3) 集計閲覧ポリシー（本体）を階層フィルタ付きに差し替え
drop policy if exists "overtime_select_summary" on overtime_reports;
create policy "overtime_select_summary" on overtime_reports
  for select using (
    has_feature_permission('overtime_summary')
    and overtime_role_rank_target(applicant_id) >= (select overtime_role_rank(auth.uid()))
  );

-- 4) 抜け道封じ①：時間帯（実データそのもの）
drop policy if exists "segments_select" on overtime_report_segments;
create policy "segments_select" on overtime_report_segments
  for select using (
    exists (
      select 1 from overtime_reports r
      where r.id = report_id
        and (
          r.applicant_id = auth.uid()
          or r.reviewer_id = auth.uid()
          or (
            has_feature_permission('overtime_summary')
            and overtime_role_rank_target(r.applicant_id) >= (select overtime_role_rank(auth.uid()))
          )
        )
    )
  );

-- 5) 抜け道封じ②：修正履歴（snapshot に diff_minutes 等を含む）
drop policy if exists "overtime_history_select" on overtime_report_history;
create policy "overtime_history_select" on overtime_report_history
  for select using (
    changed_by = auth.uid()
    or exists (
      select 1 from overtime_reports r
      where r.id = report_id
        and (
          r.applicant_id = auth.uid()
          or r.reviewer_id = auth.uid()
          or (
            has_feature_permission('overtime_summary')
            and overtime_role_rank_target(r.applicant_id) >= (select overtime_role_rank(auth.uid()))
          )
        )
    )
  );

commit;

-- ========================================
-- ロールバック（必要時）
-- ========================================
-- begin;
-- drop policy if exists "overtime_select_summary" on overtime_reports;
-- create policy "overtime_select_summary" on overtime_reports
--   for select using (has_feature_permission('overtime_summary'));
-- drop policy if exists "segments_select" on overtime_report_segments;
-- create policy "segments_select" on overtime_report_segments
--   for select using (exists (select 1 from overtime_reports r where r.id = report_id
--     and (r.applicant_id = auth.uid() or r.reviewer_id = auth.uid() or has_feature_permission('overtime_summary'))));
-- drop policy if exists "overtime_history_select" on overtime_report_history;
-- create policy "overtime_history_select" on overtime_report_history
--   for select using (changed_by = auth.uid() or has_feature_permission('overtime_summary')
--     or exists (select 1 from overtime_reports r where r.id = report_id
--       and (r.applicant_id = auth.uid() or r.reviewer_id = auth.uid())));
-- drop function if exists overtime_visible_roster();
-- drop function if exists overtime_role_rank_target(uuid);
-- drop function if exists overtime_role_rank(uuid);
-- commit;

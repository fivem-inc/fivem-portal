-- ============================================================
-- 残業の実績報告で「残業なし（差分0の自己確定）」「自己受理申請の実績報告」が
-- RLSで弾かれるバグの修正
--
-- 症状: 実績報告フェーズで「残業なしで報告する（確定）」を押すと
--   new row violates row-level security policy for table "overtime_reports"
--
-- 原因: overtime_update_own は WITH CHECK 省略（＝USINGが更新後の行にも適用）で、
--   更新後の status が requested/request_confirmed/reported/returned しか許されない。
--   実績報告のUPDATEで status='confirmed' に直行する2経路（①isPureZero=残業なし
--   ②isSelfReview=自己受理申請の実績報告）が必ず失敗していた。
--   2026-07-24 の 20260730000000 で segments 側だけ直し、本体テーブルが取り残された
--   （INSERT経路の自己受理は overtime_insert_own で通るため新規送信では発覚しない）。
--
-- 修正: WITH CHECK を明示し、「confirmed かつ confirmed_by=本人」を追加で許可する
--   （segments_write_own と同じ条件）。欠勤の自己確定はINSERTポリシーと同じく
--   マネージャー以上（overtime_role_rank<=2）に限定する。
--   USING（更新できる元の行）は従来のまま変更しない。
-- ============================================================

drop policy if exists overtime_update_own on overtime_reports;
create policy overtime_update_own on overtime_reports
  for update
  using (
    applicant_id = auth.uid()
    and entry_type = 'manual'
    and status in ('requested','request_confirmed','reported','returned')
  )
  with check (
    applicant_id = auth.uid()
    and entry_type = 'manual'
    and (
      status in ('requested','request_confirmed','reported','returned')
      or (
        status = 'confirmed'
        and confirmed_by = auth.uid()
        -- 欠勤の自己確定はマネージャー以上のみ（overtime_insert_own と同じ制限）
        and (not ('absence' = any(application_types)) or overtime_role_rank(auth.uid()) <= 2)
      )
    )
  );

-- 残業・時間管理：終日種別（時間外調整休・振替休日・欠勤）を追加
-- 背景: 休暇タブの調整休＋欠勤を残業ページへ統合する準備（残業ページは未公開のため現行運用に影響なし）。
-- 残高への影響: chosei_off=シフト労働分マイナス(相殺) / furikae_off=0(記録のみ) / absence=0(残高に入れず別枠カウント)
-- 法務方針: 割増賃金25%はアプリで扱わず給与計算側で処理（残高は所定内の時間貸借のみ）。

-- 1) application_types の許容値に終日3種を追加（上位集合への拡張なので既存行は必ず通る）
alter table overtime_reports
  drop constraint overtime_reports_application_types_check;

alter table overtime_reports
  add constraint overtime_reports_application_types_check
  check (application_types <@ array[
    'overtime','early_start','tardiness','early_leave',
    'holiday_work','location_change','late_start_adj','early_end_adj',
    'chosei_off','furikae_off','absence'
  ]::text[]);

-- 2) 終日種別は単独付与のみ（時刻系種別と混在禁止。GCalタイトルの「調整休＋調整休」等を防ぐ）
alter table overtime_reports
  add constraint overtime_reports_fullday_single_type
  check (
    not (application_types && array['chosei_off','furikae_off','absence']::text[])
    or array_length(application_types, 1) = 1
  );

-- 3) 欠勤は自己受理禁止（本人＝受理者を DB レベルで拒否。画面・Edge Function と合わせた3層ガードの最終防衛線）
alter table overtime_reports
  add constraint overtime_reports_absence_no_self_review
  check (
    not ('absence' = any(application_types))
    or (
      reviewer_id is distinct from applicant_id
      and confirmed_by is distinct from applicant_id
    )
  );

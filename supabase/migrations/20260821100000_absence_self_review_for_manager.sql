-- 欠勤（終日）の自己受理を、マネージャー以上に開放する
--
-- 【背景】
-- 2026-07-21 に「欠勤は本人＝受理者を禁止」とし、画面・サーバー・DB CHECK の3層で塞いでいた。
-- マネージャー以上は残業などと同じく自分で確定してよい、という判断になったため開放する
-- （2026-08-21 ユーザー確定）。リーダー以下はこれまでどおり他の人の受理が必要。
--
-- 【設計の要点】
-- 🚨 CHECK 制約からは他のテーブルを参照できないため「その人がマネージャーか」を判定できない。
--    そこで制約は削除し、判定は役職を見られる RLS 側へ移す。
--
-- 🚨 制約を消すだけにしてはいけない。
--    overtime_insert_own には status の制限が無く、
--    自己受理は「送信した瞬間に status='confirmed' でクライアントから直接 INSERT する」作りのため、
--    受理ボタンを通らない＝Edge Function のチェックが効かない。
--    制約を消しただけだと、一般スタッフでも直接データを送れば
--    自分の欠勤を勝手に確定できてしまう（画面の見た目だけの制限になる）。
--
-- 🚨 元のポリシーは TO 句なし（＝PUBLIC）なので、作り直しでも TO 句を書かない。
--    ここで to authenticated と書くと適用範囲が変わってしまう。

alter table public.overtime_reports
  drop constraint if exists overtime_reports_absence_no_self_review;

drop policy if exists overtime_insert_own on public.overtime_reports;
create policy overtime_insert_own on public.overtime_reports
  for insert
  with check (
    submitted_by = auth.uid()
    and applicant_id = auth.uid()
    and entry_type = 'manual'
    -- 欠勤を本人が確定（自己受理）できるのはマネージャー以上だけ。
    -- overtime_role_rank は 社長1・管理者1・マネージャー2・リーダー3・フロア責任者4・一般5・パート6
    -- （小さいほど上位。役職が分からない場合は 99 が返るので通らない＝安全側）
    and (
      not ('absence' = any(application_types))
      or confirmed_by is distinct from auth.uid()
      or overtime_role_rank(auth.uid()) <= 2
    )
  );

comment on policy overtime_insert_own on public.overtime_reports is
  '本人が自分の残業を登録できる。欠勤の自己受理（confirmed_by=本人）はマネージャー以上のみ';

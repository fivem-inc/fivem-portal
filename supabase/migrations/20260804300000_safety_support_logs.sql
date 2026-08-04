-- ========================================
-- 安否確認：対応記録（誰が担当して、電話の結果がどうだったか）
--
-- これまで「対応中にする」は画面の中だけの印で、DBに保存しておらず
-- 他の人の画面には一切出ていなかった＝二重に電話をかけるのを防げていなかった。
--
-- 【ユーザー決定】
--   ・対象は「助けが必要な人」と「未回答の人」の両方（未回答者への電話こそ二重になりやすい）
--   ・「電話する」を押したら自動で担当になる（別ボタンだと押し忘れる）。取り消しも可
--   ・結果は つながった／つながらない／留守電に入れた／家族が出た／その他 ＋ 自由記入
--   ・書けるのはマネージャー以上＋進行中のリーダー（＝集計を見られる人）
--
-- ⚠️ 追記のみ。変更・削除のポリシーを作らない。
--    災害対応の記録は「誰が・いつ・何をしたか」が後から書き換えられては意味がないため。
--    間違えて担当になった場合は release を追記して取り消す（記録は残る）。
-- ========================================

create table if not exists safety_check_support_logs (
  id uuid primary key default gen_random_uuid(),
  check_id uuid not null references safety_checks(id) on delete cascade,
  target_user_id uuid not null references auth.users(id) on delete cascade,  -- 誰について
  author_id uuid not null references auth.users(id) on delete cascade,       -- 誰が書いたか
  kind text not null check (kind in ('claim', 'note', 'done', 'release')),
  --   claim   … 自分が担当します（電話する を押した）
  --   note    … 結果の記録
  --   done    … 対応を終える
  --   release … 担当を取り消す
  result text,   -- note のときの選択肢（つながった 等）
  body text,     -- 自由記入
  created_at timestamptz not null default now()
);

create index if not exists idx_safety_support_logs_check
  on safety_check_support_logs (check_id, target_user_id, created_at);

alter table safety_check_support_logs enable row level security;

-- 閲覧・記入とも「集計を見られる人」に合わせる。
-- ⚠️ クロステーブル参照は SECURITY DEFINER 関数を経由する（RLSの相互再帰で全件消える前例があるため）
drop policy if exists scsl_select on safety_check_support_logs;
create policy scsl_select on safety_check_support_logs for select to authenticated using (
  is_manager_plus() or (is_leader() and safety_check_is_active(check_id))
);

drop policy if exists scsl_insert on safety_check_support_logs;
create policy scsl_insert on safety_check_support_logs for insert to authenticated with check (
  author_id = auth.uid()
  and (is_manager_plus() or (is_leader() and safety_check_is_active(check_id)))
);

-- update / delete のポリシーは作らない（＝誰も書き換えられない・追記のみ）

notify pgrst, 'reload schema';

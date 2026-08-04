-- ========================================
-- 安否確認：管理者による完全削除
--
-- 「取消（誤発信）」は記録を残す操作（履歴に取消として残り、全員に誤送信の通知が飛ぶ）。
-- これとは別に、訓練の後片付け・テストデータの整理のために
-- 「記録ごと消す」操作を管理者だけに用意する。
--
-- 宛先・回答・回答履歴は safety_checks への外部キーが on delete cascade なので
-- 本体を消せば自動で消える。ベル通知だけは reference_id が text で外部キーが無いため手で消す。
--
-- ⚠️ 元に戻せない。安否確認にはCSV出力が無いので、消す前に集計画面で控えを取ること。
-- ========================================

create or replace function delete_safety_check(p_check_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- 管理者のみ。RLSは safety_checks に DELETE ポリシーを作っていないので、
  -- この関数を通さない限り誰も消せない（＝ここが唯一の入口）
  if coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') <> 'admin' then
    raise exception 'permission denied' using errcode = '42501';
  end if;

  if not exists (select 1 from safety_checks where id = p_check_id) then
    raise exception 'safety_check not found' using errcode = 'P0002';
  end if;

  -- 発信時のお知らせ・全員回答の通知・誤送信の通知。
  -- 残すとタップ先が無くなるので一緒に消す。
  delete from notifications
   where source_type in ('safety_check', 'safety_check_cancelled')
     and reference_id = p_check_id::text;

  -- 本体（宛先・回答・回答履歴は cascade で連動して消える）
  delete from safety_checks where id = p_check_id;
end;
$$;

grant execute on function delete_safety_check(uuid) to authenticated;

notify pgrst, 'reload schema';

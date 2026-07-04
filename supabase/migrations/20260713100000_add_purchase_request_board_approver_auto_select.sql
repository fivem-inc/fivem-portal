-- 備品購入申請・経費精算 Phase 4（その2）
-- 承認対象者（全マネージャー+社長）を自動選出するBEFORE INSERT OR UPDATEトリガー。
-- ユーザーが対象者を選ぶことはできない（完全自動選出）。休職中（is_active=false）は自動除外し、
-- 申請者自身も対象から除外する（自分の申請を自分で承認できないようにする）。
--
-- 対象者が0人の場合、NEW.board_approver_idsはNULLのままになり、
-- purchase_requests_board_approver_ids_check（前段のmigrationで追加済み）でINSERT/UPDATE自体がエラーになる。
-- フロント側でも事前にボタン無効化のガードを入れる想定。

CREATE OR REPLACE FUNCTION public.set_board_approver_ids()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.amount > 30000 AND NEW.request_type = 'purchase_request' AND NOT NEW.president_self_judgment THEN
    SELECT array_agg(id) INTO NEW.board_approver_ids
      FROM public.profiles
      WHERE is_active = true
        AND role_title IN ('マネージャー', '社長')
        AND id != NEW.user_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER purchase_requests_set_board_approver_ids
  BEFORE INSERT OR UPDATE ON public.purchase_requests
  FOR EACH ROW EXECUTE FUNCTION public.set_board_approver_ids();

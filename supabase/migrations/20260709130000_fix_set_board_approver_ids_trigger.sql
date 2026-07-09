-- set_board_approver_ids トリガーの不具合修正
--
-- 症状：管理画面で承認者を外しても、直後に別のトリガーが「3万円超なので承認メンバーは
-- 全マネージャー＋社長」というリストで毎回上書きし直してしまい、外した操作が実質無効化されていた。
--
-- 原因：このトリガーがINSERT時だけでなく「UPDATEのたびに毎回」自動で
-- board_approver_idsを再計算・上書きしていたため。
--
-- 対応：新規作成時（INSERT）は今まで通り自動セットする。更新時（UPDATE）は、
-- 呼び出し側がboard_approver_idsを明示的に変更していない場合（＝他の項目の修正など）
-- のみ自動再計算する。呼び出し側が既にboard_approver_idsを新しい値に変更している場合
-- （＝管理者が承認者を外す/戻す操作をした場合）は、その値をそのまま尊重し上書きしない。

CREATE OR REPLACE FUNCTION public.set_board_approver_ids()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.amount > 30000 AND NEW.request_type = 'purchase_request' AND NOT NEW.president_self_judgment THEN
    IF TG_OP = 'INSERT' OR NEW.board_approver_ids IS NOT DISTINCT FROM OLD.board_approver_ids THEN
      SELECT array_agg(id) INTO NEW.board_approver_ids
        FROM public.profiles
        WHERE is_active = true
          AND role_title IN ('マネージャー', '社長')
          AND id != NEW.user_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

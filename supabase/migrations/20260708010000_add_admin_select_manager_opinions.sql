-- 管理画面から購入申請の承認状況（誰が未回答か）を表示するために、
-- purchase_request_manager_opinionsへの管理者SELECT権限が不足していたため追加する。
-- 既存のopinion_selectポリシーは依頼されたマネージャー/board_approver本人、
-- または（共有可の場合の）申請者本人のみを許可しており、管理者は対象外だった。

create policy "opinion_admin_select" on purchase_request_manager_opinions
  for select using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

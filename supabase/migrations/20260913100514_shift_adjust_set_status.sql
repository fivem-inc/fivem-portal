-- シフト調整の作業場：「確認済（変更なし）で閉じる」／「未調整に戻す」（手順6-A）
-- 設計は docs/計画-シフト調整.md。手順2で**直接の書き込みの許可を作らなかった**ので、
-- 状態を変えるには関数が要る。
--
-- 【この関数でできること】
--   pending  … 未調整に戻す
--   no_change… 確認済（変更なし）で閉じる
-- 🚨 `decided`（誰が入るかを決める）は**この関数では扱わない**。
--    決定は割り当て・勤怠の登録・依頼を1つの処理でやる必要があるので、別の関数（手順6-B）にする。
--    ここで decided を許すと「決定したのに誰も入っていない」場が作れてしまう。
--
-- 【🚨 割り当てがある場は断る】
--   すでに「誰が入るか」が決まっている場を、この関数で未調整や確認済に戻せてしまうと、
--   勤怠の記録だけが残って宙に浮く。片付けるのは「決定を取り消す」（手順6-B）から。
--
-- 【🚨 古い列への書き写しは何も書かなくてよい】
--   手順4で付けたトリガー `trg_zz_shift_adjust_to_leave` が、場の状態が変わった瞬間に
--   `leave_requests.shift_adjust_status` を書き換える。ここに同じ処理を書くと二重になる。

create or replace function public.shift_adjust_set_status(
  p_slot_id uuid,
  p_status  text
) returns table(ok boolean, reason text)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_is_admin boolean;
  v_slot     shift_adjust_slots%rowtype;
  v_has_assign boolean;
begin
  if p_status not in ('pending', 'no_change') then
    return query select false, '状態の値が正しくありません'::text;
    return;
  end if;

  v_is_admin := coalesce((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin', false);
  if not (v_is_admin or public.has_feature_permission('shift_adjust_decide')) then
    return query select false, 'シフト調整を決める権限がありません（管理画面の「役職・機能権限」で設定します）'::text;
    return;
  end if;

  -- 🚨 行を押さえてから見る。2人が同時に押したときに、後の人が古い中身で判断しないように
  select * into v_slot from shift_adjust_slots s where s.id = p_slot_id for update;
  if not found then
    return query select false, 'この調整の場は見つかりません'::text;
    return;
  end if;

  -- 🚨 休んだ本人には触らせない（読み取りのRLSと同じ決まりを、関数の中でももう一度確かめる）
  if v_slot.target_user_id = auth.uid() then
    return query select false, '自分の休みの調整は、この画面からは変えられません'::text;
    return;
  end if;

  select exists (select 1 from shift_adjust_assignments a where a.slot_id = p_slot_id)
    into v_has_assign;
  if v_has_assign then
    return query select false, 'すでに出勤する人が決まっています。先に「決定を取り消す」から片付けてください'::text;
    return;
  end if;

  if v_slot.status in ('closed_past', 'cause_cancelled') then
    return query select false, 'この場はもう閉じています（過ぎた日、または休みが取り消されました）'::text;
    return;
  end if;

  update shift_adjust_slots s
     set status     = p_status,
         decided_by = case when p_status = 'pending' then null else auth.uid() end,
         decided_at = case when p_status = 'pending' then null else now() end,
         updated_at = now()
   where s.id = p_slot_id;

  return query select true, ''::text;
end $function$;

comment on function public.shift_adjust_set_status(uuid, text) is
  'シフト調整の場を「確認済（変更なし）」で閉じる／「未調整」に戻す。'
  '🚨 decided は扱わない（決定は割り当て・勤怠・依頼を1つの処理でやる別の関数）。'
  '🚨 割り当てがある場は断る。古い列への書き写しはトリガーが自動でやる。';

-- 🚨 CLAUDE.md の決まり：新しい関数は anon の実行権限を確かめて外す。
--    順番が大事：PUBLIC から外す → ログイン済みに与え直す → anon からも外す
--    （anon だけ外しても PUBLIC 経由で残る）
revoke execute on function public.shift_adjust_set_status(uuid, text) from public;
grant  execute on function public.shift_adjust_set_status(uuid, text) to authenticated;
revoke execute on function public.shift_adjust_set_status(uuid, text) from anon;

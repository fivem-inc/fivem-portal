-- シフト調整の作業場：今までのボタンと、新しい作業場を同じ状態に保つ（手順3）
-- 設計は docs/計画-シフト調整.md。手順2（表の土台・20260912222515）の続き。
--
-- 【なぜ手順4（自動で場を作る）より先にやるのか】
--   🚨 既存のお知らせ（cron `remind-leave-shift-adjust-daily`・`*/15`）は
--      **`leave_requests.shift_adjust_status = 'pending'`** を見ている（専用の索引まである）。
--      手順4で場が自動で作られ始めると、「新しい作業場では片付いているのに、
--      古い列が pending のまま」という食い違いが生まれ、**本物のスタッフへお知らせが飛び続ける**。
--      だから、**場が1つも生まれる前に**両者をつなぐ。
--
-- 【いまの本番の数字（2026-09-12 実測）】
--   shift_adjust_status … pending 63／adjusted 7／no_change 1
--   🚨 pending 63件のうち、**今後の休みは2件だけ**（残りは過ぎた休み）。
--      ＝このファイルを適用しても、お知らせの対象は今までと1件も変わらない。
--
-- 【このファイルでやること】
--   `set_leave_shift_adjust`（今のカレンダーの3つのボタンが呼ぶ関数）に、
--   **新しい作業場の見出しも同時に動かす**処理を足す。
--   🚨 本体（今までの動き）は**本番の実定義から1文字も変えずに**起こしてある。
--      足したのは最後の「同期」のかたまりだけ。
--
-- 【このファイルでやらないこと】
--   逆向き（新しい作業場で決めたら古い列も書き換える）は、**決定の RPC と一緒に作る**。
--   いまは決定する道が無いので、書いても呼ばれない。
--
-- 【状態の対応（今回決めたこと）】
--   古いボタン            新しい作業場
--   pending        →      pending（決めた人・日時を消す）
--   adjusted       →      decided（この画面の外で決まった＝割り当ては空のまま）
--   no_change      →      no_change
--   🚨 `adjusted` を `no_change` に寄せない。「調整した」と「変更なし」は別の意味で、
--      混ぜると記録が嘘になる。割り当てが空の `decided` は画面で
--      「前のやり方で調整済み」と出せばよい。
--
-- 【🚨 古いボタンが新しい決定を壊さないようにする】
--   すでに**割り当て（誰が入るか）が入っている場は、古いボタンでは動かさない**。
--   動かすと、勤怠の記録だけが残って「誰も入らないことになっているのに出勤の記録がある」状態になる。
--   その場は新しい作業場の「決定を取り消す」で片付ける。

create or replace function public.set_leave_shift_adjust(p_id uuid, p_status text)
returns table(ok boolean, reason text)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_role_id uuid;
  v_is_admin boolean;
  v_count int;
begin
  if p_status not in ('pending', 'adjusted', 'no_change') then
    return query select false, '状態の値が正しくありません'::text;
    return;
  end if;

  v_is_admin := coalesce((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin', false);
  select role_id into v_role_id from profiles where id = auth.uid();

  if not (v_is_admin or exists (
        select 1
          from feature_permissions fp
         where fp.feature_key = 'leave_shift_adjust'
           and fp.enabled
           and fp.role_id = v_role_id)) then
    return query select false, 'シフト調整の状態を変える権限がありません（管理画面の「役職・機能権限」で設定します）'::text;
    return;
  end if;

  update leave_requests
     set shift_adjust_status = p_status,
         shift_adjusted_at   = case when p_status = 'pending' then null else now() end,
         shift_adjusted_by   = case when p_status = 'pending' then null else auth.uid() end
   where id = p_id
     and status in ('manager_approved', 'admin_approved', 'approved');

  get diagnostics v_count = row_count;
  if v_count = 0 then
    return query select false, 'この休暇は受理前か、すでに取り消されています'::text;
    return;
  end if;

  -- ───── ここから下が今回足した「同期」─────
  -- 🚨 **失敗しても今までの動きを巻き戻さない。** ここで例外を投げると、
  --    せっかく成功した上の update ごと取り消され、ボタンが効かなくなる。
  --    新しい作業場はまだテスト中なので、こちらの都合で本番の運用を止めてはいけない。
  begin
    update shift_adjust_slots s
       set status      = case p_status
                           when 'pending'   then 'pending'
                           when 'adjusted'  then 'decided'
                           else                  'no_change'
                         end,
           decided_by  = case when p_status = 'pending' then null else auth.uid() end,
           decided_at  = case when p_status = 'pending' then null else now() end,
           updated_at  = now()
     where s.cause_leave_request_id = p_id
       -- 🚨 すでに「誰が入るか」まで決まっている場は触らない（勤怠の記録が宙に浮くため）
       and not exists (
             select 1 from shift_adjust_assignments a where a.slot_id = s.id
           );
  exception when others then
    raise warning '[set_leave_shift_adjust] 新しい作業場の同期に失敗しました: %', sqlerrm;
  end;

  return query select true, ''::text;
end $function$;

comment on function public.set_leave_shift_adjust(uuid, text) is
  '今のカレンダーのシフト調整ボタン。2026-09-12 に「新しい作業場の見出しも同時に動かす」処理を足した。'
  '🚨 同期が失敗しても本体は巻き戻さない（warning を出すだけ）。'
  '🚨 割り当てが入っている場は触らない（決定の取り消しから片付ける）。';

-- 🚨 CLAUDE.md の決まり：関数を作り直したら anon の実行権限を確かめて外す。
--    `create or replace` では権限は変わらないが、もともと付いていた場合に備えて明示的に外す。
--    順番が大事：PUBLIC から外す → ログイン済みに与え直す → anon からも外す
--    （anon だけ外しても PUBLIC 経由で残る。2026-09-12 に実際に踏んだ）
revoke execute on function public.set_leave_shift_adjust(uuid, text) from public;
grant  execute on function public.set_leave_shift_adjust(uuid, text) to authenticated;
revoke execute on function public.set_leave_shift_adjust(uuid, text) from anon;

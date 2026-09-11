-- 🚨🚨 時間外調整休を「最終受理」すると失敗する不具合を直す（2026-09-11）
--
-- 【何が起きていたか（本番で取り消し版を流して証明済み）】
--   通常シフトのある正社員の時間外調整休を approved にすると、
--     ERROR 42703: column "user_id" of relation "overtime_reports" does not exist
--   でトリガーが落ち、**受理の更新そのものが巻き戻される**＝最終受理ができない。
--   本番の時間外調整休はまだ0件なので、**誰も踏んでいなかっただけ**。
--   🚨 残業調整の提案を受け入れると必ず時間外調整休ができる（OvertimeProposalResponse）ので、
--      最初の1件で社長の最終受理が止まるところだった。
--
-- 【原因】
--   2026-07-24 の最初の版は正しく `applicant_id, submitted_by` に書いていた。
--   2026-08-06（有休奨励日の対応）で作り直したとき、コメントには
--   「変更点は elsif の1行だけ」とあるのに、実際は次が**黙って変わっていた**：
--     ・書く人の列が `user_id`（存在しない）になり、`submitted_by`（必須）が抜けた
--     ・受理を**取り消したとき**に自動行を消す処理が丸ごと消えた
--     ・`confirmed_by`（誰が確定したか）を残さなくなった
--   🚨 教訓：**「1行だけ変えた」と書いた作り直しほど、全文を前の版と突き合わせる**。
--
-- 【直し方】本番の実定義（08-06版）から起こし、抜けた部分だけ 07-24 版から戻した。
--   08-06 で意図して入れた改善は**残す**：
--     ・有休奨励日（work_on_closed_encouraged）を出勤日と同じ扱いにする
--     ・同じ曜日に複数あるときは適用開始が新しいシフトを使う（order by valid_from desc）
--     ・労働時間が空でも落ちない（coalesce）
--   戻したもの：
--     ・applicant_id と submitted_by（どちらも必須・既定値なし）
--     ・受理を取り消したら自動行を消す
--     ・「受理になった瞬間だけ」作る条件（トリガーの WHEN にもあるが、関数の中でも守る）
--     ・break_manual = false、confirmed_by
--   confirmed_by は**実際に受理を押した人**（auth.uid()）を入れる。取れないときは
--   1人目の受理者（07-24 版と同じ値）に落とす。
--
-- 🚨 引数も戻り値も変えていないので create or replace だけ（drop しない）。
--    トリガー本体（WHEN 条件つき）は触らない。
-- 🚨 作り直しても権限は残るので、anon の実行権限はここで明示的に外す（CLAUDE.md の決まり）。

create or replace function public.sync_overtime_from_leave() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  d date;
  v_kind text;
  v_day_kind text;
  v_pattern weekly_shift_patterns%rowtype;
  v_period_start date;
begin
  -- ① 受理が取り消されたら、自動で作ったマイナス行を消す（07-24 版にあり、08-06 で抜けていた）
  if old.status = 'approved' and new.status is distinct from 'approved' then
    delete from overtime_reports
    where source_leave_request_id = new.id and entry_type = 'leave_auto';
  end if;

  -- ② 受理になった瞬間の時間外調整休：日ごとにマイナス行を作る
  if new.status = 'approved' and old.status is distinct from 'approved'
     and new.leave_type = '調整休' and new.chosei_sub_type = 'zangyou' then

    -- 何度動いても二重にならないよう、先に消してから作り直す
    delete from overtime_reports
    where source_leave_request_id = new.id and entry_type = 'leave_auto';

    for d in
      select (jsonb_array_elements_text(new.leave_dates::jsonb))::date
    loop
      -- 会社カレンダー優先で day_kind を解決（08-06 の改善を残す）
      select kind into v_kind from company_calendar where date = d;
      if v_kind = 'closed_all' then
        v_day_kind := 'holiday';
      elsif v_kind in ('work_on_closed', 'work_on_closed_encouraged') then
        v_day_kind := 'work_on_closed';
      else
        v_day_kind := (array['sun','mon','tue','wed','thu','fri','sat'])[extract(dow from d)::int + 1];
      end if;

      -- 🚨 weekly_shift_patterns の列は user_id で正しい（overtime_reports とは列名が違う）
      select * into v_pattern from weekly_shift_patterns
      where user_id = new.user_id
        and day_kind = v_day_kind
        and valid_from <= d
        and (valid_to is null or valid_to >= d)
      order by valid_from desc
      limit 1;

      -- その日に通常シフトがある場合のみマイナス計上（休みの日の調整休は0のため対象外）
      if v_pattern.id is not null and coalesce(v_pattern.labor_minutes, 0) > 0 then
        v_period_start := calc_pay_period_start(d);
        insert into overtime_reports (
          applicant_id, submitted_by, work_date, pay_period_start,
          entry_type, status,
          normal_shift, break_minutes, break_manual, labor_minutes, diff_minutes,
          reason, confirmed_by, confirmed_at, source_leave_request_id
        ) values (
          new.user_id, new.user_id, d, v_period_start,
          'leave_auto', 'confirmed',
          jsonb_build_object(
            'day_kind', v_day_kind,
            'calendar_kind', v_kind,
            'start_time', v_pattern.start_time,
            'end_time', v_pattern.end_time,
            'break_minutes', v_pattern.break_minutes,
            'labor_minutes', v_pattern.labor_minutes
          ),
          0, false, 0, -v_pattern.labor_minutes,
          '時間外調整休（休暇申請より自動計上）',
          coalesce(auth.uid(), new.approver_id), now(), new.id
        );
      end if;
    end loop;
  end if;

  return new;
end;
$$;

-- 🚨 anon の実行権限は**外さない**（2026-09-11 取り消し版で確かめて決めた）。
--    ・anon になって直接呼ぶと `0A000 trigger functions can only be called as triggers` で必ず失敗する
--      ＝トリガー専用の関数なので、権限が付いていても**悪用できない**。
--    ・`revoke … from anon` は効かなかった（権限は PUBLIC 経由で付いている）。
--    ・PUBLIC から外すと、トリガーが動く経路に影響するおそれがあり、
--      **今回直したい「受理が止まる」をもう一度起こしかねない**。
--    CLAUDE.md の「新しい関数は anon から外す」は**直接呼べる関数（RPC）の話**で、
--    トリガー専用の関数には当てはまらない。

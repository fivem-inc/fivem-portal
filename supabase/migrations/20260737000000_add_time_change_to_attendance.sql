-- 勤怠カレンダーに「勤務時間変更」を追加する。
--
-- 背景：出勤日だが通常レッスンがなく、短期などで普段と違う時間に勤務する日がある
-- （例：金曜は四条本校の出勤日だが、この日は 12:45〜16:50 のみ勤務）。
-- 校は変わらないため「勤務地変更」では意味がずれ、遅刻・早退でもないので、
-- これまでどの種別でも正しく表せなかった。
--
-- 勤務地変更との違い：
--   ・勤務時間変更（time_change）    … 校は普段どおり。時間だけ違う。original_location は null
--   ・勤務地変更（location_change）  … 校が変わる。original_location に変更前の校を入れる
-- どちらも work_segments に「実際に勤務する時間帯」を入れる（形式は共通）。
--
-- ※ 20260613000000 の「本人が自己登録できる」INSERTポリシーは type を明示列挙しているため、
--    time_change を足しても一般スタッフが自分で登録できるようにはならない（意図通り）。
--    そちらのポリシーに time_change を追加してはいけない。

alter table attendance_exceptions
  drop constraint if exists attendance_exceptions_type_check;

alter table attendance_exceptions
  add constraint attendance_exceptions_type_check
    check (type in ('late', 'early_leave', 'absent', 'late_start', 'early_end', 'holiday_work', 'location_change', 'time_change'));

-- 矛盾する勤怠の排他ルールを更新する（20260736000000 の関数を置き換え）。
--   ・全欠勤 / 休日出勤 … その日は単独。他のどの種別とも同居できない
--   ・遅刻 ⇔ 遅出(調整) … どちらか一方
--   ・早退 ⇔ 早退(調整) … どちらか一方
--   ・勤務地変更 ⇔ 勤務時間変更 … どちらか一方（どちらも「実際に勤務する時間帯」を持つため、
--      両方あると同じ日の勤務時間が二重に定義されてしまう）
--   ・勤務地変更・勤務時間変更は遅刻・早退などと同時に登録できる
--      （普段と違う校／時間で、しかも遅刻、はあり得るため）
create or replace function public.enforce_attendance_exclusive()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  conflict_type  text;
  conflict_label text;
begin
  if NEW.type in ('absent', 'holiday_work') then
    -- 単独種別：同じ日に何かあれば必ず衝突
    select type into conflict_type
      from attendance_exceptions
     where user_id = NEW.user_id
       and date = NEW.date
       and (NEW.id is null or id <> NEW.id)
     limit 1;
  else
    select type into conflict_type
      from attendance_exceptions
     where user_id = NEW.user_id
       and date = NEW.date
       and (NEW.id is null or id <> NEW.id)
       and (
         -- 単独種別が既にある日には他を足せない
         type in ('absent', 'holiday_work')
         -- 出勤側・退勤側はそれぞれ一方のみ
         or (NEW.type in ('late', 'late_start')        and type in ('late', 'late_start'))
         or (NEW.type in ('early_leave', 'early_end')  and type in ('early_leave', 'early_end'))
         -- 勤務時間帯を持つ種別は一方のみ
         or (NEW.type in ('location_change', 'time_change') and type in ('location_change', 'time_change'))
       )
     limit 1;
  end if;

  if conflict_type is not null then
    conflict_label := case conflict_type
      when 'absent'          then '全欠勤'
      when 'holiday_work'    then '休日出勤'
      when 'late'            then '遅刻'
      when 'late_start'      then '遅出(調整)'
      when 'early_leave'     then '早退'
      when 'early_end'       then '早退(調整)'
      when 'location_change' then '勤務地変更'
      when 'time_change'     then '勤務時間変更'
      else conflict_type
    end;
    raise exception '同じ日にすでに「%」が登録されています。先にそちらを取消してから登録してください。', conflict_label
      using errcode = '23514';
  end if;

  return NEW;
end;
$$;

-- 取消したことをリーダー以上へ知らせる通知（attendance:cancelled）。
-- これまで取消は通知が飛ばず、Googleカレンダーから予定が黙って消えるだけだった。
-- 既定は登録時（attendance:registered）と同じ「サイト通知＋プッシュON・メール/SlackはOFF」。
insert into public.notification_settings (event_key, channel, enabled, recipient, subject, template) values
  ('attendance:cancelled', 'site',  true,  '{"roles":["リーダー","マネージャー","社長","管理者"],"groupFilter":"same"}', null, '🔴 {{対象者名}}さんの{{種別}}が取消されました（{{日付}}）'),
  ('attendance:cancelled', 'push',  true,  '{"roles":["リーダー","マネージャー","社長","管理者"],"groupFilter":"same"}', null, null),
  ('attendance:cancelled', 'email', false, '{"roles":["リーダー","マネージャー","社長","管理者"],"groupFilter":"same"}', '勤怠の登録が取消されました', E'{{対象者名}}さんの{{種別}}（{{日付}}）が取消されました。\n\n下記のリンクからご確認ください。\n{{リンク}}'),
  ('attendance:cancelled', 'slack', false, '{"channels":[]}', null, null)
on conflict (event_key, channel) do nothing;

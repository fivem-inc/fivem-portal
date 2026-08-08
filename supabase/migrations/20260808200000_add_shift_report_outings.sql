-- 勤務変更報告で「勤務した時間帯」を最大3つまで持てるようにする（残業ページと同じ形）。
-- これまでは「開始〜終了」1組＋「外出」1組しか持てず、
-- 「9:00〜12:00 と 14:00〜18:00 に働いた」を素直に表せなかった。
--
-- 🚨 既存の original_start/end・original_outing_start/end はそのまま残す。
-- 過去の報告は「開始〜終了から外出を抜く」形で時間帯に復元して表示できるため、データの作り直しは不要。
-- 新しく保存するときは segments に全部入れ、あわせて
--   開始 = 最初の時間帯の開始 ／ 終了 = 最後の時間帯の終了
-- を従来の列にも書く（遅刻・早退の判定や集計がそのまま動くようにするため）。
alter table public.shift_reports
  add column if not exists original_segments jsonb,
  add column if not exists actual_segments   jsonb;

-- 配列であること・最大3つであることを保証する。
-- 🚨 jsonb_array_length は配列以外を渡すとエラーになるため、必ず jsonb_typeof で型を確かめてから使う
alter table public.shift_reports
  drop constraint if exists shift_reports_segments_max3;
alter table public.shift_reports
  add constraint shift_reports_segments_max3 check (
    (original_segments is null or (jsonb_typeof(original_segments) = 'array' and jsonb_array_length(original_segments) <= 3))
    and
    (actual_segments is null or (jsonb_typeof(actual_segments) = 'array' and jsonb_array_length(actual_segments) <= 3))
  );

comment on column public.shift_reports.original_segments is '通常シフトの勤務時間帯 最大3つ [{"start":"9:00","end":"12:00"}]。間の空きが外出・中抜け。開始と終了は original_start/end にも入る（互換用）';
comment on column public.shift_reports.actual_segments   is '実際に勤務した時間帯 最大3つ。開始と終了は actual_start/end にも入る（互換用）';

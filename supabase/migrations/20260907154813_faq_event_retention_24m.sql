-- 社外FAQの利用記録：保存期間を 13か月 → 24か月に延ばし、行数の上限を足す
--
-- 【なぜ延ばすか】
-- 集計画面に「前年同期と比べる」を入れるため。13か月だと前年同月がぎりぎりで、
-- 月末の1日ぶんが欠けることがある。24か月なら前年同期がまるごと残る。
-- （前月比は2か月目から効くので、そちらは期間に関係なく使える）
--
-- 🚨 【なぜ行数の上限も足すのか】
-- 期間を延ばすと、最悪の場合の容量が増える。
-- いまの防壁は「1日2万件まで」だけで、これは一気に流し込まれるのを止めるためのもの。
-- 24か月ぶん貯めると理論上の最大は 2万件 × 730日 ＝ 1,460万件（約4GB）になり、
-- 無料枠500MBをはるかに超える。実際にはあり得ない量だが、
-- **「上限を決めたつもりで決まっていない」状態は残さない**。
-- 行数の上限を入れれば、期間を延ばしても容量が青天井にならない。
--   20万行 × 約300バイト ≒ 60MB（無料枠500MBの12%）
-- 普通に使えば月に数千件程度なので、20万行に届くことはまず無く、
-- 普段は「24か月で消える」だけが効く。
--
-- 2026-08-20 に cron の記録が 130,817件・115MB まで膨らみ、
-- 「上限に達すると読み取り専用になって申請が保存できなくなる」一歩手前まで行っている。
-- 補助機能が基幹業務を止める経路は、作らない。

select cron.unschedule('purge-faq-public-event')
where exists (select 1 from cron.job where jobname = 'purge-faq-public-event');

-- JST 3:50（UTC 18:50）。既存の delete-old-notifications（UTC 18:00）と
-- purge-cron-history-daily（UTC 18:30）の後ろ。時刻は変えていない
select cron.schedule(
  'purge-faq-public-event',
  '50 18 * * *',
  $$
    -- ① 期間で消す（24か月）
    delete from public.faq_public_event
     where created_at < now() - interval '24 months';

    -- ② 行数の上限。新しいものから20万行を残し、それより古いものを消す
    --    🚨 idx_faq_public_event_created（created_at desc）が効く並びにしてある
    delete from public.faq_public_event
     where id in (
       select id from public.faq_public_event
        order by created_at desc
        offset 200000
     );

    -- ③ 1日の上限を数えている表の後始末（90日ぶんだけ残す）
    delete from public.faq_event_quota
     where day < (now() at time zone 'Asia/Tokyo')::date - 90;
  $$
);

-- 適用後に実測すること（読み取りのみ）
-- select jobname, schedule, active from cron.job where jobname = 'purge-faq-public-event';
-- select count(*) from cron.job;   -- 15 のまま（増えも減りもしない）

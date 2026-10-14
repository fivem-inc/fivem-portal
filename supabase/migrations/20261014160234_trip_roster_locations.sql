-- 今のシフト表の出張（大人）・園指導（こども）に、出張報告と同じ行き先リストの行を入れる（2026-10-14 ユーザー確定・対応表はモック⑥）
-- ・こども：決定済みの園指導4件／大人：作業中の案「案1」の出張3件（洛西口の3件は自分の校舎の勤務なので入れない・ユーザー確定 B）
-- ・表に出す名前は今のまま（短い名前 short_label に今の名前を入れる。リストの名前と同じものは入れない）
-- 🚨 こどもの表に作業中の案は無い（2026-10-14 実測）＝決定済みのマスの照合の値が変わっても、食い違いになる案は無い
begin;

-- 短い名前（今の表の名前）
update public.master_options set short_label = '陵和園'
 where category = 'trip_location_園指導' and value = '上京陵和園' and short_label is null;
update public.master_options set short_label = '下鴨夢'
 where category = 'trip_location_園指導' and value = '認定こども園 下鴨夢' and short_label is null;
update public.master_options set short_label = 'HOPPA（課外教室）'
 where category = 'trip_location_園指導' and value = 'HOPPA からすま京都ホテル' and short_label is null;
update public.master_options set short_label = '四条'
 where category = 'trip_location_出張' and value = 'JEUGIA 四条' and short_label is null;

-- こども：決定済みの園指導
update public.kids_shift_items i
   set trip_location_id = m.id
  from public.master_options m, (values
         ('陵和園', '上京陵和園'), ('太秦保育園', '太秦保育園'),
         ('下鴨夢', '認定こども園 下鴨夢'), ('HOPPA（課外教室）', 'HOPPA からすま京都ホテル')) as v(cls, loc)
 where i.kind_key = 'garden' and i.cell_id is not null and i.trip_location_id is null
   and i.class_name = v.cls and m.category = 'trip_location_園指導' and m.value = v.loc
   and exists (select 1 from public.kids_shift_cells c join public.kids_shift_places p on p.id = c.place_id
                where c.id = i.cell_id and p.board = 'kids');

-- 大人：作業中の案の出張
update public.kids_shift_items i
   set trip_location_id = m.id
  from public.master_options m, (values ('上牧', '上牧'), ('四条', 'JEUGIA 四条'), ('山科', '山科')) as v(cls, loc)
 where i.kind_key = 'trip' and i.plan_cell_id is not null and i.trip_location_id is null
   and i.class_name = v.cls and m.category = 'trip_location_出張' and m.value = v.loc
   and exists (select 1 from public.kids_shift_plan_cells pc join public.kids_shift_plans pl on pl.id = pc.plan_id
                where pc.id = i.plan_cell_id and pl.board = 'adult' and pl.status = 'open');

commit;

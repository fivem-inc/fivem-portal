-- 社内FAQ：休暇申請の「時間調整」「調整休」を残業申請にまとめる（10/16 から）。新しい版を valid_from=2026-10-16 で入れる（2026-10-13）
-- ・前の版は valid_until=2026-10-15（10/15 まではそのまま出る）。対象（役職）は前の版から写す
--   🚨 対象つきの回答は対象なしより優先されるので、写さないと前の版が出続ける（lib/faq.ts の resolveAnswer）
-- ・「休暇申請ページの「🕐 時間調整」タブは何に使う？」は一本化まで非公開だった。新しい版を入れて公開にする
begin;

create temporary table _faq_new (old_id uuid, body text) on commit drop;
insert into _faq_new (old_id, body) values
('0ed12d96-ba68-4c5e-be12-5e2826d05f5e', $faq$基本の流れは「①申請先のリーダー → ②マネージャー → ③経理 → ④社長」の順で受理され、すべて済むと完了です。
申請先にマネージャーを直接選んだ場合は、そのマネージャーが1回の受理で経理へ進めることができます。
調整休はマネージャーの受理で完了します（経理・社長は通りません）。10/16以降の勤務日の時間外調整休・振替休日は、休暇申請ではなく「残業申請」で申請します。
受理・差し戻しの結果は通知（ベル・プッシュ）で届き、「📋 申請履歴」タブで状況を確認できます。$faq$),
('ced7df7c-e9e5-4b31-aece-f042db2f5d3c', $faq$①ナビの「🌿 休暇申請」を開く
②「申請先」で休暇を取る日の勤務校リーダーを選ぶ（フォーム内の「▼ 勤務校リーダー・マネージャー 一覧を表示」で担当を確認できます）
③休暇種別（有給休暇／バースデー休暇（有給）／慶弔休暇／調整休／その他）を選ぶ（10/16以降の時間外調整休・振替休日は「残業申請」で申請します）
④カレンダーで休暇日をタップして選択（複数日可）
⑤日付ごとの勤務校を確かめる（基本シフトの校が入ります。違う日は選び直してください）
⑥事由を入力して送信

できるだけ休暇予定日の2週間前までに申請し、申請後は選択したリーダーへ直接ご相談ください。受理されるとGoogleカレンダーに自動登録されます。$faq$),
('fa4ad670-aad5-4a8a-910d-971d283f021a', $faq$時刻を入れず1日単位で記録する種別です。10/16以降の勤務日は、休暇申請の「調整休」もこちらにまとまりました。

①時間外調整休＝残業分の調整で休む日。受理されると、その日のシフト労働分（例：−7:00）が今期の合計時間数から差し引かれます。
②振替休日＝休日出勤の振替。振替元の勤務日・勤務校を入力します。
③欠勤＝欠勤1日として記録します（合計時間数とは別枠でカウント）。

いずれも受理された時点で完了し、実績報告は不要です。欠勤を受理できるのはマネージャー以上です。
受理されると、上長の「シフト調整」にその日が入ります（休暇申請の調整休と同じです）。$faq$),
('7b29507f-b4d2-419f-a831-1d9c9207afe3', $faq$10/16以降の勤務日は、どちらも「残業申請」の終日（時間外調整休・振替休日）で申請します。休暇申請の「調整休」で申請できるのは10/15までの日だけです。

■ 振替休日
休日出勤・特定日の振替として取る休みです。振替元の勤務日と勤務校の入力が必須です。

■ 時間外調整休
残業（時間外労働）分を調整するために取る休みです。受理されると「🕐 残業・時間管理」の今期の合計時間数から、その日のシフト労働分がマイナス計上されます。$faq$),
('a081d319-9e77-459a-91bb-5bba726cd871', $faq$10/16以降の勤務日の時間調整（遅く出勤・早く退勤）は、休暇申請ではなく「残業申請」で申請します。

①「残業申請」の［事前申請・事後報告］で日付と実際の勤務時間を入れる
②「開始が遅い理由」または「早く終わる理由」で［時間調整で遅く出勤］［時間調整で早退］を選ぶ
③申請先を選んで送る（上長の受理が必要です）

休暇申請の「🕐 時間調整」タブで登録できるのは10/15までの日だけです。登録済みの時間調整は「履歴」の「時間調整」で見られます。
事前にフロア責任者・リーダー（マネージャー）へ相談してから申請してください。$faq$);

-- 前の版は 10/15 まで
update public.faq_answers a set valid_until = '2026-10-15', updated_at = now()
  from _faq_new n where a.id = n.old_id;

-- 新しい版（対象は前の版から写す）
create temporary table _faq_map (old_id uuid, new_id uuid) on commit drop;
insert into _faq_map select old_id, gen_random_uuid() from _faq_new;
insert into public.faq_answers (id, topic_id, valid_from, body)
  select m.new_id, a.topic_id, '2026-10-16', n.body
    from _faq_map m join _faq_new n on n.old_id = m.old_id join public.faq_answers a on a.id = m.old_id;
insert into public.faq_answer_targets (answer_id, school, course, role_title, role_id)
  select m.new_id, t.school, t.course, t.role_title, t.role_id
    from _faq_map m join public.faq_answer_targets t on t.answer_id = m.old_id;

-- 時間調整タブの質問を公開（一本化まで非公開にしていた）
update public.faq_topics set is_published = true
 where id = (select topic_id from public.faq_answers where id = 'a081d319-9e77-459a-91bb-5bba726cd871');

commit;

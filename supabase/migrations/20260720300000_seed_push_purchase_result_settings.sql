-- 備品購入申請の結果報告系イベントにもプッシュ設定を追加（ユーザー要望）。
-- これらは宛先が構造で決まる（申請者本人・共有先マネージャー）ため、
-- 通常のpush-dispatchパイプラインで処理される（役職選択なし）。
-- デフォルトはON（ユーザー要望で結果報告もプッシュする。過多なら管理画面でOFF）。
INSERT INTO notification_settings (event_key, channel, enabled)
SELECT v.event_key, 'push', true
FROM (VALUES
  ('purchase_request:leader_approved'),
  ('purchase_request:manager_approved'),
  ('purchase_request:board_all_approved'),
  ('purchase_request:self_judgment_shared')
) AS v(event_key)
WHERE NOT EXISTS (
  SELECT 1 FROM notification_settings s
  WHERE s.event_key = v.event_key AND s.channel = 'push'
);

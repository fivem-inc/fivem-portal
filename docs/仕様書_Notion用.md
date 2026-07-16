> スタッフ向け業務ポータル「ファイブM スタッフサイト」の全体仕様。
> 最終更新: 2026-07-16

---

## 1. 概要

| 項目 | 内容 |
| --- | --- |
| 名称 | ファイブM スタッフサイト（fivem-portal） |
| 目的 | 交通費・出張・休暇・勤務変更・備品購入/精算の申請、社内連絡、勤怠カレンダーを1つに集約した社内ポータル |
| 利用者 | 全スタッフ（正社員・パート） |
| 本番URL | https://fivem-portal.vercel.app |
| 対応端末 | スマホ（iPhone / Android）・PC。PWA対応（ホーム画面に追加可） |

---

## 2. 技術構成

```
ブラウザ（スマホ / PC）
   │ HTTPS
   ▼
Vercel（フロントエンド）
   React + TypeScript + Vite
   │ Supabase JS SDK
   ▼
Supabase（バックエンド）
   ├─ Auth（ログイン）
   ├─ Database（PostgreSQL + RLS）
   ├─ Edge Functions（Deno）
   ├─ Storage（レシート画像）
   └─ pg_cron / Vault（定期実行・秘密鍵）
   │ Webhook / API
   ▼
Slack / Google カレンダー / Web Push（プッシュ通知）/ メール
```

| レイヤー | 技術 |
| --- | --- |
| フロント | React + TypeScript + Vite（Vercel自動デプロイ） |
| バックエンド | Supabase（PostgreSQL・Auth・Edge Functions・Storage） |
| 定期実行 | pg_cron（プッシュ配信・リマインド・容量チェック等） |
| 通知連携 | Slack Webhook / Web Push（VAPID）/ サイト内通知 / メール |
| カレンダー連携 | Google カレンダー（gcal-sync Edge Function） |

---

## 3. 役職（ロール）と権限

### 役職一覧
`管理者` ・ `社長` ・ `マネージャー` ・ `リーダー` ・ `フロア責任者` ・ `一般` ・ `パート`

### 雇用形態
`正社員` ・ `パート`

### 権限の考え方
- **管理者** … すべての機能・管理画面にアクセス可（常に最上位）
- **承認者**（リーダー / マネージャー / フロア責任者 / 社長 / 管理者）… 申請の承認・受理が可能
- 各機能の表示ON/OFFは **管理画面「権限管理」タブ** で役職ごとに設定（`feature_permissions`）
    - 対象キー: `expense`（交通費）/ `trip_report`（出張）/ `leave_request`（休暇）/ `leave_approvals`（休暇承認ページ）/ `leave_calendar`（カレンダー）/ `shift_report`（勤務変更報告）/ `board`（連絡板）/ `purchase_request`（備品購入申請・経費精算）
    - `purchase_request` はパートも「精算のみ」利用可

---

## 4. 画面一覧（ルート）

| パス | 画面 | 概要 |
| --- | --- | --- |
| `/` | ホーム（Dashboard） | 各機能への入口・承認待ちバナー・未読通知・プッシュ案内バナー |
| `/` 内 交通費 | 交通費申請 | カート型UIで複数経路を申請 |
| `/trip-report` | 出張報告 | GPS付き出張報告（到着・終了） |
| `/leave` | 休暇申請 | カレンダー選択・休暇/時間調整/有給奨励日回答 |
| `/leave-approvals` | 休暇承認 | 承認者専用（自分の番の申請） |
| `/calendar` | チームカレンダー | 休暇・欠勤の勤怠カレンダー |
| `/shift-report` | 勤務変更報告 | 勤務変更・早出・複数種別報告（パート・アルバイト） |
| `/purchase` | 備品購入申請・経費精算 | 購入前の承認申請・購入後の立替精算記録 |
| `/board` | 連絡板 | 社内連絡・お知らせ・DM・グループ |
| `/admin` | 管理画面 | 各種管理タブ（管理者・承認者向け） |
| `/account` | アカウント設定 | 名前・メール・パスワード・プッシュ通知 |
| `/notification-settings` | 通知設定（本人用） | 自分宛て通知の受け取り設定 |
| `/change-email` `/change-password` | メール/パスワード変更 | アカウント設定のサブ画面 |
| `/signin` `/reset-password` | ログイン・パスワード再設定 | 認証画面 |

---

## 5. 機能モジュール詳細

### 5-1. 🚃 交通費申請
- **カート型UI**: 1件ずつ入力 →「申請リストに追加」→ まとめて申請
- 「⇄ 往復で追加」「複製」「📋 よく使う経路（使用頻度順）」「申請履歴テンプレート」
- 通勤区分: 通勤（単発）/ 定期 / 出張（園指導等）/ その他
- バリデーション: 必須項目ハイライト・定期と単発の混在禁止・定期の日付前後チェック
- 送信前に確認モーダル → Slack `#07_3閲覧禁止-経理専用` へ通知
- 管理画面で承認・却下管理

### 5-2. 📍 出張報告
- GPS取得 → Nominatim APIで住所変換（「京都市左京区〇〇町」レベル）
- 区分（出張・園指導・試合・下見・その他）で場所プリセット表示
- 終了報告時に Slack 通知（チャンネル選択式・晃平先生は自動付与）
- 次回（次月）予定カレンダー
- 管理画面で到着/終了フィルター・GPS→住所リンク

### 5-3. 🌿 休暇申請
- **承認フロー**: 申請者 → リーダー → マネージャー → 経理（管理者）→ 社長 → 完了
    - `pending → step2_pending → manager_approved → admin_approved → approved`
- 休暇種別: 有給 / バースデー休暇 / 慶弔 / その他
- カレンダー多日付選択（2か月超は不可）
- 文言: 承認→**受理**、却下→**差し戻し**
- 各ステップで Slack 通知（リーダー回覧 / マネージャー回覧 / 経理専用 / 晃平先生へ）
- パートへ申請フォームを送信する機能（リーダー/マネージャー/管理者）
- **🕐 時間調整（自己登録）**: 調整遅出・調整早退を承認不要で直接登録
- **有給奨励日**: 管理者が奨励日を作成 → 対象者が4択回答（有給/欠勤/定休/その他）。未回答者へ自動リマインド

### 5-4. 📅 チームカレンダー
- 休暇・欠勤（遅刻・早退・全欠勤）を表示
- 登録・取消で Google カレンダーへ自動同期（gcal-sync）
- 色: 有給・慶弔=ピンク / 遅刻・早退=緑 / 全欠勤=ピンク
- **欠勤・遅刻・早退の登録時に、同グループの該当役職者へ自動通知**（attendance-notify）
- ⚠️ 仕様メモ: **過去日付のイベントはGoogleカレンダー側で自動的に薄く表示される**（colorIdとは無関係）

### 5-5. ⏰ 勤務変更報告（パート・アルバイト）
- 事後報告用。勤務変更・早出・複数種別の同時選択に対応
- ステータス: 報告時（`pending`）→ 受理（`confirmed`）/ 差し戻し（`returned`）/ 再提出（`resubmitted`）/ 取消（`cancelled`）
- 代行報告（本人以外の分を報告）に対応
- グループフィルター・管理タブで受理/差し戻し管理
- 通知: 報告時→承認者、受理時・差し戻し時→本人＋選択チャンネル（Slack/メール/サイト/プッシュを設定で出し分け）

### 5-6. 🧾 備品購入申請・経費精算（`/purchase`）
社内備品の購入について、購入前の承認と購入後の立替精算を扱うモジュール。

| 区分 | 内容 |
| --- | --- |
| 購入申請 | 購入前に承認を得るフロー。金額・ルートに応じて承認先が変わる |
| 立替精算 | 立て替えて購入した費用の精算記録（承認操作なし・記録のみ） |

- **3つの承認ルート**（申請時に自動判定）
    - リーダー承認ルート（`pending_leader`）
    - マネージャー審議ルート（`pending_manager`・複数マネージャーへ依頼、意見出揃いで通知）
    - 全員承認ルート（`pending_board`・選ばれた承認者全員の承認で自動確定）
- 自己判断・共有、最終承認、差し戻し、立替精算記録の各段階で通知
- レシート画像を Storage にアップロード（署名付きURL発行・一括ZIP出力）
- パートは「精算のみ」利用可
- 管理画面「購入申請」タブで申請/精算の一覧・CSV出力（申請のみ/精算のみ）・修正履歴

### 5-7. 💬 連絡板（社内連絡）
LINE風の社内連絡ツール。「楽らく連絡プラス」の代替。

| 機能 | 内容 |
| --- | --- |
| お知らせ送信 | 受信トレイへ配信。期限・種別（確認/回答/提出/承認）設定可 |
| 受信トレイ | フィルター: すべて / **未読** / 未対応 / 読了 / 回答 / 提出 / 承認 / アーカイブ |
| 送信トレイ | 送信済み / 予約済み / 下書き / アーカイブ |
| グループ | グループ宛の連絡（三役・マネージャー・リーダー・全員 等） |
| DM | 個人メッセージ（1対1）／複数選択で一斉個別配信 |
| リプライ | グループ/DMのみ（お知らせには非表示） |
| 既読 | 既読人数表示・管理者は既読者/未読者の名前一覧も確認可 |
| お気に入り | メッセージ・チャンネルを★で保存 |
| 自動CC | 「代表者設定」で選んだ人にお知らせを自動CC |
| 通知 | サイト内通知・メール・プッシュ通知（投稿ごとに選択） |
| 見積参考リンク | コメント＋URL混在でも文中URLを自動リンク化 |

### 連絡板の権限（管理画面 連絡板設定タブ）
- **お知らせ送信**: 役職で制御（未設定なら全員可・管理者は常に可）
- **グループ作成**: 設定で選んだ人＋管理者（未設定なら「自動CC代表者」と同じ人）
- **DM送信**: 雇用形態・役職で制御（未設定なら全員可）

---

## 6. 管理画面（/admin）タブ構成

| タブ | 内部キー | 内容 |
| --- | --- | --- |
| 交通費 | `approvals` | 交通費申請の承認・却下・分析 |
| 出張報告 | `trip_reports` | 出張報告一覧・区分/場所マスタ管理 |
| 休暇申請 | `leave_requests` | 全休暇申請の管理・有給奨励日・修正履歴 |
| 勤務変更 | `shift_reports` | 勤務変更報告の受理・差し戻し管理 |
| 購入申請 | `purchase_requests` | 備品購入申請・立替精算の一覧・CSV・修正履歴 |
| ユーザー | `users` | 雇用形態・役職・並び替え・有効/無効・プッシュ状況 |
| グループ | `groups` | グループの作成・名前変更・メンバー管理 |
| リーダー | `leader_assignments` | コース・校舎ごとの担当リーダー/マネージャー |
| レポート | `reports` | 各種集計・分析 |
| 通知設定 | `notifications` | イベント別に宛先・チャンネル・テンプレート・プッシュ案内バナー設定 |
| リマインド設定 | `scheduled_reminders` | 定期リマインド・未読リマインドの設定 |
| 連絡板設定 | `board_settings` | 送信権限・DM権限・グループ作成権限・自動CC |
| お知らせ | `announcements` | 社内お知らせ（作成時連絡・期限接近リマインド） |
| 権限管理 | `feature_permissions` | 役職ごとに各機能の表示ON/OFF |

---

## 7. データベース（主要テーブル）

| テーブル | 用途 |
| --- | --- |
| `profiles` | スタッフ情報（名前・雇用形態・役職・グループ） |
| `expenses` / `expense_templates` | 交通費申請・テンプレート |
| `business_trip_reports` | 出張報告（住所・次回予定含む） |
| `leave_requests` | 休暇申請（承認フロー・修正履歴） |
| `attendance_exceptions` | 欠勤・遅刻・早退・時間調整 |
| `shift_reports` / `shift_report_history` | 勤務変更報告・変更履歴 |
| `purchase_requests` | 備品購入申請・立替精算（承認ルート・レシート・修正履歴） |
| `leader_assignments` | 担当リーダー/マネージャー |
| `paid_leave_encouragement_*` | 有給奨励日（マスタ・対象者・回答） |
| `board_channels` / `board_channel_members` | 連絡板チャンネル・メンバー |
| `board_messages` / `board_message_recipients` | 連絡板メッセージ・宛先 |
| `board_reads` / `board_confirmations` | 既読・確認 |
| `board_favorites` / `board_channel_last_seen` | お気に入り・最終既読 |
| `board_scheduled_reminders` | 定期リマインド |
| `announcements` | 社内お知らせ |
| `notifications` | サイト内通知（🔔ベル＋ホームバナー。プッシュ配信の入口） |
| `notification_settings` | イベント×チャンネル別の通知ON/OFF・宛先・テンプレート |
| `email_templates` | メール通知テンプレート |
| `push_subscriptions` | プッシュ通知の購読情報 |
| `push_queue` | プッシュ送信待ちキュー（トリガーで積み、cronで集約送信） |
| `master_options` | 各種マスタ（区分・場所・グループ等） |
| `app_settings` | アプリ設定（連絡板権限・CC・プッシュ案内バナー等のキー/値） |
| `gcal_events` | Googleカレンダー連携イベント |
| `feature_permissions` / `roles` | 機能の役職別権限 |

> 🔒 全テーブルに RLS（行レベルセキュリティ）を設定。個人データのSELECTは本人＋役職者に限定、全開放は無し（2026-07-14 本番DB直接監査で確認済）。

---

## 8. Edge Functions（サーバー処理）

### 申請・承認の通知系
| 関数 | 役割 |
| --- | --- |
| `slack-notify` | 交通費申請のSlack通知 |
| `send-leave-slack` | 休暇申請のSlack通知（ステップ別チャンネル） |
| `send-trip-slack` | 出張報告のSlack通知（チャンネル選択式） |
| `send-purchase-slack` | 備品購入申請のSlack通知 |
| `time-adjustment-notify` | 時間調整登録時の通知 |
| `attendance-notify` | 欠勤・遅刻・早退の登録時に役職＋グループ配信 |
| `shift-report-confirmed-notify` | 勤務変更報告 受理時の通知（4チャンネル出し分け） |
| `shift-report-returned-notify` | 勤務変更報告 差し戻し時のSlack通知 |
| `purchase-reimbursement-notify` | 立替精算 記録時の通知 |
| `encouragement-notify` | 有給奨励日の未回答者へ通知 |

### プッシュ・メール・リマインド
| 関数 | 役割 |
| --- | --- |
| `send-push` | Web プッシュ通知の送信（VAPID・aes128gcm） |
| `push-dispatch` | push_queue を集約し「状態名詞＋件数」で送信（1分毎cron） |
| `send-email` | メール送信 |
| `send-rejection-email` | 差し戻しメール |
| `remind-scheduled` / `remind-unread` | リマインド（予約・未読） |
| `board-scheduled-send` | 連絡板の予約送信 |
| `announcement-notify` / `announcement-remind` | 社内お知らせの作成連絡・期限接近リマインド |

### アカウント・ファイル・運用
| 関数 | 役割 |
| --- | --- |
| `create-user` / `delete-user` | ユーザー作成・削除 |
| `new-signup-notify` / `record-signup-ip` | 新規登録の通知・IP記録 |
| `gcal-sync` | Googleカレンダーへの同期（休暇・欠勤） |
| `receipt-signed-url` / `receipt-bulk-zip` | レシート画像の署名付きURL発行・一括ZIP出力 |
| `storage-usage-check` | ストレージ使用量チェック（毎週月曜9:00 cron） |

---

## 9. 通知の仕組み

| 種類 | 用途 |
| --- | --- |
| Slack | 申請・承認の業務連絡（各専用チャンネル） |
| サイト内通知 | 🔔ベルアイコン＋ホームバナー（`notifications` の1行が両方に出る） |
| メール | 重要通知 |
| プッシュ通知 | スマホ/PCへの即時通知（PWA・VAPID） |

### プッシュ通知パイプライン（ベル通知→プッシュの自動連動）
```
notifications へ INSERT（event_key付き）
   → AFTER INSERTトリガーが push_queue に送信待ちを積む
   → 1分毎の pg_cron が push-dispatch を呼ぶ
   → user × event_key で集約し「状態名詞＋件数」で送信
```
- トリガーは EXCEPTION 捕捉でベル通知本体を守る（プッシュ側が全滅してもベルは無傷）
- **サイト内通知をOFFにすると、そのイベントのプッシュも止まる**（ベル通知が入口のため）
    - ただし時間調整・勤務変更受理・欠勤登録・立替精算は専用Functionが直接送るため独立

### 🚨 プッシュ文面ルール（実機テスト済・変更禁止）
- **OK**: 状態を表す漢字名詞＋件数（新着 / 本日期限 / 明日期限 / 差戻 / 未承認 / 承認）
- **NG**: 「確認」「依頼」「〜待ち」「差し戻し」（ひらがな交じり）・文章形・短時間の連続送信
    - → Android Chrome が「不正な通知」と判定し警告表示に化ける

### プッシュ通知ONの案内
- **アプリ内バナー**（`PushEnableBanner`）: 未ONの人だけ表示。Android=「許可する」ボタン、iPhone=ホーム画面追加手順
- 管理画面「通知設定」タブで、案内バナーの表示ON/OFF・文面・再表示間隔を設定可
> 📱 iPhoneは「ホーム画面に追加」（PWAインストール）しないとプッシュ通知が届かない。

---

## 10. 運用・注意事項

- **デプロイ**: `git push`（master）→ Vercel が自動デプロイ。Edge Function は `supabase functions deploy <名前>` が別途必要（Docker不要）
- **DBマイグレーション**: `supabase db query --linked --file <SQL>`。新イベント/新チャンネルは `notification_settings` に行が無いと通知設定画面に出ない
- **本番Supabase**: `https://xaeynaxctiiyqxjyuzfi.supabase.co`
- **Slack Webhook URL** はコードに直書き禁止 → Supabase Edge Function Secrets に登録
- **セキュリティ**: PAT（アクセストークン）を git remote URL に直書き禁止（GCMのブラウザログインを使う）
- **UIルール**:
    - `alert()` 禁止 → 成功時は緑カード
    - `window.confirm()` 禁止 → インライン確認パネル（赤枠）
    - `.catch()` 禁止・認証は AuthContext に一元化
- Googleカレンダーの過去日付イベントが薄いのは**仕様**（colorIdとは無関係）

---

以上です。Notionページに貼り付ければ、表や見出しがそのまま反映されます。ファイル版も `docs/仕様書_Notion用.md` に残してあります（コミットはしていません）。

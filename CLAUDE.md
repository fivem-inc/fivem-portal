# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 🚀 毎回の開発開始手順

### ⚠️ 作業開始前に必ず確認すること
**Claudeは最初に必ずユーザーに以下を確認すること：**
1. **ローカルで開発するか、直接デプロイだけか？**
   - ローカル開発 → `npm run dev` でサーバー起動してから作業
   - 確認・デプロイのみ → サーバー起動不要
2. **どのPCか？**（ユーザー名によってパスが変わる）

### 🚨 デプロイのルール
- **git push（デプロイ）はユーザーの指示があってから行うこと**
- コード修正後はローカルで確認してもらい、OKの指示が出てからpushする
- 自動デプロイはしない

### ローカルで開発する場合
```
cd C:\Users\[ユーザー名]\fivem-portal
git pull
cd client
npm run dev
```
ブラウザで http://localhost:5173 を開く

### Claude Code での作業開始
1. Claude Code を開く
2. 作業ディレクトリ: `C:\Users\[ユーザー名]\fivem-portal`
3. **CLAUDE.md の「次回やること」を確認してから作業開始**

---

## 🖥️ 新しいPCでの環境構築手順

### 1. Node.js インストール
以下のURLから直接ダウンロード：
https://nodejs.org/dist/v24.16.0/node-v24.16.0-x64.msi

- ダウンロードしたファイルをダブルクリック
- 「Next」を連打してインストール（途中のチェックボックスはそのままでOK）
- **インストール後はPCを再起動する**

### 2. リポジトリをクローン
```
git clone https://github.com/fivem-inc/fivem-portal
```

### 3. パッケージをインストール（2か所で必要）
```
cd fivem-portal
npm install

cd client
npm install
```

### 4. アプリを起動
```
cd client
npm run dev
```

### 5. ブラウザで開く
http://localhost:5173

### 注意
- `.env` ファイルはリポジトリに含まれているので設定不要
- `npm install` はルートと `client` フォルダの**両方**で実行すること

---

## 👥 SQLでユーザーを一括追加する方法

### 手順
古いSupabaseから以下の形式でprofilesデータをもらう：
```
INSERT INTO "public"."profiles" ("id", "email", "name", "is_admin", "is_active") VALUES ('UUID', 'email', '名前', false, true), ...;
```

このデータをClaudeに渡すと、以下の3つのSQLを自動生成します：
1. **auth.usersに一括INSERT** （パスワード=メールの@より前）
2. **auth.identitiesに一括INSERT**
3. **profilesのnameを一括UPDATE** （退職者はis_active=falseも設定）

**既存ユーザーは自動スキップ（重複しない）**

---

### 正しい手順（必ずこのSQLを使うこと）

```sql
-- 1. auth.usersに追加（空文字カラムに注意！NULLにしてはいけない）
INSERT INTO auth.users (
  id, instance_id, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  aud, role,
  raw_app_meta_data,
  confirmation_token, recovery_token,
  email_change, email_change_token_new
)
VALUES (
  gen_random_uuid(),
  '00000000-0000-0000-0000-000000000000',
  'staff@example.com',
  crypt('moriakiko', gen_salt('bf', 10)),
  NOW(), NOW(), NOW(),
  'authenticated', 'authenticated',
  '{"provider":"email","providers":["email"]}',
  '', '', '', ''
);

-- 2. auth.identitiesに追加（provider_idはUUIDにすること！メールアドレスにしてはいけない）
INSERT INTO auth.identities (id, user_id, identity_data, provider, provider_id, last_sign_in_at, created_at, updated_at)
VALUES (
  gen_random_uuid(),
  (SELECT id FROM auth.users WHERE email = 'staff@example.com'),
  jsonb_build_object('sub', (SELECT id FROM auth.users WHERE email = 'staff@example.com')::text, 'email', 'staff@example.com'),
  'email',
  (SELECT id FROM auth.users WHERE email = 'staff@example.com')::text,
  NOW(), NOW(), NOW()
);

-- 3. profilesに追加
INSERT INTO profiles (id, email, name, is_active)
VALUES (
  (SELECT id FROM auth.users WHERE email = 'staff@example.com'),
  'staff@example.com',
  'スタッフ名前',
  true
);
```

### パスワードのルール
- 仮パスワードは **メールアドレスの@より前** にする
  - 例: `sgwhryk@gmail.com` → パスワードは `sgwhryk`
  - 例: `na0246@icloud.com` → パスワードは `na0246`

### ⚠️ 注意事項
- `confirmation_token`, `recovery_token`, `email_change`, `email_change_token_new` は必ず **空文字（''）** にすること（NULLにするとログイン時に500エラーになる）
- `provider_id` は必ず **UUID** にすること（メールアドレスにするとログインできない）
- `encrypted_password` は `gen_salt('bf', 10)` でコスト10にすること（コスト6だとエラーになる場合あり）
- 仮パスワードは `moriakiko` で統一。本人にパスワード変更してもらうこと

### トラブルシューティング（2026-05-31 発生・解決済み）
- **「Database error querying schema」エラー** → `email_change`等が空文字でなくNULLになっていた → 上記SQLで修正
- **「Database error querying schema」エラー** → `auth.identities`の`provider_id`がメールアドレスになっていた → UUIDに修正
- **ログインできない** → `auth.identities`テーブルへの追加を忘れていた → 追加で解決
- **「メールアドレスまたはパスワードが正しくありません」エラー（パスワードは正しいのに）** → `instance_id` が NULL になっていた → `UPDATE auth.users SET instance_id = '00000000-0000-0000-0000-000000000000' WHERE email = '...';` で解決
- **ログイン後に expenses/profiles リレーションエラー** → `expenses`テーブルに外部キーがなかった → `ALTER TABLE public.expenses ADD CONSTRAINT fk_expenses_profiles FOREIGN KEY (user_id) REFERENCES public.profiles(id);` で解決

---

## ⚠️ Supabase URL移行トラブル（2026-05-31 発生・解決済み）

### 問題
- `business_trip_reports` テーブルへのAPIアクセスが404エラーになり続けた
- テーブルはダッシュボードに存在するのに送信できなかった

### 原因
- SupabaseがプロジェクトのURLを新形式に移行していた
  - 旧URL: `https://unwdmdgtzbhwflepabud.supabase.co`
  - 新URL: `https://xaeynaxctiiyqxjyuzfi.supabase.co`
- `.env`が古いURLのままだったため、新しいテーブルが認識されなかった

### 解決方法
`.env` を以下のように更新する：
```
VITE_SUPABASE_URL=https://xaeynaxctiiyqxjyuzfi.supabase.co
VITE_SUPABASE_ANON_KEY=sb_publishable_ZA6Udr3Ww9_dQO0CKKhSGw_Phx8Kegp
```

### 教訓
- 新しいテーブルが404になる場合はSupabaseのURLが変わっていないか確認
- Settings → General でProject URLを確認し、`.env`と一致させる

## ✅ 2026-06-01 Phase2: ユーザー情報拡張・グループ管理完了

### DBに追加したカラム（profilesテーブル）
- `employment_type` TEXT DEFAULT '正社員'
- `role_title` TEXT DEFAULT '一般'
- `group_names` TEXT[]（複数グループ対応・配列型）
- `leave_request_enabled` BOOLEAN DEFAULT false

### 追加したテーブル: `master_options`
- category / value / sort_order
- employment_type: 正社員・パート
- role_title: 一般・リーダー・マネージャー・社長・管理者
- group: こども・パート・アルバイトスタッフ・マネージャー・リーダー・マネージャー専用・三役・大人・正社員・契約社員
- RLS: 全員読み取り可

### フロントエンド変更
- ユーザー管理テーブルに雇用形態・役職列（編集モードボタン・確認ポップアップ付き）
- 非編集時はセレクト矢印非表示
- 👥 グループ管理タブ追加（グループ一覧・名前変更・削除・メンバー追加削除・新規作成）
- コミット: `80dc859`

## 🔧 リーダー管理機能(2026-06-06実装)レビュー指摘・要修正

UI/UXとシニアエンジニアの2エージェントでレビュー、以下が未対応:

### 優先度高(実害あり)
1. `LeaveRequest.tsx`約403行目: `leaderAssignments.length === 0`で
   「読み込み中...」表示 → データを全削除した場合も同じ表示になり区別できない。
   `isLoading`等の専用stateで「読み込み中」と「データなし」を分けるべき。
2. `LeaderAssignmentsTab.tsx`の`saveEdit`/`handleDelete`: 処理中のローディング
   状態がなく、ボタン連打で重複登録の恐れ。処理中はボタンをdisabledに。

### 優先度中
3. migration `20260606000000_create_leader_assignments_table.sql`: UPDATEポリシーに
   `WITH CHECK`がない(INSERTにはある→不統一)。
4. UI/UX: 改行区切り入力の説明不足、削除確認ダイアログに対象名がない、
   表示順(display_order)の意味が伝わりにくい。

---

## ✅ 2026-06-06 休暇申請: リーダー・マネージャー一覧を管理画面で編集可能に

### 完了した内容
- Supabaseに`leader_assignments`テーブルを新規作成(course/school/leader/manager/display_order)
  - RLS: 閲覧は全認証ユーザー、編集はadmin(app_metadata.role='admin')のみ
  - 既存のハードコード内容を初期データとして投入済み
- 管理画面に「📋 リーダー管理」タブ(LeaderAssignmentsTab.tsx)を追加し、
  一覧の追加・編集・削除がGUIから可能に
- LeaveRequest.tsxの担当リーダー一覧パネルをDB読み込み方式に変更
  (ハードコードされた表を撤去し、leader_assignmentsテーブルから動的に表示)

### 不具合修正(同時対応)
- 前回コミットで'tdSchool'という未使用変数の宣言が残りビルドエラーになっていた
  → 表示部分をDB読み込み方式に書き換えたことで解消

---

## ✅ 2026-06-06 休暇申請: 担当リーダー・マネージャー一覧パネル追加

### 完了した内容
- 休暇申請フォーム(LeaveRequest.tsx)の注意事項欄に、開閉式の
  「勤務校リーダー・マネージャー一覧」パネルを追加
- 「申請先がわかりにくい」という声を受け、コース・校舎ごとに
  担当リーダー/マネージャーを一覧表示(表形式、コース見出しは色帯)
- ボタン文言は注意事項の表現に合わせて「▼ 勤務校リーダー・マネージャー 一覧を表示」

---

## ✅ 2026-06-06 経費フォーム: 誤送信バグ修正＋ボタン文言改善

### 完了した内容
- SingleDatePicker内の全ボタン(前月/翌月/クリア/日付セル)とエラー閉じるボタンに
  type="button" を追加 → <form>内でデフォルトsubmit扱いになり誤ってホームに戻る
  バグを修正(レビューで2箇所漏れ発見、追加修正済み)
- 「＋ 追加」→「＋ 申請リストに追加」、「⇄ 往復で追加」→「⇄ 往復で申請リストに追加」
  に文言変更(新人が「これで申請完了」と誤解しないように)
- 誤って紛れ込んでいたpreview_design.htmlを削除

### 次回やること（優先順）
1. **Phase 3: 休暇・有給申請**（優先①）← 2026-06-02に着手・途中
2. **Phase 1: メール送信機能**（優先②）
3. **Phase 4: 出張報告拡張**（住所変換・Slackチャンネル選択）

---

## ✅ 2026-06-02 Phase3: 休暇申請機能 実装完了

### 完了した内容（全て）

#### DBに追加したカラム
- `leave_requests.approver2_id` UUID（マネージャー用・2026-06-02追加）
- `profiles` RLS: 全認証ユーザーが読み取り可能ポリシー追加

#### 承認フロー（確定版）
```
申請者 → 一人目(pending) → 承認時にマネージャー選択 → マネージャー(step2_pending) → 経理(manager_approved) → 社長(admin_approved) → 完了(approved)
```
- 一人目承認時にマネージャーを選んで送る（モーダルで選択）
- 管理者は全申請を強制的に次へ進められる
- 却下取り消し機能あり（管理者: pending戻し、承認者: 自分のステップ戻し）

#### LeaveRequest.tsx（申請者画面）
- 新規申請タブ + 申請履歴タブ（切り替え）
- 履歴カードにステータスバッジ・却下理由表示
- 申請完了後「申請履歴を確認」ボタン追加

#### LeaveApprovals.tsx（承認者専用ページ /leave-approvals）
- リーダー・マネージャー: 自分の番の申請のみ表示
- 管理者: 全申請表示
- 一人目承認 → マネージャー選択モーダル
- 却下済みカードに「↩ 却下を取り消す」ボタン（自分のステップに戻す）
- 右上 ✕ でホームに戻る

#### App.tsx
- Dashboard に承認バナー（自分の番が N件）表示
- `/leave-approvals` ルート追加
- useAuth の loading フラグ修正（プロフィール取得前に弾かない）

#### AdminPanel.tsx 休暇申請タブ改善
- フィルター: 承認待ち / 承認済み / 却下 / すべて（デフォルト: 承認待ち）
- ソート: フロー順①②③④→承認済み→却下、同ステップ内は新着順
- 承認状況列: 役職＋名前の2行バッジ（①②③④番号付き）
- 操作列: 承認（緑）・却下（赤）・削除（グレー縦書き）
- 却下済みに「↩ 取り消し」ボタン → pending に戻す
- 名前を全角スペースで2行分割表示

### ✅ 2026-06-02 グループ追加機能 修正完了
- `master_options`テーブルにRLSポリシー追加（管理者のINSERT/UPDATE/DELETE許可）
  - `(auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'` で判定
- エラーハンドリング追加（失敗時にalertで表示）
- コミット: `d4f23c3`

### ✅ 2026-06-02 休暇申請フロー改善完了
- **パートへ申請フォーム送信機能**
  - 管理者画面「休暇申請」タブ → パートを選択 → 「送信」で`leave_request_enabled=true`
  - パートのホームに「📨 申請フォームが届いています」バナー表示 → タップで申請画面へ
  - パートには申請履歴タブ非表示・送信後「ホームへ戻る」のみ
  - 申請完了後`leave_request_enabled=false`に自動リセット
  - RLS追加: `leave_requests`テーブルで承認者が自分宛を読める
- **社長の承認フロー**
  - `admin_approved`ステータスをLeaveApprovals・バナーに追加
  - 社長ホームに承認待ちバナー表示
  - 承認ボタンに確認ダイアログ追加
- **管理者画面の承認フロー修正**
  - `pending → step2_pending`のスキップバグ修正
- コミット: `e8a8bd9`, `1cb310e`

### ✅ 2026-06-02 バグ修正
- **休暇申請 削除できない** → RLSにDELETE権限がなかった → 追加済み
- **削除エラーハンドリング追加** → 失敗時にalertで表示
- コミット: `505e9ed`

### Supabase RLS（追加済み）
```sql
-- master_options: 管理者のINSERT/UPDATE/DELETE
(auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'

-- leave_requests: 承認者が自分宛を読める
approver_id = auth.uid() OR approver2_id = auth.uid()
OR role_title = '社長' で admin_approved も読める

-- leave_requests: 管理者のDELETE
(auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
```

### ✅ 2026-06-02 パートフォーム送信の権限制御
- `profiles`に`leave_enabled_by` UUID カラム追加（Supabase SQL済み）
- リーダー → 自分が送ったパートのみ表示・取り消し可
- マネージャー・社長・管理者 → 全員分表示・取り消し可
- 承認ページ（/leave-approvals）にもパート送信UIを追加
- LeaveRequest.tsx に「✅ 承認ページ」ボタン追加（承認者のみ表示）
- コミット: `c8cd3dc`
- ビルドエラー修正: `1d77e8a`（canApprove未使用・TripReportPageでroleTitle未定義）

### ✅ 2026-06-02 管理者承認フロー改善
- 管理者が`pending`申請を承認する際にマネージャー選択モーダルを追加
- 「✅ 承認ページへ」ボタンをタブ下に独立配置（承認者のみ表示）
- コミット: `22e4b32`

### Supabase SQL（追加済み）
```sql
ALTER TABLE public.profiles ADD COLUMN leave_enabled_by UUID REFERENCES auth.users(id);
CREATE POLICY "leader_manager_update_leave_enabled" ON public.profiles FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
```

## ✅ 2026-06-03 休暇申請UI全面改善 完了

### 変更内容
- **カレンダー多日付選択**: 日付をタップで個別選択・解除、2か月超はNG
- **休暇種別**: 有給休暇 / バースデー休暇（有給）/ 慶弔休暇 / その他
- **事由（必須）・備考（任意）** フィールド追加
- **注意事項** 4項目をフォーム上部に表示
- **文言変更（全画面）**: 承認→受理、却下→差し戻し
- **受理済みバナー**: ホーム画面に表示、タップで申請履歴へ・localStorage消去
- **管理者画面**: 承認状況→確認状況、開始日/終了日→休暇日（年/月/日・日・日形式）
- **管理者画面**: 申請日新着順固定（ステータス変更で並び替わらない）
- **ナビ重なり修正**: 全ページpaddingTop 80px

### Supabase SQL（実施済み ✅）
```sql
ALTER TABLE public.leave_requests ADD COLUMN IF NOT EXISTS leave_dates TEXT;
ALTER TABLE public.leave_requests ADD COLUMN IF NOT EXISTS purpose TEXT;
```

### コミット: ee686a7

## ✅ 2026-06-04 UI修正完了

- 休暇申請 注意事項を5項目に改訂（申請後リーダーへ相談の流れに変更）
- 出張報告ページ ダークモード対応（カード #343a40・入力欄 #495057 で休暇申請と統一）
- コミット: `16a3201`

---

## ✅ 2026-06-04 休暇申請Slack通知 実装完了

### 通知フロー（確定版）
| タイミング | 送信先チャンネル | 通知文 |
|---|---|---|
| 申請時（リーダー宛） | `#01リーダー回覧` | 【休暇申請】新しい申請・申請先名 |
| 申請時（マネージャー宛） | `#01マネージャー回覧` | 【休暇申請】新しい申請・申請先名 |
| マネージャーが受理 | `#07_3閲覧禁止-経理専用` | 【休暇申請】確認が必要・受理者名 |
| 経理（管理者）が受理 | `#03晃平先生へ` | 【休暇申請】確認が必要・経理担当者＋リンク |
| 社長が受理 | 通知なし（完了） | - |

### 実装ファイル
- `supabase/functions/send-leave-slack/index.ts` （Edge Function）
- `client/src/lib/leaveSlack.ts` （フロント共通関数）
- `client/src/components/LeaveRequest.tsx` （申請時通知）
- `client/src/components/LeaveApprovals.tsx` （承認者画面）
- `client/src/components/AdminPanel.tsx` （管理者画面）

### Slack Webhook URLの管理
⚠️ **Webhook URLはコードに直書き禁止**（GitHubのSecret Scanningで拒否される）
→ **Supabase Edge Function Secrets に登録すること**

Supabase Secrets登録場所：
https://supabase.com/dashboard/project/xaeynaxctiiyqxjyuzfi/functions → Secrets

| Secret名 | 対応チャンネル |
|---|---|
| `SLACK_WEBHOOK_LEADER` | `#01リーダー回覧` |
| `SLACK_WEBHOOK_MANAGER` | `#01マネージャー回覧` |
| `SLACK_WEBHOOK_ACCOUNTING` | `#07_3閲覧禁止-経理専用` |
| `SLACK_WEBHOOK_PRESIDENT` | `#03晃平先生へ` |

### Edge Functionのデプロイ方法
```
cd C:\Users\kohei\fivem-portal
npx supabase functions deploy send-leave-slack --project-ref xaeynaxctiiyqxjyuzfi
```
※ 初回のみ `npx supabase login` が必要

### 今回の問題点・改善メモ
1. **Webhook URLをコードに直書きした** → GitHubにpushできなかった → Supabase Secretsに移動して解決
2. **AdminPanel.tsx に通知を入れ忘れた** → 管理者画面からの受理で通知が来なかった → 追加して解決
3. **Slack通知のステータスマッピングがズレていた** → 1ステップずれた通知が届いた → 修正して解決
4. **LeaveApprovals.tsx で profileName をpropsから受け取っていなかった** → ビルドエラー → 追加して解決

### コミット
- `c160d50` feat: 休暇申請Slack通知実装
- `29c4ffd` fix: 管理者画面にもSlack通知追加
- `64c1fb6` fix: ステータスマッピング修正
- `06a75dc` fix: profileName props修正

### ✅ 休暇申請機能　完了一覧（2026-06-02時点）
- 承認フロー: pending→step2_pending→manager_approved→admin_approved→approved
- 申請者画面: 新規申請・申請履歴タブ・承認者選択
- 承認者画面(/leave-approvals): リーダー/マネージャー/社長それぞれの番のみ表示
- 管理者画面: 全申請管理・フィルター・承認時マネージャー選択モーダル
- パート: 管理者/リーダー/マネージャー/社長からフォーム送信→通知バナー→申請→自動非表示
- リーダーは自分が送ったパートのみ表示、管理者/マネージャー/社長は全員表示
- 「✅ 承認ページへ」ボタン: 休暇申請ページのタブ下に独立配置（承認者のみ）
- 却下・却下取り消し・削除すべて対応

### コミット
- `2bc4c23` Phase3: 休暇申請フォーム実装
- `e8cdb96` Phase3: 管理者画面に休暇申請タブ追加

---

## ✅ 2026-06-04 Slack通知・管理画面改善 完了

### 追加・修正内容
- 管理画面 休暇申請タブ：事由＋備考を同一セルに表示（備考はグレー小文字）
- 管理画面 受理済み申請に「差戻」ボタン追加（差し戻し理由入力あり）
- Slack通知ルール確定：
  - 管理者が自分のステップ（manager_approved）を進めた時のみ `03晃平先生へ` 通知
  - 管理者が他のステップを代わりに進めた場合は通知なし
  - pending/step2_pendingのマネージャー選択モーダルからの通知も削除

### Slack通知 確定ルール（最終版）
| 操作 | 通知先 |
|---|---|
| 新規申請（リーダー宛） | `#01リーダー回覧` |
| 新規申請（マネージャー宛） | `#01マネージャー回覧` |
| リーダーが受理（承認ページ） | `#01マネージャー回覧` |
| マネージャーが受理（承認ページ） | `#07_3閲覧禁止-経理専用` |
| 経理（管理者）が受理（承認ページ or 管理画面） | `#03晃平先生へ` |
| 社長が受理 | 通知なし（完了） |
| 管理者が他ステップを代わりに進める | 通知なし |

### コミット: `765fcec`

---

## ✅ 2026-06-04 Phase4: 出張報告機能拡張 完了

### 実装内容
- GPS取得後にNominatim APIで住所変換（「京都市左京区〇〇町」レベル）
- 住所・次回予定をDBに保存（`address`, `next_dates` カラム追加済み）
- 終了報告時のSlack通知（チャンネル選択制・晃平先生は選択時に自動付与）
- 区分「出張」「園指導」選択時に場所プリセット表示（DBから取得）
- 次回（次月）予定カレンダー（終了・出張/園指導のみ）
- 管理画面: 到着/終了フィルターボタン、GPS→住所リンク、次回予定列
- 管理画面: 区分・場所リスト管理モーダル（追加・削除・名前変更）

### Slack Edge Function（未デプロイ）
- ファイル: `supabase/functions/send-trip-slack/index.ts`
- デプロイコマンド: `npx supabase functions deploy send-trip-slack --project-ref xaeynaxctiiyqxjyuzfi`
- Supabase Secrets登録が必要（SLACK_WEBHOOK_TRIP_KOHEI / ADULT / KIDS_* / JUNIOR）

### Supabase SQL（実施済み）
```sql
ALTER TABLE public.business_trip_reports ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE public.business_trip_reports ADD COLUMN IF NOT EXISTS next_dates TEXT;
INSERT INTO public.master_options (category, value, sort_order) VALUES
  ('trip_category', '出張', 1), ('trip_category', '園指導', 2),
  ('trip_category', '試合', 3), ('trip_category', '下見', 4), ('trip_category', 'その他', 5),
  ('trip_location_出張', '上牧', 1), ('trip_location_出張', 'JEUGIA 四条', 2),
  ('trip_location_出張', 'JEUGIA 西友山科', 3), ('trip_location_出張', 'バンディエラA.F.C', 4),
  ('trip_location_園指導', '太秦保育園', 1), ('trip_location_園指導', '上京陵和園', 2),
  ('trip_location_園指導', '認定こども園 下鴨夢', 3), ('trip_location_園指導', 'HOPPA からすま京都ホテル', 4);
```

### コミット: `8210827`

---

### ✅ Slack Edge Functionデプロイ完了（2026-06-04）
- `send-trip-slack` デプロイ済み
- Supabase Secrets登録済み（KOHEI / ADULT / KIDS_* / JUNIOR / SUPPORT）
- `#07_1お客様サポートへ`（SLACK_WEBHOOK_TRIP_SUPPORT）追加済み・デプロイ済み
- チャンネル一覧: 晃平先生へ（自動）/ 大人 / 本校こども / 西陣校 / 上桂校 / 洛西口校 / 南草津校 / ジュニア / お客様サポート
- コミット: `9bcb6b4`

---

## ✅ 2026-06-05 コードレビュー改善 完了

### 実施内容（UIデザイナー＋シニアエンジニア 2エージェントレビューに基づく）

#### フロントエンド改善
- **`useDarkMode()` カスタムフック新設** (`client/src/hooks/useDarkMode.ts`)
  - 静的な `window.matchMedia(...).matches` をリアクティブに置き換え
  - LeaveRequest / LeaveApprovals / BusinessTripReport / AdminPanel 全4ファイルに適用
  - OS のダークモード切り替えに即座に追従するようになった
- **`isApprover` を `useAuth` に集約** (`client/src/hooks/useAuth.ts`)
  - `['リーダー', 'マネージャー', '社長', '管理者'].includes(roleTitle)` の重複を排除
  - `APPROVER_ROLES` 定数として1か所で管理
  - App.tsx 全ページで `isApprover` を使用するよう統一
- **カレンダーのタップ領域拡大** (`LeaveRequest.tsx`)
  - `padding: '7px 0'` → `padding: '10px 2px', minHeight: 40` に変更
  - スマホでのタップ失敗を防止
- **`alert()` → インラインエラーバナーに変更** (`ExpenseForm.tsx`)
  - 全バリデーションエラーを赤いバナーで表示（✕で閉じられる）
  - 送信成功も緑のバナーで表示
  - `alert()` ダイアログを完全廃止

#### Edge Function セキュリティ改善
- **JWT 認証チェック追加**（slack-notify / send-leave-slack / send-trip-slack 全3本）
  - `Authorization: Bearer ...` ヘッダーがない場合 401 を返す
- **CORS を本番ドメインに制限**（全3本）
  - `Access-Control-Allow-Origin: *` → `https://fivem-portal.vercel.app` に変更

#### その他
- `STRUCTURE.md` 追加（プロジェクト構造をアスキーアートで整理）

### 保留項目（リリース後に対応）
- AdminPanel.tsx (3803行) の6ファイル分割
  - タブ: approvals(L1816) / groups(L2561) / users(L2719) / trip_reports(L2959) / reports(L3254) / leave_requests(L3432)
  - 全タブが同一stateを共有しているため、リリース後に余裕をもって実施する
- `any` 型を型定義に置き換え（`useState<any[]>` → `useState<LeaveRequest[]>` 等）

### コミット
- `4eb605b` refactor: レビュー改善
- `58fc85f` docs: STRUCTURE.md追加

---

## ✅ 2026-06-05 追加修正・機能追加 完了

### Slack通知（交通費）修正
- `slack-notify` のWebhook URLをコードから削除 → Supabase Secrets `SLACK_WEBHOOK_EXPENSE` に移動
  - 登録先チャンネル: `#07_3閲覧禁止-経理専用`（`SLACK_WEBHOOK_ACCOUNTING` と同じURL）
- 通知フォーマットを旧シンプル形式に戻した（申請者・申請日・申請内容・項目数）
- Edge FunctionのCORSをlocalhost:5173/5174も許可するよう修正
- Slack通知送信を `fetch()` → `supabase.functions.invoke()` に変更（JWT形式エラー解消）

### 交通費申請フォーム改善
- **送信前確認モーダル追加**（出張報告と同じ仕様）
  - 「申請する」→ 内容確認画面（下からスライド）→「この内容で申請する」で送信
  - 「修正する」でフォームに戻れる
- **日付入力をカスタムカレンダーに変更**（スマホ対応）
  - `<input type="date">` を廃止 → タップで即確定するカスタムカレンダー
  - 画面中央に固定表示（切れない）
- エラーバナー・成功バナーを「申請する」ボタン直下に配置
- 成功バナーの表示時間を6秒に延長

### コミット
- `5e7fb5f` fix: approverRoles未定義エラー
- `68da92a` fix: エラーバナー位置修正
- `02a0f6b` fix: CORS修正・成功バナー移動
- `943bca2` fix: Slack通知をfetch→invoke
- `b98be1d` fix: WebhookをSecretsに移動
- `ae208ee` fix: Slack通知フォーマット旧形式に戻す
- `4c9d96c` feat: 確認モーダル・カスタム日付ピッカー追加
- `34665f7` fix: カレンダー中央固定表示
- `200bb49` fix: ビルドエラー修正

### ✅ 2026-06-05 AdminPanel 6ファイル分割 完了

- Context API方式で全state/handlerを `admin/AdminPanelContext.tsx` に集約
- タブごとに6ファイル（ApprovalsTab / GroupsTab / UsersTab / TripReportsTab / ReportsTab / LeaveRequestsTab）
- AdminPanel.tsx は730行に削減（元3945行）
- ExpenseForm.tsx: 利用日ボタンのダークモード対応（background/color修正）

### ✅ 2026-06-05 交通費申請フォーム改善 完了（コミット: 43f98b0）

- 通勤区分に「その他」追加・交通機関セレクト化・勤務先スマートセレクト化
- 勤務先リスト・通勤区分ラベルを master_options で管理（管理画面から編集可能）
- 管理画面モーダルを全タブから開けるよう AdminPanel.tsx に移動
- モーダル構成を「交通費関連」「出張報告関連」に整理

### Supabase に追加したデータ（2026-06-05）
```sql
-- 勤務先リスト（category='workplace'）
INSERT INTO master_options (category, value, sort_order) VALUES
  ('workplace', '四条本校', 1), ('workplace', '西陣校', 2),
  ('workplace', '上桂校', 3), ('workplace', '洛西口校', 4), ('workplace', '南草津校', 5);
-- 通勤区分ラベル（category='expense_type_label'、sort_order 1〜4 固定）
INSERT INTO master_options (category, value, sort_order) VALUES
  ('expense_type_label', '通勤（単発）', 1), ('expense_type_label', '定期', 2),
  ('expense_type_label', '出張（園指導等）', 3), ('expense_type_label', 'その他', 4);
```

### ✅ 2026-06-05 バグ修正3件 完了（コミット: c31125f）

- **parseAmount強化**: 全角文字全般（￥・円・カンマ等）に対応 `/[！-～]/g`
- **totalAmount を useMemo 化**: リアルタイム計算に変更（旧サイトと同様）
- **往復ボタンに translate="no"**: ブラウザ自動翻訳で「対抗」になるバグを根本修正

### ✅ 2026-06-05 ファビコン・ホーム画面アイコン設定 完了（コミット: af74f4d）

- あいみんキャラクター画像をアイコンとして使用
  - 元画像: `\\NAS-SIJYO\Public\...\あいみん 名前入り元画像 - コピー.jpg`
  - PowerShellで4サイズに自動リサイズして配置
- 配置ファイル（`client/public/`）:
  - `favicon.ico`（32×32）→ ブラウザタブ
  - `icon-192.png`（192×192）→ Android ホーム画面
  - `icon-512.png`（512×512）→ Android スプラッシュ
  - `apple-touch-icon.png`（180×180）→ iPhone ホーム画面
  - `manifest.json` → PWA設定
- `index.html` 更新：favicon・apple-touch-icon・manifest・タイトル設定
- `manifest.json` 設定：
  - name: ファイブM スタッフサイト
  - short_name: ファイブM
  - display: standalone（ホーム画面から開くとアドレスバーなし）
- **ホーム画面への追加方法**:
  - Android: Chrome右上 `⋮` → 「ホーム画面に追加」
  - iPhone: Safari共有ボタン `□↑` → 「ホーム画面に追加」
  - 既存のPWAアイコンは一度アンインストールしてから再追加すること
- **注意**: サービスワーカー未設定のため自動インストールバナーは出ない（手動追加のみ）

### ✅ 2026-06-05 アカウント設定・UI改善 完了（コミット: 6f8cf51）

- アカウント設定ページ新規作成 `client/src/pages/AccountSettings.tsx`（`/account`）
  - 名前・メールアドレス表示
  - メールアドレス変更・パスワード変更へのリンク
- パスワード変更ページ新規作成 `client/src/pages/ChangePassword.tsx`（`/change-password`）
  - ログイン中に直接パスワード変更可能（`supabase.auth.updateUser`）
- ナビバーの名前タップ → `/account` へ移動（メール変更ボタンは削除）
- 交通費申請タイトルUI改善（🚃アイコン・ファイブMスタッフサイトサブタイトル）
- 休暇申請 注意事項4番：「ホーム画面」→「交通費申請ページ」に修正

### ✅ 2026-06-05 any型→型定義置き換え 完了（コミット: 96d951c）

- `types/index.ts` に `AdminUserProfile` / `AdminLeaveRequest` / `ReportStats` を追加
- `AdminPanelContext.tsx` の `useState<any[]>` をすべて型付きに置き換え
- ビルドエラー全修正・デプロイ済み

---

## ✅ 2026-06-06 交通費申請UI全面リニューアル 完了

### 変更内容

#### UIアーキテクチャ変更（カート型UI）
- **旧UI**: 複数行を同時編集する一覧フォーム
- **新UI**: 1件ずつ入力して「追加」→「追加済みリスト」に積み上げ→「申請する」

#### 主な機能
- **「＋ 追加」ボタン**: 入力フォームの1件を追加済みリストへ
- **「⇄ 往復で追加」ボタン**: 往路＋復路を同時に2件追加
- **「📋 よく使う経路」**: 直近50件の申請履歴から使用頻度順（上位5件）でフォームにセット
- **テンプレート適用（申請履歴）**: 1件ずつフォームにセットして日付入力→追加の流れ
  - キュー残り件数をバナー表示
- **バリデーション（必須項目）**: 交通機関・出発駅・帰着駅・金額・利用日
- **混在禁止**: 定期券と単発・出張を同一申請に混ぜるとエラー停止
- **定期日付チェック**: 終了日が開始日より前はエラー停止

#### CSS追加
- `.expense-card` / `.expense-line` / `.expense-line-indent`: カードレイアウト
- `.form-input-full`: 新フォーム用フル幅入力（max-width: none）

#### App.tsx変更
- `expenses` 初期値を `[]`（空）に変更
- `templateQueue` state追加
- `handleApplyTemplate` → `setTemplateQueue` に変更（直接リスト追加から1件ずつフォーム経由に）

### コミット
- `5987da7` feat: 交通費申請UIをカート型に全面リニューアル
- `62100bf` fix: 未使用変数を削除（ビルドエラー修正）
- `c3df6ba` feat: Slack通知に「申請を確認・承認」ボタン追加

### ✅ 2026-06-06 追加改善（同日）

#### よく使う経路
- 最大10件取得・デフォルト5件表示
- 「▼ もっと見る（あとN件）」ボタンで残り5件を展開/折りたたみ可能

#### 必須項目ハイライト（薄ピンク）
- よく使う経路・申請履歴テンプレート適用時 → 利用日がピンクに
- バリデーション失敗時 → 未入力の必須項目が全てピンクに
- 入力すると該当フィールドのピンクが消える
- ダークモード対応（暗い赤系）

#### クリアボタン
- 追加・往復で追加ボタンの横に「クリア」ボタン追加
- 押すと全入力フィールドリセット＋ハイライト消去＋エラー消去

#### バリデーション強化
- 定期券と単発・出張の混在を禁止（エラーで停止）
- 定期の終了日が開始日より前を禁止

### コミット
- `15c4a80` feat: よく使う経路改善・必須項目ハイライト・クリアボタン追加
- `2839a5e` docs: CLAUDE.mdコミットID修正

### ✅ 2026-06-06 バリデーション・表示改善

#### バリデーション
- 勤務先を必須項目に追加（未入力でピンクハイライト＋エラー）
- 定期の開始日・終了日がピンクハイライトされない不具合修正

#### よく使う経路
- デフォルト3件表示 → 「▼ もっと見る」で最大10件に変更

#### 確認モーダルのコンパクト化
- 1件を2行で表示（区分/交通機関/日付/勤務先 ＋ 経路 ＋ 金額）
- 10件超でも縦スクロールで見やすいサイズに

#### 「その他」表示の改善
- 交通機関で「その他」を選んで自由入力した場合 → 確認モーダル・追加済みリストに実際の入力内容を表示
- 勤務先で「その他」を選んで自由入力した場合 → 同様に実際の入力内容を表示
- 例：「その他」→「近江鉄道」「布引の森」など

#### 確認モーダルの表示構造
```
[番号] 区分  交通機関  日付  勤務先       ← 1行目（小文字）
       出発駅 → 帰着駅          ¥金額    ← 2行目（太字）
       備考: テキスト                    ← 3行目（備考ある時のみ）
```

### ✅ 2026-06-06 バグ修正

- **出張申請で「区分を選択してください」エラーが出る不具合修正**
  - 旧フォームにあった `trip_category`（出張区分：園指導・試合・下見など）の入力欄は新フォームで廃止済み
  - しかし「trip_categoryが空ならエラー」のバリデーションだけ残っていた
  - → 不要なチェックを削除して修正
  - コミット: `d14e50d`

### ✅ 2026-06-06 UX改善2件

- **追加済みリストに「複製」ボタン追加**
  - 押すと日付だけ空にして入力フォームにセット
  - 利用日がピンクハイライトされ、画面上部へ自動スクロール
  - 同じ経路を日付違いで何件も入れる時に便利

- **カレンダーのダークモード対応**
  - 月移動ボタン（‹ ›）と年月テキストが暗い背景で見えなかった不具合修正
  - `color: '#333'` を明示して修正
  - コミット: `329eefd`
  - 修正: 複製ボタン押下時にスクロールしないよう修正（ハイライト削除が原因）`502c9d9`

---

## ✅ 2026-06-06 よく使う経路・複製ボタン バグ修正 完了

### 修正した3つのバグ

#### バグ① よく使う経路・複製で「その他」交通機関が入らない
- **原因**: DBに保存されるとき「その他→近江鉄道」のように実際の値にマージして保存される。テンプレートとして読み込んだとき、`transportation = '近江鉄道'` のままセットされていた。テンプレートの2件目以降（templateQueue）は `toDraft()` 変換を通していなかったのが主因。
- **toDraft()とは**: DBの保存形式（マージ済み）をフォームの入力形式（「その他」+自由テキスト）に戻す変換関数。
- **修正**: `handleAddDraft` 内のtemplatueQueue処理に `toDraft()` を追加

#### バグ② 複製ボタンで「その他」交通機関・勤務先が入らない
- **原因**: 複製ボタンの処理が `toDraft()` を通していなかった
- **修正**: 複製ボタンのonClickに `toDraft()` を追加

#### バグ③ 複製ボタンで利用日がピンクハイライトされない
- **原因**: 以前のバグ修正でハイライト処理を削除していた（スクロールが起きるのを防ぐため）
- **修正**: `setTimeout(..., 0)` で1フレーム遅らせてハイライトをセットすることでスクロール問題を回避しつつハイライトを復活

#### バグ④ 区分「その他」（試合等）の勤務先が「その他」になる
- **原因**: `toDraft()` が「四条本校」等のプリセット外の値をすべて「その他+自由テキスト」に変換していた。しかし区分「その他」の場合、勤務先フォームは「その他」を使わない直接テキスト入力。
- **修正**: `toDraft()` に `item.type === 'other'` のとき変換をスキップする条件を追加

### 変更ファイル
- `client/src/components/ExpenseForm.tsx`

### ⚠️ 残存する懸念点（実運用上は問題なし）
- `business_trip`（出張）の勤務先プリセット（太秦保育園等）は `locationsByCategory` が読み込まれていないと誤判定される
  - **影響**: アプリ起動直後（約0.3秒以内）に「入力」ボタンを押した場合のみ発生
  - **実運用**: 人間が画面を見てボタンを押すまで最低1〜2秒かかるため、ほぼ発生しない
  - **対応が必要な場合**: データ取得完了までボタンをグレーアウト（`disabled`）にする対応で解決可能

### 🔜 次回やること
1. **Phase 1: メール送信機能**（現状は別ツール使用中のため後回し）

### 📅 運用スケジュール
- 確認期限：2026年6月13日（金）※幹部・マネージャーにテスト依頼済み
- 運用開始目標：2026年7月1日（火）
- 次回マネージャーMTGで出張報告・休暇申請の運用ルールを審議予定

---

---

## 🏗️ 新規ページ・機能の実装方針

### ファイル配置ルール

```
client/src/
├── components/
│   ├── XxxPage.tsx          ← 薄いオーケストレーター（~200行以内を目標）
│   └── xxx/                 ← タブ・セクションが複数ある場合はサブフォルダ
│       ├── XxxContext.tsx   ← 共有state + handler（Context API）
│       ├── XxxTabA.tsx      ← タブ/セクションごとのJSX
│       └── XxxTabB.tsx
├── hooks/
│   └── useXxx.ts            ← DBアクセス・非同期処理を切り出す
└── types/index.ts           ← 型定義はここに集約
```

### 実装の判断基準

| 状況 | 対応 |
|---|---|
| 500行以下のシンプルなページ | 1ファイルでOK |
| タブが複数ある | **最初からタブごとに分割**して作る |
| DBアクセスが多い | `useXxx.ts` フックに分離 |
| stateを複数タブで共有 | Context API（AdminPanelの方式） |
| any型の使用 | 型定義を先に `types/index.ts` に書く |

### 実装ステップ（メール送信など新機能のとき）

1. **型定義**を `types/index.ts` に追加（DB型 + コンポーネントprops型）
2. **DB操作フック**を `hooks/useXxx.ts` に作成（fetch + state）
3. **コンポーネント**を機能単位で1ファイル（1タブ = 1ファイル）
4. **状態共有**が必要になったらContextに昇格
5. **AdminPanel**に新タブを追加する場合は `admin/` に新ファイルを作り、`AdminPanelContext.tsx` にstateを追加

### Context APIの使い方（AdminPanelの方式）

```typescript
// 1. Context + Provider を作成（xxx/XxxContext.tsx）
export const useXxx = () => { const ctx = useContext(XxxContext); if (!ctx) throw ...; return ctx; };
export const XxxProvider: React.FC<{children}> = ({ children }) => {
  const [state, setState] = useState(...);
  return <XxxContext.Provider value={{ state, setState }}>{children}</XxxContext.Provider>;
};

// 2. ページコンポーネントでProviderでラップ
const XxxPage = () => <XxxProvider><XxxContent /></XxxProvider>;

// 3. 子コンポーネントでContextを使う（propsなし）
const XxxTabA = () => { const { state, setState } = useXxx(); return <div>...</div>; };
```

---

## 🗺️ 開発ロードマップ詳細

## Phase 3: 休暇・有給申請（優先①）

### 表示制御
- パート（一般）: 有給申請は通常非表示
- 正社員・リーダー・マネージャー・社長: 常時表示
- パートへの有給申請フォーム送信: 管理者/リーダー/マネージャーが特定パートを選んで送信 → そのパートのみ一時表示 → 申請完了で非表示に戻る

### 承認フロー
- 申請者 → リーダー → マネージャー → 経理（管理者） → 社長
- 申請が来たら承認者全員に表示
- 承認されたら申請者にメール通知
- 各ステップで承認/却下

## Phase 1: メール送信機能（優先②）
- 管理者から全員・グループ・個人にメール送信
- グループ: こども / パート・アルバイトスタッフ / マネージャー・リーダー / マネージャー専用 / 三役 / 大人 / 正社員・契約社員
- 送信履歴管理
- SMTP設定済み（office@five-m.com）

## Phase 4: 出張報告機能拡張（優先③）

### ① 位置情報 → 住所変換（無料API使用）
- GPS取得後に自動で住所を表示（Nominatim API）

### ② 終了報告時のSlack通知（チャンネル選択）
- 到着報告 → 通知なし
- 終了報告 → Slackに通知
- `#03晃平先生へ` → 常に自動送信（選択不要）
- 以下から複数選択可能：
  - 03森先生へ / 03大人へ / 04本校こどもへ
  - 05_2西陣校こどもへ / 05_3上桂校こどもへ
  - 05_4洛西口校こどもへ / 05_5南草津校こどもへ / 06ジュニアへ
- コメント欄追加

### ③ 実装タスク
1. 各チャンネルにSlack Webhookを追加（Slack側の設定）
2. BusinessTripReport.tsxにチャンネル選択UIを追加
3. Supabase Edge Functionに複数チャンネル送信機能を追加
4. 住所変換API（Nominatim/無料）を実装

---

## ✅ 2026-05-31 出張報告機能実装完了

### 実装内容
- **出張報告フォーム** (`client/src/components/BusinessTripReport.tsx`)
  - 報告種別（到着/終了）
  - 区分（出張/園指導/試合/下見/その他）
  - 場所・備考入力
  - GPS位置情報取得
  - 送信確認モーダル
- **ナビゲーションバー** (App.tsx) - 申請・出張報告の切り替え
- **管理者画面に出張報告タブ追加** (AdminPanel.tsx)
  - 全スタッフの報告一覧
  - Googleマップリンク表示

### データベース
- テーブル: `business_trip_reports`
- RLSポリシー: ユーザーは自分のデータのみ、管理者は全件閲覧可
- `profiles`テーブルとの外部キー設定済み

### その他変更
- ログイン画面タイトル: 「ファイブM 交通費精算」→「ファイブM スタッフサイト」
- ナビゲーション: 「🏠 申請」→「🏠 交通費申請」

### 次回実装予定
- GPS位置情報を住所に変換して管理画面に表示（Nominatim API使用・無料）
- Slack通知（終了報告時のみ）
- CSV出力機能

---

## Project Overview

Expense management application built with React/TypeScript frontend and Supabase backend.

## Development Setup

Working directory: `/mnt/c/Users/kohei/expense-app`

## Commands

**Deployment workflow:**
- `git add .` → `git commit -m "message"` → `git push`
- Vercel: Auto-deploys from GitHub (no manual action needed)
- Supabase Edge Functions: Manual deploy via dashboard when needed

## Architecture

- Frontend: React + TypeScript + Vite
- Backend: Supabase (database, auth, Edge Functions)
- Deployment: Vercel (frontend), Supabase (backend functions)
- Repository: GitHub integration with auto-deploy

## Notes

- Always use git workflow for deployments
- Vercel automatically deploys on git push
- Edge Functions require manual deployment in Supabase dashboard
- Project configured with proper TypeScript types and CORS handling

## Next Session TODO (明日の実装予定)

### ✅ 印刷機能完了 - 伝票番号・表示改善 (2025-08-01)
**実装完了内容**:
- ✅ 時刻ベース伝票番号: `#20250801-1430-01` (日付-時分-連番)
- ✅ ヘッダー表示: `[交通費請求明細書] #20250801-1430-01 【1/2】`
- ✅ 印刷日表示削除: シンプル化
- ✅ ローカルストレージ依存廃止: ブラウザ固有問題解決
- ✅ 中央寄せ角括弧形式: 視認性向上
- ✅ 印刷専用ウィンドウ使用: 余分ページ問題解決済み

### 🎯 その他優先実装
1. **ページ読み込み時の通知チェック** ✅完了
2. **却下理由付きのPOPアップ表示** ✅完了  
3. **メール通知は実装しない**

### 🚀 正しいデプロイ指示
```
「既存のfive-m-expense-appプロジェクトを更新して、
five-m-expense.vercel.appにデプロイして。
新しいプロジェクトは作らないで。」
```

### 📂 重要な設定
- **Root Directory**: `client` (Vercel設定済み)
- **vercel.json**: `/client/vercel.json` (正しい位置)
- **作業ディレクトリ**: `/mnt/c/Users/kohei/expense-app`
- **メインURL**: https://fivem-portal.vercel.app

### ✅ 現在完了済み
- 却下理由の表示機能 ✅
- 管理者パネルでの却下処理 ✅
- SPAルーティング修正 ✅
- 全体的なUI改善 ✅
- 404エラー解決 ✅
- **印刷機能の基本実装** ✅
  - 印刷選択UI
  - A4プレビューモーダル
  - 印刷履歴データベース更新
  - 伝票レイアウト（2伝票/ページ、10行/伝票）
- **ステータス色分け表示** ✅ (2025-07-26完了)
  - 申請中: 黒色
  - 承認: 青色・太字
  - 却下: 赤色・太字
  - 全画面（申請者履歴・管理者画面）に適用
- **交通費申請UI改善** ✅ (2025-08-01完了)
  - 項目名変更: 「通勤（単発）」「定期」「出張（園指導等）」
  - 勤務先入力欄追加（金額の後ろ、全角6文字程度、必須項目）
  - 申請履歴・管理者画面で勤務先表示
  - CSV出力・印刷出力に勤務先情報追加
  - データベース: rejected_reasonカラム追加済み
  - ログアウト機能修正（セッション管理改善）
- **月別申請状況表示機能** ✅ (2025-10-04完了)
  - 一般ユーザー専用の月別申請状況コンポーネント
  - 種別別表示（定期・通勤（単発）・出張（園指導等））
  - 前月・次月ボタンで月移動機能
  - **利用日ベースでのカウント**：単発・出張は実際の利用日（start_date）、定期は申請日
  - **日数・件数の両方表示**：例「4日・8件」
  - **同日複数申請対応**：例「10/5(木)×2」で往復申請を正確に表示
  - 申請漏れ防止のための視覚的確認機能
  - ダークモード対応（テキスト色明示的指定）

### 📋 印刷機能詳細
**現在の状態**:
- プレビュー: 完全動作（A4サイズ、正確な伝票表示）
- 印刷データ生成: 正常（デバッグログで確認済み）
- **問題**: 実際の印刷で余分なページが出力される

**技術仕様**:
- CSS Grid: 2列レイアウト（1fr 1fr）
- 伝票サイズ: 87mm × 110mm
- ページサイズ: A4 (210mm × 297mm)
- 印刷時CSS: @media print + page-break制御

## ✅ 2025-10-04 編集履歴機能実装完了

### 🎯 実装した機能
**編集履歴機能** - 管理者が申請内容を編集した履歴を記録・表示

#### **1. データベース設計** ✅
```sql
-- 編集履歴用カラム追加（安全な設計）
ALTER TABLE expenses ADD COLUMN last_edited_at timestamp;
ALTER TABLE expenses ADD COLUMN last_edited_by text;  -- 外部キー制約なしで安全
ALTER TABLE expenses ADD COLUMN edit_count integer DEFAULT 0;
```

#### **2. 編集保存機能の拡張** ✅
- `AdminPanel.tsx`の`handleSaveEdit`関数を修正
- 編集時に履歴情報を自動更新：
  - `last_edited_at`: 編集日時（UTC）
  - `last_edited_by`: '管理者'
  - `edit_count`: 編集回数（累積）

#### **3. 編集済みバッジ表示** ✅
- **黄色バッジ**: `編集済み (X回)` 
- **詳細情報**: `最終編集: 日時 (編集者)`
- **表示場所**: 承認待ち一覧 + 全申請履歴
- **日本時間表示**: UTC+9時間で正確な時刻表示

#### **4. TypeScript型定義** ✅
```typescript
export interface Submission {
  // ... 既存フィールド
  last_edited_at?: string | null;
  last_edited_by?: string | null;
  edit_count?: number;
}
```

### 🚀 技術的実装詳細
- **安全性**: 外部キー制約なしでPostgREST問題を回避
- **時刻変換**: 手動UTC+9計算で確実な日本時間表示
- **型安全性**: null/undefinedチェックでTypeScript厳密モード対応
- **表示条件**: `((edit_count && edit_count > 0) || last_edited_at)`

### 🎨 UI/UX設計
- **視認性**: 黄色バッジ（#ffc107）で編集済みを強調
- **情報量**: 編集回数 + 最終編集日時 + 編集者名
- **一貫性**: 承認待ち・全申請履歴で統一表示

### 📋 実装順序と問題解決
1. **データベース構造設計** → 安全なカラム追加
2. **保存機能実装** → 編集時の履歴更新
3. **表示機能実装** → バッジと詳細情報表示
4. **表示問題解決** → useExpensesクエリ条件修正
5. **時刻表示修正** → 日本時間への確実な変換
6. **TypeScript対応** → 型定義追加とnull安全性

### 🔧 トラブルシューティング履歴
- **PostgREST関係エラー**: 外部キー制約回避で解決
- **表示されない問題**: 条件式修正で解決  
- **時刻表示問題**: 手動UTC+9変換で解決
- **TypeScriptエラー**: 型定義追加とnull checkで解決

### 📂 変更ファイル
- `supabase/migrations/`: 編集履歴カラム追加
- `client/src/types/index.ts`: Submission型にedit履歴フィールド追加
- `client/src/components/AdminPanel.tsx`: 編集保存・表示機能実装
- `client/src/hooks/useExpenses.ts`: データ取得対応

## ✅ 2025-10-04 Slack通知改善完了

### 🎯 実装した機能
**定期申請の視認性向上** - Slack通知で定期申請を⭐で強調表示

#### **実装内容** ✅
- **Slack通知での表示変更**:
  - Before: `申請内容: 定期、単発`
  - After: `申請内容: ⭐定期⭐、単発`

#### **修正箇所** ✅
- `supabase/functions/slack-notify/index.ts`
- 12行目：`"定期"` → `"⭐定期⭐"`に変更

#### **解決した問題** ✅
- **課題**: 定期申請がSlack通知で見逃されやすい
- **解決**: ⭐絵文字で視覚的に強調、一目で識別可能

#### **技術的詳細** ✅
- **修正方法**: Supabaseダッシュボードで直接コード編集
- **デプロイ**: Edge Functions手動デプロイが必要
- **Git管理**: ローカルコードも同期して変更記録

### 🔧 トラブルシューティング履歴
- **初回デプロイ後に⭐が表示されない**: 実際のデプロイ済みコードが古いバージョンだった
- **解決方法**: Supabaseダッシュボードで実際のコードを確認・修正
- **学習**: Edge Functionsは手動デプロイ＋コード編集が必要

### 🎨 改善効果
- **視認性**: 定期申請が⭐で即座に識別可能
- **業務効率**: 重要な定期申請の見逃し防止
- **UI一貫性**: 絵文字による直感的な情報伝達

## ✅ 2025-08-02 作業完了

### 🎯 完了した機能実装
1. **申請種別セレクトボックス幅調整** ✅
   - 「出張（園指導等）」の文字切れを修正
   - `.single-select` CSS追加（min-width: 160px, max-width: 180px）

2. **申請フォーム説明文追加** ✅
   - 「申請履歴をテンプレートとして使用できます。」を追加
   - 改行付きで分かりやすく表示

3. **管理者画面フィルター機能実装** ✅
   - **申請種別フィルター**: 通勤（単発）、定期、出張（園指導等）、すべて
   - **ステータスフィルター**: 申請中、承認済み、却下、すべて
   - 承認待ち一覧・全申請履歴の両方に対応
   - リアルタイム絞り込み、軽量処理（フロントエンド配列フィルタリング）
   - 全選択・印刷機能もフィルター対応

4. **印刷プレビューと実際印刷の表示統一** ✅
   - App.cssに印刷プレビュー用CSS追加
   - 実際の印刷ウィンドウと完全一致する表示
   - 70%スケールでA4サイズを画面表示

5. **印刷処理の改善** ✅
   - 印刷キャンセル時に印刷済みマークが付かない仕様
   - 印刷キャンセル時に印刷ウィンドウを自動クローズ（4秒後）
   - `onafterprint`と`onbeforeunload`イベント活用

6. **承認・却下ボタンのUI改善** ✅
   - 承認ボタン: 緑色背景 + 濃い緑枠線（2px solid）
   - 却下ボタン: 赤色背景 + 濃い赤枠線（2px solid）
   - パディング、太字フォント、角丸で視認性向上

### 🚀 技術的実装詳細
- **フィルタリング**: `useCallback`と`useMemo`でパフォーマンス最適化
- **印刷制御**: `printWindow.onafterprint`で実際の印刷完了を検知
- **UI統一**: 印刷プレビューCSS（App.css）で実際印刷と完全一致
- **エラーハンドリング**: 印刷ウィンドウのtry-catch処理で安全性確保

## ✅ 2025-12-08 管理者画面ダークモード対応完了

### 🎯 実装した機能
**スマホのダークモードで管理者画面の文字が見えない問題を修正**

#### **1. ダークモード検出機能** ✅
```javascript
const isDarkMode = window.matchMedia('(prefers-color-scheme: dark)').matches;
```

#### **2. タブナビゲーション** ✅
- 非アクティブタブの背景色: `#495057` (ダークモード) / `#f8f9fa` (ライトモード)
- 文字色: `#fff` (ダークモード) / `#333` (ライトモード)
- 境界線色も動的に変更

#### **3. タブコンテンツ** ✅
- 背景色: `#343a40` (ダークモード) / `white` (ライトモード)
- 明示的な文字色指定: `#fff` / `#000`

#### **4. モーダル（却下理由入力）** ✅
- モーダル背景: ダークモード対応
- テキストエリア: 背景色・文字色・境界線を修正

#### **5. フィルター機能** ✅
- ラベルの文字色を明示的に指定
- セレクトボックス: 背景色・文字色・境界線を修正
- 申請種別・ステータスフィルター両方に対応

#### **6. CSV出力セクション** ✅
- 日付入力フィールド: 背景色・文字色・境界線を修正
- ラベルの文字色を明示的に指定

#### **7. 全見出し要素** ✅
- h2, h3, h4, pタグすべてに色指定を追加
- 「管理画面」「承認管理」「ユーザー管理」「レポート・分析」など

#### **8. テーブル完全対応** ✅
**ユーザー管理タブ:**
- テーブルヘッダー: 背景色・境界線・文字色
- テーブルボディ: 奇数偶数行の背景色切り替え
- 入力フィールド: 名前編集用inputのダークモード対応
- メールアドレス表示: smallタグの色調整

**レポート・分析タブ:**
- ユーザー別統計テーブル: 完全ダークモード対応
- 月次レポートテーブル: 完全ダークモード対応
- 色付き数値（承認・申請中・却下）: ダークモードで視認性の高い色に変更

#### **9. 統計カード** ✅
- ダッシュボードの5つのカード（総申請数・申請中・承認済み・却下・承認率）
- 背景色をダークモード用に調整（暗めの色相）
- 見出しと数値の色を調整

### 📋 修正ファイル
- `client/src/components/AdminPanel.tsx`: 管理者画面全体のダークモード対応

### 🎨 カラーパレット
**ダークモード:**
- 背景: `#343a40`, `#495057`
- 文字: `#fff`, `#adb5bd`
- 境界線: `#6c757d`
- 統計カード背景: `#1a3a52`, `#4a3800`, `#1b4d1b`, `#5a1a1a`, `#4a1a5a`

**ライトモード:**
- 背景: `white`, `#f8f9fa`
- 文字: `#000`, `#333`, `#6c757d`
- 境界線: `#dee2e6`, `#ccc`

### 🚀 デプロイ
- コミットID: `bb17130`
- デプロイ先: https://fivem-portal.vercel.app/
- 自動デプロイ: Vercel（1〜2分で反映）

## ✅ 2025-12-08 二重送信防止機能実装完了

### 🎯 実装した機能
**申請フォームの二重送信防止** - 送信ボタンの連続クリックによる重複申請を防止

#### **実装内容** ✅
1. **送信中フラグ管理**
   - `isSubmitting` stateを追加
   - 送信中はボタンを無効化（disabled）

2. **視覚的フィードバック**
   - ボタンテキスト: 「申請する」→「送信中...」
   - 背景色: 青色（#007bff）→グレー（#6c757d）
   - 透明度: 60%に変更
   - カーソル: not-allowed

3. **送信完了後の制限**
   - 送信成功後、3秒間はボタンを押せない
   - `setTimeout`で3秒後に自動的にボタン復活

4. **エラー時の対応**
   - バリデーションエラー: 即座にボタン復活
   - データベースエラー: 即座にボタン復活

### 📋 修正ファイル
- `client/src/components/ExpenseForm.tsx`: 二重送信防止機能追加

### 🚀 デプロイ
- コミットID: `ba44a25`
- デプロイ先: https://fivem-portal.vercel.app/
- 自動デプロイ: Vercel（1〜2分で反映）

## 🔜 次回実装予定: 出張報告機能

### 📋 機能概要
**出張・園指導等の到着/終了報告機能** - GPS位置情報付きで報告を記録・管理

### 1. **UI/ナビゲーション**
- ナビゲーションに「📍出張報告」を追加
- 一般ユーザーのみアクセス可能（管理者は閲覧のみ）

### 2. **入力フォーム仕様**
```
┌─────────────────────────────┐
│  📍 出張報告                 │
├─────────────────────────────┤
│ 報告種別: ○ 到着  ○ 終了    │
│                             │
│ 区分: [選択 ▼]              │
│  - 出張                     │
│  - 園指導                   │
│  - 試合                     │
│  - 下見                     │
│  - その他 (→自由記載欄表示) │
│                             │
│ 場所: [____________]        │
│      （出張先・園名など）    │
│                             │
│ 備考: [____________]        │
│       [            ]        │
│                             │
│ GPS: 未取得                 │
│ [📍 現在地を取得]           │
│                             │
│ [送信] ※確認画面あり        │
└─────────────────────────────┘
```

**重要な仕様:**
- 自分の出張申請を選択する形式ではなく、**都度入力する**
- 送信前に**確認画面を表示**
- 区分で「その他」を選択時は自由記載欄を表示

### 3. **GPS位置情報取得**
- **技術**: Geolocation API（無料、ブラウザ標準）
- **取得データ**: 緯度、経度、精度
- **マップリンク**: `https://www.google.com/maps?q={latitude},{longitude}`

```javascript
navigator.geolocation.getCurrentPosition(
  (position) => {
    const lat = position.coords.latitude;
    const lng = position.coords.longitude;
    const accuracy = position.coords.accuracy;
  }
);
```

### 4. **Slack通知**
- **通知タイミング**: 終了報告時のみ
- **通知内容**:
  - 報告者名
  - 区分（出張/園指導/試合/下見/その他）
  - 場所
  - 備考
  - GPS座標
  - Googleマップリンク

**通知例:**
```
📍 出張終了報告

👤 報告者: 山田太郎
📋 区分: 園指導
📍 場所: 〇〇保育園
💬 備考: 無事に終了しました
🗺️ 位置情報: https://www.google.com/maps?q=35.6812,139.7671
```

### 5. **管理者画面**
- **新規タブ**: 「📍出張報告」を追加
- **表示内容**:
  - 報告種別（到着/終了）
  - 区分
  - 場所
  - 報告日時
  - 報告者名
  - GPS位置情報（Googleマップリンク）
  - 備考
- **機能**:
  - 一覧表示（最新順）
  - CSV出力
  - Googleマップリンクで位置確認

### 6. **データベース設計**
テーブル名: `business_trip_reports`

```sql
CREATE TABLE business_trip_reports (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  report_type TEXT NOT NULL,        -- '到着' or '終了'
  category TEXT NOT NULL,            -- '出張', '園指導', '試合', '下見', 'その他'
  category_other TEXT,               -- 区分が「その他」の場合の自由記載
  location TEXT NOT NULL,            -- 場所
  notes TEXT,                        -- 備考
  latitude NUMERIC(10, 8),           -- 緯度
  longitude NUMERIC(11, 8),          -- 経度
  accuracy NUMERIC,                  -- GPS精度（メートル）
  created_at TIMESTAMP DEFAULT NOW()
);

-- インデックス
CREATE INDEX idx_business_trip_reports_user_id ON business_trip_reports(user_id);
CREATE INDEX idx_business_trip_reports_created_at ON business_trip_reports(created_at DESC);
```

### 7. **実装タスク（次回セッション用）**
1. データベーステーブル作成
2. TypeScript型定義追加
3. 出張報告フォームコンポーネント作成
4. GPS取得機能実装
5. 確認画面モーダル作成
6. Slack通知Edge Function作成（終了報告時のみ）
7. 管理者画面に出張報告タブ追加
8. CSV出力機能追加
9. ナビゲーションメニューに追加

### 8. **技術スタック**
- **フロントエンド**: React + TypeScript
- **GPS**: Geolocation API（ブラウザ標準、無料）
- **バックエンド**: Supabase（データベース + Edge Functions）
- **通知**: Slack Webhook（終了報告時のみ）

### 9. **注意事項**
- スプレッドシート連携は不要
- GPS取得はHTTPS環境が必須（本番環境のみ動作）
- 位置情報の許可をユーザーに求める必要あり
- Slack通知はEdge Functionで実装（手動デプロイ必要）
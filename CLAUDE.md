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
- **実装完了時・セッション終了前に必ず `git status` で未コミットがないか確認すること**
  - 未コミットがあればユーザーに伝えてからpushする

### 🔥 本番だけ動かないとき（トラブル時に確認）
- `.env` と `.env.production` の `VITE_SUPABASE_URL` が一致しているか確認
  - 正しい値: `https://xaeynaxctiiyqxjyuzfi.supabase.co`
  - ローカルは `.env`、本番ビルド（Vercel）は `.env.production` が優先される
- Edge Function が 403 → Supabase Legacy Anon Key（`eyJ...`）を使っているか確認
- Supabase CLI が「Cannot find project ref」→ `supabase link --project-ref xaeynaxctiiyqxjyuzfi`

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

### 優先度高(実害あり) → 対応済み(2026-06-06)
1. ✅ `LeaveRequest.tsx`: `loadingAssignments` stateを追加し、「読み込み中」と
   「担当者情報が登録されていません」を区別して表示するよう修正。
2. ✅ `LeaderAssignmentsTab.tsx`: `isProcessing` stateを追加し、`saveEdit`/
   `handleDelete`実行中はボタンをdisabled化（「保存中...」「処理中...」表示）して
   二重クリックによる重複登録・削除を防止。

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

### 🔜 次回やること（2026-06-12時点）

#### 優先①: バックフィル実行（Googleカレンダーの過去データ同期）
```
# 既存の欠勤データを一括同期（client/フォルダから）
node backfill-gcal-absence.mjs <SERVICE_ROLE_KEY>
```
- backfill-gcal.mjs（休暇）・backfill-gcal-absence.mjs（欠勤）を実行後は削除してOK

#### 優先②: 西村さんの色問題修正
- gcal_eventsテーブルから西村さんのleaveレコードを削除
- GoogleカレンダーのイベントをUI上で手動削除
- backfill-gcal.mjs を再実行して色を統一（colorId='4'ピンクに）

#### 優先③: Phase 5（任意）
- gcal-sync失敗時リトライキュー
- 管理画面でカレンダー同期ステータス表示

#### その他
- backfill用スクリプト（client/backfill-gcal.mjs・client/backfill-gcal-absence.mjs）は使用後に削除
- UI/UX改善（コードレビュー結果・高優先項目）

---

## ✅ 2026-06-11 UI改善・通知機能強化 完了

### 変更内容

#### 欠勤入力UI改善（CalendarPage.tsx）
- 遅刻アイコン 🟡→🟠、早退アイコン 🟠→🔵（凡例と色を統一）
- 時間入力をチェックボックス行の下段に展開表示（スマホ見切れ解消）

#### 出張報告 送信後UX修正（BusinessTripReport.tsx）
- 送信後に `gpsAttempted` / `gpsUnavailable` をリセット（チェックボックスが残るバグ修正）
- 送信成功バナーをページ最上部に移動＋自動スクロール（`scrollIntoView`）

#### 休暇申請 管理者修正履歴（LeaveRequestsTab.tsx / AdminPanelContext.tsx / types/index.ts）
- Supabase: `leave_requests` に `modified_by`（uuid）・`modified_at`（timestamptz）カラム追加
- 管理者が「変更して受理」時に修正者・日時を保存
- 一覧に「▶ 修正」ボタン追加→クリックで修正者・日時・変更内容を1行展開

#### 通知機能強化（App.tsx）
- バナー通知: 5秒後に自動フェードアウト＋✕手動消し
- ベルドロップダウン: 各通知に✕ボタン追加（個別既読・非表示）
- 時刻表示: `timeZone: 'Asia/Tokyo'` 明示（二重JST変換バグ修正）
- Supabase pg_cron: 毎日午前3時に既読30日以上の通知を自動削除

---

## ✅ 2026-06-12 Googleカレンダー連携・欠勤登録UX改善 完了

### 変更内容

#### LeaveRequestsTab.tsx（管理者画面）
- 休暇申請の「取り消し」ボタンでgcal-sync deleteを呼び出し、Googleカレンダーからイベントを削除

#### CalendarPage.tsx（休暇カレンダー）
- 欠勤登録「確定する」押下後：ボタンが「登録中...」表示になり連打を防止
- DB保存・gcal-sync完了後にシートを閉じ「登録しました」バナーを即時表示
- 欠勤「取消」ボタン：DB削除後にgcal-sync deleteを呼び出しGoogleカレンダーからも削除
- 欠勤削除後に「削除しました」バナーを表示（薄ピンク `#fce8ed`・中央オーバーレイ）
- 「登録しました」バナー：薄緑(`#d4edda`)・中央モーダル型・✅大アイコン

#### gcal-sync Edge Function
- colorId '11'(Tomato赤) → '4'(Flamingo ピンク)に変更（全LEAVE_CONFIGエントリ）
- デプロイ済み: `npx supabase functions deploy gcal-sync`

#### backfill-gcal-absence.mjs（新規）
- 既存の`attendance_exceptions`を一括でGoogleカレンダーに同期するスクリプト
- 使い方: `node backfill-gcal-absence.mjs <SERVICE_ROLE_KEY>` (client/フォルダから実行)

### ⚠️ Googleカレンダーの色に関する重要な仕様メモ
- **過去日付のイベントは自動的に薄く表示される**（Googleカレンダーの仕様）
- colorIdの設定値とは無関係
- 「色がおかしい」報告があったら、まず対象日が過去かどうかを確認すること
- 過去日付なら仕様通りであり、colorId変更やバックフィルは不要（2026-06-12 確認）

### gcal_events テーブル
- `source_type`: 'leave' または 'absence'
- `source_id`: leave_requests.id または attendance_exceptions.id
- upsert時: 既存eventを削除→再作成（colorId反映のため）

### カレンダーイベントの色設定
| 種別 | colorId | 色名 |
|---|---|---|
| 有給・慶弔・調整休・その他 | '4' | Flamingo（ピンク） |
| 遅刻・遅出(調整)・早退 | '2' | Sage（緑） |
| 全欠勤 | '4' | Flamingo（ピンク） |

### コミット: `bddd62c`

---

## ✅ 2026-06-13 時間調整（自己登録）機能 実装完了

### 機能概要
一般社員が自分で「調整遅出（late_start）」「調整早退（early_end）」を申請なし・承認フローなしで直接登録できる機能。

### 変更ファイル

#### `client/src/components/LeaveRequest.tsx`
- タブ追加: 🌿 休暇 ┃ 🕐 時間調整 ┃ 📋 申請履歴（3タブ構成）
- 時間調整フォーム（adjustmentタブ）:
  - 自己登録説明ボックス（承認フロー不要・即時記録の旨を明示）
  - 注意事項バー（事前にフロア責任者・リーダー・マネージャーへ了承を得ること）
  - タイプ選択: 調整遅出（緑●）/ 調整早退（紫●）チェックボックス（各種別で時間入力が展開）
  - 時間入力: 時/分のセレクト（未選択時は赤枠・placeholder表示）
  - 日付カレンダー: 当日以降のみ選択可（過去日は無効・グレー表示）
  - 了承者フィールド: リーダー/マネージャーからの選択 または 自由記入（任意）
  - 理由テキストエリア（必須・文例ボタン付き）
- バリデーション（全て必須）:
  - 種別1つ以上チェック必須
  - 日付は当日以降のみ（過去日不可）
  - 時間は各種別で必須（デフォルト値なし、必ず選択）
  - 両種別チェック時: 遅出時刻 < 早退時刻
  - 理由は空白不可
- 送信後: attendance_exceptions にINSERT → gcal-sync → time-adjustment-notify で通知
- 申請履歴タブにサブタブ追加: 🌿 休暇申請 ┃ 🕐 時間調整
  - 時間調整履歴: 年度フィルター + 月グループ表示
  - 休暇申請履歴: 有給取得状況（承認中/受理/合計日数）を年度選択下に追加

#### `supabase/migrations/20260613000000_time_adjustment_self_register.sql`（新規）
```sql
-- 一般社員が自分の late_start/early_end を自己登録できるRLS
CREATE POLICY "Users can insert own time adjustments"
  ON attendance_exceptions FOR INSERT
  WITH CHECK (
    user_id = auth.uid()
    AND created_by = auth.uid()
    AND type IN ('late_start', 'early_end')
    AND date >= current_date
  );

-- 同日・同種別の重複登録防止
ALTER TABLE attendance_exceptions
  ADD CONSTRAINT uq_attendance_exceptions_user_date_type
  UNIQUE (user_id, date, type);
```

#### `supabase/functions/time-adjustment-notify/index.ts`（新規）
- 時間調整登録時に同グループのリーダー・マネージャーへサイト内通知
- profiles.group_names で同グループを検索 → 未設定の場合は全マネージャーにフォールバック
- Service Role Key でRLSをバイパスしてnotificationsテーブルにINSERT

### ⚠️ Supabase への手動適用が必要（未適用）

#### 1. マイグレーション適用
Supabase ダッシュボード SQL Editor で実行:
https://supabase.com/dashboard/project/xaeynaxctiiyqxjyuzfi/sql
→ `supabase/migrations/20260613000000_time_adjustment_self_register.sql` の内容をコピペ実行

#### 2. Edge Function デプロイ
```
cd C:\Users\kohei\fivem-portal
npx supabase functions deploy time-adjustment-notify --project-ref xaeynaxctiiyqxjyuzfi
```

### 🔜 次回やること（2026-06-13時点）

#### ✅ 完了済み（2026-06-13）
- バックフィル（backfill-gcal.mjs・backfill-gcal-absence.mjs）実行済み
- 通知設定画面（NotificationsTab）に「🕐 時間調整」グループ追加（Slack複数チャンネル・メール・サイト通知・役職＋グループフィルター・テンプレート編集）
- time-adjustment-notify Edge Function 実装・デプロイ済み
- 全バナー・モーダルのデザイン統一（下記参照）
- 通知設定 複数宛先対応（下記参照）
- **有給奨励日機能 全面実装（下記参照）**

#### 優先①: その他
- UI/UX改善（コードレビュー結果・高優先項目）
- gcal-sync 失敗時リトライキュー（低優先）

---

## ✅ 2026-06-14 社内連絡板・フィードバック統一・UX改善 完了

### 社内連絡板（BoardPage.tsx）新規実装
- LINE風チャットUI（チャンネルリスト左・メッセージ右・モバイル切り替え）
- グループ / 個人DM チャンネル
- スレッド（リプライ）・既読数表示・未読バッジ
- メッセージ編集・削除
- グループ作成モーダル（有給奨励日スタイル: 雇用形態ヘッダー+役職列+一括選択）
- メンバー管理モーダル（同スタイル: チェックボックス一括編集+保存）
- DB: board_channels / board_channel_members / board_messages / board_channel_last_seen / board_reads（RLS付き）
- グループはprofiles.group_namesから一括作成（SQL済み）

### バグ修正
- board_messages / board_channel_members のprofilesジョイン（FK→auth.usersのため失敗）を削除
  → 名前はallProfiles stateからclient-sideでlookup
- DM チャンネル名もallProfilesから取得するよう修正

### 全ページ フィードバック統一（成功時は緑カード・alert廃止）
- AdminPanelContext: successMsg state追加・success alert を9箇所 setSuccessMsg() に置き換え
- AdminPanel.tsx: 管理画面全体に共通バナー表示
- LeaveApprovals.tsx: パート送信後バナー追加
- LeaderAssignmentsTab: 保存・追加・削除後バナー
- LeaveRequestsTab: メール送信・パート有給フォーム送信後バナー
- BoardPage: メッセージ編集保存後バナー

### UX改善
- NavBar: 現在地と同じボタンを押すと先頭スクロール（全ボタン共通）

### CLAUDE.md
- UIフィードバック標準仕様を追記（成功系は緑カード必須・alert禁止・コードテンプレート付き）

### 🔜 次回タスク
- 残業申請フォーム（パート用）← 次タスク①
- タブ・機能の表示権限管理画面 ← 次タスク②
- UI/UX改善（コードレビュー結果・高優先項目）
- gcal-sync 失敗時リトライキュー（低優先）

---

## ✅ 2026-06-14 BoardPage UI改善・未読通知 完了

### 変更内容

#### メンバー選択モーダル改善（BoardPage.tsx）
- 選択中メンバーをチップ形式でタイトル直下に表示（選択ゼロ時は非表示）
  - 自分は緑チップ（削除不可）、他メンバーはチップの ✕ ボタンで外せる
- ボタン順序を「キャンセル（左）・保存/作成（右）」に統一（Web標準に合わせた）
  - 対象: グループ作成モーダル・メンバー編集モーダルの計2箇所

#### 既読状況ポップアップ（管理者のみ）
- 管理者には「既読 〇」が下線付きボタンとして表示される
- タップすると `board_reads` を取得し、既読者・未読者を名前一覧で表示
  - 緑: ✓ 既読（〇人）
  - 赤: … 未読（〇人）
- 背景タップまたは ✕ で閉じる

#### NavBar 連絡板ボタンに未読バッジ（App.tsx）
- `useBoardUnread` フック追加（board_channel_members → board_messages → board_reads を結合して未読数算出）
- NavBar の「💬 連絡板」ボタン右上に赤バッジ表示
- `/board` を開いている間はバッジ非表示
- 30秒ごとに自動更新

#### ホーム画面 未読トースト（App.tsx）
- ホームを開いたとき未読があれば画面中央に緑カード（既存デザイン統一）を表示
- 5秒で自動消え
- タップすると `/board` へ移動
- ✕ で手動消し

### ⚠️ 注意事項
- `useBoardUnread` は NavBar と Dashboard の両方で呼んでいるが、それぞれ独立したポーリング（二重クエリ）
  - 将来的に Context 化して共有することも可能だが、現状は件数が少ないため問題なし
- NavBar のバッジは `location.pathname !== '/board'` の条件で `/board` 表示中は非表示にしている

### ✅ 2026-06-14 追加変更
- **boardToast の位置変更**: 画面中央ポップアップ → NavBar直下の上部バナー（`position: fixed, top: 56`）
- **連絡板ヘッダーに🔔ボタン追加**: タップでアカウント設定（通知設定）画面に遷移

### 🔜 次回タスク（2026-06-14時点）
- 残業申請フォーム（パート用）← 最優先
- 忘れん坊通知①②③（send-push Edge Function は完成済み・呼び出し側を実装）
- タブ・機能の表示権限管理画面
- UI/UX改善（コードレビュー高優先項目）

---

## ✅ 2026-06-13 有給奨励日機能 実装完了

### 機能概要
管理者が「有給奨励日」を作成し、対象スタッフに回答を求める機能。
承認フローなし・回答のみ。choice=有給休暇のときleave_requestsに自動挿入（受理済み）。

### DBテーブル（Supabase SQLで作成済み）

```sql
-- 奨励日マスター
paid_leave_encouragement_days (id, target_date, deadline, fiscal_year, created_by, created_at)

-- 対象者
paid_leave_encouragement_targets (id, encouragement_day_id, user_id, created_at)

-- 回答
paid_leave_encouragement_responses (id, encouragement_day_id, user_id, choice, note, responded_at, created_at)
-- choice: 1=有給休暇, 2=欠勤（調整休）, 3=定休日, 4=その他
```

### RLS（追加済み）
```sql
-- 管理者がleave_requestsを代理挿入できるポリシー
CREATE POLICY "admin_insert_leave_requests" ON leave_requests FOR INSERT TO authenticated
WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE profiles.id = auth.uid() AND profiles.role_title IN ('管理者', '社長')));
```

### Edge Function
- `supabase/functions/encouragement-notify/index.ts`（新規・デプロイ済み）
- 毎朝UTC 0:00（JST 9:00）実行
- deadline - today が 3日 or 0日 の奨励日の未回答者にベル通知
- Cron登録済み（pg_cron jobid: 2）

### 変更ファイル

#### `client/src/components/admin/LeaveRequestsTab.tsx`
- 奨励日セクション追加（年度フィルター・新規作成ボタン・進捗バー付き一覧）
- 確認モーダル（回答状況一覧・編集・削除・対象者追加・CSV出力・未回答者メール送信）
- 新規作成モーダル（日付・期限・対象者選択: 雇用形態グループ・役職ヘッダー中央揃え）
- 種別フィルター追加（全種別・有給休暇・調整休 等）
- 回答編集: ✏️ ボタンでインライン編集（choice変更 + 備考変更）
- 保存時: leave_requestsを削除→再挿入（choice変更に追従）
- ✕削除時: leave_requests からも同時削除
- 「登録しました」3秒表示（緑バナー）
- 回答日時: 日付と時刻を2行表示・中央揃え（Asia/Tokyo）

#### `client/src/components/LeaveRequest.tsx`
- 未回答バナー（青→黄→赤→期限切れ色で変化）・タップして回答モーダル表示
- 回答モーダル（4択＋備考）
- 回答送信後 leave_requests に自動挿入:
  - choice=1 → leave_type='有給休暇'
  - choice=2 → leave_type='調整休'
  - choice=3 → leave_type='その他'（leave_type_other='定休日'）
  - choice=4 → leave_type='その他'（leave_type_other=備考内容）
- 「確認中」表記修正（承認中→確認中）

#### `client/src/App.tsx`
- EncouragementBanner コンポーネント（ホーム画面の消せない奨励日バナー）
- Dashboard に encAnswerModal（/leaveに遷移不要・ホーム完結）
- 回答送信後「回答を送信しました」✅バナー（3秒）
- 有給奨励日のベル通知をサイト通知バナーから除外（.not('message', 'like', '%有給奨励日%')）

### 日付フォーマット（全箇所統一）
```ts
const fmtEncDow = (dateStr: string) => {
  const d = new Date(dateStr + 'T00:00:00Z');
  return `${d.getUTCFullYear()}年${d.getUTCMonth()+1}月${d.getUTCDate()}日(${ENC_DOW[d.getUTCDay()]})`;
};
// 例: 2026年7月29日(水)
```

### ⚠️ 注意事項
- モーダルは `const modal = condition ? (...JSX...) : null` のJSX変数形式（コンポーネント関数化禁止）
- `responded_at` は Supabase が既にタイムゾーン付きで返すため `+ 'Z'` 不要（`new Date(r.responded_at)` のみ）
- leave_requests 代理挿入には `admin_insert_leave_requests` ポリシーが必要（上記SQL）
- choice変更時は既存 leave_requests を削除してから再挿入（start_date + reason='【有給奨励日】' + status='approved' で特定）

---

## ✅ 2026-06-13 メールテンプレートライブラリ・プレビュー機能 完了

### 変更内容

#### DB
- `email_templates` テーブル作成（id / name / subject / template / created_at）
- RLS: SELECT は全認証ユーザー、INSERT/UPDATE/DELETE は管理者のみ

#### `client/src/components/admin/NotificationsTab.tsx`
- **テンプレートライブラリ**（📋 ボタン）: 追加・編集・削除・一覧表示
- **テンプレートから選択**: メールチャンネルの件名・本文をライブラリから一括適用
- **テンプレートとして保存**（💾 ボタン）: 現在の件名・本文をライブラリに登録
- **プレビュー**（👁 ボタン）: `{{変数}}` にサンプル値を入力して完成形を確認
- **変数一覧**（📝 ボタン）: カテゴリ別（共通・休暇申請・交通費・時間調整）に整理、[件名へ] [本文へ] ボタンで挿入

#### ユーザビリティ
- ライブラリモーダルをJSX変数化（コンポーネント内コンポーネント禁止 → 再マウント防止・入力バグ修正）
- 最終アクセス: 列名「最終ログイン」→「最終アクセス」、時間表示追加、+9h二重加算バグ修正
- `useAuth.ts`: `.select('id')` 追加で last_sign_in_at update を強制実行

---

## ✅ 2026-06-13 通知設定 複数宛先対応 完了

### 変更内容

#### `client/src/lib/notificationDispatch.ts`
- `dispatchEmail`: 旧・1人 → 新・複数人に送信（JSON `{"recipients":["applicant","approver"]}` を解析してループ送信）
- `dispatchSiteNotification`: 同様に複数ユーザーへ通知、重複排除（`seen` セット）
- `parseRecipientKeys()`: 旧形式（plain string）・新形式（JSON配列）の両方に対応

#### `client/src/components/admin/NotificationsTab.tsx`
- メール・サイト通知の「宛先」: ドロップダウン(1択) → **チェックボックス複数選択**に変更
  - 選択肢: 申請者本人 / 申請先（承認者）/ リーダー / マネージャー
  - DBへの保存形式: `{"recipients":["applicant","approver"]}` の JSON
- Slack「送信先チャンネル」（差し戻し時・取り消し時など）: ドロップダウン(1択) → **チェックボックス複数選択**に変更
  - DBへの保存形式: `{"channels":["leader","manager"]}` の JSON
- `parseSlackChannels()`: 旧形式（plain string）対応追加
- `parseEmailSiteRecipients()`: 新ヘルパー追加
- `RECIPIENT_OPTIONS.site` に `申請先（承認者）` 追加

#### 変更なし
- 時間調整（役職チェックボックス + グループ絞り込み）→ 元から複数選択対応
- `leave:new_request` Slack → 申請先役職で自動振り分け（変更不要）

---

## ✅ 2026-06-13 細かいUI修正まとめ 完了

### 変更内容

#### 「勤務先」→「行き先」に全面改称
- 変更ファイル: ExpenseForm / HistoryView / AdminPanel / AdminPanelContext / ApprovalsTab / TripReportsTab / utils/index.ts（CSV列名も変更）

#### Googleカレンダー 時刻フォーマット修正
- `actual_time` が `"18:00:00"` でDBに保存されるため、gcal-sync に渡す前に `.slice(0, 5)` で `"18:00"` に切り詰め
- 変更ファイル: CalendarPage.tsx / LeaveRequest.tsx

#### 通知設定「保存しました」バッジ
- 3秒で自動消え・✕ボタン削除
- 変更ファイル: NotificationsTab.tsx

#### time-adjustment-notify Slack メッセージ
- 公開チャンネルのため「理由」を削除
- notification_settings: Slack・メール・サイト通知を全て有効化、Slack を全4チャンネル（leader/manager/accounting/president）に設定（SQL手動実行済み）

---

## ✅ 2026-06-13 通知バナー・モーダルデザイン統一 完了

### 変更方針
- **サイト通知 NotifItem**（App.tsx）→ Bスタイル（左ライン+薄背景）、✕ボタンのみ・自動消えなし
- **登録/削除/報告バナー** → 案Aスタイル（カード+丸アイコン）、自動消え3秒＋✕ボタン
- **CalendarPage モーダル** → 案Aスタイル（カード+丸アイコン）、自動消え3秒＋✕ボタン＋オーバーレイタップで閉じる

### 変更ファイル
| ファイル | 変更内容 |
|---|---|
| `client/src/App.tsx` | NotifItem → 左ライン+薄背景（緑/赤/オレンジ）・✕のみ |
| `client/src/components/BusinessTripReport.tsx` | BannerSuccess コンポーネント追加（カード型・3秒自動消え） |
| `client/src/components/ExpenseForm.tsx` | 同上 |
| `client/src/components/LeaveRequest.tsx` | adjBanner → BannerSuccess に置き換え |
| `client/src/pages/CalendarPage.tsx` | CalendarResultModal コンポーネント追加（登録/削除・3秒自動消え+オーバーレイ） |

### ⚠️ 注意事項
- `BannerSuccess` は各ファイルにローカル定義（共通化は意図的にしていない）
- `CalendarResultModal` は `position: fixed` をオーバーレイdivに使用（通常はNG だが CalendarPage は専用ページのため問題なし）
- NotifItem の `visible` state と setTimeout フェードアウトは削除済み（即時 onDismiss を呼ぶ）

---

## 🎨 UIフィードバック標準仕様（新規機能を作るときに必ず守ること）

### 成功フィードバック → BannerSuccess パターン（緑カード）

**すべての「登録しました」「保存しました」「送信しました」「削除しました」系は必ずこのパターンを使うこと。**
`alert()` を使用することは禁止。

```tsx
// stateを定義
const [saveBanner, setSaveBanner] = useState(false);

// 処理成功後に設定
setSaveBanner(true);
setTimeout(() => setSaveBanner(false), 3000);

// JSX（returnの最後、モーダルより外側に配置）
{saveBanner && (
  <div style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', zIndex: 9999, background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 12, padding: '20px 28px', boxShadow: '0 4px 20px rgba(0,0,0,0.15)', display: 'flex', alignItems: 'center', gap: 12, minWidth: 220 }}>
    <div style={{ width: 36, height: 36, borderRadius: '50%', background: '#22c55e', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 18, flexShrink: 0 }}>✓</div>
    <span style={{ fontSize: 15, fontWeight: 'bold', color: '#166534' }}>保存しました</span>
    <button type="button" onClick={() => setSaveBanner(false)} style={{ marginLeft: 'auto', background: 'none', border: 'none', color: '#166534', cursor: 'pointer', fontSize: 16, padding: '0 4px' }}>✕</button>
  </div>
)}
```

### エラー・バリデーション → alert() は可（ただしできればインラインバナー推奨）

| フィードバック種別 | UI |
|---|---|
| 成功（登録・保存・送信・削除） | 画面中央 緑カード（3秒自動消え＋✕）|
| エラー（API失敗） | `alert()` 可（致命的なものはインライン赤バナーが望ましい）|
| バリデーション（未入力等） | `alert()` 可 |
| 確認（取り消せない操作） | `window.confirm()` 可 |

---

## ✅ 2026-06-08 出張報告GPS必須化・UI改善 完了

### 変更内容

#### GPS位置情報を必須項目に
- GPS未取得＆チェックなしで送信 → アラートでブロック
- GPS取得成功 → 送信可
- GPS取得失敗（ボタンを押したが取得できなかった場合）→ 黄色背景の「取得できませんでした」チェックボックスが出現 → チェックすれば送信可

#### UI改善
- ボタン下に補足テキスト追加（左揃え）
  - 「許可を求めるダイアログが出たら『今回のみ』または『許可』を選んでください」
  - 「位置情報はボタンを押したときのみ取得します（常時追跡はしません）」
- 取得済み表示を「✅ 取得済み」のみにシンプル化（精度・マップリンク削除）

### コミット: `6024e83`

---

## ✅ 2026-06-08 交通費フォームUI改善 完了

### 変更内容

#### ラベルのインライン化（全フィールド統一）
- 区分・利用日・交通機関・出発・到着・金額・勤務先 → ラベルをフィールド左端にインライン配置
- ラベル色: `#9e9e9e`（グレー、申請するボタンと同系色）
- 行数削減・フォームがコンパクトに

#### 出発 ⇄ 到着 反転ボタン追加
- 真ん中に `⇄` ボタン、押すと出発駅・到着駅が入れ替わる
- placeholder: 「駅、バス停」

#### 交通機関: チェックボックス複数選択方式
- フィールドをタップするとチェックボックス一覧が出る
- 複数選択可能（例: 阪急・JR → `・` 区切りで保存）
- 選択済みは青いタグで表示
- 「決定」ボタンで閉じる
- `toDraft()` も `・` 区切り対応に更新

#### バリデーション強化
- 交通機関「その他」選択 + 自由入力欄が空 → エラー＋ピンクハイライト
- 勤務先「その他」選択 + 入力欄が空 → エラー＋ピンクハイライト
- 入力するとピンクが消える

#### 金額・勤務先レイアウト
- 金額: 固定120px（コンパクト）
- 勤務先: 残り幅全て（広め）

### コミット: `f33e127`

## ✅ 2026-06-08 交通費フォーム追加改善 完了

### 変更内容

#### グレーラベル角丸修正
- `overflow: hidden` を廃止 → ラベルに `borderRadius: '3px 0 0 3px'` + `alignSelf: 'stretch'` で枠いっぱいに表示

#### 京都市バス排他制御
- バスを選ぶ → 他の交通機関を自動解除
- 他を選んでいる状態でバスを選ぶ → 他が全解除されバスのみに

#### 注釈追加（チェックボックスドロップダウン上部）
- 「ℹ️ 複数選択可（🚌バス除く）」を常時表示
- 黄色背景（`#fff9e6`）・青文字（`#1565c0`）

### コミット: `2d4bf29`

---

## ✅ 2026-06-07 バグ修正・Slack通知フォーマット改善 完了

### 申請日時 9時間ズレ修正（`ApprovalsTab.tsx`）

#### 原因
- Supabase は `timestamptz` カラムをタイムゾーン情報なし（`2026-06-07T12:58:09` ← Zなし）で返す場合がある
- `new Date('2026-06-07T12:58:09')` はブラウザがローカル時間として解釈 → JST機では「12:58 JST」扱い
- 実際は UTC 12:58 = JST 21:58 なのに 12:58 と表示されていた（9時間ズレ）

#### 解決策
タイムゾーン情報がない文字列に `Z` を強制付加してUTCとして解釈させる：
```ts
const toJST = (utcStr: string | null | undefined): string => {
  if (!utcStr) return '';
  const hasTimezone = utcStr.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(utcStr);
  const d = new Date(hasTimezone ? utcStr : utcStr + 'Z');
  // getHours() 等はブラウザのローカル時間（JST）で返る
  return `${d.getFullYear()}/${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
};
```

#### 教訓
- `toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })` は Zなし文字列をローカル時間として変換してしまうため効果なし
- `getHours()` も同様（Zなし文字列をローカル時間と解釈）
- **Zなし文字列には必ず + 'Z' してからparseすること**

---

### Slack通知 太字が効かない問題（出張報告・休暇申請）

#### 原因
- plain text（`{ text: '...' }`）で送信すると `*テキスト*` がそのままアスタリスク付きで表示される
- Slack の太字は **Blocks API + `mrkdwn` 形式** でのみ正しく機能する

#### 解決策（Blocks API使用）
```ts
const payload = {
  text: message,        // フォールバック用（通知バナーに表示）
  blocks: [
    { type: 'section', text: { type: 'mrkdwn', text: message } },
    // ボタンが必要な場合:
    { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'ボタン名' }, url: 'URL', style: 'primary' }] }
  ]
}
```

#### 太字ルール（Slack mrkdwn）
- `*テキスト*` → 太字（前後に空白が必要）
- `*ラベル：* 値` → ✅ 効く（閉じ`*`の後にスペース）
- `*ラベル：*値` → ❌ 効かない（閉じ`*`の直後に日本語）
- `*ラベル：値*` → ✅ 効く（行全体を太字）

---

### 出張報告 Slack通知フォーマット（`BusinessTripReport.tsx` + `send-trip-slack`）

#### 完了後フォーマット
```
📝 *【出張終了報告】*

*報告者：* 濱口　美由紀
*区分：* 出張
*場所：* JEUGIA 西友山科
*次回（次月）予定：* 6/3（水）
📢 ポスティング後、14:00に戻ります。
```
- `buildSlackPreview()` 関数で `*` を除去してアプリ内プレビュー表示（Slack送信本体は `buildSlackMessage()` のまま）

---

### 休暇申請 Slack通知フォーマット（`send-leave-slack` Edge Function）

#### 通知フロー（確定版）
| ステップ | タイミング | 送信先 | 通知内容 | ボタン |
|---|---|---|---|---|
| ① | 新規申請 | リーダーorマネージャー回覧 | `🔔【休暇申請/新規】` `申請先：〇〇（役職）` | なし |
| ② | リーダー受理 | マネージャー回覧 | `✅【休暇申請/確認①】` `確認先：〇〇（マネージャー）` `受理者：〇〇（リーダー）` | なし |
| ③ | マネージャー受理 | 経理専用 | `✅【休暇申請/確認②】` `受理者：〇〇（マネージャー）` | あり |
| ④ | 経理受理 | 晃平先生へ | `✅【休暇申請/確認③】` `受理者：経理` | あり |

- ②の「確認先（マネージャー名）」は `handleApproveWithManager` 内で `managers.find(m => m.id === selectedManagerId)` で取得して渡す
- `sendLeaveSlack()` に `nextApproverName?` / `nextApproverRole?` パラメータを追加済み

### コミット
- `74872b1` fix: 申請日時JST表示修正・出張報告Slack通知をBlocks形式に変更
- `8537131` fix: 休暇申請・出張報告Slack通知フォーマット改善

### 📅 運用スケジュール
- 確認期限：2026年6月13日（金）※幹部・マネージャーにテスト依頼済み
- 運用開始目標：2026年7月1日（火）
- 次回マネージャーMTGで出張報告・休暇申請の運用ルールを審議予定

---

## ✅ 2026-06-10 欠勤入力に「遅出・早退（残業調整）」追加 完了

### 変更内容
- `attendance_exceptions.type` の CHECK制約に `late_start` / `early_end` を追加
  - migration: `20260610200000_add_late_start_early_end_to_attendance_exceptions.sql`
- 欠勤入力フォームに「🟢 調整遅出」「🟣 調整早退」チェックボックス追加
  - 遅刻と調整遅出は排他（片方チェックで自動解除）
  - 早退と調整早退も同様に排他
  - 時間入力欄は同じ行の右に配置（1つを共有）
- `ABSENCE_LABEL` / `ABSENCE_COLOR` に追加
  - `late_start`：遅出（黄緑 `#8bc34a`）
  - `early_end`：早退(残業調整)（紫 `#e1bee7`）
- `AbsenceEvent` 型定義・LeaveRequestsTab.tsx も同様に更新

### コミット
- `4f0bdef` feat: 欠勤入力に遅出・早退(残業調整)を追加
- `025d654` fix: AbsenceEvent型にlate_start/early_endを追加

---

## ✅ 2026-06-10 NavBar改善・カレンダー表示修正 完了

### 変更内容
- **NavBar スマホ対応**
  - スマホ（640px未満）：絵文字＋ラベルの正方形ボタン（52×52px）横一列
  - PC：従来の横並びボタン（fontSize:14, padding:6px 14px）
  - 右端：ベルアイコン＋名前（上）／ログアウト（下）の縦並び
- **休暇カレンダー ページタイトル追加**
  - `📅 休暇カレンダー` タイトルを追加（交通費申請と同サイズ・ダークモード対応）
  - App.tsx 側の重複タイトルを削除
- **カレンダー 遅出(調整)・早退(調整) 表示修正**
  - ラベル: `late_start` → 遅出(調整)、`early_end` → 早退(調整)
  - 色: 濃い目の背景＋白文字に統一
    - 遅刻: `#ff9800` / 早退: `#1565c0` / 遅出(調整): `#558b2f` / 早退(調整): `#7b1fa2`
  - 凡例に遅出(調整)・早退(調整)を追加

### コミット
- `370e000` fix: NavBar右側を名前・ログアウト縦並びに変更
- `e2e3592` feat: 休暇カレンダーにページタイトル追加（ダークモード対応）
- `c25ddc7` fix: 休暇カレンダータイトル重複を削除
- `6d96efd` fix: スマホNavBarをアイコン+ラベルの正方形ボタンに変更
- `c4a726c` fix: 遅出(調整)・早退(調整)のラベル・色・凡例を修正

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

## ✅ 2026-06-15 連絡板リニューアル Phase3 UX改善 完了

### 変更ファイル
- `client/src/pages/BoardPage.tsx`
- `client/src/App.tsx`

### 主な変更内容

#### 連絡板（BoardPage.tsx）

**UI/UXリニューアル**
- グループチャンネルに件名フィールドを追加（⚙️パネル内）
- 件名・本文・内容・企画・場所・リンクを左揃えに統一（全カード）
- 件名と本文の間に区切り線追加
- 種別ラベル（読了確認など）を件名の上に配置
- 受信トレイ・送信トレイカードをコンパクトなデザインにリデザイン
- ★とアーカイブ📦をヘッダー右に移動

**種別（deadline_type）**
- 確認（confirm）を5つ目の種別として追加
- DEADLINE_TYPES: read / answer / submit / approve / confirm
- DBのCHECK制約に 'confirm' を追加（Supabase SQLで手動実行済み）
  ```sql
  ALTER TABLE board_messages DROP CONSTRAINT board_messages_deadline_type_check;
  ALTER TABLE board_messages ADD CONSTRAINT board_messages_deadline_type_check
    CHECK (deadline_type IN ('read', 'answer', 'submit', 'approve', 'confirm'));
  ```
- 「確認確認」バグ修正: typeText === '確認' のとき `${typeText}確認` → `確認` のみ表示

**入力欄（全種別対応）**
- 全種別でコメント入力欄を表示（任意）
- `回答` のみ必須（赤枠 + ボタン無効化）
- 他種別（読了・提出・承認・確認）は任意（空でも「完了」ボタン有効）

**未読管理（board_reads テーブル）**
- `inboxReadIds` state（Set<string>）で開封済みID管理
- 未読カードを青左ボーダー（`3px solid #4a90d9`）で強調
- 受信トレイカードを開いたとき board_reads に upsert → readCounts もインクリメント
- `loadInbox` / `loadOutbox` / `loadData` でそれぞれ readCounts を取得（マージ方式: `prev => ({ ...prev, ...rc })`）
- **注意**: `loadData` が `setReadCounts(rc)` で全置換していた → `setReadCounts(prev => ...)` に修正済み

**既読カウント・既読状況ポップアップ**
- お知らせ（channel_id = null）の場合: チャンネルメンバーではなく `inboxRecipients[msg.id]` を使用
  - renderMsg 内 `channelMemberIds`（3箇所）
  - 既読状況ポップアップ `chMembers`（1箇所）
- 既読状況ポップアップのメッセージ検索: `[...messages, ...inboxMessages, ...outboxMessages, ...archivedMessages]` に変更（グループメッセージが `messages` state にあるため）
- 受信トレイ詳細を開いたとき `inboxRecipients` にも受信者一覧を格納

**自分への通知除外**
- `sendNotice` で `composeRecipientIds.filter(uid => uid !== user.id)` で送信者自身を除外

**時刻フォーマット**
- `fmtFull`（年/月/日 時:分）→ 送信トレイカード・renderMsg の時刻
- 通知ベルは `fmtNotif`（月/日 時:分 / 今日は時刻のみ）を App.tsx に直接インライン実装

**お知らせ件名を必須化**
- `sendNotice` バリデーション: `!composeSubject.trim()` を条件に追加

**ナビゲーション改善（← が2つある問題を解消）**
- グローバルヘッダーの ← ボタン: 詳細ビュー → リスト、リスト → サイドバー へ1クリックで戻る
- ヘッダータイトル: 詳細ビュー時は「📩 メッセージ」、それ以外は各ビュー名

**件名DB保存バグ修正**
- `insertData.title = newTitle.trim()` を `if (!parentId && newDeadlineType)` ブロック外に移動

**`insertNotification` 呼び出し修正**
- 旧オブジェクト形式（`insertNotification({ userId, message, ... })`）を正しい引数形式（`insertNotification(uid, message, undefined, 'board')`）に修正（リマインド送信の2箇所）

#### App.tsx（通知ベル・アバターメニュー）

**ドロップダウン重なり修正（ReactDOM.createPortal）**
- `BellIcon` と `AvatarMenu` のドロップダウンを `ReactDOM.createPortal` で `document.body` 直下にマウント
- ヘッダー（`position: fixed; zIndex: 100`）のスタッキングコンテキスト問題を根本解決
- ドロップダウンは `position: fixed; zIndex: 9999`、ボタン位置を `getBoundingClientRect()` で取得

**通知時刻フォーマット**
- `new Date().toLocaleString('ja-JP', { year: 'numeric', ... })` → `fmtNotif` 相当のインライン実装に変更（年なし・月/日 時:分 / 今日は時刻のみ）

### ⚠️ 注意事項

#### readCounts の管理
- `loadData`（チャンネル）・`loadInbox`（受信トレイ）・`loadOutbox`（送信トレイ）の3か所でそれぞれ取得
- 全て `setReadCounts(prev => ({ ...prev, ...rc }))` のマージ方式（`setReadCounts(rc)` の全置換禁止）
- カード開封時: `setReadCounts(prev => ({ ...prev, [msg.id]: (prev[msg.id] || 0) + 1 }))` でインクリメント

#### inboxRecipients の管理
- お知らせの受信者リストは `board_message_recipients` テーブルから取得
- `loadOutbox` で送信者側から取得
- 受信トレイ詳細を開いたとき `setInboxRecipients(prev => ({ ...prev, [inboxDetailId]: allIds }))` で格納
- `channelMemberIds` / `chMembers` を参照する全箇所で channel_id が null の場合は `inboxRecipients[msg.id]` を使うこと

#### スタッキングコンテキスト
- ヘッダーは `position: fixed; zIndex: 100` → 内部子要素の zIndex は root context では 100 相当にしかならない
- ドロップダウン系は必ず `ReactDOM.createPortal(…, document.body)` + `position: fixed; zIndex: 9999` で実装すること

### 🔜 次回タスク（2026-06-15時点）
- 残業申請フォーム（パート用）← 最優先
- 忘れん坊通知①②③（send-push Edge Function は完成済み・呼び出し側を実装）
- タブ・機能の表示権限管理画面
- UI/UX改善（コードレビュー高優先項目）

---

## ✅ 2026-06-15 連絡板 UX修正 追加対応 完了

### 変更ファイル
- `client/src/App.tsx`
- `client/src/pages/BoardPage.tsx`
- `supabase/migrations/20260616100000_board_recipients_peer_select.sql`（新規）

### 修正内容

#### 未読バッジが連絡板訪問後も消えない問題（App.tsx）
- **根本原因①**: `useBoardUnread` が `board_reads` を使用 → チャンネルをクリックしないと `board_reads` が更新されないため、連絡板を開いただけでは count が 0 にならなかった
- **根本原因②**: `Dashboard` コンポーネントは `/board` ナビゲーション時にアンマウントされるため、`useRef` の `clearedAt` がリセットされていた
- **修正**: `boardClearedAt` をモジュールレベル変数（React 外）で管理
  - `/board` を開いた瞬間に `boardClearedAt = new Date().toISOString()` をセット + `setCount(0)`
  - 以降のフェッチは `boardClearedAt` より新しいメッセージのみカウント（自分の投稿は除外）
  - `/board` から離れたときのみリフェッチ（clearedAt 以降の新着のみ）

#### 受信トレイ 未読バッジが一瞬「6」になる問題（BoardPage.tsx）
- **根本原因**: `loadInbox` で `setInboxMessages` を先に呼んでから非同期で reads を取得して `setInboxReadIds` を呼ぶ間に1レンダリングが走り、inboxUnread = 全件数 になっていた
- **修正**: メッセージ・既読ID・既読カウントを `Promise.all` で並行取得し、全て揃ってから同時 setState（React 18 の自動バッチングで1レンダリングに統合）

#### 時刻フォーマット統一（BoardPage.tsx）
- **方針**: 「連絡板TOPのチャンネル一覧（サイドバー）」は `fmtTime`（月/日 時:分）、それ以外は `fmtFull`（年/月/日 時:分）
- **変更箇所**: 受信トレイカード・グループメッセージ親/返信・スレッド最終返信・完了確認時刻・お気に入り・検索結果

#### 受信トレイ詳細に「宛先 Xeople」チップ表示追加（BoardPage.tsx）
- 送信トレイと同仕様で、受信者全員の名前チップを表示
- `inboxRecipients[inboxDetail.id]` を使用（inboxDetailId effect で自動取得済み）

#### 既読状況ポップアップ: 受信者が1人しか表示されない問題（Supabase RLS）
- **根本原因**: `board_recipients_select_own` ポリシーが `user_id = auth.uid()` のみ許可 → 受信者が他の受信者のレコードを取得できなかった
- **修正 ①**: SECURITY DEFINER 関数 `get_my_recipient_message_ids()` を作成（再帰回避）
  ```sql
  CREATE OR REPLACE FUNCTION get_my_recipient_message_ids()
  RETURNS SETOF uuid LANGUAGE sql SECURITY DEFINER SET search_path = public
  AS $$ SELECT message_id FROM board_message_recipients WHERE user_id = auth.uid(); $$;
  ```
- **修正 ②**: 新ポリシー `board_recipients_select_peer` を追加
  ```sql
  CREATE POLICY "board_recipients_select_peer" ON public.board_message_recipients
    FOR SELECT TO authenticated
    USING (message_id IN (SELECT get_my_recipient_message_ids()));
  ```
- **⚠️ 注意**: 単純な `USING (message_id IN (SELECT message_id FROM ... WHERE user_id = auth.uid()))` はRLS再帰で全件消失する → 必ず SECURITY DEFINER 関数を経由すること

#### `readDetailMsgId` 自動フェッチ追加（BoardPage.tsx）
- 既読状況ポップアップを開いたとき `inboxRecipients[readDetailMsgId]` が未取得なら自動で `board_message_recipients` を取得する useEffect を追加

#### ヘッダータイトル変更（BoardPage.tsx）
- 受信トレイ詳細: `📩 メッセージ` → `📨 受信メッセージ`
- 送信トレイ詳細: `📩 メッセージ` → `📤 送信メッセージ`

### ⚠️ 注意事項

#### useBoardUnread のモジュール変数
- `boardClearedAt` は React コンポーネント外のモジュールレベル変数（NavBar/Dashboard のインスタンスをまたいで共有される）
- ページリロード時はリセットされる → 初回ロード時は DB から全件チェックして正確な count を表示

#### RLS 再帰回避
- `board_message_recipients` に対して同テーブルを参照するサブクエリを USING 句に書くと再帰になり全件消失する
- 必ず `SECURITY DEFINER` 関数を経由すること

### 🔜 次回タスク（2026-06-15時点・更新）
- 残業申請フォーム（パート用）← 最優先
- 忘れん坊通知①②③（send-push Edge Function は完成済み・呼び出し側を実装）
- タブ・機能の表示権限管理画面
- UI/UX改善（コードレビュー高優先項目）
- gcal-sync 失敗時リトライキュー（低優先）

---

## ✅ 2026-06-16 連絡板バナー・通知 UX全面改善 完了

### 変更ファイル
- `client/src/App.tsx`
- `client/src/pages/BoardPage.tsx`
- `client/src/lib/notifications.ts`

### DB変更
- `notifications` テーブルに `reference_id text` 列を追加（nullable）
  - コマンド: `npx supabase db query --linked "ALTER TABLE notifications ADD COLUMN IF NOT EXISTS reference_id text;"`

### 主な変更内容

#### お知らせ通知バナー → 直接メッセージ詳細へ遷移（App.tsx / BoardPage.tsx / notifications.ts）
- `insertNotification` に `referenceId?` 第5引数を追加、DB に `reference_id` として保存
- お知らせ送信時: `insertNotification(uid, "...お知らせ...", preview, undefined, data.id)` で `message_id` を紐付け
- リマインド通知時も同様に `inboxDetail.id` を渡す
- `NotifItem` タップ時: `reference_id` があれば `/board?openInboxId=<id>` へ遷移
- `BoardPage` に `useSearchParams` 追加、`openInboxId` パラメータ受け取り後 `inboxMessages` ロード完了を待ってから詳細を自動展開 → `window.history.replaceState` でURLをクリア

#### 通知バナー `isBoard` 判定を改善（App.tsx）
- 旧: `n.message.includes('お知らせ')` 等の文字列マッチ（脆弱）
- 新: `n.source_type === 'inbox'` を優先し、フォールバックで文字列マッチ（シニアエンジニアレビュー反映）
- `NotificationRow` 型と fetch クエリに `source_type` / `reference_id` を追加

#### お知らせバナー 複数件折りたたみ（App.tsx）
- 3件以上のときは最初の2件のみ表示し「他n件を表示 ▼」リンクで展開（UI/UXデザイナーレビュー反映）
- `expanded` state で制御

#### バナー色の整理（App.tsx）
- お知らせポップアップ（NotifItem）: 水色 → 元の緑（`#f0fdf4`）に戻す
- 連絡板未読バナー（グループのみ）: 緑 → 水色（`#eff6ff`・`#3b82f6`）に変更

#### 連絡板を開いただけでバナーが消えるバグを修正（App.tsx）
- **旧**: `pathname === '/board'` になった瞬間に `boardClearedAt = now` を localStorage に書き強制リセット
- **新**: 連絡板を開いてもカウントはそのまま。以下のタイミングでのみ自然に減少:
  - グループ未読 → チャンネルを開いたとき（`selectChannel` → `board_reads` upsert）
  - お知らせ未読 → 個別メッセージを開いたとき（受信トレイ詳細タップ → `board_reads` upsert）
  - NavBadge → 連絡板から戻ったとき + 30秒ポーリング

### ⚠️ 注意事項

#### reference_id の活用
- `reference_id` はお知らせ（board_messages の id）を指す
- 将来的にリマインド通知も同じ仕組みで直接遷移可能
- `reference_id` が null の古い通知（実装前に送ったもの）はタップで `/board` トップに遷移（フォールバック）

#### BoardPage の `openInboxId` 処理
- `inboxMessages.length === 0` のときは guard で skip（データ未ロード時の誤作動防止）
- 該当メッセージが見つからない場合（アーカイブ済み等）も skip（フォールバックなし）
- `window.history.replaceState({}, '', '/board')` でURL から `?openInboxId=xxx` を除去（戻る→再タップ時の二重展開防止）

#### boardClearedAt の役割
- localStorage に残った `boardClearedAt` は「この日付より前のメッセージは無視」という既存のカットオフ値として機能し続ける
- 今回の修正で「連絡板を開いた瞬間に更新」する処理を削除したため、カットオフ値は固定になった
- 新着メッセージは `board_reads` テーブルで正確に管理される

### 🔜 次回タスク（2026-06-16時点）
- 残業申請フォーム（パート用）← 最優先
- 忘れん坊通知①②③（send-push Edge Function は完成済み・呼び出し側を実装）
- タブ・機能の表示権限管理画面
- UI/UX改善（コードレビュー高優先項目）
- gcal-sync 失敗時リトライキュー（低優先）

---

## ✅ 2026-06-16 boardClearedAt バグ修正 完了

### 変更ファイル
- `client/src/App.tsx`

### 問題
- `/board`（連絡板）を一度開くと `boardClearedAt=現在時刻` が localStorage に保存されていた
- 次回以降の `useBoardUnread` の `fetchCount` でこの値をフィルターとして使用
- 結果：保存時刻より前のメッセージが全て「既読扱い」になり、連絡板バナー・NavBadgeが消えるバグ

### 修正内容
- `BOARD_CLEARED_KEY` 定数と `localStorage.getItem(BOARD_CLEARED_KEY)` フィルターを完全削除
- `board_reads` テーブルのみを既読判定の唯一ソースとして使用
- チャンネルを開いた際に `board_reads` へ upsert する処理（BoardPage.tsx の `selectChannel`）は引き続き機能

### ⚠️ 注意事項
- 既存ユーザーの localStorage に古い `boardClearedAt` が残っている場合でも、コード側でその値を参照しなくなったため影響なし
- 初回アクセス時、過去に一度も開いていないチャンネルのメッセージが「未読」として表示される場合がある
  → チャンネルを開けば `board_reads` に書き込まれ以降は正常

### コミット: `0c75b8c`

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

---

## ✅ 2026-06-15 通知整理・NavBarボタン縮小 完了

### 通知の重複解消（App.tsx / notifications.ts / BoardPage.tsx）
- `notifications` テーブルに `source_type text` カラムを追加（Supabase SQL手動実行済み）
- `insertNotification()` に第4引数 `sourceType?: string` を追加（`client/src/lib/notifications.ts`）
- `BoardPage.tsx` の board系通知挿入2箇所に `source_type: 'board'` を付与
- `NotificationBanner` のクエリに `.or('source_type.is.null,source_type.neq.board')` を追加
  → board通知は連絡板未読バナー（`useBoardUnread`）に一本化し、ベル通知と重複しなくなった
- ベル（BellIcon）・名前メニュー（AvatarMenu）のドロップダウン z-index を 999 → 1500 に引き上げ

### NavBarモバイルボタン縮小（App.tsx）
- モバイル（640px未満）のナビボタンを **52×52px → 44×44px**、fontSize: 10 → 9 に変更
- 管理者6ボタン（44×6 + gap4×5 = 284px）+ 右端60px = 344px → 390px画面に収まる

### 🔜 次回タスク
- 残業申請フォーム（パート用）← 最優先
- ナビバー将来対応：ボタンが7個以上（残業申請追加時）になった場合は ☰ ハンバーガーメニュー方式に移行予定
  - 固定: ☰（左）/ 🏠交通費 / 💬連絡板（右） / 🔔 / 名前アイコン
  - カスタム2スロット: ユーザーが選択・並び替え可能
  - 保存先: `nav_preferences` テーブル（専用）
  - D&D: `@dnd-kit/core` 使用予定
- タブ・機能の表示権限管理画面
- UI/UX改善（コードレビュー高優先項目）
- gcal-sync 失敗時リトライキュー（低優先）

### migration
- `supabase/migrations/20260615000000_add_source_type_to_notifications.sql`（Supabase手動適用済み）

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

---

## 🎨 UI/UXレビュー結果（2026-06-12 エージェントレビュー）

対象：LeaveRequest.tsx / LeaveApprovals.tsx / CalendarPage.tsx / LeaveRequestsTab.tsx

### 高優先度（8件）
1. **`alert`/`confirm` 廃止** → 各フィールド直下にインラインエラー表示、送信ボタンをdisabled化
2. **受理に確認モーダルを追加**（現状は `window.confirm` のみ → 誤タップ防止）
3. **スマホカレンダーのイベント情報が少ない**（5pxドットのみ → 人数バッジや当日リストのボトムシート表示）
4. **管理テーブル（LeaveRequestsTab）がスマホで使えない**（9カラムテーブル → スマホではカード形式に切り替え）
5. **差し戻しモーダルのボタンが紛らわしい**（緑・赤の違いを説明文で補足）
6. **日付タップ領域が狭い**（MultiDatePickerのpadding: '10px 2px' → padding: '10px 0' + width: 100%）
7. **休暇日数の表示が誤っている場合がある**（start〜end差分ではなくleave_datesのJSON配列から実日数取得）
8. **凡例がカレンダー上部を大きく占有**（折りたたみ化 or カレンダー下へ移動）

### 中優先度（8件）
1. 受理・差し戻し後の**成功トースト通知がない**
2. フォームが縦に長く**スクロール量が多い**（注意事項をページ上部に固定、スマホはウィザード形式も検討）
3. **調整休の入力が複雑**（振替元日数＝取得日数ルールを事前説明）
4. 申請履歴タブの**現在年度をデフォルト展開**（現状は全て折りたたみ）
5. **パート送信エリアが常時全表示**（アコーディオンでデフォルト折りたたみ）
6. **直近6ヶ月サマリーの数値の意味が不明**（「日（延べ）」と単位表示）
7. **遅刻・早退の時刻入力を `<input type="time">` に変更**（selectボックス2つよりネイティブピッカーが使いやすい）
8. **フィルター結果0件の表示が不親切**（現在の絞り込み条件を文中に明示 + リセットボタン）

### 低優先度（4件）
1. 承認者の「✅ 受理ページへ」ボタンが申請フォーム内にあり誤タップリスク（ヘッダーへ移動）
2. 「別の承認者の順番です」に次の承認者名が表示されない
3. **削除ボタンが9pxの縦書きでアクセシビリティ違反**（最低12px以上、アイコン化も検討）
4. 欠勤取消の権限制御（`created_by === currentUserId` のみ取消可にする）

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

---

## ✅ 2026-06-11 通知設定システム完成・全イベント配線完了（続き）

### 追加実装

#### 通知設定 保存ボタンの状態表示改善（NotificationsTab.tsx）
- 未変更時：グレー（目立たない）
- 変更後：濃い青・白文字（変更があることが一目でわかる）
- `savedSettings` で保存済み状態を保持し、`isDirty` フラグで差分を検知

### 📂 変更ファイル
- `client/src/components/admin/NotificationsTab.tsx`（保存ボタン状態制御追加）

---

## ✅ 2026-06-12 管理画面の独立ページ化 完了

### 実装内容

#### 管理画面を `/admin` として独立（App.tsx / AdminPanel.tsx）
- `AdminPage` コンポーネント新規追加（`/admin` ルート）
  - `isAdmin` でなければ `/` にリダイレクト
  - `useExpenses` を独立して呼び出し（Dashboard と共有しない）
- Dashboard から `AdminPanel` ブロックを削除
- `AdminPanel.tsx`: `borderTop` 区切り線と上マージンを削除（管理画面内のタイトルと二重になるため）

#### NavBar に `⚙️ 管理` ボタン追加（isAdmin のみ・左端）
- 色: `#6f42c1`（紫）
- スマホ: 絵文字＋ラベルの 52×52px 正方形ボタン（他ボタンと統一）
- PC: テキストボタン

#### ログイン後のリダイレクト（SignIn.tsx）
- 管理者 → `/admin`
- 一般ユーザー → `/`（変更なし）
- `useAuth()` の `isAdmin` を使って振り分け

### ⚠️ 注意事項
- `useAuth()` の `loading` が `true` の間は `isAdmin` が確定していない場合があるため、
  `SignIn.tsx` でのリダイレクトは `loading` 完了後に行われる（`useAuth` の実装に依存）
- `/admin` は **クライアントサイドのルートガードのみ**。
  AdminPanel が fetch する Supabase テーブルは RLS で管理者のみアクセス可能になっていることを確認すること
- 管理者は `🏠 交通費` ボタンから `/` に遷移できる（テスト・確認用途）

### 日時表示の修正

#### LeaveRequestsTab.tsx：申請日に時刻追加
- 申請日を `2026/6/12` + `9:23` の2行表示に変更（時間は0埋めなし）
- タイムゾーン処理を `Intl.DateTimeFormat.formatToParts` + `Asia/Tokyo` 指定に変更
  - **旧方式の問題**: `new Date(str).getTime() + 9*60*60*1000` → ブラウザのローカル時間（JST）に+9時間で二重加算になる
  - **新方式**: `new Date(str)` のまま `Intl.DateTimeFormat` でタイムゾーン指定して取得

#### TripReportsTab.tsx：報告日時のゼロ埋め削除
- `06/10 18:05` → `6/10 18:05`（月・日・時の先頭ゼロを除去）

### 変更ファイル
- `client/src/App.tsx`
- `client/src/pages/SignIn.tsx`
- `client/src/components/AdminPanel.tsx`
- `client/src/components/admin/LeaveRequestsTab.tsx`
- `client/src/components/admin/TripReportsTab.tsx`

---

## 📋 次回作業予定

### 優先順
1. **Googleカレンダーとの同期**（休暇カレンダー連携）← 次回最優先・下記プラン参照
2. **承認フロー各ステップのメール通知テンプレート整備**
   - 件名・本文を管理者が通知設定画面から調整できるようになった
3. **会議審議予定の運用ルール確定後に対応**
   - 出張報告：入り報告の要否 / 2名出張時の扱い
   - 休暇申請：申請期限・承認者不在時のエスカレーション

---

## 🗓️ Googleカレンダー連携プラン（2026-06-12 確定）

### 確定仕様

| 項目 | 決定内容 |
|------|---------|
| 方向 | ポータル → Googleカレンダー（一方向） |
| 書き込み先 | テスト中：新規「休暇」カレンダー / 本番：ファイブM共有カレンダー |
| 切り替え方法 | Supabase Secrets の `GCAL_CALENDAR_ID` を差し替えるだけ |
| 認証 | サービスアカウント（five-m.com の Google Workspace） |
| 書き込みタイミング | 休暇：最終受理時 / 欠勤・遅刻・早退：管理者入力時 |
| 変更・差し戻し | 自動で更新・削除（gcal_events テーブルのIDを使う） |
| 時間 | 終日イベント（全種別） |
| 複数日 | 1日ずつ個別イベント（ポータルの日付選択と対応） |

### イベントタイトルフォーマット

```
休暇系（薄ピンク）：
  林 晃平｜有給休暇
  川井 玲｜BD休暇
  清水 治彦｜慶弔休
  阿部 勇輝｜調整休
  鈴木 雄介｜病欠
  小出 佳奈｜その他

欠勤・時間変更系：
  林 晃平｜休み          ← 全欠勤（薄ピンク）
  林 晃平｜遅刻｜13:30〜  ← 遅刻（緑）
  清水 治彦｜遅出(調整)｜14:00〜  ← late_start（緑）
  阿部 勇輝｜早退｜〜15:00        ← 早退（緑）
  清水 治彦｜早退(調整)｜〜18:00  ← early_end（緑）
```

### カレンダー色分け（Google colorId）
- **薄ピンク**：休み系（有給・BD・慶弔・調整休・病欠・その他・全欠勤）
- **緑**：時間変更系（遅刻・遅出・早退・早退調整）

### DB設計：gcal_events テーブル（新規作成）

```sql
CREATE TABLE gcal_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type   TEXT NOT NULL,  -- 'leave' | 'absence'
  source_id     UUID NOT NULL,
  event_date    DATE NOT NULL,
  gcal_event_id TEXT NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX ON gcal_events (source_type, source_id);
```

差し戻し・削除時は `source_id` で全イベントを一括取得 → Google API で削除 → レコード削除

### 同期失敗キュー：gcal_sync_queue テーブル（新規作成）

```sql
CREATE TABLE gcal_sync_queue (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type TEXT NOT NULL,
  source_id   UUID NOT NULL,
  operation   TEXT NOT NULL,  -- 'upsert' | 'delete'
  retry_count INT DEFAULT 0,
  last_error  TEXT,
  created_at  TIMESTAMPTZ DEFAULT now()
);
```

- Google API 失敗時：ポータル処理はそのまま確定、キューに追加
- 失敗時は Slack で経理担当・社長に通知（SLACK_WEBHOOK_ACCOUNTING / SLACK_WEBHOOK_PRESIDENT）
- pg_cron または定期 Edge Function でリトライ

### Edge Function 実装順序

| フェーズ | 内容 | 工数目安 |
|---------|------|---------|
| Phase 1 | サービスアカウント認証PoC（JWT RS256 in Deno） | 1〜2日 |
| Phase 2 | イベント作成・更新・削除の基本 Edge Function | 2日 |
| Phase 3 | 休暇承認フロー（最終受理トリガー）組み込み | 1日 |
| Phase 4 | 欠勤・遅刻・早退（管理者入力時）組み込み | 1日 |
| Phase 5 | リトライキュー + 管理画面の同期ステータス表示 | 2日 |

### ⚠️ 技術的注意点

1. **Deno での JWT 実装**
   - `googleapis` ライブラリ不可（Node.js専用）
   - `crypto.subtle.importKey` + `djwt` ライブラリで RS256 署名
   - **必ずPhase 1でPoCを完成させてから本実装に入ること**

2. **gcal_event_id の保存**
   - 配列カラムではなく `gcal_events` 別テーブルで管理
   - 保存前クラッシュでゴーストイベントが残る可能性あり（設計上許容）

3. **Supabase Secrets に追加が必要なもの**
   - `GCAL_SERVICE_ACCOUNT_KEY`（JSONキー）
   - `GCAL_CALENDAR_ID`（テスト用カレンダーID → 後で本番に切り替え）

### 初回セットアップ手順（実装前に必要）
1. Google Cloud Console でサービスアカウント作成（five-m.com Workspace）
2. 「休暇テスト」カレンダーを作成、サービスアカウントに編集権限を付与
3. サービスアカウントのキー（JSON）をダウンロード → Supabase Secrets に登録
4. Phase 1 PoC でテストイベントを1件投入して動作確認

---

## ✅ 2026-06-11 通知設定システム完成・全イベント配線完了

### 🎯 実装した機能

#### 1. 通知設定UI改善（NotificationsTab.tsx）
- **leave:new_request Slack**: ドロップダウン廃止 → 静的2行表示（リーダー申請先・マネージャー申請先）＋自動振り分け説明
- **leave:rejected Slack**: チャンネル選択肢を3択に（リーダー・マネージャー・経理）
- **trip:report_end**: Slackは説明テキスト表示のみ、メール・サイト通知はON/OFFトグル維持
- **Slackテンプレート欄を非表示**: Slackメッセージはシステム自動生成のため「※ Slackのメッセージ内容はシステムで自動生成されます」に変更
- **保存ボタン**: 背景色を濃い青（#0277BD）・白文字に変更（視認性向上）
- **承認者ラベル**: 「承認者」→「申請先（承認者）」に変更

#### 2. 差し戻し時Slackチャンネル通知（leaveSlack.ts / send-leave-slack/index.ts）
- `LeaveSlackEvent` 型に `'rejected'` 追加
- `sendLeaveSlack` に `targetChannel?` パラメータ追加
- send-leave-slack Edge Function に rejected ルーティング追加（`🔴 *【休暇申請 / 差し戻し】*` メッセージ）

#### 3. 全イベントへのメール・サイト通知配線
| イベント | メール | サイト通知 |
|---|---|---|
| leave:new_request | ✅ LeaveRequest.tsx | ✅ LeaveRequest.tsx |
| leave:leader_approved | ✅ LeaveApprovals.tsx | ✅ LeaveApprovals.tsx |
| leave:manager_approved | ✅ LeaveApprovals.tsx + LeaveRequestsTab.tsx | - |
| leave:rejected | ✅ LeaveRequestsTab.tsx | - |
| expense:new_request | ✅ ExpenseForm.tsx | ✅ ExpenseForm.tsx |
| trip:report_end | ✅ BusinessTripReport.tsx | ✅ BusinessTripReport.tsx |

#### 4. notificationDispatch.ts ヘルパー追加
- `getUserEmail(userId)`: profilesテーブルからメールアドレスを取得
- `dispatchEmail(eventKey, vars, emails)`: 宛先キーで解決してメール送信（console.logデバッグ付き）
- `dispatchSiteNotification(eventKey, vars, userIds, insertFn)`: 宛先キーでuser_idを解決してサイト通知

#### 5. RLS修正（notification_settings テーブル）
- 問題: 管理者のみ読み取り可能 → 一般ユーザーが設定を読めずshouldSend()が常にfalse
- 修正: SELECTポリシーを全認証ユーザーに許可（INSERT/UPDATE/DELETEは管理者のみ維持）
- ファイル: `fix_notification_rls.sql`（実行済み）

#### 6. CORS修正（Edge Functions）
- 問題: ローカル開発サーバーがポート5175で動作しているが、全Edge FunctionはCORSに5175未記載
- 修正: 5つのEdge Functionすべてに `http://localhost:5175` を追加・デプロイ済み
  - send-email, send-leave-slack, slack-notify, send-trip-slack, create-user

#### 7. 休暇申請フォーム改善（LeaveRequest.tsx）
- **申請先（承認者）ドロップダウン**: 初期値を空に（「申請先を選択してください」プレースホルダー）
- **振替元の勤務日**: `<input type="date">` → `<MultiDatePicker>` （振替休日と同じ複数選択カレンダー）
- **バリデーション追加**: 振替元勤務日と休暇日の日数が一致しないと送信不可

#### 8. メール送信バグ修正
- 問題: 宛先が「申請先（承認者）」の場合、`emails['approver']` がundefinedでメール未送信
- 修正: `dispatchEmail('leave:new_request', vars, { applicant: ..., leader: ..., approver: leaderEmail })`

### 🔧 トラブルシューティング履歴
- **Vercel ビルドエラー（TS2339）**: LeaveReq インターフェースに `leave_dates?: string | null` 追加で解決
- **Vercel ビルドエラー（TS2552）**: `setChoseiOriginDate` → `setChoseiOriginDates` 修正で解決
- **メール不達（RLS）**: notification_settings の読み取りポリシー修正で解決
- **メール不達（CORS）**: ポート5175をすべてのEdge FunctionのCORSに追加で解決
- **メール不達（Gmailフィルター）**: noreply@five-m.com からのメールを削除するフィルター設定されていた → ユーザーが削除して解決

### 📂 変更ファイル
- `client/src/components/admin/NotificationsTab.tsx`
- `client/src/lib/notificationDispatch.ts`
- `client/src/lib/leaveSlack.ts`
- `client/src/components/LeaveRequest.tsx`
- `client/src/components/LeaveApprovals.tsx`
- `client/src/components/admin/LeaveRequestsTab.tsx`
- `client/src/components/ExpenseForm.tsx`
- `client/src/components/BusinessTripReport.tsx`
- `supabase/functions/send-leave-slack/index.ts`
- `supabase/functions/send-email/index.ts`
- `supabase/functions/slack-notify/index.ts`
- `supabase/functions/send-trip-slack/index.ts`
- `supabase/functions/create-user/index.ts`
- `fix_notification_rls.sql`（新規・実行済み）

---

## ✅ 2026-06-13 セキュリティ改善・ユーザー管理UI改善 完了

### セキュリティ改善（コードレビュー対応）

#### UsersTab.tsx
- `console.log` 削除（本番稼働中のデバッグログ除去）
- パスワード入力欄を `type="text"` → `type="password"` に変更（平文表示を廃止）
- 👁️ トグルボタンでパスワードの表示/非表示を切り替え可能に
- `passwordManuallyEdited` フラグ追加：手動でパスワードを変更済みの場合、メールアドレスを編集してもパスワードが上書きされないバグを修正
- メールアドレス形式バリデーション追加（`/^[^\s@]+@[^\s@]+\.[^\s@]+$/` でチェック）

#### send-email/index.ts（Edge Function）
- HTMLインジェクション対策：受信した `html` から `<script>...</script>` タグを除去してから Resend に渡す
- 不正Origin へのCORSフォールバックを `ALLOWED_ORIGINS[0]`（本番URL）→ `'null'` に変更

### ユーザー管理画面UI改善

#### テーブル構造変更
- 「件数」列を削除
- 「グループ」列を追加（`profiles.group_names` を表示）
- 「最終ログイン」列を追加（ログイン時に `profiles.last_sign_in_at` を更新）

#### Supabase SQL（実施済み）
```sql
ALTER TABLE profiles ADD COLUMN last_sign_in_at timestamptz;
```

#### レイアウト改善
- テーブルを中央寄せ（`width: auto` + `justifyContent: center`）
- 全ヘッダーを中央揃えに統一
- メール列を `width: 160px` に縮小（省略表示）
- 名前列を `140px` に拡大
- グループ列を `120px` に設定
- 📧 アイコン → 「メール」テキストに変更（わかりやすく）
- 「雇用形態・役職を編集」ボタンを「ユーザー追加」と同じ行に移動
- 並び替えボタンを中央寄せ

### 変更ファイル
- `client/src/components/admin/UsersTab.tsx`
- `client/src/hooks/useAuth.ts`（ログイン時に `last_sign_in_at` を更新）
- `client/src/types/index.ts`（`AdminUserProfile` に `last_sign_in_at` 追加）
- `client/src/components/admin/AdminPanelContext.tsx`（fetchUsers に `last_sign_in_at` 追加）
- `supabase/functions/send-email/index.ts`

### デプロイ済み
- `send-email` Edge Function デプロイ済み

---

### 🔜 次回やること（2026-06-13時点）

#### 優先①：UsersTab・send-email コードレビュー対応の残り（余裕時）
| 内容 | 場所 |
|------|------|
| レート制限設定 | Supabase Dashboard → Rate Limits |
| 送信進捗表示（progress バー） | UsersTab SendEmailModal |
| 失敗分の再送ボタン | UsersTab SendEmailModal |
| 並列送信（Promise.allSettled） | UsersTab handleSend |

#### 優先②：承認フロー通知メール（Phase 3）
- 承認・差し戻し・受理の各ステップでメール送信

#### 優先③：メールテンプレート管理（Phase 2）
- `email_templates` テーブル作成・テンプレート選択UI

#### 低優先
- gcal-sync 失敗時リトライキュー（Phase 5）

---

## ✅ 2026-06-13 パート向け有給申請フォーム（ホーム表示）実装

### 概要
`leaveRequestEnabled = true` のパート社員がホーム画面から直接休暇申請できる機能。

### 実装内容
#### App.tsx
- 緑バナー「有給申請を送信してください」をホームに表示（`leaveRequestEnabled && !leaveSubmitted`）
- タップでフルスクリーンモーダルが開き、通常の休暇申請フォームと全く同じ内容を表示
- 上部に✕ボタン（モーダルを閉じる）
- 申請完了後：`leaveSubmitted = true` でバナー非表示（画面遷移なし）
- Props: `onSubmitSuccess={() => { setShowLeaveModal(false); setLeaveSubmitted(true); }}`

#### LeaveRequest.tsx
- Props に `onSubmitSuccess?: () => void` を追加
- `leaveRequestEnabled = true` のとき：
  - タブを「🌿 休暇」のみ表示（「時間調整」「申請履歴」非表示）
  - 休暇種別セレクトを「有給休暇」固定（他の選択肢非表示・disabled）
- 申請完了後：`onSubmitSuccess` があればそれを呼ぶ（モーダルを閉じる）、なければ従来通り `/` へ navigate
- 成功表示を `BannerSuccess` コンポーネントに統一（フルページ表示廃止）

### 注意事項
- `leaveRequestEnabled` は管理者・リーダー・マネージャーいずれが送信しても `true` になる
- 申請完了後に `leave_request_enabled = false` がDBに書かれるが、useAuth の再取得は即時されない
  → `leaveSubmitted` ローカルstate でバナーを隠すことで対応

### 🔜 次回やること（2026-06-13更新）

#### ✅ 完了済み：UsersTab・send-email コードレビュー対応
| 内容 | 状態 |
|------|------|
| console.log 削除 | ✅ 対応済み（該当行なし） |
| HTMLインジェクション対策 | ✅ 対応済み（send-email:42） |
| 並列送信（Promise.allSettled） | ✅ 対応済み（UsersTab.tsx:186） |
| 送信進捗バー | ✅ 対応済み（UsersTab.tsx:227） |
| 失敗分の再送ボタン | ✅ 対応済み（UsersTab.tsx:242） |
| パスワード表示トグル（👁️） | ✅ 対応済み（UsersTab.tsx:18） |
| メールバリデーション追加 | ✅ 対応済み（send-email/index.ts コミット: 2b9496b） |

#### 優先①：承認フロー通知メール（Phase 3）
- 承認・差し戻し・受理の各ステップでメール送信

#### 優先②：レート制限設定
- Supabase Dashboard → Rate Limits で設定

#### 低優先
- gcal-sync 失敗時リトライキュー（Phase 5）

---

## ⚠️ セッション開始時のルール（必ず守る）

### タスク確認の手順
1. 「次回やること」に残っているタスクを**コードで確認してから**状況を報告する
2. 「メモにこう書いてある」ではなく「コードを見たらこうなっている」を先に伝える
3. 完了済みのタスクを未対応として報告しない

### なぜこのルールが必要か
- 引き継ぎメモに「どれが完了済みか」が書かれていない場合がある
- コードを見ずにメモの内容をそのまま報告すると、すでに実装済みのタスクを「残っている」と誤って伝えてしまう
- ユーザーに余計な確認コストをかけないため、必ずコードで事実確認してから報告する

---

## 📋 将来タスク：社内連絡板＋プッシュ通知機能

### 概要
「楽らく連絡プラス」の代替として、fivem-portal 内に社内連絡板を実装する。
広告なし・既存のユーザー/グループ情報をそのまま利用できる。

### 確定した仕様（2026-06-13 設計中）
- **画面構成**: B案（グループも個人も1つの一覧画面にまとめる）
- **自動投稿先**: 休暇・欠勤申請 → リーダー＆マネージャーグループに自動投稿
- スレッド有無・既読・添付など詳細は設計継続中

### プッシュ通知 実装ステップ
| Step | 内容 | 状態 |
|------|------|------|
| 1 | 掲示板・連絡機能を作る（DB・画面・自動投稿） | ✅ 完了 |
| 2 | Service Worker を追加（public/sw.js） | ✅ 完了（2026-06-14） |
| 3 | VAPID鍵・購読情報DB・Edge Function（send-push） | ✅ 完了（2026-06-14） |
| 4 | 通知設定画面（アカウント画面に許可ボタン・ON/OFF） | ✅ 完了（2026-06-14） |

### プッシュ通知 実装詳細（2026-06-14 完了）
- **VAPID公開鍵**: `BOjtAkA5HCLTuJwop__FzxcccvAfwoyNt1e0uybDz83cI0p7zBZQcLx7EWy3edif4JTUKcc_0dUKly2iozylyq8`
- **VAPID秘密鍵**: Supabase Edge Functions Secrets に保存済み（`VAPID_PRIVATE_KEY`）
- **DBテーブル**: `push_subscriptions`（user_id, endpoint, p256dh, auth）
- **Edge Function**: `send-push`（user_ids・title・body・url を受け取り通知送信）
- **クライアント**: `src/utils/pushNotification.ts`（許可取得・購読・解除）
- **通知設定UI**: `AccountSettings.tsx`（🔔 許可する / OFFにする・拒否時は手順表示）

### 通知を送る方法（他の Edge Function から呼び出す）
```typescript
await supabase.functions.invoke('send-push', {
  body: {
    user_ids: ['uuid1', 'uuid2'],  // 送り先ユーザーIDの配列
    title: '連絡板',
    body: '新しいメッセージがあります',
    url: '/board',  // タップで開くURL
  }
});
```

### 未実装（次回タスク）
- 忘れん坊通知①: 期限付き投稿 → 未回答者に send-push 呼び出し
- 忘れん坊通知②: 定期リマインド（毎月◯日）→ Supabase Cron + send-push
- 忘れん坊通知③: 「確認しました」ボタン → 未確認者を管理者が把握
- 送信・投稿権限設定画面（役職×個人/グループのON/OFF）

### 注意事項
- iPhone はホーム画面に追加（PWAインストール）しないとプッシュ通知が届かない
- ブラウザで「拒否」した場合はアプリ側から再許可できない（ブラウザ設定で手動変更が必要）
- `visibilitychange` イベントで権限状態を自動再チェックするため、ブラウザ設定変更後にタブに戻ると自動反映される

### 対応端末
| 端末 | 条件 | 通知 |
|------|------|------|
| Android | Chromeでホーム画面に追加 | ◎ 届く |
| iPhone | Safariでホーム画面に追加（iOS 16.4以上） | ◎ 届く |
| PC（Chrome） | ブラウザ閉じていても | ◎ 届く |
| iPhone（ブラウザのまま） | ホーム画面追加なし | ✕ 届かない |

※ fivem-portal はすでにPWA設定済みのため Service Worker 追加から着手できる。

---

## 📋 将来タスク：社内連絡板 確定仕様（2026-06-13 設計完了）

楽らく連絡プラスの代替として fivem-portal 内に実装する。

### 確定した仕様一覧

| 項目 | 決定内容 |
|------|---------|
| 画面構成 | グループも個人も1つの一覧画面にまとめる（LINE形式） |
| 自動投稿先 | 休暇・欠勤申請 → リーダー＆マネージャーグループに自動投稿 |
| スレッド | あり（1件の話題にリプライが束になる） |
| 既読 | 通常は人数のみ（「既読3」）・管理者は名前一覧も確認可 |
| ファイル添付 | まずテキストのみ（将来Supabase Storageで画像追加可・15〜20年無料枠で運用可） |
| 削除・編集 | 両方可（編集後は「編集済み」表示あり） |
| 通知タイミング | 参加しているグループに投稿があったとき |
| グループ | 「全員」グループあり・管理者＋マネージャーが作成・メンバー追加可 |
| 個人メッセージ | 誰でも送受信可・会話ごとにミュート可 |
| 通知種類 | サイト通知・メール・プッシュ通知（将来）を投稿ごとに選択可 |

### 送信・投稿権限（設定画面でチェックボックス管理）

**個人メッセージ・グループ投稿：**
- 役職（管理者/社長/マネージャー/リーダー/一般/パート）×「個人宛」「グループ宛」の2軸でON/OFF
- 管理者は常時ON固定
- 受け取りは全役職・全雇用形態が常に可能

**全体グループ（全員・こども・大人・管理部など）への投稿：**
- グループごとにタブ切り替えで個別設定
- 役職とグループ所属の両軸でON/OFF（どちらかを満たせば投稿可）

### 忘れん坊通知（リマインド機能）

**3パターン全部実装：**

| パターン | 内容 |
|---------|------|
| ① 未回答リマインド | 投稿に期限を設定 → 未回答者に自動通知（期限1日前・当日） |
| ② 定期リマインド | 毎月〇日に指定グループへ自動通知（月目標・シフト提出など） |
| ③ 確認ボタン | 重要連絡に「確認しました」ボタン → 未確認者を管理者が把握・一括リマインド可 |

**リマインド設定権限（チェックボックス管理）：**
- 全体向け：管理者・社長・マネージャー・リーダーが設定可
- チーム向け：正社員以上が自分のグループに設定可
- 個人向け：個人メッセージ送信権限がONの役職のみ設定可

### スプレッドシート連携（月目標未提出通知）

- GAS（Google Apps Script）から Supabase Edge Function を呼び出す
- 毎月〇日に自動実行（GASのタイム駆動トリガー）
- 未提出者のサイト通知・メール・プッシュを自動送信
- 当面はスプレッドシートのまま運用、余裕ができたら fivem-portal に取り込み

---

## 📋 将来タスク：その他（別途設計・実装）

### タブ・機能の表示権限管理画面 - 将来実装

**目的：** 新機能を追加した際、まず幹部だけで試して問題なければ全体公開する運用を可能にする。

**仕様：**
- 管理画面に「機能表示設定」タブを追加
- 既存・新規すべての機能（タブ）を一覧表示
- 各機能ごとに「どの役職まで表示するか」をチェックボックスで設定
  - 例：社内連絡板 → ✅管理者 ✅社長 ✅マネージャー ☐リーダー ☐一般 ☐パート
- 設定はSupabaseのDBに保存（コード変更不要で切り替え可能）
- 対象機能例：社内連絡板・残業申請・有給申請・出張報告・カレンダー・など全タブ

---

### 残業申請フォーム（パート用）- 近々実装予定

**仕様：**
1. 出勤時間・退勤時間を入力
2. 勤務時間・休憩・労働時間を自動計算して表示
3. 何時間の残業申請かが自動で算出される
4. 申請先としてリーダーまたはマネージャーを選択して送信

**休憩の自動計算ルール（現行スプレッドシートの数式より）：**
- 勤務時間 4:15未満、または退勤13:00以前かつ勤務5:45以内 → 休憩 0:00
- 13:00以降出勤で退勤6:15以内 → 休憩 0:15
- 退勤6:30以内 → 休憩 0:30
- 退勤8:45以内 → 休憩 0:45
- 退勤8:45超 → 休憩 1:00
- 13:00前出勤で勤務6:30の場合 → 休憩 0:30

**申請先：** リーダー・マネージャーから選択（LeaveRequestと同様の選択UI）

---

## ✅ 2026-06-14 連絡板UI全面改善・NavBar刷新 完了

### 変更ファイル
- `client/src/pages/BoardPage.tsx`
- `client/src/App.tsx`

### BoardPage.tsx 変更内容

#### スレッド（リプライ）Case B 実装
- リプライボタンを押すと全画面スレッドパネルが開く（Slack方式）
- `threadMsgId` state で制御、`position: fixed; top:60; bottom:0; zIndex:200`
- スレッドパネル構成: 固定ヘッダー（← スレッド）+ 親メッセージ固定表示 + リプライ一覧 + 固定入力欄
- リプライにも 既読N 未読N を右揃えで表示
- リプライ送信時: スレッド参加者（親メッセージ投稿者 + 既存リプライ投稿者）に `insertNotification` で通知

#### チャンネルヘッダー・連絡板ヘッダーの常時固定化
- 両ヘッダーを `position: fixed; top:60` で常時DOM常駐
- `showChannelList` の true/false で `display: flex / none` を切り替え
- channelListPanel・messagePanel のヘッダーをJSX外（return内のルート）に移動

#### その他UI修正
- 送信確認モーダルの本文テキストを左揃えに
- スレッドパネル内メッセージを左揃えに

#### 未読バナー改善（App.tsx）
- boardToast（5秒で消えるポップアップ）→ インラインバナー（消えない）に変更
- `boardToast` state・useEffect を削除
- 連絡板ページを開いている間はバナー非表示（`location.pathname !== '/board'`）

### NavBar 刷新（App.tsx）

#### 右端をアバター丸アイコン + ベルに変更
- 旧: ベル + 名前テキスト + ログアウトボタン（幅が足りずはみ出ていた）
- 新: ベル（既存 BellIcon）+ アバター丸（初期文字1文字、青`#4a90d9`）
- `AvatarMenu` コンポーネント新規作成
  - タップでドロップダウン: 名前 / アカウント設定リンク / ログアウトボタン
  - 通知リストはベルアイコンが担当するためアバターメニューには含めない
  - 外クリックで閉じる（`mousedown` イベント）

### 連絡板 管理者設定・管理機能（実装済み・記載漏れ）

#### ① グループチャンネル作成（管理者のみ）
- チャンネルリストヘッダー右の `＋` ボタン or チャンネルなし画面の「＋ グループを作成」
- グループ名入力 + メンバー選択（雇用形態ヘッダー+役職列+チェックボックス+チップ表示）
- 作成後 `board_channels` + `board_channel_members` に INSERT

#### ② メンバー管理（管理者: 全操作 / 一般: 閲覧のみ）
- チャンネルヘッダー右の `👥 メンバー` ボタンでモーダル表示
- 管理者: チェックボックスで追加・削除・一括保存
- 一般: メンバー一覧の閲覧のみ

#### ③ チャンネル削除（管理者 or チャンネル作成者）
- チャンネルリスト各行の右端 🗑 ボタン
- `confirm()` ダイアログ → `board_channel_members` / `board_messages` / `board_channels` を順に DELETE

#### ④ 既読詳細表示設定（管理者のみ）
- チャンネルヘッダー右の `👁 既読` ボタンで ON/OFF 切り替え
- ON（緑枠）: 全メンバーが「既読N 未読N」を見られる
- OFF: 既読数非表示
- 設定は `master_options` テーブル `category='board_show_read_detail'` に保存（全体共通）

#### ⑤ 未確認者リマインド（管理者のみ）
- 読了確認付きメッセージ（deadline_type あり）に「リマインド送信」黄ボタン表示
- 押すと未確認者の名前一覧モーダル → 「リマインドを送信」で `insertNotification` 実行

#### ⑥ DM（個人メッセージ）作成（全員）
- チャンネルリストヘッダーの `✉️` ボタンから相手を選んで DM チャンネル作成

### 🔜 次回タスク（2026-06-14時点）
1. **残業申請フォーム（パート用）** ← 最優先
2. **連絡板 送信時 宛先指定（機能B）**
   - メッセージ入力欄の上に「宛先」欄＋「＋ 追加」ボタンを追加
   - タップで既存チェックボックスUI（グループ一覧 + 役職別メンバー一覧）が開く
   - グループ名・個人を混在で複数選択 → チップ表示
3. **タブ・機能の表示権限管理画面**
4. **gcal-sync 失敗時リトライキュー**（低優先）

---

## ✅ 2026-06-14 連絡板 送信権限設定・チャンネル管理 完了

### 実装内容

#### 管理画面「📨 連絡板設定」タブ（BoardSettingsTab.tsx）新規作成
- AdminPanelContext に `'board_settings'` タブ追加
- AdminPanel.tsx にタブ登録・BoardSettingsTab インポート追加

#### グループチャンネル作成（管理者のみ）
- 連絡板ページの「＋」ボタンはすでに `isAdmin` チェック済み（管理者のみ表示）
- 連絡板設定タブからもグループチャンネルを作成可能
  - チャンネル名入力＋メンバー選択（名前絞り込み・チェックボックス）
  - 作成時に `created_by` + 選択メンバーを `board_channel_members` に INSERT

#### チャンネルごとの送信権限設定
- グループチャンネル: チャンネルごとに個別設定（雇用形態・役職チェックボックス）
- 全選択・全解除ボタン（雇用形態・役職それぞれに追加）
- 設定は `board_channels.send_permissions`（JSONB）に保存
- BoardPage.tsx の `canSendInChannel()` で権限チェック → 非権限者は入力欄を非表示

#### DM全体デフォルト送信権限設定
- DMチャンネルは個別設定ではなく全体共通のデフォルト権限
- 設定は `app_settings` テーブル key=`dm_default_send_permissions` に保存（JSONB）
- BoardPage.tsx ロード時に `app_settings` から取得、DMチャンネルに適用

### Supabase SQL（実施済み）
```sql
ALTER TABLE board_channels ADD COLUMN IF NOT EXISTS send_permissions JSONB;

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value JSONB,
  updated_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_all" ON app_settings FOR ALL USING (true) WITH CHECK (true);
```

### 注意事項
- `app_settings` テーブルのRLSポリシー `allow_all` は作成済み
- 管理者は `canSendInChannel()` を常にバイパス（isAdmin = true）
- 送信権限ロジック: `employment_types` OR `role_titles` のどちらかに含まれれば送信可（OR条件）

### 🔜 次回タスク（2026-06-14 セッション終了時点）
1. **残業申請フォーム（パート用）** ← 最優先
2. **連絡板 送信時 宛先指定（機能B）**
3. **タブ・機能の表示権限管理画面**
4. **gcal-sync 失敗時リトライキュー**（低優先）

---

## ✅ 2026-06-14 連絡板 一斉送信・UI改善 完了

### 実装内容

#### 一斉送信機能（BoardPage.tsx）
- ✉️ボタン → 「メッセージ送信」テキストボタンに変更（青色・目立つデザイン）
- 送信モーダルをチェックボックスUI（雇用形態ヘッダー+役職列+一括選択ボタン）に変更
  - **1人選択** → 「DMを開始」ボタン → 既存の1対1DMを開く
  - **複数選択** → メッセージ入力欄が出現 → 「一斉送信（N人）」ボタン
- 一斉送信の動作:
  - 各受信者に個別DM（1対1）としてメッセージが届く
  - 送信者には「📤 送信メール」チャンネルが自動作成され、送信履歴が残る
  - 各メッセージに「宛先: ○○、△△、...」が緑色で表示される
  - 「送信メール」チャンネルは返信不可（「送信した連絡の履歴です（返信不可）」表示）

#### 送信メールチャンネル（board_channels type='sent_mail'）
- 型: Channel.type に `'sent_mail'` を追加
- board_messages に `broadcast_recipients JSONB` カラム追加（Supabase SQLで適用済み）
- board_channels の type 制約を更新（'group' | 'dm' | 'sent_mail'）
- チャンネルリストで 📤 緑アイコンで表示

### Supabase SQL（実施済み）
```sql
ALTER TABLE board_messages ADD COLUMN IF NOT EXISTS broadcast_recipients JSONB;
ALTER TABLE board_channels DROP CONSTRAINT IF EXISTS board_channels_type_check;
ALTER TABLE board_channels ADD CONSTRAINT board_channels_type_check
  CHECK (type IN ('group', 'dm', 'sent_mail'));
```

#### 既読設定の移動
- 「👁 既読」ボタンをチャットヘッダーから削除
- 管理画面「連絡板設定」タブ上部に「👁 既読詳細の表示 ON/OFF」として移設
- 既読数タップ（詳細モーダル）は管理者のみに制限（`isAdmin && showReadDetail`）

#### メンバー表示
- チャンネルヘッダーの人数（例：20人）をタップするとメンバー一覧モーダルが開く（既存動作を確認）

#### ヘッダーボタン整理（BoardPage.tsx）
- ボタン順: **メッセージ送信（青）** → **通知設定** → **＋（管理者のみ）**
- アイコンボタン（🔔・✉️）からテキストボタンに統一
- ベルボタンの遷移先: `/account` → `/notification-settings`（新規ページ）

#### 通知設定ページ（NotificationSettings.tsx）新規作成
- プッシュ通知のON/OFFのみ表示するシンプルなページ（`/notification-settings`）
- 「戻る」で前のページに戻る

### ⚠️ 注意事項
- `sent_mail` チャンネルは送信者だけがメンバー（RLSは既存member-basedポリシーで対応）
- 一斉送信は「各受信者に個別DM」として届く（全員が同じグループに入るわけではない）
- 送信メールの `broadcast_recipients` カラムは board_messages に追加済み

### 🔜 次回タスク（2026-06-14 セッション2 終了時点）
1. **残業申請フォーム（パート用）** ← 最優先
2. **タブ・機能の表示権限管理画面**
3. **UI/UX改善**（コードレビュー高優先項目）
4. **gcal-sync 失敗時リトライキュー**（低優先）

---

## ✅ 2026-06-14 連絡板 レイアウト修正・スクロール改善 完了

### 変更ファイル
- `client/src/pages/BoardPage.tsx`

### 変更内容

#### チャンネルリスト ヘッダー固定表示
- 「💬 連絡板」ヘッダーをチャンネルリストパネル内のフロー要素として配置
- `display: flex; flexDirection: column` で親パネルを構成
  - ヘッダー（`flexShrink: 0`）
  - スクロールエリア（`flex: 1; minHeight: 0; overflowY: auto`）
- `position: fixed` や `paddingTop` スペーサーを廃止し、flexレイアウトで自然に高さを確保
- 外側ルートdivに `boxSizing: 'border-box'` を明示（`height: 100vh + paddingTop: 60` が正確に 100vh 内に収まる）

#### 戻るボタン後のスクロールリセット
- チャンネルから ← で戻ったとき、チャンネルリストが末尾にスクロールしたまま表示される問題を修正
- `useEffect` で `showChannelList` が `true` になったとき `channelListRef.current.scrollTop = 0` を即時実行

### ⚠️ 注意事項
- `channelListPanel` は `{showChannelList && channelListPanel}` で条件レンダリングされている。`showChannelList=false` 時は DOM からアンマウントされ、再表示時は新規マウントになる
- 外側ルートdivの `boxSizing: 'border-box'` は必須。省略すると `height: 100vh + paddingTop: 60` で合計 `100vh + 60px` になりはみ出す
- メッセージエリアの `paddingTop: 110` は別の固定ヘッダー（チャンネル名ヘッダー）のためのもので変更不要

### 🔜 次回タスク（2026-06-14 セッション3 終了時点）
1. **残業申請フォーム（パート用）** ← 最優先
2. **タブ・機能の表示権限管理画面**
3. **UI/UX改善**（コードレビュー高優先項目）
4. **gcal-sync 失敗時リトライキュー**（低優先）
---

## ✅ 2026-06-15 連絡板リニューアル 設計確定・軽微修正 完了

### 変更ファイル
- `client/src/pages/BoardPage.tsx`

### 変更内容

#### スクロール修正
- メッセージ履歴の `scrollIntoView({ behavior: 'smooth' })` → `behavior: 'instant'` に変更
- チャンネル開いた瞬間に最下部へ瞬間移動（スクロールアニメーションが見えていた問題を解消）

#### グループ名の切れ修正
- チャンネルリストのグループ名 `maxWidth: 130`（固定幅で切れていた）→ `flex: 1`（残り幅を使う）に変更
- 「マネージャー・リーダー」が切れずに表示されるようになった

---

## 📋 連絡板リニューアル 確定設計（2026-06-15）

次回セッションでこの設計を実装する。

### チャンネルリスト構成
```
📥 受信ボックス（届いたお知らせ）
📤 送信トレイ（送ったお知らせ）
⭐ お気に入り（ブックマーク済み）
──────────────（太線区切り）
👥 グループ（直近3件 ＋ 残りN件展開ボタン）
💬 DM（直近3件 ＋ 残りN件展開ボタン）
🔍 検索：ヘッダー右上ボタン（押すと入力欄出現）
```

### 受信ボックス
- リスト形式（1件ずつカード）・タップで全文表示
- フィルタータブ：すべて / 未対応 / 承認 / 回答 / 提出 / 読了
- アーカイブ機能あり（アーカイブ済みタブ）
- コメント許可ONの場合、カード下部に折りたたみでコメント表示

### 送信フロー（別ページ遷移・自動保存）
① 宛先選択（グループ / 個人）
② ⚙️ 件名・種別・期限・送信予約（全て任意・折りたたみ）
③ 本文入力
④ 送信
- 途中で閉じると自動で下書き保存

### 送信トレイ
- タブ：送信済み / 下書き
- 閲覧権限：本人＋役職単位で管理画面から設定可
- 取消・修正：本人＋管理者がいつでも可能・完全削除

### ⚙️ 設定パネル（任意・折りたたみ）
- 件名（任意入力）
- 種別：読了 / 回答 / 提出 / 承認（選択すると確認ボタンが付く）
- 期限日
- 送信予約（日時指定）
- コメント許可 ON/OFF

### 既読・対応状況
- メッセージ下部に「既読N ｜ 未読N」表示
- タップでモーダル（既読者名＋時刻 / 未読者リスト＋チェックボックス）
- リマインド送信：未読者を選択して再通知（送信者＋管理者のみ）
- リマインド済みバッジ表示
- 管理画面の設定でON/OFF切替可

### お気に入り
- グループ・DM・受信ボックス各メッセージに⭐ボタン
- ⭐押すとお気に入りセクションに追加

### 送信メール（現行）→ リニューアルで廃止
- 現行の個別DM自動生成を廃止
- 受信ボックス・送信トレイに統合

### DB変更予定
- `board_message_recipients` 中間テーブル新設（broadcast_recipients配列から移行）
- `board_favorites`（user_id, message_id）新設・ユニーク制約あり
- board_messages に `subject`（件名）・`comment_enabled`・`status`（draft/sent/cancelled）カラム追加
- board_channels の type: 'sent_mail' は段階的に廃止

### 実装フェーズ
1. DBスキーマ確定・マイグレーション
2. 受信ボックス → 送信フロー（下書き含む）→ 送信トレイ
3. お気に入り → 役職別閲覧権限 → 送信予約（Edge Function）
4. リマインド機能 → アーカイブ → 既読設定管理画面

### ⚠️ 注意事項
- 現行の `sent_mail` チャンネルと新設計の共存期間中は既存ロジックと混在しないよう注意
- リアルタイム購読はチャンネル数を増やさず1〜2本に絞る
- 送信フォームのステート管理は Context または Zustand を使う（propsバケツリレー禁止）
- スキーマ変更後は `supabase gen types typescript` を必ず実行

### 🔜 次回タスク（2026-06-15 終了時点）
1. **連絡板リニューアル実装**（上記フェーズ1から順に）← 最優先
2. **残業申請フォーム（パート用）**
3. **タブ・機能の表示権限管理画面**
4. **gcal-sync 失敗時リトライキュー**（低優先）

---

## ✅ 2026-06-15 連絡板リニューアル Phase1+2 実装完了

### 変更ファイル
- `client/src/pages/BoardPage.tsx`
- `client/src/components/admin/BoardSettingsTab.tsx`
- `supabase/migrations/20260616000000_board_inbox_refactor.sql`
- `supabase/migrations/20260616000001_board_channel_show_read_detail.sql`

### 実装内容

#### DBマイグレーション（Supabase手動実行済み）
- `board_messages` に `subject`・`comment_enabled`・`status` カラム追加
- `board_message_recipients` 中間テーブル新設（RLS付き）
- `board_favorites` テーブル新設
- `board_channels.show_read_detail` カラム追加（boolean → TEXT `'all'|'permitted'|'none'`）

#### RLS循環参照バグ修正
- 原因: `board_recipients_select_sender` が `board_messages` を参照 → `board_messages` RLS が `board_message_recipients` を参照 → 循環で500エラー
- 修正: Supabase SQL エディタで該当ポリシーを DROP

#### BoardPage.tsx 主な変更
- 通知設定ボタン復活（ヘッダー右端に配置）
- 検索バー展開時 `paddingTop: 92`（52固定でチャンネルが裏に隠れるバグ修正）
- チャンネル名フィルタ検索（デバウンス300ms）
- composeパネルを横並びレイアウト `[textarea][送信]` に変更
- 既読詳細表示を3択判定（`show_read_detail: 'all'|'permitted'|'none'`）
- ダークモードのラベル・input背景色改善

#### BoardSettingsTab.tsx 主な変更
- チャンネルごとの既読詳細表示3択ボタン（全員ON / 権限連動 / 全員OFF）
- 送信権限説明に「新規・リプライ両方」と明記
- `show_read_detail` の DB保存・読み込み対応

### 🔜 次回タスク（2026-06-15 夜 終了時点）
1. **メッセージ全文検索（DB ilike クエリ）** ← ユーザーが「２でやる」選択済み
   - searchResults state → searchMessages関数（ilike） → デバウンス → サイドバーに結果リスト → クリックでチャンネル移動
2. **残業申請フォーム（パート用）**
3. **タブ・機能の表示権限管理画面**
4. **gcal-sync 失敗時リトライキュー**（低優先）

---

## ✅ 2026-06-15 連絡板リニューアル Phase3 実装完了

### 変更ファイル
- `client/src/pages/BoardPage.tsx`
- `client/src/components/admin/LeaveRequestsTab.tsx`
- `client/src/App.tsx`

### 実装内容

#### 全文検索（BoardPage.tsx）
- `board_messages.body` に対して `ilike` クエリ（デバウンス300ms）
- チャンネルメッセージ（channel_id IS NOT NULL）と受信ボックス（channel_id IS NULL）を別クエリで取得・重複排除・マージ
- `highlightMatch()` でマッチ箇所を `<mark>` タグでハイライト
- `View` 型に `'search'` を追加、`viewTitle` にも対応

#### 受信ボックスUI改善（BoardPage.tsx）
- カード形式の一覧表示、タップで全文展開
- `INBOX_FILTERS` に `'archived'` タブ追加
- `loadArchived()` 関数追加（archived=true のメッセージを取得）
- `archiveMessage(msgId, archive)` 関数追加（board_message_recipients.archived を更新）
- `loadInbox` に `.eq('archived', false)` フィルター追加

#### コメント折りたたみ（BoardPage.tsx）
- `comment_enabled` が true のメッセージの詳細ビューにコメント欄を追加
- `inboxCommentOpen` / `inboxComments` / `inboxCommentBody` state 追加

#### Composeパネル改善（BoardPage.tsx）
- 「内容」「保存先」「URL」フィールドを追加（種別選択時のみ表示）
- 「場所」→「保存先」に統一
- `composeOptions` 初期値を `true`（最初から展開済み状態）
- 件名・種別パネルを最初から開いた状態に変更

#### 送信確認モーダル（BoardPage.tsx）
- チャンネルメッセージ・お知らせ両方でプレビュー形式の送信確認モーダルを実装
- 宛先を全員タグ表示（10人以上は「▼ もっと見る」で折りたたみ）
- `showComposeSendConfirm` / `showAllRecipients` state 追加

#### 有給奨励日 2段階送信確認（LeaveRequestsTab.tsx）
- 「内容を確認して送信」ボタンで確認モーダルを表示してから送信
- 対象者タグ表示（10人以上は折りたたみ）
- `showEncConfirm` / `showAllEncTargets` state 追加

#### 連絡板ボタンTOPリセット（App.tsx / BoardPage.tsx）
- `navTo` 関数で同パスの場合 `window.dispatchEvent(new CustomEvent('board-reset'))` を発火
- BoardPage に `resetToTop` コールバック + `board-reset` イベントリスナーを追加
- タップでチャンネル・詳細・検索をすべてリセットし受信ボックストップに戻る

#### スマホ戻るボタン対応（BoardPage.tsx）
- 内部状態変化時（チャンネル選択・詳細表示等）に `history.pushState({ boardInternal: true }, '')` を積む
- `popstate` ハンドラーで段階的にリセット（thread → inboxDetail → outboxDetail → selectedChannel → view）
- `e.state?.boardInternal` が true のときのみ処理（外部遷移には干渉しない）

### ⚠️ 注意事項（JSX構文）
- JSX属性の onClick 内でセミコロン区切り複数文は構文エラーになる
  - ❌ `onClick={() => setA(false); setB(false)}`
  - ✅ `onClick={() => { setA(false); setB(false); }}`
- スタイル内の余分なシングルクォート（`gap: 4'`）も構文エラー → `gap: 4` に修正

### 🔜 次回タスク（2026-06-15 終了時点）
1. **送信の取消・修正・完全削除**（本人＋管理者）
2. **残業申請フォーム（パート用）**
3. **タブ・機能の表示権限管理画面**
4. 送信トレイ宛先表示（BoardPage.tsx:2034）も10人以上折りたたみ化

---

## ⚠️ 既知バグ・トラブル事例（2026-06-16）

### 🔴 ReactDOM.createPortal + mousedown outside-click ハンドラの競合

**症状：** BellIcon（通知ドロップダウン）や AvatarMenu（ログアウトメニュー）の内部ボタン（✕・ログアウト）を押しても何も起きない。

**原因：**
`ReactDOM.createPortal` でドロップダウンを `document.body` に挿入した後、
「外側クリックで閉じる」ハンドラが **ポータル内クリックを「外側」と誤判定** する。

```ts
// NG: ポータルは ref.current の外に挿入されるため contains() が false になる
const h = (e: MouseEvent) => {
  if (!ref.current?.contains(e.target as Node)) setOpen(false); // ← ポータル内も「外側」扱い
};
```

タップ → `mousedown` → `setOpen(false)` → ドロップダウンDOM削除 → `click` が届かない。

**修正方法：** ポータルの div に `portalRef` を付けて、mousedown ハンドラで両方チェックする。

```ts
const portalRef = useRef<HTMLDivElement>(null);

const h = (e: MouseEvent) => {
  const inside = ref.current?.contains(e.target as Node)
               || portalRef.current?.contains(e.target as Node);
  if (!inside) setOpen(false);
};

// ポータルの div に ref を付与
{open && dropRect && ReactDOM.createPortal(
  <div ref={portalRef} style={{ ... }}>
    ...
  </div>,
  document.body
)}
```

**実装済みコミット：** `1f4c0fd`（App.tsx: BellIcon・AvatarMenu 両方修正済み）

**教訓：** `createPortal` を使うときは、outside-click ハンドラが **ポータルの中身を認識できない** ことに注意。必ず `portalRef` でポータルの div も追跡すること。

---

## ✅ 2026-06-16 勤務変更申請（ShiftReportPage）実装完了

### 実装したファイル

| ファイル | 内容 |
|---|---|
| `client/src/pages/ShiftReportPage.tsx` | 新規作成（メインページ） |
| `client/src/App.tsx` | ルート追加・ナビボタン追加 |
| `client/src/hooks/useAuth.ts` | `フロア責任者` を APPROVER_ROLES に追加 |
| `supabase/migrations/20260616200000_create_shift_reports.sql` | テーブル作成・RLS |
| `supabase/migrations/20260616210000_add_tardiness_type.sql` | 遅刻（tardiness）種別追加 |

### 機能概要

- **対象**: パート・アルバイト（パート以外のスタッフはページ非表示）
- **申請種別**: 残業（overtime）・早退（early_leave）・遅刻（tardiness）・欠勤（absence）
- **タブ構成**: 申請 ┃ 履歴
- **フォーム**:
  - 単日カレンダー選択（休暇申請と同じスタイル）
  - 通常シフト（勤務地・時間・「もともと休みの日」チェック）
  - 実際の勤務（勤務地・時間）
  - 休憩/実労働 自動計算（スプレッドシート式ロジック）
  - 勤務地は workplaces ドロップダウン + 「その他（自由入力）」
  - 確認依頼先ドロップダウン（自分選択 → 申請と同時に受理、管理者は非表示）
- **代行申請**: リーダー以上が対象スタッフ（パートのみ）を選択して申請可能
- **自己受理**: 申請者 = 確認依頼先のとき `status: 'confirmed'` で即受理
- **修正ボタン**: リーダー以上のみ表示（パートは修正不可）
- **ステータス**: pending（申請中）・resubmitted（再申請）・confirmed（受理済み）
- **履歴**: 給与期間（16日〜翌15日）でグループ化・開閉可能
- **承認ページへボタン**: リーダー以上のみ表示（オレンジ）
- **ダークモード**: 全要素対応済み

### DB テーブル: `shift_reports`

```
applicant_id / submitted_by / work_date / pay_period_start
application_type CHECK ('overtime','early_leave','tardiness','absence')
original_location / original_start / original_end
actual_location / actual_start / actual_end
break_minutes / labor_minutes
reviewer_id / status / confirmed_by / confirmed_at
```

- ユニーク制約: `(applicant_id, work_date)`
- RLS: 本人参照・代行INSERT・承認者UPDATE・全件SELECT（リーダー以上）
- `calc_pay_period_start(date)` SQL関数

### ルーティング
- パス: `/shift-report`
- ナビボタン: `⏰ 勤務変更`

### 注意事項（表示テキスト）
1. 残業・早退・遅刻・欠勤が発生した場合に申請してください。
2. 出勤する校の担当のリーダー・マネージャー（スタッフ）を選択してください。
3. 受理されると「受理済み」に変わります。
4. 間違えた場合は、担当のリーダー・マネージャー（スタッフ）にお知らせください。

### ⚠️ Supabase への手動適用が必要

SQL Editor で以下を順番に実行:
1. `supabase/migrations/20260616200000_create_shift_reports.sql`
2. `supabase/migrations/20260616210000_add_tardiness_type.sql`

---

### 🔜 次回タスク（2026-06-16 終了時点）

1. **管理画面「勤務変更申請」タブ** ← 最優先（承認・確認・設定）
2. **連絡板 送信の取消・修正・完全削除**（本人＋管理者）
3. **タブ・機能の表示権限管理画面**
4. **忘れん坊通知①②③**（send-push Edge Function は完成済み・呼び出し側を実装）
5. **gcal-sync 失敗時リトライキュー**（低優先）

---

## ✅ 2026-06-17 役職・機能権限管理画面 改善完了

### 変更内容（`FeaturePermissionsTab.tsx`）

#### スタッフ割り当てモーダル追加
- 各役職行に **「X人」バッジ**（灰色チップ）を常時表示
- バッジをクリックするとモーダルが開き、その役職のスタッフ一覧を表示
- 各スタッフにドロップダウンで役職変更が可能（変更行はオレンジハイライト）
- 変更があるときのみ「✓ 保存する」（緑）が出現
- 保存後は `profiles.role_title` を更新 → 人数バッジも再集計

#### UX改善
- 「変更する」/「完了」/「キャンセル」/「保存する」ボタンを **ヘッダー右上** に移動（役職一覧・権限マトリクスの両セクション）
- フッターボタン廃止
- 管理者行の左揃えズレ修正：編集モード時に `width:14` のスペーサーを追加し、▲▼ボタンと役職名の位置を統一

#### 役職構成の変更（ユーザーが画面から操作）
- 「一般」→「正社員」に名前変更（37人が自動更新）
- 「パート」役職を有効活用（21人移行済み）
- 現在の役職: パート(21人)・正社員(11人)・フロア責任者(5人)・リーダー(4人)・マネージャー(6人)・社長(1人)・管理者(1人固定)

### 🔜 次回タスク（2026-06-17 終了時点）

1. **管理画面「勤務変更申請」タブ** ← 最優先（申請一覧・受理・管理者操作）
2. **連絡板 送信の取消・修正・完全削除**（本人＋管理者）
3. **忘れん坊通知①②③**（send-push Edge Function 完成済み・呼び出し側を実装）
4. **gcal-sync 失敗時リトライキュー**（低優先）

---

## ✅ 2026-06-17（後半） 勤務変更申請 管理機能・CSV出力・UI統一 完了

### 作業概要

#### ShiftReportsTab.tsx（管理画面タブ）全面リライト
- **テーブルレイアウト**に変更（休暇申請管理と同スタイル）
- 列構成: 申請日 / 申請者 / 種別 / 勤務日 / 勤務地 / 理由・備考 / 確認状況 / 操作
- **確認待ち行**：黄色左ボーダー＋薄黄背景でハイライト
- **バッジ展開**:
  - `resubmitted` → 青 `▶ 再申請` → クリックで履歴展開
  - `returned` → 赤 `▶ 差戻し` → クリックで履歴展開
  - その他受理済み等 → 灰色 `▶ 修正履歴`
- **確認状況バッジ**: 確認者名（小字）＋ステータス（太字）の色付きバッジ
- **操作ボタン**: 確認待ち→「受理」、差戻し可能→「差戻」、全行→「削除」
- **差戻しモーダル**: コメント任意入力・本人へ通知
- **ソート**: 申請日（デフォルト新着順）/ 勤務日 / 申請者名・昇降順トグル
- **クリアボタン**: ソート＋全フィルタを一括リセット
- **代行申請バッジ**: `submitted_by ≠ applicant_id` のとき紫バッジ「代行：○○」表示
- **フィルタ**: ステータス（すべて/確認待ち/受理済み/取消済み）/ 給与期間 / グループ / 申請者 / 種別
- **デフォルト**: 「すべて」を初期選択

#### CSV出力機能（両タブ）
- **ShiftReportsTab**: 給与期間セレクト OR カスタム日付範囲で出力
  - 列: 申請日・申請者・代行者・種別・勤務日・勤務地・開始〜終了・労働時間(分)・休憩時間(分)・理由・確認者・ステータス
  - ファイル名: `勤務変更申請_〇〇年〇月給与分.csv`
- **LeaveRequestsTab**: 年度（4月〜翌3月）OR カスタム日付範囲で出力
  - 列: 申請日・申請者・種別・休暇日・日数・理由目的・第一承認者・第二承認者・ステータス
  - ファイル名: `休暇申請_〇〇年度.csv`
- BOM付きUTF-8（Excel文字化けなし）

#### ページタイトルフォントサイズ統一（全ページ 20px）
| ページ | 変更前 | 変更後 |
|---|---|---|
| 📍 出張報告 | h2デフォルト(≈24px) | **20px** 明示 |
| ⏰ 勤務変更申請 | 18px | **20px** |
| 🌿 休暇申請 | 18px | **20px** |
| 📅 休暇カレンダー | 22px | **20px** |
| 🚃 交通費申請 | 22px | **20px** |

#### その他UI調整
- ShiftReportPage: 絵文字を単独行から `⏰ 勤務変更申請` インラインに変更
- LeaveRequest: `🌿 休暇申請` タイトルをタブボタンの上に移動（フォーム内のh2重複削除）
- CSV出力ボタン: タイトル・説明文の下・右端に配置（両タブ共通）

### 適用済みDBマイグレーション
- `20260617500000_add_cancel_policy_to_shift_reports.sql`（取消RLSポリシー）
- `20260617600000_add_returned_status_to_shift_reports.sql`（returned ステータス追加・申請者再申請RLS更新）

### コミット
- `ffac228` feat: 管理画面テーブル化・CSV出力・ソート・代行表示・タイトル統一
- `49ef194` fix: 未使用変数TypeScriptビルドエラー修正

---

---

## ✅ 2026-06-17〜18 勤務変更申請 複数種別・早出追加・管理画面改善 完了

### 変更内容

#### 種別を複数選択チェックボックスに変更（ShiftReportPage.tsx）
- `type ApplicationType = 'overtime' | 'holiday_work' | 'early_leave' | 'tardiness' | 'absence' | 'early_start'`
- `application_types: ApplicationType[]` フィールド追加（`application_type` と後方互換維持）
- `TYPE_INFO` に `early_start: { label: '早出', color: '#0891b2', emoji: '🌅' }` 追加
- `toggleType()` で排他ロジック実装:
  - 欠勤(absence) ↔ 他全種別（欠勤単独のみ許可）
  - 早出(early_start) ↔ 遅刻(tardiness)
  - 残業(overtime) ↔ 早退(early_leave)
- チェックボックスを3グループで表示: 「休日出勤・欠勤」/ 「出勤時」/ 「退勤時」
- 初期値 `[]`（何も選択なし）

#### DBマイグレーション（Supabase SQLで手動適用済み）
- `supabase/migrations/20260617700000_add_application_types_and_early_start.sql`
  - `application_type` CHECK制約に `'early_start'` 追加
  - `application_types text[] NOT NULL DEFAULT '{}'` カラム追加
  - 既存レコードを `application_types = ARRAY[application_type]` に移行

#### グループフィルター修正（ShiftReportPage.tsx / ShiftReportsTab.tsx 両方）
- 旧: 勤務地ベース（`courseSchoolMap` 経由）
- 新: 申請者の `profiles.group_names` ベース
- グループ選択肢: `master_options` テーブルの `category='shift_report_group'` から取得
  - こども / 大人 / 管理部 の3グループのみ
- DBマイグレーション: `20260617800000_add_shift_report_groups.sql` 適用済み

#### 管理画面タブ改善（AdminPanel.tsx / AdminPanelContext.tsx）
- タブを2段レイアウトに変更:
  - ROW1（申請系4つ）: 🚃 交通費 / 📍 出張報告 / 🌿 休暇申請 / ⏰ 勤務変更
  - ROW2（管理系7つ）: 👤 ユーザー / 👥 グループ / 📋 リーダー / 📊 レポート / 🔔 通知設定 / 📨 連絡板設定 / 🔐 権限管理
- `承認管理` → `🚃 交通費` に改名（ApprovalsTab.tsx のタイトルも「🚃 交通費申請一覧」に変更）
- スマホはセレクトボックス（変更なし）

#### タブレイアウト崩れ修正（App.css / AdminPanel.tsx / AdminPanelContext.tsx）
- `App.css`: `.admin-tabs-pc` に `flex-direction: column` 追加（ROW1/ROW2が横並びになるバグ修正）
- `AdminPanel.tsx` `rowStyle`: `flexWrap: 'nowrap'`、ROW2は `overflowX: 'auto'`
- `AdminPanelContext.tsx` `tabStyle`: `whiteSpace: 'nowrap'`・`flexShrink: 0` 追加、padding/fontSize 小さく調整

### 適用済みDBマイグレーション
- `20260617700000_add_application_types_and_early_start.sql`
- `20260617800000_add_shift_report_groups.sql`

### ⚠️ 注意事項
- `application_types` (text[]) が主フィールド。`application_type` は後方互換で残しているが新規レコードは `application_types` を使う
- `shift_report_group` の選択肢はこども・大人・管理部の3つのみ（`master_options` テーブルで管理）
- ShiftReportsTab.tsx の `fetchLeaderAssignments` と `LeaderAssignment` 型は削除済み（groupベースに変更したため不要）

### コミット
- `2857043` feat: 勤務変更申請 複数種別・早出・グループフィルター・管理タブ改善

---

---

## ✅ 2026-06-18 連絡板 大幅機能追加 完了

### 適用済みDBマイグレーション（Supabase SQLで手動実行済み）
```sql
ALTER TABLE board_messages ADD COLUMN outbox_hidden boolean DEFAULT false;
ALTER TABLE board_messages ADD COLUMN cc_user_ids text[] DEFAULT '{}';
```

### 変更内容

#### 宛先選択UI（BoardPage.tsx）
- グループクイック選択ボタン追加（全員/正社員/パート/マネージャー・リーダー/こども/大人/管理部/全解除）
- スマートトグル: 全員押して別グループ → そのグループのみ選択、複数グループ同時選択も可
- 自分も宛先に選択可能（自分を選ぶと送信ボタンで別途通知送信なし）
- メンバー行にこども/大人/管理部のカラータグ表示（group_namesベース）

#### チャンネルメッセージ削除（BoardPage.tsx）
- ✏️ 編集ボタン完全削除（チャンネルは削除のみ）
- 🗑️ クリックで本文下にインライン確認パネル（赤枠）表示

#### お知らせ 修正・完全削除（BoardPage.tsx）
- 送信者 or 管理者が件名+本文をインライン修正可能（✏️修正する）
- 🗑️完全削除：board_confirmations / board_reads / board_message_recipients / board_messages を全削除
- 削除確認パネル: 「受信者全員の受信トレイからも削除されます。元に戻せません。」
- 送信トレイ・受信トレイ両方の詳細画面に修正/削除ボタン追加
- 成功/削除バナー表示（3秒後消滅）

#### CC代表者設定（BoardSettingsTab.tsx + BoardPage.tsx）
- BoardSettingsTab: 「📬 お知らせの自動CC（代表者設定）」セクション追加
  - ユーザー選択UIを雇用形態ヘッダー × 役職列グリッドに変更
  - `app_settings` テーブルの key='board_notice_cc_user_ids' に保存
- BoardPage 作成画面: ⚙️設定内に「他の代表者の送信履歴に加える」チェックボックス
  - CC設定済みのときのみ表示、送信予約の下に同スタイルで配置
- CCユーザーは `board_message_recipients` に入れず `cc_user_ids` カラムに保存
  - CC受信者は受信トレイではなく**送信トレイ**に届く
  - `loadOutbox` で cc_user_ids に自分のIDを含むメッセージも取得してマージ

#### 送信トレイ アーカイブ機能（BoardPage.tsx）
- タブ: 送信済み / 予約済み / 下書き / **📦 アーカイブ** の4タブ構成
- 送信済みリスト: 各カードに 📦 ボタン → 即座にアーカイブ（確認なし）
- 詳細画面: 📦アーカイブ / 🗑️完全削除 の2ボタン
- アーカイブタブ:
  - チェックボックス選択 + 全て選択/外す
  - 「選択した X 件を削除」→ 確認パネル（受信者からも完全削除）
  - 一括削除ボタン（1ヶ月/3ヶ月/1年/すべて）で対象件数を選択 → 確認パネル
  - 📤 戻すボタン（送信済みタブに戻す）
- `outbox_hidden = true` でアーカイブ。loadOutbox で OR 分岐して取得

#### 受信トレイ アーカイブ チェックボックス（BoardPage.tsx）
- アーカイブタブのメッセージカードにチェックボックス追加
- 全て選択/外す バー
- 「選択した X 件を削除」→ 確認パネル表示
- 期間ボタン（1ヶ月/3ヶ月/1年/すべて）も確認パネル経由に統一
- `alert()` / `window.confirm()` を完全廃止

### コミット
- `78df90d` feat: 連絡板 宛先選択改善・お知らせ修正削除・CC代表者設定・送信トレイアーカイブ機能追加

---

## ✅ 2026-06-18 ツールチップ・アーカイブアイコン改善 完了

### 変更内容（BoardPage.tsx）

#### ツールチップ追加（マウスホバーで説明表示）
- チャンネルメッセージ ☆ボタン → `title="お気に入りに追加 / お気に入り解除"`
- チャンネルメッセージ 🗑️ボタン → `title="削除"`
- チャンネルリスト 🗑️ボタン → `title="削除"`
- 受信トレイ ☆ボタン → `title="お気に入りに追加 / お気に入り解除"`
- 受信トレイ アーカイブボタン → `title="アーカイブ"` / `title="受信トレイに戻す"`
- 送信トレイ一覧 アーカイブボタン → `title="アーカイブ"`（既存）
- 送信トレイ詳細 アーカイブボタン → `title="アーカイブ"` 追加

#### アーカイブアイコン変更（📦絵文字 → SVG）
- `ArchiveIcon` コンポーネントを新規追加（box + 下向き矢印のSVG）
- 受信トレイ一覧・送信トレイ一覧・送信トレイ詳細・タブラベル 全箇所に適用
  - 受信トレイ タブ「アーカイブ」: SVGアイコン + テキスト
  - 送信トレイ タブ「アーカイブ」: SVGアイコン + テキスト
  - 一覧カードのアーカイブボタン: SVGアイコンのみ
  - 詳細画面のアーカイブボタン: SVGアイコン + テキスト

### コミット
- `c006445` feat: 連絡板 ツールチップ追加・アーカイブアイコンをSVGに変更

---

## ✅ 2026-06-22 連絡板 DM作成403修正・UI改善・グループ/DM送信ボタン 完了

### 🔥 最重要：DM作成が社長だけ403で失敗していた問題（根本原因と修正）

**症状**: 管理者はDM作成できるのに、社長など非管理者は「DM開始」を押しても作成できず403 Forbidden。

**根本原因**: DM作成は ①board_channels にINSERT → ②board_channel_members にメンバー追加、の2ステップ。
クライアントは①を `?select=*` 付きで実行するため、PostgRESTが挿入直後にその行を **SELECTで読み返す**。
しかし②のメンバー登録はまだ完了しておらず、`board_channels_select` ポリシー
（`id IN (自分がメンバーのchannel) OR admin`）に弾かれて403。管理者は `OR admin` の抜け道で通っていた。

**修正（適用済みSQL）**: SELECTポリシーに「自分が作成したチャンネルは読める」を追加。
```sql
-- 20260622010000_fix_board_channels_select_creator.sql（Supabaseダッシュボードで適用済み）
DROP POLICY IF EXISTS board_channels_select ON public.board_channels;
CREATE POLICY board_channels_select ON public.board_channels FOR SELECT TO authenticated
USING (
  id IN (SELECT channel_id FROM public.board_channel_members WHERE user_id = auth.uid())
  OR created_by = auth.uid()
  OR (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
);
```
- 併せて `20260622000000_force_board_channels_created_by.sql`（created_byをauth.uid()で強制するトリガー・適用済み）も追加したが、本命は上記SELECTポリシー修正。
- ⚠️ 教訓: PostgRESTの `INSERT ?select=*` は **INSERT(WITH CHECK)とSELECT(USING)の両方** を通過する必要がある。
  作成直後にまだ閲覧権限が無い行は読み返しで403になる → 作成者は created_by で常に読めるようにする。

### BoardPage.tsx 変更
- **リプライボタンを受信/送信トレイで非表示**: `renderMsg` は連絡板とお知らせ共通描画のため、
  リプライUIがお知らせにも漏れていた。`msg.channel_id` がある（=チャンネル/DM）時のみ表示に修正。
- **DM作成の自動リトライ**: `insertBoardChannel` ヘルパー追加（403時に refreshSession して1回リトライ）。
  startDM/sendBroadcast に適用。失敗時は赤枠エラー表示・ボタンは「作成中...」でロック。
- **ヘッダー高さ揃え**: 左「連絡板」と右チャンネルヘッダーを両方 `height: 56` 固定（右の2行テキストは
  `lineHeight: 1.2`）。下のコンテンツ余白も52→56に統一。
- **border/borderLeft 混在の警告解消**: 受信トレイカードを4辺個別指定に変更。
- **ボタン文言・権限表示**:
  - 上部「＋送信」→「＋お知らせ送信」（通知設定は🔔アイコン化してPC2段折返し解消）
  - グループ欄に「＋グループ作成」ボタン（管理者 ＋ 設定で選ばれた人 ＋ 未設定ならCC代表者）
  - DM欄「＋」→「＋DM送信」ボタン（DM送信権限を持つ人に表示）

### BoardSettingsTab.tsx 変更
- 「👥 グループを作成できる人」設定セクションを新設（CC代表者設定と同じチェックボックスUI）。
  - 保存先: `app_settings` の `board_group_create_user_ids`（特定ユーザーIDの配列）
  - 未設定の場合は「お知らせ自動CCの代表者」と同じ人がグループ作成可（BoardPage側でフォールバック）

### DMの仕様メモ（確認事項）
- DM送信モーダルは複数選択可。**1人＝1対1のDM、複数＝一斉送信**（選んだ人それぞれに個別DMを配信。グループDMではない）。
- 選択UIは既に「名前検索＋雇用形態別の一覧チェックボックス」になっている。

### コミット
- `d5ab5fb` fix: 連絡板 DM作成403修正・UI改善・グループ/DM送信ボタン追加

---

## ✅ 2026-06-22 受信トレイ「未読」フィルター追加 完了

### 変更内容（BoardPage.tsx）
- 受信トレイのフィルタータブに「未読」を追加（すべて / **未読** / 未対応 / 読了 / 回答 / 提出 / 承認 / アーカイブ）
  - `inboxFilter` 型に `'unread'` を追加・`filteredInbox` に `!inboxReadIds.has(m.id)` の分岐を追加
- 受信トレイの赤い未読バッジ（件数）をクリック → 受信トレイを開いて「未読」フィルターON（未読だけ表示）
  - バッジに `onClick`（`e.stopPropagation()` で行クリックと分離）・`title="未読だけ表示"`
- 受信トレイ行クリック時は `setInboxFilter('all')` でリセット
- 未読0件時は「未読のお知らせはありません」を表示

### コミット
- `5b399a6` feat: 連絡板 受信トレイに「未読」フィルター追加

---

## ✅ 2026-06-22 出張報告 削除修正・絞り込み / 機能の公開段階リリース 完了

### 1. 出張報告が削除できない問題の修正（RLS）
- 症状: 管理画面で出張報告の「削除」を押しても消えない（エラーも出ない）。
- 原因: `business_trip_reports` に **DELETEポリシーが1つも無かった**。
  RLSは「許可ポリシーの無い操作は全拒否」のため、DELETEは0行削除で成功扱い→再取得で残る。
- 修正(適用済みSQL): 管理者のみ削除できるDELETEポリシーを追加（本人削除は不可の方針）。
  ```sql
  CREATE POLICY "Admins can delete all reports" ON public.business_trip_reports
    FOR DELETE TO authenticated
    USING (((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = 'admin'::text);
  ```
  migration: 20260622020000_add_trip_reports_delete_policy.sql
- ⚠️ DM作成403と同じ「RLSポリシー欠落」系。削除/更新が無反応のときはまずRLSのcmd別ポリシーを疑う。

### 2. 出張報告一覧に絞り込み追加（TripReportsTab.tsx）
- 種別ボタン（すべて/到着/終了）に加え、ドロップダウン3つを追加:
  🏷️ 区分（category）/ 👤 報告者（profiles.name）/ 📍 場所（location）
- 4条件を組み合わせて絞り込み可。「絞り込み解除」ボタンあり。

### 3. 機能の段階リリース（公開/非公開 + リーダー以上 先行公開）
管理画面「機能別 表示権限」に列を2つ追加し、メニュー表示を制御。
- 🟢 全公開: ON=全員表示 / OFF=管理者以外に非表示
- 🔵 リーダー以上: ON=リーダー以上だけに先行表示（全公開OFF時に有効）
- 表示判定: `isAdmin || 全公開!==false || (リーダー以上===true && ユーザーがリーダー以上)`
  - リーダー以上 = リーダー・マネージャー・フロア責任者・社長・管理者（LEADER_PLUS_ROLES）
- 保存先(app_settings): `feature_published` / `feature_published_leader`（どちらも {feature_key: bool}）
  - 値が無いキー: 全公開=true扱い / リーダー以上=false扱い
- 新規フック: client/src/hooks/useFeaturePublished.ts（NavBarで使用）
- NavBar(App.tsx)の各メニュー（交通費/出張報告/休暇/カレンダー/勤務変更/連絡板）を isPub() で出し分け

#### 運用（7月リリース予定）
- 7/1: 交通費・出張報告を全公開ON（他は非公開のまま）
- 7/16: 残り（休暇・カレンダー・勤務変更・連絡板）を全公開ON
- 手動切替（日付自動化なし）。先行確認したい機能はリーダー以上ONにする。

### コミット
- `85dc20b` feat: 出張報告 削除修正・絞り込み追加 / 機能の段階リリース（公開・リーダー以上）

---

## ✅ 2026-06-23 出張報告フォーム文言修正・交通費注意書き改善 完了

### 1. 出張報告フォーム（BusinessTripReport.tsx）
- **区分「イベント下見」→「イベント（下見）」にリネーム**
  - 区分の選択肢は **コードではなく Supabase `master_options`（category='trip_category'）** から取得している点に注意。
  - 本番DBは下記SQLで更新済み（適用済み）:
    ```sql
    UPDATE master_options SET value = 'イベント（下見）'
    WHERE category = 'trip_category' AND value = 'イベント下見';
    ```
  - コード側のフォールバック初期値も `下見` → `イベント（下見）` に修正。
- **「次回（次月）予定」の下に補足テキストを追加**（小さめ・グレー）:
  「※当日決まった予定がある場合は選択してください。/ あわせて、Googleカレンダーにも入力してください。」
- **Slack送信先チャンネルの説明文を差し替え**:
  「※ 選択しない場合は送信されません」→「（選択しない場合、Slackには送信されません。）」
  さらに薄黄色の案内ボックスを追加（●終了報告/責任者のみSlack送信/送信先=出張後に向かう校・直帰は所属チーム/責任者以外は送信不要）。

### 2. 交通費申請フォーム（ExpenseForm.tsx）
- 黄色い注意ボックスを **⚠️中央＋●箇条書き左揃え** のレイアウトに変更（項目が3つに増えたため可読性優先）。
  - ⚠️マークは中央寄せの見出し風（`textAlign:'center'`）
  - ●3行は左揃え（親要素から継承される中央寄せを `textAlign:'left'` で打ち消し）
  - 追加項目: 「定期券は原則6か月定期（入社6か月未満は3か月定期）」「磁気定期はIC定期へ切り替え」
- ⚠️ 教訓: 中央寄せにならない/勝手に中央寄せになる時は、**親要素の textAlign 継承**を疑う。

---

## ✅ 2026-06-23 依存パッケージの脆弱性対応・GitHub Dependabot有効化 完了

### 背景
- `git push` 時にGitHubから「16 vulnerabilities（high8/moderate8）」の警告が表示されるようになっていた
- 7/1の本番公開を控えており、ユーザーから「気になるので今すぐ対応して」と依頼

### 1. npm audit で依存パッケージを更新
- **root**: `npm audit fix` で7件解消（express/body-parser/qs/minimatch/picomatch/path-to-regexp/brace-expansion）
- **client**: `npm audit fix` で1件解消（@babel/core）
  - 残り1件（esbuild、low severity・Windows開発サーバーのみに影響・本番には無関係）は
    **Vite 7→8のメジャーアップグレードが必要**と判明
- ユーザー確認の上、Vite 7→8・`@vitejs/plugin-react` 4→6 にアップグレード
  - `npm run build`（本番ビルド）・`npm run dev`（開発サーバー起動＋HTTP 200確認）の両方で動作確認済み
  - root/client ともに `npm audit` で **0 vulnerabilities** に
- コミット: `8e456bb`

### 2. 不要な `backup_temp` フォルダを削除
- 約1年前（2025-07-12）、別のバックアップから一時的にコピーされて消し忘れられていたフォルダが
  Gitに紛れ込んでいた（`backup_temp/client/...`）
- 中の古い `package-lock.json` がGitHubの脆弱性カウントに加算されていた一因と判明
- 削除前に確認した安全性:
  - `vite.config.ts` / `tsconfig.json` / `client/vercel.json` のどこからも参照されていない
  - 中の `.env` はSupabaseのローカル開発用デモキー（公開情報・実害なし）
  - 経緯は `.claude.json`（Claude Codeの過去作業ログ）に記録あり（ログイン画面不具合調査で一時コピーしたもの）
- 削除後も `npm run build` が正常に通ることを確認
- コミット: `ab75724`

### 3. GitHub Dependabot を有効化（ユーザー操作）
- 原因判明: リポジトリの **Dependabot alerts機能自体が無効（inactive）** だったため、
  上記の修正がGitHub側の表示に反映されていなかった（push時の「16件」は古いキャッシュ表示）
- Settings → Code security → **Dependency graph を Enable**（読み取り専用の依存解析。コードの変更権限は付与しない）
- 続けて **Dependabot alerts も Enable**
- 結果: Security and quality ページで **「0 Open / 16 Closed」** に更新（過去の16件はすべて解決済みとして記録）
- ⚠️ 今後また新しい脆弱性が見つかった場合は、このDependabotが自動でPRやアラートで知らせてくれる状態になった

---

## ✅ 2026-06-23 休暇カレンダー（スマホ版）丸印の色分け改善 完了

### 背景
- スマホ版休暇カレンダー（`/calendar`）の日付下の丸印が、全欠勤・遅刻・早退・遅出調整・早退調整すべて同じ赤1色で表示され、種類が見分けられなかった
- ユーザーと相談し、3色で意味を分ける案（案A）を採用

### 変更内容（`client/src/pages/CalendarPage.tsx` の `SpCalendar` コンポーネントのみ）
- 🔴 赤＝全欠勤・休暇（申請中／受理済みの区別は廃止しシンプルに統一）
- 🟠 オレンジ＝遅刻・早退
- 🟢 緑＝遅出（調整）・早退（調整）
- **PC版（`PcCalendar`）は対象外・変更なし**（名前＋種類別ラベル表示は従来通り）

### 実装ロジック（L673-690付近）
```ts
const hasRed = events.length > 0 || absences.some(a => a.type === 'absent');
const hasOrange = absences.some(a => a.type === 'late' || a.type === 'early_leave');
const hasGreen = absences.some(a => a.type === 'late_start' || a.type === 'early_end');
```

### 確認内容
- `npx tsc --noEmit` エラーなし
- `npm run build` 成功（本番ビルド確認済み）
- ⚠️ fivem-portalはClaude Codeのプライマリ作業ディレクトリ外にあるため、`preview_start`（ブラウザ自動確認ツール）では起動できなかった。今後ブラウザでの実機確認が必要な変更の場合は、ユーザーに `npm run dev` でのローカル確認を依頼すること。
- コミット: 本コミットに含む

---

## ✅ 2026-06-24 連絡板予約送信の不具合修正・役職データ整理・新規登録の承認制 完了

### 1. 連絡板「予約送信」の不具合修正
- `board-scheduled-send` Edge Function を atomic UPDATE に変更（cron多重起動時の二重通知を防止）
- 送信トレイ：送信済みタブに「📅予約送信済み」バッジ、予約済みタブに予約時刻を表示
- 送信予約の日時ピッカーの `min` 属性が UTC基準になっていたバグを修正（JSTでは実際より9時間前まで過去日時が選べてしまっていた）→ `localDatetimeMin()` ヘルパーを追加
- pg_cronで `board-scheduled-send` を5分間隔実行するSQL追加（`20260624000000_schedule_board_scheduled_send_cron.sql`、Vaultの`service_role_key`必須）
- 「他の代表者の送信履歴に加える」チェックボックスは、送信者本人が代表者リストに含まれる場合のみ表示・役職プレビュー中は非表示に変更

### 2. 役職プレビュー機能のバグ修正
- プレビュー中でも `canSendInChannel`/`canStartDM` がログイン中の本物の管理者の役職を見て判定していたため、どの役職をプレビューしても「送信できる」になってしまっていた → `roleTitle`/`employmentType`（プレビュー反映済みの値）を使うように修正

### 3. 役職データの整理（重要・本番DB変更）
- `roles`テーブル（機能別表示権限のマスタ）の「正社員」という行は、元々「一般」だったものの誤表記だったため `一般` に統一
- `profiles.role_title` が「正社員」になっていた11人を `一般` に統一（雇用形態と役職が同じ文字列で重複していたミス）。「パート」×「パート」の21人はパート専用の権限tierとして意図された設計のため変更なし
- `master_options`（ユーザー管理画面の役職セレクトの選択肢マスタ）に「パート」が登録されていなかったため追加（フロア責任者は登録済み）
- `UsersTab.tsx`の雇用形態・役職セレクトに「選択肢にない値が保存されている場合は赤枠で警告表示」を追加（同種のズレの再発に気づけるように）

### 4. セキュリティ：新規登録の承認制を実装
- **発見した問題**：ログイン画面の「新規登録」フォームが、誰でもメール+パスワード+名前だけでアカウントを作成でき、即座に`is_active=true`でフルアクセスできる状態だった（実際に身元不明の「peach」というアカウントが作成されていた）
- `profiles`に`approval_status`列追加（既存ユーザーは`approved`のまま）
- `handle_new_user`トリガーを変更：新規登録時は`is_active=false`・`approval_status='pending'`で作成し、`new-signup-notify` Edge Functionをpg_net経由で呼び出す
- `new-signup-notify`（新規）：管理者へベル通知＋経理Slackへの通知を送信
- ログイン画面：承認待ち中は「ご登録ありがとうございます。管理者の承認をお待ちください。」と表示してログインをブロック
- ユーザー管理画面：「🆕 承認待ちの新規登録」パネルを追加。雇用形態・役職をその場で設定して承認、または拒否ができる
- **peachさんのアカウントは今回未対応のまま**（ユーザー判断待ち。退職処理または削除を検討）

### マイグレーション・Edge Function
- `supabase/migrations/20260624000000_schedule_board_scheduled_send_cron.sql`
- `supabase/migrations/20260624100000_add_signup_approval.sql`
- `supabase/functions/new-signup-notify/index.ts`（デプロイ済み）
- `supabase/functions/board-scheduled-send/index.ts`（atomic化、再デプロイ要）

### 5. 削除済みユーザーがログイン可能だった不具合の修正（追加対応）
- **発見した問題**：ユーザー管理の「完全に削除」ボタンが`profiles`テーブルのみ削除しており、`auth.users`（ログイン認証の元データ）が残っていたため、削除後もログインできてしまっていた
- `delete-user` Edge Function新規作成（管理者チェック付き、`auth.admin.deleteUser()`で削除。`profiles`はON DELETE CASCADEで連動削除）→ デプロイ済み
- `AdminPanelContext.tsx`の`handleDeleteUser`をこのEdge Function経由に変更
- 過去にテストで`profiles`だけ削除され孤立していた`auth.users`（nisijin68@yahoo.co.jp）をSupabaseダッシュボードから削除済み
- **おまけ対応**：Supabase Authダッシュボードの「Display name」欄が全員「-」だった件 → `create-user` Edge Functionで`user_metadata: { full_name: name }`を渡すよう修正（デプロイ済み）。既存ユーザーは`profiles.name`から一括反映するSQLを実行済み
- peachさんのアカウントは今回も**未対応のまま**（ユーザー判断待ち）

### 🔜 次回タスク（2026-06-24 最新）

1. **peachさんアカウントの処置を決める**（退職にする／削除する）
2. **忘れん坊通知①②③**（send-push Edge Function 完成済み・呼び出し側を実装）
   - ① 未回答リマインド: お知らせの期限1日前・当日に未回答者へ send-push
   - ② 定期リマインド: 毎月〇日に指定グループへ自動通知（Supabase Cron + send-push）
   - ③ 確認ボタン: 重要連絡に「確認しました」ボタン → 未確認者を管理者が把握・一括リマインド
3. **gcal-sync 失敗時リトライキュー**（低優先）
4. ★7月リリースの公開操作（手動：管理画面→機能別 表示権限）
   - 7/1 : 交通費・出張報告を「全公開」ON
   - 7/16: 残り（休暇・カレンダー・勤務変更・連絡板）を「全公開」ON
   - 先行確認したい機能は「リーダー以上」ONにする

### 6. 新規登録の承認待ち判定の競合状態（レースコンディション）を修正（追加対応）
- **発見した問題**：承認待ち(`is_active=false`)のアカウントでログイン（特にメール確認リンクから直接ログインするパターン）すると、`AuthContext`が承認チェック前に一瞬「ログイン済み」と判定してしまい、本来見えてはいけない画面が一瞬表示されたり、ブロック理由のメッセージが表示されないことがあった
- `AuthContext.tsx`に`is_active`/`approval_status`判定を一元化（`applySessionUser`関数）。`SignIn.tsx`単体の判定だけでは間に合わないため、認証状態が変わる全てのタイミング（初回読み込み・ログイン・メール確認リンクからの自動ログイン等）でこの判定を必ず通すように修正
- ブロック理由のメッセージを`AuthContext`の`blockedMessage`として保持し、`SignIn.tsx`はそれを表示するだけの役割に変更（「先にサインアウトされてメッセージが表示されない」競合を解消）
- `SIGNED_IN`イベント検知時は、承認チェックが完了するまで`loading=true`にしてアプリ全体を非表示にすることで、判定前の画面が一瞬でも見える可能性を防止
- **教訓**：認証状態に関わるアクセス制御は、画面個別（コンポーネント単位）ではなく`AuthContext`のような一元的な場所に必ず実装すること。`onAuthStateChange`は複数の経路（手動ログイン・メール確認リンク・トークン更新等）で発火するため、特定の画面のボタン処理だけでガードすると抜け道が残る

### ⚠️ 作業ルール（必読）
- **デプロイ（git push）はユーザーの指示があってから**
- **ローカル確認後にデプロイ指示を待つ**
- **`alert()` 禁止** → 成功時は緑カード（BannerSuccess / setSuccessMsg）を使用
- **`window.confirm()` 禁止** → インライン確認パネル（赤枠）を使用
- **Supabase クエリの `.catch()` 禁止** → `.then(null, () => {})` を使用（Supabase JS v2はnative Promiseではないため）
- **役職（role_title）と雇用形態（employment_type）は別軸** → 役職欄に雇用形態と同じ文字を入れない（「正社員」を役職に使わない。役職が無い人は必ず「一般」）
- **`master_options`（UsersTab選択肢）と`roles`テーブル（機能別表示権限）は別テーブル** → 役職を新設・変更する時は両方に反映する必要がある

---

## ✅ 2026-06-24（続き）連絡板の予約送信バグ修正・管理画面バッジ追加 完了

### 1. ビルドエラー修正
- 前回作業で発生していたTS6133（未使用変数）エラーを修正し、Vercelビルドが通るように対応
- `archiveBulkDeleting`セッター・`outboxArchiveConfirmId`・`editingId`/`editBody`・`saveEdit`関数・`bulkDeleteOutboxArchived`関数（いずれも死んだコード）を削除

### 2. 管理画面タブに承認待ちバッジを追加
- 休暇申請タブに承認待ち件数（status が `approved`/`rejected` 以外）の赤丸バッジを追加（交通費タブには追加しないよう指示あり）
- `AdminPanelContext.tsx`で`pendingLeaveRequests`を新規追加、初回マウント時に取得（タブを開かなくても件数がわかる）
- 2段目タブ行の`overflowX: 'auto'`がCSS仕様上`overflowY`も自動でクリップしてしまい、ユーザータブの承認待ちバッジ（数字）が上端で欠けて見えていた不具合を修正 → `paddingTop`+`marginTop`の相殺で解消

### 3. 連絡板「予約送信」が送信済みタブに移動しない不具合の根本原因を特定・修正
- **発見した問題**：`board-scheduled-send`を呼ぶcronジョブ（jobid 8）が既に存在していたが、Authorizationヘッダーの値が`<eyJhbGci...>`のように**山括弧がプレースホルダーのまま残っており**、毎分実行されては認証エラーで失敗し続けていた
- 正しい設定でjobid 9（5分間隔、Vaultのservice_role_keyを正しく参照）を新規登録し、壊れていたjobid 8は`cron.unschedule('board-scheduled-send')`で削除済み
- `board_messages`に`sent_at`列を追加（実際に送信された時刻）。即時送信時はフロント側でセット、予約送信は`board-scheduled-send`が実行時にセット
- 送信トレイ（送信者視点）：ヘッダーに「予約 6/24 8:00 → 送信 6/24 8:03」のように予約時刻と実際の送信時刻を両方表示
- 受信トレイ（受信者視点）：予約情報は表示せず、実際に届いた時刻（`sent_at`、無ければ`created_at`）のみ表示するよう`renderMsg`に`isOutboxView`引数を追加して分岐

### マイグレーション・Edge Function（すべて適用・デプロイ済み）
- `supabase/migrations/20260624200000_add_board_messages_sent_at.sql`（SQL Editorで実行済み）
- `supabase/functions/board-scheduled-send/index.ts`（`sent_at`セット追加、再デプロイ済み）
- pg_cron: jobid 9 `board-scheduled-send-every-5-min`が稼働中（壊れていたjobid 8は削除済み）

### 注意事項
- Vercel CLIのログインセッションが切れている（`vercel whoami` → Not authorized）。本番デプロイはGitHub push経由のVercel自動デプロイに依存している。CLIで直接デプロイしたい場合は事前に`vercel login`が必要
- `.claude/launch.json`を追加（preview_start用のdevサーバー起動設定）。Gitには含めない

### 4. 予約送信メッセージのベル通知が来ない不具合・受信時刻の表示崩れを修正（追加対応）
- **発見した問題①**：`board-scheduled-send` Edge Functionが`notifications`テーブルに**存在しない列名**（`body`/`type`/`is_read`）でinsertしていたため、cronが処理しても通知が一件も作成されていなかった
  - 実際の列名（`user_id`/`message`/`sub_message`/`read`/`source_type`/`reference_id`）に修正し再デプロイ済み
- **発見した問題②**：受信トレイの表示判定が「ブラウザの現在時刻 ≧ 予約時刻(`scheduled_at`)」というクライアント時計基準だったため、cronがDBを実際に更新する前に表示されてしまうことがあり、その場合`sent_at`が未確定で作成時刻（予約した時刻）にフォールバック表示されていた
  - 判定をDB側の`status`（cronが原子的に確定させた値）基準に変更（`m.status !== 'scheduled'`で受信トレイに出すかを判定）。これにより表示タイミングと`sent_at`の確定が必ず一致するようになった
- 変更ファイル：`client/src/pages/BoardPage.tsx`（`loadInbox`のフィルタ変更）、`supabase/functions/board-scheduled-send/index.ts`（通知insertの列名修正・デプロイ済み）
- コミット：`030d9e9`

### 5. 受信トレイ・送信トレイ一覧の時刻表示を送信時刻ベースに統一（追加対応）
- **発見した問題**：受信トレイ一覧・送信トレイ一覧（カードの先頭に出る時刻）が下書き作成時刻（`created_at`）を表示していたため、詳細画面で表示される実際の送信時刻（`sent_at`）とズレて見えていた（例：作成16:41・送信16:50なのに一覧は16:41のまま）
- 受信トレイ一覧（`BoardPage.tsx` 受信カード）：`msg.created_at` → `msg.sent_at || msg.created_at` に変更
- 送信トレイ一覧・送信済みタブ：送信済みタブのときだけ`sent_at`を優先表示（予約済みタブは予定時刻がまだ確定していないため作成時刻のまま）
- 送信トレイ・アーカイブ一覧：同様に`sent_at`優先に変更
- 送信トレイ詳細（チャット形式ヘッダー）：「予約 16:50 → 送信 16:50」という表記が、`scheduled_at`（送信予定時刻）を「予約」として表示していたため「予約操作をした時刻」と誤解されやすかった → 「予約作成 {created_at} → 送信済 {sent_at}」（未送信の場合は「予約作成 {created_at} → {scheduled_at}に送信予定」）に変更し、操作時刻と送信時刻を明確に分離
- 確認内容：`npx tsc --noEmit` エラーなし、`npm run build` 成功（本番ビルド確認済み）
- 変更ファイル：`client/src/pages/BoardPage.tsx`
- コミット：`9e47105`

### 🔜 次回タスク（2026-06-24 セッション終了時点・最新）
1. **Vault修正後の動作確認**：board-scheduled-sendのcron・new-signup-notifyが正しく動くか（次回cron実行時、または新規登録テストで確認）
2. **peachさんアカウント（pongketkorn15@gmail.com）の処置を決める**（退職にする／削除する。追跡は限界に達したため現状未削除）
3. **忘れん坊通知①②③**（send-push Edge Function 完成済み・呼び出し側を実装）
   - ① 未回答リマインド: お知らせの期限1日前・当日に未回答者へ send-push
   - ② 定期リマインド: 毎月〇日に指定グループへ自動通知（Supabase Cron + send-push）
   - ③ 確認ボタン: 重要連絡に「確認しました」ボタン → 未確認者を管理者が把握・一括リマインド
4. **gcal-sync 失敗時リトライキュー**（低優先）
5. ★7月リリースの公開操作（手動：管理画面→機能別 表示権限）
   - 7/1 : 交通費・出張報告を「全公開」ON
   - 7/16: 残り（休暇・カレンダー・勤務変更・連絡板）を「全公開」ON
   - 先行確認したい機能は「リーダー以上」ONにする

### ⚠️ 作業ルール（必読・再掲）
- デプロイ（git push）はユーザーの指示があってから。ローカル確認後にデプロイ指示を待つ
- `alert()` 禁止 → 成功時は緑カード（setSuccessMsg）
- `window.confirm()` 禁止 → インライン確認パネル（赤枠）
- Supabase クエリの `.catch()` 禁止 → `.then(null, () => {})` を使用
- 認証・アクセス制御は画面個別でなく必ず`AuthContext`のような一元的な場所に実装する（`onAuthStateChange`は複数経路で発火するため、個別画面のチェックだけだと抜け道が残る）
- 役職（`role_title`）と雇用形態（`employment_type`）は別軸。役職に雇用形態と同じ文字を入れない（無役職者は必ず「一般」）
- `master_options`（UsersTab選択肢）と`roles`テーブル（機能別表示権限）は別テーブル → 役職を新設・変更する時は両方に反映が必要

---

## ✅ 2026-07-02 Vault動作確認・GitHub秘密情報漏洩の緊急対応・通知バグ2件修正 完了

### 1. Vault修正後の動作確認（前回タスク1・完了）
- `board-scheduled-send`（5分毎cron）：直近の実行ログを`net._http_response`で確認 → 全て`status_code 200`、401エラー無し。正常稼働を確認
- `new-signup-notify`（新規登録通知）：`handle_new_user`トリガーの定義を確認 → Vaultの`service_role_key`を正しく参照する設定になっていた（実際の新規登録が無かったため実行ログでは未確認だが設定は正常）
- **ついでに発見**：`encouragement-notify-daily`・`remind-unread-daily`（別の毎日0時cron、「忘れん坊通知」機能用）が401/失敗していた。原因はVaultとは無関係で、呼び出し先URLが`<YOUR_PROJECT_REF>`というテンプレートのプレースホルダーのまま／古い認証方式のまま放置されていたため。次回タスク「忘れん坊通知①②③の呼び出し側実装」が未完了である証拠として記録

### 2. 連絡板：上部📨アイコンのバッジが予約中(未送信)メッセージもカウントしていた不具合を修正
- **原因**：`App.tsx`の`inboxUnread`集計が`board_message_recipients`テーブルの件数だけを見ており、`board_messages.status`（`scheduled`=未送信 / `sent`=送信済み）を見ていなかった。受信者レコード自体は「予約作成した瞬間」に作られるため、まだ送信されていない予約メッセージの分までバッジにカウントされていた
- 修正：`status='sent'`のメッセージだけを未読カウント対象にするようフィルタ追加
- 変更ファイル：`client/src/App.tsx`（L210-218）
- コミット：`da08995`

### 3. 🚨 重大セキュリティ対応：GitHub履歴に認証トークンが約1年間公開されていた問題
- **発見の経緯**：上記2の修正後、Vercelの自動デプロイが動かなくなっていることに気づき調査 → Vercel Hobbyプランは「組織所有のPrivateリポジトリ」からの自動デプロイに非対応と判明（7/1にfivem-portal他3リポジトリをPrivate化したことが原因）
- **調査の過程で発覚した本題**：リポジトリ内に`.claude/.credentials.json`（Claude CodeのOAuthアクセストークン・リフレッシュトークン）と`.local/share/com.vercel.cli/auth.json`（Vercel CLIの認証トークン）が**2025年7月12日から誤ってgit管理下にコミットされており、Privateにする前日(2026/7/1)まで約1年間Publicリポジトリとして世界中に公開されていた**
  - 他に`.claude.json`・`.cache/`・`.npm/`（53MBの巨大キャッシュ含む）・`.nvm/`も同様に誤って追跡されていた（ホームディレクトリでの`git add -A`等が原因と推測）
  - `client/.env`系のSupabase anon key・VAPID public keyは元々クライアントに公開される想定の鍵のため実害なしと判断
- **対応した内容**：
  1. ユーザー自身がPC上でClaude Codeをログアウト→再ログイン（漏洩トークンの無効化）
  2. `.gitignore`に`.claude/` `.claude.json` `.vercel` `.cache/` `.local/` `.nvm/` `.npm/`を追加、`git rm --cached`で追跡解除
  3. `git filter-branch --index-filter`で全523コミットの履歴から該当ファイルを完全削除（2回に分けて実施：`.claude`系→後から発覚した`.local`/`.cache`/`.npm`/`.nvm`系）
  4. `git push --force`でGitHub側の履歴を上書き（`.git`容量 236MB→2.7MBに削減）
  5. Vercel CLIトークンはVercelダッシュボードのTokens一覧で確認したところ、CLIトークンは短期間で自動失効・再発行される仕様のため、漏洩当時のものは既に自然失効済みと判断（個別Revokeは不要と判断）
- **再発防止策（このPC = `C:\Users\kohei`に導入済み・重要）**：
  - グローバル`.gitignore`：`C:\Users\kohei\.gitignore_global`（`git config --global core.excludesfile`で登録）。`.claude/` `.vercel` `.env` `.cache/` `.local/` `.nvm/` `.npm/` `*.pem` `*.key` `.ssh/` `.aws/`等を**全リポジトリ共通で**除外
  - グローバル pre-commit フック：`C:\Users\kohei\.git-hooks\pre-commit`（`git config --global core.hooksPath`で登録）。上記パターンに一致するファイルを含むコミットを自動ブロック（動作確認済み）
  - **⚠️ 自宅PC等、別のパソコンには反映されていない**（パソコン単位のローカル設定のため）。新しいPCで作業する前に必ず同じ設定を入れること
- **リポジトリ最終状態**：セキュリティ対応完了後、ユーザー判断で**Publicに戻した**（履歴クリーン化＋pre-commitフック導入済みのため許容。「危険なのはコードが見えることではなく秘密情報が漏れること」という方針）
- 自宅PC側の対応（次回自宅PCを開いたら最初に必須）：
  ```
  git fetch origin
  git reset --hard origin/master
  ```
  （履歴を書き換えたため、通常の`git pull`ではなくこの2行が必要。自宅PC側に未コミットの変更が無いことは確認済み）

### 4. Vercel自動デプロイの復旧
- 原因は上記3のPrivate化によるVercel Hobbyプラン制限だったため、Publicに戻した後、Vercelプロジェクト設定→Git→一度Disconnect→再Connectで復旧（単にPublicに戻すだけでは既存の壊れた連携は直らず、再接続が必要だった）
- 復旧確認：空コミットをpushしてDeploymentsタブに反映されることを確認済み

### 5. 通知関連バグ2件を修正
- **① ベル🔔通知一覧：✕で消してもリロードすると復活する不具合**
  - 原因：`fetchNotifs`が既読・未読を問わず全件（最大30件）を毎回取得し直す実装だったため、✕（実体は`read=true`への更新）を押しても、リロード後の再取得で同じ項目が再表示されていた
  - 修正：クエリに`.eq('read', false)`を追加し、未読のみ取得するよう変更
  - 変更ファイル：`client/src/App.tsx`（L68）
- **② ホーム画面の通知バナーからお知らせを開くと、受信トレイの未読バッジが消えない不具合**
  - 原因：URLパラメータ`openInboxId`経由でお知らせ詳細を自動展開する処理が、`inboxDetailId`をセットするだけで`board_reads`テーブルへの既読登録をしていなかった（受信トレイ一覧から直接クリックした場合は既読登録される実装と処理が分岐していた）
  - 修正：`openInboxId`のuseEffect内にも同じ既読登録処理（`board_reads.upsert`）を追加
  - 変更ファイル：`client/src/pages/BoardPage.tsx`（L642-656）
- コミット：`bafe6eb`

### 6. Vercel Public化後の再接続、および連絡板「確認・提出系」対応状況まわりのバグ複数修正（同日続き）

#### Vercel再接続
- Publicに戻しただけでは自動デプロイは復活しなかった（以前Privateで接続失敗した状態のまま残っていたため）
- Vercelプロジェクト設定 → Git → 「Disconnect」→ 再度「Connect」（fivem-inc → fivem-portal選択）で復旧
- 空コミットpushでDeploymentsタブに反映されることを確認

#### 期限切れバッジが確認済みでも赤いままだった不具合
- 原因：赤バッジ判定が`msg.deadline`と今日の日付の比較だけで、「本人が確認済みかどうか」を見ていなかった
- 修正：確認済みの場合は赤字「期限切れ」を出さず、日付のみグレーで表示するよう受信トレイ一覧・詳細画面（`renderMsg`）の両方に適用
- 送信者（送信トレイ表示）の場合は「全員確認済みか」で判定（送信者自身は受信者ではなく確認できないため、個人の確認有無ではなく集計で判定）
- 変更ファイル：`client/src/pages/BoardPage.tsx`

#### 送信トレイの「対応状況」が常に0人だった不具合
- 原因：`loadOutbox`が`board_confirmations`（誰が確認・提出したか）を一度も取得していなかった（`loadInbox`側にはあったが送信トレイ側だけ抜けていた）
- 修正：`loadOutbox`にも同じ取得処理を追加

#### 送信者が自分の送信メッセージに確認報告できてしまっていた不具合
- 送信者が誤って自分の送信メッセージに「確認報告」を押すと、受信者向けの集計に紛れ込み「2人/1人」のような矛盾表示になっていた
- 議論の末、`isOutboxView`（送信トレイ表示中かどうか）で判定：**送信トレイ画面では確認報告ボタンを表示しない**。自分を宛先に含めて送った場合は、その分は受信トレイ側に届くので、受信トレイからは通常通り回答できる

#### 回答一覧に確認日時が出ていなかった不具合
- 原因：`board_confirmations`の`confirmed_at`列をそもそも取得していなかった（`comment`だけ取得）
- 修正：3箇所のデータ取得（`loadAll`/`loadInbox`/`loadOutbox`）全てに`confirmed_at`を追加、常に年月日時分を表示する`fmtConfirmDate`関数を新設
- 表示範囲を分離：**受信者は自分の回答のみ**、**送信者（送信トレイ）は全員分**を表示
- 自分の確認済みボタンの時刻（「確認済み（済み）」表記）が、ページ再読み込み後に消えていた問題も、DBの`confirmed_at`から復元するよう修正（以前はローカルstate`myConfirmTimes`のみに依存していた）

#### 送信トレイの一覧カードの表示を受信トレイと統一
- 種別ラベル（確認・提出確認など）＋期限バッジ＋左の色付き縦線が送信トレイの一覧に無かったため追加
- 全員確認済みの場合、受信トレイと同じ緑「✓完了」バッジを送信トレイのカードにも追加

#### 種別（読了/回答/提出/承認/確認）選択時、期限日を必須化
- チャンネル投稿・個別お知らせ作成の両方の作成画面で、種別ボタンを選んだ状態で期限日が未入力だと送信ボタンが無効化されるよう変更
- 未入力時は期限日欄が赤枠＋「種別を選んだ場合、期限日の入力が必要です」を表示

コミット：`c859d31`

### 🔜 次回タスク（2026-07-02 セッション終了時点・最新）
1. **忘れん坊通知①②③の呼び出し側実装**（`encouragement-notify-daily`・`remind-unread-daily`のURL/認証設定が未完了のまま放置されている。プレースホルダーURLの修正＋Vault方式への統一が必要）
   - ① 未回答リマインド: お知らせの期限1日前・当日に未回答者へ send-push
   - ② 定期リマインド: 毎月〇日に指定グループへ自動通知（Supabase Cron + send-push）
   - ③ 確認ボタン: 重要連絡に「確認しました」ボタン → 未確認者を管理者が把握・一括リマインド
2. **peachさんアカウント（pongketkorn15@gmail.com）の処置**：削除済み（対応完了）
3. **gcal-sync 失敗時リトライキュー**（低優先）
4. ★7月リリースの公開操作（手動：管理画面→機能別 表示権限）
   - 7/1 : 交通費・出張報告を「全公開」ON → 済
   - 7/16: 残り（休暇・カレンダー・勤務変更・連絡板）を「全公開」ON
5. **自宅PCへのセキュリティ設定導入**（グローバル`.gitignore`＋pre-commitフック。上記3参照）
6. **npm不要ファイル・大容量キャッシュの整理**：他のリポジトリでも`.claude`/`.vercel`/`.npm`等の誤コミットが無いか確認すると安心
7. **テスト用データの掃除**：「あああ」というテストメッセージ（board_confirmations に管理者自身の確認データが残っている）を削除して良いか、次回ユーザーに確認する

### ⚠️ 作業ルール（必読・再掲・更新）
- デプロイ（git push）はユーザーの指示があってから。ローカル確認後にデプロイ指示を待つ
- `alert()` 禁止 → 成功時は緑カード（setSuccessMsg）
- `window.confirm()` 禁止 → インライン確認パネル（赤枠）
- Supabase クエリの `.catch()` 禁止 → `.then(null, () => {})` を使用
- 認証・アクセス制御は画面個別でなく必ず`AuthContext`のような一元的な場所に実装する
- 役職（`role_title`）と雇用形態（`employment_type`）は別軸。無役職者は必ず「一般」
- `master_options`（UsersTab選択肢）と`roles`テーブル（機能別表示権限）は別テーブル → 役職を新設・変更する時は両方に反映が必要
- **新規プロジェクト開始前・新しいPCで作業開始前は、必ず「秘密情報漏洩防止の設定（グローバル`.gitignore`＋pre-commitフック）」が入っているか確認する**（今回`.claude`/`.vercel`のトークンが1年間公開されていた事故の再発防止）
- **`git add .` / `git add -A` の前は必ず`git status`で中身を目視確認する**（ホームディレクトリの設定フォルダが紛れ込んでいないか）
- **連絡板の「確認・提出」系機能は、送信者と受信者で見えるべき情報・できる操作が異なる**（受信者＝自分の回答のみ・回答可、送信者＝全員分の集計・回答不可）。この手の機能を追加・修正する時は必ず「誰の視点か（`isOutboxView`）」を意識すること

---

## ✅ 2026-07-02（続き）連絡板のメール通知機能を追加

### 1. 背景
- 管理者から「お知らせが届いた時にメール通知したい、個人DM・グループそれぞれでON/OFFできるようにしたい」と依頼
- 確認の結果、連絡板関連のメール通知は一件も実装されていなかった（管理画面の通知設定タブには休暇/交通費/出張報告/時間調整の4グループのみ）

### 2. 実装内容
- 管理画面「通知設定」タブに新グループ「📝連絡板」を追加（`board:notice`＝お知らせ受信時／`board:dm_message`＝個人DM受信時／`board:group_message`＝グループメッセージ受信時、それぞれメールのON/OFF・件名・本文をテンプレート編集可能）
- メール本文には元のメッセージ内容を載せず、「届いたことの通知＋リンク」のみ（変数：`{{送信者名}}`・`{{件名}}`・`{{グループ名}}`・`{{リンク}}`）。お知らせはリンク先で該当項目が自動展開（既存の`openInboxId`パラメータを利用）、DM/グループは連絡板トップへのリンク
- 送信元：`sendMessage`（DM/グループの新規メッセージ・スレッド返信）・`sendNotice`（即時送信のお知らせ）から新規関数`dispatchBoardEmail`（`notificationDispatch.ts`）を呼び出し
- 予約送信されたお知らせは`board-scheduled-send` Edge Functionから同様にメール送信（クライアント側の`dispatchEmail`とは別実装。Deno環境で`notification_settings`テーブルを直接参照して送信）
- デフォルトはOFF（他イベントと同じ慣習。管理者が管理画面でONにするまで送信されない）

### 3. 管理画面のバグ修正（実装中に発覚）
- 連絡板イベントの「宛先」欄に、休暇申請などロール制の宛先（「申請者本人」「リーダー」等）の選択肢がそのまま表示されてしまっていた。連絡板は宛先が固定（実際のメッセージ受信者）のため選択自体が不要 → `event.key.startsWith('board:')`の場合は宛先セクションを非表示に変更
- `getBadges`が全チャンネル（Slack/メール/サイト通知）を無条件でOFFバッジ表示していたため、連絡板イベント（メールのみ実装）でも「Slack OFF」「サイト通知 OFF」という設定不可能なバッジが出てしまっていた → 設定行が実際に存在するチャンネルのみバッジ表示するよう修正

### 4. 追加で発見・修正したセキュリティ上の抜け穴
- **発見した問題**：`/board`ページ（連絡板）には、他の保護されたページ（休暇カレンダー・管理画面等）にあるような「機能未公開なら弾く」ガードが無かった。管理画面の「機能別表示権限」で連絡板を未公開にしていても、`isPub('board')`はナビバーのボタン表示・非表示だけを制御しており、URLを直接開けば（今回のメール内リンク経由でも）誰でも中身を見られてしまう状態だった
- ナビバーに書かれていた公開判定ロジック（管理者は常に許可／全公開ON／リーダー以上限定ON、の3段階判定）を`useFeaturePublished.ts`の`isFeaturePublished()`関数として切り出し、`App.tsx`の`BoardPageWrapper`（`/board`のルート）にも同じ判定でガードを追加（未公開なら`/`へリダイレクト）
- **教訓**：機能公開設定はナビバーのボタン表示だけでなく、ルート単位でも同じ判定を通す必要がある。他のページ（勤務変更・休暇カレンダー等）は元々ルート側にもガードがあったが、連絡板だけ抜けていた。新しいページを追加する時は必ずルート側のガードも実装すること

### マイグレーション・Edge Function
- `supabase/migrations/20260702000000_add_board_email_notifications.sql`（SQL Editorで実行済み）
- `supabase/functions/board-scheduled-send/index.ts`（メール送信処理を追加、再デプロイ済み）

### 確認内容
- `npx tsc --noEmit`：エラーなし
- `npm run build`：本番ビルド成功

### 変更ファイル
- `client/src/pages/BoardPage.tsx`
- `client/src/lib/notificationDispatch.ts`
- `client/src/components/admin/NotificationsTab.tsx`
- `client/src/hooks/useFeaturePublished.ts`
- `client/src/App.tsx`
- `supabase/functions/board-scheduled-send/index.ts`
- `supabase/migrations/20260702000000_add_board_email_notifications.sql`（新規）

### ⚠️ 注意事項・今後の検討事項
- DM/グループはメッセージが送信されるたびに毎回メールが送られる仕様（「未読の場合のみ」等の抑制ロジックは入れていない）。やりとりが活発なチャンネルだとメールが連続する可能性があるため、実際に運用してみて頻度が気になるようなら抑制ロジックの追加を検討する
- 今回のガード追加により、`/board`が未公開の状態でメール内リンクを踏んだユーザーはホームにリダイレクトされるようになった。7/16の全公開までの間、テスト送信は管理者アカウント宛てのみに限定すること
- テストは`previewRole`（管理者が他の役職になりすまして画面確認できる機能）で「連絡板が未公開の一般スタッフ」から`/board`に直接アクセスし、ホームにリダイレクトされることを確認する

### 🔜 次回タスク（2026-07-02 セッション最新）
1. **忘れん坊通知①②③の呼び出し側実装**（`encouragement-notify-daily`・`remind-unread-daily`のURL/認証設定が未完了のまま放置）
2. **gcal-sync 失敗時リトライキュー**（低優先）
3. ★7/16：残り機能（休暇・カレンダー・勤務変更・連絡板）を「全公開」ON
4. **自宅PCへのセキュリティ設定導入**（グローバル`.gitignore`＋pre-commitフック）
5. **テスト用データの削除可否確認**（「あああ」メッセージへの管理者自身の確認データ）
6. **連絡板メール通知の実運用テスト**：本文抜きで運用上問題ないか、DM/グループの連続送信が気にならないか、実際に使ってみて判断する

### ⚠️ 作業ルール（必読・再掲）
- デプロイ（git push）はユーザーの指示があってから。ローカル確認後にデプロイ指示を待つ
- `alert()` 禁止 → 成功時は緑カード（setSuccessMsg）
- `window.confirm()` 禁止 → インライン確認パネル（赤枠）
- Supabase クエリの `.catch()` 禁止 → `.then(null, () => {})` を使用
- 認証・アクセス制御は画面個別でなく必ず`AuthContext`のような一元的な場所に実装する
- 役職（`role_title`）と雇用形態（`employment_type`）は別軸。無役職者は必ず「一般」
- `master_options`（UsersTab選択肢）と`roles`テーブル（機能別表示権限）は別テーブル → 役職を新設・変更する時は両方に反映が必要
- **新しいページ（ルート）を追加する時は、ナビバーのボタン表示・非表示だけでなく、ルート単位でも機能公開判定（`isFeaturePublished`）のガードを必ず入れる**（連絡板で抜けていたことが発覚）
- 連絡板の「確認・提出」系機能は、送信者と受信者で見えるべき情報・できる操作が異なる（受信者＝自分の回答のみ・回答可、送信者＝全員分の集計・回答不可）。「誰の視点か（`isOutboxView`）」を必ず意識すること

---

## ✅ 2026-07-02 通知ベル: ✕未押下の通知までリロードで消える不具合修正 完了

### 症状
- 通知ベルで✕を押した通知が消えるのは正常だが、リロードすると✕を押していない（まだ残しておきたい）通知まで一緒に消えてしまう

### 原因
- `App.tsx` の `BellIcon` で、ベルを開くだけで `markAllRead()` が呼ばれ、その時点の未読通知を全件 `read: true` に更新していた
- `fetchNotifs` は `eq('read', false)` で未読のみ取得する仕様（bafe6ebで導入）のため、開いただけで既読化された「✕未押下」の通知もリロード後の一覧から消えていた
- 「既読(read)」と「✕で消した(dismiss)」が同じ `read` カラムに統合されていたのが根本原因

### 修正
- `handleOpen` から `markAllRead()` の呼び出しを削除、`markAllRead` 関数自体も削除
- ✕ボタン（`dismissOne`）だけが `read: true` を更新するように変更 → ベルを開いただけでは既読化されない

### 変更ファイル
- `client/src/App.tsx`

### コミット: `2f6ea50`

---

## ✅ 2026-07-03 忘れん坊通知①②③ 自動化・柔軟化 完了

### 背景
- `encouragement-notify`（有給奨励日未回答リマインド）・`remind-scheduled`（定期リマインド）・
  `remind-unread`（連絡板締切未読リマインド）の3つはロジックは完成していたが、
  自動で呼び出す仕組み（pg_cron等）が未設定のまま放置されていた
- 手動の「🔔 ○人にリマインドを送る」ボタン（BoardPage.tsx）は別途実装済みのため対象外

### 実装内容（段階的に対応）

#### 1. pg_cronで毎日自動呼び出し
- 3つのEdge Functionを毎日09:00(JST)にpg_cronで自動呼び出すよう設定
- Vaultのservice_role_key・pg_netを使い、`board-scheduled-send`と同じ方式

#### 2. 「何日前に送るか」を管理画面から編集可能に
- `reminder_days_settings`テーブルを新規作成（`encouragement_notify`・`remind_unread`）
- これまでコードにハードコードされていた閾値（3日前/当日、前日/当日）を可変化
- 管理画面「通知設定」タブに「⏰ リマインド送信タイミング設定」パネル追加

#### 3. 送信時刻も管理画面から編集可能に（毎日固定09:00→可変）
- pg_cronを「毎日1回固定時刻」→「5分おきに実行し、Edge Function内でJST現在時刻と
  設定時刻(send_hour/send_minute)が一致するかチェック」方式に変更
- 管理画面から時刻を変更するだけで反映され、cronの再設定が不要に

#### 4. 定期リマインドを「1件ごとに」時刻・頻度・複数日を持てるように再設計
- `board_scheduled_reminders`テーブルを再設計：
  `day_of_month`（単一値）→ `frequency`('monthly'|'weekly') + `days`(int[]) + `send_hour`/`send_minute`
- 管理画面「📅 定期リマインド設定」の新規追加フォームに「頻度」（毎月/毎週）・
  日付複数指定（カンマ区切り）・曜日複数選択（チェックボタン）・時刻選択を追加
- これにより「1件は毎月1日9時」「別の1件は毎週月曜17時」のように個別設定可能に
- ③(remind_scheduled)は個別時刻を持つため、共通1時刻の`reminder_days_settings`行は削除

#### 5. ①②③すべてにベル通知＋メールON/OFFを追加
- これまで②③は「プッシュ通知のみ」（通知許可していない人には届かない）だったため、
  ①と同様に`notifications`テーブルへのinsert（🔔ベル通知）を追加
- `notification_settings`に`reminder:encouragement`・`reminder:scheduled`・`reminder:unread`
  （channel='email'）を追加し、管理画面「通知設定」タブに「⏰ リマインド」グループを新設
  （件名・本文編集、ON/OFF切り替え、デフォルトはOFF）
- リマインド系イベントは「宛先」欄（申請者本人/リーダー等のロール選択）が不要なため、
  `board:`と同様に`reminder:`プレフィックスも宛先UIを非表示にする条件分岐を追加

### マイグレーション（実行順）
1. `20260703000000_schedule_reminder_crons.sql`
2. `20260703100000_create_reminder_days_settings.sql`
3. `20260703200000_add_send_time_to_reminder_settings.sql`
4. `20260703210000_change_reminder_crons_to_5min.sql`
5. `20260703300000_per_reminder_send_time.sql`（board_scheduled_remindersの列を`day_of_month`→`frequency`+`days`に変更、破壊的変更だが登録データが無い時点で実施）
6. `20260703400000_add_reminder_email_settings.sql`

### 再デプロイしたEdge Function
- `encouragement-notify`・`remind-unread`・`remind-scheduled`（計3回、途中の設計変更のたびに複数回デプロイ）

### 確認内容
- `npx tsc --noEmit`：エラーなし（都度確認）
- Supabase SQL Editorで各migration実行・`select * from cron.job`等で動作確認済み
- 管理画面の見た目確認済み（頻度切り替え・時刻プルダウン・メール設定パネル）

### ⚠️ 注意事項・今後の確認事項
- 実際に朝9時（または設定した時刻）にリマインドが届くか、翌日以降に実運用で確認すること
- pg_cronは5分おきに全リマインダーをチェックする方式に変わったため、Edge Function呼び出し回数が
  増えている（1日あたり288回×3関数）。Supabaseの無料枠等で問題にならないか一応留意
- メール通知はデフォルトOFF。運用しながら必要に応じて管理画面でONにする
- `board_scheduled_reminders`の`day_of_month`列は削除済み（`frequency`+`days`に統合）。
  もし他の場所で`day_of_month`を参照しているコードが残っていたら要修正

---

## ✅ 2026-07-03 定期リマインド編集機能・不具合修正 完了

### 追加内容
- 「📅 定期リマインド設定」の登録済み一覧に「編集」ボタンを追加（NotificationsTab.tsx）
  - 押すと上のフォームに既存の頻度・日付/曜日・送り先・時刻・タイトル・本文が読み込まれ、
    「更新する」で保存（DB変更・Edge Functionの変更なし、フロントのみ）
  - 「キャンセル」で新規追加モードに戻る

### 発生した不具合と原因
- 「⏰ リマインド送信タイミング設定」パネルで「何日前」を保存してもリロードすると消える不具合が発生
- **原因**：7/3に案内した`reminder_days_settings`へ`send_hour`/`send_minute`列を追加するSQL
  （`20260703200000_add_send_time_to_reminder_settings.sql`）が、途中で別の作業（定期リマインドの
  頻度・複数日対応）に話が進んだため、実行されないまま放置されていた
  → フロントのfetchが `send_hour, send_minute` を含む列をSELECTしていたため、列が存在せず
    クエリが失敗 → 設定が空として表示され、保存前の値のように見えていた（実際は元の値は
    DBに残っていたが、UI側で読めていなかった）
- 該当SQLを実行してもらい解決（データ自体は消えていなかった）

### ⚠️ 教訓
- 複数のmigrationファイルを立て続けに作る時は、途中で話が脱線しても
  「まだ実行してもらっていないSQLが無いか」を都度確認すること
  （今回は「①のSQL実行」を案内した直後にユーザーが別の質問をしてきたため、
  そのまま次の設計変更に進んでしまい、実行確認が漏れた）

### 確認内容
- `npx tsc --noEmit`：エラーなし
- SQL実行後、ブラウザで「何日前」入力欄に保存値が表示されることを確認済み

---

## ✅ 2026-07-03 勤務変更申請: 時刻表示バグ修正・勤務地変更種別追加・ダークモード改善 完了

### 1. 時刻入力欄がダークモードで読み間違えるバグ修正
- 症状：「通常シフト」の時間欄が実際は12:00〜19:00等なのに、見た目上「13:00〜13:00」のように
  終了時刻が開始時刻と同じに見え、下の「シフト時間：6時間」と矛盾しているように見えた
- 原因：`<input type="time">`にダークモード時の`colorScheme`指定が無く、OS/ブラウザが
  ネイティブ描画する時刻ピッカーの数字がライトテーマ想定のまま描画され、暗い背景と
  合わさって読み取りづらくなっていた（データ自体は正しかった＝表示バグ）
- 修正：`f`スタイル（ShiftReportPage.tsx）に`colorScheme: isDark ? 'dark' : 'light'`を追加

### 2. 種別に「📍 勤務地変更」を追加
- 背景：勤務地が普段と異なる場合を種別として明示的に選べるようにしたいという要望
- 名称は複数案から「勤務地変更」を選定（フォーム内の既存ラベル「勤務地」と表記を統一）
- 配置：休日出勤・欠勤のすぐ下（見出し無し、単独の行）
- 排他ルール：休日出勤と勤務地変更は同時選択不可に（間違えて両方押してしまうのを防止）
- `shift_reports.application_type`のCHECK制約に`location_change`を追加
- 管理画面（ShiftReportsTab.tsx）側のTYPE_INFO定義にも同様に追加

### 3. ダークモードの見にくさを複数箇所修正
- 「🕐 休憩◯分／実労働◯時間」「✓ 種別サマリー」「✓ 申請と同時に受理済みになります」
  「✅ 実際の勤務時間（確認ページ・履歴一覧）」等、暗い緑背景に暗い緑文字（`#166534`/`#065f46`）
  で表示されていた箇所をダークモード時のみ明るい緑（`#4ade80`）に変更
- 「勤務地変更」ボタンの選択時の色も、ダークモードでは明るい紫（`#c4b5fd`）に調整

### 未実装・保留事項
- 「通常シフト（シフト時間）」が休憩を引く前の総時間、「実際に勤務した時間（実労働）」が
  休憩を引いた後の正味時間で、比較の基準が揃っていない問題を発見（時刻が同じでも
  数字が違って見える）。残業判定（`diffMin = 実労働 − シフト時間`）が実際より甘く出る
  可能性があるため、休憩ルールを両方に揃えるべきか検討中。**実装は保留、後日対応**

### マイグレーション
- `20260703500000_add_location_change_type.sql`（要SQL Editor実行）

### 変更ファイル
- `client/src/pages/ShiftReportPage.tsx`
- `client/src/components/admin/ShiftReportsTab.tsx`

### 確認内容
- `npx tsc --noEmit`：エラーなし（都度確認）
- ダークモードで時刻表示・種別選択・実労働表示の見た目確認済み

---

## ✅ 2026-07-04 勤務変更申請: シフト時間表示削除／サイト全体の言語タグ修正 完了

### 1. 勤務変更申請「シフト時間」表示を削除
- 背景：休憩時間の計算基準が「シフト時間（休憩を引く前）」と「実労働（休憩を引いた後）」で
  揃っていない問題（[[2026-07-03勤務変更申請]]の保留事項）があり、比較基準が不揃いのまま
  「シフト時間：◯時間」を表示し続けると誤解を招くため、表示自体を削除する対応にした
- 削除箇所（`ShiftReportPage.tsx`）：
  1. 入力フォーム（「通常シフト」の時間欄の下、`origMin`表示）
  2. 送信前確認画面（「📋 通常シフト（もともとの予定）」行の末尾カッコ書き）
  3. 申請履歴一覧（管理者/本人共通の履歴カード、時刻の末尾カッコ書き）
- `origMin`/`oMin`変数自体は残業判定・早出/遅刻/早退の差分計算に引き続き使われているため削除していない（表示のみ削除）
- 別の履歴表示（管理者向け縦並びリスト、L1207-1208付近）はもともとシフト時間を表示していなかったので変更不要だった

### 2. サイト全体でChromeが勝手に翻訳ポップアップを出す不具合を修正
- 症状：日本語のみのサイトなのに、Chromeが「このページを翻訳しますか？」を自動表示する
- 原因：`client/index.html`の`<html lang="en">`が英語指定のままで、実際のページ内容（日本語）と
  食い違っていたため、Chromeの自動翻訳判定が誤爆していた
- 修正：`<html lang="en">` → `<html lang="ja">`

### 未実装・保留事項（変更なし、引き続き保留）
- 休憩時間の計算基準統一（「シフト時間」表示は消したが、`diffMin`（残業判定）の計算式自体は
  まだ「実労働 − シフト時間（休憩前基準）」のまま。基準を揃えるかどうかは別途検討・実装が必要）

### 変更ファイル
- `client/src/pages/ShiftReportPage.tsx`
- `client/index.html`

### 確認内容
- `npx tsc --noEmit`：エラーなし
- fivem-portalがプロジェクトルート外にあるためpreview_startでのブラウザ起動確認は不可。
  型チェックとコード差分レビューで確認（実機での見た目確認は次回ローカルで推奨）

### コミット
- `bf881fc` fix: 勤務変更申請のシフト時間表示を削除
- 本セッションのlang修正・CLAUDE.md追記分（本コミット）

### 🔜 次回やること（優先順、2026-07-04時点）
1. 休憩時間の計算基準統一（上記保留事項、`diffMin`計算式の見直し）
2. 忘れん坊通知①②③の実運用確認（朝9時等の設定時刻に届くか）
3. 連絡板メール通知の実運用テスト（管理者アカウントのみ）
4. gcal-sync失敗時リトライキュー（低優先）
5. 7/16：残り機能（休暇・カレンダー・勤務変更・連絡板）を「全公開」ON
6. 自宅PCへのセキュリティ設定導入（グローバル.gitignore＋pre-commitフック）
7. テスト用データの削除可否確認（「あああ」メッセージへの管理者自身の確認データ）
8. npm不要ファイル・大容量キャッシュの整理

---

## ✅ 2026-07-04 ベル通知：バッジと表示を分離（既読≠非表示化） 完了

### 背景
- 7/3の修正で「ベルを開いただけでは既読にならない」状態にしたが、そうすると
  「メッセージを確認した（既読にした）のにベルの数字バッジが残り続ける」という
  別の違和感が発生した
- 「read」という1つの列で『バッジを消す』と『リストから消す』を兼用していたのが原因

### 変更内容
- `notifications`テーブルに列を追加：`dismissed`（✕を押したか）・`read_at`（既読にした日時）
- 挙動を分離：
  - ベルを**開いた瞬間** → 未読を`read=true, read_at=now()`に一括更新 → バッジの数字が即0になる
  - ✕を押した時 → `dismissed=true`に更新 → その通知だけリストから消える
  - ベル一覧の取得条件を`read=false`→`dismissed=false`に変更（既読でも✕を押すまでは表示され続ける）
- 自動削除cron（`delete-old-notifications`, jobid=13）を`created_at`基準→`read_at`基準に変更
  （「既読にしてから30日」で自動削除。期間は30日のまま据え置き）

### Supabase SQL（実行済み）
```sql
alter table notifications add column if not exists dismissed boolean default false;
alter table notifications add column if not exists read_at timestamptz;
update notifications set read_at = created_at where read = true and read_at is null;

select cron.unschedule('delete-old-notifications');
select cron.schedule(
  'delete-old-notifications',
  '0 18 * * *',
  $$ delete from notifications where read = true and read_at < now() - interval '30 days'; $$
);
```

### 変更ファイル
- `client/src/App.tsx`（BellIconコンポーネント）
- `supabase/migrations/20260704000000_add_dismissed_to_notifications.sql`

### 確認内容
- `npx tsc --noEmit`：エラーなし
- cronジョブ再登録後の内容をSQLで確認済み（jobid=13、read_at基準）
- ⚠️ ブラウザでの実機動作確認（ベルを開いてバッジが消える／✕を押すとリストから消える／
  リロードしても✕を押していない通知は残る）は次回ローカルでの確認を推奨

### 注意事項
- `NotificationBanner`（ページ上部の帯バナー、有給奨励日などの案内）は今回変更していない。
  引き続き`read=false`を条件に表示しているため、ベルを開いて既読になった通知は
  次回フェッチ時にバナーからも消える（意図した挙動：ベルで見た＝バナーで再度案内不要）
  → **2026-07-04追記：この挙動が不都合と判明したため、直後に別対応で分離した（下記参照）**

---

## ✅ 2026-07-04（続報） 上部お知らせバナーをベルの既読と分離 完了

### 背景
- 直前の対応で「ベルを開く→既読(read=true)」にした結果、上部お知らせバナーも
  `read=false`を条件にしていたため、ベルを開いただけで上部バナーまで消えてしまう
  問題が発覚（ベルは見ただけで確認していないのに、TOPのお知らせが消えるのは困る）

### 変更内容
- `notifications`テーブルに`banner_dismissed`列を追加
- `NotificationBanner`（上部帯バナー）の表示条件：`read=false`→`banner_dismissed=false`に変更
- `NotificationBanner`の確認（タップ）時：`read=true`に加えて`banner_dismissed=true`もセット

### 現在の3つの独立フラグの役割（最終形）
| フラグ | 役割 | trueにするタイミング |
|---|---|---|
| `read` | ベルのバッジ数に使う | ベルを開いた瞬間／上部バナーを確認した瞬間 |
| `dismissed` | ベル一覧にまだ表示するか | ベル内の✕を押した瞬間 |
| `banner_dismissed` | 上部バナーにまだ表示するか | 上部バナーを確認（タップ）した瞬間 |

### Supabase SQL（実行済み）
```sql
alter table notifications add column if not exists banner_dismissed boolean default false;
```

### 変更ファイル
- `client/src/App.tsx`（NotificationBannerコンポーネント）
- `supabase/migrations/20260704100000_add_banner_dismissed_to_notifications.sql`

### 確認内容
- `npx tsc --noEmit`：エラーなし
- ⚠️ 実機動作確認（ベルを開いても上部バナーが残る／上部バナーを確認するとそれだけ消える）は
  次回ローカルでの確認を推奨

---

## ✅ 2026-07-04（続報2） 連絡板お知らせバナー：本体既読で自動的に消えるように 完了

### 背景
- 上記の対応で上部バナーは「タップして確認するまで消えない」仕様にしたが、
  連絡板メッセージについては「バナーをタップせず、連絡板ページを直接開いて本体を読んだ場合」
  にバナーだけが取り残されて残り続けてしまう問題があった

### 変更内容（`NotificationBanner`のみ、BoardPage.tsx側は無変更）
- バナー通知取得時、`source_type='inbox'`（連絡板由来）の通知だけ、`reference_id`（元の
  メッセージid）を`board_reads`テーブル（本体を開いた既読記録）と突き合わせる
- 既に本体を読んでいた場合：
  - その場でDBを`read=true, banner_dismissed=true`に更新（次回以降も再表示されない）
  - 今回の画面表示からも除外
- これにより「連絡板ページで直接読んだ→ホームに戻るとバナーが自動で消えている」という
  挙動になった（SQL変更は不要、既存テーブルのみで対応）

### 変更ファイル
- `client/src/App.tsx`（NotificationBannerのfetchNotifs）

### 確認内容
- `npx tsc --noEmit`：エラーなし
- ⚠️ 実機動作確認（連絡板を直接開いて既読にした後、ホームでバナーが消えているか）は
  次回ローカルでの確認を推奨

---

## ✅ 2026-07-04（続報3） 連絡板バナー自動非表示が動いていなかったバグ修正 完了

### 症状
- 直前の対応（本体既読→バナー自動非表示）を入れたのに、実際に受信トレイでお知らせを
  開いて確認してもTOPバナーが消えなかった

### 原因
- 連絡板系の通知は`insertNotification()`で`sourceType`引数を渡さずに作成しているため、
  実際のDB上の`source_type`は常に`null`（`'inbox'`という値は使われていなかった）
- 自動非表示の判定条件を`source_type === 'inbox'`にしていたため、常に不一致で
  何も自動非表示にならなかった（表示側の`NotifItem`はメッセージ文言で`isBoard`判定して
  いたのに、新設した判定だけ`source_type`を見ていて表示側とロジックが噛み合っていなかった）
- 加えて、DM送信時の通知（`BoardPage.tsx`のtargetId宛メッセージ）は`reference_id`（送信した
  メッセージのid）を渡していなかったため、本体既読と突き合わせる手がかりが無かった

### 修正内容
- `App.tsx`の`NotificationBanner`：判定を`source_type === 'inbox'`→表示側と同じ
  メッセージ文言判定（`お知らせ`/`メッセージが届き`/`リマインド`を含むか）に統一
- `BoardPage.tsx`のDM送信箇所：`board_messages`のinsert結果からメッセージidを取得し、
  `insertNotification`の`referenceId`に渡すよう修正（`.select('id').single()`を追加）

### 変更ファイル
- `client/src/App.tsx`
- `client/src/pages/BoardPage.tsx`

### 確認内容
- `npx tsc --noEmit`：エラーなし
- ⚠️ 実機動作確認（受信トレイでお知らせ本文を開いた後、ホームでバナーが消えるか）は
  次回ローカル・本番での確認を推奨

---

## ✅ 2026-07-04（続報4） 未使用機能「お知らせのコメント欄」を削除 完了

### 背景
- 通知バナーの調査中に発見：「お知らせ」詳細画面に`comment_enabled=true`の時だけ
  表示されるコメント欄が実装されていた（2026-06-16 Phase実装、CLAUDE.md L3351）
- しかし送信フォーム側に`comment_enabled`をONにするUIが存在せず、常にfalseで
  insertされるため、実際には一度も表示されたことがない死んだコードだった
- 対応状況（確認・回答／deadline_type・requires_confirmation）機能で代替済みのため、
  ユーザー判断で削除することにした

### 削除内容
- `BoardPage.tsx`：
  - `BoardMessage`型の`comment_enabled`フィールド
  - state 3つ（`inboxCommentOpen`・`inboxComments`・`inboxCommentBody`）
  - コメント欄UIブロック全体（開閉ボタン・一覧・入力欄）
  - 6箇所の`select`文にあった`comment_enabled`列指定
  - メッセージ送信時のハードコード`comment_enabled: false`
- DB：`board_messages.comment_enabled`列を削除

### Supabase SQL（実行済み）
```sql
alter table public.board_messages drop column if exists comment_enabled;
```

### 変更ファイル
- `client/src/pages/BoardPage.tsx`
- `supabase/migrations/20260704200000_drop_comment_enabled.sql`

### 確認内容
- 削除前に他機能（スレッド返信・対応状況・お知らせ本体）との依存が無いことを
  grepで確認済み（`comment_enabled`はこの機能専用でのみ参照されていた）
- `npx tsc --noEmit`：エラーなし

---

## ✅ 2026-07-03（追加調査） 忘れん坊リマインドcron未反映バグ発見・修正

### 経緯
- 定期リマインド（③remind-scheduled）をテストしたが届かず調査
- 7/3に作成したマイグレーション`20260703210000_change_reminder_crons_to_5min.sql`
  （忘れん坊通知①②③のcronを「1日1回固定」→「5分おき」に変更するSQL）が、
  SQL実行を案内し忘れており**DBに反映されていなかった**（同日の`send_hour`/`send_minute`
  列追加SQL忘れと全く同じパターンの再発）
- `select jobid, jobname, schedule from cron.job`で確認したところ、
  `encouragement-notify-daily`・`remind-unread-daily`・`remind-scheduled-daily`の
  3つとも`0 0 * * *`（UTC0:00=JST9:00固定）のままだった

### 対応
- 以下のSQLを実行してもらい解決（3ジョブとも`*/5 * * * *`に変更済み）
```sql
select cron.alter_job((select jobid from cron.job where jobname = 'encouragement-notify-daily'), schedule := '*/5 * * * *');
select cron.alter_job((select jobid from cron.job where jobname = 'remind-scheduled-daily'), schedule := '*/5 * * * *');
select cron.alter_job((select jobid from cron.job where jobname = 'remind-unread-daily'), schedule := '*/5 * * * *');
```

### ⚠️ 教訓（再掲・強化）
- 「マイグレーションファイルを作った」≠「DBに反映された」。特に`cron.schedule`/
  `cron.alter_job`のようにテーブル変更を伴わないSQLは、`git status`や通常の動作確認
  だけでは気づけないため、**cron系の変更は毎回`select * from cron.job`で反映結果を
  実際に確認する**ことを徹底する

---

## ✅ 2026-07-03（追加調査2） メールテンプレートの改行が「\n」と文字化けするバグ修正

### 症状
- 連絡板お知らせのメール通知本文が「〜届きました。\n下記のリンクから...」のように
  `\n`が改行されず文字としてそのまま表示されていた

### 原因
- メールテンプレートの初期値をDBに登録したマイグレーションSQLで、通常の
  シングルクォート文字列内に`\n`と書いていた
- PostgreSQLは`standard_conforming_strings`がデフォルトONのため、通常の`'...'`内の
  `\n`はエスケープとして解釈されず、バックスラッシュ+nの2文字がそのままDBに
  保存されていた（改行させるには`E'...'`のエスケープ文字列構文が必要だった）
- 影響していたテンプレート：`board:notice`・`board:dm_message`・`board:group_message`・
  `reminder:encouragement`・`reminder:unread`（計5件、email channel）

### 対応
- 既存データを修正するSQLを実行してもらい解決
```sql
update notification_settings
set template = replace(template, '\n', chr(10))
where channel = 'email' and template like '%\n%';
```
- 該当マイグレーションファイル（`20260702000000_add_board_email_notifications.sql`・
  `20260703400000_add_reminder_email_settings.sql`）も`E'...'`構文に修正し、
  今後新規環境を構築した場合に同じ不具合が再発しないようにした

### 変更ファイル
- `supabase/migrations/20260702000000_add_board_email_notifications.sql`
- `supabase/migrations/20260703400000_add_reminder_email_settings.sql`
- `supabase/migrations/20260704300000_fix_literal_newline_in_email_templates.sql`（新規）

### ⚠️ 教訓
- 今後、通知テンプレート等でDBに複数行の初期値をSQLでinsertする時は、改行を含む場合
  必ず`E'...'`構文（またはダラー引用符での実改行）を使うこと。通常の`'...'`はNG

---

## ✅ 2026-07-04〜05 忘れん坊cron修正・勤務変更受理の一斉通知・勤務変更申請の表示改善 完了

### 1. 忘れん坊通知cron未反映バグ修正
- `20260703210000_change_reminder_crons_to_5min.sql`（①②③のcronを5分おきに変更するSQL）が
  実は未実行だったと判明（`select * from cron.job`で確認したら3つとも`0 0 * * *`固定のまま）
- `cron.alter_job`で3ジョブとも`*/5 * * * *`に変更・実行済み

### 2. メールテンプレートの改行文字化けバグ修正
- 通常の`'...'`文字列内の`\n`はPostgreSQLでエスケープされず、メール本文に
  バックスラッシュ+nがそのまま表示されるバグを発見・修正
- 影響：`board:notice`・`board:dm_message`・`board:group_message`・
  `reminder:encouragement`・`reminder:unread`（計5件）
- 既存データはUPDATE文で修正済み、マイグレーションファイルも`E'...'`に修正

### 3. 勤務変更申請「受理時」の一斉通知（新機能）
- 時間調整（`time_adjustment:registered`）と同じ「役職＋グループ絞り込み」方式を導入
- 新規Edge Function：`shift-report-confirmed-notify`（`time-adjustment-notify`とほぼ同一ロジック）
- 管理画面「勤務変更申請」カテゴリを新設（時間調整と同じUIコンポーネントを共有するよう
  `ROLE_GROUP_BROADCAST_EVENTS`配列で汎用化）
- デフォルト設定：サイト通知ON（リーダー・マネージャー・管理者・社長、同グループのみ）、
  Slack・メールは要設定
- 呼び出し箇所3つ：ShiftReportPage.tsx（通常受理・自己受理）、ShiftReportsTab.tsx（管理者受理）
- 申請者本人には別途届く既存の「受理されました」通知と重複しないよう、
  `resolveTargetIds`で申請者自身を除外

### 4. 新規登録通知バグ修正（調査中に発見）
- `new-signup-notify`が`body`/`type`/`is_read`という存在しない列名でinsertしており、
  管理者へのベル通知が一件も作成されていなかった（過去に`board-scheduled-send`にあった
  のと同じバグパターン）→ 正しい列名（`sub_message`）に修正

### 5. TOPバナー・ベルの通知設計を全面整理
- 休暇申請・勤務変更申請の通知に`reference_id`と`source_type`を新規付与
  - `leave_request:pending_approval` / `leave_request:pending_resubmit` / `leave_request`（結果）
  - `shift_report:pending_approval` / `shift_report:pending_resubmit` / `shift_report`（結果）
  - `time_adjustment`
- `dispatchSiteNotification`にsourceType/referenceIdを渡せるよう拡張（後方互換）
- TOPバナー（`NotifItem`）のタップ挙動を種別ごとに正しく振り分け
  - 要対応（pending_approval/pending_resubmit）：タップしても消えない、`/leave-approvals`等へ遷移
  - 結果報告のみ：タップで閉じる、履歴タブへ遷移
  - 「要対応」の承認待ちは既存の集計バナー（LeaveApprovalBanner/ShiftReportApprovalBanner）と
    重複するため、TOPバナー側からは除外（`.not('source_type', 'in', ...)`）
- 対応完了の自動消去：`leave_requests`/`shift_reports`のステータスをそれぞれ1回のクエリに
  まとめて取得しN+1を回避、RLSで読めない場合は安全側で残す
- `ShiftReportApprovalBanner`のタップ先を`/shift-report`→`/shift-report?view=confirm`に修正
  （今まで確認ページに直接飛ばないバグだった）
- `ShiftReportPage.tsx`に`?tab=`・`?view=confirm`クエリパラメータ対応を追加
- 連絡板「リマインド未対応の催促」の自動消去判定を`board_reads`（既読）→
  `board_confirmations`（実際に回答したか）に修正（開いただけで消えるのはおかしいため）

### 6. 勤務変更申請フォーム・表示の改善
- 欠勤（`hasAbsence`）選択時、「通常シフト（もともとの予定）」欄を丸ごと非表示・入力不要に
  （欠勤なのに時間入力を求められる不具合を解消）。確認画面・履歴表示も統一
- 履歴一覧・管理画面：「短縮」表示を削除（休憩基準が揃っていないため不正確だった）
- 履歴一覧・管理画面：さらに「時間外」表示も全箇所削除（同じ理由、フォーム入力中・
  確認画面も含め計6箇所）
- 実際の勤務地（`actual_location`）を履歴一覧に追加表示（今まで元の勤務地しか出ていなかった）
- 履歴一覧・管理画面の表記を絵文字（📋/✅）→「変更前：」「変更後：」の明示テキストに統一
- 管理画面テーブル：「勤務日」「勤務地」の2列→「変更前」「変更後」の2列に再編、
  休憩時間も追加表示
- CSV出力も「変更前/変更後」で別列に分割（今まで実際の値優先の1列にまとめていた）
- 管理画面：「代行：」の姓のみ表示→フルネーム表示に修正、申請者名も改行せず一行表示に統一
  （休暇申請一覧の申請者・申請先も同様に修正、計6箇所）
- 修正履歴ボタン：履歴が実際にある申請だけボタンを表示（無ければ非表示）、色も青に変更
  （一覧読み込み時に`shift_report_history`をまとめて1回のクエリで存在確認、N+1回避）

### デプロイ済みEdge Function（4本）
- `new-signup-notify`・`remind-scheduled`・`time-adjustment-notify`・
  `shift-report-confirmed-notify`（新規）

### 実行済みSQL
- `select cron.alter_job(...)` × 3（cron 5分おき化）
- `update notification_settings set template = replace(...)`（改行修正）
- `20260704000000_add_dismissed_to_notifications.sql`
- `20260704100000_add_banner_dismissed_to_notifications.sql`
- `20260704200000_drop_comment_enabled.sql`
- `20260704300000_fix_literal_newline_in_email_templates.sql`
- `20260705000000_add_shift_report_confirmed_notification.sql`

### 削除した未使用機能
- 連絡板「お知らせのコメント欄」（`comment_enabled`列、送信フォームにONにする手段が
  無く一度も使われていなかったため）

### ⚠️ 注意事項・保留事項
- 休憩時間の計算基準統一（「実労働＝休憩後」「通常シフト＝休憩前」で基準が不揃いという
  根本問題）は、「時間外」表示を削除する形で対応（数字を出さないことで誤解を防いだ）。
  根本的な計算ロジックの統一は依然未対応・保留
- `canSeeAll`（勤務変更申請「全スタッフ」タブ表示権限）に「社長」が含まれていない点を
  指摘したが、対応は保留（意図的か確認が必要）
- 新設した`shift_report:confirmed`イベントは、Slack・メールがデフォルトOFF。
  必要に応じて管理画面「勤務変更申請」から設定すること

### 確認内容
- `npx tsc --noEmit`：エラーなし（都度確認）
- ⚠️ 実機動作確認（TOPバナーのタップ遷移・自動消去、勤務変更受理の一斉通知が実際に
  届くか、欠勤フォームの表示等）は次回ローカル・本番での確認を推奨

---

## ✅ 2026-07-06 勤務変更申請：休憩時間ルール表示・外出/戻り記録機能 完了

### 1. 休憩時間ルールの折りたたみ表示を追加
- 注意事項パネル（勤務校リーダー・マネージャー一覧の下）に「▼ 休憩時間ルールを表示」
  ボタンを追加、押すと休憩時間の算出ルール（5段階の時間帯別ルール）を表示
- `showBreakRules` stateで開閉制御（既存の`showReviewerGuide`と同じパターン）

### 2. 外出・戻り記録機能（新機能）
- 背景：現状は出勤〜退勤の1区間のみ記録可能だったが、勤務中に一時外出するケースに
  対応できるよう、通常シフト・実際の勤務どちらにも「外出・戻り」を任意で記録できるようにした
- 実装前にvisualizeツールでイメージ画像を作成し、実際のフォームの見た目（時間入力の
  スタイル）に合わせて確認してから実装
- DB：`shift_reports`に`original_outing_start/end`・`actual_outing_start/end`（time型）を追加
- フォーム：「外出・戻りを記録する」チェックボックス（通常シフト・実際の勤務それぞれに
  独立して設置）→ チェックすると出勤〜退勤と同じデザインの時間入力行が出現
- 計算：外出時間は休憩時間と同様に労働時間から差し引く
  - 実労働 = (退勤−出勤) − 休憩 − 外出時間
  - 通常シフトの予定時間も同様に外出分を差し引く
- バリデーション：外出・戻りON時は開始・終了の入力必須、同時刻はエラー
- 反映箇所：確認画面（外出・戻り行を追加）、履歴（自分の申請／全スタッフ、
  変更前後の表示に「（外出 14:00〜15:00）」を追記）、管理画面テーブル（変更前/変更後
  列に外出行を追加）、CSV出力（変更前外出/変更前戻り/変更後外出/変更後戻りの列を追加）
- 修正履歴（▶修正履歴ボタンで展開する変更ログ）は自由記述テキストのみの仕様のため対応不要

### Supabase SQL（実行済み）
```sql
alter table public.shift_reports
  add column if not exists original_outing_start time,
  add column if not exists original_outing_end   time,
  add column if not exists actual_outing_start   time,
  add column if not exists actual_outing_end     time;
```

### 変更ファイル
- `client/src/pages/ShiftReportPage.tsx`
- `client/src/components/admin/ShiftReportsTab.tsx`
- `supabase/migrations/20260706000000_add_outing_time_to_shift_reports.sql`

### 確認内容
- `npx tsc -b`・`npx vite build`：両方成功（Vercelビルドエラーの教訓を踏まえ、
  今回から`tsc --noEmit`だけでなく実際のビルドコマンドで確認）
- ⚠️ 実機動作確認（外出・戻りチェックボックスの表示、労働時間の計算、履歴・管理画面
  への反映）は次回ローカル・本番での確認を推奨

---

## ✅ 2026-07-07 メール一斉送信のTo漏洩バグ修正・定期リマインド機能拡張 完了

### 1. メール一斉送信でTo欄に全員のアドレスが見えるバグを修正（重要・プライバシー問題）
- ユーザーがGmailで受信したリマインドメールのTo欄に受信者全員のアドレスが並んでいるのを発見・報告
- 原因：Resend APIの`to`に複数アドレスを配列でまとめて渡していたため、受信者全員が
  お互いのメールアドレスを見える状態になっていた
- 該当4箇所（UI/UXデザイナー・シニアエンジニアのサブエージェント2体でレビュー後、方針決定）
  - `encouragement-notify`・`remind-unread`・`remind-scheduled`：1人ずつループ送信＋
    送信失敗件数をログ出力する方式に変更（既存の`time-adjustment-notify`等と同じパターン）
  - `board-scheduled-send`（全社員30〜40人規模になりうる）：Resendの**バッチ送信API**
    （`POST /emails/batch`、宛先ごとに個別の`to`を持つメールを1回のAPIコールでまとめて送る）
    を直接呼ぶ専用ロジックに変更。`send-email`関数自体は「単一宛先」の契約のまま維持
    （バッチ対応させると他の呼び出し元への影響範囲が広がるため）
- 追加のセキュリティ強化（エンジニアレビューで指摘）
  - `send-email`に呼び出し元認証が無く外部から悪用され得た問題 → `supabase/config.toml`で
    `verify_jwt = true`に変更・デプロイ済み
  - それに伴い`UsersTab.tsx`の招待メール送信（認証ヘッダーなしの生fetch）を
    `supabase.functions.invoke()`に変更（自動でセッションJWTが付与される）
  - `send-email`に宛先件数の上限（5件）バリデーションを追加（誤操作による大量送信対策）

### 2. 「三役」連絡板チャンネルに管理者が紛れ込んでいた件（調査のみ・対応なし）
- 定期リマインドのテスト送信で、グループ管理画面上は3人のグループなのに実際は
  管理者を含む4人にメールが届いた件を調査
- 原因：連絡板の「グループチャンネル」作成時（`BoardSettingsTab.tsx`の`createChannel`）は
  作成者を自動で`board_channel_members`に追加する仕様のため。今回の「三役」チャンネルは
  過去に管理者自身が作成したため、選んだメンバーとは別に管理者も含まれていた
- ユーザー判断：**仕様のままでよい**（管理者を含めたままにする）→ コード変更なし

### 3. 有給奨励日パネルの開閉UI変更
- 管理画面「休暇申請」タブの📅有給奨励日一覧を、常時展開表示→**デフォルト全部閉じる、
  クリックで開くと進捗バー＋確認ボタンが表示**される方式に変更（`LeaveRequestsTab.tsx`）

### 4. 勤務変更申請フォーム：休憩時間ルール表示の開閉ボタンを削除
- 前回セッションで追加した「▲休憩時間ルールを閉じる」の開閉トグルボタンを削除し、
  常時展開表示に変更（内側の「▼休憩時間ルールを全て表示」だけ残す）。未使用になった
  `showBreakRules` stateも削除（`ShiftReportPage.tsx`）

### 5. 定期リマインドの送り先に「個別選択」を追加
- 今まで「グループ（連絡板チャンネル）」か「全員」しか選べなかった送り先に、
  スタッフを個別に複数選択できるモードを追加（`NotificationsTab.tsx`の`ScheduledRemindersPanel`）
- UIは「全員／グループ／個別選択」の3択ボタン。個別選択時は名前検索＋チェックボックスで選択
- DB：`board_scheduled_reminders`に`user_ids uuid[]`列を追加（設定されていれば
  グループ・全員より優先。`remind-scheduled`側で対応）

### 6. 定期リマインドの日付選択をボタングリッド化＋「月末日」オプション追加
- 「毎月」の日付指定を、カンマ区切りテキスト入力→**1〜31のボタングリッド（複数選択可）**に変更
- 別枠で「月末日」ボタンを追加（値`32`を特別値として使用）。「31日」とは意味を分離し、
  2月は28日（うるう年29日）、4/6/9/11月は30日など、月によって最終日が変わる月でも
  正しく毎月末に届くようにした（`remind-scheduled`側で「翌日のUTC日付が1日に戻る＝
  今日が月末」と判定）

### 7. 管理画面「リマインド設定」タブを独立
- 今まで「🔔通知設定」タブに同居していた「📅定期リマインド設定」「リマインドの
  何日前設定」を、新しい独立タブ「📅リマインド設定」に分離（`AdminPanel.tsx`・
  `AdminPanelContext.tsx`の`AdminTab`型に`scheduled_reminders`を追加）

### 8. 勤務変更申請フォーム：時間入力時は勤務地も必須に
- 「通常シフト」「実際に勤務した時間」どちらも、時間を入力した場合は勤務地（`origLoc`・
  `actLoc`）の選択も必須になるようバリデーションを追加（今まで「その他」選択時の
  自由入力のみ必須で、勤務地自体は未選択のまま送信できてしまっていた）。ラベルにも
  赤い`*`を追加し、他の必須項目と見た目を統一（`ShiftReportPage.tsx`）

### デプロイ済みEdge Function（5本）
- `encouragement-notify`・`remind-unread`・`remind-scheduled`・`board-scheduled-send`・
  `send-email`（`supabase functions deploy`でデプロイ済み、`send-email`は
  `verify_jwt: true`反映済みを確認済み）

### 実行済みSQL
- `20260707000000_add_user_ids_to_scheduled_reminders.sql`
  （`supabase db query --linked`で直接適用・列追加を確認済み）

### 変更ファイル
- `client/src/components/admin/LeaveRequestsTab.tsx`
- `client/src/components/admin/NotificationsTab.tsx`
- `client/src/components/admin/UsersTab.tsx`
- `client/src/components/AdminPanel.tsx`
- `client/src/components/admin/AdminPanelContext.tsx`
- `client/src/pages/ShiftReportPage.tsx`
- `supabase/config.toml`
- `supabase/functions/encouragement-notify/index.ts`
- `supabase/functions/remind-scheduled/index.ts`
- `supabase/functions/remind-unread/index.ts`
- `supabase/functions/board-scheduled-send/index.ts`
- `supabase/functions/send-email/index.ts`
- `supabase/migrations/20260707000000_add_user_ids_to_scheduled_reminders.sql`

### ⚠️ 注意事項・保留事項
- `send-email`の`verify_jwt = true`化により、今後この関数を新しい場所から呼ぶ時は
  必ず`supabase.functions.invoke()`（またはセッションJWT付きのfetch）を使うこと。
  認証ヘッダーなしの生fetchでは401になる
- 一斉メール送信を新規実装する時は、少人数ならループで1人ずつ`send-email`を呼び、
  全社員規模になりうる場合はResendのバッチ送信API（`/emails/batch`）を使うこと。
  `to`に複数アドレスを配列でそのまま渡さない（今回のバグの再発防止）
- 定期リマインドの「月末日」は値`32`を特別値として使っているため、`days`列に
  32が入っていても異常ではない
- 「三役」連絡板チャンネルへの管理者混入は意図的に対応しない方針で確定（他のグループ
  チャンネルにも同様の混入がある可能性はあるが、今回は指摘のみで未調査）

### 確認内容
- `npx tsc -b`・`npx vite build`：全変更を通して複数回実行し毎回成功を確認
- Edge Function側はDeno CLIがローカルに無いため目視レビューのみ（デプロイ後の
  ステータスは`supabase functions list`で`ACTIVE`・`verify_jwt`設定を確認済み）
- ⚠️ 実機動作確認（Toアドレス漏洩修正後の実際のメール受信、定期リマインドの個別選択・
  月末日ボタンの動作、リマインド設定タブの表示、勤務変更申請の勤務地必須バリデーション）
  は次回ローカル・本番での確認を推奨

---

## ✅ 2026-07-07（続き）通知メールへのリンク追加・勤務変更申請の勤務地必須化 完了

### 1. 通知メールにリンクが無い問題を調査・カテゴリごとに対応方針を決定
- ユーザーが「勤務変更申請が受理されました」メールにリンクが無いことを指摘
- 調査の結果、リンクがあるのは連絡板系（お知らせ・DM・グループメッセージ・未読リマインド）
  のみで、それ以外のほとんどの通知カテゴリにリンクが無いことが判明
- ユーザーと相談の上、以下の方針で確定
  - リンクを追加：勤務変更申請の受理／時間調整の登録／有給奨励日の未回答リマインド／
    休暇申請（新規・受理・差し戻し）
  - リンクなしのまま：定期リマインド、出張報告
  - 経費申請（`expense:new_request`）：申請者本人への受付確認メール（経理へは別途
    Slackで通知済み）と判明し、次の操作が無いためリンク不要と判断

### 2. 各通知にリンク変数を追加
- `shift-report-confirmed-notify`：`{{リンク}}` → `/shift-report?tab=history`
- `time-adjustment-notify`：`{{リンク}}` → `/leave?tab=history`
- `encouragement-notify`：`{{リンク}}` → `/leave`
- `leave:new_request`（承認者宛）：`{{リンク}}` → `/leave-approvals`
- `leave:leader_approved`（次承認者＝マネージャー宛）：`{{リンク}}` → `/leave-approvals`
- `leave:manager_approved`（申請者宛）：`{{リンク}}` → `/leave?tab=history`
- `leave:rejected`（申請者宛）：`{{リンク}}` → `/leave?tab=history`
- `NotificationsTab.tsx`の変数チップ一覧にも`{{リンク}}`を追加（管理画面での再編集用）

### 3. 副次的に発見したバグ修正：`leave:leader_approved`メールが実際は送信されていなかった
- `notification_settings`の`recipient`が`'approver'`と設定されているのに、
  `LeaveApprovals.tsx`の`dispatchEmail`呼び出しが`applicant`/`manager`キーしか
  渡しておらず、`approver`キーが未解決のまま`continue`されメールが送られていなかった
- `leave:new_request`と同様に`approver`キーにもマネージャーのメールアドレスを
  渡すよう修正（宛先設定が`approver`でも`manager`でも解決できるようになった）

### 4. 勤務変更申請フォーム：時間入力時は勤務地も必須に
- 「通常シフト」「実際に勤務した時間」どちらも、時間を入力する場合は勤務地
  （`origLoc`・`actLoc`）の選択も必須になるようバリデーションを追加（今まで「その他」
  選択時の自由入力のみ必須で、勤務地自体は未選択のまま送信できてしまっていた）。
  ラベルにも赤い`*`を追加し、他の必須項目と見た目を統一（`ShiftReportPage.tsx`）

### デプロイ済みEdge Function（3本）
- `shift-report-confirmed-notify`・`time-adjustment-notify`・`encouragement-notify`

### 実行済みSQL
- `20260707100000_add_link_to_email_templates.sql`
  （`supabase db query --linked`で直接適用。対象7イベントのメールテンプレート末尾に
  「下記のリンクからご確認ください。{{リンク}}」を追記・反映確認済み）

### 変更ファイル
- `client/src/components/LeaveApprovals.tsx`
- `client/src/components/LeaveRequest.tsx`
- `client/src/components/admin/LeaveRequestsTab.tsx`
- `client/src/components/admin/NotificationsTab.tsx`
- `client/src/pages/ShiftReportPage.tsx`（勤務地必須化）
- `supabase/functions/encouragement-notify/index.ts`
- `supabase/functions/shift-report-confirmed-notify/index.ts`
- `supabase/functions/time-adjustment-notify/index.ts`
- `supabase/migrations/20260707100000_add_link_to_email_templates.sql`

### ⚠️ 注意事項・保留事項
- リンク追加は本番DBのテンプレート更新＋Edge Functionデプロイまで完了済みだが、
  休暇申請系（`leave:new_request`/`leave:leader_approved`/`leave:manager_approved`/
  `leave:rejected`）のリンクはクライアント側コードでvarsに渡す仕組みのため、
  **今回のgit push（Vercel自動デプロイ）が完了するまで本番では反映されない**
  （それまでは休暇申請系メールの本文に`{{リンク}}`がそのまま表示される）
- 新しい通知カテゴリを追加する時は、リンクが必要かどうかを都度検討し、必要なら
  Edge Function側／dispatchEmail呼び出し側のvarsに`'リンク'`キーを追加し、
  `notification_settings`のテンプレートにも`{{リンク}}`を含めること

### 確認内容
- `npx tsc -b`・`npx vite build`：両方成功
- SQLの反映は`select event_key, template from notification_settings ...`で
  全7件に`{{リンク}}`が追加されていることを確認済み
- Edge Function 3本は`supabase functions deploy`でデプロイ済み
- ⚠️ 実機動作確認（休暇申請系メールのリンク反映はpush後、勤務変更申請の
  勤務地必須バリデーション）は次回ローカル・本番での確認を推奨

---

## ✅ 2026-07-07（続き2） スマホ戻るボタン対応（連絡板・勤務変更申請）完了

### 背景・経緯
- ユーザーから「連絡板で受信トレイのメッセージを見ていて戻るボタンを押すと、
  交通費申請など別ページに飛んでしまい、1つ前の受信トレイ一覧に戻らない」と報告
- 過去（2026-06-15〜16）に連絡板の戻るボタン対応は5回も方式を変えて実装が
  試みられ（pushStateセンチネル→go(1)→useBlocker→replaceState→navigate(replace)）、
  最終的に「ログアウト・通知復旧優先」として**全て無効化されたまま放置されていた**
  ことをgit log調査で判明（コミット`c57fc89`で削除）。CLAUDE.md 3375行目付近の
  記載は削除前の古い情報だった
- 過去の失敗はいずれも「独自にhistory.pushState/replaceStateやpopstateリスナーを
  操作し、ログアウト・通知遷移と衝突する」ことが原因と分析。今回はReact Router
  標準の`navigate()`/`useSearchParams()`だけで完結させ、ブラウザの戻る操作自体には
  一切介入しない設計に変更した

### 実装方式（今後同様の画面を作る時の指針）
1. 画面の深さ（詳細表示・チャンネル選択・確認ページ等）を**URLパラメータに反映**する
   （BoardPageは`bv`/`bsb`/`bch`/`bin`/`bout`/`bth`、ShiftReportPageは`view=confirm`）
2. 「進む」操作（メッセージを開く等）は`setSearchParams`で**push**（履歴に積む）
3. 「戻る」操作（← ボタン・閉じるボタン）は`setSearchParams`で新しい状態をpushする
   のではなく**`navigate(-1)`で1段階ポップする**
   → in-appの戻るボタンと物理戻るボタンが完全に同じ挙動になり、
     「pushState蓄積で何度も戻るボタンを押さないと抜けられない」問題を回避できる
4. メッセージ削除など**ユーザー操作ではない自動補正**は`replace: true`で
   履歴を汚さずにURLだけ直す（例：表示中のメッセージが削除された時にdetail idをクリア）
5. 1つのクリックハンドラ内で複数のstateを同時に変更する箇所が多いため、
   BoardPageでは`queueMicrotask`で同一イベント内の変更を1回のpush/replaceに
   まとめる仕組み（`patchBoardParams`）を実装。これが無いと1タップで履歴が
   複数積まれ、結局「戻るボタンを何度も押さないといけない」バグが再発する
6. 通知メール等の外部リンクで深い状態（例：`?openInboxId=xxx`, `?view=confirm`）
   にいきなり着地するケースは、そのままpushすると「戻る」でアプリの外
   （通知一覧やホーム）に出てしまう。**着地時に「TOPの状態にreplace」→
   「深い状態をpush」の2段階**にすることで、戻るボタンで必ずアプリ内のTOPに
   戻れるようにした（BoardPageの`openInboxId`処理、ShiftReportPageの
   `view=confirm`直接遷移処理）

### 変更ファイル
- `client/src/pages/BoardPage.tsx`
  - view/showSidebar/selectedChannelId/inboxDetailId/outboxDetailId/threadMsgId
    をすべてuseStateからURLパラメータ連動に変更
  - 各種「←」「✕」戻る系ボタンを`navigate(-1)`に統一
  - `resetToTop`（連絡板アイコン再タップ）は1段階戻るのではなく根本へのジャンプ
    なので`replace: true`で一括クリア
- `client/src/pages/ShiftReportPage.tsx`
  - `confirmView`（確認ページ表示）をuseStateからURLパラメータ（`view=confirm`）
    連動に変更、「‹」戻るボタンを`navigate(-1)`に変更
  - 通知メールから`?view=confirm`付きで直接遷移してきた場合のTOP経由化を追加

### ⚠️ 注意事項・保留事項
- 今回のURLパラメータ方式は、BoardPage・ShiftReportPage以外の画面
  （休暇申請・出張報告・交通費申請等）にはまだ適用していない。同様の
  「詳細を開いたまま戻るとページごと離脱する」報告があれば同じ方式で対応する
- BoardPageの`showChannelList`state・`window.confirm`（`deleteChannel`内）・
  `alert`（送信失敗時）は今回のスコープ外として温存（既存の別課題）
- **未デプロイ・未push**（このセッションでpush予定）

### 確認内容
- `npx tsc -b`・`npx vite build`：両方成功（BoardPage 140.75KB、ShiftReportPage 57.63KB）
- fivem-portalはClaude Codeのプライマリ作業ディレクトリ外のため`preview_start`が
  使えず、ビルド確認のみ。ユーザーが実機（ローカル`npm run dev`）で以下を確認済み：
  - 連絡板：受信トレイ詳細・送信トレイ詳細・チャンネル・スレッドから戻るボタンで
    1段階ずつ正しく戻れる
  - 勤務変更申請：確認ページから戻るボタンでTOP（申請/履歴タブ）に戻れる

---

## ✅ 2026-07-07（続き3） NavBarモバイル：ボタン横スワイプスクロール対応 完了

### 背景
- ユーザーから「スマホで見るとナビバー上部のアイコンが全部表示されない」と報告
- 調査の結果、管理者は最大7ボタン（管理・交通費・出張報告・休暇申請・休暇・
  勤務変更・連絡板）が並び、(44px+gap4px)×7≒336px に加え右側要素
  （👁確認セレクト・ベル・アバター≒124px）で必要幅が約470pxとなり、
  390px前後のスマホ画面に収まらないことが判明
  - 親コンテナ（`App.tsx`のNavBar）が`overflow: hidden`ではみ出しをクリップし、
    ボタン群コンテナも`overflowX`未設定でスクロールもできず、単に「見えない」
    状態になっていた
  - 2026-06-15に52px→44pxへ縮小して一度対応したが、その後「勤務変更」ボタンが
    増えて再びあふれた。これ以上の縮小はタップ性を損なうため却下し、
    ユーザーと相談の上「横スワイプスクロール」方式に決定
    （2段折り返し／「その他」メニュー集約は不採用）

### 実装内容
- `client/src/App.tsx`のNavBar：ボタン群コンテナに`overflowX: 'auto'`
  （モバイルのみ）を追加。右側要素（確認セレクト・ベル・アバター）は
  `flexShrink: 0`のまま常時固定表示を維持
  - スクロールバー自体は`.navbar-scroll`クラス（`::-webkit-scrollbar { display: none }`）
    で非表示にし、見た目上はスワイプ操作のみに統一（Firefox用に`scrollbarWidth: 'none'`も設定）
  - まだスクロールできる方向を示す半透明フェード（黒グラデーション、幅20px、
    `pointerEvents: none`）を左右に表示。`useRef`で取得したスクロール要素の
    `scrollLeft`/`scrollWidth`/`clientWidth`を`onScroll`・`resize`イベントで
    判定し`canScrollLeft`/`canScrollRight`のstateを更新
  - 連絡板の未読バッジ（ボタン右上に`-4px`はみ出す）が切れないよう、
    スクロールコンテナに`padding: 6px 4px`を確保
- `client/src/index.css`：`.navbar-scroll::-webkit-scrollbar { display: none; }`を追加

### ⚠️ 注意事項（今後同様のスクロール可能な横並びUIを作る時の指針）
- flexアイテムに`overflowX: auto`を効かせるには**`minWidth: 0`が必須**
  （デフォルトの`min-width: auto`だとコンテンツ幅ぶん親を押し広げてしまい、
  スクロールにならず単純にレイアウトが崩れる）。今回はボタン群コンテナ本体と、
  それを包む`position: relative`のフェード表示用ラッパーの両方に設定した
- フェードの表示判定は「ボタンの数が変わる可能性のある値」
  （`featurePublishState`・`isAdmin`・`canLeave`・`canShiftReport`・`canCalendar`）を
  useEffectの依存配列に含めること。これらは非同期に確定するため、初回マウント時の
  1回だけの判定だと機能公開設定によってはフェードの出現状態がズレる
- PC表示（`!isMobile`）は影響を受けないよう、`overflowX`は`isMobile`時のみ`'auto'`
  （それ以外は`'visible'`）にしている

### 変更ファイル
- `client/src/App.tsx`
- `client/src/index.css`

### 確認内容
- `npx tsc -b`・`npx vite build`：両方成功
- fivem-portalはプライマリ作業ディレクトリ外のため`preview_start`が使えず、
  ビルド確認のみ。ユーザーが実機（ローカル`npm run dev`、スマホ幅）で
  7ボタン全てへの横スワイプ到達・フェード表示・未読バッジ表示・
  右側要素の固定表示・PC幅での非影響を確認済み

---

## ✅ 2026-07-07（続き4） 新機能「備品購入申請・経費精算」Phase 1（精算フロー）実装・デプロイ完了

### 背景
- 総務部・上長からの指示による消耗品購入（文具・トイレットペーパー・掃除薬剤・
  ハンドソープ等）の実費精算が、レシートに手書き＋郵送／出勤伝票の流用という
  アナログな運用になっていた問題を解消したい、との相談から着手
- `/grill-me`で詳細ヒアリングし、最終的には「精算（承認ゲートなしの実費精算）」と
  「申請（金額に応じた3段階承認ルート付きの新規備品購入申請）」の2フロー構成で
  合意。ただし仕様量が大きいため**今回は「精算」フローのみ実装**し、「申請」フローは
  次回以降のセッションに持ち越し（設計はヒアリング済み、下記「将来フェーズ」参照）
- 実装前にPlanエージェント＋UI/UXデザイナー・シニアエンジニアの計2種のサブエージェントで
  設計レビューを実施してから着手（ユーザーからの明示的な依頼）

### 実装内容
- **DB**: `purchase_requests`テーブル新規作成（品目・金額・購入日・購入先・用途・
  指示者・支払方法・レシート情報等）。`request_type`列は将来`purchase_request`
  （申請フロー）を追加する前提で用意しつつ、CHECK制約で今回は`'reimbursement'`
  のみに絞り、未実装フローが暴発しないようガードしている
  - RLS: 本人は自分の記録をinsert/select、マネージャー以上・管理者は全件select
- **Supabase Storage初導入**: バケット`purchase-receipts`（非公開）、
  パス規約`{user_id}/{request_id}/{timestamp}_receipt.jpg`。RLSは**所有者チェックのみ**
  に留め、マネージャー以上の閲覧はテーブル側RLSに寄せる方針（Storage側でロール判定を
  二重管理しない。シニアエンジニアレビュー指摘を反映）
- **画像圧縮**（新規npm依存なし）: `client/src/lib/imageCompress.ts`。
  `createImageBitmap(file, { imageOrientation: 'from-image' })` + canvas +
  `toBlob('image/jpeg', 0.8)`で長辺1600pxに圧縮。`imageOrientation: 'from-image'`を
  指定しないとiPhone縦撮り写真がEXIF回転を無視されて横向きになるバグの定番パターンに
  なるため必須（シニアエンジニアレビュー指摘）。20MB超は拒否、HEIC等でcanvas処理が
  失敗した場合は元ファイルのままアップロードするフォールバックを実装
- **UI**: 新規専用ページ`/purchase`（タブ：精算／履歴）。ナビボタン「🧾備品精算」を
  1個だけ追加（既存ナビはこれ以上増やさない方針）
  - レシート添付は「写真アップロード／直接提出／レシートなし＋理由」の3択を
    **完全に対等な見た目**で提供（UI/UXレビュー：写真アップロードだけ強調すると、
    スマホ操作に不慣れな人・通信容量が気になる人がブロックされた気分になるため）
  - 支払方法は「①自分で立替えた（後日返金されます）／②会社カードで払った
    （記録のみ・返金なし）」という結果が明示される文言に（UI/UXレビュー：
    「精算」という画面名と「会社カード＝返金なし」が矛盾して混乱を招くため）
  - 必須4項目（品目名・金額・購入日・レシート）は常時表示、任意項目
    （数量・購入先・用途・指示者・備考）はデフォルト折りたたみ
- **公開範囲**: 既存の`feature_permissions`（role_idごとの機能ON/OFFテーブル、
  `FeaturePermissionsTab.tsx`で管理）にfeature_key `purchase_request`を追加する
  だけで対応。`useAuth.ts`に`canPurchaseRequest`を追加（`canLeave`等と同じパターン）
- **通知**: 精算記録時にマネージャー以上へsite通知のみ（email/slackは見送り）。
  役職ベースの一斉配信が必要なため、新規Edge Function
  `purchase-reimbursement-notify`を`shift-report-confirmed-notify`と同じパターンで作成

### デプロイ済み
- Migration: `20260707200000_create_purchase_requests.sql`
  （`supabase db push`は履歴が同期しておらず全migration再実行を試みて既存ポリシーと
  衝突したため中断→**`supabase db query --linked --file`で新規migrationファイルのみ
  直接適用**して解決。過去にも同様のケースがあり、この方式が確実）
- Edge Function: `purchase-reimbursement-notify`（`supabase functions deploy`）
- git commit・push済み

### ⚠️ 注意事項・ハマったポイント
- **`supabase db push`は使わない**：migration履歴（schema_migrations追跡テーブル）が
  過去に`db query --linked`で直接適用してきた分と同期しておらず、`db push`は
  「未適用」と誤認した古いmigration全部を再実行しようとして途中の
  `CREATE POLICY ... already exists`で失敗する。実害はない（トランザクション
  ロールバックで中断するだけ）が、**新しいmigrationを1本だけ適用したい時は
  `supabase db query --linked --file <path>` を使うこと**
- **ページの上部余白（固定ナビバー対策）は要注意**：ナビバーは`position: fixed`
  （高さ60px、プレビューバナー表示中92px）のため、各ページが自分でナビバーの
  高さぶんのpadding-topを確保しないとタイトルがナビバーの裏に隠れる。
  今回、新規ページ作成時にこれを見落として「タイトルが表示されない」バグを出した。
  さらに、既存ページ間でも「App.tsxラッパー側の110px」と「ページ自身の70px」で
  スタイルがバラバラだったため、以下に統一した：
  - 交通費申請・出張報告・休暇申請・休暇カレンダー・勤務変更申請・備品精算
    （＝タイトルのあるスタッフ向けページ）→ ラッパー`padding-top: 70px`に統一
  - 管理画面・連絡板・休暇申請承認（タイトルなし）→ 現状維持（ユーザー指示）
  - さらに、ラッパーのpadding-topを揃えても各ページのタイトル要素自身が持つ
    上マージン・パディングがバラバラだと見た目がズレる（例：出張報告は
    `<h2 marginBottom>`だけでmargin-topを明示しておらず、ブラウザデフォルトの
    h2上マージン約17pxが効いて他ページよりわずかに下にズレていた）。
    タイトル要素側の上余白も揃える必要がある
  - 既知の未解決事項：勤務変更申請・備品精算・連絡板の3ページは`paddingTop`が
    固定値（60px/70px）で、`--topbar-height` CSS変数（プレビューバナー表示中は
    92pxに変わる）に追従していないため、管理者のロールプレビュー中は
    余白がズレる。今回は指摘のみで未修正（影響範囲が限定的なため）

### 将来フェーズ（次回以降・未着手）
- Phase 2: 申請フロー（〜1万円・リーダー承認のみ）
- Phase 3: マネージャー承認（1万円超〜3万円）＋自己判断（共有のみ）チェックボックス
- Phase 4: 全員承認（3万円超・`purchase_request_approvals`子テーブル・全マネージャー
  ＋社長の全員一致、反対/保留時は協議の上での最終承認アクション）
- Phase 5: 管理画面タブでのCSV出力・Slack通知追加
- （詳細な承認ルート決定ロジック・DB設計はPlanエージェントによる調査済み。
  次回セッション開始時はこのセクションと会話履歴を参照）

### 実機動作確認（ユーザー確認済み）
- 交通費・出張報告・休暇申請・休暇カレンダー・勤務変更申請・備品精算の
  6ページでタイトル位置が揃ったことを確認
- 備品精算ページ：フォーム表示・レシート3択UIの表示を確認
- 管理画面`FeaturePermissionsTab`で「備品購入申請・経費精算」の表示・
  役職別トグルが機能することを確認（社長・管理者をON済み）

### 未確認（今後ローカル・本番で確認推奨）
- 実際にレシート写真をアップロードして自動圧縮・Storage保存が動くか
- 「直接提出する」「レシートなし＋理由」のパスで送信できるか
- マネージャー・社長アカウントで他人の精算記録が履歴タブから見えるか
- 精算記録時にマネージャー以上へのsite通知が届くか

---

## ✅ 2026-07-07（続き5） 備品精算フォーム「指示者」欄をドロップダウン化

### 経緯
- ユーザー実機確認中、「指示者（誰からの依頼か）」欄が自由入力＋datalist候補
  （テキストボックスに候補が薄く出るだけ）だったのに対し、休暇申請の
  「申請先を選択してください」のような`<select>`ドロップダウン（名前＋役職表示）の
  方が分かりやすいと指摘を受け変更
- 「個別選択＋自由記入も残したい」という要望だったため、リスト選択＋
  「その他（自由記述）」で自由入力にフォールバックする構成に

### 変更内容（`client/src/components/ReimbursementForm.tsx`のみ）
- 指示者欄をテキスト入力（datalist）から`<select>`ドロップダウンに変更
  - 選択肢：「総務部」／`role_title`が「リーダー」「マネージャー」の
    アクティブなスタッフ全員（`名前（役職）`表示、休暇申請の申請先選択と同じ表記）／
    「その他（自由記述）」
  - 「その他」選択時のみテキスト入力欄が下に表示される
    （休暇種別「その他」選択時に理由入力欄が出る既存パターンを踏襲）
  - 引き続き任意項目のまま（「詳しく入力する」の折りたたみ内、必須にはしない
    ── 指示者がいない自己判断購入もあるため）

### 確認内容
- `npx tsc -b`・`npx vite build`：両方成功
- ユーザーがローカルで表示確認済み
- DB・Edge Function変更なし（フロントエンドのみ）

---

## ✅ 2026-07-08〜09 備品購入申請「申請」フロー Phase 2・Phase 3 実装・デプロイ完了

### 背景
- Phase 1（精算フロー、承認ゲートなし）に続き、「申請」フロー（購入前に承認を得るタイプ）を
  金額帯ごとに段階実装。今回はPhase 2（〜1万円・リーダー承認のみ）とPhase 3（1万円超〜3万円・
  マネージャー承認 or 自己判断共有）まで実装。Phase 4（3万円超・全員承認）は次回以降に持ち越し
- 各Phaseとも実装前にPlanエージェントで設計調査 → UI/UXデザイナー・シニアエンジニアの
  サブエージェント2体でレビュー → 指摘反映 → 実装、というサイクルを踏襲

### Phase 2（〜1万円・リーダー承認のみ）実装内容
- **DB** (`supabase/migrations/20260708000000_add_purchase_request_flow.sql`)
  - `purchase_requests`に`leader_id`・`leader_approved_at`・`returned_reason`・
    `requested_purchase_date`（申請フロー専用の「購入予定日」。精算の`purchased_at`＝
    購入実績日とは意味を分離。シニアエンジニアレビュー指摘）を追加
  - `quotes`(jsonb配列 `[{"vendor":"...","amount":...}]`)・`quote_file_path`を追加し
    **相見積もり機能**を実装（ユーザー追加要望）：1万円以上は2社以上の相見積もり必須
    （DB CHECK制約`purchase_requests_quotes_required_check`で強制）、1万円未満は任意
    （コスト意識付けのため「比較しましたか」の記録欄として残す）
  - 見積書の写真/PDF添付は任意（`QuoteFileUploader.tsx`。既存の画像圧縮ロジックが
    canvas非対応形式で元ファイルにフォールバックする仕様を流用し、PDF分岐を追加不要で実現）
  - RLS: `pr_leader_select`/`pr_leader_update`（承認/差し戻しのみ許可）/`pr_applicant_resubmit`
    （差し戻し後の再申請、同一レコード編集方式。休暇申請のような新規行＋元申請cancelledの
    ツリー方式ではなく、承認段数が1段のみのため簡略化）
  - **承認者による申請内容改ざん防止トリガー** `protect_purchase_request_fields()` を新設
    （RLSのWITH CHECKだけでは「値が変わっていないこと」を強制できないため。シニアエンジニア
    レビューで「RPC化 or トリガーで補強」の指摘を受け、既存の`updated_at`トリガーと同じ手法
    で一貫性を保つためトリガー方式を採用）
  - 通知は新規Edge Function不要、既存`notificationDispatch.ts`の個人宛`dispatchSiteNotification`
    （leave:leader_approved等と同じ`recipients`配列方式）をそのまま流用
- **UI**: `/purchase`ページのタブを「精算／申請／履歴」＋権限者のみ表示「承認」タブ（計4タブ）に変更
  - `PurchaseRequestForm.tsx`（新規）：品目名・金額・購入予定日・承認リーダー選択・相見積もり欄
  - `PurchaseApprovals.tsx`（新規）：リーダー承認画面（承認/差し戻し、差し戻し理由入力）
  - 申請フォーム冒頭に「まだ購入していない場合はこちら」の固定案内、履歴タブには種別バッジ
    （精算/申請）とステータスバッジで区別
  - 差し戻し後は履歴タブに理由表示＋「修正して再申請する」ボタン（同一レコードを編集し
    ステータスを`pending_leader`に戻す方式）

### Phase 3（1万円超〜3万円・マネージャー承認 or 自己判断共有）実装内容
- **DB** (`supabase/migrations/20260709000000_add_purchase_request_manager_flow.sql`)
  - status追加：`pending_manager`/`manager_approved`/`self_judgment_shared`
  - `manager_id`（単数、`leader_id`と対称）と`shared_manager_ids`（uuid配列、自己判断共有ルート用）
    を**別列に分離**（当初`manager_ids`共用案だったが、シニアエンジニアレビューで
    「承認ルートと共有ルートは意味もライフサイクルも違うため列を分けるべき」との指摘を反映）
  - `is_self_judgment`列を追加、CHECK制約で「自己判断時はmanager_idがNULLかつ
    shared_manager_idsが1件以上」「非自己判断時はshared_manager_idsがNULL」という
    排他関係を強制（`purchase_requests_self_judgment_columns_check`）
  - `purchase_requests_type_status_check`を金額帯・自己判断フラグごとに許容status/列の
    組み合わせを縛るよう全面書き換え（1万円以下＝リーダー承認固定、1万円超＝マネージャー
    承認 or 自己判断共有のみ）
  - `purchase_requests_amount_band_check`で3万円超をガード（Phase4未実装のため暴発防止）
  - RLS: `pr_manager_select`/`pr_manager_update`（`manager_id`版、`pr_leader_*`と対称）、
    `pr_shared_manager_select`（自己判断の共有先マネージャーはFYI参照のみ、承認アクションなし）
  - 改ざん防止トリガーに`manager_id`/`shared_manager_ids`/`is_self_judgment`列を追加
  - 相見積もり必須ロジック（Phase2で追加済み、`amount>=10000`基準）は自己判断時も変更なく適用
- **UI**: `PurchaseRequestForm.tsx`を金額入力に応じて3段階（〜1万円/1万円超〜3万円/3万円超）で
  フォーム内容が変わる設計に拡張
  - 1万円超〜3万円：「承認を依頼する」／「自己判断で購入し、共有のみ行う」のラジオボタン2択
    （UI/UXレビューで「チェックボックスは承認スキップという重い判断には軽すぎる」と指摘され
    ラジオボタン化＋自己判断選択時は黄色警告枠＋確認文言「承認は不要になり、選択した
    マネージャーへの通知のみになります」を表示）
  - 自己判断時の共有先は同部署マネージャーから複数選択可（チェックボックス＋
    「◯名選択中」カウンタ表示）
  - 金額入力で1万円・3万円の閾値をまたぐと、承認者関連の入力（リーダー/マネージャー選択・
    自己判断チェック）だけをリセットし、「◯万円になったため承認に関する入力項目が
    変わりました」という通知バナーを表示（**自動消滅させず、✕ボタンで手動で閉じる方式**。
    ユーザー指示で「出したままでよい」に変更）。品目名・数量・購入予定日・相見積もり等の
    他の入力は保持
  - 3万円超は「現在3万円を超える申請フローは対応していません。連絡板で総務部にご相談
    ください」という事務的な行き止まり表示（UI/UXレビューで「今後実装予定」という時期の
    言及は不安を煽ると指摘され、Phase2の1万円超と同トーンに統一）
  - `PurchaseApprovals.tsx`をリーダー承認・マネージャー承認の統合画面に変更
    （`leader_id=userId`と`manager_id=userId`を2回クエリしてクライアント側マージ。
    `.or()`で無理に一本化せず可読性を優先、というシニアエンジュニアレビューの指摘を反映）。
    カードに「あなたの承認が必要（リーダー／マネージャー）」バッジを表示、自己判断案件は
    承認アクション不要のためこの画面には出さない

### 業務ルールの確定事項（ユーザー判断）
- 1万円未満でも相見積もり欄は残す（比較したかを記録し、コスト意識を持ってもらうため）
- 自己判断（共有のみ）でも相見積もりは引き続き必須
- 自己判断の共有先マネージャーは単一ではなく複数選択可（同部署の数名に送れるように）
- 1万円超〜3万円の申請は役職を問わず全員が使える（承認ゲートで金額に応じたチェックが
  かかるため、申請者を役職で絞る必要はないと判断）
- Phase4（3万円超・全マネージャー＋社長の全員承認、反対/保留時は協議のうえ最終承認）は
  構造が単一承認者フローと別物（複数承認者の個別回答管理・全員一致待ち・協議フローが必要）
  のため、今回は着手せず次回改めて設計から行う

### デプロイ済み
- Migration: `20260708000000_add_purchase_request_flow.sql`・
  `20260709000000_add_purchase_request_manager_flow.sql`
  （`supabase db query --linked --file`で順番に直接適用、`db push`は使用せず）
- Edge Function: 変更なし（新規Edge Functionは作らず、既存`notificationDispatch.ts`の
  クライアント側個人宛通知パターンで対応。Phase2設計時に一度「新規Edge Function作成」で
  計画していたが、既存の休暇申請等がこの方式で足りていると判明し不要と判断）
- git commit・push済み

### 未確認（今後ローカル・本番で確認推奨）
- Phase2：リーダー承認・差し戻し・再申請の一連の流れ、相見積もり必須バリデーション、
  見積書アップロード（画像/PDF）
- Phase3：マネージャー承認・差し戻し、自己判断（共有のみ）選択時の複数マネージャーへの
  通知、金額帯をまたいだ時のフォームリセット・バナー表示、承認画面でのリーダー/マネージャー
  バッジ出し分け
- 差し戻し→再申請で金額帯を書き換えて承認ルートが変わるケース（DB制約はあるが実機未確認）

### 次回以降のタスク（この時点、Phase2/3基本実装完了直後）
1. 上記「未確認」の実機動作確認一式
2. Phase 4（3万円超・全マネージャー＋社長の全員承認フロー）の設計から着手
   - 複数承認者の個別回答管理・全員一致待ち・反対/保留時の協議フローが必要
   - 管理画面CSV出力・Slack通知はPhase5として別途予定
3. 連絡板・勤務変更申請・備品精算の3ページで、プレビューバナー表示中（ナビバー92px時）に
   paddingTopが固定値のため余白がズレる既知バグ（未修正・影響軽微、[[fivem_portal]]参照）

---

## ✅ 2026-07-10〜11 備品購入申請 Phase 3 改修（複数マネージャー審議・自己判断の役職ベース判定化）

### 背景
上記Phase 2・3のデプロイ直後、ユーザーからのフィードバックで2点の設計変更が入った：
1. マネージャー承認ルートを「単一マネージャーが承認すれば確定」ではなく、
   「複数マネージャーに相談し、各自の意見を出し合ったうえで審議して決める」フローにしたい
2. 「自己判断（共有のみ）」はユーザーが任意で選べるラジオボタンではなく、**申請者自身の役職の
   決裁権限**で自動的に決まるべき（リーダーは1万円まで、マネージャーは3万円まで、自分の権限内
   なら承認不要で共有のみでよい）という業務ルールの誤解が発覚し、修正

いずれも実装前にPlanエージェント＋UI/UXデザイナー・シニアエンジニア2体のレビューサイクルを
踏襲してから着手。

### 1. 複数マネージャー審議機能

**要件確定までの経緯**：「複数マネージャーを選べるようにしたい」→「全員一致でなくてもマネー
ジャー審議のうえ購入できる、全員の意見が見えるようにしたい」→「意見は承認/否認/判断できない/
その他＋コメント」→「全員の意見が揃うまで最終決定不可、誰か1人が最終決定」という要件に対話で
段階的に確定した。

**DB** (`supabase/migrations/20260710000000_add_purchase_request_manager_deliberation.sql`)
- `manager_id`（単数）を`requested_manager_ids`（uuid配列、`shared_manager_ids`と対称）に
  置き換え（既存データはARRAY[manager_id]へ移行）
- 新規テーブル`purchase_request_manager_opinions`：各マネージャーが
  `opinion`（'approve'/'deny'/'undecided'/'other'）＋`comment`＋
  `visible_to_applicant`（回答者ごとに申請者への共有可否を選べる）を投稿。`unique(purchase_request_id, manager_id)`でupsert
- **「全員の意見が揃うまで最終決定不可」をDBトリガーでも強制**（UI回避・直接API呼び出し対策）：
  `enforce_manager_opinions_complete()`がBEFORE UPDATEで意見行数と依頼人数を比較し、
  不足時は例外を投げる。「判断できない」も有効な回答の1つとして数える（未回答とは区別）
- なりすまし対策：意見のinsert/updateは「実際にrequested_manager_idsに含まれる人か」を
  RLSのWITH CHECKで検証。最終決定後（status≠'pending_manager'）は意見の書き換えも禁止
- 改ざん防止トリガー`protect_purchase_request_fields()`の`manager_id`参照を
  `requested_manager_ids`のANY判定に書き換え（列名変更に伴う書き換え漏れが最重要リスクと
  シニアエンジニアレビューで指摘されたため特に注意して対応）

**UI**
- `PurchaseRequestForm.tsx`：承認依頼マネージャーをドロップダウン単一選択→チェックボックス
  複数選択に変更（「◯名選択中」カウンタ、依頼した全員の回答が揃うまで最終決定できない旨を注記）
- `PurchaseApprovals.tsx`：「意見を出す」（4択＋コメント＋申請者共有チェック、確定ではない）と
  「最終決定を押す」（承認する/差し戻す、これで確定）を色・配置・ボタン文言（「意見を送る」／
  「最終決定：承認する・差し戻す」）で明確に分離。全員の意見一覧（誰が何を回答したか、未回答者
  は名指し表示）、あと何人待ちかの表示、全員揃った後は「全員一致でなくても構いません」という
  能動的な案内文を表示（UI/UXレビューで「全員一致必須と誤解されるリスク」を指摘され対応）
- `PurchaseRequestPage.tsx`：履歴タブに、申請者への共有を選んだ意見（`visible_to_applicant=true`
  の行のみRLSで自動的にフィルタされる）を表示

**申請者への公開範囲**：UI/UXレビューで「否認やネガティブなコメントが申請者に直接見えると
心理的安全性の懸念がある」と指摘され、ユーザー判断で「回答者が意見ごとに申請者への共有可否を
選べる」方式に確定（集計のみ表示・全公開・非公開の3案から選択）

### 2. 「自己判断」を役職ベースの自動判定に変更

**背景**：実装済みだった「承認を依頼する／自己判断で購入し共有のみ行う」のラジオボタンは、
ユーザーの意図と異なっていた。正しい業務ルールは「申請者自身の役職の決裁権限」で自動的に
決まるというもの：
- リーダー以上（リーダー／マネージャー／社長）：1万円以下は自分の決裁権限内 → 自己判断可
- マネージャー以上（マネージャー／社長）：1万円超〜3万円も決裁権限内 → 自己判断可
- 上記に満たない役職（一般スタッフ、または金額が自分の権限を超える場合）：承認が必要
  （〜1万円はリーダーかマネージャーの承認、1万円超〜3万円はマネージャー複数人審議）

**DB** (`supabase/migrations/20260711000000_allow_self_judgment_at_leader_tier.sql`)
- 旧`purchase_requests_self_judgment_amount_check`（自己判断は1万円超のみ許可）を削除
- `purchase_requests_type_status_check`を、1万円以下でも`is_self_judgment=true`＋
  `status='self_judgment_shared'`を許容するよう拡張

**フロントエンド** (`PurchaseRequestForm.tsx`)
- ラジオボタン（`approvalMode`ステート）を完全に撤去
- `isAdmin`propを新規追加（`PurchaseRequestPage.tsx`から渡す）し、
  `roleTitle`と`isAdmin`から`canSelfJudge`（申請者がその金額帯の決裁権限を持つか）を算出、
  UIをその判定結果に応じて出し分け（ユーザーが選ぶのではなく自動判定）
- 承認ルール説明の案内文（水色ボックス）も、役職に応じた決裁権限の説明に文言修正

### デプロイ済み
- Migration: `20260710000000_add_purchase_request_manager_deliberation.sql`・
  `20260711000000_allow_self_judgment_at_leader_tier.sql`
  （`supabase db query --linked --file`で順番に適用）
- Edge Function: 変更なし
- `npx tsc -b`・`npx vite build`とも成功確認済み
- git commit・push済み

### 未確認（今後ローカル・本番で確認推奨）
- リーダー/マネージャー自身が申請者になった場合に、正しく「自己判断（共有のみ）」UIが
  自動表示されるか（一般スタッフでは表示されず承認依頼UIになるか）
- 複数マネージャーへの意見依頼・意見提出（upsert・変更）・全員揃うまで最終決定ボタンが
  disabledになるか・DBトリガーでのAPI直叩きガードの実際の動作
- 申請者への意見共有トグル（`visible_to_applicant`）が履歴タブに正しく反映されるか
- 意見提出時・全員揃った時の通知が実際に届くか

### 次回以降のタスク（旧・下記セクションで更新済み）
3. 連絡板・勤務変更申請・備品精算の3ページで、プレビューバナー表示中（ナビバー92px時）に
   paddingTopが固定値のため余白がズレる既知バグ（未修正・影響軽微、[[fivem_portal]]参照）

---

## 備品購入申請 Phase4・Phase5・複数商品対応（2026-07-04〜2026-07-06セッション）

### Phase4: 3万円超・全マネージャー＋社長の全員承認フロー
- 新カラム`board_approver_ids`（申請時に全マネージャー＋社長を自動選出・スナップショット、
  休職中・申請者自身は除外）、`board_approved_at`、`president_self_judgment`
  （社長本人が申請者の場合のみ「自己判断」/「全マネージャーに審議依頼」を選択可）
- status追加：`pending_board`／`board_approved`
- ゲート関数`enforce_board_opinions_complete()`（Phase3の`enforce_manager_opinions_complete()`
  とは別関数、Phase3のロジックは無変更）。全員回答が揃うまで最終決定不可、全員承認(approve)で
  揃った場合のみ`board_approved`へ遷移可、否認が混ざっていれば`returned`のみ許可
- 全員承認の自動確定はRPC `submit_board_opinion()`（意見提出のたびに全員approveか判定し、
  揃えば自動でboard_approvedに遷移、戻り値で「全員承認完了」をフロントに伝えてバナー表示）
- 否認時の扱い：即座に差し戻さず、全員の回答が揃うまで待ってから人間が最終判断（ユーザー決定）
- Phase3の潜在バグ修正：再申請時に前回のマネージャー意見が残ったまま誤判定される問題を
  `approval_round`列（申請・意見テーブル両方に追加）で解消。意見は削除せず履歴として残し、
  判定は常に「現在のapproval_roundの意見のみ」を対象にする
- 既存バグ発見・修正：`purchased_at`／`payment_method`／`receipt_type`が精算(reimbursement)
  フロー専用のNOT NULL列のままで、Phase2以降の「申請」フローが保存時に必ず失敗していた
  （申請フローでは値を入れていなかったため）。精算フローの場合のみ必須とするCHECK制約に置換

### Phase5: 管理画面CSV出力・Slack/メール通知
- 管理画面に新規「購入申請」タブ、全ステータス対象・1商品1行展開のCSV出力
- Slack通知・メール通知は主要4イベント（申請時・最終承認・差し戻し・全員承認自動確定）のみ。
  意見提出ごとの通知はサイト内通知のみ（Slack/メールには出さない）
- **重要**：Slack/メールの送信先チャンネル・宛先・有効無効は、既存の管理画面「通知設定」タブ
  （`notification_settings`テーブル、休暇申請等と同じ仕組み）から選択・変更できるようにした
  （コード側にハードコードしていない）。ただし依頼された全マネージャー・社長など「宛先が
  動的に決まる」イベント（`submitted_manager`/`submitted_board`/`self_judgment_shared`）の
  サイト通知・メールの宛先チェックボックスは実際には機能しない（コード側で自動計算するため）
  ので、説明文に置き換え済み

### 複数商品対応（大規模改修）
1申請で複数商品をまとめて申請できるようにする改修。設計はPlanエージェント→UI/UXデザイナー・
シニアエンジニアのサブエージェント2体レビューのサイクルを2周（一次設計→レビュー→最終設計）
経て確定。

**データモデル**：明細を別テーブルに分離する方式を採用（JSONB1列案は不採用。既存の金額帯
CHECK制約・トリガーを一切変更せずに済むため）
- `purchase_request_items`（商品明細：item_name/quantity/amount/amount_manually_overridden/
  store_name）
- `purchase_request_item_quotes`（商品ごとの相見積もり：vendor/unit_amount（単価）/note/
  quote_file_path/is_selected）。`is_selected=true`は商品内で最大1件という制約を部分ユニーク
  インデックスでDBレベルにも強制
- `purchase_requests`に`items_subtotal`（明細合計スナップショット）・`amount_diff_reason`
  （手動上書きで金額帯をまたいだ場合の理由・任意）・`amount_diff_flag`（GENERATED STORED、
  乖離があれば自動でtrue）・`location`（使用先）を追加

**金額の整合性設計**：申請金額(`amount`、承認ルートの金額帯判定に使う権威列)を手動上書きして
明細合計と乖離し、金額帯（1万/3万円）をまたいでも**送信はブロックしない**（ユーザー決定）。
ただし乖離は必ず`amount_diff_flag`/`amount_diff_reason`としてDBに記録し、承認画面・履歴・CSV
すべてに警告バッジとして表示することで、金額帯偽装の抑止力とする（シニアエンジニアレビューの
指摘：ブロックしない設計は監査上のリスクがあるため、必ず記録・可視化することで担保する方針）

**RPC**（`submit_purchase_request`・`select_purchase_item_quote`）に処理を集約：
- 送信（新規・再申請とも）は`submit_purchase_request(p_request_id, p_is_resubmit, p_header, p_items)`
  に一本化。商品0件送信を拒否、本体行＋明細を1トランザクションでコミット
- 相見積もりの「ここで購入予定」選択（1商品1社のみ）は`select_purchase_item_quote`で
  「解除→選択→金額再計算」を1トランザクションに集約（レースコンディション対策、
  シニアエンジニアレビュー指摘への対応）
- **既知バグ修正済み**：`p_header`にJSの`null`を渡すとjsonbとしては「JSON null（スカラー値）」
  になり、`COALESCE(..., '[]'::jsonb)`では空配列に変換されず`jsonb_array_elements_text`が
  「cannot extract elements from a scalar」で失敗する問題があった。`jsonb_typeof(...) = 'array'`
  で判定してから処理するよう修正（`20260719200000`で対応）。**今後同様のRPCを書く際は、
  JS側からnullを渡しうるjsonb配列パラメータは必ずjsonb_typeofで型チェックすること**

**フォーム**（`PurchaseRequestForm.tsx`、全面改修）：
- 商品はカード形式（`items: ItemDraft[]`）、2件以上で折りたたみ・進捗サマリー表示、
  「＋商品を追加」で新規カードの位置まで自動スクロール
- 相見積もりは素直なラジオボタン（チェックボックス＋内部排他制御のような紛らわしいUIは
  UI/UXレビューで却下された）。「金額を直接入力する（相見積もりを使わない）」もラジオの
  選択肢の1つとして用意（デフォルト選択）
- 業者を選択すると単価×数量で金額を自動計算、「上書きする」で手動編集モードに切替可能
  （切替後は自動計算に追従しない。業者を選び直すと自動計算に戻る）
- 業者選択中は「購入予定先（店舗名）」入力欄を隠し、選択業者名を自動的に店舗名として使用
  （店舗名欄は「金額を直接入力する」を選んだ場合のみ表示）
- 2件目以降の商品に「商品1の業者情報をコピー」ボタン（業者名のみコピー、単価はコピーしない
  ＝商品によって単価が異なりうるため）
- 商品が1件のみの場合は合計金額欄自体を非表示にし、その商品の金額がそのまま申請金額になる。
  2件以上で「合計金額」欄が出現し、各商品金額の自動合計に「自動追従→手動編集したら追従停止」
  という商品ごとの金額欄と同じパターンを適用（**実機バグ修正済み**：当初は商品数が1→2に
  変わった瞬間だけ初期化する実装だったため、後から商品の金額を変えても合計欄が追従せず、
  「合計金額」と「各商品の金額合計」が食い違うバグがあった）
- 数量は必須項目（1以上）に変更（当初は未入力のまま送信できてしまうバグがあった）
- 「使用先」はセレクト＋その他自由入力。**重要**：交通費の`trip_location_*`（お客様先の訪問先
  マスタ）ではなく、`workplace`カテゴリ（ファイブMの校舎自体、交通費申請の社内スタッフ向け
  「行き先」と同じマスタ）を使うのが正しい（当初trip_location_*を誤って使っていたバグを修正
  済み）
- 「用途」もセレクト＋その他自由入力（新規`master_options`カテゴリ`purchase_purpose`：
  レッスン用品／清掃用品／事務用品／教材／設備・備品／その他。「イベント」はユーザー指摘で削除）。
  プリセットを選んでも「詳細（任意）」欄で補足でき、`区分（詳細）`の形でpurpose列に保存
- 「事前に確認してもらう」（決裁権限内でも承認を求める選択肢）の依頼先は、実際はリーダー・
  マネージャー両方が選択肢に入っているが、ラベルが「リーダー」のみだったため
  「確認を依頼するリーダー・マネージャー」に修正
- 承認ルート判定の`amount`は「商品1件なら商品自体の金額、2件以上なら合計金額欄」で確定する
  設計（`isSelfJudgment`等の既存tier判定ロジックはこの`amount`を使うよう統一、ロジック自体は
  無変更）

**承認画面・履歴画面**（`PurchaseApprovals.tsx`/`PurchaseRequestPage.tsx`）：
- 共有コンポーネント`PurchaseItemsSummary`を新設（商品1件ならシンプル1行、2件以上は
  商品ごとにアコーディオンで相見積もり明細を展開）。承認・差し戻し・意見提出等の既存ロジック
  自体は無変更、表示部分のみ改修
- `amount_diff_flag`がtrueの申請はカード最上部に警告バッジ表示
- 通知文言の品目名は複数商品時「1件目（他N件）」形式に統一（`PurchaseApprovals.tsx`の
  承認・差し戻し・全員承認確定の通知箇所も含め全て対応済み）

**過去データの互換性**：明細テーブルへのバックフィルは行わず、`resolveItems()`関数
（`client/src/lib/purchaseItemsFallback.ts`）で「明細0件なら本体列(item_name/quantity/
amount/store_name/quotes)から1商品分を合成」というフォールバックで対応。承認画面・履歴・
CSV・フォーム再申請時の初期化すべてでこの関数を共通利用している

**CSV出力**：`generatePurchaseRequestCSVData`を1商品＝1行に展開する方式に全面書き換え
（交通費精算CSVの`expenses_data.forEach`と同じ考え方）。36列構成（申請ID・商品連番から
差し戻しラウンドまで）

### migration一覧（今回追加、20260707200000〜20260717000000は既存デプロイ済み・無変更）
```
20260712000000  Phase3バグ修正：approval_round列追加・意見テーブルのラウンド判定・FOR UPDATE強化
20260713000000  Phase4：board_approver_ids/board_approved_at/president_self_judgment列・status追加
20260713100000  Phase4：全マネージャー＋社長の自動選出トリガー
20260713200000  Phase4：ゲートトリガー・RLS・改ざん防止トリガー拡張
20260713300000  Phase4：submit_board_opinion RPC・通知設定
20260714000000  バグ修正：purchased_atのNOT NULL制約緩和（申請フロー対応）
20260715000000  Phase5：Slack通知設定（notification_settings）8イベント追加
20260716000000  Phase5：メール通知設定（notification_settings）8イベント追加
20260717000000  バグ修正：payment_method/receipt_typeのNOT NULL制約緩和（申請フロー対応）
20260718000000  複数商品対応：purchase_request_items テーブル新設
20260718100000  複数商品対応：purchase_request_item_quotes テーブル新設（部分ユニークインデックス）
20260718200000  複数商品対応：items_subtotal/amount_diff_reason/amount_diff_flag列追加
20260718300000  複数商品対応：明細テーブルのRLS
20260718400000  複数商品対応：select_purchase_item_quote RPC
20260718500000  複数商品対応：submit_purchase_request RPC
20260718600000  複数商品対応：purchase_requests.location列追加
20260718700000  複数商品対応：submit_purchase_request RPCにlocation対応を追加（CREATE OR REPLACE）
20260719000000  用途マスタ（purchase_purposeカテゴリ）7件追加
20260719100000  用途マスタから「イベント」を削除
20260719200000  submit_purchase_request RPCのnull配列処理バグ修正（jsonb_typeofで型チェック）
```
全てSupabase本番相当環境に`supabase db query --linked --file`で適用済み。

### 作業の進め方（今回のセッションで確立・重要）
- **サブエージェントに実装を依頼する際は「あなた自身が直接実装すること、他のサブエージェント
  への委任は絶対禁止」と明記すること**。1回、委任だけして実装を完了せずに終了するエージェントが
  いた（ファイル変更ゼロで「完了」と報告してきた）。以後は毎回この注意書きを入れている
- 大規模改修は Plan エージェント → UI/UXデザイナー・シニアエンジニアのサブエージェント2体レビュー
  → 指摘反映して最終設計確定 → 実装（DB→型/共通ロジック→フォーム→承認画面→履歴→CSV→通知の順で
  段階分割） のサイクルを踏襲
- 各実装ステップ完了後、必ず自分でも`git status`・`tsc -b`・`vite build`・（RPCなら）
  `pg_get_functiondef`等で内容を検証してから次に進む（サブエージェントの報告を鵜呑みにしない）
- ユーザーからのフィードバックは実機のスクリーンショット＋断片的な短い日本語コメントで来ることが
  多く、意図が曖昧な場合は実装前に理解を言い換えて確認する（今回も「使用先」のマスタ取り違え、
  「事前確認」の依頼先ラベル誤解などが、確認すれば防げた手戻りとして発生した）

### 次回以降のタスク
1. Phase4/Phase5/複数商品対応の実機での一連の動作確認（申請〜承認〜差し戻し〜再申請〜CSV出力の
   一通り）。特に複数商品×金額帯またぎ×差し戻し再申請の組み合わせは未確認
2. 連絡板・勤務変更申請・備品精算の3ページで、プレビューバナー表示中（ナビバー92px時）に
   paddingTopが固定値のため余白がズレる既知バグ（未修正・影響軽微、[[fivem_portal]]参照）
3. Slack Webhook環境変数（SLACK_WEBHOOK_LEADER/MANAGER/ACCOUNTING/PRESIDENT）が未設定の場合、
   購入申請のSlack通知は送信自体が失敗する（既存の休暇申請機能で設定済みなら流用されるので
   追加設定不要のはず、要確認）
4. 複数商品対応の明細テーブルへの過去データバックフィルは意図的に見送っている。将来的に
   本体列（item_name/quantity/amount/store_name/quotes）のフォールバック表示コードを
   廃止するかどうかの判断が必要になったら検討する

## 2026-07-19頃（続き：見積書PDF圧縮・管理画面「購入申請」タブに申請一覧を追加）

### 見積書PDFの圧縮（`QuoteFileUploader.tsx`）
- 従来はPDFを無圧縮のままアップロードしていた（画像のみ`compressImageFile`で圧縮）。
  ユーザーからのフィードバックで「PDFも圧縮してほしい」と要望があり対応
- 新規`client/src/lib/pdfCompress.ts`：PDFの各ページを`pdfjs-dist`でcanvasにラスタライズし、
  画像圧縮と同じ基準（長辺1600px・JPEG品質80%、`imageCompress.ts`の定数を共通利用）で
  再圧縮した上で、`pdf-lib`で1ページ1画像のPDFとして作り直す方式
- 新規npm依存：`pdfjs-dist`・`pdf-lib`。**重要**：`QuoteFileUploader.tsx`側では
  `import('../lib/pdfCompress')`による動的importを使い、PDFが実際に選択された時だけ
  読み込む設計にしている（静的importにすると`PurchaseRequestPage`の遅延読み込みチャンクに
  重い依存が常時バンドルされてしまい、通常ページの初回表示が遅くなるため。動的import化前は
  該当チャンクが76KB→922KBに肥大化することを確認した上で修正した）
- 30MB超の元PDFはエラーで拒否（画像は20MB上限、圧縮せず素通しのPDFは元は5MB上限にする案も
  検討したが、最終的に「常に圧縮する」方式に変更したため上限は緩め）
- 暗号化PDF等、pdfjsが処理できない場合は元ファイルのままアップロードするフォールバックあり

### 管理画面「購入申請」タブに申請一覧を追加
- 従来はCSV出力機能のみで、申請内容を画面上で確認する手段がなかった
  （ユーザーから「申請された内容が見えない」と指摘）
- `AdminPanelContext.tsx`に`fetchPurchaseRequestsList`を新設し、`purchase_requests`全件
  （明細・相見積もり・関係者名前も含む）を新しい順に取得。タブが`purchase_requests`に
  なった時に読み込む（既存の`users`/`trip_reports`等と同じ`useEffect`パターン）
- `PurchaseRequestsTab.tsx`に一覧UIを追加：全て/承認待ち/承認済み/差し戻しのフィルタタブ、
  各カードに申請者名・商品明細（`PurchaseItemsSummary`を再利用）・金額・ステータスバッジ・
  差し戻し理由を表示。既存の`PurchaseApprovals.tsx`/`PurchaseRequestPage.tsx`の
  カードデザインに準拠

### 未確認・要検証
- 実際にPDFをアップロードしてファイルサイズが縮小されているか、複数ページPDFの内容が
  正しく保持されるか（実機未確認）
- 管理画面の一覧・フィルタ表示が正しく動くか（実機未確認）
- ビルド確認は`tsc -b`・`vite build`とも成功済み

### 経理担当者への確認依頼（今後の運用）
- 上記の管理画面「購入申請」タブは経理担当者にも使ってもらう想定。ページ構成の説明と
  確認依頼文書を別途作成する予定

---

## ✅ 2026-07-07 作業メモ: 経費精算レシート・入力フォーム改善

### 今日の作業内容
- 経費精算のレシートアップロードで、スマホの写真フォルダ選択とカメラ撮影を別ボタンに分離。
- カメラ撮影後に入力内容が消える対策として、精算フォームの下書きをsessionStorageに一時保存。
- レシート写真アップロード中は送信ボタンを無効化し、「アップロード完了前に送信してエラーになる」問題を防止。
- 送信ボタン文言を「記録する」から「送信する」に変更。
- 精算フォームの入力順を見直し、詳しい入力欄を廃止して主要項目を最初から表示。
- 使用先・用途は備品購入申請と同じmaster_optionsを利用。
- 税務確認として、電子帳簿保存法・スキャナ保存では要件を満たせば紙原本を廃棄可能だが、現状は紙レシートも一定期間保管する運用が安全と確認。
- 画面文言として「紙のレシートは少なくとも3か月は保管してください」を追加。
- `npm run build` 成功確認済み。

### 今後の予定タスク
1. 本番反映後、スマホで経費精算を実機確認する。
2. 確認項目:
   - 写真フォルダからレシートを選べるか
   - カメラで撮影できるか
   - 撮影後に入力内容が消えないか
   - アップロード完了後に送信できるか
   - 購入点数・購入先・使用先・用途が正しく保存されるか
3. 紙レシート保管ルールを社内運用として最終決定する。
4. 将来的に紙原本を廃棄する運用にする場合は、電子帳簿保存法のスキャナ保存要件への対応を別途設計する。
5. 既存予定タスク:
   - 備品購入申請の実機確認
   - プレビューバナー表示中の余白ズレ修正
   - Slack Webhook環境変数確認
   - LINE通知機能は新機能候補として保留

### 作業ルール
- fivem-portal作業は、可能なら最初から `C:\Users\kohei\fivem-portal` を作業フォルダにしたCodexスレッドで開始する。
- 作業開始時は必ず `git pull` と `git status` を確認する。
- 修正後は `cd client && npm run build` を実行する。
- pushはユーザーの明示指示があるまで行わない。
- このセッションのように別プロジェクト作業フォルダから触ると、通常ファイルは編集できても `.git/index.lock` 権限エラーでcommitできない可能性がある。

---

## ✅ 2026-07-07 追加作業メモ: レシート撮影アップロード根本対策

### 今日の作業内容
- 経費精算フォームのレシート撮影で、スマホカメラ撮影後に「レシート写真のアップロードを完了してください」と出る問題を調査。
- 原因は、撮影自体はできていても、ブラウザの `input type="file" capture` 経由で返ってくるスマホ撮影画像がアプリ側で安定して処理・アップロード完了できないケースがあるためと判断。
- `ReceiptUploader.tsx` を根本修正し、「カメラで撮影する」をファイル入力任せではなくアプリ内カメラ方式に変更。
  - `navigator.mediaDevices.getUserMedia` でブラウザ内カメラを起動。
  - 画面内でレシートを撮影。
  - canvasでJPEG化してからSupabase Storageへアップロード。
  - 成功時のみ「レシートを添付しました」を表示。
  - カメラを起動できない端末では従来のカメラ入力へフォールバック。
- 画像圧縮処理も補強済み。
  - `createImageBitmap` が使えない/失敗する場合、Image要素での読み込み方式でもJPEG化を試す。
  - それでも処理できない形式のみ元ファイルアップロードにフォールバック。
- 送信時エラー文を「レシート欄に『レシートを添付しました』と表示されてから送信してください」に変更。
- `npm run build` 成功確認済み。

### 今後の予定タスク
1. 本番スマホで経費精算を再確認する。
2. 確認項目:
   - 「写真フォルダから選ぶ」で添付できるか。
   - 「カメラで撮影する」でアプリ内カメラが起動するか。
   - 「この写真を使う」後に「レシートを添付しました」と表示されるか。
   - 添付完了後に送信できるか。
   - カメラ許可を拒否した場合、フォルダ選択で回避できるか。
3. もしiPhone/Safariでアプリ内カメラが起動しない場合は、PWA表示・ブラウザ表示・カメラ許可状態を確認する。
4. 既存予定タスク:
   - 備品購入申請の実機確認。
   - 管理画面「購入申請」タブの確認。
   - 見積書PDF圧縮の実機確認。
   - プレビューバナー表示中の余白ズレ修正。
   - Slack Webhook環境変数確認。
   - LINE通知機能は新機能候補として保留。

### 作業ルール
- fivem-portal作業は `C:\Users\kohei\fivem-portal` を作業フォルダにして開始する。
- 作業開始時は必ず `git pull`、`git status`、`CLAUDE.md` の次回作業メモを確認する。
- 修正後は必ず `cd client` → `npm run build` を実行する。
- pushはユーザーの明示指示があるまで行わない。
- 現在のCodex環境では `.git/index.lock` 権限エラーで commit/push できないことがある。その場合はユーザー側ターミナルまたはClaude Codeで git 操作を行う。

---

## ✅ 2026-07-08 作業メモ: レシート撮影の画角/クラッシュ対策、管理画面「購入申請」タブ大規模再設計、重大バグ修正、申請理由欄の追加

### 今日の作業内容（レシート撮影まわり）
- カメラ黒画面バグを修正（起動中に`<video>`を条件レンダリングで外していたため、ストリーム接続先が存在しなかった）。
- 標準カメラアプリ方式（`input capture`）を一度試したが、低メモリ端末でページごとクラッシュする問題が発覚し撤回。
- 画像圧縮処理を`createImageBitmap`の縮小デコード方式に変更し、4800万画素超の写真でもフル解像度をメモリに展開しないよう修正（メモリ不足クラッシュの根本対策）。
- 最終的にアプリ内カメラ方式へ再度切替。`getUserMedia`の`width`/`height`固定指定をやめ`aspectRatio`のみ緩く指定し、機種依存の画角異常（狭いズーム・縦長すぎる等）を解消。プレビューは`object-fit: cover`で画面いっぱいに表示し、撮影結果もプレビュー表示範囲に合わせてcrop。
- 撮影後は必ず確認画面を挟む仕様に変更（即送信ではなく「この写真を使う/撮り直す」を選べる）。ラプラシアン分散によるぼやけ判定（`lib/blurDetect.ts`）を追加し、閾値を下回ったら警告バナーを表示（送信はブロックしない、あくまでヒント）。
- 上記のアプリ内カメラ機能一式を`CameraCaptureModal.tsx`として共通コンポーネント化し、`ReceiptUploader.tsx`（精算のレシート）と`QuoteFileUploader.tsx`（申請の見積書、新規に📷カメラボタン追加）の両方で共用。QuoteFileUploader側はPDF添付機能はそのまま維持。

### 今日の作業内容（管理画面「購入申請」タブ再設計）
- UI/UXデザイナー・シニアエンジニアの2体のサブエージェントでプランをレビューしてから実装（サブエージェント運用ルール適用）。
- 修正履歴ボタンは実際に履歴がある場合のみ表示・青色に変更。
- 一括選択＋zip一括ダウンロード（新規Edge Function `receipt-bulk-zip`。連続ダウンロードによるブラウザ確認ダイアログ連発を回避するため最初からzip化する設計）。
- 管理者代行の承認/差し戻し/取り消し操作を追加。
  - `purchaseApprovalActions.ts`に本人向け承認画面（`PurchaseApprovals.tsx`）と共通のロジックを切り出し、通知/Slack/メール送信も同一処理を再利用。
  - 同時実行対策として更新時に`.eq('status', 現在のステータス)`を必須化（他の操作者が先に処理していたら0件更新で無視される）。
  - 取り消しは金額帯・自己判断フラグから復元先ステータスを一意に算出する方式（新規列不要）。
  - `purchase_request_manager_opinions`への管理者SELECT権限が不足していた不具合を発見・修正（レビューで発覚、承認状況バッジ表示に必須）。
- 確認待ち/受理済み/差し戻し/すべてのステータスタブ、年度・申請者（人名検索）・使用先フィルタ、リセットボタンを追加。全体をコンパクト化。
- 立替払いの返金記録機能を追加（`reimbursed_at`列、支払方法バッジをタイトル行右に移動、クリックで返金日を任意入力・修正・取り消し、「未返金のみ」フィルタ）。

### 🚨重大バグ修正
- **1万円以上の備品購入申請が常に送信失敗する不具合を発見・修正**。複数商品対応（`submit_purchase_request` RPC導入）以降、相見積もりは`purchase_request_items`配下の新テーブルに保存されるようになったが、旧`purchase_requests.quotes`列に対する「1万円以上は2社以上必須」のCHECK制約が削除されておらず、quotesが常にNULLとなり全件失敗していた。制約を削除して即デプロイ（緊急対応）。

### 申請理由欄の追加
- 「用途」（分類）とは別に「申請理由」欄を新設。使用先・用途・申請理由を**金額に関わらず必須**に変更（クライアント側バリデーション＋DB CHECK制約とも）。
- 承認画面（`PurchaseApprovals.tsx`）では金額・品目のすぐ下に青枠で目立つ表示にし、承認者が読んでから判断できるようにした。
- CHECK制約は既存データ（reason未入力の過去分）を検証対象外にする`NOT VALID`で追加（新規行・更新行のみ適用）。
- `submit_purchase_request` RPCも同じマイグレーションでreason列の読み書きに対応させた（スキーマとRPCの追従漏れという今回の重大バグの教訓を踏まえた対応）。

### デプロイ状況
- DBマイグレーション・Edge Function・クライアントコードすべて本番適用・push済み。
- `tsc -b`・`vite build`とも成功確認済み。

### 今後の予定タスク
1. 本番スマホでレシート撮影（画角・ぼやけ警告・確認画面）を再確認する。
2. 管理画面「購入申請」タブの一括選択・zip一括ダウンロード・管理者代行承認/差し戻し/取り消しを実機確認する（今回新規実装のため特に重要）。
3. 1万円以上の備品購入申請が正常に送信できるようになったか実機確認する（重大バグ修正の検証）。
4. 使用先・用途・申請理由が必須化されたことで、過去の下書き（resubmit）データが引っかからないか確認する。
5. 既存予定タスク:
   - 見積書PDF圧縮の実機確認。
   - プレビューバナー表示中の余白ズレ修正。
   - Slack Webhook環境変数確認。
   - LINE通知機能は新機能候補として保留。

### 作業ルール
- fivem-portal作業は `C:\Users\kohei\fivem-portal` を作業フォルダにして開始する。
- 作業開始時は必ず `git pull`、`git status`、`CLAUDE.md` の次回作業メモを確認する。
- 修正後は必ず `cd client` → `npm run build`（`tsc -b` + `vite build`）を実行する。
- DBマイグレーションは`supabase db push`ではなく`supabase db query --linked --file`で直接適用する（このプロジェクトは履歴管理が不整合なため）。
- 既存データがある列にNOT NULL相当のCHECK制約を追加する場合は`NOT VALID`を使い、既存行を検証対象外にする。
- スキーマに列を追加する際は、その列を書き込むRPC/Edge Functionも同じマイグレーションで必ず更新する（追従漏れで全件失敗する重大バグを経験済み）。
- pushはユーザーの明示指示があるまで行わない。

---

## ✅ 2026-07-08 追加作業メモ: 購入申請「承認バナー」を他申請と同挙動に統一・相見積もり表示漏れ修正・ボタン文言統一

### 今日の作業内容
- **通知バナーの挙動統一**：備品購入申請の「全員承認依頼」等のバナーは今まで✕で対応せずに消せてしまっていた。休暇申請・勤務変更申請と同じ「専用集計バナー方式」に変更し、`PurchaseApprovalBanner`（✕ボタンなし、自分が意見を送信して対象から外れると自動的に消える）を新規追加。汎用の`NotificationBanner`側では`purchase_request:pending_approval`を除外対象に追加（`leave_request:pending_approval`/`shift_report:pending_approval`と同様の扱い）。
- **ナビタブへの未回答バッジ追加**：ナビバーの「🧾備品精算」タブに、連絡板の未読バッジと同じ赤丸で未回答件数を表示。`usePurchasePendingCount`フックを新規作成し、リーダー承認待ち＋マネージャー/全員承認のうち自分がまだ意見を送信していないものをカウント（承認ラウンド`approval_round`単位で判定、他の人が未回答でも自分が送信済みならカウントしない）。NavBarとPurchaseApprovalBannerの両方でこのフックを共用。
- **相見積もり表示漏れの修正**：`PurchaseItemsSummary.tsx`で、商品が1件のみの申請では相見積もり（業者名・単価・「購入予定」タグ・備考・見積書アイコン）が一切表示されない不具合を発見・修正。複数商品の場合は開閉式アコーディオンで正しく表示されていたが、単一商品の分岐（`items.length === 1`）にはその表示コード自体が存在しなかった。単一商品でも常時展開で相見積もりを表示するよう追加。
- **ボタン文言の統一**：マネージャー・全員承認の意見提出ボタンの文言を「意見を送る」→「意見を送信」に変更（アプリ内の他の送信ボタン、例：有給奨励日回答の「回答を送信」に合わせた）。送信中は「送信中...」表示に変更。
- ユーザーからの追加質問（「申請者本人がマネージャーの場合、自分にも承認依頼が来るのか」）に対し、`set_board_approver_ids()`トリガー（`20260713100000_add_purchase_request_board_approver_auto_select.sql`）で`AND id != NEW.user_id`により申請者自身は自動除外される仕様であることを確認・回答済み（コード変更なし）。
- `tsc -b`・`vite build`とも成功確認済み。

### 変更ファイル
- `client/src/App.tsx`（`usePurchasePendingCount`フック新規・`PurchaseApprovalBanner`新規・NavBarバッジ・`NotificationBanner`除外条件）
- `client/src/components/PurchaseItemsSummary.tsx`（単一商品時の相見積もり表示追加）
- `client/src/components/PurchaseApprovals.tsx`（ボタン文言変更）
- DBマイグレーションなし（フロントのみの変更）

### 今後の予定タスク
1. 本番でバナー・ナビバッジの動作を実機確認する（自分が意見を送信すると即座にバナー・バッジが消えるか）。
2. 相見積もりが1商品のみの申請でも正しく表示されるか実機確認する。
3. 既存予定タスク（2026-07-08時点の一連の実機確認、上記参照）：
   - レシート撮影（画角・ぼやけ警告・確認画面）
   - 管理画面「購入申請」タブの一括選択・zip一括ダウンロード・管理者代行承認/差し戻し/取り消し
   - 1万円以上の備品購入申請が正常に送信できるか（重大バグ修正の検証）
   - 使用先・用途・申請理由の必須化で過去の下書き（resubmit）が引っかからないか
   - 見積書PDF圧縮の実機確認／プレビューバナー余白ズレ修正／Slack Webhook環境変数確認／LINE通知は新機能候補として保留

### 作業ルール
- fivem-portal作業は `C:\Users\kohei\fivem-portal` を作業フォルダにして開始する。
- 作業開始時は必ず `git pull`、`git status`、`CLAUDE.md` の次回作業メモを確認する。
- 修正後は必ず `cd client` → `npm run build`（`tsc -b` + `vite build`）を実行する。
- pushはユーザーの明示指示があるまで行わない。
- 大規模な機能追加はUI/UXデザイナー・シニアエンジニアのサブエージェント2体でプランレビューしてから実装する。

---

## ✅ 2026-07-08 追加作業メモ: 新規登録の接続元IP表示・見積書ファイルの管理画面プレビュー機能

### 背景
- 管理画面のユーザー管理に、身元不明の新規登録（test@gmail.com／Test1）が来ていることに気づいた
- Supabaseの生ログ（`auth.audit_log_entries`は空だったため、Logsダッシュボードの「Auth」ログから`remote_addr`を取得）を手動で調査し、IPアドレス（210.56.151.14）とその国（オーストラリア・パース、ip-api.comで逆引き）を特定
- この手動調査を毎回やらずに済むよう、登録時に自動でIP・国を記録して管理画面に表示する機能を追加することにした

### 実装内容（新規登録IP表示）
- `profiles`テーブルに`signup_ip`・`signup_country`・`signup_city`列を追加（マイグレーション`20260719300000_add_signup_ip_to_profiles.sql`、適用済み）
- 新規Edge Function`record-signup-ip`（`verify_jwt = false`）を作成・デプロイ済み
  - リクエストヘッダーの`x-forwarded-for`先頭値を接続元IPとして取得
  - `ip-api.com`（無料・APIキー不要）へサーバーサイドで問い合わせ、国・都市を取得
  - `profiles`に`signup_ip`/`signup_country`/`signup_city`をservice role権限で書き込み
  - ⚠️ IPアドレスを外部サービス（ip-api.com）へ自動送信する設計のため、実装前にユーザーへ明示確認を取った（自動送信を許可する方針で承認済み）
- `SignIn.tsx`の`handleSignUp`：`signUp()`成功直後にこのEdge Functionをベストエフォートで呼び出し（`.then(null, () => {})`、失敗しても登録フロー自体はブロックしない）
- ユーザー管理画面の「🆕 承認待ちの新規登録」カード（`UsersTab.tsx`の`PendingUserRow`）に、IPアドレスと国・都市を小さい灰色文字で追加表示
- `AdminPanelContext.tsx`の`fetchUsers`クエリに`signup_ip, signup_country, signup_city`を追加

### 実装内容（見積書ファイルの管理画面プレビュー、副次対応）
- 上記調査の過程で、備品購入申請の相見積もり見積書ファイルが実際にはStorageに正しく保存されているにもかかわらず（DB・Storageとも実体確認済み）、承認/管理画面には「📎あり」を示す静的アイコンがあるだけでクリックして実際に開く手段がなかったことが判明
- `PurchaseItemsSummary.tsx`に`onViewFile`コールバックpropを追加。渡された場合のみ📎を「クリックして見積書を開くリンク」に変更（渡されない画面では従来通り静的アイコンのまま）
- 管理画面`PurchaseRequestsTab.tsx`にのみ配線（既存のレシート表示の仕組み`receiptView.ts`の`openReceiptImage()`・Edge Function`receipt-signed-url`を流用し、署名付きURLを新しいタブで開く）
- ~~あえてマネージャー承認画面（`PurchaseApprovals.tsx`）には配線していない~~ → 同日中の追加対応で解消済み（下記参照）

### デプロイ状況
- DBマイグレーション・Edge Function（`record-signup-ip`）とも本番適用・デプロイ済み
- クライアントコードはpush済み
- `tsc -b`・`vite build`とも成功確認済み

### 今後の検討事項
1. 新規登録のIP表示機能を実際にテスト登録で確認する（次回の新規登録時にIP・国が正しく表示されるか）
2. 既存予定タスク（2026-07-08時点、上記参照）は変更なし

---

## ✅ 2026-07-08 追加作業メモ: 見積書ファイルの閲覧権限を承認者（リーダー・マネージャー・社長）にも開放

### 背景
- 上記の見積書プレビュー機能は管理画面（`PurchaseRequestsTab.tsx`）にしか配線していなかった
- ユーザーから「承認者（リーダー・マネージャー・社長）にも見積書を見せたい。経費精算のレシートは社長がすでに見れているようだが」と指摘あり
- 調査の結果、「社長がレシートを見れている」のは役職による許可ではなく、**自分自身の申請を見ているとき（isOwner）は誰でも見れる**という既存ルールに該当していただけと判明（`receipt-signed-url`の`VIEW_ROLES`は今も`['管理者']`のみで、他人の経費精算レシートを社長ロールで見ることはできない）

### 実装内容
- `receipt-signed-url` Edge Function：`QUOTE_VIEW_ROLES = ['リーダー', 'マネージャー', '社長', '管理者']`を追加。パスに`_quote.`が含まれる（＝見積書ファイル）場合の**閲覧のみ**この拡張ロールを適用。ダウンロードは引き続き管理者のみ、経費精算レシート（`_quote.`を含まないパス）は従来通り本人または管理者のみに制限（変更なし）
- `PurchaseApprovals.tsx`（マネージャー/全員承認画面）にも`onViewFile`を配線し、見積書の📎リンクをクリックで開けるように変更

### デプロイ状況
- Edge Function（`receipt-signed-url`）再デプロイ済み
- クライアントコードpush済み
- `tsc -b`・`vite build`とも成功確認済み

---

## ✅ 2026-07-08 追加作業メモ: 履歴タブの見積書リンク配線漏れ・意見送信ボタンのフィードバック不足を修正

### 背景（実機確認で発覚）
- マネージャーとして実機確認したところ、承認画面（`PurchaseApprovals.tsx`）では見積書が見れるようになったが、`/purchase`ページの「履歴」タブ（`PurchaseRequestPage.tsx`内`HistoryList`）では見積書が見れないままだった
- 意見（承認/否認等）を送信しても画面に変化がなく、送信できたのか分からず何度もボタンを押せてしまう、との指摘

### 修正内容
- `PurchaseRequestPage.tsx`の`HistoryList`にも`onViewFile`を配線（`PurchaseRequestsTab.tsx`・`PurchaseApprovals.tsx`と同じ`openReceiptImage`を使用）。マネージャー以上は他人の履歴も見られる画面のため、見積書の閲覧権限は前回追加した`QUOTE_VIEW_ROLES`（リーダー・マネージャー・社長・管理者）にすでにカバーされている
- `PurchaseApprovals.tsx`：意見送信成功後3秒間、送信ボタンが緑色＋「✅ 送信しました」表示に変わるフィードバックを追加（`justSubmittedId`ステート）。連打自体はupsertのため実害はなかったが、完了が分からずUXが悪かった
  → **直後の追加対応で仕様変更**（下記参照）：3秒で元に戻る一時表示ではなく、送信後はフォームを恒久的にロックする方式に変更

### デプロイ状況
- フロントのみの変更（DBマイグレーション・Edge Functionの変更なし）
- `tsc -b`・`vite build`とも成功確認済み

---

## ✅ 2026-07-09 追加作業メモ: 意見送信後のフォームを恒久ロック方式に変更

### 背景
- 前回追加した「送信後3秒だけボタンが緑になる」フィードバックについて、ユーザーから「3秒経つとまた送信できてしまう。1回送信したらボタンを押せないようにして、修正したい時だけ『修正』ボタンで変更できるようにしてほしい」との指摘

### 修正内容
- `PurchaseApprovals.tsx`：`justSubmittedId`（3秒タイマー）を廃止し、`editingIds`（Set）ステートに変更
- 実際のDB上の回答有無（`requestOpinions`に自分の`manager_id`のレコードがあるか）を正として、既に回答済みなら常にロック状態で表示する（画面リロードしても状態が保持される。一時的なローカルstateではなく実データ基準）
- ロック中は緑の帯で「✅ 送信しました：{回答内容}」＋「✏️ 修正する」ボタンのみ表示。ラジオ/コメント欄/チェックボックスはグレーアウトして編集不可に
- 「修正する」を押すと`editingIds`にそのリクエストIDを追加してロック解除、フォームが再度編集可能になり送信ボタンの文言も「変更を送信」に変わる
- 送信が成功すると`editingIds`から削除して再びロック状態に戻る

### デプロイ状況
- フロントのみの変更（DBマイグレーション・Edge Functionの変更なし）
- `tsc -b`・`vite build`とも成功確認済み

---

## ✅ 2026-07-09 追加作業メモ: ストレージ容量の定期確認機能を追加

### 背景
- 「画像保存（レシート・見積書アップロード）の容量は大丈夫か」との質問を受け、`storage.objects`を直接SQLで調査
  → その時点でpurchase-receiptsバケット20ファイル・合計3.3MB（無料枠1GBの0.3%）と判明、当面問題なしと回答
- 「定期的に確認できるようにしたい」との要望を受け、自動アラート機能を作ろうとしたところ、
  外部Slack連携を伴う新規自動化パイプラインのため実装前にユーザーへ方針確認（結果：自動アラート＋管理画面表示の両方を作ることで合意）

### 実装内容
- SQL関数`public.get_storage_usage_mb()`を新規作成（`storage.objects`の合計サイズをMB単位で返す、`authenticated`ロールに実行権限付与）
- 管理画面ユーザー管理タブに「📦 ストレージ使用量: X MB / 1024MB（無料枠）」を表示（初版時点では700MB以上で赤字警告。**直後の追加対応で変更あり、下記参照**）
- 新規Edge Function`storage-usage-check`：`get_storage_usage_mb()`を呼び出し、閾値を超えたら
  - 管理者へサイト内通知
  - 経理Slack（`SLACK_WEBHOOK_ACCOUNTING`、未設定ならスキップ）に警告メッセージを送信
- pg_cronで毎月1日 9:00（JST）に`storage-usage-check`を自動実行するよう設定（jobid=14、`service_role_key`はVault経由）

### デプロイ状況
- マイグレーション（`20260719400000_add_storage_usage_check.sql`）・Edge Function（`storage-usage-check`）とも本番適用・デプロイ済み
- 動作確認：`get_storage_usage_mb()`実行結果 3.2MB
- `tsc -b`・`vite build`とも成功確認済み

---

## ✅ 2026-07-09 追加作業メモ: ストレージ使用量バッジの配置変更・Slack通知先追加

### 背景
- ユーザー管理タブ内の表示だと目立ちすぎる（「醜い」とのフィードバック）ため配置を再検討
- 「残り2割を切ったら赤色でアラート」という基準の希望あり
- Slack通知に社長チャンネルも追加してほしいとの要望あり

### 修正内容
- 表示場所を**ユーザー管理タブ内→「管理画面」タイトルの右上（`AdminPanel.tsx`）**に変更。全タブ共通ヘッダーのため、どのタブを開いていても常に見える
- 表示を2行に変更：1行目「📦 ストレージ使用量」、2行目「X MB / 1024MB（無料枠）」
- 警告の閾値を「700MB」→「819MB（無料枠1024MBの8割＝残り2割を切ったら）」に統一。バッジの赤字化条件とEdge Function側のアラート閾値（`ALERT_THRESHOLD_MB`）両方に反映
- Slack通知先に`SLACK_WEBHOOK_PRESIDENT`（`#03晃平先生へ`）を追加。既存の`SLACK_WEBHOOK_ACCOUNTING`（`#07_3閲覧禁止-経理専用`）と両方に送信するよう変更

### デプロイ状況
- `storage-usage-check` Edge Functionを2回再デプロイ済み（閾値変更→Slack追加の順）
- `tsc -b`・`vite build`とも成功確認済み
- DBマイグレーションの変更なし（SQL関数・cronジョブは前回のものをそのまま使用）

### 今後の検討事項
- 次回1日9:00のcron実行時に、実際にアラートが正しく動くか（閾値未満なら発火しない）を確認する
- 閾値（819MB）や頻度（毎月）は運用してみて調整可能

---

## ✅ 2026-07-09 追加作業メモ: 休暇申請「受理ページ」からの差し戻しに申請者通知が無かった不具合を修正

### 背景
- テスト依頼メッセージの文言を検討中、「承認・差し戻し後、申請者側に通知が正しく届くか確認してください」という一文について、実際の通知実装をユーザーと一緒に確認
- 調査の結果、休暇申請の差し戻しには2つの実装経路があり、**片方にしか通知処理が無い**という不整合が判明
  - 管理画面（`LeaveRequestsTab.tsx`）から管理者が差し戻す場合 → `leave:rejected`イベントでサイト内通知・Slack・メールが送信される（`notification_settings`の設定に従う）
  - リーダー・マネージャーが普段使う「受理ページ」（`LeaveApprovals.tsx`）から差し戻す場合 → **通知処理自体が一切呼ばれていなかった**（ステータス更新とGoogleカレンダー削除のみ）
- リーダー・マネージャーは基本的に「受理ページ」から操作するため、実運用ではほぼ「差し戻し通知が機能していない」状態に近かった
- 管理画面の「通知設定」タブで“差し戻し時：サイト通知ON・宛先「申請者本人」”という設定が表示されていても、この経路ではその設定自体が参照されずに無視されていた

### 修正内容
- `LeaveApprovals.tsx`の`handleReject`に、管理画面（`LeaveRequestsTab.tsx`）の差し戻し処理と同じ通知呼び出しを追加
  - サイト内通知：`shouldSend('leave:rejected', 'site')`が真の場合、`insertNotification`で申請者へ送信
  - Slack：`shouldSend('leave:rejected', 'slack')`が真の場合、`getNotificationRecipient`で設定されたチャンネルへ送信
  - メール：`dispatchEmail('leave:rejected', ...)`で申請者へ送信
- 既存の`notification_settings`（通知設定タブの「差し戻し時」ON/OFF・宛先設定）をそのまま参照する形にしたため、設定変更用のUIやテーブルの追加変更は不要
- `getNotificationRecipient`のimportを追加（既存の`shouldSend`等と同じ`notificationDispatch.ts`からの関数）

### デプロイ状況
- フロントのみの変更（`client/src/components/LeaveApprovals.tsx`のみ、DBマイグレーション・Edge Functionの変更なし）
- `tsc -b`・`vite build`とも成功確認済み

### 注意事項・今後のタスク
- **同種の「配線漏れ」パターンに要注意**：同じ機能（承認/差し戻し）が複数の画面（受理ページ／管理画面）に個別実装されている場合、片方だけ通知やロジックを追加して他方が漏れる、というミスが購入申請の見積書プレビューでも過去に発生している（[[fivem_portal]]参照）。今後、承認系フローを触る際は「受理ページ・管理画面・履歴タブ」など複数箇所への横断確認を毎回行うこと
- **実機確認済み**：リーダー・マネージャーが受理ページから差し戻した際、申請者へサイト内通知・メールが正しく届くことを確認済み（2026-07-09）
- 同一パターンの点検候補：
  - 勤務変更申請（shift report）の受理ページからの承認・差し戻しを調査した結果、休暇申請と同種の「画面間の配線漏れ」は**無かった**（受理ページ`ShiftReportPage.tsx`と管理画面`ShiftReportsTab.tsx`の通知処理は完全一致）。ただし差し戻し時はサイト内通知のみでSlack/メール通知の仕組み自体が存在しない（`notification_settings`に差し戻し用イベントキーが無い）ことが判明。これは「配線漏れ」ではなく「機能未実装」であり、今回は対応不要と判断（ユーザー確認済み）
  - 休暇申請の「社長の最終受理（admin_approved→approved）」ステップで申請者への通知コードが存在しない件は、**意図的な仕様と確認済み**（ユーザー回答、2026-07-09）。対応不要

---

## ✅ 2026-07-09 追加作業メモ: ストレージ使用量チェックのcron頻度を月次→週次に変更

### 背景
- ストレージ使用量バッジ・自動アラート機能の実機確認中、ユーザーから「月1回より毎週の方が良いのでは」との提案
- 現状使用量は3.3MB程度とごく小さいが、万一の大量アップロード等の異常に早く気づけるメリットがあるため、頻度を上げることに合意

### 修正内容
- 新規マイグレーション`20260709100000_storage_usage_check_weekly.sql`
  - 既存のcronジョブ`storage-usage-check-monthly`（毎月1日9:00 JST）を`cron.unschedule`
  - `storage-usage-check-weekly`として毎週月曜9:00 JST（`0 0 * * 1`）に`storage-usage-check`Edge Functionを呼ぶよう再登録
- Edge Function自体（`storage-usage-check`）・SQL関数（`get_storage_usage_mb`）は変更なし

### デプロイ状況
- `supabase db query --linked --file`で本番DBに直接適用済み（新ジョブID: 15、`cron.job`テーブルで`active: true`確認済み）
- Edge Functionの変更は無いため再デプロイ不要
- git push済み

### 今後の確認事項
- 次回月曜9:00の自動実行が正常に動くか確認（閾値未満なら発火しないはず）

---

## ✅ 2026-07-09 追加作業メモ: 休暇申請・勤務変更申請のナビバッジ追加

### 背景
- 備品精算タブに未回答件数の赤丸バッジがあるのを見て、ユーザーから「休暇申請・勤務変更にもバッジがあった方がいい」との提案（交通費は承認フローが別画面のため対象外と回答）

### 実装内容
- `App.tsx`に`useLeavePendingCount`・`useShiftPendingCount`フックを新規追加（`usePurchasePendingCount`と同じ構成）
  - 休暇申請：既存の`LeaveApprovalBanner`と同じ判定ロジック（`status=pending`かつ`approver_id=自分`／`status=step2_pending`かつ`approver2_id=自分`／社長は`admin_approved`も対象）を流用
  - 勤務変更：既存の`ShiftReportApprovalBanner`と同じ判定ロジック（`reviewer_id=自分`かつ`status in (pending, resubmitted)`）を流用
  - どちらも30秒ごとにポーリング（`useBoardUnread`と同じ方式。`usePurchasePendingCount`には無い定期更新だが、新規追加分は最初から入れておいた）
- NavBarの🌿休暇申請・⏰勤務変更ボタンに、🧾備品精算と同じ赤丸バッジUIを追加
  - 初版では休暇申請バッジは`/leave-approvals`を、勤務変更バッジは`/shift-report`を開いている時は非表示にしていたが、実機確認で「休暇申請だけ自分のページ（`/leave`）にいてもバッジが消えない」という不整合が発覚
    → 原因は、備品精算・勤務変更は申請/承認が同一URL内のタブ切り替えなのに対し、休暇申請だけ申請ページ（`/leave`）と受理ページ（`/leave-approvals`）のURLが分かれており、「/leave」を開いている時の非表示条件を書き忘れていたため
    → ユーザーと相談の上、「休暇申請だけ揃える」のではなく「3つとも自分のページにいても常にバッジを表示する」方式に統一することに決定（対応中の画面でも残り件数が常にナビバーで分かる方を優先。ページ内の「あと◯件」表示との重複は許容）
  - 最終的に3箇所（休暇申請・勤務変更・備品精算）とも`location.pathname !== '...'`という非表示条件を撤廃し、件数が1件以上ある限り常にバッジを表示する仕様に統一

### デプロイ状況（1回目：常時表示化）
- フロントのみの変更（`client/src/App.tsx`のみ、DBマイグレーション・Edge Functionの変更なし）
- `tsc -b`・`vite build`とも成功確認済み
- fivem-portalはClaude Codeのプライマリ作業ディレクトリ外のためpreview_startが使えず、実機でのバッジ表示確認はユーザーに依頼

### 追加対応：操作直後にバッジを即時更新（同セッション内）
- ユーザーから「30秒ごとのポーリングだと、承認した直後もバッジがすぐ減らないのでは」との指摘
- 30秒ごとの定期ポーリングは維持しつつ、承認・差し戻し・意見送信などの操作が完了した直後にも追加で1回再取得するよう変更
- 実装方式：`window.dispatchEvent(new CustomEvent('leave-pending-changed'))`（休暇申請）／`'shift-pending-changed'`（勤務変更）／`'purchase-pending-changed'`（備品精算）というカスタムイベントを、各操作完了時に発火。`App.tsx`側の各pendingCountフックはこのイベントをリッスンしてその場で再取得する（`board-reset`カスタムイベントの既存パターンを踏襲）
- 発火箇所：
  - `LeaveApprovals.tsx`：`handleApprove`・`handleApproveWithManager`・`handleReject`・「差し戻しを取り消す」ボタン
  - `ShiftReportPage.tsx`：`handleConfirm`・`handleReturn`・`executeCancelReport`
  - `PurchaseApprovals.tsx`：`handleApprove`・`handleReturn`・`submitOpinion`・`submitBoardOpinion`
- 連絡板（`useBoardUnread`）は対象外・現状維持（開いている間に既読処理で未読数が実際に減っていく仕組みのため、自分のページでは非表示のままで問題ないとユーザーと合意）
- 通信量への影響：既存の30秒ポーリングに対し、操作時にもう1回id一覧を取得するだけの軽いクエリが追加される程度で、ごく僅か

### デプロイ状況（2回目：即時更新）
- フロントのみの変更（`App.tsx`・`LeaveApprovals.tsx`・`ShiftReportPage.tsx`・`PurchaseApprovals.tsx`、DBマイグレーション・Edge Functionの変更なし）
- `tsc -b`・`vite build`とも成功確認済み

### 今後の確認事項
- 実機で、休暇申請・勤務変更・備品精算それぞれ、自分のページを開いている時もバッジが表示され続けるか確認
- 実機で、承認・差し戻し・意見送信の操作をした直後にバッジの数字がその場で減るか確認

---

## ✅ 2026-07-09 追加作業メモ: 備品購入申請「全員承認」ルートで、休職中などの承認者を外せる機能を追加

### 背景
- 管理画面「購入申請」タブの管理者代行承認/差し戻し機能を実機確認しようとした際、「全員承認（board）」ルートの申請には**そもそも承認ボタンが無く、差し戻しボタンも全員回答済みでないと押せない**仕様だと判明
- ユーザーから「対象の承認者が休職中などで回答できない場合、永久に止まってしまうのでは」と指摘。実際、指定された承認者（`requested_manager_ids`・`board_approver_ids`）の誰か1人でも長期間回答できないと、全員承認ルートは詰んでしまう設計上の穴だった
- 対応案（A: 承認者リストを編集できるようにする／B: 管理者の強制承認／C: 個別の棄権フラグ）をユーザーに提示し、**A（リスト編集）を推奨し採用**。理由：全員一致の合意という設計思想を壊さず、根本原因（回答不能な人が母数に残り続けていること）に直接対処できるため

### 実装内容
- 初版では`PurchaseRequestEditModal.tsx`（「✏️ 修正」ボタン、品目名・金額など申請内容全般を編集するモーダル）の中に承認者一覧セクションを追加していたが、ユーザーから「内容の修正とは別で、『全員承認待ち（残n名：...）』バナーの横に専用で出したい」との指摘を受け、**専用モーダルとして切り出し**
  - `PurchaseApproverEditModal.tsx`を新規作成（承認者一覧の表示・「外す」ボタン・理由入力・確定処理のみを持つ、内容修正とは独立した小さいモーダル）
  - `PurchaseRequestEditModal.tsx`は承認者機能を削除し、元の「申請内容の修正」専用に戻した
  - `PurchaseRequestsTab.tsx`の「② マネージャー確認待ち（残n名：...）」「全員承認待ち（残n名：...）」バナーの右端に「👤 メンバー編集」ボタンを追加し、そこから`PurchaseApproverEditModal`を開く
- 動作自体は変わらず：対象承認者（`board_approver_ids`または`requested_manager_ids`）を表示し、「外す」→理由入力（必須）→「この人を外す」で確定。確定すると該当配列からそのIDを除去して`purchase_requests`を更新し、`purchase_request_edit_log`に変更前後の名前一覧＋理由をセットで記録（既存の`changes`jsonbカラムに`reason`キーを追加する形。マイグレーション不要）。外した後もモーダルは閉じず、続けて別の承認者も外せる
- `PurchaseRequestEditHistoryModal.tsx`（修正履歴モーダル）に、承認者変更の理由を表示する行を追加、フィールドラベルに「承認者（全員承認）」「承認者（マネージャー）」を追加（変更なし、そのまま維持）

### デプロイ状況
- フロントのみの変更（新規`PurchaseApproverEditModal.tsx`、既存`PurchaseRequestEditModal.tsx`・`PurchaseRequestEditHistoryModal.tsx`・`PurchaseRequestsTab.tsx`、DBマイグレーション・Edge Functionの変更なし）
- `tsc -b`・`vite build`とも成功確認済み

### 今後の確認事項
- 実機で、マネージャー確認待ち・全員承認待ちのバナー横に「👤 メンバー編集」ボタンが表示され、そこから承認者を外せるか確認
- 理由入力が必須になっているか、修正履歴に理由が表示されるか確認
- 承認者を外した後、残りの承認者だけで正常に全員回答→自動確定のフローが機能するか確認
- テスト時、対象データの「申請理由」欄が空だと更新自体が制約エラーになる場合がある（2026-07-08の申請理由必須化がNOT VALIDのため、既存データの一部が該当）。実データでは新規申請は全て理由必須のため影響なし

---

## ✅ 2026-07-09 追加作業メモ: 承認メンバー編集機能のバグ修正（改ざん防止トリガー）・「戻す」機能追加

### 背景・発覚した不具合
- 実機テストで「承認者を外す」操作をしても保存に失敗する不具合を発見
- 原因：`protect_purchase_request_fields()`という改ざん防止トリガー（承認者が申請内容を勝手に書き換えられないようにする仕組み）が、**操作者が管理者かどうかを一切見ておらず**、「操作者がこの申請の承認者リスト（`leader_id`/`requested_manager_ids`/`board_approver_ids`）に含まれているか」だけで判定していた
- 今回のテストでは、操作していた管理者アカウントがこの申請の承認者としても登録されていたため、システムが「承認者本人が申請内容を書き換えようとしている」と誤判定し、正当な管理者操作までブロックしていた

### 修正内容（セキュリティチェックの緩和・ユーザー明示承認済み）
- `protect_purchase_request_fields()`トリガー関数の先頭に、「操作者が管理者ロール（`app_metadata.role = 'admin'`）なら、以降のチェックを全てスキップして常に許可する」という一文を追加
- これは「管理者なら誰でも何でもできる」に近い変更のため、実行前にユーザーへ変更内容を明確に確認し、明示的な承認（「はい、実行してください」）を得てから適用した。一度は自動セキュリティチェックでブロックされ、より明確な確認をやり直した経緯あり
- 一般の承認者（管理者以外）による申請内容の書き換え防止チェックは従来通り維持

### 追加要望への対応：「外す」だけでなく「戻す」もできるように
- ユーザーから「外した理由が見れない」「戻す機能がない」との指摘
- `purchase_request_edit_log`への記録方式を変更：承認者の`old`/`new`を「名前を繋げた文字列」ではなく**IDの配列**で保存するよう変更（元の実装は名前の文字列化のみで、後から「誰を戻すか」を機械的に特定できなかったため）
- `PurchaseApproverEditModal.tsx`に「外したメンバー」セクションを新設：編集ログを遡って、今は外れているが過去に外された記録がある人を一覧表示し、それぞれに理由・日時・「↩ 戻す」ボタンを表示。戻すと配列に追加し直し、その操作自体も同じログに記録される
- `PurchaseRequestEditHistoryModal.tsx`（修正履歴モーダル）もID配列形式に対応：承認者関連のフィールドは、ログに含まれるIDから名前を解決して表示するよう変更

### デプロイ状況
- DBマイグレーション：`20260709120000_admin_bypass_purchase_request_protect_trigger.sql`（`supabase db query --linked --file`で適用済み）
- フロントのみのその他変更（`PurchaseApproverEditModal.tsx`・`PurchaseRequestEditHistoryModal.tsx`）
- `tsc -b`・`vite build`とも成功確認済み

### 今後の確認事項
- 実機で、承認者を外した後に「外したメンバー」セクションに表示され、「戻す」で元に戻せるか確認
- 修正履歴モーダルで、承認者の変更が名前で正しく表示されるか確認

---

## ✅ 2026-07-09 追加作業メモ: 外したメンバーと理由を、モーダルを開かなくてもカード上に表示

### 背景
- ユーザーから「全員承認待ち（残n名：...）の下に、外した人と理由も表示してほしい」との要望
- それまでは「👤 メンバー編集」モーダルを開かないと、誰を外したか・なぜ外したかが分からなかった

### 実装内容
- `AdminPanelContext.tsx`の`fetchPurchaseRequestsList`内で、`purchase_request_edit_log`の取得列を`purchase_request_id`のみ→`purchase_request_id, changes, edited_at`に拡張し、承認者関連フィールド（`board_approver_ids`/`requested_manager_ids`）の変更を申請ごとに集計。「現在は外れているが過去に外された記録がある人」を`purchaseRequestRemovedApprovers`（`Record<申請ID, {id, reason, editedAt}[]>`）としてContextに追加
  - `PurchaseApproverEditModal.tsx`側の同種ロジック（過去ログから現在除外されている人を特定する処理）と同じ考え方だが、一覧画面用に申請ごと・一括で計算する形で複製
- `PurchaseRequestsTab.tsx`の各カードで、承認待ちバナーの直下に「外したメンバー：{名前}（理由：{理由}）」を表示するよう追加（モーダルを開かなくても見える）

### デプロイ状況
- フロントのみの変更（`AdminPanelContext.tsx`・`PurchaseRequestsTab.tsx`、DBマイグレーション・Edge Functionの変更なし）
- `tsc -b`・`vite build`とも成功確認済み

### 今後の確認事項
- 実機で、承認者を外した後にカード上（バナーの下）に「外したメンバー：◯◯（理由：...）」が表示されるか確認
- 「戻す」を押した後は、この表示が消えるか確認

---

## 🚨 2026-07-09 追加作業メモ: 承認者を外しても直後に別トリガーで6人に戻ってしまう重大バグを修正

### 発覚の経緯
- 「👤 メンバー編集」で外す→理由も保存されているのに、モーダルを開き直すと全員（6名）に戻っている、「戻す」を押していないのに戻る、という現象をユーザーが実機で発見
- DBを直接クエリして調査した結果、`purchase_request_edit_log`には「外した」記録（reason付き）が正しく残っているのに、`purchase_requests.board_approver_ids`自体は6人のまま変化していないことが判明

### 根本原因
- `set_board_approver_ids`という別のトリガー（3万円超の申請作成時に、承認メンバーを「全マネージャー＋社長」で自動セットする仕組み）が、**INSERT時だけでなくUPDATEのたびに毎回**発火し、承認者の更新を無条件に「全マネージャー＋社長」のリストで上書きし直していた
- そのため、管理画面から`board_approver_ids`を意図的に更新（承認者を外す）しても、同じトランザクション内でこのトリガーが直後に元の6人リストへ上書きしてしまい、更新自体は成功扱い（エラーなし）なのに実質何も変わっていなかった
- ログへの記録は別テーブル（`purchase_request_edit_log`）への独立したinsertのため、このトリガーの影響を受けず、「外した記録だけ残るが実データは変わらない」という食い違いが発生していた

### 修正内容
- `set_board_approver_ids()`トリガー関数を、「呼び出し側（管理者の更新操作）が`board_approver_ids`を既に明示的に変更している場合は、自動上書きをスキップする」よう修正
  - 判定方法：`TG_OP = 'INSERT'`（新規作成時）または`NEW.board_approver_ids IS NOT DISTINCT FROM OLD.board_approver_ids`（＝呼び出し側がこの列を触っていない＝他の項目の修正など）の場合のみ自動再計算する
  - 管理者が承認者を意図的に外す/戻す更新をした場合は、`NEW.board_approver_ids`が既に`OLD`と異なる値で来るため、この条件に該当せず、上書きされずそのまま反映される
- マイグレーション：`20260709130000_fix_set_board_approver_ids_trigger.sql`（本番DB適用済み）

### 追加要望への対応：モーダルに承認済み・コメントも表示
- ユーザーから「個人ページ同様に、承認済みの人・コメントも見えるようにしてほしい」との要望
- `PurchaseApproverEditModal.tsx`に`purchase_request_manager_opinions`（現在の`approval_round`分）を取得し、各承認者の名前の下に「承認／否認／判断できない／その他：コメント」または「未回答」を表示するよう追加（個人ページ`PurchaseRequestPage.tsx`の`HistoryList`と同じ`OPINION_LABEL`表示パターンを踏襲）

### デプロイ状況
- DBマイグレーション1本（`20260709130000_fix_set_board_approver_ids_trigger.sql`）を`supabase db query --linked --file`で適用済み
- フロントの変更（`PurchaseApproverEditModal.tsx`）
- `tsc -b`・`vite build`とも成功確認済み

### 今後の確認事項
- 実機で、承認者を外した後、モーダルを開き直しても・リロードしても、外れたままになっているか確認（今回の重大バグの再発防止確認）
- モーダルの各承認者の下に、回答内容（承認/否認/未回答＋コメント）が正しく表示されるか確認
- このトリガー修正が、通常の新規申請時（3万円超）の承認者自動セットに影響していないか確認（INSERT時の動作は変更していないはずだが、実際の新規申請テストで確認推奨）

---

## ✅ 2026-07-09 追加作業メモ: 承認・否認の回答表示を「メンバー編集モーダル」からカード本体に移動

### 背景
- 直前に実装した「モーダルの各承認者に回答状況（承認/否認/コメント）を表示」機能について、ユーザーから「メンバー編集モーダルではなく、カードの『全員承認待ち』バナーの下に出す方がよい」との指摘
- `PurchaseRequestsTab.tsx`側では、実は`opinionsByRequest`としてこの情報がカードごとに既に取得済みだった（未回答者数・バッジ表示のため）。ただし`comment`列だけ取得していなかった

### 実装内容
- `PurchaseApproverEditModal.tsx`：回答状況の表示・fetchを削除し、承認者を外す/戻す機能だけのシンプルな作りに戻した
- `PurchaseRequestsTab.tsx`：
  - `opinionsByRequest`取得クエリに`comment`列を追加
  - カードの承認待ちバナーの下に「回答済み：{名前}（承認/否認/コメント）」を表示（個人ページ`HistoryList`の「共有された意見」と同じ表示パターン）
  - 「外したメンバー：...」の表示はそのまま維持（回答状況とは別の行として両方表示）

### デプロイ状況
- フロントのみの変更（`PurchaseApproverEditModal.tsx`・`PurchaseRequestsTab.tsx`、DBマイグレーション・Edge Functionの変更なし）
- `tsc -b`・`vite build`とも成功確認済み

### 今後の確認事項
- 実機で、カードの「全員承認待ち」バナー下に回答済みメンバー・意見内容が表示されるか確認
- メンバー編集モーダルがシンプルな一覧（外す/戻すのみ）に戻っているか確認

---

## ✅ 2026-07-09 追加作業メモ: ダークモード時に読みにくい水色文字を白に修正（3箇所）＋全体調査

### 背景
- ユーザーから「休暇カレンダーの案内文・勤務変更の注意事項・備品精算の案内文が、ダークモードだと水色で読みにくい」との指摘

### 修正内容（3箇所）
- `CalendarPage.tsx`：「📅日付をタップして欠勤入力できます」等の案内文の色を、ダークモード時`#4a90d9`固定→`isDark ? '#fff' : '#4a90d9'`に変更
- `ShiftReportPage.tsx`：`noteText`・`noteTitleColor`（注意事項の本文・見出し色）を、ダークモード時`#90cdf4`→`#fff`に変更
- `PurchaseRequestForm.tsx`：申請フォーム冒頭の案内文（承認ルールの目安）の色を、ダークモード時`#9cc6ff`→`#fff`に変更

### 追加調査：同様パターンの全体調査（未修正・記録のみ）
- 上記3箇所と同じ「暗い背景に薄い青・水色系の文字色」パターンが他にも多数見つかったため、調査エージェントで全体調査を実施。以下は未修正のまま記録（ユーザーが今後、優先度と要否を判断する）
  - `BoardPage.tsx`：10箇所以上、`#93c5fd`（本文ラベル・宛先タグ・カテゴリラベル・返信者名など）
  - `LeaveRequestsTab.tsx`（管理画面）：4箇所、`#93c5fd`（休暇承認者名タグ・「もっと見る」ボタン）
  - `BoardSettingsTab.tsx`（管理画面）：4箇所、`#93c5fd`（「雇用形態」「役職」ラベル）
  - `LeaveRequest.tsx`（個人の休暇申請）：6箇所、`#90c9f5`・`#d0dde8`・`#90d0f0`・`#a8cfe8`・`#90caf9`（再申請見出し・案内文・ボタン文字）
  - `ShiftReportPage.tsx`：2箇所、`#7dd3fc`・`#90caf9`（通知メッセージ・ボタン文字。今回直した箇所とは別）
  - `ExpenseForm.tsx`（交通費）：5箇所、`#7fb3d3`・`#90caf9`・`#4a9eff`（見出し・交通手段タグ・金額表示）
  - `BusinessTripReport.tsx`：2箇所、`#80c8ff`（リンク風ボタン文字）
  - `ReimbursementForm.tsx`：1箇所、`#d6ecff`（注意書き）
  - `ReportsTab.tsx`（管理画面レポート）：7箇所、`#64b5f6`（統計ラベル・表の数値）

### デプロイ状況
- フロントのみの変更（`CalendarPage.tsx`・`ShiftReportPage.tsx`・`PurchaseRequestForm.tsx`、DBマイグレーション・Edge Functionの変更なし）
- `tsc -b`・`vite build`とも成功確認済み

### 今後の確認事項
- 実機で、休暇カレンダー・勤務変更申請・備品精算の3画面がダークモードで見やすくなったか確認
- 上記の未修正リストについて、対応要否をユーザーと相談して進める

---

## ✅ 2026-07-09 追加作業メモ: 支払方法の構造変更（立替／会社支払＋内訳）＋「申請」カードの誤表示修正

### 背景
- ユーザーから「支払方法に振込・代引き・その他も追加したい」との要望。大分類「立替（返金あり）」「会社支払（返金なし）」＋会社支払の内訳（会社カード／振込／代引き／その他）という設計で合意
- 実装のきっかけになったテスト中、「ウレタンマット（申請中の案件）」のカードに「会社カード（返金なし）」という支払方法バッジが表示されているのを発見。調査の結果、**支払方法はそもそも「精算」フロー専用の項目で、「申請」フォームには入力欄自体が無い**ことが判明。管理画面の修正モーダルが申請/精算を区別せず支払方法欄を出していたため、テストで誤って設定されてしまっていた

### 実装内容（支払方法の構造変更）
- マイグレーション`20260709110000_restructure_payment_method.sql`：`payment_method`列を`cash`/`company_paid`の2値に変更（既存の`company_card`データは`company_paid`＋新規列`payment_method_detail='company_card'`に自動移行）、新規列`payment_method_detail`（内訳）・`payment_method_other`（その他の自由記載）を追加
  - **一度適用に失敗**：UPDATE文で新しい値`company_paid`をセットする前に、古いCHECK制約（`cash`/`company_card`の2値限定）をまだ外していなかったため、その場で制約違反エラーになった。DROP CONSTRAINTをUPDATEより先に実行する順序に修正して再適用し成功
- `ReimbursementForm.tsx`（精算記録の入力画面）：支払い選択を「①立替えた／②会社支払」の2択にし、②を選ぶと内訳（会社カード／振込／代引き／その他＋自由記載）を選べるよう変更
- `PurchaseRequestEditModal.tsx`（管理画面の修正モーダル）：支払方法プルダウンを新構造（大分類＋内訳）に対応
- `utils/index.ts`に共通の`paymentMethodLabel()`関数を新設（CSV出力・各画面の表示ラベルで共通利用）

### 実装内容（「申請」カードへの誤表示修正）
- `PurchaseRequestEditModal.tsx`：支払方法欄を`record.request_type === 'reimbursement'`の時だけ表示するよう変更（「申請」の修正画面では非表示に）
- `PurchaseRequestsTab.tsx`（管理画面一覧）・`PurchaseRequestPage.tsx`（個人ページの履歴）：支払方法バッジの表示条件に`r.request_type === 'reimbursement'`を追加

### デプロイ状況
- DBマイグレーション1本（`20260709110000_restructure_payment_method.sql`）を`supabase db query --linked --file`で適用済み（実データの移行も確認済み：`company_card`だった6件が正しく`company_paid`＋内訳`company_card`に変換）
- フロントの変更（`ReimbursementForm.tsx`・`PurchaseRequestEditModal.tsx`・`PurchaseRequestsTab.tsx`・`PurchaseRequestPage.tsx`・`utils/index.ts`）
- `tsc -b`・`vite build`とも成功確認済み

### 今後の確認事項
- 実機で、精算記録画面から「会社支払」→内訳（振込・代引き・その他）を選んで送信できるか確認
- 「その他」を選んだ時、自由記載が必須になっているか確認
- 管理画面の修正モーダルで、「申請」の時は支払方法欄が表示されない・「精算」の時だけ表示されるか確認
- 「申請」カードから支払方法バッジ自体が消えているか確認

---

## ✅ 2026-07-09 セッションまとめ・ダークモード視認性の判断結果

### ダークモード`#93c5fd`（水色）18箇所について、ユーザー確認の上「現状維持」に決定
- 調査で見つかった`BoardPage.tsx`（10箇所以上）・`LeaveRequestsTab.tsx`（4箇所）・`BoardSettingsTab.tsx`（4箇所）の`#93c5fd`について、具体的な行番号・用途を一覧で提示して確認を依頼
- ユーザー回答：「確認したけど大丈夫、そのままで」→ **対応不要、現状維持**
- 残り未確認の箇所（`LeaveRequest.tsx`・`ExpenseForm.tsx`・`ShiftReportPage.tsx`の別2箇所・`BusinessTripReport.tsx`・`ReimbursementForm.tsx`・`ReportsTab.tsx`、色は`#90c9f5`・`#d0dde8`・`#90d0f0`・`#a8cfe8`・`#90caf9`・`#7dd3fc`・`#7fb3d3`・`#4a9eff`・`#80c8ff`・`#d6ecff`・`#64b5f6`など）は次回セッションで改めて確認予定

### 本日の作業まとめ（コミット e8bd34f 〜 462320b）
1. 休暇申請「受理ページ」からの差し戻し通知修正
2. ストレージ使用量チェックのcron頻度を月次→週次に変更
3. 休暇申請・勤務変更にナビバッジ追加、承認系バッジを常時表示+即時更新化
4. 承認者を外す機能を追加・専用モーダルに分離、関連する重大バグ2件（set_board_approver_idsの上書きバグ、protect_purchase_request_fieldsの管理者バイパス漏れ）を修正
5. ダークモード視認性修正（3箇所修正・全体調査実施）
6. 支払方法の構造変更（振込・代引き・その他追加）＋「申請」カードへの誤表示修正

### 今後の予定タスク（次回セッション優先順）
1. 支払方法（振込/代引き/その他）の入力・「その他」自由記載必須化の実機確認
2. 管理画面修正モーダルで「申請」の時は支払方法欄が出ない・「精算」の時だけ出るか確認
3. 「申請」カードから支払方法バッジが消えているか確認
4. 休暇カレンダー・勤務変更申請・備品精算のダークモード表示（水色→白）が見やすくなったか確認
5. ダークモード視認性の残り箇所（上記9箇所程度）を確認し、直すか判断する
6. 承認者を外す/戻す機能の実機確認（外した理由の記録・カード表示・戻すボタン）
7. 承認・否認の回答状況がカードの承認待ちバナー下に正しく表示されるか確認
8. 休暇申請・勤務変更・備品精算のナビバッジが常時表示され、操作直後に即時更新されるか確認
9. 次回月曜9:00のstorage-usage-check cron実行確認
10. 既存タスク：管理画面「購入申請」タブの一括選択・zipダウンロード・管理者代行承認/差し戻し/取り消しの実機確認、1万円以上の備品購入申請確認、使用先・用途・申請理由必須化の下書き確認、見積書PDF圧縮の実機確認／プレビューバナー余白ズレ修正／Slack Webhook環境変数確認／LINE通知は新機能候補として保留

### 作業ルール（追加分）
- マイグレーション内でCHECK制約を変更する時は、UPDATE文より先にDROP CONSTRAINTを実行する順序に注意（順序を誤ると、まだ有効な古い制約に新しい値が引っかかって失敗する。2026-07-09に実際に発生）
- セキュリティチェック（トリガーの管理者バイパス等）を緩める変更は、自動セキュリティ機構がブロックすることがあるため、何を・なぜ緩めるかを明確に説明し、曖昧でない明示的な承認を得てから実行する
- 専門用語を含む説明は、新卒社会人でも分かるように都度解説しながら説明する（[[feedback_explanation_style]]参照）

---

## ✅ 2026-07-10 出張報告：注意事項ボックス追加・Slack送信先文言の整理、備品精算のダークモード配色統一

### 背景・経緯
- ユーザーから「出張報告にも注意事項があった方がいいのでは」と提案があり、複数回の文言案のすり合わせを経て以下の内容に確定
- 途中、確認を取らずに実装してしまい指摘を受けた（[[feedback_deploy_and_work_start]]参照：**このプロジェクトでは実装前に必ず文面・方針を提案し、承認を得てから着手すること**）

### 実装内容（`BusinessTripReport.tsx`）
- 「到着」報告種別選択時：区分の直上に水色【注意事項】ボックス（勤務変更申請と同じ配色・ダークモード対応）を新規追加
  - 内容：①区分・場所・GPSを選択して報告 ②GPS取得できない場合の対処（Slack共有機能が無い旨の記載は「言わずもがな」のため削除）
- 「終了」報告種別選択時：同じ位置に【注意事項】ボックスを新規追加（①区分・場所・GPS+Slack送信先選択の案内、▷担当者（複数の場合は責任者）／▷担当者（責任者を除く）でSlack要否を分けて明記）
- 既存のSlack送信先チャンネル欄の黄色ボックス（●終了報告）の文言も整理
  - 送信先ルールを「【送信先】出張：出張後に向かう校／直帰・イベント終了時：所属チーム（こどもの場合は本校）」に統一（イベント終了時は直帰と同じ扱い、こどもの直帰・イベント終了時のみ本校、という例外構造を確定）
  - 責任者以外はSlack送信不要の一文はそのまま維持、改行を追加して見やすく整理

### 実装内容（備品精算のダークモード配色統一）
- 備品精算の4タブ（精算・申請・履歴・承認）が他画面と異なる紫系配色（`#1a1a2e`／`#2d2d3e`／`#3a3a5c`）だったのを、休暇申請等と同じ灰色系配色（`#212529`／`#343a40`／`#495057`）に統一
- 対象ファイル：`PurchaseRequestPage.tsx`・`ReimbursementForm.tsx`・`PurchaseRequestForm.tsx`・`PurchaseApprovals.tsx`・`PurchaseItemsSummary.tsx`
- **注意**：同じ紫系配色は連絡板・アカウント設定・グループ管理など他の画面でも広く使われている（意図的な別デザイン系統の可能性あり）。今回は備品精算のみ対応、他画面は対象外

### デプロイ状況
- フロントのみの変更（DBマイグレーション・Edge Functionの変更なし）
- `tsc -b`・`vite build`とも成功確認済み

### 今後の確認事項
- 実機で、出張報告の「到着」「終了」それぞれの注意事項ボックス表示・文言を確認
- 実機で、備品精算のダークモード配色が休暇申請などと揃って見えるか確認
- 連絡板・アカウント設定・グループ管理などの紫系配色を今後統一するかどうかは未検討（ユーザー判断待ち）

### 次回やること（優先順、上記に追加）
1. 出張報告の到着・終了の注意事項ボックス表示・文言の実機確認
2. 備品精算のダークモード配色統一の実機確認
3. 上記「2026-07-09セッションまとめ」の次回タスク1〜10は引き続き未確認

---

## ✅ 2026-07-10（続き）勤務変更申請：種別ラベルをダークモードで読みやすいバッジ表示に変更

### 背景
- ユーザーから「勤務変更申請の履歴・確認待ち一覧で、残業(青)・欠勤(赤)・勤務地変更(紫)などの種別ラベルがダークモードで見にくい」と指摘
- 原因：`TYPE_INFO`の色文字がそのままダークな背景に乗っているだけで、背景・枠が無かった（「受理済み」等のステータスバッジは背景付きなので問題なかった）

### 実装内容（`ShiftReportPage.tsx`）
- `TYPE_INFO`に種別ごとのダークモード用背景色`darkBg`を追加
- 共通ヘルパー`typeBadgeStyle(color, darkBg, isDark)`を新設：枠線は元の色のまま、背景はライトモードは薄い色付き・ダークモードは暗めの色付き、文字色はダークモードのみ白に変更（実装前にvisualizeツールでモックアップを提示し、ユーザー確認の上で「文字は白」に決定）
- 「確認待ち」一覧（承認者向け）と「履歴」一覧（申請者・管理者向け）の両方の種別ラベル表示に適用（同じ表示パターンが2箇所にあり、片方だけ直すと配線漏れになるため両方対応）

### デプロイ状況
- フロントのみの変更（DBマイグレーション・Edge Functionの変更なし）
- `tsc -b`・`vite build`とも成功確認済み

### 今後の確認事項
- 実機で、勤務変更申請の履歴・確認待ち一覧の種別バッジがダークモードで読みやすくなったか確認
- 同じ「色文字がそのまま置かれて読みにくい」パターンが他の画面にも残っていないか、次回以降で気づいたら都度対応

### 次回やること（優先順、上記に追加）
1. 勤務変更申請の種別バッジ（残業・欠勤・勤務地変更等）がダークモードで読みやすくなったか実機確認

---

## ✅ 2026-07-10 実機確認完了：直近デプロイ分の大半がOK判定

### ユーザーが実機確認し「OK」と回答した項目（対応完了・確認不要）
1. 勤務変更申請の種別バッジ（残業・欠勤・勤務地変更等）のダークモード表示
2. 出張報告「到着」「終了」それぞれの注意事項ボックスの表示・文言
3. 備品精算のダークモード配色（休暇申請等と統一）
4. 支払方法（振込/代引き/その他）の入力・「その他」自由記載必須化
5. 管理画面修正モーダルの支払方法欄（「申請」では非表示・「精算」でのみ表示）
6. 「申請」カードから支払方法バッジが消えていること
7. 休暇カレンダー・勤務変更申請・備品精算のダークモード表示（水色→白）
8. ダークモード視認性の残り箇所（LeaveRequest.tsx・ExpenseForm.tsx・ShiftReportPage.tsx他、計9箇所程度）→確認の上、対応不要と判断（`#93c5fd`系18箇所と合わせて全て現状維持で決定）
9. 承認者を外す/戻す機能（外した理由の記録・カード表示・戻すボタン）
10. 承認・否認の回答状況がカードの承認待ちバナー下に表示されること
11. 休暇申請・勤務変更・備品精算のナビバッジの常時表示・即時更新
12. 管理画面「購入申請」タブの一括選択・zipダウンロード・管理者代行承認/差し戻し/取り消し、見積書PDF圧縮の実機確認

→ 上記は全てこのCLAUDE.md上の該当タスクから削除・完了扱いとする

### 残っている確認事項（ユーザーからの指示あり）
- **storage-usage-check cronが毎週月曜9:00に正常実行されているか確認すること**
  → ユーザーから「よろしく、今度やって」と依頼あり。**次回セッションでClaude側から確認すること**
- プレビューバナー余白ズレ修正（連絡板・勤務変更申請・備品精算の3ページ、既知バグ・影響軽微・未修正）
- Slack Webhook環境変数の設定確認（未設定の場合、購入申請のSlack通知が送信失敗する）
- LINE通知は新機能候補として保留（着手時期未定）

---

## ✅ 2026-07-12 プッシュ通知の不達を修正・Chrome「不正な通知」判定の文面ルールを確立

### 背景
- ユーザーから「プッシュ通知が来ない」と報告。調査の結果、プッシュ通知機能（2026-06-13実装）は購読・DB・Service Workerは正常だが、**send-push Edge Functionが実装当初から一度も送信に成功していなかった**ことが判明

### 🚨 根本原因と修正（send-push Edge Function・デプロイ済みv2）
- **秘密鍵の読み込み形式の不一致**：VAPID秘密鍵（生32バイトのbase64url形式）をPKCS#8形式で読み込もうとして毎回例外→全送信が失敗（テスト結果 sent:0, failed:2）
- 修正：公開鍵からx/yを取り出しJWK形式でインポートする方式に変更 → sent:2, failed:0 で送信成功
- あわせて暗号化方式を旧aesgcm→現行標準のRFC 8291（aes128gcm）に更新（**旧方式はiPhone(web.push.apple.com)が受け付けない**ため、iPhone対応にも必須だった）
- 失敗時にHTTPステータス・エラー内容をレスポンスとログに含めるよう改善（従来は失敗数のみで調査困難だった）
- 404/410（購読期限切れ）の購読はDBから自動削除

### 🚨 Chrome「不正な疑いのある通知」問題と文面ルール（重要・実機テストで確立）
送信は成功したが、Android Chromeが通知を「不正な疑いのある通知」警告に置き換える問題が発生。
林晃平の実機で約20パターンをテストし、以下のルールを確立した：

**判定の仕組み（推定）**：Chromeは通知の文面を端末内AIで判定し、「行動を求める言葉」を
フィッシング（偽の宅配不在通知等はvercel.appドメインで大量発生している）とみなす。
vercel.app + 日本語という組み合わせで特に厳しい。

| 表現 | 判定 |
|---|---|
| 新着 ◯件／本日期限 ◯件／明日期限 ◯件／◯日後期限 ◯件 | ✅ OK |
| 差戻 ◯件（ひらがな無し）／未承認 ◯件 | ✅ OK |
| 英語文 | ✅ OK |
| 「確認」を含む全パターン（確認をお願いします・未確認・確認待ち・確認依頼） | ❌ 不正 |
| 「依頼」（承認依頼）／「〜待ち」（承認待ち）／「差し戻し」（ひらがな交じり） | ❌ 不正 |
| 文章形（〜してください・〜があります・〜について） | ❌ 不正 |
| 短時間の連続送信（5秒間隔×3通など） | ❌ 途中から警告に吸収される |

**→ プッシュ通知の文面ルール：「状態を表す漢字名詞 + 件数」のみ。
メッセージ本文は載せず、詳細はタップ先のサイトで見せる。**

### 実装内容（文面の修正・全てデプロイ済み）
- `BoardPage.tsx` 連絡板の催促ボタン：「📌 確認をお願いします」+本文50字 → 「ファイブM 連絡板／新着 1件」
- `remind-unread`：「⏰ 本日期限の連絡があります」+本文 → プッシュのみ「ファイブM 連絡板／本日期限 1件」（サイト内ベル通知・メールは従来の詳しい文面のまま、プッシュだけ分離）
- `remind-scheduled`：管理者の自由文をそのまま送信 → プッシュのみ固定「ファイブM リマインド／新着 1件」（ベル通知・メールは従来通り）

### その他の知見
- 通知が並ばない問題 → タグが異なれば正常に並ぶ（並ばなかったのは連続送信の警告吸収が原因）。アプリは元々メッセージごとに固有タグを使っており問題なし
- 文字化け → アプリ側の問題ではなく、Windowsシェルからcurlで日本語を直接送ったテスト手順の問題（教訓：**Bashツールでcurlに日本語ボディを渡す時は、printfでUTF-8ファイルに書き出して`--data-binary @file`で送る**。コマンド文字列への直接埋め込みやheredocスクリプト内の日本語はCP932化けする）
- 中期対応候補：独自ドメイン（portal.five-m.com等）への移行。vercel.appドメインへの疑いが緩和され、本文入り通知が通る可能性が高い。ただしDNS設定・URL周知・全員のプッシュ再許可（購読はドメイン単位）が必要（未着手・ユーザー判断待ち）

### デプロイ状況
- Edge Function 3本デプロイ済み：send-push(v2)・remind-unread(v5)・remind-scheduled(v6)
- フロント（BoardPage.tsx）は`tsc -b`・`vite build`成功確認済み、push待ち

### 今後の確認事項
- 実運用で連絡板の催促・期限リマインド・定期リマインドのプッシュ通知が警告なしで届くか
- 将来プッシュ通知を休暇申請・備品精算等に拡張する時は、上記文面ルール（状態名詞+件数）に従うこと。「差戻 1件」「未承認 1件」は実機テスト済みで使用可
- iPhoneユーザー（長岡・曽川）にaes128gcm化後の通知が届くか（未確認）

---

## ✅ 2026-07-12（続き）ユーザー管理に「プッシュ」列を追加（コミットc9b06d2）

### 実装内容
- ユーザー管理テーブルの「最終アクセス」と「状態」の間に「プッシュ」列を追加（許可中🔔／未設定－、ヘッダーにtitle属性で説明あり）
- `UsersTab.tsx`：push_subscriptionsからuser_id一覧を取得しSetで判定
- Migration `20260712000000_push_subscriptions_admin_select.sql`：push_subscriptionsに「管理者は閲覧可」のSELECTポリシーを追加（`supabase db query --linked --file`で適用済み。編集・削除は従来通り本人のみ）
- ローカルで表示確認済み（🔔が購読済み4人に付くことを確認）、git push済み

### 次回セッションの予定タスク（2026-07-12時点・優先順）
1. **storage-usage-check cronが毎週月曜9:00に正常実行されているか確認**（ユーザー依頼あり・Claude側から確認すること）
2. 実運用でプッシュ通知（連絡板の催促・期限リマインド・定期リマインド）が警告なしで届くか確認
3. iPhoneユーザー（長岡・曽川）にaes128gcm化後のプッシュ通知が届くか確認
4. 本番のユーザー管理画面「プッシュ」列の表示確認
5. プレビューバナー余白ズレ修正（連絡板・勤務変更申請・備品精算、既知バグ・影響軽微）
6. Slack Webhook環境変数の設定確認（未設定なら購入申請のSlack通知が失敗する）
7. 独自ドメイン（portal.five-m.com等）への移行検討（プッシュ通知の不正判定の根本緩和策。DNS設定・URL周知・全員のプッシュ再許可が必要、ユーザー判断待ち）
8. LINE通知は新機能候補として保留

### 作業ルール（今回の追加分）
- **プッシュ通知の文面は「状態を表す漢字名詞+件数」のみ**（新着◯件・本日期限◯件・差戻◯件・未承認◯件は実機テスト済みOK）。「確認」「依頼」「〜待ち」「差し戻し」・文章形・絵文字入り呼びかけ・短時間の連続送信はChromeが不正な通知と判定するため禁止。将来プッシュ通知を新機能に広げる時もこのルールに従い、新しい単語は実機テストしてから使う
- **Bashツールからcurlで日本語ボディを送る時は、printfでUTF-8ファイルに書き出して`--data-binary @file`で送る**（コマンド文字列への直接埋め込みやheredocスクリプト内の日本語はCP932化けする）
- git pushが2分でタイムアウトすることがある→run_in_background(バックグラウンド実行)で再試行すれば成功する

---

## ✅ 2026-07-13 ベル通知→スマホプッシュ通知の自動連動パイプラインを実装（本番動作確認済み）

### 背景・きっかけ
- 「サイト内ベル通知とプッシュは連動しているのか」というユーザーの問いから、連動していない（プッシュは連絡板系3箇所のみ個別配線）ことが判明
- ユーザー案「既存の通知設定のプッシュ列を足せばいい」を採用。プロUI/UXデザイナー＋シニアエンジニアのサブエージェント2体でプランレビュー後に実装
- レビュー結論：全ベル通知の一律連動はNG（通知疲れ・source_type未付与の誤分類）、「要対応イベントに絞る＋キュー方式」を推奨

### アーキテクチャ（案A'：トリガー→キュー→cronワーカー）
```
notifications INSERT
 → AFTER INSERTトリガー enqueue_push_notification（EXCEPTION捕捉・SECURITY DEFINER）
   が push_queue に積むだけ（購読者かつevent_key有り、同一user×event×refの重複は積まない）
 → pg_cron（1分毎）→ push-dispatch Edge Function
   が pending を user×event_key で集約し「ファイブM ○○／状態名詞 n件」で送信 → status更新
```
- **トリガーから直接pg_netを叩かない**：過去のVault事故（失敗が不可視）を踏まえ、キューに「見える形」で残す。プッシュ側が全滅してもベル通知本体は無傷（トリガーは必ずRETURN NEW）
- 集約により Chrome連続送信判定も回避、30行INSERT→30通問題も解消

### 実装ファイル
- Migration `20260720000000_create_push_pipeline.sql`：notifications.event_key列、push_queueテーブル（RLSポリシー無し＝クライアント遮断）、トリガー
- Migration `20260720100000_schedule_push_dispatch_and_seed_settings.sql`：push-dispatch cron（1分毎）、notification_settingsに'push'チャンネル行を19イベント分シード
- 新Edge Function `push-dispatch`：EVENT_MAP（event_key→アプリ名・状態語・URL）、notification_settings(channel='push')でON/OFF判定、集約送信、リトライ3回、7日超の掃除
- `send-push`：service_role認可チェック追加（🚨一般社員が任意文面を全社員に送れる穴を封鎖。token一致 or JWTのrole=service_role）
- 全発生源にevent_keyラベル付け：クライアント（notifications.ts/notificationDispatch.tsにeventKey引数追加、BoardPage・各承認画面・LeaveRequestsTab）、Edge Function（remind-unread/remind-scheduled/board-scheduled-send/encouragement-notify）
- **二重送信排除**：remind-unread/remind-scheduledの直接send-push呼び出しを削除しパイプライン一本化。BoardPage催促ボタンもinsertNotification経由に変更
- `NotificationsTab.tsx`：pushチャンネル列（📱ON/OFFトグルのみ、文面はシステム固定の説明付き）、shift_report:new_request/returned・board:confirm_request・purchase_request:manager_opinions_readyをイベント一覧に追加

### プッシュ対象イベント（EVENT_MAP・状態名詞は実機テスト済みの安全語のみ）
- 休暇：申請/受理系→「未承認 n件」、差戻→「差戻 n件」
- 勤務変更：申請→「未承認」、差戻→「差戻」
- 備品：申請各ルート・意見出揃い→「未承認」、差戻→「差戻」
- 交通費申請→「新着」、連絡板（notice/dm/group/confirm）→「新着」
- リマインド：本日期限→「本日期限」、明日期限→「明日期限」、それ以外→「新着」

### デプロイ・動作確認
- Migration 2本適用済み、Edge Function 6本デプロイ済み（push-dispatch新規・send-push・remind-unread・remind-scheduled・board-scheduled-send・encouragement-notify）
- cron `push-dispatch-every-min` 登録・active確認済み
- **本番E2Eテスト成功**：notifications INSERT→push_queue pending→cron→sent→林晃平の実機に「ファイブM 連絡板／新着 1件」着信を確認
- send-pushの認可：anon keyでの直接呼び出しが403になることを確認（穴が塞がった）
- `tsc -b`・`vite build`成功
- **途中のハマり**：cronからの呼び出しがVault保存のservice_role_key（JWT形式）でtoken完全一致にならず403全滅→JWTのrole=service_roleも許可する二段構えに修正して解決

### 今後の確認事項・残タスク
- 各イベント種別のプッシュが実運用で正しく届くか（現状board:noticeのみ実機確認済み。休暇/勤務変更/備品の承認系は未確認）
- 管理画面「通知設定」タブのプッシュ列トグルが保存・反映されるか実機確認
- iPhoneユーザー（長岡・曽川）への到達確認
- 通知タップ後のカテゴリ別URL遷移（/leave-approvals等）が正しいか確認
- （デザイナー提案の将来分）結果系の集約配信・quiet hours・iPhone購読導線ガイドは未実装

---

## ✅ 2026-07-13（続き）プッシュ通知の役職選択・CC送信・結果報告系追加＋見積リンク/下書き/ナビ消失バグ修正

### プッシュ通知の拡張
1. **一斉通知系3イベントに役職選択プッシュを追加**（勤務変更 受理時／時間調整 登録時／立替精算 記録時）
   - サイト通知とは別に、プッシュだけ別の役職・グループに送れる。各Edge Function（shift-report-confirmed-notify・time-adjustment-notify・purchase-reimbursement-notify）が'push'チャンネルのrecipient（役職）を解決し、購読者に直接send-push（パイプライン非経由なので二重送信なし）
   - Migration `20260720200000`：勤務変更/時間調整=リーダー〜社長・同グループ、立替精算=社長のみ（全てON）でシード
2. **CC送信を配線**（承認フロー系プッシュに「追加でプッシュする役職（任意）」）
   - 管理画面で役職を選ぶと、本来の宛先＋その役職の人にもプッシュ。空欄なら追加送信なし
   - push-dispatchワーカーが notification_settings の recipient に `{"ccRoles":[...]}` を読み、本来の宛先と重複しない購読者へ送信。実機テストで `{"sent":1,"cc":1}` 確認済み
3. **備品購入の結果報告系4イベントにプッシュ追加**（リーダー/マネージャー/全員承認・自己判断共有）
   - Migration `20260720300000`でpush設定シード（ON）。EVENT_MAPに承認=「承認」／自己判断共有=「新着」を追加
   - ⚠️「承認」という語は実機未テスト（「未承認」はOK）。Chrome警告が出たら「新着」に変える
4. **UIに送信先を明記**：通知設定タブのプッシュ欄に「📮 送信先：〇〇」を全イベント表示（承認フロー系は自動宛先、一斉系は役職選択）

### バグ修正3件
1. **見積もり参考リンクのはみ出し・押せない**（`PurchaseItemsSummary.tsx`）：備考欄にAmazon等のURLが入ると長い文字列がそのまま表示されはみ出していた→URLなら「🔗 参考リンクを開く」のリンク＋`wordBreak:break-all`で折り返し。申請一覧・承認画面・履歴の共通部品なので3画面同時に直る
2. **申請中にリンクを探しに別アプリへ行くと入力が消える**（`PurchaseRequestForm.tsx`）：スマホがページを破棄して入力全消失していた→入力内容をlocalStorage（キー`fivem_purchase_request_draft`）へ自動保存し、戻ったら復元。緑バナー「前回の入力内容を復元しました」＋「新しく入力し直す」ボタン、送信成功時に自動クリア、再申請時は保存しない
3. **🚨ナビボタンが突然2個（交通費・出張報告）だけになる**（マネージャー濱口が報告、`useAuth.ts`＋`AuthContext.tsx`）：
   - 原因：トークン自動更新（一定時間ごと・画面復帰時）のたびに役職・権限をDB再取得する作りで、モバイルの不安定回線で一瞬空データを掴むと`fetchPermsForRole`が`{}`を返し、権限が空で上書き→役職依存ボタン（休暇/勤務変更/備品精算/連絡板）が全消え。アプリ再起動で直る＝メモリ上の状態破損
   - 修正①：`fetchPermsForRole`は取得失敗時nullを返し、呼び出し側は「nullなら既存の権限を保持」（空で上書きしない）
   - 修正②：`AuthContext`でTOKEN_REFRESHEDイベント時はsetUserし直さない（役職・権限の再取得ループ自体を止める。トークン差し替えはライブラリ内部で完結するためアプリ状態更新は不要）

### デプロイ状況
- Edge Function：push-dispatch・shift-report-confirmed-notify・time-adjustment-notify・purchase-reimbursement-notify デプロイ済み
- Migration `20260720200000`・`20260720300000` 適用済み
- `tsc -b`・`vite build`成功、フロントはVercel自動デプロイ

### 今後の確認事項
- 役職選択プッシュ（勤務変更受理・時間調整・立替精算）が選んだ役職に届くか実機確認
- CC送信を実運用でONにした時に本来の宛先＋CC役職に届くか
- 結果報告系プッシュの「承認」文言がChrome警告にならないか（なれば「新着」へ）
- 見積リンクが折り返して開けるか、申請フォームの下書き復元・送信後クリアの実機確認
- ナビボタン消失が再発しないか（濱口さんに経過観察依頼）
- iPhoneのSafariはホーム画面追加しないとプッシュ許可欄が出ない（太田さん事例）→アカウント設定にiPhone向け手順ガイドを載せるのは今後の改善候補
- 連絡板グループへの申請内容自動投稿＋スレッド内シフト調整は「別途相談」として保留（記録のみ）

---

## ✅ 2026-07-13（続き2）🚨削除済みアカウントがログイン扱いされる判定の穴を修正

### 症状
- ユーザーが過去に別アカウント（退職済み・削除済み）で数回ログインしていた
- 現在は自分のアカウントで正常に使えているが、ページ更新時に一瞬だけ削除済みアカウントが表示され、その後で自分のアカウントに切り替わる

### 原因（`AuthContext.tsx` の `applySessionUser`）
- ブラウザのlocalStorageに残った古いアカウントのセッションを、ページ表示時に復元してしまう
- 判定コードが `if (profile && profile.is_active === false)` となっており、**プロフィール自体が存在しない（＝完全削除済み）場合は `profile` が null で判定を素通り**し、最後の `setUser(sessionUser)` でログイン扱いされていた
- → 削除済みアカウントのセッションが残っていると一瞬ログイン状態として表示される

### 修正
- profiles取得の `error.code === 'PGRST116'`（行が存在しない＝削除済み）を検知して即サインアウト＋「このアカウントは無効です」表示
- ネットワーク等の一時的な取得失敗（別エラーで data も null）は、正常ユーザーを誤ってログアウトさせないため弾かず既存挙動を維持（PGRST116のみを削除済みと判定）

### 注意・確認事項
- ブラウザに残った古いテストアカウントのセッションを消すには、一度ログアウトボタンを押す（`handleLogout`が`localStorage.clear()`する）か、サイトデータ削除が確実
- 本番反映後、削除済みアカウントで開いた時に一瞬も表示されず「無効なアカウント」画面へ直行するか確認
- フロントのみの変更（DB・Edge Function変更なし）、`tsc -b`・`vite build`成功

---

## ✅ 2026-07-14 アバターに前アカウントの名前が一瞬残る問題を修正

- 症状：アカウント切替後、右上アバターに前のアカウント（削除済み等）の名前が一瞬表示され、その後で自分の名前になる
- 原因：`useAuth.ts`でユーザー切替時にprofileName（アバター表示名）を取り直す間、前の値が残っていた
- 修正：`user?.id`が変わったらprofileName・employmentTypeを即クリア（取得完了時に上書き）。役職・権限はクリアするとナビボタンが一瞬消える別バグが再発するためあえて保持
- フロントのみ、`tsc -b`・`vite build`成功
- **補足（PWA起動速度の質問への回答）**：ホーム画面アプリの起動時スプラッシュ(約1秒)は正常範囲。内訳はJS読込＋起動時のログイン確認(サーバー1往復)。大きく速くする方法は「ログイン確認を待たず画面表示」だが退職者・承認待ち画面が一瞬見えるためセキュリティ上非推奨。安全な追加分割は0.1〜0.3秒程度で体感差なし。icon-512.png(198KB)はOS側にキャッシュされ2回目以降の起動に影響しないため圧縮しても効果なし。結論：1秒前後は現状維持でよい

---

## ✅ 2026-07-14（続き）起動体感の改善（スケルトン・preconnect・ちらつき根治・lazy化）

サブエージェント2体（UI/UXデザイナー＋シニアエンジニア）レビューを経て第1弾を実装。
レビュー結論：不満の本質は「1秒という時間」ではなく「真っ白で壊れて見える不安」。白をスケルトンに置き換えるのが最小コスト最大効果。実速度はpreconnectとSWキャッシュが主戦場。ちらつきの真因は「画面が先に描画され、後から名前・権限が届く」こと。

### 実装（すべてフロントのみ・DB/Edge Function変更なし）
1. **index.htmlに起動スケルトン**（`#root`直下にインラインHTML/CSS）：空の`#root`がJS読込完了まで真っ白だったのを、スプラッシュと同じ背景色#1a1a2e＋ロゴ＋プログレスバーで即表示。JS/認証を待たず描画され、OSスプラッシュから滑らかに繋がる。Reactマウントで自動置換
2. **AuthProviderのloading中をスケルトン表示に**（`{loading ? <BootSkeleton/> : children}`）：認証確認中の「第2の白画面」を消す。index.htmlと見た目統一。枠のみで個人情報を含まずis_active判定前でも安全
3. **index.htmlにSupabase preconnect**（`<link rel=preconnect>`）：起動時最初のサーバー通信のTLS確立をJS読込と並行化、初回往復を50-150ms短縮。費用対効果1位
4. **ちらつき根治**（useAuth.ts）：AuthProviderがスケルトンでchildrenを遅らせる→useAuth起動時にuser確定済み→`useState`遅延初期化でキャッシュから同期的に名前・役職・権限を読む（`useEffect`後追いをやめ、最初の描画から正しい表示）。名前はキャッシュ→トークン内user_metadata.name→空の順にフォールバック（初回端末でも実名）。キャッシュに`v:`バージョンキー追加＋`perms`形式検証（破損時破棄で白画面防止）。アカウント切替時のみuseRefで前user.idと比較して再反映
5. **設定系ページのlazy化**（AccountSettings/NotificationSettings/ChangeEmail/ChangePassword/SupabaseSettingsCheck）：起動ランディングに不要なので遅延読込。ExpenseForm/SignInはeager据え置き。効果は軽微（ページが小さかった）だが害なし
- `tsc -b`・`vite build`成功、ローカルでログイン画面表示・コンソールエラーなし確認

### セキュリティ判定（シニアエンジニアがRLS実コードで裏取り済み）
- feature_permissions（canX=ナビ表示可否）は`select using(true)`で全認証ユーザー参照可＋変更はadminのみ。実データRLSは`auth.uid()`と`profiles.role_title`で判定し**feature_permissionsを一切参照しない**（例：purchase_requests）。→ **canXは認可に使われず、localStorageキャッシュ改ざんで見えるのはナビボタンだけ。実データはサーバーが毎回再判定するため取得不可＝安全**
- 前提条件：全データテーブルにRLSが張られていること（purchase_requests/roles/feature_permissions確認済み。leave_requests/shift_reports/board_*は同型パターンだが**次回に棚卸し推奨**、特にクライアントガードの無い/leave・/shift-report）

### 今後のタスク（第2弾・保留・次回検討）
- **Service Workerでアプリシェル・JS/CSSをプリキャッシュ**（vite-plugin-pwa injectManifestで既存push処理を温存）：2回目以降の起動を200-500ms短縮。更新時の古いアセット配信リスクの運用設計が必要なため次回。費用対効果2位
- **profiles二重フェッチ解消**：AuthContextのis_activeチェックSELECTに表示カラム(name/role_title等)を足しContextで配布、useAuthの重複SELECT削減（往復-1・DB負荷半減）。認証はAuthContextに一元化する方針とも整合（[[feedback_deploy_and_work_start]]）。今回は遅延初期化＋スケルトンでちらつきは根治済みのため、これは最適化として次回
- vendorチャンク分割（SW導入とセットで相乗）
- 全データテーブルのRLS棚卸し（canX非依存で守れているか、特に/leave・/shift-report）
- AuthContext.tsx:75のalert()をトースト化（作業ルールのalert禁止に抵触・触るついでに）

### 実機確認事項
- 起動時に真っ白が消え、スプラッシュ→骨組み→アプリが滑らかに繋がるか
- アバターにメール頭文字「N」が出ず最初から名前が出るか、濱口さんのナビボタン欠けが再発しないか
- 各ページ（設定系lazy化分含む）が正常に開くか

---

## ✅ 2026-07-14（続き2）RLS棚卸し監査 実施＝全テーブル安全を確認（コード変更なし）

キャッシュ改善(canXをlocalStorageに持つ)の安全性前提「実データはRLSで守られる」を、本番DBに直接問い合わせて全公開テーブルを監査。結果オールクリア。

### 監査方法
- `pg_class.relrowsecurity` と `pg_policies` で全public tableのRLS有効化・ポリシー数を確認
- 個人データ系(leave_requests/shift_reports/attendance_exceptions/expenses/business_trip_reports/notifications)のSELECTポリシーの `qual` を実DBで確認

### 結果
- **全public tableでRLS有効**（rls_enabled=true）。鍵の外れた棚は無し
- 個人データ系のSELECTは全て `auth.uid()`（本人）または役職（profiles.role_title/JWT admin）で制限。`using(true)`のような全開放は無し
  - leave_requests: 本人 or approver/approver2 or admin/社長 or リーダー〜管理者
  - shift_reports: 本人(applicant_id) or リーダー〜管理者
  - attendance_exceptions/expenses/business_trip_reports/notifications: 本人 or 管理職/admin
- gcal_events・push_queue は「RLS有効＋ポリシー0件」＝クライアント完全遮断・service_roleのみ（サーバー専用テーブルとして正しい）
- **結論**：canX（ナビ表示可否）は実データの認可に使われておらず、キャッシュ改ざんで見えるのはボタンだけ・実データはサーバーが毎回RLSで再判定＝**キャッシュ改善は完全に安全と確定**。コード変更不要

### 軽微な所見（対応不要）
- expensesの管理者ALLポリシーは役職クレームではなく管理者メール(fivem.kyoto@gmail.com)直書き。動作はするが他テーブルと不整合。実害なし
- INSERTポリシーのUSINGはnull（INSERTはWITH CHECK側で制御、読み取り漏洩とは無関係）

### 第2弾の判断（ユーザーと確認済み）
- profiles二重フェッチ解消(②)は**見送り**。通信量は数百バイト×往復1回増で無料枠(月5GB)に対し誤差レベル＝コスト問題ではない。効果は0.1秒程度＋コード整理のみで、ログイン心臓部を触るリスクに見合わないため。ちらつきは既にスケルトン＋遅延初期化で解決済み
- Service Workerプリキャッシュ(①)も見送り（効果大だが更新時の古アセット配信リスク運用が必要、後日単独で慎重に）

---

## ✅ 2026-07-14（続き3）見積備考のコメント＋リンク混在に対応

- 背景：見積の備考欄は「コメントとリンクの両方を書いてください」と促す欄。前回の修正は「備考が丸ごとURLの時だけリンク化」だったため、コメント＋URL混在だとリンクにならず押せなかった
- 修正（`PurchaseItemsSummary.tsx` の renderNote）：備考をURL正規表現でsplitし、`http/https`で始まる部分だけ「🔗 リンク」のクリック可能リンクに、コメント文字はそのまま表示。複数URL混在・過去データも対応。申請一覧・承認画面・履歴の共通部品なので3画面同時反映
- **注意（実装ハマり）**：`g`フラグ付き正規表現で`.test()`を使うとlastIndexが進み誤判定する。判定用は非グローバル`/^https?:\/\//i`を別に使うこと
- ユーザーと相談し「リンク入力欄を分ける(B案)」ではなく「文中URL自動リンク化(A案)」を採用。理由：過去データがそのまま活きる・入力自由度維持・DB構造変更なしで低リスク。将来URL検証や厳密分離が必要ならB案へ移行可
- フロントのみ、`tsc -b`・`vite build`成功

### 起動体感 第1弾の実機確認結果（ユーザーOK）
- 起動時の真っ白解消・アバターのメール頭文字N改善を確認（「少し早くなった」「Nの表示は改善された」）

---

## ✅ 2026-07-14（続き4）プッシュ通知ON促進：案内文＋アプリ内バナー

ユーザー要望「基本的に全員プッシュ通知をONにしてほしい・こちらからお知らせを出したい」に対応。
**制約**：プッシュは各自がブラウザで「許可」しないとONにできず、こちらから強制ONは不可。iPhoneは「ホーム画面に追加」してPWAで開かないと設定欄すら出ない。

### ① 案内文（連絡板の全員宛て投稿 or メール一斉送信用・ユーザーに提供済み）
- Android(Chrome)：右上アイコン→アカウント設定→プッシュ通知「許可する」→確認で許可
- iPhone(Safari)：Safariで開く→共有ボタン(□↑)→ホーム画面に追加→そのアイコンから開き直す→アカウント設定→許可する
- OFF：アカウント設定→プッシュ通知「OFFにする」
- ※プッシュ自体でお知らせしても未ONの人に届かないので、連絡板/メールで出すのが正解

### ② アプリ内バナー（`App.tsx` の `PushEnableBanner`）
- Dashboard(ホーム=ログイン後の着地)トップに、まだONにしていない人にだけ表示（既にON/拒否済み/「後で」で閉じた場合は非表示）
- `getPushPermissionStatus()`で判定：'default'→その場で押せる「許可する」ボタン（requestPushPermission呼び出し）／iPhone(Safari・ホーム画面未追加=unsupported+isIOS+非standalone)→「ホーム画面に追加」の手順を出し分け
- iOS判定：`/iP(hone|ad|od)/.test(userAgent)`、standalone判定：`matchMedia('(display-mode: standalone)')` or `navigator.standalone`
- 「後で」で7日間非表示（localStorage `push_banner_dismissed_until`）。'denied'は本人が拒否済みなので出さない（AccountSettings側に再設定手順あり）
- フロントのみ、`tsc -b`・`vite build`成功、ローカルでコンソールエラーなし確認（バナー本体はログイン後表示のため実機確認は次回）

### 実機確認事項
- Android実機：ホームにバナーが出て「許可する」でその場でON→バナー消える→プッシュ届く
- iPhone実機：バナーに「ホーム画面に追加」手順が出る／PWAで開くと「許可する」が出る
- 既にONの人・「後で」を押した人にバナーが出ないこと

---

## ✅ 2026-07-14（続き5）プッシュ案内バナー文言編集＋社内お知らせ機能＝デプロイ完了（コミット5ab738b）

**本番反映済み**（tsc -b・vite build成功／push origin master／announcementsテーブルも本番DB適用済み）。

### 機能A：プッシュ案内バナーを管理画面から編集可能に（拡張）
- 通知設定タブ先頭の設定セクション（`PushBannerSettingsSection.tsx`）＋設定ロジック（`lib/pushBannerConfig.ts`）
- 当初は「案内文（本文）」のみ編集可だったが、**ユーザー要望でタイトル・「ONにする」ボタン・「後で」ボタンの文言も編集可能に拡張**
- 各欄が空欄なら初期文にフォールバック（DEFAULT定数）：タイトル`通知設定のお願い`／本文`大切なお知らせを見逃さないよう、特別な理由がなければ通知はONでお願いします。`／ON`通知をONにする`／後で`後で`
- `App.tsx`の`PushEnableBanner`が`config.title/message/enableLabel/laterLabel`を反映。iPhoneのホーム画面追加手順のみ固定文（編集対象外）
- 保存先：`app_settings` key='push_banner_config'（jsonb：enabled/title/message/enableLabel/laterLabel/redisplayDays）。保存自体はDB棚(app_settings)が既存のため本番DB変更不要

### 機能B：社内お知らせ（新機能）
- 管理者が全スタッフのホーム上部にお知らせバナーを出す＋履歴管理
- **DB**：`announcements`テーブル（id/title/body/active/created_by/created_at/updated_at）。RLS＝全員select・`role_title='管理者'`のみwrite。マイグレーション`supabase/migrations/20260714120000_create_announcements.sql`
  - ⚠️このマイグレーションは日付が既存適用済み分（20260720...）より**古い**ため、`supabase db push`ではなく`supabase db query --linked -f <file>`で直接適用した（冪等=if not existsなので再実行安全）
- `lib/announcements.ts`：fetchActive/fetchAll/create/setActive/delete
- 管理画面「📢お知らせ」タブ（`AnnouncementsTab.tsx`）：作成フォーム＋「📱イメージを見る」プレビュー＋履歴一覧（表示中/停止トグル・削除）。**削除はconfirm禁止→インライン確認UI**
- `AdminPanel.tsx`配線（import・ROW2タブ追加・描画分岐）＋`AdminPanelContext.tsx`のAdminTab型に`announcements`追加
- `App.tsx`の`AnnouncementBanner`：`fetchActiveAnnouncements`取得、青系#e7f1fb・📢、全員表示、localStorage`announcement_dismissed_ids`で個別に閉じる。PushEnableBanner直後に配置
- ※お知らせ作成はプッシュ通知を飛ばさない（アプリ内バナー表示のみ）

### 実機確認事項（次回・本番URLで）
- プッシュ案内バナー：通知設定タブで文言（タイトル・本文・ボタン）を変えて保存→実バナーに反映されるか（Android/iPhone）
- 社内お知らせ：作成→全スタッフのホームに表示→✕で閉じる／履歴の停止・再開・削除
- ※安全にテストするなら、まず「📱イメージを見る」プレビュー（DB保存なし・他人に見えない）で見た目確認→本番作成は中身を「テスト」と明記しすぐ削除

### 今後の相談（今回スコープ外）
- スタッフ側で過去のお知らせを見返す一覧ページ（要相談）

### 作業ルール（再掲・厳守）
- 作業フォルダ`C:\Users\[ユーザー名]\fivem-portal`。開始時：git pull→git status→CLAUDE.md「次回やること」確認
- 修正後：`cd client && npx tsc -b && npx vite build`（Vercelと同手順で確認）
- UIの文言・配色・新機能はいきなり実装せず**案を提示→承認後に実装**。見た目確認はvisualizeモックアップ or 画面内プレビュー
- **alert()・window.confirm()・.catch()禁止**（削除確認等はインライン確認UI）
- 認証はAuthContextに一元化。再取得結果で上書きする箇所は「失敗・空・切替時に前/誤った値を見せない」
- 本番DB操作（`supabase db query --linked`）は「進めて」だけでは通さず、**本番DBを対象と明示した許可**を得てから実行
- push/コミットは指示待ち。git add前に必ずgit status目視。`AGENTS.md`は未追跡のままコミットに含めない

---

## 🗂 2026-07-14（続き6）作業ディレクトリ／起動方法の整理（コード変更なし）

※fivem-portal のコード変更なし。今回は起動・作業フォルダまわりの整理のみ。

### 確認できた事実
- Claude デスクトップアプリは毎回 `D:\ドキュメント\Claude_kohei` から新規セッションを開く（`.claude/projects` の履歴もこの1つだけ）。fivem-keiei(経営)はその配下 `fivem-dev\keiei` にあるので自然に触れる。
- fivem-portal の本体は `C:\Users\kohei\fivem-portal`（git repo・origin=`fivem-inc/fivem-portal`・branch `master`）。起動場所が違っても Claude がフルパス／`cd` で正しく操作できることを読み取りで確認済み（git status・log 取得成功）。**壊れていない。**

### 確定した運用ルール
- **新規セッションを開いたら、最初に「どのアプリの作業か」（社内=fivem-portal／交通費／経営）を一言伝える** → Claude が正しいフォルダで `git pull` 等を実行する。ターミナルや専用bat は不要。
- 引き継ぎは「チャット貼付メモ／CLAUDE.md 作業ログ／自動メモリ」の三重で記録されており問題なし。内容がズレないようそろえるだけでよい。

### 次回タスク（続き5から変更なし）
1. 【実機確認】プッシュ案内バナー：文言（タイトル・本文・ボタン）を変えて保存→実バナーに反映されるか（Android/iPhone）
2. 【実機確認】社内お知らせ：作成→全スタッフのホームに表示→✕で閉じる／履歴の停止・再開・削除（まず「📱イメージを見る」で見た目確認→本番作成は「テスト」と明記し即削除）
3. 【相談・スコープ外】スタッフ側で過去のお知らせを見返す一覧ページ

---

## ✅ 2026-07-14（続き7）お知らせに「表示期間・リマインド・作成時通知」を追加＝本番反映済み

コミット `cf5cf21`（+Vercel発火用の空コミット `718a836`）。本番DB・Edge Function・cron すべて反映済み。
実装前に UI/UXデザイナー＋シニアエンジニアのサブエージェント2体にレビューさせ、指摘（プッシュ全skip・二重送信・NULL後方互換・JST丸め・実効ステータス・編集導線など）を反映済み。

### 機能
- **表示期間（開始日〜終了日）**：期間外は自動で非表示。終了日は JST 23:59:59 まで表示（朝に消えるオフバイワン防止）。履歴に実効ステータス（表示予定/表示中/終了/停止中）を表示
- **編集機能**：タイトル・本文・期間・通知を後から変更（期限延長も可）
- **作成時通知**（Edge Function `announcement-notify`・管理者のみ・認証あり）：投稿した瞬間に全員へプッシュ／メール
- **期限リマインド**（Edge Function `announcement-remind`／cron `announcement-remind-daily` 毎日09:00 JST）：終了日前に アプリ内再表示／プッシュ／メール。回数=1回 or 毎日を選択可。`reference_id` と `remind_last_sent_on` で二重送信防止
- **メールは全員宛て**（件名`【お知らせ】タイトル`／本文）→ 通知OFFの人にも届く
- `push-dispatch` の EVENT_MAP に `announcement:new` / `announcement:remind` 追加（文面は安全語「新着」固定）

### 主なファイル
- client: `lib/announcements.ts` / `lib/announcementDates.ts`(新) / `components/admin/AnnouncementsTab.tsx` / `App.tsx`(AnnouncementBanner)
- supabase: `functions/announcement-notify`(新) / `announcement-remind`(新) / `push-dispatch`(更新) / `migrations/20260721000000`(列追加・冪等) / `20260721010000`(cron記録)

### デプロイ手順の記録（今回の学び）
- 本番DB列追加：ダッシュボード SQL Editor で手動実行（`db push` は使わず）。列追加のみで既存データ非破壊
- Edge Function：`supabase functions deploy announcement-notify announcement-remind push-dispatch`（Docker不要・APIバンドル）
- cron：ダッシュボードで `cron.schedule('announcement-remind-daily','0 0 * * *', …)` を手動登録（Vault の service_role_key 使用）
- **Vercel：`cf5cf21` の自動デプロイが webhook 不発 → 空コミット `718a836` を push して発火**（同様の事象が起きたらこの手で対処）

### 次回やること
1. 【実機確認】📢お知らせタブの新UI：詳細設定・表示期間・作成時通知（メール/プッシュ）・リマインド・編集
   - 作成時メール/プッシュが届くか、期間外は非表示か、編集で期限延長できるか
   - 安全手順：まず「📱イメージを見る」→ 本番作成は「テスト」明記で即削除
2. 【任意】リマインドのプッシュ/メールは毎日09:00自動。急ぎ確認は ダッシュボード Edge Functions → `announcement-remind` を手動 Invoke

---

## ✅ 2026-07-14（続き8）プッシュ通知OFFが更新でONに戻る不具合を修正＝本番反映済み

コミット `16dcf55`。フロントのみ（`client/src/utils/pushNotification.ts`）。

### 症状
アカウント設定／通知設定ページで「プッシュ通知」を **OFFにしても、ページ更新するとONに戻って見える**。

### 原因
`getPushPermissionStatus()` が `Notification.permission`（ブラウザの通知許可）だけで ON/OFF を判定していた。
「OFFにする」を押すと購読（`push_subscriptions`）は消えるが、**ブラウザの通知許可は `granted` のまま残る**（許可の取り消しはユーザーがブラウザ設定でしか行えない仕様）。そのため更新時に `granted`＝ON と表示されていた。

### 修正
`getPushPermissionStatus()` を、許可が granted のときは **実際の購読の有無**（`PushManager.getSubscription()`）で判定するよう変更。購読が無ければ `default`（OFF）を返す。
- 使用箇所3つ（`App.tsx` の案内バナー／`AccountSettings.tsx`／`NotificationSettings.tsx`）すべてに反映される
- 副作用：これまでバグでON表示だった（実際はOFF）人には、ホームの「通知をONに」案内バナーが再表示される（＝正しい挙動。「後で」で7日消せる）

### 注意事項（今後の教訓）
- **ブラウザの通知許可(permission)と、実際のプッシュ購読(subscription)は別物**。ON/OFF表示は購読の有無で判定すること。permission は「拒否(denied)」判定にのみ使う。
- 端末とDBの購読状態がズレる可能性（ブラウザに購読があるがDB行が無い等）は今回未対応。必要になれば `push_subscriptions` の行も併せて確認する。

### 次回やること
- 【実機確認】プッシュ通知を OFF→更新 で OFF のままか（Android/iPhone）。ON→更新 で ON のままか。

---

## ✅ 2026-07-15（続き9）休暇まわり4件（奨励日削除・社長宛先・カレンダー本番切替）＝本番反映済み

フロントは1コミット、`gcal-sync` は関数デプロイ済み。本番DBの変更・マイグレーションは無し。

### ① 有給奨励日の「日ごと削除」機能（LeaveRequestsTab.tsx）
- 一覧を展開 →「削除」ボタン＋インライン確認（confirm禁止順守）
- 既存の「個人ごとの✕（対象から削除）」を全員に行うのと同じ順序で削除：
  回答 → 対象者 → その日の自動作成された承認済み有給申請 → 奨励日本体
- RLSで拒否された場合（error無しで0件）も検知して警告表示。※実機で削除できることは確認済み

### ② マネージャー受理時（leave:manager_approved）の宛先に「社長」追加
### ③ 取り消し時（leave:cancelled）の宛先に「社長」追加
- 通知設定タブの メール／サイト通知 の宛先チェックに「社長」を追加（②③のイベントだけに表示）
- 送信側で `role_title='社長'`（在籍者・複数可）を解決して届ける
- サイト通知は申請者本人を従来どおり送信＋社長を追加（無回帰）。メールも申請者＋社長
- `notificationDispatch.ts` の dispatchEmail/dispatchSiteNotification を president キー・配列宛先に対応。二重送信防止つき
- 変更: NotificationsTab.tsx（getRecipientOptions で president を出し分け）／LeaveApprovals.tsx（受理）／LeaveRequestsTab.tsx（取り消し）／notificationDispatch.ts
- **注意：管理画面で「社長」にチェックを入れないと届かない（既定OFF）**

### ④ 休暇カレンダーの本番/テスト ワンクリック切替
- **背景**：書き込み先カレンダーは gcal-sync の env で固定だった。テスト（休暇（テスト））で運用中→本番（ファイブM共有）へ移行したい
- **Secrets**：`GCAL_CALENDAR_ID`（既存＝テスト）はそのまま、`GCAL_CALENDAR_ID_PROD=office@five-m.com`（本番＝ファイブM共有のカレンダーID）を新規追加済み
- **gcal-sync**：`app_settings` の `gcal_calendar_mode`（{mode:'production'|'test'}）を読み、本番なら `GCAL_CALENDAR_ID_PROD`、それ以外/未設定/失敗時は `GCAL_CALENDAR_ID`（テスト）
- **管理画面**：通知設定タブ上部「🗓 休暇カレンダーの連携先」→ [本番]/[テスト] ワンクリック切替（`GcalCalendarSection.tsx` / `lib/gcalCalendarConfig.ts`）
- 既定はテスト。**管理画面で[本番]を押した瞬間に本番カレンダーへ移行**。以降はアプリ内トグルだけで切替可（Secrets編集不要）
- サービスアカウント `fivem-portal-gcal@chromium-358109.iam.gserviceaccount.com` を「ファイブM共有」に「予定の変更」で共有済み

### 次回やること
1. 【要操作】管理 → 通知設定 → 「🗓 休暇カレンダーの連携先」で **[本番] を押して本番へ移行** → 休暇1件受理して「ファイブM共有」に予定が出るか確認
2. 【設定】通知設定で ②マネージャー受理時／③取り消し時 の「社長」チェックを入れる → 社長にメール/サイト通知が届くか
3. 【実機確認】①有給奨励日の削除（本番）
- 補足：テスト時に作った休暇を本番切替後に取消/変更すると、本番カレンダーに対象イベントが無く削除失敗しうる（新規は正常）

### セッション終了メモ（2026-07-15）
- 続き6〜9をこの日にまとめて実施。デプロイ完了・ユーザーの動作確認OK（「できました」）
- 残る継続確認：社長宛先が実際に届くか／カレンダー本番運用で新規予定が「ファイブM共有」に出るか（本番で最終確認）
- スコープ外の相談事項：スタッフ側で過去のお知らせを見返す一覧ページ

---

## ✅ 2026-07-15（続き10）ナビ3ボタンのわかりやすさ改善（説明文の追加）＝本番反映

**背景**：ナビの「🌿休暇申請」「📅休暇」「⏰勤務変更」の3つが「わかりにくい」との声。各ページの注意事項枠の上部に「このページで何をするか」を簡潔に明記。フロントのみ・ロジック変更なし・DB変更なし。

### 変更内容（文言はユーザー確定版）
- **🌿 休暇申請**（`LeaveRequest.tsx`）注意事項枠の上部に追加
  - 「有給・慶弔休・調整休などを申請するページです。」（14px 太字）
  - 「※申請が受理されると、Googleカレンダーに自動登録されます。」（12px・注意事項本文と同色に統一）
- **⏰ 勤務変更**（`ShiftReportPage.tsx`）注意事項枠の上部に追加
  - 「パート・アルバイトスタッフの『休日出勤・残業・早退・遅刻・欠勤』が発生したときに報告するページです。」（14px 太字）
  - 「（これまでの残業申請表の代わりです。）」（12px）
- **📅 休暇カレンダー**（`CalendarPage.tsx`）見出し直下に**新規の説明枠を追加**（元々注意事項枠が無かった）
  - 「【リーダー・マネージャー専用】」12px 太字・**中央寄せ**
  - ①②の青丸バッジ付きで「① スタッフの休みを一覧で確認できます／② 欠勤・遅刻・早退の入力ができます」（各14px 太字。2機能を見やすく）
  - 「※Googleカレンダーに自動登録されます。／※有給の申請はできません。」（12px）
- **フォーム送信ボタンの見出し統一**（表記ゆれ解消）
  - `LeaveApprovals.tsx`：「📨 パートへ申請フォームを送信」→「📨 パート・アルバイトへ休暇申請フォームを送信」
  - `admin/LeaveRequestsTab.tsx`：「📨 パートへ有給申請フォームを送信」→ 同上に統一
  - 両画面のプルダウン「-- パートを選択 --」→「-- パート・アルバイトを選択 --」

### 確認・注意事項
- 記載内容はコードと一致することを実装前に確認済み（受理時のgcal-sync `source_type:'leave'`／カレンダーの欠勤入力機能／閲覧は `canCalendar` 権限）
- 「勤務変更＝パート・アルバイト」の限定表現はユーザーの運用意向どおり（現状の注意事項本文には雇用形態の限定は無いが、説明文で限定を明示）
- 各ページの既存注意事項枠と同じ配色（ライト/ダーク対応）に統一
- `LeaveApprovals.tsx` / `LeaveRequestsTab.tsx` のフォーム送信処理には既存の `alert()`/`window.confirm()` が残存（今回のスコープ外・未変更）。将来インラインUI化の候補

### 次回やること
- 【実機確認】3ページの説明枠がスマホ幅でも崩れず読めるか（特にカレンダーの①②バッジ行）
- 【任意】上記フォーム送信の alert/confirm をインラインUIへ置換（作業ルール順守）

---

## ✅ 2026-07-15（続き11）説明枠を全6ページに統一・黄色化・背景統一＝本番反映

続き10の説明枠を全ページへ展開し、デザインを統一。フロントのみ・ロジック/DB変更なし。

### 対象6ページの「説明枠」を統一（タイトル直下に配置）
交通費（`ExpenseForm.tsx`）／休暇申請（`LeaveRequest.tsx`）／休暇カレンダー（`CalendarPage.tsx`）／勤務変更（`ShiftReportPage.tsx`）／出張報告（`BusinessTripReport.tsx`）／備品精算（`PurchaseRequestPage.tsx`）
- **形式統一**：中央寄せの【対象ラベル】＋ 青丸①②バッジ（`#4a90d9`）付きの「〜できます」リスト（14px 太字）＋ ※注記（12px）
- 対象ラベル：休暇申請/出張報告/備品精算/交通費=【全スタッフ】、カレンダー=【リーダー・マネージャー専用】、勤務変更=【パート・アルバイトスタッフ専用】
- 休暇申請・勤務変更・出張報告は、注意事項枠の中にあった説明文を枠の外（タイトル直下）へ移動。タブ外なので常時表示

### 配色ルール（重要）
- **説明枠＝黄色**（ライト・ダーク共通の固定色）：背景 `#fff3cd` / 枠線 `#ffe0a3` / ラベル・注記 `#856404` / ①本文 `#664d03`
  - ※一度ダーク用にくすんだ黄（`#3a3220`）にしたら「ダークで見えにくい」となり、元の明るい黄をライト/ダーク共通で使う方針に変更。ダークでも黄色がはっきり出る
- **注意事項枠＝水色/紺**：背景 `isDark ? '#2c3e50' : '#e8f4fd'` / 枠線 `isDark ? '#3d5a73' : '#bee5eb'` / 本文 `isDark ? '#d0dde8' : '#2c5f6e'` / タイトル `isDark ? '#fff' : '#1a4a5a'`
  - 勤務変更・出張報告の注意事項枠のダーク色が `#1a2e3a`/`#2d5a6e` でバラついていたのを上記の紺に統一

### 交通費ページの再構成（`ExpenseForm.tsx`）
- 旧：グレー枠＋黄色⚠️ボックス（ダーク非対応で浮いていた）を撤去
- 新：黄色の説明枠（① 通勤・出張などの交通費を申請できます／※申請は「まとめて」「都度」のどちらでもできます。／※申請履歴をテンプレートとして使えます。）＋ 水色/紺の【注意事項】枠（定期券まわり3項目は文言変更なし・`<ol>`化・ダーク対応）

### ページ背景の統一（A案）
- 備品精算（`PurchaseRequestPage.tsx`）だけが `minHeight:100vh` で独自背景（ダーク `#212529`／ライト `#f0f2f5`）を塗っており、他の全ページ（body の `#242424`／`#ffffff`）と微妙に違っていた
- → 備品精算の `background` 指定と未使用化した `bg` 変数を削除。全6ページが body 背景に統一（連絡板は対象外）

### 次回やること
- 【実機確認】6ページの説明枠（黄色）・注意事項枠（紺）がスマホ幅・ダークモードで崩れず読めるか
- 【留意】黄色枠はライト/ダーク共通の固定色。今後トーンを変える場合は6ファイル一括で（共通化されていない点に注意）

---

## 📌 セッション終了メモ（2026-07-15 続き10–11 まとめ／次セッション用）

### 今日やったこと（すべて本番反映・push完了）
- 全6ページ（交通費/休暇申請/休暇カレンダー/勤務変更/出張報告/備品精算）に「説明枠」を新設・統一
  - タイトル直下に配置（タブ外＝常時表示）。中央【対象ラベル】＋青丸①②バッジの「〜できます」＋※注記
- 配色ルール確立：**説明枠＝明るい黄色（ライト/ダーク共通固定色）**、**注意事項枠＝水色/紺（ダーク #2c3e50 に統一）**
- 交通費ページ再構成（黄色説明枠＋水色/紺【注意事項】枠。定期券3項目は文言そのまま）
- フォーム送信見出しを「📨 パート・アルバイトへ休暇申請フォームを送信」に統一（LeaveApprovals / admin/LeaveRequestsTab）
- ページ背景をA案で統一（備品精算の独自背景を撤去し全ページ body 背景へ）
- 詳細は上の「続き10」「続き11」参照

### 次回の予定タスク
1. 【実機確認】6ページの説明枠(黄)・注意事項枠(紺)がスマホ幅・ダークで崩れないか
2. 【留意】黄色枠は共通化されていない固定色。トーン変更時は6ファイル一括で
3. 【任意】フォーム送信の alert()/window.confirm() をインラインUIへ置換
4. 【継続確認・続き9由来】社長宛先が実際に届くか／休暇カレンダー本番運用で新規予定が「ファイブM共有」に出るか
5. 【相談・スコープ外】スタッフ側で過去のお知らせを見返す一覧ページ

### 作業ルール（厳守・毎回）
- 作業フォルダ `C:\Users\kohei\fivem-portal`。新セッションは最初に対象アプリを伝える
- 修正後：`cd client && npx tsc -b && npx vite build`
- UI文言・配色・新機能は「案を提示→承認後に実装」。いきなり実装しない
- `alert()`／`window.confirm()`／`.catch()` 禁止（確認はインラインUI）
- 認証は AuthContext に一元化
- 本番DB操作・本番設定変更・push/コミットは「明示の指示」を得てから
- git add 前に必ず `git status` 目視。`AGENTS.md`（未追跡）はコミットに含めない
- デプロイ＝push。Vercel webhook 不発時は空コミット push で発火

---

## ✅ 2026-07-15（続き12）勤務変更ページ：事後報告化・欠勤の連絡確認・削除バグ修正＝本番反映

パート・アルバイトの勤務変更ページで「欠勤を事前申請と誤解して上長へ連絡しない」リスクへの対応と、用語統一・削除バグ修正をまとめて実施。

### ① 黄色説明枠に「事後報告」を明記（`ShiftReportPage.tsx`）
- 「① 発生した『休日出勤・残業・早退・遅刻・欠勤』を**事後報告**できます」
- 「※このページは事後報告用です。事前の申請・お休みの連絡はできません。」
- 「※欠勤・遅刻・早退の連絡は、これまで通りリーダー・マネージャーへ直接連絡してください。」

### ② 欠勤タップ時のインライン確認パネル（`ShiftReportPage.tsx`）
- 種別「❌ 欠勤」を**新規選択**するとき（本人・新規のみ／編集・代行はスキップ）、即選択せず確認パネルを表示（`toggleType` で `absencePrompt: 'none'|'confirm'|'declined'` を制御）
- 「連絡済みです（報告をつづける）」で選択実行／「まだ連絡していない」で連絡方法を案内（前日まで／当日朝／営業時間内＋`tel:0755854018` リンク＋受付時間＋「もう一度欠勤を押す」導線）
- 位置は**押した欠勤ボタンの直下**（1段目グリッド直下）。表示時に `scrollIntoView({block:'center'})` で自動スクロール
- 配色は**ライト/ダーク共通の明るいアンバー**（背景`#fff8e1`/枠`#f59e0b`/見出し`#b45309`/本文`#92400e`）。※一度ダーク用に暗い茶にしたら「くすんで醜い」となり、黄色枠と同じく共通固定色に変更

### ③「申請」→「報告」に一括変更＋ステータス「確認待ち」
- `ShiftReportPage.tsx`：見出し「勤務変更報告」／タブ「✏️ 報告」／送信「✓ この内容で報告する」／成功「報告を送信しました」／通知文・履歴・取消など全て。ステータス表示「申請中」→「**確認待ち**」
- `App.tsx`：バナー「勤務変更報告の確認依頼が…」
- `admin/ShiftReportsTab.tsx`：一覧見出し・CSVヘッダー(報告日/報告者)・ファイル名(勤務変更報告_…)・ソート・「再報告」・ステータス（確認待ち/確認待ち(再)）
- `admin/NotificationsTab.tsx`：カテゴリ「勤務変更報告（パート・アルバイト）」・「報告時（プッシュのみ）」
- `admin/FeaturePermissionsTab.tsx`：ラベル「勤務変更報告」
- Edge Functions：`push-dispatch`（app名）／`shift-report-confirmed-notify`（プッシュtitle・Slack本文・メール件名フォールバック）→ **両方 `supabase functions deploy` 済み**
- **変更しない**：DBカラム・`source_type`・`event_key`・機能権限key `shift_report`・管理タブkey `shift_reports`・テンプレート変数`{{申請者名}}`・役職リテラル`'申請者本人'`・URL `/shift-report`・他機能の「申請」（休暇/交通費/備品）・「残業申請表」（旧帳票名）・説明文の「事前の申請」

### ④ 完全削除バグ修正（RLS）
- **原因**：`shift_reports`/`shift_report_history` に **DELETE ポリシーが無く**、RLSで全削除が無言拒否（0件・エラー無し）→ 画面は「削除しました」と嘘表示で消えない
- **本番DB（適用済み・範囲A＝リーダー以上＋管理者）**：
  ```sql
  drop policy if exists "approver_delete" on public.shift_reports;
  create policy "approver_delete" on public.shift_reports for delete using (
    (auth.jwt() ->> 'role') = 'admin'
    or exists (select 1 from profiles where id = auth.uid()
      and role_title in ('リーダー','マネージャー','フロア責任者','社長','管理者')));
  ```
  （履歴は `on delete cascade` で親削除時に自動削除。DELETEポリシー不要）
- **フロント**（`admin/ShiftReportsTab.tsx`）：`handleDelete` を `.select()` で削除件数/エラー検知に変更。成功時のみ「削除しました」、拒否/0件は赤帯で「削除できませんでした（権限不足）」。冗長な履歴の明示削除は撤去（cascade任せ）
- 補足：完全削除で報告本体・変更履歴はDBから消える（cascade）。gcal/欠勤カレンダーには非連携。過去に送信した通知レコードのみ残る

### デプロイ後の手動作業（要対応）
- **メール件名・本文は管理画面「通知設定」のDB保存テンプレートが優先**。コードのフォールバックのみ変更したので、実際に届くメールは旧「勤務変更申請〜」のまま。管理→通知設定→「勤務変更報告（パート・アルバイト）」の各テンプレの「申請」を「報告」に手動更新が必要

### 次回やること
- 【要操作】上記メールテンプレートの手動更新（管理→通知設定）
- 【任意】`ShiftReportPage`/`ShiftReportsTab` に残る `window.confirm`（hardDelete等）をインラインUI化（作業ルール違反の解消）
- 【実機確認】欠勤パネル（ライト/ダーク）・削除の実挙動・「報告」表記の通し確認

---

## ✅ 2026-07-15（続き13）休暇カレンダー欠勤入力の通知機能を新設＝本番反映

休暇カレンダー（リーダー・マネージャー専用）で欠勤・遅刻・早退を登録しても**通知が一切飛んでいなかった**ため、`time-adjustment-notify` と同じ「役職＋グループ配信」パターンで通知機能を新設。

### 実装
- **新Edge Function `attendance-notify`**（`time-adjustment-notify` のクローン。**デプロイ済み**）
  - event_key `attendance:registered`。notification_settings を読み、サイト通知/プッシュ/メール/Slack を設定に従い配信
  - 宛先解決：リーダー・マネージャーは `groupFilter='same'` のとき同グループのみ。**社長・管理者(`ORG_WIDE_ROLES`)はグループ絞り込みを無視して常に対象**（「同グループ既定だと社長に届かない」トラップ回避）。`申請者本人` チェック時は該当スタッフ本人も対象
  - vars：`{{対象者名}}`（=該当スタッフ）`{{種別}}` `{{日付}}` `{{リンク}}`（/calendar）。複数日欠勤は「◯月◯日 他N日」表記
- **`NotificationsTab.tsx`**：カテゴリ「🔴 欠勤・遅刻・早退（休暇カレンダー登録）」追加。`attendance:registered` を `ROLE_GROUP_BROADCAST_EVENTS`/`PUSH_ROLE_SELECT_EVENTS` に追加＋`VARIABLES_BY_EVENT`/`PUSH_RECIPIENT_BY_EVENT` 追加。本人ラベルは `roleLabel()` でこのイベントのみ「本人（該当スタッフ）」表示（内部値は共通の `申請者本人` のまま）
- **`CalendarPage.tsx`**：欠勤入力の保存後（gcal同期の後）に `attendance-notify` を invoke（`user_id`=該当スタッフ, `dates`, `types` を渡す）

### seed SQL（本番で要実行。新イベントは行が無いと通知設定画面に出ない）
```sql
insert into public.notification_settings (event_key, channel, enabled, recipient, subject, template) values
  ('attendance:registered','site', true,'{"roles":["リーダー","マネージャー","社長","管理者"],"groupFilter":"same"}',null,'🔴 {{対象者名}}さんの{{種別}}が登録されました（{{日付}}）'),
  ('attendance:registered','push', true,'{"roles":["リーダー","マネージャー","社長","管理者"],"groupFilter":"same"}',null,null),
  ('attendance:registered','email',false,'{"roles":["リーダー","マネージャー","社長","管理者"],"groupFilter":"same"}','欠勤・遅刻・早退が登録されました','{{対象者名}}さんの{{種別}}が {{日付}} に登録されました。'),
  ('attendance:registered','slack',false,'{"channels":[]}',null,null)
on conflict (event_key, channel) do nothing;
```
- 既定：サイト＋プッシュON／メール・SlackはOFF／宛先リーダー以上／同グループ。本人は既定OFF（サイト・メールで選択可。プッシュは既存仕様上リスト非表示）

### 次回やること
- 【要操作】上記 seed SQL を本番で実行（未実行ならまず実行）
- 【実機確認】休暇カレンダーで欠勤入力→リーダー等にサイト通知/プッシュが届くか。管理→通知設定に新カテゴリが出て宛先変更できるか

---

## 📌 セッション終了メモ（2026-07-15 続き12–13 まとめ／次セッション用）

### 今日やったこと（すべて本番反映・push＋Edge Functionデプロイ・SQL実行まで完了）
- **勤務変更ページ改修（続き12・コミット 5d1942f）**
  - 黄色枠に「事後報告用／事前申請・お休みの連絡はできない」明記
  - 欠勤タップ時のインライン確認パネル（連絡済み確認→未連絡なら連絡方法案内 tel:0755854018。本人・新規のみ／欠勤ボタン直下＋自動スクロール／ライト・ダーク共通の明るいアンバー）
  - 「申請」→「報告」一括統一・ステータス「確認待ち」（画面/通知/バナー/管理3ファイル/CSV/Edge Functions 2本）
  - 完全削除バグ修正（shift_reportsにDELETE RLSポリシー無→無言拒否。approver_deleteポリシー本番適用＋フロントを件数/エラー検知に）
- **休暇カレンダー欠勤入力の通知新設（続き13・コミット a5d901a）**
  - 新Edge Function `attendance-notify`（event_key `attendance:registered`）。役職＋グループ配信、社長・管理者はグループ不問、本人選択可。デプロイ済
  - NotificationsTabに「🔴 欠勤・遅刻・早退（休暇カレンダー登録）」カテゴリ追加、CalendarPage保存後に通知呼び出し、seed SQL(4行)実行済
- 詳細は上の「続き12」「続き13」参照

### 次回の予定タスク
1. 【要操作】メールテンプレ手動更新：管理→通知設定→「勤務変更報告」の件名・本文に残る「勤務変更申請」を「報告」へ
2. 【実機確認】欠勤入力→リーダー等に通知が届くか（対象スタッフのグループにリーダー/マネージャーがいる状態で）
3. 【実機確認】勤務変更ページの欠勤パネル・削除・「報告」表記の通し
4. 【任意】ShiftReportPage/ShiftReportsTab の window.confirm をインラインUI化
5. 【継続確認】社長宛先が実際に届くか（休暇の受理/取消）
6. 【相談・スコープ外】スタッフ側で過去のお知らせを見返す一覧ページ

### 補足（今日の質問回答）
- 「休暇承認（承認者向けページ）」= `/leave-approvals`。承認者(リーダー以上)が休暇申請を受理/差戻するページ。休暇申請ページのオレンジ「✅受理ページへ」から入る。権限表の「休暇承認」トグルはこのページの表示可否設定

### 作業ルール（厳守・毎回）
- 作業フォルダ `C:\Users\kohei\fivem-portal`。新セッションは最初に対象アプリを伝える
- 修正後：`cd client && npx tsc -b && npx vite build`
- UI文言・配色・新機能は「案を提示→承認後に実装」。いきなり実装しない
- `alert()`／`window.confirm()`／`.catch()` 禁止（確認はインラインUI）
- 認証は AuthContext に一元化
- 本番DB操作・本番設定変更・push/コミットは「明示の指示」を得てから
- git add 前に必ず `git status` 目視。`AGENTS.md`（未追跡）はコミットに含めない
- デプロイ＝push。Vercel webhook 不発時は空コミット push で発火。Edge Function は `supabase functions deploy <name>` が別途必要（Docker不要）

---

## 📌 セッション終了メモ（2026-07-16／勤務変更報告「差し戻し時」の4チャンネル化）

### やったこと（本番反映済み：マイグレーション適用＋Edge Functionデプロイ完了）
ユーザー要望：管理→通知設定の「⏰ 勤務変更報告（パート・アルバイト）」の**差し戻し時**を、
受理時と同じく **Slack／メール／サイト通知／プッシュ** の4つとも選べるようにする。

**なぜ「プッシュのみ」だったか（原因）**
- 受理時は Edge Function `shift-report-confirmed-notify` を経由し、設定を読んで4チャンネル出し分けしていた
- 差し戻し時は画面から `notifications` に直接1行INSERTしていただけ（ベル→トリガー→プッシュが流れるので結果的にプッシュのみ）
- **通知設定画面は notification_settings に行がある channel だけ表示する**。行が無い＝その欄自体が出ない

**実装（休暇の差し戻し `leave:rejected` と同じ作りに揃えた）**
- **新Edge Function `shift-report-returned-notify`（デプロイ済）**：Slack専用。
  Webhook URLはサーバー側の秘密のため関数経由。送信先チャンネル・文面は notification_settings から関数側で読む
- **新 `client/src/lib/shiftReportReturnedNotify.ts`**：差し戻し通知の送信処理を集約（site＋Slack invoke＋email）。
  **差し戻しは管理画面(ShiftReportsTab)と申請画面(ShiftReportPage)の2か所から実行できる**ため、
  両方からこのヘルパーを呼ぶ（配線漏れ防止）。直INSERTは廃止
- **プッシュはヘルパーで送らない**：site通知INSERTにevent_keyを付けるとトリガー→push-dispatchで自動送信されるため、
  ここで送ると二重送信になる
- **NotificationsTab.tsx**：ラベル「差し戻し時（プッシュのみ）」→「差し戻し時」、
  `SLACK_CHANNEL_OPTIONS_BY_EVENT` に `shift_report:returned`（TIME_ADJ_SLACK_OPTIONS＝リーダー/マネージャー/経理/晃平先生）、
  `VARIABLES_BY_EVENT` に `{{申請者名}}{{種別}}{{日付}}{{差し戻し理由}}{{リンク}}`、
  `APPLICANT_ONLY_RECIPIENT_EVENTS`（新設）で メール・サイトの宛先は「申請者本人」のみ表示
- **マイグレーション `20260722000000_add_shift_report_returned_channels.sql`（本番適用済）**：
  site/slack/email の3行を追加（push行は既存）。既定は **site=ON（従来挙動維持）／slack・email=OFF**
  site の subject は null のまま＝画面側が「種別　日付（＋理由）」を自動生成（従来のベル2行目と同じ表示）

### 🚨 注意事項（今回わかった仕様・重要）
- **「サイト通知」＝ `notifications` の1行**。これが **🔔ベル一覧（App.tsx の NotificationBell）と
  ホーム上部のバナー（App.tsx の NotificationBanner）の両方**に出る。別物ではない。
  ホームのバナーを×で消すと `banner_dismissed` が立ちバナーだけ消える（ベルには残る）
  ※ホームにある「プッシュ通知をONに」の `PushEnableBanner` は通知設定とは無関係の別物
- **サイト通知OFF＝プッシュも止まる**（プッシュはベル通知INSERTのトリガーが入口のため）。
  この注記を**サイト通知欄に表示するようにした**（`pushFollowsSite()` で判定）。
  ただし **PUSH_ROLE_SELECT_EVENTS の4件（時間調整・勤務変更受理・欠勤登録・立替精算）は
  専用Edge Functionがプッシュを直接送るのでこの結合は無い**＝注記を出さない（出すと嘘になる）
- 新イベント/新チャンネルを増やすときは **必ず notification_settings に行をseed** しないと画面に出ない

### 次回やること（実機確認）
1. 管理→通知設定→勤務変更報告→差し戻し時 に4欄が出るか。Slackのチャンネル選択・メールON→本人に届くか
2. 差し戻しを **管理画面と申請画面の両方**から実行し、ベル/ホームバナー/プッシュが従来どおり届くか
   （文面「差戻」はChrome警告にならない実機テスト済み語）
3. サイト通知欄の注記が、受理時・時間調整・欠勤登録・立替精算には**出ていない**ことの確認

---

## 📌 セッション終了メモ（2026-07-17／入力下書きの自動保存を全申請フォームに統一）

### やったこと（本番反映は未・ユーザー確認後にpush予定）
スマホで参考情報を別アプリに調べに行って戻ると入力が消える問題への対策。
備品精算と同じ「入力中は端末に自動保存・送信成功で消える」方式を全フォームに統一。

**共通ヘルパー新設 `client/src/lib/draftStorage.ts`**
- `DRAFT_KEYS`（fivem_draft_* で統一）、`loadDraft/saveDraft/clearDraft`、連絡板チャット用 `loadChatDraft/saveChatDraft`
- 仕様：localStorage無期限・自動保存・自動復元（復元バナーなし）・**消えるのは送信成功と🗑クリアのみ**

**適用した画面（各フォームの最初の入力枠の右上に「🗑 クリア」ピル型ボタン）**
- 交通費 ExpenseForm：入力中＋**追加済みリスト**を保存。下部の旧クリアボタンは廃止し右上に移設。送信成功でclear
- 備品 PurchaseRequestForm：既存の独自localStorage実装はそのまま。**復元バナーを廃止**し🗑クリアに統一
- 出張 BusinessTripReport：GPS・住所は一時情報なので保存しない。送信成功でclear
- 休暇申請 LeaveRequest：休暇フォーム＋時間調整フォームを別キーで保存（`leave`/`leaveAdjustment`）。それぞれ🗑クリア。再申請モードは対象外
- 休暇カレンダー CalendarPage の欠勤入力シート：`attendance`キー。開いていた日付ごとに保存し、
  更新・別アプリ移動でシートが閉じても**マウント時にsetAbsenceSheet(draft.date)でシートを開き直す**。
  キャンセル/背景タップ=破棄（handleDismissでclear）、登録成功でclear
- 勤務変更 ShiftReportPage：新規報告のみ保存（修正モードは対象外）。送信成功でclear。🗑クリアは!editTarget時のみ
- 連絡板 BoardPage：**お知らせ作成フォームのみ**実装（`boardCompose`キー）。
  ・「＋お知らせ送信」ボタンは `openCompose()`：下書きがあれば消さず保持して開く／無ければresetCompose
  ・auto-save effectは**全項目が空ならclearDraft**（送信・クリア後に空下書きが復活するのを防ぐ重要ガード）
  ・resetCompose（送信成功・🗑クリア）でclear
  ・**チャット入力（グループ/DM/リプライのreplyBody）は今回未実装**（リアルタイム・チャンネル切替が絡みリスク高・短文で価値低のため見送り）。必要なら別途

### 注意事項・設計判断
- 連絡板は既に「送信トレイ→下書きタブ」のDB下書き機能あり（お知らせ作成の手動保存）。今回の自動保存はそれとは別の"事故防止の安全網"
- クリアボタン文言は「🗑 クリア」で全画面統一（ゴミ箱アイコン＋最短文字）
- **空下書きの罠**：clearDraft後にauto-save effectが再実行され空オブジェクトを保存し直すと、
  loadDraftがtruthyを返して誤動作する。openCompose等loadDraftの真偽で分岐する箇所は空判定ガード必須
- ページ遷移（アプリ内）では消えない＝要件どおり。更新・アプリ完全終了では消える（localStorageなので実際は残るが、
  送信するまで残す仕様＝ユーザー要望「送信したら消えるのみ」に合致）

### 次回やること（実機確認）
1. 各フォームで入力途中に別アプリへ→戻る（または更新）→入力が復元されるか
2. 送信成功後に下書きが消えているか（再度開くと空か）
3. 🗑クリアで入力が空になるか。交通費は追加済みリストは残り入力枠だけ消えるか
4. 欠勤入力：入力途中で更新→シートが自動で開き直り復元されるか。キャンセルで破棄されるか
5. 連絡板お知らせ：作成途中で別画面→「＋お知らせ送信」で戻ると下書きが残っているか。送信後は空か
6. 勤務変更・休暇の修正モードでは下書きが誤発動しないか（新規のみ対象）

---

## 📌 追記（2026-07-17／欠勤登録バナーのタップ改善＋精算フォームの下書き）

### 欠勤登録バナー：タップで正しい月へ飛んで該当行を強調
問題：欠勤登録バナー（source_type='attendance'）をタップすると今月の`/calendar`に飛ぶだけで、
別月の登録でも今月に飛ぶ＆一覧が多いとどれが追加分か分からなかった。

対応：
- `attendance-notify`：通知の**reference_idに対象日(先頭日・YYYY-MM-DD)**を入れる（**要デプロイ**）
- `App.tsx` バナー(isAttendance)：reference_idが日付形式なら`/calendar?focus=YYYY-MM-DD`へ遷移
- `CalendarPage.tsx`：URLの`?focus=`を読み、**その月を開き**（year/month初期化）、
  一覧の該当行を**黄色ハイライト＋自動スクロール**、6秒後にhighlightDateをnullにしてフェード
- 制約：日付が入るのは改修後の新しい通知のみ。過去分はreference_idが無く従来どおり今月へ（エラーなし）

### 精算フォーム（ReimbursementForm）の下書きを他と統一
- もともと**sessionStorage**で保存していた（ブラウザ完全終了で消える）→ **localStorageに変更**（他フォームと同じ無期限）
- レシートは画像そのものでなくstorage_path(文字列)なのでlocalStorageで安全
- 🗑クリアボタンを最初の入力枠の右上に追加（resetFormを呼ぶ）
- 承認タブ(PurchaseApprovals)・履歴タブは入力フォームでないため下書き不要

### デプロイ対象
- フロント：git push（Vercel自動）
- Edge Function：`supabase functions deploy attendance-notify`（reference_id追加のため必須）
- gcal-sync/shift-report-returned-notify等は今回変更なし

---

# 📌📌 セッション終了サマリー（2026-07-17／次回はここから）

## 今日やったこと（すべて本番反映済み：push＋Edge Functionデプロイ＋DB適用まで完了）

### 1. 勤務変更報告「差し戻し時」の4チャンネル化（コミット ac72dc4）
- 差し戻し時をSlack/メール/サイト通知/プッシュで出し分け可能に（受理時と同じ作り）
- 新Edge Function `shift-report-returned-notify`（Slack専用・デプロイ済）、lib/shiftReportReturnedNotify.ts に送信集約
- 管理画面・申請画面の両方から差し戻せるので両方から同ヘルパーを呼ぶ
- notification_settings に site/slack/email 3行追加（site=ON、slack/email=OFF）

### 2. 全体仕様書を最新化（コミット aa25b19）
- docs/仕様書_Notion用.md を2026-07-16版に更新（備品精算モジュール・プッシュパイプライン・管理14タブ等）

### 3. 欠勤・休暇・時間調整に「校（勤務校）」を追加（コミット 26d8583）
- DB列追加（本番適用済）：`attendance_exceptions.location`、`leave_requests.leave_locations`、`leave_requests.chosei_origin_locations`
- gcal-sync（デプロイ済）：locations受け取りでタイトルを `椿原 凜大｜休み［四条本校］` に。姓名間の全角スペース→半角に正規化
- 欠勤入力・休暇申請・時間調整・振替元勤務日に**日付ごとの校選択**（必須・一括選択あり・1日1行表示）
- チームカレンダー：PCセルに校を小表示、一覧に校列＋理由の2行目（欠勤備考・調整休のみ／有給奨励日は「📅有給奨励日」表示）
- 承認画面・管理受理/種別変更でも校をGCalへ引き継ぎ。休暇申請CSVを1日1行化＋校列、欠勤CSVを新規追加

### 4. バナータップ修正・有給奨励日表示・交通費リスト並び替え（コミット 0691b0e）
- 欠勤登録バナーがタップ無反応だった不具合を修正
- 交通費の追加済みリストに並び替え（登録順/日付順・↓↑・端末に記憶）

### 5. 入力下書きの自動保存を全フォームに統一＋欠勤バナーの飛び先改善（コミット f6ad6b5）
- 共通 lib/draftStorage.ts。入力中は自動保存・**送信成功と🗑クリアでのみ消える**（localStorage無期限）
- 対象：交通費/出張/休暇+時間調整/欠勤入力/勤務変更/備品申請/備品精算/連絡板お知らせ作成
- 各フォーム最初の入力枠の右上に「🗑クリア」統一。修正/再申請モードは対象外
- **欠勤登録バナー**：attendance-notify の reference_id に対象日追加（デプロイ済）→タップで正しい月へジャンプ＋該当行を黄色ハイライト＋自動スクロール（6秒でフェード）

## 次回の予定タスク（実機確認・優先順）
1. 【最優先・実機】入力下書き：各フォームで入力途中→別アプリ/更新→復元されるか。送信後は空か。🗑クリアで空になるか
   （交通費は追加済みリストが残り入力枠だけ消える／欠勤入力は更新でシート自動再表示・キャンセルで破棄）
2. 【実機】欠勤バナー：新規欠勤登録→バナータップ→正しい月で該当行が光るか（過去の通知は日付なしで今月へ＝仕様）
3. 【実機】校選択：欠勤・休暇・時間調整で校を選び登録→GCalタイトルが `姓 名｜内容［校］`（半角スペース）になるか
4. 【実機】勤務変更差し戻しの4チャンネル、有給奨励日の一覧表示、交通費の並び替え記憶
5. 【保留・未実装】連絡板のチャット入力（グループ/DM/リプライ）の下書き
   → リアルタイム・チャンネル切替が絡みリスク高・短文で価値低のため今回見送り。やるなら別途慎重に
6. 【継続】storage-usage-check cron（毎週月曜9:00）が正常実行されているか確認
7. 【保留】プッシュ案内バナーの管理画面設定機能（C案）※以前からの未着手タスク

## 作業ルール（厳守・毎回）
- 作業フォルダ `C:\Users\kohei\fivem-portal`。開始時：git pull → git status → CLAUDE.mdの本サマリー確認
- 修正後：`cd client && npx tsc -b && npx vite build`（Vercelと同手順）
- UI文言・配色・新機能は「案を提示→承認後に実装」。いきなり実装しない。配色/レイアウトはvisualizeでモック提示
- 専門用語は新卒でも分かるよう都度解説する
- `alert()`／`window.confirm()`／`.catch()` 禁止（確認はインラインUI・成功は緑カード）。認証はAuthContextに一元化
- 本番DB操作・本番設定変更・push/コミットは「明示の指示」を得てから。git add 前に必ず `git status` 目視
- `AGENTS.md`（未追跡）はコミットに含めない
- DBマイグレーション：`supabase db query --linked --file <SQL>`。Edge Function：`supabase functions deploy <名前>`（Docker不要）
- git push が2分でタイムアウト→run_in_backgroundで再試行
- プッシュ文面は「状態を表す漢字名詞＋件数」のみ（実機テスト済み語）
- 下書き実装の落とし穴：clearDraft後にauto-save effectが空データを再保存し得る→loadDraftの真偽で分岐する箇所は空判定ガード必須

---

## 📌 追記（2026-07-17 続き／カレンダー日曜始まり・通知バナーの該当ハイライト・お知らせ改善）

### 1. チームカレンダーを日曜始まりに（CalendarPage）
- 休暇申請フォームは元から日曜始まり、チームカレンダーだけ月曜始まりだったので統一
- WEEKDAYS=['日'..'土']、firstDow=getDay()（+6%7を撤廃）、土日色：日曜=赤(i===0)・土曜=青(i===6)
- 3つのカレンダー（MultiDatePicker/PcCalendar/SpCalendar）すべて修正

### 2. 承認依頼・結果通知バナーのタップで該当申請を強調（休暇・勤務変更・備品すべて）
- 共通フック **`hooks/useFocusHighlight.ts`** 新設：URLの`?focus=<ID>`を読み、該当カードにref＋黄色ハイライト＋スクロール、6秒でフェード
- App.tsx バナー：reference_id（申請ID）があれば飛び先URLに`focus=`を付与
- 適用6画面：LeaveApprovals（受理）/LeaveRequest履歴/ShiftReportPage確認ビュー＋履歴/PurchaseApprovals/PurchaseRequestPage履歴
- 勤務変更履歴は対象が古い期間（折りたたみ）にある場合、その期間を自動で開くeffectを追加
- 休暇・勤務変更・備品の通知はいずれもreference_idに申請IDが入っている（確認済）ので日付より正確に1件を特定

### 3. お知らせバナーの折りたたみ（App.tsx AnnouncementBanner）
- 普段はタイトル1行のコンパクト表示（「▼開く」）、タップで本文展開（「▲閉じる」）、初期は閉じた状態
- ✕での閉じる（dismissed）動作は従来どおり。expanded stateで開閉管理

### 4. お知らせの表示期間に時刻を追加（AnnouncementsTab / announcementDates.ts）
- 入力を `type="date"` → `type="datetime-local"` に。DBは元からタイムスタンプ（starts_at/ends_at）なのでDB変更不要
- ヘルパー改修：dateInputToStartIso/EndIso は 'YYYY-MM-DDTHH:mm'（時刻なし旧形式も許容）、isoToDateInput は datetime-local形式、isoToShortDate は 'M/D HH:mm'
- 既存の時刻なしお知らせも編集・表示OK（開始0:00・終了23:59扱い）

### デプロイ
- すべてフロントのみ（DB変更なし・Edge Functionデプロイ不要）。git push（Vercel自動）で完了

### 社内お知らせ文（提供済み）
- 一般向け：入力自動保存・交通費並べ替えの2点（フォーマル・シンプル）
- 幹部向け：上記＋校選択/GCal表記/通知バナー改善/差し戻し通知設定/お知らせ機能改善/CSV改善（全9項目）

---

## 📌 追記（2026-07-17 続き2／休暇「受理ページへ」ボタンにパート送信を明記）
- 休暇申請ページの「✅ 受理ページへ」ボタン（承認者のみ表示）の先に、パートへの申請フォーム送信機能が
  あるのが分かりにくかったため、ボタンを2行に：1行目「✅ 受理ページへ」＋2行目（小）「パートへの申請フォーム送信」
- 出張報告のクリアボタンは既に「報告種別」見出しの右横で希望どおり＝変更なし
- フロントのみ（LeaveRequest.tsx の1ファイル）。DB・Edge Function変更なし

---

## 📌 追記（2026-07-18／マネージャー受理の二度手間解消・「承認」→「受理」文言統一）
UI/UXデザイナー＋シニアエンジニアのサブエージェント2体でレビュー後に実装。

### 1. マネージャーが申請先の休暇受理を1回で完了できるように（LeaveApprovals.tsx）
- 従来：マネージャーを申請先に選んだ申請は、一人目受理→二人目に自分を選び直して再受理、で**同じ人が2回受理**する二度手間
- 改善：一人目受理のモーダルを、受理者本人がマネージャー（roleTitle==='マネージャー'）のとき2択に：
  - ◉ 自分が受理して経理へ進める（既定）… step2_pendingをスキップし直接manager_approvedへ。approver2_id=本人を記録
  - ○ 別のマネージャーに受理を依頼する … 従来どおりstep2_pending
- **調整休は完了まで**：調整休はmanager承認で完了する特殊フローのため、行き先を `isChosei ? 'approved' : 'manager_approved'`、
  ボタン文言も「受理して完了」に自動切替（レビューで指摘された最重要の落とし穴）
- 受理確定の副作用（gcal-sync書き込み＋申請者/社長サイト通知＋Slack＋メール）を **emitManagerApproved()** に共通化し、
  handleApprove(step2_pending時) と新 handleApproveAsSelf の両方から呼ぶ（コードのdrift防止）
- 新経路では leader_approved 通知は送らない（次のマネージャーがいないため）。manager_approved通知は必ず送る
- リーダーが受理する場合は従来どおり（roleTitleで分岐）。管理画面(LeaveRequestsTab)は変更なし（管理者は手動強制進行できる）

### 2. 「承認」→「受理」の文言統一（CLAUDE.mdルール:379行「承認→受理」に準拠）
- LeaveApprovals：受理待ちの申請はありません／別の受理者の順番です／次の受理者（マネージャー）を選択／
  受理後、選んだマネージャーに…／Slackフォールバック'受理者'
- LeaveRequest：受理者が登録されていません／時間調整は受理フローがありません・受理待ちにはなりません

### 注意事項
- source_type や通知イベントキー（leave:manager_approved 等）は内部識別子なので変更しない（表示テキストのみ統一）
- 役職判定は roleTitle（ログイン中の受理者本人の役職）。pending受理はcanApproveでapprover_id===user.id担保済み＝申請先本人
- フロントのみ（DB・Edge Function変更なし）

### 今後の任意タスク（レビューで挙がった改善余地）
- manager_approved通知が LeaveRequestsTab では社長宛が欠落（LeaveApprovalsは送る）→ 整合させる価値あり
- 承認フローの status を3ファイルで個別switchしている→将来「ステップ定義＋単一advance関数」への線形化リファクタ余地

---

# 2026-07-19 差し戻しバナー改善・フロア責任者了承者・社長の勤務変更履歴修正

## 1. 削除済み申請を指す古いバナーの自動削除（App.tsx NotificationBanner）
- isResolvedPending で `leave_request:pending_resubmit` / `shift_report:pending_resubmit` の対象レコードが
  「クエリ成功したのに取得できない＝削除済み」の場合にバナーを自動削除（read+banner_dismissed化）するよう変更
- **安全策**：`leaveFetchOk` / `shiftFetchOk` フラグを追加。クエリ自体が失敗（通信エラー等）した場合は従来通り「残す」。
  `!r` を無条件で消すと一時的な取得失敗で正常バナーまで一斉に消えるため、この区別は外さないこと
- 背景：長岡さん宛07-09のテスト差し戻し通知が残存していた件（対象申請は削除済み）。次回バナー取得時に自動で消える

## 2. 差し戻しバナー2行目に休暇日を表示（案2＝日付のみ・ユーザー承認済み）
- `lib/notifications.ts` に `formatLeaveDateSummary(leaveDates, startDate, endDate, leaveTypeName)` を新設
  - 1日「7/26 有給休暇（1日）」／2〜3日「7/26・7/27 …（2日）」／4日以上「7/26〜8/2 …（4日）」（飛び日でも範囲＋正確な日数）
  - leave_datesがnull（旧申請）はstart〜endから補完。日付情報が皆無なら種別名のみ
- 差し戻し通知（leave:rejected site）の sub_message を差し戻し理由→休暇日サマリーに変更。**2箇所**：
  LeaveApprovals.tsx（受理ページ）と admin/LeaveRequestsTab.tsx（管理画面、種別名はorigTypeで「その他」解決済み）
- 経緯：案1（日付＋理由併記）・案3（3行）もモック提示したが、スマホ幅で折り返しが崩れないコンパクトな案2に決定。
  差し戻し理由はタップ先の申請履歴で確認できる。今後の通知から有効（既存通知の文言は変わらない）

## 3. 時間調整の了承者リストにフロア責任者を追加（LeaveRequest.tsx）
- approvers取得を `in('role_title', ['リーダー','マネージャー','フロア責任者'])` に拡大、
  並びはリーダー→マネージャー→フロア責任者（ShiftReportPageの報告先ordマップと同じ前例）
- **休暇申請の「申請先」は現状維持**：`leaveApprovers`（フロア責任者除外）を派生させ選択肢・0件判定に使用。
  承認フロー対象はリーダー・マネージャーのみのまま。了承者の保存は従来通り notes に `【了承者】名前` テキスト（DB変更なし）
- 注意書き（1165行「フロア責任者・リーダーへ相談」）と選択肢の不整合が解消

## 4. 社長・フロア責任者が勤務変更バナーをタップしても履歴が空だった問題（ShiftReportPage.tsx）
- 原因：`canSeeAll` に社長・フロア責任者が入っておらず「全スタッフ」モードが出ない＋
  履歴初期モードが 'reviewed'（自分がレビュー担当した報告のみ）だが、報告先リストから社長は除外されており常に0件
- 修正：canSeeAll と履歴初期モード判定の両方に「フロア責任者」「社長」を追加（RLSのapprover_selectと役職を一致させた）
- DB権限（RLS）は元々全件閲覧可で問題なし。**画面側の役職リストとRLSの役職リストがズレると
  「通知は届くのに見えない」不整合になる**ので、役職を足すときは両方確認すること

## 5. 文言統一：自己受理の確認画面「受理済みになります」→「受理されます」
- 確認依頼先に自分を選んだ時の緑カード（isSelfReview時のみ表示）を選択肢の文言「※報告と同時に受理されます」と統一
- パートは確認依頼先に自分を選べない（承認者役職のみ）ためこの文言は出ない。動作も文言通り登録時に即confirmed

いずれもフロントのみ（DBマイグレーション・Edge Function変更なし）。tsc -b・vite build成功確認済み。

---

# 2026-07-19（続き）役職序列の確定・先行公開からフロア責任者を除外

## 役職序列（ユーザー明言・重要）
**社長 ＞ マネージャー ＞ リーダー ＞ フロア責任者 ＞ 一般・パート**
- フロア責任者は**リーダーより下位**。「リーダー以上」という言葉にフロア責任者を含めるかは都度ユーザー確認すること
- ただし承認者系リスト（REVIEWER_ROLES・shift_reports RLSのapprover_select・欠勤FYI通知の宛先等）には
  引き続きフロア責任者を含む＝「監督的役職」としての扱いは変更していない

## 先行公開「リーダー以上」からフロア責任者を除外（案2・ユーザー決定）
- `useFeaturePublished.ts` の LEADER_PLUS_ROLES：リーダー・マネージャー・社長・管理者のみに変更
- `FeaturePermissionsTab.tsx` 凡例：「リーダー・マネージャー・社長に先行表示（フロア責任者は含みません）」に修正
- 影響：全公開OFF＋リーダー以上ONの機能（連絡板・休暇カレンダー・休暇承認・備品購入申請）が
  フロア責任者に**表示されなくなる**。役職別トグルや全公開ONの機能は変化なし
- 経緯：フロア責任者プレビューに連絡板が出る理由を確認→「リーダー以上」グループに含まれていたため。
  序列の指摘を受け、案1（現状維持＋凡例修正）／案2（除外）を提示し案2に決定
- 本日デプロイ済みの「時間調整の了承者にフロア責任者」「勤務変更の全スタッフ履歴にフロア責任者」は
  明示指示によるもので序列の話とは別枠＝そのまま維持

フロントのみ・tsc/build成功。

---

# 📌📌 セッション終了サマリー（2026-07-19／次回はここから）

## 今日やったこと（デプロイ済み：d452f9f・05443e3）
1. 削除済み申請を指す古い差し戻しバナーの自動削除（休暇＋勤務変更、取得失敗時は残す安全策付き）
2. 差し戻しバナー2行目に休暇日表示（案2＝日付のみ。formatLeaveDateSummary新設、受理ページ＋管理画面の2箇所）
3. 時間調整の了承者にフロア責任者追加（休暇申請の申請先はリーダー・マネージャーのまま）
4. 社長・フロア責任者の勤務変更履歴が空だった問題を修正（canSeeAll＋履歴初期モードに追加）
5. 自己受理の文言統一「報告と同時に受理されます」
6. **役職序列の確定**（社長＞マネージャー＞リーダー＞フロア責任者＞一般・パート）に伴い、
   先行公開「リーダー以上」からフロア責任者を除外（LEADER_PLUS_ROLES・凡例修正）
※詳細・注意事項は直上「2026-07-19 差し戻しバナー改善…」「2026-07-19（続き）役職序列…」参照

## 次回タスク
1. **実機確認（今日の分）**
   - 長岡さん宛の古いテスト差し戻しバナーが自動で消えるか
   - 新しく差し戻した時のバナー2行目「7/26 有給休暇（1日）」表示
   - 時間調整「了承者を選択」にフロア責任者が出るか／休暇申請の申請先には出ないこと
   - 社長アカウント：勤務変更バナータップ→履歴が「全スタッフ」で表示されるか
   - フロア責任者プレビュー：連絡板・休暇カレンダー等（全公開OFF＋リーダー以上ONの機能）が非表示になったか
2. 実機確認（前回からの継続・コードは完了済み）：入力下書き／欠勤バナーの月ジャンプ＆ハイライト／校選択のGCalタイトル／
   マネージャー受理1回完了・調整休「完了」表示／日曜始まりカレンダー／お知らせバナー折りたたみ・期間の時刻指定／承認→結果バナーの該当ハイライト

## 保留（やるなら別途）
- 連絡板のチャット入力（グループ/DM/リプライ）の下書き（見送り中）
- 承認フローの status を3ファイルで個別switch→線形化リファクタ（将来）
- 選択肢827行の「※報告と同時に受理されます」とisSelfReview緑カードは文言を揃えてある。今後変更時は両方セットで

## 作業ルール（厳守・毎回）
- 作業フォルダ C:\Users\kohei\fivem-portal。開始時 git pull→git status→本サマリー確認
- 修正後 `cd client && npx tsc -b && npx vite build`
- UI文言・配色・新機能・設計判断は案提示→承認後に実装（配色/レイアウトはvisualizeでモック）。大規模改修はUI/UX＋シニアエンジニアのサブエージェント2体レビュー
- 専門用語は新卒でも分かるよう都度解説
- alert/window.confirm/.catch禁止（確認はインラインUI・成功は緑カード）。認証はAuthContext一元化
- ユーザー向け文言は「承認→受理」「却下→差し戻し」で統一
- 本番DB操作・push/コミットは明示指示後。git add前に git status目視。AGENTS.md（未追跡）はコミットに含めない
- DBマイグレーションは `supabase db query --linked --file`、Edge Functionは `supabase functions deploy <名前>`（Docker不要）
- git pushが2分でタイムアウト→run_in_backgroundで再試行

---

## 2026-07-20 正社員 残業・勤務時間管理（スプレッドシート「残業申請表」置き換え）新規実装

正社員の残業を、Excel/スプレッドシートの「残業申請表」からアプリに移行する新機能一式を実装。
grill-me→モック承認→サブエージェント2体レビュー（UI/UX＋シニアエンジニア）×2回→実装、の順で作成。

### 実装した機能
- **新ページ `/overtime`（OvertimePage.tsx）**：正社員用。「申請・報告」「履歴・通算」タブ＋確認者ビュー（`?view=confirm`）＋リーダー以上の部門集計モード
  - 事前申請と実績報告は**1レコードのstatus遷移**（requested→request_confirmed→reported→confirmed＋returned/cancelled）。事後報告単体も可
  - 日付を選ぶと通常シフト（曜日パターン）を自動表示。実務時間帯は最大3枠（外出・戻り）。休憩自動計算＋手修正。法定チェック警告（本人・確認者両方に表示・提出はブロックしない）
  - 残高カード（今期通算・プラス青/マイナス橙）、受理済み事前申請の「実績を報告する」プリフィル、取消導線
- **管理タブ（OvertimeAdminTab.tsx）**：曜日パターン編集／会社カレンダー／設定（しきい値・部門グループ）。パターンは履歴型（適用開始日つき）
- **シフトExcel取り込み（OvertimeShiftImport.tsx）**：勤務表.xlsx→シート選択→現行パターンとの差分表示→適用開始日つき一括登録
  - 各曜日2行構成に対応：2段目＝第2時間帯（外出・戻り・テレワーク）、掃除列2段目＝校（空欄は四条本校）。労働時間は2段合計で計算
  - 旧姓・表記ゆれは「この人を選ぶ」で手動紐付け→エイリアス（overtime_name_aliases）に保存し次回自動一致。パートは対象外表示
- **超過FYIバナー（App.tsx）**：今期残業がしきい値超で本人・リーダー（自チーム）・マネージャー以上に表示。文言「今月（7/16〜8/15）の残業が10時間を超えました。時間調整をお願いします。調整する日がわからない場合はリーダー・マネージャーにご相談ください。」
- 通知は overtime_request 系 source_type を App.tsx 3か所（タップ遷移・除外リスト・自動消し込み）＋通知に追加
- 先行公開に「社長のみ」区分を新設（useFeaturePublished＋FeaturePermissionsTab）。**現在 overtime は社長のみ表示**

### DBマイグレーション（本番SQL Editorで適用済み・3本）
1. `20260724000000_create_overtime_management.sql`：全テーブル（weekly_shift_patterns / company_calendar / overtime_reports＋segments＋history / overtime_settings / banner_dismissals / name_aliases）＋トリガー＋RLS＋feature_permissions/feature_published seed
2. `20260724100000_add_shift_pattern_band2_location.sql`：weekly_shift_patterns に start_time2/end_time2/location 追加
3. `20260724200000_fix_overtime_admin_rls.sql`：管理者RLS判定の修正（下記重大教訓）

### ★重大教訓：RLSの管理者判定は必ず app_metadata 経由で書く
- 当初 `(auth.jwt() ->> 'role') = 'admin'` で書いてしまい、管理者と認識されず全INSERTがRLSで弾かれた（エラー42501）
- 正しくは **`(auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'`**（既存 fix_purchase_requests_admin_rls.sql と同じ轍・2回目のミス）
- 今後 RLS で管理者を判定するときは必ず app_metadata 経由で書くこと

### 併せて直した既存バグ
- ShiftReportPage の完全削除ボタンに残っていた `window.confirm` → インライン2段階確認に
- `new Date().toISOString().slice(0,10)` のUTC日付バグ（JST深夜0〜9時に前日）を全10ファイルで `todayJstStr()`/`toJstDateStr()` に置換。ReportsTab の月末日ズレも修正
- 休憩計算・時間ユーティリティは lib/breakCalc.ts に集約（純関数・テスト可能）

### 設計上のポイント（今後の注意）
- 時間量はすべて符号付きint分・**1分単位**（5分刻み制約は入れない）
- 休憩ルール（自動計算）：出勤13:00前→拘束4:15未満0/〜6:30が30分/〜8:45が45分/超60分。13:00以降→5:45以下0/〜6:15が15分/〜6:30が30分/〜8:45が45分/超60分。分割勤務は時間帯ごとに適用し合算
- 締め16日〜翌15日（既存 calc_pay_period_start 再利用）。繰り越しなし（毎期リセット）
- 時間外調整休の受理→残業台帳へ自動マイナス計上は leave_requests のトリガーで同期（受理経路が複数あるためRPCでなくトリガー）
- 曜日パターンの「祝（全員休み）」「出（休館日だけど出勤日）」は会社カレンダー連動用。試合・イベントの単発出勤は曜日パターンでなく残業・時間管理ページで実績報告する運用
- 既存「時間調整」タブ（休暇申請ページ内）は当面残す。正社員は本番公開時に新ページへ一本化予定

## 次回タスク（残業・時間管理）
1. **実機テスト**（社長アカウント。先行公開は社長のみなので一般には出ない）
   - Excel取り込み：太田恭子が労働8:00（テレワーク加算）、尾上千佳子（旧姓・森本千佳子）の手動紐付け、校が日ごとに正しく入るか
   - 残業の事前申請→受理→実績報告→確認の一連の流れ
   - 事後報告単体、差し戻し→再提出、取消
   - 休暇申請「時間外調整休」受理→残業台帳に自動マイナス計上されるか
   - 超過FYIバナーの表示（しきい値を低く設定してテスト）
   - 部門集計・週合計・「いま適用中のパターン一覧」の表示
2. 実機で問題なければ、マネージャーへの先行公開→全体公開のタイミング検討
3. 本番公開時に正社員の「時間調整」タブを非表示にし新ページへ一本化

## 前回からの継続タスク（実機確認・コードは完了済み）
- 2026-07-19分：長岡さん宛の古い差し戻しバナー自動削除／差し戻しバナー2行目の休暇日表示／時間調整の了承者フロア責任者／社長の勤務変更履歴／フロア責任者プレビューでの非表示

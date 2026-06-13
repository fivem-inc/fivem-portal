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
| Step | 内容 | 目安 | 難易度 |
|------|------|------|--------|
| 1 | 掲示板・連絡機能を作る（DB・画面・自動投稿） | 2〜3週間 | ★★★☆ |
| 2 | Service Worker を追加（public/sw.js・manifest.json更新） | 2〜3日 | ★★☆☆ |
| 3 | プッシュ通知送信（VAPID鍵・購読情報DB保存・Edge Function） | 3〜4日 | ★★★☆ |
| 4 | 通知設定画面（許可ボタン・ON/OFFスイッチ） | 1〜2日 | ★★☆☆ |

**合計目安: 約1か月**　まず掲示板を作り、通知は後から追加できる。

### 対応端末
| 端末 | 条件 | 通知 |
|------|------|------|
| Android | Chromeでホーム画面に追加 | ◎ 届く |
| iPhone | Safariでホーム画面に追加（iOS 16.4以上） | ◎ 届く |
| PC（Chrome） | ブラウザ閉じていても | ◎ 届く |
| iPhone（ブラウザのまま） | ホーム画面追加なし | ✕ 届かない |

※ fivem-portal はすでにPWA設定済みのため Service Worker 追加から着手できる。
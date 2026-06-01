# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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

### 🔜 次回やること
1. **パートへの有給申請フォーム送信**（管理者がパートを指定して一時表示）
2. **グループ追加機能**（現在グループの追加ができない・管理者画面のグループ管理タブから新規グループを作成できるようにする）
3. **Phase 1: メール送信機能**

### コミット
- `2bc4c23` Phase3: 休暇申請フォーム実装
- `e8cdb96` Phase3: 管理者画面に休暇申請タブ追加
- 本日分: Phase3完了・承認フロー改善・UI整備

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
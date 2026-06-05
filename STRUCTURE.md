# fivem-portal プロジェクト構造

## 全体アーキテクチャ

```
ブラウザ（スマホ/PC）
    │
    │ HTTPS
    ▼
┌─────────────────────────────┐
│  Vercel（フロントエンド）    │
│  https://fivem-portal.      │
│  vercel.app                 │
│                             │
│  React + TypeScript + Vite  │
└────────────┬────────────────┘
             │ Supabase JS SDK
             ▼
┌─────────────────────────────┐
│  Supabase（バックエンド）    │
│  xaeynaxctiiyqxjyuzfi       │
│                             │
│  ┌─────────┐ ┌───────────┐  │
│  │  Auth   │ │ Database  │  │
│  │(ログイン)│ │(PostgreSQL│  │
│  └─────────┘ └───────────┘  │
│  ┌─────────────────────────┐ │
│  │   Edge Functions (Deno) │ │
│  └─────────────────────────┘ │
└─────────────┬───────────────┘
              │ Webhook
              ▼
         ┌─────────┐
         │  Slack  │
         └─────────┘
```

---

## フロントエンド構造 (client/src/)

```
client/src/
│
├── main.tsx                      # エントリーポイント
│
├── App.tsx                       # ルーティング・ナビゲーション
│   ├── /                         →  Dashboard（ホーム）
│   ├── /leave-approvals          →  LeaveApprovals（承認者専用）
│   ├── /reset-password           →  ResetPassword
│   └── /change-email             →  ChangeEmail
│
├── pages/
│   ├── SignIn.tsx                 # ログイン画面
│   ├── ResetPassword.tsx          # パスワードリセット
│   ├── ChangeEmail.tsx            # メール変更
│   └── SupabaseSettingsCheck.tsx  # 設定確認（デバッグ用）
│
├── components/
│   ├── Auth.tsx                   # 認証ラッパー
│   ├── AdminPanel.tsx             # 管理者画面（メインタブ管理）
│   │   ├── tab: approvals         → 交通費承認管理
│   │   ├── tab: users             → ユーザー管理（雇用形態・役職・並び替え）
│   │   ├── tab: groups            → グループ管理
│   │   ├── tab: reports           → レポート・分析
│   │   ├── tab: trip_reports      → 出張報告一覧
│   │   └── tab: leave_requests    → 休暇申請管理
│   │
│   ├── ExpenseForm.tsx            # 交通費申請フォーム
│   ├── HistoryView.tsx            # 申請履歴（一般ユーザー）
│   ├── MonthlyApplicationStatus.tsx # 月別申請状況
│   ├── BusinessTripReport.tsx     # 出張報告フォーム（GPS付き）
│   ├── LeaveRequest.tsx           # 休暇申請フォーム（カレンダー選択）
│   └── LeaveApprovals.tsx         # 休暇申請承認者画面
│
├── contexts/
│   └── AuthContext.tsx/ts         # 認証コンテキスト（ログイン状態管理）
│
├── hooks/
│   ├── useAuth.ts                 # 認証フック（profile取得含む）
│   └── useExpenses.ts             # 交通費データ取得フック
│
├── lib/
│   ├── supabaseClient.ts          # Supabaseクライアント初期化
│   └── leaveSlack.ts              # 休暇申請Slack通知共通関数
│
├── types/
│   └── index.ts                   # TypeScript型定義
│
└── utils/
    └── index.ts                   # ユーティリティ関数（CSV・日付等）
```

---

## Supabase Edge Functions

```
supabase/functions/
│
├── slack-notify/                  # 交通費申請のSlack通知
│   └── index.ts
│
├── send-leave-slack/              # 休暇申請のSlack通知
│   └── index.ts                  （各ステップで対応チャンネルに送信）
│
├── send-trip-slack/               # 出張報告のSlack通知（終了報告時）
│   └── index.ts                  （チャンネル選択式）
│
└── send-rejection-email/          # 却下メール送信（現在はスタブ）
    └── index.ts
```

---

## データベース（Supabase PostgreSQL）

```
auth.users                         # Supabase管理（ログイン情報）
    │ 1:1
    ▼
public.profiles                    # ユーザー詳細情報
    │  id, email, name
    │  employment_type（正社員/パート）
    │  role_title（一般/リーダー/マネージャー/社長/管理者）
    │  group_names TEXT[]（複数グループ）
    │  is_active, is_admin
    │  sort_order, leave_request_enabled
    │  leave_enabled_by
    │
    ├── 1:N → public.expenses              # 交通費申請
    │         id, user_id, type, amount
    │         status（pending/approved/rejected）
    │         rejected_reason, approved_at
    │         last_edited_at, edit_count
    │
    ├── 1:N → public.business_trip_reports # 出張報告
    │         id, user_id, report_type（到着/終了）
    │         category, location, notes
    │         latitude, longitude, address
    │         next_dates
    │
    └── 1:N → public.leave_requests        # 休暇申請
              id, user_id, approver_id, approver2_id
              status（pending/step2_pending/
                      manager_approved/admin_approved/approved/rejected）
              leave_dates TEXT（選択日付JSON）
              purpose, notes, rejected_reason
              leave_type（有給/バースデー/慶弔/その他）

public.master_options              # マスターデータ（選択肢）
    category / value / sort_order
    ├── employment_type:  正社員・パート
    ├── role_title:       一般・リーダー・マネージャー・社長・管理者
    ├── group:            こども・パート・アルバイト等10種
    ├── trip_category:    出張・園指導・試合・下見・その他
    └── trip_location_*:  場所リスト（区分ごと）
```

---

## Slack通知フロー

```
【休暇申請】
申請（リーダー宛）  →  #01リーダー回覧
申請（マネージャー宛）→  #01マネージャー回覧
リーダーが受理      →  #01マネージャー回覧
マネージャーが受理  →  #07_3閲覧禁止-経理専用
経理（管理者）が受理→  #03晃平先生へ
社長が受理          →  通知なし（完了）

【出張報告（終了時のみ）】
送信先を複数選択可：
  晃平先生へ（自動付与）/ 大人 / 本校こども
  西陣校 / 上桂校 / 洛西口校 / 南草津校
  ジュニア / お客様サポート
```

---

## デプロイフロー

```
ローカル編集
    │ git push
    ▼
GitHub (fivem-inc/fivem-portal)
    │ 自動デプロイ（Webhook）
    ▼
Vercel → https://fivem-portal.vercel.app

Edge Functions は別途手動デプロイ:
  npx supabase functions deploy <function-name> \
    --project-ref xaeynaxctiiyqxjyuzfi
```

---

## 権限・ロール構成

```
app_metadata.role = 'admin'  →  管理者（全機能）
role_title = '社長'          →  承認フロー最終ステップ
role_title = 'マネージャー'  →  承認フロー中間
role_title = 'リーダー'      →  承認フロー一人目
role_title = '一般'          →  申請のみ
employment_type = 'パート'   →  休暇申請は通常非表示
```

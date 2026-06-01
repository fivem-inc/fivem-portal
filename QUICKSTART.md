# 🚀 Claude作業開始メモ（どのPCでもコピペするだけ）

## 📌 別のPCで作業を再開する方法

**チャット履歴は別PCでは見られません。でも大丈夫！**

### 手順（3ステップ）

1. このファイル（QUICKSTART.md）を開く
   👉 https://github.com/fivem-inc/fivem-portal/blob/master/QUICKSTART.md

2. 下の「Claudeへの最初のメッセージ」をコピー

3. Claude Codeを起動して貼り付ける

→ ClaudeがGitHubとCLAUDE.mdから状況を把握して続きから作業してくれます！

**コードはGitHubに全部保存されているので、チャット履歴がなくても続きから作業できます。**

---

## Claudeへの最初のメッセージ（コピペ用）

```
fivem-portalの続きの作業をしたい。

【プロジェクト情報】
- ローカルパス: C:\Users\kohei\fivem-portal（なければgit cloneする）
- GitHub: https://github.com/fivem-inc/fivem-portal
- 新サイト: https://fivem-portal.vercel.app
- 旧サイト: https://expense-app-one-iota.vercel.app

【初めてのPCの場合】
git clone https://github.com/fivem-inc/fivem-portal.git C:\Users\[ユーザー名]\fivem-portal

【デプロイ方法】
git add . && git commit -m "変更内容" && git push
→ Vercelが自動デプロイ（1〜2分）

【重要な設定情報】
- Supabase新環境: https://supabase.com/dashboard/project/xaeynaxctiiyqxjyuzfi
- Supabase旧環境: https://supabase.com/dashboard/project/unwdmdgtzbhwflepabud
- 管理者メール: fivem.kyoto@gmail.com
- SMTP: office@five-m.com（Gmail）

【現在の状況・次回やること】
以下の2つを必ず両方読んで確認してください：
1. CLAUDE.md（プロジェクトルートにある）
2. メモリファイル: C:\Users\kohei\.claude\projects\D---------Claude-kohei\memory\work_history.md
※ work_history.md に開発ロードマップ・次回タスクが記録されています。
```

---

## 🔚 作業終了時に言うこと（コピペ用）

```
ここまでの内容を保存して終了します。
CLAUDE.mdとGitHubにも反映してください。
```

→ Claudeが今日の作業内容・次回タスクをCLAUDE.mdに書いてgit pushします。
→ 次回どのPCからでも続きから始められます。

---

## 管理画面リンク集（ブックマーク用）

| サービス | URL |
|---|---|
| 新サイト | https://fivem-portal.vercel.app |
| 旧サイト | https://expense-app-one-iota.vercel.app |
| GitHub新 | https://github.com/fivem-inc/fivem-portal |
| GitHub旧 | https://github.com/nisijin68/fivem-expense |
| Supabase新 | https://supabase.com/dashboard/project/xaeynaxctiiyqxjyuzfi |
| Supabase旧 | https://supabase.com/dashboard/project/unwdmdgtzbhwflepabud |
| Vercel | https://vercel.com/fivem-inc-s-projects/fivem-portal |

---

## 初めてのPCでの環境構築手順

```powershell
# 1. リポジトリをクローン
git clone https://github.com/fivem-inc/fivem-portal.git

# 2. フォルダに移動
cd fivem-portal/client

# 3. パッケージをインストール
npm install

# 4. ローカルで起動（テスト用）
npm run dev
```

## .env ファイルの作成（ローカル起動時に必要）

`client/.env` を作成して以下を記入：

```
VITE_SUPABASE_URL=https://xaeynaxctiiyqxjyuzfi.supabase.co
VITE_SUPABASE_ANON_KEY=（Supabaseダッシュボードから取得）
```

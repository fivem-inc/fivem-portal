# 🚀 Claude作業開始メモ（どのPCでもコピペするだけ）

## 📌 別のPCで作業を再開する方法

**チャット履歴は別PCでは見られません。でも大丈夫！**

### 手順（3ステップ）

1. このファイル（QUICKSTART.md）を開く
   👉 https://github.com/fivem-inc/fivem-portal/blob/master/QUICKSTART.md

2. 下の「Claudeへの最初のメッセージ」をコピー

3. **自分のPCのユーザー名を確認してコピペ先に貼り付ける**
   - コマンドプロンプト or PowerShellで `echo %USERNAME%` を実行
   - 表示された名前が自分のユーザー名

→ ClaudeがGitHubとCLAUDE.mdから状況を把握して続きから作業してくれます！

---

## Claudeへの最初のメッセージ（コピペ用）

> ⚠️ `[ユーザー名]` の部分は自分のPCのユーザー名に変えてください

```
fivem-portalの続きの作業をしたい。
作業はローカルで実施して
確認してからデプロイする方法ですすめて
作業前に必ず確認してから、開始ください。

【プロジェクト情報】
- GitHub: https://github.com/fivem-inc/fivem-portal
- 本番サイト: https://fivem-portal.vercel.app
- Supabase: https://supabase.com/dashboard/project/xaeynaxctiiyqxjyuzfi
- 管理者メール: fivem.kyoto@gmail.com
- SMTP: office@five-m.com（Gmail）

【ローカルパス】
以下のどちらかに存在します。両方確認して、あるほうを使ってください。
- C:\Users\kohei\fivem-portal
- C:\Users\nisij\fivem-portal
存在する場合は必ず git pull で最新にしてから作業してください。
どちらもなければ git clone してください：
git clone https://github.com/fivem-inc/fivem-portal.git C:\Users\[ユーザー名]\fivem-portal

【デプロイ方法】
git add . && git commit -m "変更内容" && git push
→ Vercelが自動デプロイ（1〜2分）

【現在の状況・次回やること】
プロジェクトルートの CLAUDE.md を読んで確認してください。
```

---

## 🔚 作業終了時に言うこと（コピペ用）

```
今日の作業は終了します。
CLAUDE.mdとメモリファイルに作業内容・次回タスクを保存して
git pushしてください。
```

→ ClaudeがCLAUDE.mdに作業記録を書いてgit pushします。
→ 次回どのPCからでも続きから始められます。

---

## 管理画面リンク集（ブックマーク用）

| サービス | URL |
|---|---|
| 本番サイト | https://fivem-portal.vercel.app |
| GitHub | https://github.com/fivem-inc/fivem-portal |
| Supabase | https://supabase.com/dashboard/project/xaeynaxctiiyqxjyuzfi |
| Vercel | https://vercel.com/fivem-inc-s-projects/fivem-portal |

---

## 初めてのPCでの環境構築手順

```powershell
# 1. ユーザー名確認
echo %USERNAME%

# 2. リポジトリをクローン（[ユーザー名]を変えること）
git clone https://github.com/fivem-inc/fivem-portal.git C:\Users\[ユーザー名]\fivem-portal

# 3. パッケージをインストール
cd C:\Users\[ユーザー名]\fivem-portal\client
npm install

# 4. ローカルで起動
npm run dev
```

ブラウザで http://localhost:5173 を開く（使用中なら5174になる）

## .env ファイルについて

リポジトリに含まれているので設定不要。
もし動かない場合は `client/.env` を確認：

```
VITE_SUPABASE_URL=https://xaeynaxctiiyqxjyuzfi.supabase.co
VITE_SUPABASE_ANON_KEY=sb_publishable_ZA6Udr3Ww9_dQO0CKKhSGw_Phx8Kegp
```

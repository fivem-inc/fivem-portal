# トラブルシューティングメモ

---

## ⚠️ 本番で動かない・ローカルでは動く → まず .env.production を確認

### 症状
- ローカル（localhost:5173）では正常動作
- 本番（fivem-portal.vercel.app）でエラー・機能が動かない

### 原因パターン
Vite のビルド優先順位：
- ローカル開発 → `.env` を使用
- 本番ビルド（Vercel） → `.env.production` を優先

`.env` だけ修正して `.env.production` を直し忘れると、本番だけ古い設定で動く。

### 確認コマンド
```powershell
cat client/.env
cat client/.env.production
```
両方の `VITE_SUPABASE_URL` が同じ（`xaeynaxctiiyqxjyuzfi`）であることを確認。

### 正しい値（2026-06-11 時点）
```
VITE_SUPABASE_URL=https://xaeynaxctiiyqxjyuzfi.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhhZXluYXhjdGlpeXF4anl1emZpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAwMzk1MTksImV4cCI6MjA5NTYxNTUxOX0.vAPzHKVNMAb1T2z9G8c8eAjQzWFbPx8NaVQUYoPDbRw
```

### 発生履歴
- **2026-05-31**：Supabase がプロジェクトURLを移行。`.env` は修正したが `.env.production` を直し忘れ。
- **2026-06-11**：ユーザー追加・メール送信が本番で動かない原因として再発見・修正。

---

## ⚠️ Supabase Edge Function が 403 になる → Legacy Anon Key を使う

### 症状
`supabase.functions.invoke()` で Edge Function を呼ぶと 403 Forbidden

### 原因
Supabase が新形式キー（`sb_publishable_...`）を導入したが、Edge Functions ゲートウェイは旧形式（`eyJ...`）しか受け付けない。

### 解決策
Supabase Dashboard → Settings → API Keys → **Legacy anon タブ** の `eyJ...` キーを使う。

---

## ⚠️ Supabase CLI が "Cannot find project ref" → supabase link を実行

### 症状
```
Cannot find project ref. Have you run supabase link?
```

### 解決策
```powershell
cd C:\Users\kohei\fivem-portal
supabase link --project-ref xaeynaxctiiyqxjyuzfi
```

### Edge Function デプロイコマンド
```powershell
supabase functions deploy <function-name>
# 例
supabase functions deploy create-user
supabase functions deploy send-email
```

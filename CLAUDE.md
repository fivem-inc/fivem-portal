# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## 🚨 先に3つだけ

1. **`master` に push した瞬間、本番に公開されます。** 試す場所（ステージング）はありません。
   スタッフ約46名が毎日使っている稼働中のシステムです。
2. **このリポジトリは Public です。** 誰でも全ファイルを読めます。
   `client/.env` と `client/.env.production` に秘密の鍵を1行も足さないでください（詳細は下）。
3. **本番のデータベースは1つだけ**です。ブランチで分けられません。流す前に一声かけてください。

---

## 📌 まず読むもの（2026-08-31〜・2人で並行して開発しています）

引き継ぎは **担当ごとに別のファイル** に分けてあります。
自分の担当のファイルを開き、いちばん上の「▶▶ 次セッション ここから開始」を読んでください。

| 触るもの | 読むファイル |
|---|---|
| 場所予約（/rooms） | `docs/引き継ぎ-場所予約.md` |
| 備品購入申請・残業・休暇・FAQ・連絡板ほか | `docs/引き継ぎ-申請系.md` |

**どちらか分からないときは、勝手にどちらかを読んで進めず、
「今日は場所予約と申請系のどちらですか」とユーザーに確認してください。**

🚨 **記録を書くときも、自分の担当のファイルに書いてください。**
同じ場所を2人で編集しないので、ぶつかりません。

> **2026-08-31 に引き継ぎを分割しました。過去の記録は消さずに上の2ファイルへ移しています。**
>
> 🚨 **移した過去ログの中に「開始時：CLAUDE.md 冒頭の引き継ぎを確認」「CLAUDE.md に
> セッション記録を保存」と書かれた行が十数箇所残っています。これは分割前のやり方です。
> 今日から無効なので、従わないでください。**
>
> - 読むところ … 担当の引き継ぎファイルの「▶▶ 次セッション ここから開始」
> - 書くところ … 担当の引き継ぎファイルの、いちばん上の案内のすぐ下
> - **この CLAUDE.md には日々の記録を書かない**（2人共通のルールだけを置く場所）

---

## 🚨 2人で開発するときの決まりごと

### ① データベースの変更ファイルは、番号を「今の時刻」で付ける

同じ日に作ると番号がぶつかります（2026-08-31 に実際 `20260831200000` が重複しました）。
**人が番号を選ぶとまたぶつかる**ので、コマンドで作った時刻をそのまま使います。

```bash
date +%Y%m%d%H%M%S        # 例: 20260831213045
ls supabase/migrations/ | grep ^2026<日付>   # 念のため同じ日の並びを確認
```

秒まで入るので、2人が同時に作らないかぎりぶつかりません。

> 担当ごとに番号帯を割り振る案もありましたが、**場所予約は1日に6本作った実績があり
> 枠が足りませんでした**。帯を決めても守れないので、時刻方式にしています。

🚨 `supabase db push` は**使わない**（履歴が同期しておらず、231本を流し直そうとして失敗する）。
SQL Editor に貼るか `supabase db query --linked --file <ファイル>` を使う。

### ② 両方が触るファイル（事前に一声かける）

**(a) 編集がぶつかりやすいもの** — 1つの配列や型に全機能が集まっており、同じ行を編集します。

```
client/src/App.tsx                                     ナビ・ルート
  └ 🚨 権限フラグを1つ足すと 31 箇所に触ります。ここが一番重い
client/src/hooks/useAuth.ts                            権限
client/src/components/AdminPanel.tsx                   管理タブ（1タブ追加で4箇所）
client/src/components/admin/AdminPanelContext.tsx      管理タブの型・配列
client/src/components/admin/FeaturePermissionsTab.tsx  権限の画面
client/src/components/admin/NotificationsTab.tsx       通知イベントの一覧
client/src/lib/notificationDispatch.ts                 通知の宛先解決
client/src/types/index.ts                              型（1ファイルに集約）
client/src/lib/draftStorage.ts                         下書きのキー一覧
supabase/config.toml                                   Edge Function の登録
client/package.json / package-lock.json                依存
```

**(b) 片方が変えると、もう片方が静かに壊れるもの** — 衝突しないので気づけません。

```
client/src/lib/timeInput.ts / components/TimeInput.tsx   すでに両者が使用中
supabase/functions/ の共用9本（deploy は丸ごと上書き・消えてもエラーが出ない）：
  push-dispatch / send-push / send-email / slack-notify / gcal-sync
  create-user / delete-user / record-signup-ip / storage-usage-check
```

🚨 **上の一覧に無いから自由、ではありません。**
既存のテーブル・関数・Edge Function・cron・**通知の仕組み**は、一覧に無くても要相談です
（`docs/開発ルール.md` 第2部 §2）。とくに通知は「**設定が無い＝全員に送る**」作りのため、
新しい種類を足すとスタッフ46人にいきなり飛びます。

### ③ 作業を始める前に必ず `git pull`

相手が先に進んでいると、あとから合流するのが大変になる。

### ④ Edge Function を出す前にも `git pull`

🚨 `supabase functions deploy` は**関数を丸ごと置き換える**。
取り込まずに出すと、相手の修正が無言で消える。

### ⑤ push が「behind」で弾かれたら、いきなり pull しない

先に、双方が触ったファイルが重なっていないかを確認する。

```bash
git fetch origin
git diff --name-only HEAD...origin/master     # 相手が触ったもの
git diff --name-only origin/master...HEAD     # 自分が触ったもの
```

重なりが0件なら、そのままマージして問題ない。

### ⑥ データベースの変更は同時にやらない

本番DBは1つしかなく、ブランチで分けられない。流す前に担当者経由で一声かける。

### ⑦ master に push ＝ その瞬間に本番公開

Vercel が自動デプロイする。試す場所（ステージング）は無い。
**スタッフ約46名が使っている稼働中のシステム。**

---

## 🚨 このリポジトリは「公開」されています

`fivem-inc/fivem-portal` は **Public**。GitHubにログインしていない人でも
URLを開けば全ファイルを読めます（2026-08-28 実測確認済み）。

これは事故ではなく **2026-07-02 のユーザー判断**です。過去に本当の漏洩事故
（開発ツールの認証情報が約1年間公開）を起こしたあと、履歴を消し、
自動チェックを入れたうえでPublicに戻しました。方針は
「危険なのはコードが見えることではなく、秘密情報が漏れること」。
加えて無料プランでは Private にすると本番の自動デプロイが止まります。

### 守ること

> **`client/.env` と `client/.env.production` に、秘密の鍵を1行も足さない。**

`VITE_` で始まる変数は**ビルド時に画面のJSへそのまま埋め込まれ**、全利用者の
ブラウザに配られます。`VITE_` を付けた時点で公開情報です。
現在入っている3つ（`VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` /
`VITE_VAPID_PUBLIC_KEY`）はいずれも公開前提のもので問題ありません。

**絶対に書いてはいけないもの**（1行足した瞬間に世界公開されます）

- `SUPABASE_SERVICE_ROLE_KEY`（DBの全権限。RLSを無視して全データを読み書きできる）
- `VAPID_PRIVATE_KEY`（スマホ通知の秘密鍵）
- データベースのパスワード / Slack Webhook URL / Resend の APIキー

→ **Supabase の Secrets** か **Vercel の環境変数**へ。

### 自動チェックの限界

| ファイル | pre-commit フック |
|---|---|
| `client/.env` | ✅ 止まる |
| `client/.env.production` | ❌ **素通り**（本番ビルドに必要でGitHubに置く前提のため対象外） |

🚨 このチェックは **PCごとの設定**です。**新しいPCには入っていません。**
設定方法は `docs/開発ルール.md` を参照（新しく参加する人にはこれを渡せば足ります）。

---

## 作業ルール（毎回厳守）

### 始めるとき
- `git pull` → `git status` → **担当の引き継ぎファイル**の冒頭を確認
- 作業開始・commit・push・デプロイは**指示を得てから**（勝手に進めない）

### 直したあと
- `cd client && npx tsc -b && npx vite build` ＋ `npm run lint`
  （lint で見るのは `react-hooks/rules-of-hooks` だけ。**常に0件**。必ず client で実行）

### 出すとき
- デプロイ順序：**① DB migration → ② Edge Function → ③ クライアント push**
  （逆にすると、まだ無い列を読みに行って画面が壊れる）
- DBは本番前に `begin; …SQL… rollback;` で1回通す。**本番DB操作は都度許可を得る**
- 適用後は必ず**実測で確認**（列・件数・権限を SELECT で数える）
- Edge Function：`npx supabase functions deploy <名前> --project-ref xaeynaxctiiyqxjyuzfi`
- **push の許可は1回分**。`git add` 前に `git status` を目視。`AGENTS.md` は含めない
- commit メッセージは Write でファイルに書いて `git commit -F <file>`
  （シェル直書きは日本語が化ける）
- push後は `git ls-remote origin master` で突合（exit 0 でも未送信のことがある）
- 着地は**本番JSに今回の日本語ラベルが載ったか**で確認
  （🚨 エントリJSは `index-*.js` ではなく `main-*.js`。ファイル名のハッシュは
  再ビルドで変わるので名前では判定できない）
- 🚨 デプロイ確認で curl を短い間隔で繰り返さない（Vercelのボット対策が作動する）

### 書くとき（コードの決まり）
- `alert()` / `window.confirm()` / `.catch()` は**使わない**
  （確認はインラインUI・成功は薄緑カード。過去に70箇所を全廃済み）
- 認証は `AuthContext` に一元化する（画面ごとに判定を書かない）
- ユーザー向け文言は「**承認→受理**」「**却下→差し戻し**」で統一
- RLS/RPCの管理者判定は必ず `(auth.jwt()->'app_metadata'->>'role')='admin'`
  （`'role'` の直参照は常に false。過去に2回踏んでいる）
- `.update()` / `.delete()` は **0件でもエラーにならない**。`.select('id')` で件数を見る
- `supabase.functions.invoke` は **4xx/5xx でも throw しない**。`error` と `success` を見る
- 時刻を扱うときは `lib/timeInput.ts` を通す（自前で `split(':')` しない）
- 日付は `toJstDateStr()` を使う（`toISOString().slice(0,10)` はUTCなので前日になる）
- **Hookは早期returnより前に置く**（後ろに置くと画面が真っ白になる）
- 絵文字は「意味が合う」「化けない」の両方を満たすものだけ。文字で通るなら付けない
  - 検証済み：🕐 📦 🌿 📅 🔔 🆘 📩 📋 ⚠️ 💬 👤 ／ 記号は ✕ ✓ ↩ ⟲ ★ ☆ → ←
  - 使わない：🗑 🖊 ⏱ 🗓 🗒️ 🗄️ 🏷️ 🏖️（□に化けた実績・その同系統）
- 🚨 RPCを `create or replace` するときは、**必ず本番の実定義から起こす**
  （`select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname='<関数名>';`）。リポジトリのファイルは最後に適用された
  版とは限らない。**古い版で上書きし、全ての備品購入申請が送信不能になった事故がある**
- 🚨 新しい関数を作ったら **anon の実行権限を確認して外す**
  （Supabaseは新しい関数に anon の実行権限を自動で付ける。`revoke … from public` では外れない）
- 🚨 **鍵の値をチャット・コミットメッセージ・コード内コメントに書かない／受け取らない**

### 詳しいルールの置き場所（毎回ここを見る）

CLAUDE.md に収まらない恒久ルールは `docs/引き継ぎ-申請系.md` の中にあります。
**場所予約の担当者も、新しい画面を作るときは必ず参照してください**（見た目が割れます）。

| 内容 | そのファイルを検索する語 |
|---|---|
| 配色（バナー／選択ボタン／入力欄）※例外なし | `🎨🔒` |
| UIフィードバックの標準（成功は緑カード等） | `UIフィードバック標準仕様` |
| 新規ページの作り方（上余白・タブ・説明枠の型） | `🏗️ 新規ページ` |
| 役職の序列 | `役職序列` |
| プッシュ通知に使ってよい文言 | `検証済み語` |

### 決めるとき
- UI文言・配色・新機能・設計判断は**案を提示→承認後に実装**（いきなり作らない）
- 文面を直すときは**3案出す**（違いも説明する）
- 大きな設計は専門エージェント2体でレビュー（委任禁止・自分で実施と明記）
- レビューの指摘は鵜呑みにせず、重要な主張は自分で動かして裏取りする
- 専門用語は新卒社会人でも分かるようかみ砕いて説明する

### 忘れやすいこと
- 🚨 機能を変えたら **社内FAQ（本番DB）と画面の注意事項も同時に直す**
  （片方だけだと画面が嘘をつく。FAQは `faq_topics` / `faq_answers` を grep して確認）
- 🚨 同じ意味の判定・ラベルを2か所に書かない（片方だけ直す事故が何度も起きている）
- 🚨 「選択肢が出る」＝「使える」ではない。受理まわりを変えるときは
  ①選択肢の出し分け ②送信前チェック ③切り替え時のリセット の3つをセットで見る

---

## 環境メモ

### 共通（2人とも同じ）

- project ref: `xaeynaxctiiyqxjyuzfi` ／ ブランチは `master`
- python は使えない。JSONの整形などは node を使う
- **日本語を含むSQL・置換は Edit / Write / node スクリプトで行う**（シェル直書きは化ける）
- 🚨 sed の区切り文字に注意（`||` を含む行を `s|...|...|` で置換すると壊れる）
- Bashの作業フォルダは cd が持続する。**絶対パスで指定する**

### 🚨 PCごとに違う（自分がどちらか、最初に確認する）

| | 申請系の担当 | 場所予約の担当 |
|---|---|---|
| 作業フォルダ | `C:\Users\kohei\fivem-portal` | `D:\Claudeファイル\fivem-portal` |
| Windowsユーザー | `kohei` | `Admin` |
| 秘密情報の pre-commit チェック | 入っている | **入っていない**（`docs/開発ルール.md` を見て設定する） |
| NAS・DBの自動バックアップ | このPCで動く（毎日12:00 / 12:30） | 動かない |

- 🚨 申請系のPCは**ホームディレクトリ（`C:\Users\kohei`）自体も git リポジトリ**。
  git は `git -C <リポジトリのパス> ...` の形で明示する
- バックアップの確認は**日付ではなく** `backup_log.txt` の末尾（バイト数）か
  `Get-FileHash` で行う（詳細は `docs/DISASTER-RECOVERY.md` / `docs/OPERATIONS.md`）

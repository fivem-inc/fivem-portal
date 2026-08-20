# 開発PC故障時の復旧手順（fivem-portal）

このドキュメントは、開発PC（現在: kohei機）が壊れた・盗難にあった・入れ替わった場合に、
非エンジニアでも読んで対応できるように書いています。

## 1. まず知っておくこと：ほとんどのデータはクラウドにあり無事

- **アプリのコード全体** → GitHub（`fivem-inc/fivem-portal`）に保存済み。PCが壊れても消えない
- **データベース・ログイン認証・サーバー側の処理（Edge Functions）** → Supabase（クラウド）
- **本番サイトそのもの** → Vercel（クラウド、GitHubと連携して自動更新）

**このPCにしかなく、壊れたら本当に消えるものは以下の4つだけ**です（これだけが日次バックアップの対象）：

| 内容 | 元の場所 | 理由 |
|---|---|---|
| `.env`（Supabase接続キー等） | `client\.env` | 秘密情報のためgit管理から除外している |
| `.env.production` | `client\.env.production` | 同上 |
| `AGENTS.md` | プロジェクト直下 | 意図的にgit管理していない作業メモ |
| Claude Codeのこのプロジェクト用メモリ | `C:\Users\kohei\.claude\projects\C--Users-kohei-fivem-portal\memory` | git管理外。⚠️ **現在このフォルダは空**（このプロジェクトは引き継ぎを CLAUDE.md に集約する運用で、メモリ機能を使っていないため）。将来使い始めたときのために対象に含めてある。ログに「WARN: claude memory folder is EMPTY」と出るのは正常 |

このドキュメント自体も**毎日NASへ`復旧手順.md`としてコピーされる**ため、PC・GitHubのどちらにもアクセスできない状況でも、NASの保存先フォルダを直接開けば読める（本文はgitの`docs/DISASTER-RECOVERY.md`にもあるが、そちらが読めない事態を想定した二重化）。

## 2. 自動バックアップの仕組み

- スクリプト: `scripts/backup-to-nas.ps1`（このリポジトリに含まれる）
- 保存先（NAS）:
  `\\NAS-SIJYO\Public\四条本校マイドキュメント\10_パソコン設定\Claud重要バックアップデータ\社内サイト`
- コピーされるファイル: `.env` / `.env.production` / `AGENTS.md` / `claude_memory`フォルダ一式 / **`復旧手順.md`（この手順書自体）**
- 実行タイミング（Windowsタスクスケジューラ・タスク名 `BackupFivemPortalToNAS`）:
  - PCへのログオン時
  - 毎日 12:00
- 方式: **上書き保存**（世代管理なし。対象ファイルが小さいため、過去分を何日も残す必要がないと判断）
- 失敗しても他のファイルの処理は止まらない（1ファイルずつ存在確認→コピー→ログ記録）

### バックアップが正常に動いているかの確認方法

1. NASの保存先フォルダを開き、`backup_log.txt` の一番下の日時が「最近」であることを確認する
2. または、PCで以下をPowerShellで実行して手動テストできる:
   ```powershell
   Start-ScheduledTask -TaskName 'BackupFivemPortalToNAS'
   Get-ScheduledTaskInfo -TaskName 'BackupFivemPortalToNAS'
   ```
   `LastTaskResult` が `0` なら「エラーなく終わった」という意味。
   ⚠️ **これはコピーできた証拠にはならない**（対象が0件でも `0` になる）。

3. ⚠️ **日付では判定できない。** NAS側のファイルの日時は次のようになっており、
   どちらも「いつバックアップされたか」を表さない。
   - `CreationTime`（作成日時）… **上書きでは更新されない**（初回コピー時のまま止まる）
   - `LastWriteTime`（更新日時）… コピー元の日時がそのまま引き継がれる

4. **確実な確認方法は次の2つ。**
   - `backup_log.txt` の末尾を見る。各行に **実際のバイト数・ファイル数** が出る。
     `OK: ...\.env (468 bytes)` のように数字が入っていれば、NAS側で存在を確認できている。
     `WARN:` で始まる行があれば、コピーできていないか中身が空。
   - 中身そのものを突き合わせる（いちばん確実）:
     ```powershell
     $p = 'C:\Users\kohei\fivem-portal\AGENTS.md'
     $n = '\\NAS-SIJYO\Public\四条本校マイドキュメント\10_パソコン設定\Claud重要バックアップデータ\社内サイト\AGENTS.md'
     (Get-FileHash $p -Algorithm MD5).Hash -eq (Get-FileHash $n -Algorithm MD5).Hash
     ```
     `True` なら最新が届いている。

   ※ `.env` のようにドットで始まるファイルは隠しファイル扱いになるため、
     PowerShell で調べるときは `Get-Item`／`Get-ChildItem` に **`-Force` が必要**。

## 3. 新しいPCでの復旧手順（壊れた時にこの順で行う）

### 準備するもの
- 新しいPC（Node.js等が使える状態）
- GitHubのアカウント（`fivem-inc/fivem-portal` にアクセスできること）
- NASへのアクセス権（社内ネットワーク）

### 手順

1. **コードを取得する**
   ```bash
   git clone https://github.com/fivem-inc/fivem-portal
   cd fivem-portal
   npm install
   cd client
   npm install
   ```
   （この時点でコード・Supabase設定の雛形・アプリ構造はすべて揃う。詳細は `CLAUDE.md` の
   「新しいPCでの環境構築手順」も参照）

2. **バックアップからファイルを戻す**

   NASの `\\NAS-SIJYO\Public\四条本校マイドキュメント\10_パソコン設定\Claud重要バックアップデータ\社内サイト`
   から以下をコピーする：

   | NAS側のファイル | 戻す先 |
   |---|---|
   | `.env` | `fivem-portal\client\.env` |
   | `.env.production` | `fivem-portal\client\.env.production` |
   | `AGENTS.md` | `fivem-portal\AGENTS.md` |
   | `claude_memory` フォルダ一式 | `C:\Users\<新しいユーザー名>\.claude\projects\C--Users-<新しいユーザー名>-fivem-portal\memory\`（Claude Codeを一度起動するとフォルダ自体は自動生成されるので、その中に中身をコピーする） |

3. **自動バックアップのタスクを作り直す**
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\<新しいユーザー名>\fivem-portal\scripts\setup-backup-task.ps1"
   ```
   ※ スクリプト内のパスが `C:\Users\kohei\...` 固定になっているため、
   ユーザー名が変わる場合は `scripts\backup-to-nas.ps1` と `scripts\setup-backup-task.ps1` の
   中のパスを新しいユーザー名に書き換えてから実行すること。

4. **動作確認**
   ```bash
   cd client
   npm run dev
   ```
   でローカル起動し、ログイン・データ表示ができるか確認する。

## 4. 注意点

- **バックアップの鮮度**：最大で「前回のログオン or 前回の12:00バックアップ」から今までの差分しか戻せない。
  例えば `.env` のキーをその日の朝に変更し、直後にPCが壊れた場合は最新の変更は失われる可能性がある。
  重要な変更をした直後は、手動で一度バックアップを走らせておくと安全（上記「手動テスト」のコマンドでOK）。
- **対象外にしたもの**：`node_modules`（`npm install`で再生成可能）、gitで管理されているコード本体
  （GitHubにあるため）、一時的なログ・実行履歴（実害が小さいため）。「全部バックアップ」はしていない。
- **他システムとの関係**：Supabase・Vercelの設定自体はクラウド側にあるため、このPCの故障とは無関係に無事。
  ただし `.env` にあるキー情報が無いと、ローカル開発環境からSupabaseに接続できない。

## 5. Supabase のプロジェクトを失った場合（PCの故障とは別のリスク）

⚠️ **PCが壊れただけならこの章は不要**。Supabaseのプロジェクトを削除・凍結などで丸ごと失ったときだけ読む。

Edge Function（サーバー側の処理）には28個の設定値が登録されている。
**値はSupabaseから取り出せない**（登録はできるが後から読めない仕組み）ため、
控えを取ることができない。失った場合は下記のとおり**再取得・再登録**する。

| 分類 | 数 | 取り戻し方 |
|---|---|---|
| `SUPABASE_*`（URL・各種キー） | 7 | **作業不要**。新しいプロジェクトを作れば自動で入る |
| `SLACK_WEBHOOK_*` | 14 | Slack → App → Incoming Webhooks で**作り直す**（対応表は下記） |
| `RESEND_API_KEY` | 1 | Resend の管理画面でAPIキーを再発行 |
| `GCAL_SERVICE_ACCOUNT_JSON` | 1 | Google Cloud でサービスアカウント（`fivem-portal-gcal@chromium-358109.iam.gserviceaccount.com`）の鍵を再発行し、対象カレンダーに「予定の変更」権限で共有し直す |
| `GCAL_CALENDAR_ID` / `_PROD` | 2 | テスト用カレンダーのID／本番は `office@five-m.com`（ファイブM共有） |
| `VAPID_PUBLIC_KEY` / `VAPID_SUBJECT` | 2 | 公開鍵は CLAUDE.md に記載あり |
| 🚨 `VAPID_PRIVATE_KEY` | 1 | **取り戻せない**（下記参照） |

### Slack Webhook の対応表（どのキーがどのチャンネルか）

| キー名 | チャンネル |
|---|---|
| `SLACK_WEBHOOK_LEADER` | #01リーダー回覧 |
| `SLACK_WEBHOOK_MANAGER` | #01マネージャー回覧 |
| `SLACK_WEBHOOK_ACCOUNTING` / `SLACK_WEBHOOK_EXPENSE` | #07_3閲覧禁止-経理専用（同じURL） |
| `SLACK_WEBHOOK_PRESIDENT` / `SLACK_WEBHOOK_TRIP_KOHEI` | #03晃平先生へ |
| `SLACK_WEBHOOK_TRIP_ADULT` | 大人 |
| `SLACK_WEBHOOK_TRIP_KIDS_MAIN` | 本校こども |
| `SLACK_WEBHOOK_TRIP_KIDS_NISHIJIN` | 西陣校 |
| `SLACK_WEBHOOK_TRIP_KIDS_KAMIKATSURA` | 上桂校 |
| `SLACK_WEBHOOK_TRIP_KIDS_RAKUSAIGUCHI` | 洛西口校 |
| `SLACK_WEBHOOK_TRIP_KIDS_MINAMISUSITA` | 南草津校 |
| `SLACK_WEBHOOK_TRIP_JUNIOR` | ジュニア |
| `SLACK_WEBHOOK_TRIP_SUPPORT` | #07_1お客様サポートへ |

### 🚨 プッシュ通知の秘密鍵（VAPID_PRIVATE_KEY）について

- **どこにも控えが無い**（2026-08-20にgit全履歴・PC内・NASを全て探索して確認済み。
  見つかるのは公開鍵だけで、公開鍵はブラウザに配布されるものなので問題ない）
- Supabaseからも取り出せないため、失った場合は**新しい鍵ペアを生成して登録し直す**
- 🚨 **鍵が変わると、スタッフのスマホに登録済みの購読はすべて無効になる**。
  データを完璧に復元しても通知だけは復活しないため、**全員に通知の再設定を依頼する必要がある**
  （iPhoneは「ホーム画面に追加」からやり直し。案内文は CLAUDE.md 2026-08-08 の項に残っている）
- 【2026-08-20 のユーザー判断】今のうちに鍵を作り直して控えを持つ案も検討したが、
  **作り直すと今すぐ全員の再設定が必要になる**ため、**現状維持**とした。
  Supabaseを丸ごと失う可能性は低く（毎日使っているので自動停止もない）、
  失った場合はどのみち大がかりな復旧作業になるため、その中に再設定が含まれても
  相対的な追加負担は小さい、という判断。

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
| Claude Codeのこのプロジェクト用メモリ | `C:\Users\kohei\.claude\projects\C--Users-kohei-fivem-portal\memory` | 引き継ぎ情報の蓄積フォルダ。git管理外 |

## 2. 自動バックアップの仕組み

- スクリプト: `scripts/backup-to-nas.ps1`（このリポジトリに含まれる）
- 保存先（NAS）:
  `\\NAS-SIJYO\Public\四条本校マイドキュメント\10_パソコン設定\Claud重要バックアップデータ\社内サイト`
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
   `LastTaskResult` が `0` なら正常終了。
3. NAS側のファイルが実際に更新されたかは **CreationTime**（作成日時）を見る。
   `LastWriteTime`（更新日時）はコピー元の日時がそのまま引き継がれるため、
   「今日バックアップされたか」の判定には使えない点に注意。

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

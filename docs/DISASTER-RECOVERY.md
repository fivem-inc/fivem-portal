# 開発PC故障時の復旧手順（fivem-portal）

このドキュメントは、開発PC（現在: kohei機）が壊れた・盗難にあった・入れ替わった場合に、
非エンジニアでも読んで対応できるように書いています。

## 1. まず知っておくこと：ほとんどのデータはクラウドにあり無事

- **アプリのコード全体** → GitHub（`fivem-inc/fivem-portal`）に保存済み。PCが壊れても消えない
- **データベース・ログイン認証・サーバー側の処理（Edge Functions）** → Supabase（クラウド）
  🚨 ただし **Supabase の無料プランには、バックアップも復元機能も一切ありません**。
  「クラウドにあるから安全」ではありません。誤って消した場合やアカウントを失った場合、
  Supabase 側から元に戻す手段はゼロです。そのため **毎日このPCからデータを吸い出して、
  暗号化して NAS に保管しています**（下の「2-2」）
- **本番サイトそのもの** → Vercel（クラウド、GitHubと連携して自動更新）

**このPCにしかなく、壊れたら本当に消えるものは以下の4つだけ**です（これだけが日次バックアップの対象）：

| 内容 | 元の場所 | 理由 |
|---|---|---|
| `.env`（Supabase接続キー等） | `client\.env` | 秘密情報のためgit管理から除外している |
| `.env.production` | `client\.env.production` | 同上 |
| `AGENTS.md` | プロジェクト直下 | 意図的にgit管理していない作業メモ |
| Claude Codeのこのプロジェクト用メモリ | `C:\Users\kohei\.claude\projects\C--Users-kohei-fivem-portal\memory` | git管理外。⚠️ **現在このフォルダは空**（このプロジェクトは引き継ぎを CLAUDE.md に集約する運用で、メモリ機能を使っていないため）。将来使い始めたときのために対象に含めてある。ログに「WARN: claude memory folder is EMPTY」と出るのは正常 |

このドキュメント自体も**毎日NASへ`復旧手順.md`としてコピーされる**ため、PC・GitHubのどちらにもアクセスできない状況でも、NASの保存先フォルダを直接開けば読める（本文はgitの`docs/DISASTER-RECOVERY.md`にもあるが、そちらが読めない事態を想定した二重化）。

## 2. 自動バックアップの仕組み（PC内のファイル）

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

## 2-2. Supabase データベースの日次バックアップ

🚨 **Supabase の無料プランには復元機能がない**ため、この仕組みが唯一の命綱です。

### 何を・どこに保管しているか

- スクリプト: `scripts/backup-supabase-db.sh`
- 保存先（NAS）:
  `\\NAS-SIJYO\Public\四条本校マイドキュメント\10_パソコン設定\Claud重要バックアップデータ\社内サイト\db-backup`
  - `daily\fivem-db-YYYYMMDD.7z` … **14世代**
  - `monthly\fivem-db-YYYYMM.7z` … **12世代**（毎月1日の分を残す）
  - `db_backup_log.txt` … 実行ログ
- 実行タイミング: **毎日 12:30**（Windowsタスク名 `BackupFivemSupabaseDB`）。
  その時刻にPCが止まっていた場合は、次に起動したときに自動で実行される
- **7-Zip の AES-256 で暗号化**。ファイル名の一覧も暗号化しているので、
  中に何が入っているかも外からは見えない（保存先が Public 共有のため必須）

### 中に入っているもの（5つ）

| ファイル | 中身 | これが無いと何が起きるか |
|---|---|---|
| `01-schema.sql` | RLSポリシー193本・関数・トリガー | 権限設定が全部消える。⚠️ **正本は本番DBの中にしかない** |
| `02-data.sql` | 業務データ＋`auth.users`（ログイン情報50件） | 申請データが消える／**誰もログインできない** |
| `03-roles.sql` | ロールの設定 | 権限の受け皿が欠ける |
| `04-cron-jobs.sql` | pg_cron のジョブ13個 | 自動実行（プッシュ配信・掃除・リマインド）が**全部止まる** |
| `05-vault-secret-names.txt` | Vault に登録されている**名前だけ** | 何を再登録すべきか分からなくなる |

🚨 `04` を別に取っているのは、**pg_cron のジョブは pg_dump では取れない**ためです
（拡張機能が管理しているテーブルはダンプの対象外になる）。取りこぼすと、
復元しても自動実行が1つも動きません。

🚨 Vault の**値**（service_role_key など）は取得できません（取るべきでもない）。
復元後に手で登録し直す必要があります。名前の一覧だけを控えています。

### 暗号化パスワード

- 32文字のランダムな文字列
- PC内では Windows の暗号化機能（DPAPI）で保護されており、
  **このPC・このユーザー以外では復号できない**
  （保存先 `C:\Users\kohei\.fivem-backup\db-backup-password.txt`）
- 🚨 **PCが壊れると、この保存分は二度と復号できません。紙の控えが唯一の鍵になります**
- 紙の控えは**2枚**（社長用・経理責任者用）を別々の場所に保管。
  **年1回、封を開けて読めるかを確認する**（開封テスト）
- 作り直すとき: `scripts\setup-backup-password.ps1`
  ⚠️ 作り直すと、**それ以前に作ったバックアップは開けなくなります**

### 正常に動いているかの確認方法

⚠️ **ここでも日付では判定できません**（PC内ファイルのバックアップと同じ理由）。

1. NAS の `db-backup\db_backup_log.txt` の**末尾**を見る。
   最後が `===== 正常終了 =====` で、その手前に次の行が並んでいれば正常：
   - `検証OK: RLSポリシー 193 本`
   - `検証OK: auth.users あり`
   - `検証OK: データダンプは最後まで完了`
   - `検証OK: 暗号化ファイルを開けることを確認`
   - `OK: NAS に保存しました （◯◯ バイト）`
2. `ERROR:` や `===== 異常終了 =====` があれば、その日は保存されていない。
   ただし**中身が怪しいものでNASを上書きしない**設計なので、前日までの分は無事です
3. 手で動かすとき:
   ```powershell
   Start-ScheduledTask -TaskName 'BackupFivemSupabaseDB'
   ```

### この仕組みでは保存されないもの

| 対象 | 理由 | どうするか |
|---|---|---|
| Storage の画像（レシート・見積書） | データベースの中に入っていないため | 紙の原本が正式な保存書類なので、当面は紙で担保（将来は月1回の取得を検討） |
| Edge Function の設定値28個 | Supabaseから読み出せない仕組み | 「5. Supabase のプロジェクトを失った場合」を参照 |
| Vault の値 | 同上 | 同上 |
| migration の適用履歴 | サーバー側に15本／199本しか残っていない | スキーマは `01-schema.sql` から戻す（`db push` では戻せない） |

### pg_dump の用意（新しいPCで必要になったとき）

このバックアップは PostgreSQL に付属する `pg_dump` を使います（本番と同じ **17系**）。
インストーラは実行せず、zip から取り出して置くだけです。

1. `https://get.enterprisedb.com/postgresql/postgresql-17.6-2-windows-x64-binaries.zip`
   をダウンロード（約315MB。配布元 EnterpriseDB ＝ PostgreSQL 公式のWindows配布元）
2. zip の中の `pgsql\bin` フォルダだけを取り出し、`C:\Users\<ユーザー名>\pgsql17\bin` に置く
3. 確認: `C:\Users\<ユーザー名>\pgsql17\bin\pg_dump.exe --version` が
   `pg_dump (PostgreSQL) 17.6` と出ればOK

⚠️ **18系など本番より新しいものは使わない**（復元のときに互換性の問題が出ることがある）。

補足: Supabase CLI が出す設定は Supabase が独自に手を入れた pg_dump 向けなので、
標準の pg_dump で動くようにスクリプト側で2箇所だけ書き換えています
（`--quote-all-identifier` → `--quote-all-identifiers`、`--exclude-schema` の `|` 区切りを個別指定へ展開）。
将来 CLI の仕様が変わって失敗するようになったら、まずここを疑ってください。

## 3. 新しいPCでの復旧手順（壊れた時にこの順で行う）

### 準備するもの
- 新しいPC（Node.js等が使える状態）
- GitHubのアカウント（`fivem-inc/fivem-portal` にアクセスできること）
- NASへのアクセス権（社内ネットワーク）
- **紙に控えたバックアップの暗号化パスワード**（データベースのバックアップを開くのに必要）
- **pg_dump 17**（データベースのバックアップを続けるのに必要。用意のしかたは「2-2」の末尾）

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

3. **自動バックアップのタスクを作り直す（2つあります）**

   ① PC内ファイルのバックアップ
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\<新しいユーザー名>\fivem-portal\scripts\setup-backup-task.ps1"
   ```

   ② Supabase データベースのバックアップ（先に pg_dump 17 を置いておくこと）
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\<新しいユーザー名>\fivem-portal\scripts\setup-backup-password.ps1"
   powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\<新しいユーザー名>\fivem-portal\scripts\setup-db-backup-task.ps1"
   ```
   🚨 **新しいPCでは、古い暗号化パスワードを復号できません**（PC・ユーザーに紐づく仕組みのため）。
   新しいパスワードを作り直すことになりますが、**紙の控えは捨てないでください**。
   それが「古いバックアップを開ける唯一の手段」です。

   ※ どのスクリプトもパスが `C:\Users\kohei\...` 固定です。ユーザー名が変わる場合は、
   `scripts\` 配下の4本（`backup-to-nas.ps1` / `setup-backup-task.ps1` /
   `backup-supabase-db.sh` / `setup-db-backup-task.ps1`）の中のパスを書き換えてから実行すること。

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

## 6. バックアップからデータベースを復元する

⚠️ この作業は、実際には**年に1回のリハーサル**でしか使いません。
だからこそ、**年1回、手順書のとおりに動くかを必ず試してください**。
いちばん怖い失敗は「いざという時に動かないバックアップ」です。

### 準備するもの
- NAS の `db-backup\daily\` にある最新の `fivem-db-YYYYMMDD.7z`
- **紙に控えた暗号化パスワード**（これが無いと中身は永久に開けません）
- `pg_dump` / `psql`（`C:\Users\kohei\pgsql17\bin`。無ければ「2-2」の末尾の手順で用意）

### 手順

1. **中身を取り出す**
   ```powershell
   & "C:\Users\kohei\scoop\shims\7z.exe" x "fivem-db-20260820.7z" -o"C:\restore"
   ```
   パスワードを聞かれるので、紙の控えを入力する。

2. **戻す先を用意する**
   - Supabase で新しいプロジェクトを作る（無料プランでよい）
   - 接続文字列（`postgresql://postgres:パスワード@db.〇〇.supabase.co:5432/postgres`）を控える

3. **この順番で流し込む**（順番を変えると外部キーのエラーで失敗します）
   ```bash
   psql "接続文字列" -f 01-schema.sql
   psql "接続文字列" -f 03-roles.sql
   psql "接続文字列" -f 02-data.sql
   psql "接続文字列" -f 04-cron-jobs.sql
   ```
   🚨 `02-data.sql` は外部キーのエラーが出ることがあります。
   `board_messages` に循環参照があるためです（バックアップ時のログにも警告が出ています）。
   その場合は、制約を一時的に止めて流し込みます:
   ```bash
   psql "接続文字列" -c "set session_replication_role = replica;" -f 02-data.sql
   ```

4. **手で戻すもの**（バックアップには入っていません）
   - Vault … `05-vault-secret-names.txt` に書かれている名前で、値を登録し直す
   - Edge Function の設定値28個 … 「5. Supabase のプロジェクトを失った場合」の表を参照
   - Edge Function の本体 … `npx supabase functions deploy <名前> --project-ref <新しいref>`
   - Storage のバケットと画像

5. **確認する**
   ```sql
   select count(*) from pg_policies;   -- 193 前後なら正常
   select count(*) from cron.job;      -- 13 前後なら正常
   select count(*) from auth.users;    -- 50 前後なら正常
   ```
   そのうえで、実際にアプリからログインできるかを確認する。

### 年1回のリハーサルでやること

1. 上の 1〜3 を、**使い捨ての無料プロジェクト**に対して実行する（本番には触らない）
2. 上の 5 の3つの数字を確認する
3. **紙の封筒を開け、パスワードが読めることを確認する**（開封テスト）
4. 終わったら使い捨てプロジェクトを削除する
5. 下の表に実施日を記録する

| 実施日 | 実施者 | 結果 | 気づいたこと |
|---|---|---|---|
| （未実施） | | | |

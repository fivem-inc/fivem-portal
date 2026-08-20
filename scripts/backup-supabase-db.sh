#!/usr/bin/env bash
# ============================================================
#  Supabase（本番データベース）の日次バックアップ
# ============================================================
#  無料プランにはバックアップも復元機能も一切ないため、
#  自前で毎日ダンプを取って NAS に暗号化して保管する。
#
#  取るもの（4つ）
#    01-schema.sql   スキーマ（RLSポリシー・関数・トリガー）※正本は本番DBの中にしかない
#    02-data.sql     データ（public + auth + storage）※auth が無いと復元してもログインできない
#    03-roles.sql    ロールの設定
#    04-cron-jobs.sql  pg_cron のジョブ（拡張が管理しているので pg_dump では取れない）
#    05-vault-secret-names.txt  Vault に登録されている名前だけ（値は取らない・取れない）
#
#  実行方法（手で試すとき）
#    "C:\Program Files\Git\bin\bash.exe" -l C:\Users\kohei\fivem-portal\scripts\backup-supabase-db.sh
#
#  詳しい設計と復元手順は docs/DISASTER-RECOVERY.md を参照。
# ============================================================

# -e は使わない。途中で失敗しても最後までログを残したいため、各ステップで自分で確認する。
set -uo pipefail

# --- 設定 ---------------------------------------------------
PROJECT_REF='xaeynaxctiiyqxjyuzfi'

# 🚨 supabase CLI は「今いるフォルダの supabase/ 」を見て、どのプロジェクトに
#    繋ぐかを決める。タスクスケジューラから起動されると作業フォルダが
#    C:\Windows\system32 になるため --linked が効かず、localhost に繋ごうとして
#    「Connection refused」で全部失敗する。必ずプロジェクトへ移動すること。
PROJECT_DIR='/c/Users/kohei/fivem-portal'

# NAS の保存先（UNCパス。ネットワークドライブの割り当てに依存しないようにする）
DEST_ROOT='//NAS-SIJYO/Public/四条本校マイドキュメント/10_パソコン設定/Claud重要バックアップデータ/社内サイト/db-backup'
DEST_DAILY="$DEST_ROOT/daily"
DEST_MONTHLY="$DEST_ROOT/monthly"
LOG_FILE="$DEST_ROOT/db_backup_log.txt"

# NAS に書けないときのローカル退避先
LOCAL_ROOT='/c/Users/kohei/.fivem-backup'
LOCAL_LOG="$LOCAL_ROOT/db_backup_error_log.txt"
WORK_DIR="$LOCAL_ROOT/work"
PASSWORD_FILE="$LOCAL_ROOT/db-backup-password.txt"

# 世代数
KEEP_DAILY=14
KEEP_MONTHLY=12

# 検証のしきい値
MIN_POLICIES=190     # RLSポリシーは193本ある。190を下回ったら異常とみなす
MIN_SHRINK_PCT=50    # 前回より50%未満に縮んでいたら異常とみなす

# ツールの場所（タスクスケジューラから起動されると PATH が細るので明示する）
export PATH="/c/Users/kohei/pgsql17/bin:/c/Users/kohei/scoop/shims:$PATH"

TODAY=$(date +%Y%m%d)
DAY_OF_MONTH=$(date +%d)
ARCHIVE_NAME="fivem-db-$TODAY.7z"

# --- ログ ---------------------------------------------------
log() {
    local line
    line="$(date '+%Y-%m-%d %H:%M:%S')  $1"
    echo "$line"
    # リダイレクト自体の失敗（NASに繋がらない等）は 2>/dev/null では消せないので、
    # ブロック全体を囲んで抑制する。囲まないと画面にエラーが出続ける。
    if ! { echo "$line" >> "$LOG_FILE"; } 2>/dev/null; then
        mkdir -p "$LOCAL_ROOT" 2>/dev/null
        { echo "$line" >> "$LOCAL_LOG"; } 2>/dev/null
    fi
}

# --- 後片付け（途中で落ちても平文のダンプを残さない） -------
cleanup() {
    if [ -d "$WORK_DIR" ]; then
        rm -rf "$WORK_DIR" 2>/dev/null
    fi
}
trap cleanup EXIT

FAILED=0
fail() { log "ERROR: $1"; FAILED=1; }

# 保存先を先に作っておく（NASに繋がっていれば、最初の1行目からNASのログに残る）
mkdir -p "$DEST_ROOT" 2>/dev/null

log "===== バックアップ開始 ====="

# --- 前提の確認 ---------------------------------------------
for cmd in pg_dump psql supabase 7z; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
        fail "$cmd が見つかりません（PATH を確認してください）"
        log "===== 中止 ====="
        exit 1
    fi
done

if ! cd "$PROJECT_DIR" 2>/dev/null; then
    fail "プロジェクトフォルダへ移動できません: $PROJECT_DIR"
    log "===== 中止 ====="
    exit 1
fi

if [ ! -d "$PROJECT_DIR/supabase" ]; then
    fail "$PROJECT_DIR に supabase フォルダがありません（--linked が効きません）"
    log "===== 中止 ====="
    exit 1
fi

if [ ! -f "$PASSWORD_FILE" ]; then
    fail "暗号化パスワードが未設定です。先に scripts/setup-backup-password.ps1 を1回実行してください"
    log "===== 中止 ====="
    exit 1
fi

# --- 暗号化パスワードを取り出す -----------------------------
# Windows の DPAPI で暗号化されているので PowerShell に復号してもらう。
# このPC・このユーザーでしか復号できない。
# 【重要】PowerShell に渡すパスは Windows 形式（C:\...）にすること。
#   bash 側の /c/Users/... のままだと PowerShell はファイルを見つけられず、
#   「復号できません」という紛らわしい失敗になる。
PASSWORD_FILE_WIN=$(cygpath -w "$PASSWORD_FILE" 2>/dev/null || echo "$PASSWORD_FILE")
PW_ERR="$LOCAL_ROOT/.pwerr"

BACKUP_PASSWORD=$(powershell -NoProfile -NonInteractive -Command "
    \$ErrorActionPreference='Stop'
    \$s = (Get-Content '$PASSWORD_FILE_WIN' -Raw).Trim() | ConvertTo-SecureString
    [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR(
        [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR(\$s))
" 2>"$PW_ERR" | tr -d '\r\n')

if [ -z "$BACKUP_PASSWORD" ]; then
    fail "暗号化パスワードを復号できませんでした"
    # 原因を握りつぶさない。ファイルが無いのか、別PCで復号できないのかを残す。
    [ -s "$PW_ERR" ] && log "  詳細: $(head -3 "$PW_ERR" | tr '\n' ' ' | cut -c1-200)"
    rm -f "$PW_ERR" 2>/dev/null
    log "===== 中止 ====="
    exit 1
fi
rm -f "$PW_ERR" 2>/dev/null

# --- 作業フォルダ -------------------------------------------
rm -rf "$WORK_DIR" 2>/dev/null
mkdir -p "$WORK_DIR" || { fail "作業フォルダを作れません: $WORK_DIR"; exit 1; }

# --- ダンプ本体 ---------------------------------------------
# Supabase CLI の --dry-run は「pg_dump を実行する bash スクリプト」を出力する。
# 接続用のパスワードはそのつど使い捨てのものが発行されるので、PC には保存しない。
#
# ただし CLI は Supabase が独自にパッチした pg_dump を前提にしているので、
# 標準の pg_dump 17 で動くように2箇所だけ書き換える：
#   1. --quote-all-identifier（単数形）は標準にない → --quote-all-identifiers
#   2. --exclude-schema "A|B|C" の | 区切りは標準が解釈しない → 個別指定に展開
translate() {
    sed -E 's/--quote-all-identifier\b/--quote-all-identifiers/g' \
      | sed -E '/--exclude-schema/ s/\|/" --exclude-schema "/g'
}

run_dump() {
    local label="$1" outfile="$2"; shift 2
    local err="$WORK_DIR/.err"
    # supabase 側のエラーも捨てない（捨てると「なぜ失敗したか」が永久に分からなくなる）。
    # 正常時はここに "Initialising login role..." などの進捗が入るだけ。
    local sberr="$WORK_DIR/.sberr"
    # 失敗したときに何が起きたかを必ず残す（pg_dump側とCLI側の両方）。
    # PGPASSWORD を含む行だけは絶対にログへ出さない。
    detail() {
        [ -s "$err" ]   && log "  詳細: $(head -3 "$err" | tr '\n' ' ' | cut -c1-200)"
        [ -s "$sberr" ] && log "  CLI : $(grep -v 'PGPASSWORD' "$sberr" | tail -3 | tr '\n' ' ' | cut -c1-200)"
    }

    if supabase db dump --linked --dry-run "$@" 2>"$sberr" | translate | bash > "$outfile" 2>"$err"; then
        local bytes; bytes=$(wc -c < "$outfile")
        if [ "$bytes" -eq 0 ]; then
            fail "$label のダンプが 0 バイトです"
            detail
            return 1
        fi
        log "OK: $label （$bytes バイト）"
        # pg_dump の warning は失敗ではないので、参考として残すだけにする
        if grep -q 'warning' "$err" 2>/dev/null; then
            log "  参考: $(grep 'warning' "$err" | head -1 | cut -c1-120)"
        fi
        return 0
    else
        fail "$label のダンプに失敗しました"
        detail
        return 1
    fi
}

run_dump "スキーマ" "$WORK_DIR/01-schema.sql"
run_dump "データ"   "$WORK_DIR/02-data.sql" --data-only
run_dump "ロール"   "$WORK_DIR/03-roles.sql" --role-only

# --- pg_cron のジョブ ---------------------------------------
# pg_cron のジョブ定義は拡張が持つテーブルにあるため pg_dump には含まれない。
# 取りこぼすと、復元しても自動実行（プッシュ配信・掃除・リマインド）が全部止まる。
# 接続情報だけ --dry-run から借りる。cron スキーマは postgres ロールでないと読めない。
eval "$(supabase db dump --linked --dry-run 2>/dev/null | grep '^export PG')"

CRON_FILE="$WORK_DIR/04-cron-jobs.sql"
{
    echo "-- pg_cron のジョブ一覧（$(date '+%Y-%m-%d %H:%M:%S') 時点）"
    echo "-- pg_dump では取れないので、この SQL で作り直す。"
    echo "-- 復元後、Vault に service_role_key を登録してから実行すること。"
    echo ""
} > "$CRON_FILE"

if psql -Atq -c "set role postgres; select '-- jobid=' || jobid || '  ' || jobname || '  [' || schedule || ']  active=' || active from cron.job order by jobid;" >> "$CRON_FILE" 2>"$WORK_DIR/.err"; then
    echo "" >> "$CRON_FILE"
    psql -Atq -c "set role postgres; select 'select cron.schedule(' || quote_literal(jobname) || ', ' || quote_literal(schedule) || ', ' || quote_literal(command) || ');' from cron.job order by jobid;" >> "$CRON_FILE" 2>>"$WORK_DIR/.err"
    echo "" >> "$CRON_FILE"
    # 停止中のジョブは、作り直したあとに止め直す必要がある
    psql -Atq -c "set role postgres; select 'update cron.job set active = false where jobname = ' || quote_literal(jobname) || ';' from cron.job where not active order by jobid;" >> "$CRON_FILE" 2>>"$WORK_DIR/.err"
    CRON_COUNT=$(grep -c '^select cron.schedule' "$CRON_FILE")
    log "OK: cronジョブ （$CRON_COUNT 件）"
else
    fail "cronジョブを取得できませんでした"
    [ -s "$WORK_DIR/.err" ] && log "  詳細: $(head -2 "$WORK_DIR/.err" | tr '\n' ' ')"
    CRON_COUNT=0
fi

# --- Vault に入っている名前だけ控える -----------------------
# 値は取らない（取るべきではない）。復元時に「何を再登録すべきか」が分かれば足りる。
VAULT_FILE="$WORK_DIR/05-vault-secret-names.txt"
{
    echo "Vault に登録されている名前の一覧（値は含まれていません）"
    echo "復元後、Supabase ダッシュボードの Vault で同じ名前で登録し直す必要があります。"
    echo "----------------------------------------"
} > "$VAULT_FILE"
psql -Atq -c "set role postgres; select name from vault.secrets order by name;" >> "$VAULT_FILE" 2>/dev/null \
    && log "OK: Vaultの名前一覧" || log "WARN: Vaultの名前一覧を取得できませんでした（バックアップ自体は続行します）"

# 接続情報はもう使わないので消す
unset PGPASSWORD PGHOST PGPORT PGUSER PGDATABASE

# --- 中身の検証（サイズではなく中身で見る） -----------------
# 「ファイルはあるのに中身が空」を見逃さないための確認。
# 🚨 `grep -c ... || echo 0` と書いてはいけない。grep は該当0件でも "0" を出力した上で
#    終了コード1を返すため、|| の右側も動いて "0\n0" という2行の値になる。
#    そうなると数値比較が壊れて「0本なのに検証OK」という最悪の誤判定になる（実際に起きた）。
POLICY_COUNT=$(grep -c '^CREATE POLICY' "$WORK_DIR/01-schema.sql" 2>/dev/null || true)
POLICY_COUNT=${POLICY_COUNT:-0}
if [ "$POLICY_COUNT" -lt "$MIN_POLICIES" ]; then
    fail "RLSポリシーが $POLICY_COUNT 本しかありません（$MIN_POLICIES 本以上あるはずです）"
else
    log "検証OK: RLSポリシー $POLICY_COUNT 本"
fi

AUTH_USERS=$(grep -c 'INSERT INTO "auth"."users"' "$WORK_DIR/02-data.sql" 2>/dev/null || true)
AUTH_USERS=${AUTH_USERS:-0}
if [ "$AUTH_USERS" -lt 1 ]; then
    fail "データに auth.users（ログイン情報）が入っていません。これでは復元してもログインできません"
else
    log "検証OK: auth.users あり"
fi

if ! grep -q 'PostgreSQL database dump complete' "$WORK_DIR/02-data.sql" 2>/dev/null; then
    fail "データダンプが最後まで書き終わっていません（途中で切れています）"
else
    log "検証OK: データダンプは最後まで完了"
fi

if [ "$CRON_COUNT" -lt 1 ]; then
    fail "cronジョブが1件も取れていません"
fi

# --- 圧縮して暗号化 -----------------------------------------
# -mhe=on はファイル名の一覧も暗号化する。保存先が Public 共有なので、
# 中に何が入っているかを外から見えないようにするために必須。
# （7z 形式のパスワード暗号化は AES-256）
ARCHIVE_LOCAL="$LOCAL_ROOT/$ARCHIVE_NAME"
rm -f "$ARCHIVE_LOCAL" 2>/dev/null

if 7z a -t7z -mx=5 -mhe=on -p"$BACKUP_PASSWORD" "$ARCHIVE_LOCAL" "$WORK_DIR/"*.sql "$WORK_DIR/"*.txt > /dev/null 2>&1; then
    ARCHIVE_SIZE=$(wc -c < "$ARCHIVE_LOCAL")
    log "OK: 暗号化しました （$ARCHIVE_SIZE バイト）"
else
    fail "暗号化に失敗しました"
    ARCHIVE_SIZE=0
fi

# 暗号化ファイルが本当に開けるか、その場で確かめる
# （パスワードが違えば、ここで必ず失敗する）
if [ "$ARCHIVE_SIZE" -gt 0 ]; then
    if 7z t -p"$BACKUP_PASSWORD" "$ARCHIVE_LOCAL" > /dev/null 2>&1; then
        log "検証OK: 暗号化ファイルを開けることを確認"
    else
        fail "暗号化ファイルを開けませんでした"
    fi
fi

# --- 前回より極端に小さくなっていないか ---------------------
PREV=$(ls -t "$DEST_DAILY"/fivem-db-*.7z 2>/dev/null | head -1)
if [ -n "$PREV" ] && [ "$ARCHIVE_SIZE" -gt 0 ]; then
    PREV_SIZE=$(wc -c < "$PREV" 2>/dev/null || echo 0)
    if [ "$PREV_SIZE" -gt 0 ]; then
        PCT=$(( ARCHIVE_SIZE * 100 / PREV_SIZE ))
        if [ "$PCT" -lt "$MIN_SHRINK_PCT" ]; then
            fail "前回より小さすぎます（前回の ${PCT}%）。中身が欠けている可能性があります"
        else
            log "検証OK: 前回比 ${PCT}%"
        fi
    fi
fi

# --- 検証を通ったものだけ NAS へ ----------------------------
if [ "$FAILED" -ne 0 ]; then
    log "WARN: 検証に通らなかったため NAS には保存しません（古いバックアップはそのまま残ります）"
    log "===== 異常終了 ====="
    rm -f "$ARCHIVE_LOCAL" 2>/dev/null
    exit 1
fi

if ! mkdir -p "$DEST_DAILY" "$DEST_MONTHLY" 2>/dev/null; then
    fail "NAS に接続できません（$DEST_ROOT）"
    log "  暗号化ファイルはPC内に残してあります: $ARCHIVE_LOCAL"
    log "===== 異常終了 ====="
    exit 1
fi

if cp -f "$ARCHIVE_LOCAL" "$DEST_DAILY/$ARCHIVE_NAME" 2>/dev/null; then
    NAS_SIZE=$(wc -c < "$DEST_DAILY/$ARCHIVE_NAME" 2>/dev/null || echo -1)
    if [ "$NAS_SIZE" -eq "$ARCHIVE_SIZE" ]; then
        log "OK: NAS に保存しました （$NAS_SIZE バイト）"
    else
        fail "NAS 側のサイズが違います（PC=$ARCHIVE_SIZE NAS=$NAS_SIZE）"
    fi
else
    fail "NAS へのコピーに失敗しました"
fi

# --- 月次（毎月1日の分を12か月ぶん残す） --------------------
if [ "$DAY_OF_MONTH" = "01" ]; then
    MONTHLY_NAME="fivem-db-$(date +%Y%m).7z"
    if cp -f "$ARCHIVE_LOCAL" "$DEST_MONTHLY/$MONTHLY_NAME" 2>/dev/null; then
        log "OK: 月次バックアップとしても保存しました （$MONTHLY_NAME）"
    else
        log "WARN: 月次バックアップの保存に失敗しました"
    fi
fi

# --- 古い世代を消す -----------------------------------------
# 日次は14世代、月次は12世代。新しいものから数えて、それより古い分を消す。
purge() {
    local dir="$1" keep="$2" label="$3"
    local old
    old=$(ls -t "$dir"/fivem-db-*.7z 2>/dev/null | tail -n +$((keep + 1)))
    if [ -n "$old" ]; then
        local n=0
        while IFS= read -r f; do
            [ -z "$f" ] && continue
            rm -f "$f" 2>/dev/null && n=$((n + 1))
        done <<< "$old"
        [ "$n" -gt 0 ] && log "OK: 古い${label}を $n 件削除しました（$keep 世代を保持）"
    fi
}
purge "$DEST_DAILY" "$KEEP_DAILY" "日次バックアップ"
purge "$DEST_MONTHLY" "$KEEP_MONTHLY" "月次バックアップ"

# --- PC内の一時コピーを消す ---------------------------------
rm -f "$ARCHIVE_LOCAL" 2>/dev/null

DAILY_COUNT=$(ls "$DEST_DAILY"/fivem-db-*.7z 2>/dev/null | wc -l)
MONTHLY_COUNT=$(ls "$DEST_MONTHLY"/fivem-db-*.7z 2>/dev/null | wc -l)
log "現在の保管数: 日次 $DAILY_COUNT 件 / 月次 $MONTHLY_COUNT 件"
log "===== 正常終了 ====="
exit 0

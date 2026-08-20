# ============================================================
#  バックアップの暗号化パスワードを作る（最初に1回だけ実行）
# ============================================================
#  このスクリプトがやること
#   1. 32文字のランダムなパスワードを作る
#   2. このPC・このユーザーでしか読めない形（Windows DPAPI）で保存する
#   3. 画面にパスワードを表示する  ← 紙に書き写してください（2枚）
#
#  【重要】PCが壊れると、保存した分は二度と復号できません。
#          紙に書いた控えが唯一の鍵になります。
#
#  実行方法：PowerShell を開いて
#    powershell -ExecutionPolicy Bypass -File C:\Users\kohei\fivem-portal\scripts\setup-backup-password.ps1
# ============================================================

$ErrorActionPreference = 'Stop'

# 保存先。リポジトリの中に置くと GitHub に上がる事故が起きるので、必ず外に置く。
$storeDir  = 'C:\Users\kohei\.fivem-backup'
$storePath = Join-Path $storeDir 'db-backup-password.txt'

if (-not (Test-Path $storeDir)) {
    New-Item -ItemType Directory -Force -Path $storeDir | Out-Null
}

# すでにある場合は、上書きしてよいか必ず確認する。
# 上書きすると、既存の暗号化ファイルを開ける鍵が失われる。
if (Test-Path $storePath) {
    Write-Host ''
    Write-Host '  すでにパスワードが保存されています。' -ForegroundColor Yellow
    Write-Host '  上書きすると、これまでに作ったバックアップを開けなくなります。' -ForegroundColor Yellow
    Write-Host '  （古いバックアップを捨ててよい場合だけ、作り直してください）' -ForegroundColor Yellow
    Write-Host ''
    $answer = Read-Host '  作り直しますか？  yes と入力すると作り直します'
    if ($answer -ne 'yes') {
        Write-Host '  中止しました。既存のパスワードはそのままです。' -ForegroundColor Green
        exit 0
    }
    # 念のため、古いものを日付つきで退避しておく（PCが同じなら復号できる）
    $backupOld = Join-Path $storeDir ("db-backup-password.old-{0}.txt" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
    try {
        Copy-Item $storePath $backupOld -Force -ErrorAction Stop
        Write-Host "  古いパスワードを退避しました: $backupOld" -ForegroundColor DarkGray
    } catch {
        # 退避できなくても作り直しは続行する（元ファイルが壊れている場合など）
        Write-Host "  古いパスワードの退避はできませんでした（続行します）" -ForegroundColor DarkGray
    }
}

# --- パスワードを作る ---------------------------------------
# 紙に書き写すので、見間違えやすい文字（0 O o 1 l I）は使わない。
$chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'
$length = 32

$bytes = New-Object 'System.Byte[]' ($length * 4)
# 【注意】RandomNumberGenerator::Fill() は PowerShell 7 以降（.NET Core）にしかない。
#   Windows PowerShell 5.1（powershell コマンドで起動するほう）では
#   「Fill という名前のメソッドが含まれないため、メソッドの呼び出しに失敗しました」になる。
#   どちらでも動く Create() / GetBytes() を使うこと。
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try {
    $rng.GetBytes($bytes)
} finally {
    $rng.Dispose()
}

$sb = New-Object System.Text.StringBuilder
for ($i = 0; $i -lt $length; $i++) {
    # 4バイトを整数に変換して、文字の種類数で割った余りを使う
    $value = [System.BitConverter]::ToUInt32($bytes, $i * 4)
    [void]$sb.Append($chars[[int]($value % [uint32]$chars.Length)])
}
$password = $sb.ToString()

# --- DPAPI で保存 -------------------------------------------
# ConvertFrom-SecureString は、既定で「このPCのこのユーザー」だけが
# 復号できる形に暗号化する（Windows DPAPI）。
$secure = ConvertTo-SecureString -String $password -AsPlainText -Force
# 【重要】Set-Content は既定で末尾に改行を足す。その改行が入っていると、
#   読み戻すときに ConvertTo-SecureString が
#   「入力文字列の形式が正しくありません」で失敗する。-NoNewline が必須。
#   読み出す側（backup-supabase-db.sh）でも Trim() すること。
$secure | ConvertFrom-SecureString | Set-Content -Path $storePath -Encoding ASCII -NoNewline

# 保存したものを読み直して、本当に元に戻せるか必ず確認する
$check = (Get-Content $storePath -Raw).Trim() | ConvertTo-SecureString
$checkPlain = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR(
    [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($check))
if ($checkPlain -ne $password) {
    Write-Host '  保存の確認に失敗しました。もう一度実行してください。' -ForegroundColor Red
    exit 1
}

# 書き写しやすいように4文字ずつ区切った表示も出す（区切りの空白はパスワードに含まれません）
$spaced = ($password -split '(.{4})' | Where-Object { $_ -ne '' }) -join ' '

Write-Host ''
Write-Host '============================================================' -ForegroundColor Cyan
Write-Host '  バックアップの暗号化パスワードを作りました' -ForegroundColor Cyan
Write-Host '============================================================' -ForegroundColor Cyan
Write-Host ''
Write-Host '  そのままの形（コピー用）:' -ForegroundColor White
Write-Host "    $password" -ForegroundColor Yellow
Write-Host ''
Write-Host '  書き写す用（4文字ずつ・空白は含みません）:' -ForegroundColor White
Write-Host "    $spaced" -ForegroundColor Yellow
Write-Host ''
Write-Host '  ---- ここから先は必ずやってください ----' -ForegroundColor White
Write-Host '   1. 上のパスワードを紙に2枚書き写す（社長用・経理責任者用）' -ForegroundColor White
Write-Host '   2. それぞれ封筒に入れ、別々の場所に保管する' -ForegroundColor White
Write-Host '   3. 年に1回、封を開けて読めるか確認する（開封テスト）' -ForegroundColor White
Write-Host '   4. 書き写したら、この画面を閉じる' -ForegroundColor White
Write-Host ''
Write-Host "  PCへの保存先: $storePath" -ForegroundColor DarkGray
Write-Host '  （このPCのこのユーザーでしか読めない形で保存されています。' -ForegroundColor DarkGray
Write-Host '    PCが壊れると読めなくなるので、紙の控えが唯一の鍵になります）' -ForegroundColor DarkGray
Write-Host ''
Write-Host '  ※ このパスワードはチャットやメールに貼らないでください。' -ForegroundColor Red
Write-Host ''

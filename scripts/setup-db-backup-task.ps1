# ============================================================
#  Supabase の日次バックアップを Windows のタスクに登録する
# ============================================================
#  最初に1回だけ実行してください（何度実行しても構いません）。
#
#    powershell -ExecutionPolicy Bypass -File C:\Users\kohei\fivem-portal\scripts\setup-db-backup-task.ps1
#
#  先に scripts\setup-backup-password.ps1 を実行して
#  暗号化パスワードを作っておく必要があります。
# ============================================================

$ErrorActionPreference = 'Stop'

$taskName   = 'BackupFivemSupabaseDB'
$bashPath   = 'C:\Program Files\Git\bin\bash.exe'
$scriptPath = '/c/Users/kohei/fivem-portal/scripts/backup-supabase-db.sh'

if (-not (Test-Path $bashPath)) {
    Write-Host "  Git Bash が見つかりません: $bashPath" -ForegroundColor Red
    Write-Host '  Git for Windows がインストールされているか確認してください。' -ForegroundColor Red
    exit 1
}

if (-not (Test-Path 'C:\Users\kohei\.fivem-backup\db-backup-password.txt')) {
    Write-Host '  暗号化パスワードがまだ作られていません。' -ForegroundColor Yellow
    Write-Host '  先に setup-backup-password.ps1 を実行してください。' -ForegroundColor Yellow
    Write-Host '  （このまま登録することもできますが、実行しても失敗します）' -ForegroundColor Yellow
    $answer = Read-Host '  それでも登録しますか？  yes と入力すると登録します'
    if ($answer -ne 'yes') { Write-Host '  中止しました。' -ForegroundColor Green; exit 0 }
}

$action = New-ScheduledTaskAction -Execute $bashPath -Argument $scriptPath

# 毎日 12:30。既存のファイルバックアップ（12:00）とぶつからない時刻にしている。
$trigger = New-ScheduledTaskTrigger -Daily -At 12:30PM

# StartWhenAvailable: 12:30 にPCが止まっていた場合、次に起動したときに実行する。
#   これが無いと、その日のバックアップが黙って飛ぶ。
# ExecutionTimeLimit: 万一ぶら下がっても1時間で打ち切る。
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Hours 1) `
    -MultipleInstances IgnoreNew `
    -DontStopIfGoingOnBatteries `
    -AllowStartIfOnBatteries

$principal = New-ScheduledTaskPrincipal -UserId "$env:COMPUTERNAME\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null

Write-Host ''
Write-Host "  タスク '$taskName' を登録しました（毎日 12:30 / PCが止まっていたら次回起動時）" -ForegroundColor Green
Write-Host ''
Write-Host '  今すぐ試すには:' -ForegroundColor White
Write-Host "    Start-ScheduledTask -TaskName '$taskName'" -ForegroundColor Cyan
Write-Host ''
Write-Host '  結果の確認は、NAS の db-backup\db_backup_log.txt の末尾を見てください。' -ForegroundColor White
Write-Host '  （日付ではなく、ログに書かれたバイト数・件数で確認します）' -ForegroundColor DarkGray
Write-Host ''

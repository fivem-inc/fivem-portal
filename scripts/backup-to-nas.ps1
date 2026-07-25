# Daily backup of PC-only critical files to NAS (overwrite, no generation history).
# What this covers: files that exist ONLY on this PC and are NOT in git/Supabase/Vercel.
# See docs/DISASTER-RECOVERY.md for the full recovery procedure.

$ErrorActionPreference = 'Continue'

$destRoot = '\\NAS-SIJYO\Public\四条本校マイドキュメント\10_パソコン設定\Claud重要バックアップデータ\社内サイト'
$logFile = Join-Path $destRoot 'backup_log.txt'
$localErrorLog = 'C:\Users\kohei\fivem-portal\scripts\backup_error_log.txt'

function Write-BackupLog {
    param([string]$Message)
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $Message"
    try {
        Add-Content -Path $logFile -Value $line -ErrorAction Stop
    } catch {
        Add-Content -Path $localErrorLog -Value $line -ErrorAction SilentlyContinue
    }
}

try {
    if (-not (Test-Path $destRoot)) {
        New-Item -ItemType Directory -Force -Path $destRoot | Out-Null
    }
} catch {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  ERROR: NAS unreachable - $($_.Exception.Message)"
    Add-Content -Path $localErrorLog -Value $line -ErrorAction SilentlyContinue
    exit 1
}

$targets = @(
    @{ Src = 'C:\Users\kohei\fivem-portal\client\.env'; DstName = '.env' },
    @{ Src = 'C:\Users\kohei\fivem-portal\client\.env.production'; DstName = '.env.production' },
    @{ Src = 'C:\Users\kohei\fivem-portal\AGENTS.md'; DstName = 'AGENTS.md' },
    @{ Src = 'C:\Users\kohei\fivem-portal\docs\DISASTER-RECOVERY.md'; DstName = '復旧手順.md' }
)

foreach ($t in $targets) {
    if (Test-Path $t.Src) {
        try {
            Copy-Item -Path $t.Src -Destination (Join-Path $destRoot $t.DstName) -Force
            Write-BackupLog "OK: $($t.Src)"
        } catch {
            Write-BackupLog "ERROR copying $($t.Src): $($_.Exception.Message)"
        }
    } else {
        Write-BackupLog "SKIP (not found): $($t.Src)"
    }
}

$memorySrc = 'C:\Users\kohei\.claude\projects\C--Users-kohei-fivem-portal\memory'
$memoryDst = Join-Path $destRoot 'claude_memory'
if (Test-Path $memorySrc) {
    try {
        if (-not (Test-Path $memoryDst)) { New-Item -ItemType Directory -Force -Path $memoryDst | Out-Null }
        Copy-Item -Path (Join-Path $memorySrc '*') -Destination $memoryDst -Recurse -Force -ErrorAction Stop
        Write-BackupLog "OK: claude memory folder"
    } catch {
        Write-BackupLog "ERROR copying claude memory: $($_.Exception.Message)"
    }
} else {
    Write-BackupLog "SKIP (not found): claude memory folder"
}

Write-BackupLog "Backup run finished"

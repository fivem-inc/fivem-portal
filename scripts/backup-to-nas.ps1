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
    @{ Src = 'C:\Users\kohei\fivem-portal\docs\DISASTER-RECOVERY.md'; DstName = '復旧手順.md' },
    # 運用メモも NAS に置く。PC も GitHub も見られない状況で、NAS だけを開いた人が
    # 「何がいつ動いているか」「何を確認すればよいか」を読めるようにするため。
    @{ Src = 'C:\Users\kohei\fivem-portal\docs\OPERATIONS.md'; DstName = '運用メモ.md' }
)

foreach ($t in $targets) {
    if (Test-Path $t.Src) {
        try {
            $destPath = Join-Path $destRoot $t.DstName
            Copy-Item -Path $t.Src -Destination $destPath -Force
            # Verify on the NAS side. A log line saying "OK" is not proof that the file arrived,
            # so compare the size against the source.
            # -Force is required: dot-files such as .env are treated as hidden and
            # Get-Item cannot see them without it.
            $srcSize = (Get-Item $t.Src -Force).Length
            $dstSize = if (Test-Path $destPath) { (Get-Item $destPath -Force).Length } else { -1 }
            if ($srcSize -eq 0) {
                # An empty source would pass the size check below (0 -eq 0) and be logged as OK,
                # silently overwriting a good backup on the NAS with an empty file. Catch it first.
                Write-BackupLog "WARN: $($t.Src) is EMPTY on this PC (0 bytes) - check the source file"
            } elseif ($dstSize -eq $srcSize) {
                Write-BackupLog "OK: $($t.Src) ($srcSize bytes)"
            } else {
                Write-BackupLog "WARN: $($t.Src) size mismatch (PC=$srcSize NAS=$dstSize)"
            }
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
        # Copy-Item with a wildcard does NOT fail when the folder is empty, so it used to log
        # "OK" even though nothing was copied. Count the files and say so explicitly.
        $srcCount = @(Get-ChildItem -Path $memorySrc -Recurse -Force -File -ErrorAction SilentlyContinue).Count
        if ($srcCount -eq 0) {
            Write-BackupLog "WARN: claude memory folder is EMPTY on this PC (0 files) - nothing to copy"
        } else {
            Copy-Item -Path (Join-Path $memorySrc '*') -Destination $memoryDst -Recurse -Force -ErrorAction Stop
            $dstCount = @(Get-ChildItem -Path $memoryDst -Recurse -Force -File -ErrorAction SilentlyContinue).Count
            Write-BackupLog "OK: claude memory folder (PC=$srcCount files / NAS=$dstCount files)"
        }
    } catch {
        Write-BackupLog "ERROR copying claude memory: $($_.Exception.Message)"
    }
} else {
    Write-BackupLog "SKIP (not found): claude memory folder"
}

Write-BackupLog "Backup run finished"

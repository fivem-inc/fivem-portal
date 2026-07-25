# Registers/updates the daily NAS backup scheduled task for fivem-portal.
# Run this once on a new PC after: git clone + this scripts folder is restored.
# Safe to re-run (Register-ScheduledTask -Force overwrites the existing definition).

$taskName = 'BackupFivemPortalToNAS'
$scriptPath = 'C:\Users\kohei\fivem-portal\scripts\backup-to-nas.ps1'

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$scriptPath`""

$triggerLogon = New-ScheduledTaskTrigger -AtLogOn -User "$env:COMPUTERNAME\$env:USERNAME"
$triggerNoon  = New-ScheduledTaskTrigger -Daily -At 12:00PM

$principal = New-ScheduledTaskPrincipal -UserId "$env:COMPUTERNAME\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($triggerLogon, $triggerNoon) -Principal $principal -Force | Out-Null

Write-Output "Task '$taskName' registered (triggers: at logon + daily 12:00)."
Write-Output "Test it now with: Start-ScheduledTask -TaskName '$taskName'"

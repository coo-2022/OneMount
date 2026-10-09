param([Parameter(Mandatory=$true)][string]$Script)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'Disposable GitHub Actions runner only' }
$root = Split-Path -Parent $PSScriptRoot
$scriptPath = (Resolve-Path (Join-Path $root $Script)).Path
$node = (Get-Command node.exe).Source
$name = 'omtest' + ([guid]::NewGuid().ToString('N').Substring(0, 10))
$password = 'Om!9' + [guid]::NewGuid().ToString('N') + 'zA'
$secure = ConvertTo-SecureString $password -AsPlainText -Force
$work = Join-Path $env:RUNNER_TEMP $name
New-Item -ItemType Directory -Path $work | Out-Null
$user = New-LocalUser -Name $name -Password $secure -AccountNeverExpires
$taskName = 'OneMount-validation-' + $name
try {
  # Only the local Users group; never Administrators.
  Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $name
  $sid = $user.SID.Value
  & icacls.exe $root /grant "*${sid}:(OI)(CI)RX" /T /Q | Out-Null
  & icacls.exe $work /grant "*${sid}:(OI)(CI)F" /T /Q | Out-Null
  $results = Join-Path $root 'test-results'
  New-Item -ItemType Directory -Force -Path $results | Out-Null
  & icacls.exe $results /grant "*${sid}:(OI)(CI)F" /T /Q | Out-Null
  if ($env:ONEMOUNT_PLAYWRIGHT) { & icacls.exe (Split-Path -Parent (Split-Path -Parent $env:ONEMOUNT_PLAYWRIGHT)) /grant "*${sid}:(OI)(CI)RX" /T /Q | Out-Null }
  $q = {param($v) "'" + $v.Replace("'", "''") + "'"}
  $command = @"
`$ErrorActionPreference = 'Stop'
`$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
`$principal = [System.Security.Principal.WindowsPrincipal]::new(`$identity)
if (`$principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Test must not be elevated' }
Write-Host 'PASS: running with a non-administrator Windows token'
`$env:TEMP = $(& $q $work)
`$env:TMP = $(& $q $work)
`$env:ONEMOUNT_PLAYWRIGHT = $(& $q ([string]$env:ONEMOUNT_PLAYWRIGHT))
`$env:GITHUB_ACTIONS = 'true'
Set-Location $(& $q $root)
`$p = Start-Process $(& $q $node) -ArgumentList $(& $q ('"' + $scriptPath + '"')) -WorkingDirectory $(& $q $root) -RedirectStandardOutput $(& $q (Join-Path $work 'stdout.txt')) -RedirectStandardError $(& $q (Join-Path $work 'stderr.txt')) -PassThru
`$p.WaitForExit()
[System.IO.File]::WriteAllText($(& $q (Join-Path $work 'exit.txt')), [string]`$p.ExitCode)
exit `$p.ExitCode
"@
  $runnerScript = Join-Path $work 'run.ps1'
  [System.IO.File]::WriteAllText($runnerScript, $command, [System.Text.UTF8Encoding]::new($true))
  $action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument "-NoProfile -NonInteractive -File `"$runnerScript`"" -WorkingDirectory $root
  & wevtutil.exe sl Microsoft-Windows-TaskScheduler/Operational /e:true
  $started = Get-Date
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
  Register-ScheduledTask -TaskName $taskName -Action $action -Settings $settings -User "$env:COMPUTERNAME\$name" -Password $password -RunLevel Limited -Force | Out-Null
  Start-ScheduledTask -TaskName $taskName
  $deadline = [DateTime]::UtcNow.AddMinutes(4)
  $tick = 0
  while (!(Test-Path (Join-Path $work 'exit.txt'))) {
    if ([DateTime]::UtcNow -gt $deadline) { throw 'Standard-user test timed out (4 minutes)' }
    Start-Sleep -Seconds 2
    $info = Get-ScheduledTaskInfo -TaskName $taskName
    $tick++
    if ($tick % 10 -eq 0) {
      Get-WinEvent -FilterHashtable @{LogName='Microsoft-Windows-TaskScheduler/Operational'; StartTime=$started} -ErrorAction SilentlyContinue | Where-Object { $_.Message -like "*$taskName*" } | Select-Object -First 8 Id,Message | Format-List
      if ($info.LastTaskResult -eq 267011 -and $tick -ge 20) { throw 'Scheduled task never started; see scheduler events above' }
      Write-Host "Test task state: $((Get-ScheduledTask -TaskName $taskName).State), result: $($info.LastTaskResult)"
      if (Test-Path (Join-Path $work 'stdout.txt')) { Get-Content (Join-Path $work 'stdout.txt') -Tail 10 }
      if (Test-Path (Join-Path $work 'stderr.txt')) { Get-Content (Join-Path $work 'stderr.txt') -Tail 10 }
    }
    if (!(Test-Path (Join-Path $work 'exit.txt')) -and (Get-ScheduledTask -TaskName $taskName).State -eq 'Ready' -and $info.LastRunTime.Year -gt 2000 -and $info.LastTaskResult -ne 0 -and $info.LastTaskResult -ne 267009) { throw "Test task failed before completion: $($info.LastTaskResult)" }
  }
  $exitText = (Get-Content -LiteralPath (Join-Path $work 'exit.txt') -Raw).Trim()
  if ($exitText -notmatch '^-?\d+$') { throw 'Missing numeric test process exit status' }
  $exitCode = [int]$exitText
  Get-Content -LiteralPath (Join-Path $work 'stdout.txt')
  Get-Content -LiteralPath (Join-Path $work 'stderr.txt')
  if ($exitCode -ne 0) { throw "Standard-user test failed: $exitCode" }
  $output = Get-Content -LiteralPath (Join-Path $work 'stdout.txt') -Raw
  if ($Script -like '*mount-integration*' -and ([regex]::Matches($output, 'PASS real Windows mount')).Count -ne 3) { throw 'Not all three mount scenarios completed' }
  if ($Script -like '*packaged-e2e*' -and $output -notlike '*PASS Safe exit with both disks mounted*') { throw 'Packaged UI checks did not complete' }
  Write-Host 'PASS: standard-user test completed with an explicitly non-administrator token'
} finally {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  Remove-LocalUser -Name $name
}

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
`$si = [System.Diagnostics.ProcessStartInfo]::new()
`$si.FileName = $(& $q $node)
`$si.Arguments = $(& $q ('"' + $scriptPath + '"'))
`$si.WorkingDirectory = $(& $q $root)
`$si.UseShellExecute = `$false
`$si.RedirectStandardOutput = `$true
`$si.RedirectStandardError = `$true
`$p = [System.Diagnostics.Process]::new()
`$p.StartInfo = `$si
[void]`$p.Start()
`$outTask = `$p.StandardOutput.ReadToEndAsync()
`$errTask = `$p.StandardError.ReadToEndAsync()
`$p.WaitForExit()
[System.IO.File]::WriteAllText($(& $q (Join-Path $work 'stdout.txt')), `$outTask.GetAwaiter().GetResult())
[System.IO.File]::WriteAllText($(& $q (Join-Path $work 'stderr.txt')), `$errTask.GetAwaiter().GetResult())
[System.IO.File]::WriteAllText($(& $q (Join-Path $work 'exit.tmp')), `$p.ExitCode.ToString())
[System.IO.File]::Move($(& $q (Join-Path $work 'exit.tmp')), $(& $q (Join-Path $work 'exit.txt')))
exit `$p.ExitCode
"@
  $runnerScript = Join-Path $work 'run.ps1'
  [System.IO.File]::WriteAllText($runnerScript, $command, [System.Text.UTF8Encoding]::new($true))
  # CreateProcessWithLogonW limits the complete command line to 1024 characters.
  # Pass a short script path, never a long -EncodedCommand payload.
  $credential = [PSCredential]::new("$env:COMPUTERNAME\$name", $secure)
  $args = @('-NoProfile','-NonInteractive','-File', ('"' + $runnerScript + '"'))
  $proc = Start-Process "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Credential $credential -LoadUserProfile -ArgumentList $args -WorkingDirectory $root -RedirectStandardOutput (Join-Path $work 'launcher-stdout.txt') -RedirectStandardError (Join-Path $work 'launcher-stderr.txt') -PassThru
  $deadline = [DateTime]::UtcNow.AddMinutes(4)
  $tick = 0
  while (!(Test-Path (Join-Path $work 'exit.txt'))) {
    if ([DateTime]::UtcNow -gt $deadline) { throw 'Standard-user test timed out (4 minutes)' }
    Start-Sleep -Seconds 2
    $tick++
    if ($tick % 10 -eq 0 -or $proc.HasExited) {
      foreach ($file in @('launcher-stdout.txt','launcher-stderr.txt','stdout.txt','stderr.txt')) {
        if (Test-Path (Join-Path $work $file)) { Get-Content (Join-Path $work $file) -Tail 10 }
      }
    }
    if ($proc.HasExited -and !(Test-Path (Join-Path $work 'exit.txt'))) { throw "Launcher exited before test completion: $($proc.ExitCode)" }
  }
  $exitText = [System.IO.File]::ReadAllText((Join-Path $work 'exit.txt')).Trim()
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
  Remove-LocalUser -Name $name
}

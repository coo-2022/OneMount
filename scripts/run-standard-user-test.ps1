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
& $(& $q $node) $(& $q $scriptPath)
exit `$LASTEXITCODE
"@
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
  $credential = [PSCredential]::new("$env:COMPUTERNAME\$name", $secure)
  $proc = Start-Process powershell.exe -Credential $credential -LoadUserProfile -ArgumentList @('-NoProfile','-NonInteractive','-EncodedCommand',$encoded) -WorkingDirectory $root -RedirectStandardOutput (Join-Path $work 'stdout.txt') -RedirectStandardError (Join-Path $work 'stderr.txt') -PassThru
  if (!$proc.WaitForExit(600000)) { throw 'Standard-user test timed out (10 minutes)' }
  $proc.Refresh()
  Get-Content -LiteralPath (Join-Path $work 'stdout.txt')
  Get-Content -LiteralPath (Join-Path $work 'stderr.txt')
  if ($proc.ExitCode -ne 0) { throw "Standard-user test failed: $($proc.ExitCode)" }
} finally {
  Remove-LocalUser -Name $name
}

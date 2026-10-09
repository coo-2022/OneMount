$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# Dedicated disposable GitHub Windows runner only; never installs a driver on users' machines.
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'This script is only for GitHub Actions runners' }
$msi = Join-Path $env:RUNNER_TEMP 'winfsp-2.1.25156.msi'
Invoke-WebRequest -UseBasicParsing 'https://github.com/winfsp/winfsp/releases/download/v2.1/winfsp-2.1.25156.msi' -OutFile $msi
$actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $msi).Hash.ToLowerInvariant()
if ($actual -ne '073a70e00f77423e34bed98b86e600def93393ba5822204fac57a29324db9f7a') { throw 'WinFsp installer checksum mismatch' }
$p = Start-Process msiexec.exe -ArgumentList @('/i', ('"' + $msi + '"'), '/qn', '/norestart', 'ADDLOCAL=ALL') -Wait -PassThru
if ($p.ExitCode -notin @(0, 3010)) { throw "WinFsp installation failed: $($p.ExitCode)" }
Write-Host 'Verified WinFsp installed for actual mount integration test.'

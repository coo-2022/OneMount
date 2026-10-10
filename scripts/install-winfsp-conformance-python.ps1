$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'Disposable CI runner only' }
$tools = Join-Path (Split-Path -Parent $PSScriptRoot) 'test-tools'
$msi = Join-Path $tools 'python-2.7.18.amd64.msi'
if ((Get-FileHash -Algorithm SHA256 $msi).Hash.ToLowerInvariant() -ne 'b74a3afa1e0bf2a6fc566a7b70d15c9bfabba3756fb077797d16fffa27800c05') { throw 'Python MSI checksum mismatch' }
$python = Join-Path $tools 'python27'
# Python 2 installs some runtime DLLs outside TARGETDIR. Install on every runner;
# copying an installed directory between machines is not sufficient.
$p = Start-Process msiexec.exe -ArgumentList @('/i',('"'+$msi+'"'),'/qn','/norestart',('TARGETDIR="'+$python+'"'),'ALLUSERS=0') -Wait -PassThru
if ($p.ExitCode -notin @(0,3010)) { throw "Python test runtime installation failed: $($p.ExitCode)" }
& (Join-Path $python 'python.exe') -c 'import sys; print(sys.version)'
if ($LASTEXITCODE -ne 0) { throw 'Python test runtime cannot start' }

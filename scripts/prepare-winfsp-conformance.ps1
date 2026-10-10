$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'Disposable CI runner only' }
$root = Split-Path -Parent $PSScriptRoot
$tools = Join-Path $root 'test-tools'
New-Item -ItemType Directory -Force -Path $tools | Out-Null
function Download-Verified($url,$file,$hash) {
  Invoke-WebRequest -UseBasicParsing $url -OutFile $file
  if ((Get-FileHash -Algorithm SHA256 $file).Hash.ToLowerInvariant() -ne $hash) { throw "Checksum mismatch: $url" }
}
$zip = Join-Path $env:RUNNER_TEMP 'winfsp-tests.zip'
Download-Verified 'https://github.com/winfsp/winfsp/releases/download/v2.1/winfsp-tests-2.1.25156.zip' $zip '0cfc68791703c80f96c729ebd38b63187de53e19baa1c603a7059d6ea87c5f52'
Expand-Archive $zip (Join-Path $tools 'winfsp') -Force
# Run the upstream legacy suite unchanged, with its original Python runtime.
# This runtime is confined to disposable tests and never packaged with OneMount.
$msi = Join-Path $tools 'python-2.7.18.amd64.msi'
Download-Verified 'https://www.python.org/ftp/python/2.7.18/python-2.7.18.amd64.msi' $msi 'b74a3afa1e0bf2a6fc566a7b70d15c9bfabba3756fb077797d16fffa27800c05'
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$vs = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
$dev = Join-Path $vs 'Common7/Tools/VsDevCmd.bat'
foreach ($relative in @('secfs/winfstest','secfs/fstools/src/fsx')) {
  $dir = Join-Path $tools $relative
  & cmd.exe /d /c "call `"$dev`" -arch=x64 && cd /d `"$dir`" && nmake /f Nmakefile"
  if ($LASTEXITCODE -ne 0) { throw "Cannot compile upstream test tool: $relative" }
}
Write-Host 'Official WinFsp 2.1 suite and pinned secfs winfstest/FSX tools ready.'

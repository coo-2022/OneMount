$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSScriptRoot
$dest = Join-Path $root 'engines'
$work = Join-Path ([System.IO.Path]::GetTempPath()) ('onemount-engines-' + [guid]::NewGuid())
New-Item -ItemType Directory -Force -Path $dest, $work | Out-Null
function Download-Verified($url, $file, $sha256) {
  Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $file
  # .NET hashing also works when a parent PowerShell 7 process has supplied
  # a PSModulePath that omits Windows PowerShell's script-based Get-FileHash.
  $stream = [System.IO.File]::OpenRead($file)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { $actual = [System.BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
  finally { $stream.Dispose(); $sha.Dispose() }
  if ($actual -ne $sha256) { throw "Downloaded archive checksum mismatch: $url" }
}
try {
  $jfsTar = Join-Path $work 'juicefs.tar.gz'
  Download-Verified 'https://github.com/juicedata/juicefs/releases/download/v1.3.0/juicefs-1.3.0-windows-amd64.tar.gz' $jfsTar '2d7118f6db7046582fb8658682164942fcd014aada7f0f08b620f6065babdd22'
  New-Item -ItemType Directory -Path (Join-Path $work 'jfs') | Out-Null
  tar -xzf $jfsTar -C (Join-Path $work 'jfs')
  if ($LASTEXITCODE -ne 0) { throw 'Cannot extract volume engine' }
  Copy-Item (Join-Path $work 'jfs/juicefs.exe') (Join-Path $dest 'juicefs.exe') -Force
  Write-Host 'JuiceFS downloaded and verified. rclone is built from engine-src/rclone.'
} finally { Remove-Item -LiteralPath $work -Recurse -Force }

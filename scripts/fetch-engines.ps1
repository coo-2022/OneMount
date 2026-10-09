$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dest = Join-Path $root 'engines'
$work = Join-Path ([System.IO.Path]::GetTempPath()) ('onemount-engines-' + [guid]::NewGuid())
New-Item -ItemType Directory -Force -Path $dest, $work | Out-Null
function Download-Verified($url, $file, $sha256) {
  Invoke-WebRequest -Uri $url -OutFile $file
  $actual = (Get-FileHash -Path $file -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $sha256) { throw "Downloaded archive checksum mismatch: $url" }
}
try {
  $rcZip = Join-Path $work 'rclone.zip'
  Download-Verified 'https://downloads.rclone.org/v1.75.0/rclone-v1.75.0-windows-amd64.zip' $rcZip '203581f0a7baeae873f2347483a798c79e2eaf5c384a4e9d866aa374f1c89ac0'
  Expand-Archive -Path $rcZip -DestinationPath (Join-Path $work 'rc')
  Copy-Item (Join-Path $work 'rc/rclone-v1.75.0-windows-amd64/rclone.exe') (Join-Path $dest 'rclone.exe') -Force
  $jfsTar = Join-Path $work 'juicefs.tar.gz'
  Download-Verified 'https://github.com/juicedata/juicefs/releases/download/v1.3.0/juicefs-1.3.0-windows-amd64.tar.gz' $jfsTar '2d7118f6db7046582fb8658682164942fcd014aada7f0f08b620f6065babdd22'
  New-Item -ItemType Directory -Path (Join-Path $work 'jfs') | Out-Null
  tar -xzf $jfsTar -C (Join-Path $work 'jfs')
  if ($LASTEXITCODE -ne 0) { throw 'Cannot extract volume engine' }
  Copy-Item (Join-Path $work 'jfs/juicefs.exe') (Join-Path $dest 'juicefs.exe') -Force
  Write-Host 'Both Windows engines downloaded and verified.'
} finally { Remove-Item -LiteralPath $work -Recurse -Force }

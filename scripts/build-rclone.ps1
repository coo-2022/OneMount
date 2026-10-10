$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$source = Join-Path $root 'engine-src/rclone'
$dest = Join-Path $root 'engines'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'Build this distribution on Windows x64' }
$previous = @{}
foreach ($name in @('GOOS','GOARCH','CGO_ENABLED','GOTOOLCHAIN','GOWORK')) { $previous[$name] = [Environment]::GetEnvironmentVariable($name,'Process') }
Push-Location $source
try {
  $env:GOOS = 'windows'; $env:GOARCH = 'amd64'; $env:CGO_ENABLED = '0'; $env:GOWORK = 'off'
  $toolchain = Select-String -Path 'go.mod' -Pattern '^toolchain (go\S+)$'
  if (!$toolchain) { throw 'Missing pinned Go toolchain' }
  $env:GOTOOLCHAIN = $toolchain.Matches[0].Groups[1].Value
  node (Join-Path $PSScriptRoot 'generate-rclone-backends.cjs')
  if ($LASTEXITCODE -ne 0) { throw 'Backend registration generation failed' }
  go mod verify
  if ($LASTEXITCODE -ne 0) { throw 'Go dependency verification failed' }
  $dependency = go list -mod=readonly -m -json github.com/rclone/rclone | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0 -or $dependency.Version -ne 'v1.75.0' -or $dependency.Replace) { throw 'Unexpected rclone dependency; review the engine version pin before upgrading' }
  $modfile = node (Join-Path $PSScriptRoot 'prepare-rclone-source.cjs')
  if ($LASTEXITCODE -ne 0) { throw 'Cannot apply reviewed rclone source patches' }
  go test -mod=readonly -modfile $modfile -tags cmount -run '^TestCmountMkdir' -count=1 .
  if ($LASTEXITCODE -ne 0) { throw 'Patched cmount regression tests failed' }
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  # Upstream Windows builds use cmount with CGO_ENABLED=0 (cgofuse loads WinFsp at runtime).
  go build -mod=readonly -modfile $modfile -trimpath -buildvcs=false -tags cmount -ldflags '-s -w -X github.com/rclone/rclone/fs.Version=v1.75.0-onemount' -o (Join-Path $dest 'rclone.exe') .
  if ($LASTEXITCODE -ne 0) { throw 'Custom rclone compilation failed' }
  node (Join-Path $PSScriptRoot 'record-rclone-build.cjs')
  if ($LASTEXITCODE -ne 0) { throw 'Custom engine verification failed' }
} finally {
  Pop-Location
  foreach ($name in $previous.Keys) { [Environment]::SetEnvironmentVariable($name,$previous[$name],'Process') }
}

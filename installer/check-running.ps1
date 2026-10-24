param(
  [Parameter(Mandatory = $true)][string]$InstallDirectory,
  [Parameter(Mandatory = $true)][string]$AppExecutable
)
$ErrorActionPreference = 'Stop'
# Called by NSIS using -File with literal arguments, never interpolated source.
# The guard is deliberately read-only: files may still be uploading, even after
# the desktop process exits. Never stop an application or a filesystem engine.
try {
  $targetDirectory = [IO.Path]::GetFullPath($InstallDirectory).TrimEnd('\') + '\'
  $runtimeNames = @($AppExecutable, 'rclone.exe', 'juicefs.exe')
  $running = Get-CimInstance -ClassName Win32_Process -ErrorAction Stop
  foreach ($runtime in $running) {
    if ($runtime.Name -notin $runtimeNames) { continue }
    if (-not $runtime.ExecutablePath) {
      # Cannot prove an inaccessible matching process belongs elsewhere.
      exit 11
    }
    $runtimePath = [IO.Path]::GetFullPath($runtime.ExecutablePath)
    if ($runtimePath.StartsWith($targetDirectory, [StringComparison]::OrdinalIgnoreCase)) {
      exit 10
    }
  }
  exit 0
} catch {
  exit 11
}

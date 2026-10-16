param([string]$Proxy)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$repo = Split-Path $PSScriptRoot -Parent
$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'juicefs-upstream-tests.json') -Raw | ConvertFrom-Json
$destination = Join-Path $repo $manifest.directory
New-Item -ItemType Directory -Force -Path $destination | Out-Null
foreach ($entry in $manifest.files) {
    $file = Join-Path $destination $entry.name
    if (!(Test-Path -LiteralPath $file)) {
        $options = @{Uri=$entry.url; OutFile=$file; UseBasicParsing=$true}
        if ($Proxy) { $options.Proxy = $Proxy }
        Invoke-WebRequest @options
    }
    if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLower() -ne $entry.sha256) {
        throw "SHA256 mismatch: $($entry.name)"
    }
}
# Always extract the verified archive into a fresh directory. Existing evidence
# is kept; no recursive deletion or stale patched test files are used.
$extraction = Join-Path $destination ('winfstest-' + [guid]::NewGuid().ToString('N'))
Expand-Archive -LiteralPath (Join-Path $destination 'TestSuite-x64-v4.zip') -DestinationPath $extraction
Set-Content -LiteralPath (Join-Path $destination 'winfstest-directory.txt') -Value (Split-Path $extraction -Leaf) -Encoding ascii
Write-Output "Verified JuiceFS test tools: $destination"

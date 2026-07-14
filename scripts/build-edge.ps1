param(
    [Parameter(Position = 0)]
    [string]$OutDir
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Node = Get-Command node -ErrorAction Stop
$Packager = Join-Path $PSScriptRoot "package-edge.mjs"
$Arguments = @($Packager)

if ($OutDir) {
    $Arguments += @("--out-dir", $OutDir)
}

& $Node.Source @Arguments
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

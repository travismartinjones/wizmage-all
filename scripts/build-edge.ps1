param(
    [string]$OutDir
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$RootDir = Split-Path -Parent $PSScriptRoot
if (-not $OutDir) {
    $OutDir = Join-Path $RootDir "dist\edge"
}

$UnpackedDir = Join-Path $OutDir "unpacked"
$ZipPath = Join-Path $OutDir "wizmage-ai-edge.zip"
$ExcludedNames = @(".DS_Store", ".git", "_metadata", "dist", "scripts", "Wizmage AI")

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
if (Test-Path -LiteralPath $UnpackedDir) {
    Remove-Item -LiteralPath $UnpackedDir -Recurse -Force
}
if (Test-Path -LiteralPath $ZipPath) {
    Remove-Item -LiteralPath $ZipPath -Force
}
New-Item -ItemType Directory -Force -Path $UnpackedDir | Out-Null

Get-ChildItem -LiteralPath $RootDir -Force | ForEach-Object {
    if ($ExcludedNames -contains $_.Name) {
        return
    }
    Copy-Item -LiteralPath $_.FullName -Destination $UnpackedDir -Recurse -Force
}

$ManifestPath = Join-Path $UnpackedDir "manifest.json"
if (-not (Test-Path -LiteralPath $ManifestPath)) {
    throw "manifest.json was not copied into $UnpackedDir"
}

$Manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
[void]$Manifest.PSObject.Properties.Remove("key")
[void]$Manifest.PSObject.Properties.Remove("update_url")
$Manifest | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $ManifestPath

Compress-Archive -Path (Join-Path $UnpackedDir "*") -DestinationPath $ZipPath -Force

Write-Host "Built Edge package:"
Write-Host "  Unpacked: $UnpackedDir"
Write-Host "  Zip: $ZipPath"

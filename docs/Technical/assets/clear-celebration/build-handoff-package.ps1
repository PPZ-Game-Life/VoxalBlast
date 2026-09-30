# Package ONLY the documented handoff and original reference resources.
# Run with PowerShell 7: pwsh -File docs/Technical/assets/clear-celebration/build-handoff-package.ps1
# Existing output ZIP is replaced; game files and other archives are untouched.
$ErrorActionPreference = 'Stop'
$resourceRoot = $PSScriptRoot
$document = [IO.Path]::GetFullPath((Join-Path $resourceRoot '../../CLEAR_CELEBRATION_AUDIO_HANDOFF.md'))
$manifest = Get-Content -LiteralPath (Join-Path $resourceRoot 'audio-manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$files = @(
  'garden-celebration-reference.png',
  'celebration-shapes.svg',
  'audio-manifest.json',
  'SOURCES.md',
  'build-audio-previews.mjs',
  'build-handoff-package.ps1',
  'audio/audition-sequence.wav'
) + @($manifest.entries | ForEach-Object { $_.file })
foreach ($relative in $files) {
  if (-not (Test-Path -LiteralPath (Join-Path $resourceRoot $relative) -PathType Leaf)) {
    throw "Missing package input: $relative"
  }
}
if (-not (Test-Path -LiteralPath $document -PathType Leaf)) { throw 'Missing handoff document' }
$staging = Join-Path ([IO.Path]::GetTempPath()) ('voxal-celebration-handoff-' + [guid]::NewGuid().ToString('N'))
$assetTarget = Join-Path $staging 'assets/clear-celebration'
New-Item -ItemType Directory -Path $assetTarget -Force | Out-Null
Copy-Item -LiteralPath $document -Destination (Join-Path $staging 'CLEAR_CELEBRATION_AUDIO_HANDOFF.md')
foreach ($relative in $files) {
  $target = Join-Path $assetTarget $relative
  New-Item -ItemType Directory -Path (Split-Path $target -Parent) -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $resourceRoot $relative) -Destination $target
}
$output = Join-Path $resourceRoot 'jeffy-celebration-handoff.zip'
Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $output -CompressionLevel Optimal -Force
# Validate that the package root mirrors the document's local relative links.
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($output)
try {
  $names = @($archive.Entries | ForEach-Object { $_.FullName.Replace('\', '/') })
  $expected = @('CLEAR_CELEBRATION_AUDIO_HANDOFF.md') + @($files | ForEach-Object { 'assets/clear-celebration/' + $_ })
  foreach ($name in $expected) { if ($names -notcontains $name) { throw "Missing ZIP entry: $name" } }
  if (@($names | Where-Object { $_ -notmatch '/$' }).Count -ne $expected.Count) { throw 'Unexpected package files' }
  [pscustomobject]@{ zip = $output; files = $expected.Count; bytes = (Get-Item -LiteralPath $output).Length; staging = $staging } | ConvertTo-Json
} finally { $archive.Dispose() }
# Keep the small unique staging folder for auditability; no bulk cleanup performed.

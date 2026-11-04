param(
    [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
    [string]$OutputName = ('BlackHole-dev-no-models-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.zip')
)
$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path
if ([System.IO.Path]::GetFileName($OutputName) -ne $OutputName -or -not $OutputName.EndsWith('.zip')) {
    throw 'OutputName must be a ZIP filename without a directory.'
}
$outputPath = Join-Path $RepoRoot $OutputName
if (Test-Path -LiteralPath $outputPath) { throw "Archive already exists: $outputPath" }

$directories = @(
    '.github',
    'blackhole\src', 'blackhole\scripts', 'blackhole\docs', 'blackhole\build',
    'blackhole\.blackhole', 'blackhole\benchmarks', 'blackhole\models',
    'blackhole\frontend\src', 'blackhole\frontend\public',
    'vscode-blackhole\src', 'vscode-blackhole\resources', 'vscode-blackhole\test',
    'node-v24.21.0-win-x64', 'blackhole\resources\llama.cpp'
)
$files = @('.gitignore', '.gitattributes', 'blackhole\package.json', 'blackhole\package-lock.json', 'blackhole\IMPROVEMENTS.md')
foreach ($directory in @('blackhole\frontend', 'vscode-blackhole')) {
    $files += Get-ChildItem -LiteralPath (Join-Path $RepoRoot $directory) -File -Force |
        Where-Object { $_.Extension -in @('.json', '.js', '.ts', '.html', '.md') -or $_.Name -in @('.gitignore', '.vscodeignore') } |
        ForEach-Object { $_.FullName.Substring($RepoRoot.Length + 1) }
}
foreach ($directory in $directories) {
    $target = Join-Path $RepoRoot $directory
    if (-not (Test-Path -LiteralPath $target)) { throw "Required development directory is missing: $target" }
    $files += Get-ChildItem -LiteralPath $target -Recurse -File -Force |
        ForEach-Object { $_.FullName.Substring($RepoRoot.Length + 1) }
}

Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::Open($outputPath, [System.IO.Compression.ZipArchiveMode]::Create)
$count = 0
try {
    foreach ($relative in ($files | Sort-Object -Unique)) {
        $entry = $relative.Replace('\', '/')
        if ($entry -match '\.gguf($|\.)' -or $entry -match '(^|/)(secrets(\.enc)?\.json|\.blackhole-key\.bin|\.env(\..*)?)$') {
            continue
        }
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
            $archive, (Join-Path $RepoRoot $relative), $entry, [System.IO.Compression.CompressionLevel]::Optimal
        ) | Out-Null
        $count++
    }
} finally {
    $archive.Dispose()
}
[pscustomobject]@{ archive = $outputPath; files = $count; bytes = (Get-Item -LiteralPath $outputPath).Length } | ConvertTo-Json

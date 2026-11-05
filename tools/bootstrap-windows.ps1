param([switch]$SkipInstall, [switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$cache = Join-Path $root '.cache\bootstrap'
$nodeName = 'node-v24.22.2-win-x64'
$nodeDir = Join-Path $root $nodeName
$llamaDir = Join-Path $root 'blackhole\resources\llama.cpp'

function Assert-Hash([string]$File, [string]$Expected) {
    $actual = (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash
    if ($actual -ine $Expected) { throw "SHA-256 mismatch: $File" }
}

function Get-CheckedArchive([string]$Url, [string]$Name, [string]$Hash) {
    $file = Join-Path $cache $Name
    if (-not (Test-Path -LiteralPath $file)) {
        Invoke-WebRequest -Uri $Url -OutFile $file -UseBasicParsing
    }
    Assert-Hash $file $Hash
    return $file
}

if (-not $CheckOnly) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    New-Item -ItemType Directory -Path $cache -Force | Out-Null
    if (-not (Test-Path -LiteralPath (Join-Path $nodeDir 'node.exe'))) {
        $name = "$nodeName.zip"
        $base = 'https://nodejs.org/dist/v24.22.2'
        $sums = (Invoke-WebRequest -Uri "$base/SHASUMS256.txt" -UseBasicParsing).Content
        $line = ($sums -split "`n" | Where-Object { $_ -match "^[a-fA-F0-9]{64}\s+$([regex]::Escape($name))\s*$" })
        if (@($line).Count -ne 1) { throw 'Missing unique official Node checksum.' }
        $hash = ($line.Trim() -split '\s+')[0]
        $zip = Get-CheckedArchive "$base/$name" $name $hash
        Expand-Archive -LiteralPath $zip -DestinationPath $root -Force
    }
    if (-not (Test-Path -LiteralPath (Join-Path $llamaDir 'llama-server.exe'))) {
        $name = 'llama-b9553-bin-win-vulkan-x64.zip'
        $url = "https://github.com/ggml-org/llama.cpp/releases/download/b9553/$name"
        $zip = Get-CheckedArchive $url $name '71ce19ec77d6eddcaff520f6ba2c0e90c28755d0ec2851c2375042ecddbb9bba'
        New-Item -ItemType Directory -Path $llamaDir -Force | Out-Null
        Expand-Archive -LiteralPath $zip -DestinationPath $llamaDir -Force
    }
}

$node = Join-Path $nodeDir 'node.exe'
$npm = Join-Path $nodeDir 'node_modules\npm\bin\npm-cli.js'
foreach ($required in @($node, $npm, (Join-Path $llamaDir 'llama-server.exe'))) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Missing runtime: $required" }
}
$version = & $node --version
if ($LASTEXITCODE -ne 0 -or $version -ne 'v24.22.2') { throw "Unexpected Node version: $version" }
$env:Path = $nodeDir + ';' + $env:Path
if (-not $SkipInstall -and -not $CheckOnly) {
    foreach ($project in @('blackhole', 'blackhole\frontend', 'vscode-blackhole')) {
        & $node $npm --prefix (Join-Path $root $project) ci
        if ($LASTEXITCODE -ne 0) { throw "npm ci failed: $project" }
    }
}
Write-Host 'Required runtime files are present. No model or credential was installed.'

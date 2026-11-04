param(
    # P0-3: repo-relative paths (no more d:\BlackHole hardcoding).
    [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
    [switch]$KeepDist,
    [switch]$PrepareCertificatesOnly
)
$ErrorActionPreference = "Stop"
$env:PSModulePath = (Join-Path $PSHOME 'Modules') + [System.IO.Path]::PathSeparator + $env:PSModulePath
Import-Module Microsoft.PowerShell.Security, PKI, Microsoft.PowerShell.Archive -ErrorAction Stop
$RepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path

function Assert-ReleaseDirectory([string]$Target) {
    $absolute = [System.IO.Path]::GetFullPath($Target)
    $prefix = $RepoRoot.TrimEnd('\') + '\'
    if (-not $absolute.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Release directory is outside the repository: $absolute"
    }
}

Write-Host "=================================================="
Write-Host "BlackHole Auto-Signature & Release Sync (P0-3)"
Write-Host "RepoRoot: $RepoRoot"
Write-Host "=================================================="

# 1. Root CA & Code Signing certificate management
$rootCertSubject = "CN=BlackHole Root CA"
$codeSignSubject = "CN=BlackHole Publisher"

$rootCert = Get-ChildItem -Path Cert:\CurrentUser\My | Where-Object { $_.Subject -eq $rootCertSubject } | Select-Object -First 1
if (-not $rootCert) {
    Write-Host "Generating BlackHole Root CA certificate..."
    # P0-3: private key is NonExportable; only the public .cer is exported.
    # Validity: 5 years. Record thumbprint below and verify on clients.
    $notAfter = (Get-Date).AddYears(5)
    $rootCert = New-SelfSignedCertificate -Type Custom -KeySpec Signature -Subject $rootCertSubject -KeyExportPolicy NonExportable -HashAlgorithm sha256 -KeyLength 2048 -CertStoreLocation "Cert:\CurrentUser\My" -KeyUsage CertSign,CRLSign -NotAfter $notAfter
    Write-Host "Success: Root CA created with thumbprint $($rootCert.Thumbprint)"
} else {
    Write-Host "Found existing BlackHole Root CA (Thumbprint: $($rootCert.Thumbprint))."
}
Write-Host "VERIFY: compare this thumbprint on every client before trusting."
Write-Host "  Thumbprint: $($rootCert.Thumbprint)"
Write-Host "  Subject: $($rootCert.Subject) | NotAfter: $($rootCert.NotAfter)"

# Export Root CA to windows directory for client trust (repo-relative)
$certDir = Join-Path $RepoRoot 'windows'
if (-not (Test-Path $certDir)) {
    New-Item -ItemType Directory -Path $certDir -Force | Out-Null
}
$certPath = Join-Path $certDir "BlackHoleRootCA.cer"
Export-Certificate -Cert $rootCert -FilePath $certPath -Force | Out-Null
Write-Host "Root CA certificate exported to: $certPath"

# Also export to project root for packaging (repo-relative)
$projectCertPath = Join-Path $RepoRoot 'blackhole\BlackHoleRootCA.cer'
Export-Certificate -Cert $rootCert -FilePath $projectCertPath -Force | Out-Null
Write-Host "Root CA certificate exported to project path: $projectCertPath"

# Auto-trust the Root CA on this developer build PC under CurrentUser\Root (doesn't require admin privileges)
$currentUserRootStore = Get-ChildItem Cert:\CurrentUser\Root | Where-Object { $_.Thumbprint -eq $rootCert.Thumbprint }
if (-not $currentUserRootStore) {
    Write-Host "Auto-trusting Root CA in CurrentUser\Root for local signing validity..."
    $store = New-Object System.Security.Cryptography.X509Certificates.X509Store('Root', 'CurrentUser')
    $store.Open('ReadWrite')
    $store.Add($rootCert)
    $store.Close()
}

$codeSignCert = Get-ChildItem -Path Cert:\CurrentUser\My | Where-Object { $_.Subject -eq $codeSignSubject } | Select-Object -First 1
if (-not $codeSignCert) {
    Write-Host "Generating BlackHole Code Signing certificate..."
    $codeSignCert = New-SelfSignedCertificate -Type CodeSigningCert -Subject $codeSignSubject -Signer $rootCert -CertStoreLocation "Cert:\CurrentUser\My"
    Write-Host "Success: Code Signing cert created with thumbprint $($codeSignCert.Thumbprint)"
} else {
    Write-Host "Found existing Code Signing certificate (Thumbprint: $($codeSignCert.Thumbprint))."
}

if ($PrepareCertificatesOnly) {
    Write-Host "Certificates prepared for packaging."
    return
}

# 2. Sign the build files in dist (repo-relative)
$distDir = Join-Path $RepoRoot 'blackhole\dist'
$winExe = Join-Path $distDir "blackhole.exe"
$unpackedExe = Join-Path $distDir "win-unpacked\BlackHole.exe"
$setupExe = Join-Path $distDir "BlackHole-Setup.exe"

$filesToSign = @($winExe, $unpackedExe, $setupExe)
foreach ($file in $filesToSign) {
    if (-not (Test-Path -LiteralPath $file)) {
        throw "Expected release executable is missing: $file"
    }
    $sig = Get-AuthenticodeSignature -LiteralPath $file
    if ($sig.Status -eq 'Valid') {
        Write-Host "Preserving valid packaged signature: $file"
    } else {
        Write-Host "Signing executable: $file..."
        $sig = Set-AuthenticodeSignature -FilePath $file -Certificate $codeSignCert
    }
    Write-Host "Status: $($sig.Status)"
    if ($sig.Status -ne 'Valid') { throw "Executable signing failed: $file ($($sig.Status))" }
}

# 3. Synchronize release to <repo>/windows (repo-relative)
Write-Host "Synchronizing Windows binaries to release folder..."
$windowsReleaseDir = Join-Path $RepoRoot 'windows'

# Copy Portable EXE
if (Test-Path $winExe) {
    Copy-Item -Path $winExe -Destination (Join-Path $windowsReleaseDir "blackhole.exe") -Force
    Write-Host "Copied blackhole.exe to release directory."
    
    # Re-zip
    Compress-Archive -Path (Join-Path $windowsReleaseDir "blackhole.exe") -DestinationPath (Join-Path $windowsReleaseDir "blackhole.zip") -Force
    Write-Host "Updated blackhole.zip archive."
}

# Copy Setup EXE
if (Test-Path $setupExe) {
    Copy-Item -Path $setupExe -Destination (Join-Path $windowsReleaseDir "BlackHole-Setup.exe") -Force
    Write-Host "Copied BlackHole-Setup.exe to release directory."
}

# Sync Unpacked folder
$distUnpacked = Join-Path $distDir "win-unpacked"
$releaseUnpacked = Join-Path $windowsReleaseDir "win-unpacked"
if (Test-Path $distUnpacked) {
    if (Test-Path $releaseUnpacked) {
        Assert-ReleaseDirectory $releaseUnpacked
        Remove-Item -LiteralPath $releaseUnpacked -Recurse -Force
    }
    New-Item -ItemType Directory -Path $releaseUnpacked -Force | Out-Null
    Copy-Item -Path (Join-Path $distUnpacked "*") -Destination $releaseUnpacked -Recurse -Force
    Write-Host "Synchronized win-unpacked directory."
}

# 4. Synchronize Linux binaries if present (repo-relative)
$linuxReleaseDir = Join-Path $RepoRoot 'linux'
$linuxTar = Join-Path $distDir "blackhole-1.0.0.tar.gz"
$linuxZip = Join-Path $distDir "blackhole-1.0.0.zip"
$linuxUnpacked = Join-Path $distDir "linux-unpacked"

if ((Test-Path $linuxTar) -or (Test-Path $linuxZip) -or (Test-Path $linuxUnpacked)) {
    Write-Host "Synchronizing Linux binaries to release folder..."
    if (-not (Test-Path $linuxReleaseDir)) {
        New-Item -ItemType Directory -Path $linuxReleaseDir -Force | Out-Null
    }
    if (Test-Path $linuxTar) {
        Copy-Item -Path $linuxTar -Destination (Join-Path $linuxReleaseDir "blackhole-1.0.0.tar.gz") -Force
        Write-Host "Copied blackhole-1.0.0.tar.gz to linux release."
    }
    if (Test-Path $linuxZip) {
        Copy-Item -Path $linuxZip -Destination (Join-Path $linuxReleaseDir "blackhole-1.0.0.zip") -Force
        Write-Host "Copied blackhole-1.0.0.zip to linux release."
    }
    if (Test-Path $linuxUnpacked) {
        $releaseLinuxUnpacked = Join-Path $linuxReleaseDir "linux-unpacked"
        if (Test-Path $releaseLinuxUnpacked) {
            Assert-ReleaseDirectory $releaseLinuxUnpacked
            Remove-Item -LiteralPath $releaseLinuxUnpacked -Recurse -Force
        }
        New-Item -ItemType Directory -Path $releaseLinuxUnpacked -Force | Out-Null
        Copy-Item -Path (Join-Path $linuxUnpacked "*") -Destination $releaseLinuxUnpacked -Recurse -Force
        Write-Host "Synchronized linux-unpacked directory."
    }
}

# 5. Clean up temporary dist folder (P2-7: keep with -KeepDist for forensics)
if ($KeepDist) {
    Write-Host "Keeping dist folder (-KeepDist)."
} elseif (Test-Path $distDir) {
    Assert-ReleaseDirectory $distDir
    Remove-Item -LiteralPath $distDir -Recurse -Force
    Write-Host "Cleaned up temporary dist folder. (Use -KeepDist to retain.)"
}

# 6. Write BUILDINFO.json (P2-7 reproducibility)
try {
    $buildInfo = [ordered]@{
        builtAt = (Get-Date).ToUniversalTime().ToString('o')
        platform = 'win32'
        repoRoot = $RepoRoot
        rootCaThumbprint = $rootCert.Thumbprint
        rootCaNotAfter = $rootCert.NotAfter.ToString('o')
        codeSignThumbprint = $codeSignCert.Thumbprint
        gitSha = ''
        gitDirty = $false
    }
    $nodeExe = Join-Path $RepoRoot 'blackhole\resources\node-runtime\current\node.exe'
    $metadataPath = Join-Path $windowsReleaseDir 'BUILDINFO.json'
    & $nodeExe (Join-Path $RepoRoot 'blackhole\scripts\write-build-info.js') '--platform=win32' "--output=$metadataPath"
    if ($LASTEXITCODE -ne 0) { throw 'Source fingerprint generation failed.' }
    $metadata = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
    foreach ($property in $metadata.PSObject.Properties) { $buildInfo[$property.Name] = $property.Value }
    try { $buildInfo.gitSha = (git -C $RepoRoot rev-parse --short HEAD 2>$null) } catch {}
    $buildInfoPath = Join-Path $windowsReleaseDir 'BUILDINFO.json'
    [System.IO.File]::WriteAllText($buildInfoPath, ($buildInfo | ConvertTo-Json -Depth 4), (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "Wrote $buildInfoPath"
} catch {
    throw "BUILDINFO write failed: $($_.Exception.Message)"
}

Write-Host "=================================================="
Write-Host "Auto-Signing & Release Sync Complete!"
Write-Host "=================================================="

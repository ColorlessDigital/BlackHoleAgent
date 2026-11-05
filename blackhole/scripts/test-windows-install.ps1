param(
    [Parameter(Mandatory = $true)][string]$ReleaseRoot,
    [switch]$IsolatedTestMachine,
    [string]$InstallRoot = 'C:\BlackHole-Install-Stability'
)
$ErrorActionPreference = 'Stop'
$env:PSModulePath = (Join-Path $PSHOME 'Modules') + [IO.Path]::PathSeparator + $env:PSModulePath
Import-Module Microsoft.PowerShell.Security, PKI -ErrorAction Stop
if (-not $IsolatedTestMachine) { throw 'Run only on a disposable clean Windows test machine with -IsolatedTestMachine.' }
if (Test-Path -LiteralPath (Join-Path $env:APPDATA 'BlackHole')) { throw 'A clean test profile without existing BlackHole data is required.' }
if (Test-Path -LiteralPath $InstallRoot) { throw 'InstallRoot must not already exist.' }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'The per-machine installer test requires an elevated disposable test host.' }
$ReleaseRoot = (Resolve-Path -LiteralPath $ReleaseRoot).Path
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot)
if ($InstallRoot -notmatch '^[A-Za-z]:\\BlackHole-Install-Stability(?:-[A-Za-z0-9]+)?$') { throw 'Use a dedicated BlackHole-Install-Stability directory at the drive root.' }
$installer = Join-Path $ReleaseRoot 'BlackHole-Setup.exe'
if (-not (Test-Path -LiteralPath $installer)) { throw 'Installer not found.' }
$report = [ordered]@{ ok = $false; startedAt = (Get-Date).ToUniversalTime().ToString('o'); checks = @(); installRoot = $InstallRoot }
$reportPath = Join-Path $ReleaseRoot 'WINDOWS-INSTALL-TEST.json'
function Roots { return @((Get-ChildItem Cert:\LocalMachine\Root).Thumbprint + (Get-ChildItem Cert:\CurrentUser\Root).Thumbprint | Sort-Object) }
function Check([string]$Name, [bool]$Passed) {
    $script:report.checks += [ordered]@{ name = $Name; passed = $Passed }
    if (-not $Passed) { throw "Check failed: $Name" }
}
function RunInstaller {
    $p = Start-Process -FilePath $installer -ArgumentList @('/S', "/D=$InstallRoot") -WindowStyle Hidden -Wait -PassThru
    Check 'installer-exit' ($p.ExitCode -eq 0)
}
try {
    $before = Roots
    RunInstaller
    $exe = Join-Path $InstallRoot 'BlackHole.exe'
    $asar = Join-Path $InstallRoot 'resources\app.asar'
    Check 'installed-executable' (Test-Path -LiteralPath $exe)
    $expected = (Get-FileHash -LiteralPath (Join-Path $ReleaseRoot 'win-unpacked\resources\app.asar') -Algorithm SHA256).Hash
    Check 'installed-payload' ((Get-FileHash -LiteralPath $asar -Algorithm SHA256).Hash -eq $expected)
    Check 'install-keeps-trust-store' ((Compare-Object $before (Roots) | Measure-Object).Count -eq 0)
    $data = Join-Path $env:APPDATA 'BlackHole'
    New-Item -ItemType Directory -Path $data | Out-Null
    $config = Join-Path $data 'config.json'
    [IO.File]::WriteAllText($config, (@{ workspaceRoot = (Join-Path $InstallRoot 'workspace'); installationTestSentinel = 'preserve-on-upgrade' } | ConvertTo-Json))
    $configHash = (Get-FileHash -LiteralPath $config -Algorithm SHA256).Hash
    RunInstaller
    Check 'upgrade-keeps-user-config' ((Get-FileHash -LiteralPath $config -Algorithm SHA256).Hash -eq $configHash)
    Check 'upgrade-keeps-trust-store' ((Compare-Object $before (Roots) | Measure-Object).Count -eq 0)
    $uninstaller = Join-Path $InstallRoot 'Uninstall BlackHole.exe'
    Check 'uninstaller-present' (Test-Path -LiteralPath $uninstaller)
    $p = Start-Process -FilePath $uninstaller -ArgumentList @('/S') -WindowStyle Hidden -Wait -PassThru
    Check 'uninstaller-exit' ($p.ExitCode -eq 0)
    for ($i = 0; $i -lt 60 -and (Test-Path -LiteralPath $exe); $i++) { Start-Sleep -Seconds 1 }
    Check 'executable-removed' (-not (Test-Path -LiteralPath $exe))
    Check 'uninstall-keeps-trust-store' ((Compare-Object $before (Roots) | Measure-Object).Count -eq 0)
    $report.ok = $true
} catch { $report.error = $_.Exception.Message }
finally {
    $report.finishedAt = (Get-Date).ToUniversalTime().ToString('o')
    [IO.File]::WriteAllText($reportPath, ($report | ConvertTo-Json -Depth 8))
}
if (-not $report.ok) { throw "Windows install test failed. See $reportPath" }
Write-Output "Windows install/upgrade/uninstall checks passed. See $reportPath"

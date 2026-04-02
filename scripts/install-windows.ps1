#Requires -Version 5.1
<#
.SYNOPSIS
    Install daeva on Windows.

.DESCRIPTION
    Installs Node.js (via winget or choco), optional Podman Desktop, and
    registers a Windows service (via NSSM or sc.exe) or a Scheduled Task
    to keep the orchestrator running as a user-level background process.

.PARAMETER SkipPodman
    Skip Podman Desktop installation.

.PARAMETER SkipService
    Skip Windows service / Scheduled Task setup.

.PARAMETER DryRun
    Print commands without executing them.

.PARAMETER NonInteractive
    Suppress all prompts; use defaults.

.PARAMETER InstallDir
    Installation directory. Default: $env:LOCALAPPDATA\daeva

.PARAMETER Port
    HTTP port for the orchestrator. Default: 8787

.PARAMETER DataDir
    Data directory. Default: $env:APPDATA\daeva

.EXAMPLE
    .\install-windows.ps1
    .\install-windows.ps1 -SkipPodman -SkipService
    .\install-windows.ps1 -DryRun
#>

[CmdletBinding()]
param(
    [switch]$SkipPodman,
    [switch]$SkipService,
    [switch]$DryRun,
    [switch]$NonInteractive,
    [string]$InstallDir  = "$env:LOCALAPPDATA\daeva",
    [int]   $Port        = 8787,
    [string]$DataDir     = "$env:APPDATA\daeva"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ServiceName  = 'daeva'
$NodeVersionRequired = 20

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
function Write-Info  { param($Msg) Write-Host "[info]  $Msg" -ForegroundColor Cyan }
function Write-Ok    { param($Msg) Write-Host "[ok]    $Msg" -ForegroundColor Green }
function Write-Warn  { param($Msg) Write-Host "[warn]  $Msg" -ForegroundColor Yellow }
function Write-Err   { param($Msg) Write-Host "[err]   $Msg" -ForegroundColor Red }
function Write-Fail  { param($Msg) Write-Err $Msg; exit 1 }

function Invoke-Step {
    param([string]$Cmd)
    if ($DryRun) {
        Write-Host "[dry-run] $Cmd" -ForegroundColor Yellow
    } else {
        Invoke-Expression $Cmd
    }
}

function Test-Command {
    param([string]$Name)
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

# ---------------------------------------------------------------------------
# Package manager detection
# ---------------------------------------------------------------------------
$UseWinget = Test-Command 'winget'
$UseChoco  = Test-Command 'choco'

if (-not $UseWinget -and -not $UseChoco) {
    Write-Warn "Neither winget nor chocolatey detected."
    Write-Warn "Attempting to install Chocolatey..."
    if (-not $DryRun) {
        Set-ExecutionPolicy Bypass -Scope Process -Force
        [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor 3072
        Invoke-Expression ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))
        $UseChoco = Test-Command 'choco'
    }
}

# ---------------------------------------------------------------------------
# Prerequisite report
# ---------------------------------------------------------------------------
$Missing = @()
foreach ($tool in @('node', 'npm', 'git')) {
    if (-not (Test-Command $tool)) { $Missing += $tool }
}
if ($Missing.Count -gt 0) {
    Write-Warn "Missing prerequisites: $($Missing -join ', ')"
}

# ---------------------------------------------------------------------------
# Node.js installation
# ---------------------------------------------------------------------------
function Install-Node {
    Write-Info "Installing Node.js ${NodeVersionRequired}+..."
    if ($UseWinget) {
        Invoke-Step "winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements"
    } elseif ($UseChoco) {
        Invoke-Step "choco install nodejs-lts -y"
    } else {
        Write-Fail "Cannot install Node.js: no package manager available. Install from https://nodejs.org"
    }
    # Refresh PATH
    if (-not $DryRun) {
        $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
                    [System.Environment]::GetEnvironmentVariable('Path', 'User')
    }
}

if (Test-Command 'node') {
    $nodeVer = [int]((node -e "process.stdout.write(process.versions.node.split('.')[0])") -replace '\D', '')
    if ($nodeVer -ge $NodeVersionRequired) {
        Write-Ok "Node.js $nodeVer already installed"
    } else {
        Write-Warn "Node.js $nodeVer < $NodeVersionRequired — upgrading..."
        Install-Node
    }
} else {
    Install-Node
}

# ---------------------------------------------------------------------------
# Podman Desktop installation
# ---------------------------------------------------------------------------
if (-not $SkipPodman) {
    if (Test-Command 'podman') {
        Write-Ok "Podman already installed: $(podman --version)"
    } else {
        Write-Info "Installing Podman Desktop..."
        if ($UseWinget) {
            Invoke-Step "winget install -e --id RedHat.Podman-Desktop --accept-source-agreements --accept-package-agreements"
        } elseif ($UseChoco) {
            Invoke-Step "choco install podman-desktop -y"
        } else {
            Write-Warn "Cannot install Podman Desktop automatically."
            Write-Warn "Download from: https://podman-desktop.io/downloads"
        }
    }
} else {
    Write-Info "Skipping Podman installation (-SkipPodman)"
}

# ---------------------------------------------------------------------------
# Install daeva
# ---------------------------------------------------------------------------
Write-Info "Installing daeva to $InstallDir..."
Invoke-Step "New-Item -ItemType Directory -Force -Path '$InstallDir' | Out-Null"
Invoke-Step "New-Item -ItemType Directory -Force -Path '$DataDir'    | Out-Null"
Invoke-Step "New-Item -ItemType Directory -Force -Path '$DataDir\logs' | Out-Null"

$localPkg = Join-Path (Get-Location) 'package.json'
if ((Test-Path $localPkg) -and ((Get-Content $localPkg -Raw) -match '"daeva"')) {
    Write-Info "Installing from local source tree..."
    Invoke-Step "npm install --prefix '$InstallDir' --production"
    Invoke-Step "Copy-Item -Recurse -Force . '$InstallDir\'"
} else {
    Write-Info "Installing from npm..."
    Invoke-Step "npm install -g daeva"
}

# Resolve binary path
$BinPath = (Get-Command 'daeva' -ErrorAction SilentlyContinue)?.Source
if (-not $BinPath) {
    $BinPath = Join-Path $InstallDir 'node_modules\.bin\daeva.cmd'
}

# Write .env
$EnvFile = Join-Path $DataDir '.env'
Write-Info "Writing .env to $EnvFile..."
if (-not $DryRun) {
    @"
PORT=$Port
DATA_DIR=$DataDir
"@ | Set-Content -Encoding UTF8 $EnvFile
}

# ---------------------------------------------------------------------------
# Service setup
# ---------------------------------------------------------------------------
if (-not $SkipService) {
    # Prefer NSSM if available, otherwise use Scheduled Task (user-level)
    if (Test-Command 'nssm') {
        Write-Info "Installing Windows service via NSSM..."
        Invoke-Step "nssm install '$ServiceName' '$BinPath' '--port $Port --data-dir `"$DataDir`"'"
        Invoke-Step "nssm set '$ServiceName' AppStdout '$DataDir\logs\stdout.log'"
        Invoke-Step "nssm set '$ServiceName' AppStderr '$DataDir\logs\stderr.log'"
        Invoke-Step "nssm set '$ServiceName' Start SERVICE_AUTO_START"
        Invoke-Step "nssm start '$ServiceName'"

        Write-Ok "NSSM service '$ServiceName' installed and started."
        Write-Host ""
        Write-Host "Manage the service with:" -ForegroundColor Green
        Write-Host "  nssm start   $ServiceName"
        Write-Host "  nssm stop    $ServiceName"
        Write-Host "  nssm restart $ServiceName"
        Write-Host "  nssm remove  $ServiceName confirm"
    } else {
        # Fallback: Scheduled Task that runs at logon (user scope, no elevation needed)
        Write-Info "NSSM not found — installing as a Scheduled Task (runs at logon)..."

        $TaskAction = New-ScheduledTaskAction `
            -Execute 'cmd.exe' `
            -Argument "/c `"$BinPath`" --port $Port --data-dir `"$DataDir`" >> `"$DataDir\logs\stdout.log`" 2>&1"

        $TaskTrigger  = New-ScheduledTaskTrigger -AtLogOn
        $TaskSettings = New-ScheduledTaskSettingsSet `
            -ExecutionTimeLimit (New-TimeSpan -Hours 0) `
            -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

        if (-not $DryRun) {
            Register-ScheduledTask `
                -TaskName $ServiceName `
                -Action   $TaskAction  `
                -Trigger  $TaskTrigger `
                -Settings $TaskSettings `
                -RunLevel Limited `
                -Force | Out-Null

            Start-ScheduledTask -TaskName $ServiceName
        } else {
            Write-Host "[dry-run] Register-ScheduledTask -TaskName $ServiceName ..." -ForegroundColor Yellow
        }

        Write-Ok "Scheduled Task '$ServiceName' registered and started."
        Write-Host ""
        Write-Host "Manage the task with:" -ForegroundColor Green
        Write-Host "  Start-ScheduledTask   -TaskName $ServiceName"
        Write-Host "  Stop-ScheduledTask    -TaskName $ServiceName"
        Write-Host "  Unregister-ScheduledTask -TaskName $ServiceName"
    }
} else {
    Write-Info "Skipping service setup (-SkipService)"
    Write-Host ""
    Write-Host "Start manually with:" -ForegroundColor Green
    Write-Host "  & '$BinPath' --port $Port --data-dir '$DataDir'"
}

Write-Host ""
Write-Ok "Installation complete. API will be available at http://127.0.0.1:$Port"

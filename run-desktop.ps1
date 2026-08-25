#Requires -Version 5.1
<#
    Build and run the Sluice desktop app from source, on Windows.

    Run this from PowerShell in the repository root:

        .\run-desktop.ps1

    The first run installs dependencies and downloads Electron (~200 MB), so give it a few
    minutes. Later runs skip straight to building and launching.

    Options:
        -SkipInstall   Don't run npm install (faster when nothing has changed)
        -SkipWeb       Don't rebuild the dashboard (it changes far less often than the app)
        -KeepDocker    Leave the Docker container running, even though it blocks mining
#>
[CmdletBinding()]
param(
    [switch]$SkipInstall,
    [switch]$SkipWeb,
    [switch]$KeepDocker
)

$ErrorActionPreference = "Stop"
$repo = $PSScriptRoot
Set-Location $repo

function Step($text) { Write-Host "`n=== $text ===" -ForegroundColor Cyan }
function Note($text) { Write-Host "    $text" -ForegroundColor DarkGray }
function Warn($text) { Write-Host "    $text" -ForegroundColor Yellow }
function Die($text)  { Write-Host "`nERROR: $text" -ForegroundColor Red; exit 1 }

Step "Checking what's here"

$node = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $node) { Die "Node.js is not on PATH. Install Node 20 or newer from nodejs.org." }
$version = (node --version).TrimStart("v")
$major = [int]($version.Split(".")[0])
if ($major -lt 20) { Die "Node $version is too old; this needs 20 or newer." }
Note "Node $version"

if (-not (Test-Path (Join-Path $repo "packages\desktop\package.json"))) {
    Die "Run this from the repository root - packages\desktop was not found here."
}

# Two copies mining one Twitch account contradict each other, so the app refuses to start
# mining while the container holds the same account. Better to say so now than to have it
# look broken later.
$docker = Get-Command docker -ErrorAction SilentlyContinue
if ($docker -and -not $KeepDocker) {
    $running = (docker ps --filter "name=sluice" --format "{{.Names}}" 2>$null)
    if ($running) {
        Warn "The '$running' container is running."
        Warn "Both copies mining one account makes Twitch credit neither reliably, so the"
        Warn "desktop app will refuse to mine while it is up."
        $answer = Read-Host "    Stop it for this test? [Y/n]"
        if ($answer -eq "" -or $answer -match "^[Yy]") {
            docker stop $running | Out-Null
            Note "Stopped. Start it again afterwards with: docker compose up -d"
        } else {
            Warn "Left running - expect the app to show 'already mining this account'."
        }
    }
}

if (-not $SkipInstall) {
    Step "Installing dependencies"
    Note "First run downloads Electron - a few minutes, once."
    npm install
    if ($LASTEXITCODE -ne 0) { Die "npm install failed." }
}

if (-not $SkipWeb) {
    Step "Building the dashboard"
    Note "The same build the container serves; the desktop app does not have its own."
    npm run build:web
    if ($LASTEXITCODE -ne 0) { Die "The dashboard build failed." }
}

Step "Building the workspace"
npx tsc -b
if ($LASTEXITCODE -ne 0) { Die "TypeScript build failed." }

Step "Building the Electron bundles"
npm --prefix packages/desktop run build
if ($LASTEXITCODE -ne 0) { Die "The Electron build failed." }

Step "Starting Sluice"
Write-Host @"
    Worth checking while it's open:

      * The window opens on the device-code screen without waiting for a login.
      * The twitch.tv/activate link opens your BROWSER, not a window inside the app.
      * Settings -> Sign in through Steam leaves the app and comes back.
      * Signing out returns to the device-code screen WITHOUT the app exiting.
      * Closing the window hides it to the tray and mining continues.
      * Starting a second copy focuses the first window.

    Data lives in:  $env:APPDATA\Sluice
    Logs:           $env:APPDATA\Sluice\logs\desktop.log

    Ctrl+C here closes the app.

"@ -ForegroundColor DarkGray

npm --prefix packages/desktop run dev

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

# Keep a copy of everything printed here. A failed build scrolls past, or the window closes,
# and the app's own log is no help because the failure happened before it ever started.
$transcript = Join-Path $env:TEMP "sluice-run-desktop.log"
# A second file, because the transcript holds its own open and Tee-Object cannot write to
# the same path - and even after Stop-Transcript the append silently goes nowhere.
$appLog = Join-Path $env:TEMP "sluice-app.log"
try { Start-Transcript -Path $transcript -Force | Out-Null } catch { }

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
    App log:        $env:APPDATA\@sluice\desktop\logs\desktop.log
    This script:    $transcript
    Its output:     $appLog

    Ctrl+C here closes the app.

"@ -ForegroundColor DarkGray

# Run through cmd, with stderr folded into stdout *inside* cmd rather than by PowerShell.
#
# This looks roundabout and is not. $ErrorActionPreference is "Stop", and PowerShell turns
# anything a native command writes to stderr into a terminating error the moment the stream
# is redirected - so `npm ... 2>&1 |` killed the script on electron-vite's entirely harmless
# "renderer config is missing" notice. Folding the streams before PowerShell sees them means
# there is no stderr to object to, while the output still reaches the log and $LASTEXITCODE
# still reports a genuine failure.
cmd.exe /c "npm --prefix packages/desktop run dev 2>&1" | Tee-Object -FilePath $appLog

# Nothing checked this, and nothing followed it, so a crash left the script exiting 0. The
# wrapper only pauses on a failure, which meant the window closed on the error unread.
if ($LASTEXITCODE -ne 0) {
    Die "Sluice exited with code $LASTEXITCODE. The output above is also in $appLog"
}

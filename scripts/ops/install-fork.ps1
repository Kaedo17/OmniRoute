# Install (or update) the OmniRoute fork from source and get it running.
#
#   .\scripts\ops\install-fork.ps1                    # install + production build
#   .\scripts\ops\install-fork.ps1 -Dev               # install + dev server, no build
#   .\scripts\ops\install-fork.ps1 -Dir D:\x -Branch some/other-branch
#   .\scripts\ops\install-fork.ps1 -WithOpenCode      # + writes the OpenCode provider block
#
# NOTE: prebuilt better-sqlite3 binaries for Windows exist only for Python/MSVC-built
# Node toolchains; on standard PowerShell-installed Node the postinstall falls back
# transparently to the pure-JS engine, so no Visual Studio is required.
param(
    [switch]$Dev,
    [string]$Dir = (Join-Path $env:USERPROFILE "OmniRoute"),
    [string]$Branch = $env:OMNIROUTE_BRANCH,
    [switch]$WithOpenCode
)

$ErrorActionPreference = "Stop"

if (-not $Branch) { $Branch = "fix/opencode-free-tier-keyed-lane" }
$RepoUrl = if ($env:OMNIROUTE_REPO_URL) { $env:OMNIROUTE_REPO_URL } else { "https://github.com/Kaedo17/OmniRoute.git" }

function Say($m)  { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Warn($m) { Write-Host "WARNING: $m" -ForegroundColor Yellow }
function Die($m)  { Write-Host "`nERROR: $m" -ForegroundColor Red; exit 1 }

# ── 1. Node runtime gate (mirrors engines: >=22.22.2 <23 || >=24 <27) ─────
Say "Checking Node.js"
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Die "Node not found - install 22.x or 24+ from https://nodejs.org"
}
$ok = node -e "const [M,m,p]=process.versions.node.split('.').map(Number); process.exit(((M===22&&(m>22||(m===22&&p>=2)))||(M>=24&&M<27))?0:1)"
if (-not $ok) { Die "Node $(node -v) unsupported. Need >=22.22.2 <23 or >=24 <27." }
Write-Host "    node $(node -v)  ok"

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Die "git not found - install from https://git-scm.com (or `winget install Git.Git`)"
}

# ── 2. Clone or update the branch ──────────────────────────────────────────
if (Test-Path "$Dir\.git") {
    Say "Updating $Dir ($Branch)"
    git -C $Dir fetch origin $Branch
    git -C $Dir checkout $Branch
    git -C $Dir pull --ff-only origin $Branch 2>$null
    if ($LASTEXITCODE -ne 0) { Warn "pull failed (local commits?); keeping current tree" }
} else {
    Say "Cloning $Branch -> $Dir"
    git clone --branch $Branch --single-branch $RepoUrl $Dir
}
Set-Location $Dir

# ── 3. .env with real secrets (idempotent - never clobbers set values) ─────
function Gen([int]$bytes, [string]$fmt) {
    node -e "process.stdout.write(require('crypto').randomBytes($bytes).toString('$fmt').replace(/\+/g,'-').replace(/\//g,'_'))"
}
function SetEnv([string]$key, [string]$value) {
    $lines = Get-Content .env
    $idx = [Array]::FindIndex($lines, [Predicate[string]] { param($l) $l -match "^$key=" })
    if ($idx -ge 0) {
        $val = $lines[$idx] -replace "^$key=", ""
        if ($val -eq "" -or $val -eq "CHANGEME") {
            $lines[$idx] = "$key=$value"
            Set-Content -Path .env -Value $lines -Encoding UTF8
        }
    } else {
        Add-Content -Path .env -Value "$key=$value"
    }
}
if (-not (Test-Path .env)) {
    Say "Creating .env from .env.example"
    Copy-Item .env.example .env
}
Say "Generating secrets (existing values are kept)"
SetEnv "JWT_SECRET"     (Gen 48 "base64")
SetEnv "API_KEY_SECRET" (Gen 32 "hex")
SetEnv "INITIAL_PASSWORD" (Gen 12 "base64")

# ── 4. Dependencies ────────────────────────────────────────────────────────
Say "Installing dependencies (this is the slow step)"
npm install --no-audit --no-fund

# ── 5. Build & hand off ───────────────────────────────────────────────────
if ($Dev) {
    Say "Starting the dev server (Ctrl+C to stop)"
    npm run dev
    exit 0
}

Say "Building for production (a few minutes)"
npm run build

$pass = (Select-String -Path .env -Pattern "^INITIAL_PASSWORD=(.+)$").Matches[0].Groups[1].Value
Write-Host ""
Write-Host "Install complete." -ForegroundColor Green
Write-Host ""
Write-Host "  Start:      cd $Dir; npm start"
Write-Host "  Dashboard:  http://localhost:20128"
Write-Host "  Login:      admin / $pass   (change it after first login)"
Write-Host "  API base:   http://localhost:20128/v1"
Write-Host "  Data dir:   %DATA_DIR% (default %USERPROFILE%\.omniroute)"
Write-Host ""
Write-Host "  Get an API key:  Dashboard -> Endpoints, then:"
Write-Host '    curl http://localhost:20128/v1/models -H "Authorization: Bearer YOUR_KEY"'
Write-Host ""
Write-Host "  Exposing to other devices? Set REQUIRE_API_KEY=true in .env first."
Write-Host "  With it false and the server on 0.0.0.0, anyone on the network can"
Write-Host "  spend your provider quota."

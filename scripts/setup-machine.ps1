# One-time setup of this project on a new machine (Windows).
#
#   powershell -ExecutionPolicy Bypass -File scripts/setup-machine.ps1
#   powershell -ExecutionPolicy Bypass -File scripts/setup-machine.ps1 -Private "D:\Sync\PlayTested-private"
#
# Checks Git and Node, switches to the dev branch, installs packages, and copies
# the local secret files (.dev.vars, .env) from the Syncthing folder
# "PlayTested-private" (by default next to this repo's folder). Existing files
# are never overwritten. See HANDOFF.md, section 1.

param(
  [string]$Private = (Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) "PlayTested-private")
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo
$todo = @()

function Ok($m) { Write-Host "  OK   $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  !!   $m" -ForegroundColor Yellow }

Write-Host "`nPlayTested setup in $repo`n"

# 1. Tools
$git = Get-Command git -ErrorAction SilentlyContinue
if ($git) { Ok "Git $((git --version) -replace 'git version ', '')" } else { Warn "Git is missing: install it from https://git-scm.com"; $todo += "Install Git" }

$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
  $v = (node -v).TrimStart("v")
  if ([int]($v.Split(".")[0]) -ge 22) { Ok "Node $v" } else { Warn "Node $v is old: install Node 22 LTS from https://nodejs.org"; $todo += "Update Node to 22" }
} else { Warn "Node is missing: install Node 22 LTS from https://nodejs.org"; $todo += "Install Node 22" }

if (-not ($git -and $node)) { Write-Host "`nInstall the missing tools, then run this again.`n"; exit 1 }

# 2. Branch: everyday work happens on dev
$branch = (git rev-parse --abbrev-ref HEAD).Trim()
if ($branch -ne "dev") {
  git fetch origin dev --quiet
  git switch dev 2>$null
  if ($LASTEXITCODE -ne 0) { git switch -c dev --track origin/dev }
  Ok "Switched to the dev branch"
} else { Ok "On the dev branch" }
git pull --ff-only --quiet
Ok "Up to date with GitHub"

# 3. Local secrets from the Syncthing folder
if (Test-Path $Private) {
  Ok "Private folder: $Private"
  foreach ($f in ".dev.vars", ".env") {
    $src = Join-Path $Private $f
    $dst = Join-Path $repo $f
    if (Test-Path $dst) { Ok "$f already here (left as is)" }
    elseif (Test-Path $src) { Copy-Item $src $dst; Ok "$f copied from the private folder" }
    else { Warn "$f is not in the private folder"; $todo += "Put a copy of $f in $Private (from the other machine)" }
  }
} else {
  Warn "Private folder not found: $Private"
  $todo += "Share the Syncthing folder PlayTested-private to this machine (or pass -Private <path>)"
}

# 4. Packages
Write-Host "`n  Installing packages (npm ci)..."
npm ci --no-audit --no-fund
if ($LASTEXITCODE -eq 0) { Ok "Packages installed" } else { Warn "npm ci failed (see above)"; $todo += "Fix npm ci" }

# 5. Cloudflare sign-in
$who = (npx --no-install wrangler whoami 2>&1 | Out-String)
if ($who -match "You are logged in") { Ok "Cloudflare: signed in" }
else { Warn "Cloudflare: not signed in"; $todo += "Run: npx wrangler login  (account rebutoclyndon02@gmail.com)" }

# Summary
Write-Host ""
if ($todo.Count) {
  Write-Host "Still to do:" -ForegroundColor Yellow
  $todo | ForEach-Object { Write-Host "  - $_" }
} else {
  Write-Host "All set. Open this folder in VS Code and start Claude Code." -ForegroundColor Green
}
Write-Host "Daily routine: git pull when you start, push before you stop (HANDOFF.md 1.1).`n"

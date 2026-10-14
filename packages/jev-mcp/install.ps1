# Jev MCP installer for Claude Code (Windows).
# ASCII only on purpose: Windows PowerShell 5.1 misreads non-ASCII .ps1 files.
#
# Usage: double-click install.cmd, or
#   powershell -ExecutionPolicy Bypass -File install.ps1 [-ApiKey <key>] [-Name jev] [-InstallDir <dir>]
# The API key is stored as env TYPESAFE_API_KEY of this MCP server in your Claude Code user config (~/.claude.json).
param(
  [string]$ApiKey = '',
  [string]$Name = 'jev',
  [string]$InstallDir = (Join-Path $HOME '.jev-mcp')
)
$ErrorActionPreference = 'Stop'

function Fail([string]$msg) {
  Write-Host ''
  Write-Host "[FAILED] $msg" -ForegroundColor Red
  exit 1
}

Write-Host '=== Jev MCP installer ===' -ForegroundColor Cyan

# 1. Node.js 20+
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Fail 'Node.js not found. Install Node.js 20 or later from https://nodejs.org and run this again.' }
$nodeMajor = [int]((& node -p "process.versions.node.split('.')[0]").Trim())
if ($nodeMajor -lt 20) { Fail "Node.js $nodeMajor found; version 20 or later is required." }
Write-Host "[ok] Node.js major version $nodeMajor"

# 2. Claude Code CLI
$claude = Get-Command claude -ErrorAction SilentlyContinue
if (-not $claude) { Fail 'Claude Code CLI (claude) not found in PATH. Install Claude Code first: https://docs.claude.com/claude-code' }
Write-Host '[ok] Claude Code CLI found'

# 3. API key: -ApiKey > env TYPESAFE_API_KEY > prompt
if (-not $ApiKey) { $ApiKey = $env:TYPESAFE_API_KEY }
if (-not $ApiKey) {
  Write-Host ''
  Write-Host 'Enter your TypeSafe API key (get one at https://console.typesafe.ai). Input is hidden.'
  $secure = Read-Host -AsSecureString 'TypeSafe API key'
  $ApiKey = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
}
$ApiKey = $ApiKey.Trim()
if (-not $ApiKey) { Fail 'No API key given.' }

# 4. Copy the server file
$src = Join-Path $PSScriptRoot 'jev-mcp.mjs'
if (-not (Test-Path $src)) { Fail "jev-mcp.mjs not found next to this script ($src). Keep all files of the package together." }
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$dest = Join-Path $InstallDir 'jev-mcp.mjs'
Copy-Item -Force $src $dest
Write-Host "[ok] Installed to $dest"

# 5. Verify the key (GET /v1/models only, no data is sent)
$env:TYPESAFE_API_KEY = $ApiKey
$check = & node $dest --check
if ($LASTEXITCODE -ne 0) { Fail "API key check failed: $check" }
Write-Host "[ok] $check"

# 6. Register with Claude Code (user scope = available in all projects); replace an existing registration
cmd /c "claude mcp remove `"$Name`" -s user >nul 2>&1"
# '--' must be quoted: Windows PowerShell 5.1 drops a bare -- when calling native commands,
# and then the variadic -e swallows "node <path>" as more env entries.
& claude mcp add --scope user $Name -e "TYPESAFE_API_KEY=$ApiKey" '--' node $dest
if ($LASTEXITCODE -ne 0) { Fail 'claude mcp add failed (see message above).' }

Write-Host ''
Write-Host "[DONE] Jev MCP '$Name' is registered. Open a NEW Claude Code session to use the jev_classify tool." -ForegroundColor Green
Write-Host "       Remove later with: claude mcp remove $Name -s user"

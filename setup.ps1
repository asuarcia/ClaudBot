# Claudbot first-run on a new Windows device. Needs only PowerShell.
# Usage: powershell -ExecutionPolicy Bypass -File setup.ps1 [--yes]
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Host "Node.js is not installed - Claudbot needs it (>= 22)."
    $a = if ($args -contains "--yes") { "y" } else { Read-Host "Install Node.js via winget now? [y/N]" }
    if ($a -notmatch '^y') { Write-Host "Install Node from https://nodejs.org, then re-run."; exit 1 }
    winget install -e --id OpenJS.NodeJS --accept-source-agreements --accept-package-agreements
    Write-Host "Node installed. Open a NEW terminal and re-run setup.ps1."
    exit 0
}
& node "$PSScriptRoot\scripts\bootstrap.mjs" @args

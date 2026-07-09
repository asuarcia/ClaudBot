# Start the Claudbot dream loop if it isn't already running.
# Idempotent — registered as the ClaudbotDream scheduled task (at logon + every
# hour), so a crash or reboot self-heals within the hour. Runs from THIS repo
# checkout so the loop always uses current code (a stale clone at C:\Repo\Claudbot
# ran the loop on old code for a day before this existed — 2026-07-09).

$repo = Split-Path -Parent $PSScriptRoot
$logs = Join-Path $repo ".claudbot"
New-Item -ItemType Directory -Force -Path $logs | Out-Null

$running = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match 'dream\.mjs --watch|claudbot\.mjs dream' }
if ($running) {
    Write-Output "dream: already running (PID $($running[0].ProcessId))"
    exit 0
}

Start-Process -WindowStyle Hidden -FilePath "node" `
    -ArgumentList "claudbot.mjs", "dream", "--watch" `
    -WorkingDirectory $repo `
    -RedirectStandardOutput (Join-Path $logs "dream.log") `
    -RedirectStandardError (Join-Path $logs "dream.err.log")
Write-Output "dream: started from $repo"

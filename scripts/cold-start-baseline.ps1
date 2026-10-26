# Cold-start baseline driver (Phase 0 / spec 1.3).
#
# Launches the real Rust Runtime binary N times from an isolated, freshly
# seeded home so every launch is "clean", and measures per launch:
#   spawn          — process created
#   runtime_ready  — GET /health answers 200 on the Runtime port
#   first_event    — thread created + canonical ledger first event readable
#   working_set    — process WorkingSet64 sampled at runtime-ready
# Reports median / p95 for the durations and the working set.
#
# NOTE on scope: spec 1.3's headline budget is "main window usable <= 5 s".
# Measuring the desktop *window* under automation hits Tauri single-instance
# and WebView2 user-data-folder locks that make scripted launches diverge
# from interactive ones (see REFACTOR_STATUS 29th pass). The runtime-ready
# milestone is the share of cold start the runtime owns, measured here; the
# window budget needs an interactive launch with the desktop driver.
#
# Usage:
#   powershell -File scripts/cold-start-baseline.ps1 [-Runs 10]
#
# Output: .dsh-coldstart/baseline.json + console table.

param(
    [int]$Runs = 10,
    [string]$Binary = "",
    [int]$Port = 48099,
    [int]$TimeoutSec = 60
)

$ErrorActionPreference = "Stop"
$OutputEncoding = [System.Text.Encoding]::UTF8

$repo = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($Binary)) {
    $Binary = Join-Path $repo "frontend\terminal\target\debug\hakus-tui.exe"
}
$root = Join-Path $repo ".dsh-coldstart"
$home_ = Join-Path $root "home"
$workspace = Join-Path $root "workspace"
$resultsPath = Join-Path $root "baseline.json"

if (-not (Test-Path $Binary)) {
    Write-Host "runtime binary missing: $Binary" -ForegroundColor Red
    Write-Host "build it first: cargo build -p hakus-tui --bin hakus-tui (in frontend/terminal)" -ForegroundColor Red
    exit 2
}

function Stop-Leftovers {
    foreach ($name in @("desktop-tauri", "HakusAI", "hakus-tui")) {
        Get-Process $name -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    }
    Get-CimInstance Win32_Process -Filter "Name = 'msedgewebview2.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match "com\.hakusai\.client" } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 800
    $deadline = (Get-Date).AddSeconds(20)
    while ((Get-Date) -lt $deadline) {
        $busy = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
        if (-not $busy) { return }
        Start-Sleep -Milliseconds 300
    }
}

# --- fresh home + workspace for a clean first launch ----------------------
if (Test-Path $root) { Remove-Item $root -Recurse -Force }
New-Item -ItemType Directory -Force -Path $home_, $workspace | Out-Null
# No-BOM UTF-8: PS 5's utf8 encoding writes a BOM the TOML parser rejects.
$config = "provider = `"local`"`r`ndefault_text_model = `"baseline`"`r`n`r`nallow_shell = false`r`napproval_policy = `"never`"`r`nsandbox_mode = `"workspace-write`"`r`n`r`n[providers.local]`r`nkind = `"openai-compatible`"`r`ndisplay_name = `"Baseline stub (never called)`"`r`napi_key = `"baseline-key`"`r`nbase_url = `"http://127.0.0.1:1/v1`"`r`nmodel = `"baseline`"`r`nwire = `"openai`"`r`nmodels = [`"baseline`"]`r`n`r`n[update]`r`ncheck_for_updates = false`r`n"
[System.IO.File]::WriteAllText((Join-Path $home_ "config.toml"), $config, (New-Object System.Text.UTF8Encoding($false)))

Stop-Leftovers

$launches = @()
Write-Host "`n== Cold-start baseline: $Runs launches ==" -ForegroundColor Cyan
Write-Host "  binary = $Binary"

for ($i = 1; $i -le $Runs; $i++) {
    $env:HAKUS_HOME = $home_
    $env:DEEPSEEK_HOME = $home_
    $spawnedAt = [DateTime]::UtcNow
    $proc = Start-Process -FilePath $Binary -PassThru -WorkingDirectory $workspace `
        -ArgumentList @('serve', '--http', '--insecure', '--port', "$Port") `
        -RedirectStandardError (Join-Path $root "run-$i.err") `
        -RedirectStandardOutput (Join-Path $root "run-$i.out")
    Remove-Item Env:\HAKUS_HOME -ErrorAction SilentlyContinue
    Remove-Item Env:\DEEPSEEK_HOME -ErrorAction SilentlyContinue

    $readyMs = $null
    $firstEventMs = $null
    $workingSetMb = $null
    $threadId = $null
    $deadline = $spawnedAt.AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        if ($proc.HasExited) { $proc.Refresh(); if ($proc.HasExited) { break } }
        try {
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 1
            if ($health) {
                $readyMs = [int]([DateTime]::UtcNow - $spawnedAt).TotalMilliseconds
                break
            }
        } catch { }
        Start-Sleep -Milliseconds 100
    }

    if ($null -ne $readyMs) {
        $proc.Refresh()
        $workingSetMb = [math]::Round($proc.WorkingSet64 / 1MB, 1)
        # First canonical event: create a thread and time until the ledger
        # returns its thread.started event.
        $threadPostedAt = [DateTime]::UtcNow
        try {
            $body = '{"title":"baseline","mode":"agent","archived":false}'
            $resp = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/v1/threads" -Method Post `
                -ContentType "application/json" -Body $body -TimeoutSec 15
            $threadId = $resp.id
            $evDeadline = (Get-Date).AddSeconds(15)
            while ((Get-Date) -lt $evDeadline) {
                $ledger = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/v1/threads/$threadId/ledger?limit=10" -TimeoutSec 5
                if ($ledger.verification.last_seq -ge 1) {
                    $firstEventMs = [int]([DateTime]::UtcNow - $threadPostedAt).TotalMilliseconds
                    break
                }
                Start-Sleep -Milliseconds 20
            }
        } catch { }
    }

    $launches += ,([pscustomobject][ordered]@{
        run = $i
        exited_early = $proc.HasExited
        runtime_ready_ms = $readyMs
        first_event_ms = $firstEventMs
        working_set_mb = $workingSetMb
        thread_id = $threadId
    })
    Write-Host ("  run {0,2}: ready={1}ms first_event={2}ms ws={3}MB" -f $i, $readyMs, $firstEventMs, $workingSetMb)
    Stop-Leftovers
    Start-Sleep -Milliseconds 500
}

function Stats([object[]]$values) {
    $sorted = @($values | Where-Object { $_ -ne $null } | Sort-Object)
    if ($sorted.Count -eq 0) { return $null }
    $median = $sorted[[int][math]::Floor(($sorted.Count - 1) / 2)]
    $p95Index = [int][math]::Ceiling($sorted.Count * 0.95) - 1
    return [ordered]@{ n = $sorted.Count; median = $median; p95 = $sorted[$p95Index]; max = $sorted[-1] }
}

$summary = [ordered]@{
    runs = $Runs
    binary = $Binary
    profile = "debug"
    runtime_ready = (Stats $launches.runtime_ready_ms)
    first_event = (Stats $launches.first_event_ms)
    working_set_mb = (Stats $launches.working_set_mb)
    launches = $launches
}

New-Item -ItemType Directory -Force -Path $root | Out-Null
$summary | ConvertTo-Json -Depth 6 | Set-Content -Path $resultsPath -Encoding utf8
Write-Host "`nruntime_ready: median=$($summary.runtime_ready.median)ms p95=$($summary.runtime_ready.p95)ms"
Write-Host "first_event: median=$($summary.first_event.median)ms p95=$($summary.first_event.p95)ms"
Write-Host "working_set_mb: median=$($summary.working_set_mb.median) p95=$($summary.working_set_mb.p95)"
Write-Host "results: $resultsPath"

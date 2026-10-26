# Live Runtime smoke test for the canonical-ledger refactor.
#
# Exercises the real HTTP/SSE surfaces that the desktop client uses:
#   create thread -> canonical ledger read/verify -> enqueue turn ->
#   read SSE from the canonical cursor -> confirm ledger grew and verifies.
#
# Usage:
#   pwsh -File scripts/smoke-runtime.ps1
#   pwsh -File scripts/smoke-runtime.ps1 -SkipTurn   # no model call

param(
    [string]$Base = "http://127.0.0.1:48081",
    [string]$Prompt = "Reply with exactly: SMOKE_OK",
    [int]$TurnTimeoutSec = 180,
    [switch]$SkipTurn
)

$ErrorActionPreference = "Stop"
$OutputEncoding = [System.Text.Encoding]::UTF8

$script:Failures = 0
$script:Checks = 0

function Check([string]$Name, [bool]$Ok, [string]$Detail = "") {
    $script:Checks++
    if ($Ok) {
        Write-Host ("  [PASS] {0}" -f $Name) -ForegroundColor Green
    } else {
        $script:Failures++
        Write-Host ("  [FAIL] {0} {1}" -f $Name, $Detail) -ForegroundColor Red
    }
}

function PostJson([string]$Path, [hashtable]$Body) {
    $json = $Body | ConvertTo-Json -Depth 12 -Compress
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    Invoke-RestMethod -Uri "$Base$Path" -Method Post -ContentType "application/json; charset=utf-8" -Body $bytes -TimeoutSec 60
}

function GetJson([string]$Path) {
    Invoke-RestMethod -Uri "$Base$Path" -Method Get -TimeoutSec 60
}

Write-Host "`n== 1. Runtime identity ==" -ForegroundColor Cyan
$health = GetJson "/health"
Check "health reports rust execution plane" ($health.execution_plane -eq "rust") "got '$($health.execution_plane)'"
Check "feature gate rust_default_path" ($health.feature_gates.rust_default_path -eq $true)
$diag = GetJson "/v1/diagnostics"
Check "diagnostics exposes canonical ledger counters" ($null -ne $diag.canonical_ledger_event_count)
$ledger0 = [int]$diag.canonical_ledger_event_count
Write-Host ("  canonical_ledger_event_count(before) = {0}" -f $ledger0)

Write-Host "`n== 2. Create thread ==" -ForegroundColor Cyan
$thread = PostJson "/v1/threads" @{ title = "DSH smoke"; mode = "agent"; archived = $false }
$tid = $thread.id
Check "thread has id" (-not [string]::IsNullOrWhiteSpace($tid)) "id='$tid'"
Write-Host ("  thread_id = {0}" -f $tid)

Write-Host "`n== 3. Canonical ledger after thread.started ==" -ForegroundColor Cyan
$ledger = GetJson "/v1/threads/$tid/ledger?limit=200"
$events = @($ledger.events)
Check "ledger returns events" ($events.Count -ge 1) "count=$($events.Count)"
Check "ledger read verification agrees" ($ledger.verification.contiguous -eq $true) "verification=$($ledger.verification | ConvertTo-Json -Compress)"
$verify = GetJson "/v1/threads/$tid/ledger/verify"
Check "ledger verifies contiguous" ($verify.contiguous -eq $true) "verify=$($verify | ConvertTo-Json -Compress)"
Check "verify last_seq matches event count" ([int]$verify.last_seq -eq $events.Count) "last_seq=$($verify.last_seq) count=$($events.Count)"
$types = ($events | ForEach-Object { $_.event_type }) -join ","
Check "first event is thread lifecycle" ($types -match "thread") "types=$types"
Write-Host ("  event types = {0}" -f $types)
$baselineSeq = [int]$verify.verification.last_seq
Write-Host ("  baseline last_seq = {0}" -f $baselineSeq)

if ($SkipTurn) {
    Write-Host "`n-SkipTurn set; stopping after ledger checks." -ForegroundColor Yellow
} else {
    Write-Host "`n== 4. Enqueue turn from the canonical cursor ==" -ForegroundColor Cyan
    $turn = PostJson "/v1/threads/$tid/turns" @{ prompt = $Prompt }
    $turnId = $turn.turn.id
    Check "turn accepted with id" (-not [string]::IsNullOrWhiteSpace($turnId)) "turn='$turnId'"
    Write-Host ("  turn_id = {0}" -f $turnId)

    Write-Host "`n== 5. SSE replay from durable cursor (source=canonical) ==" -ForegroundColor Cyan
    $sseUrl = "$Base/v1/threads/$tid/events?source=canonical&since_seq=$baselineSeq"
    $sseEvents = 0
    $sseFirst = $null
    $deadline = (Get-Date).AddSeconds($TurnTimeoutSec)
    try {
        $req = [System.Net.WebRequest]::Create($sseUrl)
        $req.Method = "GET"
        $req.Accept = "text/event-stream"
        $req.Timeout = ($TurnTimeoutSec + 30) * 1000
        $req.ReadWriteTimeout = ($TurnTimeoutSec + 30) * 1000
        $resp = $req.GetResponse()
        Check "SSE handshake 200" $true "status=200"
        $stream = $resp.GetResponseStream()
        $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8)
        $sawTerminal = $false
        while ((Get-Date) -lt $deadline) {
            $line = $reader.ReadLine()
            if ($null -eq $line) { break }
            if ($line.StartsWith("data:")) {
                $sseEvents++
                if ($null -eq $sseFirst) { $sseFirst = $line }
                if ($line -match 'turn\.(completed|failed)|"completed"|"failed"') { $sawTerminal = $true }
            }
            if ($sawTerminal) { break }
        }
        $reader.Dispose()
        $resp.Close()
    } catch {
        Check "SSE stream readable" $false $_.Exception.Message
    }
    Check "SSE delivered canonical events" ($sseEvents -gt 0) "events=$sseEvents"
    Write-Host ("  sse data events = {0}" -f $sseEvents)

    Write-Host "`n== 6. Wait for terminal turn status ==" -ForegroundColor Cyan
    $finalStatus = $null
    $terminal = @("completed", "failed", "cancelled", "interrupted")
    while ((Get-Date) -lt $deadline) {
        $detail = GetJson "/v1/threads/$tid"
        $t = @($detail.turns) | Where-Object { $_.id -eq $turnId } | Select-Object -First 1
        if ($t -and ($terminal -contains $t.status)) { $finalStatus = $t.status; break }
        Start-Sleep -Milliseconds 500
    }
    Check "turn reached a terminal status" ($null -ne $finalStatus) "status=$($finalStatus)"
    Write-Host ("  turn status = {0}" -f $finalStatus)

    Write-Host "`n== 7. Ledger advanced and matches the JSONL compatibility log ==" -ForegroundColor Cyan
    $after = GetJson "/v1/threads/$tid/ledger/verify"
    $afterSeq = [int]$after.last_seq
    Check "ledger advanced past baseline" ($afterSeq -gt $baselineSeq) "before=$baselineSeq after=$afterSeq"
    Check "ledger still contiguous" ($after.contiguous -eq $true)
    $tail = GetJson "/v1/threads/$tid/ledger?after_seq=$baselineSeq&limit=500"
    $types2 = (($tail.events) | ForEach-Object { $_.event_type }) -join ","
    Write-Host ("  new events ({0}) = {1}" -f @($tail.events).Count, $types2)
    Check "new events include item lifecycle" ($types2 -match "item") "types=$types2"

    # Shadow-write completeness: every JSONL runtime event must have a mirrored
    # canonical ledger row. A gap here is the exact divergence this refactor
    # exists to prevent, so it is asserted rather than assumed.
    $jsonlStats = (GetJson "/v1/threads/$tid/event-log?limit=1").stats
    $jsonlCount = [int]$jsonlStats.event_count
    Check "ledger mirrors every JSONL event" ($afterSeq -eq $jsonlCount) "ledger=$afterSeq jsonl=$jsonlCount"
    Write-Host ("  ledger events = {0}, jsonl events = {1}" -f $afterSeq, $jsonlCount)
}

Write-Host "`n== 8. Idempotency: repeat verify + replay ==" -ForegroundColor Cyan
$repeat = GetJson "/v1/threads/$tid/ledger/verify"
Check "repeat verify stable" ([int]$repeat.last_seq -ge $baselineSeq)
$diag2 = GetJson "/v1/diagnostics"
Check "diagnostics counts canonical sessions" ([int]$diag2.canonical_ledger_session_count -ge 1) "sessions=$($diag2.canonical_ledger_session_count)"
Write-Host ("  canonical_ledger_event_count(after) = {0}, sessions = {1}" -f $diag2.canonical_ledger_event_count, $diag2.canonical_ledger_session_count)

Write-Host ""
if ($script:Failures -eq 0) {
    Write-Host ("SMOKE PASS - {0}/{0} checks" -f $script:Checks) -ForegroundColor Green
    exit 0
} else {
    Write-Host ("SMOKE FAIL - {0} of {1} checks failed" -f $script:Failures, $script:Checks) -ForegroundColor Red
    exit 1
}

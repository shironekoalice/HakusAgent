# Golden-replay gate driver for the Phase-1 exit gate.
#
# Proves that the model input a restarted Runtime rebuilds from durable state is
# byte-identical to the input the live turn sent. It drives the real HTTP/SSE
# surfaces against `scripts/model_stub.py`, which records every request body.
#
#   turn 1 on a fresh thread   -> live composition, recorded
#   stop the Runtime
#   turn 2 on the same thread  -> the user history is now rebuilt from the
#                                 durable item store, recorded
#
# Turn 2's request must repeat turn 1's system prompt and turn 1's user message
# byte for byte, and must still carry both turns' assistant replies.
#
# Usage:
#   pwsh -File scripts/golden-replay.ps1
#   pwsh -File scripts/golden-replay.ps1 -Port 48091 -KeepArtifacts

param(
    [int]$Port = 48081,
    [int]$StubPort = 48999,
    [string]$Root = "",
    [int]$TurnTimeoutSec = 180,
    [switch]$KeepArtifacts
)

$ErrorActionPreference = "Stop"
$OutputEncoding = [System.Text.Encoding]::UTF8

$repo = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($Root)) { $Root = Join-Path $repo ".dsh-golden" }
$home_ = Join-Path $Root "home"
$workspace = Join-Path $Root "workspace"
$capture = Join-Path $Root "model-calls.jsonl"
$stubLog = Join-Path $Root "stub.log"
$runtimeLog = Join-Path $Root "runtime.log"
$binary = Join-Path $repo "frontend\terminal\target\debug\hakus-tui.exe"
$stubScript = Join-Path $repo "scripts\model_stub.py"

$script:Failures = 0
$script:Checks = 0
$script:StubPid = $null
$script:RuntimePid = $null

function Check([string]$Name, [bool]$Ok, [string]$Detail = "") {
    $script:Checks++
    if ($Ok) {
        Write-Host ("  [PASS] {0}" -f $Name) -ForegroundColor Green
    } else {
        $script:Failures++
        Write-Host ("  [FAIL] {0} {1}" -f $Name, $Detail) -ForegroundColor Red
    }
}

function PostJson([string]$Path, [hashtable]$Body, [int]$TimeoutSec = 60) {
    $json = $Body | ConvertTo-Json -Depth 12 -Compress
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    Invoke-RestMethod -Uri "http://127.0.0.1:$Port$Path" -Method Post `
        -ContentType "application/json; charset=utf-8" -Body $bytes -TimeoutSec $TimeoutSec
}

function GetJson([string]$Path) {
    Invoke-RestMethod -Uri "http://127.0.0.1:$Port$Path" -Method Get -TimeoutSec 60
}

function Wait-RuntimeReady([int]$TimeoutSec = 120) {
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        try {
            $health = GetJson "/health"
            if ($health) { return $true }
        } catch {
            Start-Sleep -Milliseconds 400
        }
    }
    return $false
}

function Stop-Runtime {
    if ($script:RuntimePid) {
        Stop-Process -Id $script:RuntimePid -Force -ErrorAction SilentlyContinue
        $script:RuntimePid = $null
    }
    Get-Process hakus-tui -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    # The port must be free before the restart, otherwise the "restart" would be
    # measuring the same process.
    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $deadline) {
        $busy = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
        if (-not $busy) { return }
        Start-Sleep -Milliseconds 300
    }
}

# The server is launched directly, not through Start-Job: a job-hosted child
# did not serve turns at all in this environment (the turn sat in the engine
# until the driver's timeout while the stub received nothing), and a direct
# child with the same home, workspace, and config completes normally.
function Start-Runtime {
    $env:HAKUS_HOME = $home_
    $env:DEEPSEEK_HOME = $home_
    $proc = Start-Process -FilePath $binary -PassThru -NoNewWindow -WorkingDirectory $workspace `
        -ArgumentList @('serve', '--http', '--insecure', '--port', "$Port") `
        -RedirectStandardOutput $runtimeLog -RedirectStandardError "$runtimeLog.err"
    $script:RuntimePid = $proc.Id
    Remove-Item Env:\HAKUS_HOME -ErrorAction SilentlyContinue
    Remove-Item Env:\DEEPSEEK_HOME -ErrorAction SilentlyContinue
}

function Send-Turn([string]$ThreadId, [string]$Prompt) {
    $turn = PostJson "/v1/threads/$ThreadId/turns" @{ prompt = $Prompt }
    $turnId = $turn.turn.id
    $deadline = (Get-Date).AddSeconds($TurnTimeoutSec)
    $terminal = @("completed", "failed", "cancelled", "interrupted")
    while ((Get-Date) -lt $deadline) {
        $detail = GetJson "/v1/threads/$ThreadId"
        $t = @($detail.turns) | Where-Object { $_.id -eq $turnId } | Select-Object -First 1
        if ($t -and ($terminal -contains $t.status)) { return $t.status }
        Start-Sleep -Milliseconds 500
    }
    return "timeout"
}

function Read-Capture {
    $items = @()
    if (Test-Path $capture) {
        foreach ($line in Get-Content $capture) {
            if ($line.Trim()) { $items += , ($line | ConvertFrom-Json) }
        }
    }
    # A plain array return: the caller wraps it in @(), and `+= ,` above keeps
    # each parsed line exactly one element even when ConvertFrom-Json hands back
    # an array of its own.
    return $items
}

function Get-CallIndices([object[]]$Calls) {
    $indices = @()
    foreach ($call in @($Calls)) {
        foreach ($item in @($call)) { $indices += [int]$item.call_index }
    }
    return $indices
}

function Canonical($Value) {
    return ($Value | ConvertTo-Json -Depth 40 -Compress)
}

function Stop-Stub {
    if ($script:StubPid) {
        Stop-Process -Id $script:StubPid -Force -ErrorAction SilentlyContinue
        $script:StubPid = $null
    }
}

function Start-Stub {
    $proc = Start-Process -FilePath (Get-Command python).Source -PassThru -NoNewWindow `
        -ArgumentList @($stubScript, '--port', "$StubPort", '--out', $capture) `
        -RedirectStandardOutput $stubLog -RedirectStandardError "$stubLog.err"
    $script:StubPid = $proc.Id
}

# ---------------------------------------------------------------- setup
if (Test-Path $Root) {
    Remove-Item $Root -Recurse -Force -ErrorAction SilentlyContinue
}
New-Item -ItemType Directory -Force -Path $home_, $workspace | Out-Null

foreach ($d in @("automations", "sessions", "tasks", "workspace")) {
    New-Item -ItemType Directory -Force -Path (Join-Path $home_ $d) | Out-Null
}

# A git workspace makes `<turn_meta>` carry its "Git workspace:" line, which is
# the volatile part the durable record has to reproduce.
Push-Location $workspace
try {
    git init --quiet 2>&1 | Out-Null
    git config user.email "golden@replay.local" 2>&1 | Out-Null
    git config user.name "Golden Replay" 2>&1 | Out-Null
    Set-Content -Path (Join-Path $workspace "README.md") -Value "golden replay workspace" -Encoding utf8
    git add -A 2>&1 | Out-Null
    git -c commit.gpgsign=false commit --quiet -m "seed" 2>&1 | Out-Null
} finally {
    Pop-Location
}

$config = @"
provider = "hy4"
default_text_model = "hy4-preview"

allow_shell = false
approval_policy = "never"
sandbox_mode = "workspace-write"

[providers.hy4]
kind = "openai-compatible"
display_name = "Golden replay stub"
api_key = "stub-key"
base_url = "http://127.0.0.1:$StubPort/v1"
model = "hy4-preview"
wire = "openai"
models = ["hy4-preview"]

[update]
check_for_updates = false
"@
Set-Content -Path (Join-Path $home_ "config.toml") -Value $config -Encoding utf8

Write-Host "`n== Golden replay ==" -ForegroundColor Cyan
Write-Host "  root      = $Root"
Write-Host "  runtime   = http://127.0.0.1:$Port"
Write-Host "  stub      = http://127.0.0.1:$StubPort"
Write-Host "  workspace = $workspace"
Write-Host "  capture   = $capture"

if (-not (Test-Path $binary)) {
    Write-Host "runtime binary missing: $binary`nbuild it first: cargo build -p hakus-tui --bin hakus-tui" -ForegroundColor Red
    exit 2
}

# ---------------------------------------------------------------- run
try {
    Write-Host "`n== 1. Start the model stub ==" -ForegroundColor Cyan
    Start-Stub
    $stubReady = $false
    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $deadline) {
        try {
            Invoke-RestMethod -Uri "http://127.0.0.1:$StubPort/v1/models" -TimeoutSec 5 | Out-Null
            $stubReady = $true; break
        } catch { Start-Sleep -Milliseconds 400 }
    }
    Check "model stub listening" $stubReady "see $stubLog"
    if (-not $stubReady) { throw "model stub did not start" }

    Write-Host "`n== 2. Start the Runtime and create a thread ==" -ForegroundColor Cyan
    Start-Runtime
    Check "runtime reports ready" (Wait-RuntimeReady) "see $runtimeLog"
    $health = GetJson "/health"
    Check "runtime execution plane is rust" ($health.execution_plane -eq "rust") "got '$($health.execution_plane)'"
    $thread = PostJson "/v1/threads" @{ title = "Golden replay"; mode = "agent"; archived = $false }
    $tid = $thread.id
    Check "thread created" (-not [string]::IsNullOrWhiteSpace($tid)) "id='$tid'"
    Write-Host "  thread_id = $tid"

    Write-Host "`n== 3. Turn 1 (live composition) ==" -ForegroundColor Cyan
    $status1 = Send-Turn $tid "reply with exactly GOLDEN_ONE"
    Check "turn 1 completed" ($status1 -eq "completed") "status=$status1"
    $calls1 = @(Read-Capture)
    Check "turn 1 produced one model call" ($calls1.Count -eq 1) "calls=$($calls1.Count)"
    $boundary = 0
    $indices = Get-CallIndices $calls1
    if ($indices.Count -ge 1) { $boundary = $indices[-1] }

    Write-Host "`n== 4. Restart the Runtime ==" -ForegroundColor Cyan
    Stop-Runtime
    Start-Sleep -Seconds 2
    Start-Runtime
    Check "runtime restarted" (Wait-RuntimeReady) "see $runtimeLog"
    $detail = GetJson "/v1/threads/$tid"
    Check "thread survived the restart" ($detail.thread.id -eq $tid)
    Check "turn 1 is durable" (@($detail.turns).Count -ge 1) "turns=$(@($detail.turns).Count)"

    Write-Host "`n== 5. Turn 2 (history rebuilt from durable state) ==" -ForegroundColor Cyan
    $status2 = Send-Turn $tid "reply with exactly GOLDEN_TWO"
    Check "turn 2 completed" ($status2 -eq "completed") "status=$status2"
    $calls = @(Read-Capture)
    $calls2 = @($calls | Where-Object { [int]$_.call_index -gt $boundary })
    Check "turn 2 produced one model call" ($calls2.Count -eq 1) "calls=$($calls2.Count)"

    Write-Host "`n== 6. Compare the model input byte for byte ==" -ForegroundColor Cyan
    if ($calls2.Count -ge 1) {
        $bodyA = $calls1[0].body
        $bodyB = $calls2[0].body
        $messagesA = @($bodyA.messages)
        $messagesB = @($bodyB.messages)
        Write-Host ("  turn 1: {0} messages, sha256={1}" -f $messagesA.Count, $calls1[0].sha256)
        Write-Host ("  turn 2: {0} messages, sha256={1}" -f $messagesB.Count, $calls2[0].sha256)

        Check "turn 2 carries both turns' assistant replies" `
            ($messagesB.Count -eq $messagesA.Count + 2) `
            "turn1=$($messagesA.Count) turn2=$($messagesB.Count)"
        Check "system prompt is byte-identical" `
            ((Canonical $messagesA[0]) -eq (Canonical $messagesB[0]))

        $userA = $messagesA | Where-Object { $_.role -eq "user" } | Select-Object -First 1
        $userB = $messagesB | Where-Object { $_.role -eq "user" } | Select-Object -First 1
        $sameUser = (Canonical $userA) -eq (Canonical $userB)
        Check "turn 1 user message (with turn_meta) replays byte-identically" $sameUser
        if (-not $sameUser) {
            $ca = Canonical $userA
            $cb = Canonical $userB
            for ($i = 0; $i -lt [Math]::Min($ca.Length, $cb.Length); $i++) {
                if ($ca[$i] -ne $cb[$i]) {
                    $lo = [Math]::Max(0, $i - 80)
                    Write-Host ("    first diff at char {0}" -f $i) -ForegroundColor Yellow
                    Write-Host ("      live : ...{0}..." -f $ca.Substring($lo, [Math]::Min(160, $ca.Length - $lo))) -ForegroundColor Yellow
                    Write-Host ("      rebuilt: ...{0}..." -f $cb.Substring($lo, [Math]::Min(160, $cb.Length - $lo))) -ForegroundColor Yellow
                    break
                }
            }
        }

        $assistantB = $messagesB | Where-Object { $_.role -eq "assistant" } | Select-Object -First 1
        $assistantText = "$($assistantB.content)"
        Write-Host ("  turn 1 assistant reply, as turn 2 resends it: {0}" -f $assistantText)
        Check "turn 1 assistant reply is carried into turn 2" `
            ($assistantText -eq "GOLDEN_REPLAY_OK") "got '$assistantText'"

        # Turn 1's own request carried no assistant message (its history was
        # only the system prompt and the live user turn), so the retained prefix
        # is compared over the indices both requests actually have.
        Write-Host "`n  retained prefix (system prompt + turn 1 user turn):"
        $names = @("system prompt", "turn 1 user message")
        for ($i = 0; $i -lt $names.Count; $i++) {
            $same = ($i -lt $messagesA.Count) -and ($i -lt $messagesB.Count) -and
                ((Canonical $messagesA[$i]) -eq (Canonical $messagesB[$i]))
            Check ("turn 2 resends message[{0}] ({1}) byte-identically" -f $i, $names[$i]) $same
        }
    }

    Write-Host "`n== 7. Ledger still verifies ==" -ForegroundColor Cyan
    $verify = GetJson "/v1/threads/$tid/ledger/verify"
    Check "ledger contiguous after both turns" ($verify.contiguous -eq $true) "verify=$($verify | ConvertTo-Json -Compress)"
    $jsonl = (GetJson "/v1/threads/$tid/event-log?limit=1").stats
    Check "ledger mirrors every JSONL event" `
        ([int]$verify.last_seq -eq [int]$jsonl.event_count) `
        "ledger=$($verify.last_seq) jsonl=$($jsonl.event_count)"
    $items = @($detail.items) + @((GetJson "/v1/threads/$tid").items)
    $userItems = @($items | Where-Object { $_.kind -eq "user_message" })
    Check "user turn items recorded" ($userItems.Count -ge 1) "user_items=$($userItems.Count)"
    $withBlocks = @($userItems | Where-Object { $null -ne $_.metadata.provider_blocks })
    Check "user turn items carry the composed provider blocks" `
        ($withBlocks.Count -eq $userItems.Count) `
        "with_blocks=$($withBlocks.Count) of $($userItems.Count)"
} catch {
    Write-Host ("`nDRIVER ERROR: " + $_.Exception.Message) -ForegroundColor Red
    $script:Failures++
} finally {
    Stop-Runtime
    Stop-Stub
    Remove-Item Env:\HAKUS_HOME -ErrorAction SilentlyContinue
    Remove-Item Env:\DEEPSEEK_HOME -ErrorAction SilentlyContinue
}

Write-Host ""
if ($script:Failures -eq 0) {
    Write-Host ("GOLDEN REPLAY PASS - {0}/{0} checks" -f $script:Checks) -ForegroundColor Green
    Write-Host ("capture: {0}" -f $capture)
    exit 0
} else {
    Write-Host ("GOLDEN REPLAY FAIL - {0} of {1} checks failed" -f $script:Failures, $script:Checks) -ForegroundColor Red
    Write-Host ("capture: {0}" -f $capture)
    Write-Host ("runtime log: {0}" -f $runtimeLog)
    exit 1
}

param(
    [string]$RepoRoot = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'
$terminalRoot = Join-Path $RepoRoot 'frontend/terminal'
$desktopRoot = Join-Path $RepoRoot 'HakusAgent/frontend/desktop-tauri'

$results = [System.Collections.Generic.List[object]]::new()

function Invoke-Gate([string]$Name, [string]$Command, [string]$WorkingDirectory) {
    Write-Host "`n== $Name =="
    Push-Location $WorkingDirectory
    try {
        & powershell -NoProfile -ExecutionPolicy Bypass -Command $Command
        $code = $LASTEXITCODE
    } finally {
        Pop-Location
    }
    $results.Add([pscustomobject]@{ name = $Name; command = $Command; exit_code = $code })
    if ($code -ne 0) {
        throw "Gate failed: $Name (exit $code)"
    }
}

# These checks are the named Phase 2 exit-gate constituents. Keeping them in a
# single driver prevents a green phase from depending on a hand-picked subset.
Invoke-Gate 'Rust policy, mutation, receipt, and workspace routes' `
    'cargo test -p hakus-tui --lib -- tool_call_receipts_are_durable_by_the_time_the_turn_is_terminal tool_call_start_is_durable_within_the_turn_but_not_acknowledged worktree_add apply_hunk' `
    $terminalRoot

Invoke-Gate 'Retired Python PTY route' `
    'python scripts/verify_terminal_retired.py' `
    $RepoRoot

Invoke-Gate 'Python permission seed and fail-closed execution' `
    'python -m pytest tests/test_permission_seed_modes.py -q' `
    $RepoRoot

Invoke-Gate 'Desktop Rust command surface' `
    'cargo test --lib' `
    (Join-Path $desktopRoot 'src-tauri')

Invoke-Gate 'Desktop frontend typecheck and unit suite' `
    'npx tsc --noEmit; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; npx vitest run' `
    $desktopRoot

$report = [pscustomobject]@{
    gate = 'phase2-exit-gate'
    status = 'pass'
    checks = @($results)
    generated_at = (Get-Date).ToUniversalTime().ToString('o')
}
Write-Output ($report | ConvertTo-Json -Depth 5)

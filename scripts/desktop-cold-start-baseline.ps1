param(
    [int]$Runs = 10,
    [string]$Binary = "",
    [int]$DevPort = 1420,
    [int]$CdpBasePort = 9230,
    [int]$TimeoutSec = 45,
    [string]$BrowserArguments = "",
    [string]$ResultsFileName = "baseline.json",
    [switch]$NoDevServer
)

$ErrorActionPreference = "Stop"
$OutputEncoding = [System.Text.Encoding]::UTF8
$repo = Split-Path -Parent $PSScriptRoot
$desktopRoot = Join-Path $repo "HakusAgent\frontend\desktop-tauri"
if ([string]::IsNullOrWhiteSpace($Binary)) {
    $Binary = Join-Path $desktopRoot "src-tauri\target\debug\desktop-tauri.exe"
}
$outRoot = Join-Path $repo ".dsh-desktop-coldstart"
$resultsPath = Join-Path $outRoot $ResultsFileName
$profile = if ($Binary -match '[\\/]release[\\/]') { "release" } else { "debug" }

if (-not (Test-Path $Binary)) { throw "desktop binary missing: $Binary" }

function Stop-ProcessTree([int]$RootPid) {
    $children = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object { $_.ParentProcessId -eq $RootPid })
    foreach ($child in $children) { Stop-ProcessTree ([int]$child.ProcessId) }
    Stop-Process -Id $RootPid -Force -ErrorAction SilentlyContinue
}

function Get-DesktopProcesses() {
    $expected = [IO.Path]::GetFullPath($Binary)
    return @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object {
            $_.Name -eq [IO.Path]::GetFileName($expected) -and
            $_.ExecutablePath -and
            ([IO.Path]::GetFullPath($_.ExecutablePath) -ieq $expected)
        })
}

function Get-CdpProcesses([int]$Port) {
    $needle = "--remote-debugging-port=$Port"
    return @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -eq 'msedgewebview2.exe' -and $_.CommandLine -like "*$needle*" })
}

function Stop-CdpProcesses([int]$Port) {
    foreach ($process in (Get-CdpProcesses $Port)) {
        Stop-ProcessTree ([int]$process.ProcessId)
    }
    foreach ($process in (Get-CdpProcesses $Port)) {
        Stop-Process -Id ([int]$process.ProcessId) -Force -ErrorAction SilentlyContinue
    }
}

function Wait-CdpReady([int]$Port, [DateTime]$Deadline, [string]$ExpectedUrlPrefix) {
    while ((Get-Date) -lt $Deadline) {
        try {
            $targets = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/list" -TimeoutSec 1
            $page = @($targets | Where-Object {
                $_.type -eq 'page' -and
                ([string]::IsNullOrEmpty($ExpectedUrlPrefix) -or $_.url -like "$ExpectedUrlPrefix*")
            }) | Select-Object -First 1
            # The packaged page title can be rewritten by the embedded runtime
            # (for example, to the host name). The isolated CDP port and URL
            # match are the stable readiness signal.
            if ($page -and
                -not [string]::IsNullOrWhiteSpace([string]$page.url) -and
                $page.url -ne 'about:blank' -and
                -not [string]::IsNullOrWhiteSpace([string]$page.title) -and
                $page.title -ne 'about:blank') {
                return [pscustomobject]@{
                    title = [string]$page.title
                    url = [string]$page.url
                }
            }
        } catch { }
        Start-Sleep -Milliseconds 100
    }
    return $null
}

function Get-ProcessTreeIds([int]$RootPid) {
    $ids = [System.Collections.Generic.List[int]]::new()
    $ids.Add($RootPid)
    $frontier = @($RootPid)
    while ($frontier.Count -gt 0) {
        $children = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
            Where-Object { $frontier -contains [int]$_.ParentProcessId })
        $frontier = @()
        foreach ($child in $children) {
            $childId = [int]$child.ProcessId
            if (-not $ids.Contains($childId)) {
                $ids.Add($childId)
                $frontier += $childId
            }
        }
    }
    return @($ids)
}

function Get-WorkingSetMb([int[]]$RootPids, [int]$CdpPort) {
    $rootIds = [System.Collections.Generic.HashSet[int]]::new()
    foreach ($rootPid in $RootPids) {
        foreach ($processId in (Get-ProcessTreeIds $rootPid)) { [void]$rootIds.Add($processId) }
    }
    foreach ($process in (Get-CdpProcesses $CdpPort)) {
        foreach ($processId in (Get-ProcessTreeIds ([int]$process.ProcessId))) { [void]$rootIds.Add($processId) }
    }
    $total = [int64]0
    foreach ($procId in $rootIds) {
        try { $total += [int64](Get-Process -Id $procId -ErrorAction Stop).WorkingSet64 } catch { }
    }
    return [math]::Round($total / 1MB, 1)
}

New-Item -ItemType Directory -Force -Path $outRoot | Out-Null
$runningDesktop = @(Get-DesktopProcesses)
if ($runningDesktop.Count -gt 0) {
    throw "desktop binary is already running (PID $($runningDesktop[0].ProcessId)); close it before measuring"
}

$vite = $null
$activeAppPid = 0
$expectedUrlPrefix = if ($NoDevServer) { "" } else { "http://127.0.0.1:$DevPort/" }
try {
    if (-not $NoDevServer) {
        $viteLog = Join-Path $outRoot "vite.out.log"
        $viteErr = Join-Path $outRoot "vite.err.log"
        $vite = Start-Process -FilePath "npm.cmd" -ArgumentList @("run", "dev", "--", "--host", "127.0.0.1", "--port", "$DevPort") `
            -WorkingDirectory $desktopRoot -PassThru -RedirectStandardOutput $viteLog -RedirectStandardError $viteErr
        $viteDeadline = (Get-Date).AddSeconds(30)
        $viteReady = $false
        while ((Get-Date) -lt $viteDeadline) {
            try { Invoke-WebRequest -Uri "http://127.0.0.1:$DevPort/" -TimeoutSec 1 | Out-Null; $viteReady = $true; break } catch { Start-Sleep -Milliseconds 100 }
        }
        if (-not $viteReady) { throw "Vite did not become ready on port $DevPort" }
    }

    $launches = @()
    for ($i = 1; $i -le $Runs; $i++) {
        $cdpPort = $CdpBasePort + $i
        $occupied = @(Get-NetTCPConnection -State Listen -LocalPort $cdpPort -ErrorAction SilentlyContinue)
        if ($occupied.Count -gt 0 -or @(Get-CdpProcesses $cdpPort).Count -gt 0) {
            throw "CDP port $cdpPort is already in use; choose another CdpBasePort"
        }
        $runningDesktop = @(Get-DesktopProcesses)
        if ($runningDesktop.Count -gt 0) {
            throw "desktop binary became active during measurement (PID $($runningDesktop[0].ProcessId))"
        }
        $extraBrowserArguments = $BrowserArguments.Trim()
        $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = ("--remote-debugging-port=$cdpPort $extraBrowserArguments").Trim()
        # Use a fresh WebView2 profile for every launch. The default profile
        # can reuse an existing browser process from another WebView2 host,
        # which makes CDP and process-tree measurements non-deterministic.
        $webviewUserData = Join-Path $outRoot ("webview2-run-{0}" -f $i)
        if (Test-Path $webviewUserData) {
            Remove-Item -LiteralPath $webviewUserData -Recurse -Force
        }
        New-Item -ItemType Directory -Force -Path $webviewUserData | Out-Null
        $env:WEBVIEW2_USER_DATA_FOLDER = $webviewUserData
        $started = [DateTime]::UtcNow
        $log = Join-Path $outRoot "run-$i.out.log"
        $err = Join-Path $outRoot "run-$i.err.log"
        $app = Start-Process -FilePath $Binary -WorkingDirectory $desktopRoot -PassThru `
            -RedirectStandardOutput $log -RedirectStandardError $err
        $activeAppPid = $app.Id
        $readyPage = Wait-CdpReady $cdpPort ((Get-Date).AddSeconds($TimeoutSec)) $expectedUrlPrefix
        $ready = $null -ne $readyPage
        $elapsed = if ($ready) { [int]([DateTime]::UtcNow - $started).TotalMilliseconds } else { $null }
        $app.Refresh()
        $workingSet = if ($ready) { Get-WorkingSetMb @($app.Id) $cdpPort } else { $null }
        $launches += [pscustomobject][ordered]@{
            run = $i
            pid = $app.Id
            window_usable = $ready
            window_usable_ms = $elapsed
            working_set_mb = $workingSet
            process_exited_early = $app.HasExited
            cdp_port = $cdpPort
            cdp_title = if ($readyPage) { $readyPage.title } else { $null }
            cdp_url = if ($readyPage) { $readyPage.url } else { $null }
        }
        Write-Host ("  run {0,2}: usable={1}ms ws={2}MB pid={3}" -f $i, $elapsed, $workingSet, $app.Id)
        Stop-ProcessTree $app.Id
        Stop-CdpProcesses $cdpPort
        $activeAppPid = 0
        Remove-Item Env:\WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS -ErrorAction SilentlyContinue
        Remove-Item Env:\WEBVIEW2_USER_DATA_FOLDER -ErrorAction SilentlyContinue
        $stopDeadline = (Get-Date).AddSeconds(10)
        while ((Get-Date) -lt $stopDeadline -and @(Get-DesktopProcesses).Count -gt 0) {
            Start-Sleep -Milliseconds 100
        }
        if (@(Get-DesktopProcesses).Count -gt 0) {
            throw "desktop process did not stop after run $i"
        }
        Start-Sleep -Milliseconds 500
    }
} finally {
    Remove-Item Env:\WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS -ErrorAction SilentlyContinue
    Remove-Item Env:\WEBVIEW2_USER_DATA_FOLDER -ErrorAction SilentlyContinue
    if ($activeAppPid -gt 0) { Stop-ProcessTree $activeAppPid }
    if ($vite) { Stop-ProcessTree $vite.Id }
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
    profile = $profile
    reference_machine = "$env:COMPUTERNAME / Windows $([Environment]::OSVersion.Version)"
    dev_server = if ($NoDevServer) { "none (bundled production assets)" } else { "Vite http://127.0.0.1:$DevPort" }
    enabled_extensions = "default desktop build"
    window_usable = Stats $launches.window_usable_ms
    working_set_mb = Stats $launches.working_set_mb
    launches = $launches
}
$summary | ConvertTo-Json -Depth 6 | Set-Content -Path $resultsPath -Encoding utf8
Write-Host "`nwindow_usable: median=$($summary.window_usable.median)ms p95=$($summary.window_usable.p95)ms"
Write-Host "results: $resultsPath"

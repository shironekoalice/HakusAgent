[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]] $TauriArguments
)

$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$desktopRoot = Join-Path $repositoryRoot 'HakusAgent/frontend/desktop-tauri'
$androidHome = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { $env:ANDROID_SDK_ROOT }

$ndkRoot = if ($env:ANDROID_NDK_HOME) {
    $env:ANDROID_NDK_HOME
} elseif ($env:ANDROID_NDK_ROOT) {
    $env:ANDROID_NDK_ROOT
} elseif ($androidHome) {
    $ndkParent = Join-Path $androidHome 'ndk'
    if (Test-Path $ndkParent) {
        Get-ChildItem $ndkParent -Directory | Sort-Object Name -Descending | Select-Object -First 1 -ExpandProperty FullName
    }
}

if (-not $ndkRoot -or -not (Test-Path $ndkRoot)) {
    throw 'Android NDK is required. Set ANDROID_NDK_HOME or install an NDK under ANDROID_HOME/ndk.'
}

$toolchainRoot = Join-Path $ndkRoot 'toolchains/llvm/prebuilt/windows-x86_64'
$clangRoot = Join-Path $toolchainRoot 'bin'
$clang = Join-Path $clangRoot 'aarch64-linux-android24-clang.cmd'
$clangPlusPlus = Join-Path $clangRoot 'aarch64-linux-android24-clang++.cmd'
$ar = Join-Path $clangRoot 'llvm-ar.exe'
$sysroot = Join-Path $toolchainRoot 'sysroot'
$resourceRoot = Join-Path $toolchainRoot 'lib/clang'
$resourceVersion = Get-ChildItem $resourceRoot -Directory | Sort-Object Name -Descending | Select-Object -First 1

foreach ($required in @($clang, $clangPlusPlus, $ar, $sysroot, $resourceVersion.FullName)) {
    if (-not (Test-Path $required)) {
        throw "Android NDK toolchain entry is missing: $required"
    }
}

# Bindgen runs as a host executable, so use forward-slash NDK paths in its
# argument string. This preserves the argument boundaries on Windows and
# prevents a Chinese workspace path from being parsed as a host include path.
$ndkForClang = ($toolchainRoot -replace '\\', '/')
$env:BINDGEN_EXTRA_CLANG_ARGS = "--target=aarch64-linux-android24 --sysroot=$ndkForClang/sysroot -resource-dir=$ndkForClang/lib/clang/$($resourceVersion.Name) -I$ndkForClang/sysroot/usr/include/aarch64-linux-android"
$env:CC_aarch64_linux_android = $clang
$env:CXX_aarch64_linux_android = $clangPlusPlus
$env:AR_aarch64_linux_android = $ar
$linkerWrapper = Join-Path $PSScriptRoot 'android-aarch64-linker.cmd'
$env:CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER = $linkerWrapper
$linkerFlag = "-C linker=$($linkerWrapper -replace '\\', '/')"
if ($env:CARGO_TARGET_AARCH64_LINUX_ANDROID_RUSTFLAGS) {
    $env:CARGO_TARGET_AARCH64_LINUX_ANDROID_RUSTFLAGS = "$($env:CARGO_TARGET_AARCH64_LINUX_ANDROID_RUSTFLAGS) $linkerFlag"
} else {
    $env:CARGO_TARGET_AARCH64_LINUX_ANDROID_RUSTFLAGS = $linkerFlag
}

Write-Host "Using Android NDK: $ndkRoot"
Write-Host "Using bindgen sysroot: $sysroot"

# Tauri's Gradle pass overrides CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER
# with the NDK clang (which chokes on non-ASCII repo paths), so route every
# rustc invocation through this exe wrapper; it re-injects our linker for
# aarch64-android targets. Rust exe, not cmd, so quoted --cfg args survive.
$env:RUSTC_WRAPPER = Join-Path $PSScriptRoot 'android-rustc-wrapper.exe'
Push-Location $desktopRoot
try {
    & npx tauri android build --apk --target aarch64 @TauriArguments
    exit $LASTEXITCODE
} finally {
    Pop-Location
}




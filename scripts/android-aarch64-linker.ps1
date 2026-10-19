[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]] $LinkerArguments
)

$ErrorActionPreference = 'Stop'
$ndkRoot = if ($env:ANDROID_NDK_HOME) {
    $env:ANDROID_NDK_HOME
} elseif ($env:ANDROID_NDK_ROOT) {
    $env:ANDROID_NDK_ROOT
} else {
    $androidHome = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { $env:ANDROID_SDK_ROOT }
    $ndkParent = if ($androidHome) { Join-Path $androidHome 'ndk' }
    if ($ndkParent -and (Test-Path $ndkParent)) {
        (Get-ChildItem $ndkParent -Directory | Sort-Object Name -Descending | Select-Object -First 1 -ExpandProperty FullName)
    }
}

if (-not $ndkRoot) {
    throw 'Android NDK was not found. Set ANDROID_NDK_HOME or install an NDK under ANDROID_HOME/ndk.'
}

$clang = Join-Path $ndkRoot 'toolchains/llvm/prebuilt/windows-x86_64/bin/clang.exe'
if (-not (Test-Path $clang)) {
    throw "Android clang was not found at $clang"
}

# LLVM's Windows argument decoder still receives non-ASCII absolute paths from
# rustc as mojibake. Convert paths inside the repository to relative ASCII
# paths before invoking clang; the files and output remain in the workspace.
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path.TrimEnd('\')
$workingDirectory = (Get-Location).Path.TrimEnd('\')
$repoUri = [Uri]($repositoryRoot + [IO.Path]::DirectorySeparatorChar)
$baseUri = New-Object System.Uri -ArgumentList ($workingDirectory + [IO.Path]::DirectorySeparatorChar)
$relativeRepositoryRoot = [Uri]::UnescapeDataString($baseUri.MakeRelativeUri($repoUri).ToString())
$repositoryPrefix = $repositoryRoot + '\'
$repositoryPrefixForward = $repositoryRoot.Replace('\', '/') + '/'

$normalizedArguments = foreach ($argument in $LinkerArguments) {
    $value = [string]$argument
    $value = $value.Replace($repositoryPrefix, ($relativeRepositoryRoot.TrimEnd('\') + '\'))
    $value = $value.Replace($repositoryPrefixForward, ($relativeRepositoryRoot.Replace('\', '/').TrimEnd('/') + '/'))
    $value
}

$clangArgs = @('--target=aarch64-linux-android24') + [string[]]$normalizedArguments
& $clang @clangArgs
exit $LASTEXITCODE

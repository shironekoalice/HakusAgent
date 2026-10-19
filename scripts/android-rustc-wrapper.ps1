[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]] $RustcArguments
)

$ErrorActionPreference = 'Stop'
if ($RustcArguments.Count -lt 1) {
    throw 'rustc wrapper requires the real rustc path as its first argument.'
}

$rustc = $RustcArguments[0]
$arguments = @($RustcArguments | Select-Object -Skip 1 | ForEach-Object {
    if ($_ -eq '__HAKUS_STDIN__') { '-' } else { $_ }
})
$isAndroidTarget = (
    ($arguments -contains '--target' -and $arguments -contains 'aarch64-linux-android') -or
    $arguments -contains '--target=aarch64-linux-android'
)

if ($isAndroidTarget) {
    $linker = (Join-Path $PSScriptRoot 'android-aarch64-linker.exe').Replace('\', '/')
    $arguments += @('-C', "linker=$linker")
}

& $rustc @arguments
exit $LASTEXITCODE


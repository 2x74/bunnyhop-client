# Execute the actual release-check/startup block from BOTH workflow copies with
# adversarial native exit codes. A later successful help command cannot erase failure.
$ErrorActionPreference = 'Stop'
$repo = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
foreach ($relative in @('.github/workflows/native-release.yml', 'native/apps/native/packaging/workflows/native-packages.yml')) {
    $yaml = Get-Content -Raw (Join-Path $repo $relative)
    $match = [regex]::Match($yaml, '(?m)^          \$package = Get-ChildItem[^\r\n]*\r?\n(?:          [^\r\n]*\r?\n)+')
    if (!$match.Success) { throw "Release-check block absent in $relative" }
    $block = $match.Value -replace '(?m)^          ', ''
    $block = $block -replace '(?m)^& \(Join-Path[^\r\n]*--help', '$global:startupCalled = $true; $global:LASTEXITCODE = $global:startupExit'
    function Get-ChildItem { [PSCustomObject]@{ FullName = 'fixture-package' } }
    function bun { $global:LASTEXITCODE = $global:releaseExit }
    foreach ($case in @(@{release=42; startup=0; fail=$true; called=$false}, @{release=0; startup=19; fail=$true; called=$true}, @{release=0; startup=0; fail=$false; called=$true})) {
        $global:releaseExit = $case.release; $global:startupExit = $case.startup; $global:startupCalled = $false
        $failed = $false
        try { & ([scriptblock]::Create($block)) } catch { $failed = $true }
        if ($failed -ne $case.fail -or $global:startupCalled -ne $case.called) { throw "Exit-code masking regression in $relative (release=$($case.release), startup=$($case.startup))" }
    }
    Write-Output "PASS $relative : release 42/help 0 rejected before startup; release 0/help 19 rejected; 0/0 accepted"
}

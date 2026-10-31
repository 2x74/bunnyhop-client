# Extract the measurement artifact, then run from PowerShell. No Python or game account is needed.
param(
    [Parameter(Mandatory = $true)][string]$Map,
    [string]$ContentRoot = '',
    [string]$Output = 'renderer-measurement',
    [ValidateRange(100, 100000)][int]$Frames = 3000,
    [ValidateRange(90, 10000)][int]$Warmup = 300,
    [ValidateRange(1, 10)][int]$Repeats = 3
)
$ErrorActionPreference = 'Stop'
$bundle = $PSScriptRoot
if (!(Test-Path (Join-Path $bundle 'bunnyhop-native-gameplay-benchmark.exe'))) {
    throw 'Run the copy of measure-renderer.ps1 in the extracted Windows measurement artifact.'
}
$mapPath = (Resolve-Path -LiteralPath $Map).Path
$contentPath = if ($ContentRoot) { (Resolve-Path -LiteralPath $ContentRoot).Path } else { '' }
$outputPath = [System.IO.Path]::GetFullPath($Output)
New-Item -ItemType Directory -Force $outputPath | Out-Null
$work = Join-Path $outputPath ('.work-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory $work | Out-Null
$benchmark = $null
$presentmon = $null
$records = [System.Collections.Generic.List[object]]::new()
$summary = [System.Collections.Generic.List[string]]::new()
$summary.Add('Bunnyhop OpenGL / D3D11 interop comparison (VSync off)')
$shaderResult = $null

function Read-PresentModes([string]$Csv, [object]$Result) {
    $counts = @{}
    if (!(Test-Path -LiteralPath $Csv)) {
        return @{ counts = $counts; reason = 'PresentMon produced no CSV; run PowerShell as administrator for ETW.' }
    }
    # Keep only the measured QPC interval and only the PresentMode column. The raw CSV stays private.
    foreach ($row in (Import-Csv -LiteralPath $Csv)) {
        if (!$row.PresentMode -or !$row.CPUStartQPC) { continue }
        $qpc = [double]$row.CPUStartQPC
        if ($qpc -lt $Result.measuredQpcStart -or $qpc -gt $Result.measuredQpcEnd) { continue }
        $mode = $row.PresentMode
        if ($mode -notmatch '^(Hardware|Composed|Unknown|Other|Independent|Legacy|Flip|Copy)[: A-Za-z0-9()_-]*$') {
            $mode = 'Unknown'
        }
        if (!$counts.ContainsKey($mode)) { $counts[$mode] = 0 }
        $counts[$mode]++
    }
    $reason = if ($counts.Count) { '' } else { 'No measured PresentMode/QPC rows; ETW unavailable or CSV format changed.' }
    return @{ counts = $counts; reason = $reason }
}

try {
    Push-Location $bundle
    & ./bunnyhop-native-shader-benchmark.exe target/native-assets (Join-Path $work 'shaders.json') *> (Join-Path $work 'shader.log')
    if ($LASTEXITCODE -ne 0) { throw 'Shader compilation measurement failed.' }
    $shaderResult = Get-Content -Raw (Join-Path $work 'shaders.json') | ConvertFrom-Json
    $summary.Add("GPU: $($shaderResult.gpu); driver: $($shaderResult.driver); OS: $($shaderResult.os)")
    $shaderTimes = @($shaderResult.permutations | ForEach-Object { [double]$_.totalMs } | Sort-Object)
    $summary.Add(('Shader lazy compile/link: {0} keys; median {1:F2} ms; worst {2:F2} ms (driver cache intact).' -f `
        $shaderTimes.Count, $shaderTimes[[int][Math]::Floor($shaderTimes.Count / 2)], $shaderTimes[-1]))
    for ($repeat = 0; $repeat -lt $Repeats; $repeat++) {
        $cases = @(@{ mode = 'off'; fps = 0 }, @{ mode = 'on'; fps = 0 }, @{ mode = 'boost'; fps = 0 },
                   @{ mode = 'off'; fps = 240 }, @{ mode = 'on'; fps = 240 }, @{ mode = 'boost'; fps = 240 })
        if ($repeat % 2) { [array]::Reverse($cases) }
        foreach ($case in $cases) {
            $stem = "r$($repeat + 1)-$($case.mode)-$($case.fps)"
            Write-Host "Measuring $stem. Leave the fullscreen window focused; Escape cancels."
            $ready = Join-Path $work "$stem.ready"
            $start = Join-Path $work "$stem.start"
            $resultPath = Join-Path $work "$stem.json"
            $csv = Join-Path $work "$stem.csv"
            $spec = @{ path = $mapPath; contentRoot = $contentPath; out = $resultPath; frames = $Frames;
                warmup = $Warmup; fpsLimit = $case.fps; lowLatency = $case.mode; vsync = $false;
                comparison = $true; visible = $true; limitQueuedFrames = $true; readyFile = $ready; startFile = $start }
            $specPath = Join-Path $work "$stem-spec.json"
            $spec | ConvertTo-Json -Depth 10 | Set-Content -Encoding UTF8 $specPath
            $benchmark = Start-Process -FilePath (Join-Path $bundle 'bunnyhop-native-gameplay-benchmark.exe') `
                -ArgumentList ('"' + $specPath + '"') -PassThru -RedirectStandardOutput (Join-Path $work "$stem.log") `
                -RedirectStandardError (Join-Path $work "$stem-error.log")
            $deadline = [DateTime]::UtcNow.AddMinutes(3)
            while (!(Test-Path -LiteralPath $ready) -and !$benchmark.HasExited -and [DateTime]::UtcNow -lt $deadline) {
                Start-Sleep -Milliseconds 100
                $benchmark.Refresh()
            }
            if (!(Test-Path -LiteralPath $ready)) {
                $records.Add(@{ repeat = $repeat + 1; mode = $case.mode; fpsLimit = $case.fps;
                                status = 'unavailable'; reason = 'Presenter or map setup failed before measurement.' })
                $summary.Add("$stem : unavailable (presenter or map setup failed).")
                if (!$benchmark.HasExited) { $benchmark.Kill() }
                $benchmark = $null
                continue
            }
            $presentmonPath = Join-Path $bundle 'PresentMon.exe'
            if (Test-Path -LiteralPath $presentmonPath) {
                $presentmon = Start-Process -FilePath $presentmonPath -PassThru -WindowStyle Hidden `
                    -ArgumentList @('--process_id', $benchmark.Id, '--output_file', ('"' + $csv + '"'),
                        '--qpc_time', '--terminate_on_proc_exit', '--no_console_stats', '--session_name', "Bunnyhop-$stem") `
                    -RedirectStandardOutput (Join-Path $work "$stem-presentmon.log") `
                    -RedirectStandardError (Join-Path $work "$stem-presentmon-error.log")
                Start-Sleep -Seconds 2
            }
            Set-Content -LiteralPath $start -Value 'start' -Encoding ASCII
            if (!$benchmark.WaitForExit(300000)) { $benchmark.Kill(); throw 'Capture exceeded five minutes.' }
            $benchmark.Refresh()
            if ($presentmon) {
                if (!$presentmon.WaitForExit(10000)) { $presentmon.Kill() }
                $presentmon = $null
            }
            if ($benchmark.ExitCode -ne 0 -or !(Test-Path -LiteralPath $resultPath)) {
                throw "Capture $stem failed or was cancelled; no fallback result will be compared."
            }
            $benchmark = $null
            $result = Get-Content -Raw -LiteralPath $resultPath | ConvertFrom-Json
            $modes = Read-PresentModes $csv $result
            $result | Add-Member -NotePropertyName presentMode -NotePropertyValue $modes
            $result.PSObject.Properties.Remove('measuredQpcStart')
            $result.PSObject.Properties.Remove('measuredQpcEnd')
            $records.Add(@{ repeat = $repeat + 1; mode = $case.mode; fpsLimit = $case.fps; status = 'ok'; result = $result })
            $modesText = if ($modes.counts.Count) { ($modes.counts.Keys | Sort-Object) -join ', ' } else { 'unknown (ETW unavailable)' }
            Write-Host ("$stem : $($result.frame.fps) fps; $modesText")
        }
    }
    $report = @{ schema = 1; mapSha256 = (Get-FileHash -LiteralPath $mapPath -Algorithm SHA256).Hash.ToLowerInvariant();
        runs = $records; shaders = $shaderResult; method = 'Sequential matched frame-indexed camera; alternating case order; VSync off.' }
    $report | ConvertTo-Json -Depth 100 | Set-Content -Encoding UTF8 (Join-Path $outputPath 'measurement.json')
    foreach ($group in ($records | Where-Object { $_.status -eq 'ok' } | Group-Object mode, fpsLimit)) {
        $runs = @($group.Group)
        $p50 = @($runs | ForEach-Object { $_.result.frame.p50Ms } | Sort-Object)
        $p99 = @($runs | ForEach-Object { $_.result.frame.p99Ms } | Sort-Object)
        $worst = ($runs | ForEach-Object { $_.result.frame.maxMs } | Measure-Object -Maximum).Maximum
        $middle = [int][Math]::Floor($runs.Count / 2)
        $first = $runs[0]
        $modes = @($runs | ForEach-Object { $_.result.presentMode.counts.Keys } | Sort-Object -Unique)
        $modesText = if ($modes.Count) { $modes -join ', ' } else { 'mode unknown (ETW unavailable)' }
        $summary.Add(('{0}/{1}: median p50/p99 {2:F2}/{3:F2} ms; worst {4:F2} ms; {5}; {6}' -f `
            $first.mode, $first.fpsLimit, $p50[$middle], $p99[$middle], $worst, $first.result.presenter, $modesText))
    }
    $summary.Add('Software timings measure engine/driver intervals, not end-to-end click-to-photon latency.')
    $summary | Set-Content -Encoding UTF8 (Join-Path $outputPath 'summary.txt')
    $summary | ForEach-Object { Write-Host $_ }
    Write-Host "Share measurement.json and summary.txt from $outputPath"
} finally {
    if ($benchmark -and !$benchmark.HasExited) { $benchmark.Kill() }
    if ($presentmon -and !$presentmon.HasExited) { $presentmon.Kill() }
    Pop-Location
    Remove-Item -LiteralPath $work -Recurse -Force
}

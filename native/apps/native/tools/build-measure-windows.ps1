$ErrorActionPreference = 'Stop'
function Run([string]$Command, [string[]]$Arguments) {
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Command failed ($LASTEXITCODE)" }
}
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$vs = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (!$vs) { throw 'MSVC x64 tools unavailable.' }
$devcmd = Join-Path $vs 'Common7\Tools\VsDevCmd.bat'
& $env:COMSPEC /d /s /c "`"$devcmd`" -no_logo -arch=x64 -host_arch=x64 >nul && set" | ForEach-Object {
    if ($_ -match '^([^=]+)=(.*)$') { [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process') }
}
$vcpkg = Join-Path (Get-Location) 'target/native-deps/vcpkg'
Run 'git' @('clone', '--filter=blob:none', '--no-checkout', 'https://github.com/microsoft/vcpkg.git', $vcpkg)
Run 'git' @('-C', $vcpkg, 'checkout', '--detach', '8bd269459edab68222274040cb79608590b6c91e')
Run (Join-Path $vcpkg 'bootstrap-vcpkg.bat') @('-disableMetrics')
Run (Join-Path $vcpkg 'vcpkg.exe') @('install', 'curl:x64-windows', 'zlib:x64-windows', '--disable-metrics')
Run 'bun' @('apps/native/packaging/sdl.ts')
$sdl = Join-Path (Get-Location) 'target/native-deps/sdl/install'
$sdlConfig = (& bun apps/native/packaging/sdl.ts --print config).Trim()
if ($LASTEXITCODE -ne 0) { throw 'SDL config lookup failed.' }
$env:PATH = "$sdl/bin;$env:PATH"
Run 'cmake' @('-S', 'apps/native', '-B', 'apps/native/build', '-G', 'Ninja', '-DCMAKE_BUILD_TYPE=Release',
    "-DCMAKE_TOOLCHAIN_FILE=$vcpkg/scripts/buildsystems/vcpkg.cmake", '-DVCPKG_TARGET_TRIPLET=x64-windows',
    "-DCMAKE_PREFIX_PATH=$sdl", "-DSDL3_DIR=$sdlConfig", '-DBUILD_TESTING=ON')
Run 'bun' @('apps/native/build.ts', '--prebuilt-resources')
$bundle = Join-Path (Get-Location) 'target/renderer-measure-windows'
New-Item -ItemType Directory -Force "$bundle/target" | Out-Null
Copy-Item target/native-assets "$bundle/target/native-assets" -Recurse
Copy-Item apps/native/build/bunnyhop-native-gameplay-benchmark.exe $bundle
Copy-Item apps/native/build/bunnyhop-native-shader-benchmark.exe $bundle
Copy-Item apps/native/tools/measure-renderer.ps1 $bundle
Copy-Item docs/d3d11/measure.md $bundle
Copy-Item "$sdl/bin/*.dll" $bundle
Copy-Item "$vcpkg/installed/x64-windows/bin/*.dll" $bundle
New-Item -ItemType Directory -Force "$bundle/licenses" | Out-Null
Copy-Item apps/native/vendor/nvapi/LICENSE "$bundle/licenses/nvapi.txt"
Copy-Item apps/native/vendor/amd/LICENSE "$bundle/licenses/amd.txt"
Copy-Item "$vcpkg/installed/x64-windows/share" "$bundle/licenses/vcpkg" -Recurse
$sdlLicenses = (& bun apps/native/packaging/sdl.ts --print licenses).Trim()
Copy-Item $sdlLicenses "$bundle/licenses/sdl" -Recurse
$presentmon = "$bundle/PresentMon.exe"
Invoke-WebRequest 'https://github.com/GameTechDev/PresentMon/releases/download/v2.6.0/PresentMon-2.6.0-x64.exe' -OutFile $presentmon
if ((Get-FileHash $presentmon -Algorithm SHA256).Hash.ToLowerInvariant() -ne `
    'b2a706bc6ad475749e3b7e3409263aa1e6906d45bdcf993f6dbc0f660188f1af') { throw 'PresentMon hash mismatch.' }
Invoke-WebRequest 'https://raw.githubusercontent.com/GameTechDev/PresentMon/v2.6.0/LICENSE.txt' -OutFile "$bundle/licenses/PresentMon.txt"

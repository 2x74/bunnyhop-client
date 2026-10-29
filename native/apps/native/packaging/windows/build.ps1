# MSVC x64 build/package. All dependency sources are pinned; no credentials are required.
param([string]$Version = '0.0.1')
$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..\..'))
Set-Location $root
function Run([string]$Command, [string[]]$Arguments) { & $Command @Arguments; if ($LASTEXITCODE -ne 0) { throw "$Command failed ($LASTEXITCODE)" } }
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$vs = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (!$vs) { throw 'Install Visual Studio Build Tools with Desktop development with C++ and Windows SDK.' }
$devcmd = Join-Path $vs 'Common7\Tools\VsDevCmd.bat'
# Import the existing VS installation environment into this process, without persisting shell changes.
& $env:COMSPEC /d /s /c "`"$devcmd`" -no_logo -arch=x64 -host_arch=x64 >nul && set" | ForEach-Object { if ($_ -match '^([^=]+)=(.*)$') { [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process') } }
$revision = '8bd269459edab68222274040cb79608590b6c91e'
$vcpkg = Join-Path $root 'target\native-deps\vcpkg'
if (!(Test-Path (Join-Path $vcpkg '.git'))) { Run 'git' @('clone', '--filter=blob:none', '--no-checkout', 'https://github.com/microsoft/vcpkg.git', $vcpkg) }
Run 'git' @('-C', $vcpkg, 'checkout', '--detach', $revision)
if ((& git -C $vcpkg rev-parse HEAD).Trim() -ne $revision) { throw 'vcpkg revision mismatch' }
Run (Join-Path $vcpkg 'bootstrap-vcpkg.bat') @('-disableMetrics')
Run (Join-Path $vcpkg 'vcpkg.exe') @('install', 'curl:x64-windows', 'zlib:x64-windows', '--disable-metrics')
# SDL3 comes from the commit pinned in packaging/sdl.json, built the same way on every platform.
Run 'bun' @('apps/native/packaging/sdl.ts')
$sdl = Join-Path $root 'target\native-deps\sdl\install'
$sdlConfig = (& bun apps/native/packaging/sdl.ts --print config).Trim()
$sdlLicenses = (& bun apps/native/packaging/sdl.ts --print licenses).Trim()
# Tests and the game load SDL3.dll from the pinned install, not from vcpkg.
$env:PATH = "$sdl\bin;$env:PATH"
Run 'cmake' @('-S', 'apps/native', '-B', 'apps/native/build', '-G', 'Ninja', '-DCMAKE_BUILD_TYPE=Release', "-DCMAKE_TOOLCHAIN_FILE=$vcpkg/scripts/buildsystems/vcpkg.cmake", '-DVCPKG_TARGET_TRIPLET=x64-windows', "-DCMAKE_PREFIX_PATH=$sdl", "-DSDL3_DIR=$sdlConfig", '-DBUILD_TESTING=ON')
$required = @('target/native-menu/menu.html', 'target/native-menu/menu-manifest.json', 'target/native-assets/viewmodels.json', 'target/native-assets/viewmodels.bin.z', 'target/native-assets/actor-animations.json', 'target/native-assets/actor-animations.bin', 'target/native-assets/tp-inspects.json', 'target/native-assets/runner.json', 'target/native-assets/runner.bin', 'target/native-assets/hud.rgba', 'target/native-assets/audio.json', 'target/native-assets/tutorial.json')
$prebuilt = ($required | Where-Object { !(Test-Path -LiteralPath $_ -PathType Leaf) }).Count -eq 0
if ($prebuilt) { Run 'bun' @('apps/native/build.ts', '--prebuilt-resources') }
else {
    if (!(Get-Command ffmpeg -ErrorAction SilentlyContinue)) { throw 'Source asset generation requires ffmpeg on PATH; or provide complete prebuilt target/native-menu and target/native-assets resources.' }
    Run 'bun' @('apps/native/build.ts')
}
Run 'bun' @('apps/native/tools/parity-gate.ts')
Run 'bun' @('test', 'apps/native/tools/parity-gate.test.ts')
Run 'ctest' @('--test-dir', 'apps/native/build', '--output-on-failure', '--no-tests=error')
Run 'cargo' @('test', '-p', 'bunnyhop-native-bridge', '--locked')
Run 'cargo' @('test', '-p', 'bunnyhop-core', '--features', 'native-wasm-math', '--test', 'physics_versions', '--test', 'native_entities', '--test', 'native_render', '--locked')
Run 'bun' @('test', 'apps/native/packaging')
Run 'bun' @('apps/native/package.ts', '--skip-build', '--version', $Version, '--dependencies', "$sdl/bin", '--dependencies', "$vcpkg/installed/x64-windows/bin", '--licenses', $sdlLicenses, '--licenses', "$vcpkg/installed/x64-windows/share")

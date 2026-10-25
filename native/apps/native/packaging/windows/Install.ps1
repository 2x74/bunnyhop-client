# App-local dependencies and a per-user shortcut; no administrator privileges required.
$ErrorActionPreference = 'Stop'
$source = $PSScriptRoot
$destination = Join-Path $env:LOCALAPPDATA 'Programs\Bunnyhop Native'
if ((Read-Host "Install this downloaded bunnyhop.lol - Native package to $destination? Type YES") -cne 'YES') { exit 1 }
if (Test-Path -LiteralPath $destination) { throw 'An installation exists. Close the game and run its Uninstall.ps1 before installing this package.' }
New-Item -ItemType Directory -Path $destination | Out-Null
try {
    Get-ChildItem -LiteralPath $source -Force | Copy-Item -Destination $destination -Recurse -Force
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Programs')) 'bunnyhop.lol - Native.lnk'))
    $shortcut.TargetPath = Join-Path $destination 'bunnyhop-native.exe'
    $shortcut.IconLocation = (Join-Path $destination 'bunnyhop-native.exe') + ',0'
    $shortcut.Description = 'bunnyhop.lol - Native'
    $shortcut.WorkingDirectory = $destination; $shortcut.Save()
    Write-Host 'Installed. Launch bunnyhop.lol - Native from the Start menu. If menus report a missing WebView2 Runtime, run Install-WebView2.ps1.'
} catch { Remove-Item -LiteralPath $destination -Force -Recurse; throw }

$ErrorActionPreference = 'Stop'
$destination = Join-Path $env:LOCALAPPDATA 'Programs\Bunnyhop'
if ([System.IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\') -cne [System.IO.Path]::GetFullPath($destination).TrimEnd('\')) { throw 'Run Uninstall.ps1 from the installed per-user Bunnyhop directory.' }
if ((Read-Host 'Remove this Bunnyhop installation? Replays/account profile are kept. Type YES') -cne 'YES') { exit 1 }
Remove-Item -LiteralPath (Join-Path ([Environment]::GetFolderPath('Programs')) 'Bunnyhop.lnk') -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $destination -Recurse -Force

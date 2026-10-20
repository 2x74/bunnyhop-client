# Optional user-initiated installation. Never invoked automatically by the game/updater.
$ErrorActionPreference = 'Stop'
Write-Host 'Microsoft Edge WebView2 Evergreen Runtime is required for menus and account access.'
Write-Host 'Download source: https://go.microsoft.com/fwlink/p/?LinkId=2124703 (Microsoft official installer)'
if ((Read-Host 'Download, verify Microsoft signature, and install WebView2? Type YES') -cne 'YES') { exit 1 }
$installer = Join-Path ([System.IO.Path]::GetTempPath()) ('Bunnyhop-WebView2-' + [guid]::NewGuid() + '.exe')
try {
    Invoke-WebRequest -Uri 'https://go.microsoft.com/fwlink/p/?LinkId=2124703' -OutFile $installer -UseBasicParsing
    $signature = Get-AuthenticodeSignature -LiteralPath $installer
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation(?:,|$)') { throw 'WebView2 installer does not have a valid Microsoft Authenticode signature.' }
    $process = Start-Process -FilePath $installer -ArgumentList '/install' -PassThru -Wait
    if ($process.ExitCode -ne 0) { throw "WebView2 installer failed: $($process.ExitCode)" }
} finally { Remove-Item -LiteralPath $installer -Force -ErrorAction SilentlyContinue }

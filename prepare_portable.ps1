# One-time, on a machine WITH internet (e.g. home): bundles a portable
# Python into this folder so the target machine needs nothing installed.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$url = 'https://www.python.org/ftp/python/3.12.8/python-3.12.8-embed-amd64.zip'
$zip = Join-Path $PSScriptRoot 'python-embed.zip'
Write-Host "Downloading embeddable Python..."
Invoke-WebRequest -Uri $url -OutFile $zip
Expand-Archive -Path $zip -DestinationPath (Join-Path $PSScriptRoot 'py') -Force
Remove-Item $zip
Write-Host "Done. This folder is now fully portable - copy it anywhere and run START_MAP_GUI.bat"

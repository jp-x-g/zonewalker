@echo off
setlocal
cd /d "%~dp0"
if exist "py\python.exe" (
  echo Using bundled Python...
  "py\python.exe" server.py
  goto :end
)
where py >nul 2>nul && ( py -3 server.py & goto :end )
where python >nul 2>nul && ( python server.py & goto :end )
echo No Python found. Either install Python 3, or run prepare_portable.ps1
echo on a machine with internet to bundle Python into this folder.
pause
:end

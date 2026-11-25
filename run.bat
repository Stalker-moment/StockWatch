@echo off
setlocal
cd /d "%~dp0"
if not exist bin\StockWatchApi.exe goto missing
if not exist bin\StockWatch.exe goto missing
"%~dp0bin\StockWatch.exe" %*
exit /b %errorlevel%

:missing
echo Jalankan build.bat atau build workspace dari Code::Blocks dahulu.
exit /b 1

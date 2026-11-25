@echo off
setlocal
cd /d "%~dp0"
set "GXX="
if exist "%ProgramFiles%\CodeBlocks\MinGW\bin\g++.exe" set "GXX=%ProgramFiles%\CodeBlocks\MinGW\bin\g++.exe"
if not defined GXX if exist "%ProgramFiles(x86)%\CodeBlocks\MinGW\bin\g++.exe" set "GXX=%ProgramFiles(x86)%\CodeBlocks\MinGW\bin\g++.exe"
if not defined GXX for /f "usebackq delims=" %%A in (`where g++.exe 2^>nul`) do if not defined GXX set "GXX=%%A"
if not defined GXX (
    echo Compiler GCC tidak ditemukan. Gunakan Code::Blocks dengan MinGW atau tambahkan g++ ke PATH.
    exit /b 1
)
if not exist bin mkdir bin
echo Building StockWatchApi...
"%GXX%" -std=c++17 -Wall -Wextra -Ithird_party src\server.cpp src\market.cpp src\directory.cpp src\http.cpp -static -lwinhttp -lws2_32 -o bin\StockWatchApi.exe
if errorlevel 1 exit /b 1
echo Building StockWatch...
"%GXX%" -std=c++17 -Wall -Wextra -Ithird_party src\terminal.cpp src\dashboard.cpp src\portfolio.cpp src\http.cpp -static -lwinhttp -o bin\StockWatch.exe
if errorlevel 1 exit /b 1
echo Build selesai.

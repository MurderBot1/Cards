@echo off
:: Builds Binder (Release) if needed and starts it.
:: Needs CMake and Visual Studio 2019/2022 (or its Build Tools) with the "Desktop development with C++" workload.
:: See BUILDING.md for what the build downloads and how to run the tests.
setlocal enabledelayedexpansion

where cmake >nul 2>nul
if errorlevel 1 (
    echo CMake was not found on PATH. Install it from https://cmake.org/download/ ^(tick "Add CMake to the PATH"^).
    pause
    exit /b 1
)

:: Find a Visual Studio with the C++ compiler, so CMake is told which one to use instead of guessing (it falls back to
:: NMake, which then fails, when it can't find one from a plain terminal).
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
set "GENERATOR="
if exist "%VSWHERE%" (
    for /f "usebackq delims=" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property catalog_productLineVersion`) do set "VSYEAR=%%i"
)
if "%VSYEAR%"=="2022" set "GENERATOR=Visual Studio 17 2022"
if "%VSYEAR%"=="2019" set "GENERATOR=Visual Studio 16 2019"
if "%GENERATOR%"=="" (
    echo.
    echo No Visual Studio with the C++ tools was found ^(2019 or 2022 needed^).
    echo Install "Build Tools for Visual Studio 2022" from https://visualstudio.microsoft.com/downloads/
    echo and tick the "Desktop development with C++" workload, then run this again.
    pause
    exit /b 1
)

:: A configure that failed with another generator ^(e.g. NMake^) leaves a cache that CMake refuses to reuse.
if exist build\native\CMakeCache.txt (
    findstr /c:"CMAKE_GENERATOR:INTERNAL=%GENERATOR%" build\native\CMakeCache.txt >nul
    if errorlevel 1 rmdir /s /q build\native
)

cmake -S native -B build\native -G "%GENERATOR%" -A x64
if errorlevel 1 (
    echo CMake configure failed!
    pause
    exit /b 1
)
cmake --build build\native --config Release --parallel
if errorlevel 1 (
    echo Build failed!
    pause
    exit /b 1
)
echo Starting Binder...
build\native\bin\Release\binder.exe
pause

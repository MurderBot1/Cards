@echo off
:: Builds Binder (Release) if needed and starts it.
:: Needs CMake and a C++ compiler: Visual Studio 2019/2022 (or its Build Tools) with the "Desktop development with C++"
:: workload, or - as a fallback when there is none - GCC (MinGW-w64) plus Ninja or mingw32-make, all on PATH.
:: See BUILDING.md for what the build downloads and how to run the tests.
setlocal

where cmake >nul 2>nul
if errorlevel 1 (
    echo CMake was not found on PATH. Install it from https://cmake.org/download/ ^(tick "Add CMake to the PATH"^).
    pause
    exit /b 1
)

:: Prefer Visual Studio. Find one with the C++ compiler, so CMake is told which one to use instead of guessing (it
:: falls back to NMake, which then fails, when it can't find one from a plain terminal).
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
set "VSYEAR="
set "GENERATOR="
if exist "%VSWHERE%" (
    for /f "usebackq delims=" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property catalog_productLineVersion`) do set "VSYEAR=%%i"
)
if "%VSYEAR%"=="2022" set "GENERATOR=Visual Studio 17 2022"
if "%VSYEAR%"=="2019" set "GENERATOR=Visual Studio 16 2019"

set "CONFIG_ARGS=-A x64"
set "BUILD_ARGS=--config Release"
set "BINARY=build\native\bin\Release\binder.exe"

:: Fallback: GCC from MinGW-w64 (flat gotos rather than nested blocks: a variable set inside a block isn't visible to the
:: rest of that block in batch).
if not "%GENERATOR%"=="" goto have_generator
where g++ >nul 2>nul
if errorlevel 1 goto have_generator
where ninja >nul 2>nul
if not errorlevel 1 set "GENERATOR=Ninja"
if not "%GENERATOR%"=="" goto gcc_selected
where mingw32-make >nul 2>nul
if not errorlevel 1 set "GENERATOR=MinGW Makefiles"
if "%GENERATOR%"=="" goto have_generator
:gcc_selected
echo No Visual Studio found - building with GCC ^(%GENERATOR%^).
set "CONFIG_ARGS=-DCMAKE_BUILD_TYPE=Release -DCMAKE_C_COMPILER=gcc -DCMAKE_CXX_COMPILER=g++"
set "BUILD_ARGS="
set "BINARY=build\native\bin\binder.exe"
:have_generator

if "%GENERATOR%"=="" (
    echo.
    echo No C++ compiler was found. Either:
    echo   - install "Build Tools for Visual Studio 2022" from https://visualstudio.microsoft.com/downloads/
    echo     and tick the "Desktop development with C++" workload, or
    echo   - put GCC ^(MinGW-w64, e.g. from https://www.msys2.org/^) and Ninja or mingw32-make on PATH.
    echo Then run this again.
    pause
    exit /b 1
)

:: A configure that failed with another generator ^(e.g. NMake^) leaves a cache that CMake refuses to reuse.
if exist build\native\CMakeCache.txt (
    findstr /c:"CMAKE_GENERATOR:INTERNAL=%GENERATOR%" build\native\CMakeCache.txt >nul
    if errorlevel 1 rmdir /s /q build\native
)

cmake -S native -B build\native -G "%GENERATOR%" %CONFIG_ARGS%
if errorlevel 1 (
    echo CMake configure failed!
    pause
    exit /b 1
)
cmake --build build\native %BUILD_ARGS% --parallel
if errorlevel 1 (
    echo Build failed!
    pause
    exit /b 1
)
echo Starting Binder...
%BINARY%
pause

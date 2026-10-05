@echo off
:: Builds Binder (Release) if needed and starts it. Needs CMake and a C++ compiler (Visual Studio Build Tools) on PATH.
:: See BUILDING.md for what the build downloads and how to run the tests.
cmake -S native -B build\native -DCMAKE_BUILD_TYPE=Release
if %errorlevel% neq 0 (
    echo CMake configure failed!
    pause
    exit /b %errorlevel%
)
cmake --build build\native --config Release --parallel
if %errorlevel% neq 0 (
    echo Build failed!
    pause
    exit /b %errorlevel%
)
echo Starting Binder...
build\native\bin\Release\binder.exe
pause

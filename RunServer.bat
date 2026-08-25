@echo off

:: Navigate into the server directory
cd server

:: Generate Ninja build files
premake5 ninja
if %errorlevel% neq 0 (
    echo Premake failed!
    pause
    exit /b %errorlevel%
)

:: Build the project using Ninja
ninja -C build Release
if %errorlevel% neq 0 (
    echo Ninja build failed!
    pause
    exit /b %errorlevel%
)

:: Run the compiled executable
.\build\bin\Release\Server.exe

pause
@echo off

:: Open RunServer.bat in a new Command Prompt window
start "Server" RunServer.bat

:: Run RunApp.bat in the current window
call RunApp.bat
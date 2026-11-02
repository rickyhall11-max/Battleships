@echo off
title Battleships Tactical Command Center
echo ==================================================================
echo    ⚓  BATTLESHIPS COMMAND CENTER - LAUNCHING HOME SERVER  ⚓
echo ==================================================================
cd /d "%~dp0"

echo Compiling Java Server...
javac -d bin src\BattleshipsServer.java
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Compilation failed! Ensure Java 21 or newer is installed.
    pause
    exit /b %ERRORLEVEL%
)

echo Starting Server on 0.0.0.0:8765...
java -cp bin BattleshipsServer 8765
pause


@echo off
cd /d "%~dp0"
where py >nul 2>nul
if errorlevel 1 (
  echo Python 3 is not installed or not available in PATH.
  echo Install Python from https://www.python.org/downloads/windows/
  pause
  exit /b 1
)
py -m pip install -r requirements.txt
if errorlevel 1 (
  echo Failed to install required packages.
  pause
  exit /b 1
)
py agent.py
pause

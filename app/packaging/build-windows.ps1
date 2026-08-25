# packaging/build-windows.ps1
# Run from PowerShell, from anywhere: .\packaging\build-windows.ps1
$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot

python -m pip install --upgrade pip
pip install -r (Join-Path $RepoRoot "backend\requirements.txt")
pip install -r (Join-Path $RepoRoot "packaging\requirements-build.txt")

python (Join-Path $RepoRoot "packaging\build.py")
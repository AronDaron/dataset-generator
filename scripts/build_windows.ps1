# Dataset Generator — Windows build script (Faza 7)
#
# Usage (PowerShell in repo root):
#   .\scripts\build_windows.ps1
#
# If execution policy blocks: powershell -ExecutionPolicy Bypass -File scripts\build_windows.ps1
#
# Produces: DatasetGenerator-windows-x64.zip in the repo root.
# First run: ~8–12 minutes (npm ci + venv + PyInstaller).
# Repeat runs: ~2 minutes.

$ErrorActionPreference = "Stop"
$ROOT = Split-Path -Parent $PSScriptRoot
Set-Location $ROOT

Write-Host ""
Write-Host "=== Dataset Generator — Windows build ===" -ForegroundColor Cyan
Write-Host ""

# --- 1/6 Frontend static export ---
Write-Host "[1/6] Building frontend (npm run build)..." -ForegroundColor Yellow
Push-Location frontend
if (-not (Test-Path "node_modules")) {
    npm ci
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }
}
npm run build
if ($LASTEXITCODE -ne 0) { throw "npm run build failed" }
Pop-Location
if (-not (Test-Path "frontend\out")) { throw "frontend\out was not produced" }

# --- 2/6 Python venv ---
Write-Host "[2/6] Preparing Python venv..." -ForegroundColor Yellow
if (-not (Test-Path "backend\venv")) {
    python -m venv backend\venv
    if ($LASTEXITCODE -ne 0) { throw "python -m venv failed — is Python on PATH?" }
}
$pip = "backend\venv\Scripts\pip.exe"
$py  = "backend\venv\Scripts\python.exe"
& $pip install --upgrade pip --quiet
& $pip install -r backend\requirements.txt --quiet
if ($LASTEXITCODE -ne 0) { throw "pip install -r requirements failed" }

# --- 3/6 Icon (PNG → ICO) ---
Write-Host "[3/6] Generating ICO from logo.png..." -ForegroundColor Yellow
& $py scripts\prepare_icon.py
if ($LASTEXITCODE -ne 0) { throw "prepare_icon.py failed" }

# --- 4/6 Clean previous builds ---
Write-Host "[4/6] Cleaning previous build artefacts..." -ForegroundColor Yellow
if (Test-Path "dist")  { Remove-Item -Recurse -Force dist }
if (Test-Path "build") { Remove-Item -Recurse -Force build }

# --- 5/6 PyInstaller ---
Write-Host "[5/6] Running PyInstaller (this takes a few minutes)..." -ForegroundColor Yellow
& "backend\venv\Scripts\pyinstaller.exe" dataset_generator.spec --noconfirm
if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed" }
if (-not (Test-Path "dist\DatasetGenerator\DatasetGenerator.exe")) {
    throw "Expected dist\DatasetGenerator\DatasetGenerator.exe was not produced"
}

# --- 6/6 Package as ZIP ---
Write-Host "[6/6] Compressing to ZIP..." -ForegroundColor Yellow
$zipName = "DatasetGenerator-windows-x64.zip"
if (Test-Path $zipName) { Remove-Item $zipName }
Compress-Archive -Path "dist\DatasetGenerator" -DestinationPath $zipName -CompressionLevel Optimal

$zipSize = [Math]::Round((Get-Item $zipName).Length / 1MB, 1)
Write-Host ""
Write-Host "=== DONE ===" -ForegroundColor Green
Write-Host "Output: $zipName ($zipSize MB)" -ForegroundColor Green
Write-Host ""
Write-Host "To test:" -ForegroundColor Cyan
Write-Host "  1. Extract the ZIP somewhere (e.g. C:\Temp\DG\)"
Write-Host "  2. Double-click DatasetGenerator.exe inside the extracted folder"
Write-Host "  3. First run: SmartScreen may warn — 'More info' -> 'Run anyway'"
Write-Host ""

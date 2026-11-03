Write-Host "========================================" -ForegroundColor Cyan
Write-Host " FertiLedger ERP - Phase 9 Push Script  " -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

Set-Location "D:\FertiLedger ERP"

# STEP 1: TypeScript Check
Write-Host "=== STEP 1: TypeScript Check ===" -ForegroundColor Yellow
$tsResult = npx tsc --noEmit 2>&1
if ($LASTEXITCODE -eq 0) {
    Write-Host "TypeScript: CLEAN" -ForegroundColor Green
} else {
    Write-Host "TypeScript ERRORS:" -ForegroundColor Red
    Write-Host $tsResult
    Write-Host "Aborting push due to TypeScript errors." -ForegroundColor Red
    exit 1
}
Write-Host ""

# STEP 2: Vitest
Write-Host "=== STEP 2: Vitest ===" -ForegroundColor Yellow
npx vitest run
if ($LASTEXITCODE -ne 0) {
    Write-Host "Tests FAILED. Aborting push." -ForegroundColor Red
    exit 1
}
Write-Host "Tests: PASSED" -ForegroundColor Green
Write-Host ""

# STEP 3: Git Commit + Push
Write-Host "=== STEP 3: Git Commit + Push ===" -ForegroundColor Yellow
git add -A
git status
$commitMessage = 'feat(phase9): Inventory Module - Stock Ledger, Batch Register, Stock Adjustments, Transfer Log'
git commit -m $commitMessage
git push upstream main

Write-Host ""
Write-Host "=== Last 5 commits ===" -ForegroundColor Cyan
git log --oneline -5
Write-Host ""
Write-Host "Phase 9 complete!" -ForegroundColor Green

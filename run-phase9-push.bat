@echo off
echo ========================================
echo  FertiLedger ERP - Phase 9 Push Script  
echo ========================================
echo.

cd /d "D:\FertiLedger ERP"

echo === STEP 1: TypeScript Check ===
call npx tsc --noEmit
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] TypeScript compilation failed!
    exit /b %ERRORLEVEL%
)
echo TypeScript: CLEAN
echo.

echo === STEP 2: Vitest ===
call npx vitest run
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Tests failed!
    exit /b %ERRORLEVEL%
)
echo Tests: PASSED
echo.

echo === STEP 3: Git Commit + Push ===
git add -A
git status
git commit -m "feat(phase9): Inventory Module - Stock Ledger, Batch Register, Stock Adjustments, Transfer Log"
git push upstream main

echo.
echo === Last 5 commits ===
git log --oneline -5
echo.
echo Phase 9 complete!

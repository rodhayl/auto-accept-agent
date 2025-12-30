@echo off
setlocal
echo Building Auto Accept Agent...

echo Installing dependencies...
if exist package-lock.json (
call npm ci --no-audit --no-fund
) else (
call npm install --no-audit --no-fund
)
if %errorlevel% neq 0 exit /b %errorlevel%

echo Compiling extension...
call npm run compile
if %errorlevel% neq 0 exit /b %errorlevel%

echo Packaging VSIX...
set GIT_PAGER=
set PAGER=
set LESS=
call npx vsce package --no-git-tag-version
if %errorlevel% neq 0 exit /b %errorlevel%

echo Build complete!
endlocal

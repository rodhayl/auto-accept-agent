@echo off
echo Building Multi Purpose Agent 7.1.2-david...

echo Installing dependencies...
call npm install
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

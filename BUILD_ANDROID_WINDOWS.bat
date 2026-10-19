@echo off
chcp 65001 >nul
cd /d "%~dp0"
where flutter >nul 2>&1
if errorlevel 1 (
 echo [ERROR] Flutter SDK not installed. Build cannot proceed.
 echo Install Flutter and Android Studio on a Windows PC first.
 pause
 exit /b 1
)
where python >nul 2>&1
if errorlevel 1 (
 echo [ERROR] Python is required for Android platform configuration.
 pause
 exit /b 1
)
call flutter create --project-name soul_reader --org com.soulreader --platforms android .
if errorlevel 1 goto fail
python scripts\configure_platforms.py
if errorlevel 1 goto fail
call flutter pub get
if errorlevel 1 goto fail
call flutter analyze
if errorlevel 1 goto fail
call flutter build apk --debug
if errorlevel 1 goto fail
echo.
echo APK ready: build\app\outputs\flutter-apk\app-debug.apk
pause
exit /b 0
:fail
echo Build failed. Check messages above.
pause
exit /b 1

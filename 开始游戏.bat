@echo off
chcp 65001 >nul
cd /d "%~dp0"
set PORT=8124
set PAGE=index.html

echo.
echo   Fruit Ninja（M5StickS3 体感版）- 本地服务
echo   地址: http://localhost:%PORT%/%PAGE%
echo   关掉这个窗口即停止服务
echo.

where py >nul 2>nul && goto usepy
where python >nul 2>nul && goto usepy2
where node >nul 2>nul && goto usenode
goto nofound

:usepy
start "M5 Game Server" py -3 -m http.server %PORT%
goto opened

:usepy2
start "M5 Game Server" python -m http.server %PORT%
goto opened

:usenode
start "M5 Game Server" node server.js
goto opened

:nofound
echo   没找到 Python 或 Node，起不了本地服务。
echo   原版游戏必须走 http 打开，直接双击 html 会加载失败。
echo.
pause
exit /b

:opened
timeout /t 2 >nul
start "" "http://localhost:%PORT%/%PAGE%"
exit /b

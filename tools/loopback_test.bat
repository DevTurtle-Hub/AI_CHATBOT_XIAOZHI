@echo off
cd /d "%~dp0.."
echo ============================================================
echo   XIAOXI I PH benches - ANHEN I LOOPBACK TEST AM THANH
echo   1. Tat run_xiaoxi.bat di (nhung robot VAN bat)
echo   2. Cua do nhac robot: noi giong minh 3-5 giay roi nghi
echo   3. Robot se phat lai giong anh - nghe thong minh chat
echo ============================================================
node tools\loopback_test.js
pause

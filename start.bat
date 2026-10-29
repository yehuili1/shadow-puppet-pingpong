@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 指尖皮影剧场：http://localhost:8765/index.html
echo （需要 Python 3；关闭本窗口即停止服务）
rem 找 Python：python 不行再试 py 启动器（python.org 安装时没勾 Add to PATH 就只有 py）
set "PY="
python -c "import sys" >nul 2>&1 && set "PY=python"
if not defined PY py -3 -c "import sys" >nul 2>&1 && set "PY=py -3"
if not defined PY goto nopy
rem 8765 已被占用就停下：Windows 上 http.server 能重复绑定同一端口，浏览器会一直打开旧服务
%PY% -c "import socket,sys;s=socket.socket();s.settimeout(0.5);sys.exit(s.connect_ex(('127.0.0.1',8765))==0)" || goto busy
rem 等服务起来约 1 秒后再打开浏览器
start "" /b cmd /c "ping -n 2 127.0.0.1 >nul & start http://localhost:8765/index.html"
%PY% -m http.server 8765
if errorlevel 1 pause
exit /b

:nopy
echo 未找到 Python 3：请到 python.org 安装，安装时勾选 Add python.exe to PATH
pause
exit /b 1

:busy
echo 8765 端口已被占用（多半是之前打开的黑色窗口还在运行），请先关闭它再双击本文件
pause
exit /b 1

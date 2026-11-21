@echo off
chcp 65001 >nul
set ELECTRON_RUN_AS_NODE=
rem 若已用 npm 安装 electron，直接用 node_modules 里的可执行文件
if exist "%~dp0node_modules\electron\dist\electron.exe" (
  start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0app" --disable-gpu --no-sandbox
) else (
  echo [提示] 未找到 Electron 运行时。
  echo 请先在本目录执行：npm install electron
  echo 或自行下载 Electron 解压到本目录后，把 electron.exe 放到 node_modules\electron\dist\ 下。
  pause
)

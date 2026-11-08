@echo off
chcp 65001 >nul
rem 用脚本自身位置回到项目根，避免把盘符和绝对路径写进仓库
cd /d "%~dp0.."

rem 缺依赖或构建产物时先补齐，让双击在干净环境下也能起来
where npm >nul 2>&1
if errorlevel 1 (
  echo 没有找到 Node.js，请先安装 Node.js 后再试。
  pause
  exit /b 1
)

if not exist "node_modules\electron\dist\electron.exe" (
  echo 首次启动，正在安装依赖，请稍候……
  call npm install
  if errorlevel 1 (
    echo 依赖安装失败，请查看上面的报错。
    pause
    exit /b 1
  )
)

if not exist "out\main\index.js" (
  echo 正在构建应用，请稍候……
  call npm run build
  if errorlevel 1 (
    echo 构建失败，请查看上面的报错。
    pause
    exit /b 1
  )
)

rem 用 start 让控制台立即关闭，只留下应用窗口
start "" "node_modules\electron\dist\electron.exe" .
exit /b 0

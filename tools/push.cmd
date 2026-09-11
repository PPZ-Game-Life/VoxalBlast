@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

rem =====================================================================
rem  VoxalBlast 受控推送脚本（agent 与本机终端共用）
rem
rem  用法：
rem    tools\push.cmd                  推送 main 到 origin
rem    tools\push.cmd <branch>         推送指定分支
rem    tools\push.cmd main --pause     结束后暂停（双击运行时用）
rem
rem  退出码：0 成功 / 1 其他失败 / 2 沙箱拦截 / 3 网络不通 / 4 凭据问题
rem
rem  为什么这么写：
rem   - 只用明文凭据存储 %USERPROFILE%\.git-credentials 并显式重置 helper 链，
rem     绕开 GCM/wincredman（在沙箱下必定失败并打印 fatal 噪音）。
rem   - 输出重定向到文件而不是管道：沙箱禁止创建跨进程管道，
rem     `git push | Out-Null` 这类写法会连带失败。
rem   - 失败按 沙箱/网络/凭据 三类归因，直接给出下一步动作。
rem =====================================================================

set "BRANCH=%~1"
if "%BRANCH%"=="" set "BRANCH=main"
if /i "%BRANCH%"=="--pause" set "BRANCH=main"
set "REMOTE=origin"
set "ATTEMPTS=3"
set "DELAY=8"
if "%TEMP%"=="" set "TEMP=%CD%\.tmp"
set "OUT=%TEMP%\voxalblast-push.log"
set "CODE="

set "REPO=%~dp0.."
cd /d "%REPO%" 2>nul
if errorlevel 1 (
  echo [ERROR] 无法进入仓库目录: %REPO%
  set "CODE=1"
  goto done
)

where git >nul 2>nul
if errorlevel 1 (
  echo [ERROR] 找不到 git，请检查 PATH。
  set "CODE=1"
  goto done
)

set "GIT_TERMINAL_PROMPT=0"
set "CRED=-c credential.helper= -c credential.helper=store"

echo === VoxalBlast push: %REMOTE%/%BRANCH% ===
echo 仓库: %CD%
if not exist "%USERPROFILE%\.git-credentials" echo [提示] 未发现 %%USERPROFILE%%\.git-credentials，若报凭据错误请先配置。

git %CRED% fetch %REMOTE% %BRANCH% --quiet >"%OUT%" 2>&1
git rev-list --count %REMOTE%/%BRANCH%..HEAD >"%TEMP%\vb-ahead.txt" 2>nul
set "AHEAD="
set /p AHEAD=<"%TEMP%\vb-ahead.txt"
if "%AHEAD%"=="" set "AHEAD=?"
echo 待推送提交: %AHEAD%
if "%AHEAD%"=="0" (
  echo [OK] 本地已与 %REMOTE%/%BRANCH% 同步，无需推送。
  set "CODE=0"
  goto done
)

set /a TRY=0
:attempt
set /a TRY+=1
echo --- 第 %TRY%/%ATTEMPTS% 次推送 ---
git %CRED% push %REMOTE% %BRANCH% >"%OUT%" 2>&1
set "RC=%ERRORLEVEL%"
type "%OUT%"
if "%RC%"=="0" goto verify

set "CODE=1"
findstr /C:"cannot create standard input pipe" /C:"Permission denied" "%OUT%" >nul && set "CODE=2"
if "!CODE!"=="1" findstr /C:"Recv failure" /C:"Couldn't connect" /C:"Connection was reset" /C:"RPC failed" /C:"Failed to connect" /C:"Operation timed out" "%OUT%" >nul && set "CODE=3"
if "!CODE!"=="1" findstr /C:"could not read Username" /C:"Authentication failed" /C:"wincredman" /C:"Invalid username or password" /C:"publickey" "%OUT%" >nul && set "CODE=4"

if "!CODE!"=="2" goto done
if %TRY% LSS %ATTEMPTS% (
  echo 第 %TRY% 次失败（分类码 !CODE!），%DELAY% 秒后重试...
  ping -n %DELAY% 127.0.0.1 >nul 2>&1
  goto attempt
)
goto done

:verify
git %CRED% fetch %REMOTE% %BRANCH% --quiet >nul 2>&1
git rev-parse HEAD >"%TEMP%\vb-head.txt" 2>nul
git rev-parse %REMOTE%/%BRANCH% >"%TEMP%\vb-remote.txt" 2>nul
set "H="
set "R="
set /p H=<"%TEMP%\vb-head.txt"
set /p R=<"%TEMP%\vb-remote.txt"
if /i "%H%"=="%R%" (
  echo [OK] 推送成功：%REMOTE%/%BRANCH% = %H%
  set "CODE=0"
) else (
  echo [WARN] push 退出码为 0，但本地 %H% 与远端 %R% 不一致，请人工复核。
  set "CODE=1"
)
goto done

:done
del "%TEMP%\vb-ahead.txt" "%TEMP%\vb-head.txt" "%TEMP%\vb-remote.txt" >nul 2>nul
if "%CODE%"=="" set "CODE=1"
echo.
if "%CODE%"=="2" (
  echo [沙箱拦截] DSH 沙箱禁止 git 创建 remote-https 的网络管道（stdin pipe）。
  echo   - 在 DSH 会话里：带 sandbox_permissions=danger-full-access 重跑本脚本（会弹一次授权）。
  echo   - 在本机终端：直接运行不受影响。
)
if "%CODE%"=="3" (
  echo [网络不通] 到 github.com 的连接被重置或超时。
  echo   - 开 Clash Verge 后执行一次：
  echo       git config --global http.https://github.com/.proxy http://127.0.0.1:7897
  echo   - 并确认 127.0.0.1:7897 正在监听。
)
if "%CODE%"=="4" (
  echo [凭据问题] git 读不到 GitHub 凭据。
  echo   - 检查 %%USERPROFILE%%\.git-credentials 内容形如 https://archerdante:TOKEN@github.com
  echo   - PAT 过期或被撤销时，到 https://github.com/settings/personal-access-tokens 重新生成，只替换这一行。
)
echo 退出码 %CODE%（0 成功 / 1 其他失败 / 2 沙箱拦截 / 3 网络不通 / 4 凭据问题）
if /i "%~2"=="--pause" pause
exit /b %CODE%

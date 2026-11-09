<#
  V1.0 干净机验收脚本（2026-11-09 已在干净 Win10 虚拟机执行；首轮三项断言按实测修正）

  为什么默认不动作：工程规范 §3.5 规定「在开发机上跑的一律不算真机验收」，
      而安装 / 卸载会改系统状态。所以不带 -Run 时只做环境预检并打印验收清单，
      不执行任何安装、启动或卸载。

  为什么卸载要单独确认：卸载属于会改变系统状态的动作，按发布验证手册的破坏性前置，
      必须显式给 -ConfirmUninstall 才执行；脚本只调用安装包自带的卸载程序，
      不清理用户数据（规划 §7.8-5、偏离 9.2：卸载默认保留数据库与已下载素材）。

  为什么分 auto / manual：需求九节里有需要人点击的演示项（例如「全程不切窗口」），
      脚本无法替人点。这类项按「点哪里 / 看到什么 / 失败长什么样」列出，
      结果记 MANUAL，不混进 PASS 分母，避免用「页面能开」冒充验收。

  兼容性：只用 PowerShell 5.1 自带命令，虚拟机里不用装 Node / FFmpeg / 任何依赖。
      干净机本来就要求系统里没有这些，CDP 界面断言由开发机侧远程连 9222 端口完成。

  用法示例（在干净 Win10 里，以管理员身份）：
      powershell -ExecutionPolicy Bypass -File .\v1-clean-machine.ps1 -InstallerPath D:\Kithoard-Setup-1.0.0-x64.exe -Version 1.0.0
      powershell -ExecutionPolicy Bypass -File .\v1-clean-machine.ps1 -InstallerPath D:\Kithoard-Setup-1.0.0-x64.exe -Version 1.0.0 -ExpectedSha256 <哈希> -Run -ConfirmUninstall
#>
[CmdletBinding()]
param(
  [string]$InstallerPath = '',
  [string]$Version = '',
  [string]$ExpectedSha256 = '',
  [string]$WorkDir = (Join-Path $env:TEMP 'kithoard-v1-verify'),
  [switch]$Run,
  [switch]$ConfirmUninstall
)

$ErrorActionPreference = 'Stop'

# 版本号不写死：开发机侧可从 package.json 读，虚拟机侧由远程调用传入
if (-not $Version) {
  $pkg = Join-Path (Split-Path -Parent $PSScriptRoot) 'package.json'
  if (Test-Path $pkg) { $Version = (Get-Content -Raw -Encoding UTF8 $pkg | ConvertFrom-Json).version }
}
if (-not $Version) { $Version = '<未指定>' }

$script:InstallDir = ''
$script:UninstallExe = ''
$script:AppExe = ''
$script:InstallExitCode = $null
$script:AppProcess = $null

# 从卸载注册表反查真实安装目录：用户可能改过安装路径，写死 $LOCALAPPDATA 会误判
function Resolve-InstallInfo {
  $keys = @(
    'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
  )
  foreach ($key in $keys) {
    $hit = Get-ItemProperty -Path $key -ErrorAction SilentlyContinue |
      Where-Object { $_.DisplayName -like 'Kithoard*' } | Select-Object -First 1
    if ($hit) {
      $script:InstallDir = $hit.InstallLocation
      if (-not $script:InstallDir -and $hit.DisplayIcon) {
        # DisplayIcon 常写成「路径,0」，先去掉逗号后的索引和引号再取目录
        $script:InstallDir = Split-Path -Parent (($hit.DisplayIcon -split ',')[0].Trim('"'))
      }
      if ($hit.UninstallString) {
        $script:UninstallExe = ($hit.UninstallString -replace '^"([^"]+)".*$', '$1').Trim()
      }
      break
    }
  }
  if ($script:InstallDir) {
    $script:AppExe = Join-Path $script:InstallDir 'Kithoard.exe'
    if (-not $script:UninstallExe) {
      $script:UninstallExe = Join-Path $script:InstallDir 'Uninstall Kithoard.exe'
    }
  }
}

function Test-NoFfmpegInPath {
  # 干净机不能自带 FFmpeg，否则「二进制随包、不依赖系统 PATH」这条就验不出来
  $names = @('ffmpeg.exe', 'ffprobe.exe')
  foreach ($name in $names) { if (Get-Command $name -ErrorAction SilentlyContinue) { return $false } }
  return $true
}

# 统一断言表：Mode 决定执行阶段，Test 收敛成一个判定块，
# 这样每加一条检查只需补一行数据，不用重复写结果汇总逻辑
$Checks = @(
  @{ Id='C01'; Stage='pre'; Mode='auto'; Title='系统是 Windows 10';
     Point='读取 Win32_OperatingSystem.Caption'; Expect='包含 Windows 10';
     Fail='显示 Windows 11 / Server，或读取失败';
     Test={ (Get-CimInstance Win32_OperatingSystem).Caption -like '*Windows 10*' } },
  @{ Id='C02'; Stage='pre'; Mode='auto'; Title='没装过 Kithoard';
     Point='查三处卸载注册表'; Expect='找不到 Kithoard 条目';
     Fail='查到旧条目，说明不是干净机';
     Test={ $found = $false; foreach ($k in @('HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*')) { if (Get-ItemProperty -Path $k -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'Kithoard*' }) { $found = $true } }; -not $found } },
  @{ Id='C03'; Stage='pre'; Mode='auto'; Title='没有旧用户数据';
     Point='查 %APPDATA%\Kithoard'; Expect='目录不存在';
     Fail='存在旧数据库或素材，需换一台干净虚拟机';
     Test={ -not (Test-Path (Join-Path $env:APPDATA 'Kithoard')) } },
  @{ Id='C04'; Stage='pre'; Mode='auto'; Title='系统 PATH 里没有 FFmpeg';
     Point='Get-Command ffmpeg.exe / ffprobe.exe'; Expect='两者都找不到';
     Fail='找到了系统级 FFmpeg，随包验证会被污染';
     Test={ Test-NoFfmpegInPath } },
  @{ Id='C05'; Stage='pre'; Mode='auto'; Title='安装包存在';
     Point='检查 -InstallerPath 文件'; Expect='文件存在且是 .exe';
     Fail='路径写错或附件没拷进虚拟机';
     Test={ $InstallerPath -and (Test-Path $InstallerPath) } },
  @{ Id='C06'; Stage='pre'; Mode='auto'; Title='安装包哈希与 Release 一致';
     Point='Get-FileHash SHA256'; Expect='与 -ExpectedSha256 相同（不给则跳过）';
     Fail='哈希不符，装的不是验过的那一份';
     Test={ if (-not $ExpectedSha256) { return $true }; if (-not (Test-Path $InstallerPath)) { return $false }; (Get-FileHash -Algorithm SHA256 $InstallerPath).Hash -ieq $ExpectedSha256 } },

  @{ Id='I01'; Stage='install'; Mode='auto'; Title='静默安装成功';
     Point='安装包 /S 退出码'; Expect='退出码 0';
     Fail='安装报错或中途退出';
     Test={ $script:InstallExitCode -eq 0 } },
  @{ Id='I02'; Stage='install'; Mode='auto'; Title='主程序落盘';
     Point='检查 Kithoard.exe'; Expect='文件存在';
     Fail='安装目录没有可执行文件';
     Test={ $script:AppExe -and (Test-Path $script:AppExe) } },
  @{ Id='I03'; Stage='install'; Mode='auto'; Title='版本号一致';
     Point='读 Kithoard.exe 的 ProductVersion'; Expect='等于 -Version 或补了第四段（如 0.6.0.0）';
     Fail='装到的是别的版本';
     Test={ if (-not (Test-Path $script:AppExe)) { return $false }; $pv = (Get-Item $script:AppExe).VersionInfo.ProductVersion; $pv -eq $Version -or $pv -like ($Version + '.*') } },
  @{ Id='I04'; Stage='install'; Mode='auto'; Title='快捷方式已创建';
     Point='查桌面与开始菜单'; Expect='至少一处存在 Kithoard 快捷方式';
     Fail='安装包装完没建快捷方式，与 §7.8-4 不符';
     Test={ $paths = @((Join-Path $env:USERPROFILE 'Desktop'), (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs')); $ok = $false; foreach ($p in $paths) { if (Test-Path $p) { if (Get-ChildItem -Path $p -Filter '*Kithoard*.lnk' -ErrorAction SilentlyContinue) { $ok = $true } } }; $ok } },
  @{ Id='I05'; Stage='install'; Mode='auto'; Title='应用能启动';
     Point='启动后查主进程与 %APPDATA%\Kithoard\kithoard.db'; Expect='主进程存活且数据库已落地';
     Fail='进程秒退或数据库没生成，说明主进程没真正起来';
     Test={ if (-not $script:AppProcess) { return $false }; $script:AppProcess.Refresh(); (-not $script:AppProcess.HasExited) -and (Test-Path (Join-Path $env:APPDATA 'Kithoard\kithoard.db')) } },
  @{ Id='I09'; Stage='install'; Mode='auto'; Title='安装目录含许可与声明';
     Point='检查安装目录根部的 LICENSE / THIRD_PARTY_NOTICES.md / README.md';
     Expect='三份文件都在'; Fail='缺文件：随包分发 GPL v3 的 FFmpeg 却没有可见的许可与构建来源';
     Test={ $dir = Split-Path -Parent $script:AppExe; $missing = @('LICENSE','THIRD_PARTY_NOTICES.md','README.md') | Where-Object { -not (Test-Path (Join-Path $dir $_)) }; $missing.Count -eq 0 } },
  @{ Id='I06'; Stage='manual'; Mode='manual'; Title='关窗即完全退出';
     Point='在虚拟机桌面点关闭按钮，任务管理器看进程'; Expect='Kithoard 进程数归零';
     Fail='关窗后仍有后台进程，与 §7.8-验收 9 不符' },
  @{ Id='I07'; Stage='post-uninstall'; Mode='auto'; Title='卸载后程序目录清空';
     Point='检查安装目录'; Expect='目录不存在或已无 Kithoard.exe';
     Fail='程序本体残留';
     Test={ -not (Test-Path $script:AppExe) } },
  @{ Id='I08'; Stage='post-uninstall'; Mode='auto'; Title='卸载默认保留用户数据';
     Point='检查 %APPDATA%\Kithoard'; Expect='目录仍在';
     Fail='数据被误删，违反偏离 9.2 的默认保留口径';
     Test={ Test-Path (Join-Path $env:APPDATA 'Kithoard') } },

  @{ Id='M01'; Stage='manual'; Mode='manual'; Title='需求九节 12 条演示';
     Point='按版本规划 §8 矩阵逐条点'; Expect='每条有可见结果';
     Fail='某条无承接或点不出结果' },
  @{ Id='M02'; Stage='manual'; Mode='manual'; Title='全程不切窗口单次连续演示';
     Point='搜一个词 → 下载 → 转换/压缩 → 本地素材库打开产物'; Expect='四步全在应用内，产物可检索';
     Fail='中途打开资源管理器/第三方软件，或产物没入库' },
  @{ Id='M03'; Stage='manual'; Mode='manual'; Title='1 万条大库性能';
     Point='按决策 D13 造 1 万条后翻页/搜索'; Expect='回填实测值，不编数字';
     Fail='界面卡死或耗时明显不可用' },
  @{ Id='M04'; Stage='manual'; Mode='manual'; Title='V0.6 交互断言';
     Point='站内浏览、最近访问、协议拦截、隔离区恢复'; Expect='B1–B9 断言全过';
     Fail='任一断言与 cache/验证单/v0.6.0.md 不符' }
)

$Results = @()

function Invoke-CheckStage {
  param([string]$Stage)
  foreach ($c in ($Checks | Where-Object { $_.Stage -eq $Stage })) {
    if ($c.Mode -eq 'manual') {
      $script:Results += [pscustomobject]@{ Id=$c.Id; Result='MANUAL'; Detail=$c.Title }
      continue
    }
    $ok = $false
    try { $ok = [bool](& $c.Test) } catch { $ok = $false }
    $script:Results += [pscustomobject]@{ Id=$c.Id; Result=$(if ($ok) { 'PASS' } else { 'FAIL' }); Detail=$c.Title }
  }
}

function Show-Plan {
  Write-Host "V1 干净机验收计划  版本=$Version  安装包=$InstallerPath"
  Write-Host "工作目录（只写验证产物，不清理）: $WorkDir"
  Write-Host ''
  Write-Host '预检 / 自动断言：'
  foreach ($c in ($Checks | Where-Object { $_.Mode -eq 'auto' })) {
    Write-Host ("  {0}  {1}" -f $c.Id, $c.Title)
    Write-Host ("        点哪里: {0}" -f $c.Point)
    Write-Host ("        看到什么: {0}" -f $c.Expect)
    Write-Host ("        失败长什么样: {0}" -f $c.Fail)
  }
  Write-Host ''
  Write-Host '需要人点或开发机侧 CDP 的项（结果记 MANUAL，不算进 PASS）：'
  foreach ($c in ($Checks | Where-Object { $_.Mode -eq 'manual' })) {
    Write-Host ("  {0}  {1}  |  点哪里: {2}  |  看到什么: {3}  |  失败: {4}" -f $c.Id, $c.Title, $c.Point, $c.Expect, $c.Fail)
  }
  Write-Host ''
  Write-Host '注：§7.8-5「卸载勾选删除素材」按 cache/待定问题.md 第 20 条默认未实现，本次不验。'
}

# 预检永远跑，且只读；这一步不过就不往下走，避免在错的机器上装包
Invoke-CheckStage 'pre'
$preFail = @($Results | Where-Object { $_.Result -eq 'FAIL' })

if (-not $Run) {
  Show-Plan
  Write-Host ''
  Write-Host ("DRY-RUN  预检 PASS {0}/{1}  FAIL {2}（未执行任何安装 / 启动 / 卸载）" -f `
    @($Results | Where-Object { $_.Result -eq 'PASS' }).Count, $Results.Count, $preFail.Count)
  foreach ($f in $preFail) { Write-Host ("  fail: {0} {1}" -f $f.Id, $f.Detail) }
  return
}

if ($preFail.Count -gt 0) {
  foreach ($f in $preFail) { Write-Host ("  fail: {0} {1}" -f $f.Id, $f.Detail) }
  Write-Host 'STOP：预检未过，不在不干净的机器上装包'
  exit 1
}

New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null

# /S 是 electron-builder NSIS 的静默参数；不用 /D 指定目录，走默认 perMachine:false 路径
$installer = (Resolve-Path $InstallerPath).Path
$proc = Start-Process -FilePath $installer -ArgumentList '/S' -Wait -PassThru
$script:InstallExitCode = $proc.ExitCode
Resolve-InstallInfo

# 先启动、后断言：否则 I05 检查时进程对象还是空的。SSH 无图形会话拿不到窗口标题，
# 所以用「主进程存活 + 数据库落地」当应用真起来的证据，比「窗口能开」更可靠。
# 带调试端口是为了让开发机侧沿用 V0 的 CDP 断言手法；干净机本身不需要装 Node
if ($script:AppExe -and (Test-Path $script:AppExe)) {
  $script:AppProcess = Start-Process -FilePath $script:AppExe -ArgumentList '--remote-debugging-port=9222' -PassThru
  Start-Sleep -Seconds 5
}
Invoke-CheckStage 'install'

if (-not $ConfirmUninstall) {
  foreach ($id in @('I07','I08')) {
    $script:Results += [pscustomobject]@{ Id=$id; Result='SKIP'; Detail='未给 -ConfirmUninstall，卸载阶段未执行' }
  }
} else {
  # 卸载前先正常关窗，避免卸载时主程序还占着文件；关窗行为本身由人工项 I06 判定
  if ($script:AppProcess) {
    $script:AppProcess.Refresh()
    if (-not $script:AppProcess.HasExited) { $script:AppProcess.CloseMainWindow() | Out-Null }
    Start-Sleep -Seconds 3
  }
  if ($script:UninstallExe -and (Test-Path $script:UninstallExe)) {
    Start-Process -FilePath $script:UninstallExe -ArgumentList '/S' -Wait
  }
  # 卸载后单独跑一次：这时才该判定「程序没了、数据还在」
  Invoke-CheckStage 'post-uninstall'
}

foreach ($c in ($Checks | Where-Object { $_.Stage -eq 'manual' })) {
  $script:Results += [pscustomobject]@{ Id=$c.Id; Result='MANUAL'; Detail=$c.Title }
}

$pass = @($Results | Where-Object { $_.Result -eq 'PASS' }).Count
$fail = @($Results | Where-Object { $_.Result -eq 'FAIL' })
$manual = @($Results | Where-Object { $_.Result -eq 'MANUAL' }).Count
$skip = @($Results | Where-Object { $_.Result -eq 'SKIP' }).Count

Write-Host ("V1 {0} clean-machine: PASS {1}  FAIL {2}  MANUAL {3}  SKIP {4}" -f $Version, $pass, $fail.Count, $manual, $skip)
foreach ($f in $fail) { Write-Host ("  fail: {0} {1}" -f $f.Id, $f.Detail) }
if ($fail.Count -gt 0) { exit 1 }

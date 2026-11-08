# 下载 FFmpeg 静态二进制到 resources/bin（V0.5 §7.7-1）
# 二进制约 200 MB，不进 git；打包前必须已存在，否则产物缺少音视频处理能力。
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$bin = Join-Path $root 'resources/bin'
$ffmpeg = Join-Path $bin 'ffmpeg.exe'
$ffprobe = Join-Path $bin 'ffprobe.exe'

if ((Test-Path $ffmpeg) -and (Test-Path $ffprobe)) {
  Write-Host "[ffmpeg] already present: $bin"
  exit 0
}

New-Item -ItemType Directory -Force -Path $bin | Out-Null
$zip = Join-Path $root 'cache/ffmpeg-release-essentials.zip'
if (-not (Test-Path $zip)) {
  Write-Host '[ffmpeg] downloading gyan.dev essentials build...'
  Invoke-WebRequest -Uri 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip' -OutFile $zip -UseBasicParsing
}

$extract = Join-Path $root 'cache/ffmpeg-extract'
if (Test-Path $extract) {
  # 不永久删除：旧目录改名留档，避免复用半套文件
  Move-Item $extract "cache/ffmpeg-extract-old-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
}
Expand-Archive -Path $zip -DestinationPath $extract -Force
$sourceBin = Get-ChildItem $extract -Recurse -Filter 'ffmpeg.exe' | Select-Object -First 1
if (-not $sourceBin) { throw 'ffmpeg.exe not found in archive' }
Copy-Item (Join-Path $sourceBin.Directory.FullName 'ffmpeg.exe') $ffmpeg -Force
Copy-Item (Join-Path $sourceBin.Directory.FullName 'ffprobe.exe') $ffprobe -Force
Write-Host "[ffmpeg] ready: $bin"

# 第三方组件与许可声明

本应用随包分发以下第三方组件。修改或再分发时请保留本文件与各组件的许可文本。

| 组件 | 版本 | 许可 | 说明 |
|---|---|---|---|
| Electron | 38.8.6 | MIT | 桌面运行时 |
| React / React DOM | 19.3.1 | MIT | 渲染层界面 |
| Zustand | 5.1.0 | MIT | 渲染层状态管理 |
| better-sqlite3 | 13.0.3 | MIT | 本地数据库（含预编译 SQLite） |
| sharp | 0.34.5 | Apache-2.0 | 图片处理（含 libvips） |
| FFmpeg / FFprobe | 9.0.2 essentials build | **GPL v3** | 音视频处理，见下 |
| NSIS（V0.6 安装包） | 随 electron-builder | zlib/libpng 类 | 安装程序 |

## FFmpeg

- **构建来源**：https://www.gyan.dev/ffmpeg/builds/ （`ffmpeg-release-essentials.zip`，Windows x64 静态构建）
- **版本**：`ffmpeg version 9.0.2-essentials_build-www.gyan.dev`
- **许可**：该构建启用 `--enable-gpl --enable-version3`，整体按 **GPL v3** 分发；本应用因随包分发该构建，分发时同样遵循 GPL v3 的相应义务。
- **源码获取**：
  - FFmpeg 源码：https://ffmpeg.org/download.html
  - 该构建的编译脚本与配置说明：https://www.gyan.dev/ffmpeg/builds/
- **configure 参数**（摘自 `ffmpeg -version`）：

```
--enable-gpl --enable-version3 --enable-static --disable-w32threads --disable-autodetect
--enable-cairo --enable-fontconfig --enable-iconv --enable-gnutls --enable-libxml2
--enable-gmp --enable-bzlib --enable-lzma --enable-zlib --enable-libsrt --enable-libssh
--enable-libzmq --enable-avisynth --enable-sdl2 --enable-libwebp --enable-libx264
--enable-libx265 --enable-libxvid --enable-libaom --enable-libopenjpeg --enable-libvpx
--enable-mediafoundation --enable-libass --enable-libfreetype --enable-libfribidi
--enable-libharfbuzz --enable-libvidstab --enable-libvmaf --enable-libzimg --enable-amf
--enable-cuda-llvm --enable-cuvid --enable-dxva2 --enable-d3d11va --enable-d3d12va
--enable-ffnvcodec --enable-libvpl --enable-nvdec --enable-nvenc --enable-vaapi
--enable-openal --enable-libgme --enable-libopenmpt --enable-libopencore-amrwb
--enable-libmp3lame --enable-libtheora --enable-libvo-amrwbenc --enable-libgsm
--enable-libopencore-amrnb --enable-libopus --enable-libspeex --enable-libvorbis
--enable-librubberband
```

- **二进制位置**：开发目录 `resources/bin/ffmpeg.exe`、`resources/bin/ffprobe.exe`；安装后位于应用 `resources/bin/`。二进制约 200 MB，不进入 git，使用 `npm run fetch:ffmpeg` 获取。

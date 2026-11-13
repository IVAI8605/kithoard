// 一次性图标生成器：把侧栏的「K」字标（主题橙 + 深色字）渲染成应用图标与托盘图标。
// 产物是可提交的静态资源；本脚本只用于重新生成，不随应用发布。
import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'

const root = process.cwd()

/** 圆角方块 + 居中的 K；托盘版留边更小、字更粗，保证 16px 下仍可辨认 */
function svg({ size, radius, fontSize, margin }) {
  const inner = size - margin * 2
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect x="${margin}" y="${margin}" width="${inner}" height="${inner}" rx="${radius}" fill="#d08a5f"/>
  <text x="${size / 2}" y="${size / 2 + fontSize * 0.36}" text-anchor="middle"
        font-family="Segoe UI, Arial, sans-serif" font-weight="700"
        font-size="${fontSize}" fill="#1c1410">K</text>
</svg>`
}

const targets = [
  {
    file: path.join(root, 'build', 'icon.png'),
    svg: svg({ size: 512, radius: 120, fontSize: 300, margin: 32 })
  },
  {
    file: path.join(root, 'resources', 'icons', 'tray.png'),
    svg: svg({ size: 32, radius: 8, fontSize: 24, margin: 1 })
  }
]

for (const target of targets) {
  fs.mkdirSync(path.dirname(target.file), { recursive: true })
  const buffer = await sharp(Buffer.from(target.svg)).png().toBuffer()
  fs.writeFileSync(target.file, buffer)
  const meta = await sharp(buffer).metadata()
  console.log(`${target.file} ${meta.width}x${meta.height} ${buffer.length}B`)
}

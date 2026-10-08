// §6.4 悬浮投影: measure the soft ellipse in PIXELS and compare it with the handoff's own window.
//
// Why this exists: the receipt could only say "软投影偏淡", which nobody can tune against. The module's
// report gives the shadow's WORLD size (`width: 6.25` units) and its SCREEN anchor, but not its screen
// extent — and dividing the world size by `framing.solid` (CSS px) is a unit error that looks like a
// reading and is not one. So measure pixels.
//
// Two traps this version exists to avoid, both hit on the way here:
//   1. Baseline. Sampling the far-left/right of the strip reads the plaza's EDGE SCENERY (walls,
//      foreground blocks) as "the field", so the darkest thing found was a scenery object at x=0..66.
//      A per-ROW MEDIAN is robust to that, so it is the baseline here.
//   2. Line endings. The gate log is CRLF; `\r` is a line terminator for JS regexes, so an anchored
//      `^OK … (\S.*)$` silently matches nothing while `startsWith('OK')` is true. Strip it on read.
//
// Passing a tolerance of 2/255 means "where does the darkening become invisible"; the ellipse is soft,
// so the same measurement at 8/255 gives a smaller, darker core. Both are printed.
import { readFileSync } from 'node:fs'
import { readPng } from './png-read.mjs'

const LOG = process.argv[2]
const buf = readFileSync(LOG)
const text = buf[0] === 0xFF && buf[1] === 0xFE ? buf.toString('utf16le') : buf.toString('utf8')
const lines = text.split('\n').map((l) => l.replace(/\r$/, ''))

let excluded = 0
const shots = []
for (let i = 0; i < lines.length; i += 1) {
  const m = /^OK\s+(\S+)\s+(\S+)\s+(\S.*)$/.exec(lines[i])
  if (!m) continue
  let report
  try { report = JSON.parse(lines[i + 1].trim()) } catch { continue }
  const shadow = report.rendering?.world?.boardShadow
  if (!shadow?.screen || !report.framing?.solid) continue
  // Only shots where the board is actually in play. On the cover and over a dialog the board is not
  // drawn, so there is no projection to measure — counting those as "outside the window" would inflate
  // the failure count with captures §6.4 does not apply to.
  const inPlay = report.gameLayers?.[0]?.visibility === 'visible'
  if (!inPlay) { excluded += 1; continue }
  shots.push({ name: m[1], viewport: m[2], path: m[3].trim(), report, shadow })
}

const pct = (v) => `${(100 * v).toFixed(1)}%`
const window4 = (w, h, below, opacity) => [
  w >= 0.65 && w <= 0.85,
  h >= 0.06 && h <= 0.12,
  below >= 0.12 && below <= 0.18,
  opacity >= 0.14,
]

console.log('§6.4 悬浮投影：像素实测 vs 交接单窗口')
console.log('  窗口：影宽/盘宽 .65–.85 ｜ 影高/盘屏高 .06–.12 ｜ 中心在盘底下方 .12–.18 盘屏高 ｜ 透明度 ≥ .14')
console.log('')
console.log('shot                       viewport     影宽px 影宽比     影高px 影高比     中心距盘底  透明度  判定')
let failures = 0
let notMeasured = 0
const rows = []
for (const shot of shots) {
  const { report, shadow } = shot
  const img = readPng(shot.path)
  const { width, channels, pixels } = img
  const lum = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= img.height) return null
    const k = (y * width + x) * channels
    return 0.2126 * pixels[k] + 0.7152 * pixels[k + 1] + 0.0722 * pixels[k + 2]
  }
  const rowMedian = (y) => {
    const v = []
    for (let x = 0; x < width; x += 2) v.push(lum(x, y))
    v.sort((a, b) => a - b)
    return v[Math.floor(v.length / 2)]
  }
  const darkening = (x, y) => {
    const l = lum(x, y)
    return l === null ? 0 : rowMedian(y) - l
  }

  const ax = Math.round(shadow.screen.x)
  const ay = Math.round(shadow.screen.y)
  const boardW = report.framing.solid.maxX - report.framing.solid.minX
  const boardH = report.framing.solid.maxY - report.framing.solid.minY
  const top = Math.ceil(report.framing.solid.maxY) + 1
  const bottom = report.trayMetrics ? Math.floor(report.trayMetrics.y) - 1 : img.height - 1

  const extent = (step, limit, tolerance, bounded) => {
    let n = 0
    let [x, y] = [ax, ay]
    for (;;) {
      x += step[0]; y += step[1]
      if (x < 0 || y < top || y > bottom || x >= width) { if (bounded) return { n, bounded: true }; break }
      if (darkening(x, y) < tolerance) break
      n += 1
      if (n === limit) return { n, bounded: true }
    }
    return { n, bounded: false }
  }

  const measure = (tolerance) => {
    const l = extent([-1, 0], 520, tolerance, false)
    const r = extent([1, 0], 520, tolerance, false)
    const u = extent([0, -1], 520, tolerance, true)
    const d = extent([0, 1], 520, tolerance, true)
    return { w: l.n + r.n + 1, h: u.n + d.n + 1, hBounded: u.bounded || d.bounded }
  }
  const soft = measure(2)
  const core = measure(8)
  // A 1px "extent" means no darkening was found at the reported anchor at all — which is what happens
  // when an opaque dialog sits over the plaza below the board (game-over / settings / leaderboard
  // captures). Those shots cannot judge §6.4, so they are counted separately instead of failed.
  if (soft.w <= 3) {
    const why = report.gameOver?.cardShown ? 'game-over card covers it' : (report.home === 'home-screen' ? 'cover' : 'panel/dialog covers it')
    console.log(`${shot.name.padEnd(26)} ${shot.viewport.padEnd(12)} ${'—'.padStart(22)}   not measurable (${why})`)
    notMeasured += 1
    continue
  }
  const wRatio = soft.w / boardW
  const hRatio = soft.h / boardH
  const below = (ay - report.framing.solid.maxY) / boardH
  const checks = window4(wRatio, hRatio, below, shadow.opacity)
  const ok = checks.every(Boolean)
  if (!ok) failures += 1
  const mark = (v) => (v ? ' ' : '*')
  console.log(
    `${shot.name.padEnd(26)} ${shot.viewport.padEnd(12)} `
    + `${String(soft.w).padStart(5)} ${pct(wRatio).padStart(7)}${mark(checks[0])} `
    + `${String(soft.h).padStart(5)}${soft.hBounded ? '>' : ' '} ${pct(hRatio).padStart(7)}${mark(checks[1])} `
    + `${pct(below).padStart(9)}${mark(checks[2])}  ${String(shadow.opacity).padStart(5)}${mark(checks[3])}   ${ok ? 'in window' : 'OUT'}`,
  )
  rows.push({ shot, soft, core, wRatio, hRatio, below, checks })
}
console.log('')
console.log(`(* marks a value outside the §6.4 window)  board-in-play shots: ${shots.length}  outside: ${failures}  (cover/panel captures excluded: ${excluded})`)
const avg = (f) => rows.reduce((n, r) => n + f(r), 0) / Math.max(rows.length, 1)
console.log(`mean 影宽比 ${pct(avg((r) => r.wRatio))}   mean 影高比 ${pct(avg((r) => r.hRatio))}   mean 影高 ${avg((r) => r.soft.h).toFixed(1)}px`)
console.log(`(影高比用盘屏高归一；"影高px >" 表示扫描撞到盘底/托盘边界，是真值的下界)`)
console.log('')
console.log('未覆盖：§6.4 还要求「0°/45°/90° 检查穿插」，而门禁只拍停靠姿态 —— 旋转姿态的投影可见性未测。')

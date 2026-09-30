// Quantitative A/B for two screenshots of the SAME pose — the handoff's rule is that a
// material round is only "no change" or "changed" if that is measured, not eyeballed at
// 390px where a subtle shader term is a few levels of luminance.
//
//   node tools/frame-diff.mjs <a.png> <b.png> [--box x0,y0,x1,y1]
//
// Prints: how many pixels differ by more than 2/8/16/32 levels, the mean and max absolute
// per-channel delta, and the bounding box of everything that moved. A --box restricts the
// comparison to one region (e.g. the candidate tray, so a board-only shader change cannot
// be claimed from a difference that actually came from the HUD).
//
// Reuses tools/png-read.mjs — no image dependency enters the repo for this.
import { readPng } from './png-read.mjs'

const [aPath, bPath] = process.argv.slice(2).filter((arg) => !arg.startsWith('--'))
if (!aPath || !bPath) throw new Error('usage: node tools/frame-diff.mjs <a.png> <b.png> [--box x0,y0,x1,y1]')
const boxArg = process.argv.includes('--box') ? process.argv[process.argv.indexOf('--box') + 1] : null
const box = boxArg ? boxArg.split(',').map(Number) : null

const a = readPng(aPath)
const b = readPng(bPath)
if (a.width !== b.width || a.height !== b.height || a.channels !== b.channels) {
  throw new Error(`frames are not comparable: ${a.width}x${a.height}c${a.channels} vs ${b.width}x${b.height}c${b.channels}`)
}

const [x0, y0, x1, y1] = box ?? [0, 0, a.width - 1, a.height - 1]
const channels = a.channels
const thresholds = [2, 8, 16, 32]
const counts = thresholds.map(() => 0)
let sum = 0
let max = 0
let samples = 0
const moved = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }

for (let y = y0; y <= y1; y += 1) {
  for (let x = x0; x <= x1; x += 1) {
    const i = (y * a.width + x) * channels
    let delta = 0
    // Alpha is excluded on purpose: the capture is opaque, and an alpha term would
    // dilute the per-channel colour delta the eye actually reads.
    for (let c = 0; c < Math.min(3, channels); c += 1) delta = Math.max(delta, Math.abs(a.pixels[i + c] - b.pixels[i + c]))
    sum += delta
    samples += 1
    if (delta > max) max = delta
    thresholds.forEach((t, index) => { if (delta > t) counts[index] += 1 })
    if (delta > 2) {
      if (x < moved.minX) moved.minX = x
      if (y < moved.minY) moved.minY = y
      if (x > moved.maxX) moved.maxX = x
      if (y > moved.maxY) moved.maxY = y
    }
  }
}

const total = samples || 1
console.log(`A  ${aPath}  (sha256 of file differs by construction; this is a pixel comparison)`)
console.log(`B  ${bPath}`)
console.log(`region      ${x0},${y0} .. ${x1},${y1}   (${total} px)`)
console.log(`mean |d|    ${(sum / total).toFixed(3)}   max |d| ${max}`)
thresholds.forEach((t, index) => {
  console.log(`> ${String(t).padStart(2)} levels  ${String(counts[index]).padStart(7)} px  ${(100 * counts[index] / total).toFixed(2)}%`)
})
console.log(moved.minX === Infinity
  ? 'moved box   none (no pixel differs by more than 2 levels)'
  : `moved box   ${moved.minX},${moved.minY} .. ${moved.maxX},${moved.maxY}`)

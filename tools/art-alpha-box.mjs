// v0.9.15 — where does each HUD art slice actually START being visible?
//
// The HUD alignment is done in CSS (element top edges share `--hud-top`), but what the
// producer SEES is the art inside each PNG. If `score-panel.png` carries transparent padding
// above the wooden board while the round buttons fill their box from row 0, then equal element
// tops still read as "the buttons float above the plaque". This measures the alpha bounding box
// of every reference slice so the decision (crop the art vs offset the buttons) can be made on
// numbers instead of on a screenshot.
import { readFileSync } from 'node:fs'
import { join, resolve, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function readPng(path) {
  const buffer = readFileSync(path)
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error(`${path}: not a PNG`)
  let offset = 8
  let width = 0, height = 0, depth = 0, colorType = 0, interlace = 0
  const idat = []
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4)
      depth = data[8]; colorType = data[9]; interlace = data[12]
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    offset += 12 + length
  }
  if (interlace) throw new Error(`${path}: interlaced PNG unsupported`)
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType]
  if (!channels) throw new Error(`${path}: colour type ${colorType} unsupported`)
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = Buffer.alloc(height * stride)
  let pos = 0
  for (let y = 0; y < height; y += 1) {
    const filter = raw[pos]; pos += 1
    const line = raw.subarray(pos, pos + stride); pos += stride
    const prev = y ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride)
    const cur = out.subarray(y * stride, (y + 1) * stride)
    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? cur[i - channels] : 0
      const b = prev[i]
      const c = i >= channels ? prev[i - channels] : 0
      let value = line[i]
      if (filter === 1) value += a
      else if (filter === 2) value += b
      else if (filter === 3) value += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
        value += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c)
      }
      cur[i] = value & 0xff
    }
  }
  return { width, height, channels, pixels: out }
}

// Alpha bounding box, plus how much of each edge is fully transparent.
function alphaBox(path) {
  const { width, height, channels, pixels } = readPng(path)
  if (channels !== 4) throw new Error(`${path}: no alpha channel (channels=${channels})`)
  let minX = width, maxX = -1, minY = height, maxY = -1
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (pixels[(y * width + x) * channels + 3] > 8) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  return { width, height, minX, maxX, minY, maxY,
    padTopPct: (minY / height) * 100, padBottomPct: ((height - 1 - maxY) / height) * 100 }
}

const args = process.argv.slice(2)
const names = args.length ? args : ['score-panel.png', 'sound.png', 'help.png', 'settings.png']
for (const name of names) {
  const path = join(ROOT, 'public', 'art', 'reference', name)
  const b = alphaBox(path)
  console.log(`${basename(name).padEnd(16)} ${String(b.width).padStart(4)}x${String(b.height).padStart(4)}  `
    + `content x ${String(b.minX).padStart(4)}..${String(b.maxX).padStart(4)}  y ${String(b.minY).padStart(4)}..${String(b.maxY).padStart(4)}  `
    + `top pad ${b.minY}px (${b.padTopPct.toFixed(1)}%)  bottom pad ${b.height - 1 - b.maxY}px (${b.padBottomPct.toFixed(1)}%)`)
  // v0.9.16: for the score plaque the interesting row is not the alpha box (that is the LEAF
  // decoration, which is meant to stick out above) but where the WOODEN BOARD itself starts —
  // that is the edge the producer means by 「积分…的上沿」.
  //
  // Measured by the longest CONTIGUOUS opaque run per row, not by total coverage: the leaves
  // run along the whole top edge, so a coverage test fires on the leaf cluster (~13% of the
  // height) while the board itself only starts at ~24%. A first attempt used total coverage and
  // put the buttons 10px above the slab on the rendered phone. The board is one wide slab, so
  // the first row whose longest run reaches half the width is its top edge.
  if (name === 'score-panel.png') {
    const { width, height, channels, pixels } = readPng(path)
    const longestRun = []
    for (let y = 0; y < height; y += 1) {
      let best = 0, run = 0
      for (let x = 0; x < width; x += 1) {
        if (pixels[(y * width + x) * channels + 3] > 8) { run += 1; if (run > best) best = run }
        else run = 0
      }
      longestRun.push(best)
    }
    const boardTop = longestRun.findIndex((run) => run >= width * 0.5)
    console.log(`  ${'└ board'.padEnd(14)} top edge at y ${boardTop} of ${height} = ${(boardTop / height * 100).toFixed(2)}% of the slice height`)
    console.log(`  ${''.padEnd(14)} leaves stick out ${boardTop - b.minY}px above the board (that is the gap the HUD must not align to)`)
    console.log(`  ${''.padEnd(14)} longest run, rows 20..60: ${longestRun.slice(20, 61).map((r) => String(r).padStart(3)).join(' ')}`)
  }
}

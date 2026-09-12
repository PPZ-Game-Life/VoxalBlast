#!/usr/bin/env node
// PNG statistics — objective proof that a screenshot is a real rendered frame and
// not a blank page (a blank white PNG is exactly what a failed headless capture
// looks like, and it is small enough to be mistaken for a "clean" screenshot).
//
//   node tools/png-stats.mjs artifacts/visual/*.png
//
// Reports, per file: dimensions, the share of pixels that differ from the most
// common colour (the background), the share of near-white pixels, and the bounding
// box of the differing pixels. A real game frame has a background share well under
// ~0.9 and a content box covering most of the image; a blank frame is >0.95 single
// colour with a tiny text-only box.
import fs from 'node:fs'
import zlib from 'node:zlib'

function readPng(path) {
  const buffer = fs.readFileSync(path)
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG')
  let offset = 8
  let width = 0
  let height = 0
  let depth = 0
  let colorType = 0
  let interlace = 0
  const idat = []
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      depth = data[8]
      colorType = data[9]
      interlace = data[12]
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    offset += 12 + length
  }
  if (depth !== 8) throw new Error(`unsupported bit depth ${depth}`)
  if (interlace !== 0) throw new Error('interlaced PNG not supported')
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 0
  if (!channels) throw new Error(`unsupported colour type ${colorType}`)
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const pixels = Buffer.alloc(height * stride)
  let previous = Buffer.alloc(stride)
  let cursor = 0
  for (let y = 0; y < height; y += 1) {
    const filter = raw[cursor]
    cursor += 1
    const line = raw.subarray(cursor, cursor + stride)
    cursor += stride
    const out = Buffer.alloc(stride)
    for (let i = 0; i < stride; i += 1) {
      const left = i >= channels ? out[i - channels] : 0
      const up = previous[i]
      const upLeft = i >= channels ? previous[i - channels] : 0
      let value = line[i]
      if (filter === 1) value += left
      else if (filter === 2) value += up
      else if (filter === 3) value += (left + up) >> 1
      else if (filter === 4) {
        const p = left + up - upLeft
        const pa = Math.abs(p - left)
        const pb = Math.abs(p - up)
        const pc = Math.abs(p - upLeft)
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
      }
      out[i] = value & 0xff
    }
    out.copy(pixels, y * stride)
    previous = out
  }
  return { width, height, channels, pixels }
}

function stats(path) {
  const { width, height, channels, pixels } = readPng(path)
  const counts = new Map()
  let nearWhite = 0
  for (let i = 0; i < width * height; i += 1) {
    const at = i * channels
    const r = pixels[at]
    const g = pixels[at + 1]
    const b = pixels[at + 2]
    const key = `${r >> 2},${g >> 2},${b >> 2}`
    counts.set(key, (counts.get(key) || 0) + 1)
    if (r > 244 && g > 244 && b > 244) nearWhite += 1
  }
  let backgroundKey = ''
  let backgroundCount = 0
  for (const [key, count] of counts) if (count > backgroundCount) { backgroundCount = count; backgroundKey = key }
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * channels
      const key = `${pixels[at] >> 2},${pixels[at + 1] >> 2},${pixels[at + 2] >> 2}`
      if (key === backgroundKey) continue
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }
  }
  const total = width * height
  return {
    file: path.split(/[\\/]/).pop(),
    size: `${width}×${height}`,
    background: `rgb(${backgroundKey.split(',').map((v) => Number(v) * 4).join(',')})`,
    backgroundShare: +(backgroundCount / total).toFixed(3),
    nearWhiteShare: +(nearWhite / total).toFixed(3),
    contentBox: maxX < 0 ? 'empty' : `${maxX - minX + 1}×${maxY - minY + 1} @ ${minX},${minY}`,
    contentShare: maxX < 0 ? 0 : +(((maxX - minX + 1) * (maxY - minY + 1)) / total).toFixed(3),
  }
}

const files = process.argv.slice(2)
if (!files.length) {
  console.error('usage: node tools/png-stats.mjs <file.png> [...]')
  process.exit(2)
}
for (const file of files) {
  try {
    console.log(JSON.stringify(stats(file)))
  } catch (error) {
    console.log(JSON.stringify({ file, error: error.message }))
  }
}

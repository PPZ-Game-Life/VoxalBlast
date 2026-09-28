// Minimal PNG reader shared by the art and rendering checks (`tools/art-alpha-box.mjs`, and the
// one-off HUD measurements). Non-interlaced, 8-bit, colour types 0/2/4/6 — everything the
// pipeline produces. Kept tiny on purpose: a PNG library is a dependency this repo does not need.
import { readFileSync } from 'node:fs'
import zlib from 'node:zlib'

export function readPng(path) {
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
  if (depth !== 8) throw new Error(`${path}: bit depth ${depth} unsupported`)
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType]
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

// The first row inside `x0..x1` whose pixel differs from `background` by more than `tolerance`
// on any channel. Used to find a rendered element's TOP EDGE in a screenshot — "where does the
// solid thing start", which is what the eye reads as 上沿.
export function firstRowDiffering(image, { x0, x1, background, tolerance = 24, from = 0, to = null }) {
  const { width, channels, pixels } = image
  const limit = to ?? image.height
  for (let y = from; y < limit; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const i = (y * width + x) * channels
      if (Math.abs(pixels[i] - background[0]) > tolerance
        || Math.abs(pixels[i + 1] - background[1]) > tolerance
        || Math.abs(pixels[i + 2] - background[2]) > tolerance) return y
    }
  }
  return null
}

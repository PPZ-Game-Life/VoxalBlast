import * as THREE from 'three'

// Deterministic, low-contrast timber and lacquer. Paint covers the timber's
// fibres: it gets a soft pigment wash of its own, not the bare wood's line map.
//
// Everything is seeded and deterministic: the grain must be identical on every
// load, or two screenshots of the same build would not compare, and the board
// would visibly re-cut its planks between sessions.

function mulberry32(seed) {
  let a = seed >>> 0
  return function random() {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function paintBase(ctx, width, height, base) {
  ctx.fillStyle = base
  ctx.fillRect(0, 0, width, height)
}

// One family of wavy streaks. `axis` is the direction the grain RUNS: 'x' draws
// horizontal streaks (a plank seen from the side), 'y' draws them running down
// the board (a post, or the end grain of a small button).
function paintStreaks(ctx, width, height, random, { axis, count, color, alpha, width: strokeWidth }) {
  const span = axis === 'x' ? width : height
  const cross = axis === 'x' ? height : width
  ctx.lineCap = 'round'
  for (let i = 0; i < count; i += 1) {
    const offset = random() * cross
    const wobble = cross * (0.012 + random() * 0.05)
    const phase = random() * Math.PI * 2
    const freq = (1.6 + random() * 2.6) * Math.PI / span
    ctx.beginPath()
    ctx.strokeStyle = color
    ctx.globalAlpha = alpha * (0.5 + random() * 0.9)
    ctx.lineWidth = strokeWidth * (0.5 + random())
    const step = Math.max(6, span / 48)
    for (let t = 0; t <= span; t += step) {
      const drift = Math.sin(t * freq + phase) * wobble + Math.sin(t * freq * 2.7 + phase) * wobble * 0.35
      const cx = axis === 'x' ? t : offset + drift
      const cy = axis === 'x' ? offset + drift : t
      if (t === 0) ctx.moveTo(cx, cy)
      else ctx.lineTo(cx, cy)
    }
    ctx.stroke()
  }
  ctx.globalAlpha = 1
}

// A softly varying light wash across the grain. Real planks are never one value:
// the shell needs this or a 5-unit cube reads as a plastic mould.
function paintSheen(ctx, width, height, axis, from, to) {
  const gradient = axis === 'x'
    ? ctx.createLinearGradient(0, 0, 0, height)
    : ctx.createLinearGradient(0, 0, width, 0)
  gradient.addColorStop(0, from)
  gradient.addColorStop(0.55, to)
  gradient.addColorStop(1, from)
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, width, height)
}

function makeCanvas(width, height) {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

const GRAIN_RECIPE = Object.freeze({ size: 256 })
let grainCanvas = null

function buildSurfaceCanvas(painted = false) {
  const { size } = GRAIN_RECIPE
  const canvas = makeCanvas(size, size)
  const ctx = canvas.getContext('2d')
  const pixels = ctx.createImageData(size, size)
  // Periodic, coherent bands avoid both texture seams and the old crossing
  // scribbles. Broad pigment variation survives at real game size.
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = x / size * Math.PI * 2
      const v = y / size * Math.PI * 2
      const wash = Math.sin(u + Math.sin(v)) * Math.cos(v * 2 - Math.sin(u))
      const grain = Math.pow(0.5 + 0.5 * Math.sin(u * 9 + Math.sin(v) * 1.8 + Math.sin(v * 2) * 0.4), 12)
      const fibre = Math.sin(u * 27 + Math.sin(v * 2) * 2)
      const value = painted ? 248 + wash * 4 : 245 + wash * 5 - grain * 10 + fibre * 1.5
      const i = (y * size + x) * 4
      pixels.data[i] = value
      pixels.data[i + 1] = value
      pixels.data[i + 2] = value
      pixels.data[i + 3] = 255
    }
  }
  ctx.putImageData(pixels, 0, 0)
  return canvas
}

function buildGrainCanvas() {
  if (!grainCanvas) grainCanvas = buildSurfaceCanvas()
  return grainCanvas
}

let paintedTexture
let woodBumpTexture
let paintBumpTexture
export function blockSurfaceMaps(painted = false) {
  if (!paintedTexture) {
    paintedTexture = new THREE.CanvasTexture(buildSurfaceCanvas(true))
    paintedTexture.colorSpace = THREE.SRGBColorSpace
    paintedTexture.wrapS = paintedTexture.wrapT = THREE.RepeatWrapping
    paintedTexture.anisotropy = 4
    woodBumpTexture = new THREE.CanvasTexture(buildGrainCanvas())
    paintBumpTexture = new THREE.CanvasTexture(paintedTexture.image)
    for (const texture of [woodBumpTexture, paintBumpTexture]) {
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping
      texture.anisotropy = 4
      // Height is data; leave colorSpace at NoColorSpace.
    }
  }
  return {
    map: painted ? paintedTexture : woodGrainTextureRepeating(1),
    bumpMap: painted ? paintBumpTexture : woodBumpTexture,
  }
}

// One CanvasTexture per repeat value, because `repeat` lives on the Texture and the
// 5-unit shell, a 0.91 block and a signboard cannot share one. `repeat = 1` is a
// valid recipe, so this is the only entry point the game needs.
const repeatCache = new Map()
export function woodGrainTextureRepeating(repeat = 1) {
  const key = Number(repeat.toFixed(4))
  if (repeatCache.has(key)) return repeatCache.get(key)
  const texture = new THREE.CanvasTexture(buildGrainCanvas())
  texture.colorSpace = THREE.SRGBColorSpace
  texture.wrapS = THREE.RepeatWrapping
  texture.wrapT = THREE.RepeatWrapping
  texture.anisotropy = 4
  texture.repeat.set(key, key)
  repeatCache.set(key, texture)
  return texture
}

// ---- CSS side ---------------------------------------------------------------
// The signboards are DOM, so they cannot use a CanvasTexture. They use the same
// call as a data URL instead: identical fibre, drawn by the same maths.
function woodDataUrl({ width, height, axis, base, seed, streaks, alpha }) {
  const random = mulberry32(seed)
  const canvas = makeCanvas(width, height)
  const ctx = canvas.getContext('2d')
  paintBase(ctx, width, height, base)
  paintStreaks(ctx, width, height, random, { axis, count: streaks, color: '#6b4620', alpha: alpha * 0.55, width: 2.6 })
  paintStreaks(ctx, width, height, random, { axis, count: Math.round(streaks * 0.7), color: '#fff2d8', alpha: alpha * 1.5, width: 1.8 })
  for (let i = 0; i < 420; i += 1) {
    ctx.globalAlpha = 0.05 + random() * 0.06
    ctx.fillStyle = random() > 0.5 ? '#5c3d1c' : '#fff6e6'
    ctx.fillRect(random() * width, random() * height, 1 + random(), 1 + random())
  }
  ctx.globalAlpha = 1
  paintSheen(ctx, width, height, axis, 'rgba(255,255,255,0.16)', 'rgba(96,64,30,0.16)')
  return canvas.toDataURL('image/png')
}

// Horizontal planks (signboards, the candidate tray, the banner).
export function installWoodSkin(root = document.documentElement) {
  const panel = woodDataUrl({ width: 320, height: 120, axis: 'x', base: '#e0b57e', seed: 4471, streaks: 14, alpha: 0.1 })
  const post = woodDataUrl({ width: 96, height: 320, axis: 'y', base: '#dcae74', seed: 9931, streaks: 12, alpha: 0.12 })
  root.style.setProperty('--wood-grain', `url("${panel}")`)
  root.style.setProperty('--wood-grain-post', `url("${post}")`)
}

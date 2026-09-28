import * as THREE from 'three'
import { BLOCK_TEXTURES, BOARD_STYLE } from './config.js'

// Deterministic pale timber and smooth toy plastic. Authored neutral brushwork
// supplements only timber; both families have a complete procedural fallback.
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

// A single neutral hand-painted source, tinted by the existing gameplay palette.
// Loading never gates play: live CanvasTextures start with the procedural recipe
// and are refreshed in place when the small, local WebP is decoded.
let artState = 'loading'
const pigmentVariants = []
export const blockSurfaceArtStatus = () => artState
let resolveSurfaceArt
export const blockSurfaceArtReady = new Promise(resolve => { resolveSurfaceArt = resolve })

const pigmentImage = new Image()
pigmentImage.onload = () => {
  const { size } = GRAIN_RECIPE
  for (let variant = 0; variant < 3; variant += 1) {
    const canvas = makeCanvas(size, size)
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    const crop = Math.min(pigmentImage.width, pigmentImage.height) * 0.74
    const offset = (pigmentImage.width - crop) * variant / 2
    ctx.translate(size / 2, size / 2)
    ctx.rotate(variant * Math.PI / 2)
    ctx.drawImage(pigmentImage, offset, pigmentImage.height - crop - offset, crop, crop, -size / 2, -size / 2, size, size)
    const pixels = ctx.getImageData(0, 0, size, size).data
    const values = new Float32Array(size * size)
    let mean = 0
    for (let i = 0; i < values.length; i += 1) {
      values[i] = pixels[i * 4] * 0.2126 + pixels[i * 4 + 1] * 0.7152 + pixels[i * 4 + 2] * 0.0722
      mean += values[i] / values.length
    }
    // Remove the source's ivory tint / average exposure. Only its brushwork
    // should affect the tint, especially the colour-coded occupied cells.
    pigmentVariants.push({ values, mean })
  }
  artState = 'ready'
  for (const [key, maps] of surfaceCache) {
    const [painted, variant] = key.split(':')
    if (painted === 'true') continue // toy plastic does not use the authored grain
    for (const [property, channel] of SURFACE_CHANNELS) {
      const texture = maps[property]
      if (texture.userData.authored) continue
      texture.image.getContext('2d').drawImage(buildSurfaceCanvas(painted === 'true', Number(variant), channel), 0, 0)
      texture.needsUpdate = true
    }
  }
  resolveSurfaceArt(artState)
}
pigmentImage.onerror = () => { artState = 'fallback'; resolveSurfaceArt(artState) }
pigmentImage.src = `${import.meta.env.BASE_URL}art/block-pigment.webp`

function noise(x, y, seed) {
  const ix = Math.floor(x), iy = Math.floor(y)
  const fx = x - ix, fy = y - iy
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy)
  const hash = (a, b) => {
    let h = Math.imul(a, 374761393) ^ Math.imul(b, 668265263) ^ Math.imul(seed, 1274126177)
    h = Math.imul(h ^ (h >>> 13), 1274126177)
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295
  }
  const a = hash(ix, iy), b = hash(ix + 1, iy), c = hash(ix, iy + 1), d = hash(ix + 1, iy + 1)
  return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy
}

function buildSurfaceCanvas(painted = false, variant = 0, channel = 'color') {
  const { size } = GRAIN_RECIPE
  const canvas = makeCanvas(size, size)
  const ctx = canvas.getContext('2d')
  const pixels = ctx.createImageData(size, size)
  if (channel === 'normal') {
    const heights = buildSurfaceCanvas(painted, variant, 'height').getContext('2d').getImageData(0, 0, size, size).data
    const heightAt = (x, y) => heights[(Math.max(0, Math.min(size - 1, y)) * size + Math.max(0, Math.min(size - 1, x))) * 4] / 255
    for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
      const u = x / (size - 1) * 2 - 1, v = 1 - y / (size - 1) * 2
      const crown = painted ? BOARD_STYLE.paintCrownHeight : BOARD_STYLE.woodCrownHeight
      // Analytic gradient of h = crown * (1-u²)² * (1-v²)². It is zero at
      // the UV boundary, joining the real bevel without a normal-map seam.
      // A view-independent normal field lets the actual environment reflection
      // travel across a face as the cube rotates; no highlight is painted in.
      const micro = painted ? 0.12 : 0.22
      const nx = (heightAt(x - 1, y) - heightAt(x + 1, y)) * micro + 8 * crown * u * (1 - u * u) * (1 - v * v) ** 2
      const ny = (heightAt(x, y + 1) - heightAt(x, y - 1)) * micro + 8 * crown * v * (1 - v * v) * (1 - u * u) ** 2
      const length = Math.hypot(nx, ny, 1), i = (y * size + x) * 4
      pixels.data.set([(nx / length * 0.5 + 0.5) * 255, (ny / length * 0.5 + 0.5) * 255, (1 / length * 0.5 + 0.5) * 255, 255], i)
    }
    ctx.putImageData(pixels, 0, 0)
    return canvas
  }
  const seed = 1847 + variant * 73
  const pigment = pigmentVariants[variant % 3]
  // Domain-warped fallback washes, supplemented by authored brushwork on load.
  // No directional light is baked in: bevel highlights still track the sun.
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = x / (size - 1), v = y / (size - 1)
      const warp = noise(u * 3, v * 3, seed)
      const cloud = noise(u * 5 + warp * 2, v * 5 + warp, seed + 1)
      const brush = noise(u * 13 + warp * 3, v * 9, seed + 2)
      const fine = noise(u * 46, v * 46, seed + 3)
      const wash = cloud * 0.68 + brush * 0.25 + fine * 0.07
      // Keep the UV seams quiet, without dark painted borders or fake lighting.
      const edge = Math.min(u, v, 1 - u, 1 - v)
      const fade = Math.min(1, edge / 0.055)
      let value
      const stroke = pigment ? pigment.values[y * size + x] - pigment.mean : (wash - 0.5) * 30
      // Smooth lacquer fills the grain. Large pigment changes belong in albedo,
      // not in bump: the old broad bump made the faces look soft and dented.
      // Long, low-contrast fibres distinguish bare maple from smooth toy plastic.
      // Paint never inherits authored timber brushwork, even after the asset loads.
      const fibre = Math.sin(v * 95 + warp * 12 + Math.sin(u * 9 + variant) * 2)
      const grain = fibre * 2.5 + (noise(u * 3, v * 70, seed + 4) - 0.5) * 7
      if (channel === 'ao') value = 255 - 38 * (1 - Math.min(1, edge / 0.12)) ** 2
      else if (channel === 'roughness') value = painted ? 244 + (fine - 0.5) * 4 : 239 + grain * 0.8
      else if (channel === 'height') value = 128 + (painted ? (fine - 0.5) * 2 : grain * 1.4) * fade
      else value = painted ? 249 + (cloud - 0.5) * 7 : 244 + (grain + stroke * 0.12 + (wash - 0.5) * 3) * fade
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

const surfaceCache = new Map()
const SURFACE_CHANNELS = [['map', 'color'], ['normalMap', 'normal'], ['roughnessMap', 'roughness'], ['aoMap', 'ao']]
export function blockSurfaceMaps(painted = false, variant = 0) {
  variant = painted ? 0 : variant % 3
  const key = `${painted}:${variant % 3}`
  if (surfaceCache.has(key)) return surfaceCache.get(key)
  const maps = {}
  for (const [property, channel] of SURFACE_CHANNELS) {
    const texture = new THREE.CanvasTexture(buildSurfaceCanvas(painted, variant % 3, channel))
    if (channel === 'color') texture.colorSpace = THREE.SRGBColorSpace
    texture.anisotropy = 4
    texture.name = `block-${painted ? 'paint' : 'wood'}-${variant}-${channel}`
    const source = BLOCK_TEXTURES[painted ? 'paint' : 'wood'][channel === 'color' ? 'baseColor' : channel]
    if (source) {
      const image = new Image()
      image.onload = () => {
        texture.image.getContext('2d').drawImage(image, 0, 0, GRAIN_RECIPE.size, GRAIN_RECIPE.size)
        texture.userData.authored = true
        texture.needsUpdate = true
      }
      image.onerror = () => console.warn(`Block texture unavailable; using procedural ${texture.name}`)
      image.src = `${import.meta.env.BASE_URL}${source.replace(/^\//, '')}`
    }
    maps[property] = texture
  }
  // Share roughness data instead of allocating another clearcoat image; the
  // clearcoatRoughness material factor controls the top layer independently.
  maps.clearcoatRoughnessMap = maps.roughnessMap
  surfaceCache.set(key, maps)
  return maps
}

// One CanvasTexture per repeat value, because `repeat` lives on the Texture and the
// 5-unit shell, a 0.94 block and a signboard cannot share one. `repeat = 1` is a
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

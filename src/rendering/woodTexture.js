import * as THREE from 'three'

// v0.7 「木作工坊」— every wooden surface in the game comes from THIS file.
//
// 05「资产边界」 forbids shipping image files: the runtime picture is built from
// parametric geometry, CSS, code-generated inline SVG, canvas textures and
// shaders. So the wood is not a photograph of oak, it is a canvas painted at
// boot by the recipes below, and every plank on screen — the cube body, the face
// sockets, the signboards, the fence in the backdrop — is the same recipe at a
// different scale and rotation. One generator is what makes the UI and the 3D
// board read as the same material (05「同源」).
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

// The universal grain layer. A near-white canvas carrying faint dark streaks, so
// it can be used as `map` on a MeshStandardMaterial of ANY colour: Three.js
// multiplies `map` by `color`, which means one texture grains the natural-wood
// shell, the recessed sockets and every painted chip at once. That single shared
// map is what stops the board reading as "wood plus coloured plastic".
const GRAIN_RECIPE = Object.freeze({ size: 512, seed: 20270915 })
let grainCanvas = null

function buildGrainCanvas() {
  if (grainCanvas) return grainCanvas
  const { size, seed } = GRAIN_RECIPE
  const canvas = makeCanvas(size, size)
  const ctx = canvas.getContext('2d')
  const random = mulberry32(seed)
  paintBase(ctx, size, size, '#ffffff')
  paintStreaks(ctx, size, size, random, { axis: 'x', count: 90, color: '#7a5a34', alpha: 0.16, width: 3.4 })
  paintStreaks(ctx, size, size, random, { axis: 'x', count: 60, color: '#fff6e4', alpha: 0.5, width: 2.2 })
  // Fine speckle: without it the streaks read as pen lines rather than fibre.
  for (let i = 0; i < 900; i += 1) {
    ctx.globalAlpha = 0.05 + random() * 0.07
    ctx.fillStyle = random() > 0.5 ? '#6b4a26' : '#fffaf0'
    ctx.fillRect(random() * size, random() * size, 1 + random() * 1.6, 1 + random() * 1.4)
  }
  ctx.globalAlpha = 1
  paintSheen(ctx, size, size, 'x', 'rgba(255,255,255,0.10)', 'rgba(120,86,50,0.10)')
  grainCanvas = canvas
  return canvas
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
  const panel = woodDataUrl({ width: 320, height: 120, axis: 'x', base: '#e0b57e', seed: 4471, streaks: 34, alpha: 0.5 })
  const post = woodDataUrl({ width: 96, height: 320, axis: 'y', base: '#dcae74', seed: 9931, streaks: 26, alpha: 0.55 })
  root.style.setProperty('--wood-grain', `url("${panel}")`)
  root.style.setProperty('--wood-grain-post', `url("${post}")`)
}

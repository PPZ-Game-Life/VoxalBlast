// Board-contour anti-aliasing read-out.
//
// Why this exists: the board cube's outline is a dark stroke roughly ONE device pixel wide
// (`BOARD_STYLE.boardOuterInkExpansion` splits a .04 world-unit band over the two sides of a
// 4.95-wide block lattice). A one-pixel dark stroke on a cream field is the worst case for
// aliasing, and the mobile tier shipped with `multisampling: 0` + `SMAAPreset.LOW`, so the
// stair-step is visible in the 390x844 captures. "It looks jaggy" is not a number, and the
// repo grades visual claims with reproductions, so this probe measures the two things that
// decide whether the stroke is anti-aliased at all:
//
//   bandWidthPx      how many device pixels of ink the silhouette stroke actually covers.
//                    Below ~1.2 the stroke is a sliver and AA has nothing to work with.
//   blendPerRow      the count of partially covered pixels straddling the OUTER boundary of the
//                    stroke, averaged over the rows that cross it. A resolved edge leaves about
//                    one such pixel per row; a hard edge leaves none. THE GATE is 0.8 here.
//   blendRowFrac     the share of rows carrying at least one partially covered pixel. Reported
//                    as a second, stricter reading (the shipped desktop tier sits at .7-.9); it is
//                    NOT the gate, because a locally pixel-aligned edge legitimately has rows
//                    with no blend pixel at all.
//   edgeSharpness    the largest single-pixel luminance jump across the boundary. A hard edge
//                    moves the full ink→background distance (~155) in one step; a resolved one
//                    spreads it. Reported for diagnosis, not gated.
//
// Recorded readings (390x844, DPR 1, same seeded deal, left/right silhouette):
//   shipped low tier (MSAA 0 + SMAA LOW)      blendPerRow 1.47 / 0.36   sharpness 140 / 168
//   shipped high tier (MSAA 4 + SMAA HIGH)    blendPerRow 2.22 / 1.15   sharpness  75 / 125
// after the contour close (both tiers MSAA 4 + SMAA ULTRA):
//   low tier                                  blendPerRow 2.02 / 1.14   sharpness  76 / 102
// The low tier was the reported case: it carried 3.4x fewer partially covered pixels than the
// high tier on the SAME frame, which is the staircase the eye reads as 锯齿.
//
//   node tools/contour-aa-probe.mjs                     # full matrix, artifacts/contour-aa
//   node tools/contour-aa-probe.mjs --tier low --viewport 390x844 --dsf 1
//   node tools/contour-aa-probe.mjs --cases mobile-low,mobile-high
//
// Pitfalls this driver already handles, do not re-solve them:
//   - Headless Edge reports `devicePixelRatio` from the emulation override, so `--dsf 3` is how
//     a real phone's DPR is reproduced. The drawing buffer is read back and printed, never
//     assumed from `quality.pixelRatioMax`.
//   - The tier is chosen at module load, so forcing one means a fresh document: the override is
//     registered as a new-document script before navigating.
//   - The board's idle float and the scenery clock are pinned before the capture, otherwise two
//     runs of the same build photograph the cube at different heights and the row band moves.
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { readPng } from './png-read.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
]
const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
const url = (process.argv.find((a) => a.startsWith('http')) || 'http://localhost:5173/').replace(/\/?$/, '/')

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}

const CASES = [
  { name: 'mobile-low', width: 390, height: 844, dsf: 1, tier: 'low' },
  { name: 'mobile-high', width: 390, height: 844, dsf: 1, tier: 'high' },
  { name: 'mobile-dpr3-low', width: 390, height: 844, dsf: 3, tier: 'low' },
  { name: 'desktop-high', width: 1440, height: 900, dsf: 1, tier: 'high' },
]
const only = (arg('cases') || '').split(',').map((s) => s.trim()).filter(Boolean)
const tierOverride = arg('tier')
const viewportOverride = arg('viewport')
const dsfOverride = arg('dsf')
const selected = CASES.filter((c) => {
  if (only.length) return only.includes(c.name)
  if (viewportOverride) {
    const [w, h] = viewportOverride.split('x').map(Number)
    if (c.width !== w || c.height !== h) return false
  }
  if (tierOverride && c.tier !== tierOverride) return false
  if (dsfOverride && c.dsf !== Number(dsfOverride)) return false
  return true
})
if (!selected.length) throw new Error('no probe case selected')

const outDir = resolve(ROOT, arg('out', 'artifacts/contour-aa'))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function connect(wsUrl) {
  return new Promise((resolve_, reject) => {
    const socket = new WebSocket(wsUrl)
    socket.addEventListener('open', () => resolve_(socket))
    socket.addEventListener('error', (event) => reject(new Error(`websocket error: ${event.message ?? 'unknown'}`)))
  })
}

const pending = new Map()
function send(socket, id, method, params = {}) {
  return new Promise((resolve_, reject) => {
    pending.set(id, { resolve: resolve_, reject })
    socket.send(JSON.stringify({ id, method, params }))
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`${method} timed out`))
    }, 30000)
  })
}

function pipe(socket) {
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    const slot = pending.get(message.id)
    if (!slot) return
    pending.delete(message.id)
    if (message.error) slot.reject(new Error(`${JSON.stringify(message.error)}`))
    else slot.resolve(message.result)
  })
}

const LUM = (p, i) => 0.2126 * p[i] + 0.7152 * p[i + 1] + 0.0722 * p[i + 2]
const DARK = 140

// One row of the cube's silhouette: the OUTERMOST dark run whose inner neighbour is a bright
// block. The `outside`/`outside2` samples are the two pixels away from the cube, which is where
// a sub-pixel-resolved edge leaves its blend. `undefined` when the row misses the cube.
function strokeOn(image, y, x0, x1, side) {
  const { width, channels, pixels } = image
  const at = (x) => (y * width + x) * channels
  const forward = side === 'left'
  const inRange = (x) => x >= x0 && x <= x1
  const step = forward ? 1 : -1
  let x = forward ? x0 : x1
  while (inRange(x)) {
    if (LUM(pixels, at(x)) >= DARK) { x += step; continue }
    let far = x
    while (inRange(far + step) && LUM(pixels, at(far + step)) < DARK) far += step
    // `inner` is the pixel on the cube side of the run, `outer` the first pixel off the cube.
    const innerX = far + step
    const outerX = x - step
    const outerX2 = x - 2 * step
    const inside = inRange(innerX) ? LUM(pixels, at(innerX)) : 0
    const outside = inRange(outerX) ? LUM(pixels, at(outerX)) : null
    const outside2 = inRange(outerX2) ? LUM(pixels, at(outerX2)) : null
    if (inside > 165 && outside !== null && outside >= DARK) {
      return { start: Math.min(x, far), end: Math.max(x, far), bandWidth: Math.abs(far - x) + 1, outside, outside2, inside }
    }
    x = far + step
  }
  return null
}

function analyse(image, band, side) {
  const rows = []
  for (let y = band.from; y <= band.to; y += 1) {
    const hit = strokeOn(image, y, band.x0, band.x1, side)
    if (hit) rows.push({ y, ...hit })
  }
  if (rows.length < 20) {
    throw new Error(`only ${rows.length} contour rows sampled on the ${side} edge — the band is not on the cube; refusing to report a metric`)
  }
  const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b)
    return sorted[Math.floor(sorted.length / 2)]
  }
  // The blend read-out is taken from a 4-pixel window straddling the OUTER boundary of the
  // stroke. A partially covered pixel must land between the ink's own luminance (~45) and the
  // background's (~200), so counting pixels in (70, 170) counts exactly the pixels that only a
  // sub-pixel-resolved rasteriser can produce. `edgeSharpness` is the largest single-pixel jump
  // in the same window: a hard edge moves the full ink→background distance in ONE step, an
  // anti-aliased one spreads it over at least two.
  const { width, channels, pixels } = image
  const lumAt = (x, y) => (x < 0 || x >= width ? null : LUM(pixels, (y * width + x) * channels))
  const forward = side === 'left'
  const step = forward ? 1 : -1
  const blendCounts = []
  const sharpness = []
  for (const row of rows) {
    const anchor = forward ? row.start : row.end
    let blends = 0
    let maxJump = 0
    let previous = lumAt(anchor - 2 * step, row.y)
    for (let k = -1; k <= 1; k += 1) {
      const current = lumAt(anchor + k * step, row.y)
      if (current === null || previous === null) { previous = current; continue }
      if (previous > 70 && previous < 170) blends += 1
      maxJump = Math.max(maxJump, Math.abs(current - previous))
      previous = current
    }
    if (previous !== null && previous > 70 && previous < 170) blends += 1
    blendCounts.push(blends)
    sharpness.push(maxJump)
  }
  const steps = { 0: 0, 1: 0, 2: 0, more: 0 }
  for (let i = 1; i < rows.length; i += 1) {
    const delta = Math.abs(rows[i].start - rows[i - 1].start)
    if (delta > 2) steps.more += 1
    else steps[delta] += 1
  }
  return {
    rows: rows.length,
    bandWidthPx: median(rows.map((r) => r.bandWidth)),
    bandWidthMin: Math.min(...rows.map((r) => r.bandWidth)),
    bandWidthMax: Math.max(...rows.map((r) => r.bandWidth)),
    blendPerRow: Number((blendCounts.reduce((a, b) => a + b, 0) / rows.length).toFixed(3)),
    blendRowFrac: Number((blendCounts.filter((n) => n > 0).length / rows.length).toFixed(3)),
    edgeSharpness: median(sharpness),
    outsideLumMedian: median(rows.map((r) => Math.round(r.outside))),
    insideLumMedian: median(rows.map((r) => Math.round(r.inside))),
    stepHistogram: steps,
  }
}

async function capture(browser, probeCase) {
  const { width, height, dsf, tier, name } = probeCase
  const profile = mkdtempSync(join(tmpdir(), 'voxalblast-contour-'))
  const child = spawn(browser, [
    '--headless=new', '--disable-gpu', '--disable-breakpad', '--hide-scrollbars',
    '--no-first-run', '--no-default-browser-check',
    '--run-all-compositor-stages-before-draw',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`, 'about:blank',
  ], { stdio: 'ignore', windowsHide: true })
  let startupError = null
  child.on('error', (error) => { startupError = error })
  try {
    let port = null
    for (let i = 0; i < 80; i += 1) {
      if (startupError) throw startupError
      try {
        port = Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0])
        await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
        break
      } catch { port = null; await sleep(250) }
    }
    if (!port) throw new Error('browser never opened a debugging port')
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json()
    const ws = await connect(target.webSocketDebuggerUrl)
    pipe(ws)
    await send(ws, 1, 'Page.enable')
    await send(ws, 2, 'Runtime.enable')
    await send(ws, 3, 'Page.addScriptToEvaluateOnNewDocument', {
      source: `globalThis.__voxalblastQuality = ${JSON.stringify(tier)};`
        + `(() => { let seed = 20260916; Math.random = () => {
          seed = (seed + 0x6d2b79f5) >>> 0;
          let value = Math.imul(seed ^ (seed >>> 15), seed | 1);
          value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
          return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
        }; })();`,
    })
    await send(ws, 4, 'Emulation.setDeviceMetricsOverride', {
      width, height, screenWidth: width, screenHeight: height, deviceScaleFactor: dsf, mobile: width < 600,
    })
    await send(ws, 5, 'Page.navigate', { url })
    await sleep(3600)

    let nextId = 200
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const read = await send(ws, nextId++, 'Runtime.evaluate', {
        expression: 'JSON.stringify((() => { const i = globalThis.__voxalblast?.intro?.(); return i ? { active: i.active } : null })())',
        returnByValue: true,
      })
      const raw = read.result?.value
      const wave = raw && raw !== 'null' ? JSON.parse(raw) : null
      if (wave && !wave.active) break
      await sleep(150)
    }
    await send(ws, nextId++, 'Runtime.evaluate', {
      expression: '(() => { const d = globalThis.__voxalblastDev; if (!d) return "no-dev-handle";'
        + ' return { board: d.setBoardFloat?.({ frozen: true, time: 0 }) ?? null,'
        + ' ambient: d.setAmbient?.({ frozen: true, time: 0 }) ?? null }; })()',
      returnByValue: true,
    })
    await send(ws, nextId++, 'Runtime.evaluate', {
      expression: 'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))', awaitPromise: true,
    })
    await sleep(400)

    const facts = await send(ws, nextId++, 'Runtime.evaluate', {
      expression: `JSON.stringify((() => {
        try {
          const canvas = document.querySelector('#world-canvas')
          const gl = canvas && canvas.getContext('webgl2')
          const dev = globalThis.__voxalblast
          return {
            bounds: dev.bounds(),
            lowPower: dev.rendering().lowPower,
            drawingBuffer: canvas ? { width: canvas.width, height: canvas.height } : null,
            cssSize: canvas ? { width: canvas.clientWidth, height: canvas.clientHeight } : null,
            dpr: devicePixelRatio,
            maxSamples: gl ? gl.getParameter(gl.MAX_SAMPLES) : null,
            multisampled: gl ? gl.getParameter(gl.SAMPLES) : null,
          }
        } catch (error) {
          return {
            error: String(error && error.message || error),
            handles: { readOnly: typeof globalThis.__voxalblast, dev: typeof globalThis.__voxalblastDev },
            readyState: document.readyState,
            url: location.href,
            pageErrors: globalThis.__errs ?? null,
          }
        }
      })())`,
      returnByValue: true,
    })
    const factsValue = typeof facts.result?.value === 'string'
      ? JSON.parse(facts.result.value)
      : (() => { throw new Error(`page facts unavailable: ${JSON.stringify(facts).slice(0, 600)}`) })()
    if (factsValue.error) throw new Error(`page facts failed on ${name}: ${JSON.stringify(factsValue).slice(0, 600)}`)
    const shot = await send(ws, nextId++, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    mkdirSync(outDir, { recursive: true })
    const out = join(outDir, `v${version}-${name}.png`)
    writeFileSync(out, Buffer.from(shot.data, 'base64'))
    await send(ws, 1000, 'Browser.close').catch(() => {})
    ws.close()
    return { out, facts: factsValue }
  } finally {
    await new Promise((done) => {
      if (child.exitCode !== null) return done()
      child.once('exit', done)
      setTimeout(() => { try { child.kill() } catch {} }, 3000)
    })
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 }) } catch {}
  }
}

const browser = EDGE_CANDIDATES.find((candidate) => {
  try { readFileSync(candidate); return true } catch { return false }
})
if (!browser) throw new Error('no Edge/Chrome binary found')

const results = []
for (const probeCase of selected) {
  const { out, facts } = await capture(browser, probeCase)
  const image = readPng(out)
  const { bounds } = facts
  // Emulation coordinates are CSS px; the PNG is device px. The factor is measured from the
  // image the browser actually returned, not from the requested `dsf`.
  const scale = image.width / probeCase.width
  const pad = 4
  const x0 = Math.max(0, Math.round(bounds.minX * scale) - pad)
  const x1 = Math.min(image.width - 1, Math.round(bounds.maxX * scale) + pad)
  const top = Math.max(0, Math.round(bounds.minY * scale))
  const bottom = Math.min(image.height - 1, Math.round(bounds.maxY * scale))
  const height = bottom - top
  const band = {
    x0, x1,
    from: Math.round(top + height * 0.32),
    to: Math.round(top + height * 0.68),
  }
  const left = analyse(image, band, 'left')
  const right = analyse(image, band, 'right')
  results.push({
    case: probeCase.name,
    viewport: `${probeCase.width}x${probeCase.height}`,
    dpr: facts.dpr,
    tier: facts.lowPower ? 'low' : 'high',
    drawingBuffer: facts.drawingBuffer,
    maxSamples: facts.maxSamples,
    glSamples: facts.multisampled,
    cubeScreen: { x: Math.round(bounds.maxX - bounds.minX), y: Math.round(bounds.maxY - bounds.minY) },
    left,
    right,
    png: out.replace(/\\/g, '/'),
  })
}

console.log(JSON.stringify(results, null, 2))
const failing = results.filter((r) => Math.min(r.left.blendPerRow, r.right.blendPerRow) < 0.8)
const rough = results.filter((r) => Math.min(r.left.blendRowFrac, r.right.blendRowFrac) < 0.7)
console.log(failing.length
  ? `\nCONTOUR-AA: ${failing.length}/${results.length} case(s) alias — fewer than .8 partially covered pixels per silhouette row`
  : `\nCONTOUR-AA: ${results.length}/${results.length} case(s) anti-aliased on both silhouettes`)
if (rough.length) {
  console.log(`CONTOUR-AA note: ${rough.map((r) => r.case).join(', ')} still has rows with no blend pixel (blendRowFrac < .7) — the shipped desktop tier measured .72-.79`)
}

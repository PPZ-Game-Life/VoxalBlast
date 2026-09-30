// G0 + G1 pedestal-grounding probe — docs/Technical/MATERIAL_GROUNDING_REWORK_HANDOFF.md §4/§5.
//
//   node tools/material-grounding-probe.mjs [--stage=all|g0|g1a|g1b] [--views=desktop,mobile]
//                                          [--tier=high|low|auto] [--url=...] [--out=...]
//   npm run probe:grounding                  (needs `node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5173`)
//
// What it is for: the handoff refuses to accept "3D support looks better" as an argument. It
// asks for a frozen, comparable baseline (G0) and then for CONTROLLED comparisons that switch
// ONE term at a time (G1a: SSAO / the contact decal / the projected receiver; G1b: painted
// pedestal vs a plain 3D slab), plus a quantitative gate on the thing a slab is most likely to
// break — the turning cube going through it.
//
// Everything it drives is a DEV-only presentation switch (`__voxalblastDev.grounding`) or a
// real pointer gesture. No board cell, score, hand, camera or framing number is touched, and
// the page is a throwaway browser profile with a fixture-injected save, never the player's.
//
// Output: <out>/<view>-<tier>/<condition>.png plus <out>/report-<view>-<tier>.json.
//
// Pitfalls already handled (do not re-solve):
//   - Device emulation, not --window-size, establishes the mobile viewport; PNG dimensions and
//     the CSS layout box are both recorded so a crop cannot silently pass as a phone.
//   - One browser per (view, tier) with many captures inside it: re-booting per shot would put
//     each frame in a different browser state, which is exactly what a comparison cannot have.
//   - Software rendering (--disable-gpu) means the frame times are a RELATIVE baseline on this
//     machine, not a device measurement; the report says so where the numbers are written.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { readPng } from './png-read.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
const BROWSER_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
]
const BROWSER = BROWSER_CANDIDATES.find((path) => path && existsSync(path))
if (!BROWSER) throw new Error(`no headless browser found; tried:\n  ${BROWSER_CANDIDATES.join('\n  ')}`)

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const hit = args.find((arg) => arg.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}
const STAGE = option('stage', 'all')
const TIER = option('tier', 'auto')
// §9.2 asks for the same device graded at BOTH tiers, so the default matrix is both of them.
const TIERS = option('tiers', TIER === 'auto' ? 'high,low' : TIER).split(',').map((t) => t.trim()).filter(Boolean)
for (const tier of TIERS) if (!['high', 'low'].includes(tier)) throw new Error(`unknown tier '${tier}'; known: high, low`)
const URL_ = option('url', 'http://127.0.0.1:5173/').replace(/\/?$/, '/')
const OUT = resolve(ROOT, option('out', 'artifacts/material-grounding'))
const SEED = Number(option('seed', 20260930))

// §9.2: 1440x900 and 390x844 are the two main acceptances; 1280x720 is the desktop minimum
// height the default screenshot list does not cover, and 844x390 is the phone in landscape.
const VIEWS = {
  desktop: { width: 1440, height: 900 },
  desktop720: { width: 1280, height: 720 },
  mobile: { width: 390, height: 844 },
  landscape: { width: 844, height: 390 },
}
const viewNames = option('views', 'desktop,mobile,desktop720').split(',').map((n) => n.trim()).filter(Boolean)
for (const name of viewNames) if (!VIEWS[name]) throw new Error(`unknown view '${name}'; known: ${Object.keys(VIEWS).join(', ')}`)

const FIXTURES = {
  empty: resolve(ROOT, 'tools/fixtures/material-grounding-empty.json'),
  rgb: resolve(ROOT, 'tools/fixtures/material-grounding-rgb.json'),
}
for (const [key, path] of Object.entries(FIXTURES)) {
  if (!existsSync(path)) throw new Error(`${key} fixture missing (${path}); run: node tools/material-grounding-fixtures.mjs`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')

// ---------------------------------------------------------------- CDP plumbing
function send(ws, id, method, params = {}) {
  return new Promise((resolve_, reject) => {
    const finish = (error, result) => {
      clearTimeout(timeout)
      ws.removeEventListener('message', onMessage)
      ws.removeEventListener('close', onClose)
      if (error) reject(error)
      else resolve_(result)
    }
    const onMessage = (event) => {
      const msg = JSON.parse(event.data)
      if (msg.id !== id) return
      finish(msg.error ? new Error(`${method}: ${JSON.stringify(msg.error)}`) : null, msg.result)
    }
    const onClose = () => finish(new Error(`${method}: debugger connection closed`))
    const timeout = setTimeout(() => finish(new Error(`${method}: timed out`)), 30000)
    ws.addEventListener('message', onMessage)
    ws.addEventListener('close', onClose, { once: true })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function connect(endpoint) {
  const ws = new WebSocket(endpoint)
  await new Promise((ok, no) => {
    const timeout = setTimeout(() => { ws.close(); no(new Error('debugger connection timed out')) }, 8000)
    ws.addEventListener('open', () => { clearTimeout(timeout); ok() }, { once: true })
    ws.addEventListener('error', (error) => { clearTimeout(timeout); no(error) }, { once: true })
  })
  return ws
}

async function waitForExit(child, timeoutMs = 6000) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return true
  return new Promise((ok) => {
    const done = () => { clearTimeout(timeout); ok(true) }
    const timeout = setTimeout(() => { child.removeListener('exit', done); ok(false) }, timeoutMs)
    child.once('exit', done)
  })
}

async function closeBrowser(child, browserSocket, pageSocket, profile) {
  if (browserSocket?.readyState === WebSocket.OPEN) await send(browserSocket, 1, 'Browser.close').catch(() => {})
  if (pageSocket?.readyState === WebSocket.OPEN) pageSocket.close()
  if (browserSocket?.readyState === WebSocket.OPEN) browserSocket.close()
  let exited = await waitForExit(child)
  if (!exited && child.pid) {
    if (process.platform === 'win32') {
      const cleanup = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      cleanup.on('error', () => {})
      await waitForExit(cleanup)
    } else child.kill('SIGTERM')
    exited = await waitForExit(child)
  }
  if (!exited) throw new Error(`capture browser did not exit; retained profile ${profile}`)
  const tempRoot = realpathSync(tmpdir())
  const actualProfile = realpathSync(profile)
  const suffix = relative(tempRoot, actualProfile)
  if (!suffix || suffix.startsWith('..') || basename(actualProfile).indexOf('voxalblast-grounding-') !== 0) {
    throw new Error(`refusing to remove profile outside capture temp directory: ${actualProfile}`)
  }
  try {
    rmSync(actualProfile, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
  } catch (error) {
    if (!['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'].includes(error.code)) throw error
    console.warn(`WARN cleanup: retained locked temp profile ${actualProfile} (${error.code})`)
  }
}

// ---------------------------------------------------------------- page helpers
const READOUT = `JSON.stringify({
  rendering: globalThis.__voxalblast.rendering(),
  rotation: globalThis.__voxalblast.rotation(),
  framing: globalThis.__voxalblast.framing(),
  placement: globalThis.__voxalblast.placement(),
  board: globalThis.__voxalblast.board(),
  intro: globalThis.__voxalblast.intro(),
  viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
  pedestalArt: (() => {
    const el = document.querySelector('.garden-pedestal')
    if (!el) return null
    const r = el.getBoundingClientRect()
    const style = getComputedStyle(el)
    return { visibility: style.visibility, displayed: style.display, width: r.width, height: r.height, top: r.top, left: r.left, loaded: el.complete && el.naturalWidth > 0 }
  })(),
})`

// Frame-time recorder. The clock is the rAF timestamp itself: the rAF callback can be handed a
// timestamp EARLIER than performance.now() inside the same frame (v0.9.29's lesson), so mixing
// the two would produce a negative first delta. Only the rAF clock is used here.
const frameRecorder = (frames) => `new Promise((resolve) => {
  const deltas = []
  let last = null
  let count = 0
  const step = (t) => {
    if (last !== null) deltas.push(t - last)
    last = t
    count += 1
    if (count < ${frames}) requestAnimationFrame(step)
    else resolve(JSON.stringify(deltas))
  }
  requestAnimationFrame(step)
})`

const waitFrames = 'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))'

function percentile(values, fraction) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round(fraction * (sorted.length - 1))))
  return Number(sorted[index].toFixed(2))
}

// A quaternion rotated box corner — the interpenetration check needs the turning cube's lowest
// point, and `rotation().pose` is the pose the renderer actually drew. Manual quaternion maths
// keeps this file free of a three.js import (it is a node-side reader, not a renderer).
function lowCornerY(quat, extent) {
  const [x, y, z, w] = quat
  let lowest = Infinity
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    const vx = sx * extent, vy = sy * extent, vz = sz * extent
    // v' = v + 2 * q_v x (q_v x v + w v)
    const tx = 2 * (y * vz - z * vy)
    const ty = 2 * (z * vx - x * vz)
    const tz = 2 * (x * vy - y * vx)
    const outY = vy + w * ty + (z * tx - x * tz)
    if (outY < lowest) lowest = outY
  }
  return lowest
}

function rectOf(framing, view) {
  const canvas = framing.canvas
  return { canvas, solid: framing.solid, view }
}

// Region presets for the A/B diffs. A whole-frame difference only says "something moved"; the
// handoff (§5 G1a) asks WHERE. `cube` is the interior the two scene passes act on; `support` is
// the band from just above the cube's bottom edge down through the painted ledge.
//
// Coordinates: `framing.solid` is already in CLIENT (page) pixels — gameScene's projectCubeBounds
// adds the canvas rect's own left/top — and a capture is the whole page, so the two agree and the
// only clamp needed is against the image itself. `canvas` is used for its box, not as an origin.
function regionsFor(framing, image) {
  const solid = framing.solid
  const box = framing.canvas
  const maxX = image.width - 1
  const maxY = image.height - 1
  const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, Math.round(value)))
  return {
    cube: {
      x0: clamp(solid.minX, 0, maxX),
      y0: clamp(solid.minY, 0, maxY),
      x1: clamp(solid.maxX, 0, maxX),
      y1: clamp(solid.maxY, 0, maxY),
    },
    support: {
      x0: clamp(box.left, 0, maxX),
      y0: clamp(solid.maxY - box.height * 0.10, 0, maxY),
      x1: clamp(box.left + box.width - 1, 0, maxX),
      y1: clamp(solid.maxY + box.height * 0.22, 0, maxY),
    },
  }
}

// Same measurement as tools/frame-diff.mjs (which stays a CLI): how many pixels moved by more
// than N levels, and where.
function diffBox(a, b, box) {
  const { x0, y0, x1, y1 } = box
  const channels = a.channels
  const thresholds = [2, 8, 16, 32]
  const counts = thresholds.map(() => 0)
  let sum = 0
  let max = 0
  let samples = 0
  const moved = { minX: x1, minY: y1, maxX: x0, maxY: y0 }
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const i = (y * a.width + x) * channels
      let delta = 0
      for (let c = 0; c < Math.min(3, channels); c += 1) delta = Math.max(delta, Math.abs(a.pixels[i + c] - b.pixels[i + c]))
      sum += delta
      samples += 1
      if (delta > max) max = delta
      thresholds.forEach((t, index) => { if (delta > t) counts[index] += 1 })
      if (delta > 2) {
        if (x < moved.minX) moved.minX = x
        if (x > moved.maxX) moved.maxX = x
        if (y < moved.minY) moved.minY = y
        if (y > moved.maxY) moved.maxY = y
      }
    }
  }
  return {
    pixels: samples,
    over: Object.fromEntries(thresholds.map((t, index) => [t, counts[index]])),
    meanDelta: samples ? Number((sum / samples).toFixed(3)) : null,
    maxDelta: max,
    movedBBox: counts[0] ? moved : null,
  }
}

// ---------------------------------------------------------------- one browser session
async function runSession({ viewName, tier, report }) {
  const view = VIEWS[viewName]
  const outDir = join(OUT, `${viewName}-${tier}`)
  mkdirSync(outDir, { recursive: true })
  const profile = mkdtempSync(join(tmpdir(), 'voxalblast-grounding-'))
  const child = spawn(BROWSER, [
    '--headless=new', '--disable-gpu', '--disable-breakpad', '--hide-scrollbars',
    '--no-first-run', '--no-default-browser-check', '--force-device-scale-factor=1',
    '--run-all-compositor-stages-before-draw',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    `--window-size=${view.width},${view.height}`, 'about:blank',
  ], { stdio: 'ignore', windowsHide: true })
  let ws = null
  let browserSocket = null
  let captureError = null
  let id = 100
  const browserErrors = []

  try {
    let browserInfo = null
    let port = 0
    for (let i = 0; i < 80; i += 1) {
      try {
        port = Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0])
        browserInfo = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
        break
      } catch { await sleep(250) }
    }
    if (!browserInfo) throw new Error('devtools never came up')
    browserSocket = await connect(browserInfo.webSocketDebuggerUrl)
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json()
    ws = await connect(target.webSocketDebuggerUrl)
    ws.addEventListener('message', (event) => {
      const { method, params } = JSON.parse(event.data)
      if (method === 'Runtime.consoleAPICalled' && params.type === 'error') {
        browserErrors.push(`console.error: ${params.args.map((a) => a.value ?? a.description ?? a.type).join(' ')}`)
      } else if (method === 'Log.entryAdded' && params.entry.level === 'error') {
        browserErrors.push(`${params.entry.source}.error: ${params.entry.text}`)
      }
    })

    const next = () => { id += 1; return id }
    const evalIn = async (expression, awaitPromise = false) => {
      const result = await send(ws, next(), 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
      if (result.exceptionDetails) throw new Error(`page threw: ${result.exceptionDetails.text ?? ''} ${JSON.stringify(result.exceptionDetails.exception?.description ?? '')}`)
      return result.result?.value
    }
    const readout = async () => JSON.parse(await evalIn(READOUT))
    const settle = () => evalIn(waitFrames, true)

    const capture = async (name, clip) => {
      await settle()
      const shot = await send(ws, next(), 'Page.captureScreenshot', {
        format: 'png', captureBeyondViewport: false, ...(clip ? { clip: { ...clip, scale: 1 } } : {}),
      })
      const file = join(outDir, `${name}.png`)
      const buffer = Buffer.from(shot.data, 'base64')
      writeFileSync(file, buffer)
      return { file: relative(ROOT, file).replace(/\\/g, '/'), bytes: buffer.length }
    }

    await send(ws, next(), 'Page.enable')
    await send(ws, next(), 'Runtime.enable')
    await send(ws, next(), 'Log.enable')

    // Everything a capture needs is injected before any page script runs: the frozen save, the
    // seed, and (DEV only) the forced quality tier.
    const bootScript = [
      tier === 'auto' ? '' : `globalThis.__voxalblastQuality = ${JSON.stringify(tier)};`,
      `(() => { let seed = ${SEED}; Math.random = () => {`,
      '  seed = (seed + 0x6d2b79f5) >>> 0;',
      '  let value = Math.imul(seed ^ (seed >>> 15), seed | 1);',
      '  value ^= value + Math.imul(value ^ (value >>> 7), value | 61);',
      '  return ((value ^ (value >>> 14)) >>> 0) / 4294967296;',
      '}; })();',
    ].join('\n')
    await send(ws, next(), 'Page.addScriptToEvaluateOnNewDocument', { source: bootScript })
    await send(ws, next(), 'Emulation.setDeviceMetricsOverride', {
      width: view.width, height: view.height, screenWidth: view.width, screenHeight: view.height, deviceScaleFactor: 1, mobile: view.width < 600,
    })

    // One session per stage/route: the previous fixture script is REMOVED before the next one is
    // installed, so a later navigation cannot run two save injectors in whatever order they
    // happen to have been added.
    let fixtureScript = null
    const loadFixture = async (key) => {
      const fixture = JSON.parse(readFileSync(FIXTURES[key], 'utf8'))
      if (fixtureScript) await send(ws, next(), 'Page.removeScriptToEvaluateOnNewDocument', { identifier: fixtureScript })
      const installed = await send(ws, next(), 'Page.addScriptToEvaluateOnNewDocument', {
        source: `localStorage.setItem('voxalblast.session.v1', ${JSON.stringify(JSON.stringify(fixture.snapshot))});`,
      })
      fixtureScript = installed.identifier
      await send(ws, next(), 'Page.navigate', { url: URL_ })
      await sleep(3600)
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const wave = JSON.parse(await evalIn('JSON.stringify((() => { const i = globalThis.__voxalblast?.intro?.(); return i ? { active: i.active } : null })())') || 'null')
        if (wave && !wave.active) break
        await sleep(150)
      }
      const state = await readout()
      if (JSON.stringify(state.board.cells) !== JSON.stringify(fixture.expectedBoard.cells)) {
        throw new Error(`${viewName}/${tier}: fixture '${key}' did not resume (${state.board.cells.length} cells on the board, expected ${fixture.expectedBoard.cells.length})`)
      }
      if (!state.rendering.grounding) {
        throw new Error(`the grounding diagnostics are missing — is the page a DEV build? rendering keys: ${Object.keys(state.rendering).join(', ')}`)
      }
      baselineOcclusion = state.rendering.grounding.occlusionIntensity
      baselineShape = state.rendering.contactShadows.pedestal?.contactShape ?? 'footprint'
      return state
    }

    let baselineOcclusion = null
    let baselineShape = null
    const applyState = async ({ route = 'art', ssao, contact = true, projected = true, pose = null, occlusion = null, shape = null }) => {
      const expression = `(() => {
        const g = globalThis.__voxalblastDev.grounding
        g.route(${JSON.stringify(route)})
        g.contactDecal(${contact})
        g.projectedShadow(${projected})
        ${ssao === undefined || ssao === null ? '' : `g.ssao(${ssao})`}
        g.occlusion(${occlusion === null ? baselineOcclusion ?? 'undefined' : occlusion})
        g.contactShape(${JSON.stringify(shape ?? baselineShape ?? 'footprint')})
        ${pose ? pose.expression : 'g.release()'}
        return JSON.stringify(g.report())
      })()`
      return JSON.parse(await evalIn(expression))
    }

    // Real pointer gestures, through the shipped input path — the probe never writes an angle.
    const gesture = (() => {
      const point = { x: 0, y: 0 }
      return {
        async prime() {
          const framing = JSON.parse(await evalIn('JSON.stringify(__voxalblast.framing())'))
          const bounds = JSON.parse(await evalIn('JSON.stringify(__voxalblast.bounds())'))
          point.x = (bounds.minX + bounds.maxX) / 2
          point.y = bounds.minY * 0.3 + bounds.maxY * 0.7
          return { span: bounds.maxX - bounds.minX, framing }
        },
        async press() {
          await send(ws, next(), 'Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 })
        },
        async moveTo(fraction, span, y = null) {
          const steps = 8
          for (let step = 1; step <= steps; step += 1) {
            await send(ws, next(), 'Input.dispatchMouseEvent', {
              type: 'mouseMoved', x: point.x + (fraction * span * step) / steps, y: y ?? point.y, button: 'left', buttons: 1,
            })
          }
        },
        async release() {
          await send(ws, next(), 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 })
        },
      }
    })()

    const dragFineTune = async (fraction) => {
      const { span } = await gesture.prime()
      await gesture.press()
      await gesture.moveTo(fraction, span)
      await settle()
      const held = await readout()
      await gesture.release()
      await sleep(320)
      return { held, kept: await readout() }
    }

    const dragFullFlip = async (fraction = 0.25) => {
      const { span } = await gesture.prime()
      await gesture.press()
      await gesture.moveTo(fraction, span)
      await gesture.release()
      await sleep(420)
      return readout()
    }

    const measureStatic = async (frames = 90) => JSON.parse(await evalIn(frameRecorder(frames), true))
    const measureTurning = async (flips = 4, frames = 200) => {
      const recorder = evalIn(frameRecorder(frames), true)
      for (let i = 0; i < flips; i += 1) {
        await dragFullFlip(0.25)
        await sleep(120)
      }
      return JSON.parse(await recorder)
    }

    const recordFrame = async (entry, state, timing) => {
      const shot = await capture(entry.id)
      const readouts = await readout()
      const row = {
        ...entry,
        view: viewName,
        viewport: view,
        tier,
        file: shot.file,
        bytes: shot.bytes,
        state,
        readouts,
        frameTiming: timing || null,
      }
      if (entry.crops) {
        const centre = readouts.placement.center
        const u = readouts.placement.uAxis
        // `vAxis.dy` is UP-positive (NDC convention), so a +v step — which is screen-DOWN in the
        // shipped placement — is a NEGATIVE dy. Both crops below therefore move along -v.
        const v = readouts.placement.vAxis
        const cellPx = Math.hypot(u.dx, u.dy)
        const faceSize = Math.round(cellPx * 3)
        const face = await capture(`${entry.id}-cropface`, {
          x: centre.x - faceSize / 2, y: centre.y - faceSize / 2, width: faceSize, height: faceSize,
        })
        // The bottom-left rows of the front face: the one place on the coloured board where bare
        // timber and paint sit side by side (the fixture's two deliberate gaps). Cell (1,0) is one
        // step left along u and two steps down along v from the face centre (2,2).
        const woodSize = Math.round(cellPx * 2.6)
        const woodX = centre.x - u.dx
        const woodY = centre.y - 2 * v.dy
        const woodShot = await capture(`${entry.id}-cropwood`, {
          x: woodX - woodSize / 2, y: woodY - woodSize / 2, width: woodSize, height: woodSize,
        })
        row.crops = { face: face.file, wood: woodShot.file }
      }
      // The flip gate's own crop: the cube's bottom-front EDGE, where a mid-turn pose leaves the
      // support plane. Everything else in the frame can hide that behind the support's own rim.
      if (entry.flipCrop) {
        const p = readouts.placement
        const v = p.vAxis
        const step = Math.hypot(v.dx, v.dy)
        const edgeY = p.center.y - 2.5 * v.dy
        const size = Math.round(step * 2.6)
        const shot = await capture(`${entry.id}-cropbase`, {
          x: Math.round(p.center.x - size / 2), y: Math.round(edgeY - size * 0.45), width: size, height: size,
        })
        row.crops = { ...(row.crops || {}), base: shot.file }
      }
      report.conditions.push(row)
      return row
    }

    // ---------------------------------------------------------------- conditions
    const stageAll = STAGE === 'all'
    const wantG0 = stageAll || STAGE === 'g0'
    const wantG1a = stageAll || STAGE === 'g1a'
    const wantG1b = stageAll || STAGE === 'g1b'
    const wantG1c = stageAll || STAGE === 'g1c'

    const autoTierDefault = tier === 'high' ? true : tier === 'low' ? false : null

    if (wantG0) {
      await loadFixture('empty')
      const emptyState = await applyState({ route: 'art', ssao: autoTierDefault, contact: true, projected: true })
      await recordFrame({ id: 'g0-empty-dock', stage: 'G0', note: 'empty board, default dock' }, emptyState, {
        static: null,
      })
      report.conditions[report.conditions.length - 1].frameTiming = { static: summarize(await measureStatic()) }

      await loadFixture('rgb')
      const dockState = await applyState({ route: 'art', ssao: autoTierDefault, contact: true, projected: true })
      const dockRow = await recordFrame({ id: 'g0-rgb-dock', stage: 'G0', crops: true, note: 'coloured save, default dock' }, dockState)
      dockRow.frameTiming = { static: summarize(await measureStatic()) }
      dockRow.fixtureBoardHash = sha256(JSON.stringify(dockRow.readouts.board.cells))

      // Micro-adjust, measured as an offset from the DOCK on both sides: the left drag leaves the
      // bearing 9.9° below the dock, and the same drag to the right is applied twice — once to walk
      // the bearing back to the dock, once to be the recorded right-hand sample. (The bearing is
      // committed on release, so a second drag started from the left state would otherwise only
      // cancel the first one out and look like "the right drag does nothing".)
      const left = await dragFineTune(-0.09)
      await recordFrame({ id: 'g0-rgb-yaw-left', stage: 'G0', note: 'fine tune kept, bearing below the dock' }, await applyState({ route: 'art', ssao: autoTierDefault }), null)
      report.conditions[report.conditions.length - 1].gesture = { heldPose: left.held.rotation, keptPose: left.kept.rotation }

      await dragFineTune(0.09)
      const right = await dragFineTune(0.09)
      await recordFrame({ id: 'g0-rgb-yaw-right', stage: 'G0', note: 'fine tune kept, bearing above the dock' }, await applyState({ route: 'art', ssao: autoTierDefault }), null)
      report.conditions[report.conditions.length - 1].gesture = { heldPose: right.held.rotation, keptPose: right.kept.rotation }

      // Does the held diagnostic pose really equal the pose a RELEASED turn settles on? Both are
      // composed as `bearingQuat · step(axis, angle) · cubeBase` from the same base, so the check
      // is a quaternion comparison — and because the two candidate directions (±90°) are 180°
      // apart, the comparison also says WHICH way the shipped gesture turns.
      await applyState({ route: 'art', ssao: autoTierDefault })
      const baseBeforeFlip = (await readout()).rotation.base
      await applyState({ route: 'art', ssao: autoTierDefault, pose: { expression: `g.hold('yaw', Math.PI / 2)` } })
      const heldPlus = (await readout()).rotation.pose
      await recordFrame({ id: 'g0-rgb-flip-end', stage: 'G0', note: 'held +90° yaw — the pose a released turn settles on' },
        await applyState({ route: 'art', ssao: autoTierDefault, pose: { expression: `g.hold('yaw', Math.PI / 2)` } }), null)
      await applyState({ route: 'art', ssao: autoTierDefault, pose: { expression: `g.hold('yaw', -Math.PI / 2)` } })
      const heldMinus = (await readout()).rotation.pose
      await applyState({ route: 'art', ssao: autoTierDefault })
      const realFlip = await dragFullFlip(0.25)
      const dot = (a, b) => Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3])
      const realPose = realFlip.rotation.pose
      const plusDot = dot(heldPlus, realPose)
      const minusDot = dot(heldMinus, realPose)
      const flipRow = await recordFrame({ id: 'g0-rgb-flip-real', stage: 'G0', note: 'a real released turn, settled' }, await applyState({ route: 'art', ssao: autoTierDefault }), null)
      flipRow.holdCheck = {
        baseBeforeFlip,
        baseAfterFlip: realFlip.rotation.base,
        heldPlus, heldMinus, realFlipPose: realPose,
        dotHeldPlus: Number(plusDot.toFixed(12)),
        dotHeldMinus: Number(minusDot.toFixed(12)),
        direction: plusDot > 1 - 1e-9 ? '+90' : minusDot > 1 - 1e-9 ? '-90' : 'neither',
      }

      await recordFrame({ id: 'g0-rgb-flip-mid', stage: 'G0', note: 'held 45 deg yaw (the mid-turn pose a real flip passes through)' }, await applyState({ route: 'art', ssao: autoTierDefault, pose: { expression: `g.hold('yaw', Math.PI / 4)` } }), null)
      await recordFrame({ id: 'g0-rgb-flip-mid-pitch', stage: 'G0', note: 'held 45 deg pitch' }, await applyState({ route: 'art', ssao: autoTierDefault, pose: { expression: `g.hold('pitch', Math.PI / 4)` } }), null)
      await applyState({ route: 'art', ssao: autoTierDefault })
      const turning = await measureTurning()
      await recordFrame({ id: 'g0-rgb-turning', stage: 'G0', note: 'four released flips; the continuous-rotation timing window' },
        await applyState({ route: 'art', ssao: autoTierDefault }), { turning: summarize(turning) })
    }

    if (wantG1a || wantG1b) {
      await loadFixture('rgb')
      const base = { route: 'art', contact: true, projected: true }

      if (wantG1a) {
        const variants = [
          { id: 'g1a-A-all', ssao: autoTierDefault ?? true, contact: true, projected: true, note: 'A: everything on' },
          { id: 'g1a-B-no-ssao', ssao: false, contact: true, projected: true, note: 'B: SSAO only' },
          { id: 'g1a-C-no-contact', ssao: autoTierDefault ?? true, contact: false, projected: true, note: 'C: contact decal only' },
          { id: 'g1a-D-no-projected', ssao: autoTierDefault ?? true, contact: true, projected: false, note: 'D: projected receiver only' },
          // Low tier only: the tier turns the two scene passes OFF (SHADOW_STYLE.lowPowerSSAO),
          // so A vs B is degenerate there. This row prices what the tier gives up, on the same
          // machine and the same frame.
          ...(tier === 'low'
            ? [{ id: 'g1a-E-low-ssao-on', ssao: true, contact: true, projected: true, note: 'E (low tier): the two scene passes forced on' }]
            : []),
          // A zero difference can mean "configured too gently" as easily as "not running": this
          // row cranks the occlusion blend far past the shipped value on the SAME frame.
          { id: 'g1a-F-occlusion-cranked', ssao: true, contact: true, projected: true, occlusion: 8, note: 'F: shipped SSAO with its blend cranked to 8' },
        ]
        for (const variant of variants) {
          const state = await applyState({
            route: 'art', ssao: variant.ssao, contact: variant.contact, projected: variant.projected, occlusion: variant.occlusion ?? null,
          })
          await recordFrame({ id: variant.id, stage: 'G1a', note: variant.note }, state, null)
        }
      }

      if (wantG1b) {
        const variants = [
          { id: 'g1b-art-ssao-on', route: 'art', ssao: autoTierDefault ?? true, contact: true, projected: true, note: 'painted pedestal, shipped look' },
          { id: 'g1b-art-ssao-off', route: 'art', ssao: false, contact: true, projected: true, note: 'painted pedestal, no SSAO (the comparable 2D baseline)' },
          { id: 'g1b-platform-plain', route: 'platform', ssao: false, contact: false, projected: false, note: '3D slab, no SSAO, no decal, no receiver' },
          { id: 'g1b-platform-decal', route: 'platform', ssao: false, contact: true, projected: false, note: '3D slab + contact decal' },
          { id: 'g1b-platform-ssao', route: 'platform', ssao: true, contact: false, projected: false, note: '3D slab + SSAO' },
          { id: 'g1b-platform-ssao-decal', route: 'platform', ssao: true, contact: true, projected: false, note: '3D slab + SSAO + decal' },
        ]
        for (const variant of variants) {
          const state = await applyState({ route: variant.route, ssao: variant.ssao, contact: variant.contact, projected: variant.projected })
          await recordFrame({ id: variant.id, stage: 'G1b', note: variant.note }, state, null)
        }

        // The flip gate: the same poses on both routes, so the interpenetration (if any) can be
        // read off the pose numbers AND seen on the frames.
        const poses = [
          { id: 'flip-yaw-mid', expression: `g.hold('yaw', Math.PI / 4)`, axis: 'yaw', deg: 45 },
          { id: 'flip-pitch-mid', expression: `g.hold('pitch', Math.PI / 4)`, axis: 'pitch', deg: 45 },
          { id: 'flip-yaw-end', expression: `g.hold('yaw', Math.PI / 2)`, axis: 'yaw', deg: 90 },
          { id: 'flip-pitch-end', expression: `g.hold('pitch', Math.PI / 2)`, axis: 'pitch', deg: 90 },
          { id: 'flip-roll-mid', expression: `g.hold('roll', Math.PI / 4)`, axis: 'roll', deg: 45 },
        ]
        for (const route of ['art', 'platform']) {
          for (const pose of poses) {
            const state = await applyState({
              route,
              ssao: route === 'platform' ? false : autoTierDefault ?? true,
              contact: route !== 'platform',
              projected: route !== 'platform',
              pose,
            })
            const row = await recordFrame({
              id: `g1b-${route}-${pose.id}`,
              stage: 'G1b',
              flipCrop: true,
              note: `${route} support at ${pose.axis} ${pose.deg}° (mid-turn hold)`,
            }, state, null)
            const readouts = row.readouts
            const quat = readouts.rotation.pose
            const extent = -readouts.rendering.grounding.cubeBottomY
            const lowest = lowCornerY(quat, extent)
            const supportTopY = readouts.rendering.grounding.supportTopY
            row.interpenetration = {
              poseReported: readouts.rotation.diagnostic,
              extent,
              lowestCornerY: Number(lowest.toFixed(4)),
              supportTopY: supportTopY === null ? null : Number(supportTopY.toFixed(4)),
              restBottomY: Number(readouts.rendering.grounding.cubeBottomY.toFixed(4)),
              // Only the 3D route has geometry to pass through; on the painted route the number
              // says how far the turning cube dips BELOW the line the art's ledge is drawn at,
              // i.e. how much of the turn the 2D support is hiding rather than supporting.
              belowSupport: supportTopY === null ? null : Number(Math.max(0, supportTopY - lowest).toFixed(4)),
              belowRestBottom: Number(Math.max(0, readouts.rendering.grounding.cubeBottomY - lowest).toFixed(4)),
            }
            report.interpenetration.push({ view: viewName, tier, route, pose: pose.id, axis: pose.axis, deg: pose.deg, ...row.interpenetration })
          }
        }

        // The opening wave scales tiles past 1.0 (INTRO_STYLE.build.scaleOvershoot) — with a slab
        // flush under the cube that is the other place a real block can leave the support's plane,
        // so the gate needs a mid-build frame AND the largest scale the wave actually reached.
        await applyState({ route: 'platform', ssao: false, contact: false, projected: false })
        await evalIn('globalThis.__voxalblastDev.replayIntro()')
        let introShot = null
        let maxScale = 0
        let maxScaleCell = null
        for (let attempt = 0; attempt < 120; attempt += 1) {
          const intro = JSON.parse(await evalIn('JSON.stringify(globalThis.__voxalblast.intro())'))
          const entries = Array.isArray(intro.progress) ? intro.progress : []
          for (const entry of entries) {
            if (entry.scale > maxScale) { maxScale = entry.scale; maxScaleCell = entry.cell }
          }
          if (!introShot && intro.active && intro.stage === 'build') {
            const rising = entries.filter((entry) => entry.scale > 0.73 && entry.scale < 0.999).length
            if (rising >= 10) {
              introShot = await recordFrame({ id: 'g1b-platform-intro-mid', stage: 'G1b', note: 'opening wave mid-build over the slab' },
                await applyState({ route: 'platform', ssao: false, contact: false, projected: false }), null)
            }
          }
          if (introShot && !intro.active) break
          if (!intro.active && attempt > 6) break
          await sleep(25)
        }
        if (!introShot) console.warn(`WARN ${viewName}/${tier}: no mid-wave frame was caught`)
        const finalReadout = await readout()
        const restBottomY = finalReadout.rendering.grounding.cubeBottomY
        const blockHalf = finalReadout.rendering.materials.size / 2
        report.introWave.push({
          view: viewName, tier, maxTileScale: Number(maxScale.toFixed(4)), maxScaleCell,
          // A bottom-face tile at scale s has its block bottom at restBottom - blockHalf*(s-1),
          // i.e. it dips blockHalf*(s-1) below the resting bottom edge — the same edge the slab's
          // top surface is anchored to. blockHalf comes from the shared block geometry's own
          // reported size, not from a typed-in constant.
          dipBelowRestBottom: Number((blockHalf * Math.max(0, maxScale - 1)).toFixed(4)),
          restBottomY: Number(restBottomY.toFixed(4)),
          captured: Boolean(introShot),
        })
        await evalIn('globalThis.__voxalblastDev.settleIntro()')
      }
    }

    // ---- G1c: route B (v0.10.2) — the contact decal reshaped to the board's footprint -------
    //
    // The producer chose route B on 2026-09-30 (keep the painted pedestal, redo the contact
    // matching). The only thing that changed is the decal's SHAPE and its alignment, so the round
    // is graded by swapping the shape on the same frame and nothing else.
    if (wantG1c) {
      await loadFixture('rgb')
      const variants = [
        { id: 'g1c-footprint', shape: 'footprint', note: 'route B: footprint-shaped contact decal (shipped default)' },
        { id: 'g1c-radial', shape: 'radial', note: 'legacy radial contact decal (same frame, same pose)' },
      ]
      for (const variant of variants) {
        const state = await applyState({ route: 'art', ssao: autoTierDefault, contact: true, projected: true, shape: variant.shape })
        await recordFrame({ id: variant.id, stage: 'G1c', crops: true, flipCrop: true, note: variant.note }, state, null)
      }
      // Does the footprint stay under the blocks while the view is dialled? One real fine-tune
      // drag to each end of the zone, captured, so the alignment can be seen rather than assumed.
      await dragFineTune(0.09)
      await recordFrame({ id: 'g1c-footprint-yaw-right', stage: 'G1c', note: 'route B decal at the top of the fine-tune zone' },
        await applyState({ route: 'art', ssao: autoTierDefault }), null)
      await dragFineTune(-0.09)
      await dragFineTune(-0.09)
      await recordFrame({ id: 'g1c-footprint-yaw-left', stage: 'G1c', note: 'route B decal at the bottom of the fine-tune zone' },
        await applyState({ route: 'art', ssao: autoTierDefault }), null)
      // …and under a mid-turn cube, where the footprint is no longer a footprint.
      for (const shape of ['footprint', 'radial']) {
        await recordFrame({
          id: `g1c-${shape}-flip-pitch-mid`, stage: 'G1c', flipCrop: true,
          note: `${shape} decal under a 45° pitch`,
        }, await applyState({ route: 'art', ssao: autoTierDefault, shape, pose: { expression: `g.hold('pitch', Math.PI / 4)` } }), null)
      }
      await applyState({ route: 'art', ssao: autoTierDefault })
    }

    if (browserErrors.length) {
      report.pageErrors.push({ view: viewName, tier, errors: [...new Set(browserErrors)] })
    }
    console.log(`OK   ${viewName} (${view.width}x${view.height}) tier=${tier} conditions=${report.conditions.filter((c) => c.view === viewName && c.tier === tier).length}`)
  } catch (error) {
    captureError = error
    throw error
  } finally {
    try {
      await closeBrowser(child, browserSocket, ws, profile)
    } catch (error) {
      if (!captureError) throw error
      console.warn(`WARN cleanup after ${viewName}/${tier}: ${error.message}`)
    }
  }
}

function summarize(deltas) {
  if (!deltas || !deltas.length) return null
  const p50 = percentile(deltas, 0.5)
  const p95 = percentile(deltas, 0.95)
  return {
    frames: deltas.length,
    p50,
    p95,
    min: Number(Math.min(...deltas).toFixed(2)),
    max: Number(Math.max(...deltas).toFixed(2)),
    fpsFromP50: p50 ? Number((1000 / p50).toFixed(1)) : null,
    note: 'headless software rendering (--disable-gpu); a relative same-machine baseline, not a device measurement',
  }
}

// ---------------------------------------------------------------------- run
const commit = (() => {
  try {
    return readFileSync(resolve(ROOT, '.git/HEAD'), 'utf8').trim()
  } catch { return null }
})()

const report = {
  run: {
    startedAt: new Date().toISOString(),
    version,
    url: URL_,
    stage: STAGE,
    tier: TIER,
    tiers: TIERS,
    seed: SEED,
    views: viewNames,
    head: commit,
    node: process.version,
    note: 'G0 + G1 evidence for MATERIAL_GROUNDING_REWORK_HANDOFF §4/§5. Every switch driven here is DEV-only and presentation-only.',
  },
  fixtures: Object.fromEntries(Object.entries(FIXTURES).map(([key, path]) => [key, {
    path: relative(ROOT, path).replace(/\\/g, '/'),
    sha256: sha256(readFileSync(path)),
  }])),
  conditions: [],
  interpenetration: [],
  introWave: [],
  diffs: [],
  pageErrors: [],
}

mkdirSync(OUT, { recursive: true })
for (const viewName of viewNames) {
  for (const tier of TIERS) {
    await runSession({ viewName, tier, report })
  }
}

// ---- G1a / G1b region diffs -------------------------------------------------------
// Paired per (view, tier): the same condition id exists in every session, and a plain id map
// would silently keep only the last one — which is exactly how a comparison can look like it
// ran when it graded the wrong viewport.
const pairs = [
  ['g1a-A-all', 'g1a-B-no-ssao', 'G1a: SSAO contribution'],
  ['g1a-A-all', 'g1a-E-low-ssao-on', 'G1a: what the low tier gives up by turning both passes off'],
  ['g1a-A-all', 'g1a-F-occlusion-cranked', 'G1a: is the shipped occlusion merely gentle, or not running at all?'],
  ['g1a-A-all', 'g1a-C-no-contact', 'G1a: contact decal contribution'],
  ['g1a-A-all', 'g1a-D-no-projected', 'G1a: projected receiver contribution'],
  ['g1b-art-ssao-on', 'g1b-art-ssao-off', 'G1b: SSAO contribution on the painted route'],
  ['g1b-art-ssao-off', 'g1b-platform-plain', 'G1b: painted support vs plain 3D slab (both without SSAO)'],
  ['g1b-platform-plain', 'g1b-platform-decal', 'G1b: contact decal on a real slab'],
  ['g1b-platform-plain', 'g1b-platform-ssao', 'G1b: SSAO on a real slab'],
  ['g1b-platform-ssao', 'g1b-platform-ssao-decal', 'G1b: decal on top of SSAO'],
  ['g1c-radial', 'g1c-footprint', 'G1c (route B): footprint decal vs the legacy radial blob'],
  ['g1c-radial-flip-pitch-mid', 'g1c-footprint-flip-pitch-mid', 'G1c (route B): the two shapes under a 45° pitch'],
]
for (const [aId, bId, label] of pairs) {
  for (const a of report.conditions.filter((condition) => condition.id === aId)) {
    const b = report.conditions.find((condition) => condition.id === bId && condition.view === a.view && condition.tier === a.tier)
    if (!b) continue
    const imageA = readPng(resolve(ROOT, a.file))
    const imageB = readPng(resolve(ROOT, b.file))
    const regions = regionsFor(a.readouts.framing, imageA)
    for (const [regionName, box] of Object.entries(regions)) {
      report.diffs.push({
        label, a: aId, b: bId, view: a.view, tier: a.tier, region: regionName, box,
        ...diffBox(imageA, imageB, box),
      })
    }
  }
}

const reportPath = join(OUT, `report-${STAGE}.json`)
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
console.log(`\nreport ${relative(ROOT, reportPath).replace(/\\/g, '/')}`)
console.log(`conditions ${report.conditions.length}  diffs ${report.diffs.length}  interpenetration rows ${report.interpenetration.length}`)
if (report.pageErrors.length) {
  console.error(`FAIL page errors: ${JSON.stringify(report.pageErrors)}`)
  process.exitCode = 1
}

// VoxalBlast "floating block world" C3 environment-animation evidence (visual correction
// handoff section 7.2).
//
// Section 7.2 does not accept the sentence "the animation is implemented". It asks for two
// reproducible artefacts:
//
//   1. "at least one 8-12s clip, or a t0 / t+8s pair, proving the clouds and the buildings
//      really move" - a single frame can never be accepted as animation evidence;
//   2. "a clip of the freeze during a drag/pause, and of the resume that does not jump".
//
// A headless browser cannot hand out a video, so this tool ships CONTROLLED FRAME PAIRS:
// the world's ambient clock is pinned at t=0 and at t=8 and both frames are captured, so a
// pixel diff proves the scenery moved; then both clocks are released, a candidate piece is
// picked up and held, and two frames 1.2s apart prove the BOARD froze while the world kept
// living. Pinning both clocks works because `__voxalblastDev.setAmbient` and `setBoardFloat`
// take an ABSOLUTE time (handoff 8.7 / C0.4): `{ frozen: true, time: T }` computes the pose
// FROM T rather than stopping an accumulator, so the same build and the same T always give
// the same image.
//
// Freezing also has to be shown "not to be a reset". Two identical screenshots cannot tell
// "hold the current offset" from "snap to zero and sit still", so the third phase samples the
// board's PROJECTED centre (`placement().center.y`, which follows `cubeGroup.position.y`) once
// per frame: while the piece is held it must equal where the board was when the finger landed
// (HOLD, not RESET), the frame after the release must sit right next to that value (no jump),
// and the per-frame step afterwards must stay inside a ceiling (a 0.25s blend, not a teleport).
//
//   node tools/floating-world-motion-evidence.mjs [url] [outDir] [--size=WxH]
//
// Exit code: 1 if any assertion fails. The thresholds are NOT tuned to whatever a run
// produced - a failure is reported to the producer as it stands.
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { readPng } from './png-read.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
].find((p) => p && existsSync(p))
if (!EDGE) throw new Error('no Edge/Chrome found')

const url = (process.argv[2] || 'http://127.0.0.1:5173/').replace(/\/?$/, '/')
const outDir = resolve(ROOT, process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : 'artifacts/visual-motion')
const sizeArg = process.argv.find((a) => a.startsWith('--size='))
const [WIDTH, HEIGHT] = (sizeArg ? sizeArg.slice(7) : '1440x900').split('x').map(Number)
const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// The pin the whole file rests on: ONE absolute time for BOTH clocks, so "t=8" means the same
// pose for the scenery and for the board.
const PIN = (t) => `(() => { const d = globalThis.__voxalblastDev
  const board = d.setBoardFloat({ frozen: true, time: ${t} })
  const ambient = d.setAmbient({ frozen: true, time: ${t} })
  return JSON.stringify({ board, ambient: ambient ?? null }) })()`
const UNPIN = `(() => { globalThis.__voxalblastDev.setBoardFloat(null); globalThis.__voxalblastDev.setAmbient(null); return 'live' })()`

let nextId = 100
function send(ws, method, params = {}) {
  const id = nextId++
  return new Promise((res, rej) => {
    const onMessage = (e) => {
      const m = JSON.parse(e.data)
      if (m.id !== id) return
      ws.removeEventListener('message', onMessage)
      m.error ? rej(new Error(`${method}: ${JSON.stringify(m.error)}`)) : res(m.result)
    }
    ws.addEventListener('message', onMessage)
    ws.send(JSON.stringify({ id, method, params }))
  })
}
async function connect(endpoint) {
  const ws = new WebSocket(endpoint)
  await new Promise((ok, no) => {
    ws.addEventListener('open', () => ok(), { once: true })
    ws.addEventListener('error', no, { once: true })
  })
  return ws
}
async function evaluate(ws, expression, awaitPromise = false) {
  const r = await send(ws, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
  if (r.exceptionDetails) throw new Error(`page error: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`)
  return r.result.value
}
async function capture(ws, path) {
  const shot = await send(ws, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  writeFileSync(path, Buffer.from(shot.data, 'base64'))
  return path
}
// Wait until the renderer has drawn the pose that was just pinned: one rAF is not enough,
// because the pin is consumed inside the frame loop (main.js) and the composer renders after it.
async function settle(ws, frames = 4) {
  await evaluate(ws, `new Promise(ok => { let n = 0; const tick = () => { if (++n >= ${frames}) ok(n); else requestAnimationFrame(tick) }; requestAnimationFrame(tick) })`, true)
}

// The same measure as tools/frame-diff.mjs, in-process because the evidence has to carry the
// numbers next to the frames it is talking about: pixels differing by more than 2/8/16/32 levels.
function diffBox(a, b, box) {
  const [x0, y0, x1, y1] = box
  const counts = [0, 0, 0, 0]
  let sum = 0
  let max = 0
  let samples = 0
  const moved = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const i = (y * a.width + x) * a.channels
      let delta = 0
      for (let c = 0; c < 3; c += 1) delta = Math.max(delta, Math.abs(a.pixels[i + c] - b.pixels[i + c]))
      sum += delta
      samples += 1
      if (delta > max) max = delta
      counts[0] += delta > 2 ? 1 : 0
      counts[1] += delta > 8 ? 1 : 0
      counts[2] += delta > 16 ? 1 : 0
      counts[3] += delta > 32 ? 1 : 0
      if (delta > 2) {
        if (x < moved.minX) moved.minX = x
        if (x > moved.maxX) moved.maxX = x
        if (y < moved.minY) moved.minY = y
        if (y > moved.maxY) moved.maxY = y
      }
    }
  }
  return {
    box: { x0, y0, x1, y1 },
    samples,
    over2: counts[0], over8: counts[1], over16: counts[2], over32: counts[3],
    shareOver2: +(counts[0] / samples).toFixed(4),
    mean: +(sum / samples).toFixed(3),
    max,
    movedBox: moved.minX === Infinity ? null : moved,
  }
}

const failures = []
const check = (ok, label, detail) => {
  if (!ok) failures.push(`${label}${detail ? ` - ${detail}` : ''}`)
  return ok
}
// The dev server reloads the page whenever anything in the module graph is saved, and the live
// handles are gone for a few frames while it does. A concurrent editor is therefore an
// environment condition, not a product result - say so, instead of failing with a TypeError
// three phases in.
async function requireHandle(ws, phase) {
  const kind = await evaluate(ws, 'typeof globalThis.__voxalblastDev')
  if (kind !== 'object') {
    throw new Error(`page handles missing at ${phase} (typeof __voxalblastDev = ${kind}): the dev server reloaded mid-run - re-run with no other editor saving files`)
  }
}

mkdirSync(outDir, { recursive: true })
const profile = mkdtempSync(join(tmpdir(), 'voxalblast-motion-'))
const child = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--disable-breakpad', '--hide-scrollbars',
  '--no-first-run', '--no-default-browser-check', '--force-device-scale-factor=1',
  '--run-all-compositor-stages-before-draw', '--remote-debugging-port=0',
  `--user-data-dir=${profile}`, `--window-size=${WIDTH},${HEIGHT}`, 'about:blank',
], { stdio: 'ignore', windowsHide: true })

let port = null
for (let i = 0; i < 80 && !port; i += 1) {
  try { port = Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]) } catch { await sleep(250) }
}
const info = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
const browserSocket = await connect(info.webSocketDebuggerUrl)
const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json()
const ws = await connect(target.webSocketDebuggerUrl)
await send(ws, 'Page.enable')
await send(ws, 'Runtime.enable')
const logs = []
ws.addEventListener('message', (event) => {
  const { method, params } = JSON.parse(event.data)
  if (method === 'Runtime.consoleAPICalled') logs.push(`${params.type}: ${params.args.map((a) => a.value ?? a.description ?? a.type).join(' ')}`)
})
await send(ws, 'Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, screenWidth: WIDTH, screenHeight: HEIGHT, deviceScaleFactor: 1, mobile: WIDTH < 600 })
await send(ws, 'Page.navigate', { url })
await sleep(4200)
// The cover is the boot state; the board bob is only visible on the board, so start a run.
await evaluate(ws, `(() => { if (globalThis.__voxalblast?.boot?.()?.homeOpen) document.querySelector('#home-primary')?.click(); return 'board' })()`)
for (let i = 0; i < 80; i += 1) {
  const wave = JSON.parse(await evaluate(ws, 'JSON.stringify(globalThis.__voxalblast?.intro?.() ?? null)') || 'null')
  if (wave && !wave.active) break
  await sleep(150)
}
await sleep(600)

const framing = JSON.parse(await evaluate(ws, 'JSON.stringify(globalThis.__voxalblast.framing())'))
const world = JSON.parse(await evaluate(ws, 'JSON.stringify(globalThis.__voxalblast.rendering().world)'))
const solid = framing.solid
// The tray is measured from the DOM here rather than taken from the screenshot driver's payload:
// this tool is not the driver, and the control box has to be the box the DOM actually has.
const tray = JSON.parse(await evaluate(ws, `(() => { const el = document.querySelector('.bottom-panel')
  const b = el.getBoundingClientRect()
  return JSON.stringify({ x: b.left, y: b.top, width: b.width, height: b.height }) })()`))
const slot = JSON.parse(await evaluate(ws, `(() => { const el = document.querySelector('.piece-slot')
  const b = el.getBoundingClientRect()
  return JSON.stringify({ x: b.left, y: b.top, width: b.width, height: b.height }) })()`))

// The boxes the evidence is read through. SKY must contain clouds and background buildings and
// NOTHING that is pinned by the UI; TRAY is a DOM plate, so it must be bit-identical across a
// scenery-only move - it is the control proving the diff came from the world rather than noise.
const skyBox = [0, Math.round(HEIGHT * 0.18), Math.round(WIDTH * 0.34), Math.round(HEIGHT * 0.44)]
const trayBox = [Math.round(tray.x), Math.round(tray.y), Math.round(tray.x + tray.width), Math.round(tray.y + tray.height)]
// The board band is read at its TOP rows: the dragged candidate is parked at the board's centre,
// so the top of the board is the part of it that must hold still while the player decides. It is
// INSET horizontally because `framing.solid` is the AABB of the board's projected silhouette - a
// cube projects to a hexagon, so the corners of that box are BACKGROUND, and an un-inset band
// reports cloud drift as board motion (measured: 418 px, max delta 134, before the inset).
const boardInset = (solid.maxX - solid.minX) * 0.22
const boardBox = [
  Math.round(solid.minX + boardInset), Math.round(solid.minY + (solid.maxY - solid.minY) * 0.06),
  Math.round(solid.maxX - boardInset), Math.round(solid.minY + (solid.maxY - solid.minY) * 0.3),
]

const report = {
  version, url, viewport: `${WIDTH}x${HEIGHT}`, deviceScaleFactor: 1,
  world: { enabled: world.enabled, tier: world.tier, clouds: world.clouds, cloudTextures: world.cloudTextures, clusters: world.clusters, walls: world.walls, looseBlocks: world.looseBlocks },
  boxes: { sky: skyBox, tray: trayBox, board: boardBox },
  phases: {},
}

// --- Phase A: does the world move? (t=0 vs t=8s) -------------------------------------------
await requireHandle(ws, 'phase A')
await evaluate(ws, PIN(0))
await settle(ws, 6)
const t0 = join(outDir, `motion-${WIDTH}x${HEIGHT}-t0.png`)
await capture(ws, t0)
// The NEUTRAL pose: `time: 0` is zero float, so this is where a "reset instead of hold" bug
// would park the board. Phase C is judged against it rather than against a tolerance.
const neutralY = JSON.parse(await evaluate(ws, 'JSON.stringify(globalThis.__voxalblast.placement().center.y)'))
await evaluate(ws, PIN(8))
await settle(ws, 6)
const t8 = join(outDir, `motion-${WIDTH}x${HEIGHT}-t8.png`)
await capture(ws, t8)
// Determinism: the same pinned time must give the same pixels, or nothing else here is comparable.
await evaluate(ws, PIN(0))
await settle(ws, 6)
await evaluate(ws, PIN(8))
await settle(ws, 6)
const t8b = join(outDir, `motion-${WIDTH}x${HEIGHT}-t8-repeat.png`)
await capture(ws, t8b)
await evaluate(ws, PIN(0))
await settle(ws, 6)
const t0b = join(outDir, `motion-${WIDTH}x${HEIGHT}-t0-repeat.png`)
await capture(ws, t0b)

const png = (p) => readPng(p)
const a0 = png(t0)
const a8 = png(t8)
const a8b = png(t8b)
const a0b = png(t0b)
const skyDiff = diffBox(a0, a8, skyBox)
const trayDiff = diffBox(a0, a8, trayBox)
const whole = diffBox(a0, a8, [0, 0, WIDTH - 1, HEIGHT - 1])
const repeat8 = diffBox(a8, a8b, [0, 0, WIDTH - 1, HEIGHT - 1])
const repeat0 = diffBox(a0, a0b, [0, 0, WIDTH - 1, HEIGHT - 1])
report.phases.motion = {
  frames: { t0, t8, t8Repeat: t8b, t0Repeat: t0b },
  sky: skyDiff, tray: trayDiff, whole, repeatAt8: repeat8, repeatAt0: repeat0,
  // Section 7.2 puts the clouds at .006/.008/.010 screen widths per second, so after 8s even the
  // slowest one has travelled 4.8% of the width. A third of the sky band is cloud and building,
  // so "more than 2 levels different" cannot be a single-digit percentage - the floor is 2%.
  moved: check(skyDiff.shareOver2 >= 0.02, 'A1 scenery did not move between t=0 and t=8s', `sky shareOver2=${skyDiff.shareOver2}`),
  trayStill: check(trayDiff.over2 === 0, 'A2 the DOM tray changed while only the world clock moved', `over2=${trayDiff.over2} max=${trayDiff.max}`),
  deterministic8: check(repeat8.max === 0, 'A3 the same pinned time t=8 gave two different frames', `max=${repeat8.max}`),
  deterministic0: check(repeat0.max === 0, 'A4 the same pinned time t=0 gave two different frames', `max=${repeat0.max}`),
}

// --- Phase B: is the board frozen while the world keeps living? ------------------------------
await requireHandle(ws, 'phase B')
await evaluate(ws, UNPIN)
await settle(ws, 10)
const centre = JSON.parse(await evaluate(ws, 'JSON.stringify(globalThis.__voxalblast.placement().center)'))
const from = { x: Math.round(slot.x + slot.width / 2), y: Math.round(slot.y + slot.height / 2) }
const to = { x: Math.round(centre.x), y: Math.round(centre.y) }
// Per-frame trace of the board's PROJECTED centre. `placement()` projects a board-space cell
// through the camera, so it follows `cubeGroup.position.y` the way the player's eye does - an
// internal offset variable can be correct while the screen is not, this cannot.
await evaluate(ws, `(() => {
  window.__motionTrace = []
  window.__motionTraceError = null
  const tick = () => {
    try {
      const p = globalThis.__voxalblast.placement()
      window.__motionTrace.push({ t: +performance.now().toFixed(1), y: +p.center.y.toFixed(3) })
    } catch (err) { window.__motionTraceError = String(err && err.message || err) }
    if (window.__motionTrace.length < 1800) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
  return 'sampling'
})()`)
const pageClock = () => evaluate(ws, 'performance.now()')
await sleep(500)
// Wait for the bob to be NEAR ITS EXTREME before pressing. "Freeze holds the value" and "freeze
// resets to zero" are the same picture when the value already is zero, so the phase is only
// meaningful if the board is displaced when the finger lands - and the margin has to survive the
// ~30ms between the reading and the event, which is why this waits for 1.0px of the 1.33px
// amplitude rather than for "not zero". The period is 5.5s, so this terminates on its own.
let displaced = null
for (let i = 0; i < 200; i += 1) {
  displaced = JSON.parse(await evaluate(ws, 'JSON.stringify(globalThis.__voxalblast.placement().center.y)'))
  if (Math.abs(displaced - neutralY) > 1) break
  await sleep(40)
}
await send(ws, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y })
const pressAt = await pageClock()
await send(ws, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 })
for (let i = 1; i <= 8; i += 1) {
  await send(ws, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(from.x + (to.x - from.x) * (i / 8)), y: Math.round(from.y + (to.y - from.y) * (i / 8)), button: 'left', buttons: 1 })
  await sleep(40)
}
await sleep(400)
// B0: the drag has to have actually picked something up, or B1/B2 would pass because nothing was
// happening - a frozen board and an empty gesture look identical in two screenshots.
const inHand = JSON.parse(await evaluate(ws, 'JSON.stringify({ preview: globalThis.__voxalblast.preview(), ghost: globalThis.__voxalblast.ghost() })'))
const dragA = join(outDir, `motion-${WIDTH}x${HEIGHT}-drag-hold-a.png`)
await capture(ws, dragA)
await sleep(1200)
const dragB = join(outDir, `motion-${WIDTH}x${HEIGHT}-drag-hold-b.png`)
await capture(ws, dragB)
const holdSky = diffBox(png(dragA), png(dragB), skyBox)
const holdBoard = diffBox(png(dragA), png(dragB), boardBox)
const holdTray = diffBox(png(dragA), png(dragB), trayBox)
// Put the piece back where it came from BEFORE letting go. A release over the board would PLACE
// it, and a placement runs a snap animation that freezes the float for its own reason - the
// resume this phase is about would then be measured on a board that is not resuming.
for (let i = 7; i >= 0; i -= 1) {
  await send(ws, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(from.x + (to.x - from.x) * (i / 8)), y: Math.round(from.y + (to.y - from.y) * (i / 8)), button: 'left', buttons: 1 })
  await sleep(40)
}
const releaseAt = await pageClock()
await send(ws, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: from.x, y: from.y, button: 'left', buttons: 0, clickCount: 1 })
// 3.2s, not "a bit": the bob's period is 5.5s, so a window longer than half a period ALWAYS spans
// a good share of the amplitude whatever phase the release lands on. A 1.6s window can land on an
// extreme and read a 0.4px span - which is not a defect, but it is a gate that fails at random.
await sleep(3200)
const samples = JSON.parse(await evaluate(ws, 'JSON.stringify(window.__motionTrace ?? [])'))
const traceError = await evaluate(ws, 'window.__motionTraceError ?? null')
report.phases.freeze = {
  frames: { holdA: dragA, holdB: dragB },
  pointer: { from, to },
  inHand: { piece: inHand.preview.piece, valid: inHand.preview.valid, cells: inHand.preview.cells.length, ghostVisible: inHand.ghost.visible, ghostCentre: inHand.ghost.centre },
  sky: holdSky, board: holdBoard, tray: holdTray,
  pickup: check(Boolean(inHand.preview.piece) && inHand.preview.cells.length > 0, 'B0 the drag never picked up a piece', `piece=${inHand.preview.piece} cells=${inHand.preview.cells.length}`),
  boardStill: check(holdBoard.over2 === 0, 'B1 the board moved while a piece was held', `over2=${holdBoard.over2} max=${holdBoard.max}`),
  trayStill: check(holdTray.over2 === 0, 'B2 the tray moved while a piece was held', `over2=${holdTray.over2} max=${holdTray.max}`),
  // The world must NOT be frozen by a drag - only the board is. A drag that stopped the clouds
  // would pass B1 for the wrong reason, so the same pair is asserted the other way round too.
  worldAlive: check(holdSky.shareOver2 >= 0.005, 'B3 the world stopped moving during the drag (freeze over-reached)', `sky shareOver2=${holdSky.shareOver2}`),
}

// --- Phase C: HOLD, not RESET; and a resume that does not jump ------------------------------
// Segmented by the page's OWN clock rather than by counting frames: the marks are read around the
// CDP dispatches, and every trace sample carries a `performance.now()` stamp.
const before = samples.filter((s) => s.t < pressAt)
const during = samples.filter((s) => s.t >= pressAt && s.t <= releaseAt)
const after = samples.filter((s) => s.t > releaseAt)
// The freeze lands on the frame AFTER the pointerdown is processed, so the first frames inside
// `during` are still the free clock; they are dropped rather than allowed to widen the spread.
const heldSamples = during.slice(3)
const heldValue = heldSamples.length ? heldSamples[heldSamples.length - 1].y : null
const beforePress = before.length ? before[before.length - 1].y : null
const spread = heldSamples.length ? Math.max(...heldSamples.map((s) => s.y)) - Math.min(...heldSamples.map((s) => s.y)) : null
// How far the board travels in ONE free frame, taken from the run itself: the freeze lands on the
// frame after the pointerdown is processed, so the held value can legitimately differ from the
// last pre-press sample by up to that much. Deriving the bound from the trace keeps it honest - a
// reset is a jump of the whole bob amplitude, not one frame.
const freeWindow = before.slice(-20)
const freeSteps = freeWindow.slice(1).map((s, i) => Math.abs(s.y - freeWindow[i].y)).sort((a, b) => a - b)
const frameStepPx = freeSteps.length ? freeSteps[Math.floor(freeSteps.length / 2)] : 0
const holdMatchesPress = heldValue !== null && beforePress !== null && Math.abs(heldValue - beforePress) <= Math.max(0.05, 2 * frameStepPx)
const steps = after.slice(1).map((s, i) => Math.abs(s.y - after[i].y))
// The headless software renderer draws this scene at ~8 fps and `main.js` clamps its dt to 0.05s
// (handoff 7.2), so the game's clock runs at roughly a third of wall time in this harness. That is
// a property of the MEASUREMENT, not of the product, and it is recorded because every distance
// below is in game time: a "3.2s" resume window is ~1.3s of bob.
const traceFps = samples.length > 1 ? +(samples.length / ((samples[samples.length - 1].t - samples[0].t) / 1000)).toFixed(1) : null
const gameClockShare = traceFps ? +(Math.min(1 / traceFps, 0.05) * traceFps).toFixed(3) : null
const resumeStepMax = steps.length ? Math.max(...steps) : null
const resumeSpan = after.length > 1 ? Math.max(...after.map((s) => s.y)) - Math.min(...after.map((s) => s.y)) : null
// The bob is +-.02 world units = +-1.33 CSS px at this framing, so a live sine moves ~0.05px per
// frame; the 0.25s blend is what a resume is allowed to spend. A jump back to phase zero is >=1px,
// which is what this ceiling is set to catch - it is NOT tuned to whatever the run happened to do.
const STEP_CEILING = 0.5
report.phases.resume = {
  traceError,
  traceFps,
  gameClockShare,
  neutralYPx: neutralY,
  displacedAtPressPx: displaced,
  frameStepPx: +frameStepPx.toFixed(3),
  samples: { total: samples.length, before: before.length, during: during.length, after: after.length },
  heldSpreadPx: spread === null ? null : +spread.toFixed(3),
  heldValuePx: heldValue,
  beforePressPx: beforePress,
  heldDeltaFromBeforePressPx: heldValue !== null && beforePress !== null ? +Math.abs(heldValue - beforePress).toFixed(3) : null,
  heldDeltaFromNeutralPx: heldValue !== null ? +Math.abs(heldValue - neutralY).toFixed(3) : null,
  resumeFirstPx: after.length ? after[0].y : null,
  resumeFirstDeltaFromHeldPx: after.length && heldValue !== null ? +Math.abs(after[0].y - heldValue).toFixed(3) : null,
  resumeStepMaxPx: resumeStepMax === null ? null : +resumeStepMax.toFixed(3),
  resumeSpanPx: resumeSpan === null ? null : +resumeSpan.toFixed(3),
  trace: samples,
  held: check(heldSamples.length > 5 && spread !== null && spread < 0.05, 'C1 the board kept moving while a piece was held', `spread=${spread} samples=${heldSamples.length}`),
  // "HOLD, not RESET" is two claims, and the second is the one a screenshot cannot make: the held
  // value must be OFF the neutral pose (a reset parks it exactly there), and it must agree with
  // where the board was when the finger landed.
  notReset: check(heldValue !== null && Math.abs(heldValue - neutralY) > 0.3, 'C2 the freeze parked the board on the neutral pose (reset, not hold)', `held=${heldValue} neutral=${neutralY}`),
  heldAtPressValue: check(holdMatchesPress, 'C2b the held offset does not match where the board was at pointerdown', `held=${heldValue} beforePress=${beforePress} frameStep=${frameStepPx}`),
  noJumpOnResume: check(after.length > 0 && heldValue !== null && Math.abs(after[0].y - heldValue) < 0.05, 'C3 the resume jumped away from the held offset', `first=${after[0]?.y} held=${heldValue}`),
  smoothResume: check(resumeStepMax !== null && resumeStepMax < STEP_CEILING, 'C4 the resume moved in one step instead of blending', `maxStep=${resumeStepMax} ceiling=${STEP_CEILING}`),
  resumeContinues: check(resumeSpan !== null && resumeSpan > 0.1, 'C5 the board never resumed moving after the release', `span=${resumeSpan}`),
}

// --- Phase D: prefers-reduced-motion stops the world (section 7.2, last line) ----------------
// Both clocks answer to the media query (the scenery's `frozen` flag and the board's float gate),
// so the whole frame must be bit-identical a second and a half apart. This is the one phase where
// a NON-zero diff is the failure, and it is measured over the whole viewport rather than a band -
// a reduced-motion rule that missed one group of clouds would still pass a banded check.
await send(ws, 'Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
await requireHandle(ws, 'phase D')
await evaluate(ws, UNPIN)
await settle(ws, 12)
const reducedA = join(outDir, `motion-${WIDTH}x${HEIGHT}-reduced-a.png`)
await capture(ws, reducedA)
await sleep(1500)
const reducedB = join(outDir, `motion-${WIDTH}x${HEIGHT}-reduced-b.png`)
await capture(ws, reducedB)
const reducedWhole = diffBox(png(reducedA), png(reducedB), [0, 0, WIDTH - 1, HEIGHT - 1])
report.phases.reducedMotion = {
  frames: { a: reducedA, b: reducedB },
  movedBox: reducedWhole.movedBox,
  still: check(reducedWhole.max === 0, 'D1 the world kept moving under prefers-reduced-motion', `max=${reducedWhole.max} over2=${reducedWhole.over2}`),
}
await send(ws, 'Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] })

report.failures = failures
report.logs = logs
const jsonPath = join(outDir, `motion-evidence-${WIDTH}x${HEIGHT}.json`)
writeFileSync(jsonPath, JSON.stringify(report, null, 1))

console.log(`floating-world motion evidence  v${version}  ${WIDTH}x${HEIGHT}  dpr 1`)
console.log(`world  clouds=${world.clouds} textures=${world.cloudTextures} clusters=${world.clusters} walls=${world.walls} loose=${world.looseBlocks} tier=${world.tier}`)
const row = (name, d) => console.log(`  ${name.padEnd(24)} over2=${String(d.over2).padStart(7)} (${(d.shareOver2 * 100).toFixed(2)}%)  mean=${d.mean}  max=${d.max}`)
row('A t0<->t8 sky band', skyDiff)
row('A t0<->t8 tray band', trayDiff)
row('A t0<->t8 whole frame', whole)
row('A t8<->t8 repeat', repeat8)
row('B hold sky band', holdSky)
row('B hold board band', holdBoard)
row('B hold tray band', holdTray)
row('D reduced-motion whole', reducedWhole)
console.log(`C neutral ${neutralY.toFixed(3)}px  held ${report.phases.resume.heldValuePx} (dNeutral ${report.phases.resume.heldDeltaFromNeutralPx}px, dLastFree ${report.phases.resume.heldDeltaFromBeforePressPx}px)  resume first ${report.phases.resume.resumeFirstPx}  max step ${report.phases.resume.resumeStepMaxPx}px  span ${report.phases.resume.resumeSpanPx}px  trace ${report.phases.resume.samples.total} frames @ ${traceFps}fps`)
console.log(`   frames ${outDir}`)
console.log(failures.length ? `FAIL ${failures.length}:\n  - ${failures.join('\n  - ')}` : 'all motion/freeze/resume/reduced-motion assertions passed')

await send(browserSocket, 'Browser.close').catch(() => {})
await sleep(1000)
try { rmSync(profile, { recursive: true, force: true, maxRetries: 8 }) } catch {}
process.exit(failures.length ? 1 : 0)

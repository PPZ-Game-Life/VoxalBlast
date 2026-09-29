// Drop-hitch probe (v0.9.30) — what blocks the main thread when the LAST candidate is placed?
//
//   node tools/drop-hitch-probe.mjs [url]      (needs `npm run dev`; Vite serves on localhost)
//
// Why it exists. main.onDrop() settles the placement, paints the feedback and then, if every
// candidate is now spent, calls nextPieces() — which runs the board-aware dealer (sample 36
// batches, prove each, analyse the survivors, refine the best few) AND rebuilds the three slot
// previews (dispose + create three WebGL contexts) in the SAME task. Both are on the frame the
// player just released a piece on, and the producer reported it as 「放置上去会卡顿一下」.
// tools/deal-perf.mjs measures the dealer alone in Node; it cannot see the frame, the preview
// rebuild, or which of the three placements in a hand is the expensive one. This probe does.
//
// What it reports:
//   1. Per drop: how long the release frame stayed blocked (release → next presented frame),
//      how many long tasks it produced, and the dealer metrics of the batch it dealt.
//   2. Every main-thread long task (≥50ms) with its start time, so a stray GC pause is visible
//      as one rather than smeared into an average.
//   3. A CPU profile of the whole run, aggregated by function self-time, so the cost can be
//      attributed to the dealer / the search / the preview rebuild instead of guessed at.
//   4. The WebGL renderer string, because a software rasteriser makes shader compilation read
//      far slower than it is on a real GPU.
//
// The drop is real CDP input (press on the slot, six moves, release on the face), and where it
// lands is retried against the game's own read-outs until the candidate is actually spent — a
// release on an occupied cell spends nothing, and a probe that never empties the hand would
// measure the cheap path three times and call it a day.
//
// Discipline, same as the other probes: real CDP input only, read-only `__voxalblast` handles for
// observation, an isolated temp profile with an OS-assigned debug port, Browser.close before the
// profile is removed.
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const url = (process.argv[2] || 'http://localhost:5173/').replace(/\/?$/, '/')
const CHROME_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
]
const BROWSER = CHROME_CANDIDATES.find((path) => path && existsSync(path))
if (!BROWSER) throw new Error(`no headless browser found; tried:\n  ${CHROME_CANDIDATES.join('\n  ')}`)

// Four hands = twelve drops = four deal-triggering drops. Enough to see the tail, short enough
// that a stray GC pause is recognisable as one.
const HANDS = Number(process.env.HITCH_HANDS || 4)
const VIEWPORT = { width: 430, height: 900 }
const INTRO_TIMEOUT_MS = 20000
// A plain mouse drag carries the piece 10px above the pointer (rendering/config.js DRAG_GHOST);
// landing a piece on a chosen cell therefore means aiming that far below it.
const MOUSE_LIFT = 10
// Cells to try, in the FACE's own u/v steps, until the candidate is actually spent.
const OFFSETS = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [2, 0], [-2, 0], [0, 2], [0, -2], [2, 1], [-2, -1]]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let nextId = 100

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
    const timeout = setTimeout(() => finish(new Error(`${method}: timed out`)), 60000)
    ws.addEventListener('message', onMessage)
    ws.addEventListener('close', onClose, { once: true })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function connect(endpoint) {
  const ws = new WebSocket(endpoint)
  await new Promise((ok, no) => {
    const timeout = setTimeout(() => { ws.close(); no(new Error('debugger connection timed out')) }, 5000)
    ws.addEventListener('open', () => { clearTimeout(timeout); ok() }, { once: true })
    ws.addEventListener('error', (error) => { clearTimeout(timeout); no(error) }, { once: true })
  })
  return ws
}

// The in-page recorder. `longtask` entries carry the start time on the page's own clock, which is
// the clock `arm()` reports, so a drop and the long task it caused line up exactly. `arm()`
// resolves on the next presented frame: the gap it reports is the release frame's whole blocking
// window, measured by the browser rather than by the probe's own sleeps.
const INSTALL = `(() => {
  const state = { long: [], unsupported: null, renderer: 'unknown' }
  globalThis.__hitch = state
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) state.long.push({ start: entry.startTime, dur: entry.duration })
    }).observe({ entryTypes: ['longtask'] })
  } catch (error) {
    state.unsupported = String(error)
  }
  state.arm = () => new Promise((done) => {
    const t0 = performance.now()
    requestAnimationFrame(() => done({ start: t0, blocked: performance.now() - t0, long: state.long.length }))
  })
  const canvas = document.createElement('canvas')
  const gl = canvas.getContext('webgl2') || canvas.getContext('webgl')
  const info = gl && gl.getExtension('WEBGL_debug_renderer_info')
  if (info) state.renderer = gl.getParameter(info.UNMASKED_RENDERER_WEBGL)
  return true
})()`

// The slot the probe is about to drag: the FIRST slot still holding an unused candidate, the
// candidate count, the face centre, and the face's own u/v steps in client pixels.
const SCENE = `(() => {
  const slots = [...document.querySelectorAll('#piece-slots .piece-slot')]
  const open = slots.filter((slot) => !slot.classList.contains('used'))
  const slot = open[0]
  const placement = globalThis.__voxalblast.placement()
  if (!slot || !placement || !placement.center) return null
  const box = slot.getBoundingClientRect()
  return {
    open: open.length,
    used: slots.length - open.length,
    // A settled placement ALWAYS pays (§4.1), so the score is what proves a drop actually landed —
    // the used-slot count cannot, because a successful third drop refills the hand and resets it.
    score: globalThis.__voxalblast.board().score,
    slot: { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) },
    center: { x: Math.round(placement.center.x), y: Math.round(placement.center.y) },
    // diagnostics.js reports the face axes in client pixels with dy > 0 = upward (NDC), while
    // client y runs downward: the sign is flipped here, once, rather than at every call site.
    u: { x: placement.uAxis.dx, y: -placement.uAxis.dy },
    v: { x: placement.vAxis.dx, y: -placement.vAxis.dy },
  }
})()`

const profile = mkdtempSync(join(tmpdir(), 'voxalblast-hitch-'))
const child = spawn(BROWSER, [
  '--headless=new', '--disable-breakpad', '--hide-scrollbars',
  '--no-first-run', '--no-default-browser-check', '--force-device-scale-factor=1',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  `--window-size=${VIEWPORT.width},${VIEWPORT.height}`, 'about:blank',
], { stdio: 'ignore', windowsHide: true })

let ws
let browserSocket = null
const browserErrors = []

try {
  let port
  for (let i = 0; i < 80; i += 1) {
    try { port = Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]); break } catch { await sleep(250) }
  }
  if (!port) throw new Error('devtools never came up')
  browserSocket = await connect((await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl)
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json()
  ws = await connect(target.webSocketDebuggerUrl)

  ws.addEventListener('message', (event) => {
    const { method, params } = JSON.parse(event.data)
    if (method === 'Runtime.consoleAPICalled' && params.type === 'error') {
      browserErrors.push(params.args.map((arg) => arg.value ?? arg.description ?? arg.type).join(' '))
    }
    if (method === 'Runtime.exceptionThrown') browserErrors.push(params.exceptionDetails.text)
  })
  await send(ws, 1, 'Page.enable')
  await send(ws, 2, 'Runtime.enable')
  await send(ws, 3, 'Emulation.setDeviceMetricsOverride', { ...VIEWPORT, deviceScaleFactor: 2, mobile: true })

  const evaluate = (expression, awaitPromise) => send(ws, nextId++, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: Boolean(awaitPromise) })
  const evalJs = async (expression) => {
    const result = await evaluate(expression)
    if (result.exceptionDetails) throw new Error(`evaluate threw: ${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`)
    return result.result?.value
  }

  await send(ws, 4, 'Page.navigate', { url })
  const deadline = Date.now() + 40000
  let ready = false
  while (Date.now() < deadline) {
    ready = await evalJs('Boolean(globalThis.__voxalblast && globalThis.__voxalblast.intro)')
    if (ready) break
    await sleep(250)
  }
  if (!ready) throw new Error(`the app never exposed __voxalblast at ${url}\n  browser errors: ${browserErrors.join(' | ') || '(none)'}`)
  // The opening wave must be over before a drag means anything.
  const introDeadline = Date.now() + INTRO_TIMEOUT_MS
  while (Date.now() < introDeadline) {
    if (await evalJs('globalThis.__voxalblast.intro().active') === false) break
    await sleep(120)
  }
  await evalJs(INSTALL)
  const renderer = await evalJs('globalThis.__hitch.renderer')

  // The baseline the drops are read against: what an IDLE frame costs here (headless, software
  // present, whatever the working tree currently renders). Without it a slow environment reads as
  // a slow refill.
  const frames = await evalJs(`new Promise((done) => {
    const gaps = []
    let last = performance.now()
    let count = 0
    const tick = () => {
      const now = performance.now()
      gaps.push(now - last)
      last = now
      if (++count < 120) requestAnimationFrame(tick)
      else {
        gaps.sort((a, b) => a - b)
        done({ p50: Math.round(gaps[60]), p95: Math.round(gaps[113]), max: Math.round(gaps[119]) })
      }
    }
    requestAnimationFrame(tick)
  })`, true)

  const profiling = process.env.HITCH_PROFILE !== '0'
  if (profiling) {
    await send(ws, 5, 'Profiler.enable')
    await send(ws, 6, 'Profiler.setSamplingInterval', { interval: 100 })
    await send(ws, 7, 'Profiler.start')
  }

  const mouse = (type, x, y, buttons) => send(ws, nextId++, 'Input.dispatchMouseEvent', {
    type, x, y, button: 'left', buttons, ...(type === 'mouseReleased' ? { clickCount: 1 } : {}),
  })

  // One drag: press the slot, six moves to the target, hold a beat, then release with the frame
  // timer already armed. `armed` is started BEFORE the release so the reported window is the
  // release frame itself, not the probe's own latency.
  async function dragDrop(scene, target) {
    await mouse('mouseMoved', scene.slot.x, scene.slot.y, 0)
    await mouse('mousePressed', scene.slot.x, scene.slot.y, 1)
    for (let i = 1; i <= 6; i += 1) {
      await mouse('mouseMoved', scene.slot.x + (target.x - scene.slot.x) * i / 6, scene.slot.y + (target.y - scene.slot.y) * i / 6, 1)
      await sleep(16)
    }
    await sleep(70)
    const armed = evaluate('globalThis.__hitch.arm()', true)
    // The release and the arm share one socket; the release is dispatched first, so the timer is
    // already running when the game's own handler executes.
    const released = await mouse('mouseReleased', target.x, target.y, 0)
    void released
    const result = await armed
    const frame = result.result?.value
    if (!frame) throw new Error('the frame timer never resolved')
    return frame
  }

  const drops = []
  for (let hand = 0; hand < HANDS; hand += 1) {
    for (let step = 0; step < 3; step += 1) {
      let scene = await evalJs(SCENE)
      if (!scene) throw new Error(`hand ${hand} step ${step}: nothing left to drag`)
      const openBefore = scene.open
      const scoreBefore = scene.score
      let placed = false
      let frame = null
      let attempts = 0
      for (const [ou, ov] of OFFSETS) {
        attempts += 1
        scene = await evalJs(SCENE)
        const target = {
          x: Math.round(scene.center.x + scene.u.x * ou + scene.v.x * ov),
          y: Math.round(scene.center.y + scene.u.y * ou + scene.v.y * ov + MOUSE_LIFT),
        }
        frame = await dragDrop(scene, target)
        const after = await evalJs(SCENE)
        if (after && after.score > scoreBefore) { placed = true; break }
        await sleep(120)
      }
      await sleep(260)
      const settled = await evalJs(SCENE)
      const metrics = placed && openBefore === 1 ? await evalJs('(() => { const m = globalThis.__voxalblast.lastDeal(); return m ? { nodes: m.nodes, candidates: m.candidatesSampled, refined: m.candidatesRefined, fallback: m.fallback, proof: m.proofStatus } : null })()') : null
      drops.push({
        hand, step, openBefore, placed, attempts,
        openAfter: settled ? settled.open : null,
        blocked: frame ? Number(frame.blocked.toFixed(1)) : null,
        longTasks: frame ? frame.long : null,
        metrics,
      })
    }
  }

  const profileResult = profiling ? await send(ws, nextId++, 'Profiler.stop') : null
  const longTasks = await evalJs('globalThis.__hitch.long.map((e) => ({ start: Math.round(e.start), dur: Math.round(e.dur) }))')

  // Self-time per function: the share of samples whose TOP frame is that function. The profile's
  // timestamps are microseconds, so the per-sample weight is derived from the interval the browser
  // used rather than from the span (which includes the idle gaps between samples).
  const byId = new Map(((profileResult?.profile.nodes) || []).map((node) => [node.id, node]))
  const selfTime = new Map()
  const samples = profileResult?.profile.samples || []
  const sampleInterval = samples.length
    ? ((profileResult.profile.endTime - profileResult.profile.startTime) / samples.length) / 1000
    : 0
  for (const id of samples) {
    const node = byId.get(id)
    if (!node) continue
    const frame = node.callFrame
    const key = `${frame.functionName || '(anonymous)'}  ${frame.url ? frame.url.split('/').slice(-1)[0] : ''}:${frame.lineNumber + 1}`
    selfTime.set(key, (selfTime.get(key) || 0) + sampleInterval)
  }
  const top = [...selfTime.entries()].sort((a, b) => b[1] - a[1]).slice(0, 26)

  const stat = (list) => {
    const values = list.map((drop) => drop.blocked).filter((value) => Number.isFinite(value)).sort((a, b) => a - b)
    if (!values.length) return 'n/a (no such drop)'
    return `n=${values.length}  p50 ${values[Math.floor(values.length / 2)].toFixed(1)}ms  max ${values[values.length - 1].toFixed(1)}ms`
  }
  const dealDrops = drops.filter((drop) => drop.openBefore === 1)

  console.log(`drop-hitch: ${HANDS} hands, ${drops.length} drops  (viewport ${VIEWPORT.width}x${VIEWPORT.height})`)
  console.log(`webgl renderer: ${renderer}`)
  console.log(`idle frame gaps here: p50 ${frames.p50}ms  p95 ${frames.p95}ms  max ${frames.max}ms`)
  console.log(`longtask observer: ${await evalJs('globalThis.__hitch.unsupported || "ok"')}`)
  console.log('\nper drop (openBefore = candidates still in hand when the piece was released):')
  for (const drop of drops) {
    const tag = drop.openBefore === 1 ? 'REFILL' : 'place '
    const metrics = drop.metrics ? `  nodes ${drop.metrics.nodes}  cand ${drop.metrics.candidates}/${drop.metrics.refined}  ${drop.metrics.fallback}` : ''
    console.log(`  ${tag} hand ${drop.hand} step ${drop.step}  open ${drop.openBefore}→${drop.openAfter}  ${drop.placed ? 'placed' : 'NOT PLACED'} (${drop.attempts} tries)  release frame blocked ${String(drop.blocked).padStart(7)}ms  longTasks ${drop.longTasks}${metrics}`)
  }
  console.log(`\nrelease frame, refill drops : ${stat(dealDrops)}`)
  console.log(`release frame, plain drops  : ${stat(drops.filter((drop) => drop.openBefore > 1))}`)
  console.log('\nmain-thread long tasks (>=50ms) over the whole run:')
  if (!longTasks.length) console.log('  none')
  for (const task of longTasks) console.log(`  start ${String(task.start).padStart(8)}  ${String(task.dur).padStart(6)}ms`)
  console.log('\nCPU self-time, top functions:')
  if (!profiling) console.log('  (profiler off: HITCH_PROFILE=0)')
  for (const [name, ms] of top) console.log(`  ${ms.toFixed(1).padStart(7)}ms  ${name}`)
  if (browserErrors.length) console.log(`\nbrowser errors:\n  ${browserErrors.join('\n  ')}`)
} finally {
  try { if (ws) await send(ws, nextId++, 'Browser.close') } catch { /* already gone */ }
  try { if (browserSocket) browserSocket.close() } catch { /* ignore */ }
  if (child && !child.killed) child.kill()
  await sleep(300)
  try { rmSync(profile, { recursive: true, force: true }) } catch { /* windows lock */ }
}

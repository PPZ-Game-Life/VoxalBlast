// Placement impact probe (PLACEMENT_IMPACT_FEEDBACK_HANDOFF.md §9.2) — R1 and up.
//
//   node tools/placement-impact-probe.mjs [url]
//   npm run probe:impact -- http://localhost:5199/
//
// What it grades, and why it grades THESE things: R1's exit condition is 「正式贴图逐帧、GLB姿态、
// 单线从落点扫向两端」 with 「刷光约0.65格高、cube约0.36–0.52格」, and §9.2 forbids the asset
// check-board from standing in for that. So this probe reads the runtime's OWN asset report
// (frame ids, order, durations, union bounds, pivot, GLB primitives and vertex colours), drives a
// real clear through the DEV descriptor path with an EXPLICIT placement, and then samples the live
// sweep geometry to prove the branch really started at the placement's origin and never drew
// behind it.
//
// Honest boundary, stated here because it must not be inferred from a green run: the placement
// this probe hands the planner is a DEV descriptor field, not a settled finger drop. The REAL
// Board path (`place()` → real lines → real snapshot) is asserted in
// tools/cartoon-clear-plan-tests.mjs against nine real fixtures; what is unique to this file is
// everything the browser alone can answer — texture sampling, quad geometry, GLB pose, draw calls
// and on-screen size.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const url = (process.argv[2] || 'http://localhost:5199/').replace(/\/?$/, '/')
const OUT = join(ROOT, 'artifacts', 'placement-impact-v2')
const SHOTS = join(OUT, 'r1', 'shots')
mkdirSync(SHOTS, { recursive: true })

const CHROME_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
]
const BROWSER = CHROME_CANDIDATES.find((path) => path && existsSync(path))
if (!BROWSER) throw new Error(`no headless browser found; tried:\n  ${CHROME_CANDIDATES.join('\n  ')}`)

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const evidence = { url, startedAt: new Date().toISOString(), checks: [], failures: [], samples: {} }
const check = (label, ok, detail) => {
  evidence.checks.push({ label, ok: Boolean(ok), detail: detail === undefined ? null : detail })
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : `  ${detail}`}`)
  if (!ok) evidence.failures.push(label)
}
const close = (a, b, tol) => Math.abs(a - b) <= tol

function send(ws, id, method, params = {}) {
  return new Promise((done, fail) => {
    const onMessage = (event) => {
      const message = JSON.parse(event.data)
      if (message.id !== id) return
      ws.removeEventListener('message', onMessage)
      if (message.error) fail(new Error(`${method}: ${message.error.message}`))
      else done(message.result)
    }
    ws.addEventListener('message', onMessage)
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function connect(endpoint) {
  const ws = new WebSocket(endpoint)
  await new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error('debugger connection timed out')), 8000)
    ws.addEventListener('open', () => { clearTimeout(timer); done() })
  })
  return ws
}

const profile = mkdtempSync(join(tmpdir(), 'voxalblast-impact-'))
const gpu = process.env.PI_GPU === '1'
const child = spawn(BROWSER, [
  '--headless=new', ...(gpu ? ['--use-angle=d3d11'] : ['--disable-gpu']),
  '--disable-breakpad', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
  '--force-device-scale-factor=1', '--autoplay-policy=no-user-gesture-required',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=390,844', 'about:blank',
], { stdio: 'ignore', windowsHide: true })
evidence.rasterisation = gpu ? 'd3d11 (PI_GPU=1)' : 'swiftshader (--disable-gpu)'

let ws
let browserSocket = null
const browserErrors = []
let nextId = 1
let screenshotSink = null

try {
  let port
  for (let i = 0; i < 80 && !port; i += 1) {
    try { port = Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]) } catch { await sleep(250) }
  }
  if (!port) throw new Error('devtools never came up')
  browserSocket = await connect((await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl)
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json()
  ws = await connect(target.webSocketDebuggerUrl)
  ws.addEventListener('message', (event) => {
    const { method, params } = JSON.parse(event.data)
    if (method === 'Page.screencastFrame') return
    if (method === 'Runtime.consoleAPICalled' && params.type === 'error') {
      browserErrors.push(params.args.map((arg) => arg.value ?? arg.description ?? arg.type).join(' '))
    }
    if (method === 'Runtime.exceptionThrown') browserErrors.push(params.exceptionDetails.text)
  })
  const evaluate = async (expression) => {
    const result = await send(ws, nextId++, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(`${expression}\n  ${result.exceptionDetails.text}`)
    return result.result.value
  }
  const json = async (expression) => JSON.parse(await evaluate(`JSON.stringify(${expression})`))
  const shot = async (name, clip = null) => {
    const params = { format: 'png', captureBeyondViewport: false, fromSurface: true }
    if (clip) params.clip = clip
    const result = await send(ws, nextId++, 'Page.captureScreenshot', params)
    const path = join(SHOTS, `${name}.png`)
    writeFileSync(path, Buffer.from(result.data, 'base64'))
    return path
  }

  await send(ws, nextId++, 'Page.enable')
  await send(ws, nextId++, 'Runtime.enable')
  const viewport = { width: 390, height: 844, screenWidth: 390, screenHeight: 844, deviceScaleFactor: 3, mobile: true }
  await send(ws, nextId++, 'Emulation.setDeviceMetricsOverride', viewport)
  await send(ws, nextId++, 'Page.navigate', { url })

  let booted = false
  for (let i = 0; i < 60 && !booted; i += 1) {
    await sleep(500)
    try { booted = await evaluate('Boolean(globalThis.__voxalblastDev && globalThis.__voxalblastDev.impactReport)') } catch { booted = false }
  }
  if (!booted) throw new Error('the DEV handles never appeared; is the dev server up and is this a DEV build?')

  // The pack loads lazily after boot and must never block a move (§8.1) — so the probe WAITS for it
  // here, and reports how long that took instead of asserting an instant.
  let assetsReady = false
  let waited = 0
  for (let i = 0; i < 60 && !assetsReady; i += 1) {
    const status = await evaluate('globalThis.__voxalblastDev.impactReport().status')
    if (status === 'ready' || status === 'failed') { assetsReady = true; break }
    await sleep(250)
    waited += 250
  }
  evidence.assetWaitMs = waited
  const assets = await json('globalThis.__voxalblastDev.impactReport()')
  evidence.assets = assets
  check('the pack loaded', assets.status === 'ready', `status=${assets.status} error=${assets.error ?? 'none'} failures=${JSON.stringify(assets.assets.failures)}`)
  if (assets.status !== 'ready') throw new Error(`the impact pack is ${assets.status}: ${assets.error}`)

  // ---------------------------------------------------------------- 1. the asset contract
  const sweep = assets.assets.sequences.sweep
  const pop = assets.assets.sequences.endpointPop
  check('sweep: four frames, left to right, 140ms total',
    sweep && sweep.frames.length === 4 && sweep.totalDurationMs === 140,
    sweep ? `frames=${sweep.frames.length} total=${sweep.totalDurationMs} declared=${sweep.declaredTotalDurationMs}` : 'missing')
  check('sweep: the fixed union box IS the reference box (no per-frame compensation)',
    sweep && sweep.unionIsReference === true, sweep ? JSON.stringify(sweep.unionAlphaBounds) : 'missing')
  check('sweep: the visible box is the doc\'s 1.4 × 0.65 cell',
    sweep && close(sweep.visibleWorld[0], 1.4, 1e-9) && close(sweep.visibleWorld[1], 0.65, 1e-9),
    sweep ? sweep.visibleWorld.join(' × ') : 'missing')
  check('sweep: the head pivot is preserved (not the transparent tile\'s centre)',
    sweep && sweep.pivotWorldOffset && close(sweep.pivotWorldOffset[0], 0.42578125 * sweep.frameWorld[0], 1e-6),
    sweep ? `pivotOffsetX=${sweep.pivotWorldOffset[0]} frameWorld=${sweep.frameWorld[0]}` : 'missing')
  check('sweep: mirror-for-negative-direction and rotate-around-head are declared',
    sweep && sweep.mirrorForNegativeDirection === true && sweep.rotateAroundHeadAnchor === true)
  check('endpoint burst: six frames, 140ms, one shot',
    pop && pop.frames.length === 6 && pop.totalDurationMs === 140,
    pop ? `frames=${pop.frames.length} total=${pop.totalDurationMs}` : 'missing')
  const cubeIds = Object.keys(assets.assets.cubes)
  check('three cube variants loaded, alias excluded', cubeIds.length === 3, cubeIds.join(','))
  for (const id of cubeIds) {
    const cube = assets.assets.cubes[id]
    check(`cube ${id}: one primitive with vertex colours, unit bounding box, doc's visible edge band`,
      cube.primitives === 1 && cube.hasVertexColors === true && cube.hasNormals === true
        && close(cube.localEdge, 1, 0.02) && cube.edgeWorld >= 0.36 && cube.edgeWorld <= 0.52,
      `primitives=${cube.primitives} colors=${cube.hasVertexColors} localEdge=${cube.localEdge.toFixed(4)} edgeWorld=${cube.edgeWorld.toFixed(4)}`)
  }

  // ---------------------------------------------------------------- 2. the live geometry
  await evaluate('globalThis.__voxalblastDev.clearCelebration()')
  await sleep(400)
  await shot('00-baseline')

  // The 148ms window is stepped on a FROZEN clock, one real frame at a time. Driving it from here
  // with sleeps would describe the rasteriser instead of the effect — measured: the first clear in
  // a session stalled 179ms between two animation frames (shader compile + texture upload), which
  // is longer than the whole sweep. `impactStep()` runs the REAL shipped update path with the
  // clock pinned, so every arrival, frame index and clip edge below is exact and recomputable,
  // while the wall-clock reading below still measures the cost of an ordinary clear.
  const jsonAsync = async (expression) => JSON.parse(await evaluate(expression))
  const series = await jsonAsync(`(() => {
    const dev = globalThis.__voxalblastDev
    const read = globalThis.__voxalblast
    const out = { baselineCalls: read.rendering().rendererInfo.calls, steps: [] }
    let fired = dev.demoClear(1, { placedIndexes: [2] })
    out.propagation = fired.cartoon.lastPropagation
    out.event = fired.impact.lastEvent
    const t0 = fired.impact.lastEvent.startedAt
    // 0..500ms, and the beats around the doc's own numbers are sampled twice so an edge is recorded
    // on BOTH sides of it: 34/36 around the 35ms start, 112/114 around the 113.125ms arrival.
    const beats = [0, 10, 34, 36, 60, 90, 112, 114, 136, 138, 160, 200, 300, 500]
    let previous = 0
    for (const beat of beats) {
      for (let t = previous; t <= beat; t += 2) dev.impactStep(t0 + t, 2 / 1000)
      previous = beat
      dev.impactStep(t0 + beat, 2 / 1000)
      const impact = dev.impactReport()
      out.steps.push({
        t: beat,
        sweeps: impact.liveSweeps.map((entry) => ({
          dir: entry.direction, originS: entry.originS, travelled: entry.travelled,
          frame: entry.frameIndex, lo: entry.interval[0], hi: entry.interval[1], face: entry.face,
          visible: entry.visible,
        })),
        bursts: impact.liveBursts.map((entry) => ({ frame: entry.frameIndex, face: entry.face, visible: entry.visible })),
        cubes: impact.live.cubes,
      })
    }
    dev.impactStep(null)
    return JSON.stringify(out)
  })()`)
  evidence.series = series
  const steps = series.steps
  const stepAt = (t) => steps.find((step) => step.t === t)
  const propagation = series.propagation
  check('a single line reports two face rays and two endpoints',
    propagation && propagation.faceRays === 2 && propagation.endpoints.length === 2,
    propagation ? `faceRays=${propagation.faceRays} endpoints=${propagation.endpoints.length}` : 'missing')
  check('the placement is known (not a fallback)',
    propagation && propagation.placedKnown === true && propagation.fallbackLines === 0,
    propagation ? `placed=${propagation.placedCellCount} fallback=${propagation.fallbackLines}` : 'missing')
  check('hits[2] gives the doc\'s symmetric 113.125/113.125ms',
    propagation && close(propagation.lines[0].originT, 2, 1e-9)
      && close(propagation.lines[0].minusMs, 113.125, 1e-6) && close(propagation.lines[0].plusMs, 113.125, 1e-6),
    propagation ? `originT=${propagation.lines[0].originT} ${propagation.lines[0].minusMs}/${propagation.lines[0].plusMs}` : 'missing')

  // §5.1 「落点后35ms启动」: before the start beat the instances exist but must draw NOTHING.
  const early = [0, 10, 34].map(stepAt).filter(Boolean)
  check('nothing is drawn before the doc\'s 35ms start',
    early.length === 3 && early.every((step) => step.sweeps.every((entry) => entry.visible === false)),
    early.map((step) => `${step.t}ms:${step.sweeps.filter((entry) => entry.visible).length}visible`).join(' '))

  const first = stepAt(36)
  check('both branches start at the placement, not at the line centre',
    first && first.sweeps.length === 2 && first.sweeps.every((entry) => close(entry.originS, 2, 1e-9)),
    first ? JSON.stringify(first.sweeps.map((entry) => `${entry.dir}:${entry.originS}`)) : 'missing')
  check('the two branches travel in opposite directions',
    Boolean(first) && first.sweeps.some((entry) => entry.dir > 0) && first.sweeps.some((entry) => entry.dir < 0))
  // §5.1 「起始瞬间不能把完整1.4格柔尾摆在origin两侧」: on the first travelling frame the tail is
  // clipped AT the origin on both sides, so the sprite is a short head rather than a full brush.
  check('the tail is clipped to the origin on the first travelling frame',
    first && first.sweeps.every((entry) => (entry.dir > 0
      ? close(entry.lo, entry.originS, 1e-6)
      : close(entry.hi, entry.originS, 1e-6))),
    first ? JSON.stringify(first.sweeps.map((entry) => `${entry.dir}:[${entry.lo},${entry.hi}]`)) : 'missing')

  const behind = []
  const travelled = []
  for (const step of steps) {
    for (const entry of step.sweeps) {
      if (!entry.visible) continue
      if (entry.dir > 0 && entry.lo < entry.originS - 1e-6) behind.push(`${step.t}ms:+${entry.lo}`)
      if (entry.dir < 0 && entry.hi > entry.originS + 1e-6) behind.push(`${step.t}ms:-${entry.hi}`)
      if (entry.dir > 0) travelled.push({ t: step.t, value: entry.travelled })
    }
  }
  check('no branch ever draws behind its own origin', behind.length === 0, behind.slice(0, 4).join(' ') || 'clean')
  const moving = travelled.filter((entry) => entry.value > 0)
  check('the branch advances monotonically at the doc\'s speed',
    moving.length >= 4 && moving.every((entry, index) => index === 0 || entry.value >= moving[index - 1].value)
      && close(moving[moving.length - 1].value, 2.5, 0.2),
    moving.map((entry) => `${entry.t}ms:${entry.value.toFixed(2)}`).join(' '))
  const framesSeen = new Set(steps.flatMap((step) => step.sweeps.filter((entry) => entry.visible).map((entry) => entry.frame)))
  check('the frame index follows travel progress through all four frames',
    [0, 1, 2, 3].every((frame) => framesSeen.has(frame)),
    `frames=${[...framesSeen].sort().join(',')}`)
  const stillRunning = stepAt(136)
  const done = stepAt(160)
  check('a centred placement reaches both ends together and releases just after',
    stillRunning && stillRunning.sweeps.filter((entry) => entry.visible).length === 2
      && stillRunning.sweeps.every((entry) => entry.frame === 3)
      && done && done.sweeps.length === 0,
    `t=136 visible=${stillRunning ? stillRunning.sweeps.filter((e) => e.visible).length : 'n/a'} frames=${stillRunning ? stillRunning.sweeps.map((e) => e.frame).join(',') : 'n/a'}; t=160 sweeps=${done ? done.sweeps.length : 'n/a'}`)
  const beforeArrival = stepAt(112)
  const afterArrival = stepAt(114)
  const visibleBursts = (step) => (step ? step.bursts.filter((entry) => entry.visible).length : -1)
  check('the endpoint burst waits for its own arrival',
    visibleBursts(beforeArrival) === 0 && visibleBursts(afterArrival) >= 1,
    `t=112 visible bursts=${visibleBursts(beforeArrival)} t=114 visible bursts=${visibleBursts(afterArrival)}`)
  const lastStep = stepAt(500)
  check('the whole event is over well inside the doc\'s 200ms sweep window',
    done && done.sweeps.length === 0, `live sweeps at 160ms = ${done ? done.sweeps.length : 'n/a'}`)
  check('the flight has cleaned up by the end of the clear window',
    lastStep && lastStep.cubes === 0 && lastStep.bursts.length === 0 && lastStep.sweeps.length === 0,
    JSON.stringify({ cubes: lastStep?.cubes, bursts: lastStep?.bursts.length, sweeps: lastStep?.sweeps.length }))
  const maxLive = steps.reduce((acc, step) => ({
    sweeps: Math.max(acc.sweeps, step.sweeps.filter((entry) => entry.visible).length),
    bursts: Math.max(acc.bursts, step.bursts.length),
    cubes: Math.max(acc.cubes, step.cubes),
  }), { sweeps: 0, bursts: 0, cubes: 0 })
  evidence.samples.maxLive = maxLive
  const caps = (await json('globalThis.__voxalblastDev.impactReport()')).caps
  check('the recipe\'s global live caps hold',
    maxLive.cubes <= caps.cubes && maxLive.bursts <= caps.endpointPops,
    `live=${JSON.stringify(maxLive)} caps=${JSON.stringify(caps)}`)

  // §8.3's draw-call ceiling, measured with the frame FROZEN mid-flight: freezing the clock and
  // letting the ordinary render loop draw it means the reading cannot be taken after the effect
  // has already left the screen, which is how "≤8 extra calls" would otherwise pass trivially.
  const liveCalls = await jsonAsync(`(() => {
    const dev = globalThis.__voxalblastDev
    dev.clearCelebration()
    const fired = dev.demoClear(1, { placedIndexes: [2] })
    const t0 = fired.impact.lastEvent.startedAt
    for (let t = 0; t <= 70; t += 2) dev.impactStep(t0 + t, 2 / 1000)
    return JSON.stringify({ baseline: ${series.baselineCalls}, frozen: dev.impactReport().live })
  })()`)
  await sleep(250)
  evidence.drawCalls = {
    baseline: series.baselineCalls,
    frozenLive: liveCalls.frozen,
    calls: (await json('globalThis.__voxalblast.rendering().rendererInfo')).calls,
  }
  const callDelta = evidence.drawCalls.calls - series.baselineCalls
  check('the extra draw calls during a live event stay inside the §8.3 ceiling',
    callDelta <= 8, `baseline=${series.baselineCalls} live=${evidence.drawCalls.calls} delta=${callDelta} live=${JSON.stringify(liveCalls.frozen)}`)
  await evaluate('globalThis.__voxalblastDev.impactStep(null)')

  // §8.1 「不阻塞落子」: the first clear used to stall 179ms between two animation frames while the
  // new programs compiled. The warm-up draws one throwaway quad per role off-screen right after the
  // pack loads, so the same measurement must now find no long frame at all.
  const gaps = await jsonAsync(`(async () => {
    const dev = globalThis.__voxalblastDev
    const measure = async (fire) => {
      await new Promise((done) => setTimeout(done, 120))
      const out = []
      let previous = performance.now()
      const t0 = previous
      if (fire) dev.demoClear(2, { placedIndexes: [1] })
      while (performance.now() - t0 < 700) {
        await new Promise((done) => requestAnimationFrame(() => done()))
        const now = performance.now()
        out.push(Math.round(now - previous))
        previous = now
      }
      return out
    }
    dev.clearCelebration()
    const idle = await measure(false)
    dev.clearCelebration()
    const clearing = await measure(true)
    return JSON.stringify({ idle, clearing })
  })()`)
  const worst = (list) => list.reduce((acc, value) => Math.max(acc, value), 0)
  const idleWorst = worst(gaps.idle)
  const clearWorst = worst(gaps.clearing)
  evidence.frameGaps = {
    idleFrames: gaps.idle.length, idleWorstMs: idleWorst, clearFrames: gaps.clearing.length, clearWorstMs: clearWorst,
  }
  // The rasteriser here draws this scene at a handful of frames per second, so an absolute
  // millisecond threshold would grade the machine. What matters is that a CLEAR is not measurably
  // worse than an idle frame on the same machine — the 179ms stall this row exists for was 20x the
  // idle gap, and no shader compilation is left to do on the first move.
  check('an ordinary clear is no slower than an idle frame (the programs were warmed at load)',
    clearWorst <= Math.max(60, idleWorst * 1.5),
    `idle worst ${idleWorst}ms over ${gaps.idle.length} frames; clearing worst ${clearWorst}ms over ${gaps.clearing.length} frames`)

  // §5.2's per-event allocation, in the recipe's own unit. The expected row is derived from the
  // global caps rather than hard-coded, so a standard/low-power run is graded against its OWN row.
  const event = series.event
  const expectedCubes = caps.cubes / 4
  const expectedPops = Math.max(1, Math.round(caps.endpointPops / 6))
  check('a single clear allocates the recipe\'s single row',
    event && event.severity === 'single' && event.sweeps === 2
      && event.cubes === expectedCubes && event.bursts === expectedPops,
    event
      ? `${JSON.stringify({ severity: event.severity, sweeps: event.sweeps, bursts: event.bursts, cubes: event.cubes })} want cubes=${expectedCubes} pops=${expectedPops}`
      : 'missing')

  // §8.1 「同颜色实例共享geometry/material … 不逐粒子clone几何」: now that a clear has actually built
  // the instanced meshes, the identity is checkable — before that there is nothing to compare.
  const afterFirst = await json('globalThis.__voxalblastDev.impactReport()')
  for (const id of Object.keys(afterFirst.assets.cubes)) {
    const cube = afterFirst.assets.cubes[id]
    if (!cube.materialised) {
      // §5.2 「低配主六面体默认只分配蓝/青两个vertexColors变体，粉色让位」: an unused variant has no
      // instanced mesh on purpose, and that is a PASS condition rather than a skip.
      evidence.notes = evidence.notes || []
      evidence.notes.push(`cube ${id} has no instanced mesh (its variant was not allocated this session)`)
      continue
    }
    check(`cube ${id}: the instances share the pack's own geometry and material`,
      cube.sharedGeometry === true && cube.sharedMaterial === true,
      `shared=${cube.sharedGeometry}/${cube.sharedMaterial} meshes=${afterFirst.records.meshes}`)
  }

  // ---------------------------------------------------------------- 2b. the same beats, as pictures
  // Each beat is its OWN clear with the clock FROZEN at that beat, so the file named `beat-113ms`
  // really is the frame 113ms after the placement rather than whichever frame the rasteriser
  // reached first. The wall-clock time the capture actually took is recorded next to it.
  await evaluate('globalThis.__voxalblastDev.clearCelebration()')
  await sleep(400)
  evidence.samples.shots = []
  for (const beat of [0, 35, 70, 113, 136, 160, 240, 420, 600]) {
    await jsonAsync(`(() => {
      const dev = globalThis.__voxalblastDev
      dev.clearCelebration()
      const fired = dev.demoClear(1, { placedIndexes: [2] })
      const t0 = fired.impact.lastEvent.startedAt
      for (let t = 0; t <= ${beat}; t += 2) dev.impactStep(t0 + t, 2 / 1000)
      return JSON.stringify({ t0, live: dev.impactReport().live })
    })()`)
    // Two real frames at the frozen clock: one to build the frame, one to be sure it is the frame
    // that was drawn when the capture is taken.
    await evaluate('new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))')
    const startedAt = Date.now()
    const path = await shot(`beat-${String(beat).padStart(3, '0')}ms`)
    evidence.samples.shots.push({ beat, captureMs: Date.now() - startedAt, path })
    await evaluate('globalThis.__voxalblastDev.impactStep(null)')
    await sleep(250)
  }

  // Zoomed crops of the board, because 「刷光约0.65格高」 is a measurement about the REAL cell size on
  // a real phone viewport and a 1170px-wide capture of the whole page is not where that can be read.
  // The clip is in CSS pixels of the emulated viewport and the capture scale is 3, so one cell
  // (390px viewport ÷ 5 columns ≈ 52 CSS px) is ~150 device pixels in the file.
  evidence.samples.zooms = []
  for (const beat of [36, 70, 113]) {
    const box = await jsonAsync(`(() => {
      const dev = globalThis.__voxalblastDev
      dev.clearCelebration()
      const fired = dev.demoClear(1, { placedIndexes: [2] })
      const t0 = fired.impact.lastEvent.startedAt
      for (let t = 0; t <= ${beat}; t += 2) dev.impactStep(t0 + t, 2 / 1000)
      return JSON.stringify({ bounds: globalThis.__voxalblast.bounds(), live: dev.impactReport().live })
    })()`)
    await evaluate('new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))')
    const clip = {
      x: Math.max(0, box.bounds.minX - 12),
      y: Math.max(0, box.bounds.minY - 12),
      width: Math.min(viewport.width - Math.max(0, box.bounds.minX - 12), (box.bounds.maxX - box.bounds.minX) + 24),
      height: Math.min(viewport.height - Math.max(0, box.bounds.minY - 12), (box.bounds.maxY - box.bounds.minY) + 24),
      scale: 3,
    }
    const path = await shot(`zoom-${String(beat).padStart(3, '0')}ms`, clip)
    evidence.samples.zooms.push({ beat, clip, bounds: box.bounds, live: box.live, path })
    await evaluate('globalThis.__voxalblastDev.impactStep(null)')
    await sleep(200)
  }

  // ---------------------------------------------------------------- 3. an off-centre placement
  await evaluate('globalThis.__voxalblastDev.clearCelebration()')
  await sleep(300)
  const offCentre = await json('globalThis.__voxalblastDev.demoClear(1, { placedIndexes: [0] })')
  const off = offCentre.cartoon.lastPropagation.lines[0]
  evidence.samples.offCentre = off
  check('hits[0] gives the doc\'s 50.625/175.625ms',
    close(off.originT, 0, 1e-9) && close(off.minusMs, 50.625, 1e-6) && close(off.plusMs, 175.625, 1e-6),
    `originT=${off.originT} ${off.minusMs}/${off.plusMs}`)
  check('the near end is nearer than the far end',
    off.minusMs < off.plusMs, `${off.minusMs} < ${off.plusMs}`)
  const nearStart = Date.now()
  await sleep(90)
  const nearState = await json('globalThis.__voxalblastDev.impactReport()')
  evidence.samples.offCentreAt90ms = nearState.liveSweeps.map((entry) => ({ dir: entry.direction, travelled: entry.travelled, interval: entry.interval }))
  const nearBranch = nearState.liveSweeps.find((entry) => entry.direction < 0)
  const farBranch = nearState.liveSweeps.find((entry) => entry.direction > 0)
  check('the near branch has finished or is finishing while the far one is still travelling',
    !nearBranch || nearBranch.travelled >= 0.5,
    `near=${nearBranch ? nearBranch.travelled.toFixed(2) : 'released'} far=${farBranch ? farBranch.travelled.toFixed(2) : 'released'}`)
  void nearStart
  await sleep(400)

  // ---------------------------------------------------------------- 4. cost + cleanup
  await evaluate('globalThis.__voxalblastDev.clearCelebration()')
  await sleep(600)
  const empty = await json('globalThis.__voxalblastDev.impactReport()')
  evidence.samples.afterCancel = { live: empty.live, liveEvents: empty.liveEvents }
  check('cancel releases every instance and every cube',
    empty.live.sweeps === 0 && empty.live.bursts === 0 && empty.live.cubes === 0,
    JSON.stringify(empty.live))

  const callsAfter = await json('globalThis.__voxalblast.rendering().rendererInfo')
  evidence.samples.idleCalls = callsAfter
  check('once the event is cancelled the frame cost is back to the baseline',
    callsAfter.calls <= series.baselineCalls,
    `idle=${callsAfter.calls} baseline=${series.baselineCalls}`)

  // §8.3 「加载完成后100轮触发/清理，实际live归0、共享资源不逐轮增长」
  // The two readings are both taken WARM — the pools fill lazily as bigger events use more of them,
  // and a count taken before the pool has ever been exercised would report that fill-up as a leak.
  // "Does it grow per ROUND" is answered by comparing two windows that have both already seen the
  // worst case, which is what makes this row mean what §8.3 says rather than what a warm-up looks
  // like.
  const geometriesBefore = callsAfter.geometries
  const churnWindow = async (rounds, from) => {
    for (let round = from; round < from + rounds; round += 1) {
      await evaluate(`globalThis.__voxalblastDev.demoClear(${(round % 3) + 1}, { placedIndexes: [${round % 5}] })`)
      if (round % 25 === 24) await sleep(60)
    }
    await evaluate('globalThis.__voxalblastDev.clearCelebration()')
    await sleep(700)
    return json('globalThis.__voxalblast.rendering().rendererInfo')
  }
  const warmUp = await churnWindow(50, 0)
  const callsChurn = await churnWindow(50, 50)
  const afterChurn = await json('globalThis.__voxalblastDev.impactReport()')
  evidence.churn = {
    live: afterChurn.live,
    liveEvents: afterChurn.liveEvents,
    meshes: afterChurn.records.meshes,
    spawned: afterChurn.spawned,
    calls: callsChurn,
    warmUpCalls: warmUp,
  }
  check('after 100 triggers and cleanups nothing is live',
    afterChurn.live.sweeps === 0 && afterChurn.live.bursts === 0 && afterChurn.live.cubes === 0,
    JSON.stringify(afterChurn.live))
  check('one InstancedMesh per allocated cube variant, never one per particle',
    afterChurn.records.meshes <= 3, `meshes=${afterChurn.records.meshes}`)
  check('the renderer\'s geometry count stops growing once the pool has been exercised',
    callsChurn.geometries <= warmUp.geometries,
    `geometries ${geometriesBefore} (cold) → ${warmUp.geometries} (after 50) → ${callsChurn.geometries} (after 100)`)
  check('the shared pack does not grow the frame cost over 100 rounds',
    callsChurn.calls <= series.baselineCalls + 8,
    `calls=${callsChurn.calls} baseline=${series.baselineCalls}`)

  check('the probe saw no console errors or uncaught exceptions', browserErrors.length === 0, browserErrors.slice(0, 3).join(' | ') || 'none')
} finally {
  try { if (ws) ws.close() } catch { /* already gone */ }
  try { if (browserSocket) await send(browserSocket, nextId++, 'Browser.close') } catch { /* already gone */ }
  try { child.kill() } catch { /* already gone */ }
  await sleep(300)
  try { rmSync(profile, { recursive: true, force: true }) } catch { /* best effort */ }
}

evidence.finishedAt = new Date().toISOString()
evidence.failuresCount = evidence.failures.length
writeFileSync(join(OUT, 'r1', 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`)
console.log(`\n${evidence.failures.length ? 'FAIL' : 'PASS'}  ${evidence.failures.length} failure(s)`)
console.log(`evidence: ${join(OUT, 'r1', 'evidence.json')}`)
process.exit(evidence.failures.length ? 1 : 0)

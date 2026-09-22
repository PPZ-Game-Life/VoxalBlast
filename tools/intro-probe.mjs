// Opening creation wave probe for 03 §「进入单局」(v0.8.21), headless Edge over CDP.
//
//   node tools/intro-probe.mjs [url] [outDir]
//   npm run probe:intro            (needs `npm run dev` running)
//
// What it proves, on a desktop viewport (1440×900) and a phone viewport (390×844):
//   1. The board does NOT appear complete: mid-wave some blocks are built and some have
//      not started, and the wavefront runs screen bottom-left -> top-right.
//   2. It crosses SEVERAL FACES AT ONCE -the front is one sweep over the whole cube,
//      not six faces played in turn.
//   3. Painted (occupied) blocks join later than the bare timber, on average, by the
//      configured beat.
//   4. It is over inside the window the design fixes (0.8-1.2s), with one block taking
//      160-220ms and adjacent bands 25-40ms apart.
//   5. Afterwards every block is back on its AUTHORED transform, wearing the shared
//      material (not the wave's per-block clone), shadowing again and opaque -and the
//      board itself is byte-identical to what it was before the wave.
//   6. Input is locked while it plays (a real drag does not move the cube) and released
//      the moment it ends (the same drag does).
//   7. A restart re-arms it instead of stacking two waves.
//   8. prefers-reduced-motion replaces the per-block wave with ONE whole-board fade of
//      150-200ms: every block at the same opacity, no block moved, no block scaled.
//
// The visual evidence is written as a frame sequence (CDP screencast) -a recording of
// the wave, one PNG per captured frame -to <outDir>, plus a screenshot fallback if the
// screencast yields nothing.
//
// Pitfalls already handled (do not re-solve): own temp profile + OS-assigned debug port
// per run; Browser.close before profile removal; every assertion reads the dev-visible
// read-only hook, never a class name or a private variable.
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
const url = (process.argv[2] || 'http://127.0.0.1:5173/').replace(/\/?$/, '/')
const outDir = resolve(ROOT, process.argv[3] || 'artifacts/visual/intro')
const CHROME_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
]
const BROWSER = CHROME_CANDIDATES.find((path) => path && existsSync(path))
if (!BROWSER) throw new Error(`no headless browser found; tried:\n  ${CHROME_CANDIDATES.join('\n  ')}`)

const VIEWS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
]
const MAX_FRAMES = 40

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
    const timeout = setTimeout(() => finish(new Error(`${method}: timed out`)), 20000)
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

// `progress` is only carried by the full read: the polling read runs every ~80ms and
// has no use for 98 rows.
const STATE = (full) => `(() => {
  const api = globalThis.__voxalblast
  if (!api) return JSON.stringify({ missing: true })
  const intro = api.intro()
  return JSON.stringify({
    home: api.home().open,
    status: document.querySelector('#status').textContent,
    pose: api.rotation().pose,
    locked: intro.locked,
    board: ${full ? 'api.board()' : 'undefined'},
    intro: intro.active ? { ...intro, progress: ${full ? 'intro.progress' : 'undefined'} } : intro,
  })
})()`

const profile = mkdtempSync(join(tmpdir(), 'voxalblast-intro-'))
const child = spawn(BROWSER, [
  '--headless=new', '--disable-gpu', '--disable-breakpad', '--hide-scrollbars',
  '--no-first-run', '--no-default-browser-check', '--force-device-scale-factor=1',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1440,900', 'about:blank',
], { stdio: 'ignore', windowsHide: true })

const failures = []
function check(label, condition, detail) {
  console.log(`${condition ? 'OK  ' : 'FAIL'} ${label}${detail === undefined ? '' : `  ${detail}`}`)
  if (!condition) failures.push(label)
}
const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : Number.NaN)
const round = (value, digits = 3) => Number(value.toFixed(digits))
// The wave's own coordinate: NDC +x right, +y up, so this runs 0 at screen bottom-left.
const diagonal = (entry) => entry.x * 0.5 + entry.y * 0.5 + 0.5

let ws
let browserSocket = null
const browserErrors = []
const screencast = { collecting: false, frames: [] }

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
    if (method === 'Page.screencastFrame') {
      if (screencast.collecting && screencast.frames.length < MAX_FRAMES) {
        screencast.frames.push({ data: params.data, timestamp: params.metadata?.timestamp ?? null })
      }
      // Frames are not delivered until the previous one is acknowledged; without this
      // the screencast stops after the first.
      send(ws, nextId++, 'Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {})
    }
  })
  await send(ws, 1, 'Page.enable')
  await send(ws, 2, 'Runtime.enable')

  const evalJs = async (expression, awaitPromise = false) => {
    const result = await send(ws, nextId++, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
    if (result.exceptionDetails) throw new Error(`evaluate threw: ${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`)
    return result.result?.value
  }
  const state = async (full = false) => JSON.parse(await evalJs(STATE(full)))
  const armWave = () => evalJs('globalThis.__voxalblastDev.replayIntro()')
  // Poll until the wave reports itself finished rather than sleeping a magic number:
  // the assertions below grade what the wave LEFT behind, so they must not run while
  // it is still in flight (a slow frame is not a failure of the wave).
  const waitForSettle = async (maxMs = 4000) => {
    const start = Date.now()
    while (Date.now() - start < maxMs) {
      if ((await state()).intro.active === false) return Date.now() - start
      await sleep(60)
    }
    return null
  }
  const notReduced = (v) => !v

  const gesture = async (dx) => {
    const box = JSON.parse(await evalJs(`(() => {
      const r = document.querySelector('#scene-wrap').getBoundingClientRect()
      return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) })
    })()`))
    await send(ws, nextId++, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', buttons: 1, clickCount: 1 })
    for (let i = 1; i <= 6; i += 1) {
      await send(ws, nextId++, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x + (dx * i) / 6, y: box.y, button: 'left', buttons: 1 })
      await sleep(16)
    }
    await send(ws, nextId++, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x + dx, y: box.y, button: 'left', buttons: 0, clickCount: 1 })
    await sleep(500) // let the face snap settle: the pose is only comparable at rest
  }
  const samePose = (a, b) => JSON.stringify(a) === JSON.stringify(b)

  // ---- the wave the player actually gets, recorded as a frame sequence -----------
  // The screencast is started BEFORE the click so the very first frames of the wave are
  // in the recording, and it is the only capture path here that can hold several frames
  // per animation (Page.captureScreenshot costs 200-400ms, i.e. a third of the wave).
  const recordOpening = async (view, label) => {
    screencast.frames = []
    screencast.collecting = true
    await send(ws, nextId++, 'Page.startScreencast', { format: 'png', maxWidth: view.width, maxHeight: view.height, everyNthFrame: 1 })
    await evalJs('document.querySelector("#home-primary").click()')
    await sleep(1800)
    await send(ws, nextId++, 'Page.stopScreencast')
    screencast.collecting = false
    const dir = join(outDir, view.name)
    mkdirSync(dir, { recursive: true })
    screencast.frames.forEach((frame, index) => {
      writeFileSync(join(dir, `${version}-${label}-${String(index + 1).padStart(2, '0')}.png`), Buffer.from(frame.data, 'base64'))
    })
    if (screencast.frames.length >= 6) return screencast.frames.length
    // Fallback: the platform refused to stream, so capture stills instead. The frame
    // times are then read back from the wave's own clock, not from the wall.
    screencast.frames = []
    for (let i = 0; i < 6; i += 1) {
      const shot = await send(ws, nextId++, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
      const elapsed = (await state()).intro.elapsed
      writeFileSync(join(dir, `${version}-${label}-still-${String(i + 1).padStart(2, '0')}.png`), Buffer.from(shot.data, 'base64'))
      screencast.frames.push({ elapsed })
      await sleep(80)
    }
    return screencast.frames.length
  }

  await send(ws, 3, 'Emulation.setDeviceMetricsOverride', { width: VIEWS[0].width, height: VIEWS[0].height, screenWidth: VIEWS[0].width, screenHeight: VIEWS[0].height, deviceScaleFactor: 1, mobile: false })
  await send(ws, 4, 'Page.navigate', { url })
  await sleep(3600)
  const hasHandle = await evalJs('typeof globalThis.__voxalblastDev?.replayIntro === "function"')
  if (!hasHandle) throw new Error('dev handles missing: point this probe at `npm run dev`')

  for (const view of VIEWS) {
    console.log(`\n--- ${view.name} ${view.width}x${view.height} ---`)
    const at = `${view.name}:`
    await send(ws, nextId++, 'Emulation.setDeviceMetricsOverride', { width: view.width, height: view.height, screenWidth: view.width, screenHeight: view.height, deviceScaleFactor: 1, mobile: view.width < 600 })
    await send(ws, nextId++, 'Emulation.setEmulatedMedia', { features: [] })
    await send(ws, nextId++, 'Page.navigate', { url })
    await sleep(3600)

    const opened = await state()
    check(`${at} opens on the home cover with the run behind it`, opened.home === true && opened.intro.active === false)

    const frames = await recordOpening(view, 'wave')
    await waitForSettle(4000)
    const settled = await state()
    check(`${at} the opening wave was recorded`, frames >= 6, `${frames} frames -> ${join(outDir, view.name)}`)
    check(`${at} it is over by the time a player would look up`, settled.intro.active === false, `locked=${settled.intro.locked}`)
    check(`${at} input is unlocked once it has settled`, settled.intro.locked === false)
    check(`${at} no block was left off its authored transform`, settled.intro.integrity.scaleOff === 0 && settled.intro.integrity.positionOff === 0 && settled.intro.integrity.materialOff === 0 && settled.intro.integrity.opacityOff === 0 && settled.intro.integrity.shadowOff === 0, JSON.stringify(settled.intro.integrity))

    // ---- the wave's own timeline, sampled while it plays --------------------------
    const boardBefore = (await state(true)).board
    await armWave()
    const t0 = Date.now()
    const samples = []
    for (let i = 0; i < 24; i += 1) {
      const sample = await state()
      samples.push({ at: (Date.now() - t0) / 1000, ...sample })
      if (samples.length > 3 && sample.intro.active === false) break
      await sleep(70)
    }
    const live = samples.filter((sample) => sample.intro.active)
    const wallMs = samples.find((sample) => sample.intro.active === false)?.at
    check(`${at} the wave was sampled in flight`, live.length >= 4, `${live.length} live samples`)
    const config = live[0]?.intro.config ?? {}
    check(`${at} one block takes 160-220ms`, config.duration >= 0.16 && config.duration <= 0.22, `${config.duration}s`)
    check(`${at} adjacent wavefront bands are 25-40ms apart`, config.bandStagger >= 0.025 && config.bandStagger <= 0.04, `${config.bandStagger}s × ${config.bandCount} bands`)
    check(`${at} painted blocks join 40-60ms later`, config.occupiedDelay >= 0.04 && config.occupiedDelay <= 0.06, `${config.occupiedDelay}s`)
    check(`${at} the whole wave fits 0.8-1.2s`, live[0].intro.total >= 0.8 && live[0].intro.total <= 1.2, `total ${live[0].intro.total}s`)
    check(`${at} it really takes about that long on the clock`, wallMs >= 0.8 && wallMs <= 1.45, `${round(wallMs)}s wall`)
    check(`${at} the board is not complete mid-wave`, live.some((sample) => sample.intro.built > 0 && sample.intro.pending > 0), live.map((sample) => `${round(sample.at, 2)}s:${sample.intro.built}/${sample.intro.pending}`).join(' '))
    check(`${at} input is locked while it plays`, live.every((sample) => sample.intro.locked === true))

    // One full read close to the middle of the wave: the front's shape and the
    // painted blocks' lag are properties of the schedule, and this is where it shows.
    await armWave()
    await sleep(440)
    const mid = await state(true)
    check(`${at} the mid-wave read caught it in flight`, mid.intro.active === true, `elapsed=${mid.intro.elapsed}`)
    if (mid.intro.active) {
      const progress = mid.intro.progress
      const built = progress.filter((entry) => entry.opacity > 0.99)
      const pending = progress.filter((entry) => entry.opacity <= 0)
      check(`${at} part of the cube is built and part is still missing`, built.length > 0 && pending.length > 0, `built=${built.length} pending=${pending.length}`)
      if (built.length && pending.length) {
        const builtMean = mean(built.map(diagonal))
        const pendingMean = mean(pending.map(diagonal))
        check(`${at} the front runs bottom-left -> top-right`, builtMean < pendingMean - 0.08, `built ${round(builtMean, 3)} vs pending ${round(pendingMean, 3)} (0 = bottom-left)`)
        const builtFaces = new Set(built.flatMap((entry) => entry.faces))
        const pendingFaces = new Set(pending.flatMap((entry) => entry.faces))
        check(`${at} one front crosses several faces at once`, builtFaces.size >= 2 && pendingFaces.size >= 2, `built on ${builtFaces.size} faces, pending on ${pendingFaces.size}`)
      }
      const paintedDelay = mean(progress.filter((entry) => entry.painted).map((entry) => entry.delay))
      const bareDelay = mean(progress.filter((entry) => !entry.painted).map((entry) => entry.delay))
      check(`${at} painted blocks are scheduled later, on average`, paintedDelay - bareDelay > 0.02, `+${round(paintedDelay - bareDelay, 3)}s (${progress.filter((entry) => entry.painted).length} painted)`)
      check(`${at} painted blocks are the only ones that light up`, progress.every((entry) => entry.painted || entry.emissive === 0))
    }
    await waitForSettle(4000)
    const afterWave = await state(true)
    check(`${at} the wave leaves the board exactly as it found it`, JSON.stringify(afterWave.board) === JSON.stringify(boardBefore))
    check(`${at} nothing is left scaled, dimmed, invisible or shadowless`, afterWave.intro.integrity.scaleOff === 0 && afterWave.intro.integrity.positionOff === 0 && afterWave.intro.integrity.materialOff === 0 && afterWave.intro.integrity.opacityOff === 0 && afterWave.intro.integrity.shadowOff === 0, JSON.stringify(afterWave.intro.integrity))

    // ---- input: locked during, live after ----------------------------------------
    await armWave()
    await sleep(200)
    const poseLocked = await state()
    await gesture(150)
    const poseAfterBlocked = await state()
    check(`${at} a drag during the wave does not turn the cube`, samePose(poseLocked.pose, poseAfterBlocked.pose), `during=${poseAfterBlocked.intro.active}`)
    await waitForSettle(4000)
    const poseAtRest = (await state()).pose
    await gesture(150)
    const poseAfterAllowed = await state()
    check(`${at} the same drag turns it again after the wave`, notReduced(samePose(poseAtRest, poseAfterAllowed.pose)))

    // ---- rapid restart: re-armed, never stacked ----------------------------------
    await armWave()
    await sleep(150)
    const t2 = Date.now()
    await armWave()
    await sleep(430)
    const restarted = await state()
    const sinceArm = (Date.now() - t2) / 1000
    check(`${at} a second wave replaces the first instead of stacking`, restarted.intro.active === true && restarted.intro.elapsed <= sinceArm + 0.06, `elapsed=${restarted.intro.elapsed}s since restart=${round(sinceArm)}s`)
    await waitForSettle(4000)
    const afterRestart = await state()
    check(`${at} the restarted wave settles clean`, afterRestart.intro.active === false && afterRestart.intro.locked === false && afterRestart.intro.integrity.positionOff === 0 && afterRestart.intro.integrity.scaleOff === 0, JSON.stringify(afterRestart.intro.integrity))

    // ---- prefers-reduced-motion: one whole-board fade, no per-block motion -------
    await send(ws, nextId++, 'Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    await send(ws, nextId++, 'Page.navigate', { url })
    await sleep(3600)
    await evalJs('document.querySelector("#home-primary").click()')
    await sleep(70)
    const reduced = await state(true)
    check(`${at} reduced motion is picked up at arm time`, reduced.intro.active === true && reduced.intro.reduced === true, `elapsed=${reduced.intro.elapsed}`)
    if (reduced.intro.active && reduced.intro.reduced) {
      check(`${at} reduced motion fades over 150-200ms`, reduced.intro.total >= 0.15 && reduced.intro.total <= 0.2, `total ${reduced.intro.total}s`)
      const opacities = reduced.intro.progress.map((entry) => entry.opacity)
      check(`${at} every block fades together`, Math.max(...opacities) - Math.min(...opacities) < 0.02, `spread ${round(Math.max(...opacities) - Math.min(...opacities), 4)}`)
      check(`${at} no block is scaled or moved`, reduced.intro.progress.every((entry) => entry.scale === 1) && reduced.intro.integrity.positionOff === 0 && reduced.intro.integrity.scaleOff === 0)
      check(`${at} blocks keep their shadows while they fade`, reduced.intro.integrity.shadowOff === 0)
    }
    await sleep(600)
    const afterReduced = await state()
    check(`${at} the reduced fade is over quickly`, afterReduced.intro.active === false && afterReduced.intro.locked === false)
  }

  check('no browser console errors', browserErrors.length === 0, browserErrors.join(' | '))
} finally {
  try { if (browserSocket?.readyState === WebSocket.OPEN) await send(browserSocket, 9999, 'Browser.close') } catch {}
  try { ws?.close() } catch {}
  await sleep(500)
  if (child.exitCode === null) {
    try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) } catch {}
    await sleep(600)
  }
  // Recursive removal stays inside the real temp directory and only targets this
  // driver's own profile, even if TEMP holds an unexpected path.
  try {
    const tempRoot = realpathSync(tmpdir())
    const actual = realpathSync(profile)
    const suffix = relative(tempRoot, actual)
    const insideTemp = suffix && !suffix.startsWith('..') && !suffix.includes(sep)
    if (insideTemp && basename(actual).startsWith('voxalblast-intro-')) {
      rmSync(actual, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
    }
  } catch {}
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed:\n  - ${failures.join('\n  - ')}`)
  process.exitCode = 1
} else {
  console.log(`\nopening creation wave verified on ${VIEWS.length} viewports; frame sequence in ${outDir}`)
}

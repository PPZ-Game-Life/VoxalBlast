// Opening creation wave probe for 03 §6 (v0.8.22), headless Edge over CDP.
//
//   node tools/intro-probe.mjs [url] [outDir]
//   npm run probe:intro            (needs `npm run dev` running)
//
// The run opens on a live board (v0.8.22), so the wave plays on load. This probe grades
// it on a desktop viewport (1440×900) and a phone viewport (390×844):
//   1. A refresh lands INSIDE a run and arms exactly ONE wave — never the home cover.
//   2. Stage 1 builds the cube along the screen bottom-left → top-right diagonal, across
//      SEVERAL FACES AT ONCE, and every block it builds wears a PRIMER colour: no timber,
//      no crayon paint. The primer family is the designed one, not noise.
//   3. The hold: the primed cube stands complete and still before anything repaints.
//   4. Stage 2 repaints each block into the colour the BOARD actually has — bare cells to
//      timber, occupied cells to their own paint, occupied ones a beat later — and passes
//      through a state where some blocks are repainted and some are not.
//   5. It is longer than the v0.8.21 single pass by design (the producer's "太快，看不清"
//      report): one block takes 300ms to build and the whole thing runs ~2.85s.
//   6. Afterwards every block is back on its AUTHORED transform, wearing the SHARED
//      material (not the wave's per-block clone), shadowing again and opaque — and the
//      board is byte-identical to what it was before the wave.
//   7. Input is locked while it plays (a real drag does not move the cube) and released
//      the moment it ends (the same drag does).
//   8. A restart re-arms it instead of stacking two waves.
//   9. prefers-reduced-motion goes straight to the BOARD's colours in one 150–200ms fade
//      with no per-block motion and no primer pass at all.
//
// The visual evidence is a frame sequence (CDP screencast) of the real boot, one PNG per
// captured frame, written to <outDir>.
//
// Pitfalls already handled (do not re-solve): own temp profile + OS-assigned debug port
// per run; Browser.close before profile removal; the screencast needs
// Page.screencastFrameAck or it stops after one frame, and it catches the blank page
// before the canvas paints — those frames are dropped by size, not by timing.
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
const MAX_FRAMES = 60
// A frame with no canvas in it (about:blank, the pre-paint page) is a few kB of flat
// colour; anything with the meadow and the cube on it is hundreds of kB.
const BLANK_FRAME_BYTES = 40000

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

// `progress` is only carried by the full read: the polling read runs every ~70ms and has
// no use for 98 rows.
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
        screencast.frames.push({ data: params.data, bytes: params.data.length })
      }
      // Frames are not delivered until the previous one is acknowledged; without this the
      // screencast stops after the first.
      send(ws, nextId++, 'Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {})
    }
  })
  await send(ws, 1, 'Page.enable')
  await send(ws, 2, 'Runtime.enable')

  const evalJs = async (expression) => {
    const result = await send(ws, nextId++, 'Runtime.evaluate', { expression, returnByValue: true })
    if (result.exceptionDetails) throw new Error(`evaluate threw: ${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`)
    return result.result?.value
  }
  const state = async (full = false) => JSON.parse(await evalJs(STATE(full)))
  const armWave = () => evalJs('globalThis.__voxalblastDev.replayIntro()')
  // Poll until the wave reports itself finished rather than sleeping a magic number: the
  // assertions below grade what the wave LEFT behind, so they must not run while it is
  // still in flight (a slow frame is not a failure of the wave).
  const waitForSettle = async (maxMs = 6000) => {
    const start = Date.now()
    while (Date.now() - start < maxMs) {
      if ((await state()).intro.active === false) return Date.now() - start
      await sleep(70)
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

  // ---- the wave the player actually gets, recorded from the real boot --------------
  // The screencast runs across the NAVIGATION, because the wave now starts by itself: a
  // recorder that attaches after load would only ever catch the finished cube.
  const recordBoot = async (view) => {
    screencast.frames = []
    screencast.collecting = true
    await send(ws, nextId++, 'Page.startScreencast', { format: 'png', maxWidth: view.width, maxHeight: view.height, everyNthFrame: 1 })
    await send(ws, nextId++, 'Page.navigate', { url })
    await sleep(6000)
    await send(ws, nextId++, 'Page.stopScreencast')
    screencast.collecting = false
    const sharp = screencast.frames.filter((frame) => frame.bytes >= BLANK_FRAME_BYTES)
    const dir = join(outDir, view.name)
    mkdirSync(dir, { recursive: true })
    sharp.forEach((frame, index) => {
      writeFileSync(join(dir, `${version}-boot-${String(index + 1).padStart(2, '0')}.png`), Buffer.from(frame.data, 'base64'))
    })
    return { frames: sharp.length, raw: screencast.frames.length }
  }

  await send(ws, 3, 'Emulation.setDeviceMetricsOverride', { width: VIEWS[0].width, height: VIEWS[0].height, screenWidth: VIEWS[0].width, screenHeight: VIEWS[0].height, deviceScaleFactor: 1, mobile: false })
  await send(ws, 4, 'Page.navigate', { url })
  await sleep(4200)
  const hasHandle = await evalJs('typeof globalThis.__voxalblastDev?.replayIntro === "function"')
  if (!hasHandle) throw new Error('dev handles missing: point this probe at `npm run dev`')

  for (const view of VIEWS) {
    console.log(`\n--- ${view.name} ${view.width}x${view.height} ---`)
    const at = `${view.name}:`
    await send(ws, nextId++, 'Emulation.setDeviceMetricsOverride', { width: view.width, height: view.height, screenWidth: view.width, screenHeight: view.height, deviceScaleFactor: 1, mobile: view.width < 600 })
    await send(ws, nextId++, 'Emulation.setEmulatedMedia', { features: [] })

    const recording = await recordBoot(view)
    await waitForSettle(6000)
    const settled = await state()
    check(`${at} the boot wave was recorded`, recording.frames >= 6, `${recording.frames} frames of ${recording.raw} -> ${join(outDir, view.name)}`)
    check(`${at} a refresh lands inside a run, not on the home cover`, settled.home === false && settled.intro.plays === 1, `plays=${settled.intro.plays}`)
    check(`${at} the wave is over`, settled.intro.active === false, `locked=${settled.intro.locked}`)
    check(`${at} input is unlocked once it has settled`, settled.intro.locked === false)
    check(`${at} no block was left off its authored transform`, settled.intro.integrity.scaleOff === 0 && settled.intro.integrity.positionOff === 0 && settled.intro.integrity.materialOff === 0 && settled.intro.integrity.opacityOff === 0 && settled.intro.integrity.shadowOff === 0, JSON.stringify(settled.intro.integrity))

    // ---- the wave's own timeline, sampled while it plays --------------------------
    const boardBefore = (await state(true)).board
    await armWave()
    const t0 = Date.now()
    const samples = []
    for (let i = 0; i < 60; i += 1) {
      const sample = await state()
      samples.push({ at: (Date.now() - t0) / 1000, ...sample })
      if (samples.length > 3 && sample.intro.active === false) break
      await sleep(70)
    }
    const live = samples.filter((sample) => sample.intro.active)
    const wallMs = samples.find((sample) => sample.intro.active === false)?.at
    const timeline = live
      .filter((_, index) => index % 4 === 0)
      .map((sample) => `${round(sample.at, 2)}s:${sample.intro.stage}:${sample.intro.built}/${sample.intro.primed}/${sample.intro.repainted}`)
    check(`${at} the wave was sampled in flight`, live.length >= 8, `${live.length} live samples`)
    const config = live[0]?.intro.config ?? {}
    check(`${at} stage 1 builds one block in 160–400ms`, config.build?.duration >= 0.16 && config.build?.duration <= 0.4, `${config.build?.duration}s`)
    check(`${at} adjacent wavefront bands are 25–50ms apart`, config.build?.bandStagger >= 0.025 && config.build?.bandStagger <= 0.05 && config.paint?.bandStagger >= 0.025 && config.paint?.bandStagger <= 0.05, `build ${config.build?.bandStagger}s / paint ${config.paint?.bandStagger}s × ${config.build?.bandCount} bands`)
    check(`${at} the primer family is the designed one`, Array.isArray(config.primer?.colors) && config.primer.colors.length >= 1 && config.primer.colors.length <= 4 && new Set(config.primer.colors).size === config.primer.colors.length, `${JSON.stringify(config.primer?.colors)}`)
    check(`${at} occupied cells repaint 40–60ms later`, config.paint?.occupiedDelay >= 0.04 && config.paint?.occupiedDelay <= 0.06, `${config.paint?.occupiedDelay}s`)
    check(`${at} both passes together are longer than the v0.8.21 single pass`, live[0].intro.total >= 2.2 && live[0].intro.total <= 4, `total ${live[0].intro.total}s`)
    check(`${at} it really takes about that long on the clock`, wallMs >= 2.0 && wallMs <= 4.6, `${round(wallMs)}s wall`)
    check(`${at} build, hold and paint were all seen`, new Set(live.map((sample) => sample.intro.stage)).size >= 3, timeline.join(' '))
    check(`${at} the board is not complete mid-wave`, live.some((sample) => sample.intro.built > 0 && sample.intro.pending > 0))
    check(`${at} input is locked while it plays`, live.every((sample) => sample.intro.locked === true))

    // ---- stage 1: the primer coat ------------------------------------------------
    await armWave()
    await sleep(520)
    const build = await state(true)
    check(`${at} stage 1 was caught in flight`, build.intro.active === true && build.intro.stage === 'build', `stage=${build.intro.stage} elapsed=${build.intro.elapsed}`)
    if (build.intro.active) {
      const progress = build.intro.progress
      const built = progress.filter((entry) => entry.opacity > 0.99)
      const pending = progress.filter((entry) => entry.opacity <= 0)
      check(`${at} part of the cube is built and part is still missing`, built.length > 0 && pending.length > 0, `built=${built.length} pending=${pending.length}`)
      if (built.length && pending.length) {
        const builtMean = mean(built.map(diagonal))
        const pendingMean = mean(pending.map(diagonal))
        check(`${at} the front runs bottom-left -> top-right`, builtMean < pendingMean - 0.08, `built ${round(builtMean)} vs pending ${round(pendingMean)} (0 = bottom-left)`)
        const builtFaces = new Set(built.flatMap((entry) => entry.faces))
        const pendingFaces = new Set(pending.flatMap((entry) => entry.faces))
        check(`${at} one front crosses several faces at once`, builtFaces.size >= 2 && pendingFaces.size >= 2, `built on ${builtFaces.size} faces, pending on ${pendingFaces.size}`)
      }
      check(`${at} stage 1 shows NO game colour anywhere`, built.every((entry) => entry.primer) && built.every((entry) => !entry.final), `${built.filter((entry) => !entry.primer).length} of ${built.length} built blocks are not primer`)
      const primerSeen = new Set(progress.map((entry) => entry.color))
      check(`${at} the primer coat is not cluttered`, primerSeen.size <= build.intro.config.primer.colors.length && [...primerSeen].every((hex) => build.intro.primerHex.includes(hex)), `${[...primerSeen].join(' ')}`)
    }
    await waitForSettle(6000)

    // ---- the hold: primed, complete, not yet repainted ----------------------------
    await armWave()
    const buildWindow = live[0]?.intro.buildWindow ?? 1.4
    await sleep(Math.round((buildWindow + 0.08) * 1000))
    const hold = await state(true)
    if (hold.intro.active) {
      check(`${at} the primed cube stands complete before stage 2`, hold.intro.stage === 'hold' || hold.intro.repainted === 0, `stage=${hold.intro.stage} primed=${hold.intro.primed} repainted=${hold.intro.repainted}`)
      check(`${at} nothing is repainted during the beat`, hold.intro.repainted === 0 && hold.intro.primed === 98, `primed=${hold.intro.primed} repainted=${hold.intro.repainted}`)
    }
    await waitForSettle(6000)

    // ---- stage 2: repaint into the board's own colours ----------------------------
    await armWave()
    const paintStart = live[0]?.intro.paintStart ?? 1.6
    await sleep(Math.round((paintStart + 0.55) * 1000))
    const paint = await state(true)
    check(`${at} stage 2 was caught in flight`, paint.intro.active === true && paint.intro.stage === 'paint', `stage=${paint.intro.stage} elapsed=${paint.intro.elapsed}`)
    if (paint.intro.active && paint.intro.stage === 'paint') {
      const progress = paint.intro.progress
      check(`${at} some blocks are repainted and some are still primer`, paint.intro.repainted > 0 && paint.intro.primed > 0, `repainted=${paint.intro.repainted} primer=${paint.intro.primed}`)
      const paintedLater = mean(progress.filter((entry) => entry.painted).map((entry) => entry.paintDelay))
      const bareLater = mean(progress.filter((entry) => !entry.painted).map((entry) => entry.paintDelay))
      check(`${at} occupied cells repaint later, on average`, paintedLater - bareLater > 0.02, `+${round(paintedLater - bareLater)}s (${progress.filter((entry) => entry.painted).length} painted)`)
      const repainted = progress.filter((entry) => entry.final)
      check(`${at} a repainted block lands on a board colour, never on a primer one`, repainted.every((entry) => !entry.primer), `${repainted.length} repainted`)
      check(`${at} only painted blocks light up while repainting`, progress.every((entry) => entry.painted || entry.emissive === 0))
    }
    await waitForSettle(6000)
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
    await waitForSettle(6000)
    const poseAtRest = (await state()).pose
    await gesture(150)
    const poseAfterAllowed = await state()
    check(`${at} the same drag turns it again after the wave`, notReduced(samePose(poseAtRest, poseAfterAllowed.pose)))

    // ---- rapid restart: re-armed, never stacked ----------------------------------
    const playsBefore = (await state()).intro.plays
    await armWave()
    await sleep(150)
    const t2 = Date.now()
    await armWave()
    await sleep(430)
    const restarted = await state()
    const sinceArm = (Date.now() - t2) / 1000
    check(`${at} a second wave replaces the first instead of stacking`, restarted.intro.active === true && restarted.intro.elapsed <= sinceArm + 0.06 && restarted.intro.plays === playsBefore + 2, `elapsed=${restarted.intro.elapsed}s since restart=${round(sinceArm)}s plays=${restarted.intro.plays}`)
    await waitForSettle(6000)
    const afterRestart = await state()
    check(`${at} the restarted wave settles clean`, afterRestart.intro.active === false && afterRestart.intro.locked === false && afterRestart.intro.integrity.positionOff === 0 && afterRestart.intro.integrity.scaleOff === 0, JSON.stringify(afterRestart.intro.integrity))

    // ---- prefers-reduced-motion: straight to the board's colours ------------------
    await send(ws, nextId++, 'Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    await send(ws, nextId++, 'Page.navigate', { url })
    await sleep(4200)
    const reduced = await state(true)
    if (reduced.intro.active) {
      check(`${at} reduced motion is picked up at arm time`, reduced.intro.reduced === true)
      check(`${at} reduced motion fades over 150–200ms`, reduced.intro.total >= 0.15 && reduced.intro.total <= 0.2, `total ${reduced.intro.total}s`)
      check(`${at} reduced motion skips the primer entirely`, reduced.intro.progress.every((entry) => entry.primer === false) && reduced.intro.progress.every((entry) => entry.final === true))
      const opacities = reduced.intro.progress.map((entry) => entry.opacity)
      check(`${at} every block fades together`, Math.max(...opacities) - Math.min(...opacities) < 0.02, `spread ${round(Math.max(...opacities) - Math.min(...opacities), 4)}`)
      check(`${at} no block is scaled or moved`, reduced.intro.progress.every((entry) => entry.scale === 1) && reduced.intro.integrity.positionOff === 0 && reduced.intro.integrity.scaleOff === 0)
      check(`${at} blocks keep their shadows while they fade`, reduced.intro.integrity.shadowOff === 0)
    } else {
      check(`${at} reduced motion still arms a wave on load`, reduced.intro.plays >= 1, `plays=${reduced.intro.plays}`)
    }
    await waitForSettle(6000)
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
  // Recursive removal stays inside the real temp directory and only targets this driver's
  // own profile, even if TEMP holds an unexpected path.
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
  console.log(`\nopening creation wave (primer + repaint) verified on ${VIEWS.length} viewports; frame sequence in ${outDir}`)
}

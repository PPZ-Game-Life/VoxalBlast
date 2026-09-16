// Measures the ON-SCREEN sense of the cube's swipe rotation in a real headless
// browser, so a "the cube spins against my finger on one side" report can be
// settled with numbers instead of with the eye.
//
//   node tools/swipe-probe.mjs
//
// It synthesises the three vertical gestures the gesture partition distinguishes
// (left band -> roll, right band -> roll, over the cube -> pitch), reads the cube's
// pose through `globalThis.__voxalblast.rotation()` before and after each one, and
// prints the world-space rotation each gesture applied, as an axis-angle.
//
// Reading the axis. The camera sits at positive Z looking at the origin with world
// +Y up, so a rotation about world +Z is counter-clockwise on screen and about world
// -Z is clockwise. A downward drag therefore has to come out as: -Z in the right band
// (the right edge travels down with the finger, which is what the player calls
// correct), +Z in the left band (that band's own edge travels down), and +X over the
// cube (pitch, so the front face slides down). Those three are asserted: the probe
// fails if any of them comes out the other way round — that is the v0.8.1 regression
// (both bands sharing one roll sign, so the left band turned against the finger).
//
// The step is measured as `world = base1 * inverse(base0)` — the rotation the GRID
// pose underwent — not as the pose delta `inverse(pose0) * pose1`. The pose delta is
// conjugated by the grid pose, so it only reads as a world axis while the cube is
// unrotated; the first version of this probe was fooled by exactly that (a start pose
// carrying a 180° roll flipped the pitch row's sign while the cube's real step had not
// changed at all). The pose delta is still reported, as `pose`, so the difference is
// visible instead of being a trap for the next reader.
//
// Browser plumbing is deliberately the same proven shape as tools/screenshot.mjs
// (global WebSocket + CDP, `--headless=new`, `--remote-debugging-port=0`, a fresh
// temp profile, port read from DevToolsActivePort, Browser.close + profile
// removal). No puppeteer, no new dependency.
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const APP_URL = 'http://127.0.0.1:5173/'
const APP_PORT = 5173
const START_VIEWPORT = { width: 900, height: 1200 }
// A side band must leave room for a start point 40px outside the cube's span plus
// a few px of viewport margin, so ~45px is the floor. Narrower than that and the
// start point would land inside the cube and silently become the pitch gesture.
const BAND_MIN_PX = 45
const BAND_OFFSET_PX = 40
const DRAG_DOWN_PX = 140
const MOVE_STEPS = 8
const SETTLE_MS = 900
const STILL_MS = 2500

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Injected at document start (so it survives the per-gesture reloads). Plain JS
// quaternion math, deliberately no three.js import.
const PROBE_SETUP = `(() => {
  const mul = (a, b) => [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
  const conj = (q) => [-q[0], -q[1], -q[2], q[3]];
  const axisAngle = (input) => {
    let [x, y, z, w] = input;
    // q and -q are the same rotation; take the shortest arc so angle is in
    // [0, 180] and the axis carries the direction.
    if (w < 0) { w = -w; x = -x; y = -y; z = -z; }
    const deg = 2 * Math.acos(Math.min(1, Math.max(-1, w))) * 180 / Math.PI;
    const s = Math.hypot(x, y, z);
    const axis = s > 1e-9 ? [x / s, y / s, z / s] : [0, 0, 0];
    const r3 = (v) => Number(v.toFixed(3));
    const a3 = axis.map(r3);
    return { angleDeg: r3(deg), axis: a3, axisText: '(' + a3.map((v) => v.toFixed(3)).join(',') + ')' };
  };
  // The gesture's rotation IN WORLD SPACE. The grid pose goes from base0 to
  // base1 = W * base0, so W = base1 * inverse(base0) — the rotation the cube
  // actually underwent on screen, and the only reading that does not depend on
  // what the cube looked like before the gesture.
  //
  // The pose delta (inverse(pose0) * pose1) is NOT that rotation: it is conjugated
  // by the grid pose, so it reads as a world axis only while the cube is
  // unrotated. It is reported too, as 'pose', because that is what a naive check
  // would measure — and the first run of this probe was fooled by exactly that: a
  // start pose carrying a 180° roll flipped the sign of the pitch row while the
  // cube's real step was unchanged.
  globalThis.__swipeProbe = {
    pose: (pose0, pose1) => axisAngle(mul(conj(pose0), pose1)),
    world: (base0, base1) => axisAngle(mul(base1, conj(base0))),
  };
  globalThis.__errs = [];
  addEventListener('error', (e) => globalThis.__errs.push(String(e.message) + ' @ ' + String(e.filename) + ':' + String(e.lineno)));
  addEventListener('unhandledrejection', (e) => globalThis.__errs.push('rejection: ' + String((e.reason && e.reason.stack) || e.reason)));
})()`

function findBrowser() {
  for (const path of EDGE_CANDIDATES) if (path && existsSync(path)) return path
  throw new Error(`no headless browser found; tried:\n  ${EDGE_CANDIDATES.join('\n  ')}`)
}

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

async function waitForExit(child, timeoutMs = 5000) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return true
  return new Promise((ok) => {
    const done = () => { clearTimeout(timeout); ok(true) }
    const timeout = setTimeout(() => { child.removeListener('exit', done); ok(false) }, timeoutMs)
    child.once('exit', done)
  })
}

async function closeBrowser(child, browserSocket, pageSocket, profile) {
  if (browserSocket?.readyState === WebSocket.OPEN) {
    await send(browserSocket, 9000, 'Browser.close').catch(() => {})
  }
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
  if (!exited) throw new Error(`probe browser did not exit; retained profile ${profile}`)

  const tempRoot = realpathSync(tmpdir())
  const actualProfile = realpathSync(profile)
  const suffix = relative(tempRoot, actualProfile)
  if (!suffix || isAbsolute(suffix) || suffix === '..' || suffix.startsWith(`..${sep}`)
    || !basename(actualProfile).startsWith('voxalblast-swipe-')) {
    throw new Error(`refusing to remove profile outside probe temp directory: ${actualProfile}`)
  }
  try {
    rmSync(actualProfile, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
  } catch (error) {
    if (!['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'].includes(error.code)) throw error
    console.warn(`WARN cleanup: retained locked temp profile ${actualProfile} (${error.code})`)
  }
}

// ---------------------------------------------------------------- dev server

async function appReachable() {
  try {
    const response = await fetch(APP_URL, { signal: AbortSignal.timeout(2500) })
    return response.ok
  } catch { return false }
}

async function ensureDevServer() {
  if (await appReachable()) return { started: false }
  console.log(`dev server not up on ${APP_PORT}; starting vite --port ${APP_PORT} --strictPort`)
  // Spawning the repo's own vite entrypoint with the running node avoids needing a
  // shell for npx.cmd (Node refuses .cmd without shell:true), and adds no dependency.
  const viteBin = join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js')
  if (!existsSync(viteBin)) throw new Error(`vite not installed at ${viteBin}; run npm install first`)
  const child = spawn(process.execPath, [viteBin, '--port', String(APP_PORT), '--strictPort'], {
    cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true,
  })
  child.on('error', () => {})
  child.unref() // left running on purpose: the caller keeps using 5173 afterwards
  for (let i = 0; i < 80; i += 1) {
    await sleep(500)
    if (await appReachable()) return { started: true, pid: child.pid }
  }
  throw new Error(`vite did not answer on ${APP_URL} within 40s`)
}

// ---------------------------------------------------------------- page helpers

function makeClient(ws) {
  let nextId = 100
  // A reload tears the execution context down under us; "no context" is expected,
  // not a failure, so it is retried rather than propagated.
  const evaluate = async (expression, { awaitPromise = false, settle = null } = {}) => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        const result = await send(ws, (nextId += 1), 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
        if (result.exceptionDetails) {
          throw new Error(`evaluate threw: ${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`)
        }
        return result.result?.value
      } catch (error) {
        if (/context|destroyed|Cannot find|timed out/i.test(error.message) && attempt < 39) {
          await sleep(250)
          continue
        }
        throw error
      }
    }
    throw new Error('evaluate never succeeded')
  }
  const frames = () => evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))', { awaitPromise: true })
  return { send: (method, params) => send(ws, (nextId += 1), method, params), evaluate, frames }
}

async function waitForCube(client) {
  for (let i = 0; i < 80; i += 1) {
    const ready = await client.evaluate('Boolean(globalThis.__voxalblast && globalThis.__swipeProbe)')
    if (ready) return true
    await sleep(250)
  }
  throw new Error('app never exposed globalThis.__voxalblast')
}

async function readBounds(client) {
  return JSON.parse(await client.evaluate('JSON.stringify(globalThis.__voxalblast.bounds())'))
}

async function readRotation(client) {
  return JSON.parse(await client.evaluate('JSON.stringify(globalThis.__voxalblast.rotation())'))
}

async function waitSettled(client) {
  await sleep(SETTLE_MS)
  for (let i = 0; i < Math.ceil(STILL_MS / 250); i += 1) {
    const still = await client.evaluate('Boolean(globalThis.__voxalblast.rotation().settling)')
    if (!still) return true
    await sleep(250)
  }
  console.warn('WARN settle animation still running after the wait; measuring anyway')
  return false
}

// Enlarges the viewport until both side bands are usable, rather than letting the
// LEFT/RIGHT start point fall inside the cube's span and become a pitch gesture.
async function fitBands(client, viewport) {
  const { height } = viewport
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const bounds = await readBounds(client)
    const left = bounds.minX
    const right = viewport.width - bounds.maxX
    if (Math.min(left, right) >= BAND_MIN_PX) return bounds
    const width = Math.ceil(viewport.width * 1.3)
    if (width > 2600) { console.warn(`WARN side bands stayed under ${BAND_MIN_PX}px; using ${viewport.width}x${height}`); return bounds }
    console.log(`side bands ${Math.round(left)}/${Math.round(right)}px too narrow; widening viewport to ${width}x${height}`)
    viewport.width = width
    await client.send('Emulation.setDeviceMetricsOverride', {
      width, height, screenWidth: width, screenHeight: height, deviceScaleFactor: 1, mobile: false,
    })
    await sleep(600)
    await client.frames()
  }
  return readBounds(client)
}

async function reloadAndSettle(client) {
  await client.send('Page.reload', { ignoreCache: false })
  await sleep(1200)
  await waitForCube(client)
  const click = await client.evaluate('(() => { const b = document.querySelector("#home-primary"); if (!b) return "no-button"; b.click(); return "clicked"; })()')
  if (click !== 'clicked') throw new Error(`home cover not dismissed: ${click}`)
  await sleep(2600)
  await client.frames()
  await waitSettled(client)
}

async function drag(client, from, to, steps = MOVE_STEPS) {
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 })
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps
    await client.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: from.x + (to.x - from.x) * t,
      y: from.y + (to.y - from.y) * t,
      button: 'left',
      buttons: 1,
    })
    await sleep(16)
  }
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 })
}

// A downward drag in a side band must read as a roll about Z; over the cube it is
// a pitch about X. The sense is read off the WORLD step, so it says what the player
// sees: +Z is counter-clockwise on screen, and the band the finger is in decides
// which of the two quarters counts as "following the finger".
function senseOf(step) {
  const named = [['x', Math.abs(step.axis[0])], ['y', Math.abs(step.axis[1])], ['z', Math.abs(step.axis[2])]].sort((a, b) => b[1] - a[1])
  if (named[0][1] < 0.5) return 'mixed'
  if (named[0][0] === 'z') {
    return step.axis[2] < 0
      ? 'clockwise on screen (the right edge travels down with the finger)'
      : 'counter-clockwise on screen (the left edge travels down with the finger)'
  }
  if (named[0][0] === 'x') return 'pitch about world X (the front face slides down)'
  return `about world ${named[0][0].toUpperCase()}`
}

// ---------------------------------------------------------------------- run

const browserPath = findBrowser()
const viewport = { ...START_VIEWPORT }
const dev = await ensureDevServer()
console.log(`browser  ${browserPath}`)
console.log(`target   ${APP_URL}  (dev server ${dev.started ? `started, pid ${dev.pid}` : 'already running'})\n`)

const profile = mkdtempSync(join(tmpdir(), 'voxalblast-swipe-'))
const child = spawn(browserPath, [
  '--headless=new', '--disable-gpu', '--disable-breakpad', '--hide-scrollbars',
  '--no-first-run', '--no-default-browser-check', '--force-device-scale-factor=1',
  '--run-all-compositor-stages-before-draw',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  `--window-size=${viewport.width},${viewport.height}`, 'about:blank',
], { stdio: 'ignore', windowsHide: true })

let browserSocket = null
let pageSocket = null
let thrown = null
const reports = []
const failures = []

try {
  let browserInfo = null
  for (let i = 0; i < 100; i += 1) {
    try {
      const port = Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0])
      browserInfo = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
      break
    } catch { await sleep(250) }
  }
  if (!browserInfo) throw new Error('devtools never came up')
  browserSocket = await connect(browserInfo.webSocketDebuggerUrl)
  const target = await (await fetch(`http://127.0.0.1:${browserInfo.webSocketDebuggerUrl.replace(/^ws:/, 'http:').replace(/\/devtools\/browser\/.*$/, '')}/json/new?about:blank`, { method: 'PUT' }).catch(() => null))?.json?.() ?? null

  // The /json/new helper above is best-effort; fall back to the browser-level list.
  let pageTarget = target
  if (!pageTarget?.webSocketDebuggerUrl) {
    const port = Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0])
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    pageTarget = list.find((entry) => entry.type === 'page')
  }
  pageSocket = await connect(pageTarget.webSocketDebuggerUrl)

  const client = makeClient(pageSocket)
  await client.send('Page.enable')
  await client.send('Runtime.enable')
  await client.send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE_SETUP })
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: viewport.width, height: viewport.height,
    screenWidth: viewport.width, screenHeight: viewport.height, deviceScaleFactor: 1, mobile: false,
  })
  await client.send('Page.navigate', { url: APP_URL })
  await waitForCube(client)
  await sleep(2600)
  await client.frames()

  const bounds = await fitBands(client, viewport)
  const cubeW = bounds.maxX - bounds.minX
  const cubeH = bounds.maxY - bounds.minY
  const rawCentreY = (bounds.minY + bounds.maxY) / 2
  const startY = Math.min(Math.max(rawCentreY, 4), viewport.height - 4)
  console.log(`viewport ${viewport.width}x${viewport.height}  cube box x[${bounds.minX.toFixed(1)},${bounds.maxX.toFixed(1)}] y[${bounds.minY.toFixed(1)},${bounds.maxY.toFixed(1)}] (${cubeW.toFixed(0)}x${cubeH.toFixed(0)}px)`)
  console.log(`left band ${(bounds.minX).toFixed(0)}px  right band ${(viewport.width - bounds.maxX).toFixed(0)}px\n`)

  // What a downward drag has to produce, per region, in world space. `want` is the
  // sign of the world axis: +Z rolls counter-clockwise (the left band's edge travels
  // down with the finger), -Z rolls clockwise (the right band's), +X pitches so the
  // front face slides down. These are the assertions the probe gates on.
  const GESTURES = [
    { key: 'left', label: 'LEFT band ', axis: 'roll', want: { component: 'z', sign: 1 } },
    { key: 'right', label: 'RIGHT band', axis: 'roll', want: { component: 'z', sign: -1 } },
    { key: 'pitch', label: 'over cube ', axis: 'pitch', want: { component: 'x', sign: 1 } },
  ]

  for (const gesture of GESTURES) {
    await reloadAndSettle(client)
    const fresh = await readBounds(client)
    // The band fit is re-checked per gesture: a reload re-lays-out the cube, so the
    // start point is derived from the FRESH box, never from a stale one.
    const startX = gesture.key === 'left' ? fresh.minX - BAND_OFFSET_PX
      : gesture.key === 'right' ? fresh.maxX + BAND_OFFSET_PX
        : (fresh.minX + fresh.maxX) / 2
    const y = Math.min(Math.max((fresh.minY + fresh.maxY) / 2, 4), viewport.height - 4)
    const insideSpan = startX >= fresh.minX && startX <= fresh.maxX
    const hitTarget = await client.evaluate(`(() => { const el = document.elementFromPoint(${startX}, ${y}); return el ? (el.id || el.className || el.tagName) : null })()`)
    const before = await readRotation(client)

    await drag(client, { x: startX, y }, { x: startX, y: y + DRAG_DOWN_PX })
    const settledCleanly = await waitSettled(client)
    const after = await readRotation(client)

    const worldStep = JSON.parse(await client.evaluate(
      `JSON.stringify(globalThis.__swipeProbe.world(${JSON.stringify(before.base)}, ${JSON.stringify(after.base)}))`))
    const poseStep = JSON.parse(await client.evaluate(
      `JSON.stringify(globalThis.__swipeProbe.pose(${JSON.stringify(before.pose)}, ${JSON.stringify(after.pose)}))`))

    const component = { x: 0, y: 1, z: 2 }[gesture.want.component]
    const got = worldStep.axis[component]
    const onAxis = Math.abs(got) > 0.9
    const quarter = Math.abs(worldStep.angleDeg - 90) < 5
    const rightWay = Math.sign(got) === gesture.want.sign
    const ok = onAxis && quarter && rightWay && settledCleanly
    const expected = `world ${gesture.want.sign > 0 ? '+' : '-'}${gesture.want.component.toUpperCase()} (${gesture.axis})`
    if (!ok) {
      failures.push(`${gesture.key}: expected ${expected}, got axis=${worldStep.axisText} angle=${worldStep.angleDeg}deg`
        + `${insideSpan && gesture.key !== 'pitch' ? ' and the start point fell inside the cube span' : ''}`
        + `${settledCleanly ? '' : ' (the settle animation never finished)'}`)
    }

    reports.push({
      gesture: gesture.key,
      label: gesture.label,
      start: { x: Number(startX.toFixed(1)), y: Number(y.toFixed(1)) },
      bandOffsetPx: Number((gesture.key === 'left' ? fresh.minX - startX : startX - fresh.maxX).toFixed(1)),
      insideCubeSpan: insideSpan,
      hitTarget,
      expected,
      ok,
      world: { axis: worldStep.axis, angleDeg: worldStep.angleDeg, sense: senseOf(worldStep) },
      pose: { axis: poseStep.axis, angleDeg: poseStep.angleDeg },
      front: { from: before.front, to: after.front },
      settled: settledCleanly,
    })

    const warn = insideSpan && gesture.key !== 'pitch' ? '  <-- WARN start point fell inside the cube span' : ''
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${gesture.label} down 140px  world axis=${worldStep.axisText} ${worldStep.angleDeg.toFixed(1)}deg`
      + `  ${senseOf(worldStep)}  (start x=${startX.toFixed(0)}, y=${y.toFixed(0)}, want ${expected})${warn}`)
  }

  const errors = await client.evaluate('JSON.stringify(globalThis.__errs || [])')
  const parsed = JSON.parse(errors)
  if (parsed.length) console.warn(`WARN page errors: ${parsed.join(' | ')}`)
} catch (error) {
  thrown = error
} finally {
  try {
    await closeBrowser(child, browserSocket, pageSocket, profile)
  } catch (error) {
    if (!thrown) thrown = error
    else console.warn(`WARN cleanup: ${error.message}`)
  }
}

console.log(`\n${JSON.stringify({ viewport, devServer: `http://127.0.0.1:${APP_PORT}/`, gestures: reports }, null, 2)}`)

if (thrown) throw thrown
if (failures.length) {
  console.log(`\nFAIL:\n  ${failures.join('\n  ')}`)
  process.exitCode = 1
} else {
  console.log('\nall three gestures turn the cube the way the finger goes')
}

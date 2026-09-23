// Measures the two things the v0.8.6 rotation-interaction pass is graded on, in a
// real headless browser:
//
//   1. 停稳构图 — how the cube's screen silhouette is divided between the faces the
//      player can see, on all 24 face-aligned orientations (six faces × four
//      in-plane directions). The target is a main-face share of 82–88%, no other
//      face above 11%, and the same composition and in-plane skew on every one.
//   2. 旋转轨迹 — where the rotation axis points ON SCREEN while a gesture is in
//      flight. A turn that "looks crooked" is a turn whose pose increment is about
//      a screen axis that is not level/plumb, so the probe samples the increment
//      at several drag distances and reports its screen direction. This is also what
//      catches a rotation that STOPS answering the finger: a zero increment has no
//      axis at all.
//   3. 停靠 / 微调 / 换面 (v0.8.24) — the three rules of the fine-tune layer: the zone
//      is symmetric about the dock in finger travel as well as in degrees, a release
//      inside it keeps exactly the pose on screen, a drag past the edge converges onto
//      it, and a face costs the same drag from every bearing. The numbers come from
//      `rotation().zone` / `.resistance`, i.e. from the shipped model rather than from
//      a second copy of the arithmetic.
//
//   node tools/cube-framing-probe.mjs [--json] [--quick] [--debug] [--viewport=WxH]
//
// `--debug` prints every drag the bearing section makes (from/to bearing, raw offset,
// and the held sample), which is how a routing problem is told apart from a feel one.
//
// `npm run probe:framing`.
//
// It needs a dev server on 5173 and will start one, leaving it running like
// tools/swipe-probe.mjs does. Browser plumbing is the same proven shape (global
// WebSocket + CDP, `--headless=new`, `--remote-debugging-port=0`, fresh temp
// profile, Browser.close + profile removal). No puppeteer, no new dependency.
//
// Reading the numbers.
//   - `mainShare` is exact projected polygon area, not a cosα·cosβ estimate: the
//     three visible faces of a convex body tile the silhouette, so their areas sum
//     to the silhouette and the share is the real on-screen composition.
//   - `skewDeg` is how far a face's own +u edge runs from screen-right. It should
//     be the same value on all 24 orientations — that is what "the presentation
//     tilt is fixed in screen space" means, and it is what stops a face from
//     arriving crooked.
//   - `screenDeg` is the direction of the gesture's rotation axis on screen:
//     0 = the axis lies horizontally (a pitch, the front face slides up/down),
//     ±90 = the axis is vertical (a yaw, the cube turns left/right), and a Z spin
//     has `|alongView| ≈ 1` (its axis points at the camera, so it has no screen
//     direction — it is an in-plane spin by construction).
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const APP_URL = 'http://127.0.0.1:5173/'
const APP_PORT = 5173
// Composition targets — see the block at TARGET below for why they are what they are.
const SETTLE_MS = 420 // longer than ROTATE_STYLE.snapDuration (220ms)
const JSON_ONLY = process.argv.includes('--json')
// `--quick` measures the resting composition only (one orientation) so a tilt value
// can be swept in a few seconds instead of a full 24-orientation walk. It is a
// tuning aid: the per-orientation consistency checks are skipped under it.
const QUICK = process.argv.includes('--quick')
const DEBUG = process.argv.includes('--debug')
// The composition is NOT viewport-independent: `refreshCameraProjection()` solves the
// camera distance from the canvas aspect, and the distance decides how much of a side
// face the perspective leaves visible at a given camera angle. A desktop-correct
// framing can therefore collapse into a flat plate on a phone. Default desktop;
// `--viewport=390x737` (CSS pixels, as the browser reports them) checks a real one.
const VIEWPORT = (() => {
  const arg = process.argv.find((value) => value.startsWith('--viewport='))
  if (!arg) return { width: 1280, height: 900 }
  const match = /^--viewport=(\d+)x(\d+)$/.exec(arg)
  if (!match) throw new Error(`--viewport expects WxH, got ${arg}`)
  return { width: Number(match[1]), height: Number(match[2]) }
})()

// 03 §2 / docs/Planning targets. Cited here so the probe fails against the
// DOCUMENT and not against whatever the code happens to do today.
// The targets the resting composition is graded on. Cited here so the probe fails
// against the DOCUMENTED intent, not against whatever the code happens to do today.
//
// History, so these numbers are not "adjusted to whatever passes": the v0.8.6 first
// cut chased 82–88% (82.8% measured) and the producer rejected it on sight — "整个
// 就是一格一格的，然后视觉上还比较歪". A near-frontal face makes every cell a
// near-square, which is exactly a flat grid; and the cube-tilt that bought the extra
// share leaned the board −4.8° on screen. The targets now encode the corrected
// intent: three faces visible and upright, front face clearly the subject.
const TARGET = {
  mainShareMin: 0.66,
  mainShareMax: 0.78,
  // No non-main face may collapse into a sliver. This is the one that catches the
  // flat-plate failure mode directly: with a close camera, a small tilt can leave a
  // side face invisible entirely (measured 100% / 0 / 0 for a 6.6° cube tilt).
  minOtherShare: 0.06,
  maxUprightDeg: 0.5, // the cube's vertical edges stay plumb — "视觉上还比较歪" is this number
  maxOffAxisSpreadDeg: 0.05, // the presented face sits the same amount off the camera axis on all 24
  // The presented face's in-plane roll (perspective-free) is not exactly constant
  // and cannot be while the camera is three-quarter: the cube's grid poses are signed
  // permutations of the world axes, so a face arrives with its grid aligned to
  // whichever world axis, and those project at different angles on screen. The bound
  // is therefore the camera's own spread, not zero — v0.8.5's camera measured ~10.6°
  // for the same quantity, and this camera's is ~7.7°. It would go to ~0 only by
  // making the camera frontal, which is the composition that was rejected.
  maxTwistSpreadDeg: 9.0,
  maxTiltGoneDeg: 24, // the presentation tilt is fully out well before the ≈30° commit threshold
  // The gesture axes are world axes and the camera is tilted, so a vertical drag is
  // NOT exactly plumb on screen — that skew is the camera's and is the price of the
  // three-quarter look. What is asserted instead is that the fade adds nothing: the
  // axis the bare (tilt-free) part of the gesture turns about must be STABLE.
  maxAxisDriftDeg: 1.0,
  maxAxisOffsetDeg: 12.0, // ...and the camera's own skew must stay bounded
  // A roll is the one axis a three-quarter camera cannot show as an in-plane spin:
  // its axis has to point at the camera for that, and the camera is pitched ~18°, so
  // the world Z axis is ~30° off the view direction by construction. Graded against
  // its own (looser) budget; its CONSISTENCY is still graded at 1° like the others.
  maxRollAxisOffsetDeg: 15.0,
}

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ------------------------------------------------------------------ orientation BFS
// The six key bindings are quarter turns about the three world axes, and the key
// mapping is the swipe it equals (rendering/keyboard.js). `cubeBase.premultiply()`
// means base_new = step * base_old, so replaying a key sequence from the identity
// reproduces the pose exactly and the probe can reach all 24 orientations without
// reading anything but the public rotation() hook.
const ROTATE_STYLE = (await import('../src/rendering/config.js')).ROTATE_STYLE
const STEP_KEYS = [
  { key: 'w', axis: 0, steps: -1 * ROTATE_STYLE.pitchDirection, inverse: 's' },
  { key: 's', axis: 0, steps: 1 * ROTATE_STYLE.pitchDirection, inverse: 'w' },
  { key: 'a', axis: 1, steps: -1 * ROTATE_STYLE.yawDirection, inverse: 'd' },
  { key: 'd', axis: 1, steps: 1 * ROTATE_STYLE.yawDirection, inverse: 'a' },
  { key: 'q', axis: 2, steps: -1 * ROTATE_STYLE.rollDirection, inverse: 'e' },
  { key: 'e', axis: 2, steps: 1 * ROTATE_STYLE.rollDirection, inverse: 'q' },
]

// q and -q are the same rotation, and a path-dependent sign is exactly the trap
// that would make a 24-element group look like 48. Every comparison goes through
// a canonical sign.
function canonical(q) {
  for (const value of q) {
    if (Math.abs(value) > 1e-6) return value > 0 ? q : qNeg(q)
  }
  return q
}
function qMul(a, b) {
  return canonical([
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ])
}
function qNeg(q) {
  return [-q[0], -q[1], -q[2], -q[3]]
}
function axisQuarter(axis, steps) {
  const n = ((steps % 4) + 4) % 4
  const half = (n * Math.PI) / 4 // half-angle
  const s = Math.sin(half)
  const q = [0, 0, 0, Math.cos(half)]
  q[axis] = s
  return canonical(q)
}
const qKey = (q) => canonical(q).map((value) => (Math.abs(value) < 1e-6 ? 0 : value).toFixed(3)).join(',')

// BFS from the identity over the six quarter turns => the 24 face-aligned poses,
// each with the key sequence that reaches it.
function orientationPaths() {
  const identity = [0, 0, 0, 1]
  const seen = new Map([[qKey(identity), { quat: identity, path: [] }]])
  const queue = [identity]
  while (queue.length) {
    const current = queue.shift()
    const node = seen.get(qKey(current))
    for (const step of STEP_KEYS) {
      const next = qMul(axisQuarter(step.axis, step.steps), current)
      const key = qKey(next)
      if (seen.has(key)) continue
      seen.set(key, { quat: next, path: [...node.path, step], previous: qKey(current) })
      queue.push(next)
    }
  }
  if (seen.size !== 24) throw new Error(`orientation BFS found ${seen.size} poses, expected 24`)
  return [...seen.values()]
}

const ORIENTATIONS = orientationPaths()

// ------------------------------------------------------------------ browser plumbing
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
    || !basename(actualProfile).startsWith('voxalblast-framing-')) {
    throw new Error(`refusing to remove profile outside probe temp directory: ${actualProfile}`)
  }
  try {
    rmSync(actualProfile, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
  } catch (error) {
    if (!['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'].includes(error.code)) throw error
    console.warn(`WARN cleanup: retained locked temp profile ${actualProfile} (${error.code})`)
  }
}

async function appReachable() {
  try {
    const response = await fetch(APP_URL, { signal: AbortSignal.timeout(2500) })
    return response.ok
  } catch { return false }
}

async function ensureDevServer() {
  if (await appReachable()) return { started: false }
  const viteBin = join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js')
  if (!existsSync(viteBin)) throw new Error(`vite not installed at ${viteBin}; run npm install first`)
  const child = spawn(process.execPath, [viteBin, '--port', String(APP_PORT), '--strictPort'], {
    cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true,
  })
  child.on('error', () => {})
  child.unref()
  for (let i = 0; i < 80; i += 1) {
    await sleep(500)
    if (await appReachable()) return { started: true, pid: child.pid }
  }
  throw new Error(`vite did not answer on ${APP_URL} within 40s`)
}

function makeClient(ws) {
  let nextId = 100
  const evaluate = async (expression, { awaitPromise = false } = {}) => {
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
    const ready = await client.evaluate('Boolean(globalThis.__voxalblast && globalThis.__voxalblast.faces && globalThis.__voxalblast.poseAxisScreen)')
    if (ready) return true
    await sleep(250)
  }
  throw new Error('app never exposed __voxalblast.faces()/poseAxisScreen() — is this v0.8.6 or later?')
}

const readJson = async (client, expression) => JSON.parse(await client.evaluate(`JSON.stringify(${expression})`))

// A straight pointer drag from A to B, in `steps` moves. Same shape as
// tools/swipe-probe.mjs's: the axis is claimed a few px in, which is what the
// gesture partition expects.
async function drag(client, from, to, steps = 8) {
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

async function pressKeys(client, keys) {  for (const key of keys) {
    const code = `Key${key.toUpperCase()}`
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: key.toUpperCase(), code, windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0) })
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: key.toUpperCase(), code, windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0) })
    await sleep(30)
  }
  await sleep(SETTLE_MS)
  await client.frames()
}

function foldSkew(deg) {
  const value = ((deg % 90) + 90) % 90
  return value > 45 ? value - 90 : value
}

function foldScreenDeg(deg) {
  let value = ((deg + 90) % 180 + 180) % 180 - 90
  if (value === -90) value = 90
  return value
}

// What "on its screen axis" means per gesture: a yaw turns about a vertical screen
// axis (±90°), a pitch about a horizontal one (0°). A roll's axis points at the
// camera, so it has no screen direction at all and the only honest reading is that
// the axis is along the view (`alongView` ±1). Because the camera is deliberately
// three-quarter, the world X axis is NOT exactly horizontal on screen — the reading
// is compared against the camera's own skew, not against 0/90.
function screenAxisError(axis, entry) {
  if (axis === 'roll') return Math.abs(1 - Math.abs(entry.alongView)) * 90
  return Math.abs(axis === 'yaw' ? Math.abs(entry.screenDeg) - 90 : entry.screenDeg)
}

// ------------------------------------------------------------------ run
const browserPath = findBrowser()
const dev = await ensureDevServer()
const profile = mkdtempSync(join(tmpdir(), 'voxalblast-framing-'))
const child = spawn(browserPath, [
  '--headless=new', '--disable-gpu', '--disable-breakpad', '--hide-scrollbars',
  '--no-first-run', '--no-default-browser-check', '--force-device-scale-factor=1',
  '--run-all-compositor-stages-before-draw',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  `--window-size=${VIEWPORT.width},${VIEWPORT.height}`, 'about:blank',
], { stdio: 'ignore', windowsHide: true })

let browserSocket = null
let pageSocket = null
let thrown = null
const failures = []
const report = { viewport: VIEWPORT, targets: TARGET }

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
  const port = Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0])
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const pageTarget = list.find((entry) => entry.type === 'page')
  pageSocket = await connect(pageTarget.webSocketDebuggerUrl)

  const client = makeClient(pageSocket)
  await client.send('Page.enable')
  await client.send('Runtime.enable')
  await client.evaluate('1')
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: VIEWPORT.width, height: VIEWPORT.height,
    screenWidth: VIEWPORT.width, screenHeight: VIEWPORT.height, deviceScaleFactor: 1, mobile: false,
  })
  await client.send('Page.navigate', { url: APP_URL })
  await waitForCube(client)
  await sleep(2600)
  await client.frames()
  // v0.8.22: the game boots straight into a run, so there is no #home-primary to click —
  // just wait for the opening creation wave, which holds the input lock while it plays.
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await client.evaluate('JSON.stringify(globalThis.__voxalblast.intro?.().active ?? false)') === 'false') break
    await sleep(200)
  }
  await sleep(600)
  await client.frames()

  // ---------------------------------------------------------------- 1. framing
  const bounds = await readJson(client, 'globalThis.__voxalblast.bounds()')
  const spanX = bounds.maxX - bounds.minX
  const spanY = bounds.maxY - bounds.minY
  report.ruler = {
    cubeBox: { width: Number(spanX.toFixed(1)), height: Number(spanY.toFixed(1)), minX: Number(bounds.minX.toFixed(1)), maxX: Number(bounds.maxX.toFixed(1)) },
    // swipeAngle: angle = dx / span.x * π, and one face is π/2, so a face costs
    // stepThreshold/π of the span on either axis.
    pxPerFaceYaw: Number((spanX / 2).toFixed(1)),
    pxPerFacePitch: Number((spanY / 2).toFixed(1)),
    pxToStepYaw: Number((ROTATE_STYLE.stepThreshold / Math.PI * spanX).toFixed(1)),
    pxToStepPitch: Number((ROTATE_STYLE.stepThreshold / Math.PI * spanY).toFixed(1)),
  }

  const samples = []
  for (const orientation of (QUICK ? ORIENTATIONS.filter((entry) => entry.path.length === 0) : ORIENTATIONS)) {
    await pressKeys(client, orientation.path.map((step) => step.key))
    const rotation = await readJson(client, 'globalThis.__voxalblast.rotation()')
    const faces = await readJson(client, 'globalThis.__voxalblast.faces()')
    samples.push({
      path: orientation.path.map((step) => step.key).join(''),
      base: rotation.base,
      front: faces.front,
      mainFaceMatches: faces.mainFaceMatches,
      mainShare: faces.mainShare,
      others: faces.others,
      mainSkewDeg: faces.visible[0]?.skewDeg ?? null,
      mainTwistDeg: faces.visible[0]?.twistDeg ?? null,
      mainOffAxisDeg: faces.visible[0]?.offAxisDeg ?? null,
      sideFacesVisible: faces.visible.length > 1,
      uprightDeg: faces.uprightDeg,
      camera: faces.camera,
      presentation: rotation.presentation,
    })
    // Return to the identity so the next path starts where it thinks it does.
    await pressKeys(client, orientation.path.slice().reverse().map((step) => step.inverse))
  }

  const shares = samples.map((sample) => sample.mainShare)
  const skews = samples.map((sample) => sample.mainSkewDeg)
  const minOtherMax = Math.min(...samples.map((sample) => sample.others.length === 2 ? Math.min(...sample.others.map((other) => other.share)) : 0))
  const otherMax = Math.max(...samples.flatMap((sample) => sample.others.map((other) => other.share)))
  const distinctPoses = new Set(samples.map((sample) => qKey(sample.base))).size
  report.framing = {
    orientations: samples.length,
    distinctPoses,
    mainShare: { min: Math.min(...shares), max: Math.max(...shares) },
    otherMax,
    otherMin: minOtherMax,
    uprightDeg: {
      min: Math.min(...samples.map((sample) => sample.uprightDeg)),
      max: Math.max(...samples.map((sample) => sample.uprightDeg)),
    },
    offAxisDeg: {
      min: Math.min(...samples.map((s) => s.mainOffAxisDeg)),
      max: Math.max(...samples.map((s) => s.mainOffAxisDeg)),
    },
    // `skewDeg` is the projected edge angle, folded a quarter turn at a time. It
    // carries perspective convergence, so it is reported for the record rather
    // than graded; `twistDeg` is the perspective-free one and IS graded.
    skewDeg: { values: [...new Set(skews.map((value) => Number(foldSkew(value).toFixed(2))))].sort((a, b) => a - b) },
    twistDeg: {
      min: Math.min(...samples.map((s) => s.mainTwistDeg)),
      max: Math.max(...samples.map((s) => s.mainTwistDeg)),
      spread: Math.max(...samples.map((s) => s.mainTwistDeg)) - Math.min(...samples.map((s) => s.mainTwistDeg)),
    },
    perOrientation: samples.map((sample) => ({
      path: sample.path, front: sample.front, mainShare: sample.mainShare,
      others: sample.others.map((other) => `${other.face} ${(other.share * 100).toFixed(1)}%`).join(' / '),
      skewDeg: Number(foldSkew(sample.mainSkewDeg).toFixed(2)),
      twistDeg: sample.mainTwistDeg,
      offAxisDeg: sample.mainOffAxisDeg,
      sideFacesVisible: sample.sideFacesVisible,
    })),
  }
  const skewsFolded = report.framing.perOrientation.map((row) => row.skewDeg)
  report.framing.skewRange = {
    min: Math.min(...skewsFolded), max: Math.max(...skewsFolded),
    spread: Math.max(...skewsFolded) - Math.min(...skewsFolded),
  }
  report.framing.offAxisSpread = report.framing.offAxisDeg.max - report.framing.offAxisDeg.min

  report.framing.camera = samples[0].camera
  if (QUICK) console.warn('WARN --quick: only the resting orientation was sampled')
  if (!QUICK && distinctPoses !== 24) failures.push(`framing: reached ${distinctPoses} distinct orientations, expected 24`)
  if (!samples.every((sample) => sample.mainFaceMatches)) failures.push('framing: the largest visible face is not the detected front face')
  if (Math.min(...shares) < TARGET.mainShareMin || Math.max(...shares) > TARGET.mainShareMax) {
    failures.push(`framing: main share ${(Math.min(...shares) * 100).toFixed(1)}–${(Math.max(...shares) * 100).toFixed(1)}% outside ${TARGET.mainShareMin * 100}–${TARGET.mainShareMax * 100}%`)
  }
  if (otherMax > 1 - TARGET.mainShareMin) failures.push(`framing: a non-main face reaches ${(otherMax * 100).toFixed(1)}%`)
  if (minOtherMax < TARGET.minOtherShare) {
    failures.push(`framing: a non-main face is down to ${(minOtherMax * 100).toFixed(1)}% — the cube is flattening into a plate (min ${TARGET.minOtherShare * 100}%)`)
  }
  const uprightAbs = Math.max(...samples.map((sample) => Math.abs(sample.uprightDeg)))
  if (uprightAbs > TARGET.maxUprightDeg) {
    failures.push(`framing: the cube leans ${uprightAbs.toFixed(2)}° on screen (max ${TARGET.maxUprightDeg}°) — vertical edges must stay plumb`)
  }
  // The strict one: the presented face sits the same distance off the camera axis
  // on every orientation. A tilt applied in the cube's own frame (rather than in
  // screen space) fails this immediately — some face always comes out flatter.
  if (report.framing.offAxisSpread > TARGET.maxOffAxisSpreadDeg) {
    failures.push(`framing: main face off-axis varies by ${report.framing.offAxisSpread.toFixed(3)}° across orientations`)
  }
  if (report.framing.twistDeg.spread > TARGET.maxTwistSpreadDeg) {
    failures.push(`framing: presented face twist varies by ${report.framing.twistDeg.spread.toFixed(2)}° across orientations (a cube-space tilt does exactly this)`)
  }
  // A side face that is not visible at all is the failure mode this whole pass
  // exists to prevent: the silhouette is then the bare front face and the cube
  // reads as a flat 5×5 plate.
  if (samples.some((sample) => !sample.sideFacesVisible)) {
    failures.push('framing: at some orientation no non-main face is visible — the cube renders as a flat plate')
  }

  // ---------------------------------------------------------------- 2. trajectory
  // A fresh pose, then one gesture per axis sampled at several travel distances.
  await pressKeys(client, [])
  const freshBounds = await readJson(client, 'globalThis.__voxalblast.bounds()')
  const centreX = (freshBounds.minX + freshBounds.maxX) / 2
  const centreY = (freshBounds.minY + freshBounds.maxY) / 2
  const padding = Math.min(centreX - freshBounds.minX, freshBounds.minX)
  const sideX = padding >= 45 ? freshBounds.minX - 40 : null

  const GESTURES = [
    { name: 'yaw', want: 'yaw', from: { x: centreX, y: centreY }, step: (distance) => ({ x: distance, y: 0 }) },
    { name: 'pitch', want: 'pitch', from: { x: centreX, y: centreY }, step: (distance) => ({ x: 0, y: distance }) },
    { name: 'roll-left', want: 'roll', from: sideX === null ? null : { x: sideX, y: centreY }, step: (distance) => ({ x: 0, y: distance }) },
  ]

  const trajectories = []
  for (const gesture of GESTURES) {
    if (!gesture.from) { trajectories.push({ name: gesture.name, skipped: 'no usable side band at this viewport' }); continue }
    // The distance that pulls exactly one face, from the documented ruler.
    const span = gesture.want === 'yaw' ? spanX : spanY
    const samples_ = [0.06, 0.08, 0.12, 0.22, 0.35, 0.48].map((fraction) => fraction * span)
    const trace = []
    await pressKeys(client, []) // settle back to the identity
    await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: gesture.from.x, y: gesture.from.y, button: 'left', buttons: 1, clickCount: 1 })
    let previous = await readJson(client, 'globalThis.__voxalblast.rotation()')
    for (const distance of samples_) {
      const target = gesture.step(distance)
      await client.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: gesture.from.x + target.x, y: gesture.from.y + target.y, button: 'left', buttons: 1,
      })
      await client.frames()
      const current = await readJson(client, 'globalThis.__voxalblast.rotation()')
      const delta = await readJson(client,
        `globalThis.__voxalblast.poseAxisScreen(${JSON.stringify(previous.pose)}, ${JSON.stringify(current.pose)})`)
      trace.push({
        dragPx: Number(distance.toFixed(1)),
        liveAngleDeg: current.live ? Number((current.live.angle * 180 / Math.PI).toFixed(2)) : null,
        bearingDeg: current.bearingDeg.yaw,
        deltaAngleDeg: delta.angleDeg,
        screenDeg: foldScreenDeg(delta.screenDeg),
        alongView: delta.alongView,
        worldAxis: delta.axis.map((value) => Number(value.toFixed(3))),
      })
      previous = current
    }
    await client.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: gesture.from.x + gesture.step(samples_[samples_.length - 1]).x,
      y: gesture.from.y + gesture.step(samples_[samples_.length - 1]).y,
      button: 'left', buttons: 0, clickCount: 1,
    })
    await sleep(SETTLE_MS)
    await client.frames()

    // The gesture's own axis, sampled against what the camera does to that world
    // axis. Since the bearing is no longer faded out, every sample is a genuine
    // increment of the same single-axis rotation and the reading has to be constant
    // — that constancy is what "the cube turns on one clean axis" means here.
    const axisOffsetDeg = trace.length > 2 ? Math.max(...trace.slice(2).map((entry) => screenAxisError(gesture.want, entry))) : null
    const readings = trace.slice(2).map((entry) => (gesture.want === 'roll' ? entry.alongView * 90 : entry.screenDeg))
    const axisDriftDeg = readings.length > 1 ? Math.max(...readings) - Math.min(...readings) : 0
    const budget = gesture.want === 'roll' ? TARGET.maxRollAxisOffsetDeg : TARGET.maxAxisOffsetDeg
    if (axisOffsetDeg !== null && axisOffsetDeg > budget) {
      failures.push(`trajectory ${gesture.name}: rotation axis is ${axisOffsetDeg.toFixed(2)}° off its screen axis (budget ${budget}°)`)
    }
    if (axisDriftDeg > TARGET.maxAxisDriftDeg) {
      failures.push(`trajectory ${gesture.name}: the gesture's axis drifts ${axisDriftDeg.toFixed(2)}° mid-drag`)
    }
    trajectories.push({
      name: gesture.name,
      axis: gesture.want,
      pxToStep: Number((ROTATE_STYLE.stepThreshold / Math.PI * span).toFixed(1)),
      axisOffsetDeg: axisOffsetDeg === null ? null : Number(axisOffsetDeg.toFixed(2)),
      axisDriftDeg: Number(axisDriftDeg.toFixed(2)),
      trace,
    })
  }
  report.trajectory = trajectories

  // ------------------------------------------------------------- 3. the bearing
  // v0.8.24 replaced the asymmetric fence with three rules, and each is asserted here
  // against what the SHIPPED model reports (`rotation().zone` / `.resistance`) rather
  // than against a copy of the arithmetic — a probe that re-derives the model it is
  // checking can pass on a copy that has drifted:
  //   1. the fine-tune zone is SYMMETRIC about the dock, in OPERATION (finger travel)
  //      as well as in degrees, so the same drag either way buys the same offset;
  //   2. inside the zone a release KEEPS the pose the player is looking at; the cube
  //      resists as the edge arrives, and a drag that ends past the edge converges
  //      onto it — never the one-frame truncation of v0.8.23 and earlier;
  //   3. the FACE is the gesture's own call, so it costs the same drag from every
  //      bearing, and the bearing the player dialled survives the turn.
  const tuning = []
  const readRotation = () => readJson(client, 'globalThis.__voxalblast.rotation()')
  const readBearing = async () => {
    const rotation = await readRotation()
    return {
      yawDeg: rotation.bearingDeg.yaw,
      pitchDeg: rotation.bearingDeg.pitch,
      rawYawDeg: rotation.bearingRawDeg.yaw,
      settling: rotation.settling,
      base: rotation.base,
    }
  }
  const dragBy = async (axis, px, steps = 12) => {
    const from = { x: centreX, y: centreY }
    const to = axis === 'pitch' ? { x: from.x, y: from.y + px } : { x: from.x + px, y: from.y }
    const before = await readBearing()
    await drag(client, from, to, steps)
    await sleep(SETTLE_MS)
    await client.frames()
    const after = await readBearing()
    if (DEBUG) console.log(`    [drag ${axis} ${px.toFixed(2)}px from ${before.yawDeg}/${before.pitchDeg} raw ${before.rawYawDeg}] -> ${after.yawDeg}/${after.pitchDeg}`)
    return after
  }
  // The app's drag ruler is the CUBE'S OWN SILHOUETTE, sampled where the gesture
  // commits — and that silhouette changes with the bearing (a more frontal cube is a
  // narrower box: measured, 452.7px at the dock against ~420px at the 7° bearing, so a
  // park aimed with the dock's ruler came out 8% short). Every drag converted from
  // degrees therefore re-measures the ruler first, at the pose the gesture will claim
  // its axis in.
  let rulerYaw = spanX
  let rulerPitch = spanY
  const measureRuler = async () => {
    const bounds = await readJson(client, 'globalThis.__voxalblast.bounds()')
    rulerYaw = Math.max(bounds.maxX - bounds.minX, 120)
    rulerPitch = Math.max(bounds.maxY - bounds.minY, 120)
  }
  const dragByDeg = async (axis, deg, steps = 12) => {
    await measureRuler()
    return dragBy(axis, (axis === 'pitch' ? rulerPitch : rulerYaw) * deg / 180, steps)
  }
  // A drag that is HELD: press, walk out to the far end, sample the pose while the
  // finger is still down, then release. The resistance is a property of the DRAG, so
  // this is the only way to see it — a release only shows its tail.
  const dragHoldDeg = async (axis, deg, steps = 12) => {
    await measureRuler()
    const px = (axis === 'pitch' ? rulerPitch : rulerYaw) * deg / 180
    const from = { x: centreX, y: centreY }
    const to = axis === 'pitch' ? { x: from.x, y: from.y + px } : { x: from.x + px, y: from.y }
    await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 })
    for (let i = 1; i <= steps; i += 1) {
      const t = i / steps
      await client.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t, button: 'left', buttons: 1,
      })
      await sleep(16)
    }
    const held = await readRotation()
    if (DEBUG) console.log(`    [hold ${axis} ${px.toFixed(2)}px] ruler ${rulerYaw.toFixed(1)} live ${JSON.stringify(held.live)}`)
    await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 })
    await sleep(SETTLE_MS)
    await client.frames()
    const settled = await readBearing()
    if (DEBUG) console.log(`    [hold ${axis} settled] -> ${settled.yawDeg}/${settled.pitchDeg}`)
    return { held, settled }
  }
  const band = ROTATE_STYLE.stepThreshold
  const pxPerRadYaw = spanX / Math.PI // swipeAngle: angle = dx / span.x * π
  const pxPerRadPitch = spanY / Math.PI
  const deg = (rad) => rad * 180 / Math.PI

  // Park the cube ON the dock before anything else: the zone is centred on it, so a
  // test that claims "the same drag either way" has to start there. The travel that
  // undoes a bearing is the RAW offset (`rotation().bearingRawDeg`), never the bearing
  // itself — the bearing is the resisted value, so dragging out "the bearing in
  // degrees" would leave a residue. The park is always a sub-threshold drag, because a
  // bearing is at most one margin (10°) wide while the step threshold is 30°.
  const zone = (await readRotation()).zone
  const yawZone = zone.yaw
  const resistance = ROTATE_STYLE.bearingResistance
  const freeDeg = yawZone.marginDeg * resistance.free
  const parkYaw = async () => {
    const current = await readBearing()
    return dragByDeg('yaw', -current.rawYawDeg)
  }
  const atDock = await parkYaw()
  const parked = Math.abs(atDock.yawDeg) < 0.4
  tuning.push({ step: 'the cube parks back on the dock', bearingDeg: atDock.yawDeg, dockDeg: yawZone.dockDeg })
  if (!parked) failures.push(`bearing: parking the bearing on the dock landed at ${atDock.yawDeg}° (dock ${yawZone.dockDeg}°)`)

  // (1) SYMMETRY (rule 1). The same finger travel either way, from the dock, and
  // inside the zone but past the 1:1 region so the resistance is live on both sides.
  const probeDeg = yawZone.marginDeg * 0.8
  const toRight = await dragByDeg('yaw', probeDeg)
  await parkYaw()
  const toLeft = await dragByDeg('yaw', -probeDeg)
  const symmetryGap = Math.abs(Math.abs(toRight.yawDeg) - Math.abs(toLeft.yawDeg))
  const resisted = Math.abs(toRight.yawDeg) > freeDeg && Math.abs(toRight.yawDeg) < probeDeg
  tuning.push({
    step: 'the same drag either way yields the same offset',
    dragDeg: Number(probeDeg.toFixed(2)),
    rightDeg: toRight.yawDeg,
    leftDeg: toLeft.yawDeg,
    gapDeg: Number(symmetryGap.toFixed(2)),
    resisted,
  })
  if (symmetryGap >= 0.5) {
    failures.push(`bearing: the zone is not symmetric — ${probeDeg.toFixed(1)}° of drag right gave ${toRight.yawDeg}°, left gave ${toLeft.yawDeg}°`)
  }
  if (!resisted) {
    failures.push(`bearing: ${probeDeg.toFixed(1)}° of drag produced ${toRight.yawDeg}° — outside the resisted band (${freeDeg.toFixed(1)}°..${probeDeg.toFixed(1)}°)`)
  }

  // (2a) INSIDE the zone a release KEEPS exactly the pose on screen: no spring-back,
  // no convergence, nothing left to animate. This is the one property the whole
  // fine-tune layer exists for, and it is asserted on the angle the finger left AND on
  // the settle flag — a run that landed 0.01° away would still be a second animation.
  await parkYaw()
  const keptDrag = await dragHoldDeg('yaw', probeDeg)
  const keptShownDeg = keptDrag.held.live ? deg(keptDrag.held.live.shown) : 0
  const keptExactly = Math.abs(keptDrag.settled.yawDeg - keptShownDeg) < 0.05
  const noSettle = keptDrag.settled.settling === false
  tuning.push({
    step: 'inside the zone a release keeps what is on screen',
    dragDeg: Number(probeDeg.toFixed(2)),
    shownWhileHeldDeg: Number(keptShownDeg.toFixed(2)),
    settledDeg: keptDrag.settled.yawDeg,
    keptExactly,
    noSettle,
  })
  if (!keptExactly) {
    failures.push(`bearing: a release inside the zone moved the cube from ${keptShownDeg.toFixed(2)}° to ${keptDrag.settled.yawDeg}°`)
  }
  if (!noSettle) failures.push('bearing: a release inside the zone ran a convergence animation — it should have had nothing to settle')

  // (2b) THE EDGE (rule 2). A drag well past the operation margin: the cube overshoots
  // the zone WHILE the finger is down (that is the resistance, not a wall), and the
  // release converges it exactly onto the edge instead of truncating the drag.
  await parkYaw()
  const pastEdgeDeg = yawZone.edgeDeg * 1.25
  // The widest overshoot a player can ever release with is at the flip threshold —
  // past that the drag turns a face instead of settling. That is the budget the
  // overshoot is judged against, not an arbitrary tolerance.
  const releaseBudgetDeg = yawZone.marginDeg + (deg(band) - yawZone.edgeDeg) * resistance.wall
  const edge = await dragHoldDeg('yaw', pastEdgeDeg)
  const heldShownDeg = edge.held.live ? deg(edge.held.live.shown) : 0
  const overshot = heldShownDeg > yawZone.marginDeg && heldShownDeg <= releaseBudgetDeg + 0.2
  const converged = Math.abs(Math.abs(edge.settled.yawDeg) - yawZone.marginDeg) < 0.6
  const noTurn = qKey(edge.settled.base) === qKey(keptDrag.settled.base)
  tuning.push({
    step: 'past the edge it resists, then converges onto the edge',
    dragDeg: Number(pastEdgeDeg.toFixed(2)),
    operationMarginDeg: yawZone.edgeDeg,
    shownWhileHeldDeg: Number(heldShownDeg.toFixed(2)),
    marginDeg: yawZone.marginDeg,
    settledDeg: edge.settled.yawDeg,
    overshot,
    converged,
    faceUnchanged: noTurn,
  })
  if (!overshot) {
    failures.push(`bearing: a ${pastEdgeDeg.toFixed(1)}° drag held the cube at ${heldShownDeg.toFixed(2)}° — outside (${yawZone.marginDeg}°, ${releaseBudgetDeg.toFixed(2)}°]`)
  }
  if (!converged) {
    failures.push(`bearing: a drag past the edge settled at ${edge.settled.yawDeg}° instead of the ${yawZone.marginDeg}° edge`)
  }
  if (!noTurn) failures.push('bearing: a sub-threshold drag past the edge turned a face')

  // (3) THE FACE IS THE DRAG'S CALL (rule 3). The bearing is sitting on the frontal
  // edge now, and the drag that turns a face from there has to turn one from the
  // three-quarter edge too. Through v0.8.23 the test was `|bearing + drag|`, so from
  // the frontal edge this drag fine-tuned instead (|10° − 32.4°| = 22.4° < 30°) and
  // the player needed 40° of drag for the very same face.
  const flipDragDeg = deg(band) * 1.08
  const fromFrontEdge = await dragByDeg('yaw', -flipDragDeg)
  const frontTurned = qKey(fromFrontEdge.base) !== qKey(edge.settled.base)
  const frontKept = Math.abs(Math.abs(fromFrontEdge.yawDeg) - yawZone.marginDeg) < 0.6
  // Dial to the three-quarter edge (park first, so the origin is the dock again).
  await parkYaw()
  const backEdge = await dragByDeg('yaw', -pastEdgeDeg)
  const backDialled = Math.abs(Math.abs(backEdge.yawDeg) - yawZone.marginDeg) < 0.6
  const fromBackEdge = await dragByDeg('yaw', flipDragDeg)
  const backTurned = qKey(fromBackEdge.base) !== qKey(backEdge.base)
  const backKept = Math.abs(Math.abs(fromBackEdge.yawDeg) - yawZone.marginDeg) < 0.6
  tuning.push({
    step: 'the same drag turns a face from either edge',
    dragDeg: Number(flipDragDeg.toFixed(2)),
    frontalEdgeTurned: frontTurned,
    threeQuarterEdgeTurned: backTurned,
    bearingKeptAfterFrontTurn: frontKept,
    bearingKeptAfterBackTurn: backKept,
  })
  if (!frontTurned || !backTurned) {
    failures.push(`bearing: a ${flipDragDeg.toFixed(1)}° drag turned a face from ${frontTurned ? '' : 'no '}frontal edge / ${backTurned ? '' : 'no '}three-quarter edge — the face cost still depends on the bearing`)
  }
  if (!frontKept || !backKept) {
    failures.push(`bearing: the dialled bearing was lost across a face turn (${fromFrontEdge.yawDeg}° / ${fromBackEdge.yawDeg}°, edge ${yawZone.marginDeg}°)`)
  }
  if (!backDialled) failures.push(`bearing: dialling the three-quarter edge landed at ${backEdge.yawDeg}° instead of -${yawZone.marginDeg}°`)

  // (4) THE SHAPE of the resistance, read straight off the shipped model: monotone,
  // continuous at the edge (no cliff where the old clamp used to sit), creeping at
  // `wall` past it (NEVER frozen — the saturating first cut of this feature stopped
  // answering the finger from ~40° of drag on, which the trajectory section above
  // caught as a zero pose increment), and bounded where it counts: the widest
  // overshoot a player can release with is the one at the flip threshold.
  const curve = (await readRotation()).resistance.curve
  let monotone = true
  let continuous = true
  for (let i = 1; i < curve.length; i += 1) {
    const step = curve[i][1] - curve[i - 1][1]
    if (step < -0.005) monotone = false
    if (step > 2.05) continuous = false
  }
  const atThreshold = curve.find(([raw]) => raw === Math.round(deg(band))) ?? curve[curve.length - 1]
  const tailSlope = curve[curve.length - 1][1] - atThreshold[1]
  const creep = Math.abs(tailSlope - (curve[curve.length - 1][0] - atThreshold[0]) * resistance.wall) < 0.15
  const bounded = atThreshold[1] <= releaseBudgetDeg + 0.05
  // The first `free` of the zone is the identity: the finger tracks 1:1 there and the
  // resistance has not started. It cannot be reached through a gesture from the dock
  // (a drag only claims its axis after 16px, which is already ~6° — past the free
  // region), so it is asserted on the shipped curve instead of pretended away.
  const identityInFree = curve.filter(([raw]) => raw <= freeDeg).every(([raw, shown]) => Math.abs(raw - shown) < 0.02)
  tuning.push({
    step: 'the resistance is monotone, continuous, creeping and bounded',
    monotone,
    continuous,
    creep,
    identityInFree,
    atThresholdDeg: atThreshold[1],
    budgetDeg: Number(releaseBudgetDeg.toFixed(2)),
    bounded,
  })
  if (!monotone) failures.push('bearing: the resistance curve is not monotone — the cube would move backwards under a forward finger')
  if (!continuous) failures.push('bearing: the resistance curve jumps — the edge is a cliff again')
  if (!creep) failures.push(`bearing: past the edge the cube moves ${tailSlope.toFixed(2)}° per 2° of finger instead of ${(2 * resistance.wall).toFixed(2)}° — the wall is not a slope`)
  if (!identityInFree) failures.push(`bearing: the first ${freeDeg.toFixed(1)}° of the zone is not 1:1 — the resistance starts too early`)
  if (!bounded) failures.push(`bearing: at the ${deg(band).toFixed(1)}° flip threshold the cube is at ${atThreshold[1]}° (budget ${releaseBudgetDeg.toFixed(2)}°) — the overshoot is not bounded`)

  // (5) roll leaves no bearing behind (Z is the straighten gesture)
  const beforeRoll = await readBearing()
  if (sideX !== null) {
    const to = { x: sideX, y: centreY + Math.round(band * 0.5 * pxPerRadPitch) }
    await drag(client, { x: sideX, y: centreY }, to, 10)
    await sleep(SETTLE_MS)
    await client.frames()
  }
  const afterRoll = await readBearing()
  const rollClean = qKey(afterRoll.base) === qKey(beforeRoll.base)
    && Math.abs(afterRoll.yawDeg - beforeRoll.yawDeg) < 0.5
    && Math.abs(afterRoll.pitchDeg - beforeRoll.pitchDeg) < 0.5
  tuning.push({ step: 'a sub-threshold roll leaves no bearing', baseUnchanged: qKey(afterRoll.base) === qKey(beforeRoll.base) })
  if (sideX !== null && !rollClean) failures.push('bearing: a sub-threshold side-band roll left a residual offset')
  report.tuning = tuning
  // (6) THE FRONTAL EDGE STILL LEAVES A CUBE. The margin was DERIVED from this
  // measurement, so it is the one the probe has to keep honest: at the edge the front
  // face is still the subject and the roof is still a band, not a line — the failure
  // mode the old asymmetric fence existed to prevent (measured 100% main / 0% / 0% at
  // yaw +25°, pitch −25°, which then STAYED, because a bearing is remembered across
  // face turns and saved with the run).
  await parkYaw() // back to the dock
  const atFrontalEdge = await dragByDeg('yaw', pastEdgeDeg)
  const edgeFaces = await readJson(client, 'globalThis.__voxalblast.faces()')
  const edgeOthers = edgeFaces.others.map((entry) => entry.share)
  const edgeKeepsCube = edgeFaces.visible.length === 3 && edgeOthers.every((share) => share >= 0.04)
  tuning.push({
    step: 'the frontal edge still leaves a cube',
    bearingDeg: atFrontalEdge.yawDeg,
    mainShare: edgeFaces.mainShare,
    others: edgeOthers.map((share) => Number(share.toFixed(3))),
    facesVisible: edgeFaces.visible.length,
  })
  if (!edgeKeepsCube) {
    failures.push(`bearing: at the frontal edge the cube has ${edgeFaces.visible.length} faces (main ${(edgeFaces.mainShare * 100).toFixed(1)}%, others ${edgeOthers.map((s) => (s * 100).toFixed(1)).join('/')}) — the margin is letting it flatten`)
  }
  report.bearing = {
    dockDeg: yawZone.dockDeg,
    marginDeg: yawZone.marginDeg,
    operationMarginDeg: yawZone.edgeDeg,
    symmetricDragDeg: Number(probeDeg.toFixed(2)),
    rightDeg: toRight.yawDeg,
    leftDeg: toLeft.yawDeg,
    atEdgeHeldDeg: Number(heldShownDeg.toFixed(2)),
    atEdgeSettledDeg: edge.settled.yawDeg,
    flipDragDeg: Number(flipDragDeg.toFixed(2)),
    afterFrontTurnDeg: fromFrontEdge.yawDeg,
    afterBackTurnDeg: fromBackEdge.yawDeg,
    afterRollDeg: afterRoll.yawDeg,
  }

  const errs = JSON.parse(await client.evaluate('JSON.stringify(globalThis.__errs || [])'))
  if (errs.length) failures.push(`page errors: ${errs.join(' | ')}`)
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

if (JSON_ONLY) console.log(JSON.stringify({ ...report, failures }, null, 2))
else {
  console.log(`browser  ${browserPath}`)
  console.log(`target   ${APP_URL}  (dev server ${dev.started ? `started, pid ${dev.pid}` : 'already running'})`)
  console.log(`viewport ${VIEWPORT.width}x${VIEWPORT.height}\n`)
  const framing = report.framing
  if (framing) {
    console.log(`cube box ${report.ruler.cubeBox.width}x${report.ruler.cubeBox.height}px   one face ≈ ${report.ruler.pxPerFaceYaw}px drag (yaw) / ${report.ruler.pxPerFacePitch}px (pitch)`)
    console.log(`framing  ${framing.orientations} orientations (${framing.distinctPoses} distinct poses)`)
    console.log(`  main face share ${(framing.mainShare.min * 100).toFixed(1)}–${(framing.mainShare.max * 100).toFixed(1)}%   (target ${TARGET.mainShareMin * 100}–${TARGET.mainShareMax * 100}%)`)
    console.log(`  non-main faces ${(framing.otherMin * 100).toFixed(1)}–${(framing.otherMax * 100).toFixed(1)}%   (floor ${TARGET.minOtherShare * 100}%)`)
    console.log(`  cube upright ${framing.uprightDeg.min.toFixed(2)}…${framing.uprightDeg.max.toFixed(2)}° (0 = vertical edges plumb)`)
    console.log(`  presented face twist ${framing.twistDeg.min.toFixed(2)}…${framing.twistDeg.max.toFixed(2)}° (spread ${framing.twistDeg.spread.toFixed(2)}°)   off-axis ${framing.offAxisDeg.min.toFixed(2)}…${framing.offAxisDeg.max.toFixed(2)}°`)
    console.log(`  projected edge angle (informational, carries perspective convergence) ${framing.skewRange.min.toFixed(2)}…${framing.skewRange.max.toFixed(2)}°`)
    for (const row of framing.perOrientation) {
      console.log(`    ${row.path.padEnd(6)} front ${row.front.padEnd(3)} main ${(row.mainShare * 100).toFixed(1)}%  others ${row.others}  skew ${row.skewDeg.toFixed(2)}°`)
    }
  }
  if (report.trajectory) {
    console.log('\ntrajectory')
    for (const gesture of report.trajectory) {
      if (gesture.skipped) { console.log(`  ${gesture.name}: skipped (${gesture.skipped})`); continue }
      console.log(`  ${gesture.name}  (${gesture.pxToStep}px to commit)  axis offset ${gesture.axisOffsetDeg}°  drift ${gesture.axisDriftDeg}°`)
      for (const entry of gesture.trace) {
        console.log(`    ${String(entry.dragPx).padStart(6)}px  drag ${String(entry.liveAngleDeg).padStart(7)}°  Δ ${String(entry.deltaAngleDeg).padStart(6)}°  screen ${String(entry.screenDeg).padStart(7)}°  alongView ${entry.alongView}`)
      }
    }
  }
  if (report.tuning) {
    console.log('\nbearing (停靠 / 微调 / 换面)')
    for (const row of report.tuning) console.log(`  ${row.step.padEnd(48)} ${JSON.stringify(row)}`)
    const b = report.bearing
    console.log(`  dock ${b.dockDeg}°  margin ±${b.marginDeg}°  operation margin ±${b.operationMarginDeg}°  face at ${b.flipDragDeg}° of drag`)
    console.log(`  ${b.symmetricDragDeg}° of drag: right ${b.rightDeg}° / left ${b.leftDeg}°   at the edge: held ${b.atEdgeHeldDeg}° → settled ${b.atEdgeSettledDeg}°`)
    console.log(`  bearing kept across a face turn: ${b.afterFrontTurnDeg}° / ${b.afterBackTurnDeg}°   after a roll ${b.afterRollDeg}°`)
  }
  if (failures.length) console.log(`\nFAIL:\n  ${failures.join('\n  ')}`)
  else console.log('\nframing and rotation trajectories are within target')
}

if (thrown) throw thrown
if (failures.length) process.exitCode = 1

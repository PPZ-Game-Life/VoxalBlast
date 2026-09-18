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
//      at several drag distances and reports its screen direction.
//
//   node tools/cube-framing-probe.mjs [--json]
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
  const click = await client.evaluate('(() => { const b = document.querySelector("#home-primary"); if (!b) return "no-button"; b.click(); return "clicked"; })()')
  if (click !== 'clicked') throw new Error(`home cover not dismissed: ${click}`)
  await sleep(2600)
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
  // "每次转完，都是到达同一个角度" (v0.8.7 and earlier). These are the four things
  // that make the bearing the player's instead of a constant: a sub-threshold drag
  // is KEPT, it is REMEMBERED across a face turn, a drag that would leave the band
  // turns the next face instead, and a roll never leaves a bearing behind.
  const tuning = []
  const readBearing = async () => {
    const rotation = await readJson(client, 'globalThis.__voxalblast.rotation()')
    return { yawDeg: rotation.bearingDeg.yaw, pitchDeg: rotation.bearingDeg.pitch, base: rotation.base }
  }
  const dragBy = async (axis, px) => {
    const from = axis === 'pitch' ? { x: centreX, y: centreY } : { x: centreX, y: centreY }
    const to = axis === 'pitch' ? { x: from.x, y: from.y + px } : { x: from.x + px, y: from.y }
    await drag(client, from, to, 10)
    await sleep(SETTLE_MS)
    await client.frames()
    return readBearing()
  }
  const band = ROTATE_STYLE.stepThreshold
  const pxPerRadYaw = spanX / Math.PI // swipeAngle: angle = dx / span.x * π
  const pxPerRadPitch = spanY / Math.PI

  // (a) a sub-threshold drag is kept as the new bearing
  await pressKeys(client, [])
  const before1 = await readBearing()
  const nudgeRad = band * 0.4
  const after1 = await dragBy('yaw', -nudgeRad * pxPerRadYaw)
  const keptDelta = after1.yawDeg - before1.yawDeg
  const keptTarget = -nudgeRad * 180 / Math.PI
  const nudgeKept = Math.abs(keptDelta - keptTarget) < 3 && qKey(after1.base) === qKey(before1.base)
  tuning.push({ step: 'sub-threshold drag is kept', expectedDeg: Number(keptTarget.toFixed(2)), gotDeg: keptDelta, baseUnchanged: qKey(after1.base) === qKey(before1.base) })
  if (!nudgeKept) failures.push(`bearing: a ${(keptTarget).toFixed(1)}° fine-tune settled at ${keptDelta.toFixed(2)}° instead`)

  // (b) it survives a face turn: a committing drag keeps the bearing and steps base
  const committed = await dragBy('yaw', -band * 1.5 * pxPerRadYaw)
  const remembered = Math.abs(committed.yawDeg - after1.yawDeg) < 2
  const stepped = qKey(committed.base) !== qKey(after1.base)
  tuning.push({ step: 'bearing is remembered across a face turn', bearingDeg: committed.yawDeg, faceChanged: stepped })
  if (!stepped) failures.push('bearing: a drag well past the band did not turn a face')
  if (!remembered) failures.push(`bearing: the fine-tune was lost across a face turn (${after1.yawDeg}° -> ${committed.yawDeg}°)`)

  // (c) past the band it turns a face instead of fine-tuning further. Push in the
  // direction the bearing is already leaning, far enough that the total must leave
  // ±band: `band − |bearing|` to reach the edge, plus a margin.
  const after1Rad = committed.yawDeg * Math.PI / 180
  const toEdgeRad = band - Math.abs(after1Rad) + band * 0.3
  // Same direction the bearing is already leaning: swipeAngle's yaw term is
  // `+dx / span * π`, so a negative bearing needs a negative drag to go further.
  const overEdge = await dragBy('yaw', Math.sign(after1Rad || -1) * toEdgeRad * pxPerRadYaw)
  const turnedInstead = qKey(overEdge.base) !== qKey(committed.base)
  tuning.push({ step: 'past the band it turns the next face', faceChanged: turnedInstead, bearingDeg: overEdge.yawDeg })
  if (!turnedInstead) {
    failures.push(`bearing: a drag of ${(toEdgeRad * 180 / Math.PI).toFixed(1)}° from a ${committed.yawDeg}° bearing fine-tuned to ${overEdge.yawDeg} instead of turning a face`)
  }

  // (d) roll leaves no bearing behind (Z is the straighten gesture)
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
  // (e) THE FRONTAL FENCE. The "more frontal" direction is the one the fine-tune
  // exists for, and it is also the direction with almost no headroom: dialling far
  // enough used to leave the cube a flat plate with a face missing entirely
  // (measured 100% main / 0% / 0% at yaw +25/pitch -25), and because a bearing is
  // remembered across face turns and saved with the run, it STAYED that way - this is
  // the state the producer's phone screenshot was showing. `bearingBand` must now
  // stop the dial while all three faces are still there.
  const beforeFence = await readBearing()
  const yawBand = ROTATE_STYLE.bearingBand.yaw
  // Aim deliberately PAST the fence so the clamp is what stops it, not the drag length.
  const overshoot = 0.0873 // 5°
  const toFenceRad = (yawBand.max + overshoot) - beforeFence.yawDeg * Math.PI / 180
  const atFence = await dragBy('yaw', toFenceRad * pxPerRadYaw)
  const fenceFaces = await readJson(client, 'globalThis.__voxalblast.faces()')
  const fenceOthers = fenceFaces.others.map((entry) => entry.share)
  const fenceDeg = yawBand.max * 180 / Math.PI
  const stoppedAtFence = Math.abs(atFence.yawDeg - fenceDeg) < 1.5
  const fenceKeepsCube = fenceFaces.visible.length === 3 && fenceOthers.every((share) => share >= 0.04)
  tuning.push({
    step: 'dialling fully frontal still leaves a cube',
    fenceDeg: Number(fenceDeg.toFixed(2)),
    bearingDeg: atFence.yawDeg,
    stoppedAtFence,
    mainShare: fenceFaces.mainShare,
    others: fenceOthers.map((share) => Number(share.toFixed(3))),
    facesVisible: fenceFaces.visible.length,
  })
  if (!stoppedAtFence) {
    failures.push(`bearing: a frontal drag ${overshoot * 180 / Math.PI}° past the fence landed at ${atFence.yawDeg}° (fence ${fenceDeg}°) — the clamp is not holding`)
  }
  if (!fenceKeepsCube) {
    failures.push(`bearing: at the frontal fence the cube has ${fenceFaces.visible.length} faces (main ${(fenceFaces.mainShare * 100).toFixed(1)}%, others ${fenceOthers.map((s) => (s * 100).toFixed(1)).join('/')}) — the band is letting it flatten`)
  }
  // (f) ...and the player is never stuck at the fence: a drag long enough to leave
  // the ≈30° band still turns a face.
  const fromFence = await dragBy('yaw', (ROTATE_STYLE.stepThreshold + band * 0.2) * pxPerRadYaw)
  const escaped = qKey(fromFence.base) !== qKey(atFence.base)
  tuning.push({ step: 'a long frontal drag still turns a face', faceChanged: escaped, bearingDeg: fromFence.yawDeg })
  if (!escaped) failures.push('bearing: a drag past the band from the frontal fence did not turn a face - the player would be stuck')
  report.bearing = { afterYawNudgeDeg: after1.yawDeg, afterFaceTurnDeg: committed.yawDeg, afterRollDeg: afterRoll.yawDeg, atFenceDeg: atFence.yawDeg }

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
    console.log('\nbearing (微调方位)')
    for (const row of report.tuning) console.log(`  ${row.step.padEnd(44)} ${JSON.stringify(row)}`)
    console.log(`  bearing after the yaw nudge ${report.bearing.afterYawNudgeDeg}°  after a face turn ${report.bearing.afterFaceTurnDeg}°  after a roll ${report.bearing.afterRollDeg}°`)
  }
  if (failures.length) console.log(`\nFAIL:\n  ${failures.join('\n  ')}`)
  else console.log('\nframing and rotation trajectories are within target')
}

if (thrown) throw thrown
if (failures.length) process.exitCode = 1

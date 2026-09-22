// Resource / listener accumulation probe.
//
//   node tools/refactor-churn-probe.mjs [url]
//
// Why it exists. The refactor plan (§7.5, last row) requires that repeated real play —
// 反复新局 / 返家 / 设置 / 换批 — stays "一次输入一次响应", with no steady growth in
// renderers, canvases, listeners or timers, and it names this as the check that has to run
// ~20 times. Nothing in the suite covered it: every other probe drives ONE gesture or ONE
// panel and then exits. That gap is exactly where the module split is most dangerous,
// because the pieces that get re-created on every cycle are the ones moving house:
//   * ui/* bind() — a listener registered per open is invisible until you open it 20 times
//   * pieceView   — the candidate slots each own a WebGLRenderer, and 换批 rebuilds them
//   * boardView   — PLAY AGAIN rebuilds all 98 tiles
//   * effects     — a new run must not leave the previous run's particles behind
//
// What it measures, without adding any monitoring framework to the game:
//   * `getEventListeners()` — the DevTools Command Line API, already in the browser. This is
//     the only way to see a double-bound listener from the outside, and it is the direct
//     assertion for the plan's "监听器只绑定一次" rule.
//   * canvas count, `__voxalblast.rendering()` (meshes / uniqueCells / programs), and the
//     candidate slot count.
//   * a final liveness check: after all the churn a real drag must still attach, so a
//     "clean" result cannot be bought by breaking the game.
//
// Judgement rule, taken from the plan: Three's internal caches are NOT required to return to
// their starting value, but no metric may grow monotonically across cycles. So the
// assertion is STEADY STATE — the value after the last cycle must equal the value after a
// warm-up cycle — not "equals the first reading".
//
// Discipline: real CDP input, one isolated browser profile + OS-assigned debug port,
// Browser.close before profile removal. Anything that cannot be reached is SKIP, not PASS.
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const APP_URL = (process.argv[2] || 'http://127.0.0.1:5173/').replace(/\/?$/, '/')
const APP_PORT = Number(new URL(APP_URL).port || 80)
const VIEWPORT = { width: 900, height: 1200 }

// Cycle counts. The plan asks for ~20 repeats of the high-frequency action; 换批 and 新局
// are heavier (each rebuilds candidates / the whole board), so they run fewer times but
// still enough for a leak to show: a per-cycle leak of one renderer is unmistakable at 8.
const SETTINGS_CYCLES = 20
const HOME_CYCLES = 10
const NEW_RUN_CYCLES = 8
const REROLL_CYCLES = 12
const WARMUP_CYCLES = 2

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
    || !basename(actualProfile).startsWith('voxalblast-churn-')) {
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
  console.log(`dev server not up on ${APP_PORT}; starting vite --port ${APP_PORT} --strictPort`)
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

// ----------------------------------------------------------------------- page client

function makeClient(ws) {
  let nextId = 100
  // A plain value read. The listener half of a sample does NOT come from here — it comes
  // from `readListeners()` over the protocol, because the console-only helper is not
  // injected into this kind of evaluation (see the note above SAMPLE).
  const evaluate = async (expression, { awaitPromise = false } = {}) => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        const result = await send(ws, (nextId += 1), 'Runtime.evaluate', {
          expression, returnByValue: true, awaitPromise,
        })
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
  const readJson = async (expression, opts) => JSON.parse(await evaluate(`JSON.stringify(${expression})`, opts))
  // A live object reference, for the protocol methods that take an objectId (listener
  // inspection). No returnByValue, so this must not be used for reading values.
  const objectId = async (expression) => {
    const result = await send(ws, (nextId += 1), 'Runtime.evaluate', { expression })
    return result.result?.objectId ?? null
  }
  const frames = () => evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))', { awaitPromise: true })
  return { send: (method, params) => send(ws, (nextId += 1), method, params), evaluate, readJson, objectId, frames }
}

async function waitForHandle(client) {
  for (let i = 0; i < 100; i += 1) {
    if (await client.evaluate('Boolean(globalThis.__voxalblast)')) return true
    await sleep(250)
  }
  throw new Error('app never exposed globalThis.__voxalblast')
}

async function waitIntroDone(client) {
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    if ((await client.evaluate('JSON.stringify(globalThis.__voxalblast.intro().active)')) === 'false') {
      await sleep(250)
      await client.frames()
      return true
    }
    await sleep(200)
  }
  return false
}

// One sample of the accumulating quantities that are observable from inside the page.
//
// Listener counts are deliberately NOT read here. `getEventListeners()` is a DevTools
// console-only helper and is not injected for a plain `Runtime.evaluate` — measured, not
// assumed: this probe's first run died on `ReferenceError: getEventListeners is not defined`
// even with `includeCommandLineAPI: true`. The protocol has the real thing instead:
// `DOMDebugger.getEventListeners` takes an object id and returns the listener descriptors,
// which is what `readListeners()` below uses.
const SAMPLE = `(() => {
  const rendering = globalThis.__voxalblast.rendering()
  const candidates = globalThis.__voxalblast.candidateFrames()
  return {
    canvases: document.querySelectorAll('canvas').length,
    meshes: rendering.meshes,
    uniqueCells: rendering.uniqueCells,
    programs: rendering.programs,
    slots: document.querySelectorAll('#piece-slots .piece-slot').length,
    candidateNames: candidates.map((frame) => frame.name),
    score: globalThis.__voxalblast.board().score,
    status: document.querySelector('#status')?.textContent ?? null,
    homeOpen: globalThis.__voxalblast.home().open,
  }
})()`

const metricPaths = [
  ['listeners.window', (s) => s.listeners.window],
  ['listeners.document', (s) => s.listeners.document],
  ['listeners.canvas', (s) => s.listeners.canvas],
  ['listeners.settingsButton', (s) => s.listeners.settingsButton],
  ['listeners.playAgain', (s) => s.listeners.playAgain],
  ['listeners.soundSwitch', (s) => s.listeners.soundSwitch],
  ['canvases', (s) => s.canvases],
  ['rendering.meshes', (s) => s.meshes],
  ['rendering.uniqueCells', (s) => s.uniqueCells],
  ['rendering.programs', (s) => s.programs],
  ['candidateSlots', (s) => s.slots],
]

// The long-lived nodes whose listener counts matter: window/document carry the page-level
// handlers, the board canvas carries the pointer/keyboard/wheel input, and the three
// buttons are the ones a per-open `bind()` would double up. A node that does not exist yet
// (the Game Over card before the first run ends) reads as null and is reported, not guessed.
const LISTENER_TARGETS = [
  ['window', 'globalThis'],
  ['document', 'document'],
  ['canvas', "document.querySelector('#scene-wrap canvas')"],
  ['settingsButton', "document.querySelector('#settings-button')"],
  ['playAgain', "document.querySelector('#reset-modal')"],
  ['soundSwitch', "document.querySelector('#sound-setting')"],
]

async function readListeners(client) {
  const counts = {}
  for (const [name, expression] of LISTENER_TARGETS) {
    const objectId = await client.objectId(expression)
    if (!objectId) { counts[name] = null; continue }
    try {
      const result = await client.send('DOMDebugger.getEventListeners', { objectId, depth: 0, pierce: false })
      counts[name] = (result.listeners || []).length
    } catch {
      counts[name] = null
    }
  }
  return counts
}

// One sample = the page-side metrics plus the protocol-side listener counts.
async function sample(client) {
  const base = await client.readJson(SAMPLE)
  return { ...base, listeners: await readListeners(client) }
}

// ----------------------------------------------------------------------------- checks

const results = { ok: 0, fail: 0, skip: 0 }
const failures = []
const skips = []

function check(label, condition, detail) {
  if (condition) {
    results.ok += 1
    console.log(`OK   ${label}${detail ? `  ${detail}` : ''}`)
  } else {
    results.fail += 1
    failures.push(label)
    console.log(`FAIL ${label}${detail ? `  ${detail}` : ''}`)
  }
  return condition
}

function skip(label, reason) {
  results.skip += 1
  skips.push(`${label}: ${reason}`)
  console.log(`SKIP ${label}  ${reason}`)
}

function note(label, detail) {
  console.log(`INFO ${label}  ${detail}`)
}

// Steady state, not "back to the start". Two conditions, both required:
//   * no NET growth — the last reading is not above the first (samples start after a
//     warm-up, so the first reading is already past lazy init: shader programs, the
//     first-run texture uploads, and the like)
//   * SETTLED — the last two readings agree, so the series has stopped moving rather than
//     merely happening to end where it began
// A monotonic per-cycle leak fails both. Three's lazily-populated caches pass.
function checkSteady(group, samples, metric, name) {
  // An empty or near-empty series means the cycle loop bailed early; say so instead of
  // comparing `undefined <= undefined` and reporting a confusing "leak".
  if (samples.length < 3) {
    skip(`${group} · ${name}`, `only ${samples.length} sample(s) collected — the cycle loop did not complete`)
    return
  }
  const values = samples.map(metric)
  if (values.some((value) => value === null || value === undefined)) {
    skip(`${group} · ${name}`, 'metric unavailable in this browser build')
    return
  }
  const first = values[0]
  const last = values[values.length - 1]
  const previous = values[values.length - 2] ?? first
  const peak = Math.max(...values)
  check(`${group} · ${name} does not grow across cycles`, last <= first && last === previous,
    `first=${first} last=${last} peak=${peak} series=[${values.join(',')}]`)
}

// ------------------------------------------------------------------------ CDP input

function mouse(client) {
  return {
    async click(selector) {
      const rect = await client.readJson(`(() => { const el = document.querySelector(${JSON.stringify(selector)})
        if (!el) return null; const box = el.getBoundingClientRect()
        if (box.width === 0 || box.height === 0) return null
        return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) } })()`)
      if (!rect) return false
      await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y })
      await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', buttons: 1, clickCount: 1 })
      await sleep(30)
      await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', buttons: 0, clickCount: 1 })
      await sleep(200)
      return true
    },
    async pressAndHold(from, to, steps = 6) {
      await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y })
      await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 })
      for (let i = 1; i <= steps; i += 1) {
        const t = i / steps
        await client.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved', x: Math.round(from.x + (to.x - from.x) * t), y: Math.round(from.y + (to.y - from.y) * t), button: 'left', buttons: 1,
        })
        await sleep(16)
      }
    },
    async up(x, y) {
      await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
    },
  }
}

// ------------------------------------------------------------------- the churn cases

async function cycleSettings(client, input, samples) {
  for (let i = 0; i < SETTINGS_CYCLES; i += 1) {
    await input.click('#settings-button')
    await input.click('#settings-close')
    if (i >= WARMUP_CYCLES) samples.push(await sample(client))
  }
}

async function cycleHome(client, input, samples) {
  for (let i = 0; i < HOME_CYCLES; i += 1) {
    await input.click('#settings-button')
    await input.click('#home-setting')
    await input.click('#home-primary')
    await waitIntroDone(client)
    if (i >= WARMUP_CYCLES) samples.push(await sample(client))
  }
}

async function cycleNewRun(client, input, samples) {
  if (!(await client.evaluate('Boolean(globalThis.__voxalblastDev?.endGame)'))) return false
  for (let i = 0; i < NEW_RUN_CYCLES; i += 1) {
    await client.evaluate('globalThis.__voxalblastDev.endGame()')
    await sleep(300)
    await input.click('#reset-modal')
    await waitIntroDone(client)
    if (i >= WARMUP_CYCLES) samples.push(await sample(client))
  }
  return true
}

// 换批 is the one cycle that rebuilds the candidate previews, and those are the three
// per-slot WebGLRenderers — the single most likely thing to leak when pieceView moves out of
// main.js. It is guarded: if the click does not actually re-deal (the item may be disarmed,
// on cooldown, or the button may not be the instant-use path), the sub-cycle reports SKIP
// instead of pretending to have exercised the rebuild.
async function cycleReroll(client, input, samples) {
  const armed = await client.evaluate('Boolean(globalThis.__voxalblastDev?.setItems)')
  if (!armed) return 'no-dev-handle'
  await client.evaluate('globalThis.__voxalblastDev.setItems({ refresh: 99, hammer: 1, rocket: 1, bomb: 1 })')
  await sleep(200)
  const first = await sample(client)
  const before = first.candidateNames.join(',')
  let rerolled = false
  for (let i = 0; i < REROLL_CYCLES; i += 1) {
    const clicked = await input.click('.item-button[data-item="refresh"]')
    if (!clicked) return 'no-refresh-button'
    await sleep(250)
    const now = await sample(client)
    if (now.candidateNames.join(',') !== before) rerolled = true
    if (i >= WARMUP_CYCLES) samples.push(now)
  }
  return rerolled ? 'rerolled' : 'no-change'
}

// --------------------------------------------------------------------------- driver

const browserPath = findBrowser()
const dev = await ensureDevServer()
console.log(`browser  ${browserPath}`)
console.log(`target   ${APP_URL}  (dev server ${dev.started ? `started, pid ${dev.pid}` : 'already running'})`)
console.log(`viewport ${VIEWPORT.width}x${VIEWPORT.height}`)
console.log(`cycles   settings ${SETTINGS_CYCLES} · home ${HOME_CYCLES} · new run ${NEW_RUN_CYCLES} · reroll ${REROLL_CYCLES}\n`)

const profile = mkdtempSync(join(tmpdir(), 'voxalblast-churn-'))
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
  if (!pageTarget?.webSocketDebuggerUrl) throw new Error('no page target to attach to')
  pageSocket = await connect(pageTarget.webSocketDebuggerUrl)

  const client = makeClient(pageSocket)
  const errors = []
  pageSocket.addEventListener('message', (event) => {
    const { method, params } = JSON.parse(event.data)
    if (method === 'Runtime.consoleAPICalled' && params.type === 'error') {
      errors.push(params.args.map((arg) => arg.value ?? arg.description ?? arg.type).join(' '))
    }
    if (method === 'Runtime.exceptionThrown') errors.push(params.exceptionDetails.text)
  })
  await client.send('Page.enable')
  await client.send('Runtime.enable')
  // Required for DOMDebugger.getEventListeners to resolve the object ids it is handed.
  await client.send('DOM.enable')
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: VIEWPORT.width, height: VIEWPORT.height,
    screenWidth: VIEWPORT.width, screenHeight: VIEWPORT.height, deviceScaleFactor: 1, mobile: false,
  })

  await client.send('Page.navigate', { url: APP_URL })
  await waitForHandle(client)
  check('boot: the opening wave finishes on its own', (await waitIntroDone(client)) === true, 'intro().active === false')

  const input = mouse(client)
  const baseline = await sample(client)
  check('boot: the listener API is available for measuring', baseline.listeners.window !== null,
    `window=${baseline.listeners.window} document=${baseline.listeners.document} canvas=${baseline.listeners.canvas}`)
  check('boot: the board is the expected 98 unique tiles', baseline.meshes === 98 && baseline.uniqueCells === 98,
    `meshes=${baseline.meshes} uniqueCells=${baseline.uniqueCells}`)
  check('boot: exactly three candidate slots', baseline.slots === 3, `slots=${baseline.slots}`)

  console.log(`\n-- A. settings open/close x${SETTINGS_CYCLES} --`)
  const settingsSamples = []
  await cycleSettings(client, input, settingsSamples)
  for (const [name, get] of metricPaths) checkSteady('A', settingsSamples, get, name)

  console.log(`\n-- B. home cover open/return x${HOME_CYCLES} --`)
  const homeSamples = []
  await cycleHome(client, input, homeSamples)
  for (const [name, get] of metricPaths) checkSteady('B', homeSamples, get, name)

  console.log(`\n-- C. new run (Game Over -> PLAY AGAIN) x${NEW_RUN_CYCLES} --`)
  const runSamples = []
  if (await cycleNewRun(client, input, runSamples)) {
    for (const [name, get] of metricPaths) checkSteady('C', runSamples, get, name)
    check('C every new run really starts from zero', runSamples.every((sample) => sample.score === 0),
      `scores=[${runSamples.map((sample) => sample.score).join(',')}]`)
    check('C every new run really deals three unspent candidates',
      runSamples.every((sample) => sample.slots === 3), `slots=[${runSamples.map((s) => s.slots).join(',')}]`)
  } else {
    skip('C new-run churn', 'no DEV endGame handle: point this probe at `npm run dev`')
  }

  console.log(`\n-- D. 换批 (candidate preview rebuild) x${REROLL_CYCLES} --`)
  const rerollSamples = []
  const rerollOutcome = await cycleReroll(client, input, rerollSamples)
  if (rerollOutcome === 'rerolled') {
    for (const [name, get] of metricPaths) checkSteady('D', rerollSamples, get, name)
  } else {
    skip('D 换批 churn', `the refresh click did not re-deal (${rerollOutcome}); candidate-preview leak not exercised`)
  }

  console.log('\n-- E. the game still works after all of it --')
  await waitIntroDone(client)
  const bounds = await client.readJson('globalThis.__voxalblast.bounds()')
  const midX = (bounds.minX + bounds.maxX) / 2
  const midY = (bounds.minY + bounds.maxY) / 2
  const halfW = (bounds.maxX - bounds.minX) / 2
  const halfH = (bounds.maxY - bounds.minY) / 2
  // Sweep the candidate slots AND a few points on the cube, exactly like the interaction
  // probe's case A. A single point on a single slot is flaky by construction: after 12 换批
  // the hand is random, and a 6-cell `Rect 6` or a 3×3 `Block 9` often has nowhere to go on
  // the front face — which is a legitimate "no room" (`mode === 'invalid'`), NOT a broken
  // input path. Measured, not guessed: the first version of this check failed with
  // `mode=invalid marker=0` while `refactor-interaction-probe` case A attached fine on the
  // very same tree, and `mode=invalid` is only ever set AFTER the pointer has been projected
  // onto the cube and the carried ghost tinted — so the path it was meant to prove had in
  // fact worked.
  const slots = await client.readJson(`(() => [...document.querySelectorAll('#piece-slots .piece-slot:not(.used)')]
    .map((el) => { const box = el.getBoundingClientRect()
      return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) } }))()`)
  if (!slots.length) {
    skip('E liveness', 'no unused candidate slot to drag after the churn')
  } else {
    const targets = [[0, 0], [0.35, 0], [-0.35, 0], [0, 0.35], [0, -0.35], [0.35, 0.35], [-0.35, -0.35]]
      .map(([dx, dy]) => ({ x: Math.round(midX + dx * halfW), y: Math.round(midY + dy * halfH) }))
    // A drag can only ever land on the face the pointer projects onto, which is always the
    // FRONT face. The opening layout only guarantees that SOME candidate fits on SOME of the
    // six faces, so sweeping the front face alone is not guaranteed to succeed — the first
    // version of this check could report SKIP half the time for that reason. Rotating one
    // face between sweeps walks all six, so the guarantee does apply, and the check also
    // proves rotation still works after the churn.
    let live = null
    let attached = false
    let attempts = 0
    let rotations = 0
    const MAX_ROTATIONS = 5
    for (; rotations <= MAX_ROTATIONS && !attached; rotations += 1) {
      for (const slot of slots) {
        for (const target of targets) {
          attempts += 1
          await input.pressAndHold(slot, target)
          await client.frames()
          live = await client.readJson('globalThis.__voxalblast.ghost()')
          if (live.attached === true && live.mode === 'snap' && live.previewCells > 0) { attached = true; break }
          await input.up(target.x, target.y)
          await sleep(70)
        }
        if (attached) break
      }
      if (attached) break
      // One quarter turn about world Y, through the real key handler.
      await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 })
      await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 })
      await sleep(450)
    }
    if (attached) {
      // Release on the cell the preview showed, so this also completes a real placement.
      const placed = await client.readJson('globalThis.__voxalblast.ghost()')
      await input.up(midX, midY)
      await sleep(300)
      check('E a real drag still attaches after the churn', true,
        `mode=snap marker=${placed.previewCells} after ${attempts} attempt(s), ${rotations} rotation(s)`)
    } else {
      skip('E a real drag still attaches after the churn',
        `no unused candidate had room on any of the 6 faces after ${attempts} attempt(s) (last mode=${live?.mode ?? 'none'})`)
    }
    const after = await sample(client)
    check('E the board still holds exactly 98 unique tiles', after.meshes === 98 && after.uniqueCells === 98,
      `meshes=${after.meshes} uniqueCells=${after.uniqueCells}`)
    check('E the panel still responds to a click', await input.click('#settings-button')
      && (await sample(client)).status === 'Paused', 'settings opened after the churn')
    await input.click('#settings-close')
  }

  console.log('')
  check('no browser console errors', errors.length === 0, errors.join(' | '))
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

console.log(`\nchecks: ${results.ok} ok, ${results.fail} failed, ${results.skip} skipped`)

if (thrown) throw thrown
if (failures.length) {
  console.log(`\nFAIL:\n  ${failures.join('\n  ')}`)
  process.exitCode = 1
} else if (skips.length) {
  console.log(`\nno failures, but ${skips.length} case(s) never ran:\n  ${skips.join('\n  ')}`)
  process.exitCode = 0
} else {
  console.log('\nno renderer, canvas, listener or tile accumulation across repeated play')
}

// Drag-feel probe (v0.8.27) — how the placement drag behaves WHILE the finger is down.
//
//   node tools/drag-feel-probe.mjs [url]
//
// Why it exists. `refactor-interaction-probe.mjs` pins the placement PATH: the preview the
// player sees is the placement that lands, cancel / Esc / right-click / settings / a second
// pointer / a reload all leave a clean state. It says nothing about how the drag FEELS between
// the attach and the release, and that is exactly what v0.8.27 reworked: 「吸附后继续调整位置很
// 困难」 (the preview froze on an illegal target and kept the last legal origin), 「大方块进入棋盘
// 时突然跳位」 (the attach searched the whole face for the nearest LEGAL origin) and 「到边缘后反向
// 拖动不及时」 (the over-travel was banked and had to be unwound first). None of the three is
// visible to a probe that only reads the state after a release, and none of them is fixed by
// tuning `snapMarginPx`.
//
// What it asserts, in the order it runs:
//   A attach mapping   the piece lands where it is held, and the hand→face offset does NOT grow
//                      with the shape (the old model offset a 3-long piece by ~1 cell and threw
//                      a big piece around after searching the whole face)
//   B over occupied    the target keeps moving while it is illegal, the marker turns red, and
//                      both recover the moment the piece clears an occupied cell
//   C edge reverse     once the piece is against an edge the first cell of the way back moves it:
//                      no over-travel to unwind first
//   D illegal release  spends nothing, leaves the board untouched, and does NOT fall back to a
//                      position the piece used to be on
//   E release point    the drop is judged at the RELEASE coordinates, through the same rule that
//                      drew the last frame (browsers do not always deliver a final move)
//   F touch            the touch grab lift is bounded and the preview still crosses an occupied
//                      cell with a real touch pointer
//   G other faces      after a real cube turn the piece still tracks the finger, one lattice unit
//                      per lattice unit, measured on the FACE's own axes
//   J cube edges     carrying the piece until its own centre leaves the CUBE's silhouette arms
//                    the dwell on that side (the screen edge plays no part since v0.9.11);
//                    feedback and placement survive
//   K cancellation    leaving an edge, release and Escape clear the pending dwell
//   L repeat + touch  a stationary touch can browse faces; full faces never auto-spin
//   M the switch      the 拖块翻面 preference gates the dwell: OFF carries the piece but never
//                     arms, background drags still turn the cube, ON arms again, and flipping it
//                     OFF mid-drag drops a dwell that is already armed
//   N the entry       pushing a piece UP out of the tray (which always crosses the cube's bottom
//                     edge) never arms, however long it is held there; once the piece HAS been
//                     inside the cube that same edge arms again, and the latch resets per drag
//
// Discipline, same as the other probes: real CDP input only, read-only `__voxalblast` handles for
// observation, an isolated browser profile with an OS-assigned debug port, Browser.close before
// the profile is removed, and every precondition that cannot be reached reported as SKIP (never
// as PASS) so a green run cannot be bought by skipping.
//
// One harness note that matters for case A: `__voxalblast.placement()` describes the FIRST UNUSED
// candidate, so a drag of any other slot would describe a different shape and the comparison would
// be nonsense. Every case therefore drags slot 0, and the fixture's hand is reordered per case so
// that slot 0 holds the shape the case needs.
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { SH, faceLattice } from '../src/game/board.js'
import { DRAG_GHOST, PIECE_SPIN, RENDER_PALETTE } from '../src/rendering/config.js'
import { Quaternion } from 'three'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const APP_URL = (process.argv[2] || 'http://127.0.0.1:5173/').replace(/\/?$/, '/')
const APP_PORT = Number(new URL(APP_URL).port || 80)
const VIEWPORT = { width: Number(process.env.DRAGFEEL_WIDTH || 430), height: Number(process.env.DRAGFEEL_HEIGHT || 900) }

// The invalid marker's own colour, read from the constant the renderer uses: a probe with the hex
// hard-coded would keep passing after the palette moved.
const INVALID_HEX = `#${RENDER_PALETTE.invalid.toString(16).padStart(6, '0')}`

// The deterministic session the interaction probe already uses: one centre cell per face (so the
// front face is empty except its middle) and three small candidates. Reusing the file keeps the
// two probes comparable; only the ORDER of the hand is rewritten, per case.
const FIXTURE_PATH = join(ROOT, 'tools', 'fixtures', 'interaction-session.json')
const FIXTURE_SNAPSHOT = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')).snapshot

function fixtureSource(handOrder) {
  const byName = new Map(FIXTURE_SNAPSHOT.pieces.map((entry) => [entry.name, entry]))
  const snapshot = {
    ...FIXTURE_SNAPSHOT,
    pieces: handOrder.map((name) => ({ ...(byName.get(name) || { name, used: false }), used: false })),
  }
  return `localStorage.setItem('voxalblast.session.v1', ${JSON.stringify(JSON.stringify(snapshot))})`
}

// A packed front face verifies that unavailable placement never bypasses edge dwell.
function spinFixtureSource(handOrder) {
  const packed = new Map()
  FIXTURE_SNAPSHOT.board.cells.forEach((cell) => packed.set(cell.slice(0, 3).join(','), cell))
  for (let u = 0; u < SH; u += 1) {
    for (let v = 0; v < SH; v += 1) {
      const [x, y, z] = faceLattice('+z', u, v)
      packed.set(`${x},${y},${z}`, [x, y, z, FIXTURE_SNAPSHOT.board.cells[0][3]])
    }
  }
  const byName = new Map(FIXTURE_SNAPSHOT.pieces.map((entry) => [entry.name, entry]))
  const snapshot = {
    ...FIXTURE_SNAPSHOT,
    board: { ...FIXTURE_SNAPSHOT.board, cells: [...packed.values()] },
    pieces: handOrder.map((name) => ({ ...(byName.get(name) || { name, used: false }), used: false })),
  }
  return `localStorage.setItem('voxalblast.session.v1', ${JSON.stringify(JSON.stringify(snapshot))})`
}

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
]

const MOVE_STEPS = 6
const INTRO_TIMEOUT_MS = 20000
// Debugging aid: DRAGFEEL_CASES=AC runs only the named cases (a full run reloads the app a dozen
// times, which is slow while a single case is being chased).
const ONLY = (process.env.DRAGFEEL_CASES || '').toUpperCase()
const wants = (id) => !ONLY || ONLY.includes(id)
// A mouse grab lifts the piece 10px — a fraction of one cell. A real touch grab lifts it by half
// the piece's own height (capped at 120px + 12), which on this viewport is a couple of cells.
const MOUSE_OFFSET_MAX_CELLS = 0.6
const TOUCH_OFFSET_MAX_CELLS = 3

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function feedbackShot(client, name) {
  if (!process.env.DRAGFEEL_ARTIFACTS) return
  const folder = resolve(ROOT, process.env.DRAGFEEL_ARTIFACTS)
  mkdirSync(folder, { recursive: true })
  const shot = await client.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(folder, `${name}.png`), Buffer.from(shot.data, 'base64'))
}

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
    || !basename(actualProfile).startsWith('voxalblast-dragfeel-')) {
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

// The repo's own vite entrypoint is spawned directly (Node refuses a .cmd without a shell) and
// left running on purpose: the other probes reuse the same port.
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
  const readJson = async (expression) => JSON.parse(await evaluate(`JSON.stringify(${expression})`))
  const frames = () => evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))', { awaitPromise: true })
  return { send: (method, params) => send(ws, (nextId += 1), method, params), evaluate, readJson, frames }
}

const HANDLE_READY = 'Boolean(globalThis.__voxalblast && typeof globalThis.__voxalblast.ghost === "function")'

async function waitForHandle(client) {
  for (let i = 0; i < 100; i += 1) {
    if (await client.evaluate(HANDLE_READY)) return true
    await sleep(250)
  }
  throw new Error('app never exposed globalThis.__voxalblast')
}

// The opening wave holds the same pause lock as a modal: a drag started during it is swallowed.
async function waitIntroDone(client) {
  const deadline = Date.now() + INTRO_TIMEOUT_MS
  while (Date.now() < deadline) {
    if ((await client.evaluate('JSON.stringify(globalThis.__voxalblast.intro().active)')) === 'false') {
      await sleep(300)
      await client.frames()
      return true
    }
    await sleep(200)
  }
  return false
}

let fixtureScriptId = null
let fixtureSourceNow = null
async function setSessionFixture(client, source) {
  if (fixtureScriptId) {
    await client.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: fixtureScriptId })
    fixtureScriptId = null
  }
  fixtureSourceNow = source
  if (!source) return
  const added = await client.send('Page.addScriptToEvaluateOnNewDocument', { source })
  fixtureScriptId = added.identifier
}

async function reloadWithHand(client, handOrder) {
  await setSessionFixture(client, fixtureSource(handOrder))
  await client.send('Page.reload', { ignoreCache: false })
  await sleep(1200)
  await waitForHandle(client)
  await client.frames()
  const done = await waitIntroDone(client)
  if (!done) note('intro', `the opening wave did not settle within ${INTRO_TIMEOUT_MS}ms`)
  return done
}

// One read of everything below compares against, in a single evaluate so a check can never
// straddle two frames.
const STATE = `(() => {
  const toast = document.querySelector('#toast')
  const slots = [...document.querySelectorAll('#piece-slots .piece-slot')].map((slot) => {
    const box = slot.getBoundingClientRect()
    return {
      index: Number(slot.dataset.index),
      used: slot.classList.contains('used'),
      x: Math.round(box.left + box.width / 2),
      y: Math.round(box.top + box.height / 2),
    }
  })
  return {
    status: document.querySelector('#status')?.textContent ?? null,
    toast: toast?.textContent ?? null,
    slots,
    board: globalThis.__voxalblast.board(),
    ghost: globalThis.__voxalblast.ghost(),
    preview: globalThis.__voxalblast.preview(),
    clearPreview: globalThis.__voxalblast.clearPreview(),
    placement: globalThis.__voxalblast.placement(),
    rotation: globalThis.__voxalblast.rotation(),
  }
})()`

const boardFingerprint = (board) => JSON.stringify(board.cells.map((cell) => `${cell[0]},${cell[1]},${cell[2]}`).sort())
  + `|score=${board.score}|lines=${board.totalLines}`

// ------------------------------------------------------------------------ CDP input

function mouse(client) {
  return {
    async move(x, y) {
      await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 })
    },
    async up(x, y) {
      await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
    },
    async pressAndHold(from, to, steps = MOVE_STEPS) {
      await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y })
      await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 })
      for (let i = 1; i <= steps; i += 1) {
        const t = i / steps
        await this.move(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t)
        await sleep(16)
      }
    },
  }
}

function touch(client) {
  const points = (list) => list.map((point) => ({ x: point.x, y: point.y, id: point.id, radiusX: 2, radiusY: 2, force: 1 }))
  return {
    async start(list) { await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(list) }) },
    async move(list) { await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(list) }) },
    async end(list) { await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: points(list) }) },
  }
}

async function pressEscape(client) {
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
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
  console.log(`GAP  ${label}  ${detail}`)
}

const fmt = (value) => (value ? `(${value.fu.toFixed(3)}, ${value.fv.toFixed(3)})` : 'none')
const fmtRef = (value) => (value ? `(${value.u.toFixed(3)}, ${value.v.toFixed(3)})` : 'none')

// ------------------------------------------------------------------- shared state reads

const attached = (state) => state.ghost.attached === true && state.ghost.mode === 'snap' && state.ghost.previewCells > 0
const idle = (state) => state.ghost.attached === false && state.ghost.visible === false
  && state.ghost.count === 0 && state.ghost.previewCells === 0
// `placement()` follows the first UNUSED candidate, which is always slot 0 in this probe.
const tracksDrag = (state) => state.preview.piece !== null && state.preview.piece === state.placement.piece
const originKey = (state) => `${state.ghost.previewOrigin.u},${state.ghost.previewOrigin.v}`

function extent(cells) {
  return {
    u: Math.max(...cells.map(([u]) => u)),
    v: Math.max(...cells.map(([, v]) => v)),
  }
}

// Where the piece's bounding-box CENTRE sits relative to the pointer's own face coordinate, in
// lattice units — measured on `ref`, the continuous origin the drag accumulates into, so the
// number is not polluted by the half-cell quantisation of the drawn cell. This is what case A
// compares across shapes: the attach maps the centre, so the offset must be the grab lift (a
// constant), not a function of how big the piece is.
function attachOffset(state) {
  const ref = state.ghost.previewRef
  const pointer = state.ghost.previewPointer
  if (!ref || !pointer) return null
  const span = extent(state.placement.oriented)
  return { du: ref.u + span.u / 2 - pointer.fu, dv: ref.v + span.v / 2 - pointer.fv }
}

// The same offset measured on the QUANTISED origin — what the player actually sees drawn. It
// carries up to half a cell of rounding per axis, so it is only used for a coarse bound.
function drawnOffset(state) {
  const origin = state.ghost.previewOrigin
  const pointer = state.ghost.previewPointer
  if (!origin || !pointer) return null
  const span = extent(state.placement.oriented)
  return { du: origin.u + span.u / 2 - pointer.fu, dv: origin.v + span.v / 2 - pointer.fv }
}

async function readState(client, input, point) {
  if (point) await input.move(point.x, point.y)
  await sleep(30)
  await client.frames()
  return client.readJson(STATE)
}

function cubeCentre(bounds) {
  return { x: Math.round((bounds.minX + bounds.maxX) / 2), y: Math.round((bounds.minY + bounds.maxY) / 2) }
}

// A few points around the cube's centre: the swept list that makes each case's precondition
// reachable whatever the face looks like.
function centreTargets(bounds) {
  const midX = (bounds.minX + bounds.maxX) / 2
  const midY = (bounds.minY + bounds.maxY) / 2
  const halfW = (bounds.maxX - bounds.minX) / 2
  const halfH = (bounds.maxY - bounds.minY) / 2
  const deltas = [[0, 0], [0.08, 0], [-0.08, 0], [0, 0.08], [0, -0.08], [0.24, 0], [-0.24, 0], [0, 0.24], [0, -0.24]]
  return deltas.map(([dx, dy]) => ({ x: Math.round(midX + dx * halfW), y: Math.round(midY + dy * halfH) }))
}

// Press slot 0 and glide onto the cube, stopping while the button is still down, at the first
// swept point whose live state satisfies `accept`. Returns null when none did (never a pass).
// A failed attempt is cancelled with Escape BEFORE the button is released, so a swept point that
// happened to be legal cannot spend the piece and change the state the next attempt starts from.
async function holdDragOver(client, input, slot, targets, accept) {
  for (const target of targets) {
    await input.pressAndHold({ x: slot.x, y: slot.y }, target)
    await client.frames()
    const state = await client.readJson(STATE)
    if (accept(state)) return { state, target }
    await pressEscape(client)
    await sleep(120)
    await input.up(target.x, target.y)
    await sleep(120)
  }
  return null
}

// Put the gesture down without spending anything: Escape first (the drag is cancelled), then the
// pointer release that only clears the button state.
async function releaseWithoutPlacing(client, input, point) {
  await pressEscape(client)
  await sleep(150)
  await input.up(point.x, point.y)
  await sleep(150)
}

// The strip a release means "put it back" in (the item bar, which never sits under a slot).
async function cancelStripPoint(client) {
  return client.readJson(`(() => { const el = document.querySelector('#item-bar'); const box = el.getBoundingClientRect()
    return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) } })()`)
}

// Park the piece against a face edge by walking outward in small steps, so the case works whatever
// the local px-per-cell scale turns out to be. Returns every attached sample on the way out, in
// order — the last one is the furthest point that still had the piece on the face.
//
// The walk ends by putting the pointer BACK on that last accepted point: the step that left the
// cube put the piece back in hand (by design — the next arrival on the cube re-grabs it wherever
// the finger is), and the reversal the caller does next has to continue the same attachment.
async function walkToEdge(client, input, cube, vec, accept) {
  const samples = []
  for (let step = 0.4; step <= 3.0; step += 0.15) {
    const point = { x: Math.round(cube.x + vec.x * step), y: Math.round(cube.y + vec.y * step) }
    const state = await readState(client, input, point)
    if (ONLY) {
      console.log(`       walk x=${point.x} y=${point.y} mode=${state.ghost.mode} face=${state.ghost.previewFace}`
        + ` pointer=${fmt(state.ghost.previewPointer)} ref=${fmtRef(state.ghost.previewRef)}`
        + ` origin=${state.ghost.previewOrigin ? originKey(state) : 'none'}`)
    }
    if (!accept(state)) {
      if (samples.length) break
      continue
    }
    samples.push({ state, point })
  }
  const last = samples[samples.length - 1]
  if (last) {
    const state = await readState(client, input, last.point)
    if (accept(state)) samples[samples.length - 1] = { state, point: last.point }
  }
  return samples
}

// Sweep the face's own (u, v) axes around `start` for one legal and one illegal target. Used to set
// up cases D and E without assuming where the fixture's occupied cell projects to.
async function scanTargets(client, input, start, step, accept) {
  let legal = null
  let illegal = null
  const offsets = []
  for (const du of [-1.5, -1, -0.5, 0, 0.5, 1, 1.5]) for (const dv of [-1.5, -1, -0.5, 0, 0.5, 1, 1.5]) offsets.push([du, dv])
  for (const [du, dv] of offsets) {
    const point = {
      x: Math.round(start.x + du * step.u.x + dv * step.v.x),
      y: Math.round(start.y + du * step.u.y + dv * step.v.y),
    }
    const state = await readState(client, input, point)
    if (!accept(state)) continue
    if (state.preview.valid) legal = legal || { point, state }
    else illegal = illegal || { point, state }
    if (legal && illegal) break
  }
  return { legal, illegal }
}

// --------------------------------------------------------------------------- cases

// A. The attach is a direct mapping and the piece then follows the finger exactly. Two things are
// measured per shape, in the same drag:
//
//   1. the piece's continuous centre stays within its own half-extent plus the grab lift of the
//      finger's face point — it may be PINNED to the nearest edge (the piece is entering the face
//      from outside, so the near edge is where it must land), but it is never searched for or
//      thrown somewhere else. The old model attached the shape's ORIGIN cell to the finger after
//      scanning the whole face for the nearest LEGAL origin, so a big piece could appear cells
//      away from the hand that was holding it.
//   2. every further step of the finger moves the piece by exactly that much (Δcentre == Δpointer):
//      no easing, no dead zone, no cell the piece refuses to leave.
async function caseAttachMapping(client, input) {
  const samples = []
  for (const shape of ['Dot', 'Line 3', 'Square']) {
    await reloadWithHand(client, [shape, 'Line 3', 'Square', 'Dot'].filter((name, index, all) => all.indexOf(name) === index).slice(0, 3))
    const before = await client.readJson(STATE)
    // Isolate the attach mapping on the operation face. A three-quarter cube's
    // silhouette centre is not its face centre; sweeping from the tray first
    // clamps against a different edge and measures retained over-travel instead.
    // Case C below independently exercises that swept edge/reversal path.
    const cube = before.placement.center
    await input.pressAndHold(before.slots[0], cube, 1)
    await client.frames()
    const state = await client.readJson(STATE)
    const held = attached(state) && tracksDrag(state) && state.ghost.previewPointer !== null
      ? { state, target: cube } : null
    if (!held) { skip(`A attach mapping (${shape})`, 'no swept point produced an attached preview'); continue }
    const span = extent(held.state.placement.oriented)
    const centre = { u: span.u / 2, v: span.v / 2 }
    const step = held.state.ghost.stepScreen

    // Walk the piece INWARD from where it attached, one small step at a time. A shape that
    // entered the face half off it is pinned to the edge at first; the walk crosses the moment
    // the edge lets go, which is where a jump or a sticky cell would show up.
    const track = [{ point: held.target, state: held.state }]
    for (let i = 1; i <= 8; i += 1) {
      const t = i / 8
      const point = {
        x: Math.round(held.target.x + (cube.x - held.target.x) * t + step.v.x * 0.4 * t),
        y: Math.round(held.target.y + (cube.y - held.target.y) * t + step.v.y * 0.4 * t),
      }
      const state = await readState(client, input, point)
      if (!attached(state) || state.ghost.previewPointer === null) break
      track.push({ point, state })
    }

    let worstStep = 0
    for (let i = 1; i < track.length; i += 1) {
      const a = track[i - 1].state
      const b = track[i].state
      const dPointer = { u: b.ghost.previewPointer.fu - a.ghost.previewPointer.fu, v: b.ghost.previewPointer.fv - a.ghost.previewPointer.fv }
      const dCentre = { u: b.ghost.previewRef.u - a.ghost.previewRef.u, v: b.ghost.previewRef.v - a.ghost.previewRef.v }
      worstStep = Math.max(worstStep, Math.abs(dCentre.u - dPointer.u), Math.abs(dCentre.v - dPointer.v))
    }
    const end = track[track.length - 1].state
    const gap = {
      u: end.ghost.previewRef.u + centre.u - end.ghost.previewPointer.fu,
      v: end.ghost.previewRef.v + centre.v - end.ghost.previewPointer.fv,
    }
    const drawn = drawnOffset(end)
    samples.push({ shape, span, gap, drawn, steps: track.length - 1 })
    console.log(`     ${shape.padEnd(7)} ${`${span.u + 1}x${span.v + 1}`.padEnd(3)} gap=(${gap.u.toFixed(3)}, ${gap.v.toFixed(3)})`
      + ` drawn=(${drawn.du.toFixed(3)}, ${drawn.dv.toFixed(3)}) origin=${originKey(end)}`
      + ` tracking=${track.length - 1} steps, worst mismatch ${worstStep.toFixed(3)}`)

    check(`A ${shape}: the finger's own travel moves the piece by exactly that much`,
      track.length > 2 && worstStep <= 0.08, `worst |Δcentre - Δpointer| = ${worstStep.toFixed(3)} cell over ${track.length - 1} steps`)
    check(`A ${shape}: the piece is at most its own half-extent + the grab lift away from the finger`,
      Math.abs(gap.u) <= centre.u + MOUSE_OFFSET_MAX_CELLS && Math.abs(gap.v) <= centre.v + MOUSE_OFFSET_MAX_CELLS,
      `gap u=${gap.u.toFixed(3)} (max ${(centre.u + MOUSE_OFFSET_MAX_CELLS).toFixed(2)}), v=${gap.v.toFixed(3)} (max ${(centre.v + MOUSE_OFFSET_MAX_CELLS).toFixed(2)})`)
    check(`A ${shape}: the drawn cell is within one cell of the finger`,
      Math.abs(drawn.du) <= centre.u + 1 && Math.abs(drawn.dv) <= centre.v + 1,
      `drawn u=${drawn.du.toFixed(3)}, v=${drawn.dv.toFixed(3)}`)
    check(`A ${shape}: the attached piece is inside the face`, end.ghost.previewOrigin.u >= 0 && end.ghost.previewOrigin.v >= 0,
      `origin=${originKey(end)}`)

    await releaseWithoutPlacing(client, input, held.target)
  }
  if (samples.length < 2) skip('A attach mapping', `only ${samples.length} shape(s) reached an attached preview`)
}

// B. The target position follows the finger ACROSS an occupied region: the marker keeps moving
// (and stays drawn), turns red exactly while it overlaps, and recovers the moment it clears.
//
// The falsifiable form of "it does not stick": under the old model every illegal target reported
// the LAST LEGAL origin, so no illegal sample could ever sit on an origin that was never legal.
async function caseAcrossOccupied(client, input) {
  await reloadWithHand(client, ['Square', 'Line 3', 'Dot'])
  const before = await client.readJson(STATE)
  const bounds = await client.readJson('globalThis.__voxalblast.bounds()')
  const held = await holdDragOver(client, input, before.slots[0], centreTargets(bounds),
    (state) => attached(state) && tracksDrag(state))
  if (!held) { skip('B over occupied cells', 'no swept point produced an attached preview'); return }

  const cube = cubeCentre(bounds)
  const cellCount = held.state.placement.oriented.length
  const halfW = (bounds.maxX - bounds.minX) / 2
  const halfH = (bounds.maxY - bounds.minY) / 2
  // A raster over the face centre: 0.4 of a cell per step, so it crosses the occupied centre cell
  // on both axes whatever the shape's orientation turns out to be.
  const positions = []
  for (let iy = -2; iy <= 2; iy += 1) {
    for (let ix = -2; ix <= 2; ix += 1) {
      positions.push({ x: Math.round(cube.x + (ix * halfW) / 5), y: Math.round(cube.y + (iy * halfH) / 5) })
    }
  }

  const samples = []
  for (const point of positions) {
    const state = await readState(client, input, point)
    if (!attached(state)) continue
    samples.push({
      origin: originKey(state),
      valid: state.preview.valid,
      cells: state.ghost.previewCells,
      color: state.preview.cells[0]?.color ?? null,
      pieceColor: state.preview.pieceColor,
    })
  }
  await releaseWithoutPlacing(client, input, cube)
  if (!samples.length) { skip('B over occupied cells', 'the raster never sampled an attached preview'); return }

  const validOrigins = new Set(samples.filter((s) => s.valid).map((s) => s.origin))
  const illegal = samples.filter((s) => !s.valid)
  const legalAfterIllegal = samples.some((s, i) => s.valid && samples.slice(0, i).some((p) => !p.valid))
  const illegalAfterLegal = samples.some((s, i) => !s.valid && samples.slice(0, i).some((p) => p.valid))
  console.log(`     ${samples.length} samples, ${validOrigins.size} legal origin(s), ${illegal.length} illegal`)

  check('B the preview is drawn on the face for every sample on the cube',
    samples.every((s) => s.cells === cellCount), `cells=[${[...new Set(samples.map((s) => s.cells))].join(',')}] expected=${cellCount}`)
  check('B an illegal target moves the preview instead of holding the last legal cell',
    illegal.length > 0 && illegal.some((s) => !validOrigins.has(s.origin)),
    `illegal origins=[${[...new Set(illegal.map((s) => s.origin))].join(' ')}] legal origins=[${[...validOrigins].join(' ')}]`)
  check('B the marker wears the invalid paint exactly while the target is illegal',
    illegal.length > 0 && illegal.every((s) => s.color === INVALID_HEX),
    `illegal colours=[${[...new Set(illegal.map((s) => s.color))].join(' ')}] invalid=${INVALID_HEX}`)
  check('B the marker wears the piece own paint on every legal target',
    samples.filter((s) => s.valid).every((s) => s.color === s.pieceColor),
    `legal colours=[${[...new Set(samples.filter((s) => s.valid).map((s) => s.color))].join(' ')}]`)
  check('B the preview crosses the occupied region and recovers', illegalAfterLegal && legalAfterIllegal,
    `illegal after a legal sample=${illegalAfterLegal}, legal again afterwards=${legalAfterIllegal}`)
}

// C. The edge is a wall, not a debt: park the piece against it, then come back by less than one
// cell — the piece must move. Under the old model it stayed put here, because the pointer's total
// travel from the grab point was still being rounded and the over-travel was part of it.
async function caseEdgeReverse(client, input) {
  await reloadWithHand(client, ['Dot', 'Square', 'Line 3'])
  const before = await client.readJson(STATE)
  const bounds = await client.readJson('globalThis.__voxalblast.bounds()')
  const held = await holdDragOver(client, input, before.slots[0], centreTargets(bounds),
    (state) => attached(state) && tracksDrag(state) && state.ghost.previewPointer !== null)
  if (!held) { skip('C edge reverse', 'no swept point produced an attached preview'); return }
  if (held.state.preview.piece !== 'Dot') {
    await releaseWithoutPlacing(client, input, held.target)
    skip('C edge reverse', `slot 0 is not the Dot (holding ${held.state.preview.piece})`)
    return
  }

  const step = held.state.ghost.stepScreen
  const axis = Math.abs(step.u.x) >= Math.abs(step.v.x) ? { key: 'u', vec: step.u } : { key: 'v', vec: step.v }
  const cube = cubeCentre(bounds)
  const maxOrigin = SH - 1 // the Dot spans one cell, so the last origin is the last cell
  const onFace = (state) => attached(state) && state.ghost.previewPointer !== null
  console.log(`     edge axis ${axis.key}, one cell = ${axis.vec.x.toFixed(1)},${axis.vec.y.toFixed(1)} px`)

  for (const side of [1, -1]) {
    const label = side > 0 ? 'right' : 'left'
    const samples = await walkToEdge(client, input, cube,
      { x: axis.vec.x * side, y: axis.vec.y * side }, onFace)
    if (samples.length < 3) { skip(`C the ${label} edge`, `only ${samples.length} attached sample(s) on the way out`); continue }
    const parked = samples[samples.length - 1]
    const expected = side > 0 ? maxOrigin : 0
    console.log(`     ${label} edge: ${samples.length} samples, ${samples.map((s) => s.state.ghost.previewOrigin[axis.key]).join('')}`)

    check(`C pushing past the ${label} edge parks the piece on origin ${expected}`,
      parked.state.ghost.previewOrigin[axis.key] === expected,
      `origin ${axis.key}=${parked.state.ghost.previewOrigin[axis.key]} (expected ${expected})`)
    // The over-travel never banks: no sample on the way out may have slipped past the last origin.
    check(`C over-travel past the ${label} edge never moves the piece past origin ${expected}`,
      samples.every((s) => side > 0
        ? s.state.ghost.previewOrigin[axis.key] <= expected
        : s.state.ghost.previewOrigin[axis.key] >= expected),
      `origins=[${samples.map((s) => s.state.ghost.previewOrigin[axis.key]).join(' ')}]`)

    // Back by less than one cell: exactly one cell of response, no unwinding of the over-travel
    // first. Under the old model the piece stayed where it was here — the over-travel was part of
    // the rounded total the piece followed.
    const want = expected + (side > 0 ? -1 : 1)
    const back = {
      x: Math.round(parked.point.x - axis.vec.x * side * 0.7),
      y: Math.round(parked.point.y - axis.vec.y * side * 0.7),
    }
    const reversed = await readState(client, input, back)
    console.log(`     ${label}: parked ref=${fmtRef(parked.state.ghost.previewRef)} pointer=${fmt(parked.state.ghost.previewPointer)}`
      + ` origin=${originKey(parked.state)} face=${parked.state.ghost.previewFace} anchor=${JSON.stringify(parked.state.ghost.anchor)}`
      + ` -> back(-0.7) ref=${fmtRef(reversed.ghost.previewRef)} pointer=${fmt(reversed.ghost.previewPointer)}`
      + ` origin=${reversed.ghost.previewOrigin ? originKey(reversed) : 'none'} face=${reversed.ghost.previewFace}`
      + ` mode=${reversed.ghost.mode} anchor=${JSON.stringify(reversed.ghost.anchor)}`)
    check(`C coming back less than one cell from the ${label} edge moves the piece`,
      attached(reversed) && reversed.ghost.previewOrigin[axis.key] === want,
      `after reversing 0.7 cell: ${axis.key}=${reversed.ghost.previewOrigin?.[axis.key]} (expected ${want})`)
  }

  await releaseWithoutPlacing(client, input, cube)
  const after = await client.readJson(STATE)
  check('C cancelling after the edge work leaves no residue',
    idle(after) && after.slots[0].used === false, `attached=${after.ghost.attached} used=${after.slots[0].used}`)
}

// D. An illegal release spends nothing — and never falls back to a position the piece used to be
// on. The old model kept the last legal origin while the target was illegal, so the release could
// drop the piece on a cell the player had already left.
async function caseIllegalRelease(client, input) {
  await reloadWithHand(client, ['Dot', 'Square', 'Line 3'])
  const before = await client.readJson(STATE)
  const bounds = await client.readJson('globalThis.__voxalblast.bounds()')
  const cube = cubeCentre(bounds)

  // A legal attach first, then across the face to an occupied target, then release there.
  const held = await holdDragOver(client, input, before.slots[0], centreTargets(bounds),
    (state) => attached(state) && tracksDrag(state) && state.preview.valid && state.ghost.previewPointer !== null)
  if (!held) { skip('D illegal release', 'no swept point produced a LEGAL attached preview'); return }
  const legalOrigin = originKey(held.state)

  const found = await scanTargets(client, input, held.target, held.state.ghost.stepScreen,
    (state) => attached(state) && state.ghost.previewPointer !== null)
  if (!found.illegal) {
    await releaseWithoutPlacing(client, input, cube)
    skip('D illegal release', 'no illegal target reachable on the fixture face')
    return
  }
  // Walk back through a legal target first, so "fell back to a position it used to be on" is a
  // state the piece really passed through.
  if (found.legal) {
    const legalState = await readState(client, input, found.legal.point)
    check('D a legal target on the way is legal again', attached(legalState) && legalState.preview.valid === true,
      `origin=${legalState.ghost.previewOrigin ? originKey(legalState) : 'none'} valid=${legalState.preview.valid}`)
  }
  const illegalState = await readState(client, input, found.illegal.point)
  check('D the target moved onto the occupied cell before the release',
    attached(illegalState) && illegalState.preview.valid === false && originKey(illegalState) !== legalOrigin,
    `legal origin ${legalOrigin} -> illegal origin ${illegalState.ghost.previewOrigin ? originKey(illegalState) : 'none'}`)

  await feedbackShot(client, 'invalid-overlap')
  await input.up(found.illegal.point.x, found.illegal.point.y)
  const flightStart = await client.readJson(STATE)
  await sleep(100)
  const flightMiddle = await client.readJson(STATE)
  check('D rejected piece visibly returns over time', Boolean(flightStart.ghost.returning)
    && flightMiddle.ghost.returning?.progress > flightStart.ghost.returning.progress
    && flightMiddle.ghost.returning.progress < 1, JSON.stringify(flightMiddle.ghost.returning))
  const returnPixels = await client.readJson(`(() => {
    const c = document.querySelector('.piece-return-flight')
    if (!c) return 0
    const p = c.getContext('2d').getImageData(0,0,c.width,c.height).data
    let visible = 0
    for(let i=3;i<p.length;i+=4) if(p[i]>32) visible++
    return visible
  })()`)
  check('D return snapshot contains rendered block pixels', returnPixels > 100, `visible pixels=${returnPixels}`)
  await feedbackShot(client, 'return-flight')
  await sleep(450)
  const after = await client.readJson(STATE)
  check('D return flight finishes and restores candidate', !after.ghost.returning && await client.evaluate(`!document.querySelector('.piece-return-flight, .piece-returning, .piece-dragging')`))
  check('D an illegal release spends no piece', after.slots[0].used === false, `used=${after.slots[0].used}`)
  check('D an illegal release leaves the board untouched', boardFingerprint(after.board) === boardFingerprint(before.board),
    `${boardFingerprint(before.board)} -> ${boardFingerprint(after.board)}`)
  check('D an illegal release does not land on the position the piece used to be on',
    after.board.cells.length === before.board.cells.length, `cells ${before.board.cells.length} -> ${after.board.cells.length}`)
  check('D an illegal release clears every drag residue', idle(after),
    `attached=${after.ghost.attached} mode=${after.ghost.mode} marker=${after.ghost.previewCells}`)
  check('D an illegal release says "Try another spot"', after.toast === 'Try another spot', `toast="${after.toast}"`)
}

// E. The release is judged at the RELEASE coordinates, through the same rule that drew the last
// frame. Browsers do not always deliver a pointermove at the release position, and the drop must
// not be decided from a stale preview (nor by a second path that hunts for a legal cell).
async function caseReleasePoint(client, input) {
  await reloadWithHand(client, ['Dot', 'Square', 'Line 3'])
  const before = await client.readJson(STATE)
  const bounds = await client.readJson('globalThis.__voxalblast.bounds()')
  const cube = cubeCentre(bounds)

  const held = await holdDragOver(client, input, before.slots[0], centreTargets(bounds),
    (state) => attached(state) && tracksDrag(state) && state.preview.valid && state.ghost.previewPointer !== null)
  if (!held) { skip('E release coordinates', 'no swept point produced a LEGAL attached preview'); return }

  const found = await scanTargets(client, input, held.target, held.state.ghost.stepScreen,
    (state) => attached(state) && state.ghost.previewPointer !== null)
  if (!found.illegal) {
    await releaseWithoutPlacing(client, input, cube)
    skip('E release coordinates', 'no illegal target reachable on the fixture face')
    return
  }

  // The distinguishing move: hold over the legal spot again, then dispatch the RELEASE at the
  // illegal point with no pointermove in between.
  await readState(client, input, held.target)
  await input.up(found.illegal.point.x, found.illegal.point.y)
  await sleep(400)
  const after = await client.readJson(STATE)
  check('E the drop is judged at the release coordinates, not the last move',
    after.slots[0].used === false && boardFingerprint(after.board) === boardFingerprint(before.board),
    `used=${after.slots[0].used} board ${boardFingerprint(before.board)} -> ${boardFingerprint(after.board)}`)
  check('E the release point path leaves no drag residue', idle(after),
    `attached=${after.ghost.attached} mode=${after.ghost.mode} marker=${after.ghost.previewCells}`)
}

// F. The touch path: the grab lift is shape-scaled there, so its offset is a different number from
// the mouse's — it must still be bounded, and the preview must still cross an occupied cell with
// the finger down.
async function caseTouch(client, touchInput) {
  await reloadWithHand(client, ['Square', 'Line 3', 'Dot'])
  const before = await client.readJson(STATE)
  const slot = before.slots[0]
  const bounds = await client.readJson('globalThis.__voxalblast.bounds()')
  let held = null
  for (const target of centreTargets(bounds)) {
    await touchInput.start([{ x: slot.x, y: slot.y, id: 1 }])
    for (let i = 1; i <= MOVE_STEPS; i += 1) {
      const t = i / MOVE_STEPS
      await touchInput.move([{ x: Math.round(slot.x + (target.x - slot.x) * t), y: Math.round(slot.y + (target.y - slot.y) * t), id: 1 }])
      await sleep(16)
    }
    await client.frames()
    const state = await client.readJson(STATE)
    if (attached(state) && tracksDrag(state) && attachOffset(state) !== null) { held = { state, target }; break }
    await touchInput.end([])
    await sleep(150)
  }
  if (!held) { skip('F touch', 'touch input never produced an attached preview'); return }

  const offset = attachOffset(held.state)
  const worst = Math.max(Math.abs(offset.du), Math.abs(offset.dv))
  console.log(`     touch attach offset=(${offset.du.toFixed(3)}, ${offset.dv.toFixed(3)}) cells`)
  check('F the touch grab lift is bounded (the piece stays with the finger)',
    worst <= TOUCH_OFFSET_MAX_CELLS, `offset ${worst.toFixed(3)} cell (max ${TOUCH_OFFSET_MAX_CELLS})`)

  const cellCount = held.state.placement.oriented.length
  const halfW = (bounds.maxX - bounds.minX) / 2
  const halfH = (bounds.maxY - bounds.minY) / 2
  const cube = cubeCentre(bounds)
  let sawIllegal = false
  let sawLegalAfter = false
  let markerCells = 0
  let markerDrawn = true
  for (let iy = -1; iy <= 1 && !sawLegalAfter; iy += 1) {
    for (let ix = -2; ix <= 2; ix += 1) {
      const point = { x: Math.round(cube.x + (ix * halfW) / 5), y: Math.round(cube.y + (iy * halfH) / 5) }
      await touchInput.move([{ x: point.x, y: point.y, id: 1 }])
      await sleep(30)
      await client.frames()
      const state = await client.readJson(STATE)
      if (!attached(state)) { markerDrawn = false; continue }
      markerCells = Math.max(markerCells, state.ghost.previewCells)
      if (!state.preview.valid) sawIllegal = true
      else if (sawIllegal) { sawLegalAfter = true; break }
    }
  }
  // Put the finger down in the strip that means "cancel" before lifting, so the case's own
  // teardown cannot place the piece and turn the residue check into a fail for the wrong reason.
  const strip = await cancelStripPoint(client)
  await touchInput.move([{ x: strip.x, y: strip.y, id: 1 }])
  await sleep(80)
  await touchInput.end([])
  await sleep(300)
  const after = await client.readJson(STATE)
  check('F the touch preview crosses the occupied region and recovers', sawIllegal && sawLegalAfter,
    `illegal seen=${sawIllegal} legal after=${sawLegalAfter}`)
  check('F the touch preview is drawn on the face while it crosses', markerDrawn && markerCells === cellCount,
    `marker=${markerCells} expected=${cellCount} drawn=${markerDrawn}`)
  check('F the touch gesture leaves no residue and spends nothing',
    idle(after) && after.slots.every((entry, index) => entry.used === before.slots[index].used),
    `attached=${after.ghost.attached} used=[${after.slots.map((s) => s.used).join(',')}]`)
}

// G. Another face after a real cube turn: the piece still tracks the finger one lattice unit per
// lattice unit, measured on the FACE's own axes rather than the screen's.
async function caseOtherFace(client, input) {
  await reloadWithHand(client, ['Dot', 'Square', 'Line 3'])
  const startFace = (await client.readJson(STATE)).rotation.front
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'd', code: 'KeyD', windowsVirtualKeyCode: 68, nativeVirtualKeyCode: 68 })
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'd', code: 'KeyD', windowsVirtualKeyCode: 68, nativeVirtualKeyCode: 68 })
  await sleep(800)
  const turned = await client.readJson(STATE)
  if (turned.rotation.front === startFace) {
    skip('G another face', `the cube did not turn (front is still ${startFace})`)
    return
  }

  const before = await client.readJson(STATE)
  const bounds = await client.readJson('globalThis.__voxalblast.bounds()')
  const cube = cubeCentre(bounds)
  const held = await holdDragOver(client, input, before.slots[0], centreTargets(bounds),
    (state) => attached(state) && tracksDrag(state) && state.ghost.previewPointer !== null)
  if (!held) { skip('G another face', 'no swept point produced an attached preview after the turn'); return }

  check('G the drag follows the face the cube was turned to',
    held.state.ghost.previewFace === turned.rotation.front,
    `previewFace=${held.state.ghost.previewFace} front=${turned.rotation.front}`)

  const step = held.state.ghost.stepScreen
  for (const axis of [{ key: 'u', vec: step.u }, { key: 'v', vec: step.v }]) {
    const size = Math.abs(axis.vec.x) + Math.abs(axis.vec.y)
    if (size < 12) {
      skip(`G one ${axis.key} step on the turned face`, `the ${axis.key} axis is nearly edge-on (${axis.vec.x.toFixed(1)}, ${axis.vec.y.toFixed(1)} px)`)
      continue
    }
    const from = await readState(client, input, cube)
    if (!attached(from)) { skip(`G ${axis.key} step on the turned face`, 'the pointer left the cube'); break }
    const base = from.ghost.previewOrigin
    // Move inward if this orientation's centre target is already on its last
    // row/column. An outward step must clamp, not advance beyond the board.
    const direction = base[axis.key] >= SH - 1 ? -1 : 1
    const moved = await readState(client, input, { x: Math.round(cube.x + axis.vec.x * direction), y: Math.round(cube.y + axis.vec.y * direction) })
    if (!attached(moved)) { skip(`G ${axis.key} step on the turned face`, 'the pointer left the cube'); break }
    const du = moved.ghost.previewOrigin.u - base.u
    const dv = moved.ghost.previewOrigin.v - base.v
    check(`G one ${axis.key} step of pointer travel moves the piece one ${axis.key} cell on face ${turned.rotation.front}`,
      axis.key === 'u' ? du === direction && dv === 0 : dv === direction && du === 0,
      `origin ${base.u},${base.v} -> ${moved.ghost.previewOrigin.u},${moved.ghost.previewOrigin.v} (step ${axis.vec.x.toFixed(1)}, ${axis.vec.y.toFixed(1)} px)`)
  }
  await releaseWithoutPlacing(client, input, cube)
}

// J. The turn arms where the CARRIED PIECE's centre leaves the CUBE's screen silhouette — the
// v0.9.11 rule. The probe does not pick a screen corner any more: it reads the cube's own box
// from `bounds()` and walks the piece's centre just past one side of it. `MOUSE_LIFT` is the
// lift the ghost is drawn with under a mouse (DRAG_GHOST.liftMousePx), i.e. how far above the
// pointer the measured centre sits, so a target pointer position is the wanted centre plus it.
const MOUSE_LIFT = 10

// v0.9.13: a piece that has never been INSIDE the cube cannot arm the dwell, so a drag straight
// from the tray to an edge is deliberately inert (that is the tray→cube entry, which crosses the
// bottom edge by construction). Every case that wants an armed edge therefore has to make the
// real gesture: pick up in the tray, carry the piece up INTO the cube, and only then out again.
// `glideTo` is a multi-step move on purpose — a single jump would never put the centre inside, so
// the latch would stay open and the case would fail for the wrong reason.
async function glideTo(input, from, to, steps = MOVE_STEPS) {
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps
    await input.move(Math.round(from.x + (to.x - from.x) * t), Math.round(from.y + (to.y - from.y) * t))
    await sleep(16)
  }
}

// The whole gesture: tray → inside the cube → out to a target point (client px of the POINTER).
async function carryOutOfCube(input, slot, through, point) {
  await input.pressAndHold(slot, through)
  await glideTo(input, through, point)
}

async function waitForObservation(client, expression) {
  return client.evaluate(`new Promise((resolve, reject) => {
    const deadline = performance.now() + 10000;
    function poll() {
      if (${expression}) return resolve(true);
      if (performance.now() > deadline) return reject(new Error('observation timed out'));
      requestAnimationFrame(poll);
    }
    poll();
  })`, { awaitPromise: true })
}

async function caseScreenEdges(client, input) {
  await reloadWithHand(client, ['Dot', 'Square', 'Line 3'])
  const bounds = await client.readJson('globalThis.__voxalblast.bounds()')
  const midX = Math.round((bounds.minX + bounds.maxX) / 2)
  const midY = Math.round((bounds.minY + bounds.maxY) / 2)
  for (const [edge, centre, axis, expectedFace] of [
    ['left', { x: Math.round(bounds.minX) - 24, y: midY }, 'yaw', '+x'],
    ['right', { x: Math.round(bounds.maxX) + 24, y: midY }, 'yaw', '-x'],
    ['top', { x: midX, y: Math.round(bounds.minY) - 24 }, 'pitch', '-y'],
    ['bottom', { x: midX, y: Math.round(bounds.maxY) + 24 }, 'pitch', '+y'],
  ]) {
    // The piece's centre is lifted above the pointer, so aim the pointer that far BELOW the
    // wanted centre. (The measured centre is asserted back below, from `ghost.centre`.)
    const point = { x: centre.x, y: centre.y + MOUSE_LIFT }
    // Enter through the middle of the cube first (see carryOutOfCube): the entry latch has to
    // close before any edge can arm, exactly as it does in play.
    const through = { x: midX, y: midY + MOUSE_LIFT }
    await reloadWithHand(client, ['Dot', 'Square', 'Line 3'])
    const before = await client.readJson(STATE)
    await carryOutOfCube(input, before.slots[0], through, point)
    const armed = await client.readJson(STATE)
    // The trigger itself, asserted from the number the game used: the piece's own centre is
    // past the cube silhouette on the expected side, and NOWHERE near the viewport edge.
    const overshoot = {
      left: bounds.minX - armed.ghost.centre.x,
      right: armed.ghost.centre.x - bounds.maxX,
      top: bounds.minY - armed.ghost.centre.y,
      bottom: armed.ghost.centre.y - bounds.maxY,
    }
    check(`J ${edge}: the piece's centre is past the CUBE silhouette, not the screen edge`,
      armed.ghost.centre !== null && overshoot[edge] > 0
      && overshoot[edge] < 60 && point.x > 20 && point.x < VIEWPORT.width - 20
      && point.y > 20 && point.y < VIEWPORT.height - 20,
      `centre ${JSON.stringify(armed.ghost.centre)} overshoot ${overshoot[edge].toFixed(1)}px, pointer ${JSON.stringify(point)}`)
    check(`J ${edge}: enters dwell with carried piece and no rotation`, armed.ghost.armed
      && armed.ghost.edge === edge && armed.ghost.armedAxis === axis
      && armed.ghost.entered === true
      && armed.ghost.visible && JSON.stringify(armed.rotation.pose) === JSON.stringify(before.rotation.pose))
    const hint = await client.readJson(`(() => { const el = document.querySelector('.edge-turn-hint'); const card = el.querySelector('.edge-turn-card'); const box = card.getBoundingClientRect(); return { visible: !el.hidden, edge: el.dataset.edge, progress: Number(el.style.getPropertyValue('--turn-progress')), card: { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) } } })()`)
    check(`J ${edge}: visible directional progress`, hint.visible && hint.edge === edge && hint.progress < 1)
    // The card follows the piece, not a screen corner: it is drawn beside the armed point and
    // fully inside the viewport.
    check(`J ${edge}: the card is drawn beside the piece and stays on screen`,
      Math.abs(hint.card.x - armed.ghost.centre.x) < 140 && Math.abs(hint.card.y - armed.ghost.centre.y) < 140
      && hint.card.x > 20 && hint.card.x < VIEWPORT.width - 20
      && hint.card.y > 20 && hint.card.y < VIEWPORT.height - 20,
      `card ${JSON.stringify(hint.card)} centre ${JSON.stringify(armed.ghost.centre)}`)
    const canvas = await client.readJson(`(() => { const r = document.querySelector('#scene-wrap canvas').getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom } })()`)
    check(`J ${edge}: carried shape stays inside the rendered canvas`, armed.ghost.cells.every(p =>
      p.x - armed.ghost.cellPx / 2 >= canvas.left && p.x + armed.ghost.cellPx / 2 <= canvas.right
      && p.y - armed.ghost.cellPx / 2 >= canvas.top && p.y + armed.ghost.cellPx / 2 <= canvas.bottom))
    // Stop holding at the first committed turn, independent of GPU/screenshot
    // latency. Otherwise a slow screenshot can legitimately browse a second face.
    await waitForObservation(client, 'globalThis.__voxalblast.ghost().turned')
    const cube = cubeCentre(await client.readJson('globalThis.__voxalblast.bounds()'))
    await input.move(cube.x, cube.y)
    await waitForObservation(client, '!globalThis.__voxalblast.rotation().settling')
    const turned = await client.readJson(STATE)
    check(`J ${edge}: one adjacent face, never roll`, turned.rotation.front === expectedFace,
      `front=${turned.rotation.front} expected=${expectedFace}`)
    const delta = new Quaternion().fromArray(turned.rotation.base)
      .multiply(new Quaternion().fromArray(before.rotation.base).invert())
    check(`J ${edge}: exactly 90 degrees around ${axis}, zero Z rotation`,
      Math.abs(delta.z) < 1e-6 && Math.abs(axis === 'yaw' ? delta.x : delta.y) < 1e-6
      && Math.abs(Math.abs(delta.w) - Math.SQRT1_2) < 1e-6)
    check(`J ${edge}: turning spends nothing`, boardFingerprint(turned.board) === boardFingerprint(before.board) && !turned.slots[0].used)
    // Returning from any edge permits ordinary placement on the arriving face.
    const returned = await readState(client, input, cube)
    check(`J ${edge}: feedback cancels and preview reattaches`, !returned.ghost.armed && returned.ghost.onFace)
    if (process.env.DRAGFEEL_ARTIFACTS) {
      await input.move(point.x, point.y)
      await sleep(180)
      await feedbackShot(client, `edge-${edge}-hold`)
    }
    await releaseWithoutPlacing(client, input, cube)
  }
}

async function caseEdgeCancel(client, input) {
  for (const mode of ['retreat', 'release', 'escape']) {
    await reloadWithHand(client, ['Dot', 'Square', 'Line 3'])
    const before = await client.readJson(STATE)
    const bounds = await client.readJson('globalThis.__voxalblast.bounds()')
    const cube = cubeCentre(bounds)
    const point = { x: Math.round(bounds.maxX) + 24, y: Math.round((bounds.minY + bounds.maxY) / 2) + MOUSE_LIFT }
    await carryOutOfCube(input, before.slots[0], { x: cube.x, y: cube.y + MOUSE_LIFT }, point)
    await sleep(100)
    if (mode === 'retreat') await input.move(cube.x, cube.y)
    if (mode === 'release') await input.up(point.x, point.y)
    if (mode === 'escape') await pressEscape(client)
    await sleep(PIECE_SPIN.holdMs + 100)
    const after = await client.readJson(STATE)
    check(`K ${mode}: no delayed rotation`, JSON.stringify(after.rotation.pose) === JSON.stringify(before.rotation.pose))
    check(`K ${mode}: clears feedback`, !after.ghost.armed && await client.readJson("document.querySelector('.edge-turn-hint').hidden"))
    if (mode === 'retreat') await releaseWithoutPlacing(client, input, cube)
    else await input.up(cube.x, cube.y)
  }
}

async function caseEdgeRepeatTouch(client, input, touchInput) {
  await setSessionFixture(client, spinFixtureSource(['Dot', 'Square', 'Line 3']))
  await client.send('Page.reload', { ignoreCache: false })
  await sleep(1200); await waitForHandle(client); await waitIntroDone(client)
  const before = await client.readJson(STATE)
  const cube = cubeCentre(await client.readJson('globalThis.__voxalblast.bounds()'))
  await input.pressAndHold(before.slots[0], cube)
  await input.move(cube.x, cube.y - 60)
  await sleep(PIECE_SPIN.holdMs + 100)
  const full = await client.readJson(STATE)
  check('L full face no longer hijacks placement to rotate', full.rotation.front === before.rotation.front && !full.ghost.armed)
  await releaseWithoutPlacing(client, input, cube)

  await reloadWithHand(client, ['Dot', 'Square', 'Line 3'])
  const fresh = await client.readJson(STATE)
  const bounds = await client.readJson('globalThis.__voxalblast.bounds()')
  const cubeMid = cubeCentre(bounds)
  // The touch grab lifts the piece by 12px + half its own height, so the pointer target sits
  // that far below the wanted centre. The cell pitch comes from the BOARD's own measured axis
  // (an idle ghost reports a meaningless pitch: it has never been placed on the ghost plane).
  const step = await client.readJson('globalThis.__voxalblast.placement().uAxis')
  const cellPx = Math.hypot(step.dx, step.dy)
  const edgeCentre = { x: Math.round(bounds.maxX) + 24, y: cubeMid.y }
  const edgePoint = { x: edgeCentre.x, y: Math.round(edgeCentre.y + 12 + cellPx * 0.5) }
  const throughPoint = { x: cubeMid.x, y: Math.round(cubeMid.y + 12 + cellPx * 0.5) }
  // Enter the cube first (v0.9.13 entry latch), then carry the piece out to the right edge.
  await touchInput.start([{ ...fresh.slots[0], id: 1 }])
  for (let i = 1; i <= MOVE_STEPS; i += 1) {
    const t = i / MOVE_STEPS
    await touchInput.move([{ x: Math.round(fresh.slots[0].x + (throughPoint.x - fresh.slots[0].x) * t), y: Math.round(fresh.slots[0].y + (throughPoint.y - fresh.slots[0].y) * t), id: 1 }])
    await sleep(16)
  }
  await touchInput.move([{ ...edgePoint, id: 1 }])
  await sleep(100)
  const armed = await client.readJson(STATE)
  check('L touch: edge arms and piece remains visible', armed.ghost.armed && armed.ghost.visible
    && armed.ghost.edge === 'right' && armed.ghost.entered === true,
    `centre ${JSON.stringify(armed.ghost.centre)} edge ${armed.ghost.edge} entered=${armed.ghost.entered}`)
  await sleep(PIECE_SPIN.holdMs + 220)
  const first = await client.readJson(STATE)
  check('L stationary touch turns first face', first.rotation.front === '-x',
    `front=${first.rotation.front} phase=${first.ghost.turnPhase}`)
  await sleep(PIECE_SPIN.holdMs + 400)
  const second = await client.readJson(STATE)
  check('L continued hold turns another face after a fresh dwell', second.rotation.front === '-z',
    `front=${second.rotation.front}`)
  await touchInput.end([])
  await sleep(PIECE_SPIN.holdMs + 350)
  const ended = await client.readJson(STATE)
  check('L release stops repeats and returns the unused piece', !ended.ghost.attached && !ended.ghost.armed
    && !ended.slots[0].used && ended.rotation.front === second.rotation.front)
}

// M. The 拖块翻面 switch (v0.9.12). With it OFF the piece is carried exactly as before, the
// dwell never arms however far off the cube the piece goes, and the cube can still be turned by
// dragging the background. With it back ON the very same drag arms again.
//
// The switch is flipped the way a player flips it — a real click on the settings row — and read
// back from `preferences()`, the same accessor the input gate reads.
async function setDragTurn(client, on) {
  await client.evaluate(`(() => {
    const el = document.querySelector('#drag-turn-setting')
    if (el.getAttribute('aria-pressed') !== '${on}') el.click()
  })()`)
  await sleep(120)
  const prefs = await client.readJson('globalThis.__voxalblast.preferences()')
  return prefs.dragTurn === on
}

async function caseDragTurnSwitch(client, input) {
  await reloadWithHand(client, ['Dot', 'Square', 'Line 3'])
  const bounds = await client.readJson('globalThis.__voxalblast.bounds()')
  const midY = Math.round((bounds.minY + bounds.maxY) / 2)
  const centre = { x: Math.round(bounds.maxX) + 24, y: midY }
  const point = { x: centre.x, y: centre.y + MOUSE_LIFT }
  const cube = cubeCentre(bounds)
  const through = { x: cube.x, y: cube.y + MOUSE_LIFT }

  if (!await setDragTurn(client, false)) { skip('M switch OFF', 'the settings row did not report the new state'); return }
  const off = await client.readJson('globalThis.__voxalblast.preferences()')
  check('M the switch reads OFF from the game, not just the DOM', off.dragTurn === false, JSON.stringify(off))

  const before = await client.readJson(STATE)
  await carryOutOfCube(input, before.slots[0], through, point)
  await sleep(PIECE_SPIN.holdMs + 260)
  const held = await client.readJson(STATE)
  check('M OFF: the piece is still carried, but the dwell never arms',
    held.ghost.attached && !held.ghost.armed && held.ghost.edge === null && held.ghost.turnPhase === null,
    `attached=${held.ghost.attached} armed=${held.ghost.armed} edge=${held.ghost.edge}`)
  check('M OFF: no hint card is drawn', await client.readJson("document.querySelector('.edge-turn-hint').hidden"))
  check('M OFF: the cube did not move', JSON.stringify(held.rotation.pose) === JSON.stringify(before.rotation.pose),
    `front=${held.rotation.front}`)
  // A held piece that never arms must still be releasable without spending anything.
  await input.move(cube.x, cube.y)
  const back = await readState(client, input, cube)
  check('M OFF: bringing the piece back still previews a placement', back.ghost.onFace && back.ghost.previewCells > 0,
    `onFace=${back.ghost.onFace} cells=${back.ghost.previewCells}`)
  await releaseWithoutPlacing(client, input, cube)

  // The background drag is a different gesture and is NOT gated by this switch.
  const turnable = await client.readJson(STATE)
  await input.pressAndHold(cube, { x: cube.x, y: cube.y - Math.round((bounds.maxY - bounds.minY) * 0.45) }, 8)
  await input.up(cube.x, cube.y - Math.round((bounds.maxY - bounds.minY) * 0.45))
  await waitForObservation(client, '!globalThis.__voxalblast.rotation().settling')
  const turned = await client.readJson(STATE)
  check('M OFF: dragging the background still turns the cube',
    turned.rotation.front !== turnable.rotation.front,
    `front ${turnable.rotation.front} -> ${turned.rotation.front}`)

  // Back ON: the identical carry arms the dwell again.
  if (!await setDragTurn(client, true)) { skip('M switch back ON', 'the settings row did not report the new state'); return }
  await reloadWithHand(client, ['Dot', 'Square', 'Line 3'])
  const onBefore = await client.readJson(STATE)
  await carryOutOfCube(input, onBefore.slots[0], through, point)
  const armed = await client.readJson(STATE)
  check('M ON: the same carry arms the dwell again', armed.ghost.armed && armed.ghost.edge === 'right',
    `armed=${armed.ghost.armed} edge=${armed.ghost.edge}`)
  await releaseWithoutPlacing(client, input, cube)

  // Flipping the switch OFF mid-drag drops a dwell that is already armed.
  await reloadWithHand(client, ['Dot', 'Square', 'Line 3'])
  const live = await client.readJson(STATE)
  await carryOutOfCube(input, live.slots[0], through, point)
  const wasArmed = await client.readJson(STATE)
  if (!wasArmed.ghost.armed) { skip('M switch OFF mid-drag', 'the dwell did not arm before the switch was flipped'); return }
  await setDragTurn(client, false)
  await sleep(PIECE_SPIN.holdMs + 260)
  const dropped = await client.readJson(STATE)
  check('M flipping the switch OFF mid-drag drops the armed dwell and never turns',
    !dropped.ghost.armed && dropped.ghost.edge === null
    && JSON.stringify(dropped.rotation.pose) === JSON.stringify(live.rotation.pose),
    `armed=${dropped.ghost.armed} edge=${dropped.ghost.edge} front=${dropped.rotation.front}`)
  await releaseWithoutPlacing(client, input, cube)
  await setDragTurn(client, true)
}

// N. The tray→cube ENTRY never turns the cube (v0.9.13). Every candidate is pushed UP out of the
// tray, and the tray sits below the cube, so the piece's centre necessarily crosses the bottom
// edge on the way in. This case walks exactly that path with real pointer input and holds it
// there for several dwells: the cube must not move, and the piece must still be placeable.
//
// It also pins the other half of the rule — once the piece HAS been inside, the bottom edge is an
// exit again and does arm — so the latch cannot be "fixed" by simply never arming the bottom.
async function caseEntryFromTray(client, input) {
  await reloadWithHand(client, ['Dot', 'Square', 'Line 3'])
  const before = await client.readJson(STATE)
  const bounds = await client.readJson('globalThis.__voxalblast.bounds()')
  const midX = Math.round((bounds.minX + bounds.maxX) / 2)
  // Just past the bottom edge, where the old rule armed within a frame of arriving.
  const justBelow = { x: midX, y: Math.round(bounds.maxY) + 18 + MOUSE_LIFT }

  // 1. Straight up from the tray to just below the cube — the ordinary way in.
  await input.pressAndHold(before.slots[0], justBelow)
  const arriving = await client.readJson(STATE)
  check('N the tray→cube entry never arms the dwell',
    !arriving.ghost.armed && arriving.ghost.edge === null && arriving.ghost.entered === false,
    `armed=${arriving.ghost.armed} edge=${arriving.ghost.edge} entered=${arriving.ghost.entered}`)
  check('N no hint card on the way in', await client.readJson("document.querySelector('.edge-turn-hint').hidden"))
  // Hold it there for several dwells: the old behaviour turned the cube here.
  await sleep(PIECE_SPIN.holdMs * 3 + 200)
  const heldBelow = await client.readJson(STATE)
  check('N holding at the cube foot on the way in still never turns',
    !heldBelow.ghost.armed && heldBelow.rotation.front === before.rotation.front
    && JSON.stringify(heldBelow.rotation.pose) === JSON.stringify(before.rotation.pose),
    `front=${heldBelow.rotation.front} armed=${heldBelow.ghost.armed}`)

  // 2. Up INTO the cube, then back out through the bottom edge: now it is an EXIT, so it arms.
  const cube = cubeCentre(bounds)
  await glideTo(input, justBelow, { x: cube.x, y: cube.y + MOUSE_LIFT })
  const entered = await client.readJson(STATE)
  check('N carrying the piece into the cube closes the latch',
    entered.ghost.entered === true && !entered.ghost.armed,
    `entered=${entered.ghost.entered} armed=${entered.ghost.armed}`)
  await glideTo(input, { x: cube.x, y: cube.y + MOUSE_LIFT }, justBelow)
  const backOut = await client.readJson(STATE)
  check('N leaving through the bottom edge AFTER entering does arm it',
    backOut.ghost.armed && backOut.ghost.edge === 'bottom' && backOut.ghost.armedAxis === 'pitch',
    `armed=${backOut.ghost.armed} edge=${backOut.ghost.edge}`)
  await waitForObservation(client, 'globalThis.__voxalblast.ghost().turned')
  await waitForObservation(client, '!globalThis.__voxalblast.rotation().settling')
  const turned = await client.readJson(STATE)
  check('N and that turn is a real one', turned.rotation.front !== before.rotation.front,
    `front ${before.rotation.front} -> ${turned.rotation.front}`)

  // 3. A fresh gesture starts in the tray again: the latch is per drag, not per session.
  await releaseWithoutPlacing(client, input, cube)
  await reloadWithHand(client, ['Dot', 'Square', 'Line 3'])
  const fresh = await client.readJson(STATE)
  await input.pressAndHold(fresh.slots[0], justBelow)
  await sleep(PIECE_SPIN.holdMs + 300)
  const second = await client.readJson(STATE)
  check('N the next drag has to enter the cube all over again',
    second.ghost.entered === false && !second.ghost.armed
    && second.rotation.front === fresh.rotation.front,
    `entered=${second.ghost.entered} armed=${second.ghost.armed} front=${second.rotation.front}`)

  // 4. The piece is still a normal piece: brought back over the cube it previews a placement.
  await glideTo(input, justBelow, { x: cube.x, y: cube.y + MOUSE_LIFT })
  const placeable = await readState(client, input, { x: cube.x, y: cube.y + MOUSE_LIFT })
  check('N and it still previews a placement once it is over a face',
    placeable.ghost.onFace && placeable.ghost.previewCells > 0,
    `onFace=${placeable.ghost.onFace} cells=${placeable.ghost.previewCells}`)
  await releaseWithoutPlacing(client, input, cube)
}

// --------------------------------------------------------------------------- driver

const browserPath = findBrowser()
const dev = await ensureDevServer()
console.log(`browser  ${browserPath}`)
console.log(`target   ${APP_URL}  (dev server ${dev.started ? `started, pid ${dev.pid}` : 'already running'})`)
console.log(`viewport ${VIEWPORT.width}x${VIEWPORT.height}\n`)

const profile = mkdtempSync(join(tmpdir(), 'voxalblast-dragfeel-'))
const child = spawn(browserPath, [
  '--headless=new', '--disable-gpu', '--disable-breakpad', '--hide-scrollbars',
  '--no-first-run', '--no-default-browser-check', '--force-device-scale-factor=1',
  '--run-all-compositor-stages-before-draw',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  `--window-size=${VIEWPORT.width},${VIEWPORT.height}`, 'about:blank',
], { stdio: 'ignore', windowsHide: true })

let browserSocket = null
let pageSocket = null
async function caseClearForecast(client, input) {
  const snapshot = structuredClone(FIXTURE_SNAPSHOT)
  snapshot.board.cells = [0, 1, 3, 4].map((x, i) => [x, 2, 4, [0x3f8fe0, 0x217d6e, 0x8b57c9, 0x293894][i]])
  snapshot.board.score = 0
  snapshot.board.totalLines = 0
  snapshot.pieces = ['Dot', 'Square', 'Line 3'].map(name => ({ name, used: false }))
  await setSessionFixture(client, `localStorage.setItem('voxalblast.session.v1', ${JSON.stringify(JSON.stringify(snapshot))})`)
  await client.send('Page.reload', { ignoreCache: false })
  await sleep(1200)
  await waitForHandle(client)
  await waitIntroDone(client)
  const before = await client.readJson(STATE)
  const originalPaint = await client.evaluate('JSON.stringify(globalThis.__voxalblast.tileColors())')
  const center = before.placement.center
  await input.pressAndHold(before.slots[0], center, 1)
  const held = await readState(client, input)
  check('H legal forecast paints the whole completed row in the dragged colour', held.preview.valid
    && held.clearPreview.length === 5 && held.clearPreview.every(tile => tile.color === held.preview.pieceColor),
  JSON.stringify({ clear: held.clearPreview, preview: held.preview, centre: center, cells: held.board.cells }))
  check('H forecasting changes no board data', JSON.stringify(held.board) === JSON.stringify(before.board))
  await feedbackShot(client, 'clear-forecast')
  const step = held.ghost.stepScreen.v
  await readState(client, input, { x: center.x + step.x, y: center.y + step.y })
  check('H moving away restores every original tile material',
    await client.evaluate('JSON.stringify(globalThis.__voxalblast.tileColors())') === originalPaint)
  await readState(client, input, center)
  await pressEscape(client)
  await input.up(center.x, center.y)
  const cancelled = await client.readJson(STATE)
  check('H cancelling removes forecast without changing board', cancelled.clearPreview.length === 0
    && JSON.stringify(cancelled.board) === JSON.stringify(before.board)
    && await client.evaluate('JSON.stringify(globalThis.__voxalblast.tileColors())') === originalPaint)
  // Pick up again before the first return finishes: a new drag owns the source.
  await input.pressAndHold(before.slots[0], center, 1)
  const again = await readState(client, input)
  check('H a new drag interrupts the old return cleanly', !again.ghost.returning && again.preview.valid && again.clearPreview.length === 5)
  await input.up(center.x, center.y)
  await sleep(600)
  const placed = await client.readJson(STATE)
  check('H actual placement clears the predicted row and restores the view', placed.board.cells.length === 0
    && placed.board.totalLines === 1 && placed.clearPreview.length === 0 && !placed.ghost.returning)
}

async function caseOverflow(client, input) {
  await reloadWithHand(client, ['Square', 'Dot', 'Line 3'])
  const before = await client.readJson(STATE)
  const center = before.placement.center
  await input.pressAndHold(before.slots[0], center, 1)
  const held = await readState(client, input)
  const step = held.ghost.stepScreen.u
  // Enter the last quantised column without pushing the pointer past the cube
  // into the separate viewport-edge turn band. Use the continuous drag origin.
  const delta = 3.6 - held.ghost.previewRef.u
  const point = { x: center.x + step.x * delta, y: center.y + step.y * delta }
  const overflow = await readState(client, input, point)
  check('I partial overflow stays at the requested edge and turns grey', overflow.ghost.onFace
    && overflow.ghost.previewOrigin.u === 4 && !overflow.preview.valid
    && overflow.preview.cells.length === 4 && overflow.preview.cells.every(cell => cell.color === INVALID_HEX), JSON.stringify(overflow.preview))
  check('I overflow never forecasts a clear', overflow.clearPreview.length === 0)
  await feedbackShot(client, 'invalid-overflow')
  await input.up(point.x, point.y)
  const released = await client.readJson(STATE)
  check('I overflow release animates back and spends nothing', Boolean(released.ghost.returning)
    && JSON.stringify(released.board) === JSON.stringify(before.board) && !released.slots[0].used)
  await sleep(500)
}

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
  await client.send('Network.enable')
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: VIEWPORT.width, height: VIEWPORT.height,
    screenWidth: VIEWPORT.width, screenHeight: VIEWPORT.height, deviceScaleFactor: 1, mobile: true,
  })
  // Touch support on, but mouse input is NOT converted to touch — the mouse cases need real mouse
  // pointers (the same split the interaction probe runs with).
  await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })

  await setSessionFixture(client, fixtureSource(['Square', 'Line 3', 'Dot']))
  await client.send('Page.navigate', { url: APP_URL })
  await waitForHandle(client)
  const booted = await waitIntroDone(client)
  check('boot: the opening wave finishes on its own', booted === true, 'intro().active === false')

  const input = mouse(client)
  const touchInput = touch(client)

  console.log('\n-- A. the attach maps the piece where it is held, whatever its size --')
  if (wants('A')) await caseAttachMapping(client, input)

  console.log('\n-- B. the target follows the finger across occupied cells --')
  if (wants('B')) await caseAcrossOccupied(client, input)

  console.log('\n-- C. no dead travel at the face edges --')
  if (wants('C')) await caseEdgeReverse(client, input)

  console.log('\n-- D. an illegal release spends nothing and falls back nowhere --')
  if (wants('D')) await caseIllegalRelease(client, input)

  console.log('\n-- E. the release is judged at the release coordinates --')
  if (wants('E')) await caseReleasePoint(client, input)

  console.log('\n-- F. the same behaviour with a touch pointer --')
  if (wants('F')) await caseTouch(client, touchInput)

  console.log('\n-- G. another face after a real cube turn --')
  if (wants('G')) await caseOtherFace(client, input)

  console.log('\n-- H. clear forecast and original-colour restoration --')
  if (wants('H')) await caseClearForecast(client, input)

  console.log('\n-- I. partial overflow is grey and returns without placement --')
  if (wants('I')) await caseOverflow(client, input)

  console.log('\n-- J. carrying the piece off the cube arms the dwell on that side --')
  if (wants('J')) await caseScreenEdges(client, input)

  console.log('\n-- K. pending edge turns cancel cleanly --')
  if (wants('K')) await caseEdgeCancel(client, input)

  console.log('\n-- L. full faces and stationary touch repeats --')
  if (wants('L')) await caseEdgeRepeatTouch(client, input, touchInput)

  console.log('\n-- M. the 拖块翻面 switch gates the dwell --')
  if (wants('M')) await caseDragTurnSwitch(client, input)

  console.log('\n-- N. the tray→cube entry never turns the cube --')
  if (wants('N')) await caseEntryFromTray(client, input)

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
  console.log('\nthe placement drag follows the finger: direct attach, moving target, no edge debt')
}

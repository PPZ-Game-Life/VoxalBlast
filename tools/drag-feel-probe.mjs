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
//   J cube turn        on a face that takes the piece NOWHERE the drag turns the cube instead
//                      (v0.9.3): armed on arrival, one axis claimed on the push, the pose turned
//                      with the button still down, the piece re-attached to the arriving face —
//                      and NOT turned again on a face that does take it
//   K pinned push      and on ANY face (v0.9.4): a piece that has stopped following the finger
//                      (parked against a face edge) arms nothing while it still moves, and turns
//                      the cube once the push passes PIECE_SPIN.pinPx — again with the button down.
//                      Also measures the pointer's room past the edge, which is pinPx's budget
//   L one face only    and ONCE per gesture (v0.9.7): after the push has turned a face, neither
//                      pulling the finger back (「转了一面以后我稍微往下一拖，它就转回来了」) nor
//                      pushing on again may turn it a second time — release and push again
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

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const APP_URL = (process.argv[2] || 'http://127.0.0.1:5173/').replace(/\/?$/, '/')
const APP_PORT = Number(new URL(APP_URL).port || 80)
const VIEWPORT = { width: 430, height: 900 }

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

// v0.9.3 spin fixture. The interaction fixture above (one centre cell per face) with the FRONT
// face packed edge to edge: the face then takes NO piece at all, whatever its shape, which is the
// spin's trigger. The four side faces keep plenty of room — a packed +z face only fills one edge
// row on each of them — so the run is still playable and `hasPlaceablePiece()` stays true, which is
// also what makes case J's negative control reachable: after one turn, the face in front DOES take
// the piece.
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
// The pinned-push threshold the app ships with, imported rather than copied: case K measures the
// pointer's room past a face edge AGAINST it, so a probe holding its own copy would keep reporting a
// healthy budget after the constant moved out of reach. v0.9.5 expresses it in LATTICE CELLS
// (「超出半格」) because that is the unit that survives a change of viewport.
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
    // Stop while the piece is pinned but still UNDER the turn threshold (v0.9.4). Past pinPx the
    // same push turns the cube instead of leaving the piece parked — that is case K's territory, and
    // walking through it here would silently replace the state this case means to measure. Everything
    // case C asserts (「推到边上不欠账、反向立刻跟手」) holds inside this window, which is also the
    // window a player who is placing a piece at an edge actually lives in.
    if (state.ghost.pushCells >= PIECE_SPIN.pinCells * 0.6) break
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

// J. v0.9.3 — the cube turns out from under a piece whose face takes it nowhere.
//
// The fixture packs the FRONT face edge to edge, so every origin on it is occupied and the drag
// has nothing left to mean but 「turn」. The case walks the whole gesture: arrive (armed, but the
// pose has not moved), push (one axis claimed, the cube turns — with the button still DOWN, which
// is the part no release-only probe can see), land on the face that came round, then push again on
// a face that DOES take the piece and watch the pose stay put (the trigger's own negative).
async function caseSpin(client, input) {
  await setSessionFixture(client, spinFixtureSource(['Dot', 'Square', 'Line 3']))
  await client.send('Page.reload', { ignoreCache: false })
  await sleep(1200)
  await waitForHandle(client)
  await client.frames()
  await waitIntroDone(client)

  const before = await client.readJson(STATE)
  if (before.rotation.front !== '+z') {
    skip('J spin', `the packed face is not the front one (front=${before.rotation.front})`)
    return
  }
  const bounds = await client.readJson('globalThis.__voxalblast.bounds()')
  const cube = cubeCentre(bounds)
  const slot = before.slots[0]

  // Glide onto the cube in SMALL steps and stop at the attach: the spin's ruler starts where the
  // piece touches down, so arriving in one long sweep would have turned the cube before the
  // precondition could be read.
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: slot.x, y: slot.y })
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: slot.x, y: slot.y, button: 'left', buttons: 1, clickCount: 1 })
  let held = null
  let at = null
  for (let i = 1; i <= 24; i += 1) {
    const t = i / 24
    const point = { x: Math.round(slot.x + (cube.x - slot.x) * t), y: Math.round(slot.y + (cube.y - slot.y) * t) }
    await input.move(point.x, point.y)
    await sleep(12)
    const state = await client.readJson(STATE)
    if (state.ghost.attached && state.ghost.previewCells > 0) { held = state; at = point; break }
  }
  if (!held) {
    await releaseWithoutPlacing(client, input, cube)
    skip('J spin', 'the piece never attached to the packed face')
    return
  }

  check('J the packed face reports roomless and the target is illegal',
    held.ghost.roomless === true && held.preview.valid === false,
    `roomless=${held.ghost.roomless} valid=${held.preview.valid} face=${held.ghost.previewFace} origin=${originKey(held)}`)
  check('J arriving on a face with no room arms the turn without moving the pose',
    held.ghost.spin === true && held.rotation.front === '+z',
    `spin=${held.ghost.spin} axis=${held.ghost.spinAxis} front=${held.rotation.front}`)

  // The push: the same gesture, 16px at a time, from WHERE THE PIECE TOUCHED DOWN — the spin's
  // ruler starts at the attach, so anything else would be measuring a throw rather than a push.
  // It stops on its own the moment the turn commits (`spin` goes live -> null), which keeps the
  // pointer inside the cube for the negative control that follows.
  let axisSeen = null
  let tip = at
  for (let i = 1; i <= 14; i += 1) {
    tip = { x: at.x, y: at.y - 16 * i }
    await input.move(tip.x, tip.y)
    await sleep(16)
    const state = await client.readJson(STATE)
    if (axisSeen === null && state.ghost.spinAxis) axisSeen = state.ghost.spinAxis
    if (state.ghost.spin === false) break
  }
  check('J the push claims one axis of the cube turn', axisSeen !== null, `axis=${axisSeen ?? 'none'}`)
  await sleep(450)
  await client.frames()
  const turned = await readState(client, input, { x: tip.x, y: tip.y - 4 })
  check('J the cube turned to another face with the button still down',
    turned.rotation.front !== '+z' && turned.rotation.front !== held.ghost.previewFace,
    `front ${held.ghost.previewFace} -> ${turned.rotation.front}`)
  check('J the piece re-attaches to the face that came round',
    turned.ghost.onFace === true && turned.ghost.previewFace === turned.rotation.front
      && turned.ghost.roomless === false,
    `onFace=${turned.ghost.onFace} previewFace=${turned.ghost.previewFace} front=${turned.rotation.front} roomless=${turned.ghost.roomless}`)

  // The trigger's negative, inside the same gesture: this face DOES take the piece, so the same
  // kind of push must move the piece across it and leave the pose alone.
  const frontNow = turned.rotation.front
  const from = { x: tip.x, y: tip.y - 4 }
  const roomyPoint = { x: from.x, y: from.y - 100 }
  for (let i = 1; i <= 5; i += 1) {
    await input.move(from.x, from.y - (100 * i) / 5)
    await sleep(16)
  }
  const roomy = await readState(client, input, roomyPoint)
  check('J a face that takes the piece does not turn the cube',
    roomy.ghost.onFace === true && roomy.rotation.front === frontNow,
    `onFace=${roomy.ghost.onFace} front ${frontNow} -> ${roomy.rotation.front} origin=${originKey(roomy)}`)

  // The release has exactly two possible answers, and the board has to match the one that happened.
  const legal = roomy.preview.valid === true
  await input.up(roomyPoint.x, roomyPoint.y)
  const released = await client.readJson(STATE)
  const untouched = boardFingerprint(released.board) === boardFingerprint(before.board)
  check(legal ? 'J the release after the turn places the piece on the new face'
    : 'J the release on an illegal cell returns the piece and spends nothing',
  legal ? released.slots[0].used === true && !untouched : released.slots[0].used === false && untouched,
  `valid=${legal} used=${released.slots[0].used} boardChanged=${!untouched} toast=${released.toast}`)
  await sleep(400)
}

// K. v0.9.4/v0.9.5 — the general arming condition, with the producer's time rule:
// 「超出下方一半格子，超过一段时间以后就向下翻」. No packing, no "this face has no room": the standard
// fixture's front face is empty except its centre, the piece is a Dot parked against a face edge, and
// from there the finger keeps going. Four claims:
//   1. a piece that is still following the finger never arms anything (this is what keeps an
//      ordinary placement drag from turning the cube — v0.8.27 slides the preview across occupied
//      cells on purpose, so the finger's own travel can never be the ruler);
//   2. pushing past PIECE_SPIN.pinCells ARMS it and the cube LEANS, but the pose does not turn;
//   3. holding the armed push for PIECE_SPIN.pinHoldMs turns exactly one face, with the button down;
//   4. pulling the finger back before that springs the lean back and turns nothing.
// v0.9.7 adds the RESISTANCE and its second commit: 「它会自动往外弹，如果这个时候我继续往外拖的话，
// 他就应该去转面了」 — the lean deepens with the push, and pushing on by PIECE_SPIN.pinPushPx turns the
// face without waiting out the dwell (「the push that keeps going」 section at the end).
//
// It also MEASURES the pointer's room past the edge, because that room is the budget `pinCells` has
// to be reachable inside. The measurement is a NOTE, never a pass.
async function casePinnedPush(client, input) {
  await reloadWithHand(client, ['Dot', 'Square', 'Line 3'])
  const before = await client.readJson(STATE)
  const bounds = await client.readJson('globalThis.__voxalblast.bounds()')
  const cube = cubeCentre(bounds)
  const slot = before.slots[0]

  // Attach at the centre, in small steps, and stop the moment the piece is on the face.
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: slot.x, y: slot.y })
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: slot.x, y: slot.y, button: 'left', buttons: 1, clickCount: 1 })
  let state = null
  for (let i = 1; i <= 24; i += 1) {
    const t = i / 24
    await input.move(Math.round(slot.x + (cube.x - slot.x) * t), Math.round(slot.y + (cube.y - slot.y) * t))
    await sleep(12)
    state = await client.readJson(STATE)
    if (state.ghost.attached && state.ghost.previewCells > 0) break
  }
  if (!state?.ghost?.attached) {
    await releaseWithoutPlacing(client, input, cube)
    skip('K pinned push', 'the piece never attached to the front face')
    return
  }

  const step = state.ghost.stepScreen.u
  const pitch = Math.hypot(step.x, step.y)
  if (pitch < 24) {
    await releaseWithoutPlacing(client, input, cube)
    skip('K pinned push', `the +u axis is nearly edge-on (${pitch.toFixed(1)} px per cell)`)
    return
  }

  // Walk right in QUARTER cells until the piece stops following the finger (`pushPx` leaves zero).
  // Every step before that is a step the PIECE took, so it proves the negative that keeps an
  // ordinary placement drag from turning the cube: dragging a piece across its face arms nothing,
  // and the pose stays put.
  const at = (cells) => ({ x: Math.round(cube.x + step.x * cells), y: Math.round(cube.y + step.y * cells) })
  let pinned = state
  let pinCells = 0
  let armedOnTheWay = 0
  for (let q = 1; q <= SH * 4; q += 1) {
    const next = await readState(client, input, at(q / 4))
    if (!next.ghost.onFace) break
    if (next.ghost.pushPx > 0) { pinned = next; pinCells = q / 4; break }
    if (next.rotation.front !== before.rotation.front) {
      skip('K pinned push', 'the cube turned while the piece was still following the finger')
      break
    }
    armedOnTheWay = next.ghost.pushPx
    pinned = next
  }
  check('K a piece that is still moving never arms the turn',
    pinned.ghost.onFace === true && pinned.rotation.front === before.rotation.front
      && armedOnTheWay === 0 && pinned.ghost.previewOrigin.u === SH - 1,
    `pushPx while moving=${armedOnTheWay} origin=${originKey(pinned)} front=${pinned.rotation.front}`)

  // Push straight on, one eighth of a cell at a time, until the push passes PIECE_SPIN.pinCells in
  // LATTICE CELLS (the producer's 「超出半格」). Nothing may turn here: the push only ARMS the turn.
  // The order of the two tests matters — a committed turn DROPS the latch on purpose, so the piece is
  // already back in hand on the frame the pose moves, and reading `onFace` first would hide it.
  const pinPoint = at(pinCells)
  const stepCells = pitch / 8 // one eighth of a cell, ≈7px at a 430px viewport
  let armedAt = null
  let last = pinned
  let lastStep = 0
  for (let i = 1; i <= 40; i += 1) {
    const point = at(pinCells + i / 8)
    const next = await readState(client, input, point)
    if (next.rotation.front !== before.rotation.front) {
      check('K the push arms the turn without turning the face', false,
        `the front moved to ${next.rotation.front} at step ${i}, before the dwell`)
      await releaseWithoutPlacing(client, input, point)
      return
    }
    if (!next.ghost.onFace) break
    if (next.ghost.armed) { armedAt = { i, px: i * stepCells, point, state: next }; break }
    last = next
    lastStep = i
  }
  if (!armedAt) {
    check('K pushing past the threshold arms the turn', false,
      `never armed after ${(lastStep * stepCells).toFixed(1)}px of pushing `
      + `(pushCells=${last.ghost.pushCells.toFixed(2)} of ${PIECE_SPIN.pinCells}, onFace=${last.ghost.onFace})`)
    await releaseWithoutPlacing(client, input, at(pinCells))
    return
  }
  const overhang = Math.round(armedAt.point.x - bounds.maxX)

  check('K pushing past half a cell arms the turn and leaves the face where it is',
    armedAt.state.rotation.front === before.rotation.front && armedAt.state.ghost.armedAxis !== null
      && armedAt.state.ghost.pushCells >= PIECE_SPIN.pinCells,
    `armed at pushCells=${armedAt.state.ghost.pushCells.toFixed(2)} (${armedAt.px.toFixed(1)}px), axis=${armedAt.state.ghost.armedAxis}, front=${armedAt.state.rotation.front}`)
  check('K the armed cube LEANS before anything is committed',
    JSON.stringify(armedAt.state.rotation.pose) !== JSON.stringify(before.rotation.pose),
    `pose changed while the front stayed ${armedAt.state.rotation.front} (lean ${PIECE_SPIN.armLeanDeg}°)`)
  check('K the arming push is made inside the cube\'s reachable band',
    overhang <= DRAG_GHOST.snapMarginPx,
    `pointer ${overhang}px past the silhouette, attach margin ${DRAG_GHOST.snapMarginPx}px — past that the piece is carried again and the push can never finish`)
  note('K pin budget', `${PIECE_SPIN.pinCells} cell = ${(PIECE_SPIN.pinCells * pitch).toFixed(0)}px armed at ${armedAt.px.toFixed(1)}px of push;`
    + ` the pointer has ~${Math.round(bounds.maxX - pinPoint.x + DRAG_GHOST.snapMarginPx)}px past the pin point before it leaves the cube`)

  // The cancel half of the rule, in this gesture: pull the finger back before the dwell elapses ->
  // the lean springs back, the pose returns to the grid, and the front never moves. The re-arming
  // half is NOT tested here: the pull-back spends the pointer's room past the edge (the piece has to
  // be walked back out before it can be pushed again), and the gesture would run out of cube before
  // reaching the threshold. The hold half gets its own gesture below for exactly that reason.
  await input.move(armedAt.point.x - Math.round(step.x * 0.5), armedAt.point.y - Math.round(step.y * 0.5))
  await sleep(90)
  const pulled = await client.readJson(STATE)
  check('K pulling the finger back before the dwell turns nothing',
    pulled.ghost.armed === false && pulled.rotation.front === before.rotation.front,
    `armed=${pulled.ghost.armed} front=${pulled.rotation.front}`)
  await releaseWithoutPlacing(client, input, at(pinCells))

  // ---- the hold half, in a gesture of its own ------------------------------------------------
  // 「超过一段时间以后就向下翻」: push past the threshold, then send NO further input at all and let
  // the clock run. This is the one claim no expressible gesture could fake.
  await reloadWithHand(client, ['Dot', 'Square', 'Line 3'])
  const second = await client.readJson(STATE)
  const slot2 = second.slots[0]
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: slot2.x, y: slot2.y })
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: slot2.x, y: slot2.y, button: 'left', buttons: 1, clickCount: 1 })
  let live = null
  for (let i = 1; i <= 24; i += 1) {
    const t = i / 24
    await input.move(Math.round(slot2.x + (cube.x - slot2.x) * t), Math.round(slot2.y + (cube.y - slot2.y) * t))
    await sleep(12)
    live = await client.readJson(STATE)
    if (live.ghost.attached && live.ghost.previewCells > 0) break
  }
  if (!live?.ghost?.attached) {
    await releaseWithoutPlacing(client, input, cube)
    skip('K hold', 'the second drag never attached')
    return
  }
  const step2 = live.ghost.stepScreen.u
  const at2 = (cells) => ({ x: Math.round(cube.x + step2.x * cells), y: Math.round(cube.y + step2.y * cells) })
  let armed2 = null
  for (let i = 1; i <= 40 && !armed2; i += 1) {
    const next = await readState(client, input, at2(i / 8))
    if (next.ghost.armed) armed2 = { i, point: at2(i / 8), state: next }
    else if (!next.ghost.onFace) break
  }
  if (!armed2) {
    check('K a fresh gesture can arm the same turn', false, 'never armed on the second gesture')
    await releaseWithoutPlacing(client, input, at2(2))
    return
  }
  const holdStart = Date.now()
  const holdMs = Math.round(PIECE_SPIN.pinHoldMs * 0.5)
  await sleep(holdMs)
  await client.frames()
  const halfway = await client.readJson(STATE)
  check('K the armed push does NOT turn the face before the dwell elapses',
    halfway.rotation.front === second.rotation.front,
    `after ${Math.round(Date.now() - holdStart)}ms of held push front is still ${halfway.rotation.front} (pinHoldMs=${PIECE_SPIN.pinHoldMs})`)

  await sleep(PIECE_SPIN.pinHoldMs - holdMs + 260)
  await client.frames()
  const held = await client.readJson(STATE)
  check('K holding the armed push for the dwell turns exactly one face, button still down',
    held.rotation.front !== second.rotation.front,
    `front ${second.rotation.front} -> ${held.rotation.front} after ${Math.round(Date.now() - holdStart)}ms of held push (pinHoldMs=${PIECE_SPIN.pinHoldMs})`)

  // The release has the same two possible answers as every other illegal release: the piece lands on
  // the face that came round, or it goes back to the strip with nothing spent.
  await readState(client, input, { x: armed2.point.x, y: armed2.point.y - 4 })
  const after = await client.readJson(STATE)
  const legal = after.preview.valid === true
  await input.up(armed2.point.x, armed2.point.y - 4)
  const released = await client.readJson(STATE)
  const fingerprint = JSON.stringify(released.board)
  const secondStart = JSON.stringify(second.board)
  check(legal ? 'K the release after the held turn places the piece on the new face'
    : 'K the release after the held turn returns the piece and spends nothing',
  legal ? released.slots[0].used === true && fingerprint !== secondStart
    : released.slots[0].used === false && fingerprint === secondStart,
  `valid=${legal} used=${released.slots[0].used} boardChanged=${fingerprint !== secondStart} toast=${released.toast}`)
  await sleep(400)

  // ---- the DOWN edge: the same rule on the other SIGN of the clamp ---------------------------------
  // This section is why v0.9.6 exists. `clampOrigin`'s bounds are `[-span, SH-1]`: travel discarded
  // at the LOW bound arrives as a negative difference, at the HIGH one positive. The first
  // implementation only added positive values, so 「推到右边推不动」 armed and 「推到下边推不动」 never
  // did — and whether the producer's downward push worked depended on the piece's shape and where it
  // started (「我往下已经超出很多了，但是没有转，有时候又转了」). Right/up and down/left are the two
  // signs of the same code path, so one case per sign pins the fix.
  await reloadWithHand(client, ['Dot', 'Square', 'Line 3'])
  const third = await client.readJson(STATE)
  const slot3 = third.slots[0]
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: slot3.x, y: slot3.y })
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: slot3.x, y: slot3.y, button: 'left', buttons: 1, clickCount: 1 })
  let down = null
  for (let i = 1; i <= 24; i += 1) {
    const t = i / 24
    await input.move(Math.round(slot3.x + (cube.x - slot3.x) * t), Math.round(slot3.y + (cube.y - slot3.y) * t))
    await sleep(12)
    down = await client.readJson(STATE)
    if (down.ghost.attached && down.ghost.previewCells > 0) break
  }
  if (!down?.ghost?.attached) {
    await releaseWithoutPlacing(client, input, cube)
    skip('K down edge', 'the downward drag never attached')
    return
  }
  const stepV = down.ghost.stepScreen.v
  // `stepScreen.v` is the lattice +v direction on screen, which for the front face points UP the
  // screen; the producer's report is about pushing DOWN, so this walks the OTHER way.
  const atV = (cells) => ({ x: Math.round(cube.x - stepV.x * cells), y: Math.round(cube.y - stepV.y * cells) })
  const pitchV = Math.hypot(stepV.x, stepV.y)
  let armedDown = null
  let lastDown = down
  let downSteps = 0
  for (let i = 1; i <= 40 && !armedDown; i += 1) {
    const next = await readState(client, input, atV(i / 8))
    if (next.rotation.front !== third.rotation.front) break
    if (!next.ghost.onFace) break
    lastDown = next
    downSteps = i
    if (next.ghost.armed) armedDown = { i, point: atV(i / 8), state: next }
  }
  if (!armedDown) {
    check('K pushing DOWN past half a cell arms the turn', false,
      `never armed after ${downSteps} eighths of a cell of downward pushing `
      + `(pushCells=${lastDown.ghost.pushCells.toFixed(2)}, origin=${lastDown.ghost.previewOrigin ? originKey(lastDown) : 'none'}, `
      + `onFace=${lastDown.ghost.onFace}) — the piece must reach the bottom row (v=0) before the push can count`)
    await releaseWithoutPlacing(client, input, atV(downSteps / 8))
    return
  }
  check('K pushing DOWN past half a cell arms the turn',
    armedDown.state.ghost.armedAxis === 'pitch' && armedDown.state.rotation.front === third.rotation.front
      && armedDown.state.ghost.pushCells >= PIECE_SPIN.pinCells
      && originKey(armedDown.state).endsWith(',0'),
    `armed at pushCells=${armedDown.state.ghost.pushCells.toFixed(2)} on axis=${armedDown.state.ghost.armedAxis}, `
    + `origin=${originKey(armedDown.state)} (${(armedDown.i * pitchV / 8).toFixed(0)}px down), front still ${armedDown.state.rotation.front}`)
  note('K down edge', `v axis ${pitchV.toFixed(1)}px per cell; armed ${(armedDown.i * pitchV / 8).toFixed(0)}px down, `
    + `cube bounds y ${Math.round(bounds.minY)}..${Math.round(bounds.maxY)} — the bottom edge is the tight one (no face visible past it)`)

  await sleep(PIECE_SPIN.pinHoldMs + 260)
  await client.frames()
  const turnedDown = await client.readJson(STATE)
  check('K holding a downward push turns the cube the other way',
    turnedDown.rotation.front !== third.rotation.front && turnedDown.rotation.front !== down.ghost.previewFace,
    `front ${down.ghost.previewFace} -> ${turnedDown.rotation.front} after the dwell`)
  await releaseWithoutPlacing(client, input, armedDown.point)

  // ---- the push that keeps going: the resistance, and the second commit (v0.9.7) -----------------
  // 「我超框以后，它会自动往外弹，如果这个时候我继续往外拖的话，他就应该去转面了」. Two claims, in one
  // gesture: the lean DEEPENS as the finger keeps pushing (the spring), and pushing on by
  // PIECE_SPIN.pinPushPx turns the face — before the dwell could have fired, which is what proves the
  // distance path committed it rather than the clock. The steps are a quarter of a cell (~9-13px at
  // this viewport), so the arming point is crossed within ~200ms: if the face turns, it was the push.
  await reloadWithHand(client, ['Dot', 'Square', 'Line 3'])
  const fourth = await client.readJson(STATE)
  const slot4 = fourth.slots[0]
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: slot4.x, y: slot4.y })
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: slot4.x, y: slot4.y, button: 'left', buttons: 1, clickCount: 1 })
  let out = null
  for (let i = 1; i <= 24; i += 1) {
    const t = i / 24
    await input.move(Math.round(slot4.x + (cube.x - slot4.x) * t), Math.round(slot4.y + (cube.y - slot4.y) * t))
    await sleep(12)
    out = await client.readJson(STATE)
    if (out.ghost.attached && out.ghost.previewCells > 0) break
  }
  if (!out?.ghost?.attached) {
    await releaseWithoutPlacing(client, input, cube)
    skip('K push on', 'the piece never attached to the front face')
    return
  }
  const step4 = out.ghost.stepScreen.u
  const pitch4 = Math.hypot(step4.x, step4.y)
  if (pitch4 < 24) {
    await releaseWithoutPlacing(client, input, cube)
    skip('K push on', `the +u axis is nearly edge-on (${pitch4.toFixed(1)} px per cell)`)
    return
  }
  const at4 = (cells) => ({ x: Math.round(cube.x + step4.x * cells), y: Math.round(cube.y + step4.y * cells) })
  let armed4 = null
  let walk4 = 0
  for (let i = 1; i <= 40 && !armed4; i += 1) {
    const next = await readState(client, input, at4(i / 8))
    walk4 = i / 8
    if (next.rotation.front !== fourth.rotation.front || !next.ghost.onFace) break
    if (next.ghost.armed) armed4 = { walk: i / 8, point: at4(i / 8), state: next }
  }
  if (!armed4) {
    check('K pushing on from a fresh gesture arms the turn', false, `never armed after ${walk4} cells of pushing`)
    await releaseWithoutPlacing(client, input, at4(2))
    return
  }
  // One more quarter cell out: still short of the commit distance, so the face must NOT move and the
  // lean must already be deeper than it was at the arming point.
  const leanMore = await readState(client, input, at4(armed4.walk + 0.25))
  check('K pushing on deepens the lean without turning the face',
    leanMore.rotation.front === fourth.rotation.front
    && JSON.stringify(leanMore.rotation.pose) !== JSON.stringify(armed4.state.rotation.pose),
    `front ${fourth.rotation.front} -> ${leanMore.rotation.front}; pose moved from ${PIECE_SPIN.armLeanDeg}° towards ${PIECE_SPIN.armLeanMaxDeg}°`)
  // Now push on past PIECE_SPIN.pinPushPx in three small moves with NO read cycle in between, so the
  // elapsed time is the pushes themselves and not the probe's step cadence: if the face turns, the
  // DISTANCE committed it, because the clock had not run out. The total is pinPushPx past the point
  // the lean was measured at, which leaves the pointer well inside PIECE_SPIN.pinMarginPx.
  const base = at4(armed4.walk + 0.25)
  const ux = step4.x / pitch4
  const uy = step4.y / pitch4
  const pushStart = Date.now()
  for (let i = 1; i <= 3; i += 1) {
    const d = (PIECE_SPIN.pinPushPx / 3) * i
    await input.move(Math.round(base.x + ux * d), Math.round(base.y + uy * d))
    await sleep(16)
  }
  await client.frames()
  const committed = await client.readJson(STATE)
  const elapsed = Date.now() - pushStart
  check('K pushing on past pinPushPx turns the face WITHOUT waiting out the dwell',
    committed.rotation.front !== fourth.rotation.front && elapsed < PIECE_SPIN.pinHoldMs,
    `front ${fourth.rotation.front} -> ${committed.rotation.front} after ${PIECE_SPIN.pinPushPx}px of extra push in ${elapsed}ms `
    + `(pinHoldMs=${PIECE_SPIN.pinHoldMs}ms, onFace=${committed.ghost.onFace})`)
  note('K push budget', `pinCells ${PIECE_SPIN.pinCells} + pinPushPx ${PIECE_SPIN.pinPushPx}px; armed ${walk4} cells out, `
    + `pointer ~${Math.round(bounds.maxX - at4(walk4).x + PIECE_SPIN.pinMarginPx)}px of room past the armed point`)
  await releaseWithoutPlacing(client, input, at4(armed4.walk + 2))
}

// L. v0.9.7 — 「一次手势一面」 on the PUSH path.
//
// The producer's report on v0.9.6: 「我在往上转，转了一面以后，我稍微往下一拖，它就转回来了」. The push
// path could turn the cube a SECOND time inside the same gesture, in any direction — including the
// one the finger had just come from — as soon as the clamp started discarding `pinCells` again.
// Nothing in the rule separated 「我再推一次」 from 「我把手指收回来」: after a turn the piece re-attaches
// wherever the clamp puts it on the arriving face, which can be flush against the very edge the
// return motion pushes into, so that motion is discarded — and counted as a push — from its first
// pixel. The face then turns back under a finger the player thought was just relaxing.
//
// What the case pins: one gesture turns one face by push — the same 「一次手势一面」 the keyboard and
// the view gesture already obey. A player who wants a second face lets go and pushes again.
//
// Both v-axis signs are walked, because WHICH edge the piece lands on after the turn depends on the
// direction the cube turned: the reversal only bites when the return motion pushes into that edge.
async function caseOnePushPerGesture(client, input) {
  for (const dir of [1, -1]) {
    const side = dir > 0 ? 'up' : 'down'
    await reloadWithHand(client, ['Dot', 'Square', 'Line 3'])
    const before = await client.readJson(STATE)
    const bounds = await client.readJson('globalThis.__voxalblast.bounds()')
    const cube = cubeCentre(bounds)
    const slot = before.slots[0]

    await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: slot.x, y: slot.y })
    await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: slot.x, y: slot.y, button: 'left', buttons: 1, clickCount: 1 })
    let held = null
    for (let i = 1; i <= 24; i += 1) {
      const t = i / 24
      await input.move(Math.round(slot.x + (cube.x - slot.x) * t), Math.round(slot.y + (cube.y - slot.y) * t))
      await sleep(12)
      held = await client.readJson(STATE)
      if (held.ghost.attached && held.ghost.previewCells > 0) break
    }
    if (!held?.ghost?.attached) {
      await releaseWithoutPlacing(client, input, cube)
      skip(`L ${side}`, 'the piece never attached to the front face')
      continue
    }
    const stepV = held.ghost.stepScreen.v
    const pitch = Math.hypot(stepV.x, stepV.y)
    if (pitch < 24) {
      await releaseWithoutPlacing(client, input, cube)
      skip(`L ${side}`, `the v axis is nearly edge-on (${pitch.toFixed(1)} px per cell)`)
      continue
    }
    // +v points UP the screen on the front face (K's note), so `dir` walks the piece towards the
    // edge the producer pushed against: +1 the top one, -1 the bottom one.
    const at = (cells) => ({ x: Math.round(cube.x + stepV.x * cells * dir), y: Math.round(cube.y + stepV.y * cells * dir) })
    let armed = null
    for (let i = 1; i <= 40 && !armed; i += 1) {
      const next = await readState(client, input, at(i / 8))
      if (next.rotation.front !== before.rotation.front || !next.ghost.onFace) break
      if (next.ghost.armed) armed = { i, point: at(i / 8), state: next }
    }
    if (!armed) {
      await releaseWithoutPlacing(client, input, at(1))
      skip(`L ${side}`, `the ${side}ward push never armed the turn`)
      continue
    }

    await sleep(PIECE_SPIN.pinHoldMs + 320)
    await client.frames()
    const turned = await client.readJson(STATE)
    const turnedNow = turned.rotation.front !== before.rotation.front
    check(`L ${side}: holding the push turns exactly one face, button still down`, turnedNow,
      `front ${before.rotation.front} -> ${turned.rotation.front}; onFace=${turned.ghost.onFace} `
      + `pushCells=${turned.ghost.pushCells.toFixed(2)}`)
    check(`L ${side}: the gesture marks its one face as spent`, turnedNow && turned.ghost.turned === true,
      `turned=${turned.ghost.turned} armed=${turned.ghost.armed}`)
    if (!turnedNow) {
      await releaseWithoutPlacing(client, input, at(2))
      continue
    }

    // The return, in the SAME gesture: the finger walks back the way it came, one eighth of a cell
    // at a time, and then HOLDS still for longer than the dwell — a turn that re-armed anywhere on
    // the way would fire in that hold, exactly as the producer saw it.
    const from = { x: armed.point.x, y: armed.point.y }
    const backPoint = (cells) => ({ x: Math.round(from.x - stepV.x * cells * dir), y: Math.round(from.y - stepV.y * cells * dir) })
    let rearmed = null
    let back = 0
    for (let i = 1; i <= 56; i += 1) {
      const point = backPoint(i / 8)
      const next = await readState(client, input, point)
      back = i / 8
      if (ONLY) {
        console.log(`       back ${back.toFixed(3)} cells -> mode=${next.ghost.mode} onFace=${next.ghost.onFace}`
          + ` face=${next.ghost.previewFace} origin=${next.ghost.previewOrigin ? originKey(next) : 'none'}`
          + ` pushCells=${next.ghost.pushCells.toFixed(2)} armed=${next.ghost.armed} front=${next.rotation.front}`)
      }
      if (next.ghost.armed && !rearmed) rearmed = { cells: i / 8, pushCells: next.ghost.pushCells, axis: next.ghost.armedAxis }
      if (next.rotation.front !== turned.rotation.front) break
    }
    await sleep(PIECE_SPIN.pinHoldMs + 320)
    await client.frames()
    const after = await client.readJson(STATE)
    check(`L ${side}: pulling the finger back ${back} cells does NOT turn the cube back`,
      after.rotation.front === turned.rotation.front,
      `front ${turned.rotation.front} -> ${after.rotation.front}`
      + (rearmed ? `; the return armed a second turn at ${rearmed.cells} cells back (pushCells ${rearmed.pushCells.toFixed(2)}, axis ${rearmed.axis})` : ''))
    check(`L ${side}: the return motion never even arms a second push turn`,
      rearmed === null,
      `armed=${after.ghost.armed} at ${back} cells back`)

    // The same rule, stated positively: a second DELIBERATE push in this gesture turns nothing
    // either — the rule is 「一次手势一面」, not 「别往回拖」. Walking the finger forward again is the
    // strongest push the gesture can make, and it must still leave the face where it is.
    const forwardPoint = at(2.5)
    await readState(client, input, forwardPoint)
    await sleep(PIECE_SPIN.pinHoldMs + 320)
    await client.frames()
    const pushedOn = await client.readJson(STATE)
    check(`L ${side}: a second push inside the same gesture turns nothing either`,
      pushedOn.rotation.front === turned.rotation.front,
      `front ${turned.rotation.front} -> ${pushedOn.rotation.front} after pushing on again`)

    // Nothing is stuck by any of it: the gesture still ends the way every other drag does — the
    // piece lands if the cell under it takes it, and goes back to the strip (spending nothing)
    // if it does not.
    await input.up(forwardPoint.x, forwardPoint.y)
    const released = await client.readJson(STATE)
    const spent = released.slots[0].used === true
    check(`L ${side}: the gesture still ends cleanly after the turn`,
      released.ghost.attached === false && released.ghost.armed === false
      && (spent || JSON.stringify(released.board) === JSON.stringify(before.board)),
      `attached=${released.ghost.attached} armed=${released.ghost.armed} spent=${spent} toast=${released.toast}`)
    await sleep(400)
  }
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
    && held.clearPreview.length === 5 && held.clearPreview.every(tile => tile.color === held.preview.pieceColor), JSON.stringify(held.clearPreview))
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
  const delta = 4 - held.ghost.previewOrigin.u
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

  console.log('\n-- J. the cube turns out from under a piece whose face takes it nowhere --')
  if (wants('J')) await caseSpin(client, input)

  console.log('\n-- K. a piece that cannot follow the finger turns the cube when pushed once more --')
  if (wants('K')) await casePinnedPush(client, input)

  console.log('\n-- L. one gesture turns ONE face — the way back out of a turn is not a second turn --')
  if (wants('L')) await caseOnePushPerGesture(client, input)

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

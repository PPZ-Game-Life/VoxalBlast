// Interaction regression probe for the incremental module-split refactor (P0).
//
//   node tools/refactor-interaction-probe.mjs [url]
//
// Why it exists. The refactor moves drag/viewDrag/keyboard/item-pointer arbitration out
// of src/main.js into input/ and rendering/ modules, and the existing probes each pin one
// narrow axis: swipe-probe owns the three rotation gestures, intro-probe owns the opening
// wave, rescue-probe owns the three stuck branches, screenshot.mjs owns static frames.
// NOTHING pins the placement path end to end, and nothing pins the cancel / pointer
// conflict / settings-interrupt / reload-resume paths — which is exactly where a rewrite
// of the listeners silently changes behaviour while every other check stays green.
//
// What it asserts, in the order it runs:
//   A. legal drop       the landing preview the player sees IS the placement that lands
//                       (preview origin + oriented cells -> the exact lattice cells the
//                       board gains), and the piece is spent exactly once
//   B. cancel strip     releasing back over candidate strip / item bar spends nothing,
//                       changes nothing on the board, and leaves no ghost behind
//   C. short press      a <6px press selects instead of placing, and a 10px move that
//                       ends off the cube places nothing ("Try another spot")
//   D. Esc / right-click cancelling a live drag restores the idle state exactly
//   E. settings         opening settings mid-drag cancels it (openSettings() path)
//   F. second pointer   a second finger's pointerup must not commit the first finger's
//                       piece (real CDP touch input, two touch ids)
//   G. reload resume    a placement survives a page reload: board, score and the used
//                       flags of the three candidates come back, and the boot still
//                       goes straight into the run (no home cover)
//   H. churn            ten drag+cancel cycles leave no growing preview/ghost/canvas
//                       population
//
// Discipline (same as the other probes): real CDP input only, no mocking of a result,
// read-only `__voxalblast` handles for observation, one isolated browser profile + OS
// assigned debug port per run, Browser.close before the profile is removed. Every
// precondition that cannot be reached is reported as SKIP (never as PASS) so a green run
// cannot be bought by skipping.
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { faceLattice } from '../src/game/board.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const APP_URL = (process.argv[2] || 'http://127.0.0.1:5173/').replace(/\/?$/, '/')
const APP_PORT = Number(new URL(APP_URL).port || 80)
const VIEWPORT = { width: 430, height: 900 }

// A deterministic hand. The real opening deal is random, and a 6-cell `Rect 6` or a 3×3
// `Block 9` frequently has nowhere to go on the front face — which would leave every
// placement case below inconclusive rather than failing, and an inconclusive probe is
// worth little. The fixture is an ordinary saved run (one centre cell per face so no
// face is crowded, three small candidates) written into localStorage BEFORE the page's
// module runs: it therefore reaches the board through the same `continueRun()` →
// `applySession()` path a real resume takes, exactly like screenshot.mjs's SHOT_SESSION.
// No result is mocked, and the placement cases below still use ordinary pointer input.
const FIXTURE_PATH = join(ROOT, 'tools', 'fixtures', 'interaction-session.json')
const FIXTURE_SOURCE = `localStorage.setItem('voxalblast.session.v1', ${
  JSON.stringify(JSON.stringify(JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')).snapshot))})`

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
]

const DRAG_SLOP_PX = 6   // main.js: `Math.hypot(...) < 6` keeps the press a click
const MOVE_STEPS = 6
const INTRO_TIMEOUT_MS = 20000
const CHURN_CYCLES = 10

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
    || !basename(actualProfile).startsWith('voxalblast-interaction-')) {
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

// The repo's own vite entrypoint is spawned directly (Node refuses a .cmd without a
// shell), and it is left running on purpose: the other probes reuse port 5173 too.
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
  // A reload tears the execution context down under us; retrying is what makes
  // "wait for the handle to appear" safe instead of a race.
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

// The opening wave holds the same pause lock as a modal, so every drag below would be
// swallowed if it ran during the wave. Wait for `intro().active === false` — the same
// gate swipe-probe gained in v0.8.22.
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

// The fixture is re-injected on EVERY navigation, which is what keeps the reload-heavy
// cases identical to each other. The one case that must observe a real saved run (G) turns
// the injection off first, so the snapshot the game wrote itself is the one that loads.
let fixtureScriptId = null
async function setSessionFixture(client, wanted) {
  if (wanted && !fixtureScriptId) {
    const added = await client.send('Page.addScriptToEvaluateOnNewDocument', { source: FIXTURE_SOURCE })
    fixtureScriptId = added.identifier
  } else if (!wanted && fixtureScriptId) {
    await client.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: fixtureScriptId })
    fixtureScriptId = null
  }
}

async function reloadAndSettle(client, { fixture = true } = {}) {
  await setSessionFixture(client, fixture)
  await client.send('Page.reload', { ignoreCache: false })
  await sleep(1200)
  await waitForHandle(client)
  await client.frames()
  return waitIntroDone(client)
}

// One read of everything the checks below compare against. Deliberately a single
// evaluate so a check can never straddle two frames. It returns the OBJECT (not a
// JSON string) so readJson() can serialise it once — see makeClient.
const STATE = `(() => {
  const shown = (el) => { if (!el) return null; const cs = getComputedStyle(el); const box = el.getBoundingClientRect(); return { display: cs.display, width: Math.round(box.width), height: Math.round(box.height) } }
  const slots = [...document.querySelectorAll('#piece-slots .piece-slot')].map((slot) => {
    const box = slot.getBoundingClientRect()
    return {
      index: Number(slot.dataset.index),
      label: slot.getAttribute('aria-label'),
      used: slot.classList.contains('used'),
      selected: slot.classList.contains('selected'),
      x: Math.round(box.left + box.width / 2),
      y: Math.round(box.top + box.height / 2),
    }
  })
  const toast = document.querySelector('#toast')
  return {
    status: document.querySelector('#status')?.textContent ?? null,
    toast: toast?.textContent ?? null,
    toastVisible: toast ? getComputedStyle(toast).opacity !== '0' : false,
    cancelMode: Boolean(document.querySelector('.bottom-panel')?.classList.contains('cancel-mode')),
    slots,
    board: globalThis.__voxalblast.board(),
    ghost: globalThis.__voxalblast.ghost(),
    preview: globalThis.__voxalblast.preview(),
    placement: globalThis.__voxalblast.placement(),
    rotation: globalThis.__voxalblast.rotation(),
    home: globalThis.__voxalblast.home(),
    run: globalThis.__voxalblast.run(),
    session: globalThis.__voxalblast.session(),
    canvases: document.querySelectorAll('canvas').length,
  }
})()`

const cellKey = (cell) => `${cell[0]},${cell[1]},${cell[2]}`
const boardKeys = (board) => board.cells.map(cellKey).sort()

// ------------------------------------------------------------------------ CDP input

function mouse(client) {
  return {
    async move(x, y) {
      await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 })
    },
    async down(x, y, button = 'left') {
      await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons: button === 'left' ? 1 : 2, clickCount: 1 })
    },
    async up(x, y, button = 'left') {
      await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount: 1 })
    },
    async click(x, y) {
      await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
      await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
      await sleep(40)
      await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
      await sleep(200)
    },
    // Press, glide to `to` in steps, and STOP with the button still down — so the caller
    // can read the live drag state before deciding how the gesture ends. That pause is
    // the whole point of this probe: the landing preview is only observable mid-drag.
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

// Real multi-touch. Chrome derives the per-touch pointer ids itself; the probe never
// invents one, it only diffes which touch points are still down (the CDP contract:
// touchPoints lists what remains active, so the removed entry is the released finger).
function touch(client) {
  const points = (list) => list.map((point) => ({ x: point.x, y: point.y, id: point.id, radiusX: 2, radiusY: 2, force: 1 }))
  return {
    async start(list) {
      await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(list) })
    },
    async move(list) {
      await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(list) })
    },
    async end(list) {
      await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: points(list) })
    },
  }
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

// `ghost().attached` is `Boolean(drag)` — "a drag gesture is live", NOT "the piece is on a
// face". The on-face handoff is `mode === 'snap'`: the carried ghost is hidden and the
// board draws the landing marker in its place. Conflating the two makes every assertion
// below pass for the wrong reason, which is how this probe's first draft fooled itself.
const gestureLive = (state) => state.ghost.attached === true
const onFace = (state) => state.ghost.attached === true && state.ghost.mode === 'snap' && state.ghost.previewCells > 0
// v0.8.27: "attached" no longer implies "legal" — the preview now follows the finger ACROSS
// occupied cells (red) instead of sticking to the last legal origin. Any sweep whose landing
// spot is the subject of the check has to ask for the legal one explicitly, or it would settle
// on a red preview and fail the check it was meant to set up.
const onLegalFace = (state) => onFace(state) && state.preview.valid === true
const inHand = (state) => state.ghost.attached === true && state.ghost.mode === 'carry'
  && state.ghost.count > 0 && state.ghost.previewCells === 0
// clearDragGhost() leaves `userData.mode` stale on purpose (nothing reads it while idle),
// so "idle" has to be read off visible/count/marker rather than off the last mode string.
const idle = (state) => state.ghost.attached === false && state.ghost.visible === false
  && state.ghost.count === 0 && state.ghost.previewCells === 0

// A legal drop target inside the cube's silhouette. The opening board leaves the middle
// of the front face free, but "the middle" is not guaranteed once the random opening
// layout lands, so candidates are swept until the live preview reports attached+valid.
function targetCandidates(bounds) {
  const midX = (bounds.minX + bounds.maxX) / 2
  const midY = (bounds.minY + bounds.maxY) / 2
  const halfW = (bounds.maxX - bounds.minX) / 2
  const halfH = (bounds.maxY - bounds.minY) / 2
  const deltas = [[0, 0], [0.35, 0], [-0.35, 0], [0, 0.35], [0, -0.35], [0.35, 0.35], [-0.35, -0.35], [0.35, -0.35], [-0.35, 0.35]]
  return deltas.map(([dx, dy]) => ({ x: Math.round(midX + dx * halfW), y: Math.round(midY + dy * halfH) }))
}

// Press a candidate slot and glide onto the cube, stopping while still held. Returns the
// live state, or null when no swept point produced an attached placement preview.
async function holdDragOverCube(client, input, slot, bounds) {
  for (const target of targetCandidates(bounds)) {
    await input.pressAndHold({ x: slot.x, y: slot.y }, target)
    await client.frames()
    const state = await client.readJson(STATE)
    if (onLegalFace(state)) return { state, target }
    await input.up(target.x, target.y)
    await sleep(120)
  }
  return null
}

// --------------------------------------------------------------- the actual P0 cases

// A. The preview the player sees must be the placement that lands.
async function caseLegalDrop(client, input) {
  const before = await client.readJson(STATE)
  const slot = before.slots.find((entry) => !entry.used)
  if (!slot) { skip('A legal drop', 'no unused candidate slot on the opening deal'); return }
  const bounds = await client.readJson('globalThis.__voxalblast.bounds()')
  const held = await holdDragOverCube(client, input, slot, bounds)
  if (!held) { skip('A legal drop', 'no swept cube point produced an attachable preview'); return }

  const live = held.state
  const origin = live.ghost.previewOrigin
  // `placement()` reports the oriented cells of the first unused candidate; it has to be
  // the candidate this drag is holding or the prediction below would describe another piece.
  if (live.preview.piece !== live.placement.piece) {
    await input.up(held.target.x, held.target.y)
    skip('A legal drop', `placement() tracks "${live.placement.piece}" but the drag holds "${live.preview.piece}"`)
    return
  }
  check('A the drop is attached to a face with a valid origin', onFace(live) && live.preview.valid === true,
    `mode=${live.ghost.mode} valid=${live.preview.valid} origin=${JSON.stringify(origin)}`)
  check('A the landing marker is drawn for exactly the piece cell count',
    live.ghost.previewCells === live.placement.oriented.length && live.preview.cells.length === live.placement.oriented.length,
    `marker=${live.ghost.previewCells} oriented=${live.placement.oriented.length}`)
  check('A the landing marker wears the candidate own paint, not a fixed colour',
    live.preview.pieceColor !== null && live.preview.cells.every((cell) => cell.color === live.preview.pieceColor)
      && live.preview.cells.every((cell) => cell.opacity === 0.72),
    `pieceColor=${live.preview.pieceColor} marker=${live.preview.cells.map((c) => c.color).join(',')}`)
  check('A the landing marker and the carried ghost never coexist',
    live.ghost.visible === false, `ghostVisible=${live.ghost.visible} mode=${live.ghost.mode}`)

  // The prediction, built from the SAME lattice helper the game uses — not a
  // re-implementation of it: preview origin + oriented cells -> lattice coordinates.
  const predicted = live.placement.oriented
    .map(([du, dv]) => cellKey(faceLattice(live.placement.face, du + origin.u, dv + origin.v)))
    .sort()

  await input.up(held.target.x, held.target.y)
  await sleep(400)
  const after = await client.readJson(STATE)

  const gained = boardKeys(after.board).filter((key) => !boardKeys(before.board).includes(key))
  if (after.board.totalLines === before.board.totalLines) {
    check('A the placement lands exactly the lattice cells the preview showed',
      JSON.stringify(gained) === JSON.stringify(predicted),
      `gained=[${gained}] predicted=[${predicted}] face=${live.placement.face}`)
    check('A no board cell was consumed by the placement', boardKeys(after.board).length === boardKeys(before.board).length + predicted.length,
      `before=${boardKeys(before.board).length} after=${boardKeys(after.board).length} placed=${predicted.length}`)
  } else {
    // The opening layout can, rarely, leave a face one cell short of a line: then the
    // clear consumes the very cells the preview showed and the set comparison above
    // would be measuring the clear, not the drop. Say so instead of passing quietly.
    note('A the first placement completed a line',
      `totalLines ${before.board.totalLines} -> ${after.board.totalLines}; cell-set comparison not applicable this run`)
  }
  check('A the placement scores', after.board.score > before.board.score, `score ${before.board.score} -> ${after.board.score}`)
  check('A no full line is left standing after settling', after.board.fullLines.length === 0, `fullLines=${after.board.fullLines.join('|')}`)
  check('A the placed candidate is spent exactly once', after.slots[slot.index].used === true, `slot ${slot.index} used=${after.slots[slot.index].used}`)
  check('A the drag state is fully released', idle(after),
    `attached=${after.ghost.attached} mode=${after.ghost.mode} previewCells=${after.ghost.previewCells} ghost=${after.ghost.count}`)
  check('A the run is resumable right after the placement', after.session !== null && after.session.board.score === after.board.score,
    `sessionScore=${after.session?.board?.score} boardScore=${after.board.score}`)
  return after
}

// B. Releasing back over the strip that the drag came from puts the piece back.
async function caseCancelStrip(client, input) {
  await reloadAndSettle(client)
  const before = await client.readJson(STATE)
  const slot = before.slots.find((entry) => !entry.used)
  if (!slot) { skip('B cancel strip', 'no unused candidate slot on the opening deal'); return }
  const bounds = await client.readJson('globalThis.__voxalblast.bounds()')
  const held = await holdDragOverCube(client, input, slot, bounds)
  if (!held) { skip('B cancel strip', 'no swept cube point produced an attachable preview'); return }

  // The cancel target is the strip, so glide back down to the panel the slot lives in.
  // `main.js` binds the zone to `.bottom-panel` (slots + item bar are its two halves).
  const panel = await client.readJson(`(() => { const el = document.querySelector('.bottom-panel')
    if (!el) return null; const box = el.getBoundingClientRect()
    return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) } })()`)
  if (!panel) { await input.up(held.target.x, held.target.y); skip('B cancel strip', 'no .bottom-panel to release over'); return }

  await input.move(panel.x, panel.y)
  await sleep(80)
  const inZone = await client.readJson(STATE)
  check('B dragging back over the strip raises the cancel affordance', inZone.cancelMode === true, `cancelMode=${inZone.cancelMode} status="${inZone.status}"`)
  check('B the cancel state clears the landing preview', inZone.ghost.previewCells === 0 && inZone.ghost.mode === 'cancel',
    `previewCells=${inZone.ghost.previewCells} mode=${inZone.ghost.mode}`)

  await input.up(panel.x, panel.y)
  await sleep(400)
  const after = await client.readJson(STATE)
  check('B cancelling spends no piece', after.slots[slot.index].used === false, `slot ${slot.index} used=${after.slots[slot.index].used}`)
  check('B cancelling leaves the board untouched', JSON.stringify(boardKeys(after.board)) === JSON.stringify(boardKeys(before.board))
    && after.board.score === before.board.score, `cells=${boardKeys(after.board).length} score=${after.board.score}`)
  check('B cancelling clears every drag residue', idle(after),
    `attached=${after.ghost.attached} mode=${after.ghost.mode} previewCells=${after.ghost.previewCells} ghost=${after.ghost.count}`)
  check('B cancelling says so', after.toast === 'Placement cancelled' && after.status === 'Pick a shape',
    `toast="${after.toast}" status="${after.status}"`)
}

// C. The 6px click/drag boundary and the "released nowhere useful" branch.
async function caseSlopAndMiss(client, input) {
  await reloadAndSettle(client)
  const before = await client.readJson(STATE)
  const slot = before.slots.find((entry) => !entry.used)
  if (!slot) { skip('C slop', 'no unused candidate slot on the opening deal'); return }

  // Under the slop: a press that stays put is a selection, never a placement.
  await input.pressAndHold({ x: slot.x, y: slot.y }, { x: slot.x + 3, y: slot.y }, 1)
  await input.up(slot.x + 3, slot.y)
  await sleep(300)
  const tapped = await client.readJson(STATE)
  check(`C a press under ${DRAG_SLOP_PX}px selects instead of placing`, tapped.slots[slot.index].used === false && tapped.slots[slot.index].selected === true,
    `used=${tapped.slots[slot.index].used} selected=${tapped.slots[slot.index].selected} status="${tapped.status}"`)
  check('C the short press leaves no carried ghost behind', idle(tapped),
    `attached=${tapped.ghost.attached} mode=${tapped.ghost.mode} carried=${tapped.ghost.count} marker=${tapped.ghost.previewCells}`)

  // Past the slop, ending off the cube and off the strip: nothing is spent, and the
  // player is told to try elsewhere rather than silently losing the piece.
  const void_ = { x: Math.round(VIEWPORT.width / 2), y: 4 }
  await input.pressAndHold({ x: slot.x, y: slot.y }, void_)
  await sleep(80)
  const carried = await client.readJson(STATE)
  check('C a piece carried off the cube stays in hand', inHand(carried),
    `mode=${carried.ghost.mode} carried=${carried.ghost.count} marker=${carried.ghost.previewCells}`)
  await input.up(void_.x, void_.y)
  await sleep(350)
  const after = await client.readJson(STATE)
  check('C dropping outside the board spends no piece', after.slots[slot.index].used === false, `used=${after.slots[slot.index].used}`)
  check('C dropping outside the board changes nothing', JSON.stringify(boardKeys(after.board)) === JSON.stringify(boardKeys(before.board)),
    `cells=${boardKeys(after.board).length}`)
  check('C dropping outside the board says "Try another spot"', after.toast === 'Try another spot', `toast="${after.toast}"`)
}

// D. Esc and the right mouse button end a live drag with the same clean state.
async function caseEscAndContextMenu(client, input) {
  for (const [label, cancel] of [
    ['Esc', async (target) => {
      await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
      await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
    }],
    ['right-click', async (target) => {
      // The left button is still down (that is the drag). `buttons` carries the whole
      // bitmask, so the right press must report left+right and its release left only —
      // otherwise the browser synthesises a left mouse-up and cancels the drag for us,
      // which would make the assertion vacuous.
      await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'right', buttons: 3, clickCount: 1 })
      await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'right', buttons: 1, clickCount: 1 })
    }],
  ]) {
    await reloadAndSettle(client)
    const before = await client.readJson(STATE)
    const slot = before.slots.find((entry) => !entry.used)
    if (!slot) { skip(`D ${label} cancels a live drag`, 'no unused candidate slot on the opening deal'); continue }
    const bounds = await client.readJson('globalThis.__voxalblast.bounds()')
    const held = await holdDragOverCube(client, input, slot, bounds)
    if (!held) { skip(`D ${label} cancels a live drag`, 'no swept cube point produced an attachable preview'); continue }

    await cancel(held.target)
    await sleep(350)
    const after = await client.readJson(STATE)
    check(`D ${label} ends the drag and spends no piece`,
      after.slots[slot.index].used === false && idle(after),
      `used=${after.slots[slot.index].used} attached=${after.ghost.attached} mode=${after.ghost.mode} carried=${after.ghost.count}`)
    check(`D ${label} leaves the board untouched`,
      JSON.stringify(boardKeys(after.board)) === JSON.stringify(boardKeys(before.board)) && after.board.score === before.board.score,
      `cells=${boardKeys(after.board).length} score=${after.board.score}`)
    check(`D ${label} restores the idle prompt`, after.status === 'Pick a shape', `status="${after.status}"`)
    // The gesture's own left button is still logically down; let it go so the next case
    // does not start with a phantom press.
    await input.up(held.target.x, held.target.y)
    await sleep(150)
  }
}

// E. The settings panel is the documented "open a modal mid-drag" path.
async function caseSettingsInterrupt(client, input) {
  const before = await client.readJson(STATE)
  const slot = before.slots.find((entry) => !entry.used)
  if (!slot) { skip('E settings cancels a live drag', 'no unused candidate slot on the opening deal'); return }
  const bounds = await client.readJson('globalThis.__voxalblast.bounds()')
  const held = await holdDragOverCube(client, input, slot, bounds)
  if (!held) { skip('E settings cancels a live drag', 'no swept point produced an attachable preview'); return }

  // The gear is a real button with a real click listener; this drives that listener, not
  // a private function. Done through the DOM because the mouse is held by the drag.
  await client.evaluate(`document.querySelector('#settings-button').click()`)
  await sleep(350)
  const after = await client.readJson(STATE)
  check('E opening settings cancels the live drag', idle(after),
    `attached=${after.ghost.attached} mode=${after.ghost.mode} carried=${after.ghost.count}`)
  check('E opening settings spends no piece', after.slots[slot.index].used === false, `used=${after.slots[slot.index].used}`)
  check('E opening settings pauses the board', after.status === 'Paused', `status="${after.status}"`)

  // Put the panel away with its own close button and confirm the board comes back live.
  await client.evaluate(`document.querySelector('#settings-close').click()`)
  await sleep(300)
  const closed = await client.readJson(STATE)
  check('E closing settings returns the idle prompt', closed.status === 'Pick a shape', `status="${closed.status}"`)
  // The gesture left a captured pointer behind; release it so later cases start clean.
  await input.up(held.target.x, held.target.y)
  await sleep(200)
}

// F. Two live fingers: the second finger's release must not commit the first one's piece.
//
// This case records the browser's own pointer stream (type + pointerId) while it runs.
// CDP's touch contract is a diff against the previous touchPoints list, and the failure
// mode worth ruling out is the probe itself asking Chrome to lift the WRONG finger: that
// would place the piece legitimately and the check would be blaming the game for the
// harness. The recorded stream is printed either way, so the verdict is auditable.
async function caseSecondPointer(client, input, touchInput) {
  await reloadAndSettle(client)
  const before = await client.readJson(STATE)
  const slot = before.slots.find((entry) => !entry.used)
  if (!slot) { skip('F second pointer', 'no unused candidate slot on the opening deal'); return }
  const bounds = await client.readJson('globalThis.__voxalblast.bounds()')

  await client.evaluate(`(() => {
    globalThis.__pointerLog = []
    for (const type of ['pointerdown', 'pointerup', 'pointercancel']) {
      addEventListener(type, (event) => globalThis.__pointerLog.push({
        type, pointerId: event.pointerId, pointerType: event.pointerType,
        x: Math.round(event.clientX), y: Math.round(event.clientY),
      }), true)
    }
  })()`)

  // Finger 1 presses the slot and glides onto the cube. Swept like the mouse cases so an
  // unlucky opening layout cannot make this case vacuous.
  let held = null
  for (const target of targetCandidates(bounds)) {
    await touchInput.start([{ x: slot.x, y: slot.y, id: 1 }])
    const steps = MOVE_STEPS
    for (let i = 1; i <= steps; i += 1) {
      const t = i / steps
      await touchInput.move([{ x: Math.round(slot.x + (target.x - slot.x) * t), y: Math.round(slot.y + (target.y - slot.y) * t), id: 1 }])
      await sleep(16)
    }
    await client.frames()
    const state = await client.readJson(STATE)
    if (onLegalFace(state)) { held = { state, target }; break }
    await touchInput.end([])
    await sleep(150)
  }
  if (!held) {
    skip('F second pointer', 'touch input never produced an attachable preview (touch emulation inconclusive)')
    return
  }
  check('F the first touch starts a real placement drag', onFace(held.state) && held.state.preview.valid === true,
    `mode=${held.state.ghost.mode} valid=${held.state.preview.valid}`)

  const armedCells = boardKeys(held.state.board)
  const armedScore = held.state.board.score
  await client.evaluate('globalThis.__pointerLog = []')

  // Finger 2 taps far from finger 1 and lifts. Its pointerup runs the shared handler
  // (finishViewDrag → finishDrag → item confirm); the pointerId check is what has to
  // stop it from finishing finger 1's placement.
  //
  // CDP touch semantics, measured rather than assumed (the first draft of this case got
  // them wrong and blamed the game for it): the touchPoints of a `touchEnd` are the
  // points BEING RELEASED, while an empty list releases everything still down. So the
  // second finger's lift is `end([finger2])`, not `end([finger1])` — the latter lifts
  // finger 1 and the placement that follows is correct behaviour, not a bug.
  const second = { x: Math.round(VIEWPORT.width - 16), y: Math.round(VIEWPORT.height - 16) }
  await touchInput.start([{ x: held.target.x, y: held.target.y, id: 1 }, { x: second.x, y: second.y, id: 2 }])
  await sleep(120)
  await touchInput.end([{ x: second.x, y: second.y, id: 2 }])
  await sleep(350)

  const afterSecond = await client.readJson(STATE)
  const liftLog = await client.readJson('globalThis.__pointerLog')
  console.log(`     second-finger lift produced: ${JSON.stringify(liftLog)}`)
  const wrongFinger = liftLog.some((entry) => entry.type === 'pointerup'
    && Math.abs(entry.x - second.x) < 8 && Math.abs(entry.y - second.y) < 8) === false
  check('F the second finger does not commit the first finger piece',
    JSON.stringify(boardKeys(afterSecond.board)) === JSON.stringify(armedCells) && afterSecond.board.score === armedScore,
    `cells=${boardKeys(afterSecond.board).length} vs ${armedCells.length} score=${afterSecond.board.score} vs ${armedScore}`
    + `${wrongFinger ? ' [the lift did not land on the second finger — harness problem, not the game]' : ''}`)
  check('F the first finger drag survives the second finger', onFace(afterSecond),
    `mode=${afterSecond.ghost.mode} marker=${afterSecond.ghost.previewCells}`)

  // Finger 1 lets go for real: now the placement must land.
  await touchInput.end([])
  await sleep(450)
  const afterFirst = await client.readJson(STATE)
  check('F the first finger release still places exactly once',
    boardKeys(afterFirst.board).length === armedCells.length + held.state.ghost.previewCells,
    `before=${armedCells.length} after=${boardKeys(afterFirst.board).length} placed=${held.state.ghost.previewCells}`)
  check('F no drag residue is left after the two-finger gesture', idle(afterFirst),
    `attached=${afterFirst.ghost.attached} mode=${afterFirst.ghost.mode} carried=${afterFirst.ghost.count}`)
}

// G. A real placement has to survive a reload, and the boot still goes straight in.
async function caseReloadResume(client, input) {
  await reloadAndSettle(client)
  const before = await client.readJson(STATE)
  const slot = before.slots.find((entry) => !entry.used)
  if (!slot) { skip('G reload resume', 'no unused candidate slot on the opening deal'); return }
  const bounds = await client.readJson('globalThis.__voxalblast.bounds()')
  const held = await holdDragOverCube(client, input, slot, bounds)
  if (!held) { skip('G reload resume', 'no swept cube point produced an attachable preview'); return }
  await input.up(held.target.x, held.target.y)
  await sleep(450)
  const placed = await client.readJson(STATE)

  // This is the one reload that must NOT get the fixture: the snapshot the game wrote
  // itself (saveSession() after the placement) is the thing under test. Injection is
  // turned back on afterwards so the later cases keep their deterministic hand.
  await reloadAndSettle(client, { fixture: false })
  const resumed = await client.readJson(STATE)

  check('G the reload boots straight into a run, not a home cover',
    resumed.home.open === false && resumed.home.hasSavedRun === true,
    `open=${resumed.home.open} hasSavedRun=${resumed.home.hasSavedRun}`)
  check('G the reload restores every placed board cell',
    JSON.stringify(boardKeys(resumed.board)) === JSON.stringify(boardKeys(placed.board)),
    `before=${boardKeys(placed.board).length} after=${boardKeys(resumed.board).length}`)
  check('G the reload restores the score', resumed.board.score === placed.board.score,
    `${placed.board.score} -> ${resumed.board.score}`)
  check('G the reload restores the total line count', resumed.board.totalLines === placed.board.totalLines,
    `${placed.board.totalLines} -> ${resumed.board.totalLines}`)
  check('G the reload restores which candidates were spent',
    JSON.stringify(resumed.slots.map((entry) => entry.used)) === JSON.stringify(placed.slots.map((entry) => entry.used)),
    `${JSON.stringify(placed.slots.map((e) => e.used))} -> ${JSON.stringify(resumed.slots.map((e) => e.used))}`)
  check('G the reload restores the chain', resumed.run.chain === placed.run.chain, `${placed.run.chain} -> ${resumed.run.chain}`)
  check('G the reload keeps the front face the run was left on',
    resumed.rotation.front !== null && resumed.rotation.front === placed.rotation.front,
    `${placed.rotation.front} -> ${resumed.rotation.front}`)

  // Known pre-existing gap (refactor plan §1.3) — observed, never "fixed": session.js
  // migrate() rebuilds `pose` as {yaw,pitch,quat,base} and drops bearingYaw/bearingPitch,
  // so the dialled bearing cannot come back even though sessionSnapshot() writes it and
  // applySession() reads it. Recorded here so the refactor cannot silently change it.
  const stored = await client.evaluate(`localStorage.getItem('voxalblast.session.v1')`)
  const storedPose = stored ? Object.keys(JSON.parse(stored).pose || {}) : []
  note('G bearing is not persisted (pre-existing session.js migrate gap)',
    `stored pose keys=[${storedPose}] -> restore falls back to ROTATE_STYLE defaults (observed, out of scope for this refactor)`)
}

// H. Repeated drag+cancel must not accumulate preview meshes, ghosts or canvases.
async function caseChurn(client, input) {
  await reloadAndSettle(client)
  const start = await client.readJson(STATE)
  const slot = start.slots.find((entry) => !entry.used)
  if (!slot) { skip('H churn', 'no unused candidate slot on the opening deal'); return }
  const bounds = await client.readJson('globalThis.__voxalblast.bounds()')
  const cube = { x: Math.round((bounds.minX + bounds.maxX) / 2), y: Math.round((bounds.minY + bounds.maxY) / 2) }
  // The item bar, not the candidate panel: a slot sits INSIDE that panel, so releasing
  // over the panel's own centre can be a sub-6px move that never leaves the click state
  // and would make the churn vacuous. The item bar is the strip's other half and is
  // always well clear of the slots.
  const strip = await client.readJson(`(() => { const el = document.querySelector('#item-bar'); const box = el.getBoundingClientRect()
    return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) } })()`)

  for (let i = 0; i < CHURN_CYCLES; i += 1) {
    await input.pressAndHold({ x: slot.x, y: slot.y }, cube)
    await input.move(strip.x, strip.y)
    await sleep(30)
    await input.up(strip.x, strip.y)
    await sleep(60)
  }
  await sleep(500)
  const after = await client.readJson(STATE)
  check(`H ${CHURN_CYCLES} drag+cancel cycles leave no preview or ghost residue`, idle(after),
    `attached=${after.ghost.attached} mode=${after.ghost.mode} carried=${after.ghost.count} marker=${after.ghost.previewCells}`)
  check(`H ${CHURN_CYCLES} drag+cancel cycles leave the canvas count stable`,
    after.canvases === start.canvases, `canvases ${start.canvases} -> ${after.canvases}`)
  check(`H ${CHURN_CYCLES} drag+cancel cycles spend nothing`,
    after.slots.every((entry, index) => entry.used === start.slots[index].used) && after.board.score === start.board.score,
    `score ${start.board.score} -> ${after.board.score}`)
  check(`H ${CHURN_CYCLES} drag+cancel cycles leave exactly three candidate slots`,
    after.slots.length === 3, `slots=${after.slots.length}`)
}

// --------------------------------------------------------------------------- driver

const browserPath = findBrowser()
const dev = await ensureDevServer()
console.log(`browser  ${browserPath}`)
console.log(`target   ${APP_URL}  (dev server ${dev.started ? `started, pid ${dev.pid}` : 'already running'})`)
console.log(`viewport ${VIEWPORT.width}x${VIEWPORT.height}\n`)

const profile = mkdtempSync(join(tmpdir(), 'voxalblast-interaction-'))
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
  const netFailures = []
  await client.send('Page.enable')
  await client.send('Runtime.enable')
  await client.send('Network.enable')
  pageSocket.addEventListener('message', (event) => {
    const { method, params } = JSON.parse(event.data)
    if (method === 'Network.loadingFailed' && !params.canceled && !/ERR_ABORTED/.test(params.errorText || '')) {
      netFailures.push(`${params.errorText} ${params.type || ''}`)
    }
  })
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: VIEWPORT.width, height: VIEWPORT.height,
    screenWidth: VIEWPORT.width, screenHeight: VIEWPORT.height, deviceScaleFactor: 1, mobile: true,
  })
  // Touch support on, but mouse input is NOT converted to touch (that would be
  // setEmitTouchEventsForMouse) — the mouse cases below need real mouse pointers.
  await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })

  // The fixture has to be registered before the FIRST navigation, not only before the
  // reloads, or the opening case would run on a random deal.
  await setSessionFixture(client, true)
  await client.send('Page.navigate', { url: APP_URL })
  await waitForHandle(client)
  const booted = await waitIntroDone(client)
  check('boot: the opening wave finishes on its own', booted === true, 'intro().active === false')
  const input = mouse(client)
  const touchInput = touch(client)

  console.log('\n-- A. legal drop: the preview IS the placement --')
  await caseLegalDrop(client, input)

  console.log('\n-- B. cancel strip --')
  await caseCancelStrip(client, input)

  console.log('\n-- C. click slop and drop outside the board --')
  await caseSlopAndMiss(client, input)

  console.log('\n-- D. Esc and right-click cancel a live drag --')
  await caseEscAndContextMenu(client, input)

  console.log('\n-- E. settings interrupts a live drag --')
  await caseSettingsInterrupt(client, input)

  console.log('\n-- F. a second pointer must not commit the first pointer piece --')
  await caseSecondPointer(client, input, touchInput)

  console.log('\n-- G. reload resume --')
  await caseReloadResume(client, input)

  console.log('\n-- H. churn --')
  await caseChurn(client, input)

  console.log('')
  check('no browser console errors', errors.length === 0, errors.join(' | '))
  check('no failed network load (excluding cancelled navigations)', netFailures.length === 0, netFailures.join(' | '))
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
  console.log('\nplacement, cancel, pointer-conflict, settings-interrupt and reload-resume paths behave as before')
}

// Rescue-judgement probe for 07 §3.1 B1 (v0.8.16), headless Edge over CDP.
//
//   node tools/rescue-probe.mjs [url]
//   npm run probe:rescue          (needs `npm run dev` running)
//
// What it proves: when nothing in the candidate hand can be placed, the run must NOT
// end while the player still holds a tool that can open a hole. The three branches of
// `checkStuckAndPrompt()` are asserted in order:
//   1. refresh > 0                      -> "No spot - use Refresh", run alive
//   2. refresh = 0 but hammer/rocket/bomb > 0 -> "No spot - clear a path", run alive,
//      and the blocking-clear tool can actually be armed (that is the whole point)
//   3. every charge spent               -> Game Over card, run over
//
// A shell jam is common in real play but cannot be produced on demand, which is why the
// dev-only `__voxalblastDev.jam()` / `setItems()` / `stuckCheck()` handles exist: they
// call the same functions gameplay calls, so this is not a mock of the rule.
//
// Pitfalls already handled (do not re-solve): own temp profile + OS-assigned debug port
// per run; Browser.close before profile removal; DOM assertions read computed style,
// layout box and hit test rather than class names.
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync, rmSync, realpathSync } from 'node:fs'
import { basename, join, relative, sep } from 'node:path'
import { tmpdir } from 'node:os'

const url = process.argv[2] || 'http://127.0.0.1:5173/'
const CHROME_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
]
const BROWSER = CHROME_CANDIDATES.find((path) => path && existsSync(path))
if (!BROWSER) throw new Error(`no headless browser found; tried:\n  ${CHROME_CANDIDATES.join('\n  ')}`)

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
    const timeout = setTimeout(() => finish(new Error(`${method}: timed out`)), 15000)
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

const STATE = `(() => {
  const card = document.querySelector('#game-over')
  const shown = (el) => {
    if (!el) return null
    const cs = getComputedStyle(el)
    const box = el.getBoundingClientRect()
    return { display: cs.display, width: Math.round(box.width), height: Math.round(box.height) }
  }
  const toast = document.querySelector('#toast')
  return JSON.stringify({
    status: document.querySelector('#status').textContent,
    toast: toast.textContent,
    toastVisible: getComputedStyle(toast).opacity !== '0',
    gameOver: shown(card),
    gameOverLive: !!card && getComputedStyle(card).display !== 'none',
    items: globalThis.__voxalblastDev.items(),
    armed: document.querySelector('.item-button.armed')?.dataset.item ?? null,
    itemBarCounts: [...document.querySelectorAll('.item-button .item-count')].map((el) => el.textContent),
  })
})()`

const profile = mkdtempSync(join(tmpdir(), 'voxalblast-rescue-'))
const child = spawn(BROWSER, [
  '--headless=new', '--disable-gpu', '--disable-breakpad', '--hide-scrollbars',
  '--no-first-run', '--no-default-browser-check', '--force-device-scale-factor=1',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=430,900', 'about:blank',
], { stdio: 'ignore', windowsHide: true })

const failures = []
function check(label, condition, detail) {
  console.log(`${condition ? 'OK  ' : 'FAIL'} ${label}${detail === undefined ? '' : `  ${detail}`}`)
  if (!condition) failures.push(label)
}

let ws
let browserSocket = null
try {
  let port
  for (let i = 0; i < 80; i += 1) {
    try { port = Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]); break } catch { await sleep(250) }
  }
  if (!port) throw new Error('devtools never came up')
  browserSocket = await connect((await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl)
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json()
  ws = await connect(target.webSocketDebuggerUrl)

  const browserErrors = []
  ws.addEventListener('message', (event) => {
    const { method, params } = JSON.parse(event.data)
    if (method === 'Runtime.consoleAPICalled' && params.type === 'error') {
      browserErrors.push(params.args.map((arg) => arg.value ?? arg.description ?? arg.type).join(' '))
    }
    if (method === 'Runtime.exceptionThrown') browserErrors.push(params.exceptionDetails.text)
  })
  await send(ws, 1, 'Page.enable')
  await send(ws, 2, 'Runtime.enable')
  await send(ws, 3, 'Emulation.setDeviceMetricsOverride', { width: 430, height: 900, screenWidth: 430, screenHeight: 900, deviceScaleFactor: 1, mobile: true })

  const evalJs = async (expression) => {
    const result = await send(ws, nextId++, 'Runtime.evaluate', { expression, returnByValue: true })
    if (result.exceptionDetails) throw new Error(`evaluate threw: ${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`)
    return result.result?.value
  }
  const state = async () => JSON.parse(await evalJs(STATE))
  const clickSel = async (selector) => {
    const rect = JSON.parse(await evalJs(`(() => { const el = document.querySelector(${JSON.stringify(selector)})
      if (!el) return 'null'; const r = el.getBoundingClientRect(); return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }) })()`))
    if (!rect) throw new Error(`missing ${selector}`)
    await send(ws, nextId++, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y })
    await send(ws, nextId++, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
    await sleep(40)
    await send(ws, nextId++, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
    await sleep(250)
  }

  await send(ws, 4, 'Page.navigate', { url })
  await sleep(3500)
  const hasHandle = await evalJs('typeof globalThis.__voxalblastDev?.stuckCheck === "function"')
  if (!hasHandle) throw new Error('dev handles missing: point this probe at `npm run dev`')

  // v0.8.22: there is no home cover to dismiss any more — the game boots into a run. Wait
  // for the opening creation wave instead, which holds the input lock and would swallow
  // every click below.
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (JSON.parse(await evalJs('JSON.stringify(globalThis.__voxalblast.intro().active)')) === false) break
    await sleep(200)
  }
  const booted = JSON.parse(await evalJs('JSON.stringify(globalThis.__voxalblast.home())'))
  check('run started on load, no home cover', booted.open === false)
  check('the opening wave is over before the first click', JSON.parse(await evalJs('JSON.stringify(globalThis.__voxalblast.intro().active)')) === false)

  // Branch 1 — refresh charged (the pre-existing rule, unchanged).
  const items1 = await evalJs('JSON.stringify(globalThis.__voxalblastDev.setItems({ refresh: 2, hammer: 1, rocket: 1, bomb: 1 }))')
  const jam = JSON.parse(await evalJs('JSON.stringify(globalThis.__voxalblastDev.jam())'))
  await evalJs('globalThis.__voxalblastDev.stuckCheck()')
  let s = await state()
  check('jam filled the board', jam.occupied === 98, `occupied=${jam.occupied} filled=${jam.filled}`)
  check('refresh charged: run stays alive', s.gameOverLive === false)
  check('refresh charged: prompt names Refresh', s.status === 'No spot - use Refresh' && s.toast === 'No spot - try Refresh', `status="${s.status}" toast="${s.toast}"`)
  check('items set to the first branch', JSON.parse(items1).refresh === 2)

  // Branch 2 — B1: no refresh left, but a blocking-clear tool is charged.
  await evalJs('globalThis.__voxalblastDev.setItems({ refresh: 0, hammer: 1, rocket: 1, bomb: 1 })')
  await evalJs('globalThis.__voxalblastDev.stuckCheck()')
  s = await state()
  check('B1: jam with only hammer/rocket/bomb does NOT end the run', s.gameOverLive === false)
  check('B1: prompt says clear a path', s.status === 'No spot - clear a path' && s.toast === 'No spot - clear a path', `status="${s.status}" toast="${s.toast}"`)

  // The rescue has to be reachable, not just announced: arm the hammer through the UI.
  await clickSel('.item-button[data-item="hammer"]')
  s = await state()
  check('B1: hammer arms while the board is jammed', s.status === 'Tap a block to remove', `status="${s.status}"`)
  await clickSel('.item-button[data-item="hammer"]') // tapping the armed tool puts it away
  s = await state()
  check('B1: tap again disarms, no charge spent', s.items.hammer === 1, `hammer=${s.items.hammer}`)

  // Branch 3 — every charge spent: the run may end now, and only now.
  await evalJs('globalThis.__voxalblastDev.setItems({ refresh: 0, hammer: 0, rocket: 0, bomb: 0 })')
  await evalJs('globalThis.__voxalblastDev.stuckCheck()')
  await sleep(400)
  s = await state()
  check('all charges spent: Game Over card is shown', s.gameOverLive === true, `display=${s.gameOver?.display}`)

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
    if (insideTemp && basename(actual).startsWith('voxalblast-rescue-')) {
      rmSync(actual, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
    }
  } catch {}
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed:\n  - ${failures.join('\n  - ')}`)
  process.exitCode = 1
} else {
  console.log('\nrescue rule (07 §3.1 B1) verified: 3 branches + armable tool')
}

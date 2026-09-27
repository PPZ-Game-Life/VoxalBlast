// Scroll-containment probe (v0.9.8) — WHO owns a vertical slide in the game view.
//
//   node tools/scroll-containment-probe.mjs [url]     (npm run probe:scroll)
//
// Why it exists. The producer reported "滑动整个窗口会上下滑动，整体滑动的区域最好只在顶部响应，
// 其他地方不要响应". Two independent causes, and a probe that only reads CSS can see neither:
//   1) `styles.css` still carried the v0.2 flow-layout floor `body { min-height: 100vh }`. On a
//      phone `vh` is the LARGE viewport (address bar retracted) while the visible one is `dvh`,
//      so the document stayed one address bar taller than the screen and a slide pushed the whole
//      run (HUD included) up — `.game-layout` is `position: absolute; inset: 0` against the
//      initial containing block, so it travels with the document.
//   2) touch-action was only declared on `.scene-wrap` / `.piece-slot` / `.item-button`. Every
//      piece of ground between them (the sky above the cube, the meadows beside it, the tray
//      frame, the gaps in the item strip) hit-tested as `.game-layout` with `auto`, so those
//      regions scrolled the window.
//
// What it asserts, in the order it runs:
//   A floor gone     `body` min-height no longer resolves to the viewport height, and the
//                    document fits its viewport on its own (scrollHeight === clientHeight)
//   B top only       with the window FORCED to overflow, a slide that starts in the top HUD band
//                    scrolls it, and a slide that starts on the board, the tray, the item bar or
//                    either meadow leaves window.scrollY at exactly 0
//   C escape         informational: with an overflowing box appended inside `.game-layout`, where
//                    the remaining pan-capable ground is (`.game-layout` is anchored to the ICB,
//                    not to `#app`, so such a box escapes `#app`'s clip)
//
// Pitfall this probe cannot solve, and does not pretend to: headless Chrome has no address bar,
// so `vh === dvh` and the phone's own overflow cannot be reproduced. Phase B therefore forces the
// same overflow the phone has (`body { min-height: 170vh }`), which is the shape of the bug, not
// the device. Physical-device verification stays open (docs/Technical/REFERENCE_ART_SKIN.md).
//
// Discipline, same as the other probes: real CDP touch input only, an isolated browser profile
// with an OS-assigned debug port, Browser.close before the profile is removed, and a non-zero
// exit as soon as one assertion fails.
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const url = (process.argv[2] || 'http://127.0.0.1:5173/').replace(/\/?$/, '/')
const CHROME = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
].find((path) => path && existsSync(path))
if (!CHROME) throw new Error('no headless browser')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let nextId = 100
const failures = []
let passed = 0

function check(name, ok, detail) {
  if (ok) { passed += 1; console.log(`  PASS ${name}${detail ? ` — ${detail}` : ''}`) }
  else { failures.push(name); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`) }
}

// One viewport per layout family the reference skin switches on: a portrait phone (board nearly
// full width, tray in the bottom thumb zone, item strip in the HUD band) and a desktop (board
// inset 10% each side, so the meadow margins are real ground a player can touch).
const VIEWPORTS = [
  { name: 'mobile-390x844', width: 390, height: 844, mobile: true, points: [
    { name: 'top-band', x: 195, y: 26, pan: true },
    { name: 'item-bar', x: 195, y: 128 },
    { name: 'board', x: 195, y: 430 },
    { name: 'tray', x: 195, y: 800 },
    { name: 'left-margin', x: 8, y: 620 },
    { name: 'right-margin', x: 382, y: 620 } ] },
  { name: 'desktop-1440x900', width: 1440, height: 900, mobile: false, points: [
    { name: 'top-band', x: 340, y: 40, pan: true },
    { name: 'item-bar', x: 720, y: 40 },
    { name: 'board', x: 720, y: 400 },
    { name: 'tray', x: 720, y: 830 },
    { name: 'left-margin', x: 60, y: 450 },
    { name: 'right-margin', x: 1380, y: 450 } ] },
]

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
    const onClose = () => finish(new Error(`${method}: closed`))
    const timeout = setTimeout(() => finish(new Error(`${method}: timed out`)), 15000)
    ws.addEventListener('message', onMessage)
    ws.addEventListener('close', onClose, { once: true })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function connect(endpoint) {
  const ws = new WebSocket(endpoint)
  await new Promise((ok, no) => {
    const timeout = setTimeout(() => { ws.close(); no(new Error('ws timeout')) }, 5000)
    ws.addEventListener('open', () => { clearTimeout(timeout); ok() }, { once: true })
    ws.addEventListener('error', (error) => { clearTimeout(timeout); no(error) }, { once: true })
  })
  return ws
}

const STATE_JS = `(() => ({
  viewport: [innerWidth, innerHeight],
  doc: { scrollHeight: document.scrollingElement.scrollHeight, clientHeight: document.scrollingElement.clientHeight, scrollY: Math.round(window.scrollY) },
  bodyMinHeight: getComputedStyle(document.body).minHeight,
}))()`

const HIT_JS = `(x, y) => {
  const hit = (node) => node ? { el: (node.id || node.className || node.tagName).toString().slice(0, 30), ta: getComputedStyle(node).touchAction } : null
  return { self: hit(document.elementFromPoint(x, y)), strip: hit(document.querySelector('.scroll-strip')) }
}`

const profile = mkdtempSync(join(tmpdir(), 'voxalblast-scroll-'))
const child = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--disable-breakpad', '--hide-scrollbars',
  '--no-first-run', '--no-default-browser-check', '--force-device-scale-factor=1',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1440,900', 'about:blank',
], { stdio: 'ignore', windowsHide: true })

let ws
try {
  let port
  for (let i = 0; i < 80; i += 1) {
    try { port = Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]); break } catch { await sleep(250) }
  }
  if (!port) throw new Error('browser never reported a debugging port')
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json()
  ws = await connect(target.webSocketDebuggerUrl)
  await send(ws, 1, 'Page.enable')
  await send(ws, 2, 'Runtime.enable')
  await send(ws, 3, 'Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 })

  const evalJs = async (expression) => {
    const result = await send(ws, nextId++, 'Runtime.evaluate', { expression, returnByValue: true })
    if (result.exceptionDetails) throw new Error(`evaluate threw: ${result.exceptionDetails.text}`)
    return result.result?.value
  }
  const state = async () => await evalJs(STATE_JS)
  const hitAt = async (x, y) => await evalJs(`(${HIT_JS})(${x}, ${y})`)
  const touch = (type, points) => send(ws, nextId++, 'Input.dispatchTouchEvent', { type, touchPoints: points })

  // A slide upward (the gesture that scrolls content down) in eight steps: one move is not enough
  // for Chromium to start a pan, and a teleporting pointer is not what a thumb does.
  const slideUp = async (x, y, distance = 260) => {
    await touch('touchStart', [{ x, y }])
    await sleep(30)
    for (let i = 1; i <= 8; i += 1) {
      await touch('touchMove', [{ x, y: y - (distance * i) / 8 }])
      await sleep(18)
    }
    await touch('touchEnd', [])
    await sleep(180)
  }
  const resetScroll = () => evalJs('window.scrollTo(0, 0)')
  const setForce = (css) => evalJs(`(() => {
    const existing = document.getElementById('__probeStyle')
    if (existing) existing.remove()
    if (!${JSON.stringify(css)}) return 'off'
    const s = document.createElement('style'); s.id = '__probeStyle'; s.textContent = ${JSON.stringify(css)}
    document.head.appendChild(s); return 'on'
  })()`)

  for (const view of VIEWPORTS) {
    await send(ws, nextId++, 'Emulation.setDeviceMetricsOverride', {
      width: view.width, height: view.height, screenWidth: view.width, screenHeight: view.height,
      deviceScaleFactor: 1, mobile: view.mobile,
    })
    await send(ws, nextId++, 'Page.navigate', { url })
    await sleep(3200)
    console.log(`\n===== ${view.name}`)

    // --- A: the phantom floor is gone and the document fits its viewport on its own.
    await setForce('')
    await resetScroll()
    const base = await state()
    check('A body min-height floor removed', base.bodyMinHeight === '0px', `min-height=${base.bodyMinHeight}`)
    check('A document fits the viewport unforced', base.doc.scrollHeight === base.doc.clientHeight,
      `${base.doc.scrollHeight}/${base.doc.clientHeight}`)
    for (const point of view.points) {
      const hit = await hitAt(point.x, point.y)
      if (point.pan) {
        check(`A ${point.name} is the pan band`, hit.self?.ta === 'pan-y',
          `hit=${hit.self?.el} touch-action=${hit.self?.ta}`)
      } else {
        check(`A ${point.name} is not the pan band`, hit.self?.ta !== 'pan-y',
          `hit=${hit.self?.el} touch-action=${hit.self?.ta}`)
      }
    }

    // --- B: the window is forced to overflow (the phone's vh > dvh), so a pan is possible at all.
    await setForce('body{min-height:170vh !important}')
    await sleep(200)
    const forced = await state()
    check('B forced overflow is reachable', forced.doc.scrollHeight > forced.doc.clientHeight,
      `${forced.doc.scrollHeight}/${forced.doc.clientHeight}`)
    for (const point of view.points) {
      await resetScroll()
      const before = await state()
      await slideUp(point.x, point.y)
      const after = await state()
      const delta = after.doc.scrollY - before.doc.scrollY
      if (point.pan) check(`B ${point.name} scrolls the window`, delta > 0, `ΔscrollY=${delta}`)
      else check(`B ${point.name} does not scroll the window`, delta === 0, `ΔscrollY=${delta}`)
    }

    // --- C: informational — the ground left over once an overflowing box escapes `#app`.
    await setForce('')
    await resetScroll()
    await evalJs(`(() => {
      const box = document.createElement('div'); box.id = '__probeOverflow'
      box.style.cssText = 'position:absolute;top:100%;left:0;width:4px;height:240px'
      document.querySelector('.game-layout').appendChild(box); return 'ok'
    })()`)
    await sleep(200)
    const escaped = await state()
    const reachable = []
    for (const point of view.points) {
      await resetScroll()
      const before = await state()
      await slideUp(point.x, point.y)
      const after = await state()
      if (after.doc.scrollY !== before.doc.scrollY) reachable.push(point.name)
    }
    console.log(`  INFO C overflow box inside .game-layout escapes #app: document ${escaped.doc.scrollHeight}/${escaped.doc.clientHeight}; pan-capable ground = ${reachable.join(', ') || 'none'}`)
    await evalJs("document.getElementById('__probeOverflow')?.remove(); window.scrollTo(0,0); 'ok'")
  }

  console.log(`\n${failures.length ? 'FAIL' : 'OK'} scroll containment: ${passed} passed, ${failures.length} failed${failures.length ? ` — ${failures.join('; ')}` : ''}`)
  process.exitCode = failures.length ? 1 : 0
} finally {
  try { await send(ws, 9999, 'Browser.close') } catch {}
  await sleep(500)
  if (child.exitCode === null) { try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) } catch {} }
  await sleep(600)
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 }) } catch {}
}

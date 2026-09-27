// Dialog-surface probe (v0.9.9) — is a dialog's CARD actually the thing on screen?
//
//   node tools/dialog-surface-probe.mjs [url]     (npm run probe:dialog)
//
// Why it exists. On 2026-09-25 the producer reported 「设置界面显示有问题」. Every existing check
// passed: the panel was `display: grid`, the card had a non-zero box, every row was laid out at
// the right coordinates, `elementFromPoint` returned the card, and the UI probe's open/close/focus
// assertions were green. What was wrong was invisible to all of them: `.modal-close::before`, the
// wooden face every `.icon-button` / `.item-button` / `.home-primary` draws, is
// `position: absolute; inset: 4px 4px 5px`, and `.modal-close` was the ONE wood button without
// `position: relative`. Its face therefore resolved against the nearest positioned ancestor — the
// `.modal` itself, `position: fixed; inset: 0` — and painted a plank inset 4px across the WHOLE
// VIEWPORT, over the card's title and rows. `isolation: isolate` on the close button made that
// plank a stacking context painted in the positioned-descendants step, i.e. after the card's text,
// so the dialog read as a blank wooden slab with only the ✕ and the toggle switches visible.
// Measured bounds of the slab matched the pseudo-element's own inset exactly (x 4…385, y 4…838 at
// 390×844), which is what identified it.
//
// What it asserts, per dialog (settings / controls / leaderboard):
//   A contained   no element inside the dialog has an absolutely positioned ::before / ::after
//                 while itself being `position: static` — that combination always lets the
//                 pseudo-element escape to the dialog box. This is the exact defect above, stated
//                 as an invariant rather than as a fix.
//   B legible     the card's own box, captured from the composed frame, contains dark text pixels
//                 in the title band and across the card (a missing/covered paint fails this; the
//                 broken build measured 0 dark pixels in the title band, the fixed one 530).
//   C card box    the card fits inside the dialog and inside the viewport
//
// Discipline, same as the other probes: real CDP input only, an isolated browser profile with an
// OS-assigned debug port, Browser.close before the profile is removed, and a non-zero exit as soon
// as one assertion fails. The PNG census needs no dependency — the 40-line decoder below reads the
// 8-bit RGB/RGBA, non-interlaced PNGs CDP returns.
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'

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

// --- minimal PNG reader (8-bit RGB/RGBA, non-interlaced) ------------------------------------
function decodePng(buffer) {
  let pos = 8
  let width = 0, height = 0, depth = 0, colorType = 0
  const idat = []
  while (pos < buffer.length) {
    const len = buffer.readUInt32BE(pos)
    const type = buffer.toString('ascii', pos + 4, pos + 8)
    const data = buffer.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8]; colorType = data[9] }
    else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    pos += 12 + len
  }
  if (depth !== 8) throw new Error(`unsupported PNG bit depth ${depth}`)
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0
  if (!channels) throw new Error(`unsupported PNG colour type ${colorType}`)
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = Buffer.alloc(stride * height)
  let rp = 0
  for (let y = 0; y < height; y += 1) {
    const filter = raw[rp]; rp += 1
    const line = raw.subarray(rp, rp + stride); rp += stride
    const o = y * stride
    const prev = o - stride
    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? out[o + i - channels] : 0
      const b = y > 0 ? out[prev + i] : 0
      const c = i >= channels && y > 0 ? out[prev + i - channels] : 0
      let v = line[i]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      out[o + i] = v & 0xff
    }
  }
  return { width, height, channels, stride, data: out }
}
// "Dark" here means a label pixel: the wood skin paints every label in a deep brown (#452e13 and
// friends) on a cream card, so the mean-channel threshold separates text from card, from the ✕'s
// plank and from the blurred backdrop without depending on the exact palette.
function darkPixels(png, x0, y0, x1, y1) {
  const { width, height, channels, stride, data } = png
  let count = 0
  for (let y = Math.max(0, y0); y < Math.min(height, y1); y += 1) {
    for (let x = Math.max(0, x0); x < Math.min(width, x1); x += 1) {
      const o = y * stride + x * channels
      if ((data[o] + data[o + 1] + data[o + 2]) / 3 < 120) count += 1
    }
  }
  return count
}

const CONTAINED_JS = `(selector) => {
  const scope = document.querySelector(selector)
  if (!scope) return { error: 'dialog missing' }
  const offenders = []
  for (const el of scope.querySelectorAll('*')) {
    const own = getComputedStyle(el)
    for (const pseudo of ['::before', '::after']) {
      const face = getComputedStyle(el, pseudo)
      if (!face || face.content === 'none' || face.position !== 'absolute') continue
      // An absolutely positioned pseudo-element on a static element escapes to the nearest
      // positioned ancestor, which for a dialog is the fixed full-screen .modal box.
      if (own.position === 'static') offenders.push(\`\${el.tagName.toLowerCase()}\${el.id ? '#' + el.id : ''} \${pseudo} (inset \${face.inset})\`)
    }
  }
  return { offenders }
}`

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

// Each dialog is reached through its own real entry point. `panel` is the card the player reads.
const DIALOGS = [
  { name: 'settings', open: ['#settings-button'], panel: '#settings-modal .modal-content', title: '#settings-title', viewport: 'mobile' },
  { name: 'controls', open: ['#controls-button'], panel: '#controls-modal .modal-content', title: '#controls-title', viewport: 'desktop' },
  { name: 'leaderboard', open: ['#settings-button', '#home-setting', '#home-leaderboard'], panel: '#leaderboard .modal-content', title: '#leaderboard-title', viewport: 'mobile' },
]

const VIEWPORTS = {
  mobile: { width: 390, height: 844, mobile: true },
  desktop: { width: 1440, height: 900, mobile: false },
}

const profile = mkdtempSync(join(tmpdir(), 'voxalblast-dialog-'))
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

  const evalJs = async (expression) => {
    const result = await send(ws, nextId++, 'Runtime.evaluate', { expression, returnByValue: true })
    if (result.exceptionDetails) throw new Error(`evaluate threw: ${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`)
    return result.result?.value
  }
  const click = async (selector, label) => {
    const raw = await evalJs(`(() => { const el = document.querySelector(${JSON.stringify(selector)})
      if (!el) return null
      const r = el.getBoundingClientRect()
      if (!r.width || !r.height) return null
      return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)] })()`)
    if (!raw) { console.log(`    click ${label} (${selector}): not reachable`); return false }
    const [x, y] = raw
    await send(ws, nextId++, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await sleep(40)
    await send(ws, nextId++, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
    return true
  }

  for (const dialog of DIALOGS) {
    const view = VIEWPORTS[dialog.viewport]
    await send(ws, nextId++, 'Emulation.setDeviceMetricsOverride', {
      width: view.width, height: view.height, screenWidth: view.width, screenHeight: view.height,
      deviceScaleFactor: 1, mobile: view.mobile,
    })
    await send(ws, nextId++, 'Page.navigate', { url })
    await sleep(3800)
    console.log(`\n===== ${dialog.name} (${dialog.viewport} ${view.width}x${view.height})`)

    let reached = true
    for (const step of dialog.open) {
      if (!(await click(step, step))) reached = false
      await sleep(step === '#home-setting' ? 900 : 700)
    }
    if (!reached || (await evalJs(`!!document.querySelector(${JSON.stringify(dialog.panel)})`)) !== true) {
      check(`${dialog.name} reachable`, false, 'entry point did not open the dialog')
      continue
    }
    const shown = await evalJs(`getComputedStyle(document.querySelector(${JSON.stringify(dialog.panel)})).display !== 'none'`)
    check(`${dialog.name} dialog opens`, shown === true)
    if (shown !== true) continue

    // A — the invariant.
    const contained = await evalJs(`(${CONTAINED_JS})(${JSON.stringify(`#${dialog.panel.split(' ')[0].slice(1)}`)})`)
    const offenders = contained?.offenders || []
    check(`${dialog.name} A pseudo-elements are contained`, offenders.length === 0,
      offenders.length ? offenders.join('; ') : 'no absolute pseudo-element on a static element')

    // C — the card box.
    const box = await evalJs(`(() => { const el = document.querySelector(${JSON.stringify(dialog.panel)})
      const r = el.getBoundingClientRect()
      return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) } })()`)
    check(`${dialog.name} C card fits in the viewport`,
      box.width > 0 && box.height > 0 && box.x >= 0 && box.y >= 0 && box.x + box.width <= view.width && box.y + box.height <= view.height,
      `${box.width}x${box.height} at ${box.x},${box.y}`)

    // B — the painted card is legible.
    await sleep(600)
    const shot = await send(ws, nextId++, 'Page.captureScreenshot', { format: 'png', clip: { ...box, scale: 1 } })
    const png = decodePng(Buffer.from(shot.data, 'base64'))
    const titleBox = await evalJs(`(() => { const el = document.querySelector(${JSON.stringify(dialog.title)}).getBoundingClientRect()
      return { x0: Math.floor(el.left) - ${box.x}, y0: Math.floor(el.top) - ${box.y}, x1: Math.ceil(el.right) - ${box.x}, y1: Math.ceil(el.bottom) - ${box.y} } })()`)
    const titleDark = darkPixels(png, titleBox.x0, titleBox.y0, titleBox.x1, titleBox.y1)
    const cardDark = darkPixels(png, 0, 0, png.width, png.height)
    check(`${dialog.name} B title is painted`, titleDark >= 60, `${titleDark} dark px in the title box`)
    check(`${dialog.name} B card is painted`, cardDark >= 1200, `${cardDark} dark px on the card`)
  }

  console.log(`\n${failures.length ? 'FAIL' : 'OK'} dialog surfaces: ${passed} passed, ${failures.length} failed${failures.length ? ` — ${failures.join('; ')}` : ''}`)
  process.exitCode = failures.length ? 1 : 0
} finally {
  try { await send(ws, 9999, 'Browser.close') } catch {}
  await sleep(500)
  if (child.exitCode === null) { try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) } catch {} }
  await sleep(600)
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 }) } catch {}
}

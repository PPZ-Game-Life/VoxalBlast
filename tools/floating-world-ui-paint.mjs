// Does every control the player can press actually PAINT something?
//
// Why this exists (v0.13.0, and it exists because of a real miss): the UI skin moved the button
// art from `reference.css`'s `background-image` to the pack's SVG boards, and one round of that
// work cleared the background of BOTH button families while only giving it back to one of them.
// The sound / help / settings buttons stopped drawing entirely — and **every gate stayed green**,
// because they were still `<button>` elements with an `aria-label`, still the right size, still
// hit-testable, and the existing art gate only ever asks that the OLD art stops painting. Nothing
// asked that the NEW art paints.
//
// That is the failure mode this checks: a control that is present, sized, focusable and invisible.
// A screenshot shows it, but only if a human looks at that corner of that viewport; this looks at
// every control at two states, every time.
//
//   node tools/floating-world-ui-paint.mjs [url]
//
// It is deliberately COMPUTED-STYLE based, like the driver's `legacyArtHidden` check: the question
// "is there a paint source here" is answerable without reading the framebuffer, and reading the
// framebuffer for it would mean guessing which pixels belong to which control.
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
].find((p) => p && existsSync(p))
if (!EDGE) { console.error('no headless browser found'); process.exit(1) }

const url = process.argv[2] || 'http://127.0.0.1:5173/'
const WIDTH = 1440, HEIGHT = 900
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function send(ws, id, method, params = {}) {
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      const msg = JSON.parse(event.data)
      if (msg.id !== id) return
      ws.removeEventListener('message', onMessage)
      msg.error ? reject(new Error(`${method}: ${JSON.stringify(msg.error)}`)) : resolve(msg.result)
    }
    ws.addEventListener('message', onMessage)
    ws.send(JSON.stringify({ id, method, params }))
  })
}
async function connect(endpoint) {
  const ws = new WebSocket(endpoint)
  await new Promise((ok, no) => {
    ws.addEventListener('open', () => ok(), { once: true })
    ws.addEventListener('error', no, { once: true })
  })
  return ws
}

// A control PAINTS if it, or any descendant that is actually visible, has a background image, a
// non-transparent background colour, or a loaded bitmap. `border` is deliberately NOT counted: a
// 1px outline is not an icon, and a button whose only paint is its border is the exact
// "换 glyph 留旧底" case this is trying to catch.
const PROBE = `(() => {
  const paints = (el) => {
    const style = getComputedStyle(el)
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) < 0.05) return false
    if (style.backgroundImage && style.backgroundImage !== 'none') return true
    const bg = style.backgroundColor || ''
    const m = bg.match(/rgba?\\(([^)]+)\\)/)
    if (m) {
      const parts = m[1].split(',').map((v) => Number(v.trim()))
      const alpha = parts.length > 3 ? parts[3] : 1
      if (alpha > 0.05 && !(parts[0] > 250 && parts[1] > 250 && parts[2] > 250 && alpha === 0)) return true
    }
    for (const img of el.querySelectorAll('img')) {
      const s = getComputedStyle(img)
      if (s.visibility === 'hidden' || s.display === 'none') continue
      if (img.naturalWidth > 0 && img.getBoundingClientRect().width > 1) return true
    }
    for (const child of el.querySelectorAll('*')) {
      const s = getComputedStyle(child)
      if (s.visibility === 'hidden' || s.display === 'none') continue
      if (s.backgroundImage && s.backgroundImage !== 'none') return true
    }
    return false
  }
  const report = (selector) => [...document.querySelectorAll(selector)].map((el) => {
    const box = el.getBoundingClientRect()
    return {
      id: el.id || el.dataset.item || el.className.split(' ')[0],
      width: Math.round(box.width), height: Math.round(box.height),
      visible: box.width > 0 && box.height > 0 && getComputedStyle(el).visibility !== 'hidden',
      paints: paints(el),
    }
  })
  return JSON.stringify({
    live: report('#item-bar .item-button, .topbar .icon-button'),
  })
})()`

const HOME_PROBE = `(() => {
  const report = (selector) => [...document.querySelectorAll(selector)].map((el) => {
    const box = el.getBoundingClientRect()
    const style = getComputedStyle(el)
    // An <img> IS its own paint: it has no background and no children to look at. Checking only
    // descendants reported the logo and the record art as blank (v0.13.0 first run) — a gate that
    // cries wolf on the two elements it was written to protect.
    const selfImage = el.tagName === 'IMG' && el.naturalWidth > 0 && box.width > 1
    const inner = [...el.children].some((c) => {
      const s = getComputedStyle(c)
      if (s.display === 'none' || s.visibility === 'hidden') return false
      return (s.backgroundImage && s.backgroundImage !== 'none')
        || (c.tagName === 'IMG' && c.naturalWidth > 0 && c.getBoundingClientRect().width > 1)
        || (c.tagName === 'CANVAS' && c.width > 1 && c.getBoundingClientRect().width > 1)
    })
    const bg = style.backgroundColor || ''
    const m = bg.match(/rgba?\\(([^)]+)\\)/)
    const alpha = m ? (m[1].split(',').length > 3 ? Number(m[1].split(',')[3]) : 1) : 0
    return {
      id: el.id || el.className.split(' ')[0],
      width: Math.round(box.width), height: Math.round(box.height),
      visible: box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none',
      paints: selfImage || inner || (style.backgroundImage && style.backgroundImage !== 'none') || alpha > 0.05,
    }
  })
  return JSON.stringify({
    home: report('.home-primary, .home-secondary, .home-record-art, .home-logo'),
  })
})()`

// Zero visible references to the retired skins (correction handoff §9.1 「可见背景已不是 valley
// 画作/旧SVG」「不存在旧金边混搭」; §9.3 「旧 backdrop DOM/图片加载断言要同批改掉」).
//
// WHY A SECOND CHECK RATHER THAN TRUSTING THE RESKIN: the driver's `legacyArtHidden` only asks that
// the injected `svg.toy-icon` does not paint on top of a host that still carries reference art. It
// never asks whether old art is visible SOMEWHERE ELSE, so a panel this skin forgot to cover stays
// green — which is exactly what the settings/leaderboard/game-over cards were until this round.
//
// Two paint paths are scanned because the pack's UI uses both: `background-image` (boards, glyphs,
// plates) and `<img src>` (the cover's icons). Visibility uses the same test as the paint check, so
// an element that is merely hidden (the home cover hides the whole game layout) is not a hit.
const LEGACY_SCAN = `(() => {
  const LEGACY = ['/art/ui-redesign/', '/art/reference/', '/art/pastoral']
  const visible = (el) => {
    const s = getComputedStyle(el)
    const b = el.getBoundingClientRect()
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05 && b.width > 1 && b.height > 1
  }
  const describe = (el) => el.id
    ? '#' + el.id
    : el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/).join('.') : '')
  const hits = []
  for (const el of document.querySelectorAll('#app, #app *')) {
    const bg = getComputedStyle(el).backgroundImage
    if (!bg || bg === 'none') continue
    const path = LEGACY.find((p) => bg.includes(p))
    if (path && visible(el)) hits.push({ el: describe(el), how: 'background-image', path, value: bg.slice(0, 140) })
  }
  for (const img of document.querySelectorAll('img')) {
    const src = img.getAttribute('src') || ''
    const path = LEGACY.find((p) => src.includes(p))
    if (path && visible(img)) hits.push({ el: describe(img), how: 'img src', path, value: src })
  }
  return JSON.stringify(hits)
})()`

const profile = mkdtempSync(join(tmpdir(), 'voxalblast-shot-'))
const child = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--disable-breakpad', '--hide-scrollbars',
  '--no-first-run', '--no-default-browser-check', '--force-device-scale-factor=1',
  '--run-all-compositor-stages-before-draw', '--remote-debugging-port=0',
  `--user-data-dir=${profile}`, `--window-size=${WIDTH},${HEIGHT}`, 'about:blank',
], { stdio: 'ignore', windowsHide: true })

let port = null
for (let i = 0; i < 80 && !port; i += 1) {
  try { port = Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]) } catch { await sleep(250) }
}
const info = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
const browserSocket = await connect(info.webSocketDebuggerUrl)
const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json()
const ws = await connect(target.webSocketDebuggerUrl)
await send(ws, 1, 'Page.enable')
await send(ws, 2, 'Runtime.enable')
await send(ws, 4, 'Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, screenWidth: WIDTH, screenHeight: HEIGHT, deviceScaleFactor: 1, mobile: false })
await send(ws, 5, 'Page.navigate', { url })
await sleep(4200)
for (let i = 0; i < 60; i += 1) {
  const r = await send(ws, 200 + i, 'Runtime.evaluate', { expression: 'JSON.stringify(globalThis.__voxalblast?.intro?.() ?? null)', returnByValue: true })
  const wave = r.result?.value && r.result.value !== 'null' ? JSON.parse(r.result.value) : null
  if (wave && !wave.active) break
  await sleep(150)
}
await send(ws, 300, 'Runtime.evaluate', { expression: 'globalThis.__voxalblastDev?.setBoardFloat?.({ frozen: true, time: 0 }); 1', returnByValue: true })

// A gate that has never been shown to fail is a gate nobody should trust. `UI_PAINT_SELFTEST=1`
// blanks one control the gate has just called painted, and inverts the expectation: the run
// PASSES only if the gate now reports a failure. That is how the check proves it can see the
// thing it was written for — the bug that prompted it (a button family whose background was
// cleared and never replaced) looked exactly like this.
const SELFTEST = process.env.UI_PAINT_SELFTEST === '1'
if (SELFTEST) {
  await send(ws, 301, 'Runtime.evaluate', {
    expression: `(() => {
      const style = document.createElement('style')
      style.textContent = '#item-bar .item-button, #item-bar .item-button * { background-image: none !important; background-color: transparent !important; }'
      document.head.appendChild(style)
      return 1
    })()`,
    returnByValue: true,
  })
}

const failures = []
const check = (state, rows) => {
  for (const row of rows) {
    if (!row.visible) continue
    if (!row.paints) failures.push(`${state}: ${row.id} (${row.width}x${row.height}) is present and pressable but paints nothing`)
  }
}

const live = JSON.parse((await send(ws, 400, 'Runtime.evaluate', { expression: PROBE, returnByValue: true })).result.value)
check('live run', live.live)
console.log(`live run   ${live.live.length} control(s); ${live.live.filter((r) => r.visible).length} visible`)

// The retired skins, scanned in each state that paints a different surface: the board (HUD, tools,
// tray, top bar), the cover, and the two dialogs whose cards this skin had not covered until now.
const legacy = []
const scanLegacy = async (id, label) => {
  const hits = JSON.parse((await send(ws, id, 'Runtime.evaluate', { expression: LEGACY_SCAN, returnByValue: true })).result.value)
  console.log(`legacy     ${label.padEnd(18)} ${hits.length} visible reference(s)`)
  for (const hit of hits) legacy.push({ state: label, ...hit })
}
await scanLegacy(500, 'board')

await send(ws, 401, 'Runtime.evaluate', {
  expression: '(() => { document.querySelector("#settings-button").click(); document.querySelector("#home-setting").click(); return 1 })()',
  returnByValue: true,
})
await sleep(900)
const home = JSON.parse((await send(ws, 402, 'Runtime.evaluate', { expression: HOME_PROBE, returnByValue: true })).result.value)
check('home cover', home.home)
console.log(`home cover ${home.home.length} control(s); ${home.home.filter((r) => r.visible).length} visible`)
await scanLegacy(501, 'home cover')
// The two dialog cards, each open in turn on the cover. `#home-leaderboard` and `#home-settings`
// are the cover's own entry points, so this drives the same path the player does.
await send(ws, 502, 'Runtime.evaluate', {
  expression: '(() => { document.querySelector("#home-settings").click(); return 1 })()',
  returnByValue: true,
})
await sleep(500)
await scanLegacy(503, 'settings panel')
await send(ws, 504, 'Runtime.evaluate', {
  expression: '(() => { document.querySelector("#settings-close").click(); document.querySelector("#home-leaderboard").click(); return 1 })()',
  returnByValue: true,
})
await sleep(500)
await scanLegacy(505, 'leaderboard panel')

for (const row of [...live.live, ...home.home]) {
  if (row.visible && row.paints) console.log(`  ok   ${row.id} ${row.width}x${row.height}`)
}
if (legacy.length) {
  for (const hit of legacy) failures.push(`${hit.state}: ${hit.el} still paints the retired skin via ${hit.how} (${hit.path}) — ${hit.value}`)
}
if (SELFTEST) {
  console.log(`self-test: expected the blanked tool tiles to be reported (${failures.length} failure(s))`)
  console.log(failures.length ? 'self-test: OK — the gate can fail' : 'self-test: FAILED — the gate did not notice a blank control')
  await send(browserSocket, 1000, 'Browser.close').catch(() => {})
  await sleep(800)
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 8 }) } catch {}
  process.exit(failures.length ? 0 : 1)
}
if (failures.length) {
  for (const message of failures) console.error(`FAIL ${message}`)
  console.error(`\nfloating-world-ui-paint: ${failures.length} control(s) paint nothing`)
  await send(browserSocket, 1000, 'Browser.close').catch(() => {})
  await sleep(800)
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 8 }) } catch {}
  process.exit(1)
}
console.log('floating-world-ui-paint: every visible control paints something')
await send(browserSocket, 1000, 'Browser.close').catch(() => {})
await sleep(800)
try { rmSync(profile, { recursive: true, force: true, maxRetries: 8 }) } catch {}
process.exit(0)

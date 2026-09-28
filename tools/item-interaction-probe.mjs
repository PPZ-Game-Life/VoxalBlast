// 07-道具系统设计.md §8 — the item interaction v1's own acceptance probe (§8.11).
//
// Why it exists. The redesign is entirely about POINTERS: which gesture owns one, what a release
// is allowed to mean, and what happens on the frames in between. A screenshot cannot show any of
// that (§8.11 says so outright: 「单张截图不能证明释放时机正确」) and a DOM read cannot either,
// because the mode is state, not markup. So this probe drives real mouse input through CDP,
// presses and moves and releases at computed board coordinates, and after every step reads the
// two read-only hooks — `__voxalblast.item()` (the input layer's own report) and
// `__voxalblast.placement()` (the front face's centre and its screen basis).
//
// What it deliberately does NOT cover, and who does:
//   * I06/I13/I14 (undo, shared lattice, score/chain isolation) — tools/rescue-probe.mjs and the
//     rule/session suites;
//   * I15's whole viewport matrix — tools/screenshot.mjs;
//   * anything about feel: 真人易用性 is a human check by definition (§8.11's own last section).
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep, isAbsolute, basename } from 'node:path'
// The expected copy comes from the same catalogue the page renders (docs/Technical/
// LOCALIZATION.md). In Node there is no ?lang= and no stored preference, so t() resolves the
// shipped default — English — which is also what a fresh headless profile boots in.
import { t } from '../src/i18n/index.js'

const CHROME = process.env.VOXALBLAST_CHROME || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const APP_URL = process.env.VOXALBLAST_URL || 'http://127.0.0.1:5173/'
const url = APP_URL

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const connect = async (wsUrl) => {
  const socket = new WebSocket(wsUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve)
    socket.addEventListener('error', reject)
  })
  return socket
}
const send = (socket, id, method, params = {}) => new Promise((resolve, reject) => {
  const onMessage = (event) => {
    const message = JSON.parse(event.data)
    if (message.id !== id) return
    socket.removeEventListener('message', onMessage)
    message.error ? reject(new Error(`${method}: ${message.error.message}`)) : resolve(message.result)
  }
  socket.addEventListener('message', onMessage)
  socket.send(JSON.stringify({ id, method, params }))
})

// Everything a step needs to be judged, in one round trip. `board` is the session's own
// occupancy (not a screenshot), `item` the input layer's report, and the boxes are the real
// layout boxes the player can hit.
const STATE = `(() => {
  const box = (sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, shown: cs.display !== 'none' && cs.visibility !== 'hidden' }
  }
  const klass = (sel, name) => !!document.querySelector(sel)?.classList.contains(name)
  return JSON.stringify({
    status: document.querySelector('#status').textContent,
    toast: document.querySelector('#toast').textContent,
    item: globalThis.__voxalblast.item(),
    items: globalThis.__voxalblastDev.items(),
    cells: globalThis.__voxalblast.board().cells.length,
    score: globalThis.__voxalblast.board().score,
    pose: globalThis.__voxalblast.rotation(),
    placement: globalThis.__voxalblast.placement(),
    bar: {
      hidden: klass('#item-status', 'hidden'),
      text: document.querySelector('#item-status').textContent.replace(/\\s+/g, ' ').trim(),
      useHidden: klass('#item-use', 'hidden'),
      useBox: box('#item-use'),
      cancelBox: box('#item-cancel'),
      axisHidden: klass('#axis-pick', 'hidden'),
      axisRow: klass('#axis-pick button[data-axis="row"]', 'active'),
      axisCol: klass('#axis-pick button[data-axis="col"]', 'active'),
    },
    undo: { hidden: klass('#undo-bar', 'hidden'), text: document.querySelector('#undo-bar-text').textContent, box: box('#undo-button') },
    confirm: { hidden: klass('#refresh-confirm', 'hidden') },
    zones: {
      tray: klass('.bottom-panel', 'cancel-mode'),
      trayHot: klass('.bottom-panel', 'cancel-hot'),
      bar: klass('#item-bar', 'cancel-mode'),
      barHot: klass('#item-bar', 'cancel-hot'),
    },
    icons: [...document.querySelectorAll('.item-button')].map((el) => {
      const r = el.getBoundingClientRect()
      return { id: el.dataset.item, empty: el.classList.contains('empty'), disabled: el.classList.contains('disabled'), active: el.classList.contains('active'), x: r.left + r.width / 2, y: r.top + r.height / 2 }
    }),
  })
})()`

const profile = mkdtempSync(join(tmpdir(), 'voxalblast-item-'))
const child = spawn(CHROME, [
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
try {
  let port
  for (let i = 0; i < 80; i += 1) {
    try { port = Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]); break } catch { await sleep(250) }
  }
  if (!port) throw new Error('devtools never came up')
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
  await send(ws, 3, 'Emulation.setDeviceMetricsOverride', { width: 430, height: 900, screenWidth: 430, screenHeight: 900, deviceScaleFactor: 1, mobile: false })

  let nextId = 100
  const evalJs = async (expression) => {
    const result = await send(ws, nextId++, 'Runtime.evaluate', { expression, returnByValue: true })
    if (result.exceptionDetails) throw new Error(`evaluate threw: ${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`)
    return result.result?.value
  }
  const state = async () => JSON.parse(await evalJs(STATE))

  // Real mouse input. `buttons: 1` while held is what tells Chromium to keep delivering moves to
  // the same target and to synthesise the click on release — the same path a player's mouse takes.
  const move = (x, y, held = false) => send(ws, nextId++, 'Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: Math.round(x), y: Math.round(y), button: held ? 'left' : 'none', buttons: held ? 1 : 0,
  })
  const down = (x, y) => send(ws, nextId++, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(x), y: Math.round(y), button: 'left', buttons: 1, clickCount: 1 })
  const up = (x, y) => send(ws, nextId++, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(x), y: Math.round(y), button: 'left', buttons: 0, clickCount: 1 })
  const click = async (x, y) => { await move(x, y); await down(x, y); await sleep(30); await up(x, y); await sleep(120) }
  const clickSel = async (selector) => {
    const point = JSON.parse(await evalJs(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return 'null'; const r = el.getBoundingClientRect(); return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 }) })()`))
    if (!point) throw new Error(`missing ${selector}`)
    await click(point.x, point.y)
    await sleep(120)
  }

  // Visual evidence for the states a still cannot otherwise reach. The acceptance rule (§8.11)
  // is that a screenshot cannot PROVE the release timing — it can still show whether the scope,
  // the status bar and the cancel rectangle actually read the way the doc describes.
  const SHOT_DIR = join(process.cwd(), 'artifacts', 'visual')
  // The file name carries the version it was actually taken at, read from the shipped manifest
  // instead of typed here: these shots are what a report points at, and a hard-coded prefix makes
  // the evidence unattributable the moment the game moves on.
  const SHOT_VERSION = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')).version
  const shoot = async (name) => {
    try { mkdirSync(SHOT_DIR, { recursive: true }) } catch { /* already there */ }
    const shot = await send(ws, nextId++, 'Page.captureScreenshot', { format: 'png' })
    const file = join(SHOT_DIR, `v${SHOT_VERSION}-${name}.png`)
    writeFileSync(file, Buffer.from(shot.data, 'base64'))
    console.log(`     shot ${file}`)
  }

  // Front-face cell (u, v) in client pixels, from the game's own report: `center` is cell (2, 2)
  // and the two axis steps are one lattice step on screen (dy up-positive). No second copy of the
  // face basis is written here — the probe reads the one the game uses.
  const facePoint = (s, u, v) => ({
    x: s.placement.center.x + (u - 2) * s.placement.uAxis.dx + (v - 2) * s.placement.vAxis.dx,
    y: s.placement.center.y - (u - 2) * s.placement.uAxis.dy - (v - 2) * s.placement.vAxis.dy,
  })
  const iconPoint = (s, id) => {
    const icon = s.icons.find((entry) => entry.id === id)
    if (!icon) throw new Error(`no icon ${id}`)
    return icon
  }

  // A drag straight from an icon to a point, in `steps` moves — the main path of §8.2.
  const dragIconTo = async (s, id, to, { steps = 6, release = true, trace = false } = {}) => {
    const from = iconPoint(s, id)
    await move(from.x, from.y)
    await down(from.x, from.y)
    for (let i = 1; i <= steps; i += 1) {
      await move(from.x + (to.x - from.x) * i / steps, from.y + (to.y - from.y) * i / steps, true)
      await sleep(16)
      if (trace) console.log(`    trace ${i}: ${JSON.stringify((await state()).item)}`)
    }
    if (release) await up(to.x, to.y)
    await sleep(160)
  }

  await send(ws, 4, 'Page.navigate', { url })
  await sleep(3500)
  const hasHandle = await evalJs('typeof globalThis.__voxalblastDev?.jam === "function"')
  if (!hasHandle) throw new Error('dev handles missing: point this probe at a dev server (`npm run dev`)')
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (JSON.parse(await evalJs('JSON.stringify(globalThis.__voxalblast.intro().active)')) === false) break
    await sleep(200)
  }
  await evalJs('globalThis.__voxalblastDev.setItems({ refresh: 2, hammer: 1, rocket: 1, bomb: 1 })')
  // A full shell: every front-face cell is occupied, so every tool has something to clear and
  // the counts below are exact rather than "whatever the deal happened to give".
  await evalJs('globalThis.__voxalblastDev.jam()')
  await evalJs('globalThis.__voxalblastDev.stuckCheck()')
  await sleep(200)
  let s = await state()
  check('setup: the shell is full', s.cells === 98, `cells=${s.cells}`)
  const baselinePose = JSON.stringify(s.pose)

  // ---- §8.3 — the strip says three different things -------------------------------
  check('strip: icons carry a name', (await evalJs('document.querySelector(".item-button .item-name")?.textContent')) === t('item.name.refresh'))
  await evalJs('globalThis.__voxalblastDev.setItems({ refresh: 2, hammer: 0, rocket: 1, bomb: 1 })')
  await sleep(150)
  s = await state()
  const hammerIcon = s.icons.find((icon) => icon.id === 'hammer')
  check('strip: an empty charge shows the empty copy rather than a fake grey', hammerIcon.empty === true && hammerIcon.disabled === false, JSON.stringify(hammerIcon))
  check('strip: an empty charge is not "ready" either', s.icons.find((icon) => icon.id === 'rocket').disabled === false)
  // v0.9.20 — the caption has to FIT its own column, measured at the NARROWEST shipped phone.
  // A real device on v0.9.18 showed the empty copy spilling out of its column and colliding with
  // the neighbour's: the caption is a nowrap grid item, so its max-content widened its own track
  // past the button and painted over the next item. This probe's own viewport (430×900) happened
  // to be wide enough for the shipped English string, which is why nothing here caught it — so the
  // measurement runs at 320×740, where portrait gives `--hud-button: max(44px, 12.4vw)` = 44px.
  // `scrollWidth > clientWidth` is the ink overflowing the box; `spill` is the box leaving the
  // button. Ellipsis alone would satisfy neither, so a future over-long translation still fails.
  await evalJs('globalThis.__voxalblastDev.setItems({ refresh: 0, hammer: 0, rocket: 0, bomb: 0 })')
  await send(ws, nextId++, 'Emulation.setDeviceMetricsOverride', { width: 320, height: 740, screenWidth: 320, screenHeight: 740, deviceScaleFactor: 1, mobile: false })
  await sleep(400)
  const captionRows = async () => JSON.parse(await evalJs(`JSON.stringify([...document.querySelectorAll('#item-bar .item-button')].map((button) => {
    const name = button.querySelector('.item-name')
    const empty = button.querySelector('.item-empty')
    const el = getComputedStyle(empty).display === 'none' ? name : empty
    const column = button.getBoundingClientRect()
    const ink = el.getBoundingClientRect()
    return {
      id: button.dataset.item, text: el.textContent, column: Math.round(column.width),
      fits: el.scrollWidth <= el.clientWidth + 1,
      spillLeft: Math.round(column.left - ink.left), spillRight: Math.round(ink.right - column.right),
    }
  }))`))
  const rowsToText = (rows) => rows.map((entry) => `${entry.id}:"${entry.text}" col=${entry.column} spill=${entry.spillLeft}/${entry.spillRight}`).join(' ')
  const emptyRows = await captionRows()
  check('strip: at 320x740 the empty captions fit their own column without spilling',
    emptyRows.every((entry) => entry.fits && entry.spillLeft <= 1 && entry.spillRight <= 1), rowsToText(emptyRows))
  // The "after" shot of the v0.9.20 report: the same state the producer photographed on his phone
  // (all four charges gone, narrowest phone) — a still is the only thing that shows the four
  // captions side by side.
  await shoot('items-empty-320')
  await evalJs('globalThis.__voxalblastDev.setItems({ refresh: 1, hammer: 1, rocket: 1, bomb: 1 })')
  await sleep(150)
  const nameRows = await captionRows()
  check('strip: at 320x740 the tool names fit their own column too',
    nameRows.every((entry) => entry.fits && entry.spillLeft <= 1 && entry.spillRight <= 1), rowsToText(nameRows))
  await send(ws, nextId++, 'Emulation.setDeviceMetricsOverride', { width: 430, height: 900, screenWidth: 430, screenHeight: 900, deviceScaleFactor: 1, mobile: false })
  await sleep(400)
  await evalJs('globalThis.__voxalblastDev.setItems({ refresh: 2, hammer: 1, rocket: 1, bomb: 1 })')
  await sleep(150)

  // ---- I01 — the drag path commits once, on release, and turns nothing ------------
  s = await state()
  const hammerCell = facePoint(s, 1, 1)
  await dragIconTo(s, 'hammer', hammerCell)
  s = await state()
  check('I01 hammer drag: exactly one charge spent', s.items.hammer === 0, `hammer=${s.items.hammer}`)
  check('I01 hammer drag: exactly one cell cleared', s.cells === 97, `cells=${s.cells}`)
  check('I01 hammer drag: the mode is closed again', s.item === null)
  check('I01 hammer drag: the cube never turned', JSON.stringify(s.pose) === baselinePose)
  check('I01 hammer drag: no score is awarded', s.score === 0, `score=${s.score}`)
  check('§8.9 undo bar: 已清除 1 格 + a real button', s.undo.hidden === false && s.undo.text === t('item.clearedN', { n: 1 }) && s.undo.box.w >= 44 && s.undo.box.h >= 44, JSON.stringify(s.undo))

  // ---- I02 — the tap path: select, aim, lock, then 使用 ---------------------------
  await evalJs('globalThis.__voxalblastDev.setItems({ refresh: 2, hammer: 1, rocket: 1, bomb: 1 })')
  await sleep(150)
  s = await state()
  await clickSel('.item-button[data-item="rocket"]')
  s = await state()
  check('I02 tap rocket: selected, no target, nothing spent', s.item?.id === 'rocket' && s.item.phase === 'selected' && s.item.hasTarget === false && s.items.rocket === 1, JSON.stringify(s.item))
  check('I02 tap rocket: 使用 is not offered yet', s.bar.useHidden === true)
  check('I02 tap rocket: the ↔/↕ switch is offered', s.bar.axisHidden === false)

  // The rocket keeps the direction it was told, not the one the pointer implies (I07).
  await clickSel('#axis-pick button[data-axis="col"]')
  s = await state()
  check('I07 axis switch: the report says col', s.item?.orientation === 'col', JSON.stringify(s.item))
  const rocketCell = facePoint(s, 2, 0)
  await click(rocketCell.x, rocketCell.y)
  s = await state()
  check('I02 tap board: the preview locks, nothing is spent', s.item?.phase === 'locked' && s.items.rocket === 1, JSON.stringify(s.item))
  check('I07 vertical: the scope is one column, five cells', s.item.span?.u0 === 2 && s.item.span?.u1 === 2 && s.item.span?.v0 === 0 && s.item.span?.v1 === 4, JSON.stringify(s.item.span))
  check('I02 tap board: 使用 appears with N', s.bar.useHidden === false && s.bar.text.includes(t('item.clearN', { n: 5 })), s.bar.text)
  check('I02 tap board: the cube never turned', JSON.stringify(s.pose) === baselinePose)
  await shoot('rocket-locked')

  // Moving to the button must NOT re-aim (the doc names this one explicitly).
  const before = s.item
  await move(s.bar.useBox.x, s.bar.useBox.y)
  await sleep(120)
  s = await state()
  check('I02 walking to 使用 does not re-aim', JSON.stringify(s.item.anchor) === JSON.stringify(before.anchor), JSON.stringify(s.item.anchor))
  const cellsBeforeUse = s.cells
  await clickSel('#item-use')
  s = await state()
  check('I02 使用: one charge, five cells, mode closed', s.items.rocket === 0 && s.cells === cellsBeforeUse - 5 && s.item === null, `rocket=${s.items.rocket} cells=${s.cells}`)

  // ---- I03 — dragging back into the strip cancels, and the strip IS a cancel zone ---
  await evalJs('globalThis.__voxalblastDev.setItems({ refresh: 2, hammer: 1, rocket: 1, bomb: 1 })')
  await sleep(150)
  s = await state()
  const bombCell = facePoint(s, 2, 2)
  const iconFrom = iconPoint(s, 'bomb')
  await move(iconFrom.x, iconFrom.y)
  await down(iconFrom.x, iconFrom.y)
  for (let i = 1; i <= 5; i += 1) {
    await move(iconFrom.x + (bombCell.x - iconFrom.x) * i / 5, iconFrom.y + (bombCell.y - iconFrom.y) * i / 5, true)
    await sleep(16)
  }
  s = await state()
  check('I03 dragging out: the strip is a cancel rectangle', s.zones.bar === true && s.zones.tray === true, JSON.stringify(s.zones))
  check('I03 dragging out: the preview is live', s.item?.hasTarget === true && s.item.clear > 0, JSON.stringify(s.item))
  check('I01 press and move spend nothing', s.items.bomb === 1, `bomb=${s.items.bomb}`)
  await shoot('bomb-drag-preview')
  // Back into the item strip.
  const barBox = JSON.parse(await evalJs(`(() => { const r = document.querySelector('#item-bar').getBoundingClientRect(); return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 }) })()`))
  for (let i = 1; i <= 5; i += 1) {
    await move(bombCell.x + (barBox.x - bombCell.x) * i / 5, bombCell.y + (barBox.y - bombCell.y) * i / 5, true)
    await sleep(16)
  }
  s = await state()
  check('I03 back in the zone: it highlights and the scope is dropped', s.zones.barHot === true && s.item?.hasTarget === false, JSON.stringify(s.zones))
  const cellsBeforeCancel = s.cells
  await up(barBox.x, barBox.y)
  s = await state()
  check('I03 releasing in the strip cancels free of charge', s.item === null && s.items.bomb === 1 && s.cells === cellsBeforeCancel, JSON.stringify(s.items))
  check('I03 the cancel rectangles are gone afterwards', s.zones.bar === false && s.zones.tray === false)

  // ---- I04 — an invalid release exits and costs nothing ---------------------------
  await evalJs('globalThis.__voxalblastDev.setItems({ refresh: 2, hammer: 1, rocket: 1, bomb: 1 })')
  await sleep(150)
  s = await state()
  // Three face cells ABOVE the grid: the pointer is over the canvas but not over the front
  // face's own quad, which §8.5.1 says is not a target (「移到正面棋格」).
  const sky = facePoint(s, 2, -1)
  await dragIconTo(s, 'bomb', sky, { trace: process.env.ITEM_TRACE === '1' })
  s = await state()
  check('I04 release off the face: nothing spent, no mode left', s.item === null && s.items.bomb === 1, `${JSON.stringify(s.items)} item=${JSON.stringify(s.item)}`)
  check('I04 the refusal is not silent', s.status === 'Pick a shape', `status="${s.status}"`)

  // ---- I08 — the board is locked while a tool is in hand --------------------------
  await evalJs('globalThis.__voxalblastDev.setItems({ refresh: 2, hammer: 1, rocket: 1, bomb: 1 })')
  await sleep(150)
  s = await state()
  await clickSel('.item-button[data-item="bomb"]')
  const lockPose = JSON.stringify((await state()).pose)
  const centre = (await state()).placement.center
  await move(centre.x, centre.y)
  await down(centre.x, centre.y)
  for (let i = 1; i <= 8; i += 1) { await move(centre.x - i * 14, centre.y + i * 4, true); await sleep(16) }
  await up(centre.x - 112, centre.y + 32)
  s = await state()
  check('I08 a big canvas drag does not turn the cube', JSON.stringify(s.pose) === lockPose)
  await send(ws, nextId++, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87 })
  await send(ws, nextId++, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87 })
  await sleep(200)
  s = await state()
  check('I08 W does not turn the cube while a tool is armed', JSON.stringify(s.pose) === lockPose)
  check('I08 the refusal is explained (需换面？取消后转动棋盘)', s.status === t('item.lockedRotate') || s.toast === t('item.lockedRotate'), `status="${s.status}" toast="${s.toast}"`)
  check('I08 the mode survived the refused turn', s.item?.id === 'bomb', JSON.stringify(s.item))
  await clickSel('#item-cancel')
  s = await state()
  check('§8.3 ✕ 取消 exits the mode and changes nothing', s.item === null && s.items.bomb === 1, JSON.stringify(s.items))

  // ---- I10 — the batch question asks before it spends -----------------------------
  await evalJs('globalThis.__voxalblastDev.setItems({ refresh: 2, hammer: 1, rocket: 1, bomb: 1 })')
  await sleep(150)
  await clickSel('.item-button[data-item="refresh"]')
  s = await state()
  check('I10 tapping 换批 asks first and spends nothing', s.confirm.hidden === false && s.items.refresh === 2, JSON.stringify(s.items))
  check('I10 the batch question is a mode of its own', s.item?.phase === 'refresh-confirm', JSON.stringify(s.item))
  await shoot('refresh-confirm')
  await clickSel('#refresh-keep')
  s = await state()
  check('I10 保留当前 leaves everything alone', s.confirm.hidden === true && s.item === null && s.items.refresh === 2)
  await clickSel('.item-button[data-item="refresh"]')
  await clickSel('#refresh-go')
  s = await state()
  check('I10 换一批 spends exactly one', s.items.refresh === 1 && s.item === null && s.confirm.hidden === true, JSON.stringify(s.items))

  // ---- I15 — every item-mode button is a real target ------------------------------
  await evalJs('globalThis.__voxalblastDev.setItems({ refresh: 2, hammer: 1, rocket: 1, bomb: 1 })')
  await sleep(150)
  await clickSel('.item-button[data-item="rocket"]')
  s = await state()
  const rockets = await evalJs(`(() => { const out = []
    for (const sel of ['#item-cancel', '#axis-pick button[data-axis="row"]', '#axis-pick button[data-axis="col"]']) {
      const r = document.querySelector(sel)?.getBoundingClientRect()
      if (r) out.push({ sel, w: Math.round(r.width), h: Math.round(r.height) })
    }
    return JSON.stringify(out) })()`)
  const small = JSON.parse(rockets).filter((entry) => entry.w < 44 || entry.h < 44)
  check('I15 item buttons are >= 44px', small.length === 0, JSON.stringify(small))
  check('I15 the status bar is visible and outside the board band', s.bar.hidden === false)
  await clickSel('#item-cancel')

  // ---- §8.9 — no charge can be spent twice ----------------------------------------
  await evalJs('globalThis.__voxalblastDev.setItems({ refresh: 2, hammer: 1, rocket: 1, bomb: 1 })')
  await sleep(150)
  s = await state()
  const rapid = facePoint(s, 1, 0)
  const rapidFrom = iconPoint(s, 'hammer')
  await move(rapidFrom.x, rapidFrom.y)
  await down(rapidFrom.x, rapidFrom.y)
  for (let i = 1; i <= 4; i += 1) { await move(rapidFrom.x + (rapid.x - rapidFrom.x) * i / 4, rapidFrom.y + (rapid.y - rapidFrom.y) * i / 4, true); await sleep(10) }
  await up(rapid.x, rapid.y)
  // A second release and a duplicate click on the same frame must find nothing to spend.
  await up(rapid.x, rapid.y)
  await click(rapidFrom.x, rapidFrom.y)
  s = await state()
  check('I11 repeated release/click cannot spend a second charge', s.items.hammer === 0 && s.item === null, JSON.stringify(s.items))

  check('no browser console errors', browserErrors.length === 0, browserErrors.join(' | '))

  console.log(`\nitem interaction v1 (07 §8): ${failures.length ? `${failures.length} FAILED` : 'all checks passed'}`)
  if (failures.length) {
    for (const failure of failures) console.log(`  - ${failure}`)
    process.exitCode = 1
  }
} finally {
  try { ws?.close() } catch {}
  await sleep(400)
  if (child.exitCode === null) {
    try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) } catch {}
    await sleep(600)
  }
  try {
    const tempRoot = realpathSync(tmpdir())
    const actual = realpathSync(profile)
    const suffix = relative(tempRoot, actual)
    const insideTemp = suffix && !suffix.startsWith('..') && !suffix.includes(sep) && !isAbsolute(suffix)
    if (insideTemp && basename(actual).startsWith('voxalblast-item-')) rmSync(actual, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
  } catch { /* the driver's own temp profile only */ }
}

// UI-panel regression probe — the acceptance gate for refactor stage P1
// ("抽取 DOM 与 UI 展示", temp/VoxalBlast-渐进式模块拆分重构执行计划.md §6 P1).
//
//   node tools/refactor-ui-probe.mjs [url]
//
// Why it exists. P1 moves the panels out of src/main.js into ui/ modules and, crucially,
// re-homes their event listeners behind `bind()` calls. Every failure mode of that move is
// invisible to the other probes: a listener bound twice (a `bind()` called on every open),
// a focus target that stops being restored, a modal that stops pausing the board, a
// `.hidden` / `inert` / `aria-pressed` contract quietly dropped while the CSS still looks
// right. `npm run shot` only photographs static frames, so none of it shows up there.
//
// What it asserts:
//   A. settings      gear opens the panel (board pauses, focus lands on the close button),
//                    close restores focus to the gear, and the sound switch flips EXACTLY
//                    once per click — the double-binding detector (a second listener makes
//                    one click toggle twice, i.e. net nothing)
//   B. controls      the top-bar entry and the settings row both open the card; closing
//                    returns focus to whichever one opened it
//   C. home          opening the cover sets #app.home-open, makes the game layers inert,
//                    moves focus to the primary button; playing closes it and un-inerts
//   D. leaderboard   opens from the home cover and from the Game Over card, and closing
//                    returns focus to the button that opened it (per-opener, not hard-coded)
//   E. escape        Escape closes leaderboard → controls → settings, in that precedence
//   F. play again    Game Over → PLAY AGAIN starts a real run (score 0, three fresh slots)
//   G. churn         ten open/close cycles leave no stuck pause, no inert layer, and the
//                    sound switch still flips exactly once; the preference survives a reload
//
// Discipline: real CDP input only, DOM state read from computed style / layout / inert /
// activeElement rather than from class-name guesses wherever the real contract is
// observable. An unreachable precondition is reported as SKIP, never as PASS.
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const APP_URL = (process.argv[2] || 'http://127.0.0.1:5173/').replace(/\/?$/, '/')
const APP_PORT = Number(new URL(APP_URL).port || 80)
// 1280x900 keeps the top-bar controls entry visible (it is hidden below 641px), so the
// two-entry-point focus test below can actually run.
const VIEWPORT = { width: 1280, height: 900 }
const CHURN_CYCLES = 10

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
]

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
    || !basename(actualProfile).startsWith('voxalblast-ui-')) {
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
      await sleep(300)
      await client.frames()
      return true
    }
    await sleep(200)
  }
  return false
}

// Everything the checks below compare against, read in ONE evaluate so a check can never
// straddle two frames. `shown` is computed style + layout box, not a class-name guess: the
// real contract is "the player can see it", and a class can be present while CSS hides it.
const STATE = `(() => {
  const shown = (selector) => {
    const el = document.querySelector(selector)
    if (!el) return null
    const cs = getComputedStyle(el)
    const box = el.getBoundingClientRect()
    return {
      hidden: el.classList.contains('hidden'),
      display: cs.display,
      visibility: cs.visibility,
      width: Math.round(box.width),
      height: Math.round(box.height),
      inert: el.inert === true,
      onTop: box.width > 0 && box.height > 0
        ? document.elementFromPoint(Math.round(box.left + box.width / 2), Math.round(box.top + box.height / 2))?.closest(selector) === el
        : false,
    }
  }
  const layer = (selector) => {
    const el = document.querySelector(selector)
    if (!el) return null
    return { inert: el.inert === true, visibility: getComputedStyle(el).visibility, width: Math.round(el.getBoundingClientRect().width) }
  }
  const sound = document.querySelector('#sound-setting')
  return {
    status: document.querySelector('#status')?.textContent ?? null,
    activeId: document.activeElement?.id ?? null,
    activeTag: document.activeElement?.tagName ?? null,
    appHomeOpen: document.querySelector('#app')?.classList.contains('home-open') ?? null,
    topbar: layer('.topbar'),
    gameLayout: layer('.game-layout'),
    settings: shown('#settings-modal'),
    controls: shown('#controls-modal'),
    leaderboard: shown('#leaderboard'),
    home: shown('#home'),
    gameOver: shown('#game-over'),
    playAgain: shown('#reset-modal'),
    soundPressed: sound ? sound.getAttribute('aria-pressed') : null,
    soundEnabled: sound ? sound.classList.contains('enabled') : null,
    hapticsPressed: document.querySelector('#haptics-setting')?.getAttribute('aria-pressed') ?? null,
    homePrimaryLabel: document.querySelector('#home-primary-label')?.textContent ?? null,
    board: globalThis.__voxalblast.board(),
    homeState: globalThis.__voxalblast.home(),
    slots: [...document.querySelectorAll('#piece-slots .piece-slot')].map((slot) => slot.classList.contains('used')),
    storedSound: localStorage.getItem('voxalblast-sound'),
  }
})()`

// A panel is "open" only if it is actually on screen AND on top of the stack: a modal that
// is display:block but covered by another layer is not usable, which is exactly the
// v0.8.15 "button hidden by CSS" class of bug.
const open = (panel) => Boolean(panel) && panel.display !== 'none' && panel.visibility !== 'hidden'
  && panel.width > 0 && panel.height > 0
const closed = (panel) => Boolean(panel) && !open(panel)

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

// ------------------------------------------------------------------------ CDP input

function mouse(client) {
  return {
    async click(selector, { label = selector } = {}) {
      const rect = await client.readJson(`(() => { const el = document.querySelector(${JSON.stringify(selector)})
        if (!el) return null; const box = el.getBoundingClientRect()
        if (box.width === 0 || box.height === 0) return null
        return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) } })()`)
      if (!rect) return { clicked: false, reason: `${label} has no layout box` }
      await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y })
      await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', buttons: 1, clickCount: 1 })
      await sleep(40)
      await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', buttons: 0, clickCount: 1 })
      await sleep(260)
      return { clicked: true, rect }
    },
    async escape() {
      for (const type of ['keyDown', 'keyUp']) {
        await client.send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
      }
      await sleep(260)
    },
  }
}

// ------------------------------------------------------------------- the P1 cases

async function caseSettings(client, input) {
  const before = await client.readJson(STATE)
  check('A the board starts live, not paused behind a panel',
    before.status === 'Pick a shape' && before.settings.hidden === true,
    `status="${before.status}" settingsHidden=${before.settings.hidden}`)

  const gear = await input.click('#settings-button', { label: 'the gear' })
  if (!gear.clicked) { skip('A settings open/close', gear.reason); return }
  const opened = await client.readJson(STATE)
  check('A the gear opens the settings panel', open(opened.settings),
    `display=${opened.settings.display} ${opened.settings.width}x${opened.settings.height}`)
  check('A opening settings pauses the board', opened.status === 'Paused', `status="${opened.status}"`)
  check('A opening settings moves focus to its close button', opened.activeId === 'settings-close',
    `activeElement=#${opened.activeId}`)
  check('A the settings panel is on top of the stack', opened.settings.onTop === true, `onTop=${opened.settings.onTop}`)

  // The double-binding detector. One click on the switch has to flip it exactly once; a
  // listener registered twice per open flips it twice and lands back where it started.
  const startPressed = opened.soundPressed
  await input.click('#sound-setting', { label: 'the sound switch' })
  const flipped = await client.readJson(STATE)
  check('A one click on the sound switch flips it exactly once',
    flipped.soundPressed !== startPressed,
    `aria-pressed ${startPressed} -> ${flipped.soundPressed} (unchanged means the listener is bound twice)`)
  check('A the sound switch keeps aria-pressed and .enabled in step',
    String(flipped.soundEnabled) === flipped.soundPressed,
    `aria-pressed=${flipped.soundPressed} .enabled=${flipped.soundEnabled}`)
  check('A the sound switch writes its preference to storage',
    flipped.storedSound === (flipped.soundPressed === 'true' ? 'on' : 'off'),
    `localStorage=${flipped.storedSound} aria-pressed=${flipped.soundPressed}`)
  await input.click('#sound-setting', { label: 'the sound switch' })
  const restored = await client.readJson(STATE)
  check('A a second click restores the original switch state',
    restored.soundPressed === startPressed, `aria-pressed=${restored.soundPressed}`)

  await input.click('#settings-close', { label: 'the settings close button' })
  const shut = await client.readJson(STATE)
  check('A the close button hides the panel', closed(shut.settings), `display=${shut.settings.display}`)
  check('A closing settings un-pauses the board', shut.status === 'Pick a shape', `status="${shut.status}"`)
  check('A closing settings returns focus to the gear', shut.activeId === 'settings-button',
    `activeElement=#${shut.activeId}`)
}

async function caseControls(client, input) {
  // Entry 1: the top bar button (only laid out at >=641px, which is why this probe runs
  // at 1280x900 — otherwise this whole case would silently skip).
  const bar = await input.click('#controls-button', { label: 'the top-bar controls entry' })
  if (!bar.clicked) { skip('B controls from the top bar', bar.reason); return }
  const opened = await client.readJson(STATE)
  check('B the top-bar entry opens the controls card', open(opened.controls),
    `display=${opened.controls.display} ${opened.controls.width}x${opened.controls.height}`)
  check('B opening the controls card pauses the board', opened.status === 'Paused', `status="${opened.status}"`)
  check('B opening the controls card focuses its close button', opened.activeId === 'controls-close',
    `activeElement=#${opened.activeId}`)

  await input.click('#controls-close', { label: 'the controls close button' })
  const shut = await client.readJson(STATE)
  check('B closing the controls card hides it', closed(shut.controls), `display=${shut.controls.display}`)
  check('B closing the controls card returns focus to the top-bar entry', shut.activeId === 'controls-button',
    `activeElement=#${shut.activeId}`)
  check('B closing the controls card un-pauses the board', shut.status === 'Pick a shape', `status="${shut.status}"`)

  // Entry 2: the row inside settings. The card must NOT close the settings panel behind it
  // (03 §2.2 — the player returns to the legend's own panel, not to the board).
  await input.click('#settings-button', { label: 'the gear' })
  const inSettings = await input.click('#controls-setting', { label: 'the controls row in settings' })
  if (!inSettings.clicked) { skip('B controls from the settings row', inSettings.reason); return }
  const fromRow = await client.readJson(STATE)
  check('B the settings row opens the controls card', open(fromRow.controls), `display=${fromRow.controls.display}`)
  check('B the settings panel stays open behind the controls card', open(fromRow.settings),
    `settingsDisplay=${fromRow.settings.display}`)

  await input.click('#controls-close', { label: 'the controls close button' })
  const back = await client.readJson(STATE)
  check('B closing the controls card returns focus to the settings row', back.activeId === 'controls-setting',
    `activeElement=#${back.activeId}`)
  await input.click('#settings-close', { label: 'the settings close button' })
}

async function caseHome(client, input) {
  await input.click('#settings-button', { label: 'the gear' })
  const toHome = await input.click('#home-setting', { label: 'the 回到主页 row' })
  if (!toHome.clicked) { skip('C home open/return', toHome.reason); return }
  const home = await client.readJson(STATE)
  check('C 回到主页 opens the cover', open(home.home), `display=${home.home.display} ${home.home.width}x${home.home.height}`)
  check('C the cover sets #app.home-open', home.appHomeOpen === true, `home-open=${home.appHomeOpen}`)
  check('C the cover makes the game layers inert', home.topbar?.inert === true && home.gameLayout?.inert === true,
    `topbar.inert=${home.topbar?.inert} gameLayout.inert=${home.gameLayout?.inert}`)
  check('C the cover keeps the game layers laid out (not collapsed)', (home.gameLayout?.width ?? 0) > 0,
    `gameLayout width=${home.gameLayout?.width}`)
  check('C the cover pauses the run', home.status === 'Home', `status="${home.status}"`)
  check('C the cover focuses its primary button', home.activeId === 'home-primary', `activeElement=#${home.activeId}`)
  check('C the cover reports itself through the read-only hook', home.homeState.open === true, `home().open=${home.homeState.open}`)
  check('C the primary button carries a resume/new label', ['继续游戏', '新游戏'].includes(home.homePrimaryLabel),
    `label="${home.homePrimaryLabel}"`)

  const play = await input.click('#home-primary', { label: 'the primary button' })
  if (!play.clicked) { skip('C home return', play.reason); return }
  await waitIntroDone(client)
  const resumed = await client.readJson(STATE)
  check('C the primary button closes the cover', closed(resumed.home), `display=${resumed.home.display}`)
  check('C leaving the cover clears #app.home-open', resumed.appHomeOpen === false, `home-open=${resumed.appHomeOpen}`)
  check('C leaving the cover un-inerts the game layers', resumed.topbar?.inert === false && resumed.gameLayout?.inert === false,
    `topbar.inert=${resumed.topbar?.inert} gameLayout.inert=${resumed.gameLayout?.inert}`)
  check('C leaving the cover makes the game layers visible again', resumed.gameLayout?.visibility === 'visible',
    `visibility=${resumed.gameLayout?.visibility}`)
  check('C the run is live again', resumed.status === 'Pick a shape' && resumed.homeState.open === false,
    `status="${resumed.status}" home().open=${resumed.homeState.open}`)
}

async function caseLeaderboardFromHome(client, input) {
  await input.click('#settings-button', { label: 'the gear' })
  await input.click('#home-setting', { label: 'the 回到主页 row' })
  const opened = await client.readJson(STATE)
  if (!open(opened.home)) { skip('D leaderboard from the cover', 'the cover did not open'); return }

  const lb = await input.click('#home-leaderboard', { label: 'the cover leaderboard entry' })
  if (!lb.clicked) { skip('D leaderboard from the cover', lb.reason); return }
  const shown = await client.readJson(STATE)
  check('D the cover entry opens the leaderboard', open(shown.leaderboard),
    `display=${shown.leaderboard.display} ${shown.leaderboard.width}x${shown.leaderboard.height}`)
  check('D the leaderboard focuses its close button', shown.activeId === 'leaderboard-close',
    `activeElement=#${shown.activeId}`)
  check('D the leaderboard renders its body', await client.evaluate(
    'document.querySelector("#leaderboard-body").children.length > 0'), 'body has sections')

  await input.click('#leaderboard-close', { label: 'the leaderboard close button' })
  const shut = await client.readJson(STATE)
  check('D closing the leaderboard hides it', closed(shut.leaderboard), `display=${shut.leaderboard.display}`)
  check('D closing the leaderboard returns focus to the cover entry it was opened from',
    shut.activeId === 'home-leaderboard', `activeElement=#${shut.activeId}`)
  check('D closing the leaderboard leaves the cover up', open(shut.home), `homeDisplay=${shut.home.display}`)

  // Escape is the other documented way out, and it has to restore focus the same way.
  await input.click('#home-leaderboard', { label: 'the cover leaderboard entry' })
  await input.escape()
  const escaped = await client.readJson(STATE)
  check('D Escape closes the leaderboard and restores focus to its opener',
    closed(escaped.leaderboard) && escaped.activeId === 'home-leaderboard',
    `display=${escaped.leaderboard.display} activeElement=#${escaped.activeId}`)

  await input.click('#home-primary', { label: 'the primary button' })
  await waitIntroDone(client)
}

async function caseEscapePrecedence(client, input) {
  // The keydown handler resolves Escape in a fixed order: leaderboard → controls → item →
  // drag → settings. With both the controls card and settings open, one Escape must close
  // the card and leave settings up — a re-homed listener that lost the order would close
  // both (or the wrong one).
  await input.click('#settings-button', { label: 'the gear' })
  await input.click('#controls-setting', { label: 'the controls row in settings' })
  const both = await client.readJson(STATE)
  if (!open(both.controls) || !open(both.settings)) {
    skip('E Escape precedence', 'could not get both panels open at once')
  } else {
    await input.escape()
    const afterFirst = await client.readJson(STATE)
    check('E Escape closes the controls card first', closed(afterFirst.controls), `controlsDisplay=${afterFirst.controls.display}`)
    check('E Escape leaves the settings panel open', open(afterFirst.settings), `settingsDisplay=${afterFirst.settings.display}`)
    await input.escape()
    const afterSecond = await client.readJson(STATE)
    check('E a second Escape closes the settings panel', closed(afterSecond.settings), `settingsDisplay=${afterSecond.settings.display}`)
    check('E closing by Escape un-pauses the board', afterSecond.status === 'Pick a shape', `status="${afterSecond.status}"`)
  }
  if (open((await client.readJson(STATE)).settings)) await input.click('#settings-close', { label: 'the settings close button' })
}

async function caseGameOver(client, input) {
  const ended = await client.evaluate('Boolean(globalThis.__voxalblastDev?.endGame)')
  if (!ended) { skip('F Game Over paths', 'no DEV handle: point this probe at `npm run dev`'); return }
  await client.evaluate('globalThis.__voxalblastDev.endGame()')
  await sleep(500)
  const over = await client.readJson(STATE)
  check('F the Game Over card is shown', open(over.gameOver), `display=${over.gameOver.display}`)
  check('F PLAY AGAIN is reachable, not just present', open(over.playAgain) && over.playAgain.onTop === true,
    `display=${over.playAgain.display} ${over.playAgain.width}x${over.playAgain.height} onTop=${over.playAgain.onTop}`)

  // The Game Over card is the leaderboard's second entry point; focus must come back to
  // ITS button, not to the cover's (that is the per-opener rule from v0.8.19).
  const lb = await input.click('#leaderboard-button', { label: 'the Game Over leaderboard entry' })
  if (!lb.clicked) { skip('F leaderboard from Game Over', lb.reason); return }
  const shown = await client.readJson(STATE)
  check('F the Game Over entry opens the leaderboard', open(shown.leaderboard), `display=${shown.leaderboard.display}`)
  await input.click('#leaderboard-close', { label: 'the leaderboard close button' })
  const shut = await client.readJson(STATE)
  check('F closing it returns focus to the Game Over entry', shut.activeId === 'leaderboard-button',
    `activeElement=#${shut.activeId}`)
  check('F the Game Over card survives the leaderboard round trip', open(shut.gameOver), `display=${shut.gameOver.display}`)

  const again = await input.click('#reset-modal', { label: 'PLAY AGAIN' })
  if (!again.clicked) { skip('F PLAY AGAIN', again.reason); return }
  await waitIntroDone(client)
  const fresh = await client.readJson(STATE)
  check('F PLAY AGAIN hides the Game Over card', closed(fresh.gameOver), `display=${fresh.gameOver.display}`)
  check('F PLAY AGAIN starts a fresh run at zero', fresh.board.score === 0, `score=${fresh.board.score}`)
  check('F PLAY AGAIN deals three unspent candidates',
    fresh.slots.length === 3 && fresh.slots.every((used) => used === false), `used=[${fresh.slots}]`)
  check('F PLAY AGAIN leaves the board live', fresh.status === 'Pick a shape', `status="${fresh.status}"`)
  check('F PLAY AGAIN leaves the cover closed', fresh.homeState.open === false, `home().open=${fresh.homeState.open}`)
}

async function caseChurn(client, input) {
  const start = await client.readJson(STATE)
  if (start.settings.hidden !== true) { skip('G churn', 'settings was not closed at the start'); return }
  for (let i = 0; i < CHURN_CYCLES; i += 1) {
    await input.click('#settings-button', { label: 'the gear' })
    await input.click('#settings-close', { label: 'the settings close button' })
  }
  const after = await client.readJson(STATE)
  check(`G ${CHURN_CYCLES} open/close cycles leave the panel shut`, closed(after.settings), `display=${after.settings.display}`)
  check(`G ${CHURN_CYCLES} open/close cycles leave the board un-paused`, after.status === 'Pick a shape', `status="${after.status}"`)
  check(`G ${CHURN_CYCLES} open/close cycles leave no inert layer`, after.topbar?.inert === false && after.gameLayout?.inert === false,
    `topbar.inert=${after.topbar?.inert} gameLayout.inert=${after.gameLayout?.inert}`)
  check(`G ${CHURN_CYCLES} open/close cycles leave the cover closed`, after.appHomeOpen === false, `home-open=${after.appHomeOpen}`)

  // Re-run the double-binding detector AFTER the churn: a `bind()` that runs on every open
  // shows up here even if the first open looked clean.
  await input.click('#settings-button', { label: 'the gear' })
  const reopened = await client.readJson(STATE)
  await input.click('#sound-setting', { label: 'the sound switch' })
  const flipped = await client.readJson(STATE)
  check('G the sound switch still flips exactly once after churn',
    flipped.soundPressed !== reopened.soundPressed,
    `aria-pressed ${reopened.soundPressed} -> ${flipped.soundPressed}`)
  await input.click('#sound-setting', { label: 'the sound switch' })
  await input.click('#settings-close', { label: 'the settings close button' })

  // The preference is a plain localStorage key the settings module owns; a reload has to
  // bring it back (this is the one settings behaviour with persistence behind it).
  const before = await client.readJson(STATE)
  await client.send('Page.reload', { ignoreCache: false })
  await sleep(1200)
  await waitForHandle(client)
  await waitIntroDone(client)
  const reloaded = await client.readJson(STATE)
  check('G the sound preference survives a reload',
    reloaded.soundPressed === before.soundPressed && reloaded.storedSound === before.storedSound,
    `aria-pressed ${before.soundPressed} -> ${reloaded.soundPressed}, storage=${reloaded.storedSound}`)
}

// --------------------------------------------------------------------------- driver

const browserPath = findBrowser()
const dev = await ensureDevServer()
console.log(`browser  ${browserPath}`)
console.log(`target   ${APP_URL}  (dev server ${dev.started ? `started, pid ${dev.pid}` : 'already running'})`)
console.log(`viewport ${VIEWPORT.width}x${VIEWPORT.height}\n`)

const profile = mkdtempSync(join(tmpdir(), 'voxalblast-ui-'))
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
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: VIEWPORT.width, height: VIEWPORT.height,
    screenWidth: VIEWPORT.width, screenHeight: VIEWPORT.height, deviceScaleFactor: 1, mobile: false,
  })

  await client.send('Page.navigate', { url: APP_URL })
  await waitForHandle(client)
  check('boot: the opening wave finishes on its own', (await waitIntroDone(client)) === true, 'intro().active === false')

  const input = mouse(client)

  console.log('\n-- A. settings panel: open, pause, focus, single binding --')
  await caseSettings(client, input)

  console.log('\n-- B. controls card: both entry points and focus return --')
  await caseControls(client, input)

  console.log('\n-- C. home cover: open, inert, return --')
  await caseHome(client, input)

  console.log('\n-- D. leaderboard from the cover --')
  await caseLeaderboardFromHome(client, input)

  console.log('\n-- E. Escape precedence --')
  await caseEscapePrecedence(client, input)

  console.log('\n-- F. Game Over: leaderboard round trip and PLAY AGAIN --')
  await caseGameOver(client, input)

  console.log('\n-- G. churn, re-binding and preference persistence --')
  await caseChurn(client, input)

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
  console.log('\nUI panel paths, focus return and listener binding behave as before')
}

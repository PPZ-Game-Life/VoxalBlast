// Home cover and leaderboard panel.
//
// Refactor P1 (temp/VoxalBlast-渐进式模块拆分重构执行计划.md §6). Two things live here
// because they are the same screen family: the cover the player returns to, and the record
// panel reachable from it and from the Game Over card.
//
// What this module OWNS: the cover's DOM (the `#app.home-open` flag, the `inert` game
// layers, `#home` visibility, the primary button's label/note, focus), the home hero's
// renderer, and the leaderboard's body markup + per-opener focus restore.
//
// What it does NOT own: `openHome()` / `leaveHome()` remain orchestration in main, because
// they settle the intro wave, cancel a live drag, drop the item selection and write the
// resume snapshot — game-side work, not presentation. This module exposes the DOM half
// (`showCover()` / `hideCover()`) and tells main when the open state changed so it can
// recompute the pause lock through `onOpen` / `onClose`.
//
// The cover's open flag lives here (plan §3 state table: homeOpen → 对应 UI 模块, exposed as
// `isOpen()`) and is never written from outside.
import * as THREE from 'three'
import { HONORS } from '../game/honors.js'
import { RECORD_FIELDS, weekKey } from '../game/records.js'
import { TIER_CUTS, tierForScore, tiersReady } from '../game/tiers.js'
import { BOARD_STYLE as style } from '../rendering/config.js'
import { addToyLights } from '../rendering/toyLights.js'
import { blockSurfaceArtReady } from '../rendering/woodTexture.js'

export function createHome({
  els,
  getSavedRun,
  getBest,
  getRecords,
  platform,
  cloneSources,
  onOpen,
  onClose,
}) {
  const {
    app,
    homeEl,
    homeHeroEl,
    homePrimaryEl,
    homePrimaryLabelEl,
    homeBestEl,
    homeResumeNoteEl,
    leaderboardEl,
    leaderboardBodyEl,
    leaderboardCloseEl,
    leaderboardPlatformEl,
    gameLayers,
  } = els

  let homeOpen = false
  let leaderboardOpener = null

  // The hero's own renderer, scene and camera: on-demand, never part of the main loop.
  let homeRenderer
  let homeScene
  let homeCamera
  let homeModel

  // The hero is rendered on demand; refresh it if its first frame used the fallback surface
  // while the art asset was still in flight. Registered here rather than at module scope so
  // it closes over this instance's renderer.
  blockSurfaceArtReady.then(() => {
    if (homeOpen && homeRenderer) homeRenderer.render(homeScene, homeCamera)
  })

  // The hero is a CLONE of the live board, so its geometry and materials are shared: they
  // are borrowed from `cloneSources` and must never be disposed here.
  function renderHomeBoard() {
    if (!homeHeroEl.clientWidth || !homeHeroEl.clientHeight) return
    if (!homeRenderer) {
      homeRenderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power' })
      homeRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5))
      homeRenderer.outputColorSpace = THREE.SRGBColorSpace
      homeRenderer.toneMapping = THREE.ACESFilmicToneMapping
      homeRenderer.toneMappingExposure = style.exposure
      homeHeroEl.appendChild(homeRenderer.domElement)
      homeScene = new THREE.Scene()
      addToyLights(homeScene)
      homeCamera = new THREE.PerspectiveCamera(34, 1, 0.1, 100)
      homeCamera.position.set(9, 7, 12)
      homeCamera.lookAt(0, 0, 0)
      new ResizeObserver(renderHomeBoard).observe(homeHeroEl)
    }
    if (homeModel) homeScene.remove(homeModel)
    homeModel = new THREE.Group()
    // Clones share owned geometry/materials; do not dispose shared resources here.
    homeModel.add(cloneSources.cubeBody.clone(), cloneSources.gridGroup.clone(true))
    homeScene.add(homeModel)
    homeRenderer.setSize(homeHeroEl.clientWidth, homeHeroEl.clientHeight, false)
    homeCamera.aspect = homeHeroEl.clientWidth / homeHeroEl.clientHeight
    homeCamera.updateProjectionMatrix()
    homeRenderer.render(homeScene, homeCamera)
  }

  function refreshHome() {
    requestAnimationFrame(renderHomeBoard)
    const saved = getSavedRun()
    homePrimaryEl.classList.toggle('resume', Boolean(saved))
    homePrimaryLabelEl.textContent = saved ? '继续游戏' : '新游戏'
    homeBestEl.textContent = getBest().toLocaleString('en-US')
    homeResumeNoteEl.textContent = saved
      ? `未完成的一局：${saved.board.score.toLocaleString('en-US')} 分 · ${saved.board.cells.length} 格`
      : ''
    return saved
  }

  function isOpen() { return homeOpen }

  // The DOM half of main's openHome(), in the original order: the open flag first (so the
  // pause lock main recomputes in onOpen() sees it), then the layers, then the cover, then
  // the refreshed labels. Focus is a separate call so main can keep it last, where it was.
  function showCover() {
    if (homeOpen) return false
    homeOpen = true
    app.classList.add('home-open')
    gameLayers.forEach((el) => { el.inert = true })
    homeEl.classList.remove('hidden')
    refreshHome()
    onOpen?.()
    return true
  }

  // The DOM half of main's leaveHome(). The layers come back visible and operable; their
  // layout boxes were never collapsed, so nothing has to be re-measured.
  function hideCover() {
    homeOpen = false
    app.classList.remove('home-open')
    gameLayers.forEach((el) => { el.inert = false })
    homeEl.classList.add('hidden')
    onClose?.()
  }

  function focusPrimary() { homePrimaryEl.focus() }

  // ---- Leaderboard panel (08 §7.5) ------------------------------------------
  // The panel has three entry points (Game Over, the home cover, the dev handle), so focus
  // is returned to whoever opened it instead of to one hard-coded button — returning to the
  // Game Over button while the cover is up would drop focus onto a covered element.
  function openLeaderboard() {
    renderLeaderboard()
    leaderboardOpener = document.activeElement
    leaderboardEl.classList.remove('hidden')
    leaderboardCloseEl.focus()
  }

  function closeLeaderboard() {
    leaderboardEl.classList.add('hidden')
    const opener = leaderboardOpener
    leaderboardOpener = null
    if (opener instanceof HTMLElement && opener.isConnected && !opener.closest('.hidden')) opener.focus()
  }

  function renderLeaderboard() {
    const records = getRecords()
    const tier = tierForScore(records.best.score)
    // The tier badge: the mechanism is finished, the cut scores are deliberately
    // empty (08 §4.6, 交接单 §2 — 99.3% of games never end, so no absolute number
    // can be calibrated yet). A badge with invented thresholds would be worse than
    // no badge, so the panel says what it is waiting for.
    const tierHtml = tier
      ? `<div class="lb-tier"><span class="lb-tier-badge">T${tier.tier}</span><span class="lb-tier-copy"><strong>${tier.name}</strong><small>${tier.title}</small></span></div>`
      : `<div class="lb-tier uncalibrated"><span class="lb-tier-badge">T?</span><span class="lb-tier-copy"><strong>阶位待校准</strong><small>难度定稿后按真实玩家分位分档（08 §4.6）</small></span></div>`

    const recent = records.recent
    const top = Math.max(1, ...recent.map((entry) => entry.score))
    const bars = recent.length
      ? recent.map((entry, index) => `<li class="lb-bar-row"><span class="lb-bar-index">${index + 1}</span><span class="lb-bar"><i style="width:${Math.max(4, Math.round((entry.score / top) * 100))}%"></i></span><span class="lb-bar-score">${entry.score.toLocaleString('en-US')}</span></li>`).join('')
      : '<li class="lb-empty">还没有对局记录</li>'

    const recordRows = RECORD_FIELDS
      .map((field) => `<li><span>${field.label}</span><strong>${records.records[field.key]}</strong></li>`)
      .join('')
    const honorRows = HONORS
      .map((honor) => `<li><span>${honor.label}<small>${honor.title}</small></span><strong>${records.honors[honor.id] || 0}</strong></li>`)
      .join('')

    leaderboardBodyEl.innerHTML = `
    ${tierHtml}
    <section class="lb-section">
      <h2>最近 ${recent.length || 0} 局</h2>
      <ol class="lb-bars">${bars}</ol>
    </section>
    <section class="lb-section">
      <h2>个人最佳</h2>
      <ul class="lb-list">
        <li><span>最高分</span><strong>${records.best.score.toLocaleString('en-US')}</strong></li>
        <li><span>本周最佳</span><strong>${(records.weekly.key === weekKey() ? records.weekly.score : 0).toLocaleString('en-US')}</strong></li>
        <li><span>已玩局数</span><strong>${records.records.gamesPlayed}</strong></li>
        ${recordRows}
      </ul>
    </section>
    <section class="lb-section">
      <h2>荣誉收集</h2>
      <ul class="lb-list lb-list-honors">${honorRows}</ul>
      ${tiersReady(TIER_CUTS) ? '' : '<p class="lb-note">阶位分档取自真实玩家分位数，难度定稿后一次性标定；当前不出具体数字（08 §12 待决策 4）。</p>'}
    </section>`

    // Layer 2 entry: without an invitation the platform has nothing to show, so the
    // button is greyed with "即将开放" and never fires a request (§7.4).
    const invited = platform.leaderboardAvailable()
    leaderboardPlatformEl.innerHTML = `<p>全球榜由 CrazyGames 提供</p>`
      + (invited
        ? '<button id="platform-button" class="ghost-button" type="button">打开全球榜</button>'
        : '<button class="ghost-button disabled" type="button" disabled>即将开放</button>')
    leaderboardPlatformEl.querySelector('#platform-button')?.addEventListener('click', () => platform.openLeaderboard())
  }

  return {
    isOpen,
    showCover,
    hideCover,
    focusPrimary,
    refreshHome,
    renderHomeBoard,
    openLeaderboard,
    closeLeaderboard,
    renderLeaderboard,
  }
}

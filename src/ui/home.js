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
import { formatNumber, t } from '../i18n/index.js'
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
      homeRenderer.toneMapping = THREE.NeutralToneMapping
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
    homePrimaryLabelEl.textContent = saved ? t('home.resume') : t('home.play')
    homeBestEl.textContent = formatNumber(getBest())
    homeResumeNoteEl.textContent = saved
      ? t('home.resumeNote', {
        score: formatNumber(saved.board.score),
        cells: saved.board.cells.length,
      })
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
      ? `<div class="lb-tier"><span class="lb-tier-badge">T${tier.tier}</span><span class="lb-tier-copy"><strong>${t(`tier.${tier.tier}.name`)}</strong><small>${t(`tier.${tier.tier}.title`)}</small></span></div>`
      : `<div class="lb-tier uncalibrated"><span class="lb-tier-badge">T?</span><span class="lb-tier-copy"><strong>${t('leaderboard.tierUncalibrated')}</strong><small>${t('leaderboard.tierUncalibratedNote')}</small></span></div>`

    const recent = records.recent
    const top = Math.max(1, ...recent.map((entry) => entry.score))
    const bars = recent.length
      ? recent.map((entry, index) => `<li class="lb-bar-row"><span class="lb-bar-index">${index + 1}</span><span class="lb-bar"><i style="width:${Math.max(4, Math.round((entry.score / top) * 100))}%"></i></span><span class="lb-bar-score">${formatNumber(entry.score)}</span></li>`).join('')
      : `<li class="lb-empty">${t('leaderboard.empty')}</li>`

    // Labels come from the catalogue by STABLE KEY (record.maxChain / honor.QUAD.label), never
    // from display text stored in the data modules: honors.js and records.js are game data and
    // are imported by the Node rule tests, which must not need a locale to run.
    const recordRows = RECORD_FIELDS
      .map((field) => `<li><span>${t(field.labelKey)}</span><strong>${records.records[field.key]}</strong></li>`)
      .join('')
    const honorRows = HONORS
      .map((honor) => `<li><span>${t(`honor.${honor.id}.label`)}<small>${t(`honor.${honor.id}.title`)}</small></span><strong>${records.honors[honor.id] || 0}</strong></li>`)
      .join('')

    leaderboardBodyEl.innerHTML = `
    ${tierHtml}
    <section class="lb-section">
      <h2>${t('leaderboard.recent', { n: recent.length || 0 })}</h2>
      <ol class="lb-bars">${bars}</ol>
    </section>
    <section class="lb-section">
      <h2>${t('leaderboard.personalBest')}</h2>
      <ul class="lb-list">
        <li><span>${t('leaderboard.best')}</span><strong>${formatNumber(records.best.score)}</strong></li>
        <li><span>${t('leaderboard.weekly')}</span><strong>${formatNumber(records.weekly.key === weekKey() ? records.weekly.score : 0)}</strong></li>
        <li><span>${t('leaderboard.gamesPlayed')}</span><strong>${records.records.gamesPlayed}</strong></li>
        ${recordRows}
      </ul>
    </section>
    <section class="lb-section">
      <h2>${t('leaderboard.honors')}</h2>
      <ul class="lb-list lb-list-honors">${honorRows}</ul>
      ${tiersReady(TIER_CUTS) ? '' : `<p class="lb-note">${t('leaderboard.tierNote')}</p>`}
    </section>`

    // Layer 2 entry: without an invitation the platform has nothing to show, so the
    // button is greyed with "coming soon" and never fires a request (§7.4).
    const invited = platform.leaderboardAvailable()
    leaderboardPlatformEl.innerHTML = `<p>${t('leaderboard.globalBy')}</p>`
      + (invited
        ? `<button id="platform-button" class="ghost-button" type="button">${t('leaderboard.openGlobal')}</button>`
        : `<button class="ghost-button disabled" type="button" disabled>${t('leaderboard.comingSoon')}</button>`)
    leaderboardPlatformEl.querySelector('#platform-button')?.addEventListener('click', () => platform.openLeaderboard())
  }

  // The cover's read-out (refactor P9): what the headless checks compare against — the open
  // flag, the two labels the player reads and whether a run is waiting behind the cover.
  // `persistent` is NOT here: that is the save slot's own answer, and diagnostics adds it.
  function report() {
    return {
      open: homeOpen,
      label: homePrimaryLabelEl.textContent,
      note: homeResumeNoteEl.textContent,
      hasSavedRun: Boolean(getSavedRun()),
    }
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
    report,
  }
}

// Home cover and leaderboard panel.
//
// Refactor P1 (temp/VoxalBlast-渐进式模块拆分重构执行计划.md §6). Two things live here
// because they are the same screen family: the cover the player returns to, and the record
// panel reachable from it and from the Game Over card.
//
// What this module OWNS: the cover's DOM (the `#app.home-open` flag, the `inert` game
// layers, `#home` visibility, the primary button's label/note, focus), and the leaderboard's
// body markup + per-opener focus restore.
//
// What it does NOT own: `openHome()` / `leaveHome()` remain orchestration in main, because
// they settle the intro wave, cancel a live drag, drop the item selection and write the
// resume snapshot — game-side work, not presentation. This module exposes the DOM half
// (`showCover()` / `hideCover()`) and tells main when the open state changed so it can
// recompute the pause lock through `onOpen` / `onClose`.
//
// The cover's open flag lives here (plan §3 state table: homeOpen → 对应 UI 模块, exposed as
// `isOpen()`) and is never written from outside.
//
// v0.9.26: the cover no longer renders anything. It used to own a second WebGLRenderer that
// drew a CLONE of the live cube as the hero; the approved redesign has an empty figure area
// (temp/ui-redesign-handoff-20260929 §1), so the renderer, its scene/camera, the clone and the
// `blockSurfaceArtReady` re-render hook are all deleted rather than left running behind a
// hidden div. Nothing here was ever shared with the game — but the clone borrowed the board's
// geometry and materials, and the reason this file used to say "never dispose those" is exactly
// why the whole path is better gone than disabled.
import { HONORS } from '../game/honors.js'
import { RECORD_FIELDS, weekKey } from '../game/records.js'
import { TIER_CUTS, tierForScore, tiersReady } from '../game/tiers.js'
import { formatNumber, t } from '../i18n/index.js'

export function createHome({
  els,
  getSavedRun,
  getBest,
  getRecords,
  platform,
  onOpen,
  onClose,
}) {
  const {
    app,
    homeEl,
    homePrimaryEl,
    homePrimaryLabelEl,
    homeBestEl,
    homeResumeNoteEl,
    homeNewEl,
    leaderboardEl,
    leaderboardBodyEl,
    leaderboardCloseEl,
    leaderboardPlatformEl,
    gameLayers,
  } = els

  let homeOpen = false
  let leaderboardOpener = null

  function refreshHome() {
    const saved = getSavedRun()
    homePrimaryEl.classList.toggle('resume', Boolean(saved))
    homePrimaryLabelEl.textContent = saved ? t('home.resume') : t('home.play')
    // v0.9.24: 新游戏 is the way out of 继续游戏, so it is offered exactly when a run is
    // waiting — with an empty slot the primary button already IS the new game.
    homeNewEl.classList.toggle('hidden', !saved)
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
      // v0.9.24: the second run action is offered only while the first one says 继续游戏.
      newGameOffered: !homeNewEl.classList.contains('hidden'),
    }
  }

  return {
    isOpen,
    showCover,
    hideCover,
    focusPrimary,
    refreshHome,
    openLeaderboard,
    closeLeaderboard,
    renderLeaderboard,
    report,
  }
}

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
import { REWARD_ORDER, SCORE_RULES_VERSION } from '../game/scoring.js'
import { TIER_CUTS, tierForScore, tiersReady } from '../game/tiers.js'
import { formatNumber, t } from '../i18n/index.js'

export function createHome({
  els,
  getSavedRun,
  getBest,
  getRecords,
  // v0.10.3 (§5.3): which scoring rules the panel should rank against. The run on screen is the
  // only thing that knows, and it can change (a legacy save resumes into a version-1 run), so it
  // arrives as a getter like every other live value here.
  getRulesVersion = () => SCORE_RULES_VERSION,
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
    // §5.3: every number on this panel belongs to ONE rule set. The current one leads; the other
    // is printed as read-only history when it has anything in it, so a player who has been here
    // since the old rules can still see those numbers — clearly labelled, never re-ranked.
    const rules = getRulesVersion()
    const current = rules === SCORE_RULES_VERSION
    const pool = current
      ? { best: records.bestV2, weekly: records.weeklyV2 }
      : { best: records.best, weekly: records.weekly }
    const legacyPool = current
      ? { best: records.best, weekly: records.weekly }
      : { best: records.bestV2, weekly: records.weeklyV2 }
    const tier = tierForScore(pool.best.score)
    // The tier badge: the mechanism is finished, the cut scores are deliberately
    // empty (08 §4.6, 交接单 §2 — 99.3% of games never end, so no absolute number
    // can be calibrated yet). A badge with invented thresholds would be worse than
    // no badge, so the panel says what it is waiting for.
    const tierHtml = tier
      ? `<div class="lb-tier"><span class="lb-tier-badge">T${tier.tier}</span><span class="lb-tier-copy"><strong>${t(`tier.${tier.tier}.name`)}</strong><small>${t(`tier.${tier.tier}.title`)}</small></span></div>`
      : `<div class="lb-tier uncalibrated"><span class="lb-tier-badge">T?</span><span class="lb-tier-copy"><strong>${t('leaderboard.tierUncalibrated')}</strong><small>${t('leaderboard.tierUncalibratedNote')}</small></span></div>`

    // The recent bars are the SAME rule set's last games: a bar chart that mixes two score scales
    // is a chart of nothing (§5.3 不把不同分制混榜). The legacy entries stay in storage and are
    // counted out loud instead of being drawn as if they were comparable.
    const recent = records.recent.filter((entry) => (entry.rules === SCORE_RULES_VERSION) === current)
    const legacyRecent = records.recent.length - recent.length
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
    // The three current categories, with their lifetime counts. A version-2 run earns these and
    // nothing else, so the panel that says 「荣誉收集」 has to say what it is collecting now.
    const rewardRows = REWARD_ORDER
      .map((type) => `<li><span>${t(`reward.${type}.name`)}</span><strong>${records.rewards[type] || 0}</strong></li>`)
      .join('')

    leaderboardBodyEl.innerHTML = `
    ${tierHtml}
    <section class="lb-section">
      <h2>${current ? t('leaderboard.recent', { n: recent.length || 0 }) : t('leaderboard.recentLegacy', { n: recent.length || 0 })}</h2>
      <ol class="lb-bars">${bars}</ol>
      ${legacyRecent > 0 ? `<p class="lb-note">${t('leaderboard.recentOtherRules', { n: legacyRecent })}</p>` : ''}
    </section>
    <section class="lb-section">
      <h2>${t('leaderboard.personalBest')}</h2>
      <ul class="lb-list">
        <li><span>${t('leaderboard.best')}</span><strong>${formatNumber(pool.best.score)}</strong></li>
        <li><span>${t('leaderboard.weekly')}</span><strong>${formatNumber(pool.weekly.key === weekKey() ? pool.weekly.score : 0)}</strong></li>
        ${legacyPool.best.score > 0 ? `<li><span>${t('leaderboard.bestLegacy')}</span><strong>${formatNumber(legacyPool.best.score)}</strong></li>` : ''}
        ${legacyPool.weekly.score > 0 && legacyPool.weekly.key === weekKey() ? `<li><span>${t('leaderboard.weeklyLegacy')}</span><strong>${formatNumber(legacyPool.weekly.score)}</strong></li>` : ''}
        <li><span>${t('leaderboard.gamesPlayed')}</span><strong>${records.records.gamesPlayed}</strong></li>
        ${recordRows}
      </ul>
    </section>
    <section class="lb-section">
      <h2>${current ? t('leaderboard.rewards') : t('leaderboard.honors')}</h2>
      ${current
        ? `<ul class="lb-list">${rewardRows}</ul>`
        : `<ul class="lb-list lb-list-honors">${honorRows}</ul>`}
      ${tiersReady(TIER_CUTS) ? '' : `<p class="lb-note">${t('leaderboard.tierNote')}</p>`}
    </section>
    ${current && Object.values(records.honors).some((count) => count > 0)
      ? `<section class="lb-section"><h2>${t('leaderboard.honorsLegacy')}</h2><ul class="lb-list lb-list-honors">${honorRows}</ul></section>`
      : ''}`

    // Layer 2 entry: without an invitation the platform has nothing to show, so the
    // button is greyed with "coming soon" and never fires a request (§7.4). v0.10.3 adds a
    // second reason to be greyed — §5.5, a rules set the platform board is not routed to — and
    // it says which one, because "not yet for these rules" is not "coming soon".
    const invited = typeof platform.leaderboardAvailableFor === 'function'
      ? platform.leaderboardAvailableFor(rules)
      : platform.leaderboardAvailable()
    const routed = typeof platform.boardRulesVersion !== 'function' || platform.boardRulesVersion() === rules
    leaderboardPlatformEl.innerHTML = `<p>${t('leaderboard.globalBy')}</p>`
      + (invited
        ? `<button id="platform-button" class="ghost-button" type="button">${t('leaderboard.openGlobal')}</button>`
        : `<button class="ghost-button disabled" type="button" disabled>${t(routed ? 'leaderboard.comingSoon' : 'leaderboard.rulesUnrouted')}</button>`)
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

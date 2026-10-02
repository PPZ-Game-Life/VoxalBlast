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
import { rankBoard } from '../game/leaderboardRanking.js'
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
  // v0.12.0: the global board's data source — see platform/leaderboardFeed.js. Injected the same
  // way `platform` is, so this module renders standings without knowing where they came from and
  // the sample board can be replaced by a real feed without touching the panel.
  globalFeed,
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
    leaderboardGlobalEl,
    leaderboardTabsEl,
    lbTabGlobalEl,
    lbTabLocalEl,
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
  // Two views over one card since v0.12.0: the seasonal GLOBAL board and the LOCAL record wall
  // (Layer 1). Both panes are rendered on open — and again on a language switch — and BOTH stay
  // in the DOM: the tabs toggle `.hidden`, so switching is instant, a check that reads one pane
  // never depends on which tab is selected, and nothing has to be re-fetched.
  //
  // Where the global standings COME FROM is not this module's business. It asks `globalFeed` and
  // renders what comes back together with the honesty flag the feed returned (`sample`, and `me`
  // when the source already knows the player's standing). platform/leaderboardFeed.js is the one
  // swap point; nothing in this file changes when the sample board is replaced by real data.
  //
  // The panel has three entry points (Game Over, the home cover, the dev handle), so focus is
  // returned to whoever opened it instead of to one hard-coded button — returning to the Game
  // Over button while the cover is up would drop focus onto a covered element.
  let activeTab = 'global'
  // Guard for the global pane's ASYNC render: a slow answer must never paint over a newer board.
  let globalRenderId = 0

  function openLeaderboard() {
    // The tab state is re-applied rather than assumed: it survives a close (the player returns to
    // the view they left) and this is the one line that guarantees the panes and the flags agree.
    selectTab(activeTab)
    renderLeaderboard()
    leaderboardOpener = document.activeElement
    leaderboardEl.classList.remove('hidden')
    leaderboardCloseEl.focus()
  }

  // One tab state, read by the panes and written only here. `aria-selected` IS the state — the
  // CSS styles the selected plate off that attribute, so what a screen reader is told and what
  // is on screen cannot drift apart.
  function selectTab(tab, { focus = false } = {}) {
    activeTab = tab === 'local' ? 'local' : 'global'
    const isGlobal = activeTab === 'global'
    leaderboardGlobalEl.classList.toggle('hidden', !isGlobal)
    leaderboardBodyEl.classList.toggle('hidden', isGlobal)
    for (const [el, selected] of [[lbTabGlobalEl, isGlobal], [lbTabLocalEl, !isGlobal]]) {
      el.setAttribute('aria-selected', selected ? 'true' : 'false')
      // Roving tabindex: one tab is reachable with Tab, the arrow keys move between them.
      el.tabIndex = selected ? 0 : -1
      if (focus && selected) el.focus()
    }
  }

  function stepTab() {
    selectTab(activeTab === 'global' ? 'local' : 'global', { focus: true })
  }

  // Bound once, here, because these three elements exist for the life of the page and the tab
  // state is this module's own. The panel's other listeners (the two openers, the close button,
  // the backdrop) stay in main.js, where they have always been.
  lbTabGlobalEl.addEventListener('click', () => selectTab('global'))
  lbTabLocalEl.addEventListener('click', () => selectTab('local'))
  leaderboardTabsEl.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    stepTab()
  })

  function closeLeaderboard() {
    leaderboardEl.classList.add('hidden')
    const opener = leaderboardOpener
    leaderboardOpener = null
    if (opener instanceof HTMLElement && opener.isConnected && !opener.closest('.hidden')) opener.focus()
  }

  function renderLeaderboard() {
    renderLocalPane()
    renderPlatformEntry()
    // The global pane repaints from the feed: a sample board resolves on the next microtask, a
    // platform board whenever the network answers. Nothing waits on it — the panel is already
    // open, the local pane is already correct, and the global pane shows its own loading line.
    renderGlobalBoard()
  }

  function renderLocalPane() {
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

  }

  // ---- The GLOBAL pane (08 §7.5) ---------------------------------------------
  // The seasonal ranking, drawn from whatever `globalFeed` hands over. Two things this file
  // decides on its own: the avatar (a letter on a hue derived from the name — a real board has no
  // avatar upload either) and the player's OWN row, which is the local best when the source does
  // not already know the standing.
  //
  // An entry's name is DATA, and after the platform integration it is REMOTE data: it is escaped
  // on the way into innerHTML. The sample board's names are harmless, which is exactly why the
  // escape belongs here now rather than being added later, in a hurry, with real names on screen.
  const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
  const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ESCAPES[char])

  function avatarHue(name) {
    let hue = 0
    for (let index = 0; index < name.length; index += 1) hue = (hue * 31 + name.charCodeAt(index)) % 360
    return hue
  }

  function toScore(value) {
    const score = Number(value)
    return Number.isFinite(score) ? Math.max(0, Math.trunc(score)) : 0
  }

  function boardRow(entry) {
    const name = escapeHtml(entry.name)
    return `<li class="lb-row${entry.rank <= 3 ? ` top top-${entry.rank}` : ''}">`
      + `<span class="lb-rank">${entry.rank}</span>`
      + `<i class="lb-avatar" style="--lb-hue:${avatarHue(entry.name)}" aria-hidden="true">${escapeHtml(entry.name.trim().charAt(0).toUpperCase() || '?')}</i>`
      + `<span class="lb-name">${name}</span>`
      + `<strong class="lb-score">${formatNumber(entry.score)}</strong></li>`
  }

  async function renderGlobalBoard() {
    const renderId = (globalRenderId += 1)
    const records = getRecords()
    const current = getRulesVersion() === SCORE_RULES_VERSION
    // §5.3: the player's own standing is read from the pool of the rules the run on screen was
    // played under, exactly as the local pane reads it.
    const myScore = (current ? records.bestV2 : records.best).score
    leaderboardGlobalEl.innerHTML = `<p class="lb-note">${t('leaderboard.loading')}</p>`

    const board = await globalFeed.global()
    // A second open, or a language switch, may have started a newer render. Only the newest one
    // may paint; a slow answer landing late must not overwrite a newer board.
    if (renderId !== globalRenderId) return

    // The player's own row: the source's answer when it has one (a real board knows the standing),
    // otherwise the local best ranked against this very board. Ranking it here is not a claim that
    // the board is real — it is the same arithmetic, done on the one score this device owns, and
    // it lives in game/leaderboardRanking.js where the Node test can drive it.
    const me = board.me
      ? { name: String(board.me.name || t('leaderboard.you')), score: toScore(board.me.score) }
      : (myScore > 0 ? { name: t('leaderboard.you'), score: myScore } : null)
    const ranked = rankBoard(board.entries, me)
    const rows = ranked.board.map(boardRow).join('')

    const meHtml = ranked.mine
      ? `<div class="lb-me"><span class="lb-me-label">${t('leaderboard.myRank')}<span class="lb-me-rank">${t('leaderboard.rankOf', { n: ranked.mine.rank })}</span></span><strong class="lb-me-score">${formatNumber(ranked.mine.score)}</strong></div>`
      : `<div class="lb-me unranked"><span class="lb-me-label">${t('leaderboard.myRank')}<span class="lb-me-rank">${t('leaderboard.notRanked')}</span></span><strong class="lb-me-score">—</strong></div>`

    leaderboardGlobalEl.innerHTML = `
    <div class="lb-season">
      <span class="lb-season-name">${t('leaderboard.season', { key: escapeHtml(board.season) })}</span>
      ${board.sample ? `<span class="lb-sample-chip">${t('leaderboard.sample')}</span>` : ''}
    </div>
    <ol class="lb-board">${rows}</ol>
    ${board.sample ? `<p class="lb-note lb-sample-note">${t('leaderboard.sampleNote')}</p>` : ''}
    ${meHtml}`
  }

  // Layer 2 (the platform's own board drawer). v0.12.0: the panel renders the standings itself
  // now, so this row is no longer the panel's explanation of why there is nothing to show — when
  // the platform cannot be opened it stays EMPTY, and the global pane's own copy carries the
  // truth about the numbers. §5.5 still has a sentence here: invited, but no route for the rules
  // the run on screen is playing, is a different state from not invited at all.
  function renderPlatformEntry() {
    const rules = getRulesVersion()
    if (typeof platform.leaderboardAvailable !== 'function' || !platform.leaderboardAvailable()) {
      leaderboardPlatformEl.innerHTML = ''
      return
    }
    const routed = typeof platform.boardRulesVersion !== 'function' || platform.boardRulesVersion() === rules
    leaderboardPlatformEl.innerHTML = `<p>${t('leaderboard.globalBy')}</p>`
      + (routed
        ? `<button id="platform-button" class="ghost-button" type="button">${t('leaderboard.openGlobal')}</button>`
        : `<button class="ghost-button disabled" type="button" disabled>${t('leaderboard.rulesUnrouted')}</button>`)
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
    // v0.12.0: the two leaderboard tabs. Exposed for the probes (the gate switches tabs through
    // the real click path, but a check that needs a specific view can also ask for one).
    selectTab,
    report,
  }
}

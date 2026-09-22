// HUD presentation: score/best pills, status line, toast, chain indicator, score pop,
// honor banner and the item bar / rocket Row-Col readout.
//
// Refactor P1 (temp/VoxalBlast-渐进式模块拆分重构执行计划.md §6). Everything here is DOM:
// markup templates, class toggles and their own one-shot timers. Nothing here decides a
// rule — the values arrive through getters and the one action that is not presentation
// (the chain-break sound, which belongs to effects in P5) arrives as a callback.
//
// Live state is read through GETTERS, never captured: resetRun()/applySession() rewrite
// `run`, `itemCounts` and `itemActive` in place, so a copy taken once at construction would
// silently go stale — the trap the plan's state table calls out.
//
// Deliberately NOT here yet: `renderPieceSlots` / `updatePieceSlotSelection`. They walk the
// `piecePreviews` map, whose values are Three.js renderers, and the plan's contract forbids
// a UI module from carrying Three objects. They move with `pieceView` in P4.
import { FEEDBACK_STYLE, HUD_STYLE } from '../rendering/config.js'

export function createHud({
  els,
  getScore,
  getBest,
  getChain,
  getItemCounts,
  getItemActive,
  canUseItems,
  onChainBreak,
}) {
  const {
    statusEl,
    toastEl,
    scoreEl,
    bestEl,
    chainEl,
    chainValueEl,
    chainBarEl,
    sceneWrap,
    honorLayerEl,
    itemBarEl,
    axisPickEl,
  } = els

  // The toast's own timer, moved with the function that owns it.
  let toastTimer

  function setStatus(text) { statusEl.textContent = text }

  function showToast(text, duration = 1500) {
    toastEl.textContent = text
    toastEl.classList.add('visible')
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => toastEl.classList.remove('visible'), duration)
  }

  function updateHud() {
    scoreEl.textContent = String(getScore()).padStart(4, '0')
    // BEST is a secondary pill: same chip language, smaller type (04「UI 与发布」修订条款).
    bestEl.textContent = getBest().toLocaleString('en-US')
  }

  // 荣誉名号. A placement that clears nothing still pops its placement score, which
  // is the entire purpose of the 放置分 layer (§4.1): "this turn built instead of
  // clearing" must not read as nothing happened.
  function showScorePop(points, { lines = 0, faces = 1, honor = null, quiet = false } = {}) {
    const pop = document.createElement('div')
    pop.className = quiet ? 'score-pop quiet' : 'score-pop'
    const rows = [`<strong>+${points}</strong>`]
    if (lines > 0) rows.push(`<span>${lines} LINE${lines === 1 ? '' : 'S'}</span>`)
    if (faces > 1) rows.push(`<span class="score-pop-faces">${faces} FACES</span>`)
    if (honor) rows.push(`<span class="score-pop-honor">${honor.title}</span>`)
    pop.innerHTML = rows.join('')
    sceneWrap.appendChild(pop)
    requestAnimationFrame(() => pop.classList.add('visible'))
    setTimeout(() => pop.remove(), quiet ? 640 : 920)
  }

  // Chain indicator (08 §7.5): absent below HUD_STYLE.chainMinVisible and brighter as
  // it grows. A chain that is always on screen costs nothing to break, and the whole
  // mechanism is the stake (08 §4.4).
  function updateChainHud() {
    const chain = getChain()
    const visible = chain >= HUD_STYLE.chainMinVisible
    chainEl.classList.toggle('visible', visible)
    chainEl.classList.toggle('hot', chain >= HUD_STYLE.chainMinVisible)
    chainEl.setAttribute('aria-hidden', String(!visible))
    chainValueEl.textContent = String(chain)
    chainBarEl.style.transform = `scaleX(${Math.min(1, chain / HUD_STYLE.chainBarCap)})`
  }

  function breakChainFeedback(chain) {
    chainEl.classList.add('broken')
    setTimeout(() => chainEl.classList.remove('broken'), 620)
    // Sound is effects' business (P5); main wires this to playChainBreakSound.
    onChainBreak?.(chain)
  }

  // §5.3: ONE primary banner (the rarest honor wins), the rest float in as a single
  // row of small badges. Both are overlay-only — the design forbids a reward moment
  // that blocks input, so nothing here is modal and nothing here can eat a gesture.
  function showHonorBanner(honors, level) {
    const feedback = FEEDBACK_STYLE.levels[level] || FEEDBACK_STYLE.levels[0]
    if (honors.primary) {
      const banner = document.createElement('div')
      banner.className = `honor-banner honor-banner-${feedback.banner}`
      banner.innerHTML = `<strong>${honors.primary.title}</strong><small>${honors.primary.label} · +${honors.primary.bonus}</small>`
      honorLayerEl.appendChild(banner)
      requestAnimationFrame(() => banner.classList.add('visible'))
      const ms = FEEDBACK_STYLE.honorBannerMs[feedback.banner] || 900
      setTimeout(() => {
        banner.classList.remove('visible')
        setTimeout(() => banner.remove(), 320)
      }, ms)
    }
    const extras = honors.secondary.concat(honors.records)
    if (!extras.length || !feedback.badges) return
    const row = document.createElement('div')
    row.className = 'honor-badges'
    row.innerHTML = extras.map((honor) => `<span class="honor-badge">${honor.title}</span>`).join('')
    honorLayerEl.appendChild(row)
    requestAnimationFrame(() => row.classList.add('visible'))
    setTimeout(() => {
      row.classList.remove('visible')
      setTimeout(() => row.remove(), 320)
    }, 1400)
  }

  function clearHonorLayer() {
    honorLayerEl.replaceChildren()
  }

  // The item strip is rebuilt in place: the buttons are static in index.html and only their
  // class/aria/count are written, so no node is ever replaced mid-gesture (that is what
  // used to lose pointer capture).
  function renderItemBar() {
    const counts = getItemCounts()
    const active = getItemActive()
    itemBarEl.querySelectorAll('.item-button').forEach((button) => {
      const id = button.dataset.item
      const count = counts[id]
      const ready = canUseItems() && count > 0
      button.classList.toggle('disabled', !ready)
      button.classList.toggle('active', active?.id === id)
      button.setAttribute('aria-pressed', String(active?.id === id))
      const countEl = button.querySelector('.item-count')
      if (countEl) countEl.textContent = String(count)
    })
  }

  // The Row/Col panel doubles as the readout for the line the pointer auto-picked
  // (07 §3.1 A5), so it is re-rendered whenever the orientation changes.
  function renderAxisPick() {
    const active = getItemActive()
    axisPickEl.querySelectorAll('button[data-axis]').forEach((button) => {
      const axis = button.dataset.axis === 'col' ? 'col' : 'row'
      const on = active?.id === 'rocket' && active.orientation === axis
      button.classList.toggle('active', on)
      button.setAttribute('aria-pressed', String(on))
    })
  }

  return {
    setStatus,
    showToast,
    updateHud,
    showScorePop,
    updateChainHud,
    breakChainFeedback,
    showHonorBanner,
    clearHonorLayer,
    renderItemBar,
    renderAxisPick,
  }
}

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
// The candidate slots' DOM lives here since P9 (`renderPieceSlots`): the buttons, the chip
// colour, the thumbnail canvases and the pointer wiring. The PREVIEWS those canvases are
// drawn into stay pieceView's — this module only calls its `createPiecePreview` and never
// holds a renderer, which is the part of the plan's contract that matters. The single
// Three.js use below is a colour formatter, not a renderer.
import * as THREE from 'three'
import { FEEDBACK_STYLE, HUD_STYLE } from '../rendering/config.js'
import { ITEM_COPY, ITEM_NAME } from './itemCopy.js'

// The four icons exactly as index.html draws them. The status bar repeats the icon of whatever is
// armed so the bar can never be read as belonging to a different tool than the highlighted one.
const ITEM_ICON = Object.freeze({
  refresh: '↻', hammer: '🔨', rocket: '🚀', bomb: '💣',
})

// The one Three.js use in this module: a colour integer -> the CSS custom property a candidate
// slot paints its chip with. It is a formatter, not a renderer — the candidate PREVIEWS are
// rendering/pieceView.js's and never enter this module (P9).
function colorHex(color) {
  return `#${new THREE.Color(color).getHexString()}`
}

export function createHud({
  els,
  getScore,
  getBest,
  getChain,
  getItemCounts,
  getItemActive,
  canUseItems,
  // The candidate strip's content (P9). `slotsEl` is its container; the four callbacks belong
  // to rendering/pieceView.js and input/gameInput.js, neither of which exists yet when this
  // factory runs (main builds hud before both), so they arrive lazily and are read at call
  // time — the same rule as `getCubeGroup` in boardView.
  getPieces,
  getSelectedPiece,
  bindSlot,
  disposePiecePreviews,
  createPiecePreview,
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
    slotsEl,
    // 07 §8.3/§8.8/§8.9: the status bar, the batch question and the undo window's bar.
    itemStatusEl,
    itemStatusIconEl,
    itemStatusNameEl,
    itemStatusHintEl,
    itemUseEl,
    refreshConfirmEl,
    refreshConfirmCopyEl,
    undoBarEl,
    undoBarTextEl,
  } = els

  // The toast's own timer, moved with the function that owns it.
  let toastTimer
  let scoreFitFrame = 0
  const scoreMeasure = document.createRange()

  function fitScores() {
    cancelAnimationFrame(scoreFitFrame)
    scoreFitFrame = requestAnimationFrame(() => {
      for (const el of [scoreEl, bestEl]) {
        el.style.fontSize = ''
        const style = getComputedStyle(el)
        scoreMeasure.selectNodeContents(el)
        const naturalWidth = scoreMeasure.getBoundingClientRect().width
        const available = Math.max(1, el.clientWidth - 4) // outline + shadow
        if (naturalWidth > available) el.style.fontSize = `${parseFloat(style.fontSize) * available / naturalWidth}px`
      }
    })
  }
  const scoreResize = new ResizeObserver(fitScores)
  scoreResize.observe(scoreEl.parentElement)
  scoreResize.observe(bestEl.parentElement)

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
    fitScores()
  }

  // 08 §6: the score pop grew from two rows to four — +分数 / N LINES / M FACES /
  // 荣誉名号 — and the point of the placement-score layer (§4.1) is that a placement
  // clearing nothing still pops its score: "this turn built instead of clearing" must not
  // read as nothing happened. Overlay only; nothing here is modal or eats a gesture.
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
  // class/aria/count are written, so no node is ever replaced mid-gesture (that is what used
  // to lose pointer capture).
  //
  // v1 (07 §8.3): three states, and they must be told apart at a glance —
  //   ready    (has charges, operable)   normal
  //   empty    (0 charges)               `.empty`, and it SAYS 本局已用完 instead of only dimming
  //   not now  (paused / cooling down)   `.disabled`
  // The strip of a run in progress may never be left looking grey while it still has charges;
  // tools/screenshot.mjs asserts exactly that, because v0.8.21 shipped that bug.
  function renderItemBar() {
    const counts = getItemCounts()
    const active = getItemActive()
    itemBarEl.querySelectorAll('.item-button').forEach((button) => {
      const id = button.dataset.item
      const count = counts[id]
      const empty = count <= 0
      const ready = canUseItems() && !empty
      button.classList.toggle('disabled', !ready && !empty)
      button.classList.toggle('empty', empty)
      button.classList.toggle('active', active?.id === id)
      button.setAttribute('aria-pressed', String(active?.id === id))
      const countEl = button.querySelector('.item-count')
      if (countEl) countEl.textContent = String(count)
      const emptyEl = button.querySelector('.item-empty')
      if (emptyEl) emptyEl.textContent = ITEM_COPY.empty
      const nameEl = button.querySelector('.item-name')
      if (nameEl) nameEl.textContent = ITEM_NAME[id]
    })
  }

  // 07 §8.3/§8.5: the ONE place that says what the armed tool is about to do. It reads the input
  // layer's report and never invents a number of its own — the N on screen is the N the release
  // will clear, because both come from the same buildItemScope() snapshot.
  function renderItemStatus(report) {
    const visible = Boolean(report)
    itemStatusEl.classList.toggle('hidden', !visible)
    itemStatusEl.setAttribute('aria-hidden', String(!visible))
    if (!visible) {
      itemStatusEl.removeAttribute('data-item')
      itemStatusEl.removeAttribute('data-phase')
      return
    }
    itemStatusEl.dataset.item = report.id
    itemStatusEl.dataset.phase = report.phase
    itemStatusEl.dataset.clipped = report.clipped
    itemStatusIconEl.textContent = ITEM_ICON[report.id] || ''
    itemStatusNameEl.textContent = ITEM_NAME[report.id] || report.id
    itemStatusHintEl.textContent = itemStatusHint(report)
    itemStatusHintEl.classList.toggle('warn', report.phase === 'dragging' && !report.hasTarget)
    const usable = report.canUse === true
    itemUseEl.classList.toggle('hidden', !usable)
    itemUseEl.disabled = !usable
    itemUseEl.textContent = ITEM_COPY.use(1)
  }

  // The hint is the tool's state read out loud, in the doc's own words (§8.10's copy table):
  // which path is live, whether the scope can be submitted, and — when the face edge cut it —
  // the area/N pair that §8.6 demands instead of an apologetic silence.
  function itemStatusHint(report) {
    if (report.phase === 'refresh-confirm') return ITEM_COPY.refreshConfirm
    if (!report.hasTarget) {
      return report.phase === 'dragging' ? ITEM_COPY.offFace : ITEM_COPY.tapHint
    }
    if (report.clear <= 0) return ITEM_COPY.noTarget
    const parts = [report.phase === 'dragging' ? ITEM_COPY.clearRelease(report.clear) : ITEM_COPY.clearN(report.clear)]
    if (report.clipped !== 'none') parts.unshift(ITEM_COPY.clipped(report.area, report.clear))
    if (report.shared) parts.push(ITEM_COPY.shared)
    return parts.join(' · ')
  }

  // §8.8: the batch question, asked where the batch is. The copy is set once (it is static text
  // from the planning table) and only its visibility changes.
  function renderRefreshConfirm(open) {
    refreshConfirmEl.classList.toggle('hidden', !open)
    refreshConfirmEl.setAttribute('aria-hidden', String(!open))
    refreshConfirmCopyEl.textContent = ITEM_COPY.refreshConfirm
  }

  // §8.9: 取消 ≠ 撤销. The undo window gets a real bar with a real button (≥44px) instead of a
  // clickable toast, because a toast can be painted over by the next ordinary message while the
  // charge is still refundable.
  function renderUndoBar(state) {
    const visible = Boolean(state)
    undoBarEl.classList.toggle('hidden', !visible)
    undoBarEl.setAttribute('aria-hidden', String(!visible))
    if (!visible) return
    undoBarTextEl.textContent = state.text
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

  // The candidate strip's DOM half (refactor P9): one button per piece, its chip colour, the
  // thumbnail canvas it draws into and the pointer wiring. Where the piece may go is not
  // decided here; the previews that paint those canvases are pieceView's, reached through the
  // injected dispose/create callbacks (plan §4: 把建 preview 的调用交给 pieceView，不把
  // renderer 放进 UI 状态).
  function renderPieceSlots() {
    disposePiecePreviews()
    slotsEl.innerHTML = ''
    getPieces().forEach((piece, index) => {
      const slot = document.createElement('button')
      slot.className = `piece-slot${piece.used ? ' used' : ''}${getSelectedPiece() === piece ? ' selected' : ''}`
      slot.type = 'button'
      slot.dataset.index = index
      slot.style.setProperty('--piece-color', colorHex(piece.shape.color))
      slot.setAttribute('aria-label', `${piece.shape.name}, ${piece.shape.cells.length} blocks`)

      const thumb = document.createElement('span')
      thumb.className = 'piece-thumb'
      const canvas = document.createElement('canvas')
      canvas.className = 'piece-preview-canvas'
      canvas.setAttribute('aria-hidden', 'true')
      thumb.appendChild(canvas)

      slot.append(thumb)
      bindSlot(slot, piece)
      slotsEl.appendChild(slot)
      createPiecePreview(piece, canvas, slot)
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
    renderItemStatus,
    renderRefreshConfirm,
    renderUndoBar,
    renderPieceSlots,
  }
}

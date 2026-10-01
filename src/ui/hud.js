// HUD presentation: score/best pills, status line, toast, the reward note, the score pop and
// the item bar / rocket Row-Col readout.
//
// Refactor P1 (temp/VoxalBlast-渐进式模块拆分重构执行计划.md §6). Everything here is DOM:
// markup templates, class toggles and their own one-shot timers. Nothing here decides a
// rule — the values arrive through getters and the one action that is not presentation
// (the reward note's own sound, which belongs to the audio bus) arrives with the event.
//
// v0.10.3 (docs/Technical/SCORE_REWARD_SIMPLIFICATION_HANDOFF.md §3.1): the resident CHAIN pill
// is GONE — the component, its bar, its milestone flash and its break animation — and the
// honour banner is replaced by ONE merged reward note. The chain itself is still counted and
// still saved (it is what pays the streak reward); it just has no permanent home on screen any
// more, and the space it took is given back to the layout instead of being hidden in place.
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
import { AUDIO_STYLE, REWARD_NOTE } from '../rendering/config.js'
import { formatNumber, t } from '../i18n/index.js'
import { ITEM_COPY, ITEM_NAME } from './itemCopy.js'

// The four icons exactly as index.html draws them. The status bar repeats the icon of whatever is
// armed so the bar can never be read as belonging to a different tool than the highlighted one.
const ITEM_ICON = Object.freeze({
  refresh: '↻', hammer: '🔨', rocket: '🚀', bomb: '💣',
})

// The score ROLL (v0.9.29). The pill's number counts up to the value the board already holds
// instead of snapping to it: a jump from 120 to 168 is a number the player has to RE-READ,
// while a number that runs up is a reward they watch land. The producer's report was exactly
// this — 加分的反馈太弱.
//
// Presentation only: nothing here decides a score, it decides how the one `getScore()`
// already reports gets painted on the way there. The length is proportional to the points
// because the roll IS the receipt — a 12-point placement that takes half a second lies about
// what it earned, and a 600-point one that takes three seconds is a wait. minMs covers the
// smallest build, maxMs caps a big clear, tickMs rate-limits the counting click so a long
// roll cannot machine-gun the audio (the same reason playChainSound caps its pitch), and
// settleMs is how long the landing bump stays on the number (styles.css repeats the number;
// CSS cannot read this file).
const SCORE_ROLL = Object.freeze({
  minMs: 260,
  maxMs: 900,
  perPoint: 1.5,
  // v0.10.1 (§6.1): the counting click's own rate limit is the AUDIO BUS's constant now — the
  // request is capped at one per `tickMinIntervalMs` and at `tickMaxPerRoll` per roll. The
  // NUMBER is untouched by either: it still repaints every frame and still lands on the score
  // the board reports.
  tickMs: AUDIO_STYLE.tickMinIntervalMs,
  tickMax: AUDIO_STYLE.tickMaxPerRoll,
  settleMs: 420,
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
  // The score roll's two noises (v0.9.29). The sound is not this module's to make, so it
  // arrives as a callback and hud.js decides only WHEN a tick is owed (the counting click,
  // with how far the roll has run) and when the number is DONE (the landing chord, with how
  // many points it just landed). Whether anything is heard at all is effects' and the sound
  // switch's business.
  onScoreTick,
  onScoreSettle,
}) {
  const {
    statusEl,
    toastEl,
    scoreEl,
    bestEl,
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

  // ---- the score roll (v0.9.29, SCORE_ROLL above) --------------------------------
  // `shownScore` is what the pill is PAINTING, which for the few hundred ms a roll lasts is
  // deliberately not what the board holds. Every other reader of the score reads the board
  // through getScore(), so nothing downstream can ever see this number.
  let shownScore = getScore()
  let roll = null
  let rollFrame = 0
  let settleTimer

  function paintScore(value) {
    scoreEl.textContent = String(value).padStart(4, '0')
  }

  function endRoll() {
    cancelAnimationFrame(rollFrame)
    rollFrame = 0
    roll = null
  }

  function startRoll(target) {
    endRoll()
    const distance = target - shownScore
    roll = {
      from: shownScore,
      target,
      distance,
      startedAt: null, // stamped by the first frame — see stepRoll
      ms: Math.min(SCORE_ROLL.maxMs, SCORE_ROLL.minMs + distance * SCORE_ROLL.perPoint),
      ticks: 0,
      lastTickAt: -Infinity,
    }
    scoreEl.classList.remove('settled')
    scoreEl.classList.add('rolling')
    fitScores()
    rollFrame = requestAnimationFrame(stepRoll)
  }

  // easeOutCubic: fast off the line, soft on the landing. A linear count reads as a timer.
  //
  // The clock is the rAF clock and ONLY the rAF clock: `startedAt` is stamped by the first
  // frame, not by performance.now() at the release. A callback scheduled during a frame is
  // handed that frame's START time, which can be EARLIER than the performance.now() the
  // release ran at — the first step then comes out negative and the pill paints a number like
  // `00-2`, i.e. a NaN frame (tools/score-roll-probe.mjs caught exactly that on the first
  // run). Math.max(0) is cheap insurance against any browser handing back a stamp from before
  // the frame; a backgrounded tab is what the Math.min(1, ...) is for.
  function stepRoll(now) {
    rollFrame = 0
    if (!roll) return
    if (roll.startedAt === null) roll.startedAt = now
    const k = Math.min(1, Math.max(0, (now - roll.startedAt) / roll.ms))
    const value = Math.round(roll.from + roll.distance * (1 - (1 - k) ** 3))
    if (value !== shownScore) {
      shownScore = value
      paintScore(value)
      // The click rides the counter but never at frame rate: a speaker that ticks sixty
      // times a second is noise, not a reward. `k < 1` keeps the last frame for the landing.
      if (k < 1 && roll.ticks < SCORE_ROLL.tickMax && now - roll.lastTickAt >= SCORE_ROLL.tickMs) {
        roll.ticks += 1
        roll.lastTickAt = now
        onScoreTick?.(k)
      }
    }
    if (k < 1) rollFrame = requestAnimationFrame(stepRoll)
    else landRoll()
  }

  function landRoll() {
    if (!roll) return
    const { target, distance } = roll
    endRoll()
    shownScore = target
    paintScore(target)
    scoreEl.classList.remove('rolling')
    // The landing is the frame the player is meant to remember: the number is already exact,
    // and the bump (CSS) plus the chord (effects) are what say "that was the total".
    scoreEl.classList.add('settled')
    clearTimeout(settleTimer)
    settleTimer = setTimeout(() => scoreEl.classList.remove('settled'), SCORE_ROLL.settleMs)
    fitScores()
    onScoreSettle?.(distance)
  }

  // Snap — never roll — when the number goes DOWN, and when the caller says so. A downward
  // count is a new run or a restored save, and a score that counts backwards reads as a bug.
  function snapScore() {
    endRoll()
    shownScore = getScore()
    paintScore(shownScore)
    scoreEl.classList.remove('rolling', 'settled')
  }

  function setStatus(text) { statusEl.textContent = text }

  function showToast(text, duration = 1500) {
    toastEl.textContent = text
    toastEl.classList.add('visible')
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => toastEl.classList.remove('visible'), duration)
  }

  // Every caller that is not a placement passes `{ snap: true }` — a restored save has to
  // come back on the number it was saved at, and counting up to it would be a lie about a
  // move the player never made.
  function updateHud({ snap = false } = {}) {
    const target = getScore()
    if (snap || target < shownScore) snapScore()
    // A roll already running to the same number is left alone: one placement calls updateHud
    // more than once (renderBoard, then the record write at game over), and those extra calls
    // must not restart its clock.
    else if (target > shownScore && roll?.target !== target) startRoll(target)
    // BEST is a secondary pill: same chip language, smaller type (04「UI 与发布」修订条款).
    // Grouped per locale: the same number is 12,340 in English and 12 340 in some others, and
    // a hard-coded 'en-US' is exactly the kind of bug a second language exposes.
    bestEl.textContent = formatNumber(getBest())
    // Outside a roll the number is already right, so this only re-fits after a resize, a
    // locale change or a four-digit number becoming five (the roll re-fits when it lands).
    fitScores()
  }

  // 08 §6's score pop, as narrowed by v0.10.3 §3.3: 一个总分跳字, and the number it carries is
  // the hand's TOTAL (基础分 + 三类奖励). It deliberately says nothing else — the categories,
  // their counts and their own `+N` are the reward note's job, and two plates naming the same
  // hand is the duplication the round exists to remove. `quiet` keeps the small variant for a
  // placement that cleared nothing but still paid (§4.1 放置分).
  function showScorePop(points, { quiet = false } = {}) {
    const pop = document.createElement('div')
    pop.className = quiet ? 'score-pop quiet' : 'score-pop'
    pop.innerHTML = `<strong>+${points}</strong>`
    sceneWrap.appendChild(pop)
    requestAnimationFrame(() => pop.classList.add('visible'))
    setTimeout(() => pop.remove(), quiet ? 640 : 920)
  }

  // ---- the reward note (v0.10.3 §3.3) -------------------------------------------
  // ONE main title, ONE merged detail line, and nothing else: 不顺次弹三张奖状、不另起附属荣誉
  // 徽章行. It consumes the rewardEvent the settlement produced — it never re-counts lines,
  // never re-decides whether a bonus was owed, and never shows a zero-bonus category.
  //
  // The title's category is also the first entry of the detail, exactly as the doc's own
  // example reads (「清空 1 面」/「3 线 +200 · 连消 4 次 +150 · 清面 +300」), because the detail
  // is the receipt for the whole hand and not "everything except the headline".
  const rewardTitle = (reward) => t(`reward.${reward.type}.title`, { n: reward.count })
  const rewardDetail = (reward) => `${t(`reward.${reward.type}.detail`, { n: reward.count })} +${reward.bonus}`

  function showRewardNote(event) {
    const rewards = event?.rewards || []
    if (!rewards.length) return null
    const primary = rewards.find((reward) => reward.type === event.primaryType) || rewards[0]
    const note = document.createElement('div')
    note.className = `reward-note reward-note-${String(event.primaryType || primary.type).toLowerCase()}`
    // The eventId is on the DOM so a headless check can prove one placement produced one note,
    // and a re-render (resize, language switch) did not produce a second.
    note.dataset.eventId = String(event.eventId)
    note.innerHTML = `<strong>${rewardTitle(primary)}</strong>`
      + `<small>${rewards.map(rewardDetail).join(' · ')}</small>`
    honorLayerEl.appendChild(note)
    requestAnimationFrame(() => note.classList.add('visible'))
    // §3.4: 700–1000ms for one category, up to 1200ms when several fired — and never resident.
    const hold = rewards.length > 1 ? REWARD_NOTE.holdMultiMs : REWARD_NOTE.holdMs
    setTimeout(() => {
      note.classList.remove('visible')
      setTimeout(() => note.remove(), REWARD_NOTE.exitMs)
    }, hold)
    return note
  }

  // A new run, a resume or a home press takes the note with it: a reward plate that survives
  // into the next board would describe a placement the player cannot see any more.
  function clearRewardNotes() {
    honorLayerEl.querySelectorAll('.reward-note').forEach((note) => note.remove())
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
      if (nameEl) nameEl.textContent = ITEM_NAME[id] || id
      // The tooltip is translated too (07 §8.3: the name alone does not explain the tool).
      button.setAttribute('title', t(`item.title.${id}`))
      button.setAttribute('aria-label', ITEM_NAME[id] || id)
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
    const pieces = getPieces()
    // The canvases are CARRIED OVER, not rebuilt: each one owns the WebGL context its preview
    // renderer draws through, and a fresh context means every shader program in it compiles
    // again — measured at ~56ms for the three slots on a desktop GPU, on the very frame the third
    // piece is placed (v0.9.30, tools/drop-hitch-probe.mjs). The buttons around them are still
    // rebuilt, because each carries the pointer handlers for the piece it holds.
    const canvases = [...slotsEl.children].map((slot) => slot.querySelector('canvas'))
    slotsEl.innerHTML = ''
    pieces.forEach((piece, index) => {
      const slot = document.createElement('button')
      slot.className = `piece-slot${piece.used ? ' used' : ''}${getSelectedPiece() === piece ? ' selected' : ''}`
      slot.type = 'button'
      slot.dataset.index = index
      slot.style.setProperty('--piece-color', colorHex(piece.shape.color))
      slot.setAttribute('aria-label', t('a11y.pieceSlot', {
        name: piece.shape.name,
        blocks: piece.shape.cells.length,
      }))

      const thumb = document.createElement('span')
      thumb.className = 'piece-thumb'
      const canvas = canvases[index] || document.createElement('canvas')
      canvas.className = 'piece-preview-canvas'
      canvas.setAttribute('aria-hidden', 'true')
      thumb.appendChild(canvas)

      slot.append(thumb)
      bindSlot(slot, piece)
      slotsEl.appendChild(slot)
      createPiecePreview(piece, canvas, slot, index)
    })
    // A shorter hand (a save that could not be completed) leaves its surplus slots behind: those
    // previews have no canvas in the strip any more and must release their context.
    disposePiecePreviews(pieces.length)
  }

  return {
    setStatus,
    showToast,
    updateHud,
    showScorePop,
    showRewardNote,
    clearRewardNotes,
    clearHonorLayer,
    renderItemBar,
    renderAxisPick,
    renderItemStatus,
    renderRefreshConfirm,
    renderUndoBar,
    renderPieceSlots,
  }
}

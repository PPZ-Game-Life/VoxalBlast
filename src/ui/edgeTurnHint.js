import './edgeTurnHint.css'
import { t } from '../i18n/index.js'

const ARROWS = { left: '←', right: '→', top: '↑', bottom: '↓' }

// v0.9.11 — the card is drawn NEXT TO THE PIECE, not at the screen edge it is named after.
// The turn now arms where the piece is carried off the cube, which can be anywhere inside the
// canvas (the cube is centred), so a fixed viewport-edge card would point at a corner the
// player is not looking at. `x` / `y` are the client px where the edge was armed; the card is
// placed beside that point and flipped to whichever side has room.
const CARD_GAP = 18

export function createEdgeTurnHint() {
  const hint = document.createElement('div')
  hint.className = 'edge-turn-hint'
  hint.hidden = true
  hint.setAttribute('aria-hidden', 'true')
  hint.innerHTML = '<div class="edge-turn-card"><span class="edge-turn-arrow"></span><span class="edge-turn-label"></span><span class="edge-turn-track"><i></i></span></div>'
  document.body.append(hint)
  const card = hint.querySelector('.edge-turn-card')
  const arrow = hint.querySelector('.edge-turn-arrow')
  const label = hint.querySelector('.edge-turn-label')
  return state => {
    hint.hidden = !state
    if (!state) return
    hint.dataset.edge = state.edge
    hint.dataset.phase = state.phase
    hint.style.setProperty('--turn-progress', state.progress)
    arrow.textContent = ARROWS[state.edge]
    // Read at draw time, never captured: the card can be on screen when the player switches
    // language, and the next state update repaints it (docs/Technical/LOCALIZATION.md).
    label.textContent = t(state.phase === 'turning' ? 'edgeturn.turning' : 'edgeturn.hold')
    const half = card.offsetWidth / 2 || 46
    const flipX = state.x > window.innerWidth * 0.5 ? -1 : 1
    const flipY = state.y > window.innerHeight * 0.62 ? -1 : 1
    card.style.left = `${Math.min(Math.max(state.x + flipX * (half + CARD_GAP), half + 6), window.innerWidth - half - 6)}px`
    card.style.top = `${Math.min(Math.max(state.y + flipY * 58, 66), window.innerHeight - 66)}px`
  }
}

import './edgeTurnHint.css'

const ARROWS = { left: '←', right: '→', top: '↑', bottom: '↓' }

export function createEdgeTurnHint() {
  const hint = document.createElement('div')
  hint.className = 'edge-turn-hint'
  hint.hidden = true
  hint.setAttribute('aria-hidden', 'true')
  hint.innerHTML = '<div class="edge-turn-card"><span class="edge-turn-arrow"></span><span class="edge-turn-label"></span><span class="edge-turn-track"><i></i></span></div>'
  document.body.append(hint)
  const arrow = hint.querySelector('.edge-turn-arrow')
  const label = hint.querySelector('.edge-turn-label')
  return state => {
    hint.hidden = !state
    if (!state) return
    hint.dataset.edge = state.edge
    hint.dataset.phase = state.phase
    hint.style.setProperty('--turn-progress', state.progress)
    arrow.textContent = ARROWS[state.edge]
    label.textContent = state.phase === 'turning' ? 'Turning…' : 'Hold to turn'
  }
}

// Game Over panel presentation.
//
// Refactor P1 (temp/VoxalBlast-渐进式模块拆分重构执行计划.md §6). This module owns the
// card's DOM and nothing else: it reads the run and the score summary it is handed and
// writes text/innerHTML. It deliberately does NOT call `recordStore.recordRun()` or clear
// the resume slot — the order "local record first, then clear the snapshot, then submit to
// the platform" is orchestration and stays in main.endGame() where it always was.
import { FACES } from '../game/board.js'
import { HUD_STYLE } from '../rendering/config.js'

export function createGameOver({ els, getRun }) {
  const { gameOverBestEl, gameOverFacesEl, gameOverHonorsEl, gameOverStatsEl } = els

  // The run is read through a getter, never captured in a local. resetRun() and
  // applySession() rewrite these counters (and swap `facesLit` for a new Set) in place, so
  // a destructured copy taken once at construction would silently go stale — the exact trap
  // the plan's state table calls out.
  function bestDimensionLabel() {
    const run = getRun()
    if (run.maxLinesOneMove >= 4) return `本局名场面 · 单次 ${run.maxLinesOneMove} 线`
    if (run.honorCounts.TRIFACE) return `本局三面同爆 ${run.honorCounts.TRIFACE} 次`
    if (run.bestChain >= 3) return `本局最长链 ${run.bestChain}`
    return `本局点亮 ${run.facesLit.size}/6 面`
  }

  // The Game Over panel is the "再来一局" screen (08 §7.5), so it leads with the delta to
  // the record, not with the score the player just watched count up. Every branch here is a
  // reason to press PLAY AGAIN once more.
  function renderGameOver(summary) {
    const run = getRun()
    if (summary.isNewBest) {
      gameOverBestEl.textContent = '★ NEW BEST!'
      gameOverBestEl.className = 'game-over-best new-best'
    } else if (summary.previousBest > 0 && summary.gapRatio < HUD_STYLE.bestGapRatio) {
      gameOverBestEl.textContent = `差 ${summary.gapToBest.toLocaleString('en-US')} 分破纪录`
      gameOverBestEl.className = 'game-over-best close'
    } else {
      gameOverBestEl.textContent = bestDimensionLabel()
      gameOverBestEl.className = 'game-over-best'
    }

    // 六面制霸 progress. §5.2 forbids shipping the BADGE (its old threshold fired in
    // 100% of games), but the progress bar is the panel's "next goal" and stays.
    const lit = run.facesLit.size
    gameOverFacesEl.innerHTML = `<span class="faces-label">六面制霸</span>`
      + FACES.map((face, index) => `<i class="${index < lit ? 'lit' : ''}"></i>`).join('')
      + `<small>${lit}/6</small>`

    const earned = Object.entries(run.honorCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([id, times]) => `<span class="honor-badge">${id} ×${times}</span>`)
      .join('')
    gameOverHonorsEl.innerHTML = earned || '<span class="game-over-empty">本局还没拿到荣誉</span>'

    gameOverStatsEl.innerHTML = [
      `最长链 <strong>${run.bestChain}</strong>`,
      `单次最多 <strong>${run.maxLinesOneMove}</strong> 线`,
      `三面同爆 <strong>${run.honorCounts.TRIFACE || 0}</strong> 次`,
      `本周最佳 <strong>${summary.weeklyBest.toLocaleString('en-US')}</strong>`,
    ].map((text) => `<span>${text}</span>`).join('')
  }

  return { renderGameOver, bestDimensionLabel }
}

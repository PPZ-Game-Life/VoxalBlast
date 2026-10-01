// Game Over panel presentation.
//
// Refactor P1 (temp/VoxalBlast-渐进式模块拆分重构执行计划.md §6). This module owns the
// card's DOM and nothing else: it reads the run and the score summary it is handed and
// writes text/innerHTML. It deliberately does NOT call `recordStore.recordRun()` or clear
// the resume slot — the order "local record first, then clear the snapshot, then submit to
// the platform" is orchestration and stays in main.endGame() where it always was.
import { FACES } from '../game/board.js'
import { SCORE_RULES_VERSION } from '../game/scoring.js'
import { HUD_STYLE } from '../rendering/config.js'
import { formatNumber, t } from '../i18n/index.js'

export function createGameOver({ els, getRun }) {
  const { gameOverBestEl, gameOverFacesEl, gameOverHonorsEl, gameOverStatsEl } = els

  // v0.10.1 (CLEAR_CELEBRATION_AUDIO_HANDOFF.md §4.4): the record moment happens ONCE per run.
  // The card is re-rendered for reasons that have nothing to do with the record — a language
  // switch, a resize — and 重复 render 不再触发 is a hard requirement, so the trigger is tied to
  // the SUMMARY OBJECT identity: main re-renders from the same `lastSummary`, so a second
  // render of the same record finds this flag already set and only repaints the text.
  let celebratedSummary = null

  // The card's own paper: a ring of chips around the record line, drawn from the same three
  // paper tones as the in-play celebration. Pure overlay — `pointer-events:none`,
  // `aria-hidden` and no focusable node, so the buttons stay usable the whole time (§4.4
  // 按钮立即可用) and a screen reader hears the card, not the decoration.
  function paperRing(hostEl) {
    const ring = document.createElement('div')
    ring.className = 'record-paper'
    ring.setAttribute('aria-hidden', 'true')
    for (let i = 0; i < 14; i += 1) {
      const chip = document.createElement('i')
      const side = i % 2 === 0 ? -1 : 1
      chip.className = `record-chip tone-${i % 3}`
      // Spread down both sides of the card, never across the score or the buttons.
      chip.style.setProperty('--paper-x', `${side * (46 + (i % 4) * 8)}px`)
      chip.style.setProperty('--paper-y', `${(i % 7) * 18 - 40}px`)
      chip.style.setProperty('--paper-turn', `${(i % 5) * 22 - 44}deg`)
      chip.style.setProperty('--paper-delay', `${(i % 4) * 45}ms`)
      ring.appendChild(chip)
    }
    hostEl.appendChild(ring)
    return ring
  }

  /**
   * The new-record moment, called by main.endGame() with the summary the record book just
   * returned — never from a live score crossing BEST mid-run, and never from a re-render.
   */
  function celebrateNewBest(summary) {
    if (!summary?.isNewBest || celebratedSummary === summary) return false
    celebratedSummary = summary
    gameOverBestEl.classList.add('stamped')
    const host = gameOverBestEl.parentElement
    paperRing(host || gameOverBestEl)
    // §4.4: 全部飞行装饰结束，只留静态纪录标识 — the paper unmounts itself and the `stamped`
    // mark stays.
    setTimeout(() => { host?.querySelector('.record-paper')?.remove() }, 1700)
    return true
  }

  // The run is read through a getter, never captured in a local. resetRun() and
  // applySession() rewrite these counters (and swap `facesLit` for a new Set) in place, so
  // a destructured copy taken once at construction would silently go stale — the exact trap
  // the plan's state table calls out.
  //
  // v0.10.3 (§5.3): the card follows the rules the finished run played under. A version-2 run
  // has no honours to name — listing 「本局 TRIPLE +150」 for one would be a description of a
  // reward it could not win — and a version-1 run has no three-category tally. The two branches
  // below are the only place that decides which vocabulary the card speaks.
  function isCurrentRules(run) {
    return run.scoreRulesVersion === SCORE_RULES_VERSION
  }

  function bestDimensionLabel() {
    const run = getRun()
    if (run.maxLinesOneMove >= 4) return t('gameover.dim.bigMove', { n: run.maxLinesOneMove })
    if (isCurrentRules(run)) {
      if (run.faceWipes > 0) return t('gameover.dim.faceClear', { n: run.faceWipes })
    } else if (run.honorCounts.TRIFACE) {
      return t('gameover.dim.triface', { n: run.honorCounts.TRIFACE })
    }
    if (run.bestChain >= 3) return t('gameover.dim.chain', { n: run.bestChain })
    return t('gameover.dim.faces', { n: run.facesLit.size })
  }

  // The Game Over panel is the "再来一局" screen (08 §7.5), so it leads with the delta to
  // the record, not with the score the player just watched count up. Every branch here is a
  // reason to press PLAY AGAIN once more.
  //
  // Every string goes through t() at RENDER time, and main re-calls this with the same
  // summary when the player switches language, so the card it is standing on never keeps the
  // language the player just left.
  function renderGameOver(summary) {
    const run = getRun()
    // A run that was NOT a record clears the flag, so the next record in the same session still
    // fires, and a card left open across two runs cannot inherit the previous stamp.
    if (!summary.isNewBest && celebratedSummary) celebratedSummary = null
    if (!summary.isNewBest) gameOverBestEl.classList.remove('stamped')
    if (summary.isNewBest) {
      gameOverBestEl.textContent = t('gameover.newBest')
      gameOverBestEl.className = 'game-over-best new-best'
    } else if (summary.previousBest > 0 && summary.gapRatio < HUD_STYLE.bestGapRatio) {
      gameOverBestEl.textContent = t('gameover.gap', { n: formatNumber(summary.gapToBest) })
      gameOverBestEl.className = 'game-over-best close'
    } else {
      gameOverBestEl.textContent = bestDimensionLabel()
      gameOverBestEl.className = 'game-over-best'
    }

    // 六面制霸 progress. §5.2 forbids shipping the BADGE (its old threshold fired in
    // 100% of games), but the progress bar is the panel's "next goal" and stays.
    const lit = run.facesLit.size
    gameOverFacesEl.innerHTML = `<span class="faces-label">${t('gameover.facesLabel')}</span>`
      + FACES.map((face, index) => `<i class="${index < lit ? 'lit' : ''}"></i>`).join('')
      + `<small>${lit}/6</small>`

    // The badge wears the reward's NAME, not its id: '一次多消 ×2' is a database row, and the
    // catalogue is where that name is translated. A version-1 run still lists its honours —
    // that history is not rewritten, it is simply no longer earnable (§5.3). Both are sorted by
    // count, biggest first, which is the reading order the honour row always used.
    const current = isCurrentRules(run)
    const tally = (current
      ? Object.entries(run.rewardCounts || {}).map(([type, times]) => ({ label: t(`reward.${type}.name`), times }))
      : Object.entries(run.honorCounts).map(([id, times]) => ({ label: t(`honor.${id}.title`), times })))
      .filter((entry) => entry.times > 0)
      .sort((a, b) => b.times - a.times)
      .map((entry) => `<span class="honor-badge${current ? ' reward-badge' : ''}">${entry.label} ×${entry.times}</span>`)
      .join('')
    gameOverHonorsEl.innerHTML = tally
      || `<span class="game-over-empty">${t(current ? 'gameover.noRewards' : 'gameover.noHonors')}</span>`

    gameOverStatsEl.innerHTML = [
      { label: 'gameover.stat.chain', value: run.bestChain },
      { label: 'gameover.stat.lines', value: run.maxLinesOneMove },
      // 三面同爆 is a version-1 statistic: under the current rules the same slot reports the
      // faces actually emptied, which is what the round pays for (§2.4).
      current
        ? { label: 'gameover.stat.faceClear', value: run.faceWipes }
        : { label: 'gameover.stat.triface', value: run.honorCounts.TRIFACE || 0 },
      { label: 'gameover.stat.weekly', value: formatNumber(summary.weeklyBest) },
    ].map(({ label, value }) => `<span>${t(label)} <strong>${value}</strong></span>`).join('')
  }

  return { renderGameOver, bestDimensionLabel, celebrateNewBest }
}

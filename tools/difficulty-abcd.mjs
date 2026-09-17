#!/usr/bin/env node
// Measurement only. Nothing in src/ imports this runner or its experimental dealer.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import {
  SHAPE_NAMES, PLACEMENTS, POOLS, POOL_IDS, poolById, rngFor, stageAt, drawHand, makeOpening,
  occupiedCount, legalCount, chooseMove, settle,
} from './difficulty-model.mjs'

export const GROUPS = Object.freeze({
  A: { structured: false, staged: false, poolId: 'current', label: '现行开局 + 等概率发牌' },
  B: { structured: true, staged: false, poolId: 'current', label: '结构化开局 + 等概率发牌' },
  C: { structured: false, staged: true, poolId: 'current', label: '现行开局 + 阶段发牌' },
  D: { structured: true, staged: true, poolId: 'current', label: '结构化开局 + 阶段发牌' },
})

// Arm ids are `<pool>/<dealer>`, e.g. `e/staged`. The legacy A/B/C/D ids remain
// valid so the earlier opening experiment stays reproducible with one tool.
export const DEALERS = Object.freeze({ uniform: false, staged: true })

export function resolveGroup(id) {
  if (GROUPS[id]) return GROUPS[id]
  const [poolId, dealer, ...rest] = String(id).split('/')
  if (rest.length || !Object.prototype.hasOwnProperty.call(DEALERS, dealer)) {
    throw new Error(`unknown arm "${id}"; use A|B|C|D or <pool>/${Object.keys(DEALERS).join('|')} with pool in ${POOL_IDS.join(', ')}`)
  }
  return Object.freeze({
    structured: false,
    staged: DEALERS[dealer],
    poolId: poolById(poolId).id, // throws on an unknown pool id
    label: `${poolById(poolId).label} × ${dealer === 'staged' ? '阶段发牌' : '等概率发牌'}`,
  })
}

// Arms that share a pool differ only in the dealer (and vice versa): comparing every
// such pair isolates one factor instead of reporting a pool+dealer mixture.
function armPairs(ids) {
  const parts = new Map(ids.map((id) => [id, id.split('/')]))
  const pairs = []
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const [leftPool, leftDealer] = parts.get(ids[i])
      const [rightPool, rightDealer] = parts.get(ids[j])
      if ((leftPool === rightPool) !== (leftDealer === rightDealer)) pairs.push([ids[i], ids[j]])
    }
  }
  return pairs
}
const THRESHOLDS = [12, 30, 60, 120, 300, 600]
const SHAPE_SIZE = Object.fromEntries(SHAPE_NAMES.map((name) => [name, PLACEMENTS.find((p) => p.shape === name).indices.length]))
const mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null
const round = (x, digits = 3) => x == null ? null : Number(x.toFixed(digits))
const pct = (n, d) => d ? round(100 * n / d) : null
export const quantile = (xs, q) => xs.length ? [...xs].sort((a, b) => a - b)[Math.max(0, Math.ceil(q * xs.length) - 1)] : null

export function wilson(successes, total) {
  if (!total) return null
  const z = 1.959963984540054, p = successes / total, den = 1 + z * z / total
  const mid = (p + z * z / (2 * total)) / den
  const half = z * Math.sqrt(p * (1 - p) / total + z * z / (4 * total * total)) / den
  return [round(Math.max(0, mid - half) * 100), round(Math.min(1, mid + half) * 100)]
}

// Sum unique geometric placements for the distinct shapes still in hand. Duplicate
// candidate slots do not inflate this pressure proxy; it is NOT a probability.
export function mobility(state, hand) {
  return [...new Set(hand)].reduce((sum, shape) => sum + legalCount(state, shape), 0)
}

export function runGame({ group, seed, gameIndex, strategy = 'noise', stepCap = 600, trace = false }) {
  const config = resolveGroup(group)
  if (!Number.isSafeInteger(stepCap) || stepCap < 1) throw new Error('stepCap must be a positive integer')
  const opening = makeOpening({ seed, gameIndex, ...config })
  let state = opening.state, hand = [...opening.hand], steps = 0, ended = false
  const dealRng = rngFor(seed, gameIndex, 'deal'), policyRng = rngFor(seed, gameIndex, 'policy')
  const firstHand = drawHand(dealRng, 0, config.staged, config.poolId)
  if (JSON.stringify(firstHand) !== JSON.stringify(hand)) throw new Error('First-hand RNG stream drift')
  let firstClearStep = null, clearMoves = 0, clearedCells = 0, addedCells = 0
  let dry = 0, longestDry = 0, tightMoves = 0, samePreHandMobilityReleases = 0
  let deals = 1, freshDealStuck = 0, justDealt = true, lineTotal = 0
  const bins = new Map(), traceRows = [], dealShapeCounts = Object.fromEntries(SHAPE_NAMES.map((name) => [name, 0]))
  hand.forEach((s) => dealShapeCounts[s]++)
  for (;;) {
    if (!hand.length) {
      hand = drawHand(dealRng, steps, config.staged, config.poolId)
      hand.forEach((s) => dealShapeCounts[s]++)
      deals++; justDealt = true
    }
    const move = chooseMove(state, hand, policyRng, strategy)
    if (!move) {
      ended = true
      if (justDealt) freshDealStuck++
      break
    }
    // At exactly the cap check terminal status, but never execute cap+1.
    if (steps === stepCap) break
    const before = mobility(state, hand)
    const beforeCount = occupiedCount(state)
    const tight = before <= 8
    const result = settle(state, move.pl)
    // Measure geometric release with the SAME hand, before removing the used slot.
    const released = tight && result.lines > 0 && mobility(result.state, hand) >= before + 8
    const bucket = Math.floor(steps / 12) * 12
    if (!bins.has(bucket)) bins.set(bucket, { start: bucket, samples: 0, occupied: 0, mobility: 0, tight: 0, clear: 0, added: 0, removed: 0 })
    const bin = bins.get(bucket)
    bin.samples++; bin.occupied += beforeCount; bin.mobility += before
    bin.tight += Number(tight); bin.clear += Number(result.lines > 0)
    bin.added += SHAPE_SIZE[hand[move.slot]]; bin.removed += result.cellsCleared
    if (trace) traceRows.push({ step: steps, occupied: beforeCount, mobility: before, stage: config.staged ? stageAt(steps).name : 'uniform', hand: [...hand], slot: move.slot, placementId: move.pl.id, cleared: result.cellsCleared })
    tightMoves += Number(tight); samePreHandMobilityReleases += Number(released)
    addedCells += SHAPE_SIZE[hand[move.slot]]; clearedCells += result.cellsCleared; lineTotal += result.lines
    steps++
    if (result.lines > 0) {
      clearMoves++; dry = 0
      if (firstClearStep == null) firstClearStep = steps
    } else {
      dry++; longestDry = Math.max(longestDry, dry)
    }
    state = result.state
    hand.splice(move.slot, 1)
    justDealt = false
  }
  const { witness, ...openingMeta } = opening.meta
  const record = {
    group, seed, gameIndex, strategy, steps, ended, censored: !ended,
    pool: config.poolId, dealer: config.staged ? 'staged' : 'uniform',
    opening: openingMeta, firstHand, firstClearStep, clearMoves, lineTotal,
    addedCells, clearedCells, longestDry, tightMoves, samePreHandMobilityReleases,
    deals, freshDealStuck, finalOccupied: occupiedCount(state), dealShapeCounts,
  }
  return { record, bins: [...bins.values()], trace: trace ? { ...record, openingWitness: witness ?? null, moves: traceRows } : null }
}

export function summarizeGames(records, stepCap = 600) {
  const ended = records.filter((g) => g.ended), n = records.length
  const endingQuantile = (q) => {
    const x = quantile(records.map((g) => g.ended ? g.steps : Infinity), q)
    return x == null ? null : Number.isFinite(x) ? x : `>${stepCap}`
  }
  const ratioOfSums = (numerator, denominator) => pct(records.reduce((a, g) => a + (g[numerator] || 0), 0), records.reduce((a, g) => a + (g[denominator] || 0), 0))
  const survivalAt = (step) => {
    if (step > stepCap) return { step, pct: null, ci95: null, reason: 'beyond observation cap' }
    const successes = records.filter((g) => g.steps >= step).length
    return { step, pct: pct(successes, n), ci95: wilson(successes, n) }
  }
  const structured = records.filter((g) => g.opening.accepted != null)
  const fallbacks = structured.filter((g) => g.opening.fallback).length
  const totalSteps = records.reduce((a, g) => a + g.steps, 0)
  const totalDeals = records.reduce((a, g) => a + g.deals, 0)
  const shapeCounts = Object.fromEntries(SHAPE_NAMES.map((name) => [name, records.reduce((a, g) => a + (g.dealShapeCounts?.[name] || 0), 0)]))
  const totalDealtSlots = Object.values(shapeCounts).reduce((sum, count) => sum + count, 0)
  return {
    games: n, endedGames: ended.length, endedPct: pct(ended.length, n), endedCi95: wilson(ended.length, n),
    censoredGames: n - ended.length, censoredPct: pct(n - ended.length, n),
    // Administrative censoring at a common cap: restricted mean E[min(T, cap)],
    // not a forecast of unrestricted session length.
    restrictedMeanSteps: round(mean(records.map((g) => g.steps))),
    endStepsAll: { p50: endingQuantile(0.5), p75: endingQuantile(0.75), p90: endingQuantile(0.9) },
    endStepsEndedOnly: { n: ended.length, p50: quantile(ended.map((g) => g.steps), 0.5), p90: quantile(ended.map((g) => g.steps), 0.9) },
    earlyEndBefore12Pct: pct(records.filter((g) => g.ended && g.steps < 12).length, n),
    survival: THRESHOLDS.map(survivalAt),
    // Full curve retains sub-12-step differences in opening quality.
    survivalCurve: Array.from({ length: stepCap + 1 }, (_, step) => survivalAt(step)),
    firstClearObservedPct: pct(records.filter((g) => g.firstClearStep != null).length, n),
    firstClearObservedP50: quantile(records.map((g) => g.firstClearStep).filter((x) => x != null), 0.5),
    firstClearBy3Pct: pct(records.filter((g) => g.firstClearStep != null && g.firstClearStep <= 3).length, n),
    clearMovePct: pct(records.reduce((a, g) => a + g.clearMoves, 0), totalSteps),
    longestDryP50: quantile(records.map((g) => g.longestDry), 0.5),
    tightMovePct: pct(records.reduce((a, g) => a + g.tightMoves, 0), totalSteps),
    samePreHandMobilityReleasePct: ratioOfSums('samePreHandMobilityReleases', 'tightMoves'),
    freshDealStuckPct: ratioOfSums('freshDealStuck', 'deals'),
    gamesEndingOnFreshDealPct: pct(records.filter((g) => g.freshDealStuck > 0).length, n),
    meanOpeningCells: round(mean(records.map((g) => g.opening.actualCount))),
    openingCellHistogram: Object.fromEntries([...new Set(records.map((g) => g.opening.actualCount))].sort((a, b) => a - b).map((count) => [count, records.filter((g) => g.opening.actualCount === count).length])),
    structured: {
      games: structured.length, fallbacks, fallbackPct: pct(fallbacks, structured.length),
      baselineAlreadyQualified: structured.filter((g) => g.opening.accepted && g.opening.attempts === 1).length,
      resampledQualified: structured.filter((g) => g.opening.accepted && g.opening.attempts > 1).length,
      fallbackReasons: Object.fromEntries([...new Set(structured.filter((g) => g.opening.fallback).map((g) => g.opening.reason))].map((reason) => [reason, structured.filter((g) => g.opening.fallback && g.opening.reason === reason).length])),
      meanAttempts: round(mean(structured.map((g) => g.opening.attempts))),
      searchBudgetExhaustions: structured.reduce((a, g) => a + (g.opening.searchBudgetExhaustions || 0), 0),
      exactOccupancyMatches: structured.filter((g) => g.opening.actualCount === g.opening.baselineCount).length,
    },
    totalDeals, totalDealtSlots,
    shapeCounts, // Raw exposure totals, NOT directly comparable probabilities.
    shapePctOfDealtSlots: Object.fromEntries(SHAPE_NAMES.map((name) => [name, pct(shapeCounts[name], totalDealtSlots)])),
  }
}

function aggregateBins(runs) {
  const totals = new Map()
  for (const run of runs) for (const bin of run.bins) {
    if (!totals.has(bin.start)) totals.set(bin.start, { start: bin.start, games: 0, samples: 0, occupied: 0, mobility: 0, tight: 0, clear: 0, added: 0, removed: 0 })
    const total = totals.get(bin.start)
    total.games++
    for (const key of ['samples', 'occupied', 'mobility', 'tight', 'clear', 'added', 'removed']) total[key] += bin[key]
  }
  return [...totals.values()].sort((a, b) => a.start - b.start).map((b) => ({
    start: b.start, games: b.games, samples: b.samples,
    meanOccupied: round(b.occupied / b.samples), meanMobility: round(b.mobility / b.samples),
    tightMovePct: pct(b.tight, b.samples), clearMovePct: pct(b.clear, b.samples),
    meanNetAdded: round((b.added - b.removed) / b.samples),
  }))
}

export function pairedComparison(left, right, stepCap) {
  const key = (r) => `${r.seed}/${r.gameIndex}`
  const leftMap = new Map(left.map((g) => [key(g), g]))
  const rightMap = new Map(right.map((g) => [key(g), g]))
  if (leftMap.size !== left.length || rightMap.size !== right.length) throw new Error('Paired comparison contains duplicate seed/game keys')
  if (leftMap.size !== rightMap.size || [...leftMap.keys()].some((id) => !rightMap.has(id))) throw new Error('Paired comparison requires identical seed/game key sets')
  const pairs = left.map((g) => [g, rightMap.get(key(g))])
  return {
    pairs: pairs.length,
    restrictedMeanStepDifferenceRightMinusLeft: round(mean(pairs.map(([a, b]) => b.steps - a.steps))),
    endedPctPointDifferenceRightMinusLeft: round(100 * mean(pairs.map(([a, b]) => Number(b.ended) - Number(a.ended)))),
    thresholds: THRESHOLDS.filter((t) => t <= stepCap).map((step) => ({
      step,
      survivalPctPointDifferenceRightMinusLeft: round(100 * mean(pairs.map(([a, b]) => Number(b.steps >= step) - Number(a.steps >= step)))),
      leftOnlySurvived: pairs.filter(([a, b]) => a.steps >= step && b.steps < step).length,
      rightOnlySurvived: pairs.filter(([a, b]) => b.steps >= step && a.steps < step).length,
    })),
  }
}

export async function runExperiment(options) {
  const { groups, seeds, games, strategies, stepCap, mode } = options
  const allRecords = [], summaries = [], traces = []
  for (const strategy of strategies) for (const group of groups) {
    const runs = []
    for (const seed of seeds) {
      const started = performance.now(), seedRecords = []
      for (let gameIndex = 0; gameIndex < games; gameIndex++) {
        const run = runGame({ group, seed, gameIndex, strategy, stepCap, trace: gameIndex === 0 })
        runs.push(run); allRecords.push(run.record); seedRecords.push(run.record)
        if (run.trace) traces.push(run.trace)
      }
      console.log(`${strategy}/${group}/seed=${seed}: n=${games}, ended=${seedRecords.filter((g) => g.ended).length}, ${(performance.now() - started).toFixed(0)}ms`)
    }
    const records = runs.map((r) => r.record)
    summaries.push({
      strategy, group, label: resolveGroup(group).label,
      ...summarizeGames(records, stepCap), bins: aggregateBins(runs),
      bySeed: seeds.map((seed) => {
        const { survivalCurve, ...summary } = summarizeGames(records.filter((g) => g.seed === seed), stepCap)
        return { seed, ...summary }
      }),
    })
  }
  const pairSpecs = mode === 'arms' ? armPairs(groups) : [['A', 'B'], ['A', 'C'], ['B', 'D'], ['C', 'D']]
  const comparisons = []
  for (const strategy of strategies) for (const [left, right] of pairSpecs) {
    if (!groups.includes(left) || !groups.includes(right)) continue
    comparisons.push({ strategy, left, right, ...pairedComparison(
      allRecords.filter((g) => g.group === left && g.strategy === strategy),
      allRecords.filter((g) => g.group === right && g.strategy === strategy), stepCap,
    ) })
  }
  return { summaries, comparisons, records: allRecords, traces }
}

const ROOT = fileURLToPath(new URL('../', import.meta.url))
function fingerprints() {
  const files = ['src/game/board.js', 'src/game/shapes.js', 'src/rendering/config.js', 'tools/difficulty-model.mjs', 'tools/difficulty-abcd.mjs']
  return Object.fromEntries(files.map((file) => [file, createHash('sha256').update(fs.readFileSync(path.join(ROOT, file))).digest('hex')]))
}
const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const PALETTE = ['#1261a0', '#23925c', '#db8a08', '#b94574', '#7a4fd0', '#0f9ba6', '#c0561f', '#5c6f2a', '#8a3ab0', '#2f7fd8', '#a8572d', '#1f9c6b']
function chart(series, xMax, yMax, title, xLabel, yLabel) {
  const w = 820, h = 310, l = 64, t = 25, iw = 730, ih = 235
  const lines = series.map((s) => `<polyline fill="none" stroke="${s.color}" stroke-width="2" points="${s.points.map(([x, y]) => `${l + x / xMax * iw},${t + ih - y / yMax * ih}`).join(' ')}"/>`).join('')
  const labels = Array.from({ length: 6 }, (_, i) => `<text x="${l - 8}" y="${t + ih - ih * i / 5 + 4}" text-anchor="end">${round(yMax * i / 5, 1)}</text><line x1="${l}" x2="${l + iw}" y1="${t + ih - ih * i / 5}" y2="${t + ih - ih * i / 5}" stroke="#ddd"/>`).join('')
  return `<h3>${escape(title)}</h3><svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${escape(title)}"><text x="8" y="14">${escape(yLabel)}</text>${labels}${lines}<text x="${l}" y="${h - 25}">0</text><text x="${l + iw - 30}" y="${h - 25}">${xMax}</text><text x="${w / 2}" y="${h - 4}" text-anchor="middle">${escape(xLabel)}</text></svg>`
}

export function htmlReport(result) {
  const colorOf = new Map([...new Set(result.summaries.map((s) => s.group))].map((group, index) => [group, PALETTE[index % PALETTE.length]]))
  const isPoolRun = result.options.mode === 'arms'
  const headline = isPoolRun ? 'VoxalBlast 候选池 × 发牌测量' : 'VoxalBlast A/B/C/D 测量'
  const note = isPoolRun
    ? '<p>同一开局的候选池与发牌权重对照。池只存在于测量工具中：正式游戏仍发十种等权重，本轮未改玩法。</p>'
    : '<p>结构化失败时保持配对占用量并回退原局，回退纳入主分析。</p>'
  const content = result.options.strategies.map((strategy) => {
    const summaries = result.summaries.filter((s) => s.strategy === strategy)
    const rows = summaries.map((s) => `<tr><td><span style="color:${colorOf.get(s.group)}">${escape(s.group)}</span> ${escape(s.label)}</td><td>${s.games}</td><td>${s.endedPct}% [${s.endedCi95.join(', ')}]<br>各种子：${s.bySeed.map((x) => `${x.seed}: ${x.endedPct}%`).join(' / ')}</td><td>${escape(s.endStepsAll.p50)}</td><td>${s.restrictedMeanSteps}</td><td>${s.endStepsEndedOnly.p50 ?? '—'}</td><td>${s.firstClearBy3Pct}%</td>${isPoolRun ? '' : `<td>${s.structured.fallbackPct ?? '—'}%</td>`}</tr>`).join('')
    const series = (pick) => summaries.map((s) => ({ group: s.group, color: colorOf.get(s.group), points: pick(s) }))
    const curve = chart(series((s) => s.survivalCurve.map((p) => [p.step, p.pct])), result.options.stepCap, 100, '生存曲线 S(n)：完成至少 n 步的比例', '成功落子数', '%')
    const occupancy = chart(series((s) => s.bins.map((b) => [b.start, b.meanOccupied])), result.options.stepCap, 98, '压力代理：在场对局平均占用格数', '落子步数（12步窗口）', '格')
    const maxMobility = Math.max(1, ...summaries.flatMap((s) => s.bins.map((b) => b.meanMobility)))
    const moves = chart(series((s) => s.bins.map((b) => [b.start, b.meanMobility])), result.options.stepCap, Math.ceil(maxMobility / 100) * 100, '压力代理：剩余不同形状的合法落点总数', '落子步数（12步窗口）', '落点')
    const clear = chart(series((s) => s.bins.map((b) => [b.start, b.clearMovePct])), result.options.stepCap, 100, '节奏代理：有消除的落子比例', '落子步数（12步窗口）', '%')
    return `<section><h2>策略：${escape(strategy)}</h2><table><thead><tr><th>组</th><th>局数</th><th>自然结束率 [模拟95% Wilson区间]</th><th>全体P50</th><th>截断平均步数</th><th>已结束局中位</th><th>前3步有消除</th>${isPoolRun ? '' : '<th>结构化回退</th>'}</tr></thead><tbody>${rows}</tbody></table>${curve}${occupancy}${moves}${clear}</section>`
  }).join('')
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${headline}</title><style>body{font:16px/1.65 system-ui,sans-serif;color:#233;background:#faf9f5;max-width:1080px;margin:32px auto;padding:0 18px}table{border-collapse:collapse;font-size:14px;width:100%}td,th{border:1px solid #ccc;padding:8px;text-align:left}svg{width:100%;background:white}svg text{font-size:12px}section{margin-top:36px}.legend span{margin-right:22px;font-weight:bold}code{overflow-wrap:anywhere}</style><h1>${headline}</h1><p>测量版本 ${escape(result.schemaVersion)}；5×5、三候选、无道具，正式玩法未修改。每组每种子 ${result.options.games} 局；种子 ${result.options.seeds.join(', ')}；上限 ${result.options.stepCap} 步。</p><p>没有通关条件，故不报告“胜率”。超过观察上限属于右删失，不是600步通关。截断平均不是实际平均局长。机器人不是经过真人校准的水平分层，也不是最优策略。Wilson区间只表达此模拟策略的抽样不确定性，不包含真人差异或模型误差；逐种子结束率列在下表。</p><p>后段压力曲线仅统计仍在场对局，会有幸存者偏差；曲线不能证明心流或乐趣。</p>${note}<div class="legend">${[...colorOf].map(([group, color]) => `<span style="color:${color}">${escape(group)}</span>`).join('')}</div>${content}<h2>复现</h2><code>${escape(result.command)}</code><p>完整参数、源码SHA256、逐局记录、逐种子统计及每种子第0局轨迹见同名JSON。</p></html>`
}

export function parseArgs(argv) {
  const allowed = new Set(['games', 'seeds', 'groups', 'arms', 'strategies', 'step-cap', 'out'])
  const opts = {}
  for (const arg of argv) {
    const match = /^--([^=]+)=(.+)$/.exec(arg)
    if (!match || !allowed.has(match[1])) throw new Error(`Unknown/invalid argument ${arg}; use --name=value`)
    if (opts[match[1]] !== undefined) throw new Error(`Repeated argument ${match[1]}`)
    opts[match[1]] = match[2]
  }
  const positive = (value, label) => {
    const n = Number(value)
    if (!Number.isSafeInteger(n) || n < 1) throw new Error(`${label} must be a positive integer`)
    return n
  }
  const list = (value, label) => {
    const parts = value.split(',')
    if (parts.some((s) => !s) || new Set(parts).size !== parts.length) throw new Error(`${label} must contain unique non-empty values`)
    return parts
  }
  if (opts.arms && opts.groups) throw new Error('use either --arms or --groups, not both')
  const mode = opts.arms ? 'arms' : 'groups'
  const groups = list(opts.arms || opts.groups || 'A,B,C,D', mode)
  const strategies = list(opts.strategies || 'noise', 'strategies')
  if (mode === 'groups' && groups.some((g) => !GROUPS[g])) throw new Error('groups must be A,B,C,D')
  groups.forEach((g) => resolveGroup(g)) // throws on an unknown pool id or dealer
  if (strategies.some((s) => !['noise', 'greedy', 'random', 'space'].includes(s))) throw new Error('Unknown strategy')
  const seeds = list(opts.seeds || '1,2,3', 'seeds').map((s) => {
    const n = Number(s)
    if (!Number.isSafeInteger(n) || n < 0 || n > 0xffffffff) throw new Error('seeds must be uint32')
    return n
  })
  if (new Set(seeds).size !== seeds.length) throw new Error('seeds must be numerically unique')
  return {
    groups, arms: mode === 'arms' ? [...groups] : null, mode, strategies, seeds,
    games: positive(opts.games || 200, 'games'), stepCap: positive(opts['step-cap'] || 600, 'step-cap'),
    out: opts.out || (mode === 'arms' ? 'tools/results/difficulty-pools.json' : 'tools/results/difficulty-abcd.json'),
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2)), started = performance.now()
  const result = {
    schemaVersion: 1, generatedAt: new Date().toISOString(),
    command: `node tools/difficulty-abcd.mjs ${process.argv.slice(2).join(' ')}`,
    options, fingerprints: fingerprints(),
    design: {
      board: '5x5x5 shell / 98 unique cells', batch: 3, items: false,
      rng: 'mulberry32, independently hashed seed/game/stream',
      mode: options.mode,
      pools: [...new Set(options.groups.map((group) => resolveGroup(group).poolId))].map((id) => ({
        id, label: POOLS[id].label,
        weights: Object.fromEntries(POOLS[id].entries.map((entry) => [entry.name, entry.weight])),
      })),
      poolDealing: 'Uniform arms draw from the pool\'s cumulative weight table; staged arms renormalize the stage weights over the groups the pool still covers. Every slot consumes exactly two random values in both arms, so paired streams stay aligned.',
      structured: 'Exact paired baseline cell count; fixed first hand; >=2 distinct shapes with >=2 unique placements; immediate +z clear with witnessed complete three-piece path; bounded search; explicit baseline fallback',
      stages: [0, 12, 30, 48, 54, 72, 78].map((step) => ({ step, ...stageAt(step) })),
      censoring: 'Stop after exactly cap successful placements; check terminal state there. Quantiles beyond the observed range are >cap.',
      survival: 'S(n)=P(successful placements >= n); no win condition',
      pressure: 'Mobility counts unique occupied-cell placements per distinct remaining shape; tight<=8; samePreHandMobilityReleasePct is a geometric counterfactual: clear followed by SAME PRE-MOVE hand mobility increase >=8, not actual post-move hand recovery.',
      confidence: 'Wilson intervals quantify Monte Carlo uncertainty under this model/actor only; not model error or real-player confidence intervals. See bySeed for seed sensitivity.',
      strategies: {
        noise: 'First playable slot; 25% random unique physical placement, otherwise maximum immediate lines. New geometry enumeration/tie order differs from historical reachability; not a byte-identical historical replay.',
        greedy: 'First playable slot, maximum immediate lines; not optimal.',
        space: 'Across all slots, top-6 by 100000*immediately cleared unique cells + 100*empty shell cells + occupied orthogonal adjacency; select most remaining-hand legal placements, ties use preliminary score. Pruned moves cannot win; no future-deal knowledge; not optimal.',
        random: 'Uniform across legal slot/unique-physical-placement moves; not calibrated to a novice.',
      },
      binning: '12-placement windows, observations conditional on still playing; survivor bias applies.',
      fallbackPolicy: 'Baseline fallback retained in intention-to-treat comparison; never excluded as a failed sample.',
    },
    ...await runExperiment(options),
  }
  result.elapsedMs = Math.round(performance.now() - started)
  fs.mkdirSync(path.dirname(options.out), { recursive: true })
  fs.writeFileSync(options.out, `${JSON.stringify(result, null, 2)}\n`)
  const htmlPath = options.out.replace(/\.json$/i, '') + '.html'
  fs.writeFileSync(htmlPath, htmlReport(result))
  // The full file carries every per-game record, trace and step-by-step curve
  // (tens of MB at larger sample sizes) and stays out of version control; the
  // summary sidecar keeps the aggregates, paired comparisons, threshold survival
  // and source fingerprints at commit size. Curves and window bins are dropped
  // here on purpose — the HTML next to it is the chart deliverable.
  const { records, traces, ...aggregate } = result
  aggregate.summaries = result.summaries.map(({ survivalCurve, bins, ...rest }) => rest)
  aggregate.omitted = {
    records: records.length,
    traces: traces.length,
    curves: 'per-step survivalCurve and 12-step bins live in the full JSON and the HTML only',
    note: 'Per-game records, traces and curves are omitted from this committed summary; the full JSON sits next to it and is not versioned.',
  }
  const summaryPath = options.out.replace(/\.json$/i, '') + '.summary.json'
  fs.writeFileSync(summaryPath, `${JSON.stringify(aggregate, null, 2)}\n`)
  console.log(`Wrote ${options.out}, ${summaryPath} and ${htmlPath}; ${result.records.length} games; ${result.elapsedMs}ms`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.stack); process.exitCode = 1 })
}

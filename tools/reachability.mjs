#!/usr/bin/env node
// VoxalBlast 荣誉系统可达性与频率验证器 (v0.3)
//
// 为什么需要它：荣誉/倍率的手工推导已多次出错（跨面上限算成 10，实际 12；
// CUBE_BURST 以为可达，实际不可能；PERFECT_STRIKE 以为史诗，实际 6000 局 0 次）。
// 本工具用程序给出可复现的答案。
//
// 模型不再"镜像"游戏代码，而是**直接 import 游戏代码**（v0.3 同源改造）：
//   - 棋盘/六面/晶格映射：src/game/board.js（SH / FACES / faceLattice）
//   - 拼块池：src/game/shapes.js（v0.2.31 已移除 Line 4，旧版验证器还带着它）
//   - 计分：src/game/scoring.js（v0.3 倍率表 + 跨面加法 + 连消链）
//   - 荣誉：src/game/honors.js（v0.4 五枚规模系 + 理论区）
// 这样"模型与规则漂移"不再可能：规则一改，验证器的结论跟着改。
//
// 用法：
//   node tools/reachability.mjs all
//   node tools/reachability.mjs p1                                  # 仅完备穷举
//   node tools/reachability.mjs p2 --strategy=noise --games=2000    # 仅对局模拟
//   node tools/reachability.mjs all --out=tools/reachability-baseline.json
//
// Phase 1（完备穷举）：对每个（拼块 × 朝向 × 落点）DFS 枚举所有可行缺口组合。
//   结论是**可证明的**——搜索树里没出现的事件即不可达。
//   利用立方体对称性，只扫 +z 面（其余 5 面与之等价）。
// Phase 2（对局模拟）：跑完整对局统计频率。
//   strategy=greedy 每步选消除线数最多的落点（上界玩家）
//   strategy=noise  75% 概率走 greedy、25% 随机（近似真人，默认）
//   strategy=random 全随机（下界玩家）
//
// ⚠️ 判读红线（09 §5）：phase1.timeUp == true 或 truncatedPlacements > 0 时搜索被
// 截断，该次结果**不能**用来证明任何事件不可达，只能证明「找到的那些可达」。

import fs from 'node:fs'
import { SH, FACES, faceLattice } from '../src/game/board.js'
import { SHAPES } from '../src/game/shapes.js'
import { moveScore, nextChain } from '../src/game/scoring.js'
import { HONORS as HONOR_TABLE, resolveHonors } from '../src/game/honors.js'

const argv = process.argv.slice(2)
const PHASE = argv.find((a) => !a.startsWith('--')) || 'all'
const opt = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : dflt
}
const STRATEGY = opt('strategy', 'noise')
const GAMES = Number(opt('games', 2000))
const STEP_CAP = Number(opt('stepCap', 600))
const OUT = opt('out', '')

// ---- 晶格索引 ------------------------------------------------------------
const idx = new Map()
const CELLS = []
for (let x = 0; x < SH; x++) for (let y = 0; y < SH; y++) for (let z = 0; z < SH; z++) {
  if (x === 0 || x === SH - 1 || y === 0 || y === SH - 1 || z === 0 || z === SH - 1) {
    idx.set(`${x},${y},${z}`, CELLS.length)
    CELLS.push([x, y, z])
  }
}
const BIT = (i) => 1n << BigInt(i)

// ---- 线 ------------------------------------------------------------------
const LINES = []
for (const face of FACES) {
  for (let v = 0; v < SH; v++) {
    const cs = []
    for (let u = 0; u < SH; u++) cs.push(idx.get(faceLattice(face, u, v).join(',')))
    LINES.push({ face, axis: 'row', n: v, cells: cs, mask: cs.reduce((m, i) => m | BIT(i), 0n) })
  }
  for (let u = 0; u < SH; u++) {
    const cs = []
    for (let v = 0; v < SH; v++) cs.push(idx.get(faceLattice(face, u, v).join(',')))
    LINES.push({ face, axis: 'col', n: u, cells: cs, mask: cs.reduce((m, i) => m | BIT(i), 0n) })
  }
}
LINES.forEach((l, i) => { l.id = i })

const FACE_MASK = {}
for (const face of FACES) {
  let m = 0n
  for (let u = 0; u < SH; u++) for (let v = 0; v < SH; v++) m |= BIT(idx.get(faceLattice(face, u, v).join(',')))
  FACE_MASK[face] = m
}

const LINES_BY_CELL = CELLS.map(() => [])
LINES.forEach((l) => l.cells.forEach((ci) => LINES_BY_CELL[ci].push(l.id)))

// ---- 拼块朝向与摆放 ------------------------------------------------------
const normalize = (cs) => {
  const mu = Math.min(...cs.map((c) => c[0])), mv = Math.min(...cs.map((c) => c[1]))
  return cs.map(([u, v]) => [u - mu, v - mv])
}
const rotate = (cs, q) => {
  let out = cs.map((c) => [c[0], c[1]])
  for (let i = 0; i < q; i++) out = normalize(out.map(([u, v]) => [-v, u]))
  return out
}
const shapeKey = (cs) => cs.map((c) => c.join(',')).sort().join('|')

const ORIENTS = []
for (const s of SHAPES) {
  const seen = new Set()
  for (let q = 0; q < 4; q++) {
    const cs = rotate(s.cells, q)
    const k = shapeKey(cs)
    if (seen.has(k)) continue
    seen.add(k)
    ORIENTS.push({ shape: s.name, cells: cs, size: cs.length })
  }
}

function buildPlacements(faces) {
  const out = []
  for (const face of faces) for (const o of ORIENTS) {
    const maxU = SH - 1 - Math.max(...o.cells.map((c) => c[0]))
    const maxV = SH - 1 - Math.max(...o.cells.map((c) => c[1]))
    for (let u = 0; u <= maxU; u++) for (let v = 0; v <= maxV; v++) {
      const cis = o.cells.map(([du, dv]) => idx.get(faceLattice(face, u + du, v + dv).join(',')))
      if (cis.some((c) => c === undefined)) continue
      const mask = cis.reduce((m, i) => m | BIT(i), 0n)
      const candSet = new Set()
      cis.forEach((ci) => LINES_BY_CELL[ci].forEach((li) => candSet.add(li)))
      out.push({ face, shape: o.shape, size: o.size, u, v, mask, cand: [...candSet] })
    }
  }
  return out
}

const ALL_PLACEMENTS = buildPlacements(FACES)

// ---- 结算 ----------------------------------------------------------------
function hasFullLine(state) {
  for (const l of LINES) if ((state & l.mask) === l.mask) return true
  return false
}

// 落子前 state 必须无满线；因此落子后新满的线必然包含至少一个拼块格，
// 只需检查 pl.cand（与拼块格相交的线）即可，被多个面共享的棱/角格天然跨面生效。
// 这与 board.place() 的 findAllFullLines() 等价——v0.3 起游戏本体也是六面全检。
function sim(state, pl) {
  const T = state | pl.mask
  const lines = []
  for (const li of pl.cand) {
    const l = LINES[li]
    if ((T & l.mask) === l.mask) lines.push(l)
  }
  let cleared = 0n
  for (const l of lines) cleared |= l.mask
  const R = T & ~cleared
  const faceSet = new Set()
  for (const l of lines) faceSet.add(l.face)
  return { T, R, lines, cleared, facesHit: faceSet.size, lineCount: lines.length }
}

function quickLineCount(state, pl) {
  const T = state | pl.mask
  let n = 0
  for (let i = 0; i < pl.cand.length; i++) {
    const l = LINES[pl.cand[i]]
    if ((T & l.mask) === l.mask) n++
  }
  return n
}

// v0.4 现行荣誉（同源 honors.js）+ v0.3 之前那 8 枚遗留荣誉。两套同时输出：新的
// 用于标定现行设计，旧的用于复现 09 报告里的频率表（那张表是现行门槛的依据）。
const CURRENT_HONORS = HONOR_TABLE.map((honor) => honor.id)
const LEGACY_HONORS = ['CROSS', 'DOUBLE_CROSS', 'PERFECT_STRIKE', 'DUAL_FACE', 'TRIPLE_FACE', 'CUBE_BURST', 'FACE_WIPE', 'PURE_CUBE']

function currentHonorIds(r) {
  return resolveHonors({ lines: r.lineCount, faces: r.facesHit }).ids
}

function legacyHonorIds(r) {
  const hs = []
  if (r.lineCount === 0) return hs
  const per = {}
  for (const l of r.lines) (per[l.face] ||= []).push(l)
  for (const f of Object.keys(per)) {
    const ls = per[f]
    const rows = ls.filter((l) => l.axis === 'row').length
    const cols = ls.filter((l) => l.axis === 'col').length
    if (rows >= 1 && cols >= 1) hs.push('CROSS')
    if (ls.length >= 4 && rows >= 2 && cols >= 2) hs.push('DOUBLE_CROSS')
    if (ls.length >= 5) hs.push('PERFECT_STRIKE')
  }
  if (r.facesHit >= 2) hs.push('DUAL_FACE')
  if (r.facesHit >= 3) hs.push('TRIPLE_FACE')
  if (r.facesHit >= 4) hs.push('CUBE_BURST')
  for (const f of FACES) {
    if ((r.T & FACE_MASK[f]) !== 0n && (r.R & FACE_MASK[f]) === 0n) { hs.push('FACE_WIPE'); break }
  }
  if (r.R === 0n) hs.push('PURE_CUBE')
  return [...new Set(hs)]
}

// ---- Phase 1：完备穷举 ---------------------------------------------------
function phase1() {
  const pls = buildPlacements(['+z'])
  const deadline = Date.now() + Number(process.env.P1_BUDGET_MS || 120000)
  const reachable = new Map()
  const maxByShape = new Map()
  let globalMax = 0, truncated = 0, nodesTotal = 0, timeUp = false

  for (const pl of pls) {
    const seen = new Set()
    let localMax = 0, nodes = 0, aborted = false
    const LIMIT = 40000
    const dfs = (start, S) => {
      if (aborted) return
      if (nodes++ > LIMIT) { aborted = true; return }
      if ((nodes & 2047) === 0 && Date.now() > deadline) { aborted = true; return }
      const k = S.toString(16)
      if (seen.has(k)) return
      seen.add(k)
      const r = sim(S, pl)
      if (r.lineCount > localMax) localMax = r.lineCount
      if (r.lineCount > globalMax) globalMax = r.lineCount
      for (const h of currentHonorIds(r)) reachable.set(h, (reachable.get(h) || 0) + 1)
      for (let j = start; j < pl.cand.length; j++) {
        const l = LINES[pl.cand[j]]
        if ((l.mask & pl.mask) === 0n) continue      // 该线没有拼块格，不可能被补满
        const S2 = S | (l.mask & ~pl.mask)
        if (hasFullLine(S2)) continue                // 落子前就有满线 -> 非法状态
        dfs(j + 1, S2)
      }
    }
    dfs(0, 0n)
    if (aborted) truncated++
    nodesTotal += nodes
    maxByShape.set(pl.shape, Math.max(maxByShape.get(pl.shape) || 0, localMax))
    if (Date.now() > deadline) { timeUp = true; break }
  }

  return {
    placementsScanned: pls.length,
    nodesTotal,
    truncatedPlacements: truncated,
    timeUp,
    complete: !timeUp && truncated === 0,
    maxLinesInOneMove: globalMax,
    maxLinesByShape: Object.fromEntries([...maxByShape].sort((a, b) => b[1] - a[1])),
    reachableHonors: Object.fromEntries([...reachable].sort((a, b) => b[1] - a[1])),
  }
}

// ---- Phase 2：对局模拟 ---------------------------------------------------
let seed = 12345
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }

const PL_BY_SHAPE = new Map()
for (const pl of ALL_PLACEMENTS) {
  if (!PL_BY_SHAPE.has(pl.shape)) PL_BY_SHAPE.set(pl.shape, [])
  PL_BY_SHAPE.get(pl.shape).push(pl)
}
const SHAPE_NAMES = SHAPES.map((s) => s.name)

function legalPlacements(state, shape) {
  const out = []
  for (const pl of PL_BY_SHAPE.get(shape)) if ((state & pl.mask) === 0n) out.push(pl)
  return out
}

function choosePlacement(state, shape) {
  const legal = legalPlacements(state, shape)
  if (!legal.length) return null
  if (STRATEGY === 'random') {
    const pl = legal[Math.floor(rnd() * legal.length)]
    return { pl, r: sim(state, pl) }
  }
  if (STRATEGY === 'noise' && rnd() < 0.25) {
    const pl = legal[Math.floor(rnd() * legal.length)]
    return { pl, r: sim(state, pl) }
  }
  let best = null, bestLines = -1
  for (const pl of legal) {
    const n = quickLineCount(state, pl)
    if (n > bestLines) { bestLines = n; best = pl }
  }
  return { pl: best, r: sim(state, best) }
}

const percentile = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0)

function phase2(games) {
  const lineHist = new Map(), faceHist = new Map(), crossHist = new Map()
  const honorGames = new Map(), honorTotal = new Map()
  const legacyGames = new Map(), legacyTotal = new Map()
  let sixFaceGames = 0, stepsTotal = 0, scoreTotal = 0, maxSteps = 0, capped = 0
  let chainsTotal = 0, maxChainSeen = 0, honorMovesTotal = 0
  const scores = []
  let maxLinesSeen = 0

  for (let g = 0; g < games; g++) {
    let state = 0n, steps = 0, score = 0, chain = 0, bestChain = 0
    const seenHere = new Set(), facesEverCleared = new Set(), legacyHere = new Set()
    let hand = [SHAPE_NAMES[Math.floor(rnd() * SHAPE_NAMES.length)], SHAPE_NAMES[Math.floor(rnd() * SHAPE_NAMES.length)], SHAPE_NAMES[Math.floor(rnd() * SHAPE_NAMES.length)]]

    for (;;) {
      if (steps > STEP_CAP) { capped++; break }
      let moved = false
      for (let i = 0; i < hand.length; i++) {
        const pick = choosePlacement(state, hand[i])
        if (!pick) continue
        const r = pick.r
        // 连消链（scoring.js 的 nextChain）：落子未消除即归零
        chain = nextChain(chain, r.lineCount)
        bestChain = Math.max(bestChain, chain)
        if (r.lineCount > 0) {
          lineHist.set(r.lineCount, (lineHist.get(r.lineCount) || 0) + 1)
          faceHist.set(r.facesHit, (faceHist.get(r.facesHit) || 0) + 1)
          const ck = `${r.lineCount}|${r.facesHit}`
          crossHist.set(ck, (crossHist.get(ck) || 0) + 1)
          if (r.lineCount > maxLinesSeen) maxLinesSeen = r.lineCount
          r.lines.forEach((l) => facesEverCleared.add(l.face))
          for (const h of currentHonorIds(r)) { seenHere.add(h); honorTotal.set(h, (honorTotal.get(h) || 0) + 1) }
          for (const h of legacyHonorIds(r)) { legacyHere.add(h); legacyTotal.set(h, (legacyTotal.get(h) || 0) + 1) }
          honorMovesTotal++
        }
        // 08 文档 §4 的四层计分：放置分 + 线分 + 跨面加法 + 链加成 + 荣誉加分
        const honors = resolveHonors({ lines: r.lineCount, faces: r.facesHit })
        score += moveScore({
          cellCount: pick.pl.size,
          lines: r.lineCount,
          faces: r.facesHit,
          chain,
          honorBonus: honors.bonus,
        }).total
        state = r.R
        steps++
        hand.splice(i, 1)
        moved = true
        break
      }
      if (!moved) break
      if (hand.length === 0) hand = [SHAPE_NAMES[Math.floor(rnd() * SHAPE_NAMES.length)], SHAPE_NAMES[Math.floor(rnd() * SHAPE_NAMES.length)], SHAPE_NAMES[Math.floor(rnd() * SHAPE_NAMES.length)]]
    }

    if (facesEverCleared.size >= 6) sixFaceGames++
    for (const h of seenHere) honorGames.set(h, (honorGames.get(h) || 0) + 1)
    for (const h of legacyHere) legacyGames.set(h, (legacyGames.get(h) || 0) + 1)
    chainsTotal += bestChain
    maxChainSeen = Math.max(maxChainSeen, bestChain)
    stepsTotal += steps; scoreTotal += score
    scores.push(score)
    if (steps > maxSteps) maxSteps = steps
  }

  scores.sort((a, b) => a - b)
  const byCount = (m) => Object.fromEntries([...m].sort((a, b) => a[0] - b[0]))
  return {
    strategy: STRATEGY,
    games,
    stepCap: STEP_CAP,
    gamesReachedStepCap: capped,
    avgStepsPerGame: +(stepsTotal / games).toFixed(1),
    maxStepsPerGame: maxSteps,
    avgScore: Math.round(scoreTotal / games),
    medianScore: Math.round(percentile(scores, 0.5)),
    // Score quantiles of THIS model. Real-player quantiles are still what 08 §4.6
    // asks for before any tier cut is fixed; these are here so the calibration step
    // has something to start from and a permanent reference to compare against.
    scorePercentiles: {
      p25: Math.round(percentile(scores, 0.25)),
      p50: Math.round(percentile(scores, 0.5)),
      p75: Math.round(percentile(scores, 0.75)),
      p90: Math.round(percentile(scores, 0.9)),
      p99: Math.round(percentile(scores, 0.99)),
    },
    maxLinesInOneMoveObserved: maxLinesSeen,
    avgBestChain: +(chainsTotal / games).toFixed(2),
    maxChainObserved: maxChainSeen,
    linesClearedPerMove: byCount(lineHist),
    facesHitPerMove: byCount(faceHist),
    linesByFaces: Object.fromEntries([...crossHist].sort()),
    honorOccurrencesPerGame: Object.fromEntries(CURRENT_HONORS.map((k) => [k, +((honorTotal.get(k) || 0) / games).toFixed(4)])),
    honorGamesPct: Object.fromEntries(CURRENT_HONORS.map((k) => [k, +((100 * (honorGames.get(k) || 0)) / games).toFixed(1)])),
    honorShareOfClears: Object.fromEntries(CURRENT_HONORS.map((k) => [k, honorMovesTotal ? +((100 * (honorTotal.get(k) || 0)) / honorMovesTotal).toFixed(4) : 0])),
    legacyHonorOccurrencesPerGame: Object.fromEntries(LEGACY_HONORS.map((k) => [k, +((legacyTotal.get(k) || 0) / games).toFixed(3)])),
    legacyHonorGamesPct: Object.fromEntries(LEGACY_HONORS.map((k) => [k, +((100 * (legacyGames.get(k) || 0)) / games).toFixed(1)])),
    sixFaceClearPct: +((100 * sixFaceGames) / games).toFixed(1),
  }
}

// ---- 运行 ----------------------------------------------------------------
const t0 = Date.now()
const p1 = PHASE === 'p2' ? null : phase1()
const t1 = Date.now()
const p2 = PHASE === 'p1' ? null : phase2(GAMES)
const t2 = Date.now()

const result = {
  generatedAt: new Date().toISOString(),
  model: {
    source: 'imported from src/game/{board,shapes,scoring,honors}.js',
    shellCells: CELLS.length,
    lines: LINES.length,
    placements: ALL_PLACEMENTS.length,
    orientations: ORIENTS.length,
    shapePool: SHAPE_NAMES,
  },
  phase1: p1 && { ...p1, ms: t1 - t0 },
  phase2: p2 && { ...p2, ms: t2 - t1 },
}

const json = JSON.stringify(result, null, 2)
if (OUT) {
  fs.writeFileSync(OUT, json)
  console.log(`written: ${OUT}`)
  console.log(json)
} else {
  console.log(json)
}

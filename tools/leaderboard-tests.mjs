// Global-board ranking tests — the pure half of the leaderboard panel (v0.12.0).
//
//   node tools/leaderboard-tests.mjs
//
// Why this exists. src/game/leaderboardRanking.js is the one part of the panel that makes a CLAIM
// about the player ("you are #N"), and every way of getting it wrong is a way of flattering or
// short-changing them: two rows on the same rank when the player's score is inserted into a board
// whose ranks were computed without them, a tie silently handed to the player, a NaN from a feed
// row sorting unpredictably and printing on screen. None of those fail a build, and all of them
// look plausible in a screenshot — so they are pinned here, in Node, with no browser.
//
// What it asserts:
//   1. an empty board stays empty, an unranked player stays unranked
//   2. a board with nobody ranked on it is ranked 1..n, best first
//   3. inserting the player SHIFTS the rows below them and drops the last one off the board
//   4. a tie is not a win: the player lands BELOW an entry with the same score
//   5. a player below the whole board still gets their true rank (n+1), board unchanged
//   6. junk scores (text, negative, missing) normalize to 0 instead of NaN, from the board AND
//      from the player's own row
//   7. the caller's array is not mutated, and board rows never carry the player-only marker
import assert from 'node:assert/strict'

import { rankBoard } from '../src/game/leaderboardRanking.js'

let passed = 0
const failures = []

function check(label, condition, detail = '') {
  if (condition) { passed += 1; return }
  failures.push(`${label}${detail ? ` — ${detail}` : ''}`)
}

function equal(label, actual, expected) {
  check(label, Object.is(actual, expected), `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`)
}

const board = (n) => Array.from({ length: n }, (_, index) => ({ name: `P${index + 1}`, score: (n - index) * 100 }))
const ranks = (rows) => rows.map((row) => row.rank)
const seq = (from, to) => Array.from({ length: to - from + 1 }, (_, index) => from + index)

// 1. nothing to rank -------------------------------------------------------------------------
{
  const empty = rankBoard([], null)
  equal('an empty board ranks nothing', empty.board.length, 0)
  equal('an empty board has no player row', empty.mine, null)

  const unranked = rankBoard(board(3), null)
  equal('no player row means no rank', unranked.mine, null)
  equal('the board is unchanged without the player', ranks(unranked.board).join(','), '1,2,3')
}

// 2. the board itself ------------------------------------------------------------------------
{
  const { board: rows } = rankBoard(board(20), null)
  equal('twenty entries render twenty rows', rows.length, 20)
  equal('ranks run 1..20', ranks(rows).join(','), seq(1, 20).join(','))
  check('best score first', rows[0].score === 2000 && rows[19].score === 100, `${rows[0].score}..${rows[19].score}`)
}

// 3. the player is inserted, not appended -----------------------------------------------------
{
  const { board: rows, mine } = rankBoard(board(20), { name: 'Me', score: 50000 })
  equal('a top score takes rank 1', mine.rank, 1)
  equal('the board still renders twenty rows', rows.length, 20)
  equal('every entry below the player moved down one', rows[0].rank, 2)
  equal('the last entry fell off the board', rows[19].rank, 21)
  check('no rank is printed twice', new Set(ranks(rows)).size === rows.length, ranks(rows).join(','))
  check('the player is not also on the board', rows.every((row) => !row.you))
}

// 4. a tie is not a win -----------------------------------------------------------------------
{
  const { board: rows, mine } = rankBoard([{ name: 'A', score: 1000 }, { name: 'B', score: 900 }], { name: 'Me', score: 1000 })
  equal('the player lands below the entry that already had the score', mine.rank, 2)
  equal('that entry keeps rank 1', rows[0].rank, 1)
  equal('the entry below both moves to 3', rows[1].rank, 3)
}

// 5. below the whole board --------------------------------------------------------------------
{
  const { board: rows, mine } = rankBoard(board(20), { name: 'Me', score: 1 })
  equal('a score below the board still has a true rank', mine.rank, 21)
  equal('the board itself is untouched', ranks(rows).join(','), seq(1, 20).join(','))
}

// 6. junk normalizes to 0, never NaN ----------------------------------------------------------
{
  const sources = [
    { name: 'A', score: '120' }, { name: 'B', score: -50 }, { name: 'C' }, { name: 'D', score: 'abc' },
  ]
  const { board: rows, mine } = rankBoard(sources, { name: 'Me', score: Number.NaN })
  check('every board score is a finite number', rows.every((row) => Number.isFinite(row.score)), JSON.stringify(rows))
  check('a text score is read as its number', rows.find((row) => row.name === 'A').score === 120)
  check('a negative score floors at zero', rows.find((row) => row.name === 'B').score === 0)
  check('a missing score is zero', rows.find((row) => row.name === 'C').score === 0)
  check('a NaN score is zero', rows.find((row) => row.name === 'D').score === 0)
  equal('a NaN player score is zero, not a rank above everyone', mine.score, 0)
  equal('…and it lands last', mine.rank, 5)
}

// 7. the caller's data is not touched ---------------------------------------------------------
{
  const input = Object.freeze([Object.freeze({ name: 'A', score: 100 }), Object.freeze({ name: 'B', score: 300 })])
  const { board: rows } = rankBoard(input, { name: 'Me', score: 200 })
  equal('input order is left alone', input.map((entry) => entry.name).join(','), 'A,B')
  equal('input objects gain nothing', Object.keys(input[0]).join(','), 'name,score')
  equal('the result is sorted best first', rows.map((row) => row.name).join(','), 'B,A')
}

console.log(`leaderboard-tests: ${passed}/${passed + failures.length} checks passed`)
if (failures.length) {
  console.log('\nFAILED:')
  failures.forEach((failure) => console.log(`  - ${failure}`))
  process.exitCode = 1
} else {
  console.log('board ranking holds: one ordering, ties honest, junk scores finite')
}

assert.ok(true)

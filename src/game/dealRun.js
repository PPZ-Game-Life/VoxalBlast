// One deal as a pure TRANSACTION (v0.9.31) — the code the main thread and the deal worker both run.
//
// WHY THIS FILE EXISTS. Until v0.9.31 the deal ran on the main thread inside the drop's own task
// (main.onDrop → nextPieces → session.deal → dealBatch), so the frame the player released a piece
// on also paid for the board-aware search: 36 proposals proven, the best few refined — measured at
// p50 40.6ms / max 51.9ms on this desktop and 3–5x that on a phone (tools/deal-perf.mjs,
// tools/drop-hitch-probe.mjs). Spec §11.2 names the fix: run the search OFF the main thread and
// give the game a "dealing" state. That is what this module makes possible.
//
// THE SHAPE OF IT: everything the deal needs goes in as JSON-able data (the board's cells, the
// director's save state, the random streams' save state, the reason) and everything it produces
// comes back the same way. Nothing here touches the session, the DOM or Three.js, so the SAME
// function is the main thread's synchronous fallback AND the worker's whole body — which is what
// makes "the worker deals exactly what the synchronous path would have dealt" a property of the
// code rather than a claim that needs a test to hold it up.
//
// WHAT IT DOES NOT DO: it does not commit. The caller decides when a returned batch becomes the
// player's hand (gameSession.commitDeal), and a refused batch hands back the state it was given so
// that "nothing was spent" is visible in the return value rather than implied.
import { Board } from './board.js'
import { createStreams } from './rng.js'
import {
  batchConstraints, beginNaturalBatch, currentIntent, noteDealt, refreshIntent,
  revive as reviveDirector, serialize as serializeDirector,
} from './dealDirector.js'
import { dealBatch } from './dealer.js'

// `cells` is the board's occupancy as [x, y, z, color] rows — the same shape the resume slot
// stores, so a deal request and a saved board are one format (session.js).
export function dealRequestSnapshot(cells, { director, streams, reason = 'natural' }) {
  return { cells, director, streams, reason: reason === 'refresh' ? 'refresh' : 'natural' }
}

// A refused batch is a FACT ABOUT THE POSITION, not an error: the cube has no legal placement for
// any shape. It carries no hand, moves neither the director nor the streams, and the caller keeps
// the hand it had — which is the state the stuck flow reads (gameSession, spec §7.2).
export function runDeal({ cells, director: directorState, streams: streamState, reason = 'natural' }) {
  const board = new Board()
  board.restore({ cells })
  const director = reviveDirector(directorState)
  const streams = createStreams(0)
  streams.restore(streamState)

  // A refresh deliberately skips the natural-batch step: it must not advance the run or shorten
  // Block 9's cooldown (§10.1), and the batch it deals is generated against the relief target.
  const isRefresh = reason === 'refresh'
  if (!isRefresh) beginNaturalBatch(director, streams.director())
  const intent = isRefresh ? refreshIntent(director) : currentIntent(director)
  const constraints = batchConstraints(director, { natural: !isRefresh })

  const result = dealBatch({
    board,
    director,
    intent,
    constraints,
    rng: streams.deal(),
    searchRng: streams.search(),
    beforeHands: director.recentHands,
  })

  if (!result.hand) {
    return {
      ok: false,
      names: null,
      metrics: result.metrics,
      witness: null,
      reason: result.metrics.fallback,
      // Handed back unchanged, so the caller has nothing to commit.
      director: directorState,
      streams: streamState,
    }
  }

  noteDealt(director, result.names, { natural: !isRefresh })
  return {
    ok: true,
    names: result.names,
    metrics: result.metrics,
    witness: result.witness,
    director: serializeDirector(director),
    streams: streams.snapshot(),
  }
}

// The deal worker (v0.9.31): the board-aware search, off the main thread.
//
// A module worker whose whole body is `runDeal` — the same function the main thread calls as its
// synchronous fallback (game/dealRun.js). It deals nothing by itself: it answers one request with
// one JSON-able result, so the thread that owns the run decides when a batch becomes the hand.
//
// THE MESSAGE CONTRACT (deal-worker-tests.mjs exercises it without a browser):
//   in : { id, request: { cells, director, streams, reason } }
//   out: { id, ok: true,  result }                       — the deal, committed by the caller
//        { id, ok: false, error }                        — the worker itself failed; the caller
//                                                          falls back to dealing on its own thread
//
// A batch that cannot be dealt is NOT a worker failure — that comes back as `ok: true` with
// `result.ok === false` (dealRun.js owns the difference), so a browser can never mistake "the cube
// is full" for "the worker broke".
import { runDeal } from './dealRun.js'

export function answerDealRequest(data) {
  const id = data && data.id
  try {
    return { id, ok: true, result: runDeal(data.request) }
  } catch (error) {
    return { id, ok: false, error: String((error && error.message) || error) }
  }
}

// `self` exists in a real worker and nowhere else, so this module stays importable from Node —
// which is what lets the message contract be tested without launching a browser.
if (typeof self !== 'undefined' && typeof self.postMessage === 'function') {
  self.onmessage = (event) => { self.postMessage(answerDealRequest(event.data)) }
}

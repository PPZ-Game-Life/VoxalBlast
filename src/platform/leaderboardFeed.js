// Global board feed — the ONE seam between the leaderboard panel and wherever the standings
// actually come from.
//
// docs/Technical/LEADERBOARD_GLOBAL_BOARD_HANDOFF.md. Today the answer is SAMPLE_BOARD
// (platform/leaderboardMock.js): twenty made-up players, rendered through the real panel so the
// final shape can be reviewed before the platform integration exists. The panel does not know
// that, and it must not have to: it asks this module for a board and renders whatever comes
// back, tagged with whether the source was real.
//
// THE SWAP POINT IS `global()`'s FIRST BRANCH. When the platform can give the client entries
// (a read API on the SDK, or our own endpoint behind `platform`), it answers first and the
// sample board is not reached — no UI change, no second render path, and the 「sample」 chip in
// the panel turns itself off because the result says `sample: false`. Deleting
// leaderboardMock.js afterwards is then the whole cleanup.
//
// Where the numbers OUTSIDE the entries come from: the season key is weekKey() — the same
// Monday-09:00-UTC ISO week the platform's weekly seasons (and the player's own weekly best)
// already use, so a real board and the local record wall cannot disagree about which week it is.
import { weekKey } from '../game/records.js'
import { SAMPLE_BOARD } from './leaderboardMock.js'

// How many rows a rendered board holds. Twenty is one screen and a bit on a phone; the feed
// clamps to it so a real backend returning 500 entries cannot blow up the panel's DOM.
export const BOARD_LIMIT = 20

export function createLeaderboardFeed({ platform = null, board = SAMPLE_BOARD } = {}) {
  return {
    /**
     * The global standings for the current season.
     *
     * Resolves — never rejects — to:
     *   { entries: [{ name, score }], season: '2026-W42', me: null, sample: true }
     *
     * `entries` is already limited and already ordered best-first; the panel re-sorts nothing it
     * is given and ranks nothing on its own except the player's own row (which is local data).
     * `me` is the platform's own answer about the player when it has one (null today, and null
     * for an unranked player); the panel falls back to ranking the LOCAL best against the board.
     * `sample` is the honesty flag every surface reads before it claims a standing is real.
     */
    async global({ limit = BOARD_LIMIT } = {}) {
      // ---- the swap point: a platform that can hand us entries goes first ----------------
      if (typeof platform?.fetchLeaderboard === 'function') {
        try {
          const remote = await platform.fetchLeaderboard({ limit })
          if (remote && Array.isArray(remote.entries) && remote.entries.length > 0) {
            return {
              entries: remote.entries.slice(0, limit),
              season: typeof remote.season === 'string' && remote.season ? remote.season : weekKey(),
              me: remote.me ?? null,
              sample: false,
            }
          }
        } catch {
          // §7.4 失败即静默降级: a board that fails to load takes nothing else down. The panel
          // shows the sample board rather than an error, and it still says it is a sample.
        }
      }
      // ---- today's answer ---------------------------------------------------------------
      return { entries: board.slice(0, limit), season: weekKey(), me: null, sample: true }
    },
  }
}

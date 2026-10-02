// Ranking a global board against the player's own score — PURE, and therefore testable in Node
// (tools/leaderboard-tests.mjs), because this is the one piece of the leaderboard panel that
// makes a CLAIM: "you are #N".
//
// docs/Technical/LEADERBOARD_GLOBAL_BOARD_HANDOFF.md. The panel gets a board from
// platform/leaderboardFeed.js and the player's own score from the local record book. This module
// puts the two into ONE sorted list so every rank on screen comes from the same ordering.
//
// Three decisions worth stating, because each is a way to lie to a player:
//
//  1. ONE LIST. Inserting the player's score moves the entries below it down (their ranks shift by
//     one and one entry falls off the bottom) rather than printing a board whose ranks were
//     computed without the player and a "your rank" that was computed with them. Two rows claiming
//     the same place is the classic version of this bug.
//  2. A TIE GOES TO THE PLAYER'S DISADVANTAGE. `Array.prototype.sort` is stable, so the player's
//     row, appended last, stays BELOW every entry with the same score. Equality is not a win.
//  3. A BAD ENTRY IS A ZERO, NEVER A NaN. A feed can hand over a missing, negative or non-numeric
//     score (after the platform integration it is remote data); a NaN would sort unpredictably and
//     print "NaN" on the board, so every score is normalized here, once, and the ranking never
//     depends on the caller having validated anything.
//
// When the platform knows the player's real standing it hands `me` to the panel, and the panel
// passes it here: the arithmetic is the same either way, so a locally ranked row and a remotely
// ranked one cannot disagree about how ties are broken.

const toScore = (value) => {
  const score = Number(value)
  return Number.isFinite(score) ? Math.max(0, Math.trunc(score)) : 0
}

const toName = (value) => String(value ?? '')

/**
 * Rank one board with the player's own row inserted.
 *
 * @param {Array<{name?: string, score?: number}>} entries  the board, as the source gave it
 * @param {{name?: string, score?: number}|null} me          the player's row, or null when the
 *                                                           player has no score to rank
 * @returns {{board: Array, mine: object|null}} `board` holds exactly as many rows as `entries`
 *          (one falls off the bottom when the player is inserted), each with its `rank`;
 *          `mine` is the player's row with its rank, or null.
 */
export function rankBoard(entries = [], me = null) {
  const list = (Array.isArray(entries) ? entries : []).map((entry) => ({
    name: toName(entry?.name),
    score: toScore(entry?.score),
  }))
  // `you` marks the player's row; it is the ONLY difference between the two row shapes, so the
  // renderer needs no second template.
  const mine = me ? { name: toName(me.name), score: toScore(me.score), you: true } : null

  const ranked = [...list, ...(mine ? [mine] : [])]
    .sort((a, b) => b.score - a.score)
    .map((entry, index) => ({ ...entry, rank: index + 1 }))

  return {
    // `you` is the identity marker, not a field of the data: the spread above copies it, so the
    // player's row is filtered out by ITS OWN flag rather than by object identity (which the
    // `.map` has already broken).
    board: ranked.filter((entry) => !entry.you).slice(0, list.length),
    mine: ranked.find((entry) => entry.you) || null,
  }
}

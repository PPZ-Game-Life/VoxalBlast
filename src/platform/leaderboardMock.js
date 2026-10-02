// PLACEHOLDER DATA — the sample global board.
//
// docs/Technical/LEADERBOARD_GLOBAL_BOARD_HANDOFF.md. The leaderboard panel's global tab
// (docs/Planning/08-荣誉与排行榜系统.md §7.5) has to exist in its final SHAPE before the platform
// integration lands, so this file stands in for the standings: twenty made-up players and their
// scores, rendered by exactly the code the real feed will render through.
//
// WHAT IS FAKE HERE, AND WHAT IS NOT:
//   * fake — every name and every score below. They are hand-tuned to be PLAUSIBLE for the
//     current (version-2) scoring rules rather than measured: v2 pays 10 per placed cell plus
//     100 per line plus the three bonus categories, so a long skilled run lands in the tens of
//     thousands and a weekly board decays steeply from there. Nothing here is a claim about a
//     real player, and no measurement in docs/Technical/DIFFICULTY_*.md reads this file.
//   * real — the SEASON is not in here at all. It is computed by weekKey() in game/records.js,
//     the same ISO week on the same Monday-09:00-UTC boundary the platform's weekly seasons use.
//     A sample board that invented its own season would hide a real bug behind a fake one.
//
// HOW THIS GOES AWAY: the panel reads `createLeaderboardFeed(...)`, never this array. When the
// platform can hand the client real entries, the feed returns them (its `global()` prefers the
// platform, and falls back here only when that call is missing or fails), the tab drops its
// 「sample data」 chip because the feed says the source is real, and this file is deleted. Until
// then every surface that shows it says, in the player's language, that the numbers are samples
// (leaderboard.sample / leaderboard.sampleNote) — a board that looks real and is not is worse
// than no board at all.
export const SAMPLE_BOARD = Object.freeze([
  Object.freeze({ name: 'CubeKing', score: 76480 }),
  Object.freeze({ name: 'Tetsuya', score: 71905 }),
  Object.freeze({ name: 'Mira', score: 68340 }),
  Object.freeze({ name: 'BlokBoss', score: 61220 }),
  Object.freeze({ name: 'Nia', score: 57860 }),
  Object.freeze({ name: 'Quadzilla', score: 52470 }),
  Object.freeze({ name: 'PixelPang', score: 48115 }),
  Object.freeze({ name: 'SoraLee', score: 44930 }),
  Object.freeze({ name: 'Kobo', score: 41260 }),
  Object.freeze({ name: 'Renz', score: 37845 }),
  Object.freeze({ name: 'Amara', score: 34510 }),
  Object.freeze({ name: 'HexaHu', score: 31080 }),
  Object.freeze({ name: 'Doyo', score: 27640 }),
  Object.freeze({ name: 'ViviQ', score: 24395 }),
  Object.freeze({ name: 'Tonkatsu', score: 21730 }),
  Object.freeze({ name: 'LinusB', score: 19460 }),
  Object.freeze({ name: 'Maki', score: 16880 }),
  Object.freeze({ name: 'Zeno', score: 14250 }),
  Object.freeze({ name: 'Bijou', score: 11930 }),
  Object.freeze({ name: 'Kaede', score: 9640 }),
])

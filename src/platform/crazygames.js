// CrazyGames platform layer (08-荣誉与排行榜系统.md §7.2/§7.4).
//
// Layer 2 is the platform leaderboard, and it is the one layer we cannot develop
// against yet: leaderboards are only opened to INVITED games, the signed score
// needs a 32-byte base64 key from the platform dashboard, and the client is given
// no read API at all (the platform draws the ranking itself — §7.1). So this
// module is written as the DEGRADED PATH first: everything is optional, every
// failure is silent, and the local record layer never depends on it.
//
// Turn it on with two build-time values (both absent = entry stays greyed):
//   VITE_CRAZYGAMES_LEADERBOARD=on
//   VITE_CRAZYGAMES_SCORE_KEY=<32-byte base64 key from the dashboard>
const ENV = import.meta.env || {}
const LEADERBOARD_ENABLED = ENV.VITE_CRAZYGAMES_LEADERBOARD === 'on'
const SCORE_KEY = ENV.VITE_CRAZYGAMES_SCORE_KEY || ''
// v0.10.3 (docs/Technical/SCORE_REWARD_SIMPLIFICATION_HANDOFF.md §5.5): the score rules
// changed, so the platform board has to be ROUTED to the new rules before a version-2 score
// may be submitted to it. Sending the new score to the old board would mix two scales in one
// ranking, and the client cannot fix that by attaching a version field — the ranking is drawn
// by the platform, not by us. So the route is a build-time decision, exactly like the
// invitation itself: absent = version 2 has no board yet, and the game says so instead of
// submitting.
const BOARD_RULES_VERSION = Number(ENV.VITE_CRAZYGAMES_SCORE_RULES) === 2 ? 2 : 1

// AES-GCM, per the platform's client submission flow: submitScore takes the plain
// score for display AND an encrypted copy the server can trust. The exact wire
// format is unverified until we are invited; only the degraded path ships now, so
// nothing here is on a live code path.
async function encryptScore(score, keyBase64) {
  const cryptoApi = globalThis.crypto?.subtle
  if (!cryptoApi || !keyBase64) return null
  const bytes = Uint8Array.from(globalThis.atob(keyBase64), (char) => char.charCodeAt(0))
  const key = await cryptoApi.importKey('raw', bytes, 'AES-GCM', false, ['encrypt'])
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12))
  const payload = new TextEncoder().encode(String(score))
  const cipher = await cryptoApi.encrypt({ name: 'AES-GCM', iv }, key, payload)
  return globalThis.btoa(String.fromCharCode(...new Uint8Array(cipher)))
}

export function createCrazyGamesAdapter() {
  const sdk = globalThis.CrazyGames?.SDK
  let submittedRun = null // one submission per run, however often a run ends

  return {
    available: Boolean(sdk),
    initialize: async () => {
      if (sdk?.init) await sdk.init()
    },
    gameplayStart: () => sdk?.game?.gameplayStart?.(),
    gameplayStop: () => sdk?.game?.gameplayStop?.(),
    pause: () => sdk?.game?.pause?.(),
    resume: () => sdk?.game?.resume?.(),
    // Invited AND wired AND the SDK actually offers the call — otherwise the UI
    // greys the entry and says "即将开放" instead of firing a request that 4xxes.
    leaderboardAvailable: () => Boolean(LEADERBOARD_ENABLED && sdk?.user?.submitScore),
    // §5.5: the board a given rules version would submit to, or null when the platform has
    // no board for it. The leaderboard panel reads this to explain WHY the entry is greyed —
    // "coming soon" and "no board for these rules yet" are different sentences, and a player
    // who just scored under the new rules is owed the second one.
    boardRulesVersion: () => BOARD_RULES_VERSION,
    leaderboardAvailableFor: (rulesVersion = BOARD_RULES_VERSION) => (
      Boolean(LEADERBOARD_ENABLED && sdk?.user?.submitScore) && Number(rulesVersion) === BOARD_RULES_VERSION
    ),
    // Submit one finished run. Never throws, never blocks the Game Over panel, and
    // never reports failure to the player (§7.4: 失败即静默降级).
    async submitScore(score, runToken = null, { rulesVersion = BOARD_RULES_VERSION } = {}) {
      if (!this.leaderboardAvailable()) return { submitted: false, reason: 'unavailable' }
      // §5.5 不得以客户端多传一个版本字段就宣称完成分榜: without a route for these rules the
      // submission is withheld outright rather than pointed at a board that ranks a different
      // measurement.
      if (Number(rulesVersion) !== BOARD_RULES_VERSION) {
        return { submitted: false, reason: 'rules-version-unrouted', rulesVersion: Number(rulesVersion) }
      }
      if (runToken !== null && runToken === submittedRun) return { submitted: false, reason: 'duplicate' }
      submittedRun = runToken
      try {
        const encryptedScore = await encryptScore(score, SCORE_KEY)
        await sdk.user.submitScore({ score, ...(encryptedScore ? { encryptedScore } : {}) })
        return { submitted: true }
      } catch {
        return { submitted: false, reason: 'error' }
      }
    },
    // The ranking UI belongs to the platform (no read API on the client, §7.1). A
    // greying entry is the normal state until we are invited, so this call only
    // exists for the invited build.
    openLeaderboard: () => {
      if (typeof sdk?.user?.showLeaderboard === 'function') sdk.user.showLeaderboard()
    },
  }
}

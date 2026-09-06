export function createCrazyGamesAdapter() {
  const sdk = globalThis.CrazyGames?.SDK
  return {
    available: Boolean(sdk),
    initialize: async () => {
      if (sdk?.init) await sdk.init()
    },
    gameplayStart: () => sdk?.game?.gameplayStart?.(),
    gameplayStop: () => sdk?.game?.gameplayStop?.(),
    pause: () => sdk?.game?.pause?.(),
    resume: () => sdk?.game?.resume?.(),
  }
}

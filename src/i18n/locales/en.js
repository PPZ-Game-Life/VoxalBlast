// English (default locale). See docs/Technical/LOCALIZATION.md for the project standard.
//
// Every value is either a plain string (with {placeholders}) or a function of the params
// object. Pluralisation lives INSIDE the string, per language, because "1 block / 2 blocks"
// is an English rule and must not be a rule the caller knows about — zh-Hans is free to
// ignore {n === 1} entirely.
//
// The key set of this file and locales/zh-Hans.js must stay IDENTICAL; tools/i18n-tests.mjs
// fails the build when they drift.
export default Object.freeze({
  // ---- HUD chrome -----------------------------------------------------------
  'hud.score': 'SCORE',
  'hud.best': 'BEST',

  // ---- Accessibility labels on static markup --------------------------------
  'a11y.score': 'Score',
  'a11y.bestScore': 'Best score',
  'a11y.sound': 'Sound',
  'a11y.version': 'Game version',
  'a11y.controls': 'Controls',
  'a11y.openControls': 'Open controls',
  'a11y.closeControls': 'Close controls',
  'a11y.settings': 'Settings',
  'a11y.openSettings': 'Open settings',
  'a11y.closeSettings': 'Close settings',
  'a11y.closeLeaderboard': 'Close leaderboard',
  'a11y.items': 'Items',
  'a11y.refreshConfirm': 'Refresh confirmation',
  'a11y.rocketAxis': 'Rocket direction',
  'a11y.cancelItem': 'Cancel the current item',
  'a11y.pieceSlot': ({ name, blocks }) => `${name}, ${blocks} block${blocks === 1 ? '' : 's'}`,

  // ---- Status line ----------------------------------------------------------
  'status.idle': 'Pick a shape',
  'status.paused': 'Paused',
  'status.home': 'Home',
  'status.turning': 'Turning to next face',
  'status.holdToTurn': 'Hold to turn',
  'status.dragToFace': 'Drag to a face',
  'status.releaseToPlace': 'Release to place',
  'status.carryOffToTurn': 'Carry the block off the cube to turn',
  'status.noRoomOnFace': 'No room on this face',
  'status.releaseToCancel': 'Release to cancel',
  'status.nothingToClear': 'Nothing to clear there',
  'status.noSpotRefresh': 'No spot - use Refresh',
  'status.noSpotClear': 'No spot - clear a path',
  'status.clearKeepBuilding': 'Clear! Keep building',

  // ---- The card that rides beside a carried piece (03 §3.1) -----------------
  'edgeturn.turning': 'Turning…',
  'edgeturn.hold': 'Hold to turn',

  // ---- Toasts ---------------------------------------------------------------
  'toast.placementCancelled': 'Placement cancelled',  'toast.tryAnotherSpot': 'Try another spot',
  'toast.nothingToClear': 'Nothing to clear there',
  'toast.noRoomClearPath': 'No room - clear a path',
  'toast.refreshed': 'Refreshed',
  'toast.noSpotTryRefresh': 'No spot - try Refresh',
  'toast.nothingToRestore': 'Nothing to restore',
  'toast.offline': 'Offline mode',
  // §5.2: the one-off notice a resumed legacy run gets. It says what is true — the run keeps the
  // scoring it started on — and nothing about what the player should do about it.
  'toast.legacyRules': 'This run keeps the scoring it started on',

  // ---- Reward note (SCORE_REWARD_SIMPLIFICATION_HANDOFF §3.2) ---------------
  // ONE title per settled hand, chosen by the headline category, plus one merged detail line
  // that names every category that paid. The three titles are the doc's own copy:
  // 「一次消除 {L} 线」/ `{L}-LINE CLEAR`, 「连续消除 {C} 次」/ `STREAK {C}`,
  // 「清空 {W} 面」/ `{W} FACE(S) CLEARED`. `{n}` is the category's own count (lines, streak,
  // faces) — never the score, which the total pop carries.
  'reward.MULTI_CLEAR.title': ({ n }) => `${n}-LINE CLEAR`,
  'reward.MULTI_CLEAR.detail': ({ n }) => `${n} line${n === 1 ? '' : 's'}`,
  'reward.MULTI_CLEAR.name': 'Multi-clear',
  'reward.CLEAR_STREAK.title': ({ n }) => `STREAK ${n}`,
  'reward.CLEAR_STREAK.detail': ({ n }) => `streak ${n}`,
  'reward.CLEAR_STREAK.name': 'Streak',
  'reward.FACE_CLEAR.title': ({ n }) => `${n} FACE${n === 1 ? '' : 'S'} CLEARED`,
  'reward.FACE_CLEAR.detail': ({ n }) => `${n} face${n === 1 ? '' : 's'}`,
  'reward.FACE_CLEAR.name': 'Face clear',

  // ---- Items (07-道具系统设计.md §8.10) -------------------------------------
  'item.name.refresh': 'Refresh',
  'item.name.hammer': 'Hammer',
  'item.name.rocket': 'Rocket',
  'item.name.bomb': 'Bomb',
  'item.title.refresh': 'Discard the whole batch and deal three new pieces',
  'item.title.hammer': 'Knock out one block on the front face',
  'item.title.rocket': 'Clear a whole row or column on the front face',
  'item.title.bomb': 'Blast a 2 x 2 area on the front face',
  'item.dragHint': 'Drag to the board. Release to use.',
  'item.dragHintRocket': 'Drag to the board. Release to use · pick a direction first',
  'item.tapHint': 'Pick a target, then tap Use',
  'item.offFace': 'Move onto the front grid',
  'item.noTarget': 'Nothing to clear here',
  'item.clearN': ({ n }) => `Clear ${n} block${n === 1 ? '' : 's'}`,
  'item.clearRelease': ({ n }) => `Clear ${n} block${n === 1 ? '' : 's'} · Release to use`,
  'item.shared': 'Edge-shared cells clear too',
  'item.clipped': ({ area, n }) => `Clipped at edge · Area: ${area} cells / Clear ${n} blocks`,
  'item.refreshConfirm': 'Replace the whole batch? Costs 1. The new batch may not fit.',
  'item.refreshKeep': 'Keep current',
  'item.refreshGo': 'Refresh · −1',
  'item.use': ({ n }) => `Use · −${n}`,
  // The status bar's button ships this as its markup default, before any tool is armed.
  'item.useOnce': 'Use · −1',
  'item.axis.row': '↔ Row',
  'item.axis.col': '↕ Column',
  'item.cancel': '✕ Cancel',
  'item.dragCancelTitle': 'Drag here to cancel',
  'item.dragCancelNote': 'Release to cancel',
  'item.pieceCancelTitle': 'Cancel',
  'item.pieceCancelNote': 'placement',
  'item.empty': 'None left',
  'item.lockedRotate': 'Cancel to turn the cube',
  'item.stale': 'Not used — aim again',
  'item.clearedN': ({ n }) => `Cleared ${n}`,
  'item.undo': 'Undo',
  'item.restoredN': ({ n }) => `Restored ${n}`,

  // ---- Honors (08 §5) -------------------------------------------------------
  'honor.TRIPLE.label': 'Triple clear',
  'honor.TRIPLE.title': 'TRIPLE',
  'honor.TRIFACE.label': 'Three faces at once',
  'honor.TRIFACE.title': 'TRIFACE',
  'honor.QUAD.label': 'Quad clear',
  'honor.QUAD.title': 'QUAD',
  'honor.PENTA.label': 'Penta clear',
  'honor.PENTA.title': 'PENTA',
  'honor.HEXA.label': 'Hexa clear',
  'honor.HEXA.title': 'HEXA',
  'honor.PERFECT_TWELVE.label': 'Perfect twelve',
  'honor.PERFECT_TWELVE.title': 'PERFECT TWELVE',

  // ---- Personal bests (08 §7.3) ---------------------------------------------
  'record.maxChain': 'Longest chain',
  'record.maxLinesOneMove': 'Most lines in one move',
  'record.maxFacesOneMove': 'Most faces in one move',
  'record.facesLitBest': 'Faces lit',
  'record.faceWipes': 'Faces wiped',
  'record.pureCubes': 'Pure cubes',

  // ---- Tiers (08 §4.6) ------------------------------------------------------
  'tier.1.name': 'Novice',
  'tier.1.title': 'NOVICE',
  'tier.2.name': 'Shaper',
  'tier.2.title': 'SHAPER',
  'tier.3.name': 'Facer',
  'tier.3.title': 'FACER',
  'tier.4.name': 'Cuber',
  'tier.4.title': 'CUBER',
  'tier.5.name': 'Master',
  'tier.5.title': 'MASTER',
  'tier.6.name': 'Legend',
  'tier.6.title': 'LEGEND',

  // ---- Home cover -----------------------------------------------------------
  'home.tagline': 'Stack · Align · Blast all six faces',
  'home.best': 'Best',
  'home.play': 'New game',
  'home.resume': 'Continue',
  // v0.9.24: the cover's second run action, shown only while the primary reads Continue —
  // starting over has to be possible without spending the waiting run through the settings panel.
  'home.newGame': 'New game',
  'home.resumeNote': ({ score, cells }) => `Game in progress: ${score} points · ${cells} blocks`,
  'home.leaderboard': 'Leaderboard',
  'home.settings': 'Settings',

  // ---- Settings panel -------------------------------------------------------
  'settings.title': 'Settings',
  'settings.language': 'Language',
  'settings.languageNote': 'Takes effect immediately',
  'settings.sound': 'Sound',
  'settings.soundNote': 'Placement and clear SFX',
  'settings.haptics': 'Haptics',
  'settings.hapticsNote': 'Vibration feedback',
  'settings.hapticsUnsupported': 'Not available on this device',
  'settings.dragTurn': 'Drag to turn',
  'settings.dragTurnNote': 'Carrying a piece off the cube turns it',
  'settings.controls': 'Controls',
  'settings.controlsNote': 'Keyboard and rotation',
  'settings.home': 'Home',
  'settings.restart': 'Restart',

  // ---- Controls card --------------------------------------------------------
  'controls.eyebrow': 'PC KEYBOARD',
  'controls.title': 'Controls',
  'controls.pitch': 'Turn up / down',
  'controls.pitchNote': 'Around the X axis (screen horizontal)',
  'controls.yaw': 'Turn left / right',
  'controls.yawNote': 'Around the Y axis (screen vertical)',
  'controls.roll': 'Spin in plane',
  'controls.rollNote': 'Around the Z axis (screen normal)',
  'controls.note': 'Each key turns the cube once, on the same axis and direction as a mouse drag or a one-finger swipe. Holding a key does not repeat.',

  // ---- Game Over ------------------------------------------------------------
  'gameover.eyebrow': 'RUN COMPLETE',
  'gameover.title': 'Play again?',
  'gameover.runScore': 'This run',
  'gameover.playAgain': 'Play again',
  'gameover.leaderboard': 'Leaderboard',
  'gameover.newBest': '★ NEW BEST!',
  'gameover.gap': ({ n }) => `${n} short of the record`,
  'gameover.noHonors': 'No honors this run',
  // v0.10.3 (§5.3): a version-2 run lists the three bonus categories it earned, not the six
  // honours it can no longer win. The label is the empty state for that list.
  'gameover.noRewards': 'No bonus clears this run',
  'gameover.facesLabel': 'SIX-FACE SWEEP',
  'gameover.dim.bigMove': ({ n }) => `Best move: ${n} lines at once`,
  'gameover.dim.triface': ({ n }) => `${n} triple-face clears`,
  'gameover.dim.faceClear': ({ n }) => `${n} faces emptied`,
  'gameover.dim.chain': ({ n }) => `Longest chain ${n}`,
  'gameover.dim.faces': ({ n }) => `${n}/6 faces lit`,
  'gameover.stat.chain': 'Longest chain',
  'gameover.stat.lines': 'Most in one move',
  'gameover.stat.triface': 'Triple-face moves',
  // The version-2 replacement for the triple-face count: under the new rules the number that
  // says "you released space" is how many faces were emptied, and TRIFACE no longer exists.
  'gameover.stat.faceClear': 'Faces emptied',
  'gameover.stat.weekly': 'Best this week',

  // ---- Leaderboard ----------------------------------------------------------
  'leaderboard.eyebrow': 'LOCAL RECORDS',
  'leaderboard.title': 'Leaderboard',
  'leaderboard.recent': ({ n }) => `Last ${n} games`,
  'leaderboard.personalBest': 'Personal best',
  'leaderboard.best': 'Best score',
  'leaderboard.weekly': 'Best this week',
  // §5.3: BEST and the weekly best are compared inside ONE scoring rule set. The legacy pool is
  // shown read-only, labelled, and never overwritten by a run on the new rules.
  'leaderboard.bestLegacy': 'Best score · old rules',
  'leaderboard.weeklyLegacy': 'Best this week · old rules',
  'leaderboard.recentLegacy': ({ n }) => `Last ${n} games · old rules`,
  // How many of the stored games belong to the other rule set. They are not drawn as bars
  // (§5.3 不把不同分制混榜) but they are not hidden either.
  'leaderboard.recentOtherRules': ({ n }) => `${n} more game${n === 1 ? '' : 's'} stored under the other scoring rules`,
  'leaderboard.gamesPlayed': 'Games played',
  'leaderboard.honors': 'Honor collection',
  'leaderboard.honorsLegacy': 'Honor collection · old rules',
  'leaderboard.rewards': 'Bonus clears',
  'leaderboard.empty': 'No games recorded yet',
  'leaderboard.tierUncalibrated': 'Tiers not calibrated yet',
  'leaderboard.tierUncalibratedNote': 'Cut scores follow real player quantiles once the difficulty is final.',
  'leaderboard.tierNote': 'Tier cuts come from real player quantiles and will be set in one pass once the difficulty is final; no numbers are published yet.',
  'leaderboard.globalBy': 'Global leaderboard by CrazyGames',
  'leaderboard.openGlobal': 'Open global leaderboard',
  'leaderboard.comingSoon': 'Coming soon',
  // §5.5: the board is routed per scoring rule set. Until a route exists for the current rules
  // the entry says so — 「not yet」 is a different statement from 「coming soon」, and a player who
  // just scored under the new rules is owed the true one.
  'leaderboard.rulesUnrouted': 'No global board for the current scoring rules yet',
})

// Static DOM handles, collected in one place.
//
// Refactor P1 (temp/VoxalBlast-渐进式模块拆分重构执行计划.md §6): main.js used to open with
// ~45 bare `document.querySelector('#…')` lines. They are not logic and they are not any
// one panel's business — every module downstream needs a few of them — so they are
// collected here and handed out as one object.
//
// Two rules this file deliberately keeps from the code it replaces:
//
//  1. **Only STATIC nodes are cached.** A node the game creates later (the candidate slots
//     rebuilt by `renderPieceSlots()`, the leaderboard body rewritten by
//     `renderLeaderboard()`, the platform button inside it) must be queried by whoever just
//     rendered it. Caching one here would hand out a detached element for the rest of the
//     session.
//  2. **A missing REQUIRED node fails loudly and by name.** The old bare queries returned
//     `null` and the failure surfaced much later as "cannot read properties of null" from
//     somewhere unrelated. An index.html that lost `#status` is a broken build, and saying
//     which selector is missing is the whole value of centralising this.
//
// `collectDom(root = document)` takes the root so a test or a future embed can collect from
// a subtree without touching the global document.
export function collectDom(root = document) {
  const need = (selector) => {
    const element = root.querySelector(selector)
    if (!element) {
      throw new Error(`collectDom: required element ${selector} is missing — index.html and ui/dom.js have drifted apart`)
    }
    return element
  }

  return {
    // Board canvas host and the top bar.
    sceneWrap: need('#scene-wrap'),
    app: need('#app'),
    versionEl: need('#app-version'),

    // HUD: score, best, chain, status line and the transient toast.
    scoreEl: need('#score'),
    bestEl: need('#best'),
    chainEl: need('#chain'),
    chainValueEl: need('#chain-value'),
    chainBarEl: need('#chain-bar'),
    statusEl: need('#status'),
    toastEl: need('#toast'),
    honorLayerEl: need('#honor-layer'),

    // Candidate strip, item bar and their shared cancel target.
    slotsEl: need('#piece-slots'),
    piecesPanelEl: need('.bottom-panel'),
    cancelZoneEl: need('#cancel-zone'),
    itemBarEl: need('#item-bar'),
    axisPickEl: need('#axis-pick'),
    axisCancelEl: need('#axis-cancel'),

    // Settings panel, controls card and their entries.
    settingsEl: need('#settings-modal'),
    settingsButtonEl: need('#settings-button'),
    soundSettingEl: need('#sound-setting'),
    hapticsSettingEl: need('#haptics-setting'),
    controlsEl: need('#controls-modal'),
    controlsButtonEl: need('#controls-button'),
    controlsSettingEl: need('#controls-setting'),
    controlsCloseEl: need('#controls-close'),

    // Rotation-key legend: the badge and the three axis rows.
    axisHintEl: need('#axis-hint'),
    axisHintKeyEl: need('#axis-hint-key'),
    axisHintAxisEl: need('#axis-hint-axis'),
    // axis -> the legend row carrying that axis's mini cube and keycaps.
    controlRows: new Map(
      [...root.querySelectorAll('.ctrl-row')].map((row) => [row.dataset.axis, row]),
    ),

    // Game Over card.
    gameOverEl: need('#game-over'),
    finalScoreEl: need('#final-score'),
    gameOverBestEl: need('#game-over-best'),
    gameOverFacesEl: need('#game-over-faces'),
    gameOverHonorsEl: need('#game-over-honors'),
    gameOverStatsEl: need('#game-over-stats'),

    // Leaderboard panel.
    leaderboardButtonEl: need('#leaderboard-button'),
    leaderboardEl: need('#leaderboard'),
    leaderboardBodyEl: need('#leaderboard-body'),
    leaderboardCloseEl: need('#leaderboard-close'),
    leaderboardPlatformEl: need('#leaderboard-platform'),

    // Home cover.
    homeEl: need('#home'),
    homeHeroEl: need('#home-hero'),
    homePrimaryEl: need('#home-primary'),
    homePrimaryLabelEl: need('#home-primary-label'),
    homeBestEl: need('#home-best'),
    homeResumeNoteEl: need('#home-resume-note'),
    homeLeaderboardEl: need('#home-leaderboard'),
    homeSettingsEl: need('#home-settings'),
    homeSettingEl: need('#home-setting'),
    // The in-game layers the cover hides and makes inert. A LIST, not a required single
    // node: the selector legitimately matches two elements, and an empty result would be a
    // markup change worth reporting rather than a crash.
    gameLayers: [...root.querySelectorAll('.topbar, .game-layout')],

    // Settings panel's own close button and the restart row (used by ui/settings.js).
    settingsCloseEl: need('#settings-close'),
    restartSettingEl: need('#restart-setting'),
  }
}

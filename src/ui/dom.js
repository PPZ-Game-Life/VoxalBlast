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
    // v0.13.2: the background itself — the layer that owns every pixel the game does not.
    // It is a SECOND surface for the view gesture (gameInput's `background`): `.board-section`
    // is transparent to pointers, so the band under the cube arrives here instead of dying.
    scrollShield: need('.scroll-shield'),
    app: need('#app'),
    versionEl: need('#app-version'),
    // v0.11.2: the boot curtain. It is NOT inside #app (it must cover the cover as well), so it
    // is its own handle rather than part of any layer list.
    bootEl: need('#boot-screen'),

    // HUD: score, best, status line and the transient toast. The CHAIN pill's three handles
    // were removed with the component in v0.10.3 (SCORE_REWARD_SIMPLIFICATION_HANDOFF §3.1).
    scoreEl: need('#score'),
    bestEl: need('#best'),
    statusEl: need('#status'),
    toastEl: need('#toast'),
    honorLayerEl: need('#honor-layer'),

    // Candidate strip, item bar and the two cancel targets (07 §8.3: the tray and the item
    // strip are two INDEPENDENT rectangles, so each has its own overlay and its own copy).
    slotsEl: need('#piece-slots'),
    piecesPanelEl: need('.bottom-panel'),
    cancelZoneEl: need('#cancel-zone'),
    cancelZoneTitleEl: need('#cancel-zone-title'),
    cancelZoneNoteEl: need('#cancel-zone-note'),
    itemBarEl: need('#item-bar'),
    itemCancelZoneEl: need('#item-cancel-zone'),
    axisPickEl: need('#axis-pick'),
    // The item status bar and its controls (07 §8.3), plus the undo window's bar (§8.9).
    itemStatusEl: need('#item-status'),
    itemStatusIconEl: need('#item-status-icon'),
    itemStatusNameEl: need('#item-status-name'),
    itemStatusHintEl: need('#item-status-hint'),
    itemUseEl: need('#item-use'),
    itemCancelEl: need('#item-cancel'),
    undoBarEl: need('#undo-bar'),
    undoBarTextEl: need('#undo-bar-text'),
    undoButtonEl: need('#undo-button'),
    refreshConfirmEl: need('#refresh-confirm'),
    refreshConfirmCopyEl: need('#refresh-confirm-copy'),
    refreshKeepEl: need('#refresh-keep'),
    refreshGoEl: need('#refresh-go'),

    // Settings panel, controls card and their entries.
    settingsEl: need('#settings-modal'),
    settingsButtonEl: need('#settings-button'),
    // i18n: the language row and the hint that spells the current language in its own script.
    languageSettingEl: need('#language-setting'),
    languageSettingValueEl: need('#language-setting-value'),
    soundSettingEl: need('#sound-setting'),
    hapticsSettingEl: need('#haptics-setting'),
    // v0.9.19: the row's own note. It changes when the device has no vibrator at all, so
    // settings.js repaints it from the same capability read that greys the row.
    hapticsNoteEl: need('#haptics-note'),
    dragTurnSettingEl: need('#drag-turn-setting'),
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

    // Leaderboard panel. v0.12.0: two tabs and two panes — `leaderboardBodyEl` is the local
    // record wall (its id is unchanged so the existing checks keep reading the same node) and
    // `leaderboardGlobalEl` is the seasonal board.
    leaderboardButtonEl: need('#leaderboard-button'),
    leaderboardEl: need('#leaderboard'),
    leaderboardBodyEl: need('#leaderboard-body'),
    leaderboardGlobalEl: need('#leaderboard-global'),
    leaderboardTabsEl: need('#leaderboard-tabs'),
    lbTabGlobalEl: need('#lb-tab-global'),
    lbTabLocalEl: need('#lb-tab-local'),
    leaderboardCloseEl: need('#leaderboard-close'),
    leaderboardPlatformEl: need('#leaderboard-platform'),

    // Home cover.
    homeEl: need('#home'),
    homePrimaryEl: need('#home-primary'),
    homePrimaryLabelEl: need('#home-primary-label'),
    homeBestEl: need('#home-best'),
    homeResumeNoteEl: need('#home-resume-note'),
    homeNewEl: need('#home-new'),
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

// Diagnostics — the `__voxalblast` / `__voxalblastDev` contract (plan §2.1, §6 P9).
//
// This module ASSEMBLES. Every number it returns comes from the module that owns the state:
// boardView's pose, framing and tile counts, gameScene's post chain and camera framing,
// pieceView's previews and ghost, effects' systems, the stores' snapshots, the UI modules'
// own open flags. It copies no projection and no algorithm, keeps no state of its own, and
// no gameplay path calls it (plan §2.1: diagnostics 只装配，不复制投影或计分算法).
//
// Two globals, and the split is the contract (计划 §6 P9 第 2 条):
//   __voxalblast     — read-only, mounted in EVERY build; the headless checks read it.
//   __voxalblastDev  — write handles, mounted only under import.meta.env.DEV, which vite
//                      replaces with `false` in the production bundle. The callbacks behind
//                      them are built by main and handed in, so this module never becomes the
//                      entry point for a gameplay action — it only mounts them under the
//                      names the probes already use.
//
// Names, shapes and field order are the ones the probes and the checklists have asserted
// since v0.2.x: this file is a change of owner, not of contract.
import * as THREE from 'three'
import { FACES } from './game/board.js'
import { SHAPES } from './game/shapes.js'
import { DEFAULT_LOCALE, getLocale, LOCALES } from './i18n/index.js'
import { hapticsSupported } from './platform/haptics.js'
import { KEY_BINDINGS } from './rendering/keyboard.js'
import { blockSurfaceArtStatus } from './rendering/woodTexture.js'
import { referencePaintColor } from './rendering/referencePalette.js'

export function createDiagnostics({
  version,
  scene3d,
  floatingWorld,
  boardView,
  blocks,
  pieceView,
  effects,
  audio,
  input,
  session,
  recordStore,
  sessionStore,
  homeUi,
  bootUi,
  settingsUi,
  dev,
}) {
  // The board's box, and the ONLY box this module measures against.
  //
  // v0.13.0 R3 (handoff §9.3) made the main canvas the whole viewport, so "the rect the
  // renderer draws into" stopped being "the rect the board lives in". Everything here — the
  // face-centre the drag probes aim at, the per-cell screen step the ghost is placed with,
  // `facesReport`'s box — is board geometry measured through the CANONICAL camera, and the
  // canonical camera is solved against the gameplay rect. Reading the canvas element instead
  // silently moved the reported board centre by tens of pixels while the picture stayed
  // perfect, which is exactly how a probe goes red with no visual symptom at all.
  //
  // Nothing is cached: a cached rect would freeze the numbers to the window size they were
  // first measured at.
  const boardRect = () => scene3d.getGameplayRect()

  const readOnly = Object.freeze({
    version,
    // `meshes`/`uniqueCells` are boardView's 98 tiles; the post-chain facts are gameScene's
    // (both were inline in main.js before refactor P9). `surfaceArt` stays a direct read of
    // the art loader's status, because that is what it is: a module-level load state.
    rendering: () => {
      const tiles = boardView.tileStats()
      const scene = scene3d.report()
      return {
        meshes: tiles.meshes,
        uniqueCells: tiles.uniqueCells,
        trianglesPerBlock: blocks.report().trianglesPerBlock,
        materials: blocks.report(),
        surfaceArt: blockSurfaceArtStatus(),
        environment: scene.environment,
        hdr: scene.hdr,
        contactShadows: scene.contactShadows,
        // v0.13.0 R3: the canvas/gameplay split and the error between the two projections.
        // The ≤1 CSS px equality it reports is the gate this stage is graded on, and it cannot
        // be read off a screenshot — a board drawn a few pixels off its own hit box still looks
        // like a board.
        projection: scene.projection,
        // v0.13.0 R4 (§9.3): what the background ACTUALLY is now. The old skin's only tell was
        // "the valley webp finished loading", which stays true whether or not any of it is on
        // screen — these say a sky, a plaza, N lit clusters and N cloud textures are up.
        world: floatingWorld.report(),
        toneMapping: scene.toneMapping,
        programs: scene.programs,
        lowPower: scene.lowPower,
        // G0/G1 (MATERIAL_GROUNDING_REWORK_HANDOFF §4/§5): the per-frame counters a support or
        // material round has to report, and which support the page is actually drawing (painted
        // pedestal, its two quads, the 3D prototype, and whether the two scene passes are on).
        // Still a pure assembly of gameScene's own report.
        rendererInfo: scene.rendererInfo,
        grounding: scene.grounding,
      }
    },
    // `pose` is the rendered orientation; `base` is the logical grid pose it settles around
    // (a product of whole 90° steps about world axes, so it can never drift off the grid);
    // `bearing` is how far the player has dialled the view off the face, in screen space, and
    // `bearingDeg` the same in degrees. The Euler triples are readability helpers for the
    // checks (a pure yaw/pitch/roll pose decomposes exactly in ZYX order). BoardView's.
    rotation: () => boardView.rotationReport(),
    // v0.8.6 framing read-out: how the cube's screen silhouette is divided between the faces
    // that are actually visible, plus how far each of them is off the camera axis and how far
    // the main face's own lattice axes are from screen right/down. Areas are exact projected
    // polygons, not a cosα·cosβ approximation. BoardView measures it; the rect is the
    // renderer's, which boardView deliberately does not own.
    faces: () => boardView.facesReport(boardRect()),
    // v0.8.6 rotation read-out: the world-space increment between two rendered poses,
    // expressed in the camera's own frame. `screenDeg` is where the rotation axis points on
    // screen, measured from screen-right and folded to (-90°, 90°]: 0° means the axis lies
    // horizontally (a pitch — the front face slides up/down), ±90° means the axis is vertical
    // (a yaw — the cube turns left/right). A roll's axis points at the camera, so it has no
    // screen direction at all and shows up as `alongView ≈ ±1` instead. Read-only; the probe
    // calls it with two quaternions it just read from rotation().
    poseAxisScreen: (from, to) => boardView.poseAxisScreen(from, to),
    // Screen-space cube box + framing numbers, used to check the "inside vs outside the cube"
    // gesture split and how much of the canvas the cube fills.
    bounds: () => scene3d.cubeScreenBounds(),
    // The landing marker, next to the piece in hand. `cells[].color` is the material the
    // marker is actually wearing, so a check can assert it matches `pieceColor` while the
    // drop is legal and only turns into `palette.invalid` when it is not (v0.8.11 fixed this:
    // the marker used to be a fixed green whatever the candidate's colour was).
    // Read-only; no gameplay path reads it.
    preview: () => {
      const piece = input.getSelectedPiece()
      const hex = (color) => `#${new THREE.Color(color).getHexString()}`
      return {
        piece: piece ? piece.shape.name : null,
        pieceColor: piece ? hex(referencePaintColor(piece.shape.color)) : null,
        storedPieceColor: piece ? hex(piece.shape.color) : null,
        valid: input.dragReport().valid,
        cells: pieceView.landingCells(),
      }
    },
    // Candidate orientation on the current front face. `raw` is the top-left layout the slot
    // draws, `oriented` is what would actually be dropped, and `uAxis` / `vAxis` project the
    // lattice step the piece's +u / +v take, in client pixels with dx > 0 = rightward and
    // dy > 0 = upward (NDC convention). A matching placement therefore has +u rightward and
    // +v downward. The face, the cells and the world points are boardView's; the candidate
    // list is the session's.
    placement: () => {
      const face = boardView.findFrontFace()
      const candidatePieces = session.getPieces()
      const piece = candidatePieces.find((candidate) => !candidate.used) || candidatePieces[0]
      const rect = boardRect()
      const faceCenter = boardView.cellWorld(face, 2, 2).project(scene3d.camera)
      const stepScreen = (probeCells) => {
        const [from, to] = boardView.faceOrientedCells(face, probeCells)
        const du = to[0] - from[0]
        const dv = to[1] - from[1]
        const start = boardView.cellWorld(face, 0, 0).project(scene3d.camera)
        const end = boardView.cellWorld(face, du, dv).project(scene3d.camera)
        return {
          step: [du, dv],
          dx: (end.x - start.x) * 0.5 * rect.width,
          dy: (end.y - start.y) * 0.5 * rect.height, // NDC y is already up-positive
        }
      }
      return {
        face,
        center: { x: rect.left + (faceCenter.x + 1) * rect.width / 2, y: rect.top + (1 - faceCenter.y) * rect.height / 2 },
        piece: piece ? piece.shape.name : null,
        raw: piece ? session.currentCells(piece) : [],
        oriented: piece ? boardView.faceOrientedCells(face, session.currentCells(piece)) : [],
        uAxis: stepScreen([[0, 0], [1, 0]]),
        vAxis: stepScreen([[0, 0], [0, 1]]),
      }
    },
    // v0.4.4 drag ghost: where the piece in hand actually is on screen. `cells` are the
    // client-pixel centres of the ghost's voxels (so a check can assert that the ghost tracks
    // the pointer within the lift offset and that a 3-cell piece really drew three voxels),
    // `cellPx` is the on-screen cell edge, and `mode` is the state the drop is in. Read-only;
    // no gameplay path reads it. The fields arrive in two halves (refactor P4b): pieceView
    // measures the view, the gesture record adds the pointer half.
    ghost: () => {
      const d = input.dragReport()
      return {
        // The view half — where the ghost's voxels actually are on screen, the measured cell
        // pitch and the tint it is wearing — is pieceView's projection (refactor P4b).
        ...pieceView.ghostReport(),
        attached: d.attached,
        // How many landing cells the board is drawing right now. The whole point of the
        // v0.4.5 revision is that this and `visible` are never both non-zero.
        previewCells: pieceView.landingCount(),
        // Where the snapped piece is anchored on the face, and the grab point the relative
        // movement is measured from. v0.8.27 split the two halves apart: `previewOrigin` is the
        // quantised target CELL the marker is drawn at, `previewRef` the continuous face
        // coordinate the finger's travel accumulates into, and `previewFace` the face those
        // coordinates live on (latched at the attach — it does not follow the pointer). A check
        // reads them to prove the target moves under an illegal cell rather than sticking.
        previewOrigin: d.origin,
        previewRef: d.ref,
        previewFace: d.face,
        previewPointer: d.pointer,
        onFace: d.onFace,
        anchor: d.anchor,
        // The face's own lattice basis in client pixels — the basis the relative movement is
        // solved in. Exposed so a check can reproduce the mapping exactly instead of
        // assuming it.
        stepScreen: d.stepScreen,
        // v0.9.11 turning while carrying a piece: the trigger is the CARRIED PIECE's centre
        // (`centre`, client px) crossing the CUBE's screen silhouette — not the pointer reaching
        // a viewport edge. `edge` is the silhouette side it crossed, `armed` / `turnPhase` the
        // dwell, `armedAxis` the axis it will turn on. A check reads `centre` together with
        // `bounds()` to prove the arming condition rather than re-deriving it.
        roomless: d.roomless,
        centre: d.centre,
        // v0.9.13: false until this gesture has carried the piece INSIDE the cube once. No edge
        // can arm before that, which is what keeps the tray→cube entry (always through the
        // bottom edge) from turning the cube on the way in.
        entered: d.entered,
        armed: d.armed,
        armedAxis: d.armedAxis,
        edge: d.edge,
        turnPhase: d.turnPhase,
        turned: d.turned,
      }
    },
    // The camera's own framing report (gameScene owns the zoom, the orbit distance, the fit
    // box and the canvas it draws into).
    framing: () => scene3d.framingReport(),
    clearPreview: () => boardView.clearPreviewReport(),
    tileColors: () => boardView.tileColorReport(),
    // Board read-out for the headless checks (v0.2.31): the occupied shell cells as
    // [x, y, z, color] — the color is the shape type, so a check can prove the opening layout
    // draws from the candidate pool — plus the score and any face line that is already full.
    // Read-only, like the rest of this hook.
    board: () => ({
      cells: session.board.occupied().map((cell) => [cell.x, cell.y, cell.z, cell.color]),
      score: session.board.score,
      totalLines: session.board.totalLines,
      // The v0.3 regression assertion reads this: after ANY settled placement it must be
      // empty on all six faces (04「玩法与规则」残留满线条款) — place() settles every face,
      // so nothing can be left standing full.
      fullLines: session.board.findAllFullLines().map((line) => `${line.face}:${line.axis}:${line.axis === 'row' ? line.v : line.u}`),
      faceOccupancy: Object.fromEntries(FACES.map((face) => [face, session.board.faceOccupancy(face)])),
    }),
    // The run in progress: chain, per-run bests, which faces have been cleared and the honours
    // earned — what the Game Over panel and the records layer are fed from.
    //
    // v0.10.3 (SCORE_REWARD_SIMPLIFICATION_HANDOFF §4.1): `scoreRulesVersion` says which formula
    // is pricing this run, and `rewardCounts` is the three-category tally a version-2 settlement
    // card lists. Both are read-only here, like everything else in this hook.
    run: () => ({
      scoreRulesVersion: session.run.scoreRulesVersion,
      chain: session.run.chain,
      bestChain: session.run.bestChain,
      maxLinesOneMove: session.run.maxLinesOneMove,
      maxFacesOneMove: session.run.maxFacesOneMove,
      facesLit: [...session.run.facesLit],
      faceWipes: session.run.faceWipes,
      rewardEventId: session.run.rewardEventId,
      rewardCounts: { ...session.run.rewardCounts },
      honors: [...session.run.honors],
      honorCounts: { ...session.run.honorCounts },
    }),
    // The persisted Layer-1 snapshot (read-only: it is the same object the store hands the UI,
    // so the checks can prove a run round-tripped through storage).
    records: () => recordStore.all(),
    // v0.4 home + resume slot, read-only: what the cover is showing and whether a run is
    // waiting behind it (the checks assert the slot survives a page load, which is the whole
    // point of storing it). The cover's half is homeUi's own report; `persistent` is the save
    // slot's answer and belongs to the store, not the cover.
    home: () => ({ ...homeUi.report(), persistent: sessionStore.persistent }),
    // v0.11.2: the boot curtain's own state machine. A still cannot say whether the thing on
    // screen is a loading screen or a frozen page, so the frame checks read this alongside the
    // picture: `state: 'showing'` is a curtain, `'done'` with `reason: 'ready'` is a curtain that
    // lifted because the scene was complete, and `reason: 'timeout'` is the one that means the
    // boot was too slow to be trusted.
    boot: () => bootUi.report(),    intro: () => boardView.introReport(),
    candidateFrames: () => pieceView.candidateFrames(),
    // v0.9.17 (07 §8): the armed tool's live state — phase, target, scope area/N and whether the
    // release is committable. The v1 interaction lives entirely in pointers, which a screenshot
    // cannot show and a DOM read cannot prove (「单张截图不能证明释放时机正确」), so the probe
    // reads the very report the status bar renders rather than re-deriving it from the DOM.
    item: () => input.itemReport(),
    // v0.8.23 (P5): what the effects layer is holding right now. Particle systems are not
    // board meshes, so no other read-out can prove they were released on a restart; the shake
    // and the slow-motion dip are otherwise invisible too. Read-only; no gameplay path reads it.
    effects: () => effects.report(),
    // v0.10.1 (handoff §9): the audio bus's own read-out. `cuesPlayed` is what the game asked the
    // bus to play and `outputPeak` is what the MASTER actually handed to the device, which is the
    // only pair that can tell "it played" from "it intended to play" — and, with the sound off,
    // "silenced" from "still audible".
    audio: () => audio.report(),
    session: () => sessionStore.read(),
    // v0.4.1: the keyboard bindings the game actually honours. The headless check reads this
    // and compares it against the keycaps printed in the controls card, so a legend can never
    // advertise a key that does nothing (and vice versa).
    keys: () => KEY_BINDINGS.map((binding) => ({ axis: binding.axis, keys: [...binding.keys] })),
    controls: () => settingsUi.report(),
    // v0.9.18 (docs/Technical/LOCALIZATION.md): the language the game is actually speaking.
    // The headless check has to prove two things a screenshot cannot: that the DEFAULT is
    // English, and that the language row moves the whole page (not just the panel it sits in).
    i18n: () => ({
      locale: getLocale(),
      htmlLang: document.documentElement.lang,
      locales: LOCALES.map((entry) => entry.id),
      defaultLocale: DEFAULT_LOCALE,
    }),
    // v0.9.12: the three settings preferences as the game actually reads them, so a check can
    // assert the 拖块翻面 switch gates the turn dwell without reaching into the DOM or storage.
    preferences: () => ({
      sound: settingsUi.getSoundOn(),
      haptics: settingsUi.getHapticsOn(),
      dragTurn: settingsUi.getDragTurnOn(),
      // v0.9.19: whether a buzz could be FELT here. Read from the capability module itself,
      // NOT from the settings row it greys, so a check comparing the two is testing the wiring
      // rather than agreeing with a copy (platform/haptics.js header).
      hapticsSupported: hapticsSupported(),
    }),
    // The candidate pool itself: name, color and cell count per type.
    shapes: () => SHAPES.map((shape) => ({ name: shape.name, color: shape.color, size: shape.cells.length })),
    // v0.9.0 P1: where the run is on the difficulty ladder, and what the LAST batch was made
    // of — the tolerance interval it landed on, the pressure change, whether it needed a
    // fallback, and how many search nodes it cost. This is the only read-out that can prove
    // the board-aware dealer is actually driving the game (a screenshot cannot see a search),
    // and it is what tools/deal-perf.mjs and the experiment harness read in the browser.
    progress: () => session.progress(),
    lastDeal: () => session.getDealMetrics(),
  })

  // DEV-ONLY handles for the headless verification run. The two modal panels cannot be
  // reached by playing: the model says a shell "jam" takes more than 600 placements (09 §3),
  // so a screenshot run would never get there. main builds the callbacks under
  // import.meta.env.DEV and hands them in; this function only mounts them, and vite replaces
  // the flag with `false` in the production build, so the shipped bundle contains neither the
  // block nor the callbacks it would have used — unlike the read-only hook above, they are
  // never used by any gameplay path.
  function install() {
    globalThis.__voxalblast = readOnly
    if (import.meta.env.DEV && dev) {
      globalThis.__voxalblastDev = Object.freeze({
        tuneMaterials: (values) => blocks.tuneMaterials(values),
        tuneGem: (values) => blocks.tuneGem(values),
        tuneShadows: (values) => scene3d.tuneShadows(values),
        // v0.13.0 R5 (handoff §8.7): pin the board's idle float while a capture is taken, so a
        // screenshot is a still of a DETERMINISTIC pose rather than of whatever phase the float
        // happened to be in. Moves no rule and stores nothing.
        setBoardFloat: (values) => dev.setBoardFloat(values),
        // v0.13.0 R4 (KNOWN_GAPS §3 / handoff §C0.4): the SAME pin for the scenery's ambient
        // clock. The board's float and the world's clouds/bob are two independent clocks; pinning
        // one and not the other leaves the picture non-reproducible, which is what the gap
        // recorded. Mounted here because this module whitelists the handles one by one — a
        // `dev.setAmbient` that is never forwarded is a handle that silently does nothing.
        setAmbient: (values) => dev.setAmbient(values),
        // v0.13.0 R4 (handoff §6.3-A): the two switches the block-material round turns ONE AT A
        // TIME to tell 「灰」 from 「厚黑缝」 — "the seams render darker than the hull colour the
        // recipe specifies" is a measurement, and the experiment that explains it is dropping the
        // occlusion term. `main.js` has owned both callbacks all along; they were simply never
        // forwarded here, and this module whitelists handles one by one, so the page had no way to
        // run that A/B at all.
        //
        // They live under `dev.grounding`, NOT at the top of the bag — the first version of this
        // forwarding called `dev.ssao` and threw, which is the same trap twice: the whitelist is
        // by hand, so a forward is only correct if its PATH is copied from the owner, not guessed
        // from the name.
        ssao: (on) => dev.grounding.ssao(on),
        occlusion: (value) => dev.grounding.occlusion(value),
        endGame: () => dev.endGame(),
        openLeaderboard: () => dev.openLeaderboard(),
        records: () => recordStore.all(),
        // v0.8.21: replay the opening wave on demand, so the probe can drive it without
        // depending on where a click landed. It calls armIntro() itself — the same function
        // every real entry point calls.
        replayIntro: () => dev.replayIntro(),
        settleIntro: () => dev.settleIntro(),
        // v0.8.23 (P5): the L5 dip normally needs a 4-line clear to happen, which cannot be
        // arranged on demand. This calls the very same triggerSlowMo() the clear path calls,
        // so "does the dip block input" can be asserted instead of assumed.
        triggerSlowMo: (level) => dev.triggerSlowMo(level),
        // v0.8.16 rescue probe (07 §3.1 B1). A shell jam is common in real play but cannot be
        // produced on demand, so the three judgement branches could not be asserted without a
        // way to build one: `jam()` fills every free shell cell (nothing fits anywhere),
        // `setItems()` sets the charges, and `stuckCheck()` runs the very same judgement the
        // gameplay path runs — no mock of it.
        setItems: (counts) => dev.setItems(counts),
        items: () => dev.items(),
        jam: () => dev.jam(),
        stuckCheck: () => dev.stuckCheck(),
        // Visual triggers for the headless UI checks: they call the very same functions the
        // gameplay path calls, so a screenshot of them is a screenshot of the real rendering,
        // not a hand-built mock of it.
        //
        // v0.10.3: `showChain` / `showHonor` were removed with the resident CHAIN pill and the
        // honour banner. `demoReward(lines, chain, wipedFaces)` replaces them: it runs the real
        // rule (scoring.js settleScore) through the real presentation, which is what the five
        // demos the handoff's §6.4 asks for are made of.
        demoReward: (lines, chain, wipedFaces) => dev.demoReward(lines, chain, wipedFaces),
        showScorePop: (points, options) => dev.showScorePop(points, options),
        // v0.10.1 clear-celebration probe: an L1–L5 clear cannot be arranged by playing, so the
        // probe drives the very same spawnClearEffects() the gameplay path calls, plus the two
        // audio-window handles that make "was anything heard since here" answerable.
        demoClear: (lines) => dev.demoClear(lines),
        clearCelebration: () => dev.clearCelebration(),
        audioReset: () => dev.audioReset(),
        audioUnlock: () => dev.audioUnlock(),
        // G1 grounding diagnostics (MATERIAL_GROUNDING_REWORK_HANDOFF §5): the pedestal-contact
        // round has to switch ONE term at a time (SSAO / the projected receiver / the contact
        // decal / the support route) and hold a mid-turn pose that exists for a few frames
        // during a real flip. All presentation-only; main builds the callbacks.
        grounding: dev.grounding,
      })
    }
  }

  return { install, readOnly }
}

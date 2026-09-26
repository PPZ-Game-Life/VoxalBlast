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
import { KEY_BINDINGS } from './rendering/keyboard.js'
import { blockSurfaceArtStatus } from './rendering/woodTexture.js'
import { referencePaintColor } from './rendering/referencePalette.js'

export function createDiagnostics({
  version,
  canvas,
  scene3d,
  boardView,
  blocks,
  pieceView,
  effects,
  input,
  session,
  recordStore,
  sessionStore,
  homeUi,
  settingsUi,
  dev,
}) {
  // The canvas box is the renderer's own element, read live: a cached rect would freeze the
  // framing numbers to the window size they were first measured at.
  const canvasRect = () => canvas.getBoundingClientRect()

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
        surfaceArt: blockSurfaceArtStatus(),
        environment: scene.environment,
        hdr: scene.hdr,
        contactShadows: scene.contactShadows,
        toneMapping: scene.toneMapping,
        programs: scene.programs,
        lowPower: scene.lowPower,
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
    faces: () => boardView.facesReport(canvasRect()),
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
      const rect = canvasRect()
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
        // v0.9.3 spin: `roomless` is the board's verdict on the latched face (no origin on it
        // takes this piece, so the drag turns the cube instead) and `spin` / `spinAxis` are the
        // turn the gesture switched into. v0.9.4 adds the GENERAL arming condition: `pushPx` is how
        // far the finger has been pushing a piece that cannot follow it (pinned against a face
        // edge), in client px on the face's own axes, and `pinAxis` is the turn that push means. A
        // check reads them together with `rotation.front` to prove the cube turned with the finger
        // still down.
        roomless: d.roomless,
        spin: d.spin,
        spinAxis: d.spinAxis,
        pushPx: d.pushPx,
        pushCells: d.pushCells,
        pinAxis: d.pinAxis,
        // v0.9.5: `armed` is the turn the push has armed (the cube leans, nothing committed) and
        // `armedAxis` the axis it will turn on once PIECE_SPIN.pinHoldMs has passed. A check reads them
        // with `rotation` to prove the lean happens BEFORE the face moves.
        armed: d.armed,
        armedAxis: d.armedAxis,
        // v0.9.7: 「一次手势一面」 — true once this gesture has turned a face by push, which closes the
        // push path for the rest of the gesture (the return motion out of a turn can no longer arm
        // a second one, let alone the one that would undo it).
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
    // The run in progress: chain, per-run bests, which faces have been cleared and the honors
    // earned — what the Game Over panel and the records layer are fed from.
    run: () => ({
      chain: session.run.chain,
      bestChain: session.run.bestChain,
      maxLinesOneMove: session.run.maxLinesOneMove,
      maxFacesOneMove: session.run.maxFacesOneMove,
      facesLit: [...session.run.facesLit],
      faceWipes: session.run.faceWipes,
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
    intro: () => boardView.introReport(),
    candidateFrames: () => pieceView.candidateFrames(),
    // v0.8.23 (P5): what the effects layer is holding right now. Particle systems are not
    // board meshes, so no other read-out can prove they were released on a restart; the shake
    // and the slow-motion dip are otherwise invisible too. Read-only; no gameplay path reads it.
    effects: () => effects.report(),
    session: () => sessionStore.read(),
    // v0.4.1: the keyboard bindings the game actually honours. The headless check reads this
    // and compares it against the keycaps printed in the controls card, so a legend can never
    // advertise a key that does nothing (and vice versa).
    keys: () => KEY_BINDINGS.map((binding) => ({ axis: binding.axis, keys: [...binding.keys] })),
    controls: () => settingsUi.report(),
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
        showChain: (chain) => dev.showChain(chain),
        showHonor: (lines, faces) => dev.showHonor(lines, faces),
        showScorePop: (points, options) => dev.showScorePop(points, options),
      })
    }
  }

  return { install, readOnly }
}

// Piece view — the three candidate previews and everything drawn for a piece in flight
// (refactor P4a + P4b).
//
// Plan §2 `pieceView.js`: it owns the preview renderers, their scenes, cameras and meshes, the
// map holding them, the LANDING marker, the DRAG GHOST and the read-only projections the
// headless checks read. It does NOT own the hand of pieces (gameSession, P6), the selection or
// the drag itself (gameInput, P7), the legality of a drop (board/main), or the slot DOM: main
// keeps that DOM until the input state it reads has moved, and never the other way round.
//
// Why a separate WebGL renderer per slot at all: each candidate is an off-screen scene drawn
// into its own `<canvas>` in the slot card, with its own tone mapping and lights, so the
// thumbnails cannot inherit the board's camera, exposure or post chain. That is deliberate and
// stays: no atlas, no shared context, no instancing (plan §6 P4.5 / §5.3).
//
// The P4b split (plan §6 P4.3) is the load-bearing one: **main decides legality and the drop
// mode, this module only draws.** That is why `showLanding` is handed the face, the cells and
// the origin instead of solving for them, and why `syncDragGhost` receives the pointer's NDC and
// the two pixel rulers instead of reading an event: unprojection, scale and tint are the view's
// arithmetic, "is this drop legal" is not. The lattice -> world conversion and the face normal
// stay boardView's (plan §6 P4.4 — no second copy of the face basis anywhere).
//
// Two inputs arrive as getters because both change under the module's feet: the piece objects
// are replaced by every new deal, and the selection is reassigned on every click. `blocks` is a
// plain parameter -- the shared geometry and the shared material factory are built once in main
// and every consumer must be handed the SAME instances (plan §5.3).
import * as THREE from 'three'
import { addToyLights } from './toyLights.js'
import { BOARD_STYLE as style, DRAG_GHOST, dragGhostLiftPx, RENDER_PALETTE as palette } from './config.js'
import { faceLattice } from '../game/board.js'
import { referencePaintColor } from './referencePalette.js'

export function createPieceView({
  blocks,
  cubeGroup,
  camera,
  cellToWorld,
  cubeVector,
  previewLift,
  getCanvasRect,
  getCells,
  getSelectedPiece,
}) {
  // One entry per candidate slot: the piece, the slot button, that slot's renderer / scene /
  // camera / meshes, and the frame size the last projection was fitted to.
  const previews = new Map()
  // Flat, face-on preview positions: (u,v) -> screen space (x right, y down).
  // `pitch` is the cell edge: the slot thumbnails pack the cells tighter (0.8) so
  // the outline fits the card, the drag ghost uses the board's own 1.0 pitch.
  function flatPreviewPositions(cells, pitch = 0.8) {
    const maxU = Math.max(...cells.map(([u]) => u))
    const maxV = Math.max(...cells.map(([, v]) => v))
    const cx = maxU / 2
    const cy = maxV / 2
    return cells.map(([u, v]) => new THREE.Vector3((u - cx) * pitch, (cy - v) * pitch, 0))
  }

  function disposePiecePreviews() {
    previews.forEach((preview) => {
      preview.meshes.forEach((mesh) => {
        mesh.material.dispose()
        mesh.children.forEach((child) => child.material?.dispose())
      })
      preview.renderer.dispose()
      preview.renderer.forceContextLoss?.()
    })
    previews.clear()
  }

  function createPiecePreview(piece, canvas, slot) {
    const previewRenderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'low-power' })
    previewRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5))
    previewRenderer.outputColorSpace = THREE.SRGBColorSpace
    previewRenderer.toneMapping = THREE.NeutralToneMapping
    previewRenderer.toneMappingExposure = style.exposure
    previewRenderer.setClearColor(0x000000, 0)

    const previewScene = new THREE.Scene()
    addToyLights(previewScene)

    const previewCamera = new THREE.OrthographicCamera(-2.5, 2.5, 2.2, -2.2, 0.1, 40)
    previewCamera.position.set(0.12, 0.18, 8)
    previewCamera.lookAt(0, 0, 0)
    const root = new THREE.Group()
    previewScene.add(root)
    const positions = flatPreviewPositions(getCells(piece))
    // A cell has one visual size across the entire hand. Do not inflate a dot
    // or a two-cell shape to fill the same box as a nine-cell shape.
    const outlineColor = new THREE.Color(referencePaintColor(piece.shape.color)).multiplyScalar(0.58)
    const meshes = positions.map((position) => {
      const mesh = new THREE.Mesh(blocks.blockGeometry, blocks.makeMaterial(piece.shape.color))
      mesh.scale.setScalar(0.8)
      mesh.position.copy(position)
      mesh.add(new THREE.LineSegments(blocks.edgeGeometry, new THREE.LineBasicMaterial({ color: outlineColor, transparent: true, opacity: style.voxelEdgeOpacity })))
      root.add(mesh)
      return mesh
    })
    previews.set(piece, { piece, slot, renderer: previewRenderer, scene: previewScene, camera: previewCamera, root, meshes, frameWidth: 0, frameHeight: 0 })
  }

  function updatePieceSlotSelection() {
    previews.forEach((preview, piece) => {
      preview.slot.classList.toggle('selected', getSelectedPiece() === piece)
      preview.slot.classList.toggle('used', piece.used)
    })
  }

  function updatePiecePreviews() {
    previews.forEach((preview) => {
      const width = Math.max(preview.renderer.domElement.clientWidth, 1)
      const height = Math.max(preview.renderer.domElement.clientHeight, 1)
      if (preview.frameWidth !== width || preview.frameHeight !== height) {
        preview.renderer.setSize(width, height, false)
        preview.frameWidth = width
        preview.frameHeight = height
        // Fit the actual projected volume, including the cubes' depth. A 3×3
        // shape's oblique projection was taller than the old fixed 3.2-unit view.
        preview.root.updateMatrixWorld(true)
        preview.camera.updateMatrixWorld(true)
        const bounds = new THREE.Box3().setFromObject(preview.root).applyMatrix4(preview.camera.matrixWorldInverse)
        const size = bounds.getSize(new THREE.Vector3())
        const center = bounds.getCenter(new THREE.Vector3())
        const usable = 0.88
        // Reserve the same 3×3 envelope in every slot, in addition to the actual
        // bounds, so small pieces and large pieces keep identical cell pitch.
        const envelope = 2.45
        const halfHeight = Math.max(envelope / (2 * usable), envelope * height / (2 * width * usable), size.y / (2 * usable), size.x * height / (2 * width * usable))
        const halfWidth = halfHeight * width / height
        preview.camera.left = center.x - halfWidth
        preview.camera.right = center.x + halfWidth
        preview.camera.top = center.y + halfHeight
        preview.camera.bottom = center.y - halfHeight
        preview.camera.updateProjectionMatrix()
      }
      preview.camera.position.set(0.12, 0.18, 8)
      preview.camera.lookAt(0, 0, 0)
      preview.renderer.render(preview.scene, preview.camera)
    })
  }

  // Read-only report for the headless checks: where each candidate's projected volume sits in
  // NDC, so a slot can be proven not to crop its shape. Same fields the hook has always exposed
  // (refactor P4a; P9 only assembles it).
  function candidateFrames() {
    return [...previews.values()].map(preview => {
      preview.root.updateMatrixWorld(true)
      const bounds = new THREE.Box3().setFromObject(preview.root)
      const points = []
      for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
        points.push(new THREE.Vector3(x, y, z).project(preview.camera))
      }
      return {
        name: preview.piece.shape.name,
        blocks: preview.meshes.length,
        minX: Math.min(...points.map(p => p.x)), maxX: Math.max(...points.map(p => p.x)),
        minY: Math.min(...points.map(p => p.y)), maxY: Math.max(...points.map(p => p.y)),
      }
    })
  }

  // ---- The landing marker (refactor P4b) --------------------------------------
  // The group is CUBE-LOCAL: the cells below are positioned in cube-local coordinates, so the
  // marker turns with the cube instead of floating over it. (The drag ghost next door is
  // CAMERA-local for the opposite reason: the piece in hand must never inherit that rotation.)
  const landing = new THREE.Group()
  cubeGroup.add(landing)

  // The board's 98 tiles, both preview groups and the ghost all hand out the SAME geometry and
  // the same material factory, so tearing a group down must never dispose a shared instance —
  // it would take the live board with it (plan §5.3).
  function disposeNode(node) {
    node.traverse((child) => {
      if (child.geometry && !blocks.sharedGeometries.includes(child.geometry)) child.geometry.dispose()
      if (Array.isArray(child.material)) child.material.forEach((material) => material.dispose())
      else if (child.material) child.material.dispose()
    })
  }

  function clearGroup(group) {
    while (group.children.length) {
      const child = group.children.pop()
      if (child) disposeNode(child)
    }
  }

  function clearLanding() {
    clearGroup(landing)
  }

  // Draw the cells the piece would occupy at this origin. Whether the drop is LEGAL is main's
  // decision (`valid`); so is the piece's own colour, which arrives resolved because it comes
  // from the piece object main is holding.
  //
  // The marker is a translucent ghost OF THE PIECE IN HAND, so it takes the piece's
  // OWN paint, not a fixed green: a green marker next to a purple piece in the tray
  // reads as two different objects, and it throws away the one colour that says which
  // of the three candidates is being placed. 05 §… "候选预览与棋盘同源" — the same
  // reasoning that makes the board, the tray and the drag ghost share one material.
  // Only the INVALID state keeps a colour of its own (`palette.invalid`, terracotta),
  // because there the colour is carrying a different message: "no room here".
  function showLanding({ face, cells, origin, valid, color }) {
    const faceNormal = cubeVector(face, 'n')
    const markerColor = valid ? color : palette.invalid
    const markerEdge = valid
      ? new THREE.Color(referencePaintColor(color)).multiplyScalar(0.58)
      : new THREE.Color(0x7a2a17)
    cells.forEach(([u, v]) => {
      const [cx, cy, cz] = faceLattice(face, u + origin.u, v + origin.v)
      // The landing marker IS a ghost of the block: same cube, same cell, same gap to
      // its neighbours. The player therefore sees the board it is about to get, not a
      // highlight floating over it (05 §6「落点预览」).
      const mesh = new THREE.Mesh(blocks.blockGeometry, blocks.makeMaterial(markerColor, 0.72))
      mesh.position.copy(cellToWorld(cx, cy, cz)).addScaledVector(faceNormal, previewLift)
      mesh.add(new THREE.LineSegments(blocks.edgeGeometry, new THREE.LineBasicMaterial({
        color: markerEdge,
        transparent: true,
        opacity: 0.92,
        depthWrite: false,
      })))
      landing.add(mesh)
    })
  }

  // The landing marker is read by a check and by the drag report, never by gameplay: how many
  // cells it is drawing, and the material each of them ended up wearing.
  function landingCount() {
    return landing.children.length
  }

  function landingCells() {
    return landing.children.map((mesh) => ({
      color: `#${mesh.material.color.getHexString()}`,
      opacity: Number(mesh.material.opacity.toFixed(3)),
    }))
  }

  // ---- Drag ghost (refactor P4b; v0.4.4) --------------------------------------
  // The piece the finger is carrying (see DRAG_GHOST in rendering/config.js). It
  // hangs off the CAMERA rather than the cube: it must always face the player and
  // never inherit the cube's rotation, and camera space turns "put it at this
  // pixel, this big" into plain arithmetic (syncDragGhost). depthTest is off on
  // every ghost material because the ghost is the one thing a drag may never hide:
  // whatever it overlaps, the player has to be able to see the shape in hand.
  const ghost = new THREE.Group()
  ghost.visible = false
  camera.add(ghost)
  // Reused per drag so tinting an invalid drop never reallocates a Color.
  const ghostInvalid = new THREE.Color(palette.invalid)
  const ghostInvalidEdge = new THREE.Color(palette.invalid).multiplyScalar(0.62)

  // 03 §4 has always asked for「鼠标按下方块后进入拖拽态，方块跟随光标移动」; until
  // v0.4.4 the drag drew the landing cells on the board and nothing else, so the
  // piece the player was holding had no on-screen existence at all. These four
  // helpers are the whole feature: build it once when the gesture starts, place it
  // on every pointermove, tint it by the drop state, drop it when the gesture ends.
  function clearDragGhost() {
    ghost.visible = false
    clearGroup(ghost)
  }

  // One rounded voxel per cell, in the piece's own colour, with the slot preview's
  // darkened outline — the ghost must read as the SAME object the player picked up
  // (05「候选预览与棋盘同源」), not as a second visual language for dragging.
  function buildDragGhost(piece) {
    clearGroup(ghost)
    const fill = new THREE.Color(referencePaintColor(piece.shape.color))
    const outline = fill.clone().multiplyScalar(0.58)
    const cells = getCells(piece)
    // Rows the shape spans on screen: what the fingertip clearance is measured from.
    ghost.userData.rows = cells.reduce((max, [, v]) => Math.max(max, v), 0) + 1
    for (const position of flatPreviewPositions(cells, 1)) {
      const material = blocks.makeMaterial(piece.shape.color, DRAG_GHOST.opacity)
      // Fog is a depth cue for the board; at the ghost plane it would only wash the
      // piece out as the camera zooms.
      material.fog = false
      // Always on top: the ghost may never be swallowed by the cube it is about to
      // land on. Kept transparent from the start so tinting never has to rebuild
      // the material.
      material.depthTest = false
      material.depthWrite = false
      material.transparent = true
      const mesh = new THREE.Mesh(blocks.blockGeometry, material)
      mesh.position.copy(position)
      mesh.renderOrder = 12
      mesh.userData.fillColor = fill.clone()
      mesh.userData.edgeColor = outline.clone()
      const edges = new THREE.LineSegments(blocks.edgeGeometry, new THREE.LineBasicMaterial({
        color: outline,
        transparent: true,
        opacity: 0.7,
        depthTest: false,
        depthWrite: false,
      }))
      edges.renderOrder = 13
      mesh.add(edges)
      ghost.add(mesh)
    }
    ghost.visible = false
  }

  // `mode` is the state the drag is in: 'carry' (in hand, off the cube), 'snap' (the
  // piece is on the board now — the ghost goes away, the landing preview is the
  // piece), 'invalid' (on the cube but this face has no room) or 'cancel' (dragged
  // back over the candidate/item strip).
  function tintDragGhost(mode) {
    const invalid = mode === 'invalid'
    const opacity = mode === 'cancel' ? DRAG_GHOST.cancelOpacity
      : invalid ? DRAG_GHOST.invalidOpacity : DRAG_GHOST.opacity
    ghost.userData.mode = mode
    for (const mesh of ghost.children) {
      mesh.material.color.copy(invalid ? ghostInvalid : mesh.userData.fillColor)
      mesh.material.opacity = opacity
      const edges = mesh.children[0]
      if (edges) edges.material.color.copy(invalid ? ghostInvalidEdge : mesh.userData.edgeColor)
    }
  }

  // Put the ghost where the finger is. It lives in the camera's frame, so "at this
  // pixel, this big" is linear algebra rather than a raycast — but the two corner
  // rays are taken from the REAL projection matrices (unproject + worldToLocal)
  // instead of a hand-rolled tan(fov/2). The camera's aspect belongs to the canvas
  // the renderer actually draws into; whenever that disagreed with the CSS box, a
  // hand-rolled formula sized and placed the ghost by the wrong factor with no
  // error anywhere (v0.4.5: it was 16% off on desktop, which is part of what made
  // the first version feel like it was not following the drag). unproject() cannot
  // disagree with the renderer, because it is the renderer's own matrices.
  //
  // The three rulers are measured by main, where the renderer's CSS box and the cube's
  // screen bounds live (plan §6 P4.3): `ndc` is the pointer, `canvasHeight` is the canvas
  // in CSS pixels, `cellPx` is one cell of the cube as it is drawn right now.
  const ghostPlaneMin = new THREE.Vector3()
  const ghostPlaneMax = new THREE.Vector3()

  function syncDragGhost({ ndc, canvasHeight, cellPx, pointerType, mode }) {
    if (!ghost.children.length) return
    // v0.4.5: ONE piece per turn. The moment the piece attaches to a face the board
    // draws it, and the one in hand must not be there as well — the player read the
    // pair as "two blocks", which is exactly what it was.
    if (mode === 'snap') {
      ghost.visible = false
      ghost.userData.mode = mode
      return
    }
    const distance = DRAG_GHOST.planeDistance
    camera.updateMatrixWorld(true)
    ghostPlaneMin.set(-1, -1, 0.5).unproject(camera)
    camera.worldToLocal(ghostPlaneMin)
    ghostPlaneMax.set(1, 1, 0.5).unproject(camera)
    camera.worldToLocal(ghostPlaneMax)
    const toPlane = distance / Math.max(-ghostPlaneMin.z, 1e-6)
    const halfWidth = (ghostPlaneMax.x - ghostPlaneMin.x) * 0.5 * toPlane
    const halfHeight = (ghostPlaneMax.y - ghostPlaneMin.y) * 0.5 * toPlane
    const worldPerPx = (2 * halfHeight) / canvasHeight

    // Touch carries the piece just above the fingertip: half its own height plus a
    // small clearance, so the whole shape clears the thumb instead of losing its
    // bottom row under it. The mouse gets a small fixed lift only — a shape-scaled
    // offset under a mouse reads as "not following the drag" (see DRAG_GHOST).
    //
    // The rule itself is config's (v0.8.27), because gameInput has to know the very same
    // lift to land the piece's centre where the ghost was showing it.
    const rows = ghost.userData.rows || 1
    const liftPx = dragGhostLiftPx(pointerType, rows, cellPx)

    ghost.visible = true
    ghost.scale.setScalar(cellPx * worldPerPx)
    // Camera space: +X is screen-right and +Y is screen-up, exactly as NDC. (The X
    // term used to be negated — invisible in every check because they all aimed at
    // the canvas centre, where ndc.x is 0.)
    ghost.position.set(ndc.x * halfWidth, ndc.y * halfHeight + liftPx * worldPerPx, -distance)
    tintDragGhost(mode)
  }

  // v0.4.4 drag ghost: where the piece in hand actually is on screen. `cells` are
  // the client-pixel centres of the ghost's voxels (so a check can assert that the
  // ghost tracks the pointer within the lift offset and that a 3-cell piece really
  // drew three voxels), `cellPx` is the on-screen cell edge, and `mode` is the
  // state the drop is in. Read-only; no gameplay path reads it. The report is
  // assembled by main, which adds the fields it owns (the gesture it is in, the
  // landing cells, the anchor) (refactor P4b; P9 only assembles it).
  function ghostReport() {
    if (!ghost.parent) return { visible: false, count: 0, cells: [] }
    camera.updateMatrixWorld()
    ghost.updateWorldMatrix(true, true)
    const rect = getCanvasRect()
    const toScreen = (v) => {
      const p = v.clone().project(camera)
      return {
        x: rect.left + (p.x * 0.5 + 0.5) * rect.width,
        y: rect.top + (-p.y * 0.5 + 0.5) * rect.height,
      }
    }
    const cells = ghost.children.map((mesh) => toScreen(mesh.getWorldPosition(new THREE.Vector3())))
    const fill = ghost.children[0]?.material
    // MEASURED cell pitch, not the number the placement code intended: project the
    // ghost's own +X axis (its layout pitch is exactly 1.0 local unit) and read the
    // pixels back off the screen. This is what catches a projection that disagrees
    // with the canvas the renderer is drawing into.
    const pitchFrom = toScreen(ghost.localToWorld(new THREE.Vector3(0, 0, 0)))
    const pitchTo = toScreen(ghost.localToWorld(new THREE.Vector3(1, 0, 0)))
    return {
      visible: ghost.visible,
      count: ghost.children.length,
      cells,
      // The ghost's own origin: what the lift is measured against (the cells'
      // centroid is not the group centre — an L or T piece is lopsided).
      center: toScreen(ghost.getWorldPosition(new THREE.Vector3())),
      cellPx: pitchTo.x - pitchFrom.x,
      opacity: fill ? fill.opacity : 0,
      color: fill ? `#${fill.color.getHexString()}` : null,
      // 'carry' | 'snap' | 'invalid' | 'cancel' — the state the drag is in. 'snap'
      // is the handoff: the ghost is hidden because the board is drawing the piece.
      mode: ghost.userData.mode ?? null,
    }
  }

  // ---- Item target overlay (refactor P4c) -------------------------------------
  // Cube-local, like the landing marker and for the same reason: these cells are positioned in
  // cube-local coordinates, so the highlight a tool paints has to turn with the cube it is
  // pointing at. Which cells a tool covers is the tool's RULE and whether a cell is already
  // taken is the board's (gameSession, P6) — both arrive here as data (plan §6 P4.3).
  const itemOverlay = new THREE.Group()
  cubeGroup.add(itemOverlay)

  function clearItemOverlay() {
    clearGroup(itemOverlay)
  }

  // One marker per targeted cell: an occupied cell gets the full-size, more opaque ghost of the
  // block already sitting there, an empty one a smaller, fainter marker.
  function showItemOverlay({ face, cells }) {
    const normal = cubeVector(face, 'n')
    cells.forEach(({ cell: [x, y, z], occupied }) => {
      const mesh = new THREE.Mesh(blocks.blockGeometry, blocks.makeMaterial(palette.valid, occupied ? 0.55 : 0.22))
      mesh.scale.setScalar(occupied ? 1 : 0.72)
      // The marker is a ghost of the BLOCK that would sit in this cell, lifted just
      // clear of the one already there so the two cannot z-fight.
      mesh.position.copy(cellToWorld(x, y, z)).addScaledVector(normal, previewLift)
      itemOverlay.add(mesh)
    })
  }

  return {
    disposePiecePreviews,
    createPiecePreview,
    updatePieceSlotSelection,
    updatePiecePreviews,
    candidateFrames,
    clearLanding,
    showLanding,
    landingCount,
    landingCells,
    buildDragGhost,
    clearDragGhost,
    syncDragGhost,
    ghostReport,
    clearItemOverlay,
    showItemOverlay,
  }
}

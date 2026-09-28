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
  onClearForecast,
}) {
  // One entry per candidate slot: the piece, the slot button, that slot's renderer / scene /
  // camera / meshes, and the frame size the last projection was fitted to.
  const previews = new Map()
  let draggedPiece = null
  let returnFlight = null

  function cancelReturn() {
    if (!returnFlight) return
    returnFlight.animation.cancel()
    returnFlight.finish()
  }

  // A short, input-transparent flight outside the board canvas. Capture the actual
  // posed 3D piece using its existing preview renderer, so the rejected piece
  // starts exactly where the landing marker/ghost was, even near a canvas edge.
  function projectedBounds(group, viewCamera, rect) {
    group.updateWorldMatrix(true, true)
    viewCamera.updateMatrixWorld(true)
    const box = new THREE.Box3().setFromObject(group)
    const points = []
    for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
      const p = new THREE.Vector3(x, y, z).project(viewCamera)
      points.push({ x: rect.left + (p.x + 1) * rect.width / 2, y: rect.top + (1 - p.y) * rect.height / 2 })
    }
    const left = Math.min(...points.map(p => p.x)) - 2
    const top = Math.min(...points.map(p => p.y)) - 2
    return { left, top, width: Math.max(...points.map(p => p.x)) - left + 2, height: Math.max(...points.map(p => p.y)) - top + 2 }
  }

  function returnPiece(piece) {
    cancelReturn()
    const preview = previews.get(piece)
    const source = landing.children.length ? landing : ghost.visible ? ghost : null
    if (!preview || !source) return
    const rect = getCanvasRect()
    const from = projectedBounds(source, camera, rect)
    const to = projectedBounds(preview.root, preview.camera, preview.renderer.domElement.getBoundingClientRect())
    if (![from.width, from.height, to.width, to.height].every(n => Number.isFinite(n) && n > 0)) return
    const snapshot = new THREE.Scene()
    addToyLights(snapshot)
    const copy = source.clone(true)
    copy.visible = true
    copy.matrixAutoUpdate = false
    copy.matrix.copy(source.matrixWorld)
    const temporaryMaterials = []
    copy.traverse(node => {
      if (!node.material) return
      node.material = node.material.clone()
      temporaryMaterials.push(node.material)
      node.material.color.set(referencePaintColor(piece.shape.color))
      if (node.isLineSegments) node.material.color.multiplyScalar(0.58)
      node.material.opacity = node.isLineSegments ? style.voxelEdgeOpacity : 0.96
    })
    snapshot.add(copy)
    const captureCamera = camera.clone(false)
    captureCamera.setViewOffset(rect.width, rect.height, from.left - rect.left, from.top - rect.top, from.width, from.height)
    const canvas = document.createElement('canvas')
    canvas.className = 'piece-return-flight'
    canvas.setAttribute('aria-hidden', 'true')
    const ratio = preview.renderer.getPixelRatio()
    canvas.width = Math.ceil(from.width * ratio)
    canvas.height = Math.ceil(from.height * ratio)
    canvas.style.cssText = `position:fixed;pointer-events:none;z-index:30;left:${from.left}px;top:${from.top}px;width:${from.width}px;height:${from.height}px;transform-origin:0 0;`
    preview.renderer.setSize(from.width, from.height, false)
    preview.renderer.render(snapshot, captureCamera)
    canvas.getContext('2d').drawImage(preview.renderer.domElement, 0, 0, canvas.width, canvas.height)
    preview.renderer.setSize(preview.frameWidth, preview.frameHeight, false)
    preview.renderer.render(preview.scene, preview.camera)
    temporaryMaterials.forEach(material => material.dispose())
    document.body.appendChild(canvas)
    preview.slot.classList.add('piece-returning')
    const animation = canvas.animate([
      { transform: 'translate(0px, 0px) scale(1, 1)', filter: 'grayscale(1)' },
      { transform: `translate(${to.left - from.left}px, ${to.top - from.top}px) scale(${to.width / from.width}, ${to.height / from.height})`, filter: 'grayscale(0)' },
    ], { duration: 420, easing: 'cubic-bezier(.22,.7,.3,1)', fill: 'forwards' })
    const flight = { animation, from, to, finish: () => {
      canvas.remove()
      preview.slot.classList.remove('piece-returning')
      if (returnFlight === flight) returnFlight = null
    } }
    returnFlight = flight
    animation.finished.then(flight.finish, flight.finish)
  }
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
    cancelReturn()
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
    onClearForecast()
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
  // Only the INVALID state keeps a colour of its own (`palette.invalid`, grey),
  // because there the colour is carrying a different message: "no room here".
  function showLanding({ face, cells, origin, valid, color }) {
    const faceNormal = cubeVector(face, 'n')
    const markerColor = valid ? color : palette.invalid
    const markerEdge = valid
      ? new THREE.Color(referencePaintColor(color)).multiplyScalar(0.58)
      : new THREE.Color(palette.invalid).multiplyScalar(0.58)
    cells.forEach(([u, v]) => {
      const [cx, cy, cz] = faceLattice(face, u + origin.u, v + origin.v)
      // The landing marker IS a ghost of the block: same cube, same cell, same gap to
      // its neighbours. The player therefore sees the board it is about to get, not a
      // highlight floating over it (05 §6「落点预览」).
      const mesh = new THREE.Mesh(blocks.blockGeometry, blocks.makeMaterial(markerColor, valid ? 0.86 : 0.96))
      mesh.position.copy(cellToWorld(cx, cy, cz)).addScaledVector(faceNormal, previewLift)
      mesh.add(new THREE.LineSegments(blocks.edgeGeometry, new THREE.LineBasicMaterial({
        color: markerEdge,
        transparent: true,
        opacity: style.voxelEdgeOpacity,
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
  function clearDragGhost({ keepReturn = false } = {}) {
    if (!keepReturn) cancelReturn()
    previews.forEach(preview => preview.slot.classList.remove('piece-dragging'))
    ghost.visible = false
    clearGroup(ghost)
  }

  // One rounded voxel per cell, in the piece's own colour, with the slot preview's
  // darkened outline — the ghost must read as the SAME object the player picked up
  // (05「候选预览与棋盘同源」), not as a second visual language for dragging.
  function buildDragGhost(piece) {
    cancelReturn()
    draggedPiece = piece
    clearGroup(ghost)
    const fill = new THREE.Color(referencePaintColor(piece.shape.color))
    const outline = fill.clone().multiplyScalar(0.58)
    const cells = getCells(piece)
    // Rows the shape spans on screen: what the fingertip clearance is measured from.
    ghost.userData.rows = cells.reduce((max, [, v]) => Math.max(max, v), 0) + 1
    ghost.userData.columns = cells.reduce((max, [u]) => Math.max(max, u), 0) + 1
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
        opacity: style.voxelEdgeOpacity,
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
  // piece), 'invalid' (on the cube but this face has no room), 'cancel' (dragged
  // back over the candidate/item strip) or 'turn' (carried off the cube: the turn dwell
  // has armed, so the piece keeps its own colour instead of reading as "you cannot drop
  // this here" — the tint is about the DROP, and there is no drop where it is now).
  function tintDragGhost(mode) {
    const invalid = mode !== 'snap' && mode !== 'turn'
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

  function syncDragGhost({ ndc, canvasHeight, cellPx, pointerType, mode, keepInView = false }) {
    if (!ghost.children.length) return
    previews.get(draggedPiece)?.slot.classList.add('piece-dragging')
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
    if (keepInView) {
      // Viewport edges can lie outside this canvas (especially above the HUD and
      // below the tray). Keep the held shape just inside the visible play area; only its
      // display is clamped, never the piece centre that drives the turn dwell (v0.9.11
      // measures that centre from the ghost's own placement, not from this clamp).
      const insetX = ((ghost.userData.columns || 1) * cellPx / 2 + 8) * worldPerPx
      const insetY = (rows * cellPx / 2 + 8) * worldPerPx
      const limitX = Math.max(0, halfWidth - insetX)
      const limitY = Math.max(0, halfHeight - insetY)
      ghost.position.x = THREE.MathUtils.clamp(ghost.position.x, -limitX, limitX)
      ghost.position.y = THREE.MathUtils.clamp(ghost.position.y, -limitY, limitY)
    }
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
      returning: returnFlight ? { progress: returnFlight.animation.effect.getComputedTiming().progress, from: returnFlight.from, to: returnFlight.to } : null,
    }
  }

  // ---- Item scope overlay (refactor P4c, redesigned for 07 §8.5/§8.6) -----------
  // Cube-local, like the landing marker and for the same reason: these cells are positioned in
  // cube-local coordinates, so the scope a tool paints has to turn with the cube it is pointing
  // at. The input layer decides WHICH cells a tool reaches and which of them hold a block; this
  // module is handed the finished list and only draws it.
  //
  // v1 draws FOUR things, and they answer four different questions the old single-opacity ghost
  // could not (07 §8.1: 「炸弹也不该让玩家猜盲盒」):
  //   * the frame + internal ruling  — where the scope is, spaces included;
  //   * a faint floor plate          — a cell that is EMPTY, explicitly not a doomed one;
  //   * the full-size ghost + edge   — a cell that WILL be cleared (the block itself, outlined);
  //   * the shared marker            — a cell an edge/corner hands to the neighbouring face.
  // Plus the anchor pip and, when the face edge cut the scope, the clipped-side ticks.
  const itemOverlay = new THREE.Group()
  cubeGroup.add(itemOverlay)
  // Materials are created once per rebuild and shared by every bar/dot in it, then disposed
  // together — `clearGroup` would dispose a shared material once per mesh that referenced it,
  // so the overlay owns its own teardown instead of reusing the landing marker's.
  let itemMaterials = []
  let itemPulse = []
  const itemFrameLift = style.blockSize * 0.5 + style.blockSize * 0.06

  function clearItemOverlay() {
    while (itemOverlay.children.length) {
      const child = itemOverlay.children.pop()
      if (child) child.traverse((node) => {
        if (node.geometry && !blocks.sharedGeometries.includes(node.geometry)) node.geometry.dispose()
      })
    }
    itemMaterials.forEach((material) => material.dispose())
    itemMaterials = []
    itemPulse = []
  }

  function flatMaterial(color, opacity) {
    const material = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity,
      depthWrite: false,
      toneMapped: false,
    })
    itemMaterials.push(material)
    return material
  }

  // One prism between two cube-local points. The face basis is ±x/±y/±z in cube-local space, so
  // a scope edge is always axis-aligned there and the scale can be written per axis — no
  // per-bar quaternion, and no second copy of the face basis.
  function addBar(group, from, to, thickness, material) {
    const delta = to.clone().sub(from)
    const length = delta.length()
    if (!(length > 1e-6)) return
    const mesh = new THREE.Mesh(blocks.barGeometry, material)
    const scale = new THREE.Vector3(thickness, thickness, thickness)
    const ax = Math.abs(delta.x)
    const ay = Math.abs(delta.y)
    const az = Math.abs(delta.z)
    if (ax >= ay && ax >= az) scale.x = length
    else if (ay >= az) scale.y = length
    else scale.z = length
    mesh.scale.copy(scale)
    mesh.position.copy(from).add(to).multiplyScalar(0.5)
    group.add(mesh)
  }

  const itemOverlayGroup = itemOverlay

  // `scope` is the input layer's snapshot (07 §8.5.7 "所见即所得"): the SAME object the release
  // will commit, so the frame on screen and the cells that disappear cannot be two answers.
  function showItemScope({
    face,
    anchor,
    cells,
    span,
    single = false,
    clipped = 'none',
    sharedCells = [],
    empty = false,
  }) {
    clearItemOverlay()
    if (!cells.length) return
    const normal = cubeVector(face, 'n')
    const uStep = cellToWorld(...faceLattice(face, 1, 0)).sub(cellToWorld(...faceLattice(face, 0, 0)))
    const vStep = cellToWorld(...faceLattice(face, 0, 1)).sub(cellToWorld(...faceLattice(face, 0, 0)))
    const base = cellToWorld(...faceLattice(face, 0, 0))
    const lift = normal.clone().multiplyScalar(itemFrameLift)
    const at = (u, v) => base.clone().addScaledVector(uStep, u).addScaledVector(vStep, v).add(lift)

    const scopeColor = empty ? palette.invalid : palette.itemScope
    const frameMaterial = flatMaterial(scopeColor, empty ? 0.42 : 0.9)
    const ruleMaterial = flatMaterial(scopeColor, empty ? 0.18 : 0.32)
    const clearMaterial = flatMaterial(palette.itemClear, 0.95)
    const floorMaterial = flatMaterial(scopeColor, empty ? 0.1 : 0.16)
    const sharedMaterial = flatMaterial(palette.itemShared, 0.9)

    const thickness = style.blockSize * 0.035
    const ruleThickness = style.blockSize * 0.02
    const u0 = span.u0 - 0.5
    const u1 = span.u1 + 0.5
    const v0 = span.v0 - 0.5
    const v1 = span.v1 + 0.5

    // 1. The scope's own rectangle, drawn on the cell boundaries.
    addBar(itemOverlayGroup, at(u0, v0), at(u1, v0), thickness, frameMaterial)
    addBar(itemOverlayGroup, at(u0, v1), at(u1, v1), thickness, frameMaterial)
    addBar(itemOverlayGroup, at(u0, v0), at(u0, v1), thickness, frameMaterial)
    addBar(itemOverlayGroup, at(u1, v0), at(u1, v1), thickness, frameMaterial)
    // 2. The internal ruling, so a 2×2 is visibly four cells and a 5-cell line visibly five.
    for (let u = span.u0; u < span.u1; u += 1) addBar(itemOverlayGroup, at(u + 0.5, v0), at(u + 0.5, v1), ruleThickness, ruleMaterial)
    for (let v = span.v0; v < span.v1; v += 1) addBar(itemOverlayGroup, at(u0, v + 0.5), at(u1, v + 0.5), ruleThickness, ruleMaterial)

    // 3. Each cell: a floor plate if empty, the block itself + its outline if taken.
    const shared = new Set(sharedCells.map((cell) => cell.join(',')))
    cells.forEach(({ u, v, cell, occupied }) => {
      const centre = cellToWorld(cell[0], cell[1], cell[2]).addScaledVector(normal, style.blockSize * 0.5 + style.blockSize * 0.02)
      if (!occupied) {
        const plate = new THREE.Mesh(blocks.barGeometry, floorMaterial)
        plate.scale.set(style.blockSize * 0.72, style.blockSize * 0.72, Math.max(style.blockSize * 0.012, 0.004))
        plate.position.copy(centre)
        // Lay the plate flat on THIS face: the face basis is axis-aligned, so the thin axis is
        // whichever one the normal points along.
        if (Math.abs(normal.x) > 0.5) plate.scale.set(Math.max(style.blockSize * 0.012, 0.004), style.blockSize * 0.72, style.blockSize * 0.72)
        else if (Math.abs(normal.y) > 0.5) plate.scale.set(style.blockSize * 0.72, Math.max(style.blockSize * 0.012, 0.004), style.blockSize * 0.72)
        itemOverlayGroup.add(plate)
        return
      }
      const ghost = new THREE.Mesh(blocks.blockGeometry, blocks.makeMaterial(palette.itemClear, 0.34))
      ghost.scale.setScalar(0.94)
      ghost.position.copy(cellToWorld(cell[0], cell[1], cell[2])).addScaledVector(normal, previewLift)
      ghost.add(new THREE.LineSegments(blocks.edgeGeometry, new THREE.LineBasicMaterial({
        color: palette.itemClear, transparent: true, opacity: 0.98, depthWrite: false, toneMapped: false,
      })))
      itemOverlayGroup.add(ghost)
      itemPulse.push(ghost)
      if (shared.has(cell.join(','))) {
        const pip = new THREE.Mesh(blocks.barGeometry, sharedMaterial)
        pip.scale.setScalar(style.blockSize * 0.16)
        pip.position.copy(centre).addScaledVector(normal, style.blockSize * 0.06)
        itemOverlayGroup.add(pip)
      }
    })

    // 4. The anchor: the cell the scope grows FROM (07 §8.6 「靶心标出当前锚点格」). The bomb
    //    and the rocket start here; the hammer's whole scope is this one cell, so it draws the
    //    same pip and nothing else pretends to be a target.
    if (anchor) {
      const pip = new THREE.Mesh(blocks.barGeometry, clearMaterial)
      // The hammer's whole scope IS this cell, so its pip is drawn big enough to read as the
      // target rather than as a marker inside a bigger one.
      pip.scale.setScalar(style.blockSize * (single ? 0.5 : 0.26))
      pip.position.copy(at(anchor.u, anchor.v)).addScaledVector(normal, style.blockSize * 0.05)
      itemOverlayGroup.add(pip)
    }

    // 5. Clipped sides (07 §8.6): two short ticks across the cut edge, so "the scope was cut
    //    here" cannot be misread as "the scope moved inwards to fit".
    const tick = style.blockSize * 0.22
    if (clipped === 'u' || clipped === 'uv') {
      addBar(itemOverlayGroup, at(u1, v0).addScaledVector(vStep, tick), at(u1, v1).addScaledVector(vStep, -tick), thickness * 1.6, clearMaterial)
    }
    if (clipped === 'v' || clipped === 'uv') {
      addBar(itemOverlayGroup, at(u0, v1).addScaledVector(uStep, tick), at(u1, v1).addScaledVector(uStep, -tick), thickness * 1.6, clearMaterial)
    }
  }

  // A quiet pulse on the cells that will actually disappear (07 §8.5.4). Driven from the game's
  // own frame loop; with nothing to pulse it is a no-op, so it costs the common frame nothing.
  const ITEM_PULSE_BASE = 0.94
  const ITEM_PULSE_DEPTH = 0.035
  function pulseItemScope(elapsed) {
    if (!itemPulse.length) return
    const scale = ITEM_PULSE_BASE * (1 + ITEM_PULSE_DEPTH * Math.sin(elapsed * 5.2))
    itemPulse.forEach((marker) => marker.scale.setScalar(scale))
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
    returnPiece,
    ghostReport,
    clearItemOverlay,
    showItemScope,
    pulseItemScope,
  }
}

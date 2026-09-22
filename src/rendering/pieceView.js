// Piece view — the three candidate previews (refactor P4a).
//
// Plan §2 `pieceView.js`: it owns the preview renderers, their scenes, cameras and meshes, the
// map holding them and the read-only projection the headless checks read. It does NOT own the
// hand of pieces (gameSession, P6), the selection or the drag (gameInput, P7), or the slot DOM:
// main keeps that DOM until the input state it reads has moved, and never the other way round.
//
// Why a separate WebGL renderer per slot at all: each candidate is an off-screen scene drawn
// into its own `<canvas>` in the slot card, with its own tone mapping and lights, so the
// thumbnails cannot inherit the board's camera, exposure or post chain. That is deliberate and
// stays: no atlas, no shared context, no instancing (plan §6 P4.5 / §5.3).
//
// Two inputs arrive as getters because both change under the module's feet: the piece objects
// are replaced by every new deal, and the selection is reassigned on every click. `blocks` is a
// plain parameter -- the shared geometry and the shared material factory are built once in main
// and every consumer must be handed the SAME instances (plan §5.3).
import * as THREE from 'three'
import { addToyLights } from './toyLights.js'
import { BOARD_STYLE as style, VFX_CONFIG } from './config.js'

export function createPieceView({ blocks, getCells, getSelectedPiece }) {
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
    previewRenderer.toneMapping = THREE.ACESFilmicToneMapping
    previewRenderer.toneMappingExposure = style.exposure
    previewRenderer.setClearColor(0x000000, 0)

    const previewScene = new THREE.Scene()
    addToyLights(previewScene)

    const previewCamera = new THREE.OrthographicCamera(-2.5, 2.5, 2.2, -2.2, 0.1, 40)
    previewCamera.position.set(2.5, 2.9, 5.4)
    previewCamera.lookAt(0, 0, 0)
    const root = new THREE.Group()
    previewScene.add(root)
    const positions = flatPreviewPositions(getCells(piece))
    const size = new THREE.Box3().setFromPoints(positions.map((p) => p.clone())).getSize(new THREE.Vector3()).addScalar(0.62)
    const baseScale = THREE.MathUtils.clamp(3.2 / Math.max(size.x, size.y, size.z), 0.96, VFX_CONFIG.preview.maxScale)
    root.scale.setScalar(baseScale)
    const outlineColor = new THREE.Color(piece.shape.color).multiplyScalar(0.58)
    const meshes = positions.map((position) => {
      const mesh = new THREE.Mesh(blocks.blockGeometry, blocks.makeMaterial(piece.shape.color))
      mesh.scale.setScalar(0.7)
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
        const usable = Math.max(0.5, 1 - 20 / Math.min(width, height))
        const halfHeight = Math.max(1.6, size.y / (2 * usable), size.x * height / (2 * width * usable))
        const halfWidth = halfHeight * width / height
        preview.camera.left = center.x - halfWidth
        preview.camera.right = center.x + halfWidth
        preview.camera.top = center.y + halfHeight
        preview.camera.bottom = center.y - halfHeight
        preview.camera.updateProjectionMatrix()
      }
      preview.camera.position.set(2.5, 2.9, 5.4)
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

  return {
    flatPreviewPositions,
    disposePiecePreviews,
    createPiecePreview,
    updatePieceSlotSelection,
    updatePiecePreviews,
    candidateFrames,
  }
}

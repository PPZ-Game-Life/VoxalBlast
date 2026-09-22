// Shared block geometry and materials — one owner for the resources the board, the
// candidate slots, the drag ghost and the item overlays all draw with.
//
// Refactor P2a (temp/VoxalBlast-渐进式模块拆分重构执行计划.md §2 `blockResources.js`).
// Why this module exists at all: `boardView`, `pieceView` and `effects` all need the same
// rounded cube and the same three-material family. Without one owner they end up importing
// each other for it, and — worse — whichever one clears its preview first disposes the
// geometry the board is still drawing. So creation AND ownership live here, and the
// `sharedGeometries` list is what the dispose path consults before freeing anything.
//
// What is shared, and why it must not be disposed per-consumer:
//   * ONE `blockGeometry` for every block everywhere. The comment that used to sit on this
//     line in main.js said it best: "a piece in the hand and a piece on the board are
//     literally the same object". 98 board tiles, 3 candidate previews × their cells, the
//     drag ghost and the landing marker all reference this single instance.
//   * ONE `edgeGeometry` (the outline) reused by the tray, the ghost and the marker.
//   * `blockWoodMaterials`: one material per (idle|active × tone step). A tile swaps a
//     MATERIAL, never a geometry.
//   * `paintMaterial(color, variant)`: a cache of the paint per colour+variant, so two
//     cells of the same colour are the same material instance.
//
// `createBlockResources({ cubeBody })` is a factory rather than module-level singletons for
// one concrete reason: `blockSurfaceMaps()` builds CanvasTextures, so constructing these
// touches the document. Doing it at ESM evaluation time would make the module's import
// order load-bearing; doing it inside main's explicit setup keeps the timing visible.
import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import { BOARD_STYLE as style } from './config.js'
import { blockSurfaceMaps } from './woodTexture.js'

export function createBlockResources({ cubeBody }) {
  // THE block. ONE geometry instance shared by the board's 98 blocks, the three candidate
  // slots and the drag ghost, so a piece in the hand and a piece on the board are literally
  // the same object — same size, same six flat faces, same bevel.
  const blockGeometry = new RoundedBoxGeometry(
    style.blockSize, style.blockSize, style.blockSize, style.blockSegments, style.blockRadius,
  )

  // One material per (state × tone step): the idle timber and the lighter timber of the
  // face under the camera. A small cache shares the three surface variants.
  function blockWoodMaterial(baseColor, step, variant) {
    return new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(baseColor).multiplyScalar(step),
      ...blockSurfaceMaps(false, variant),
      bumpScale: style.woodBumpScale,
      roughness: style.woodRoughness,
      clearcoat: style.woodClearcoat,
      clearcoatRoughness: style.woodClearcoatRoughness,
      metalness: 0,
    })
  }
  const BLOCK_TONES = style.blockToneSteps.length
  const blockWoodMaterials = style.blockToneSteps.map((step, variant) => ({
    idle: blockWoodMaterial(style.blockColor, step, variant),
    active: blockWoodMaterial(style.blockActiveColor, step, variant),
  }))

  // A piece in the hand is PAINTED WOOD: opaque colour over the same grain the shell uses,
  // with a real varnish layer on top. The shared grain map is what ties the board to the
  // signboards — the UI and the cube are visibly the same material (05「同源」), and a piece
  // keeps this exact material from the tray, through the drag, onto the board.
  function makeMaterial(color, opacity = 1, variant = 0) {
    return new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(color),
      ...blockSurfaceMaps(true, variant),
      bumpScale: style.paintBumpScale,
      roughness: style.paintRoughness,
      clearcoat: style.paintClearcoat,
      clearcoatRoughness: style.paintClearcoatRoughness,
      metalness: 0,
      transparent: opacity < 1,
      opacity,
    })
  }

  const paintMaterials = new Map()
  function paintMaterial(color, variant = 0) {
    const key = `${color}:${variant % 3}`
    if (paintMaterials.has(key)) return paintMaterials.get(key)
    const material = makeMaterial(color, 1, variant)
    paintMaterials.set(key, material)
    return material
  }

  // A cube whose 98 blocks are all one flat colour looks like ONE moulded crate; the
  // reference is visibly assembled from separate pieces of timber. So every block gets its
  // own tone step, picked from a deterministic hash of its lattice cell — deterministic
  // because the grain must be identical on every load, or two screenshots of the same build
  // would not compare.
  function toneIndexFor(x, y, z) {
    const hash = (x * 73856093) ^ (y * 19349663) ^ (z * 83492791)
    return Math.abs(hash) % BLOCK_TONES
  }

  const edgeGeometry = new THREE.EdgesGeometry(blockGeometry)

  // The resources a node may be holding WITHOUT owning. `disposeNode()` checks this list
  // before freeing a geometry, which is what stops a cleared candidate preview or drag
  // ghost from taking the board's blocks down with it. `cubeBody.geometry` is the board's
  // own hull and belongs to its creator, so it is listed here too.
  const sharedGeometries = [blockGeometry, cubeBody.geometry]

  return {
    blockGeometry,
    edgeGeometry,
    blockWoodMaterials,
    paintMaterial,
    makeMaterial,
    toneIndexFor,
    sharedGeometries,
  }
}

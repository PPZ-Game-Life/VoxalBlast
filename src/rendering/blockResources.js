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
// `createBlockResources({ metrics })` is a factory rather than module-level singletons for
// one concrete reason: it builds GPU resources and reads `metrics()`, which is only settled
// once the scene exists. Doing it at ESM evaluation time would make the module's import order
// load-bearing; doing it inside main's explicit setup keeps the timing visible.
//
// v0.13.0 「浮空积木世界」: neither family wears a surface map any more (handoff §4.2), so
// the factory no longer touches the document at all. The reason above is kept because the
// ordering constraint it describes still governs every consumer of this module.
//
// Since refactor P9 it also creates the cube's opaque timber BODY (the shell behind the 98
// blocks), because that is a geometry + material pair and main must create neither (plan §8).
// `metrics()` hands it the lattice half-side lazily, the same way gameScene gets its own.
import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import { BOARD_STYLE as style, GEM_STYLE } from './config.js'
import { referencePaintColor } from './referencePalette.js'
import { toyEnvironment } from './toyLights.js'
import { GemMaterial, clampGemSettings } from './gemMaterial.js'

export function createBlockResources({ metrics }) {
  const livePaintMaterials = new Set()
  let gemTuning = { ...GEM_STYLE }
  const paintTuning = { roughness: style.paintRoughness, envMapIntensity: style.paintEnvMapIntensity, metalness: style.paintMetalness }
  // THE block. ONE geometry instance shared by the board's 98 blocks, the three candidate
  // slots and the drag ghost, so a piece in the hand and a piece on the board are literally
  // the same object — same size, same six flat faces, same bevel.
  const blockGeometry = new RoundedBoxGeometry(
    style.blockSize, style.blockSize, style.blockSize, style.blockSegments, style.blockRadius,
  )

  // Opaque shell behind the blocks. The shell is only a BACKING: it occludes the far faces and
  // fills the narrow notches between blocks (which is why it is darker than they are). It is
  // inset behind them so that the blocks — not the shell — make up the surface of the big cube.
  // It is NOT one of the shared block geometries: it is one mesh for the whole cube, and main
  // adds it to the cube group (the child order there is load-bearing).
  //
  // v0.13.0 (handoff §4.1/§4.2): the shell keeps its role and loses its timber. The grain map
  // is gone with the block maps, so the notches are now flat `hull` (#243A4A) rather than a
  // dark brown groove — the handoff's 缝隙/背壳 colour. What used to make a block readable was
  // the seam; it still is.
  const cubeSide = metrics().cubeSide
  const cubeBodyMaterial = new THREE.MeshPhysicalMaterial({
    color: style.hullColor,
    roughness: style.hullRoughness,
    clearcoat: style.hullClearcoat,
    clearcoatRoughness: 0.42,
    metalness: 0,
    envMapIntensity: style.woodEnvMapIntensity,
    envMap: toyEnvironment(),
    transparent: false,
    opacity: style.hullOpacity,
    depthWrite: true,
  })
  const cubeBody = new THREE.Mesh(
    new RoundedBoxGeometry(cubeSide - style.hullInset, cubeSide - style.hullInset, cubeSide - style.hullInset, 3, style.hullRadius),
    cubeBodyMaterial,
  )
  cubeBody.renderOrder = -2
  cubeBody.castShadow = false
  cubeBody.receiveShadow = true

  // One material per (state × tone step): the idle bare block and the lighter one on the face
  // under the camera.
  //
  // v0.13.0 (handoff §4.2): NO surface maps on either family. The timber skin bought its read
  // from a colour/roughness/normal/AO canvas set, and the handoff is explicit that turning the
  // colour to cream while the maps keep multiplying the roughness does not remove the wood —
  // so the maps are switched off together and the response is the recipe's flat table. What is
  // left is real shading: one broad soft gloss from the key light across the bevel, and a
  // face that visibly changes tone when the cube is really turned.
  function blockWoodMaterial(baseColor, step) {
    return new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(baseColor).multiplyScalar(step),
      envMapIntensity: style.woodEnvMapIntensity,
      // r172 overrides material.envMapIntensity with scene.environmentIntensity
      // when envMap is null. Bind the shared source so per-family tuning works.
      envMap: toyEnvironment(),
      roughness: style.woodRoughness,
      clearcoat: style.woodClearcoat,
      clearcoatRoughness: style.woodClearcoatRoughness,
      specularIntensity: style.woodSpecularIntensity,
      ior: style.woodIor,
      metalness: 0,
    })
  }
  const BLOCK_TONES = style.blockToneSteps.length
  const blockWoodMaterials = style.blockToneSteps.map(step => ({
    idle: blockWoodMaterial(style.blockColor, step),
    active: blockWoodMaterial(style.blockActiveColor, step),
  }))

  // Opaque saturated lacquer. Metalness stays 0: this is a painted dielectric lit by the same
  // rig as the shell, not a metal and not a gem. A piece keeps this exact material from the tray,
  // through the drag, onto the board.
  function makeMaterial(color, opacity = 1, variant = 0) {
    const material = new GemMaterial({
      color: new THREE.Color(referencePaintColor(color)),
      ior: style.paintIor,
      roughness: style.paintRoughness,
      clearcoat: style.paintClearcoat,
      clearcoatRoughness: style.paintClearcoatRoughness,
      // Keep frontal lacquer saturated; strong white environment reflections
      // otherwise turn emerald and blue into pastel tiles at thumbnail scale.
      specularIntensity: style.paintSpecularIntensity,
      envMapIntensity: style.paintEnvMapIntensity,
      envMap: toyEnvironment(),
      metalness: style.paintMetalness,
      ...paintTuning,
      transparent: opacity < 1,
      opacity,
    })
    material.setVolume(gemTuning)
    livePaintMaterials.add(material)
    material.addEventListener('dispose', () => livePaintMaterials.delete(material))
    return material
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

  // A plain unit box, scaled per bar by rendering/pieceView.js to draw an item's scope frame
  // (07 §8.5.4/§8.6: 「细实线/低透明填充表示完整作用域」 and 「边框沿棋格画成方形/透视四边形，
  // 并保留内部分格」). It is deliberately NOT `blockGeometry`: a frame drawn out of bevelled
  // blocks at a 0.03-cell thickness reads as a row of pebbles instead of a ruled line. Like the
  // block, it is shared and listed below, so tearing an overlay down never frees it.
  const barGeometry = new THREE.BoxGeometry(1, 1, 1)

  // The resources a node may be holding WITHOUT owning. `disposeNode()` checks this list
  // before freeing a geometry, which is what stops a cleared candidate preview or drag
  // ghost from taking the board's blocks down with it. `cubeBody.geometry` is the board's
  // own hull and belongs to its creator, so it is listed here too.
  const sharedGeometries = [blockGeometry, cubeBody.geometry, barGeometry]

  // Read-out for the moved introspection block (diagnostics only assembles): the triangle
  // count of THE shared block geometry, so a check can prove the block is still the same
  // bevelled box it always was.
  function report() {
    return {
      trianglesPerBlock: blockGeometry.attributes.position.count / 3,
      size: style.blockSize, radius: style.blockRadius,
      wood: { roughness: style.woodRoughness, envMapIntensity: style.woodEnvMapIntensity, specularIntensity: style.woodSpecularIntensity, ior: style.woodIor },
      paint: { ...paintTuning },
      polish: { clearcoat: style.paintClearcoat, clearcoatRoughness: style.paintClearcoatRoughness, ior: style.paintIor, crownHeight: style.paintCrownHeight },
      gem: { model: 'local-thickness-scattering', settings: { ...gemTuning }, materials: livePaintMaterials.size,
        singlePass: [...livePaintMaterials].every(material => material.transmission === 0) },
      // v0.13.0: the empty cell and the paint are UNTEXTURED (§4.2 — a flat uniform roughness
      // for the first A/B, so a retuned roughness number is the roughness the shader sees).
      // The list stays so a check can prove no albedo/normal/roughness/AO map came back.
      textureChannels: [],
      environmentBound: [...livePaintMaterials, ...blockWoodMaterials.flatMap(pair => Object.values(pair))]
        .every(material => material.envMap === toyEnvironment()),
    }
  }

  // DEV diagnostics calls this; only numeric material uniforms change. Cached
  // and future paint share the same tuning, with no new textures or programs.
  function tuneMaterials({ paint = {}, wood = {} } = {}) {
    for (const [family, values] of [['paint', paint], ['wood', wood]]) {
      for (const key of ['roughness', 'envMapIntensity', 'metalness']) {
        if (!Number.isFinite(values[key])) continue
        const value = THREE.MathUtils.clamp(values[key], key === 'roughness' ? 0.08 : 0, key === 'envMapIntensity' ? 2 : 1)
        if (family === 'paint') {
          paintTuning[key] = value
          for (const material of livePaintMaterials) material[key] = value
        } else for (const pair of blockWoodMaterials) for (const material of Object.values(pair)) material[key] = value
      }
    }
    return report()
  }

  function tuneGem(values = {}) {
    gemTuning = clampGemSettings(values, gemTuning)
    for (const material of livePaintMaterials) material.setVolume(gemTuning)
    return { ...gemTuning }
  }

  return {
    blockGeometry,
    edgeGeometry,
    barGeometry,
    // The shell mesh itself, for main to add to the cube group (see the note above).
    cubeBody,
    report,
    tuneMaterials,
    tuneGem,
    blockWoodMaterials,
    paintMaterial,
    makeMaterial,
    toneIndexFor,
    sharedGeometries,
  }
}

// Impact feedback v2 — the asset half (PLACEMENT_IMPACT_FEEDBACK_HANDOFF.md §5.1, §8.1).
//
// This module owns ONE question: what did the shipped pack actually give us, in the units the
// runtime draws in. It fetches the sequences' metadata, applies the pack's OWN normalization
// contract and loads the three cube variants. It draws nothing and knows nothing about a clear.
//
// The contract it encodes, in the pack's own words (ASSETS.md):
//
//   * `normalization.unionAlphaBounds` is the fixed reference box for the WHOLE clip. Layout,
//     scale, clipping and pivot all come from it, and `frames[].contentAlphaBoundsMeasuredOnly`
//     is never used to rescale or recenter — a per-frame compensation would erase the very
//     expansion the endpoint burst and the tap ring are made of.
//   * the pivot is a PIXEL coordinate inside the frame (`headAnchorLocalPx`), not the geometric
//     centre of the transparent tile, so a mirror/rotate happens around it.
//   * the GLBs are single-primitive, vertex-coloured, centre-pivoted 1×1×1 models: the runtime
//     scales by `cellPitch * visibleEdgeCells` and shares geometry/material per variant.
//
// Everything here is read-only and failure-tolerant: a missing file sets a status and an error
// string, and the caller falls back to the v1 underlay rather than blocking a placement.
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { IMPACT_FEEDBACK } from './config.js'

function assetUrl(relative) {
  const base = import.meta.env?.BASE_URL || '/'
  return `${base.endsWith('/') ? base : `${base}/`}${IMPACT_FEEDBACK.dir}${relative}`
}

/**
 * The pack's normalization, in world units.
 *
 * `visibleWidthWorld` / `visibleHeightWorld` are how big the UNION box should be on screen — the
 * caller supplies them because only it knows whether it is stating a cell size (the sweep's
 * `1.4 × 0.65` cells) or a CSS pixel size. Everything else is derived from the sheet's own pixels,
 * so the quad's transparent margin is included in the world size instead of being clipped off.
 */
export function sequenceMetrics(meta, { visibleWidthWorld, visibleHeightWorld }) {
  const [frameWidth, frameHeight] = meta.layout.frameSize
  const [left, top, right, bottom] = meta.normalization.unionAlphaBounds
  const unionWidth = Math.max(1, right - left)
  const unionHeight = Math.max(1, bottom - top)
  const frameWorldWidth = visibleWidthWorld * (frameWidth / unionWidth)
  const frameWorldHeight = visibleHeightWorld * (frameHeight / unionHeight)
  const pivotPx = meta.frames[0]?.pivot || meta.placement?.headAnchorNormalized || [0.5, 0.5]
  // The pivot as a fraction of the FRAME (the JSON states it normalized to the frame already, but
  // a pack that gives pixels — `headAnchorLocalPx` — must land in the same place).
  const pivot = [pivotPx[0], pivotPx[1]]
  const columns = meta.layout.columns
  const rows = meta.layout.rows
  return {
    id: meta.id,
    columns,
    rows,
    frameWidth,
    frameHeight,
    sheetWidth: meta.sheetSize[0],
    sheetHeight: meta.sheetSize[1],
    frameWorldWidth,
    frameWorldHeight,
    unionWidth,
    unionHeight,
    visibleWidthWorld,
    visibleHeightWorld,
    // Offset of the pivot from the FRAME's own centre, in world units. A quad is placed so that
    // this point — not the quad's middle — is on the branch head (ASSETS 「固定 head pivot」).
    pivotOffsetX: (pivot[0] - 0.5) * frameWorldWidth,
    pivotOffsetY: (0.5 - pivot[1]) * frameWorldHeight,
    // uv of one frame inside the sheet, in the row-order the pack numbered (left to right, top to
    // bottom). `flipY` is TRUE on the textures below, which is what makes v=1 the image's top row.
    frameUv: (index) => {
      const column = index % columns
      const row = Math.floor(index / columns)
      return {
        u0: column / columns,
        u1: (column + 1) / columns,
        v0: 1 - (row + 1) / rows,
        v1: 1 - row / rows,
      }
    },
    frames: (meta.frames || []).map((frame) => ({
      index: frame.index,
      durationMs: frame.durationMs,
      interval: frame.travelProgressInterval || null,
      measuredBounds: frame.contentAlphaBoundsMeasuredOnly || null,
      uv: frame.uvTopLeft || null,
    })),
    totalDurationMs: (meta.frames || []).reduce((sum, frame) => sum + (frame.durationMs || 0), 0),
    declaredTotalDurationMs: meta.playback?.totalDurationMs ?? null,
    reducedFrameIndex: meta.reducedMotion?.frameIndex ?? null,
    reducedHoldMs: meta.reducedMotion?.holdMs ?? null,
    // The pack's own cross-check that we read the fixed box rather than a per-frame one.
    unionIsReference: JSON.stringify(meta.normalization.unionAlphaBounds) === JSON.stringify(meta.normalization.referenceAlphaBounds),
    placement: meta.placement || null,
    playback: meta.playback || null,
  }
}

function configureTexture(texture) {
  texture.colorSpace = THREE.SRGBColorSpace
  texture.flipY = true
  texture.generateMipmaps = false
  texture.minFilter = THREE.LinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.wrapS = THREE.ClampToEdgeWrapping
  texture.wrapT = THREE.ClampToEdgeWrapping
  texture.premultiplyAlpha = false
  texture.needsUpdate = true
  return texture
}

export function createImpactAssets() {
  const state = {
    status: 'idle', // idle | loading | ready | failed
    error: null,
    recipe: null,
    sequences: {}, // id -> { texture, metrics, meta }
    cubes: {}, // id -> { geometry, material, box, node, primitives, hasVertexColors }
    loadedAt: null,
    failures: [],
  }

  async function fetchJson(relative) {
    const response = await fetch(assetUrl(relative))
    if (!response.ok) throw new Error(`${relative}: HTTP ${response.status}`)
    return response.json()
  }

  function loadTexture(relative) {
    return new Promise((resolve, reject) => {
      new THREE.TextureLoader().load(
        assetUrl(relative),
        (texture) => resolve(configureTexture(texture)),
        undefined,
        (error) => reject(error instanceof Error ? error : new Error(`${relative}: image load failed`)),
      )
    })
  }

  /**
   * §8.1 「运行资源必须为单primitive并使用vertexColors表达选定颜色变体；同颜色实例共享geometry/
   * material」. The loader hands back the ONE geometry and ONE material, plus the facts the asset
   * gate has to report (primitive count, whether COLOR_0 really arrived, the model's own bbox) —
   * because 「只证明文件能load不算姿态门通过」.
   */
  async function loadCube(entry) {
    const loader = new GLTFLoader()
    const gltf = await loader.loadAsync(assetUrl(entry.file))
    const node = gltf.scene.getObjectByName(entry.node)
      || gltf.scene.children.find((child) => child.isMesh)
    if (!node) throw new Error(`${entry.file}: node ${entry.node} is missing`)
    const mesh = node.isMesh ? node : node.children.find((child) => child.isMesh)
    if (!mesh) throw new Error(`${entry.file}: no mesh under ${entry.node}`)
    mesh.geometry.computeBoundingBox()
    const box = mesh.geometry.boundingBox.clone()
    const primitives = mesh.isMesh ? 1 : 0
    const hasVertexColors = Boolean(mesh.geometry.getAttribute('color'))
    const hasNormals = Boolean(mesh.geometry.getAttribute('normal'))
    // The material the pack shipped is the ONE the instances share; `vertexColors` must be on or
    // COLOR_0 would be ignored and every variant would draw white.
    const material = mesh.material
    material.vertexColors = hasVertexColors
    material.needsUpdate = true
    material.depthWrite = false
    material.toneMapped = false
    return {
      id: entry.id,
      geometry: mesh.geometry,
      material,
      box,
      node: mesh.name,
      primitives,
      hasVertexColors,
      hasNormals,
      localEdge: Math.max(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z),
      indexCount: mesh.geometry.index ? mesh.geometry.index.count : 0,
      vertexCount: mesh.geometry.getAttribute('position')?.count || 0,
    }
  }

  async function load() {
    if (state.status === 'loading' || state.status === 'ready') return state.status
    state.status = 'loading'
    try {
      state.recipe = await fetchJson(IMPACT_FEEDBACK.recipe)
    } catch (error) {
      state.failures.push(`recipe: ${error.message}`)
    }
    const recipe = state.recipe
    // The sweep's world size is stated in CELLS by the recipe; the endpoint burst has no cell
    // figure of its own, so it takes the sweep's visible height as its own reference box (a burst
    // is the same brush's punctuation, not a second art direction).
    const sweepVisibleHeight = recipe?.sweep?.visibleHeightCells ?? 0.65
    const sweepVisibleWidth = recipe?.sweep?.lengthCells ?? 1.4
    const popVisible = sweepVisibleHeight * 1.55

    const wanted = [
      { key: 'sweep', meta: IMPACT_FEEDBACK.sweep, visibleWidthWorld: sweepVisibleWidth, visibleHeightWorld: sweepVisibleHeight },
      { key: 'endpointPop', meta: IMPACT_FEEDBACK.endpointPop, visibleWidthWorld: popVisible, visibleHeightWorld: popVisible },
      { key: 'tap', meta: IMPACT_FEEDBACK.tap, visibleWidthWorld: popVisible, visibleHeightWorld: popVisible },
    ]
    await Promise.all(wanted.map(async (entry) => {
      try {
        const [meta, texture] = await Promise.all([fetchJson(entry.meta.json), loadTexture(entry.meta.image)])
        state.sequences[entry.key] = {
          meta,
          texture,
          metrics: sequenceMetrics(meta, entry),
        }
      } catch (error) {
        state.failures.push(`${entry.key}: ${error.message}`)
      }
    }))
    await Promise.all(IMPACT_FEEDBACK.cubes.map(async (entry) => {
      try {
        state.cubes[entry.id] = await loadCube(entry)
      } catch (error) {
        state.failures.push(`cube ${entry.id}: ${error.message}`)
      }
    }))

    const missing = ['sweep', 'endpointPop'].filter((key) => !state.sequences[key])
    if (missing.length || Object.keys(state.cubes).length === 0) {
      // §8.1: a partial pack may not half-draw. The sweep and the endpoint burst are the round's
      // subject, so their absence fails the whole layer and the v1 underlay stays in charge; a
      // missing cube colour alone is not fatal (low power drops pink on purpose).
      state.status = 'failed'
      state.error = `missing: ${missing.join(', ') || 'none'}; cubes: ${Object.keys(state.cubes).join(',') || 'none'}`
      return state.status
    }
    state.status = 'ready'
    state.loadedAt = performance.now()
    return state.status
  }

  return {
    load,
    status: () => state.status,
    error: () => state.error,
    recipe: () => state.recipe,
    sequence: (key) => state.sequences[key] || null,
    cube: (id) => state.cubes[id] || null,
    reports: () => state,
  }
}

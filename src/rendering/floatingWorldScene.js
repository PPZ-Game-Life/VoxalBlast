// 「浮空积木世界」的实景层 —— R4.
//
// docs/Technical/FLOATING_WORLD_VISUAL_CORRECTION_HANDOFF.md §4 is the specification this file
// implements, and docs/Art/floating-world-v1/approved-concept-v4.png is the picture it is
// measured against. The one thing it is built to produce is §4.2's three layers, and the one
// thing it is built to RETIRE is a painted backdrop:
//
//   far   a real sky gradient plus separate cloud shapes that actually drift;
//   mid   low-saturation block arches / stairs / ledges and wall segments at the sides, plus a
//         few loose floating blocks whose bottoms are visible;
//   near  the cream plaza floor across the lower half, restrained paving lines, and larger
//         block masses the frame crops at both edges.
//
// Why it is a scene-graph module and not CSS: §7 requires the blocks to be REAL, LIT meshes that
// move. The valley this correction retires was a DOM layer with a webp in it, which is exactly
// why it kept winning — nothing in the render had to change for it to stay on screen.
//
// Layer discipline (the R3 contract): every object here lives on layer 2 and ONLY layer 2.
// gameScene's render camera enables 0/1/2 while its normal prepass keeps only 0, so scenery never
// enters the board's contact shading and is never pickable. Layers filter visibility; they DO NOT
// override depth ordering in the beauty pass. The projected board keep-out below is therefore the
// mechanism that prevents a nearer decorative mesh from covering live cells. §4.2's「背景物体不
// 拾取、不挂 cubeGroup、不随玩家翻盘」 remains enforced by the layer mask.
//
// The recipe is the art-facing knob file (floatingWorld.js is its only reader). Composition
// numbers — plaza bounds, per-band depths, anchors — live in `scene.recipe.json`'s `world`
// section so Luna can retune them without touching this file; nothing here re-types a palette
// value.
import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import { floatingWorldRecipe as recipe, floatingWorldPalette as palette } from './floatingWorld.js'

// 0 = the board and its effects, 1 = shadow-only receivers (boardShadows), 2 = the world.
// Enabling it is gameScene's job; this module only ever asserts the mask it owns.
const SCENERY_LAYER = 2
const WORLD_LAYER_MASK = 1 << SCENERY_LAYER

const hex = (value) => Number.parseInt(String(value).replace(/^#/, ''), 16)
const degrees = (value) => THREE.MathUtils.degToRad(Number(value) || 0)

// One scratch set for the whole module. The layout solve runs per layout change and the motion
// runs per frame; none of these values outlives the call that made it.
const _dir = new THREE.Vector3()
const _point = new THREE.Vector3()
const _corner = new THREE.Vector3()
const _matrix = new THREE.Matrix4()
const _quaternion = new THREE.Quaternion()
const _euler = new THREE.Euler()
const _centre = new THREE.Vector3()
const _box = new THREE.Box3()
// Only the board-shadow solve uses this one; see its call site for why it must not share `_point`.
const _shadowDir = new THREE.Vector3()

// `getRenderQuality()` ships two tiers (`lowPower`); the recipe names three. Mapping to the
// nearest is deliberate and documented rather than inventing a third tier here.
const tierFor = (quality) => (quality?.lowPower ? recipe.quality.low : recipe.quality.high)

function prepareTexture(texture, anisotropy) {
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = anisotropy
  return texture
}

// The plaza's paving pattern. A canvas texture, not a shipped image: the procedural-render
// baseline allows generated textures, and a paving grid is four lines.
function pavingTexture(spec) {
  const size = 128
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = spec.top
  ctx.fillRect(0, 0, size, size)
  ctx.strokeStyle = spec.line
  ctx.lineWidth = Math.max(1, Math.round(size * spec.lineWidth))
  ctx.beginPath()
  ctx.moveTo(0.5, 0)
  ctx.lineTo(0.5, size)
  ctx.moveTo(0, 0.5)
  ctx.lineTo(size, 0.5)
  ctx.stroke()
  const texture = new THREE.CanvasTexture(canvas)
  texture.wrapS = THREE.RepeatWrapping
  texture.wrapT = THREE.RepeatWrapping
  return prepareTexture(texture, 4)
}

// A rounded rectangle in the shape's own XY plane, from explicit world-z bounds: after
// `rotateX(-90°)` the shape's +y axis points down world −z, so the far edge is the shape's
// topmost edge. Getting this backwards flips the plaza behind the camera and the frame shows
// nothing but sky, so the mapping is stated here rather than left implicit.
function plazaShape(halfX, zFar, zNear, cornerRadius) {
  const y0 = -zNear
  const y1 = -zFar
  const r = Math.min(cornerRadius, halfX, (y1 - y0) / 2)
  const shape = new THREE.Shape()
  shape.moveTo(-halfX + r, y0)
  shape.lineTo(halfX - r, y0)
  shape.quadraticCurveTo(halfX, y0, halfX, y0 + r)
  shape.lineTo(halfX, y1 - r)
  shape.quadraticCurveTo(halfX, y1, halfX - r, y1)
  shape.lineTo(-halfX + r, y1)
  shape.quadraticCurveTo(-halfX, y1, -halfX, y1 - r)
  shape.lineTo(-halfX, y0 + r)
  shape.quadraticCurveTo(-halfX, y0, -halfX + r, y0)
  return shape
}

export function createFloatingWorld({ scene, quality, getCamera, getCanvasRect, getKeepOutRects, getBoardScreenBox }) {
  const world = recipe.world
  const paletteColor = (name) => new THREE.Color(palette[name] ?? 0xffffff)

  const group = new THREE.Group()
  group.name = 'floating-world'
  group.layers.set(SCENERY_LAYER)
  scene.add(group)

  // ---- Sky (far layer) ----------------------------------------------------------
  //
  // A gradient sphere, NOT `scene.background = new Color(...)`: §4.2's far layer is 蓝天, and a
  // flat fill reads as the blue test card the correction explicitly rejects. It is fixed at the
  // world origin and the gradient is measured from `cameraPosition`, so the camera may sit ~65
  // units off-centre inside it without the gradient sliding — which is why nothing here chases
  // the camera per frame.
  //
  // `depthWrite:false` + a very negative `renderOrder`: it is a background, so it draws first
  // and lets everything else paint over it, including the transparent art shadow on the plaza.
  const skyMaterial = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
    uniforms: {
      uTop: { value: paletteColor('skyTop') },
      uBottom: { value: paletteColor('skyBottom') },
      uHorizon: { value: world.sky.horizon },
      uZenith: { value: world.sky.zenith },
    },
    vertexShader: `
      varying vec3 vFromCamera;
      void main() {
        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        vFromCamera = worldPosition.xyz - cameraPosition;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 uTop;
      uniform vec3 uBottom;
      uniform float uHorizon;
      uniform float uZenith;
      varying vec3 vFromCamera;
      void main() {
        float height = normalize(vFromCamera).y;
        gl_FragColor = vec4(mix(uBottom, uTop, smoothstep(uHorizon, uZenith, height)), 1.0);
      }
    `,
  })
  const sky = new THREE.Mesh(new THREE.SphereGeometry(world.sky.radius, 32, 16), skyMaterial)
  sky.renderOrder = -1000
  sky.frustumCulled = false
  sky.layers.set(SCENERY_LAYER)
  sky.name = 'floating-world-sky'
  group.add(sky)

  // ---- Plaza (near layer) -------------------------------------------------------
  //
  // A finite slab whose TOP sits just under the board's own ground plane
  // (`lighting.shadow.floorY`), so the art shadow the board casts lands ON the plaza instead of
  // being buried under it — the two are coplanar by design, and the 2 cm of clearance is what
  // keeps the shadow decal on top of the floor rather than fighting it for the same depth.
  //
  // The far edge is solved from a SCREEN position, not typed in world units. With the shipped
  // FOV the camera looks ~12° down and sits only ~16 world units above that plane, so where the
  // ground ends is what decides how much sky the frame gets — and the world z that puts the edge
  // at a given screen height moves with every viewport. `horizonNdc` is therefore the knob
  // (the recipe's 遠層/近層 split), and `solveGroundZ` turns it into world units through the
  // render camera the frame is actually drawn with.
  const plazaSpec = { halfX: world.plaza.halfWidth, zFar: world.plaza.zFar, zNear: world.plaza.zNear }
  const plazaFloorY = recipe.lighting.shadow.floorY - 0.02
  const plazaTop = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: pavingTexture(world.plaza),
    roughness: recipe.materials.background.roughness,
    metalness: recipe.materials.background.metalness,
    envMapIntensity: recipe.materials.background.envMapIntensity,
  })
  const plazaSide = new THREE.MeshStandardMaterial({
    color: hex(world.plaza.side),
    roughness: 0.92,
    metalness: 0,
    envMapIntensity: recipe.materials.background.envMapIntensity,
  })

  // The plaza's mesh is rebuilt whenever the solved bounds move, which happens on a layout
  // change and at no other time. A decorated slab was the alternative; regenerating four
  // hundred vertices per resize is cheaper and cannot drift out of step with the bounds.
  const plaza = new THREE.Mesh(new THREE.BufferGeometry(), [plazaTop, plazaSide])
  // `ExtrudeGeometry` puts one cap at z = 0 and the other at z = depth, and the rotation above
  // maps +z to +y — so the slab's TOP surface is the far cap, `world.plaza.thickness` above the
  // mesh's own origin. The origin is therefore dropped by exactly the thickness, which is what
  // lands the surface on `floorY`; leaving it there put the floor 1.2 units too high and buried
  // the board's art shadow inside the slab (invisible, and with no visual clue why).
  plaza.position.y = plazaFloorY - world.plaza.thickness
  plaza.layers.set(SCENERY_LAYER)
  plaza.name = 'floating-world-plaza'
  plaza.frustumCulled = false
  group.add(plaza)

  function buildPlaza(zFar, zNear) {    const geometry = new THREE.ExtrudeGeometry(plazaShape(plazaSpec.halfX, zFar, zNear, world.plaza.cornerRadius), {
      depth: world.plaza.thickness,
      bevelEnabled: false,
      curveSegments: 8,
    })
    // ExtrudeGeometry extrudes along +Z from the shape's XY plane; this rotation puts the cap
    // face up (top at local y = 0) and hangs the slab's body below it.
    geometry.rotateX(-Math.PI / 2)
    // The caps carry the shape's own XY as UVs, so one repeat per `tile` world units is exact
    // and independent of the slab's dimensions.
    plazaTop.map.repeat.set(1 / world.plaza.tile, 1 / world.plaza.tile)
    plazaTop.map.needsUpdate = true
    plaza.geometry.dispose()
    plaza.geometry = geometry
    plazaSpec.zFar = zFar
    plazaSpec.zNear = zNear
  }

  // Where does a ray through this NDC height meet the plaza's own plane? The answer is returned
  // in the PLAZA'S local z (which runs along the camera's ground bearing, not world z), because
  // that is the coordinate the slab's shape is authored in. `null` when the ray points at or
  // above the horizon and never comes down — the honest answer, and one a caller must not
  // silently treat as zero.
  function solveGroundZ(camera, ndcY) {
    ndcPoint(camera, _point, 0, ndcY, 1).sub(camera.position).normalize()
    if (_point.y >= -1e-4) return null
    const t = (plazaFloorY - camera.position.y) / _point.y
    if (!(t > 0) || !Number.isFinite(t)) return null
    const bearing = plaza.rotation.y
    const x = camera.position.x + _point.x * t
    const z = camera.position.z + _point.z * t
    return x * Math.sin(bearing) + z * Math.cos(bearing)
  }

  // The camera sits somewhere on the plaza, so the NEAR edge only has to be far enough past the
  // frame's bottom to never be seen: -1.4 NDC is one fifth of a frame below the bottom edge.
  const NEAR_EDGE_NDC = -1.4
  // Until the first layout solve the mesh needs SOME geometry — an empty BufferGeometry would
  // render a plaza that is not there, and the first frame is graded.
  buildPlaza(world.plaza.zFar, world.plaza.zNear)

  // ---- The board's art soft shadow (§6.4) ---------------------------------------
  //
  // 「本次明确的美术裁决：不接受『桌面没有投影也算完成』」. The real shadow map is a quality-tier
  // feature (`realBoardShadow`), so on every phone-sized viewport there is no cast shadow at all
  // — and the blob the G1 prototype left behind is a ShadowMaterial, which draws NOTHING without
  // one. §6.4 therefore authorises a procedural soft ellipse on all tiers for C1, and this is it.
  //
  // It is a designed SPACE CUE, not a physically accurate shadow: its anchor is solved from where
  // the resting board's silhouette lands on screen, cast back onto the plaza by a real ray
  // intersection — so it can never end up as a screen-space smudge pasted over the UI, and it
  // moves with the camera instead of with the board's rotation. Solved on layout only, never per
  // frame, so it cannot jitter with the board's bob.
  const shadowSpec = world.boardShadow
  const shadowTexture = (() => {
    const size = 256
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')
    const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
    // Four stops rather than two: the falloff is what reads as "soft", and a linear ramp reads
    // as a hard-edged disc under a board this size.
    gradient.addColorStop(0, 'rgba(0,0,0,0.95)')
    gradient.addColorStop(0.42, 'rgba(0,0,0,0.62)')
    gradient.addColorStop(0.74, 'rgba(0,0,0,0.22)')
    gradient.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, size, size)
    return prepareTexture(new THREE.CanvasTexture(canvas), 2)
  })()
  const boardShadow = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({
      color: hex(world.plaza.shadowColor),
      map: shadowTexture,
      transparent: true,
      opacity: shadowSpec.opacity,
      depthWrite: false,
      // DoubleSide: the decal is a single flat quad lying on the plaza, so its winding decides
      // nothing visually and a mis-signed rotation would silently cull it. The plane is rotated
      // -90° about X, which puts its normal at +Y — stating the side removes the guesswork.
      side: THREE.DoubleSide,
      toneMapped: true,
    }),
  )
  // YXZ keeps the -90° floor tilt while allowing a later world-Y bearing. With the default XYZ
  // order, changing rotation.y tilts the quad's long axis out of the floor instead of yawing it.
  boardShadow.rotation.order = 'YXZ'
  boardShadow.rotation.x = -Math.PI / 2
  boardShadow.layers.set(SCENERY_LAYER)
  boardShadow.name = 'floating-world-board-shadow'
  boardShadow.frustumCulled = false
  boardShadow.renderOrder = -800
  group.add(boardShadow)

  function placeBoardShadow() {
    const camera = getCamera()
    const rect = getCanvasRect?.()
    const box = getBoardScreenBox?.()
    if (!camera || !rect || !box || rect.width < 1 || rect.height < 1) { boardShadow.visible = false; return }
    // The anchor, in CSS pixels on the FULL canvas: under the board's own screen centre, dropped
    // by `offsetFactor` of the board's screen height — the air gap §4.3 asks the composition to
    // show between the board's underside and its shadow.
    const boardWidth = box.maxX - box.minX
    const boardHeight = box.maxY - box.minY
    if (!(boardWidth > 0) || !(boardHeight > 0)) { boardShadow.visible = false; return }
    const ax = (box.minX + box.maxX) / 2
    const ay = box.maxY + shadowSpec.offsetFactor * boardHeight
    // A vector of this call's OWN: `visibleHeightAt()` walks `_point` twice, so keeping the ray
    // in the shared scratch and reading it back after that call silently measured the direction
    // to a DIFFERENT NDC corner. The symptom was a shadow parked behind the eye at z ≈ +86 while
    // every reported number stayed self-consistent.
    _shadowDir.set(2 * (ax - rect.left) / rect.width - 1, 1 - 2 * (ay - rect.top) / rect.height, 0.5)
      .unproject(camera).sub(camera.position).normalize()
    if (_shadowDir.y >= -1e-4) { boardShadow.visible = false; return }
    const y = plazaFloorY + shadowSpec.lift
    const t = (y - camera.position.y) / _shadowDir.y
    // A ray that never reaches the ground has no honest anchor: §6.4 forbids faking one with a
    // screen-space patch, so the shadow is simply not drawn and the report says so.
    if (!(t > 0) || !Number.isFinite(t)) { boardShadow.visible = false; return }
    const worldPerPx = visibleHeightAt(camera, t) / rect.height
    boardShadow.position.set(camera.position.x + _shadowDir.x * t, y, camera.position.z + _shadowDir.z * t)
    // The plane lies on the plaza, but its long axis must follow the camera's screen-right vector.
    // Leaving it on world X made the ellipse project as a long diagonal smear on desktop because
    // the camera itself is yawed 26°. The plaza uses the same bearing for its horizon.
    boardShadow.rotation.y = plaza.rotation.y
    boardShadow.scale.set(boardWidth * shadowSpec.widthFactor * worldPerPx, boardHeight * shadowSpec.heightFactor * worldPerPx, 1)
    boardShadow.visible = true
  }

  // ---- Block clusters -----------------------------------------------------------
  //
  //
  // ONE instanced mesh per placed cluster. The blocks are the same rounded box the board uses,
  // at the recipe's BACKGROUND size — a scenery block is a sibling of a gameplay block, not a
  // copy of one, so it is deliberately not routed through blockResources (which owns the 98
  // tiles' shared instance and would be the wrong owner for decorative geometry).
  const cellGeometry = new RoundedBoxGeometry(
    recipe.geometry.background.size,
    recipe.geometry.background.size,
    recipe.geometry.background.size,
    recipe.geometry.background.segments,
    recipe.geometry.background.radius,
  )
  const cellMaterial = new THREE.MeshStandardMaterial({
    roughness: recipe.materials.background.roughness,
    metalness: recipe.materials.background.metalness,
    envMapIntensity: recipe.materials.background.envMapIntensity,
  })

  // Cells are authored in lattice units (pitch 1, exactly like the recipe's prefabs). The
  // cluster's scale converts one lattice cell into its share of screen height, so the recipe's
  // numbers stay in the units its author wrote them in.
  function buildCluster(cells, name) {
    const mesh = new THREE.InstancedMesh(cellGeometry, cellMaterial, cells.length)
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage)
    mesh.layers.set(SCENERY_LAYER)
    mesh.name = `floating-world-${name}`
    let minX = Infinity; let minY = Infinity; let minZ = Infinity
    let maxX = -Infinity; let maxY = -Infinity; let maxZ = -Infinity
    cells.forEach((cell, index) => {
      const [x, y, z] = cell
      minX = Math.min(minX, x); maxX = Math.max(maxX, x)
      minY = Math.min(minY, y); maxY = Math.max(maxY, y)
      minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z)
      mesh.setMatrixAt(index, _matrix.makeTranslation(x, y, z))
      mesh.setColorAt(index, paletteColor(cell[3]))
    })
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    group.add(mesh)
    return {
      mesh,
      bounds: {
        height: maxY - minY + 1,
        centreX: (minX + maxX) / 2,
        centreY: (minY + maxY) / 2,
        centreZ: (minZ + maxZ) / 2,
      },
    }
  }

  // A parametric box mass — §4.2's 「补少量简单墙段与大块前景几何」. The recipe describes one as a
  // size in lattice cells plus a colour, which is the whole of what these are. An optional
  // `topColor` paints the top course, so a wall reads as built rather than extruded without the
  // recipe having to list every cell.
  function buildBoxMass(spec) {
    const [cx, cy, cz] = spec.sizeCells
    const cells = []
    for (let x = 0; x < cx; x += 1) for (let y = 0; y < cy; y += 1) for (let z = 0; z < cz; z += 1) {
      cells.push([x, y, z, (spec.topColor && y === cy - 1) ? spec.topColor : spec.color])
    }
    return buildCluster(cells, spec.id)
  }

  // ---- Clouds ------------------------------------------------------------------
  //
  // §7 allows the clouds to be sprites and requires them to actually move. They are the only
  // alpha-blended thing in the world, and `depthWrite:false` keeps them from punching a hole in
  // whatever is drawn after them.
  const cloudTextures = []
  const cloudSpecs = recipe.layout.cloudSeeds.map((seed, index) => {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      transparent: true,
      depthWrite: false,
      // Starts invisible and is faded in by its own texture's arrival. A SpriteMaterial with a
      // null map renders as a SOLID WHITE QUAD, so a cloud whose texture has not arrived — or
      // whose file 404s — would sit in the sky as a hard-edged white rectangle. That is exactly
      // what six seeds fed by three shapes produced: only the first three were ever given a map.
      opacity: 0,
    }))
    sprite.layers.set(SCENERY_LAYER)
    sprite.name = `floating-world-cloud-${index}`
    sprite.renderOrder = -900
    group.add(sprite)
    return { sprite, seed }
  })
  const loader = new THREE.TextureLoader()
  world.clouds.shapes.forEach((name, shapeIndex) => {
    // Every seed gets a shape, by round-robin rather than by index: six seeds and three shapes
    // means each shape is used twice, and an `index % seeds` mapping would hand the first three
    // seeds the three shapes and leave the rest blank.
    const targets = cloudSpecs.filter((_, index) => index % world.clouds.shapes.length === shapeIndex)
    loader.load(
      `${import.meta.env.BASE_URL}art/floating-world-v1/clouds/${name}`,
      (texture) => {
        prepareTexture(texture, 2)
        cloudTextures[shapeIndex] = texture
        for (const { sprite } of targets) {
          sprite.material.map = texture
          sprite.material.opacity = world.clouds.opacity
          sprite.material.needsUpdate = true
        }
      },
      undefined,
      () => { cloudTextures[shapeIndex] = null },
    )
  })

  // ---- Placement ----------------------------------------------------------------
  //
  // The recipe's `anchorConvention`: anchors are NDC of the FULL viewport, resolved once per
  // layout change using the render camera — the camera the frame is actually drawn with.
  // Resolving them through the canonical camera would anchor the world to the play area
  // instead, and every decoration outside that rect would land somewhere else entirely.
  //
  // `ndcPoint` is exact for any projection matrix: it unprojects the NDC ray and walks it to the
  // requested distance. That matters here because the render camera's projection is the CANONICAL
  // one embedded into a sub-rect, so its effective field of view is not `camera.fov` and a
  // `tan(fov/2)`-based helper would size every decoration wrongly.
  function ndcPoint(camera, out, ndcX, ndcY, distance) {
    out.set(ndcX, ndcY, 0.5).unproject(camera).sub(camera.position).normalize()
    return out.multiplyScalar(distance).add(camera.position)
  }

  // How much world the FULL frame covers at `distance`. Measured through the camera rather than
  // computed from its fov, for the reason above.
  function visibleHeightAt(camera, distance) {
    ndcPoint(camera, _point, 0, 1, distance)
    const top = _point.y
    ndcPoint(camera, _point, 0, -1, distance)
    return Math.abs(top - _point.y)
  }

  // The distance the board itself sits at, read from the live camera so the wheel and the
  // framing solver both feed through: every band is a multiple of it.
  const frameDistance = () => Math.max(1, getCamera()?.position.length() ?? 60)

  // Every decoration is placed by the same rule: walk the anchor ray to the band's depth, then
  // scale the cluster so its own lattice height covers `screenHeightFraction` of what the frame
  // can see there.
  function place(cluster, spec, bandFactor) {
    const camera = getCamera()
    if (!camera) return
    const distance = frameDistance() * (spec.distanceFactor ?? bandFactor)
    const scale = (spec.screenHeightFraction * visibleHeightAt(camera, distance)) / cluster.bounds.height
    ndcPoint(camera, _point, spec.anchor[0], spec.anchor[1], distance)
    _quaternion.setFromEuler(_euler.set(0, degrees(spec.yawDegrees), 0))
    // The cluster is centred on its own bounds, so the anchor names where the decoration IS
    // rather than where its lattice origin happens to be.
    _centre.set(cluster.bounds.centreX, cluster.bounds.centreY, cluster.bounds.centreZ)
      .applyQuaternion(_quaternion)
      .multiplyScalar(scale)
    cluster.mesh.position.copy(_point).sub(_centre)
    cluster.mesh.quaternion.copy(_quaternion)
    cluster.mesh.scale.setScalar(scale)
    cluster.mesh.userData.baseY = cluster.mesh.position.y
  }

  // ---- The placed set -----------------------------------------------------------
  const clusters = recipe.layout.gameplay
    .filter((entry) => recipe.prefabs[entry.prefab])
    .map((entry) => ({ ...buildCluster(recipe.prefabs[entry.prefab].cells, entry.id), spec: entry }))
  const walls = (world.walls ?? []).map((spec) => ({ ...buildBoxMass(spec), spec }))
  const foreground = (world.foreground ?? []).map((spec) => ({ ...buildBoxMass(spec), spec }))
  const looseBlocks = recipe.layout.looseBlocks
    .map((spec, index) => ({ ...buildCluster([[0, 0, 0, spec.color]], `loose-${index}`), spec }))

  // ---- Keep-out (§4.2/§4.3) ------------------------------------------------------
  //
  // A decoration the HUD or the board's own outline has to be read through is worse than a
  // missing decoration. The rects come from main, which owns both the DOM and the projected board
  // silhouette; this module only knows how to stop drawing into them.
  let culled = 0

  function screenBoxOf(object, camera, rect) {
    _box.setFromObject(object, true)
    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity
    for (let i = 0; i < 8; i += 1) {
      _corner.set(
        i & 1 ? _box.max.x : _box.min.x,
        i & 2 ? _box.max.y : _box.min.y,
        i & 4 ? _box.max.z : _box.min.z,
      ).project(camera)
      const x = rect.left + (_corner.x + 1) * 0.5 * rect.width
      const y = rect.top + (1 - _corner.y) * 0.5 * rect.height
      minX = Math.min(minX, x); maxX = Math.max(maxX, x)
      minY = Math.min(minY, y); maxY = Math.max(maxY, y)
    }
    return { left: minX, top: minY, right: maxX, bottom: maxY }
  }

  function applyKeepOut() {
    const camera = getCamera()
    const rect = getCanvasRect?.()
    if (!camera || !rect || rect.width < 1 || rect.height < 1) return
    const rects = (getKeepOutRects?.() ?? []).filter((r) => r && r.width > 0 && r.height > 0)
    const board = getBoardScreenBox?.()
    if (board && [board.minX, board.minY, board.maxX, board.maxY].every(Number.isFinite)) {
      const padding = Math.max(0, Number(recipe.layout.keepOutPaddingCssPx) || 0)
      rects.push({
        left: board.minX - padding,
        top: board.minY - padding,
        right: board.maxX + padding,
        bottom: board.maxY + padding,
        width: board.maxX - board.minX + padding * 2,
        height: board.maxY - board.minY + padding * 2,
        role: 'board',
      })
    }
    // Frame cropping is still allowed; overlap with a protected rect is not. The tray is not one
    // of those rects (it is an opaque DOM panel over the canvas), so the near masses can keep their
    // lower-corner crop. The board IS protected, therefore every decorative family participates —
    // including foreground and loose blocks. Exempting the near layer was the reason a cream mass
    // could sit on top of the live cells on a narrow phone.
    let hidden = 0
    for (const cluster of [...clusters, ...walls, ...foreground, ...looseBlocks]) {
      const box = screenBoxOf(cluster.mesh, camera, rect)
      cluster.mesh.visible = !rects.some((keep) => box.left < keep.right && box.right > keep.left && box.top < keep.bottom && box.bottom > keep.top)
      if (!cluster.mesh.visible) hidden += 1
    }
    culled = hidden
  }

  // ---- Layout solve -------------------------------------------------------------

  let appliedLayout = null

  // The two edges are solved along the frame's OWN vertical centre line, and the slab is then
  // yawed to match the camera's ground bearing. Both halves are load-bearing: the camera looks
  // down a fixed direction that is 26° off the world z axis, so a slab aligned to world axes
  // would present its far edge at an angle to the image plane and the 遠/近 boundary would come
  // out as a visibly tilted line, higher on one side than the other. Aligning the slab's local
  // +z with the camera's own ground bearing makes that edge parallel to the image plane, which
  // is what turns it into the straight horizon §4.3 asks the composition to read as.
  function alignPlaza(camera) {
    const px = camera.position.x
    const pz = camera.position.z
    if (Math.hypot(px, pz) < 1e-3) return
    plaza.rotation.y = Math.atan2(px, pz)
  }

  function layout() {
    const camera = getCamera()
    if (!camera) return
    // Every measurement below is a ray through `camera`, and `unproject` reads its WORLD matrix —
    // which is only refreshed by a render. A layout pass triggered by a resize can run before
    // that, so the matrix is asserted here rather than assumed; `updateRenderCamera()` owns the
    // same fix on the per-frame path.
    camera.updateMatrixWorld()
    alignPlaza(camera)
    // The plaza's two edges, solved from where §4.2 wants the 遠/近 split to land on screen.
    const zFar = solveGroundZ(camera, world.plaza.horizonNdc)
    const zNear = solveGroundZ(camera, NEAR_EDGE_NDC)
    if (zFar !== null && zNear !== null
      && (Math.abs(zFar - plazaSpec.zFar) > 0.01 || Math.abs(zNear - plazaSpec.zNear) > 0.01)) {
      buildPlaza(zFar, zNear)
    }
    for (const cluster of clusters) place(cluster, cluster.spec, world.bands.mid)
    for (const cluster of walls) place(cluster, cluster.spec, world.bands.far)
    for (const cluster of foreground) place(cluster, cluster.spec, world.bands.near)
    for (const cluster of looseBlocks) place(cluster, cluster.spec, world.bands.mid)

    // Clouds are placed on their own band; the layout pass only fixes where each one STARTS, and
    // the drift in `update()` moves it from there.
    const cloudDistance = frameDistance() * world.bands.clouds
    // The delivered cloud PNGs are 512×192 — 2.67:1, not square. A sprite scaled by one number
    // stretches them vertically into tall white slabs with hard-looking edges, which is what a
    // "cloud" stops being the moment it is 2.67× too tall. The aspect is declared in the recipe
    // so the shape is right on the first frame, before any texture has finished loading.
    const cloudAspect = world.clouds.aspect
    for (const { sprite, seed } of cloudSpecs) {
      const [ndcX, ndcY, heightFraction] = seed
      ndcPoint(camera, _point, ndcX, ndcY, cloudDistance)
      sprite.position.copy(_point)
      const size = heightFraction * visibleHeightAt(camera, cloudDistance)
      sprite.scale.set(size * cloudAspect, size, 1)
      // The band records everything the drift needs to be computed ABSOLUTELY from a time
      // value rather than accumulated frame by frame (see `applyAmbient`): where this cloud
      // starts, how wide the frame is in world units at its own depth, and how far it has to
      // travel before it is fully past either edge.
      ndcPoint(camera, _point, -1, ndcY, cloudDistance)
      const leftX = _point.x
      ndcPoint(camera, _point, 1, ndcY, cloudDistance)
      const rightX = _point.x
      sprite.userData.band = {
        distance: cloudDistance,
        size,
        baseX: sprite.position.x,
        halfSpan: (size * cloudAspect) / 2,
        leftX,
        rightX,
        speed: recipe.motion.clouds.speedScreenWidthsPerSecond[(seed[3] ?? 0) % recipe.motion.clouds.speedScreenWidthsPerSecond.length],
      }
    }
    appliedLayout = {
      distance: frameDistance(),
      plazaZFar: plazaSpec.zFar,
      plazaZNear: plazaSpec.zNear,
      shadowVisible: boardShadow.visible,
      clusters: clusters.length, walls: walls.length, foreground: foreground.length, looseBlocks: looseBlocks.length,
    }
    applyKeepOut()
    // Last: the shadow's anchor is solved from the board's own screen box, which is a product of
    // the framing this layout pass did not touch but must not read before the camera is settled.
    placeBoardShadow()
  }

  // ---- Motion (§7.2) -------------------------------------------------------------
  //
  // ONE ambient clock for the whole world, and it is a CLOCK VALUE, not an accumulator of
  // per-frame deltas. That distinction is load-bearing twice over:
  //
  //   * §C0.4 asks for a STILL mode so two captures of the same build can be compared pixel for
  //     pixel. With the pose computed from an absolute time, `setAmbient({ frozen: true, time: 0 })`
  //     reproduces one exact pose — the same contract `__voxalblastDev.setBoardFloat` gives the
  //     board, which is what makes the two halves of the world pinnable together.
  //   * `position.x += …` drifts: it accumulates float error and, worse, can only ever be frozen
  //     by simply not running. Computing the pose from `t` means a frozen world and a running one
  //     go through the exact same code path.
  let ambientTime = 0
  let ambientOverride = null
  const reducedMotion = typeof matchMedia === 'function'
    ? matchMedia('(prefers-reduced-motion: reduce)')
    : { matches: false }

  // §8.7 / C0.4. `null` clears the pin and hands the world back to the live clock. A pin is a
  // still POSE, not a paused animation: it keeps rendering the same frame, which is what a
  // before/after pair needs. `{ frozen: true, time: 0 }` is the neutral pose, matching the board's
  // own convention.
  function setAmbient(options) {
    if (!options) { ambientOverride = null; return }
    ambientOverride = { frozen: options.frozen === true, time: Number(options.time) }
  }

  function applyAmbient(t) {
    const rect = getCanvasRect?.()
    if (!rect || rect.width < 1) return
    for (const { sprite } of cloudSpecs) {
      const band = sprite.userData.band
      if (!band) continue
      // "Screen widths per second" is a SCREEN-space rate. Multiplying it by the frame's world
      // width AT THE CLOUD'S OWN DEPTH is what makes a near cloud and a far one move at the same
      // apparent speed instead of racing — and it needs the horizontal world-per-pixel, which the
      // embedded projection does not have to keep equal to the vertical one.
      const drift = t * band.speed * (band.rightX - band.leftX)
      // Wrap across the frame plus one sprite, so the sprite is fully off one edge before it
      // arrives at the other. §7.2 forbids an in-frame jump; a modulo over the whole loop makes
      // the wrap a function of `t` like everything else, so a pinned pose and a live one agree.
      const from = band.leftX - band.halfSpan
      const span = (band.rightX - band.leftX) + band.halfSpan * 2
      const wrapped = ((band.baseX + drift - from) % span + span) % span
      sprite.position.x = from + wrapped
    }
    // Building bob: the recipe's amplitude is in the building's OWN cells, so it is scaled by
    // the cluster's own scale rather than by a shared world number.
    const bob = (list, amplitude, period, phaseStep) => {
      list.forEach((cluster, index) => {
        const phase = cluster.spec.phaseRadians ?? index * phaseStep
        const lift = Math.sin((t / period) * Math.PI * 2 + phase) * amplitude * cluster.mesh.scale.y
        cluster.mesh.position.y = cluster.mesh.userData.baseY + lift
      })
    }
    bob(clusters, recipe.motion.cluster.amplitudeCell, recipe.motion.cluster.periodSeconds, recipe.motion.cluster.phaseStepRadians)
    bob(looseBlocks, recipe.motion.looseBlock.amplitudeCell, recipe.motion.looseBlock.periodSeconds, recipe.motion.looseBlock.phaseStepRadians)
  }

  function update(delta) {
    // The layout is a function of the camera's DISTANCE, and that number is only settled once the
    // framing solver, the turn-band lift and the zoom wheel have all had their say — which is
    // after this module is constructed. Re-solving whenever it moves keeps every decoration
    // anchored to the frame instead of to whatever pose the camera happened to be in at boot.
    const distance = frameDistance()
    if (!appliedLayout || Math.abs(distance - appliedLayout.distance) > distance * 0.01) layout()
    // A pinned time answers for the clock entirely; `frozen` only decides whether the live clock
    // keeps running underneath. `prefers-reduced-motion` freezes the displacement too (§7.2) — the
    // world holds a readable static pose rather than accumulating time nobody sees.
    const pinned = ambientOverride && Number.isFinite(ambientOverride.time) ? ambientOverride.time : null
    const frozen = reducedMotion.matches || ambientOverride?.frozen === true || pinned !== null
    if (!frozen) ambientTime += Math.min(delta, recipe.motion.maxDeltaSeconds)
    applyAmbient(pinned ?? ambientTime)
  }

  // ---- Report --------------------------------------------------------------------
  //
  // §9.3 asks for background instances and cloud textures to be assertable. "The valley image
  // loaded" was the old skin's only tell; these are the facts that say the NEW one is up.
  const _probe = new THREE.Vector3()
  function horizonReport() {
    const camera = getCamera()
    if (!camera) return null
    const bearing = plaza.rotation.y
    // The far edge's midpoint, rebuilt from the solved local z rather than read off the mesh:
    // the mesh's own matrix may be a frame stale, and this number is a claim about the picture.
    _probe.set(Math.sin(bearing) * plazaSpec.zFar, plazaFloorY, Math.cos(bearing) * plazaSpec.zFar)
    _probe.project(camera)
    return {
      requestedNdc: world.plaza.horizonNdc,
      edgeNdc: _probe.y,
      edgeFromTop: (1 - _probe.y) / 2,
      zFar: plazaSpec.zFar,
    }
  }
  function report() {
    const count = (list) => list.reduce((sum, cluster) => sum + cluster.mesh.count, 0)
    return {
      enabled: group.visible,
      layer: SCENERY_LAYER,
      layerMask: WORLD_LAYER_MASK,
      tier: quality?.lowPower ? 'low' : 'high',
      tierSpec: tierFor(quality),
      // §4.2's split, as the screen actually shows it. `edgeNdc` is the solved far edge PROJECTED
      // BACK through the render camera: the number §4.2's composition is graded on, and the one
      // fact that cannot be read off a screenshot when the background is a flat cream field.
      // `edgeScreenFraction` is the same thing as "how far down from the top of the frame".
      horizon: horizonReport(),
      sky: { radius: world.sky.radius, ready: sky.visible },
      plaza: { halfWidth: plazaSpec.halfX, zFar: plazaSpec.zFar, zNear: plazaSpec.zNear, floorY: plaza.position.y },
      boardShadow: (() => {
        const camera = getCamera()
        const rect = getCanvasRect?.()
        _probe.copy(boardShadow.position)
        if (camera) _probe.project(camera)
        return {
          visible: boardShadow.visible,
          opacity: shadowSpec.opacity,
          width: boardShadow.scale.x,
          height: boardShadow.scale.y,
          y: boardShadow.position.y,
          position: [boardShadow.position.x, boardShadow.position.y, boardShadow.position.z],
          // Where the decal's centre lands on screen, so "it is not in the picture" can be told
          // apart from "it is in the picture and cannot be seen" without a debugger.
          screen: rect ? { x: rect.left + (_probe.x + 1) * 0.5 * rect.width, y: rect.top + (1 - _probe.y) * 0.5 * rect.height } : null,
          mapReady: Boolean(boardShadow.material.map?.image),
          parented: boardShadow.parent === group,
        }
      })(),
      clusters: clusters.length,
      walls: walls.length,
      foreground: foreground.length,
      looseBlocks: looseBlocks.length,
      cells: count(clusters) + count(walls) + count(foreground) + count(looseBlocks),
      clouds: cloudSpecs.length,
      cloudTextures: cloudTextures.filter(Boolean).length,
      culled,
      layout: appliedLayout,
      reducedMotion: reducedMotion.matches,
      // §8.7 / C0.4: whether the world is on the live clock, pinned, or frozen — the fact a
      // before/after pair is only comparable when it is true. `time` is the value the pose was
      // actually built from, so a pinned capture can prove WHICH pose it is.
      ambient: {
        frozen: reducedMotion.matches || ambientOverride?.frozen === true || ambientOverride !== null,
        pinned: ambientOverride !== null,
        time: ambientOverride && Number.isFinite(ambientOverride.time) ? ambientOverride.time : ambientTime,
      },
    }
  }

  const setEnabled = (on) => { group.visible = on }

  // There is deliberately NO layout pass here.
  //
  // Every placement is measured through the camera the frame is drawn with, and that cannot be
  // answered at construction time: the framing solver has not run, the camera is still at the
  // origin, and the board's own screen silhouette — which the art shadow is anchored from — is
  // not computable yet (it needs main's `BLOCK_HALF`, declared further down that file). Calling
  // it here threw `ReferenceError: Cannot access 'BLOCK_HALF' before initialization` on the very
  // first layout attempt. The plaza's placeholder geometry is built above; `update()` re-solves
  // everything on the first frame, and `resize()` re-solves it again whenever the layout moves.

  return { group, sky, plaza, resize: layout, update, setEnabled, setAmbient, report }
}

import packageInfo from '../package.json'
import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import {
  BloomEffect,
  EffectComposer,
  EffectPass,
  RenderPass,
  SMAAEffect,
  SMAAPreset,
} from 'postprocessing'
import {
  BatchedRenderer,
  Bezier,
  ColorOverLife,
  ConstantColor,
  ConstantValue,
  Gradient,
  ParticleSystem,
  PiecewiseBezier,
  RenderMode,
  SizeOverLife,
} from 'three.quarks'
import { Board, SIZE } from './game/board.js'
import { SHAPES, normalizeCells } from './game/shapes.js'
import { createCrazyGamesAdapter } from './platform/crazygames.js'
import { getRenderQuality, RENDER_PALETTE as palette, VFX_CONFIG } from './rendering/config.js'
import './styles.css'

const board = new Board()
const platform = createCrazyGamesAdapter()
const sceneWrap = document.querySelector('#scene-wrap')
const scoreEl = document.querySelector('#score')
const bestEl = document.querySelector('#best')
const statusEl = document.querySelector('#status')
const linesEl = document.querySelector('#lines-readout')
const toastEl = document.querySelector('#toast')
const slotsEl = document.querySelector('#piece-slots')
const piecesPanelEl = document.querySelector('.pieces-panel')
const cancelZoneEl = document.querySelector('#cancel-zone')
const gameOverEl = document.querySelector('#game-over')
const finalScoreEl = document.querySelector('#final-score')
const finalBestEl = document.querySelector('#final-best')
const versionEl = document.querySelector('#app-version')
const settingsEl = document.querySelector('#settings-modal')
const settingsButtonEl = document.querySelector('#settings-button')
const soundSettingEl = document.querySelector('#sound-setting')
const hapticsSettingEl = document.querySelector('#haptics-setting')

const bestKey = 'voxalblast-best'
const soundKey = 'voxalblast-sound'
const hapticsKey = 'voxalblast-haptics'
versionEl.textContent = `v${packageInfo.version}`
let best = Number.parseInt(localStorage.getItem(bestKey) || '0', 10)
let pieces = []
let selectedPiece = null
let drag = null
let viewDrag = null
let isPaused = false
let gameEnded = false
let settingsOpen = false
let soundOn = localStorage.getItem(soundKey) !== 'off'
let hapticsOn = localStorage.getItem(hapticsKey) !== 'off'
let audioContext
let toastTimer
let cameraShake = 0
let transientEffects = []
let suppressPieceClickUntil = 0
const particleSystems = new Set()
const piecePreviews = new Map()

const quality = getRenderQuality()

const scene = new THREE.Scene()
scene.background = null
scene.fog = new THREE.Fog(palette.background, 17, 30)
const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100)
const cameraBasePosition = new THREE.Vector3()
const cameraDirection = new THREE.Vector3(0.82, 0.76, 1).normalize()
const cameraTarget = new THREE.Vector3(0, 0, 0)
let cameraAzimuth = Math.atan2(1, 0.82)
const defaultCameraAzimuth = cameraAzimuth
const cameraElevation = Math.atan2(0.76, Math.hypot(0.82, 1))
let cameraZoom = 1
const minCameraZoom = 0.7
const maxCameraZoom = 1.7
let orbitDistance = 10
const frameCorner = new THREE.Vector3()
const frameRight = new THREE.Vector3()
const frameUp = new THREE.Vector3()

// Camera orbits at a constant distance fitted to the widest view of the cube,
// so the board keeps one apparent size instead of zooming in face-on and
// shrinking when viewed corner-on.
function distanceForViewDirection(direction) {
  camera.position.copy(direction)
  camera.lookAt(cameraTarget)
  camera.updateMatrixWorld(true)
  const right = frameRight.setFromMatrixColumn(camera.matrixWorld, 0)
  const up = frameUp.setFromMatrixColumn(camera.matrixWorld, 1)
  const verticalTan = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)
  const horizontalTan = verticalTan * camera.aspect
  const isMobile = sceneWrap.clientWidth < 700
  const safeFactor = isMobile ? 0.84 : 0.88
  const min = -boardSpan / 2
  const max = boardSpan / 2
  let distance = 0
  for (const x of [min, max]) for (const y of [min, max]) for (const z of [min, max]) {
    const corner = frameCorner.set(x, y, z)
    const depthOffset = corner.dot(direction)
    distance = Math.max(
      distance,
      depthOffset + Math.abs(corner.dot(right)) / (horizontalTan * safeFactor),
      depthOffset + Math.abs(corner.dot(up)) / (verticalTan * safeFactor),
    )
  }
  return distance
}

function recomputeOrbitDistance() {
  let worst = 0
  const horizontalScale = Math.cos(cameraElevation)
  for (let i = 0; i < 72; i += 1) {
    const azimuth = (i / 72) * Math.PI * 2
    const direction = new THREE.Vector3(
      horizontalScale * Math.cos(azimuth),
      Math.sin(cameraElevation),
      horizontalScale * Math.sin(azimuth),
    ).normalize()
    worst = Math.max(worst, distanceForViewDirection(direction))
  }
  return worst
}

function refreshCameraProjection() {
  const isMobile = sceneWrap.clientWidth < 700
  camera.fov = isMobile ? 37 : 34
  camera.aspect = Math.max(sceneWrap.clientWidth / Math.max(sceneWrap.clientHeight, 1), 0.5)
  camera.updateProjectionMatrix()
  orbitDistance = recomputeOrbitDistance()
}

function fitCameraToPlaySpace() {
  const horizontalScale = Math.cos(cameraElevation)
  cameraDirection.set(
    horizontalScale * Math.cos(cameraAzimuth),
    Math.sin(cameraElevation),
    horizontalScale * Math.sin(cameraAzimuth),
  ).normalize()
  cameraBasePosition.copy(cameraDirection).multiplyScalar(orbitDistance * cameraZoom)
  camera.position.copy(cameraBasePosition)
  camera.lookAt(cameraTarget)
}

const previewCameraRadius = Math.hypot(5, 6)
const previewCameraBaseAzimuth = Math.atan2(6, 5)
const previewCameraHeight = 4.2

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' })
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality.pixelRatioMax))
renderer.outputColorSpace = THREE.SRGBColorSpace
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.toneMappingExposure = 1.14
renderer.setClearColor(0x000000, 0)
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFSoftShadowMap
sceneWrap.appendChild(renderer.domElement)

const composer = new EffectComposer(renderer, { multisampling: quality.multisampling })
const renderPass = new RenderPass(scene, camera)
const bloomEffect = new BloomEffect({
  intensity: quality.bloomIntensity,
  luminanceThreshold: VFX_CONFIG.bloom.luminanceThreshold,
  luminanceSmoothing: VFX_CONFIG.bloom.luminanceSmoothing,
  mipmapBlur: true,
  radius: VFX_CONFIG.bloom.radius,
  levels: quality.lowPower ? VFX_CONFIG.bloom.lowPowerLevels : VFX_CONFIG.bloom.levels,
})
const smaaEffect = new SMAAEffect({ preset: quality.lowPower ? SMAAPreset.LOW : SMAAPreset.HIGH })
const effectPass = new EffectPass(camera, bloomEffect, smaaEffect)
composer.addPass(renderPass)
composer.addPass(effectPass)

const hemiLight = new THREE.HemisphereLight(0xdbeaff, 0x182653, 2.25)
scene.add(hemiLight)
const keyLight = new THREE.DirectionalLight(0xffffff, 4.1)
keyLight.position.set(5.5, 10, 7)
keyLight.castShadow = true
keyLight.shadow.mapSize.set(2048, 2048)
keyLight.shadow.camera.left = -8
keyLight.shadow.camera.right = 8
keyLight.shadow.camera.top = 8
keyLight.shadow.camera.bottom = -8
keyLight.shadow.bias = -0.0004
scene.add(keyLight)
const rimLight = new THREE.DirectionalLight(0x72aaff, 2.2)
rimLight.position.set(-8, 4, -6)
scene.add(rimLight)
const fillLight = new THREE.PointLight(0x9de8ff, 18, 15, 2)
fillLight.position.set(0, 5, 2)
scene.add(fillLight)

const gridGroup = new THREE.Group()
const blocksGroup = new THREE.Group()
const previewGroup = new THREE.Group()
const candidateGroup = new THREE.Group()
const fxGroup = new THREE.Group()
scene.add(gridGroup, blocksGroup, previewGroup, candidateGroup, fxGroup)

const cellSize = 1.05
const boardSpan = SIZE * cellSize
const boardOffset = (SIZE - 1) * cellSize / 2
const cellToWorld = (x, y, z) => new THREE.Vector3(
  x * cellSize - boardOffset,
  y * cellSize - boardOffset,
  z * cellSize - boardOffset,
)
const cubeGeometry = new RoundedBoxGeometry(0.86, 0.86, 0.86, 3, 0.075)
const edgeGeometry = new THREE.EdgesGeometry(cubeGeometry)
const particleGeometry = new RoundedBoxGeometry(0.12, 0.12, 0.12, 2, 0.025)
const beamGeometry = new THREE.BoxGeometry(boardSpan + 0.08, 0.065, 0.065)
function buildStarShape(outer = 0.5, inner = 0.2, points = 5) {
  const shape = new THREE.Shape()
  for (let i = 0; i < points * 2; i += 1) {
    const radius = i % 2 === 0 ? outer : inner
    const angle = (i / (points * 2)) * Math.PI * 2 - Math.PI / 2
    const x = Math.cos(angle) * radius
    const y = Math.sin(angle) * radius
    if (i === 0) shape.moveTo(x, y)
    else shape.lineTo(x, y)
  }
  shape.closePath()
  return new THREE.ShapeGeometry(shape)
}
const starGeometry = buildStarShape(0.5, 0.22, 5)
const particleMaterial = new THREE.MeshBasicMaterial({
  color: 0xffffff,
  transparent: true,
  opacity: 0.8,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  toneMapped: false,
})
const particleRenderer = new BatchedRenderer()
scene.add(particleRenderer)

function colorToVector4(color, alpha = 1) {
  const normalized = new THREE.Color(color)
  return new THREE.Vector4(normalized.r, normalized.g, normalized.b, alpha)
}

function makeMaterial(color, opacity = 1) {
  const materialColor = new THREE.Color(color)
  return new THREE.MeshStandardMaterial({
    color: materialColor,
    roughness: 0.34,
    metalness: 0.04,
    emissive: materialColor,
    emissiveIntensity: opacity < 1 ? 0.12 : 0.055,
    transparent: opacity < 1,
    opacity,
  })
}

function disposeNode(node) {
  node.traverse((child) => {
    if (child.geometry && child.geometry !== cubeGeometry && child.geometry !== edgeGeometry) child.geometry.dispose()
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

function buildGrid() {
  const min = -boardSpan / 2
  const max = boardSpan / 2

  // The play space floats directly in the sky. Only the lowest layer keeps
  // soft, separated landing pads so depth remains readable without a base.
  const padGeometry = new RoundedBoxGeometry(0.82, 0.035, 0.82, 3, 0.09)
  const padMaterial = new THREE.MeshStandardMaterial({
    color: palette.grid,
    roughness: 0.78,
    metalness: 0,
    transparent: true,
    opacity: 0.19,
    depthWrite: false,
  })
  for (let x = 0; x < SIZE; x += 1) for (let z = 0; z < SIZE; z += 1) {
    const pad = new THREE.Mesh(padGeometry, padMaterial)
    pad.position.set(x * cellSize - boardOffset, min - 0.025, z * cellSize - boardOffset)
    pad.receiveShadow = true
    gridGroup.add(pad)
  }

  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(boardSpan * 0.72, boardSpan * 0.72),
    new THREE.ShadowMaterial({ color: palette.navyDeep, opacity: 0.14, transparent: true }),
  )
  shadow.rotation.x = -Math.PI / 2
  shadow.position.y = min - 0.06
  shadow.receiveShadow = true
  gridGroup.add(shadow)

  // Eight short corner brackets are only a faint depth hint now; the volume is
  // carried by the colored blocks, the bottom landing pads and candidate hints.
  const corners = [
    new THREE.Vector3(min, min, min), new THREE.Vector3(max, min, min),
    new THREE.Vector3(min, max, min), new THREE.Vector3(max, max, min),
    new THREE.Vector3(min, min, max), new THREE.Vector3(max, min, max),
    new THREE.Vector3(min, max, max), new THREE.Vector3(max, max, max),
  ]
  const edgeMaterial = new THREE.LineBasicMaterial({
    color: palette.navy,
    transparent: true,
    opacity: 0.1,
    depthWrite: false,
  })
  const bracketLength = 0.4
  const bracketPoints = []
  corners.forEach((corner) => {
    for (const axis of ['x', 'y', 'z']) {
      const end = corner.clone()
      end[axis] += (corner[axis] === min ? 1 : -1) * bracketLength
      bracketPoints.push(corner, end)
    }
  })
  const bracketGeometry = new THREE.BufferGeometry().setFromPoints(bracketPoints)
  gridGroup.add(new THREE.LineSegments(bracketGeometry, edgeMaterial))
}
buildGrid()

function nearestOrigin(ndc, cells) {
  let bestOrigin = { x: 0, y: 0, z: 0 }
  let bestDistance = Infinity
  const projected = new THREE.Vector3()
  for (let x = 0; x < SIZE; x += 1) for (let y = 0; y < SIZE; y += 1) for (let z = 0; z < SIZE; z += 1) {
    if (!board.canPlace(cells, { x, y, z })) continue
    projected.copy(cellToWorld(x, y, z)).project(camera)
    const distance = Math.hypot(projected.x - ndc.x, projected.y - ndc.y)
    if (distance < bestDistance) { bestDistance = distance; bestOrigin = { x, y, z } }
  }
  if (bestDistance < Infinity) return bestOrigin
  for (let x = 0; x < SIZE; x += 1) for (let y = 0; y < SIZE; y += 1) for (let z = 0; z < SIZE; z += 1) {
    projected.copy(cellToWorld(x, y, z)).project(camera)
    const distance = Math.hypot(projected.x - ndc.x, projected.y - ndc.y)
    if (distance < bestDistance) { bestDistance = distance; bestOrigin = { x, y, z } }
  }
  return bestOrigin
}

function renderBoard() {
  clearGroup(blocksGroup)
  board.cells.forEach((cell) => {
    const mesh = new THREE.Mesh(cubeGeometry, makeMaterial(cell.color))
    mesh.position.copy(cellToWorld(cell.x, cell.y, cell.z))
    mesh.castShadow = true
    mesh.receiveShadow = true
    mesh.add(new THREE.LineSegments(edgeGeometry, new THREE.LineBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.38,
      depthWrite: false,
    })))
    blocksGroup.add(mesh)
  })
  clearGroup(candidateGroup)
  board.candidateCells().forEach((key) => {
    const [x, y, z] = key.split(',').map(Number)
    const ring = new THREE.Mesh(
      new RoundedBoxGeometry(0.94, 0.94, 0.94, 2, 0.06),
      new THREE.MeshBasicMaterial({ color: palette.candidate, transparent: true, opacity: 0.15, wireframe: true, toneMapped: false }),
    )
    ring.position.copy(cellToWorld(x, y, z))
    candidateGroup.add(ring)
  })
  updateHud()
}

function updateHud() {
  scoreEl.textContent = String(board.score).padStart(4, '0')
  bestEl.textContent = String(best).padStart(4, '0')
  linesEl.textContent = `${board.totalLines} LINE${board.totalLines === 1 ? '' : 'S'}`
}

function makePiece(shape) {
  return { shape, cells: normalizeCells(shape.cells), used: false }
}

function currentCells(piece) {
  return piece.cells
}

function nextPieces() {
  pieces = Array.from({ length: 3 }, () => makePiece(SHAPES[Math.floor(Math.random() * SHAPES.length)]))
  selectedPiece = null
  renderPieceSlots()
}

function colorHex(color) {
  return `#${new THREE.Color(color).getHexString()}`
}

function centeredPreviewPositions(cells) {
  const vectors = cells.map(([x, y, z]) => new THREE.Vector3(x, y, z).multiplyScalar(0.72))
  const bounds = new THREE.Box3().setFromPoints(vectors)
  const center = bounds.getCenter(new THREE.Vector3())
  return vectors.map((position) => position.sub(center))
}

function disposePiecePreviews() {
  piecePreviews.forEach((preview) => {
    preview.meshes.forEach((mesh) => {
      mesh.material.dispose()
      mesh.children.forEach((child) => child.material?.dispose())
    })
    preview.renderer.dispose()
    preview.renderer.forceContextLoss?.()
  })
  piecePreviews.clear()
}

function createPiecePreview(piece, canvas, slot) {
  const previewRenderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'low-power' })
  previewRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5))
  previewRenderer.outputColorSpace = THREE.SRGBColorSpace
  previewRenderer.toneMapping = THREE.ACESFilmicToneMapping
  previewRenderer.toneMappingExposure = 1.16
  previewRenderer.setClearColor(0x000000, 0)

  const previewScene = new THREE.Scene()
  previewScene.add(new THREE.HemisphereLight(0xffffff, 0x6f82b7, 2.8))
  const previewKey = new THREE.DirectionalLight(0xffffff, 4.4)
  previewKey.position.set(4, 7, 5)
  previewScene.add(previewKey)
  const previewRim = new THREE.DirectionalLight(0x7ec8ff, 1.5)
  previewRim.position.set(-4, 2, -3)
  previewScene.add(previewRim)

  const previewCamera = new THREE.OrthographicCamera(-2.5, 2.5, 2.2, -2.2, 0.1, 40)
  previewCamera.position.set(5, 4.2, 6)
  previewCamera.lookAt(0, 0, 0)
  const root = new THREE.Group()
  previewScene.add(root)
  const positions = centeredPreviewPositions(currentCells(piece))
  const size = new THREE.Box3().setFromPoints(positions).getSize(new THREE.Vector3()).addScalar(0.62)
  const baseScale = THREE.MathUtils.clamp(3.4 / Math.max(size.x, size.y, size.z), 0.96, VFX_CONFIG.preview.maxScale)
  root.scale.setScalar(baseScale)
  const outlineColor = new THREE.Color(piece.shape.color).multiplyScalar(0.58)
  const meshes = positions.map((position) => {
    const mesh = new THREE.Mesh(cubeGeometry, makeMaterial(piece.shape.color))
    mesh.scale.setScalar(0.72)
    mesh.position.copy(position)
    mesh.add(new THREE.LineSegments(edgeGeometry, new THREE.LineBasicMaterial({ color: outlineColor, transparent: true, opacity: 0.66 })))
    root.add(mesh)
    return mesh
  })
  piecePreviews.set(piece, { piece, slot, renderer: previewRenderer, scene: previewScene, camera: previewCamera, root, meshes })
}

function updatePieceSlotSelection() {
  piecePreviews.forEach((preview, piece) => {
    preview.slot.classList.toggle('selected', selectedPiece === piece)
    preview.slot.classList.toggle('used', piece.used)
  })
}

function updatePiecePreviews() {
  piecePreviews.forEach((preview) => {
    const width = Math.max(preview.renderer.domElement.clientWidth, 1)
    const height = Math.max(preview.renderer.domElement.clientHeight, 1)
    if (preview.renderer.domElement.width !== Math.round(width * preview.renderer.getPixelRatio()) || preview.renderer.domElement.height !== Math.round(height * preview.renderer.getPixelRatio())) {
      preview.renderer.setSize(width, height, false)
      const halfHeight = VFX_CONFIG.preview.cameraHeight
      const halfWidth = halfHeight * width / height
      preview.camera.left = -halfWidth
      preview.camera.right = halfWidth
      preview.camera.top = halfHeight
      preview.camera.bottom = -halfHeight
      preview.camera.updateProjectionMatrix()
    }
    // Candidate thumbnails share the board's yaw: orbiting the view turns the
    // little previews the same way so a piece faces identically in both.
    const azimuth = previewCameraBaseAzimuth + (cameraAzimuth - defaultCameraAzimuth)
    preview.camera.position.set(
      Math.cos(azimuth) * previewCameraRadius,
      previewCameraHeight,
      Math.sin(azimuth) * previewCameraRadius,
    )
    preview.camera.lookAt(0, 0, 0)
    preview.renderer.render(preview.scene, preview.camera)
  })
}

function renderPieceSlots() {
  disposePiecePreviews()
  slotsEl.innerHTML = ''
  pieces.forEach((piece, index) => {
    const slot = document.createElement('button')
    slot.className = `piece-slot${piece.used ? ' used' : ''}${selectedPiece === piece ? ' selected' : ''}`
    slot.type = 'button'
    slot.dataset.index = index
    slot.style.setProperty('--piece-color', colorHex(piece.shape.color))
    slot.setAttribute('aria-label', `${piece.shape.name}, ${piece.shape.cells.length} voxels`)

    const thumb = document.createElement('span')
    thumb.className = 'piece-thumb'
    const canvas = document.createElement('canvas')
    canvas.className = 'piece-preview-canvas'
    canvas.setAttribute('aria-hidden', 'true')
    thumb.appendChild(canvas)

    slot.append(thumb)
    slot.addEventListener('pointerdown', (event) => beginDrag(event, piece))
    slot.addEventListener('click', () => {
      if (!piece.used && !drag && performance.now() >= suppressPieceClickUntil) {
        selectedPiece = piece
        updatePieceSlotSelection()
        setStatus('Ready to place')
      }
    })
    slotsEl.appendChild(slot)
    createPiecePreview(piece, canvas, slot)
  })
}

function setStatus(text) { statusEl.textContent = text }
function showToast(text) {
  toastEl.textContent = text
  toastEl.classList.add('visible')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => toastEl.classList.remove('visible'), 1500)
}

function setCancelZone(active, highlighted = false) {
  piecesPanelEl.classList.toggle('cancel-mode', active)
  piecesPanelEl.classList.toggle('cancel-hot', active && highlighted)
  cancelZoneEl.setAttribute('aria-hidden', String(!active))
}

function isInsidePieceArea(event) {
  const rect = piecesPanelEl.getBoundingClientRect()
  return event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom
}

function cancelActiveDrag(showFeedback = true) {
  if (!drag) return false
  const currentDrag = drag
  drag = null
  releaseDragPointer(currentDrag.source, currentDrag.pointerId)
  clearGroup(previewGroup)
  selectedPiece = null
  suppressPieceClickUntil = performance.now() + 260
  setCancelZone(false)
  updatePieceSlotSelection()
  setStatus('Pick a shape')
  if (showFeedback) {
    showToast('Placement cancelled')
    playHaptic(10)
  }
  return true
}

function updateSettingsUi() {
  soundSettingEl.classList.toggle('enabled', soundOn)
  soundSettingEl.setAttribute('aria-pressed', String(soundOn))
  hapticsSettingEl.classList.toggle('enabled', hapticsOn)
  hapticsSettingEl.setAttribute('aria-pressed', String(hapticsOn))
}

function openSettings() {
  if (gameEnded) return
  settingsOpen = true
  isPaused = true
  if (drag) cancelActiveDrag(false)
  clearGroup(previewGroup)
  settingsEl.classList.remove('hidden')
  platform.gameplayStop()
  setStatus('Paused')
  updateSettingsUi()
  document.querySelector('#settings-close').focus()
}

function closeSettings() {
  if (!settingsOpen) return
  settingsOpen = false
  settingsEl.classList.add('hidden')
  isPaused = document.hidden || gameEnded
  if (!isPaused) {
    platform.gameplayStart()
    setStatus('Pick a shape')
  }
  settingsButtonEl.focus()
}

function playTone(frequency, duration = 0.08, volume = 0.045, delay = 0) {
  if (!soundOn) return
  const AudioContext = window.AudioContext || window.webkitAudioContext
  if (!AudioContext) return
  audioContext ||= new AudioContext()
  if (audioContext.state === 'suspended') audioContext.resume()
  const start = audioContext.currentTime + delay
  const oscillator = audioContext.createOscillator()
  const gain = audioContext.createGain()
  oscillator.type = 'sine'
  oscillator.frequency.setValueAtTime(frequency, start)
  oscillator.frequency.exponentialRampToValueAtTime(frequency * 1.08, start + duration)
  gain.gain.setValueAtTime(0.0001, start)
  gain.gain.exponentialRampToValueAtTime(volume, start + 0.012)
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration)
  oscillator.connect(gain).connect(audioContext.destination)
  oscillator.start(start)
  oscillator.stop(start + duration + 0.02)
}

function playPlaceSound(lineCount) {
  if (lineCount > 0) {
    playTone(520, 0.12, 0.055)
    playTone(lineCount > 1 ? 880 : 720, 0.16, 0.05, 0.055)
  } else playTone(330, 0.075, 0.036)
}

function playHaptic(pattern = 15) {
  if (hapticsOn && navigator.vibrate) navigator.vibrate(pattern)
}

function showScorePop(points, lineCount) {
  const pop = document.createElement('div')
  pop.className = 'score-pop'
  pop.innerHTML = `<strong>+${points}</strong><span>${lineCount} LINE${lineCount === 1 ? '' : 'S'}</span>`
  sceneWrap.appendChild(pop)
  requestAnimationFrame(() => pop.classList.add('visible'))
  setTimeout(() => pop.remove(), 920)
}

const raycaster = new THREE.Raycaster()
const pointer = new THREE.Vector2()
const boardPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), boardSpan / 2 + 0.025)
function pointerPoint(event) {
  const rect = renderer.domElement.getBoundingClientRect()
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
  raycaster.setFromCamera(pointer, camera)
  const point = new THREE.Vector3()
  raycaster.ray.intersectPlane(boardPlane, point)
  return { point, ndc: pointer.clone() }
}

function beginDrag(event, piece) {
  if (piece.used || isPaused || drag) return
  // Right/middle click is reserved as the in-drag cancel entry on PC; it must
  // not start a phantom placement drag when a slot is idle.
  if (event.pointerType === 'mouse' && event.button !== 0) return
  event.preventDefault()
  selectedPiece = piece
  const hit = pointerPoint(event)
  drag = {
    piece,
    pointerId: event.pointerId,
    source: event.currentTarget,
    point: hit.point,
    ndc: hit.ndc,
    origin: null,
    valid: false,
    active: false,
    inCancelZone: false,
    startX: event.clientX,
    startY: event.clientY,
  }
  // Keep receiving the touch after it leaves the slot button.
  try {
    event.currentTarget.setPointerCapture?.(event.pointerId)
  } catch {
    // Some embedded browsers reject capture during an interrupted gesture.
  }
  event.currentTarget.classList.add('selected')
  setStatus('Drag to the cube')
}

function updatePreview(point) {
  clearGroup(previewGroup)
  if (!selectedPiece || !point || !drag?.active) return
  const cells = currentCells(selectedPiece)
  const origin = nearestOrigin(drag.ndc, cells)
  const valid = board.canPlace(cells, origin)
  drag.valid = valid
  drag.origin = origin
  cells.forEach(([x, y, z]) => {
    const mesh = new THREE.Mesh(cubeGeometry, makeMaterial(valid ? palette.valid : palette.invalid, 0.52))
    mesh.position.copy(cellToWorld(x + origin.x, y + origin.y, z + origin.z))
    mesh.add(new THREE.LineSegments(edgeGeometry, new THREE.LineBasicMaterial({
      color: valid ? 0x083c39 : 0x6b1024,
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
    })))
    previewGroup.add(mesh)
  })
  setStatus(valid ? 'Release to place' : 'No room here')
}

class AxisEmitter {
  constructor(direction, spread = VFX_CONFIG.clear.spread) {
    this.type = 'axis'
    this.direction = direction.clone().normalize()
    this.spread = spread
    this.sequence = 0
  }

  initialize(particle) {
    const helper = Math.abs(this.direction.y) < 0.8 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)
    const side = new THREE.Vector3().crossVectors(helper, this.direction).normalize()
    const other = new THREE.Vector3().crossVectors(this.direction, side).normalize()
    const phase = this.sequence++ * 2.399963
    particle.position.set(0, 0, 0)
    particle.velocity.copy(this.direction)
      .addScaledVector(side, Math.cos(phase) * this.spread)
      .addScaledVector(other, Math.sin(phase) * this.spread * 0.7)
      .normalize()
      .multiplyScalar(particle.startSpeed)
  }

  toJSON() { return { type: this.type, direction: this.direction.toArray(), spread: this.spread } }
  clone() { return new AxisEmitter(this.direction, this.spread) }
}

function spawnLineParticles(line) {
  const direction = line.axis === 'x' ? new THREE.Vector3(1, 0, 0) : line.axis === 'y' ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1)
  const color = palette.line[line.axis]
  // Stay in the line hue instead of blowing out to white at the end of life.
  const brightEnd = new THREE.Color(color).lerp(new THREE.Color(0xffffff), 0.42)
  const system = new ParticleSystem({
    autoDestroy: true,
    looping: false,
    duration: 0.72,
    startLife: new ConstantValue(0.62),
    startSpeed: new ConstantValue(1.45),
    startSize: new ConstantValue(0.09),
    startColor: new ConstantColor(colorToVector4(color)),
    emissionOverTime: new ConstantValue(0),
    emissionBursts: [{ time: 0, count: quality.particlesPerLine, cycle: 1, interval: 0.01, probability: 1 }],
    shape: new AxisEmitter(direction),
    material: particleMaterial,
    instancingGeometry: particleGeometry,
    renderMode: RenderMode.Mesh,
    renderOrder: 4,
    worldSpace: true,
    behaviors: [
      new ColorOverLife(new Gradient([
        [new THREE.Vector3(new THREE.Color(color).r, new THREE.Color(color).g, new THREE.Color(color).b), 0],
        [new THREE.Vector3(brightEnd.r, brightEnd.g, brightEnd.b), 1],
      ], [[1, 0.95], [0, 0.02]])),
      new SizeOverLife(new PiecewiseBezier([[new Bezier(1, 1.15, 0.4, 0), 0]])),
    ],
  })
  const first = line.cells[0]
  const last = line.cells[line.cells.length - 1]
  const center = cellToWorld(
    (first[0] + last[0]) / 2,
    (first[1] + last[1]) / 2,
    (first[2] + last[2]) / 2,
  )
  system.emitter.position.copy(center)
  scene.add(system.emitter)
  system.emitter.updateMatrixWorld(true)
  particleRenderer.addSystem(system)
  particleSystems.add(system)
}

function spawnLineBeam(line, index) {
  const first = line.cells[0]
  const last = line.cells[line.cells.length - 1]
  const center = cellToWorld(
    (first[0] + last[0]) / 2,
    (first[1] + last[1]) / 2,
    (first[2] + last[2]) / 2,
  )
  const beam = new THREE.Mesh(beamGeometry, new THREE.MeshBasicMaterial({
    color: palette.line[line.axis],
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  }))
  if (line.axis === 'y') beam.rotation.z = Math.PI / 2
  if (line.axis === 'z') beam.rotation.y = Math.PI / 2
  beam.position.copy(center)
  fxGroup.add(beam)
  transientEffects.push({
    object: beam,
    elapsed: -index * 0.035,
    duration: 0.56,
    update: (effect, delta) => {
      effect.elapsed += delta
      const progress = THREE.MathUtils.clamp(effect.elapsed / effect.duration, 0, 1)
      const pulse = progress < 0.25 ? progress / 0.25 : 1 - (progress - 0.25) / 0.75
      effect.object.material.opacity = Math.max(0, pulse) * VFX_CONFIG.clear.beamOpacity
      const scale = progress < 0.25 ? 0.72 + progress * 1.12 : 1.0
      effect.object.scale.setScalar(scale)
    },
  })
  spawnLineParticles(line)
}

function spawnClearStars(line, index) {
  const first = line.cells[0]
  const last = line.cells[line.cells.length - 1]
  const center = cellToWorld(
    (first[0] + last[0]) / 2,
    (first[1] + last[1]) / 2,
    (first[2] + last[2]) / 2,
  )
  // Celebratory stars stay warm (yellow/orange) instead of flashing white.
  ;[0xffd32a, 0xff9c3d].forEach((color, starIndex) => {
    const material = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      depthWrite: false,
      toneMapped: false,
    })
    const star = new THREE.Mesh(starGeometry, material)
    star.position.copy(center)
    fxGroup.add(star)
    transientEffects.push({
      object: star,
      elapsed: -index * 0.02,
      duration: VFX_CONFIG.clear.starDuration,
      update: (effect, delta) => {
        effect.elapsed += delta
        const progress = THREE.MathUtils.clamp(effect.elapsed / effect.duration, 0, 1)
        const pop = progress < 0.22 ? 0.1 + (progress / 0.22) * 1.0 : 1.1 - ((progress - 0.22) / 0.78) * 0.18
        const base = starIndex === 0 ? 1 : 0.6
        effect.object.quaternion.copy(camera.quaternion)
        effect.object.scale.setScalar(base * pop * VFX_CONFIG.clear.starMaxScale)
        const fade = progress < 0.12 ? progress / 0.12 : progress > 0.55 ? 1 - (progress - 0.55) / 0.45 : 1
        effect.object.material.opacity = Math.max(0, fade) * 0.85
      },
    })
  })
}

function spawnClearEffects(lines) {
  lines.forEach((line, index) => {
    spawnLineBeam(line, index)
    spawnClearStars(line, index)
  })
  triggerShake(lines.length > 1 ? 0.12 : 0.055)
}

function updateTransientEffects(delta) {
  transientEffects = transientEffects.filter((effect) => {
    effect.update(effect, delta)
    if (effect.elapsed < effect.duration) return true
    fxGroup.remove(effect.object)
    if (effect.object.material) effect.object.material.dispose()
    return false
  })
}

function clearTransientEffects() {
  transientEffects.forEach((effect) => {
    fxGroup.remove(effect.object)
    if (effect.object.material) effect.object.material.dispose()
  })
  transientEffects = []
  particleSystems.forEach((system) => system.dispose())
  particleSystems.clear()
}

function triggerShake(amount) { cameraShake = Math.max(cameraShake, amount) }
function updateCameraShake(delta) {
  cameraShake = Math.max(0, cameraShake - delta * 0.42)
  camera.position.copy(cameraBasePosition)
  if (cameraShake > 0) {
    const time = performance.now() * 0.045
    camera.position.x += Math.sin(time) * cameraShake
    camera.position.y += Math.cos(time * 1.17) * cameraShake * 0.7
    camera.position.z += Math.sin(time * 0.83) * cameraShake * 0.5
  }
  camera.lookAt(0, 0, 0)
}

function releaseDragPointer(source, pointerId) {
  try {
    source?.releasePointerCapture?.(pointerId)
  } catch {
    // The browser may have already cancelled the pointer capture.
  }
}

function finishDrag(event) {
  if (!drag || (event?.pointerId !== undefined && event.pointerId !== drag.pointerId)) return
  const currentDrag = drag
  drag = null
  releaseDragPointer(currentDrag.source, currentDrag.pointerId)
  clearGroup(previewGroup)
  setCancelZone(false)
  if (!currentDrag.active) {
    selectedPiece = currentDrag.piece
    updatePieceSlotSelection()
    setStatus('Ready to place')
    return
  }
  suppressPieceClickUntil = performance.now() + 260
  if (currentDrag.inCancelZone) {
    selectedPiece = null
    updatePieceSlotSelection()
    setStatus('Pick a shape')
    showToast('Placement cancelled')
    playHaptic(10)
    return
  }
  if (!currentDrag.valid || !currentDrag.origin) {
    selectedPiece = null
    updatePieceSlotSelection()
    setStatus('Pick a shape')
    showToast('Try another spot')
    return
  }
  const result = board.place(currentCells(currentDrag.piece), currentDrag.origin, currentDrag.piece.shape.color)
  playPlaceSound(result.lines.length)
  playHaptic(result.lines.length > 1 ? [18, 35, 22] : result.lines.length ? [18, 28, 16] : 12)
  currentDrag.piece.used = true
  selectedPiece = null
  renderBoard()
  updatePieceSlotSelection()
  if (result.lines.length) {
    const multiplier = result.lines.length === 1 ? 'x1' : result.lines.length === 2 ? 'x3' : result.lines.length === 3 ? 'x6' : 'x10'
    showToast(`${result.lines.length} LINE${result.lines.length === 1 ? '' : 'S'}  ${multiplier}  +${result.points}`)
    showScorePop(result.points, result.lines.length)
    spawnClearEffects(result.lines)
    setStatus('Clear! Keep building')
  } else setStatus('Pick a shape')
  if (pieces.every((piece) => piece.used)) nextPieces()
  if (!gameEnded && pieces.every((piece) => piece.used || !hasAnyPlacement(piece))) endGame()
}

function hasAnyPlacement(piece) {
  const cells = currentCells(piece)
  for (let x = 0; x < SIZE; x += 1) for (let y = 0; y < SIZE; y += 1) for (let z = 0; z < SIZE; z += 1) {
    if (board.canPlace(cells, { x, y, z })) return true
  }
  return false
}

function endGame() {
  if (gameEnded) return
  gameEnded = true
  isPaused = true
  platform.gameplayStop()
  best = Math.max(best, board.score)
  localStorage.setItem(bestKey, String(best))
  finalScoreEl.textContent = String(board.score).padStart(4, '0')
  finalBestEl.textContent = String(best).padStart(4, '0')
  gameOverEl.classList.remove('hidden')
}

function resetGame() {
  clearTransientEffects()
  board.clear()
  gameEnded = false
  settingsOpen = false
  isPaused = document.hidden
  cameraShake = 0
  settingsEl.classList.add('hidden')
  gameOverEl.classList.add('hidden')
  selectedPiece = null
  drag = null
  setCancelZone(false)
  nextPieces()
  renderBoard()
  setStatus('Pick a shape')
  if (!isPaused) platform.gameplayStart()
}

function resetView() {
  cameraAzimuth = defaultCameraAzimuth
  cameraZoom = 1
  fitCameraToPlaySpace()
}

function beginViewDrag(event) {
  if (isPaused || drag || viewDrag || event.pointerType === 'mouse' && event.button !== 0) return
  event.preventDefault()
  viewDrag = {
    pointerId: event.pointerId,
    source: event.currentTarget,
    startX: event.clientX,
    startAzimuth: cameraAzimuth,
    moved: false,
  }
  try {
    event.currentTarget.setPointerCapture?.(event.pointerId)
  } catch {
    // Some embedded browsers can reject capture after an interrupted gesture.
  }
}

function finishViewDrag(event) {
  if (!viewDrag || (event?.pointerId !== undefined && event.pointerId !== viewDrag.pointerId)) return
  const currentViewDrag = viewDrag
  viewDrag = null
  releaseDragPointer(currentViewDrag.source, currentViewDrag.pointerId)
}

renderer.domElement.addEventListener('pointerdown', beginViewDrag)
window.addEventListener('pointermove', (event) => {
  if (viewDrag && event.pointerId === viewDrag.pointerId) {
    event.preventDefault()
    const travel = event.clientX - viewDrag.startX
    if (Math.abs(travel) < 3) return
    viewDrag.moved = true
    const width = Math.max(sceneWrap.clientWidth, 1)
    // Horizontal swipe rotates the camera around the play-space's world Y axis.
    cameraAzimuth = viewDrag.startAzimuth + travel / width * Math.PI
    fitCameraToPlaySpace()
    return
  }
  if (!drag || event.pointerId !== drag.pointerId) return
  event.preventDefault()
  if (!drag.active && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 6) return
  if (!drag.active) {
    drag.active = true
    setCancelZone(true)
  }
  drag.inCancelZone = isInsidePieceArea(event)
  setCancelZone(true, drag.inCancelZone)
  if (drag.inCancelZone) {
    drag.valid = false
    drag.origin = null
    clearGroup(previewGroup)
    setStatus('Release to cancel')
    return
  }
  const hit = pointerPoint(event)
  drag.point = hit.point
  drag.ndc = hit.ndc
  updatePreview(hit.point)
  setStatus(drag.valid ? 'Release to place' : 'No room here')
}, { passive: false })
window.addEventListener('pointerup', (event) => {
  finishViewDrag(event)
  finishDrag(event)
})
window.addEventListener('pointercancel', (event) => {
  finishViewDrag(event)
  if (!drag || event.pointerId !== drag.pointerId) return
  cancelActiveDrag(false)
})
renderer.domElement.addEventListener('wheel', (event) => {
  event.preventDefault()
  cameraZoom = THREE.MathUtils.clamp(cameraZoom * (event.deltaY > 0 ? 0.92 : 1.08), minCameraZoom, maxCameraZoom)
  fitCameraToPlaySpace()
}, { passive: false })
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && drag) { event.preventDefault(); cancelActiveDrag(); return }
  if (event.key === 'Escape' && settingsOpen) { closeSettings(); return }
  if (settingsOpen) return
  if (event.key.toLowerCase() === 'r') resetView()
})
window.addEventListener('contextmenu', (event) => {
  if (!drag) return
  event.preventDefault()
  cancelActiveDrag()
})
for (const button of document.querySelectorAll('.rotate-button')) button.addEventListener('click', () => resetView())
for (const button of document.querySelectorAll('#reset-button, #reset-modal')) button.addEventListener('click', resetGame)
settingsButtonEl.addEventListener('click', openSettings)
document.querySelector('#settings-close').addEventListener('click', closeSettings)
settingsEl.addEventListener('pointerdown', (event) => { if (event.target === settingsEl) closeSettings() })
soundSettingEl.addEventListener('click', () => {
  soundOn = !soundOn
  localStorage.setItem(soundKey, soundOn ? 'on' : 'off')
  updateSettingsUi()
  if (soundOn) playTone(520, 0.08, 0.035)
})
hapticsSettingEl.addEventListener('click', () => {
  hapticsOn = !hapticsOn
  localStorage.setItem(hapticsKey, hapticsOn ? 'on' : 'off')
  updateSettingsUi()
  if (hapticsOn) playHaptic(18)
})
document.querySelector('#view-setting').addEventListener('click', () => { resetView(); closeSettings(); showToast('View reset') })
document.querySelector('#restart-setting').addEventListener('click', resetGame)
document.addEventListener('visibilitychange', () => {
  if (document.hidden && drag) cancelActiveDrag(false)
  isPaused = document.hidden || gameEnded || settingsOpen
  if (document.hidden) { platform.gameplayStop(); setStatus('Paused') }
  else if (gameEnded || settingsOpen) return
  else { platform.gameplayStart(); setStatus('Pick a shape') }
})
updateSettingsUi()

function resize() {
  const width = sceneWrap.clientWidth
  const height = sceneWrap.clientHeight
  renderer.setSize(width, height, false)
  composer.setSize(width, height)
  refreshCameraProjection()
  fitCameraToPlaySpace()
}
window.addEventListener('resize', resize)
resize()
resetGame()
platform.initialize().catch(() => showToast('Offline mode'))

const clock = new THREE.Clock()
function animate() {
  requestAnimationFrame(animate)
  const delta = Math.min(clock.getDelta(), 0.05)
  if (!isPaused) {
    particleRenderer.update(delta)
    updateTransientEffects(delta)
  }
  updatePiecePreviews()
  updateCameraShake(delta)
  candidateGroup.children.forEach((mesh, index) => {
    mesh.material.opacity = 0.1 + Math.sin(performance.now() * 0.003 + index) * 0.05
  })
  composer.render(delta)
}
animate()

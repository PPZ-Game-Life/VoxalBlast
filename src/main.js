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
import { SHAPES, keyOf, normalizeCells, rotateCells } from './game/shapes.js'
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
let isPaused = false
let gameEnded = false
let settingsOpen = false
let soundOn = localStorage.getItem(soundKey) !== 'off'
let hapticsOn = localStorage.getItem(hapticsKey) !== 'off'
let audioContext
let toastTimer
let cameraShake = 0
let transientEffects = []
const particleSystems = new Set()

const quality = getRenderQuality()

const scene = new THREE.Scene()
scene.background = null
scene.fog = new THREE.Fog(palette.background, 17, 30)
const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100)
const cameraBasePosition = new THREE.Vector3()
const cameraDirection = new THREE.Vector3(0.82, 0.76, 1).normalize()
const cameraTarget = new THREE.Vector3(0, 0, 0)

function fitCameraToPlaySpace() {
  const isMobile = sceneWrap.clientWidth < 700
  camera.fov = isMobile ? 37 : 34
  camera.aspect = Math.max(sceneWrap.clientWidth / Math.max(sceneWrap.clientHeight, 1), 0.5)
  camera.updateProjectionMatrix()

  // Fit the eight actual play-space corners rather than a conservative sphere.
  // This keeps the floating cube large while preserving a safe edge margin.
  camera.position.copy(cameraDirection)
  camera.lookAt(cameraTarget)
  camera.updateMatrixWorld(true)
  const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0)
  const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1)
  const verticalTan = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)
  const horizontalTan = verticalTan * camera.aspect
  const safeFactor = isMobile ? 0.84 : 0.88
  const min = -boardSpan / 2
  const max = boardSpan / 2
  let distance = 0
  for (const x of [min, max]) for (const y of [min, max]) for (const z of [min, max]) {
    const corner = new THREE.Vector3(x, y, z)
    const depthOffset = corner.dot(cameraDirection)
    distance = Math.max(
      distance,
      depthOffset + Math.abs(corner.dot(right)) / (horizontalTan * safeFactor),
      depthOffset + Math.abs(corner.dot(up)) / (verticalTan * safeFactor),
    )
  }
  cameraBasePosition.copy(cameraDirection).multiplyScalar(distance)
  camera.position.copy(cameraBasePosition)
  camera.lookAt(cameraTarget)
}

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
const particleMaterial = new THREE.MeshBasicMaterial({
  color: 0xffffff,
  transparent: true,
  opacity: 0.92,
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

  // Eight short corner brackets replace the previous full 3D cage. They
  // communicate the play-space volume without turning it into a wireframe box.
  const corners = [
    new THREE.Vector3(min, min, min), new THREE.Vector3(max, min, min),
    new THREE.Vector3(min, max, min), new THREE.Vector3(max, max, min),
    new THREE.Vector3(min, min, max), new THREE.Vector3(max, min, max),
    new THREE.Vector3(min, max, max), new THREE.Vector3(max, max, max),
  ]
  const edgeMaterial = new THREE.LineBasicMaterial({
    color: palette.navy,
    transparent: true,
    opacity: 0.38,
    depthWrite: false,
  })
  const bracketLength = 0.46
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

  const markerGeometry = new RoundedBoxGeometry(0.18, 0.18, 0.18, 3, 0.045)
  const markerMaterial = new THREE.MeshStandardMaterial({
    color: palette.navyDeep,
    roughness: 0.5,
    transparent: true,
    opacity: 0.66,
  })
  corners.forEach((corner) => {
    const marker = new THREE.Mesh(markerGeometry, markerMaterial)
    marker.position.copy(corner)
    gridGroup.add(marker)
  })
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
  return { shape, cells: normalizeCells(shape.cells), rotations: { x: 0, y: 0, z: 0 }, used: false }
}

function currentCells(piece) {
  let cells = piece.shape.cells
  for (const axis of ['x', 'y', 'z']) for (let i = 0; i < piece.rotations[axis]; i += 1) cells = rotateCells(cells, axis)
  return normalizeCells(cells)
}

function rotationVariants(piece) {
  const variants = []
  const seen = new Set()
  for (let rx = 0; rx < 4; rx += 1) for (let ry = 0; ry < 4; ry += 1) for (let rz = 0; rz < 4; rz += 1) {
    let cells = piece.shape.cells
    for (let i = 0; i < rx; i += 1) cells = rotateCells(cells, 'x')
    for (let i = 0; i < ry; i += 1) cells = rotateCells(cells, 'y')
    for (let i = 0; i < rz; i += 1) cells = rotateCells(cells, 'z')
    cells = normalizeCells(cells)
    const signature = cells.map((cell) => cell.join(',')).join('|')
    if (!seen.has(signature)) { seen.add(signature); variants.push(cells) }
  }
  return variants
}

function nextPieces() {
  pieces = Array.from({ length: 3 }, () => makePiece(SHAPES[Math.floor(Math.random() * SHAPES.length)]))
  selectedPiece = null
  renderPieceSlots()
}

function colorHex(color) {
  return `#${new THREE.Color(color).getHexString()}`
}

function renderPieceSlots() {
  slotsEl.innerHTML = ''
  pieces.forEach((piece, index) => {
    const slot = document.createElement('button')
    slot.className = `piece-slot${piece.used ? ' used' : ''}${selectedPiece === piece ? ' selected' : ''}`
    slot.type = 'button'
    slot.dataset.index = index
    slot.style.setProperty('--piece-color', colorHex(piece.shape.color))

    const thumb = document.createElement('span')
    thumb.className = 'piece-thumb'
    const cells = currentCells(piece)
    cells.forEach(([x, y, z]) => {
      const cell = document.createElement('span')
      cell.className = 'piece-thumb-cell'
      cell.style.left = `${7 + x * 11 + z * 3}px`
      cell.style.top = `${7 + y * 11 - z * 3}px`
      cell.style.backgroundColor = colorHex(piece.shape.color)
      cell.style.setProperty('--depth', `${z * 3}px`)
      thumb.appendChild(cell)
    })

    const meta = document.createElement('span')
    meta.className = 'piece-meta'
    meta.innerHTML = `<span class="piece-index">0${index + 1}</span><span class="piece-name">${piece.shape.name}</span><span class="piece-count">${piece.shape.cells.length} VOXELS</span>`
    slot.append(thumb, meta)
    slot.addEventListener('pointerdown', (event) => beginDrag(event, piece))
    slot.addEventListener('click', () => {
      if (!piece.used && !drag) { selectedPiece = piece; renderPieceSlots(); setStatus('READY TO PLACE') }
    })
    slotsEl.appendChild(slot)
  })
}

function setStatus(text) { statusEl.textContent = text }
function showToast(text) {
  toastEl.textContent = text
  toastEl.classList.add('visible')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => toastEl.classList.remove('visible'), 1500)
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
  if (drag) {
    releaseDragPointer(drag.source, drag.pointerId)
    drag = null
    selectedPiece = null
    renderPieceSlots()
  }
  clearGroup(previewGroup)
  settingsEl.classList.remove('hidden')
  platform.gameplayStop()
  setStatus('PAUSED')
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
    setStatus('PLACE A SHAPE')
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

function rotatePiece(axis) {
  const piece = selectedPiece || pieces.find((item) => !item.used)
  if (!piece || isPaused) return
  selectedPiece = piece
  piece.rotations[axis] = (piece.rotations[axis] + 1) % 4
  renderPieceSlots()
  updatePreview(drag?.point)
  setStatus(`ROTATED ${axis.toUpperCase()}`)
}

const raycaster = new THREE.Raycaster()
const pointer = new THREE.Vector2()
const boardPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 2.65)
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
  setStatus('DRAG TO GRID')
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
  setStatus(valid ? 'RELEASE TO PLACE' : 'INVALID POSITION')
}

class AxisEmitter {
  constructor(direction, spread = 0.3) {
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
        [new THREE.Vector3(1, 1, 1), 1],
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
      effect.object.material.opacity = Math.max(0, pulse) * 0.72
      const scale = progress < 0.25 ? 0.72 + progress * 1.12 : 1.0
      effect.object.scale.setScalar(scale)
    },
  })
  spawnLineParticles(line)
}

function spawnClearEffects(lines) {
  lines.forEach((line, index) => spawnLineBeam(line, index))
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
  if (!currentDrag.active) {
    selectedPiece = currentDrag.piece
    renderPieceSlots()
    setStatus('READY TO PLACE')
    return
  }
  if (!currentDrag.valid || !currentDrag.origin) { setStatus('PLACE A SHAPE'); return }
  const result = board.place(currentCells(currentDrag.piece), currentDrag.origin, currentDrag.piece.shape.color)
  playPlaceSound(result.lines.length)
  playHaptic(result.lines.length > 1 ? [18, 35, 22] : result.lines.length ? [18, 28, 16] : 12)
  currentDrag.piece.used = true
  selectedPiece = null
  renderBoard()
  renderPieceSlots()
  if (result.lines.length) {
    const multiplier = result.lines.length === 1 ? 'x1' : result.lines.length === 2 ? 'x3' : result.lines.length === 3 ? 'x6' : 'x10'
    showToast(`${result.lines.length} LINE${result.lines.length === 1 ? '' : 'S'}  ${multiplier}  +${result.points}`)
    showScorePop(result.points, result.lines.length)
    spawnClearEffects(result.lines)
    setStatus('CLEAR! KEEP BUILDING')
  } else setStatus('PLACE A SHAPE')
  if (pieces.every((piece) => piece.used)) nextPieces()
  if (!gameEnded && pieces.every((piece) => piece.used || !hasAnyPlacement(piece))) endGame()
}

function hasAnyPlacement(piece) {
  return rotationVariants(piece).some((cells) => {
    for (let x = 0; x < SIZE; x += 1) for (let y = 0; y < SIZE; y += 1) for (let z = 0; z < SIZE; z += 1) {
      if (board.canPlace(cells, { x, y, z })) return true
    }
    return false
  })
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
  nextPieces()
  renderBoard()
  setStatus('PLACE A SHAPE')
  if (!isPaused) platform.gameplayStart()
}

function resetView() {
  fitCameraToPlaySpace()
}

window.addEventListener('pointermove', (event) => {
  if (!drag || event.pointerId !== drag.pointerId) return
  event.preventDefault()
  if (!drag.active && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 6) return
  drag.active = true
  const hit = pointerPoint(event)
  drag.point = hit.point
  drag.ndc = hit.ndc
  updatePreview(hit.point)
  setStatus(drag.valid ? 'RELEASE TO PLACE' : 'DRAG TO GRID')
}, { passive: false })
window.addEventListener('pointerup', finishDrag)
window.addEventListener('pointercancel', (event) => {
  if (!drag || event.pointerId !== drag.pointerId) return
  const source = drag.source
  const pointerId = drag.pointerId
  drag = null
  releaseDragPointer(source, pointerId)
  clearGroup(previewGroup)
  selectedPiece = null
  renderPieceSlots()
  setStatus('PLACE A SHAPE')
})
renderer.domElement.addEventListener('wheel', (event) => { event.preventDefault(); rotatePiece(event.deltaY > 0 ? 'y' : 'x') }, { passive: false })
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && settingsOpen) { closeSettings(); return }
  if (settingsOpen) return
  if (event.key.toLowerCase() === 'r') resetView()
  if (['w', 'a', 's', 'd'].includes(event.key.toLowerCase())) rotatePiece(event.key.toLowerCase() === 'w' || event.key.toLowerCase() === 's' ? 'x' : 'y')
})
for (const button of document.querySelectorAll('.rotate-button')) button.addEventListener('click', () => button.dataset.axis ? rotatePiece(button.dataset.axis) : resetView())
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
document.querySelector('#view-setting').addEventListener('click', () => { resetView(); closeSettings(); showToast('VIEW RESET') })
document.querySelector('#restart-setting').addEventListener('click', resetGame)
document.addEventListener('visibilitychange', () => {
  isPaused = document.hidden || gameEnded || settingsOpen
  if (document.hidden) { platform.gameplayStop(); setStatus('PAUSED') }
  else if (gameEnded || settingsOpen) return
  else { platform.gameplayStart(); setStatus('PLACE A SHAPE') }
})
updateSettingsUi()

function resize() {
  const width = sceneWrap.clientWidth
  const height = sceneWrap.clientHeight
  renderer.setSize(width, height, false)
  composer.setSize(width, height)
  fitCameraToPlaySpace()
}
window.addEventListener('resize', resize)
resize()
resetGame()
platform.initialize().catch(() => showToast('PLATFORM MODE OFFLINE'))

const clock = new THREE.Clock()
function animate() {
  requestAnimationFrame(animate)
  const delta = Math.min(clock.getDelta(), 0.05)
  if (!isPaused) {
    particleRenderer.update(delta)
    updateTransientEffects(delta)
  }
  updateCameraShake(delta)
  candidateGroup.children.forEach((mesh, index) => {
    mesh.material.opacity = 0.1 + Math.sin(performance.now() * 0.003 + index) * 0.05
  })
  composer.render(delta)
}
animate()

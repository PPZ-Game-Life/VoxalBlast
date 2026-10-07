// ART_RECIPE / ART_ASSETS are injected by the offline pack builder (not game globals).
import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
async function main() {
const recipe = ART_RECIPE
const assets = ART_ASSETS
const canvas = document.querySelector('#scene')
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false })
renderer.setPixelRatio(1)
renderer.setSize(canvas.clientWidth, canvas.clientHeight, false)
renderer.outputColorSpace = THREE.SRGBColorSpace
renderer.toneMapping = THREE.NeutralToneMapping // Art-only lab; game uses its existing composer TM instead.
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFSoftShadowMap
const scene = new THREE.Scene()
scene.background = new THREE.Color('#9BD6F4')
const aspect = canvas.clientWidth / canvas.clientHeight
const camera = new THREE.OrthographicCamera(-4*aspect, 4*aspect, 4, -4, 0.1, 100)
camera.position.set(8, 5.2, 24)
camera.lookAt(0, 0, 0)
const lighting = recipe.lighting
scene.add(new THREE.HemisphereLight(lighting.hemisphere.sky, lighting.hemisphere.ground, lighting.hemisphere.intensity))
const key = new THREE.DirectionalLight(lighting.key.color, lighting.key.intensity)
key.position.set(...lighting.key.position)
key.castShadow = true
key.shadow.mapSize.set(1024, 1024)
Object.assign(key.shadow.camera, { left: -14, right: 14, top: 7, bottom: -7, near: 0.1, far: 50 })
key.shadow.bias = -0.00015
key.shadow.normalBias = 0.012
scene.add(key)
const fill = new THREE.DirectionalLight(lighting.fill.color, lighting.fill.intensity)
fill.position.set(...lighting.fill.position)
scene.add(fill)
const groundGeometry = new THREE.PlaneGeometry(60, 16)
const ground = new THREE.Mesh(groundGeometry, new THREE.MeshBasicMaterial({ color: recipe.palette.empty }))
ground.rotation.x = -Math.PI/2
ground.position.set(0,-3.25,5)
scene.add(ground)
const receiver = new THREE.Mesh(groundGeometry, new THREE.ShadowMaterial({ color: '#20334C', opacity: 0.18 }))
receiver.rotation.copy(ground.rotation)
receiver.position.copy(ground.position).y += 0.002
receiver.receiveShadow = true
scene.add(receiver)
const g = recipe.geometry.board
const geometry = new RoundedBoxGeometry(g.size, g.size, g.size, g.segments, g.radius)
const mat = color => new THREE.MeshPhysicalMaterial({ color, ...recipe.materials.paint })
const colors = { '.': recipe.palette.empty, B: recipe.palette.royalBlue, V: recipe.palette.violet, T: recipe.palette.teal }
const mats = Object.fromEntries(Object.entries(colors).map(([key, color]) => [key, mat(color)]))
Object.assign(mats['.'], recipe.materials.empty)
const board = new THREE.Group()
const pattern = ['BB...', '.BB..', '...VV', 'T..VV', 'TT...']
let count = 0
for (let x=-2;x<=2;x++) for (let y=-2;y<=2;y++) for (let z=-2;z<=2;z++) {
  if (Math.max(Math.abs(x),Math.abs(y),Math.abs(z))!==2) continue
  const color = z===2 ? pattern[2-y][x+2] : '.'
  const block = new THREE.Mesh(geometry, mats[color])
  block.position.set(x,y,z)
  block.castShadow = true
  block.receiveShadow = true
  board.add(block); count++
}
const hull = new THREE.Mesh(new RoundedBoxGeometry(4.32,4.32,4.32,3,0.08), new THREE.MeshStandardMaterial({color:recipe.palette.hull,roughness:1}))
board.add(hull)
board.scale.setScalar(0.8)
board.position.set(-7,0,0)
scene.add(board)
const groups = []
const loader = new GLTFLoader()
const modelNames = ['floating-arch','floating-stairs','floating-ledge']
for (let i=0;i<modelNames.length;i++) {
  const bytes = Uint8Array.from(atob(assets[`models/${modelNames[i]}.glb`]), c=>c.charCodeAt(0))
  const gltf = await loader.parseAsync(bytes.buffer, '')
  const object = gltf.scene
  object.scale.setScalar(0.67)
  object.position.set(-1.6+i*4,0.1,0)
  object.traverse(child => { if(child.isMesh) {child.castShadow=true;child.receiveShadow=true} })
  scene.add(object)
  groups.push(object)
}
const cloudSprites = []
window.__cloudPngs = {}
for (const [i,name] of ['cloud-a','cloud-b','cloud-c'].entries()) {
  const image = new Image()
  image.src = `data:image/svg+xml;base64,${assets[`clouds/${name}.svg`]}`
  await image.decode()
  const buffer = document.createElement('canvas')
  buffer.width=512; buffer.height=192
  buffer.getContext('2d').drawImage(image,0,0,512,192)
  window.__cloudPngs[name] = buffer.toDataURL('image/png')
  const texture = new THREE.CanvasTexture(buffer)
  texture.colorSpace = THREE.SRGBColorSpace
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({map:texture,depthWrite:false,transparent:true}))
  sprite.scale.set(4.8,1.8,1)
  sprite.position.set(-8+i*7,1.5,-4)
  scene.add(sprite)
  cloudSprites.push(sprite)
}
const still = new URL(location.href).searchParams.has('still')
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
let time=0,previous=performance.now()
function draw(now) {
  requestAnimationFrame(draw)
  if(document.hidden){previous=now;return}
  const dt=Math.max(0,Math.min(0.05,(now-previous)/1000));previous=now
  if(!still&&!reduced)time+=dt
  board.position.y=0.02*Math.sin(time*2*Math.PI/5.5)
  groups.forEach((object,i)=>object.position.y=0.1+0.12*Math.sin(time*2*Math.PI/7.5+i*1.3))
  cloudSprites.forEach((sprite,i)=>sprite.position.x=(((-8+i*7)+time*0.18+14)%28)-14)
  renderer.render(scene,camera)
  window.__artReady=true
  window.__artStats={boardCells:count,models:groups.length,clouds:cloudSprites.length,drawCalls:renderer.info.render.calls,triangles:renderer.info.render.triangles,time,cloudX:cloudSprites.map(sprite=>sprite.position.x),still,reducedMotion:reduced}
}
requestAnimationFrame(draw)
}
main().catch(error => { window.__artError = String(error?.stack || error); console.error(error) })

// Rebuild only this handoff pack: GLBs, manifest and an offline art-only preview.
// Does NOT import main.js, mutate game state, or patch production rendering.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js'
import { build } from 'esbuild'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const pack = path.join(root, 'public/art/floating-world-v1')
const evidence = path.join(root, 'docs/Art/floating-world-v1')
const recipe = JSON.parse(fs.readFileSync(path.join(pack, 'scene.recipe.json'), 'utf8'))
fs.mkdirSync(path.join(pack, 'models'), { recursive: true })
fs.mkdirSync(evidence, { recursive: true })
// GLTFExporter uses FileReader for binary blobs; Node provides Blob but not FileReader.
globalThis.FileReader ??= class {
  readAsArrayBuffer(blob) { blob.arrayBuffer().then(value => { this.result = value; this.onloadend?.() }, error => this.onerror?.(error)) }
  readAsDataURL(blob) { blob.arrayBuffer().then(value => { this.result = `data:${blob.type || 'application/octet-stream'};base64,${Buffer.from(value).toString('base64')}`; this.onloadend?.() }, error => this.onerror?.(error)) }
}
const exporter = new GLTFExporter()
const materialCache = new Map()
function material(color) {
  if (!materialCache.has(color)) {
    const m = new THREE.MeshStandardMaterial({ color, roughness: recipe.materials.background.roughness, metalness: 0 })
    m.name = `paint-${color.substring(1)}`
    materialCache.set(color, m)
  }
  return materialCache.get(color)
}
const background = recipe.geometry.background
const bgGeometry = new RoundedBoxGeometry(background.size, background.size, background.size, background.segments, background.radius)
async function exportModel(name, group) {
  group.name = name
  group.userData = { artPack: recipe.schema, pivot: 'origin after subtracting recipe pivot', status: 'handoff mesh; runtime should instance recipe cells' }
  const binary = await exporter.parseAsync(group, { binary: true, onlyVisible: true })
  fs.writeFileSync(path.join(pack, 'models', `${name}.glb`), Buffer.from(binary))
}
for (const [name, prefab] of Object.entries(recipe.prefabs)) {
  const group = new THREE.Group()
  prefab.cells.forEach(([x, y, z, color], index) => {
    const mesh = new THREE.Mesh(bgGeometry, material(recipe.palette[color]))
    mesh.name = `${name}-cell-${index}`
    mesh.position.set(x - prefab.pivot[0], y - prefab.pivot[1], z - prefab.pivot[2])
    group.add(mesh)
  })
  await exportModel(name, group)
}
const board = recipe.geometry.board
const unit = new THREE.Group()
unit.add(new THREE.Mesh(new RoundedBoxGeometry(board.size, board.size, board.size, board.segments, board.radius), material(recipe.palette.empty)))
await exportModel('block-unit', unit)

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(item => item.isDirectory() ? walk(path.join(dir, item.name)) : [path.join(dir, item.name)])
}
const files = walk(pack).filter(file => path.basename(file) !== 'manifest.json').sort()
const manifest = {
  schema: recipe.schema,
  status: 'art assets only; production integration pending',
  basis: 'VoxalBlast v0.12.0 / source review HEAD 5d307a8',
  runtimeBase: '/art/floating-world-v1/',
  totals: { files: files.length, bytes: files.reduce((n, file) => n + fs.statSync(file).size, 0) },
  geometry: { boardTriangles: unit.children[0].geometry.attributes.position.count / 3, backgroundTriangles: bgGeometry.attributes.position.count / 3 },
  files: files.map(file => {
    const relative = path.relative(pack, file).replaceAll('\\', '/')
    const entry = { path: relative, bytes: fs.statSync(file).size, role: relative.split('/')[0] }
    if (file.endsWith('.svg')) entry.viewBox = fs.readFileSync(file, 'utf8').match(/viewBox="([^"]+)"/)?.[1] ?? null
    return entry
  })
}
fs.writeFileSync(path.join(pack, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')

const inlineAssets = Object.fromEntries(files.filter(f => /\.(svg|glb)$/.test(f)).map(file => [path.relative(pack, file).replaceAll('\\', '/'), fs.readFileSync(file).toString('base64')]))
const previewBundle = await build({
  entryPoints: [path.join(root, 'tools/art/floating-world-preview.mjs')], bundle: true, write: false, format: 'iife', minify: true,
  define: { ART_RECIPE: JSON.stringify(recipe), ART_ASSETS: JSON.stringify(inlineAssets) },
})
const uri = (file, mime) => `data:${mime};base64,${fs.readFileSync(path.join(pack, file)).toString('base64')}`
const icons = files.filter(f => /[\\/]ui[\\/]icon-/.test(f) && !f.endsWith('icon-button.svg'))
const chrome = files.filter(f => /[\\/]ui[\\/]/.test(f) && (!/[\\/]icon-/.test(f) || f.endsWith('icon-button.svg')))
const cards = collection => collection.map(file => `<figure><img src="data:image/svg+xml;base64,${fs.readFileSync(file).toString('base64')}"/><figcaption>${path.basename(file)}</figcaption></figure>`).join('')
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Floating World — asset review, not game UI</title><style>
*{box-sizing:border-box}body{margin:0;padding:24px;background:#e9f3f8;color:#20334c;font:16px Arial,"Microsoft YaHei",sans-serif}h1{font-size:28px;margin:0 0 6px}h2{font-size:20px;margin:18px 0 10px}p{margin:4px 0 12px}.brand{height:122px;display:flex;align-items:center;gap:30px}.brand img{width:290px}.logo-check{padding:10px;border-radius:15px;background:#42abf2}.cream{background:#fff1ce}#scene{width:100%;height:340px;display:block;border:2px solid #20334c;border-radius:18px} .icons,.chrome,.clouds{display:grid;gap:10px}.icons{grid-template-columns:repeat(8,1fr)}.chrome{grid-template-columns:repeat(3,1fr)}.clouds{grid-template-columns:repeat(3,1fr)}figure{margin:0;text-align:center;background:white;border-radius:10px;padding:8px}figure img{height:72px;max-width:100%;object-fit:contain}figcaption{font-size:11px;margin-top:4px}.chrome figure img{height:66px;width:100%}.clouds figure{background:#67b7e9}.clouds img{width:100%;height:58px}.note{font-size:13px;color:#516575}
</style><h1>浮空积木世界 · 资源预览</h1><p>交接资源与独立材质样板，不是实机截图。Three.js 实时模型、统一左上主光、投影、移动云朵与轻浮动。</p><div class="brand"><div class="logo-check"><img src="${uri('brand/logo-1024.webp', 'image/webp')}"></div><div class="logo-check cream"><img src="${uri('brand/logo-512.png', 'image/png')}"></div><p class="note">透明 Logo：PNG / WebP<br>UI 数字、文案仍由 DOM/i18n 输出<br>打开本文件可观看背景轻浮动；?still=1 冻结动画。</p></div><canvas id="scene"></canvas><h2>可编辑矢量图标</h2><div class="icons">${cards(icons)}</div><h2>无文字 UI 底板</h2><div class="chrome">${cards(chrome)}</div><h2>移动云朵轮廓（Sprite 素材）</h2><div class="clouds">${cards(files.filter(f => /[\\/]clouds[\\/]/.test(f) && f.endsWith('.svg')))}</div><p class="note">运行时优先按 scene.recipe.json 实例化积木；GLB 用于交换和审阅。不把整张参考图铺成背景。</p><script>${previewBundle.outputFiles[0].text.replaceAll('</script', '<\\/script')}</script></html>`
// Bundled shader template strings contain harmless trailing whitespace; normalize for Git.
fs.writeFileSync(path.join(evidence, 'asset-preview.html'), html.replace(/[ \t]+$/gm, ''))
console.log(JSON.stringify({ ...manifest.totals, geometry: manifest.geometry, preview: path.relative(root, path.join(evidence, 'asset-preview.html')) }))

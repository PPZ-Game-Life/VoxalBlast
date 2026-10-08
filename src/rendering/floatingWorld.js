// The 「浮空积木世界」 skin's parameter source.
//
// docs/Technical/FLOATING_WORLD_ART_HANDOFF.md §2.5 makes `scene.recipe.json` the art-facing
// knob file: geometry, palette, material response, the light rig, the floating motion and the
// three quality tiers all live there, and Luna edits it. This module is the ONLY reader, and it
// deliberately imports the file rather than re-typing its numbers, so a retuned recipe reaches
// the game without a second copy that can silently drift out of step.
//
// What it is NOT: an asset loader. `manifest.json` lists the delivered files; the GLBs are
// exchange backups (§2.5 — the shipped background is instantiated from the recipe's `cells`),
// and nothing here fetches anything over the network.
//
// Colours arrive as CSS strings and leave as 0xRRGGBB numbers, which is the form Three's
// constructors and the rest of config.js already speak.
// The import attribute is load-bearing: Vite resolves the JSON without it, but the repo's
// `node tools/*.mjs` suites import `config.js` straight into Node's ESM loader (gemMaterial
// pulls the board style in), and Node refuses a JSON module without `with { type: 'json' }`.
import recipe from '../../public/art/floating-world-v1/scene.recipe.json' with { type: 'json' }

const hex = value => Number.parseInt(String(value).replace(/^#/, ''), 16)
const vector = value => Object.freeze(value.map(Number))

export const floatingWorldRecipe = recipe

// The named palette (§3). `ink` is the outline colour the UI line art and the shell's seams
// use; `empty`/`emptyActive` are the two tones a bare block wears.
export const floatingWorldPalette = Object.freeze(
  Object.fromEntries(Object.entries(recipe.palette).map(([name, value]) => [name, hex(value)])),
)

// Stored save colours → displayed paint. The KEYS are the 14 stable gameplay RGB identities
// (referencePalette.js's whole reason for existing): the mapping changes what a block LOOKS
// like and never what a run, a save or a shape is made of.
export const floatingWorldPaint = Object.freeze(
  Object.entries(recipe.paintMapping).map(([stored, shown]) => [Number(stored), hex(shown)]),
)

export const floatingWorldMaterials = recipe.materials
export const floatingWorldGeometry = recipe.geometry

// The four lights, with their colours converted. The positions are copied into frozen arrays
// so a consumer spreading them into `light.position.set(...)` cannot mutate the recipe.
export const floatingWorldLighting = Object.freeze({
  ...recipe.lighting,
  key: Object.freeze({ ...recipe.lighting.key, color: hex(recipe.lighting.key.color), position: vector(recipe.lighting.key.position) }),
  hemisphere: Object.freeze({
    ...recipe.lighting.hemisphere,
    sky: hex(recipe.lighting.hemisphere.sky),
    ground: hex(recipe.lighting.hemisphere.ground),
  }),
  fill: Object.freeze({ ...recipe.lighting.fill, color: hex(recipe.lighting.fill.color), position: vector(recipe.lighting.fill.position) }),
  rim: Object.freeze({ ...recipe.lighting.rim, color: hex(recipe.lighting.rim.color), position: vector(recipe.lighting.rim.position) }),
})

export const floatingWorldShadow = recipe.lighting.shadow
export const floatingWorldMotion = recipe.motion
export const floatingWorldQuality = recipe.quality

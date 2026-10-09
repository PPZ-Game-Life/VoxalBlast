// Visual skin only. Stable game/save RGB identities continue to work for old runs.
// Every block consumer uses this mapping through blockResources.
//
// v0.13.0 「浮空积木世界」: the displayed paint is no longer typed in here — it is
// `scene.recipe.json`'s `paintMapping`, read by rendering/floatingWorld.js. The art handoff
// (§3) is explicit that this is a RENDER mapping: the 14 stored RGB identities stay exactly
// as they are, so a run saved under the old skin loads, deals and scores identically.
import { floatingWorldPaint } from './floatingWorld.js'

const lacquer = new Map(floatingWorldPaint)
const warnedFallbacks = new Set()
const FALLBACK_WARNING_LIMIT = 8

// Unknown historical save colours keep the compatibility fallback. In development the first few
// are reported once, while current legal SHAPES are guarded separately by the art preflight gate.
export function referencePaintColor(color) {
  if (lacquer.has(color)) return lacquer.get(color)
  if (import.meta.env?.DEV && warnedFallbacks.size < FALLBACK_WARNING_LIMIT && !warnedFallbacks.has(color)) {
    warnedFallbacks.add(color)
    console.warn(`[paintMapping] unmapped stored colour 0x${Number(color).toString(16).padStart(6, '0')}; using compatibility fallback`)
  }
  return color
}

export function referencePaintReport(colors) {
  return [...new Set(colors)].map((logical) => ({
    logical,
    logicalHex: `#${Number(logical).toString(16).padStart(6, '0')}`,
    mapped: lacquer.has(logical),
    mappedHex: `#${Number(referencePaintColor(logical)).toString(16).padStart(6, '0')}`,
  }))
}

// Visual skin only. Stable game/save RGB identities continue to work for old runs.
// Every block consumer uses this mapping through blockResources.
//
// v0.13.0 「浮空积木世界」: the displayed paint is no longer typed in here — it is
// `scene.recipe.json`'s `paintMapping`, read by rendering/floatingWorld.js. The art handoff
// (§3) is explicit that this is a RENDER mapping: the 14 stored RGB identities stay exactly
// as they are, so a run saved under the old skin loads, deals and scores identically.
import { floatingWorldPaint } from './floatingWorld.js'

const lacquer = new Map(floatingWorldPaint)
export const referencePaintColor = color => lacquer.get(color) ?? color

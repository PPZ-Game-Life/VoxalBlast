import { BufferAttribute } from 'three'

// ---------------------------------------------------------------------------
// three ⇄ three.quarks compatibility bridge (v0.3.0)
//
// three.quarks 0.10.18 writes the LEGACY partial-upload field when it batches
// particles:
//
//     this.offsetBuffer.updateRange.count = index * 3
//     this.sizeBuffer.updateRange.count   = index
//     ...
//
// three r159 replaced that field with `updateRanges` + `addUpdateRange()`, and r172
// (what this project ships) no longer defines `updateRange` at all. So every write
// threw `TypeError: Cannot set properties of undefined (setting 'count')` — and
// because it throws inside `particleRenderer.update()` at the top of the animation
// loop, the rest of the frame (effects, previews, `composer.render`) never ran:
// **the board froze on the first clear or the first item blast while the game kept
// running underneath**. That is why the honour/celebration feedback could never be
// seen in a browser session.
//
// The bridge exposes the legacy property as a view over three's range list, which is
// exactly the semantics quarks expects (it only ever writes `count` from offset 0).
// It is deleted the moment three.quarks is upgraded to a release that knows about
// `updateRanges` (0.17.x) — see the note in docs/Planning/05.
if (!Object.getOwnPropertyDescriptor(BufferAttribute.prototype, 'updateRange')) {
  Object.defineProperty(BufferAttribute.prototype, 'updateRange', {
    configurable: true,
    get() {
      const attribute = this
      return {
        get offset() {
          return attribute.updateRanges[0]?.start ?? 0
        },
        set offset(value) {
          attribute.clearUpdateRanges()
          attribute.addUpdateRange(value, attribute.count)
        },
        get count() {
          return attribute.updateRanges[0]?.count ?? 0
        },
        set count(value) {
          attribute.clearUpdateRanges()
          attribute.addUpdateRange(0, value)
        },
      }
    },
  })
}

export const THREE_QUARKS_COMPAT = true

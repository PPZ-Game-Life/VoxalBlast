import { BufferAttribute, DepthTexture } from 'three'

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

// ---------------------------------------------------------------------------
// postprocessing ⇄ three compatibility bridge (v0.8.0)
//
// SMAAEffect declares `EffectAttribute.DEPTH`, so the EffectPass that carries it asks
// the composer for a depth texture. `EffectComposer.addPass()` answers by building a
// "stable" depth target, and it builds it from CLONES:
//
//     const inputDepthTexture  = new DepthTexture()
//     const stableDepthTexture = inputDepthTexture.clone()
//     ...
//     this.inputBuffer.depthTexture  = inputDepthTexture
//     this.depthRenderTarget         = new WebGLRenderTarget(..., { depthTexture: stableDepthTexture })
//
// three r172 caches ONE GPU texture per `texture.source`, and a clone shares its source,
// so those two "different" depth textures are a single GL image. `RenderPass` then sets
// `needsDepthBlit`, `EffectComposer.render()` blits that image into itself, and the driver
// refuses it — once per page load:
//
//     GL_INVALID_OPERATION: glBlitFramebuffer:
//     Read and write depth stencil attachments cannot be the same image.
//
// Nothing renders wrong: the effect shaders here never read depth (EffectPass only
// forwards `depth` to an effect whose fragment shader takes that parameter — SMAA, Bloom
// and ToneMapping do not), and the screenshot probe's images are identical with and
// without the failed blit. It is still an invalid GPU call on every load, and `npm run
// shot` counts it as a runtime failure, so the request is cancelled here instead.
//
// A pass holding its own depth texture reports `needsDepthTexture === false`, so the
// composer never creates the aliased pair and never blits it. The texture is never
// attached to a render target and never sampled; it exists to answer that one question.
//
// Delete this the moment postprocessing stops cloning its depth textures — and if an
// effect that really READS depth (SSAO, depth of field, outline) joins the chain, this
// substitution is no longer valid: that effect needs a populated depth target, aliased
// blit or not.
export function skipComposerDepthBlit(pass) {
  const placeholder = new DepthTexture(1, 1)
  placeholder.name = 'VoxalBlast.EffectPassDepthPlaceholder'
  pass.setDepthTexture(placeholder)
}

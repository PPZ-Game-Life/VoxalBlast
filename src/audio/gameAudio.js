// Game audio — one bus, one clock, one place that decides what is heard.
//
// docs/Technical/CLEAR_CELEBRATION_AUDIO_HANDOFF.md §5/§6, implemented 2026-09-30 (v0.10.1).
// Before this module every sound in the game was `effects.js: playTone()`: a bare sine
// oscillator with a short envelope, started straight into `ctx.destination`. There was no
// master, no way to cancel what had already been scheduled, no scene, and a placement that
// cleared three lines fired place + honour + chain as three separate melodies over each
// other (§1, §6.1).
//
// What this module owns:
//   * the CUES. §5.3's first-version route: synthesize each cue from the offline recipes in
//     docs/Technical/assets/clear-celebration/build-audio-previews.mjs and cache the rendered
//     AudioBuffer. No download, no licence, no first-packet weight — and the same family
//     (clean wood knock, short mallet, a restrained bell, a weak paper noise) rather than one
//     electronic beep retuned. The WAVs in the handoff package stay listening references.
//   * the BUS. `source → category gain → master gain → soft safety compressor → analyser →
//     destination` (§6.2). The compressor is insurance, never a substitute for levels.
//   * the VOICE ACCOUNTING. §6.2 caps simultaneous sources (≤12, ≤8 on low power); the oldest
//     low-priority voice goes before a new placement's own touch is ever dropped.
//   * the SCENES. §6.3's point is negative: gameplay being paused and audio being allowed are
//     NOT the same boolean. There are seven scenes, and the fact that the run is over is
//     exactly why the new-record sound must still be allowed to play.
//   * the LIFECYCLE constraints nothing else can enforce: an explicit unlock on the first
//     gesture, a mute that ramps and cancels in ≤20ms, and a hidden page that stops.
//
// Every decision above is observable through `report()`, because the headless checks have to
// be able to tell "it played" from "it intended to play" — the old probe counted
// `createOscillator` calls, which cannot survive pre-rendered buffers and could never have
// detected "muted but still audible" at all (§9).
import { AUDIO_STYLE } from '../rendering/config.js'

// ---------------------------------------------------------------- cue recipes
// Verbatim from the offline generator (build-audio-previews.mjs), so the runtime tone family
// and the audited previews are the SAME sound rather than two things that resemble each
// other. `notes` are [at, midi, duration, kind, gain]; `paper` are [at, duration, gain].
// C4 = 261.63Hz (midi 60).
const CUE_RECIPES = Object.freeze({
  place: Object.freeze({ duration: 0.16, peak: 0.11, notes: [[0, 60, 0.12, 'wood', 1]], paper: [] }),
  'clear-l1': Object.freeze({ duration: 0.42, peak: 0.16, notes: [[0, 60, 0.14, 'wood', 0.65], [0.07, 72, 0.29, 'mallet', 1]], paper: [[0.045, 0.12, 0.055]] }),
  'clear-l2': Object.freeze({ duration: 0.5, peak: 0.18, notes: [[0, 60, 0.14, 'wood', 0.65], [0.065, 72, 0.27, 'mallet', 0.9], [0.15, 76, 0.28, 'mallet', 1]], paper: [[0.045, 0.15, 0.065]] }),
  'clear-l3': Object.freeze({ duration: 0.62, peak: 0.2, notes: [[0, 60, 0.14, 'wood', 0.6], [0.06, 72, 0.26, 'mallet', 0.85], [0.15, 76, 0.28, 'mallet', 0.9], [0.24, 79, 0.32, 'bell', 0.75]], paper: [[0.05, 0.17, 0.08]] }),
  'clear-l4': Object.freeze({ duration: 0.76, peak: 0.22, notes: [[0, 60, 0.14, 'wood', 0.65], [0.055, 72, 0.28, 'mallet', 0.9], [0.15, 76, 0.29, 'mallet', 0.9], [0.25, 79, 0.31, 'mallet', 1], [0.35, 84, 0.34, 'bell', 0.65]], paper: [[0.05, 0.2, 0.09]] }),
  'clear-l5': Object.freeze({ duration: 0.92, peak: 0.24, notes: [[0, 60, 0.14, 'wood', 0.65], [0.055, 72, 0.27, 'mallet', 0.9], [0.15, 76, 0.3, 'mallet', 0.95], [0.25, 79, 0.32, 'mallet', 1], [0.36, 84, 0.45, 'bell', 0.65], [0.36, 76, 0.38, 'mallet', 0.35]], paper: [[0.05, 0.22, 0.1]] }),
  'chain-milestone': Object.freeze({ duration: 0.44, peak: 0.13, notes: [[0, 79, 0.23, 'mallet', 0.8], [0.1, 84, 0.29, 'bell', 0.7]], paper: [] }),
  // v0.10.3 reward signatures (SCORE_REWARD_SIMPLIFICATION_HANDOFF.md §3.2). The three
  // categories have to be TELLABLE APART, and "a different pitch on the same run" is not
  // that: the multi-clear keeps the ascending mallet run (clear-l2..l5 above), the streak is
  // two short knocks that read as 「接上了」, and the face clear is a soft paper sweep under a
  // bright CHORD — simultaneous notes, so it can never be mistaken for an ascending run.
  // `streak-hi` is the capped variant: C>=3 adds one closing bell and stops there (§3.2
  // 「C>=5 音型封顶」), because a streak that kept climbing would be the background hum this
  // whole round removes.
  'streak-2': Object.freeze({ duration: 0.38, peak: 0.17, notes: [[0, 72, 0.15, 'wood', 1], [0.13, 76, 0.2, 'mallet', 0.9]], paper: [] }),
  'streak-hi': Object.freeze({ duration: 0.52, peak: 0.19, notes: [[0, 72, 0.15, 'wood', 1], [0.13, 76, 0.2, 'mallet', 0.9], [0.28, 79, 0.26, 'bell', 0.6]], paper: [] }),
  // The same two knocks, TRIMMED, for the case where the streak is NOT the headline: it rides
  // inside the main cue as one tail (§3.3 allows exactly one extra phrase). It is a separate cue
  // id because a tail must not be a MAIN cue — starting one as `main` would replace the cue it is
  // supposed to sit inside, which is precisely the "three melodies over each other" the audio
  // handoff §6.1 exists to prevent.
  'streak-tail': Object.freeze({ duration: 0.32, peak: 0.15, notes: [[0, 72, 0.14, 'wood', 0.9], [0.12, 76, 0.18, 'mallet', 0.8]], paper: [] }),
  'face-clear': Object.freeze({ duration: 0.66, peak: 0.2, notes: [[0.05, 72, 0.3, 'mallet', 0.7], [0.05, 79, 0.34, 'mallet', 0.6], [0.05, 84, 0.44, 'bell', 0.5]], paper: [[0, 0.3, 0.12]] }),
  'new-best': Object.freeze({ duration: 1.12, peak: 0.25, notes: [[0, 60, 0.18, 'wood', 0.4], [0.08, 72, 0.29, 'mallet', 0.8], [0.2, 76, 0.31, 'mallet', 0.85], [0.32, 79, 0.34, 'mallet', 0.95], [0.46, 84, 0.5, 'bell', 0.8], [0.46, 76, 0.46, 'mallet', 0.4], [0.46, 79, 0.44, 'mallet', 0.35]], paper: [[0.14, 0.26, 0.1]] }),
  'item-hammer': Object.freeze({ duration: 0.25, peak: 0.16, notes: [[0, 53, 0.17, 'wood', 1], [0.035, 65, 0.16, 'mallet', 0.22]], paper: [[0.012, 0.07, 0.1]] }),
  'item-rocket': Object.freeze({ duration: 0.34, peak: 0.14, notes: [[0.04, 67, 0.19, 'mallet', 0.5], [0.12, 72, 0.18, 'mallet', 0.45]], paper: [[0, 0.24, 0.24]] }),
  'item-bomb': Object.freeze({ duration: 0.36, peak: 0.15, notes: [[0, 55, 0.19, 'wood', 0.8], [0.08, 67, 0.22, 'mallet', 0.36]], paper: [[0.018, 0.23, 0.22]] }),
  'item-refresh': Object.freeze({ duration: 0.3, peak: 0.12, notes: [[0.015, 67, 0.11, 'wood', 0.4], [0.1, 72, 0.14, 'wood', 0.45]], paper: [[0, 0.1, 0.2], [0.105, 0.12, 0.15]] }),
  cancel: Object.freeze({ duration: 0.15, peak: 0.07, notes: [[0, 57, 0.12, 'wood', 1]], paper: [] }),
  'chain-break': Object.freeze({ duration: 0.34, peak: 0.09, notes: [[0, 67, 0.16, 'wood', 0.8], [0.1, 64, 0.19, 'wood', 0.65]], paper: [] }),
  'score-tick': Object.freeze({ duration: 0.07, peak: 0.035, notes: [[0, 76, 0.055, 'wood', 1]], paper: [] }),
  'score-settle': Object.freeze({ duration: 0.28, peak: 0.09, notes: [[0, 72, 0.18, 'mallet', 0.7], [0.055, 79, 0.2, 'mallet', 0.65]], paper: [] }),
  'game-over': Object.freeze({ duration: 0.46, peak: 0.1, notes: [[0, 64, 0.24, 'wood', 0.75], [0.15, 60, 0.24, 'mallet', 0.55]], paper: [] }),
})

// The three voices of the family (§5.1). `[ratio, amplitude, partialDecaySeconds]`.
const PARTIALS = Object.freeze({
  wood: Object.freeze([[1, 1, 0.044], [2.72, 0.32, 0.019], [4.13, 0.1, 0.009]]),
  mallet: Object.freeze([[1, 1, 0.055], [2, 0.2, 0.055], [3, 0.07, 0.024]]),
  bell: Object.freeze([[1, 1, 0.16], [2.01, 0.24, 0.16], [3.98, 0.07, 0.055]]),
})
const KIND_DECAY = Object.freeze({ wood: 0.13, mallet: 0.1, bell: 0.19 })
const PAPER_SEED = 1847

function noteHz(midi) { return 440 * 2 ** ((midi - 69) / 12) }

// The offline script's own envelope, unaltered: 4ms attack, exponential decay, 18ms release
// so a note can never click off.
function envelope(t, duration, decay) {
  if (t < 0 || t >= duration) return 0
  return Math.min(1, t / 0.004) * Math.exp(-t / decay) * Math.min(1, (duration - t) / 0.018)
}

// Deterministic: a seeded xorshift, never the game's dealing RNG (§5.3 「不要把特效噪声随机源
// 接到游戏发牌 RNG」). Same seed as the offline render, so the paper is the same paper.
function renderCue(id, sampleRate) {
  const cue = CUE_RECIPES[id]
  if (!cue) return null
  const length = Math.round(cue.duration * sampleRate)
  const buf = new Float64Array(length)
  for (const [at, midi, duration, kind, gain] of cue.notes) {
    const base = noteHz(midi)
    const start = Math.round(at * sampleRate)
    const count = Math.round(duration * sampleRate)
    const decay = KIND_DECAY[kind]
    for (const [ratio, amplitude, partialDecay] of PARTIALS[kind]) {
      const frequency = base * ratio
      for (let i = 0; i < count && start + i < length; i += 1) {
        const t = i / sampleRate
        const phase = 2 * Math.PI * frequency * t
        buf[start + i] += Math.sin(phase) * amplitude * Math.exp(-t / partialDecay)
          * envelope(t, duration, decay) * gain
      }
    }
  }
  cue.paper.forEach(([at, duration, gain], index) => {
    let x = (PAPER_SEED + index * 101) >>> 0
    let low = 0
    let slower = 0
    const start = Math.round(at * sampleRate)
    const count = Math.round(duration * sampleRate)
    for (let i = 0; i < count && start + i < length; i += 1) {
      x ^= x << 13; x ^= x >>> 17; x ^= x << 5
      const noise = ((x >>> 0) / 4294967296) * 2 - 1
      low += 0.18 * (noise - low)
      slower += 0.023 * (noise - slower)
      const u = i / count
      buf[start + i] += (low - slower) * gain * Math.sin(Math.PI * u) ** 1.6
    }
  })
  // Peak-normalize to the recipe's own headroom, then the 2ms/4ms edge fades.
  let peak = 0
  for (const sample of buf) peak = Math.max(peak, Math.abs(sample))
  const factor = cue.peak / Math.max(peak, 1e-9)
  const out = new Float32Array(length)
  for (let i = 0; i < length; i += 1) {
    out[i] = buf[i] * factor
      * Math.min(1, i / (sampleRate * 0.002), (length - 1 - i) / (sampleRate * 0.004))
  }
  return out
}

// ---------------------------------------------------------------- scenes (§6.3)
// `gameplay` is a live run; `intro` is the opening wave and stays SILENT (this version adds
// no opening music); `settings`/`help` stop in-run sound and allow only an explicit test tone;
// `result` is the finished run, where the in-run music is over but the record sound is owed;
// `home` is the cover (it cancels the previous run's tail) and `hidden` overrides everything.
const SCENE_ALLOW = Object.freeze({
  gameplay: Object.freeze(['place', 'clear', 'chain', 'chain-break', 'item', 'cancel', 'tick', 'settle']),
  intro: Object.freeze([]),
  settings: Object.freeze(['test']),
  help: Object.freeze([]),
  result: Object.freeze(['new-best', 'game-over']),
  home: Object.freeze([]),
  hidden: Object.freeze([]),
})

// Which category a cue plays on, and whether it is a MAIN cue (one per settled placement, §6.1)
// or an accompaniment that must give way to it.
const CUE_META = Object.freeze({
  place: { kind: 'place', category: 'clear', main: true, priority: 3 },
  'clear-l1': { kind: 'clear', category: 'clear', main: true, priority: 4 },
  'clear-l2': { kind: 'clear', category: 'clear', main: true, priority: 4 },
  'clear-l3': { kind: 'clear', category: 'clear', main: true, priority: 5 },
  'clear-l4': { kind: 'clear', category: 'clear', main: true, priority: 6 },
  'clear-l5': { kind: 'clear', category: 'clear', main: true, priority: 7 },
  // The legacy v1 chain milestone. Kept because a version-1 run in flight still earns those
  // 5/10/15/20 nodes (SCORE_REWARD_SIMPLIFICATION_HANDOFF §5.2 不中途改价); NO version-2 run
  // reaches it — version 2 pays the streak reward instead.
  'chain-milestone': { kind: 'chain', category: 'clear', main: false, priority: 4 },
  // v0.10.3 reward signatures. All three are MAIN cues: one settled placement plays exactly
  // one of them (§3.3 一个主声音), and a secondary streak is added as a trimmed tail inside it.
  'streak-2': { kind: 'clear', category: 'clear', main: true, priority: 5 },
  'streak-hi': { kind: 'clear', category: 'clear', main: true, priority: 5 },
  // NOT main: this one is the tail that rides inside another cue (§3.3).
  'streak-tail': { kind: 'clear', category: 'clear', main: false, priority: 3 },
  'face-clear': { kind: 'clear', category: 'clear', main: true, priority: 6 },
  'new-best': { kind: 'new-best', category: 'result', main: true, priority: 9 },
  'game-over': { kind: 'game-over', category: 'result', main: true, priority: 6 },
  'item-hammer': { kind: 'item', category: 'item', main: true, priority: 6 },
  'item-rocket': { kind: 'item', category: 'item', main: true, priority: 6 },
  'item-bomb': { kind: 'item', category: 'item', main: true, priority: 6 },
  'item-refresh': { kind: 'item', category: 'item', main: true, priority: 6 },
  cancel: { kind: 'cancel', category: 'ui', main: false, priority: 1 },
  'chain-break': { kind: 'chain-break', category: 'ui', main: false, priority: 2 },
  'score-tick': { kind: 'tick', category: 'ui', main: false, priority: 1 },
  'score-settle': { kind: 'settle', category: 'ui', main: false, priority: 2 },
})

const CLEAR_CUES = Object.freeze(['clear-l1', 'clear-l2', 'clear-l3', 'clear-l4', 'clear-l5'])
const ITEM_CUES = Object.freeze({ hammer: 'item-hammer', rocket: 'item-rocket', bomb: 'item-bomb', refresh: 'item-refresh' })

export function createGameAudio({ getSoundOn, lowPower = false } = {}) {
  let context = null
  let master = null
  let duck = null
  let compressor = null
  let analyser = null
  let analysisBuffer = null
  const categoryGains = {}
  const buffers = new Map()
  const voices = new Set()
  const externalMutes = new Set()

  let scene = 'gameplay'
  let unlocked = false
  let unlockPromise = null
  let mainCue = null // the live main voice, replaced (never queued) by the next event
  let lastTickAt = -Infinity
  let lastEdgeHintAt = -Infinity
  let rollTicks = 0
  let ducked = false

  // The read-out the headless checks read (never used by gameplay). `outputPeak` is measured
  // on the MASTER output, which is the only place that can tell "the graph ran" from "the
  // graph was silenced" — see §9 and tools/score-roll-probe.mjs.
  const stats = {
    cuesPlayed: 0,
    cuesDropped: 0,
    cuesSuppressed: 0,
    voicesStarted: 0,
    outputPeak: 0,
    outputPeakAt: 0,
    resetAt: -Infinity,
    resetClock: -1,
    lastCue: null,
    lastCueAt: 0,
    lastScene: 'gameplay',
    lastDropReason: null,
    lastSuppressedCue: null,
    lastSuppressedAt: 0,
  }

  const soundOn = () => (typeof getSoundOn === 'function' ? getSoundOn() !== false : true)
  const muted = () => !soundOn() || externalMutes.size > 0
  const voiceLimit = () => (lowPower ? AUDIO_STYLE.voiceLimitLowPower : AUDIO_STYLE.voiceLimit)

  function ensureContext() {
    if (context) return context
    const Ctor = window.AudioContext || window.webkitAudioContext
    if (!Ctor) return null
    try {
      context = new Ctor()
    } catch {
      context = null
      return null
    }
    // §6.2's chain: category → master → soft safety compressor → output.
    compressor = context.createDynamicsCompressor()
    const c = AUDIO_STYLE.compressor
    compressor.threshold.value = c.threshold
    compressor.knee.value = c.knee
    compressor.ratio.value = c.ratio
    compressor.attack.value = c.attack
    compressor.release.value = c.release
    master = context.createGain()
    // §6.1: the counting click is pushed down while a main cue is playing. The duck sits
    // BETWEEN the UI category and the master, so only the tick/settle ride it — the main cue
    // on the clear category is untouched, and the duck can never change the mix of a cue.
    duck = context.createGain()
    duck.gain.value = 1
    analyser = context.createAnalyser()
    // §9 measurement window: an analysis block is the last `fftSize` samples, so a window
    // SHORTER than one frame gap could miss sound entirely and turn a hitch into a false
    // "nothing played". 16384 samples ≈ 340ms at 48kHz, comfortably longer than any frame the
    // game can render, and it is only ever read by the diagnostic report.
    analyser.fftSize = 16384
    analysisBuffer = new Float32Array(analyser.fftSize)
    for (const [name, level] of Object.entries(AUDIO_STYLE.categories)) {
      const gain = context.createGain()
      gain.gain.value = level
      categoryGains[name] = gain
    }
    for (const gain of Object.values(categoryGains)) gain.connect(master)
    categoryGains.ui.disconnect()
    categoryGains.ui.connect(duck)
    duck.connect(master)
    master.connect(compressor)
    compressor.connect(analyser)
    analyser.connect(context.destination)
    master.gain.value = muted() ? 0 : AUDIO_STYLE.master
    // Desktops and any browser that grants autoplay hand back a context that is ALREADY
    // running — there is then nothing to unlock and the first placement is heard.
    if (context.state === 'running') unlocked = true
    return context
  }

  function cueBuffer(id) {
    const ctx = ensureContext()
    if (!ctx) return null
    if (!buffers.has(id)) {
      const rendered = renderCue(id, ctx.sampleRate)
      if (!rendered) return null
      const buffer = ctx.createBuffer(1, rendered.length, ctx.sampleRate)
      buffer.copyToChannel(rendered, 0)
      buffers.set(id, buffer)
    }
    return buffers.get(id)
  }

  // The analyser keeps a WINDOW of the most recent samples, so a naive "reset then measure"
  // would still see the audio that played before the reset — the exact false positive that
  // would let a broken mute pass. The peak is therefore taken over the samples RENDERED since
  // the reset, and "rendered since" is counted on the AUDIO clock (`context.currentTime`), not
  // the wall clock: the audio thread can lag the main thread by whole quanta, and a wall-clock
  // slice would drag pre-reset audio into a post-reset measurement.
  function sampleOutput() {
    if (!analyser) return 0
    analyser.getFloatTimeDomainData(analysisBuffer)
    const renderedSince = context && stats.resetClock >= 0
      ? Math.max(0, context.currentTime - stats.resetClock)
      : Number.POSITIVE_INFINITY
    const sinceSamples = Number.isFinite(renderedSince)
      ? Math.max(0, Math.min(analysisBuffer.length, Math.round(renderedSince * context.sampleRate)))
      : analysisBuffer.length
    let peak = 0
    for (let i = analysisBuffer.length - sinceSamples; i < analysisBuffer.length; i += 1) {
      peak = Math.max(peak, Math.abs(analysisBuffer[i]))
    }
    return peak
  }

  // ------------------------------------------------------------ voice handling
  function stopVoice(voice, fadeSeconds) {
    if (!voice || voice.stopped) return
    voice.stopped = true
    voices.delete(voice)
    if (mainCue === voice) {
      mainCue = null
      // The duck rides the main cue, so it is released with it. A replacement re-ducks in the
      // same tick, which cancels this ramp before it can be heard.
      setDucked(false)
    }
    const now = context.currentTime
    try {
      voice.gain.gain.cancelScheduledValues(now)
      voice.gain.gain.setValueAtTime(voice.gain.gain.value, now)
      voice.gain.gain.linearRampToValueAtTime(0, now + fadeSeconds)
      voice.source.stop(now + fadeSeconds + 0.01)
    } catch {
      try { voice.source.stop() } catch { /* already finished */ }
    }
  }

  function cancelVoices(predicate, fadeSeconds = AUDIO_STYLE.mainCueFadeMs / 1000) {
    for (const voice of [...voices]) {
      if (!predicate || predicate(voice)) stopVoice(voice, fadeSeconds)
    }
  }

  function setDucked(on) {
    if (!duck || ducked === on) return
    ducked = on
    const now = context.currentTime
    const target = on ? 10 ** (AUDIO_STYLE.duckDb / 20) : 1
    duck.gain.cancelScheduledValues(now)
    duck.gain.setValueAtTime(duck.gain.value, now)
    duck.gain.linearRampToValueAtTime(target, now + (on ? AUDIO_STYLE.duckAttack : AUDIO_STYLE.duckRelease))
  }

  function reserveVoice(priority) {
    // §6.2: the cap is on SOURCES, and the oldest tail of the LOWEST priority goes first —
    // never the current placement's own touch information.
    if (voices.size < voiceLimit()) return true
    let victim = null
    for (const voice of voices) {
      if (voice.priority >= priority) continue
      if (!victim || voice.priority < victim.priority || voice.startedAt < victim.startedAt) victim = voice
    }
    if (!victim) return false
    stopVoice(victim, 0.03)
    return true
  }

  function drop(cue, reason) {
    stats.cuesDropped += 1
    stats.lastDropReason = `${cue}:${reason}`
    return false
  }

  function startCue(id, { delay = 0, gain = 1, priority, limit = 0, duck: wantsDuck = false, kind = null } = {}) {
    const meta = CUE_META[id]
    if (!meta) return false
    // The scene gate is asked about the cue's KIND, and `kind` may be overridden by the caller:
    // the settings panel's test tone plays the same material as `clear-l1` but is a different
    // intent, and «设置中禁止局内尾曲但允许显式试音» hinges on exactly that distinction.
    if (!SCENE_ALLOW[scene].includes(kind || meta.kind)) return drop(id, `scene:${scene}`)
    if (muted()) return drop(id, 'muted')
    // The context is created (once) BEFORE the unlock question is asked: a browser that grants
    // autoplay hands back a context that is already running, and that IS the unlock.
    const ctx = ensureContext()
    if (!ctx) return drop(id, 'unavailable')
    // §6.3: an unlock that has not happened yet drops THIS sound. It is never queued up and
    // replayed as a burst on the next interaction.
    if (!unlocked) return drop(id, 'locked')
    const buffer = cueBuffer(id)
    if (!buffer) return drop(id, 'unavailable')
    if (ctx.state === 'suspended') ctx.resume().catch(() => {})
    const voicePriority = priority ?? meta.priority
    if (!reserveVoice(voicePriority)) return drop(id, 'voice-limit')

    const source = ctx.createBufferSource()
    source.buffer = buffer
    const gainNode = ctx.createGain()
    gainNode.gain.value = gain
    source.connect(gainNode).connect(categoryGains[meta.category] || master)
    const startsAt = ctx.currentTime + delay
    const voice = {
      id,
      source,
      gain: gainNode,
      priority: voicePriority,
      startedAt: performance.now(),
      main: Boolean(meta.main),
      stopped: false,
    }
    source.onended = () => {
      voices.delete(voice)
      if (mainCue === voice) {
        mainCue = null
        setDucked(false)
      }
    }
    source.start(startsAt)
    // §6.1 「只在原主 cue 内加一个轻铃点」: a cue may be TRIMMED to a shorter window instead
    // of being allowed to run its own phrase on top of the main one.
    if (limit > 0) stopAt(voice, startsAt + limit)
    voices.add(voice)
    if (meta.main) {
      // §6.2: a new event replaces the old tail instead of queueing behind it. The new sound
      // starts NOW — the old one fades under it.
      if (mainCue && mainCue !== voice) stopVoice(mainCue, AUDIO_STYLE.mainCueFadeMs / 1000)
      mainCue = voice
      if (wantsDuck) setDucked(true)
    }
    stats.cuesPlayed += 1
    stats.voicesStarted += 1
    stats.lastCue = id
    stats.lastCueAt = performance.now()
    return true
  }

  function stopAt(voice, atTime) {
    try {
      voice.gain.gain.setValueAtTime(voice.gain.gain.value, Math.max(atTime - 0.02, context.currentTime))
      voice.gain.gain.linearRampToValueAtTime(0, atTime)
      voice.source.stop(atTime + 0.01)
    } catch { /* the source already ended */ }
  }

  // ------------------------------------------------------------ public cues
  function playPlace() {
    rollTicks = 0
    return startCue('place')
  }

  // §6.1: ONE main cue per settled placement, and it already contains the landing knock.
  //
  // v0.10.3: the cue is chosen by the reward EVENT's primary category (§3.3 主声音按主类别选音型),
  // not by re-deriving anything from lines and faces:
  //   FACE_CLEAR   → 'face-clear'  (paper sweep + bright chord)
  //   CLEAR_STREAK → 'streak-2' / 'streak-hi'  (two short knocks, capped)
  //   MULTI_CLEAR  → the ascending clear-lN the LADDER already owns, keyed by `level`
  // A secondary streak rides INSIDE the same cue as one trimmed tail (§3.3 allows exactly one
  // extra phrase, never three melodies), which is the same discipline the old milestone tail
  // followed. `milestone` is the version-1 field and is only read for version-1 runs.
  function playClear(level, { milestone = 0, reward = null } = {}) {
    rollTicks = 0
    const ranked = Math.min(Math.max(level, 1), 5)
    const primary = reward?.primaryType || null
    const streak = (reward?.rewards || []).find((entry) => entry.type === 'CLEAR_STREAK') || null
    let id = CLEAR_CUES[ranked - 1]
    if (primary === 'FACE_CLEAR') id = 'face-clear'
    else if (primary === 'CLEAR_STREAK') id = streak && streak.count >= 3 ? 'streak-hi' : 'streak-2'
    const started = startCue(id, { wantsDuck: true })
    if (!started) return started

    if (reward) {
      // A streak that is NOT the headline still has to be heard as 「接上了」 — one short tail
      // inside the main cue, and nothing when the headline already IS the streak. `streak-tail`
      // is deliberately NOT a main cue: a main cue replaces the one it is meant to sit inside.
      if (primary !== 'CLEAR_STREAK' && streak) {
        const delay = Math.min(Math.max(CUE_RECIPES[id].duration - 0.24, 0.2), 0.9 - CUE_RECIPES['streak-tail'].duration)
        startCue('streak-tail', { delay, gain: 0.6, priority: 3 })
      }
      return started
    }

    if (!milestone) return started
    const duration = CUE_RECIPES[id].duration
    if (ranked <= 2) {
      // L1/L2 may carry the milestone as the tail of the SAME phrasing, under §6.1's 0.9s cap.
      const delay = Math.min(Math.max(duration - 0.3, 0.12), Math.max(0.9 - CUE_RECIPES['chain-milestone'].duration, 0))
      startCue('chain-milestone', { delay, priority: 4 })
    } else {
      // L3+ gets one bell point INSIDE the main cue: the same cue trimmed to its mallet note,
      // never a second melody beside it.
      const delay = Math.max(duration - 0.26, 0.2)
      startCue('chain-milestone', { delay, limit: 0.26, gain: 0.55, priority: 3 })
    }
    return started
  }

  function playChainBreak() { return startCue('chain-break') }

  function playItem(id) {
    const cue = ITEM_CUES[id]
    return cue ? startCue(cue) : false
  }

  // §6.2: the edge hint is a real cue, but a player dragging over an illegal cell must not
  // hear it every frame. 150ms is the floor.
  function playCancel() {
    const now = performance.now()
    if (now - lastEdgeHintAt < AUDIO_STYLE.edgeHintMinIntervalMs) {
      stats.cuesSuppressed += 1
      stats.lastSuppressedCue = 'cancel'
      stats.lastSuppressedAt = now
      return false
    }
    lastEdgeHintAt = now
    return startCue('cancel')
  }

  function playNewBest() { return startCue('new-best', { wantsDuck: true }) }
  function playGameOver() { return startCue('game-over') }

  // §6.1: the counting click is rate-limited and capped per roll, and rides §6.2's duck.
  function playScoreTick() {
    if (rollTicks >= AUDIO_STYLE.tickMaxPerRoll) return false
    const now = performance.now()
    if (now - lastTickAt < AUDIO_STYLE.tickMinIntervalMs) return false
    lastTickAt = now
    rollTicks += 1
    return startCue('score-tick')
  }

  // §6.1: the landing chord is SUPPRESSED while the main cue is still running (the HUD's own
  // visual landing is not), and only played into a quiet bus. `points` is this roll's delta.
  function playScoreSettle() {
    if (mainCue) {
      stats.cuesSuppressed += 1
      stats.lastSuppressedCue = 'score-settle'
      stats.lastSuppressedAt = performance.now()
      return false
    }
    return startCue('score-settle')
  }

  // The settings panel's explicit test tone: it may unlock the context (§6.3) and is allowed
  // even though the scene forbids in-run sound. One tap, one cue.
  function playTestTone() {
    const tone = () => startCue('clear-l1', { priority: 8, kind: 'test' })
    if (unlocked) return Promise.resolve(tone())
    // The unlock is a promise, so the FIRST test tone is the one sound that has to wait for it
    // rather than be dropped: it is a direct answer to the tap that just unlocked the context.
    return unlock().then((ok) => (ok ? tone() : false))
  }

  // ------------------------------------------------------------ lifecycle
  function unlock() {
    if (unlocked) return Promise.resolve(true)
    if (unlockPromise) return unlockPromise
    const ctx = ensureContext()
    if (!ctx) return Promise.resolve(false)
    unlockPromise = ctx.resume()
      .then(() => {
        unlocked = ctx.state === 'running'
        return unlocked
      })
      // A refused unlock is NOT retried on the next sound and never queues one: the cue that
      // was owed is dropped (startCue's 'locked' branch), which is §6.3's rule.
      .catch(() => { unlocked = false; return false })
      .finally(() => { unlockPromise = null })
    return unlockPromise
  }

  function setScene(next) {
    if (!SCENE_ALLOW[next] || next === scene) return scene
    const previous = scene
    scene = next
    // Leaving a scene cancels ITS tails: the reason a scene exists is that the sound of the
    // one before it must not survive into it.
    cancelVoices(null)
    setDucked(false)
    rollTicks = 0
    if (next === 'hidden' && context && context.state === 'running') context.suspend().catch(() => {})
    else if (previous === 'hidden' && context && context.state === 'suspended' && !muted() && unlocked) context.resume().catch(() => {})
    stats.lastScene = next
    return scene
  }

  // §6.3: the platform adapter has no verified ad-callback audio wiring yet, so this is the
  // reserved interface ONLY — nothing claims CrazyGames mute integration has been tested.
  function setExternalMute(reason, active) {
    if (active) externalMutes.add(reason)
    else externalMutes.delete(reason)
    return applyMuteState()
  }

  // The single place the mute state is APPLIED (reads the live switch plus any external reason).
  // Called by the settings switch, by an external mute, and by nothing else.
  function applyMuteState() {
    if (muted()) {
      if (master && context) {
        const now = context.currentTime
        master.gain.cancelScheduledValues(now)
        master.gain.setValueAtTime(master.gain.value, now)
        master.gain.linearRampToValueAtTime(0, now + AUDIO_STYLE.muteFadeMs / 1000)
      }
      // Muting is not "refuse the next note": what is already scheduled and playing goes too.
      cancelVoices(null)
      setDucked(false)
    } else if (master && context) {
      const now = context.currentTime
      master.gain.cancelScheduledValues(now)
      master.gain.setValueAtTime(master.gain.value, now)
      master.gain.linearRampToValueAtTime(AUDIO_STYLE.master, now + AUDIO_STYLE.muteFadeMs / 1000)
      // Re-opening does NOT replay anything that was dropped.
    }
    return muted()
  }

  function cancelAll() {
    cancelVoices(null, 0.02)
    setDucked(false)
  }

  function report() {
    const peak = sampleOutput()
    if (peak > stats.outputPeak) {
      stats.outputPeak = peak
      stats.outputPeakAt = performance.now()
    }
    return {
      scene,
      muted: muted(),
      soundOn: soundOn(),
      externalMutes: [...externalMutes],
      unlocked,
      contextState: context ? context.state : 'none',
      sampleRate: context ? context.sampleRate : 0,
      voices: voices.size,
      voiceIds: [...voices].map((voice) => voice.id),
      voiceLimit: voiceLimit(),
      mainCue: mainCue ? mainCue.id : null,
      cuesPlayed: stats.cuesPlayed,
      cuesDropped: stats.cuesDropped,
      cuesSuppressed: stats.cuesSuppressed,
      voicesStarted: stats.voicesStarted,
      lastCue: stats.lastCue,
      lastCueAt: stats.lastCueAt,
      lastDropReason: stats.lastDropReason,
      lastSuppressedCue: stats.lastSuppressedCue,
      lastSuppressedAt: stats.lastSuppressedAt,
      outputPeak: Number(stats.outputPeak.toFixed(5)),
      outputPeakAt: stats.outputPeakAt,
    }
  }

  // The probe's window reset: "was anything heard SINCE this moment" is the only question
  // that can distinguish a silenced bus from a bus that was never driven.
  function resetOutputWindow() {
    stats.outputPeak = 0
    stats.outputPeakAt = 0
    stats.resetAt = performance.now()
    // The audio clock at the reset: the measurement starts where the RENDERER is, not where the
    // main thread is. -1 means "no context yet", and then there is nothing to measure anyway.
    stats.resetClock = context ? context.currentTime : -1
    return true
  }

  return {
    unlock,
    setScene,
    setExternalMute,
    refreshMute: applyMuteState,
    cancelAll,
    report,
    resetOutputWindow,
    getScene: () => scene,
    isMuted: muted,
    isUnlocked: () => unlocked,
    playPlace,
    playClear,
    playChainBreak,
    playItem,
    playCancel,
    playNewBest,
    playGameOver,
    playScoreTick,
    playScoreSettle,
    playTestTone,
  }
}

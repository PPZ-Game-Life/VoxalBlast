// Deterministic random streams (v0.9.0 P1, producer's dealing spec §4.2).
//
// WHY THIS EXISTS AT ALL: from v0.9.0 the hand a player receives depends on the board,
// the difficulty phase and a search — so "the deal is random" is no longer a description
// anyone can reproduce. Two things have to become checkable instead:
//   - a bug report can be replayed (same seed + same placement history ⇒ same hands), and
//   - the experiment arms in tools/ can be compared WITHOUT the difference being luck.
//
// WHY SEPARATE STREAMS: one global Math.random() would let anything that happens to draw
// a number — a particle burst, a search tie-break, a decorative wobble — shift every
// later hand. The spec's rule is that the dealing stream, the search stream and the
// presentation stream are independent, so adding an effect can never move a hand. Each
// stream is (seed, name) and is created on demand: `streams.deal()`, `streams.search()`.
//
// The algorithm is deliberately the one the offline measurement already uses
// (tools/difficulty-model.mjs: FNV-1a hash of the seed material + mulberry32), so a
// number produced here and a number produced by the experiment tooling agree. The old
// LCG that preceded it clustered by seed (single-seed ending rates were off by ~14pp —
// see docs/Technical/DIFFICULTY_BASELINE.md), which is exactly the kind of bias that
// would make a "the new dealer feels harder" claim unfalsifiable.

// FNV-1a, 32-bit. Takes any number of string/number parts so a stream's identity can be
// composed: hashSeed('v0.9.0-p1', runSeed, 'deal').
export function hashSeed(...parts) {
  let hash = 0x811c9dc5
  const text = parts.map((part) => String(part)).join('\u0000')
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

// mulberry32: 32-bit state, one multiply-xor round per value, period 2^32. Small enough
// to serialize into a save slot (that is the point — the director's RNG state is saved).
export function createRng(seed = 1) {
  let state = (Number.isFinite(seed) ? Math.floor(seed) : 1) >>> 0
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  next.getState = () => state >>> 0
  next.setState = (value) => {
    state = (Number.isFinite(value) ? Math.floor(value) : 0) >>> 0
    return state
  }
  // Integer in [0, n). The dealing code picks slots and weights, so this is the form it
  // actually wants; keeping it here means no call site has to remember the exclusive bound.
  next.int = (n) => (n > 0 ? Math.floor(next() * n) % n : 0)
  next.pick = (list) => (list.length ? list[next.int(list.length)] : undefined)
  // Fisher-Yates over a copy: the spec allows the three slots to be shuffled at the end
  // (a batch is a SET of three pieces — permutations are the same combination to evaluate).
  next.shuffle = (list) => {
    const out = [...list]
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = next.int(i + 1)
      ;[out[i], out[j]] = [out[j], out[i]]
    }
    return out
  }
  return next
}

// The stream registry. `seed` is per RUN (a new game gets a fresh one, a resumed run keeps
// the saved one), and the name separates purposes. Creating a stream is cheap and
// idempotent per name, so callers can just ask for `streams.get('search')` wherever they
// need it instead of threading a function through every layer.
export function createStreams(seed = 1) {
  const states = new Map()
  const get = (name) => {
    if (!states.has(name)) states.set(name, createRng(hashSeed(seed, name)))
    return states.get(name)
  }
  return {
    seed,
    get,
    deal: () => get('deal'),
    search: () => get('search'),
    director: () => get('director'),
    // The saved half: every stream's current state, so a resumed run continues the same
    // sequences rather than restarting them (spec §4.3 "重载不重抽当前手牌，不重置难度").
    snapshot: () => Object.fromEntries([...states.entries()].map(([name, rng]) => [name, rng.getState()])),
    restore(saved) {
      if (!saved || typeof saved !== 'object') return false
      Object.entries(saved).forEach(([name, value]) => get(name).setState(value))
      return true
    },
  }
}

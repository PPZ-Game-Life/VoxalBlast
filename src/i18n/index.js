// i18n core — the ONE place that decides what language the game speaks. Project standard:
// docs/Technical/LOCALIZATION.md.
//
// Rules this module exists to enforce:
//
//  1. **English is the default.** `DEFAULT_LOCALE` is the answer whenever nothing else
//     applies, and it is also the fallback for any key a locale is missing. A build that
//     forgets to ship a language still boots in English.
//  2. **No user-facing literal lives anywhere else.** Text comes from t(), markup carries
//     `data-i18n` / `data-i18n-aria-label` / `data-i18n-title`, and the guard in
//     tools/i18n-tests.mjs fails the build when a CJK literal or a known English UI string
//     reappears under src/ or index.html.
//  3. **Nothing is captured at import time.** The player can switch language mid-run from
//     the settings panel, so a module-level `const COPY = t(...)` would go stale the moment
//     the switch flips. Call t() at render time; ui/itemCopy.js is the worked example.
//
// Resolution order for the boot language: `?lang=` query parameter (QA / deep links) →
// the stored preference → `DEFAULT_LOCALE`. There is deliberately NO navigator.language
// sniffing: "the game is English by default" is a product decision that a browser header
// must not silently override, and a deterministic default is the only one a headless gate
// can assert. Turning auto-detection on later is the one line flagged in resolveInitialLocale().
import { readPreferenceValue, writePreferenceValue } from '../platform/storage.js'
import en from './locales/en.js'
import zhHans from './locales/zh-Hans.js'

export const DEFAULT_LOCALE = 'en'

// The shipped languages. `label` is the ENDONYM — a language picker that says "Chinese"
// to a Chinese player is the classic mistake, and one that says 简体中文 to everyone else
// is still readable. `htmlLang` goes on <html lang> for screen readers and hyphenation.
export const LOCALES = Object.freeze([
  Object.freeze({ id: 'en', label: 'English', htmlLang: 'en' }),
  Object.freeze({ id: 'zh-Hans', label: '简体中文', htmlLang: 'zh-Hans' }),
])

const CATALOGS = Object.freeze({ en, 'zh-Hans': zhHans })

// Aliases a browser, a QA link or a future store build may hand us. Kept as a table rather
// than a regex so adding a language is one entry and never a new branch.
const ALIASES = Object.freeze({
  en: 'en', 'en-us': 'en', 'en-gb': 'en', 'en-ca': 'en', 'en-au': 'en',
  zh: 'zh-Hans', 'zh-hans': 'zh-Hans', 'zh-cn': 'zh-Hans', 'zh-sg': 'zh-Hans',
  'zh-hans-cn': 'zh-Hans', 'zh-hans-sg': 'zh-Hans',
})

const LOCALE_BY_ID = new Map(LOCALES.map((entry) => [entry.id, entry]))

// Anything unknown normalises to null rather than to English: the caller decides whether an
// unknown tag means "fall back" or "ignore this input", and those are different answers.
export function normalizeLocale(input) {
  if (typeof input !== 'string') return null
  const tag = input.trim().toLowerCase().replace(/_/g, '-')
  if (!tag) return null
  if (LOCALE_BY_ID.has(tag)) return tag
  if (ALIASES[tag]) return ALIASES[tag]
  // 'zh-Hant-TW' style leftovers: match on the primary subtag only.
  const primary = tag.split('-')[0]
  return ALIASES[primary] || (LOCALE_BY_ID.has(primary) ? primary : null)
}

function queryLocale() {
  try {
    if (typeof location === 'undefined' || !location.search) return null
    return normalizeLocale(new URLSearchParams(location.search).get('lang'))
  } catch {
    return null
  }
}

// See the header: no navigator sniffing. Enabling it is
// `normalizeLocale(navigator.language)` inserted between the query and the stored value.
export function resolveInitialLocale() {
  return queryLocale()
    || normalizeLocale(readPreferenceValue('locale'))
    || DEFAULT_LOCALE
}

let currentLocale = resolveInitialLocale()
const listeners = new Set()

export function getLocale() { return currentLocale }

export function getLocaleEntry(id = currentLocale) {
  return LOCALE_BY_ID.get(id) || LOCALE_BY_ID.get(DEFAULT_LOCALE)
}

// The BCP-47 tag Intl wants. Kept next to getLocaleEntry so number formatting can never
// disagree with the strings around it.
export function getNumberLocale() {
  return getLocaleEntry().id
}

export function isSupportedLocale(input) {
  return normalizeLocale(input) !== null
}

function interpolate(template, params) {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (match, name) => (
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
  ))
}

// The lookup: the active locale first, then English, then the key itself. Returning the KEY
// on a miss is deliberate — a missing string shows up as `item.tapHint` on screen and in a
// screenshot instead of as an empty element nobody notices.
export function t(key, params = null) {
  const active = CATALOGS[currentLocale] || CATALOGS[DEFAULT_LOCALE]
  let entry = active ? active[key] : undefined
  if (entry === undefined) entry = CATALOGS[DEFAULT_LOCALE][key]
  if (entry === undefined) return key
  // A function entry owns its own grammar (plurals, list joining); a string entry only
  // needs {placeholder} substitution.
  return typeof entry === 'function' ? entry(params || {}) : interpolate(entry, params)
}

export function hasKey(key) {
  return key in CATALOGS[DEFAULT_LOCALE]
}

export function keysOf(localeId) {
  const catalog = CATALOGS[localeId]
  return catalog ? Object.keys(catalog) : []
}

// Locale-aware numbers. Every `toLocaleString('en-US')` the UI used to hard-code is a bug
// the moment a second language exists: 1,234.5 and 1 234,5 are the same number.
export function formatNumber(value, options) {
  const number = Number(value)
  if (!Number.isFinite(number)) return String(value)
  try {
    return number.toLocaleString(getNumberLocale(), options)
  } catch {
    return String(number)
  }
}

// The static-markup half. Four attributes, no templating engine:
//   data-i18n              -> textContent (replaces EVERYTHING inside the element)
//   data-i18n-text         -> only the element's direct text node, leaving child elements
//                             alone. Used where the button already owns an icon <span> whose
//                             box the layout depends on: wrapping the label in one more span
//                             would add a flex gap and move the icon.
//   data-i18n-aria-label   -> aria-label
//   data-i18n-title        -> title
// index.html ships the ENGLISH text inline as well, so the default locale paints correctly
// even if the module never ran; this pass is what makes the other locales (and a mid-session
// switch) take effect.
export function applyStatic(root = typeof document === 'undefined' ? null : document) {
  if (!root) return 0
  let applied = 0
  for (const el of root.querySelectorAll('[data-i18n]')) {
    el.textContent = t(el.dataset.i18n)
    applied += 1
  }
  for (const el of root.querySelectorAll('[data-i18n-text]')) {
    const text = t(el.dataset.i18nText)
    const node = [...el.childNodes].find((child) => child.nodeType === 3 && child.textContent.trim())
    if (node) {
      // Keep whatever leading whitespace the markup authored: `↻ 再来一局` needs its space,
      // `</span>排行榜` has none and must not grow one.
      const leading = (node.textContent.match(/^\s*/) || [''])[0]
      node.textContent = leading + text
    } else {
      el.appendChild(el.ownerDocument.createTextNode(text))
    }
    applied += 1
  }
  for (const el of root.querySelectorAll('[data-i18n-aria-label]')) {
    el.setAttribute('aria-label', t(el.dataset.i18nAriaLabel))
    applied += 1
  }
  for (const el of root.querySelectorAll('[data-i18n-title]')) {
    el.setAttribute('title', t(el.dataset.i18nTitle))
    applied += 1
  }
  return applied
}

export function onLocaleChange(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function syncDocument() {
  if (typeof document === 'undefined') return
  document.documentElement.lang = getLocaleEntry().htmlLang
}

// The one setter. `persist` is false only for a caller that is already restoring a value.
// Returns the locale that is now active, so a caller can branch without re-reading state.
export function setLocale(id, { persist = true } = {}) {
  const next = normalizeLocale(id) || DEFAULT_LOCALE
  if (persist) writePreferenceValue('locale', next)
  if (next === currentLocale) return currentLocale
  currentLocale = next
  syncDocument()
  applyStatic()
  for (const listener of [...listeners]) listener(currentLocale)
  return currentLocale
}

export function nextLocale() {
  const index = LOCALES.findIndex((entry) => entry.id === currentLocale)
  return setLocale(LOCALES[(index + 1) % LOCALES.length].id)
}

// Called once at boot by main.js, before the first render, so every t() below the import
// already sees the resolved language.
export function initI18n() {
  syncDocument()
  applyStatic()
  return currentLocale
}

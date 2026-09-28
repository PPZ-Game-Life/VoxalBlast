// Settings and keyboard-legend presentation. Main keeps the business actions and
// inserts these UI steps at their original positions in each orchestration flow.
//
// The three preferences are the only thing this module persists. Since refactor P8 they go
// through platform/storage.js instead of touching localStorage here: same keys, same
// 'on'/'off' strings, same default ON when the key is absent, and deliberately the same
// unguarded behaviour (a throwing storage still throws — see the facade's header).
import { readPreferenceOn, writePreferenceOn } from '../platform/storage.js'
// v0.9.19: whether a buzz could be felt AT ALL on this device. The row is not a preference
// question — there is nothing to prefer on a machine with no vibrator (platform/haptics.js).
import { hapticsSupported } from '../platform/haptics.js'
import { getLocaleEntry, nextLocale, onLocaleChange, t } from '../i18n/index.js'

export function createSettings({
  settingsEl,
  settingsButtonEl,
  settingsCloseEl,
  languageSettingEl,
  languageSettingValueEl,
  soundSettingEl,
  hapticsSettingEl,
  hapticsNoteEl,
  dragTurnSettingEl,
  restartSettingEl,
  controlsButtonEl,
  controlsSettingEl,
  controlsEl,
  controlsCloseEl,
  axisHintEl,
  axisHintKeyEl,
  axisHintAxisEl,
  controlRows,
  onOpen,
  onClose,
  // v0.9.12: switching 拖块翻面 OFF has to take effect NOW, not at the next gesture — the
  // dwell may already be armed on a live drag, so main clears it (the same `endTurns()` every
  // other cancellation path uses). Optional, so a caller that does not care can omit it.
  onDragTurnChanged = () => {},
}) {
  let settingsOpen = false
  let controlsOpen = false
  const controlSpin = { pitch: 0, yaw: 0, roll: 0 }
  let soundOn = readPreferenceOn('sound')
  let hapticsOn = readPreferenceOn('haptics')
  let dragTurnOn = readPreferenceOn('dragTurn')
  // Read once per page: the device cannot grow a vibrator mid-session.
  const hapticsAvailable = hapticsSupported()
  let axisHintTimer
  let controlsOpener = null
  let unbind = null
  const soundButton = document.getElementById('sound-button')

  function updateSettingsUi() {
    soundSettingEl.classList.toggle('enabled', soundOn)
    soundSettingEl.setAttribute('aria-pressed', String(soundOn))
    soundButton?.setAttribute('aria-pressed', String(soundOn))
    hapticsSettingEl.classList.toggle('enabled', hapticsOn)
    hapticsSettingEl.setAttribute('aria-pressed', String(hapticsOn))
    // v0.9.19 (03 §3.2): with no vibrator in the device the row goes inert and its note says
    // so, instead of offering a switch that can never be honoured. The stored preference is
    // NOT rewritten — it is per-origin, and the same player's phone must keep their choice.
    // The note is painted HERE rather than only by i18n's static pass because this runs after
    // applyStatic() on a locale change, so the two can never disagree about the language.
    hapticsSettingEl.disabled = !hapticsAvailable
    hapticsNoteEl.textContent = t(hapticsAvailable ? 'settings.hapticsNote' : 'settings.hapticsUnsupported')
    dragTurnSettingEl.classList.toggle('enabled', dragTurnOn)
    dragTurnSettingEl.setAttribute('aria-pressed', String(dragTurnOn))
    // The language row is not a switch: it names the ACTIVE language, spelled in its own
    // script (English / 简体中文). Written from the i18n module's own state so the hint can
    // never disagree with the language the rest of the panel just re-rendered in.
    if (languageSettingValueEl) languageSettingValueEl.textContent = getLocaleEntry().label
  }

  // Opening settings sets its pause source BEFORE main cancels active gestures.
  // Reset also clears this flag BEFORE cameraShake/slowMo and hides the DOM after.
  function setSettingsOpen(open) {
    settingsOpen = open
  }

  function showSettings() {
    settingsEl.classList.remove('hidden')
    onOpen()
  }

  function hideSettings() {
    settingsEl.classList.add('hidden')
    onClose()
  }

  // openHome/resetGame already synchronize pause later in their own sequence.
  // Do not notify or restore focus when those flows dismiss the settings panel.
  function hideSettingsSilently() {
    settingsEl.classList.add('hidden')
  }

  function focusSettingsClose() {
    settingsCloseEl.focus()
  }

  function focusSettingsButton() {
    settingsButtonEl.focus()
  }

  // The legend's own feedback: the row's mini cube takes the same quarter the real
  // one just took, and the keycap that caused it sinks. --spin uses CSS degrees.
  function spinControlCube(axis, direction, key) {
    const row = controlRows.get(axis)
    if (!row) return
    controlSpin[axis] += direction * 90
    row.style.setProperty('--spin', `${controlSpin[axis]}deg`)
    const cap = row.querySelector(`kbd[data-key="${key.toLowerCase()}"]`)
    if (!cap) return
    cap.classList.add('active')
    setTimeout(() => cap.classList.remove('active'), 180)
  }

  function showAxisHint(key, axis) {
    axisHintKeyEl.textContent = key.toUpperCase()
    axisHintAxisEl.textContent = { pitch: 'X', yaw: 'Y', roll: 'Z' }[axis] || '?'
    axisHintEl.dataset.axis = axis
    axisHintEl.classList.add('visible')
    clearTimeout(axisHintTimer)
    axisHintTimer = setTimeout(() => axisHintEl.classList.remove('visible'), 700)
  }

  function openControls() {
    if (controlsOpen) return false
    controlsOpen = true
    // Keep settings open underneath: the legend may have been opened from its row.
    controlsOpener = document.activeElement
    controlsEl.classList.remove('hidden')
    onOpen()
    return true
  }

  function closeControls() {
    if (!controlsOpen) return false
    controlsOpen = false
    controlsEl.classList.add('hidden')
    onClose()
    return true
  }

  function focusControlsClose() {
    controlsCloseEl.focus()
  }

  function restoreControlsFocus() {
    const opener = controlsOpener
    controlsOpener = null
    if (opener instanceof HTMLElement && opener.isConnected && !opener.closest('.hidden')) opener.focus()
    else if (settingsOpen) controlsSettingEl.focus()
  }

  // Explicit wiring only: no listeners or orchestration callbacks during creation.
  // Home entries are bound by their owner; Escape stays in main's keydown chain.
  function bind({ openSettings, closeSettings, openControls, closeControls, beginRun, playTone, playHaptic }) {
    if (unbind) return unbind

    function onControlsButtonClick() { openControls() }
    function onControlsSettingClick() { openControls() }
    function onControlsCloseClick() { closeControls() }
    function onControlsBackdropClick(event) {
      if (event.target === controlsEl) closeControls()
    }
    function onSettingsButtonClick(event) { openSettings(event) }
    function onSettingsCloseClick(event) { closeSettings(event) }
    function onSettingsBackdropPointerDown(event) {
      if (event.target === settingsEl) closeSettings()
    }
    function onSoundSettingClick() {
      soundOn = !soundOn
      writePreferenceOn('sound', soundOn)
      updateSettingsUi()
      if (soundOn) playTone(520, 0.08, 0.035)
    }
    function onHapticsSettingClick() {
      hapticsOn = !hapticsOn
      writePreferenceOn('haptics', hapticsOn)
      updateSettingsUi()
      if (hapticsOn) playHaptic(18)
    }
    function onRestartSettingClick(event) { beginRun(event) }
    // The language row ADVANCES through the shipped locales rather than opening a picker: with
    // two languages that is a toggle, and with five it is still one tap per step instead of a
    // new modal. The panel's own labels are rewritten by the i18n module (applyStatic) before
    // the listeners below run, so nothing here re-renders them.
    function onLanguageSettingClick() {
      nextLocale()
      updateSettingsUi()
      playHaptic(12)
    }
    function onDragTurnSettingClick() {
      dragTurnOn = !dragTurnOn
      writePreferenceOn('dragTurn', dragTurnOn)
      updateSettingsUi()
      // Switching it OFF must drop any dwell that is already armed on a live drag; switching it
      // back ON needs nothing (the next pointermove re-arms it). The callback is main's.
      onDragTurnChanged(dragTurnOn)
      if (dragTurnOn) playHaptic(12)
    }

    controlsButtonEl.addEventListener('click', onControlsButtonClick)
    controlsSettingEl.addEventListener('click', onControlsSettingClick)
    controlsCloseEl.addEventListener('click', onControlsCloseClick)
    controlsEl.addEventListener('click', onControlsBackdropClick)
    settingsButtonEl.addEventListener('click', onSettingsButtonClick)
    settingsCloseEl.addEventListener('click', onSettingsCloseClick)
    settingsEl.addEventListener('pointerdown', onSettingsBackdropPointerDown)
    soundSettingEl.addEventListener('click', onSoundSettingClick)
    soundButton?.addEventListener('click', onSoundSettingClick)
    hapticsSettingEl.addEventListener('click', onHapticsSettingClick)
    dragTurnSettingEl.addEventListener('click', onDragTurnSettingClick)
    restartSettingEl.addEventListener('click', onRestartSettingClick)
    languageSettingEl?.addEventListener('click', onLanguageSettingClick)
    // A locale can also change from somewhere else (the ?lang= deep link, a future store
    // switch). The switch above already refreshed the row in that case; this keeps the row
    // honest when it did not.
    const unsubscribeLocale = onLocaleChange(() => updateSettingsUi())

    function dispose() {
      controlsButtonEl.removeEventListener('click', onControlsButtonClick)
      controlsSettingEl.removeEventListener('click', onControlsSettingClick)
      controlsCloseEl.removeEventListener('click', onControlsCloseClick)
      controlsEl.removeEventListener('click', onControlsBackdropClick)
      settingsButtonEl.removeEventListener('click', onSettingsButtonClick)
      settingsCloseEl.removeEventListener('click', onSettingsCloseClick)
      settingsEl.removeEventListener('pointerdown', onSettingsBackdropPointerDown)
      soundSettingEl.removeEventListener('click', onSoundSettingClick)
      soundButton?.removeEventListener('click', onSoundSettingClick)
      hapticsSettingEl.removeEventListener('click', onHapticsSettingClick)
      dragTurnSettingEl.removeEventListener('click', onDragTurnSettingClick)
      restartSettingEl.removeEventListener('click', onRestartSettingClick)
      languageSettingEl?.removeEventListener('click', onLanguageSettingClick)
      unsubscribeLocale()
      // A stale disposer must not affect a later, explicitly rebound instance.
      if (unbind === dispose) unbind = null
    }
    unbind = dispose
    return unbind
  }

  // The controls card's read-out (refactor P9): whether it is open, which rows it actually
  // printed (so a check can compare them against the bindings the game honours) and the
  // legend's own spin counters. Read-only.
  function report() {
    return {
      open: controlsOpen,
      axes: [...controlRows.keys()],
      spin: { ...controlSpin },
    }
  }

  // The settings panel's read-out: the three switches, the language the panel is currently
  // showing, and whether the language row is live. Read-only, like the controls card's.
  function settingsReport() {
    return {
      open: settingsOpen,
      sound: soundOn,
      haptics: hapticsOn,
      // v0.9.19: what the row's own inertness is derived from, so a check can compare the
      // switch's state against the reason it has one.
      hapticsSupported: hapticsAvailable,
      dragTurn: dragTurnOn,
      locale: getLocaleEntry().id,
      localeLabel: getLocaleEntry().label,
    }
  }

  return {
    isOpen: () => settingsOpen,
    isControlsOpen: () => controlsOpen,
    getSoundOn: () => soundOn,
    getHapticsOn: () => hapticsOn,
    // v0.9.12: read live by gameInput's drag gate, never captured (the same rule the sound
    // switch follows — a switch flipped mid-run has to apply to the very next gesture).
    getDragTurnOn: () => dragTurnOn,
    getControlSpin: () => ({ ...controlSpin }),
    report,
    settingsReport,
    setSettingsOpen,
    showSettings,
    hideSettings,
    hideSettingsSilently,
    focusSettingsClose,
    focusSettingsButton,
    updateSettingsUi,
    spinControlCube,
    showAxisHint,
    openControls,
    closeControls,
    focusControlsClose,
    restoreControlsFocus,
    bind,
  }
}

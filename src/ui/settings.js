// Settings and keyboard-legend presentation. Main keeps the business actions and
// inserts these UI steps at their original positions in each orchestration flow.
//
// The two preferences are the only thing this module persists. Since refactor P8 they go
// through platform/storage.js instead of touching localStorage here: same keys, same
// 'on'/'off' strings, same default ON when the key is absent, and deliberately the same
// unguarded behaviour (a throwing storage still throws — see the facade's header).
import { readPreferenceOn, writePreferenceOn } from '../platform/storage.js'

export function createSettings({
  settingsEl,
  settingsButtonEl,
  settingsCloseEl,
  soundSettingEl,
  hapticsSettingEl,
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
}) {
  let settingsOpen = false
  let controlsOpen = false
  const controlSpin = { pitch: 0, yaw: 0, roll: 0 }
  let soundOn = readPreferenceOn('sound')
  let hapticsOn = readPreferenceOn('haptics')
  let axisHintTimer
  let controlsOpener = null
  let unbind = null

  function updateSettingsUi() {
    soundSettingEl.classList.toggle('enabled', soundOn)
    soundSettingEl.setAttribute('aria-pressed', String(soundOn))
    hapticsSettingEl.classList.toggle('enabled', hapticsOn)
    hapticsSettingEl.setAttribute('aria-pressed', String(hapticsOn))
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

    controlsButtonEl.addEventListener('click', onControlsButtonClick)
    controlsSettingEl.addEventListener('click', onControlsSettingClick)
    controlsCloseEl.addEventListener('click', onControlsCloseClick)
    controlsEl.addEventListener('click', onControlsBackdropClick)
    settingsButtonEl.addEventListener('click', onSettingsButtonClick)
    settingsCloseEl.addEventListener('click', onSettingsCloseClick)
    settingsEl.addEventListener('pointerdown', onSettingsBackdropPointerDown)
    soundSettingEl.addEventListener('click', onSoundSettingClick)
    hapticsSettingEl.addEventListener('click', onHapticsSettingClick)
    restartSettingEl.addEventListener('click', onRestartSettingClick)

    function dispose() {
      controlsButtonEl.removeEventListener('click', onControlsButtonClick)
      controlsSettingEl.removeEventListener('click', onControlsSettingClick)
      controlsCloseEl.removeEventListener('click', onControlsCloseClick)
      controlsEl.removeEventListener('click', onControlsBackdropClick)
      settingsButtonEl.removeEventListener('click', onSettingsButtonClick)
      settingsCloseEl.removeEventListener('click', onSettingsCloseClick)
      settingsEl.removeEventListener('pointerdown', onSettingsBackdropPointerDown)
      soundSettingEl.removeEventListener('click', onSoundSettingClick)
      hapticsSettingEl.removeEventListener('click', onHapticsSettingClick)
      restartSettingEl.removeEventListener('click', onRestartSettingClick)
      // A stale disposer must not affect a later, explicitly rebound instance.
      if (unbind === dispose) unbind = null
    }
    unbind = dispose
    return unbind
  }

  return {
    isOpen: () => settingsOpen,
    isControlsOpen: () => controlsOpen,
    getSoundOn: () => soundOn,
    getHapticsOn: () => hapticsOn,
    getControlSpin: () => ({ ...controlSpin }),
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

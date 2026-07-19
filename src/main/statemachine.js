'use strict';

// Pure dictation state machine. No timers, no IO — main.js interprets the
// action list. Every transition is unit-tested against the event table.
//
// States: idle | listening | processing | injecting | flash
// Events: HOTKEY_DOWN, HOTKEY_UP, ESC, BLOCKED, REC_DONE, REC_ERROR,
//         TRANSCRIBED_TEXT, TRANSCRIBED_EMPTY, INJECT_DONE, FAIL,
//         MAX_TIME, FLASH_END
// ctx: { mode: 'hold'|'toggle' }

const IGNORE = Object.freeze({ next: null, actions: [] });

function t(next, ...actions) {
  return { next, actions };
}

function transition(state, event, ctx) {
  const mode = (ctx && ctx.mode) || 'hold';
  switch (state) {
    case 'idle':
      if (event === 'HOTKEY_DOWN') return t('listening', 'startRec');
      if (event === 'BLOCKED') return t('idle', 'flashDisabled');
      return IGNORE;

    case 'listening':
      if (event === 'HOTKEY_UP' && mode === 'hold') return t('processing', 'stopRec');
      if (event === 'HOTKEY_DOWN' && mode === 'toggle') return t('processing', 'stopRec');
      if (event === 'ESC') return t('idle', 'cancelRec', 'hideOverlay');
      if (event === 'MAX_TIME') return t('processing', 'stopRec');
      if (event === 'AUTO_STOP') return t('processing', 'stopRec'); // silence detected (toggle mode)
      if (event === 'REC_ERROR') return t('flash', 'flashError');
      return IGNORE;

    case 'processing':
      if (event === 'REC_DONE') return t('processing', 'transcribe');
      if (event === 'REC_TOO_SHORT') return t('idle', 'hideOverlay');
      if (event === 'TRANSCRIBED_TEXT') return t('injecting', 'inject');
      if (event === 'TRANSCRIBED_EMPTY') return t('flash', 'flashNoSpeech');
      if (event === 'REC_ERROR' || event === 'FAIL') return t('flash', 'flashError');
      if (event === 'ESC') return t('idle', 'abandon', 'hideOverlay');
      if (event === 'HOTKEY_DOWN') return t('processing', 'pulseBusy');
      return IGNORE;

    case 'injecting':
      if (event === 'INJECT_DONE') return t('flash', 'flashResult');
      if (event === 'FAIL') return t('flash', 'flashError');
      if (event === 'HOTKEY_DOWN') return t('injecting', 'pulseBusy');
      return IGNORE;

    case 'flash':
      if (event === 'FLASH_END') return t('idle', 'hideOverlay');
      // allow instant re-dictation from the flash state
      if (event === 'HOTKEY_DOWN') return t('listening', 'startRec');
      return IGNORE;

    default:
      return IGNORE;
  }
}

module.exports = { transition };

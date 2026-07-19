'use strict';

const { EventEmitter } = require('events');
const log = require('./log');

// Wraps uiohook-napi. Emits semantic events only on real key TRANSITIONS
// (Windows auto-repeat fires keydown ~30/s while held — filtered here), and
// swallows everything while text injection is in flight (+ a grace period)
// so our own synthetic Ctrl+V can never re-trigger dictation.
class Hotkeys extends EventEmitter {
  constructor() {
    super();
    this.uiohook = null;
    this.UiohookKey = null;
    this.started = false;
    this.keycode = null;
    this.enabled = true;
    this.down = new Set();
    this.injectingUntil = 0;
    this.captureCb = null;
  }

  init() {
    const mod = require('uiohook-napi');
    this.uiohook = mod.uIOhook;
    this.UiohookKey = mod.UiohookKey;
    this.uiohook.on('keydown', (e) => this._onKey(e, true));
    this.uiohook.on('keyup', (e) => this._onKey(e, false));
  }

  start() {
    if (this.started) return;
    this.uiohook.start();
    this.started = true;
    log.info('keyboard hook started');
  }

  stop() {
    if (!this.started) return;
    try { this.uiohook.stop(); } catch (e) { log.warn('hook stop:', e.message); }
    this.started = false;
  }

  setConfig({ keycode, enabled }) {
    if (typeof keycode === 'number') this.keycode = keycode;
    if (typeof enabled === 'boolean') this.enabled = enabled;
  }

  setInjecting(active) {
    // While active: block everything. On release: 250 ms grace for queued events.
    this.injectingUntil = active ? Infinity : Date.now() + 250;
  }

  captureNext(cb) { this.captureCb = cb; }

  // Resolves a pending capture with null so its awaiting IPC promise settles —
  // a stale armed capture must never rebind the hotkey from a later keypress.
  cancelCapture() {
    const cb = this.captureCb;
    this.captureCb = null;
    if (cb) cb(null);
  }

  keyName(keycode) {
    for (const [name, code] of Object.entries(this.UiohookKey || {})) {
      if (code === keycode) return name.replace(/([a-z])([A-Z])/g, '$1 $2');
    }
    return `Key ${keycode}`;
  }

  _onKey(e, isDown) {
    const now = Date.now();
    if (now < this.injectingUntil) return;

    const transition = isDown ? !this.down.has(e.keycode) : this.down.has(e.keycode);
    if (isDown) this.down.add(e.keycode); else this.down.delete(e.keycode);
    if (!transition) return; // auto-repeat or duplicate

    if (this.captureCb && isDown) {
      const cb = this.captureCb;
      this.captureCb = null;
      if (e.keycode === this.UiohookKey.Escape) { cb(null); return; }
      cb({ keycode: e.keycode, name: this.keyName(e.keycode) });
      return;
    }

    if (e.keycode === this.UiohookKey.Escape && isDown) {
      this.emit('esc');
      return;
    }
    if (e.keycode !== this.keycode) return;

    if (!this.enabled) {
      if (isDown) this.emit('blocked');
      return;
    }
    this.emit(isDown ? 'hotkey-down' : 'hotkey-up');
  }
}

module.exports = { Hotkeys };

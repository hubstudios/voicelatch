'use strict';

const { spawn } = require('child_process');
const { clipboard } = require('electron');
const log = require('./log');

function runHelper(exe, args, { stdinText, timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(exe, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const killer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch (_) {}
      reject(new Error('injector timeout'));
    }, timeoutMs || 10000);
    proc.stdout.on('data', (d) => { out += d.toString('utf8'); });
    proc.stderr.on('data', (d) => { err += d.toString('utf8'); });
    proc.on('error', (e) => { clearTimeout(killer); reject(e); });
    proc.on('exit', (code) => {
      clearTimeout(killer);
      resolve({ code, out, err });
    });
    if (stdinText != null) {
      proc.stdin.write(stdinText, 'utf8');
      proc.stdin.end();
    } else {
      proc.stdin.end();
    }
  });
}

class Injector {
  constructor(exe, hotkeys) {
    this.exe = exe;
    this.hotkeys = hotkeys; // for setInjecting guard
  }

  async fginfo() {
    try {
      const { code, out } = await runHelper(this.exe, ['fginfo'], { timeoutMs: 4000 });
      if (code !== 0) return null;
      const parts = out.split('|');
      if (parts.length < 4) return null;
      return {
        hwnd: parts[0],
        elevated: parts[1] === '1',
        proc: parts[2],
        title: parts.slice(3).join('|'),
      };
    } catch (e) {
      log.warn('fginfo failed:', e.message);
      return null;
    }
  }

  _snapshotClipboard() {
    try {
      const snap = { text: clipboard.readText(), html: clipboard.readHTML() };
      const img = clipboard.readImage();
      snap.image = img && !img.isEmpty() ? img : null;
      return snap;
    } catch (e) {
      return null;
    }
  }

  _restoreClipboard(snap) {
    if (!snap) return;
    try {
      if (snap.image) {
        clipboard.writeImage(snap.image);
      } else if (snap.html && snap.html.length > 0) {
        clipboard.write({ text: snap.text || '', html: snap.html });
      } else if (snap.text) {
        clipboard.writeText(snap.text);
      } else {
        clipboard.clear();
      }
    } catch (e) {
      log.warn('clipboard restore failed:', e.message);
    }
  }

  /**
   * Inject text into the focused app.
   * @param {string} text
   * @param {object} settings {injectionMode, restoreClipboard, restoreDelayMs}
   * @param {object|null} target fginfo captured at record-stop (window identity check)
   * @returns {{status: 'injected'|'copied', reason?: string}}
   * Guarantee: on ANY failure path the text is left on the clipboard.
   */
  async inject(text, settings, target) {
    const current = await this.fginfo();
    // Fail CLOSED: if either window identity is unknown we cannot prove the
    // focus is still where the user dictated — copy instead of typing blind.
    if (!target || !current) {
      clipboard.writeText(text);
      log.warn('inject skipped: window identity unverifiable',
        `target=${!!target} current=${!!current}`);
      return { status: 'copied', reason: 'verify-failed' };
    }
    if (current.hwnd !== target.hwnd) {
      clipboard.writeText(text);
      log.info('inject skipped: focus moved', target.proc, '→', current.proc);
      return { status: 'copied', reason: 'window-changed' };
    }
    if (current.elevated) {
      clipboard.writeText(text);
      log.info('inject skipped: elevated target', current.proc);
      return { status: 'copied', reason: 'elevated' };
    }

    this.hotkeys && this.hotkeys.setInjecting(true);
    try {
      if (settings.injectionMode === 'type') {
        const { code, err } = await runHelper(this.exe, ['type'], {
          stdinText: text,
          timeoutMs: 15000 + text.length * 10,
        });
        if (code !== 0) throw new Error(`type helper exit ${code} ${err.slice(0, 200)}`);
        return { status: 'injected' };
      }

      // paste mode
      const snap = this._snapshotClipboard();
      clipboard.writeText(text);
      const { code, err } = await runHelper(this.exe, ['paste'], { timeoutMs: 8000 });
      if (code !== 0) throw new Error(`paste helper exit ${code} ${err.slice(0, 200)}`);
      // The text is in the target app the moment Ctrl+V lands — success must
      // not wait out the restore grace period. The restore runs behind this
      // return; its guard skips it if the clipboard changed meanwhile (user
      // copied something, or an instant next dictation already wrote its text).
      if (settings.restoreClipboard) {
        setTimeout(() => {
          try {
            if (clipboard.readText() === text) this._restoreClipboard(snap);
          } catch (_) { /* clipboard busy — leave the dictated text in place */ }
        }, Math.max(120, settings.restoreDelayMs | 0));
      }
      return { status: 'injected' };
    } catch (e) {
      log.error('injection failed:', e.message);
      try { clipboard.writeText(text); } catch (_) {}
      return { status: 'copied', reason: 'inject-failed' };
    } finally {
      this.hotkeys && this.hotkeys.setInjecting(false);
    }
  }
}

module.exports = { Injector, runHelper };
